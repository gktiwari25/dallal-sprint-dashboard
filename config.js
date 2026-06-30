// Fill these in before deploying, then the dashboard is shareable as-is.
// The ANON key is a PUBLIC key (safe for the browser). With auth enabled, the
// anon key alone returns NO data — users sign in and reads run under their JWT.
window.DALLAL_CONFIG = {
  SUPABASE_URL: "https://dgcxiznnyvhddzsoaxsd.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRnY3hpem5ueXZoZGR6c29heHNkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4MDI3OTksImV4cCI6MjA5ODM3ODc5OX0.EzDcpHPiP_f14eox8qVHya84f0_AaQu-2XB9l_u_HKE",

  // Which sprints appear in the dropdown / trend.
  // CURRENT_SPRINT: null = auto-detect (latest sprint with delivered work, +1).
  //                 Set a number to pin it, e.g. 11.
  // Window shown = [CURRENT_SPRINT - SPRINT_BACK  ..  CURRENT_SPRINT + 2].
  CURRENT_SPRINT: null,
  SPRINT_BACK: 2,
  DEFAULT_SPRINT: 10,   // sprint selected on load (falls back to newest in-window)

  REQUIRE_AUTH: true,   // set false only if you intentionally want a public link
};
