"""Pydantic models for every request and response body."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

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
    colours: list[Annotated[str, StringConstraints(pattern=r"^#[0-9A-Fa-f]{6}$")]] | None = Field(
        default=None, min_length=1,
        description="Colours to keep, as \"#RRGGBB\" from the design's detected colours; the others are left "
                    "out. Omit to keep them all.",
    )


class PreviewRequest(DesignSettings):
    """Optional body of POST /designs/{id}/preview: settings to change before digitizing again."""


class SiteInfo(BaseModel):
    """What the public landing page shows; none of it depends on unchosen limits."""
    app_name: str
    demo_video_url: str = Field(description="Empty means: show the poster with the [Demo video] label")
    export_formats: list[str] = Field(description="Only formats whose pyembroidery round trip passes")
    # Owner decisions for the Privacy, Terms and Contact pages. null = not chosen yet in config.py
    # (the page then shows "Not chosen yet").
    company_name: str | None = None
    contact_email: str | None = None
    governing_country: str | None = None
    data_retention_days: int | None = None
    last_updated: str | None = Field(default=None, description="YYYY-MM-DD")
    max_upload_bytes: int | None = Field(default=None, description="Upload size limit, for the Privacy page")


class TraceColumn(BaseModel):
    number: int
    left: list[list[float]] = Field(description="Left edge points, mm")
    right: list[list[float]] = Field(description="Right edge points, mm")
    edit_points: list[list[float]] = Field(description="Points along the centerline the user can move, mm")
    label: list[float] = Field(description="Where to draw the column number, mm")
    shape: int | None = Field(default=None, description="Number of the design shape this column belongs to")
    colour: int | None = Field(default=None, description="Number of the colour layer this column belongs to")


class JobsHealth(BaseModel):
    status: Literal["ok"]
    workers: int = Field(description="Workers listening on the queue; 0 means jobs wait in the queue")


class ThreadPlaceholder(BaseModel):
    """Thread names and codes are not chosen yet. This is a labelled placeholder, never a real code."""
    name: str = Field(description='Always "[Thread name]" for now')
    code: str = Field(description='Always "[Thread code]" for now')
    placeholder: Literal[True] = True


class ColourLayerOut(BaseModel):
    number: int = Field(description="1-based, in sewing order (largest total area first)")
    hex: str = Field(description="The image's own colour for this layer, #RRGGBB")
    shape_count: int
    area_mm2: float
    stitch_count: int | None = Field(default=None, description="Stitches in this colour (preview only)")
    thread: ThreadPlaceholder


class DetectedColour(BaseModel):
    """A colour found in the uploaded image (the background is not listed)."""
    hex: str = Field(description="#RRGGBB, the mean of the image's own pixels of this colour")
    share: float = Field(description="Fraction of the logo's pixels (all detected colours) in this colour, 0..1")
    shape_count: int = Field(description="Shapes of this colour after speck removal")
    bounds_px: list[int] = Field(description="[min x, min y, max x, max y] of its shapes, image pixels")


class ColumnEdges(BaseModel):
    left: list[list[float]] = Field(description="Left edge, mm")
    right: list[list[float]] = Field(description="Right edge, mm")
    closed: bool = Field(description="True when the edges are an outline and a hole (a ring)")


class DesignShape(BaseModel):
    number: int = Field(description="1-based over the whole design, in sewing order")
    colour: int = Field(description="Number of its colour layer")
    kind: Literal["fill", "satin", "running", "column"] = Field(
        description="How the shape is sewn: by width (fill or satin) unless chosen in the editor; "
                    "column = a satin column made in the editor between two edges")
    kind_chosen: bool = Field(default=False, description="The stitch type was chosen in the editor")
    pull_compensation_mm: float | None = Field(default=None, description="Set in the editor; None = the default")
    fill_spacing_mm: float | None = Field(default=None, description="Fill density set in the editor; None = default")
    satin_spacing_mm: float | None = Field(default=None, description="Satin density set in the editor; None = default")
    parent: int | None = Field(default=None, description="For a sublayer: the number of the shape it is part of")
    sublayers: list[int] = Field(default=[], description="Numbers of this shape's sublayers")
    notes: list[str] = Field(default=[], description="Plain notes about how this shape will be sewn")
    edges: ColumnEdges | None = Field(default=None, description="For kind column: the two edges it runs between")
    max_width_mm: float
    area_mm2: float
    bounds_mm: list[float] = Field(description="[min x, min y, max x, max y]")
    rings: list[list[list[float]]] = Field(description="Outline first, then holes; points in mm (includes the overlap)")
    overlap: list[list[list[list[float]]]] = Field(
        default=[], description="Where this shape runs under a later colour it touches (colour.overlap_mm): "
                                "polygons, each outline then holes, in mm")


class DesignShapes(BaseModel):
    id: str
    colours: list[ColourLayerOut]
    shapes: list[DesignShape]
    bounds_mm: list[float]
    width_mm: float
    height_mm: float
    shapes_found: int = Field(description="Shapes traced before speck removal")
    specks_removed: int = Field(description="Shapes dropped as specks (smaller than input.min_shape_area_mm2)")
    skipped_edits: list[str] = Field(default=[], description="Editor changes that no longer fit the design")
    fabric: str | None = Field(default=None, description="Fabric preset in effect; null = the stitch defaults")


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
    status_timeout_s: float = Field(description="How long the editor waits for a job-status answer before saying so")
    billing: dict | None = Field(default=None, description="Plans, prices and credit costs (also GET /plans)")


class QualityWarningOut(BaseModel):
    code: Literal["too_small", "low_contrast", "blurry_edges", "many_specks"]
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
    colour_changes: int = 0
    shapes_found: int = 0
    specks_removed: int = 0
    holes_filled: int = 0


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
    colours: list[DetectedColour] = []  # detected thread colours (background removed), largest area first
    background: str | None = None  # "#RRGGBB" of the removed background; None if transparent or unknown
    specks_removed: int = 0
    settings: DesignSettings
    warnings: list[QualityWarningOut]
    status: Literal["uploaded", "digitized"]
    created_at: datetime
    stats: StitchStats | None = None
    report: DigitizeReport | None = None
    downloads: list[str] = []
    # Who can see the design. Only "private" exists: there is no sharing. Only its owner (the
    # signed-in user who uploaded it) can read or change it; anyone else gets 404.
    visibility: Literal["private"] = "private"
    trace_job_id: str | None = None  # latest "Create satin columns" job, so the editor can resume it
    # Editor changes, stored in image pixels (digitizer.edits). The first edits_applied are in
    # effect; the rest can be redone. A new change drops the ones that could be redone.
    edits: list[dict] = []
    edits_applied: int = 0


class DesignSummary(BaseModel):
    """One row of "My designs"."""
    id: str
    filename: str
    type: ImageType
    status: Literal["uploaded", "digitized"]
    created_at: datetime
    colour_count: int
    stitch_count: int | None = Field(description="None until the design has been digitized")
    width_mm: float | None
    height_mm: float | None


class DownloadLink(BaseModel):
    url: str = Field(description="Signed Storage link, or (local mode) the API's own /download path")
    filename: str
    expires_in_s: int | None = Field(description="Seconds the link works for; None for the API path")
    signed: bool


class DesignCreated(BaseModel):
    id: str
    type: ImageType
    width_px: int | None
    height_px: int | None
    logo_width_px: int | None = Field(description="Logo bounding box; design height = width_mm x logo_height/logo_width")
    logo_height_px: int | None
    colours: list[DetectedColour] = Field(description="Colours found (background removed), largest area first")
    background: str | None = Field(description="Removed background colour; None if it was transparent")
    specks_removed: int = Field(description="Shapes dropped as specks at the upload's design width")
    warnings: list[QualityWarningOut]


class StitchPoint(BaseModel):
    x_mm: float
    y_mm: float
    command: Literal["stitch", "jump", "trim", "end"]
    layer: int | None = Field(default=None, description="Layer number for stitches; None for other commands")


class Layer(BaseModel):
    number: int = Field(description="1-based, in sewing order")
    type: Literal["fill", "satin", "running", "junction patch"]
    stitch_count: int
    colour: int = Field(description="Number of the colour layer it belongs to")
    shape: int | None = Field(default=None, description="Number of the shape it sews (as in shapes)")


class SettingsUsed(BaseModel):
    width_mm: float
    fill_row_spacing_mm: float


class PreviewResponse(BaseModel):
    id: str
    stats: StitchStats
    report: DigitizeReport
    settings_used: SettingsUsed
    colours: list[ColourLayerOut] = Field(description="Colour layers in sewing order, one colour change between each")
    overlaps: list[list[list[list[float]]]] = Field(
        default=[], description="Where one colour runs under a later colour it touches: polygons (rings) in mm")
    layers: list[Layer]
    warnings: list[QualityWarningOut]
    stitches: list[StitchPoint] = Field(description="Every needle command in the DST, in sewing order.")


class DownloadQuery(BaseModel):
    format: str = Field(default="dst", description="One of GET /formats' formats")


class UnavailableFormat(BaseModel):
    format: str
    label: str
    reason: str = Field(description="Why it cannot be exported, in words (shown as the picker's tooltip)")


class FormatsOut(BaseModel):
    """Formats the backend can write AND whose pyembroidery round trip passes (see digitizer.formats)."""
    formats: list[str]
    labels: dict[str, str] = Field(description="Name to show for each format, offered or not")
    unavailable: list[UnavailableFormat]


# ---------- editor ----------

PointMm = Annotated[list[float], Field(min_length=2, max_length=2, description="[x, y] in mm")]


class OutlineRef(BaseModel):
    """One outline of a shape: ring 0 is its outside, 1.. its holes (in the order /editor lists them)."""
    model_config = ConfigDict(extra="forbid")
    shape: int = Field(ge=1)
    ring: int = Field(default=0, ge=0)


class DrawnEdge(BaseModel):
    """An edge drawn with the pen, in mm."""
    model_config = ConfigDict(extra="forbid")
    points: list[PointMm] = Field(min_length=2)


class SetTypeEdit(BaseModel):
    model_config = ConfigDict(extra="forbid")
    op: Literal["set_type"]
    shape: int = Field(ge=1, description="Shape number, as /editor lists it now")
    kind: Literal["running", "satin", "fill"]


class PullCompensationEdit(BaseModel):
    model_config = ConfigDict(extra="forbid")
    op: Literal["set_pull_compensation"]
    shape: int = Field(ge=1)
    mm: float | None = Field(description="Total widening of each satin stitch; null = back to the default")


class DensityEdit(BaseModel):
    model_config = ConfigDict(extra="forbid")
    op: Literal["set_density"]
    shape: int = Field(ge=1)
    mm: float | None = Field(description="Row spacing (fill) or satin spacing (satin); null = back to the default")


class SublayerEdit(BaseModel):
    model_config = ConfigDict(extra="forbid")
    op: Literal["sublayer"]
    shape: int = Field(ge=1, description="The shape to take the sublayer out of")
    points: list[PointMm] = Field(min_length=3, description="Outline of the part that becomes the sublayer, in mm")


class SplitEdit(BaseModel):
    model_config = ConfigDict(extra="forbid")
    op: Literal["split"]
    a: PointMm = Field(description="A point on one edge of a satin shape")
    b: PointMm = Field(description="A point on the opposite edge")


class ColumnEdit(BaseModel):
    model_config = ConfigDict(extra="forbid")
    op: Literal["column"]
    left: OutlineRef | DrawnEdge
    right: OutlineRef | DrawnEdge
    colour: int | None = Field(default=None, ge=1, description="Colour layer for drawn edges (default: 1)")


class FabricEdit(BaseModel):
    model_config = ConfigDict(extra="forbid")
    op: Literal["fabric"]
    preset: str | None = Field(description="Fabric preset name from /editor; null = back to the stitch defaults")


EditRequest = Annotated[SetTypeEdit | PullCompensationEdit | DensityEdit | SplitEdit | SublayerEdit | ColumnEdit | FabricEdit,
                        Field(discriminator="op")]


class History(BaseModel):
    applied: int = Field(description="Changes in effect")
    total: int = Field(description="Changes stored, including ones that can be redone")
    undo: str | None = Field(description="What Undo would take back; null = nothing")
    redo: str | None = Field(description="What Redo would put back; null = nothing")


class EditorDefaults(BaseModel):
    """Values from config.py the editor shows as defaults and limits."""
    pull_compensation_mm: float = Field(description="For shapes without their own: the fabric preset's, else config's")
    pull_compensation_min_mm: float
    pull_compensation_max_mm: float
    fill_row_spacing_mm: float = Field(description="Fill density for shapes without their own (preset or preview)")
    fill_row_spacing_min_mm: float
    fill_row_spacing_max_mm: float
    satin_spacing_mm: float = Field(description="Satin density for shapes without their own")
    satin_spacing_min_mm: float
    satin_spacing_max_mm: float
    satin_max_width_mm: float


class FabricPresetOut(BaseModel):
    name: str
    label: str
    verified: bool = Field(description="Sewn on a machine and checked by the owner. False: show it as unverified")
    ready: bool = Field(description="All its values are chosen in config.py; false = it cannot be chosen yet")
    values: dict[str, float | bool] | None = Field(description="Its values (UNVERIFIED unless verified); null if not chosen")


class FabricState(BaseModel):
    preset: str | None = Field(description="Preset in effect; null = the stitch defaults")
    presets: list[FabricPresetOut]


class EditorState(BaseModel):
    """Everything the editor shows, from one run of the digitizer with the changes in effect.
    The stitch file is written by the same run, so Preview and Download match it."""
    id: str
    shapes: DesignShapes
    columns: list[TraceColumn] = Field(description="Satin columns, numbered in sewing order")
    colours: list[ColourLayerOut]
    layers: list[Layer]
    stats: StitchStats
    stitches: list[StitchPoint]
    history: History
    defaults: EditorDefaults
    fabric: FabricState
