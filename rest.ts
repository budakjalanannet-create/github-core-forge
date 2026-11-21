// The REST v3 surface: repositories, branches, commits, contents, labels, issues, comments
// and pull requests, in the shapes checks-rest.ts asserts. Contents are real git commits in
// the shared object pool (store.ts), so the REST view and the git view never disagree.
// Every body is a JSON value; app.ts serializes it and adds the request-id header.

import { getObject, parseCommit, parseTree } from './git.ts';
import {
  VIEWER,
  addComment,
  branchTip,
  commitFileChange,
  createIssue,
  createPull,
  createRepo,
  defaultBranch,
  deleteRepo,
  diffFiles,
  filesAtCommit,
  filesAtRef,
  getRepo,
  nowIso,
  performMerge,
  pullChanges,
  repos,
  resolveCommit,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';

export interface RestReply {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

function message(status: number, text: string): RestReply {
  return { status, body: { message: text } };
}

function notFound(): RestReply {
  return message(404, 'Not Found');
}

function unauthorized(): RestReply {
  return message(401, 'Bad credentials');
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id },
    private: repo.private,
    description: repo.description,
    default_branch: defaultBranch(repo),
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}`,
    clone_url: `https://forge.invalid/${repo.owner}/${repo.name}.git`,
    fork: false,
    forks_count: 0,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
  };
}

export function issueJson(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: 'ededed' })),
    user: { login: VIEWER.login, id: VIEWER.id },
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = branchTip(repo, pull.headRef) ?? pull.headShaAtCreate;
  const baseSha = branchTip(repo, pull.baseRef) ?? pull.baseSha;
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: VIEWER.login, id: VIEWER.id },
    created_at: pull.createdAt,
    updated_at: pull.createdAt,
  };
}

function commentJson(comment: { id: number; body: string; createdAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: VIEWER.login, id: VIEWER.id },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
  };
}

/** Parse a JSON request body; {ok:false} is the protocol check's malformed-body 400. */
function parseBody(raw: Buffer): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    const value = JSON.parse(raw.toString('utf8')) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: true, value: {} };
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  return { page, perPage };
}

function paginate<T>(items: readonly T[], query: URLSearchParams): T[] {
  const { page, perPage } = pageParams(query);
  return items.slice((page - 1) * perPage, page * perPage);
}

// ------------------------------------------------------------------ handlers

function handleUserRepos(method: string, query: URLSearchParams, raw: Buffer, authed: boolean, host: string): RestReply {
  if (method === 'POST') {
    if (!authed) return unauthorized();
    const parsed = parseBody(raw);
    if (!parsed.ok) return message(400, 'Problems parsing JSON');
    const name = String(parsed.value.name ?? '');
    if (!name) return message(422, 'Validation Failed: name is required');
    if (getRepo(VIEWER.login, name)) return message(422, `name already exists on this account: ${name}`);
    const repo = createRepo(VIEWER.login, name, {
      description: typeof parsed.value.description === 'string' ? parsed.value.description : '',
      private: typeof parsed.value.private === 'boolean' ? parsed.value.private : false,
    });
    return { status: 201, body: repoJson(repo) };
  }
  if (method === 'GET') {
    if (!authed) return unauthorized();
    const mine = [...repos.values()].filter((repo) => repo.owner === VIEWER.login).sort((a, b) => a.id - b.id);
    const { page, perPage } = pageParams(query);
    const slice = mine.slice((page - 1) * perPage, page * perPage);
    const headers: Record<string, string> = {};
    if (page * perPage < mine.length) {
      const next = `http://${host}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
      const lastPage = Math.ceil(mine.length / perPage);
      const last = `http://${host}/api/v3/user/repos?per_page=${perPage}&page=${lastPage}`;
      headers.link = `<${next}>; rel="next", <${last}>; rel="last"`;
    }
    return { status: 200, body: slice.map(repoJson), headers };
  }
  return message(405, 'Method Not Allowed');
}

