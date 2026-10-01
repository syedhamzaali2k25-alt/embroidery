import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { logIn, logOut, safeNext, signInEnabled, signUp, useSession } from "../lib/auth";
import { SiteFooter, SiteHeader } from "../lib/SiteChrome";
import { usePage } from "../lib/usePage";
import "../css/auth.css";

// Log in, Sign up and Log out. Plain white page, one centred column, Supabase Auth behind it.

function AuthPage({ title, children }: { title: string; children: ReactNode }) {
  usePage(`${title} · Stitchbook`, "auth-page");
  return (
    <>
      <div className="sheet">
        <SiteHeader />
        <main className="auth">{children}</main>
      </div>
      <SiteFooter />
    </>
  );
}

/** This build has no sign-in (no Supabase settings): say so instead of showing a form that can't work. */
function NoSignIn() {
  return (
    <div className="auth__note" role="note">
      <p>Sign-in is not set up on this server, so designs are kept on this computer only.</p>
      <p><Link to="/upload">Upload a logo</Link></p>
    </div>
  );
}

function Field({ id, label, type, value, onChange, autoComplete, help }: {
  id: string; label: string; type: string; value: string; onChange: (v: string) => void; autoComplete: string; help?: string;
}) {
  return (
    <div className="auth__field">
      <label htmlFor={id}>{label}</label>
      <input id={id} name={id} type={type} value={value} autoComplete={autoComplete} required
             aria-describedby={help ? `${id}-help` : undefined} onChange={(e) => onChange(e.target.value)} />
      {help && <p className="auth__help" id={`${id}-help`}>{help}</p>}
    </div>
  );
}

export function Login() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const { ready, session } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (ready && session) navigate(next, { replace: true });
  }, [ready, session, next, navigate]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    logIn(email.trim(), password).then((r) => {
      setBusy(false);
      if (r.ok) navigate(next, { replace: true });
      else setError(r.message);
    });
  };

  return (
    <AuthPage title="Log in">
      <h1 className="auth__title">Log <span className="accent">in</span></h1>
      {params.get("next") && <p className="auth__lede">Log in to save your design. You'll come straight back.</p>}
      {!signInEnabled ? <NoSignIn /> : (
        <form className="auth__form" onSubmit={submit} noValidate={false}>
          <Field id="email" label="Email" type="email" value={email} onChange={setEmail} autoComplete="email" />
          <Field id="password" label="Password" type="password" value={password} onChange={setPassword} autoComplete="current-password" />
          {error && <p className="auth__error" role="alert">{error}</p>}
          <button className="btn btn--ink btn--lg auth__submit" type="submit" disabled={busy}>{busy ? "Logging in…" : "Log in"}</button>
          <p className="auth__switch">No account yet? <Link to={`/signup${params.get("next") ? `?next=${encodeURIComponent(next)}` : ""}`}>Sign up</Link></p>
        </form>
      )}
    </AuthPage>
  );
}

export function Signup() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    signUp(email.trim(), password).then((r) => {
      setBusy(false);
      if (!r.ok) setError(r.message);
      else if (r.confirmEmail) setSent(true);
      else navigate(next, { replace: true });
    });
  };

  return (
    <AuthPage title="Sign up">
      <h1 className="auth__title">Sign <span className="accent">up</span></h1>
      {!signInEnabled ? <NoSignIn /> : sent ? (
        <div className="auth__note" role="status">
          <p>Check your email: we sent a link to <strong>{email.trim()}</strong>. Open it, then log in.</p>
          <p><Link to={`/login${params.get("next") ? `?next=${encodeURIComponent(next)}` : ""}`}>Go to log in</Link></p>
        </div>
      ) : (
        <form className="auth__form" onSubmit={submit}>
          <Field id="email" label="Email" type="email" value={email} onChange={setEmail} autoComplete="email" />
          <Field id="password" label="Password" type="password" value={password} onChange={setPassword}
                 autoComplete="new-password" />
          {error && <p className="auth__error" role="alert">{error}</p>}
          <button className="btn btn--ink btn--lg auth__submit" type="submit" disabled={busy}>{busy ? "Signing up…" : "Sign up"}</button>
          <p className="auth__switch">Already have an account? <Link to={`/login${params.get("next") ? `?next=${encodeURIComponent(next)}` : ""}`}>Log in</Link></p>
        </form>
      )}
    </AuthPage>
  );
}

export function Logout() {
  const [state, setState] = useState<"working" | "done" | { error: string }>(signInEnabled ? "working" : "done");
  useEffect(() => {
    if (!signInEnabled) return;
    logOut().then((r) => setState(r.ok ? "done" : { error: r.message }));
  }, []);
  return (
    <AuthPage title="Log out">
      <h1 className="auth__title">Log <span className="accent">out</span></h1>
      {!signInEnabled ? <NoSignIn /> : state === "working" ? (
        <p className="auth__lede" role="status">Logging out…</p>
      ) : state === "done" ? (
        <div className="auth__note" role="status">
          <p>You're logged out. Your designs stay saved in your account.</p>
          <p><Link className="btn btn--ink" to="/login">Log in again</Link></p>
        </div>
      ) : (
        <div className="auth__note" role="alert">
          <p>{state.error}</p>
          <p><button className="btn btn--ink" type="button" onClick={() => location.reload()}>Try again</button></p>
        </div>
      )}
    </AuthPage>
  );
}
