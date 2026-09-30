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
    "colour": {
        # Most thread colours a design is reduced to (the background is not counted). The image is
        # quantized to at most this many flat colours; fewer if it has fewer.
        "max_colours": PLACEHOLDER,
        # Two colours closer than this (CIE76 Delta E in Lab: about 1 is a just-visible step)
        # count as the same thread colour. Also decides which pixels are "flat" (all neighbours
        # within this distance) and therefore used to find the colours; edge blends are not.
        "same_colour_delta_e": PLACEHOLDER,
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
        # Satin density: distance along the column's centerline from one needle point to the next
        # (points alternate between the two edges). Smaller = denser.
        "satin_spacing_mm": PLACEHOLDER,
        # Length of each stitch along a running-stitch outline. (Not used yet.)
        "running_stitch_length_mm": PLACEHOLDER,
        # Longest single stitch the digitizer may emit; longer stitches are split evenly.
        # Note: one DST record can move at most 12.1 mm along each axis.
        "max_stitch_length_mm": PLACEHOLDER,
        # Fill rows shorter than this are dropped (avoids tiny stitches that bunch or break thread).
        "min_stitch_length_mm": PLACEHOLDER,
        # Zigzag underlay under satin: distance along the centerline between its needle points.
        # (Fill underlay is not built yet.)
        "underlay_spacing_mm": PLACEHOLDER,
        # Pull compensation for satin: each column is made this much wider in total
        # (half added on each edge) to offset fabric pull-in. (Not applied to fill yet.)
        "pull_compensation_mm": PLACEHOLDER,
        # Moves between rows up to this length, that stay inside the shape, are sewn as stitches;
        # anything longer or crossing outside the shape becomes a jump.
        "jump_threshold_mm": PLACEHOLDER,
        # Jumps longer than this also get a trim command before them.
        "trim_threshold_mm": PLACEHOLDER,
    },
    "satin": {
        # SATIN_MAX_WIDTH_MM. A shape whose widest point (largest circle that fits inside it)
        # is at most this wide becomes satin; wider shapes stay fill.
        "max_width_mm": PLACEHOLDER,
        # Skeleton clean-up: a centerline branch with a free end that is shorter than this many
        # times the local half-width is treated as a corner artefact and removed.
        "spur_prune_factor": PLACEHOLDER,
        # Edge-walk underlay: run stitches along both edges before the satin (true/false).
        "underlay_edge_walk": PLACEHOLDER,
        # How far inside each edge the edge walk runs.
        "underlay_edge_inset_mm": PLACEHOLDER,
        # Stitch length of the edge walk.
        "underlay_edge_stitch_length_mm": PLACEHOLDER,
        # Zigzag underlay: a sparse zigzag across the column before the satin (true/false).
        # Its density is stitch.underlay_spacing_mm.
        "underlay_zigzag": PLACEHOLDER,
        # How far inside each edge the zigzag underlay turns.
        "underlay_zigzag_inset_mm": PLACEHOLDER,
    },
    "input": {
        # Accepted upload types (from the product spec). digitize.py reads PNG/JPG only so far.
        "allowed_types": ["png", "jpg", "jpeg", "svg"],
        # Largest upload the API accepts, in bytes. Bigger files are rejected.
        "max_upload_bytes": PLACEHOLDER,
        # Largest image the API accepts: width or height above this many pixels is rejected.
        "max_image_side_px": PLACEHOLDER,
        # Speck removal: a traced shape (of any colour) smaller than this area, at the design's
        # size, is dropped; a hole in a shape smaller than this is filled. In square millimetres.
        "min_shape_area_mm2": PLACEHOLDER,
    },
    "quality": {
        # Upload warnings (the upload is still accepted). Smaller long side -> "too small" warning.
        "min_long_side_px": 300,
        # Low-contrast warning below this: difference in mean grey level (0-255) between the
        # logo and the background after an automatic black/white split.
        "min_contrast": PLACEHOLDER,
        # Blurry-edges warning below this: variance of the Laplacian of the image after its grey
        # levels are stretched to 0-255 (so contrast does not count twice).
        "min_edge_sharpness": PLACEHOLDER,
        # "Many small specks" warning when speck removal drops more than this many shapes.
        "max_specks": PLACEHOLDER,
    },
    "api": {
        # POST /designs/{id}/preview digitizes on the spot only for images whose long side is at
        # most this many pixels; bigger ones must wait for background processing (not built yet).
        "sync_preview_max_side_px": PLACEHOLDER,
        # Largest design width a user may ask for, in mm (also bounds how long a preview can take).
        "max_design_width_mm": PLACEHOLDER,
        # Range a user may set the fill row spacing to on the preview screen (the default is
        # stitch.fill_row_spacing_mm). Smaller spacing = denser fill = more stitches.
        "fill_row_spacing_min_mm": PLACEHOLDER,
        "fill_row_spacing_max_mm": PLACEHOLDER,
    },
    "output": {
        # Machine formats offered to users (download, landing page). A format may be listed only
        # after its pyembroidery write-then-read round trip passes (digitizer/tests/test_round_trip.py).
        # PES is next, but its round trip fails today: every jump comes back with a trim, and one
        # sample gets an extra stitch in the middle of a jump.
        # JEF, VP3 and EXP come after PES.
        "formats": ["dst"],
    },
    "site": {
        # Landing-page demo video (a full URL to a video file). Empty = a poster with a play
        # button and the label "[Demo video]".
        "demo_video_url": "",
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
        # Jump line colour, and the colour of column-number labels (ink and muted from the
        # design system).
        "stitch_color": "#1F1F1F",
        "jump_color": "#8A8A8A",
        # Blank margin around the design, as a fraction of its larger side.
        "margin_fraction": 0.05,
        # Stitches are drawn in their colour layer's colour (the image's own colours).
        # Underlay is drawn in its layer's colour at this opacity (0-1).
        "underlay_alpha": 0.35,
        # Font size of the column numbers, in points.
        "label_font_size_pt": 7,
    },
    "jobs": {
        # Hard limit on one digitizing job in the worker before it is killed.
        "job_timeout_s": PLACEHOLDER,
        # How long a finished job's result stays in Redis.
        "result_ttl_s": PLACEHOLDER,
        # How many times a failed job is retried automatically.
        "max_retries": PLACEHOLDER,
        # Typical time for "Create satin columns", shown as "Usually about N minutes (estimate)".
        # None = no estimate is shown. Never replaced by a guess in the UI.
        "trace_estimate_minutes": None,
        # The editor asks for a job's state first after this many seconds...
        "poll_start_s": 2,
        # ...then waits longer each time, never more than this many seconds...
        "poll_max_s": 15,
        # ...multiplying the wait by this factor after each check.
        "poll_backoff_factor": PLACEHOLDER,
        # The API gives up connecting to / reading from Redis after this many seconds and
        # answers "Background jobs are not running" instead of hanging.
        "redis_timeout_s": PLACEHOLDER,
        # The editor waits this many seconds for a job-status answer before showing a plain
        # "no answer" message with Retry (the Create satin columns card never waits forever).
        "status_timeout_s": PLACEHOLDER,
    },
    "editor": {
        # Edit points on a traced satin column: its centerline is simplified so that no point of
        # the line is further than this from the simplified version. Bigger = fewer points.
        "edit_point_tolerance_mm": PLACEHOLDER,
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
    "colour.max_colours": 8,
    "colour.same_colour_delta_e": 10,
    "input.min_shape_area_mm2": 1.0,
    "quality.max_specks": 10,
    "design.width_mm": 60,
    "stitch.satin_spacing_mm": 0.4,
    "stitch.underlay_spacing_mm": 2.0,
    "stitch.pull_compensation_mm": 0.3,
    "satin.max_width_mm": 6,
    "satin.spur_prune_factor": 2,
    "satin.underlay_edge_walk": True,
    "satin.underlay_edge_inset_mm": 0.4,
    "satin.underlay_edge_stitch_length_mm": 2.0,
    "satin.underlay_zigzag": True,
    "satin.underlay_zigzag_inset_mm": 0.4,
    "stitch.fill_angle_deg": 45,
    "stitch.fill_row_spacing_mm": 0.4,
    "stitch.max_stitch_length_mm": 7,
    "stitch.min_stitch_length_mm": 0.5,
    "stitch.jump_threshold_mm": 2,
    "stitch.trim_threshold_mm": 5,
    "input.max_upload_bytes": 5_000_000,
    "input.max_image_side_px": 4000,
    "quality.min_contrast": 100,
    "quality.min_edge_sharpness": 50,
    "api.sync_preview_max_side_px": 1000,
    "api.max_design_width_mm": 300,
    "api.fill_row_spacing_min_mm": 0.3,
    "api.fill_row_spacing_max_mm": 1.0,
    "jobs.job_timeout_s": 600,
    "jobs.result_ttl_s": 86400,
    "jobs.max_retries": 0,
    "jobs.poll_backoff_factor": 2,
    "jobs.redis_timeout_s": 2,
    "jobs.status_timeout_s": 10,
    "editor.edit_point_tolerance_mm": 0.5,
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
