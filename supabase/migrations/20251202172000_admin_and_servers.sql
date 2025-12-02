-- Restrict server creation to admins, add admin flag to users, and simplify server type.

-- 1) Simplify game_type to text (general) and drop enum
alter table public.servers
  alter column game_type type text using game_type::text,
  alter column game_type set default 'general';
update public.servers set game_type = 'general' where game_type is null or game_type = '';
drop type if exists public.game_type;

-- 2) Admin flag on users
alter table public.users add column if not exists is_admin boolean not null default false;

-- 3) RLS: users cannot self-promote; only service_role can change is_admin
drop policy if exists "Users manage own profile" on public.users;
drop policy if exists "Users update own profile" on public.users;

-- Insert: only self, cannot set is_admin
create policy "Users manage own profile" on public.users
  for insert
  with check (auth.jwt()->>'role' = 'authenticated' and auth.uid() = id and coalesce(is_admin, false) = false);

-- Update: only self, cannot change is_admin
create policy "Users update own profile" on public.users
  for update using (auth.jwt()->>'role' = 'authenticated' and auth.uid() = id and is_admin = false)
  with check (auth.jwt()->>'role' = 'authenticated' and auth.uid() = id and is_admin = false);

create policy "Service role manages users" on public.users
  for all using (auth.jwt()->>'role' = 'service_role') with check (true);

-- 4) Servers: only admins create/update/delete (public read stays)
drop policy if exists "Owners manage servers" on public.servers;
create policy "Admins manage servers" on public.servers
  for all using (
    exists (
      select 1 from public.users u where u.id = auth.uid() and u.is_admin = true
    )
    or auth.jwt()->>'role' = 'service_role'
  )
  with check (
    exists (
      select 1 from public.users u where u.id = auth.uid() and u.is_admin = true
    )
    or auth.jwt()->>'role' = 'service_role'
  );
