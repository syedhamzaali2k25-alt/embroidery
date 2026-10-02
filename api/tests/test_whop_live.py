"""OPTIONAL live check against Whop's SANDBOX. Skipped (with a message) unless WHOP_API_KEY is set
and config.py has billing.whop_environment = "sandbox" and the four plan ids. It only READS:
each configured plan, compared with our prices (stitchbook_api.whop_plans). It creates no
checkout, cancels nothing and pays nothing. Run: .venv/bin/pytest api/tests/test_whop_live.py -v -rs
"""

from __future__ import annotations

import httpx
import pytest
from digitizer.config import load_config

from stitchbook_api import plans as plan_math
from stitchbook_api.payments import WhopProvider, whop_plan_ids
from stitchbook_api.whop_plans import _key, compare

CONFIG = load_config()
KEY = _key()
IDS = whop_plan_ids(CONFIG)
MISSING = [name for name, ok in [
    ("WHOP_API_KEY", bool(KEY)),
    ('billing.whop_environment = "sandbox"', plan_math.chosen(CONFIG, "billing.whop_environment") == "sandbox"),
    ("billing.provider_http_timeout_s", plan_math.chosen(CONFIG, "billing.provider_http_timeout_s") is not None),
    ("the four billing.plans.*.whop_plan_ids", all(IDS.values())),
] if not ok]

pytestmark = pytest.mark.skipif(bool(MISSING), reason=f"live Whop sandbox test skipped: {', '.join(MISSING)} not set. "
                                                      "See docs/payments-whop.md.")


def test_the_sandbox_plans_match_our_prices():
    provider = WhopProvider(KEY, "unused-for-reading-plans", "sandbox", IDS, None,
                            lambda: CONFIG.get("billing.provider_http_timeout_s"), CONFIG.get("billing.webhook_tolerance_s"),
                            httpx.Client())
    lines, problems = compare(CONFIG, provider.plan)
    print("\n".join(lines))
    assert problems == []
