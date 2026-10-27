# Architecture

`custom-workspace` is a unified real-time collaborative workspace (chat,
docs, whiteboard, tasks/calendar, huddles) split into three deployable
services and two shared packages:

```
apps/api      NestJS + GraphQL (Apollo) — identities, RBAC, chat, tasks,
              calendar, guest links. The system of record.
apps/sync     Go — WebSocket relay for CRDT (Yjs) documents and whiteboards.
              Talks to the same Postgres database directly via raw SQL.
apps/web      SolidJS SPA — talks to apps/api over GraphQL and apps/sync
              over WebSocket (Hocuspocus-protocol-compatible).

packages/db      Prisma schema + generated client (packages/db/prisma/schema.prisma).
                 Single source of truth for the relational data model.
packages/shared  TypeScript types/enums shared between apps/api and apps/web
                 (WorkspaceRole, PermissionLevel, canPerform() RBAC matrix, ...).
```

Backing infra: PostgreSQL (system of record for both `apps/api` and
`apps/sync`), Redis (rate-limit storage, GraphQL subscription fan-out,
sync-engine cross-instance pub/sub), and an optional self-hosted LiveKit SFU
for huddles (voice/video).

```
                         ┌─────────────┐
                         │   apps/web   │  SolidJS SPA
                         └──────┬──────┘
                    GraphQL     │      WebSocket (doc:/board: rooms)
                  (HTTP + WS)   │      + LiveKit (optional, huddles)
                 ┌──────────────┴───────────────┐
                 ▼                              ▼
          ┌─────────────┐                ┌─────────────┐
          │   apps/api   │                │  apps/sync   │
          │ NestJS/Nest  │                │  Go relay    │
          │  + GraphQL   │                │              │
          └──────┬───────┘                └──────┬───────┘
                 │            ┌───────────┐       │
                 ├───────────►│  Postgres │◄──────┤  raw SQL, same schema
                 │            └───────────┘       │
                 │            ┌───────────┐       │
                 └───────────►│   Redis   │◄──────┘  pub/sub fan-out
                              └───────────┘
```

## Why two backend services instead of one

`apps/sync` exists because CRDT relay is a distinct workload from the rest of
the API: many long-lived WebSocket connections, per-room in-memory state, and
latency-sensitive fan-out — a different scaling profile than a stateless
GraphQL API serving request/response traffic. The comment at the top of
[`apps/sync/cmd/sync/main.go`](../apps/sync/cmd/sync/main.go) frames this as
the "rewrite the isolated WebSocket microservice in Go once the single
Node.js process's CPU becomes the bottleneck" step of a staged rollout —
this build skips straight to that end state rather than starting with an
in-process Node CRDT server.

`apps/sync` is deliberately a **protocol relay + durable replay-log store**,
not a full CRDT engine: it never decodes or merges Yjs updates itself (see
`apps/sync/internal/protocol`), it only frames, persists, and rebroadcasts
opaque update blobs. Convergence correctness is entirely the responsibility
of the real `yjs` client library running in the browser (and in
`bench/verify-sync.mjs`, which uses that same library to prove it end to
end — see [TESTING.md](TESTING.md)).

## apps/api — NestJS / GraphQL

- **Transport**: Apollo Server over `/graphql` (HTTP for queries/mutations,
  `graphql-ws` for the `messageAdded` subscription). `schema.gql` is
  auto-generated (`autoSchemaFile`) from resolver decorators — do not hand-edit it.
- **Auth**: short-lived (15m) HS256 access tokens (`JWT_ACCESS_SECRET`) plus
  opaque refresh tokens, stored server-side only as a salted hash
  (`JWT_REFRESH_PEPPER` mixed in before hashing — see `apps/api/src/auth`).
  `apps/sync` verifies the *same* access tokens (byte-identical secret) so a
  user doesn't need a second login for realtime features.
- **RBAC — two orthogonal guards** (`apps/api/src/common/rbac`):
  - `RolesGuard` + `@Roles(...)` — workspace membership *tier*
    (OWNER/ADMIN/MEMBER/GUEST). Use for "must be an admin to invite members"
    checks. Guests never pass (no `WorkspaceMember` row exists for them).
  - `PermissionsGuard` + `@RequiredPermission(level)` — resource-level
    capability (VIEW/COMMENT/EDIT), via `canPerform()` in `@workspace/shared`.
    OWNER/ADMIN/MEMBER map to a fixed ceiling (MEMBER's ceiling is EDIT — no
    per-channel ACL table exists yet); GUEST's permission instead comes from
    `GuestLink.permission`, carried as a claim on their guest JWT and checked
    against the *workspace the link was scoped to* (a guest link minted for
    workspace A can never touch workspace B).
- **Rate limiting**: `@nestjs/throttler` (100 req/60s per client) backed by
  Redis (`RedisThrottlerStorage`) rather than in-memory storage — required
  for correctness once the API runs as more than one replica behind a load
  balancer.
- **Realtime chat fan-out**: `messageAdded` subscription uses
  `graphql-redis-subscriptions`, so the publishing API instance and the
  subscribing one don't need to be the same process.
- **Health**: `GET /health` (plain REST, not GraphQL — so k8s/LB probes don't
  need a GraphQL client) checks Postgres + Redis and never itself throws; a
  degraded dependency is reported as `"status": "degraded"` with **HTTP
  200**, deliberately, so a Redis blip alone doesn't get the process killed —
  see [`apps/api/src/health/health.controller.ts`](../apps/api/src/health/health.controller.ts).

## apps/sync — Go relay

