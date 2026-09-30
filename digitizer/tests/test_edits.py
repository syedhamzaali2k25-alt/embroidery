"""Editor changes applied by the engine: stitch type, pull compensation, split, and satin columns
from two outlines or two drawn edges. Each change must really change the stitches, and every
change a person can get wrong must fail with a plain message.

Uses TEST_RUN_OVERRIDES (running stitch length, snap distance and the pull compensation range
are placeholders in the product config).
"""

from __future__ import annotations

import math
from pathlib import Path

import pyembroidery
import pytest
from shapely.geometry import LineString, Point
from shapely.ops import unary_union

from digitizer.config import load_test_run_config
from digitizer.digitize import build_pieces, digitize, trace_design
from digitizer.edits import EditError, apply_edit, label, to_pixels
from digitizer.readback import UNITS_PER_MM, segments

SAMPLES = Path(__file__).resolve().parents[1] / "samples"
CONFIG = load_test_run_config()
BIRD, RING = SAMPLES / "bird.png", SAMPLES / "thin_ring.png"
BODY, BRANCH = 1, 7  # bird: the navy body (fill) and the brown branch (satin)


def stored(image, width, edit, earlier=()):
    """An edit as the editor sends it -> stored form, against the design with `earlier` applied."""
    return to_pixels(edit, trace_design(image, CONFIG, width, edits=list(earlier)))


def branch_cut(x_mm: float):
    """Two points on the branch's edges, straight across it at x."""
    branch = trace_design(BIRD, CONFIG, 90).shapes[BRANCH - 1].poly
    cut = branch.intersection(LineString([(x_mm, -100), (x_mm, 100)]))
    ys = [p[1] for g in getattr(cut, "geoms", [cut]) for p in g.coords]
    return [x_mm, min(ys)], [x_mm, max(ys)]


def stitch_segments(dst: Path):
    pattern = pyembroidery.read_dst(str(dst))
    return [((x0 / UNITS_PER_MM, y0 / UNITS_PER_MM), (x1 / UNITS_PER_MM, y1 / UNITS_PER_MM))
            for cmd, x0, y0, x1, y1 in segments(pattern) if cmd == pyembroidery.STITCH]


# ---------- stitch type ----------

@pytest.mark.parametrize("kind", ["running", "satin", "fill"])
def test_changing_the_type_changes_the_stitches(kind, tmp_path):
    before = digitize(BIRD, tmp_path / "a", CONFIG, 90)
    after = digitize(BIRD, tmp_path / "b", CONFIG, 90,
                     edits=[stored(BIRD, 90, {"op": "set_type", "shape": BODY, "kind": kind})])
    shape = next(s for s in after.shapes["shapes"] if s["number"] == BODY)
    assert shape["kind"] == kind and shape["kind_chosen"]
    body_layers = {t for t, _n, colour in after.layers if colour == 1}
    if kind == "fill":  # the body is fill already: the same file
        assert (tmp_path / "a" / "out.dst").read_bytes() == (tmp_path / "b" / "out.dst").read_bytes()
    else:
        assert after.stats.stitch_count != before.stats.stitch_count
        assert kind in body_layers
    if kind == "satin":  # wider than the satin limit: the wide parts are filled, and it says so
        assert shape["notes"] and "sewn as fill" in shape["notes"][0]


def test_running_stitch_follows_every_outline_within_the_stitch_length(tmp_path):
    edit = stored(RING, 40, {"op": "set_type", "shape": 1, "kind": "running"})
    result = digitize(RING, tmp_path, CONFIG, 40, edits=[edit])
    assert [t for t, _n, _c in result.layers] == ["running", "running"]  # outside and the hole
    ring = trace_design(RING, CONFIG, 40).shapes[0].poly
    length = CONFIG.get("stitch.running_stitch_length_mm")
    rounding = math.sqrt(2) / UNITS_PER_MM
    for a, b in stitch_segments(tmp_path / "out.dst"):
        assert math.dist(a, b) <= length + rounding
        assert ring.boundary.distance(Point(b)) <= 2 * rounding + ring.area ** 0.5 * 0.01


