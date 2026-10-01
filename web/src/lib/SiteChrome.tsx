import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { api, type SiteInfo } from "./api";
import { Icon } from "./Icon";
import "../css/site.css";

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

/** A value from the site settings: the value, "Not chosen yet", or why it is not shown. */
export function SiteValue({ state, value, render }: {
  state: SiteState; value: (s: SiteInfo) => string | number | null; render?: (v: string | number) => ReactNode;
}) {
  if (state.failed) return <span className="not-chosen">Not loaded: the server could not be reached</span>;
  if (!state.site) return <span className="site-loading">Loading…</span>;
  const v = value(state.site);
  return v === null || v === "" ? <NotChosen /> : <>{render ? render(v) : v}</>;
}

export const FOOTER_LINKS = [
  ["/privacy", "Privacy"],
  ["/terms", "Terms of Service"],
  ["/contact", "Contact"],
  ["/blog", "Blog"],
] as const;

/** Header for the public pages (Privacy, Terms, Contact, Blog). */
export function SiteHeader() {
  return (
    <header className="nav">
      <a className="brand" href="/"><Icon name="logo" />Stitchbook</a>
      <div className="nav__actions">
        <a className="btn btn--ink btn--sm" href="/upload">Upload a logo</a>
      </div>
    </header>
  );
}

/** Footer on every public page (landing, upload, preview, and the pages it links to). */
export function SiteFooter() {
  return (
    <footer className="footer">
      <a className="brand" href="/"><Icon name="logo" />Stitchbook</a>
      <nav className="footer__links" aria-label="Site">
        {FOOTER_LINKS.map(([to, label]) => <Link key={to} to={to}>{label}</Link>)}
      </nav>
      <p className="footer__note">Made for people who sew.</p>
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
export function SitePage({ children }: { children: ReactNode }) {
  return (
    <div className="sheet">
      <SiteHeader />
      <main className="doc">{children}</main>
      <SiteFooter />
    </div>
  );
}
