# custom-workspace — Detailed Test Reference

Audience: LLM/QA agents. Nothing executed. **[src]** = read from `apps/`, `packages/db`. Scripts (convergence model checker, isolation matrix, durability, chat order): `03-TEST-SCRIPTS.md`.
Format: ID · Setup · Action · Expected · Priority · Tags.

---------------------------------------------------------------------------------------------------
## 1. System facts [src]
| Area | Fact |
|---|---|
| API (NestJS GraphQL :4000) | Queries `me, user, workspace, myWorkspaces, channels, messages, tasks, events`; Mutations `register, login, refreshToken, logout, createWorkspace, inviteMember, createChannel, archiveChannel, sendMessage, editMessage, deleteMessage, createTask, assignTask, updateTaskStatus, createEvent, createGuestLink, resolveGuestLink`; subscriptions for messages; REST `health`, `internal/sessions` |
| Inputs | register `{email @IsEmail, password @MinLength(8) "Password must be at least 8 characters", displayName}`; login `{email, password}`; refresh `{refreshToken}`; workspace `{name}` (slug generated, unique); invite `{workspaceId, email @IsEmail, role @IsEnum(WorkspaceRole)}`; channel `{workspaceId, name, isPrivate? (default false), parentId?}`; message send `{channelId, body, threadRootId?}`, edit `{messageId, body}`; task `{workspaceId, title, description?, dueAt? @IsDateString, assigneeId?}`; event `{workspaceId, title, description?, startsAt @IsDateString, endsAt @IsDateString}`; guest link `{workspaceId, permission @IsEnum(GuestLinkPermission), expiresAt? @IsDateString}` |
| Outputs | AuthPayload `{accessToken, refreshToken, user{id,email,displayName,avatarUrl,createdAt}}`; Message `{id, channelId, author, body, threadRootId, replyCount, editedAt, deletedAt, createdAt}`; page `{items, nextCursor, hasMore}`; Channel `{id, workspaceId, name, kind, isPrivate, parentId, isArchived, children}`; Task `{…, status, creatorId}`; ResolvedGuestLink `{workspace, permission, accessToken}` |
| Enums | WorkspaceRole `OWNER, ADMIN, MEMBER, GUEST`; PermissionLevel `VIEW, COMMENT, EDIT`; ChannelKind `CHANNEL, DM`; DocumentKind `RICH_TEXT, WHITEBOARD`; TaskStatus `TODO, IN_PROGRESS, DONE, CANCELLED`; GuestLinkPermission `VIEW, COMMENT, EDIT` |
| Unique constraints | `User.email`, `RefreshToken.tokenHash`, `Workspace.slug`, `WorkspaceMember(workspaceId,userId)`, `GuestLink.token` |
| Tokens | access `15m` (`JWT_ACCESS_SECRET`), guest token `30m`, refresh hashed with `JWT_REFRESH_PEPPER` |
| Throttler | `limit: 100` per `ttl: 60_000` ms |
| Internal | `/internal/*` guard: header `x-internal-secret` vs `INTERNAL_SERVICE_SECRET` with `timingSafeEqual`; **unconfigured → 401 "INTERNAL_SERVICE_SECRET is not configured"** (fails closed) |
| Sync (Go :1234) | env `DATABASE_URL`, `REDIS_URL`, `API_BASE_URL`, `INTERNAL_SERVICE_SECRET`, `INSTANCE_ID`, `SESSION_VERIFY_TIMEOUT_MS`, `SNAPSHOT_DEBOUNCE_MS`; WS read limit **10 MB**; `CheckOrigin` **always true**; client `ReadOnly = !CanAccess(perm, COMMENT)` → **only VIEW is read-only; COMMENT can send document updates**; timers seen: 5 ms, 50 ms, 80 ms, 2 s, 3 s, 5 s, 10 s, 60 s (ping/pong, debounce, verify timeouts — map in code) |
| Models | User, RefreshToken, Workspace, WorkspaceMember, Channel, Message, Attachment, Document, DocumentSnapshot, Task, CalendarEvent, GuestLink |
| Infra | Postgres :5433, Redis :6390, LiveKit :7880/:7881; prod compose api :4000, sync :1234, web :8080 |

