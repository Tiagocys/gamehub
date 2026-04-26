alter type public.server_status add value if not exists 'deleted';

alter table if exists public.game_requests
  drop constraint if exists game_requests_status_check;

alter table if exists public.game_requests
  add constraint game_requests_status_check
  check (status in ('pending','under_review','approved','rejected','deleted'));
