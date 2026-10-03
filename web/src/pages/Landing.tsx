import { useEffect, type MouseEvent } from "react";
import { Link, useLocation } from "react-router-dom";

import design from "../assets/hero-design.json";
import { APP_NAME, SHOW_PLACEHOLDERS } from "../lib/brand";
import { count, usePlans } from "../lib/credits";
import { HeroStitches } from "../lib/HeroStitches";
import { Icon } from "../lib/Icon";
import { PlanCards } from "../lib/PlanCards";
import { NotChosen, SiteFooter, SiteHeader, useSite, type NavLink } from "../lib/SiteChrome";
import { usePage } from "../lib/usePage";
import { useReveal } from "../lib/useReveal";
import "../css/landing.css";

// The public home page. Every sentence says what the product does today; each one appears once
// (hero = the promise, features = what you get, steps = the order you do it in, FAQ = details).
// Prices, credits and the export cost come from config (GET /plans); the formats from GET /site.

// Sections, cards, tiles and FAQ rows below the first screen fade and rise into view once.
// (The CTA band clips its contents, so its parts reveal inside it rather than the band itself.)
const REVEAL = "main > section:not(.hero):not(.cta) > h2, .features__grid > .feature, .steps > .step, .demo__frame, .faq__row, .cta > h2, .cta > .btn";

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

const STEPS = ["step--green", "step--lavender", "step--lime", "step--pink"];

