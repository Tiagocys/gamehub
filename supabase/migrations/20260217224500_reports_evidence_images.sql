-- Optional image evidence attachments for reports

alter table if exists public.reports
  add column if not exists evidence_images text[] not null default '{}'::text[];

do $$
begin
  if exists (
    select 1
    from information_schema.tables
    where table_schema = 'public'
      and table_name = 'reports'
  ) then
    if not exists (
      select 1
      from pg_constraint
      where conname = 'reports_evidence_images_limit'
        and conrelid = 'public.reports'::regclass
    ) then
      alter table public.reports
        add constraint reports_evidence_images_limit
        check (coalesce(cardinality(evidence_images), 0) <= 8);
    end if;
  end if;
end $$;

comment on column public.reports.evidence_images is 'URLs públicas de anexos de denúncia (R2), convertidos para webp.';
