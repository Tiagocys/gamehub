alter table if exists public.servers
  add column if not exists owner_email text;

update public.servers s
set owner_email = u.email
from public.users u
where s.owner_id = u.id
  and coalesce(trim(s.owner_email), '') = '';

create index if not exists servers_owner_email_idx
  on public.servers (lower(owner_email));

comment on column public.servers.owner_email is 'E-mail auditável do owner vinculado ao servidor no momento do cadastro/aprovação.';
