// The GraphQL v4 surface: a small parser and executor covering exactly the documents gh
// and github-mcp-server send (and the checks exercise): viewer, repository, node, __type
// introspection, issue/pull connections with cursor pagination, and the five mutations.
// Relay-style global ids are base64 "<Type>:<databaseId>" — opaque, stable, and never the
// bare number. Unknown fields produce GraphQL errors naming the field, at HTTP 200, as the
// invalid-field check requires; a missing token is refused by app.ts with 401 before this.

import { mergeBase } from './git.ts';
import {
  VIEWER,
  addComment,
  branchTip,
  createIssue,
  createPull,
  defaultBranch,
  diffFiles,
  filesAtCommit,
  getRepo,
  performMerge,
  pullChanges,
  repos,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';

// ------------------------------------------------------------------ global ids

export function globalId(kind: string, dbId: number): string {
  return Buffer.from(`${kind}:${dbId}`, 'utf8').toString('base64');
}

function decodeGlobalId(id: string): { kind: string; dbId: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const match = /^([A-Za-z]+):(\d+)$/.exec(text);
    if (!match) return null;
    return { kind: match[1], dbId: Number(match[2]) };
  } catch {
    return null;
  }
}

function findRepoById(dbId: number): Repo | undefined {
  for (const repo of repos.values()) if (repo.id === dbId) return repo;
  return undefined;
}

function findIssueById(dbId: number): { repo: Repo; issue: Issue } | undefined {
  for (const repo of repos.values()) {
    for (const issue of repo.issues.values()) if (issue.id === dbId) return { repo, issue };
  }
  return undefined;
}

function findPullById(dbId: number): { repo: Repo; pull: Pull } | undefined {
  for (const repo of repos.values()) {
    for (const pull of repo.pulls.values()) if (pull.id === dbId) return { repo, pull };
  }
  return undefined;
}

