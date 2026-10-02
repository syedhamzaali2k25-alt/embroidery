"""Payment providers behind one small interface, so a real (or local) gateway can be added later.

A provider:
  create_checkout(user_id, email, plan, interval) -> URL of the provider's checkout page; the
                      user id goes into the provider's signed metadata, never from our request body
  verify_webhook(headers, raw_body) -> Event; raises BadSignature BEFORE anything is parsed
  cancel_subscription(subscription_id)

  manage_url(subscription_id) -> the provider's own page where the buyer manages the plan, or None

FakeProvider: tests and local development (HMAC-SHA256 over the raw body).
WhopProvider: Whop (docs/payments-whop.md), sandbox first. While billing.provider is unset,
payments answer 503 "Payments are not available yet".
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Mapping, Protocol
from urllib.parse import quote, urlencode

import httpx

log = logging.getLogger("stitchbook_api.payments")


class NotConfigured(RuntimeError):
    """No payment provider is set up."""


class BadSignature(ValueError):
    """The webhook's signature does not match: the body is not trusted or parsed."""


class IgnoredEvent(Exception):
    """A correctly signed event that changes nothing here (another event type, another product's
    plan, a refund). The webhook answers 200 so the provider does not retry, and logs it."""


class ProviderError(RuntimeError):
    """The provider could not be reached or refused a call (checkout, cancel, manage link)."""


@dataclass(frozen=True)
class Event:
    id: str
    type: str
    owner_id: str | None    # from the provider's signed metadata only; None = not in this event
    plan: str               # free | pro | business
    interval: str | None    # month | year
    status: str             # active | past_due | canceled
    period_end: datetime | None
    customer_id: str | None
    subscription_id: str | None
    grant: bool = True               # give this period's plan credits (if active)
    period_start: datetime | None = None  # when the paid period began (None = now)
    has_period: bool = True          # False: the event does not carry the period end (keep ours)


class Provider(Protocol):
    name: str
    def create_checkout(self, user_id: str, email: str | None, plan: str, interval: str) -> str: ...
    def verify_webhook(self, headers: Mapping[str, str], raw_body: bytes) -> Event: ...
    def cancel_subscription(self, subscription_id: str) -> None: ...
    def manage_url(self, subscription_id: str) -> str | None: ...


PLANS = {"free", "pro", "business"}
INTERVALS = {"month", "year"}
STATUSES = {"active", "past_due", "canceled"}


class FakeProvider:
    """A stand-in provider. Its "checkout" is a URL nobody can pay at; its webhooks are signed
    with HMAC-SHA256(secret, raw body) in the X-Fake-Signature header (hex). Never in production."""
    name = "fake"
    SIGNATURE_HEADER = "x-fake-signature"

    def __init__(self, secret: str):
        if not secret:
            raise NotConfigured("the fake provider needs STITCHBOOK_FAKE_PROVIDER_SECRET")
        self._secret = secret.encode()
        self.cancelled: list[str] = []

    def sign(self, raw_body: bytes) -> str:
        return hmac.new(self._secret, raw_body, hashlib.sha256).hexdigest()

    def create_checkout(self, user_id: str, email: str | None, plan: str, interval: str) -> str:
        return "https://checkout.invalid/fake?" + urlencode({"plan": plan, "interval": interval, "user": user_id})

    def verify_webhook(self, headers: Mapping[str, str], raw_body: bytes) -> Event:
        given = {k.lower(): v for k, v in headers.items()}.get(self.SIGNATURE_HEADER, "")
        if not given or not hmac.compare_digest(given, self.sign(raw_body)):
            raise BadSignature("webhook signature does not match")
        data = json.loads(raw_body)  # only after the signature matched
        meta = data.get("metadata") or {}
        event = Event(
            id=str(data["id"]), type=str(data.get("type", "")), owner_id=str(meta["user_id"]),
            plan=str(data["plan"]), interval=data.get("interval"), status=str(data["status"]),
            period_end=datetime.fromisoformat(data["period_end"]) if data.get("period_end") else None,
            customer_id=data.get("customer_id"), subscription_id=data.get("subscription_id"),
        )
        if event.plan not in PLANS or event.status not in STATUSES or (event.interval not in INTERVALS | {None}):
            raise ValueError("webhook event has an unknown plan, status or interval")
        return event

    def cancel_subscription(self, subscription_id: str) -> None:
        self.cancelled.append(subscription_id)

    def manage_url(self, subscription_id: str) -> str | None:
        return None


