"""The Whop adapter (docs/payments-whop.md), on the real migration-5 functions (local Postgres)
and signed-in stand-in users. Nothing here calls Whop: its API is an httpx MockTransport.

The sample webhook bodies follow Whop's own shapes, as published in Whop's official Python SDK
(whop-sdk 0.0.41 typed webhook events: {id, api_version, type, timestamp, company_id, data};
data = a Membership or a Payment). Signing follows Standard Webhooks: base64 HMAC-SHA256 over
"{webhook-id}.{webhook-timestamp}.{raw body}", header "v1,<sig>", the secret used as its literal
bytes (whop-sdk 2.0.0, whop_sdk/lib/verify_webhook.py).
"""

from __future__ import annotations

import json
import time
import uuid
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from fastapi.testclient import TestClient

from billing_pg import PgRpc, start_postgres
from stitchbook_api.auth import SupabaseAuth
from stitchbook_api.billing import Billing
from stitchbook_api.main import create_app
from stitchbook_api.payments import NotConfigured, WhopProvider, provider_from, standard_webhook_signature, \
    verify_standard_webhook, BadSignature
from stitchbook_api.plans import month_start
from stitchbook_api.settings import Settings
from stitchbook_api.storage import LocalDiskStorage
from test_auth import URL, FakeSupabaseAuth, token
from test_billing_api import CONFIG as BASE, auth, credits, new_user

SECRET = "ws_test_secret_made_up_for_tests_only"
PLAN_IDS = {"pro.month": "plan_ProMonth", "pro.year": "plan_ProYear",
            "business.month": "plan_BizMonth", "business.year": "plan_BizYear"}
CONFIG = BASE.with_overrides({
    "billing.provider": "whop", "billing.whop_environment": "sandbox", "billing.provider_http_timeout_s": 5,
    **{f"billing.plans.{k.split('.')[0]}.whop_plan_ids.{k.split('.')[1]}": v for k, v in PLAN_IDS.items()},
})


