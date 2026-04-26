alter table public.partner_wallets
  drop constraint if exists partner_wallets_available_cents_check;

alter table public.partner_wallet_events
  add column if not exists server_id uuid references public.servers(id) on delete set null,
  add column if not exists viewer_key text,
  add column if not exists charge_window_key text;

create index if not exists partner_wallet_events_server_idx
  on public.partner_wallet_events (server_id, created_at desc)
  where server_id is not null;

create unique index if not exists partner_wallet_events_server_window_unique
  on public.partner_wallet_events (user_id, server_id, viewer_key, charge_window_key)
  where event_type = 'consume'
    and server_id is not null
    and viewer_key is not null
    and charge_window_key is not null;

create table if not exists public.server_feed_daily_metrics (
  server_id uuid not null references public.servers(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  stat_date date not null,
  impressions_count integer not null default 0 check (impressions_count >= 0),
  charged_cents bigint not null default 0 check (charged_cents >= 0),
  last_impression_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (server_id, stat_date)
);

create index if not exists server_feed_daily_metrics_user_idx
  on public.server_feed_daily_metrics (user_id, stat_date desc);

drop trigger if exists server_feed_daily_metrics_set_updated_at on public.server_feed_daily_metrics;
create trigger server_feed_daily_metrics_set_updated_at
  before update on public.server_feed_daily_metrics
  for each row execute function public.set_updated_at();

alter table public.server_feed_daily_metrics enable row level security;
