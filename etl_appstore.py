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
# The Analytics feed powers the metrics that MATCH App Store Connect > Analytics
# (First-Time Downloads, Redownloads, Impressions, Product Page Views, Sessions,
# Active Devices, Crashes). Report + column names vary a little by account, so we
# detect columns defensively. Run `python3 etl_appstore.py --debug-analytics` to
# print each discovered report name + its CSV header, then tighten the lists below.
DEBUG = False

DATE_COLS = ["Date", "Day"]
COUNT_COLS = ["Counts", "Count", "Value", "Unique Devices"]
# Download-type dimension value -> our metric (mirrors the App Analytics cards).
# DISABLED: the App Analytics ONGOING install feed produced inflated first-time /
# redownload counts (e.g. 44-125/day vs Apple's ~25-30 and Sales & Trends App Units).
# We now take iOS downloads/redownloads from Sales & Trends only, so don't ingest
# the analytics download-type metrics. Impressions / page views / sessions / crashes
# come from other reports and are unaffected. Re-enable only if the feed is verified.
DLTYPE_COLS = ["Download Type", "Event", "Type"]
DLTYPE_METRIC = {}
# Report-name substrings whose rows carry download-type-dimensioned install counts
DOWNLOAD_REPORT_HINTS = ["install", "download", "acquisition"]
# Single-metric reports: (report-name substring, our metric, value-column candidates)
ANALYTICS_SINGLE = [
    ("session", "sessions", ["Sessions", "Counts", "Value"]),
    ("crash", "crashes", ["Crashes", "Counts", "Value"]),
]
# App Store Discovery and Engagement report: Impressions and Product Page Views
# aren't separate reports — they're Event-dimension rows inside this one report
# (exactly like Download Type inside the install report). Match the report by
# name, then map the Event value to our metric. Exact-match the total-count
# events only (skip "… Unique Devices" variants) so we don't double-count.
ENGAGEMENT_REPORT_HINTS = ["discovery and engagement"]
IMPRESSION_EVENTS = {"impression", "impressions"}
PAGEVIEW_EVENTS = {"product page view", "product page views", "page view", "page views"}


def _engagement_metric(event):
    e = (event or "").strip().lower()
    if e in IMPRESSION_EVENTS:
        return "impressions"
    if e in PAGEVIEW_EVENTS:
        return "product_page_views"
    return None


def _to_int(v):
    try:
        return int(float(str(v).replace(",", "").strip()))
    except (ValueError, TypeError):
        return None


def _find_col(header, candidates):
    low = {h.lower(): h for h in (header or [])}
    for c in candidates:
        if c.lower() in low:
            return low[c.lower()]
    return None


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

    reports = asc_get(token, f"/v1/analyticsReportRequests/{req_id}/reports",
                      params={"limit": 200})
    if reports.status_code != 200:
        print(f"  analytics reports list: HTTP {reports.status_code}")
        return []

    raw = []
    for report in reports.json().get("data", []):
        name = report.get("attributes", {}).get("name", "")
        raw += _download_report_instances(token, report["id"], name, since_day)

    # Analytics rows fan out by country/source/type — collapse to one value per
    # (date, metric) so First-Time Downloads etc. are worldwide daily totals.
    agg = {}
    for r in raw:
        agg[(r["date"], r["metric"])] = agg.get((r["date"], r["metric"]), 0) + r["value"]
    return [dict(date=d, metric=m, value=v, territory="WW", platform="ios", app_version=None)
            for (d, m), v in agg.items()]


def _parse_segment(text, report_name, since_day):
    """Parse one analytics CSV/TSV segment into tidy rows (defensive column detection)."""
    first_line = text.split("\n", 1)[0]
    delim = "\t" if "\t" in first_line else ","
    reader = csv.DictReader(io.StringIO(text), delimiter=delim)
    header = reader.fieldnames or []
    if DEBUG:
        print(f"    [debug] report={report_name!r} cols={header}")
    date_col = _find_col(header, DATE_COLS)
    if not date_col:
        return []
    name_l = report_name.lower()
    is_dl = any(h in name_l for h in DOWNLOAD_REPORT_HINTS)
    is_eng = any(h in name_l for h in ENGAGEMENT_REPORT_HINTS)
    dltype_col = _find_col(header, DLTYPE_COLS) if is_dl else None
    event_col = _find_col(header, ["Event"]) if is_eng else None
    count_col = _find_col(header, COUNT_COLS)
    single = next((s for s in ANALYTICS_SINGLE if s[0] in name_l), None)
    single_col = _find_col(header, single[2]) if single else None
    # Active-devices ESTIMATE: Apple exposes no clean, summable Active Devices
    # report, so approximate it from the Unique Devices column of the App Sessions
    # report. Summing over the report's slices over-counts slightly (a device can
    # appear under multiple source/territory/version rows), so this is an
    # upper-bound estimate — surfaced separately as `active_devices_est`.
    uniq_col = _find_col(header, ["Unique Devices"]) if "session" in name_l else None

    out = []
    for row in reader:
        day = (row.get(date_col) or "").strip()[:10]
        if not day or day < since_day:
            continue
        if is_dl and dltype_col and count_col:
            metric = DLTYPE_METRIC.get((row.get(dltype_col) or "").strip().lower())
            v = _to_int(row.get(count_col))
            if metric and v is not None:
                out.append(dict(date=day, metric=metric, value=v))
        elif is_eng and event_col and count_col:
            metric = _engagement_metric(row.get(event_col))
            v = _to_int(row.get(count_col))
            if metric and v is not None:
                out.append(dict(date=day, metric=metric, value=v))
        elif single and single_col:
            v = _to_int(row.get(single_col))
            if v is not None:
                out.append(dict(date=day, metric=single[1], value=v))
        if uniq_col:
            u = _to_int(row.get(uniq_col))
            if u is not None:
                out.append(dict(date=day, metric="active_devices_est", value=u))
    return out


def _download_report_instances(token, report_id, report_name, since_day):
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
            blob = requests.get(url, timeout=120)  # pre-signed URL, no auth header
            if blob.status_code != 200:
                continue
            try:
                text = gzip.decompress(blob.content).decode("utf-8", "replace")
            except OSError:
                text = blob.content.decode("utf-8", "replace")
            out += _parse_segment(text, report_name, since_day)
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
    global DEBUG
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=3,
                    help="how many trailing days of Sales reports to (re)fetch (default 3)")
    ap.add_argument("--debug-analytics", action="store_true",
                    help="print each analytics report name + CSV header, to verify/adjust the column mapping")
    args = ap.parse_args()
    DEBUG = args.debug_analytics

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
