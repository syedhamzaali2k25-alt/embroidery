import type { ColourLayer, DesignShapes, Layer, StitchPoint, TraceResult } from "./api";
import { placeLabels } from "./labels";

/** The canvas is a 400 × 400 viewBox; the design is fitted into its middle 360. */
export const CANVAS = 400;
const FIT = 360;
const LABEL_R = 8;

export type Fit = (p: number[]) => [number, number];

/** mm -> canvas units, centred, same scale on both axes. */
export function fitTo(bounds: number[]): Fit {
  const [minX, minY, maxX, maxY] = bounds;
  const scale = FIT / Math.max(maxX - minX, maxY - minY, 1);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  return ([x, y]) => [CANVAS / 2 + (x - cx) * scale, CANVAS / 2 + (y - cy) * scale];
}

/** canvas units -> mm: the inverse of fitTo(bounds). */
export function unfitFrom(bounds: number[]): Fit {
  const [minX, minY, maxX, maxY] = bounds;
  const scale = FIT / Math.max(maxX - minX, maxY - minY, 1);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  return ([x, y]) => [cx + (x - CANVAS / 2) / scale, cy + (y - CANVAS / 2) / scale];
}

const path = (rings: number[][][], fit: Fit) =>
  rings.map((ring) => "M" + ring.map((p) => fit(p).map((v) => v.toFixed(2)).join(",")).join("L") + "Z").join("");

type ShapesProps = {
  shapes: DesignShapes;
  fit: Fit;
  hidden: Set<number>;
  selected: number | null;
  traced: boolean;
  /** Stitches are drawn on top: the shapes are shown faintly, for picking. */
  faint?: boolean;
  /** Clicking a shape selects it; undefined while a tool uses the clicks. */
  onSelect?: (n: number) => void;
};

/** The uploaded design's shapes, as traced by the digitizer (outline with holes), each in its
 * colour layer's colour (the image's own colour). Once traced they become outlines under the columns. */
export function DesignShapesLayer({ shapes, fit, hidden, selected, traced, faint, onSelect }: ShapesProps) {
  const visible = shapes.shapes.filter((s) => !hidden.has(s.number));
  const hexOf = new Map(shapes.colours.map((c) => [c.number, c.hex]));
  const chosen = visible.find((s) => s.number === selected);
  const classes = ["design-shapes", traced && "is-under", faint && "is-faint", !onSelect && "is-inert"].filter(Boolean).join(" ");
  return (
    <g className={classes}>
      {visible.map((s) => (
        <path key={s.number} className="design-shape" d={path(s.rings, fit)} fillRule="evenodd"
              style={traced ? undefined : { fill: hexOf.get(s.colour) }} data-colour={s.colour}
              data-shape={s.number} data-kind={s.kind} onClick={onSelect ? () => onSelect(s.number) : undefined} />
      ))}
      {!traced && !faint && visible.flatMap((s) => (s.overlap ?? []).map((poly, i) => (
        // Where this colour runs under the next one it touches: a thin darker seam.
        <path key={`o${s.number}-${i}`} className="design-overlap" d={path(poly, fit)} fillRule="evenodd" />
      )))}
      {chosen && <path className="design-shape__selected" d={path(chosen.rings, fit)} fillRule="evenodd" />}
    </g>
  );
}

/** Traced satin columns: outline, spine, edit points and a number label that never overlaps another. */
export function TracedColumns({ result, fit, hidden }: { result: TraceResult; fit: Fit; hidden: Set<number> }) {
  const columns = result.columns.filter((c) => c.shape == null || !hidden.has(c.shape));
  const labels = placeLabels(columns.map((c) => fit(c.label)), LABEL_R, 1, CANVAS);
  const pts = (points: number[][]) => points.map((p) => fit(p).join(",")).join(" ");
  return (
    <g className="traced" aria-label={`${result.columns.length} traced satin columns`}>
      {columns.map((c) => (
        <g key={c.number} className="traced__column" data-shape={c.shape ?? undefined}>
          <polygon className="traced__outline" points={pts([...c.left, ...[...c.right].reverse()])} />
          <polyline className="traced__spine" points={pts(c.edit_points)} />
          {c.edit_points.map((p, i) => {
            const [x, y] = fit(p);
            return <circle key={i} className="traced__point" cx={x} cy={y} r="3.2" />;
          })}
        </g>
      ))}
      {columns.map((c, i) => {
        const l = labels[i];
        return (
          <g key={`n${c.number}`} className="traced__label" data-moved={l.moved || undefined}>
            {l.moved && <line className="traced__leader" x1={l.anchorX} y1={l.anchorY} x2={l.x} y2={l.y} />}
            {l.moved && <circle className="traced__anchor" cx={l.anchorX} cy={l.anchorY} r="1.6" />}
            <circle cx={l.x} cy={l.y} r={LABEL_R} />
            <text x={l.x} y={l.y} dy="0.35em" textAnchor="middle">{c.number}</text>
          </g>
        );
      })}
    </g>
  );
}

