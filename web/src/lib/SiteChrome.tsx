import { useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";

import { api, type SiteInfo } from "./api";
import { AccountControl } from "./AccountMenu";
import { Icon } from "./Icon";
import { useReveal } from "./useReveal";
import "../css/site.css";
import { APP_NAME, SHOW_PLACEHOLDERS } from "./brand";

// GET /site once per page load, shared by every page that needs it.
let siteRequest: Promise<SiteInfo> | null = null;
function loadSite(): Promise<SiteInfo> {
  siteRequest ??= api.site().catch((err) => { siteRequest = null; throw err; });
  return siteRequest;
}

export type SiteState = { site: SiteInfo | null; failed: boolean };

/** The site settings from config.py (via GET /site); `failed` if the server could not be reached. */
export function useSite(): SiteState {
  const [state, setState] = useState<SiteState>({ site: null, failed: false });
  useEffect(() => {
    let live = true;
    loadSite().then((site) => live && setState({ site, failed: false }), () => live && setState({ site: null, failed: true }));
    return () => { live = false; };
  }, []);
  return state;
}

/** The visible marker for something the owner has not decided yet. Never a made-up value. */
export function NotChosen({ what = "Not chosen yet" }: { what?: string }) {
  return <span className="not-chosen">{what}</span>;
}

/** An open owner decision on a public page: the visible marker in development and test builds,
 *  nothing in a production build. */
export function Unset({ what }: { what?: string }) {
  return SHOW_PLACEHOLDERS ? <NotChosen what={what} /> : null;
}

/** A value from the site settings: the value, "Not chosen yet", or why it is not shown. */
export function SiteValue({ state, value, render }: {
  state: SiteState; value: (s: SiteInfo) => string | number | null; render?: (v: string | number) => ReactNode;
}) {
  if (state.failed) return <span className="not-chosen">Not loaded: the server could not be reached</span>;
  if (!state.site) return <span className="site-loading">Loading…</span>;
  const v = value(state.site);
  return v === null || v === "" ? <NotChosen /> : <>{render ? render(v) : v}</>;
}

// Footer link columns. Product links point at the landing page's own sections.
export const FOOTER_COLUMNS = [
  ["Product", [["/upload", "Upload a logo"], ["/#how", "How it works"], ["/#faq", "FAQ"], ["/pricing", "Pricing"]]],
  ["Company", [["/contact", "Contact"], ["/blog", "Blog"]]],
  ["Legal", [["/privacy", "Privacy"], ["/terms", "Terms of Service"]]],
] as const;

export type NavLink = { href: string; label: string; onClick?: (e: MouseEvent<HTMLAnchorElement>) => void };

/**
 * The header of the public pages (the landing page passes its section links): sticky at the top,
 * the links inline from 900px, and a Menu button below that. The menu opens with a click, Enter or
 * Space, closes with Escape (focus back on the button), a click outside, or choosing a link. The
 * right side is the account control (nothing in offline / local mode).
 */
export function SiteHeader({ page, links = [{ href: "/pricing", label: "Pricing" }] }: { page?: "login" | "signup"; links?: NavLink[] }) {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname, location.hash]);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>("a")?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); button.current?.focus(); } };
    const outside = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", key);
    document.addEventListener("pointerdown", outside);
    return () => { document.removeEventListener("keydown", key); document.removeEventListener("pointerdown", outside); };
  }, [open]);
  const item = (l: NavLink, cls?: string) => {
    const internal = l.href.startsWith("/") && !l.href.startsWith("/#");
    const onClick = (e: MouseEvent<HTMLAnchorElement>) => { l.onClick?.(e); setOpen(false); };
    return internal
      ? <Link key={l.href} className={cls} to={l.href} onClick={onClick}>{l.label}</Link>
      : <a key={l.href} className={cls} href={l.href} onClick={onClick}>{l.label}</a>;
  };
  return (
    <header className="nav">
      <a className="brand" href="/"><Icon name="logo" />{APP_NAME}</a>
      <nav className="nav__links" aria-label="Main">{links.map((l) => item(l))}</nav>
      <div className="nav__actions">
        <AccountControl page={page} />
        <button ref={button} className="btn btn--ghost btn--sm nav__menu-btn" type="button" aria-expanded={open}
                aria-controls={id} aria-label={open ? "Close" : "Menu"} onClick={() => setOpen((v) => !v)}>
          <Icon name={open ? "i-close" : "i-menu"} /><span className="nav__menu-word" aria-hidden="true">{open ? "Close" : "Menu"}</span>
        </button>
      </div>
      <div ref={menu} id={id} className="nav__menu" hidden={!open}>
        <nav aria-label="Main (menu)">{links.map((l) => item(l, "nav__menu-link"))}</nav>
      </div>
    </header>
  );
}

/**
 * Footer on every public page (landing, upload, preview and the text pages; not the editor):
 * what Stitchbook does (only what it does today), link columns, and the copyright line with
 * company_name from config.py ("Not chosen yet" until it is chosen).
 */
export function SiteFooter({ home = false }: { home?: boolean }) {
  const state = useSite();
  return (
    <footer className="footer">
      <div className="footer__inner">
        <div className="footer__top">
          <div className="footer__about">
            <a className="brand" href="/"><Icon name="logo" />{APP_NAME}</a>
            <p className="footer__tagline">Turn a PNG or JPG logo into an embroidery file.</p>
          </div>
          <nav className="footer__cols" aria-label="Site">
            {FOOTER_COLUMNS.map(([title, links]) => (
              <div className="footer__col" key={title}>
                <h2 className="footer__heading">{title}</h2>
                <ul className="footer__list">
                  {links.map(([to, label]) => (
                    <li key={to}><Link className="footer__link" to={home && to === "/pricing" ? "/#pricing" : to}>{label}</Link></li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </div>
        <div className="footer__bottom">
          <p className="footer__copy">
            © {new Date().getFullYear()}{" "}
            {SHOW_PLACEHOLDERS ? <SiteValue state={state} value={(s) => s.company_name} /> : (state.site?.company_name || APP_NAME)}
          </p>
          <p className="footer__note">Made for people who sew.</p>
        </div>
      </div>
    </footer>
  );
}

/** "Draft: not yet reviewed by a lawyer." and the last-updated date (or its marker), on Privacy and Terms. */
export function DraftBanner({ state }: { state: SiteState }) {
  return (
    <div className="draft-banner" role="note">
      <p><strong>Draft: not yet reviewed by a lawyer.</strong></p>
      <p>Last updated: <SiteValue state={state} value={(s) => s.last_updated} /></p>
    </div>
  );
}

/** Layout of a public text page: header, a centred column, footer. */
// Text-page blocks (headings, paragraphs, lists) and blog cards below the first screen reveal on scroll.
const DOC_REVEAL = ".doc > :is(h2, h3, p, ul, ol, article, .empty-state):not(.post-list), .post-list > li";

export function SitePage({ children }: { children: ReactNode }) {
  useReveal(DOC_REVEAL);
  return (
    <>
      <div className="sheet">
        <SiteHeader />
        <main className="doc">{children}</main>
      </div>
      <SiteFooter />
    </>
  );
}
