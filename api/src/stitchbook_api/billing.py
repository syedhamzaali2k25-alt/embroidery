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


# Named refusals raised by migration 7's team functions.
TEAM_ERRORS = {"business_required", "not_team_owner", "no_seats", "invite_invalid", "invite_used", "invite_expired",
               "invite_own_team", "invite_other_email", "already_in_team", "has_own_plan", "team_inactive",
               "cannot_remove_owner"}


class TeamError(Exception):
    """A team change the database refused (no seats, used invite, ...): code is the reason."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class Rpc(Protocol):
    """Calls one of migration 5's functions, or reads a billing table, as the service role."""
    def call(self, fn: str, args: dict[str, Any]) -> Any: ...
    def select(self, table: str, owner_id: str, order: str | None = None, limit: int | None = None) -> list[dict]: ...
    def select_by(self, table: str, column: str, value: str) -> list[dict]: ...


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
            if body.get("message") in TEAM_ERRORS:
                raise TeamError(body["message"])
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

    def select_by(self, table: str, column: str, value: str) -> list[dict]:
        response = self._send("GET", table, params={column: f"eq.{value}", "select": "*"})
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
    team_role: str | None = None   # "owner" or "member" when in a team
    pool_owner: str | None = None  # a member: whose credits they spend


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

    def membership(self, user: str) -> dict | None:
        rows = self.rpc.select_by("team_members", "user_id", user)
        return rows[0] if rows else None

    def effective(self, user: str) -> Plan:
        """The plan that applies to the user: a member of an active Business team gets the team's
        plan (and spends the owner's credits); everyone else their own."""
        m = self.membership(user)
        if m and m["role"] == "member":
            pool = self.plan(str(m["owner_id"]))
            if pool.id == "business":
                return Plan(pool.id, pool.name, None, "active", None, team_role="member", pool_owner=str(m["owner_id"]))
        own = self.plan(user)
        if m and m["role"] == "owner":
            own.team_role = "owner"
        return own

    def ensure_grants(self, owner: str, plan: Plan | None = None) -> Plan:
        """The Free grant once per account (ref "free_grant"; never to someone who has joined a
        team), this UTC month's plan allowance once per subscription and month (ref
        "plan:{subscription}:{period_start}"), and a Business owner's extra-seat credits once per
        seat and month (ref "seat:{subscription}:{period_start}"). A team member's grants are
        their pool owner's."""
        plan = plan or self.effective(owner)
        if plan.team_role == "member" and plan.pool_owner:
            self.ensure_grants(plan.pool_owner)  # the pool's grants, so members never wait on the owner
            return plan
        free = plan_math.plan_credits(self.config, "free")
        joined = self.rpc.select_by("team_invites", "accepted_by", owner) if free else []
        if free and not joined:
            self.rpc.call("grant_credits", {"p_owner": owner, "p_amount": free, "p_bucket": "plan", "p_reason": "free_grant",
                                            "p_ref": "free_grant", "p_expires_at": None})
        start = plan_math.month_start()
        rollover = plan_math.chosen(self.config, "billing.monthly_rollover")
        expires = None if rollover else plan_math.month_end(start).isoformat()
        if plan.id != "free" and plan.subscription_id:
            monthly = plan_math.plan_credits(self.config, plan.id)
            if monthly:
                self.rpc.call("grant_credits", {"p_owner": owner, "p_amount": monthly, "p_bucket": "plan",
                                                "p_reason": "plan_grant", "p_ref": grant_ref(plan.subscription_id, start),
                                                "p_expires_at": expires})
        if plan.id == "business":
            seat_credits = plan_math.chosen(self.config, "billing.team.extra_seat_credits")
            for seat in self.rpc.select("team_extra_seats", owner) if seat_credits else []:
                if seat.get("status") == "active":
                    self.rpc.call("grant_credits", {"p_owner": owner, "p_amount": seat_credits, "p_bucket": "plan",
                                                    "p_reason": "seat_grant",
                                                    "p_ref": seat_ref(seat["provider_subscription_id"], start),
                                                    "p_expires_at": expires})
        return plan

    # ---------- balances and history ----------
    def balances(self, owner: str) -> dict[str, dict[str, int]]:
        rows = self.rpc.call("credit_balance", {"p_owner": owner}) or []
        return {r["bucket"]: {"available": r["available"], "reserved": r["reserved"], "consumed": r["consumed"]} for r in rows}

    def account(self, owner: str, history: int | None = None) -> dict[str, Any]:
        plan = self.ensure_grants(owner)
        log_rows = self.rpc.select("operation_log", owner, order="created_at.desc", limit=history)
        costs = {k: plan_math.credit_cost(self.config, k) for k in plan_math.operation_kinds(self.config)}
        own_history = [{k: r.get(k) for k in ("job_id", "design_id", "operation", "format", "status", "credits",
                                              "created_at", "finished_at", "error")} for r in log_rows]
        if plan.team_role == "member":
            # A member sees what the team can still spend, and their own operations; never the
            # owner's grants, reservations or anyone else's activity.
            pool = sum(b["available"] for b in self.balances(plan.pool_owner).values())
            empty = {"available": 0, "reserved": 0, "consumed": 0}
            return {"enabled": True, "plan": plan.id, "plan_name": plan.name, "interval": None, "status": "active",
                    "team": {"role": "member"}, "balances": {"plan": {**empty, "available": pool}, "purchased": empty},
                    "available": pool, "costs": costs, "history": own_history}
        balances = self.balances(owner)
        return {
            "enabled": True,
            "plan": plan.id, "plan_name": plan.name, "interval": plan.interval, "status": plan.status,
            "team": {"role": "owner"} if plan.team_role == "owner" else None,
            "balances": balances,
            "available": sum(b["available"] for b in balances.values()),
            "costs": costs,
            "history": own_history,
        }

    # ---------- teams (migration 7) ----------
    def team_view(self, owner: str) -> dict[str, Any]:
        """The owner's team: members, open invites, seats used and total."""
        included = self.config.get("billing.team.included_seats")
        members = self.rpc.select("team_members", owner, order="joined_at.asc")
        now = datetime.now(timezone.utc)
        invites = [i for i in self.rpc.select("team_invites", owner, order="created_at.desc")
                   if not i.get("accepted_at") and not i.get("revoked_at") and _time(i["expires_at"]) > now]
        extra = sum(1 for x in self.rpc.select("team_extra_seats", owner) if x.get("status") == "active")
        used = len(members) or 1  # the owner always holds a seat, even before the team row exists
        return {
            "members": [{"user_id": str(m["user_id"]), "email": m.get("email"), "role": m["role"], "joined_at": m["joined_at"]}
                        for m in members if m["role"] == "member"],
            "invites": [{"id": str(i["id"]), "email": i["email"], "expires_at": i["expires_at"]} for i in invites],
            "seats": {"used": used, "total": included + extra, "included": included, "extra": extra},
        }

    def create_invite(self, owner: str, email: str, token_hash: str, expires_at: datetime) -> str:
        return str(self.rpc.call("team_create_invite", {
            "p_owner": owner, "p_email": email, "p_token_hash": token_hash, "p_expires_at": expires_at.isoformat(),
            "p_included_seats": self.config.get("billing.team.included_seats")}))

    def accept_invite(self, user: str, email: str | None, token_hash: str) -> dict:
        return self.rpc.call("team_accept_invite", {"p_user": user, "p_email": email, "p_token_hash": token_hash,
                                                    "p_included_seats": self.config.get("billing.team.included_seats")})

    def remove_member(self, owner: str, user: str) -> bool:
        return bool(self.rpc.call("team_remove_member", {"p_owner": owner, "p_user": user}))

    def revoke_invite(self, owner: str, invite_id: str) -> bool:
        return bool(self.rpc.call("team_revoke_invite", {"p_owner": owner, "p_invite": invite_id}))

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
        """A verified provider event: subscription update + this period's plan credits, once.

        The owner is the user id in the provider's signed metadata. An event without one (a
        renewal payment, say) belongs to whoever that subscription was first bound to, by an
        earlier signed event. Never applied:
          - an event whose owner is not a Stitchbook account ("ignored: unknown owner");
          - an event naming another owner than the one its subscription is bound to
            ("ignored: owner mismatch"): credits never move to a different user;
          - a cancel / failure of a subscription that is no longer the owner's current one
            ("ignored: not the current subscription"), so an old plan cannot end the new one.
        """
        if getattr(event, "kind", "plan") == "seat":
            return self.apply_seat_event(provider, event)
        bound = [r for r in (self.rpc.select_by("subscriptions", "provider_subscription_id", event.subscription_id)
                             if event.subscription_id else []) if r.get("provider") == provider]
        bound_owner = bound[0]["owner_id"] if bound else None
        if event.owner_id and bound_owner and str(bound_owner) != event.owner_id:
            log.warning("billing event %s names another owner than its subscription's: ignored", event.id)
            return "ignored: owner mismatch"
        owner = event.owner_id or (str(bound_owner) if bound_owner else None)
        if not owner or not self.rpc.select_by("profiles", "id", owner):
            log.warning("billing event %s (%s) has no known owner: nothing applied", event.id, event.type)
            return "ignored: unknown owner"
        rows = self.rpc.select("subscriptions", owner)
        current = rows[0] if rows else None
        same = bool(current) and current.get("provider_subscription_id") == event.subscription_id
        if current and not same and current.get("provider_subscription_id") and current.get("status") == "active" \
                and event.status != "active":
            log.info("billing event %s is for an earlier subscription: ignored", event.id)
            return "ignored: not the current subscription"
        period_end = event.period_end
        if not getattr(event, "has_period", True):  # payment events: keep the period we know
            period_end = _time(current.get("current_period_end")) if same else None
        grant = getattr(event, "grant", True)
        monthly = plan_math.plan_credits(self.config, event.plan) if grant and event.plan != "free" and event.status == "active" else None
        start = plan_math.month_start(getattr(event, "period_start", None))
        rollover = plan_math.chosen(self.config, "billing.monthly_rollover")
        result = self.rpc.call("apply_billing_event", {
            "p_provider": provider, "p_event_id": event.id, "p_owner": owner, "p_plan": event.plan,
            "p_interval": event.interval, "p_status": event.status,
            "p_period_end": period_end.isoformat() if period_end else None,
            "p_customer": event.customer_id, "p_subscription": event.subscription_id,
            "p_grant_amount": monthly or 0,
            "p_grant_ref": grant_ref(event.subscription_id, start) if monthly and event.subscription_id else None,
            "p_grant_expires_at": None if rollover else plan_math.month_end(start).isoformat(),
        })
        if result == "applied":
            # A Business plan that has ended takes the team with it (no-op while still active).
            removed = self.rpc.call("team_end", {"p_owner": owner})
            if removed:
                log.info("billing event %s ended a team: %s member(s) back on their own account", event.id, removed)
        return result

    def apply_seat_event(self, provider: str, event: Any) -> str:
        """An extra seat bought, renewed or cancelled: the seat's status, and this period's seat
        credits (billing.team.extra_seat_credits) once. The owner comes from the signed metadata,
        or from the account the seat was first bound to."""
        bound = [r for r in (self.rpc.select_by("team_extra_seats", "provider_subscription_id", event.subscription_id)
                             if event.subscription_id else []) if r.get("provider") == provider]
        bound_owner = str(bound[0]["owner_id"]) if bound else None
        if event.owner_id and bound_owner and bound_owner != event.owner_id:
            log.warning("seat event %s names another owner than its seat's: ignored", event.id)
            return "ignored: owner mismatch"
        owner = event.owner_id or bound_owner
        if not owner or not event.subscription_id or not self.rpc.select_by("profiles", "id", owner):
            log.warning("seat event %s has no known owner: nothing applied", event.id)
            return "ignored: unknown owner"
        credits = plan_math.chosen(self.config, "billing.team.extra_seat_credits") if getattr(event, "grant", True) else None
        start = plan_math.month_start(getattr(event, "period_start", None))
        rollover = plan_math.chosen(self.config, "billing.monthly_rollover")
        return self.rpc.call("apply_seat_event", {
            "p_provider": provider, "p_event_id": event.id, "p_owner": owner, "p_subscription": event.subscription_id,
            "p_status": event.status, "p_period_end": event.period_end.isoformat() if event.period_end else None,
            "p_grant_amount": credits or 0,
            "p_grant_ref": seat_ref(event.subscription_id, start) if credits else None,
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


def seat_ref(subscription_id: str, period_start: datetime) -> str:
    return f"seat:{subscription_id}:{period_start:%Y-%m-%d}"


def grant_ref(subscription_id: str, period_start: datetime) -> str:
    return f"plan:{subscription_id}:{period_start:%Y-%m-%d}"


def _time(value: str | None) -> datetime | None:
    if not value:
        return None
    t = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)
