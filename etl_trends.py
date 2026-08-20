#!/usr/bin/env python3
"""
etl_trends.py — Amplitude event-segmentation TREND charts -> Supabase fact_trends.

Reproduces the team's saved Amplitude trend charts (daily unique users, last 30
days) so the dashboard's Funnels > Trends section matches Amplitude:
  - Registration and Log In            (chart pxetzn7k)
  - Demand Side Activities             (chart hpda3uog)
  - Register Interest & Messaging      (chart zgcuxxs2)

fact_trends: one row per (env, chart, series, date). env=PROD (app 776558).

.env: AMPLITUDE_PROD_API_KEY / AMPLITUDE_PROD_SECRET_KEY, AMPLITUDE_API_HOST,
      SUPABASE_URL, SUPABASE_SERVICE_KEY / SUPABASE_SERVICE_ROLE_KEY
Run:  python3 etl_trends.py [--days 30] [--supabase]
"""
import argparse
import base64
import json
import os
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

HOST = os.environ.get("AMPLITUDE_API_HOST", "https://amplitude.com").rstrip("/")

# (chart display name, [(series label, event_type), ...]) — from the saved charts.
TRENDS = [
    {"chart": "Registration and Log In", "events": [
        ("Registration via Phone No.", "register_phone_number"),
        ("Login via Phone No.", "login_phone_number"),
        ("Registration via Apple", "register_apple"),
        ("Registration via Google (MOB)", "register_google"),
        ("Registration via Google (Web)", "login_google"),
        ("Log in via email", "login_email"),
    ]},
    {"chart": "Demand Side Activities", "events": [
        ("Landing Page Viewed", "listing_viewed"),
        ("Property Details Viewed", "view_details"),
        ("Likes", "property_liked"),
        ("Saves", "property_details_saved"),
        ("Shares", "property_shared"),
        ("Messages sent to Listers", "message_lister"),
    ]},
    {"chart": "Register Interest & Messaging", "events": [
        ("Clicked Register Interest", "register_interest_clicked"),
        ("Messages sent to listers", "message_lister"),
        ("Messages screen viewed", "messages_viewed"),
        ("Property Details Viewed", "view_details"),
    ]},
    # --- Product insights shared by Rayan (Aug 2026) ---
    # Kuwait Daily Active Users (any active event, filtered to country = Kuwait).
    {"chart": "Kuwait — Daily Active Users",
     "seg": [{"prop": "country", "op": "is", "values": ["Kuwait"]}],
     "events": [("Daily Active Users · Kuwait", "_active")]},
    # How seekers browse: searching via filters vs via the map (chart 9r2ga5vn).
    {"chart": "Search — Filters vs Map", "events": [
        ("Searching via Filters", "search_from_filters"),
        ("Searching via Map", "search_from_map"),
    ]},
    # Marketplace liquidity: seekers messaging listers vs listers replying (yna8m93c).
    {"chart": "Messaging — Seekers vs Listers", "events": [
        ("Seekers → Listers", "message_lister"),
        ("Listers → Seekers (replies)", "message_seeker"),
    ]},
]


def query_segmentation(key, secret, event, start, end, seg=None):
    """Daily unique users for one event -> [(YYYY-MM-DD, value), ...].
    seg = optional Amplitude segment filter list (e.g. country = Kuwait)."""
    q = {
        "e": json.dumps({"event_type": event}),
        "start": start, "end": end, "m": "uniques", "i": 1, "n": "active",
    }
    if seg:
        q["s"] = json.dumps(seg)
    params = urllib.parse.urlencode(q)
    req = urllib.request.Request(HOST + "/api/2/events/segmentation?" + params,
                                 headers={"Authorization": "Basic " + base64.b64encode(f"{key}:{secret}".encode()).decode()})
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            d = json.loads(r.read()).get("data", {})
    except urllib.error.HTTPError as e:
        print(f"    seg {event}: HTTP {e.code} {e.read().decode()[:120]}", file=sys.stderr)
        return []
    xs = d.get("xValues", [])
    series = d.get("series", [])
    vals = series[0] if series else []
    return [(str(x)[:10], v) for x, v in zip(xs, vals)]


def upsert(rows):
    url = os.environ["SUPABASE_URL"].rstrip("/") + "/rest/v1/fact_trends?on_conflict=env,chart,series,date"
    key = os.environ.get("SUPABASE_SERVICE_KEY") or os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    import urllib.request as u
    for i in range(0, len(rows), 500):
        body = json.dumps(rows[i:i + 500]).encode()
        req = u.Request(url, data=body, method="POST", headers={
            "apikey": key, "Authorization": "Bearer " + key, "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal"})
        with u.urlopen(req, timeout=90) as r:
            print(f"  fact_trends[{i}]: {r.status}", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument("--supabase", action="store_true")
    args = ap.parse_args()
    key = os.environ.get("AMPLITUDE_PROD_API_KEY")
    secret = os.environ.get("AMPLITUDE_PROD_SECRET_KEY")
    if not key or not secret:
        sys.exit("Missing AMPLITUDE_PROD_API_KEY / AMPLITUDE_PROD_SECRET_KEY")
    end = datetime.now(timezone.utc).date()
    start = end - timedelta(days=args.days)
    s, e = start.strftime("%Y%m%d"), end.strftime("%Y%m%d")

    rows = []
    for t in TRENDS:
        seg = t.get("seg")
        for label, event in t["events"]:
            for day, val in query_segmentation(key, secret, event, s, e, seg=seg):
                rows.append({"env": "PROD", "chart": t["chart"], "series": label, "date": day, "value": int(val)})
        total = sum(r["value"] for r in rows if r["chart"] == t["chart"])
        print(f"[PROD] {t['chart']}: {total} total uniques across series", file=sys.stderr)

    print(f"{len(rows)} trend rows")
    if args.supabase:
        upsert(rows)
    print("Done.")


if __name__ == "__main__":
    main()
