"""Fabric presets: named sets of density, underlay and pull compensation (config section "fabric").

A preset is chosen in the editor as a change like any other ({"op": "fabric", "preset": name},
see digitizer.edits), so undo, redo, Preview and Download all follow it. digitize() sews with
sewing_config(): the preset's values replace the defaults, and what was set by hand (the fill
density on the preview screen, a shape's own pull compensation) still wins.

Every preset value is UNVERIFIED until the owner has sewn it on a machine and set .verified.
"""

from __future__ import annotations

from dataclasses import dataclass

from digitizer.config import Config, PlaceholderValueError

# Preset field -> the setting it replaces. Names, not numbers: the numbers live in config.py.
FIELDS = {
    "fill_row_spacing_mm": "stitch.fill_row_spacing_mm",
    "satin_spacing_mm": "stitch.satin_spacing_mm",
    "underlay_spacing_mm": "stitch.underlay_spacing_mm",
    "underlay_edge_walk": "satin.underlay_edge_walk",
    "underlay_zigzag": "satin.underlay_zigzag",
    "pull_compensation_mm": "stitch.pull_compensation_mm",
}


class FabricError(ValueError):
    """A preset that does not exist or has no values yet, in plain words."""


@dataclass(frozen=True)
class Preset:
    name: str
    label: str
    verified: bool  # sewn on a machine and checked by the owner
    values: dict | None  # field -> value; None while any value is still a placeholder


def presets(config: Config) -> list[Preset]:
    """Every preset in config order, with its values if they have all been chosen."""
    out = []
    for name in config.get("fabric.presets"):
        try:
            values = {f: config.get(f"fabric.{name}.{f}") for f in FIELDS}
        except PlaceholderValueError:
            values = None
        out.append(Preset(name, config.get(f"fabric.{name}.label"), bool(config.get(f"fabric.{name}.verified")),
                          values))
    return out


def preset(config: Config, name: str) -> Preset:
    for p in presets(config):
        if p.name == name:
            return p
    raise FabricError("That fabric preset is not in the list any more. Choose another one.")


def check(config: Config, name: str | None) -> None:
    """Raise FabricError unless `name` is None (no preset) or a preset whose values are chosen."""
    if name is not None and preset(config, name).values is None:
        raise FabricError(f"The {preset(config, name).label} preset has no values yet. Choose another one.")


def sewing_config(config: Config, name: str | None, fill_row_spacing_mm: float | None = None) -> Config:
    """The config to sew with: the preset's values over the defaults, then the fill density set
    by hand (if any) over that."""
    overrides = {}
    if name is not None:
        check(config, name)
        overrides = {FIELDS[f]: v for f, v in preset(config, name).values.items()}
    if fill_row_spacing_mm is not None:
        overrides["stitch.fill_row_spacing_mm"] = fill_row_spacing_mm
    return config.with_overrides(overrides) if overrides else config
