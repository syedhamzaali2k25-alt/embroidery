"""Satin junctions: columns must not run over each other; junctions get a fill patch;
no travel stitch is sewn on top of stitching that is already done."""

from __future__ import annotations

import itertools
import json
from pathlib import Path

import pytest
from shapely.geometry import LineString, Point
from shapely.ops import unary_union

from digitizer.config import load_test_run_config
from digitizer.digitize import (
    build_pieces,
    digitize,
    load_mask,
    mask_to_polygons,
    plan_pieces,
    satin_settings,
    scale_to_width,
    travel_allowed,
)
from shapely.geometry import Polygon

SAMPLES = Path(__file__).resolve().parents[1] / "samples"
CONFIG = load_test_run_config()
# Where the strokes of samples/junctions.png cross, in source pixels (T, X, Y).
JUNCTIONS_PX = [(150, 100), (450, 170), (300, 470)]


def build(name: str, width_mm: float):
    mask = load_mask(SAMPLES / f"{name}.png", CONFIG.get("image.min_speck_area_px"))
    polygons_px = mask_to_polygons(mask)
    polygons, tf = scale_to_width(polygons_px, width_mm)
    return build_pieces(mask, polygons_px, polygons, tf, CONFIG), polygons, tf


CASES = [("junctions", 50), ("bold_r", 18)]


@pytest.mark.parametrize("name,width", CASES)
def test_satin_columns_do_not_overlap(name, width):
    built, _, tf = build(name, width)
    covers = [p.cover for p in built.pieces if p.kind == "satin"]
    # Neighbouring columns may share an edge; allow a sliver one source pixel wide.
    for a, b in itertools.combinations(covers, 2):
        assert a.intersection(b).area <= tf.mm_per_px * min(a.length, b.length) / 2


@pytest.mark.parametrize("name,width", CASES)
def test_satin_and_patches_cover_the_logo(name, width):
    built, polygons, _ = build(name, width)
    logo = unary_union(polygons)
    covered = unary_union([p.cover for p in built.pieces])
    assert logo.difference(covered).area / logo.area < 0.03


def test_every_junction_gets_its_own_patch():
    built, _, tf = build("junctions", 50)
    patches = [p.cover for p in built.pieces if p.patch]
    assert len(patches) == len(JUNCTIONS_PX)
    for x, y in JUNCTIONS_PX:
        centre = Point((x - tf.cx) * tf.mm_per_px, (y - tf.cy) * tf.mm_per_px)
        assert sum(patch.distance(centre) <= tf.mm_per_px for patch in patches) == 1


@pytest.mark.parametrize("name,width", CASES)
def test_no_travel_stitch_runs_over_sewn_stitching(name, width):
    built, polygons, tf = build(name, width)
    logo = unary_union(polygons).buffer(tf.mm_per_px)
    plan = plan_pieces(built.pieces, logo, satin_settings(CONFIG), CONFIG.get("stitch.jump_threshold_mm"), tf.mm_per_px)
    sewn, done, prev = [], set(), None
    for move in plan.moves:
        if move.source not in done:
            sewn = [built.pieces[i].cover.buffer(-tf.mm_per_px) for i in done]
            done.add(move.source)
            if move.role == "travel":
                assert not LineString([prev, move.to]).intersects(unary_union(sewn)), "travel over sewn stitching"
        prev = move.to


def test_travel_over_sewn_stitching_becomes_a_jump():
    logo = Polygon([(0, 0), (10, 0), (10, 4), (0, 4)])
    sewn = Polygon([(3, 0), (5, 0), (5, 4), (3, 4)]).buffer(-0.05)
    assert travel_allowed((0.5, 2), (2.5, 2), logo, 5, sewn)  # beside the sewn area
    assert travel_allowed((3, 1), (3, 3), logo, 5, sewn)  # along its edge
    assert not travel_allowed((2, 2), (6, 2), logo, 5, sewn)  # straight over it
    assert not travel_allowed((0.5, 2), (9.5, 2), logo, 5, Polygon())  # longer than the threshold


def test_report_json_carries_rung_counts(tmp_path):
    result = digitize(SAMPLES / "junctions.png", tmp_path, CONFIG, 50)
    report = json.loads((tmp_path / "report.json").read_text())
    assert report["skipped_rungs"] == result.skipped_rungs
    assert report["trimmed_rungs"] == result.trimmed_rungs > 0
    assert report["junction_patches"] == result.junction_patches == len(JUNCTIONS_PX)
