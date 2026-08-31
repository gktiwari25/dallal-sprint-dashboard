#!/usr/bin/env python3
"""
etl_asana.py — keep the Delivery dashboard's work-item STATE fresh (near-live).

Reads the Dallal Product Development Asana project and upserts each task's
volatile state into Supabase `fact_workitems` — section, status, completion,
priority, found-in, etc. It deliberately does NOT write story_points / burndown
so it can't diverge from the existing (cloud) sync: PostgREST partial upsert
updates only the columns in the payload, leaving SP and everything else intact.

Purpose: the completion/section of a task changes the moment someone updates it
in Asana; running this every ~15 min (launchd) makes the dashboard reflect that
quickly, instead of waiting on the slower periodic sync.

.env:
  ASANA_PAT=<Asana personal access token>
  ASANA_PROJECT_GID=1214388950902741   (default: Dallal Product Development)
  SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY   (shared)
Run:
  python3 etl_asana.py --dry-run   # fetch + compare to Supabase, write nothing
  python3 etl_asana.py             # upsert state into fact_workitems
"""

import argparse
import os
import re
import sys
from datetime import datetime, timedelta, timezone

import requests

ASANA_BASE = "https://app.asana.com/api/1.0"
DEFAULT_PROJECT = "1214388950902741"
DELIVERED_RE = re.compile(r"ready for uat|qa on uat|in uat|uat passed|ready for production|released", re.I)
OPT_FIELDS = ",".join([
    "name", "completed", "completed_at", "created_at", "modified_at",
    "memberships.section.name", "memberships.project.gid",
    "assignee.name", "custom_fields.name", "custom_fields.display_value",
])


def env(name, required=True, default=None):
    v = os.environ.get(name, default)
    if required and not v:
        sys.exit(f"Missing required env var: {name}")
    return v


def num(v):
    try:
        return float(str(v).replace(",", "").strip())
    except (ValueError, TypeError, AttributeError):
        return None


def fetch_tasks(token, project, modified_since=None):
    """Page through project tasks with the fields we need; optionally only those
    modified since a timestamp (cheap incremental polling)."""
    headers = {"Authorization": f"Bearer {token}"}
    tasks, offset = [], None
    while True:
        params = {"project": project, "opt_fields": OPT_FIELDS, "limit": 100}
        if modified_since:
            params["modified_since"] = modified_since
        if offset:
            params["offset"] = offset
        r = requests.get(ASANA_BASE + "/tasks", headers=headers, params=params, timeout=90)
        if r.status_code != 200:
            sys.exit(f"Asana error {r.status_code}: {r.text[:300]}")
        body = r.json()
        tasks.extend(body.get("data", []))
        offset = (body.get("next_page") or {}).get("offset")
        if not offset:
            break
    return tasks


def section_for(task, project):
    # Return the section name EXACTLY as Asana/the existing sync store it (some
    # names carry leading/trailing spaces, e.g. " Released", "Reopen ") — stripping
    # them would make this sync and the cloud sync overwrite each other every run.
    for m in task.get("memberships", []):
        if (m.get("project") or {}).get("gid") == project and m.get("section"):
            return m["section"].get("name") or ""
    ms = task.get("memberships") or []
    return ((ms[0].get("section") or {}).get("name") or "") if ms else ""


def cf(task):
    out = {}
    for c in task.get("custom_fields", []):
        out[(c.get("name") or "").strip()] = c.get("display_value")
    return out


