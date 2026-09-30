import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { usePage } from "../lib/usePage";
import DesignEditor from "./DesignEditor";
import "../css/editor.css";

const TOOLS = [
  ["Select", "i-select"], ["Draw", "i-pen"], ["Shape", "i-shape"],
  ["Text", "i-text"], ["Stitch path", "i-needle"], ["Pan", "i-hand"],
] as const;
const STITCH_TYPES = ["Running", "Satin", "Fill"] as const;
// Thread colours are not chosen yet: the labels are visible placeholders, not real thread names.
const THREADS = [["ink", "[Thread colour 1]"], ["green", "[Thread colour 2]"]] as const;
const THREAD_NOTE = "Placeholder: real thread colours are not chosen yet.";
const LAYERS = [["petals", "Petals", "ink"], ["centre", "Centre", "green"], ["leaves", "Leaves", "green"]] as const;
type LayerId = (typeof LAYERS)[number][0];

// With ?design=<id> the editor works on that design (DesignEditor). Without one it is the
// original mock-up, ported from the static editor.html; nothing in it is saved.
export default function Editor() {
  usePage("Stitchbook Editor", "editor");
  const [search] = useSearchParams();
  const designParam = search.get("design");
  const designId = designParam && /^[0-9a-f]{32}$/.test(designParam) ? designParam : null;
  if (designId) return <DesignEditor designId={designId} />;
  return <MockEditor />;
}

