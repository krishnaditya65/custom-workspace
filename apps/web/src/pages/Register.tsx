import { createSignal, Show } from "solid-js";
import { useNavigate, A } from "@solidjs/router";
import { register } from "../lib/api";

export default function Register() {
  const navigate = useNavigate();
  const [name, setName] = createSignal("");
  const [email, setEmail] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [submitting, setSubmitting] = createSignal(false);

  async function handleSubmit(e: Event) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await register(email(), password(), name() || undefined);
      navigate("/", { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Registration failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div class="auth-page">
      <form class="auth-form" onSubmit={handleSubmit}>
        <h1>Create an account</h1>
        <label>
          Name
          <input type="text" value={name()} onInput={(e) => setName(e.currentTarget.value)} />
        </label>
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
            minLength={8}
            value={password()}
            onInput={(e) => setPassword(e.currentTarget.value)}
          />
        </label>
        <Show when={error()}>
          <div class="auth-form__error">{error()}</div>
        </Show>
        <button type="submit" disabled={submitting()}>
          {submitting() ? "Creating account…" : "Register"}
        </button>
        <p>
          Already have an account? <A href="/login">Log in</A>
        </p>
      </form>
    </div>
  );
}
