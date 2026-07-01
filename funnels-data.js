// Bundled funnel snapshot (Amplitude · Dallal-UAT · last 30 days) used until the
// live Supabase `fact_funnels` table is populated by etl_amplitude.py.
window.DALLAL_FUNNELS = [
  { funnel: "Listing Creation", source: "Amplitude · Dallal-UAT · last 30d", steps: [
    { name: "Listing Started", users: 27 },
    { name: "Property Details", users: 20 },
    { name: "Images Uploaded", users: 18 },
    { name: "Location Selected", users: 9 },
    { name: "PACI Verified", users: 5 },
    { name: "Previewed", users: 3 },
    { name: "Published", users: 3 }
  ]},
  { funnel: "Property Discovery", source: "Amplitude · Dallal-UAT · last 30d", steps: [
    { name: "Search", users: 221 },
    { name: "View Details", users: 67 },
    { name: "Gallery Viewed", users: 4 },
    { name: "Property Saved", users: 1 },
    { name: "Agent Contacted", users: 0 },
    { name: "Chat Started", users: 0 },
    { name: "Visit Scheduled", users: 0 }
  ]},
  { funnel: "User Registration", source: "Amplitude · Dallal-UAT · last 30d (OTP/registration steps use proxies)", steps: [
    { name: "App Session", users: 625 },
    { name: "Registration Started", users: 264 },
    { name: "OTP Screen", users: 110 },
    { name: "OTP Verified", users: 7 },
    { name: "Login Success", users: 0 }
  ]}
];
