"""Export history and Credit usage through the API (Step 13d), on the real migration 5 + 7 SQL:
billing as the service role, the history and usage AS THE USER (row level security), as in
Supabase mode. Free gets 403 plan_required; Pro gets its own rows only, newest first, paged.
"""

from __future__ import annotations

import json
import uuid

import httpx
import pytest
from fastapi.testclient import TestClient

from billing_pg import PgRpc, PgUserRpc, start_postgres
from stitchbook_api.auth import SupabaseAuth
from stitchbook_api.billing import Billing
from stitchbook_api.main import create_app
from stitchbook_api.payments import FakeProvider
from stitchbook_api.settings import Settings
from stitchbook_api.storage import LocalDiskStorage
from test_auth import URL, FakeSupabaseAuth
from test_billing_api import CONFIG, WEBHOOK_SECRET, auth, designed, new_user, signed

SMALL_PAGES = CONFIG.with_overrides({"billing.history_page_size": 2})


@pytest.fixture(scope="module")
def pg():
    db = start_postgres()
    try:
        yield db
    finally:
        db.stop()


def make(tmp_path, pg, config=SMALL_PAGES, usage=True):
    http = httpx.Client(transport=httpx.MockTransport(FakeSupabaseAuth()))
    sign_in = SupabaseAuth(URL, "sb_publishable_test", timeout_s=lambda: 5, cache_s=lambda: 300, http=http)
    settings = Settings("redis://127.0.0.1:1", "digitize", None, str(tmp_path / "store"), False, "info")
    fake = FakeProvider(WEBHOOK_SECRET)
    app = create_app(config, LocalDiskStorage(tmp_path / "store"), settings, auth=sign_in,
                     billing=Billing(PgRpc(pg), config), provider=fake,
                     usage_for=(lambda user: PgUserRpc(pg, user.id)) if usage else None)
    return TestClient(app, raise_server_exceptions=False), fake


def on_plan(client, fake, user, plan="pro"):
    raw, headers = signed(fake, {"id": f"evt_{uuid.uuid4().hex}", "plan": plan, "interval": "month", "status": "active",
                                 "subscription_id": f"sub_{uuid.uuid4().hex[:8]}", "metadata": {"user_id": user},
                                 "period_end": "2026-11-01T00:00:00+00:00"})
    assert client.post("/webhooks/billing", content=raw, headers=headers).json()["result"] == "applied"


def export(client, user, design):
    assert client.get(f"/designs/{design}/download?format=dst", headers=auth(user)).status_code == 200


def test_free_is_403_plan_required(tmp_path, pg):
    client, _ = make(tmp_path, pg)
    user = new_user(pg)
    for path in ("/exports", "/credits/usage"):
        response = client.get(path, headers=auth(user))
        assert response.status_code == 403 and response.json() == {"error": "plan_required", "plan": "pro"}, path
    assert client.get("/exports").status_code == 401
    assert client.get("/me/credits", headers=auth(user)).status_code == 200  # Free keeps its balance


def test_pro_sees_its_exports_newest_first_and_paged(tmp_path, pg):
    client, fake = make(tmp_path, pg)
    user = new_user(pg)
    on_plan(client, fake, user)
    design = designed(client, pg, user)
    pg.sql(f"insert into public.exports (owner_id, design_id, format, storage_path, bytes) values "
           f"('{user}', '{uuid.UUID(design)}', 'dst', '{user}/{uuid.UUID(design)}/out.dst', 4321)")
    for _ in range(3):
        export(client, user, design)
    first = client.get("/exports", headers=auth(user)).json()
    assert first["enabled"] and first["page"] == 1 and first["page_size"] == 2 and first["has_more"] is True
    row = first["items"][0]
    assert row == {**row, "design_id": design, "design_name": "two.png", "format": "dst", "bytes": 4321, "credits": 10}
    second = client.get("/exports?page=2", headers=auth(user)).json()
    assert len(second["items"]) == 1 and second["has_more"] is False
    times = [r["finished_at"] for r in first["items"] + second["items"]]
    assert times == sorted(times, reverse=True)
    assert len({r["job_id"] for r in first["items"] + second["items"]}) == 3
    assert client.get("/exports?page=0", headers=auth(user)).status_code == 422


