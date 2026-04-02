alter table public.users
  add column if not exists show_telegram_button boolean not null default true;
