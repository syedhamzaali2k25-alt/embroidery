import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import design from "../assets/hero-design.json";

// The hero's stitch drawing: the real stitches of a sample design (the bird sample, from the
// recorded API preview; see scripts/make-hero-design.mjs), drawn as lines in sewing order, colour
// by colour, in about DURATION_MS, once on load. The finished design then stays. Replay draws it
// again. Only stroke-dashoffset changes, from requestAnimationFrame, on a couple of dozen paths:
// nothing else moves and the main thread is never held. prefers-reduced-motion: the finished
// design at once, no Replay.

const DURATION_MS = 3000;

type Run = { c: string; p: number[] };

function pathOf(p: number[]): string {
  let d = `M${p[0]} ${p[1]}`;
  for (let i = 2; i < p.length; i += 2) d += `L${p[i]} ${p[i + 1]}`;
  return d;
}

function lengthOf(p: number[]): number {
  let total = 0;
  for (let i = 2; i < p.length; i += 2) total += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
  return Math.max(total, 0.001);
}

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function HeroStitches() {
  const runs = design.runs as Run[];
  const shapes = useMemo(() => {
    let start = 0;
    return runs.map((r) => {
      const length = lengthOf(r.p);
      const item = { colour: r.c, d: pathOf(r.p), length, start };
      start += length;
      return item;
    });
  }, [runs]);
  const total = shapes.length ? shapes[shapes.length - 1].start + shapes[shapes.length - 1].length : 0;
  const paths = useRef<(SVGPathElement | null)[]>([]);
  const svg = useRef<SVGSVGElement>(null);
  const frame = useRef(0);
  const [reduced] = useState(reducedMotion);
  const [state, setState] = useState<"drawing" | "done">(reduced ? "done" : "drawing");

  const show = useCallback((drawn: number) => {
    shapes.forEach((s, i) => {
      const el = paths.current[i];
      if (!el) return;
      const visible = Math.min(Math.max(drawn - s.start, 0), s.length);
      el.style.strokeDashoffset = String(s.length - visible);
    });
  }, [shapes]);

  const finish = useCallback(() => {
    cancelAnimationFrame(frame.current);
    for (const el of paths.current) if (el) { el.style.strokeDasharray = ""; el.style.strokeDashoffset = ""; }
    setState("done");
  }, []);

  const play = useCallback(() => {
    cancelAnimationFrame(frame.current);
    if (reducedMotion()) { finish(); return; }
    shapes.forEach((s, i) => {
      const el = paths.current[i];
      if (el) el.style.strokeDasharray = `${s.length} ${s.length}`;
    });
    show(0);
    setState("drawing");
    const begin = performance.now();
    const tick = (now: number) => {
      const t = Math.min((now - begin) / DURATION_MS, 1);
      show(t * total);
      if (t < 1) frame.current = requestAnimationFrame(tick);
      else finish();
    };
    frame.current = requestAnimationFrame(tick);
  }, [finish, shapes, show, total]);

  useEffect(() => {
    if (!reduced) play();
    return () => cancelAnimationFrame(frame.current);
  }, [play, reduced]);

  const [x0, y0, x1, y1] = design.bounds;
  const pad = Math.max(x1 - x0, y1 - y0) * 0.03;
  return (
    <div className="hero-stitches" data-state={state} data-stitches={design.stitch_count} data-runs={runs.length}>
      <svg ref={svg} viewBox={`${x0 - pad} ${y0 - pad} ${x1 - x0 + 2 * pad} ${y1 - y0 + 2 * pad}`} role="img"
           aria-label="The stitches of a sample design, drawn in sewing order">
        {shapes.map((s, i) => (
          <path key={i} ref={(el) => { paths.current[i] = el; }} d={s.d} stroke={s.colour} pathLength={s.length}
                className="hero-stitches__run"
                style={reduced ? undefined : { strokeDasharray: `${s.length} ${s.length}`, strokeDashoffset: s.length }} />
        ))}
      </svg>
      {!reduced && (
        <button className="btn btn--ghost btn--sm hero-stitches__replay" type="button" onClick={play}
                disabled={state === "drawing"} aria-label="Replay the stitch drawing">
          Replay
        </button>
      )}
    </div>
  );
}
