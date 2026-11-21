// The forge's HTTP server: one process serving git smart HTTP (/<owner>/<repo>.git/...),
// the REST v3 API (/api/v3/...), GraphQL v4 (/api/graphql) and MCP (/mcp) from one store.
// main.ts owns the lifecycle (bind, register, wait for done); this file is only the surface.
//
// Discipline the protocol checks assert: every API answer is JSON with a non-empty
// X-GitHub-Request-Id, error bodies always carry a message, a malformed JSON body is a 400
// (never a 500 or an HTML page), and no request can crash the process.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git-http.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { getRepo } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 512 * 1024 * 1024;

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(36)}-${((requestCounter * 2654435761) % 0xffffffff).toString(16)}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = body === null || body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
  });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function isAuthed(req: IncomingMessage): boolean {
  const token = process.env.MAKEFUN_SHOP_TOKEN;
  if (!token) return true; // local runs without a token configured
  return (req.headers.authorization ?? '') === `Bearer ${token}`;
}

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const path = url.pathname;
        const method = req.method ?? 'GET';

        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        const raw = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
        const authed = isAuthed(req);

        if (path === '/mcp') {
          if (method === 'DELETE') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          if (!authed) {
            sendJson(res, 401, { message: 'Bad credentials' });
            return;
          }
          const reply = handleMcp(raw);
          res.writeHead(reply.status, {
            'content-type': JSON_TYPE,
            'content-length': Buffer.byteLength(reply.body),
            'x-github-request-id': nextRequestId(),
          });
          res.end(reply.body);
          return;
        }

        if (path === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          if (!authed) {
            res.writeHead(401, { 'content-type': JSON_TYPE, 'x-github-request-id': nextRequestId() });
            res.end(JSON.stringify({ errors: [{ message: 'Bad credentials' }] }));
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw.toString('utf8'));
          } catch {
            sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
            return;
          }
          if (Array.isArray(parsed)) {
            sendJson(res, 200, parsed.map((entry) => executeGraphQL(entry as { query?: unknown; variables?: unknown })));
            return;
          }
          sendJson(res, 200, executeGraphQL(parsed as { query?: unknown; variables?: unknown }));
          return;
        }

        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const reply = handleRest(method, path, url.searchParams, raw, authed, req.headers.host ?? 'localhost');
          sendJson(res, reply.status, reply.body, reply.headers ?? {});
          return;
        }

        // Git smart HTTP: /<owner>/<repo>.git/<endpoint>
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        if (gitMatch) {
          const owner = decodeURIComponent(gitMatch[1]);
          const name = decodeURIComponent(gitMatch[2]);
          const endpoint = gitMatch[3];
          const repo = getRepo(owner, name);
          const store = repo ?? null;
          const protocolHeader = req.headers['git-protocol'] ?? '';
          const v2 = typeof protocolHeader === 'string' && protocolHeader.includes('version=2');
          if (endpoint === 'info/refs' && method === 'GET') {
            const service = url.searchParams.get('service') ?? '';
            const reply = handleInfoRefs(store, service, v2);
            sendRaw(res, reply.status, reply.contentType, reply.body);
            return;
          }
          if (endpoint === 'git-upload-pack' && method === 'POST') {
            const reply = handleUploadPack(store, raw, v2);
            sendRaw(res, reply.status, reply.contentType, reply.body);
            return;
          }
          if (endpoint === 'git-receive-pack' && method === 'POST') {
            const reply = handleReceivePack(store, raw);
            sendRaw(res, reply.status, reply.contentType, reply.body);
            return;
          }
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch {
        try {
          sendJson(res, 500, { message: 'Internal Server Error' });
        } catch {
          // The socket is already gone; the server itself stays up.
        }
      }
    })();
  });
}
