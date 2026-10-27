import { createSignal, Show } from "solid-js";
import { useParams } from "@solidjs/router";
import ChatPanel from "../features/chat/ChatPanel";
import CollabEditor from "../features/document/CollabEditor";
import Whiteboard from "../features/whiteboard/Whiteboard";
import Huddle from "../features/huddle/Huddle";
import TaskList from "../features/tasks-calendar/TaskList";
import CalendarView from "../features/tasks-calendar/CalendarView";

// -----------------------------------------------------------------------
// ChannelView.tsx - the /w/:workspaceId/c/:channelId route.
//
// Chat is always visible; the collaborative doc/board/tasks/calendar/huddle
// surfaces are tabs alongside it. The doc/board `documentId`/`boardId` are
// derived from the channelId (`doc:<channelId>` / `board:<channelId>` at
// the Hocuspocus layer - see CollabEditor.tsx/Whiteboard.tsx, which add
// their own `doc:`/`board:` prefixes on top of this id) so each channel
// gets exactly one shared document and one shared whiteboard. A future
// iteration might let a channel have multiple named docs/boards; that's
// out of scope for the documented contract today.
// -----------------------------------------------------------------------

const WS_URL: string = (import.meta as any).env?.VITE_WS_URL ?? "ws://localhost:1234";
const API_URL: string = (import.meta as any).env?.VITE_API_URL ?? "http://localhost:4000";

type Tab = "chat" | "doc" | "board" | "huddle" | "tasks" | "calendar";

export default function ChannelView() {
  const params = useParams<{ workspaceId: string; channelId: string }>();
  const [tab, setTab] = createSignal<Tab>("chat");

  const tabs: { id: Tab; label: string }[] = [
    { id: "chat", label: "Chat" },
    { id: "doc", label: "Doc" },
    { id: "board", label: "Whiteboard" },
    { id: "huddle", label: "Huddle" },
    { id: "tasks", label: "Tasks" },
    { id: "calendar", label: "Calendar" },
  ];

  return (
    <div class="channel-view">
      <div class="channel-view__tabs">
        {tabs.map((tabItem) => (
          <button classList={{ active: tab() === tabItem.id }} onClick={() => setTab(tabItem.id)}>
            {tabItem.label}
          </button>
        ))}
      </div>

      <div class="channel-view__body">
        <Show when={tab() === "chat"}>
          <ChatPanel channelId={params.channelId} />
        </Show>
        <Show when={tab() === "doc"}>
          <CollabEditor documentId={params.channelId} wsUrl={WS_URL} />
        </Show>
        <Show when={tab() === "board"}>
          <Whiteboard boardId={params.channelId} wsUrl={WS_URL} />
        </Show>
        <Show when={tab() === "huddle"}>
          <Huddle workspaceId={params.workspaceId} channelId={params.channelId} apiUrl={API_URL} />
        </Show>
        <Show when={tab() === "tasks"}>
          <TaskList workspaceId={params.workspaceId} />
        </Show>
        <Show when={tab() === "calendar"}>
          <CalendarView workspaceId={params.workspaceId} />
        </Show>
      </div>
    </div>
  );
}
