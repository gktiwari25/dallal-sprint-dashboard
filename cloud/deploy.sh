#!/usr/bin/env bash
# Deploy the Dallal ETLs to Google Cloud Run Jobs + Cloud Scheduler (always-on,
# no Mac, no GitHub). Run from the repo root AFTER `gcloud auth login`.
#
#   PROJECT=dallal-e23a2 REGION=us-central1 bash cloud/deploy.sh
#
# Reads secrets from .env, pushes them to Secret Manager, deploys two jobs
# (hourly + derived) from source (Cloud Build — no local Docker needed), and
# schedules them. Needs in .env: all ASC_*, PLAY_*, SUPABASE_*, AMPLITUDE_*,
# ASANA_PAT, SLACK_WEBHOOK_URL, plus GH_TOKEN (a read-only GitHub PAT) and the
# secrets/AuthKey_*.p8 + secrets/dallal-play-sa.json files.
set -euo pipefail
PROJECT="${PROJECT:-dallal-e23a2}"
REGION="${REGION:-us-central1}"
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a

gcloud config set project "$PROJECT"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  cloudscheduler.googleapis.com secretmanager.googleapis.com artifactregistry.googleapis.com

PNUM="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
SA="${PNUM}-compute@developer.gserviceaccount.com"   # Cloud Run job identity + scheduler caller

put() { # put SECRET_NAME VALUE -> create or add version; echoes name on success
  if printf '%s' "$2" | gcloud secrets create "$1" --data-file=- 2>/dev/null \
     || printf '%s' "$2" | gcloud secrets versions add "$1" --data-file=- >/dev/null 2>&1; then
    echo "$1"
  fi ; }

# Push each present secret; collect the ones that actually got created into SEC.
SEC=""
add() { [ -n "${1:-}" ] && SEC="${SEC}${SEC:+,}${1}=${1}:latest"; }

SCALARS="SUPABASE_URL SUPABASE_SERVICE_KEY SUPABASE_SERVICE_ROLE_KEY ASC_ISSUER_ID ASC_KEY_ID \
ASC_VENDOR_NUMBER ASC_APP_ID PLAY_BUCKET_ID PLAY_PACKAGE_NAME AMPLITUDE_API_HOST AMPLITUDE_PROD_APP \
AMPLITUDE_UAT_APP AMPLITUDE_PROD_API_KEY AMPLITUDE_PROD_SECRET_KEY AMPLITUDE_UAT_API_KEY \
AMPLITUDE_UAT_SECRET_KEY ASANA_PAT ASANA_PROJECT_GID SLACK_WEBHOOK_URL GH_TOKEN"
for v in $SCALARS; do
  val="${!v:-}"; [ -n "$val" ] && add "$(put "$v" "$val")"
done
# file secrets (only if the source files exist)
[ -n "${ASC_PRIVATE_KEY_PATH:-}" ] && [ -f "$ASC_PRIVATE_KEY_PATH" ] \
  && add "$(put ASC_PRIVATE_KEY_B64 "$(base64 < "$ASC_PRIVATE_KEY_PATH")")"
[ -n "${GOOGLE_APPLICATION_CREDENTIALS:-}" ] && [ -f "$GOOGLE_APPLICATION_CREDENTIALS" ] \
  && add "$(put GOOGLE_SA_JSON "$(cat "$GOOGLE_APPLICATION_CREDENTIALS")")"
echo "Secrets wired: $SEC"

# The job identity must be able to read the secrets; the scheduler caller must run jobs.
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:$SA" --role="roles/secretmanager.secretAccessor" --condition=None -q >/dev/null
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:$SA" --role="roles/run.developer" --condition=None -q >/dev/null

deploy() { # deploy JOBNAME ARG
  gcloud run jobs deploy "$1" --source . --region "$REGION" \
    --service-account "$SA" --set-secrets "$SEC" --args "$2" \
    --task-timeout=1200s --max-retries=1 --memory=1Gi
}
deploy dallal-etl-hourly  hourly
deploy dallal-etl-derived derived

# Scheduler: hourly at :15, derived every 12h. Uses the Cloud Run Jobs run target.
sched() { # sched NAME CRON JOB
  gcloud scheduler jobs create http "$1" --location "$REGION" --schedule="$2" \
    --uri="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT}/jobs/${3}:run" \
    --http-method=POST --oauth-service-account-email="$SA" 2>/dev/null \
  || gcloud scheduler jobs update http "$1" --location "$REGION" --schedule="$2" \
    --uri="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT}/jobs/${3}:run" \
    --http-method=POST --oauth-service-account-email="$SA"
}
sched dallal-hourly  "15 * * * *"  dallal-etl-hourly
sched dallal-derived "30 */12 * * *" dallal-etl-derived

echo "Deployed. Run once now:  gcloud run jobs execute dallal-etl-hourly --region $REGION"
