import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';

export interface RequestUser {
  userId: string;
  email: string;
  guest?: false;
}

export interface RequestGuest {
  userId: string; // synthetic guest id, e.g. `guest:<guestLinkId>`
  guest: true;
  workspaceId: string;
  permission: string;
}

/**
 * @CurrentUser() param decorator - pulls the authenticated principal
 * (attached to `req.user` by JwtStrategy) out of either an HTTP or GraphQL
 * execution context. Works for both regular users and guest tokens; check
 * `.guest` to distinguish.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): RequestUser | RequestGuest => {
    const gqlContext = GqlExecutionContext.create(context);
    const req = gqlContext.getContext().req ?? context.switchToHttp().getRequest();
    return req.user;
  },
);
