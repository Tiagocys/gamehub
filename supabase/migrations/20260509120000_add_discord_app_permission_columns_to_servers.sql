alter table if exists public.servers
  add column if not exists discord_app_installed boolean not null default false,
  add column if not exists discord_app_can_create_invite boolean not null default false,
  add column if not exists discord_app_can_view_channels boolean not null default false,
  add column if not exists discord_app_can_send_messages boolean not null default false,
  add column if not exists discord_app_can_embed_links boolean not null default false,
  add column if not exists discord_app_permissions_synced_at timestamptz;

comment on column public.servers.discord_app_installed is 'Indica se o App do Gimerr está atualmente instalado no servidor do Discord vinculado.';
comment on column public.servers.discord_app_can_create_invite is 'Indica se o App do Gimerr possui permissão para criar convites no servidor do Discord.';
comment on column public.servers.discord_app_can_view_channels is 'Indica se o App do Gimerr possui permissão para ver canais no servidor do Discord.';
comment on column public.servers.discord_app_can_send_messages is 'Indica se o App do Gimerr possui permissão para enviar mensagens no servidor do Discord.';
comment on column public.servers.discord_app_can_embed_links is 'Indica se o App do Gimerr possui permissão para inserir links/embeds no servidor do Discord.';
comment on column public.servers.discord_app_permissions_synced_at is 'Momento da última sincronização das permissões do App do Gimerr com o servidor do Discord.';
