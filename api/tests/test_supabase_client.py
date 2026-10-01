"""What the API sends to Supabase, offline: a stand-in for Supabase's REST and Storage APIs records
every request. Checks that each call carries the signed-in user's token and the publishable key
(never a secret key), filters by the owner, uses the private buckets and {user}/{design}/{file}
paths, and that download links are signed and short-lived. The real project: test_supabase_live.py.
"""

from __future__ import annotations

import json
import uuid

import httpx
import pytest

from stitchbook_api.models import DesignRecord, DesignSettings
from stitchbook_api.records import SupabaseDesigns, as_uuid
from stitchbook_api.storage import NotFound, SupabaseStorage

URL = "https://example-project.supabase.co"
PUBLISHABLE = "sb_publishable_test"
OWNER = str(uuid.uuid4())
TOKEN = "user-access-token"


class FakeSupabase:
    def __init__(self):
        self.requests: list[httpx.Request] = []
        self.rows: dict[str, dict] = {}
        self.objects: dict[str, bytes] = {}

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        if path.startswith("/rest/v1/designs"):
            if request.method == "POST":
                row = json.loads(request.content)
                self.rows[row["id"]] = row
                return httpx.Response(201)
            wanted = request.url.params.get("id", "").removeprefix("eq.")
            rows = [r for r in self.rows.values() if not wanted or r["id"] == wanted]
            if request.method == "PATCH":
                for r in rows:
                    r.update(json.loads(request.content))
            return httpx.Response(200, json=[{"record": r["record"]} for r in rows])
        if path.startswith("/rest/v1/exports"):
            return httpx.Response(201)
        if path.startswith("/storage/v1/object/sign/"):
            name = path.removeprefix("/storage/v1/object/sign/")
            if name not in self.objects:
                return httpx.Response(400, json={"statusCode": "404", "error": "not_found", "message": "Object not found"})
            return httpx.Response(200, json={"signedURL": f"/object/sign/{name}?token=signed"})
        if path.startswith("/storage/v1/object/authenticated/"):
            name = path.removeprefix("/storage/v1/object/authenticated/")
            if name not in self.objects:
                return httpx.Response(400, json={"statusCode": "404", "error": "not_found", "message": "Object not found"})
            return httpx.Response(200, content=self.objects[name])
        if path.startswith("/storage/v1/object/"):
            self.objects[path.removeprefix("/storage/v1/object/")] = request.content
            return httpx.Response(200, json={"Key": path})
        return httpx.Response(404)


@pytest.fixture
def fake():
    return FakeSupabase()


@pytest.fixture
def designs(fake):
    return SupabaseDesigns(URL, PUBLISHABLE, OWNER, TOKEN, 5, httpx.Client(transport=httpx.MockTransport(fake)))


def record() -> DesignRecord:
    return DesignRecord(id=uuid.uuid4().hex, filename="logo.png", type="png", bytes=10, width_px=10, height_px=10,
                        settings=DesignSettings(), warnings=[], status="uploaded",
                        created_at="2026-10-01T00:00:00Z")


def test_every_call_is_made_as_the_user_with_the_publishable_key(fake, designs):
    r = record()
    designs.create(r)
    designs.put_file(r.id, "original.png", b"png")
    designs.put_file(r.id, "out.dst", b"dst")
    designs.get(r.id)
    designs.list()
    designs.signed_url(r.id, "out.dst", 60, "logo.dst")
    assert fake.requests
    for request in fake.requests:
        assert request.headers["authorization"] == f"Bearer {TOKEN}"
        assert request.headers["apikey"] == PUBLISHABLE
        assert "sb_secret" not in str(request.headers) and "service_role" not in str(request.headers)


def test_queries_filter_by_owner_and_rows_carry_the_owner(fake, designs):
    r = record()
    designs.create(r)
    assert fake.rows[as_uuid(r.id)]["owner_id"] == OWNER
    designs.get(r.id)
    designs.list()
    designs.save(r)
    for request in fake.requests:
        if request.method in ("GET", "PATCH"):
            assert request.url.params["owner_id"] == f"eq.{OWNER}"


def test_files_go_to_the_private_buckets_under_user_and_design(fake, designs):
    r = record()
    designs.create(r)
    designs.put_file(r.id, "original.png", b"png")
    designs.put_file(r.id, "out.dst", b"dst")
    designs.put_file(r.id, "preview.png", b"preview")
    folder = f"{OWNER}/{as_uuid(r.id)}"
    assert set(fake.objects) == {f"uploads/{folder}/original.png", f"exports/{folder}/out.dst",
                                 f"exports/{folder}/preview.png"}
    assert designs.get_file(r.id, "out.dst") == b"dst"
    export = next(q for q in fake.requests if q.url.path == "/rest/v1/exports")
    assert json.loads(export.content)["storage_path"] == f"{folder}/out.dst"
    with pytest.raises(NotFound):
        designs.get_file(r.id, "out.pes")


def test_download_links_are_signed_and_expire(fake, designs):
    r = record()
    designs.put_file(r.id, "out.dst", b"dst")
    url = designs.signed_url(r.id, "out.dst", 60, "logo.dst")
    assert url.startswith(f"{URL}/storage/v1/object/sign/exports/{OWNER}/") and "token=" in url
    assert url.endswith("&download=logo.dst")
    sign = next(q for q in fake.requests if "/object/sign/" in q.url.path)
    assert json.loads(sign.content) == {"expiresIn": 60}
    assert "/object/public/" not in url
    with pytest.raises(NotFound):
        designs.signed_url(r.id, "out.pes", 60, "logo.pes")


def test_keys_cannot_leave_the_users_folder():
    storage = SupabaseStorage(URL, PUBLISHABLE, TOKEN, 5, httpx.Client(transport=httpx.MockTransport(FakeSupabase())))
    for bad in ("../x/original.png", f"{OWNER}/../other/out.dst", "/etc/passwd"):
        with pytest.raises(ValueError):
            storage.put(bad, b"x")


def test_billing_rpc_uses_the_secret_key_and_maps_insufficient_credits():
    """Only the billing module talks with the secret key; PostgREST's error for RAISE
    'insufficient_credits' becomes InsufficientCredits (the API's 402)."""
    from stitchbook_api.billing import InsufficientCredits, SupabaseRpc

    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path == "/rest/v1/rpc/reserve_credit":
            return httpx.Response(400, json={"code": "P0001", "message": "insufficient_credits",
                                             "details": '{"available": 4, "needed": 10}'})
        return httpx.Response(200, json=[{"bucket": "plan", "available": 4, "reserved": 0, "consumed": 6}])

    rpc = SupabaseRpc(URL, "sb_secret_test_value_123", lambda: 5, httpx.Client(transport=httpx.MockTransport(handler)))
    assert rpc.call("credit_balance", {"p_owner": OWNER})[0]["available"] == 4
    with pytest.raises(InsufficientCredits) as exc:
        rpc.call("reserve_credit", {"p_owner": OWNER, "p_job": "j", "p_amount": 10})
    assert (exc.value.available, exc.value.needed) == (4, 10)
    assert all(r.headers["apikey"] == "sb_secret_test_value_123" for r in seen)
