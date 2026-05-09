do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'server_follows'
      and policyname = 'Admins read all server follows'
  ) then
    create policy "Admins read all server follows"
      on public.server_follows
      for select
      to authenticated
      using (
        exists (
          select 1
          from public.users u
          where u.id = auth.uid()
            and coalesce(u.is_admin, false) = true
        )
      );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'listing_view_daily_metrics'
      and policyname = 'Admins read all listing view metrics'
  ) then
    create policy "Admins read all listing view metrics"
      on public.listing_view_daily_metrics
      for select
      to authenticated
      using (
        exists (
          select 1
          from public.users u
          where u.id = auth.uid()
            and coalesce(u.is_admin, false) = true
        )
      );
  end if;
end $$;
