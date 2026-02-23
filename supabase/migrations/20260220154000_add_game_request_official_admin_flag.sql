alter table if exists public.game_requests
  add column if not exists is_official_admin boolean not null default false;

create index if not exists game_requests_is_official_admin_idx
  on public.game_requests (is_official_admin);
