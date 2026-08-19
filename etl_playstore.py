#!/usr/bin/env python3
"""
etl_playstore.py — pull Google Play (Android) analytics into Supabase
`fact_appstore_metrics` as platform='android' rows, so the dashboard's
App Analytics > Android tab shows real data next to iOS.

Source: Google Play bulk reports in the developer's Cloud Storage bucket
(gs://pubsite_prod_<id>/stats/...). Monthly CSVs (UTF-16), one row per day.

Metrics captured (mapped to the shared schema):
  downloads          <- installs overview "Daily User Installs" (new-user installs)
  active_devices     <- installs overview "Active Device Installs"
  product_page_views <- store_performance "Store Listing Visitors"
  crashes            <- crashes overview "Daily Crashes"
  downloads(territory) <- installs *_country report, per country

------------------------------------------------------------------------------------
SETUP (.env)
  GOOGLE_APPLICATION_CREDENTIALS=/…/secrets/dallal-play-sa.json   # service-account key
  PLAY_BUCKET_ID=pubsite_prod_XXXXXXXXXXXXXXXXX                   # from Play Console
  PLAY_PACKAGE_NAME=com.app.dallal
  SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY                        # shared with the iOS ETL
Needs: pip install google-cloud-storage requests

The service account must have "View app information and download bulk reports"
in Play Console (Users and permissions) — grants read on the pubsite bucket.
Access can take time to propagate after granting.

Run:  python3 etl_playstore.py --months 2
      python3 etl_playstore.py --debug   # list matching report files + CSV headers
"""

import argparse
import csv
import io
import os
import sys
from datetime import datetime, timedelta, timezone

import requests

try:
    from google.cloud import storage
    from google.oauth2 import service_account
except ImportError:
    sys.exit("Missing dep: pip install google-cloud-storage")

DEBUG = False

# Column candidates (Play report headers are stable but we stay defensive).
DATE_COLS = ["Date"]
COUNTRY_COLS = ["Country", "Country/Region", "Region"]
# (report subdir, endswith filter, our metric, value-column candidates)
INSTALL_METRICS = [
    ("downloads", ["Daily User Installs", "Store Listing Acquisitions (Unique Users)", "Daily Device Installs"]),
    ("active_devices", ["Active Device Installs", "Active Devices"]),
]
STORE_METRICS = [
    ("product_page_views", ["Store Listing Visitors", "Store Listing Visitors (Unique Users)"]),
]
CRASH_METRICS = [
    ("crashes", ["Daily Crashes", "Crashes"]),
]


def env(name, required=True, default=None):
    v = os.environ.get(name, default)
    if required and not v:
        sys.exit(f"Missing required env var: {name}")
    return v


def to_int(v):
    try:
        return int(round(float(str(v).replace(",", "").strip())))
    except (ValueError, TypeError):
        return None


def find_col(header, candidates):
    low = {h.lower().strip(): h for h in (header or [])}
    for c in candidates:
        if c.lower() in low:
            return low[c.lower()]
    return None


def gcs_client():
    cred = service_account.Credentials.from_service_account_file(
        env("GOOGLE_APPLICATION_CREDENTIALS"))
    return storage.Client(credentials=cred, project=cred.project_id)


def decode_report(raw):
    """Play bulk CSVs are UTF-16; fall back to utf-8."""
    for enc in ("utf-16", "utf-16-le", "utf-8-sig", "utf-8"):
        try:
            text = raw.decode(enc)
            if "\x00" not in text:
                return text
        except (UnicodeDecodeError, LookupError):
            continue
    return raw.decode("utf-8", "replace")


def months_back(n):
    """List of YYYYMM strings for the current and previous n-1 months."""
    out, d = [], datetime.now(timezone.utc).date().replace(day=1)
    for _ in range(n):
        out.append(d.strftime("%Y%m"))
        d = (d - timedelta(days=1)).replace(day=1)
    return out


def parse_rows(text, metric_specs, since_day, territory_mode=False):
    reader = csv.DictReader(io.StringIO(text))
    header = reader.fieldnames or []
    if DEBUG:
        print(f"    [debug] cols={header}")
    date_col = find_col(header, DATE_COLS)
    if not date_col:
        return []
    country_col = find_col(header, COUNTRY_COLS) if territory_mode else None
    resolved = [(m, find_col(header, cands)) for m, cands in metric_specs]
    resolved = [(m, c) for m, c in resolved if c]
    out = []
    for row in reader:
        day = (row.get(date_col) or "").strip()[:10]
        if not day or day < since_day:
            continue
        terr = ((row.get(country_col) or "").strip().upper()[:2] or "WW") if country_col else "WW"
        for metric, col in resolved:
            v = to_int(row.get(col))
            if v is not None:
                out.append(dict(date=day, metric=metric, value=v, territory=terr,
                                platform="android", app_version=None))
    return out


