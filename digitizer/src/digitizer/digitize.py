"""Logo image -> multi-colour fill + satin DST, a preview PNG and a report.

Pipeline:
  1. quantize to a few flat colours in Lab and remove the background (digitizer.colours)
  2. trace each colour's pixels with OpenCV -> shapely polygons with holes
  3. scale to the design width (so all stitch spacing is in real millimetres); drop specks
     smaller than input.min_shape_area_mm2 and fill holes smaller than that
  4. classify each polygon by its widest point: wider than satin.max_width_mm -> fill, else satin
     (steps 1-4 are trace_design(), shared by every caller)
  5. fill: parallel scanlines at the configured angle and row spacing, zigzag row order
     satin: skeleton centerline -> rungs perpendicular to it -> underlay (edge walk, zigzag)
     then satin from edge to edge, widened by pull compensation
  6. sew colour by colour, largest total area first (see trace_design); within a colour, order
     pieces greedily to avoid jumps (short in-shape moves are sewn, others jump); between
     colours: trim, colour change, jump
  7. split stitches longer than the max length, write DST with pyembroidery
  8. read the DST back, check it matches what was written, render the preview from it

All numbers come from digitizer.config. No lock stitches or fill underlay yet.
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

from digitizer import colours, satin
from digitizer.config import Config, load_config, load_test_run_config
from digitizer.readback import DstStats, dst_stats, render_preview, stitch_points

UNITS_PER_MM = 10  # pyembroidery / DST coordinates are in 0.1 mm; a unit conversion, not a setting.


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


# ---------- 1-4. image -> colour layers of classified shapes (shared by every caller) ----------

@dataclass
class Shape:
    number: int  # 1-based over the whole design, in sewing order
    colour: int  # number of its colour layer (1-based, sewing order)
    poly_px: Polygon  # in image pixels
    poly: Polygon  # in mm, design coordinates
    # "fill", "satin" or "running"; "column" for a satin column made in the editor between two
    # edges (see `edges`); "" when the caller did not ask for classification.
    kind: str = ""
    max_width_mm: float = 0.0  # widest point (largest circle that fits inside)
    # The part added by colour overlap (under later, touching colours), in mm; empty if none.
    # poly and poly_px already include it.
    overlap: Polygon | MultiPolygon = field(default_factory=Polygon)
    pull_compensation_mm: float | None = None  # set in the editor; None = stitch.pull_compensation_mm
    kind_chosen: bool = False  # the stitch type was chosen in the editor, not by width
    # kind "column": its two edges in pixels, and whether they are closed loops (outline + hole)
    edges: tuple[list, list, bool] | None = None


@dataclass
class ColourLayer:
    number: int  # 1-based, sewing order
    colour: colours.Colour
    shapes: list[Shape]

    @property
    def hex(self) -> str:
        return self.colour.hex


@dataclass
class Traced:
    layers: list[ColourLayer]  # in sewing order
    tf: PxToMm
    image_shape: tuple[int, int]
    palette: list[colours.Colour]  # every colour found (background excluded), kept or not
    background: str | None  # removed background colour, None if it was transparency
    shapes_found: int  # shapes traced in the kept colours, before speck removal
    specks_removed: int  # shapes dropped as specks (smaller than input.min_shape_area_mm2)
    holes_filled: int  # holes filled because they were smaller than input.min_shape_area_mm2
    skipped_edits: list[str] = field(default_factory=list)  # editor changes that no longer apply

    @property
    def shapes(self) -> list[Shape]:
        return [shape for layer in self.layers for shape in layer.shapes]

    @property
    def bounds_mm(self) -> tuple[float, float, float, float]:
        return unary_union([s.poly for s in self.shapes]).bounds


def trace_design(image_path: str | Path, config: Config, width_mm: float | None = None,
                 keep_colours: list[str] | None = None, classify: bool = True,
                 edits: list[dict] | None = None) -> Traced:
    """The one place an image becomes colour layers of shapes. The CLI, the API's upload check,
    preview and shapes endpoints, and the editor's trace job all go through here, so they always
    agree on colours, shapes and order.

    1. Quantize to at most colour.max_colours flat colours and remove the background
       (digitizer.colours). keep_colours ("#RRGGBB" values from the palette) leaves the other
       colours out; None keeps them all.
    2. Trace each kept colour's pixels into polygons with holes.
    3. Scale to the design width. Speck removal: shapes smaller than input.min_shape_area_mm2
       are dropped and smaller holes are filled (judged at the scale of everything traced), then
       the kept shapes are scaled to the width.
    4. Classify each shape fill or satin by its widest point (satin.max_width_mm).

    5. Colour overlap (the one rule): a shape that touches a shape of a colour sewn later grows by
       colour.overlap_mm into that shape, so it runs under the later colour and no fabric shows
       between them (see grow_under_later_colours). Classification uses the grown shape.
    6. Editor changes (edits: stitch type, pull compensation, splits, satin columns between two
       edges), stored in image pixels and applied in order (digitizer.edits). A change that no
       longer fits the design (say its shape was left out) is skipped and listed in skipped_edits.

    Sewing order (the one rule): colour layers are sewn largest total shape area first, smallest
    last, so big areas go down first and small details are sewn on top; equal areas keep palette
    order. Within a layer, shapes keep the order they were traced in.
    """
    q = colours.quantize(colours.read_image(image_path), config)
    chosen = q.colours
    if keep_colours is not None:
        wanted = {c.upper() for c in keep_colours}
        chosen = [c for c in q.colours if c.hex in wanted]
        if not chosen:
            raise ValueError("none of the chosen colours are in this image")
    traced = [(c, mask_to_polygons(np.where(q.labels == c.index, 255, 0).astype(np.uint8))) for c in chosen]
    found = sum(len(polys) for _, polys in traced)
    if not found:
        raise ValueError("no logo found after removing the background")

    width = width_mm or config.get("design.width_mm")
    _, tf_all = scale_to_width([p for _, polys in traced for p in polys], width)
    min_area_px = config.get("input.min_shape_area_mm2") / tf_all.mm_per_px ** 2
    holes_filled = 0
    cleaned = []
    for colour, polys in traced:
        kept = []
        for p in polys:
            if p.area < min_area_px:
                continue
            holes = [h for h in p.interiors if Polygon(h).area >= min_area_px]
            holes_filled += len(p.interiors) - len(holes)
            kept.append(Polygon(p.exterior, holes) if len(holes) != len(p.interiors) else p)
        if kept:
            cleaned.append((colour, kept))
    kept_count = sum(len(polys) for _, polys in cleaned)
    if not kept_count:
        raise ValueError("only specks found: every shape is smaller than the minimum shape area")

    cleaned.sort(key=lambda item: (-sum(p.area for p in item[1]), item[0].index))
    _, tf = scale_to_width([p for _, polys in cleaned for p in polys], width)
    grown = grow_under_later_colours([(n, p) for n, (_, polys) in enumerate(cleaned) for p in polys],
                                     config.get("colour.overlap_mm") / tf.mm_per_px)
    max_width = config.get("satin.max_width_mm") if classify else None
    layers, number = [], 0
    for layer_number, (colour, polys) in enumerate(cleaned, start=1):
        shapes = []
        for _ in polys:
            poly_px, added = grown[number]
            number += 1
            shape = Shape(number, layer_number, poly_px, tf.geom(poly_px), overlap=tf.geom(added))
            if classify:
                shape.kind, _mask, dist = classify_shape(poly_px, q.shape, tf, max_width)
                shape.max_width_mm = shape_max_width_mm(dist, tf)
            shapes.append(shape)
        layers.append(ColourLayer(layer_number, colour, shapes))
    traced = Traced(layers, tf, q.shape, q.colours, q.background, found, found - kept_count, holes_filled)
    if edits and classify:
        from digitizer.edits import apply_edits  # edits builds on this module
        traced.skipped_edits = apply_edits(traced, edits, config)
    return traced


# Traced outlines run through the centres of each region's edge pixels, so two colour regions
# that touch are 1 px apart (sqrt(2) diagonally). Within this distance they count as neighbours.
# A property of the tracing (pixel units), not a product setting.
NEIGHBOUR_PX = 1.5


def grow_under_later_colours(shapes: list[tuple[int, Polygon]], distance_px: float):
    """Colour overlap. shapes are (layer index in sewing order, outline in pixels). Returns, per
    shape, (grown outline, the part that was added).

    A shape grows only where it touches a shape of a LATER layer (outlines within NEIGHBOUR_PX):
    by distance_px, and only into that later shape plus the seam between the two. So it never
    reaches a colour it does not touch, never grows past the design's outer edge (the seam is
    the only place outside both shapes it may cover), and the later colour, sewn on top, hides
    the overlap. The last colour never grows."""
    out = []
    for i, (layer, shape) in enumerate(shapes):
        reach = shape.buffer(distance_px)
        near = shape.buffer(NEIGHBOUR_PX)
        parts = []
        for j, (other_layer, other) in enumerate(shapes):
            if other_layer <= layer or distance_px <= 0 or shape.distance(other) > NEIGHBOUR_PX:
                continue
            seam = near.intersection(other.buffer(NEIGHBOUR_PX))
            parts.append(reach.intersection(unary_union([other, seam])))
        if not parts:
            out.append((shape, Polygon()))
            continue
        grown = unary_union([shape, *parts]).buffer(0)
        if isinstance(grown, MultiPolygon):  # drop crumbs that do not join the shape
            grown = max(grown.geoms, key=lambda g: g.intersection(shape).area)
        out.append((grown, grown.difference(shape)))
    return out


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
    kind: str  # "stitch", "jump", or "change" (trim, then change to the next thread colour)
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
    kind: str  # "fill", "satin" or "running"
    area: Polygon  # the shape it belongs to, slightly grown, for in-shape checks
    cover: Polygon  # the area this piece's stitches cover
    rows: list[Row] = field(default_factory=list)
    column: satin.Column | None = None
    patch: bool = False  # a fill patch where satin columns meet or leave a gap
    shape: int = 0  # number of the Shape this piece came from
    path: list[tuple[float, float]] = field(default_factory=list)  # kind "running": a closed loop


@dataclass
class Pieces:
    pieces: list[Piece]
    skipped_rungs: int = 0  # stations with no sensible edge-to-edge line
    trimmed_rungs: int = 0  # rungs removed at junctions or where columns would overlap

    @property
    def patches(self) -> int:
        return sum(p.patch for p in self.pieces)


def classify_shape(poly_px: Polygon, mask_shape: tuple[int, int], tf: PxToMm, max_width_mm: float):
    """"fill" if the shape is anywhere wider than a satin column may be, else "satin".
    Also returns the shape's own mask and distance map, which satin tracing reuses."""
    shape_mask = satin.polygon_mask(poly_px, mask_shape)
    dist = satin.distance_map(shape_mask)
    kind = "fill" if shape_max_width_mm(dist, tf) > max_width_mm else "satin"
    return kind, shape_mask, dist


