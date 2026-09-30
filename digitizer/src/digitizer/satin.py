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
from shapely.geometry import LineString, MultiLineString, MultiPoint, Point, Polygon
from shapely.ops import linemerge, unary_union
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
    station: int  # index along the centerline; gaps in the sequence mean dropped rungs
    center: Pt
    left: Pt   # after pull compensation
    right: Pt
    width_mm: float  # before pull compensation
    edge_left: Pt  # on the outline, before pull compensation
    edge_right: Pt


@dataclass
class Column:
    centerline: LineString
    closed: bool
    rungs: list[Rung] = field(default_factory=list)
    skipped_rungs: int = 0  # stations dropped because no sensible edge-to-edge line exists
    stations: int = 0  # how many stations the centerline was cut into
    cover: Polygon | None = None  # cached coverage()


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
    column = Column(centerline, closed, stations=len(stations))
    for station, d in enumerate(stations):
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
        def at(dist_left: float, dist_right: float) -> tuple[Pt, Pt]:
            return ((center[0] + normal[0] * dist_left, center[1] + normal[1] * dist_left),
                    (center[0] - normal[0] * dist_right, center[1] - normal[1] * dist_right))

        edge_left, edge_right = at(up, down)
        left, right = at(up + pull_comp / 2, down + pull_comp / 2)
        column.rungs.append(Rung(station, center, left, right, up + down, edge_left, edge_right))
    return column


# ---------- junctions: trimming, splitting, coverage ----------

def rung_segment(rung: Rung) -> LineString:
    return LineString([rung.edge_left, rung.edge_right])


def coverage(column: Column) -> Polygon:
    """Area the column's satin covers (outline edges, before pull compensation)."""
    if column.cover is not None:
        return column.cover
    rungs = column.rungs
    pairs = list(zip(rungs, rungs[1:]))
    if column.closed and len(rungs) > 2:
        pairs.append((rungs[-1], rungs[0]))
    quads = [MultiPoint([a.edge_left, a.edge_right, b.edge_left, b.edge_right]).convex_hull for a, b in pairs]
    column.cover = unary_union(quads) if quads else Polygon()
    return column.cover


def trim(column: Column, blocked) -> int:
    """Drop rungs whose edge-to-edge line touches `blocked`. Returns how many were dropped."""
    if blocked.is_empty:
        return 0
    keep = [r for r in column.rungs if not rung_segment(r).intersects(blocked)]
    dropped = len(column.rungs) - len(keep)
    column.rungs = keep
    column.cover = None
    return dropped


def split_runs(column: Column) -> tuple[list[Column], int]:
    """Split a column wherever stations are missing, so satin never stitches across a gap.
    Runs shorter than two rungs cannot form satin and are dropped (returned as a count)."""
    rungs = column.rungs
    if not rungs:
        return [], 0
    if column.closed and len(rungs) == column.stations:
        return [column], 0
    runs: list[list[Rung]] = [[rungs[0]]]
    for prev, rung in zip(rungs, rungs[1:]):
        if rung.station == prev.station + 1:
            runs[-1].append(rung)
        else:
            runs.append([rung])
    # On a closed loop, a run touching the seam continues into the run at the other end.
    if column.closed and len(runs) > 1 and runs[0][0].station == 0 and runs[-1][-1].station == column.stations - 1:
        runs[0] = runs.pop() + runs[0]
    out, dropped = [], 0
    for run in runs:
        if len(run) < 2:
            dropped += len(run)
            continue
        centerline = LineString([r.center for r in run])
        out.append(Column(centerline, False, run, 0, column.stations))
    return out, dropped



def _inset(rung: Rung, side: str, inset: float) -> Pt:
    edge = rung.left if side == "left" else rung.right
    half = math.hypot(edge[0] - rung.center[0], edge[1] - rung.center[1])
    if half <= inset:
        return rung.center
    t = (half - inset) / half
    return (rung.center[0] + (edge[0] - rung.center[0]) * t, rung.center[1] + (edge[1] - rung.center[1]) * t)


