"""Background jobs (RQ) for the API: start a trace, read its state, cancel it.

The API only enqueues by function path (stitchbook_worker.jobs.trace_design by default); the
worker runs it and the digitizer does the work. Finished, failed and cancelled jobs are copied to
Storage so the editor can show them again after Redis has expired the job.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Callable

from redis import Redis
from redis.exceptions import RedisError
from rq import Queue, Retry, Worker
from rq.command import send_stop_job_command
from rq.exceptions import NoSuchJobError
from rq.job import Job, JobStatus

from stitchbook_api.models import JobOut, TraceResult
from stitchbook_api.storage import NotFound, Storage

_STATUS = {
    JobStatus.CREATED: "queued", JobStatus.QUEUED: "queued", JobStatus.DEFERRED: "queued",
    JobStatus.SCHEDULED: "queued", JobStatus.STARTED: "running", JobStatus.FINISHED: "done",
    JobStatus.FAILED: "failed", JobStatus.CANCELED: "cancelled", JobStatus.STOPPED: "cancelled",
}
TERMINAL = {"done", "failed", "cancelled"}
GENERIC_FAILURE = "Tracing failed on the server. Try again; if it keeps failing, upload the image again."


class QueueUnavailable(RuntimeError):
    """Redis (the job queue) cannot be reached."""


class JobNotFound(KeyError):
    pass


class AlreadyFinished(RuntimeError):
    pass


def _utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _now() -> datetime:
    return datetime.now(timezone.utc)


class Jobs:
    def __init__(self, redis_url: str, queue_name: str, trace_job: str, storage: Storage,
                 redis_timeout_s: Callable[[], float]):
        self.redis_url = redis_url
        self.queue_name = queue_name
        self.redis_timeout_s = redis_timeout_s  # read on first use, so an unchosen value only
        self._redis: Redis | None = None        # affects job endpoints, not the whole API
        self._queue: Queue | None = None
        self.trace_job = trace_job
        self.storage = storage

    @property
    def redis(self) -> Redis:
        if self._redis is None:
            # The timeouts make an unreachable Redis fail fast instead of hanging each request.
            timeout = self.redis_timeout_s()
            self._redis = Redis.from_url(self.redis_url, socket_connect_timeout=timeout, socket_timeout=timeout)
        return self._redis

    @property
    def queue(self) -> Queue:
        if self._queue is None:
            self._queue = Queue(self.queue_name, connection=self.redis)
        return self._queue

    # ---------- health ----------
    def health(self) -> int:
        """Number of workers on the queue. Raises QueueUnavailable if Redis can't be reached."""
        try:
            self.redis.ping()
            return Worker.count(queue=self.queue)
        except RedisError as exc:
            raise QueueUnavailable() from exc

    # ---------- start ----------
    def start_trace(self, design_id: str, image: bytes, suffix: str, width_mm: float | None,
                    overrides: dict[str, Any], colours: list[str] | None, edits: list[dict], timeout_s: int,
                    ttl_s: int, retries: int) -> JobOut:
        job_id = uuid.uuid4().hex
        try:
            self.queue.enqueue(
                self.trace_job, args=(image, suffix, width_mm, overrides, colours, edits), job_id=job_id,
                job_timeout=timeout_s, result_ttl=ttl_s, failure_ttl=ttl_s,
                retry=Retry(max=retries) if retries else None,
                meta={"design_id": design_id, "kind": "trace", "progress": None},
            )
        except RedisError as exc:
            raise QueueUnavailable() from exc
        return self.state(job_id)

    # ---------- read ----------
    def state(self, job_id: str) -> JobOut:
        snapshot = self._snapshot(job_id)
        if snapshot is not None:
            return snapshot.model_copy(update={"server_time": _now()})
        try:
            job = Job.fetch(job_id, connection=self.redis)
            status = _STATUS.get(job.get_status(refresh=True), "queued")
        except NoSuchJobError:
            raise JobNotFound(job_id) from None
        except RedisError as exc:
            raise QueueUnavailable() from exc
        meta = job.get_meta(refresh=True)
        result = None
        if status == "done":
            result = TraceResult(**job.return_value())
        out = JobOut(
            id=job.id, design_id=meta.get("design_id", ""), kind="trace", status=status,
            progress=1.0 if status == "done" else meta.get("progress"),
            created_at=_utc(job.created_at), started_at=_utc(job.started_at),
            finished_at=_utc(job.ended_at), server_time=_now(),
            cancel_requested=bool(meta.get("cancel_requested")) and status == "running",
            error=(meta.get("error") or GENERIC_FAILURE) if status == "failed" else None,
            result=result,
        )
        if status in TERMINAL:
            self.storage.put(f"jobs/{job_id}.json", out.model_dump_json().encode())
        return out

    def _snapshot(self, job_id: str) -> JobOut | None:
        try:
            return JobOut.model_validate_json(self.storage.get(f"jobs/{job_id}.json"))
        except NotFound:
            return None

    # ---------- cancel ----------
    def cancel(self, job_id: str) -> JobOut:
        current = self.state(job_id)
        if current.status in TERMINAL:
            raise AlreadyFinished(current.status)
        try:
            job = Job.fetch(job_id, connection=self.redis)
            if current.status == "queued":
                job.cancel()
            else:
                job.meta["cancel_requested"] = True
                job.save_meta()
                send_stop_job_command(self.redis, job_id)  # the worker stops the job; state follows
        except NoSuchJobError:
            raise JobNotFound(job_id) from None
        except RedisError as exc:
            raise QueueUnavailable() from exc
        return self.state(job_id)
