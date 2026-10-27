# Testing

Four independent test layers, from fast/isolated to slow/real:

| Layer | Where | Needs infra? | Run with |
|---|---|---|---|
| Unit (TS) | `apps/api/src/**/*.spec.ts`, `apps/web/src/**/*.spec.ts` | No | `pnpm test` / `pnpm test:unit` |
| Unit (Go) | `apps/sync/internal/**/*_test.go` | No | `go test ./...` (in `apps/sync`) |
| E2E (API) | `apps/api/test/app.e2e-spec.ts` | Yes (Postgres + Redis) | `pnpm test:e2e` |
| Real-client correctness | `bench/verify-sync.mjs` | Yes (Postgres + apps/sync running) | `pnpm --filter @workspace/bench run verify` |

## Unit tests

No external services required — run these constantly during development.

```sh
pnpm test          # apps/api + apps/web unit suites, via each app's own `test` script
pnpm test:unit      # same, via each app's `test:unit` script where it differs from `test`
```

- **apps/api** (`jest --config jest.config.ts`): notably
  [`rbac.util.spec.ts`](../apps/api/src/common/rbac/rbac.util.spec.ts) — the
  full truth table for `canPerform(role, required)` — and
  `auth.service.spec.ts` covering token issuance/refresh/revocation.
- **apps/web** (`vitest run`): pure-logic units like
  `undo-scope.spec.ts` (collaborative editor undo/redo scoping) and
  `gain.spec.ts` (spatial audio gain curve for huddles).
- **apps/sync** (`go test ./...`, run from `apps/sync/`): `internal/hub`
  (room lifecycle, debounce/flush timing — see `room_test.go`'s
  `fakePersister`, which asserts write count/content without a real
  Postgres), `internal/lib0` (wire encoding), `internal/protocol` (message
  framing), `internal/rbac` (the local `PermissionLevel`-ranking helpers —
  see below), `internal/sessionsclient` (the HTTP client for
  `POST /internal/sessions/verify`, tested against an `httptest.Server` —
  covers the valid/invalid-session/unreachable-api response shapes).

### RBAC is resolved by apps/api alone

`apps/sync` used to hand-maintain its own Go copy of the RBAC permission
matrix (`internal/rbac.EffectivePermission`), kept honest only by running the
same truth table as two independent test suites (a TS one in apps/api, a Go
mirror in apps/sync) and hoping neither drifted. That's gone: apps/sync now
calls apps/api's `POST /internal/sessions/verify`
(`apps/api/src/internal/internal-sessions.service.ts`) on every new
connection, which reuses the exact same JWT verification and
`@workspace/shared` RBAC matrix (`DEFAULT_ROLE_PERMISSION`, `canPerform`)
that GraphQL requests go through. There is now exactly one implementation of
"does role X get permission Y", tested in exactly one place —
`apps/api/src/internal/internal-sessions.service.spec.ts` plus
`rbac.util.spec.ts`. `internal/rbac/rbac_test.go` in apps/sync now only
covers the pure `CanAccess`/`ReadOnly` ranking helpers that remain local to
the Go relay once it already has a permission from apps/api in hand.

## E2E tests (apps/api)

Real GraphQL requests against a real Nest app instance, with a real Postgres
and Redis — no mocks. Exercises the whole path: resolver → guard
(`JwtAuthGuard`/`RolesGuard`/`PermissionsGuard`) → service → Prisma →
Postgres.

```sh
pnpm dev:infra          # starts Postgres + Redis (+ LiveKit) via infra/docker-compose.yml
pnpm prisma:migrate     # apply the schema if not already applied
pnpm test:e2e
```

Not run as part of `pnpm test` — it's slower and requires live infra, so
keep it out of the fast inner loop. Each run uses unique per-run emails
(`owner-<runId>@example.com`) so it's safe to run repeatedly against a
persistent dev database without hitting `User.email`'s unique constraint.

## Real-client correctness (apps/sync)

`apps/sync` never decodes or merges Yjs updates itself — it's a relay, not a
CRDT engine (see [ARCHITECTURE.md](ARCHITECTURE.md)). That means the only
way to actually prove the wire protocol is byte-correct is to drive it with
*real* Yjs clients, not a Go-side simulation of the protocol. That's what
`bench/verify-sync.mjs` does, using the real `yjs` + `y-websocket` npm
packages:

```sh
pnpm dev:infra
go run ./cmd/sync                       # from apps/sync/, in a separate terminal
pnpm --filter @workspace/bench install  # first time only
pnpm --filter @workspace/bench run verify
```

It checks, against a live relay:

1. Two independent Yjs clients converge on one client's insert (round-trip
   through the Go relay).
2. Concurrent edits from both clients converge identically on both sides —
   the actual CRDT conflict-free guarantee, with the server never
   arbitrating, ordering, or locking anything.
3. After the write-behind debounce window elapses, a `DocumentSnapshot` row
   exists in Postgres.
4. That persisted snapshot, gunzipped/unframed and replayed through a fresh
   `Y.Doc`, reconstructs the **exact same** document text — i.e. the
   persisted binary snapshot isn't just present, it's actually correct.

### A bug this approach has already caught

`internal/protocol.EncodeSyncStep1Empty` advertises an empty Yjs state
vector on every fresh room load (this server doesn't maintain a real Yjs
state vector — see ARCHITECTURE.md). An empty *lib0-encoded map* is not a
zero-length byte string; it's the single byte `0x00` (`writeVarUint(0)`,
"0 clients"). Handing a genuinely empty payload to a real Yjs client makes
`Y.encodeStateAsUpdate()`'s decoder run `readVarUint()` past the end of the
buffer and throw. A Go-only test asserting "the payload equals `[]byte{}`"
would have happily passed while breaking every real client — this was only
caught by connecting an actual `y-websocket` client (i.e. running
`verify-sync.mjs` against a real relay) and watching it throw. It's the
canonical example of why this layer exists on top of the Go unit tests.

## Benchmarks (not correctness tests)

`bench/sync-latency.mjs` and `bench/sync-scale.mjs` measure fan-out latency,
sustained throughput, and connection-scale behavior — see
[BENCHMARKS.md](BENCHMARKS.md). They're perf instrumentation, not
pass/fail correctness checks, and are not run in CI gating.

## Running everything

```sh
pnpm build                 # apps/api + apps/web build; apps/sync via `go build ./...`
pnpm dev:infra
pnpm prisma:migrate
pnpm test                  # unit (TS)
(cd apps/sync && go test ./...)   # unit (Go)
pnpm test:e2e               # e2e (needs infra up)
pnpm --filter @workspace/bench run verify   # real-client correctness (needs infra + apps/sync running)
```
