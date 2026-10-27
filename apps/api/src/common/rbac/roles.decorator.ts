import { SetMetadata } from '@nestjs/common';
import { WorkspaceRole } from '@workspace/shared';

export const ROLES_KEY = 'rbac:roles';

/**
 * Marks a resolver/handler as requiring the caller's WorkspaceMember.role to
 * be one of the given roles (checked by RolesGuard). Roles are NOT
 * hierarchical here by default in terms of *which* roles are listed - list
 * every role that should pass, e.g. `@Roles(WorkspaceRole.OWNER, WorkspaceRole.ADMIN)`
 * for "ADMIN or above".
 *
 * The guard extracts `workspaceId` from GraphQL args, supporting either a
 * flat `workspaceId` arg or a nested `input.workspaceId`.
 */
export const Roles = (...roles: WorkspaceRole[]) => SetMetadata(ROLES_KEY, roles);
