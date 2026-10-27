import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PUB_SUB, MESSAGE_ADDED_EVENT } from '../common/pubsub/pubsub.constants';
import type { RedisPubSub } from 'graphql-redis-subscriptions';

@Injectable()
export class MessagesService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PUB_SUB) private readonly pubSub: RedisPubSub,
  ) {}

  private async assertChannelAccess(channelId: string, userId: string) {
    const channel = await this.prisma.channel.findUnique({ where: { id: channelId } });
    if (!channel) {
      throw new NotFoundException('Channel not found');
    }
    const membership = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: channel.workspaceId, userId } },
    });
    if (!membership) {
      throw new ForbiddenException('Not a member of this workspace');
    }
    return channel;
  }

  private async withReplyCount(message: { id: string }) {
    const replyCount = await this.prisma.message.count({ where: { threadRootId: message.id } });
    return { ...message, replyCount };
  }

  async sendMessage(userId: string, channelId: string, body: string, threadRootId?: string) {
    await this.assertChannelAccess(channelId, userId);

    const message = await this.prisma.message.create({
      data: { channelId, authorId: userId, body, threadRootId },
      include: { author: true },
    });

    const shaped = await this.withReplyCount(message);

    // Publish for `messageAdded` subscribers. Filtering by channelId happens
    // in the resolver's withFilter, but we still scope the topic name per
    // channel so unrelated channels' fan-out doesn't even reach subscribers
    // that never asked for it.
    await this.pubSub.publish(`${MESSAGE_ADDED_EVENT}.${channelId}`, {
      messageAdded: shaped,
    });

    return shaped;
  }

  /**
   * Cursor-paginated message history for a channel.
   *
   * Storage order is `createdAt desc` (newest first) so we can efficiently
   * grab "the next page older than `cursor`" via a simple id-based cursor
   * (id of the oldest message already seen by the client), then the array is
   * reversed before returning so the client can render top-to-bottom in
   * natural chronological order.
   */
  async messages(userId: string, channelId: string, cursor?: string, limit = 50) {
    await this.assertChannelAccess(channelId, userId);

    const cursorMessage = cursor
      ? await this.prisma.message.findUnique({ where: { id: cursor } })
      : null;

    const rows = await this.prisma.message.findMany({
      where: {
        channelId,
        deletedAt: null,
        ...(cursorMessage ? { createdAt: { lt: cursorMessage.createdAt } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      include: { author: true },
    });

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);

    const withCounts = await Promise.all(page.map((message) => this.withReplyCount(message)));
    withCounts.reverse(); // chronological order for display

    return {
      items: withCounts,
      nextCursor: hasMore ? page[page.length - 1].id : null,
      hasMore,
    };
  }

  async editMessage(userId: string, messageId: string, body: string) {
    const message = await this.prisma.message.findUnique({ where: { id: messageId } });
    if (!message || message.deletedAt) {
      throw new NotFoundException('Message not found');
    }
    if (message.authorId !== userId) {
      throw new ForbiddenException('Only the author can edit this message');
    }

    const updated = await this.prisma.message.update({
      where: { id: messageId },
      data: { body, editedAt: new Date() },
      include: { author: true },
    });
    return this.withReplyCount(updated);
  }

  /** Soft delete - preserves the row (and thread structure) but hides the body/marks deletedAt. */
  async deleteMessage(userId: string, messageId: string): Promise<boolean> {
    const message = await this.prisma.message.findUnique({ where: { id: messageId } });
    if (!message || message.deletedAt) {
      return false;
    }
    if (message.authorId !== userId) {
      throw new ForbiddenException('Only the author can delete this message');
    }

    await this.prisma.message.update({
      where: { id: messageId },
      data: { deletedAt: new Date(), body: '[deleted]' },
    });
    return true;
  }
}
