update public.partner_payout_events
set share_ratio = 0.5
where payout_role = 'owner'
  and share_ratio is distinct from 0.5;

delete from public.partner_payout_events
where payout_role = 'admin';
