"""Single-colour logo image -> fill + satin DST and a preview PNG.

Pipeline:
  1. load, threshold to black/white (Otsu, or the alpha channel if present), remove specks
  2. trace contours with OpenCV -> shapely polygons with holes
  3. scale to the design width (so all stitch spacing is in real millimetres)
  4. classify each polygon by its widest point: wider than satin.max_width_mm -> fill, else satin
  5. fill: parallel scanlines at the configured angle and row spacing, zigzag row order
     satin: skeleton centerline -> rungs perpendicular to it -> underlay (edge walk, zigzag)
     then satin from edge to edge, widened by pull compensation
  6. order all pieces greedily to avoid jumps (short in-shape moves are sewn, others jump)
  7. split stitches longer than the max length, write DST with pyembroidery
  8. read the DST back, check it matches what was written, render the preview from it

All numbers come from digitizer.config. No lock stitches, fill underlay or colours yet.
"""

from __future__ import annotations

import argparse
import json
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import cv2
import numpy as np
import pyembroidery
from shapely import affinity
from shapely.geometry import LineString, MultiPolygon, Point, Polygon
from shapely.ops import unary_union

from digitizer import satin
from digitizer.config import Config, load_config, load_test_run_config
from digitizer.readback import DstStats, dst_stats, render_preview, stitch_points

UNITS_PER_MM = 10  # pyembroidery / DST coordinates are in 0.1 mm; a unit conversion, not a setting.


# ---------- 1. image -> clean binary mask ----------

def load_mask(path: str | Path, min_speck_area_px: int) -> np.ndarray:
    """Return a uint8 mask, 255 = logo, 0 = background."""
    image = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    if image is None:
        raise ValueError(f"could not read image {path} (PNG and JPG are supported)")

    if image.ndim == 3 and image.shape[2] == 4 and image[:, :, 3].min() < 255:
        # Transparent PNG: the alpha channel is the logo.
        _, mask = cv2.threshold(image[:, :, 3], 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    else:
        gray = image if image.ndim == 2 else cv2.cvtColor(image[:, :, :3], cv2.COLOR_BGR2GRAY)
        # Dark logo on a light background.
        _, mask = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)

    mask = _drop_small_components(mask, min_speck_area_px)  # specks of ink
    mask = 255 - _drop_small_components(255 - mask, min_speck_area_px)  # pinholes in the logo
    if not mask.any():
        raise ValueError("no logo found after thresholding and speck removal")
    return mask


def logo_bounds(path: str | Path, min_speck_area_px: int) -> tuple[int, int] | None:
    """Width and height (px) of the logo's bounding box after thresholding, or None if no logo."""
    try:
        mask = load_mask(path, min_speck_area_px)
    except ValueError:
        return None
    _, _, w, h = cv2.boundingRect(mask)
    return w, h


def _drop_small_components(mask: np.ndarray, min_area: int) -> np.ndarray:
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    keep = np.zeros(count, dtype=bool)
    keep[1:] = stats[1:, cv2.CC_STAT_AREA] >= min_area
    return np.where(keep[labels], 255, 0).astype(np.uint8)


# ---------- 2. mask -> polygons with holes ----------

