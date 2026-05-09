alter table if exists public.servers
  add column if not exists discord_announcement_channel_id text,
  add column if not exists discord_announcement_channel_name text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'servers_discord_announcement_channel_id_format'
  ) then
    alter table public.servers
      add constraint servers_discord_announcement_channel_id_format
      check (
        discord_announcement_channel_id is null
        or discord_announcement_channel_id ~ '^[0-9]{17,20}$'
      );
  end if;
end $$;

comment on column public.servers.discord_announcement_channel_id is 'Canal do Discord onde o bot publicará novos anúncios do servidor.';
comment on column public.servers.discord_announcement_channel_name is 'Nome do canal configurado para anúncios automáticos do bot.';

alter table if exists public.listings
  add column if not exists discord_announced_at timestamptz,
  add column if not exists discord_announcement_message_id text;

comment on column public.listings.discord_announced_at is 'Momento em que o anúncio foi publicado pelo bot do Discord.';
comment on column public.listings.discord_announcement_message_id is 'ID da mensagem enviada pelo bot do Discord para este anúncio.';
