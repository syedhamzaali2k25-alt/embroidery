"""Plans, prices and credit costs, read from config.py (billing.*) and nothing else.

The yearly price is computed here (monthly x 12 x (1 - discount/100), rounded to 2 decimals),
never typed in. A value still PLACEHOLDER comes out as None, and the web app shows a visible
placeholder for it; nothing here invents a number.
"""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from digitizer.config import PLACEHOLDER, Config, PlaceholderValueError

PLAN_IDS = ("free", "pro", "business")


def chosen(config: Config, key: str) -> Any:
    """The value, or None while it is still a placeholder."""
    try:
        return config.get(key)
    except PlaceholderValueError:
        return None


def money(value: Decimal | int | float) -> Decimal:
    return Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def yearly_price(monthly: Decimal | int | float, discount_percent: Decimal | int | float) -> Decimal:
    """monthly x 12 x (1 - discount/100), 2 decimals. 12/month at 10% -> 129.60."""
    return money(Decimal(str(monthly)) * 12 * (1 - Decimal(str(discount_percent)) / 100))


def per_month_of_yearly(monthly: Decimal | int | float, discount_percent: Decimal | int | float) -> Decimal:
    """What a yearly plan comes to per month (the yearly price / 12), 2 decimals."""
    return money(yearly_price(monthly, discount_percent) / 12)


def operation_kinds(config: Config) -> list[str]:
    """The metered operation kinds: the keys of billing.credit_costs.* in config.py."""
    return [k.removeprefix("credit_costs.") for k in config.data["billing"] if k.startswith("credit_costs.")]


def credit_cost(config: Config, operation: str) -> int:
    """Credits an operation costs; 0 when it is free or its cost is not chosen yet (then
    nothing is reserved)."""
    value = chosen(config, f"billing.credit_costs.{operation}")
    return int(value) if isinstance(value, (int, float)) and value > 0 else 0


def plan_credits(config: Config, plan: str) -> int | None:
    """Credits a plan grants per grant period (Free: once; paid: per UTC month)."""
    key = "billing.plans.free.credits" if plan == "free" else f"billing.plans.{plan}.credits_per_month"
    value = chosen(config, key)
    return int(value) if isinstance(value, (int, float)) else None


def plan_name(config: Config, plan: str) -> str | None:
    return chosen(config, f"billing.plans.{plan}.display_name")


def plans(config: Config) -> dict[str, Any]:
    """Everything the pricing page and the plan cards show, from config only."""
    discount = chosen(config, "billing.yearly_discount_percent")
    out = []
    for plan in PLAN_IDS:
        monthly = chosen(config, f"billing.plans.{plan}.price_monthly")
        features = chosen(config, f"billing.plans.{plan}.features")
        priced = monthly is not None and discount is not None
        out.append({
            "id": plan,
            "name": plan_name(config, plan),
            "price_monthly": str(money(monthly)) if monthly is not None else None,
            "price_yearly": str(yearly_price(monthly, discount)) if priced and monthly else ("0.00" if monthly == 0 else None),
            "price_yearly_per_month": str(per_month_of_yearly(monthly, discount)) if priced and monthly else
                ("0.00" if monthly == 0 else None),
            "credits": plan_credits(config, plan),
            "credit_period": chosen(config, "billing.plans.free.credit_period") if plan == "free" else "month",
            "features": features if isinstance(features, list) else None,
        })
    costs = {kind: (chosen(config, f"billing.credit_costs.{kind}")) for kind in operation_kinds(config)}
    packs = chosen(config, "billing.credit_packs")
    return {
        "currency": chosen(config, "billing.currency"),
        "yearly_discount_percent": discount,
        "plans": out,
        "credit_costs": {k: (int(v) if isinstance(v, (int, float)) else None) for k, v in costs.items()},
        "monthly_rollover": chosen(config, "billing.monthly_rollover"),
        "credit_packs": packs if isinstance(packs, list) and packs else None,
        "refund_policy": chosen(config, "billing.refund_policy"),
        # /billing, back from the payment page: how often and how long to look for the payment.
        "checkout_return": {"poll_s": chosen(config, "billing.checkout_return_poll_s"),
                            "wait_s": chosen(config, "billing.checkout_return_wait_s")},
    }


def month_start(now: datetime | None = None) -> datetime:
    """Start of the current UTC calendar month (the plan allowance period)."""
    now = now or datetime.now(timezone.utc)
    return now.astimezone(timezone.utc).replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def month_end(start: datetime) -> datetime:
    """Start of the next UTC month: when this month's plan credits expire (no rollover)."""
    return start.replace(year=start.year + 1, month=1) if start.month == 12 else start.replace(month=start.month + 1)


__all__ = ["PLACEHOLDER", "PLAN_IDS", "chosen", "credit_cost", "month_end", "month_start", "operation_kinds",
           "per_month_of_yearly", "plan_credits", "plan_name", "plans", "yearly_price"]
