import { useEffect, useRef, useState, type DragEvent, type MouseEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";

import { api, type SiteInfo } from "../lib/api";
import { HeroStitches } from "../lib/HeroStitches";
import { AccountControl } from "../lib/AccountMenu";
import { Icon } from "../lib/Icon";
import { setPendingUpload } from "../lib/pendingUpload";
import { usePlans } from "../lib/credits";
import { PlanCards } from "../lib/PlanCards";
import { SiteFooter } from "../lib/SiteChrome";
import { usePage } from "../lib/usePage";
import { useReveal } from "../lib/useReveal";
import "../css/landing.css";

const ACCEPT = ".png,.jpg,.jpeg,image/png,image/jpeg";
// (The CTA card clips its contents, and moving the whole card counted as a layout shift in
// Chrome; its heading, line and button reveal inside it instead.)
const REVEAL = "main > section:not(.hero):not(.cta) > h2, .features__grid > .feature, .how__intro, .steps > .step, .demo__frame, .faq__row, .cta > h2, .cta > p, .cta > .btn";

// Answers state only what the product does today. Unconfirmed terms stay visible placeholders.
function faq(formats: string) {
  return [
    ["What kind of image works best?",
      "A logo with clear, flat colours on a plain background, or a transparent PNG. After you upload it, the image check tells you if it is too small, low in contrast, blurry or full of small specks, and what to do about it."],
    ["Which files can I upload?",
      "PNG and JPG."],
    ["Which machine files can I download?",
      `${formats}. A format is only offered after it passes a write-and-read-back check, so the file you download has the same stitches as the preview.`],
    ["How many thread colours are used?",
      "One per colour in your logo, with a thread change between colours; the background is left out. On the upload page you choose which of the colours found to keep. Thread names and codes are not chosen yet."],
    ["Can I change the stitches?",
      "Yes. In the preview you set the design width and fill density. In the editor you pick a shape and change it to running, satin or fill stitch, set satin pull compensation, split a satin shape, or make a satin column between two edges. Every change shows up in the preview and the download."],
    ["Is there a free trial?", "[Fill in your trial terms]"],
  ] as const;
}

/** Smooth only when the visitor has not asked for reduced motion. */
const scrollMotion = (): ScrollBehavior => (matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");

/** A link to one of this page's sections: scrolls there (smoothly unless reduced motion) and keeps
 *  the address (#pricing) so it can be shared. */
function sectionLink(e: MouseEvent<HTMLAnchorElement>) {
  const id = e.currentTarget.hash.slice(1);
  const target = document.getElementById(id);
  if (!target || e.metaKey || e.ctrlKey || e.shiftKey) return;
  e.preventDefault();
  target.scrollIntoView({ behavior: scrollMotion() });
  history.pushState(null, "", `#${id}`);
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
  // Sections, cards, steps and FAQ rows below the first screen fade and rise into view once.
  useReveal(REVEAL);

  // Links such as /#how (the footer's "How it works") scroll to their section once it is drawn:
  // this page loads on demand, so the browser cannot do it by itself.
  const location = useLocation();
  useEffect(() => {
    if (location.hash) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView({ behavior: scrollMotion() });
  }, [location.hash, location.key]);

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
  const plans = usePlans();
  const video = site?.demo_video_url ?? "";

  return (
    <>
    <div className="sheet">
      <header className="nav">
        <a className="brand" href="/"><Icon name="logo" />Stitchbook</a>
        <nav className="nav__links" aria-label="Main">
          <a href="#features" onClick={sectionLink}>Features</a>
          <a href="#how" onClick={sectionLink}>How it works</a>
          <a href="#demo" onClick={sectionLink}>Demo</a>
          <a href="#faq" onClick={sectionLink}>FAQ</a>
          <a href="#pricing" onClick={sectionLink}>Pricing</a>
        </nav>
        <div className="nav__actions"><AccountControl /></div>
      </header>

      <main>
        <section className="hero">
          <div className="hero__copy">
            <p className="eyebrow"><span className="dot" aria-hidden="true"></span>Automatic embroidery digitizing</p>
            <h1>Turn your logo into <span className="accent">stitches</span></h1>
            <p className="lede">Upload an image of your logo. Stitchbook lays out the stitches automatically, lets you change them in the editor, and exports an embroidery machine file.</p>
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
              <HeroStitches />
              <p className="hero-drop__title">Drop your logo here</p>
              <p className="hero-drop__hint">PNG or JPG</p>
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
              <p>Drop in a PNG or JPG. Stitchbook checks its size, contrast, sharpness and specks first and tells you what to fix.</p>
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
            <li className="step"><span className="step__num">1</span><div><h3>Upload an image</h3><p>Drop your logo as PNG or JPG, choose its colours and set the design width.</p></div></li>
            <li className="step"><span className="step__num">2</span><div><h3>Get automatic stitches</h3><p>Fill and satin are laid out for you; the preview shows every stitch.</p></div></li>
            <li className="step"><span className="step__num">3</span><div><h3>Change them in the editor</h3><p>Pick a shape and change its stitch type, split satin, or add satin columns.</p></div></li>
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

        <section className="home-pricing" id="pricing" aria-labelledby="pricing-title">
          <h2 id="pricing-title">Plans and <span className="accent">credits</span></h2>
          {plans.plans ? <PlanCards plans={plans.plans} />
            : <p role={plans.failed ? "alert" : "status"}>{plans.failed ? "The plans could not be loaded: the server could not be reached." : "Loading plans…"}</p>}
          <Link className="btn btn--ghost home-pricing__more" to="/pricing">See full pricing</Link>
        </section>

        <section className="cta">
          <svg className="shape shape--ink cta__sparkle" aria-hidden="true"><use href="/assets/sprite.svg#sparkle" /></svg>
          <svg className="shape shape--lime cta__star" aria-hidden="true"><use href="/assets/sprite.svg#star" /></svg>
          <h2>Your next patch starts here</h2>
          <p>Upload a PNG or JPG logo and see its stitches.</p>
          <a className="btn btn--ink btn--lg" href="/upload">Upload a logo</a>
        </section>
      </main>
    </div>
    <SiteFooter home />
    </>
  );
}
