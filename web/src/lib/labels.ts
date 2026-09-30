// Column-number labels that never overlap. On small lettering several columns have their middle
// points within a label's width of each other; each label then moves to the nearest free spot
// around its point and a short leader line joins them.

export type Placed = { x: number; y: number; anchorX: number; anchorY: number; moved: boolean };

/** Rings of candidate spots around the anchor, nearest first. */
function candidates(ax: number, ay: number, radius: number): [number, number][] {
  const out: [number, number][] = [[ax, ay]];
  for (let ring = 1; ring <= 10; ring++) {
    const d = ring * radius * 1.25;
    const steps = 8 + ring * 4;
    for (let i = 0; i < steps; i++) {
      const a = (i + (ring % 2) * 0.5) * (2 * Math.PI / steps) - Math.PI / 2; // start above the point
      out.push([ax + d * Math.cos(a), ay + d * Math.sin(a)]);
    }
  }
  return out;
}

/**
 * Places a circle of `radius` for each anchor, in order, so that no two circles overlap
 * (centres at least 2 * radius + gap apart) and every circle stays inside a `size` square box.
 * Where it can, a label also keeps clear of the other columns' anchor points.
 */
export function placeLabels(anchors: [number, number][], radius: number, gap: number, size: number): Placed[] {
  const placed: Placed[] = [];
  const min = 2 * radius + gap;
  const inside = (x: number, y: number) => x >= radius && y >= radius && x <= size - radius && y <= size - radius;
  const clearance = (x: number, y: number) =>
    placed.reduce((m, p) => Math.min(m, Math.hypot(p.x - x, p.y - y)), Infinity);
  const coversAnchor = (x: number, y: number, own: number) =>
    anchors.some(([ax, ay], i) => i !== own && Math.hypot(ax - x, ay - y) < radius + gap);
  anchors.forEach(([ax, ay], index) => {
    const spots = candidates(ax, ay, radius).filter(([x, y]) => inside(x, y));
    const free = spots.filter(([x, y]) => clearance(x, y) >= min);
    let best = free.find(([x, y]) => !coversAnchor(x, y, index)) ?? free[0];
    if (!best) { // nowhere free nearby: take the spot that overlaps least
      let most = -1;
      for (const [x, y] of spots) {
        const c = clearance(x, y);
        if (c > most) { most = c; best = [x, y]; }
      }
    }
    const [x, y] = best ?? [Math.min(Math.max(ax, radius), size - radius), Math.min(Math.max(ay, radius), size - radius)];
    placed.push({ x, y, anchorX: ax, anchorY: ay, moved: Math.hypot(x - ax, y - ay) > 0.5 });
  });
  return placed;
}