def shape_max_width_mm(dist: np.ndarray, tf: PxToMm) -> float:
    return satin.max_width_px(dist) * tf.mm_per_px


def build_pieces(shapes: list[Shape], image_shape: tuple[int, int], tf: PxToMm, config: Config,
                 on_shape_done: Callable[[int, int], None] | None = None) -> Pieces:
    """Stitch pieces for classified shapes (from trace_design). on_shape_done(done, total) is
    called before each shape, for progress reporting."""
    max_width = config.get("satin.max_width_mm")
    min_len = config.get("stitch.min_stitch_length_mm")
    tolerance = tf.mm_per_px  # traced outlines are pixel staircases: allow one source pixel
    result = Pieces([])
    pieces = result.pieces
    for done, shape in enumerate(shapes):
        if on_shape_done:
            on_shape_done(done, len(shapes))
        poly, shape_number = shape.poly, shape.number
        area = poly.buffer(tolerance)
        pull_comp = (config.get("stitch.pull_compensation_mm") if shape.pull_compensation_mm is None
                     else shape.pull_compensation_mm)
        if shape.kind == "fill":
            pieces.append(Piece("fill", area, poly, rows=_rows(poly, config), shape=shape_number))
            continue
        if shape.kind == "running":
            # A running stitch along every outline of the shape (outside, then each hole).
            length = config.get("stitch.running_stitch_length_mm")
            for ring in (poly.exterior, *poly.interiors):
                path = satin.running_path(list(ring.coords), length)
                pieces.append(Piece("running", area, LineString(path + path[:1]).buffer(tolerance),
                                    shape=shape_number, path=path))
            continue
        if shape.kind == "column":
            left_px, right_px, closed = shape.edges
            column = satin.column_between([tf.geom(Point(p)).coords[0] for p in left_px],
                                          [tf.geom(Point(p)).coords[0] for p in right_px], closed,
                                          config.get("stitch.satin_spacing_mm"), pull_comp)
            cover = satin.coverage(column)
            pieces.append(Piece("satin", area.union(cover.buffer(tolerance)), cover, column=column, shape=shape_number))
            continue
        shape_mask = satin.polygon_mask(shape.poly_px, image_shape)
        dist = satin.distance_map(shape_mask)

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
                pull_comp, min_len, radius_mm,
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
                pieces.append(Piece("satin", area, cover, column=column, shape=shape_number))
                covered = unary_union([covered, cover])

        # Whatever the columns leave uncovered (junctions, skipped stations) becomes fill,
        # unless it is too thin to hold a stitch of the minimum length.
        rest = poly.difference(covered) if not covered.is_empty else poly
        for gap in satin_gaps(rest, min_len):
            rows = _rows(gap, config)
            if rows:
                pieces.append(Piece("fill", gap.buffer(tolerance), gap, rows=rows, patch=not covered.is_empty,
                                    shape=shape_number))
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
    satin_pieces: dict[int, int] = field(default_factory=dict)  # column number -> source (piece) index


