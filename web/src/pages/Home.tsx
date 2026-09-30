import { usePage } from "../lib/usePage";
import "../css/home.css";

// Designs are not saved to an account yet, so there is no list to show. This page says so and
// offers the one thing that works today: starting a new design from a PNG or JPG.
export default function Home() {
  usePage("Stitchbook Home", "home");
  return (
    <div className="sheet app">
      <aside className="side">
        <a className="brand" href="/"><svg aria-hidden="true"><use href="/assets/sprite.svg#logo"/></svg>Stitchbook</a>
        <nav className="side__nav" aria-label="Sections">
          <a href="/home" aria-current="page"><svg aria-hidden="true"><use href="/assets/sprite.svg#i-grid"/></svg>Designs</a>
        </nav>
      </aside>

      <main className="main">
        <section className="welcome">
          <div>
            <h1>Your <span className="accent">designs</span></h1>
            <p className="welcome__sub">
              Designs are not saved to an account yet, so none are listed here. Each design has its own address:
              keep the link to its preview or editor to open it again.
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
      </main>
    </div>
  );
}
