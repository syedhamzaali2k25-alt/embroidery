import type { DesignShapes, TraceResult } from "./api";
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

const path = (rings: number[][][], fit: Fit) =>
  rings.map((ring) => "M" + ring.map((p) => fit(p).map((v) => v.toFixed(2)).join(",")).join("L") + "Z").join("");

type ShapesProps = {
  shapes: DesignShapes;
  fit: Fit;
  hidden: Set<number>;
  selected: number | null;
  traced: boolean;
  onSelect: (n: number) => void;
};

/** The uploaded design's shapes, as traced by the digitizer (outline with holes), each in its
 * colour layer's colour (the image's own colour). Once traced they become outlines under the columns. */
export function DesignShapesLayer({ shapes, fit, hidden, selected, traced, onSelect }: ShapesProps) {
  const visible = shapes.shapes.filter((s) => !hidden.has(s.number));
  const hexOf = new Map(shapes.colours.map((c) => [c.number, c.hex]));
  const chosen = visible.find((s) => s.number === selected);
  return (
    <g className={traced ? "design-shapes is-under" : "design-shapes"}>
      {visible.map((s) => (
        <path key={s.number} className="design-shape" d={path(s.rings, fit)} fillRule="evenodd"
              style={traced ? undefined : { fill: hexOf.get(s.colour) }} data-colour={s.colour}
              data-shape={s.number} data-kind={s.kind} onClick={() => onSelect(s.number)} />
      ))}
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
