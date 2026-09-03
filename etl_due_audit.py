#!/usr/bin/env python3
"""
etl_due_audit.py — audit due-date CHANGES so a PM can catch tickets whose due
date was moved (e.g. a dev pushing it out to avoid being overdue).

Asana's task fields don't expose due-date history, but each `due_date_changed`
story carries STRUCTURED old/new dates (old_dates.due_on / new_dates.due_on) —
exact ISO dates, so we never have to parse Asana's relative wording ("Today",
"Monday", "Yesterday"). We scan the stories of every open, sprinted ticket and
upsert a per-ticket summary into `fact_due_changes`:
  - changed_by / changed_at   = the LATEST change (who + when)
  - old_due -> new_due        = the exact dates on that latest change
  - action                    = 'set' (from nothing) | 'changed' | 'removed'
  - n_changes                 = how many times the due date was touched
  - pushed_later              = the latest change moved the date LATER (red flag)
  - modified                  = the latest action changed/removed an EXISTING
                                due date (i.e. worth the PM's attention — a pure
                                first-time set is NOT flagged)

.env: ASANA_PAT, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.  Run: python3 etl_due_audit.py
"""
import os
import re
import sys
import json
import urllib.request
import urllib.error

ASANA = "https://app.asana.com/api/1.0"
DONE_RE = re.compile(r"Ready for UAT|QA on UAT|In UAT|UAT Passed|Ready for Production|Released", re.I)
STORY_FIELDS = "created_at,resource_subtype,created_by.name,old_dates.due_on,new_dates.due_on"
# Changers whose due-date edits are NOT flagged (PMs / leads, not the devs we watch).
# Comma-separated in .env; e.g. DUE_AUDIT_EXCLUDE="Rayan Abdul Baki,Gourav Kumar Tiwari".
EXCLUDE = {n.strip() for n in (os.environ.get("DUE_AUDIT_EXCLUDE") or "").split(",") if n.strip()}


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


def is_done(r):
    return bool(r.get("completed_at")) or str(r.get("is_completed")) == "1" \
        or str(r.get("is_delivered")) == "1" or bool(DONE_RE.search(r.get("section") or ""))


def due_changes(task_gid):
    """Ordered list of due-date change events with exact dates:
    [{at, by, old_due(iso|None), new_due(iso|None)}]."""
    h = {"Authorization": "Bearer " + env("ASANA_PAT")}
    out, offset = [], None
    while True:
        q = f"/tasks/{task_gid}/stories?opt_fields={STORY_FIELDS}&limit=100"
        if offset:
            q += "&offset=" + offset
        body = json.loads(urllib.request.urlopen(urllib.request.Request(ASANA + q, headers=h), timeout=60).read())
        for s in body.get("data", []):
            if s.get("resource_subtype") != "due_date_changed":
                continue
            out.append({
                "at": s.get("created_at"),
                "by": (s.get("created_by") or {}).get("name"),
                "old_due": (s.get("old_dates") or {}).get("due_on"),
                "new_due": (s.get("new_dates") or {}).get("due_on"),
            })
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
    items = sb_get("fact_workitems?select=task_gid,name,sprint,assignee,section,is_completed,is_delivered,completed_at")
    cands = [r for r in items if not is_done(r) and str(r.get("sprint") or "").isdigit()]
    print(f"Auditing {len(cands)} open, sprinted tickets for due-date changes...")
    rows = []
    for r in cands:
        evs = due_changes(r["task_gid"])
        if not evs:
            continue
        # Ignore edits by excluded changers (PMs/leads). Base the row on the latest
        # change made by SOMEONE ELSE, so a dev's change isn't hidden by a later PM edit.
        relevant = [e for e in evs if (e["by"] or "") not in EXCLUDE]
        base = relevant[-1] if relevant else evs[-1]
        old_due, new_due = base["old_due"], base["new_due"]
        action = "removed" if new_due is None else ("set" if old_due is None else "changed")
        pushed_later = bool(old_due and new_due and new_due > old_due)
        # "modified" = a NON-excluded person changed/removed an EXISTING due date
        # (pure first-time sets, and edits made only by excluded users, are not flagged).
        modified = bool(relevant) and (old_due is not None)
        rows.append({
            "task_gid": r["task_gid"], "name": r.get("name"), "sprint": int(r["sprint"]),
            "assignee": r.get("assignee"), "changed_at": base["at"], "changed_by": base["by"],
            "old_due": old_due, "new_due": new_due, "action": action,
            "n_changes": len(relevant), "pushed_later": pushed_later, "modified": modified,
        })
    mod = sum(1 for x in rows if x["modified"])
    print(f"{len(rows)} tickets have due-date history; {mod} were MODIFIED (existing date changed/removed).")
    # Drop stale rows: tickets no longer in scope (done/unsprinted) or whose edits are
    # now all by excluded users — so the audit reflects only current, relevant changes.
    current = {r["task_gid"] for r in rows}
    existing = [e["task_gid"] for e in sb_get("fact_due_changes?select=task_gid")]
    stale = [g for g in existing if g not in current]
    if stale:
        key = env("SUPABASE_SERVICE_ROLE_KEY")
        h = {"apikey": key, "Authorization": "Bearer " + key, "Prefer": "return=minimal"}
        base = env("SUPABASE_URL").rstrip("/") + "/rest/v1/fact_due_changes"
        for i in range(0, len(stale), 50):
            ch = stale[i:i + 50]
            u = base + "?task_gid=in.(" + ",".join(ch) + ")"
            urllib.request.urlopen(urllib.request.Request(u, headers=h, method="DELETE"), timeout=60)
        print(f"  pruned {len(stale)} stale row(s).")
    upsert(rows)
    print("Done.")


if __name__ == "__main__":
    main()
