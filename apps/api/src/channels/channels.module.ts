import { Module } from '@nestjs/common';
import { ChannelsService } from './channels.service';
import { ChannelsResolver } from './channels.resolver';

@Module({
  providers: [ChannelsService, ChannelsResolver],
  exports: [ChannelsService],
})
export class ChannelsModule {}
