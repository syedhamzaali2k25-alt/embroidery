"""Editor changes to a traced design: stitch type, pull compensation, splits, and satin columns
between two edges. No web code: the API stores the edits and trace_design() applies them.

Edits are stored in image pixels, so they survive a change of design width. A shape is named
by a point inside it (its "anchor"), not by its number, because numbers shift when shapes are
split or added. Operations (stored form):

  {"op": "set_type", "at": [x, y], "kind": "running" | "satin" | "fill"}
  {"op": "set_pull_compensation", "at": [x, y], "mm": 0.3}      # mm None = back to the default
  {"op": "split", "a": [x, y], "b": [x, y]}                      # two points on the shape's edge
  {"op": "column", "left": EDGE, "right": EDGE, "colour": "#RRGGBB"}
      EDGE = {"at": [x, y], "ring": i}  one outline of a shape (0 = outside, 1.. = holes), or
             {"points": [[x, y], ...]}  an edge drawn with the pen

The editor sends the same operations with shape numbers and millimetres; to_pixels() turns
those into the stored form. Every rule a person can break raises EditError with a plain message.
"""

from __future__ import annotations

import math

from shapely.affinity import scale
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import nearest_points, split

from digitizer.config import Config
from digitizer.digitize import Shape, Traced, classify_shape, shape_max_width_mm

KINDS = ("running", "satin", "fill")
KIND_NAMES = {"running": "Running", "satin": "Satin", "fill": "Fill", "column": "Satin"}
# A point this close (image pixels) to a shape still counts as on it: traced outlines run
# through pixel centres. A unit of the tracing, not a setting.
ON_SHAPE_PX = 2.0


class EditError(Exception):
    """A change that cannot be made, with a message that says what to do instead."""


def label(edit: dict) -> str:
    """Short name of a change, for Undo and Redo."""
    op = edit.get("op")
    if op == "set_type":
        return f"Change a shape to {KIND_NAMES.get(edit.get('kind'), edit.get('kind'))}"
    if op == "set_pull_compensation":
        mm = edit.get("mm")
        return "Reset pull compensation" if mm is None else f"Set pull compensation to {mm:g} mm"
    if op == "split":
        return "Split a satin shape"
    if op == "column":
        return ("Satin column from drawn edges" if "points" in edit.get("left", {})
                else "Satin column from two outlines")
    return "Change"


# ---------- finding shapes ----------

def _layer_and_index(traced: Traced, shape: Shape) -> tuple[int, int]:
    for li, layer in enumerate(traced.layers):
        for si, s in enumerate(layer.shapes):
            if s is shape:
                return li, si
    raise EditError("That shape is no longer in the design.")


def _find(traced: Traced, at) -> Shape:
    point = Point(at)
    inside = [s for s in traced.shapes if s.poly_px.contains(point)]
    if inside:
        return inside[-1]  # the one sewn last is on top
    near = min(traced.shapes, key=lambda s: s.poly_px.distance(point), default=None)
    if near is None or near.poly_px.distance(point) > ON_SHAPE_PX:
        raise EditError("That shape is no longer in the design (its colour may have been left out on the upload "
                        "screen). Undo this change or pick the shape again.")
    return near


def _by_number(traced: Traced, number) -> Shape:
    for s in traced.shapes:
        if s.number == number:
            return s
    raise EditError(f"There is no shape {number} in this design. Reload the editor and pick the shape again.")


def _anchor(shape: Shape) -> list[float]:
    p = shape.poly_px.representative_point()
    return [p.x, p.y]


def _rings(poly: Polygon) -> list[list[tuple[float, float]]]:
    return [list(ring.coords)[:-1] for ring in (poly.exterior, *poly.interiors)]


def _new_shape(traced: Traced, colour: int, poly_px: Polygon, kind: str, config: Config, **extra) -> Shape:
    tf = traced.tf
    shape = Shape(0, colour, poly_px, tf.geom(poly_px), kind=kind, kind_chosen=True, **extra)
    _kind, _mask, dist = classify_shape(poly_px, traced.image_shape, tf, config.get("satin.max_width_mm"))
    shape.max_width_mm = shape_max_width_mm(dist, tf)
    return shape


