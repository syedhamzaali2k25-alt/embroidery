import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";

import { safeNext, signInEnabled, useSession } from "./auth";
import { count, useCredits } from "./credits";
import "../css/account.css";

// The right side of every header: one account control, only when this build has sign-in.
//   checking   nothing shown, but the slot keeps its size (no header jump)
//   signed out "Log in" (outline) + "Sign up" (ink); phones: just "Log in";
//              on /login only "Sign up", on /signup only "Log in"
//   signed in  an avatar (Google picture, else a letter on a thumbnail colour) that opens a
//              small menu: name and email, My designs, Log out

type Who = { id: string; name: string | null; email: string | null; picture: string | null };

function who(session: Session): Who {
  const meta = (session.user.user_metadata ?? {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    id: session.user.id,
    name: text(meta.full_name) ?? text(meta.name),
    email: session.user.email ?? text(meta.email),
    picture: text(meta.avatar_url) ?? text(meta.picture),
  };
}

/** The same thumbnail colour for a user every time (a small hash of the id): 1 to 4. */
export function thumbFor(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (h % 4) + 1;
}

const initial = (w: Who) => ((w.name ?? w.email ?? "?").trim()[0] ?? "?").toUpperCase();

function Avatar({ person }: { person: Who }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [person.picture]);
  if (person.picture && !broken) {
    return <img className="acct__img" src={person.picture} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} />;
  }
  return <span className={`acct__letter acct__letter--${thumbFor(person.id)}`} aria-hidden="true">{initial(person)}</span>;
}

function Menu({ person, planName, teamLink }: { person: Who; planName: string | null; teamLink: boolean }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const location = useLocation();
  const navigate = useNavigate();

  // Close on route change.
  useEffect(() => setOpen(false), [location.pathname, location.search]);

  // Close on a click or tap outside; focus moves into the menu when it opens.
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    root.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  const items = () => [...(root.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      button.current?.focus();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
      e.preventDefault();
      const list = items();
      const at = list.indexOf(document.activeElement as HTMLElement);
      const next = e.key === "Home" ? 0 : e.key === "End" ? list.length - 1
        : (at + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length;
      list[next]?.focus();
    }
    if (e.key === "Tab") setOpen(false);
  };

  return (
    <div className="acct__menu-wrap" ref={root} onKeyDown={onKey}>
      <button ref={button} className="acct__avatar" type="button" aria-label="Account menu" aria-haspopup="menu"
              aria-expanded={open} aria-controls="account-menu" onClick={() => setOpen((v) => !v)}>
        <Avatar person={person} />
      </button>
      {open && (
        <div className="acct__menu" id="account-menu" role="menu" aria-label="Account">
          <div className="acct__who" role="none">
            {person.name && <p className="acct__name">{person.name}</p>}
            {person.email && <p className="acct__email">{person.email}</p>}
            {planName && <p className="acct__plan">{planName} plan</p>}
          </div>
          <Link className="acct__item" role="menuitem" to="/home" onClick={() => setOpen(false)}>My designs</Link>
          <Link className="acct__item" role="menuitem" to="/billing" onClick={() => setOpen(false)}>Credits and plan</Link>
          <Link className="acct__item" role="menuitem" to="/exports" onClick={() => setOpen(false)}>Export history</Link>
          {teamLink && <Link className="acct__item" role="menuitem" to="/team" onClick={() => setOpen(false)}>Team</Link>}
          <button className="acct__item" role="menuitem" type="button" onClick={() => { setOpen(false); navigate("/logout"); }}>Log out</button>
        </div>
      )}
    </div>
  );
}

/** `page`: the Log in and Sign up pages each show only the other choice. */
export function AccountControl({ page }: { page?: "login" | "signup" }) {
  const { ready, session } = useSession();
  const account = useCredits();
  const location = useLocation();
  if (!signInEnabled) return null;
  if (!ready) return <div className="acct acct--checking" aria-hidden="true" data-state="checking" />;
  if (session) {
    const billing = account && account.enabled ? account : null;
    return (
      <div className="acct" data-state="in">
        {billing && (
          <Link className="acct__credits" to="/billing" aria-label={`${count(billing.available)} credits available: credits and plan`}>
            {count(billing.available)} {billing.available === 1 ? "credit" : "credits"}
          </Link>
        )}
        <Menu person={who(session)} planName={billing?.plan_name ?? null} teamLink={billing?.plan === "business"} />
      </div>
    );
  }
  // Come back to this page after logging in (the Log in / Sign up pages pass their own "next" on).
  const here = page ? safeNext(new URLSearchParams(location.search).get("next"), "") : location.pathname + location.search;
  const next = here && here !== "/" && !here.startsWith("/logout") ? `?next=${encodeURIComponent(here)}` : "";
  return (
    <div className="acct" data-state="out">
      {page !== "login" && <Link className={`btn btn--ghost btn--sm${page === "signup" ? "" : " acct__login"}`} to={`/login${next}`}>Log in</Link>}
      {page !== "signup" && <Link className={`btn btn--ink btn--sm${page === "login" ? "" : " acct__signup"}`} to={`/signup${next}`}>Sign up</Link>}
    </div>
  );
}
