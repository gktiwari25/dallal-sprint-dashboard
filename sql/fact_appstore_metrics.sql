-- Apple App Store analytics — tidy/long daily metrics.
-- Populated by etl_appstore.py (App Store Connect API: Sales & Trends + App Analytics).
-- The dashboard (app.js renderAppStore) reads this table live via Supabase.
--
-- One row = one metric value for one day / territory / app version.
--   metric ∈ {downloads, redownloads, impressions, product_page_views,
--             sessions, active_devices, crashes}
--   territory: ISO-2 country code for per-territory metrics (downloads),
--              or 'WW' for worldwide aggregates (everything else).

create table if not exists public.fact_appstore_metrics (
  id           bigint generated always as identity primary key,
  date         date        not null,
  metric       text        not null,
  value        numeric     not null default 0,
  territory    text        not null default 'WW',
  platform     text        not null default 'ios',
  app_version  text,
  updated_at   timestamptz not null default now(),
  -- one value per (day, metric, territory, platform) so the ETL can upsert idempotently
  unique (date, metric, territory, platform)
);

create index if not exists idx_appstore_date   on public.fact_appstore_metrics (date);
create index if not exists idx_appstore_metric on public.fact_appstore_metrics (metric);

-- Row Level Security: mirror the other fact_* tables — signed-in users can read,
-- writes happen only through the service_role key used by the ETL (bypasses RLS).
alter table public.fact_appstore_metrics enable row level security;

drop policy if exists "authenticated read appstore" on public.fact_appstore_metrics;
create policy "authenticated read appstore"
  on public.fact_appstore_metrics
  for select
  to authenticated
  using (true);
