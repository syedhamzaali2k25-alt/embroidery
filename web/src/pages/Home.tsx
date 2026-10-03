import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { api, ApiError, needsLogin, type DesignSummary } from "../lib/api";
import { AccountControl } from "../lib/AccountMenu";
import { loginPath, signInEnabled, useSession } from "../lib/auth";
import { usePage } from "../lib/usePage";
import "../css/home.css";
import { APP_NAME, titled } from "../lib/brand";

type Load = { status: "loading" } | { status: "ready"; designs: DesignSummary[] } | { status: "error"; message: string };

const DATE = new Intl.DateTimeFormat("en", { day: "numeric", month: "short", year: "numeric" });

/** "My designs": the signed-in user's designs (GET /designs), newest first, and a way to start one. */
export default function Home() {
  usePage(titled("My designs"), "home");
  const auth = useSession();
  const [load, setLoad] = useState<Load>({ status: "loading" });

  const fetchDesigns = useCallback(() => {
    setLoad({ status: "loading" });
    api.designs().then(
      (designs) => setLoad({ status: "ready", designs }),
      (err) => {
        if (needsLogin(err)) return; // the API client is already taking the visitor to log in
        setLoad({ status: "error", message: err instanceof ApiError ? err.message : "Your designs could not be loaded. Try again." });
      },
    );
  }, []);

  useEffect(() => {
    if (!auth.ready) return;
    if (signInEnabled && !auth.session) {
      location.assign(loginPath("/home"));
      return;
    }
    fetchDesigns();
  }, [auth.ready, auth.session, fetchDesigns]);

  return (
    <div className="sheet app">
      <aside className="side">
        <a className="brand" href="/"><svg aria-hidden="true"><use href="/assets/sprite.svg#logo"/></svg>{APP_NAME}</a>
        <nav className="side__nav" aria-label="Sections">
          <a href="/home" aria-current="page"><svg aria-hidden="true"><use href="/assets/sprite.svg#i-grid"/></svg>My designs</a>
        </nav>
      </aside>

      <main className="main">
        {signInEnabled && <div className="topbar"><div className="topbar__right"><AccountControl /></div></div>}
        <section className="welcome">
          <div>
            <h1>My <span className="accent">designs</span></h1>
            <p className="welcome__sub">
              {signInEnabled
                ? "Every logo you upload is saved here, in your account. Only you can see them."
                : "Sign-in is not set up on this server, so this list shows the designs kept on this computer."}
            </p>
          </div>
        </section>

        <section className="starts" aria-labelledby="starts-title">
          <h2 id="starts-title" className="visually-hidden">Start a design</h2>
          <a className="card card--lavender start" href="/upload">
            <svg className="start__icon" aria-hidden="true"><use href="/assets/sprite.svg#i-image"/></svg>
            <span className="start__title">Upload a logo</span>
            <span className="start__text">PNG or JPG</span>
            <svg className="shape shape--ink start__deco" aria-hidden="true"><use href="/assets/sprite.svg#sparkle"/></svg>
          </a>
        </section>

        <section className="designs" aria-labelledby="designs-title">
          <div className="designs__head"><h2 id="designs-title">Saved designs</h2></div>
          {load.status === "loading" && <p className="designs__empty" role="status">Loading your designs…</p>}
          {load.status === "error" && (
            <div className="designs__empty" role="alert">
              <p>{load.message}</p>
              <button className="btn btn--ink btn--sm" type="button" onClick={fetchDesigns}>Try again</button>
            </div>
          )}
          {load.status === "ready" && load.designs.length === 0 && (
            <p className="designs__empty">No designs yet. Upload a logo to make your first one.</p>
          )}
          {load.status === "ready" && load.designs.length > 0 && (
            <ul className="designs__grid thumbs">
              {load.designs.map((d) => (
                <li className="design" key={d.id}>
                  <Link to={`/preview/${d.id}`}>
                    <span className="thumb">
                      <span className="badge">{d.status === "digitized" ? "Digitized" : "Uploaded"}</span>
                      <span className="design__type" aria-hidden="true">{d.type.toUpperCase()}</span>
                    </span>
                    <span className="design__meta">
                      <span className="design__name">{d.filename}</span>
                      <span className="design__info">
                        {DATE.format(new Date(d.created_at))}
                        {" · "}{d.colour_count} {d.colour_count === 1 ? "colour" : "colours"}
                        {d.stitch_count !== null && <>{" · "}{d.stitch_count.toLocaleString("en")} stitches</>}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