# ---------- pull compensation ----------

def test_pull_compensation_widens_this_shape_only():
    edit = stored(BIRD, 90, {"op": "set_pull_compensation", "shape": BRANCH, "mm": 0.8})
    traced = trace_design(BIRD, CONFIG, 90, edits=[edit])
    default = CONFIG.get("stitch.pull_compensation_mm")
    for shape in traced.shapes:
        if shape.kind != "satin":
            continue
        want = 0.8 if shape.number == BRANCH else default
        for piece in build_pieces([shape], traced.image_shape, traced.tf, CONFIG).pieces:
            if piece.column:
                for r in piece.column.rungs:
                    assert math.dist(r.left, r.right) == pytest.approx(r.width_mm + want, abs=1e-6)


def test_pull_compensation_needs_satin_and_resets():
    with pytest.raises(EditError, match="only applies to satin"):
        traced = trace_design(BIRD, CONFIG, 90)
        apply_edit(traced, to_pixels({"op": "set_pull_compensation", "shape": BODY, "mm": 0.4}, traced), CONFIG)
    on = stored(BIRD, 90, {"op": "set_pull_compensation", "shape": BRANCH, "mm": 0.8})
    off = stored(BIRD, 90, {"op": "set_pull_compensation", "shape": BRANCH, "mm": None}, [on])
    shape = trace_design(BIRD, CONFIG, 90, edits=[on, off]).shapes[BRANCH - 1]
    assert shape.pull_compensation_mm is None


# ---------- split ----------

def test_split_makes_two_satin_shapes_and_no_stitch_crosses_the_cut(tmp_path):
    a, b = branch_cut(-30)
    edit = stored(BIRD, 90, {"op": "split", "a": a, "b": b})
    before = digitize(BIRD, tmp_path / "a", CONFIG, 90)
    after = digitize(BIRD, tmp_path / "b", CONFIG, 90, edits=[edit])
    assert len(after.shapes["shapes"]) == len(before.shapes["shapes"]) + 1
    brown = [s for s in after.shapes["shapes"] if s["colour"] == 5]
    assert [s["kind"] for s in brown] == ["satin", "satin"]
    assert after.satin_columns > before.satin_columns
    # No satin rung joins the two halves: every rung stays on one side of the (vertical) cut;
    # a rung may end on the cut, which is now the edge of both halves.
    traced = trace_design(BIRD, CONFIG, 90, edits=[edit])
    x, eps = a[0], 1e-6
    for shape in traced.layers[4].shapes:
        for piece in build_pieces([shape], traced.image_shape, traced.tf, CONFIG).pieces:
            for r in (piece.column.rungs if piece.column else []):
                xs = (r.edge_left[0], r.edge_right[0])
                assert not (min(xs) < x - eps and max(xs) > x + eps), "a rung crosses the cut"


@pytest.mark.parametrize("a,b,phrase", [
    ([-30, 19], [0, -10], "same satin shape"),      # second point is not on the branch
    ([0, -20], [5, -20], "same satin shape"),       # inside the body, not on an edge
])
def test_split_explains_what_went_wrong(a, b, phrase):
    traced = trace_design(BIRD, CONFIG, 90)
    with pytest.raises(EditError, match=phrase):
        apply_edit(traced, to_pixels({"op": "split", "a": a, "b": b}, traced), CONFIG)


def test_split_needs_a_satin_shape():
    traced = trace_design(BIRD, CONFIG, 90)
    body = traced.shapes[BODY - 1].poly
    x0, y0, x1, y1 = body.bounds
    cut = body.intersection(LineString([(-20, y0 - 1), (-20, y1 + 1)]))
    ys = [p[1] for g in getattr(cut, "geoms", [cut]) for p in g.coords]
    with pytest.raises(EditError, match="Change this shape to Satin first"):
        apply_edit(traced, to_pixels({"op": "split", "a": [-20, min(ys)], "b": [-20, max(ys)]}, traced), CONFIG)


# ---------- satin columns from two edges ----------

