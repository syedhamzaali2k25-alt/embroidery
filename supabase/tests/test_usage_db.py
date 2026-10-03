"""Migration 7, part 1 (Step 13d): the functions behind Export history and Credit usage, run as
the signed-in user on a throwaway local Postgres. Each returns only the caller's rows, pages
newest first, and anon cannot run them.
"""

from __future__ import annotations

import json

import pytest

from test_billing_db import consume, db, grant, new_design, new_user, release, reserve, svc  # noqa: F401 (fixture)


def as_json(db, user, query: str):
    out = db.sql(f"select coalesce(json_agg(t), '[]') from ({query}) t", user=user)
    return json.loads("\n".join("|".join(r) for r in out))


def exported(db, user, design, job, fmt="dst", ok=True):
    reserve(db, user, design, job, fmt=fmt)
    consume(db, user, job) if ok else release(db, user, job)


def test_export_history_is_the_callers_finished_exports_newest_first(db):
    a, b = new_user(db), new_user(db)
    design = new_design(db, a)
    db.sql(f"insert into public.exports (owner_id, design_id, format, storage_path, bytes) "
           f"values ('{a}', '{design}', 'dst', '{a}/{design}/out.dst', 1234)", user=a)
    grant(db, a, 100)
    exported(db, a, design, "h1")
    exported(db, a, design, "h2")
    exported(db, a, design, "h3", ok=False)  # failed: not in the history
    rows = as_json(db, a, "select * from public.my_export_history(10, 0)")
    assert [r["job_id"] for r in rows] == ["h2", "h1"]
    assert rows[0] == {**rows[0], "design_name": "logo.png", "format": "dst", "bytes": 1234, "credits": 10}
    assert as_json(db, b, "select * from public.my_export_history(10, 0)") == []  # B never sees A's
    assert [r["job_id"] for r in as_json(db, a, "select * from public.my_export_history(1, 1)")] == ["h1"]  # paging


def test_credit_entries_show_grants_and_spends_of_the_caller_only(db):
    a, b = new_user(db), new_user(db)
    design = new_design(db, a)
    grant(db, a, 50, reason="free_grant", ref="free_grant")
    exported(db, a, design, "e1")
    rows = as_json(db, a, "select * from public.my_credit_entries(10, 0)")
    assert [(r["kind"], r["reason"], r["amount"]) for r in rows] == [("spend", "export", -10), ("grant", "free_grant", 50)]
    assert as_json(db, b, "select * from public.my_credit_entries(10, 0)") == []
    assert len(as_json(db, a, "select * from public.my_credit_entries(1, 1)")) == 1
    assert db.sql("select public.my_credits_spent(now() - interval '1 hour')", user=a) == [["10"]]
    assert db.sql("select public.my_credits_spent(now() - interval '1 hour')", user=b) == [["0"]]


def test_balance_and_subscription_are_the_callers_own(db):
    a, b = new_user(db), new_user(db)
    grant(db, a, 70)
    svc(db, f"select public.apply_billing_event('fake', 'evt-usage', '{a}', 'pro', 'month', 'active', "
            f"'2026-11-01T00:00:00Z', 'c', 'sub-u', 0, null, null)")
    bal = {r["bucket"]: r["available"] for r in as_json(db, a, "select * from public.my_credit_balance()")}
    assert bal == {"plan": 70, "purchased": 0}
    assert sum(r["available"] for r in as_json(db, b, "select * from public.my_credit_balance()")) == 0
    assert [r["plan"] for r in as_json(db, a, "select * from public.my_subscription()")] == ["pro"]
    assert as_json(db, b, "select * from public.my_subscription()") == []


def test_anon_cannot_run_them(db):
    for call in ("my_export_history(10, 0)", "my_credit_entries(10, 0)", "my_credits_spent(now())",
                 "my_subscription()", "my_credit_balance()"):
        with pytest.raises(PermissionError, match="permission denied"):
            db.sql(f"select * from public.{call}", anon=True)