export default function Landing() {
  usePage(APP_NAME, "landing");
  const site = useSite().site;
  const plans = usePlans();
  useReveal(REVEAL);

  // Links such as /#how (the footer's "How it works") scroll to their section once it is drawn:
  // this page loads on demand, so the browser cannot do it by itself.
  const location = useLocation();
  useEffect(() => {
    if (location.hash) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView({ behavior: scrollMotion() });
  }, [location.hash, location.key]);

  // Only formats that pass the round-trip test (config via GET /site).
  const formats = site ? site.export_formats.map((f) => f.toUpperCase()).join(", ") : null;
  const video = site?.demo_video_url ?? "";
  const showDemo = Boolean(video) || SHOW_PLACEHOLDERS;
  const exportCost = plans.plans?.credit_costs.export ?? null;
  const costLine = plans.plans ? `Preview is free.${exportCost ? ` 1 export = ${count(exportCost)} credits.` : ""}` : null;

  const links: NavLink[] = [
    { href: "#features", label: "Features", onClick: sectionLink },
    { href: "#how", label: "How it works", onClick: sectionLink },
    ...(showDemo ? [{ href: "#demo", label: "Demo", onClick: sectionLink }] : []),
    { href: "#faq", label: "FAQ", onClick: sectionLink },
    { href: "#pricing", label: "Pricing", onClick: sectionLink },
  ];

  const faq: [string, string][] = [
    ["Which images work best?",
      "A logo with flat colours on a plain or transparent background. The image check points out anything too small, blurry, low in contrast or full of specks."],
    ["Which files can I upload?", "PNG and JPG."],
    ["Which machine files can I download?",
      `${formats ?? "The formats listed when you export"}. A format is offered only after its file passes a write-and-read-back check.`],
    ["How are thread colours handled?",
      "Each colour you keep becomes one thread, with a colour change between them. The background is not stitched."],
    ["Can I change the stitches?",
      "Yes. Set the width and density in the preview; in the editor, change a shape's stitch type, split a satin shape, or draw a satin column."],
    ...(exportCost ? [["What does an export cost?",
      `Previews are free. Each export uses ${count(exportCost)} credits; if it fails, the credits come back.`] as [string, string]] : []),
  ];

  return (
    <>
    <div className="sheet">
      <SiteHeader links={links} />

      <main>
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero__copy">
            <h1 id="hero-title">Turn your logo into <span className="accent">stitches</span></h1>
            <p className="lede">Get an embroidery file for your machine from a logo image, and see every stitch before you download it.</p>
            <div className="hero__cta">
              <Link className="btn btn--ink btn--lg" to="/upload">Upload a logo <Icon name="i-arrow" /></Link>
              <a className="btn btn--ghost btn--lg" href="#how" onClick={sectionLink}>See how it works</a>
            </div>
            <p className="hero__note">{costLine ?? " "}</p>
          </div>

          <figure className="hero-sample">
            <div className="hero-sample__pair">
              <div className="hero-sample__panel">
                <span className="hero-sample__tag">Logo</span>
                <img className="hero-sample__img" src="/assets/sample-bird.png" width={800} height={640} decoding="async"
                     alt="The sample logo: a bird on a branch, in flat colours" />
              </div>
              <Icon name="i-arrow" className="hero-sample__arrow" />
              <div className="hero-sample__panel hero-sample__panel--after">
                <span className="hero-sample__tag">Stitches</span>
                <HeroStitches />
              </div>
            </div>
            <figcaption className="hero-sample__caption">
              A sample logo from {APP_NAME}'s own tests and the {count(design.stitch_count)} stitches it made from it at 90 mm wide (test settings).
            </figcaption>
          </figure>
        </section>

        <section className="features" id="features" aria-labelledby="features-title">
          <h2 id="features-title">What you <span className="accent">get</span></h2>
          <div className="features__grid">
            <article className="card card--lavender feature">
              <Icon name="i-image" className="feature__icon" />
              <h3>An image check first</h3>
              <p>Size, contrast, sharpness and stray specks are checked before anything is stitched, with a note on what to fix.</p>
            </article>
            <article className="card card--lime feature">
              <Icon name="i-needle" className="feature__icon" />
              <h3>Stitches chosen per shape</h3>
              <p>Wide areas become fill, narrow strokes become satin with underlay, and jumps and trims are planned between them.</p>
            </article>
            <article className="card card--pink feature">
              <Icon name="i-pen" className="feature__icon" />
              <h3>Yours to adjust</h3>
              <p>Switch any shape between running, satin and fill stitch, split a satin shape, or draw a satin column between two edges.</p>
            </article>
          </div>
        </section>

        <section className="how" id="how" aria-labelledby="how-title">
          <h2 id="how-title">How it <span className="accent">works</span></h2>
          <ol className="steps">
            {[["Upload", "Add a PNG or JPG of your logo."],
              ["Choose colours and size", "Keep the colours you want and set the width in millimetres."],
              ["Look it over", "Check the stitches, and change any shape in the editor."],
              ["Download", `Save the ${formats ?? "machine"} file and load it on your machine.`]].map(([title, text], i) => (
              <li className={`step ${STEPS[i]}`} key={title}>
                <span className="step__num" aria-hidden="true">{i + 1}</span>
                <h3><span className="visually-hidden">Step {i + 1}: </span>{title}</h3>
                <p>{text}</p>
              </li>
            ))}
          </ol>
        </section>

        {showDemo && (
          <section className="demo" id="demo" aria-labelledby="demo-title">
            <h2 id="demo-title">See it in <span className="accent">action</span></h2>
            <div className="demo__frame">
              {video ? (
                <video className="demo__video" src={video} controls preload="none" poster="/assets/sample-bird.png"
                       width={1280} height={720}>
                  Your browser can't play this video. <a href={video}>Download it instead.</a>
                </video>
              ) : (
                <div className="demo__poster">
                  <button className="demo__play" type="button" disabled aria-label="Demo video (not added yet)">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor" /></svg>
                  </button>
                  <p className="demo__label"><NotChosen what="[Demo video]" /></p>
                </div>
              )}
            </div>
          </section>
        )}

        <section className="faq" id="faq" aria-labelledby="faq-title">
          <h2 id="faq-title">Questions and <span className="accent">answers</span></h2>
          <div className="faq__list">
            {faq.map(([q, a]) => (
              <details className="faq__row" key={q}>
                <summary>{q}<Icon name="i-plus" className="faq__icon" /></summary>
                <p>{a}</p>
              </details>
            ))}
            {SHOW_PLACEHOLDERS && (
              <details className="faq__row">
                <summary>Is there a free trial?<Icon name="i-plus" className="faq__icon" /></summary>
                <p><NotChosen what="[Fill in your trial terms]" /></p>
              </details>
            )}
          </div>
        </section>

        <section className="home-pricing" id="pricing" aria-labelledby="pricing-title">
          <h2 id="pricing-title">Plans and <span className="accent">credits</span></h2>
          {plans.plans ? <PlanCards plans={plans.plans} />
            : <p role={plans.failed ? "alert" : "status"}>{plans.failed ? "The plans could not be loaded: the server could not be reached." : "Loading plans…"}</p>}
          <Link className="btn btn--ghost home-pricing__more" to="/pricing">See full pricing</Link>
        </section>

        <section className="cta" aria-labelledby="cta-title">
          <svg className="shape shape--ink cta__sparkle" aria-hidden="true"><use href="/assets/sprite.svg#sparkle" /></svg>
          <svg className="shape shape--lime cta__star" aria-hidden="true"><use href="/assets/sprite.svg#star" /></svg>
          <h2 id="cta-title">Try it with your <span className="accent">logo</span></h2>
          <Link className="btn btn--ink btn--lg" to="/upload">Upload a logo</Link>
        </section>
      </main>
    </div>
    <SiteFooter home />
    </>
  );
}
