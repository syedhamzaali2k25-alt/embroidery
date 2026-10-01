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
    # and tests. Designs and files are always read and written as the signed-in user, so row level
    # security applies. repr=False keeps keys out of logs.
    supabase_url: str | None = None
    supabase_publishable_key: str | None = field(default=None, repr=False)
    # The secret key: used ONLY by the billing module (credits functions, webhooks).
    supabase_secret_key: str | None = field(default=None, repr=False)
    # "production" (STITCHBOOK_ENV): the API refuses to start unless sign-in and billing are fully
    # configured and free operations are off. Fail closed.
    environment: str = "development"
    # Local mode only: metered operations (exports) run free with no billing at all. Must be
    # switched on explicitly (STITCHBOOK_FREE_OPERATIONS=1); refused in production.
    free_operations: bool = False
    # Signing secret of the FakeProvider (tests and local development only).
    fake_provider_secret: str | None = field(default=None, repr=False)

    @property
    def supabase(self) -> bool:
        return bool(self.supabase_url and self.supabase_publishable_key)

    @property
    def production(self) -> bool:
        return self.environment == "production"

    def check_production(self) -> None:
        """Refuses to run a production API on anything but full sign-in and billing."""
        if not self.production:
            return
        problems = []
        if not self.supabase:
            problems.append("SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY are not set (local mode)")
        if not self.supabase_secret_key:
            problems.append("SUPABASE_SECRET_KEY is not set (billing cannot run)")
        if self.free_operations:
            problems.append("STITCHBOOK_FREE_OPERATIONS is on")
        if self.test_run_values:
            problems.append("STITCHBOOK_TEST_RUN_VALUES is on")
        if problems:
            raise RuntimeError("Refusing to start in production: " + "; ".join(problems) + ".")


def load_settings() -> Settings:
    """Reads the environment. An empty value counts as not set (so a copied .env.example with
    empty values runs on the defaults)."""
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
        redis_url=os.environ.get("REDIS_URL") or "redis://localhost:6379/0",
        rq_queue=os.environ.get("RQ_QUEUE") or "digitize",
        cors_origin=origin,
        storage_dir=os.environ.get("STORAGE_DIR") or "data/storage",
        test_run_values=os.environ.get("STITCHBOOK_TEST_RUN_VALUES", "") == "1",
        log_level=os.environ.get("LOG_LEVEL") or "info",
        trace_job=os.environ.get("STITCHBOOK_TRACE_JOB") or "stitchbook_worker.jobs.trace_design",
        supabase_url=supabase_url,
        supabase_publishable_key=publishable,
        supabase_secret_key=os.environ.get("SUPABASE_SECRET_KEY", "").strip() or None,
        environment=(os.environ.get("STITCHBOOK_ENV") or "development").strip().lower(),
        free_operations=os.environ.get("STITCHBOOK_FREE_OPERATIONS", "") == "1",
        fake_provider_secret=os.environ.get("STITCHBOOK_FAKE_PROVIDER_SECRET", "").strip() or None,
    )
