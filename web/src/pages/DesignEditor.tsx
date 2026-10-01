import { useCallback, useEffect, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { Link, useNavigate } from "react-router-dom";

import {
  api, ApiError, type ClientConfig, type DesignRecord, type DesignShape, type EditorState, type FabricPreset, type Formats,
  type ShapeKind, type TraceResult,
} from "../lib/api";
import {
  DesignShapesLayer, fitTo, OverlapSeams, RingPicker, StitchLines, ToolMarks, TracedColumns, unfitFrom, type RingPick,
} from "../lib/DesignCanvas";
import { DownloadLink } from "../lib/DownloadLink";
import { SelectField } from "../lib/Field";
import { TraceCard } from "../lib/TraceCard";
import { useEditor, type EditorHook } from "../lib/useEditor";
import { useTraceJob } from "../lib/useTraceJob";

type Tool = "select" | "split" | "columns" | "draw" | "sublayer";
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
  const [sublayerOf, setSublayerOf] = useState<number | null>(null);
  // Close: waits for a save in progress, or asks what to do with one that failed ("wait" | "ask").
  const [closing, setClosing] = useState<"wait" | "ask" | null>(null);
  const navigate = useNavigate();

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

  const startSublayer = (n: number) => {
    reset(); setDone(null); clearError();
    setSublayerOf(n);
    setTool("sublayer");
  };
  const finishSublayer = () => {
    if (current.length < 3 || !unfit || sublayerOf === null) return;
    void send({ op: "sublayer", shape: sublayerOf, points: current.map(unfit) }, `Add a sublayer to shape ${sublayerOf}`)
      .then((ok) => { if (ok) setTool("select"); });
  };

  // Close goes Home, but never drops a change: a save in progress is waited for, and a failed
  // one is not left behind without asking.
  const close = () => {
    if (editor.status === "saving") setClosing("wait");
    else if (editor.status === "failed" && editor.error) setClosing("ask");
    else navigate("/home");
  };
  useEffect(() => {
    if (closing === "wait" && editor.status === "saved") navigate("/home");
    if (closing === "wait" && editor.status === "failed") setClosing("ask");
  }, [closing, editor.status, navigate]);
  // Leaving the page another way (tab close, reload, typed address) while saving: the browser asks.
  useEffect(() => {
    if (editor.status !== "saving" && !(editor.status === "failed" && editor.error)) return;
    const onLeave = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [editor.status, editor.error]);

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
    } else if (tool === "sublayer") {
      setCurrent((c) => (c.length && Math.hypot(c[c.length - 1][0] - p[0], c[c.length - 1][1] - p[1]) < 1 ? c : [...c, p]));
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
      if (e.key === "Enter" && tool === "sublayer") finishSublayer();
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
  const statusText = { loading: "Loading…", saved: "Saved", saving: "Saving…", failed: editor.data ? "Error" : "Not loaded" }[editor.status];

  return (
    <>
      <header className="bar">
        <div className="bar__left">
          <button className="btn btn--ghost btn--sm bar__close" type="button" onClick={close}>Close</button>
          <div className="file">
            <p className="file__name">{design?.filename ?? (loadProblem ? "Design not loaded" : "Loading…")}</p>
            <div className="chips">
              <p className={`chip file__state is-${editor.status}`} role="status" aria-live="polite"
                 title={editor.status === "saving" && editor.saving ? `Saving: ${editor.saving}` : editor.error ? `Not saved: ${editor.error.what}` : undefined}>
                <span className="saved-dot" aria-hidden="true"></span>{statusText}
              </p>
              {editor.status === "failed" && editor.error && (
                <button className="chip chip--action" type="button" onClick={() => void editor.retry()}>Retry</button>
              )}
              <span className="chip chip--private" tabIndex={0} aria-describedby="private-tip">
                <svg aria-hidden="true"><use href="/assets/sprite.svg#i-lock"/></svg>Private
                <span className="tip" role="tooltip" id="private-tip">
                  Only you work on this design; there is no sharing yet. There are no accounts yet either, so
                  anyone who has this page's address can open it.
                </span>
              </span>
            </div>
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
        </div>
      </header>
      {closing && (
        <CloseDialog state={closing} editor={editor} onStay={() => setClosing(null)}
                     onLeave={() => { editor.dismiss(); navigate("/home"); }}
                     onRetry={() => { setClosing("wait"); void editor.retry(); }} />
      )}

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

          {/* Only the cards scroll; the tools row above stays in view. */}
          <div className="ed-left__scroll">
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

          <ExportCard designId={designId} ready={!!data && editor.status === "saved"} saving={editor.status === "saving"} />
          </div>
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
                        hasSatin={hasSatin} sublayerOf={sublayerOf} onFinish={tool === "sublayer" ? finishSublayer : finishEdge}
                        onCancel={() => { reset(); clearError(); setTool("select"); }} />
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
                  <ToolMarks points={points} edges={edges} current={current} area={tool === "sublayer"} />
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
                      onAddSublayer={startSublayer}
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
  drawColour: number; setDrawColour: (n: number) => void; hasSatin: boolean; sublayerOf: number | null;
  onFinish: () => void; onCancel: () => void;
};

/** What to do next with the chosen tool, and its buttons. */
function ToolHint({ tool, data, points, picks, edges, current, saving, drawColour, setDrawColour, hasSatin, sublayerOf, onFinish, onCancel }: HintProps) {
  let text = "";
  if (saving) text = `Saving: ${saving}…`;
  else if (tool === "split" && !hasSatin) text = "No satin shapes in this design.";
  else if (tool === "split") text = points === 0
    ? "Split: click a point on one edge of a satin shape."
    : "Now click the point straight across, on the opposite edge.";
  else if (tool === "columns") text = picks === 0
    ? "Select Satin Columns: click the outline to use as the column's first edge."
    : "Now click the second edge: another outline, or a hole inside the first one.";
  else if (tool === "sublayer") text = current < 3
    ? `Sublayer of shape ${sublayerOf}: click around the part that gets its own stitches (at least three points).`
    : "Keep clicking around the part, or Finish to make it a sublayer.";
  else if (tool === "draw") text = edges === 0
    ? "Draw edges: click along the first side of the column, then Finish edge."
    : "Now draw the second side, running the same way, then Finish edge.";
  return (
    <div className="tool-hint" data-tool={tool}>
      <p role="status">{text}</p>
      <div className="tool-hint__actions">
        {tool === "draw" && (
          <>
            <SelectField compact className="tool-hint__colour" label="Thread" value={drawColour}
                         onChange={(e) => setDrawColour(Number(e.target.value))} disabled={!!saving}>
              {data.colours.map((c) => <option key={c.number} value={c.number}>Colour {c.number} · {c.hex}</option>)}
            </SelectField>
            <button className="btn btn--ink btn--sm" type="button" onClick={onFinish} disabled={current < 2 || !!saving}>
              Finish edge
            </button>
          </>
        )}
        {tool === "sublayer" && (
          <button className="btn btn--ink btn--sm" type="button" onClick={onFinish} disabled={current < 3 || !!saving}>
            Finish sublayer
          </button>
        )}
        <button className="btn btn--ghost btn--sm" type="button" onClick={onCancel} disabled={!!saving}>Cancel</button>
      </div>
    </div>
  );
}

type PanelProps = {
  data: EditorState | null; failed: boolean; shape: DesignShape | null; editor: EditorHook;
  onSelect: (n: number | null) => void; onAddSublayer: (n: number) => void; hidden: Set<number>; onToggle: (n: number) => void;
};

/** The selected shape's stitch type, density, pull compensation and sublayers; the fabric preset, threads and layers. */
function ShapePanel({ data, failed, shape, editor, onSelect, onAddSublayer, hidden, onToggle }: PanelProps) {
  const defaults = data?.defaults;

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
          {defaults && shape.kind !== "running" && (
            <SliderField id="density" label="Density" unit="mm spacing"
                         value={shape.kind === "fill" ? shape.fill_spacing_mm : shape.satin_spacing_mm}
                         fallback={shape.kind === "fill" ? defaults.fill_row_spacing_mm : defaults.satin_spacing_mm}
                         min={shape.kind === "fill" ? defaults.fill_row_spacing_min_mm : defaults.satin_spacing_min_mm}
                         max={shape.kind === "fill" ? defaults.fill_row_spacing_max_mm : defaults.satin_spacing_max_mm}
                         help={shape.kind === "fill" ? "Space between fill rows. Smaller is denser." : "Space between satin stitches. Smaller is denser."}
                         disabled={!!editor.saving}
                         onCommit={(mm) => void editor.edit({ op: "set_density", shape: shape.number, mm }, mm === null ? "Reset density" : `Set density to ${mm} mm`)} />
          )}
          {defaults && shape.kind === "running" && <p className="panel__note">Density and pull compensation do not apply to running stitch.</p>}
          {satinLike && defaults && (
            <SliderField id="pull" label="Pull compensation" unit="mm"
                         value={shape.pull_compensation_mm} fallback={defaults.pull_compensation_mm}
                         min={defaults.pull_compensation_min_mm} max={defaults.pull_compensation_max_mm}
                         help={`Widens each satin stitch by this much in total, to make up for the fabric pulling in.${data.fabric.preset ? " The default comes from the fabric preset." : ""}`}
                         disabled={!!editor.saving}
                         onCommit={(mm) => void editor.edit({ op: "set_pull_compensation", shape: shape.number, mm }, mm === null ? "Reset pull compensation" : `Set pull compensation to ${mm} mm`)} />
          )}
        </section>
      )}

      {shape && (
        <section className="panel__section" aria-labelledby="sublayers-title">
          <h3 className="label" id="sublayers-title">Sublayers</h3>
          {shape.parent ? (
            <p className="panel__note">
              This is a sublayer of{" "}
              <button className="link-btn" type="button" onClick={() => onSelect(shape.parent ?? null)}>shape {shape.parent}</button>:
              its own stitch type and settings, inside that shape. It has no sublayers of its own.
            </p>
          ) : (
            <ul className="sublayers" aria-label={`Sublayers of shape ${shape.number}`}>
              {(shape.sublayers ?? []).map((n) => {
                const child = data.shapes.shapes.find((s) => s.number === n);
                return (
                  <li key={n}>
                    <button className="sublayer" type="button" onClick={() => onSelect(n)}>
                      <span className="sublayer__name">Shape {n}</span>
                      <span className="sublayer__kind">{child ? KIND_NAMES[child.kind] : ""}</span>
                    </button>
                  </li>
                );
              })}
              <li>
                <button className="sublayer sublayer--add" type="button" disabled={!!editor.saving || shape.kind === "column"}
                        onClick={() => onAddSublayer(shape.number)}>
                  + Sublayer
                </button>
              </li>
            </ul>
          )}
          {!shape.parent && (
            <p className="panel__note">
              {shape.kind === "column"
                ? "A column made from two edges cannot have sublayers."
                : "Outline a part of this shape to give it its own stitch type, density and pull compensation."}
            </p>
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
                    <li key={s.number} className={`layer${s.parent ? " layer--sub" : ""}${s.number === shape?.number ? " is-active" : ""}`}>
                      <button className="layer__pick" type="button" aria-pressed={s.number === shape?.number}
                              onClick={() => onSelect(s.number === shape?.number ? null : s.number)}>
                        <span className="layer__name">{name}{s.parent ? <span className="layer__sub"> · sublayer of {s.parent}</span> : null}</span>
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
      <div className="fabric">
        <SelectField compact id="fabric" className="fabric__field" label="Fabric preset" value={fabric.preset ?? ""}
                     aria-describedby={unverified ? "fabric-status fabric-help" : "fabric-help"}
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
        </SelectField>
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

type SliderProps = {
  id: string; label: string; unit: string; value: number | null | undefined; fallback: number; min: number; max: number;
  help: string; disabled: boolean; onCommit: (mm: number | null) => void;
};

/**
 * A setting as a slider between config.py's min and max (shown at both ends). Moving it only
 * changes the number shown; letting go (or a key press) saves it, like every other change.
 */
function SliderField({ id, label, unit, value, fallback, min, max, help, disabled, onCommit }: SliderProps) {
  const saved = value ?? fallback;
  const [shown, setShown] = useState(saved);
  useEffect(() => setShown(saved), [saved]);
  const ref = useRef<HTMLInputElement>(null);
  const commit = useRef(onCommit);
  commit.current = onCommit;
  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    // The native change event fires once, when the slider is let go (or after a key step).
    const onChange = () => {
      const mm = Math.round(Number(input.value) * 100) / 100;
      if (mm !== saved) commit.current(mm);
    };
    input.addEventListener("change", onChange);
    return () => input.removeEventListener("change", onChange);
  }, [saved]);
  const step = 0.05;
  return (
    <div className="slider">
      <div className="field">
        <label className="label" htmlFor={id}>{label}</label>
        <span className="field__value">
          <output htmlFor={id} id={`${id}-value`}>{shown.toFixed(2)}</output> {unit}{value === null || value === undefined ? " (default)" : ""}
        </span>
      </div>
      <input ref={ref} id={id} className="range" type="range" min={min} max={max} step={step} value={shown} disabled={disabled}
             aria-describedby={`${id}-help ${id}-range`} onChange={(e) => setShown(Number(e.target.value))} />
      <div className="slider__ends" id={`${id}-range`}>
        <span>min {min} mm</span><span>max {max} mm</span>
      </div>
      <p className="panel__note" id={`${id}-help`}>{help}</p>
      {value !== null && value !== undefined && (
        <button className="btn btn--ghost btn--sm" type="button" disabled={disabled} onClick={() => onCommit(null)}>
          Use the default ({fallback} mm)
        </button>
      )}
    </div>
  );
}

/**
 * Export: pick a machine file format and download the design in it. Only formats the server can
 * write AND whose write-then-read round trip passes can be picked; the others say why.
 */
function ExportCard({ designId, ready, saving }: { designId: string; ready: boolean; saving: boolean }) {
  const [formats, setFormats] = useState<Formats | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [picked, setPicked] = useState("dst");
  const load = useCallback(() => {
    setProblem(null);
    api.formats().then(
      (f) => { setFormats(f); if (!f.formats.includes(picked)) setPicked(f.formats[0] ?? ""); },
      (err) => setProblem(err instanceof ApiError ? err.message : "Something went wrong. Try again."),
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(load, [load]);
  const all = formats ? [...formats.formats, ...formats.unavailable.map((u) => u.format)] : [];
  const reason = (f: string) => formats?.unavailable.find((u) => u.format === f)?.reason;
  const canExport = ready && !!formats?.formats.includes(picked);
  return (
    <section className="export-card" aria-labelledby="export-title">
      <h2 className="export-card__title" id="export-title">Export</h2>
      {problem ? (
        <>
          <p className="panel__note" role="alert">{problem}</p>
          <button className="btn btn--ghost btn--sm" type="button" onClick={load}>Retry</button>
        </>
      ) : !formats ? (
        <p className="panel__note" role="status">Loading formats…</p>
      ) : (
        <>
          <div className="formats" role="radiogroup" aria-label="File format">
            {all.map((f) => {
              const why = reason(f);
              return (
                <span key={f} className="format">
                  <button type="button" role="radio" className="format__btn" aria-checked={picked === f}
                          aria-disabled={why ? true : undefined} aria-describedby={why ? `why-${f}` : undefined}
                          onClick={() => { if (!why) setPicked(f); }}>
                    {f.toUpperCase()}
                  </button>
                  {why && <span className="tip" role="tooltip" id={`why-${f}`}>{why}</span>}
                </span>
              );
            })}
          </div>
          <p className="panel__note">{formats.labels[picked] ?? ""}</p>
          {canExport
            ? <DownloadLink className="btn btn--ink btn--sm export-card__go" designId={designId} format={picked}>
                <svg aria-hidden="true"><use href="/assets/sprite.svg#i-download"/></svg>Export file
              </DownloadLink>
            : <button className="btn btn--ink btn--sm export-card__go" type="button" disabled>
                <svg aria-hidden="true"><use href="/assets/sprite.svg#i-download"/></svg>{saving ? "Saving…" : "Export file"}
              </button>}
        </>
      )}
    </section>
  );
}

type CloseProps = { state: "wait" | "ask"; editor: EditorHook; onStay: () => void; onLeave: () => void; onRetry: () => void };

/** Close while a change is saving (wait for it) or after one failed (ask). Inside the page. */
function CloseDialog({ state, editor, onStay, onLeave, onRetry }: CloseProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); }, [state]);
  return (
    <div className="close-dialog" role="alertdialog" aria-modal="true" aria-labelledby="close-title" aria-describedby="close-text"
         tabIndex={-1} ref={ref}>
      {state === "wait" ? (
        <>
          <h2 className="close-dialog__title" id="close-title">Saving your last change</h2>
          <p id="close-text">{editor.saving ? `${editor.saving}. ` : ""}You will go to Home as soon as it is saved.</p>
          <div className="close-dialog__actions">
            <button className="btn btn--ghost btn--sm" type="button" onClick={onStay}>Stay here</button>
          </div>
        </>
      ) : (
        <>
          <h2 className="close-dialog__title" id="close-title">Your last change is not saved</h2>
          <p id="close-text">
            {editor.error ? `${editor.error.what}: ${editor.error.message}` : "The last change could not be saved."}
          </p>
          <div className="close-dialog__actions">
            <button className="btn btn--ink btn--sm" type="button" onClick={onRetry}>Retry, then close</button>
            <button className="btn btn--ghost btn--sm" type="button" onClick={onStay}>Stay here</button>
            <button className="btn btn--ghost btn--sm" type="button" onClick={onLeave}>Close without it</button>
          </div>
        </>
      )}
    </div>
  );
}
