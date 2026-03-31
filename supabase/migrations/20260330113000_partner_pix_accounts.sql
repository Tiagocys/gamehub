alter table public.partner_payout_accounts
  drop constraint if exists partner_payout_accounts_provider_check;

alter table public.partner_payout_accounts
  add constraint partner_payout_accounts_provider_check
  check (provider in ('wise', 'pix'));

alter table public.partner_payout_accounts
  add column if not exists pix_key_type text,
  add column if not exists pix_key_value text;

alter table public.partner_payout_accounts
  drop constraint if exists partner_payout_accounts_pix_key_type_check;

alter table public.partner_payout_accounts
  add constraint partner_payout_accounts_pix_key_type_check
  check (
    pix_key_type is null
    or pix_key_type in ('cpf', 'cnpj', 'email', 'phone', 'random')
  );

alter table public.partner_withdraw_requests
  drop constraint if exists partner_withdraw_requests_provider_check;

alter table public.partner_withdraw_requests
  add constraint partner_withdraw_requests_provider_check
  check (provider in ('wise', 'pix'));

create index if not exists partner_payout_accounts_provider_user_idx
  on public.partner_payout_accounts (provider, user_id);

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'partner_payout_accounts'
      and policyname = 'Admins read partner payout accounts'
  ) then
    create policy "Admins read partner payout accounts"
      on public.partner_payout_accounts
      for select
      using (
        exists (
          select 1
          from public.users u
          where u.id = auth.uid()
            and coalesce(u.is_admin, false) = true
        )
      );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'partner_withdraw_requests'
      and policyname = 'Admins read partner withdraw requests'
  ) then
    create policy "Admins read partner withdraw requests"
      on public.partner_withdraw_requests
      for select
      using (
        exists (
          select 1
          from public.users u
          where u.id = auth.uid()
            and coalesce(u.is_admin, false) = true
        )
      );
  end if;
end $$;
