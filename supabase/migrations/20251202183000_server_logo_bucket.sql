-- Bucket dedicated to server logos with public read and admin-only writes.

do $$
begin
  if not exists (select 1 from storage.buckets where id = 'server_logos') then
    insert into storage.buckets (id, name, public, file_size_limit)
    values ('server_logos', 'server_logos', false, 5242880); -- 5MB
  else
    update storage.buckets
      set file_size_limit = 5242880,
          public = false
      where id = 'server_logos';
  end if;
end$$;

-- Allow public read access (logos exibidas no front)
drop policy if exists "Public read server logos" on storage.objects;
create policy "Public read server logos" on storage.objects
  for select using (bucket_id = 'server_logos');

-- Allow admins/service role to manage uploads
drop policy if exists "Admins manage server logos" on storage.objects;
create policy "Admins manage server logos" on storage.objects
  for all using (
    bucket_id = 'server_logos' and (
      auth.jwt()->>'role' = 'service_role' or
      exists (select 1 from public.users u where u.id = auth.uid() and u.is_admin = true)
    )
  )
  with check (
    bucket_id = 'server_logos' and (
      auth.jwt()->>'role' = 'service_role' or
      exists (select 1 from public.users u where u.id = auth.uid() and u.is_admin = true)
    )
  );
