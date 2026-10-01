-- Stitchbook, migration 2 of 3: a profile row for every new account.
-- Paste after 20261001000001_tables.sql.
--
-- Runs as the function's owner (security definer) because the new user is not signed in yet when
-- auth.users gets the row. It only inserts the user's own id; search_path is empty, so every name
-- is schema-qualified. Execute is revoked from the API roles: only the trigger calls it.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id) values (new.id) on conflict (id) do nothing;
  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
