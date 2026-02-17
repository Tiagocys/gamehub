alter table if exists public.listings
  add column if not exists highlight_started_at timestamptz,
  add column if not exists highlight_payment_intent_id text;

create index if not exists listings_highlight_payment_intent_idx
  on public.listings (highlight_payment_intent_id);
