"""Stitchbook HTTP API.

Endpoints: GET /health, GET /site, GET /config, POST /designs, POST /designs/{id}/preview,
GET /designs/{id}, GET /designs/{id}/shapes, GET /designs/{id}/download?format=dst,
GET /designs/{id}/editor, POST /designs/{id}/edits, POST /designs/{id}/edits/undo,
POST /designs/{id}/edits/redo, POST /designs/{id}/trace, GET /jobs/health, GET /jobs/{id},
POST /jobs/{id}/cancel. Every error body is {"error": "<what to fix>"}.
Design records are JSON files in Storage for now (a database comes with Supabase later).
"""

from __future__ import annotations

import functools
import re
import tempfile
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated

from digitizer.config import Config, PlaceholderValueError, load_config, load_test_run_config
from digitizer import quality
from digitizer.digitize import design_shapes, digitize, thread_placeholder, trace_design
from digitizer.edits import EditError, apply_edit, label as edit_label, to_pixels
from digitizer.fabric import presets as fabric_presets
from digitizer.readback import records
from fastapi import Body, FastAPI, File, Form, HTTPException, Path as PathParam, Query, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import ValidationError
from shapely.ops import unary_union

from stitchbook_api import uploads
from stitchbook_api.jobs import AlreadyFinished, JobNotFound, Jobs, QueueUnavailable
from stitchbook_api.models import (
    ClientConfig,
    ColourLayerOut,
    DesignCreated,
    DesignRecord,
    DesignSettings,
    DesignShapes,
    DetectedColour,
    DigitizeReport,
    DownloadQuery,
    EditorDefaults,
    EditorState,
    EditRequest,
    ErrorResponse,
    FabricPresetOut,
    FabricState,
    HealthResponse,
    History,
    JobOut,
    JobsHealth,
    Layer,
    SiteInfo,
    PreviewRequest,
    PreviewResponse,
    SettingsUsed,
    QualityWarningOut,
    StitchPoint,
    StitchStats,
    TraceColumn,
)
from stitchbook_api.settings import Settings, load_settings
from stitchbook_api.storage import LocalDiskStorage, NotFound, Storage

DesignId = Annotated[str, PathParam(pattern=r"^[0-9a-f]{32}$", description="Design id from POST /designs")]
JobId = Annotated[str, PathParam(pattern=r"^[0-9a-f]{32}$", description="Job id from POST /designs/{id}/trace")]
ERRORS = {code: {"model": ErrorResponse} for code in (404, 409, 413, 415, 422, 503)}


def _warnings(items) -> list[QualityWarningOut]:
    return [QualityWarningOut(code=w.code, message=w.message, value=w.value, threshold=w.threshold) for w in items]


def _detected_colours(traced) -> tuple[list[DetectedColour], tuple[int, int] | None]:
    """Detected colours (largest area first) and the logo's bounding box size in pixels."""
    pixels = sum(layer.colour.pixels for layer in traced.layers) or 1
    detected = []
    for layer in traced.layers:
        x0, y0, x1, y1 = unary_union([s.poly_px for s in layer.shapes]).bounds
        detected.append(DetectedColour(hex=layer.hex, share=layer.colour.pixels / pixels, shape_count=len(layer.shapes),
                                       bounds_px=[int(x0), int(y0), int(round(x1)), int(round(y1))]))
    x0, y0, x1, y1 = unary_union([s.poly_px for s in traced.shapes]).bounds
    return detected, (int(round(x1 - x0)), int(round(y1 - y0)))


def _plain_validation_message(exc: RequestValidationError | ValidationError) -> str:
    parts = []
    for err in exc.errors():
        loc = ".".join(str(p) for p in err.get("loc", ()) if p not in ("body", "query", "path"))
        parts.append(f"{loc}: {err['msg']}" if loc else err["msg"])
    return "; ".join(parts) + ". Fix the request and send it again."