---------------------------------------------------------------------------------------------------
## 2. Environments & data
* **E-DEV**: infra compose + api + one sync + web. **E-MULTI**: 3 sync instances (distinct `INSTANCE_ID`) + 2 API replicas behind proxy. **E-PROD**: `docker-compose.prod.yml`.
* Users: owner O, admin A, member M, guest G (role GUEST), outsider X (other workspace W2). Guest links: VIEW, COMMENT, EDIT, expired, revoked.
* Docs: RICH_TEXT and WHITEBOARD per workspace; recorded Yjs update corpora from real editing sessions.

---------------------------------------------------------------------------------------------------
## 3. Smoke
CW-SMK-001 api/sync health; Prisma migration applied · 002 register → login → `me` · 003 createWorkspace → createChannel → sendMessage → messages · 004 two Yjs clients converge (`bench verify-sync`) · 005 web login & editor render · 006 message subscription delivers.

---------------------------------------------------------------------------------------------------
## 4. Auth
| ID | Action | Expected | Pri |
|---|---|---|---|
| CW-AUTH-001 | register valid | AuthPayload; user row; refresh token hash stored (not plaintext) | P0 |
| CW-AUTH-002 | password 7 chars | "Password must be at least 8 characters" | P1 |
| CW-AUTH-003 | invalid email; duplicate email (case variants) | validation error / conflict (no 500 on unique) | P1 |
| CW-AUTH-004 | login wrong password / unknown email | identical error | P0 |
| CW-AUTH-005 | access token expiry 15 min boundary | rejected after | P1 |
| CW-AUTH-006 | refreshToken rotation; reuse old | new pair / reuse rejected | P0 |
| CW-AUTH-007 | 50 parallel refresh with same token | ≤ 1 success | P0 |
| CW-AUTH-008 | logout → refresh invalid; access token until expiry (stateless) — document | P1 |
| CW-AUTH-009 | throttler: 101 requests in 60 s from one client | 101st throttled; GraphQL batching/aliases counted per operation (verify) | P1 |
| CW-AUTH-010 | `me` without/with forged/expired token | unauthorized | P0 |
| CW-AUTH-011 | `user(id)` of non-colleague | no email/PII | P1 |

## 5. Workspaces & membership
CW-WS-001 createWorkspace → creator OWNER; slug unique (same name twice → distinct slugs) · 002 `myWorkspaces` only member workspaces · 003 `workspace(id)` by outsider → forbidden · 004 inviteMember by OWNER/ADMIN ok; MEMBER/GUEST forbidden; invite OWNER role by ADMIN (escalation) → forbidden; invite existing member → conflict (unique workspaceId,userId) · 005 invalid email/role → validation · 006 removed member loses API + sync access (sync within session-verify window).

## 6. Channels & messages
| ID | Action | Expected | Pri |
|---|---|---|---|
| CW-CH-001 | createChannel public/private, with `parentId` (nesting) | ok; parent in same workspace; cycles impossible | P1 |
| CW-CH-002 | private channel visibility for non-members | hidden from `channels`, messages forbidden | P0 |
| CW-CH-003 | archiveChannel (admin/owner); send to archived | archived=true; send rejected | P1 |
| CW-MSG-001 | sendMessage; threadRootId reply → `replyCount` increments | P0 |
| CW-MSG-002 | threadRootId from other channel / nonexistent | rejected | P1 |
| CW-MSG-003 | editMessage by author → `editedAt`; by others → forbidden (admin?) | P0 |
| CW-MSG-004 | deleteMessage → `deletedAt` set (soft), body hidden; delete twice | idempotent | P1 |
| CW-MSG-005 | body empty / whitespace / 100 KB / 10 MB / HTML-script | validated; rendered escaped in web | P1 |
| CW-MSG-006 | pagination `{items, nextCursor, hasMore}` with concurrent inserts; bogus cursor | no dup/miss; error | P1 |
| CW-MSG-007 | subscription: non-member / other workspace / private channel | no events | P0 |
| CW-MSG-008 | 300 concurrent sends; subscribers on 2 API replicas | same order as DB, no loss/dup | P0 |