// ------------------------------------------------------------------ lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        tokens.push({ kind: 'string', value: source.slice(i + 3, end < 0 ? source.length : end) });
        i = end < 0 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1];
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j])) j += 1;
      const text = source.slice(i, j);
      tokens.push(text.includes('.') || /[eE]/.test(text) ? { kind: 'float', value: Number(text) } : { kind: 'int', value: Number(text) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

// ------------------------------------------------------------------ parser

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Record<string, Value> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, Value>;
  selections: Selection[];
}

interface FragmentNode {
  kind: 'inline';
  typeCondition: string | null;
  selections: Selection[];
}

type Selection = FieldNode | FragmentNode;

interface Operation {
  type: 'query' | 'mutation';
  selections: Selection[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private next(): Token {
    const token = this.tokens[this.pos];
    this.pos += 1;
    if (!token) throw new Error('unexpected end of GraphQL document');
    return token;
  }
  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected "${value}" in GraphQL document`);
  }
  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token && token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseDocument(): Operation {
    let operation: Operation | null = null;
    while (this.pos < this.tokens.length) {
      const token = this.peek() as Token;
      if (token.kind === 'punct' && token.value === '{') {
        operation = { type: 'query', selections: this.parseSelectionSet() };
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        this.next();
        const type = token.value === 'mutation' ? 'mutation' : 'query';
        const maybeName = this.peek();
        if (maybeName && maybeName.kind === 'name') this.next();
        if (this.peek()?.kind === 'punct' && (this.peek() as { value?: string }).value === '(') this.parseVariableDefinitions();
        operation = { type, selections: this.parseSelectionSet() };
      } else if (token.kind === 'name' && token.value === 'fragment') {
        // Named fragments are parsed and skipped; the contest documents use inline ones.
        this.next();
        this.next();
        const on = this.next();
        if (on.kind === 'name' && on.value === 'on') this.next();
        this.parseSelectionSet();
      } else {
        throw new Error('unsupported GraphQL document element');
      }
    }
    if (!operation) throw new Error('no operation in GraphQL document');
    return operation;
  }

  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      this.expectPunct('$');
      this.next(); // variable name
      this.expectPunct(':');
      this.parseType();
      if (this.skipPunct('=')) this.parseValue();
    }
  }

  private parseType(): void {
    if (this.skipPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.next();
    }
    this.skipPunct('!');
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!this.skipPunct('}')) selections.push(this.parseSelection());
    return selections;
  }

  private parseSelection(): Selection {
    const token = this.peek();
    if (token && token.kind === 'spread') {
      this.next();
      const on = this.next();
      let typeCondition: string | null = null;
      if (on.kind === 'name' && on.value === 'on') {
        const typeToken = this.next();
        if (typeToken.kind === 'name') typeCondition = typeToken.value;
        return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
      }
      throw new Error('named fragment spreads are not supported');
    }
    let nameToken = this.next();
    if (nameToken.kind !== 'name') throw new Error('expected a field name');
    let alias: string | null = null;
    let name = nameToken.value;
    if (this.skipPunct(':')) {
      alias = name;
      nameToken = this.next();
      if (nameToken.kind !== 'name') throw new Error('expected a field name after alias');
      name = nameToken.value;
    }
    const args: Record<string, Value> = {};
    if (this.peek()?.kind === 'punct' && (this.peek() as { value?: string }).value === '(') {
      this.expectPunct('(');
      while (!this.skipPunct(')')) {
        const argName = this.next();
        if (argName.kind !== 'name') throw new Error('expected an argument name');
        this.expectPunct(':');
        args[argName.value] = this.parseValue();
      }
    }
    // Directives are parsed and ignored.
    while (this.peek()?.kind === 'punct' && (this.peek() as { value?: string }).value === '@') {
      this.next();
      this.next();
      if (this.peek()?.kind === 'punct' && (this.peek() as { value?: string }).value === '(') {
        this.expectPunct('(');
        while (!this.skipPunct(')')) {
          this.next();
          this.expectPunct(':');
          this.parseValue();
        }
      }
    }
    let selections: Selection[] = [];
    if (this.peek()?.kind === 'punct' && (this.peek() as { value?: string }).value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selections };
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      const name = this.next();
      if (name.kind !== 'name') throw new Error('expected a variable name');
      return { kind: 'variable', name: name.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: Value[] = [];
      while (!this.skipPunct(']')) items.push(this.parseValue());
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, Value> = {};
      while (!this.skipPunct('}')) {
        const key = this.next();
        if (key.kind !== 'name') throw new Error('expected an object key');
        this.expectPunct(':');
        fields[key.value] = this.parseValue();
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

// ------------------------------------------------------------------ schema tables

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'organization', 'user', 'search', 'rateLimit'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'updateIssue', 'createRepository'],
  User: ['id', 'login', 'name', 'email', 'databaseId', 'url', 'createdAt', 'updatedAt'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'viewerPermission',
    'hasIssuesEnabled', 'defaultBranchRef', 'issue', 'issues', 'pullRequest', 'pullRequests', 'createdAt',
    'updatedAt', 'url', 'labels', 'refs', 'ref', 'object', 'stargazerCount', 'forkCount',
  ],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'author', 'repository', 'comments', 'labels',
    'createdAt', 'updatedAt', 'url', 'closed', 'locked',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'headRef', 'baseRef', 'files', 'author', 'repository', 'createdAt', 'updatedAt', 'url', 'additions',
    'deletions', 'changedFiles', 'mergedAt', 'mergeCommit',
  ],
  IssueComment: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  Ref: ['id', 'name', 'prefix', 'target'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changeType'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'possibleTypes'],
  __Field: ['name', 'description', 'type'],
  __EnumValue: ['name', 'description'],
  __Schema: ['types', 'queryType', 'mutationType'],
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  State: ['OPEN', 'CLOSED'],
};

// ------------------------------------------------------------------ execution

interface Ctx {
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

type Wrapped =
  | { __type: 'User' }
  | { __type: 'Repository'; repo: Repo }
  | { __type: 'Issue'; repo: Repo; issue: Issue }
  | { __type: 'PullRequest'; repo: Repo; pull: Pull }
  | { __type: 'IssueComment'; comment: { id: number; body: string; createdAt: string } }
  | { __type: 'Ref'; name: string }
  | { __type: 'PageInfo'; hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null }
  | { __type: 'IssueConnection'; items: Wrapped[]; pageInfo: Wrapped }
  | { __type: 'PullRequestConnection'; items: Wrapped[]; pageInfo: Wrapped }
  | { __type: 'PullRequestFileConnection'; items: Wrapped[]; pageInfo: Wrapped }
  | { __type: 'PullRequestFile'; path: string; additions: number; deletions: number }
  | { __type: 'CreateIssuePayload'; issue: Wrapped }
  | { __type: 'CloseIssuePayload'; issue: Wrapped }
  | { __type: 'CreatePullRequestPayload'; pullRequest: Wrapped }
  | { __type: 'MergePullRequestPayload'; pullRequest: Wrapped }
  | { __type: 'AddCommentPayload'; commentEdge: Wrapped }
  | { __type: 'IssueCommentEdge'; node: Wrapped }
  | { __type: '__Type'; name: string }
  | { __type: '__Field'; name: string }
  | { __type: '__EnumValue'; name: string };

function resolveValue(value: Value, ctx: Ctx): unknown {
  switch (value.kind) {
    case 'variable':
      return ctx.variables[value.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => resolveValue(item, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(value.fields)) out[key] = resolveValue(inner, ctx);
      return out;
    }
  }
}

function argsOf(field: FieldNode, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(field.args)) out[key] = resolveValue(value, ctx);
  return out;
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexFromCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || !cursor) return -1;
  try {
    const match = /^cursor:(\d+)$/.exec(Buffer.from(cursor, 'base64').toString('utf8'));
    return match ? Number(match[1]) : -1;
  } catch {
    return -1;
  }
}

interface Page {
  items: Wrapped[];
  pageInfo: Wrapped;
}

function paginate(items: Wrapped[], args: Record<string, unknown>): Page {
  const first = typeof args.first === 'number' ? args.first : items.length;
  const afterIndex = indexFromCursor(args.after);
  const start = afterIndex + 1;
  const slice = items.slice(start, start + first);
  const pageInfo: Wrapped = {
    __type: 'PageInfo',
    hasNextPage: start + slice.length < items.length,
    hasPreviousPage: start > 0,
    startCursor: slice.length ? cursorFor(start) : null,
    endCursor: slice.length ? cursorFor(start + slice.length - 1) : null,
  };
  return { items: slice, pageInfo };
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

/** Whether a pull request would merge cleanly (the squashMerge rules, read-only). */
function mergeableState(repo: Repo, pull: Pull): string {
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef) ?? pull.headShaAtCreate;
  if (!baseTip || !headTip) return 'UNKNOWN';
  const base = mergeBase(baseTip, headTip);
  if (!base) return 'CONFLICTING';
  const baseFiles = filesAtCommit(baseTip);
  const mergeBaseFiles = filesAtCommit(base);
  const changes = diffFiles(mergeBaseFiles, filesAtCommit(headTip));
  for (const change of changes) {
    const current = baseFiles.get(change.path);
    const atBase = mergeBaseFiles.get(change.path);
    if (change.status === 'added' && current && current.oid !== change.newOid) return 'CONFLICTING';
    if (change.status === 'modified' && (!current || (current.oid !== atBase?.oid && current.oid !== change.newOid))) return 'CONFLICTING';
    if (change.status === 'removed' && current && atBase && current.oid !== atBase.oid) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

function resolveField(typeName: string, source: Wrapped | null, field: FieldNode, ctx: Ctx): unknown {
  const args = argsOf(field, ctx);
  if (field.name === '__typename') return source?.__type ?? typeName;
  if (typeName === 'Query') {
    switch (field.name) {
      case 'viewer':
        return { __type: 'User' } satisfies Wrapped;
      case 'repository': {
        const repo = getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo ? ({ __type: 'Repository', repo } satisfies Wrapped) : null;
      }
      case 'node': {
        const decoded = decodeGlobalId(String(args.id ?? ''));
        if (!decoded) return null;
        if (decoded.kind === 'Repository') {
          const repo = findRepoById(decoded.dbId);
          return repo ? ({ __type: 'Repository', repo } satisfies Wrapped) : null;
        }
        if (decoded.kind === 'Issue') {
          const found = findIssueById(decoded.dbId);
          return found ? ({ __type: 'Issue', repo: found.repo, issue: found.issue } satisfies Wrapped) : null;
        }
        if (decoded.kind === 'PullRequest') {
          const found = findPullById(decoded.dbId);
          return found ? ({ __type: 'PullRequest', repo: found.repo, pull: found.pull } satisfies Wrapped) : null;
        }
        return null;
      }
      case '__type':
        return { __type: '__Type', name: String(args.name ?? '') } satisfies Wrapped;
      default:
        break;
    }
  }
  if (typeName === 'Mutation' && source === null) {
    switch (field.name) {
      case 'createIssue': {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
        const repo = decoded ? findRepoById(decoded.dbId) : undefined;
        if (!repo) throw new Error('createIssue: repository not found');
        const issue = createIssue(repo, {
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : '',
        });
        return { __type: 'CreateIssuePayload', issue: { __type: 'Issue', repo, issue } } satisfies Wrapped;
      }
      case 'closeIssue': {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.issueId ?? ''));
        const found = decoded ? findIssueById(decoded.dbId) : undefined;
        if (!found) throw new Error('closeIssue: issue not found');
        found.issue.state = 'closed';
        return { __type: 'CloseIssuePayload', issue: { __type: 'Issue', repo: found.repo, issue: found.issue } } satisfies Wrapped;
      }
      case 'createPullRequest': {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
        const repo = decoded ? findRepoById(decoded.dbId) : undefined;
        if (!repo) throw new Error('createPullRequest: repository not found');
        const head = String(input.headRefName ?? '');
        const base = String(input.baseRefName ?? '');
        if (!branchTip(repo, head) || !branchTip(repo, base)) throw new Error('createPullRequest: branch not found');
        const pull = createPull(repo, {
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : '',
          head,
          base,
        });
        return { __type: 'CreatePullRequestPayload', pullRequest: { __type: 'PullRequest', repo, pull } } satisfies Wrapped;
      }
      case 'mergePullRequest': {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
        const found = decoded ? findPullById(decoded.dbId) : undefined;
        if (!found) throw new Error('mergePullRequest: pull request not found');
        if (!found.pull.merged && found.pull.state === 'open') performMerge(found.repo, found.pull);
        return { __type: 'MergePullRequestPayload', pullRequest: { __type: 'PullRequest', repo: found.repo, pull: found.pull } } satisfies Wrapped;
      }
      case 'addComment': {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.subjectId ?? ''));
        const found = decoded ? findIssueById(decoded.dbId) : undefined;
        if (!found) throw new Error('addComment: subject not found');
        const comment = addComment(found.issue, String(input.body ?? ''));
        const node: Wrapped = { __type: 'IssueComment', comment };
        return { __type: 'AddCommentPayload', commentEdge: { __type: 'IssueCommentEdge', node } } satisfies Wrapped;
      }
      default:
        break;
    }
  }
  if (!source) return null;
  switch (source.__type) {
    case 'User':
      switch (field.name) {
        case 'login': return VIEWER.login;
        case 'id': return globalId('User', VIEWER.id);
        case 'databaseId': return VIEWER.id;
        case 'name': return VIEWER.name;
        case 'email': return VIEWER.email;
        default: return null;
      }
    case 'Repository': {
      const repo = source.repo;
      switch (field.name) {
        case 'id': return globalId('Repository', repo.id);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
        case 'owner': return { __type: 'User' } satisfies Wrapped;
        case 'description': return repo.description;
        case 'isPrivate': return repo.private;
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'defaultBranchRef': {
          const branch = defaultBranch(repo);
          return branchTip(repo, branch) ? ({ __type: 'Ref', name: branch } satisfies Wrapped) : null;
        }
        case 'issue': {
          const issue = repo.issues.get(Number(args.number));
          return issue ? ({ __type: 'Issue', repo, issue } satisfies Wrapped) : null;
        }
        case 'issues': {
          let items = [...repo.issues.values()];
          const states = Array.isArray(args.states) ? args.states.map(String) : null;
          if (states) items = items.filter((issue) => states.includes(issueState(issue)));
          const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
          const descending = orderBy.direction === 'DESC';
          items.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
          const wrapped = items.map((issue) => ({ __type: 'Issue', repo, issue }) as Wrapped);
          const page = paginate(wrapped, args);
          return { __type: 'IssueConnection', items: page.items, pageInfo: page.pageInfo } satisfies Wrapped;
        }
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.number));
          return pull ? ({ __type: 'PullRequest', repo, pull } satisfies Wrapped) : null;
        }
        case 'pullRequests': {
          let items = [...repo.pulls.values()];
          const states = Array.isArray(args.states) ? args.states.map(String) : null;
          if (states) items = items.filter((pull) => states.includes(pullState(pull)));
          items.sort((a, b) => a.number - b.number);
          const wrapped = items.map((pull) => ({ __type: 'PullRequest', repo, pull }) as Wrapped);
          const page = paginate(wrapped, args);
          return { __type: 'PullRequestConnection', items: page.items, pageInfo: page.pageInfo } satisfies Wrapped;
        }
        case 'createdAt': return repo.createdAt;
        case 'updatedAt': return repo.createdAt;
        default: return null;
      }
    }
    case 'Issue': {
      const issue = source.issue;
      switch (field.name) {
        case 'id': return globalId('Issue', issue.id);
        case 'databaseId': return issue.id;
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'state': return issueState(issue);
        case 'author': return { __type: 'User' } satisfies Wrapped;
        case 'repository': return { __type: 'Repository', repo: source.repo } satisfies Wrapped;
        case 'createdAt': return issue.createdAt;
        case 'updatedAt': return issue.updatedAt;
        case 'closed': return issue.state === 'closed';
        default: return null;
      }
    }
    case 'PullRequest': {
      const pull = source.pull;
      switch (field.name) {
        case 'id': return globalId('PullRequest', pull.id);
        case 'databaseId': return pull.id;
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pullState(pull);
        case 'merged': return pull.merged;
        case 'mergeable': return mergeableState(source.repo, pull);
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'author': return { __type: 'User' } satisfies Wrapped;
        case 'repository': return { __type: 'Repository', repo: source.repo } satisfies Wrapped;
        case 'files': {
          const changes = pullChanges(source.repo, pull);
          const wrapped = changes.map((change) => ({
            __type: 'PullRequestFile',
            path: change.path,
            additions: change.additions,
            deletions: change.deletions,
          }) as Wrapped);
          const page = paginate(wrapped, args);
          return { __type: 'PullRequestFileConnection', items: page.items, pageInfo: page.pageInfo } satisfies Wrapped;
        }
        case 'createdAt': return pull.createdAt;
        case 'updatedAt': return pull.createdAt;
        case 'mergedAt': return pull.mergedAt;
        case 'additions': return pullChanges(source.repo, pull).reduce((sum, c) => sum + c.additions, 0);
        case 'deletions': return pullChanges(source.repo, pull).reduce((sum, c) => sum + c.deletions, 0);
        case 'changedFiles': return pullChanges(source.repo, pull).length;
        default: return null;
      }
    }
    case 'IssueComment':
      switch (field.name) {
        case 'id': return globalId('IssueComment', source.comment.id);
        case 'databaseId': return source.comment.id;
        case 'body': return source.comment.body;
        case 'author': return { __type: 'User' } satisfies Wrapped;
        case 'createdAt': return source.comment.createdAt;
        case 'updatedAt': return source.comment.createdAt;
        default: return null;
      }
    case 'Ref':
      return field.name === 'name' ? source.name : null;
    case 'PageInfo':
      switch (field.name) {
        case 'hasNextPage': return source.hasNextPage;
        case 'hasPreviousPage': return source.hasPreviousPage;
        case 'startCursor': return source.startCursor;
        case 'endCursor': return source.endCursor;
        default: return null;
      }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestFileConnection':
      switch (field.name) {
        case 'nodes': return source.items;
        case 'pageInfo': return source.pageInfo;
        case 'totalCount': return source.items.length;
        case 'edges': return source.items.map((node) => ({ __type: 'IssueCommentEdge', node }));
        default: return null;
      }
    case 'PullRequestFile':
      switch (field.name) {
        case 'path': return source.path;
        case 'additions': return source.additions;
        case 'deletions': return source.deletions;
        default: return null;
      }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
      return field.name === 'issue' ? source.issue : null;
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
      return field.name === 'pullRequest' ? source.pullRequest : null;
    case 'AddCommentPayload':
      return field.name === 'commentEdge' ? source.commentEdge : null;
    case 'IssueCommentEdge':
      return field.name === 'node' ? source.node : null;
    case '__Type':
      switch (field.name) {
        case 'name': return source.name;
        case 'kind': return ENUM_VALUES[source.name] ? 'ENUM' : 'OBJECT';
        case 'fields': return (TYPE_FIELDS[source.name] ?? []).map((name) => ({ __type: '__Field', name }) as Wrapped);
        case 'enumValues': return (ENUM_VALUES[source.name] ?? []).map((name) => ({ __type: '__EnumValue', name }) as Wrapped);
        default: return null;
      }
    case '__Field':
    case '__EnumValue':
      return field.name === 'name' ? source.name : null;
    default:
      return null;
  }
}

const KNOWN_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = Object.fromEntries(
  Object.entries(TYPE_FIELDS).map(([type, fields]) => [type, new Set(fields)]),
);

function executeSelections(typeName: string, source: Wrapped | null, selections: Selection[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      const condition = selection.typeCondition;
      const matches =
        condition === null ||
        condition === typeName ||
        (source !== null && condition === source.__type) ||
        condition === 'Node';
      if (matches) {
        const inner = executeSelections(source?.__type ?? typeName, source, selection.selections, ctx);
        Object.assign(out, inner);
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    const concreteType = source?.__type ?? typeName;
    if (selection.name !== '__typename' && selection.name !== '__type' && selection.name !== '__schema') {
      const known = KNOWN_FIELDS[concreteType];
      if (known && !known.has(selection.name)) {
        ctx.errors.push({ message: `Field '${selection.name}' doesn't exist on type '${concreteType}'` });
        out[key] = null;
        continue;
      }
    }
    let value: unknown;
    try {
      value = resolveField(typeName === 'Query' || typeName === 'Mutation' ? typeName : concreteType, source, selection, ctx);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
      continue;
    }
    if (value !== null && typeof value === 'object' && '__type' in (value as Record<string, unknown>)) {
      const wrapped = value as Wrapped;
      out[key] = selection.selections.length
        ? executeSelections(wrapped.__type, wrapped, selection.selections, ctx)
        : null;
    } else if (Array.isArray(value)) {
      out[key] = value.map((item) => {
        if (item !== null && typeof item === 'object' && '__type' in (item as Record<string, unknown>)) {
          const wrapped = item as Wrapped;
          return selection.selections.length ? executeSelections(wrapped.__type, wrapped, selection.selections, ctx) : null;
        }
        return item;
      });
    } else {
      out[key] = value ?? null;
    }
  }
  return out;
}

/** Execute one GraphQL operation body ({query, variables}) into a {data, errors?} envelope. */
export function executeGraphQL(body: { query?: unknown; variables?: unknown }): Record<string, unknown> {
  const ctx: Ctx = {
    variables: (body.variables && typeof body.variables === 'object' ? body.variables : {}) as Record<string, unknown>,
    errors: [],
  };
  try {
    const operation = new Parser(lex(String(body.query ?? ''))).parseDocument();
    const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
    const data = executeSelections(rootType, null, operation.selections, ctx);
    const envelope: Record<string, unknown> = { data };
    if (ctx.errors.length) envelope.errors = ctx.errors;
    return envelope;
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}
