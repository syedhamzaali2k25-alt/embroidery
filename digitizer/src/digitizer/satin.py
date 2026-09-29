"""Satin columns: width classification, centerlines, rungs, underlay and satin stitch order.

Works on one polygon at a time. Pixel-space inputs (the traced mask) are used for the
distance transform and the skeleton; everything the embroidery file sees is in mm.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Callable

import cv2
import numpy as np
from shapely.geometry import LineString, MultiLineString, Point, Polygon
from shapely.ops import linemerge
from skimage.morphology import skeletonize

Pt = tuple[float, float]


# ---------- raster helpers (pixel space) ----------

def polygon_mask(polygon_px: Polygon, shape: tuple[int, int]) -> np.ndarray:
    """Rasterise one traced polygon (with holes) back to a uint8 mask."""
    mask = np.zeros(shape, dtype=np.uint8)
    cv2.fillPoly(mask, [np.round(np.asarray(polygon_px.exterior.coords)).astype(np.int32)], 255)
    for ring in polygon_px.interiors:
        cv2.fillPoly(mask, [np.round(np.asarray(ring.coords)).astype(np.int32)], 0)
    return mask


def distance_map(mask: np.ndarray) -> np.ndarray:
    """Distance (px) from every inside pixel to the nearest outside pixel."""
    return cv2.distanceTransform(mask, cv2.DIST_L2, cv2.DIST_MASK_PRECISE)


def max_width_px(dist: np.ndarray) -> float:
    """Diameter of the largest circle that fits inside the shape."""
    return 2.0 * float(dist.max())


# ---------- centerline from the skeleton ----------

def skeleton_lines(mask: np.ndarray) -> list[LineString]:
    """Skeleton pixels -> merged lines between ends/junctions (closed loops stay closed)."""
    ys, xs = np.nonzero(skeletonize(mask > 0))
    pixels = set(zip(xs.tolist(), ys.tolist()))
    segments = []
    for x, y in pixels:
        for dx, dy in ((1, 0), (0, 1), (1, 1), (1, -1)):
            q = (x + dx, y + dy)
            if q not in pixels:
                continue
            # Skip a diagonal link when an L-shaped pair of orthogonal links already joins them.
            if dx and dy and ((x + dx, y) in pixels or (x, y + dy) in pixels):
                continue
            segments.append(((x, y), q))
    if not segments:
        return []
    merged = linemerge(MultiLineString(segments))
    return list(getattr(merged, "geoms", [merged]))


def end_degrees(lines: list[LineString]) -> dict[Pt, int]:
    degree: dict[Pt, int] = {}
    for line in lines:
        if line.is_closed:
            continue
        for end in (line.coords[0], line.coords[-1]):
            degree[end] = degree.get(end, 0) + 1
    return degree


def prune_spurs(lines: list[LineString], dist: np.ndarray, factor: float) -> list[LineString]:
    """Remove short branches that run from a junction to a free end (corner artefacts)."""
    while True:
        degree = end_degrees(lines)
        keep, removed = [], False
        for line in lines:
            ends = (line.coords[0], line.coords[-1])
            if not line.is_closed and len(lines) > 1:
                free = [e for e in ends if degree[e] == 1]
                junction = [e for e in ends if degree[e] >= 3]
                if len(free) == 1 and junction:
                    jx, jy = junction[0]
                    if line.length < factor * dist[int(jy), int(jx)]:
                        removed = True
                        continue
            keep.append(line)
        if not removed:
            return lines
        merged = linemerge(MultiLineString(keep))
        lines = list(getattr(merged, "geoms", [merged]))


# ---------- columns (mm space) ----------

@dataclass
class Rung:
    center: Pt
    left: Pt   # after pull compensation
    right: Pt
    width_mm: float  # before pull compensation


@dataclass
class Column:
    centerline: LineString
    closed: bool
    rungs: list[Rung] = field(default_factory=list)
    skipped_rungs: int = 0  # stations dropped because no sensible edge-to-edge line exists


def _unit(dx: float, dy: float) -> Pt:
    n = math.hypot(dx, dy) or 1.0
    return dx / n, dy / n


def _hit_distance(origin: Pt, direction: Pt, polygon: Polygon, reach: float) -> float | None:
    """Distance to the first outline crossing along a ray, or None if none within reach."""
    ray = LineString([origin, (origin[0] + direction[0] * reach, origin[1] + direction[1] * reach)])
    hit = polygon.boundary.intersection(ray)
    if hit.is_empty:
        return None
    points = [g for g in getattr(hit, "geoms", [hit])]
    coords = [c for g in points for c in g.coords]
    return min(math.hypot(c[0] - origin[0], c[1] - origin[1]) for c in coords)


def extend_free_ends(line: LineString, start_free: bool, end_free: bool, polygon: Polygon, reach: float,
                     radius_mm: Callable[[Pt], float]) -> LineString:
    """Skeletons stop about a half-width short of stroke tips; extend free ends to the outline."""
    coords = list(line.coords)
    for at_start, free in ((True, start_free), (False, end_free)):
        if not free:
            continue
        end = coords[0] if at_start else coords[-1]
        # Tip direction is taken over the last half-width of the centerline.
        back = line.interpolate(min(line.length, radius_mm(end)) if at_start
                                else max(0.0, line.length - radius_mm(end)))
        direction = _unit(end[0] - back.x, end[1] - back.y)
        d = _hit_distance(end, direction, polygon, reach)
        if d:
            tip = (end[0] + direction[0] * d, end[1] + direction[1] * d)
            coords = [tip] + coords if at_start else coords + [tip]
    return LineString(coords)


def build_column(centerline: LineString, polygon: Polygon, spacing: float, max_width: float,
                 pull_comp: float, min_width: float, radius_mm: Callable[[Pt], float]) -> Column:
    """Cut the shape into rungs perpendicular to the centerline, every `spacing` mm."""
    closed = centerline.is_closed
    length = centerline.length
    count = max(1, int(length // spacing))
    stations = [k * length / count for k in range(count if closed else count + 1)]
    column = Column(centerline, closed)
    for d in stations:
        p = centerline.interpolate(d)
        center = (p.x, p.y)
        h = max(radius_mm(center), spacing)
        if closed:
            a, b = centerline.interpolate((d - h) % length), centerline.interpolate((d + h) % length)
        else:
            a, b = centerline.interpolate(max(0.0, d - h)), centerline.interpolate(min(length, d + h))
        tx, ty = _unit(b.x - a.x, b.y - a.y)
        normal = (-ty, tx)
        up = _hit_distance(center, normal, polygon, max_width)
        down = _hit_distance(center, (-normal[0], -normal[1]), polygon, max_width)
        # A rung wider than a satin shape can be means the normal ran into another arm
        # (a junction). Mirror the good side if only one side overshot; otherwise skip.
        if up is not None and down is not None and up + down <= max_width:
            pass
        elif up is not None and up <= max_width / 2 and (down is None or up + down > max_width):
            down = up
        elif down is not None and down <= max_width / 2 and (up is None or up + down > max_width):
            up = down
        else:
            column.skipped_rungs += 1
            continue
        if up + down < min_width:
            column.skipped_rungs += 1
            continue
        up_c, down_c = up + pull_comp / 2, down + pull_comp / 2
        left = (center[0] + normal[0] * up_c, center[1] + normal[1] * up_c)
        right = (center[0] - normal[0] * down_c, center[1] - normal[1] * down_c)
        column.rungs.append(Rung(center, left, right, up + down))
    return column


def _inset(rung: Rung, side: str, inset: float) -> Pt:
    edge = rung.left if side == "left" else rung.right
    half = math.hypot(edge[0] - rung.center[0], edge[1] - rung.center[1])
    if half <= inset:
        return rung.center
    t = (half - inset) / half
    return (rung.center[0] + (edge[0] - rung.center[0]) * t, rung.center[1] + (edge[1] - rung.center[1]) * t)


def _resample(points: list[Pt], min_step: float) -> list[Pt]:
    """Keep points at least min_step apart (always keeps the last point)."""
    if not points:
        return []
    out = [points[0]]
    for p in points[1:]:
        if math.hypot(p[0] - out[-1][0], p[1] - out[-1][1]) >= min_step:
            out.append(p)
    if out[-1] != points[-1]:
        out.append(points[-1])
    return out


@dataclass(frozen=True)
class SatinSettings:
    spacing: float
    underlay_spacing: float
    edge_walk: bool
    edge_inset: float
    edge_stitch_length: float
    zigzag: bool
    zigzag_inset: float


def column_sequence(column: Column, start: int, forward: bool, s: SatinSettings) -> list[tuple[Pt, str]]:
    """Needle points for one column: underlay passes then satin, as (point, role)."""
    rungs = column.rungs
    if column.closed:
        rungs = rungs[start:] + rungs[:start]
        if not forward:
            rungs = rungs[:1] + rungs[1:][::-1]
    elif not forward:
        rungs = rungs[::-1]

    def along(seq: list[Rung], ahead: bool) -> list[Rung]:
        if column.closed:
            ring = seq + seq[:1]
            return ring if ahead else ring[::-1]
        return seq if ahead else seq[::-1]

    points: list[tuple[Pt, str]] = []
    ahead = True
    if s.edge_walk:
        left = _resample([_inset(r, "left", s.edge_inset) for r in along(rungs, ahead)], s.edge_stitch_length)
        right = _resample([_inset(r, "right", s.edge_inset) for r in along(rungs, not ahead)], s.edge_stitch_length)
        points += [(p, "underlay") for p in left + right]
    if s.zigzag:
        step = max(1, round(s.underlay_spacing / s.spacing))
        seq = along(rungs, ahead)[::step]
        points += [(_inset(r, "left" if i % 2 == 0 else "right", s.zigzag_inset), "underlay") for i, r in enumerate(seq)]
        ahead = not ahead
    seq = along(rungs, ahead)
    points += [((r.left if i % 2 == 0 else r.right), "satin") for i, r in enumerate(seq)]
    return points


def entry_options(column: Column, pos: Pt | None) -> list[tuple[int, bool]]:
    """(start rung, direction) choices worth trying from the current needle position."""
    if not column.closed:
        return [(0, True), (0, False)]
    if pos is None:
        return [(0, True)]
    nearest = min(range(len(column.rungs)),
                  key=lambda i: math.hypot(column.rungs[i].center[0] - pos[0], column.rungs[i].center[1] - pos[1]))
    return [(nearest, True), (nearest, False)]


def label_point(column: Column) -> Point:
    return column.centerline.interpolate(0.5, normalized=True)
