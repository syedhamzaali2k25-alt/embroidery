"""Migration 5 (credits, plans, billing) on a throwaway local Postgres, with the same Supabase
stand-in as test_rls.py: row level security on the new tables, who may run the functions, and
the credit rules (reserve at start, consume only on success, release on failure or cancel,
idempotency, plan bucket before purchased, monthly expiry, the stale sweep, concurrency, and the
webhook event function). The real project: paste the migration, then run the live tests.
"""

from __future__ import annotations

import json
import threading
import uuid

import pytest

from test_rls import MIGRATIONS, STUB, Postgres

COSTS = 10  # the export cost in config.py (billing.credit_costs.export); tests pass amounts explicitly


@pytest.fixture(scope="module")
def db():
    pg = Postgres()
    try:
        pg.sql(STUB.read_text())
        for migration in MIGRATIONS:
            pg.sql(migration.read_text())
        yield pg
    finally:
        pg.stop()


def new_user(db: Postgres) -> str:
    user = str(uuid.uuid4())
    db.sql(f"insert into auth.users (id, email) values ('{user}', '{user[:8]}@example.com')")  # profile via trigger
    return user


def new_design(db: Postgres, user: str) -> str:
    return db.sql("insert into public.designs (filename, file_type, status, record) "
                  "values ('logo.png', 'png', 'uploaded', '{}') returning id", user=user)[0][0]


def svc(db: Postgres, query: str):
    return db.sql(query, service=True)


def grant(db, user, amount, bucket="plan", reason="adjustment", ref=None, expires=None) -> bool:
    ref = ref or f"test:{uuid.uuid4().hex}"
    exp = f"'{expires}'" if expires else "null"
    return svc(db, f"select public.grant_credits('{user}', {amount}, '{bucket}', '{reason}', '{ref}', {exp})")[0][0] == "t"


def balance(db, user) -> dict[str, dict[str, int]]:
    rows = svc(db, f"select bucket, available, reserved, consumed from public.credit_balance('{user}')")
    return {b: {"available": int(a), "reserved": int(r), "consumed": int(c)} for b, a, r, c in rows}


def total(db, user) -> int:
    return sum(v["available"] for v in balance(db, user).values())


def reserve(db, user, design, job, amount=COSTS, operation="export", fmt="dst", settings=None) -> dict:
    s = json.dumps(settings or {"width_mm": 60}).replace("'", "''")
    d = f"'{design}'" if design else "null"
    f = f"'{fmt}'" if fmt else "null"
    out = svc(db, f"select public.reserve_credit('{user}', {d}, '{job}', '{operation}', {f}, '{s}'::jsonb, {amount})")
    return json.loads(out[0][0])


def consume(db, user, job) -> str:
    return svc(db, f"select public.consume_credit('{user}', '{job}')")[0][0]


def release(db, user, job, reason="failed", status="failed") -> str:
    return svc(db, f"select public.release_credit('{user}', '{job}', '{reason}', '{status}')")[0][0]


def log_row(db, user, job) -> dict:
    rows = svc(db, f"select owner_id, design_id, operation, format, settings, status, credits, created_at, finished_at, error "
                   f"from public.operation_log where owner_id = '{user}' and job_id = '{job}'")
    keys = ["owner_id", "design_id", "operation", "format", "settings", "status", "credits", "created_at", "finished_at", "error"]
    return dict(zip(keys, rows[0])) if rows else {}


# ---------- row level security and privileges ----------

NEW_TABLES = ("subscriptions", "credit_ledger", "credit_reservations", "credit_allocations", "operation_log",
              "processed_webhook_events")
FUNCTIONS = ("credit_balance(uuid)", "grant_credits(uuid,integer,text,text,text,timestamp with time zone)",
             "reserve_credit(uuid,uuid,text,text,text,jsonb,integer)", "consume_credit(uuid,text)",
             "release_credit(uuid,text,text,text)", "release_stale_reservations(interval)",
             "apply_billing_event(text,text,uuid,text,text,text,timestamp with time zone,text,text,integer,text,timestamp with time zone)",
             "billing_lock_owner(uuid)", "billing_open_grants(uuid)")


