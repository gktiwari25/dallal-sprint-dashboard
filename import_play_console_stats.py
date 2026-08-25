#!/usr/bin/env python3
"""
import_play_console_stats.py — land a MANUALLY-downloaded Google Play Console
"Statistics" CSV into Supabase `fact_appstore_metrics` (platform='android').

Why this exists: Google's Cloud-Storage bulk export (used by etl_playstore.py)
froze this app's install/acquisition statistics at ~Aug 4 2026, while the Play
Console UI still has fresh numbers. Until Google's export resumes, download the
statistic from the Console and import it here to keep the dashboard current.

How to get the CSV:
  Play Console → Statistics → metric "New users acquired"
  (USER_ACQUISITION-NEW-EVENTS-PER_INTERVAL-DAY), dimension = Country,
  pick your date range → Export → CSV.
  The file looks like:
    Date,"User acquisition (New users, ... Daily): All countries / regions",...,Notes
    "Aug 12, 2026",6,5,0,

Mapping: the "All countries / regions" column → metric `downloads` (Daily User
Installs equivalent, i.e. the by-unique-user "Installs" the dashboard shows),
territory='WW'. Per-country columns are NOT imported, because the dashboard sums
all territories for the KPI total and Android is stored WW-only — adding
per-country rows would double-count. (The number IS the all-countries total.)

Run:  python3 import_play_console_stats.py "/path/to/Play Console export.csv"
      python3 import_play_console_stats.py "<csv>" --metric downloads
"""
import argparse
import csv
import io
import os
import sys
from datetime import datetime, timezone

import requests

# Header keyword -> our metric (matched against the "All countries" column header,
# lower-cased; first match wins, so order matters). Extend as needed.
HEADER_METRIC = [
    ("new users", "downloads"),                 # "User acquisition (New users…)" = installs by user
    ("device acquisition", "device_installs"),  # installs by device
    ("install base", "active_devices"),         # unique devices with the app installed
    ("returning users", "returning_users"),     # re-engaged users
    ("user loss", "uninstalls"),                # users who left / uninstalled
    ("total impressions", "impressions"),       # store-listing impressions
    ("store listing visitors", "product_page_views"),   # store-listing views
    ("store listing acquisitions", "store_acquisitions"),
    ("daily active users", "dau"),
    ("dau/mau", "dau_mau"),                      # stickiness %, stored as a number (8.72 = 8.72%)
    ("installed audience", "installed_audience"),
    ("anrs", "anrs"),
    ("crashes", "crashes"),                     # daily crashes (dimension is Android version)
    ("daily user installs", "downloads"),
    ("daily device installs", "device_installs"),
]


def load_env(path=".env"):
    env = {}
    if os.path.exists(path):
        for line in open(path):
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k] = v.strip().strip('"').strip("'")
    for k, v in env.items():
        os.environ.setdefault(k, v)
    return os.environ


def parse_date(s):
    s = (s or "").strip().strip('"')
    for fmt in ("%b %d, %Y", "%Y-%m-%d", "%b %d %Y", "%d %b %Y"):
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            continue
    return None


def to_num(v):
    """Parse a Play Console cell → number. Handles commas, '%' (DAU/MAU) and '-'
    (no data). Returns int for whole values, float otherwise, None if unparseable."""
    s = str(v).replace(",", "").replace("%", "").strip()
    if s in ("", "-", "N/A", "NaN"):
        return None
    try:
        n = float(s)
    except (ValueError, TypeError):
        return None
    return int(n) if n == int(n) else round(n, 4)


def detect(header, forced_metric):
    """Return (date_col, value_col, metric). value_col = the 'All countries' column."""
    date_col = next((h for h in header if h.strip().lower() == "date"), None)
    # the overall column is the acquisition/installs column for "All countries / regions"
    overall = next((h for h in header if "all countries" in h.lower()), None)
    if overall is None:
        # fall back to the first non-Date, non-Notes column
        overall = next((h for h in header if h.strip().lower() not in ("date", "notes")), None)
    metric = forced_metric
    if not metric and overall:
        low = overall.lower()
        for kw, m in HEADER_METRIC:
            if kw in low:
                metric = m
                break
    return date_col, overall, metric


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("csv", help="path to the Play Console statistics CSV export")
    ap.add_argument("--metric", default=None, help="override target metric (downloads | device_installs)")
    ap.add_argument("--dry-run", action="store_true", help="parse & print, don't upsert")
    args = ap.parse_args()

    load_env()
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not (url and key):
        sys.exit("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env")

    with open(args.csv, newline="", encoding="utf-8-sig") as f:
        reader = csv.reader(f)
        header = next(reader, [])
        date_col, overall, metric = detect(header, args.metric)
        if not (date_col and overall and metric):
            sys.exit("Could not detect Date / value column / metric.\n  header=%s\n  -> date=%r value=%r metric=%r"
                     % (header, date_col, overall, metric))
        di, vi = header.index(date_col), header.index(overall)
        print("Detected: date=%r  value=%r  ->  metric=%r (android, territory=WW)" % (date_col, overall, metric))
        rows = []
        for rec in reader:
            if len(rec) <= max(di, vi):
                continue
            d = parse_date(rec[di])
            v = to_num(rec[vi])
            if d is None or v is None:
                continue
            rows.append({"date": d, "metric": metric, "value": v, "territory": "WW",
                         "platform": "android", "app_version": None})

    if not rows:
        sys.exit("No parseable rows found.")
    dts = [r["date"] for r in rows]
    if len(rows) <= 14:
        for r in rows:
            print("  %s  %s = %s" % (r["date"], r["metric"], r["value"]))
    else:
        for r in rows[:3] + rows[-3:]:
            print("  %s  %s = %s" % (r["date"], r["metric"], r["value"]))
        print("  … (%d rows total)" % len(rows))
    nz = sum(1 for r in rows if r["value"] != 0)
    print("Total: %d day-rows  (%s → %s, %d non-zero)" % (len(rows), min(dts), max(dts), nz))

    if args.dry_run:
        print("(dry run — nothing written)")
        return

    stamp = datetime.now(timezone.utc).isoformat()
    for r in rows:
        r["updated_at"] = stamp
    headers = {"apikey": key, "Authorization": "Bearer " + key,
               "Content-Type": "application/json",
               "Prefer": "resolution=merge-duplicates,return=minimal"}
    for i in range(0, len(rows), 1000):   # chunk large multi-year files
        chunk = rows[i:i + 1000]
        resp = requests.post(url.rstrip("/") + "/rest/v1/fact_appstore_metrics?on_conflict=date,metric,territory,platform",
                             headers=headers, json=chunk, timeout=120)
        if resp.status_code not in (200, 201, 204):
            sys.exit("Upsert failed [%d]: %s %s" % (i, resp.status_code, resp.text[:300]))
    print("Upserted %d rows into fact_appstore_metrics." % len(rows))


if __name__ == "__main__":
    main()
