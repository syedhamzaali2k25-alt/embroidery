"""Colour overlap: where two colours touch, no fabric may show between them.

The check sews nothing: it reads the DST back with pyembroidery, turns every stitch into a band
one fill row spacing wide with flat ends (so a fill reads as solid, but nothing counts as
stitched beyond a needle point), and samples every point on the border between two colours in
the source image. With
colour.overlap_mm set, every such point must be stitched; with 0 overlap the same check finds
gaps, which shows the check can see them.
"""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
import pyembroidery
import pytest
import shapely
from shapely.geometry import LineString
from shapely.ops import unary_union

from digitizer.colours import quantize, read_image
from digitizer.config import load_test_run_config
from digitizer.digitize import NEIGHBOUR_PX, digitize, trace_design
from digitizer.readback import UNITS_PER_MM

SAMPLES = Path(__file__).resolve().parents[1] / "samples"
CONFIG = load_test_run_config()
# DST stores needle points on a 0.1 mm grid; rounding moves a point by up to half a unit
# diagonally, which can open hairline cracks between rows of one colour.
ROUNDING_MM = (2 ** 0.5) * 0.5 / UNITS_PER_MM
CASES = [("two_colour", 60), ("three_colour", 60), ("bird", 90)]


def stitched_area(dst: Path, line_mm: float):
    """Every stitch as a band line_mm wide with flat ends (the band stops at the needle points,
    so a row that ends short of an edge leaves that edge bare). Each colour block is closed by
    ROUNDING_MM on its own, which seals the hairline cracks DST rounding opens between rows of
    one colour but never closes a gap between two colours."""
    pattern = pyembroidery.read_dst(str(dst))
    blocks, bands, prev = [], [], None
    for x, y, c in pattern.stitches:
        c &= pyembroidery.COMMAND_MASK
        if c == pyembroidery.COLOR_CHANGE:
            blocks.append(bands)
            bands = []
            continue
        if c not in (pyembroidery.STITCH, pyembroidery.JUMP):
            continue
        here = (x / UNITS_PER_MM, y / UNITS_PER_MM)
        if c == pyembroidery.STITCH and prev is not None and prev != here:
            bands.append(LineString([prev, here]).buffer(line_mm / 2, cap_style="flat"))
        prev = here
    blocks.append(bands)
    return unary_union([unary_union(b).buffer(ROUNDING_MM).buffer(-ROUNDING_MM) for b in blocks if b])


def shared_edge_points_mm(name: str, width: float, config) -> tuple[np.ndarray, int]:
    """Midpoints between 4-neighbour pixels of two different thread colours, in design mm, and
    how many were left out because they lie within one fill row spacing of the background: there
    the shared edge ends at the design's outer edge, which the overlap may not grow past, so
    coverage is the same as at any outer corner of a fill (rows cannot reach an exact corner)."""
    q = quantize(read_image(SAMPLES / f"{name}.png"), config)
    tf = trace_design(SAMPLES / f"{name}.png", config, width, classify=False).tf
    lab = q.labels
    points = []
    for dy, dx in ((0, 1), (1, 0)):
        a, b = lab[: lab.shape[0] - dy, : lab.shape[1] - dx], lab[dy:, dx:]
        ys, xs = np.nonzero((a >= 0) & (b >= 0) & (a != b))
        points.append(np.stack([xs + dx / 2, ys + dy / 2], axis=1))
    px = np.concatenate(points)
    to_background = cv2.distanceTransform((lab >= 0).astype(np.uint8), cv2.DIST_L2, 5)
    near = to_background[px[:, 1].astype(int), px[:, 0].astype(int)] * tf.mm_per_px <= config.get("stitch.fill_row_spacing_mm")
    px = px[~near]
    return np.stack([(px[:, 0] - tf.cx) * tf.mm_per_px, (px[:, 1] - tf.cy) * tf.mm_per_px], axis=1), int(near.sum())


def uncovered(name: str, width: float, config, tmp_path: Path) -> tuple[int, int, int]:
    """(bare points on shared edges, points checked, points left out at the outer edge)."""
    digitize(SAMPLES / f"{name}.png", tmp_path, config, width)
    area = stitched_area(tmp_path / "out.dst", config.get("stitch.fill_row_spacing_mm"))
    edge, left_out = shared_edge_points_mm(name, width, config)
    return int((~shapely.contains_xy(area, edge[:, 0], edge[:, 1])).sum()), len(edge), left_out


@pytest.mark.parametrize("name,width", CASES)
def test_no_fabric_shows_between_touching_colours(name, width, tmp_path):
    gaps, total, left_out = uncovered(name, width, CONFIG, tmp_path)
    assert total > 0 and left_out < total / 20, "the sample must have colours that touch"
    assert gaps == 0, f"{gaps} of {total} points on shared edges are not stitched"


@pytest.mark.parametrize("name,width", CASES)
def test_the_check_finds_gaps_without_overlap(name, width, tmp_path):
    gaps, _total, _left_out = uncovered(name, width, CONFIG.with_overrides({"colour.overlap_mm": 0}), tmp_path)
    assert gaps > 0


@pytest.mark.parametrize("name,width", CASES)
def test_growth_stays_inside_the_design_and_only_under_later_neighbours(name, width):
    plain = trace_design(SAMPLES / f"{name}.png", CONFIG.with_overrides({"colour.overlap_mm": 0}), width)
    grown = trace_design(SAMPLES / f"{name}.png", CONFIG, width)
    seam = NEIGHBOUR_PX * grown.tf.mm_per_px
    design = unary_union([s.poly for s in plain.shapes])
    overlap = CONFIG.get("colour.overlap_mm")
    for before, after in zip(plain.shapes, grown.shapes):
        added = after.overlap
        # never past the design's outer edge (only the seams between colours are outside every shape)
        assert added.difference(design.buffer(seam)).area < 1e-9
        # only into shapes of later colours that touch it, and at most colour.overlap_mm deep
        later = [s.poly for s in plain.shapes if s.colour > before.colour and s.poly.distance(before.poly) <= seam]
        if not later:
            assert added.is_empty and after.poly.equals(before.poly)
            continue
        assert added.difference(unary_union(later).buffer(seam)).area < 1e-9
        assert added.difference(before.poly.buffer(overlap + 1e-6)).area < 1e-9
    last = [s for s in grown.shapes if s.colour == len(grown.layers)]
    assert all(s.overlap.is_empty for s in last)  # the last colour is sewn on top of everything


def test_colours_that_do_not_touch_do_not_overlap():
    # three_colour: the navy bar touches nothing; the green square and orange disc touch.
    traced = trace_design(SAMPLES / "three_colour.png", CONFIG, 60)
    by_hex = {layer.hex: layer.shapes for layer in traced.layers}
    assert by_hex["#1F2A5A"][0].overlap.is_empty
    assert not by_hex["#2E9E4F"][0].overlap.is_empty  # green is sewn first: it grows under orange
