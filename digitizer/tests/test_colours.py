"""Multi-colour digitizing: colour quantization, background removal, speck removal, colour layers
and their sewing order, and colour changes in the DST (read back with pyembroidery).

Uses TEST_RUN_OVERRIDES (colour.max_colours, colour.same_colour_delta_e, input.min_shape_area_mm2
and quality.max_specks are still placeholders in the product config).
"""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
import pyembroidery
import pytest

from digitizer import quality
from digitizer.colours import quantize, read_image
from digitizer.config import PlaceholderValueError, load_config, load_test_run_config
from digitizer.digitize import design_shapes, digitize, trace_columns, trace_design

SAMPLES = Path(__file__).resolve().parents[1] / "samples"
CONFIG = load_test_run_config()


def lab(hex_colour: str) -> np.ndarray:
    r, g, b = (int(hex_colour[i:i + 2], 16) for i in (1, 3, 5))
    return cv2.cvtColor(np.array([[[b, g, r]]], np.float32) / 255, cv2.COLOR_BGR2Lab)[0, 0]


def delta_e(a: str, b: str) -> float:
    return float(np.linalg.norm(lab(a) - lab(b)))


def matches(found: list[str], drawn: list[str]) -> bool:
    """Every drawn colour was found (within a just-visible step) and nothing else."""
    return len(found) == len(drawn) and all(min(delta_e(f, d) for f in found) < 2 for d in drawn)


def dst_commands(path) -> list[int]:
    return [c & pyembroidery.COMMAND_MASK for _, _, c in pyembroidery.read_dst(str(path)).stitches]


# ---------- quantization and background ----------

@pytest.mark.parametrize("name,drawn", [
    ("two_colour", ["#D62828", "#1D4ED8"]),
    ("three_colour", ["#2E9E4F", "#F28C28", "#1F2A5A"]),
    ("bird", ["#1E3A6E", "#2A9D8F", "#F4A261", "#F6C90E", "#111111", "#7A4A2A", "#5BAA46"]),
])
def test_finds_the_drawn_colours_and_removes_the_white_background(name, drawn):
    q = quantize(read_image(SAMPLES / f"{name}.png"), CONFIG)
    assert q.background == "#FFFFFF"
    assert matches([c.hex for c in q.colours], drawn)


def test_touching_colours_do_not_leave_a_sliver_shape_on_their_border():
    # The orange disc overlaps the green square: the anti-aliased blend along their border must
    # join one of them, not become extra shapes.
    traced = trace_design(SAMPLES / "three_colour.png", CONFIG, 60, classify=False)
    assert [len(layer.shapes) for layer in traced.layers] == [1, 1, 1]
    assert traced.specks_removed == 0


def test_transparent_background_is_removed(tmp_path):
    img = np.zeros((300, 400, 4), np.uint8)
    cv2.circle(img, (130, 150), 90, (40, 40, 200, 255), -1, lineType=cv2.LINE_AA)
    cv2.rectangle(img, (260, 60), (340, 240), (200, 120, 30, 255), -1)
    cv2.imwrite(str(tmp_path / "t.png"), img)
    q = quantize(read_image(tmp_path / "t.png"), CONFIG)
    assert q.background is None
    assert matches([c.hex for c in q.colours], ["#C82828", "#1E78C8"])


def test_gradient_is_reduced_to_at_most_max_colours_flat_bands(tmp_path):
    traced = trace_design(SAMPLES / "gradient.png", CONFIG, 60, classify=False)
    assert 2 <= len(traced.layers) <= CONFIG.get("colour.max_colours")
    assert traced.background == "#FFFFFF"
    result = digitize(SAMPLES / "gradient.png", tmp_path, CONFIG, 60)
    assert result.stats.color_count == len(traced.layers)


def test_same_image_same_colours():
    a = trace_design(SAMPLES / "bird.png", CONFIG, 90, classify=False)
    b = trace_design(SAMPLES / "bird.png", CONFIG, 90, classify=False)
    assert [l.hex for l in a.layers] == [l.hex for l in b.layers]


def test_colour_settings_are_placeholders_in_the_product_config():
    for key in ("colour.max_colours", "colour.same_colour_delta_e", "input.min_shape_area_mm2", "quality.max_specks"):
        assert key in load_config().placeholders()
    with pytest.raises(PlaceholderValueError):
        quantize(read_image(SAMPLES / "two_colour.png"), load_config())


# ---------- specks ----------

def test_specks_are_removed_and_counted():
    traced = trace_design(SAMPLES / "noisy_specks.png", CONFIG, 60, classify=False)
    assert len(traced.shapes) == 1  # the star
    assert traced.shapes_found > traced.specks_removed > CONFIG.get("quality.max_specks")
    minimum = CONFIG.get("input.min_shape_area_mm2")
    assert all(s.poly.area >= minimum for s in traced.shapes)
    for layer in trace_design(SAMPLES / "bird.png", CONFIG, 90, classify=False).layers:
        assert all(s.poly.area >= minimum for s in layer.shapes)


