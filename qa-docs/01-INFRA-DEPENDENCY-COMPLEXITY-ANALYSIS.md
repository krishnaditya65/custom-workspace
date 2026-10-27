# custom-workspace — Infra, Dependency & Complexity Analysis

Audience: LLM agents writing/running tests. Nothing here has been executed.

## 1. What it is
Real-time collaborative workspace (Slack + Notion + tasks + calendar + spatial audio rooms). pnpm monorepo: TypeScript 85 files / 30.4k LOC (includes Prisma generated client under `packages/db/generated` — exclude from coverage), TSX 13 files / 1.7k LOC, Go 17 files / 1.9k LOC, 1 SQL migration (286 LOC), JS bench scripts 11 files.

## 2. Components
| Component | Stack | Port | Role |
|---|---|---|---|
| `apps/api` | NestJS, Apollo GraphQL (+ graphql-ws subscriptions via `graphql-redis-subscriptions`), Prisma (`@workspace/db`), JWT/passport, bcrypt, ioredis, `@nestjs/throttler` | 4000 (`PORT`, `CORS_ORIGIN`) | modules: `auth`, `users`, `workspaces`, `channels`, `messages`, `tasks`, `calendar`, `guest-links`, `internal` (REST `internal/sessions` for sync), `health`, `common/rbac`, `redis`, `prisma` |
| `apps/sync` | Go, gorilla/websocket, pgx, go-redis, jwt | 1234 (`PORT`) | Yjs-compatible CRDT sync server (Hocuspocus-style protocol): `internal/{lib0 (varint codec), protocol, hub, redisbus, store, rbac, sessionsclient, config}`; env `DATABASE_URL`, `REDIS_URL`, `API_BASE_URL=http://localhost:4000`, `INTERNAL_SERVICE_SECRET`, `INSTANCE_ID`, `SESSION_VERIFY_TIMEOUT_MS`, `SNAPSHOT_DEBOUNCE_MS`; routes `/` (WS, `?token=`), `/health` |
| `apps/web` | SolidJS, @solidjs/router, yjs, @hocuspocus/provider, y-indexeddb (offline), y-prosemirror + prosemirror-*, livekit-client | 8080 (prod nginx) | features: `document`, `spatial-audio`, … |
| `packages/db` | Prisma schema + migrations | | `generate`, `migrate`, `migrate:deploy`, `studio` |
| `packages/shared` | TS types | | |
| `bench/` | Node: `verify-sync.mjs`, `sync-latency.mjs`, `sync-scale.mjs`, `api-throughput.mjs`, `run-all.mjs`, `lib/{gzip-frame,seed}.mjs` (yjs, y-websocket, ws, jsonwebtoken, pg) | | scripts `verify`, `bench:sync`, `bench:sync-scale`, `bench:api`, `bench:all` |

GraphQL operations (resolver method names): queries `me, user, workspace, myWorkspaces, channels, messages, tasks, events`; mutations `register, login, refreshToken, logout, createWorkspace, createChannel, archiveChannel, (sendMessage), editMessage, deleteMessage, createTask, assignTask, updateTaskStatus, createEvent, (createGuestLink), resolveGuestLink, (addMember)`; subscriptions for messages (confirm names).

## 3. Infra
`infra/docker-compose.yml`: Postgres 16 (host **5433**), Redis 7 (host **6390**), LiveKit server (7880 HTTP/WS signalling, 7881 TCP fallback).
`infra/docker-compose.prod.yml`: `api` :4000, `sync` :1234, `web` :8080→80 (images `custom-workspace/{api,sync,web}:${TAG}`). `infra/docker`, `infra/k8s`. Root scripts: `build`, `test`, `test:unit`, `test:e2e`, `bench`, `dev:infra`, `dev:infra:down`, `prisma:generate`, `prisma:migrate`.

## 4. Existing tests
`tests/api/services.deeper.spec.ts` (+ `jest.config.ts`), `tests/web/{api-client,gain}.deeper.spec.ts`, `apps/api/test` (e2e, supertest), `apps/api/src/{internal,common/rbac,auth}` specs, `apps/web/src/{lib,features/spatial-audio,features/document}` (vitest), `apps/sync/internal/{sessionsclient,rbac,protocol,lib0,hub}` Go tests. Reports/docs: `tests/TEST_REPORT.md`, `docs/{TESTING,BENCHMARKS,ARCHITECTURE,CODEBASE_REFERENCE,DEPLOYMENT}.md`.

