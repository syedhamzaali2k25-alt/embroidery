"""Credits through the API, on the real migration-5 functions (local Postgres, see billing_pg.py),
with signed-in users (stand-in Supabase tokens, as in test_auth.py) and the FakeProvider.

Covers: /me/credits (token, free grant once), an export reserves first and consumes only on
success, a failed export gives everything back, 402 with nothing started at zero balance,
satin columns reserved BEFORE enqueuing (402 = not enqueued; queue down = released at once),
20 concurrent exports with credits for 12, webhooks (bad signature, valid, replay), checkout
without a provider, and the production fail-closed check.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import threading
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import pytest
from digitizer.config import load_test_run_config
from fastapi.testclient import TestClient

from billing_pg import PgRpc, start_postgres
from stitchbook_api import jobs as jobs_module
from stitchbook_api.auth import SupabaseAuth
from stitchbook_api.billing import Billing
from stitchbook_api.main import create_app
from stitchbook_api.payments import FakeProvider
from stitchbook_api.plans import month_start
from stitchbook_api.records import as_uuid
from stitchbook_api.settings import Settings
from stitchbook_api.storage import LocalDiskStorage
from test_auth import URL, FakeSupabaseAuth, token

SAMPLES = Path(__file__).resolve().parents[2] / "digitizer" / "samples"
CONFIG = load_test_run_config()
WEBHOOK_SECRET = "test-webhook-secret"


@pytest.fixture(scope="module")
def pg():
    db = start_postgres()
    try:
        yield db
    finally:
        db.stop()


def make_app(tmp_path, pg, config=CONFIG, provider="fake"):
    http = httpx.Client(transport=httpx.MockTransport(FakeSupabaseAuth()))
    auth = SupabaseAuth(URL, "sb_publishable_test", timeout_s=lambda: 5, cache_s=lambda: 300, http=http)
    settings = Settings("redis://127.0.0.1:1", "digitize", None, str(tmp_path / "store"), False, "info")
    fake = FakeProvider(WEBHOOK_SECRET) if provider == "fake" else None
    app = create_app(config, LocalDiskStorage(tmp_path / "store"), settings, auth=auth,
                     billing=Billing(PgRpc(pg), config), provider=fake)
    return TestClient(app, raise_server_exceptions=False), fake


def new_user(pg) -> str:
    user = str(uuid.uuid4())
    pg.sql(f"insert into auth.users (id, email) values ('{user}', '{user[:8]}@example.com')")
    return user


def auth(user):
    return {"Authorization": f"Bearer {token(user)}"}


def grant(pg, user, amount, bucket="purchased"):
    pg.sql(f"select public.grant_credits('{user}', {amount}, '{bucket}', "
           f"'{'purchase' if bucket == 'purchased' else 'adjustment'}', 'test:{uuid.uuid4().hex}')", service=True)


def designed(client, pg, user) -> str:
    """An uploaded, previewed design (so it has a DST), also recorded in the database (the
    reservations' foreign key), as Supabase mode would."""
    body = (SAMPLES / "two_colour.png").read_bytes()
    made = client.post("/designs", headers=auth(user), files={"file": ("two.png", body, "image/png")},
                       data={"settings": json.dumps({"width_mm": 40})})
    assert made.status_code == 201, made.text
    design = made.json()["id"]
    pg.sql(f"insert into public.designs (id, owner_id, filename, file_type, status, record) "
           f"values ('{as_uuid(design)}', '{user}', 'two.png', 'png', 'digitized', '{{}}')")
    assert client.post(f"/designs/{design}/preview", headers=auth(user)).status_code == 200
    return design


def credits(client, user) -> dict:
    response = client.get("/me/credits", headers=auth(user))
    assert response.status_code == 200, response.text
    return response.json()


NO_FREE = CONFIG.with_overrides({"billing.plans.free.credits": 0})


def test_me_credits_needs_a_token_and_grants_free_credits_once(tmp_path, pg):
    client, _ = make_app(tmp_path, pg)
    assert client.get("/me/credits").status_code == 401
    user = new_user(pg)
    first = credits(client, user)
    assert first["enabled"] is True and first["plan"] == "free" and first["plan_name"] == "Free"
    assert first["available"] == 30 and first["balances"]["plan"]["available"] == 30
    assert credits(client, user)["available"] == 30  # granted once (ref "free_grant")
    assert first["costs"]["export"] == 10


def test_an_export_reserves_first_and_is_charged_only_when_it_works(tmp_path, pg):
    client, _ = make_app(tmp_path, pg)
    user = new_user(pg)
    design = designed(client, pg, user)
    assert credits(client, user)["available"] == 30  # preview is free
    response = client.get(f"/designs/{design}/download?format=dst", headers=auth(user))
    assert response.status_code == 200 and response.content[:2] == b"LA"
    after = credits(client, user)
    assert after["available"] == 20 and after["balances"]["plan"]["consumed"] == 10
    row = after["history"][0]
    assert row["operation"] == "export" and row["format"] == "dst" and row["status"] == "succeeded" and row["credits"] == 10
    assert row["design_id"] == as_uuid(design)
    logged = pg.sql(f"select settings from public.operation_log where owner_id = '{user}'", service=True)[0][0]
    assert json.loads(logged)["width_mm"] == 40 and json.loads(logged)["format"] == "dst"


def test_a_failed_export_gives_the_credits_back(tmp_path, pg, monkeypatch):
    client, _ = make_app(tmp_path, pg)
    user = new_user(pg)
    design = designed(client, pg, user)
    real_get = LocalDiskStorage.get
    monkeypatch.setattr(LocalDiskStorage, "get",
                        lambda self, key: (_ for _ in ()).throw(OSError("disk gone")) if key.endswith("out.dst") else real_get(self, key))
    response = client.get(f"/designs/{design}/download?format=dst", headers=auth(user))
    assert response.status_code == 500
    after = credits(client, user)
    assert after["available"] == 30 and after["balances"]["plan"]["reserved"] == 0
    assert after["history"][0]["status"] == "failed"


def test_zero_balance_is_402_and_nothing_runs(tmp_path, pg):
    client, _ = make_app(tmp_path, pg, config=NO_FREE)
    user = new_user(pg)
    design = designed(client, pg, user)
    response = client.get(f"/designs/{design}/download?format=dst", headers=auth(user))
    assert response.status_code == 402
    assert response.json() == {"error": "You don't have enough credits for this.", "available": 0, "needed": 10, "plan": "free"}
    link = client.get(f"/designs/{design}/download-url?format=dst", headers=auth(user))
    assert link.status_code == 402
    assert pg.sql(f"select count(*) from public.operation_log where owner_id = '{user}'", service=True) == [["0"]]


def test_satin_columns_reserve_before_enqueuing(tmp_path, pg, monkeypatch):
    config = NO_FREE.with_overrides({"billing.credit_costs.satin_columns": 20})
    client, _ = make_app(tmp_path, pg, config=config)
    user = new_user(pg)
    design = designed(client, pg, user)
    enqueued = []
    real = jobs_module.Jobs.start_trace
    monkeypatch.setattr(jobs_module.Jobs, "start_trace", lambda self, *a, **k: (enqueued.append(k.get("job_id")), real(self, *a, **k))[1])
    grant(pg, user, 10)
    assert client.post(f"/designs/{design}/trace", headers=auth(user)).status_code == 402
    assert enqueued == []  # 402: nothing was enqueued
    grant(pg, user, 20)
    response = client.post(f"/designs/{design}/trace", headers=auth(user))
    assert response.status_code == 503 and len(enqueued) == 1  # the queue is down (no Redis here)...
    after = credits(client, user)
    assert after["available"] == 30 and after["balances"]["purchased"]["reserved"] == 0  # ...so released at once
    assert after["history"][0]["operation"] == "satin_columns" and after["history"][0]["status"] == "failed"


def test_twenty_concurrent_exports_with_credits_for_twelve(tmp_path, pg):
    client, _ = make_app(tmp_path, pg, config=NO_FREE)
    user = new_user(pg)
    design = designed(client, pg, user)
    grant(pg, user, 120)
    codes = []
    lock = threading.Lock()

    def one():
        code = client.get(f"/designs/{design}/download?format=dst", headers=auth(user)).status_code
        with lock:
            codes.append(code)

    threads = [threading.Thread(target=one) for _ in range(20)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(codes).count(200) == 12 and codes.count(402) == 8, codes
    after = credits(client, user)
    assert after["available"] == 0 and after["balances"]["purchased"] == {"available": 0, "reserved": 0, "consumed": 120}
    assert pg.sql(f"select count(*) from public.operation_log where owner_id = '{user}' and status = 'succeeded'",
                  service=True) == [["12"]]


def signed(fake: FakeProvider, payload: dict) -> tuple[bytes, dict]:
    raw = json.dumps(payload).encode()
    return raw, {"X-Fake-Signature": fake.sign(raw), "Content-Type": "application/json"}


def test_webhooks_are_verified_applied_once_and_grant_the_period_once(tmp_path, pg):
    client, fake = make_app(tmp_path, pg)
    user = new_user(pg)
    end = (datetime.now(timezone.utc) + timedelta(days=30)).isoformat()
    event = {"id": "evt_1", "type": "subscription.updated", "plan": "pro", "interval": "year", "status": "active",
             "period_end": end, "customer_id": "cus_1", "subscription_id": "sub_1", "metadata": {"user_id": user}}
    raw, headers = signed(fake, event)
    bad = client.post("/webhooks/billing", content=raw, headers={**headers, "X-Fake-Signature": "0" * 64})
    assert bad.status_code == 400
    tampered = client.post("/webhooks/billing", content=raw.replace(b'"pro"', b'"business"'), headers=headers)
    assert tampered.status_code == 400
    assert pg.sql(f"select count(*) from public.subscriptions where owner_id = '{user}'", service=True) == [["0"]]
    assert client.post("/webhooks/billing", content=raw, headers=headers).json() == {"result": "applied"}
    assert client.post("/webhooks/billing", content=raw, headers=headers).json() == {"result": "duplicate"}  # replay
    again = {**event, "id": "evt_2"}
    raw2, headers2 = signed(fake, again)
    assert client.post("/webhooks/billing", content=raw2, headers=headers2).json() == {"result": "applied"}
    ref = f"plan:sub_1:{month_start():%Y-%m-%d}"
    assert pg.sql(f"select count(*), sum(delta), max(ref) from public.credit_ledger where owner_id = '{user}' and reason = 'plan_grant'",
                  service=True) == [["1", "5000", ref]]  # one grant per period
    account = credits(client, user)
    assert account["plan"] == "pro" and account["plan_name"] == "Pro" and account["interval"] == "year"
    assert account["available"] == 5030  # this month's allowance + the free grant


def test_webhook_user_id_comes_only_from_the_signed_event(tmp_path, pg):
    client, fake = make_app(tmp_path, pg)
    victim, attacker = new_user(pg), new_user(pg)
    raw, headers = signed(fake, {"id": "evt_x", "plan": "business", "interval": "month", "status": "active",
                                 "subscription_id": "sub_x", "metadata": {"user_id": victim}})
    # A sign-in token or a query parameter changes nothing: the signed metadata decides.
    client.post(f"/webhooks/billing?user_id={attacker}", content=raw, headers={**headers, **auth(attacker)})
    assert pg.sql(f"select owner_id from public.subscriptions where provider_subscription_id = 'sub_x'", service=True) == [[victim]]


def test_checkout_without_a_payment_provider_is_503(tmp_path, pg):
    client, _ = make_app(tmp_path, pg, provider=None)
    user = new_user(pg)
    response = client.post("/billing/checkout", json={"plan": "pro", "interval": "year"}, headers=auth(user))
    assert response.status_code == 503 and response.json()["error"] == "Payments are not available yet."
    assert client.post("/webhooks/billing", content=b"{}").status_code == 503
    client2, _ = make_app(tmp_path, pg)
    url = client2.post("/billing/checkout", json={"plan": "pro", "interval": "year"}, headers=auth(user)).json()["url"]
    assert url.startswith("https://checkout.invalid/fake?") and user in url


def test_plans_are_public_and_in_config(tmp_path, pg):
    client, _ = make_app(tmp_path, pg)
    plans = client.get("/plans").json()
    assert [p["price_yearly"] for p in plans["plans"]] == ["0.00", "129.60", "270.00"]
    assert client.get("/config").json()["billing"] == plans


def test_production_refuses_local_or_free_billing(tmp_path):
    base = ("redis://unused", "digitize", None, str(tmp_path), False, "info")
    with pytest.raises(RuntimeError, match="Refusing to start in production"):
        create_app(CONFIG, settings=Settings(*base, environment="production", free_operations=True))
    with pytest.raises(RuntimeError, match="SUPABASE_SECRET_KEY"):
        create_app(CONFIG, settings=Settings(*base, environment="production", supabase_url="https://x.supabase.co",
                                             supabase_publishable_key="sb_publishable_x"))


def test_local_mode_without_the_switch_refuses_exports(tmp_path):
    settings = Settings("redis://unused", "digitize", None, str(tmp_path / "store"), False, "info")
    client = TestClient(create_app(CONFIG, LocalDiskStorage(tmp_path / "store"), settings))
    body = (SAMPLES / "two_colour.png").read_bytes()
    design = client.post("/designs", files={"file": ("two.png", body, "image/png")}).json()["id"]
    assert client.post(f"/designs/{design}/preview").status_code == 200  # preview stays free
    response = client.get(f"/designs/{design}/download?format=dst")
    assert response.status_code == 503 and "Credits are not set up" in response.json()["error"]
    assert client.get("/me/credits").json() == {"enabled": False}
