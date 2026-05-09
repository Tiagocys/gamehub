create table if not exists public.listing_view_guards (
  listing_id uuid not null references public.listings(id) on delete cascade,
  viewer_key text not null,
  view_window_key timestamptz not null,
  page_path text,
  first_seen_at timestamptz not null default now(),
  primary key (listing_id, viewer_key, view_window_key)
);

create index if not exists listing_view_guards_first_seen_idx
  on public.listing_view_guards (first_seen_at desc);

create table if not exists public.listing_view_daily_metrics (
  listing_id uuid not null references public.listings(id) on delete cascade,
  server_id uuid references public.servers(id) on delete set null,
  user_id uuid not null references public.users(id) on delete cascade,
  stat_date date not null,
  views_count integer not null default 0 check (views_count >= 0),
  last_view_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (listing_id, stat_date)
);

create index if not exists listing_view_daily_metrics_user_idx
  on public.listing_view_daily_metrics (user_id, stat_date desc);

create index if not exists listing_view_daily_metrics_server_idx
  on public.listing_view_daily_metrics (server_id, stat_date desc)
  where server_id is not null;

drop trigger if exists listing_view_daily_metrics_set_updated_at on public.listing_view_daily_metrics;
create trigger listing_view_daily_metrics_set_updated_at
  before update on public.listing_view_daily_metrics
  for each row execute function public.set_updated_at();

alter table public.listing_view_daily_metrics enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'listing_view_daily_metrics'
      and policyname = 'Users read own listing view metrics'
  ) then
    create policy "Users read own listing view metrics"
      on public.listing_view_daily_metrics
      for select
      to authenticated
      using (auth.uid() = user_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'listing_view_daily_metrics'
      and policyname = 'Partners read linked server listing view metrics'
  ) then
    create policy "Partners read linked server listing view metrics"
      on public.listing_view_daily_metrics
      for select
      to authenticated
      using (
        exists (
          select 1
          from public.servers s
          where s.id = listing_view_daily_metrics.server_id
            and (
              s.owner_id = auth.uid()
              or s.admin_beneficiary_id = auth.uid()
            )
        )
      );
  end if;
end $$;
