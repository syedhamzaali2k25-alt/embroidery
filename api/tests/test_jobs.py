"""Trace jobs end to end: real Redis, real RQ worker process, the API's job endpoints.

Covers every state (queued, running, done, failed, cancelled), cancelling while queued and while
running, and reading a finished job back after Redis has forgotten it.
"""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

import cv2
import numpy as np
import pytest
from digitizer.config import load_test_run_config
from fastapi.testclient import TestClient
from redis import Redis

from stitchbook_api.main import create_app
from stitchbook_api.settings import Settings
from stitchbook_api.storage import LocalDiskStorage

pytestmark = pytest.mark.skipif(shutil.which("redis-server") is None, reason="needs redis-server")

SAMPLES = Path(__file__).resolve().parents[2] / "digitizer" / "samples"
CONFIG = load_test_run_config()
REAL = "stitchbook_worker.jobs.trace_design"
SLOW = "stitchbook_worker.testing.slow_trace_design"


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def redis_url(tmp_path):
    port = free_port()
    proc = subprocess.Popen(["redis-server", "--port", str(port), "--save", "", "--appendonly", "no",
                             "--dir", str(tmp_path)], stdout=subprocess.DEVNULL)
    url = f"redis://127.0.0.1:{port}/0"
    for _ in range(100):
        try:
            Redis.from_url(url).ping()
            break
        except Exception:  # noqa: BLE001 - not up yet
            time.sleep(0.05)
    yield url
    proc.terminate()
    proc.wait()


@pytest.fixture
def start_worker(redis_url):
    procs = []

    def start():
        env = {**os.environ, "REDIS_URL": redis_url, "RQ_QUEUE": "digitize", "LOG_LEVEL": "warning"}
        procs.append(subprocess.Popen([sys.executable, "-m", "stitchbook_worker.main"], env=env))
    yield start
    for p in procs:
        p.terminate()
        p.wait()


def client_for(tmp_path, redis_url, trace_job=REAL) -> TestClient:
    settings = Settings(redis_url, "digitize", None, str(tmp_path / "store"), False, "info", trace_job)
    return TestClient(create_app(CONFIG, LocalDiskStorage(tmp_path / "store"), settings))


def upload(client, name="bold_r.png", width=18, data: bytes | None = None) -> str:
    body = data or (SAMPLES / name).read_bytes()
    response = client.post("/designs", files={"file": (name, body, "image/png")}, data={"settings": f'{{"width_mm": {width}}}'})
    assert response.status_code == 201, response.text
    return response.json()["id"]


def wait_for(client, job_id, statuses, timeout=30.0):
    end = time.time() + timeout
    while time.time() < end:
        job = client.get(f"/jobs/{job_id}").json()
        if job["status"] in statuses:
            return job
        time.sleep(0.1)
    raise AssertionError(f"job never reached {statuses}; last: {job}")


def test_trace_runs_to_done_and_survives_redis_forgetting_it(tmp_path, redis_url, start_worker):
    client = client_for(tmp_path, redis_url)
    design_id = upload(client)
    job = client.post(f"/designs/{design_id}/trace")
    assert job.status_code == 202 and job.json()["status"] == "queued"
    job_id = job.json()["id"]
    assert client.get(f"/designs/{design_id}").json()["trace_job_id"] == job_id
    start_worker()
    done = wait_for(client, job_id, {"done", "failed"})
    assert done["status"] == "done", done
    columns = done["result"]["columns"]
    assert [c["number"] for c in columns] == list(range(1, len(columns) + 1)) and len(columns) >= 3
    assert all(len(c["edit_points"]) >= 2 and len(c["left"]) == len(c["right"]) for c in columns)
    assert done["started_at"] and done["finished_at"] and done["progress"] == 1.0
    Redis.from_url(redis_url).flushall()  # job expired from Redis: the stored copy answers
    assert client.get(f"/jobs/{job_id}").json()["result"] == done["result"]


def test_cancel_while_queued(tmp_path, redis_url):
    client = client_for(tmp_path, redis_url)  # no worker: the job stays queued
    job_id = client.post(f"/designs/{upload(client)}/trace").json()["id"]
    assert client.get(f"/jobs/{job_id}").json()["status"] == "queued"
    cancelled = client.post(f"/jobs/{job_id}/cancel")
    assert cancelled.status_code == 200 and cancelled.json()["status"] == "cancelled"
    assert client.get(f"/jobs/{job_id}").json()["status"] == "cancelled"
    again = client.post(f"/jobs/{job_id}/cancel")
    assert again.status_code == 409 and "nothing to cancel" in again.json()["error"]


def test_cancel_while_running(tmp_path, redis_url, start_worker):
    client = client_for(tmp_path, redis_url, SLOW)
    job_id = client.post(f"/designs/{upload(client)}/trace").json()["id"]
    start_worker()
    running = wait_for(client, job_id, {"running"})
    assert running["started_at"] is not None
    assert client.post(f"/jobs/{job_id}/cancel").json()["status"] in ("running", "cancelled")
    cancelled = wait_for(client, job_id, {"cancelled", "done", "failed"}, timeout=15)
    assert cancelled["status"] == "cancelled", cancelled
    assert cancelled["result"] is None


def test_second_trace_while_one_is_active_returns_the_same_job(tmp_path, redis_url):
    client = client_for(tmp_path, redis_url)
    design_id = upload(client)
    first = client.post(f"/designs/{design_id}/trace").json()["id"]
    assert client.post(f"/designs/{design_id}/trace").json()["id"] == first


def test_failed_trace_gives_a_plain_message(tmp_path, redis_url, start_worker):
    client = client_for(tmp_path, redis_url)
    blank = cv2.imencode(".png", np.full((400, 400), 255, np.uint8))[1].tobytes()  # no logo at all
    job_id = client.post(f"/designs/{upload(client, 'blank.png', data=blank)}/trace").json()["id"]
    start_worker()
    failed = wait_for(client, job_id, {"failed", "done"})
    assert failed["status"] == "failed"
    assert failed["error"].startswith("The logo could not be traced") and "Traceback" not in failed["error"]


def test_queue_down_gives_a_plain_message(tmp_path):
    client = client_for(tmp_path, f"redis://127.0.0.1:{free_port()}/0")  # nothing listens there
    response = client.post(f"/designs/{upload(client)}/trace")
    assert response.status_code == 503 and "job queue can't be reached" in response.json()["error"]


def test_unknown_job(tmp_path, redis_url):
    response = client_for(tmp_path, redis_url).get("/jobs/" + "0" * 32)
    assert response.status_code == 404 and "Start it again from the editor" in response.json()["error"]
