#!/usr/bin/env python3
"""
Dallal Sprint Dashboard - Amplitude Funnels ETL (multi-environment + platform)
==============================================================================
Queries Amplitude's Funnel Analysis REST API for each configured project
(Dallal UAT + Dallal PROD) and, for each funnel, computes conversion for
"All" platforms plus a per-platform split (web / android / ios), writing
per-step user counts into Supabase `fact_funnels` (tagged by env + platform),
which the dashboard's Funnels tab reads.

Platform split
--------------
`platform` is a custom *event* property (values: web / android / ios) present on
the product's own events but NOT on Amplitude auto-events (session_start,
user_journey.*). Because a funnel is sequential per user, filtering the *entry*
step by platform already restricts the whole funnel to that platform's users, so
later steps need not carry the property. If the entry event itself lacks
`platform` (only the Discovery `search` step), we anchor the platform funnel on
the first platform-aware step instead.

Env (add to .env / GitHub secrets):
    # UAT (falls back to AMPLITUDE_API_KEY/SECRET for backwards-compat)
    AMPLITUDE_UAT_API_KEY / AMPLITUDE_UAT_SECRET_KEY      (app 830558)
    # PROD
    AMPLITUDE_PROD_API_KEY / AMPLITUDE_PROD_SECRET_KEY    (app 776558)
    AMPLITUDE_API_HOST=https://amplitude.com   # US (default). EU: https://analytics.eu.amplitude.com
    SUPABASE_URL / SUPABASE_SERVICE_KEY

Only environments whose API key + secret are set are queried.

Usage:  python3 etl_amplitude.py --days 30 --supabase
"""
import argparse
import base64
import csv
import json
import os
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone


def _env(*names):
    for n in names:
        v = os.environ.get(n)
        if v:
            return v
    return None


# Events known to carry the custom `platform` event property. Steps whose event
# is NOT in this set are left unfiltered (they still count sequentially behind an
# already-platform-anchored earlier step).
PLATFORM_EVENTS = {
    # UAT taxonomy (fully platform-instrumented)
    "listing_started", "property_details_saved", "property_media_added",
    "listing_flow.address_review.step_completed", "property_previewed", "property_published",
    "view_details", "photo_clicked", "property_saved", "message_lister", "message_sent",
    "viewing_scheduled", "register_phone_number",
    # PROD taxonomy — funnel *entry* steps that carry the custom `platform`
    # property (web/android/ios). Anchoring each PROD funnel on its entry step
    # restricts the whole funnel to that platform's users; later PROD steps then
    # count sequentially, so they need not be listed here.
    "listing_flow.welcome.step_entered", "property_search", "sign_up_started",
}

# UAT funnels (spec step name -> real event). UAT is fully platform-instrumented.
FUNNELS_UAT = [
    {"name": "Listing Creation", "steps": [
        # PACI + Location before Property Details (matches the real wizard order).
        ("Listing Started", "listing_started"),
        ("PACI Verified", "listing_flow.paci_results.step_completed"),
        ("Location Selected", "listing_flow.address_review.step_completed"),
        ("Property Details", "property_details_saved"),
        ("Images Uploaded", "property_media_added"),
        ("Previewed", "property_previewed"),
        ("Published", "property_published"),
    ]},
    {"name": "Property Discovery", "steps": [
        ("Search", "user_journey.search.performed"),
        ("View Details", "view_details"),
        ("Gallery Viewed", "photo_clicked"),
        ("Property Saved", "property_saved"),
        ("Agent Contacted", "message_lister"),
        ("Chat Started", "message_sent"),
        ("Visit Scheduled", "viewing_scheduled"),
    ]},
    {"name": "User Registration", "steps": [
        ("Registration Started", "register_phone_number"),
        ("OTP Screen", "user_journey.login_phone_otp.screen_viewed"),
        ("OTP Verified", "otp_verified"),
        ("Login Success", "user_journey.login.success"),
    ]},
]

