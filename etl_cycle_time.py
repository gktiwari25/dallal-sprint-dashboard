#!/usr/bin/env python3
"""
etl_cycle_time.py — per-ticket delivery cycle time (approved -> released), computed
from the Asana activity log.

"Approved" = the ticket was moved into the "Sprint Planned" board column (committed
to a sprint). "Released" = moved into the "Released" board column. We read each
sprinted ticket's stories, take the EARLIEST move into each of those two sections,
and store the gap in days into `fact_cycle_time`:
  - approved_at, released_at  = the two milestone timestamps
  - cycle_days                = (released_at - approved_at) in days (1 dp)
Only tickets that have BOTH milestones (and released >= approved) are stored.

Scope mirrors etl_uat_moves: recent sprints by default (current calendar sprint
from config.js, floor = current - 2), `--full` backfills from MOVES_SPRINT_FLOOR.
Tasks the PAT can't read (403) or that are deleted (404) are skipped, not fatal.

.env: ASANA_PAT, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
Run:  python3 etl_cycle_time.py            # hourly: recent sprints
      python3 etl_cycle_time.py --full      # backfill from MOVES_SPRINT_FLOOR (default 10)
"""
import os
import re
import sys
import json
import datetime
import urllib.request
import urllib.error

import asana_util

ASANA = "https://app.asana.com/api/1.0"
APPROVED_SECTION = "Sprint Planned"
ACTIVE_DAYS = int(os.environ.get("MOVES_ACTIVE_DAYS") or "10")
# Board section names carry stray spaces (" Released"); match tolerant of surrounding
# whitespace inside the quotes.
APPROVED_RE = re.compile(r'to\s+"\s*' + re.escape(APPROVED_SECTION) + r'\s*"', re.I)
RELEASED_RE = re.compile(r'to\s+"\s*Released\s*"', re.I)
STORY_FIELDS = "created_at,resource_subtype,text"
RECENT_SPRINTS = int(os.environ.get("MOVES_RECENT_SPRINTS") or "3")
SPRINT_FLOOR = int(os.environ.get("MOVES_SPRINT_FLOOR") or "10")


def env(n):
    v = os.environ.get(n)
    if not v:
        sys.exit(f"Missing env var: {n}")
    return v


def current_sprint():
    """Calendar-driven current sprint from config.js SPRINT_ANCHOR (robust against
    outlier future sprint numbers). Returns None if config can't be read."""
    try:
        cfg = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.js")).read()
        anc = int(re.search(r"SPRINT_ANCHOR:\s*\{\s*sprint:\s*(\d+)", cfg).group(1))
        start = datetime.date.fromisoformat(re.search(r'start:\s*"(\d{4}-\d{2}-\d{2})"', cfg).group(1))
        length = int(re.search(r"SPRINT_LENGTH_DAYS:\s*(\d+)", cfg).group(1))
        return anc + (datetime.date.today() - start).days // length
    except Exception:
        return None


def sb_get(path):
    key = env("SUPABASE_SERVICE_ROLE_KEY")
    h = {"apikey": key, "Authorization": "Bearer " + key}
    url = env("SUPABASE_URL").rstrip("/") + "/rest/v1/" + path
    return json.loads(urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=60).read())


def milestones(task_gid):
    """(approved_at, released_at) = earliest move into each section, or (None, None)."""
    pat = env("ASANA_PAT")
    approved, released, offset = None, None, None
    while True:
        q = f"/tasks/{task_gid}/stories?opt_fields={STORY_FIELDS}&limit=100"
        if offset:
            q += "&offset=" + offset
        body = asana_util.get_json(q, pat)
        for s in body.get("data", []):
            if s.get("resource_subtype") != "section_changed":
                continue
            txt, ca = s.get("text") or "", s.get("created_at")
            if not ca:
                continue
            if APPROVED_RE.search(txt) and (approved is None or ca < approved):
                approved = ca
            elif RELEASED_RE.search(txt) and (released is None or ca < released):
                released = ca
        offset = (body.get("next_page") or {}).get("offset")
        if not offset:
            break
    return approved, released


