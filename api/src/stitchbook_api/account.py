"""Export history and Credit usage, read AS THE SIGNED-IN USER (Step 13d).

Everything here goes through migration 7's my_* functions with the user's own token and the
publishable key, so Supabase's row level security decides what is returned. No secret key.
(Which plan the user is on, and so whether they may see this at all, is decided by
stitchbook_api.billing, like every other plan check.)
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Callable, Protocol

import httpx

from stitchbook_api.records import as_uuid


class UsageUnavailable(RuntimeError):
    """The database could not be reached or refused the read."""


class UserRpc(Protocol):
    """Runs one of migration 7's my_* functions as the signed-in user."""
    def call(self, fn: str, args: dict[str, Any]) -> Any: ...


class SupabaseUserRpc:
    def __init__(self, url: str, publishable_key: str, token: str, timeout_s: Callable[[], float], http: httpx.Client):
        self.base = f"{url.rstrip('/')}/rest/v1/rpc"
        self.headers = {"apikey": publishable_key, "Authorization": f"Bearer {token}"}
        self.timeout_s = timeout_s
        self.http = http

    def call(self, fn: str, args: dict[str, Any]) -> Any:
        try:
            response = self.http.post(f"{self.base}/{fn}", json=args, headers=self.headers, timeout=self.timeout_s())
        except httpx.HTTPError as exc:
            raise UsageUnavailable("the database could not be reached") from exc
        if response.status_code >= 300:
            raise UsageUnavailable(f"{fn} failed ({response.status_code})")
        return response.json() if response.content else None


def page_of(rows: list[dict], page: int, size: int) -> dict:
    """Rows fetched with limit size+1: the page, and whether there is another."""
    return {"items": rows[:size], "page": page, "page_size": size, "has_more": len(rows) > size}


def export_history(rpc: UserRpc, page: int, size: int) -> dict:
    rows = rpc.call("my_export_history", {"p_limit": size + 1, "p_offset": (page - 1) * size}) or []
    items = [{"job_id": r["job_id"], "design_id": as_hex(r.get("design_id")), "design_name": r.get("design_name"),
              "format": r.get("format"), "bytes": r.get("bytes"), "credits": r.get("credits"),
              "finished_at": r.get("finished_at")} for r in rows]
    return page_of(items, page, size)


def credit_usage(rpc: UserRpc, page: int, size: int, month_start: datetime) -> dict:
    balance = {r["bucket"]: {"available": r["available"], "reserved": r["reserved"], "consumed": r["consumed"]}
               for r in rpc.call("my_credit_balance", {}) or []}
    sub = (rpc.call("my_subscription", {}) or [None])[0]
    entries = rpc.call("my_credit_entries", {"p_limit": size + 1, "p_offset": (page - 1) * size}) or []
    renewal = None
    if sub and sub.get("plan") != "free" and sub.get("current_period_end"):
        renewal = {"date": sub["current_period_end"], "renews": sub.get("status") == "active"}
    return {
        "enabled": True,
        "balances": balance,
        "available": sum(b["available"] for b in balance.values()),
        "renewal": renewal,
        "spent_this_month": rpc.call("my_credits_spent", {"p_since": month_start.isoformat()}) or 0,
        "entries": page_of([{"kind": e["kind"], "reason": e["reason"], "amount": e["amount"], "bucket": e.get("bucket"),
                             "at": e["at"], "operation": e.get("operation"), "design_id": as_hex(e.get("design_id")),
                             "acting_user": ({"id": e["acting_user_id"], "email": e.get("acting_email")}
                                             if e.get("acting_user_id") else None)} for e in entries], page, size),
    }


def as_hex(design_id: str | None) -> str | None:
    """Design ids as the web app uses them (32 hex characters)."""
    return as_uuid(design_id).replace("-", "") if design_id else None
