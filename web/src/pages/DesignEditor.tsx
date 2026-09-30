import { useCallback, useEffect, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { Link } from "react-router-dom";

import {
  api, ApiError, type ClientConfig, type DesignRecord, type DesignShape, type EditorState, type FabricPreset, type ShapeKind,
  type TraceResult,
} from "../lib/api";
import {
  DesignShapesLayer, fitTo, OverlapSeams, RingPicker, StitchLines, ToolMarks, TracedColumns, unfitFrom, type RingPick,
} from "../lib/DesignCanvas";
import { TraceCard } from "../lib/TraceCard";
import { useEditor, type EditorHook } from "../lib/useEditor";
import { useTraceJob } from "../lib/useTraceJob";

type Tool = "select" | "split" | "columns" | "draw";
type View = "stitches" | "shapes";

// Our own tool names and wording.
const TOOL_ROWS: [Tool, string, string, string][] = [
  ["split", "Split", "i-shape", "Cut a satin shape in two"],
  ["columns", "Select Satin Columns", "i-select", "Use two outlines as a column's edges"],
  ["draw", "Draw edges", "i-pen", "Draw both sides; satin fills between"],
];
const TYPES = [["running", "Running"], ["satin", "Satin"], ["fill", "Fill"]] as const;
const KIND_NAMES: Record<ShapeKind, string> = { fill: "Fill", satin: "Satin", running: "Running", column: "Satin column" };
// A click this close to an outline (screen pixels) lands on it. Pointer comfort only: the server
// decides what counts as on the edge (editor.snap_distance_mm).
const SNAP_SCREEN_PX = 14;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Nearest point on any outline of any visible shape to p (all in canvas units). */
function nearestOnOutline(shapes: DesignShape[], fit: (p: number[]) => [number, number], p: number[]) {
  let best: { point: number[]; dist: number } | null = null;
  for (const s of shapes) {
    for (const ring of s.rings) {
      for (let i = 0; i + 1 < ring.length; i++) {
        const [ax, ay] = fit(ring[i]), [bx, by] = fit(ring[i + 1]);
        const dx = bx - ax, dy = by - ay;
        const t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / (dx * dx + dy * dy || 1)));
        const q = [ax + t * dx, ay + t * dy];
        const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (!best || d < best.dist) best = { point: q, dist: d };
      }
    }
  }
  return best;
}

