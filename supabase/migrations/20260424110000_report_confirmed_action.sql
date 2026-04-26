do $$
begin
  if not exists (
    select 1
    from pg_type t
    join pg_enum e on e.enumtypid = t.oid
    where t.typname = 'report_action'
      and e.enumlabel = 'confirmed_report'
  ) then
    alter type public.report_action add value 'confirmed_report';
  end if;
end $$;

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
  profile_report_counts as (
    select
      rp.reported_user_id as user_id,
      count(*)::int as reports_count
    from public.reports rp
    where rp.target_type = 'user'
      and rp.reported_user_id = any(coalesce(target_user_ids, '{}'::uuid[]))
      and rp.status = 'handled'
      and rp.action_taken::text in ('confirmed_report', 'user_banned', 'listing_deleted')
    group by rp.reported_user_id
  ),
  listing_report_counts as (
    select
      l.user_id,
      count(*)::int as reports_count
    from public.reports rp
    join public.listings l on l.id = rp.listing_id
    where rp.target_type = 'listing'
      and l.user_id = any(coalesce(target_user_ids, '{}'::uuid[]))
      and rp.status = 'handled'
      and rp.action_taken::text in ('confirmed_report', 'listing_deleted')
    group by l.user_id
  ),
  merged_report_counts as (
    select
      user_id,
      sum(reports_count)::int as reports_count
    from (
      select * from profile_report_counts
      union all
      select * from listing_report_counts
    ) counts
    group by user_id
  )
  select
    tu.id as user_id,
    tu.is_verified,
    coalesce(rc.recommendations_count, 0) as recommendations_count,
    coalesce(mrc.reports_count, 0) as reports_count,
    case
      when not tu.is_verified then null::numeric(3,1)
      when coalesce(rc.recommendations_count, 0) + coalesce(mrc.reports_count, 0) = 0 then 0.0::numeric(3,1)
      else round(
        (
          coalesce(rc.recommendations_count, 0)::numeric
          / (coalesce(rc.recommendations_count, 0) + coalesce(mrc.reports_count, 0))::numeric
        ) * 10,
        1
      )::numeric(3,1)
    end as reputation_score
  from target_users tu
  left join recommendation_counts rc on rc.user_id = tu.id
  left join merged_report_counts mrc on mrc.user_id = tu.id;
$$;

grant execute on function public.get_user_reputation_stats(uuid[]) to anon, authenticated, service_role;
