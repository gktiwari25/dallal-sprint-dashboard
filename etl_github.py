#!/usr/bin/env python3
"""
Dallal Sprint Dashboard - GitHub / engineering-health ETL
=========================================================
Pulls per-repo governance + CI metrics live (via the `gh` CLI) and merges in the
dependency-vulnerability totals/list (from the OSV scans) to feed the dashboard's
Engineering page.

Requires: `gh` CLI authenticated (gh auth login) on the host. No pip deps.

Usage:
    python3 etl_github.py --out ./data                 # governance + CI + vuln seed -> CSV
    python3 etl_github.py --out ./data --supabase      # also upsert to Supabase
    # vuln TOTALS come from data/github_vulns_totals.csv and the CVE LIST from
    # data/github_vulns_seed.csv (refresh those from a periodic OSV scan).

Outputs:
    fact_repo_health.csv   one row per repo (governance, CI, scanner flags, vuln counts, posture)
    fact_vulns.csv         one row per notable CVE (for the table)
"""
import argparse
import csv
import json
import os
import subprocess
import sys

ORG = "Dallal-kwt"
REPOS = ["Dallal-BE-ROR", "Dallal-ReactJs", "Dallal-React-Native-Mobile"]
WINDOW_DAYS = 30  # PR/governance lookback


def gh_json(args):
    """Run a gh command returning JSON; ([] / {}) on failure."""
    try:
        out = subprocess.run(["gh"] + args, capture_output=True, text=True, timeout=120)
        if out.returncode != 0 or not out.stdout.strip():
            return None
        return json.loads(out.stdout)
    except (subprocess.SubprocessError, json.JSONDecodeError):
        return None


def gh_ok(api_path):
    """True if `gh api <path>` succeeds (2xx) - used to detect enabled features."""
    try:
        r = subprocess.run(["gh", "api", api_path, "--silent"],
                           capture_output=True, text=True, timeout=60)
        return r.returncode == 0
    except subprocess.SubprocessError:
        return False


def default_branch(repo):
    d = gh_json(["repo", "view", f"{ORG}/{repo}", "--json", "defaultBranchRef"])
    return (d or {}).get("defaultBranchRef", {}).get("name", "dev")


def _is_promotion(p):
    """Release-flow PRs (dev->uat/main, cherry-picks) carry already-reviewed code;
    they should NOT count against code-review metrics."""
    base = (p.get("baseRefName") or "").lower()
    title = (p.get("title") or "").lower()
    if base in ("uat", "main", "master", "prod", "production", "stage", "staging", "release"):
        return True
    return any(k in title for k in ("promote", "promotion", "cherry-pick", "cherry pick"))


def pr_governance(repo):
    prs = gh_json(["pr", "list", "-R", f"{ORG}/{repo}", "--state", "merged",
                   "--limit", "200", "--json",
                   "number,title,mergedAt,reviewDecision,reviews,baseRefName"]) or []
    from datetime import datetime, timedelta, timezone
    cutoff = (datetime.now(timezone.utc) - timedelta(days=WINDOW_DAYS)).isoformat()
    recent = [p for p in prs if (p.get("mergedAt") or "") >= cutoff]
    # Review metrics consider only FEATURE/bugfix PRs into the working branch —
    # promotion PRs (dev->uat) are excluded since the code was reviewed on dev.
    feature = [p for p in recent if not _is_promotion(p)]
    merged = len(feature)
    unreviewed = sum(1 for p in feature
                     if p.get("reviewDecision") != "APPROVED" and not p.get("reviews"))
    changes_req = sum(1 for p in feature if p.get("reviewDecision") == "CHANGES_REQUESTED")
    coverage = round(100.0 * (merged - unreviewed) / merged, 1) if merged else None
    return merged, unreviewed, changes_req, coverage


def ci_pass_rate(repo):
    runs = gh_json(["run", "list", "-R", f"{ORG}/{repo}", "--limit", "30",
                    "--json", "conclusion"]) or []
    done = [r for r in runs if r.get("conclusion") in ("success", "failure")]
    if not done:
        return None, 0
    passed = sum(1 for r in done if r["conclusion"] == "success")
    return round(100.0 * passed / len(done), 1), len(done)


