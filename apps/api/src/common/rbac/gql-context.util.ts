import { ExecutionContext } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';

/**
 * Extracts a workspaceId from a GraphQL resolver's arguments. Supports two
 * shapes used across this codebase's mutations/queries:
 *   - a flat arg:            createChannel(workspaceId: ID!, ...)
 *   - a nested input object: inviteMember(input: { workspaceId, ... })
 *
 * Returns undefined if neither is present (guards should treat that as a
 * failed/ambiguous authorization check, not "allow").
 */
export function extractWorkspaceId(context: ExecutionContext): string | undefined {
  const gqlContext = GqlExecutionContext.create(context);
  const args = gqlContext.getArgs<Record<string, unknown>>();

  if (typeof args.workspaceId === 'string') {
    return args.workspaceId;
  }

  const input = args.input as Record<string, unknown> | undefined;
  if (input && typeof input.workspaceId === 'string') {
    return input.workspaceId;
  }

  return undefined;
}

/** Returns the GraphQL request object (where our auth guard attaches `user`). */
export function getGqlRequest(context: ExecutionContext): any {
  const gqlContext = GqlExecutionContext.create(context);
  return gqlContext.getContext().req;
}
