// Fill these in before deploying, then the dashboard is shareable as-is.
// The ANON key is a PUBLIC key (safe for the browser). With auth enabled, the
// anon key alone returns NO data — users sign in and reads run under their JWT.
window.DALLAL_CONFIG = {
  SUPABASE_URL: "https://dgcxiznnyvhddzsoaxsd.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRnY3hpem5ueXZoZGR6c29heHNkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4MDI3OTksImV4cCI6MjA5ODM3ODc5OX0.EzDcpHPiP_f14eox8qVHya84f0_AaQu-2XB9l_u_HKE",

  // Which sprints appear in the dropdown / trend.
  // CURRENT_SPRINT: null = auto-detect (latest sprint with delivered work, +1).
  //                 Set a number to pin it, e.g. 11.
  // The upper end stays dynamic: window ends at CURRENT_SPRINT + 2 so new sprints
  // appear automatically as work is delivered.
  // The lower end is anchored by MIN_SPRINT (a fixed floor): the list always
  // starts at MIN_SPRINT and never rolls off the bottom. Set MIN_SPRINT: null to
  // fall back to the old rolling floor of CURRENT_SPRINT - SPRINT_BACK.
  // Window shown = [ MIN_SPRINT (or CURRENT_SPRINT - SPRINT_BACK)  ..  CURRENT_SPRINT + 2 ].
  CURRENT_SPRINT: null,
  MIN_SPRINT: 10,       // fixed floor — always show from Sprint 10 upward
  SPRINT_BACK: 2,       // rolling floor, used only when MIN_SPRINT is null
  DEFAULT_SPRINT: 10,   // fallback only — real default is the calendar sprint below

  // Calendar-driven "current running sprint": the default selection and the top of
  // the sprint window are computed from today's date, so they advance automatically
  // (no data/ETL dependency). Sprints are SPRINT_LENGTH_DAYS long, Monday-aligned.
  // Anchor = a known sprint and the Monday it started. Update only if the cadence
  // changes. e.g. Sprint 14 started Mon 2026-08-10 -> Sprint 15 = Mon 2026-08-24.
  // Set SPRINT_ANCHOR: null to fall back to the old "latest delivered + 1" heuristic.
  SPRINT_ANCHOR: { sprint: 14, start: "2026-08-10" },
  SPRINT_LENGTH_DAYS: 14,

  REQUIRE_AUTH: true,   // set false only if you intentionally want a public link
};
