"""Stitchbook HTTP API.

Endpoints: GET /health, GET /site, GET /config, POST /designs, POST /designs/{id}/preview,
GET /designs/{id}, GET /designs/{id}/shapes, GET /designs/{id}/download?format=dst,
GET /designs/{id}/editor, POST /designs/{id}/edits, POST /designs/{id}/edits/undo,
POST /designs/{id}/edits/redo, POST /designs/{id}/trace, GET /jobs/health, GET /jobs/{id},
POST /jobs/{id}/cancel, GET /designs, GET /designs/{id}/download-url. Every error body is
{"error": "<what to fix>"}.

Sign-in: with SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY set, every route except /health, /site,
/formats and /config (public, no user data) needs "Authorization: Bearer <Supabase access
token>"; the user id comes only from that verified token. Missing or bad token: 401. Someone
else's design or job: 404, exactly as if it did not exist. Records then live in Supabase's tables
and files in its private Storage buckets, always read and written as the signed-in user.
Without those settings the API runs in local mode: one local user, records and files on disk.
"""

from __future__ import annotations

import functools
import logging
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
from digitizer.formats import CANDIDATES as FORMAT_LABELS, offered as offered_formats, write as write_format
from digitizer.readback import records
import httpx
from fastapi import Body, Depends, FastAPI, File, Form, Header, HTTPException, Path as PathParam, Query, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import ValidationError
from shapely.ops import unary_union

from stitchbook_api import uploads
from stitchbook_api.auth import LOCAL_USER, Auth, AuthUnavailable, SupabaseAuth, Unauthorized, User
from stitchbook_api.jobs import TERMINAL, AlreadyFinished, JobNotFound, Jobs, QueueUnavailable
from stitchbook_api.models import (
    ClientConfig,
    ColourLayerOut,
    DesignCreated,
    DesignRecord,
    DesignSettings,
    DesignShapes,
    DesignSummary,
    DetectedColour,
    DigitizeReport,
    DownloadLink,
    DownloadQuery,
    EditorDefaults,
    EditorState,
    EditRequest,
    ErrorResponse,
    FabricPresetOut,
    FabricState,
    FormatsOut,
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
    UnavailableFormat,
)
from stitchbook_api.records import DatabaseUnavailable, Designs, LocalDesigns, SupabaseDesigns
from stitchbook_api.settings import Settings, load_settings
from stitchbook_api.storage import LocalDiskStorage, NotFound, Storage, StorageUnavailable