def _renumber(traced: Traced) -> None:
    for number, shape in enumerate(traced.shapes, start=1):
        shape.number = number


# ---------- the operations ----------

def _set_type(traced: Traced, edit: dict, config: Config) -> None:
    kind = edit.get("kind")
    if kind not in KINDS:
        raise EditError("Choose Running, Satin or Fill.")
    shape = _find(traced, edit["at"])
    shape.kind = "column" if kind == "satin" and shape.edges else kind
    shape.kind_chosen = True


def _set_pull_compensation(traced: Traced, edit: dict, config: Config) -> None:
    shape = _find(traced, edit["at"])
    if shape.kind not in ("satin", "column"):
        raise EditError("Pull compensation only applies to satin. Change this shape to Satin first.")
    mm = edit.get("mm")
    if mm is not None and mm < 0:
        raise EditError("Pull compensation cannot be negative.")
    shape.pull_compensation_mm = mm


def _split(traced: Traced, edit: dict, config: Config) -> None:
    tf = traced.tf
    snap = config.get("editor.snap_distance_mm") / tf.mm_per_px
    a, b = Point(edit["a"]), Point(edit["b"])
    shape = min(traced.shapes, key=lambda s: s.poly_px.boundary.distance(a) + s.poly_px.boundary.distance(b))
    edge = shape.poly_px.boundary
    if edge.distance(a) > snap or edge.distance(b) > snap:
        raise EditError("Click two points on the edge of the same satin shape, one on each side.")
    if shape.kind != "satin":
        raise EditError("Split works on satin shapes. Change this shape to Satin first."
                        if shape.kind != "column" else
                        "This column was made from two edges; undo it and pick shorter edges instead of splitting it.")
    pa, pb = nearest_points(edge, a)[0], nearest_points(edge, b)[0]
    cut = LineString([pa, pb])
    if cut.length * tf.mm_per_px < config.get("stitch.min_stitch_length_mm"):
        raise EditError("The two points are too close together. Click one point on each side of the shape.")
    if not shape.poly_px.buffer(ON_SHAPE_PX).contains(cut):
        raise EditError("The cut would leave the shape. Click two points facing each other across the shape.")
    reach = (cut.length + 2 * ON_SHAPE_PX) / cut.length
    parts = [g for g in split(shape.poly_px, scale(cut, reach, reach)).geoms if isinstance(g, Polygon)]
    if len(parts) < 2:
        raise EditError("This cut does not divide the shape in two. Click points on opposite edges "
                        "(a ring needs two cuts).")
    min_area = config.get("input.min_shape_area_mm2") / tf.mm_per_px ** 2
    if min(p.area for p in parts) < min_area:
        raise EditError("One side of the cut would be too small to sew. Cut further from the end of the shape.")
    li, si = _layer_and_index(traced, shape)
    pieces = [_new_shape(traced, shape.colour, p, "satin", config, pull_compensation_mm=shape.pull_compensation_mm,
                         overlap=shape.overlap.intersection(tf.geom(p))) for p in parts]
    traced.layers[li].shapes[si:si + 1] = pieces


def _edge(traced: Traced, ref: dict) -> tuple[list, bool, Shape | None]:
    """(points in px, closed?, the shape it came from or None)."""
    if "points" in ref:
        points = [tuple(p) for p in ref["points"]]
        if len(points) < 2:
            raise EditError("Each edge needs at least two points.")
        return points, False, None
    shape = _find(traced, ref["at"])
    rings = _rings(shape.poly_px)
    ring = ref.get("ring", 0)
    if not 0 <= ring < len(rings):
        raise EditError("That outline is no longer part of the shape. Pick the two edges again.")
    return rings[ring], True, shape


