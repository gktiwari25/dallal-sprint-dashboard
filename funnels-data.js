// Bundled funnel snapshot (Amplitude · UAT + PROD · last ~30d) used until the live
// Supabase `fact_funnels` table is populated by etl_amplitude.py. Tagged by env + platform.
window.DALLAL_FUNNELS = [
  {
    "env": "UAT",
    "platform": "All",
    "funnel": "Listing Creation",
    "source": "Amplitude \u00b7 Dallal-UAT \u00b7 last 30d",
    "steps": [
      {
        "name": "Listing Started",
        "users": 27
      },
      {
        "name": "Property Details",
        "users": 20
      },
      {
        "name": "Images Uploaded",
        "users": 18
      },
      {
        "name": "Location Selected",
        "users": 9
      },
      {
        "name": "PACI Verified",
        "users": 5
      },
      {
        "name": "Previewed",
        "users": 3
      },
      {
        "name": "Published",
        "users": 3
      }
    ]
  },
  {
    "env": "UAT",
    "platform": "web",
    "funnel": "Listing Creation",
    "source": "Amplitude \u00b7 Dallal-UAT \u00b7 web \u00b7 last 30d",
    "steps": [
      {
        "name": "Listing Started",
        "users": 21
      },
      {
        "name": "Property Details",
        "users": 16
      },
      {
        "name": "Images Uploaded",
        "users": 14
      },
      {
        "name": "Location Selected",
        "users": 8
      },
      {
        "name": "PACI Verified",
        "users": 3
      },
      {
        "name": "Previewed",
        "users": 0
      },
      {
        "name": "Published",
        "users": 0
      }
    ]
  },
  {
    "env": "UAT",
    "platform": "android",
    "funnel": "Listing Creation",
    "source": "Amplitude \u00b7 Dallal-UAT \u00b7 android \u00b7 last 30d",
    "steps": [
      {
        "name": "Listing Started",
        "users": 5
      },
      {
        "name": "Property Details",
        "users": 3
      },
      {
        "name": "Images Uploaded",
        "users": 3
      },
      {
        "name": "Location Selected",
        "users": 0
      },
      {
        "name": "PACI Verified",
        "users": 0
      },
      {
        "name": "Previewed",
        "users": 0
      },
      {
        "name": "Published",
        "users": 0
      }
    ]
  },
  {
    "env": "UAT",
    "platform": "ios",
    "funnel": "Listing Creation",
    "source": "Amplitude \u00b7 Dallal-UAT \u00b7 ios \u00b7 last 30d",
    "steps": [
      {
        "name": "Listing Started",
        "users": 3
      },
      {
        "name": "Property Details",
        "users": 3
      },
      {
        "name": "Images Uploaded",
        "users": 3
      },
      {
        "name": "Location Selected",
        "users": 0
      },
      {
        "name": "PACI Verified",
        "users": 0
      },
      {
        "name": "Previewed",
        "users": 0
      },
      {
        "name": "Published",
        "users": 0
      }
    ]
  },
  {
    "env": "UAT",
    "platform": "All",
    "funnel": "Property Discovery",
    "source": "Amplitude \u00b7 Dallal-UAT \u00b7 last 30d",
    "steps": [
      {
        "name": "Search",
        "users": 221
      },
      {
        "name": "View Details",
        "users": 67
      },
      {
        "name": "Gallery Viewed",
        "users": 4
      },
      {
        "name": "Property Saved",
        "users": 1
      },
      {
        "name": "Agent Contacted",
        "users": 0
      },
      {
        "name": "Chat Started",
        "users": 0
      },
      {
        "name": "Visit Scheduled",
        "users": 0
      }
    ]
  },
  {
    "env": "UAT",
    "platform": "web",
    "funnel": "Property Discovery",
    "source": "Amplitude \u00b7 Dallal-UAT \u00b7 web \u00b7 last 30d",
    "steps": [
      {
        "name": "View Details",
        "users": 72
      },
      {
        "name": "Gallery Viewed",
        "users": 8
      },
      {
        "name": "Property Saved",
        "users": 0
      },
      {
        "name": "Agent Contacted",
        "users": 0
      },
      {
        "name": "Chat Started",
        "users": 0
      },
      {
        "name": "Visit Scheduled",
        "users": 0
      }
    ]
  },
  {
    "env": "UAT",
    "platform": "android",
    "funnel": "Property Discovery",
    "source": "Amplitude \u00b7 Dallal-UAT \u00b7 android \u00b7 last 30d",
    "steps": [
      {
        "name": "View Details",
        "users": 37
      },
      {
        "name": "Gallery Viewed",
        "users": 2
      },
      {
        "name": "Property Saved",
        "users": 0
      },
      {
        "name": "Agent Contacted",
        "users": 0
      },
      {
        "name": "Chat Started",
        "users": 0
      },
      {
        "name": "Visit Scheduled",
        "users": 0
      }
    ]
  },
  {
    "env": "UAT",
    "platform": "ios",
    "funnel": "Property Discovery",
    "source": "Amplitude \u00b7 Dallal-UAT \u00b7 ios \u00b7 last 30d",
    "steps": [
      {
        "name": "View Details",
        "users": 34
      },
      {
        "name": "Gallery Viewed",
        "users": 1
      },
      {
        "name": "Property Saved",
        "users": 1
      },
      {
        "name": "Agent Contacted",
        "users": 0
      },
      {
        "name": "Chat Started",
        "users": 0
      },
      {
        "name": "Visit Scheduled",
        "users": 0
      }
    ]
  },
  {
    "env": "UAT",
    "platform": "All",
    "funnel": "User Registration",
    "source": "Amplitude \u00b7 Dallal-UAT \u00b7 last 30d",
    "steps": [
      {
        "name": "Registration Started",
        "users": 24
      },
      {
        "name": "OTP Screen",
        "users": 6
      },
      {
        "name": "OTP Verified",
        "users": 6
      },
      {
        "name": "Login Success",
        "users": 6
      }
    ]
  },
  {
    "env": "UAT",
    "platform": "web",
    "funnel": "User Registration",
    "source": "Amplitude \u00b7 Dallal-UAT \u00b7 web \u00b7 last 30d",
    "steps": [
      {
        "name": "Registration Started",
        "users": 16
      },
      {
        "name": "OTP Screen",
        "users": 2
      },
      {
        "name": "OTP Verified",
        "users": 2
      },
      {
        "name": "Login Success",
        "users": 2
      }
    ]
  },
  {
    "env": "UAT",
    "platform": "android",
    "funnel": "User Registration",
    "source": "Amplitude \u00b7 Dallal-UAT \u00b7 android \u00b7 last 30d",
    "steps": [
      {
        "name": "Registration Started",
        "users": 4
      },
      {
        "name": "OTP Screen",
        "users": 1
      },
      {
        "name": "OTP Verified",
        "users": 1
      },
      {
        "name": "Login Success",
        "users": 1
      }
    ]
  },
  {
    "env": "UAT",
    "platform": "ios",
    "funnel": "User Registration",
    "source": "Amplitude \u00b7 Dallal-UAT \u00b7 ios \u00b7 last 30d",
    "steps": [
      {
        "name": "Registration Started",
        "users": 4
      },
      {
        "name": "OTP Screen",
        "users": 3
      },
      {
        "name": "OTP Verified",
        "users": 3
      },
      {
        "name": "Login Success",
        "users": 3
      }
    ]
  },
  {
    "env": "PROD",
    "platform": "All",
    "funnel": "Listing Creation",
    "source": "Amplitude \u00b7 Dallal-PROD \u00b7 last 30d",
    "steps": [
      {
        "name": "Listing Started",
        "users": 12
      },
      {
        "name": "Property Details",
        "users": 10
      },
      {
        "name": "Photos Added",
        "users": 9
      },
      {
        "name": "Property Review",
        "users": 7
      },
      {
        "name": "Published",
        "users": 5
      }
    ]
  },
  {
    "env": "PROD",
    "platform": "All",
    "funnel": "Property Discovery",
    "source": "Amplitude \u00b7 Dallal-PROD \u00b7 last 30d",
    "steps": [
      {
        "name": "Search",
        "users": 2
      },
      {
        "name": "View Details",
        "users": 0
      },
      {
        "name": "Gallery Viewed",
        "users": 0
      },
      {
        "name": "Property Saved",
        "users": 0
      },
      {
        "name": "Agent Contacted",
        "users": 0
      },
      {
        "name": "Chat Started",
        "users": 0
      }
    ]
  },
  {
    "env": "PROD",
    "platform": "All",
    "funnel": "User Registration",
    "source": "Amplitude \u00b7 Dallal-PROD \u00b7 last 30d",
    "steps": [
      {
        "name": "Registration Started",
        "users": 10
      },
      {
        "name": "Signed Up",
        "users": 2
      },
      {
        "name": "OTP Verified",
        "users": 2
      },
      {
        "name": "Login Success",
        "users": 1
      }
    ]
  }
];
