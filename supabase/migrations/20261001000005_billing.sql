-- Stitchbook, migration 5: credits, plans and billing (Step 13).
-- Paste after 20261001000003_storage.sql (and after migration 4 if you have one; this file does not
-- depend on it). Safe to run once; it creates only the objects below.
--
-- Money and credits are written ONLY by the security-definer functions at the end of this file,
-- which only the server's secret key (service_role) may execute. Signed-in users can READ their
-- own rows (row level security, owner_id = (select auth.uid())) and nothing else: no insert,
-- update or delete. Visitors who are not signed in (anon) get nothing.
--
-- Credits:
--   credit_ledger        append-only grants (+) and adjustments; two buckets: 'plan' (the plan's
--                        allowance; monthly grants expire at the end of their UTC month unless
--                        rollover is on) and 'purchased' (never expires).
--   credit_reservations  one per metered operation (job): reserved when it starts, consumed only
--                        when it succeeds, released when it fails, is cancelled or goes stale.
--   credit_allocations   which grant(s) each reservation draws from: plan credits first
--                        (soonest-expiring first), then purchased.
--   available(bucket) = what is left of its unexpired grants, minus negative adjustments.
-- Every function that changes credits first locks the owner's profiles row (FOR UPDATE), so two
-- operations of one user never reserve the same credits.

-- ---------- subscriptions: one row per paying user (no row = Free) ----------

create table public.subscriptions (
  owner_id uuid primary key references public.profiles (id) on delete cascade,
  plan text not null default 'free' check (plan in ('free', 'pro', 'business')),
  billing_interval text check (billing_interval in ('month', 'year')),
  status text not null default 'active' check (status in ('active', 'past_due', 'canceled')),
  current_period_end timestamptz,
  provider text,
  provider_customer_id text,
  provider_subscription_id text,
  updated_at timestamptz not null default now()
);
comment on table public.subscriptions is 'The plan of each paying user; written only by the billing webhook (service role).';

-- ---------- credit_ledger: append-only ----------

create table public.credit_ledger (
  id bigint generated always as identity primary key,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  delta integer not null check (delta <> 0),
  bucket text not null check (bucket in ('plan', 'purchased')),
  reason text not null check (reason in ('plan_grant', 'free_grant', 'purchase', 'adjustment')),
  ref text not null,                -- idempotency key: "free_grant", "plan:{subscription}:{period_start}", ...
  expires_at timestamptz,           -- plan credits without rollover: end of their UTC month; null = never
  created_at timestamptz not null default now(),
  unique (owner_id, ref),
  check (bucket = 'plan' or expires_at is null)  -- purchased credits never expire
);
comment on table public.credit_ledger is 'Credit grants and adjustments; append-only.';

-- ---------- credit_reservations ----------

create table public.credit_reservations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  design_id uuid,                   -- kept as null if the design is deleted: spent credits stay spent
  job_id text not null,
  operation text not null check (operation ~ '^[a-z_]{1,40}$'),
  amount integer not null check (amount > 0),
  status text not null default 'reserved' check (status in ('reserved', 'consumed', 'released')),
  release_reason text,
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  unique (owner_id, job_id),
  foreign key (design_id, owner_id) references public.designs (id, owner_id) on delete set null (design_id),
  check ((status = 'reserved') = (settled_at is null))
);
comment on table public.credit_reservations is 'Credits held for one operation: reserved -> consumed (success) or released (failure, cancel, stale).';

create table public.credit_allocations (
  reservation_id uuid not null references public.credit_reservations (id) on delete cascade,
  ledger_id bigint not null references public.credit_ledger (id) on delete cascade,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  amount integer not null check (amount > 0),
  primary key (reservation_id, ledger_id)
);
comment on table public.credit_allocations is 'Which grant each reservation draws from (plan first, then purchased).';

-- ---------- operation_log: one row for every operation ----------

create table public.operation_log (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  design_id uuid,
  job_id text not null,
  operation text not null check (operation ~ '^[a-z_]{1,40}$'),
  format text,
  settings jsonb not null default '{}'::jsonb,
  credits integer not null default 0 check (credits >= 0),
  status text not null default 'started' check (status in ('started', 'succeeded', 'failed', 'cancelled')),
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  error text,
  unique (owner_id, job_id),
  foreign key (design_id, owner_id) references public.designs (id, owner_id) on delete set null (design_id)
);
comment on table public.operation_log is 'Who ran which operation on which design, when, with what settings, and how it ended.';