DesignId = Annotated[str, PathParam(pattern=r"^[0-9a-f]{32}$", description="Design id from POST /designs")]
JobId = Annotated[str, PathParam(pattern=r"^[0-9a-f]{32}$", description="Job id from POST /designs/{id}/trace")]
ERRORS = {code: {"model": ErrorResponse} for code in (401, 404, 409, 413, 415, 422, 503)}
log = logging.getLogger("stitchbook_api")


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
               settings: Settings | None = None, auth: Auth | None = None,
               http: httpx.Client | None = None) -> FastAPI:
    """`auth` checks sign-in tokens: made from the Supabase settings when they are set; tests may
    pass their own. With neither, the API is in local mode (no sign-in, one local user)."""
    settings = settings or load_settings()
    config = config or (load_test_run_config() if settings.test_run_values else load_config())
    storage = storage or LocalDiskStorage(settings.storage_dir, config.get("storage.replace_attempts"),
                                          config.get("storage.replace_retry_s"))
    if settings.supabase:
        http = http or httpx.Client()
        auth = auth or SupabaseAuth(settings.supabase_url, settings.supabase_publishable_key,
                                    timeout_s=lambda: config.get("auth.http_timeout_s"),
                                    cache_s=lambda: config.get("auth.jwks_cache_s"), http=http)

        def designs_for(user: User) -> Designs:
            return SupabaseDesigns(settings.supabase_url, settings.supabase_publishable_key, user.id, user.token,
                                   config.get("auth.http_timeout_s"), http)
    else:
        if auth is None:
            log.warning("Supabase is not configured: local mode, no sign-in, every request is the one local user. "
                        "For offline development and tests only.")

        def designs_for(user: User) -> Designs:
            return LocalDesigns(storage, user.id)

    def current_user(authorization: Annotated[str | None, Header(include_in_schema=False)] = None) -> User:
        """The signed-in user, from a verified token only. Local mode: the one local user."""
        if auth is None:
            return LOCAL_USER
        scheme, _, token = (authorization or "").partition(" ")
        if scheme.lower() != "bearer" or not token.strip():
            raise HTTPException(401, "Sign in to continue: this request has no sign-in token.",
                                headers={"WWW-Authenticate": "Bearer"})
        try:
            return auth.verify(token.strip())
        except Unauthorized as exc:
            raise HTTPException(401, str(exc), headers={"WWW-Authenticate": "Bearer"}) from None
        except AuthUnavailable:
            raise HTTPException(503, "Sign-in could not be checked right now. Try again in a moment.") from None
        except PlaceholderValueError:
            raise  # an unchosen auth.* value: the plain "choose a value" 503

    # Routes take `designs: Designs = Depends(my_designs)` (the default form, because names local to
    # create_app cannot be resolved from string annotations).
    def my_designs(user: User = Depends(current_user)) -> Designs:
        return designs_for(user)
    # One lock per design: requests that sew a design and write its files (preview, editor,
    # changes, undo, redo) run one after the other for the same design, never at the same time.
    # This covers one API process; several processes would need a shared lock (not built).
    locks: dict[str, threading.Lock] = {}
    locks_guard = threading.Lock()

    def design_lock(design_id: str) -> threading.Lock:
        with locks_guard:
            return locks.setdefault(design_id, threading.Lock())

    def one_at_a_time(endpoint):
        """Run the endpoint while holding its design's lock (FastAPI still sees its signature).
        The lock is per owner and design, so one user cannot hold up another's design."""
        @functools.wraps(endpoint)
        def locked(design_id: str, *args, **kwargs):
            with design_lock(f"{kwargs['designs'].owner_id}/{design_id}"):
                return endpoint(design_id, *args, **kwargs)
        return locked

    jobs = Jobs(settings.redis_url, settings.rq_queue, settings.trace_job,
                redis_timeout_s=lambda: config.get("jobs.redis_timeout_s"))

    app = FastAPI(title=f"{config.app_name} API")
    if settings.cors_origin:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=[settings.cors_origin],
            allow_methods=["GET", "POST"],
            allow_headers=["Authorization", "Content-Type"],
        )

    @app.exception_handler(HTTPException)
    async def http_error(_: Request, exc: HTTPException):
        return JSONResponse({"error": exc.detail}, status_code=exc.status_code, headers=exc.headers)

    @app.exception_handler(DatabaseUnavailable)
    @app.exception_handler(StorageUnavailable)
    async def store_down(_: Request, exc: Exception):
        log.warning("store unavailable: %s", exc)
        return JSONResponse({"error": "Your designs could not be reached right now. Try again in a moment."},
                            status_code=503)

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, exc: RequestValidationError):
        return JSONResponse({"error": _plain_validation_message(exc)}, status_code=422)

    @app.exception_handler(PlaceholderValueError)
    async def not_configured(_: Request, exc: PlaceholderValueError):
        key = str(exc).split("'")[1] if "'" in str(exc) else str(exc)
        return JSONResponse({"error": f"The server is not configured yet: choose a value for {key} in "
                                      "digitizer/src/digitizer/config.py."}, status_code=503)

    def load_record(designs: Designs, design_id: str) -> DesignRecord:
        """The user's own design, or 404: someone else's design looks exactly like a missing one."""
        record = designs.get(design_id)
        if record is None:
            raise HTTPException(404, f"No design with id {design_id}. Upload the image again with POST /designs.")
        return record

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

    @app.get("/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        return HealthResponse(status="ok", app=config.app_name)

    @app.get("/site", response_model=SiteInfo)
    def site() -> SiteInfo:
        def chosen(key: str):
            """The value, or None while it is still a placeholder (the page says "Not chosen yet")."""
            try:
                return config.get(key)
            except PlaceholderValueError:
                return None

        return SiteInfo(app_name=config.app_name, demo_video_url=config.get("site.demo_video_url"),
                        export_formats=offered_formats(config)[0],
                        **{k: chosen(f"site.{k}") for k in ("company_name", "contact_email", "governing_country",
                                                             "data_retention_days", "last_updated")},
                        max_upload_bytes=chosen("input.max_upload_bytes"))

    @app.get("/formats", response_model=FormatsOut)
    def formats() -> FormatsOut:
        """Machine file formats the backend can write AND whose write-then-read round trip with
        pyembroidery passes; the rest are listed with the reason, for the editor's picker."""
        available, unavailable = offered_formats(config)
        return FormatsOut(formats=available, labels=FORMAT_LABELS,
                          unavailable=[UnavailableFormat(format=f, label=FORMAT_LABELS[f], reason=r)
                                       for f, r in unavailable.items()])

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
        designs: Designs = Depends(my_designs),
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
        designs.create(record)  # the record first: Storage and the exports table refer to it
        designs.put_file(design_id, f"original.{upload.type}", data)
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

    def sew(designs: Designs, record: DesignRecord):
        """Digitize the design with its settings and the changes in effect; store the DST, preview
        and report (so Download matches), and the stats on the record. Returns
        (record, result, stitches, width, spacing). The fill density set on the preview screen is
        passed on as set by hand, so it wins over a fabric preset's."""
        width = record_width(record)
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / f"original.{record.type}"
            source.write_bytes(designs.get_file(record.id, f"original.{record.type}"))
            out = Path(tmp) / "out"
            try:
                result = digitize(source, out, config, width, record.settings.colours, applied(record),
                                  fill_row_spacing_mm=record.settings.fill_row_spacing_mm)
            except ValueError as exc:
                raise HTTPException(422, f"This image could not be digitized ({exc}). Use a logo on a plain "
                                         "background, or a transparent PNG.") from None
            available, _unavailable = offered_formats(config)
            for fmt in available:  # every offered format, from the same stitches (checked by a round trip)
                if fmt != "dst":
                    write_format(out / "out.dst", out / f"out.{fmt}", fmt)
            for name in ("preview.png", "report.json", *(f"out.{fmt}" for fmt in available)):
                designs.put_file(record.id, name, (out / name).read_bytes())
            layers_iter = iter(result.stitch_layers)
            stitches = [StitchPoint(x_mm=x, y_mm=y, command=c, layer=next(layers_iter) if c == "stitch" else None)
                        for x, y, c in records(out / "out.dst")]
        record = record.model_copy(update={"status": "digitized", "stats": StitchStats(**vars(result.stats)),
                                           "report": DigitizeReport(**result.to_json()), "downloads": available})
        designs.save(record)
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
    def preview(design_id: DesignId, designs: Designs = Depends(my_designs),
                body: PreviewRequest | None = None) -> PreviewResponse:
        """Digitize with the design's settings (optionally changed here) and every editor change
        in effect. Stores the DST for download."""
        record = load_record(designs, design_id)
        if body is not None:
            check_settings(body, record)
            changes = body.model_dump(exclude_none=True)
            if "colours" in changes:
                changes["colours"] = [c.upper() for c in changes["colours"]]
            record = record.model_copy(update={"settings": record.settings.model_copy(update=changes)})
        check_sync_size(record, "digitized")
        record, result, stitches, width, spacing = sew(designs, record)
        layers, colours = layers_and_colours(result)
        return PreviewResponse(id=design_id, stats=record.stats, report=record.report,
                               settings_used=SettingsUsed(width_mm=width, fill_row_spacing_mm=spacing),
                               colours=colours, overlaps=list(result.overlaps), layers=layers,
                               warnings=record.warnings, stitches=stitches)

    @app.get("/designs/{design_id}/shapes", response_model=DesignShapes, responses=ERRORS)
    def shapes(design_id: DesignId, designs: Designs = Depends(my_designs)) -> DesignShapes:
        """The design's shapes in mm (same coordinates as the DST) for the editor canvas and
        Layers list, with the editor's changes in effect."""
        record = load_record(designs, design_id)
        check_sync_size(record, "opened in the editor")
        width = record_width(record)
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / f"original.{record.type}"
            source.write_bytes(designs.get_file(design_id, f"original.{record.type}"))
            try:
                found = design_shapes(source, config, width, record.settings.colours, applied(record))
            except ValueError as exc:
                raise HTTPException(422, f"No shapes could be traced from this image ({exc}). Use a logo on a plain "
                                         "background, or a transparent PNG.") from None
        return DesignShapes(id=design_id, **found)

    # ---------- editor: changes, undo, redo ----------

    def editor_state(designs: Designs, record: DesignRecord) -> EditorState:
        record, result, stitches, _width, _spacing = sew(designs, record)
        layers, colours = layers_and_colours(result)
        n, total = record.edits_applied, len(record.edits)
        history = History(applied=n, total=total, undo=edit_label(record.edits[n - 1]) if n else None,
                          redo=edit_label(record.edits[n]) if n < total else None)
        defaults = EditorDefaults(
            pull_compensation_mm=result.pull_compensation_mm,
            pull_compensation_min_mm=config.get("api.pull_compensation_min_mm"),
            pull_compensation_max_mm=config.get("api.pull_compensation_max_mm"),
            fill_row_spacing_mm=result.fill_row_spacing_mm,
            fill_row_spacing_min_mm=config.get("api.fill_row_spacing_min_mm"),
            fill_row_spacing_max_mm=config.get("api.fill_row_spacing_max_mm"),
            satin_spacing_mm=result.satin_spacing_mm,
            satin_spacing_min_mm=config.get("api.satin_spacing_min_mm"),
            satin_spacing_max_mm=config.get("api.satin_spacing_max_mm"),
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
    def get_editor(design_id: DesignId, designs: Designs = Depends(my_designs)) -> EditorState:
        """The editor's view of the design: shapes, satin columns and every stitch, from one run
        of the digitizer with the changes in effect (which also refreshes the DST for download)."""
        record = load_record(designs, design_id)
        check_sync_size(record, "opened in the editor")
        return editor_state(designs, record)

    def check_density(traced, number: int, mm: float) -> None:
        """The density slider's range from config.py: fill row spacing or satin spacing."""
        shape = next((s for s in traced.shapes if s.number == number), None)
        if shape is None or shape.kind == "running":
            return  # the engine explains these
        which = "fill_row_spacing" if shape.kind == "fill" else "satin_spacing"
        lo, hi = config.get(f"api.{which}_min_mm"), config.get(f"api.{which}_max_mm")
        if not lo <= mm <= hi:
            raise HTTPException(422, f"Density for {'fill' if shape.kind == 'fill' else 'satin'} must be between "
                                     f"{lo:g} and {hi:g} mm.")

    @app.post("/designs/{design_id}/edits", response_model=EditorState, responses=ERRORS)
    @one_at_a_time
    def add_edit(design_id: DesignId, body: Annotated[EditRequest, Body()],
                 designs: Designs = Depends(my_designs)) -> EditorState:
        """Make one change (stitch type, pull compensation, split, satin column from two edges).
        It is checked against the design as it is now; a change that cannot be made is refused
        with a plain message and nothing is stored. Changes that could be redone are dropped."""
        record = load_record(designs, design_id)
        check_sync_size(record, "edited")
        if body.op == "set_pull_compensation" and body.mm is not None:
            lo, hi = config.get("api.pull_compensation_min_mm"), config.get("api.pull_compensation_max_mm")
            if not lo <= body.mm <= hi:
                raise HTTPException(422, f"Pull compensation must be between {lo:g} and {hi:g} mm.")
        width = record_width(record)
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / f"original.{record.type}"
            source.write_bytes(designs.get_file(design_id, f"original.{record.type}"))
            try:
                traced = trace_design(source, config, width, record.settings.colours, edits=applied(record))
                if body.op == "set_density" and body.mm is not None:
                    check_density(traced, body.shape, body.mm)
                stored = to_pixels(body.model_dump(), traced)
                apply_edit(traced, stored, config)
            except EditError as exc:
                raise HTTPException(422, str(exc)) from None
            except ValueError as exc:
                raise HTTPException(422, f"This image could not be digitized ({exc}).") from None
        edits = applied(record) + [stored]
        return editor_state(designs, record.model_copy(update={"edits": edits, "edits_applied": len(edits)}))

    @app.post("/designs/{design_id}/edits/undo", response_model=EditorState, responses=ERRORS)
    @one_at_a_time
    def undo(design_id: DesignId, designs: Designs = Depends(my_designs)) -> EditorState:
        record = load_record(designs, design_id)
        if record.edits_applied == 0:
            raise HTTPException(409, "There is nothing to undo.")
        check_sync_size(record, "edited")
        return editor_state(designs, record.model_copy(update={"edits_applied": record.edits_applied - 1}))

    @app.post("/designs/{design_id}/edits/redo", response_model=EditorState, responses=ERRORS)
    @one_at_a_time
    def redo(design_id: DesignId, designs: Designs = Depends(my_designs)) -> EditorState:
        record = load_record(designs, design_id)
        if record.edits_applied >= len(record.edits):
            raise HTTPException(409, "There is nothing to redo.")
        check_sync_size(record, "edited")
        return editor_state(designs, record.model_copy(update={"edits_applied": record.edits_applied + 1}))

    @app.get("/designs", response_model=list[DesignSummary], responses=ERRORS)
    def list_designs(designs: Designs = Depends(my_designs)) -> list[DesignSummary]:
        """The signed-in user's designs, newest first ("My designs"). Never anyone else's."""
        return [DesignSummary(id=r.id, filename=r.filename, type=r.type, status=r.status, created_at=r.created_at,
                              colour_count=len(r.colours), stitch_count=r.stats.stitch_count if r.stats else None,
                              width_mm=r.stats.width_mm if r.stats else None,
                              height_mm=r.stats.height_mm if r.stats else None)
                for r in designs.list()]

    @app.get("/designs/{design_id}", response_model=DesignRecord, responses=ERRORS)
    def get_design(design_id: DesignId, designs: Designs = Depends(my_designs)) -> DesignRecord:
        return load_record(designs, design_id)

    def machine_file(record: DesignRecord, fmt: str) -> str:
        """The download file name for an offered format the design has; plain 422/409 otherwise."""
        available, unavailable = offered_formats(config)
        if fmt not in available:
            reason = unavailable.get(fmt, f"{fmt!r} is not a machine file format this app writes.")
            raise HTTPException(422, f"{reason} Choose one of: {', '.join(f.upper() for f in available)}.")
        if fmt not in record.downloads:
            raise HTTPException(409, f"This design has no stitch file yet. Run POST /designs/{record.id}/preview "
                                     "first, then download.")
        stem = re.sub(r"[^A-Za-z0-9._-]", "_", Path(record.filename).stem) or "design"
        return f"{stem}.{fmt}"

    @app.get("/designs/{design_id}/download", responses={200: {"content": {"application/octet-stream": {}}}, **ERRORS})
    def download(design_id: DesignId, query: Annotated[DownloadQuery, Query()], designs: Designs = Depends(my_designs)) -> Response:
        record = load_record(designs, design_id)
        filename = machine_file(record, query.format)
        data = designs.get_file(design_id, f"out.{query.format}")
        return Response(data, media_type="application/octet-stream",
                        headers={"Content-Disposition": f'attachment; filename="{filename}"'})

    @app.get("/designs/{design_id}/download-url", response_model=DownloadLink, responses=ERRORS)
    def download_url(design_id: DesignId, query: Annotated[DownloadQuery, Query()], designs: Designs = Depends(my_designs)) -> DownloadLink:
        """A short-lived signed link to the machine file in private Storage (storage.signed_url_ttl_s
        in config.py). Local mode has no signed links and points at /download instead."""
        record = load_record(designs, design_id)
        filename = machine_file(record, query.format)
        ttl = config.get("storage.signed_url_ttl_s")
        try:
            url = designs.signed_url(design_id, f"out.{query.format}", ttl, filename)
        except NotFound:
            raise HTTPException(409, f"This design has no stitch file yet. Run POST /designs/{design_id}/preview "
                                     "first, then download.") from None
        if url is None:
            return DownloadLink(url=f"/designs/{design_id}/download?format={query.format}", filename=filename,
                                expires_in_s=None, signed=False)
        return DownloadLink(url=url, filename=filename, expires_in_s=ttl, signed=True)

    # ---------- background jobs ----------
    QUEUE_DOWN = "Background jobs are not running, so satin columns cannot be traced right now."

    JOB_GONE = "This job no longer exists. Start it again from the editor."

    def job_state(designs: Designs, job_id: str) -> JobOut:
        """The user's own job (404 for anyone else's): its last stored state once it has ended,
        else its state in Redis now. An ended job is stored, so it is still shown after Redis
        has expired it."""
        stored = designs.get_job(job_id)
        if stored is None:
            raise HTTPException(404, JOB_GONE)
        if stored.status in TERMINAL:
            return stored.model_copy(update={"server_time": datetime.now(timezone.utc)})
        try:
            live = jobs.state(job_id)
        except JobNotFound:
            raise HTTPException(404, JOB_GONE) from None
        except QueueUnavailable:
            raise HTTPException(503, QUEUE_DOWN) from None
        if live.status in TERMINAL:
            designs.save_job(live)
        return live

    @app.post("/designs/{design_id}/trace", response_model=JobOut, status_code=202, responses=ERRORS)
    def start_trace(design_id: DesignId, designs: Designs = Depends(my_designs)) -> JobOut:
        """Start "Create satin columns" in the background. If one is already queued or running
        for this design, that job is returned instead of starting a second."""
        record = load_record(designs, design_id)
        if record.type == "svg":
            raise HTTPException(422, "SVG files cannot be traced. Export the logo as PNG or JPG and upload that instead.")
        if record.trace_job_id:
            try:
                current = job_state(designs, record.trace_job_id)
                if current.status in ("queued", "running"):
                    return current
            except HTTPException:
                pass
        image = designs.get_file(design_id, f"original.{record.type}")
        try:
            started = jobs.start_trace(
                design_id, image, record.type, record.settings.width_mm, dict(config.overrides), record.settings.colours,
                applied(record),
                timeout_s=config.get("jobs.job_timeout_s"), ttl_s=config.get("jobs.result_ttl_s"),
                retries=config.get("jobs.max_retries"),
            )
        except QueueUnavailable:
            raise HTTPException(503, QUEUE_DOWN) from None
        designs.add_job(started)
        designs.save(record.model_copy(update={"trace_job_id": started.id}))
        return started

    # Registered before /jobs/{job_id} so "health" is not taken for a job id.
    @app.get("/jobs/health", response_model=JobsHealth, responses=ERRORS)
    def jobs_health(_user: User = Depends(current_user)) -> JobsHealth:
        """Whether background jobs can run: 503 with a plain message if Redis can't be reached."""
        try:
            return JobsHealth(status="ok", workers=jobs.health())
        except QueueUnavailable:
            raise HTTPException(503, QUEUE_DOWN) from None

    @app.get("/jobs/{job_id}", response_model=JobOut, responses=ERRORS)
    def get_job(job_id: JobId, designs: Designs = Depends(my_designs)) -> JobOut:
        return job_state(designs, job_id)

    @app.post("/jobs/{job_id}/cancel", response_model=JobOut, responses=ERRORS)
    def cancel_job(job_id: JobId, designs: Designs = Depends(my_designs)) -> JobOut:
        current = job_state(designs, job_id)  # 404 unless it is the user's own job
        try:
            out = jobs.cancel(job_id, current)
            if out.status in TERMINAL:
                designs.save_job(out)
            return out
        except AlreadyFinished as exc:
            raise HTTPException(409, f"This job has already ended ({exc}); there is nothing to cancel.") from None
        except JobNotFound:
            raise HTTPException(404, "This job no longer exists. Start it again from the editor.") from None
        except QueueUnavailable:
            raise HTTPException(503, QUEUE_DOWN) from None

    return app


app = create_app()
