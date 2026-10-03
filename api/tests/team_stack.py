"""A real API for the team screenshots (web/scripts/team-screens.mjs): the real create_app on the
real migration 1-7 SQL (a throwaway local Postgres), the FakeProvider for payments and a stand-in
for Supabase Auth's signing keys (test_auth.py). Four users are made the way real ones would be,
through the API and signed FakeProvider webhooks: Free, Pro, a Business owner and a Business
member (invited and accepted through the API). Each has done one export.

Prints one line `READY {json}` (users: id, email, access token) and serves on 127.0.0.1:<port>
until stopped. Not a test file; run by the screenshot script only.
Usage: python api/tests/team_stack.py <port> <web origin>
"""

from __future__ import annotations

import json
import os
import signal
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import httpx  # noqa: E402
import uvicorn  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from billing_pg import PgRpc, PgUserRpc, start_postgres  # noqa: E402
from stitchbook_api.auth import SupabaseAuth  # noqa: E402
from stitchbook_api.billing import Billing  # noqa: E402
from stitchbook_api.main import create_app  # noqa: E402
from stitchbook_api.payments import FakeProvider  # noqa: E402
from stitchbook_api.settings import Settings  # noqa: E402
from stitchbook_api.storage import LocalDiskStorage  # noqa: E402
from test_auth import URL, FakeSupabaseAuth, token  # noqa: E402
from test_billing_api import CONFIG, designed, new_user, signed  # noqa: E402
from test_teams_api import TEAMS  # noqa: E402

SECRET = "team-screens-fake-provider-secret"


def main(port: int, origin: str) -> None:
    os.environ["STITCHBOOK_TEST_PG_PORT"] = "55439"  # never the port the test suites use
    pg = start_postgres()
    signal.signal(signal.SIGTERM, lambda *_: (pg.stop(), os._exit(0)))
    store = Path(f"/tmp/stitchbook-team-stack-{uuid.uuid4().hex[:8]}")
    http = httpx.Client(transport=httpx.MockTransport(FakeSupabaseAuth()))
    auth = SupabaseAuth(URL, "sb_publishable_test", timeout_s=lambda: 5, cache_s=lambda: 300, http=http)
    settings = Settings("redis://127.0.0.1:1", "digitize", origin, str(store), False, "info")
    fake = FakeProvider(SECRET)
    config = TEAMS if "--teams" in sys.argv else CONFIG
    app = create_app(config, LocalDiskStorage(store), settings, auth=auth, billing=Billing(PgRpc(pg), config),
                     provider=fake, usage_for=lambda u: PgUserRpc(pg, u.id))
    client = TestClient(app)
    users = {}
    for who in ("free", "pro", "owner", "member"):
        uid = new_user(pg)
        users[who] = {"id": uid, "email": f"{uid[:8]}@example.com",
                      "token": token(uid, email=f"{uid[:8]}@example.com", exp=int(time.time()) + 4 * 3600)}

    def headers(who):
        return {"Authorization": f"Bearer {users[who]['token']}"}

    def paid(who, plan):
        raw, h = signed(fake, {"id": f"evt_{uuid.uuid4().hex}", "plan": plan, "interval": "month", "status": "active",
                               "period_end": "2099-01-01T00:00:00+00:00", "subscription_id": f"sub_{who}",
                               "metadata": {"user_id": users[who]["id"]}})
        assert client.post("/webhooks/billing", content=raw, headers=h).json()["result"] == "applied"

    paid("pro", "pro")
    paid("owner", "business")
    made = client.post("/team/invites", json={"email": users["member"]["email"]}, headers=headers("owner")).json()
    assert client.post("/team/invites/accept", json={"token": made["token"]}, headers=headers("member")).json() == {"status": "joined"}
    for who in ("free", "pro", "owner", "member"):
        client.get("/me/credits", headers=headers(who))
        design = designed_as(client, pg, users[who]["id"], headers(who))
        assert client.get(f"/designs/{design}/download?format=dst", headers=headers(who)).status_code == 200, who
    print("READY " + json.dumps({"users": users}), flush=True)
    try:
        uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
    finally:
        pg.stop()


def designed_as(client, pg, user, headers) -> str:
    """test_billing_api.designed(), with this user's own token (it carries their email)."""
    import test_billing_api
    original = test_billing_api.auth
    test_billing_api.auth = lambda _user: headers
    try:
        return designed(client, pg, user)
    finally:
        test_billing_api.auth = original


if __name__ == "__main__":
    main(int(sys.argv[1]), sys.argv[2])
