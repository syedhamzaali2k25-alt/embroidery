import { useEffect, useRef, useState, type DragEvent } from "react";
import { useNavigate } from "react-router-dom";

import { api, type SiteInfo } from "../lib/api";
import { Icon } from "../lib/Icon";
import { setPendingUpload } from "../lib/pendingUpload";
import { usePage } from "../lib/usePage";
import "../css/landing.css";

const ACCEPT = ".png,.jpg,.jpeg,.svg,image/png,image/jpeg,image/svg+xml";

// Answers state only what the product does today. Unconfirmed terms stay visible placeholders.
function faq(formats: string) {
  return [
    ["What kind of image works best?",
      "A logo with clear shapes: dark on a plain light background, or a transparent PNG. After you upload it, the image check tells you if it is too small, low in contrast or blurry, and what to do about it."],
    ["Which files can I upload?",
      "PNG and JPG files are turned into stitches. SVG files can be uploaded, but for now export them as PNG first."],
    ["Which machine files can I download?",
      `${formats}. A format is only offered after it passes a write-and-read-back check, so the file you download sews what the preview shows.`],
    ["How many thread colours are used?",
      "One for now: every shape of the logo is stitched in the same thread colour."],
    ["Can I change the stitches?",
      "Yes. In the preview you set the design width and fill density; the editor is where you fix individual stitches before you export."],
    ["Is there a free trial?", "[Fill in your trial terms]"],
  ] as const;
}