# PROD uses a different event taxonomy (listing_flow.* + listing_published;
# sign_up flow instead of register_phone_number). Per-platform split enabled via
# the PROD entry steps in PLATFORM_EVENTS. NOTE: PROD volume is low — Listing
# Creation has a healthy web/android/ios split, but Registration is mobile-only
# (no web signups) and Discovery is negligible, so some per-platform funnels will
# legitimately render as "no data".
# PROD funnels: mirror the team's saved Amplitude charts in the "Dallal Dashboard"
# space (chart ids 4jb7ago6 / ivwusoty / 352hod0g) — same events, step labels and
# 1-day conversion window, so the dashboard matches Amplitude exactly. "All Users"
# (no platform split), so the PROD project below uses only the "All" platform.
FUNNELS_PROD = [
    {"name": "Listing Flow", "steps": [
        ("Listing Flow Started", "listing_started"),
        ("PACI stage", "listing_paci_number"),
        ("Address Stage", "listing_address"),
        ("Describe Property Stage", "listing_describe_property"),
        ("Select Category Stage", "listing_category"),
        ("Add Media Stage", "property_media_added"),
        ("Publish Property Stage", "property_published"),
    ]},
    {"name": "Licensed broker Registration", "steps": [
        ("Verification Started", "verification_started"),
        ("Uploaded broker license", "licensed_broker_license_uploaded"),
        ("Add information to the profile", "licensed_broker_information_added"),
    ]},
    {"name": "Company Registration", "steps": [
        ("Verification Started", "verification_started"),
        ("Uploaded Commercial License", "company_license_uploaded"),
        ("Added Company Information", "company_information_added"),
    ]},
]

PROJECTS = [
    {"env": "UAT", "app": os.environ.get("AMPLITUDE_UAT_APP", "830558"),
     "key": _env("AMPLITUDE_UAT_API_KEY", "AMPLITUDE_API_KEY"),
     "secret": _env("AMPLITUDE_UAT_SECRET_KEY", "AMPLITUDE_SECRET_KEY"),
     "funnels": FUNNELS_UAT, "platforms": ["All", "web", "android", "ios"]},
    {"env": "PROD", "app": os.environ.get("AMPLITUDE_PROD_APP", "776558"),
     "key": _env("AMPLITUDE_PROD_API_KEY"),
     "secret": _env("AMPLITUDE_PROD_SECRET_KEY"),
     "funnels": FUNNELS_PROD, "platforms": ["All"]},
]

CONVERSION_SECONDS = 86400   # 1-day window, matching the saved Amplitude funnel charts


def build_events(steps, platform):
    """Return (sub_steps, event_dicts) for a funnel at a given platform.

    platform == "All": full step list, no filters.
    otherwise: anchor on the first platform-aware step (drop earlier non-aware
    steps), attach a platform filter to every platform-aware step.
    """
    if platform == "All":
        sub = steps
    else:
        idx = next((i for i, (_, e) in enumerate(steps) if e in PLATFORM_EVENTS), 0)
        sub = steps[idx:]
    events = []
    for _, e in sub:
        ev = {"event_type": e}
        if platform != "All" and e in PLATFORM_EVENTS:
            ev["filters"] = [{"subprop_type": "event", "subprop_key": "platform",
                              "subprop_op": "is", "subprop_value": [platform]}]
        events.append(ev)
    return sub, events


def query_funnel(key, secret, event_dicts, start, end):
    host = os.environ.get("AMPLITUDE_API_HOST", "https://amplitude.com").rstrip("/")
    params = [("e", json.dumps(ev)) for ev in event_dicts]
    params += [("start", start), ("end", end), ("cs", str(CONVERSION_SECONDS)), ("n", "active")]
    url = host + "/api/2/funnels?" + urllib.parse.urlencode(params)
    auth = "Basic " + base64.b64encode(f"{key}:{secret}".encode()).decode()
    req = urllib.request.Request(url, headers={"Authorization": auth})
    with urllib.request.urlopen(req, timeout=90) as r:
        payload = json.loads(r.read().decode())
    d = (payload.get("data") or [{}])[0]
    return d.get("cumulativeRaw") or d.get("cumulative") or []


def query_retention(key, secret, start, end, weeks=8):
    """New-user weekly retention curve via Amplitude's Retention API.

    Cohort = users who fired _new (first-ever event) in the window; retention =
    they came back (_active) in each later week. `rm='rolling'` is the only mode
    the Starter plan accepts (n-day / bracket / unbounded all 400). We aggregate
    across cohort start-dates into ONE overall curve, using only *complete*
    periods (Amplitude flags still-elapsing weeks `incomplete:true`) so recent
    partial cohorts don't drag the tail down. Returns [(label, users), ...] where
    users[k] = round(retention%_k * cohort_size) — a clean decaying curve the
    dashboard renders as a pseudo-funnel (Week 0 = 100%, churn = 1 - Week 1).
    """
    host = os.environ.get("AMPLITUDE_API_HOST", "https://amplitude.com").rstrip("/")
    params = [("se", json.dumps({"event_type": "_new"})),
              ("re", json.dumps({"event_type": "_active"})),
              ("rm", "rolling"), ("start", start), ("end", end), ("i", "7")]
    url = host + "/api/2/retention?" + urllib.parse.urlencode(params)
    auth = "Basic " + base64.b64encode(f"{key}:{secret}".encode()).decode()
    req = urllib.request.Request(url, headers={"Authorization": auth})
    with urllib.request.urlopen(req, timeout=90) as r:
        payload = json.loads(r.read().decode())
    series = ((payload.get("data") or {}).get("series") or [])
    vals = (series[0].get("values") if series else {}) or {}
    # period index -> [retained_sum, outof_sum] across all cohorts (complete only)
    agg = {}
    for _cohort, buckets in vals.items():
        for k, b in enumerate(buckets or []):
            if b.get("incomplete"):
                continue
            a = agg.setdefault(k, [0, 0])
            a[0] += int(b.get("count") or 0)
            a[1] += int(b.get("outof") or 0)
    if not agg:
        return []
    base = agg.get(0, [0, 0])[1] or 1          # week-0 cohort size (all new users)
    out, prev = [], base
    for k in range(0, min(weeks, max(agg)) + 1):
        ret_ct, ret_out = agg.get(k, [0, 0])
        pct = (ret_ct / ret_out) if ret_out else 0.0
        users = min(int(round(pct * base)), prev)   # retention can't rise; clamp thin-cohort noise
        out.append((f"Week {k}", users))
        prev = users
    return out


