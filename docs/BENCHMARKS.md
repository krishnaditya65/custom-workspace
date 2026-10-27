# Benchmarks

The `bench/` package is a **real-client** correctness + performance harness
for `apps/sync` (the Go CRDT relay) and `apps/api` (the GraphQL API) — it
drives the actual `yjs`/`y-websocket` npm libraries and real GraphQL
requests against a live server, not simulations. See
[TESTING.md](TESTING.md) for why real clients matter here specifically.

This document explains what each benchmark measures and how to run it. It
intentionally does **not** ship a "our system does N req/s" headline number:
no run has been recorded from this checkout, and a benchmark number without
the exact hardware/build/load conditions it was measured under is close to
meaningless (and easy to misquote later as a load-bearing guarantee). Run
these yourself against your target hardware and record the output; the
"Recording a run" section below is the template for doing that honestly.

## Prerequisites

```sh
pnpm dev:infra                          # Postgres + Redis (+ LiveKit)
pnpm prisma:migrate
pnpm --filter @workspace/bench install  # first time only

# apps/sync, in its own terminal, built in release mode for a real number:
cd apps/sync && go build -o /tmp/sync ./cmd/sync && /tmp/sync &
echo $!   # note the PID — pass it as SYNC_PID below for RSS reporting

# apps/api, in its own terminal, similarly built rather than run via ts-jest/watch:
pnpm --filter @workspace/api run build
node apps/api/dist/main.js &
```

Run each benchmark on an otherwise-idle machine. All three scripts below are
explicit that they measure **loopback, single-machine** conditions — none of
them are a substitute for a real multi-machine load test.

## `sync-latency.mjs` — fan-out latency + sustained throughput

```sh
SYNC_PID=<pid> pnpm --filter @workspace/bench run bench:sync
```

Two measurements against one live `apps/sync` instance, using real Yjs
clients over real WebSocket connections:

1. **Fan-out latency**: one sender inserts a character; wall-clock time
   until all other connected clients in the same room observe it. Reported
   as avg/p50/p95/p99/max over `FANOUT_ROUNDS` (default 50) rounds with
   `FANOUT_CLIENTS` (default 10) clients in the room.
2. **Sustained throughput**: one writer inserts continuously for
   `THROUGHPUT_SECONDS` (default 5s); reports the writer's achieved
   updates/sec and each observer's received chars/sec.

Env vars: `SYNC_URL` (default `ws://localhost:1234`), `FANOUT_CLIENTS`,
`FANOUT_ROUNDS`, `THROUGHPUT_SECONDS`, `SYNC_PID` (optional — enables
before/after RSS reporting via `ps`).

## `sync-scale.mjs` — connection-scale smoke test

```sh
SYNC_PID=<pid> pnpm --filter @workspace/bench run bench:sync-scale
```

Opens `NUM_DOCS × CLIENTS_PER_DOC` (default 50 × 4 = 200) real WebSocket
clients across many separate document rooms and reports connect-time
distribution (p50/p95/max) and server RSS before/during/after. This is
explicitly **not** a claim that the system handles "thousands of concurrent
connections" — see the header comment in `sync-scale.mjs` — multi-machine
load generation is out of scope for this harness. It's an honest,
reproducible data point at whatever scale one laptop can actually drive.

Env vars: `SYNC_URL`, `SYNC_PID`, `NUM_DOCS`, `CLIENTS_PER_DOC`.

## `api-throughput.mjs` — GraphQL request throughput

```sh
API_PID=<pid> pnpm --filter @workspace/bench run bench:api
```

Sustained-load benchmark against a live `apps/api` instance: `CONCURRENCY`
(default 20) concurrent workers each repeatedly run one GraphQL operation
against real HTTP for `DURATION_SECONDS` (default 5s), authenticated as a
real seeded user. Reports achieved requests/sec and p50/p95/p99 latency per
operation, for:

- `sendMessage` mutation (write path — exercises `PermissionsGuard`'s
  `channelId` → `Channel` → `Workspace` resolution on every call, same as
  production traffic)
- `messages` query (read path, paginated)

Env vars: `API_URL` (default `http://localhost:4000/graphql`),
`CONCURRENCY`, `DURATION_SECONDS`, `API_PID` (optional RSS reporting).

Like the sync benchmarks, this measures one API replica on loopback — it
does not exercise the Redis-backed rate limiter's cross-replica behavior or
a real load balancer, and `@nestjs/throttler`'s 100 req/60s-per-client
default (see [ARCHITECTURE.md](ARCHITECTURE.md)) will start rejecting a
single worker's requests well before `CONCURRENCY` workers saturate
anything interesting — either raise the throttle limit for the benchmark
run or interpret rate-limited (429) responses as expected background noise,
not benchmark failure.

## `verify-sync.mjs` — not a benchmark

Listed here only to disambiguate: this is a correctness check (does the
relay + persisted snapshot actually round-trip real Yjs state?), not a
performance measurement. See [TESTING.md](TESTING.md).

## Running everything: `pnpm bench`

`pnpm bench` (root) runs `bench/run-all.mjs`, which sequences `verify` →
`bench:sync` → `bench:api` against whatever `SYNC_URL`/`API_URL` are already
running (it does not start or stop `apps/api`/`apps/sync`/infra itself —
see the Prerequisites section above) and prints a combined JSON summary at
the end. Use the individual scripts above during iteration; use `pnpm
bench` for a single end-to-end pass you intend to record.

## Recording a run

When you do record numbers to share (e.g. in a PR description or an
incident postmortem baseline), capture at minimum:

- Exact commit / `git rev-parse HEAD`
- Machine spec (CPU, RAM) and whether Postgres/Redis were local or remote
- `apps/sync` built with `go build` (not `go run`) — debug builds are
  meaningfully slower
- The full env var overrides used (concurrency, durations, client counts)
- The raw JSON summary each script prints, not just the human-readable log
  lines

A number without those is not reproducible and shouldn't be treated as load
-bearing.
