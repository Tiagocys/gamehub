alter table public.users
  add column if not exists about_me text;

-- Remove duplicate recommendations keeping the most recent row.
with ranked as (
  select
    id,
    row_number() over (
      partition by user_id, author_id
      order by coalesce(created_at, now()) desc, id desc
    ) as rn
  from public.ratings
)
delete from public.ratings r
using ranked x
where r.id = x.id
  and x.rn > 1;

-- Self recommendation is not allowed.
delete from public.ratings
where user_id = author_id;

create unique index if not exists ratings_user_author_unique_idx
on public.ratings (user_id, author_id);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'ratings_user_not_author'
  ) then
    alter table public.ratings
      add constraint ratings_user_not_author
      check (user_id <> author_id);
  end if;
end $$;
