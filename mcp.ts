// The MCP endpoint: streamable-HTTP JSON-RPC at POST /mcp, modern-era discovery
// (server/discover), a static six-tool list, and tools/call dispatched onto the same store
// the REST surface serves, so MCP-created data is immediately visible over REST (the
// rest-parity check depends on it). Stateless: no session id is issued, so the client never
// sends one back. Auth is enforced per request by app.ts (401 without the bearer token).

import { issueJson, pullJson, repoJson } from './rest.ts';
import {
  VIEWER,
  branchTip,
  createIssue,
  createPull,
  createRepo,
  getRepo,
  performMerge,
} from './store.ts';

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
}

const SERVER_INFO = { name: 'forge-mcp', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];

const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number (squash).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
] as const;

function toolResult(payload: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function callTool(name: string, args: Record<string, unknown>): { result?: Record<string, unknown>; error?: { code: number; message: string } } {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { error: { code: -32602, message: `unknown tool: ${name}` } };
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return { error: { code: -32602, message: `missing required argument: ${required}` } };
    }
  }
  const owner = String(args.owner ?? VIEWER.login);
  const repoName = String(args.repo ?? args.name ?? '');
  switch (name) {
    case 'create_repo': {
      const repoNameArg = String(args.name ?? '');
      const existing = getRepo(VIEWER.login, repoNameArg);
      const repo =
        existing ??
        createRepo(VIEWER.login, repoNameArg, {
          description: typeof args.description === 'string' ? args.description : '',
          private: typeof args.private === 'boolean' ? args.private : false,
        });
      return { result: toolResult(repoJson(repo)) };
    }
    case 'get_repo': {
      const repo = getRepo(owner, repoName);
      if (!repo) return { result: toolError(`repository ${owner}/${repoName} not found`) };
      return { result: toolResult(repoJson(repo)) };
    }
    case 'create_issue': {
      const repo = getRepo(owner, repoName);
      if (!repo) return { result: toolError(`repository ${owner}/${repoName} not found`) };
      const issue = createIssue(repo, {
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
      });
      return { result: toolResult(issueJson(issue)) };
    }
    case 'list_issues': {
      const repo = getRepo(owner, repoName);
      if (!repo) return { result: toolError(`repository ${owner}/${repoName} not found`) };
      const state = typeof args.state === 'string' ? args.state : 'open';
      let items = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') items = items.filter((issue) => issue.state === state);
      items.sort((a, b) => a.number - b.number);
      return { result: toolResult(items.map(issueJson)) };
    }
    case 'create_pull_request': {
      const repo = getRepo(owner, repoName);
      if (!repo) return { result: toolError(`repository ${owner}/${repoName} not found`) };
      const head = String(args.head ?? '');
      const base = String(args.base ?? '');
      if (!branchTip(repo, head)) return { result: toolError(`head branch "${head}" does not exist`) };
      if (!branchTip(repo, base)) return { result: toolError(`base branch "${base}" does not exist`) };
      const pull = createPull(repo, {
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
        head,
        base,
      });
      return { result: toolResult(pullJson(repo, pull)) };
    }
    case 'merge_pull_request': {
      const repo = getRepo(owner, repoName);
      if (!repo) return { result: toolError(`repository ${owner}/${repoName} not found`) };
      const pull = repo.pulls.get(Number(args.pull_number));
      if (!pull) return { result: toolError(`pull request ${String(args.pull_number)} not found`) };
      if (!pull.merged) {
        if (pull.state !== 'open' || !performMerge(repo, pull)) return { result: toolError('pull request is not mergeable') };
      }
      return { result: toolResult(pullJson(repo, pull)) };
    }
    default:
      return { error: { code: -32602, message: `unknown tool: ${name}` } };
  }
}

function handleOne(request: JsonRpcRequest): Record<string, unknown> | null {
  const id = request.id ?? null;
  const method = String(request.method ?? '');
  const params = (request.params ?? {}) as Record<string, unknown>;
  if (id === null || request.id === undefined) return null; // a notification: no reply
  switch (method) {
    case 'server/discover':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          supportedVersions: SUPPORTED_VERSIONS,
          serverInfo: SERVER_INFO,
          capabilities: { tools: {} },
          _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
        },
      };
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      };
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    case 'tools/call': {
      const toolName = String(params.name ?? '');
      const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>;
      const outcome = callTool(toolName, args);
      if (outcome.error) return { jsonrpc: '2.0', id, error: outcome.error };
      return { jsonrpc: '2.0', id, result: outcome.result };
    }
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
  }
}

export interface McpReply {
  readonly status: number;
  readonly body: string;
}

/** Handle one POST /mcp body (already authenticated by app.ts). */
export function handleMcp(raw: Buffer): McpReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return {
      status: 400,
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }),
    };
  }
  if (Array.isArray(parsed)) {
    const replies = parsed
      .map((entry) => handleOne(entry as JsonRpcRequest))
      .filter((reply) => reply !== null);
    return { status: 200, body: JSON.stringify(replies) };
  }
  const reply = handleOne(parsed as JsonRpcRequest);
  if (reply === null) return { status: 202, body: '' };
  return { status: 200, body: JSON.stringify(reply) };
}
