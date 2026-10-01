"""Sign-in and ownership, offline: the API checks Supabase-style tokens (ES256, made here with a
throwaway key and served from a stand-in JWKS) and keeps each user's designs, files and jobs
apart. Every route of the app is walked, so a new route without the check fails here.

The same rules against the real Supabase project are in test_supabase_live.py.
"""

from __future__ import annotations

import json
import time
import uuid
from pathlib import Path

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from digitizer.config import load_test_run_config
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

from stitchbook_api.auth import SupabaseAuth
from stitchbook_api.models import JobOut
from stitchbook_api.main import create_app
from stitchbook_api.records import LocalDesigns, as_uuid
from stitchbook_api.settings import Settings
from stitchbook_api.storage import LocalDiskStorage

SAMPLES = Path(__file__).resolve().parents[2] / "digitizer" / "samples"
CONFIG = load_test_run_config()
URL = "https://example-project.supabase.co"
ISSUER = f"{URL}/auth/v1"
KEY = ec.generate_private_key(ec.SECP256R1())
OTHER_KEY = ec.generate_private_key(ec.SECP256R1())  # not in the project's JWKS
KID = "test-key"
A, B = str(uuid.uuid4()), str(uuid.uuid4())
PUBLIC = {"/health", "/site", "/formats", "/config"}  # no user data: no sign-in needed


def jwks() -> dict:
    public = json.loads(jwt.algorithms.ECAlgorithm.to_jwk(KEY.public_key()))
    return {"keys": [{**public, "kid": KID, "alg": "ES256", "use": "sig"}]}


def token(sub: str | None = A, *, key=KEY, kid=KID, alg="ES256", **claims) -> str:
    body = {"sub": sub, "aud": "authenticated", "iss": ISSUER, "role": "authenticated",
            "exp": int(time.time()) + 600, "iat": int(time.time()), **claims}
    return jwt.encode({k: v for k, v in body.items() if v is not None}, key, algorithm=alg, headers={"kid": kid})


class FakeSupabaseAuth:
    """The two Auth endpoints the API calls: the JWKS, and /user for legacy HS256 tokens."""

    def __init__(self):
        self.jwks_calls = 0

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth/v1/.well-known/jwks.json":
            self.jwks_calls += 1
            return httpx.Response(200, json=jwks())
        if request.url.path == "/auth/v1/user":
            return httpx.Response(401, json={"msg": "invalid JWT"})  # no HS256 token is good here
        return httpx.Response(404)


@pytest.fixture
def setup(tmp_path):
    fake = FakeSupabaseAuth()
    http = httpx.Client(transport=httpx.MockTransport(fake))
    auth = SupabaseAuth(URL, "sb_publishable_test", timeout_s=lambda: 5, cache_s=lambda: 300, http=http)
    storage = LocalDiskStorage(tmp_path / "store")
    settings = Settings("redis://127.0.0.1:1", "digitize", None, str(tmp_path / "store"), False, "info")
    client = TestClient(create_app(CONFIG, storage, settings, auth=auth))
    return client, storage, fake


def as_user(user: str) -> dict:
    return {"Authorization": f"Bearer {token(user)}"}


def upload(client, user=A) -> str:
    body = (SAMPLES / "two_colour.png").read_bytes()
    response = client.post("/designs", headers=as_user(user), files={"file": ("two.png", body, "image/png")},
                           data={"settings": json.dumps({"width_mm": 40})})
    assert response.status_code == 201, response.text
    return response.json()["id"]


def user_routes(client, design_id: str, job_id: str):
    """(method, path, body) for every route that is not public, with A's ids filled in."""
    for route in client.app.routes:
        if not isinstance(route, APIRoute) or route.path in PUBLIC:
            continue
        path = route.path.replace("{design_id}", design_id).replace("{job_id}", job_id)
        for method in route.methods:
            body = {"op": "set_type", "shape": 1, "kind": "fill"} if path.endswith("/edits") else None
            if path.endswith(("/download", "/download-url")):
                path += "?format=dst"
            yield method, path, body


def call(client, method, path, body=None, headers=None):
    if method == "POST" and path == "/designs":
        return client.post(path, headers=headers,
                           files={"file": ("two.png", (SAMPLES / "two_colour.png").read_bytes(), "image/png")})
    return client.request(method, path, json=body, headers=headers or {})


def test_public_routes_need_no_sign_in(setup):
    client, _, _ = setup
    for path in PUBLIC:
        assert client.get(path).status_code == 200, path


