#!/usr/bin/env python3
"""
etl_reconcile.py — remove tasks from the dashboard that no longer exist in the
Asana project (deleted, or moved out of the project).

etl_asana.py is INCREMENTAL (it only fetches tasks modified since the last run),
so it never learns about deletions — a deleted/moved task lingers in fact_workitems
forever and keeps showing on the dashboard. This job fixes that: it lists the LIVE
task GIDs currently in the project (Asana excludes deleted tasks from the project
task list) and deletes any fact_workitems row (and its derived rows) whose GID is
no longer live.

Safety: if the live list comes back suspiciously small (API hiccup), it aborts
rather than mass-deleting.

.env: ASANA_PAT, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
Run:  python3 etl_reconcile.py
"""
import os
import sys
import json
import urllib.request
import urllib.error

import asana_util

ASANA = "https://app.asana.com/api/1.0"
PROJECT_GID = os.environ.get("ASANA_PROJECT_GID", "1214388950902741")
# Tables keyed by task_gid that must be pruned alongside fact_workitems.
DERIVED = ["fact_uat_moves", "fact_reopens", "fact_cycle_time", "fact_due_changes"]
# Refuse to prune if the live project list is smaller than this (guards against an
# API glitch wiping the dashboard). The project has ~1300+ tasks.
MIN_LIVE = 200


def env(n):
    v = os.environ.get(n)
    if not v:
        sys.exit(f"Missing env var: {n}")
    return v


def live_task_gids():
    pat = env("ASANA_PAT")
    gids, offset = set(), None
    while True:
        url = f"{ASANA}/projects/{PROJECT_GID}/tasks?opt_fields=gid&limit=100"
        if offset:
            url += "&offset=" + offset
        b = asana_util.get_json(url, pat)
        gids.update(t["gid"] for t in b.get("data", []))
        offset = (b.get("next_page") or {}).get("offset")
        if not offset:
            break
    return gids


def sb_all_gids():
    key = env("SUPABASE_SERVICE_ROLE_KEY")
    base = env("SUPABASE_URL").rstrip("/") + "/rest/v1/fact_workitems?select=task_gid"
    out, frm = [], 0
    while True:
        h = {"apikey": key, "Authorization": "Bearer " + key, "Range": f"{frm}-{frm+999}"}
        part = json.loads(urllib.request.urlopen(urllib.request.Request(base, headers=h), timeout=60).read())
        out += [r["task_gid"] for r in part]
        if len(part) < 1000:
            break
        frm += 1000
    return out


def delete(table, gids):
    key = env("SUPABASE_SERVICE_ROLE_KEY")
    h = {"apikey": key, "Authorization": "Bearer " + key, "Prefer": "return=minimal"}
    base = env("SUPABASE_URL").rstrip("/") + "/rest/v1/" + table
    for i in range(0, len(gids), 50):
        ch = gids[i:i + 50]
        u = base + "?task_gid=in.(" + ",".join(ch) + ")"
        try:
            urllib.request.urlopen(urllib.request.Request(u, headers=h, method="DELETE"), timeout=60)
        except urllib.error.HTTPError as e:
            print(f"  {table}: ERR {e.code} {e.read().decode()[:80]}")


def main():
    live = live_task_gids()
    print(f"Live tasks in Asana project {PROJECT_GID}: {len(live)}")
    if len(live) < MIN_LIVE:
        sys.exit(f"Refusing to prune — live list only {len(live)} (< {MIN_LIVE}); likely an API hiccup.")
    sb = sb_all_gids()
    stale = [g for g in sb if g not in live]
    print(f"fact_workitems rows: {len(sb)} | stale (deleted/moved-out): {len(stale)}")
    if not stale:
        print("Nothing to prune.")
        return
    for t in ["fact_workitems"] + DERIVED:
        delete(t, stale)
        print(f"  pruned {len(stale)} from {t}")
    print("Done.")


if __name__ == "__main__":
    main()