- **Protocol**: `ws://host:1234/<kind>:<documentId>?token=<jwt>`, where
  `kind` is `doc` (rich text) or `board` (whiteboard) — mirrors
  `HocuspocusProvider`'s default of appending its `name` option to the URL
  path, so `apps/web`'s provider config needs no special-casing.
- **Auth + RBAC on connect**: apps/sync does not verify the JWT or compute a
  permission itself. It first resolves the document's workspace with a
  plain foreign-key lookup (`internal/store.DocumentWorkspace` — not a
  security decision, just topology), then calls apps/api's
  `POST /internal/sessions/verify` (`internal/sessionsclient`) with the raw
  token and that workspace id. apps/api decodes/verifies the JWT and
  computes the effective permission exactly as it does for GraphQL requests
  (guest-token claim, or `WorkspaceMember.role` -> `DEFAULT_ROLE_PERMISSION`),
  and returns `{valid, userId, role, permission}`. apps/api is the single
  source of truth for both "is this session valid" and "what can this user
  do" — see `apps/api/src/internal/internal-sessions.service.ts`. If that
  call fails (network error, timeout, non-2xx) the connection is rejected
  outright; there is no local fallback verification path, since the whole
  point of this design is that apps/sync no longer makes that call on its
  own. Connections whose effective permission is below COMMENT are accepted
  (so they can still hydrate/view) but marked read-only at the transport
  layer — `internal/rbac.ReadOnly` — any update/awareness frames they send
  are silently dropped rather than relayed.
- **`internal/rbac`** now holds only pure, dependency-free
  `PermissionLevel`-ranking helpers (`CanAccess`, `ReadOnly`) that apps/sync
  still needs once it has an effective permission in hand. It no longer
  computes a `WorkspaceRole`'s effective permission — that decision, along
  with JWT verification, lives exclusively in apps/api and is fetched over
  the network per connection (see above), so there is no longer a second
  hand-written copy of the RBAC matrix to keep in lockstep with
  `@workspace/shared` (see [TESTING.md](TESTING.md)).
- **Room lifecycle** (`internal/hub`): a `Room` is created lazily on first
  connection, hydrating from the latest `DocumentSnapshot` in Postgres, and
  torn down (after a final synchronous flush) when its last client
  disconnects — mirroring Hocuspocus's `onLoadDocument` /
  `afterUnloadDocument` hooks from the Node reference design this replaced.
  While live, a `Room` holds the ordered log of raw Yjs update blobs applied
  since load (kept as discrete blobs rather than merged, so a byte-identical
  replay is possible — see `verify-sync.mjs`).
- **Write-behind persistence** (`internal/store`): update blobs are
  gzip-framed and flushed to `DocumentSnapshot.state` on a debounce window
  (`SNAPSHOT_DEBOUNCE_MS`, prod default 10s) rather than on every update, to
  bound write amplification under sustained editing. `internal/store`
  speaks raw SQL against the Prisma-managed schema (no Prisma client exists
  for Go) — table/column names here **must** stay in sync with
  `packages/db/prisma/schema.prisma`; drift is caught by the integration
  test described in [TESTING.md](TESTING.md).
- **Cross-instance fan-out** (`internal/redisbus`): when `REDIS_URL` is
  reachable at startup, local room broadcasts are also published to Redis so
  other replicas' local clients in the same room see them; each instance
  identifies itself via `INSTANCE_ID` so it can ignore its own published
  events. If Redis is unreachable at startup, the instance logs a warning
  and runs standalone — correct for single-instance dev, not for
  horizontal scale-out (see [DEPLOYMENT.md](DEPLOYMENT.md)).

## apps/web — SolidJS SPA

- Talks to `apps/api` at `VITE_API_URL` (same-origin `/graphql` proxy in dev
  via `vite.config.ts`; direct origin in the production nginx build) and to
  `apps/sync` at `VITE_WS_URL`.
- `features/document/CollabEditor.tsx` and `features/whiteboard/Whiteboard.tsx`
  open one Y.Doc sync session per document/board against apps/sync.
- `features/huddle/Huddle.tsx` connects to LiveKit at `VITE_LIVEKIT_URL` if
  set; if unset it renders a "LiveKit server not configured" scaffold state
  rather than attempting a connection, so voice/video is fully optional to
  run the rest of the stack.

## Data model

See [`packages/db/prisma/schema.prisma`](../packages/db/prisma/schema.prisma)
for the authoritative model. Summary:

- **Identity/RBAC**: `User`, `RefreshToken`, `Workspace`, `WorkspaceMember`
  (role: OWNER/ADMIN/MEMBER/GUEST), `GuestLink` (token-based, scoped
  permission, optional expiry).
- **Chat**: `Channel` (nestable via `parentId`, `CHANNEL` or `DM` kind),
  `Message` (threaded via `threadRootId`), `Attachment`.
- **Collaborative documents**: `Document` (`RICH_TEXT` or `WHITEBOARD`,
  optionally attached to a `Channel`), `DocumentSnapshot` (compressed binary
  Yjs state + vector clock, written by apps/sync's write-behind flush — see
  above). The live CRDT state itself never touches this schema directly; it
  lives in `apps/sync`'s in-memory `Room` and is debounced into
  `DocumentSnapshot`.
- **Tasks/calendar**: `Task` (status enum, assignee/creator), `CalendarEvent`.

## Staged rollout context

The codebase's comments describe a staged build-out where the realtime CRDT
relay started as part of the Node API and was pulled out into its own Go
service once that became the scaling bottleneck. This repo starts from the
end state of that migration (two services, not one) — there is no in-repo
history of the earlier single-process version.
