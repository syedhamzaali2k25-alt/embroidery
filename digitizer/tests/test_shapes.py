"""design_shapes(): the editor's canvas shapes and Layers list come from the same tracing as the DST."""

from __future__ import annotations

from pathlib import Path

from shapely.geometry import Polygon

from digitizer.config import load_test_run_config
from digitizer.digitize import design_shapes, digitize, trace_columns

SAMPLES = Path(__file__).resolve().parents[1] / "samples"
CONFIG = load_test_run_config()


def test_kinds_match_the_stitch_file(tmp_path):
    # mixed.png: two wide shapes (fill) and two narrow strokes (satin).
    shapes = design_shapes(SAMPLES / "mixed.png", CONFIG, 50)
    kinds = sorted(s["kind"] for s in shapes["shapes"])
    assert kinds == ["fill", "fill", "satin", "satin"]
    result = digitize(SAMPLES / "mixed.png", tmp_path, CONFIG, 50)
    assert result.fill_areas == kinds.count("fill")


def test_outlines_keep_holes_and_size(tmp_path):
    shapes = design_shapes(SAMPLES / "letter_a.png", CONFIG, 60)
    (a,) = shapes["shapes"]
    assert len(a["rings"]) == 2  # outline + the hole of the A
    outline = Polygon(a["rings"][0], a["rings"][1:])
    assert abs(outline.area - a["area_mm2"]) / a["area_mm2"] < 0.02
    assert abs(shapes["width_mm"] - 60) < 1e-6
    assert all(s["number"] == i + 1 for i, s in enumerate(shapes["shapes"]))


def test_traced_columns_name_their_shape():
    shapes = design_shapes(SAMPLES / "mixed.png", CONFIG, 50)
    satin_shapes = {s["number"] for s in shapes["shapes"] if s["kind"] == "satin"}
    traced = trace_columns(SAMPLES / "mixed.png", CONFIG, 50)
    assert traced["columns"] and {c["shape"] for c in traced["columns"]} <= satin_shapes
    assert traced["bounds_mm"] == shapes["bounds_mm"]
