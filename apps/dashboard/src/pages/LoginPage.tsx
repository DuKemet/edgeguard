import { useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";

interface LocationState {
  from?: string;
}

export function LoginPage() {
  const { user, initializing, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!initializing && user) {
    return <Navigate to="/" replace />;
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(username.trim(), password);
      const state = location.state as LocationState | null;
      navigate(state?.from ?? "/", { replace: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to sign in");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="login-shell">
      <section className="login-hero">
        <div className="brand">
          <span className="brand-mark large" aria-hidden="true">
            EG
          </span>
          <span className="brand-copy">
            <strong>EdgeGuard</strong>
            <small>API protection platform</small>
          </span>
        </div>
        <div className="hero-copy">
          <h1>Protect the edge, not just the endpoint.</h1>
          <p>
            Distributed token-bucket limiting, explainable detection events and temporary client
            isolation, with a live operational dashboard.
          </p>
        </div>
        <ul className="hero-list">
          <li>
            <strong>Atomic limiting</strong>
            <span>Redis Lua token buckets shared across gateway replicas.</span>
          </li>
          <li>
            <strong>Explainable detection</strong>
            <span>Observed values, thresholds and actions for every finding.</span>
          </li>
          <li>
            <strong>Graceful degradation</strong>
            <span>Local fallback limits and readiness signal during Redis outages.</span>
          </li>
        </ul>
      </section>

      <section className="login-panel">
        <form className="login-card" onSubmit={handleSubmit}>
          <div>
            <h2>Sign in</h2>
            <p className="muted">Use the credentials configured for the gateway.</p>
          </div>
          {error ? (
            <div className="error-banner" role="alert">
              <div>
                <strong>Sign-in failed</strong>
                <p>{error}</p>
              </div>
            </div>
          ) : null}
          <label className="field">
            <span className="field-label">Username</span>
            <input
              type="text"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="admin"
              required
              autoFocus
            />
          </label>
          <label className="field">
            <span className="field-label">Password</span>
            <div className="password-field">
              <input
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="••••••••"
                required
                minLength={8}
              />
              <button
                type="button"
                className="button ghost small"
                onClick={() => setShowPassword((current) => !current)}
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? "Hide" : "Show"}
              </button>
            </div>
          </label>
          <button type="submit" className="button primary full" disabled={submitting}>
            {submitting ? "Signing in…" : "Sign in"}
          </button>
          <p className="muted tiny">
            Sessions expire automatically. Failed attempts are throttled per client.
          </p>
        </form>
      </section>
    </div>
  );
}
