import { createEffect, createSignal, For, Show } from "solid-js";
import { createTask, tasks as fetchTasks, updateTaskStatus, type Task } from "../../lib/api";

// -----------------------------------------------------------------------
// TaskList.tsx - straightforward CRUD UI for workspace tasks.
//
// NOTE: `tasks`/`createTask`/`updateTaskStatus` are NOT part of the
// documented apps/api GraphQL contract (which only covers auth/workspaces/
// channels/messages) - see the "assumed API" section in src/lib/api.ts for
// the placeholder shapes used here. Reconcile field names once apps/api
// documents its tasks schema.
// -----------------------------------------------------------------------

const STATUSES: Task["status"][] = ["todo", "in_progress", "done"];

export default function TaskList(props: { workspaceId: string }) {
  const [items, setItems] = createSignal<Task[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [title, setTitle] = createSignal("");
  const [dueAt, setDueAt] = createSignal("");

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setItems(await fetchTasks(props.workspaceId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load tasks");
    } finally {
      setLoading(false);
    }
  }

  createEffect(() => {
    // Re-run whenever the workspace changes.
    props.workspaceId;
    void load();
  });

  async function handleCreate(e: Event) {
    e.preventDefault();
    const trimmedTitle = title().trim();
    if (!trimmedTitle) return;
    try {
      const created = await createTask(props.workspaceId, trimmedTitle, dueAt() || undefined);
      setItems((current) => [...current, created]);
      setTitle("");
      setDueAt("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create task");
    }
  }

  async function handleStatusChange(task: Task, status: Task["status"]) {
    const previous = items();
    setItems((current) => current.map((t) => (t.id === task.id ? { ...t, status } : t)));
    try {
      await updateTaskStatus(task.id, status);
    } catch (e) {
      setItems(previous); // roll back on failure
      setError(e instanceof Error ? e.message : "Failed to update task");
    }
  }

  return (
    <div class="task-list">
      <form class="task-list__composer" onSubmit={handleCreate}>
        <input
          type="text"
          placeholder="New task…"
          value={title()}
          onInput={(e) => setTitle(e.currentTarget.value)}
        />
        <input type="date" value={dueAt()} onInput={(e) => setDueAt(e.currentTarget.value)} />
        <button type="submit" disabled={!title().trim()}>
          Add
        </button>
      </form>

      <Show when={loading()}>
        <div class="task-list__status">Loading tasks…</div>
      </Show>
      <Show when={error()}>
        <div class="task-list__status task-list__status--error">{error()}</div>
      </Show>

      <ul class="task-list__items">
        <For each={items()}>
          {(task) => (
            <li class="task-list__item">
              <span class="task-list__title">{task.title}</span>
              <Show when={task.dueAt}>
                <span class="task-list__due">{task.dueAt}</span>
              </Show>
              <select
                value={task.status}
                onChange={(e) => handleStatusChange(task, e.currentTarget.value as Task["status"])}
              >
                <For each={STATUSES}>{(s) => <option value={s}>{s}</option>}</For>
              </select>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}