def sb_upsert(rows):
    url = os.environ.get("SUPABASE_URL", "").rstrip("/"); key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        sys.exit("ERROR: SUPABASE_URL / SUPABASE_SERVICE_KEY required for --supabase.")
    req = urllib.request.Request(
        url + "/rest/v1/fact_funnels?on_conflict=env,platform,funnel,step_index",
        data=json.dumps(rows).encode(), method="POST",
        headers={"apikey": key, "Authorization": "Bearer " + key, "Content-Type": "application/json",
                 "Prefer": "resolution=merge-duplicates,return=minimal"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.status


def main():
    ap = argparse.ArgumentParser(description="Amplitude funnels -> Supabase fact_funnels (UAT + PROD, per platform)")
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument("--out", default="./data")
    ap.add_argument("--supabase", action="store_true")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    end = datetime.now(timezone.utc).date()
    start = end - timedelta(days=args.days)
    s, e = start.strftime("%Y%m%d"), end.strftime("%Y%m%d")
    # Retention needs a longer runway than the funnel window to show real weeks.
    rs = (end - timedelta(days=max(args.days, 63))).strftime("%Y%m%d")   # >= 9 weeks
    now = datetime.now(timezone.utc).isoformat()

    rows = []
    for p in PROJECTS:
        if not p["key"] or not p["secret"]:
            print(f"[{p['env']}] skipped - no credentials set.", file=sys.stderr)
            continue
        print(f"[{p['env']}] app {p['app']} ...", file=sys.stderr)
        for f in p["funnels"]:
            for plat in p["platforms"]:
                sub, events = build_events(f["steps"], plat)
                try:
                    counts = query_funnel(p["key"], p["secret"], events, s, e)
                except Exception as ex:
                    print(f"  [{p['env']}] {f['name']} / {plat}: FAILED ({ex}) - skipped", file=sys.stderr)
                    continue
                for i, (label, _) in enumerate(sub):
                    rows.append({"env": p["env"], "platform": plat, "funnel": f["name"],
                                 "step_index": i, "step_name": label,
                                 "users": counts[i] if i < len(counts) else 0, "updated_at": now})
                got = [counts[i] if i < len(counts) else 0 for i in range(len(sub))]
                print(f"  [{p['env']}] {f['name']} / {plat}: {got}", file=sys.stderr)

        # New-user retention curve (stored as a pseudo-funnel so it renders in the
        # existing Funnels tab with no schema change). Platform "All" only.
        try:
            ret = query_retention(p["key"], p["secret"], rs, e)
            for i, (label, users) in enumerate(ret):
                rows.append({"env": p["env"], "platform": "All", "funnel": "New-User Retention",
                             "step_index": i, "step_name": label, "users": users, "updated_at": now})
            print(f"  [{p['env']}] New-User Retention: {[u for _, u in ret]}", file=sys.stderr)
        except Exception as ex:
            print(f"  [{p['env']}] retention: FAILED ({ex}) - skipped", file=sys.stderr)

    if not rows:
        sys.exit("No Amplitude projects had credentials - nothing to write.")

    with open(os.path.join(args.out, "fact_funnels.csv"), "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)

    if args.supabase:
        print("Upserting funnels to Supabase ...", file=sys.stderr)
        sb_upsert(rows)
    envs = sorted(set(r["env"] for r in rows))
    plats = sorted(set((r["env"], r["platform"]) for r in rows))
    print(f"Done. {len(rows)} funnel-step rows across {len(envs)} env(s), {len(plats)} env×platform view(s).", file=sys.stderr)


if __name__ == "__main__":
    main()
