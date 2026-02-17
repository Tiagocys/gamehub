-- Prevent approving/creating duplicated servers by normalized website domain.

create or replace function public.normalize_website_domain(value text)
returns text
language sql
immutable
as $$
  select lower(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(trim(coalesce(value, '')), '^\s*https?://', '', 'i'),
          '^www\.', '', 'i'
        ),
        '[/?#].*$', '', 'g'
      ),
      ':[0-9]+$', '', 'g'
    )
  );
$$;

alter table public.servers
  add column if not exists website_domain text
  generated always as (public.normalize_website_domain(official_site)) stored;

alter table public.game_requests
  add column if not exists website_domain text
  generated always as (public.normalize_website_domain(website)) stored;

-- Keep only one active server per domain if duplicates already exist.
with ranked as (
  select
    id,
    row_number() over (
      partition by website_domain
      order by created_at asc, id asc
    ) as rn
  from public.servers
  where status = 'active'
    and coalesce(website_domain, '') <> ''
)
update public.servers s
set status = 'inactive'
from ranked r
where s.id = r.id
  and r.rn > 1;

create unique index if not exists servers_active_website_domain_key
  on public.servers (website_domain)
  where status = 'active'
    and coalesce(website_domain, '') <> '';

create index if not exists game_requests_website_domain_idx
  on public.game_requests (website_domain);

