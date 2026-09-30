import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { api, ApiError, type ClientConfig, type DesignRecord, type DesignShapes, type TraceResult } from "../lib/api";
import { DesignShapesLayer, fitTo, TracedColumns } from "../lib/DesignCanvas";
import { TraceCard } from "../lib/TraceCard";
import { usePage } from "../lib/usePage";
import { useTraceJob } from "../lib/useTraceJob";
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

const MANUAL_TOOLS = [
  ["Split", "i-shape", "Cut a column in two"],
  ["Select Satin Columns", "i-select", "Pick columns to change"],
] as const;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const kindName = { fill: "Fill", satin: "Satin" } as const;

// Ported from the static editor.html. Without ?design=<id> it is the original mock-up; with a
// design it shows that design's traced shapes, its Layers, and the "Create satin columns" card.
export default function Editor() {
  usePage("Stitchbook Editor", "editor");
  const [search] = useSearchParams();
  const designParam = search.get("design");
  const designId = designParam && /^[0-9a-f]{32}$/.test(designParam) ? designParam : null;
  const [design, setDesign] = useState<DesignRecord | null>(null);
  const [config, setConfig] = useState<ClientConfig | null>(null);
  const [loadProblem, setLoadProblem] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!designId) return;
    setLoadProblem(null);
    Promise.all([api.design(designId), api.config()]).then(
      ([d, c]) => { setDesign(d); setConfig(c); },
      (err) => setLoadProblem(err instanceof ApiError ? err.message : "Something went wrong. Try again."),
    );
  }, [designId]);
  useEffect(load, [load]);

  // The design's shapes (from the digitizer) for the canvas and the Layers list.
  const [shapes, setShapes] = useState<DesignShapes | null>(null);
  const [shapesProblem, setShapesProblem] = useState<string | null>(null);
  const loadShapes = useCallback(() => {
    if (!designId) return;
    setShapesProblem(null);
    api.shapes(designId).then(setShapes, (err) =>
      setShapesProblem(err instanceof ApiError ? err.message : "Something went wrong. Try again."));
  }, [designId]);
  useEffect(loadShapes, [loadShapes]);
  const [selected, setSelected] = useState<number | null>(null);
  const [hiddenShapes, setHiddenShapes] = useState<Set<number>>(new Set());
  const toggleShape = (n: number) =>
    setHiddenShapes((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });

  const trace = useTraceJob(designId, design ? design.trace_job_id : undefined, config);
  const traced = trace.phase === "done" ? trace.job?.result ?? null : null;
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
            <p className="file__name">{designId ? design?.filename ?? (loadProblem ? "Design not loaded" : "Loading…") : "Daisy jacket patch"}</p>
            <p className="file__state"><span className="saved-dot" aria-hidden="true"></span>Saved</p>
          </div>
        </div>
        <div className="bar__right">
          <button className="icon-btn" type="button" aria-label="Undo"><svg aria-hidden="true"><use href="/assets/sprite.svg#i-undo"/></svg></button>
          <button className="icon-btn" type="button" aria-label="Redo"><svg aria-hidden="true"><use href="/assets/sprite.svg#i-redo"/></svg></button>
          <button className="btn btn--ghost btn--sm bar__preview" type="button">Preview</button>
          <button className="btn btn--ink btn--sm" type="button"><svg aria-hidden="true"><use href="/assets/sprite.svg#i-download"/></svg>Export</button>
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

        {!designId && (
          <section className="trace-card" aria-label="Create satin columns" data-state="no-design">
            <div className="trace-card__head"><h2 className="trace-card__title">Create satin columns</h2><span className="chip-beta">Beta</span></div>
            <p className="trace-card__text">Open a design from its preview to trace it into satin columns.</p>
            <Link className="btn btn--ghost btn--sm trace-card__action" to="/upload">Upload a logo</Link>
          </section>
        )}
        {designId && loadProblem && (
          <section className="trace-card" aria-label="Create satin columns" data-state="error" role="alert">
            <div className="trace-card__head"><h2 className="trace-card__title">Create satin columns</h2><span className="chip-beta">Beta</span></div>
            <p className="trace-card__text">{loadProblem}</p>
            <button className="btn btn--ink btn--sm trace-card__action" type="button" onClick={load}>Retry</button>
          </section>
        )}
        {designId && !loadProblem && (
          <TraceCard {...trace} estimateMinutes={config?.trace_estimate_minutes ?? null}
                     onStart={() => void trace.start()} onCancel={() => void trace.cancel()} onRetry={() => void trace.retry()} />
        )}

        <section className="manual" aria-labelledby="manual-title">
          <h2 className="manual__title" id="manual-title">Or start manually editing</h2>
          <ul className="manual__list">
            {MANUAL_TOOLS.map(([label, icon, hint]) => (
              <li key={label}>
                <button className="manual__row" type="button" aria-pressed={tool === label} onClick={() => setTool(label)}>
                  <svg aria-hidden="true"><use href={`/assets/sprite.svg#${icon}`}/></svg>
                  <span className="manual__name">{label}</span>
                  <span className="manual__hint">{hint}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
        </aside>

        <section className="stage" aria-label="Canvas">
          <div className="stage__canvas">
            {designId ? (
              <DesignStage shapes={shapes} problem={shapesProblem} onRetry={loadShapes} name={design?.filename ?? "Your design"}
                           traced={traced} hidden={hiddenShapes} selected={selected} onSelect={setSelected} zoom={zoom} />
            ) : (
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
            )}
          </div>

          <div className="stage__footer">
            {designId ? (
              <p className="stats">
                {shapes && <><strong>{shapes.shapes.length}</strong> {shapes.shapes.length === 1 ? "shape" : "shapes"} <span className="sep" aria-hidden="true">·</span> {shapes.width_mm.toFixed(1)} × {shapes.height_mm.toFixed(1)} mm <span className="sep" aria-hidden="true">·</span> </>}
                {traced
                  ? <><strong>{traced.columns.length}</strong> satin columns</>
                  : "Not traced yet"}
                {tool === "Split" || tool === "Select Satin Columns" ? <> <span className="sep" aria-hidden="true">·</span> {tool} tool on</> : null}
              </p>
            ) : (
              <p className="stats"><strong>4,210</strong> stitches <span className="sep" aria-hidden="true">·</span> 10 × 10 cm <span className="sep" aria-hidden="true">·</span> 2 threads</p>
            )}
            <div className="zoom" role="group" aria-label="Zoom">
              <button className="icon-btn" type="button" aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(50, z - 10))}><svg aria-hidden="true"><use href="/assets/sprite.svg#i-minus"/></svg></button>
              <output className="zoom__value" aria-live="polite">{zoom}%</output>
              <button className="icon-btn" type="button" aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(200, z + 10))}><svg aria-hidden="true"><use href="/assets/sprite.svg#i-plus"/></svg></button>
            </div>
          </div>
        </section>

        <aside className="panel" aria-label="Properties">
          {designId ? (
            <DesignPanel shapes={shapes} failed={!!shapesProblem} traced={traced} selected={selected} onSelect={setSelected}
                         hidden={hiddenShapes} onToggle={toggleShape} />
          ) : (<>
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
          </>)}
        </aside>
      </div>
    </>
  );
}