def _column(traced: Traced, edit: dict, config: Config) -> None:
    left, left_closed, left_shape = _edge(traced, edit["left"])
    right, right_closed, right_shape = _edge(traced, edit["right"])
    if left_closed != right_closed:
        raise EditError("Pick two outlines, or draw two edges: a column cannot join an outline to a drawn edge.")
    if left_closed:
        a, b = Polygon(left), Polygon(right)
        if left == right:
            raise EditError("Pick two different outlines.")
        if a.contains(b):
            poly_px = Polygon(left, [right])
        elif b.contains(a):
            poly_px = Polygon(right, [left])
        else:
            raise EditError("Pick an outline and a hole inside it (or two outlines, one inside the other), "
                            "so the column runs between them.")
        colour = left_shape.colour
        replaces = left_shape if left_shape is right_shape else None
    else:
        straight = math.dist(left[0], right[0]) + math.dist(left[-1], right[-1])
        crossed = math.dist(left[0], right[-1]) + math.dist(left[-1], right[0])
        ordered = right[::-1] if crossed < straight else right
        poly_px = Polygon(left + ordered[::-1])
        if not poly_px.is_valid:
            raise EditError("The two edges cross each other. Draw them side by side, running the same way.")
        colours = {layer.hex: layer.number for layer in traced.layers}
        colour = colours.get(edit.get("colour"))
        if colour is None:
            raise EditError("That thread colour is not in the design any more. Pick a shape of the colour you "
                            "want, then draw the edges again.")
        replaces = None
    min_area = config.get("input.min_shape_area_mm2") / traced.tf.mm_per_px ** 2
    if poly_px.area < min_area:
        raise EditError("The edges are too close together to sew a column between them.")
    column = _new_shape(traced, colour, poly_px, "column", config, edges=(left, right, left_closed))
    if replaces is not None:
        li, si = _layer_and_index(traced, replaces)
        column.overlap = replaces.overlap
        traced.layers[li].shapes[si] = column
    else:
        traced.layers[colour - 1].shapes.append(column)


_OPS = {"set_type": _set_type, "set_pull_compensation": _set_pull_compensation, "split": _split, "column": _column}


def apply_edit(traced: Traced, edit: dict, config: Config) -> None:
    """Apply one stored edit (pixels) to `traced` in place; EditError if it cannot be made."""
    op = _OPS.get(edit.get("op"))
    if op is None:
        raise EditError(f"Unknown change {edit.get('op')!r}.")
    op(traced, edit, config)
    _renumber(traced)


def apply_edits(traced: Traced, edits: list[dict], config: Config) -> list[str]:
    """Apply stored edits in order. Ones that no longer fit are skipped; returns why, in words."""
    skipped = []
    for n, edit in enumerate(edits, start=1):
        try:
            apply_edit(traced, edit, config)
        except EditError as exc:
            skipped.append(f"Change {n} ({label(edit)}) was skipped: {exc}")
    return skipped


# ---------- editor form (shape numbers, mm) -> stored form (anchors, px) ----------

def to_pixels(edit: dict, traced: Traced) -> dict:
    """Turn an edit as the editor sends it (shape numbers, millimetres, colour layer numbers)
    into the stored form, using the design as it is now (all earlier edits applied)."""
    tf = traced.tf
    op = edit.get("op")

    def px(p) -> list[float]:
        return list(tf.to_px(p))

    if op in ("set_type", "set_pull_compensation"):
        out = {k: v for k, v in edit.items() if k != "shape"}
        out["at"] = _anchor(_by_number(traced, edit["shape"]))
        return out
    if op == "split":
        return {"op": "split", "a": px(edit["a"]), "b": px(edit["b"])}
    if op == "column":
        def edge(ref: dict) -> dict:
            if "points" in ref:
                return {"points": [px(p) for p in ref["points"]]}
            return {"at": _anchor(_by_number(traced, ref["shape"])), "ring": ref.get("ring", 0)}

        out = {"op": "column", "left": edge(edit["left"]), "right": edge(edit["right"])}
        if "points" in edit["left"]:
            colour = edit.get("colour") or 1
            if not 1 <= colour <= len(traced.layers):
                raise EditError(f"There is no colour {colour} in this design.")
            out["colour"] = traced.layers[colour - 1].hex
        return out
    raise EditError(f"Unknown change {op!r}.")
