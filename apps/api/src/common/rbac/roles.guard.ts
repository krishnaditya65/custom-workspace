import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { WorkspaceRole } from '@workspace/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { ROLES_KEY } from './roles.decorator';
import { extractWorkspaceId, getGqlRequest } from './gql-context.util';

/**
 * RolesGuard
 * ==========
 * Enforces `@Roles(...)` metadata: the caller must have a WorkspaceMember
 * row for the resolved `workspaceId` whose `role` is included in the
 * decorator's allowed-role list.
 *
 * This guard is workspace-*role* based (OWNER/ADMIN/MEMBER/GUEST membership
 * tier), distinct from PermissionsGuard which is about resource-level
 * VIEW/COMMENT/EDIT capability. Use RolesGuard for "must be a workspace
 * admin to invite members"-style checks; use PermissionsGuard for "must be
 * able to edit this channel/document"-style checks.
 *
 * Must run after JwtAuthGuard (relies on `req.user` being populated).
 * Guest tokens (no WorkspaceMember row) always fail RolesGuard checks, by
 * design - guests are never OWNER/ADMIN/MEMBER.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const allowedRoles = this.reflector.getAllAndOverride<WorkspaceRole[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    // No @Roles(...) decorator present -> nothing to enforce here.
    if (!allowedRoles || allowedRoles.length === 0) {
      return true;
    }

    const req = getGqlRequest(context);
    const user = req?.user;
    if (!user?.userId) {
      throw new ForbiddenException('Authentication required');
    }

    // Guests never carry a WorkspaceMember role - reject fast.
    if (user.guest) {
      throw new ForbiddenException('Guests cannot perform this action');
    }

    const workspaceId = extractWorkspaceId(context);
    if (!workspaceId) {
      throw new ForbiddenException(
        'RolesGuard could not resolve a workspaceId from the request arguments',
      );
    }

    const membership = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: user.userId } },
    });

    // Cast: Prisma's generated WorkspaceRole enum is structurally identical
    // to @workspace/shared's but a nominally distinct TS type, so it must be
    // routed through `unknown` rather than a direct `as`.
    if (!membership || !allowedRoles.includes(membership.role as unknown as WorkspaceRole)) {
      throw new ForbiddenException(
        `Requires one of roles [${allowedRoles.join(', ')}] in this workspace`,
      );
    }

    // Stash membership on the request so downstream resolvers/guards don't
    // need to re-query it.
    req.workspaceMembership = membership;
    return true;
  }
}