export default function Landing() {
  usePage("Stitchbook", "landing");
  const navigate = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [site, setSite] = useState<SiteInfo | null>(null);

  useEffect(() => {
    api.site().then(setSite, () => setSite(null));
  }, []);

  const start = (file: File | undefined) => {
    if (!file) return;
    setPendingUpload(file);
    navigate("/upload");
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    start(e.dataTransfer.files[0]);
  };

  // Only formats that pass the round-trip test (from config via the API); a placeholder until known.
  const formats = site ? site.export_formats.map((f) => f.toUpperCase()).join(", ") : "[Export formats]";
  const video = site?.demo_video_url ?? "";

  return (
    <div className="sheet">
      <header className="nav">
        <a className="brand" href="/"><Icon name="logo" />Stitchbook</a>
        <nav className="nav__links" aria-label="Main">
          <a href="#features">Features</a>
          <a href="#how">How it works</a>
          <a href="#demo">Demo</a>
          <a href="#faq">FAQ</a>
        </nav>
        <div className="nav__actions">
          <a className="btn btn--ink btn--sm" href="/upload">Upload a logo</a>
        </div>
      </header>

      <main>
        <section className="hero">
          <div className="hero__copy">
            <p className="eyebrow"><span className="dot" aria-hidden="true"></span>Automatic embroidery digitizing</p>
            <h1>Turn your logo into <span className="accent">stitches</span></h1>
            <p className="lede">Upload an image of your logo. Stitchbook lays out the stitches automatically, lets you fix them in the editor, and exports a file your embroidery machine can run.</p>
            <div className="hero__cta">
              <a className="btn btn--ink btn--lg" href="/upload">Upload a logo <Icon name="i-arrow" /></a>
              <a className="btn btn--ghost btn--lg" href="#how">See how it works</a>
            </div>
            <ul className="hero__facts" aria-label="Highlights">
              <li><strong>{formats}</strong><span>machine file</span></li>
              <li><strong>Fill and satin</strong><span>picked for each shape</span></li>
              <li><strong>Width in mm</strong><span>height follows your logo</span></li>
            </ul>
          </div>

          <div className="hero__art">
            <svg className="shape shape--lavender art-blob-a" aria-hidden="true"><use href="/assets/sprite.svg#blob-a" /></svg>
            <svg className="shape shape--lime art-blob-b" aria-hidden="true"><use href="/assets/sprite.svg#blob-b" /></svg>
            <svg className="shape shape--green art-star" aria-hidden="true"><use href="/assets/sprite.svg#star" /></svg>
            <div
              className={`hero-drop${over ? " is-over" : ""}`}
              onDragOver={(e) => { e.preventDefault(); setOver(true); }}
              onDragLeave={() => setOver(false)}
              onDrop={onDrop}
            >
              <input ref={input} className="visually-hidden" type="file" accept={ACCEPT} tabIndex={-1} aria-hidden="true"
                     onChange={(e) => start(e.target.files?.[0])} />
              <Icon name="i-image" className="hero-drop__icon" />
              <p className="hero-drop__title">Drop your logo here</p>
              <p className="hero-drop__hint">PNG, JPG or SVG</p>
              <button className="btn btn--ink" type="button" onClick={() => input.current?.click()}>Choose a file</button>
            </div>
          </div>
        </section>

        <section className="features" id="features">
          <h2>From image to <span className="accent">machine</span> file</h2>
          <div className="features__grid">
            <article className="card card--lavender feature">
              <Icon name="i-image" className="feature__icon" />
              <h3>Upload your logo</h3>
              <p>Drop in a PNG or JPG. Stitchbook checks its size, contrast and sharpness first and tells you what to fix.</p>
            </article>
            <article className="card card--lime feature">
              <Icon name="i-needle" className="feature__icon" />
              <h3>Stitches picked for you</h3>
              <p>Wide shapes get rows of fill, narrow strokes get satin columns with underlay, and jumps and trims are planned between them.</p>
            </article>
            <article className="card card--pink feature">
              <Icon name="i-download" className="feature__icon" />
              <h3>Export for your machine</h3>
              <p>Check every stitch in the preview, then download a {formats} file for your embroidery machine.</p>
            </article>
          </div>
        </section>

        <section className="how" id="how">
          <div className="how__intro">
            <h2>Four steps to a <span className="accent">finished</span> file</h2>
            <p className="lede">The same four steps for every logo.</p>
          </div>
          <ol className="steps">
            <li className="step"><span className="step__num">1</span><div><h3>Upload an image</h3><p>Drop your logo as PNG, JPG or SVG and set the design width.</p></div></li>
            <li className="step"><span className="step__num">2</span><div><h3>Get automatic stitches</h3><p>Fill and satin are laid out for you; the preview shows every stitch.</p></div></li>
            <li className="step"><span className="step__num">3</span><div><h3>Fix them in the editor</h3><p>Adjust the stitches that need it before anything is sewn.</p></div></li>
            <li className="step"><span className="step__num">4</span><div><h3>Export a machine file</h3><p>Download {formats} and send it to your machine.</p></div></li>
          </ol>
        </section>

        <section className="demo" id="demo">
          <h2>See it in <span className="accent">action</span></h2>
          <div className="demo__frame">
            {video ? (
              <video className="demo__video" src={video} controls preload="metadata">
                Your browser can't play this video. <a href={video}>Download it instead.</a>
              </video>
            ) : (
              <div className="demo__poster">
                <button className="demo__play" type="button" disabled aria-label="Demo video (not added yet)">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor" /></svg>
                </button>
                <p className="demo__label">[Demo video]</p>
              </div>
            )}
          </div>
        </section>

        <section className="faq" id="faq">
          <h2>Questions and <span className="accent">answers</span></h2>
          <div className="faq__list">
            {faq(formats).map(([q, a]) => (
              <details className="faq__row" key={q}>
                <summary>{q}<Icon name="i-plus" className="faq__icon" /></summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="cta">
          <svg className="shape shape--ink cta__sparkle" aria-hidden="true"><use href="/assets/sprite.svg#sparkle" /></svg>
          <svg className="shape shape--lime cta__star" aria-hidden="true"><use href="/assets/sprite.svg#star" /></svg>
          <h2>Your next patch starts here</h2>
          <p>Runs in your browser: nothing to install.</p>
          <a className="btn btn--ink btn--lg" href="/upload">Upload a logo</a>
        </section>
      </main>

      <footer className="footer">
        <a className="brand" href="/"><Icon name="logo" />Stitchbook</a>
        <p className="footer__note">Made for people who sew.</p>
      </footer>
    </div>
  );
}
