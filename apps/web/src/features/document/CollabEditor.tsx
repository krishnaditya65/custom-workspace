import { createSignal, For, onCleanup, onMount } from "solid-js";
import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { schema as baseSchema } from "prosemirror-schema-basic";
import { exampleSetup } from "prosemirror-example-setup";
import { keymap } from "prosemirror-keymap";
import { ySyncPlugin, yCursorPlugin, yUndoPlugin, undo, redo } from "y-prosemirror";
import { authState } from "../../lib/auth-store";
import { makeUndoManager } from "./undo-scope";

// -----------------------------------------------------------------------
// CollabEditor.tsx - multiplayer rich text.
//
// Architecture, per document:
//
//   Y.Doc  <-- IndexeddbPersistence (offline-first local cache)
//        \-- HocuspocusProvider (ws://.../  name = `doc:${documentId}`)
//
//   Y.XmlFragment("prosemirror")  <-- bound to a ProseMirror EditorView
//                                     via y-prosemirror's ySyncPlugin
//
// OFFLINE-FIRST NOTE: `IndexeddbPersistence` mirrors the Yjs update log to
// the browser's IndexedDB. Because Yjs documents are CRDTs, ALL edits -
// online or fully offline - are just appends to that update log; they
// never need to be "aware" of connectivity. So a user can keep typing with
// no network at all: their edits queue locally (both in memory and
// replicated to IndexedDB), and the moment `HocuspocusProvider` reconnects
// it exchanges state vectors with the server and replays/merges whatever
// was missed in both directions. Merge order does not matter for
// correctness (that's the CRDT guarantee) - so there's no special
// "reconnect" code to write here beyond constructing the provider.
//
// INTEGRATION ASSUMPTION: the Hocuspocus auth param is named `token` per
// the documented contract (ws://localhost:1234, doc name `doc:<documentId>`,
// `token` carries the JWT access token) - reconcile against apps/sync's
// actual `onAuthenticate` handler once it exists.
// -----------------------------------------------------------------------

const CURSOR_CHAT_TTL_MS = 5000;

/** Deterministic small hash so a given userId always maps to the same hue. */
function hashToHue(userId: string): number {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash << 5) - hash + userId.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % 360;
}

function colorForUser(userId: string): string {
  return `hsl(${hashToHue(userId)}, 70%, 50%)`;
}

interface PresenceUser {
  clientId: number;
  userId: string;
  name: string;
  color: string;
}

interface CursorChatBubble {
  clientId: number;
  name: string;
  color: string;
  text: string;
  expiresAt: number;
}

