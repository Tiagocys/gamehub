-- Phone verification via Telegram

alter table public.users
  add column if not exists phone_verified boolean not null default false,
  add column if not exists phone_verified_at timestamptz;

create table if not exists public.phone_verifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  phone text not null,
  code text not null unique,
  status text not null default 'pending' check (status in ('pending', 'code_confirmed', 'verified', 'expired')),
  telegram_user_id bigint,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  verified_at timestamptz
);

create index if not exists phone_verifications_user_idx on public.phone_verifications(user_id);
create index if not exists phone_verifications_code_idx on public.phone_verifications(code);

alter table public.phone_verifications enable row level security;

drop policy if exists "Users read own phone verifications" on public.phone_verifications;
create policy "Users read own phone verifications" on public.phone_verifications
  for select using (auth.uid() = user_id);
