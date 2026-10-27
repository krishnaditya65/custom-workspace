import { PermissionLevel, WorkspaceRole } from '@workspace/shared';

/** Response shape for POST /internal/sessions/verify. */
export interface SessionVerifyResult {
  valid: boolean;
  userId?: string;
  /** GUEST for a guest-link token, or the caller's WorkspaceMember.role. */
  role?: WorkspaceRole;
  /** Effective ceiling permission for this token against `workspaceId`. */
  permission?: PermissionLevel;
  /** Present only when `valid` is false - a short machine-checkable reason. */
  reason?: 'invalid_token' | 'workspace_mismatch' | 'not_a_member';
}
