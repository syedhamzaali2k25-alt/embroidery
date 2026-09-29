"""File storage behind one small interface, so Supabase Storage can replace local disk later."""

from __future__ import annotations

import re
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
    """Stores each key as a file under `root`."""

    def __init__(self, root: str | Path):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, key: str) -> Path:
        path = (self.root / check_key(key)).resolve()
        if self.root not in path.parents:
            raise ValueError(f"invalid storage key {key!r}")
        return path

    def put(self, key: str, data: bytes) -> None:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_bytes(data)
        tmp.replace(path)  # readers never see a half-written file

    def get(self, key: str) -> bytes:
        path = self._path(key)
        if not path.is_file():
            raise NotFound(key)
        return path.read_bytes()

    def exists(self, key: str) -> bool:
        return self._path(key).is_file()
