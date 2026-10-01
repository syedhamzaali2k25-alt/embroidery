"""Plan prices and credit costs come from config.py; the yearly price is computed."""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal

from digitizer.config import load_config

from stitchbook_api import plans

CONFIG = load_config()


def test_yearly_price_math():
    assert plans.yearly_price(12, 10) == Decimal("129.60")
    assert plans.yearly_price(25, 10) == Decimal("270.00")
    assert plans.yearly_price(0, 10) == Decimal("0.00")
    assert plans.yearly_price(9.99, 15) == Decimal("101.90")  # 9.99*12*0.85 = 101.898
    assert plans.per_month_of_yearly(12, 10) == Decimal("10.80")
    assert plans.per_month_of_yearly(25, 10) == Decimal("22.50")


def test_plans_are_read_from_config_with_owner_values():
    data = plans.plans(CONFIG)
    by_id = {p["id"]: p for p in data["plans"]}
    assert [p["id"] for p in data["plans"]] == ["free", "pro", "business"]
    assert by_id["pro"] == {**by_id["pro"], "name": "Pro", "price_monthly": "12.00", "price_yearly": "129.60",
                            "price_yearly_per_month": "10.80", "credits": 5000, "features": ["Dashboard"]}
    assert by_id["business"]["price_yearly"] == "270.00" and by_id["business"]["credits"] == 10000
    assert by_id["business"]["features"] is None  # placeholder: nothing claimed
    assert by_id["free"]["credits"] == 30 and by_id["free"]["credit_period"] == "lifetime"
    assert data["yearly_discount_percent"] == 10 and data["currency"] == "USD"
    assert data["credit_costs"] == {"export": 10, "satin_columns": None, "auto_digitize": None}
    assert data["monthly_rollover"] is False and data["credit_packs"] is None and data["refund_policy"] is None


def test_a_changed_config_value_changes_the_price():
    changed = CONFIG.with_overrides({"billing.plans.pro.price_monthly": 20, "billing.yearly_discount_percent": 25})
    pro = next(p for p in plans.plans(changed)["plans"] if p["id"] == "pro")
    assert pro["price_monthly"] == "20.00" and pro["price_yearly"] == "180.00"


def test_operation_kinds_and_costs_come_from_config_keys():
    assert plans.operation_kinds(CONFIG) == ["export", "satin_columns", "auto_digitize"]
    assert plans.credit_cost(CONFIG, "export") == 10
    assert plans.credit_cost(CONFIG, "satin_columns") == 0  # unset = free, nothing reserved
    assert plans.credit_cost(CONFIG.with_overrides({"billing.credit_costs.export": 0}), "export") == 0


def test_utc_month_window():
    start = plans.month_start(datetime(2026, 12, 31, 23, 59, tzinfo=timezone.utc))
    assert start == datetime(2026, 12, 1, tzinfo=timezone.utc)
    assert plans.month_end(start) == datetime(2027, 1, 1, tzinfo=timezone.utc)
