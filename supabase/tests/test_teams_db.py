"""Migration 7, part 2 (Step 13b): teams on a throwaway local Postgres. Read-only RLS for owner
and members, invites (hashed token, expiry, single use, email match), seats enforced in SQL even
with concurrent accepts, members spending from the owner's pool under the owner's lock, removal
and plan end stopping pool access, and extra-seat credits granted once.
"""

from __future__ import annotations

import hashlib
import threading
import uuid

import pytest

from test_billing_db import balance, db, grant, new_design, new_user, reserve, consume, svc, total  # noqa: F401 (fixture)

SEATS = 4  # billing.team.included_seats in config.py (the API passes it in)


def email_of(user: str) -> str:
    return f"{user[:8]}@example.com"  # what new_user() stores


def business(db, owner, status="active", end="now() + interval '30 days'", event=None):
    svc(db, f"select public.apply_billing_event('fake', '{event or uuid.uuid4().hex}', '{owner}', 'business', 'month', "
            f"'{status}', {end}, 'c', 'sub-{owner[:8]}', 0, null, null)")


def token_hash() -> str:
    return hashlib.sha256(uuid.uuid4().hex.encode()).hexdigest()


def invite(db, owner, email, h=None, expires="now() + interval '1 day'", seats=SEATS) -> str:
    h = h or token_hash()
    svc(db, f"select public.team_create_invite('{owner}', '{email}', '{h}', {expires}, {seats})")
    return h


def accept(db, user, h, email=None, seats=SEATS):
    return svc(db, f"select public.team_accept_invite('{user}', '{email or email_of(user)}', '{h}', {seats})")


def team_with(db, members=1):
    owner = business_owner(db)
    users = []
    for _ in range(members):
        u = new_user(db)
        accept(db, u, invite(db, owner, email_of(u)))
        users.append(u)
    return owner, users


def business_owner(db):
    owner = new_user(db)
    business(db, owner)
    return owner


# ---------- RLS ----------

def test_members_and_strangers_read_only_what_is_theirs(db):
    owner, (m1, m2) = team_with(db, 2)
    stranger = new_user(db)
    invite(db, owner, "later@example.com")
    grant(db, owner, 100)
    count = lambda q, u: int(db.sql(f"select count(*) from {q}", user=u)[0][0])  # noqa: E731
    assert count("public.team_members", owner) == 3 and count("public.team_invites", owner) >= 1
    assert count("public.team_members", m1) == 1  # only their own row, never the other member
    assert count("public.team_invites", m1) == 0  # members never see invites
    assert count("public.team_extra_seats", m1) == 0
    assert count("public.teams", m1) == 1  # which team they are in
    for table in ("credit_ledger", "subscriptions", "credit_allocations"):
        assert count(f"public.{table} where owner_id = '{owner}'", m1) == 0, f"a member reads the owner's {table}"
    for table in ("teams", "team_members", "team_invites", "team_extra_seats"):
        assert count(f"public.{table}", stranger) == 0
    # Nobody writes team tables directly, owner included.
    for statement in (f"insert into public.team_members (team_id, owner_id, user_id, role) select id, owner_id, '{stranger}', 'member' from public.teams",
                      "delete from public.team_invites", "update public.team_members set role = 'owner'"):
        with pytest.raises(PermissionError, match="permission denied"):
            db.sql(statement, user=owner)
    with pytest.raises(PermissionError, match="permission denied"):
        db.sql("select * from public.team_members", anon=True)


def test_members_never_see_each_others_designs(db):
    owner, (m1, m2) = team_with(db, 2)
    design = new_design(db, m1)
    assert db.sql(f"select count(*) from public.designs where id = '{design}'", user=m2) == [["0"]]
    assert db.sql(f"select count(*) from public.designs where id = '{design}'", user=owner) == [["0"]]


def test_team_functions_are_service_role_only(db):
    u = new_user(db)
    for call in (f"team_create_invite('{u}', 'x@example.com', '{token_hash()}', now(), 4)",
                 f"team_accept_invite('{u}', 'x@example.com', '{token_hash()}', 4)",
                 f"team_remove_member('{u}', '{u}')", f"team_end('{u}')", f"billing_credit_owner('{u}')",
                 f"apply_seat_event('fake', 'e', '{u}', 's', 'active', null, 1000, 'r', null)"):
        with pytest.raises(PermissionError, match="permission denied"):
            db.sql(f"select public.{call}", user=u)


