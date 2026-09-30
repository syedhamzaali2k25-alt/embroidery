import { usePage } from "../lib/usePage";
import "../css/landing.css";

// Ported 1:1 from the static index.html; the screenshot audit checks it renders identically.
export default function Landing() {
  usePage("Stitchbook", "landing");
  return (
    <div className="sheet">
      <header className="nav">
        <a className="brand" href="/"><svg aria-hidden="true"><use href="/assets/sprite.svg#logo"/></svg>Stitchbook</a>
        <nav className="nav__links" aria-label="Main">
          <a href="#features">Features</a>
          <a href="#how">How it works</a>
          <a href="#gallery">Gallery</a>
        </nav>
        <div className="nav__actions">
          <a className="btn btn--ghost btn--sm nav__login" href="/home">Log in</a>
          <a className="btn btn--ink btn--sm" href="/home">Start free</a>
        </div>
      </header>

      <main>
        <section className="hero">
          <div className="hero__copy">
            <p className="eyebrow"><span className="dot" aria-hidden="true"></span>Digitising, minus the headache</p>
            <h1>Turn any sketch into <span className="accent">stitches</span></h1>
            <p className="lede">Draw, trace or drop in a picture. Stitchbook maps every line to the right stitch and exports a file your machine can run, with no manual digitising.</p>
            <div className="hero__cta">
              <a className="btn btn--ink btn--lg" href="/editor">Open the editor <svg aria-hidden="true"><use href="/assets/sprite.svg#i-arrow"/></svg></a>
              <a className="btn btn--ghost btn--lg" href="#gallery">See examples</a>
            </div>
            <ul className="hero__facts" aria-label="Highlights">
              <li><strong>DST, PES, JEF</strong><span>export formats</span></li>
              <li><strong>3 stitch types</strong><span>running, satin, fill</span></li>
              <li><strong>Free</strong><span>for personal hoops</span></li>
            </ul>
          </div>

          <div className="hero__art" aria-hidden="true">
            <svg className="shape shape--lavender art-blob-a"><use href="/assets/sprite.svg#blob-a"/></svg>
            <svg className="shape shape--lime art-blob-b"><use href="/assets/sprite.svg#blob-b"/></svg>
            <svg className="shape shape--green art-star"><use href="/assets/sprite.svg#star"/></svg>
            <svg className="shape shape--ink art-sparkle"><use href="/assets/sprite.svg#sparkle"/></svg>
            <div className="hoop">
              <svg className="motif hoop__motif"><use href="/assets/sprite.svg#m-daisy"/></svg>
            </div>
            <div className="float-card float-card--pink">
              <span className="float-card__label">Satin fill</span>
              <span className="float-card__value">4,210 stitches</span>
            </div>
            <div className="float-card float-card--white">
              <span className="float-card__label">Ready to export</span>
              <span className="float-card__value">daisy.pes</span>
            </div>
          </div>
        </section>

        <section className="features" id="features">
          <h2>Everything a <span className="accent">hoop</span> needs</h2>
          <div className="features__grid">
            <article className="card card--lavender feature">
              <svg className="feature__icon" aria-hidden="true"><use href="/assets/sprite.svg#i-pen"/></svg>
              <h3>Draw with real stitches</h3>
              <p>Each stroke is previewed as thread, so you see density and direction before anything touches fabric.</p>
            </article>
            <article className="card card--lime feature">
              <svg className="feature__icon" aria-hidden="true"><use href="/assets/sprite.svg#i-image"/></svg>
              <h3>Trace a picture</h3>
              <p>Drop in a photo or a doodle. Clean outlines come back as editable shapes, grouped by thread colour.</p>
            </article>
            <article className="card card--pink feature">
              <svg className="feature__icon" aria-hidden="true"><use href="/assets/sprite.svg#i-download"/></svg>
              <h3>Export for any machine</h3>
              <p>Pick your hoop size and format. Jump stitches and trims are planned for you to keep runs tidy.</p>
            </article>
          </div>
        </section>

        <section className="how" id="how">
          <div className="how__intro">
            <h2>Three steps to a <span className="accent">finished</span> file</h2>
            <p className="lede">No digitising course required. Most people have a design ready in under ten minutes.</p>
          </div>
          <ol className="steps">
            <li className="step">
              <span className="step__num">1</span>
              <div><h3>Start a design</h3><p>Pick a hoop size, then sketch, trace or type.</p></div>
            </li>
            <li className="step">
              <span className="step__num">2</span>
              <div><h3>Tune the stitches</h3><p>Switch stitch types and set density per shape.</p></div>
            </li>
            <li className="step">
              <span className="step__num">3</span>
              <div><h3>Send to your machine</h3><p>Download the file or save it to a USB stick.</p></div>
            </li>
          </ol>
        </section>

        <section className="gallery" id="gallery">
          <div className="gallery__head">
            <h2>Made in <span className="accent">Stitchbook</span></h2>
            <a className="btn btn--ghost btn--sm" href="/home">Browse all</a>
          </div>
          <ul className="thumbs gallery__grid">
            <li><div className="thumb"><svg className="motif" aria-hidden="true"><use href="/assets/sprite.svg#m-mountain"/></svg></div><p className="gallery__name">Ridge patch</p></li>
            <li><div className="thumb"><svg className="motif" aria-hidden="true"><use href="/assets/sprite.svg#m-wave"/></svg></div><p className="gallery__name">Tide pocket</p></li>
            <li><div className="thumb"><svg className="motif" aria-hidden="true"><use href="/assets/sprite.svg#m-leaf"/></svg></div><p className="gallery__name">Fern cuff</p></li>
            <li><div className="thumb"><svg className="motif" aria-hidden="true"><use href="/assets/sprite.svg#m-heart"/></svg></div><p className="gallery__name">Heart tag</p></li>
          </ul>
        </section>

        <section className="cta">
          <svg className="shape shape--ink cta__sparkle" aria-hidden="true"><use href="/assets/sprite.svg#sparkle"/></svg>
          <svg className="shape shape--lime cta__star" aria-hidden="true"><use href="/assets/sprite.svg#star"/></svg>
          <h2>Your next patch starts here</h2>
          <p>Free to try. Nothing to install.</p>
          <a className="btn btn--ink btn--lg" href="/home">Create an account</a>
        </section>
      </main>

      <footer className="footer">
        <a className="brand" href="/"><svg aria-hidden="true"><use href="/assets/sprite.svg#logo"/></svg>Stitchbook</a>
        <p className="footer__note">Made for people who sew.</p>
      </footer>
    </div>
  );
}
