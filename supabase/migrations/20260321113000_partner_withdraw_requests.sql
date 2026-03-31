create table if not exists public.partner_withdraw_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  partner_payout_account_id uuid references public.partner_payout_accounts(id) on delete set null,
  provider text not null default 'wise' check (provider in ('wise')),
  country_code text,
  target_currency text,
  requested_amount numeric(12,2) not null check (requested_amount > 0),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'paid', 'cancelled')),
  note text,
  account_snapshot jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  reviewed_by uuid references public.users(id) on delete set null,
  reviewed_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists partner_withdraw_requests_user_status_idx
  on public.partner_withdraw_requests (user_id, status, created_at desc);

create index if not exists partner_withdraw_requests_account_idx
  on public.partner_withdraw_requests (partner_payout_account_id)
  where partner_payout_account_id is not null;

drop trigger if exists partner_withdraw_requests_set_updated_at on public.partner_withdraw_requests;
create trigger partner_withdraw_requests_set_updated_at
  before update on public.partner_withdraw_requests
  for each row execute function public.set_updated_at();

alter table public.partner_withdraw_requests enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'partner_withdraw_requests'
      and policyname = 'Owners read own partner withdraw requests'
  ) then
    create policy "Owners read own partner withdraw requests"
      on public.partner_withdraw_requests
      for select
      using (auth.uid() = user_id);
  end if;
end $$;