def create_app(config: Config | None = None, storage: Storage | None = None,
               settings: Settings | None = None) -> FastAPI:
    settings = settings or load_settings()
    config = config or (load_test_run_config() if settings.test_run_values else load_config())
    storage = storage or LocalDiskStorage(settings.storage_dir, config.get("storage.replace_attempts"),
                                          config.get("storage.replace_retry_s"))
    # One lock per design: requests that sew a design and write its files (preview, editor,
    # changes, undo, redo) run one after the other for the same design, never at the same time.
    # This covers one API process; several processes would need a shared lock (not built).
    locks: dict[str, threading.Lock] = {}
    locks_guard = threading.Lock()

    def design_lock(design_id: str) -> threading.Lock:
        with locks_guard:
            return locks.setdefault(design_id, threading.Lock())

    def one_at_a_time(endpoint):
        """Run the endpoint while holding its design's lock (FastAPI still sees its signature)."""
        @functools.wraps(endpoint)
        def locked(design_id: str, *args, **kwargs):
            with design_lock(design_id):
                return endpoint(design_id, *args, **kwargs)
        return locked

    jobs = Jobs(settings.redis_url, settings.rq_queue, settings.trace_job, storage,
                redis_timeout_s=lambda: config.get("jobs.redis_timeout_s"))

    app = FastAPI(title=f"{config.app_name} API")
    if settings.cors_origin:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=[settings.cors_origin],
            allow_methods=["GET", "POST"],
            allow_headers=["Content-Type"],
        )

    @app.exception_handler(HTTPException)
    async def http_error(_: Request, exc: HTTPException):
        return JSONResponse({"error": exc.detail}, status_code=exc.status_code)

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, exc: RequestValidationError):
        return JSONResponse({"error": _plain_validation_message(exc)}, status_code=422)

    @app.exception_handler(PlaceholderValueError)
    async def not_configured(_: Request, exc: PlaceholderValueError):
        key = str(exc).split("'")[1] if "'" in str(exc) else str(exc)
        return JSONResponse({"error": f"The server is not configured yet: choose a value for {key} in "
                                      "digitizer/src/digitizer/config.py."}, status_code=503)

    def load_record(design_id: str) -> DesignRecord:
        try:
            return DesignRecord.model_validate_json(storage.get(f"designs/{design_id}/design.json"))
        except NotFound:
            raise HTTPException(404, f"No design with id {design_id}. Upload the image again with POST /designs.") \
                from None

    def check_settings(s: DesignSettings, record: DesignRecord | None = None) -> None:
        """Plain messages for values outside the limits in config.py (and colours the design lacks)."""
        if s.colours is not None and record is not None:
            known = {c.hex for c in record.colours}
            unknown = [c for c in s.colours if c.upper() not in known]
            if unknown:
                raise HTTPException(422, f"{', '.join(unknown)} is not one of this design's colours. Choose from the "
                                         "colours found on the upload screen.")
        if s.width_mm is not None and s.width_mm > (limit := config.get("api.max_design_width_mm")):
            raise HTTPException(422, f"Design width must be at most {limit:g} mm. Enter a smaller width.")
        if s.fill_row_spacing_mm is not None:
            lo, hi = config.get("api.fill_row_spacing_min_mm"), config.get("api.fill_row_spacing_max_mm")
            if not lo <= s.fill_row_spacing_mm <= hi:
                raise HTTPException(422, f"Fill density (row spacing) must be between {lo:g} and {hi:g} mm.")

    def save_record(record: DesignRecord) -> None:
        storage.put(f"designs/{record.id}/design.json", record.model_dump_json(indent=2).encode())

    @app.get("/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        return HealthResponse(status="ok", app=config.app_name)

    @app.get("/site", response_model=SiteInfo)
    def site() -> SiteInfo:
        return SiteInfo(app_name=config.app_name, demo_video_url=config.get("site.demo_video_url"),
                        export_formats=config.get("output.formats"))

    @app.get("/config", response_model=ClientConfig, responses=ERRORS)
    def client_config() -> ClientConfig:
        return ClientConfig(
            app_name=config.app_name,
            allowed_types=config.get("input.allowed_types"),
            max_upload_bytes=config.get("input.max_upload_bytes"),
            max_image_side_px=config.get("input.max_image_side_px"),
            design_width_mm=config.get("design.width_mm"),
            max_design_width_mm=config.get("api.max_design_width_mm"),
            fill_row_spacing_mm=config.get("stitch.fill_row_spacing_mm"),
            fill_row_spacing_min_mm=config.get("api.fill_row_spacing_min_mm"),
            fill_row_spacing_max_mm=config.get("api.fill_row_spacing_max_mm"),
            trace_estimate_minutes=config.get("jobs.trace_estimate_minutes"),
            poll_start_s=config.get("jobs.poll_start_s"),
            poll_max_s=config.get("jobs.poll_max_s"),
            poll_backoff_factor=config.get("jobs.poll_backoff_factor"),
            status_timeout_s=config.get("jobs.status_timeout_s"),
        )

    @app.post("/designs", response_model=DesignCreated, status_code=201, responses=ERRORS)
    async def create_design(
        file: Annotated[UploadFile, File(description="Logo image: PNG or JPG (SVG is stored but cannot be digitized)")],
        settings_json: Annotated[str | None, Form(alias="settings", description="JSON, e.g. {\"width_mm\": 60}")] = None,
    ) -> DesignCreated:
        try:
            design_settings = DesignSettings.model_validate_json(settings_json or "{}")
        except ValidationError as exc:
            raise HTTPException(422, "settings: " + _plain_validation_message(exc)) from None
        check_settings(design_settings)
        # Read one byte past the limit so an oversized file is detected without reading it all.
        data = await file.read(config.get("input.max_upload_bytes") + 1)
        try:
            upload = uploads.inspect(data, config)
        except uploads.UploadRejected as exc:
            raise HTTPException(exc.status, exc.message) from None

        design_id = uuid.uuid4().hex
        storage.put(f"designs/{design_id}/original.{upload.type}", data)
        detected, background, specks, bounds = [], None, 0, None
        warnings = list(upload.warnings)
        if upload.type != "svg":
            with tempfile.TemporaryDirectory() as tmp:
                source = Path(tmp) / f"original.{upload.type}"
                source.write_bytes(data)
                try:
                    traced = trace_design(source, config, design_settings.width_mm, classify=False)
                except ValueError:
                    traced = None  # no logo found: the upload screen says so
            if traced is not None:
                detected, bounds = _detected_colours(traced)
                known = {c.hex for c in detected}
                if design_settings.colours and not all(c.upper() in known for c in design_settings.colours):
                    raise HTTPException(422, "settings.colours lists a colour that is not in this image. Leave it out "
                                             "to keep every colour, then choose colours after the upload.")
                background, specks = traced.background, traced.specks_removed
                if (warning := quality.speck_warning(specks, config)) is not None:
                    warnings.append(warning)
        record = DesignRecord(
            id=design_id, filename=Path(file.filename or f"logo.{upload.type}").name, type=upload.type,
            bytes=len(data), width_px=upload.width_px, height_px=upload.height_px,
            logo_width_px=bounds[0] if bounds else None, logo_height_px=bounds[1] if bounds else None,
            colours=detected, background=background, specks_removed=specks, settings=design_settings,
            warnings=_warnings(warnings), status="uploaded", created_at=datetime.now(timezone.utc),
        )
        save_record(record)
        return DesignCreated(id=design_id, type=record.type, width_px=record.width_px, height_px=record.height_px,
                             logo_width_px=record.logo_width_px, logo_height_px=record.logo_height_px,
                             colours=record.colours, background=record.background,
                             specks_removed=record.specks_removed, warnings=record.warnings)

    def check_sync_size(record: DesignRecord, what: str) -> None:
        if record.type == "svg":
            raise HTTPException(422, f"SVG files cannot be {what}. Export the logo as PNG or JPG and "
                                     "upload that instead.")
        limit = config.get("api.sync_preview_max_side_px")
        if max(record.width_px or 0, record.height_px or 0) > limit:
            raise HTTPException(422, f"This image is larger than {limit} px on its long side, too big to work on "
                                     f"while you wait. Resize it to at most {limit} px and upload again "
                                     "(background processing for large images is not built yet).")

    def record_width(record: DesignRecord) -> float:
        return record.settings.width_mm or config.get("design.width_mm")

    def applied(record: DesignRecord) -> list[dict]:
        return record.edits[:record.edits_applied]

    def sew(record: DesignRecord):
        """Digitize the design with its settings and the changes in effect; store the DST, preview
        and report (so Download matches), and the stats on the record. Returns
        (record, result, stitches, width, spacing). The fill density set on the preview screen is
        passed on as set by hand, so it wins over a fabric preset's."""
        width = record_width(record)
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / f"original.{record.type}"
            source.write_bytes(storage.get(f"designs/{record.id}/original.{record.type}"))
            out = Path(tmp) / "out"
            try:
                result = digitize(source, out, config, width, record.settings.colours, applied(record),
                                  fill_row_spacing_mm=record.settings.fill_row_spacing_mm)
            except ValueError as exc:
                raise HTTPException(422, f"This image could not be digitized ({exc}). Use a logo on a plain "
                                         "background, or a transparent PNG.") from None
            for name in ("out.dst", "preview.png", "report.json"):
                storage.put(f"designs/{record.id}/{name}", (out / name).read_bytes())
            layers_iter = iter(result.stitch_layers)
            stitches = [StitchPoint(x_mm=x, y_mm=y, command=c, layer=next(layers_iter) if c == "stitch" else None)
                        for x, y, c in records(out / "out.dst")]
        record = record.model_copy(update={"status": "digitized", "stats": StitchStats(**vars(result.stats)),
                                           "report": DigitizeReport(**result.to_json()), "downloads": ["dst"]})
        save_record(record)
        return record, result, stitches, width, result.fill_row_spacing_mm

    def layers_and_colours(result):
        layers = [Layer(number=i, type=t, stitch_count=n, colour=c, shape=shape)
                  for i, ((t, n, c), shape) in enumerate(zip(result.layers, result.layer_shapes), start=1)]
        colours = [ColourLayerOut(number=i, hex=c.hex, shape_count=c.shapes, area_mm2=c.area_mm2,
                                  stitch_count=c.stitches, thread=thread_placeholder())
                   for i, c in enumerate(result.colours, start=1)]
        return layers, colours

    @app.post("/designs/{design_id}/preview", response_model=PreviewResponse, responses=ERRORS)
    @one_at_a_time
    def preview(design_id: DesignId, body: PreviewRequest | None = None) -> PreviewResponse:
        """Digitize with the design's settings (optionally changed here) and every editor change
        in effect. Stores the DST for download."""
        record = load_record(design_id)
        if body is not None:
            check_settings(body, record)
            changes = body.model_dump(exclude_none=True)
            if "colours" in changes:
                changes["colours"] = [c.upper() for c in changes["colours"]]
            record = record.model_copy(update={"settings": record.settings.model_copy(update=changes)})
        check_sync_size(record, "digitized")
        record, result, stitches, width, spacing = sew(record)
        layers, colours = layers_and_colours(result)
        return PreviewResponse(id=design_id, stats=record.stats, report=record.report,
                               settings_used=SettingsUsed(width_mm=width, fill_row_spacing_mm=spacing),
                               colours=colours, overlaps=list(result.overlaps), layers=layers,
                               warnings=record.warnings, stitches=stitches)

    @app.get("/designs/{design_id}/shapes", response_model=DesignShapes, responses=ERRORS)
    def shapes(design_id: DesignId) -> DesignShapes:
        """The design's shapes in mm (same coordinates as the DST) for the editor canvas and
        Layers list, with the editor's changes in effect."""
        record = load_record(design_id)
        check_sync_size(record, "opened in the editor")
        width = record_width(record)
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / f"original.{record.type}"
            source.write_bytes(storage.get(f"designs/{design_id}/original.{record.type}"))
            try:
                found = design_shapes(source, config, width, record.settings.colours, applied(record))
            except ValueError as exc:
                raise HTTPException(422, f"No shapes could be traced from this image ({exc}). Use a logo on a plain "
                                         "background, or a transparent PNG.") from None
        return DesignShapes(id=design_id, **found)

    # ---------- editor: changes, undo, redo ----------

    def editor_state(record: DesignRecord) -> EditorState:
        record, result, stitches, _width, _spacing = sew(record)
        layers, colours = layers_and_colours(result)
        n, total = record.edits_applied, len(record.edits)
        history = History(applied=n, total=total, undo=edit_label(record.edits[n - 1]) if n else None,
                          redo=edit_label(record.edits[n]) if n < total else None)
        defaults = EditorDefaults(
            pull_compensation_mm=result.pull_compensation_mm,
            pull_compensation_min_mm=config.get("api.pull_compensation_min_mm"),
            pull_compensation_max_mm=config.get("api.pull_compensation_max_mm"),
            satin_max_width_mm=config.get("satin.max_width_mm"),
        )
        return EditorState(id=record.id, shapes=DesignShapes(id=record.id, **result.shapes),
                           columns=[TraceColumn(**c) for c in result.columns], colours=colours, layers=layers,
                           stats=record.stats, stitches=stitches, history=history, defaults=defaults,
                           fabric=FabricState(preset=result.fabric, presets=[
                               FabricPresetOut(name=p.name, label=p.label, verified=p.verified,
                                               ready=p.values is not None, values=p.values)
                               for p in fabric_presets(config)]))

    @app.get("/designs/{design_id}/editor", response_model=EditorState, responses=ERRORS)
    @one_at_a_time
    def get_editor(design_id: DesignId) -> EditorState:
        """The editor's view of the design: shapes, satin columns and every stitch, from one run
        of the digitizer with the changes in effect (which also refreshes the DST for download)."""
        record = load_record(design_id)
        check_sync_size(record, "opened in the editor")
        return editor_state(record)

    @app.post("/designs/{design_id}/edits", response_model=EditorState, responses=ERRORS)
    @one_at_a_time
    def add_edit(design_id: DesignId, body: Annotated[EditRequest, Body()]) -> EditorState:
        """Make one change (stitch type, pull compensation, split, satin column from two edges).
        It is checked against the design as it is now; a change that cannot be made is refused
        with a plain message and nothing is stored. Changes that could be redone are dropped."""
        record = load_record(design_id)
        check_sync_size(record, "edited")
        if body.op == "set_pull_compensation" and body.mm is not None:
            lo, hi = config.get("api.pull_compensation_min_mm"), config.get("api.pull_compensation_max_mm")
            if not lo <= body.mm <= hi:
                raise HTTPException(422, f"Pull compensation must be between {lo:g} and {hi:g} mm.")
        width = record_width(record)
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / f"original.{record.type}"
            source.write_bytes(storage.get(f"designs/{design_id}/original.{record.type}"))
            try:
                traced = trace_design(source, config, width, record.settings.colours, edits=applied(record))
                stored = to_pixels(body.model_dump(), traced)
                apply_edit(traced, stored, config)
            except EditError as exc:
                raise HTTPException(422, str(exc)) from None
            except ValueError as exc:
                raise HTTPException(422, f"This image could not be digitized ({exc}).") from None
        edits = applied(record) + [stored]
        return editor_state(record.model_copy(update={"edits": edits, "edits_applied": len(edits)}))

    @app.post("/designs/{design_id}/edits/undo", response_model=EditorState, responses=ERRORS)
    @one_at_a_time
    def undo(design_id: DesignId) -> EditorState:
        record = load_record(design_id)
        if record.edits_applied == 0:
            raise HTTPException(409, "There is nothing to undo.")
        check_sync_size(record, "edited")
        return editor_state(record.model_copy(update={"edits_applied": record.edits_applied - 1}))

    @app.post("/designs/{design_id}/edits/redo", response_model=EditorState, responses=ERRORS)
    @one_at_a_time
    def redo(design_id: DesignId) -> EditorState:
        record = load_record(design_id)
        if record.edits_applied >= len(record.edits):
            raise HTTPException(409, "There is nothing to redo.")
        check_sync_size(record, "edited")
        return editor_state(record.model_copy(update={"edits_applied": record.edits_applied + 1}))

    @app.get("/designs/{design_id}", response_model=DesignRecord, responses=ERRORS)
    def get_design(design_id: DesignId) -> DesignRecord:
        return load_record(design_id)

    @app.get("/designs/{design_id}/download", responses={200: {"content": {"application/octet-stream": {}}}, **ERRORS})
    def download(design_id: DesignId, query: Annotated[DownloadQuery, Query()]) -> Response:
        record = load_record(design_id)
        if "dst" not in record.downloads:
            raise HTTPException(409, f"This design has no stitch file yet. Run POST /designs/{design_id}/preview "
                                     "first, then download.")
        data = storage.get(f"designs/{design_id}/out.{query.format}")
        stem = re.sub(r"[^A-Za-z0-9._-]", "_", Path(record.filename).stem) or "design"
        filename = f"{stem}.{query.format}"
        return Response(data, media_type="application/octet-stream",
                        headers={"Content-Disposition": f'attachment; filename="{filename}"'})

    # ---------- background jobs ----------
    QUEUE_DOWN = "Background jobs are not running, so satin columns cannot be traced right now."

    def job_state(job_id: str) -> JobOut:
        try:
            return jobs.state(job_id)
        except JobNotFound:
            raise HTTPException(404, "This job no longer exists. Start it again from the editor.") from None
        except QueueUnavailable:
            raise HTTPException(503, QUEUE_DOWN) from None

    @app.post("/designs/{design_id}/trace", response_model=JobOut, status_code=202, responses=ERRORS)
    def start_trace(design_id: DesignId) -> JobOut:
        """Start "Create satin columns" in the background. If one is already queued or running
        for this design, that job is returned instead of starting a second."""
        record = load_record(design_id)
        if record.type == "svg":
            raise HTTPException(422, "SVG files cannot be traced. Export the logo as PNG or JPG and upload that instead.")
        if record.trace_job_id:
            try:
                current = jobs.state(record.trace_job_id)
                if current.status in ("queued", "running"):
                    return current
            except (JobNotFound, QueueUnavailable):
                pass
        image = storage.get(f"designs/{design_id}/original.{record.type}")
        try:
            started = jobs.start_trace(
                design_id, image, record.type, record.settings.width_mm, dict(config.overrides), record.settings.colours,
                applied(record),
                timeout_s=config.get("jobs.job_timeout_s"), ttl_s=config.get("jobs.result_ttl_s"),
                retries=config.get("jobs.max_retries"),
            )
        except QueueUnavailable:
            raise HTTPException(503, QUEUE_DOWN) from None
        save_record(record.model_copy(update={"trace_job_id": started.id}))
        return started

    # Registered before /jobs/{job_id} so "health" is not taken for a job id.
    @app.get("/jobs/health", response_model=JobsHealth, responses=ERRORS)
    def jobs_health() -> JobsHealth:
        """Whether background jobs can run: 503 with a plain message if Redis can't be reached."""
        try:
            return JobsHealth(status="ok", workers=jobs.health())
        except QueueUnavailable:
            raise HTTPException(503, QUEUE_DOWN) from None

    @app.get("/jobs/{job_id}", response_model=JobOut, responses=ERRORS)
    def get_job(job_id: JobId) -> JobOut:
        return job_state(job_id)

    @app.post("/jobs/{job_id}/cancel", response_model=JobOut, responses=ERRORS)
    def cancel_job(job_id: JobId) -> JobOut:
        try:
            return jobs.cancel(job_id)
        except AlreadyFinished as exc:
            raise HTTPException(409, f"This job has already ended ({exc}); there is nothing to cancel.") from None
        except JobNotFound:
            raise HTTPException(404, "This job no longer exists. Start it again from the editor.") from None
        except QueueUnavailable:
            raise HTTPException(503, QUEUE_DOWN) from None

    return app


app = create_app()
