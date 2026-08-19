# Always-on ETL host — Google Cloud Run Jobs

Runs the same Python ETLs as the Mac, on a schedule, with **no laptop and no
GitHub Actions**. Real-time Delivery is unaffected (that's the Supabase Edge
Function on the Asana webhook — already cloud-hosted).

## What runs where
| Job | Schedule | Does |
|-----|----------|------|
| `dallal-etl-hourly`  | every hour :15 | appstore, playstore, github, amplitude (funnels/retention), marketing, paths, trends |
| `dallal-etl-derived` | every 12h      | story-points supersede + is_delivered + dim_sprint + burndown |

The 60s Asana state sync is **not** migrated — the Edge Function already gives
live Delivery status; the 12h derived job backstops story points.

## One-time deploy (from repo root)

1. **Install + authenticate gcloud** (interactive, your Google account):
   ```
   gcloud auth login
   gcloud auth application-default login
   ```
2. **Add a GitHub token** for `etl_github` (fine-grained PAT, read-only:
   Contents + Metadata on the 3 repos, or classic `repo:status`,`public_repo`).
   Append it to `.env`:
   ```
   echo "GH_TOKEN=ghp_xxx" >> .env
   ```
3. **Deploy**:
   ```
   PROJECT=dallal-e23a2 REGION=us-central1 bash cloud/deploy.sh
   ```
   This pushes every secret to Secret Manager, builds the image via Cloud Build
   (no local Docker), creates both Run Jobs, and schedules them.
4. **Smoke test**:
   ```
   gcloud run jobs execute dallal-etl-hourly --region us-central1
   gcloud run jobs executions logs read --job dallal-etl-hourly --region us-central1
   ```

## After it's verified
Disable the Mac launchd timers so work isn't duplicated:
```
launchctl bootout gui/$(id -u)/com.dallal.sprintsync
launchctl bootout gui/$(id -u)/com.dallal.asana.derived
```
Keep `com.dallal.asana.sync` (60s) only if you want a local fallback to the
Edge Function; otherwise bootout it too.

## Cost
Well within GCP free tier: ~24 hourly + 2 derived executions/day, each a
sub-minute container. Cloud Scheduler is free for <3 jobs. Expect ~$0–1/mo.