def test_rls_is_on_and_users_can_only_read_their_own_rows(db):
    on = dict(db.sql("select tablename, rowsecurity from pg_tables where schemaname = 'public'"))
    assert all(on[t] == "t" for t in NEW_TABLES)
    a, b = new_user(db), new_user(db)
    design = new_design(db, a)
    grant(db, a, 50, reason="free_grant", ref="free_grant")
    reserve(db, a, design, "job-a")
    svc(db, f"select public.apply_billing_event('fake', 'evt-rls', '{a}', 'pro', 'month', 'active', now(), 'c', 's', 0, null, null)")
    for table in NEW_TABLES[:-1]:
        assert db.sql(f"select count(*) from public.{table} where owner_id = '{a}'", user=a)[0][0] != "0", table
        assert db.sql(f"select count(*) from public.{table}", user=b) == [["0"]], f"B sees A's {table}"
    with pytest.raises(PermissionError, match="permission denied"):
        db.sql("select * from public.processed_webhook_events", user=a)


def test_users_cannot_write_any_billing_table(db):
    a = new_user(db)
    design = new_design(db, a)
    writes = {
        "subscriptions": f"insert into public.subscriptions (owner_id, plan) values ('{a}', 'business')",
        "credit_ledger": f"insert into public.credit_ledger (owner_id, delta, bucket, reason, ref) values ('{a}', 9999, 'purchased', 'purchase', 'x')",
        "credit_reservations": f"insert into public.credit_reservations (owner_id, design_id, job_id, operation, amount) "
                               f"values ('{a}', '{design}', 'j', 'export', 1)",
        "operation_log": f"insert into public.operation_log (owner_id, job_id, operation) values ('{a}', 'j', 'export')",
        "processed_webhook_events": "insert into public.processed_webhook_events (provider, event_id) values ('fake', 'x')",
    }
    for table, query in writes.items():
        with pytest.raises(PermissionError, match="permission denied"):
            db.sql(query, user=a)
    grant(db, a, 30, ref="ledger-row")
    for query in (f"update public.credit_ledger set delta = 100000 where owner_id = '{a}'",
                  f"delete from public.credit_ledger where owner_id = '{a}'",
                  f"update public.subscriptions set plan = 'business' where owner_id = '{a}'"):
        with pytest.raises(PermissionError, match="permission denied"):
            db.sql(query, user=a)


def test_a_visitor_who_is_not_signed_in_sees_nothing(db):
    for table in NEW_TABLES:
        with pytest.raises(PermissionError, match="permission denied"):
            db.sql(f"select * from public.{table}", anon=True)


def test_billing_functions_run_only_with_the_secret_key(db):
    a = new_user(db)
    for fn in FUNCTIONS:
        for role in ("authenticated", "anon"):
            assert db.sql(f"select has_function_privilege('{role}', 'public.{fn}', 'execute')") == [["f"]], (role, fn)
        assert db.sql(f"select has_function_privilege('service_role', 'public.{fn}', 'execute')") == [["t"]], fn
    with pytest.raises(PermissionError, match="permission denied"):
        db.sql(f"select public.grant_credits('{a}', 1000, 'purchased', 'purchase', 'self-grant')", user=a)
    with pytest.raises(PermissionError, match="permission denied"):
        db.sql(f"select * from public.credit_balance('{a}')", anon=True)
    for fn in ("credit_balance", "reserve_credit", "consume_credit", "release_credit", "grant_credits",
               "release_stale_reservations", "apply_billing_event"):
        config = db.sql(f"select prosecdef, proconfig from pg_proc where proname = '{fn}'")[0]
        assert config[0] == "t" and config[1] in ('{search_path=""}', '{"search_path=\\"\\""}'), (fn, config)


