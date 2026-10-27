import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { GqlExecutionContext } from '@nestjs/graphql';

/**
 * Standard passport-jwt AuthGuard, extended to work transparently in both
 * HTTP (REST, e.g. /health) and GraphQL resolver contexts. GraphQL's
 * execution context wraps the real HTTP request differently than a normal
 * controller, so passport needs `getRequest()` overridden to unwrap it via
 * GqlExecutionContext - otherwise passport can't find the Authorization
 * header on GraphQL requests.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  getRequest(context: ExecutionContext) {
    const gqlContext = GqlExecutionContext.create(context);
    const gqlReq = gqlContext.getContext().req;
    return gqlReq ?? context.switchToHttp().getRequest();
  }
}