type StageProps = {
  shapes: DesignShapes | null;
  problem: string | null;
  onRetry: () => void;
  name: string;
  traced: TraceResult | null;
  hidden: Set<number>;
  selected: number | null;
  onSelect: (n: number | null) => void;
  zoom: number;
};

/** The uploaded design on the canvas: its traced shapes, and the satin columns once traced. */
function DesignStage({ shapes, problem, onRetry, name, traced, hidden, selected, onSelect, zoom }: StageProps) {
  if (problem) {
    return (
      <div className="stage__message" role="alert">
        <p>{problem}</p>
        <button className="btn btn--ink btn--sm" type="button" onClick={onRetry}>Retry</button>
      </div>
    );
  }
  if (!shapes) return <p className="stage__message" role="status">Loading your design…</p>;
  const fit = fitTo(shapes.bounds_mm);
  return (
    <svg className="hoop-canvas design-canvas" viewBox="0 0 400 400" role="img"
         aria-label={`${name}: ${plural(shapes.shapes.length, "shape")}`}>
      <rect className="design-canvas__bg" width="400" height="400" onClick={() => onSelect(null)} />
      <g className="design" style={zoom === 100 ? undefined : { transform: `scale(${zoom / 100})` }}>
        <DesignShapesLayer shapes={shapes} fit={fit} hidden={hidden} selected={selected} traced={!!traced} onSelect={onSelect} />
        {traced && <TracedColumns result={traced} fit={fit} hidden={hidden} />}
      </g>
    </svg>
  );
}

