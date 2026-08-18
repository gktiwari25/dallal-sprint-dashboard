#!/usr/bin/env python3
"""
Notify (macOS) once App Store *Analytics* metrics land in Supabase.

The hourly run_sync.sh already ingests analytics as soon as Apple produces the
feed; this just watches for it and posts a desktop notification the moment the
first analytics rows appear (First-Time Downloads / impressions / sessions /
crashes etc.), then writes a marker + stops its own launchd job so it doesn't
keep running. Scheduled by com.dallal.appstore.analyticscheck (every 2h).
"""
import os
import subprocess
import sys
from datetime import datetime, timezone

import requests

ANALYTICS_METRICS = [
    "impressions", "product_page_views", "sessions", "active_devices",
    "crashes", "downloads_analytics", "redownloads_analytics",
]
MARKER = os.path.expanduser("~/dallal-sprint-dashboard/logs/.analytics_landed")


def notify(title, msg):
    try:
        subprocess.run(
            ["osascript", "-e",
             'display notification %r with title %r sound name "Glass"' % (msg, title)],
            check=False,
        )
    except Exception:
        pass


def slack(text):
    """Post to Slack via Incoming Webhook if SLACK_WEBHOOK_URL is set."""
    hook = os.environ.get("SLACK_WEBHOOK_URL", "").strip()
    if not hook.startswith("https://hooks.slack.com/"):
        return False
    try:
        r = requests.post(hook, json={"text": text}, timeout=30)
        return r.status_code == 200
    except Exception as e:
        print("slack post failed:", e)
        return False


def main():
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    if "--test-slack" in sys.argv:
        ok = slack(":satellite: Dallal App Store analytics checker — test ping. Slack is wired up correctly.")
        print(now, "slack test:", "sent" if ok else "FAILED (check SLACK_WEBHOOK_URL)")
        return
    if os.path.exists(MARKER):
        print(now, "already notified — nothing to do")
        return

    url = os.environ.get("SUPABASE_URL", "").rstrip("/") + "/rest/v1/fact_appstore_metrics"
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not key or not url.startswith("http"):
        print(now, "missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — skipping")
        return

    inlist = ",".join(ANALYTICS_METRICS)
    headers = {"apikey": key, "Authorization": "Bearer " + key,
               "Prefer": "count=exact", "Range": "0-0"}
    try:
        r = requests.get(url + "?select=metric&metric=in.(%s)" % inlist, headers=headers, timeout=60)
    except Exception as e:
        print(now, "check failed:", e)
        return

    total = r.headers.get("content-range", "*/0").split("/")[-1]
    try:
        n = int(total)
    except ValueError:
        n = 0
    print(now, "analytics rows:", n, "(HTTP", str(r.status_code) + ")")

    if n > 0:
        try:
            open(MARKER, "w").write(now)
        except Exception:
            pass
        msg = ("%d analytics rows are now in Supabase — First-Time Downloads / impressions / "
               "conversion now match App Store Connect. Ask Claude to verify the mapping." % n)
        notify("Dallal · App Store Analytics landed 🎉", msg)
        slack(":tada: *Dallal · App Store Analytics landed* — " + msg)
        print(now, "NOTIFIED (macOS + Slack) — stopping the checker job")
        subprocess.run(
            ["launchctl", "bootout", "gui/%d/com.dallal.appstore.analyticscheck" % os.getuid()],
            check=False,
        )


if __name__ == "__main__":
    main()