export default function CollabEditor(props: { documentId: string; wsUrl: string }) {
  let editorRoot: HTMLDivElement | undefined;
  let view: EditorView | undefined;
  let provider: HocuspocusProvider | undefined;
  let cursorChatClearTimer: ReturnType<typeof setTimeout> | undefined;

  const [presence, setPresence] = createSignal<PresenceUser[]>([]);
  const [chatBubbles, setChatBubbles] = createSignal<CursorChatBubble[]>([]);
  const [chatInputOpen, setChatInputOpen] = createSignal(false);
  const [chatInputPos, setChatInputPos] = createSignal({ x: 0, y: 0 });
  const [chatDraft, setChatDraft] = createSignal("");
  const [connected, setConnected] = createSignal(false);

  onMount(() => {
    const user = authState().user;
    const token = authState().accessToken ?? "";
    const userId = user?.id ?? "anonymous";
    const userName = user?.name ?? user?.email ?? "Anonymous";
    const color = colorForUser(userId);

    // --- Yjs doc + offline cache + network provider -----------------
    const ydoc = new Y.Doc();

    // Local-first cache: survives reloads and offline sessions. Keyed by
    // documentId so switching documents doesn't cross-pollinate caches.
    const indexeddbProvider = new IndexeddbPersistence(`doc:${props.documentId}`, ydoc);

    provider = new HocuspocusProvider({
      url: props.wsUrl,
      name: `doc:${props.documentId}`,
      token,
      document: ydoc,
      onStatus: ({ status }) => setConnected(status === "connected"),
    });

    // Broadcast our own presence (name/color) so other clients can render
    // our cursor + this document's avatar row.
    provider.awareness?.setLocalStateField("user", { id: userId, name: userName, color });

    const fragment = ydoc.getXmlFragment("prosemirror");

    // --- ProseMirror schema + plugins --------------------------------
    // prosemirror-example-setup's schema-basic + list/marks etc. would
    // normally come from prosemirror-schema-list too; kept to schema-basic
    // per the documented dependency list.
    const schema = baseSchema;

    const undoManager = makeUndoManager(ydoc, fragment);

    const plugins = [
      ySyncPlugin(fragment),
      yCursorPlugin(provider.awareness!, {
        cursorBuilder: (currentUser) => {
          const el = document.createElement("span");
          el.classList.add("collab-cursor");
          el.style.borderColor = currentUser.color ?? "#888";
          const label = document.createElement("div");
          label.classList.add("collab-cursor__label");
          label.style.backgroundColor = currentUser.color ?? "#888";
          label.textContent = currentUser.name ?? "Anonymous";
          el.appendChild(label);
          return el;
        },
      }),
      // yUndoPlugin wires Ctrl/Cmd+Z and Shift+Ctrl/Cmd+Z to the
      // Y.UndoManager under the hood; we also pass our own scoped
      // undoManager instance so undo/redo only ever touches this user's
      // own transactions (see undo-scope.ts for why).
      yUndoPlugin({ undoManager }),
      keymap({
        "Mod-z": undo,
        "Shift-Mod-z": redo,
        "Mod-y": redo,
      }),
      ...exampleSetup({ schema, menuBar: true }),
    ];

    const state = EditorState.create({ schema, plugins });

    view = new EditorView(editorRoot!, {
      state,
      // "/" opens the cursor-chat popover instead of typing a literal
      // slash, unless the popover is already open (then let it type
      // normally inside the popover's own <input>, which is a separate
      // DOM node so this handler doesn't even fire for it).
      handleKeyDown: (editorView, event) => {
        if (event.key === "/" && !chatInputOpen()) {
          event.preventDefault();
          const coords = editorView.coordsAtPos(editorView.state.selection.from);
          setChatInputPos({ x: coords.left, y: coords.bottom });
          setChatInputOpen(true);
          return true;
        }
        return false;
      },
    });

    // --- Presence + cursor-chat rendering from awareness -------------
    function readAwareness() {
      const states = provider?.awareness?.getStates() ?? new Map();
      const nextPresence: PresenceUser[] = [];
      const nextBubbles: CursorChatBubble[] = [];
      const now = Date.now();

      states.forEach((state: any, clientId: number) => {
        if (clientId === ydoc.clientID) return; // skip self in the avatar row
        const presenceUser = state.user;
        if (presenceUser) {
          nextPresence.push({ clientId, userId: presenceUser.id, name: presenceUser.name, color: presenceUser.color });
        }
        const chat = state.cursorChat as { text: string; expiresAt: number } | undefined;
        if (chat && chat.expiresAt > now && presenceUser) {
          nextBubbles.push({ clientId, name: presenceUser.name, color: presenceUser.color, text: chat.text, expiresAt: chat.expiresAt });
        }
      });

      setPresence(nextPresence);
      setChatBubbles(nextBubbles);
    }

    provider.awareness?.on("change", readAwareness);
    readAwareness();

    // Periodically prune expired chat bubbles client-side even if no new
    // awareness event fires (awareness only broadcasts on change, but
    // expiry is time-based) - see the cursor-chat effect below for the
    // per-bubble timer that actually drives this; this interval is just a
    // cheap safety net so stale bubbles never linger past ~1s beyond TTL.
    const pruneInterval = setInterval(readAwareness, 1000);

    onCleanup(() => {
      clearInterval(pruneInterval);
      if (cursorChatClearTimer) clearTimeout(cursorChatClearTimer);
      provider?.awareness?.off("change", readAwareness);
      view?.destroy();
      provider?.destroy();
      indexeddbProvider.destroy();
    });
  });

  function submitCursorChat(e: Event) {
    e.preventDefault();
    const text = chatDraft().trim();
    setChatInputOpen(false);
    setChatDraft("");
    if (!text) return;

    const expiresAt = Date.now() + CURSOR_CHAT_TTL_MS;

    // Ephemeral: written only to awareness (in-memory, gossiped over the
    // websocket to connected peers), NEVER to the Y.Doc/fragment, so it's
    // never persisted to Postgres/IndexedDB and disappears the moment this
    // client disconnects or the TTL elapses.
    provider?.awareness?.setLocalStateField("cursorChat", { text, expiresAt });

    // Locally clear our own bubble after the TTL too. Re-submitting before
    // the previous timer fires cancels it first, so the bubble's lifetime
    // always tracks the *latest* message rather than the first.
    if (cursorChatClearTimer) clearTimeout(cursorChatClearTimer);
    cursorChatClearTimer = setTimeout(() => {
      provider?.awareness?.setLocalStateField("cursorChat", null);
    }, CURSOR_CHAT_TTL_MS);
  }

  return (
    <div class="collab-editor">
      <div class="collab-editor__presence">
        <For each={presence()}>
          {(p) => (
            <div
              class="presence-avatar"
              style={{ "background-color": p.color }}
              title={p.name}
            >
              {p.name.slice(0, 1).toUpperCase()}
            </div>
          )}
        </For>
        <span class="collab-editor__status">{connected() ? "Connected" : "Connecting…"}</span>
      </div>

      <div class="collab-editor__surface" ref={editorRoot} />

      <For each={chatBubbles()}>
        {(bubble) => (
          <div class="cursor-chat-bubble" style={{ "border-color": bubble.color }}>
            <strong style={{ color: bubble.color }}>{bubble.name}</strong>: {bubble.text}
          </div>
        )}
      </For>

      {chatInputOpen() && (
        <form
          class="cursor-chat-input"
          style={{ left: `${chatInputPos().x}px`, top: `${chatInputPos().y}px` }}
          onSubmit={submitCursorChat}
        >
          <input
            autofocus
            placeholder="Say something… (Enter to send, Esc to cancel)"
            value={chatDraft()}
            onInput={(e) => setChatDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setChatInputOpen(false);
                setChatDraft("");
              }
            }}
          />
        </form>
      )}
    </div>
  );
}
