# Dashboard UI tests (Selenium)

End-to-end browser tests for the Dallal sprint dashboard. Chrome is driven
headless; the matching chromedriver is auto-downloaded by Selenium Manager (no
manual driver install). By default they run against the **live** site.

## Setup (already done once)

```bash
python3 -m venv tests/.venv
tests/.venv/bin/python -m pip install -r tests/requirements.txt
```

## Auth

The dashboard is login-protected (RLS returns no data without a signed-in JWT),
so the authenticated tests need a session. Provide **one** of these — easiest first:

**A) Reuse your own browser session (no password needed)**
1. Log into the dashboard in Chrome.
2. DevTools (⌥⌘I) → **Application** → **Local Storage** → the dashboard origin.
3. Copy the **Value** of the `sb-dgcxiznnyvhddzsoaxsd-auth-token` entry.
4. Put it in `tests/.env.test` (gitignored):

```bash
TEST_SESSION='<paste the whole value here>'
```

**B) Email + password** (only if your account has a password set)

```bash
TEST_EMAIL=you@dallal.com.kw
TEST_PASSWORD='your-password'
```

> `tests/.env.test` is gitignored — credentials never get committed.
> Sessions expire (~1h); the app auto-refreshes using the refresh token in the
> stored value, but if auth tests start failing, refresh the `TEST_SESSION` value.

## Run

```bash
tests/run.sh                 # headless, live site
HEADLESS=0 tests/run.sh      # watch it in a real window
tests/run.sh -k uat          # just the Ready-for-UAT tests
DASH_URL=http://localhost:8000 tests/run.sh   # against a local build
```

Without credentials the auth tests **skip** (the 2 login-screen tests still run).

## What's covered

- Login screen renders; the data app is hidden when logged out
- Dashboard loads, first-load skeleton clears (no stuck skeleton), sprint dropdown populated
- Sprint Health renders; the info "i" icon sits inline with its title (regression guard)
- Top tabs switch (Delivery / App Analytics / Funnels / Engineering)
- Ready for UAT: both sub-tabs, the "Sent to UAT · throughput" view, "Sent" filter label
- The Sends event list is collapsed by default
- Quality tab shows the Reopened Tickets list

## Files

- `conftest.py` — `driver` and `auth_driver` fixtures
- `auth.py` — reads config.js, builds the localStorage session
- `test_dashboard.py` — the tests
- `run.sh` — loads `tests/.env.test` and runs pytest
