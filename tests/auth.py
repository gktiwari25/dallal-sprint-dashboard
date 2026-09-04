"""
Auth helpers for the Selenium tests.

The dashboard is Supabase-auth protected (RLS returns no data without a signed-in
JWT), so tests need a real session. Two ways to get one, in priority order:

  1. TEST_SESSION  — the raw localStorage value you copy from your OWN logged-in
     browser (DevTools → Application → Local Storage → the `sb-...-auth-token`
     entry → copy its Value). Works with ANY login method (Google, magic link,
     password) and needs no password. This is the easiest.

  2. TEST_EMAIL + TEST_PASSWORD — if your account has a password set, we fetch a
     session from Supabase's password grant directly (no UI clicking).

Either way we drop the session into localStorage under the key supabase-js reads,
then reload so the app picks it up already authenticated.
"""
import os
import re
import json
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_JS = os.path.join(HERE, "..", "config.js")


def _read_config():
    """Pull SUPABASE_URL + anon key out of the committed config.js (anon key is public)."""
    txt = open(CONFIG_JS, encoding="utf-8").read()
    url = re.search(r'SUPABASE_URL:\s*"([^"]+)"', txt).group(1).rstrip("/")
    anon = re.search(r'SUPABASE_ANON_KEY:\s*"([^"]+)"', txt).group(1)
    ref = re.search(r"https://([a-z0-9]+)\.supabase\.co", url).group(1)
    return url, anon, ref


SUPABASE_URL, ANON_KEY, PROJECT_REF = _read_config()
STORAGE_KEY = f"sb-{PROJECT_REF}-auth-token"


def _session_from_password(email, password):
    body = json.dumps({"email": email, "password": password}).encode()
    req = urllib.request.Request(
        SUPABASE_URL + "/auth/v1/token?grant_type=password",
        data=body,
        headers={"apikey": ANON_KEY, "Content-Type": "application/json"},
        method="POST",
    )
    s = json.loads(urllib.request.urlopen(req, timeout=30).read())
    return json.dumps({
        "access_token": s["access_token"],
        "token_type": s.get("token_type", "bearer"),
        "expires_in": s.get("expires_in", 3600),
        "expires_at": s.get("expires_at"),
        "refresh_token": s["refresh_token"],
        "user": s.get("user"),
    })


def get_storage_value():
    """Return the JSON string to store under STORAGE_KEY, or None if no creds provided."""
    raw = os.environ.get("TEST_SESSION")
    if raw:
        return raw.strip()
    email = os.environ.get("TEST_EMAIL")
    pw = os.environ.get("TEST_PASSWORD")
    if email and pw:
        return _session_from_password(email, pw)
    return None