-- ---------- processed_webhook_events: each provider event is applied once ----------

create table public.processed_webhook_events (
  provider text not null,
  event_id text not null,
  received_at timestamptz not null default now(),
  primary key (provider, event_id)
);
comment on table public.processed_webhook_events is 'Provider webhook events already applied (replays are ignored).';

-- ---------- indexes ----------

create index credit_ledger_owner_created_idx on public.credit_ledger (owner_id, created_at);
create index credit_reservations_owner_created_idx on public.credit_reservations (owner_id, created_at);
create index credit_reservations_design_owner_idx on public.credit_reservations (design_id, owner_id);
create index credit_reservations_open_idx on public.credit_reservations (created_at) where status = 'reserved';
create index credit_allocations_ledger_idx on public.credit_allocations (ledger_id);
create index credit_allocations_owner_idx on public.credit_allocations (owner_id);
create index operation_log_owner_created_idx on public.operation_log (owner_id, created_at);
create index operation_log_design_owner_idx on public.operation_log (design_id, owner_id);
-- The composite foreign keys of migration 1 (jobs, exports -> designs (id, owner_id)) get a
-- matching index too (Performance Advisor: unindexed foreign keys). "if not exists": harmless if
-- an earlier migration already made one with the same name.
create index if not exists jobs_design_owner_idx on public.jobs (design_id, owner_id);
create index if not exists exports_design_owner_idx on public.exports (design_id, owner_id);

-- ---------- row level security: read own rows only ----------

alter table public.subscriptions enable row level security;
alter table public.credit_ledger enable row level security;
alter table public.credit_reservations enable row level security;
alter table public.credit_allocations enable row level security;
alter table public.operation_log enable row level security;
alter table public.processed_webhook_events enable row level security;

revoke all on table public.subscriptions, public.credit_ledger, public.credit_reservations,
  public.credit_allocations, public.operation_log, public.processed_webhook_events from anon, authenticated;
grant select on table public.subscriptions, public.credit_ledger, public.credit_reservations,
  public.credit_allocations, public.operation_log to authenticated;

create policy "subscriptions: owner can read" on public.subscriptions
  for select to authenticated using (owner_id = (select auth.uid()));
create policy "credit_ledger: owner can read" on public.credit_ledger
  for select to authenticated using (owner_id = (select auth.uid()));
create policy "credit_reservations: owner can read" on public.credit_reservations
  for select to authenticated using (owner_id = (select auth.uid()));
create policy "credit_allocations: owner can read" on public.credit_allocations
  for select to authenticated using (owner_id = (select auth.uid()));
create policy "operation_log: owner can read" on public.operation_log
  for select to authenticated using (owner_id = (select auth.uid()));
-- processed_webhook_events: no policy at all; only the service role touches it.

-- The ledger is append-only, even for the service role (rows go only when an account is deleted).
revoke update, delete, truncate on table public.credit_ledger from service_role;

create or replace function public.credit_ledger_append_only()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception 'credit_ledger is append-only';
end;
$$;
create trigger credit_ledger_no_update before update on public.credit_ledger
  for each row execute function public.credit_ledger_append_only();

-- ---------- functions (service role only) ----------

