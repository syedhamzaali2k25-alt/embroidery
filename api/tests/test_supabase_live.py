"""Isolation tests against the REAL Supabase project: user A's design must not be visible to user B
anywhere (list, get, edits, undo/redo, trace, download, Storage, direct REST), and nothing works
without a token.

Needs SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY and SUPABASE_SECRET_KEY, from the environment or the
repo's .env (values are never printed). Skipped with a message when they are missing. Two real
users (A and B, random @example.com addresses, confirmed by the admin API) are made for the run
and deleted afterwards, with their files.

Run the migrations first (docs/supabase-setup.md). Then:  .venv/bin/pytest api/tests/test_supabase_live.py -v
"""

from __future__ import annotations

import json
import os
import secrets
import uuid
from pathlib import Path

import httpx
import pytest
from digitizer.config import load_test_run_config
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

from stitchbook_api.main import create_app
from stitchbook_api.records import as_uuid
from stitchbook_api.settings import Settings
from stitchbook_api.storage import LocalDiskStorage

ROOT = Path(__file__).resolve().parents[2]
SAMPLES = ROOT / "digitizer" / "samples"
NAMES = ("SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY")
PUBLIC = {"/health", "/site", "/formats", "/config"}


def _env() -> dict[str, str]:
    values = {}
    env_file = ROOT / ".env"
    if env_file.is_file():
        for line in env_file.read_text().splitlines():
            key, sep, value = line.partition("=")
            if sep and key.strip() in NAMES:
                values[key.strip()] = value.strip().strip("'\"")
    for name in NAMES:
        if os.environ.get(name, "").strip():
            values[name] = os.environ[name].strip()
    return values


ENV = _env()
MISSING = [n for n in NAMES if not ENV.get(n)]
pytestmark = pytest.mark.skipif(
    bool(MISSING),
    reason=f"live Supabase tests skipped: {', '.join(MISSING)} not set (environment or .env). "
           "They create two real users on the project, so they only run with all three keys.",
)

URL = ENV.get("SUPABASE_URL", "").rstrip("/")
PUBLISHABLE = ENV.get("SUPABASE_PUBLISHABLE_KEY", "")
SECRET = ENV.get("SUPABASE_SECRET_KEY", "")


def admin_headers() -> dict:
    # The secret key: test setup and teardown only (making and deleting the two users and their
    # files). The API under test never sees it.
    return {"apikey": SECRET, "Authorization": f"Bearer {SECRET}"}


def user_headers(token: str) -> dict:
    return {"apikey": PUBLISHABLE, "Authorization": f"Bearer {token}"}


class Person:
    def __init__(self, http: httpx.Client, label: str):
        self.email = f"stitchbook-test-{label}-{secrets.token_hex(6)}@example.com"
        password = secrets.token_urlsafe(24)
        made = http.post(f"{URL}/auth/v1/admin/users", headers=admin_headers(),
                         json={"email": self.email, "password": password, "email_confirm": True})
        assert made.status_code in (200, 201), f"could not create test user {label}: HTTP {made.status_code}"
        self.id = made.json()["id"]
        signed_in = http.post(f"{URL}/auth/v1/token", params={"grant_type": "password"},
                              headers={"apikey": PUBLISHABLE}, json={"email": self.email, "password": password})
        assert signed_in.status_code == 200, f"test user {label} could not sign in: HTTP {signed_in.status_code}"
        self.token = signed_in.json()["access_token"]

    @property
    def auth(self) -> dict:
        return {"Authorization": f"Bearer {self.token}"}


def _objects(http: httpx.Client, bucket: str, prefix: str) -> list[str]:
    """Every object path under prefix (Storage lists one folder level at a time)."""
    listed = http.post(f"{URL}/storage/v1/object/list/{bucket}", headers=admin_headers(),
                       json={"prefix": prefix, "limit": 1000})
    if listed.status_code != 200:
        return []
    paths = []
    for item in listed.json():
        path = f"{prefix}/{item['name']}"
        paths.extend(_objects(http, bucket, path) if item.get("id") is None else [path])
    return paths


def _delete(http: httpx.Client, person: Person) -> None:
    for bucket in ("uploads", "exports"):
        paths = _objects(http, bucket, person.id)
        if paths:
            http.request("DELETE", f"{URL}/storage/v1/object/{bucket}", headers=admin_headers(), json={"prefixes": paths})
    http.delete(f"{URL}/auth/v1/admin/users/{person.id}", headers=admin_headers())


@pytest.fixture(scope="module")
def live(tmp_path_factory):
    http = httpx.Client(timeout=30)
    try:
        http.get(f"{URL}/auth/v1/health", headers={"apikey": PUBLISHABLE})
    except httpx.HTTPError as exc:
        pytest.fail(f"SUPABASE_URL is set but the project cannot be reached ({type(exc).__name__}). "
                    "This is a failure, not a skip: the keys say the live project should be tested.")
    people = []
    try:
        a, b = Person(http, "a"), Person(http, "b")
        people += [a, b]
        store = tmp_path_factory.mktemp("unused-local-store")
        settings = Settings("redis://127.0.0.1:1", "digitize", None, str(store), False, "info",
                            supabase_url=URL, supabase_publishable_key=PUBLISHABLE)
        client = TestClient(create_app(load_test_run_config(), LocalDiskStorage(store), settings))
        body = (SAMPLES / "two_colour.png").read_bytes()
        made = client.post("/designs", headers=a.auth, files={"file": ("two.png", body, "image/png")},
                           data={"settings": json.dumps({"width_mm": 40})})
        assert made.status_code == 201, made.text
        design_id = made.json()["id"]
        assert client.post(f"/designs/{design_id}/preview", headers=a.auth).status_code == 200
        # A job of A's, recorded as POST /designs/{id}/trace does (no Redis needed for B's 404s).
        job_id = uuid.uuid4().hex
        job = http.post(f"{URL}/rest/v1/jobs", headers={**user_headers(a.token), "Prefer": "return=minimal"},
                        json={"id": job_id, "owner_id": a.id, "design_id": as_uuid(design_id), "status": "done",
                              "snapshot": {"id": job_id, "design_id": design_id, "kind": "trace", "status": "done",
                                           "progress": 1, "created_at": None, "started_at": None,
                                           "finished_at": None, "server_time": "2026-10-01T00:00:00Z"}})
        assert job.status_code == 201, job.text
        yield {"http": http, "client": client, "a": a, "b": b, "design": design_id, "job": job_id}
    finally:
        for person in people:
            _delete(http, person)
        http.close()


