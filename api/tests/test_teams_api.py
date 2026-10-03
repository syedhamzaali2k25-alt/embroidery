"""Teams through the API (Step 13b), on the real migration 5 + 7 SQL and stand-in sign-in tokens
that carry the user's email. The Stage 2 security list: a member cannot read billing, invites or
other members' designs; a non-owner cannot invite; expired or reused tokens fail; one team per
person; seats cannot be exceeded; a member with zero team credits gets 402 and nothing runs;
removal stops pool access at once; an extra seat adds its credits exactly once (a replay adds
nothing) and a cancelled seat stops the next grant; the plan's end ends the team.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone

import httpx
import pytest
from fastapi.testclient import TestClient

from billing_pg import PgRpc, PgUserRpc, start_postgres
from stitchbook_api import plans as plan_math
from stitchbook_api.auth import SupabaseAuth
from stitchbook_api.billing import Billing
from stitchbook_api.main import create_app
from stitchbook_api.payments import FakeProvider
from stitchbook_api.settings import Settings
from stitchbook_api.storage import LocalDiskStorage
from test_auth import URL, FakeSupabaseAuth, token
from test_billing_api import CONFIG, WEBHOOK_SECRET, designed, new_user, signed

# Business with "teams" (Multiple accounts) available: config.py's own list, any "coming soon"
# status dropped (the tag comes off in config only once Stage 2 passes).
TEAMS = CONFIG.with_overrides({"billing.plans.business.features": [
    {k: v for k, v in f.items() if k != "status"} for f in CONFIG.get("billing.plans.business.features")]})


@pytest.fixture(scope="module")
def pg():
    db = start_postgres()
    try:
        yield db
    finally:
        db.stop()


def email(user: str) -> str:
    return f"{user[:8]}@example.com"  # what new_user() stores in auth.users


def auth(user: str, mail: str | None = None) -> dict:
    return {"Authorization": f"Bearer {token(user, email=mail or email(user))}"}


def make(tmp_path, pg, config=TEAMS):
    http = httpx.Client(transport=httpx.MockTransport(FakeSupabaseAuth()))
    sign_in = SupabaseAuth(URL, "sb_publishable_test", timeout_s=lambda: 5, cache_s=lambda: 300, http=http)
    settings = Settings("redis://127.0.0.1:1", "digitize", None, str(tmp_path / "store"), False, "info")
    fake = FakeProvider(WEBHOOK_SECRET)
    app = create_app(config, LocalDiskStorage(tmp_path / "store"), settings, auth=sign_in,
                     billing=Billing(PgRpc(pg), config), provider=fake, usage_for=lambda u: PgUserRpc(pg, u.id))
    return TestClient(app, raise_server_exceptions=False), fake


def webhook(client, fake, payload):
    raw, headers = signed(fake, {"id": f"evt_{uuid.uuid4().hex}", **payload})
    return client.post("/webhooks/billing", content=raw, headers=headers).json()["result"]


def on_plan(client, fake, user, plan="business", status="active", end="2099-01-01T00:00:00+00:00"):
    assert webhook(client, fake, {"plan": plan, "interval": "month", "status": status, "period_end": end,
                                  "subscription_id": f"sub_{user[:8]}", "metadata": {"user_id": user}}) == "applied"


def invite(client, owner, who) -> str:
    response = client.post("/team/invites", json={"email": email(who)}, headers=auth(owner))
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["path"] == f"/team/join#token={body['token']}"
    return body["token"]


def join(client, user, tok):
    return client.post("/team/invites/accept", json={"token": tok}, headers=auth(user))


def team(client, fake, pg, members=1):
    owner = new_user(pg)
    on_plan(client, fake, owner)
    users = [new_user(pg) for _ in range(members)]
    for u in users:
        assert join(client, u, invite(client, owner, u)).json() == {"status": "joined"}
    return owner, users


def export(client, user, design):
    return client.get(f"/designs/{design}/download?format=dst", headers=auth(user))


def test_the_owner_sees_the_team_and_seats(tmp_path, pg):
    client, fake = make(tmp_path, pg)
    owner, (m1, m2) = team(client, fake, pg, 2)
    view = client.get("/team", headers=auth(owner)).json()
    assert view["role"] == "owner" and [m["email"] for m in view["members"]] == [email(m1), email(m2)]
    assert view["seats"] == {"used": 3, "total": 4, "included": 4, "extra": 0}
    assert view["extra_seat"] == {"included_seats": 4, "extra_seat_price": "10.00", "extra_seat_credits": 1000,
                                  "currency": "USD", "available": True}


def test_a_member_cannot_read_billing_invites_or_other_members(tmp_path, pg):
    client, fake = make(tmp_path, pg)
    owner, (m1, m2) = team(client, fake, pg, 2)
    client.post("/team/invites", json={"email": "later@example.com"}, headers=auth(owner))
    assert client.get("/team", headers=auth(m1)).json() == {"enabled": True, "role": "member"}  # no list, no invites
    usage = client.get("/credits/usage", headers=auth(m1))
    assert usage.status_code == 403 and usage.json()["error"] == "team_member"
    assert client.post("/billing/checkout", json={"plan": "pro", "interval": "month"}, headers=auth(m1)).status_code == 403
    me = client.get("/me/credits", headers=auth(m1)).json()
    assert me["team"] == {"role": "member"} and me["plan"] == "business"
    assert me["balances"]["plan"]["consumed"] == 0 and me["history"] == []  # the pool's figures, not the owner's ledger
    design = designed(client, pg, m2)
    assert client.get(f"/designs/{design}", headers=auth(m1)).status_code == 404  # another member's design
    assert client.get(f"/designs/{design}", headers=auth(owner)).status_code == 404  # the owner's too
    for path in ("/team/seats",):
        assert client.post(path, headers=auth(m1)).status_code == 403
    assert client.delete(f"/team/members/{m2}", headers=auth(m1)).status_code == 403


def test_a_non_owner_cannot_invite(tmp_path, pg):
    client, fake = make(tmp_path, pg)
    free, pro = new_user(pg), new_user(pg)
    on_plan(client, fake, pro, "pro")
    for user in (free, pro):
        response = client.post("/team/invites", json={"email": "x@example.com"}, headers=auth(user))
        assert response.status_code == 403 and response.json() == {"error": "plan_required", "plan": "business"}
    owner, (member,) = team(client, fake, pg, 1)
    response = client.post("/team/invites", json={"email": "x@example.com"}, headers=auth(member))
    assert response.status_code == 403 and response.json()["error"] == "team_member"
    assert client.get("/team", headers=auth(free)).status_code == 403  # no Team page for Free / Pro


def test_expired_reused_or_wrong_tokens_fail(tmp_path, pg):
    short = TEAMS.with_overrides({"billing.team.invite_ttl_s": -1})  # made already expired
    client, fake = make(tmp_path, pg, short)
    owner = new_user(pg)
    on_plan(client, fake, owner)
    u = new_user(pg)
    expired = join(client, u, invite(client, owner, u))
    assert expired.status_code == 410 and "expired" in expired.json()["error"]
    client, _ = make(tmp_path, pg)
    tok = invite(client, owner, u)
    other = new_user(pg)
    assert join(client, other, tok).status_code == 403  # the link in someone else's hands
    assert join(client, u, tok).json() == {"status": "joined"}
    reused = join(client, u, tok)
    assert reused.status_code == 410 and "already been used" in reused.json()["error"]
    assert join(client, other, "x" * 43).status_code == 404
    assert join(client, other, "").status_code == 404


def test_a_user_in_a_team_cannot_accept_a_second_invite(tmp_path, pg):
    client, fake = make(tmp_path, pg)
    a, (member,) = team(client, fake, pg, 1)
    b = new_user(pg)
    on_plan(client, fake, b)
    second = join(client, member, invite(client, b, member))
    assert second.status_code == 409 and second.json()["code"] == "already_in_team"


def test_seats_cannot_be_exceeded(tmp_path, pg):
    client, fake = make(tmp_path, pg)
    owner, members = team(client, fake, pg, 3)  # owner + 3 = the 4 included seats
    full = client.post("/team/invites", json={"email": "fifth@example.com"}, headers=auth(owner))
    assert full.status_code == 409 and full.json()["code"] == "no_seats"


def test_a_members_export_with_zero_team_credits_is_402_and_nothing_runs(tmp_path, pg):
    client, fake = make(tmp_path, pg, TEAMS.with_overrides({"billing.plans.business.credits_per_month": 0,
                                                            "billing.plans.free.credits": 0}))
    owner, (member,) = team(client, fake, pg, 1)
    design = designed(client, pg, member)
    response = export(client, member, design)
    assert response.status_code == 402 and response.json()["available"] == 0
    assert pg.sql(f"select count(*) from public.operation_log where owner_id = '{member}'", service=True) == [["0"]]


def test_a_member_spends_the_pool_and_the_owner_sees_who(tmp_path, pg):
    client, fake = make(tmp_path, pg)
    owner, (member,) = team(client, fake, pg, 1)
    before = client.get("/me/credits", headers=auth(owner)).json()["available"]
    assert export(client, member, designed(client, pg, member)).status_code == 200
    assert client.get("/me/credits", headers=auth(owner)).json()["available"] == before - 10
    usage = client.get("/credits/usage", headers=auth(owner)).json()
    spend = next(e for e in usage["entries"]["items"] if e["kind"] == "spend")
    assert spend["acting_user"] == {"id": member, "email": email(member)} and spend["design_id"] is None
    assert usage["spent_this_month"] == 10
    assert len(client.get("/exports", headers=auth(member)).json()["items"]) == 1  # the member's own history
    assert client.get("/exports", headers=auth(owner)).json()["items"] == []  # not the member's


def test_removing_a_member_stops_pool_access_at_once(tmp_path, pg):
    client, fake = make(tmp_path, pg)
    owner, (member,) = team(client, fake, pg, 1)
    design = designed(client, pg, member)
    assert export(client, member, design).status_code == 200
    assert client.delete(f"/team/members/{owner}", headers=auth(owner)).status_code == 409  # not yourself
    assert client.delete(f"/team/members/{member}", headers=auth(owner)).json() == {"status": "removed"}
    assert export(client, member, design).status_code == 402  # no pool, and no new free credits after a team
    assert client.get("/me/credits", headers=auth(member)).json()["plan"] == "free"
    assert client.delete(f"/team/members/{member}", headers=auth(owner)).status_code == 404


def test_another_owner_cannot_touch_this_team(tmp_path, pg):
    client, fake = make(tmp_path, pg)
    a, (member,) = team(client, fake, pg, 1)
    b = new_user(pg)
    on_plan(client, fake, b)
    created = client.post("/team/invites", json={"email": "z@example.com"}, headers=auth(a)).json()["invite"]
    assert client.delete(f"/team/invites/{created['id']}", headers=auth(b)).status_code == 404
    assert client.delete(f"/team/members/{member}", headers=auth(b)).status_code == 404
    assert client.get("/team", headers=auth(b)).json()["members"] == []
    assert client.delete(f"/team/invites/{created['id']}", headers=auth(a)).json() == {"status": "revoked"}
    assert client.delete("/team/invites/not-a-uuid", headers=auth(a)).status_code == 404


def test_an_extra_seat_adds_its_credits_once_and_cancelling_stops_the_next_grant(tmp_path, pg, monkeypatch):
    client, fake = make(tmp_path, pg)
    owner = new_user(pg)
    on_plan(client, fake, owner)
    url = client.post("/team/seats", headers=auth(owner)).json()["url"]
    assert url.startswith("https://checkout.invalid/fake?") and "kind=seat" in url
    seat = {"kind": "seat", "status": "active", "subscription_id": f"seat_{owner[:8]}", "metadata": {"user_id": owner}}
    raw, headers = signed(fake, {"id": "evt_seat_1", **seat})
    assert client.post("/webhooks/billing", content=raw, headers=headers).json()["result"] == "applied"
    assert client.post("/webhooks/billing", content=raw, headers=headers).json()["result"] == "duplicate"  # replay
    assert webhook(client, fake, seat) == "applied"  # a second event for the same month
    grants = lambda: pg.sql(f"select ref, delta from public.credit_ledger where owner_id = '{owner}' and reason = 'seat_grant'",  # noqa: E731
                            service=True)
    assert grants() == [[f"seat:seat_{owner[:8]}:{plan_math.month_start():%Y-%m-%d}", "1000"]]
    assert client.get("/team", headers=auth(owner)).json()["seats"]["total"] == 5
    client.get("/me/credits", headers=auth(owner))  # the monthly top-up: still the one grant this month
    assert len(grants()) == 1
    assert webhook(client, fake, {**seat, "status": "canceled"}) == "applied"
    assert client.get("/team", headers=auth(owner)).json()["seats"]["total"] == 4
    next_month = datetime(2099, 2, 1, tzinfo=timezone.utc)
    monkeypatch.setattr(plan_math, "month_start", lambda now=None: next_month if now is None else now.replace(day=1))
    client.get("/me/credits", headers=auth(owner))
    assert len(grants()) == 1  # no seat grant for the next month


def test_extra_seats_not_available_without_the_whop_add_on():
    from stitchbook_api.payments import SeatsUnavailable, WhopProvider
    whop = WhopProvider("k", "ws_x", "sandbox", {("pro", "month"): "plan_P"}, None, lambda: 5, 300)
    with pytest.raises(SeatsUnavailable):
        whop.create_seat_checkout(str(uuid.uuid4()))


def test_the_plan_ending_ends_the_team(tmp_path, pg):
    client, fake = make(tmp_path, pg)
    owner, (member,) = team(client, fake, pg, 1)
    design = designed(client, pg, member)
    on_plan(client, fake, owner, status="canceled", end=None)  # deactivated now
    assert pg.sql(f"select count(*) from public.team_members where user_id = '{member}'", service=True) == [["0"]]
    assert client.get(f"/designs/{design}", headers=auth(member)).status_code == 200  # designs stay theirs
    assert client.get("/me/credits", headers=auth(member)).json()["plan"] == "free"
    assert export(client, member, design).status_code == 402  # Free rules, no new free credits


def test_accepting_needs_a_sign_in_and_the_token_is_never_logged(tmp_path, pg, caplog):
    client, fake = make(tmp_path, pg)
    owner = new_user(pg)
    on_plan(client, fake, owner)
    u = new_user(pg)
    with caplog.at_level("DEBUG"):
        tok = invite(client, owner, u)
        assert client.post("/team/invites/accept", json={"token": tok}).status_code == 401
        join(client, u, tok)
    assert tok not in caplog.text
    stored = pg.sql(f"select token_hash from public.team_invites where owner_id = '{owner}'", service=True)
    assert tok not in json.dumps(stored) and len(stored[0][0]) == 64
