import { createSignal } from "solid-js";

// -----------------------------------------------------------------------
// auth-store.ts
//
// A tiny, framework-idiomatic SolidJS auth store: a couple of signals as
// the single source of truth for the current session, persisted to
// localStorage so a page reload doesn't force a re-login. Deliberately not
// a full state-management library - this is all the app needs.
// -----------------------------------------------------------------------

export interface AuthUser {
  id: string;
  email: string;
  name?: string;
}

export interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  user: AuthUser | null;
}

const STORAGE_KEY = "workspace.auth";

function loadInitial(): AuthState {
  if (typeof localStorage === "undefined") {
    return { accessToken: null, refreshToken: null, user: null };
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { accessToken: null, refreshToken: null, user: null };
    const parsed = JSON.parse(raw) as AuthState;
    return {
      accessToken: parsed.accessToken ?? null,
      refreshToken: parsed.refreshToken ?? null,
      user: parsed.user ?? null,
    };
  } catch {
    return { accessToken: null, refreshToken: null, user: null };
  }
}

const [auth, setAuthSignal] = createSignal<AuthState>(loadInitial());

function persist(state: AuthState) {
  if (typeof localStorage === "undefined") return;
  if (!state.accessToken) {
    localStorage.removeItem(STORAGE_KEY);
  } else {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }
}

/** Read-only accessor for the current auth state (reactive signal getter). */
export const authState = auth;

/** Set the full session (e.g. after login/register/refresh mutations). */
export function setAuth(next: {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
}) {
  const state: AuthState = {
    accessToken: next.accessToken,
    refreshToken: next.refreshToken,
    user: next.user,
  };
  setAuthSignal(state);
  persist(state);
}

/** Update just the access token, e.g. after a silent refresh. */
export function setAccessToken(accessToken: string) {
  const state = { ...auth(), accessToken };
  setAuthSignal(state);
  persist(state);
}

/** Clear the session entirely (logout, or refresh failure). */
export function logout() {
  const cleared: AuthState = { accessToken: null, refreshToken: null, user: null };
  setAuthSignal(cleared);
  persist(cleared);
}

export function isAuthenticated(): boolean {
  return auth().accessToken !== null;
}
