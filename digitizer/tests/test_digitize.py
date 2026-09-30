"""End-to-end checks on the three sample logos, reading the written DST back with pyembroidery.

Uses TEST_RUN_OVERRIDES: these tests check the code, not the (still unchosen) product values.
"""

from __future__ import annotations

from pathlib import Path

import pyembroidery
import pytest
from shapely.geometry import LineString
from shapely.ops import unary_union

from digitizer.config import PlaceholderValueError, load_config, load_test_run_config
from digitizer.digitize import digitize, trace_design
from digitizer.readback import UNITS_PER_MM, segments

SAMPLES = Path(__file__).resolve().parents[1] / "samples"
CONFIG = load_test_run_config()
WIDTHS_MM = {"circle": 60, "letter_a": 60, "two_shape": 60, "bold_r": 18, "thin_ring": 40, "mixed": 50, "junctions": 50}
ALL = list(WIDTHS_MM)


def run(name: str, tmp_path: Path, width_mm: float | None = None):
    width_mm = width_mm or WIDTHS_MM[name]
    stats = digitize(SAMPLES / f"{name}.png", tmp_path, CONFIG, width_mm).stats
    traced = trace_design(SAMPLES / f"{name}.png", CONFIG, width_mm, classify=False)
    polygons, mm_per_px = [s.poly for s in traced.shapes], traced.tf.mm_per_px
    pattern = pyembroidery.read_dst(str(tmp_path / "out.dst"))
    stitches = [
        LineString([(x0 / UNITS_PER_MM, y0 / UNITS_PER_MM), (x1 / UNITS_PER_MM, y1 / UNITS_PER_MM)])
        for cmd, x0, y0, x1, y1 in segments(pattern)
        if cmd == pyembroidery.STITCH
    ]
    return stats, polygons, mm_per_px, stitches


@pytest.mark.parametrize("name", ALL)
def test_writes_files_within_limits(name, tmp_path):
    stats, _, _, _ = run(name, tmp_path)
    assert (tmp_path / "out.dst").stat().st_size > 0
    assert (tmp_path / "preview.png").stat().st_size > 0
    assert stats.stitch_count > 0
    assert stats.longest_stitch_mm <= CONFIG.get("stitch.max_stitch_length_mm")
    # Rows stop half a row from the outline, so allow two row spacings of shortfall.
    # Satin columns are widened by pull compensation on both sides.
    slack = 2 * CONFIG.get("stitch.fill_row_spacing_mm") + CONFIG.get("stitch.pull_compensation_mm")
    assert abs(stats.width_mm - WIDTHS_MM[name]) <= slack


@pytest.mark.parametrize("name", ALL)
def test_no_stitch_leaves_the_shape(name, tmp_path):
    _, polygons, mm_per_px, stitches = run(name, tmp_path)
    allowed = unary_union(polygons).buffer(
        2 * mm_per_px + 1 / UNITS_PER_MM + CONFIG.get("stitch.pull_compensation_mm") / 2
    )
    outside = [s for s in stitches if not allowed.contains(s)]
    assert not outside, f"{len(outside)} stitches cross outside the logo"


def test_hole_in_a_stays_empty(tmp_path):
    _, polygons, mm_per_px, stitches = run("letter_a", tmp_path)
    assert [len(p.interiors) for p in polygons] == [1]
    from shapely.geometry import Polygon

    hole = Polygon(polygons[0].interiors[0]).buffer(-(2 * mm_per_px + 1 / UNITS_PER_MM))
    assert hole.area > 0
    assert not [s for s in stitches if s.intersects(hole)]


def test_two_shapes_are_joined_by_jumps(tmp_path):
    stats, polygons, _, _ = run("two_shape", tmp_path)
    assert len(polygons) == 2
    assert stats.jump_count >= 2  # start + crossing the gap


def test_specks_and_pinholes_are_cleaned():
    traced = trace_design(SAMPLES / "circle.png", CONFIG, 60, classify=False)
    assert [len(s.poly.interiors) for s in traced.shapes] == [0]
    assert traced.specks_removed == 3 and traced.holes_filled == 1


def test_product_config_refuses_placeholders(tmp_path):
    assert "stitch.max_stitch_length_mm" in load_config().placeholders()
    with pytest.raises(PlaceholderValueError):
        digitize(SAMPLES / "circle.png", tmp_path, load_config())


def test_overrides_reject_unknown_keys():
    with pytest.raises(KeyError):
        load_config().with_overrides({"stitch.not_a_setting": 1})
