"""Layer isolation: an editor change to one colour must not move a single stitch of any other
colour. Each colour layer is planned from its own shapes, not from where the previous colour
ended, so this holds for the layers sewn after the changed one too.

Uses TEST_RUN_OVERRIDES (the product config is still placeholders).
"""

from __future__ import annotations

from pathlib import Path

from shapely.geometry import LineString

from digitizer.config import load_test_run_config
from digitizer.digitize import digitize, trace_design
from digitizer.edits import to_pixels
from digitizer.readback import colour_layer_bytes, colour_layer_stitches

SAMPLES = Path(__file__).resolve().parents[1] / "samples"
CONFIG = load_test_run_config()
BIRD, WIDTH = SAMPLES / "bird.png", 90
BRANCH = 7  # the bird's brown branch: a satin shape, alone in its colour layer


def split_the_branch():
    traced = trace_design(BIRD, CONFIG, WIDTH)
    branch = traced.shapes[BRANCH - 1]
    assert branch.kind == "satin"
    cut = branch.poly.intersection(LineString([(-20, -100), (-20, 100)]))
    ys = [p[1] for g in getattr(cut, "geoms", [cut]) for p in g.coords]
    edit = to_pixels({"op": "split", "a": [-20, min(ys)], "b": [-20, max(ys)]}, traced)
    return edit, branch.colour, len(traced.layers)


def test_splitting_a_satin_shape_changes_only_its_own_colour_layer(tmp_path):
    edit, changed, colours = split_the_branch()
    assert colours >= 3 and 1 < changed < colours  # layers before and after it are both checked
    before = digitize(BIRD, tmp_path / "before", CONFIG, WIDTH)
    after = digitize(BIRD, tmp_path / "after", CONFIG, WIDTH, edits=[edit])
    assert len(after.shapes["shapes"]) == len(before.shapes["shapes"]) + 1  # the split was made

    bytes_before = colour_layer_bytes(tmp_path / "before" / "out.dst")
    bytes_after = colour_layer_bytes(tmp_path / "after" / "out.dst")
    stitches_before = colour_layer_stitches(tmp_path / "before" / "out.dst")
    stitches_after = colour_layer_stitches(tmp_path / "after" / "out.dst")
    assert len(bytes_before) == len(bytes_after) == len(stitches_before) == len(stitches_after) == colours

    for layer in range(1, colours + 1):
        if layer == changed:
            assert bytes_after[layer - 1] != bytes_before[layer - 1]
            assert stitches_after[layer - 1] != stitches_before[layer - 1]
        else:  # byte for byte, and every stitch at the same place
            assert bytes_after[layer - 1] == bytes_before[layer - 1], f"colour layer {layer} changed"
            assert stitches_after[layer - 1] == stitches_before[layer - 1], f"colour layer {layer} moved"


def test_taking_the_split_back_gives_the_original_file_exactly(tmp_path):
    edit, _changed, _colours = split_the_branch()
    digitize(BIRD, tmp_path / "before", CONFIG, WIDTH)
    digitize(BIRD, tmp_path / "split", CONFIG, WIDTH, edits=[edit])
    digitize(BIRD, tmp_path / "undone", CONFIG, WIDTH, edits=[])
    original = (tmp_path / "before" / "out.dst").read_bytes()
    assert (tmp_path / "split" / "out.dst").read_bytes() != original
    assert (tmp_path / "undone" / "out.dst").read_bytes() == original