def test_the_ledger_is_append_only_even_for_the_service_role(db):
    a = new_user(db)
    grant(db, a, 30, ref="append-only")
    with pytest.raises(PermissionError, match="permission denied"):
        svc(db, f"update public.credit_ledger set delta = 99 where owner_id = '{a}'")
    with pytest.raises(PermissionError, match="permission denied"):
        svc(db, f"delete from public.credit_ledger where owner_id = '{a}'")
    with pytest.raises(PermissionError, match="append-only"):  # not even the owner role
        db.sql(f"update public.credit_ledger set delta = 99 where owner_id = '{a}'")


# ---------- reserve, consume, release ----------

def test_success_consumes_and_failure_gives_everything_back(db):
    a = new_user(db)
    design = new_design(db, a)
    grant(db, a, 30, reason="free_grant", ref="free_grant")
    assert reserve(db, a, design, "ok")["status"] == "reserved"
    assert balance(db, a)["plan"] == {"available": 20, "reserved": 10, "consumed": 0}
    assert consume(db, a, "ok") == "succeeded"
    assert balance(db, a)["plan"] == {"available": 20, "reserved": 0, "consumed": 10}
    before = total(db, a)
    reserve(db, a, design, "bad")
    assert total(db, a) == before - 10
    assert release(db, a, "bad", "the digitizer failed") == "failed"
    assert total(db, a) == before  # a failed job consumes nothing
    assert balance(db, a)["plan"]["consumed"] == 10


def test_a_cancelled_job_releases_its_reservation(db):
    a = new_user(db)
    design = new_design(db, a)
    grant(db, a, 20)
    reserve(db, a, design, "cancel-me")
    assert total(db, a) == 10
    assert release(db, a, "cancel-me", "cancelled by the user", "cancelled") == "cancelled"
    assert total(db, a) == 20
    assert log_row(db, a, "cancel-me")["status"] == "cancelled"


def test_not_enough_credits_is_refused_and_logs_nothing(db):
    a = new_user(db)
    design = new_design(db, a)
    grant(db, a, 9)
    with pytest.raises(PermissionError, match="insufficient_credits"):
        reserve(db, a, design, "too-dear")
    assert log_row(db, a, "too-dear") == {} and total(db, a) == 9


def test_idempotency(db):
    a = new_user(db)
    design = new_design(db, a)
    grant(db, a, 30, ref="idem")
    assert grant(db, a, 30, ref="idem") is False  # the same ref is granted once
    first = reserve(db, a, design, "same")
    again = reserve(db, a, design, "same")
    assert first["repeat"] is False and again["repeat"] is True and total(db, a) == 20
    assert consume(db, a, "same") == "succeeded" and consume(db, a, "same") == "succeeded"
    assert balance(db, a)["plan"]["consumed"] == 10
    assert release(db, a, "same") == "succeeded"  # a consumed credit is never released
    assert total(db, a) == 20 and balance(db, a)["plan"]["consumed"] == 10
    reserve(db, a, design, "twice-released")
    release(db, a, "twice-released")
    release(db, a, "twice-released")
    assert consume(db, a, "twice-released") == "failed"  # released cannot be consumed afterwards
    assert total(db, a) == 20


def test_zero_cost_operations_are_logged_but_reserve_nothing(db):
    a = new_user(db)
    design = new_design(db, a)
    out = reserve(db, a, design, "free-op", amount=0, operation="satin_columns", fmt=None)
    assert out["status"] == "free" and total(db, a) == 0
    assert svc(db, f"select count(*) from public.credit_reservations where owner_id = '{a}'") == [["0"]]
    assert consume(db, a, "free-op") == "succeeded"


def test_every_operation_writes_a_log_row(db):
    a = new_user(db)
    design = new_design(db, a)
    grant(db, a, 40)
    for job, end in (("l-ok", "consume"), ("l-fail", "release"), ("l-cancel", "cancel"), ("l-free", "consume")):
        reserve(db, a, design, job, amount=0 if job == "l-free" else 10, settings={"width_mm": 75, "colours": ["#112233"]})
        if end == "consume":
            consume(db, a, job)
        elif end == "release":
            release(db, a, job, "boom")
        else:
            release(db, a, job, "cancelled", "cancelled")
    rows = {job: log_row(db, a, job) for job in ("l-ok", "l-fail", "l-cancel", "l-free")}
    assert {j: r["status"] for j, r in rows.items()} == {"l-ok": "succeeded", "l-fail": "failed", "l-cancel": "cancelled", "l-free": "succeeded"}
    for row in rows.values():
        assert row["owner_id"] == a and row["design_id"] == design and row["operation"] == "export" and row["format"] == "dst"
        assert json.loads(row["settings"]) == {"width_mm": 75, "colours": ["#112233"]}
        assert row["created_at"] and row["finished_at"]
    assert rows["l-fail"]["error"] == "boom" and rows["l-ok"]["credits"] == "10" and rows["l-free"]["credits"] == "0"


