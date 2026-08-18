#!/usr/bin/env bash
# Wrapper for the Google Play analytics-landed checker (launchd:
# com.dallal.playstore.check). Loads .env, runs the check via the venv.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"
mkdir -p logs
[ -f "$DIR/.env" ] && { set -a; . "$DIR/.env"; set +a; }
PY="$DIR/.venv/bin/python"; [ -x "$PY" ] || PY="$(command -v python3)"
"$PY" "$DIR/check_playstore.py" >> "$DIR/logs/play_check.log" 2>&1
