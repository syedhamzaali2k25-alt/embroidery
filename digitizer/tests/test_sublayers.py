"""Sublayers and per-shape density.

A sublayer is a part of a shape, taken out of it, with its own stitch type and settings. An edit
to a sublayer must change that sublayer's stitches and nothing else, and only that sublayer is
rebuilt (the piece cache). Uses TEST_RUN_OVERRIDES (the product config is still placeholders).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from digitizer.config import load_test_run_config
from digitizer.digitize import PIECE_CACHE, digitize, trace_design
from digitizer.edits import EditError, apply_edit, label, to_pixels
from digitizer.readback import stitch_points

SAMPLES = Path(__file__).resolve().parents[1] / "samples"
CONFIG = load_test_run_config()
BIRD, WIDTH = SAMPLES / "bird.png", 90
BODY = 1  # the navy body: a big fill shape


def box_in_body(half: float = 6.0):
    """A square outline around the middle of the body, in mm."""
    body = trace_design(BIRD, CONFIG, WIDTH).shapes[BODY - 1].poly
    c = body.representative_point()
    return [[c.x - half, c.y - half], [c.x + half, c.y - half], [c.x + half, c.y + half], [c.x - half, c.y + half]]


def stored(edit, earlier=()):
    return to_pixels(edit, trace_design(BIRD, CONFIG, WIDTH, edits=list(earlier)))


def add_sublayer():
    return stored({"op": "sublayer", "shape": BODY, "points": box_in_body()})


def stitches_by_shape(result, dst: Path) -> dict[int, list]:
    """Every STITCH record of the file, grouped by the shape it sews."""
    out: dict[int, list] = {}
    for point, layer in zip(stitch_points(dst), result.stitch_layers):
        out.setdefault(result.layer_shapes[layer - 1], []).append(point)
    return out


def test_a_sublayer_is_a_child_shape_of_the_same_colour(tmp_path):
    before = trace_design(BIRD, CONFIG, WIDTH).shapes[BODY - 1]
    result = digitize(BIRD, tmp_path, CONFIG, WIDTH, edits=[add_sublayer()])
    shapes = result.shapes["shapes"]
    parent, child = shapes[BODY - 1], shapes[BODY]
    assert child["parent"] == BODY and parent["sublayers"] == [child["number"]] and parent["parent"] is None
    assert child["colour"] == parent["colour"] and child["kind"] == parent["kind"] == "fill"
    assert not child["kind_chosen"]
    assert parent["area_mm2"] + child["area_mm2"] == pytest.approx(before.poly.area, rel=1e-6)
    assert BODY in result.layer_shapes and child["number"] in result.layer_shapes  # both are sewn


@pytest.mark.parametrize("change", [
    {"op": "set_density", "mm": 0.7},
    {"op": "set_type", "kind": "satin"},
    {"op": "set_type", "kind": "running"},
])
def test_a_sublayer_edit_changes_only_that_sublayers_stitches(change, tmp_path):
    sub = add_sublayer()
    before = digitize(BIRD, tmp_path / "before", CONFIG, WIDTH, edits=[sub])
    child = before.shapes["shapes"][BODY]["number"]
    edit = stored({**change, "shape": child}, [sub])
    builds = PIECE_CACHE.builds
    after = digitize(BIRD, tmp_path / "after", CONFIG, WIDTH, edits=[sub, edit])
    assert PIECE_CACHE.builds - builds == 1, "only the sublayer is rebuilt"

    a = stitches_by_shape(before, tmp_path / "before" / "out.dst")
    b = stitches_by_shape(after, tmp_path / "after" / "out.dst")
    assert a.keys() == b.keys()
    for shape in a:
        if shape == child:
            assert b[shape] != a[shape], "the sublayer's stitches change"
        else:
            assert b[shape] == a[shape], f"shape {shape} must not move"

    # Taking the change back gives the file before it, byte for byte.
    digitize(BIRD, tmp_path / "undone", CONFIG, WIDTH, edits=[sub])
    assert (tmp_path / "undone" / "out.dst").read_bytes() == (tmp_path / "before" / "out.dst").read_bytes()


def test_density_changes_the_shape_and_resets(tmp_path):
    plain = digitize(BIRD, tmp_path / "plain", CONFIG, WIDTH)
    denser = digitize(BIRD, tmp_path / "denser", CONFIG, WIDTH,
                      edits=[stored({"op": "set_density", "shape": BODY, "mm": 0.3})])
    assert denser.stats.stitch_count > plain.stats.stitch_count
    assert denser.shapes["shapes"][BODY - 1]["fill_spacing_mm"] == 0.3
    digitize(BIRD, tmp_path / "reset", CONFIG, WIDTH, edits=[stored({"op": "set_density", "shape": BODY, "mm": 0.3}),
                                                            stored({"op": "set_density", "shape": BODY, "mm": None})])
    assert (tmp_path / "reset" / "out.dst").read_bytes() == (tmp_path / "plain" / "out.dst").read_bytes()


def test_satin_density_is_per_shape(tmp_path):
    branch = 7
    plain = digitize(BIRD, tmp_path / "plain", CONFIG, WIDTH)
    sparse = digitize(BIRD, tmp_path / "sparse", CONFIG, WIDTH,
                      edits=[stored({"op": "set_density", "shape": branch, "mm": 0.7})])
    assert sparse.shapes["shapes"][branch - 1]["satin_spacing_mm"] == 0.7
    assert sparse.stats.stitch_count < plain.stats.stitch_count


@pytest.mark.parametrize("points,phrase", [
    ([[-200, -200], [-190, -200], [-190, -190]], "over a part of shape"),        # outside the shape
    ([[-100, -100], [100, -100], [100, 100], [-100, 100]], "cover all of shape"),  # the whole shape
    ([[0, 0], [5, 5], [5, 0], [0, 5]], "crosses itself"),
    ([[0, 0], [5, 5]], "at least three points"),
])
def test_sublayer_mistakes_are_explained(points, phrase):
    traced = trace_design(BIRD, CONFIG, WIDTH)
    with pytest.raises(EditError, match=phrase):
        apply_edit(traced, to_pixels({"op": "sublayer", "shape": BODY, "points": points}, traced), CONFIG)


def test_a_sublayer_cannot_have_sublayers_and_running_has_no_density():
    sub = add_sublayer()
    traced = trace_design(BIRD, CONFIG, WIDTH, edits=[sub])
    child = traced.shapes[BODY]
    with pytest.raises(EditError, match="already a sublayer of shape 1"):
        apply_edit(traced, to_pixels({"op": "sublayer", "shape": child.number, "points": box_in_body(2)}, traced),
                   CONFIG)
    running = stored({"op": "set_type", "shape": BODY, "kind": "running"})
    traced = trace_design(BIRD, CONFIG, WIDTH, edits=[running])
    with pytest.raises(EditError, match="does not apply to running"):
        apply_edit(traced, to_pixels({"op": "set_density", "shape": BODY, "mm": 0.5}, traced), CONFIG)


def test_new_changes_have_names():
    assert label({"op": "sublayer"}) == "Add a sublayer"
    assert label({"op": "set_density", "mm": 0.45}) == "Set density to 0.45 mm"
    assert label({"op": "set_density", "mm": None}) == "Reset density"
