// Sign-in with Supabase Auth. The browser only ever gets the project URL and the publishable
// key (vite.config.ts names exactly those two); the secret key stays on the server.
// Built without them (`--mode offline`, or no SUPABASE_URL in .env), there is no sign-in at all,
// matching the API's local mode.
import { useEffect, useState } from "react";
import type { Session, SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = import.meta.env.STITCHBOOK_SUPABASE_URL as string;
const PUBLISHABLE_KEY = import.meta.env.STITCHBOOK_SUPABASE_PUBLISHABLE_KEY as string;

/** True when this build has sign-in (Supabase settings were present at build time). */
export const signInEnabled = Boolean(SUPABASE_URL && PUBLISHABLE_KEY);

// supabase-js loads on first use, so pages that never ask about sign-in don't download it.
let client: Promise<SupabaseClient> | null = null;
function supabase(): Promise<SupabaseClient> {
  client ??= import("@supabase/supabase-js").then(({ createClient }) =>
    createClient(SUPABASE_URL, PUBLISHABLE_KEY, { auth: { persistSession: true, autoRefreshToken: true } }));
  return client;
}

/** The current access token (refreshed if needed), or null when signed out or without sign-in. */
export async function accessToken(): Promise<string | null> {
  if (!signInEnabled) return null;
  const { data } = await (await supabase()).auth.getSession();
  return data.session?.access_token ?? null;
}

export type AuthState = { ready: boolean; session: Session | null };

/** The signed-in session, kept up to date (sign in, sign out, token refresh). */
export function useSession(): AuthState {
  const [state, setState] = useState<AuthState>({ ready: !signInEnabled, session: null });
  useEffect(() => {
    if (!signInEnabled) return;
    let live = true;
    let unsubscribe = () => {};
    supabase().then((sb) => {
      sb.auth.getSession().then(({ data }) => live && setState({ ready: true, session: data.session }));
      const { data } = sb.auth.onAuthStateChange((_event, session) => live && setState({ ready: true, session }));
      unsubscribe = () => data.subscription.unsubscribe();
    }, () => live && setState({ ready: true, session: null }));
    return () => { live = false; unsubscribe(); };
  }, []);
  return state;
}

/** Plain messages for what Supabase Auth answers; never shows a raw error code alone. */
function plain(message: string | undefined): string {
  const m = (message || "").toLowerCase();
  if (m.includes("invalid login credentials")) return "That email and password don't match an account. Check them and try again.";
  if (m.includes("email not confirmed")) return "Confirm your email first: open the link in the email we sent, then log in.";
  if (m.includes("already registered") || m.includes("already been registered")) return "An account with this email already exists. Log in instead.";
  if (m.includes("password")) return message!.endsWith(".") ? message! : `${message}.`;
  if (m.includes("fetch") || m.includes("network")) return "Can't reach the sign-in service. Check your connection and try again.";
  return message ? (message.endsWith(".") ? message : `${message}.`) : "Something went wrong. Try again.";
}

export type AuthResult = { ok: true; confirmEmail?: boolean } | { ok: false; message: string };

export async function signUp(email: string, password: string): Promise<AuthResult> {
  const sb = await supabase();
  const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: `${location.origin}/login` } });
  if (error) return { ok: false, message: plain(error.message) };
  // With email confirmation on (the Supabase default), there is no session until the link is opened.
  return { ok: true, confirmEmail: !data.session };
}

export async function logIn(email: string, password: string): Promise<AuthResult> {
  const sb = await supabase();
  const { error } = await sb.auth.signInWithPassword({ email, password });
  return error ? { ok: false, message: plain(error.message) } : { ok: true };
}

export async function logOut(): Promise<AuthResult> {
  const sb = await supabase();
  const { error } = await sb.auth.signOut();
  return error ? { ok: false, message: plain(error.message) } : { ok: true };
}

/** Only same-site paths are followed after logging in (never another site's address). */
export function safeNext(next: string | null, fallback = "/home"): string {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : fallback;
}

/** Where to send a visitor who must log in first, coming back to `here` afterwards. */
export const loginPath = (here: string) => `/login?next=${encodeURIComponent(here)}`;