## 5. Critical flows
A. Auth: register/login → access+refresh JWT → sessions; `logout` invalidates.
B. Realtime doc editing: web (Yjs + ProseMirror) ⇄ WS `sync:1234?token=` → sync verifies session via `api /internal/sessions` (secret `INTERNAL_SERVICE_SECRET`, timeout `SESSION_VERIFY_TIMEOUT_MS`) → RBAC → hub broadcasts updates → cross-instance fan-out via Redis bus (`INSTANCE_ID`) → debounced snapshot to Postgres (`SNAPSHOT_DEBOUNCE_MS`). Offline edits persisted in IndexedDB merge on reconnect.
C. Chat: mutation → Prisma → Redis pub/sub → GraphQL subscription to all API replicas.
D. Guest links: tokenised limited access to a resource.
E. Audio rooms: LiveKit token issuance + client-side spatial gain.

## 6. Complexity & risk hot-spots
| # | Area | Risk |
|---|---|---|
| 1 | Custom Go implementation of the Yjs sync protocol + lib0 codec | binary decoding of untrusted input (varint overflow, length bombs, truncated frames) ⇒ panic/OOM; protocol incompatibility with real Yjs clients across versions; awareness messages |
| 2 | CRDT convergence across instances | Redis bus loss/duplication/reordering; update echo loops between instances; clients on different instances must converge; late joiner state = snapshot + pending updates |
| 3 | Snapshot debounce durability | updates acked to clients but only persisted after debounce ⇒ loss window on crash; concurrent snapshot writers from multiple instances overwriting newer state with older (must merge, not overwrite); snapshot growth / compaction (GC of tombstones) |
| 4 | Authz on WS | token in query string (logs!), session revocation while socket open, per-document RBAC (viewer must be read-only: server must reject update messages), guest-link scope, cross-workspace doc names |
| 5 | Session verify dependency | api down/slow ⇒ sync must fail closed within timeout; caching of positive results vs revocation |
| 6 | GraphQL subscriptions | auth on `connection_init`, per-channel membership filtering (no leakage to non-members / other workspaces), fan-out across replicas, missed messages on reconnect |
| 7 | RBAC (`common/rbac`, sync `rbac`) | two implementations (TS + Go) must agree — parity table test |
| 8 | Messages | ordering, edit/delete by non-author, pagination cursors, archived channel writes |
| 9 | Tasks/calendar | status state machine, assignment to non-member, time zones / DST / recurring events (if any), overlapping events |
| 10 | Throttler | Redis-backed vs in-memory per replica; bypass via GraphQL batching/aliases |
| 11 | Offline-first client | IndexedDB merge after long offline; schema migrations of local data; two tabs |
| 12 | LiveKit | token grants scoped to room & identity; expiry; spatial gain math (distance → gain, clamping, NaN) |
| 13 | Refresh tokens | rotation/reuse detection, logout-all |
| 14 | Gzip frames (`bench/lib/gzip-frame.mjs` suggests compressed WS frames) | decompression bombs |

## 7. Invariants
1. **Convergence**: after quiescence, every client of a document and the persisted snapshot decode to an identical Yjs state (state vector + content), regardless of instance, ordering, duplication or reconnects.
2. **No acknowledged-edit loss** beyond the documented debounce window on crash; zero loss on graceful shutdown.
3. **Monotonic persistence**: a persisted snapshot is never replaced by one that lacks previously persisted operations.
4. **Authz**: no WS frame from doc D is delivered to a connection without read access to D; no update from a read-only/guest/expired/revoked principal is applied or broadcast.
5. **Tenant isolation**: workspace A's channels/messages/tasks/events/docs never visible to non-members (queries, subscriptions, sync).
6. **Message order**: per channel, all subscribers observe the same total order = persisted order; no duplicates.
7. Sync server never panics on arbitrary bytes.

## 8. Run
`pnpm i && pnpm dev:infra && pnpm prisma:generate && pnpm prisma:migrate`, start api (`pnpm --filter api start:dev`), sync (`cd apps/sync && go run ./cmd/sync`), web (`pnpm --filter web dev`). Tests: `pnpm test:unit`, `pnpm test:e2e`, `go test ./...` in `apps/sync`, `pnpm bench` / `node bench/verify-sync.mjs`.

## 9. Caveat
Exact GraphQL argument/field names, WS document-name convention (e.g. `doc:<id>`), JWT claims expected by sync, and `/internal/sessions` contract were not read. `bench/verify-sync.mjs` + `bench/lib/seed.mjs` are the authoritative working examples of connecting and seeding — copy their conventions.
