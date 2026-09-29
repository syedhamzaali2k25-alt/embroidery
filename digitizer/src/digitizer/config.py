"""The ONE config file for every Stitchbook product number.

Rules (see CLAUDE.md):
  * Every stitch parameter, size limit, timeout and rate limit lives here, nowhere else.
  * Each value has a comment saying what it does. Units are in the key name:
    _mm = millimetres, _deg = degrees, _px = image pixels, _bytes, _s = seconds.
  * PLACEHOLDER marks a value the project owner has not chosen yet.
    Config.get() refuses to return it, so nothing runs on an invented number.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

PLACEHOLDER = "__CHOOSE__"

PRODUCT: dict[str, dict[str, Any]] = {
    "app": {
        # Working product name. The only place it is defined for Python code.
        "name": "Stitchbook",
    },
    "image": {
        # Foreground blobs (and background holes) smaller than this many pixels are
        # treated as specks and removed before contours are traced.
        "min_speck_area_px": PLACEHOLDER,
    },
    "design": {
        # Width of the finished design; the logo is scaled so its bounding box has this width.
        "width_mm": PLACEHOLDER,
    },
    "stitch": {
        # Direction of the parallel fill rows, measured from horizontal, counter-clockwise.
        "fill_angle_deg": PLACEHOLDER,
        # Spacing between parallel rows in a fill (tatami) area. Smaller = denser.
        "fill_row_spacing_mm": PLACEHOLDER,
        # Spacing between the zig-zag passes of a satin column. Smaller = denser. (Not used yet.)
        "satin_spacing_mm": PLACEHOLDER,
        # Length of each stitch along a running-stitch outline. (Not used yet.)
        "running_stitch_length_mm": PLACEHOLDER,
        # Longest single stitch the digitizer may emit; longer stitches are split evenly.
        # Note: one DST record can move at most 12.1 mm along each axis.
        "max_stitch_length_mm": PLACEHOLDER,
        # Fill rows shorter than this are dropped (avoids tiny stitches that bunch or break thread).
        "min_stitch_length_mm": PLACEHOLDER,
        # Row spacing of the underlay laid down before fill and satin top stitching. (Not used yet.)
        "underlay_spacing_mm": PLACEHOLDER,
        # Amount shapes are widened across the stitch direction to offset fabric pull-in. (Not used yet.)
        "pull_compensation_mm": PLACEHOLDER,
        # Moves between rows up to this length, that stay inside the shape, are sewn as stitches;
        # anything longer or crossing outside the shape becomes a jump.
        "jump_threshold_mm": PLACEHOLDER,
        # Jumps longer than this also get a trim command before them.
        "trim_threshold_mm": PLACEHOLDER,
    },
    "input": {
        # Accepted upload types (from the product spec). digitize.py reads PNG/JPG only so far.
        "allowed_types": ["png", "jpg", "jpeg", "svg"],
        # Largest upload the API accepts.
        "max_upload_bytes": PLACEHOLDER,
        # Raster images larger than this (width or height) are rejected or downscaled.
        "max_image_side_px": PLACEHOLDER,
    },
    "output": {
        # Formats written today, in priority order (DST first, PES second).
        # JEF, VP3 and EXP may be added only after a pyembroidery write-then-read
        # round-trip test passes for each one.
        "formats": ["dst", "pes"],
    },
    "preview": {
        # Cosmetic only: these change how preview.png looks, never the embroidery file.
        # Resolution of the preview image.
        "dpi": 150,
        # Width of the preview image in inches (height follows the design's aspect ratio).
        "width_in": 6,
        # Line width of sewn stitches in the preview, in points.
        "stitch_line_width_pt": 0.6,
        # Line width of jumps in the preview, in points (drawn dashed).
        "jump_line_width_pt": 0.5,
        # Dash pattern for jumps in the preview: [dash length, gap length] in points.
        "jump_dash_pt": [2, 2],
        # Stitch and jump line colours (ink and muted from the design system).
        "stitch_color": "#1F1F1F",
        "jump_color": "#8A8A8A",
        # Blank margin around the design, as a fraction of its larger side.
        "margin_fraction": 0.05,
    },
    "jobs": {
        # Hard limit on one digitizing job in the worker before it is killed.
        "job_timeout_s": PLACEHOLDER,
        # How long a finished job's result stays in Redis.
        "result_ttl_s": PLACEHOLDER,
        # How many times a failed job is retried automatically.
        "max_retries": PLACEHOLDER,
    },
    "rate_limits": {
        # Uploads a single user may start per minute.
        "uploads_per_minute": PLACEHOLDER,
        # Digitizing jobs a single user may have queued or running at once.
        "concurrent_jobs_per_user": PLACEHOLDER,
    },
}

# NOT product values. Used only by the sample run and the tests so the code can be
# exercised while the real values above are still PLACEHOLDER. Files produced with
# these are for checking the code, not for sewing. Replace or delete once PRODUCT is filled in.
TEST_RUN_OVERRIDES: dict[str, Any] = {
    "image.min_speck_area_px": 20,
    "design.width_mm": 60,
    "stitch.fill_angle_deg": 45,
    "stitch.fill_row_spacing_mm": 0.4,
    "stitch.max_stitch_length_mm": 7,
    "stitch.min_stitch_length_mm": 0.5,
    "stitch.jump_threshold_mm": 2,
    "stitch.trim_threshold_mm": 5,
}


class PlaceholderValueError(LookupError):
    """Raised when code asks for a config value that has not been chosen yet."""


@dataclass(frozen=True)
class Config:
    data: dict[str, dict[str, Any]] = field(default_factory=lambda: PRODUCT)
    overrides: dict[str, Any] = field(default_factory=dict)

    def get(self, dotted_key: str) -> Any:
        """Return a value such as "stitch.max_stitch_length_mm"."""
        section, _, key = dotted_key.partition(".")
        if section not in self.data or key not in self.data[section]:
            raise KeyError(f"{dotted_key!r} is not defined in digitizer/config.py")
        value = self.overrides.get(dotted_key, self.data[section][key])
        if value == PLACEHOLDER:
            raise PlaceholderValueError(
                f"{dotted_key!r} is still a placeholder in digitizer/config.py; choose a value first"
            )
        return value

    def with_overrides(self, overrides: dict[str, Any]) -> Config:
        unknown = [k for k in overrides if k.partition(".")[2] not in self.data.get(k.partition(".")[0], {})]
        if unknown:
            raise KeyError(f"unknown config keys: {unknown}")
        return Config(self.data, {**self.overrides, **overrides})

    def placeholders(self) -> list[str]:
        """Every dotted key whose effective value is still the placeholder."""
        return [
            f"{section}.{key}"
            for section, values in self.data.items()
            for key, value in values.items()
            if self.overrides.get(f"{section}.{key}", value) == PLACEHOLDER
        ]

    @property
    def app_name(self) -> str:
        return self.get("app.name")


def load_config() -> Config:
    """The product config, with no overrides."""
    return Config()


def load_test_run_config() -> Config:
    """Product config plus TEST_RUN_OVERRIDES (for samples and tests only)."""
    return Config().with_overrides(TEST_RUN_OVERRIDES)