## 7. Tasks & calendar
CW-TSK-001 createTask defaults TODO; creatorId = caller · 002 assignTask to member/guest/outsider/removed member · 003 updateTaskStatus all transitions TODO↔IN_PROGRESS→DONE/CANCELLED; illegal transitions (e.g. CANCELLED→IN_PROGRESS) per rules · 004 dueAt invalid string / past · 005 concurrent status updates → legal final state · CW-CAL-001 createEvent valid; `endsAt < startsAt`, equal, zero-length, 10-year span, invalid dates, DST instants, far future · 002 `events` range query boundaries inclusive/exclusive · 003 cross-workspace isolation.

## 8. Guest links
| ID | Action | Expected | Pri |
|---|---|---|---|
| CW-GL-001 | createGuestLink VIEW/COMMENT/EDIT by OWNER/ADMIN; by MEMBER/GUEST | ok / forbidden (verify) | P0 |
| CW-GL-002 | resolveGuestLink → `{workspace, permission, accessToken}` (30 min) | scoped token | P0 |
| CW-GL-003 | expired (`expiresAt` past), unknown, tampered token | rejected | P0 |
| CW-GL-004 | guest token used on non-scoped resources (other channels, tasks, member list) | forbidden | P0 |
| CW-GL-005 | guest token after 30 min | rejected | P1 |
| CW-GL-006 | token entropy (≥128-bit random), unique constraint | P1 |
| CW-GL-007 | `expiresAt` invalid / beyond policy max | validated | P2 |

## 9. Realtime documents (sync)
| ID | Action | Expected | Pri |
|---|---|---|---|
| CW-SYNC-001 | 2–10 clients edit RICH_TEXT concurrently | converge (identical state vectors) | P0 |
| CW-SYNC-002 | WHITEBOARD documents same | converge | P1 |
| CW-SYNC-003 | handshake without token / invalid / expired / revoked session | connection closed, no data | P0 |
| CW-SYNC-004 | session verification via api `internal/sessions` (secret, `SESSION_VERIFY_TIMEOUT_MS`); api slow/down | fail closed within timeout | P0 |
| CW-SYNC-005 | VIEW permission client sends update | rejected (ReadOnly) | P0 |
| CW-SYNC-006 | **COMMENT permission client sends content update** | currently accepted (ReadOnly only below COMMENT) → document/fix: commenters should not edit body | P1 |
| CW-SYNC-007 | EDIT permission | accepted | P0 |
| CW-SYNC-008 | doc of other workspace by name | rejected | P0 |
| CW-SYNC-009 | frame > 10 MB | connection closed by read limit; server healthy | P1 |
| CW-SYNC-010 | malformed frames (truncated varints, unknown message types, random bytes) | closed; server healthy; doc state intact | P0 |
| CW-SYNC-011 | Origin header from unexpected site | accepted (`CheckOrigin` true) — relies on upstream proxy; document | P2 |
| CW-SYNC-012 | awareness (cursor/presence) updates propagate; stale presence removed on disconnect | P2 |
| CW-SYNC-013 | snapshot debounce: edit → wait > `SNAPSHOT_DEBOUNCE_MS` → `DocumentSnapshot` row; restart → identical content | P0 |
| CW-SYNC-014 | continuous typing 10 min → snapshot still persisted (max-wait) | P1 |
| CW-SYNC-015 | multi-instance: clients on 3 instances converge via Redis; no echo loop | P0 |
| CW-SYNC-016 | late joiner receives full state | P0 |
| CW-SYNC-017 | offline client (IndexedDB) edits, reconnects | merged, no loss/dup | P0 |
| CW-SYNC-018 | compatibility with pinned `yjs`, `@hocuspocus/provider`, `y-websocket` versions | protocol works | P0 |

