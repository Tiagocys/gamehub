-- Partner model + Stripe Connect fields + server owner binding

alter table if exists public.users
  add column if not exists is_partner boolean not null default false,
  add column if not exists stripe_connect_account_id text,
  add column if not exists stripe_connect_charges_enabled boolean not null default false,
  add column if not exists stripe_connect_payouts_enabled boolean not null default false,
  add column if not exists stripe_connect_details_submitted boolean not null default false,
  add column if not exists stripe_connect_onboarded_at timestamptz;

create index if not exists users_is_partner_idx
  on public.users (is_partner);

create unique index if not exists users_stripe_connect_account_id_key
  on public.users (stripe_connect_account_id)
  where stripe_connect_account_id is not null;

alter table if exists public.servers
  add column if not exists owner_id uuid references public.users(id) on delete set null;

create index if not exists servers_owner_idx
  on public.servers (owner_id);

-- Backfill owner_id from the latest approved request by website domain when possible.
with latest_approved as (
  select distinct on (website_domain)
    website_domain,
    user_id
  from public.game_requests
  where status = 'approved'
    and website_domain is not null
    and website_domain <> ''
  order by website_domain, created_at desc
)
update public.servers s
set owner_id = la.user_id
from latest_approved la
where s.owner_id is null
  and s.website_domain = la.website_domain;
