"""Environment settings for the API (connection strings, paths and switches only).

Product numbers (limits, timeouts, rate limits) are not here: they live in
digitizer/src/digitizer/config.py and are read through digitizer.config.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Settings:
    redis_url: str
    rq_queue: str
    cors_origin: str | None
    storage_dir: str
    test_run_values: bool
    log_level: str
    trace_job: str = "stitchbook_worker.jobs.trace_design"  # function the worker runs for a trace
    # Supabase (Auth, database, Storage). Both set = sign-in required on every user route and data
    # kept in Supabase; both empty = local mode (one local user, files on disk) for offline work
    # and tests. The API never needs the secret key: it acts as the signed-in user, so row level
    # security applies to every query it makes. repr=False keeps the key out of logs.
    supabase_url: str | None = None
    supabase_publishable_key: str | None = field(default=None, repr=False)

    @property
    def supabase(self) -> bool:
        return bool(self.supabase_url and self.supabase_publishable_key)


def load_settings() -> Settings:
    origin = os.environ.get("CORS_ORIGIN", "").strip() or None
    if origin == "*":
        raise ValueError("CORS_ORIGIN must be one exact origin such as http://localhost:8080, not '*'")
    supabase_url = os.environ.get("SUPABASE_URL", "").strip().rstrip("/") or None
    publishable = os.environ.get("SUPABASE_PUBLISHABLE_KEY", "").strip() or None
    if bool(supabase_url) != bool(publishable):
        missing = "SUPABASE_PUBLISHABLE_KEY" if supabase_url else "SUPABASE_URL"
        raise ValueError(f"Supabase is half configured: set {missing} too (or neither, for local mode)")
    if supabase_url and not supabase_url.startswith("https://") and "localhost" not in supabase_url \
            and "127.0.0.1" not in supabase_url:
        raise ValueError("SUPABASE_URL must start with https:// (http only for a local Supabase)")
    return Settings(
        redis_url=os.environ.get("REDIS_URL", "redis://localhost:6379/0"),
        rq_queue=os.environ.get("RQ_QUEUE", "digitize"),
        cors_origin=origin,
        storage_dir=os.environ.get("STORAGE_DIR", "data/storage"),
        test_run_values=os.environ.get("STITCHBOOK_TEST_RUN_VALUES", "") == "1",
        log_level=os.environ.get("LOG_LEVEL", "info"),
        trace_job=os.environ.get("STITCHBOOK_TRACE_JOB") or "stitchbook_worker.jobs.trace_design",
        supabase_url=supabase_url,
        supabase_publishable_key=publishable,
    )
