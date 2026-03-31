alter table public.partner_withdraw_requests
  drop constraint if exists partner_withdraw_requests_status_check;

alter table public.partner_withdraw_requests
  add column if not exists wise_profile_id bigint,
  add column if not exists wise_recipient_id bigint,
  add column if not exists wise_quote_id text,
  add column if not exists wise_transfer_id bigint,
  add column if not exists wise_transfer_status text,
  add column if not exists wise_transfer_reference text,
  add column if not exists wise_source_currency text,
  add column if not exists wise_source_amount numeric(12,2),
  add column if not exists wise_target_amount numeric(12,2),
  add column if not exists wise_fee_currency text,
  add column if not exists wise_fee_amount numeric(12,2),
  add column if not exists wise_rate numeric(18,8),
  add column if not exists wise_last_event_at timestamptz,
  add column if not exists approved_email_sent_at timestamptz;

alter table public.partner_withdraw_requests
  add constraint partner_withdraw_requests_status_check
  check (status in ('pending', 'approved', 'rejected', 'paid', 'cancelled', 'failed'));

create index if not exists partner_withdraw_requests_wise_transfer_idx
  on public.partner_withdraw_requests (wise_transfer_id)
  where wise_transfer_id is not null;

create index if not exists partner_withdraw_requests_wise_quote_idx
  on public.partner_withdraw_requests (wise_quote_id)
  where wise_quote_id is not null;
