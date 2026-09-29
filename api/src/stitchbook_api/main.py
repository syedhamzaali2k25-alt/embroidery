"""FastAPI application. No endpoints beyond health yet."""

from __future__ import annotations

from digitizer import load_config
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from stitchbook_api.settings import load_settings

config = load_config()
settings = load_settings()

app = FastAPI(title=f"{config.app_name} API")
if settings.cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["*"],
        allow_headers=["*"],
    )


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "app": config.app_name}
