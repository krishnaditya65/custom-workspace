import { GoneException, Injectable, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import { GuestLinkPermission } from '@workspace/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';

@Injectable()
export class GuestLinksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
  ) {}

  async createGuestLink(
    createdById: string,
    workspaceId: string,
    permission: GuestLinkPermission,
    expiresAt?: string,
  ) {
    const token = crypto.randomBytes(24).toString('base64url');
    return this.prisma.guestLink.create({
      data: {
        workspaceId,
        token,
        // Cast: Prisma's generated GuestLinkPermission enum is structurally
        // identical to @workspace/shared's but a nominally distinct TS type.
        permission: permission as any,
        createdById,
        expiresAt: expiresAt ? new Date(expiresAt) : undefined,
      },
    });
  }

  /**
   * Unauthenticated flow: a guest presents the opaque link token, we
   * validate it and mint a short-lived scoped JWT (see
   * AuthService.signGuestToken) carrying `{guest: true, workspaceId,
   * permission}` - no RefreshToken row is created since guest sessions are
   * meant to be re-derived from the link, not persistently refreshable.
   */
  async resolveGuestLink(token: string) {
    const guestLink = await this.prisma.guestLink.findUnique({
      where: { token },
      include: { workspace: true },
    });
    if (!guestLink) {
      throw new NotFoundException('Guest link not found');
    }
    if (guestLink.expiresAt && guestLink.expiresAt < new Date()) {
      throw new GoneException('This guest link has expired');
    }

    const accessToken = this.authService.signGuestToken(
      guestLink.id,
      guestLink.workspaceId,
      // Cast: Prisma's generated GuestLinkPermission -> @workspace/shared's.
      guestLink.permission as unknown as GuestLinkPermission,
    );

    return {
      workspace: guestLink.workspace,
      permission: guestLink.permission,
      accessToken,
    };
  }
}
