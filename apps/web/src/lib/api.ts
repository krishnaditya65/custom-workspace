import { authState, setAccessToken, setAuth, logout, type AuthUser } from "./auth-store";

// -----------------------------------------------------------------------
// api.ts - a thin, typed GraphQL client for apps/api.
//
// Deliberately not Apollo/urql: this app's data needs are simple (a handful
// of queries/mutations, no normalized cache requirements) so a small fetch
// wrapper keeps the bundle tiny and the contract explicit and readable.
//
// INTEGRATION ASSUMPTIONS (reconcile against the real apps/api schema):
//   - Endpoint is POST {VITE_API_URL}/graphql (proxied to /graphql in dev,
//     see vite.config.ts).
//   - Auth header is `Authorization: Bearer <accessToken>`.
//   - `register(email, password, name)` and `login(email, password)`
//     mutations return `{ accessToken, refreshToken, user { id email name } }`.
//   - A `refreshToken(refreshToken: String!)` mutation exists returning the
//     same shape, used for silent refresh on 401. Its exact name/shape is
//     NOT in the documented contract and is the single biggest thing to
//     reconcile with apps/api once it lands.
//   - `myWorkspaces` returns `[Workspace]`; `workspace(id)` returns one
//     `Workspace`; `channels(workspaceId)` returns `[Channel]`;
//     `messages(channelId)` returns `[Message]` (assumed newest-last, most
//     recent N - pagination args are a TODO once apps/api documents them).
//   - `sendMessage(channelId, body)` returns the created `Message`.
//   - `createChannel(workspaceId, name)` / `createWorkspace(name)` are
//     assumed mutation names/shapes (not explicitly in the contract) -
//     reconcile field names against the real schema.
//   - Tasks/Calendar (`tasks`, `createTask`, `updateTaskStatus`, `events`,
//     `createEvent`) are assumed entirely - apps/api's documented contract
//     doesn't cover them yet. Shapes below are a reasonable placeholder.
// -----------------------------------------------------------------------

export interface Workspace {
  id: string;
  name: string;
}

export interface Channel {
  id: string;
  name: string;
  workspaceId: string;
}

export interface Message {
  id: string;
  channelId: string;
  body: string;
  authorId: string;
  authorName?: string;
  createdAt: string;
}

export interface Task {
  id: string;
  workspaceId: string;
  title: string;
  status: "todo" | "in_progress" | "done";
  dueAt?: string | null;
}

export interface CalendarEvent {
  id: string;
  workspaceId: string;
  title: string;
  startAt: string;
  endAt: string;
}

export interface AuthPayload {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
}

const API_URL: string =
  (import.meta as any).env?.VITE_API_URL ?? "";

// Same-origin `/graphql` in dev thanks to the Vite proxy; falls back to
// `${API_URL}/graphql` for prod builds where there's no dev-server proxy.
function graphqlEndpoint(): string {
  if (API_URL) return `${API_URL.replace(/\/$/, "")}/graphql`;
  return "/graphql";
}

class GraphQLError extends Error {
  constructor(
    message: string,
    public errors: unknown[],
  ) {
    super(message);
    this.name = "GraphQLError";
  }
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
}

let inFlightRefresh: Promise<boolean> | null = null;

/**
 * Attempt a silent refresh using the stored refresh token. Deduplicated so
 * concurrent 401s only trigger one network round-trip.
 */
async function silentRefresh(): Promise<boolean> {
  if (inFlightRefresh) return inFlightRefresh;

  const { refreshToken } = authState();
  if (!refreshToken) return false;

  inFlightRefresh = (async () => {
    try {
      const res = await fetch(graphqlEndpoint(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `
            mutation RefreshToken($refreshToken: String!) {
              refreshToken(refreshToken: $refreshToken) {
                accessToken
                refreshToken
                user { id email name }
              }
            }
          `,
          variables: { refreshToken },
        }),
      });
      const json = (await res.json()) as GraphQLResponse<{ refreshToken: AuthPayload }>;
      if (json.errors || !json.data?.refreshToken) {
        logout();
        return false;
      }
      setAccessToken(json.data.refreshToken.accessToken);
      return true;
    } catch {
      logout();
      return false;
    } finally {
      inFlightRefresh = null;
    }
  })();

  return inFlightRefresh;
}

/**
 * Core GraphQL request helper. Retries exactly once, after a silent
 * refresh, if the server responds with an auth error (HTTP 401, or a
 * GraphQL error with extensions.code === "UNAUTHENTICATED").
 */
