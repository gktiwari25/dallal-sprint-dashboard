#!/usr/bin/env python3
"""Listing-flow user PATHS (Sankey) via the Amplitude Export API.

The Dashboard REST API (funnels/segmentation/retention) cannot tell you WHERE a
dropped user went next — only per-step counts. So we download raw events via the
Export API, sort each user's events by time, and compute true transitions:

  * Spine   : Milestone_i -> Milestone_{i+1}  (# users who advanced; this equals
              the ordered-funnel count at step i+1, so the Sankey reconciles with
              the Listing Creation funnel exactly).
  * Drop    : for a user whose DEEPEST milestone is i (< Published), an edge
              Milestone_i -> {the first off-ramp screen they hit next in the same
              session}  or  Milestone_i -> "Exited"  if none.

Stored in Supabase `fact_paths(env, source, target, users, updated_at)` and drawn
as a Sankey on the dashboard's Funnels tab. Refreshed on the (slower) path cadence
— paths change slowly and the export is heavier than the funnel API.
"""
import argparse
import base64
import csv
import collections
import gzip
import io
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime, timedelta, timezone


def _env(*names):
    for n in names:
        v = os.environ.get(n)
        if v:
            return v
    return None


# Milestone spine — MUST match LISTING_CREATION_STEPS order in etl_amplitude.py.
# CURRENT flat taxonomy (the listing_flow.* events are deleted as of ~2026-07-03).
MILESTONES = [
    ("1 Started", "listing_started"),
    ("2 PACI", "listing_paci_number"),
    ("3 Address", "listing_address"),
    ("4 Category", "listing_category"),
    ("5 Property Details", "property_details_saved"),
    ("6 Pricing", "price_saved"),
    ("7 Photos", "property_media_added"),
    ("8 Published", "property_published"),
]
MILE_EVENT = {ev: lbl for lbl, ev in MILESTONES}
MILE_LABELS = [lbl for lbl, _ in MILESTONES]

# Off-ramp destinations — where a user goes when they leave the listing flow.
OFFRAMP = {
    # CURRENT (non-deleted) off-ramp events. The user_journey.* events are deleted.
    "property_search": "Search/Browse", "search_from_filters": "Search/Browse",
    "search_from_map": "Search/Browse", "search_raw_text": "Search/Browse",
    "results_sorted": "Search/Browse", "filters_applied": "Search/Browse", "filters_opened": "Search/Browse",
    "my_lists_opened": "My Lists", "my_properties_viewed": "My Lists", "my_listing_menu_opened": "My Lists",
    "more_menu_viewed": "Menu", "more_menu_section_opened": "Menu",
    "view_details": "View a Listing", "listing_viewed": "View a Listing",
    "logout": "Logged out", "sign_out": "Logged out",
}


def _download_chunk(host, key, secret, cs, ce):
    """Download one Export API zip for [cs, ce) UTC hours, with retries. Returns the
    raw zip bytes, or None if the window has no data (Amplitude returns 404)."""
    url = f"{host}/api/2/export?start={cs.strftime('%Y%m%dT%H')}&end={ce.strftime('%Y%m%dT%H')}"
    auth = "Basic " + base64.b64encode(f"{key}:{secret}".encode()).decode()
    last = None
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={"Authorization": auth})
            with urllib.request.urlopen(req, timeout=300) as r:
                return r.read()
        except urllib.error.HTTPError as ex:
            if ex.code == 404:
                return None                      # no events in this window
            last = ex
        except Exception as ex:
            last = ex                            # incl. "Remote end closed connection"
        time.sleep(5 * (attempt + 1))            # 5s, 10s, 15s backoff
    raise last


def download_events(host, key, secret, start, end, chunk_days=5):
    """Yield raw event dicts from the Export API for [start, end) UTC hours. Downloads
    in small time-chunks with retries — a single 30-day request grew large enough that
    Amplitude closes the connection mid-transfer, failing the whole run."""
    cur = start
    step = timedelta(days=chunk_days)
    while cur < end:
        ce = min(cur + step, end)
        blob = _download_chunk(host, key, secret, cur, ce)
        cur = ce
        if not blob:
            continue
        z = zipfile.ZipFile(io.BytesIO(blob))
        for name in z.namelist():
            for line in gzip.decompress(z.open(name).read()).decode().splitlines():
                if line.strip():
                    yield json.loads(line)


