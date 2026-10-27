import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { InternalServiceGuard } from './internal-service.guard';
import { InternalSessionsService } from './internal-sessions.service';
import { SessionVerifyDto } from './dto/session-verify.dto';
import { SessionVerifyResult } from './dto/session-verify-result.dto';

/**
 * Internal, service-to-service session/RBAC verification.
 *
 * apps/sync (the Go realtime hub) calls this instead of decoding the JWT and
 * recomputing the permission matrix itself, so apps/api stays the single
 * source of truth for "is this token valid" and "what can this user do".
 * See apps/sync/internal/sessionsclient for the Go caller.
 */
@Controller('internal/sessions')
@UseGuards(InternalServiceGuard)
export class InternalSessionsController {
  constructor(private readonly sessions: InternalSessionsService) {}

  @Post('verify')
  @HttpCode(200)
  async verify(@Body() dto: SessionVerifyDto): Promise<SessionVerifyResult> {
    return this.sessions.verify(dto);
  }
}
