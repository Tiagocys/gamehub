alter table public.game_requests
  add column if not exists currency_name text;

alter table public.servers
  add column if not exists currency_name text;

comment on column public.game_requests.currency_name is 'Nome da moeda do game.';
comment on column public.servers.currency_name is 'Nome da moeda do game.';
