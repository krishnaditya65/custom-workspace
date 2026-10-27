// -----------------------------------------------------------------------
// ws-subscription.ts
//
// STUB / documentation of the low-latency upgrade path for chat.
//
// ChatPanel.tsx currently gets "new message" updates by polling
// `messages(channelId)` every 4s (see src/features/chat/ChatPanel.tsx).
// That's simple and needs zero extra runtime dependencies, but it's not
// real-time and it re-fetches the whole message list on a timer.
//
// apps/api's design already includes (per the system spec) a GraphQL
// subscription `messageAdded(channelId: ID!): Message` served over the
// `graphql-ws` protocol on the same /graphql endpoint (upgraded to a
// WebSocket). The documented upgrade is to swap the poll loop in
// ChatPanel.tsx for a subscription client such as `graphql-ws`'s
// `createClient` here.
//
// This file intentionally does NOT pull in the `graphql-ws` package (to
// keep the app runnable standalone without extra ws deps per the task
// brief) - it stubs the shape of that integration so the swap is a small,
// localized change once apps/api's subscription is confirmed working.
// -----------------------------------------------------------------------

export interface MessageAddedEvent {
  id: string;
  channelId: string;
  body: string;
  authorId: string;
  authorName?: string;
  createdAt: string;
}

export interface SubscriptionHandle {
  unsubscribe(): void;
}

/**
 * STUB: subscribes to `messageAdded(channelId)` over graphql-ws.
 *
 * Real implementation sketch (once `graphql-ws` is added as a dependency):
 *
 * ```ts
 * import { createClient } from "graphql-ws";
 *
 * const client = createClient({
 *   url: WS_GRAPHQL_URL, // e.g. ws://localhost:4000/graphql
 *   connectionParams: () => ({ token: authState().accessToken }),
 * });
 *
 * export function subscribeToMessageAdded(
 *   channelId: string,
 *   onMessage: (msg: MessageAddedEvent) => void,
 * ): SubscriptionHandle {
 *   const unsubscribe = client.subscribe(
 *     {
 *       query: `
 *         subscription OnMessageAdded($channelId: ID!) {
 *           messageAdded(channelId: $channelId) {
 *             id channelId body authorId authorName createdAt
 *           }
 *         }
 *       `,
 *       variables: { channelId },
 *     },
 *     {
 *       next: (result) => {
 *         const msg = (result.data as any)?.messageAdded;
 *         if (msg) onMessage(msg);
 *       },
 *       error: (err) => console.error("messageAdded subscription error", err),
 *       complete: () => {},
 *     },
 *   );
 *   return { unsubscribe };
 * }
 * ```
 *
 * Until `graphql-ws` is added, this stub is a no-op that returns an
 * inert handle, so callers can wire the call site today without it doing
 * anything - ChatPanel.tsx keeps polling as its actual mechanism.
 */
export function subscribeToMessageAdded(
  _channelId: string,
  _onMessage: (msg: MessageAddedEvent) => void,
): SubscriptionHandle {
  console.warn(
    "[ws-subscription] subscribeToMessageAdded() is a documented stub - " +
      "ChatPanel.tsx uses polling by default. See the block comment in " +
      "src/lib/ws-subscription.ts for the graphql-ws upgrade path.",
  );
  return {
    unsubscribe() {
      /* no-op */
    },
  };
}
