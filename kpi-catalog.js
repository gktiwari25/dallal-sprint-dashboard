/* ===========================================================================
 * kpi-catalog.js  —  Source of truth for the Dallal KPI Command Center
 * ---------------------------------------------------------------------------
 * Every row is transcribed verbatim from Dallal_KPIs_Gourav.xlsx -> "My KPIs"
 * (GOURAV | 22 KPIs | base 13 Sep 2026).  The workbook columns are preserved:
 *   id, name, definition, section, type, unit, supports, checks,
 *   source (workbook "Data source"), frequency, base ("Base 13 Sep 26"),
 *   measuredToday ("Measured today"), agreed, comment ("Your comment").
 *
 * The *.map block is NOT from the workbook — it is the engineering mapping of
 * each KPI to its real, inspected data source so the dashboard never fabricates
 * a value. `avail` is one of:
 *   live    - computed in-browser from a Supabase table (requires sign-in/RLS)
 *   derived - computed, but a best-effort proxy (clearly labelled in the UI)
 *   etl     - available only via the authorised admin-API ETL (fact_push_kpis)
 *   manual  - no automated source; manual attestation / workbook entry
 *   none    - not instrumented yet (shows the required instrumentation)
 *
 * NO numeric targets are defined here: the workbook carries no approved target
 * for any row (every "Base 13 Sep 26" is N/A). Per the brief, targets are only
 * shown when an approved target exists, so `target` stays null everywhere.
 * ======================================================================== */
window.KPI_META = {
  workbook: "Dallal_KPIs_Gourav.xlsx",
  owner: "Gourav",
  base: "13 Sep 2026",
  count: 22,
  sections: ["ALERTS AND NOTIFICATIONS", "DELIVERY", "ROLLOUT CALENDAR"],
};

/* The authorised integration contract for the Alerts & Notifications group.
 * Direct browser access is impossible: the admin API returns HTTP 401 without
 * an admin JWT and sends no Access-Control-Allow-Origin header (CSP connect-src
 * 'self'), so GitHub Pages cannot call it. etl_push.py performs the server-side
 * fetch and writes fact_push_kpis; the dashboard reads that table. */
window.PUSH_CONTRACT = {
  endpoint: "GET https://uat-api.dallal.com.kw/api/admin/analytics/push_notifications",
  params: "?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD  (max range 90 days)",
  auth: "Authorization: Bearer <admin JWT>",
  blocked_in_browser: ["admin auth (401 for anon)", "no CORS allow-origin from gktiwari25.github.io"],
  etl: "etl_push.py -> table fact_push_kpis (period_key, kpi_id, value, ...)",
};

