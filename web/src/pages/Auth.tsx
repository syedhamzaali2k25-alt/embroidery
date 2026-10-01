import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import {
  finishGoogleReturn, logIn, logOut, oauthReturnError, safeNext, signInEnabled, signInWithGoogle, signUp, startOneTap,
  takeSavedNext, useSession,
} from "../lib/auth";
import { TextField } from "../lib/Field";
import { Icon } from "../lib/Icon";
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

/** Email and password, the same everywhere: visible labels, the shared field style, plain messages. */
function EmailField({ value, onChange, error }: { value: string; onChange: (v: string) => void; error?: string }) {
  return (
    <TextField id="email" name="email" label="Email" type="email" inputMode="email" autoComplete="email"
               autoCapitalize="none" spellCheck={false} placeholder="you@example.com" value={value} error={error}
               onChange={(e) => onChange(e.target.value)} />
  );
}

function PasswordField({ value, onChange, error, isNew }: {
  value: string; onChange: (v: string) => void; error?: string; isNew?: boolean;
}) {
  return (
    <TextField id="password" name="password" label="Password" type="password" autoComplete={isNew ? "new-password" : "current-password"}
               autoCapitalize="none" spellCheck={false} value={value} error={error} onChange={(e) => onChange(e.target.value)} />
  );
}

type FieldErrors = { email?: string; password?: string };
/** Checked before anything is sent: an empty field or an email address without its parts. */
function checkFields(email: string, password: string): FieldErrors {
  const errors: FieldErrors = {};
  if (!email.trim()) errors.email = "Enter your email address.";
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) errors.email = "Enter an email address like you@example.com.";
  if (!password) errors.password = "Enter your password.";
  return errors;
}

/** A message about the whole form (e.g. Supabase refused the log-in): icon + text, announced. */
function FormMessage({ children }: { children: ReactNode }) {
  return <p className="form-msg" role="alert"><Icon name="i-alert" />{children}</p>;
}

/** "Continue with Google" and the "or" divider above the email form; One Tap runs alongside. */
function GoogleChoice({ next, error }: { next: string; error: string | null }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const { ready, session } = useSession();
  // One Tap only for someone not signed in, only on these screens; cancelled when leaving.
  useEffect(() => {
    if (!ready || session) return;
    return startOneTap(() => {}, setFailed);
  }, [ready, session]);
  const go = () => {
    setBusy(true);
    setFailed(null);
    signInWithGoogle(next).then((r) => {
      if (!r.ok) { setBusy(false); setFailed(r.message); }
    });
  };
  const message = failed ?? error;
  return (
    <div className="auth__google">
      <button className="btn btn--ink btn--lg auth__submit" type="button" onClick={go} disabled={busy}>
        {busy ? "Opening Google…" : "Continue with Google"}
      </button>
      {message && <FormMessage>{message}</FormMessage>}
      <p className="auth__or"><span>or</span></p>
    </div>
  );
}

export function Login() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  // Back from Google: the page saved before leaving (the redirect itself carries no "next").
  const [returned] = useState(() => (params.get("code") || params.get("error") || location.hash.includes("error=")
    ? { next: takeSavedNext(), error: oauthReturnError(location.search, location.hash) } : null));
  const next = safeNext(params.get("next") ?? returned?.next ?? null);
  const { ready, session } = useSession();
  const [googleError, setGoogleError] = useState<string | null>(returned?.error ?? null);
  useEffect(() => {
    if (returned && !returned.error && params.get("code")) finishGoogleReturn().then((e) => e && setGoogleError(e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (ready && session) navigate(next, { replace: true });
  }, [ready, session, next, navigate]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errors = checkFields(email, password);
    setFieldErrors(errors);
    if (errors.email || errors.password) {
      document.getElementById(errors.email ? "email" : "password")?.focus();
      return;
    }
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
        <form className="auth__form" onSubmit={submit} noValidate>
          <GoogleChoice next={next} error={googleError} />
          <EmailField value={email} onChange={(v) => { setEmail(v); setFieldErrors((f) => ({ ...f, email: undefined })); }}
                      error={fieldErrors.email} />
          <PasswordField value={password} onChange={(v) => { setPassword(v); setFieldErrors((f) => ({ ...f, password: undefined })); }}
                         error={fieldErrors.password} />
          {error && <FormMessage>{error}</FormMessage>}
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
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const { ready, session } = useSession();
  useEffect(() => { // signed in with Google One Tap from here
    if (ready && session) navigate(next, { replace: true });
  }, [ready, session, next, navigate]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errors = checkFields(email, password);
    if (errors.password) errors.password = "Choose a password.";
    setFieldErrors(errors);
    if (errors.email || errors.password) {
      document.getElementById(errors.email ? "email" : "password")?.focus();
      return;
    }
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
        <form className="auth__form" onSubmit={submit} noValidate>
          <GoogleChoice next={next} error={null} />
          <EmailField value={email} onChange={(v) => { setEmail(v); setFieldErrors((f) => ({ ...f, email: undefined })); }}
                      error={fieldErrors.email} />
          <PasswordField value={password} onChange={(v) => { setPassword(v); setFieldErrors((f) => ({ ...f, password: undefined })); }}
                         error={fieldErrors.password} isNew />
          {error && <FormMessage>{error}</FormMessage>}
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
