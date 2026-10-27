import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { createEvent, events as fetchEvents, type CalendarEvent } from "../../lib/api";

// -----------------------------------------------------------------------
// CalendarView.tsx - a simple week-grid calendar.
//
// Same integration caveat as TaskList.tsx: `events`/`createEvent` are
// assumed API shapes, not part of the documented GraphQL contract.
// -----------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfWeek(date: Date): Date {
  const normalized = new Date(date);
  const day = normalized.getDay(); // 0 = Sunday
  normalized.setHours(0, 0, 0, 0);
  normalized.setDate(normalized.getDate() - day);
  return normalized;
}

export default function CalendarView(props: { workspaceId: string }) {
  const [items, setItems] = createSignal<CalendarEvent[]>([]);
  const [weekStart, setWeekStart] = createSignal(startOfWeek(new Date()));
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [title, setTitle] = createSignal("");
  const [startAt, setStartAt] = createSignal("");
  const [endAt, setEndAt] = createSignal("");

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setItems(await fetchEvents(props.workspaceId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load events");
    } finally {
      setLoading(false);
    }
  }

  createEffect(() => {
    props.workspaceId;
    void load();
  });

  const days = createMemo(() =>
    Array.from({ length: 7 }, (_, i) => new Date(weekStart().getTime() + i * DAY_MS)),
  );

  function eventsForDay(day: Date): CalendarEvent[] {
    const dayStart = new Date(day);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart.getTime() + DAY_MS);
    return items().filter((ev) => {
      const start = new Date(ev.startAt);
      return start >= dayStart && start < dayEnd;
    });
  }

  async function handleCreate(e: Event) {
    e.preventDefault();
    if (!title().trim() || !startAt() || !endAt()) return;
    try {
      const created = await createEvent(props.workspaceId, title().trim(), startAt(), endAt());
      setItems((current) => [...current, created]);
      setTitle("");
      setStartAt("");
      setEndAt("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create event");
    }
  }

  return (
    <div class="calendar-view">
      <div class="calendar-view__nav">
        <button onClick={() => setWeekStart((d) => new Date(d.getTime() - 7 * DAY_MS))}>Previous</button>
        <span>
          Week of {weekStart().toLocaleDateString()}
        </span>
        <button onClick={() => setWeekStart((d) => new Date(d.getTime() + 7 * DAY_MS))}>Next</button>
      </div>

      <form class="calendar-view__composer" onSubmit={handleCreate}>
        <input
          type="text"
          placeholder="Event title…"
          value={title()}
          onInput={(e) => setTitle(e.currentTarget.value)}
        />
        <input type="datetime-local" value={startAt()} onInput={(e) => setStartAt(e.currentTarget.value)} />
        <input type="datetime-local" value={endAt()} onInput={(e) => setEndAt(e.currentTarget.value)} />
        <button type="submit">Add event</button>
      </form>

      <Show when={loading()}>
        <div class="calendar-view__status">Loading events…</div>
      </Show>
      <Show when={error()}>
        <div class="calendar-view__status calendar-view__status--error">{error()}</div>
      </Show>

      <div class="calendar-view__grid">
        <For each={days()}>
          {(day) => (
            <div class="calendar-view__day">
              <div class="calendar-view__day-header">
                {day.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
              </div>
              <div class="calendar-view__day-events">
                <For each={eventsForDay(day)}>
                  {(ev) => (
                    <div class="calendar-view__event">
                      <strong>{ev.title}</strong>
                      <div class="calendar-view__event-time">
                        {new Date(ev.startAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        {" – "}
                        {new Date(ev.endAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
