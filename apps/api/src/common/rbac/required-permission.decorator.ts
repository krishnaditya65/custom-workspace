import { SetMetadata } from '@nestjs/common';
import { PermissionLevel } from '@workspace/shared';

export const REQUIRED_PERMISSION_KEY = 'rbac:requiredPermission';

/**
 * Marks a resolver/handler as requiring at least the given resource-level
 * PermissionLevel (VIEW < COMMENT < EDIT), checked by PermissionsGuard
 * against `canPerform()` from @workspace/shared. See PermissionsGuard for
 * how the effective permission is resolved (role default vs. GuestLink
 * override).
 */
export const RequiredPermission = (level: PermissionLevel) =>
  SetMetadata(REQUIRED_PERMISSION_KEY, level);