# ---------- invites ----------

def test_only_an_active_business_owner_can_invite(db):
    pro = new_user(db)
    svc(db, f"select public.apply_billing_event('fake', '{uuid.uuid4().hex}', '{pro}', 'pro', 'month', 'active', null, 'c', 's-{pro[:6]}', 0, null, null)")
    for who in (new_user(db), pro):
        with pytest.raises(PermissionError, match="business_required"):
            invite(db, who, "x@example.com")
    owner, (member,) = team_with(db, 1)
    with pytest.raises(PermissionError, match="business_required"):  # a member has no Business of their own
        invite(db, member, "y@example.com")


def test_expired_reused_revoked_or_other_email_tokens_fail(db):
    owner = business_owner(db)
    u, v = new_user(db), new_user(db)
    old = invite(db, owner, email_of(u), expires="now() - interval '1 second'")
    with pytest.raises(PermissionError, match="invite_expired"):
        accept(db, u, old)
    h = invite(db, owner, email_of(u))
    with pytest.raises(PermissionError, match="invite_other_email"):
        accept(db, v, h)  # someone else holding the link
    accept(db, u, h)
    with pytest.raises(PermissionError, match="invite_used"):
        accept(db, u, h)  # reused
    revoked = invite(db, owner, email_of(v))
    invite_id = svc(db, f"select id from public.team_invites where token_hash = '{revoked}'")[0][0]
    assert svc(db, f"select public.team_revoke_invite('{owner}', '{invite_id}')") == [["t"]]
    with pytest.raises(PermissionError, match="invite_used"):
        accept(db, v, revoked)
    with pytest.raises(PermissionError, match="invite_invalid"):
        accept(db, v, token_hash())
    assert svc(db, f"select count(*) from public.team_invites where token_hash = '{h}' and email = '{email_of(u)}'") == [["1"]]
    assert svc(db, "select count(*) from public.team_invites where token_hash !~ '^[0-9a-f]{64}$'") == [["0"]]


def test_a_user_in_a_team_cannot_accept_a_second_invite(db):
    a, (member,) = team_with(db, 1)
    b = business_owner(db)
    with pytest.raises(PermissionError, match="already_in_team"):
        accept(db, member, invite(db, b, email_of(member)))
    with pytest.raises(PermissionError, match="already_in_team"):
        accept(db, a, invite(db, b, email_of(a)))  # an owner is in their own team


