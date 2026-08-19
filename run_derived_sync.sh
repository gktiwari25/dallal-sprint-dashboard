#!/usr/bin/env bash
# Twice-daily derived-fields sync (launchd: com.dallal.asana.derived, every 12h).
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; cd "$DIR"; mkdir -p logs
[ -f "$DIR/.env" ] && { set -a; . "$DIR/.env"; set +a; }
PY="$DIR/.venv/bin/python"; [ -x "$PY" ] || PY="$(command -v python3)"
[ -n "${ASANA_PAT:-}" ] && "$PY" "$DIR/etl_derived.py" >> "$DIR/logs/derived_sync.log" 2>&1 || echo "[$(date '+%F %T')] SKIP derived — no ASANA_PAT" >> "$DIR/logs/derived_sync.log"
