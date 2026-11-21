// The forge's data model: one seeded user (the account the shop token belongs to), the
// repositories they own, and each repository's issues, pull requests and labels. Git data
// lives in git.ts's object pool; a Repo doubles as its RefStore. Every timestamp comes from
// a logical clock seeded at the scenario epoch, so the same request sequence always yields
// the same bytes — no wall clock ever reaches a response.

import {
  buildCommit,
  buildTreeFromFiles,
  flattenTree,
  getObject,
  mergeBase,
  parseCommit,
  storeObject,
} from './git.ts';

export interface Viewer {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

/** The account the suite's token acts as (wire.ts's scenario viewer). */
export const VIEWER: Viewer = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
};

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
  createdAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  createdAt: string;
  updatedAt: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  baseSha: string;
  headShaAtCreate: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  refs: Map<string, string>;
  headRef: string;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, Label>;
  nextNumber: number;
  createdAt: string;
}

export const repos = new Map<string, Repo>();

let nextRepoId = 1;
let nextIssueId = 1;
let nextPullId = 1;
let nextCommentId = 1;

const CLOCK_BASE = 1739175597; // the scenario's first commit epoch (wire.ts)
let clockTick = 0;

export function tickEpoch(): number {
  const value = CLOCK_BASE + clockTick;
  clockTick += 1;
  return value;
}

export function nowIso(): string {
  return new Date(tickEpoch() * 1000).toISOString();
}

/** A git author/committer line for the viewer at the next logical instant. */
export function gitIdent(): string {
  return `${VIEWER.name} <${VIEWER.email}> ${tickEpoch()} +0000`;
}

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function getRepo(owner: string, name: string): Repo | undefined {
  return repos.get(repoKey(owner, name));
}

export function createRepo(owner: string, name: string, opts: { description?: string; private?: boolean }): Repo {
  const repo: Repo = {
    id: nextRepoId,
    owner,
    name,
    description: opts.description ?? '',
    private: opts.private ?? false,
    refs: new Map(),
    headRef: 'refs/heads/main',
    issues: new Map(),
    pulls: new Map(),
    labels: new Map(),
    nextNumber: 1,
    createdAt: nowIso(),
  };
  nextRepoId += 1;
  repos.set(repoKey(owner, name), repo);
  return repo;
}

export function deleteRepo(owner: string, name: string): boolean {
  return repos.delete(repoKey(owner, name));
}

export function defaultBranch(repo: Repo): string {
  return repo.headRef.replace(/^refs\/heads\//, '');
}

export function branchTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

/** Resolve a ref-ish (branch name, full ref, tag name or commit oid) to a commit oid. */
export function resolveCommit(repo: Repo, ref: string): string | null {
  const candidates = [
    repo.refs.get(ref),
    repo.refs.get(`refs/heads/${ref}`),
    repo.refs.get(`refs/tags/${ref}`),
  ];
  for (const candidate of candidates) {
    if (candidate) {
      const obj = getObject(candidate);
      if (obj && obj.type === 'tag') {
        const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
        if (match) return match[1];
      }
      return candidate;
    }
  }
  const obj = getObject(ref);
  if (obj && obj.type === 'commit') return ref;
  return null;
}

/** The flat file map at a commit: path -> {oid, mode}. */
export function filesAtCommit(commitOid: string): Map<string, { oid: string; mode: string }> {
  const obj = getObject(commitOid);
  if (!obj || obj.type !== 'commit') return new Map();
  return flattenTree(parseCommit(obj.data).tree);
}

export function filesAtRef(repo: Repo, ref: string): Map<string, { oid: string; mode: string }> | null {
  const commit = resolveCommit(repo, ref);
  if (!commit) return null;
  return filesAtCommit(commit);
}

/**
 * Commit one file change (content === null deletes the path) onto a branch, creating the
 * branch from the default branch's tip when it does not exist yet. Returns the new commit
 * oid and the blob oid (null for a delete).
 */
export function commitFileChange(
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
): { commitOid: string; blobOid: string | null } {
  let tip = branchTip(repo, branch);
  if (!tip) {
    const fallback = branchTip(repo, defaultBranch(repo));
    tip = fallback;
  }
  const files = tip ? filesAtCommit(tip) : new Map<string, { oid: string; mode: string }>();
  let blobOid: string | null = null;
  if (content === null) {
    files.delete(path);
  } else {
    blobOid = storeObject('blob', content);
    const existing = files.get(path);
    files.set(path, { oid: blobOid, mode: existing?.mode ?? '100644' });
  }
  const tree = buildTreeFromFiles(files);
  const ident = gitIdent();
  const commit = buildCommit({
    tree,
    parents: tip ? [tip] : [],
    author: ident,
    committer: ident,
    message,
  });
  const commitOid = storeObject('commit', commit);
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  return { commitOid, blobOid };
}

export interface FileChange {
  path: string;
  status: 'added' | 'removed' | 'modified';
  oldOid: string | null;
  newOid: string | null;
  additions: number;
  deletions: number;
}

function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  if (a.length * b.length > 4_000_000) {
    const setA = new Set(a);
    const setB = new Set(b);
    return {
      additions: b.filter((line) => !setA.has(line)).length,
      deletions: a.filter((line) => !setB.has(line)).length,
    };
  }
  // Classic LCS dynamic program over lines.
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const common = dp[0][0];
  return { additions: b.length - common, deletions: a.length - common };
}

