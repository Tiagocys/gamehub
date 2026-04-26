create extension if not exists pg_cron with schema extensions;

create or replace function public.cleanup_function_rate_limits()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.function_rate_limits
  where bucket_start < now() - interval '24 hours';
$$;

do $$
declare
  existing_job_id bigint;
begin
  select jobid
    into existing_job_id
  from cron.job
  where jobname = 'cleanup_function_rate_limits_daily'
  limit 1;

  if existing_job_id is not null then
    perform cron.unschedule(existing_job_id);
  end if;

  perform cron.schedule(
    'cleanup_function_rate_limits_daily',
    '0 3 * * *',
    $cron$
      select public.cleanup_function_rate_limits();
    $cron$
  );
end
$$;