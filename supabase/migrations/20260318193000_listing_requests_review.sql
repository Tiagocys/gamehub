create table if not exists public.listing_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  user_email text,
  title text not null,
  description text,
  images text[] not null default '{}'::text[],
  game_name text not null,
  website text not null,
  website_domain text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  server_id uuid references public.servers(id) on delete set null,
  listing_id uuid references public.listings(id) on delete set null,
  review_note text,
  reviewed_by_admin_id uuid references public.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists listing_requests_user_idx
  on public.listing_requests (user_id);

create index if not exists listing_requests_status_idx
  on public.listing_requests (status, created_at);

create index if not exists listing_requests_website_domain_idx
  on public.listing_requests (website_domain);

create unique index if not exists listing_requests_user_domain_pending_idx
  on public.listing_requests (user_id, website_domain)
  where status = 'pending';

drop trigger if exists listing_requests_set_updated_at on public.listing_requests;
create trigger listing_requests_set_updated_at
  before update on public.listing_requests
  for each row execute function public.set_updated_at();

alter table public.listing_requests enable row level security;

create policy "Users insert own listing requests" on public.listing_requests
  for insert with check (auth.uid() = user_id);

create policy "Users read own listing requests" on public.listing_requests
  for select using (auth.uid() = user_id);

create policy "Admins read listing requests" on public.listing_requests
  for select using (
    exists (
      select 1
      from public.users u
      where u.id = auth.uid()
        and u.is_admin = true
    )
  );
