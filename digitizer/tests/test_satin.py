"""Satin columns: classification, centerlines, rungs, pull compensation, underlay, ordering."""

from __future__ import annotations

import math
from pathlib import Path

import pytest
from shapely.geometry import LineString, Polygon

from digitizer import satin
from digitizer.config import load_test_run_config
from digitizer.digitize import (
    build_pieces,
    digitize,
    load_mask,
    mask_to_polygons,
    satin_settings,
    scale_to_width,
)

SAMPLES = Path(__file__).resolve().parents[1] / "samples"
CONFIG = load_test_run_config()


def pieces_for(name: str, width_mm: float, config=CONFIG):
    mask = load_mask(SAMPLES / f"{name}.png", config.get("image.min_speck_area_px"))
    polygons_px = mask_to_polygons(mask)
    polygons, tf = scale_to_width(polygons_px, width_mm)
    return build_pieces(mask, polygons_px, polygons, tf, config).pieces


def kinds(pieces):
    return sorted(p.kind for p in pieces)


def satin_kinds(pieces):
    return sorted(p.kind for p in pieces if not p.patch)


def test_thin_ring_is_one_closed_satin_column():
    pieces = pieces_for("thin_ring", 40)
    assert kinds(pieces) == ["satin"]
    column = pieces[0].column
    assert column.closed and column.skipped_rungs == 0
    widths = [r.width_mm for r in column.rungs]
    # Ring drawn 36 px thick on a 516 px wide ring scaled to 40 mm -> about 2.8 mm.
    assert 2.4 < sum(widths) / len(widths) < 3.2


def test_mixed_logo_splits_wide_and_narrow_shapes():
    # disc and lollipop (wide head joined to a thin stick) stay fill; swoosh and chevron are satin
    assert satin_kinds(pieces_for("mixed", 50)) == ["fill", "fill", "satin", "satin"]


def test_bold_letter_is_satin_when_small_and_fill_when_large():
    assert set(satin_kinds(pieces_for("bold_r", 18))) == {"satin"}
    # Junctions are wider than strokes; at 30 mm the widest point exceeds satin.max_width_mm.
    assert kinds(pieces_for("bold_r", 30)) == ["fill"]


def test_satin_rungs_fit_the_width_limit():
    max_width = CONFIG.get("satin.max_width_mm")
    for name, width in (("thin_ring", 40), ("mixed", 50), ("bold_r", 18)):
        for piece in pieces_for(name, width):
            if piece.kind == "satin":
                assert all(r.width_mm <= max_width + 1e-9 for r in piece.column.rungs)


def _bar_column(pull_comp: float) -> satin.Column:
    bar = Polygon([(0, 0), (10, 0), (10, 3), (0, 3)])
    return satin.build_column(LineString([(0, 1.5), (10, 1.5)]), bar, 0.5, 6, pull_comp, 0.1, lambda p: 1.5)


def test_pull_compensation_widens_each_rung_by_the_configured_total():
    plain, widened = _bar_column(0.0), _bar_column(0.4)
    for a, b in zip(plain.rungs, widened.rungs):
        assert math.dist(a.left, a.right) == pytest.approx(3.0, abs=1e-6)
        assert math.dist(b.left, b.right) == pytest.approx(3.4, abs=1e-6)


def _settings(edge: bool, zigzag: bool) -> satin.SatinSettings:
    s = satin_settings(CONFIG)
    return satin.SatinSettings(s.spacing, s.underlay_spacing, edge, s.edge_inset, s.edge_stitch_length, zigzag, s.zigzag_inset)


@pytest.mark.parametrize("edge,zigzag", [(False, False), (True, False), (False, True), (True, True)])
def test_underlay_comes_first_and_follows_the_switches(edge, zigzag):
    column = _bar_column(0.0)
    seq = satin.column_sequence(column, 0, True, _settings(edge, zigzag))
    roles = [role for _, role in seq]
    first_satin = roles.index("satin")
    assert set(roles[:first_satin]) <= {"underlay"}
    assert all(r == "satin" for r in roles[first_satin:])
    assert (first_satin > 0) == (edge or zigzag)
    underlay = [p for p, role in seq if role == "underlay"]
    inset = CONFIG.get("satin.underlay_edge_inset_mm")
    assert all(inset - 1e-9 <= p[1] <= 3 - inset + 1e-9 for p in underlay)  # stays inside the edges


def test_ring_needs_no_jumps_and_labels_match_the_file(tmp_path):
    result = digitize(SAMPLES / "thin_ring.png", tmp_path, CONFIG, 40)  # raises if DST != written stitches
    assert result.satin_columns == 1 and result.jumps == 0
    assert (tmp_path / "preview.png").stat().st_size > 0
