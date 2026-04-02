alter table public.users
  add column if not exists country_code text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'users_country_code_format'
      and conrelid = 'public.users'::regclass
  ) then
    alter table public.users
      add constraint users_country_code_format
      check (country_code is null or country_code ~ '^[A-Z]{2}$');
  end if;
end $$;
