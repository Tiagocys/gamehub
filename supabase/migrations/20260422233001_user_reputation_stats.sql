create or replace function public.get_user_reputation_stats(target_user_ids uuid[])
returns table (
  user_id uuid,
  is_verified boolean,
  recommendations_count integer,
  reports_count integer,
  reputation_score numeric(3,1)
)
language sql
stable
security definer
set search_path = public
as $$
  with target_users as (
    select
      u.id,
      coalesce(u.phone_verified, false) as is_verified
    from public.users u
    where u.id = any(coalesce(target_user_ids, '{}'::uuid[]))
  ),
  recommendation_counts as (
    select
      r.user_id,
      count(*)::int as recommendations_count
    from public.recommendations r
    where r.user_id = any(coalesce(target_user_ids, '{}'::uuid[]))
    group by r.user_id
  ),
  report_counts as (
    select
      rp.reported_user_id as user_id,
      count(*)::int as reports_count
    from public.reports rp
    where rp.target_type = 'user'
      and rp.reported_user_id = any(coalesce(target_user_ids, '{}'::uuid[]))
    group by rp.reported_user_id
  )
  select
    tu.id as user_id,
    tu.is_verified,
    coalesce(rc.recommendations_count, 0) as recommendations_count,
    coalesce(pc.reports_count, 0) as reports_count,
    case
      when not tu.is_verified then null::numeric(3,1)
      when coalesce(rc.recommendations_count, 0) + coalesce(pc.reports_count, 0) = 0 then 0.0::numeric(3,1)
      else round(
        (
          coalesce(rc.recommendations_count, 0)::numeric
          / (coalesce(rc.recommendations_count, 0) + coalesce(pc.reports_count, 0))::numeric
        ) * 10,
        1
      )::numeric(3,1)
    end as reputation_score
  from target_users tu
  left join recommendation_counts rc on rc.user_id = tu.id
  left join report_counts pc on pc.user_id = tu.id;
$$;

grant execute on function public.get_user_reputation_stats(uuid[]) to anon, authenticated, service_role;