def plan_pieces(pieces: list[Piece], logo: Polygon, settings: satin.SatinSettings, jump_threshold_mm: float,
                tolerance_mm: float, start_pos=None, first_number: int = 1, source_offset: int = 0) -> Plan:
    """Greedy: from the needle position take the piece whose entry point is nearest, preferring
    entries reachable by a short stitch that stays inside the logo and does not run over
    stitching that is already sewn (it would show on top); otherwise jump.

    For a new colour layer, start_pos is where the previous colour ended: the first piece is
    the nearest one and is always reached by a jump (the thread has just been changed).
    Satin columns are numbered from first_number; Move.source is source_offset + piece index."""
    remaining = list(range(len(pieces)))
    moves: list[Move] = []
    labels: dict[int, tuple[float, float]] = {}
    columns_of: dict[int, int] = {}  # column number -> source (piece) index
    pos = start_pos
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
            elif piece.kind == "running":  # a closed loop: start at its point nearest the needle
                k = (min(range(len(piece.path)), key=lambda j: (piece.path[j][1], piece.path[j][0])) if pos is None
                     else min(range(len(piece.path)), key=lambda j: _dist(pos, piece.path[j])))
                loop = piece.path[k:] + piece.path[:k]
                options.append((i, loop[0], [(p, "running") for p in loop + loop[:1]]))
            else:
                for start, forward in satin.entry_options(piece.column, pos):
                    seq = satin.column_sequence(piece.column, start, forward, settings)
                    options.append((i, seq[0][0], seq))
        if pos is None:
            choice = min(options, key=lambda o: (o[1][1], o[1][0]))
            sewn = False
        elif not moves:  # first piece of a new colour: nearest, jumped to
            choice = min(options, key=lambda o: _dist(pos, o[1]))
            sewn = False
        else:
            reachable = [o for o in options if travel_ok(pos, o[1])]
            choice = min(reachable or options, key=lambda o: _dist(pos, o[1]))
            sewn = bool(reachable)
        i, entry, seq = choice
        remaining.remove(i)
        piece = pieces[i]
        if piece.kind == "running":
            src = source_offset + i
            piece_moves = [Move("stitch", p, role, 0, src) for p, role in seq]
            piece_moves[0] = Move("stitch" if sewn else "jump", entry, "travel" if sewn else "", 0, src)
        elif piece.kind == "fill":
            role = "patch" if piece.patch else "fill"
            src = source_offset + i
            piece_moves = [Move(m.kind, m.to, role, 0, src) for m in order_rows(piece.rows, piece.area, jump_threshold_mm, pos)]
            piece_moves[0] = Move("stitch" if sewn else "jump", piece_moves[0].to, "travel" if sewn else "", 0, src)
        else:
            src = source_offset + i
            number = first_number + len(labels)
            labels[number] = satin.label_point(piece.column).coords[0]
            columns_of[number] = src
            piece_moves = [Move("stitch", p, role, number, src) for p, role in seq]
            piece_moves[0] = Move("stitch" if sewn else "jump", entry, "travel" if sewn else "", number, src)
        moves.extend(piece_moves)
        pos = moves[-1].to
        sewn_area = unary_union([sewn_area, piece.cover.buffer(-tolerance_mm)])
    return Plan(moves, labels, columns_of)


