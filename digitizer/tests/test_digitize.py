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
from digitizer.digitize import digitize, load_mask, mask_to_polygons, scale_to_width
from digitizer.readback import UNITS_PER_MM, segments

SAMPLES = Path(__file__).resolve().parents[1] / "samples"
CONFIG = load_test_run_config()


def run(name: str, tmp_path: Path):
    stats = digitize(SAMPLES / f"{name}.png", tmp_path, CONFIG)
    mask = load_mask(SAMPLES / f"{name}.png", CONFIG.get("image.min_speck_area_px"))
    polygons, mm_per_px = scale_to_width(mask_to_polygons(mask), CONFIG.get("design.width_mm"))
    pattern = pyembroidery.read_dst(str(tmp_path / "out.dst"))
    stitches = [
        LineString([(x0 / UNITS_PER_MM, y0 / UNITS_PER_MM), (x1 / UNITS_PER_MM, y1 / UNITS_PER_MM)])
        for cmd, x0, y0, x1, y1 in segments(pattern)
        if cmd == pyembroidery.STITCH
    ]
    return stats, polygons, mm_per_px, stitches


@pytest.mark.parametrize("name", ["circle", "letter_a", "two_shape"])
def test_writes_files_within_limits(name, tmp_path):
    stats, _, _, _ = run(name, tmp_path)
    assert (tmp_path / "out.dst").stat().st_size > 0
    assert (tmp_path / "preview.png").stat().st_size > 0
    assert stats.stitch_count > 0
    assert stats.longest_stitch_mm <= CONFIG.get("stitch.max_stitch_length_mm")
    # Rows stop half a row from the outline, so allow two row spacings of shortfall.
    assert abs(stats.width_mm - CONFIG.get("design.width_mm")) <= 2 * CONFIG.get("stitch.fill_row_spacing_mm")


@pytest.mark.parametrize("name", ["circle", "letter_a", "two_shape"])
def test_no_stitch_leaves_the_shape(name, tmp_path):
    _, polygons, mm_per_px, stitches = run(name, tmp_path)
    allowed = unary_union(polygons).buffer(2 * mm_per_px + 1 / UNITS_PER_MM)
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
    mask = load_mask(SAMPLES / "circle.png", CONFIG.get("image.min_speck_area_px"))
    polygons = mask_to_polygons(mask)
    assert len(polygons) == 1 and len(polygons[0].interiors) == 0


def test_product_config_refuses_placeholders(tmp_path):
    assert "stitch.max_stitch_length_mm" in load_config().placeholders()
    with pytest.raises(PlaceholderValueError):
        digitize(SAMPLES / "circle.png", tmp_path, load_config())


def test_overrides_reject_unknown_keys():
    with pytest.raises(KeyError):
        load_config().with_overrides({"stitch.not_a_setting": 1})
