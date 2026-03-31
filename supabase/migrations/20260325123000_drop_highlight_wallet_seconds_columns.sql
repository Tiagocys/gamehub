alter table public.wallet_events
  drop column if exists seconds_delta,
  drop column if exists balance_after;

alter table public.wallets
  drop column if exists available_seconds,
  drop column if exists total_purchased_seconds,
  drop column if exists total_consumed_seconds;