function handleRepo(method: string, repo: Repo, raw: Buffer, authed: boolean): RestReply {
  if (method === 'GET') return { status: 200, body: repoJson(repo) };
  if (method === 'PATCH') {
    if (!authed) return unauthorized();
    const parsed = parseBody(raw);
    if (!parsed.ok) return message(400, 'Problems parsing JSON');
    if (typeof parsed.value.description === 'string') repo.description = parsed.value.description;
    if (typeof parsed.value.private === 'boolean') repo.private = parsed.value.private;
    if (typeof parsed.value.name === 'string' && parsed.value.name && parsed.value.name !== repo.name) {
      const oldKey = `${repo.owner}/${repo.name}`;
      repos.delete(oldKey);
      repo.name = parsed.value.name;
      repos.set(`${repo.owner}/${repo.name}`, repo);
    }
    return { status: 200, body: repoJson(repo) };
  }
  if (method === 'DELETE') {
    if (!authed) return unauthorized();
    deleteRepo(repo.owner, repo.name);
    return { status: 204, body: null };
  }
  return message(405, 'Method Not Allowed');
}

function handleBranches(method: string, repo: Repo, rest: string[], raw: Buffer): RestReply {
  if (rest.length === 0) {
    if (method !== 'GET') return message(405, 'Method Not Allowed');
    const branches = [...repo.refs.keys()]
      .filter((ref) => ref.startsWith('refs/heads/'))
      .map((ref) => ({
        name: ref.slice('refs/heads/'.length),
        commit: { sha: repo.refs.get(ref) as string },
        protected: false,
      }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    return { status: 200, body: branches };
  }
  const branch = rest.join('/');
  const tip = branchTip(repo, branch);
  if (!tip) return notFound();
  if (method === 'GET') return { status: 200, body: { name: branch, commit: { sha: tip }, protected: false } };
  return message(405, 'Method Not Allowed');
}

function handleGitRefs(method: string, repo: Repo, rest: string[], raw: Buffer): RestReply {
  if (rest.length === 0) {
    if (method !== 'POST') return message(405, 'Method Not Allowed');
    const parsed = parseBody(raw);
    if (!parsed.ok) return message(400, 'Problems parsing JSON');
    const ref = String(parsed.value.ref ?? '');
    const sha = String(parsed.value.sha ?? '');
    if (!ref.startsWith('refs/') || !getObject(sha)) return message(422, 'Validation Failed: invalid ref or sha');
    if (repo.refs.has(ref)) return message(422, 'Reference already exists');
    repo.refs.set(ref, sha);
    return { status: 201, body: { ref, node_id: `REF_${ref}`, object: { sha, type: 'commit' } } };
  }
  const ref = rest.join('/');
  const full = ref.startsWith('refs/') ? ref : `refs/${ref}`;
  const sha = repo.refs.get(full);
  if (!sha) return notFound();
  if (method === 'GET') return { status: 200, body: { ref: full, node_id: `REF_${full}`, object: { sha, type: 'commit' } } };
  if (method === 'DELETE') {
    repo.refs.delete(full);
    return { status: 204, body: null };
  }
  return message(405, 'Method Not Allowed');
}

function handleCommits(method: string, repo: Repo, query: URLSearchParams): RestReply {
  if (method !== 'GET') return message(405, 'Method Not Allowed');
  const start = resolveCommit(repo, query.get('sha') ?? defaultBranch(repo));
  if (!start) return { status: 200, body: [] };
  // Breadth-first from the tip: level order is newest-first for the linear histories here.
  const seen = new Set<string>();
  const order: string[] = [];
  let frontier = [start];
  while (frontier.length) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (seen.has(oid)) continue;
      seen.add(oid);
      order.push(oid);
      const obj = getObject(oid);
      if (obj && obj.type === 'commit') next.push(...parseCommit(obj.data).parents);
    }
    frontier = next;
  }
  const items = order.map((oid) => {
    const view = parseCommit((getObject(oid) as { data: Buffer }).data);
    const person = (line: string): { name: string; email: string; date: string } => {
      const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
      return {
        name: match?.[1] ?? '',
        email: match?.[2] ?? '',
        date: new Date(Number(match?.[3] ?? 0) * 1000).toISOString(),
      };
    };
    return {
      sha: oid,
      commit: {
        message: view.message.replace(/\n$/, ''),
        author: person(view.authorLine),
        committer: person(view.committerLine),
        tree: { sha: view.tree },
      },
      parents: view.parents.map((parent) => ({ sha: parent })),
    };
  });
  return { status: 200, body: paginate(items, query) };
}

