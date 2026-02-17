with ranked as (
  select
    id,
    row_number() over (
      partition by user_id, server_id
      order by created_at desc, id desc
    ) as rn
  from public.listings
)
delete from public.listings
where id in (select id from ranked where rn > 1);

create unique index if not exists listings_user_server_unique_idx
  on public.listings (user_id, server_id);