export default function DesignEditor({ designId }: { designId: string }) {
  const editor = useEditor(designId);
  const { data } = editor;
  const [design, setDesign] = useState<DesignRecord | null>(null);
  const [config, setConfig] = useState<ClientConfig | null>(null);
  const [loadProblem, setLoadProblem] = useState<string | null>(null);
  const load = useCallback(() => {
    setLoadProblem(null);
    Promise.all([api.design(designId), api.config()]).then(
      ([d, c]) => { setDesign(d); setConfig(c); },
      (err) => setLoadProblem(err instanceof ApiError ? err.message : "Something went wrong. Try again."),
    );
  }, [designId]);
  useEffect(load, [load]);
  const trace = useTraceJob(designId, design ? design.trace_job_id : undefined, config);

  const [tool, setTool] = useState<Tool>("select");
  const [view, setView] = useState<View>("stitches");
  const [zoom, setZoom] = useState(100);
  const [selected, setSelected] = useState<number | null>(null);
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  // Tool steps, in canvas units (split points, drawn edges) or outline picks.
  const [points, setPoints] = useState<number[][]>([]);
  const [picks, setPicks] = useState<RingPick[]>([]);
  const [edges, setEdges] = useState<number[][][]>([]);
  const [current, setCurrent] = useState<number[][]>([]);
  const [drawColour, setDrawColour] = useState(1);
  const [done, setDone] = useState<string | null>(null);

  const reset = useCallback(() => { setPoints([]); setPicks([]); setEdges([]); setCurrent([]); }, []);
  // A "Not saved" banner belongs to what the person was doing: it goes when they move on to
  // another tool or another shape (Retry is only offered while it still makes sense).
  const clearError = () => { if (editor.error) editor.dismiss(); };
  const choose = (t: Tool) => {
    reset(); setDone(null); clearError();
    setTool((cur) => (cur === t && t !== "select" ? "select" : t));
  };
  const selectShape = (n: number | null) => {
    if (n !== selected) clearError();
    setSelected(n);
  };
  // Split only works on satin shapes (not on columns made from two edges).
  const hasSatin = !!data?.shapes.shapes.some((s) => s.kind === "satin");

  // A shape number can change after a split or a new column: keep the selection valid.
  useEffect(() => {
    if (data && selected !== null && !data.shapes.shapes.some((s) => s.number === selected)) setSelected(null);
  }, [data, selected]);
  useEffect(() => {
    const shape = data?.shapes.shapes.find((s) => s.number === selected);
    if (shape) setDrawColour(shape.colour);
  }, [data, selected]);

  const send = async (edit: Parameters<EditorHook["edit"]>[0], what: string) => {
    setDone(null);
    const ok = await editor.edit(edit, what);
    if (ok) { reset(); setDone(what); }
    return ok;
  };

  const bounds = data?.shapes.bounds_mm ?? null;
  const fit = bounds ? fitTo(bounds) : null;
  const unfit = bounds ? unfitFrom(bounds) : null;
  const svgRef = useRef<SVGSVGElement>(null);

  /** Pointer position in canvas units, with zoom undone. */
  const canvasPoint = (e: MouseEvent): number[] | null => {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return null;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    const z = zoom / 100;
    return [(p.x - 200) / z + 200, (p.y - 200) / z + 200];
  };

  const onCanvasClick = (e: MouseEvent) => {
    if (!data || !fit || !unfit || editor.saving) return;
    if (tool === "select") { selectShape(null); return; }
    if (tool === "split" && !hasSatin) return;
    const p = canvasPoint(e);
    if (!p) return;
    if (tool === "split") {
      const svg = svgRef.current!;
      const unitsPerPx = 400 / svg.getBoundingClientRect().width / (zoom / 100);
      const near = nearestOnOutline(data.shapes.shapes.filter((s) => !hidden.has(s.number)), fit, p);
      const at = near && near.dist <= SNAP_SCREEN_PX * unitsPerPx ? near.point : p;
      const next = [...points, at];
      setPoints(next);
      if (next.length === 2) void send({ op: "split", a: unfit(next[0]), b: unfit(next[1]) }, "Split a satin shape");
    } else if (tool === "draw" && edges.length < 2) {
      // A double-click (Finish edge) also sends two clicks: do not add the same point again.
      setCurrent((c) => (c.length && Math.hypot(c[c.length - 1][0] - p[0], c[c.length - 1][1] - p[1]) < 1 ? c : [...c, p]));
    }
  };

  const finishEdge = () => {
    if (current.length < 2 || !unfit) return;
    const next = [...edges, current];
    setEdges(next);
    setCurrent([]);
    if (next.length === 2) {
      void send({ op: "column", left: { points: next[0].map(unfit) }, right: { points: next[1].map(unfit) }, colour: drawColour },
        "Satin column from drawn edges");
    }
  };

  const onPick = (pick: RingPick) => {
    if (editor.saving) return;
    const next = [...picks, pick];
    setPicks(next);
    if (next.length === 2) void send({ op: "column", left: next[0], right: next[1] }, "Satin column from two outlines");
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") reset();
      if (e.key === "Enter" && tool === "draw") finishEdge();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Once "Create satin columns" is done, the canvas shows the columns as they are now (with
  // every change in effect), numbered in sewing order.
  const traced: TraceResult | null = trace.phase === "done" && data ? {
    columns: data.columns, fill_shapes: trace.job?.result?.fill_shapes ?? 0,
    junction_patches: trace.job?.result?.junction_patches ?? 0, bounds_mm: data.shapes.bounds_mm, width_mm: data.shapes.width_mm,
  } : null;
  const shape = data?.shapes.shapes.find((s) => s.number === selected) ?? null;
  const statusText = { loading: "Loading…", saved: "Saved", saving: `Saving: ${editor.saving ?? ""}`, failed: editor.data ? "Not saved" : "Not loaded" }[editor.status];

  return (
    <>
      <header className="bar">
        <div className="bar__left">
          <a className="icon-btn" href="/home" aria-label="Back to designs"><svg aria-hidden="true"><use href="/assets/sprite.svg#i-back"/></svg></a>
          <div className="file">
            <p className="file__name">{design?.filename ?? (loadProblem ? "Design not loaded" : "Loading…")}</p>
            <p className={`file__state is-${editor.status}`} role="status" aria-live="polite">
              <span className="saved-dot" aria-hidden="true"></span>{statusText}
            </p>
          </div>
        </div>
        <div className="bar__right">
          <button className="icon-btn" type="button" disabled={!data?.history.undo || !!editor.saving}
                  aria-label={data?.history.undo ? `Undo: ${data.history.undo}` : "Undo (nothing to undo)"} title={data?.history.undo ?? undefined}
                  onClick={() => { reset(); setDone(null); void editor.undo(); }}>
            <svg aria-hidden="true"><use href="/assets/sprite.svg#i-undo"/></svg>
          </button>
          <button className="icon-btn" type="button" disabled={!data?.history.redo || !!editor.saving}
                  aria-label={data?.history.redo ? `Redo: ${data.history.redo}` : "Redo (nothing to redo)"} title={data?.history.redo ?? undefined}
                  onClick={() => { reset(); setDone(null); void editor.redo(); }}>
            <svg aria-hidden="true"><use href="/assets/sprite.svg#i-redo"/></svg>
          </button>
          <Link className="btn btn--ghost btn--sm bar__preview" to={`/preview/${designId}`}>Preview</Link>
          {data && editor.status !== "saving"
            ? <a className="btn btn--ink btn--sm" href={api.downloadUrl(designId)}><svg aria-hidden="true"><use href="/assets/sprite.svg#i-download"/></svg>Download DST</a>
            : <button className="btn btn--ink btn--sm" type="button" disabled><svg aria-hidden="true"><use href="/assets/sprite.svg#i-download"/></svg>Download DST</button>}
        </div>
      </header>

      <div className="workspace">
        <aside className="ed-left" aria-label="Tools and tracing">
          <nav className="tools" aria-label="Tools">
            <button className="tool" type="button" aria-pressed={tool === "select"} aria-label="Select" onClick={() => choose("select")}>
              <svg aria-hidden="true"><use href="/assets/sprite.svg#i-select"/></svg>
            </button>
            <button className="tool" type="button" aria-pressed={tool === "draw"} aria-label="Draw edges" onClick={() => choose("draw")}>
              <svg aria-hidden="true"><use href="/assets/sprite.svg#i-pen"/></svg>
            </button>
          </nav>

          {loadProblem ? (
            <section className="trace-card" aria-label="Create satin columns" data-state="error" role="alert">
              <div className="trace-card__head"><h2 className="trace-card__title">Create satin columns</h2><span className="chip-beta">Beta</span></div>
              <p className="trace-card__text">{loadProblem}</p>
              <button className="btn btn--ink btn--sm trace-card__action" type="button" onClick={load}>Retry</button>
            </section>
          ) : (
            <TraceCard {...trace} estimateMinutes={config?.trace_estimate_minutes ?? null}
                       onStart={() => void trace.start()} onCancel={() => void trace.cancel()} onRetry={() => void trace.retry()} />
          )}

          <section className="manual" aria-labelledby="manual-title">
            <h2 className="manual__title" id="manual-title">Or start manually editing</h2>
            <ul className="manual__list">
              {TOOL_ROWS.map(([id, label, icon, hint]) => {
                const noSatin = id === "split" && !!data && !hasSatin;
                return (
                  <li key={id}>
                    <button className="manual__row" type="button" aria-pressed={tool === id} onClick={() => choose(id)}
                            disabled={!data || noSatin}>
                      <svg aria-hidden="true"><use href={`/assets/sprite.svg#${icon}`}/></svg>
                      <span className="manual__name">{label}</span>
                      <span className="manual__hint">{noSatin ? "No satin shapes in this design" : hint}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        </aside>

        <section className="stage stage--design" aria-label="Canvas">
          <div className="stage__notes">
            {editor.error && (
              <div className="edit-error" role="alert">
                <p><strong>Not saved: {editor.error.what}.</strong> {editor.error.message}</p>
                <div className="edit-error__actions">
                  <button className="btn btn--ink btn--sm" type="button" onClick={() => void editor.retry()} disabled={!!editor.saving}>Retry</button>
                  <button className="btn btn--ghost btn--sm" type="button" onClick={() => { editor.dismiss(); reset(); }}>Dismiss</button>
                </div>
              </div>
            )}
            {data && tool !== "select" && (
              <ToolHint tool={tool} data={data} points={points.length} picks={picks.length} edges={edges.length}
                        current={current.length} saving={editor.saving} drawColour={drawColour} setDrawColour={setDrawColour}
                        hasSatin={hasSatin} onFinish={finishEdge} onCancel={() => { reset(); clearError(); setTool("select"); }} />
            )}
            {done && !editor.error && tool !== "select" && <p className="tool-done" role="status">Saved: {done}.</p>}
          </div>
          <div className="stage__canvas">
            {editor.loadProblem ? (
              <div className="stage__message" role="alert">
                <p>{editor.loadProblem}</p>
                <button className="btn btn--ink btn--sm" type="button" onClick={editor.reload}>Retry</button>
              </div>
            ) : !data || !fit ? (
              <p className="stage__message" role="status">Loading your design…</p>
            ) : (
              <svg ref={svgRef} className={`hoop-canvas design-canvas tool-${tool}${editor.saving ? " is-saving" : ""}`} viewBox="0 0 400 400"
                   role="img" aria-label={`${design?.filename ?? "Your design"}: ${plural(data.shapes.shapes.length, "shape")}`}
                   onClick={onCanvasClick} onDoubleClick={() => tool === "draw" && finishEdge()}>
                <rect className="design-canvas__bg" width="400" height="400" />
                <g className="design" style={zoom === 100 ? undefined : { transform: `scale(${zoom / 100})` }}>
                  <DesignShapesLayer shapes={data.shapes} fit={fit} hidden={hidden} selected={selected} traced={!!traced}
                                     faint={view === "stitches"} onSelect={tool === "select" ? selectShape : undefined} />
                  {view === "stitches" && <StitchLines stitches={data.stitches} layers={data.layers} colours={data.colours} fit={fit} hidden={hidden} />}
                  {view === "stitches" && !traced && <OverlapSeams shapes={data.shapes} fit={fit} hidden={hidden} />}
                  {traced && <TracedColumns result={traced} fit={fit} hidden={hidden} />}
                  {tool === "columns" && <RingPicker shapes={data.shapes} fit={fit} hidden={hidden} picked={picks} onPick={onPick} />}
                  <ToolMarks points={points} edges={edges} current={current} />
                </g>
              </svg>
            )}
          </div>

          <div className="stage__footer">
            <p className="stats">
              {data ? <>
                <strong>{data.stats.stitch_count.toLocaleString("en")}</strong> stitches <span className="sep" aria-hidden="true">·</span>{" "}
                {data.stats.width_mm.toFixed(1)} × {data.stats.height_mm.toFixed(1)} mm <span className="sep" aria-hidden="true">·</span>{" "}
                {plural(data.columns.length, "satin column")}
              </> : "Loading…"}
            </p>
            <div className="segmented segmented--view" role="radiogroup" aria-label="Show">
              {(["stitches", "shapes"] as const).map((v) => (
                <button key={v} type="button" role="radio" aria-checked={view === v} onClick={() => setView(v)}>
                  {v === "stitches" ? "Stitches" : "Shapes"}
                </button>
              ))}
            </div>
            <div className="zoom" role="group" aria-label="Zoom">
              <button className="icon-btn" type="button" aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(50, z - 10))}><svg aria-hidden="true"><use href="/assets/sprite.svg#i-minus"/></svg></button>
              <output className="zoom__value" aria-live="polite">{zoom}%</output>
              <button className="icon-btn" type="button" aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(200, z + 10))}><svg aria-hidden="true"><use href="/assets/sprite.svg#i-plus"/></svg></button>
            </div>
          </div>
        </section>

        <aside className="panel" aria-label="Properties">
          <ShapePanel data={data} failed={!!editor.loadProblem} shape={shape} editor={editor} onSelect={selectShape}
                      hidden={hidden} onToggle={(n) => setHidden((prev) => {
                        const next = new Set(prev);
                        if (next.has(n)) next.delete(n); else next.add(n);
                        return next;
                      })} />
        </aside>
      </div>
    </>
  );
}

type HintProps = {
  tool: Tool; data: EditorState; points: number; picks: number; edges: number; current: number; saving: string | null;
  drawColour: number; setDrawColour: (n: number) => void; hasSatin: boolean; onFinish: () => void; onCancel: () => void;
};

/** What to do next with the chosen tool, and its buttons. */
function ToolHint({ tool, data, points, picks, edges, current, saving, drawColour, setDrawColour, hasSatin, onFinish, onCancel }: HintProps) {
  let text = "";
  if (saving) text = `Saving: ${saving}…`;
  else if (tool === "split" && !hasSatin) text = "No satin shapes in this design.";
  else if (tool === "split") text = points === 0
    ? "Split: click a point on one edge of a satin shape."
    : "Now click the point straight across, on the opposite edge.";
  else if (tool === "columns") text = picks === 0
    ? "Select Satin Columns: click the outline to use as the column's first edge."
    : "Now click the second edge: another outline, or a hole inside the first one.";
  else if (tool === "draw") text = edges === 0
    ? "Draw edges: click along the first side of the column, then Finish edge."
    : "Now draw the second side, running the same way, then Finish edge.";
  return (
    <div className="tool-hint" data-tool={tool}>
      <p role="status">{text}</p>
      <div className="tool-hint__actions">
        {tool === "draw" && (
          <>
            <label className="tool-hint__colour">
              <span>Thread</span>
              <select value={drawColour} onChange={(e) => setDrawColour(Number(e.target.value))} disabled={!!saving}>
                {data.colours.map((c) => <option key={c.number} value={c.number}>Colour {c.number} · {c.hex}</option>)}
              </select>
            </label>
            <button className="btn btn--ink btn--sm" type="button" onClick={onFinish} disabled={current < 2 || !!saving}>
              Finish edge
            </button>
          </>
        )}
        <button className="btn btn--ghost btn--sm" type="button" onClick={onCancel} disabled={!!saving}>Cancel</button>
      </div>
    </div>
  );
}

type PanelProps = {
  data: EditorState | null; failed: boolean; shape: DesignShape | null; editor: EditorHook;
  onSelect: (n: number | null) => void; hidden: Set<number>; onToggle: (n: number) => void;
};

/** The selected shape's stitch type and pull compensation, the threads, and the layers. */
function ShapePanel({ data, failed, shape, editor, onSelect, hidden, onToggle }: PanelProps) {
  const defaults = data?.defaults;
  const [pull, setPull] = useState("");
  useEffect(() => {
    if (shape && defaults) setPull(String(shape.pull_compensation_mm ?? defaults.pull_compensation_mm));
  }, [shape, defaults]);

  if (!data) {
    return (
      <section className="panel__section">
        <h2 className="panel__title">All shapes</h2>
        <p className="panel__hint">{failed ? "The design could not be loaded." : "Loading…"}</p>
      </section>
    );
  }
  const shapes = data.shapes;
  const count = (kind: ShapeKind) => shapes.shapes.filter((s) => s.kind === kind).length;
  const satinLike = shape && (shape.kind === "satin" || shape.kind === "column");
  const pullMm = Number(pull);
  const pullOk = pull.trim() !== "" && defaults !== undefined && pullMm >= defaults.pull_compensation_min_mm && pullMm <= defaults.pull_compensation_max_mm;
  const current = shape ? (shape.kind === "column" ? "satin" : shape.kind) : null;
  const columnsIn = shape ? data.columns.filter((c) => c.shape === shape.number).length : 0;

  return (
    <>
      <section className="panel__section">
        <h2 className="panel__title">{shape ? `Shape ${shape.number}` : "All shapes"}</h2>
        <p className="panel__hint">
          {shape
            ? `Colour ${shape.colour} · ${KIND_NAMES[shape.kind]}${shape.kind_chosen ? " (your choice)" : ""} · ${shape.max_width_mm.toFixed(1)} mm at its widest${satinLike ? ` · ${plural(columnsIn, "column")}` : ""}`
            : `${plural(shapes.shapes.length, "shape")} in ${plural(shapes.colours.length, "colour")}: ${count("satin") + count("column")} satin, ${count("fill")} fill, ${count("running")} running. Pick a shape to change it.`}
        </p>
        {shape?.notes?.map((n) => <p key={n} className="panel__note">{n}</p>)}
      </section>

      {shape && (
        <section className="panel__section">
          <h3 className="label" id="stitch-type">Stitch type</h3>
          <div className="segmented" role="radiogroup" aria-labelledby="stitch-type">
            {TYPES.map(([kind, name]) => (
              <button key={kind} type="button" role="radio" aria-checked={current === kind} disabled={!!editor.saving}
                      onClick={() => current !== kind && void editor.edit({ op: "set_type", shape: shape.number, kind }, `Change shape ${shape.number} to ${name}`)}>
                {name}
              </button>
            ))}
          </div>
          {satinLike && defaults && (
            <form className="pull" onSubmit={(e) => {
              e.preventDefault();
              if (pullOk) void editor.edit({ op: "set_pull_compensation", shape: shape.number, mm: pullMm }, `Set pull compensation to ${pullMm} mm`);
            }}>
              <div className="field">
                <label className="label" htmlFor="pull">Pull compensation</label>
                <span className="field__value">{shape.pull_compensation_mm === null || shape.pull_compensation_mm === undefined ? "default" : "your choice"}</span>
              </div>
              <div className="pull__row">
                <div className="pull__input">
                  <input id="pull" type="number" inputMode="decimal" step="0.05" min={defaults.pull_compensation_min_mm} max={defaults.pull_compensation_max_mm}
                         value={pull} onChange={(e) => setPull(e.target.value)} aria-describedby="pull-help" disabled={!!editor.saving} />
                  <span className="unit">mm</span>
                </div>
                <button className="btn btn--ink btn--sm" type="submit" disabled={!pullOk || !!editor.saving || pullMm === (shape.pull_compensation_mm ?? defaults.pull_compensation_mm)}>Apply</button>
              </div>
              <p className={pullOk ? "panel__note" : "panel__note panel__note--error"} id="pull-help">
                {pullOk
                  ? `Widens each satin stitch by this much in total, to make up for the fabric pulling in. Default ${defaults.pull_compensation_mm} mm${data.fabric.preset ? " (from the fabric preset)" : ""}.`
                  : `Enter ${defaults.pull_compensation_min_mm} to ${defaults.pull_compensation_max_mm} mm.`}
              </p>
              {shape.pull_compensation_mm !== null && shape.pull_compensation_mm !== undefined && (
                <button className="btn btn--ghost btn--sm" type="button" disabled={!!editor.saving}
                        onClick={() => void editor.edit({ op: "set_pull_compensation", shape: shape.number, mm: null }, "Reset pull compensation")}>
                  Use the default ({defaults.pull_compensation_mm} mm)
                </button>
              )}
            </form>
          )}
        </section>
      )}

      <FabricSection fabric={data.fabric} editor={editor} />

      {shapes.skipped_edits && shapes.skipped_edits.length > 0 && (
        <section className="panel__section" role="alert">
          <h3 className="label">Changes not applied</h3>
          {shapes.skipped_edits.map((m) => <p key={m} className="panel__note">{m}</p>)}
        </section>
      )}

      <section className="panel__section">
        <h3 className="label">Threads</h3>
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
        <p className="panel__note">
          Placeholder: thread names and codes are not chosen yet. The colours are your image's own; one thread
          change between each.
        </p>
      </section>

      <section className="panel__section">
        <h3 className="label">Layers</h3>
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
                    <li key={s.number} className={s.number === shape?.number ? "layer is-active" : "layer"}>
                      <button className="layer__pick" type="button" aria-pressed={s.number === shape?.number}
                              onClick={() => onSelect(s.number === shape?.number ? null : s.number)}>
                        <span className="layer__name">{name}</span>
                        <span className="layer__kind">{KIND_NAMES[s.kind]}</span>
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
      </section>
    </>
  );
}

function presetValues(v: NonNullable<FabricPreset["values"]>): string {
  return `Fill spacing ${v.fill_row_spacing_mm} mm · satin spacing ${v.satin_spacing_mm} mm · ` +
    `underlay spacing ${v.underlay_spacing_mm} mm · edge walk ${v.underlay_edge_walk ? "on" : "off"} · ` +
    `zigzag underlay ${v.underlay_zigzag ? "on" : "off"} · pull compensation ${v.pull_compensation_mm} mm`;
}

/**
 * Fabric preset: density, underlay and pull compensation for a kind of fabric, from config.py.
 * Choosing one is a change like any other (undo, redo, Preview and Download follow it). A preset
 * not yet sewn and checked on a machine is always marked Unverified.
 */
function FabricSection({ fabric, editor }: { fabric: EditorState["fabric"]; editor: EditorHook }) {
  const chosen = fabric.presets.find((p) => p.name === fabric.preset) ?? null;
  const unverified = chosen ? !chosen.verified : fabric.presets.some((p) => !p.verified);
  const noneReady = !fabric.presets.some((p) => p.ready);
  return (
    <section className="panel__section">
      <label className="label" htmlFor="fabric">Fabric preset</label>
      <div className="fabric">
        <select id="fabric" className="fabric__select" value={fabric.preset ?? ""} aria-describedby="fabric-status fabric-help"
                disabled={!!editor.saving || (noneReady && !fabric.preset)}
                onChange={(e) => {
                  const name = e.target.value || null;
                  const label = fabric.presets.find((p) => p.name === name)?.label;
                  void editor.edit({ op: "fabric", preset: name }, label ? `Choose the ${label} preset` : "Turn the fabric preset off");
                }}>
          <option value="">None (stitch defaults)</option>
          {fabric.presets.map((p) => (
            <option key={p.name} value={p.name} disabled={!p.ready}>{p.label}{p.ready ? "" : " (no values yet)"}</option>
          ))}
        </select>
        {unverified && <span className="fabric__status" id="fabric-status">Unverified: not yet tested on a machine</span>}
      </div>
      <p className="panel__note" id="fabric-help">
        {noneReady
          ? "No preset has values yet, so none can be chosen."
          : chosen?.values
            ? presetValues(chosen.values)
            : "Sets fill and satin density, underlay and pull compensation for a kind of fabric."}
      </p>
      {chosen && (
        <p className="panel__note">The fill density set on the preview screen and a shape's own pull compensation still apply.</p>
      )}
    </section>
  );
}