function handleContents(method: string, repo: Repo, path: string, query: URLSearchParams, raw: Buffer): RestReply {
  if (method === 'GET') {
    const ref = query.get('ref') ?? defaultBranch(repo);
    const files = filesAtRef(repo, ref);
    if (!files) return notFound();
    const clean = path.replace(/^\/+|\/+$/g, '');
    if (clean === '') {
      const entries = [...files.keys()]
        .filter((p) => !p.includes('/'))
        .map((p) => fileJson(repo, p, files.get(p) as { oid: string; mode: string }));
      return { status: 200, body: entries };
    }
    const file = files.get(clean);
    if (file) return { status: 200, body: fileJson(repo, clean, file, true) };
    const prefix = `${clean}/`;
    const children = new Map<string, { type: 'file' | 'dir'; oid: string }>();
    for (const [p, entry] of files) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) children.set(rest, { type: 'file', oid: entry.oid });
      else if (!children.has(rest.slice(0, slash))) {
        children.set(rest.slice(0, slash), { type: 'dir', oid: subtreeOid(repo, ref, `${prefix}${rest.slice(0, slash)}`) });
      }
    }
    if (children.size === 0) return notFound();
    const listing = [...children.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([name, child]) => ({
        type: child.type,
        name,
        path: `${prefix}${name}`,
        sha: child.oid,
        size: child.type === 'file' ? (getObject(child.oid)?.data.length ?? 0) : 0,
      }));
    return { status: 200, body: listing };
  }
  if (method === 'PUT' || method === 'DELETE') {
    const parsed = parseBody(raw);
    if (!parsed.ok) return message(400, 'Problems parsing JSON');
    const branch = typeof parsed.value.branch === 'string' ? parsed.value.branch : defaultBranch(repo);
    const clean = path.replace(/^\/+/, '');
    const files = filesAtRef(repo, branch) ?? new Map<string, { oid: string; mode: string }>();
    const existing = files.get(clean);
    const givenSha = typeof parsed.value.sha === 'string' ? parsed.value.sha : undefined;
    if (existing && givenSha !== undefined && givenSha !== existing.oid) {
      return message(409, 'Conflict: the file has changed since the given sha');
    }
    if (method === 'DELETE') {
      if (!existing) return notFound();
      const { commitOid } = commitFileChange(repo, branch, clean, null, String(parsed.value.message ?? 'Delete file'));
      return { status: 200, body: { content: null, commit: { sha: commitOid } } };
    }
    if (existing && givenSha === undefined) return message(422, 'Validation Failed: sha is required to update a file');
    const content = Buffer.from(String(parsed.value.content ?? ''), 'base64');
    const { commitOid, blobOid } = commitFileChange(
      repo,
      branch,
      clean,
      content,
      String(parsed.value.message ?? 'Update file'),
    );
    const body = {
      content: {
        name: clean.split('/').pop() ?? clean,
        path: clean,
        sha: blobOid as string,
        size: content.length,
        type: 'file',
        encoding: 'base64',
      },
      commit: { sha: commitOid },
    };
    return { status: existing ? 200 : 201, body };
  }
  return message(405, 'Method Not Allowed');
}

/** The tree oid of a directory path at a ref (for directory listings). */
function subtreeOid(repo: Repo, ref: string, dirPath: string): string {
  const commit = resolveCommit(repo, ref);
  if (!commit) return '';
  let treeOid = parseCommit((getObject(commit) as { data: Buffer }).data).tree;
  for (const part of dirPath.split('/')) {
    const tree = getObject(treeOid);
    if (!tree) return '';
    const entry = parseTree(tree.data).find((e) => e.name === part && e.mode === '40000');
    if (!entry) return '';
    treeOid = entry.oid;
  }
  return treeOid;
}

function fileJson(repo: Repo, path: string, entry: { oid: string; mode: string }, withContent = false): Record<string, unknown> {
  const obj = getObject(entry.oid);
  const body: Record<string, unknown> = {
    type: 'file',
    name: path.split('/').pop() ?? path,
    path,
    sha: entry.oid,
    size: obj?.data.length ?? 0,
    encoding: 'base64',
  };
  if (withContent) body.content = obj ? obj.data.toString('base64') : '';
  return body;
}

function handleLabels(method: string, repo: Repo, raw: Buffer): RestReply {
  if (method === 'POST') {
    const parsed = parseBody(raw);
    if (!parsed.ok) return message(400, 'Problems parsing JSON');
    const name = String(parsed.value.name ?? '');
    if (!name) return message(422, 'Validation Failed: name is required');
    const color = typeof parsed.value.color === 'string' ? parsed.value.color : 'ededed';
    repo.labels.set(name, { name, color });
    return { status: 201, body: { name, color, default: false } };
  }
  if (method === 'GET') {
    return { status: 200, body: [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, default: false })) };
  }
  return message(405, 'Method Not Allowed');
}