def test_many_specks_give_a_quality_warning():
    warning = quality.speck_warning(CONFIG.get("quality.max_specks") + 1, CONFIG)
    assert warning is not None and warning.code == "many_specks"
    assert warning.message == "This image has many small specks. Use a cleaner logo for better stitches."
    assert quality.speck_warning(CONFIG.get("quality.max_specks"), CONFIG) is None


def test_only_specks_is_a_plain_error(tmp_path):
    img = np.full((400, 400, 3), 255, np.uint8)
    for x in range(40, 400, 60):
        cv2.circle(img, (x, 200), 2, (0, 0, 0), -1)
    cv2.imwrite(str(tmp_path / "dots.png"), img)
    with pytest.raises(ValueError, match="only specks"):
        trace_design(tmp_path / "dots.png", CONFIG, 60)


# ---------- layers, sewing order, the DST ----------

@pytest.mark.parametrize("name,width,colours", [("two_colour", 60, 2), ("three_colour", 60, 3), ("bird", 90, 7)])
def test_one_colour_change_between_layers(name, width, colours, tmp_path):
    result = digitize(SAMPLES / f"{name}.png", tmp_path, CONFIG, width)
    commands = dst_commands(tmp_path / "out.dst")
    assert commands.count(pyembroidery.COLOR_CHANGE) == colours - 1 == result.stats.color_changes
    assert len(result.colours) == colours
    # Each colour change comes after a trim and is followed by a jump (never a sewn travel).
    for i, c in enumerate(commands):
        if c == pyembroidery.COLOR_CHANGE:
            assert pyembroidery.TRIM in commands[i - 3:i]
            assert next(x for x in commands[i + 1:] if x in (pyembroidery.STITCH, pyembroidery.JUMP)) == pyembroidery.JUMP
    # Every stitch is in one colour block: stitches per block match the colour layers.
    blocks, count = [], 0
    for c in commands:
        if c == pyembroidery.STITCH:
            count += 1
        elif c == pyembroidery.COLOR_CHANGE:
            blocks.append(count)
            count = 0
    blocks.append(count)
    assert blocks == [c.stitches for c in result.colours]
    assert result.stats.longest_stitch_mm <= CONFIG.get("stitch.max_stitch_length_mm")


def test_sewing_order_is_largest_area_first():
    traced = trace_design(SAMPLES / "bird.png", CONFIG, 90, classify=False)
    areas = [sum(s.poly.area for s in layer.shapes) for layer in traced.layers]
    assert areas == sorted(areas, reverse=True)
    assert [s.number for s in traced.shapes] == list(range(1, len(traced.shapes) + 1))


def test_each_shape_is_classified_fill_or_satin():
    traced = trace_design(SAMPLES / "bird.png", CONFIG, 90)
    kinds = {s.kind for s in traced.shapes}
    assert kinds == {"fill", "satin"}  # wide body; the thin branch is satin
    limit = CONFIG.get("satin.max_width_mm")
    assert all((s.kind == "satin") == (s.max_width_mm <= limit) for s in traced.shapes)


def test_left_out_colours_are_not_sewn(tmp_path):
    full = trace_design(SAMPLES / "bird.png", CONFIG, 90, classify=False)
    keep = [layer.hex for layer in full.layers if layer.hex not in ("#5BAA46", "#7A4A2A")]  # no leaves, no branch
    result = digitize(SAMPLES / "bird.png", tmp_path, CONFIG, 90, keep_colours=keep)
    assert [c.hex for c in result.colours] == keep
    assert result.stats.color_count == len(keep)
    with pytest.raises(ValueError, match="none of the chosen colours"):
        trace_design(SAMPLES / "bird.png", CONFIG, 90, keep_colours=["#ABCDEF"])


def test_every_caller_gets_the_same_shapes_and_layers(tmp_path):
    result = digitize(SAMPLES / "bird.png", tmp_path, CONFIG, 90)
    shapes = design_shapes(SAMPLES / "bird.png", CONFIG, 90)
    assert [(c["hex"], c["shape_count"]) for c in shapes["colours"]] == [(c.hex, c.shapes) for c in result.colours]
    assert all(c["thread"]["placeholder"] for c in shapes["colours"])
    traced = trace_columns(SAMPLES / "bird.png", CONFIG, 90)
    assert len(traced["columns"]) == result.satin_columns
    assert traced["bounds_mm"] == shapes["bounds_mm"]
    satin_shapes = {s["number"]: s["colour"] for s in shapes["shapes"] if s["kind"] == "satin"}
    assert all(satin_shapes[c["shape"]] == c["colour"] for c in traced["columns"])