type PanelProps = {
  shapes: DesignShapes | null;
  failed: boolean;
  traced: TraceResult | null;
  selected: number | null;
  onSelect: (n: number | null) => void;
  hidden: Set<number>;
  onToggle: (n: number) => void;
};

/** Properties for the real design: the selected shape, the thread (placeholder) and its Layers. */
function DesignPanel({ shapes, failed, traced, selected, onSelect, hidden, onToggle }: PanelProps) {
  const shape = shapes?.shapes.find((s) => s.number === selected) ?? null;
  const count = (kind: "fill" | "satin") => shapes?.shapes.filter((s) => s.kind === kind).length ?? 0;
  const columnsIn = (n: number) => traced?.columns.filter((c) => c.shape === n).length ?? 0;
  let hint = failed ? "The design could not be loaded." : "Loading…";
  if (shape) {
    const colour = shapes?.colours.find((c) => c.number === shape.colour);
    hint = `Colour ${shape.colour}${colour ? ` (${colour.hex})` : ""} · sewn as ${shape.kind} · ${shape.max_width_mm.toFixed(1)} mm at its widest`;
    if (traced && shape.kind === "satin") hint += ` · ${plural(columnsIn(shape.number), "column")}`;
  } else if (shapes) {
    hint = `${plural(shapes.shapes.length, "shape")} in ${plural(shapes.colours.length, "colour")}: ${count("satin")} satin, ${count("fill")} fill`;
  }
  return (
    <>
      <section className="panel__section">
        <h2 className="panel__title">{shape ? `Shape ${shape.number}` : "All shapes"}</h2>
        <p className="panel__hint">{hint}</p>
      </section>

      <section className="panel__section">
        <h3 className="label">Threads</h3>
        {shapes ? (
          <ul className="threads threads--list" aria-label="Thread colours in sewing order">
            {shapes.colours.map((c) => (
              <li key={c.number} className="thread thread--placeholder">
                <span className="swatch" style={{ background: c.hex } as CSSProperties} aria-hidden="true"></span>
                <span className="thread__text">
                  <span className="thread__name">Colour {c.number} · {c.hex}</span>
                  <span className="placeholder-text">{c.thread.name} {c.thread.code}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        <p className="panel__note">
          Placeholder: thread names and codes are not chosen yet. The colours are your image's own; one thread
          change between each.
        </p>
      </section>

      <section className="panel__section">
        <h3 className="label">Layers</h3>
        {shapes ? (
          <div className="layer-groups">
            {shapes.colours.map((c) => (
              <div key={c.number} className="layer-group">
                <h4 className="layer-group__title">
                  <span className="layer__swatch" style={{ background: c.hex } as CSSProperties} aria-hidden="true"></span>
                  Colour {c.number} <span className="layer-group__hex">{c.hex}</span>
                </h4>
                <ul className="layers" aria-label={`Shapes in colour ${c.number}`}>
                  {shapes.shapes.filter((s) => s.colour === c.number).map((s) => {
                    const visible = !hidden.has(s.number);
                    const name = `Shape ${s.number}`;
                    return (
                      <li key={s.number} className={s.number === selected ? "layer is-active" : "layer"}>
                        <button className="layer__pick" type="button" aria-pressed={s.number === selected}
                                onClick={() => onSelect(s.number === selected ? null : s.number)}>
                          <span className="layer__name">{name}</span>
                          <span className="layer__kind">{kindName[s.kind]}</span>
                        </button>
                        <button className="layer__eye" type="button" aria-pressed={visible} aria-label={`${visible ? "Hide" : "Show"} ${name}`} onClick={() => onToggle(s.number)}>
                          <svg aria-hidden="true"><use href={`/assets/sprite.svg#${visible ? "i-eye" : "i-eye-off"}`}/></svg>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        ) : <p className="panel__hint">{failed ? "No layers: the design could not be loaded." : "Layers appear once the design has loaded."}</p>}
      </section>
    </>
  );
}
