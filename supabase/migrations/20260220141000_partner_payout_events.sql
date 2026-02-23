create table if not exists public.partner_payout_events (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references public.users(id) on delete cascade,
  server_id uuid references public.servers(id) on delete set null,
  listing_id uuid references public.listings(id) on delete set null,
  payer_user_id uuid references public.users(id) on delete set null,
  checkout_session_id text not null unique,
  payment_intent_id text,
  stripe_charge_id text,
  stripe_balance_transaction_id text,
  highlight_days integer not null default 0 check (highlight_days >= 0),
  highlight_started_at timestamptz,
  highlight_expires_at timestamptz,
  currency text not null default 'BRL',
  gross_amount numeric(12,2) not null default 0,
  expected_net_amount numeric(12,2) not null default 0,
  refunded_gross_amount numeric(12,2) not null default 0,
  refunded_net_amount numeric(12,2) not null default 0,
  payout_status text not null default 'pending' check (payout_status in ('pending', 'eligible', 'refunded', 'paid')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists partner_payout_events_owner_status_idx
  on public.partner_payout_events (owner_user_id, payout_status);

create index if not exists partner_payout_events_owner_expires_idx
  on public.partner_payout_events (owner_user_id, highlight_expires_at desc);

create index if not exists partner_payout_events_payment_intent_idx
  on public.partner_payout_events (payment_intent_id);

drop trigger if exists partner_payout_events_set_updated_at on public.partner_payout_events;
create trigger partner_payout_events_set_updated_at
  before update on public.partner_payout_events
  for each row execute function public.set_updated_at();

alter table public.partner_payout_events enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'partner_payout_events'
      and policyname = 'Owners read own partner payout events'
  ) then
    create policy "Owners read own partner payout events"
      on public.partner_payout_events
      for select
      using (auth.uid() = owner_user_id);
  end if;
end $$;