# ---------------------------------------------------------------- Whop

# The two Whop APIs, as in Whop's official Python SDK (whop-sdk 2.0.0, whop_sdk/environment.py).
WHOP_API = {"sandbox": "https://sandbox-api.whop.com/api/v1", "production": "https://api.whop.com/api/v1"}
# The checkout metadata key that carries our user id. Whop copies checkout metadata to the
# payments and memberships it creates, and sends it back inside the signed webhook body.
WHOP_USER_KEY = "stitchbook_user_id"
WHOP_EVENTS = {"membership.activated", "membership.deactivated", "membership.cancel_at_period_end_changed",
               "payment.succeeded", "payment.failed"}


def standard_webhook_signature(secret: bytes, webhook_id: str, timestamp: str, raw_body: bytes) -> str:
    """Standard Webhooks: base64 HMAC-SHA256 of "{webhook-id}.{webhook-timestamp}.{raw body}",
    sent as "v1,<signature>"."""
    digest = hmac.new(secret, f"{webhook_id}.{timestamp}.".encode() + raw_body, hashlib.sha256).digest()
    return "v1," + base64.b64encode(digest).decode()


def verify_standard_webhook(headers: Mapping[str, str], raw_body: bytes, secret: bytes, tolerance_s: float,
                            now: float | None = None) -> str:
    """Checks the webhook-id / webhook-timestamp / webhook-signature headers against the RAW body,
    before anything is parsed. Returns the webhook id. Raises BadSignature when a header is
    missing, the timestamp is further than tolerance_s from now, or no v1 signature matches
    (constant-time compare)."""
    h = {k.lower(): v for k, v in headers.items()}
    webhook_id, stamp, given = h.get("webhook-id", ""), h.get("webhook-timestamp", ""), h.get("webhook-signature", "")
    if not (webhook_id and stamp and given):
        raise BadSignature("missing webhook-id, webhook-timestamp or webhook-signature")
    try:
        sent = int(stamp)
    except ValueError:
        raise BadSignature("webhook-timestamp is not a number") from None
    if abs((time.time() if now is None else now) - sent) > tolerance_s:
        raise BadSignature("webhook-timestamp is too old or too new")
    expected = standard_webhook_signature(secret, webhook_id, stamp, raw_body).encode()
    matched = False
    for candidate in given.split():
        # compare every candidate, so the time taken does not depend on which one matched
        matched |= hmac.compare_digest(candidate.encode(), expected)
    if not matched:
        raise BadSignature("webhook signature does not match")
    return webhook_id


def _ref(value: Any) -> str | None:
    """An id that is either a nested object ({"id": ...}) or a plain string."""
    if isinstance(value, dict):
        value = value.get("id")
    return str(value) if value else None


def _when(value: Any) -> datetime | None:
    """Whop timestamps: Unix seconds or ISO 8601."""
    if value in (None, ""):
        return None
    if isinstance(value, (int, float)) or (isinstance(value, str) and value.replace(".", "", 1).isdigit()):
        return datetime.fromtimestamp(float(value), timezone.utc)
    t = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def _user_id(metadata: Any) -> str | None:
    """Our user id from the signed metadata, only if it is a well-formed UUID."""
    value = (metadata or {}).get(WHOP_USER_KEY) if isinstance(metadata, dict) else None
    try:
        return str(uuid.UUID(str(value))) if value else None
    except ValueError:
        return None


