#!/usr/bin/env python3
"""
etl_appstore.py — pull Apple App Store analytics into Supabase `fact_appstore_metrics`.

Sources (App Store Connect API):
  1. Sales and Trends Reports  -> daily first-time downloads + redownloads, by territory.
  2. App Analytics Reports     -> impressions, product page views, sessions,
                                  active devices, crashes (worldwide).

The dashboard (app.js -> renderAppStore) reads the table live via Supabase, so once
this runs on a schedule the "App Store" tab shows real data instead of the sample.

------------------------------------------------------------------------------------
SETUP (one time)
------------------------------------------------------------------------------------
1. App Store Connect -> Users and Access -> Integrations -> App Store Connect API:
   create a key with the "Admin" or "Sales and Finance" role. Download the .p8 ONCE.
   Note the Issuer ID and Key ID.
2. Find your Vendor Number (Payments and Financial Reports) for Sales reports,
   and your App's Apple ID (App Store Connect -> App -> App Information) for Analytics.
3. Put credentials in the environment (e.g. exported from run_sync.sh):
     export ASC_ISSUER_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
     export ASC_KEY_ID=XXXXXXXXXX
     export ASC_PRIVATE_KEY_PATH=/path/to/AuthKey_XXXXXXXXXX.p8
     export ASC_VENDOR_NUMBER=8XXXXXXX
     export ASC_APP_ID=1234567890
     export SUPABASE_URL=https://dgcxiznnyvhddzsoaxsd.supabase.co
     export SUPABASE_SERVICE_ROLE_KEY=eyJ...    # service_role — server side only, never ship to browser
4. pip install pyjwt cryptography requests

Run:  python3 etl_appstore.py            # last 3 days (Apple lag) + backfill gaps
      python3 etl_appstore.py --days 30  # backfill a wider window
"""

import argparse
import csv
import gzip
import io
import os
import sys
import time
from datetime import datetime, timedelta, timezone

import requests

try:
    import jwt  # PyJWT
except ImportError:
    sys.exit("Missing dependency: pip install pyjwt cryptography")

ASC_BASE = "https://api.appstoreconnect.apple.com"
ASC_AUD = "appstoreconnect-v1"

# ---- Sales report column -> our metric name ---------------------------------------
# In the Sales SUMMARY report, "Product Type Identifier" distinguishes first installs
# from redownloads; "Units" is the count and "Country Code" the territory.
FIRST_DOWNLOAD_TYPES = {"1", "1F", "1T", "1E", "1EP", "1EU"}   # new app installs
REDOWNLOAD_TYPES = {"3", "3F", "3T", "3E", "3EP", "3EU"}       # re-downloads/updates


def env(name, required=True, default=None):
    v = os.environ.get(name, default)
    if required and not v:
        sys.exit(f"Missing required env var: {name}")
    return v


def make_token():
    """Mint a short-lived ES256 JWT for the App Store Connect API."""
    key_path = env("ASC_PRIVATE_KEY_PATH", required=False)
    private_key = None
    if key_path and os.path.exists(key_path):
        with open(key_path, "r") as fh:
            private_key = fh.read()
    else:
        private_key = env("ASC_PRIVATE_KEY", required=False)  # inline .p8 contents
    if not private_key:
        sys.exit("Provide ASC_PRIVATE_KEY_PATH or ASC_PRIVATE_KEY")

    issuer = env("ASC_ISSUER_ID")
    key_id = env("ASC_KEY_ID")
    now = int(time.time())
    payload = {"iss": issuer, "iat": now, "exp": now + 60 * 18, "aud": ASC_AUD}
    return jwt.encode(payload, private_key, algorithm="ES256", headers={"kid": key_id, "typ": "JWT"})


def asc_get(token, path, params=None, accept="application/json", stream=False):
    r = requests.get(
        ASC_BASE + path,
        headers={"Authorization": f"Bearer {token}", "Accept": accept},
        params=params or {},
        timeout=90,
        stream=stream,
    )
    return r


