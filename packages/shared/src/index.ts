/**
 * @workspace/shared
 *
 * Cross-cutting types and pure helpers shared between apps (api, sync, web, ...).
 * These enums intentionally mirror packages/db/prisma/schema.prisma 1:1 so that
 * Prisma-generated types and hand-written TS types never drift apart. If you
 * change the Prisma schema's WorkspaceRole / PermissionLevel enums, update
 * these too.
 *
 * The RBAC matrix (canPerform) is the SINGLE SOURCE OF TRUTH for "does role X
 * satisfy required permission Y" decisions. Both apps/api (RolesGuard /
 * PermissionsGuard) and apps/sync (CRDT write gating) should import this
 * rather than re-implementing the matrix, so authorization behavior stays
 * consistent across the REST/GraphQL API and the realtime sync engine.
 */

// ---------------------------------------------------------------------------
// Enums (mirrors prisma schema)
// ---------------------------------------------------------------------------

/** Workspace-level role, ordered from highest to lowest privilege. */
export enum WorkspaceRole {
  OWNER = 'OWNER',
  ADMIN = 'ADMIN',
  MEMBER = 'MEMBER',
  GUEST = 'GUEST',
}

/** Resource-level (channel/document) permission, ordered lowest to highest. */
export enum PermissionLevel {
  VIEW = 'VIEW',
  COMMENT = 'COMMENT',
  EDIT = 'EDIT',
}

export enum ChannelKind {
  CHANNEL = 'CHANNEL',
  DM = 'DM',
}

export enum DocumentKind {
  RICH_TEXT = 'RICH_TEXT',
  WHITEBOARD = 'WHITEBOARD',
}

export enum TaskStatus {
  TODO = 'TODO',
  IN_PROGRESS = 'IN_PROGRESS',
  DONE = 'DONE',
  CANCELLED = 'CANCELLED',
}

export enum GuestLinkPermission {
  VIEW = 'VIEW',
  COMMENT = 'COMMENT',
  EDIT = 'EDIT',
}

// ---------------------------------------------------------------------------
// JWT payload shapes
// ---------------------------------------------------------------------------

/** Standard authenticated-user access token payload. */
export interface JwtPayload {
  /** Subject - the User.id */
  sub: string;
  email: string;
  /** Standard JWT claims added by jsonwebtoken/passport-jwt at sign/verify time. */
  iat?: number;
  exp?: number;
}

/**
 * Scoped guest access token payload, minted from a resolved GuestLink.
 * Guests never get a refresh token - the access token itself is short-lived
 * and re-derived from the guest link if it expires.
 */
export interface GuestJwtPayload {
  sub: string; // synthetic guest id (e.g. `guest:<guestLinkId>`)
  guest: true;
  workspaceId: string;
  permission: GuestLinkPermission;
  iat?: number;
  exp?: number;
}

export type AnyJwtPayload = JwtPayload | GuestJwtPayload;

export function isGuestJwtPayload(payload: AnyJwtPayload): payload is GuestJwtPayload {
  return (payload as GuestJwtPayload).guest === true;
}

// ---------------------------------------------------------------------------
// RBAC matrix
// ---------------------------------------------------------------------------

/**
 * Numeric rank for each WorkspaceRole. Higher number = more privilege.
 * Used for ">=" style comparisons, e.g. "must be ADMIN or higher".
 */
export const WORKSPACE_ROLE_RANK: Record<WorkspaceRole, number> = {
  [WorkspaceRole.GUEST]: 0,
  [WorkspaceRole.MEMBER]: 1,
  [WorkspaceRole.ADMIN]: 2,
  [WorkspaceRole.OWNER]: 3,
};

/**
 * Numeric rank for each PermissionLevel. Higher number = more capability.
 */
export const PERMISSION_LEVEL_RANK: Record<PermissionLevel, number> = {
  [PermissionLevel.VIEW]: 0,
  [PermissionLevel.COMMENT]: 1,
  [PermissionLevel.EDIT]: 2,
};

/**
 * Returns true if `role` outranks or equals `required` (workspace role
 * hierarchy). e.g. hasWorkspaceRoleAtLeast(ADMIN, MEMBER) === true.
 */
export function hasWorkspaceRoleAtLeast(role: WorkspaceRole, required: WorkspaceRole): boolean {
  return WORKSPACE_ROLE_RANK[role] >= WORKSPACE_ROLE_RANK[required];
}

/**
 * The default resource-level permission matrix, keyed by WorkspaceRole.
 * This is the "default ceiling" a role gets on a channel/document absent any
 * more specific override (e.g. a channel-level ACL row, or a GuestLink's own
 * `permission` field which is authoritative for guests).
 *
 *   OWNER  -> always EDIT (full control of everything in the workspace)
 *   ADMIN  -> always EDIT (workspace administration implies content control)
 *   MEMBER -> EDIT by default (regular collaborators can read/comment/write)
 *   GUEST  -> VIEW by default (must be elevated per-resource via GuestLink.permission)
 */
export const DEFAULT_ROLE_PERMISSION: Record<WorkspaceRole, PermissionLevel> = {
  [WorkspaceRole.OWNER]: PermissionLevel.EDIT,
  [WorkspaceRole.ADMIN]: PermissionLevel.EDIT,
  [WorkspaceRole.MEMBER]: PermissionLevel.EDIT,
  [WorkspaceRole.GUEST]: PermissionLevel.VIEW,
};

/**
 * canPerform(role, required, override?)
 *
 * Pure function answering: "given a caller's WorkspaceRole (and an optional
 * resource-specific permission override, e.g. a GuestLink.permission or a
 * per-channel ACL entry), can they perform an action that requires
 * `required` PermissionLevel?"
 *
 * Truth table (no override):
 *   Role \ Required | VIEW | COMMENT | EDIT
 *   OWNER           | Y    | Y       | Y
 *   ADMIN           | Y    | Y       | Y
 *   MEMBER          | Y    | Y       | Y
 *   GUEST           | Y    | N       | N
 *
 * With an override (e.g. GUEST granted COMMENT via GuestLink), the override
 * replaces the role's default ceiling entirely - it does not merely raise it,
 * since overrides are meant to be authoritative for that specific resource.
 */
export function canPerform(
  role: WorkspaceRole,
  required: PermissionLevel,
  override?: PermissionLevel,
): boolean {
  const effective = override ?? DEFAULT_ROLE_PERMISSION[role];
  return PERMISSION_LEVEL_RANK[effective] >= PERMISSION_LEVEL_RANK[required];
}

// ---------------------------------------------------------------------------
// Misc shared DTO-ish helpers
// ---------------------------------------------------------------------------

/** Generic cursor-paginated response envelope. */
export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}