class WhopProvider:
    """Whop: hosted checkout (checkout configurations), Standard Webhooks, membership cancel.

    create_checkout: POST /checkout_configurations {plan_id, metadata: {stitchbook_user_id}, redirect_url}
                     -> the configuration's purchase_url (Whop's hosted checkout page)
    verify_webhook:  Standard Webhooks signature over the raw body (secret used as its literal
                     bytes, as Whop's SDK documents), then the event is mapped:
                       membership.activated                    -> active
                       membership.deactivated                  -> canceled now (back to Free)
                       membership.cancel_at_period_end_changed -> canceled at period end / active again
                       payment.succeeded                       -> active + this month's credits
                       payment.failed                          -> past_due
                     Anything else (refunds included) -> IgnoredEvent: logged, no change.
    cancel_subscription: POST /memberships/{id}/cancel {cancel_at_period_end: true}
    manage_url:      the membership's manage_url (Whop's own page to manage or cancel)
    """
    name = "whop"

    def __init__(self, api_key: str, webhook_secret: str, environment: str, plan_ids: Mapping[tuple[str, str], str],
                 redirect_url: str | None, timeout_s: Callable[[], float], tolerance_s: float,
                 http: httpx.Client | None = None):
        if not api_key or not webhook_secret:
            raise NotConfigured("billing.provider is \"whop\" but WHOP_API_KEY and WHOP_WEBHOOK_SECRET are not both "
                                "set in .env (docs/payments-whop.md, step 2)")
        if environment not in WHOP_API:
            raise NotConfigured("billing.whop_environment must be \"sandbox\" or \"production\" in config.py")
        missing = [f"billing.plans.{p}.whop_plan_ids.{i}" for (p, i), v in plan_ids.items() if not v]
        if missing:
            raise NotConfigured("billing.provider is \"whop\" but these Whop plan ids are not set in config.py: "
                                + ", ".join(missing) + " (docs/payments-whop.md, step 1)")
        self.base = WHOP_API[environment]
        self.environment = environment
        self._key = api_key
        self._secret = webhook_secret.encode()  # literal bytes: what Whop signs with
        self.plan_ids = dict(plan_ids)
        self.plans_by_id = {v: k for k, v in plan_ids.items()}
        self.redirect_url = redirect_url
        self.timeout_s = timeout_s
        self.tolerance_s = tolerance_s
        self.http = http or httpx.Client()

    # ---------- API calls ----------
    def _call(self, method: str, path: str, json_body: dict | None = None) -> dict:
        try:
            response = self.http.request(method, f"{self.base}/{path}", json=json_body, timeout=self.timeout_s(),
                                         headers={"Authorization": f"Bearer {self._key}"})
        except httpx.HTTPError as exc:
            raise ProviderError("Whop could not be reached") from exc
        if response.status_code >= 300:
            log.warning("Whop %s %s answered %s", method, path.split("/")[0], response.status_code)
            raise ProviderError(f"Whop refused the request ({response.status_code})")
        try:
            return response.json()
        except ValueError as exc:
            raise ProviderError("Whop sent an unreadable answer") from exc

    def create_checkout(self, user_id: str, email: str | None, plan: str, interval: str) -> str:
        """A checkout for this user, plan and interval; the user id is set here, server side, from
        the verified sign-in token, and comes back in the signed webhook. The email is not sent."""
        body: dict[str, Any] = {"plan_id": self.plan_ids[(plan, interval)], "metadata": {WHOP_USER_KEY: user_id}}
        if self.redirect_url:
            body["redirect_url"] = self.redirect_url
        url = self._call("POST", "checkout_configurations", body).get("purchase_url")
        if not url or not str(url).startswith("https://"):
            raise ProviderError("Whop did not return a checkout page")
        return str(url)

    def cancel_subscription(self, subscription_id: str) -> None:
        """Stops renewal; access stays until the end of the paid period."""
        self._call("POST", f"memberships/{quote(subscription_id, safe='')}/cancel", {"cancel_at_period_end": True})

    def manage_url(self, subscription_id: str) -> str | None:
        url = self._call("GET", f"memberships/{quote(subscription_id, safe='')}").get("manage_url")
        return str(url) if url and str(url).startswith("https://") else None

    def plan(self, plan_id: str) -> dict:
        """A Whop plan as Whop has it (read only): used by the price check script."""
        return self._call("GET", f"plans/{quote(plan_id, safe='')}")

    # ---------- webhooks ----------
    def verify_webhook(self, headers: Mapping[str, str], raw_body: bytes) -> Event:
        webhook_id = verify_standard_webhook(headers, raw_body, self._secret, self.tolerance_s)
        body = json.loads(raw_body)  # only after the signature matched
        kind = str(body.get("type", ""))
        data = body.get("data") or {}
        if kind not in WHOP_EVENTS:
            raise IgnoredEvent(f"{kind or 'untyped'} event: not used" +
                               (" (refunds never remove credits automatically)" if kind.startswith("refund.") else ""))
        plan_id = _ref(data.get("plan")) or _ref(data.get("plan_id"))
        if plan_id not in self.plans_by_id:
            raise IgnoredEvent(f"{kind} for a plan that is not in config.py (billing.plans.*.whop_plan_ids)")
        plan, interval = self.plans_by_id[plan_id]
        owner = _user_id(data.get("metadata"))
        member = _ref(data.get("user")) or _ref(data.get("user_id"))
        if kind.startswith("membership."):
            subscription = _ref(data.get("id"))
            period_end = _when(data.get("renewal_period_end") or data.get("current_period_end"))
            if kind == "membership.activated":
                status, end = "active", period_end
            elif kind == "membership.deactivated":
                status, end = "canceled", None   # access has ended: Free for new grants from now
            elif data.get("cancel_at_period_end"):
                status, end = "canceled", period_end  # keeps the plan until the paid period ends
            else:
                status, end = "active", period_end
            return Event(id=webhook_id, type=kind, owner_id=owner, plan=plan, interval=interval, status=status,
                         period_end=end, customer_id=member, subscription_id=subscription, grant=False)
        subscription = _ref(data.get("membership")) or _ref(data.get("membership_id"))
        if kind == "payment.succeeded":
            return Event(id=webhook_id, type=kind, owner_id=owner, plan=plan, interval=interval, status="active",
                         period_end=None, customer_id=member, subscription_id=subscription, grant=True,
                         period_start=_when(data.get("paid_at") or data.get("created_at")), has_period=False)
        return Event(id=webhook_id, type=kind, owner_id=owner, plan=plan, interval=interval, status="past_due",
                     period_end=None, customer_id=member, subscription_id=subscription, grant=False, has_period=False)


