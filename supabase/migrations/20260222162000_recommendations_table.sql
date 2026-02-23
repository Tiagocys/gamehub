create table if not exists public.recommendations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  author_id uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint recommendations_user_not_author check (user_id <> author_id)
);

create index if not exists recommendations_user_idx on public.recommendations (user_id);
create index if not exists recommendations_author_idx on public.recommendations (author_id);
create unique index if not exists recommendations_user_author_unique_idx
  on public.recommendations (user_id, author_id);

alter table public.recommendations enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'recommendations'
      and policyname = 'Public read recommendations'
  ) then
    create policy "Public read recommendations" on public.recommendations
      for select using (true);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'recommendations'
      and policyname = 'Authors insert recommendations with verified phone'
  ) then
    create policy "Authors insert recommendations with verified phone" on public.recommendations
      for insert
      with check (
        auth.uid() = author_id
        and exists (
          select 1
          from public.users u
          where u.id = auth.uid()
            and u.phone_verified = true
        )
      );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'recommendations'
      and policyname = 'Authors delete own recommendations'
  ) then
    create policy "Authors delete own recommendations" on public.recommendations
      for delete
      using (auth.uid() = author_id);
  end if;
end $$;

do $$
begin
  if to_regclass('public.ratings') is not null then
    insert into public.recommendations (user_id, author_id, created_at)
    select r.user_id, r.author_id, coalesce(r.created_at, now())
    from public.ratings r
    where r.user_id <> r.author_id
    on conflict (user_id, author_id) do nothing;
  end if;
end $$;
