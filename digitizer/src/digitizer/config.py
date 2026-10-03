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
        # Overlap between touching colours, so no fabric shows between them. Where a shape touches
        # a shape of a colour sewn LATER, the earlier shape is grown this far outward, but only
        # into that later shape (and the thin seam between them): it runs under the later
        # colour, which is sewn on top. Never into colours it does not touch, never past the
        # design's outer edge. Measured from the traced outline, in mm.
        "overlap_mm": PLACEHOLDER,
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
        # Length of each stitch along a running-stitch outline (shapes set to Running in the editor).
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
    "fabric": {
        # Fabric presets offered in the editor, in this order. Choosing one re-sews the design with
        # its values in place of the stitch/satin defaults below (digitizer.fabric). What is set by
        # hand still wins: the fill density set on the preview screen, and a shape's own pull
        # compensation set in the editor.
        # UNVERIFIED: every preset value is a placeholder for the owner to choose; none has been
        # sewn on a machine. The editor shows "Unverified: not yet tested on a machine" next to
        # the picker for every preset whose .verified is False.
        "presets": ["woven_cotton", "knit_jersey", "cap_twill"],
        # Each preset has:
        #   .label                name shown in the picker
        #   .verified             True only after a design sewn with this preset on a real machine
        #                         has been checked by the owner; False shows the Unverified note
        #   .fill_row_spacing_mm  replaces stitch.fill_row_spacing_mm (fill density)
        #   .satin_spacing_mm     replaces stitch.satin_spacing_mm (satin density)
        #   .underlay_spacing_mm  replaces stitch.underlay_spacing_mm (zigzag underlay density)
        #   .underlay_edge_walk   replaces satin.underlay_edge_walk (true/false)
        #   .underlay_zigzag      replaces satin.underlay_zigzag (true/false)
        #   .pull_compensation_mm replaces stitch.pull_compensation_mm (satin pull compensation)
        # Woven cotton (UNVERIFIED)
        "woven_cotton.label": "Woven cotton",
        "woven_cotton.verified": False,
        "woven_cotton.fill_row_spacing_mm": PLACEHOLDER,
        "woven_cotton.satin_spacing_mm": PLACEHOLDER,
        "woven_cotton.underlay_spacing_mm": PLACEHOLDER,
        "woven_cotton.underlay_edge_walk": PLACEHOLDER,
        "woven_cotton.underlay_zigzag": PLACEHOLDER,
        "woven_cotton.pull_compensation_mm": PLACEHOLDER,
        # Knit / jersey (UNVERIFIED)
        "knit_jersey.label": "Knit / jersey",
        "knit_jersey.verified": False,
        "knit_jersey.fill_row_spacing_mm": PLACEHOLDER,
        "knit_jersey.satin_spacing_mm": PLACEHOLDER,
        "knit_jersey.underlay_spacing_mm": PLACEHOLDER,
        "knit_jersey.underlay_edge_walk": PLACEHOLDER,
        "knit_jersey.underlay_zigzag": PLACEHOLDER,
        "knit_jersey.pull_compensation_mm": PLACEHOLDER,
        # Cap / twill (UNVERIFIED)
        "cap_twill.label": "Cap / twill",
        "cap_twill.verified": False,
        "cap_twill.fill_row_spacing_mm": PLACEHOLDER,
        "cap_twill.satin_spacing_mm": PLACEHOLDER,
        "cap_twill.underlay_spacing_mm": PLACEHOLDER,
        "cap_twill.underlay_edge_walk": PLACEHOLDER,
        "cap_twill.underlay_zigzag": PLACEHOLDER,
        "cap_twill.pull_compensation_mm": PLACEHOLDER,
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
        # Range the editor's pull compensation control accepts for a satin shape (the default is
        # stitch.pull_compensation_mm).
        "pull_compensation_min_mm": PLACEHOLDER,
        "pull_compensation_max_mm": PLACEHOLDER,
        # Range the editor's density slider accepts for a shape sewn as satin (satin spacing; the
        # default is stitch.satin_spacing_mm). A fill shape's density slider uses
        # fill_row_spacing_min_mm / fill_row_spacing_max_mm above.
        "satin_spacing_min_mm": PLACEHOLDER,
        "satin_spacing_max_mm": PLACEHOLDER,
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
        # Shown on the Privacy, Terms and Contact pages. Until chosen, those pages show a visible
        # "Not chosen yet" marker instead of a value; nothing is made up.
        # The name of the person or company that runs the service.
        "company_name": PLACEHOLDER,
        # The address people can write to (shown as a mailto link; no form, no email is sent).
        "contact_email": PLACEHOLDER,
        # The country whose law the Terms of Service fall under.
        "governing_country": PLACEHOLDER,
        # How many days uploaded designs are meant to be kept. Shown as the planned retention:
        # nothing deletes designs automatically yet, and the Privacy page says so.
        "data_retention_days": PLACEHOLDER,
        # Date the Privacy and Terms text was last changed, as YYYY-MM-DD.
        "last_updated": PLACEHOLDER,
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
        # Split: a click this close to a shape's edge counts as on the edge (and is moved onto it).
        "snap_distance_mm": PLACEHOLDER,
    },
    "engine": {
        # How many shapes' stitch pieces the digitizer keeps in memory between runs, so an editor
        # change rebuilds only the shapes it changed. Only speed depends on it, never the stitches.
        "piece_cache_shapes": PLACEHOLDER,
    },
    "storage": {
        # Saving a file: on Windows, moving the finished file over one that another program has
        # open (a virus scanner, the search indexer, a viewer) fails with WinError 32. The move
        # is tried this many times in all...
        "replace_attempts": 5,
        # ...waiting this many seconds between tries.
        "replace_retry_s": 0.05,
        # Supabase Storage: a link to a private file (an export, the original) stops working this
        # many seconds after the API makes it. 60 s was named in the step-12 request.
        "signed_url_ttl_s": 60,
    },
    "auth": {
        # Supabase sign-in: the API keeps the project's public signing keys (JWKS) this many
        # seconds before fetching them again (a key the API has not seen yet is fetched at once).
        "jwks_cache_s": PLACEHOLDER,
        # The API gives up on a call to Supabase (Auth, database, Storage) after this many seconds
        # and answers with a plain "try again" message instead of hanging.
        "http_timeout_s": PLACEHOLDER,
    },
    "billing": {
        # Plans, credits and payments (Step 13). Values marked OWNER TO CONFIRM were given by the
        # owner but still need a final yes. PLACEHOLDER = not chosen: shown as a visible
        # placeholder in the UI, never replaced by an invented value.
        # Plan display names (what the pricing page and the account menu show).
        "plans.free.display_name": "Free",
        "plans.pro.display_name": "Pro",
        "plans.business.display_name": "Business",
        # Price per month in billing.currency. Free costs nothing.
        "plans.free.price_monthly": 0,
        "plans.pro.price_monthly": 12,
        "plans.business.price_monthly": 25,
        # Free plan: credits given once per account, never renewed ("lifetime"). 30 = 3 exports
        # at the export cost below. OWNER TO CONFIRM (exports, lifetime or monthly).
        "plans.free.credits": 30,
        "plans.free.credit_period": "lifetime",
        # Paid plans: credits given every UTC calendar month (yearly plans get the same monthly
        # allowance, granted month by month).
        "plans.pro.credits_per_month": 5000,
        "plans.business.credits_per_month": 10000,
        # Features listed on a plan's card, in order, AND what each plan may use: the API checks
        # a feature's "key" (export_history -> GET /exports, credit_usage -> GET /credits/usage,
        # teams -> the Team page). "name" is the text shown; "status": "coming_soon" shows a small
        # "Coming soon" tag and does NOT unlock the feature yet. Only what exists is listed.
        "plans.free.features": [
            {"key": "saved_designs", "name": "Saved designs"},
        ],
        "plans.pro.features": [
            {"key": "saved_designs", "name": "Saved designs"},
            {"key": "export_history", "name": "Export history"},
            {"key": "credit_usage", "name": "Credit usage"},
        ],
        "plans.business.features": [
            {"key": "saved_designs", "name": "Saved designs"},
            {"key": "export_history", "name": "Export history"},
            {"key": "credit_usage", "name": "Credit usage"},
            {"key": "teams", "name": "Multiple accounts", "status": "coming_soon"},
        ],
        # Accounts per Business subscription. Not built (Step 13b: Teams); never shown as a claim.
        "plans.business.seats": PLACEHOLDER,
        # Yearly billing: the yearly price is monthly x 12 x (1 - this/100), computed in code
        # (Pro 129.60, Business 270.00), never typed in anywhere.
        "yearly_discount_percent": 10,
        # Export history and Credit usage: rows per page (the API pages newest first).
        "history_page_size": PLACEHOLDER,
        # Credits each metered operation costs. 0 or PLACEHOLDER = free and nothing is reserved.
        # The list of operation kinds is the keys here. Preview is never metered.
        "credit_costs.export": 10,
        "credit_costs.satin_columns": PLACEHOLDER,
        "credit_costs.auto_digitize": PLACEHOLDER,
        # Whether unused monthly plan credits carry into the next month. False = they expire at
        # the end of the UTC month. OWNER TO CONFIRM.
        "monthly_rollover": False,
        # Credit packs to buy on top of a plan: a list of {"credits": n, "price": p}. Hidden while
        # unset. Bought credits never expire and are spent after the monthly allowance.
        "credit_packs": PLACEHOLDER,
        # Currency of every price (whether the provider supports it is an owner decision).
        "currency": "USD",
        # Payment provider adapter name (stitchbook_api.payments); PLACEHOLDER = payments off
        # ("Payments are not available yet"). "fake" = the FakeProvider, never in production.
        # "whop" = Whop (docs/payments-whop.md); accepted only with WHOP_API_KEY and
        # WHOP_WEBHOOK_SECRET in .env and every whop_* value below chosen.
        "provider": PLACEHOLDER,
        # Whop: which Whop API the adapter talks to, "sandbox" (sandbox-api.whop.com, test
        # payments) or "production" (api.whop.com). "sandbox" is refused when STITCHBOOK_ENV=production.
        "whop_environment": PLACEHOLDER,
        # Whop plan ids (plan_...), one per plan and billing interval. The owner creates these
        # four plans in the Whop dashboard and pastes their ids here; code never creates prices.
        # api/scripts/check_whop_plans.py compares each plan's Whop price with ours.
        "plans.pro.whop_plan_ids.month": PLACEHOLDER,
        "plans.pro.whop_plan_ids.year": PLACEHOLDER,
        "plans.business.whop_plan_ids.month": PLACEHOLDER,
        "plans.business.whop_plan_ids.year": PLACEHOLDER,
        # A webhook whose signed timestamp is further than this many seconds from the server's
        # clock (either way) is refused (replay protection). 300 = the 5 minutes of the Standard
        # Webhooks spec that Whop signs with (given in the Step 13c request).
        "webhook_tolerance_s": 300,
        # Back from the payment page, /billing asks for the plan and credits every
        # checkout_return_poll_s seconds, for at most checkout_return_wait_s seconds, until the
        # payment's webhook has arrived; then it says plainly that it can take longer.
        # PLACEHOLDER = no automatic checks, only a "Check again" button.
        "checkout_return_poll_s": PLACEHOLDER,
        "checkout_return_wait_s": PLACEHOLDER,
        # The API gives up on a call to the payment provider (create a checkout, cancel, read a
        # membership or plan) after this many seconds and answers with a plain "try again".
        "provider_http_timeout_s": PLACEHOLDER,
        # A reservation still open after this many seconds is released (its job is presumed
        # lost) by the sweep, which runs every sweep_interval_s seconds and at API start.
        "reservation_timeout_s": PLACEHOLDER,
        "sweep_interval_s": PLACEHOLDER,
        # Refund policy text shown on the pricing page. PLACEHOLDER = "[Refund policy]".
        "refund_policy": PLACEHOLDER,
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
    "colour.overlap_mm": 0.4,
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
    "billing.reservation_timeout_s": 600,
    "billing.sweep_interval_s": 60,
    "billing.history_page_size": 20,
    "auth.jwks_cache_s": 300,
    "auth.http_timeout_s": 10,
    "editor.edit_point_tolerance_mm": 0.5,
    "editor.snap_distance_mm": 1.0,
    "stitch.running_stitch_length_mm": 2.5,
    "api.pull_compensation_min_mm": 0.0,
    "api.pull_compensation_max_mm": 1.0,
    "api.satin_spacing_min_mm": 0.25,
    "api.satin_spacing_max_mm": 0.8,
    "engine.piece_cache_shapes": 256,
    # Fabric presets: made-up values that only differ from each other so the tests can see a
    # preset re-sew the design. Not for sewing.
    "fabric.woven_cotton.fill_row_spacing_mm": 0.4,
    "fabric.woven_cotton.satin_spacing_mm": 0.4,
    "fabric.woven_cotton.underlay_spacing_mm": 2.0,
    "fabric.woven_cotton.underlay_edge_walk": True,
    "fabric.woven_cotton.underlay_zigzag": True,
    "fabric.woven_cotton.pull_compensation_mm": 0.3,
    "fabric.knit_jersey.fill_row_spacing_mm": 0.35,
    "fabric.knit_jersey.satin_spacing_mm": 0.35,
    "fabric.knit_jersey.underlay_spacing_mm": 1.5,
    "fabric.knit_jersey.underlay_edge_walk": True,
    "fabric.knit_jersey.underlay_zigzag": True,
    "fabric.knit_jersey.pull_compensation_mm": 0.5,
    "fabric.cap_twill.fill_row_spacing_mm": 0.45,
    "fabric.cap_twill.satin_spacing_mm": 0.45,
    "fabric.cap_twill.underlay_spacing_mm": 2.5,
    "fabric.cap_twill.underlay_edge_walk": True,
    "fabric.cap_twill.underlay_zigzag": False,
    "fabric.cap_twill.pull_compensation_mm": 0.4,
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
