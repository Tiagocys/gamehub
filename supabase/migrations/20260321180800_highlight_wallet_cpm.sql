alter table public.wallets
  add column if not exists available_cents bigint not null default 0 check (available_cents >= 0),
  add column if not exists total_purchased_cents bigint not null default 0 check (total_purchased_cents >= 0),
  add column if not exists total_consumed_cents bigint not null default 0 check (total_consumed_cents >= 0);

alter table public.wallet_events
  add column if not exists amount_delta_cents bigint not null default 0,
  add column if not exists balance_after_cents bigint not null default 0 check (balance_after_cents >= 0);

update public.wallets
set
  available_cents = round((available_seconds::numeric / 86400) * 500),
  total_purchased_cents = round((total_purchased_seconds::numeric / 86400) * 500),
  total_consumed_cents = round((total_consumed_seconds::numeric / 86400) * 500)
where available_cents = 0
  and total_purchased_cents = 0
  and total_consumed_cents = 0
  and (
    available_seconds > 0
    or total_purchased_seconds > 0
    or total_consumed_seconds > 0
  );

update public.wallet_events
set
  amount_delta_cents = case
    when event_type = 'topup' and amount_paid is not null then round(amount_paid * 100)
    else round((seconds_delta::numeric / 86400) * 500)
  end,
  balance_after_cents = round((balance_after::numeric / 86400) * 500)
where amount_delta_cents = 0
  and balance_after_cents = 0
  and (
    seconds_delta <> 0
    or balance_after <> 0
    or amount_paid is not null
  );

create table if not exists public.highlight_daily_metrics (
  listing_id uuid not null references public.listings(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  stat_date date not null,
  impressions_count integer not null default 0 check (impressions_count >= 0),
  charged_cents integer not null default 0 check (charged_cents >= 0),
  last_impression_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (listing_id, stat_date)
);

create index if not exists highlight_daily_metrics_user_idx
  on public.highlight_daily_metrics (user_id, stat_date desc);

drop trigger if exists highlight_daily_metrics_set_updated_at on public.highlight_daily_metrics;
create trigger highlight_daily_metrics_set_updated_at
  before update on public.highlight_daily_metrics
  for each row execute function public.set_updated_at();