/** Colour overlap drawn over the stitches: where a colour runs under the next one it touches. */
export function OverlapSeams({ shapes, fit, hidden }: { shapes: DesignShapes; fit: Fit; hidden: Set<number> }) {
  return (
    <g className="overlap-seams">
      {shapes.shapes.filter((s) => !hidden.has(s.number)).flatMap((s) => (s.overlap ?? []).map((poly, i) => (
        <path key={`o${s.number}-${i}`} className="design-overlap" d={path(poly, fit)} fillRule="evenodd" />
      )))}
    </g>
  );
}

type StitchProps = { stitches: StitchPoint[]; layers: Layer[]; colours: ColourLayer[]; fit: Fit; hidden?: Set<number> };

/**
 * Every stitch from the stitch file, in its thread colour (one path per colour; jumps break it).
 * Stitches of `hidden` shapes are left out of the drawing, and so is the stitch that travels out
 * of one; the stitch file itself is not touched (hiding is a view setting only).
 */
export function StitchLines({ stitches, layers, colours, fit, hidden }: StitchProps) {
  const hexOfColour = new Map(colours.map((c) => [c.number, c.hex]));
  const colourOfLayer = new Map(layers.map((l) => [l.number, l.colour]));
  const shapeOfLayer = new Map(layers.map((l) => [l.number, l.shape ?? null]));
  const isHidden = (p: StitchPoint) => !!hidden?.size && p.layer !== null && hidden.has(shapeOfLayer.get(p.layer) ?? -1);
  const paths = new Map<number, string[]>();
  let prev: StitchPoint | null = null;
  for (const s of stitches) {
    if (s.command === "stitch" && s.layer !== null && prev && (prev.command === "stitch" || prev.command === "jump")
        && !isHidden(s) && !(prev.command === "stitch" && isHidden(prev))) {
      const colour = colourOfLayer.get(s.layer) ?? 1;
      const [x0, y0] = fit([prev.x_mm, prev.y_mm]);
      const [x1, y1] = fit([s.x_mm, s.y_mm]);
      const list = paths.get(colour) ?? [];
      list.push(`M${x0.toFixed(2)},${y0.toFixed(2)}L${x1.toFixed(2)},${y1.toFixed(2)}`);
      paths.set(colour, list);
    }
    if (s.command === "stitch" || s.command === "jump") prev = s;
  }
  return (
    <g className="stitch-lines" aria-hidden="true">
      {[...paths.entries()].map(([colour, segs]) => (
        <path key={colour} className="stitch-line" d={segs.join("")} style={{ stroke: hexOfColour.get(colour) }} data-colour={colour} />
      ))}
    </g>
  );
}

export type RingPick = { shape: number; ring: number };

type RingProps = { shapes: DesignShapes; fit: Fit; hidden: Set<number>; picked: RingPick[]; onPick: (pick: RingPick) => void };

/** "Select Satin Columns": every outline and hole of every shape as a path you can click. */
export function RingPicker({ shapes, fit, hidden, picked, onPick }: RingProps) {
  const isPicked = (shape: number, ring: number) => picked.findIndex((p) => p.shape === shape && p.ring === ring);
  return (
    <g className="ring-picker">
      {shapes.shapes.filter((s) => !hidden.has(s.number)).flatMap((s) => s.rings.map((ring, i) => {
        const d = path([ring], fit);
        const at = isPicked(s.number, i);
        const name = `${i === 0 ? "Outline" : `Hole ${i}`} of shape ${s.number}`;
        return (
          <g key={`${s.number}-${i}`} className={at >= 0 ? `ring is-picked is-picked-${at + 1}` : "ring"}
             data-shape={s.number} data-ring={i}>
            <path className="ring__line" d={d} />
            <path className="ring__hit" d={d} role="button" aria-label={name} tabIndex={0}
                  onClick={(e) => { e.stopPropagation(); onPick({ shape: s.number, ring: i }); }}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick({ shape: s.number, ring: i }); } }} />
          </g>
        );
      }))}
    </g>
  );
}

/** Points placed by Split, and the edges being drawn with Draw edges (canvas units). */
export function ToolMarks({ points, edges, current }: { points: number[][]; edges: number[][][]; current: number[][] }) {
  const line = (pts: number[][]) => pts.map((p) => p.join(",")).join(" ");
  return (
    <g className="tool-marks" aria-hidden="true">
      {points.length === 2 && <line className="tool-marks__cut" x1={points[0][0]} y1={points[0][1]} x2={points[1][0]} y2={points[1][1]} />}
      {edges.map((e, i) => <polyline key={i} className="tool-marks__edge is-done" points={line(e)} />)}
      {current.length > 0 && <polyline className="tool-marks__edge" points={line(current)} />}
      {[...points, ...edges.flat(), ...current].map((p, i) => (
        <circle key={i} className="tool-marks__point" cx={p[0]} cy={p[1]} r="3.5" />
      ))}
    </g>
  );
}
