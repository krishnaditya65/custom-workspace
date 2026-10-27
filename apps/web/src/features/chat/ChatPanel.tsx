import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { messages as fetchMessages, sendMessage, type Message } from "../../lib/api";
import { authState } from "../../lib/auth-store";

// -----------------------------------------------------------------------
// ChatPanel.tsx
//
// Loads channel history on mount/channel change, renders it, and lets the
// user post new messages with optimistic UI. New-message delivery is done
// by polling every 4s. See src/lib/ws-subscription.ts for the documented
// upgrade path: swap the `setInterval` poll below for a
// `subscribeToMessageAdded(channelId, onMessage)` graphql-ws subscription
// once apps/api's `messageAdded` subscription is confirmed live - that's a
// drop-in replacement for the effect below (same append-to-list logic),
// it just becomes push instead of pull.
// -----------------------------------------------------------------------

const POLL_INTERVAL_MS = 4000;

export default function ChatPanel(props: { channelId: string }) {
  const [items, setItems] = createSignal<Message[]>([]);
  const [draft, setDraft] = createSignal("");
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  let listEl: HTMLDivElement | undefined;

  async function load(channelId: string) {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchMessages(channelId);
      setItems(result);
      queueMicrotask(scrollToBottom);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load messages");
    } finally {
      setLoading(false);
    }
  }

  function scrollToBottom() {
    if (listEl) listEl.scrollTop = listEl.scrollHeight;
  }

  // Re-load whenever the channel changes, and (re)start the poll loop
  // scoped to that channel.
  createEffect(() => {
    const channelId = props.channelId;
    void load(channelId);

    const interval = setInterval(async () => {
      try {
        const latest = await fetchMessages(channelId);
        // Cheap de-dupe/merge: replace wholesale since the server is the
        // source of truth and message lists here are small. For larger
        // channels this is exactly the kind of re-fetch the subscription
        // upgrade (see file header) avoids.
        setItems((current) => {
          const wasAtBottom =
            !listEl || listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight - 24;
          if (wasAtBottom) queueMicrotask(scrollToBottom);
          return latest.length !== current.length ? latest : current;
        });
      } catch {
        // Swallow poll errors silently - the next tick will retry. A
        // persistent failure will surface next time the user switches
        // channels and the initial `load()` throws.
      }
    }, POLL_INTERVAL_MS);

    onCleanup(() => clearInterval(interval));
  });

  async function handleSend(e: Event) {
    e.preventDefault();
    const body = draft().trim();
    if (!body) return;

    const me = authState().user;
    const optimistic: Message = {
      id: `optimistic-${Date.now()}`,
      channelId: props.channelId,
      body,
      authorId: me?.id ?? "me",
      authorName: me?.name ?? me?.email ?? "You",
      createdAt: new Date().toISOString(),
    };

    setItems((current) => [...current, optimistic]);
    setDraft("");
    queueMicrotask(scrollToBottom);

    try {
      const saved = await sendMessage(props.channelId, body);
      setItems((current) => current.map((message) => (message.id === optimistic.id ? saved : message)));
    } catch (e) {
      // Roll back the optimistic message and surface the error.
      setItems((current) => current.filter((message) => message.id !== optimistic.id));
      setError(e instanceof Error ? e.message : "Failed to send message");
    }
  }

  return (
    <div class="chat-panel">
      <div class="chat-messages" ref={listEl}>
        <Show when={loading()}>
          <div class="chat-status">Loading messages…</div>
        </Show>
        <Show when={error()}>
          <div class="chat-status chat-status--error">{error()}</div>
        </Show>
        <For each={items()}>
          {(msg) => (
            <div class="chat-message" classList={{ "chat-message--pending": msg.id.startsWith("optimistic-") }}>
              <div class="chat-message__author">{msg.authorName ?? msg.authorId}</div>
              <div class="chat-message__body">{msg.body}</div>
              <div class="chat-message__time">
                {new Date(msg.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </div>
            </div>
          )}
        </For>
      </div>

      <form class="chat-composer" onSubmit={handleSend}>
        <input
          type="text"
          placeholder="Message…"
          value={draft()}
          onInput={(e) => setDraft(e.currentTarget.value)}
        />
        <button type="submit" disabled={!draft().trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