window.KPI_CATALOG = [
  /* ----------------------- A. ALERTS AND NOTIFICATIONS ---------------------
   * All eight are computed by the UAT Admin Analytics page (Push Notifications
   * section) from the Dallal database + event log. The exact response fields
   * are recorded in map.pushField for etl_push.py and the detail panel. */
  {
    id: "A10", name: "Seekers opted in to push",
    definition: "D1 x T9. Seekers opted in to push.",
    section: "ALERTS AND NOTIFICATIONS", type: "Diagnostic", unit: "People",
    supports: "Anas, Rayan", checks: "Nassar",
    source: "Dallal database and event log", frequency: "Monthly",
    base: "N/A", measuredToday: "No", agreed: "Yes", comment: "",
    map: { avail: "etl", unitKind: "count", summary: true,
      pushField: "seekers_opted_in.value",
      formula: "Distinct seekers with push enabled at period end.",
      note: "Served by UAT Admin Analytics -> Push Notifications (Seekers opted in). Monthly KPI; the live source window is a rolling date range, so pick 'This Month'/'Last Month' for a true calendar month." } },
  {
    id: "A11", name: "Notifications sent per opted-in seeker a month",
    definition: "Notifications sent in the month over A10.",
    section: "ALERTS AND NOTIFICATIONS", type: "Diagnostic", unit: "Ratio",
    supports: "Anas, Rayan", checks: "Nassar",
    source: "Dallal database and event log", frequency: "Monthly",
    base: "N/A", measuredToday: "No", agreed: "Yes", comment: "",
    map: { avail: "etl", unitKind: "ratio_raw", summary: false,
      pushField: "notifications_sent_per_opted_in_seeker.per_seeker",
      formula: "notifications_sent / opted_in_seekers.",
      note: "A ratio (sends per seeker), not a percentage. Use a calendar-month window to match the Monthly definition." } },
  {
    id: "A12", name: "Notifications sent",
    definition: "A10 x A11. All push notifications sent.",
    section: "ALERTS AND NOTIFICATIONS", type: "Diagnostic", unit: "Events",
    supports: "Anas, Rayan", checks: "Nassar",
    source: "Dallal database and event log", frequency: "Monthly",
    base: "N/A", measuredToday: "No", agreed: "Yes", comment: "",
    map: { avail: "etl", unitKind: "count", summary: false,
      pushField: "notifications_sent.value",
      formula: "Count of push notifications sent in the window (by_channel: FCM + CometChat).",
      note: "Source splits by platform and channel (fcm/cometchat)." } },
  {
    id: "A14", name: "Notification taps",
    definition: "A12 x A13.",
    section: "ALERTS AND NOTIFICATIONS", type: "Diagnostic", unit: "Events",
    supports: "Anas, Rayan", checks: "Nassar",
    source: "Dallal database and event log", frequency: "Monthly",
    base: "N/A", measuredToday: "No", agreed: "Yes", comment: "",
    map: { avail: "etl", unitKind: "count", summary: true,
      pushField: "notification_taps.value",
      companion: { label: "Tap rate", pushField: "notification_taps.tap_rate_percentage", unitKind: "pct" },
      formula: "Count of taps on sent notifications. Engagement = taps / sent in range (the A13 factor).",
      note: "The source also exposes tap_rate_percentage (the implicit A13); shown as the engagement companion." } },
  {
    id: "A19", name: "Saved-search alerts matched by a new listing within 7 days",
    definition: "Saved-search alerts that received at least one new matching listing within 7 days of creation, over alerts created.",
    section: "ALERTS AND NOTIFICATIONS", type: "Outcome", unit: "Ratio",
    supports: "Anas, Rayan", checks: "Nassar",
    source: "Dallal database and event log", frequency: "Monthly",
    base: "N/A", measuredToday: "No", agreed: "Yes", comment: "",
    map: { avail: "etl", unitKind: "pct", summary: true,
      pushField: "saved_search_alerts_matched_within_7_days",
      formula: "alerts matched within 7 days / alerts created (only alerts old enough to have a full 7-day window are 'measurable').",
      note: "Source reports value, measurable and pending_window. N/A until enough alerts have completed their 7-day window." } },
  {
    id: "A20", name: "Push opt-out rate (monthly)",
    definition: "Opted-in seekers who disable push in the month, over opted-in seekers at the start of the month.",
    section: "ALERTS AND NOTIFICATIONS", type: "Outcome", unit: "Ratio",
    supports: "Anas, Rayan", checks: "Nassar",
    source: "Dallal database and event log", frequency: "Monthly",
    base: "N/A", measuredToday: "No", agreed: "Yes", comment: "",
    map: { avail: "etl", unitKind: "pct", summary: false, lowerIsBetter: true,
      pushField: "push_opt_out_rate.opt_out_rate_percentage",
      formula: "opt_outs / opted_in_at_start.",
      note: "Lower is better. Use a calendar-month window to honour the Monthly definition." } },
  {
    id: "A21", name: "Notifications dismissed unopened or marked not relevant",
    definition: "Notifications dismissed without opening or marked not relevant, over notifications sent.",
    section: "ALERTS AND NOTIFICATIONS", type: "Outcome", unit: "Ratio",
    supports: "Anas, Rayan", checks: "Nassar",
    source: "Dallal database and event log", frequency: "Monthly",
    base: "N/A", measuredToday: "No", agreed: "Yes", comment: "",
    map: { avail: "etl", unitKind: "count", summary: false, lowerIsBetter: true,
      pushField: "notifications_unopened_over_7_days.value + notifications_marked_not_relevant.value",
      formula: "unopened > 7 days + marked not relevant (both exposed by the source, over notifications sent).",
      note: "Two source measures combined per the workbook definition. Lower is better." } },
  {
    id: "A22", name: "Lister enquiry notifications delivered within 1 minute",
    definition: "Enquiry notifications delivered to the lister within 60 seconds of the enquiry, over enquiry notifications sent.",
    section: "ALERTS AND NOTIFICATIONS", type: "Outcome", unit: "Ratio",
    supports: "Anas, Rayan", checks: "Nassar",
    source: "Dallal database and event log", frequency: "Daily",
    base: "N/A", measuredToday: "No", agreed: "Yes", comment: "",
    map: { avail: "etl", unitKind: "pct", summary: false,
      pushField: "enquiry_notifications_within_1_minute.percentage",
      formula: "enquiry notifications delivered <= 60s / enquiry notifications sent (sla_seconds = 60).",
      note: "Daily KPI (SLA 60s). Source reports percentage, value and measurable." } },

  /* ------------------------------ B. DELIVERY ------------------------------ */
  {
    id: "DL1", name: "Stories delivered in the sprint committed",
    definition: "Stories delivered in the sprint they were committed to, over stories committed.",
    section: "DELIVERY", type: "Outcome", unit: "Ratio",
    supports: "Anas, Rayan", checks: "Nassar",
    source: "Engineering tools and trackers", frequency: "Monthly",
    base: "N/A", measuredToday: "Yes", agreed: "Yes",
    comment: "We are measuring this here - https://gktiwari25.github.io/dallal-sprint-dashboard",
    map: { avail: "live", unitKind: "pct", summary: true, table: "fact_workitems / dim_sprint",
      formula: "delivered story points / committed story points, summed over the sprints in the period (pre-sprint and PM/lead assignees excluded; falls back to item counts when a sprint has no points). Mirrors the sprint dashboard's commitment logic.",
      note: "Sprint-based (Monthly). The period picker selects the sprint(s) whose dates fall in the window." } },
  {
    id: "DL2", name: "Releases in the month",
    definition: "Production releases in the month.",
    section: "DELIVERY", type: "Diagnostic", unit: "Count",
    supports: "Anas, Rayan", checks: "Nassar",
    source: "Engineering tools and trackers", frequency: "Monthly",
    base: "N/A", measuredToday: "Yes", agreed: "Yes", comment: "We are realising every sprint",
    map: { avail: "derived", unitKind: "count", summary: true, table: "fact_appstore_metrics",
      formula: "Count of distinct iOS app_version values seen in the period (App Store Connect).",
      note: "Best-effort proxy: there is no release log. iOS build versions are the only versioned release signal; Android builds are not versioned in the feed, and web/backend deploys are untracked. Treat as a lower bound." } },
  {
    id: "DL3", name: "Releases with no rollback or hotfix",
    definition: "Releases with no rollback or hotfix within 7 days, over DL2.",
    section: "DELIVERY", type: "Outcome", unit: "Ratio",
    supports: "Anas, Rayan", checks: "Nassar",
    source: "Engineering tools and trackers", frequency: "Monthly",
    base: "N/A", measuredToday: "Yes", agreed: "Yes", comment: "We have not rollback any sprint deployment",
    map: { avail: "manual", unitKind: "pct", summary: false,
      formula: "releases with no rollback/hotfix within 7 days / DL2.",
      note: "Not instrumented: rollbacks/hotfixes are not recorded in any data source. PM attestation on the workbook is 'no rollbacks to date'. Needs a release/rollback log (e.g. a 'release' tracker with rollback flag) before it can be computed." } },
  {
    id: "DL4", name: "Bugs found in production per release",
    definition: "Bugs found in production within 14 days of release, per release.",
    section: "DELIVERY", type: "Outcome", unit: "Count",
    supports: "Anas, Rayan", checks: "Nassar",
    source: "Engineering tools and trackers", frequency: "Monthly",
    base: "N/A", measuredToday: "Yes", agreed: "Yes",
    comment: "We are measuring this here - https://gktiwari25.github.io/dallal-sprint-dashboard",
    map: { avail: "live", unitKind: "count1", summary: true, lowerIsBetter: true, table: "fact_workitems",
      formula: "count(bugs with found_in = 'Prod' created in the period) / number of sprints in the period.",
      note: "Per-sprint proxy for 'per release' (same approach as the sprint dashboard). The '14 days of release' clause can't be applied without a per-bug release link." } },
  {
    id: "DL5", name: "Open bugs older than 14 days",
    definition: "Open bugs older than 14 days at month end.",
    section: "DELIVERY", type: "Outcome", unit: "Count",
    supports: "Anas, Rayan", checks: "Nassar",
    source: "Engineering tools and trackers", frequency: "Monthly",
    base: "N/A", measuredToday: "Yes", agreed: "Yes",
    comment: "We are measuring this here - https://gktiwari25.github.io/dallal-sprint-dashboard",
    map: { avail: "live", unitKind: "count", summary: true, lowerIsBetter: true, table: "fact_workitems", snapshot: true,
      formula: "count(bug AND not done AND (now - created_at) > 14 days), excluding PM/lead assignees and future-sprint items.",
      note: "A point-in-time snapshot (current open backlog), not a windowed metric. Shown as-of now regardless of the period picker." } },
  {
    id: "DL6", name: "Critical bugs fixed within 24 hours",
    definition: "Critical bugs fixed within 24 hours of report, over critical bugs reported.",
    section: "DELIVERY", type: "Outcome", unit: "Ratio",
    supports: "Anas, Rayan", checks: "Nassar",
    source: "Engineering tools and trackers", frequency: "Monthly",
    base: "N/A", measuredToday: "Yes", agreed: "Yes",
    comment: "We are measuring this here - https://gktiwari25.github.io/dallal-sprint-dashboard",
    map: { avail: "live", unitKind: "pct", summary: true, table: "fact_workitems",
      formula: "count(critical bugs reported in period AND completed within 24h of created_at) / count(critical bugs reported in period). Critical = priority P0/P1.",
      note: "Denominator follows the workbook ('over critical bugs reported'). N/A in periods with no critical bugs reported." } },
  {
    id: "DL7", name: "Cycle time: story approved to released, days",
    definition: "Median days from story approved to released.",
    section: "DELIVERY", type: "Outcome", unit: "Days",
    supports: "Anas, Rayan", checks: "Nassar",
    source: "Engineering tools and trackers", frequency: "Monthly",
    base: "N/A", measuredToday: "Yes", agreed: "Yes",
    comment: "We are measuring this here - https://gktiwari25.github.io/dallal-sprint-dashboard",
    map: { avail: "live", unitKind: "days", summary: false, lowerIsBetter: true, table: "fact_cycle_time",
      formula: "median(cycle_days) over stories whose released_at falls in the period. cycle_days = released_at - approved_at (first move into 'Sprint Planned' to first move into 'Released'), from the Asana activity log.",
      note: "Precomputed by etl_cycle_time.py. Readable without sign-in (anon RLS)." } },
  {
    id: "DL8", name: "Instrumentation backlog items delivered on schedule",
    definition: "Instrumentation backlog items delivered by their scheduled date, over items scheduled in the month.",
    section: "DELIVERY", type: "Outcome", unit: "Ratio",
    supports: "Anas, Rayan", checks: "Nassar",
    source: "Engineering tools and trackers", frequency: "Monthly",
    base: "N/A", measuredToday: "Yes", agreed: "Yes",
    comment: "We are measuring this here - https://gktiwari25.github.io/dallal-sprint-dashboard",
    map: { avail: "none", unitKind: "pct", summary: false,
      formula: "instrumentation items delivered by scheduled date / items scheduled in month.",
      note: "Not instrumented: no 'instrumentation backlog' tag or scheduled-date field exists in the tracker. Needs an Asana tag/section + a scheduled-date custom field." } },
  {
    id: "DL9", name: "Automated test coverage of core flows",
    definition: "Core flows (search, listing create, message, register) covered by automated tests, over core flows.",
    section: "DELIVERY", type: "Outcome", unit: "Ratio",
    supports: "Anas, Rayan", checks: "Nassar",
    source: "Engineering tools and trackers", frequency: "Monthly",
    base: "N/A", measuredToday: "No", agreed: "Yes",
    comment: "https://gktiwari25.github.io/dallal-sprint-dashboard",
    map: { avail: "none", unitKind: "pct", summary: false,
      formula: "core flows with automated test coverage / 4 core flows (search, listing create, message, register).",
      note: "Not instrumented. fact_repo_health has code-review coverage %, which is NOT test coverage. Needs a CI coverage report mapped to the 4 named flows." } },
  {
    id: "F15", name: "Public changelog entries in the month (dallal.com.kw/whats-new)",
    definition: "Entries added to the public changelog in the month.",
    section: "DELIVERY", type: "Diagnostic", unit: "Count",
    supports: "Anas, Rayan", checks: "Nassar",
    source: "Engineering tools and trackers", frequency: "Monthly",
    base: "N/A", measuredToday: "Yes", agreed: "Yes",
    comment: "We do add Quarter wise, Q3 will be added before Quarter end",
    map: { avail: "manual", unitKind: "count", summary: false,
      formula: "count of entries added to dallal.com.kw/whats-new in the month.",
      note: "No feed/scraper for the changelog yet. Entries are added quarterly (PM note). Needs a scrape of /whats-new or a manual monthly count." } },
  {
    id: "DL10", name: "Roadmap milestones shipped in the half-year promised",
    definition: "Roadmap milestones shipped within the half-year promised on the public roadmap, over milestones due.",
    section: "DELIVERY", type: "Outcome", unit: "Ratio",
    supports: "Anas, Rayan", checks: "Nassar",
    source: "Engineering tools and trackers", frequency: "Monthly",
    base: "N/A", measuredToday: "No", agreed: "Yes",
    comment: "We will be needing roadmap for full year to comment on this...",
    decision: "Kept. Gourav to write the full-year roadmap from the 133-feature rollout catalogue; measurement starts the month after he returns it with dates.",
    map: { avail: "none", unitKind: "pct", summary: false,
      formula: "milestones shipped within promised half-year / milestones due.",
      note: "Measurement deferred by decision until the full-year roadmap with dates is written. No source until then." } },
  {
    id: "X1", name: "Crash-free sessions",
    definition: "Sessions without a crash, over all sessions.",
    section: "DELIVERY", type: "Outcome", unit: "Ratio",
    supports: "Anas, Rayan", checks: "Nassar",
    source: "Engineering tools and trackers", frequency: "Daily",
    base: "N/A", measuredToday: "Yes", agreed: "Yes", comment: "Sentry + Crashanalytics",
    map: { avail: "live", unitKind: "pct", summary: true, table: "fact_appstore_metrics",
      formula: "100 x (1 - sum(crashes) / sum(sessions)) over the period, iOS only (App Store Connect).",
      note: "iOS approximation. Only App Store Connect sessions+crashes are in the data; there is no Sentry feed and Android reports crashes but not sessions. Eng SLA reference is 99.5% (not an approved KPI target)." } },

  /* -------------------------- C. ROLLOUT CALENDAR -------------------------- */
  {
    id: "LC24", name: "Oct-28: Reserve: slippage and hardening",
    definition: "Stage at month end: 0 not started, 1 in build, 2 beta, 3 live. Planned live Oct-28.",
    section: "ROLLOUT CALENDAR", type: "Milestone", unit: "Stage",
    supports: "Anas, Rayan", checks: "Nassar",
    source: "Delivery tracker", frequency: "Monthly",
    base: "N/A", measuredToday: "No", agreed: "Yes", comment: "",
    map: { avail: "manual", unitKind: "stage", summary: false, plannedDate: "2026-10-28",
      formula: "Stage 0-3 at month end (0 not started, 1 in build, 2 beta, 3 live).",
      note: "No stage feed in the delivery tracker yet. Planned live 28 Oct 2026. Stage is a manual monthly entry until the rollout tracker exposes it." } },
  {
    id: "LC25", name: "Nov-28: Reserve: slippage and hardening",
    definition: "Stage at month end: 0 not started, 1 in build, 2 beta, 3 live. Planned live Nov-28.",
    section: "ROLLOUT CALENDAR", type: "Milestone", unit: "Stage",
    supports: "Anas, Rayan", checks: "Nassar",
    source: "Delivery tracker", frequency: "Monthly",
    base: "N/A", measuredToday: "No", agreed: "Yes", comment: "",
    map: { avail: "manual", unitKind: "stage", summary: false, plannedDate: "2026-11-28",
      formula: "Stage 0-3 at month end (0 not started, 1 in build, 2 beta, 3 live).",
      note: "No stage feed in the delivery tracker yet. Planned live 28 Nov 2026. Stage is a manual monthly entry until the rollout tracker exposes it." } },
];

window.ROLLOUT_STAGES = { 0: "Not started", 1: "In build", 2: "Beta", 3: "Live" };
