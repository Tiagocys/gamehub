-- Apenas usuários com telefone verificado podem criar/editar recomendações.

drop policy if exists "Authors manage ratings" on public.ratings;
drop policy if exists "Authors insert ratings with verified phone" on public.ratings;
drop policy if exists "Authors update ratings with verified phone" on public.ratings;
drop policy if exists "Authors delete own ratings" on public.ratings;

create policy "Authors insert ratings with verified phone" on public.ratings
  for insert
  with check (
    auth.uid() = author_id
    and exists (
      select 1
      from public.users u
      where u.id = auth.uid()
        and u.phone_verified = true
    )
  );

create policy "Authors update ratings with verified phone" on public.ratings
  for update
  using (
    auth.uid() = author_id
  )
  with check (
    auth.uid() = author_id
    and exists (
      select 1
      from public.users u
      where u.id = auth.uid()
        and u.phone_verified = true
    )
  );

create policy "Authors delete own ratings" on public.ratings
  for delete
  using (
    auth.uid() = author_id
  );
