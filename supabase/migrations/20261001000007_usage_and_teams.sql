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
