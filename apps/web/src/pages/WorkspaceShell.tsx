import { createEffect, createSignal, For, Show } from "solid-js";
import { A, useNavigate, useParams } from "@solidjs/router";
import type { RouteSectionProps } from "@solidjs/router";
import { channels as fetchChannels, createChannel, type Channel, type Workspace, workspace as fetchWorkspace } from "../lib/api";
import { authState, logout } from "../lib/auth-store";

// -----------------------------------------------------------------------
// WorkspaceShell.tsx - the /w/:workspaceId route.
//
// Renders the persistent workspace chrome: a sidebar listing channels, and
// a main pane that renders whichever nested route is active (ChannelView
// at /w/:workspaceId/c/:channelId, via props.children). Kept deliberately thin -
// data loading for a specific channel's messages/doc/board lives in
// ChannelView.tsx, not here.
// -----------------------------------------------------------------------

export default function WorkspaceShell(props: RouteSectionProps) {
  const params = useParams<{ workspaceId: string }>();
  const navigate = useNavigate();

  const [workspace, setWorkspace] = createSignal<Workspace | null>(null);
  const [channelList, setChannelList] = createSignal<Channel[]>([]);
  const [newChannelName, setNewChannelName] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);

  createEffect(() => {
    const workspaceId = params.workspaceId;
    if (!workspaceId) return;
    setError(null);
    Promise.all([fetchWorkspace(workspaceId), fetchChannels(workspaceId)])
      .then(([loadedWorkspace, loadedChannels]) => {
        setWorkspace(loadedWorkspace);
        setChannelList(loadedChannels);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load workspace"));
  });

  async function handleCreateChannel(e: Event) {
    e.preventDefault();
    const name = newChannelName().trim();
    if (!name) return;
    try {
      const created = await createChannel(params.workspaceId, name);
      setChannelList((current) => [...current, created]);
      setNewChannelName("");
      navigate(`/w/${params.workspaceId}/c/${created.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create channel");
    }
  }

  function handleLogout() {
    logout();
    navigate("/login", { replace: true });
  }

  return (
    <div class="workspace-shell">
      <aside class="workspace-shell__sidebar">
        <div class="workspace-shell__header">
          <h2>{workspace()?.name ?? "Workspace"}</h2>
        </div>

        <Show when={error()}>
          <div class="workspace-shell__error">{error()}</div>
        </Show>

        <nav class="workspace-shell__channels">
          <For each={channelList()}>
            {(channel) => (
              <A
                href={`/w/${params.workspaceId}/c/${channel.id}`}
                class="workspace-shell__channel-link"
                activeClass="workspace-shell__channel-link--active"
              >
                # {channel.name}
              </A>
            )}
          </For>
        </nav>

        <form class="workspace-shell__new-channel" onSubmit={handleCreateChannel}>
          <input
            type="text"
            placeholder="New channel…"
            value={newChannelName()}
            onInput={(e) => setNewChannelName(e.currentTarget.value)}
          />
          <button type="submit" disabled={!newChannelName().trim()}>
            +
          </button>
        </form>

        <div class="workspace-shell__footer">
          <span>{authState().user?.name ?? authState().user?.email}</span>
          <button onClick={handleLogout}>Log out</button>
        </div>
      </aside>

      <main class="workspace-shell__main">
        {props.children}
      </main>
    </div>
  );
}
