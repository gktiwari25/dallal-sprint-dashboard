#!/usr/bin/env python3
"""
etl_reopens.py — compute an ACCURATE reopen count per ticket from the Asana
activity log, instead of trusting the hand-maintained "Reopened Count" custom
field (which is stale/wrong for most tickets).

A "reopen" = the ticket was moved back INTO the "Reopen" board column. Each such
`section_changed` story (…moved this task … to "Reopen" …) is one reopen. We also
read the manual "Reopened Count" field (mirrored into fact_workitems.reopened_count)
and take the GREATER of the two, so:
  - a stale manual field can't hide real reopens (board history wins), and
  - a real manual count isn't lost if the board move predates our story window.

Per sprinted ticket we upsert into `fact_reopens`:
  - reopen_moves     = # times moved into "Reopen" (from stories)
  - reopen_field     = the manual "Reopened Count" value
  - reopen_count     = max(reopen_moves, reopen_field)   <- what the dashboard uses
  - last_reopened_at = timestamp of the latest move into "Reopen" (or null)
Only tickets with reopen_count > 0 are kept; tickets that fall to 0 are pruned.

Scope mirrors etl_uat_moves: recent 3 sprints by default (older counts don't
change), `--full` (or MOVES_SPRINT_FLOOR) backfills from a fixed floor.

.env: ASANA_PAT, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
Run:  python3 etl_reopens.py            # hourly: recent sprints
      python3 etl_reopens.py --full      # backfill from MOVES_SPRINT_FLOOR (default 10)
"""
import os
import re
import sys
import json
import urllib.request

ASANA = "https://app.asana.com/api/1.0"
REOPEN_SECTION = "Reopen"
# Board section names carry stray spaces ("Reopen "); match  to "Reopen" tolerant of
# trailing whitespace before the closing quote.
MOVE_RE = re.compile(r'to\s+"' + re.escape(REOPEN_SECTION) + r'\s*"', re.I)
STORY_FIELDS = "created_at,resource_subtype,text"
RECENT_SPRINTS = int(os.environ.get("MOVES_RECENT_SPRINTS") or "3")
SPRINT_FLOOR = int(os.environ.get("MOVES_SPRINT_FLOOR") or "10")


def env(n):
    v = os.environ.get(n)
    if not v:
        sys.exit(f"Missing env var: {n}")
    return v


def num(v):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return 0


def sb_get(path):
    key = env("SUPABASE_SERVICE_ROLE_KEY")
    h = {"apikey": key, "Authorization": "Bearer " + key}
    url = env("SUPABASE_URL").rstrip("/") + "/rest/v1/" + path
    return json.loads(urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=60).read())


def reopen_moves(task_gid):
    """(count, last_at) of moves INTO the Reopen column from the activity log."""
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
            if MOVE_RE.search(s.get("text") or ""):
                out.append(s.get("created_at"))
        offset = (body.get("next_page") or {}).get("offset")
        if not offset:
            break
    out = [t for t in out if t]
    return len(out), (max(out) if out else None)


def upsert(rows):
    if not rows:
        print("No reopened tickets to record.")
        return
    key = env("SUPABASE_SERVICE_ROLE_KEY")
    h = {"apikey": key, "Authorization": "Bearer " + key, "Content-Type": "application/json",
         "Prefer": "resolution=merge-duplicates,return=minimal"}
    url = env("SUPABASE_URL").rstrip("/") + "/rest/v1/fact_reopens?on_conflict=task_gid"
    for i in range(0, len(rows), 200):
        chunk = rows[i:i + 200]
        r = urllib.request.urlopen(urllib.request.Request(url, data=json.dumps(chunk).encode(), headers=h, method="POST"), timeout=90)
        print(f"  upserted {len(chunk)} reopen rows (HTTP {r.status})")


def prune(keep_gids, scope_sprints):
    """Drop rows in the scanned sprint window whose reopen_count is now 0."""
    existing = sb_get("fact_reopens?select=task_gid,sprint")
    stale = [e["task_gid"] for e in existing
             if e.get("sprint") in scope_sprints and e["task_gid"] not in keep_gids]
    if not stale:
        return
    key = env("SUPABASE_SERVICE_ROLE_KEY")
    h = {"apikey": key, "Authorization": "Bearer " + key, "Prefer": "return=minimal"}
    base = env("SUPABASE_URL").rstrip("/") + "/rest/v1/fact_reopens"
    for i in range(0, len(stale), 50):
        ch = stale[i:i + 50]
        u = base + "?task_gid=in.(" + ",".join(ch) + ")"
        urllib.request.urlopen(urllib.request.Request(u, headers=h, method="DELETE"), timeout=60)
    print(f"  pruned {len(stale)} stale row(s).")


def main():
    full = "--full" in sys.argv
    items = sb_get("fact_workitems?select=task_gid,name,sprint,assignee,reopened_count&sprint=not.is.null")
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
    scope_sprints = sorted({int(r["sprint"]) for r in cands})
    print(f"Scanning {len(cands)} sprinted tickets for reopens ({scope})...")
    rows = []
    for r in cands:
        moves, last_at = reopen_moves(r["task_gid"])
        field = num(r.get("reopened_count"))
        count = max(moves, field)
        if count <= 0:
            continue
        rows.append({
            "task_gid": r["task_gid"], "name": r.get("name"), "sprint": int(r["sprint"]),
            "assignee": r.get("assignee"), "reopen_count": count, "reopen_moves": moves,
            "reopen_field": field, "last_reopened_at": last_at,
        })
    print(f"{len(rows)} tickets reopened >=1x (board or manual field).")
    prune({x["task_gid"] for x in rows}, scope_sprints)
    upsert(rows)
    print("Done.")


if __name__ == "__main__":
    main()
