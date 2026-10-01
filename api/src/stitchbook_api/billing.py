"""Credits and plans: the ONLY module that uses the Supabase secret key (service role).

Everything that changes credits goes through the security-definer functions of migration 5
(reserve_credit, consume_credit, release_credit, grant_credits, release_stale_reservations,
apply_billing_event), which lock the owner's row so concurrent operations never double-spend.

Flow for a metered operation (export now; satin columns / auto-digitize once their cost is set):
    start()   before the work (or before enqueuing): reserves the cost and logs 'started';
              not enough credits -> InsufficientCredits (the API answers 402, nothing runs)
    succeed() only when it worked: the reservation is consumed
    fail()    on failure or cancel: the reservation is released (never after a success)
All three are retry-safe (keyed by job id). A sweep releases reservations left open too long.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Protocol

import httpx
from digitizer.config import Config

from stitchbook_api import plans as plan_math
from stitchbook_api.records import as_uuid

log = logging.getLogger("stitchbook_api.billing")


class InsufficientCredits(Exception):
    def __init__(self, available: int, needed: int, plan: str | None = None):
        super().__init__("insufficient_credits")
        self.available, self.needed, self.plan = available, needed, plan


class BillingUnavailable(RuntimeError):
    """The billing database could not be reached or refused the call."""


class Rpc(Protocol):
    """Calls one of migration 5's functions, or reads a billing table, as the service role."""
    def call(self, fn: str, args: dict[str, Any]) -> Any: ...
    def select(self, table: str, owner_id: str, order: str | None = None, limit: int | None = None) -> list[dict]: ...


class SupabaseRpc:
    """The functions through Supabase's REST API (PostgREST /rpc), with the secret key."""

    def __init__(self, url: str, secret_key: str, timeout_s: Callable[[], float], http: httpx.Client):
        self.base = f"{url.rstrip('/')}/rest/v1"
        self.headers = {"apikey": secret_key, "Authorization": f"Bearer {secret_key}"}
        self.timeout_s = timeout_s
        self.http = http

    def _send(self, method: str, path: str, **kwargs) -> httpx.Response:
        try:
            return self.http.request(method, f"{self.base}/{path}", headers=self.headers, timeout=self.timeout_s(), **kwargs)
        except httpx.HTTPError as exc:
            raise BillingUnavailable("the billing database could not be reached") from exc

    def call(self, fn: str, args: dict[str, Any]) -> Any:
        response = self._send("POST", f"rpc/{fn}", json=args)
        if response.status_code >= 300:
            try:
                body = response.json()
            except ValueError:
                body = {}
            if body.get("message") == "insufficient_credits":
                detail = json.loads(body.get("details") or "{}")
                raise InsufficientCredits(int(detail.get("available", 0)), int(detail.get("needed", 0)))
            raise BillingUnavailable(f"{fn} failed ({response.status_code})")
        return response.json() if response.content else None

    def select(self, table: str, owner_id: str, order: str | None = None, limit: int | None = None) -> list[dict]:
        params: dict[str, Any] = {"owner_id": f"eq.{owner_id}", "select": "*"}
        if order:
            params["order"] = order
        if limit:
            params["limit"] = limit
        response = self._send("GET", table, params=params)
        if response.status_code >= 300:
            raise BillingUnavailable(f"reading {table} failed ({response.status_code})")
        return response.json()


@dataclass
class Plan:
    id: str
    name: str | None
    interval: str | None
    status: str
    subscription_id: str | None


