-- Ensure one verified phone number cannot be linked to multiple users.

create or replace function public.normalize_phone(value text)
returns text
language sql
immutable
as $$
  select regexp_replace(coalesce(value, ''), '\D', '', 'g');
$$;

-- If historical duplicates exist, keep the earliest verified user and unverify the rest.
with ranked as (
  select
    id,
    row_number() over (
      partition by public.normalize_phone(phone)
      order by coalesce(phone_verified_at, created_at, now()) asc, id asc
    ) as rn
  from public.users
  where phone_verified = true
    and public.normalize_phone(phone) <> ''
)
update public.users u
set
  phone_verified = false,
  phone_verified_at = null
from ranked r
where u.id = r.id
  and r.rn > 1;

create unique index if not exists users_verified_phone_unique_idx
on public.users ((public.normalize_phone(phone)))
where phone_verified = true
  and public.normalize_phone(phone) <> '';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'users_verified_phone_requires_value'
      and conrelid = 'public.users'::regclass
  ) then
    alter table public.users
      add constraint users_verified_phone_requires_value
      check (phone_verified = false or public.normalize_phone(phone) <> '');
  end if;
end $$;

