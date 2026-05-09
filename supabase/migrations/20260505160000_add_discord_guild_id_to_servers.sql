alter table public.servers
  add column if not exists discord_guild_id text;

comment on column public.servers.discord_guild_id is 'ID do servidor/guild do Discord vinculado ao servidor no Gimerr.';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'servers_discord_guild_id_format'
  ) then
    alter table public.servers
      add constraint servers_discord_guild_id_format
      check (discord_guild_id is null or discord_guild_id ~ '^[0-9]{17,20}$');
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and indexname = 'servers_discord_guild_id_key'
  ) then
    create unique index servers_discord_guild_id_key
      on public.servers (discord_guild_id)
      where discord_guild_id is not null;
  end if;
end $$;