def fetch_play(client, bucket_id, pkg, since_day, months):
    rows = []
    plan = [
        ("stats/installs/", "_overview.csv", INSTALL_METRICS, False),
        ("stats/installs/", "_country.csv", [("downloads", INSTALL_METRICS[0][1])], True),
        ("stats/store_performance/", "_country.csv", STORE_METRICS, False),
        ("stats/crashes/", "_overview.csv", CRASH_METRICS, False),
    ]
    bucket = client.bucket(bucket_id)
    for prefix, suffix, specs, terr in plan:
        for blob in client.list_blobs(bucket_id, prefix=prefix):
            name = blob.name
            if pkg not in name or not name.endswith(suffix):
                continue
            if not any(m in name for m in months):
                continue
            if DEBUG:
                print(f"  [debug] {name} ({blob.size} bytes)")
            text = decode_report(blob.download_as_bytes())
            got = parse_rows(text, specs, since_day, territory_mode=terr)
            rows += got
            print(f"  {name}: {len(got)} rows")
    # Traffic-source acquisitions (store_performance _traffic_source.csv). Dimension
    # is the source name (Play organic / Google Search / third-party / Other), which
    # we keep untruncated in `territory` under a dedicated metric.
    for blob in client.list_blobs(bucket_id, prefix="stats/store_performance/"):
        name = blob.name
        if pkg not in name or not name.endswith("_traffic_source.csv"):
            continue
        if not any(m in name for m in months):
            continue
        reader = csv.DictReader(io.StringIO(decode_report(blob.download_as_bytes())))
        header = reader.fieldnames or []
        dcol = find_col(header, DATE_COLS)
        scol = find_col(header, ["Traffic source", "Traffic Source"])
        vcol = find_col(header, ["Total store acquisitions", "Store acquisitions", "Acquisitions"])
        if not (dcol and scol and vcol):
            continue
        got = 0
        for row in reader:
            day = (row.get(dcol) or "").strip()[:10]
            if not day or day < since_day:
                continue
            src = (row.get(scol) or "").strip() or "Other"
            v = to_int(row.get(vcol))
            if v is not None:
                rows.append(dict(date=day, metric="traffic_source", value=v, territory=src, platform="android", app_version=None)); got += 1
        print(f"  {name}: {got} traffic-source rows")

    # collapse WW aggregates to one value per (date, metric); keep per-territory downloads
    agg = {}
    for r in rows:
        key = (r["date"], r["metric"], r["territory"])
        agg[key] = agg.get(key, 0) + r["value"]
    return [dict(date=d, metric=m, value=v, territory=t, platform="android", app_version=None)
            for (d, m, t), v in agg.items()]


def upsert(rows):
    if not rows:
        print("No Play rows to upsert.")
        return
    url = env("SUPABASE_URL").rstrip("/") + "/rest/v1/fact_appstore_metrics"
    key = env("SUPABASE_SERVICE_ROLE_KEY")
    stamp = datetime.now(timezone.utc).isoformat()
    for r in rows:
        r["updated_at"] = stamp
    headers = {"apikey": key, "Authorization": f"Bearer {key}",
               "Content-Type": "application/json",
               "Prefer": "resolution=merge-duplicates,return=minimal"}
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
    ap.add_argument("--months", type=int, default=2, help="how many trailing months of reports to fetch")
    ap.add_argument("--debug", action="store_true", help="list matching report files + CSV headers")
    args = ap.parse_args()
    DEBUG = args.debug

    client = gcs_client()
    bucket_id = env("PLAY_BUCKET_ID")
    pkg = env("PLAY_PACKAGE_NAME")
    months = months_back(args.months)
    since = (datetime.now(timezone.utc).date() - timedelta(days=args.months * 31)).isoformat()
    print(f"Play bucket {bucket_id} pkg {pkg} months {months} since {since}")

    rows = fetch_play(client, bucket_id, pkg, since, months)
    print(f"Total Play rows: {len(rows)}")
    upsert(rows)
    print("Done.")


if __name__ == "__main__":
    main()
