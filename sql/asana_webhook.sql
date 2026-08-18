-- Stores the Asana webhook's X-Hook-Secret so the Edge Function can verify the
-- HMAC signature on each delivery. One row (id=1). service_role bypasses RLS;
-- with RLS on and no policies, nothing else can read the secret.
create table if not exists public.asana_webhook (
  id         int primary key,
  secret     text,
  updated_at timestamptz not null default now()
);
alter table public.asana_webhook enable row level security;
