#!/usr/bin/env bash
# Near-live Asana work-item STATE sync (launchd: com.dallal.asana.sync, every 15 min).
# Loads .env, runs etl_asana.py (updates section/completion only — see that script).
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"
mkdir -p logs
[ -f "$DIR/.env" ] && { set -a; . "$DIR/.env"; set +a; }
PY="$DIR/.venv/bin/python"; [ -x "$PY" ] || PY="$(command -v python3)"
if [ -n "${ASANA_PAT:-}" ]; then
  "$PY" "$DIR/etl_asana.py" >> "$DIR/logs/asana_sync.log" 2>&1
else
  echo "[$(date '+%F %T')] SKIP asana — ASANA_PAT not set" >> "$DIR/logs/asana_sync.log"
fi