# ---------- 7. split long stitches and build the pattern ----------

@dataclass
class Built:
    pattern: pyembroidery.EmbPattern
    stitches: list[tuple[int, int]]  # every STITCH record, in file units
    labels: list[tuple[str, int]]  # (role, column number) per STITCH record
    jumps: int  # needle-up moves after the first positioning move
    trims: int
    sources: list[int] = field(default_factory=list)  # piece index per STITCH record
    colour_changes: int = 0


def build_pattern(moves: list[Move], max_stitch_mm: float, trim_threshold_mm: float,
                  thread_colours: list[str] | None = None) -> Built:
    """A "change" move becomes TRIM + COLOR_CHANGE; the jump after it gets no second trim.
    thread_colours ("#RRGGBB", one per colour layer) are stored as the pattern's threads; DST
    itself has no colours, only the colour-change stops."""
    # The file stores whole 0.1 mm units; rounding both ends can lengthen a stitch by up to
    # one unit diagonal, so split against the limit minus that amount.
    split_at = max_stitch_mm - math.sqrt(2) / UNITS_PER_MM
    built = Built(pyembroidery.EmbPattern(), [], [], 0, 0)
    for hex_colour in thread_colours or []:
        thread = pyembroidery.EmbThread()
        thread.set_hex_color(hex_colour)
        built.pattern.add_thread(thread)
    pos, last = None, None
    just_changed = False
    for move in moves:
        if move.kind == "change":
            built.pattern.add_command(pyembroidery.TRIM)
            built.trims += 1
            built.pattern.add_command(pyembroidery.COLOR_CHANGE)
            built.colour_changes += 1
            just_changed = True
            continue
        if move.kind == "jump":
            if pos is not None:
                built.jumps += 1
                if _dist(pos, move.to) > trim_threshold_mm and not just_changed:
                    built.pattern.add_command(pyembroidery.TRIM)
                    built.trims += 1
            last = _units(move.to)
            built.pattern.add_stitch_absolute(pyembroidery.JUMP, *last)
            pos = move.to
            just_changed = False
            continue
        just_changed = False
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
class ColourSummary:
    hex: str  # the image's own colour, "#RRGGBB"
    shapes: int
    stitches: int
    area_mm2: float


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
    # Layers are the pieces in sewing order: (type, stitch count, colour layer number),
    # type is fill/satin/junction patch.
    layers: tuple[tuple[str, int, int], ...] = ()
    stitch_layers: tuple[int, ...] = ()  # 1-based layer number for every STITCH record in the file
    colours: tuple[ColourSummary, ...] = ()  # colour layers in sewing order
    shapes_found: int = 0  # shapes traced before speck removal
    specks_removed: int = 0  # shapes dropped as specks
    holes_filled: int = 0  # holes smaller than the minimum shape area, filled
    # Colour overlap: where a colour runs under a later, touching colour (polygons as rings, mm).
    overlaps: tuple = ()
    columns: tuple = ()  # satin columns for the editor, numbered in sewing order (column_json)
    shapes: dict | None = None  # the shapes as sewn, for the editor (shapes_json)
    skipped_edits: tuple[str, ...] = ()  # editor changes that no longer fit the design

    def summary(self) -> str:
        colours = ", ".join(f"{c.hex} ({c.shapes} shapes, {c.stitches} stitches)" for c in self.colours)
        return (f"{self.stats.summary()}\n  colours in sewing order: {colours}\n"
                f"  shapes: {self.shapes_found} traced, {self.specks_removed} specks removed, "
                f"{self.shapes_found - self.specks_removed} kept; {self.holes_filled} small holes filled\n"
                f"  pieces: {self.fill_areas} fill, {self.satin_columns} satin columns, "
                f"{self.junction_patches} junction patches; jumps={self.jumps} trims={self.trims}; "
                f"skipped_rungs={self.skipped_rungs} trimmed_rungs={self.trimmed_rungs}")

    def to_json(self) -> dict:
        return {
            "jumps": self.jumps, "trims": self.trims, "fill_areas": self.fill_areas,
            "satin_columns": self.satin_columns, "junction_patches": self.junction_patches,
            "skipped_rungs": self.skipped_rungs, "trimmed_rungs": self.trimmed_rungs,
            "colour_changes": max(len(self.colours) - 1, 0),
            "shapes_found": self.shapes_found, "specks_removed": self.specks_removed,
            "holes_filled": self.holes_filled,
        }