def race(db, owner, users, hashes) -> dict[str, str]:
    results: dict[str, str] = {}
    gate = threading.Barrier(len(users))

    def go(u, h):
        gate.wait()
        try:
            accept(db, u, h)
            results[u] = "joined"
        except PermissionError as exc:
            results[u] = "no_seats" if "no_seats" in str(exc) else str(exc)
    threads = [threading.Thread(target=go, args=(u, h)) for u, h in zip(users, hashes)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return results


def test_seats_cannot_be_exceeded_even_with_concurrent_accepts(db):
    # Several rounds, many accepts released at the same moment: owner + 3 members, never more.
    for _ in range(4):
        owner = business_owner(db)
        users = [new_user(db) for _ in range(10)]
        hashes = [invite(db, owner, email_of(u)) for u in users]  # only the owner holds a seat so far
        results = race(db, owner, users, hashes)
        assert sorted(results.values()) == ["joined"] * 3 + ["no_seats"] * 7, results
        assert svc(db, f"select count(*) from public.team_members where owner_id = '{owner}'") == [["4"]]
    with pytest.raises(PermissionError, match="no_seats"):
        invite(db, owner, "one-more@example.com")
    # An extra seat makes room for exactly one more.
    svc(db, f"select public.apply_seat_event('fake', '{uuid.uuid4().hex}', '{owner}', 'seat-{owner[:6]}', 'active', null, 0, null, null)")
    late = [u for u, r in results.items() if r == "no_seats"]
    accept(db, late[0], invite(db, owner, email_of(late[0])))
    with pytest.raises(PermissionError, match="no_seats"):
        accept(db, late[1], hashes[users.index(late[1])])


# ---------- the shared pool ----------

def test_a_member_spends_the_owners_credits_and_the_owner_sees_who(db):
    owner, (member,) = team_with(db, 1)
    grant(db, owner, 30)
    design = new_design(db, member)
    reserve(db, member, design, "m-job")
    consume(db, member, "m-job")
    assert total(db, owner) == 20 and total(db, member) == 0
    rows = db.sql("select kind, amount, acting_email, design_id from public.my_credit_entries(10, 0) where kind = 'spend'", user=owner)
    assert rows == [["spend", "-10", email_of(member), ""]]  # who spent; the member's design id stays private
    assert db.sql(f"select owner_id from public.operation_log where job_id = 'm-job'", service=True) == [[member]]
    assert db.sql("select public.my_credits_spent(now() - interval '1 hour')", user=owner) == [["10"]]


def test_a_member_with_zero_team_credits_gets_insufficient_and_nothing_runs(db):
    owner, (member,) = team_with(db, 1)
    grant(db, member, 50)  # the member's own credits are not the pool
    with pytest.raises(PermissionError, match="insufficient_credits"):
        reserve(db, member, new_design(db, member), "broke")
    assert svc(db, "select count(*) from public.operation_log where job_id = 'broke'") == [["0"]]
    assert svc(db, "select count(*) from public.credit_reservations where job_id = 'broke'") == [["0"]]


def test_removing_a_member_stops_pool_access_at_once(db):
    owner, (member,) = team_with(db, 1)
    grant(db, owner, 100)
    design = new_design(db, member)
    reserve(db, member, design, "before")
    assert svc(db, f"select public.team_remove_member('{owner}', '{member}')") == [["t"]]
    with pytest.raises(PermissionError, match="insufficient_credits"):
        reserve(db, member, design, "after")
    consume(db, member, "before")  # what was already running settles normally
    assert total(db, owner) == 90
    with pytest.raises(PermissionError, match="cannot_remove_owner"):
        svc(db, f"select public.team_remove_member('{owner}', '{owner}')")


def test_plan_end_removes_team_access_but_keeps_designs_and_credits(db):
    owner, (member,) = team_with(db, 1)
    grant(db, owner, 100)
    design = new_design(db, member)
    business(db, owner, status="canceled", end="null")  # deactivated
    assert svc(db, f"select public.billing_credit_owner('{member}')") == [[member]]  # pool gone at once
    assert svc(db, f"select public.team_end('{owner}')") == [["1"]]
    assert svc(db, f"select count(*) from public.team_members where user_id = '{member}'") == [["0"]]
    assert db.sql(f"select count(*) from public.designs where id = '{design}'", user=member) == [["1"]]
    assert total(db, owner) == 100


def test_cancelled_but_paid_until_later_keeps_the_team(db):
    owner, (member,) = team_with(db, 1)
    business(db, owner, status="canceled", end="now() + interval '5 days'")
    assert svc(db, f"select public.billing_credit_owner('{member}')") == [[owner]]
    assert svc(db, f"select public.team_end('{owner}')") == [["0"]]


# ---------- extra seats ----------

def test_seat_credits_are_granted_once_and_not_after_cancel(db):
    owner = business_owner(db)
    call = ("select public.apply_seat_event('fake', '{e}', '{o}', 'seat-x{o8}', '{s}', null, 1000, '{ref}', "
            "date_trunc('month', now()) + interval '1 month')")
    ref = f"seat:seat-x{owner[:8]}:2026-10-01"
    assert svc(db, call.format(e=f"s1-{owner}", o=owner, o8=owner[:8], s="active", ref=ref)) == [["applied"]]
    assert svc(db, call.format(e=f"s1-{owner}", o=owner, o8=owner[:8], s="active", ref=ref)) == [["duplicate"]]
    assert svc(db, call.format(e=f"s2-{owner}", o=owner, o8=owner[:8], s="active", ref=ref)) == [["applied"]]  # same period
    assert svc(db, f"select count(*), sum(delta) from public.credit_ledger where owner_id = '{owner}' and reason = 'seat_grant'") == [["1", "1000"]]
    next_ref = f"seat:seat-x{owner[:8]}:2026-11-01"
    svc(db, call.format(e=f"s3-{owner}", o=owner, o8=owner[:8], s="canceled", ref=next_ref))
    assert svc(db, f"select count(*) from public.credit_ledger where owner_id = '{owner}' and ref = '{next_ref}'") == [["0"]]
    other = new_user(db)
    assert svc(db, call.format(e=f"s4-{owner}", o=other, o8=owner[:8], s="active", ref="x")) == [["ignored: owner mismatch"]]
