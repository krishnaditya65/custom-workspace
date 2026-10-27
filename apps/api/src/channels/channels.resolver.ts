import { UseGuards } from '@nestjs/common';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { ChannelsService } from './channels.service';
import { ChannelType, CreateChannelInput } from './dto/channel.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/decorators/current-user.decorator';

@Resolver(() => ChannelType)
@UseGuards(JwtAuthGuard)
export class ChannelsResolver {
  constructor(private readonly channelsService: ChannelsService) {}

  @Mutation(() => ChannelType)
  async createChannel(
    @Args('input') input: CreateChannelInput,
    @CurrentUser() caller: RequestUser,
  ): Promise<ChannelType> {
    return this.channelsService.createChannel(
      caller.userId,
      input.workspaceId,
      input.name,
      input.isPrivate ?? false,
      input.parentId,
    ) as unknown as Promise<ChannelType>;
  }

  @Query(() => [ChannelType])
  async channels(
    @Args('workspaceId', { type: () => ID }) workspaceId: string,
    @CurrentUser() caller: RequestUser,
  ): Promise<ChannelType[]> {
    return this.channelsService.channels(caller.userId, workspaceId) as unknown as Promise<ChannelType[]>;
  }

  @Mutation(() => ChannelType)
  async archiveChannel(
    @Args('channelId', { type: () => ID }) channelId: string,
    @CurrentUser() caller: RequestUser,
  ): Promise<ChannelType> {
    return this.channelsService.archiveChannel(caller.userId, channelId) as unknown as Promise<ChannelType>;
  }
}
