import { createSignal, Show } from "solid-js";
import { useNavigate, A } from "@solidjs/router";
import { login } from "../lib/api";

export default function Login() {
  const navigate = useNavigate();
  const [email, setEmail] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [submitting, setSubmitting] = createSignal(false);

  async function handleSubmit(e: Event) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await login(email(), password());
      navigate("/", { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Login failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div class="auth-page">
      <form class="auth-form" onSubmit={handleSubmit}>
        <h1>Log in</h1>
        <label>
          Email
          <input
            type="email"
            required
            value={email()}
            onInput={(e) => setEmail(e.currentTarget.value)}
          />
        </label>
        <label>
          Password
          <input
            type="password"
            required
            value={password()}
            onInput={(e) => setPassword(e.currentTarget.value)}
          />
        </label>
        <Show when={error()}>
          <div class="auth-form__error">{error()}</div>
        </Show>
        <button type="submit" disabled={submitting()}>
          {submitting() ? "Logging in…" : "Log in"}
        </button>
        <p>
          No account? <A href="/register">Register</A>
        </p>
      </form>
    </div>
  );
}
