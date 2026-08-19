#!/usr/bin/env python3
"""
Fire a one-time Slack alert the moment Google Play (Android) data first lands in
Supabase.

The Play ETL runs hourly but can't pull anything until Google finishes syncing
the reports-bucket permission for dallal-play-reports@dallal-e23a2 (propagation
lags the Play Console grant by hours). This watches for the first
platform='android' rows and posts once, so we know the Android feed is live and
the dashboard's Android · Google Play tab has data.

Cloud-safe: Slack only (no macOS/launchctl), and the "already alerted" marker
lives in Supabase (public.etl_alert_state) so it works from the ephemeral Cloud
Run container and never double-fires. Runs each hour after the Play ETL step.

    python3 check_android.py                # normal hourly check
    python3 check_android.py --test-slack   # verify the webhook
"""
import os
import sys
from datetime import datetime, timezone

import requests

MARKER_KEY = "playstore_android_landed"


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
        ok = slack(":satellite: Dallal — Google Play (Android) watcher test ping. Slack is wired up.")
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
            print(now, "android alert already fired — nothing to do")
            return
    except Exception as e:
        print(now, "marker check failed:", e)
        return

    # Any Android rows yet?
    metrics = url + "/rest/v1/fact_appstore_metrics"
    try:
        r = requests.get(metrics, headers={**h, "Prefer": "count=exact", "Range": "0-0"},
                         params={"select": "value", "platform": "eq.android"}, timeout=60)
    except Exception as e:
        print(now, "android check failed:", e)
        return
    n = int((r.headers.get("content-range", "*/0").split("/")[-1] or "0"))
    print(now, "android rows:", n, "(HTTP", str(r.status_code) + ")")
    if n <= 0:
        return

    # Android data landed — post once, then write the marker so we never repeat.
    downloads = 0
    try:
        rows = requests.get(metrics, headers=h,
                           params={"select": "value", "platform": "eq.android",
                                   "metric": "eq.downloads"}, timeout=60).json()
        downloads = sum(int(float(x.get("value") or 0)) for x in rows)
    except Exception:
        pass

    msg = (":robot_face: *Dallal · Google Play (Android) data has landed* — the reports-bucket "
           "permission has propagated and the Play ETL is now ingesting. Android metrics (%d "
           "install rows so far) are live on the dashboard's *Android · Google Play* tab." % n)
    if downloads:
        msg += " First-day installs total: %s." % f"{downloads:,}"
    sent = slack(msg)

    try:
        requests.post(state, headers={**h, "Content-Type": "application/json",
                                      "Prefer": "resolution=merge-duplicates"},
                     json={"key": MARKER_KEY, "fired_at": now,
                           "note": "android first seen; %d rows" % n}, timeout=30)
    except Exception as e:
        print(now, "marker write failed:", e)
    print(now, "NOTIFIED via Slack" if sent else "android present but Slack not sent")


if __name__ == "__main__":
    main()
