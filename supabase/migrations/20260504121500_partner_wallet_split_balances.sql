alter table public.partner_wallets
  add column if not exists earned_consumed_cents bigint not null default 0 check (earned_consumed_cents >= 0),
  add column if not exists total_refunded_cents bigint not null default 0 check (total_refunded_cents >= 0);

update public.partner_wallets
set
  earned_consumed_cents = greatest(0, coalesce(earned_consumed_cents, 0)) + abs(least(coalesce(available_cents, 0), 0)),
  available_cents = greatest(coalesce(available_cents, 0), 0)
where coalesce(available_cents, 0) < 0;

alter table public.partner_wallets
  drop constraint if exists partner_wallets_available_cents_check;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'partner_wallets_available_cents_nonnegative_check'
      and conrelid = 'public.partner_wallets'::regclass
  ) then
    alter table public.partner_wallets
      add constraint partner_wallets_available_cents_nonnegative_check
      check (available_cents >= 0);
  end if;
end $$;
