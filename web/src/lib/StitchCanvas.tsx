import { useEffect, useRef } from "react";

import type { StitchPoint } from "./api";

const PADDING = 24; // css px around the design

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Draws the real needle path from the API: stitches as lines, jumps dashed, the selected layer in green. */
export function StitchCanvas({ stitches, selected, label }: { stitches: StitchPoint[]; selected: number | null; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const { width, height } = canvas.getBoundingClientRect();
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      const ctx = canvas.getContext("2d");
      if (!ctx || stitches.length === 0) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const moves = stitches.filter((s) => s.command === "stitch" || s.command === "jump");
      const xs = moves.map((s) => s.x_mm);
      const ys = moves.map((s) => s.y_mm);
      const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
      const scale = Math.min((width - 2 * PADDING) / Math.max(maxX - minX, 1), (height - 2 * PADDING) / Math.max(maxY - minY, 1));
      const offX = (width - (maxX - minX) * scale) / 2;
      const offY = (height - (maxY - minY) * scale) / 2;
      const px = (s: StitchPoint): [number, number] => [offX + (s.x_mm - minX) * scale, offY + (s.y_mm - minY) * scale];

      const ink = token("--ink"), green = token("--green"), muted = token("--muted");
      // Two passes so the selected layer is drawn on top of everything else.
      for (const pass of ["base", "selected"] as const) {
        let prev: StitchPoint | null = null;
        for (const s of moves) {
          if (prev) {
            const isSelected = s.command === "stitch" && selected !== null && s.layer === selected;
            if ((pass === "selected") === isSelected) {
              const [x0, y0] = px(prev);
              const [x1, y1] = px(s);
              ctx.beginPath();
              ctx.moveTo(x0, y0);
              ctx.lineTo(x1, y1);
              if (s.command === "jump") {
                ctx.setLineDash([3, 3]);
                ctx.strokeStyle = muted;
                ctx.lineWidth = 1;
              } else {
                ctx.setLineDash([]);
                ctx.strokeStyle = isSelected ? green : ink;
                ctx.lineWidth = isSelected ? 1.6 : 0.8;
              }
              ctx.stroke();
            }
          }
          prev = s;
        }
      }
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [stitches, selected]);

  return <canvas ref={ref} role="img" aria-label={label} />;
}
