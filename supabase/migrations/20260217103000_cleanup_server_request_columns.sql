-- Remove deprecated columns and track which admin reviewed each game request.

alter table public.game_requests
  drop column if exists currency_name;

alter table public.servers
  drop column if exists currency_name;

alter table public.servers
  drop column if exists owner_id;

alter table public.game_requests
  add column if not exists reviewed_by_admin_id uuid references public.users(id) on delete set null;

create index if not exists game_requests_reviewed_by_admin_idx
  on public.game_requests (reviewed_by_admin_id);

comment on column public.game_requests.reviewed_by_admin_id is 'Administrador que aprovou/reprovou a solicitação.';