def to_row(task, project):
    c = cf(task)
    section = section_for(task, project)
    completed = bool(task.get("completed"))
    sprint_raw = c.get("Sprint")
    sprint = None
    if sprint_raw:
        mnum = re.search(r"\d+", str(sprint_raw))
        sprint = int(mnum.group()) if mnum else None
    name = task.get("name") or ""
    is_bug = 1 if (c.get("Type") == "Bug" or "BUG" in name.upper()) else 0
    is_delivered = 1 if (DELIVERED_RE.search(section) or completed) else 0
    # NOTE: story_points intentionally omitted — leave it to the existing sync.
    return {
        "task_gid": task["gid"],
        "name": name,
        "sprint": sprint,
        "section": section,
        "status": c.get("Status"),
        "type": c.get("Type"),
        "priority": c.get("Priority"),
        "found_in": c.get("Found In"),
        "severity": c.get("Severity"),
        "layer": c.get("Layer"),
        "repo": c.get("Repo"),
        "root_cause": c.get("Root Cause"),
        "release": c.get("Release"),
        "reopened_count": num(c.get("Reopened Count")) or 0,
        "efforts_hours": num(c.get("Efforts (Hours) ")),
        "assignee": (task.get("assignee") or {}).get("name"),
        "is_bug": is_bug,
        "is_completed": 1 if completed else 0,
        "is_delivered": is_delivered,
        "completed_at": task.get("completed_at"),
        "created_at": task.get("created_at"),
        "modified_at": task.get("modified_at"),
    }


def sb_current(cols):
    base = env("SUPABASE_URL").rstrip("/") + "/rest/v1/fact_workitems"
    key = env("SUPABASE_SERVICE_ROLE_KEY")
    h = {"apikey": key, "Authorization": "Bearer " + key}
    r = requests.get(base + f"?select={cols}&limit=5000", headers=h, timeout=90)
    r.raise_for_status()
    return {x["task_gid"]: x for x in r.json()}


def prune_deleted(token, live_gids):
    """Remove fact_workitems rows whose Asana task no longer exists (deleted).
    ONLY call on a FULL sync (live_gids must be the complete current project set).
    Candidates (rows not in live_gids — could be deleted tasks OR subtasks that
    aren't direct project members) are each verified via get_task; only real 404s
    are removed, so we never delete a live subtask by mistake."""
    base = env("SUPABASE_URL").rstrip("/") + "/rest/v1/fact_workitems"
    key = env("SUPABASE_SERVICE_ROLE_KEY")
    sh = {"apikey": key, "Authorization": "Bearer " + key}
    ah = {"Authorization": "Bearer " + token}
    gids, frm = [], 0
    while True:
        r = requests.get(base, headers=sh, params={"select": "task_gid", "order": "task_gid.asc",
                         "offset": frm, "limit": 1000}, timeout=90).json()
        gids += [x["task_gid"] for x in r]
        if len(r) < 1000:
            break
        frm += 1000
    cand = [g for g in gids if g not in live_gids]
    deleted = [g for g in cand
               if requests.get(ASANA_BASE + f"/tasks/{g}", headers=ah, timeout=30).status_code == 404]
    for i in range(0, len(deleted), 50):
        ch = deleted[i:i + 50]
        requests.delete(base, headers={**sh, "Prefer": "return=minimal"},
                        params={"task_gid": "in.(" + ",".join(ch) + ")"}, timeout=60)
    print(f"Prune: {len(cand)} candidates checked, {len(deleted)} deleted (removed from Asana).")
    return deleted


def upsert(rows):
    base = env("SUPABASE_URL").rstrip("/") + "/rest/v1/fact_workitems"
    key = env("SUPABASE_SERVICE_ROLE_KEY")
    h = {"apikey": key, "Authorization": "Bearer " + key,
         "Content-Type": "application/json",
         "Prefer": "resolution=merge-duplicates,return=minimal"}
    for i in range(0, len(rows), 500):
        chunk = rows[i:i + 500]
        resp = requests.post(base + "?on_conflict=task_gid", headers=h, json=chunk, timeout=90)
        if resp.status_code not in (200, 201, 204):
            print(f"  upsert failed [{i}]: {resp.status_code} {resp.text[:300]}")
        else:
            print(f"  upserted {len(chunk)} rows")


# ---------------------------------------------------------------------------
# Shared Supabase push used by the sibling ETLs (etl_github / etl_amplitude /
# etl_marketing / etl_paths import `etl_asana.SB_CONFLICT` + `write_supabase`).
# Each script extends SB_CONFLICT with its own table->conflict-key at runtime.
# ---------------------------------------------------------------------------
SB_CONFLICT = {
    "fact_workitems": "task_gid", "dim_sprint": "sprint", "dim_date": "date",
    "fact_flow": "task_gid", "fact_burndown": "snapshot_date,sprint", "load_log": None,
}


