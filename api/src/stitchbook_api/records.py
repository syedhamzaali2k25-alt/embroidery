"""One user's designs: their records, files and background jobs.

Every request works through a `Designs` made for the verified user, so it can only ever see that
user's rows and files. Someone else's design is simply not there (the API answers 404).

LocalDesigns (offline, the default without Supabase settings) keeps everything in a Storage
under "{user_id}/...". SupabaseDesigns keeps records in the designs/jobs/exports tables and files
in SupabaseStorage, always as the signed-in user, so Supabase's row level security and Storage
policies check the owner again on every call (and the queries also filter by owner_id).
"""

from __future__ import annotations

import uuid
from typing import Protocol

import httpx

from stitchbook_api.models import DesignRecord, JobOut
from stitchbook_api.storage import NotFound, Storage, StorageUnavailable, SupabaseStorage


class DatabaseUnavailable(RuntimeError):
    """Supabase's database API could not be reached or refused the request."""


def as_uuid(hex_id: str) -> str:
    """API ids are 32 hex digits; the database and Storage paths use the dashed form."""
    return str(uuid.UUID(hex_id))


class Designs(Protocol):
    owner_id: str

    def get(self, design_id: str) -> DesignRecord | None: ...
    def create(self, record: DesignRecord) -> None: ...
    def save(self, record: DesignRecord) -> None: ...
    def list(self) -> list[DesignRecord]: ...
    def put_file(self, design_id: str, name: str, data: bytes) -> None: ...
    def get_file(self, design_id: str, name: str) -> bytes: ...  # raises NotFound
    def signed_url(self, design_id: str, name: str, expires_s: int, download_name: str) -> str | None: ...
    def add_job(self, job: JobOut) -> None: ...
    def get_job(self, job_id: str) -> JobOut | None: ...
    def save_job(self, job: JobOut) -> None: ...


def file_key(owner_id: str, design_id: str, name: str) -> str:
    """Where a design's file lives: {user_id}/{design_id}/{file}."""
    return f"{owner_id}/{as_uuid(design_id)}/{name}"


class LocalDesigns:
    """Records as JSON next to the files, all under the owner's folder of a Storage."""

    def __init__(self, storage: Storage, owner_id: str):
        self.storage = storage
        self.owner_id = owner_id

    def _record_key(self, design_id: str) -> str:
        return file_key(self.owner_id, design_id, "design.json")

    def get(self, design_id: str) -> DesignRecord | None:
        try:
            return DesignRecord.model_validate_json(self.storage.get(self._record_key(design_id)))
        except NotFound:
            return None

    def create(self, record: DesignRecord) -> None:
        self.save(record)

    def save(self, record: DesignRecord) -> None:
        self.storage.put(self._record_key(record.id), record.model_dump_json(indent=2).encode())

    def list(self) -> list[DesignRecord]:
        keys = self.storage.keys(self.owner_id) if hasattr(self.storage, "keys") else []
        found = []
        for key in keys:
            if key.endswith("/design.json"):
                try:
                    found.append(DesignRecord.model_validate_json(self.storage.get(key)))
                except NotFound:
                    continue
        return sorted(found, key=lambda r: r.created_at, reverse=True)

    def put_file(self, design_id: str, name: str, data: bytes) -> None:
        self.storage.put(file_key(self.owner_id, design_id, name), data)

    def get_file(self, design_id: str, name: str) -> bytes:
        return self.storage.get(file_key(self.owner_id, design_id, name))

    def signed_url(self, design_id: str, name: str, expires_s: int, download_name: str) -> str | None:
        return None  # local files are only served through the API's own download route

    def _job_key(self, job_id: str) -> str:
        return f"{self.owner_id}/jobs/{job_id}.json"

    def add_job(self, job: JobOut) -> None:
        self.save_job(job)

    def get_job(self, job_id: str) -> JobOut | None:
        try:
            return JobOut.model_validate_json(self.storage.get(self._job_key(job_id)))
        except NotFound:
            return None

    def save_job(self, job: JobOut) -> None:
        self.storage.put(self._job_key(job.id), job.model_dump_json().encode())


