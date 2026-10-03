-- Step 13d + 13b. Run AFTER 20261001000006_whop_subscription_owner.sql, once, in the SQL Editor.
--
-- Part 1 (Step 13d): Export history and Credit usage, read AS THE SIGNED-IN USER.
--   The API calls these functions with the user's own token (publishable key + their JWT), never
--   with the secret key. They are "security invoker": row level security decides what each one
--   sees, and every query also filters on (select auth.uid()). The one exception is
--   my_credit_balance(): the balance math (credit_balance) is a service-role function, so a
--   security-definer wrapper runs it for the CALLER ONLY (auth.uid()), never for an id passed in.
--
-- Part 2 (Step 13b): Teams. Appended below Part 1 in this same file.

-- ============================================================ Part 1: usage (Step 13d)

-- The caller's finished exports, newest first: design name, format, file size, credits used.
create or replace function public.my_export_history(p_limit integer, p_offset integer)
returns table (job_id text, design_id uuid, design_name text, format text, bytes integer, credits integer,
               finished_at timestamptz)
language sql
stable
security invoker
set search_path = ''
as $$
  select o.job_id, o.design_id, d.filename, o.format, e.bytes, o.credits, coalesce(o.finished_at, o.created_at)
  from public.operation_log o
  left join public.designs d on d.id = o.design_id and d.owner_id = o.owner_id
  left join public.exports e on e.design_id = o.design_id and e.owner_id = o.owner_id and e.format = o.format
  where o.owner_id = (select auth.uid()) and o.operation = 'export' and o.status = 'succeeded'
  order by coalesce(o.finished_at, o.created_at) desc, o.id desc
  limit greatest(0, least(p_limit, 1000)) offset greatest(0, p_offset)
$$;

-- The caller's credit entries, newest first: grants (+) from the ledger and spends (-) from
-- consumed reservations, with the operation that spent them.
create or replace function public.my_credit_entries(p_limit integer, p_offset integer)
returns table (kind text, reason text, amount integer, bucket text, at timestamptz, operation text,
               design_id uuid, job_id text)
language sql
stable
security invoker
set search_path = ''
as $$
  select * from (
    select 'grant'::text, l.reason, l.delta, l.bucket, l.created_at, null::text, null::uuid, null::text
    from public.credit_ledger l
    where l.owner_id = (select auth.uid())
    union all
    select 'spend'::text, r.operation, -r.amount, null::text, r.settled_at, r.operation, r.design_id, r.job_id
    from public.credit_reservations r
    where r.owner_id = (select auth.uid()) and r.status = 'consumed'
  ) e (kind, reason, amount, bucket, at, operation, design_id, job_id)
  order by e.at desc, e.kind
  limit greatest(0, least(p_limit, 1000)) offset greatest(0, p_offset)
$$;