# ------------------------------------------------------------------------------------
# 1. Sales & Trends: downloads + redownloads by territory, per day
# ------------------------------------------------------------------------------------
def fetch_sales_day(token, vendor_number, day):
    """Return list of tidy rows for one report date, or [] if not available yet."""
    params = {
        "filter[frequency]": "DAILY",
        "filter[reportType]": "SALES",
        "filter[reportSubType]": "SUMMARY",
        "filter[vendorNumber]": vendor_number,
        "filter[reportDate]": day,      # YYYY-MM-DD
        "filter[version]": "1_1",
    }
    r = asc_get(token, "/v1/salesReports", params=params, accept="application/a-gzip", stream=True)
    if r.status_code == 404:
        return []  # Apple hasn't produced this day's report yet (normal for recent days)
    if r.status_code != 200:
        print(f"  sales {day}: HTTP {r.status_code} {r.text[:200]}")
        return []

    raw = gzip.decompress(r.content)
    text = raw.decode("utf-8", errors="replace")
    reader = csv.DictReader(io.StringIO(text), delimiter="\t")

    dl_by_terr, redl_total = {}, 0
    app_version = None
    for row in reader:
        units = int(float(row.get("Units", "0") or 0))
        ptype = (row.get("Product Type Identifier", "") or "").strip()
        country = (row.get("Country Code", "") or "WW").strip() or "WW"
        app_version = row.get("Version") or app_version
        if ptype in FIRST_DOWNLOAD_TYPES:
            dl_by_terr[country] = dl_by_terr.get(country, 0) + units
        elif ptype in REDOWNLOAD_TYPES:
            redl_total += units

    rows = []
    for terr, units in dl_by_terr.items():
        rows.append(dict(date=day, metric="downloads", value=units,
                         territory=terr, platform="ios", app_version=app_version))
    if redl_total:
        rows.append(dict(date=day, metric="redownloads", value=redl_total,
                         territory="WW", platform="ios", app_version=app_version))
    return rows


# ------------------------------------------------------------------------------------
# 2. App Analytics Reports: impressions / page views / sessions / active devices / crashes
#    These are asynchronous: create a report request, poll for the report + its
#    instances, then download CSV segments. Apple's report NAMES are account-specific,
#    so we match on substrings. Adjust ANALYTICS_METRIC_MAP if your report names differ.
# ------------------------------------------------------------------------------------
ANALYTICS_METRIC_MAP = [
    # (substring to find in the Apple analytics report name, our metric, csv column)
    ("App Store Impressions", "impressions", "Impressions"),
    ("Product Page Views", "product_page_views", "Product Page Views"),
    ("Sessions", "sessions", "Sessions"),
    ("Active Devices", "active_devices", "Active Devices"),
    ("Crashes", "crashes", "Crashes"),
]


def ensure_analytics_request(token, app_id):
    """Find an ONGOING analyticsReportRequest for the app, or create one."""
    r = asc_get(token, f"/v1/apps/{app_id}/analyticsReportRequests",
                params={"filter[accessType]": "ONGOING"})
    if r.status_code == 200:
        for item in r.json().get("data", []):
            if item.get("attributes", {}).get("accessType") == "ONGOING":
                return item["id"]
    # create one
    body = {"data": {"type": "analyticsReportRequests",
                     "attributes": {"accessType": "ONGOING"},
                     "relationships": {"app": {"data": {"type": "apps", "id": app_id}}}}}
    cr = requests.post(ASC_BASE + "/v1/analyticsReportRequests",
                       headers={"Authorization": f"Bearer {token}",
                                "Content-Type": "application/json"},
                       json=body, timeout=60)
    if cr.status_code not in (200, 201):
        print(f"  analytics request create failed: {cr.status_code} {cr.text[:200]}")
        return None
    return cr.json()["data"]["id"]