def test_every_other_route_answers_401_without_a_good_token(setup):
    client, storage, _ = setup
    design_id = upload(client, A)
    job_id = uuid.uuid4().hex
    bad_tokens = {
        "none": None,
        "not a bearer": {"Authorization": token(A)},
        "garbage": {"Authorization": "Bearer not.a.jwt"},
        "expired": {"Authorization": f"Bearer {token(A, exp=int(time.time()) - 60)}"},
        "other signing key": {"Authorization": f"Bearer {token(A, key=OTHER_KEY)}"},
        "unknown key id": {"Authorization": f"Bearer {token(A, kid='rotated-away')}"},
        "other project": {"Authorization": f"Bearer {token(A, iss='https://other.supabase.co/auth/v1')}"},
        "wrong audience": {"Authorization": f"Bearer {token(A, aud='somewhere-else')}"},
        "anon role": {"Authorization": f"Bearer {token(None, role='anon')}"},
        "no user": {"Authorization": f"Bearer {token(None)}"},
        "legacy HS256 refused by Auth": {"Authorization": f"Bearer {token(A, key='x' * 32, alg='HS256')}"},
        "unsigned": {"Authorization": f"Bearer {token(A, key=None, alg='none')}"},
    }
    routes = list(user_routes(client, design_id, job_id))
    assert len(routes) >= 15, "the walk should see every design and job route"
    for name, headers in bad_tokens.items():
        for method, path, body in routes:
            response = call(client, method, path, body, headers)
            assert response.status_code == 401, (name, method, path, response.text)
            assert "error" in response.json()
    assert LocalDesigns(storage, A).get(design_id) is not None  # nothing above changed A's design


def test_user_b_never_sees_user_as_design_or_job(setup):
    client, storage, _ = setup
    design_id = upload(client, A)
    job = JobOut(id=uuid.uuid4().hex, design_id=design_id, kind="trace", status="queued", progress=None,
                 created_at=None, started_at=None, finished_at=None, server_time="2026-10-01T00:00:00Z")
    LocalDesigns(storage, A).add_job(job)  # as POST /designs/{id}/trace would (no Redis here)

    assert [d["id"] for d in client.get("/designs", headers=as_user(A)).json()] == [design_id]
    assert client.get("/designs", headers=as_user(B)).json() == []  # B's list does not contain it
    for method, path, body in user_routes(client, design_id, job.id):
        if path in ("/designs", "/jobs/health"):
            continue  # B's own list (checked above) and the queue health
        response = call(client, method, path, body, as_user(B))
        assert response.status_code == 404, (method, path, response.status_code, response.text)
    assert client.get(f"/jobs/{job.id}", headers=as_user(A)).status_code != 404  # A still has it


def test_the_owner_is_taken_from_the_token_never_from_the_request(setup):
    client, storage, _ = setup
    body = (SAMPLES / "two_colour.png").read_bytes()
    response = client.post("/designs", headers=as_user(A), files={"file": ("two.png", body, "image/png")},
                           data={"owner_id": B, "user_id": B, "settings": json.dumps({"width_mm": 40})})
    design_id = response.json()["id"]
    assert LocalDesigns(storage, A).get(design_id) is not None
    assert LocalDesigns(storage, B).get(design_id) is None
    assert client.get(f"/designs/{design_id}", headers=as_user(B)).status_code == 404


def test_files_are_stored_under_the_owners_folder(setup, tmp_path):
    client, _, _ = setup
    design_id = upload(client, A)
    assert client.post(f"/designs/{design_id}/preview", headers=as_user(A)).status_code == 200
    folder = tmp_path / "store" / A / as_uuid(design_id)
    assert {p.name for p in folder.iterdir()} >= {"original.png", "design.json", "out.dst", "preview.png"}
    assert not (tmp_path / "store" / B).exists()
    link = client.get(f"/designs/{design_id}/download-url?format=dst", headers=as_user(A)).json()
    assert link["signed"] is False and link["url"] == f"/designs/{design_id}/download?format=dst"  # local mode


def test_signing_keys_are_fetched_once_and_cached(setup):
    client, _, fake = setup
    for _ in range(3):
        assert client.get("/designs", headers=as_user(A)).status_code == 200
    assert fake.jwks_calls == 1


def test_401_says_how_to_sign_in(setup):
    client, _, _ = setup
    response = client.get("/designs")
    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"
    assert "Sign in" in response.json()["error"]
