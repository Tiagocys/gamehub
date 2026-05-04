alter table public.users
  alter column show_telegram_button set default false;

update public.users
set show_telegram_button = false
where phone_verified = false
  and show_telegram_button = true;

alter table public.users
  drop constraint if exists users_whatsapp_button_requires_verified_phone;
