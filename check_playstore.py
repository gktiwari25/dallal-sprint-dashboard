#!/usr/bin/env python3
"""
Notify (macOS + Slack) once Google Play (Android) rows land in Supabase.

run_sync.sh runs etl_playstore.py hourly; it will keep failing with 403 until the
service account's bucket access propagates, then start ingesting. This watches for
the first platform='android' rows and pings once, then boots its own launchd job.
Scheduled by com.dallal.playstore.check (every 2h).
"""
import os
import subprocess
from datetime import datetime, timezone

import requests

MARKER = os.path.expanduser("~/dallal-sprint-dashboard/logs/.play_landed")


def notify(title, msg):
    try:
        subprocess.run(["osascript", "-e",
                        'display notification %r with title %r sound name "Glass"' % (msg, title)],
                       check=False)
    except Exception:
        pass


def slack(text):
    hook = os.environ.get("SLACK_WEBHOOK_URL", "").strip()
    if not hook.startswith("https://hooks.slack.com/"):
        return
    try:
        requests.post(hook, json={"text": text}, timeout=30)
    except Exception:
        pass


def main():
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    if os.path.exists(MARKER):
        print(now, "already notified — nothing to do")
        return
    url = os.environ.get("SUPABASE_URL", "").rstrip("/") + "/rest/v1/fact_appstore_metrics"
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not key or not url.startswith("http"):
        print(now, "missing supabase env — skipping")
        return
    headers = {"apikey": key, "Authorization": "Bearer " + key,
               "Prefer": "count=exact", "Range": "0-0"}
    try:
        r = requests.get(url + "?select=metric&platform=eq.android", headers=headers, timeout=60)
    except Exception as e:
        print(now, "check failed:", e)
        return
    try:
        n = int(r.headers.get("content-range", "*/0").split("/")[-1])
    except ValueError:
        n = 0
    print(now, "android rows:", n, "(HTTP", str(r.status_code) + ")")
    if n > 0:
        try:
            open(MARKER, "w").write(now)
        except Exception:
            pass
        msg = ("%d Android (Google Play) rows are now in Supabase — the App Analytics "
               "> Android tab is live. Ask Claude to verify the mapping." % n)
        notify("Dallal · Google Play analytics landed 🤖", msg)
        slack(":robot_face: *Dallal · Google Play analytics landed* — " + msg)
        print(now, "NOTIFIED — stopping the checker job")
        subprocess.run(["launchctl", "bootout",
                        "gui/%d/com.dallal.playstore.check" % os.getuid()], check=False)


if __name__ == "__main__":
    main()
