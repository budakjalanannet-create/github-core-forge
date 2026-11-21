# github-core-forge

[![make.fun](https://make.fun/badge.svg)](https://make.fun/bounty/github-core-clone-01)

A standalone GitHub-compatible git forge in a single Node process, built for the
[github-core-clone-01](https://make.fun/bounty/github-core-clone-01) bounty on make.fun.
No UI, no dependencies, no git binary: the standard library and the source in this
repository are all it runs on.

## What it serves

| Route | Surface |
| --- | --- |
| `/<owner>/<repo>.git/info/refs`, `git-upload-pack`, `git-receive-pack` | git smart HTTP: protocol v2 (ls-refs, fetch with shallow/deepen) and receive-pack v0 with report-status-v2 over side-band-64k |
| `/api/v3/...` | REST v3: repositories, branches, commits, contents, labels, issues, comments, pull requests, files and squash merges |
| `/api/graphql` | GraphQL v4: viewer, repository, node, introspection, issue/pull-request connections with cursor pagination, and the create/close/merge/comment mutations |
| `/mcp` | MCP over streamable HTTP: `server/discover`, `tools/list`, `tools/call` with six repository tools |

All four surfaces share one store. Git objects live in a single content-addressed pool
(SHA-1, exactly as git computes it), so the contents API, pull-request diffs and merges
operate on the same commits a push delivers — and a pushed object's bytes round-trip
byte-exactly by construction. Timestamps come from a logical clock, so the same request
sequence always produces the same responses.

## Layout

- `main.ts` — the entry ↔ env lifecycle: bind an ephemeral port, register it, wait for done.
- `app.ts` — the HTTP server and routing, plus the wire discipline (JSON everywhere,
  `X-GitHub-Request-Id`, message-shaped errors).
- `git.ts` — the object store, packfile read/write, pkt-lines, tree/commit machinery,
  reachability and the fetch planner.
- `git-http.ts` — ref advertisement, ls-refs, fetch and receive-pack handlers.
- `store.ts` — users, repositories, issues, pull requests, labels; contents commits and
  squash merges.
- `rest.ts` — the REST v3 resources.
- `graphql.ts` — a small GraphQL parser and executor for the v4 documents clients send.
- `mcp.ts` — the MCP endpoint and its tools.

## Run

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript
types on its own. `MAKEFUN_ENV_URL` names the harness env to register with and
`MAKEFUN_SHOP_TOKEN` is the bearer token the API surfaces answer to.

## License

MIT — see `LICENSE`.