def write_supabase(tables):
    """Idempotent upsert of {table: rows} via PostgREST; "" -> NULL, chunked 500."""
    url = env("SUPABASE_URL").rstrip("/") + "/rest/v1/"
    key = os.environ.get("SUPABASE_SERVICE_KEY") or env("SUPABASE_SERVICE_ROLE_KEY")
    for name, rows in tables.items():
        if not rows:
            continue
        clean = [{k: (None if v == "" else v) for k, v in r.items()} for r in rows]
        conflict = SB_CONFLICT.get(name)
        path = f"{name}?on_conflict={conflict}" if conflict else name
        headers = {"apikey": key, "Authorization": "Bearer " + key, "Content-Type": "application/json",
                   "Prefer": "resolution=merge-duplicates,return=minimal" if conflict else "return=minimal"}
        for i in range(0, len(clean), 500):
            r = requests.post(url + path, headers=headers, json=clean[i:i + 500], timeout=90)
            if r.status_code not in (200, 201, 204):
                print(f"  supabase {name}: {r.status_code} {r.text[:200]}", file=sys.stderr)
        print(f"  supabase: {name} <- {len(clean)} rows", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="compare to Supabase, write nothing")
    ap.add_argument("--full", action="store_true", help="fetch all tasks, ignore the incremental marker")
    args = ap.parse_args()
    token = env("ASANA_PAT")
    project = env("ASANA_PROJECT_GID", required=False, default=DEFAULT_PROJECT)

    marker = os.path.expanduser("~/dallal-sprint-dashboard/logs/.asana_last_sync")
    run_start = datetime.now(timezone.utc)
    modified_since = None
    if not args.full and not args.dry_run and os.path.exists(marker):
        try:
            last = datetime.fromisoformat(open(marker).read().strip())
            modified_since = (last - timedelta(minutes=10)).isoformat()
        except Exception:
            modified_since = None

    tasks = fetch_tasks(token, project, modified_since)
    rows = [to_row(t, project) for t in tasks]
    print(f"Asana: {len(rows)} tasks fetched from project {project}"
          + (f" (incremental since {modified_since})" if modified_since else " (full)"))

    if args.dry_run:
        cur = sb_current("task_gid,section,status,is_completed,completed_at")
        counts = {"NEW": 0, "section": 0, "status": 0, "is_completed": 0}
        samples = []
        for r in rows:
            c = cur.get(r["task_gid"])
            if not c:
                counts["NEW"] += 1
                if len(samples) < 25: samples.append(("NEW", r["name"][:55], "", ""))
                continue
            for f in ("section", "status"):
                if str(c.get(f) or "") != str(r.get(f) or ""):
                    counts[f] += 1
                    if len(samples) < 25: samples.append((f, r["name"][:55], c.get(f), r.get(f)))
            cc = 1 if (c.get("is_completed") in (True, 1, "1")) else 0
            if cc != r["is_completed"]:
                counts["is_completed"] += 1
                if len(samples) < 25: samples.append(("is_completed", r["name"][:55], cc, r["is_completed"]))
        total = sum(counts.values())
        print(f"DRY-RUN: {total} field-diffs vs Supabase — {counts}. Sample:")
        for f, n, a, b in samples:
            print(f"  [{f}] {n!r}: {a!r} -> {b!r}")
        print("(no writes)")
        return

    # Write ONLY completion-critical fields that match the cloud sync's format
    # exactly (section kept raw, no status). PostgREST partial upsert leaves every
    # other column — story points, burndown inputs, status, etc. — untouched.
    FIELDS = ["task_gid", "section", "is_completed", "completed_at", "modified_at"]
    payload = [{k: r.get(k) for k in FIELDS} for r in rows]
    upsert(payload)
    # On a FULL sync we have the complete live task set, so prune rows for tasks that
    # were deleted in Asana (otherwise they linger and open to "This task is deleted").
    if args.full and not modified_since:
        prune_deleted(token, {t["gid"] for t in tasks})
    try:
        open(marker, "w").write(run_start.isoformat())
    except Exception:
        pass
    print(f"Done at {datetime.now(timezone.utc).isoformat(timespec='seconds')}. {len(payload)} rows (state only).")


if __name__ == "__main__":
    main()
