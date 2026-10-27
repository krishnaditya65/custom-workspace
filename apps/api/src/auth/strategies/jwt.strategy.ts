import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AnyJwtPayload, isGuestJwtPayload } from '@workspace/shared';
import type { RequestGuest, RequestUser } from '../../common/decorators/current-user.decorator';

/**
 * Validates the HS256 access token (Authorization: Bearer <token>) and
 * shapes the resulting `req.user`. Handles both regular user tokens
 * ({sub, email}) and scoped guest tokens ({sub, guest:true, workspaceId,
 * permission}) minted by AuthService.signGuestToken.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_ACCESS_SECRET', 'change-me-access-secret'),
    });
  }

  validate(payload: AnyJwtPayload): RequestUser | RequestGuest {
    if (isGuestJwtPayload(payload)) {
      return {
        userId: payload.sub,
        guest: true,
        workspaceId: payload.workspaceId,
        permission: payload.permission,
      };
    }
    return { userId: payload.sub, email: payload.email };
  }
}
