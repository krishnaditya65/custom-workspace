import { Route, Router, Navigate } from "@solidjs/router";
import type { RouteSectionProps } from "@solidjs/router";
import { Show, type JSX } from "solid-js";
import Login from "./pages/Login";
import Register from "./pages/Register";
import Home from "./pages/Home";
import WorkspaceShell from "./pages/WorkspaceShell";
import ChannelView from "./pages/ChannelView";
import { isAuthenticated } from "./lib/auth-store";

/**
 * Simple route guard: redirect to /login if there's no session.
 *
 * `when={isAuthenticated()}` is passed as a JSX expression rather than
 * evaluated in the component body, so Solid's compiler wraps it as a
 * reactive getter - the guard re-evaluates (and redirects) the moment
 * `logout()` clears the auth signal, not just on next navigation.
 */
function RequireAuth(props: { children?: JSX.Element }) {
  return (
    <Show when={isAuthenticated()} fallback={<Navigate href="/login" />}>
      {props.children}
    </Show>
  );
}

export default function App() {
  return (
    <Router>
      <Route path="/login" component={Login} />
      <Route path="/register" component={Register} />
      <Route
        path="/"
        component={() => (
          <RequireAuth>
            <Home />
          </RequireAuth>
        )}
      />
      <Route
        path="/w/:workspaceId"
        component={(props: RouteSectionProps) => (
          <RequireAuth>
            {/* Forward the router's props (params, and crucially `children`
                for the nested /c/:channelId route) through to WorkspaceShell -
                RequireAuth itself only cares about its own `children` slot. */}
            <WorkspaceShell {...props} />
          </RequireAuth>
        )}
      >
        <Route path="/c/:channelId" component={ChannelView} />
      </Route>
    </Router>
  );
}
