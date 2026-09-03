#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# run_sync.sh — hourly Dallal dashboard sync (called by launchd:
#   ~/Library/LaunchAgents/com.dallal.sprintsync.plist)
#
# Loads secrets from .env (gitignored), then runs each ETL step. Steps are
# independent: one failing does not stop the others, so a missing credential
# for one source never blocks the rest.
#
# NOTE: only the App Store ETL is wired here. The original Asana / Amplitude /
#       GitHub ETL scripts are not on this machine — restore them and add a
#       line in the "OTHER ETLs" block below when available.
# ---------------------------------------------------------------------------
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

mkdir -p logs
LOG="logs/sync.log"
ts() { date "+%Y-%m-%d %H:%M:%S"; }
log() { echo "[$(ts)] $*" | tee -a "$LOG"; }

# --- load secrets ----------------------------------------------------------
if [ -f "$DIR/.env" ]; then
  set -a; . "$DIR/.env"; set +a
else
  log "WARN: no .env file found at $DIR/.env — ETLs needing credentials will skip."
fi

# --- pick the venv python if present, else system python3 ------------------
if [ -x "$DIR/.venv/bin/python" ]; then
  PY="$DIR/.venv/bin/python"
else
  PY="$(command -v python3 || true)"
fi
[ -z "${PY:-}" ] && { log "ERROR: no python found"; exit 1; }

run_step() {
  local name="$1"; shift
  log "START $name"
  if "$@" >>"$LOG" 2>&1; then
    log "OK    $name"
  else
    log "FAIL  $name (exit $?) — continuing"
  fi
}

log "==== sync run start (py=$PY) ===="

# --- App Store Connect analytics -> Supabase fact_appstore_metrics ---------
# Skips cleanly if the App Store Connect credentials are not set in .env.
if [ -n "${ASC_ISSUER_ID:-}" ] && [ -n "${ASC_APP_ID:-}" ]; then
  run_step "appstore" "$PY" "$DIR/etl_appstore.py" --days "${ASC_BACKFILL_DAYS:-3}"
else
  log "SKIP  appstore — ASC_ISSUER_ID / ASC_APP_ID not set in .env"
fi

# --- Google Play (Android) analytics -> Supabase (platform='android') ---------
if [ -n "${PLAY_BUCKET_ID:-}" ] && [ -n "${GOOGLE_APPLICATION_CREDENTIALS:-}" ]; then
  run_step "playstore" "$PY" "$DIR/etl_playstore.py" --months "${PLAY_BACKFILL_MONTHS:-2}"
else
  log "SKIP  playstore — PLAY_BUCKET_ID / GOOGLE_APPLICATION_CREDENTIALS not set"
fi

# --- Engineering (GitHub repo health + vulns) -> Supabase ---------------------
# Uses the gh CLI (no token env needed). fact_repo_health + fact_vulns.
run_step "github" "$PY" "$DIR/etl_github.py" --out "$DIR/data" --supabase

# --- Ready-for-UAT entry dates (Asana activity log) -> fact_workitems.section_since
# Stamps when each testing ticket entered its board column (Delivery "Ready for UAT").
if [ -n "${ASANA_PAT:-}" ]; then
  run_step "uat-dates" "$PY" "$DIR/etl_uat.py"
else
  log "SKIP  uat-dates — ASANA_PAT not set in .env"
fi

# --- Amplitude (Funnels / Marketing / Paths) -> Supabase ----------------------
# Only run when the Amplitude keys are present in .env.
if [ -n "${AMPLITUDE_PROD_API_KEY:-}" ]; then
  run_step "amplitude" "$PY" "$DIR/etl_amplitude.py" --supabase
  run_step "marketing" "$PY" "$DIR/etl_marketing.py" --supabase
  run_step "paths"     "$PY" "$DIR/etl_paths.py" --supabase
  run_step "trends"    "$PY" "$DIR/etl_trends.py" --supabase --days 90
else
  log "SKIP  amplitude/marketing/paths — AMPLITUDE_PROD_API_KEY not set in .env"
fi

# --- One-time Slack alerts: App Store Impressions & Google Play (Android) ------
run_step "impr-check" "$PY" "$DIR/check_impressions.py"
run_step "android-check" "$PY" "$DIR/check_android.py"

log "==== sync run done ===="