def load_totals(out):
    path = os.path.join(out, "github_vulns_totals.csv")
    totals = {}
    if os.path.exists(path):
        with open(path, newline="", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                totals[row["repo"]] = row
    return totals


def posture(crit, high, unreviewed, ci_rate, secret_on, dependabot_on):
    """Red ONLY for genuine exploitable exposure (open Critical, or many High CVEs).
    Yellow for config gaps worth fixing (scanners off, some Highs, unreviewed, low CI).
    Green otherwise. Scanner-off alone is a gap (Yellow), not Red."""
    c = int(crit) if str(crit).isdigit() else 0
    h = int(high) if str(high).isdigit() else 0
    if c > 0 or h >= 10:
        return "Red"
    if h > 0 or unreviewed > 0 or (not secret_on and not dependabot_on) or (ci_rate is not None and ci_rate < 50):
        return "Yellow"
    return "Green"


def main():
    ap = argparse.ArgumentParser(description="GitHub engineering-health ETL")
    ap.add_argument("--out", default="./data")
    ap.add_argument("--supabase", action="store_true")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    totals = load_totals(args.out)

    health = []
    for repo in REPOS:
        print(f"GitHub: {repo} ...", file=sys.stderr)
        br = default_branch(repo)
        merged, unreviewed, changes_req, coverage = pr_governance(repo)
        ci_rate, ci_n = ci_pass_rate(repo)
        dependabot = gh_ok(f"repos/{ORG}/{repo}/vulnerability-alerts")
        codescan = gh_ok(f"repos/{ORG}/{repo}/code-scanning/alerts")
        secretscan = gh_ok(f"repos/{ORG}/{repo}/secret-scanning/alerts")
        protection = gh_ok(f"repos/{ORG}/{repo}/branches/{br}/protection")
        t = totals.get(repo, {})
        crit, high = t.get("critical", ""), t.get("high", "")
        health.append({
            "repo": repo,
            "default_branch": br,
            "merged_prs_30d": merged,
            "unreviewed_merges_30d": unreviewed,
            "review_coverage_pct": coverage,
            "merges_over_changes_requested": changes_req,
            "ci_pass_rate_pct": ci_rate,
            "ci_runs_sampled": ci_n,
            "dependabot_enabled": int(dependabot),
            "code_scanning_enabled": int(codescan),
            "secret_scanning_enabled": int(secretscan),
            "branch_protection": int(protection),
            "open_critical": crit,
            "open_high": high,
            "open_medium": t.get("medium", ""),
            "vuln_scanned_at": t.get("scanned_at", ""),
            "posture": posture(crit, high, unreviewed, ci_rate, secretscan, dependabot),
        })

    # vulnerabilities list (from seed CSV)
    vulns = []
    seed = os.path.join(args.out, "github_vulns_seed.csv")
    if os.path.exists(seed):
        with open(seed, newline="", encoding="utf-8") as f:
            vulns = [dict(r, id=str(i + 1)) for i, r in enumerate(csv.DictReader(f))]

    def write(name, rows):
        path = os.path.join(args.out, name)
        if not rows:
            open(path, "w").close()
            return
        with open(path, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)

    write("fact_repo_health.csv", health)
    write("fact_vulns.csv", vulns)
    print(f"Wrote fact_repo_health ({len(health)}), fact_vulns ({len(vulns)}) to {args.out}", file=sys.stderr)
    for h in health:
        print(f"  {h['repo']}: posture={h['posture']} coverage={h['review_coverage_pct']}% "
              f"ci={h['ci_pass_rate_pct']}% crit={h['open_critical']} high={h['open_high']}", file=sys.stderr)

    if args.supabase:
        # reuse the Asana ETL's Supabase writer
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import etl_asana
        etl_asana.SB_CONFLICT = dict(etl_asana.SB_CONFLICT,
                                     fact_repo_health="repo", fact_vulns="id")
        etl_asana.write_supabase({"fact_repo_health": health, "fact_vulns": vulns})


if __name__ == "__main__":
    main()
