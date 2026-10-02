"""Compares the four Whop plans named in config.py with our own prices. READ ONLY: it only
GETs each plan from Whop and never creates, edits or deletes anything there.

    make check-whop-plans          (or: .venv/bin/python -m stitchbook_api.whop_plans)

Expected (computed from config.py billing.*, never typed in): Pro 12 a month and 129.60 a year,
Business 25 a month and 270.00 a year, in billing.currency. For each plan it checks the
recurring price (renewal_price), the first charge (initial_price: the same, or 0/empty), the
currency, that it is a renewing plan, and the billing period (about a month, or a year).
Exit code 0 = everything matches, 1 = a mismatch (listed), 2 = cannot check (keys or ids missing,
Whop not reachable). Needs WHOP_API_KEY in the environment or .env (never printed).
"""

from __future__ import annotations

import os
import sys
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable

import httpx
from digitizer.config import Config, load_config

from stitchbook_api import plans as plan_math
from stitchbook_api.payments import WHOP_API, ProviderError, WhopProvider, whop_plan_ids

ROOT = Path(__file__).resolve().parents[3]
PERIOD_DAYS = {"month": range(28, 32), "year": range(365, 367)}


def expected_prices(config: Config) -> dict[tuple[str, str], Decimal]:
    discount = plan_math.chosen(config, "billing.yearly_discount_percent") or 0
    out = {}
    for plan in ("pro", "business"):
        monthly = plan_math.chosen(config, f"billing.plans.{plan}.price_monthly")
        if monthly is not None:
            out[(plan, "month")] = plan_math.money(monthly)
            out[(plan, "year")] = plan_math.yearly_price(monthly, discount)
    return out


def compare(config: Config, fetch: Callable[[str], dict[str, Any]]) -> tuple[list[str], list[str]]:
    """(lines to print, problems). fetch(plan_id) returns Whop's plan object."""
    lines, problems = [], []
    currency = str(plan_math.chosen(config, "billing.currency") or "").lower()
    ids = whop_plan_ids(config)
    for (plan, interval), want in expected_prices(config).items():
        label = f"{plan} / {interval}"
        plan_id = ids.get((plan, interval))
        if not plan_id:
            problems.append(f"{label}: no Whop plan id in config.py (billing.plans.{plan}.whop_plan_ids.{interval})")
            continue
        got = fetch(plan_id)
        renewal = got.get("renewal_price")
        initial = got.get("initial_price")
        mine = []
        if renewal is None or plan_math.money(renewal) != want:
            mine.append(f"recurring price is {renewal} in Whop, ours is {want}")
        if initial not in (None, 0, "0") and plan_math.money(initial) != want:
            mine.append(f"first charge (initial_price) is {initial} in Whop, ours is {want}")
        if str(got.get("currency") or "").lower() != currency:
            mine.append(f"currency is {got.get('currency')!r} in Whop, ours is {currency.upper()!r}")
        if got.get("plan_type") not in (None, "renewal"):
            mine.append(f"plan type is {got.get('plan_type')!r} in Whop, should be 'renewal' (a subscription)")
        period = got.get("billing_period")
        if period is None or int(period) not in PERIOD_DAYS[interval]:
            mine.append(f"billing period is {period} days in Whop, should be one {interval}")
        if got.get("trial_period_days"):
            mine.append(f"has a {got['trial_period_days']}-day free trial in Whop; Stitchbook has no trials (credits would be given)")
        problems += [f"{label} ({plan_id}): {m}" for m in mine]
        lines.append(f"{'MISMATCH' if mine else 'ok      '} {label}: Whop {renewal} {str(got.get('currency') or '').upper()}"
                     f" every {period} days; ours {want} {currency.upper()}")
    return lines, problems


def _key() -> str | None:
    if os.environ.get("WHOP_API_KEY", "").strip():
        return os.environ["WHOP_API_KEY"].strip()
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            name, _, value = line.partition("=")
            if name.strip() == "WHOP_API_KEY" and value.strip():
                return value.strip().strip("'\"")
    return None


def main() -> int:
    config = load_config()
    key = _key()
    environment = plan_math.chosen(config, "billing.whop_environment")
    if not key:
        print("Cannot check: WHOP_API_KEY is not set (environment or .env). Nothing was sent to Whop.")
        return 2
    if environment not in WHOP_API:
        print('Cannot check: billing.whop_environment in config.py must be "sandbox" or "production".')
        return 2
    timeout = plan_math.chosen(config, "billing.provider_http_timeout_s")
    if timeout is None:
        print("Cannot check: billing.provider_http_timeout_s is not chosen in config.py.")
        return 2
    # Read only: WhopProvider.plan() is a GET. The webhook secret is not needed for it.
    whop = WhopProvider(key, "unused-for-reading-plans", environment, {k: v or "-" for k, v in whop_plan_ids(config).items()},
                        None, lambda: timeout, config.get("billing.webhook_tolerance_s"), httpx.Client())
    print(f"Whop {environment} plans compared with config.py (nothing in Whop is changed):")
    try:
        lines, problems = compare(config, whop.plan)
    except ProviderError as exc:
        print(f"Cannot check: {exc}.")
        return 2
    print("\n".join(lines))
    if problems:
        print("\nTo fix in the Whop dashboard (or in config.py if ours is wrong):")
        print("\n".join(f"  - {p}" for p in problems))
        return 1
    print("\nAll four plans match.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