function blobText(oid: string | null): string {
  if (!oid) return '';
  const obj = getObject(oid);
  return obj ? obj.data.toString('utf8') : '';
}

/** The changes that turn `baseFiles` into `headFiles`. */
export function diffFiles(
  baseFiles: ReadonlyMap<string, { oid: string; mode: string }>,
  headFiles: ReadonlyMap<string, { oid: string; mode: string }>,
): FileChange[] {
  const changes: FileChange[] = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const before = baseFiles.get(path);
    const after = headFiles.get(path);
    if (before && !after) {
      const { additions, deletions } = lineDiff(blobText(before.oid), '');
      changes.push({ path, status: 'removed', oldOid: before.oid, newOid: null, additions, deletions });
    } else if (!before && after) {
      const { additions, deletions } = lineDiff('', blobText(after.oid));
      changes.push({ path, status: 'added', oldOid: null, newOid: after.oid, additions, deletions });
    } else if (before && after && before.oid !== after.oid) {
      const { additions, deletions } = lineDiff(blobText(before.oid), blobText(after.oid));
      changes.push({ path, status: 'modified', oldOid: before.oid, newOid: after.oid, additions, deletions });
    }
  }
  return changes;
}

/**
 * Squash-merge a pull request: apply the head's changes relative to the merge base onto
 * the current base tip as one new commit. Returns the merge commit oid, or null when the
 * changes conflict with what the base did in the meantime.
 */
export function squashMerge(repo: Repo, pull: Pull): string | null {
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef) ?? pull.headShaAtCreate;
  if (!baseTip || !headTip) return null;
  const base = mergeBase(baseTip, headTip);
  if (!base) return null;
  const baseFiles = filesAtCommit(baseTip);
  const mergeBaseFiles = filesAtCommit(base);
  const headFiles = filesAtCommit(headTip);
  const changes = diffFiles(mergeBaseFiles, headFiles);
  const merged = new Map(baseFiles);
  for (const change of changes) {
    const current = baseFiles.get(change.path);
    const atBase = mergeBaseFiles.get(change.path);
    if (change.status === 'added') {
      if (current && current.oid !== change.newOid) return null;
      if (change.newOid) merged.set(change.path, { oid: change.newOid, mode: headFiles.get(change.path)?.mode ?? '100644' });
    } else if (change.status === 'modified') {
      if (!current) return null;
      if (current.oid !== atBase?.oid && current.oid !== change.newOid) return null;
      if (change.newOid) merged.set(change.path, { oid: change.newOid, mode: current.mode });
    } else {
      if (current && atBase && current.oid !== atBase.oid) return null;
      merged.delete(change.path);
    }
  }
  const tree = buildTreeFromFiles(merged);
  const ident = gitIdent();
  const commit = buildCommit({
    tree,
    parents: [baseTip],
    author: ident,
    committer: ident,
    message: `${pull.title} (#${pull.number})`,
  });
  const commitOid = storeObject('commit', commit);
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
  return commitOid;
}

/** The files a pull request changes: its head tree diffed against the merge base tree. */
export function pullChanges(repo: Repo, pull: Pull): FileChange[] {
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef) ?? pull.headShaAtCreate;
  if (!headTip) return [];
  const base = baseTip ? mergeBase(baseTip, headTip) : null;
  const baseFiles = base ? filesAtCommit(base) : new Map<string, { oid: string; mode: string }>();
  return diffFiles(baseFiles, filesAtCommit(headTip));
}

export function createIssue(repo: Repo, fields: { title: string; body: string; labels?: string[] }): Issue {
  const issue: Issue = {
    id: nextIssueId,
    number: repo.nextNumber,
    title: fields.title,
    body: fields.body,
    state: 'open',
    labels: fields.labels ?? [],
    comments: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  nextIssueId += 1;
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

export function createPull(repo: Repo, fields: { title: string; body: string; head: string; base: string }): Pull {
  const headTip = branchTip(repo, fields.head) ?? '';
  const baseTip = branchTip(repo, fields.base) ?? '';
  const pull: Pull = {
    id: nextPullId,
    number: repo.nextNumber,
    title: fields.title,
    body: fields.body,
    state: 'open',
    headRef: fields.head,
    baseRef: fields.base,
    baseSha: baseTip,
    headShaAtCreate: headTip,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    createdAt: nowIso(),
  };
  nextPullId += 1;
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return pull;
}

/** Perform a merge (shared by REST, GraphQL and MCP): false when it conflicts. */
export function performMerge(repo: Repo, pull: Pull): boolean {
  const sha = squashMerge(repo, pull);
  if (!sha) return false;
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = nowIso();
  pull.mergeCommitSha = sha;
  return true;
}

export function addComment(issue: Issue, body: string): IssueComment {
  const comment: IssueComment = { id: nextCommentId, body, createdAt: nowIso() };
  nextCommentId += 1;
  issue.comments.push(comment);
  return comment;
}
