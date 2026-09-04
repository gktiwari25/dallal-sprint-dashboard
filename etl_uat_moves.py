#!/usr/bin/env python3
"""
etl_uat_moves.py — log EVERY "moved into Ready for UAT" event, so we can track how
many stories each developer SENDS to UAT per day — regardless of where the ticket
ends up.

The Delivery tab's original "Ready for UAT" list is current-state only: it reads
fact_workitems.section, so a ticket that was moved to Ready for UAT and then closed
by QA disappears from the count. For throughput ("who sent how many, and when") we
need the EVENTS, not the current state.

Each move shows up in the task's activity log as a `section_changed` story whose
text reads  …moved this task … to "Ready for UAT" in <project>.  That story carries
the actor (created_by.name — the person who moved the card) and created_at (when).
We scan the stories of every sprinted ticket (done OR not) and upsert one row per
move into `fact_uat_moves`:
  - task_gid, moved_at   = natural key (a ticket bounced back and re-sent = 2 rows)
  - moved_by             = who moved the card (attribution is by mover, not assignee)
  - name, sprint, assignee = ticket context (assignee = current assignee, for display)

Rows are NEVER pruned: a move is a permanent historical fact even after the ticket
closes. Re-running is idempotent (upsert on task_gid+moved_at). Excluded movers
(PMs/leads) are kept in the table and filtered in the browser (config.js
EXCLUDE_ASSIGNEES), so the exclusion list is adjustable without a re-run.

Scope: by default only RECENT sprints (top 3) are rescanned each hour — older
sprints' events are already captured and never change. `--full` (or
MOVES_SPRINT_FLOOR) rescans everything from a fixed sprint floor (one-time backfill).

.env: ASANA_PAT, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
Run:  python3 etl_uat_moves.py           # hourly: recent sprints
      python3 etl_uat_moves.py --full     # backfill from MOVES_SPRINT_FLOOR (default 10)
"""
import os
import re
import sys
import json
import urllib.request
import urllib.error

ASANA = "https://app.asana.com/api/1.0"
UAT_SECTION = "Ready for UAT"
# The move-in story text is:  …moved this task from "X" to "Ready for UAT" in <proj>
# (also "…added to \"Ready for UAT\" …"). Both contain  to "Ready for UAT".
MOVE_RE = re.compile(r'to\s+"' + re.escape(UAT_SECTION) + r'"', re.I)
STORY_FIELDS = "created_at,resource_subtype,created_by.name,text"
RECENT_SPRINTS = int(os.environ.get("MOVES_RECENT_SPRINTS") or "3")
SPRINT_FLOOR = int(os.environ.get("MOVES_SPRINT_FLOOR") or "10")


def env(n):
    v = os.environ.get(n)
    if not v:
        sys.exit(f"Missing env var: {n}")
    return v


def sb_get(path):
    key = env("SUPABASE_SERVICE_ROLE_KEY")
    h = {"apikey": key, "Authorization": "Bearer " + key}
    url = env("SUPABASE_URL").rstrip("/") + "/rest/v1/" + path
    return json.loads(urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=60).read())


def uat_moves(task_gid):
    """Every move INTO 'Ready for UAT' for a task: [{at, by}] (may be empty)."""
    h = {"Authorization": "Bearer " + env("ASANA_PAT")}
    out, offset = [], None
    while True:
        q = f"/tasks/{task_gid}/stories?opt_fields={STORY_FIELDS}&limit=100"
        if offset:
            q += "&offset=" + offset
        body = json.loads(urllib.request.urlopen(urllib.request.Request(ASANA + q, headers=h), timeout=60).read())
        for s in body.get("data", []):
            if s.get("resource_subtype") != "section_changed":
                continue
            if not MOVE_RE.search(s.get("text") or ""):
                continue
            out.append({"at": s.get("created_at"), "by": (s.get("created_by") or {}).get("name")})
        offset = (body.get("next_page") or {}).get("offset")
        if not offset:
            break
    return out


def upsert(rows):
    if not rows:
        print("No UAT moves to record.")
        return
    key = env("SUPABASE_SERVICE_ROLE_KEY")
    h = {"apikey": key, "Authorization": "Bearer " + key, "Content-Type": "application/json",
         "Prefer": "resolution=merge-duplicates,return=minimal"}
    url = env("SUPABASE_URL").rstrip("/") + "/rest/v1/fact_uat_moves?on_conflict=task_gid,moved_at"
    for i in range(0, len(rows), 200):
        chunk = rows[i:i + 200]
        r = urllib.request.urlopen(urllib.request.Request(url, data=json.dumps(chunk).encode(), headers=h, method="POST"), timeout=90)
        print(f"  upserted {len(chunk)} move rows (HTTP {r.status})")


def main():
    full = "--full" in sys.argv
    items = sb_get("fact_workitems?select=task_gid,name,sprint,assignee&sprint=not.is.null")
    sprinted = [r for r in items if str(r.get("sprint") or "").isdigit()]
    if not sprinted:
        print("No sprinted tickets found.")
        return
    if full:
        floor = SPRINT_FLOOR
        scope = f"full backfill (sprint >= {floor})"
    else:
        top = max(int(r["sprint"]) for r in sprinted)
        floor = top - (RECENT_SPRINTS - 1)
        scope = f"recent sprints {floor}-{top}"
    cands = [r for r in sprinted if int(r["sprint"]) >= floor]
    print(f"Scanning {len(cands)} sprinted tickets for UAT moves ({scope})...")
    rows, tickets_with_moves = [], 0
    for r in cands:
        moves = uat_moves(r["task_gid"])
        if not moves:
            continue
        tickets_with_moves += 1
        for m in moves:
            if not m["at"]:
                continue
            rows.append({
                "task_gid": r["task_gid"], "moved_at": m["at"], "moved_by": m["by"],
                "name": r.get("name"), "sprint": int(r["sprint"]), "assignee": r.get("assignee"),
                "section": UAT_SECTION,
            })
    print(f"{len(rows)} move events across {tickets_with_moves} tickets.")
    upsert(rows)
    print("Done.")


if __name__ == "__main__":
    main()