def test_plan_credits_are_spent_before_purchased_ones(db):
    a = new_user(db)
    design = new_design(db, a)
    grant(db, a, 15, bucket="purchased", reason="purchase", ref="pack-1")
    grant(db, a, 15, bucket="plan", reason="plan_grant", ref="plan:sub:2026-10-01", expires="2999-01-01")
    reserve(db, a, design, "p1")  # 10 from plan
    b = balance(db, a)
    assert b["plan"]["available"] == 5 and b["purchased"]["available"] == 15
    reserve(db, a, design, "p2")  # 5 plan + 5 purchased
    b = balance(db, a)
    assert b["plan"]["available"] == 0 and b["purchased"]["available"] == 10
    assert b["plan"]["reserved"] == 15 and b["purchased"]["reserved"] == 5


def test_monthly_plan_credits_expire_and_do_not_roll_over(db):
    a = new_user(db)
    design = new_design(db, a)
    # Last month's allowance (expired at the start of this month), mostly unused.
    grant(db, a, 100, reason="plan_grant", ref="plan:sub:2000-01-01", expires="2000-02-01")
    grant(db, a, 5, bucket="purchased", reason="purchase", ref="pack")
    assert balance(db, a)["plan"]["available"] == 0 and total(db, a) == 5  # nothing carried over
    grant(db, a, 100, reason="plan_grant", ref="plan:sub:2999-01-01", expires="2999-02-01")
    assert balance(db, a)["plan"]["available"] == 100  # this month: the full allowance, no more
    assert grant(db, a, 100, reason="plan_grant", ref="plan:sub:2999-01-01", expires="2999-02-01") is False
    reserve(db, a, design, "m1")
    assert balance(db, a)["plan"]["available"] == 90 and balance(db, a)["purchased"]["available"] == 5


def test_stale_reservations_are_swept(db):
    a = new_user(db)
    design = new_design(db, a)
    grant(db, a, 30)
    reserve(db, a, design, "lost")
    reserve(db, a, design, "fresh")
    db.sql(f"update public.credit_reservations set created_at = now() - interval '2 hours' where owner_id = '{a}' and job_id = 'lost'")
    assert svc(db, "select public.release_stale_reservations(interval '1 hour')")[0][0] == "1"
    assert total(db, a) == 20  # "lost" back, "fresh" still held
    assert log_row(db, a, "lost")["status"] == "failed" and log_row(db, a, "lost")["error"] == "timed out"
    assert log_row(db, a, "fresh")["status"] == "started"
    assert consume(db, a, "lost") == "failed"  # a late success cannot spend the released credits


# ---------- concurrency: each owner's credit changes are serialised ----------

def race(db, user, design, jobs, amount):
    results: dict[str, str] = {}

    def one(job):
        try:
            reserve(db, user, design, job, amount=amount)
            results[job] = "reserved"
        except PermissionError as exc:
            results[job] = "insufficient" if "insufficient_credits" in str(exc) else f"error: {exc}"

    threads = [threading.Thread(target=one, args=(job,)) for job in jobs]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return results


def test_two_at_once_with_credits_for_one(db):
    a = new_user(db)
    design = new_design(db, a)
    grant(db, a, 10)
    results = race(db, a, design, ["x1", "x2"], 10)
    assert sorted(results.values()) == ["insufficient", "reserved"], results
    assert total(db, a) == 0


