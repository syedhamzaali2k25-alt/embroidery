"""Environment settings for the API (connection strings, paths and switches only).

Product numbers (limits, timeouts, rate limits) are not here: they live in
digitizer/src/digitizer/config.py and are read through digitizer.config.
"""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    redis_url: str
    rq_queue: str
    cors_origin: str | None
    storage_dir: str
    test_run_values: bool
    log_level: str


def load_settings() -> Settings:
    origin = os.environ.get("CORS_ORIGIN", "").strip() or None
    if origin == "*":
        raise ValueError("CORS_ORIGIN must be one exact origin such as http://localhost:8080, not '*'")
    return Settings(
        redis_url=os.environ.get("REDIS_URL", "redis://localhost:6379/0"),
        rq_queue=os.environ.get("RQ_QUEUE", "digitize"),
        cors_origin=origin,
        storage_dir=os.environ.get("STORAGE_DIR", "data/storage"),
        test_run_values=os.environ.get("STITCHBOOK_TEST_RUN_VALUES", "") == "1",
        log_level=os.environ.get("LOG_LEVEL", "info"),
    )
