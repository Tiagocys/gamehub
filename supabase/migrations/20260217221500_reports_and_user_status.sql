-- User account status + reports/moderation flow

do $$
begin
  if not exists (
    select 1 from pg_type where typname = 'user_account_status'
  ) then
    create type public.user_account_status as enum ('active', 'deleted', 'banned');
  end if;
end $$;

alter table public.users
  add column if not exists status public.user_account_status not null default 'active';

create index if not exists users_status_idx
  on public.users (status);

comment on column public.users.status is 'Status da conta do usuário: active, deleted, banned.';

do $$
begin
  if not exists (
    select 1 from pg_type where typname = 'report_target_type'
  ) then
    create type public.report_target_type as enum ('listing', 'user');
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_type where typname = 'report_status'
  ) then
    create type public.report_status as enum ('pending', 'handled');
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_type where typname = 'report_action'
  ) then
    create type public.report_action as enum ('none', 'marked_handled', 'listing_deleted', 'user_banned');
  end if;
end $$;

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.users(id) on delete cascade,
  target_type public.report_target_type not null,
  listing_id uuid references public.listings(id) on delete cascade,
  reported_user_id uuid references public.users(id) on delete cascade,
  reason text not null,
  status public.report_status not null default 'pending',
  action_taken public.report_action not null default 'none',
  admin_note text,
  handled_by_admin_id uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  handled_at timestamptz,
  constraint reports_reason_len check (char_length(trim(reason)) between 10 and 2000),
  constraint reports_target_check check (
    (target_type = 'listing' and listing_id is not null and reported_user_id is null)
    or
    (target_type = 'user' and listing_id is null and reported_user_id is not null)
  ),
  constraint reports_no_self_user check (
    reported_user_id is null or reporter_id <> reported_user_id
  )
);

create index if not exists reports_status_created_idx
  on public.reports (status, created_at);

create index if not exists reports_listing_idx
  on public.reports (listing_id);

create index if not exists reports_reported_user_idx
  on public.reports (reported_user_id);

create unique index if not exists reports_pending_listing_unique_idx
  on public.reports (reporter_id, listing_id)
  where target_type = 'listing' and status = 'pending' and listing_id is not null;

create unique index if not exists reports_pending_user_unique_idx
  on public.reports (reporter_id, reported_user_id)
  where target_type = 'user' and status = 'pending' and reported_user_id is not null;

alter table public.reports enable row level security;

drop policy if exists "Users create reports" on public.reports;
create policy "Users create reports" on public.reports
  for insert
  with check (
    auth.jwt()->>'role' = 'authenticated'
    and auth.uid() = reporter_id
    and exists (
      select 1
      from public.users u
      where u.id = auth.uid()
        and u.status = 'active'
    )
  );

drop policy if exists "Users read own reports" on public.reports;
create policy "Users read own reports" on public.reports
  for select
  using (
    auth.uid() = reporter_id
  );

drop policy if exists "Admins read all reports" on public.reports;
create policy "Admins read all reports" on public.reports
  for select
  using (
    exists (
      select 1
      from public.users u
      where u.id = auth.uid()
        and u.is_admin = true
    )
    or auth.jwt()->>'role' = 'service_role'
  );

drop policy if exists "Admins update reports" on public.reports;
create policy "Admins update reports" on public.reports
  for update
  using (
    exists (
      select 1
      from public.users u
      where u.id = auth.uid()
        and u.is_admin = true
    )
    or auth.jwt()->>'role' = 'service_role'
  )
  with check (
    exists (
      select 1
      from public.users u
      where u.id = auth.uid()
        and u.is_admin = true
    )
    or auth.jwt()->>'role' = 'service_role'
  );

drop policy if exists "Admins moderate listings" on public.listings;
create policy "Admins moderate listings" on public.listings
  for delete
  using (
    exists (
      select 1
      from public.users u
      where u.id = auth.uid()
        and u.is_admin = true
    )
    or auth.jwt()->>'role' = 'service_role'
  );

drop policy if exists "Owners manage listings" on public.listings;
create policy "Owners manage listings" on public.listings
  for all
  using (
    auth.uid() = user_id
    and exists (
      select 1
      from public.users u
      where u.id = auth.uid()
        and u.status = 'active'
    )
  )
  with check (
    auth.uid() = user_id
    and exists (
      select 1
      from public.users u
      where u.id = auth.uid()
        and u.status = 'active'
    )
  );

drop policy if exists "Admins moderate users" on public.users;
create policy "Admins moderate users" on public.users
  for update
  using (
    exists (
      select 1
      from public.users u
      where u.id = auth.uid()
        and u.is_admin = true
    )
    or auth.jwt()->>'role' = 'service_role'
  )
  with check (
    exists (
      select 1
      from public.users u
      where u.id = auth.uid()
        and u.is_admin = true
    )
    or auth.jwt()->>'role' = 'service_role'
  );
