alter table if exists public.listings
  add column if not exists categories text[] not null default '{}'::text[];

update public.listings
set categories = case
  when category is null then '{}'::text[]
  else array[category::text]
end
where categories is null
   or cardinality(categories) = 0;

alter table if exists public.listings
  drop constraint if exists listings_categories_allowed;

alter table if exists public.listings
  add constraint listings_categories_allowed check (
    categories <@ array['currency','item','account','service','other']::text[]
  );

create index if not exists listings_categories_gin_idx
  on public.listings
  using gin (categories);
