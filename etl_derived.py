#!/usr/bin/env python3
"""
etl_derived.py — twice-daily (12h) local sync of the DERIVED Delivery fields,
so we can retire the failing/billing-blocked GitHub Actions entirely.

Computes, for the Dallal project, the fields the real-time webhook deliberately
does NOT own:
  - story_points  (SUPERSEDE rule: subtask sum if any subtask is pointed, else the
                   parent's own — NOT add)
  - is_delivered  (completed OR section is UAT-Passed/Released/Ready-for-Production
                   OR ALL subtasks completed)  -- also catches subtask-driven
                   delivery that the per-task webhook can't see
  - dim_sprint    (committed/delivered SP, inferred start/end, item count)
  - fact_burndown (today's remaining-SP snapshot per sprint)

Story points change at planning, so 12h is plenty. State (section/completion) is
already real-time via the Edge Function + 60s fallback.

.env: ASANA_PAT, ASANA_PROJECT_GID (default), SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
Run:  python3 etl_derived.py            # compute + upsert
      python3 etl_derived.py --dry-run  # print sprint rollups, write nothing
"""
import argparse
import os
import re
import sys
from datetime import datetime, timezone

import requests

A = "https://app.asana.com/api/1.0"
PROJECT = os.environ.get("ASANA_PROJECT_GID", "1214388950902741")
CF_SP = "1216141249950274"      # Story Points (number)
CF_SPRINT = "1214486363833795"  # Sprint (text)
SECTION_DONE = re.compile(r"UAT Passed|Released|Ready for Production", re.I)
FIELDS = ("name,completed,completed_at,num_subtasks,"
          "memberships.section.name,memberships.project.gid,"
          "custom_fields.gid,custom_fields.number_value,custom_fields.text_value")


def env(n, required=True, default=None):
    v = os.environ.get(n, default)
    if required and not v:
        sys.exit(f"Missing env var: {n}")
    return v


def AH():
    return {"Authorization": "Bearer " + env("ASANA_PAT")}


def paginate(path, params):
    out, offset = [], None
    while True:
        p = dict(params, limit=100)
        if offset:
            p["offset"] = offset
        r = requests.get(A + path, headers=AH(), params=p, timeout=90)
        if r.status_code != 200:
            sys.exit(f"Asana {r.status_code}: {r.text[:200]}")
        b = r.json()
        out += b.get("data", [])
        offset = (b.get("next_page") or {}).get("offset")
        if not offset:
            return out


def cf(task):
    return {f.get("gid"): f for f in task.get("custom_fields", [])}


def section_of(t):
    for m in t.get("memberships", []):
        p = (m.get("project") or {}).get("gid")
        if (m.get("section") or {}).get("name") and (p is None or p == PROJECT):
            return m["section"]["name"]
    return None


def sprint_of(t):
    f = cf(t).get(CF_SPRINT)
    v = f.get("text_value") if f else None
    m = re.search(r"(\d+)", str(v)) if v else None
    return int(m.group(1)) if m else None


def compute():
    tasks = paginate(f"/projects/{PROJECT}/tasks", {"opt_fields": FIELDS})
    rows = []
    for t in tasks:
        idx = cf(t)
        section = section_of(t)
        completed = bool(t.get("completed"))
        delivered = completed or bool(section and SECTION_DONE.search(section))
        spf = idx.get(CF_SP)
        sp = spf.get("number_value") if spf else None
        if (t.get("num_subtasks") or 0) > 0:
            subs = requests.get(f"{A}/tasks/{t['gid']}/subtasks",
                                headers=AH(),
                                params={"opt_fields": "completed,custom_fields.gid,custom_fields.number_value"},
                                timeout=60).json().get("data", [])
            if subs:
                ssum, any_sp, all_done = 0.0, False, True
                for s in subs:
                    for f in s.get("custom_fields", []):
                        if f.get("gid") == CF_SP and f.get("number_value") is not None:
                            ssum += f["number_value"]; any_sp = True
                    if not s.get("completed"):
                        all_done = False
                if any_sp:
                    sp = round(ssum, 2)          # supersede
                if all_done:
                    delivered = True
        rows.append({"task_gid": t["gid"], "sprint": sprint_of(t),
                     "story_points": sp, "is_delivered": 1 if delivered else 0,
                     "completed_at": t.get("completed_at")})
    return rows


def build_dims(rows):
    by = {}
    for w in rows:
        s = w["sprint"]
        if s is None:
            continue
        d = by.setdefault(s, {"items": 0, "committed": 0.0, "delivered": 0.0, "remaining": 0.0, "min": None, "max": None})
        d["items"] += 1
        sp = w["story_points"] or 0
        d["committed"] += sp
        if w["is_delivered"]:
            d["delivered"] += sp
        else:
            d["remaining"] += sp
        if w["completed_at"]:
            day = str(w["completed_at"])[:10]
            d["min"] = min(d["min"], day) if d["min"] else day
            d["max"] = max(d["max"], day) if d["max"] else day
    today = datetime.now(timezone.utc).date().isoformat()
    dim, burn = [], []
    for s in sorted(by):
        d = by[s]
        dim.append({"sprint": s, "sprint_label": f"Sprint {s}", "inferred_start": d["min"],
                    "inferred_end": d["max"], "items": d["items"],
                    "committed_sp": round(d["committed"], 1), "delivered_sp": round(d["delivered"], 1)})
        burn.append({"snapshot_date": today, "sprint": s, "remaining_sp": round(d["remaining"], 1)})
    return dim, burn


def upsert(table, rows, conflict):
    if not rows:
        return
    url = env("SUPABASE_URL").rstrip("/") + f"/rest/v1/{table}?on_conflict={conflict}"
    key = env("SUPABASE_SERVICE_ROLE_KEY")
    h = {"apikey": key, "Authorization": "Bearer " + key, "Content-Type": "application/json",
         "Prefer": "resolution=merge-duplicates,return=minimal"}
    for i in range(0, len(rows), 500):
        r = requests.post(url, headers=h, json=rows[i:i + 500], timeout=90)
        print(f"  {table}[{i}]: {r.status_code}" + ("" if r.status_code in (200, 201, 204) else " " + r.text[:200]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    rows = compute()
    dim, burn = build_dims(rows)
    print(f"tasks={len(rows)} sprints={len(dim)}")
    if args.dry_run:
        for d in dim:
            print(f"  Sprint {d['sprint']}: committed={d['committed_sp']} delivered={d['delivered_sp']} items={d['items']}")
        print("(no writes)")
        return
    upsert("fact_workitems", [{"task_gid": r["task_gid"], "story_points": r["story_points"], "is_delivered": r["is_delivered"]} for r in rows], "task_gid")
    upsert("dim_sprint", dim, "sprint")
    upsert("fact_burndown", burn, "snapshot_date,sprint")
    print(f"Done {datetime.now(timezone.utc).isoformat(timespec='seconds')}")


if __name__ == "__main__":
    main()
