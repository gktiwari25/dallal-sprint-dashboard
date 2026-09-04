#!/usr/bin/env bash
# Run the Selenium suite. Auth tests need a session — provide ONE of:
#   export TEST_SESSION='<the sb-...-auth-token value copied from your browser>'
#   export TEST_EMAIL=you@dallal.com.kw TEST_PASSWORD='...'
# Optional: HEADLESS=0 to watch it, DASH_URL=http://localhost:8000 for a local build.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
# Load creds from tests/.env.test if present (gitignored).
[ -f "$DIR/.env.test" ] && set -a && . "$DIR/.env.test" && set +a
exec "$DIR/.venv/bin/python" -m pytest "$DIR" "$@"
