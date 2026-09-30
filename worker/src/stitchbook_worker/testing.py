"""Test-only job: the real trace, stretched over a few seconds so tests can see the queued and
running states and cancel a running job. Selected with STITCHBOOK_TRACE_JOB; never the default."""

from __future__ import annotations

import time
from typing import Any

from stitchbook_worker.jobs import _save_meta, trace_design

STEPS, STEP_S = 8, 0.5  # test fixture timing: about four seconds of "running"


def slow_trace_design(image: bytes, suffix: str, width_mm: float | None, overrides: dict[str, Any]) -> dict:
    for step in range(STEPS):
        _save_meta(progress=round(step / STEPS * 0.5, 3))
        time.sleep(STEP_S)
    return trace_design(image, suffix, width_mm, overrides)
