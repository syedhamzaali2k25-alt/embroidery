-- Stitchbook, migration 3 of 3: private Storage buckets and their policies.
-- Paste after 20261001000002_profiles_on_signup.sql.
--
-- Two private buckets (public = false: no public URLs; files are read through short-lived signed
-- URLs made by the API):
--   uploads  the logo as uploaded:                    {user_id}/{design_id}/original.{png|jpg|svg}
--   exports  files made from it (DST, preview, report): {user_id}/{design_id}/{file}
-- A signed-in user can read and write only objects whose first folder is their own user id.
-- There is no policy for anon.

insert into storage.buckets (id, name, public, allowed_mime_types)
values
  ('uploads', 'uploads', false, array['image/png', 'image/jpeg', 'image/svg+xml']),
  ('exports', 'exports', false, null)
on conflict (id) do update set public = false;

create policy "stitchbook files: owner can read" on storage.objects
  for select to authenticated
  using (bucket_id in ('uploads', 'exports') and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "stitchbook files: owner can upload" on storage.objects
  for insert to authenticated
  with check (bucket_id in ('uploads', 'exports') and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "stitchbook files: owner can update" on storage.objects
  for update to authenticated
  using (bucket_id in ('uploads', 'exports') and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id in ('uploads', 'exports') and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "stitchbook files: owner can delete" on storage.objects
  for delete to authenticated
  using (bucket_id in ('uploads', 'exports') and (storage.foldername(name))[1] = (select auth.uid())::text);
