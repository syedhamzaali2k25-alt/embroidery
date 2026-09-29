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
from digitizer.digitize import digitize
from digitizer.readback import records
from fastapi import FastAPI, File, Form, HTTPException, Path as PathParam, Query, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import ValidationError

from stitchbook_api import uploads
from stitchbook_api.models import (
    DesignCreated,
    DesignRecord,
    DesignSettings,
    DigitizeReport,
    DownloadQuery,
    ErrorResponse,
    HealthResponse,
    PreviewResponse,
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

    def save_record(record: DesignRecord) -> None:
        storage.put(f"designs/{record.id}/design.json", record.model_dump_json(indent=2).encode())

    @app.get("/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        return HealthResponse(status="ok", app=config.app_name)

    @app.post("/designs", response_model=DesignCreated, status_code=201, responses=ERRORS)
    async def create_design(
        file: Annotated[UploadFile, File(description="Logo image: PNG, JPG or SVG")],
        settings_json: Annotated[str | None, Form(alias="settings", description="JSON, e.g. {\"width_mm\": 60}")] = None,
    ) -> DesignCreated:
        try:
            design_settings = DesignSettings.model_validate_json(settings_json or "{}")
        except ValidationError as exc:
            raise HTTPException(422, "settings: " + _plain_validation_message(exc)) from None
        # Read one byte past the limit so an oversized file is detected without reading it all.
        data = await file.read(config.get("input.max_upload_bytes") + 1)
        try:
            upload = uploads.inspect(data, config)
        except uploads.UploadRejected as exc:
            raise HTTPException(exc.status, exc.message) from None

        design_id = uuid.uuid4().hex
        storage.put(f"designs/{design_id}/original.{upload.type}", data)
        record = DesignRecord(
            id=design_id, filename=Path(file.filename or f"logo.{upload.type}").name, type=upload.type,
            bytes=len(data), width_px=upload.width_px, height_px=upload.height_px, settings=design_settings,
            warnings=_warnings(upload.warnings), status="uploaded", created_at=datetime.now(timezone.utc),
        )
        save_record(record)
        return DesignCreated(id=design_id, type=record.type, width_px=record.width_px, height_px=record.height_px,
                             warnings=record.warnings)

    @app.post("/designs/{design_id}/preview", response_model=PreviewResponse, responses=ERRORS)
    def preview(design_id: DesignId) -> PreviewResponse:
        record = load_record(design_id)
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
                result = digitize(source, out, config, record.settings.width_mm)
            except ValueError as exc:
                raise HTTPException(422, f"This image could not be digitized ({exc}). Use a dark logo on a "
                                         "plain light background, or a transparent PNG.") from None
            for name in ("out.dst", "preview.png", "report.json"):
                storage.put(f"designs/{design_id}/{name}", (out / name).read_bytes())
            stitches = [StitchPoint(x_mm=x, y_mm=y, command=c) for x, y, c in records(out / "out.dst")]
        stats = StitchStats(**vars(result.stats))
        report = DigitizeReport(**result.to_json())
        record = record.model_copy(update={"status": "digitized", "stats": stats, "report": report,
                                           "downloads": ["dst"]})
        save_record(record)
        return PreviewResponse(id=design_id, stats=stats, report=report, warnings=record.warnings, stitches=stitches)

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