## 10. Spatial audio (LiveKit)
CW-AUD-001 room token scoped to workspace room & identity; expiry · 002 non-member token request rejected · 003 spatial gain function: distance 0 → 1, monotonic decreasing, clamped [0,1], NaN/negative inputs safe · 004 LiveKit down → rest of app unaffected.

## 11. Authorization matrix
For each role {OWNER, ADMIN, MEMBER, GUEST, guest-link VIEW/COMMENT/EDIT, outsider} × each query/mutation and sync operation: expected allow/deny table (generate from resolvers list §1) — P0 for every outsider and guest cell. Mass assignment: extra input fields rejected/stripped by ValidationPipe.

## 12. E2E (Playwright multi-context)
CW-E2E-001 two users sign up → workspace → invite → chat → co-edit same paragraph → identical → reload persisted · 002 offline edit merge then server restart · 003 guest link read-only live view; revoke → access lost · 004 role downgrade mid-edit · 005 tasks + calendar · 006 audio room · 007 logout in one tab ends other tabs' sessions.

## 13. Concurrency / consistency
CW-RACE-001 50 clients random edits + reconnects (20 seeds) → convergence · 002 across 3 instances · 003 concurrent snapshot writers never regress persisted state · 004 join during snapshot · 005 disconnect storm (no goroutine leak) · 006 last client leaves within debounce → snapshot flushed · 007 `go test -race` · 008 chat order · 009 register/refresh races · 010 task updates · 011 member removal vs edits · 012 archive vs send · 013 guest-link resolves · CW-CON-001 snapshot == clients · 002 DB order == subscription order · 003 logout closes sync session within T · 004 TS RBAC == Go RBAC decision table · 005 read-your-writes across API replicas.

## 14. Durability
CW-DUR-001 edit → wait debounce → kill sync → restored · 002 kill inside debounce window → loss bounded; surviving clients heal · 003 SIGTERM flushes · 004 Postgres crash after commit · 005 Redis restart → no doc loss · 006 corrupt snapshot → doc refuses to load, not overwritten empty · 007 backup/restore.

## 15. Load / stress / spike / soak / scalability
Use `bench/` (`verify`, `bench:sync`, `bench:sync-scale`, `bench:api`, `bench:all`) vs `docs/BENCHMARKS.md`: CW-LOAD-001 200 docs × 5 clients propagation p99 < 150 ms · 002 1k→10k connections · 003 GraphQL 500 rps p99 < 200 ms (throttler raised) · 004 hot doc 300 editors · 005 10k subscribers · CW-STR-001..004 connection ceiling, slow consumers, 50 MB doc, update flood · CW-SPK-001 5k reconnects · CW-SOAK-001 24 h · CW-SCAL-001..002 sync & API replicas.

## 16. Chaos
CW-CHA-001 kill sync instance mid-edit · 002 Redis outage → reconverge after · 003 bus loss/dup/reorder · 004 Postgres outage → snapshots retried · 005 api down → new sync connections fail closed · 006 api slow · 007 client network flapping · 008 paused instance must not overwrite newer snapshot · 009 rolling deploy · 010 clock skew · 011 LiveKit down · 012 disk full · 013 LB moves WS to another instance.

## 17. Known findings from source
1. COMMENT-level principals can modify document content via sync (ReadOnly only for VIEW). 2. WebSocket `CheckOrigin` always true (relies on proxy). 3. Access tokens stateless for 15 min after logout. 4. Throttler 100/60 s may be per-request not per-operation.

## 18. Exit criteria
Convergence over 20 seeds incl. chaos; authorization matrix 100 %; DUR-003 zero loss; protocol compatibility; benchmarks within 10 %; soak flat.
