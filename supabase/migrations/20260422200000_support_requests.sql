create table if not exists public.support_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.users(id) on delete cascade,
  subject text not null,
  message text not null,
  status text not null default 'pending' check (status in ('pending', 'handled')),
  handled_at timestamptz,
  handled_by_admin_id uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists support_requests_status_created_idx
  on public.support_requests (status, created_at asc);

create index if not exists support_requests_handled_by_admin_idx
  on public.support_requests (handled_by_admin_id);

alter table public.support_requests enable row level security;

drop policy if exists "Users read own support requests" on public.support_requests;
create policy "Users read own support requests" on public.support_requests
  for select
  using (auth.uid() = user_id);

drop policy if exists "Admins read all support requests" on public.support_requests;
create policy "Admins read all support requests" on public.support_requests
  for select
  using (
    exists (
      select 1
      from public.users u
      where u.id = auth.uid()
        and coalesce(u.is_admin, false) = true
    )
  );

drop policy if exists "Admins update support requests" on public.support_requests;
create policy "Admins update support requests" on public.support_requests
  for update
  using (
    exists (
      select 1
      from public.users u
      where u.id = auth.uid()
        and coalesce(u.is_admin, false) = true
    )
  )
  with check (
    exists (
      select 1
      from public.users u
      where u.id = auth.uid()
        and coalesce(u.is_admin, false) = true
    )
  );

comment on table public.support_requests is 'Mensagens enviadas pela página de ajuda.';
comment on column public.support_requests.user_id is 'Usuário que abriu ou atualizou a solicitação de ajuda.';
comment on column public.support_requests.status is 'pending enquanto exige revisão do admin, handled quando já foi tratada.';