def fetch_analytics(token, app_id, since_day):
    """
    Best-effort pull of daily analytics rows on/after since_day.
    Returns tidy rows. Analytics reports lag ~1-2 days and arrive as gzipped CSV
    segments; we stream each segment and keep rows dated >= since_day.
    """
    req_id = ensure_analytics_request(token, app_id)
    if not req_id:
        return []

    rows = []
    reports = asc_get(token, f"/v1/analyticsReportRequests/{req_id}/reports",
                      params={"limit": 200})
    if reports.status_code != 200:
        print(f"  analytics reports list: HTTP {reports.status_code}")
        return []

    for report in reports.json().get("data", []):
        name = report.get("attributes", {}).get("name", "")
        match = next((m for m in ANALYTICS_METRIC_MAP if m[0].lower() in name.lower()), None)
        if not match:
            continue
        _, metric, col = match
        rows += _download_report_instances(token, report["id"], metric, col, since_day)
    return rows


def _download_report_instances(token, report_id, metric, col, since_day):
    out = []
    inst = asc_get(token, f"/v1/analyticsReports/{report_id}/instances",
                   params={"filter[granularity]": "DAILY", "limit": 200})
    if inst.status_code != 200:
        return out
    for instance in inst.json().get("data", []):
        seg = asc_get(token, f"/v1/analyticsReportInstances/{instance['id']}/segments",
                      params={"limit": 200})
        if seg.status_code != 200:
            continue
        for segment in seg.json().get("data", []):
            url = segment.get("attributes", {}).get("url")
            if not url:
                continue
            blob = requests.get(url, timeout=120)  # pre-signed S3-style URL, no auth header
            if blob.status_code != 200:
                continue
            try:
                text = gzip.decompress(blob.content).decode("utf-8", "replace")
            except OSError:
                text = blob.content.decode("utf-8", "replace")
            reader = csv.DictReader(io.StringIO(text), delimiter="\t")
            for row in reader:
                day = (row.get("Date") or "").strip()[:10]
                if not day or day < since_day:
                    continue
                val = row.get(col) or row.get("Value") or "0"
                try:
                    val = int(float(str(val).replace(",", "")))
                except ValueError:
                    continue
                out.append(dict(date=day, metric=metric, value=val,
                                territory="WW", platform="ios", app_version=None))
    return out


# ------------------------------------------------------------------------------------
# Upsert into Supabase via PostgREST (service_role bypasses RLS)
# ------------------------------------------------------------------------------------
def upsert(rows):
    if not rows:
        print("No rows to upsert.")
        return
    url = env("SUPABASE_URL").rstrip("/") + "/rest/v1/fact_appstore_metrics"
    key = env("SUPABASE_SERVICE_ROLE_KEY")
    stamp = datetime.now(timezone.utc).isoformat()
    for r in rows:
        r["updated_at"] = stamp
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        # merge on the unique (date, metric, territory, platform) key
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }
    # chunk to keep requests small
    for i in range(0, len(rows), 500):
        chunk = rows[i:i + 500]
        resp = requests.post(url + "?on_conflict=date,metric,territory,platform",
                             headers=headers, json=chunk, timeout=90)
        if resp.status_code not in (200, 201, 204):
            print(f"  upsert failed [{i}]: {resp.status_code} {resp.text[:300]}")
        else:
            print(f"  upserted {len(chunk)} rows")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=3,
                    help="how many trailing days of Sales reports to (re)fetch (default 3)")
    args = ap.parse_args()

    token = make_token()
    vendor = env("ASC_VENDOR_NUMBER")
    app_id = env("ASC_APP_ID")

    today = datetime.now(timezone.utc).date()
    all_rows = []

    # Sales & Trends — Apple posts DAILY reports with ~1 day lag; loop the window.
    for d in range(1, args.days + 1):
        day = (today - timedelta(days=d)).isoformat()
        day_rows = fetch_sales_day(token, vendor, day)
        print(f"Sales {day}: {len(day_rows)} rows")
        all_rows += day_rows

    # App Analytics — pull anything dated within the same window.
    since = (today - timedelta(days=args.days)).isoformat()
    analytics_rows = fetch_analytics(token, app_id, since)
    print(f"Analytics since {since}: {len(analytics_rows)} rows")
    all_rows += analytics_rows

    upsert(all_rows)
    print(f"Done. {len(all_rows)} total rows.")


if __name__ == "__main__":
    main()
