# Production API monitoring — wiring guide

The **Production API** dashboard tab shows, per environment:

- **Total Requests**, **Errors** (HTTP status ≥ 400), **Avg Response Time**, **Slow Requests** (response time **≥ 1s**), **Success Rate**
- an **Endpoints** table — method, requests, errors, err %, avg ms, P95 ms, slow count
- a **Recent Requests** log — method + endpoint + response status + response time

It renders **sample data** until the two Supabase tables below are populated, then it switches to **live automatically** (no code change). The slow threshold lives in `web/app.js` as `API_SLOW_MS = 1000` — change it there if your definition differs.

## 1. Supabase tables

```sql
-- Pre-aggregated per-endpoint metrics (one row per env+method+endpoint, per rolling window)
create table if not exists fact_api_endpoints (
  id           text primary key,          -- e.g. 'PROD|GET|/api/v1/listings'
  env          text not null default 'PROD',
  method       text not null,
  endpoint     text not null,             -- normalized path template, ids -> :id
  requests     bigint not null default 0,
  errors       bigint not null default 0, -- status >= 400
  avg_ms       numeric not null default 0,
  p95_ms       numeric not null default 0,
  slow_count   bigint not null default 0, -- response_ms >= 1000
  window_start timestamptz,
  window_end   timestamptz,
  updated_at   timestamptz not null default now()
);

-- Recent individual requests, for the "method & response" log (keep a rolling sample, e.g. last 24h)
create table if not exists fact_api_requests (
  id           bigserial primary key,
  env          text not null default 'PROD',
  method       text not null,
  endpoint     text not null,
  status       int  not null,
  response_ms  int  not null,
  occurred_at  timestamptz not null default now()
);
create index if not exists idx_api_requests_time on fact_api_requests (occurred_at desc);
```

## 2. Read policies (RLS) — same pattern as `web_read_policies.sql`

```sql
alter table fact_api_endpoints enable row level security;
alter table fact_api_requests  enable row level security;

create policy "read api endpoints" on fact_api_endpoints for select to authenticated using (true);
create policy "read api requests"  on fact_api_requests  for select to authenticated using (true);
```

## 3. Capture in Rails (Dallal-BE-ROR)

Record every request from a Rack middleware. Buffer + batch-insert so the hot path stays fast (don't insert synchronously per request in production — enqueue to Sidekiq or a background flusher).

```ruby
# config/initializers/api_metrics.rb  (sketch — batch/async in production)
class ApiMetrics
  IGNORE = %r{\A/(assets|health|up)\b}

  def initialize(app) = @app = app

  def call(env)
    return @app.call(env) if env['PATH_INFO'] =~ IGNORE
    t0 = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    status, headers, body = @app.call(env)
    ms = ((Process.clock_gettime(Process::CLOCK_MONOTONIC) - t0) * 1000).round

    ApiMetricsBuffer.push(
      env:         ENV.fetch('APP_ENV', 'PROD'),
      method:      env['REQUEST_METHOD'],
      endpoint:    normalize(env['PATH_INFO']),   # /api/v1/listings/42 -> /api/v1/listings/:id
      status:      status,
      response_ms: ms,
      occurred_at: Time.now.utc
    )
    [status, headers, body]
  end

  # collapse numeric / uuid path segments so endpoints group cleanly
  def normalize(path)
    path.gsub(%r{/\d+}, '/:id')
        .gsub(%r{/[0-9a-f]{8}-[0-9a-f-]{27}}, '/:id')
  end
end
# config/application.rb:  config.middleware.use ApiMetrics
```

`ApiMetricsBuffer` should accumulate rows and flush in batches to `fact_api_requests` (via the Supabase service key or a direct Postgres connection).

**Alternative:** if you already run an APM (New Relic / Datadog / Scout), point an exporter at its API instead of instrumenting Rails, and write the same two table shapes.

## 4. Aggregate into `fact_api_endpoints`

Run on a schedule (the existing sync, or a cron) to roll the last 24h of `fact_api_requests` into per-endpoint rows:

```sql
insert into fact_api_endpoints
  (id, env, method, endpoint, requests, errors, avg_ms, p95_ms, slow_count, window_start, window_end, updated_at)
select
  env||'|'||method||'|'||endpoint, env, method, endpoint,
  count(*), count(*) filter (where status >= 400),
  round(avg(response_ms)), round(percentile_cont(0.95) within group (order by response_ms)),
  count(*) filter (where response_ms >= 1000),
  now() - interval '24 hours', now(), now()
from fact_api_requests
where occurred_at >= now() - interval '24 hours'
group by env, method, endpoint
on conflict (id) do update set
  requests = excluded.requests, errors = excluded.errors, avg_ms = excluded.avg_ms,
  p95_ms = excluded.p95_ms, slow_count = excluded.slow_count,
  window_start = excluded.window_start, window_end = excluded.window_end, updated_at = now();
```

Once both tables have rows for `env = 'PROD'`, the dashboard tab shows live data and the "Sample data" note disappears.
