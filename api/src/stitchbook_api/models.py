"""Pydantic models for every request and response body."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

ImageType = Literal["png", "jpg", "svg"]


class ErrorResponse(BaseModel):
    error: str = Field(description="What went wrong and what to do about it, in plain words.")


class HealthResponse(BaseModel):
    status: Literal["ok"]
    app: str


class DesignSettings(BaseModel):
    """Per-design settings sent with the upload, as a JSON string in the `settings` form field."""
    model_config = ConfigDict(extra="forbid")
    width_mm: float | None = Field(
        default=None, gt=0, description="Finished design width in mm. Omit to use design.width_mm from config."
    )
    fill_row_spacing_mm: float | None = Field(
        default=None, gt=0, description="Fill density as row spacing in mm (smaller = denser). Omit for the default."
    )


class PreviewRequest(DesignSettings):
    """Optional body of POST /designs/{id}/preview: settings to change before digitizing again."""


class SiteInfo(BaseModel):
    """What the public landing page shows; none of it depends on unchosen limits."""
    app_name: str
    demo_video_url: str = Field(description="Empty means: show the poster with the [Demo video] label")
    export_formats: list[str] = Field(description="Only formats whose pyembroidery round trip passes")


class TraceColumn(BaseModel):
    number: int
    left: list[list[float]] = Field(description="Left edge points, mm")
    right: list[list[float]] = Field(description="Right edge points, mm")
    edit_points: list[list[float]] = Field(description="Points along the centerline the user can move, mm")
    label: list[float] = Field(description="Where to draw the column number, mm")


class TraceResult(BaseModel):
    columns: list[TraceColumn]
    fill_shapes: int
    junction_patches: int
    bounds_mm: list[float]
    width_mm: float


class JobOut(BaseModel):
    id: str
    design_id: str
    kind: Literal["trace"]
    status: Literal["queued", "running", "done", "failed", "cancelled"]
    progress: float | None = Field(description="0..1 as reported by the worker; None when unknown")
    created_at: datetime | None
    started_at: datetime | None = Field(description="Server time the worker started; elapsed time counts from here")
    finished_at: datetime | None
    server_time: datetime = Field(description="Server clock now, so the client can count elapsed time without trusting its own clock")
    cancel_requested: bool = False
    error: str | None = None
    result: TraceResult | None = None


class ClientConfig(BaseModel):
    """Defaults and limits the web app needs to fill in and check its forms."""
    app_name: str
    allowed_types: list[str]
    max_upload_bytes: int
    max_image_side_px: int
    design_width_mm: float
    max_design_width_mm: float
    fill_row_spacing_mm: float
    fill_row_spacing_min_mm: float
    fill_row_spacing_max_mm: float
    trace_estimate_minutes: float | None = Field(description="Shown as an estimate; None = show nothing")
    poll_start_s: float
    poll_max_s: float
    poll_backoff_factor: float


class QualityWarningOut(BaseModel):
    code: Literal["too_small", "low_contrast", "blurry_edges"]
    message: str
    value: float
    threshold: float


class StitchStats(BaseModel):
    stitch_count: int
    jump_count: int
    trim_count: int
    width_mm: float
    height_mm: float
    longest_stitch_mm: float
    longest_jump_mm: float
    color_count: int


class DigitizeReport(BaseModel):
    jumps: int
    trims: int
    fill_areas: int
    satin_columns: int
    junction_patches: int
    skipped_rungs: int
    trimmed_rungs: int


class DesignRecord(BaseModel):
    """What is stored (and returned by GET /designs/{id}) for one design."""
    id: str
    filename: str
    type: ImageType
    bytes: int
    width_px: int | None
    height_px: int | None
    logo_width_px: int | None = None  # bounding box of the logo itself, None if none was found
    logo_height_px: int | None = None
    settings: DesignSettings
    warnings: list[QualityWarningOut]
    status: Literal["uploaded", "digitized"]
    created_at: datetime
    stats: StitchStats | None = None
    report: DigitizeReport | None = None
    downloads: list[Literal["dst"]] = []
    trace_job_id: str | None = None  # latest "Create satin columns" job, so the editor can resume it


class DesignCreated(BaseModel):
    id: str
    type: ImageType
    width_px: int | None
    height_px: int | None
    logo_width_px: int | None = Field(description="Logo bounding box; design height = width_mm x logo_height/logo_width")
    logo_height_px: int | None
    warnings: list[QualityWarningOut]


class StitchPoint(BaseModel):
    x_mm: float
    y_mm: float
    command: Literal["stitch", "jump", "trim", "end"]
    layer: int | None = Field(default=None, description="Layer number for stitches; None for other commands")


class Layer(BaseModel):
    number: int = Field(description="1-based, in sewing order")
    type: Literal["fill", "satin", "junction patch"]
    stitch_count: int


class SettingsUsed(BaseModel):
    width_mm: float
    fill_row_spacing_mm: float


class PreviewResponse(BaseModel):
    id: str
    stats: StitchStats
    report: DigitizeReport
    settings_used: SettingsUsed
    layers: list[Layer]
    warnings: list[QualityWarningOut]
    stitches: list[StitchPoint] = Field(description="Every needle command in the DST, in sewing order.")


class DownloadQuery(BaseModel):
    format: Literal["dst"] = Field(default="dst", description="Only DST is available so far.")
