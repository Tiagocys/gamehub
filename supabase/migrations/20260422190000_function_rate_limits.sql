create table if not exists public.function_rate_limits (
  user_id uuid not null references auth.users(id) on delete cascade,
  action text not null,
  bucket_start timestamptz not null,
  count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, action, bucket_start)
);

create index if not exists function_rate_limits_lookup_idx
  on public.function_rate_limits (user_id, action, bucket_start desc);

alter table public.function_rate_limits enable row level security;

create or replace function public.increment_function_rate_limit(
  p_user_id uuid,
  p_action text,
  p_bucket_start timestamptz
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  insert into public.function_rate_limits (user_id, action, bucket_start, count, created_at, updated_at)
  values (p_user_id, p_action, p_bucket_start, 1, now(), now())
  on conflict (user_id, action, bucket_start)
  do update set
    count = public.function_rate_limits.count + 1,
    updated_at = now()
  returning count into v_count;

  return v_count;
end;
$$;
