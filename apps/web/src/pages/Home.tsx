import { createEffect, createSignal, For, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { createWorkspace, myWorkspaces, type Workspace } from "../lib/api";

// Landing page at "/": lists the current user's workspaces and lets them
// create a new one or jump into an existing one.
export default function Home() {
  const navigate = useNavigate();
  const [workspaces, setWorkspaces] = createSignal<Workspace[]>([]);
  const [name, setName] = createSignal("");
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);

  createEffect(() => {
    myWorkspaces()
      .then(setWorkspaces)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load workspaces"))
      .finally(() => setLoading(false));
  });

  async function handleCreate(e: Event) {
    e.preventDefault();
    const trimmed = name().trim();
    if (!trimmed) return;
    try {
      const created = await createWorkspace(trimmed);
      navigate(`/w/${created.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create workspace");
    }
  }

  return (
    <div class="home-page">
      <h1>Your workspaces</h1>

      <Show when={loading()}>
        <p>Loading…</p>
      </Show>
      <Show when={error()}>
        <p class="home-page__error">{error()}</p>
      </Show>

      <ul class="home-page__list">
        <For each={workspaces()}>
          {(workspaceItem) => (
            <li>
              <a href={`/w/${workspaceItem.id}`}>{workspaceItem.name}</a>
            </li>
          )}
        </For>
      </ul>

      <form class="home-page__new" onSubmit={handleCreate}>
        <input
          type="text"
          placeholder="New workspace name…"
          value={name()}
          onInput={(e) => setName(e.currentTarget.value)}
        />
        <button type="submit" disabled={!name().trim()}>
          Create workspace
        </button>
      </form>
    </div>
  );
}
