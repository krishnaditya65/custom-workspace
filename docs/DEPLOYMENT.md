# Deployment

This covers running a full production-shaped stack, either with
docker-compose (single host) or Kubernetes (`infra/k8s/`). For local
development, use `infra/docker-compose.yml` (backing services only) with
`apps/api`/`apps/sync`/`apps/web` run natively — see the root `README`-style
comment at the top of that file and [TESTING.md](TESTING.md).

## Images

Each app builds its own production container image; there is no shared
base image.

| App | Dockerfile | Base | Exposes |
|---|---|---|---|
| `apps/api` | `apps/api/Dockerfile` | `node:20-slim`, multi-stage, non-root `nestjs` user | `4000` |
| `apps/sync` | `apps/sync/Dockerfile` | `golang:1.23-alpine` build → `distroless/static-debian12:nonroot` runtime | `1234` |
| `apps/web` | `apps/web/Dockerfile` | `node:20-alpine` build → `nginx:1.27-alpine` runtime (static SPA + client-side-routing fallback) | `80` |

Build from the **repo root** (all three Dockerfiles `COPY` workspace-level
manifests for pnpm/go module resolution):

```sh
docker build -f apps/api/Dockerfile  -t custom-workspace/api:<tag>  .
docker build -f apps/sync/Dockerfile -t custom-workspace/sync:<tag> .
docker build -f apps/web/Dockerfile  -t custom-workspace/web:<tag>  \
  --build-arg VITE_API_URL=https://api.example.com \
  --build-arg VITE_WS_URL=wss://sync.example.com \
  --build-arg VITE_LIVEKIT_URL=wss://livekit.example.com \
  .
```

`apps/web`'s `VITE_*` vars are **build-time**, baked into the static bundle
by `vite build` — there's no way to change them at container-start time
short of rebuilding the image (a plain nginx `ConfigMap`-mounted `env.js`
indirection would be needed to make them runtime-configurable; this repo
doesn't do that). Get them right at build time per environment.

## Required configuration

Only `apps/api` reads `JWT_ACCESS_SECRET` now — it's the only service that
verifies access tokens. `apps/sync` instead calls `apps/api`'s
`POST /internal/sessions/verify` for every new WebSocket connection, so
`apps/api` stays the single source of truth for both session validity and
effective RBAC permission. That call is authenticated with a separate
shared secret, `INTERNAL_SERVICE_SECRET`, which **must** be byte-identical
between `apps/api` and `apps/sync` (sent as the `x-internal-secret` header)
and `apps/sync` also needs `API_BASE_URL` pointing at `apps/api`'s origin.
Generate real secrets per environment with `openssl rand -hex 32`; never
reuse the `.env.example` placeholder values. See `apps/api/.env.example` and
`apps/sync/.env.example` for the full variable lists (`DATABASE_URL`,
`REDIS_URL`, `JWT_REFRESH_PEPPER`, `CORS_ORIGIN`, `SNAPSHOT_DEBOUNCE_MS`,
`SESSION_VERIFY_TIMEOUT_MS`, `INSTANCE_ID`, ...).

## Database migrations

Run once per deploy, before rolling out new `apps/api`/`apps/sync` versions
that depend on a schema change:

```sh
pnpm prisma:migrate   # pnpm --filter @workspace/db run migrate
```

Both `apps/api` (via Prisma) and `apps/sync` (via raw SQL — see
[ARCHITECTURE.md](ARCHITECTURE.md)) read the same schema; `apps/sync`'s
table/column references are hand-kept in sync with
`packages/db/prisma/schema.prisma` and are **not** regenerated from a
migration, so a schema change that renames/removes a column `apps/sync`
touches (`Document`, `WorkspaceMember`, `DocumentSnapshot`) requires a
matching manual update to `apps/sync/internal/store`.

## Horizontal scaling

Both `apps/api` and `apps/sync` are designed to run as multiple replicas,
but each has a Redis-dependent fan-out path that must be wired up for
multi-replica correctness, not just multi-replica *availability*:

- **apps/api**: `messageAdded` GraphQL subscription fan-out
  (`graphql-redis-subscriptions`) and the rate limiter
  (`RedisThrottlerStorage`) both require `REDIS_URL` to be reachable. Safe
  to run N replicas behind any HTTP-aware load balancer — requests are
  stateless.
- **apps/sync**: cross-instance room broadcast requires `REDIS_URL`
  reachable **at startup** — if unreachable, the instance logs a warning and
  runs standalone (single-instance-correct, multi-instance-**incorrect**:
  two users on the same document routed to different replicas will not see
  each other's edits). Set a distinct `INSTANCE_ID` per replica (defaults to
  `<hostname>-<pid>`, which is normally already unique in k8s). Because
  `apps/sync` holds per-room in-memory state, its load balancer **must** use
  sticky routing so all clients of a given `doc:<id>`/`board:<id>` room can
  reach the same replica's WebSocket — Redis fan-out handles cross-replica
  visibility for correctness even without stickiness, but every client
  reconnecting to a *different* replica on every request would mean nobody
  ever converges directly and everything round-trips through Redis. In
  Kubernetes terms: a `Service` alone load-balances arbitrarily per-request;
  for real WebSocket connections that's moot (a connection, once
  established, stays on whichever pod it dialed) but an `Ingress`/L7 LB in
  front should still not do connection draining that fights long-lived
  WebSockets. No consistent-hashing-by-room-id is implemented — this is
  "works, and self-heals across replica loss via Postgres reload", not
  "avoids the Redis round-trip for same-replica peers by routing them
  together".
