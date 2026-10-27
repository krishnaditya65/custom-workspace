import { Inject, UseGuards } from '@nestjs/common';
import { Args, ID, Mutation, Query, Resolver, Subscription } from '@nestjs/graphql';
import type { RedisPubSub } from 'graphql-redis-subscriptions';
import { PermissionLevel } from '@workspace/shared';
import { MessagesService } from './messages.service';
import {
  EditMessageInput,
  MessagePage,
  MessagesQueryInput,
  MessageType,
  SendMessageInput,
} from './dto/message.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/decorators/current-user.decorator';
import { PUB_SUB, MESSAGE_ADDED_EVENT } from '../common/pubsub/pubsub.constants';
import { PermissionsGuard } from '../common/rbac/permissions.guard';
import { RequiredPermission } from '../common/rbac/required-permission.decorator';

@Resolver(() => MessageType)
@UseGuards(JwtAuthGuard)
export class MessagesResolver {
  constructor(
    private readonly messagesService: MessagesService,
    @Inject(PUB_SUB) private readonly pubSub: RedisPubSub,
  ) {}

  // PermissionsGuard resolves workspaceId via input.channelId -> Channel ->
  // Workspace (see PermissionsGuard.resolveWorkspaceId), then checks the
  // caller's effective permission (workspace role, or GuestLink.permission
  // for guests) is at least COMMENT to post a message.
  @Mutation(() => MessageType)
  @UseGuards(PermissionsGuard)
  @RequiredPermission(PermissionLevel.COMMENT)
  async sendMessage(
    @Args('input') input: SendMessageInput,
    @CurrentUser() caller: RequestUser,
  ): Promise<MessageType> {
    return this.messagesService.sendMessage(
      caller.userId,
      input.channelId,
      input.body,
      input.threadRootId,
    ) as unknown as Promise<MessageType>;
  }

  @Query(() => MessagePage)
  async messages(
    @Args('input') input: MessagesQueryInput,
    @CurrentUser() caller: RequestUser,
  ): Promise<MessagePage> {
    return this.messagesService.messages(
      caller.userId,
      input.channelId,
      input.cursor,
      input.limit,
    ) as unknown as Promise<MessagePage>;
  }

  @Mutation(() => MessageType)
  async editMessage(
    @Args('input') input: EditMessageInput,
    @CurrentUser() caller: RequestUser,
  ): Promise<MessageType> {
    return this.messagesService.editMessage(
      caller.userId,
      input.messageId,
      input.body,
    ) as unknown as Promise<MessageType>;
  }

  @Mutation(() => Boolean)
  async deleteMessage(
    @Args('messageId', { type: () => ID }) messageId: string,
    @CurrentUser() caller: RequestUser,
  ): Promise<boolean> {
    return this.messagesService.deleteMessage(caller.userId, messageId);
  }

  /**
   * Fires whenever a new message is created in `channelId`. Backed by
   * graphql-redis-subscriptions so this works correctly when the API runs
   * as multiple horizontally-scaled instances - the publishing instance and
   * the subscribing instance don't need to be the same process.
   *
   * NOTE: access control on subscriptions happens at connection/subscribe
   * time here (topic is scoped per channelId) - a production hardening
   * would also re-verify workspace membership inside `filter` using the
   * connection's authenticated context, since GraphQL subscriptions over
   * websockets carry their own connection-params-based auth handshake
   * (out of scope for this HTTP-request-oriented JwtAuthGuard).
   */
  @Subscription(() => MessageType, {
    filter: () => true,
    resolve: (payload: { messageAdded: MessageType }) => payload.messageAdded,
  })
  messageAdded(@Args('channelId', { type: () => ID }) channelId: string) {
    return this.pubSub.asyncIterator(`${MESSAGE_ADDED_EVENT}.${channelId}`);
  }
}
