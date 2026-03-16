create table if not exists public.server_follows (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  server_id uuid not null references public.servers(id) on delete cascade,
  created_at timestamptz not null default now()
);

create unique index if not exists server_follows_user_server_unique_idx
  on public.server_follows (user_id, server_id);

create index if not exists server_follows_user_idx on public.server_follows (user_id);
create index if not exists server_follows_server_idx on public.server_follows (server_id);

alter table public.server_follows enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'server_follows'
      and policyname = 'Users read own follows'
  ) then
    create policy "Users read own follows" on public.server_follows
      for select
      using (auth.uid() = user_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'server_follows'
      and policyname = 'Users insert own follows'
  ) then
    create policy "Users insert own follows" on public.server_follows
      for insert
      with check (auth.uid() = user_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'server_follows'
      and policyname = 'Users delete own follows'
  ) then
    create policy "Users delete own follows" on public.server_follows
      for delete
      using (auth.uid() = user_id);
  end if;
end $$;