def mask_to_polygons(mask: np.ndarray) -> list[Polygon]:
    """Outer contours become shells, their child contours become holes (pixel coordinates)."""
    contours, hierarchy = cv2.findContours(mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    if hierarchy is None:
        return []
    hierarchy = hierarchy[0]
    shapes = []
    for i, (_next, _prev, first_child, parent) in enumerate(hierarchy):
        if parent != -1 or len(contours[i]) < 3:
            continue
        shell = contours[i][:, 0, :].astype(float)
        holes = []
        child = first_child
        while child != -1:
            if len(contours[child]) >= 3:
                holes.append(contours[child][:, 0, :].astype(float))
            child = hierarchy[child][0]
        polygon = Polygon(shell, holes).buffer(0)  # repair self-touching pixel outlines
        shapes.extend(_polygons(polygon))
    return shapes


def _polygons(geometry) -> list[Polygon]:
    if isinstance(geometry, Polygon):
        return [geometry] if not geometry.is_empty else []
    if isinstance(geometry, MultiPolygon):
        return [g for g in geometry.geoms if not g.is_empty]
    return []


# ---------- 3. scale to millimetres ----------

@dataclass(frozen=True)
class PxToMm:
    """Pixel -> mm mapping: centre the logo on (0, 0) and scale to the design width."""
    cx: float
    cy: float
    mm_per_px: float

    def geom(self, g):
        return affinity.scale(affinity.translate(g, -self.cx, -self.cy), self.mm_per_px, self.mm_per_px, origin=(0, 0))

    def to_px(self, p):
        return p[0] / self.mm_per_px + self.cx, p[1] / self.mm_per_px + self.cy


def scale_to_width(polygons: list[Polygon], width_mm: float) -> tuple[list[Polygon], PxToMm]:
    min_x, min_y, max_x, max_y = unary_union(polygons).bounds
    tf = PxToMm((min_x + max_x) / 2, (min_y + max_y) / 2, width_mm / (max_x - min_x))
    return [tf.geom(p) for p in polygons], tf


# ---------- 5a. fill rows ----------

@dataclass
class Row:
    index: int
    start: tuple[float, float]
    end: tuple[float, float]


def fill_rows(polygon: Polygon, angle_deg: float, spacing_mm: float, min_len_mm: float) -> list[Row]:
    """Parallel rows across the polygon at angle_deg, spacing_mm apart (holes stay empty)."""
    rotated = affinity.rotate(polygon, -angle_deg, origin=(0, 0))
    min_x, min_y, max_x, max_y = rotated.bounds
    rows: list[Row] = []
    y = min_y + spacing_mm / 2
    index = 0
    while y < max_y:
        scan = LineString([(min_x - 1, y), (max_x + 1, y)])
        hit = rotated.intersection(scan)
        for piece in getattr(hit, "geoms", [hit]):
            if not isinstance(piece, LineString) or piece.length < min_len_mm:
                continue
            back = affinity.rotate(piece, angle_deg, origin=(0, 0))
            rows.append(Row(index, back.coords[0], back.coords[-1]))
        y += spacing_mm
        index += 1
    return rows


@dataclass
class Move:
    kind: str  # "stitch" or "jump"
    to: tuple[float, float]
    role: str = ""  # fill, patch, travel, underlay, satin
    piece: int = 0  # satin column number (1-based, sewing order); 0 for fill/travel
    source: int = -1  # index of the piece this move belongs to


def order_rows(rows: list[Row], area: Polygon, jump_threshold_mm: float, start_pos=None) -> list[Move]:
    """Boustrophedon walk over one fill area. The first move goes to the first row start; the
    caller decides whether that approach is sewn or jumped."""
    by_index: dict[int, list[int]] = {}
    for i, row in enumerate(rows):
        by_index.setdefault(row.index, []).append(i)
    remaining = set(range(len(rows)))
    if start_pos is None:
        current = min(remaining, key=lambda i: (rows[i].index, rows[i].start))
    else:
        current = min(remaining, key=lambda i: _dist(start_pos, _nearest_end(rows[i], start_pos)))
    pos = start_pos
    moves: list[Move] = []
    while True:
        row = rows[current]
        remaining.discard(current)
        start, end = _orient(row, pos)
        sewn = bool(moves) and _sewable(pos, start, area, jump_threshold_mm)
        moves.append(Move("stitch" if sewn else "jump", start, "fill"))
        moves.append(Move("stitch", end, "fill"))
        pos = end
        if not remaining:
            return moves
        neighbours = [i for step in (1, -1) for i in by_index.get(row.index + step, []) if i in remaining]
        reachable = [i for i in neighbours if _sewable(pos, _nearest_end(rows[i], pos), area, jump_threshold_mm)]
        pool = reachable or list(remaining)
        current = min(pool, key=lambda i: _dist(pos, _nearest_end(rows[i], pos)))


def _orient(row: Row, pos):
    if pos is not None and _dist(pos, row.end) < _dist(pos, row.start):
        return row.end, row.start
    return row.start, row.end


def _nearest_end(row: Row, pos):
    return _orient(row, pos)[0]


def travel_allowed(a, b, logo, jump_threshold_mm: float, sewn_area) -> bool:
    """A move between pieces is sewn only if it is short, stays inside the logo and does not
    run over stitching that is already done (it would show on top). Otherwise it jumps."""
    return _sewable(a, b, logo, jump_threshold_mm) and not LineString([a, b]).intersects(sewn_area)


def _sewable(a, b, area: Polygon, max_len: float) -> bool:
    return _dist(a, b) <= max_len and area.contains(LineString([a, b]))


def _dist(a, b) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


# ---------- 4-5. classify polygons and build pieces ----------

@dataclass
class Piece:
    kind: str  # "fill" or "satin"
    area: Polygon  # the shape it belongs to, slightly grown, for in-shape checks
    cover: Polygon  # the area this piece's stitches cover
    rows: list[Row] = field(default_factory=list)
    column: satin.Column | None = None
    patch: bool = False  # a fill patch where satin columns meet or leave a gap


@dataclass
class Pieces:
    pieces: list[Piece]
    skipped_rungs: int = 0  # stations with no sensible edge-to-edge line
    trimmed_rungs: int = 0  # rungs removed at junctions or where columns would overlap

    @property
    def patches(self) -> int:
        return sum(p.patch for p in self.pieces)


def build_pieces(mask: np.ndarray, polygons_px: list[Polygon], polygons: list[Polygon], tf: PxToMm,
                 config: Config, on_shape_done: Callable[[int, int], None] | None = None) -> Pieces:
    """on_shape_done(done, total) is called after each shape, for progress reporting."""
    max_width = config.get("satin.max_width_mm")
    min_len = config.get("stitch.min_stitch_length_mm")
    tolerance = tf.mm_per_px  # traced outlines are pixel staircases: allow one source pixel
    result = Pieces([])
    pieces = result.pieces
    for shape_index, (poly_px, poly) in enumerate(zip(polygons_px, polygons)):
        if on_shape_done:
            on_shape_done(shape_index, len(polygons))
        shape_mask = satin.polygon_mask(poly_px, mask.shape)
        dist = satin.distance_map(shape_mask)
        area = poly.buffer(tolerance)
        if satin.max_width_px(dist) * tf.mm_per_px > max_width:
            pieces.append(Piece("fill", area, poly, rows=_rows(poly, config)))
            continue

        def radius_mm(p, dist=dist):
            x, y = tf.to_px(p)
            yi = min(max(int(round(y)), 0), dist.shape[0] - 1)
            xi = min(max(int(round(x)), 0), dist.shape[1] - 1)
            return max(float(dist[yi, xi]), 1.0) * tf.mm_per_px

        lines_px = satin.prune_spurs(satin.skeleton_lines(shape_mask), dist, config.get("satin.spur_prune_factor"))
        degree = satin.end_degrees(lines_px)
        columns = []
        for line_px in lines_px:
            if line_px.length == 0:
                continue
            line = tf.geom(line_px)
            if not line.is_closed:
                line = satin.extend_free_ends(
                    line, degree[line_px.coords[0]] == 1, degree[line_px.coords[-1]] == 1, poly, max_width, radius_mm
                )
            column = satin.build_column(
                line, poly, config.get("stitch.satin_spacing_mm"), max_width,
                config.get("stitch.pull_compensation_mm"), min_len, radius_mm,
            )
            result.skipped_rungs += column.skipped_rungs
            columns.append(column)

        # Junctions: where three or more centerline branches meet, no rung may enter the
        # largest circle that fits there; that area is sewn as a fill patch instead.
        junctions = unary_union([
            tf.geom(Point(node)).buffer(dist[int(node[1]), int(node[0])] * tf.mm_per_px)
            for node, d in degree.items() if d >= 3
        ])
        runs: list[satin.Column] = []
        for column in columns:
            result.trimmed_rungs += satin.trim(column, junctions)
            split, dropped = satin.split_runs(column)
            runs += split
            result.trimmed_rungs += dropped
        # Where columns would still run over each other, the longer one keeps its rungs.
        runs.sort(key=lambda c: len(c.rungs), reverse=True)
        covered = Polygon()
        for run in runs:
            result.trimmed_rungs += satin.trim(run, covered.buffer(-tolerance))
            split, dropped = satin.split_runs(run)
            result.trimmed_rungs += dropped
            for column in split:
                cover = satin.coverage(column)
                pieces.append(Piece("satin", area, cover, column=column))
                covered = unary_union([covered, cover])

        # Whatever the columns leave uncovered (junctions, skipped stations) becomes fill,
        # unless it is too thin to hold a stitch of the minimum length.
        rest = poly.difference(covered) if not covered.is_empty else poly
        for gap in satin_gaps(rest, min_len):
            rows = _rows(gap, config)
            if rows:
                pieces.append(Piece("fill", gap.buffer(tolerance), gap, rows=rows, patch=not covered.is_empty))
    return result


def satin_gaps(rest, min_len: float) -> list[Polygon]:
    parts = rest.geoms if hasattr(rest, "geoms") else [rest]
    return [p for p in parts if isinstance(p, Polygon) and not p.buffer(-min_len / 2).is_empty]


def _rows(poly: Polygon, config: Config) -> list[Row]:
    return fill_rows(poly, config.get("stitch.fill_angle_deg"), config.get("stitch.fill_row_spacing_mm"),
                     config.get("stitch.min_stitch_length_mm"))


def satin_settings(config: Config) -> satin.SatinSettings:
    return satin.SatinSettings(
        spacing=config.get("stitch.satin_spacing_mm"),
        underlay_spacing=config.get("stitch.underlay_spacing_mm"),
        edge_walk=bool(config.get("satin.underlay_edge_walk")),
        edge_inset=config.get("satin.underlay_edge_inset_mm"),
        edge_stitch_length=config.get("satin.underlay_edge_stitch_length_mm"),
        zigzag=bool(config.get("satin.underlay_zigzag")),
        zigzag_inset=config.get("satin.underlay_zigzag_inset_mm"),
    )


# ---------- 6. order all pieces ----------

@dataclass
class Plan:
    moves: list[Move]
    satin_labels: dict[int, tuple[float, float]]  # column number -> label position (mm)


def plan_pieces(pieces: list[Piece], logo: Polygon, settings: satin.SatinSettings, jump_threshold_mm: float,
                tolerance_mm: float) -> Plan:
    """Greedy: from the needle position take the piece whose entry point is nearest, preferring
    entries reachable by a short stitch that stays inside the logo and does not run over
    stitching that is already sewn (it would show on top); otherwise jump."""
    remaining = list(range(len(pieces)))
    moves: list[Move] = []
    labels: dict[int, tuple[float, float]] = {}
    pos = None
    sewn_area = Polygon()  # shrunk by the tolerance so a travel may start on a sewn edge

    def travel_ok(a, b) -> bool:
        return travel_allowed(a, b, logo, jump_threshold_mm, sewn_area)

    while remaining:
        options = []  # (piece index, entry point, builder)
        for i in remaining:
            piece = pieces[i]
            if piece.kind == "fill":
                entry = (min((r.start for r in piece.rows), key=lambda p: (p[1], p[0])) if pos is None
                         else min((_nearest_end(r, pos) for r in piece.rows), key=lambda p: _dist(pos, p)))
                options.append((i, entry, None))
            else:
                for start, forward in satin.entry_options(piece.column, pos):
                    seq = satin.column_sequence(piece.column, start, forward, settings)
                    options.append((i, seq[0][0], seq))
        if pos is None:
            choice = min(options, key=lambda o: (o[1][1], o[1][0]))
            sewn = False
        else:
            reachable = [o for o in options if travel_ok(pos, o[1])]
            choice = min(reachable or options, key=lambda o: _dist(pos, o[1]))
            sewn = bool(reachable)
        i, entry, seq = choice
        remaining.remove(i)
        piece = pieces[i]
        if piece.kind == "fill":
            role = "patch" if piece.patch else "fill"
            piece_moves = [Move(m.kind, m.to, role, 0, i) for m in order_rows(piece.rows, piece.area, jump_threshold_mm, pos)]
            piece_moves[0] = Move("stitch" if sewn else "jump", piece_moves[0].to, "travel" if sewn else "", 0, i)
        else:
            number = len(labels) + 1
            labels[number] = satin.label_point(piece.column).coords[0]
            piece_moves = [Move("stitch", p, role, number, i) for p, role in seq]
            piece_moves[0] = Move("stitch" if sewn else "jump", entry, "travel" if sewn else "", number, i)
        moves.extend(piece_moves)
        pos = moves[-1].to
        sewn_area = unary_union([sewn_area, piece.cover.buffer(-tolerance_mm)])
    return Plan(moves, labels)


# ---------- 7. split long stitches and build the pattern ----------

@dataclass
class Built:
    pattern: pyembroidery.EmbPattern
    stitches: list[tuple[int, int]]  # every STITCH record, in file units
    labels: list[tuple[str, int]]  # (role, column number) per STITCH record
    jumps: int  # needle-up moves after the first positioning move
    trims: int
    sources: list[int] = field(default_factory=list)  # piece index per STITCH record


def build_pattern(moves: list[Move], max_stitch_mm: float, trim_threshold_mm: float) -> Built:
    # The file stores whole 0.1 mm units; rounding both ends can lengthen a stitch by up to
    # one unit diagonal, so split against the limit minus that amount.
    split_at = max_stitch_mm - math.sqrt(2) / UNITS_PER_MM
    built = Built(pyembroidery.EmbPattern(), [], [], 0, 0)
    pos, last = None, None
    for move in moves:
        if move.kind == "jump":
            if pos is not None:
                built.jumps += 1
                if _dist(pos, move.to) > trim_threshold_mm:
                    built.pattern.add_command(pyembroidery.TRIM)
                    built.trims += 1
            last = _units(move.to)
            built.pattern.add_stitch_absolute(pyembroidery.JUMP, *last)
            pos = move.to
            continue
        for point in _split(pos, move.to, split_at):
            q = _units(point)
            if q == last:
                continue
            built.pattern.add_stitch_absolute(pyembroidery.STITCH, *q)
            built.stitches.append(q)
            built.labels.append((move.role, move.piece))
            built.sources.append(move.source)
            last = q
        pos = move.to
    built.pattern.add_command(pyembroidery.END)
    return built


def _split(a, b, max_len: float):
    """Points from a (exclusive) to b (inclusive), evenly spaced, no step longer than max_len."""
    if a is None:
        return [b]
    pieces = max(1, math.ceil(_dist(a, b) / max_len))
    return [(a[0] + (b[0] - a[0]) * k / pieces, a[1] + (b[1] - a[1]) * k / pieces) for k in range(1, pieces + 1)]


def _units(point_mm) -> tuple[int, int]:
    return round(point_mm[0] * UNITS_PER_MM), round(point_mm[1] * UNITS_PER_MM)


# ---------- entry point ----------

@dataclass(frozen=True)
class Result:
    stats: DstStats  # read back from the DST
    jumps: int  # needle-up moves between pieces or rows (not counting the first move to the start)
    trims: int
    fill_areas: int
    satin_columns: int
    junction_patches: int  # fill patches where satin columns meet or leave a gap
    skipped_rungs: int  # satin stations with no sensible edge-to-edge line
    trimmed_rungs: int  # rungs removed at junctions or where columns would overlap
    # Layers are the pieces in sewing order: (type, stitch count), type is fill/satin/junction patch.
    layers: tuple[tuple[str, int], ...] = ()
    stitch_layers: tuple[int, ...] = ()  # 1-based layer number for every STITCH record in the file

    def summary(self) -> str:
        return (f"{self.stats.summary()}\n  pieces: {self.fill_areas} fill, {self.satin_columns} satin columns, "
                f"{self.junction_patches} junction patches; jumps={self.jumps} trims={self.trims}; "
                f"skipped_rungs={self.skipped_rungs} trimmed_rungs={self.trimmed_rungs}")

    def to_json(self) -> dict:
        return {
            "jumps": self.jumps, "trims": self.trims, "fill_areas": self.fill_areas,
            "satin_columns": self.satin_columns, "junction_patches": self.junction_patches,
            "skipped_rungs": self.skipped_rungs, "trimmed_rungs": self.trimmed_rungs,
        }


def digitize(image_path: str | Path, out_dir: str | Path, config: Config | None = None,
             width_mm: float | None = None) -> Result:
    """Write out.dst and preview.png into out_dir. width_mm overrides design.width_mm for this job."""
    config = config or load_config()
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    mask = load_mask(image_path, config.get("image.min_speck_area_px"))
    polygons_px = mask_to_polygons(mask)
    polygons, tf = scale_to_width(polygons_px, width_mm or config.get("design.width_mm"))
    built_pieces = build_pieces(mask, polygons_px, polygons, tf, config)
    pieces = built_pieces.pieces

    logo = unary_union(polygons).buffer(tf.mm_per_px)
    plan = plan_pieces(pieces, logo, satin_settings(config), config.get("stitch.jump_threshold_mm"), tf.mm_per_px)
    built = build_pattern(plan.moves, config.get("stitch.max_stitch_length_mm"), config.get("stitch.trim_threshold_mm"))

    dst_path = out_dir / "out.dst"
    pyembroidery.write_dst(built.pattern, str(dst_path))
    if stitch_points(dst_path) != built.stitches:
        raise RuntimeError("DST read back from disk does not match the stitches that were written")
    render_preview(dst_path, out_dir / "preview.png", config, built.labels,
                   {n: _units(p) for n, p in plan.satin_labels.items()})
    layer_of: dict[int, int] = {}
    for source in built.sources:  # number pieces in the order they are sewn
        layer_of.setdefault(source, len(layer_of) + 1)
    counts = {n: 0 for n in layer_of.values()}
    for source in built.sources:
        counts[layer_of[source]] += 1
    kinds = {n: _layer_type(pieces[s]) for s, n in layer_of.items()}
    result = Result(dst_stats(dst_path), built.jumps, built.trims,
                    sum(p.kind == "fill" and not p.patch for p in pieces), sum(p.kind == "satin" for p in pieces),
                    built_pieces.patches, built_pieces.skipped_rungs, built_pieces.trimmed_rungs,
                    tuple((kinds[n], counts[n]) for n in sorted(counts)),
                    tuple(layer_of[s] for s in built.sources))
    # The DST format has no room for these; keep them next to it for the readback report.
    (out_dir / "report.json").write_text(json.dumps(result.to_json(), indent=2) + "\n")
    return result


def trace_columns(image_path: str | Path, config: Config, width_mm: float | None = None,
                  on_progress: Callable[[float], None] | None = None) -> dict:
    """Satin columns for the editor: each column's two edges and a few edit points along its
    centerline, in mm (same coordinates as the DST). on_progress gets 0..1 as shapes are done."""
    report = on_progress or (lambda _f: None)
    report(0.0)
    mask = load_mask(image_path, config.get("image.min_speck_area_px"))
    polygons_px = mask_to_polygons(mask)
    polygons, tf = scale_to_width(polygons_px, width_mm or config.get("design.width_mm"))
    report(0.1)
    built = build_pieces(mask, polygons_px, polygons, tf, config,
                         on_shape_done=lambda done, total: report(0.1 + 0.85 * done / max(total, 1)))
    tolerance = config.get("editor.edit_point_tolerance_mm")
    columns = []
    for piece in built.pieces:
        if piece.kind != "satin":
            continue
        column = piece.column
        edit = column.centerline.simplify(tolerance)
        columns.append({
            "number": len(columns) + 1,
            "left": [list(r.edge_left) for r in column.rungs],
            "right": [list(r.edge_right) for r in column.rungs],
            "edit_points": [list(p) for p in edit.coords],
            "label": list(satin.label_point(column).coords[0]),
        })
    min_x, min_y, max_x, max_y = unary_union(polygons).bounds
    report(1.0)
    return {
        "columns": columns,
        "fill_shapes": sum(p.kind == "fill" and not p.patch for p in built.pieces),
        "junction_patches": built.patches,
        "bounds_mm": [min_x, min_y, max_x, max_y],
        "width_mm": max_x - min_x,
    }


def _layer_type(piece: Piece) -> str:
    return "satin" if piece.kind == "satin" else "junction patch" if piece.patch else "fill"


def main() -> None:
    parser = argparse.ArgumentParser(description="Digitize a single-colour logo into out.dst + preview.png")
    parser.add_argument("image", help="PNG or JPG logo, dark on light or transparent background")
    parser.add_argument("--out", default=".", help="output folder (default: current folder)")
    parser.add_argument("--width-mm", type=float, help="design width for this job (default: design.width_mm)")
    parser.add_argument(
        "--test-run-values",
        action="store_true",
        help="use TEST_RUN_OVERRIDES from config.py for unchosen values (not for sewing)",
    )
    args = parser.parse_args()
    config = load_test_run_config() if args.test_run_values else load_config()
    print(digitize(args.image, args.out, config, args.width_mm).summary())


if __name__ == "__main__":
    main()
