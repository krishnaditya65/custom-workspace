# Codebase Reference

Extremely detailed, file-by-file and function-by-function reference for
`custom-workspace`. This document is a companion to, not a replacement for,
the shorter narrative docs already in `docs/`:

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — high-level "why", design rationale
- [`DEPLOYMENT.md`](DEPLOYMENT.md) — deployment procedures
- [`TESTING.md`](TESTING.md) — how to run each test layer
- [`BENCHMARKS.md`](BENCHMARKS.md) — perf harness usage

Those four documents are accurate as of this writing, including the
sync↔api network-boundary change described in detail below (this reference
verified them against source and found no staleness on that topic — see
"Verification note" at the end of this document). This document goes one
level deeper: every module, every exported symbol, every real signature,
and full data-flow walkthroughs.

## Table of contents

1. [System overview](#1-system-overview)
2. [apps/api — NestJS / GraphQL](#2-appsapi--nestjs--graphql)
3. [apps/sync — Go CRDT relay](#3-appssync--go-crdt-relay)
4. [apps/web — SolidJS SPA](#4-appsweb--solidjs-spa)
5. [packages/shared](#5-packagesshared)
6. [packages/db](#6-packagesdb)
7. [Data flow walkthroughs](#7-data-flow-walkthroughs)
8. [Deployment](#8-deployment)
9. [Testing](#9-testing)

---

## 1. System overview

`custom-workspace` is a unified real-time collaborative workspace: chat
(channels/DMs/threads), collaborative rich-text documents, collaborative
whiteboards, huddles (voice/video via LiveKit), tasks, a calendar, and
awareness-driven spatial audio positioning. It is split into three
deployable apps and two shared packages in a pnpm workspace
(`pnpm-workspace.yaml`: `apps/*`, `packages/*`):

| Path | Language/stack | Role |
|---|---|---|
| `apps/api` | NestJS 10 + Apollo GraphQL (TypeScript) | System of record: identities, RBAC, chat, tasks, calendar, guest links, and now the internal session-verification service used by apps/sync |
| `apps/sync` | Go 1.23 | WebSocket relay for CRDT (Yjs) documents and whiteboards — a protocol relay + durable replay-log store, not a full CRDT engine |
| `apps/web` | SolidJS 1.8 + Vite | SPA: talks to apps/api over hand-rolled GraphQL-over-fetch and to apps/sync over WebSocket (Hocuspocus protocol) |
| `packages/db` | Prisma 5 | Single schema (`packages/db/prisma/schema.prisma`) — the relational source of truth, consumed via generated client by apps/api and via raw SQL by apps/sync |
| `packages/shared` | TypeScript | Cross-cutting enums, JWT payload types, and the `canPerform()` RBAC matrix — the single implementation of "does role X get permission Y", imported by apps/api (and, historically, mirrored by apps/sync — no longer, see §3) |

Backing infrastructure: PostgreSQL (system of record for both apps/api via
Prisma and apps/sync via raw SQL against the same schema), Redis (rate-limit
storage + GraphQL subscription fan-out for apps/api; cross-instance
CRDT-update pub/sub for apps/sync), and an optional self-hosted LiveKit SFU
for huddles.

### 1.1 Three-app architecture diagram

```
                                  ┌──────────────┐
                                  │   apps/web    │  SolidJS SPA (Vite)
                                  └──────┬───────┘
                     GraphQL-over-fetch  │        WebSocket ws://…/doc:<id>
                     (VITE_API_URL,      │        or ws://…/board:<id>
                      /graphql, HTTP)    │        (VITE_WS_URL, Hocuspocus
                                         │         protocol) + optional
                                         │         LiveKit (VITE_LIVEKIT_URL)
                    ┌────────────────────┼─────────────────────────┐
                    ▼                                              ▼
           ┌─────────────────┐                           ┌──────────────────┐
           │    apps/api      │                           │    apps/sync      │
           │  NestJS/Apollo   │◄─────────────────────────►│   Go relay/hub     │
           │  GraphQL server  │   POST /internal/         │                   │
           │                  │   sessions/verify         │                   │
           │                  │   (x-internal-secret,     │                   │
           │                  │    INTERNAL_SERVICE_SECRET│                   │
           │                  │    header; fail-closed)   │                   │
           └────────┬─────────┘                           └─────────┬─────────┘
                     │                                               │
                     │  Prisma (generated client)      raw SQL       │
                     │                                 (pgx pool)    │
                     ▼                                               ▼
              ┌──────────────────────────────────────────────────────┐
              │                     PostgreSQL                        │
              │  User, RefreshToken, Workspace, WorkspaceMember,       │
              │  Channel, Message, Attachment, Document,               │
              │  DocumentSnapshot, Task, CalendarEvent, GuestLink      │
              └──────────────────────────────────────────────────────┘
                     │                                               │
                     │ graphql-redis-subscriptions,                  │ cross-instance
                     │ RedisThrottlerStorage,                        │ room fan-out
                     │ ephemeral typing/presence (api: prefix)       │ (sync:room: prefix)
                     ▼                                               ▼
              ┌──────────────────────────────────────────────────────┐
              │                        Redis                          │
              └──────────────────────────────────────────────────────┘
```

**Critical detail — the sync↔api network boundary.** apps/sync used to
verify JWTs and compute the RBAC permission ceiling itself (a Go mirror of
the TypeScript matrix). That local verification path has been **removed
entirely** — there is no `apps/sync/internal/auth` package any more
(confirmed: `apps/sync/internal/` contains only `config`, `hub`, `lib0`,
`protocol`, `rbac`, `redisbus`, `sessionsclient`, `store` — no `auth`
directory, and no `jwt.Parse`/`ParseWithClaims`/HS256 anywhere in
`apps/sync`'s source). Instead, on every new WebSocket connection apps/sync
calls apps/api's `POST /internal/sessions/verify` with the raw bearer token
and the target document's `workspaceId`. apps/api decodes/verifies the JWT
(same `JWT_ACCESS_SECRET`, same `JwtService` config as the GraphQL auth
path) and computes the effective permission via the exact same
`@workspace/shared` `canPerform()`/`DEFAULT_ROLE_PERMISSION` matrix GraphQL
guards use, returning `{valid, userId, role, permission}` (or
`{valid:false, reason}`). apps/api is now the single source of truth for
both "is this session valid" and "what can this user do", in both the
GraphQL and the CRDT-relay paths. See §2.7 and §3.7 for full request/response
shapes, and §7.1 for the full connection walkthrough.

### 1.2 Why two backend services instead of one

apps/sync exists because CRDT relay is a distinct workload from the rest of
the API: many long-lived WebSocket connections, per-room in-memory state,
and latency-sensitive fan-out, versus a stateless GraphQL API serving
request/response traffic. The header comment on `apps/sync/cmd/sync/main.go`
frames this as the "rewrite the isolated WebSocket microservice in Go once
the single Node.js process's CPU becomes the bottleneck" step of a staged
rollout — the codebase starts directly at that end state (two services) with
no in-repo history of an earlier single-process version.

apps/sync is deliberately a **protocol relay + durable replay-log store**,
not a CRDT engine: it never decodes or merges Yjs update contents itself
(see §3.5) — it only frames (lib0 varint encoding), persists (gzip +
length-prefixed blobs), and rebroadcasts opaque byte blobs. Convergence
correctness is the responsibility of the real `yjs` library running in the
browser (and independently re-proven by `bench/verify-sync.mjs`, which
drives real `yjs`/`y-websocket` clients against a live relay — see §9).

---

## 2. apps/api — NestJS / GraphQL

Root: `apps/api/src`. Bootstrap: `apps/api/src/main.ts`. Module wiring:
`apps/api/src/app.module.ts`.

### 2.1 Bootstrap and app module

**`main.ts`**

```ts
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    logger: ['log', 'error', 'warn', 'debug', 'verbose'],
  });
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  }));
  const corsOrigin = process.env.CORS_ORIGIN ?? '*';
  app.enableCors({
    origin: corsOrigin === '*' ? true : corsOrigin.split(',').map(o => o.trim()),
    credentials: true,
  });
  const port = Number(process.env.PORT) || 4000;
  await app.listen(port);
}
```

`ValidationPipe` is global and strict: unknown DTO properties are rejected
(`forbidNonWhitelisted`), not silently dropped, and primitives are coerced
(`enableImplicitConversion`) — applies to both REST controllers (e.g.
`/internal/sessions/verify`'s `SessionVerifyDto`) and GraphQL input types.

**`app.module.ts`** wires, in order: `ConfigModule.forRoot({isGlobal:true})`;
`GraphQLModule.forRootAsync` (Apollo driver, `autoSchemaFile: schema.gql`
generated from resolver decorators — **do not hand-edit** `schema.gql`,
`sortSchema:true`, `playground`/`introspection` gated off in production,
`subscriptions: {'graphql-ws': true}` for `messageAdded`, and a `context`
factory that passes both `req`/`res` into resolver context so guards using
`GqlExecutionContext` and cookie-setting resolvers both work);
`ThrottlerModule.forRootAsync` (single global rule `{ttl: 60_000, limit:
100}` backed by `RedisThrottlerStorage`, see §2.9); then
`PrismaModule`, `RedisModule`, `AuthModule`, `UsersModule`,
`WorkspacesModule`, `ChannelsModule`, `MessagesModule`, `TasksModule`,
`CalendarModule`, `GuestLinksModule`, `HealthModule`, `InternalModule`.

### 2.2 Transport: GraphQL vs REST

Almost everything is GraphQL over `/graphql` (queries/mutations via Apollo
HTTP; the `messageAdded` subscription via `graphql-ws`). Exactly two REST
surfaces exist:

- `GET /health` (`HealthController`, §2.10) — plain REST specifically so
  load balancers/k8s probes don't need a GraphQL client.
- `POST /internal/sessions/verify` (`InternalSessionsController`, §2.7) —
  plain REST, service-to-service only, guarded by a shared secret rather
  than a user JWT.

### 2.3 auth module (`apps/api/src/auth`)

**`auth.module.ts`** — registers `AuthService`, `AuthResolver`,
`JwtStrategy`, `JwtAuthGuard`; imports Nest's `JwtModule`/`PassportModule`.
Exported so `InternalModule` can import it for `JwtService` (§2.7).

**`auth.service.ts` — `AuthService`** (full method surface, real behavior):

```ts
const BCRYPT_COST = 12;
const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const REFRESH_TOKEN_BYTES = 64;
const GUEST_TOKEN_TTL = '30m';

export interface IssuedTokens { accessToken: string; refreshToken: string; }

class AuthService {
  async register(email: string, password: string, displayName: string): Promise<{accessToken,refreshToken,user}>
  async login(email: string, password: string): Promise<{accessToken,refreshToken,user}>
  async refreshToken(presentedToken: string): Promise<{accessToken,refreshToken,user}>
  async logout(presentedToken: string): Promise<boolean>
  signGuestToken(guestLinkId: string, workspaceId: string, permission: GuestLinkPermission): string
  private issueTokenPair(userId, email): Promise<IssuedTokens>
  private signAccessToken(userId, email): string
  private generateRefreshToken(): string           // crypto.randomBytes(64).toString('base64url')
  private hashRefreshToken(token): string           // sha256(token + JWT_REFRESH_PEPPER), hex
}
```

Behavior:

- **`register`** — rejects duplicate email (`ConflictException`), hashes
  password with bcrypt cost 12, creates the `User` row, then calls
  `issueTokenPair`.
- **`login`** — looks up by email; **the same** `UnauthorizedException`
  message ("Invalid email or password") is thrown for both "no such user"
  and "wrong password", deliberately, to avoid leaking which emails are
  registered.
- **Refresh token design**: the token handed to the client is a random
  64-byte value, base64url-encoded, **never stored verbatim** — only
  `SHA-256(token + JWT_REFRESH_PEPPER)` is persisted in
  `RefreshToken.tokenHash`, so a DB leak alone (without the separate
  `JWT_REFRESH_PEPPER` env secret) cannot be used to forge/replay refresh
  tokens.
- **`refreshToken`** — single-use rotation: looks up by `tokenHash`;
  rejects unknown/`revokedAt` set/`expiresAt` passed tokens uniformly (same
  `UnauthorizedException`, same reasoning as login — also means presenting
  an already-rotated token is indistinguishable from presenting a garbage
  token, which is itself a cheap "was this token stolen and replayed"
  signal, since a legitimate client would never present a revoked token).
  Revokes the old row and creates a new one **in one `$transaction`**, then
  signs and returns a fresh access token alongside the new refresh token.
- **`logout`** — marks the presented refresh token's row `revokedAt`; a
  no-op (returns `false`) if already revoked or unknown.
- **`signGuestToken`** — signs `{sub: "guest:<guestLinkId>", guest: true,
  workspaceId, permission}` with `JWT_ACCESS_SECRET`, `expiresIn: "30m"`.
  Guests get **no** refresh token — a guest session is meant to be
  re-derived from the guest link (`resolveGuestLink`, §2.8), not
  persistently refreshable.

**`auth.resolver.ts` — `AuthResolver`** (GraphQL, no guard — these are the
unauthenticated entry points):

```graphql
type Mutation {
  register(input: RegisterInput!): AuthPayload!
  login(input: LoginInput!): AuthPayload!
  refreshToken(input: RefreshTokenInput!): AuthPayload!
  logout(input: RefreshTokenInput!): Boolean!
}
```

Each resolver method is a thin pass-through to the matching `AuthService`
method.

**`strategies/jwt.strategy.ts` — `JwtStrategy extends PassportStrategy(Strategy)`**:

```ts
constructor(config: ConfigService) {
  super({
    jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
    ignoreExpiration: false,
    secretOrKey: config.get<string>('JWT_ACCESS_SECRET', 'change-me-access-secret'),
  });
}
validate(payload: AnyJwtPayload): RequestUser | RequestGuest {
  if (isGuestJwtPayload(payload)) {
    return { userId: payload.sub, guest: true, workspaceId: payload.workspaceId, permission: payload.permission };
  }
  return { userId: payload.sub, email: payload.email };
}
```

Handles **both** regular user tokens (`{sub, email}`) and guest tokens
(`{sub, guest:true, workspaceId, permission}`) via
`isGuestJwtPayload()` from `@workspace/shared` (§5).

**`jwt-auth.guard.ts` — `JwtAuthGuard extends AuthGuard('jwt')`**:

```ts
getRequest(context: ExecutionContext) {
  const gqlContext = GqlExecutionContext.create(context);
  const gqlReq = gqlContext.getContext().req;
  return gqlReq ?? context.switchToHttp().getRequest();
}
```

Overrides `getRequest` because GraphQL's execution context wraps the real
HTTP request differently than a plain REST controller — without this
override passport can't find the `Authorization` header on GraphQL
requests. Works transparently for both transports (used on `/health` isn't
needed since health is unauthenticated, but the same guard class is reused
by every resolver in the app).

### 2.4 common/rbac (`apps/api/src/common/rbac`)

Two **orthogonal** guards:

**`roles.guard.ts` — `RolesGuard`** — workspace-**role** tier check
(OWNER/ADMIN/MEMBER/GUEST membership), paired with `@Roles(...)`:

```ts
async canActivate(context: ExecutionContext): Promise<boolean> {
  const allowedRoles = this.reflector.getAllAndOverride<WorkspaceRole[] | undefined>(
    ROLES_KEY, [context.getHandler(), context.getClass()],
  );
  if (!allowedRoles || allowedRoles.length === 0) return true;
  const req = getGqlRequest(context);
  const user = req?.user;
  if (!user?.userId) throw new ForbiddenException('Authentication required');
  if (user.guest) throw new ForbiddenException('Guests cannot perform this action'); // fail fast — guests never have a WorkspaceMember row
  const workspaceId = extractWorkspaceId(context);
  if (!workspaceId) throw new ForbiddenException('RolesGuard could not resolve a workspaceId from the request arguments');
  const membership = await this.prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: user.userId } },
  });
  if (!membership || !allowedRoles.includes(membership.role as unknown as WorkspaceRole)) {
    throw new ForbiddenException(`Requires one of roles [${allowedRoles.join(', ')}] in this workspace`);
  }
  req.workspaceMembership = membership; // cached for downstream reuse (PermissionsGuard checks this first)
  return true;
}
```

Note: OWNER outranks ADMIN in privilege but `RolesGuard` checks membership
against an **explicit allow-list**, not a rank comparison — call sites that
mean "ADMIN or higher" must list both `WorkspaceRole.OWNER,
WorkspaceRole.ADMIN` explicitly (see `WorkspacesResolver.inviteMember`,
§2.5).

**`permissions.guard.ts` — `PermissionsGuard`** — resource-level
VIEW/COMMENT/EDIT capability check, paired with `@RequiredPermission(level)`:

```ts
async canActivate(context: ExecutionContext): Promise<boolean> {
  const required = this.reflector.getAllAndOverride<PermissionLevel | undefined>(
    REQUIRED_PERMISSION_KEY, [context.getHandler(), context.getClass()],
  );
  if (!required) return true;
  const req = getGqlRequest(context);
  const user = req?.user;
  if (!user) throw new ForbiddenException('Authentication required');
  const workspaceId = await this.resolveWorkspaceId(context);
  if (!workspaceId) throw new ForbiddenException('PermissionsGuard could not resolve a workspaceId from the request arguments');

  if (user.guest) {
    if (user.workspaceId !== workspaceId) throw new ForbiddenException('Guest link is not scoped to this workspace');
    const allowed = canPerform(WorkspaceRole.GUEST, required, user.permission as PermissionLevel);
    if (!allowed) throw new ForbiddenException(`Guest permission does not satisfy required level: ${required}`);
    return true;
  }

  const membership = req.workspaceMembership ?? await this.prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: user.userId } },
  });
  if (!membership) throw new ForbiddenException('Not a member of this workspace');
  const allowed = canPerform(membership.role as unknown as WorkspaceRole, required);
  if (!allowed) throw new ForbiddenException(`Insufficient permission - requires at least ${required}`);
  return true;
}

private async resolveWorkspaceId(context): Promise<string | undefined> {
  // 1. flat `workspaceId` arg or `input.workspaceId`  (extractWorkspaceId)
  // 2. else, flat `channelId` arg or `input.channelId` -> Channel.workspaceId lookup
  // undefined => callers treat as deny
}
```

Effective ceiling per role, via `canPerform`/`DEFAULT_ROLE_PERMISSION`
(§5): OWNER/ADMIN/MEMBER → always EDIT (no per-channel ACL table exists
yet, so MEMBER's ceiling isn't currently overridable per-resource); GUEST →
uses `GuestLink.permission` (carried as a claim on the guest JWT) as an
**authoritative override**, and only after confirming the guest token's
`workspaceId` claim matches the workspace being accessed — a guest link
minted for workspace A can never touch workspace B.

**Supporting files**:
- `roles.decorator.ts` — `@Roles(...roles: WorkspaceRole[])`, sets
  `ROLES_KEY` reflector metadata.
- `required-permission.decorator.ts` — `@RequiredPermission(level:
  PermissionLevel)`, sets `REQUIRED_PERMISSION_KEY`.
- `gql-context.util.ts`:
  ```ts
  export function extractWorkspaceId(context: ExecutionContext): string | undefined
  // flat `workspaceId` arg, else `input.workspaceId`, else undefined
  export function getGqlRequest(context: ExecutionContext): any
  // unwraps GqlExecutionContext -> context.req
  ```
- `rbac.util.spec.ts` — the full `canPerform` truth table test (see §9).

### 2.5 workspaces module

**`workspaces.resolver.ts`** (`@UseGuards(JwtAuthGuard)` at class level):

```graphql
type Mutation {
  createWorkspace(input: CreateWorkspaceInput!): WorkspaceType!
  inviteMember(input: InviteMemberInput!): WorkspaceMemberType!   # @Roles(OWNER, ADMIN)
}
type Query {
  myWorkspaces: [WorkspaceType!]!
  workspace(id: ID!): WorkspaceType!
}
```

**`workspaces.service.ts` — `WorkspacesService`**:

```ts
private slugify(name: string): string          // lowercase, non-alnum -> '-', + random 3-byte hex suffix for uniqueness
async createWorkspace(ownerId: string, name: string)
async myWorkspaces(userId: string)
async getWorkspaceWithMembers(workspaceId: string, callerId: string)
async inviteMember(workspaceId: string, email: string, role: WorkspaceRole)
```

`createWorkspace` creates the `Workspace` row **and** the creator's OWNER
`WorkspaceMember` row inside one `$transaction` — if either write fails,
neither is persisted, so an ownerless workspace can never exist.
`inviteMember` `upsert`s a `WorkspaceMember` by `(workspaceId, userId)`
(so re-inviting an existing member just changes their role); `RolesGuard`
(`@Roles(OWNER, ADMIN)`) already gated this before the service runs.

### 2.6 channels module

**`channels.resolver.ts`**:
```graphql
type Mutation {
  createChannel(input: CreateChannelInput!): ChannelType!
  archiveChannel(channelId: ID!): ChannelType!
}
type Query { channels(workspaceId: ID!): [ChannelType!]! }
```

**`channels.service.ts` — `ChannelsService`**:

```ts
const ARCHIVED_PREFIX = '[archived] ';
private assertMember(workspaceId, userId): Promise<void>
private decorate<T extends {name:string}>(channel: T)   // strips/detects ARCHIVED_PREFIX, adds isArchived: boolean
async createChannel(userId, workspaceId, name, isPrivate, parentId?)
async channels(userId, workspaceId): Promise<tree>       // parent/child tree, archived channels excluded
async archiveChannel(userId, channelId)                  // idempotent
```

Notable design choice, documented in-code: **"archived" has no real
column** — `schema.prisma`'s `Channel` model has no `archivedAt`/`deletedAt`
field, so `ChannelsService` encodes archival as an `[archived] ` name
prefix and `ChannelType.isArchived` is a resolver-computed derived field,
not a DB column. `channels()` builds a parent/child tree via `parentId`
(self-relation "ChannelNesting" in the schema, §6) and filters out archived
channels entirely rather than marking them in the tree.

### 2.7 internal module — the sync↔api boundary (full detail)

Root: `apps/api/src/internal`. This is the module the recent
network-boundary change added; it groups the `/internal/*` REST surface
used only by other services (currently just apps/sync), never by end
users or the public gateway.

**`internal.module.ts`**:
```ts
@Module({
  imports: [AuthModule], // for JwtService, configured with JWT_ACCESS_SECRET
  controllers: [InternalSessionsController],
  providers: [InternalSessionsService, InternalServiceGuard],
})
export class InternalModule {}
```

**`internal-service.guard.ts` — `InternalServiceGuard implements CanActivate`**:

```ts
const INTERNAL_SECRET_HEADER = 'x-internal-secret';

@Injectable()
export class InternalServiceGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>('INTERNAL_SERVICE_SECRET');
    if (!expected) {
      // Fail closed: an unset secret must never be treated as "no auth required"
      throw new UnauthorizedException('INTERNAL_SERVICE_SECRET is not configured');
    }
    const req = context.switchToHttp().getRequest<Request>();
    const provided = req.header(INTERNAL_SECRET_HEADER);
    if (!provided || !timingSafeEqual(provided, expected)) {
      throw new UnauthorizedException('Invalid or missing internal service credentials');
    }
    return true;
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}
```

Design notes (from the in-source doc comment): there is deliberately **no
per-caller identity** here, just one shared secret compared in constant
time via a hand-rolled `timingSafeEqual` (XOR-accumulate over
`charCodeAt`, short-circuits only on length mismatch — a length mismatch
leak is accepted since secret length isn't sensitive). `/internal/*`
routes are expected to only ever be reachable from inside the private
network apps/sync also lives in — **not** exposed through the public
gateway/load balancer — and this header is defense-in-depth on top of that
network boundary, not a substitute for it. An **unset** secret fails
closed (`UnauthorizedException`) rather than silently disabling the check,
in every environment including dev.

**`internal-sessions.controller.ts` — `InternalSessionsController`**:

```ts
@Controller('internal/sessions')
@UseGuards(InternalServiceGuard)
export class InternalSessionsController {
  constructor(private readonly sessions: InternalSessionsService) {}

  @Post('verify')
  @HttpCode(200)
  async verify(@Body() dto: SessionVerifyDto): Promise<SessionVerifyResult> {
    return this.sessions.verify(dto);
  }
}
```

Full route: **`POST /internal/sessions/verify`**. `@HttpCode(200)` — even
a "session invalid" outcome returns HTTP 200 with `{valid:false, reason}`
in the body (the guard is what returns non-2xx, for auth failures on the
call itself).

**Request DTO — `dto/session-verify.dto.ts`**:
```ts
export class SessionVerifyDto {
  @IsString() @MinLength(1) token!: string;
  @IsString() @MinLength(1) workspaceId!: string;
}
```
JSON body: `{"token": "<jwt>", "workspaceId": "<uuid>"}`.

**Response DTO — `dto/session-verify-result.dto.ts`**:
```ts
export interface SessionVerifyResult {
  valid: boolean;
  userId?: string;
  role?: WorkspaceRole;                 // GUEST for a guest-link token, or WorkspaceMember.role
  permission?: PermissionLevel;         // effective ceiling permission against `workspaceId`
  reason?: 'invalid_token' | 'workspace_mismatch' | 'not_a_member';  // present only when valid=false
}
```

**`internal-sessions.service.ts` — `InternalSessionsService`** (the actual
verify logic):

```ts
async verify({ token, workspaceId }: SessionVerifyDto): Promise<SessionVerifyResult> {
  let payload: AnyJwtPayload;
  try {
    payload = await this.jwt.verifyAsync<AnyJwtPayload>(token, {
      secret: this.config.get<string>('JWT_ACCESS_SECRET', 'change-me-access-secret'),
      algorithms: ['HS256'],
    });
  } catch (err) {
    return { valid: false, reason: 'invalid_token' };
  }

  if (isGuestJwtPayload(payload)) {
    if (payload.workspaceId !== workspaceId) {
      return { valid: false, reason: 'workspace_mismatch' };
    }
    return {
      valid: true,
      userId: payload.sub,
      role: WorkspaceRole.GUEST,
      permission: payload.permission as unknown as PermissionLevel,
    };
  }

  const membership = await this.prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: payload.sub } },
  });
  if (!membership) return { valid: false, reason: 'not_a_member' };

  const role = membership.role as unknown as WorkspaceRole;
  return { valid: true, userId: payload.sub, role, permission: DEFAULT_ROLE_PERMISSION[role] };
}
```

Deliberately reuses the **exact same building blocks** as the GraphQL auth
path rather than reimplementing them: `JwtService` configured with the
same `JWT_ACCESS_SECRET`; `@workspace/shared`'s `isGuestJwtPayload` /
`DEFAULT_ROLE_PERMISSION` — the identical matrix `PermissionsGuard` uses;
`PrismaService.workspaceMember` — the same table `RolesGuard` and
`PermissionsGuard` query. Failure modes, exact by branch:

| Condition | Response body | Status |
|---|---|---|
| JWT signature invalid / expired / malformed | `{valid:false, reason:"invalid_token"}` | 200 |
| Guest token, `payload.workspaceId !== workspaceId` param | `{valid:false, reason:"workspace_mismatch"}` | 200 |
| Regular token, no `WorkspaceMember` row for `(workspaceId, userId)` | `{valid:false, reason:"not_a_member"}` | 200 |
| Regular token, membership found | `{valid:true, userId, role, permission: DEFAULT_ROLE_PERMISSION[role]}` | 200 |
| Guest token, workspace matches | `{valid:true, userId:"guest:<id>", role:GUEST, permission:<claim>}` | 200 |
| `x-internal-secret` header missing/wrong | `401 Unauthorized` (thrown by the guard, before the controller body runs) | 401 |
| `INTERNAL_SERVICE_SECRET` unset on apps/api | `401 Unauthorized` ("not configured") | 401 |

`internal-sessions.service.spec.ts` unit-tests every one of these five
outcome rows directly (mocked `JwtService`/`PrismaService`), matching the
table above exactly (see §9).

### 2.8 guest-links module

**`guest-links.resolver.ts`**:
```graphql
type Mutation {
  createGuestLink(input: CreateGuestLinkInput!): GuestLinkType!   # @Roles(OWNER, ADMIN)
  resolveGuestLink(token: String!): ResolvedGuestLink!            # intentionally unauthenticated
}
```

**`guest-links.service.ts` — `GuestLinksService`**:
```ts
async createGuestLink(createdById, workspaceId, permission: GuestLinkPermission, expiresAt?): Promise<GuestLink>
async resolveGuestLink(token: string): Promise<{workspace, permission, accessToken}>
```

`createGuestLink` mints a `token = crypto.randomBytes(24).toString('base64url')`
and stores a `GuestLink` row (ADMIN+ only, enforced by `RolesGuard`).
`resolveGuestLink` is the **unauthenticated guest entry point**: looks up
the `GuestLink` by opaque token, rejects if not found (`NotFoundException`)
or past `expiresAt` (`GoneException`), then calls
`AuthService.signGuestToken(guestLink.id, guestLink.workspaceId,
guestLink.permission)` and returns `{workspace, permission, accessToken}`.
No `RefreshToken` row is created for guests (see §2.3).

### 2.9 Rate limiting, pub/sub, Redis (common/, redis/, common/pubsub/)

**`common/throttler-redis.storage.ts` — `RedisThrottlerStorage implements
ThrottlerStorage`** — replaces `@nestjs/throttler`'s default in-memory `Map`
storage (which breaks once the API runs as N replicas) with Redis-backed
counters:

```ts
async increment(key, ttl, limit, blockDuration, throttlerName): Promise<ThrottlerStorageRecord>
```
One Redis key per `(throttlerName, tracker)`; `INCR` + conditional
`PEXPIRE` on first hit (two round trips, not atomic under extreme QPS —
documented as a known scaling knob, not solved with a Lua script here).
Optional `block:<key>` marker set for `blockDuration` ms once a tracker
exceeds `limit`, so it stays blocked even after the counting window rolls
over. Wired in `app.module.ts`'s `ThrottlerModule.forRootAsync` with a
single global rule: **100 req / 60s per client**.

**`redis/redis.service.ts` — `RedisService`** — API-side Redis helper,
explicitly scoped to *lightweight, ephemeral* concerns (typing indicators,
presence pings) — **not** the CRDT/document sync channel (that's entirely
owned by apps/sync's own Redis pub/sub, on a disjoint `sync:room:` key
namespace vs. this service's `api:` prefix, so the two can never collide):
```ts
private channel(name: string): string        // `api:${name}`
async publish(channel: string, payload: unknown): Promise<void>
async subscribe(channel: string, handler: (payload: unknown) => void): Promise<void>
async isHealthy(): Promise<boolean>           // PING === 'PONG', never throws
```
Uses a dedicated subscriber connection (`REDIS_SUBSCRIBER_CLIENT`) distinct
from the command connection (`REDIS_CLIENT`), since ioredis puts a
connection into subscriber-only mode once `SUBSCRIBE` is issued.

**`common/pubsub/pubsub.module.ts` — `PubSubModule`** (`@Global()`) —
provides a `RedisPubSub` (from `graphql-redis-subscriptions`) instance for
GraphQL subscriptions, backed by its own pair of Redis connections
(separate from `RedisModule`'s) so subscription traffic (`messageAdded`)
doesn't share a channel namespace with ephemeral typing/presence traffic.
This is what makes `messageAdded` correct across horizontally-scaled API
instances — publisher and subscriber don't need to be the same process.

**`common/gql-throttler.guard.ts` — `GqlThrottlerGuard`** — adapts
`@nestjs/throttler`'s guard to pull the request out of GraphQL context
(same `GqlExecutionContext` pattern as `JwtAuthGuard`); registered as
`APP_GUARD` in `app.module.ts` so it applies globally.

### 2.10 health module

**`health.controller.ts` — `HealthController`**:
```ts
@Controller('health')
export class HealthController {
  @Get() @HttpCode(200)
  async check() {
    const [dbHealthy, redisHealthy] = await Promise.all([this.prisma.isHealthy(), this.redis.isHealthy()]);
    const status = dbHealthy && redisHealthy ? 'ok' : 'degraded';
    return { status, uptime: process.uptime(), dependencies: { postgres: dbHealthy?'up':'down', redis: redisHealthy?'up':'down' } };
  }
}
```
**Deliberately always returns HTTP 200** — a degraded dependency is
reported in the JSON body's `status`/`dependencies` fields, not via a
non-2xx status, so a Redis blip alone doesn't get the process killed by an
orchestrator's liveness probe. `PrismaService.isHealthy()` runs `SELECT 1`
and never throws (catches internally, returns `false`).

### 2.11 messages module — see §7.2 for the full send-flow walkthrough

**`messages.resolver.ts` — `MessagesResolver`** (`@UseGuards(JwtAuthGuard)`
at class level):

```graphql
type Mutation {
  sendMessage(input: SendMessageInput!): MessageType!   # @UseGuards(PermissionsGuard) @RequiredPermission(COMMENT)
  editMessage(input: EditMessageInput!): MessageType!
  deleteMessage(messageId: ID!): Boolean!
}
type Query { messages(input: MessagesQueryInput!): MessagePage! }
type Subscription { messageAdded(channelId: ID!): MessageType! }
```

`messageAdded` resolves via `this.pubSub.asyncIterator(\`${MESSAGE_ADDED_EVENT}.${channelId}\`)`
— per-channel topic scoping. Documented gap in the source comment: access
control on the subscription happens only at connection/subscribe time via
topic scoping (channelId in the topic name), not re-verified per-event
inside a `filter` against the connection's authenticated context — GraphQL
subscriptions over WebSocket use their own connection-params-based auth
handshake, out of scope for the HTTP-request-oriented `JwtAuthGuard`; the
source flags this as a would-be production hardening item.

**`messages.service.ts` — `MessagesService`**:
```ts
private assertChannelAccess(channelId, userId): Promise<Channel>      // channel exists + caller is a WorkspaceMember
private withReplyCount(message): Promise<message & {replyCount: number}>
async sendMessage(userId, channelId, body, threadRootId?)
async messages(userId, channelId, cursor?, limit=50): Promise<MessagePage>  // id-based cursor, createdAt desc internally, reversed for chronological display
async editMessage(userId, messageId, body)             // author-only
async deleteMessage(userId, messageId): Promise<boolean>  // soft delete: deletedAt set, body -> '[deleted]'
```

`messages()` pagination: fetches `limit + 1` rows ordered `createdAt desc`
starting strictly before the cursor message's `createdAt`, to cheaply
detect `hasMore` without a separate count query; then reverses the page so
the client renders top-to-bottom in natural chronological order while the
underlying query stays a simple, index-friendly `createdAt desc` scan
(`Message` has `@@index([channelId, createdAt])`, §6).

### 2.12 tasks, calendar, users modules

**`tasks.resolver.ts` / `tasks.service.ts`** — `createTask`,
`updateTaskStatus`, `assignTask` (assignee must also be a member of the
same workspace — re-checked via `assertMember`), `tasks(workspaceId)`
(ordered `createdAt desc`). All mutations first resolve/assert workspace
membership, either directly or via `assertMemberViaTask` (task →
`workspaceId` lookup, then `assertMember`).

**`calendar.resolver.ts` / `calendar.service.ts`** — `createEvent`,
`events(workspaceId, from?, to?)` with optional `startsAt >= from` /
`endsAt <= to` range filters, ordered `startsAt asc`.

**`users.resolver.ts` / `users.service.ts`**:
```ts
async me(caller): Promise<UserType>          // 403 if caller is a guest (no user profile)
async user(id, caller): Promise<UserType>    // only visible if caller shares a workspace with target (usersService.shareWorkspace)
```
`shareWorkspace(viewerId, targetId)` — `true` if `viewerId === targetId`,
else checks whether the two users' `WorkspaceMember` sets intersect on any
`workspaceId`.

### 2.13 prisma module

**`prisma.service.ts` — `PrismaService extends PrismaClient implements
OnModuleInit, OnModuleDestroy`** — thin lifecycle wrapper: `$connect()` on
`onModuleInit`, `$disconnect()` on `onModuleDestroy`; `isHealthy()` runs
`SELECT 1` via `$queryRaw`, catches and returns `false` rather than
throwing (used by `HealthController`, §2.10). `PrismaClient` itself is
generated by `prisma generate` from `packages/db/prisma/schema.prisma` into
`packages/db/generated/client`, re-exported as `@workspace/db`'s `main`
entry (§6).

### 2.14 Environment variables (apps/api)

From `apps/api/.env.example`:

| Var | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string, consumed by `@workspace/db` (Prisma) |
| `REDIS_URL` | Backs `@nestjs/throttler` storage, API-side ephemeral pub/sub (typing/presence), and `graphql-redis-subscriptions` for `messageAdded` |
| `JWT_ACCESS_SECRET` | HS256 signing secret for 15m access tokens — generate with `openssl rand -hex 32`, never reuse the placeholder |
| `JWT_REFRESH_PEPPER` | Extra static pepper mixed into refresh-token hashing before storage |
| `PORT` | HTTP port (default 4000) |
| `CORS_ORIGIN` | Comma-separated allowed origins, or `*` (dev only) |
| `INTERNAL_SERVICE_SECRET` | Shared secret required on `x-internal-secret` for `/internal/*` (currently just `POST /internal/sessions/verify`, called by apps/sync) — **must** be byte-identical to apps/sync's copy |

---

## 3. apps/sync — Go CRDT relay

Root: `apps/sync`. Module path: `github.com/gormalone/custom-workspace/sync`.
Entry point: `apps/sync/cmd/sync/main.go`. Packages under
`apps/sync/internal/`: `config`, `hub`, `lib0`, `protocol`, `rbac`,
`redisbus`, `sessionsclient`, `store`. **No `internal/auth` package exists**
— confirmed by directory listing and by grep: there is no `jwt.Parse`,
`ParseWithClaims`, HS256 handling, or `JWT_ACCESS_SECRET` reference
anywhere under `apps/sync`. Local JWT verification was removed in full,
replaced by the `sessionsclient` HTTP call described in §3.7. One stale
artifact of the removal remains: `apps/sync/go.mod`/`go.sum` still declare
`github.com/golang-jwt/jwt/v5` as a dependency, but no `.go` file imports
it — dead weight from before the refactor, harmless but a candidate for a
future `go mod tidy`.

### 3.1 cmd/sync/main.go — startup and connection handshake

```go
var upgrader = websocket.Upgrader{
    ReadBufferSize:  4096,
    WriteBufferSize: 4096,
    CheckOrigin:     func(r *http.Request) bool { return true }, // CORS handled upstream
}

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
    cfg := config.Load()
    // fail fast if DatabaseURL / APIBaseURL / InternalServiceSecret are empty
    st, err := store.New(ctx, cfg.DatabaseURL)
    var bus *redisbus.Bus
    // if REDIS_URL parses and PINGs successfully -> bus = redisbus.New(...)
    // else: log a warning and run standalone (single-instance-correct only)
    h := hub.New(st, bus, cfg.SnapshotDebounce, logger)
    sessions := sessionsclient.New(cfg.APIBaseURL, cfg.InternalServiceSecret, cfg.SessionVerifyTimeout)
    mux := http.NewServeMux()
    mux.HandleFunc("/health", healthHandler)
    mux.HandleFunc("/", wsHandler(h, st, sessions, logger))
    srv := &http.Server{Addr: ":" + cfg.Port, Handler: mux}
    // graceful shutdown on SIGINT/SIGTERM via signal.NotifyContext, 10s Shutdown timeout
}
```

`healthHandler` — static `{"status":"ok"}`, process-liveness only (no
dependency check, unlike apps/api's `/health`).

**`wsHandler(h *hub.Hub, st *store.Store, sessions *sessionsclient.Client,
logger) http.HandlerFunc`** — the full connection sequence, in exact order:

1. Parse the URL path as `<kind>:<documentId>` (`strings.Cut(roomName,
   ":")`); `kind` must be `doc` or `board`, else `400`. URL shape:
   `ws://host:1234/<kind>:<documentId>?token=<jwt>` — mirrors
   `HocuspocusProvider`'s default of appending its `name` option to the URL
   path, so apps/web's provider config needs no special-casing (§4).
2. Read `token` from the `?token=` query param; missing → `401`.
3. `workspaceID, err := st.DocumentWorkspace(ctx, documentID)` — a **plain
   foreign-key lookup** (`SELECT "workspaceId" FROM "Document" WHERE id =
   $1`), explicitly documented as topology, not a security decision. Not
   found → `403`.
4. `result, err := sessions.VerifySession(ctx, token, workspaceID)` — the
   network call to apps/api. A non-nil `err` (network failure, timeout,
   non-2xx, malformed response — always wrapped in `sessionsclient.ErrUnreachable`)
   → **`502 Bad Gateway`**, connection rejected outright, **no local
   fallback verification path**. `!result.Valid` → `401`. Malformed
   response (`Permission == ""` or `UserID == ""` despite `valid:true`) →
   `502` (defensive — apps/api is expected to never send this shape, but
   the relay doesn't trust it blindly).
5. Only **after** step 4 succeeds does the code call
   `upgrader.Upgrade(w, r, nil)` — the WebSocket upgrade happens strictly
   after auth, never before.
6. `room, err := h.GetOrLoadRoom(ctx, roomName, documentID, workspaceID)` —
   lazily creates/hydrates the room (§3.4). Failure closes the just-upgraded
   connection.
7. `client := hub.NewClient(conn, room, h, result.UserID, permission,
   logger)`; `room.AddClient(client)`; `client.Run()` — blocks for the
   connection's lifetime.

### 3.2 internal/config — env loading

```go
type Config struct {
    Port, DatabaseURL, RedisURL string
    APIBaseURL            string
    InternalServiceSecret string
    SessionVerifyTimeout  time.Duration
    SnapshotDebounce      time.Duration
    InstanceID            string
}
func Load() Config
func getenv(key, fallback string) string
func randomID() string   // "<hostname>-<pid>", falls back to "sync-instance" if hostname lookup fails
```

Defaults: `PORT=1234`, `REDIS_URL=redis://localhost:6379`,
`API_BASE_URL=http://localhost:4000`, `SESSION_VERIFY_TIMEOUT_MS=3000`,
`SNAPSHOT_DEBOUNCE_MS=10000`. `DatabaseURL` and `InternalServiceSecret` have
**no fallback** — empty string if unset, which `main.go` treats as fatal.
`InstanceID` defaults to `randomID()` if `INSTANCE_ID` is unset — used only
to let `redisbus` distinguish "my own echo" from "a peer instance's event"
(§3.6), not security-sensitive.

### 3.3 internal/lib0 — wire encoding primitives

Minimal subset of the lib0 binary encoding the Yjs ecosystem uses
(y-protocols/sync, y-protocols/awareness): unsigned LEB128 varints
(`writeVarUint`/`readVarUint`) and length-prefixed byte/string arrays.
Every Yjs client speaks this exact framing, so the server never needs to
understand Yjs CRDT internals — only read/write these envelopes.

```go
type Decoder struct { buf []byte; pos int }
func NewDecoder(buf []byte) *Decoder
func (d *Decoder) Remaining() int
func (d *Decoder) ReadByte() (byte, error)
func (d *Decoder) ReadVarUint() (uint64, error)          // ULEB128: 7 data bits/byte, high bit = continuation
func (d *Decoder) ReadVarUint8Array() ([]byte, error)     // varUint length prefix + that many raw bytes
func (d *Decoder) ReadVarString() (string, error)         // ReadVarUint8Array interpreted as UTF-8
func (d *Decoder) Rest() []byte

type Encoder struct { buf bytes.Buffer }
func NewEncoder() *Encoder
func (e *Encoder) PutByte(b byte)
func (e *Encoder) WriteVarUint(num uint64)
func (e *Encoder) WriteVarUint8Array(data []byte)
func (e *Encoder) WriteVarString(s string)
func (e *Encoder) Bytes() []byte
```

### 3.4 internal/protocol — sync + awareness sub-protocols (CRDT mechanics)

Implements the y-websocket wire protocol on lib0 framing. Every WebSocket
frame carries exactly one top-level message.

```go
const ( MessageSync uint64 = 0; MessageAwareness uint64 = 1 )
const ( SyncStep1 uint64 = 0; SyncStep2 uint64 = 1; SyncUpdate uint64 = 2 )

type Envelope struct {
    Type uint64; SyncType uint64
    Payload []byte              // opaque for Sync messages — server never inspects Yjs update contents
    Awareness []AwarenessUpdate
    RawAwareness []byte          // relayed verbatim
}
type AwarenessUpdate struct { ClientID uint64; Clock uint64; State string }

func Decode(msg []byte) (*Envelope, error)
func EncodeSyncStep1Empty() []byte
func EncodeSyncStep2(update []byte) []byte
func EncodeSyncUpdate(update []byte) []byte
func EncodeAwarenessRemoval(clientIDs []uint64) []byte
func EncodeAwareness(payload []byte) []byte
```

**Sync sub-protocol mechanics**: `SyncStep1` carries the sender's state
vector (opaque to this server — it never decodes it); `SyncStep2` carries an
update bringing the peer up to date; `SyncUpdate` carries an incremental
update to apply and relay. The server's payload handling is intentionally
"blind": Sync messages are relayed and archived as raw bytes, never
decoded, because real convergence logic is entirely client-side Yjs.

**The one thing the server does need to understand**: awareness updates,
because it must learn client IDs to clean up stale cursors on disconnect
(`decodeAwareness` parses `{clientID, clock, state}` triples; `state ==
"null"` means "this client went away").

**`EncodeSyncStep1Empty` — a documented, load-bearing subtlety**: this
server doesn't maintain a real Yjs state vector (it never merges updates,
see §1.2), so on every fresh connection it advertises an *empty* one:
`var emptyStateVector = []byte{0x00}`. Crucially this is **not** a
zero-length byte slice — a lib0-encoded empty map is the single byte
`0x00` (`writeVarUint(0)`, "0 clients"). `Y.encodeStateAsUpdate()` on the
client reads that leading varUint unconditionally; handing it a genuinely
empty (`nil`/zero-length) payload makes the client-side decoder run
`readVarUint()` past the end of the buffer and throw. This is documented as
a bug that was only caught by `bench/verify-sync.mjs` connecting a real
`y-websocket` client — a Go-only test asserting "the payload equals
`[]byte{}`" would have passed while breaking every real client (see §9).

### 3.5 internal/hub — Room lifecycle, Client connection state

**`hub.go` — `Hub`** (owns every live `Room` on this instance, bridges local
broadcasts to `redisbus`):

```go
type DocumentStore interface {
    Persister
    LoadLatestSnapshot(ctx context.Context, documentID string) ([][]byte, error)
}
type Hub struct { /* mu sync.Mutex; rooms map[string]*Room; store DocumentStore; bus *redisbus.Bus; debounce time.Duration; logger *slog.Logger */ }

func New(st DocumentStore, bus *redisbus.Bus, debounce time.Duration, logger *slog.Logger) *Hub
func (h *Hub) onRemoteMessage(m redisbus.Message)                                  // rebroadcasts a peer instance's event to this instance's local clients only
func (h *Hub) GetOrLoadRoom(ctx, roomID, documentID, workspaceID string) (*Room, error)
func (h *Hub) ReleaseIfEmpty(room *Room)                                           // evicts + final synchronous flush once last client leaves
func (h *Hub) Publish(roomID, kind string, data []byte)                            // fans a local event out via Redis, if configured
```

`GetOrLoadRoom` — double-checked locking: fast path returns an already-live
room under a short lock; on miss, loads the snapshot **outside** the lock
(so a slow Postgres read doesn't stall other rooms), then re-checks under
the lock in case another goroutine won the race, before installing the new
`Room`. This is exactly Hocuspocus's `onLoadDocument` hook, ported.

`ReleaseIfEmpty` mirrors `afterUnloadDocument`: deletes the room from the
map only if `len(room.clients) == 0`, and if so performs a **synchronous**
`room.Flush(ctx)` with a 5s timeout — the final write-behind point, so no
edits are lost between the last disconnect and the next debounce tick.

**`room.go` — `Room`** (in-memory state for one `doc:<id>`/`board:<id>`):

```go
type Persister interface { SaveSnapshot(ctx context.Context, documentID string, blobs [][]byte) error }
type Room struct {
    ID, DocumentID, WorkspaceID string
    // mu sync.Mutex; clients map[*Client]struct{}; log [][]byte; dirty bool
    // debounce time.Duration; flushTimer *time.Timer; store Persister
}
func newRoom(id, documentID, workspaceID string, debounce time.Duration, st Persister, logger *slog.Logger) *Room
func (r *Room) snapshotBlobs() [][]byte           // deep-copied — caller can't mutate the internal log
func (r *Room) appendUpdate(update []byte)         // appends + (re)starts the debounce timer
func (r *Room) flushAsync()
func (r *Room) Flush(ctx context.Context) error    // no-op if !dirty; synchronous SaveSnapshot otherwise
func (r *Room) AddClient(c *Client) int
func (r *Room) removeClient(c *Client) int
func (r *Room) broadcastLocal(from *Client, payload []byte)   // to all clients except `from`
func (r *Room) broadcastAll(payload []byte)                    // broadcastLocal(nil, payload)
```

The room holds the ordered log of raw Yjs update blobs applied since load
**as discrete blobs, never merged/concatenated** — this is what lets a
persisted snapshot be byte-identically replayed by a fresh `Y.Doc` (proven
by `bench/verify-sync.mjs`, §9) without the Go relay needing to understand
Yjs's internal update format at all.

**Write-behind debounce**: `appendUpdate` restarts a `time.AfterFunc(debounce,
r.flushAsync)` timer on every update, so N updates within the debounce
window (default `SNAPSHOT_DEBOUNCE_MS=10000`, i.e. 10s) produce exactly one
`SaveSnapshot` call — proven directly by `room_test.go`'s
`TestDebouncedFlushCoalescesRapidUpdates` (10 updates 5ms apart inside a
50ms test debounce window → 0 flushes until the timer fires, then exactly
1 flush containing all 10 blobs). `Flush` is idempotent when clean
(`TestFlushIsNoOpWhenClean`) and the immediate-flush-on-disconnect path is
proven by `TestDisconnectFlushesImmediatelyWithoutWaitingFullDebounce`
(1-hour debounce, but `ReleaseIfEmpty` still flushes instantly).

**`client.go` — `Client`** (one authenticated WebSocket connection bound to
one `Room`):

```go
const ( writeWait = 10*time.Second; pongWait = 60*time.Second; pingPeriod = (pongWait*9)/10; sendBufferSize = 256 )

type Client struct {
    UserID string
    Permission rbac.Permission
    ReadOnly bool
    // conn *websocket.Conn; room *Room; hub *Hub; sendCh chan []byte; awarenessIDs map[uint64]struct{}
}
func NewClient(conn *websocket.Conn, room *Room, h *Hub, userID string, permission rbac.Permission, logger *slog.Logger) *Client
func (c *Client) send(payload []byte)          // non-blocking enqueue; drops (with a warn log) if sendCh is full — slow consumers never backpressure the hub
func (c *Client) Run()                          // starts writePump goroutine, hydration handshake, then blocks in readPump
func (c *Client) readPump()
func (c *Client) handleMessage(msg []byte)
func (c *Client) handleSync(env *protocol.Envelope)
func (c *Client) handleAwareness(env *protocol.Envelope)
func (c *Client) writePump()
func (c *Client) close()
```

**Hydration sequence** (`Run`, before entering `readPump`): replay every
stored update blob from `room.snapshotBlobs()` as its own `SyncStep2`
message (message *boundaries* matter — see §3.6 on why blobs are never
concatenated), then send one `EncodeSyncStep1Empty()` so the client is
prompted to push up any offline/IndexedDB-only edits it has that the server
doesn't yet know about.

**Write gating** (`handleSync`): a `SyncStep1` from a peer is a no-op (the
server already proactively sent its full log on connect — see above,
"empty-state-vector design"). `SyncStep2`/`SyncUpdate` payloads are
**dropped silently** (with an info log) if `c.ReadOnly` is true —
`rbac.ReadOnly(permission)` computed once at `NewClient` time from the
permission apps/api returned. Otherwise: appended to the room's log,
re-broadcast to local peers (`broadcastLocal`, excluding sender), and
published to Redis (`hub.Publish`) for cross-instance fan-out.

**Awareness gating** (`handleAwareness`): read-only connections **still
receive** awareness broadcasts from others (so they can see live
cursors/presence while viewing) but never emit their own — a `ReadOnly`
client's outgoing awareness updates are dropped, same as sync updates.

**Presence cleanup on disconnect** (`close`): tracks every `awarenessIDs`
this client ever announced; on close, broadcasts an
`EncodeAwarenessRemoval(ids)` message (state `"null"` for each) to remaining
local peers and publishes it to Redis, so cursors/presence disappear
immediately rather than waiting for a client-side timeout. Then calls
`hub.ReleaseIfEmpty(room)` — the final flush trigger.

**Read-loop hardening**: 10MB read limit (generous for
whiteboard/rich-doc payloads), 60s pong-wait read deadline reset on every
pong, and a 54s (`pongWait*9/10`) ping ticker on the write side —
standard gorilla/websocket keepalive pattern.

### 3.6 internal/rbac — pure ranking helpers only (no local RBAC matrix)

```go
package rbac
type Permission string
const ( PermissionView Permission = "VIEW"; PermissionComment Permission = "COMMENT"; PermissionEdit Permission = "EDIT" )
var permissionRank = map[Permission]int{ PermissionView:0, PermissionComment:1, PermissionEdit:2 }

func CanAccess(have, required Permission) bool   // have's rank >= required's rank
func ReadOnly(have Permission) bool               // !CanAccess(have, PermissionComment)
```

This is the entirety of `internal/rbac` — confirmed by grep, there is **no**
`EffectivePermission`, `WorkspaceRole`, or role→permission mapping function
anywhere in the package. The package doc comment states explicitly: it
"intentionally does NOT compute a WorkspaceRole's effective permission
anymore" — that decision, along with JWT verification, is made exclusively
by apps/api's `POST /internal/sessions/verify` (§2.7); this package only
provides the pure permission-*rank* helpers apps/sync still needs locally
once it already has an effective `Permission` string in hand from that
network call. `ReadOnly` is what `hub.NewClient` uses to set
`Client.ReadOnly`, and what gates `handleSync`/`handleAwareness` writes
(§3.5). This is the "second hand-written copy of the RBAC matrix" that used
to need to be kept in lockstep with `@workspace/shared` via two independent
test suites — that duplication no longer exists (see §9's "RBAC is
resolved by apps/api alone").

### 3.7 internal/sessionsclient — the HTTP client for the network boundary

```go
package sessionsclient

var ErrUnreachable = errors.New("sessionsclient: apps/api unreachable")

type Result struct {   // mirrors apps/api's SessionVerifyResult DTO
    Valid      bool            `json:"valid"`
    UserID     string          `json:"userId,omitempty"`
    Role       string          `json:"role,omitempty"`
    Permission rbac.Permission `json:"permission,omitempty"`
    Reason     string          `json:"reason,omitempty"`
}
type request struct { Token string `json:"token"`; WorkspaceID string `json:"workspaceId"` }

type Client struct { BaseURL string; Secret string; HTTP *http.Client }

func New(baseURL, secret string, timeout time.Duration) *Client   // timeout <= 0 -> defaults to 3s
func (c *Client) VerifySession(ctx context.Context, token, workspaceID string) (*Result, error)
```

`VerifySession` — `POST {BaseURL}/internal/sessions/verify`, JSON body
`{"token":..., "workspaceId":...}`, header `x-internal-secret: <Secret>`.
**Every failure mode** — JSON marshal error building the request, request
construction error, the HTTP round trip itself failing (DNS, connection
refused, timeout, TLS), a non-`200` status code, or a response body that
fails to JSON-unmarshal — returns `nil, fmt.Errorf("%w: ...",
ErrUnreachable, ...)`. Response body is read via `io.LimitReader(resp.Body,
1<<16)` (64KB cap, defensive against a misbehaving/malicious upstream). The
doc comment is explicit and load-bearing: *"Callers MUST treat this as a
hard reject, never a silent fallback to local verification — apps/api being
unreachable is not the same thing as a token being valid."* A **nil** error
with `Result.Valid == false` is the *other*, distinct outcome — apps/api
itself rejected the session (its own well-formed answer), carried in
`Result.Reason`. `cmd/sync/main.go`'s `wsHandler` (§3.1) implements exactly
this distinction: `err != nil` → `502`; `!result.Valid` → `401`.

Tested directly against a real `httptest.Server` in `client_test.go` (four
cases: valid session round-trips the header/body correctly; a well-formed
`{valid:false}` response is **not** treated as a Go error;
an unreachable server (`http://127.0.0.1:1`, nothing listening) returns an
`ErrUnreachable`-wrapped error; a non-`200` status (e.g. `401` for a wrong
internal secret) also returns an `ErrUnreachable`-wrapped error — see §9).

### 3.8 internal/store — raw SQL against the Prisma-managed schema

No Prisma client exists for Go, so this package speaks the schema directly
via `pgx/v5`'s connection pool. Table/column names here **must** stay in
sync with `packages/db/prisma/schema.prisma` by hand — see §7.3 for what
happens on drift.

```go
type Store struct { pool *pgxpool.Pool }
func New(ctx context.Context, databaseURL string) (*Store, error)
func (s *Store) Close()
func (s *Store) DocumentWorkspace(ctx context.Context, documentID string) (string, error)
func (s *Store) EnsureDocument(ctx context.Context, documentID, workspaceID, kind, title string) error
func (s *Store) LoadLatestSnapshot(ctx context.Context, documentID string) ([][]byte, error)
func (s *Store) SaveSnapshot(ctx context.Context, documentID string, blobs [][]byte) error
```

- `DocumentWorkspace` — `SELECT "workspaceId" FROM "Document" WHERE id =
  $1` (topology only, not an authz decision — see §3.1 step 3).
- `EnsureDocument` — `INSERT ... ON CONFLICT (id) DO NOTHING`; a defensive
  fallback for ad-hoc scratch docs opened by a client before apps/api's own
  `createDocument` mutation (which doesn't currently exist as a documented
  GraphQL mutation — see the caveat about assumed apps/api surface in §4)
  has created the row. **Not currently called anywhere in the live
  connection path** — `cmd/sync/main.go`'s `wsHandler` never invokes it
  (only `DocumentWorkspace`, `GetOrLoadRoom` → `LoadLatestSnapshot`, and
  `SaveSnapshot` are exercised at runtime); it exists as defined-but-unwired
  infrastructure for a future/manual hook.
- `LoadLatestSnapshot` — most recent `DocumentSnapshot.state` by
  `documentId`, `ORDER BY "createdAt" DESC LIMIT 1`; gunzips then
  `unframe()`s it. Returns `nil, nil` (not an error) if no row exists yet.
- `SaveSnapshot` — frames all blobs (`framing.go`, below), gzips, and in one
  `pgx` transaction: inserts a new `DocumentSnapshot` row (`vectorClock` set
  to an 8-byte big-endian encoding of `len(blobs)` — a coarse stand-in, not
  a real Yjs state vector) and **prunes** all older rows for the same
  `documentId` (`DELETE ... WHERE id NOT IN (SELECT ... ORDER BY
  "createdAt" DESC LIMIT 1)`) so the table stays bounded — only the latest
  snapshot is ever needed to rehydrate a room.

**`framing.go`** — pure byte-level helpers, no DB/network dependency:
```go
func frame(blobs [][]byte) []byte     // uint32 BE length prefix + bytes, per blob, concatenated
func unframe(raw []byte) [][]byte     // inverse; stops (doesn't panic) on a truncated/corrupt tail
func gzipBytes(data []byte) ([]byte, error)
func gunzip(data []byte) ([]byte, error)
```
This length-prefixed framing is what lets an arbitrary number of
independent Yjs update blobs live in one `Bytes` column and be split back
apart exactly, without the Go side ever parsing their contents.

### 3.9 internal/redisbus — cross-instance fan-out

```go
package redisbus
const channelPrefix = "sync:room:"
type Message struct { InstanceID, RoomID, Kind string; Data []byte }  // Kind: "update" | "awareness"
type Bus struct { rdb *redis.Client; instanceID string; logger *slog.Logger }

func New(rdb *redis.Client, instanceID string, logger *slog.Logger) *Bus
func (b *Bus) Publish(ctx context.Context, roomID, kind string, data []byte) error
func (b *Bus) Subscribe(ctx context.Context, onMessage func(Message))
```

`Publish` marshals a `Message` (tagging it with this instance's ID) and
`PUBLISH`es to `sync:room:<roomID>`. `Subscribe` opens one
`PSUBSCRIBE sync:room:*` pattern subscription and, for every incoming
message, **skips** it if `m.InstanceID == b.instanceID` (this instance
already relayed it to its own local clients directly — see
`Hub.onRemoteMessage`, §3.5) — this self-filtering is the entire reason
`INSTANCE_ID` exists. If Redis is unreachable at startup, `main.go` logs a
warning and runs with `bus == nil`; every `Hub.Publish`/room-broadcast call
becomes effectively local-only (correct for single-instance dev, silently
**incorrect** for horizontal scale-out — two users on the same document
routed to different replicas would never see each other's edits).

### 3.10 Environment variables (apps/sync)

From `apps/sync/.env.example`:

| Var | Purpose |
|---|---|
| `PORT` | HTTP/WS listen port (default 1234) |
| `DATABASE_URL` | Same Postgres apps/api uses — raw SQL against the Prisma-managed schema |
| `REDIS_URL` | Cross-instance pub/sub fan-out; standalone mode if unreachable at startup |
| `API_BASE_URL` | apps/api's origin, used for `POST /internal/sessions/verify` |
| `INTERNAL_SERVICE_SECRET` | Must be byte-identical to apps/api's copy — sent as `x-internal-secret` |
| `SESSION_VERIFY_TIMEOUT_MS` | Timeout for the verify HTTP call (default 3000); exceeding it rejects the connection, no fallback |
| `SNAPSHOT_DEBOUNCE_MS` | Write-behind debounce window (default 10000 = 10s) |
| `INSTANCE_ID` | Redis pub/sub self-identification; defaults to `<hostname>-<pid>` |

---

## 4. apps/web — SolidJS SPA

Root: `apps/web/src`. Build: Vite 5 + `vite-plugin-solid`. Router:
`@solidjs/router`. Collab stack: `yjs`, `@hocuspocus/provider`,
`y-indexeddb`, `y-prosemirror` + ProseMirror packages. Voice/video:
`livekit-client`. Tests: `vitest` + jsdom.

### 4.1 Routing (`src/App.tsx`, `src/main.tsx`, `src/pages/*`)

```
/login                              -> Login
/register                           -> Register
/                                   -> Home                (RequireAuth)
/w/:workspaceId                     -> WorkspaceShell      (RequireAuth)
  /w/:workspaceId/c/:channelId      -> ChannelView          (nested)
```

`RequireAuth(props: {children?: JSX.Element})` — `<Show
when={isAuthenticated()} fallback={<Navigate href="/login"/>}>` — reactively
redirects the instant `logout()` fires (not just on next navigation),
because Solid compiles the `when` prop into a reactive getter.

`main.tsx` — `render(() => <App/>, document.getElementById("root"))`.

**`pages/Home.tsx`** — lists `myWorkspaces()`;
`handleCreate` → `createWorkspace(name)` → `navigate(\`/w/${created.id}\`)`.

**`pages/Login.tsx`** / **`pages/Register.tsx`** — call `login`/`register`
from `lib/api.ts`, navigate to `/` with `replace: true` on success.

**`pages/WorkspaceShell.tsx`** — loads `Promise.all([fetchWorkspace(id),
fetchChannels(id)])` in a `createEffect` keyed on `params.workspaceId`.
Sidebar channel nav, new-channel form (`createChannel` then navigates into
it), logout button, `<main>{props.children}</main>` slot for the nested
route.

**`pages/ChannelView.tsx`** — reads `VITE_WS_URL`/`VITE_API_URL` from
`import.meta.env` at module scope. Tab state `type Tab = "chat"|"doc"|
"board"|"huddle"|"tasks"|"calendar"`; renders exactly one feature component
per active tab:

```tsx
chat     -> <ChatPanel channelId={params.channelId}/>
doc      -> <CollabEditor documentId={params.channelId} wsUrl={WS_URL}/>
board    -> <Whiteboard boardId={params.channelId} wsUrl={WS_URL}/>
huddle   -> <Huddle workspaceId={params.workspaceId} channelId={params.channelId} apiUrl={API_URL}/>
tasks    -> <TaskList workspaceId={params.workspaceId}/>
calendar -> <CalendarView workspaceId={params.workspaceId}/>
```

Design point: doc/board IDs are literally the `channelId` — each channel
gets exactly one shared doc and one shared board (no multi-doc-per-channel
support yet); `CollabEditor`/`Whiteboard` prepend their own `doc:`/`board:`
prefix at the Hocuspocus room-name layer.

### 4.2 src/lib — API client, auth store, WS subscription stub

**`lib/api.ts`** — hand-rolled `fetch`-based GraphQL client (no
Apollo/urql, deliberately, to keep the bundle small for the app's simple
data needs):

```ts
function graphqlEndpoint(): string                       // `${VITE_API_URL}/graphql`, or same-origin `/graphql` via the Vite dev proxy
class GraphQLError extends Error { constructor(message: string, public errors: unknown[]) }
let inFlightRefresh: Promise<boolean> | null              // dedupes concurrent silent-refresh attempts
async function silentRefresh(): Promise<boolean>          // RefreshToken mutation; setAccessToken on success, logout() on failure
async function request<T>(query, variables?, opts?: {skipAuth?, _retried?}): Promise<T>
  // attaches Authorization: Bearer <accessToken> unless skipAuth
  // on HTTP 401 (or GraphQL extensions.code === "UNAUTHENTICATED"), not yet retried:
  //   silentRefresh() then retries once with _retried: true
  // throws GraphQLError on remaining errors / missing data
```

Exported operations (all route through `request<T>`): `login`, `register`,
`myWorkspaces`, `workspace(id)`, `createWorkspace(name)`,
`channels(workspaceId)`, `createChannel(workspaceId, name)`,
`messages(channelId)`, `sendMessage(channelId, body)`, `tasks(workspaceId)`,
`createTask`, `updateTaskStatus`, `events(workspaceId)`, `createEvent` —
each with a hand-written GraphQL operation string matching the
corresponding apps/api resolver (§2). Note: `tasks`/`createTask`/
`updateTaskStatus`/`events`/`createEvent` are flagged in the source as
"assumed API, not part of the documented apps/api GraphQL contract" — their
exact field shapes are the frontend's best guess pending confirmation
against the live schema.

**`lib/auth-store.ts`** — Solid signal-based session store, persisted to
`localStorage` under `"workspace.auth"`:
```ts
interface AuthUser { id: string; email: string; name?: string }
interface AuthState { accessToken: string | null; refreshToken: string | null; user: AuthUser | null }
export const authState: () => AuthState              // reactive getter
export function setAuth(next: {accessToken, refreshToken, user}): void
export function setAccessToken(accessToken: string): void   // partial update after silent refresh
export function logout(): void
export function isAuthenticated(): boolean            // auth().accessToken !== null
```

**`lib/ws-subscription.ts`** — a **documented stub, not wired up**:
`subscribeToMessageAdded(_channelId, _onMessage): SubscriptionHandle` logs a
`console.warn` and returns a no-op handle; a block comment shows the
intended real implementation using `graphql-ws`'s `createClient`. `graphql-ws`
is deliberately **not** a dependency yet. `ChatPanel.tsx` does not call this
— it polls instead (§4.3, §7.2).

### 4.3 features/chat — ChatPanel.tsx

```ts
const POLL_INTERVAL_MS = 4000;
export default function ChatPanel(props: { channelId: string }): JSX.Element
```

**Send flow** (`handleSend`) — fully optimistic: builds a local `Message`
(`id: "optimistic-<timestamp>"`, author from `authState().user`), appends
it to the `items` signal and clears the draft **immediately**, then awaits
`sendMessage(channelId, body)` (the `SendMessage` GraphQL mutation). On
success, replaces the optimistic entry in place (matched by `id`) with the
server-returned saved message. On failure, the optimistic entry is filtered
back out and an error is surfaced (rollback).

**Delivery**: not a live subscription — a `setInterval(POLL_INTERVAL_MS)`
inside a `createEffect` keyed on `props.channelId` re-fetches
`messages(channelId)` and wholesale-replaces `items` when the fetched
length differs from current, preserving "scroll to bottom" behavior only if
the user was already at the bottom. Cleaned up via `onCleanup`. See §7.2 for
the full send-to-delivery walkthrough including this gap.

### 4.4 features/document — CollabEditor.tsx (rich text) + undo-scope.ts

```ts
export default function CollabEditor(props: { documentId: string; wsUrl: string }): JSX.Element
```

**Y.Doc sync session setup** (in `onMount`), step by step:
1. `const ydoc = new Y.Doc()`.
2. `new IndexeddbPersistence(\`doc:${documentId}\`, ydoc)` — offline-first
   local cache, keyed identically to the sync room name.
3. `token = authState().accessToken ?? ""`.
4. `provider = new HocuspocusProvider({ url: props.wsUrl, name:
   \`doc:${documentId}\`, token, document: ydoc, onStatus })` — room name
   `doc:<channelId>` (documentId passed down equals the channelId, per
   `ChannelView.tsx`). Token attached as the Hocuspocus `token` field —
   this becomes the `?token=` query param apps/sync's `wsHandler` reads
   (§3.1, §7.1).
5. `provider.awareness?.setLocalStateField("user", {id, name, color})`.
6. `ydoc.getXmlFragment("prosemirror")` is the shared type bound into
   ProseMirror via `y-prosemirror`'s `ySyncPlugin(fragment)`,
   `yCursorPlugin(provider.awareness!, {cursorBuilder})`, `yUndoPlugin` +
   an `undoManager` from `makeUndoManager` (below), plus keymaps
   (`Mod-z`/`Shift-Mod-z`/`Mod-y`) and `exampleSetup({schema, menuBar:
   true})`.

**Selective undo (`features/document/undo-scope.ts`)**:
```ts
export function makeTrackedOrigins(ydoc: Y.Doc): Set<unknown>     // new Set([ydoc.clientID])
export function makeUndoManager(ydoc: Y.Doc, fragment: Y.AbstractType<any>): Y.UndoManager
  // new Y.UndoManager(fragment, { trackedOrigins: makeTrackedOrigins(ydoc) })
```
Scopes Ctrl/Cmd+Z to only the local client's own transactions, so undoing
never reverts a remote peer's concurrent edit — tested directly in
`undo-scope.spec.ts` (§9).

**Ephemeral cursor-chat**: pressing `/` opens a popover instead of typing;
`submitCursorChat` writes `provider.awareness.setLocalStateField("cursorChat",
{text, expiresAt: Date.now() + 5000})` — **never** written to the Y.Doc, so
never persisted, auto-clearing via `setTimeout` and filtered by `expiresAt`
in the presence reader.

**Presence**: `readAwareness()` iterates `provider.awareness.getStates()`,
skips the local `clientId`, builds presence + cursor-chat-bubble lists;
bound to `awareness.on("change", ...)` plus a 1s safety-net interval.

Helpers: `hashToHue(userId): number` (djb2-ish hash → 0–359),
`colorForUser(userId): string` (`hsl(hue, 70%, 50%)`).

`onCleanup` tears down timers/listeners, `view.destroy()`,
`provider.destroy()`, `indexeddbProvider.destroy()`.

### 4.5 features/whiteboard — Whiteboard.tsx

```ts
export type ShapeType = "rectangle" | "ellipse" | "sticky" | "pen";
export interface Shape { id, type, x, y, w, h, color, points?, text? }
export interface Viewport { x: number; y: number; zoom: number; }
export function renderShapes(ctx: CanvasRenderingContext2D, shapes: Shape[], viewport: Viewport): void
export default function Whiteboard(props: { boardId: string; wsUrl: string }): JSX.Element
```

Rendering is plain Canvas2D — explicitly **not** PixiJS/WebGL, documented
in the file header as a deliberate simplification with a documented
upgrade path (swap `renderShapes` for a PixiJS `Application`). `renderShapes`
is pure: translates the canvas origin, applies `scale(zoom)` then
`translate(-viewport.x, -viewport.y)`, then draws each shape by `type`
(`rectangle`→`strokeRect`, `ellipse`→`ctx.ellipse`, `sticky`→filled rect +
wrapped text, `pen`→polyline through `points`).

**Y.Doc sync session setup** — same provider/indexeddb pattern as
CollabEditor, different naming and data model:
1. `new IndexeddbPersistence(\`board:${boardId}\`, ydoc)`.
2. `new HocuspocusProvider({url: wsUrl, name: \`board:${boardId}\`, token,
   document: ydoc})` — room name **`board:<channelId>`**.
3. `shapesMap = ydoc.getMap<Shape>("shapes")` — the whiteboard's data model
   is a flat `Y.Map` keyed by shape id (not an `XmlFragment` like the rich
   text editor); `shapesMap.observe(syncShapesFromDoc)` mirrors it into a
   Solid `shapes` signal.
4. Remote cursor tracking: `readCursors()` reads each peer's
   `awareness.getStates()` `position: {x,y}` field — this is the exact XY
   feed spatial-audio's `computeGain` (§4.6) is designed to consume, though
   that wiring isn't connected yet (see below).

**Interaction**: `screenToWorld`/pan/zoom (`wheel`, clamped `[0.2, 4]`);
`handlePointerDown` creates shapes directly via `shapesMap.set(id, shape)`
(no local-first buffering — every stroke/shape write hits the CRDT map
immediately); `handlePointerMove` broadcasts
`awareness.setLocalStateField("position", {x,y})` on every move (the
position feed for §4.6).

### 4.6 features/spatial-audio — gain.ts

Pure math, zero WebAudio/WebRTC/LiveKit dependency:

```ts
export interface Vec2 { x: number; y: number; }
export type FalloffCurve = "linear" | "inverse-square";
export interface GainOptions { nearRadius?: number; farRadius?: number; curve?: FalloffCurve; }
export function computeGain(listener: Vec2, source: Vec2, opts: GainOptions = {}): number
```

Defaults `nearRadius=150`, `farRadius=600`, `curve="linear"`. Logic: `dist
= Euclidean(listener, source)`; degenerate config (`farRadius <=
nearRadius`) → hard cutoff (1 or 0); `dist <= nearRadius` → `1`; `dist >=
farRadius` → `0`; otherwise `normalizedDistance = (dist - nearRadius) /
(farRadius - nearRadius)`, and `gain = curve === "inverse-square" ? 1 -
normalizedDistance**2 : 1 - normalizedDistance`, clamped to `[0,1]`.
Directly unit-tested in `gain.spec.ts` (§9). **Not wired to real audio
anywhere in the running app** — `Huddle.tsx` has a comment block showing
exactly where `computeGain(myPosition, participantPosition)` would feed a
Web Audio `GainNode.gain.value`, consuming the `position` awareness field
Whiteboard.tsx broadcasts, but this connection does not currently exist in
code.

### 4.7 features/huddle — Huddle.tsx (LiveKit)

```ts
type HuddleStatus = "idle" | "connecting" | "connected" | "error";
export default function Huddle(props: { workspaceId: string; channelId: string; apiUrl: string }): JSX.Element
```

Explicitly documented as a scaffold — real audio/video needs a running
LiveKit deployment plus a `POST /livekit/token` REST endpoint apps/api does
not currently implement.

**`VITE_LIVEKIT_URL` handling**: `const livekitUrl = import.meta.env
.VITE_LIVEKIT_URL || undefined`. Template: `<Show when={livekitUrl}
fallback={<div>LiveKit server not configured. Set VITE_LIVEKIT_URL to
enable voice/video huddles.</div>}>`. `joinHuddle()` also early-returns with
an error message if somehow called while `livekitUrl` is unset — belt and
suspenders.

**Token fetch**: `fetchLiveKitToken()` — `POST {apiUrl}/livekit/token` with
`Authorization: Bearer <accessToken>`, body `{workspaceId, channelId}`,
expects `{token: string}`. Documented assumption: server-side LiveKit room
name is `${workspaceId}:${channelId}`.

**Connection** (`joinHuddle`):
```ts
room = new Room();
room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => attachRemoteTrack(track, participant));
room.on(RoomEvent.TrackUnsubscribed, (track) => detachRemoteTrack(track));
room.on(RoomEvent.ParticipantConnected | ParticipantDisconnected, refreshParticipants);
room.on(RoomEvent.Disconnected, () => { setStatus("idle"); setParticipants([]); });
await room.connect(livekitUrl, token);
await room.localParticipant.setMicrophoneEnabled(true);
await room.localParticipant.setCameraEnabled(true);
```
`attachRemoteTrack` calls `track.attach()` and appends the media element to
a container, tagging `dataset.participantId` — this is the attach point
the (unwired) spatial-audio gain hook comment references.

### 4.8 features/tasks-calendar — TaskList.tsx, CalendarView.tsx

**`TaskList.tsx`** — `STATUSES = ["todo","in_progress","done"]`; loads via
`tasks(workspaceId)`, reloads on `props.workspaceId` change.
`handleStatusChange` is **optimistic**: updates `items` immediately, calls
`updateTaskStatus`, rolls back to a saved `previous` snapshot on failure.

**`CalendarView.tsx`** — `startOfWeek(date)` normalizes to Sunday 00:00;
`days = createMemo(...)` (7 dates from `weekStart`); `eventsForDay(day)`
filters loaded events by `startAt` falling in `[dayStart, dayEnd)`; prev/next
week navigation shifts `weekStart` by `±7*DAY_MS`.

Both features carry the same "assumed API, not part of the documented
apps/api GraphQL contract" caveat as `lib/api.ts`'s `tasks`/`events`
operations.

### 4.9 Environment variables (apps/web)

From `apps/web/.env.example` (all **build-time**, baked into the static
bundle by `vite build` — no runtime reconfiguration without a rebuild):

| Var | Purpose |
|---|---|
| `VITE_API_URL` | apps/api GraphQL HTTP origin (dev: proxied via `vite.config.ts`; prod: baked in) |
| `VITE_WS_URL` | apps/sync Hocuspocus WS origin, used by `CollabEditor`/`Whiteboard` |
| `VITE_LIVEKIT_URL` | LiveKit server URL; unset → `Huddle` renders the "not configured" scaffold instead of connecting |

`vite.config.ts` proxies `/graphql` to `VITE_API_URL` in dev
(`ws: false` — the proxy is HTTP-only, unrelated to the sync WS
connection).

---

## 5. packages/shared

Single file: `packages/shared/src/index.ts` (181 lines). Cross-cutting
types and pure helpers shared between apps/api and apps/web (and, before
the network-boundary change, mirrored by hand in apps/sync — no longer,
see §3.6). Its enums mirror `packages/db/prisma/schema.prisma`'s enums 1:1.

### Enums

```ts
export enum WorkspaceRole { OWNER='OWNER', ADMIN='ADMIN', MEMBER='MEMBER', GUEST='GUEST' }
export enum PermissionLevel { VIEW='VIEW', COMMENT='COMMENT', EDIT='EDIT' }
export enum ChannelKind { CHANNEL='CHANNEL', DM='DM' }
export enum DocumentKind { RICH_TEXT='RICH_TEXT', WHITEBOARD='WHITEBOARD' }
export enum TaskStatus { TODO='TODO', IN_PROGRESS='IN_PROGRESS', DONE='DONE', CANCELLED='CANCELLED' }
export enum GuestLinkPermission { VIEW='VIEW', COMMENT='COMMENT', EDIT='EDIT' }
```

### JWT payload types

```ts
export interface JwtPayload { sub: string; email: string; iat?: number; exp?: number; }
export interface GuestJwtPayload {
  sub: string;           // synthetic guest id, e.g. `guest:<guestLinkId>`
  guest: true;
  workspaceId: string;
  permission: GuestLinkPermission;
  iat?: number; exp?: number;
}
export type AnyJwtPayload = JwtPayload | GuestJwtPayload;
export function isGuestJwtPayload(payload: AnyJwtPayload): payload is GuestJwtPayload {
  return (payload as GuestJwtPayload).guest === true;
}
```

### RBAC matrix — the single implementation

```ts
export const WORKSPACE_ROLE_RANK: Record<WorkspaceRole, number> = {
  [WorkspaceRole.GUEST]: 0, [WorkspaceRole.MEMBER]: 1, [WorkspaceRole.ADMIN]: 2, [WorkspaceRole.OWNER]: 3,
};
export const PERMISSION_LEVEL_RANK: Record<PermissionLevel, number> = {
  [PermissionLevel.VIEW]: 0, [PermissionLevel.COMMENT]: 1, [PermissionLevel.EDIT]: 2,
};
export function hasWorkspaceRoleAtLeast(role: WorkspaceRole, required: WorkspaceRole): boolean {
  return WORKSPACE_ROLE_RANK[role] >= WORKSPACE_ROLE_RANK[required];
}
export const DEFAULT_ROLE_PERMISSION: Record<WorkspaceRole, PermissionLevel> = {
  [WorkspaceRole.OWNER]: PermissionLevel.EDIT,
  [WorkspaceRole.ADMIN]: PermissionLevel.EDIT,
  [WorkspaceRole.MEMBER]: PermissionLevel.EDIT,
  [WorkspaceRole.GUEST]: PermissionLevel.VIEW,
};
export function canPerform(role: WorkspaceRole, required: PermissionLevel, override?: PermissionLevel): boolean {
  const effective = override ?? DEFAULT_ROLE_PERMISSION[role];
  return PERMISSION_LEVEL_RANK[effective] >= PERMISSION_LEVEL_RANK[required];
}
```

`canPerform` step by step: resolve `effective` — `override` **entirely
replaces** the role's default ceiling if provided (`??`, not a max/merge —
per the docstring, "does not merely raise it"), else fall back to
`DEFAULT_ROLE_PERMISSION[role]`; compare ranks. Net truth table with no
override: OWNER/ADMIN/MEMBER → EDIT (rank 2), pass everything; GUEST →
VIEW (rank 0), passes only a VIEW check unless a per-resource `override`
(GuestLink.permission) raises it. This exact function is imported by
apps/api's `PermissionsGuard` (§2.4) and `InternalSessionsService` (§2.7) —
there is exactly one implementation of the RBAC matrix in the entire
system.

### Misc

```ts
export interface CursorPage<T> { items: T[]; nextCursor: string | null; hasMore: boolean; }
```

---

## 6. packages/db

`packages/db/prisma/schema.prisma` — the single Prisma schema, generating
into `packages/db/generated/client` (re-exported as `@workspace/db`'s
`main`/`types` entry point, `packages/db/package.json`). No seed script
exists anywhere under `packages/db` (no `prisma.seed` config, no `seed`
npm script, no `seed*` file).

```prisma
generator client { provider = "prisma-client-js"; output = "../generated/client" }
datasource db    { provider = "postgresql"; url = env("DATABASE_URL") }

enum WorkspaceRole { OWNER ADMIN MEMBER GUEST }
enum PermissionLevel { VIEW COMMENT EDIT }
enum ChannelKind { CHANNEL DM }
enum DocumentKind { RICH_TEXT WHITEBOARD }
enum TaskStatus { TODO IN_PROGRESS DONE CANCELLED }
enum GuestLinkPermission { VIEW COMMENT EDIT }
```

### Models

| Model | Key fields | Notes |
|---|---|---|
| `User` | `id, email @unique, passwordHash, displayName, avatarUrl?, createdAt, updatedAt` | `@@index([email])`; 1–N memberships, messages, tasks (assignee/creator), calendar events, refresh tokens, guest links created |
| `RefreshToken` | `id, userId, tokenHash @unique, expiresAt, revokedAt?, createdAt` | `@@index([userId])`; `tokenHash` is `sha256(token+pepper)`, never the raw token |
| `Workspace` | `id, name, slug @unique, createdAt, updatedAt` | root of the RBAC/content hierarchy |
| `WorkspaceMember` | `id, workspaceId, userId, role WorkspaceRole @default(MEMBER), joinedAt` | `@@unique([workspaceId, userId])`, `@@index([userId])` — the join table carrying role |
| `Channel` | `id, workspaceId, name, kind ChannelKind @default(CHANNEL), isPrivate, parentId?, createdAt` | self-relation "ChannelNesting" via `parentId`/`children`; `@@index([workspaceId])`, `@@index([parentId])` |
| `Message` | `id, channelId, authorId, body, richBody Json?, threadRootId?, editedAt?, deletedAt?, createdAt` | self-relation "ThreadReplies" via `threadRootId`/`replies`; `@@index([channelId, createdAt])`, `@@index([threadRootId])` |
| `Attachment` | `id, messageId, url, mimeType, sizeBytes, createdAt` | `@@index([messageId])` |
| `Document` | `id, workspaceId, channelId?, kind DocumentKind @default(RICH_TEXT), title, createdAt, updatedAt` | `@@index([workspaceId])`; the durable record for a CRDT doc/board — live state lives only in apps/sync's memory |
| `DocumentSnapshot` | `id, documentId, state Bytes, sizeBytes Int, vectorClock Bytes, createdAt` | `@@index([documentId, createdAt])`; compressed binary Yjs snapshot, write-behind by apps/sync |
| `Task` | `id, workspaceId, title, description?, status TaskStatus @default(TODO), dueAt?, assigneeId?, creatorId, createdAt, updatedAt` | `@@index([workspaceId, status])`, `@@index([assigneeId])` |
| `CalendarEvent` | `id, workspaceId, title, description?, startsAt, endsAt, organizerId, createdAt` | `@@index([workspaceId, startsAt])` |
| `GuestLink` | `id, workspaceId, token @unique, permission GuestLinkPermission @default(VIEW), createdById, expiresAt?, createdAt` | `@@index([workspaceId])` |

All `id` fields are `String @id @default(uuid())`. Cascade deletes: a
`Workspace` deletion cascades through `WorkspaceMember`, `Channel`, `Task`,
`CalendarEvent`, `Document`, `GuestLink`; a `Channel` deletion cascades
`Message`/`Document`; a `Document` deletion cascades `DocumentSnapshot`; a
`Message` deletion cascades `Attachment`; a `User` deletion cascades
`WorkspaceMember`/`RefreshToken`.

**Fields apps/sync's raw SQL touches directly** (must stay hand-synced —
see §3.8, §7.3): `Document.id/workspaceId`, `WorkspaceMember.workspaceId/
userId` (unique key `workspaceId_userId`), `DocumentSnapshot.id/documentId/
state/sizeBytes/vectorClock/createdAt`.

---

## 7. Data flow walkthroughs

### 7.1 WebSocket connection: apps/web → apps/sync (with the session-verify call to apps/api)

1. **apps/web** — user opens the "doc" tab in `ChannelView.tsx`. `CollabEditor`
   mounts, creates a `Y.Doc`, wires an `IndexeddbPersistence` for offline
   cache, reads `authState().accessToken`, and constructs a
   `HocuspocusProvider({url: VITE_WS_URL, name: "doc:<channelId>", token,
   document: ydoc})`. Hocuspocus dials `ws://<VITE_WS_URL>/doc:<channelId>?token=<jwt>`.
2. **apps/sync** (`cmd/sync/main.go`'s `wsHandler`) receives the raw HTTP
   request (still pre-upgrade):
   a. Parses the path into `kind="doc"`, `documentID="<channelId>"`.
   b. Reads `token` from the query string; rejects `401` if absent.
   c. `st.DocumentWorkspace(ctx, documentID)` — `SELECT "workspaceId" FROM
      "Document" WHERE id = $1` against Postgres; `403` if the document
      doesn't exist.
   d. **`sessions.VerifySession(ctx, token, workspaceID)`** — the network
      hop to apps/api: `POST {API_BASE_URL}/internal/sessions/verify`,
      header `x-internal-secret: <INTERNAL_SERVICE_SECRET>`, body
      `{"token": "<jwt>", "workspaceId": "<id>"}`, bounded by
      `SESSION_VERIFY_TIMEOUT_MS` (default 3000ms).
3. **apps/api** (`InternalSessionsController` → `InternalServiceGuard` →
   `InternalSessionsService.verify`): the guard first constant-time-compares
   the `x-internal-secret` header against its own `INTERNAL_SERVICE_SECRET`
   (401 on mismatch/missing/unset-server-secret, before the body is even
   parsed). The service then `jwt.verifyAsync(token, {secret:
   JWT_ACCESS_SECRET, algorithms:['HS256']})` — the same secret/algorithm
   as the GraphQL `JwtStrategy`. For a regular user token: looks up
   `WorkspaceMember` by `(workspaceId, userId)`; not found → `{valid:false,
   reason:"not_a_member"}`; found → `{valid:true, userId, role,
   permission: DEFAULT_ROLE_PERMISSION[role]}`. For a guest token: checks
   `payload.workspaceId === workspaceId` (else `workspace_mismatch`), then
   returns `{valid:true, userId:"guest:<id>", role:GUEST,
   permission:<claim>}` with **no** DB lookup. Responds `200` with this
   JSON body in every "well-formed" case (auth-failure at the guard level
   is the only non-2xx path).
4. **Back in apps/sync**: a **non-nil Go error** from `VerifySession`
   (timeout, connection refused, non-200, malformed JSON — all
   `ErrUnreachable`-wrapped) → the WebSocket handshake is refused with
   `502`, full stop, **no local fallback verification**. A nil error with
   `result.Valid == false` → `401`. Only once `result.Valid == true` and
   both `UserID`/`Permission` are non-empty does `wsHandler` call
   `upgrader.Upgrade(w, r, nil)` to actually establish the WebSocket.
5. `h.GetOrLoadRoom(ctx, "doc:<channelId>", documentID, workspaceID)` —
   creates the in-memory `Room` on first access, hydrating
   `LoadLatestSnapshot` from the most recent `DocumentSnapshot` row
   (gunzip + unframe into discrete blobs) if one exists, else starts empty.
6. `hub.NewClient(conn, room, h, result.UserID, permission, logger)` — sets
   `Client.ReadOnly = rbac.ReadOnly(permission)` (true iff the returned
   permission ranks below `COMMENT`). `room.AddClient(client)`;
   `client.Run()`.
7. **Hydration handshake** (`Client.Run`): every stored update blob is sent
   as its own `SyncStep2` frame (lib0-encoded), followed by one
   `EncodeSyncStep1Empty()` frame (the documented `0x00` non-empty-empty
   state vector, §3.4) so the client pushes up any local-only edits it has.
8. **apps/web**'s `y-websocket`-protocol client (`HocuspocusProvider`)
   receives the replayed blobs, applies them via `Y.applyUpdate`, and the
   editor/whiteboard becomes interactive. `onStatus` fires `status:
   "connected"`.
9. From here, live edits flow both directions as `SyncUpdate` frames
   (`Client.handleSync` → `room.appendUpdate` → `room.broadcastLocal` to
   other local clients + `hub.Publish` to Redis for other instances, §3.5,
   §3.9), and awareness (presence/cursors/`position` for spatial audio, and
   ephemeral cursor-chat) flows as `Awareness` frames, gated the same
   read-only way if `Client.ReadOnly` is true.

### 7.2 Chat message send, end to end

1. **apps/web** (`ChatPanel.tsx`, `handleSend`) — builds an optimistic
   local `Message` object and appends it to the `items` signal
   *immediately*, before any network call, so the UI feels instant.
2. Calls `sendMessage(channelId, body)` (`lib/api.ts`) → GraphQL mutation
   `SendMessage($channelId: ID!, $body: String!) { sendMessage(input:
   {channelId, body}) { id channelId body authorId authorName createdAt } }`
   over `POST /graphql`, `Authorization: Bearer <accessToken>` attached by
   `request<T>`.
3. **apps/api** (`MessagesResolver.sendMessage`) — guard chain:
   `JwtAuthGuard` (class-level) validates the JWT via `JwtStrategy`, then
   `PermissionsGuard` (`@RequiredPermission(PermissionLevel.COMMENT)`)
   resolves `workspaceId` from `input.channelId` → `Channel.workspaceId`
   (`PermissionsGuard.resolveWorkspaceId`, §2.4), then checks
   `canPerform(callerRole, COMMENT[, guestOverride])` — a GUEST with only
   VIEW permission is rejected with `403` here, before the resolver body
   runs.
4. `MessagesService.sendMessage` — re-validates channel access
   (`assertChannelAccess`: channel exists + caller has a `WorkspaceMember`
   row — belt-and-suspenders alongside the guard), `prisma.message.create`
   (includes `author`), computes `replyCount` (0 for a new top-level
   message), then **publishes** to `graphql-redis-subscriptions`:
   `pubSub.publish("messageAdded.<channelId>", {messageAdded: shaped})`.
5. The mutation returns the saved `Message` (with real `id`/`createdAt`) to
   apps/web, which swaps it in for the optimistic placeholder by matching
   the temporary `id`.
6. **The `messageAdded` subscription exists on the server** (topic-scoped
   per channel, backed by Redis so it fans out correctly across
   horizontally-scaled apps/api instances) **but apps/web never subscribes
   to it** — `lib/ws-subscription.ts`'s `subscribeToMessageAdded` is an
   inert stub (no `graphql-ws` dependency wired in). Instead, other tabs/
   users see the new message via `ChatPanel`'s 4-second poll
   (`fetchMessages(channelId)` on a `setInterval`), which wholesale-replaces
   `items` when the fetched count differs. This is a **known, documented
   gap**: message delivery to *other* connected clients has up to a
   ~4-second latency floor, not the low-latency push the subscription
   infrastructure was built to provide — the plumbing for real-time push
   exists end-to-end on the server and is fully specified in the client
   stub's comments, but is not wired into `ChatPanel.tsx`.

### 7.3 Prisma schema change → effect on apps/api and apps/sync's RBAC/data mirror

Because apps/sync speaks raw SQL rather than using a generated Prisma
client, a schema change is **not** automatically propagated to it — this is
a manual-sync hazard the codebase documents explicitly (§3.8,
`docs/DEPLOYMENT.md` "Database migrations").

- **A column apps/api alone touches** (e.g. adding `User.timezone`) — only
  `packages/db/prisma/schema.prisma` and `pnpm prisma:migrate` /
  `prisma generate` need to run; apps/api's generated `PrismaClient` picks
  it up automatically; apps/sync is unaffected (it never queries `User`).
- **A column apps/sync's raw SQL touches** — `Document.id`/`workspaceId`,
  `WorkspaceMember.workspaceId`/`userId` (and the `workspaceId_userId`
  unique constraint name, which pgx queries do **not** reference by name
  since `apps/sync/internal/store` writes plain `WHERE` clauses, but
  apps/api's Prisma `findUnique({where: {workspaceId_userId: {...}}})`
  calls *do* rely on that exact compound-unique name — renaming it breaks
  apps/api at compile time via the regenerated Prisma client, which is a
  fail-fast signal apps/sync's raw SQL would **not** get), and
  `DocumentSnapshot`'s five columns — renaming or removing any of these
  requires a **matching manual edit** to `apps/sync/internal/store/
  postgres.go`'s SQL strings. There is no compiler or migration tool that
  catches this drift for the Go side; the only safety net is the
  integration-style expectation described in `docs/TESTING.md` (round-trip
  a snapshot through `bench/verify-sync.mjs` against a migrated schema)
  and any manual review.
- **RBAC-shape changes** (e.g. adding a new `WorkspaceRole` or changing
  `DEFAULT_ROLE_PERMISSION`) — before the network-boundary change, this
  would have required updating **two** independent implementations
  (`@workspace/shared`'s TS matrix *and* apps/sync's own Go
  `EffectivePermission` mirror) and keeping their respective test suites
  in sync. Now, only `packages/shared/src/index.ts`'s `WorkspaceRole`
  enum/`DEFAULT_ROLE_PERMISSION`/`canPerform` need to change — apps/api's
  `PermissionsGuard`, `RolesGuard`, and `InternalSessionsService` all
  consume it directly, and apps/sync receives the *result* of that
  computation over the network on every connection (§2.7, §3.6, §3.7) with
  no local copy to fall out of sync. The only Go-side artifact that could
  need a matching update is `internal/rbac.Permission`'s three string
  constants (`"VIEW"|"COMMENT"|"EDIT"`) if a *new permission level* were
  ever added to `PermissionLevel` — an enum-value addition, not a
  rank/logic change — since that Go type is a plain string wire format for
  apps/api's JSON response, not an independent decision-making
  implementation.

---

## 8. Deployment

Full procedural detail lives in [`DEPLOYMENT.md`](DEPLOYMENT.md); this
section cross-checks it against the actual Dockerfiles/compose/k8s
manifests read directly for this reference and confirms accuracy.

### 8.1 Images

| App | Dockerfile | Build stages | Base (runtime) | Port |
|---|---|---|---|---|
| apps/api | `apps/api/Dockerfile` | `deps` → `build` (runs `prisma generate` + `nest build`) → `prod-deps` → `runtime` | `node:20-slim`, non-root `nestjs` user (uid/gid 1001) | 4000 |
| apps/sync | `apps/sync/Dockerfile` | `build` (`golang:1.23-alpine`, `CGO_ENABLED=0`) → runtime | `gcr.io/distroless/static-debian12:nonroot` | 1234 |
| apps/web | `apps/web/Dockerfile` | `build` (`node:20-alpine`, `pnpm run build` with `VITE_*` build args) → runtime | `nginx:1.27-alpine`, serves `dist/`, SPA fallback via `nginx.conf` | 80 |

apps/api's Dockerfile installs full workspace deps once (`deps` stage) to
build `@workspace/db`'s generated client and `@workspace/shared`, builds
with `nest build`, then does a **separate** `prod-deps` install
(`--prod`) for a lean runtime image — the runtime stage copies only
`node_modules` (prod), the generated Prisma client, `packages/shared`, and
`apps/api/dist`.

### 8.2 docker-compose

`infra/docker-compose.yml` — backing services only (Postgres 16-alpine on
host port 5433→5432, Redis 7-alpine on 6390→6379, optional LiveKit
`--dev` mode) — application processes run natively via pnpm/go for fast
iteration.

`infra/docker-compose.prod.yml` — additive, builds/runs all three app
images plus the backing services in one file set:
```sh
docker compose -f infra/docker-compose.yml -f infra/docker-compose.prod.yml up -d --build
```
Shares `INTERNAL_SERVICE_SECRET` between `api` and `sync` via a YAML anchor
(`x-shared-secrets`), confirming byte-identical values by construction in
this file (both services interpolate the same `${INTERNAL_SERVICE_SECRET}`
env var). `sync`'s compose service does **not** set
`SESSION_VERIFY_TIMEOUT_MS` explicitly — it falls back to `config.Load()`'s
3000ms default (§3.2). apps/api's compose healthcheck calls its own
`/health` via a Node one-liner; apps/sync has no compose-level healthcheck
defined even though its Dockerfile exposes `/health`.

### 8.3 Kubernetes (`infra/k8s/`)

Plain manifests (no Helm/Kustomize): `00-namespace`, `01-secrets`,
`02-postgres` (StatefulSet, for environments without a managed Postgres),
`03-redis`, `04-api` (Deployment+Service), `05-sync` (Deployment+Service),
`06-web`, `07-ingress`.

**`01-secrets.yaml`** — four `Secret` templates (all placeholder
`stringData`, meant to be replaced per the platform's real secret
mechanism): `workspace-jwt-secret` (`JWT_ACCESS_SECRET`, read by **api
only** — confirmed by its own comment: "apps/sync no longer verifies
tokens itself"), `workspace-internal-secret` (`INTERNAL_SERVICE_SECRET`,
read by **both** api and sync), `workspace-api-secret`
(`JWT_REFRESH_PEPPER`, api only), `workspace-postgres-secret` (DB
credentials + composed `DATABASE_URL`, both api and sync).

**`04-api.yaml`** — `replicas: 2`, stateless (safe behind a normal
non-sticky `Service`), env includes `INTERNAL_SERVICE_SECRET` from the
shared secret (comment: "Authenticates apps/sync's POST
/internal/sessions/verify calls"). Both `readinessProbe` and
`livenessProbe` hit `/health` — since `/health` always returns 200 by
design (§2.10), these probes only catch a wedged/dead process, not a
degraded dependency; the manifest's own comment says to alert on the body
separately.

**`05-sync.yaml`** — `replicas: 2`; `Service` uses
`sessionAffinity: ClientIP` with a 3-hour timeout, because each pod holds
per-room in-memory state and a fresh TCP connection is what session
affinity keys off (it does not migrate an established WebSocket — this
buys "new connections from the same client IP tend to land on the same
pod", not true connection stickiness across a reconnect from a different
IP). `INSTANCE_ID` is set from the pod name via the downward API
(`fieldRef: metadata.name`) rather than left to the Go default — a more
stable, human-readable choice than `<hostname>-<pid>` (though functionally
equivalent for redisbus's self-filtering purpose). Env includes
`API_BASE_URL: http://api:4000` (in-cluster service DNS) and
`INTERNAL_SERVICE_SECRET` from the same shared `Secret` as `04-api.yaml`.

### 8.4 Health checks summary

| App | Endpoint | Dependency-aware? | Status code behavior |
|---|---|---|---|
| apps/api | `GET /health` | Yes (Postgres + Redis via `Promise.all`) | Always 200; body `status: "ok"\|"degraded"` |
| apps/sync | `GET /health` | No | Always 200, static `{"status":"ok"}` |
| apps/web (nginx) | `GET /` | No | Any 200 response to `index.html` is sufficient |

### 8.5 Environment variable cross-reference

All three `.env.example` files were read directly (§2.14, §3.10, §4.9) and
their descriptions verified against the source that consumes them — no
staleness found. In particular, `INTERNAL_SERVICE_SECRET` /
`API_BASE_URL` / `SESSION_VERIFY_TIMEOUT_MS` are documented consistently
across `apps/sync/.env.example`, `apps/api/.env.example`,
`infra/docker-compose.prod.yml`, and `infra/k8s/{01-secrets,04-api,
05-sync}.yaml`.

---

## 9. Testing

Full run instructions live in [`TESTING.md`](TESTING.md); this section
documents exactly what each layer covers, read directly from the spec/test
files.

| Layer | Location | Needs infra? |
|---|---|---|
| Unit (TS) | `apps/api/src/**/*.spec.ts`, `apps/web/src/**/*.spec.ts` | No |
| Unit (Go) | `apps/sync/internal/**/*_test.go` | No |
| E2E (API) | `apps/api/test/app.e2e-spec.ts` | Yes (Postgres + Redis) |
| Real-client correctness | `bench/verify-sync.mjs` | Yes (Postgres + apps/sync running) |

### 9.1 apps/api unit specs

- **`common/rbac/rbac.util.spec.ts`** — the full `canPerform(role,
  required)` truth table (4 roles × 3 levels = 12 cases, table-driven),
  matching §5's documented matrix exactly, plus an "override" describe
  block proving `canPerform(GUEST, VIEW, COMMENT)` is `true` (an override
  can raise a guest above VIEW).
- **`auth/auth.service.spec.ts`** (205 lines) — token issuance/refresh/
  revocation coverage for `AuthService`.
- **`internal/internal-sessions.service.spec.ts`** — five cases, each
  matching a row of §2.7's failure-mode table exactly: (1) bad/expired JWT
  → `{valid:false, reason:"invalid_token"}`, no DB call made; (2) regular
  member token → `{valid:true, userId, role:MEMBER,
  permission:EDIT}` via `WorkspaceMember.findUnique`; (3) valid token, no
  membership row → `{valid:false, reason:"not_a_member"}`; (4) guest token,
  matching workspace → `{valid:true, role:GUEST, permission:<claim>}`, **no**
  DB call; (5) guest token, mismatched workspace →
  `{valid:false, reason:"workspace_mismatch"}`.

### 9.2 apps/web unit specs (vitest)

- **`features/document/undo-scope.spec.ts`** — collaborative-editor undo/
  redo scoping (`makeTrackedOrigins`/`makeUndoManager`, §4.4).
- **`features/spatial-audio/gain.spec.ts`** — `computeGain`'s near/far
  clamping and both falloff curves (§4.6).
- **`lib/auth-store.spec.ts`** — the signal-based auth store's persist/
  load/logout behavior (§4.2).

### 9.3 apps/sync unit tests (Go)

- **`internal/hub/room_test.go`** — uses a `fakePersister` (records
  `SaveSnapshot` calls without a real Postgres) to prove: rapid updates
  inside the debounce window coalesce into exactly one flush containing
  all blobs (`TestDebouncedFlushCoalescesRapidUpdates`); a clean room's
  `Flush` is a true no-op (`TestFlushIsNoOpWhenClean`); a last-client
  disconnect flushes immediately even with a 1-hour debounce configured
  (`TestDisconnectFlushesImmediatelyWithoutWaitingFullDebounce`);
  `snapshotBlobs()` returns a deep, mutation-safe copy
  (`TestSnapshotBlobsIsASafeCopy`).
- **`internal/lib0/lib0_test.go`** — varint/array wire-encoding round-trips.
- **`internal/protocol/protocol_test.go`** — sync/awareness message
  framing round-trips, including the `EncodeSyncStep1Empty` non-empty-byte
  subtlety (§3.4).
- **`internal/rbac/rbac_test.go`** — the pure `CanAccess`/`ReadOnly`
  ranking helpers only (§3.6) — no role→permission matrix testing here
  anymore, since that logic no longer lives in this package.
- **`internal/sessionsclient/client_test.go`** — four `httptest.Server`-backed
  cases matching §3.7 exactly: valid session (asserts the exact header and
  request body sent); a well-formed `{valid:false}` response is **not** a
  Go `error`; an unreachable server produces an `ErrUnreachable`-wrapped
  error; a non-200 status (e.g. wrong internal secret → 401) also produces
  an `ErrUnreachable`-wrapped error.

### 9.4 RBAC is resolved by apps/api alone (why apps/sync's RBAC tests shrank)

Before the network-boundary change, apps/sync hand-maintained its own Go
copy of the RBAC permission matrix, kept honest only by running the same
truth table as two independent test suites (a TS one in apps/api, a Go
mirror in apps/sync) and hoping neither drifted. That duplication is gone:
apps/sync now calls `POST /internal/sessions/verify` on every connection,
which reuses the exact same JWT verification and `@workspace/shared` RBAC
matrix GraphQL requests go through. There is now exactly one
implementation of "does role X get permission Y", tested in exactly one
place (`internal-sessions.service.spec.ts` + `rbac.util.spec.ts`).
`internal/rbac/rbac_test.go` in apps/sync now covers only the pure
`CanAccess`/`ReadOnly` ranking helpers that remain local to the Go relay
once it already has an effective permission in hand.

### 9.5 E2E (apps/api)

`apps/api/test/app.e2e-spec.ts` — real GraphQL requests against a real Nest
app instance with real Postgres and Redis, no mocks: resolver → guard
(`JwtAuthGuard`/`RolesGuard`/`PermissionsGuard`) → service → Prisma →
Postgres. Not run as part of `pnpm test` (slower, needs live infra). Each
run uses unique per-run emails so it's safe to run repeatedly against a
persistent dev database.

### 9.6 Real-client correctness (`bench/verify-sync.mjs`)

Since apps/sync never decodes/merges Yjs updates itself, the only way to
prove the wire protocol is byte-correct is to drive it with *real* Yjs
clients. `bench/verify-sync.mjs` (using real `yjs` + `y-websocket` npm
packages) checks, against a live relay: (1) two independent clients
converge on one client's insert; (2) concurrent edits from both converge
identically on both sides with the server never arbitrating/ordering/
locking; (3) after the write-behind debounce elapses, a `DocumentSnapshot`
row exists; (4) that persisted snapshot, gunzipped/unframed and replayed
through a fresh `Y.Doc`, reconstructs the exact same document text. This is
the layer that caught the `EncodeSyncStep1Empty` bug described in §3.4 — a
Go-only unit test asserting byte-equality with `[]byte{}` would have
passed while breaking every real client.

### 9.7 Benchmarks (not correctness tests)

`bench/sync-latency.mjs` (fan-out latency + sustained throughput over real
WebSocket clients), `bench/sync-scale.mjs` (connection-scale smoke test,
`NUM_DOCS × CLIENTS_PER_DOC` real clients), `bench/api-throughput.mjs`
(GraphQL request throughput against real HTTP, authenticated as a seeded
user). Perf instrumentation, not pass/fail gates — see
[`BENCHMARKS.md`](BENCHMARKS.md) for full env var/usage detail.

### 9.8 Running everything

```sh
pnpm build                                  # apps/api + apps/web build; apps/sync via `go build ./...`
pnpm dev:infra                              # Postgres + Redis (+ LiveKit) via infra/docker-compose.yml
pnpm prisma:migrate
pnpm test                                   # unit (TS): apps/api (jest) + apps/web (vitest)
(cd apps/sync && go test ./...)             # unit (Go)
pnpm test:e2e                               # e2e (needs infra up)
pnpm --filter @workspace/bench run verify   # real-client correctness (needs infra + apps/sync running)
```

---

## Verification note

This reference was produced by reading every file under
`apps/api/src`, `apps/sync/internal` + `apps/sync/cmd`,
`apps/web/src`, `packages/shared/src`, and
`packages/db/prisma/schema.prisma` directly (not inferred), plus every
`.env.example`, Dockerfile, `docker-compose*.yml`, and `infra/k8s/*.yaml`.
The pre-existing `docs/{ARCHITECTURE,DEPLOYMENT,TESTING,BENCHMARKS}.md`
were cross-checked against this reading specifically on the sync↔api
network-boundary change (`apps/api/src/internal/*`,
`apps/sync/internal/sessionsclient`, `apps/sync/internal/config`,
`apps/sync/cmd/sync/main.go`, and the removal of
`apps/sync/internal/auth`) and found **accurate, not stale** — those four
documents already correctly describe `POST /internal/sessions/verify`, the
`InternalServiceGuard`/`x-internal-secret` shared-secret auth, the
fail-closed behavior on unreachable/erroring apps/api, and the absence of
any local JWT verification in apps/sync. No corrections were needed to
those four files; this document adds the file/function-level depth they
intentionally omit.
