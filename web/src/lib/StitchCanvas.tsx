import { useEffect, useRef } from "react";

import type { StitchPoint } from "./api";

const PADDING = 24; // css px around the design
const FADED = 0.18; // opacity of stitches outside the selection, so the selected ones stand out
const SEAM = 0.45; // opacity of the ink seam drawn over colour overlaps
const LIGHT = 0.85; // thread colours lighter than this (relative luminance) get a thin outline on the white canvas

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** WCAG relative luminance of "#RRGGBB" (0 black .. 1 white). */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

type Props = {
  stitches: StitchPoint[];
  /** Thread colour ("#RRGGBB", the image's own colour) of a layer's stitches. */
  colourOf: (layer: number | null) => string;
  /** Layers to highlight; the rest are faded. Null or empty: nothing is faded. */
  selected: Set<number> | null;
  /** Colour overlap regions (polygons of rings, mm), drawn as a thin darker seam on top. */
  overlaps?: number[][][][];
  label: string;
};

/** Draws the real needle path from the API: each stitch in its thread colour, jumps dashed. */
export function StitchCanvas({ stitches, colourOf, selected, overlaps = [], label }: Props) {
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

      const muted = token("--muted");
      const focus = selected !== null && selected.size > 0;
      const light = new Map<string, boolean>();
      const isLight = (hex: string) => {
        if (!light.has(hex)) light.set(hex, luminance(hex) > LIGHT);
        return light.get(hex)!;
      };
      // Two passes so the selected layers are drawn on top of everything else.
      for (const pass of ["base", "selected"] as const) {
        let prev: StitchPoint | null = null;
        for (const s of moves) {
          if (prev) {
            const isSelected = focus && s.command === "stitch" && s.layer !== null && selected!.has(s.layer);
            if ((pass === "selected") === isSelected) {
              const [x0, y0] = px(prev);
              const [x1, y1] = px(s);
              ctx.beginPath();
              ctx.moveTo(x0, y0);
              ctx.lineTo(x1, y1);
              ctx.globalAlpha = focus && !isSelected ? FADED : 1;
              if (s.command === "jump") {
                ctx.setLineDash([3, 3]);
                ctx.strokeStyle = muted;
                ctx.lineWidth = 1;
                ctx.stroke();
              } else {
                const colour = colourOf(s.layer);
                const lineWidth = isSelected ? 1.6 : 0.9;
                ctx.setLineDash([]);
                if (isLight(colour)) { // pale thread on a white canvas: outline it so it stays visible
                  ctx.strokeStyle = muted;
                  ctx.lineWidth = lineWidth + 1.2;
                  ctx.stroke();
                }
                ctx.strokeStyle = colour;
                ctx.lineWidth = lineWidth;
                ctx.stroke();
              }
            }
          }
          prev = s;
        }
      }
      // Colour overlap: where one colour runs under the next, a thin darker seam.
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);
      for (const polygon of overlaps) {
        ctx.beginPath();
        for (const ring of polygon) {
          ring.forEach(([x, y], i) => {
            const [cx, cy] = px({ x_mm: x, y_mm: y, command: "stitch", layer: null });
            if (i === 0) ctx.moveTo(cx, cy);
            else ctx.lineTo(cx, cy);
          });
          ctx.closePath();
        }
        ctx.globalAlpha = focus ? FADED * SEAM : SEAM;
        ctx.fillStyle = token("--ink");
        ctx.fill("evenodd");
      }
      ctx.globalAlpha = 1;
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [stitches, colourOf, selected, overlaps]);

  return <canvas ref={ref} role="img" aria-label={label} />;
}
