create table if not exists public.game_requests (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  website text not null,
  description text,
  cover_url text,
  status text not null default 'pending' check (status in ('pending','under_review','approved','rejected')),
  note text,
  user_id uuid not null references auth.users(id) on delete cascade,
  user_email text,
  created_at timestamptz not null default now()
);

create unique index if not exists game_requests_website_key on public.game_requests (website);

create unique index if not exists game_requests_user_pending_idx
  on public.game_requests (user_id)
  where status in ('pending','under_review');

comment on table public.game_requests is 'Solicitações de criação de games enviadas por usuários';
comment on column public.game_requests.website is 'Formato normalizado, ex: https://dominio.com';

-- bucket único para logos (reutilizado por servidores/games)
insert into storage.buckets (id, name, public)
values ('server_logos', 'server_logos', true)
on conflict (id) do nothing;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and policyname = 'server logos authenticated upload'
  ) then
    create policy "server logos authenticated upload" on storage.objects
      for insert with check (
        bucket_id = 'server_logos'
        and auth.role() = 'authenticated'
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and policyname = 'server logos authenticated update'
  ) then
    create policy "server logos authenticated update" on storage.objects
      for update using (
        bucket_id = 'server_logos'
        and auth.role() = 'authenticated'
      )
      with check (
        bucket_id = 'server_logos'
        and auth.role() = 'authenticated'
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and policyname = 'server logos public read'
  ) then
    create policy "server logos public read" on storage.objects
      for select using (bucket_id = 'server_logos');
  end if;
end $$;
