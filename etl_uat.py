#!/usr/bin/env python3
"""
etl_uat.py — stamp WHEN each testing ticket entered its current board section.

The dashboard's "Ready for UAT" section (Delivery tab) needs the date a ticket
was moved into the "Ready for UAT" column. Asana's task fields don't carry that,
but the task's activity log (stories) does: a `section_changed` story whose text
reads  …moved this task from "X" to "Ready for UAT" in <project>.

This ETL reads the tickets currently sitting in the testing sections, fetches
each one's stories, finds the LATEST move INTO its current section, and upserts
that timestamp into `fact_workitems.section_since` (partial upsert — touches only
that one column, so it never clashes with the Asana state sync or the cloud sync).

Only a handful of tickets are in testing at any time, so the per-ticket story
fetch is cheap. .env: ASANA_PAT, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
Run:  python3 etl_uat.py
"""
import os
import re
import sys
import json
import urllib.parse
import urllib.request

ASANA_BASE = "https://app.asana.com/api/1.0"
# Board columns that mean "handed to testing". "Ready for UAT" is the one the
# dashboard section shows; the others are stamped too so the column is reusable.
TESTING_SECTIONS = ["Ready for UAT", "QA on UAT", "In UAT"]


def env(name, required=True, default=None):
    v = os.environ.get(name, default)
    if required and not v:
        sys.exit(f"Missing required env var: {name}")
    return v


def _get(url, headers):
    return json.loads(urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=60).read())


def sb_testing_tickets():
    base = env("SUPABASE_URL").rstrip("/") + "/rest/v1/fact_workitems"
    key = env("SUPABASE_SERVICE_ROLE_KEY")
    h = {"apikey": key, "Authorization": "Bearer " + key}
    sects = "(" + ",".join('"' + s + '"' for s in TESTING_SECTIONS) + ")"
    q = "?select=task_gid,section,name&section=" + urllib.parse.quote("in." + sects)
    return _get(base + q, h)


def stories(pat, task_gid):
    """All stories for a task (paginated), newest info intact."""
    ah = {"Authorization": "Bearer " + pat}
    out, offset = [], None
    while True:
        params = {"opt_fields": "created_at,resource_subtype,text", "limit": 100}
        if offset:
            params["offset"] = offset
        url = f"{ASANA_BASE}/tasks/{task_gid}/stories?" + urllib.parse.urlencode(params)
        body = _get(url, ah)
        out.extend(body.get("data", []))
        offset = (body.get("next_page") or {}).get("offset")
        if not offset:
            break
    return out


def entered_section_at(pat, task_gid, section):
    """Timestamp of the LATEST move INTO `section` (or None if no such story)."""
    # Matches: …to "Ready for UAT" in <project>
    pat_re = re.compile(r'to\s+"' + re.escape(section.strip()) + r'"', re.I)
    best = None
    for s in stories(pat, task_gid):
        if s.get("resource_subtype") != "section_changed":
            continue
        if pat_re.search(s.get("text") or ""):
            ca = s.get("created_at")
            if ca and (best is None or ca > best):
                best = ca
    return best


def upsert(rows):
    if not rows:
        print("No testing tickets — nothing to stamp.")
        return
    base = env("SUPABASE_URL").rstrip("/") + "/rest/v1/fact_workitems"
    key = env("SUPABASE_SERVICE_ROLE_KEY")
    h = {"apikey": key, "Authorization": "Bearer " + key, "Content-Type": "application/json",
         "Prefer": "resolution=merge-duplicates,return=minimal"}
    resp = urllib.request.urlopen(
        urllib.request.Request(base + "?on_conflict=task_gid", data=json.dumps(rows).encode(),
                               headers=h, method="POST"), timeout=90)
    print(f"  upserted section_since for {len(rows)} rows (HTTP {resp.status})")


def main():
    pat = env("ASANA_PAT")
    tickets = sb_testing_tickets()
    print(f"Testing tickets found: {len(tickets)}")
    rows, missing = [], 0
    for t in tickets:
        ts = entered_section_at(pat, t["task_gid"], t["section"])
        if ts:
            rows.append({"task_gid": t["task_gid"], "section_since": ts})
        else:
            missing += 1
            print(f"  (no section-change story) {t['name'][:55]}")
    upsert(rows)
    if missing:
        print(f"  {missing} ticket(s) had no matching move story — section_since left as-is.")
    print("Done.")


if __name__ == "__main__":
    main()
