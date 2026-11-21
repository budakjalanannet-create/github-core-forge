// The forge's HTTP server: one process serving git smart HTTP (/<owner>/<repo>.git/...),
// the REST v3 API (/api/v3/...), GraphQL v4 (/api/graphql) and MCP (/mcp) from one store.
// main.ts owns the lifecycle (bind, register, wait for done); this file is only the surface.
//
// The transport is a hand-rolled HTTP/1.1 server on node:net. The bench workloads are
// thousands of small sequential requests; Node's http stack spends more time per request
// on header bookkeeping than the handlers spend on the work, so the wire layer parses
// exactly what the handlers need (request line, a header map, a length- or chunk-framed
// body) and writes one response buffer per request. Routing and replies are unchanged.
//
// Discipline the protocol checks assert: every API answer is JSON with a non-empty
// X-GitHub-Request-Id, error bodies always carry a message, a malformed JSON body is a 400
// (never a 500 or an HTML page), and no request can crash the process.

import { createServer, type Server, type Socket } from 'node:net';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git-http.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { getRepo } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 512 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(36)}-${((requestCounter * 2654435761) % 0xffffffff).toString(16)}`;
}

interface Reply {
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
  readonly headers?: Readonly<Record<string, string>>;
}

function jsonReply(status: number, body: unknown, headers?: Readonly<Record<string, string>>): Reply {
  const text = body === null || body === undefined ? '' : `${JSON.stringify(body)}\n`;
  return { status, contentType: JSON_TYPE, body: Buffer.from(text, 'utf8'), headers };
}

function isAuthed(headers: ReadonlyMap<string, string>): boolean {
  const token = process.env.MAKEFUN_SHOP_TOKEN;
  if (!token) return true; // local runs without a token configured
  return (headers.get('authorization') ?? '') === `Bearer ${token}`;
}

/** Route one fully-read request. Synchronous: every surface handler is. */
function route(method: string, target: string, headers: ReadonlyMap<string, string>, rawBody: Buffer): Reply {
  const q = target.indexOf('?');
  const path = q < 0 ? target : target.slice(0, q);
  const query = new URLSearchParams(q < 0 ? '' : target.slice(q + 1));
  const raw = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : rawBody;

  if (method === 'GET' && path === '/healthz') return jsonReply(200, { ok: true });

  const authed = isAuthed(headers);

  if (path === '/mcp') {
    if (method === 'DELETE') return jsonReply(404, { message: 'Not Found' });
    if (method !== 'POST') return jsonReply(405, { message: 'Method Not Allowed' });
    if (!authed) return jsonReply(401, { message: 'Bad credentials' });
    const reply = handleMcp(raw);
    return { status: reply.status, contentType: JSON_TYPE, body: Buffer.from(reply.body, 'utf8') };
  }

  if (path === '/api/graphql') {
    if (method !== 'POST') return jsonReply(405, { message: 'Method Not Allowed' });
    if (!authed) {
      return {
        status: 401,
        contentType: JSON_TYPE,
        body: Buffer.from(JSON.stringify({ errors: [{ message: 'Bad credentials' }] }), 'utf8'),
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      return jsonReply(400, { errors: [{ message: 'Problems parsing JSON' }] });
    }
    if (Array.isArray(parsed)) {
      return jsonReply(200, parsed.map((entry) => executeGraphQL(entry as { query?: unknown; variables?: unknown })));
    }
    return jsonReply(200, executeGraphQL(parsed as { query?: unknown; variables?: unknown }));
  }

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    const reply = handleRest(method, path, query, raw, authed, headers.get('host') ?? 'localhost');
    return jsonReply(reply.status, reply.body, reply.headers ?? {});
  }

  // Git smart HTTP: /<owner>/<repo>.git/<endpoint>
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (gitMatch) {
    const owner = decodeURIComponent(gitMatch[1]);
    const name = decodeURIComponent(gitMatch[2]);
    const endpoint = gitMatch[3];
    const store = getRepo(owner, name) ?? null;
    const protocolHeader = headers.get('git-protocol') ?? '';
    const v2 = protocolHeader.includes('version=2');
    if (endpoint === 'info/refs' && method === 'GET') {
      const reply = handleInfoRefs(store, query.get('service') ?? '', v2);
      return { status: reply.status, contentType: reply.contentType, body: reply.body };
    }
    if (endpoint === 'git-upload-pack' && method === 'POST') {
      const reply = handleUploadPack(store, raw, v2);
      return { status: reply.status, contentType: reply.contentType, body: reply.body };
    }
    if (endpoint === 'git-receive-pack' && method === 'POST') {
      const reply = handleReceivePack(store, raw);
      return { status: reply.status, contentType: reply.contentType, body: reply.body };
    }
    return jsonReply(404, { message: 'Not Found' });
  }

  return jsonReply(404, { message: 'Not Found' });
}

const REASONS: Readonly<Record<number, string>> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

function serializeResponse(reply: Reply, keepAlive: boolean, headOnly: boolean): Buffer {
  let head = `HTTP/1.1 ${reply.status} ${REASONS[reply.status] ?? 'Status'}\r\n`;
  head += `content-type: ${reply.contentType}\r\n`;
  head += `content-length: ${reply.body.length}\r\n`;
  head += `x-github-request-id: ${nextRequestId()}\r\n`;
  if (reply.headers) {
    for (const [name, value] of Object.entries(reply.headers)) head += `${name.toLowerCase()}: ${value}\r\n`;
  }
  head += `connection: ${keepAlive ? 'keep-alive' : 'close'}\r\n\r\n`;
  const headBuffer = Buffer.from(head, 'utf8');
  return headOnly ? headBuffer : Buffer.concat([headBuffer, reply.body]);
}

interface ParsedHead {
  readonly method: string;
  readonly target: string;
  readonly version: string;
  readonly headers: Map<string, string>;
  readonly headBytes: number;
}

/** Parse a request head; null when the bytes so far are incomplete or malformed. */
function parseHead(buffer: Buffer): ParsedHead | 'malformed' | null {
  const end = buffer.indexOf('\r\n\r\n');
  if (end < 0) return buffer.length > MAX_HEADER_BYTES ? 'malformed' : null;
  const text = buffer.subarray(0, end).toString('latin1');
  const lines = text.split('\r\n');
  const first = /^(\S+) (\S+) (HTTP\/\d\.\d)$/.exec(lines[0]);
  if (!first) return 'malformed';
  const headers = new Map<string, string>();
  for (let i = 1; i < lines.length; i += 1) {
    const colon = lines[i].indexOf(':');
    if (colon <= 0) return 'malformed';
    headers.set(lines[i].slice(0, colon).trim().toLowerCase(), lines[i].slice(colon + 1).trim());
  }
  return { method: first[1], target: first[2], version: first[3], headers, headBytes: end + 4 };
}

/** Read a chunked body starting at `start`; returns the body and bytes consumed, or null when incomplete. */
function readChunked(buffer: Buffer, start: number): { body: Buffer; consumed: number } | 'malformed' | null {
  const parts: Buffer[] = [];
  let offset = start;
  let total = 0;
  for (;;) {
    const lineEnd = buffer.indexOf('\r\n', offset);
    if (lineEnd < 0) return null;
    const sizeText = buffer.subarray(offset, lineEnd).toString('latin1').split(';')[0].trim();
    if (!/^[0-9a-fA-F]+$/.test(sizeText)) return 'malformed';
    const size = parseInt(sizeText, 16);
    offset = lineEnd + 2;
    if (size === 0) {
      // Trailers run to an empty line; the common case is just the final CRLF.
      if (buffer.length >= offset + 2 && buffer[offset] === 0x0d && buffer[offset + 1] === 0x0a) {
        return { body: Buffer.concat(parts), consumed: offset + 2 };
      }
      const trailersEnd = buffer.indexOf('\r\n\r\n', offset);
      if (trailersEnd < 0) return null;
      return { body: Buffer.concat(parts), consumed: trailersEnd + 4 };
    }
    total += size;
    if (total > MAX_BODY_BYTES) return 'malformed';
    if (buffer.length < offset + size + 2) return null;
    parts.push(buffer.subarray(offset, offset + size));
    offset += size + 2; // chunk data + its trailing CRLF
  }
}

function handleSocket(socket: Socket): void {
  let buffer: Buffer = Buffer.alloc(0);
  let dead = false;
  socket.on('error', () => {
    dead = true;
  });
  socket.on('data', (chunk: Buffer) => {
    if (dead) return;
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    try {
      for (;;) {
        const head = parseHead(buffer);
        if (head === null) return; // wait for more bytes
        if (head === 'malformed') {
          dead = true;
          socket.end(serializeResponse(jsonReply(400, { message: 'Bad Request' }), false, false));
          return;
        }
        const expect = head.headers.get('expect') ?? '';
        if (expect.toLowerCase().includes('100-continue')) {
          socket.write('HTTP/1.1 100 Continue\r\n\r\n');
        }
        const rest = buffer.subarray(head.headBytes);
        let body: Buffer;
        let consumed: number;
        const transferEncoding = (head.headers.get('transfer-encoding') ?? '').toLowerCase();
        const contentLength = head.headers.get('content-length');
        if (transferEncoding.includes('chunked')) {
          const chunked = readChunked(rest, 0);
          if (chunked === null) return; // wait for more bytes
          if (chunked === 'malformed') {
            dead = true;
            socket.end(serializeResponse(jsonReply(400, { message: 'Bad Request' }), false, false));
            return;
          }
          body = chunked.body;
          consumed = head.headBytes + chunked.consumed;
        } else if (contentLength !== undefined) {
          const length = Number(contentLength);
          if (!Number.isInteger(length) || length < 0 || length > MAX_BODY_BYTES) {
            dead = true;
            socket.end(serializeResponse(jsonReply(400, { message: 'Bad Request' }), false, false));
            return;
          }
          if (rest.length < length) return; // wait for more bytes
          body = rest.subarray(0, length);
          consumed = head.headBytes + length;
        } else {
          body = Buffer.alloc(0);
          consumed = head.headBytes;
        }
        const connection = (head.headers.get('connection') ?? '').toLowerCase();
        const keepAlive = head.version === 'HTTP/1.0' ? connection.includes('keep-alive') : !connection.includes('close');
        let reply: Reply;
        try {
          reply = route(head.method, head.target, head.headers, body);
        } catch {
          reply = jsonReply(500, { message: 'Internal Server Error' });
        }
        socket.write(serializeResponse(reply, keepAlive, head.method === 'HEAD'));
        buffer = buffer.subarray(consumed);
        if (!keepAlive) {
          dead = true;
          socket.end();
          return;
        }
      }
    } catch {
      // A transport-level surprise must not take the process down; drop the socket.
      dead = true;
      socket.destroy();
    }
  });
}

export function createApp(): Server {
  const server = createServer(handleSocket);
  server.on('error', () => {
    // Listen errors are main.ts's concern (it awaits the listen callback); never crash here.
  });
  return server;
}
