import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * See dto/channel.types.ts for why "archived" is encoded as a name prefix
 * rather than a real column - schema.prisma has no archivedAt field for
 * Channel and this generator must not modify the schema.
 */
const ARCHIVED_PREFIX = '[archived] ';

@Injectable()
export class ChannelsService {
  constructor(private readonly prisma: PrismaService) {}

  private async assertMember(workspaceId: string, userId: string): Promise<void> {
    const membership = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    if (!membership) {
      throw new ForbiddenException('Not a member of this workspace');
    }
  }

  private decorate<T extends { name: string }>(channel: T) {
    const isArchived = channel.name.startsWith(ARCHIVED_PREFIX);
    return {
      ...channel,
      name: isArchived ? channel.name.slice(ARCHIVED_PREFIX.length) : channel.name,
      isArchived,
    };
  }

  async createChannel(
    userId: string,
    workspaceId: string,
    name: string,
    isPrivate: boolean,
    parentId?: string,
  ) {
    await this.assertMember(workspaceId, userId);

    if (parentId) {
      const parent = await this.prisma.channel.findUnique({ where: { id: parentId } });
      if (!parent || parent.workspaceId !== workspaceId) {
        throw new NotFoundException('Parent channel not found in this workspace');
      }
    }

    const channel = await this.prisma.channel.create({
      data: { workspaceId, name, isPrivate, parentId },
    });
    return this.decorate(channel);
  }

  /** Returns the full channel set for a workspace, shaped as a parent/child tree (archived channels excluded). */
  async channels(userId: string, workspaceId: string) {
    await this.assertMember(workspaceId, userId);

    const all = await this.prisma.channel.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'asc' },
    });

    const decorated = all.map((channel) => this.decorate(channel)).filter((channel) => !channel.isArchived);
    const byId = new Map(decorated.map((channel) => [channel.id, { ...channel, children: [] as any[] }]));
    const roots: any[] = [];

    for (const channel of byId.values()) {
      if (channel.parentId && byId.has(channel.parentId)) {
        byId.get(channel.parentId)!.children.push(channel);
      } else {
        roots.push(channel);
      }
    }

    return roots;
  }

  async archiveChannel(userId: string, channelId: string) {
    const channel = await this.prisma.channel.findUnique({ where: { id: channelId } });
    if (!channel) {
      throw new NotFoundException('Channel not found');
    }
    await this.assertMember(channel.workspaceId, userId);

    if (channel.name.startsWith(ARCHIVED_PREFIX)) {
      return this.decorate(channel); // already archived, idempotent
    }

    const updated = await this.prisma.channel.update({
      where: { id: channelId },
      data: { name: `${ARCHIVED_PREFIX}${channel.name}` },
    });
    return this.decorate(updated);
  }
}
