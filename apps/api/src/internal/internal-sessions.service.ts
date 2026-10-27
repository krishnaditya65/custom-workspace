import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import {
  AnyJwtPayload,
  DEFAULT_ROLE_PERMISSION,
  PermissionLevel,
  WorkspaceRole,
  isGuestJwtPayload,
} from '@workspace/shared';
import { PrismaService } from '../prisma/prisma.service';
import { SessionVerifyDto } from './dto/session-verify.dto';
import { SessionVerifyResult } from './dto/session-verify-result.dto';

/**
 * InternalSessionsService
 * ========================
 * Backs POST /internal/sessions/verify - the single source of truth apps/sync
 * calls on every WebSocket connection instead of decoding the JWT and
 * recomputing the RBAC ceiling itself.
 *
 * Deliberately reuses the SAME building blocks the rest of apps/api uses for
 * auth, rather than reimplementing them:
 *   - JwtService, configured with the same JWT_ACCESS_SECRET as
 *     JwtStrategy/AuthService, for verification.
 *   - `@workspace/shared`'s isGuestJwtPayload / DEFAULT_ROLE_PERMISSION -
 *     the exact same matrix PermissionsGuard uses for GraphQL requests.
 *   - PrismaService.workspaceMember, the same table RolesGuard and
 *     PermissionsGuard query.
 */
@Injectable()
export class InternalSessionsService {
  private readonly logger = new Logger(InternalSessionsService.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async verify({ token, workspaceId }: SessionVerifyDto): Promise<SessionVerifyResult> {
    let payload: AnyJwtPayload;
    try {
      payload = await this.jwt.verifyAsync<AnyJwtPayload>(token, {
        secret: this.config.get<string>('JWT_ACCESS_SECRET', 'change-me-access-secret'),
        algorithms: ['HS256'],
      });
    } catch (err) {
      this.logger.debug(`session verify: token rejected (${(err as Error).message})`);
      return { valid: false, reason: 'invalid_token' };
    }

    if (isGuestJwtPayload(payload)) {
      // A guest link is minted scoped to exactly one workspace - a token
      // valid for workspace A must never resolve access for workspace B.
      if (payload.workspaceId !== workspaceId) {
        return { valid: false, reason: 'workspace_mismatch' };
      }
      return {
        valid: true,
        userId: payload.sub,
        role: WorkspaceRole.GUEST,
        // Cast: GuestLinkPermission and PermissionLevel are distinct enum
        // types with identical string members by design (see
        // packages/shared/src/index.ts) - same pattern as the WorkspaceRole
        // cast below and in roles.guard.ts.
        permission: payload.permission as unknown as PermissionLevel,
      };
    }

    const membership = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: payload.sub } },
    });
    if (!membership) {
      return { valid: false, reason: 'not_a_member' };
    }

    // Cast: Prisma's generated WorkspaceRole enum is structurally identical
    // to @workspace/shared's but a nominally distinct TS type (see
    // roles.guard.ts for the same cast).
    const role = membership.role as unknown as WorkspaceRole;
    return {
      valid: true,
      userId: payload.sub,
      role,
      permission: DEFAULT_ROLE_PERMISSION[role],
    };
  }
}