def whop_plan_ids(config: Any) -> dict[tuple[str, str], str | None]:
    from stitchbook_api.plans import chosen
    return {(p, i): chosen(config, f"billing.plans.{p}.whop_plan_ids.{i}") for p in ("pro", "business")
            for i in ("month", "year")}


def provider_from(name: str | None, *, fake_secret: str | None, production: bool, config: Any = None,
                  whop_api_key: str | None = None, whop_webhook_secret: str | None = None,
                  site_url: str | None = None, http: httpx.Client | None = None) -> Provider | None:
    """The provider named in config.py (billing.provider), or None when none is chosen.
    A named provider that is not fully set up refuses to start (NotConfigured), with the reason."""
    if not name:
        return None
    if name == "fake":
        if production:
            raise NotConfigured("the fake payment provider is refused in production")
        return FakeProvider(fake_secret or "")
    if name == "whop":
        from stitchbook_api.plans import chosen
        environment = chosen(config, "billing.whop_environment")
        if production and environment != "production":
            raise NotConfigured("STITCHBOOK_ENV=production needs billing.whop_environment = \"production\"")
        if chosen(config, "billing.provider_http_timeout_s") is None:
            raise NotConfigured("billing.provider is \"whop\" but billing.provider_http_timeout_s is not chosen in config.py")
        return WhopProvider(whop_api_key or "", whop_webhook_secret or "", environment or "", whop_plan_ids(config),
                            redirect_url=f"{site_url}/billing?checkout=done" if site_url else None,
                            timeout_s=lambda: config.get("billing.provider_http_timeout_s"),
                            tolerance_s=config.get("billing.webhook_tolerance_s"), http=http)
    raise NotConfigured(f"no adapter for payment provider {name!r} (see docs/billing.md)")