def test_another_users_rows_are_never_returned(tmp_path, pg):
    client, fake = make(tmp_path, pg)
    a, b = new_user(pg), new_user(pg)
    on_plan(client, fake, a)
    on_plan(client, fake, b, "business")
    export(client, a, designed(client, pg, a))
    assert len(client.get("/exports", headers=auth(a)).json()["items"]) == 1
    assert client.get("/exports", headers=auth(b)).json()["items"] == []
    b_usage = client.get("/credits/usage", headers=auth(b)).json()
    assert all(e["kind"] == "grant" for e in b_usage["entries"]["items"])  # none of A's spends
    assert b_usage["spent_this_month"] == 0
    # A query string or body naming A changes nothing: the token decides.
    assert client.get(f"/exports?user_id={a}&owner_id={a}", headers=auth(b)).json()["items"] == []


def test_credit_usage_shows_balance_renewal_spend_and_entries(tmp_path, pg):
    client, fake = make(tmp_path, pg)
    user = new_user(pg)
    on_plan(client, fake, user)
    usage = client.get("/credits/usage", headers=auth(user)).json()
    assert usage["available"] == 5030 and usage["balances"]["plan"]["available"] == 5030
    assert usage["renewal"] == {"date": usage["renewal"]["date"], "renews": True} and usage["renewal"]["date"].startswith("2026-11-01")
    assert usage["spent_this_month"] == 0
    assert sorted(e["reason"] for e in usage["entries"]["items"]) == ["free_grant", "plan_grant"]
    export(client, user, designed(client, pg, user))
    after = client.get("/credits/usage", headers=auth(user)).json()
    assert after["spent_this_month"] == 10 and after["available"] == 5020
    top = after["entries"]["items"][0]
    assert (top["kind"], top["reason"], top["amount"]) == ("spend", "export", -10)
    assert after["entries"]["has_more"] is True  # 3 entries, pages of 2
    assert len(client.get("/credits/usage?page=2", headers=auth(user)).json()["entries"]["items"]) == 1


def test_without_accounts_these_say_not_enabled(tmp_path, pg):
    client, _ = make(tmp_path, pg, usage=False)
    user = new_user(pg)
    assert client.get("/exports", headers=auth(user)).json() == {"enabled": False}
    assert client.get("/credits/usage", headers=auth(user)).json() == {"enabled": False}


def test_no_secret_key_is_used_for_the_reads(tmp_path, pg, monkeypatch):
    """The reads go through the user's reader only: the service-role Rpc is used for the plan
    check, never for the history or the usage rows."""
    client, fake = make(tmp_path, pg)
    user = new_user(pg)
    on_plan(client, fake, user)
    seen = []
    original = PgRpc.call
    monkeypatch.setattr(PgRpc, "call", lambda self, fn, args: seen.append(fn) or original(self, fn, args))
    monkeypatch.setattr(PgRpc, "select", lambda self, table, owner, **kw: seen.append(table) or [])
    client.get("/exports", headers=auth(user))
    client.get("/credits/usage", headers=auth(user))
    assert not [f for f in seen if f.startswith("my_") or f in ("operation_log", "credit_ledger")], seen


def test_supabase_reader_sends_the_users_token_and_the_publishable_key_only():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=[])
    from stitchbook_api.account import SupabaseUserRpc
    rpc = SupabaseUserRpc("https://x.supabase.co", "sb_publishable_abc", "user-jwt", lambda: 5,
                          httpx.Client(transport=httpx.MockTransport(handler)))
    assert rpc.call("my_export_history", {"p_limit": 3, "p_offset": 0}) == []
    request = seen[0]
    assert str(request.url) == "https://x.supabase.co/rest/v1/rpc/my_export_history"
    assert request.headers["apikey"] == "sb_publishable_abc" and request.headers["authorization"] == "Bearer user-jwt"
    assert json.loads(request.content) == {"p_limit": 3, "p_offset": 0}
