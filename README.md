# makefun-github-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/fulede9394/makefun-github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/fulede9394/makefun-github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A small, dependency-free, GitHub-compatible git forge in a single Node 22
process, built for the
[make.fun GitHub Core Clone bounty](https://make.fun/bounty/github-core-clone-01)
(competition `github-core-clone-01`, $500, entries close 2026-11-21 06:30 UTC).

No packages, no git binary, no network access at runtime. Everything the forge
serves comes from its own in-memory store: git objects, packs, repos, issues
and pull requests are all implemented from scratch in this repository.

## What it serves

- **Git smart HTTP** — `/{owner}/{repo}.git`
  - `upload-pack` protocol v2 (advertisement, `ls-refs`, `fetch`) with a
    protocol v0 fallback, shallow clones, deepen and incremental fetches
  - `receive-pack` v0 with `report-status`, `side-band-64k` and
    `delete-refs`; fast-forward only (a non-fast-forward ref is refused with
    `ng <ref> non-fast-forward` while the good refs in the same push apply)
  - Object storage, packfile generation and parsing written from scratch;
    packs are plain (non-delta) and version 2
- **REST v3** — `/api/v3`
  - Repos (create, read, update, delete), branches, commits, git refs,
    contents (PUT/DELETE with sha; 409 on a stale sha), labels, issues,
    comments, pull requests and squash merges
  - Every reply is `application/json` with a non-empty
    `X-GitHub-Request-Id`; errors are JSON `{ "message": ... }`
  - Bearer token auth (`MAKEFUN_SHOP_TOKEN`); no token is 401, an unknown
    repo is 404 (never 403), an unknown route is a JSON 404, a malformed
    JSON body is 400
- **GraphQL v4** — `POST /api/graphql`
  - `__type` introspection for `Issue`, `PullRequest` and `Repository`,
    `SearchType` including `ISSUE`, `repository.issues` ordered by
    `CREATED_AT DESC`, `createIssue` / `closeIssue` / `createPullRequest` /
    `mergePullRequest` / `addComment`, cursor pagination, `node(id:)`
    round-trips, and two operation documents in one body answered in order
  - Unknown fields return HTTP 200 with an `errors` array; an unknown repo
    returns `data.repository: null` with no errors
- **MCP** — `POST /mcp`, JSON-RPC 2.0 Streamable HTTP, revision 2026-07-28
  - `server/discover` (and the legacy `initialize` handshake), `tools/list`
    and `tools/call` for `create_repo`, `get_repo`, `create_issue`,
    `list_issues`, `create_pull_request` and `merge_pull_request`
  - The tools share the store with REST, so a repo or issue made through
    one surface is visible through the other

## Layout

| File | What it does |
| --- | --- |
| `main.ts` | The entry: binds an ephemeral port, registers it with the env, polls until the env says done, exits 0 |
| `app.ts` | The HTTP server and router |
| `store.ts` | The in-memory store: repos, refs, objects, issues, pull requests, squash merges |
| `gitkit.ts` | SHA-1 objects, trees/commits/tags, reachability, packfile read/write, pkt-lines |
| `gitproto.ts` | The git smart-HTTP protocol (upload-pack v2/v0, receive-pack v0) |
| `rest.ts` | REST v3 |
| `graphql.ts` | A hand-rolled GraphQL parser and executor |
| `mcp.ts` | The MCP endpoint |

## Running it

```sh
MAKEFUN_SHOP_TOKEN=your-token MAKEFUN_ENV_URL=http://your-env npm start
```

Or just the server for local testing:

```sh
MAKEFUN_SHOP_TOKEN=test node --experimental-strip-types main.ts
```

`MAKEFUN_ENV_URL` is required: the entry registers its port there and waits
for the env to signal the end of the trial. The store is in memory, so the
repo directory is never written to at runtime.

## Referral

Made with [make.fun](https://make.fun/r/5kkq1ant) — referral code `5kkq1ant`.