def test_two_jobs_of_10_with_15_available(db):
    a = new_user(db)
    design = new_design(db, a)
    grant(db, a, 15)
    results = race(db, a, design, ["y1", "y2"], 10)
    assert sorted(results.values()) == ["insufficient", "reserved"], results
    assert balance(db, a)["plan"] == {"available": 5, "reserved": 10, "consumed": 0}


def test_twenty_concurrent_exports_with_enough_credits(db):
    a = new_user(db)
    design = new_design(db, a)
    grant(db, a, 230)
    jobs = [f"c{i}" for i in range(20)]
    results = race(db, a, design, jobs, 10)
    assert all(v == "reserved" for v in results.values()), results
    threads = [threading.Thread(target=consume, args=(db, a, j)) for j in jobs]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert balance(db, a)["plan"] == {"available": 30, "reserved": 0, "consumed": 200}
    assert svc(db, f"select count(*) from public.operation_log where owner_id = '{a}' and status = 'succeeded'") == [["20"]]


def test_twenty_concurrent_exports_with_credits_for_twelve(db):
    a = new_user(db)
    design = new_design(db, a)
    grant(db, a, 120)
    results = race(db, a, design, [f"d{i}" for i in range(20)], 10)
    assert list(results.values()).count("reserved") == 12 and list(results.values()).count("insufficient") == 8, results
    assert balance(db, a)["plan"] == {"available": 0, "reserved": 120, "consumed": 0}


# ---------- the webhook event function ----------

def test_a_provider_event_is_applied_once(db):
    a = new_user(db)
    args = (f"'fake', 'evt-1', '{a}', 'pro', 'year', 'active', '2999-01-01', 'cus_1', 'sub_1', 5000, "
            f"'plan:sub_1:2026-10-01', '2026-11-01')")
    assert svc(db, f"select public.apply_billing_event({args}")[0][0] == "applied"
    assert svc(db, f"select public.apply_billing_event({args}")[0][0] == "duplicate"  # replay
    assert svc(db, f"select plan, billing_interval, status from public.subscriptions where owner_id = '{a}'") == [["pro", "year", "active"]]
    assert svc(db, f"select count(*), sum(delta) from public.credit_ledger where owner_id = '{a}'") == [["1", "5000"]]
    # A different event for the same period does not grant the period twice.
    other = args.replace("'evt-1'", "'evt-2'")
    assert svc(db, f"select public.apply_billing_event({other}")[0][0] == "applied"
    assert svc(db, f"select count(*) from public.credit_ledger where owner_id = '{a}'") == [["1"]]


def test_deleting_a_design_keeps_spent_credits_spent(db):
    a = new_user(db)
    design = new_design(db, a)
    grant(db, a, 20)
    reserve(db, a, design, "kept")
    consume(db, a, "kept")
    db.sql(f"delete from public.designs where id = '{design}'", user=a)
    assert balance(db, a)["plan"] == {"available": 10, "reserved": 0, "consumed": 10}
    assert log_row(db, a, "kept")["design_id"] == ""  # the log row stays, without the design


def test_one_provider_subscription_belongs_to_one_account(db):
    """Migration 6: a Whop membership id can be bound to one account only, even if two events
    naming different accounts got past the API's own check."""
    a, b = new_user(db), new_user(db)
    call = ("select public.apply_billing_event('whop', '{event}', '{owner}', 'pro', 'month', 'active', null, null, "
            "'mem_shared', 0, null, null)")
    assert svc(db, call.format(event="m6-1", owner=a))[0][0] == "applied"
    with pytest.raises(PermissionError, match="subscriptions_provider_subscription_idx"):
        svc(db, call.format(event="m6-2", owner=b))
    assert svc(db, "select owner_id from public.subscriptions where provider_subscription_id = 'mem_shared'") == [[a]]
    assert svc(db, "select count(*) from public.processed_webhook_events where event_id = 'm6-2'") == [["0"]]  # rolled back
    # Another provider's id that happens to look the same is a different subscription.
    assert svc(db, call.replace("'whop'", "'fake'").format(event="m6-3", owner=b))[0][0] == "applied"
