alter table if exists public.support_requests
  add column if not exists response_message text;

comment on column public.support_requests.response_message is 'Resposta enviada pelo admin ao usuário.';
