create table if not exists public.partner_payout_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  provider text not null default 'wise' check (provider in ('wise')),
  wise_profile_id bigint,
  wise_recipient_id bigint,
  source_currency text not null default 'GBP',
  target_currency text not null,
  country_code text not null,
  legal_type text not null check (legal_type in ('PRIVATE', 'BUSINESS')),
  account_holder_name text not null,
  account_summary text,
  long_account_summary text,
  display_fields jsonb not null default '[]'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'active', 'disabled', 'error')),
  metadata jsonb not null default '{}'::jsonb,
  last_sync_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id)
);

create index if not exists partner_payout_accounts_provider_idx
  on public.partner_payout_accounts (provider, status);

create index if not exists partner_payout_accounts_wise_recipient_idx
  on public.partner_payout_accounts (wise_recipient_id)
  where wise_recipient_id is not null;

drop trigger if exists partner_payout_accounts_set_updated_at on public.partner_payout_accounts;
create trigger partner_payout_accounts_set_updated_at
  before update on public.partner_payout_accounts
  for each row execute function public.set_updated_at();

alter table public.partner_payout_accounts enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'partner_payout_accounts'
      and policyname = 'Owners read own partner payout accounts'
  ) then
    create policy "Owners read own partner payout accounts"
      on public.partner_payout_accounts
      for select
      using (auth.uid() = user_id);
  end if;
end $$;
