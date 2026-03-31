alter table public.wallet_events
  add column if not exists charge_type text,
  add column if not exists charge_date date;

update public.wallet_events
set
  charge_type = coalesce(nullif(metadata->>'charge_type', ''), charge_type),
  charge_date = coalesce(
    charge_date,
    nullif(metadata->>'stat_date', '')::date,
    created_at::date
  )
where event_type = 'consume';

with ranked_consume_events as (
  select
    id,
    row_number() over (
      partition by user_id, listing_id, event_type, charge_type, charge_date
      order by created_at desc, id desc
    ) as rn,
    coalesce(sum(amount_delta_cents) over (
      partition by user_id, listing_id, event_type, charge_type, charge_date
    ), 0) as total_amount_delta_cents,
    count(*) over (
      partition by user_id, listing_id, event_type, charge_type, charge_date
    ) as group_size
  from public.wallet_events
  where event_type = 'consume'
    and listing_id is not null
    and charge_type is not null
    and charge_date is not null
)
update public.wallet_events as target
set amount_delta_cents = ranked_consume_events.total_amount_delta_cents
from ranked_consume_events
where target.id = ranked_consume_events.id
  and ranked_consume_events.rn = 1
  and ranked_consume_events.group_size > 1;

with ranked_consume_events as (
  select
    id,
    row_number() over (
      partition by user_id, listing_id, event_type, charge_type, charge_date
      order by created_at desc, id desc
    ) as rn
  from public.wallet_events
  where event_type = 'consume'
    and listing_id is not null
    and charge_type is not null
    and charge_date is not null
)
delete from public.wallet_events as target
using ranked_consume_events
where target.id = ranked_consume_events.id
  and ranked_consume_events.rn > 1;

create unique index if not exists wallet_events_daily_consume_unique
  on public.wallet_events (user_id, listing_id, event_type, charge_type, charge_date)
  where event_type = 'consume'
    and listing_id is not null
    and charge_type is not null
    and charge_date is not null;

create table if not exists public.highlight_impression_guards (
  listing_id uuid not null references public.listings(id) on delete cascade,
  fingerprint_hash text not null,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (listing_id, fingerprint_hash)
);

create index if not exists highlight_impression_guards_last_seen_idx
  on public.highlight_impression_guards (last_seen_at desc);
