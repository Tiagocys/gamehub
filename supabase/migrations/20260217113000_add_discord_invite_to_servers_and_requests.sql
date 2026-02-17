alter table public.game_requests
  add column if not exists discord_invite text;

alter table public.servers
  add column if not exists discord_invite text;

comment on column public.game_requests.discord_invite is 'Link de convite para o Discord oficial do game enviado pelo usuário.';
comment on column public.servers.discord_invite is 'Link de convite para o Discord oficial do game aprovado.';