function MockEditor() {
  const [tool, setTool] = useState<string>("Select");
  const [stitchType, setStitchType] = useState<string>("Satin");
  const [thread, setThread] = useState<string>("ink");
  const [density, setDensity] = useState(4.5);
  const [length, setLength] = useState(3);
  const [hidden, setHidden] = useState<Set<LayerId>>(new Set());
  const [zoom, setZoom] = useState(100);

  const layerClass = (id: LayerId, base = "") => [base, hidden.has(id) ? "is-hidden" : ""].filter(Boolean).join(" ") || undefined;
  const toggleLayer = (id: LayerId) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <>
      <header className="bar">
        <div className="bar__left">
          <a className="icon-btn" href="/home" aria-label="Back to designs"><svg aria-hidden="true"><use href="/assets/sprite.svg#i-back"/></svg></a>
          <div className="file">
            <p className="file__name">Daisy jacket patch</p>
            <p className="file__state"><span className="saved-dot" aria-hidden="true"></span>Example only, not saved</p>
          </div>
        </div>
        <div className="bar__right">
          <Link className="btn btn--ink btn--sm" to="/upload">Upload a logo</Link>
        </div>
      </header>

      <div className="workspace">
        <aside className="ed-left" aria-label="Tools and tracing">
        <nav className="tools" aria-label="Tools">
          {TOOLS.map(([label, icon]) => (
            <button key={label} className="tool" type="button" aria-pressed={tool === label} aria-label={label} onClick={() => setTool(label)}>
              <svg aria-hidden="true"><use href={`/assets/sprite.svg#${icon}`}/></svg>
            </button>
          ))}
        </nav>

        <section className="trace-card" aria-label="Create satin columns" data-state="no-design">
          <div className="trace-card__head"><h2 className="trace-card__title">Create satin columns</h2><span className="chip-beta">Beta</span></div>
          <p className="trace-card__text">Open a design from its preview to trace it into satin columns and edit it.</p>
          <Link className="btn btn--ghost btn--sm trace-card__action" to="/upload">Upload a logo</Link>
        </section>
        </aside>

        <section className="stage" aria-label="Canvas">
          <div className="stage__canvas">
            <svg className="hoop-canvas" viewBox="0 0 400 400" role="img" aria-label="Daisy design in a 10 cm hoop">
              <circle className="hoop-ring" cx="200" cy="200" r="186"/>
              <circle className="hoop-fabric" cx="200" cy="200" r="176"/>
              <circle className="hoop-safe" cx="200" cy="200" r="150"/>
              <g className="design" style={zoom === 100 ? undefined : { transform: `scale(${zoom / 100})` }}>
                <g className={layerClass("leaves", "stitch stitch--green")} data-layer="leaves">
                  <path d="M196 262 C150 250 130 290 118 318 C160 318 190 300 196 262Z"/>
                  <path d="M204 262 C250 250 270 290 282 318 C240 318 210 300 204 262Z"/>
                  <path d="M200 250 L200 330"/>
                </g>
                <g className={layerClass("petals", "stitch stitch--ink")} data-layer="petals">
                  <ellipse cx="200" cy="130" rx="26" ry="50"/>
                  <ellipse cx="200" cy="130" rx="26" ry="50" transform="rotate(60 200 190)"/>
                  <ellipse cx="200" cy="130" rx="26" ry="50" transform="rotate(120 200 190)"/>
                  <ellipse cx="200" cy="130" rx="26" ry="50" transform="rotate(180 200 190)"/>
                  <ellipse cx="200" cy="130" rx="26" ry="50" transform="rotate(240 200 190)"/>
                  <ellipse cx="200" cy="130" rx="26" ry="50" transform="rotate(300 200 190)"/>
                </g>
                <g className={layerClass("centre")} data-layer="centre">
                  <circle className="fill fill--green" cx="200" cy="190" r="22"/>
                </g>
              </g>
              <g className="selection" aria-hidden="true">
                <rect x="96" y="76" width="208" height="228" rx="4"/>
                <rect className="handle" x="91" y="71" width="10" height="10" rx="3"/>
                <rect className="handle" x="299" y="71" width="10" height="10" rx="3"/>
                <rect className="handle" x="91" y="299" width="10" height="10" rx="3"/>
                <rect className="handle" x="299" y="299" width="10" height="10" rx="3"/>
              </g>
            </svg>
          </div>

          <div className="stage__footer">
            <p className="stats"><strong>4,210</strong> stitches <span className="sep" aria-hidden="true">·</span> 10 × 10 cm <span className="sep" aria-hidden="true">·</span> 2 threads</p>
            <div className="zoom" role="group" aria-label="Zoom">
              <button className="icon-btn" type="button" aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(50, z - 10))}><svg aria-hidden="true"><use href="/assets/sprite.svg#i-minus"/></svg></button>
              <output className="zoom__value" aria-live="polite">{zoom}%</output>
              <button className="icon-btn" type="button" aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(200, z + 10))}><svg aria-hidden="true"><use href="/assets/sprite.svg#i-plus"/></svg></button>
            </div>
          </div>
        </section>

        <aside className="panel" aria-label="Properties">
          <section className="panel__section">
            <h2 className="panel__title">Petals</h2>
            <p className="panel__hint">6 shapes selected</p>
          </section>

          <section className="panel__section">
            <h3 className="label" id="stitch-type">Stitch type</h3>
            <div className="segmented" role="radiogroup" aria-labelledby="stitch-type">
              {STITCH_TYPES.map((t) => (
                <button key={t} type="button" role="radio" aria-checked={stitchType === t} onClick={() => setStitchType(t)}>{t}</button>
              ))}
            </div>
          </section>

          <section className="panel__section">
            <div className="field">
              <label className="label" htmlFor="density">Density</label>
              <output className="field__value" htmlFor="density" id="density-out">{density.toFixed(1)} lines/mm</output>
            </div>
            <input className="range" id="density" type="range" min="2" max="7" step="0.5" value={density} onChange={(e) => setDensity(Number(e.target.value))} />
            <div className="field">
              <label className="label" htmlFor="length">Stitch length</label>
              <output className="field__value" htmlFor="length" id="length-out">{length.toFixed(1)} mm</output>
            </div>
            <input className="range" id="length" type="range" min="1" max="7" step="0.5" value={length} onChange={(e) => setLength(Number(e.target.value))} />
          </section>

          <section className="panel__section">
            <h3 className="label">Thread</h3>
            <div className="threads" role="radiogroup" aria-label="Thread colour">
              {THREADS.map(([id, name]) => (
                <button key={id} className={`thread thread--${id}`} type="button" role="radio" aria-checked={thread === id} onClick={() => setThread(id)}>
                  <span className="swatch" aria-hidden="true"></span><span className="placeholder-text">{name}</span>
                </button>
              ))}
            </div>
            <p className="panel__note">{THREAD_NOTE}</p>
          </section>

          <section className="panel__section">
            <h3 className="label">Layers</h3>
            <ul className="layers">
              {LAYERS.map(([id, name, colour], i) => {
                const visible = !hidden.has(id);
                return (
                  <li key={id} className={i === 0 ? "layer is-active" : "layer"}>
                    <span className={`layer__swatch layer__swatch--${colour}`} aria-hidden="true"></span>
                    <span className="layer__name">{name}</span>
                    <button className="layer__eye" type="button" aria-pressed={visible} aria-label={`${visible ? "Hide" : "Show"} ${name}`} onClick={() => toggleLayer(id)}>
                      <svg aria-hidden="true"><use href={`/assets/sprite.svg#${visible ? "i-eye" : "i-eye-off"}`}/></svg>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        </aside>
      </div>
    </>
  );
}
