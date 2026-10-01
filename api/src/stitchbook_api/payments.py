"""Payment providers behind one small interface, so a real (or local) gateway can be added later.

A provider:
  create_checkout(user_id, email, plan, interval) -> URL of the provider's checkout page; the
                      user id goes into the provider's signed metadata, never from our request body
  verify_webhook(headers, raw_body) -> Event; raises BadSignature BEFORE anything is parsed
  cancel_subscription(subscription_id)

Only FakeProvider exists (tests and local development, HMAC-SHA256 over the raw body). No real
provider is chosen (billing.provider in config.py), so payments answer 503 "Payments are not
available yet". docs/billing.md explains how to add an adapter.
"""

from __future__ import annotations

import hashlib
import hmac
import json
from dataclasses import dataclass
from datetime import datetime
from typing import Mapping, Protocol
from urllib.parse import urlencode


class NotConfigured(RuntimeError):
    """No payment provider is set up."""


class BadSignature(ValueError):
    """The webhook's signature does not match: the body is not trusted or parsed."""


@dataclass(frozen=True)
class Event:
    id: str
    type: str
    owner_id: str           # from the provider's signed metadata only
    plan: str               # free | pro | business
    interval: str | None    # month | year
    status: str             # active | past_due | canceled
    period_end: datetime | None
    customer_id: str | None
    subscription_id: str | None


class Provider(Protocol):
    name: str
    def create_checkout(self, user_id: str, email: str | None, plan: str, interval: str) -> str: ...
    def verify_webhook(self, headers: Mapping[str, str], raw_body: bytes) -> Event: ...
    def cancel_subscription(self, subscription_id: str) -> None: ...


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


def provider_from(name: str | None, *, fake_secret: str | None, production: bool) -> Provider | None:
    """The provider named in config.py (billing.provider), or None when none is chosen."""
    if not name:
        return None
    if name == "fake":
        if production:
            raise NotConfigured("the fake payment provider is refused in production")
        return FakeProvider(fake_secret or "")
    raise NotConfigured(f"no adapter for payment provider {name!r} (see docs/billing.md)")
