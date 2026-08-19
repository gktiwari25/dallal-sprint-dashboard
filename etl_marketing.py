#!/usr/bin/env python3
"""Marketing re-engagement dataset: users who ABANDONED listing creation (fired
listing_started but never property_published), with their drop step, segments and
contact info — from the Amplitude Export API. Powers the Marketing tab where the
team can view, filter, segment and message drop-off users, and measure recovery.

Stored in Supabase `fact_abandoned_listers`. UAT is the primary test env.
"""
import argparse
import csv
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

from etl_paths import download_events   # chunked + retried Export API reader

# Ordered listing steps (current flat taxonomy). Index = how deep the user got.
STEPS = [
    ("Started", "listing_started"), ("PACI", "listing_paci_number"),
    ("Address", "listing_address"), ("Category", "listing_category"),
    ("Property Details", "property_details_saved"), ("Pricing", "price_saved"),
    ("Photos", "property_media_added"), ("Published", "property_published"),
]
STEP_IX = {ev: i for i, (_, ev) in enumerate(STEPS)}
PUBLISHED_IX = len(STEPS) - 1


def _first(d, *keys):
    for k in keys:
        v = (d or {}).get(k)
        if v not in (None, "", "EMPTY"):
            return v
    return ""


def build_abandoned(events, env, now):
    """Return one row per user who started a listing but never published."""
    users = {}
    for e in events:
        et = e.get("event_type"); ix = STEP_IX.get(et)
        aid = e.get("amplitude_id")
        if aid is None:
            continue
        u = users.setdefault(aid, {"deep": -1, "started": False, "props": {}, "last": "", "first": ""})
        t = str(e.get("event_time") or e.get("client_event_time") or "")
        if ix is None:
            continue
        if ix > u["deep"]:
            u["deep"] = ix
        if et == "listing_started":
            u["started"] = True
            if not u["first"]:
                u["first"] = t
        u["last"] = max(u["last"], t)
        # Capture identity + segments; prefer the listing_started event's context.
        if not u["props"] or et == "listing_started":
            ep = e.get("event_properties") or {}; up = e.get("user_properties") or {}
            u["props"] = {
                "user_id": e.get("user_id") or "",
                "name": _first(up, "name"),
                "email": _first(up, "email"),
                "phone": _first(up, "phone"),
                "city": e.get("city") or "",
                "region": e.get("region") or "",
                "country": e.get("country") or "",
                "language": e.get("language") or "",
                "platform": e.get("platform") or ep.get("platform") or "",
                "source": _first(ep, "source", "listing_source") or _first(up, "initial_utm_source") or "direct",
                "user_type": _first(up, "userType"),
            }
    rows = []
    for aid, u in users.items():
        if not u["started"] or u["deep"] >= PUBLISHED_IX:
            continue   # never started, or actually published (not abandoned)
        p = u["props"]
        rows.append({
            "env": env, "amplitude_id": str(aid),
            "user_id": p.get("user_id", ""), "name": p.get("name", ""),
            "email": p.get("email", ""), "phone": p.get("phone", ""),
            "city": p.get("city", ""), "region": p.get("region", ""),
            "country": p.get("country", ""), "language": p.get("language", ""),
            "platform": p.get("platform", ""), "source": p.get("source", ""),
            "user_type": p.get("user_type", ""),
            "drop_step": STEPS[u["deep"]][0] if u["deep"] >= 0 else "Started",
            "drop_step_index": u["deep"] if u["deep"] >= 0 else 0,
            "started_at": (u["first"] or "")[:19], "last_seen": (u["last"] or "")[:19],
            "updated_at": now,
        })
    return rows


def main():
    ap = argparse.ArgumentParser(description="Abandoned listing-creation users -> fact_abandoned_listers")
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
        ("UAT", os.environ.get("AMPLITUDE_UAT_API_KEY") or os.environ.get("AMPLITUDE_API_KEY"),
         os.environ.get("AMPLITUDE_UAT_SECRET_KEY") or os.environ.get("AMPLITUDE_SECRET_KEY")),
        ("PROD", os.environ.get("AMPLITUDE_PROD_API_KEY"), os.environ.get("AMPLITUDE_PROD_SECRET_KEY")),
    ]
    rows = []
    for env, k, s in projects:
        if not k or not s:
            print(f"[{env}] skipped - no credentials.", file=sys.stderr); continue
        try:
            print(f"[{env}] downloading {args.days}d export ...", file=sys.stderr)
            evs = list(download_events(host, k, s, start, end))
        except Exception as ex:
            print(f"[{env}] export FAILED ({ex}) - skipped", file=sys.stderr); continue
        r = build_abandoned(evs, env, now)
        rows.extend(r)
        print(f"[{env}] {len(evs)} events -> {len(r)} abandoned listers", file=sys.stderr)

    with open(os.path.join(args.out, "fact_abandoned_listers.csv"), "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()) if rows else ["env"]); w.writeheader(); w.writerows(rows)

    if args.supabase:
        url = os.environ.get("SUPABASE_URL", "").rstrip("/"); sk = os.environ.get("SUPABASE_SERVICE_KEY")
        if not url or not sk:
            sys.exit("ERROR: SUPABASE_URL / SUPABASE_SERVICE_KEY required for --supabase.")
        hdr = {"apikey": sk, "Authorization": "Bearer " + sk, "Content-Type": "application/json"}
        # Authoritative: delete all then insert (the abandoned set shrinks as users
        # convert or their events age out; upsert alone never deletes).
        try:
            urllib.request.urlopen(urllib.request.Request(
                url + "/rest/v1/fact_abandoned_listers?amplitude_id=not.is.null", method="DELETE",
                headers={**hdr, "Prefer": "return=minimal"}), timeout=60)
        except Exception as ex:
            print(f"  prune failed: {ex}", file=sys.stderr)
        if rows:
            req = urllib.request.Request(url + "/rest/v1/fact_abandoned_listers", data=json.dumps(rows).encode(),
                                         method="POST", headers={**hdr, "Prefer": "return=minimal"})
            urllib.request.urlopen(req, timeout=90)
        print(f"Upserted {len(rows)} abandoned listers to Supabase.", file=sys.stderr)
    print(f"Done. {len(rows)} abandoned listers across {len(set(r['env'] for r in rows))} env(s).", file=sys.stderr)


if __name__ == "__main__":
    main()
