do $$
begin
  if to_regclass('public.user_highlight_wallets') is not null
     and to_regclass('public.wallets') is null then
    alter table public.user_highlight_wallets rename to wallets;
  end if;

  if to_regclass('public.user_highlight_wallet_events') is not null
     and to_regclass('public.wallet_events') is null then
    alter table public.user_highlight_wallet_events rename to wallet_events;
  end if;
end $$;

-- Rename indexes if they still exist with legacy names.
do $$
begin
  if to_regclass('public.user_highlight_wallets_updated_idx') is not null
     and to_regclass('public.wallets_updated_idx') is null then
    alter index public.user_highlight_wallets_updated_idx rename to wallets_updated_idx;
  end if;

  if to_regclass('public.user_highlight_wallet_events_user_idx') is not null
     and to_regclass('public.wallet_events_user_idx') is null then
    alter index public.user_highlight_wallet_events_user_idx rename to wallet_events_user_idx;
  end if;

  if to_regclass('public.user_highlight_wallet_events_listing_idx') is not null
     and to_regclass('public.wallet_events_listing_idx') is null then
    alter index public.user_highlight_wallet_events_listing_idx rename to wallet_events_listing_idx;
  end if;

  if to_regclass('public.user_highlight_wallet_events_checkout_session_key') is not null
     and to_regclass('public.wallet_events_checkout_session_key') is null then
    alter index public.user_highlight_wallet_events_checkout_session_key rename to wallet_events_checkout_session_key;
  end if;
end $$;

-- Rename trigger on wallets table.
do $$
begin
  if exists (
    select 1
    from pg_trigger
    where tgname = 'user_highlight_wallets_set_updated_at'
      and tgrelid = 'public.wallets'::regclass
  ) then
    alter trigger user_highlight_wallets_set_updated_at on public.wallets
      rename to wallets_set_updated_at;
  end if;
end $$;
