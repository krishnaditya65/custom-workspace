import { Module } from '@nestjs/common';
import { GuestLinksService } from './guest-links.service';
import { GuestLinksResolver } from './guest-links.resolver';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  providers: [GuestLinksService, GuestLinksResolver],
  exports: [GuestLinksService],
})
export class GuestLinksModule {}
