-- Antifraude: owner do servidor não pode ser o mesmo usuário admin beneficiário.

update public.servers
set owner_id = null,
    owner_email = null
where owner_id is not null
  and admin_beneficiary_id is not null
  and owner_id = admin_beneficiary_id;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'servers_owner_admin_must_differ'
      and conrelid = 'public.servers'::regclass
  ) then
    alter table public.servers
      add constraint servers_owner_admin_must_differ
      check (
        owner_id is null
        or admin_beneficiary_id is null
        or owner_id <> admin_beneficiary_id
      );
  end if;
end $$;

