-- Stitchbook, migration 1 of 3: tables, owner columns, indexes, row level security.
-- Paste into the Supabase SQL Editor first (see docs/supabase-setup.md). Safe to run once on an
-- empty project; it creates only the objects below and changes nothing else.
--
-- Every table has an owner: profiles.id is the user's own id; designs, jobs and exports have
-- owner_id. Row level security is on for all four, and a signed-in user can read and write only
-- rows they own (owner_id = auth.uid()). There is no policy for anon, so a visitor who is not
-- signed in sees no rows at all. The API's secret key bypasses RLS and is used on the server only
-- (the API still filters by the user id from the verified token).

-- ---------- helpers ----------

-- Keeps updated_at current. search_path is pinned (Security Advisor: function_search_path_mutable).
create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------- profiles: one per user, id = auth.users.id ----------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.profiles is 'One row per Stitchbook user; id is the auth.users id (the owner).';

-- ---------- designs: one per uploaded logo ----------

create table public.designs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  filename text not null,
  file_type text not null check (file_type in ('png', 'jpg', 'svg')),
  status text not null check (status in ('uploaded', 'digitized')),
  -- The API's full design record (settings, detected colours, warnings, editor changes, stats).
  record jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Lets jobs and exports require the same owner as their design (composite foreign keys below).
  unique (id, owner_id)
);
comment on table public.designs is 'A design per uploaded logo. Files live in Storage under {owner_id}/{id}/.';

-- ---------- jobs: background jobs ("Create satin columns") ----------

create table public.jobs (
  id text primary key check (id ~ '^[0-9a-f]{32}$'),  -- the RQ job id
  owner_id uuid not null references auth.users (id) on delete cascade,
  design_id uuid not null,
  kind text not null default 'trace' check (kind in ('trace')),
  status text not null check (status in ('queued', 'running', 'done', 'failed', 'cancelled')),
  -- The finished job as the API returns it, kept after Redis has expired the job.
  snapshot jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (design_id, owner_id) references public.designs (id, owner_id) on delete cascade
);
comment on table public.jobs is 'Background jobs per design; a job always has the same owner as its design.';

-- ---------- exports: machine files made for a design ----------

create table public.exports (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  design_id uuid not null,
  format text not null check (format ~ '^[a-z0-9]{2,5}$'),
  storage_path text not null,  -- in the private "exports" bucket: {owner_id}/{design_id}/out.{format}
  bytes integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (design_id, format),
  foreign key (design_id, owner_id) references public.designs (id, owner_id) on delete cascade,
  check (storage_path like owner_id::text || '/' || design_id::text || '/%')
);
comment on table public.exports is 'Machine files per design and format; the file is in the private exports bucket.';

-- ---------- indexes: owner_id on every table (RLS filters on it), plus design_id ----------

create index designs_owner_id_idx on public.designs (owner_id);
create index jobs_owner_id_idx on public.jobs (owner_id);
create index jobs_design_id_idx on public.jobs (design_id);
create index exports_owner_id_idx on public.exports (owner_id);
create index exports_design_id_idx on public.exports (design_id);
-- profiles.id is the primary key, so it is already indexed.

-- ---------- updated_at ----------

create trigger profiles_updated_at before update on public.profiles for each row execute function public.set_updated_at();
create trigger designs_updated_at before update on public.designs for each row execute function public.set_updated_at();
create trigger jobs_updated_at before update on public.jobs for each row execute function public.set_updated_at();
create trigger exports_updated_at before update on public.exports for each row execute function public.set_updated_at();

-- ---------- row level security ----------

alter table public.profiles enable row level security;
alter table public.designs enable row level security;
alter table public.jobs enable row level security;
alter table public.exports enable row level security;

-- Visitors who are not signed in get nothing: no policies for anon, and no table privileges.
revoke all on table public.profiles, public.designs, public.jobs, public.exports from anon;

-- profiles: the owner is the row's own id.
create policy "profiles: owner can read" on public.profiles
  for select to authenticated using (id = (select auth.uid()));
create policy "profiles: owner can insert" on public.profiles
  for insert to authenticated with check (id = (select auth.uid()));
create policy "profiles: owner can update" on public.profiles
  for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));
create policy "profiles: owner can delete" on public.profiles
  for delete to authenticated using (id = (select auth.uid()));

-- designs, jobs, exports: owner_id.
create policy "designs: owner can read" on public.designs
  for select to authenticated using (owner_id = (select auth.uid()));
create policy "designs: owner can insert" on public.designs
  for insert to authenticated with check (owner_id = (select auth.uid()));
create policy "designs: owner can update" on public.designs
  for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "designs: owner can delete" on public.designs
  for delete to authenticated using (owner_id = (select auth.uid()));

create policy "jobs: owner can read" on public.jobs
  for select to authenticated using (owner_id = (select auth.uid()));
create policy "jobs: owner can insert" on public.jobs
  for insert to authenticated with check (owner_id = (select auth.uid()));
create policy "jobs: owner can update" on public.jobs
  for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "jobs: owner can delete" on public.jobs
  for delete to authenticated using (owner_id = (select auth.uid()));

create policy "exports: owner can read" on public.exports
  for select to authenticated using (owner_id = (select auth.uid()));
create policy "exports: owner can insert" on public.exports
  for insert to authenticated with check (owner_id = (select auth.uid()));
create policy "exports: owner can update" on public.exports
  for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "exports: owner can delete" on public.exports
  for delete to authenticated using (owner_id = (select auth.uid()));
