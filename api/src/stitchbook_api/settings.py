"""Environment settings for the API (connection strings and secrets only).

Product numbers (limits, timeouts, rate limits) are not here: they live in
config/stitchbook.toml and are read through digitizer.config.
"""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    redis_url: str
    rq_queue: str
    cors_origins: list[str]
    log_level: str


def load_settings() -> Settings:
    return Settings(
        redis_url=os.environ.get("REDIS_URL", "redis://localhost:6379/0"),
        rq_queue=os.environ.get("RQ_QUEUE", "digitize"),
        cors_origins=[o for o in os.environ.get("CORS_ORIGINS", "").split(",") if o],
        log_level=os.environ.get("LOG_LEVEL", "info"),
    )
