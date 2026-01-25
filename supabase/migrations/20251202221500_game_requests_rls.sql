-- Enable RLS for game_requests and allow proper access for users/admins.

alter table public.game_requests enable row level security;

drop policy if exists "Users insert own game requests" on public.game_requests;
create policy "Users insert own game requests" on public.game_requests
  for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users update own rejected game requests" on public.game_requests;
create policy "Users update own rejected game requests" on public.game_requests
  for update
  using (auth.uid() = user_id and status = 'rejected')
  with check (auth.uid() = user_id and status = 'pending');

drop policy if exists "Users read own game requests" on public.game_requests;
create policy "Users read own game requests" on public.game_requests
  for select
  using (auth.uid() = user_id);

drop policy if exists "Admins read all game requests" on public.game_requests;
create policy "Admins read all game requests" on public.game_requests
  for select
  using (
    exists (
      select 1 from public.users u
      where u.id = auth.uid() and u.is_admin = true
    )
  );
