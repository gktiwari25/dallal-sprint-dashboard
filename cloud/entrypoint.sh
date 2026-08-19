#!/usr/bin/env bash
# Cloud Run Job entrypoint. Secrets arrive as env vars (from Secret Manager).
# File-based secrets (Apple .p8, Google Play SA JSON) are passed base64/JSON in
# env and written to disk here. First arg picks the job set.
set -uo pipefail
cd /app
mkdir -p secrets logs

if [ -n "${ASC_PRIVATE_KEY_B64:-}" ]; then
  echo "$ASC_PRIVATE_KEY_B64" | base64 -d > secrets/asc.p8
  export ASC_PRIVATE_KEY_PATH=/app/secrets/asc.p8
fi
if [ -n "${GOOGLE_SA_JSON:-}" ]; then
  printf '%s' "$GOOGLE_SA_JSON" > secrets/play-sa.json
  export GOOGLE_APPLICATION_CREDENTIALS=/app/secrets/play-sa.json
fi
# gh CLI authenticates from GH_TOKEN automatically.
export GH_TOKEN="${GH_TOKEN:-}"

step() { echo "== $1 =="; shift; "$@" || echo "  (failed, continuing)"; }

case "${1:-hourly}" in
  derived)
    step "asana-derived" python3 etl_derived.py
    ;;
  hourly|*)
    step "appstore"  python3 etl_appstore.py  --days "${ASC_BACKFILL_DAYS:-3}"
    step "playstore" python3 etl_playstore.py --months "${PLAY_BACKFILL_MONTHS:-2}"
    step "github"    python3 etl_github.py    --out data --supabase
    step "amplitude" python3 etl_amplitude.py --supabase
    step "marketing" python3 etl_marketing.py --supabase
    step "paths"     python3 etl_paths.py     --supabase
    step "trends"    python3 etl_trends.py     --supabase --days 90
    step "impr-check" python3 check_impressions.py
    ;;
esac
echo "done: ${1:-hourly}"
