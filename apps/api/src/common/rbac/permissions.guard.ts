import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionLevel, WorkspaceRole, canPerform } from '@workspace/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { REQUIRED_PERMISSION_KEY } from './required-permission.decorator';
import { GqlExecutionContext } from '@nestjs/graphql';
import { extractWorkspaceId, getGqlRequest } from './gql-context.util';

/**
 * PermissionsGuard
 * ================
 * Enforces `@RequiredPermission(level)` metadata using the shared
 * `canPerform()` matrix from @workspace/shared:
 *
 *   OWNER / ADMIN  -> always EDIT (full control)
 *   MEMBER         -> EDIT by default (no per-channel ACL table exists yet in
 *                      the schema, so MEMBER's ceiling is not currently
 *                      overridable per-resource; the override plumbing below
 *                      is still exercised for GUEST via GuestLink.permission,
 *                      and is where a future per-channel ACL would plug in)
 *   GUEST          -> uses GuestLink.permission as an authoritative override
 *                      (defaults to VIEW if somehow absent)
 *
 * Must run after JwtAuthGuard. Resolves the caller's effective role
 * (workspace membership, or GUEST + permission claim from a guest JWT), then
 * asks `canPerform(role, required, override)` whether that's sufficient.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<PermissionLevel | undefined>(
      REQUIRED_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!required) {
      return true;
    }

    const req = getGqlRequest(context);
    const user = req?.user;
    if (!user) {
      throw new ForbiddenException('Authentication required');
    }

    const workspaceId = await this.resolveWorkspaceId(context);
    if (!workspaceId) {
      throw new ForbiddenException(
        'PermissionsGuard could not resolve a workspaceId from the request arguments',
      );
    }

    // Guest path: role is fixed at GUEST, permission comes from their signed
    // guest JWT claim (itself derived from GuestLink.permission at mint
    // time), which acts as the authoritative override. We also confirm the
    // guest's token was scoped to *this* workspace - a guest link minted for
    // workspace A must never grant access to a channel in workspace B.
    if (user.guest) {
      if (user.workspaceId !== workspaceId) {
        throw new ForbiddenException('Guest link is not scoped to this workspace');
      }
      const allowed = canPerform(
        WorkspaceRole.GUEST,
        required,
        user.permission as PermissionLevel,
      );
      if (!allowed) {
        throw new ForbiddenException(`Guest permission does not satisfy required level: ${required}`);
      }
      return true;
    }

    const membership =
      req.workspaceMembership ??
      (await this.prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: user.userId } },
      }));

    if (!membership) {
      throw new ForbiddenException('Not a member of this workspace');
    }

    // Cast: see roles.guard.ts for why this must route through `unknown`.
    const allowed = canPerform(membership.role as unknown as WorkspaceRole, required);
    if (!allowed) {
      throw new ForbiddenException(`Insufficient permission - requires at least ${required}`);
    }

    return true;
  }

  /**
   * Resolves the workspaceId that this action is scoped to. Tries, in
   * order: a flat `workspaceId` arg, a nested `input.workspaceId`, then -
   * because many channel/message mutations only carry a `channelId` or
   * `input.channelId` - looks up the channel's parent workspace. Returns
   * undefined if none of these resolve, which callers treat as "deny".
   */
  private async resolveWorkspaceId(context: ExecutionContext): Promise<string | undefined> {
    const direct = extractWorkspaceId(context);
    if (direct) return direct;

    const gqlContext = GqlExecutionContext.create(context);
    const args = gqlContext.getArgs<Record<string, unknown>>();
    const input = args.input as Record<string, unknown> | undefined;
    const channelId =
      (typeof args.channelId === 'string' && args.channelId) ||
      (input && typeof input.channelId === 'string' && input.channelId) ||
      undefined;

    if (!channelId) return undefined;

    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId },
      select: { workspaceId: true },
    });
    return channel?.workspaceId;
  }
}
