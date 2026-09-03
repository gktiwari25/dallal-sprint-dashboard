#!/usr/bin/env python3
"""
etl_due_audit.py — audit due-date CHANGES so a PM can catch tickets whose due
date was moved (e.g. a dev pushing it out to avoid being overdue).

Asana's task fields don't expose due-date history, but the activity log does:
a `due_date_changed` story — "<name> changed the due date to Sep 11" or
"<name> removed the due date". We scan the stories of every open, sprinted
ticket, reconstruct the change sequence, and upsert a per-ticket summary into
`fact_due_changes`:
  - changed_by / changed_at   = the LATEST change (who + when)
  - old_due -> new_due        = previous value -> current value
  - action                    = 'set' (first time) | 'changed' | 'removed'
  - n_changes                 = how many times the due date was touched
  - pushed_later              = the latest change moved the date LATER (red flag)
  - modified                  = it was changed after being set, or removed
                                (i.e. worth the PM's attention — not just a first set)

The current due date comes from fact_workitems.due_on (authoritative) so the
"new" value never depends on parsing; only the "old" value is parsed from text.

.env: ASANA_PAT, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.  Run: python3 etl_due_audit.py
"""
import os
import re
import sys
import json
import datetime
import urllib.request
import urllib.error

ASANA = "https://app.asana.com/api/1.0"
DONE_RE = re.compile(r"Ready for UAT|QA on UAT|In UAT|UAT Passed|Ready for Production|Released", re.I)
TO_RE = re.compile(r"changed the due date to (.+)$", re.I)
REMOVED_RE = re.compile(r"removed the due date", re.I)


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


def asana_get(path):
    h = {"Authorization": "Bearer " + env("ASANA_PAT")}
    return json.loads(urllib.request.urlopen(urllib.request.Request(ASANA + path, headers=h), timeout=60).read())["data"]


def is_done(r):
    return bool(r.get("completed_at")) or str(r.get("is_completed")) == "1" \
        or str(r.get("is_delivered")) == "1" or bool(DONE_RE.search(r.get("section") or ""))


def parse_due(text, year_hint):
    """Parse Asana's due-date story text (e.g. 'Sep 11' or 'Sep 11, 2026') to ISO date."""
    s = (text or "").strip().rstrip(".")
    for fmt in ("%b %d, %Y", "%B %d, %Y"):
        try:
            return datetime.datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            pass
    for fmt in ("%b %d", "%B %d"):
        try:
            d = datetime.datetime.strptime(s, fmt)
            return datetime.date(year_hint, d.month, d.day).isoformat()
        except ValueError:
            pass
    return None


def due_changes(task_gid):
    """Ordered list of due-date change events: [{at, by, new_due(iso|None), removed}]."""
    out, offset = [], None
    while True:
        q = f"/tasks/{task_gid}/stories?opt_fields=created_at,resource_subtype,text,created_by.name&limit=100"
        if offset:
            q += "&offset=" + offset
        h = {"Authorization": "Bearer " + env("ASANA_PAT")}
        body = json.loads(urllib.request.urlopen(urllib.request.Request(ASANA + q, headers=h), timeout=60).read())
        for s in body.get("data", []):
            if s.get("resource_subtype") != "due_date_changed":
                continue
            at = s.get("created_at")
            by = (s.get("created_by") or {}).get("name")
            txt = s.get("text") or ""
            yr = int(at[:4]) if at else datetime.date.today().year
            if REMOVED_RE.search(txt):
                out.append({"at": at, "by": by, "new_due": None, "removed": True})
            else:
                m = TO_RE.search(txt)
                out.append({"at": at, "by": by, "new_due": parse_due(m.group(1), yr) if m else None, "removed": False})
        offset = (body.get("next_page") or {}).get("offset")
        if not offset:
            break
    out.sort(key=lambda e: e["at"] or "")
    return out


def upsert(rows):
    if not rows:
        print("No due-date changes to record.")
        return
    key = env("SUPABASE_SERVICE_ROLE_KEY")
    h = {"apikey": key, "Authorization": "Bearer " + key, "Content-Type": "application/json",
         "Prefer": "resolution=merge-duplicates,return=minimal"}
    url = env("SUPABASE_URL").rstrip("/") + "/rest/v1/fact_due_changes?on_conflict=task_gid"
    for i in range(0, len(rows), 200):
        chunk = rows[i:i + 200]
        r = urllib.request.urlopen(urllib.request.Request(url, data=json.dumps(chunk).encode(), headers=h, method="POST"), timeout=90)
        print(f"  upserted {len(chunk)} rows (HTTP {r.status})")


def main():
    items = sb_get("fact_workitems?select=task_gid,name,sprint,assignee,due_on,section,is_completed,is_delivered,completed_at")
    cands = [r for r in items if not is_done(r) and str(r.get("sprint") or "").isdigit()]
    print(f"Auditing {len(cands)} open, sprinted tickets for due-date changes...")
    rows = []
    for r in cands:
        evs = due_changes(r["task_gid"])
        if not evs:
            continue
        latest = evs[-1]
        prev_due = evs[-2]["new_due"] if len(evs) >= 2 else None
        # Authoritative current value from fact_workitems; fall back to parsed.
        new_due = r.get("due_on") if not latest["removed"] else None
        if new_due is None and not latest["removed"]:
            new_due = latest["new_due"]
        action = "removed" if latest["removed"] else ("set" if len(evs) == 1 else "changed")
        pushed_later = bool(prev_due and new_due and new_due > prev_due)
        modified = (len(evs) >= 2) or latest["removed"]
        rows.append({
            "task_gid": r["task_gid"], "name": r.get("name"), "sprint": int(r["sprint"]),
            "assignee": r.get("assignee"), "changed_at": latest["at"], "changed_by": latest["by"],
            "old_due": prev_due, "new_due": new_due, "action": action,
            "n_changes": len(evs), "pushed_later": pushed_later, "modified": modified,
        })
    mod = sum(1 for x in rows if x["modified"])
    print(f"{len(rows)} tickets have due-date history; {mod} were MODIFIED (changed/removed after set).")
    upsert(rows)
    print("Done.")


if __name__ == "__main__":
    main()
