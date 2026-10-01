import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { StitchPoint } from "./api";
import { LIGHT, luminance, PADDING, SEAM, token } from "./StitchCanvas";

// "Play sewing order": the person's own design, stitch by stitch in the order of the DST, colour by
// colour. Speeds are multiples of a fixed demo pace (1x = DEMO_STITCHES_PER_S); that pace is only
// for watching and says nothing about how fast a machine sews, so the page never calls it that.
// The last frame is the finished design: every STITCH record of the file, drawn exactly as the
// static preview draws it. prefers-reduced-motion: Play shows the finished design at once.

const DEMO_STITCHES_PER_S = 25; // 1x: a pace to watch the order by, not a machine speed
export const SPEEDS = [1, 8, 32, 128] as const;

type Props = {
  stitches: StitchPoint[]; colourOf: (layer: number | null) => string; label: string; onClose: () => void;
  /** Colour overlap regions, drawn as the static preview does once every stitch is sewn. */
  overlaps?: number[][][][];
};

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function SewPlayer({ stitches, colourOf, label, onClose, overlaps = [] }: Props) {
  // Needle moves only (stitches and jumps), and for each the number of stitches sewn up to it.
  const moves = useMemo(() => stitches.filter((s) => s.command === "stitch" || s.command === "jump"), [stitches]);
  const total = useMemo(() => moves.filter((s) => s.command === "stitch").length, [moves]);
  const stitchIndex = useMemo(() => { // stitch number k -> index in moves of the k-th stitch
    const out: number[] = [];
    moves.forEach((s, i) => { if (s.command === "stitch") out.push(i); });
    return out;
  }, [moves]);
  const colourNumbers = useMemo(() => [...new Set(moves.filter((s) => s.command === "stitch").map((s) => colourOf(s.layer)))], [moves, colourOf]);

  const canvas = useRef<HTMLCanvasElement>(null);
  const geometry = useRef<{ px: (s: StitchPoint) => [number, number]; width: number; height: number } | null>(null);
  const drawnTo = useRef(0); // moves[0..drawnTo) are on the canvas
  const position = useRef(0); // stitches sewn (may be fractional while playing)
  const frame = useRef(0);
  const [shown, setShown] = useState(0); // whole stitches shown, for the controls and tests
  const [playing, setPlaying] = useState(false);
  const playingRef = useRef(false);
  const lastShown = useRef(0);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(32);
  const [jumps, setJumps] = useState(false);

  const segment = useCallback((ctx: CanvasRenderingContext2D, i: number, muted: string) => {
    const g = geometry.current!;
    const s = moves[i], prev = moves[i - 1];
    if (!prev) return;
    if (s.command === "jump" && !jumps) return;
    const [x0, y0] = g.px(prev), [x1, y1] = g.px(s);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    if (s.command === "jump") {
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = muted;
      ctx.lineWidth = 1;
      ctx.stroke();
      return;
    }
    const colour = colourOf(s.layer);
    ctx.setLineDash([]);
    if (luminance(colour) > LIGHT) { ctx.strokeStyle = muted; ctx.lineWidth = 2.1; ctx.stroke(); }
    ctx.strokeStyle = colour;
    ctx.lineWidth = 0.9;
    ctx.stroke();
  }, [moves, jumps, colourOf]);

  /** Put exactly the first `count` stitches (and the jumps before them) on the canvas. */
  const render = useCallback((count: number) => {
    const el = canvas.current, g = geometry.current;
    if (!el || !g) return;
    const ctx = el.getContext("2d")!;
    const upTo = count <= 0 ? 0 : count >= total ? moves.length : stitchIndex[Math.ceil(count) - 1] + 1;
    const muted = token("--muted");
    if (upTo < drawnTo.current || (drawnTo.current >= moves.length && count < total)) { // going back: start again
      ctx.clearRect(0, 0, g.width, g.height);
      drawnTo.current = 0;
    }
    const wasDone = drawnTo.current >= moves.length;
    for (let i = Math.max(drawnTo.current, 1); i < upTo; i++) segment(ctx, i, muted);
    drawnTo.current = upTo;
    if (count >= total && !wasDone) { // finished: the overlap seams on top, as in the static preview
      drawnTo.current = moves.length;
      ctx.setLineDash([]);
      for (const polygon of overlaps) {
        ctx.beginPath();
        for (const ring of polygon) {
          ring.forEach(([x, y], i) => {
            const [cx, cy] = g.px({ x_mm: x, y_mm: y, command: "stitch", layer: null });
            if (i === 0) ctx.moveTo(cx, cy); else ctx.lineTo(cx, cy);
          });
          ctx.closePath();
        }
        ctx.globalAlpha = SEAM;
        ctx.fillStyle = token("--ink");
        ctx.fill("evenodd");
      }
      ctx.globalAlpha = 1;
    }
    const whole = count >= total ? total : Math.min(Math.floor(count), total);
    el.dataset.drawn = String(whole);
    // The controls (scrub bar, "Stitch n of N") follow at most 10 times a second while playing, so
    // a frame is only canvas drawing; a stop, a scrub or the end updates them at once.
    const now = performance.now();
    if (!playingRef.current || whole >= total || now - lastShown.current > 100) {
      lastShown.current = now;
      setShown(whole);
    }
  }, [segment, stitchIndex, total, moves.length, overlaps]);

  // Size the canvas and work out the same fit as the static preview; redraw on resize.
  useEffect(() => {
    const el = canvas.current;
    if (!el || moves.length === 0) return;
    const layout = () => {
      const dpr = window.devicePixelRatio || 1;
      const { width, height } = el.getBoundingClientRect();
      el.width = Math.round(width * dpr);
      el.height = Math.round(height * dpr);
      const ctx = el.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const xs = moves.map((s) => s.x_mm), ys = moves.map((s) => s.y_mm);
      const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
      const scale = Math.min((width - 2 * PADDING) / Math.max(maxX - minX, 1), (height - 2 * PADDING) / Math.max(maxY - minY, 1));
      const offX = (width - (maxX - minX) * scale) / 2, offY = (height - (maxY - minY) * scale) / 2;
      geometry.current = { width, height, px: (s) => [offX + (s.x_mm - minX) * scale, offY + (s.y_mm - minY) * scale] };
      drawnTo.current = 0;
      ctx.clearRect(0, 0, width, height);
      render(position.current);
    };
    layout();
    const observer = new ResizeObserver(layout);
    observer.observe(el);
    return () => observer.disconnect();
  }, [moves, render]);

  // Showing or hiding jumps redraws what is already sewn.
  useEffect(() => {
    const el = canvas.current, g = geometry.current;
    if (!el || !g) return;
    el.getContext("2d")!.clearRect(0, 0, g.width, g.height);
    drawnTo.current = 0;
    render(position.current);
  }, [jumps, render]);

  const speedRef = useRef(speed);
  speedRef.current = speed;
  const stop = useCallback(() => {
    cancelAnimationFrame(frame.current);
    playingRef.current = false;
    setPlaying(false);
    setShown(Number(canvas.current?.dataset.drawn ?? 0));
  }, []);

  const play = useCallback(() => {
    cancelAnimationFrame(frame.current);
    if (reducedMotion()) { position.current = total; playingRef.current = false; render(total); setPlaying(false); return; }
    if (position.current >= total) { position.current = 0; render(0); }
    playingRef.current = true;
    setPlaying(true);
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(now - last, 100) / 1000; // a hidden tab does not jump ahead
      last = now;
      position.current = Math.min(position.current + dt * DEMO_STITCHES_PER_S * speedRef.current, total);
      render(position.current);
      if (position.current < total) frame.current = requestAnimationFrame(tick);
      else { playingRef.current = false; setPlaying(false); }
    };
    frame.current = requestAnimationFrame(tick);
  }, [render, total]);

  const restart = () => { stop(); position.current = 0; render(0); play(); };
  const scrub = (value: number) => { stop(); position.current = value; render(value); };

  // Start playing as soon as the player opens.
  useEffect(() => { play(); return () => cancelAnimationFrame(frame.current); }, [play]);

  const current = shown > 0 ? moves[stitchIndex[shown - 1]] : null;
  const colourNow = current ? colourNumbers.indexOf(colourOf(current.layer)) + 1 : 0;
  const done = shown >= total;
  return (
    <div className="sew-player">
      <canvas ref={canvas} role="img" aria-label={label} data-total={total} />
      <div className="sew-player__controls" role="group" aria-label="Sewing order player">
        <div className="sew-player__buttons">
          <button className="btn btn--ink btn--sm" type="button" onClick={playing ? stop : play}>
            {playing ? "Pause" : done ? "Play again" : "Play"}
          </button>
          <button className="btn btn--ghost btn--sm" type="button" onClick={restart}>Restart</button>
          <div className="sew-player__speeds" role="radiogroup" aria-label="Speed">
            {SPEEDS.map((x) => (
              <button key={x} type="button" role="radio" aria-checked={speed === x} className="sew-player__speed"
                      onClick={() => setSpeed(x)}>{x}x</button>
            ))}
          </div>
          <label className="sew-player__jumps">
            <input type="checkbox" checked={jumps} onChange={(e) => setJumps(e.target.checked)} /> Show jumps
          </label>
          <button className="btn btn--ghost btn--sm sew-player__close" type="button" onClick={() => { stop(); onClose(); }}>
            Close player
          </button>
        </div>
        <input className="sew-player__scrub" type="range" min={0} max={total} step={1} value={shown}
               aria-label="Position in the sewing order" aria-valuetext={`Stitch ${shown} of ${total}`}
               onChange={(e) => scrub(Number(e.target.value))} />
        <p className="sew-player__status" aria-live="off">
          Stitch {shown.toLocaleString("en")} of {total.toLocaleString("en")}
          {colourNow > 0 && <> · colour {colourNow} of {colourNumbers.length}</>}
        </p>
      </div>
    </div>
  );
}
