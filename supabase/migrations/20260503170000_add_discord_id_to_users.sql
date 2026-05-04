alter table if exists public.users
  add column if not exists discord_id text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'users_discord_id_format'
      and conrelid = 'public.users'::regclass
  ) then
    alter table public.users
      add constraint users_discord_id_format
      check (discord_id is null or discord_id ~ '^[0-9]{17,20}$');
  end if;
end $$;
