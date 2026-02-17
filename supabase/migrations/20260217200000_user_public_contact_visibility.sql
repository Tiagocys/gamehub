alter table if exists public.users
  add column if not exists show_contacts_on_public_profile boolean not null default true;

