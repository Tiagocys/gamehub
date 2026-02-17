alter table if exists public.users
  add column if not exists discord_username text;

do $$
begin
  if not exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and indexname = 'users_discord_username_key'
  ) then
    create unique index users_discord_username_key on public.users (discord_username);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'users_discord_username_format'
      and conrelid = 'public.users'::regclass
  ) then
    alter table public.users
      add constraint users_discord_username_format
      check (discord_username is null or discord_username ~ '^(?!.*\\.\\.)[a-z0-9._]{2,32}$');
  end if;
end $$;
