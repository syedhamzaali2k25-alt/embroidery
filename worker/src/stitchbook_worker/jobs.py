"""Job functions run by the RQ worker. They call the digitizer; no stitch logic lives here."""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Any

from digitizer.config import Config, PlaceholderValueError
from digitizer.digitize import trace_columns
from rq import get_current_job


def _save_meta(**meta: Any) -> None:
    job = get_current_job()
    if job is not None:
        job.get_meta(refresh=True)  # keep what the API wrote meanwhile (e.g. cancel_requested)
        job.meta.update(meta)
        job.save_meta()


def trace_design(image: bytes, suffix: str, width_mm: float | None, overrides: dict[str, Any],
                 colours: list[str] | None = None) -> dict:
    """Trace a design's satin columns. Progress (0..1) goes to job.meta["progress"]; a failure a
    person can act on goes to job.meta["error"] in plain words before the job fails."""
    config = Config().with_overrides(overrides)
    try:
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / f"original.{suffix}"
            source.write_bytes(image)
            return trace_columns(source, config, width_mm, on_progress=lambda f: _save_meta(progress=round(f, 3)),
                                 keep_colours=colours)
    except PlaceholderValueError as exc:
        _save_meta(error=f"The server is not configured yet: {exc}.")
        raise
    except ValueError as exc:
        _save_meta(error=f"The logo could not be traced ({exc}). Use a logo on a plain background, "
                         "or a transparent PNG.")
        raise
