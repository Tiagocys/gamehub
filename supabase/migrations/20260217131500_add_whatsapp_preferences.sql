alter table public.users
  add column if not exists whatsapp_same_phone boolean not null default false,
  add column if not exists show_whatsapp_button boolean not null default false;

update public.users
set show_whatsapp_button = false
where show_whatsapp_button = true
  and (whatsapp_same_phone = false or phone_verified = false);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'users_whatsapp_button_requires_verified_phone'
  ) then
    alter table public.users
      add constraint users_whatsapp_button_requires_verified_phone
      check (
        show_whatsapp_button = false
        or (
          whatsapp_same_phone = true
          and phone_verified = true
          and public.normalize_phone(phone) <> ''
        )
      );
  end if;
end $$;
