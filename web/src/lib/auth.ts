// Sign-in with Supabase Auth. The browser only ever gets the project URL, the publishable key and
// the (public) Google OAuth client ID (vite.config.ts names exactly those three); the Supabase
// secret key and the Google client secret never reach the web app.
// Google: "Continue with Google" (redirect through Supabase, PKCE) and Google One Tap (Google's
// ID token, checked by Supabase with a nonce).
// Built without them (`--mode offline`, or no SUPABASE_URL in .env), there is no sign-in at all,
// matching the API's local mode.
import { useEffect, useState } from "react";
import type { Session, SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = import.meta.env.STITCHBOOK_SUPABASE_URL as string;
const PUBLISHABLE_KEY = import.meta.env.STITCHBOOK_SUPABASE_PUBLISHABLE_KEY as string;
/** Google OAuth client ID (public). Empty: no One Tap popup; "Continue with Google" still works. */
export const GOOGLE_CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) || "";

/** True when this build has sign-in (Supabase settings were present at build time). */
export const signInEnabled = Boolean(SUPABASE_URL && PUBLISHABLE_KEY);

// supabase-js loads on first use, so pages that never ask about sign-in don't download it.
let client: Promise<SupabaseClient> | null = null;
function supabase(): Promise<SupabaseClient> {
  client ??= import("@supabase/supabase-js").then(({ createClient }) =>
    // PKCE: Google sends the visitor back to /login?code=..., and supabase-js swaps the code for a
    // session on load (detectSessionInUrl) using the verifier it kept before leaving.
    createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" },
    }));
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
  cancelOneTap();
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

// ---------- Google: "Continue with Google" (redirect) ----------

const NEXT_KEY = "stitchbook.next";

/** The page to return to after the Google round trip (same tab only, same-site paths only). */
export function takeSavedNext(): string | null {
  try {
    const next = sessionStorage.getItem(NEXT_KEY);
    sessionStorage.removeItem(NEXT_KEY);
    return next && safeNext(next, "") ? next : null;
  } catch {
    return null;
  }
}

/**
 * Leaves for Google through Supabase and comes back to /login, which finishes the session and
 * goes on to `next`. Before leaving, Supabase is asked once without following the redirect, so a
 * provider that is turned off shows Supabase's own message here instead of a bare error page.
 * Returns only on failure (on success the browser is on its way to Google).
 */
export async function signInWithGoogle(next: string): Promise<AuthResult> {
  const sb = await supabase();
  const { data, error } = await sb.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: `${location.origin}/login`, skipBrowserRedirect: true },
  });
  if (error || !data?.url) return { ok: false, message: plain(error?.message) };
  try {
    const probe = await fetch(data.url, { redirect: "manual" });
    if (probe.type !== "opaqueredirect" && !probe.ok) {
      const body = await probe.json().catch(() => null);
      const msg = body?.msg ?? body?.error_description ?? body?.message;
      if (typeof msg === "string") return { ok: false, message: `Google sign-in is not available: ${plain(msg)}` };
    }
  } catch {
    // Could not ask first (network, CORS): go anyway; Supabase shows its own page if it refuses.
  }
  try { sessionStorage.setItem(NEXT_KEY, safeNext(next)); } catch { /* the default page then */ }
  location.assign(data.url);
  return { ok: true };
}

/** What Google or Supabase said when sending the visitor back to /login, in plain words; null if nothing. */
export function oauthReturnError(search: string, hash: string): string | null {
  const params = new URLSearchParams(search);
  const fromHash = new URLSearchParams(hash.replace(/^#/, ""));
  const error = params.get("error") ?? fromHash.get("error");
  if (!error) return null;
  const description = params.get("error_description") ?? fromHash.get("error_description") ?? "";
  if (error === "access_denied" && !/provider|disabled|not enabled/i.test(description)) {
    return "Google sign-in was cancelled. Try again, or log in with your email and password.";
  }
  return `Google sign-in didn't work: ${plain(description || error)}`;
}

/** After the Google round trip: the code exchange's error, if it failed (null when it worked). */
export async function finishGoogleReturn(): Promise<string | null> {
  const { error } = await (await supabase()).auth.initialize();
  return error ? `Google sign-in didn't work: ${plain(error.message)}` : null;
}

// ---------- Google One Tap ----------

type GoogleId = {
  initialize: (options: Record<string, unknown>) => void;
  prompt: (listener?: (notification: unknown) => void) => void;
  cancel: () => void;
  disableAutoSelect: () => void;
};
declare global {
  interface Window { google?: { accounts?: { id?: GoogleId } } }
}

const GSI_SRC = "https://accounts.google.com/gsi/client";
let gsiScript: Promise<GoogleId> | null = null;

function loadGoogleIdentity(): Promise<GoogleId> {
  gsiScript ??= new Promise<GoogleId>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = GSI_SRC;
    script.async = true;
    script.onload = () => (window.google?.accounts?.id ? resolve(window.google.accounts.id) : reject(new Error("no google.accounts.id")));
    script.onerror = () => { gsiScript = null; reject(new Error("blocked")); };
    document.head.append(script);
  });
  return gsiScript;
}

/** Cancels the One Tap popup if it is showing (leaving Log in / Sign up, logging out). */
export function cancelOneTap(): void {
  try {
    window.google?.accounts?.id?.cancel();
    window.google?.accounts?.id?.disableAutoSelect();
  } catch { /* nothing showing */ }
}

const toHex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** A fresh random nonce and its SHA-256 (hex): Google gets the hash, Supabase the raw value. */
export async function makeNonce(): Promise<{ raw: string; hashed: string }> {
  const raw = toHex(crypto.getRandomValues(new Uint8Array(32)).buffer);
  const hashed = toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw)));
  return { raw, hashed };
}

/**
 * Shows Google One Tap (only with a client ID). When the visitor picks an account, Google's ID
 * token goes to Supabase with the raw nonce; Supabase checks it against the hash inside the token.
 * Dismissed, blocked or switched off by the browser: nothing is shown, the button still works.
 * `onError` gets a plain message only when Supabase refuses a token. Returns a cancel function.
 */
export function startOneTap(onDone: () => void, onError: (message: string) => void): () => void {
  if (!signInEnabled || !GOOGLE_CLIENT_ID) return () => {};
  let live = true;
  (async () => {
    const nonce = await makeNonce();
    const id = await loadGoogleIdentity();
    if (!live) return;
    id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      nonce: nonce.hashed,
      use_fedcm_for_prompt: true,
      cancel_on_tap_outside: true,
      itp_support: true,
      callback: async (response: { credential?: string }) => {
        if (!live || !response.credential) return;
        const sb = await supabase();
        const { error } = await sb.auth.signInWithIdToken({ provider: "google", token: response.credential, nonce: nonce.raw });
        if (error) onError("Google sign-in could not be finished. Use \u201cContinue with Google\u201d or your email and password.");
        else onDone();
      },
    });
    id.prompt(); // dismissed, skipped or not displayed: nothing to do
  })().catch(() => { /* script blocked or unavailable: the button is the fallback */ });
  return () => { live = false; cancelOneTap(); };
}
