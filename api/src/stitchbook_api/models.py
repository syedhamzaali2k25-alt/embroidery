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
    settings: DesignSettings
    warnings: list[QualityWarningOut]
    status: Literal["uploaded", "digitized"]
    created_at: datetime
    stats: StitchStats | None = None
    report: DigitizeReport | None = None
    downloads: list[Literal["dst"]] = []


class DesignCreated(BaseModel):
    id: str
    type: ImageType
    width_px: int | None
    height_px: int | None
    warnings: list[QualityWarningOut]


class StitchPoint(BaseModel):
    x_mm: float
    y_mm: float
    command: Literal["stitch", "jump", "trim", "end"]


class PreviewResponse(BaseModel):
    id: str
    stats: StitchStats
    report: DigitizeReport
    warnings: list[QualityWarningOut]
    stitches: list[StitchPoint] = Field(description="Every needle command in the DST, in sewing order.")


class DownloadQuery(BaseModel):
    format: Literal["dst"] = Field(default="dst", description="Only DST is available so far.")
