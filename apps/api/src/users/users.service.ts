import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  async findByEmail(email: string) {
    return this.prisma.user.findUnique({ where: { email } });
  }

  /** True if `viewerId` and `targetId` share at least one workspace. */
  async shareWorkspace(viewerId: string, targetId: string): Promise<boolean> {
    if (viewerId === targetId) return true;

    const viewerWorkspaceIds = await this.prisma.workspaceMember.findMany({
      where: { userId: viewerId },
      select: { workspaceId: true },
    });
    if (viewerWorkspaceIds.length === 0) return false;

    const shared = await this.prisma.workspaceMember.findFirst({
      where: {
        userId: targetId,
        workspaceId: { in: viewerWorkspaceIds.map((membership) => membership.workspaceId) },
      },
    });
    return Boolean(shared);
  }
}
