import { useState, type CSSProperties } from "react";

import { usePage } from "../lib/usePage";
import "../css/home.css";

type Status = "draft" | "exported";
type Filter = "All" | "Drafts" | "Exported";

// Mock-up content from the static home.html (this screen is not wired to the API yet).
const DESIGNS: { name: string; motif: string; status: Status; info: string }[] = [
  { name: "Daisy jacket patch", motif: "m-daisy", status: "draft", info: "4,210 stitches · 10 × 10 cm" },
  { name: "Ridge line", motif: "m-mountain", status: "exported", info: "6,880 stitches · 13 × 18 cm" },
  { name: "Morning sun", motif: "m-sun", status: "draft", info: "3,150 stitches · 10 × 10 cm" },
  { name: "Heart tag", motif: "m-heart", status: "exported", info: "1,940 stitches · 5 × 5 cm" },
  { name: "Tide pocket", motif: "m-wave", status: "exported", info: "2,760 stitches · 8 × 8 cm" },
  { name: "Fern cuff", motif: "m-leaf", status: "exported", info: "3,420 stitches · 10 × 10 cm" },
];
const FILTERS: Record<Filter, Status | null> = { All: null, Drafts: "draft", Exported: "exported" };

// Ported 1:1 from the static home.html; the screenshot audit checks it renders identically.
export default function Home() {
  usePage("Stitchbook Home", "home");
  const [filter, setFilter] = useState<Filter>("All");
  const wanted = FILTERS[filter];
  const shown = DESIGNS.filter((d) => !wanted || d.status === wanted).length;
  return (
    <div className="sheet app">
      <aside className="side">
        <a className="brand" href="/"><svg aria-hidden="true"><use href="/assets/sprite.svg#logo"/></svg>Stitchbook</a>
        <nav className="side__nav" aria-label="Sections">
          <a href="/home" aria-current="page"><svg aria-hidden="true"><use href="/assets/sprite.svg#i-grid"/></svg>Designs</a>
          <a href="#"><svg aria-hidden="true"><use href="/assets/sprite.svg#i-folder"/></svg>Collections</a>
          <a href="#"><svg aria-hidden="true"><use href="/assets/sprite.svg#i-users"/></svg>Shared</a>
        </nav>
        <div className="side__plan card card--lime">
          <p className="side__plan-title">Hoop space</p>
          <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={20} aria-valuenow={7} aria-label="Designs used"><span style={{ "--fill": "35%" } as CSSProperties}></span></div>
          <p className="side__plan-text">7 of 20 designs on the free plan</p>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <label className="search">
            <svg aria-hidden="true"><use href="/assets/sprite.svg#i-search"/></svg>
            <span className="visually-hidden">Search designs</span>
            <input type="search" placeholder="Search designs" />
          </label>
          <div className="topbar__right">
            <a className="btn btn--ink" href="/editor"><svg aria-hidden="true"><use href="/assets/sprite.svg#i-plus"/></svg>New design</a>
            <span className="avatar" aria-label="Your account">SA</span>
          </div>
        </header>

        <section className="welcome">
          <div>
            <h1>Good to see you. Pick up your <span className="accent">thread</span></h1>
            <p className="welcome__sub">You have 2 designs waiting to be exported.</p>
          </div>
        </section>

        <section className="starts" aria-labelledby="starts-title">
          <h2 id="starts-title" className="visually-hidden">Quick start</h2>
          <a className="card card--lavender start" href="/editor">
            <svg className="start__icon" aria-hidden="true"><use href="/assets/sprite.svg#i-pen"/></svg>
            <span className="start__title">Blank hoop</span>
            <span className="start__text">Sketch from scratch</span>
            <svg className="shape shape--ink start__deco" aria-hidden="true"><use href="/assets/sprite.svg#sparkle"/></svg>
          </a>
          <a className="card card--pink start" href="/editor">
            <svg className="start__icon" aria-hidden="true"><use href="/assets/sprite.svg#i-image"/></svg>
            <span className="start__title">Trace an image</span>
            <span className="start__text">Photo or drawing</span>
            <svg className="shape shape--lavender start__deco start__deco--blob" aria-hidden="true"><use href="/assets/sprite.svg#blob-b"/></svg>
          </a>
          <a className="card card--green start" href="/editor">
            <svg className="start__icon" aria-hidden="true"><use href="/assets/sprite.svg#i-text"/></svg>
            <span className="start__title">Monogram</span>
            <span className="start__text">Letters in satin stitch</span>
            <svg className="shape shape--lime start__deco start__deco--star" aria-hidden="true"><use href="/assets/sprite.svg#star"/></svg>
          </a>
        </section>
        <section className="designs" aria-labelledby="designs-title">
          <div className="designs__head">
            <h2 id="designs-title">Your <span className="accent">designs</span></h2>
            <div className="filters" role="group" aria-label="Filter designs">
              {(Object.keys(FILTERS) as Filter[]).map((f) => (
                <button key={f} className="chip" type="button" aria-pressed={f === filter} onClick={() => setFilter(f)}>
                  {f}
                </button>
              ))}
            </div>
          </div>

          <ul className="thumbs designs__grid">
            {DESIGNS.map((d) => (
              // Hidden items keep their slot so each design keeps its thumbnail colour.
              <li key={d.name} className="design" data-status={d.status} hidden={Boolean(wanted) && d.status !== wanted}>
                <a href="/editor">
                  <div className="thumb"><svg className="motif" aria-hidden="true"><use href={`/assets/sprite.svg#${d.motif}`}/></svg><span className="badge">{d.status === "draft" ? "Draft" : "Exported"}</span></div>
                  <div className="design__meta"><p className="design__name">{d.name}</p><p className="design__info">{d.info}</p></div>
                </a>
              </li>
            ))}
          </ul>
          <p className="designs__empty" hidden={shown > 0}>No designs match this filter.</p>
        </section>
      </main>
    </div>
  );
}