async function request<T>(
  query: string,
  variables?: Record<string, unknown>,
  opts: { skipAuth?: boolean; _retried?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = authState().accessToken;
  if (token && !opts.skipAuth) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(graphqlEndpoint(), {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  });

  if (res.status === 401 && !opts.skipAuth && !opts._retried) {
    const refreshed = await silentRefresh();
    if (refreshed) {
      return request<T>(query, variables, { ...opts, _retried: true });
    }
  }

  const json = (await res.json()) as GraphQLResponse<T>;

  if (json.errors?.length) {
    const isAuthError = json.errors.some((e) => e.extensions?.code === "UNAUTHENTICATED");
    if (isAuthError && !opts.skipAuth && !opts._retried) {
      const refreshed = await silentRefresh();
      if (refreshed) {
        return request<T>(query, variables, { ...opts, _retried: true });
      }
    }
    throw new GraphQLError(json.errors.map((e) => e.message).join("; "), json.errors);
  }

  if (!json.data) {
    throw new GraphQLError("GraphQL response missing data", []);
  }

  return json.data;
}

// ------------------------------- Auth -----------------------------------

export async function login(email: string, password: string): Promise<AuthPayload> {
  const result = await request<{ login: AuthPayload }>(
    `
      mutation Login($email: String!, $password: String!) {
        login(email: $email, password: $password) {
          accessToken
          refreshToken
          user { id email name }
        }
      }
    `,
    { email, password },
    { skipAuth: true },
  );
  setAuth(result.login);
  return result.login;
}

export async function register(
  email: string,
  password: string,
  name?: string,
): Promise<AuthPayload> {
  const result = await request<{ register: AuthPayload }>(
    `
      mutation Register($email: String!, $password: String!, $name: String) {
        register(email: $email, password: $password, name: $name) {
          accessToken
          refreshToken
          user { id email name }
        }
      }
    `,
    { email, password, name },
    { skipAuth: true },
  );
  setAuth(result.register);
  return result.register;
}

// ----------------------------- Workspaces --------------------------------

export async function myWorkspaces(): Promise<Workspace[]> {
  const result = await request<{ myWorkspaces: Workspace[] }>(`
    query MyWorkspaces {
      myWorkspaces { id name }
    }
  `);
  return result.myWorkspaces;
}

export async function workspace(id: string): Promise<Workspace> {
  const result = await request<{ workspace: Workspace }>(
    `
      query Workspace($id: ID!) {
        workspace(id: $id) { id name }
      }
    `,
    { id },
  );
  return result.workspace;
}

export async function createWorkspace(name: string): Promise<Workspace> {
  const result = await request<{ createWorkspace: Workspace }>(
    `
      mutation CreateWorkspace($name: String!) {
        createWorkspace(name: $name) { id name }
      }
    `,
    { name },
  );
  return result.createWorkspace;
}

// ------------------------------ Channels ----------------------------------

export async function channels(workspaceId: string): Promise<Channel[]> {
  const result = await request<{ channels: Channel[] }>(
    `
      query Channels($workspaceId: ID!) {
        channels(workspaceId: $workspaceId) { id name workspaceId }
      }
    `,
    { workspaceId },
  );
  return result.channels;
}

export async function createChannel(workspaceId: string, name: string): Promise<Channel> {
  const result = await request<{ createChannel: Channel }>(
    `
      mutation CreateChannel($workspaceId: ID!, $name: String!) {
        createChannel(workspaceId: $workspaceId, name: $name) { id name workspaceId }
      }
    `,
    { workspaceId, name },
  );
  return result.createChannel;
}

// ------------------------------ Messages ----------------------------------

export async function messages(channelId: string): Promise<Message[]> {
  const result = await request<{ messages: Message[] }>(
    `
      query Messages($channelId: ID!) {
        messages(channelId: $channelId) {
          id channelId body authorId authorName createdAt
        }
      }
    `,
    { channelId },
  );
  return result.messages;
}

export async function sendMessage(channelId: string, body: string): Promise<Message> {
  const result = await request<{ sendMessage: Message }>(
    `
      mutation SendMessage($channelId: ID!, $body: String!) {
        sendMessage(channelId: $channelId, body: $body) {
          id channelId body authorId authorName createdAt
        }
      }
    `,
    { channelId, body },
  );
  return result.sendMessage;
}

// -------------------------- Tasks (assumed API) ----------------------------
// NOT part of the documented apps/api contract - placeholder shapes to
// reconcile once tasks/calendar land server-side.

export async function tasks(workspaceId: string): Promise<Task[]> {
  const result = await request<{ tasks: Task[] }>(
    `
      query Tasks($workspaceId: ID!) {
        tasks(workspaceId: $workspaceId) { id workspaceId title status dueAt }
      }
    `,
    { workspaceId },
  );
  return result.tasks;
}

export async function createTask(
  workspaceId: string,
  title: string,
  dueAt?: string,
): Promise<Task> {
  const result = await request<{ createTask: Task }>(
    `
      mutation CreateTask($workspaceId: ID!, $title: String!, $dueAt: String) {
        createTask(workspaceId: $workspaceId, title: $title, dueAt: $dueAt) {
          id workspaceId title status dueAt
        }
      }
    `,
    { workspaceId, title, dueAt },
  );
  return result.createTask;
}

export async function updateTaskStatus(id: string, status: Task["status"]): Promise<Task> {
  const result = await request<{ updateTaskStatus: Task }>(
    `
      mutation UpdateTaskStatus($id: ID!, $status: String!) {
        updateTaskStatus(id: $id, status: $status) {
          id workspaceId title status dueAt
        }
      }
    `,
    { id, status },
  );
  return result.updateTaskStatus;
}

// ------------------------- Calendar (assumed API) ---------------------------

export async function events(workspaceId: string): Promise<CalendarEvent[]> {
  const result = await request<{ events: CalendarEvent[] }>(
    `
      query Events($workspaceId: ID!) {
        events(workspaceId: $workspaceId) { id workspaceId title startAt endAt }
      }
    `,
    { workspaceId },
  );
  return result.events;
}

export async function createEvent(
  workspaceId: string,
  title: string,
  startAt: string,
  endAt: string,
): Promise<CalendarEvent> {
  const result = await request<{ createEvent: CalendarEvent }>(
    `
      mutation CreateEvent($workspaceId: ID!, $title: String!, $startAt: String!, $endAt: String!) {
        createEvent(workspaceId: $workspaceId, title: $title, startAt: $startAt, endAt: $endAt) {
          id workspaceId title startAt endAt
        }
      }
    `,
    { workspaceId, title, startAt, endAt },
  );
  return result.createEvent;
}