def digitize(image_path: str | Path, out_dir: str | Path, config: Config | None = None,
             width_mm: float | None = None, keep_colours: list[str] | None = None,
             edits: list[dict] | None = None, on_progress: Callable[[float], None] | None = None) -> Result:
    """Write out.dst, preview.png and report.json into out_dir. width_mm overrides design.width_mm
    for this job; keep_colours ("#RRGGBB") leaves the other detected colours out; edits are the
    editor's changes (stored form, see digitizer.edits). on_progress gets 0..1 as shapes are done."""
    config = config or load_config()
    report = on_progress or (lambda _f: None)
    report(0.0)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    traced = trace_design(image_path, config, width_mm, keep_colours, edits=edits)
    report(0.1)
    tf = traced.tf
    settings = satin_settings(config)
    pieces: list[Piece] = []
    piece_colour: list[int] = []  # colour layer number per piece
    moves: list[Move] = []
    labels: dict[int, tuple[float, float]] = {}
    column_pieces: dict[int, int] = {}  # satin column number (sewing order) -> piece index
    skipped = trimmed = patches = done = 0
    total = max(len(traced.shapes), 1)
    for layer in traced.layers:
        built_pieces = build_pieces(layer.shapes, traced.image_shape, tf, config,
                                    on_shape_done=lambda d, _t, base=done: report(0.1 + 0.8 * (base + d) / total))
        done += len(layer.shapes)
        skipped += built_pieces.skipped_rungs
        trimmed += built_pieces.trimmed_rungs
        patches += built_pieces.patches
        # Travel stitches must stay inside this colour's own shapes (anything else would show).
        logo = unary_union([s.poly for s in layer.shapes]).buffer(tf.mm_per_px)
        start = moves[-1].to if moves else None
        if moves:
            moves.append(Move("change", start))
        plan = plan_pieces(built_pieces.pieces, logo, settings, config.get("stitch.jump_threshold_mm"), tf.mm_per_px,
                           start_pos=start, first_number=len(labels) + 1, source_offset=len(pieces))
        moves.extend(plan.moves)
        labels.update(plan.satin_labels)
        column_pieces.update(plan.satin_pieces)
        pieces.extend(built_pieces.pieces)
        piece_colour.extend([layer.number] * len(built_pieces.pieces))

    built = build_pattern(moves, config.get("stitch.max_stitch_length_mm"), config.get("stitch.trim_threshold_mm"),
                          [layer.hex for layer in traced.layers])
    dst_path = out_dir / "out.dst"
    pyembroidery.write_dst(built.pattern, str(dst_path))
    if stitch_points(dst_path) != built.stitches:
        raise RuntimeError("DST read back from disk does not match the stitches that were written")
    hex_of = {layer.number: layer.hex for layer in traced.layers}
    render_preview(dst_path, out_dir / "preview.png", config, built.labels,
                   {n: _units(p) for n, p in sorted(labels.items())},
                   [hex_of[piece_colour[s]] for s in built.sources])
    layer_of: dict[int, int] = {}
    for source in built.sources:  # number pieces in the order they are sewn
        layer_of.setdefault(source, len(layer_of) + 1)
    counts = {n: 0 for n in layer_of.values()}
    for source in built.sources:
        counts[layer_of[source]] += 1
    kinds = {n: (_layer_type(pieces[s]), piece_colour[s]) for s, n in layer_of.items()}
    colour_stitches = {layer.number: 0 for layer in traced.layers}
    for source in built.sources:
        colour_stitches[piece_colour[source]] += 1
    columns = tuple(column_json(n, pieces[i].column, pieces[i].shape, piece_colour[i], config)
                    for n, i in sorted(column_pieces.items()))
    result = Result(dst_stats(dst_path), built.jumps, built.trims,
                    sum(p.kind == "fill" and not p.patch for p in pieces), sum(p.kind == "satin" for p in pieces),
                    patches, skipped, trimmed,
                    tuple((kinds[n][0], counts[n], kinds[n][1]) for n in sorted(counts)),
                    tuple(layer_of[s] for s in built.sources),
                    tuple(ColourSummary(layer.hex, len(layer.shapes), colour_stitches[layer.number],
                                        sum(s.poly.area for s in layer.shapes)) for layer in traced.layers),
                    traced.shapes_found, traced.specks_removed, traced.holes_filled,
                    tuple(ring for s in traced.shapes for ring in polygons_json(s.overlap)),
                    columns, shapes_json(traced, config), tuple(traced.skipped_edits))
    # The DST format has no room for these; keep them next to it for the readback report.
    (out_dir / "report.json").write_text(json.dumps(result.to_json(), indent=2) + "\n")
    report(1.0)
    return result


