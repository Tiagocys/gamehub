do $$
begin
  if not exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and indexname = 'users_discord_id_key'
  ) then
    create unique index users_discord_id_key
      on public.users (discord_id)
      where discord_id is not null;
  end if;
end $$;