function handleIssues(method: string, repo: Repo, rest: string[], query: URLSearchParams, raw: Buffer, authed: boolean): RestReply {
  if (rest.length === 0) {
    if (method === 'POST') {
      if (!authed) return unauthorized();
      const parsed = parseBody(raw);
      if (!parsed.ok) return message(400, 'Problems parsing JSON');
      const labels = Array.isArray(parsed.value.labels) ? parsed.value.labels.map(String) : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) return message(422, `Validation Failed: label "${label}" does not exist`);
      }
      const issue = createIssue(repo, {
        title: String(parsed.value.title ?? ''),
        body: typeof parsed.value.body === 'string' ? parsed.value.body : '',
        labels,
      });
      return { status: 201, body: issueJson(issue) };
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let items = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') items = items.filter((issue) => issue.state === state);
      const direction = query.get('direction') ?? 'desc';
      items.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      return { status: 200, body: paginate(items, query).map(issueJson) };
    }
    return message(405, 'Method Not Allowed');
  }
  const number = Number(rest[0]);
  const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
  if (rest.length === 1) {
    if (!issue) return notFound();
    if (method === 'GET') return { status: 200, body: issueJson(issue) };
    if (method === 'PATCH') {
      if (!authed) return unauthorized();
      const parsed = parseBody(raw);
      if (!parsed.ok) return message(400, 'Problems parsing JSON');
      if (parsed.value.state === 'open' || parsed.value.state === 'closed') issue.state = parsed.value.state;
      if (typeof parsed.value.title === 'string') issue.title = parsed.value.title;
      if (typeof parsed.value.body === 'string') issue.body = parsed.value.body;
      if (Array.isArray(parsed.value.labels)) {
        const labels = parsed.value.labels.map(String);
        for (const label of labels) if (!repo.labels.has(label)) return message(422, `Validation Failed: label "${label}" does not exist`);
        issue.labels = labels;
      }
      issue.updatedAt = nowIso();
      return { status: 200, body: issueJson(issue) };
    }
    return message(405, 'Method Not Allowed');
  }
  if (rest[1] === 'comments') {
    if (!issue) return notFound();
    if (method === 'GET') return { status: 200, body: issue.comments.map(commentJson) };
    if (method === 'POST') {
      if (!authed) return unauthorized();
      const parsed = parseBody(raw);
      if (!parsed.ok) return message(400, 'Problems parsing JSON');
      const comment = addComment(issue, String(parsed.value.body ?? ''));
      return { status: 201, body: commentJson(comment) };
    }
    return message(405, 'Method Not Allowed');
  }
  return notFound();
}

function handlePulls(method: string, repo: Repo, rest: string[], query: URLSearchParams, raw: Buffer, authed: boolean): RestReply {
  if (rest.length === 0) {
    if (method === 'POST') {
      if (!authed) return unauthorized();
      const parsed = parseBody(raw);
      if (!parsed.ok) return message(400, 'Problems parsing JSON');
      const head = String(parsed.value.head ?? '');
      const base = String(parsed.value.base ?? '');
      if (!branchTip(repo, head)) return message(422, `Validation Failed: head branch "${head}" does not exist`);
      if (!branchTip(repo, base)) return message(422, `Validation Failed: base branch "${base}" does not exist`);
      const existing = [...repo.pulls.values()].find(
        (pull) => pull.headRef === head && pull.baseRef === base && pull.state === 'open',
      );
      if (existing) return message(422, `Validation Failed: a pull request already exists for ${head} -> ${base}`);
      const pull = createPull(repo, {
        title: String(parsed.value.title ?? ''),
        body: typeof parsed.value.body === 'string' ? parsed.value.body : '',
        head,
        base,
      });
      return { status: 201, body: pullJson(repo, pull) };
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let items = [...repo.pulls.values()];
      if (state === 'open' || state === 'closed') items = items.filter((pull) => pull.state === state);
      items.sort((a, b) => b.number - a.number);
      return { status: 200, body: paginate(items, query).map((pull) => pullJson(repo, pull)) };
    }
    return message(405, 'Method Not Allowed');
  }
  const number = Number(rest[0]);
  const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
  if (rest.length === 1) {
    if (!pull) return notFound();
    if (method === 'GET') return { status: 200, body: pullJson(repo, pull) };
    if (method === 'PATCH') {
      if (!authed) return unauthorized();
      const parsed = parseBody(raw);
      if (!parsed.ok) return message(400, 'Problems parsing JSON');
      if (parsed.value.state === 'open' || parsed.value.state === 'closed') pull.state = parsed.value.state;
      if (typeof parsed.value.title === 'string') pull.title = parsed.value.title;
      if (typeof parsed.value.body === 'string') pull.body = parsed.value.body;
      return { status: 200, body: pullJson(repo, pull) };
    }
    return message(405, 'Method Not Allowed');
  }
  if (!pull) return notFound();
  if (rest[1] === 'files' && method === 'GET') {
    const changes = pullChanges(repo, pull);
    return {
      status: 200,
      body: changes.map((change) => ({
        filename: change.path,
        status: change.status === 'modified' ? 'modified' : change.status,
        additions: change.additions,
        deletions: change.deletions,
        changes: change.additions + change.deletions,
        sha: change.newOid ?? change.oldOid ?? '',
      })),
    };
  }
  if (rest[1] === 'merge' && method === 'PUT') {
    if (!authed) return unauthorized();
    const parsed = parseBody(raw);
    if (!parsed.ok) return message(400, 'Problems parsing JSON');
    if (pull.merged) return { status: 200, body: { sha: pull.mergeCommitSha as string, merged: true, message: 'Pull Request successfully merged' } };
    if (pull.state !== 'open') return message(405, 'Pull Request is not mergeable');
    if (!performMerge(repo, pull)) return message(405, 'Pull Request is not mergeable: merge conflict');
    return { status: 200, body: { sha: pull.mergeCommitSha as string, merged: true, message: 'Pull Request successfully merged' } };
  }
  return notFound();
}

