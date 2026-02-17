alter table if exists public.listings
  add column if not exists highlight_status text not null default 'none',
  add column if not exists highlight_expires_at timestamptz,
  add column if not exists highlight_days integer not null default 0,
  add column if not exists highlight_checkout_session_id text,
  add column if not exists highlight_paid_amount numeric(12,2),
  add column if not exists highlight_currency text not null default 'BRL';

create index if not exists listings_highlight_expires_idx on public.listings (highlight_expires_at);
