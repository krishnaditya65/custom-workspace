import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InternalSessionsController } from './internal-sessions.controller';
import { InternalSessionsService } from './internal-sessions.service';
import { InternalServiceGuard } from './internal-service.guard';

/**
 * Groups the `/internal/*` REST surface used only by other services in this
 * system (currently apps/sync). Not part of the public GraphQL API and not
 * meant to be reachable from the public gateway - see InternalServiceGuard.
 */
@Module({
  imports: [AuthModule], // for JwtService, configured with JWT_ACCESS_SECRET
  controllers: [InternalSessionsController],
  providers: [InternalSessionsService, InternalServiceGuard],
})
export class InternalModule {}