def column_json(number: int, column: satin.Column, shape: int, colour: int, config: Config) -> dict:
    """One satin column for the editor: both edges, a few edit points along its centerline and
    where its number goes, in mm. Numbers follow the sewing order."""
    edit = column.centerline.simplify(config.get("editor.edit_point_tolerance_mm"))
    return {
        "number": number,
        "left": [list(r.edge_left) for r in column.rungs],
        "right": [list(r.edge_right) for r in column.rungs],
        "edit_points": [list(p) for p in edit.coords],
        "label": list(satin.label_point(column).coords[0]),
        "shape": shape,
        "colour": colour,
    }


def trace_columns(image_path: str | Path, config: Config, width_mm: float | None = None,
                  on_progress: Callable[[float], None] | None = None,
                  keep_colours: list[str] | None = None, edits: list[dict] | None = None) -> dict:
    """Satin columns for the editor ("Create satin columns"): the same run as digitize(), so the
    columns, their numbers (sewing order) and the stitch file always agree."""
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        result = digitize(image_path, tmp, config, width_mm, keep_colours, edits, on_progress)
    bounds = result.shapes["bounds_mm"]
    return {
        "columns": list(result.columns),
        "fill_shapes": result.fill_areas,
        "junction_patches": result.junction_patches,
        "bounds_mm": bounds,
        "width_mm": bounds[2] - bounds[0],
    }