- **apps/web**: fully stateless static assets — scale trivially.

## Health checks

- `apps/api`: `GET /health` — always returns HTTP 200; body's `status` field
  is `"ok"` or `"degraded"` (Postgres/Redis reachability). Because it never
  reflects dependency issues as a non-200, a k8s **liveness** probe against
  it only detects "the process is wedged/dead", not "a dependency is down" —
  that's intentional (see [ARCHITECTURE.md](ARCHITECTURE.md)); alert on the
  JSON body's `status`/`dependencies` fields separately (e.g. via a
  sidecar/scraper), don't rely on probe failures for that signal.
- `apps/sync`: `GET /health` — static `{"status":"ok"}`, process-liveness
  only (no dependency check).
- `apps/web` (nginx): any `GET /` (returns `index.html`) is a sufficient
  liveness/readiness check.

## docker-compose (single host)

`infra/docker-compose.prod.yml` builds and runs the full stack — Postgres,
Redis, LiveKit, and the three app images — on one host. It's additive to
`infra/docker-compose.yml`, not a replacement:

```sh
docker compose -f infra/docker-compose.yml -f infra/docker-compose.prod.yml up -d --build
```

This is meant for a small single-host deployment or a staging environment,
not for the horizontal-scaling scenarios described above (compose can run
multiple replicas of a service, but has no L7 sticky-routing story for
`apps/sync` out of the box). For real horizontal scaling, use Kubernetes.

## Kubernetes

`infra/k8s/` holds plain manifests (no Helm/Kustomize layering) for a
namespaced deployment: `Deployment` + `Service` for each of `api`/`sync`/`web`,
`StatefulSet` + `Service` for `postgres` (a managed Postgres is recommended
for real production use — the in-cluster `StatefulSet` here is for
environments without one, e.g. a demo/staging cluster), `Deployment` +
`Service` for `redis`, a `Secret` template for the shared JWT secret and
connection strings, and an `Ingress` routing `/graphql` and websocket
traffic appropriately. See `infra/k8s/README.md` for apply order and what
needs to be filled in per environment (image tags, hostnames, TLS, secret
values, replica counts).

LiveKit (huddles) is not included in the k8s manifests — either point
`VITE_LIVEKIT_URL` (baked into the `web` image at build time) at LiveKit
Cloud, or deploy `livekit/livekit-server` separately (its official Helm
chart is the better fit than a hand-rolled manifest here, given its own
TURN/UDP-media-range requirements — see the `livekit` service definition in
`infra/docker-compose.yml` for the dev-mode equivalent).

## What's deliberately out of scope here

- TLS termination specifics (assumed to happen at an Ingress
  controller/cloud LB in front of this stack, not in-app)
- Secrets management integration (Vault, cloud secret managers, sealed
  secrets) — the k8s `Secret` manifest here is a plain template to fill in
  or replace with your platform's mechanism
- Autoscaling policies (HPA) — replica counts in the k8s manifests are
  static starting points, not tuned targets
- Observability stack (metrics/tracing/log shipping) wiring