def compute_edges(events):
    """Return {(source, target): unique_users} for the listing-flow Sankey."""
    by_user = collections.defaultdict(list)
    for e in events:
        et = e.get("event_type")
        if et not in MILE_EVENT and et not in OFFRAMP:
            continue  # keep only milestone + off-ramp events
        t = e.get("event_time") or e.get("client_event_time")
        by_user[e.get("amplitude_id")].append((t, e.get("session_id"), et))

    edges = collections.Counter()
    for _uid, evs in by_user.items():
        evs.sort()
        # ordered-funnel progress: how deep did this user get?
        progress = 0
        deep_idx = None          # position in evs where the deepest milestone fired
        deep_sess = None
        for i, (_t, sid, et) in enumerate(evs):
            if progress < len(MILESTONES) and et == MILESTONES[progress][1]:
                progress += 1
                deep_idx, deep_sess = i, sid
        if progress == 0:
            continue
        # spine: one edge per advanced segment (reconciles with the funnel counts)
        for j in range(progress - 1):
            edges[(MILE_LABELS[j], MILE_LABELS[j + 1])] += 1
        # drop: deepest milestone < Published -> where did they go next (same session)?
        deepest = progress - 1
        if deepest < len(MILESTONES) - 1:
            dest = "Exited"
            for _t, sid, et in evs[deep_idx + 1:]:
                if sid != deep_sess:
                    break                       # left the session -> Exited
                if et in OFFRAMP:
                    dest = OFFRAMP[et]; break
            edges[(MILE_LABELS[deepest], dest)] += 1
    return edges


def main():
    ap = argparse.ArgumentParser(description="Listing-flow paths (Sankey) -> fact_paths via Amplitude Export API")
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument("--out", default="./data")
    ap.add_argument("--supabase", action="store_true")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    host = os.environ.get("AMPLITUDE_API_HOST", "https://amplitude.com").rstrip("/")
    end = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    start = end - timedelta(days=args.days)
    now = datetime.now(timezone.utc).isoformat()

    projects = [
        ("UAT", os.environ.get("AMPLITUDE_UAT_APP", "830558"),
         _env("AMPLITUDE_UAT_API_KEY", "AMPLITUDE_API_KEY"), _env("AMPLITUDE_UAT_SECRET_KEY", "AMPLITUDE_SECRET_KEY")),
        ("PROD", os.environ.get("AMPLITUDE_PROD_APP", "776558"),
         os.environ.get("AMPLITUDE_PROD_API_KEY"), os.environ.get("AMPLITUDE_PROD_SECRET_KEY")),
    ]
    rows = []
    for env, app, key, secret in projects:
        if not key or not secret:
            print(f"[{env}] skipped - no credentials.", file=sys.stderr); continue
        try:
            print(f"[{env}] downloading {args.days}d export (app {app}) ...", file=sys.stderr)
            events = list(download_events(host, key, secret, start, end))
        except Exception as ex:
            print(f"[{env}] export FAILED ({ex}) - skipped", file=sys.stderr); continue
        edges = compute_edges(events)
        for (src, tgt), users in sorted(edges.items(), key=lambda x: (MILE_LABELS.index(x[0][0]) if x[0][0] in MILE_LABELS else 99, -x[1])):
            rows.append({"env": env, "source": src, "target": tgt, "users": users, "updated_at": now})
        print(f"[{env}] {len(events)} events -> {len(edges)} edges", file=sys.stderr)
        for (src, tgt), users in sorted(edges.items(), key=lambda x: -x[1])[:12]:
            print(f"    {users:>3}  {src} -> {tgt}", file=sys.stderr)

    if not rows:
        sys.exit("No path rows produced.")
    with open(os.path.join(args.out, "fact_paths.csv"), "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)

    if args.supabase:
        url = os.environ.get("SUPABASE_URL", "").rstrip("/"); sk = os.environ.get("SUPABASE_SERVICE_KEY")
        if not url or not sk:
            sys.exit("ERROR: SUPABASE_URL / SUPABASE_SERVICE_KEY required for --supabase.")
        # authoritative upsert: replace this env's rows (delete then insert) so stale
        # edges from a previous window don't linger (source/target sets change).
        hdr = {"apikey": sk, "Authorization": "Bearer " + sk, "Content-Type": "application/json"}
        for env, *_ in projects:
            dreq = urllib.request.Request(url + "/rest/v1/fact_paths?env=eq." + env, method="DELETE",
                                          headers={**hdr, "Prefer": "return=minimal"})
            try:
                urllib.request.urlopen(dreq, timeout=60)
            except Exception as ex:
                print(f"  [{env}] prune failed: {ex}", file=sys.stderr)
        req = urllib.request.Request(url + "/rest/v1/fact_paths", data=json.dumps(rows).encode(), method="POST",
                                     headers={**hdr, "Prefer": "return=minimal"})
        urllib.request.urlopen(req, timeout=90)
        print("Upserted fact_paths to Supabase.", file=sys.stderr)
    print(f"Done. {len(rows)} path edges across {len(set(r['env'] for r in rows))} env(s).", file=sys.stderr)


if __name__ == "__main__":
    main()
