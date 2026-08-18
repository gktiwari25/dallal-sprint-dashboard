#!/usr/bin/env python3
"""
Register (or list/delete) the Asana webhook that drives real-time Delivery sync.

The Edge Function must be DEPLOYED and public first — Asana sends a handshake to
the target URL on creation and expects the X-Hook-Secret echoed back (the
function handles that). Run this once after deploy.

.env: ASANA_PAT, ASANA_PROJECT_GID (default Dallal Product Development)
Env:  WEBHOOK_TARGET (default the Supabase function URL)

  python3 register_asana_webhook.py            # create
  python3 register_asana_webhook.py --list     # list existing
  python3 register_asana_webhook.py --delete <webhook_gid>
"""
import os
import sys
import requests

A = "https://app.asana.com/api/1.0"
PROJECT = os.environ.get("ASANA_PROJECT_GID", "1214388950902741")
TARGET = os.environ.get(
    "WEBHOOK_TARGET",
    "https://dgcxiznnyvhddzsoaxsd.supabase.co/functions/v1/asana-webhook")


def h():
    pat = os.environ.get("ASANA_PAT")
    if not pat:
        sys.exit("Missing ASANA_PAT")
    return {"Authorization": f"Bearer {pat}", "Content-Type": "application/json"}


def main():
    if "--list" in sys.argv:
        r = requests.get(f"{A}/webhooks", headers=h(),
                         params={"workspace": "1211966365940925", "limit": 100}, timeout=60)
        for w in r.json().get("data", []):
            print(w.get("gid"), "->", (w.get("target") or "")[:70], "| active:", w.get("active"))
        return
    if "--delete" in sys.argv:
        gid = sys.argv[sys.argv.index("--delete") + 1]
        r = requests.delete(f"{A}/webhooks/{gid}", headers=h(), timeout=60)
        print("delete", gid, "->", r.status_code)
        return

    body = {"data": {
        "resource": PROJECT,
        "target": TARGET,
        "filters": [
            {"resource_type": "task", "action": "changed"},
            {"resource_type": "task", "action": "added"},
            {"resource_type": "task", "action": "removed"},
            {"resource_type": "task", "action": "deleted"},
            {"resource_type": "task", "action": "undeleted"},
        ],
    }}
    r = requests.post(f"{A}/webhooks", headers=h(), json=body, timeout=60)
    if r.status_code in (200, 201):
        w = r.json()["data"]
        print(f"OK — webhook {w['gid']} active={w.get('active')} -> {TARGET}")
    else:
        print(f"FAILED {r.status_code}: {r.text[:400]}")
        print("(Is the Edge Function deployed + public? The handshake must reach it.)")


if __name__ == "__main__":
    main()