def polygons_json(geometry) -> list[list[list[list[float]]]]:
    """Polygon or MultiPolygon -> [polygon: [ring: [[x, y], ...], ...], ...] (outline first, then holes)."""
    return [[[list(p) for p in ring.coords] for ring in (poly.exterior, *poly.interiors)]
            for poly in _polygons(geometry)]


def thread_placeholder() -> dict:
    """Thread names and codes are not chosen yet: a labelled placeholder, never an invented code."""
    return {"name": "[Thread name]", "code": "[Thread code]", "placeholder": True}


def colour_layers_json(traced: Traced) -> list[dict]:
    return [{
        "number": layer.number,
        "hex": layer.hex,
        "shape_count": len(layer.shapes),
        "area_mm2": sum(s.poly.area for s in layer.shapes),
        "thread": thread_placeholder(),
    } for layer in traced.layers]


def _shape_notes(shape: Shape, limit: float) -> list[str]:
    if shape.max_width_mm <= limit:
        return []
    if shape.kind == "satin":
        return [f"Wider than {limit:g} mm (the satin limit) in places: those parts are sewn as fill."]
    if shape.kind == "column":
        return [f"This column is wider than {limit:g} mm (the satin limit) in places."]
    return []


def shapes_json(traced: Traced, config: Config) -> dict:
    """The design's shapes for the editor canvas and Layers list, in mm (the same coordinates as
    the DST), grouped into colour layers in sewing order, with their stitch type and editor
    settings. Outlines are simplified by one source pixel, which is invisible on screen; the
    number of rings (outline, holes) is kept, so a ring index names the same outline."""
    tf = traced.tf
    limit = config.get("satin.max_width_mm")
    shapes = []
    for shape in traced.shapes:
        outline = shape.poly.simplify(tf.mm_per_px, preserve_topology=True)
        item = {
            "number": shape.number,
            "colour": shape.colour,
            "kind": shape.kind,
            "kind_chosen": shape.kind_chosen,
            "pull_compensation_mm": shape.pull_compensation_mm,
            "max_width_mm": shape.max_width_mm,
            "area_mm2": shape.poly.area,
            "bounds_mm": list(shape.poly.bounds),
            "rings": [[list(p) for p in ring.coords] for ring in (outline.exterior, *outline.interiors)],
            "overlap": polygons_json(shape.overlap),
            "notes": _shape_notes(shape, limit),
        }
        if shape.edges:
            left, right, closed = shape.edges
            item["edges"] = {"left": [list(tf.geom(Point(p)).coords[0]) for p in left],
                             "right": [list(tf.geom(Point(p)).coords[0]) for p in right], "closed": closed}
        shapes.append(item)
    min_x, min_y, max_x, max_y = traced.bounds_mm
    return {
        "colours": colour_layers_json(traced),
        "shapes": shapes,
        "bounds_mm": [min_x, min_y, max_x, max_y],
        "width_mm": max_x - min_x,
        "height_mm": max_y - min_y,
        "shapes_found": traced.shapes_found,
        "specks_removed": traced.specks_removed,
        "skipped_edits": list(traced.skipped_edits),
    }