// ------------------------------------------------------------------ the router

export function handleRest(
  method: string,
  path: string,
  query: URLSearchParams,
  raw: Buffer,
  authed: boolean,
  host: string,
): RestReply {
  const segments = path.split('/').filter((s) => s !== '').map((s) => decodeURIComponent(s));
  // segments[0..1] are 'api','v3' — app.ts only routes /api/v3 here.
  const rest = segments.slice(2);
  if (rest.length === 0) {
    if (method !== 'GET') return message(405, 'Method Not Allowed');
    return {
      status: 200,
      body: {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        issue_search_url: '/api/v3/search/issues',
        rate_limit_url: '/api/v3/rate_limit',
      },
      headers: { 'x-oauth-scopes': 'repo, read:org' },
    };
  }
  if (rest[0] === 'meta' && rest.length === 1) {
    if (method !== 'GET') return message(405, 'Method Not Allowed');
    return { status: 200, body: { installed_version: '1.0.0-forge', verifiable_password_authentication: false } };
  }
  if (rest[0] === 'user' && rest.length === 1) {
    if (method !== 'GET') return message(405, 'Method Not Allowed');
    if (!authed) return unauthorized();
    return {
      status: 200,
      body: { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' },
    };
  }
  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    return handleUserRepos(method, query, raw, authed, host);
  }
  if (rest[0] === 'rate_limit' && rest.length === 1) {
    return { status: 200, body: { rate: { limit: 5000, remaining: 5000, reset: 1893456000 }, resources: {} } };
  }
  if (rest[0] === 'repos' && rest.length >= 3) {
    const owner = rest[1];
    const name = rest[2];
    const repo = getRepo(owner, name);
    if (!repo) {
      // A private-repo-shaped miss for anonymous callers stays a 404 here; the anonymous
      // 401 case is an existing private repo, handled below.
      return notFound();
    }
    if (repo.private && !authed) return unauthorized();
    const sub = rest.slice(3);
    if (sub.length === 0) return handleRepo(method, repo, raw, authed);
    if (sub[0] === 'branches') return handleBranches(method, repo, sub.slice(1), raw);
    if (sub[0] === 'git' && sub[1] === 'refs') return handleGitRefs(method, repo, sub.slice(2), raw);
    if (sub[0] === 'commits' && sub.length === 1) return handleCommits(method, repo, query);
    if (sub[0] === 'contents') return handleContents(method, repo, sub.slice(1).join('/'), query, raw);
    if (sub[0] === 'labels' && sub.length === 1) return handleLabels(method, repo, raw);
    if (sub[0] === 'issues') return handleIssues(method, repo, sub.slice(1), query, raw, authed);
    if (sub[0] === 'pulls') return handlePulls(method, repo, sub.slice(1), query, raw, authed);
    return notFound();
  }
  return notFound();
}