class SupabaseDesigns:
    """Records in Postgres through Supabase's REST API (PostgREST), files in SupabaseStorage, both
    with the user's own token and the publishable key: never the secret key."""

    def __init__(self, url: str, publishable_key: str, owner_id: str, token: str, timeout_s: float,
                 http: httpx.Client):
        self.owner_id = owner_id
        self.rest = f"{url.rstrip('/')}/rest/v1"
        self.headers = {"apikey": publishable_key, "Authorization": f"Bearer {token}"}
        self.timeout_s = timeout_s
        self.http = http
        self.files = SupabaseStorage(url, publishable_key, token, timeout_s, http)

    # ---------- database ----------
    def _call(self, method: str, table: str, params: dict | None = None, body=None,
              prefer: str | None = None) -> list[dict]:
        headers = dict(self.headers)
        if prefer:
            headers["Prefer"] = prefer
        try:
            response = self.http.request(method, f"{self.rest}/{table}", params=params, json=body,
                                         headers=headers, timeout=self.timeout_s)
        except httpx.HTTPError as exc:
            raise DatabaseUnavailable("the database could not be reached") from exc
        if response.status_code >= 300:
            raise DatabaseUnavailable(f"the database refused the request ({response.status_code})")
        return response.json() if response.content else []

    def _mine(self, **filters: str) -> dict:
        return {"owner_id": f"eq.{self.owner_id}", **filters}

    def get(self, design_id: str) -> DesignRecord | None:
        rows = self._call("GET", "designs", self._mine(id=f"eq.{as_uuid(design_id)}", select="record"))
        return DesignRecord.model_validate(rows[0]["record"]) if rows else None

    def _row(self, record: DesignRecord) -> dict:
        return {"filename": record.filename, "file_type": record.type, "status": record.status,
                "record": record.model_dump(mode="json")}

    def create(self, record: DesignRecord) -> None:
        self._call("POST", "designs", body={"id": as_uuid(record.id), "owner_id": self.owner_id, **self._row(record)},
                   prefer="return=minimal")

    def save(self, record: DesignRecord) -> None:
        rows = self._call("PATCH", "designs", self._mine(id=f"eq.{as_uuid(record.id)}"), self._row(record),
                          prefer="return=representation")
        if not rows:
            raise NotFound(record.id)

    def list(self) -> list[DesignRecord]:
        rows = self._call("GET", "designs", self._mine(select="record", order="created_at.desc"))
        return [DesignRecord.model_validate(r["record"]) for r in rows]

    # ---------- files ----------
    def put_file(self, design_id: str, name: str, data: bytes) -> None:
        key = file_key(self.owner_id, design_id, name)
        self.files.put(key, data)
        if name.startswith("out."):  # a machine file: listed in exports
            self._call("POST", "exports", {"on_conflict": "design_id,format"},
                       {"owner_id": self.owner_id, "design_id": as_uuid(design_id), "format": name[4:],
                        "storage_path": key, "bytes": len(data)},
                       prefer="resolution=merge-duplicates,return=minimal")

    def get_file(self, design_id: str, name: str) -> bytes:
        return self.files.get(file_key(self.owner_id, design_id, name))

    def signed_url(self, design_id: str, name: str, expires_s: int, download_name: str) -> str | None:
        return self.files.signed_url(file_key(self.owner_id, design_id, name), expires_s, download_name)

    # ---------- jobs ----------
    def _job_row(self, job: JobOut) -> dict:
        return {"status": job.status, "snapshot": job.model_dump(mode="json")}

    def add_job(self, job: JobOut) -> None:
        self._call("POST", "jobs", body={"id": job.id, "owner_id": self.owner_id, "design_id": as_uuid(job.design_id),
                                         "kind": job.kind, **self._job_row(job)}, prefer="return=minimal")

    def get_job(self, job_id: str) -> JobOut | None:
        rows = self._call("GET", "jobs", self._mine(id=f"eq.{job_id}", select="snapshot"))
        return JobOut.model_validate(rows[0]["snapshot"]) if rows and rows[0]["snapshot"] else None

    def save_job(self, job: JobOut) -> None:
        self._call("PATCH", "jobs", self._mine(id=f"eq.{job.id}"), self._job_row(job), prefer="return=minimal")


__all__ = ["DatabaseUnavailable", "Designs", "LocalDesigns", "NotFound", "StorageUnavailable", "SupabaseDesigns",
           "as_uuid", "file_key"]
