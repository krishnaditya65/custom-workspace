import { IsString, MinLength } from 'class-validator';

/**
 * Body for POST /internal/sessions/verify. `workspaceId` is the workspace the
 * caller (apps/sync) needs the token's effective permission resolved
 * against - for a regular user token this drives the WorkspaceMember lookup,
 * for a guest token it must match the workspace the guest link was scoped to.
 */
export class SessionVerifyDto {
  @IsString()
  @MinLength(1)
  token!: string;

  @IsString()
  @MinLength(1)
  workspaceId!: string;
}