class FakeWhop:
    """Whop's API as the SDK describes it: POST /checkout_configurations -> {id, purchase_url},
    POST /memberships/{id}/cancel, GET /memberships/{id} -> {manage_url}, GET /plans/{id}."""

    def __init__(self):
        self.requests: list[tuple[str, str, dict | None]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        assert request.url.host == "sandbox-api.whop.com", request.url
        assert request.headers["authorization"] == "Bearer whop-test-api-key"
        body = json.loads(request.content) if request.content else None
        path = request.url.path.removeprefix("/api/v1/")
        self.requests.append((request.method, path, body))
        if path == "checkout_configurations":
            return httpx.Response(200, json={"id": "ch_1", "plan": {"id": body["plan_id"]}, "metadata": body["metadata"],
                                             "purchase_url": "https://whop.com/checkout/plan_x?session=ch_1"})
        if path.endswith("/cancel"):
            return httpx.Response(200, json={"id": path.split("/")[1], "cancel_at_period_end": True})
        if path.startswith("memberships/"):
            return httpx.Response(200, json={"id": path.split("/")[1], "manage_url": "https://whop.com/@me/settings/memberships/"})
        return httpx.Response(404, json={"error": "not found"})


@pytest.fixture(scope="module")
def pg():
    db = start_postgres()
    try:
        yield db
    finally:
        db.stop()


def make(tmp_path, pg, config=CONFIG):
    whop = FakeWhop()
    http = httpx.Client(transport=httpx.MockTransport(FakeSupabaseAuth()))
    sign_in = SupabaseAuth(URL, "sb_publishable_test", timeout_s=lambda: 5, cache_s=lambda: 300, http=http)
    settings = Settings("redis://127.0.0.1:1", "digitize", None, str(tmp_path / "store"), False, "info",
                        whop_api_key="whop-test-api-key", whop_webhook_secret=SECRET, site_url="https://site.example")
    provider = provider_from("whop", fake_secret=None, production=False, config=config,
                             whop_api_key=settings.whop_api_key, whop_webhook_secret=settings.whop_webhook_secret,
                             site_url=settings.site_url, http=httpx.Client(transport=httpx.MockTransport(whop)))
    app = create_app(config, LocalDiskStorage(tmp_path / "store"), settings, auth=sign_in,
                     billing=Billing(PgRpc(pg), config), provider=provider)
    return TestClient(app, raise_server_exceptions=False), whop


def signed(body: dict, webhook_id: str | None = None, at: float | None = None, secret: str = SECRET):
    raw = json.dumps(body).encode()
    webhook_id = webhook_id or f"msg_{uuid.uuid4().hex}"
    stamp = str(int(time.time() if at is None else at))
    return raw, {"webhook-id": webhook_id, "webhook-timestamp": stamp,
                 "webhook-signature": standard_webhook_signature(secret.encode(), webhook_id, stamp, raw),
                 "content-type": "application/json"}


def iso(t: datetime) -> str:
    return t.isoformat().replace("+00:00", "Z")


def membership_event(kind, user, membership="mem_A", plan="plan_ProYear", cancel_at_period_end=False, status="active"):
    now = datetime.now(timezone.utc)
    data = {"id": membership, "status": status, "cancel_at_period_end": cancel_at_period_end, "plan": {"id": plan},
            "product": {"id": "prod_1", "title": "Stitchbook"}, "user": {"id": "user_W1", "username": "buyer"},
            "company": {"id": "biz_1", "title": "Seller"}, "checkout_configuration_id": "ch_1",
            "renewal_period_start": iso(now), "renewal_period_end": iso(now + timedelta(days=365)),
            "manage_url": "https://whop.com/@me/settings/memberships/", "created_at": iso(now), "updated_at": iso(now),
            "metadata": {"stitchbook_user_id": user} if user else {}}
    return {"id": f"evt_{uuid.uuid4().hex[:8]}", "api_version": "v1", "type": kind, "timestamp": iso(now),
            "company_id": "biz_1", "data": data}


def payment_event(kind, user, membership="mem_A", plan="plan_ProYear", paid_at=None):
    now = datetime.now(timezone.utc)
    data = {"id": f"pay_{uuid.uuid4().hex[:8]}", "status": "paid" if kind == "payment.succeeded" else "open",
            "substatus": "succeeded" if kind == "payment.succeeded" else "failed",
            "membership": {"id": membership, "status": "active"}, "plan": {"id": plan},
            "product": {"id": "prod_1", "title": "Stitchbook", "route": "stitchbook"},
            "user": {"id": "user_W1", "username": "buyer"}, "currency": "usd", "total": 129.6, "subtotal": 129.6,
            "usd_total": 129.6, "paid_at": iso(paid_at or now), "created_at": iso(now), "updated_at": iso(now),
            "checkout_configuration_id": "ch_1", "refunds": [], "refundable": True, "retryable": False, "voidable": False,
            "metadata": {"stitchbook_user_id": user} if user else {}}
    return {"id": f"evt_{uuid.uuid4().hex[:8]}", "api_version": "v1", "type": kind, "timestamp": iso(now),
            "company_id": "biz_1", "data": data}


def post(client, body, **kw):
    raw, headers = signed(body, **kw)
    return client.post("/webhooks/billing", content=raw, headers=headers)


def plan_grants(pg, user) -> list[list[str]]:
    return pg.sql(f"select delta, ref from public.credit_ledger where owner_id = '{user}' and reason = 'plan_grant' "
                  f"order by id", service=True)


def subscription(pg, user) -> list[list[str]]:
    return pg.sql(f"select plan, billing_interval, status, provider_subscription_id from public.subscriptions "
                  f"where owner_id = '{user}'", service=True)


# ---------- signature ----------

def test_a_valid_signature_is_accepted(tmp_path, pg):
    client, _ = make(tmp_path, pg)
    user = new_user(pg)
    assert post(client, payment_event("payment.succeeded", user)).json() == {"result": "applied"}
    assert subscription(pg, user) == [["pro", "year", "active", "mem_A"]]


def test_a_tampered_body_is_400_with_no_side_effects(tmp_path, pg):
    client, _ = make(tmp_path, pg)
    user = new_user(pg)
    raw, headers = signed(payment_event("payment.succeeded", user, plan="plan_ProMonth", membership="mem_T"))
    tampered = raw.replace(b"plan_ProMonth", b"plan_BizMonth")
    assert client.post("/webhooks/billing", content=tampered, headers=headers).status_code == 400
    wrong_key = signed(payment_event("payment.succeeded", user, membership="mem_T"), secret="ws_some_other_secret_value")
    assert client.post("/webhooks/billing", content=wrong_key[0], headers=wrong_key[1]).status_code == 400
    no_headers = client.post("/webhooks/billing", content=raw, headers={"content-type": "application/json"})
    assert no_headers.status_code == 400
    assert subscription(pg, user) == [] and plan_grants(pg, user) == []
    assert pg.sql(f"select count(*) from public.processed_webhook_events where event_id = '{headers['webhook-id']}'",
                  service=True) == [["0"]]


def test_a_timestamp_older_than_five_minutes_is_rejected(tmp_path, pg):
    client, _ = make(tmp_path, pg)
    user = new_user(pg)
    old = post(client, payment_event("payment.succeeded", user, membership="mem_O"), at=time.time() - 301)
    assert old.status_code == 400
    future = post(client, payment_event("payment.succeeded", user, membership="mem_O"), at=time.time() + 301)
    assert future.status_code == 400
    assert subscription(pg, user) == [] and plan_grants(pg, user) == []
    assert post(client, payment_event("payment.succeeded", user, membership="mem_O"), at=time.time() - 250).status_code == 200


def test_the_signature_check_itself():
    raw = b'{"a":1}'
    headers = {"Webhook-Id": "msg_1", "Webhook-Timestamp": "1700000000",
               "Webhook-Signature": "v1,bm90LWl0 " + standard_webhook_signature(b"k", "msg_1", "1700000000", raw)}
    assert verify_standard_webhook(headers, raw, b"k", 300, now=1700000100) == "msg_1"  # any listed v1 sig may match
    with pytest.raises(BadSignature):
        verify_standard_webhook({**headers, "Webhook-Signature": "v1,bm90LWl0"}, raw, b"k", 300, now=1700000100)
    with pytest.raises(BadSignature):
        verify_standard_webhook({**headers, "Webhook-Timestamp": "soon"}, raw, b"k", 300, now=1700000100)
    with pytest.raises(BadSignature):  # the id is signed too
        verify_standard_webhook({**headers, "Webhook-Id": "msg_2"}, raw, b"k", 300, now=1700000100)


# ---------- events ----------

def test_a_replayed_webhook_id_does_nothing(tmp_path, pg):
    client, _ = make(tmp_path, pg)
    user = new_user(pg)
    body = payment_event("payment.succeeded", user, membership="mem_R")
    first = post(client, body, webhook_id="msg_replay_1")
    assert first.json() == {"result": "applied"}
    again = post(client, body, webhook_id="msg_replay_1")  # same id, freshly re-signed: still a replay
    assert again.json() == {"result": "duplicate"}
    assert plan_grants(pg, user) == [["5000", f"plan:mem_R:{month_start():%Y-%m-%d}"]]


def test_a_webhook_for_an_unknown_owner_grants_nothing(tmp_path, pg):
    client, _ = make(tmp_path, pg)
    stranger = str(uuid.uuid4())  # a well-formed id that is no Stitchbook account
    assert post(client, payment_event("payment.succeeded", stranger, membership="mem_U")).json() == \
        {"result": "ignored: unknown owner"}
    assert post(client, payment_event("payment.succeeded", None, membership="mem_U2")).json() == \
        {"result": "ignored: unknown owner"}  # no metadata, membership never bound
    assert post(client, payment_event("payment.succeeded", "not-a-uuid", membership="mem_U3")).json() == \
        {"result": "ignored: unknown owner"}
    assert pg.sql("select count(*) from public.credit_ledger where ref like 'plan:mem_U%'", service=True) == [["0"]]
    assert pg.sql("select count(*) from public.subscriptions where provider_subscription_id like 'mem_U%'", service=True) == [["0"]]


def test_credits_go_only_to_the_user_tied_to_the_checkout(tmp_path, pg):
    client, whop = make(tmp_path, pg)
    buyer, other = new_user(pg), new_user(pg)
    # The checkout is made for the signed-in user; a user id in the body is ignored.
    made = client.post("/billing/checkout", json={"plan": "business", "interval": "month", "user_id": other},
                       headers=auth(buyer))
    assert made.status_code == 200 and made.json()["url"].startswith("https://whop.com/checkout/")
    method, path, body = whop.requests[-1]
    assert (method, path) == ("POST", "checkout_configurations")
    assert body == {"plan_id": "plan_BizMonth", "metadata": {"stitchbook_user_id": buyer},
                    "redirect_url": "https://site.example/billing?checkout=done"}
    tied = body["metadata"]["stitchbook_user_id"]
    assert post(client, membership_event("membership.activated", tied, "mem_B", "plan_BizMonth")).json()["result"] == "applied"
    # A later event for the same membership naming someone else changes nothing for anyone.
    hijack = post(client, payment_event("payment.succeeded", other, "mem_B", "plan_BizMonth"))
    assert hijack.json() == {"result": "ignored: owner mismatch"}
    assert subscription(pg, other) == [] and plan_grants(pg, other) == []
    # A renewal payment without metadata goes to the user the membership is bound to.
    assert post(client, payment_event("payment.succeeded", None, "mem_B", "plan_BizMonth")).json() == {"result": "applied"}
    assert plan_grants(pg, buyer) == [["10000", f"plan:mem_B:{month_start():%Y-%m-%d}"]]
    assert plan_grants(pg, other) == []


def test_yearly_and_monthly_both_grant_the_monthly_allowance(tmp_path, pg):
    client, _ = make(tmp_path, pg)
    cases = [("plan_ProMonth", "pro", "month", 5000), ("plan_ProYear", "pro", "year", 5000),
             ("plan_BizMonth", "business", "month", 10000), ("plan_BizYear", "business", "year", 10000)]
    for plan_id, plan, interval, monthly in cases:
        user = new_user(pg)
        membership = f"mem_{plan_id}"
        assert post(client, payment_event("payment.succeeded", user, membership, plan_id)).json() == {"result": "applied"}
        assert plan_grants(pg, user) == [[str(monthly), f"plan:{membership}:{month_start():%Y-%m-%d}"]], plan_id
        account = credits(client, user)
        assert (account["plan"], account["interval"], account["available"]) == (plan, interval, monthly + 30), plan_id
        # The API's own monthly top-up uses the same ref: no second grant this month.
        assert len(plan_grants(pg, user)) == 1


def test_payment_failed_shows_past_due(tmp_path, pg):
    client, _ = make(tmp_path, pg)
    user = new_user(pg)
    post(client, payment_event("payment.succeeded", user, "mem_F", "plan_ProMonth"))
    assert post(client, payment_event("payment.failed", user, "mem_F", "plan_ProMonth")).json() == {"result": "applied"}
    account = credits(client, user)
    assert account["status"] == "past_due" and account["plan"] == "free"  # no new grants while past due
    assert account["available"] == 5030  # what was granted stays


def test_deactivation_returns_to_free_for_new_grants_and_keeps_granted_credits(tmp_path, pg):
    client, _ = make(tmp_path, pg)
    user = new_user(pg)
    post(client, membership_event("membership.activated", user, "mem_D", "plan_ProYear"))
    post(client, payment_event("payment.succeeded", user, "mem_D", "plan_ProYear"))
    assert credits(client, user)["available"] == 5030
    # Cancel at period end: still Pro until the paid period ends.
    post(client, membership_event("membership.cancel_at_period_end_changed", user, "mem_D", "plan_ProYear",
                                  cancel_at_period_end=True))
    assert credits(client, user)["plan"] == "pro"
    assert post(client, membership_event("membership.deactivated", user, "mem_D", "plan_ProYear",
                                         status="canceled")).json() == {"result": "applied"}
    account = credits(client, user)
    assert account["plan"] == "free" and account["status"] == "canceled"
    assert account["available"] == 5030  # nothing deleted
    assert pg.sql(f"select count(*) from public.credit_ledger where owner_id = '{user}' and delta < 0", service=True) == [["0"]]
    # A new payment on the dead membership's period would be a new grant: not given while Free.
    assert len(plan_grants(pg, user)) == 1


def test_an_old_membership_ending_does_not_end_the_new_one(tmp_path, pg):
    client, _ = make(tmp_path, pg)
    user = new_user(pg)
    post(client, payment_event("payment.succeeded", user, "mem_old", "plan_ProMonth"))
    post(client, payment_event("payment.succeeded", user, "mem_new", "plan_BizMonth"))  # upgraded
    late = post(client, membership_event("membership.deactivated", user, "mem_old", "plan_ProMonth", status="canceled"))
    assert late.json() == {"result": "ignored: not the current subscription"}
    assert subscription(pg, user) == [["business", "month", "active", "mem_new"]]


def test_other_events_and_refunds_are_200_and_change_nothing(tmp_path, pg):
    client, _ = make(tmp_path, pg)
    user = new_user(pg)
    refund = {"id": "evt_r", "api_version": "v1", "type": "refund.created", "timestamp": iso(datetime.now(timezone.utc)),
              "data": {"id": "rfnd_1", "amount": 12, "payment": {"id": "pay_1"}}}
    assert post(client, refund).json() == {"result": "ignored"}
    assert post(client, {**membership_event("membership.went_valid", user), "type": "membership.went_valid"}).json() == \
        {"result": "ignored"}
    assert post(client, payment_event("payment.succeeded", user, "mem_X", "plan_SomeOtherProduct")).json() == \
        {"result": "ignored"}
    assert subscription(pg, user) == [] and plan_grants(pg, user) == []


# ---------- cancel, manage, setup ----------

def test_cancel_and_manage_billing_use_whops_own_pages(tmp_path, pg):
    client, whop = make(tmp_path, pg)
    user = new_user(pg)
    assert client.post("/billing/cancel", headers=auth(user)).status_code == 409
    assert client.get("/billing/manage", headers=auth(user)).json() == {"url": None}
    post(client, payment_event("payment.succeeded", user, "mem_M", "plan_ProMonth"))
    assert client.post("/billing/cancel", headers=auth(user)).json() == {"status": "cancel requested"}
    assert whop.requests[-1] == ("POST", "memberships/mem_M/cancel", {"cancel_at_period_end": True})
    assert client.get("/billing/manage", headers=auth(user)).json() == {"url": "https://whop.com/@me/settings/memberships/"}
    assert client.get("/billing/manage").status_code == 401


def test_whop_down_is_a_plain_502(tmp_path, pg):
    def down(request):
        raise httpx.ConnectError("no route")
    provider = WhopProvider("whop-test-api-key", SECRET, "sandbox", {("pro", "month"): "plan_P"}, None, lambda: 5, 300,
                            http=httpx.Client(transport=httpx.MockTransport(down)))
    http = httpx.Client(transport=httpx.MockTransport(FakeSupabaseAuth()))
    sign_in = SupabaseAuth(URL, "sb_publishable_test", timeout_s=lambda: 5, cache_s=lambda: 300, http=http)
    settings = Settings("redis://127.0.0.1:1", "digitize", None, str(tmp_path / "s"), False, "info")
    client = TestClient(create_app(CONFIG, LocalDiskStorage(tmp_path / "s"), settings, auth=sign_in,
                                   billing=Billing(PgRpc(pg), CONFIG), provider=provider), raise_server_exceptions=False)
    user = new_user(pg)
    response = client.post("/billing/checkout", json={"plan": "pro", "interval": "month"}, headers=auth(user))
    assert response.status_code == 502 and "did not answer" in response.json()["error"]


def test_whop_is_refused_until_it_is_fully_set_up():
    with pytest.raises(NotConfigured, match="WHOP_API_KEY and WHOP_WEBHOOK_SECRET"):
        provider_from("whop", fake_secret=None, production=False, config=CONFIG, whop_api_key="k")
    with pytest.raises(NotConfigured, match="WHOP_API_KEY and WHOP_WEBHOOK_SECRET"):
        provider_from("whop", fake_secret=None, production=False, config=CONFIG, whop_webhook_secret=SECRET)
    unset = BASE.with_overrides({"billing.whop_environment": "sandbox", "billing.provider_http_timeout_s": 5})
    with pytest.raises(NotConfigured, match="whop_plan_ids"):
        provider_from("whop", fake_secret=None, production=False, config=unset, whop_api_key="k", whop_webhook_secret=SECRET)
    with pytest.raises(NotConfigured, match="production"):
        provider_from("whop", fake_secret=None, production=True, config=CONFIG, whop_api_key="k", whop_webhook_secret=SECRET)
    with pytest.raises(NotConfigured, match="refused in production"):
        provider_from("fake", fake_secret="x", production=True)
    assert provider_from("whop", fake_secret=None, production=False, config=CONFIG, whop_api_key="k",
                         whop_webhook_secret=SECRET).name == "whop"


def test_the_api_refuses_to_start_with_whop_but_no_keys(tmp_path):
    settings = Settings("redis://127.0.0.1:1", "digitize", None, str(tmp_path), False, "info")
    with pytest.raises(NotConfigured, match="WHOP_API_KEY"):
        create_app(CONFIG, settings=settings, billing=None)


def test_the_keys_never_show_in_a_repr():
    settings = Settings("r", "q", None, "s", False, "info", whop_api_key="whop-test-api-key", whop_webhook_secret=SECRET)
    assert "whop-test-api-key" not in repr(settings) and SECRET not in repr(settings)