class Billing:
    """Credits for signed-in users, on top of the migration-5 functions."""
    enabled = True

    def __init__(self, rpc: Rpc, config: Config):
        self.rpc = rpc
        self.config = config

    # ---------- plan and grants ----------
    def plan(self, owner: str) -> Plan:
        rows = self.rpc.select("subscriptions", owner)
        sub = rows[0] if rows else None
        now = datetime.now(timezone.utc)
        end = _time(sub.get("current_period_end")) if sub else None
        entitled = bool(sub) and sub["plan"] != "free" and (
            sub["status"] == "active" or (sub["status"] == "canceled" and end is not None and end > now))
        plan_id = sub["plan"] if entitled else "free"
        return Plan(plan_id, plan_math.plan_name(self.config, plan_id), sub.get("billing_interval") if entitled else None,
                    sub["status"] if sub else "active", sub.get("provider_subscription_id") if sub else None)

    def ensure_grants(self, owner: str, plan: Plan | None = None) -> Plan:
        """The Free grant once per account (ref "free_grant"), and this UTC month's plan allowance
        once per subscription and month (ref "plan:{subscription}:{period_start}")."""
        plan = plan or self.plan(owner)
        free = plan_math.plan_credits(self.config, "free")
        if free:
            self.rpc.call("grant_credits", {"p_owner": owner, "p_amount": free, "p_bucket": "plan", "p_reason": "free_grant",
                                            "p_ref": "free_grant", "p_expires_at": None})
        if plan.id != "free" and plan.subscription_id:
            monthly = plan_math.plan_credits(self.config, plan.id)
            if monthly:
                start = plan_math.month_start()
                rollover = plan_math.chosen(self.config, "billing.monthly_rollover")
                expires = None if rollover else plan_math.month_end(start).isoformat()
                self.rpc.call("grant_credits", {"p_owner": owner, "p_amount": monthly, "p_bucket": "plan",
                                                "p_reason": "plan_grant", "p_ref": grant_ref(plan.subscription_id, start),
                                                "p_expires_at": expires})
        return plan

    # ---------- balances and history ----------
    def balances(self, owner: str) -> dict[str, dict[str, int]]:
        rows = self.rpc.call("credit_balance", {"p_owner": owner}) or []
        return {r["bucket"]: {"available": r["available"], "reserved": r["reserved"], "consumed": r["consumed"]} for r in rows}

    def account(self, owner: str, history: int | None = None) -> dict[str, Any]:
        plan = self.ensure_grants(owner)
        balances = self.balances(owner)
        log_rows = self.rpc.select("operation_log", owner, order="created_at.desc", limit=history)
        return {
            "enabled": True,
            "plan": plan.id, "plan_name": plan.name, "interval": plan.interval, "status": plan.status,
            "balances": balances,
            "available": sum(b["available"] for b in balances.values()),
            "costs": {k: plan_math.credit_cost(self.config, k) for k in plan_math.operation_kinds(self.config)},
            "history": [{k: r.get(k) for k in ("job_id", "design_id", "operation", "format", "status", "credits",
                                                 "created_at", "finished_at", "error")} for r in log_rows],
        }

    # ---------- operations ----------
    def start(self, owner: str, design_id: str | None, job_id: str, operation: str, fmt: str | None,
              settings: dict[str, Any]) -> int:
        """Logs the operation and reserves its cost. Returns the credits reserved (0 = free)."""
        amount = plan_math.credit_cost(self.config, operation)
        plan = self.ensure_grants(owner) if amount else None
        try:
            out = self.rpc.call("reserve_credit", {"p_owner": owner, "p_design": as_uuid(design_id) if design_id else None,
                                                   "p_job": job_id, "p_operation": operation, "p_format": fmt,
                                                   "p_settings": settings, "p_amount": amount})
        except InsufficientCredits as exc:
            exc.plan = plan.id if plan else None
            raise
        return int((out or {}).get("amount", amount))

    def succeed(self, owner: str, job_id: str) -> None:
        self.rpc.call("consume_credit", {"p_owner": owner, "p_job": job_id})

    def fail(self, owner: str, job_id: str, reason: str, cancelled: bool = False) -> None:
        self.rpc.call("release_credit", {"p_owner": owner, "p_job": job_id, "p_reason": reason[:500],
                                         "p_status": "cancelled" if cancelled else "failed"})

    def sweep(self, older_than_s: float) -> int:
        return int(self.rpc.call("release_stale_reservations", {"p_older_than": f"{int(older_than_s)} seconds"}) or 0)

    # ---------- provider events ----------
    def apply_event(self, provider: str, event: Any) -> str:
        """A verified provider event: subscription update + this period's plan credits, once."""
        monthly = plan_math.plan_credits(self.config, event.plan) if event.plan != "free" and event.status == "active" else None
        start = plan_math.month_start()
        rollover = plan_math.chosen(self.config, "billing.monthly_rollover")
        return self.rpc.call("apply_billing_event", {
            "p_provider": provider, "p_event_id": event.id, "p_owner": event.owner_id, "p_plan": event.plan,
            "p_interval": event.interval, "p_status": event.status,
            "p_period_end": event.period_end.isoformat() if event.period_end else None,
            "p_customer": event.customer_id, "p_subscription": event.subscription_id,
            "p_grant_amount": monthly or 0,
            "p_grant_ref": grant_ref(event.subscription_id, start) if monthly and event.subscription_id else None,
            "p_grant_expires_at": None if rollover else plan_math.month_end(start).isoformat(),
        })


class FreeOperations:
    """Local mode with STITCHBOOK_FREE_OPERATIONS=1: no billing at all, every operation is free."""
    enabled = False

    def account(self, owner: str, history: int | None = None) -> dict[str, Any]:
        return {"enabled": False}

    def start(self, *args, **kwargs) -> int:
        return 0

    def succeed(self, *args, **kwargs) -> None:
        return None

    def fail(self, *args, **kwargs) -> None:
        return None

    def sweep(self, older_than_s: float) -> int:
        return 0


def grant_ref(subscription_id: str, period_start: datetime) -> str:
    return f"plan:{subscription_id}:{period_start:%Y-%m-%d}"


def _time(value: str | None) -> datetime | None:
    if not value:
        return None
    t = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)
