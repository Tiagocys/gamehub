-- Allow admins to update their own profile (previous policy blocked updates when is_admin = true)

drop policy if exists "Users update own profile" on public.users;
drop policy if exists "Admins update own profile" on public.users;

create policy "Users update own profile" on public.users
  for update using (
    auth.jwt()->>'role' = 'authenticated'
    and auth.uid() = id
    and coalesce(is_admin, false) = false
  )
  with check (
    auth.jwt()->>'role' = 'authenticated'
    and auth.uid() = id
    and coalesce(is_admin, false) = false
  );

create policy "Admins update own profile" on public.users
  for update using (
    auth.jwt()->>'role' = 'authenticated'
    and auth.uid() = id
    and coalesce(is_admin, false) = true
  )
  with check (
    auth.jwt()->>'role' = 'authenticated'
    and auth.uid() = id
    and coalesce(is_admin, false) = true
  );