-- Serialises every credit change of one owner.
create or replace function public.billing_lock_owner(p_owner uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1 from public.profiles where id = p_owner for update;
  if not found then
    raise exception 'unknown_owner' using errcode = 'P0002';
  end if;
end;
$$;

-- What is left of each unexpired positive grant.
create or replace function public.billing_open_grants(p_owner uuid)
returns table (ledger_id bigint, bucket text, remaining integer, expires_at timestamptz, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select l.id, l.bucket,
         (l.delta - coalesce((
           select sum(a.amount) from public.credit_allocations a
           join public.credit_reservations r on r.id = a.reservation_id
           where a.ledger_id = l.id and r.status <> 'released'), 0))::integer,
         l.expires_at, l.created_at
  from public.credit_ledger l
  where l.owner_id = p_owner and l.delta > 0 and (l.expires_at is null or l.expires_at > now())
$$;

-- available / reserved / consumed, per bucket.
create or replace function public.credit_balance(p_owner uuid)
returns table (bucket text, available integer, reserved integer, consumed integer)
language sql
stable
security definer
set search_path = ''
as $$
  select b.bucket,
         greatest(0,
           coalesce((select sum(g.remaining) from public.billing_open_grants(p_owner) g where g.bucket = b.bucket), 0)
           + coalesce((select sum(l.delta) from public.credit_ledger l
                       where l.owner_id = p_owner and l.bucket = b.bucket and l.delta < 0), 0))::integer,
         coalesce((select sum(a.amount) from public.credit_allocations a
                   join public.credit_reservations r on r.id = a.reservation_id
                   join public.credit_ledger l on l.id = a.ledger_id
                   where a.owner_id = p_owner and l.bucket = b.bucket and r.status = 'reserved'), 0)::integer,
         coalesce((select sum(a.amount) from public.credit_allocations a
                   join public.credit_reservations r on r.id = a.reservation_id
                   join public.credit_ledger l on l.id = a.ledger_id
                   where a.owner_id = p_owner and l.bucket = b.bucket and r.status = 'consumed'), 0)::integer
  from (values ('plan'), ('purchased')) as b (bucket)
$$;

-- Adds credits once per ref. Returns true if granted now, false if this ref was granted before.
create or replace function public.grant_credits(p_owner uuid, p_amount integer, p_bucket text, p_reason text, p_ref text,
                                                p_expires_at timestamptz default null)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.billing_lock_owner(p_owner);
  insert into public.credit_ledger (owner_id, delta, bucket, reason, ref, expires_at)
  values (p_owner, p_amount, p_bucket, p_reason, p_ref, p_expires_at)
  on conflict (owner_id, ref) do nothing;
  return found;
end;
$$;

-- Starts an operation: logs it ('started') and, if it costs credits, reserves them (plan bucket
-- first, then purchased). Raises 'insufficient_credits' when fewer are available. Calling it again
-- with the same job_id changes nothing and returns the existing state.
create or replace function public.reserve_credit(p_owner uuid, p_design uuid, p_job text, p_operation text, p_format text,
                                                 p_settings jsonb, p_amount integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
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
  perform public.billing_lock_owner(p_owner);
  select status into v_status from public.credit_reservations where owner_id = p_owner and job_id = p_job;
  if found then
    return jsonb_build_object('job_id', p_job, 'status', v_status, 'amount', p_amount, 'repeat', true);
  end if;
  select status into v_status from public.operation_log where owner_id = p_owner and job_id = p_job;
  if found then
    return jsonb_build_object('job_id', p_job, 'status', v_status, 'amount', 0, 'repeat', true);
  end if;
  if p_amount > 0 then
    select coalesce(sum(available), 0) into v_available from public.credit_balance(p_owner);
    if v_available < p_amount then
      raise exception 'insufficient_credits'
        using errcode = 'P0001', detail = jsonb_build_object('available', v_available, 'needed', p_amount)::text;
    end if;
    insert into public.credit_reservations (owner_id, design_id, job_id, operation, amount)
    values (p_owner, p_design, p_job, p_operation, p_amount)
    returning id into v_reservation;
    for g in
      select * from public.billing_open_grants(p_owner) o
      where o.remaining > 0
      order by case o.bucket when 'plan' then 0 else 1 end, o.expires_at asc nulls last, o.created_at, o.ledger_id
    loop
      v_take := least(v_need, g.remaining);
      insert into public.credit_allocations (reservation_id, ledger_id, owner_id, amount)
      values (v_reservation, g.ledger_id, p_owner, v_take);
      v_need := v_need - v_take;
      exit when v_need = 0;
    end loop;
    if v_need > 0 then  -- negative adjustments can leave grants short of the net balance
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

-- The operation succeeded: its reservation is consumed (only from 'reserved'). Retry-safe.
create or replace function public.consume_credit(p_owner uuid, p_job text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  perform public.billing_lock_owner(p_owner);
  update public.credit_reservations set status = 'consumed', settled_at = now()
  where owner_id = p_owner and job_id = p_job and status = 'reserved';
  update public.operation_log set status = 'succeeded', finished_at = now()
  where owner_id = p_owner and job_id = p_job and status = 'started';
  select status into v_status from public.operation_log where owner_id = p_owner and job_id = p_job;
  return coalesce(v_status, 'unknown');
end;
$$;

-- The operation failed or was cancelled: its reservation is released (only from 'reserved'; a
-- consumed credit is never released). p_status: 'failed' or 'cancelled'. Retry-safe.
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
  perform public.billing_lock_owner(p_owner);
  update public.credit_reservations set status = 'released', settled_at = now(), release_reason = p_reason
  where owner_id = p_owner and job_id = p_job and status = 'reserved';
  update public.operation_log set status = p_status, finished_at = now(), error = p_reason
  where owner_id = p_owner and job_id = p_job and status = 'started';
  select status into v_status from public.operation_log where owner_id = p_owner and job_id = p_job;
  return coalesce(v_status, 'unknown');
end;
$$;

-- Releases reservations still open after p_older_than (their job is presumed lost). Returns how many.
create or replace function public.release_stale_reservations(p_older_than interval)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  o record;
  v_count integer := 0;
  v_one integer;
begin
  for o in
    select distinct owner_id from public.credit_reservations
    where status = 'reserved' and created_at < now() - p_older_than order by owner_id
  loop
    perform public.billing_lock_owner(o.owner_id);
    with released as (
      update public.credit_reservations set status = 'released', settled_at = now(), release_reason = 'timed out'
      where owner_id = o.owner_id and status = 'reserved' and created_at < now() - p_older_than
      returning job_id
    ), logged as (
      update public.operation_log set status = 'failed', finished_at = now(), error = 'timed out'
      where owner_id = o.owner_id and status = 'started' and job_id in (select job_id from released)
      returning 1
    )
    select count(*) into v_one from released;
    v_count := v_count + v_one;
  end loop;
  return v_count;
end;
$$;

-- Applies one verified provider event atomically: records it (a replay returns 'duplicate' and
-- changes nothing), updates the subscription, and grants the period's plan credits (once per ref).
create or replace function public.apply_billing_event(p_provider text, p_event_id text, p_owner uuid, p_plan text,
                                                      p_interval text, p_status text, p_period_end timestamptz,
                                                      p_customer text, p_subscription text, p_grant_amount integer,
                                                      p_grant_ref text, p_grant_expires_at timestamptz)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.processed_webhook_events (provider, event_id) values (p_provider, p_event_id)
  on conflict do nothing;
  if not found then
    return 'duplicate';
  end if;
  perform public.billing_lock_owner(p_owner);
  insert into public.subscriptions (owner_id, plan, billing_interval, status, current_period_end, provider,
                                    provider_customer_id, provider_subscription_id, updated_at)
  values (p_owner, p_plan, p_interval, p_status, p_period_end, p_provider, p_customer, p_subscription, now())
  on conflict (owner_id) do update set
    plan = excluded.plan, billing_interval = excluded.billing_interval, status = excluded.status,
    current_period_end = excluded.current_period_end, provider = excluded.provider,
    provider_customer_id = excluded.provider_customer_id,
    provider_subscription_id = excluded.provider_subscription_id, updated_at = now();
  if coalesce(p_grant_amount, 0) > 0 and p_grant_ref is not null then
    insert into public.credit_ledger (owner_id, delta, bucket, reason, ref, expires_at)
    values (p_owner, p_grant_amount, 'plan', 'plan_grant', p_grant_ref, p_grant_expires_at)
    on conflict (owner_id, ref) do nothing;
  end if;
  return 'applied';
end;
$$;

-- Only the server's secret key (service_role) may run these; never signed-in users or anon.
revoke all on function public.billing_lock_owner(uuid) from public, anon, authenticated;
revoke all on function public.billing_open_grants(uuid) from public, anon, authenticated;
revoke all on function public.credit_balance(uuid) from public, anon, authenticated;
revoke all on function public.grant_credits(uuid, integer, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.reserve_credit(uuid, uuid, text, text, text, jsonb, integer) from public, anon, authenticated;
revoke all on function public.consume_credit(uuid, text) from public, anon, authenticated;
revoke all on function public.release_credit(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.release_stale_reservations(interval) from public, anon, authenticated;
revoke all on function public.apply_billing_event(text, text, uuid, text, text, text, timestamptz, text, text, integer, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.credit_ledger_append_only() from public, anon, authenticated;

grant execute on function public.billing_lock_owner(uuid) to service_role;
grant execute on function public.billing_open_grants(uuid) to service_role;
grant execute on function public.credit_balance(uuid) to service_role;
grant execute on function public.grant_credits(uuid, integer, text, text, text, timestamptz) to service_role;
grant execute on function public.reserve_credit(uuid, uuid, text, text, text, jsonb, integer) to service_role;
grant execute on function public.consume_credit(uuid, text) to service_role;
grant execute on function public.release_credit(uuid, text, text, text) to service_role;
grant execute on function public.release_stale_reservations(interval) to service_role;
grant execute on function public.apply_billing_event(text, text, uuid, text, text, text, timestamptz, text, text, integer, text, timestamptz)
  to service_role;
