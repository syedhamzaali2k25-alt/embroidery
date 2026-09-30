"""File storage behind one small interface, so Supabase Storage can replace local disk later."""

from __future__ import annotations

import os
import re
import time
import uuid
from pathlib import Path
from typing import Protocol

_KEY = re.compile(r"^[A-Za-z0-9_-]+(\/[A-Za-z0-9_.-]+)*$")


class NotFound(KeyError):
    """No object is stored under this key."""


class Storage(Protocol):
    def put(self, key: str, data: bytes) -> None: ...
    def get(self, key: str) -> bytes: ...  # raises NotFound
    def exists(self, key: str) -> bool: ...


def check_key(key: str) -> str:
    """Keys look like "designs/<id>/out.dst": plain segments, no "..", no leading slash."""
    if not _KEY.match(key) or any(part in ("", ".", "..") for part in key.split("/")):
        raise ValueError(f"invalid storage key {key!r}")
    return key


class LocalDiskStorage:
    """Stores each key as a file under `root`.

    Each write goes to its own temporary file (a unique name, so two writes never share one)
    and is then moved over the target in one step, so readers never see half a file. On
    Windows that move fails with PermissionError (WinError 32) while another process (a virus
    scanner, the indexer, a viewer) has the target open; it is tried again up to
    replace_attempts times, replace_retry_s apart (storage.* in config.py). The defaults, one
    try and no wait, are for tests that build a storage directly.
    """

    def __init__(self, root: str | Path, replace_attempts: int = 1, replace_retry_s: float = 0.0):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.replace_attempts = max(1, replace_attempts)
        self.replace_retry_s = replace_retry_s

    def _path(self, key: str) -> Path:
        path = (self.root / check_key(key)).resolve()
        if self.root not in path.parents:
            raise ValueError(f"invalid storage key {key!r}")
        return path

    def put(self, key: str, data: bytes) -> None:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")  # one temp file per write
        tmp.write_bytes(data)
        try:
            for attempt in range(1, self.replace_attempts + 1):
                try:
                    os.replace(tmp, path)  # readers never see a half-written file
                    return
                except PermissionError:
                    if attempt == self.replace_attempts:
                        raise
                    time.sleep(self.replace_retry_s)
        finally:
            tmp.unlink(missing_ok=True)  # only left behind if every attempt failed

    def get(self, key: str) -> bytes:
        path = self._path(key)
        if not path.is_file():
            raise NotFound(key)
        return path.read_bytes()

    def exists(self, key: str) -> bool:
        return self._path(key).is_file()
