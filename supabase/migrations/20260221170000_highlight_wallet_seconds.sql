-- Wallet de destaque por usuário (saldo em segundos).

create table if not exists public.user_highlight_wallets (
  user_id uuid primary key references public.users(id) on delete cascade,
  available_seconds bigint not null default 0 check (available_seconds >= 0),
  total_purchased_seconds bigint not null default 0 check (total_purchased_seconds >= 0),
  total_consumed_seconds bigint not null default 0 check (total_consumed_seconds >= 0),
  active_listing_count integer not null default 0 check (active_listing_count >= 0),
  last_consumed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists user_highlight_wallets_updated_idx
  on public.user_highlight_wallets (updated_at desc);

drop trigger if exists user_highlight_wallets_set_updated_at on public.user_highlight_wallets;
create trigger user_highlight_wallets_set_updated_at
  before update on public.user_highlight_wallets
  for each row execute function public.set_updated_at();

alter table public.user_highlight_wallets enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'user_highlight_wallets'
      and policyname = 'Users read own highlight wallet'
  ) then
    create policy "Users read own highlight wallet"
      on public.user_highlight_wallets
      for select
      using (auth.uid() = user_id);
  end if;
end $$;

-- Ledger para auditoria de créditos/débitos do wallet.
create table if not exists public.user_highlight_wallet_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  event_type text not null check (event_type in ('topup', 'consume', 'activate', 'deactivate', 'expire', 'adjust')),
  seconds_delta bigint not null,
  balance_after bigint not null default 0 check (balance_after >= 0),
  listing_id uuid references public.listings(id) on delete set null,
  checkout_session_id text,
  payment_intent_id text,
  amount_paid numeric(12,2),
  currency text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists user_highlight_wallet_events_user_idx
  on public.user_highlight_wallet_events (user_id, created_at desc);

create index if not exists user_highlight_wallet_events_listing_idx
  on public.user_highlight_wallet_events (listing_id, created_at desc);

create unique index if not exists user_highlight_wallet_events_checkout_session_key
  on public.user_highlight_wallet_events (checkout_session_id)
  where checkout_session_id is not null;

alter table public.user_highlight_wallet_events enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'user_highlight_wallet_events'
      and policyname = 'Users read own wallet events'
  ) then
    create policy "Users read own wallet events"
      on public.user_highlight_wallet_events
      for select
      using (auth.uid() = user_id);
  end if;
end $$;

