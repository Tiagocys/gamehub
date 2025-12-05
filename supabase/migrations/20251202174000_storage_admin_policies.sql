-- Ensure listing_media bucket exists and add policies for admin uploads and public read.

-- Create bucket if it doesn't exist
do $$
begin
  if not exists (select 1 from storage.buckets where id = 'listing_media') then
    insert into storage.buckets (id, name, public) values ('listing_media', 'listing_media', false);
  end if;
end$$;

-- Allow public read of listing_media assets (for logos/banners)
drop policy if exists "Public read listing_media" on storage.objects;
create policy "Public read listing_media" on storage.objects
  for select using (bucket_id = 'listing_media');

-- Allow admins and service role to upload/update/delete listing_media
drop policy if exists "Admins manage listing_media" on storage.objects;
create policy "Admins manage listing_media" on storage.objects
  for all using (
    bucket_id = 'listing_media' and (
      auth.jwt()->>'role' = 'service_role'
      or exists (select 1 from public.users u where u.id = auth.uid() and u.is_admin = true)
    )
  )
  with check (
    bucket_id = 'listing_media' and (
      auth.jwt()->>'role' = 'service_role'
      or exists (select 1 from public.users u where u.id = auth.uid() and u.is_admin = true)
    )
  );
