"""Fabric presets: chosen in the editor as a change, they re-sew the design with their density,
underlay and pull compensation; what is set by hand still wins; nothing is marked as tested.

The preset numbers used here are TEST_RUN_OVERRIDES, made up for the tests. In the product config
every preset value is a placeholder.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from digitizer import fabric
from digitizer.config import PLACEHOLDER, PRODUCT, TEST_RUN_OVERRIDES, Config, load_test_run_config
from digitizer.digitize import digitize, trace_design
from digitizer.edits import EditError, apply_edit, label, to_pixels

SAMPLES = Path(__file__).resolve().parents[1] / "samples"
CONFIG = load_test_run_config()
BIRD, WIDTH = SAMPLES / "bird.png", 90


def choose(name):
    return to_pixels({"op": "fabric", "preset": name}, trace_design(BIRD, CONFIG, WIDTH))


def test_product_config_has_no_tested_preset_values():
    section = PRODUCT["fabric"]
    assert section["presets"], "at least one preset is listed"
    for name in section["presets"]:
        assert section[f"{name}.verified"] is False  # only the owner may set this, after sewing
        for field in fabric.FIELDS:
            assert section[f"{name}.{field}"] == PLACEHOLDER, f"{name}.{field} must stay a placeholder"


def test_presets_without_values_are_listed_but_cannot_be_chosen(tmp_path):
    no_preset_values = {k: v for k, v in TEST_RUN_OVERRIDES.items() if not k.startswith("fabric.")}
    config = Config().with_overrides(no_preset_values)
    listed = fabric.presets(config)
    assert [p.name for p in listed] == PRODUCT["fabric"]["presets"]
    assert all(p.values is None and not p.verified for p in listed)
    traced = trace_design(BIRD, config, WIDTH)
    with pytest.raises(EditError, match="has no values yet"):
        apply_edit(traced, {"op": "fabric", "preset": "knit_jersey"}, config)


def test_an_unknown_preset_is_refused():
    traced = trace_design(BIRD, CONFIG, WIDTH)
    with pytest.raises(EditError, match="not in the list"):
        apply_edit(traced, {"op": "fabric", "preset": "velvet"}, CONFIG)


@pytest.mark.parametrize("name", PRODUCT["fabric"]["presets"])
def test_choosing_a_preset_re_sews_with_its_values(name, tmp_path):
    values = fabric.preset(CONFIG, name).values
    result = digitize(BIRD, tmp_path, CONFIG, WIDTH, edits=[choose(name)])
    assert result.fabric == name and result.shapes["fabric"] == name
    assert result.fill_row_spacing_mm == values["fill_row_spacing_mm"]
    assert result.pull_compensation_mm == values["pull_compensation_mm"]
    sewn = fabric.sewing_config(CONFIG, name)
    for field, key in fabric.FIELDS.items():
        assert sewn.get(key) == values[field]


def test_different_presets_give_different_files_and_none_gives_the_defaults(tmp_path):
    files = {}
    for name in (None, "knit_jersey", "cap_twill"):
        edits = [choose(name)] if name else []
        digitize(BIRD, tmp_path / str(name), CONFIG, WIDTH, edits=edits)
        files[name] = (tmp_path / str(name) / "out.dst").read_bytes()
    assert len(set(files.values())) == 3
    digitize(BIRD, tmp_path / "off", CONFIG, WIDTH, edits=[choose("knit_jersey"), choose(None)])
    assert (tmp_path / "off" / "out.dst").read_bytes() == files[None]


def test_fill_density_set_by_hand_wins_over_the_preset(tmp_path):
    result = digitize(BIRD, tmp_path, CONFIG, WIDTH, edits=[choose("knit_jersey")], fill_row_spacing_mm=0.6)
    assert result.fill_row_spacing_mm == 0.6
    assert result.pull_compensation_mm == fabric.preset(CONFIG, "knit_jersey").values["pull_compensation_mm"]


def test_a_shapes_own_pull_compensation_wins_over_the_preset(tmp_path):
    traced = trace_design(BIRD, CONFIG, WIDTH)
    own = to_pixels({"op": "set_pull_compensation", "shape": 7, "mm": 0.9}, traced)
    result = digitize(BIRD, tmp_path, CONFIG, WIDTH, edits=[own, choose("knit_jersey")])
    assert result.shapes["shapes"][6]["pull_compensation_mm"] == 0.9


def test_preset_changes_have_names():
    assert label({"op": "fabric", "preset": "knit_jersey"}) == "Choose a fabric preset"
    assert label({"op": "fabric", "preset": None}) == "Fabric preset off"
