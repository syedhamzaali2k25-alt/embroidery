"""File storage behind one small interface: LocalDiskStorage (default, offline) or SupabaseStorage.

Design files are stored under "{user_id}/{design_id}/{file}" in both. SupabaseStorage acts as the
signed-in user (their token), so Storage's own policies also keep each user in their own folder.
"""

from __future__ import annotations

import os
import re
import time
import uuid
from pathlib import Path
from typing import Protocol
from urllib.parse import quote

import httpx

_KEY = re.compile(r"^[A-Za-z0-9_-]+(\/[A-Za-z0-9_.-]+)*$")


class NotFound(KeyError):
    """No object is stored under this key."""


class StorageUnavailable(RuntimeError):
    """The file store could not be reached or refused the request."""


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

    def keys(self, prefix: str) -> list[str]:
        """Every stored key that starts with `prefix` + "/" (temporary files left out)."""
        base = self._path(prefix)
        if not base.is_dir():
            return []
        return sorted(p.relative_to(self.root).as_posix() for p in base.rglob("*")
                      if p.is_file() and not p.name.endswith(".tmp"))


# Content type per file extension, for Storage's own checks (the uploads bucket accepts images only).
CONTENT_TYPES = {"png": "image/png", "jpg": "image/jpeg", "svg": "image/svg+xml", "json": "application/json"}


class SupabaseStorage:
    """Supabase Storage, private buckets only. A key "{user_id}/{design_id}/{file}" is stored at that
    same path in the "uploads" bucket for the original image and in "exports" for everything made
    from it (machine files, preview, report). Files are read back through the API or through a
    short-lived signed URL (signed_url); public URLs are never made."""

    def __init__(self, url: str, publishable_key: str, token: str, timeout_s: float, http: httpx.Client):
        self.base = f"{url.rstrip('/')}/storage/v1"
        self.headers = {"apikey": publishable_key, "Authorization": f"Bearer {token}"}
        self.timeout_s = timeout_s
        self.http = http

    @staticmethod
    def bucket(key: str) -> str:
        return "uploads" if key.rsplit("/", 1)[-1].startswith("original.") else "exports"

    def _object(self, key: str) -> str:
        return f"{self.bucket(key)}/{quote(check_key(key))}"

    def _send(self, method: str, path: str, **kwargs) -> httpx.Response:
        try:
            return self.http.request(method, f"{self.base}/{path}", timeout=self.timeout_s,
                                     headers={**self.headers, **kwargs.pop("headers", {})}, **kwargs)
        except httpx.HTTPError as exc:
            raise StorageUnavailable("Supabase Storage could not be reached") from exc

    @staticmethod
    def _missing(response: httpx.Response) -> bool:
        """Storage answers 404, or 400 with statusCode "404" / "not_found", for a file that does not
        exist and for one the user may not read (RLS hides it), alike."""
        if response.status_code == 404:
            return True
        if response.status_code == 400:
            try:
                body = response.json()
            except ValueError:
                return False
            return str(body.get("statusCode")) == "404" or body.get("error") == "not_found"
        return False

    def put(self, key: str, data: bytes) -> None:
        ext = key.rsplit(".", 1)[-1].lower()
        response = self._send("POST", f"object/{self._object(key)}", content=data,
                              headers={"x-upsert": "true",
                                       "Content-Type": CONTENT_TYPES.get(ext, "application/octet-stream")})
        if response.status_code >= 300:
            raise StorageUnavailable(f"Supabase Storage refused the upload ({response.status_code})")

    def get(self, key: str) -> bytes:
        response = self._send("GET", f"object/authenticated/{self._object(key)}")
        if self._missing(response):
            raise NotFound(key)
        if response.status_code != 200:
            raise StorageUnavailable(f"Supabase Storage refused the download ({response.status_code})")
        return response.content

    def exists(self, key: str) -> bool:
        response = self._send("HEAD", f"object/authenticated/{self._object(key)}")
        if response.status_code == 200:
            return True
        if response.status_code in (400, 404):
            return False
        raise StorageUnavailable(f"Supabase Storage refused the check ({response.status_code})")

    def signed_url(self, key: str, expires_s: int, download_name: str | None = None) -> str:
        """A link to one private file that works for `expires_s` seconds (storage.signed_url_ttl_s)."""
        response = self._send("POST", f"object/sign/{self._object(key)}", json={"expiresIn": int(expires_s)})
        if self._missing(response):
            raise NotFound(key)
        if response.status_code != 200:
            raise StorageUnavailable(f"Supabase Storage refused the signed link ({response.status_code})")
        signed = response.json().get("signedURL") or response.json().get("signedUrl")
        if not signed:
            raise StorageUnavailable("Supabase Storage returned no signed link")
        url = f"{self.base}{signed if signed.startswith('/') else '/' + signed}"
        if download_name:
            url += ("&" if "?" in url else "?") + "download=" + quote(download_name)
        return url