def _routes(client: TestClient, design_id: str, job_id: str):
    for route in client.app.routes:
        if not isinstance(route, APIRoute) or route.path in PUBLIC:
            continue
        path = route.path.replace("{design_id}", design_id).replace("{job_id}", job_id)
        if path.endswith(("/download", "/download-url")):
            path += "?format=dst"
        for method in route.methods:
            body = {"op": "set_type", "shape": 1, "kind": "fill"} if path.endswith("/edits") else None
            yield method, path, body


def test_a_sees_their_design_and_b_does_not(live):
    client, a, b, design = live["client"], live["a"], live["b"], live["design"]
    assert design in [d["id"] for d in client.get("/designs", headers=a.auth).json()]
    assert design not in [d["id"] for d in client.get("/designs", headers=b.auth).json()]
    assert client.get(f"/designs/{design}", headers=a.auth).status_code == 200


def test_b_gets_404_for_as_design_on_every_endpoint(live):
    client, b = live["client"], live["b"]
    checked = []
    for method, path, body in _routes(client, live["design"], live["job"]):
        if path in ("/designs", "/jobs/health"):
            continue
        if method == "POST" and path == "/designs":
            continue
        response = client.request(method, path, json=body, headers=b.auth)
        assert response.status_code == 404, (method, path, response.status_code, response.text)
        checked.append(f"{method} {path.split('?')[0].replace(live['design'], '{A}').replace(live['job'], '{A job}')}")
    for needed in ("GET /designs/{A}", "POST /designs/{A}/edits", "POST /designs/{A}/edits/undo",
                   "POST /designs/{A}/edits/redo", "POST /designs/{A}/trace", "GET /designs/{A}/download",
                   "GET /designs/{A}/download-url", "GET /jobs/{A job}"):
        assert needed in checked, needed


def test_no_token_is_401_everywhere(live):
    client = live["client"]
    for method, path, body in _routes(client, live["design"], live["job"]):
        response = client.request(method, path, json=body)
        assert response.status_code == 401, (method, path, response.status_code)


def test_b_cannot_read_or_write_as_storage_paths_directly(live):
    http, a, b, design = live["http"], live["a"], live["b"], as_uuid(live["design"])
    own = http.get(f"{URL}/storage/v1/object/authenticated/exports/{a.id}/{design}/out.dst", headers=user_headers(a.token))
    assert own.status_code == 200 and own.content  # control: A can read A's file
    for bucket, name in (("exports", "out.dst"), ("uploads", "original.png")):
        path = f"{a.id}/{design}/{name}"
        read = http.get(f"{URL}/storage/v1/object/authenticated/{bucket}/{path}", headers=user_headers(b.token))
        assert read.status_code != 200, f"B read {bucket}/{path}"
        signed = http.post(f"{URL}/storage/v1/object/sign/{bucket}/{path}", headers=user_headers(b.token),
                           json={"expiresIn": 60})
        assert signed.status_code != 200, f"B got a signed link to {bucket}/{path}"
        public = http.get(f"{URL}/storage/v1/object/public/{bucket}/{path}")
        assert public.status_code != 200, f"{bucket} is public"
    listed = http.post(f"{URL}/storage/v1/object/list/exports", headers=user_headers(b.token), json={"prefix": a.id})
    assert listed.status_code != 200 or listed.json() == []
    write = http.post(f"{URL}/storage/v1/object/exports/{a.id}/{design}/planted.dst", headers=user_headers(b.token),
                      content=b"x")
    assert write.status_code >= 400, "B wrote into A's folder"


def test_signed_download_link_works_and_is_short_lived(live):
    client, http, a = live["client"], live["http"], live["a"]
    link = client.get(f"/designs/{live['design']}/download-url?format=dst", headers=a.auth).json()
    assert link["signed"] is True and link["expires_in_s"] == 60
    assert "/object/sign/" in link["url"] and "/object/public/" not in link["url"]
    got = http.get(link["url"])
    assert got.status_code == 200 and got.content


def test_rest_api_gives_nothing_without_login_and_nothing_of_as_to_b(live):
    http, b, design = live["http"], live["b"], as_uuid(live["design"])
    for table in ("designs", "jobs", "exports", "profiles"):
        anon = http.get(f"{URL}/rest/v1/{table}", params={"select": "*"}, headers={"apikey": PUBLISHABLE})
        assert anon.status_code != 200 or anon.json() == [], f"anon read {table}"
    as_b = http.get(f"{URL}/rest/v1/designs", params={"id": f"eq.{design}", "select": "id"}, headers=user_headers(b.token))
    assert as_b.status_code == 200 and as_b.json() == []
    changed = http.patch(f"{URL}/rest/v1/designs", params={"id": f"eq.{design}"},
                         headers={**user_headers(b.token), "Prefer": "return=representation"}, json={"filename": "taken.png"})
    assert changed.status_code in (200, 204) and (changed.status_code == 204 or changed.json() == [])
