alter table if exists public.game_requests
  add column if not exists is_owner boolean;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'game_requests'
      and column_name = 'is_official_admin'
  ) then
    execute 'update public.game_requests
      set is_owner = coalesce(is_owner, is_official_admin)
      where is_owner is null';
  end if;
end $$;

update public.game_requests
set is_owner = false
where is_owner is null;

alter table if exists public.game_requests
  alter column is_owner set default false;

alter table if exists public.game_requests
  alter column is_owner set not null;

create index if not exists game_requests_is_owner_idx
  on public.game_requests (is_owner);

drop index if exists game_requests_is_official_admin_idx;

alter table if exists public.game_requests
  drop column if exists is_official_admin;
