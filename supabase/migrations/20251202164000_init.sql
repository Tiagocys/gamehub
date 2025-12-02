-- Base schema for Gamehub marketplace
-- Includes enums, tables, FKs, timestamps, and RLS policies aligned to the initial flows.

-- Extensions
create extension if not exists "pgcrypto";

-- Enums
create type public.game_type as enum ('MMORPG', 'MOBA', 'FPS', 'OTSERVER', 'OTHER');
create type public.listing_category as enum ('account', 'item', 'currency', 'service', 'other');
create type public.listing_status as enum ('active', 'sold', 'removed', 'draft');
create type public.transaction_status as enum ('pending', 'paid', 'delivered', 'completed', 'dispute', 'refunded');
create type public.currency_code as enum ('BRL', 'USD');
create type public.server_status as enum ('active', 'inactive');

-- Helper to auto-update updated_at
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Users profile table tied to Supabase Auth
create table public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique,
  email text not null unique,
  avatar_url text,
  reputation_total integer not null default 0,
  created_at timestamptz not null default now()
);

-- Game servers
create table public.servers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  game_type public.game_type not null,
  official_site text,
  description text,
  banner_url text,
  status public.server_status not null default 'active',
  owner_id uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index servers_owner_idx on public.servers(owner_id);
create index servers_status_idx on public.servers(status);

-- Listings (anúncios)
create table public.listings (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references public.servers(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  category public.listing_category not null,
  title text not null,
  description text,
  price numeric(12,2) not null default 0,
  currency public.currency_code not null default 'BRL',
  images text[] not null default '{}',
  status public.listing_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index listings_server_idx on public.listings(server_id);
create index listings_user_idx on public.listings(user_id);
create index listings_status_idx on public.listings(status);
create trigger listings_set_updated_at
  before update on public.listings
  for each row execute function public.set_updated_at();

-- Chats
create table public.chats (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid references public.listings(id) on delete set null,
  participant_ids uuid[] not null check (cardinality(participant_ids) >= 1),
  created_at timestamptz not null default now()
);
create index chats_listing_idx on public.chats(listing_id);
create index chats_participants_gin on public.chats using gin (participant_ids);

-- Transactions (escrow)
create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.listings(id) on delete cascade,
  buyer_id uuid not null references public.users(id) on delete restrict,
  seller_id uuid not null references public.users(id) on delete restrict,
  amount numeric(12,2) not null,
  currency public.currency_code not null default 'BRL',
  status public.transaction_status not null default 'pending',
  chat_id uuid references public.chats(id) on delete set null,
  events jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index transactions_listing_idx on public.transactions(listing_id);
create index transactions_buyer_idx on public.transactions(buyer_id);
create index transactions_seller_idx on public.transactions(seller_id);
create index transactions_status_idx on public.transactions(status);
create trigger transactions_set_updated_at
  before update on public.transactions
  for each row execute function public.set_updated_at();

-- Ratings
create table public.ratings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade, -- avaliado
  author_id uuid not null references public.users(id) on delete cascade, -- quem avaliou
  score int not null check (score between 1 and 5),
  comment text,
  transaction_id uuid references public.transactions(id) on delete set null,
  created_at timestamptz not null default now()
);
create index ratings_user_idx on public.ratings(user_id);
create index ratings_author_idx on public.ratings(author_id);

-- Messages
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chats(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  content text not null,
  attachments text[] not null default '{}',
  created_at timestamptz not null default now()
);
create index messages_chat_idx on public.messages(chat_id);
create index messages_user_idx on public.messages(user_id);

-- Row Level Security
alter table public.users enable row level security;
alter table public.servers enable row level security;
alter table public.listings enable row level security;
alter table public.transactions enable row level security;
alter table public.ratings enable row level security;
alter table public.chats enable row level security;
alter table public.messages enable row level security;

-- Users: anyone can read; only owner can insert/update their profile
create policy "Public read users" on public.users
  for select using (true);
create policy "Users manage own profile" on public.users
  for all using (auth.uid() = id) with check (auth.uid() = id);

-- Servers: public read; owner manages
create policy "Public read servers" on public.servers
  for select using (true);
create policy "Owners manage servers" on public.servers
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

-- Listings: public read; owner manages
create policy "Public read listings" on public.listings
  for select using (true);
create policy "Owners manage listings" on public.listings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Transactions: visible/managed by buyer or seller
create policy "Participants read transactions" on public.transactions
  for select using (auth.uid() in (buyer_id, seller_id));
create policy "Participants manage transactions" on public.transactions
  for all using (auth.uid() in (buyer_id, seller_id)) with check (auth.uid() in (buyer_id, seller_id));

-- Ratings: public read; authors create/update their own
create policy "Public read ratings" on public.ratings
  for select using (true);
create policy "Authors manage ratings" on public.ratings
  for all using (auth.uid() = author_id) with check (auth.uid() = author_id);

-- Chats: only participants can see/insert
create policy "Participants read chats" on public.chats
  for select using (auth.uid() = any(participant_ids));
create policy "Participants insert chats" on public.chats
  for insert with check (auth.uid() = any(participant_ids));

-- Messages: only participants can read/insert and must match sender
create policy "Participants read messages" on public.messages
  for select using (
    exists (
      select 1 from public.chats c
      where c.id = chat_id and auth.uid() = any(c.participant_ids)
    )
  );
create policy "Participants send messages" on public.messages
  for insert with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.chats c
      where c.id = chat_id and auth.uid() = any(c.participant_ids)
    )
  );

-- Optional: allow participants to delete their own messages
create policy "Participants delete own messages" on public.messages
  for delete using (
    auth.uid() = user_id
    and exists (
      select 1 from public.chats c
      where c.id = chat_id and auth.uid() = any(c.participant_ids)
    )
  );
