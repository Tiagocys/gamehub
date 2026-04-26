update public.partner_payout_events
set share_ratio = 0.5
where payout_role = 'owner'
  and share_ratio is distinct from 0.5;

insert into public.partner_payout_events (
  owner_user_id,
  server_id,
  listing_id,
  payer_user_id,
  checkout_session_id,
  payment_intent_id,
  stripe_charge_id,
  stripe_balance_transaction_id,
  highlight_days,
  highlight_started_at,
  highlight_expires_at,
  currency,
  gross_amount,
  expected_net_amount,
  refunded_gross_amount,
  refunded_net_amount,
  payout_status,
  notes,
  payout_role,
  share_ratio,
  created_at,
  updated_at
)
select
  s.admin_beneficiary_id as owner_user_id,
  e.server_id,
  e.listing_id,
  e.payer_user_id,
  e.checkout_session_id,
  e.payment_intent_id,
  e.stripe_charge_id,
  e.stripe_balance_transaction_id,
  e.highlight_days,
  e.highlight_started_at,
  e.highlight_expires_at,
  e.currency,
  e.gross_amount,
  round(coalesce(e.expected_net_amount, 0) * 0.5, 2) as expected_net_amount,
  e.refunded_gross_amount,
  round(coalesce(e.refunded_net_amount, 0) * 0.5, 2) as refunded_net_amount,
  e.payout_status,
  case
    when coalesce(trim(e.notes), '') = '' then 'Repasse admin restaurado para 25% do líquido.'
    else e.notes || ' | Repasse admin restaurado para 25% do líquido.'
  end as notes,
  'admin' as payout_role,
  0.25 as share_ratio,
  e.created_at,
  now() as updated_at
from public.partner_payout_events e
join public.servers s
  on s.id = e.server_id
left join public.partner_payout_events existing_admin
  on existing_admin.checkout_session_id = e.checkout_session_id
 and existing_admin.payout_role = 'admin'
where e.payout_role = 'owner'
  and s.admin_beneficiary_id is not null
  and s.admin_beneficiary_id <> e.owner_user_id
  and existing_admin.id is null;
