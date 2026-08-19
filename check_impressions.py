#!/usr/bin/env python3
"""
Fire a one-time Slack alert the moment App Store *Impressions* first land in
Supabase.

The general "analytics landed" checker already fires on the first analytics rows
(First-Time Downloads / sessions), but Impressions — and therefore Conversion
Rate — usually lag another 24-48h. This watches specifically for Impressions and
posts once, so you know the App Analytics feed is fully complete and the
Conversion Rate tile has lit up.

Cloud-safe: Slack only (no macOS/launchctl), and the "already alerted" marker
lives in Supabase (public.etl_alert_state) — not a local file — so it works from
the ephemeral Cloud Run container and never double-fires. Runs every hour as the
last step of the hourly ETL job.

    python3 check_impressions.py                # normal hourly check
    python3 check_impressions.py --test-slack   # verify the webhook
"""
import os
import sys
from datetime import datetime, timezone

import requests

MARKER_KEY = "appstore_impressions_landed"


def _env(name, *fallbacks):
    for n in (name, *fallbacks):
        v = os.environ.get(n, "").strip()
        if v:
            return v
    return ""


def slack(text):
    hook = os.environ.get("SLACK_WEBHOOK_URL", "").strip()
    if not hook.startswith("https://hooks.slack.com/"):
        print("no SLACK_WEBHOOK_URL — skipping Slack")
        return False
    try:
        r = requests.post(hook, json={"text": text}, timeout=30)
        return r.status_code == 200
    except Exception as e:
        print("slack post failed:", e)
        return False


def main():
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    url = _env("SUPABASE_URL").rstrip("/")
    key = _env("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_KEY")

    if "--test-slack" in sys.argv:
        ok = slack(":satellite: Dallal — App Store *Impressions* watcher test ping. Slack is wired up.")
        print(now, "slack test:", "sent" if ok else "FAILED (check SLACK_WEBHOOK_URL)")
        return

    if not key or not url.startswith("http"):
        print(now, "missing SUPABASE_URL / service key — skipping")
        return

    h = {"apikey": key, "Authorization": "Bearer " + key}
    state = url + "/rest/v1/etl_alert_state"

    # Already alerted? (marker row in Supabase — survives ephemeral containers)
    try:
        m = requests.get(state, headers=h,
                         params={"select": "key", "key": "eq." + MARKER_KEY}, timeout=30)
        if m.status_code == 200 and m.json():
            print(now, "impressions alert already fired — nothing to do")
            return
    except Exception as e:
        print(now, "marker check failed:", e)
        return

    # Any impressions yet? (value > 0)
    metrics = url + "/rest/v1/fact_appstore_metrics"
    try:
        r = requests.get(metrics, headers={**h, "Prefer": "count=exact", "Range": "0-0"},
                         params={"select": "value", "metric": "eq.impressions", "value": "gt.0"},
                         timeout=60)
    except Exception as e:
        print(now, "impressions check failed:", e)
        return
    n = int((r.headers.get("content-range", "*/0").split("/")[-1] or "0"))
    print(now, "impressions rows:", n, "(HTTP", str(r.status_code) + ")")
    if n <= 0:
        return

    # Impressions landed — post once, then write the marker so we never repeat.
    total = 0
    try:
        rows = requests.get(metrics, headers=h,
                           params={"select": "value", "metric": "eq.impressions"}, timeout=60).json()
        total = sum(int(float(x.get("value") or 0)) for x in rows)
    except Exception:
        pass

    msg = (":tada: *Dallal · App Store Impressions have landed* — Apple's App Analytics feed is "
           "now complete. Impressions (%s across %d day-rows) and **Conversion Rate** are live on "
           "the dashboard's App Analytics tab and now match App Store Connect." % (f"{total:,}", n))
    sent = slack(msg)

    try:
        requests.post(state, headers={**h, "Content-Type": "application/json",
                                      "Prefer": "resolution=merge-duplicates"},
                     json={"key": MARKER_KEY, "fired_at": now,
                           "note": "impressions first seen; %d rows" % n}, timeout=30)
    except Exception as e:
        print(now, "marker write failed:", e)
    print(now, "NOTIFIED via Slack" if sent else "impressions present but Slack not sent")


if __name__ == "__main__":
    main()
