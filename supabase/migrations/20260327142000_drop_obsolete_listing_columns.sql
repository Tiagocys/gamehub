alter table public.listings
  drop column if exists highlight_days,
  drop column if exists category,
  drop column if exists categories;
