import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { WorkspaceRole } from '@workspace/shared';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class WorkspacesService {
  constructor(private readonly prisma: PrismaService) {}

  private slugify(name: string): string {
    const base = name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
    const suffix = crypto.randomBytes(3).toString('hex');
    return `${base || 'workspace'}-${suffix}`;
  }

  /**
   * Creates the Workspace and the creator's OWNER membership atomically -
   * if either write fails, neither is persisted (avoids ever having an
   * ownerless workspace).
   */
  async createWorkspace(ownerId: string, name: string) {
    const slug = this.slugify(name);

    return this.prisma.$transaction(async (tx) => {
      const workspace = await tx.workspace.create({ data: { name, slug } });
      await tx.workspaceMember.create({
        // Prisma generates its own WorkspaceRole enum (structurally identical
        // to @workspace/shared's, but a nominally distinct TS type) - cast at
        // this single boundary rather than importing two parallel enums.
        data: { workspaceId: workspace.id, userId: ownerId, role: WorkspaceRole.OWNER as any },
      });
      return workspace;
    });
  }

  async myWorkspaces(userId: string) {
    const memberships = await this.prisma.workspaceMember.findMany({
      where: { userId },
      include: { workspace: true },
    });
    return memberships.map((membership) => membership.workspace);
  }

  async getWorkspaceWithMembers(workspaceId: string, callerId: string) {
    const membership = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: callerId } },
    });
    if (!membership) {
      throw new ForbiddenException('Not a member of this workspace');
    }

    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: { members: { include: { user: true } } },
    });
    if (!workspace) {
      throw new NotFoundException('Workspace not found');
    }
    return workspace;
  }

  /**
   * Invites (or re-activates) a member. RolesGuard (ADMIN+) already gated
   * access to this method before it's called from the resolver.
   */
  async inviteMember(workspaceId: string, email: string, role: WorkspaceRole) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      throw new NotFoundException(`No user registered with email ${email}`);
    }

    return this.prisma.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId, userId: user.id } },
      // See createWorkspace() above re: the WorkspaceRole enum cast.
      update: { role: role as any },
      create: { workspaceId, userId: user.id, role: role as any },
      include: { user: true },
    });
  }
}