def test_outline_and_hole_become_one_satin_column(tmp_path):
    edit = stored(RING, 40, {"op": "column", "left": {"shape": 1, "ring": 0}, "right": {"shape": 1, "ring": 1}})
    result = digitize(RING, tmp_path, CONFIG, 40, edits=[edit])
    assert [s["kind"] for s in result.shapes["shapes"]] == ["column"]  # it replaces the ring's own satin
    assert result.satin_columns == 1 and len(result.columns) == 1
    ring = trace_design(RING, CONFIG, 40).shapes[0].poly.buffer(CONFIG.get("stitch.pull_compensation_mm") / 2 + 0.2)
    assert all(ring.contains(Point(b)) for _a, b in stitch_segments(tmp_path / "out.dst"))


def test_drawn_edges_add_a_column_in_the_chosen_colour(tmp_path):
    before = digitize(BIRD, tmp_path / "a", CONFIG, 90)
    edit = stored(BIRD, 90, {"op": "column", "left": {"points": [[-40, -25], [-20, -25]]},
                             "right": {"points": [[-40, -22], [-20, -22]]}, "colour": 2})
    after = digitize(BIRD, tmp_path / "b", CONFIG, 90, edits=[edit])
    assert after.satin_columns == before.satin_columns + 1
    assert after.colours[1].shapes == before.colours[1].shapes + 1
    column = next(c for c in after.columns if c["colour"] == 2)
    widths = [math.dist(a, b) for a, b in zip(column["left"], column["right"])]
    assert all(w == pytest.approx(3.0, abs=0.01) for w in widths)  # 3 mm apart, before pull compensation


@pytest.mark.parametrize("edit,phrase", [
    ({"op": "column", "left": {"points": [[-40, -25], [-20, -22]]}, "right": {"points": [[-40, -22], [-20, -25]]},
      "colour": 1}, "cross each other"),
    ({"op": "column", "left": {"shape": 1, "ring": 0}, "right": {"points": [[-40, -22], [-20, -22]]}},
     "cannot join an outline to a drawn edge"),
    ({"op": "column", "left": {"shape": 2, "ring": 0}, "right": {"shape": 3, "ring": 0}}, "one inside the other"),
    ({"op": "column", "left": {"points": [[-40, -25]]}, "right": {"points": [[-40, -22], [-20, -22]]}, "colour": 1},
     "at least two points"),
])
def test_column_explains_what_went_wrong(edit, phrase):
    traced = trace_design(BIRD, CONFIG, 90)
    with pytest.raises(EditError, match=phrase):
        apply_edit(traced, to_pixels(edit, traced), CONFIG)


# ---------- stored edits ----------

def test_edits_keep_working_at_another_width():
    a, b = branch_cut(-30)
    edits = [stored(BIRD, 90, {"op": "split", "a": a, "b": b}),
             stored(BIRD, 90, {"op": "set_type", "shape": BODY, "kind": "running"})]
    for width in (60, 90, 120):
        traced = trace_design(BIRD, CONFIG, width, edits=edits)
        assert not traced.skipped_edits
        assert len(traced.shapes) == 10 and traced.shapes[BODY - 1].kind == "running"


def test_an_edit_whose_shape_was_left_out_is_skipped_and_reported():
    edit = stored(BIRD, 90, {"op": "set_type", "shape": BRANCH, "kind": "fill"})
    keep = [layer.hex for layer in trace_design(BIRD, CONFIG, 90).layers if layer.hex != "#7A4A2A"]
    traced = trace_design(BIRD, CONFIG, 90, keep_colours=keep, edits=[edit])
    assert len(traced.skipped_edits) == 1 and "Change 1 (Change a shape to Fill) was skipped" in traced.skipped_edits[0]


def test_every_change_has_a_short_name():
    assert label({"op": "set_type", "kind": "satin"}) == "Change a shape to Satin"
    assert label({"op": "set_pull_compensation", "mm": 0.4}) == "Set pull compensation to 0.4 mm"
    assert label({"op": "split"}) == "Split a satin shape"
    assert label({"op": "column", "left": {"points": []}}) == "Satin column from drawn edges"
    assert label({"op": "column", "left": {"at": [0, 0], "ring": 0}}) == "Satin column from two outlines"
