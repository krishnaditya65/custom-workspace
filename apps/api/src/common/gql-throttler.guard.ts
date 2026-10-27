import { Injectable, ExecutionContext } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { GqlExecutionContext } from '@nestjs/graphql';

/**
 * ThrottlerGuard's default `getRequestResponse` assumes an HTTP execution
 * context (`context.switchToHttp().getRequest()`), which returns `undefined`
 * for GraphQL resolvers — every request would crash with "Cannot read
 * properties of undefined (reading 'ip')" the moment the global APP_GUARD
 * fired. This override pulls { req, res } out of the GraphQL context instead
 * (the same object our GraphQLModule factory's `context: ({req,res}) => ...`
 * already puts there for JwtAuthGuard to use).
 */
@Injectable()
export class GqlThrottlerGuard extends ThrottlerGuard {
  protected getRequestResponse(context: ExecutionContext): { req: any; res: any } {
    // Plain REST routes (e.g. HealthController) still go through this guard
    // since it's registered globally — only GraphQL contexts need the
    // GqlExecutionContext detour.
    if (context.getType<'graphql'>() !== 'graphql') {
      const http = context.switchToHttp();
      return { req: http.getRequest(), res: http.getResponse() };
    }
    const gqlCtx = GqlExecutionContext.create(context).getContext<{ req: any; res: any }>();
    return { req: gqlCtx.req, res: gqlCtx.res };
  }
}
