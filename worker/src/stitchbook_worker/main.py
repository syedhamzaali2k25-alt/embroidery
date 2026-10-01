"""Start an RQ worker on the digitize queue. Job functions live in stitchbook_worker.jobs."""

from __future__ import annotations

import logging
import os

from digitizer import load_config
from redis import Redis
from rq import Queue, Worker


def main() -> None:
    config = load_config()
    logging.basicConfig(level=(os.environ.get("LOG_LEVEL") or "info").upper())
    redis = Redis.from_url(os.environ.get("REDIS_URL") or "redis://localhost:6379/0")
    queue = Queue(os.environ.get("RQ_QUEUE") or "digitize", connection=redis)
    logging.getLogger(__name__).info("%s worker listening on %r", config.app_name, queue.name)
    Worker([queue], connection=redis).work()


if __name__ == "__main__":
    main()