def _resample(points: list[Pt], min_step: float, inside: Polygon) -> list[Pt]:
    """Keep points at least min_step apart, but also keep a point whenever skipping it would
    make the next stitch leave the column (tight inner corners). Always keeps the last point."""
    if not points:
        return []
    out = [points[0]]
    for i in range(1, len(points)):
        p, last = points[i], out[-1]
        nxt = points[i + 1] if i + 1 < len(points) else None
        if (nxt is None or math.hypot(p[0] - last[0], p[1] - last[1]) >= min_step
                or not inside.contains(LineString([last, nxt]))):
            out.append(p)
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
    inside = coverage(column)
    ahead = True
    if s.edge_walk:
        left = _resample([_inset(r, "left", s.edge_inset) for r in along(rungs, ahead)], s.edge_stitch_length, inside)
        right = _resample([_inset(r, "right", s.edge_inset) for r in along(rungs, not ahead)], s.edge_stitch_length, inside)
        points += [(p, "underlay") for p in left + right]
    if s.zigzag:
        step = max(1, round(s.underlay_spacing / s.spacing))
        seq = along(rungs, ahead)
        sides = ("left", "right")
        i, side = 0, 0
        zig = [_inset(seq[0], sides[side], s.zigzag_inset)]
        while i < len(seq) - 1:
            # Take the usual step, or a shorter one where the full step would leave the column.
            j = min(i + step, len(seq) - 1)
            while j > i + 1 and not inside.contains(
                    LineString([zig[-1], _inset(seq[j], sides[1 - side], s.zigzag_inset)])):
                j -= 1
            i, side = j, 1 - side
            zig.append(_inset(seq[i], sides[side], s.zigzag_inset))
        points += [(p, "underlay") for p in zig]
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


# ---------- a column between two given edges (editor: "Select Satin Columns", "Draw edges") ----------

def _ring_orientation(points: list[Pt]) -> float:
    """Twice the signed area: > 0 counter-clockwise (in y-up terms), < 0 clockwise."""
    return sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(points, points[1:] + points[:1]))


def _at(line: LineString, fraction: float) -> Pt:
    p = line.interpolate(fraction, normalized=True)
    return p.x, p.y


def column_between(left: list[Pt], right: list[Pt], closed: bool, spacing: float, pull_comp: float) -> Column:
    """Satin between two edges the user chose. Both edges are cut into the same number of
    stations by length, so rungs join matching points; open edges are turned to run the same
    way, closed loops are turned the same way round and started at the nearest points. Each
    rung is widened by pull_comp in total (half at each end)."""
    if closed:
        left, right = [tuple(p) for p in left], [tuple(p) for p in right]
        left, right = (left[:-1] if left[0] == left[-1] else left), (right[:-1] if right[0] == right[-1] else right)
        if (_ring_orientation(left) > 0) != (_ring_orientation(right) > 0):
            right = right[::-1]
        k = min(range(len(right)), key=lambda i: math.hypot(right[i][0] - left[0][0], right[i][1] - left[0][1]))
        right = right[k:] + right[:k]
        left_line, right_line = LineString(left + left[:1]), LineString(right + right[:1])
    else:
        straight = math.dist(left[0], right[0]) + math.dist(left[-1], right[-1])
        crossed = math.dist(left[0], right[-1]) + math.dist(left[-1], right[0])
        if crossed < straight:
            right = right[::-1]
        left_line, right_line = LineString(left), LineString(right)
    count = max(2, math.ceil(max(left_line.length, right_line.length) / spacing))
    fractions = [k / count for k in range(count if closed else count + 1)]
    column = Column(LineString([(0, 0), (0, 0)]), closed, stations=len(fractions))
    centers = []
    for station, t in enumerate(fractions):
        a, b = _at(left_line, t), _at(right_line, t)
        width = math.dist(a, b)
        ux, uy = _unit(a[0] - b[0], a[1] - b[1])
        half = pull_comp / 2
        center = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
        centers.append(center)
        column.rungs.append(Rung(station, center, (a[0] + ux * half, a[1] + uy * half),
                                 (b[0] - ux * half, b[1] - uy * half), width, a, b))
    column.centerline = LineString(centers + (centers[:1] if closed else []))
    return column


def running_path(ring: list[Pt], stitch_length: float) -> list[Pt]:
    """Needle points along a closed outline, evenly spaced, none further apart than stitch_length.
    Returns the loop without repeating its first point."""
    line = LineString(ring)
    count = max(3, math.ceil(line.length / stitch_length))
    return [_at(line, k / count) for k in range(count)]