-- Credits the caller spent since a moment (this month's spend on /billing).
create or replace function public.my_credits_spent(p_since timestamptz)
returns integer
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(sum(r.amount), 0)::integer
  from public.credit_reservations r
  where r.owner_id = (select auth.uid()) and r.status = 'consumed' and r.settled_at >= p_since
$$;

-- The caller's plan row (for the renewal date): plan, interval, status, period end.
create or replace function public.my_subscription()
returns table (plan text, billing_interval text, status text, current_period_end timestamptz)
language sql
stable
security invoker
set search_path = ''
as $$
  select s.plan, s.billing_interval, s.status, s.current_period_end
  from public.subscriptions s
  where s.owner_id = (select auth.uid())
$$;

-- The caller's balance per bucket. Definer (credit_balance is service-role only), but only ever
-- for auth.uid(): there is no parameter to ask about anyone else.
create or replace function public.my_credit_balance()
returns table (bucket text, available integer, reserved integer, consumed integer)
language sql
stable
security definer
set search_path = ''
as $$
  select b.bucket, b.available, b.reserved, b.consumed
  from public.credit_balance((select auth.uid())) b
  where (select auth.uid()) is not null
$$;

revoke all on function public.my_export_history(integer, integer) from public, anon;
revoke all on function public.my_credit_entries(integer, integer) from public, anon;
revoke all on function public.my_credits_spent(timestamptz) from public, anon;
revoke all on function public.my_subscription() from public, anon;
revoke all on function public.my_credit_balance() from public, anon;
grant execute on function public.my_export_history(integer, integer) to authenticated;
grant execute on function public.my_credit_entries(integer, integer) to authenticated;
grant execute on function public.my_credits_spent(timestamptz) to authenticated;
grant execute on function public.my_subscription() to authenticated;
grant execute on function public.my_credit_balance() to authenticated;

-- ============================================================ Part 2: teams (Step 13b)
--
-- A Business owner can add members; members export with the OWNER's credits (one shared pool),
-- under the owner's row lock. Designs stay private to whoever made them. Everything that changes
-- a team runs in the security-definer functions below (service role only, called by the API's
-- billing module); signed-in users can only READ their own team rows.
--
-- Seats: owner + members <= included seats (from config.py, passed in by the API) + active
-- extra seats. Checked in SQL under the owner's lock, so concurrent accepts cannot overshoot.

create table public.teams (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
comment on table public.teams is 'One team per Business owner.';

create table public.team_members (
  team_id uuid not null references public.teams (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,   -- the team owner
  user_id uuid not null unique references auth.users (id) on delete cascade,  -- one person, one team
  role text not null check (role in ('owner', 'member')),
  email text,                                   -- shown to the owner (from the accepted invite)
  joined_at timestamptz not null default now(),
  primary key (team_id, user_id),
  check ((role = 'owner') = (user_id = owner_id))
);
comment on table public.team_members is 'Who is in which team; the owner is a member with role owner.';

create table public.team_invites (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  email text not null check (length(email) between 3 and 320),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),  -- sha256 of the link token
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id) on delete set null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
comment on table public.team_invites is 'Invite links; only a hash of the token is kept.';

create table public.team_extra_seats (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  provider text not null,
  provider_subscription_id text not null,
  status text not null check (status in ('active', 'past_due', 'canceled')),
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_subscription_id)
);
comment on table public.team_extra_seats is 'Extra seats bought through the payment provider; each adds a seat and monthly credits.';

create index team_members_owner_id_idx on public.team_members (owner_id);
create index team_invites_owner_id_idx on public.team_invites (owner_id);
create index team_invites_team_id_idx on public.team_invites (team_id);
create index team_invites_accepted_by_idx on public.team_invites (accepted_by);
create index team_extra_seats_owner_id_idx on public.team_extra_seats (owner_id);

-- Spends of a team member come out of the owner's pool: the reservation keeps who spent
-- (owner_id, the acting user, whose design it is) and whose credits paid (credit_owner_id).
alter table public.credit_reservations add column credit_owner_id uuid references public.profiles (id) on delete cascade;
update public.credit_reservations set credit_owner_id = owner_id where credit_owner_id is null;
alter table public.credit_reservations alter column credit_owner_id set not null;
create index credit_reservations_credit_owner_idx on public.credit_reservations (credit_owner_id, created_at);
-- Grants record who caused them, where there is one (an extra seat bought by the owner).
-- No foreign key: the ledger is append-only, so "on delete set null" could never run.
alter table public.credit_ledger add column acting_user_id uuid;
alter table public.credit_ledger drop constraint credit_ledger_reason_check;
alter table public.credit_ledger add constraint credit_ledger_reason_check
  check (reason in ('plan_grant', 'free_grant', 'purchase', 'adjustment', 'seat_grant'));

-- ---------- row level security: read only, owner (and the member's own row) ----------

alter table public.teams enable row level security;
alter table public.team_members enable row level security;
alter table public.team_invites enable row level security;
alter table public.team_extra_seats enable row level security;
revoke all on table public.teams, public.team_members, public.team_invites, public.team_extra_seats from anon, authenticated;
grant select on table public.teams, public.team_members, public.team_invites, public.team_extra_seats to authenticated;

create policy "teams: owner or member can read" on public.teams
  for select to authenticated using (owner_id = (select auth.uid())
    or exists (select 1 from public.team_members m where m.team_id = id and m.user_id = (select auth.uid())));
-- The owner reads every member; a member reads only their own row.
create policy "team_members: owner or self can read" on public.team_members
  for select to authenticated using (owner_id = (select auth.uid()) or user_id = (select auth.uid()));
create policy "team_invites: owner can read" on public.team_invites
  for select to authenticated using (owner_id = (select auth.uid()));
create policy "team_extra_seats: owner can read" on public.team_extra_seats
  for select to authenticated using (owner_id = (select auth.uid()));
-- The pool owner reads the reservations spent from their pool (to see which member spent).
drop policy "credit_reservations: owner can read" on public.credit_reservations;
create policy "credit_reservations: spender or pool owner can read" on public.credit_reservations
  for select to authenticated using (owner_id = (select auth.uid()) or credit_owner_id = (select auth.uid()));

-- ---------- who pays ----------

-- True while p_owner's Business plan gives access (active, or cancelled but paid until later).
create or replace function public.billing_business_active(p_owner uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.subscriptions s
                 where s.owner_id = p_owner and s.plan = 'business'
                   and (s.status = 'active' or (s.status = 'canceled' and s.current_period_end > now())))
$$;

-- Whose credits a user spends: the team owner while the user is a member of an active Business
-- team, otherwise the user.
create or replace function public.billing_credit_owner(p_user uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select m.owner_id from public.team_members m
                    where m.user_id = p_user and m.role = 'member' and public.billing_business_active(m.owner_id)),
                   p_user)
$$;

-- Seats a team may fill (owner included): the included seats (config) + active extra seats.
create or replace function public.team_seat_limit(p_owner uuid, p_included integer)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select p_included + (select count(*) from public.team_extra_seats x where x.owner_id = p_owner and x.status = 'active')::integer
$$;

-- ---------- credits: reserve / consume / release from the payer's pool ----------

create or replace function public.reserve_credit(p_owner uuid, p_design uuid, p_job text, p_operation text, p_format text,
                                                 p_settings jsonb, p_amount integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pool uuid;
  v_status text;
  v_available integer;
  v_reservation uuid;
  v_need integer := p_amount;
  v_take integer;
  g record;
begin
  if p_amount is null or p_amount < 0 then
    raise exception 'invalid_amount';
  end if;
  -- Lock order: the pool owner, then the acting user (a member never owns a pool).
  v_pool := public.billing_credit_owner(p_owner);
  perform public.billing_lock_owner(v_pool);
  if v_pool <> p_owner then
    perform public.billing_lock_owner(p_owner);
    v_pool := public.billing_credit_owner(p_owner);  -- re-checked under the lock (removed meanwhile?)
  end if;
  select status into v_status from public.credit_reservations where owner_id = p_owner and job_id = p_job;
  if found then
    return jsonb_build_object('job_id', p_job, 'status', v_status, 'amount', p_amount, 'repeat', true);
  end if;
  select status into v_status from public.operation_log where owner_id = p_owner and job_id = p_job;
  if found then
    return jsonb_build_object('job_id', p_job, 'status', v_status, 'amount', 0, 'repeat', true);
  end if;
  if p_amount > 0 then
    select coalesce(sum(available), 0) into v_available from public.credit_balance(v_pool);
    if v_available < p_amount then
      raise exception 'insufficient_credits'
        using errcode = 'P0001', detail = jsonb_build_object('available', v_available, 'needed', p_amount)::text;
    end if;
    insert into public.credit_reservations (owner_id, credit_owner_id, design_id, job_id, operation, amount)
    values (p_owner, v_pool, p_design, p_job, p_operation, p_amount)
    returning id into v_reservation;
    for g in
      select * from public.billing_open_grants(v_pool) o
      where o.remaining > 0
      order by case o.bucket when 'plan' then 0 else 1 end, o.expires_at asc nulls last, o.created_at, o.ledger_id
    loop
      v_take := least(v_need, g.remaining);
      insert into public.credit_allocations (reservation_id, ledger_id, owner_id, amount)
      values (v_reservation, g.ledger_id, v_pool, v_take);
      v_need := v_need - v_take;
      exit when v_need = 0;
    end loop;
    if v_need > 0 then
      raise exception 'insufficient_credits'
        using errcode = 'P0001', detail = jsonb_build_object('available', v_available, 'needed', p_amount)::text;
    end if;
  end if;
  insert into public.operation_log (owner_id, design_id, job_id, operation, format, settings, credits)
  values (p_owner, p_design, p_job, p_operation, p_format, coalesce(p_settings, '{}'::jsonb), p_amount);
  return jsonb_build_object('job_id', p_job, 'status', case when p_amount > 0 then 'reserved' else 'free' end,
                            'amount', p_amount, 'repeat', false);
end;
$$;

-- Locks the pool that paid for this job (if any), then the acting user.
create or replace function public.billing_lock_job(p_owner uuid, p_job text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pool uuid;
begin
  select credit_owner_id into v_pool from public.credit_reservations where owner_id = p_owner and job_id = p_job;
  if v_pool is not null and v_pool <> p_owner then
    perform public.billing_lock_owner(v_pool);
  end if;
  perform public.billing_lock_owner(p_owner);
end;
$$;

create or replace function public.consume_credit(p_owner uuid, p_job text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  perform public.billing_lock_job(p_owner, p_job);
  update public.credit_reservations set status = 'consumed', settled_at = now()
  where owner_id = p_owner and job_id = p_job and status = 'reserved';
  update public.operation_log set status = 'succeeded', finished_at = now()
  where owner_id = p_owner and job_id = p_job and status = 'started';
  select status into v_status from public.operation_log where owner_id = p_owner and job_id = p_job;
  return coalesce(v_status, 'unknown');
end;
$$;

create or replace function public.release_credit(p_owner uuid, p_job text, p_reason text, p_status text default 'failed')
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  if p_status not in ('failed', 'cancelled') then
    raise exception 'invalid_status';
  end if;
  perform public.billing_lock_job(p_owner, p_job);
  update public.credit_reservations set status = 'released', settled_at = now(), release_reason = p_reason
  where owner_id = p_owner and job_id = p_job and status = 'reserved';
  update public.operation_log set status = p_status, finished_at = now(), error = p_reason
  where owner_id = p_owner and job_id = p_job and status = 'started';
  select status into v_status from public.operation_log where owner_id = p_owner and job_id = p_job;
  return coalesce(v_status, 'unknown');
end;
$$;

-- ---------- teams: invites, accept, remove, end ----------

-- A new invite (the owner's Business must be active and a seat free now). Returns its id.
create or replace function public.team_create_invite(p_owner uuid, p_email text, p_token_hash text,
                                                     p_expires_at timestamptz, p_included_seats integer)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_team uuid;
  v_id uuid;
begin
  perform public.billing_lock_owner(p_owner);
  if not public.billing_business_active(p_owner) then
    raise exception 'business_required';
  end if;
  if exists (select 1 from public.team_members m where m.user_id = p_owner and m.role = 'member') then
    raise exception 'not_team_owner';
  end if;
  insert into public.teams (owner_id) values (p_owner) on conflict (owner_id) do nothing;
  select id into v_team from public.teams where owner_id = p_owner;
  insert into public.team_members (team_id, owner_id, user_id, role) values (v_team, p_owner, p_owner, 'owner')
  on conflict do nothing;
  if (select count(*) from public.team_members m where m.team_id = v_team)
     >= public.team_seat_limit(p_owner, p_included_seats) then
    raise exception 'no_seats';
  end if;
  -- One open invite per email: an older open one stops working.
  update public.team_invites set revoked_at = now()
  where team_id = v_team and lower(email) = lower(p_email) and accepted_at is null and revoked_at is null;
  insert into public.team_invites (team_id, owner_id, email, token_hash, expires_at)
  values (v_team, p_owner, lower(p_email), p_token_hash, p_expires_at)
  returning id into v_id;
  return v_id;
end;
$$;

-- Accepts an invite for p_user (whose verified email must match the invite). Each check raises a
-- named error; seats are counted under the team owner's lock.
create or replace function public.team_accept_invite(p_user uuid, p_email text, p_token_hash text, p_included_seats integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
  i record;
begin
  select owner_id into v_owner from public.team_invites where token_hash = p_token_hash;
  if not found then
    raise exception 'invite_invalid';
  end if;
  perform public.billing_lock_owner(v_owner);  -- the same lock as invites, removals and reservations
  select * into i from public.team_invites where token_hash = p_token_hash for update;
  if i.accepted_at is not null or i.revoked_at is not null then
    raise exception 'invite_used';
  end if;
  if i.expires_at <= now() then
    raise exception 'invite_expired';
  end if;
  if p_user = i.owner_id then
    raise exception 'invite_own_team';
  end if;
  if p_email is null or lower(p_email) <> lower(i.email) then
    raise exception 'invite_other_email';
  end if;
  if exists (select 1 from public.team_members m where m.user_id = p_user) then
    raise exception 'already_in_team';
  end if;
  if exists (select 1 from public.subscriptions s where s.owner_id = p_user and s.plan <> 'free'
             and (s.status = 'active' or (s.status = 'canceled' and s.current_period_end > now()))) then
    raise exception 'has_own_plan';
  end if;
  if not public.billing_business_active(i.owner_id) then
    raise exception 'team_inactive';
  end if;
  if (select count(*) from public.team_members m where m.team_id = i.team_id)
     >= public.team_seat_limit(i.owner_id, p_included_seats) then
    raise exception 'no_seats';
  end if;
  insert into public.team_members (team_id, owner_id, user_id, role, email)
  values (i.team_id, i.owner_id, p_user, 'member', lower(p_email));
  update public.team_invites set accepted_at = now(), accepted_by = p_user where id = i.id;
  return jsonb_build_object('team_id', i.team_id, 'owner_id', i.owner_id);
end;
$$;

-- The owner removes a member (never themself). Pool access stops at once: the next reservation
-- finds no membership. Returns true if someone was removed.
create or replace function public.team_remove_member(p_owner uuid, p_user uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user = p_owner then
    raise exception 'cannot_remove_owner';
  end if;
  perform public.billing_lock_owner(p_owner);
  delete from public.team_members where owner_id = p_owner and user_id = p_user and role = 'member';
  return found;
end;
$$;

create or replace function public.team_revoke_invite(p_owner uuid, p_invite uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.billing_lock_owner(p_owner);
  update public.team_invites set revoked_at = now()
  where id = p_invite and owner_id = p_owner and accepted_at is null and revoked_at is null;
  return found;
end;
$$;

-- The owner's Business has ended: members leave the team (their designs stay theirs) and open
-- invites stop working. Returns how many members were removed.
create or replace function public.team_end(p_owner uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  perform public.billing_lock_owner(p_owner);
  if public.billing_business_active(p_owner) then
    return 0;
  end if;
  delete from public.team_members where owner_id = p_owner and role = 'member';
  get diagnostics v_count = row_count;
  update public.team_invites set revoked_at = now() where owner_id = p_owner and accepted_at is null and revoked_at is null;
  return v_count;
end;
$$;

-- One verified extra-seat event, applied once (a replay returns 'duplicate'): the seat's status,
-- and this period's seat credits into the owner's plan bucket (once per ref, only while the
-- owner's Business is active). A seat already bound to another owner is refused.
create or replace function public.apply_seat_event(p_provider text, p_event_id text, p_owner uuid, p_subscription text,
                                                   p_status text, p_period_end timestamptz, p_grant_amount integer,
                                                   p_grant_ref text, p_grant_expires_at timestamptz)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.team_extra_seats x where x.provider = p_provider
             and x.provider_subscription_id = p_subscription and x.owner_id <> p_owner) then
    return 'ignored: owner mismatch';
  end if;
  insert into public.processed_webhook_events (provider, event_id) values (p_provider, p_event_id)
  on conflict do nothing;
  if not found then
    return 'duplicate';
  end if;
  perform public.billing_lock_owner(p_owner);
  insert into public.team_extra_seats (owner_id, provider, provider_subscription_id, status, current_period_end)
  values (p_owner, p_provider, p_subscription, p_status, p_period_end)
  on conflict (provider, provider_subscription_id) do update set
    status = excluded.status, current_period_end = coalesce(excluded.current_period_end, public.team_extra_seats.current_period_end),
    updated_at = now();
  if p_status = 'active' and coalesce(p_grant_amount, 0) > 0 and p_grant_ref is not null
     and public.billing_business_active(p_owner) then
    insert into public.credit_ledger (owner_id, delta, bucket, reason, ref, expires_at, acting_user_id)
    values (p_owner, p_grant_amount, 'plan', 'seat_grant', p_grant_ref, p_grant_expires_at, p_owner)
    on conflict (owner_id, ref) do nothing;
  end if;
  return 'applied';
end;
$$;

-- ---------- usage functions, now aware of the pool ----------

-- Entries of the caller's pool: grants, and spends by the caller or by their team's members
-- (acting_user_id / acting_email say who spent; null = the caller).
drop function public.my_credit_entries(integer, integer);
create function public.my_credit_entries(p_limit integer, p_offset integer)
returns table (kind text, reason text, amount integer, bucket text, at timestamptz, operation text,
               design_id uuid, job_id text, acting_user_id uuid, acting_email text)
language sql
stable
security invoker
set search_path = ''
as $$
  select * from (
    select 'grant'::text, l.reason, l.delta, l.bucket, l.created_at, null::text, null::uuid, null::text, null::uuid, null::text
    from public.credit_ledger l
    where l.owner_id = (select auth.uid())
    union all
    select 'spend'::text, r.operation, -r.amount, null::text, r.settled_at, r.operation,
           case when r.owner_id = (select auth.uid()) then r.design_id end,  -- a member's design stays theirs
           r.job_id,
           case when r.owner_id <> (select auth.uid()) then r.owner_id end,
           case when r.owner_id <> (select auth.uid()) then
             (select m.email from public.team_members m where m.user_id = r.owner_id and m.owner_id = (select auth.uid())) end
    from public.credit_reservations r
    where r.credit_owner_id = (select auth.uid()) and r.status = 'consumed'
  ) e (kind, reason, amount, bucket, at, operation, design_id, job_id, acting_user_id, acting_email)
  order by e.at desc, e.kind
  limit greatest(0, least(p_limit, 1000)) offset greatest(0, p_offset)
$$;

-- This month's spend from the caller's pool (members' spends included).
create or replace function public.my_credits_spent(p_since timestamptz)
returns integer
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(sum(r.amount), 0)::integer
  from public.credit_reservations r
  where r.credit_owner_id = (select auth.uid()) and r.status = 'consumed' and r.settled_at >= p_since
$$;

revoke all on function public.my_credit_entries(integer, integer) from public, anon;
grant execute on function public.my_credit_entries(integer, integer) to authenticated;

-- Service role only, like every function that changes credits or teams.
revoke all on function public.billing_business_active(uuid) from public, anon, authenticated;
revoke all on function public.billing_credit_owner(uuid) from public, anon, authenticated;
revoke all on function public.team_seat_limit(uuid, integer) from public, anon, authenticated;
revoke all on function public.billing_lock_job(uuid, text) from public, anon, authenticated;
revoke all on function public.team_create_invite(uuid, text, text, timestamptz, integer) from public, anon, authenticated;
revoke all on function public.team_accept_invite(uuid, text, text, integer) from public, anon, authenticated;
revoke all on function public.team_remove_member(uuid, uuid) from public, anon, authenticated;
revoke all on function public.team_revoke_invite(uuid, uuid) from public, anon, authenticated;
revoke all on function public.team_end(uuid) from public, anon, authenticated;
revoke all on function public.apply_seat_event(text, text, uuid, text, text, timestamptz, integer, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.billing_business_active(uuid) to service_role;
grant execute on function public.billing_credit_owner(uuid) to service_role;
grant execute on function public.team_seat_limit(uuid, integer) to service_role;
grant execute on function public.billing_lock_job(uuid, text) to service_role;
grant execute on function public.team_create_invite(uuid, text, text, timestamptz, integer) to service_role;
grant execute on function public.team_accept_invite(uuid, text, text, integer) to service_role;
grant execute on function public.team_remove_member(uuid, uuid) to service_role;
grant execute on function public.team_revoke_invite(uuid, uuid) to service_role;
grant execute on function public.team_end(uuid) to service_role;
grant execute on function public.apply_seat_event(text, text, uuid, text, text, timestamptz, integer, text, timestamptz)
  to service_role;
