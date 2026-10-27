import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

const INTERNAL_SECRET_HEADER = 'x-internal-secret';

/**
 * InternalServiceGuard
 * =====================
 * Restricts a REST endpoint to trusted service-to-service callers (currently
 * just apps/sync) rather than end users. There's no per-caller identity here
 * on purpose - it's a single shared secret compared in constant time, sent as
 * the `x-internal-secret` header. This is deliberately simple: `/internal/*`
 * routes are expected to only ever be reachable from inside the private
 * network apps/sync also lives in (not exposed through the public gateway),
 * and this header is a defense-in-depth check on top of that network
 * boundary, not a replacement for it.
 *
 * Configure both sides with the same INTERNAL_SERVICE_SECRET env var.
 */
@Injectable()
export class InternalServiceGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>('INTERNAL_SERVICE_SECRET');
    if (!expected) {
      // Fail closed: an unset secret must never be treated as "no auth
      // required" in any environment, including dev - misconfiguration
      // should be loud, not an open internal API.
      throw new UnauthorizedException('INTERNAL_SERVICE_SECRET is not configured');
    }

    const req = context.switchToHttp().getRequest<Request>();
    const provided = req.header(INTERNAL_SECRET_HEADER);
    if (!provided || !timingSafeEqual(provided, expected)) {
      throw new UnauthorizedException('Invalid or missing internal service credentials');
    }
    return true;
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