def design_shapes(image_path: str | Path, config: Config, width_mm: float | None = None,
                  keep_colours: list[str] | None = None, edits: list[dict] | None = None) -> dict:
    """shapes_json() for an image, without sewing it (see shapes_json)."""
    return shapes_json(trace_design(image_path, config, width_mm, keep_colours, edits=edits), config)


def _layer_type(piece: Piece) -> str:
    if piece.kind in ("satin", "running"):
        return piece.kind
    return "junction patch" if piece.patch else "fill"


def main() -> None:
    parser = argparse.ArgumentParser(description="Digitize a logo into out.dst + preview.png + report.json")
    parser.add_argument("image", help="PNG or JPG logo on a plain or transparent background")
    parser.add_argument("--out", default=".", help="output folder (default: current folder)")
    parser.add_argument("--width-mm", type=float, help="design width for this job (default: design.width_mm)")
    parser.add_argument("--colours", help="comma-separated #RRGGBB colours to keep (default: all detected)")
    parser.add_argument("--edits", help="JSON file with editor changes (stored form, see digitizer.edits)")
    parser.add_argument(
        "--test-run-values",
        action="store_true",
        help="use TEST_RUN_OVERRIDES from config.py for unchosen values (not for sewing)",
    )
    args = parser.parse_args()
    config = load_test_run_config() if args.test_run_values else load_config()
    keep = [c.strip() for c in args.colours.split(",")] if args.colours else None
    edits = json.loads(Path(args.edits).read_text()) if args.edits else None
    print(digitize(args.image, args.out, config, args.width_mm, keep, edits).summary())


if __name__ == "__main__":
    main()
