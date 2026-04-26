alter table public.servers
  add column if not exists feed_highlight_status text not null default 'none',
  add column if not exists feed_highlight_started_at timestamptz;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'servers_feed_highlight_status_check'
      and conrelid = 'public.servers'::regclass
  ) then
    alter table public.servers
      add constraint servers_feed_highlight_status_check
      check (feed_highlight_status in ('none', 'active'));
  end if;
end $$;

create index if not exists servers_feed_highlight_idx
  on public.servers (feed_highlight_status, created_at desc)
  where feed_highlight_status = 'active';
