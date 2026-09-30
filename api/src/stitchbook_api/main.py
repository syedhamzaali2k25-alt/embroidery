"""Stitchbook HTTP API.

Endpoints: GET /health, POST /designs, POST /designs/{id}/preview, GET /designs/{id},
GET /designs/{id}/download?format=dst. Every error body is {"error": "<what to fix>"}.
Design records are JSON files in Storage for now (a database comes with Supabase later).
"""

from __future__ import annotations

import re
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated

from digitizer.config import Config, PlaceholderValueError, load_config, load_test_run_config
from digitizer.digitize import digitize, logo_bounds
from digitizer.readback import records
from fastapi import FastAPI, File, Form, HTTPException, Path as PathParam, Query, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import ValidationError

from stitchbook_api import uploads
from stitchbook_api.models import (
    ClientConfig,
    DesignCreated,
    DesignRecord,
    DesignSettings,
    DigitizeReport,
    DownloadQuery,
    ErrorResponse,
    HealthResponse,
    Layer,
    PreviewRequest,
    PreviewResponse,
    SettingsUsed,
    QualityWarningOut,
    StitchPoint,
    StitchStats,
)
from stitchbook_api.settings import Settings, load_settings
from stitchbook_api.storage import LocalDiskStorage, NotFound, Storage

DesignId = Annotated[str, PathParam(pattern=r"^[0-9a-f]{32}$", description="Design id from POST /designs")]
ERRORS = {code: {"model": ErrorResponse} for code in (404, 409, 413, 415, 422, 503)}


def _warnings(items) -> list[QualityWarningOut]:
    return [QualityWarningOut(code=w.code, message=w.message, value=w.value, threshold=w.threshold) for w in items]


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
    storage = storage or LocalDiskStorage(settings.storage_dir)

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

    def check_settings(s: DesignSettings) -> None:
        """Plain messages for values outside the limits in config.py."""
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
        )

    @app.post("/designs", response_model=DesignCreated, status_code=201, responses=ERRORS)
    async def create_design(
        file: Annotated[UploadFile, File(description="Logo image: PNG, JPG or SVG")],
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
        bounds = None
        if upload.type != "svg":
            with tempfile.TemporaryDirectory() as tmp:
                source = Path(tmp) / f"original.{upload.type}"
                source.write_bytes(data)
                bounds = logo_bounds(source, config.get("image.min_speck_area_px"))
        record = DesignRecord(
            id=design_id, filename=Path(file.filename or f"logo.{upload.type}").name, type=upload.type,
            bytes=len(data), width_px=upload.width_px, height_px=upload.height_px,
            logo_width_px=bounds[0] if bounds else None, logo_height_px=bounds[1] if bounds else None,
            settings=design_settings,
            warnings=_warnings(upload.warnings), status="uploaded", created_at=datetime.now(timezone.utc),
        )
        save_record(record)
        return DesignCreated(id=design_id, type=record.type, width_px=record.width_px, height_px=record.height_px,
                             logo_width_px=record.logo_width_px, logo_height_px=record.logo_height_px,
                             warnings=record.warnings)

    @app.post("/designs/{design_id}/preview", response_model=PreviewResponse, responses=ERRORS)
    def preview(design_id: DesignId, body: PreviewRequest | None = None) -> PreviewResponse:
        record = load_record(design_id)
        if body is not None:
            check_settings(body)
            changes = body.model_dump(exclude_none=True)
            record = record.model_copy(update={"settings": record.settings.model_copy(update=changes)})
        width = record.settings.width_mm or config.get("design.width_mm")
        spacing = record.settings.fill_row_spacing_mm or config.get("stitch.fill_row_spacing_mm")
        job_config = config.with_overrides({"stitch.fill_row_spacing_mm": spacing})
        if record.type == "svg":
            raise HTTPException(422, "SVG files can be uploaded but not digitized yet. Export the logo as PNG "
                                     "and upload that instead.")
        limit = config.get("api.sync_preview_max_side_px")
        if max(record.width_px or 0, record.height_px or 0) > limit:
            raise HTTPException(422, f"This image is larger than {limit} px on its long side, too big to digitize "
                                     f"while you wait. Resize it to at most {limit} px and upload again "
                                     "(background processing for large images is not built yet).")
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / f"original.{record.type}"
            source.write_bytes(storage.get(f"designs/{design_id}/original.{record.type}"))
            out = Path(tmp) / "out"
            try:
                result = digitize(source, out, job_config, width)
            except ValueError as exc:
                raise HTTPException(422, f"This image could not be digitized ({exc}). Use a dark logo on a "
                                         "plain light background, or a transparent PNG.") from None
            for name in ("out.dst", "preview.png", "report.json"):
                storage.put(f"designs/{design_id}/{name}", (out / name).read_bytes())
            layers_iter = iter(result.stitch_layers)
            stitches = [StitchPoint(x_mm=x, y_mm=y, command=c, layer=next(layers_iter) if c == "stitch" else None)
                        for x, y, c in records(out / "out.dst")]
        stats = StitchStats(**vars(result.stats))
        report = DigitizeReport(**result.to_json())
        record = record.model_copy(update={"status": "digitized", "stats": stats, "report": report,
                                           "downloads": ["dst"]})
        save_record(record)
        layers = [Layer(number=i, type=t, stitch_count=n) for i, (t, n) in enumerate(result.layers, start=1)]
        return PreviewResponse(id=design_id, stats=stats, report=report,
                               settings_used=SettingsUsed(width_mm=width, fill_row_spacing_mm=spacing),
                               layers=layers, warnings=record.warnings, stitches=stitches)

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

    return app


app = create_app()
