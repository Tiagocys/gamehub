-- Admin commission model:
-- - owner share: 50% of net (when owner exists)
-- - admin share: 25% of net (when admin beneficiary exists)
-- - platform keeps the remainder

alter table if exists public.servers
  add column if not exists admin_beneficiary_id uuid references public.users(id) on delete set null,
  add column if not exists admin_beneficiary_email text;

create index if not exists servers_admin_beneficiary_idx
  on public.servers (admin_beneficiary_id);

create index if not exists servers_admin_beneficiary_email_idx
  on public.servers (lower(admin_beneficiary_email));

comment on column public.servers.admin_beneficiary_id is
  'Administrador com direito a 25% do líquido dos destaques do servidor.';

comment on column public.servers.admin_beneficiary_email is
  'E-mail auditável do admin beneficiário vinculado ao servidor.';

with latest_review as (
  select distinct on (website_domain)
    website_domain,
    reviewed_by_admin_id as admin_id
  from public.game_requests
  where status = 'approved'
    and reviewed_by_admin_id is not null
    and website_domain is not null
    and website_domain <> ''
  order by website_domain, created_at desc
)
update public.servers s
set admin_beneficiary_id = lr.admin_id
from latest_review lr
where s.admin_beneficiary_id is null
  and s.website_domain = lr.website_domain;

update public.servers s
set admin_beneficiary_email = u.email
from public.users u
where s.admin_beneficiary_id = u.id
  and coalesce(trim(s.admin_beneficiary_email), '') = '';

alter table if exists public.partner_payout_events
  add column if not exists payout_role text,
  add column if not exists share_ratio numeric(6,4);

update public.partner_payout_events
set payout_role = coalesce(nullif(trim(payout_role), ''), 'owner')
where payout_role is null
   or trim(payout_role) = '';

alter table if exists public.partner_payout_events
  alter column payout_role set default 'owner',
  alter column payout_role set not null;

update public.partner_payout_events
set share_ratio = coalesce(share_ratio, 0.5000)
where share_ratio is null;

alter table if exists public.partner_payout_events
  alter column share_ratio set default 0.5000,
  alter column share_ratio set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'partner_payout_events_payout_role_check'
      and conrelid = 'public.partner_payout_events'::regclass
  ) then
    alter table public.partner_payout_events
      add constraint partner_payout_events_payout_role_check
      check (payout_role in ('owner', 'admin'));
  end if;
end $$;

alter table if exists public.partner_payout_events
  drop constraint if exists partner_payout_events_checkout_session_id_key;

drop index if exists partner_payout_events_checkout_session_id_key;

create unique index if not exists partner_payout_events_session_role_key
  on public.partner_payout_events (checkout_session_id, payout_role);

create index if not exists partner_payout_events_owner_role_status_idx
  on public.partner_payout_events (owner_user_id, payout_role, payout_status);

comment on column public.partner_payout_events.payout_role is
  'Tipo de comissão: owner (50%) ou admin (25%).';

comment on column public.partner_payout_events.share_ratio is
  'Percentual aplicado sobre o líquido da transação para este destinatário.';
