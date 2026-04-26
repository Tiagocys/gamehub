create table if not exists public.partner_wallets (
  user_id uuid primary key references public.users(id) on delete cascade,
  available_cents bigint not null default 0 check (available_cents >= 0),
  total_purchased_cents bigint not null default 0 check (total_purchased_cents >= 0),
  total_consumed_cents bigint not null default 0 check (total_consumed_cents >= 0),
  last_consumed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.partner_wallet_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  event_type text not null check (event_type in ('topup', 'consume', 'activate', 'deactivate', 'adjust')),
  amount_delta_cents bigint not null default 0,
  balance_after_cents bigint not null default 0 check (balance_after_cents >= 0),
  checkout_session_id text,
  payment_intent_id text,
  currency text not null default 'BRL',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists partner_wallet_events_checkout_session_key
  on public.partner_wallet_events (checkout_session_id)
  where checkout_session_id is not null;

create index if not exists partner_wallet_events_user_idx
  on public.partner_wallet_events (user_id, created_at desc);

drop trigger if exists partner_wallets_set_updated_at on public.partner_wallets;
create trigger partner_wallets_set_updated_at
  before update on public.partner_wallets
  for each row execute function public.set_updated_at();

drop trigger if exists partner_wallet_events_set_updated_at on public.partner_wallet_events;
create trigger partner_wallet_events_set_updated_at
  before update on public.partner_wallet_events
  for each row execute function public.set_updated_at();

alter table public.partner_wallets enable row level security;
alter table public.partner_wallet_events enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'partner_wallets'
      and policyname = 'Users read own partner wallet'
  ) then
    create policy "Users read own partner wallet"
      on public.partner_wallets
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
      and tablename = 'partner_wallet_events'
      and policyname = 'Users read own partner wallet events'
  ) then
    create policy "Users read own partner wallet events"
      on public.partner_wallet_events
      for select
      using (auth.uid() = user_id);
  end if;
end $$;