def cycle_days(approved_iso, released_iso):
    a = datetime.datetime.fromisoformat(approved_iso.replace("Z", "+00:00"))
    r = datetime.datetime.fromisoformat(released_iso.replace("Z", "+00:00"))
    return round((r - a).total_seconds() / 86400.0, 1)


def upsert(rows):
    if not rows:
        print("No cycle-time rows to record.")
        return
    key = env("SUPABASE_SERVICE_ROLE_KEY")
    h = {"apikey": key, "Authorization": "Bearer " + key, "Content-Type": "application/json",
         "Prefer": "resolution=merge-duplicates,return=minimal"}
    url = env("SUPABASE_URL").rstrip("/") + "/rest/v1/fact_cycle_time?on_conflict=task_gid"
    for i in range(0, len(rows), 200):
        chunk = rows[i:i + 200]
        r = urllib.request.urlopen(urllib.request.Request(url, data=json.dumps(chunk).encode(), headers=h, method="POST"), timeout=90)
        print(f"  upserted {len(chunk)} cycle rows (HTTP {r.status})")


def prune(scanned_gids, keep_gids):
    """Drop fact_cycle_time rows for tickets we RESCANNED this run that no longer have
    a full cycle. Scoped to scanned tickets so the modified-since window never drops
    still-valid rows for dormant tickets we didn't rescan."""
    stale = [g for g in scanned_gids if g not in keep_gids]
    if not stale:
        return
    key = env("SUPABASE_SERVICE_ROLE_KEY")
    h = {"apikey": key, "Authorization": "Bearer " + key, "Prefer": "return=minimal"}
    base = env("SUPABASE_URL").rstrip("/") + "/rest/v1/fact_cycle_time"
    for i in range(0, len(stale), 50):
        ch = stale[i:i + 50]
        u = base + "?task_gid=in.(" + ",".join(ch) + ")"
        urllib.request.urlopen(urllib.request.Request(u, headers=h, method="DELETE"), timeout=60)
    print(f"  pruned {len(stale)} stale row(s).")


def main():
    full = "--full" in sys.argv
    items = sb_get("fact_workitems?select=task_gid,name,sprint,modified_at&sprint=not.is.null")
    sprinted = [r for r in items if str(r.get("sprint") or "").isdigit()]
    if not sprinted:
        print("No sprinted tickets found.")
        return
    if full:
        floor = SPRINT_FLOOR
        scope = f"full backfill (sprint >= {floor})"
    else:
        cur = current_sprint() or max(int(r["sprint"]) for r in sprinted)
        floor = cur - (RECENT_SPRINTS - 1)
        scope = f"recent sprints >= {floor} (current {cur})"
    cands = [r for r in sprinted if int(r["sprint"]) >= floor]
    if not full:
        cutoff = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=ACTIVE_DAYS)).isoformat()
        cands = [r for r in cands if (r.get("modified_at") or "") >= cutoff]
        scope += f", modified <= {ACTIVE_DAYS}d"
    scanned_gids = {r["task_gid"] for r in cands}
    print(f"Scanning {len(cands)} sprinted tickets for cycle time ({scope})...")
    rows, skipped = [], 0
    for r in cands:
        try:
            approved, released = milestones(r["task_gid"])
        except urllib.error.HTTPError as e:
            if e.code in (403, 404):
                skipped += 1
                continue
            raise
        if not (approved and released):
            continue
        cd = cycle_days(approved, released)
        if cd < 0:
            continue
        rows.append({
            "task_gid": r["task_gid"], "name": r.get("name"), "sprint": int(r["sprint"]),
            "approved_at": approved, "released_at": released, "cycle_days": cd,
        })
    if skipped:
        print(f"  skipped {skipped} inaccessible/deleted task(s).")
    print(f"{len(rows)} tickets with a full approved->released cycle.")
    prune(scanned_gids, {x["task_gid"] for x in rows})
    upsert(rows)
    print("Done.")


if __name__ == "__main__":
    main()
