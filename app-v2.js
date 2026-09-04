/* Dallal Sprint Dashboard - Supabase-auth-gated, reads via authenticated JWT.
   Metric definitions mirror the original DAX. Plain ES2017+, no build step. */
(function () {
  "use strict";

  var DONE_STATUSES = ["Released", "UAT Passed", "Ready for Production"];
  var IN_QA_STATUSES = ["QA on Dev", "In UAT", "Ready for UAT"];
  var READY_STATUSES = ["UAT Passed", "Ready for Production"];

  var cfg = window.DALLAL_CONFIG || {};
  var URL_ = cfg.SUPABASE_URL || "";
  var KEY_ = cfg.SUPABASE_ANON_KEY || "";
  var DEFAULT_SPRINT = cfg.DEFAULT_SPRINT || null;
  var SPRINT_BACK = (cfg.SPRINT_BACK != null) ? cfg.SPRINT_BACK : 2;
  var MIN_SPRINT = (cfg.MIN_SPRINT != null) ? Number(cfg.MIN_SPRINT) : null;
  var REQUIRE_AUTH = cfg.REQUIRE_AUTH !== false;

  var data = { items: [], sprints: [], flow: [], risks: [], burndown: [], repos: [], vulns: [], funnels: [], abandoned: [], reengage: [], appstore: [] };
  var velChart, statusChart, burnChart, vulnChart, sbc = null, loadedOnce = false, selectedSprint = null, _collapse = {};

  // ---------- helpers ----------
  function num(v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; }
  // Accurate reopen count per task (from fact_reopens: Reopen-column moves merged
  // with the manual "Reopened Count" field). Falls back to the raw field only if the
  // reopen table hasn't loaded yet. Set in loadAll().
  var _reopenMap = {};
  function reopenCount(i) { var v = _reopenMap[i.task_gid]; return v == null ? num(i.reopened_count) : num(v); }
  function pct(x) { return (x == null || isNaN(x)) ? "--" : (Math.round(x * 1000) / 10) + "%"; }
  function el(id) { return document.getElementById(id); }
  function show(id) { el(id).classList.remove("hidden"); }
  function hide(id) { el(id).classList.add("hidden"); }
  function isConfigured() { return URL_ && KEY_ && URL_.indexOf("your-project-ref") === -1; }

  function card(label, value, opts) {
    opts = opts || {};
    var ragHtml = opts.rag ? '<span class="rag ' + opts.rag + '">' + opts.ragText + "</span>" : "";
    var barHtml = (opts.bar != null)
      ? '<div class="bar"><span style="width:' + Math.max(0, Math.min(100, opts.bar)) + '%;background:' + (opts.barColor || "var(--teal)") + '"></span></div>'
      : "";
    var valHtml = opts.rag ? ragHtml : ('<div class="value">' + value + "</div>");
    var tipIcon = opts.tip ? ' <span class="tip" data-tip="' + escAttr(opts.tip) + '">i</span>' : "";
    var iconHtml = opts.icon ? '<span class="icon">' + opts.icon + "</span>" : "";
    var accent = opts.accent ? ' style="border-top:3px solid ' + opts.accent + '"' : "";
    return '<div class="card"' + accent + ">" + iconHtml + '<div class="label">' + label + tipIcon + "</div>" + valHtml + barHtml + "</div>";
  }

  // ---------- graphical helpers (gauges / mini charts) ----------
  var _charts = {};
  function mkChart(id, cfg) { if (_charts[id]) _charts[id].destroy(); _charts[id] = new Chart(el(id), cfg); }
  function gaugeColor(p) { p = p || 0; return p >= 0.85 ? "#2e7d32" : p >= 0.6 ? "#f29f05" : "#c62828"; }
  function gaugeTile(id, label, percent, color) {
    var txt = (percent == null || isNaN(percent)) ? "--" : Math.round(percent * 100) + "%";
    return '<div class="gauge"><div class="gwrap"><canvas id="' + id + '"></canvas>' +
      '<div class="gctr" style="color:' + color + '">' + txt + "</div></div>" +
      '<div class="glabel">' + label + "</div></div>";
  }
  function drawGauge(id, percent, color) {
    var v = Math.max(0, Math.min(100, (percent || 0) * 100));
    mkChart(id, { type: "doughnut",
      data: { datasets: [{ data: [v, 100 - v], backgroundColor: [color, "#eef1f5"], borderWidth: 0 }] },
      options: { cutout: "76%", responsive: true, maintainAspectRatio: true,
        plugins: { legend: { display: false }, tooltip: { enabled: false } }, animation: { duration: 600 } } });
  }
  function ragFor(p) { if (p >= 0.85) return ["green", "On Track"]; if (p >= 0.6) return ["amber", "At Risk"]; return ["red", "Off Track"]; }
  // Sprint Goal is timeline-aware: a just-started sprint with active work is "In
  // Progress", not "Off Track". Off Track only if work stalled with low completion.
  function goalRag(m) {
    if (m.planned > 0 && m.completed >= m.planned) return ["green", "Complete"];
    if (m.progress != null && m.progress >= 0.85) return ["green", "On Track"];
    if ((m.inDev + m.inQA) > 0) return ["amber", "In Progress"];
    if (m.progress != null && m.progress >= 0.6) return ["amber", "At Risk"];
    return ["red", "Off Track"];
  }
  function esc(s) { return (s == null ? "" : String(s)).replace(/[&<>]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]; }); }
  function escAttr(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

  // ---------- shared floating tooltip ----------
  // One reusable element positioned by JS on hover of any `.tip[data-tip]`. It is
  // appended to <body> (so it never inherits the card titles' UPPERCASE) and its
  // position is clamped to the viewport, so a tooltip can't overflow a card edge,
  // slide behind the sidebar, or get clipped — anywhere on the dashboard.
  (function () {
    var tipEl = null;
    function ensure() {
      if (!tipEl) { tipEl = document.createElement("div"); tipEl.id = "gtip"; document.body.appendChild(tipEl); }
      return tipEl;
    }
    function place(target) {
      var t = target.getAttribute("data-tip"); if (!t) return;
      var el = ensure();
      el.textContent = t;
      el.style.left = "0px"; el.style.top = "0px";   // reset before measuring
      el.classList.add("on");
      var r = target.getBoundingClientRect();
      var w = el.offsetWidth, h = el.offsetHeight, m = 10, vw = window.innerWidth, vh = window.innerHeight;
      // Prefer above the icon; drop below only if there isn't room above.
      var top = r.top - h - 10;
      if (top < m) top = Math.min(r.bottom + 10, vh - h - m);
      // Centre on the icon, then clamp horizontally inside the viewport.
      var left = r.left + r.width / 2 - w / 2;
      left = Math.max(m, Math.min(left, vw - w - m));
      el.style.left = left + "px"; el.style.top = Math.max(m, top) + "px";
    }
    function hide() { if (tipEl) tipEl.classList.remove("on"); }
    document.addEventListener("mouseover", function (e) {
      var t = e.target && e.target.closest ? e.target.closest(".tip[data-tip]") : null;
      if (t) place(t);
    });
    document.addEventListener("mouseout", function (e) {
      var t = e.target && e.target.closest ? e.target.closest(".tip[data-tip]") : null;
      if (t && (!e.relatedTarget || !t.contains(e.relatedTarget))) hide();
    });
    document.addEventListener("scroll", hide, true);
  })();
  // A ticket is a bug if its title contains "BUG" (team convention) or Type=Bug.
  // Only work items whose TYPE is "Bug" count as bugs — Feature / Enhancement / Requirement
  // items are never counted as bugs, even if "bug" appears in their title.
  function isBug(i) { return /^bug$/i.test(String(i.type || "").trim()); }
  // The board SECTION (column) is the source of truth for where a ticket is — the
  // Status custom field is often left stale — so all stage counts use the section.
  function sectionStage(sec) {
    sec = sec || "";
    if (sec === "Blocked") return "blocked";
    if (/Released/i.test(sec)) return "released";
    if (/UAT Passed|Ready for Production/i.test(sec)) return "ready";
    if (/QA on Dev|QA on UAT|Ready for UAT|In UAT/i.test(sec)) return "qa";
    if (/In Development|Code Review|Merged to Develop|Sub-tasks|Reopen/i.test(sec)) return "dev";
    if (/Backlog|Ready for Development|Sprint Planned|Refinement|Design/i.test(sec)) return "planned";
    return "other";
  }
  // "Done" / Delivered = dev is complete and the story has reached the UAT pipeline
  // or beyond — Ready for UAT, QA on UAT, In UAT, UAT Passed, Ready for Production,
  // Released — or the Asana complete flag. Work still In Development / QA on Dev /
  // Reopen / not-yet-started (Ready for Development) / Blocked is NOT delivered; it
  // is what carries forward. (The "Released" card below still counts only the
  // Released column — actually shipped to production.)
  function isDone(i) { return !!i.completed_at || i.is_completed === true || String(i.is_completed) === "1" || String(i.is_delivered) === "1" || /Ready for UAT|QA on UAT|In UAT|UAT Passed|Ready for Production|Released/i.test(i.section || ""); }
  // On-hold work is parked, not actively "not yet completed" — exclude it from the
  // open/remaining list (status enum "On hold"; also matches a Blocked/On-hold section).
  function isOnHold(i) { return /on\s*-?\s*hold/i.test(i.status || "") || /on\s*-?\s*hold/i.test(i.section || ""); }
  // Risks tied to repos/security live on the Engineering tab, not the delivery Risks list.
  function isEngRisk(r) { return (r.category || "") === "Security"; }
  var ASANA_TASK = "https://app.asana.com/0/1214388950902741/";
  function shortPri(p) { return p ? String(p).split(" ")[0] : "—"; }
  function priClass(p) { p = p || ""; return p.indexOf("P1") === 0 ? "red" : p.indexOf("P2") === 0 ? "amber" : p.indexOf("P3") === 0 ? "blue" : "grey"; }
  function taskRow(it) {
    return '<div class="taskrow">' +
      '<span class="trbadge ' + priClass(it.priority) + '">' + shortPri(it.priority) + "</span>" +
      '<span class="trname" title="' + escAttr(it.name) + '">' + esc(it.name) + "</span>" +
      '<span class="trstatus">' + esc(it.status || "") + "</span>" +
      '<a class="tasklink" href="' + ASANA_TASK + it.task_gid + '" target="_blank" rel="noopener">Open &#8599;</a></div>';
  }
  // Row for a reopened ticket: shows current board column (state) + how many times it
  // was moved back into the Reopen column (reopenCount, from the Asana activity log
  // merged with the manual field).
  function reopenedRow(it) {
    var n = reopenCount(it);
    var state = it.section || it.status || "—";
    var done = isDone(it);
    var who = it.assignee ? esc(it.assignee) : '<span class="muted">Unassigned</span>';
    return '<div class="taskrow">' +
      '<span class="trbadge ' + priClass(it.priority) + '">' + shortPri(it.priority) + "</span>" +
      '<span class="trname" title="' + escAttr(it.name) + '">' + esc(it.name) + "</span>" +
      '<span class="trwho" title="Assignee">👤 ' + who + "</span>" +
      '<span class="uat-age ' + (done ? "ok" : "warn") + '" title="Current board column">' + esc(state) + "</span>" +
      '<span class="uat-age ' + (n >= 3 ? "over" : "warn") + '" title="Times reopened / sent back for rework">🔁 ' + n + "×</span>" +
      '<a class="tasklink" href="' + ASANA_TASK + it.task_gid + '" target="_blank" rel="noopener">Open &#8599;</a></div>';
  }
  // Collapsible list block (native <details>) that remembers open/closed across re-renders.
  function listBlock(id, title, rowsHtml) {
    var open = _collapse[id] === true; // default collapsed; remembers a user's toggle in-session
    return '<details class="lb" data-lb="' + id + '"' + (open ? " open" : "") +
      '><summary class="listhdr">' + title + "</summary>" + rowsHtml + "</details>";
  }
  function riskCardHtml(r) {
    var k = (r.rag || "").toLowerCase();
    return '<div class="riskcard ' + k + '"><div class="rt"><span class="rag ' + k + '">' + esc(r.rag || "?") + "</span>" +
      '<span class="name">' + esc(r.risk_name) + "</span>" +
      '<span class="meta">' + esc(r.category || "") + " &middot; " + esc(r.owner || "") + " &middot; " + esc(r.status || "") + "</span></div>" +
      (r.impact ? '<div class="kvline"><b>Impact:</b> ' + linkify(r.impact) + "</div>" : "") +
      (r.mitigation ? '<div class="kvline"><b>Mitigation / action:</b> ' + linkify(r.mitigation) + "</div>" : "") + "</div>";
  }

  // ---------- metric computation ----------
  // Still-ideating columns excluded from every delivery/status metric — work that's
  // only an idea or in design, NOT yet committed. Excluded board columns:
  //   • Backlog - Idea / Refinement / Design
  //   • Design In-Progress
  // INCLUDED (committed scope): "Ready for Development (handoff complete)" and every
  // downstream column (In Development, QA, UAT, Released, Reopen, Sprint Planned…).
  function isPreSprint(i) {
    return /backlog\s*-\s*idea|design\s*in-?progress/i.test(i.section || "");
  }
  // Committed vs delivered SP for ONE sprint number (same rules as compute()):
  // committed = sum of SP on committed-scope items; delivered = sum on done items.
  function sprintScope(sn) {
    var it = data.items.filter(function (i) { return String(i.sprint) === String(sn) && !isPreSprint(i); });
    var c = it.reduce(function (a, i) { return a + num(i.story_points); }, 0);
    var d = it.filter(isDone).reduce(function (a, i) { return a + num(i.story_points); }, 0);
    return { committed: c, delivered: d };
  }
  // "AI learns from past sprints": over the last up-to-6 COMPLETED sprints (sprint
  // number < current, with SP set), measure two things the forecast needs:
  //   reliability = average hit-rate = mean( min(delivered/committed, 1) )  → how
  //                 reliably the team lands its commitment historically.
  //   avgVelocity = mean delivered SP per sprint                            → the
  //                 team's typical throughput, independent of what was committed.
  // Returns null until there's at least one past estimated sprint to learn from.
  function sprintHistory(current) {
    var nums = {};
    data.items.forEach(function (i) { var n = num(i.sprint); if (n > 0 && n < num(current)) nums[n] = 1; });
    var list = Object.keys(nums).map(Number).sort(function (a, b) { return b - a; }).slice(0, 6);
    var hits = [], vels = [];
    list.forEach(function (sn) {
      var s = sprintScope(sn);
      if (s.committed > 0) { hits.push(Math.min(1, s.delivered / s.committed)); vels.push(s.delivered); }
    });
    if (!hits.length) return null;
    return {
      n: hits.length,
      sprints: list.slice(0, hits.length),
      reliability: hits.reduce(function (a, b) { return a + b; }, 0) / hits.length,
      avgVelocity: vels.reduce(function (a, b) { return a + b; }, 0) / vels.length
    };
  }
  function compute(sprint) {
    // Any ticket carrying this Sprint number counts — EXCEPT still-ideating columns
    // (Backlog - Idea / Refinement / Design, Design In-Progress). "Ready for Development
    // (handoff complete)" and everything downstream IS committed scope and is included.
    var its = data.items.filter(function (i) { return String(i.sprint) === String(sprint) && !isPreSprint(i); });
    var dim = data.sprints.filter(function (s) { return String(s.sprint) === String(sprint); })[0] || {};
    var committedSP = its.reduce(function (a, i) { return a + num(i.story_points); }, 0);
    var delivered = its.filter(isDone);
    var deliveredSP = delivered.reduce(function (a, i) { return a + num(i.story_points); }, 0);
    // Carry-forward = committed work NOT delivered (see isDone) — i.e. still In
    // Development / QA on Dev / Reopen / not-yet-started (Ready for Development) /
    // Blocked. It is the exact complement of Delivered, so anything already in the
    // UAT pipeline (Ready for UAT / QA on UAT / UAT Passed …) is NOT carried over.
    var carriedFwd = its.filter(function (i) { return !isDone(i); });
    var carryFwdSP = carriedFwd.reduce(function (a, i) { return a + num(i.story_points); }, 0);
    var carryFwdItems = carriedFwd.length;
    var commitmentSP = num(dim.commitment_sp) || committedSP;
    var completed = delivered.length, planned = its.length;
    // Fallback: if no Story Points are set for this sprint, drive Sprint Health
    // off item counts instead of SP, and label the unit accordingly.
    var usePts = committedSP > 0;
    var hCommit = usePts ? committedSP : planned;
    var hDeliver = usePts ? deliveredSP : completed;
    var hCommitment = usePts ? commitmentSP : planned;
    // ---- three DISTINCT, history-learning Sprint-Health metrics ----
    var hist = sprintHistory(sprint);
    // 1) PROGRESS = what's actually been delivered so far this sprint.
    var progress = hCommit ? hDeliver / hCommit : null;
    // 2) PREDICTABILITY = likelihood we land the whole commitment, LEARNED from past
    //    sprints: reliability (historic hit-rate) × capacityFit (does our typical
    //    velocity even cover this commitment). Never below what we've already banked
    //    (progress). Falls back to progress until there's history to learn from.
    var capacityFit = (hist && hCommit) ? Math.min(1, hist.avgVelocity / hCommit) : null;
    var predictability;
    if (hist && capacityFit != null && progress != null) {
      predictability = Math.max(progress, hist.reliability * capacityFit);
    } else {
      predictability = progress;
    }
    // 3) CARRY FORWARD = committed − velocity (the user's definition): the SP our
    //    typical throughput won't cover, i.e. the forecast spill into the next sprint.
    //    CAPPED by the work actually still undelivered — already-delivered work can't
    //    spill, so a 100%-delivered sprint always reads 0 (not a stale velocity guess).
    //    Floored at 0. Without history, it's just the actual undelivered SP.
    var hUndelivered = usePts ? carryFwdSP : carryFwdItems;
    var carryFwdForecastSP = hist
      ? Math.max(0, Math.min(hCommit - hist.avgVelocity, hUndelivered))
      : hUndelivered;
    var carryFwdFrac = hCommit ? carryFwdForecastSP / hCommit : null;
    var bugs = its.filter(isBug);
    function statusIn(list) { return its.filter(function (i) { return list.indexOf(i.status) !== -1; }).length; }
    var reopened = its.filter(function (i) { return reopenCount(i) > 0; }).length;
    // Defect-escape inputs: only bugs whose "Found In" is set count toward the rate.
    var classifiedBugs = bugs.filter(function (i) { return ["Dev", "UAT", "Prod"].indexOf(i.found_in) !== -1; });
    var prodBugs = bugs.filter(function (i) { return i.found_in === "Prod"; });

    var gids = {}; its.forEach(function (i) { gids[i.task_gid] = 1; });
    var fl = data.flow.filter(function (f) { return gids[f.task_gid]; });
    function avg(field) {
      var vals = fl.map(function (f) { return num(f[field]); }).filter(function (v) { return v > 0; });
      return vals.length ? vals.reduce(function (a, b) { return a + b; }, 0) / vals.length : null;
    }
    return {
      its: its, committedSP: committedSP, deliveredSP: deliveredSP,
      usePts: usePts, velocity: hDeliver, velocityUnit: usePts ? "SP" : "items",
      progress: progress,
      predictability: predictability,
      carryFwd: carryFwdFrac,
      hist: hist, capacityFit: capacityFit,
      carryFwdForecastSP: carryFwdForecastSP,
      carryFwdSP: carryFwdSP, carryFwdItems: carryFwdItems,
      planned: planned, completed: completed,
      inDev: its.filter(function (i) { return sectionStage(i.section) === "dev"; }).length,
      inQA: its.filter(function (i) { return sectionStage(i.section) === "qa"; }).length,
      blocked: its.filter(function (i) { return sectionStage(i.section) === "blocked"; }).length,
      ready: its.filter(function (i) { return sectionStage(i.section) === "ready"; }).length,
      released: its.filter(function (i) { return sectionStage(i.section) === "released"; }).length,
      bugs: bugs.length,
      bugsClosed: bugs.filter(isDone).length,
      pCritical: bugs.filter(function (i) { return (i.priority || "").indexOf("P1") === 0; }).length,
      pHigh: bugs.filter(function (i) { return (i.priority || "").indexOf("P2") === 0; }).length,
      pMedium: bugs.filter(function (i) { return (i.priority || "").indexOf("P3") === 0; }).length,
      regression: bugs.filter(function (i) { return reopenCount(i) > 0; }).length,
      reopened: reopened,   // count of items reopened >=1x this sprint
      // Rework rate: delivered items that were reopened / delivered items (always <=100%).
      reopenedPct: completed ? its.filter(function (i) { return isDone(i) && reopenCount(i) > 0; }).length / completed : null,
      // Escape rate = Prod-found bugs / bugs that actually have a Found In value.
      // Bugs with no Found In are EXCLUDED (not silently counted as "didn't escape").
      defectEscape: classifiedBugs.length ? prodBugs.length / classifiedBugs.length : null,
      bugsClassified: classifiedBugs.length,
      escapeCoverage: bugs.length ? classifiedBugs.length / bugs.length : null,
      // Only trust the rate when enough bugs are classified (>=3 and >=50% coverage).
      escapeReliable: bugs.length ? (classifiedBugs.length >= 3 && classifiedBugs.length / bugs.length >= 0.5) : false,
      devDays: avg("dev_days"), qaDays: avg("qa_days"), cycleDays: avg("cycle_days"),
      blockedHours: fl.length ? fl.reduce(function (a, f) { return a + num(f.blocked_hours); }, 0) : null,
      hasFlow: fl.length > 0,
    };
  }

  // ---------- sprint retrospective ----------
  function retroBadge(kind) {
    var cls = kind === "good" ? "green" : kind === "bad" ? "red" : "amber";
    var t = kind === "good" ? "Went well" : kind === "bad" ? "Needs attention" : "Watch";
    return '<span class="rag ' + cls + '" style="flex:none">' + t + "</span>";
  }
  function sampleRetro(sprint) {
    return [
      { sprint: sprint, type: "well", text: "Burndown tracked close to the ideal line for most of the sprint." },
      { sprint: sprint, type: "well", text: "No P1/Critical bugs escaped to production." },
      { sprint: sprint, type: "well", text: "Code review coverage stayed high on the working branches." },
      { sprint: sprint, type: "improve", text: "Some stories were pulled in without Story Points — estimate before committing." },
      { sprint: sprint, type: "improve", text: "Scope was added mid-sprint; protect the commitment or renegotiate explicitly." },
      { sprint: sprint, type: "action", text: "Add a definition-of-ready check before a story enters In Development.", owner: "Team", status: "Open" },
      { sprint: sprint, type: "action", text: "Split stories larger than 5 SP into thinner slices at planning.", owner: "PO", status: "Open" }
    ];
  }
  function renderRetro(sprint, m) {
    if (!el("retroGrid")) return;
    var usePts = m.usePts;
    var committed = usePts ? m.committedSP : m.planned;
    var delivered = usePts ? m.deliveredSP : m.completed;
    var unit = usePts ? "SP" : "items";
    var carry = usePts ? m.carryFwdSP : m.carryFwdItems;
    var carriedItems = m.carryFwdItems;
    var comp = m.progress;
    var compHex = comp == null ? "#0f8b8d" : comp >= 0.85 ? "#2e7d32" : comp >= 0.6 ? "#b9820a" : "#c62828";

    el("retroSprint").textContent = sprint || "—";
    var muted = "var(--muted)";
    var reworkHex = (m.reopenedPct || 0) <= 0.1 ? "#2e7d32" : (m.reopenedPct || 0) <= 0.25 ? "#b9820a" : "#c62828";
    // Icon-left stat cards (same component as the Delivery tab) — consistent number
    // alignment: one big value line + a muted sub-line, no wrapping mixed units.
    el("retroGrid").innerHTML =
      statCard("Committed", committed + " " + unit, "scope committed", muted, "🎯", "#1f6feb", "Scope committed for this sprint (still-ideating columns excluded).") +
      statCard("Delivered", delivered + " " + unit, "reached UAT pipeline or shipped", "#2e7d32", "✅", "#2e7d32", "Work that reached the UAT pipeline or shipped this sprint (Ready for UAT / QA on UAT / UAT Passed / Released).") +
      statCard("Completion", pct(comp), "delivered ÷ committed", compHex, "📈", compHex, "Delivered ÷ committed.") +
      statCard("Carryover", carry + " " + unit, carriedItems + " item" + (carriedItems === 1 ? "" : "s") + " carried over", muted, "↪️", carriedItems ? "#b9820a" : "#2e7d32", "Committed work still in development or not yet started at sprint end. Items already in the QA/UAT pipeline (Ready for UAT / QA on UAT / UAT Passed) count as delivered, not carried over.") +
      statCard("Velocity", m.velocity + " " + m.velocityUnit, "delivered this sprint", muted, "⚡", "#0f8b8d", "Throughput delivered this sprint.") +
      statCard("Bugs Closed", m.bugsClosed + " / " + m.bugs, "resolved / total", muted, "🐞", "#7c5cd6", "Bugs resolved out of bugs in the sprint.") +
      statCard("Rework", m.reopenedPct == null ? "--" : pct(m.reopenedPct), "reopened after delivery", muted, "🔁", reworkHex, "Delivered items that were reopened at least once.");

    // "What the data says" — auto-generated observations. Each carries a severity
    // (good / watch / bad → left status dot + pill) and a topic icon on the right.
    var ins = [];
    if (comp != null) ins.push({ k: comp >= 0.85 ? "good" : comp >= 0.6 ? "watch" : "bad", ic: comp >= 0.85 ? "📈" : "📉", t: "Delivered " + delivered + " of " + committed + " " + unit + " committed (" + pct(comp) + ")." });
    if (carriedItems > 0) ins.push({ k: carriedItems <= 2 ? "watch" : "bad", ic: "↪️", t: carriedItems + " item(s) · " + carry + " " + unit + " carried over to the next sprint." });
    else ins.push({ k: "good", ic: "✅", t: "No carry-forward — all committed work reached the QA/UAT pipeline or shipped." });
    if (m.predictability != null) ins.push({ k: m.predictability >= 0.85 ? "good" : m.predictability >= 0.6 ? "watch" : "bad", ic: "🎯", t: "Predictability vs the original commitment: " + pct(m.predictability) + "." });
    if (m.reopenedPct != null) ins.push({ k: m.reopenedPct <= 0.1 ? "good" : m.reopenedPct <= 0.25 ? "watch" : "bad", ic: "🔁", t: "Rework rate: " + pct(m.reopenedPct) + " of delivered items were reopened." });
    if (m.pCritical > 0) ins.push({ k: "bad", ic: "🐞", t: m.pCritical + " P1/Critical bug(s) were in this sprint." });
    if (m.escapeReliable && m.defectEscape > 0) ins.push({ k: m.defectEscape <= 0.1 ? "watch" : "bad", ic: "🪲", t: pct(m.defectEscape) + " of classified bugs escaped to Prod (" + m.bugsClassified + " of " + m.bugs + " bugs classified)." });
    if (m.cycleDays != null) ins.push({ k: m.cycleDays <= 5 ? "good" : m.cycleDays <= 10 ? "watch" : "bad", ic: "⏱️", t: "Average cycle time: " + (Math.round(m.cycleDays * 10) / 10) + " days." });
    var badgeTxt = { good: "Went well", watch: "Watch", bad: "Needs attention" };
    var insRows = ins.map(function (x) {
      return '<div class="rins ' + x.k + '">' +
        '<span class="rins-ic">' + (x.k === "good" ? "✓" : "!") + '</span>' +
        '<span class="rins-badge">' + badgeTxt[x.k] + '</span>' +
        '<span class="rins-txt">' + esc(x.t) + '</span>' +
        '<span class="rins-end">' + x.ic + '</span></div>';
    }).join("");
    var insOpen = _collapse["retroinsights"] === true;
    el("retroInsights").innerHTML = '<details class="retro-panel" data-lb="retroinsights"' + (insOpen ? " open" : "") + '>' +
      '<summary class="retro-h"><span class="retro-h-ic">📊</span> WHAT THE DATA SAYS &middot; ' + ins.length + '<span class="retro-chev">&#9656;</span></summary>' +
      '<div class="rins-list">' + (insRows || '<div class="muted" style="padding:6px 14px 14px">No sprint data.</div>') + '</div></details>';

    // Stories to split — larger than 5 SP (action: slice at planning). Links to Asana.
    if (el("retroBig")) {
      var big = m.its.filter(function (i) { return num(i.story_points) > 5 && !/sub-?task/i.test(String(i.type || "")); })
        .sort(function (a, b) { return num(b.story_points) - num(a.story_points); });
      var bigRows = big.map(function (i) {
        return '<div class="rbig-row"><span class="rbig-sp">' + num(i.story_points) + ' SP</span>' +
          '<span class="rbig-name">' + esc(i.name || i.task_gid) +
          '<span class="rnote-meta"> &middot; ' + esc(i.type || "—") + (i.status ? " &middot; " + esc(i.status) : "") + '</span></span>' +
          '<a class="tasklink" href="' + ASANA_TASK + esc(i.task_gid) + '" target="_blank" rel="noopener">Open &#8599;</a></div>';
      }).join("");
      var bigOpen = _collapse["retrobig"] === true;
      el("retroBig").innerHTML = '<details class="retro-panel" data-lb="retrobig"' + (bigOpen ? " open" : "") + '>' +
        '<summary class="retro-h" style="color:#7c5cd6"><span class="retro-h-ic">✂️</span> STORIES TO SPLIT &middot; LARGER THAN 5 SP &middot; ' + big.length + '<span class="retro-chev">&#9656;</span></summary>' +
        '<div class="rins-list">' + (bigRows || '<div class="muted" style="padding:6px 14px 14px">No stories over 5 SP this sprint. 🎉</div>') + '</div></details>';
    }

    var notes = (data.retro && data.retro.length ? data.retro : sampleRetro(sprint)).filter(function (r) { return String(r.sprint) === String(sprint); });
    if (!notes.length) notes = sampleRetro(sprint);
    function noteList(dom, type, title, ic, color) {
      var sel = notes.filter(function (r) { return r.type === type; });
      var rows = sel.map(function (r) {
        var meta = (r.owner || r.status) ? '<span class="rnote-meta"> &middot; ' + esc([r.owner, r.status].filter(Boolean).join(" · ")) + "</span>" : "";
        return '<div class="rnote-row"><span class="rnote-ic">' + ic + '</span>' +
          '<span class="rnote-txt">' + esc(r.text) + meta + '</span></div>';
      }).join("");
      el(dom).innerHTML = '<div class="retro-note" style="--rn:' + color + '">' +
        '<div class="rnote-h"><span class="rnote-hic">' + ic + '</span><span class="rnote-title">' + title +
        '</span><span class="rnote-count">' + sel.length + '</span><span class="rnote-rule"></span></div>' +
        '<div class="rnote-body">' + (rows || '<div class="muted" style="padding:6px 2px">No notes yet.</div>') + '</div></div>';
    }
    noteList("retroWell", "well", "WHAT WENT WELL", "✅", "#22a565");
    noteList("retroImprove", "improve", "WHAT TO IMPROVE", "🔧", "#3b82f6");
    noteList("retroActions", "action", "ACTION ITEMS", "🎯", "#7c5cd6");
  }

  // ---------- redesign helpers (v2) ----------
  function heroCard(title, icon, p, frac, cap, color, tip, tipPos) {
    var pc = (p == null || isNaN(p)) ? 0 : Math.round(p * 100);
    var N = 7, solid = Math.max(1, Math.round(pc / 100 * N)), bars = "";
    for (var i = 0; i < N; i++) {
      var h = 30 + i * (70 / (N - 1));   // ascending 30%..100%
      bars += '<i class="' + (i < solid ? "on" : "off") + '" style="height:' + h + '%"></i>';
    }
    var badgeLeft = Math.max(9, Math.min(84, (solid - 0.5) / N * 100));
    var t = tip ? ' <span class="tip' + (tipPos ? ' tip-' + tipPos : '') + '" data-tip="' + escAttr(tip) + '">i</span>' : '';
    return '<div class="hcard" style="--hc:' + color + '">' +
      '<div class="hcard-top"><span class="hcard-title">' + title + t + '</span><span class="hcard-ic">' + icon + '</span></div>' +
      '<div class="hbars"><span class="hbadge" style="left:' + badgeLeft + '%">' + pc + '%</span>' + bars + '</div>' +
      '<div class="hcard-foot"><span class="hcard-frac">' + frac + '</span></div>' +
      '<div class="hcard-cap">' + cap + '</div></div>';
  }
  function glanceRow(icon, val, sub, ring) {
    return '<div class="grow"><span class="gic">' + icon + '</span>' +
      '<span class="gtext"><span class="gval">' + val + '</span><span class="gsub">' + sub + '</span></span>' +
      (ring != null ? '<span class="gring" style="--p:' + ring + '"><i>' + ring + '%</i></span>' : '') + '</div>';
  }
  function glanceCard(m, daysLeft) {
    var storyPct = m.planned ? Math.round(100 * m.completed / m.planned) : 0;
    return '<div class="glance">' +
      '<div class="glance-h"><span>⭐</span> AT A GLANCE</div>' +
      '<div class="grows">' +
      glanceRow('🛡️', m.completed + ' / ' + m.planned, 'Stories Delivered', storyPct) +
      (daysLeft != null ? glanceRow('📅', daysLeft, 'Days Remaining', null) : '') +
      glanceRow('⚡', m.velocity + ' ' + m.velocityUnit, 'Velocity', null) +
      glanceRow('📌', (m.usePts ? Math.round(m.committedSP) : m.planned) + ' SP', 'Committed', null) +
      '</div></div>';
  }

  function pctOf(a, b) { return b ? Math.round(100 * a / b) : 0; }
  // Icon-left stat card (Delivery + Scope Creep) — big chip, title, number, sub.
  function statCard(title, value, sub, subColor, icon, chip, tip) {
    var t = tip ? ' <span class="tip" data-tip="' + escAttr(tip) + '">i</span>' : '';
    return '<div class="scard" style="--sc:' + chip + '">' +
      '<div class="scard-ic">' + icon + '</div>' +
      '<div class="scard-b"><div class="scard-t">' + title + t + '</div>' +
      '<div class="scard-v">' + value + '</div>' +
      (sub != null ? '<div class="scard-s" style="color:' + subColor + '">' + sub + '</div>' : '') + '</div></div>';
  }
  function roundRect(ctx, x, y, w, h, r) {
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); return; }
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function hexA(hex, a) {
    if (typeof hex !== "string" || hex[0] !== "#") return "rgba(124,97,255," + a + ")";
    var n = hex.slice(1); if (n.length === 3) n = n.split("").map(function (c) { return c + c; }).join("");
    return "rgba(" + parseInt(n.slice(0, 2), 16) + "," + parseInt(n.slice(2, 4), 16) + "," + parseInt(n.slice(4, 6), 16) + "," + a + ")";
  }
  // Tiny gradient sparkline for a KPI card (no axes/grid/tooltip).
  function drawSpark(id, data, color) {
    var e = el(id); if (!e || !data || !data.length) return;
    mkChart(id, { type: "line",
      data: { labels: data.map(function (_, i) { return i; }), datasets: [{ data: data, borderColor: color, borderWidth: 2, tension: .42, pointRadius: 0, fill: true,
        backgroundColor: function (c) { var a = c.chart.chartArea; if (!a) return "transparent"; var g = c.chart.ctx.createLinearGradient(0, a.top, 0, a.bottom); g.addColorStop(0, hexA(color, .30)); g.addColorStop(1, hexA(color, 0)); return g; } }] },
      options: { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: false }, tooltip: { enabled: false } }, scales: { x: { display: false }, y: { display: false } }, elements: { line: { borderCapStyle: "round" } } } });
  }

  // "Not yet completed" summary card (ring + activity bars) — click to expand list.
  // Card-style summary block: accent ring (%) + mini bar-strip + collapsible body.
  // Generalises the NOT YET COMPLETED card so Bug tickets / Added mid-sprint /
  // Needs-estimate share the same look. opts = {label, sub, pct, color, rows}.
  function summaryBlock(id, opts) {
    var openC = _collapse[id] === true;
    var pct = Math.max(0, Math.min(100, Math.round(opts.pct == null ? 0 : opts.pct)));
    var color = opts.color || "#6c5ce7";
    var N = 48, filled = Math.round(pct / 100 * N), bars = "";
    for (var i = 0; i < N; i++) bars += '<i class="' + (i < filled ? "on" : "") + '"></i>';
    return '<details class="lb ncblock" data-lb="' + id + '"' + (openC ? " open" : "") + ' style="--nc:' + color + '">' +
      '<summary class="ncsum">' +
        '<span class="ncring" style="--p:' + pct + '"><i>' + pct + '%</i></span>' +
        '<span class="nctext"><b>' + opts.label + '</b><span>' + opts.sub + '</span></span>' +
        '<span class="ncbars">' + bars + '</span>' +
        '<span class="ncchev">&#9656;</span>' +
      '</summary><div class="ncbody">' + (opts.rows || "") + '</div></details>';
  }
  function notCompletedBlock(id, notDone, total, onHold, rowsHtml) {
    var onHoldTxt = onHold ? ' &middot; ' + onHold + ' on hold' : '';
    return summaryBlock(id, { label: "NOT YET COMPLETED", color: "#6c5ce7",
      pct: total ? 100 * notDone / total : 0,
      sub: notDone + ' of ' + total + ' stories' + onHoldTxt, rows: rowsHtml });
  }

  // ---------- render ----------
  function render(sprint) {
    var m = compute(sprint), rag = goalRag(m);
    renderRetro(sprint, m);
    var goalHex = { green: "#2e7d32", amber: "#f29f05", red: "#c62828" }[rag[0]] || "#0f8b8d";
    var fracSP = m.usePts ? (Math.round(m.deliveredSP) + " / " + Math.round(m.committedSP) + " SP") : (m.completed + " / " + m.planned + " stories");
    var unit = m.usePts ? "SP" : "items";
    var hist = m.hist;
    // --- explanatory tooltips: exactly how each hero number is derived, with live figures ---
    var progTip = "delivered ÷ committed = " + Math.round(m.usePts ? m.deliveredSP : m.completed)
      + "/" + Math.round(m.usePts ? m.committedSP : m.planned) + " " + unit + " = " + pct(m.progress)
      + ". Delivered = reached UAT pipeline or shipped.";
    var predFracTxt, predTip;
    if (hist) {
      predFracTxt = "learns from previous sprints";
      predTip = "Forecast of hitting the full commitment, learned from " + hist.n + " past sprint" + (hist.n > 1 ? "s" : "")
        + ": reliability " + pct(hist.reliability) + " × capacity-fit " + pct(m.capacityFit)
        + " (velocity " + Math.round(hist.avgVelocity) + " ÷ committed " + Math.round(m.committedSP)
        + "), floored at progress " + pct(m.progress) + " → " + pct(m.predictability) + ".";
    } else {
      predFracTxt = fracSP;
      predTip = "Needs a past estimated sprint to learn from; until then mirrors Progress (" + pct(m.progress) + ").";
    }
    var carryTxt, carryTip;
    if (hist && m.usePts) {
      var rawFc = Math.max(0, Math.round(m.committedSP - hist.avgVelocity));
      var capped = Math.round(m.carryFwdForecastSP) < rawFc;
      carryTxt = Math.round(m.carryFwdForecastSP) + " SP forecast";
      carryTip = capped
        ? ("Forecast = committed − avg velocity = " + Math.round(m.committedSP) + " − " + Math.round(hist.avgVelocity)
           + " = " + rawFc + " SP, but capped at the " + Math.round(m.carryFwdSP) + " SP still undelivered → "
           + Math.round(m.carryFwdForecastSP) + " SP (" + pct(m.carryFwd) + "). Delivered work can't spill.")
        : ("committed − avg velocity = " + Math.round(m.committedSP) + " − " + Math.round(hist.avgVelocity)
           + " = " + Math.round(m.carryFwdForecastSP) + " SP (" + pct(m.carryFwd) + ") forecast to spill next sprint. Capped at undelivered work; floored at 0.");
    } else {
      carryTxt = m.usePts ? (Math.round(m.carryFwdSP) + " SP") : ((m.carryFwdItems || 0) + " items");
      carryTip = "Committed work not yet delivered (no history yet to forecast from): " + carryTxt + ".";
    }
    // Days remaining from the sprint's SCHEDULED end (calendar cadence), not the
    // last-activity date. Only shown for the currently-running sprint.
    var daysLeft = null;
    (function () {
      var a = cfg.SPRINT_ANCHOR; if (!a || a.sprint == null || !a.start) return;
      var start0 = new Date(a.start + "T00:00:00"); if (isNaN(start0.getTime())) return;
      var len = num(cfg.SPRINT_LENGTH_DAYS) || 14;
      var startN = new Date(start0.getTime() + (num(sprint) - num(a.sprint)) * len * 86400000);
      var endN = new Date(startN.getTime() + len * 86400000);           // end (exclusive)
      var dl = Math.ceil((endN - new Date()) / 86400000);
      if (dl >= 0 && dl <= len) daysLeft = dl;                          // only the ongoing sprint
    })();
    el("healthGrid").innerHTML =
      '<div class="hero3">' +
        heroCard("SPRINT PROGRESS", "📈", m.progress, fracSP, "delivered ÷ committed", "#f5883f", progTip, "l") +
        heroCard("PREDICTABILITY", "🎯", m.predictability, predFracTxt, "likely to hit commitment", "#2f6df6", predTip, "l") +
        heroCard("CARRY FORWARD", "⏱️", m.carryFwd, carryTxt, "forecast to next sprint", "#f5a623", carryTip, "r") +
      "</div>" +
      '<div class="minigrid">' +
        card("Sprint Goal", "", { rag: rag[0], ragText: rag[1], icon: "🎯" }) +
        card("Delivered", (m.usePts ? Math.round(m.deliveredSP) + " SP" : m.completed + " items"), { icon: "✅", accent: "#2e7d32" }) +
      "</div>" +
      glanceCard(m, daysLeft);
    el("healthNote").innerHTML = m.usePts
      ? '<b>Progress</b> = delivered ÷ committed (' + Math.round(m.deliveredSP) + '/' + Math.round(m.committedSP) + ' SP = ' + pct(m.progress) + '), where delivered = reached the UAT pipeline or shipped (Ready&nbsp;for&nbsp;UAT → Released). '
        + (hist
            ? '<b>Predictability</b> = ' + pct(m.predictability) + ', a forecast of hitting the full commitment learned from the last ' + hist.n + ' sprint' + (hist.n > 1 ? 's' : '') + ' (reliability ' + pct(hist.reliability) + ' × capacity-fit ' + pct(m.capacityFit) + '). <b>Carry-Forward</b> = committed − avg velocity = ' + Math.round(m.committedSP) + '&minus;' + Math.round(hist.avgVelocity) + ' = ' + Math.max(0, Math.round(m.committedSP - hist.avgVelocity)) + ' SP, capped at the ' + Math.round(m.carryFwdSP) + ' SP still undelivered = <b>' + Math.round(m.carryFwdForecastSP) + ' SP</b> (' + pct(m.carryFwd) + ') forecast to spill next sprint (delivered work can&rsquo;t spill).'
            : '<b>Predictability</b> &amp; <b>Carry-Forward</b> start learning from history once a prior estimated sprint exists; for now Predictability mirrors Progress and Carry-Forward shows the ' + Math.round(m.carryFwdSP) + ' SP still undelivered.')
        + ' Hover the <span class="tip" data-tip="Every hero card has one of these — hover it to see the exact formula and live numbers.">i</span> on each card for its formula.'
      : "Story Points not set in Asana for this sprint — Sprint Health is showing item counts. It switches to SP automatically once tasks are estimated.";

    el("deliveryGrid").innerHTML =
      statCard("Stories Planned", m.planned, "Total", "var(--muted)", "📋", "#7b61ff") +
      statCard("In Development", m.inDev, pctOf(m.inDev, m.planned) + "% of total", "#0ea89a", "🛠️", "#0ea89a", "In Development / Code Review board column (board section, not the stale Status field).") +
      statCard("In QA", m.inQA, pctOf(m.inQA, m.planned) + "% of total", "#f5883f", "📝", "#f5883f", "A testing column: QA on Dev / Ready for UAT / QA on UAT / In UAT.") +
      statCard("Completed", m.completed, pctOf(m.completed, m.planned) + "% of total", "#22a565", "✅", "#22a565") +
      statCard("Blocked", m.blocked, pctOf(m.blocked, m.planned) + "% of total", "#ef4444", "⛔", "#ef4444") +
      statCard("Released", m.released, pctOf(m.released, m.planned) + "% of total", "#7b61ff", "🚀", "#7b61ff", "Released board column (shipped to production).");
    var openItems = m.its.filter(function (i) { return !isDone(i) && !isOnHold(i); });
    var onHoldCount = m.its.filter(function (i) { return !isDone(i) && isOnHold(i); }).length;
    el("openList").innerHTML = notCompletedBlock("open", openItems.length, m.planned, onHoldCount,
      (openItems.length ? openItems.map(taskRow).join("") : '<div class="muted">All committed stories completed. 🎉</div>'));

    renderDueDates(sprint);
    renderReadyForUAT(sprint);

    el("qualityGrid").innerHTML =
      card("Total Bugs", m.bugs, { icon: "🐞", accent: "#6b7a8d", tip: "Tickets in this sprint whose title contains \"BUG\" (or Type = Bug)." }) +
      card("Bugs Closed", m.bugsClosed, { icon: "✅", accent: "#2e7d32", tip: "Bug tickets resolved this sprint (Released / UAT Passed / done). Total Bugs − Bugs Closed = still-open bugs." }) +
      card("Critical (P1)", m.pCritical, { icon: "🔴", accent: "#c62828", tip: "Bug tickets with task Priority = P1 Critical." }) +
      card("High (P2)", m.pHigh, { icon: "🟠", accent: "#f29f05", tip: "Bug tickets with task Priority = P2 High." }) +
      card("Reopened", m.reopened, { icon: "🔁", tip: "Tickets moved back into the \"Reopen\" column at least once this sprint — counted from the Asana activity log, merged with the manual \"Reopened Count\" field (whichever is higher). See the Reopened Tickets list below. Rework rate of delivered items: " + pct(m.reopenedPct) + "." }) +
      card("Defect Escape", (m.escapeReliable ? pct(m.defectEscape) : "--") + ' <span style="font-size:13px;color:var(--muted,#5b6577)">' + m.bugsClassified + "/" + m.bugs + " classified</span>", { icon: "🪲", accent: m.escapeReliable ? undefined : "#5b6577", tip: "Share of bugs found in Prod, out of bugs that have a 'Found In' value (Dev/UAT/Prod). Bugs with no 'Found In' are excluded, and the rate shows '—' until at least 3 bugs and 50% of the sprint's bugs are classified in Asana." });
    // (Bugs by priority doughnut removed per design.)
    var bugItems = m.its.filter(isBug);
    var bugsClosedN = bugItems.filter(isDone).length;
    el("bugList").innerHTML = summaryBlock("bugs", {
      label: "BUG TICKETS", color: "#e94b6a",
      pct: bugItems.length ? 100 * bugsClosedN / bugItems.length : 100,
      sub: bugItems.length ? (bugItems.length + " bugs &middot; " + bugsClosedN + " closed") : "No bug tickets this sprint",
      rows: bugItems.length ? bugItems.map(taskRow).join("") : '<div class="muted">No bug tickets this sprint. 🎉</div>'
    });

    // Reopened tickets — every ticket sent back for rework at least once this sprint
    // (reopenCount > 0 — Reopen-column moves merged with the manual field), most-
    // reopened first, with its current board column and reopen count. The ring shows
    // how many are now closed again.
    var reopenedItems = m.its.filter(function (i) { return reopenCount(i) > 0; })
      .sort(function (a, b) { return reopenCount(b) - reopenCount(a); });
    var reopenedDone = reopenedItems.filter(isDone).length;
    el("reopenedList").innerHTML = summaryBlock("reopened", {
      label: "REOPENED TICKETS", color: "#f29f05",
      pct: reopenedItems.length ? 100 * reopenedDone / reopenedItems.length : 100,
      sub: reopenedItems.length ? (reopenedItems.length + " reopened &middot; " + reopenedDone + " now closed") : "No reopened tickets this sprint",
      rows: reopenedItems.length ? reopenedItems.map(reopenedRow).join("") : '<div class="muted">No tickets were reopened this sprint. 🎉</div>'
    });

    // (Flow section removed.)
    // Unestimated stories — committed stories (excluding bugs & sub-tasks) with no
    // Story Points. They're invisible to all SP-based metrics (velocity, burndown,
    // carry-forward), so surfacing them is the fastest way to close the data gap.
    var stories = m.its.filter(function (i) { return !isBug(i) && !/sub-?task/i.test(i.type || ""); });
    var missing = stories.filter(function (i) { return num(i.story_points) === 0; });
    var coverage = stories.length ? (stories.length - missing.length) / stories.length : 1;
    el("missingSPGrid").innerHTML =
      card("Missing Story Points", missing.length, { icon: "❓", accent: missing.length ? "#c62828" : "#2e7d32", tip: "Committed stories (excluding bugs & sub-tasks) with no Story Points set. They're invisible to velocity, burndown and Carry-Forward (all SP-based), so they make progress look worse than it is — estimate them in Asana." }) +
      card("Estimated", stories.length - missing.length, { icon: "✅", accent: "#2e7d32" }) +
      card("Estimation Coverage", pct(coverage), { icon: "📊", accent: coverage >= 0.9 ? "#2e7d32" : coverage >= 0.7 ? "#f29f05" : "#c62828", tip: "Share of committed stories that carry a Story Point estimate. Higher = more trustworthy SP metrics." });
    el("missingSPList").innerHTML = summaryBlock("missSP", {
      label: "NEEDS AN ESTIMATE", color: "#f5a623",
      pct: stories.length ? 100 * missing.length / stories.length : 0,
      sub: missing.length ? (missing.length + " of " + stories.length + " stories missing Story Points") : "All committed stories are estimated",
      rows: missing.length ? missing.map(taskRow).join("") : '<div class="muted">All committed stories are estimated. 🎉</div>'
    });

    renderRisks(sprint);
    renderCharts(sprint, m);
    renderTrends(sprint, m);
    renderBurndown(sprint, m);
    renderScopeCreep(sprint, m);
  }

  // Calendar sprint window (14 days from the config anchor) — authoritative, unlike
  // dim_sprint.inferred_start/end which drift far wider than an actual sprint.
  function sprintWindow(sn) {
    var a = cfg.SPRINT_ANCHOR;
    if (!a || a.sprint == null || !a.start) return null;
    var len = num(cfg.SPRINT_LENGTH_DAYS) || 14;
    var s0 = new Date(a.start + "T00:00:00Z");
    if (isNaN(s0.getTime())) return null;
    var start = new Date(s0.getTime() + (num(sn) - num(a.sprint)) * len * 86400000);
    var end = new Date(start.getTime() + (len - 1) * 86400000);
    return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
  }
  function renderScopeCreep(sprint, m) {
    var dim = data.sprints.filter(function (s) { return String(s.sprint) === String(sprint); })[0] || {};
    var sw = sprintWindow(sprint);
    var start = (sw && sw.start) || dim.planned_start || dim.inferred_start;
    var end = (sw && sw.end) || dim.planned_end || dim.inferred_end;
    // Scope creep = unplanned *story* work. Bugs are EXCLUDED: they're raised
    // during the sprint while testing delivered stories, so they're expected
    // sprint activity, not scope that "crept in". (Bugs live on the Quality tab.)
    var stories = m.its.filter(function (i) { return !isBug(i); });
    // Baseline = created on/before sprint start; Added = created after start (mid-sprint).
    // Measured by TICKET COUNT (always meaningful; many added tickets aren't estimated yet).
    var baseCount = 0, addCount = 0, baseSP = 0, addSP = 0;
    stories.forEach(function (i) {
      var cd = (i.created_at || "").slice(0, 10), sp = num(i.story_points);
      if (start && cd && cd > start) { addCount++; addSP += sp; }
      else { baseCount++; baseSP += sp; }
    });
    var creepPct = baseCount > 0 ? addCount / baseCount : null;
    var creepTip = "Non-bug stories added after the sprint start date (approximated by ticket creation date vs sprint start). Bugs are excluded — they're raised while testing delivered work, not scope creep. High = lots of unplanned work entered the sprint.";
    el("scopeGrid").innerHTML =
      statCard("Baseline Scope", baseCount, "stories", "var(--muted)", "🎯", "#7b61ff", "Stories committed at sprint start (created on/before the start date, bugs excluded). ≈ " + Math.round(baseSP) + " SP.") +
      statCard("Added Mid-Sprint", "+" + addCount, "tickets", "var(--muted)", "➕", "#0ea89a", creepTip) +
      statCard("Scope Creep", creepPct == null ? "--" : "+" + Math.round(creepPct * 100) + "%", "vs baseline", (creepPct && creepPct > 0.1) ? "#ef4444" : "#22a565", "📈", "#f5883f", "Added tickets ÷ baseline tickets.") +
      statCard("Added Story Points", "+" + Math.round(addSP), "SP", "var(--muted)", "🔢", "#7b61ff", "Story points of the added tickets — 0 if they aren't estimated yet.");

    var addedItems = stories.filter(function (i) { var cd = (i.created_at || "").slice(0, 10); return start && cd && cd > start; });
    el("scopeList").innerHTML = summaryBlock("scope", {
      label: "ADDED MID-SPRINT", color: "#0ea89a",
      pct: stories.length ? 100 * addedItems.length / stories.length : 0,
      sub: addedItems.length ? (addedItems.length + " stories &middot; +" + Math.round(addSP) + " SP (bugs excluded)") : "No mid-sprint story additions",
      rows: addedItems.length ? addedItems.map(taskRow).join("") : '<div class="muted">No mid-sprint story additions.</div>'
    });

    if (!start || !end) { if (_charts.scopeChart) { _charts.scopeChart.destroy(); delete _charts.scopeChart; } var c = el("scopeChart"); if (c) c.getContext("2d").clearRect(0, 0, c.width, c.height); return; }
    var days = isoDays(start, end);
    var cum = days.map(function (d) { var n = 0; stories.forEach(function (i) { var cd = (i.created_at || "").slice(0, 10); if (cd && cd <= d) n++; }); return n; });
    var baseArr = days.map(function () { return baseCount; });
    var scopePills = { id: "scopePills", afterDatasetsDraw: function (chart) {
      var ctx = chart.ctx, meta = chart.getDatasetMeta(0), dd = chart.data.datasets[0].data;
      meta.data.forEach(function (pt, i) {
        var v = dd[i]; if (v == null) return;
        // Only label the first point, points where the value changed, and the last —
        // avoids a wall of identical pills on flat stretches.
        if (i > 0 && v === dd[i - 1] && i !== dd.length - 1) return;
        ctx.save(); ctx.font = "700 10px 'Fira Sans',sans-serif"; ctx.textAlign = "center";
        var txt = String(v), w = ctx.measureText(txt).width + 12;
        ctx.fillStyle = "#e94b6a"; roundRect(ctx, pt.x - w / 2, pt.y - 26, w, 16, 6); ctx.fill();
        ctx.fillStyle = "#fff"; ctx.fillText(txt, pt.x, pt.y - 15); ctx.restore();
      });
    } };
    mkChart("scopeChart", {
      type: "line",
      data: { labels: days.map(function (d) { return d.slice(5); }), datasets: [
        { label: "Committed scope", data: cum, borderColor: "#e94b6a", borderWidth: 2.6, tension: .25, fill: true, pointRadius: 4, pointBackgroundColor: "#e94b6a", pointBorderColor: "#fff", pointBorderWidth: 2, pointHoverRadius: 6,
          backgroundColor: function (c) { var a = c.chart.chartArea; if (!a) return "rgba(233,75,106,.12)"; var g = c.chart.ctx.createLinearGradient(0, a.top, 0, a.bottom); g.addColorStop(0, "rgba(233,75,106,.26)"); g.addColorStop(1, "rgba(233,75,106,.02)"); return g; } },
        { label: "Baseline (at start)", data: baseArr, borderColor: "#6c5ce7", borderDash: [6, 5], borderWidth: 1.8, pointRadius: 0, fill: false, tension: 0 } ] },
      options: { responsive: true, maintainAspectRatio: false, layout: { padding: { top: 28 } },
        plugins: { legend: { position: "top", align: "end", labels: { usePointStyle: true, pointStyle: "circle", boxWidth: 8, padding: 14, color: "#8f9fb5", font: { size: 11.5, weight: "600" } } } },
        scales: { y: { beginAtZero: true, title: { display: true, text: "Tickets", color: "#8f9fb5" }, grid: { color: "rgba(125,142,170,.14)" }, border: { display: false }, ticks: { color: "#8f9fb5" } },
          x: { grid: { display: false }, border: { display: false }, ticks: { color: "#8f9fb5" } } } },
      plugins: [scopePills],
    });
  }

  function isoDays(start, end) {
    var out = [], a = new Date(start + "T00:00:00Z"), b = new Date(end + "T00:00:00Z");
    if (isNaN(a.getTime()) || isNaN(b.getTime()) || b < a) return out;
    for (var d = a; d <= b; d = new Date(d.getTime() + 86400000)) out.push(d.toISOString().slice(0, 10));
    return out;
  }
  function renderBurndown(sprint, m) {
    var dim = data.sprints.filter(function (s) { return String(s.sprint) === String(sprint); })[0] || {};
    var sw = sprintWindow(sprint);
    var start = (sw && sw.start) || dim.planned_start || dim.inferred_start;
    var end = (sw && sw.end) || dim.planned_end || dim.inferred_end;
    var committed = m.committedSP || 0;
    var snap = {};
    data.burndown.filter(function (b) { return String(b.sprint) === String(sprint); })
      .forEach(function (b) { snap[b.snapshot_date] = num(b.remaining_sp); });
    if (burnChart) burnChart.destroy();
    var days = (start && end) ? isoDays(start, end) : Object.keys(snap).sort();
    if (!days.length || committed <= 0) {
      var ctx = el("burnChart"); if (ctx) ctx.getContext("2d").clearRect(0, 0, ctx.width, ctx.height);
      return;
    }
    var today = new Date().toISOString().slice(0, 10);
    var labels = days.map(function (d) { return d.slice(5); });
    var ideal = days.map(function (d, i) { return Math.round(committed * (1 - i / Math.max(1, days.length - 1)) * 10) / 10; });
    // Actual remaining: snapshot where we have one; seed sprint-start with full committed; blank the future.
    var actual = days.map(function (d, i) {
      if (d in snap) return snap[d];
      if (i === 0) return committed;
      return null;
    });
    burnChart = new Chart(el("burnChart"), {
      type: "line",
      data: { labels: labels, datasets: [
        { label: "Remaining (actual)", data: actual, borderColor: "#6c5ce7", borderWidth: 2.6, tension: .38, spanGaps: true, fill: true,
          pointRadius: 4, pointBackgroundColor: "#fff", pointBorderColor: "#6c5ce7", pointBorderWidth: 2, pointHoverRadius: 6,
          backgroundColor: function (c) { var a = c.chart.chartArea; if (!a) return "rgba(108,92,231,.12)"; var g = c.chart.ctx.createLinearGradient(0, a.top, 0, a.bottom); g.addColorStop(0, "rgba(108,92,231,.28)"); g.addColorStop(1, "rgba(108,92,231,.02)"); return g; } },
        { label: "Ideal", data: ideal, borderColor: "#9aa6bb", borderDash: [5, 5], borderWidth: 1.6, pointRadius: 0, fill: false, tension: 0 } ] },
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: "top", align: "end", labels: { usePointStyle: true, pointStyle: "line", boxWidth: 26, padding: 16, color: "#8f9fb5", font: { size: 11.5, weight: "600" } } },
          tooltip: { backgroundColor: "rgba(19,22,52,.96)", cornerRadius: 12, padding: 12, titleColor: "#fff", bodyColor: "#e7e9f7", usePointStyle: true, callbacks: { title: function (t) { return "Day " + (t[0].dataIndex + 1) + " (" + t[0].label + ")"; } } } },
        scales: { y: { beginAtZero: true, title: { display: true, text: "Story Points", color: "#8f9fb5" }, grid: { color: "rgba(125,142,170,.14)" }, border: { display: false }, ticks: { color: "#8f9fb5" } },
          x: { grid: { display: false }, border: { display: false }, ticks: { color: "#8f9fb5" } } } },
    });
  }

  // ---------- Due Dates ----------
  // Assignees hidden from the Delivery developer views (PMs/leads) — set in config.js.
  var _EXCL_ASSIGNEES = {};
  (cfg.EXCLUDE_ASSIGNEES || []).forEach(function (n) { _EXCL_ASSIGNEES[String(n).trim().toLowerCase()] = 1; });
  function isExcludedAssignee(n) { return !!_EXCL_ASSIGNEES[String(n || "").trim().toLowerCase()]; }
  // Parse Asana due_on ('YYYY-MM-DD', date-only) into a LOCAL midnight Date so the
  // comparison to "today" is purely calendar-based (no timezone drift from UTC).
  function parseDue(s) {
    if (!s) return null;
    var p = String(s).slice(0, 10).split("-");
    if (p.length !== 3) return null;
    var d = new Date(+p[0], (+p[1]) - 1, +p[2]);
    return isNaN(d.getTime()) ? null : d;
  }
  function dueTaskRow(it) {
    var late = it._lateDays;
    var tag = late
      ? '<span class="due-tag over">' + late + 'd late</span>'
      : '<span class="due-tag today">Due today</span>';
    var who = it.assignee ? esc(it.assignee) : '<span class="muted">Unassigned</span>';
    return '<div class="taskrow due ' + (late ? "od" : "dt") + '">' +
      '<span class="trbadge ' + priClass(it.priority) + '">' + shortPri(it.priority) + "</span>" +
      '<span class="trname" title="' + escAttr(it.name) + '">' + esc(it.name) + "</span>" +
      '<span class="trwho" title="Assignee">👤 ' + who + "</span>" +
      tag +
      '<span class="trstatus">' + esc(it.status || it.section || "") + "</span>" +
      '<a class="tasklink" href="' + ASANA_TASK + it.task_gid + '" target="_blank" rel="noopener">Open &#8599;</a></div>';
  }
  var _DD_MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function fmtDD(iso) {
    if (!iso) return "—";
    var p = String(iso).slice(0, 10).split("-");
    return p.length < 3 ? String(iso) : (+p[2]) + " " + _DD_MON[(+p[1]) - 1];
  }
  // Row for a sprint task with NO due date set.
  function missingRow(it) {
    var who = it.assignee ? esc(it.assignee) : '<span class="muted">Unassigned</span>';
    return '<div class="taskrow due nd">' +
      '<span class="trbadge ' + priClass(it.priority) + '">' + shortPri(it.priority) + "</span>" +
      '<span class="trname" title="' + escAttr(it.name) + '">' + esc(it.name) + "</span>" +
      '<span class="trwho" title="Assignee">👤 ' + who + "</span>" +
      '<span class="due-tag nodate">no due date</span>' +
      '<span class="trstatus">' + esc(it.status || it.section || "") + "</span>" +
      '<a class="tasklink" href="' + ASANA_TASK + it.task_gid + '" target="_blank" rel="noopener">Open &#8599;</a></div>';
  }
  // Row for a ticket whose due date was changed/removed (from fact_due_changes).
  function modifiedRow(c) {
    var by = c.changed_by ? esc(c.changed_by) : "someone";
    var change = (c.action === "removed")
      ? ('<span class="due-tag over">removed ' + fmtDD(c.old_due) + '</span>')
      : (c.old_due
          ? ('<span class="dd-change">' + fmtDD(c.old_due) + ' &rarr; <strong>' + fmtDD(c.new_due) + '</strong></span>')
          : ('<span class="dd-change">set &rarr; <strong>' + fmtDD(c.new_due) + '</strong></span>'));
    var later = c.pushed_later ? '<span class="due-tag over">⚠ pushed later</span>' : "";
    var cnt = (num(c.n_changes) > 1) ? '<span class="dd-count">×' + c.n_changes + '</span>' : "";
    return '<div class="taskrow due mod">' +
      '<span class="trbadge grey">DUE</span>' +
      '<span class="trname" title="' + escAttr(c.name) + '">' + esc(c.name) + "</span>" +
      change + later + cnt +
      '<span class="trwho" title="Changed by">✏️ ' + by + ' · ' + fmtDD(c.changed_at) + "</span>" +
      '<a class="tasklink" href="' + ASANA_TASK + c.task_gid + '" target="_blank" rel="noopener">Open &#8599;</a></div>';
  }
  // Due-date view for the SELECTED sprint (same scope as the rest of the tab):
  //   Overdue · Due today · Modified due date (audit) · Missing due date.
  // "Done" uses the same isDone() rule, so anything already Released / in the UAT
  // pipeline is not flagged.
  function renderDueDates(sprint) {
    var grid = el("dueGrid"), list = el("dueList");
    if (!grid || !list) return;
    var now = new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var DAY = 86400000;
    var dueToday = [], overdue = [], missing = [];
    (data.items || []).forEach(function (i) {
      if (isDone(i)) return;
      if (String(i.sprint) !== String(sprint)) return;   // selected sprint only
      if (isExcludedAssignee(i.assignee)) return;         // hide PMs/leads (config.js)
      if (!i.due_on) { missing.push(i); return; }         // no due date set
      var d = parseDue(i.due_on);
      if (!d) { missing.push(i); return; }
      var diff = Math.round((today - d) / DAY);  // >0 late, 0 today, <0 future
      delete i._lateDays;
      if (diff === 0) dueToday.push(i);
      else if (diff > 0) { i._lateDays = diff; overdue.push(i); }
    });
    // Modified due dates for this sprint (from the audit table); red-flag pushed-later.
    var modified = (data.dueChanges || []).filter(function (c) {
      return String(c.sprint) === String(sprint) && (c.modified === true || c.modified === "true") && !isExcludedAssignee(c.assignee);
    }).sort(function (a, b) {
      var pa = a.pushed_later ? 1 : 0, pb = b.pushed_later ? 1 : 0;
      if (pa !== pb) return pb - pa;
      return String(b.changed_at || "").localeCompare(String(a.changed_at || ""));
    });
    var pushedLater = modified.filter(function (c) { return c.pushed_later; }).length;
    grid.innerHTML =
      statCard("Overdue", overdue.length, "missed due date", "#ef4444", "⚠️", "#ef4444",
        "Open (not-done) tasks in the selected sprint whose due date has already passed.") +
      statCard("Modified", modified.length, (pushedLater ? pushedLater + " pushed later" : "due date changed"), (pushedLater ? "#ef4444" : "#2f6df6"), "✏️", "#2f6df6",
        "Tickets in this sprint whose due date was changed or removed after being set — audit to catch dates moved to dodge overdue.") +
      statCard("Due Today", dueToday.length, "open tasks this sprint", "#e07b2f", "📅", "#f5883f",
        "Open (not-done) tasks in the selected sprint whose Asana due date is today.") +
      statCard("Missing Due Date", missing.length, "no date set", "#8a74f4", "❓", "#8a74f4",
        "Open tasks in this sprint with no due date set in Asana — set one so they can be tracked.");
    var blocks = "";
    if (overdue.length) {
      overdue.sort(function (a, b) { return b._lateDays - a._lateDays; });
      var idO = "due-overdue"; if (_collapse[idO] === undefined) _collapse[idO] = false;
      blocks += listBlock(idO, 'Overdue <span class="due-cnt over">' + overdue.length + '</span>', overdue.map(dueTaskRow).join(""));
    }
    if (modified.length) {
      var idM = "due-modified"; if (_collapse[idM] === undefined) _collapse[idM] = false;
      blocks += listBlock(idM,
        'Modified due date <span class="due-cnt over">' + modified.length + '</span>' + (pushedLater ? ' <span class="due-cnt over">' + pushedLater + ' pushed later</span>' : ''),
        modified.map(modifiedRow).join(""));
    }
    if (dueToday.length) {
      var idT = "due-today"; if (_collapse[idT] === undefined) _collapse[idT] = false;
      blocks += listBlock(idT, 'Due today <span class="due-cnt today">' + dueToday.length + '</span>', dueToday.map(dueTaskRow).join(""));
    }
    if (missing.length) {
      var idN = "due-missing"; if (_collapse[idN] === undefined) _collapse[idN] = false;  // often long — collapsed by default
      blocks += listBlock(idN, 'Missing due date <span class="due-cnt today">' + missing.length + '</span>', missing.map(missingRow).join(""));
    }
    if (!blocks) {
      list.innerHTML = '<div class="muted" style="padding:10px 2px">Nothing due today, nothing overdue, no changes, and every task has a due date in Sprint ' + esc(String(sprint)) + '. 🎉</div>';
      return;
    }
    list.innerHTML = blocks;
  }

  // ---------- Ready for UAT ----------
  var _UAT_MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function uatFmtDay(d) { return d.getDate() + " " + _UAT_MON[d.getMonth()]; }
  // Calendar-day difference (local), so a ticket added yesterday reads "1d" even if
  // only ~21h have elapsed — matches the "added <date>" label and how people count.
  function uatDays(ss) {
    var a = new Date(ss.getFullYear(), ss.getMonth(), ss.getDate());
    var now = new Date();
    var t = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((t - a) / 86400000);
  }
  function uatTaskRow(it) {
    var ss = it.section_since ? new Date(it.section_since) : null;
    var days = ss ? uatDays(ss) : null;
    var ageCls = days == null ? "" : (days >= 7 ? "over" : days >= 3 ? "warn" : "ok");
    var added = ss ? '<span class="due-tag added">📅 added ' + uatFmtDay(ss) + '</span>'
                   : '<span class="due-tag added">📅 date n/a</span>';
    var wait = days == null ? "" : '<span class="uat-age ' + ageCls + '">' + days + 'd in UAT</span>';
    var who = it.assignee ? esc(it.assignee) : '<span class="muted">Unassigned</span>';
    return '<div class="taskrow uat">' +
      '<span class="trbadge ' + priClass(it.priority) + '">' + shortPri(it.priority) + "</span>" +
      '<span class="trname" title="' + escAttr(it.name) + '">' + esc(it.name) + "</span>" +
      '<span class="trwho" title="Assignee">👤 ' + who + "</span>" +
      (num(it.sprint) > 0 ? '<span class="trstatus">S' + it.sprint + "</span>" : "") +
      added + wait +
      '<a class="tasklink" href="' + ASANA_TASK + it.task_gid + '" target="_blank" rel="noopener">Open &#8599;</a></div>';
  }
  // Filters for the Ready-for-UAT bucket: developer + date-added range.
  // _uatTab: "current" = tickets sitting in Ready for UAT now (current state);
  //          "sent"    = every "moved into Ready for UAT" EVENT this sprint,
  //                      irrespective of where the ticket ended up (throughput).
  var _uatSprint = null, _uatDev = "all", _uatRange = "all", _uatTab = "current";
  var UAT_RANGES = [["all", "All time"], ["today", "Today"], ["yesterday", "Yesterday"], ["7", "Last 7 days"], ["15", "Last 15 days"], ["month", "Month"], ["custom", "Custom"]];
  function uatRangeLabelFull(v) { for (var i = 0; i < UAT_RANGES.length; i++) if (UAT_RANGES[i][0] === v) return UAT_RANGES[i][1]; return "All time"; }
  var _UAT_RANGE_LABEL = { all: "awaiting UAT", today: "added today", yesterday: "added yesterday", "7": "added last 7 days", "15": "added last 15 days", month: "added this month" };
  function uatRangeBounds() {
    var v = _uatRange;
    var now = new Date();
    var t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());   // local midnight today
    var from = null, to = null;
    if (v === "today") { from = t0; to = t0; }
    else if (v === "yesterday") { var y = new Date(t0.getTime() - 86400000); from = y; to = y; }
    else if (v === "7") { from = new Date(t0.getTime() - 6 * 86400000); to = t0; }
    else if (v === "15") { from = new Date(t0.getTime() - 14 * 86400000); to = t0; }
    else if (v === "month") { from = new Date(now.getFullYear(), now.getMonth(), 1); to = t0; }
    else if (v === "custom") {
      var f = el("uatFrom") && el("uatFrom").value, tt = el("uatTo") && el("uatTo").value;
      from = f ? new Date(f + "T00:00:00") : null;
      to = tt ? new Date(tt + "T00:00:00") : null;
    }
    return { v: v, from: from, to: to };
  }
  // Full developer list = every assignee seen across the project (from Asana via
  // fact_workitems), minus the excluded PM/lead names — so you can pick anyone,
  // even a dev with no ticket currently in the UAT bucket.
  function uatDevNames() {
    var names = {};
    if (_uatTab === "sent") {
      // Movers who sent a ticket to Ready for UAT in the selected sprint (any state).
      (data.uatMoves || []).forEach(function (m) {
        if (_uatSprint != null && String(m.sprint) !== String(_uatSprint)) return;
        if (m.moved_by && !isExcludedAssignee(m.moved_by)) names[m.moved_by] = 1;
      });
    } else {
      (data.items || []).forEach(function (i) { if (i.assignee && !isExcludedAssignee(i.assignee)) names[i.assignee] = 1; });
    }
    return Object.keys(names).sort(function (a, b) { return a.toLowerCase() < b.toLowerCase() ? -1 : 1; });
  }
  function uatDevLabel() { return _uatDev === "all" ? "All developers" : _uatDev; }
  // Renders the searchable dropdown list, filtered by the search box text.
  function renderUatDevList(q) {
    var wrap = el("uatDevList"); if (!wrap) return;
    q = (q || "").trim().toLowerCase();
    var opts = ["all"].concat(uatDevNames()).filter(function (n) {
      return n === "all" ? (q === "" || "all developers".indexOf(q) !== -1) : n.toLowerCase().indexOf(q) !== -1;
    });
    wrap.innerHTML = opts.length
      ? opts.map(function (n) {
          return '<div class="combo-opt' + (n === _uatDev ? " sel" : "") + '" data-v="' + escAttr(n) + '">' +
            (n === "all" ? "All developers" : esc(n)) + '</div>';
        }).join("")
      : '<div class="combo-empty">No match</div>';
  }
  // Validate the saved developer against the current list and update the button label.
  function uatPopulateDevs() {
    var names = uatDevNames();
    if (_uatDev !== "all" && names.indexOf(_uatDev) === -1) _uatDev = "all";
    var btn = el("uatDevBtn"); if (btn) btn.textContent = uatDevLabel();
    return _uatDev;
  }
  // Date-range combobox (same style as the developer one; no search box).
  function renderUatRangeList() {
    var wrap = el("uatRangeList"); if (!wrap) return;
    wrap.innerHTML = UAT_RANGES.map(function (o) {
      return '<div class="combo-opt' + (o[0] === _uatRange ? " sel" : "") + '" data-v="' + o[0] + '">' + o[1] + '</div>';
    }).join("");
  }
  function uatSyncRangeUI() {
    var btn = el("uatRangeBtn"); if (btn) btn.textContent = uatRangeLabelFull(_uatRange);
    var cust = el("uatCustom"); if (cust) cust.classList.toggle("hidden", _uatRange !== "custom");
  }
  // Tab labels/intro/filter-label change between the two Ready-for-UAT views.
  var _UAT_INTRO = {
    current: 'Tickets in the <b>selected sprint</b> currently handed to testing (board column <b>Ready for UAT</b>), with the date each entered the column and how long it has been waiting. Filter by <b>developer</b> and by <b>when they were added</b>.',
    sent: 'Every time a developer <b>moved a ticket into Ready for UAT</b> in the <b>selected sprint</b> — counted as a throughput event, <b>irrespective of where the ticket is now</b> (so a ticket later closed by QA still counts). Attributed to <b>whoever moved the card</b>. A ticket bounced back and re-sent counts each time. Filter by <b>developer</b> and by <b>when it was sent</b> to see how many each dev sends per day.'
  };
  function updateUatTabUI() {
    var tc = el("uatTabCurrent"), ts = el("uatTabSent");
    if (tc) tc.classList.toggle("active", _uatTab === "current");
    if (ts) ts.classList.toggle("active", _uatTab === "sent");
    var intro = el("uatIntro"); if (intro) intro.innerHTML = _UAT_INTRO[_uatTab] || "";
    var lbl = el("uatRangeLabel"); if (lbl) lbl.textContent = _uatTab === "sent" ? "Sent" : "Added";
  }
  // Dispatcher: paints whichever Ready-for-UAT tab is active into the shared
  // uatGrid / uatList containers.
  function renderReadyForUAT(sprint) {
    _uatSprint = sprint;
    updateUatTabUI();
    if (_uatTab === "sent") return renderUatSent(sprint);
    return renderUatCurrent(sprint);
  }

  // One "sent to UAT" event row: ticket, who moved it, when, and its CURRENT state
  // (so you can see it was sent even though it's now Released / closed).
  function uatMoveRow(m, cur) {
    var dt = m.moved_at ? new Date(m.moved_at) : null;
    var when = dt ? '<span class="due-tag added">➡️ sent ' + uatFmtDay(dt) + '</span>' : '';
    var by = m.moved_by ? esc(m.moved_by) : '<span class="muted">Unknown</span>';
    // Current state badge, derived from the live ticket (data.items) if we still have it.
    var stateTxt = cur ? (cur.section || cur.status || "—") : "—";
    var done = cur && (String(cur.is_completed) === "1" || String(cur.is_delivered) === "1" || !!cur.completed_at
      || /UAT Passed|Ready for Production|Released|Done|Closed/i.test(cur.section || ""));
    var still = cur && /^\s*ready for uat\s*$/i.test(cur.section || "");
    var stCls = done ? "ok" : still ? "warn" : "";
    return '<div class="taskrow uat">' +
      '<span class="trbadge ' + priClass(m.priority || (cur && cur.priority)) + '">' + shortPri(m.priority || (cur && cur.priority)) + "</span>" +
      '<span class="trname" title="' + escAttr(m.name) + '">' + esc(m.name) + "</span>" +
      '<span class="trwho" title="Moved to UAT by">🧑‍💻 ' + by + "</span>" +
      (num(m.sprint) > 0 ? '<span class="trstatus">S' + m.sprint + "</span>" : "") +
      when +
      '<span class="uat-age ' + stCls + '" title="Current state">' + esc(stateTxt) + "</span>" +
      '<a class="tasklink" href="' + ASANA_TASK + m.task_gid + '" target="_blank" rel="noopener">Open &#8599;</a></div>';
  }

  // "Sent to UAT" throughput view: one row per move-into-UAT event this sprint,
  // filtered by mover (developer) and by when it was sent. Shows a per-developer
  // and per-day breakdown so you can see how many stories each dev sends per day.
  function renderUatSent(sprint) {
    _uatSprint = sprint;
    var grid = el("uatGrid"), list = el("uatList");
    if (!grid || !list) return;
    // Live-ticket lookup for the current-state badge.
    var byGid = {};
    (data.items || []).forEach(function (i) { byGid[i.task_gid] = i; });
    var base = (data.uatMoves || []).filter(function (m) {
      return String(m.sprint) === String(sprint) && !isExcludedAssignee(m.moved_by);
    });
    var dev = uatPopulateDevs();
    var rb = uatRangeBounds();
    var inRange = function (dt) {
      if (!dt) return false;
      var d = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
      if (rb.from && d < rb.from) return false;
      if (rb.to && d > rb.to) return false;
      return true;
    };
    var evs = base.filter(function (m) {
      if (dev !== "all" && (m.moved_by || "") !== dev) return false;
      return rb.v === "all" ? true : inRange(m.moved_at ? new Date(m.moved_at) : null);
    });
    evs.sort(function (a, b) { var av = a.moved_at || "", bv = b.moved_at || ""; return av < bv ? 1 : av > bv ? -1 : 0; });   // newest send first
    // Aggregates.
    var byDev = {}, byDay = {}, tickets = {};
    evs.forEach(function (m) {
      byDev[m.moved_by || "Unknown"] = (byDev[m.moved_by || "Unknown"] || 0) + 1;
      tickets[m.task_gid] = 1;
      if (m.moved_at) { var d = new Date(m.moved_at); var k = d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate(); byDay[k] = byDay[k] || { d: d, n: 0 }; byDay[k].n++; }
    });
    var devN = Object.keys(byDev).length;
    var rangeLbl = _UAT_RANGE_LABEL[rb.v] || "sent in range";
    rangeLbl = (rangeLbl || "").replace(/^added/, "sent");
    if (rb.v === "all") rangeLbl = "all time";
    if (rb.v === "custom") rangeLbl = "sent " + (rb.from ? uatFmtDay(rb.from) : "start") + " – " + (rb.to ? uatFmtDay(rb.to) : "today");
    var sub = rangeLbl + (dev !== "all" ? " · " + dev : "");
    grid.innerHTML =
      statCard("Sent to UAT", evs.length, sub, "#2f6df6", "➡️", "#2f6df6",
        "Number of times a ticket was moved into Ready for UAT in this sprint" + (dev !== "all" ? ", by " + dev : "") + (rb.v === "all" ? "" : ", within the selected range") + ". Counts every send, even if the ticket was later closed.") +
      statCard("Developers", devN, "sent ≥1 in range", "#7b61ff", "🧑‍💻", "#7b61ff", "Distinct developers who sent at least one ticket to UAT in the current filter.") +
      statCard("Distinct tickets", Object.keys(tickets).length, "unique stories", "#22a565", "🎫", "#22a565", "Unique tickets sent (a ticket re-sent after a bounce is counted once here, but each send counts in 'Sent to UAT').");
    if (!evs.length) {
      list.innerHTML = '<div class="muted" style="padding:10px 2px">No tickets were sent to Ready for UAT under this filter in Sprint ' + esc(String(sprint)) + '.</div>';
      return;
    }
    // Per-day breakdown (desc by date) — how many stories were sent each day.
    var dayRows = Object.keys(byDay).map(function (k) { return byDay[k]; })
      .sort(function (a, b) { return b.d - a.d; })
      .map(function (o) {
        return '<div class="taskrow uat"><span class="trname">📅 ' + esc(uatFmtDay(o.d)) + '</span>' +
          '<span class="uat-age" title="Stories sent that day">' + o.n + ' sent</span></div>';
      }).join("");
    var idDay = "uat-sent-day", idList = "uat-sent-list";
    if (_collapse[idDay] === undefined) _collapse[idDay] = false;    // day breakdown collapsed by default
    if (_collapse[idList] === undefined) _collapse[idList] = false;  // event list collapsed by default
    list.innerHTML =
      listBlock(idDay, "By day — " + Object.keys(byDay).length + " day" + (Object.keys(byDay).length !== 1 ? "s" : ""), dayRows) +
      listBlock(idList, "Sends — " + evs.length + " event" + (evs.length !== 1 ? "s" : ""), evs.map(function (m) { return uatMoveRow(m, byGid[m.task_gid]); }).join(""));
  }

  // The selected sprint's Ready-for-UAT bucket (section_since = when it entered the
  // column), filtered by developer and by date-added so you can count how many were
  // added per day / week / custom range. Sorted longest-waiting first.
  function renderUatCurrent(sprint) {
    _uatSprint = sprint;
    var grid = el("uatGrid"), list = el("uatList");
    if (!grid || !list) return;
    var base = (data.items || []).filter(function (i) {
      return /^\s*ready for uat\s*$/i.test(i.section || "") && String(i.sprint) === String(sprint) && !isExcludedAssignee(i.assignee);
    });
    var dev = uatPopulateDevs();
    var rb = uatRangeBounds();
    var inRange = function (ss) {
      if (!ss) return rb.from == null && rb.to == null;   // undated tickets only count in "all time"
      var d = new Date(ss.getFullYear(), ss.getMonth(), ss.getDate());
      if (rb.from && d < rb.from) return false;
      if (rb.to && d > rb.to) return false;
      return true;
    };
    var items = base.filter(function (i) {
      if (dev !== "all" && (i.assignee || "") !== dev) return false;
      return inRange(i.section_since ? new Date(i.section_since) : null);
    });
    items.sort(function (a, b) {
      var av = a.section_since || "", bv = b.section_since || "";
      if (!av && !bv) return 0; if (!av) return 1; if (!bv) return -1;
      return av < bv ? -1 : av > bv ? 1 : 0;
    });
    var dated = items.filter(function (i) { return i.section_since; });
    var oldest = dated.length ? uatDays(new Date(dated[0].section_since)) : 0;
    var rangeLbl = _UAT_RANGE_LABEL[rb.v] || "added in range";
    if (rb.v === "custom") {
      rangeLbl = "added " + (rb.from ? uatFmtDay(rb.from) : "start") + " – " + (rb.to ? uatFmtDay(rb.to) : "today");
    }
    var sub = rangeLbl + (dev !== "all" ? " · " + dev : "");
    grid.innerHTML =
      statCard((rb.v === "all" ? "In Ready for UAT" : "Added to UAT"), items.length, sub, "#2f6df6", "🧪", "#2f6df6",
        "Tickets in this sprint in Ready for UAT" + (rb.v === "all" ? "" : ", added within the selected range") + (dev !== "all" ? ", by " + dev : "") + ".") +
      statCard("Longest waiting", (dated.length ? oldest + "d" : "—"), "since added to UAT", "#e07b2f", "⏳", "#f5883f",
        "Days the oldest matching ticket has been sitting in Ready for UAT.");
    if (!items.length) {
      list.innerHTML = '<div class="muted" style="padding:10px 2px">No Ready-for-UAT tickets match this filter in Sprint ' + esc(String(sprint)) + '.</div>';
      return;
    }
    var id = "uat-all";
    if (_collapse[id] === undefined) _collapse[id] = false;   // collapsed by default
    list.innerHTML = listBlock(id,
      "Ready for UAT — " + items.length + " ticket" + (items.length !== 1 ? "s" : ""),
      items.map(uatTaskRow).join(""));
  }

  function renderRisks(sprint) {
    // Delivery Risks: manually-curated list (Supabase `risks` table). Repo/security
    // risks live on Engineering. The whole Risks section is HIDDEN unless the selected
    // sprint has a live risk — a risk tagged to this sprint, or left untagged (always-on).
    // Stale risks from OTHER sprints are no longer shown (they read as "old data").
    var section = el("risksSection");
    var rs = data.risks.filter(function (r) { return !isEngRisk(r); });
    var isCurrent = function (r) { var s = String(r.sprint == null ? "" : r.sprint).trim(); return s === "" || s === String(sprint); };
    var current = rs.filter(isCurrent);
    if (section) section.classList.toggle("hidden", current.length === 0);
    if (!current.length) return;   // nothing to render; section hidden above

    var counts = { red: 0, amber: 0, green: 0 };
    current.forEach(function (r) { var k = (r.rag || "").toLowerCase(); if (counts[k] != null) counts[k]++; });
    if (el("riskCards")) el("riskCards").innerHTML =
      card("Red", '<span class="dot red"></span> ' + counts.red) +
      card("Amber", '<span class="dot amber"></span> ' + counts.amber) +
      card("Green", '<span class="dot green"></span> ' + counts.green);
    if (el("riskList")) el("riskList").innerHTML = current.map(riskCardHtml).join("");
  }

  // Escape text, then turn any URL into a clickable link (e.g. Asana story links).
  function linkify(s) {
    return esc(s).replace(/(https?:\/\/[^\s]+)/g, function (u) {
      return '<a class="tasklink" href="' + u + '" target="_blank" rel="noopener">Open story &#8599;</a>';
    });
  }

  function renderCharts(sprint, m) {
    var sorted = data.sprints.slice().filter(function (s) { return s.sprint != null && inWindow(num(s.sprint)); })
      .sort(function (a, b) { return num(a.sprint) - num(b.sprint); });
    var labels = sorted.map(function (s) { return "S" + s.sprint; });
    // Use the SAME live computation as Sprint Health (compute()/sprintAgg) rather than
    // the stored dim_sprint columns, which go stale for in-progress/recent sprints.
    var aggs = sorted.map(function (s) { return sprintAgg(num(s.sprint)); });
    if (velChart) velChart.destroy();
    velChart = new Chart(el("velChart"), {
      type: "bar",
      data: { labels: labels, datasets: [
        { label: "Delivered SP", data: aggs.map(function (a) { return a.delivered; }), backgroundColor: "#0f8b8d" },
        { label: "Committed SP", data: aggs.map(function (a) { return a.committed; }), type: "line", borderColor: "#1f6feb", backgroundColor: "transparent", tension: .3 } ] },
      options: { responsive: true, plugins: { legend: { position: "bottom" } }, scales: { y: { beginAtZero: true } } },
    });
    // (Status mix doughnut removed.)
  }

  // Per-sprint aggregate for the trend charts (across the visible sprint window).
  function sprintAgg(sn) {
    var mm = compute(sn);
    var committed = mm.usePts ? mm.committedSP : mm.planned;
    var delivered = mm.usePts ? mm.deliveredSP : mm.completed;
    var bugItems = mm.its.filter(isBug);
    return {
      sprint: sn, committed: Math.round(committed), delivered: Math.round(delivered),
      carry: Math.round(mm.usePts ? mm.carryFwdSP : mm.carryFwdItems),
      predict: mm.predictability != null ? Math.round(mm.predictability * 100) : null,
      dev: mm.devDays, qa: mm.qaDays, cycle: mm.cycleDays,
      bugsRaised: bugItems.length, bugsClosed: bugItems.filter(isDone).length,
    };
  }

  function renderTrends(sprint, m) {
    var sns = windowSprints().sort(function (a, b) { return a - b; });
    var agg = sns.map(sprintAgg);
    var labels = agg.map(function (a) { return "S" + a.sprint; });

    // KPI row: forecast velocity, flow efficiency, aging of open work.
    var gids = {}; m.its.forEach(function (i) { gids[i.task_gid] = 1; });
    var fl = data.flow.filter(function (f) { return gids[f.task_gid]; });
    var activeD = fl.reduce(function (a, f) { return a + num(f.cycle_days); }, 0);
    var blockedD = fl.reduce(function (a, f) { return a + num(f.blocked_hours); }, 0) / 24;
    var flowEff = (activeD + blockedD) > 0 ? activeD / (activeD + blockedD) : null;
    var now = new Date();
    var ages = m.its.filter(function (i) { return !isDone(i) && i.created_at; })
      .map(function (i) { return (now - new Date(i.created_at)) / 86400000; }).filter(function (v) { return v >= 0; });
    var avgAge = ages.length ? ages.reduce(function (a, b) { return a + b; }, 0) / ages.length : null;
    var maxAge = ages.length ? Math.max.apply(null, ages) : null;
    var avgVel = agg.length ? agg.reduce(function (a, x) { return a + x.delivered; }, 0) / agg.length : 0;
    // Delivery Trends & Flow section was removed — only render its KPI grid + chart
    // if those DOM nodes still exist (the rest of this fn drives Sprint Health charts).
    if (el("trendKpiGrid")) {
      el("trendKpiGrid").innerHTML =
        card("Avg Velocity", Math.round(avgVel) + ' <small>SP/sprint</small>', { icon: "⚡", accent: "#0f8b8d", tip: "Mean delivered story points across the last " + agg.length + " sprints — the number to forecast future capacity with." }) +
        card("Flow Efficiency", flowEff != null ? pct(flowEff) : "--", { icon: "🌊", accent: "#1f6feb", tip: "Active build+test time ÷ (active + blocked) time. Higher = less time stuck waiting. Needs the --with-flow sync." }) +
        card("Avg Age (open)", avgAge != null ? avgAge.toFixed(1) + ' <small>days</small>' : "--", { icon: "⏳", accent: "#f29f05", tip: "Average days the still-open stories have been alive (created → now). Rising = work is aging." }) +
        card("Oldest Open", maxAge != null ? Math.round(maxAge) + ' <small>days</small>' : "--", { icon: "🕰️", accent: "#c62828", tip: "Age of the oldest still-open story in this sprint — a candidate to unblock or split." });
    }
    if (el("predictChart")) mkChart("predictChart", {
      type: "bar",
      data: { labels: labels, datasets: [
        { type: "bar", label: "Carryover SP", data: agg.map(function (a) { return a.carry; }), backgroundColor: "#f29f05", borderRadius: 5, yAxisID: "y" },
        { type: "line", label: "Predictability %", data: agg.map(function (a) { return a.predict; }), borderColor: "#1f6feb", backgroundColor: "transparent", tension: .3, yAxisID: "y1" } ] },
      options: { responsive: true, plugins: { legend: { position: "bottom" } },
        scales: { y: { beginAtZero: true, title: { display: true, text: "carryover SP" } },
          y1: { beginAtZero: true, suggestedMax: 100, position: "right", grid: { drawOnChartArea: false }, title: { display: true, text: "predictability %" } } } } });

    // Bugs — dual AREA chart (Total pink / Closed green) with point value labels.
    var bugLabels = { id: "bugLabels", afterDatasetsDraw: function (chart) {
      var ctx = chart.ctx;
      chart.data.datasets.forEach(function (ds, di) {
        var meta = chart.getDatasetMeta(di);
        meta.data.forEach(function (pt, i) {
          var v = ds.data[i]; if (v == null) return;
          ctx.save(); ctx.font = "700 11px 'Fira Sans',sans-serif"; ctx.textAlign = "center";
          ctx.fillStyle = di === 0 ? "#e94b6a" : "#22a565";
          ctx.fillText(v, pt.x, di === 0 ? pt.y - 9 : pt.y + 17); ctx.restore();
        });
      });
    } };
    mkChart("bugTrendChart", {
      type: "line",
      data: { labels: labels, datasets: [
        { label: "Total Bugs", data: agg.map(function (a) { return a.bugsRaised; }), borderColor: "#e94b6a", borderWidth: 2.4, tension: .4, fill: true, backgroundColor: "rgba(233,75,106,.14)", pointRadius: 4, pointBackgroundColor: "#fff", pointBorderColor: "#e94b6a", pointBorderWidth: 2, pointHoverRadius: 6 },
        { label: "Closed", data: agg.map(function (a) { return a.bugsClosed; }), borderColor: "#22a565", borderWidth: 2.4, tension: .4, fill: true, backgroundColor: "rgba(34,165,101,.16)", pointRadius: 4, pointBackgroundColor: "#fff", pointBorderColor: "#22a565", pointBorderWidth: 2, pointHoverRadius: 6 } ] },
      options: { responsive: true, maintainAspectRatio: false, layout: { padding: { top: 18 } },
        plugins: { legend: { position: "top", align: "end", labels: { usePointStyle: true, pointStyle: "circle", boxWidth: 8, padding: 14, color: "#8f9fb5", font: { size: 11.5, weight: "600" } } } },
        scales: { y: { beginAtZero: true, grid: { color: "rgba(125,142,170,.14)" }, border: { display: false }, ticks: { color: "#8f9fb5" } },
          x: { grid: { display: false }, border: { display: false }, ticks: { color: "#8f9fb5" } } } },
      plugins: [bugLabels],
    });

    // Work in progress — custom rows (icon + bar + count + %) + total donut.
    if (el("wipCustom")) el("wipCustom").innerHTML = wipHTML(m);
  }

  function wipHTML(m) {
    var stages = [
      { name: "In Dev", ic: "&lt;/&gt;", v: m.inDev, c: "#7b61ff" },
      { name: "In QA", ic: "🧪", v: m.inQA, c: "#3b82f6" },
      { name: "Blocked", ic: "⛔", v: m.blocked, c: "#ef4444" },
      { name: "Ready", ic: "✅", v: m.ready, c: "#f5a623" },
      { name: "Released", ic: "🚀", v: m.released, c: "#22c55e" } ];
    var total = stages.reduce(function (s, x) { return s + (x.v || 0); }, 0);
    var denom = total || 1, maxv = Math.max.apply(null, stages.map(function (x) { return x.v || 0; })) || 1;
    var rows = stages.map(function (x) {
      var pct = Math.round(100 * (x.v || 0) / denom), w = Math.round(100 * (x.v || 0) / maxv);
      return '<div class="wiprow" style="--wc:' + x.c + '"><span class="wipic">' + x.ic + '</span><span class="wipname">' + x.name + '</span>' +
        '<span class="wiptrack"><span style="width:' + Math.max(2, w) + '%"></span></span>' +
        '<span class="wipval">' + (x.v || 0) + '</span><span class="wippct">' + pct + '%</span></div>';
    }).join("");
    var acc = 0, segs = [];
    stages.forEach(function (x) { var f = (x.v || 0) / denom; if (f > 0) segs.push(x.c + ' ' + (acc * 360).toFixed(1) + 'deg ' + ((acc + f) * 360).toFixed(1) + 'deg'); acc += f; });
    var donut = 'conic-gradient(' + (segs.length ? segs.join(',') : 'var(--surface-3) 0deg 360deg') + ')';
    return '<div class="wipwrap"><div class="wiprows">' + rows + '</div>' +
      '<div class="wipdonut" style="background:' + donut + '"><div class="wipdc"><b>' + total + '</b><span>Total Stories</span></div></div></div>';
  }

  // ---------- engineering page ----------
  function postureClass(p) { return p === "Red" ? "red" : p === "Yellow" ? "amber" : "green"; }
  function sevClass(s) { s = (s || "").toUpperCase(); return (s === "CRITICAL" || s === "HIGH") ? "red" : s === "MEDIUM" ? "amber" : s === "LOW" ? "green" : ""; }
  function kv(k, v, tip) {
    var t = tip ? ' <span class="tip" data-tip="' + escAttr(tip) + '">i</span>' : "";
    return '<div class="kv"><span class="k">' + k + t + "</span><span>" + (v == null || v === "" ? "--" : v) + "</span></div>";
  }
  function advisoryUrl(a) {
    a = a || "";
    if (a.indexOf("GHSA") === 0) return "https://github.com/advisories/" + a;
    if (a.indexOf("CVE") === 0) return "https://nvd.nist.gov/vuln/detail/" + a;
    return null;
  }
  // TEMP one-off override (remove to restore): ignore the unreviewed-feature-merges
  // posture reason for these repos so they don't read Yellow for it right now.
  var TEMP_IGNORE_UNREV = { "Dallal-BE-ROR": 1, "Dallal-React-Native-Mobile": 1 };
  // Posture as displayed — recomputed (ignoring unreviewed merges) for TEMP-overridden repos.
  function displayPosture(r) {
    if (!TEMP_IGNORE_UNREV[r.repo]) return r.posture;
    var c = num(r.open_critical), h = num(r.open_high);
    if (c > 0 || h >= 10) return "Red";
    if (h > 0) return "Yellow";
    return "Green";
  }
  function postureReason(r) {
    var out = [], c = r.open_critical, h = r.open_high;
    if (c === "" && h === "") out.push("vuln scan pending");
    else if (num(c) > 0 || num(h) > 0) out.push(num(c) + " Critical + " + num(h) + " High CVEs");
    if (num(r.unreviewed_merges_30d) > 0 && !TEMP_IGNORE_UNREV[r.repo]) out.push(r.unreviewed_merges_30d + " unreviewed feature merges");
    return out;
  }
  function flag(v) { return (String(v) === "1") ? '<span class="flag-ok">on</span>' : '<span class="flag-no">off</span>'; }
  function pctOr(v) { return (v == null || v === "") ? "--" : v + "%"; }

  // ---------- CSV export (share Engineering tables with developers) ----------
  function csvCell(v) { return '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"'; }
  function toCSV(rows, cols) {
    var lines = [cols.map(function (c) { return csvCell(c.label); }).join(",")];
    rows.forEach(function (r) { lines.push(cols.map(function (c) { return csvCell(c.val ? c.val(r) : r[c.key]); }).join(",")); });
    return lines.join("\r\n");
  }
  function downloadCSV(name, text) {
    var blob = new Blob(["﻿" + text], { type: "text/csv;charset=utf-8" });   // BOM so Excel reads UTF-8
    var url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
  }
  function csvStamp() { return new Date().toISOString().slice(0, 10); }
  function exportVulns() {
    var rows = (data.vulns || []).filter(function (v) { return v.package; });
    downloadCSV("dallal-security-vulnerabilities-" + csvStamp() + ".csv", toCSV(rows, [
      { key: "severity", label: "Severity" }, { key: "repo", label: "Repo" }, { key: "package", label: "Package" },
      { key: "version", label: "Version" }, { key: "advisory", label: "Advisory" },
      { label: "Advisory URL", val: function (r) { return advisoryUrl(r.advisory) || ""; } },
      { key: "fixed_in", label: "Fixed in" },
      { key: "direct", label: "Direct dependency" }, { key: "summary", label: "What it is" },
    ]));
  }
  function exportRepoHealth() {
    var rows = (data.repos || []);
    downloadCSV("dallal-engineering-repo-health-" + csvStamp() + ".csv", toCSV(rows, [
      { key: "repo", label: "Repo" },
      { key: "posture", label: "Posture" },
      { label: "Why posture", val: function (r) { return postureReason(r).join(" | "); } },
      { key: "review_coverage_pct", label: "PR review coverage %" },
      { key: "unreviewed_merges_30d", label: "Unreviewed feature merges (30d)" },
      { key: "merged_prs_30d", label: "Merged feature PRs (30d)" },
      { key: "open_critical", label: "Open Critical CVEs" },
      { key: "open_high", label: "Open High CVEs" },
      { key: "open_medium", label: "Open Medium CVEs" },
      { key: "branch_protection", label: "Branch protection" },
      { key: "default_branch", label: "Default branch" },
    ]));
  }
  function exportEngRisks() {
    var rows = (data.risks || []).filter(isEngRisk);
    downloadCSV("dallal-engineering-risks-" + csvStamp() + ".csv", toCSV(rows, [
      { key: "risk_name", label: "Risk" }, { key: "rag", label: "RAG" }, { key: "category", label: "Category" },
      { key: "owner", label: "Owner" }, { key: "status", label: "Status" }, { key: "impact", label: "Impact" },
      { key: "mitigation", label: "Mitigation / action" },
    ]));
  }

  function renderEng() {
    var repos = data.repos;
    el("repoCards").innerHTML = repos.map(function (r) {
      var reason = postureReason(r), pst = displayPosture(r);
      return '<div class="repocard"><div class="rh"><span class="rn">' + esc(r.repo) + "</span>" +
        '<span class="rag ' + postureClass(pst) + '">' + esc(pst) + "</span></div>" +
        (reason.length ? '<div class="preason">Why ' + esc(pst) + ": " + reason.map(esc).join(" &middot; ") + "</div>" : "") +
        kv("PR review coverage", pctOr(r.review_coverage_pct), "Share of FEATURE PRs into dev merged with an approving review. Release-promotion PRs (dev→uat) are excluded. NB: this is code-review %, not test coverage.") +
        kv("Unreviewed feature merges", r.unreviewed_merges_30d, "Feature PRs merged into dev with no approving review. Promotion PRs (dev→uat) are NOT counted.") + "</div>";
    }).join("") || '<div class="card muted">No repo data. Run etl_github.py.</div>';

    el("postureCards").innerHTML = repos.map(function (r) {
      var pst = displayPosture(r);
      return card(r.repo.replace("Dallal-", ""), "", { rag: postureClass(pst), ragText: pst });
    }).join("");

    // (aggregate governance cards + vuln chart removed)

    // vuln table
    var body = data.vulns.filter(function (v) { return v.package; }).map(function (v) {
      var au = advisoryUrl(v.advisory);
      var adv = au ? '<a class="tasklink" href="' + au + '" target="_blank" rel="noopener">' + esc(v.advisory) + " &#8599;</a>" : esc(v.advisory);
      var fix = v.fixed_in ? "Upgrade &ge; <b>" + esc(v.fixed_in) + "</b>" : "—";
      return "<tr><td><span class='rag " + sevClass(v.severity) + "'>" + esc(v.severity) + "</span></td>" +
        "<td>" + esc((v.repo || "").replace("Dallal-", "")) + "</td><td>" + esc(v.package) + "</td>" +
        "<td>" + esc(v.version) + "</td><td>" + adv + "</td><td>" + fix + "</td>" +
        "<td class='muted'>" + esc(v.summary) + "</td></tr>";
    }).join("");
    el("vulnTable").querySelector("tbody").innerHTML = body ||
      "<tr><td colspan='7' class='muted'>No vulnerability data.</td></tr>";

    // Engineering / security risks (moved here from the delivery Risks section)
    var engRisks = data.risks.filter(isEngRisk);
    el("engRiskList").innerHTML = engRisks.map(riskCardHtml).join("") ||
      '<div class="muted">No engineering risks.</div>';

    // Unreviewed feature merges — the actual PR list (who's merging without review).
    // Bot/agent authors (e.g. @codexkw) are ignored — their merges aren't unreviewed human merges.
    var IGNORED_PR_AUTHORS = { codexkw: 1 };
    var uprs = (data.unreviewedPrs || []).filter(function (p) {
      return !IGNORED_PR_AUTHORS[String(p.author || "").toLowerCase()];
    }).slice().sort(function (a, b) { return String(b.merged_at || "").localeCompare(String(a.merged_at || "")); });
    var byRepo = {};
    uprs.forEach(function (p) { byRepo[p.repo] = (byRepo[p.repo] || 0) + 1; });
    el("unrevPrGrid").innerHTML =
      card("Unreviewed PRs (30d)", uprs.length, { icon: "🔓", accent: uprs.length ? "#c62828" : "#2e7d32", tip: "Feature/bugfix PRs merged into dev with no approving review in the last 30 days. Promotion PRs (dev→uat) are excluded — that code was reviewed on dev." }) +
      ["Dallal-BE-ROR", "Dallal-ReactJs", "Dallal-React-Native-Mobile"].map(function (r) {
        return card(r.replace("Dallal-", ""), byRepo[r] || 0, { icon: "📦", accent: (byRepo[r] || 0) ? "#b9820a" : "#2e7d32" });
      }).join("");
    el("unrevPrList").innerHTML = listBlock("unrevpr", "Feature PRs merged without an approving review &middot; " + uprs.length,
      uprs.length ? uprs.map(function (p) {
        return '<div class="taskrow"><div class="tasktitle">' +
          '<a class="tasklink" href="' + esc(p.url || "#") + '" target="_blank" rel="noopener">' +
          esc((p.repo || "").replace("Dallal-", "")) + " #" + esc(String(p.pr_number)) + " &#8599;</a>" +
          '<span class="muted"> &middot; @' + esc(p.author || "?") + " &middot; " + esc(p.merged_at || "") + " &rarr; " + esc(p.base || "") + "</span>" +
          '<div class="muted" style="font-size:12px;margin-top:2px">' + esc(p.title || "") + "</div></div></div>";
      }).join("") : '<div class="muted">No unreviewed feature merges in the last 30 days. 🎉</div>');
  }

  // "User Flow" is a parent tab holding 4 sub-tabs (Marketing, Re-engagement,
  // Recovery CRM, Journey). Remember the last sub-tab so re-opening User Flow returns to it.
  var lastUserFlowSub = "marketing";
  function showTab(which) {
    if (which === "userflow") which = lastUserFlowSub;
    var isMkt = which === "marketing", isFlow = which === "flow", isCrm = which === "crm", isJourney = which === "journey";
    var isSub = isMkt || isFlow || isCrm || isJourney;
    if (isSub) lastUserFlowSub = which;
    var isDel = which === "delivery", isEng = which === "eng", isFun = which === "funnels", isAppStore = which === "appstore";
    // views
    el("sprintView").classList.toggle("hidden", !isDel);
    el("engView").classList.toggle("hidden", !isEng);
    el("funnelView").classList.toggle("hidden", !isFun);
    el("marketingView").classList.toggle("hidden", !isMkt);
    el("flowView").classList.toggle("hidden", !isFlow);
    el("crmView").classList.toggle("hidden", !isCrm);
    el("journeyView").classList.toggle("hidden", !isJourney);
    el("appstoreView").classList.toggle("hidden", !isAppStore);
    // User Flow sub-tab bar visible only while a sub-tab is active
    el("userFlowTabs").classList.toggle("hidden", !isSub);
    // sprint selector only on Delivery
    el("sprintSel").classList.toggle("hidden", !isDel);
    el("sprintLbl").classList.toggle("hidden", !isDel);
    // top-level active states (User Flow lit for any of its sub-tabs)
    el("tabDelivery").classList.toggle("active", isDel);
    el("tabAppStore").classList.toggle("active", isAppStore);
    el("tabFunnels").classList.toggle("active", isFun);
    el("tabEng").classList.toggle("active", isEng);
    el("tabUserFlow").classList.toggle("active", isSub);
    // sub-tab active states
    el("tabMarketing").classList.toggle("active", isMkt);
    el("tabFlow").classList.toggle("active", isFlow);
    el("tabCrm").classList.toggle("active", isCrm);
    el("tabJourney").classList.toggle("active", isJourney);
    if (isEng) renderEng();
    if (isFun) renderFunnels();
    if (isMkt) renderMarketing();
    if (isAppStore) renderAppStore();
  }

  // ---------- funnels page ----------
  function funnelEnvs() {
    var s = {};
    (data.funnels || []).forEach(function (r) { s[r.env || "UAT"] = 1; });
    var envs = Object.keys(s);
    return envs.length ? envs.sort() : ["UAT"];
  }
  function populateFunnelEnv() {
    var sel = el("funnelEnv"); if (!sel) return "UAT";
    var envs = funnelEnvs();
    var saved = null; try { saved = localStorage.getItem("dallal_funnel_env"); } catch (e) {}
    var cur = (saved && envs.indexOf(saved) !== -1) ? saved : envs[0];
    sel.innerHTML = envs.map(function (e) { return '<option value="' + e + '"' + (e === cur ? " selected" : "") + ">Dallal " + e + "</option>"; }).join("");
    return cur;
  }
  var PLATFORM_LABEL = { All: "All platforms", web: "Web", android: "Android", ios: "iOS" };
  function funnelPlatforms(env) {
    var s = { All: 1 };
    var pool = (data.funnels && data.funnels.length ? data.funnels : []).concat(window.DALLAL_FUNNELS || []);
    pool.forEach(function (r) { if ((r.env || "UAT") === env) s[r.platform || "All"] = 1; });
    var order = ["All", "web", "android", "ios"];
    return Object.keys(s).sort(function (a, b) { return order.indexOf(a) - order.indexOf(b); });
  }
  function populateFunnelPlatform(env) {
    var sel = el("funnelPlatform"); if (!sel) return "All";
    var ps = funnelPlatforms(env);
    var saved = null; try { saved = localStorage.getItem("dallal_funnel_platform"); } catch (e) {}
    var cur = (saved && ps.indexOf(saved) !== -1) ? saved : "All";
    sel.innerHTML = ps.map(function (p) { return '<option value="' + p + '"' + (p === cur ? " selected" : "") + ">" + (PLATFORM_LABEL[p] || p) + "</option>"; }).join("");
    return cur;
  }
  // Rows for env+platform, grouped into funnels. Prefer live Supabase rows; if a
  // given env/platform view has none live (e.g. before the platform column is
  // populated), fall back to the bundled snapshot for that view.
  function rowsFor(src, env, platform) {
    return (src || []).filter(function (r) {
      return (r.env || "UAT") === env && (r.platform || "All") === platform;
    });
  }
  function funnelsData(env, platform) {
    platform = platform || "All";
    // Filter to the calendar's selected funnel window (window_days); retention /
    // always-on rows are tagged window_days=0 and show for any window.
    var w = (typeof funnelWindow === "function") ? funnelWindow() : 30;
    var byWin = function (r) { var wd = num(r.window_days); return wd === w || wd === 0; };
    var live = rowsFor(data.funnels, env, platform).filter(byWin);
    var rows = live.length ? live : rowsFor(window.DALLAL_FUNNELS, env, platform);
    if (!rows.length) return [];
    var isLive = live.length > 0;
    var g = {};
    rows.forEach(function (r) { (g[r.funnel] = g[r.funnel] || []).push(r); });
    var src = "Amplitude · Dallal-" + env + (platform === "All" ? "" : " · " + (PLATFORM_LABEL[platform] || platform)) + (isLive ? " · " + funnelRangeLabel() : " · last 30d");
    return Object.keys(g).map(function (fn) {
      var steps = g[fn].slice().sort(function (a, b) { return num(a.step_index) - num(b.step_index); })
        .map(function (r) { return { name: r.step_name, users: num(r.users) }; });
      return { funnel: fn, source: src, steps: steps };
    });
  }
  var FUNNEL_INFO = {
    "Listing Flow": {
      icon: "🏠", tag: "Supply side",
      what: "How a property owner or agent goes from <b>starting a listing to publishing it live</b> — every published listing is new inventory, so this funnel is the engine of marketplace <b>supply</b>. Mirrors the team's Amplitude <i>Listing Flow</i> chart.",
      biz: "Business impact: more completed listings = more inventory for buyers. The number that matters is <b>Publish Property</b>.",
      lens: "Fix the steepest drop first — it adds the most new listings. The big fall is usually early (Started → PACI); a late fall (Media → Publish) is the most costly since the user did all the work but never went live."
    },
    "Licensed broker Registration": {
      icon: "🧑‍💼", tag: "Onboarding · Supply",
      what: "How a licensed broker goes from <b>starting verification to completing their profile</b> — onboarding trusted supply-side agents. Mirrors the Amplitude <i>Licensed broker Registration</i> chart.",
      biz: "Business impact: verified brokers list more, higher-quality inventory. The number that matters is <b>Add information to the profile</b> (fully onboarded).",
      lens: "A drop at <b>Uploaded broker license</b> suggests friction in the upload/verification step; a drop at the last step means brokers verified but never finished their profile."
    },
    "Company Registration": {
      icon: "🏢", tag: "Onboarding · Supply",
      what: "How a company goes from <b>starting verification to adding company information</b> — onboarding business/developer accounts. Mirrors the Amplitude <i>Company Registration</i> chart.",
      biz: "Business impact: registered companies bring bulk/project inventory. The number that matters is <b>Added Company Information</b>.",
      lens: "A drop at <b>Uploaded Commercial License</b> points to document-upload friction; a late drop means the license passed but company details were never completed."
    },
    "Listing Creation": {
      icon: "🏠", tag: "Supply side",
      what: "How a property owner or agent goes from <b>starting a listing to publishing it live</b>. Every published listing is new inventory on Dallal, so this funnel is the engine of marketplace <b>supply</b>.",
      biz: "Business impact: more completed listings = more inventory = more for buyers to discover. The single number that matters is <b>Published</b>.",
      lens: "Each drop-off is <b>lost inventory</b>. Fix the steepest fall first — it adds the most new listings. A fall at the <b>deep steps (Review → Publish)</b> is the most costly: the user did all the work but never went live."
    },
    "Property Discovery": {
      icon: "🔎", tag: "Demand side",
      what: "How a buyer or renter goes from <b>searching to contacting an agent / scheduling a viewing</b>. This is what turns browsing into <b>real leads</b> for listers.",
      biz: "Business impact: this is demand converting to intent. The number that matters is <b>Agent Contacted / Visit Scheduled</b> — those are qualified leads.",
      lens: "An <b>early drop</b> (Search → View Details) points to search relevance or listing quality. A <b>late drop</b> (Saved → Contact) points to trust, price or intent — users liked it but didn't reach out."
    },
    "User Registration": {
      icon: "👤", tag: "Front door",
      what: "How a new user completes <b>sign-up → verification → login</b>. A leak here caps everything downstream: fewer accounts means fewer listings and fewer leads.",
      biz: "Business impact: this is top-of-funnel account growth. The number that matters is <b>Login Success</b> — a fully activated user.",
      lens: "<b>OTP / verification</b> is the classic drop-off. A big fall there usually means SMS delivery problems or a confusing screen — a fix here lifts <i>every</i> other metric."
    },
    "New-User Retention": {
      icon: "🔁", tag: "Retention · Churn",
      what: "Of every <b>new user</b> who first used Dallal, how many <b>came back</b> in each following week. Week 0 is the sign-up week (100%); each later week is the share still active. The gap from one week to the next is <b>churn</b>.",
      biz: "Business impact: acquisition is wasted if users leave. Retention compounds — a few points held every week is worth more than any single funnel fix. The number that matters is <b>Week 4 retention</b> (the habit line).",
      lens: "The <b>steepest weekly drop</b> is your churn cliff — that week's drop-offs are the prime <b>re-engagement</b> target (push / email within that window). Users who reach the later weeks rarely leave, so winning the <b>first 1–2 weeks</b> is everything."
    }
  };
  // Plain-language meaning of each step (covers UAT + PROD event names).
  var STEP_GLOSSARY = {
    "Listing Started": "Opened the create-listing flow.",
    "Started": "Opened the create-listing flow (listing_started).",
    "PACI": "Entered the property's PACI (Kuwait civil address) number.",
    "Address": "Confirmed the property's address.",
    "Category": "Chose the property category (apartment, villa, land…).",
    "Pricing": "Set the asking price.",
    "Photos": "Added at least one photo of the property.",
    "Property Details": "Entered core details — type, price, bedrooms, area.",
    "Images Uploaded": "Added at least one photo of the property.",
    "Location Selected": "Confirmed the property's address / location.",
    "PACI Verified": "Completed the government PACI address verification.",
    "Previewed": "Reviewed the finished listing before going live.",
    "Property Review": "Reviewed the finished listing before going live.",
    "Photos Added": "Added at least one photo of the property.",
    "Category Chosen": "Chose the property category (apartment, villa, land…).",
    "Published": "Listing went live and is now visible to buyers. ✅",
    "Search": "Ran a property search.",
    "View Details": "Opened a specific property's detail page.",
    "Gallery Viewed": "Browsed the property's photo gallery.",
    "Property Saved": "Saved / favourited a property.",
    "Agent Contacted": "Messaged the listing agent — a qualified lead. ✅",
    "Chat Started": "Started a conversation with the agent.",
    "Visit Scheduled": "Booked a property viewing. ✅",
    "Registration Started": "Began the sign-up flow.",
    "Signed Up": "Submitted the sign-up form.",
    "OTP Screen": "Reached the SMS one-time-passcode screen.",
    "OTP Verified": "Entered the correct code — phone verified.",
    "Login Success": "Fully signed in — an activated account. ✅"
  };

  function funnelInsight(f) {
    var u = f.steps.map(function (s) { return s.users; }), n = u.length;
    var entered = u[0] || 0, completed = u[n - 1] || 0;
    var overall = entered ? Math.round(1000 * completed / entered) / 10 : 0;
    var bi = 1, bd = -1;
    for (var i = 1; i < n; i++) { var d = u[i - 1] - u[i]; if (d > bd) { bd = d; bi = i; } }
    var dropPct = u[bi - 1] ? Math.round(1000 * bd / u[bi - 1]) / 10 : 0;
    return { entered: entered, completed: completed, overall: overall,
      fromName: f.steps[bi - 1] ? f.steps[bi - 1].name : "", fromN: u[bi - 1] || 0,
      toName: f.steps[bi] ? f.steps[bi].name : "", toN: u[bi] || 0, dropPct: dropPct };
  }

  // ---------- Funnels date-range calendar + Trends (event segmentation) ----------
  var funnelRangeDays = 30, funnelCustom = false, funnelFrom = "", funnelTo = "";
  var FUNNEL_WINDOWS = [7, 14, 30, 90];
  function trendAllDates() {
    var s = {}; (data.trends || []).forEach(function (r) { if (r.date) s[r.date] = 1; });
    return Object.keys(s).sort();
  }
  // The precomputed funnel window (window_days) the calendar selects. A custom
  // range snaps to the nearest available window (funnels can't be recomputed live).
  function funnelWindow() {
    if (funnelCustom && funnelFrom && funnelTo) {
      var span = Math.round((new Date(funnelTo) - new Date(funnelFrom)) / 86400000) + 1;
      return FUNNEL_WINDOWS.reduce(function (a, b) { return Math.abs(b - span) < Math.abs(a - span) ? b : a; });
    }
    return funnelRangeDays;
  }
  function funnelRangeLabel() {
    return (funnelCustom && funnelFrom && funnelTo) ? (funnelFrom + " to " + funnelTo) : ("last " + funnelRangeDays + " days");
  }
  function populateFunnelRange() {
    var sel = el("funnelRange"); if (!sel || sel.options.length) return;
    [[7, "Last 7 days"], [14, "Last 14 days"], [30, "Last 30 days"], [90, "Last 90 days"], ["custom", "Custom range…"]].forEach(function (o) {
      var opt = document.createElement("option"); opt.value = o[0]; opt.textContent = o[1];
      if (o[0] === funnelRangeDays) opt.selected = true; sel.appendChild(opt);
    });
    sel.addEventListener("change", function () {
      if (sel.value === "custom") {
        funnelCustom = true; el("funnelCustom").style.display = "inline-flex";
        var ad = trendAllDates();
        if (ad.length) {
          if (!funnelTo) { funnelTo = ad[ad.length - 1]; el("funnelTo").value = funnelTo; }
          if (!funnelFrom) { funnelFrom = ad[Math.max(0, ad.length - 30)]; el("funnelFrom").value = funnelFrom; }
          el("funnelFrom").min = ad[0]; el("funnelFrom").max = ad[ad.length - 1];
          el("funnelTo").min = ad[0]; el("funnelTo").max = ad[ad.length - 1];
        }
      } else { funnelCustom = false; el("funnelCustom").style.display = "none"; funnelRangeDays = parseInt(sel.value, 10) || 30; }
      renderFunnels();
    });
    el("funnelFrom").addEventListener("change", function () { funnelFrom = el("funnelFrom").value; renderFunnels(); });
    el("funnelTo").addEventListener("change", function () { funnelTo = el("funnelTo").value; renderFunnels(); });
  }
  function trendWindowDates(dates) {
    if (funnelCustom && funnelFrom && funnelTo) {
      var lo = funnelFrom, hi = funnelTo; if (lo > hi) { var t = lo; lo = hi; hi = t; }
      return dates.filter(function (d) { return d >= lo && d <= hi; });
    }
    return dates.slice(-funnelRangeDays);
  }
  var TREND_COLORS = ["#0f8b8d", "#1f6feb", "#7c5cbf", "#f29f05", "#2e7d32", "#c62828", "#12a3a5", "#b9820a"];
  function renderFunnelTrends() {
    var host = el("funnelTrends"); if (!host) return;
    var rows = (data.trends || []).filter(function (r) { return (r.env || "PROD") === "PROD"; });
    if (!rows.length) { host.innerHTML = '<div class="muted">No trend data yet.</div>'; return; }
    var allSet = {}; rows.forEach(function (r) { if (r.date) allSet[r.date] = 1; });
    var dates = trendWindowDates(Object.keys(allSet).sort());
    var inWin = {}; dates.forEach(function (d) { inWin[d] = 1; });
    var charts = {};
    rows.forEach(function (r) { if (!inWin[r.date]) return; var c = charts[r.chart] = charts[r.chart] || {}; (c[r.series] = c[r.series] || {})[r.date] = num(r.value); });
    var order = ["Kuwait — Daily Active Users", "Registration and Log In", "Demand Side Activities", "Search — Filters vs Map", "Register Interest & Messaging", "Messaging — Seekers vs Listers"];
    var names = Object.keys(charts).sort(function (a, b) { var ia = order.indexOf(a), ib = order.indexOf(b); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib); });
    host.innerHTML = names.map(function (n, i) {
      return '<div class="chartcard" style="margin-top:' + (i ? 14 : 0) + 'px"><h3>' + esc(n) + '</h3><div class="chartbox" style="height:280px"><canvas id="trendChart' + i + '"></canvas></div></div>';
    }).join("");
    names.forEach(function (n, i) {
      var labels = dates.map(function (d) { return d.slice(5); });
      var series = Object.keys(charts[n]);
      var ds = series.map(function (s, si) {
        return { label: s, data: dates.map(function (d) { return charts[n][s][d] || 0; }),
          borderColor: TREND_COLORS[si % TREND_COLORS.length], backgroundColor: "transparent", tension: 0.3, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4 };
      });
      mkChart("trendChart" + i, { type: "line", data: { labels: labels, datasets: ds },
        options: { responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
          plugins: { legend: { display: true, position: "bottom", labels: { boxWidth: 12, usePointStyle: true, font: { size: 10 } } },
            tooltip: { callbacks: { label: function (c) { return c.dataset.label + ": " + fmtInt(c.parsed.y); } } } },
          scales: { x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8, font: { size: 10 } } },
            y: { beginAtZero: true, ticks: { font: { size: 10 }, callback: function (v) { return fmtInt(v); } }, grid: { color: "#eef1f5" } } } } });
    });
  }

  var METRIC_FUNNELS = { "Supply & Demand": 1, "Engagement": 1, "Time to Reach Step (sec)": 1, "Listings Published (weekly)": 1 };
  // Short leadership-facing one-liners for the overview rows.
  var FUNNEL_DESC = {
    "Listing Flow": "Track the journey from creating a listing to publishing it live",
    "Listing Creation": "Track the journey from creating a listing to publishing it live",
    "Licensed broker Registration": "Monitor broker registration and verification completion",
    "Company Registration": "Track company sign-up and verification process",
    "User Registration": "Analyze sign-up journey and verification completion",
    "Property Discovery": "How buyers search, view and contact agents",
    "New-User Retention": "Understand how users return and stay engaged"
  };
  function funnelHealth(conv) {
    return conv >= 40 ? ["Healthy", "green"] : conv >= 15 ? ["Needs attention", "amber"] : ["At risk", "red"];
  }
  function fmtInt2(n) { return (typeof fmtInt === "function") ? fmtInt(n) : String(Math.round(num(n))); }
  // Tiny inline sparkline of a funnel's step counts (shows the drop-off shape).
  function sparkSVG(vals, rag) {
    var col = rag === "green" ? "#22a565" : rag === "amber" ? "#f29f05" : "#e94b6a";
    vals = (vals || []).map(function (v) { return num(v); });
    if (vals.length < 2) vals = [num(vals[0]) || 0, num(vals[0]) || 0];
    var mx = Math.max.apply(null, vals) || 1, w = 96, h = 34, n = vals.length;
    var pts = vals.map(function (v, i) { var x = n > 1 ? i / (n - 1) * w : 0; var y = h - 2 - (v / mx) * (h - 6); return x.toFixed(1) + "," + y.toFixed(1); }).join(" ");
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '" preserveAspectRatio="none">' +
      '<polyline points="' + pts + '" fill="none" stroke="' + col + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }
  // Detailed step bars for one funnel (used inside an expanded overview row).
  function funnelStepsHTML(f) {
    var users = f.steps.map(function (s) { return s.users; });
    var top = users[0] || 0;
    var worstIdx = (function () { var b = 1, bd = -1; for (var k = 1; k < users.length; k++) { var d = users[k - 1] - users[k]; if (d > bd) { bd = d; b = k; } } return b; })();
    return f.steps.map(function (s, i) {
      var w = top ? Math.max(2, Math.round(1000 * s.users / top) / 10) : 0;
      var ofStart = top ? Math.round(1000 * s.users / top) / 10 : 0;
      var conv = i === 0 ? 100 : (users[i - 1] ? Math.round(1000 * s.users / users[i - 1]) / 10 : 0);
      var drop = i === 0 ? 0 : (users[i - 1] - s.users);
      var isWorst = (i === worstIdx && drop > 0);
      var gl = STEP_GLOSSARY[s.name] || "";
      var meta = i === 0
        ? '<span class="fm">entry point · 100% of start</span>'
        : '<span class="fm">' + ofStart + '% of start</span><span class="fm">step conversion ' + conv + '%</span>' +
          (drop > 0 ? '<span class="fm drop">−' + drop + ' lost here</span>' : '');
      return '<div class="fstep' + (isWorst ? ' worst' : '') + '">' +
        '<div class="fstep-top"><span class="fnum">' + (i + 1) + '</span>' +
        '<span class="fstep-name">' + esc(s.name) + '</span>' +
        '<span class="fstep-users">' + s.users + ' <span class="fu">users</span></span></div>' +
        '<div class="ftrack"><div class="ffill' + (isWorst ? ' bad' : '') + '" style="width:' + w + '%"></div></div>' +
        '<div class="fstep-meta">' + meta + (isWorst ? '<span class="worsttag">◀ biggest drop-off</span>' : '') + '</div>' +
        (gl ? '<div class="fstep-gloss">' + esc(gl) + '</div>' : '') +
        '</div>';
    }).join("");
  }

  function renderFunnels() {
    populateFunnelRange();
    var env = populateFunnelEnv();
    var platform = populateFunnelPlatform(env);
    var fs = funnelsData(env, platform);
    var metricFs = fs.filter(function (f) { return METRIC_FUNNELS[f.funnel]; });
    var realFs = fs.filter(function (f) { return !METRIC_FUNNELS[f.funnel]; });
    renderFunnelAbout(env, platform);
    renderFunnelKpis(realFs, metricFs);
    renderFunnelOverview(realFs);
    renderPathSankey(env);
    renderFunnelTrends();
    renderFunnelInsights(realFs);
    renderProductMetrics(env, metricFs);
  }

  function renderFunnelAbout(env, platform) {
    var host = el("funnelAbout"); if (!host) return;
    var envTxt = env === "PROD"
      ? "Dallal PRODUCTION — real users, " + funnelRangeLabel()
      : "Dallal UAT (test) — read the shape &amp; drop-off points, not absolute counts, " + funnelRangeLabel();
    function row(ic, t, d) { return '<div class="fa-arow"><span class="fa-aic">' + ic + '</span><span class="fa-atxt"><b>' + t + ':</b> ' + d + '</span></div>'; }
    host.innerHTML = '<div class="fa-about">' +
      '<div class="fa-about-l">' +
        '<div class="fa-about-h"><span class="fa-abadge">ℹ️</span> About Funnel Analytics</div>' +
        '<p class="fa-about-sub">Funnel analytics helps you understand how users move through key actions and where they drop off.</p>' +
        '<div class="fa-arows">' +
          row("🔎", "Discovery", "Tracks user journey from discovery to primary action.") +
          row("🏠", "Listing Flow", "Monitors property listing creation and publish success.") +
          row("👤", "Registration", "Analyzes sign-up journey and verification completion.") +
          row("🔁", "User Retention", "Measures how users return and stay active over time.") +
        '</div>' +
        '<div class="fa-about-src muted">Source: Amplitude · ' + envTxt + '. Switch <b>Data</b> (UAT / PROD) &amp; <b>Platform</b> above.</div>' +
      '</div>' +
      '<div class="fa-about-ill" aria-hidden="true">' +
        '<svg viewBox="0 0 120 110" width="150" height="140">' +
          '<defs><linearGradient id="faf" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7b8cff"/><stop offset="1" stop-color="#5a5be6"/></linearGradient></defs>' +
          '<polygon points="14,16 106,16 84,52 36,52" fill="url(#faf)" opacity=".92"/>' +
          '<polygon points="36,58 84,58 72,88 48,88" fill="url(#faf)" opacity=".72"/>' +
          '<rect x="54" y="92" width="12" height="14" rx="2" fill="url(#faf)" opacity=".55"/>' +
          '<circle cx="60" cy="104" r="4" fill="#5a5be6"/>' +
        '</svg>' +
      '</div>' +
    '</div>';
  }

  function renderFunnelKpis(realFs, metricFs) {
    var host = el("funnelKpis"); if (!host) return;
    var entered = 0, completed = 0;
    realFs.forEach(function (f) { var ins = funnelInsight(f); entered += ins.entered; completed += ins.completed; });
    var conv = entered ? completed / entered * 100 : 0;
    var drop = entered ? 100 - conv : 0;
    var tt = metricFs.filter(function (f) { return f.funnel === "Time to Reach Step (sec)"; })[0];
    var avgTime = (tt && tt.steps.length) ? fmtDur(tt.steps[tt.steps.length - 1].users) : "—";
    function kpi(ic, label, val, sub, color) {
      return '<div class="fa-kpi" style="--k:' + color + '">' +
        '<div class="fa-kpi-h"><span class="fa-kpi-ic">' + ic + '</span><span class="fa-kpi-l">' + label + '</span></div>' +
        '<div class="fa-kpi-v">' + val + '</div><div class="fa-kpi-s">' + sub + '</div></div>';
    }
    host.innerHTML = '<div class="fa-kpis">' +
      kpi("👥", "Total Users Entered", fmtInt2(entered), "across all funnels", "#7b61ff") +
      kpi("✅", "Completed", fmtInt2(completed), "reached the goal step", "#22a565") +
      kpi("🎯", "Overall Conversion", (Math.round(conv * 10) / 10) + "%", "completed ÷ entered", "#f5883f") +
      kpi("⏱️", "Avg. Time to Complete", avgTime, "median to goal step", "#2f6df6") +
      kpi("📉", "Drop-off Rate", (Math.round(drop * 10) / 10) + "%", "left before completing", "#e94b6a") +
    '</div>';
  }

  function renderFunnelOverview(realFs) {
    var host = el("funnelList"); if (!host) return;
    if (!realFs.length) { host.innerHTML = '<div class="muted" style="padding:10px 2px">No funnel data for this view yet — either no events in the selected window, or this platform isn\'t instrumented for these steps.</div>'; return; }
    function dot(c, t) { return '<span class="fo-lg"><i style="background:' + c + '"></i>' + t + '</span>'; }
    var legend = '<div class="fo-legend">' + dot("#7b61ff", "Entered") + dot("#22a565", "Completed") + dot("#f5883f", "Conversion") + dot("#e94b6a", "Drop-off") + '</div>';
    host.innerHTML = legend + realFs.map(function (f, idx) {
      var ins = funnelInsight(f);
      var conv = ins.overall, drop = Math.round((100 - conv) * 10) / 10;
      var health = funnelHealth(conv);
      var info = FUNNEL_INFO[f.funnel] || { icon: "📈" };
      var desc = FUNNEL_DESC[f.funnel] || "";
      var open = _collapse["fo_" + idx] === true;
      var read = "Of <b>" + ins.entered + "</b> who started, <b>" + ins.completed + "</b> reached the end — a <b>" + ins.overall + "%</b> completion rate. " +
        "Biggest single fall-off: <b>" + esc(ins.fromName) + " → " + esc(ins.toName) + "</b>, losing <b>" + ins.dropPct + "%</b> (" + ins.fromN + " → " + ins.toN + " users). " +
        '<br><b>👉 Where to look:</b> ' + (info.lens || "");
      return '<details class="fo-row" data-lb="fo_' + idx + '"' + (open ? " open" : "") + '>' +
        '<summary class="fo-sum">' +
          '<span class="fo-num">' + (idx + 1) + '</span>' +
          '<span class="fo-name"><span class="fo-nt"><b>' + esc(f.funnel) + '</b> <span class="fo-tag ' + health[1] + '">' + health[0] + '</span></span>' +
            (desc ? '<span class="fo-desc">' + esc(desc) + '</span>' : '') + '</span>' +
          '<span class="fo-metric"><b>' + fmtInt2(ins.entered) + '</b><span>Entered</span></span>' +
          '<span class="fo-metric"><b>' + fmtInt2(ins.completed) + '</b><span>Completed</span></span>' +
          '<span class="fo-metric"><b class="cv">' + conv + '%</b><span>Conversion</span></span>' +
          '<span class="fo-metric"><b class="dp">' + drop + '%</b><span>Drop-off</span></span>' +
          '<span class="fo-spark">' + sparkSVG(f.steps.map(function (s) { return s.users; }), health[1]) + '</span>' +
          '<span class="fo-chev">&#9662;</span>' +
        '</summary>' +
        '<div class="fo-body"><div class="funnel">' + funnelStepsHTML(f) + '</div>' +
          '<div class="finsight"><b>📊 What the data says:</b> ' + read + '</div>' +
          '<div class="muted" style="font-size:11px;margin-top:8px">' + esc(f.source) + '</div></div>' +
      '</details>';
    }).join("");
  }

  function renderFunnelInsights(realFs) {
    var host = el("funnelInsights"); if (!host) return;
    if (!realFs.length) { host.innerHTML = ""; return; }
    var scored = realFs.map(function (f) { var ins = funnelInsight(f); return { f: f, ins: ins, conv: ins.overall }; });
    function card(ic, tone, title, stat, rec) {
      return '<div class="fa-inscard ' + tone + '"><div class="fa-ins-ic">' + ic + '</div>' +
        '<div class="fa-ins-t">' + esc(title) + '</div>' +
        '<div class="fa-ins-s">' + stat + '</div>' +
        '<div class="fa-ins-r">' + rec + '</div>' +
        '<div class="fa-ins-link">View funnel &rarr;</div></div>';
    }
    var cards = [];
    var worst = scored.slice().sort(function (a, b) { return a.conv - b.conv; })[0];
    var best = scored.slice().sort(function (a, b) { return b.conv - a.conv; })[0];
    if (worst) cards.push(card("⚠️", "red", "High Drop-off in " + worst.f.funnel, (Math.round((100 - worst.conv) * 10) / 10) + "% of users drop off.", "Improve onboarding &amp; engagement."));
    var reg = scored.filter(function (s) { return /Registration/i.test(s.f.funnel); }).sort(function (a, b) { return b.ins.dropPct - a.ins.dropPct; })[0];
    if (reg) cards.push(card("🔑", "amber", reg.f.funnel + " Bottleneck", reg.ins.dropPct + "% drop at " + esc(reg.ins.toName) + ".", "Simplify the verification steps."));
    if (best && best !== worst) cards.push(card("✅", "green", "Good Performance: " + best.f.funnel, best.conv + "% conversion is healthy.", "Keep up the momentum!"));
    var listing = scored.filter(function (s) { return /Listing/i.test(s.f.funnel); })[0];
    if (listing) cards.push(card("🚀", "blue", "Listing Flow Needs Boost", "Only " + listing.conv + "% complete listings.", "Optimize the listing publish flow."));
    host.innerHTML = '<div class="section"><h2>Insights &amp; Recommendations</h2><div class="body">' +
      '<div class="fa-insights">' + cards.slice(0, 4).join("") + '</div></div></div>';
  }

  // ---------- Product Health metrics (Supply/Demand, Engagement, Time-to-step, weekly supply) ----------
  function fmtDur(sec) {
    sec = num(sec);
    if (sec < 90) return sec + "s";
    if (sec < 5400) return Math.round(sec / 60) + "m";
    if (sec < 172800) return (sec / 3600).toFixed(1) + "h";
    return (sec / 86400).toFixed(1) + "d";
  }
  function renderProductMetrics(env, metricFs) {
    var host = el("productMetrics"); if (!host) return;
    if (!metricFs.length) { host.innerHTML = ""; return; }
    function by(name) { var m = metricFs.filter(function (f) { return f.funnel === name; })[0]; return m ? m.steps : []; }
    var sd = by("Supply & Demand"), eng = by("Engagement"), tt = by("Time to Reach Step (sec)"), wk = by("Listings Published (weekly)");
    var h = '<div class="funnelcard" style="margin-top:14px"><div class="fh"><span class="fname">📊 Product Health</span>' +
      '<span class="ftag">last 30 days · Dallal ' + esc(env) + '</span></div>';
    if (sd.length) h += '<div class="fwhat" style="margin-bottom:6px"><b>Supply &amp; Demand</b> — the marketplace\'s inputs (listings) and demand signals (searches, leads).</div><div class="grid">' +
      sd.map(function (s) { var ic = s.name.indexOf("Publish") >= 0 ? "🏠" : s.name.indexOf("Delet") >= 0 ? "🗑️" : s.name.indexOf("Search") >= 0 ? "🔎" : "💬"; return card(s.name, s.users, { icon: ic, accent: "#3f7fce" }); }).join("") + "</div>";
    if (eng.length) h += '<div class="fwhat" style="margin:12px 0 6px"><b>Engagement</b> — active users and <b>stickiness</b> (DAU÷MAU: how often people come back).</div><div class="grid">' +
      eng.map(function (s) { var st = s.name.indexOf("Stick") >= 0; return card(s.name, s.users + (st ? "%" : ""), { icon: st ? "🧲" : "👥", accent: "#0f8b8d" }); }).join("") + "</div>";
    if (tt.length) h += '<div class="fwhat" style="margin:12px 0 6px"><b>Time to reach each step</b> — median time from starting a listing; the slowest step is where users linger.</div><div class="grid">' +
      tt.map(function (s) { return card(s.name, fmtDur(s.users), { icon: "⏱️", accent: "#7b61ff" }); }).join("") + "</div>";
    if (wk.length) h += '<div class="fwhat" style="margin:12px 0 6px"><b>Listings published — weekly</b> (net new supply; Wk-0 = this week).</div><div class="chartbox" style="height:220px"><canvas id="wkPubChart"></canvas></div>';
    h += "</div>";
    host.innerHTML = h;
    if (wk.length) mkChart("wkPubChart", { type: "line",
      data: { labels: wk.map(function (s) { return s.name; }), datasets: [{ label: "Published", data: wk.map(function (s) { return num(s.users); }), borderColor: "#2e7d32", backgroundColor: "rgba(46,125,50,.12)", fill: true, tension: .3 }] },
      options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } } });
  }

  // ---------- User-path Sankey (fact_paths, computed from raw events) ----------
  var SANKEY_MILE = ["1 Started", "2 PACI", "3 Address", "4 Category", "5 Property Details", "6 Pricing", "7 Photos", "8 Published"];
  function renderPathSankey(env) {
    var card = el("pathSankeyCard"); if (!card) return;
    var rows = (data.paths || []).filter(function (r) { return (r.env || "UAT") === env && num(r.users) > 0; });
    var head = '<div class="funnelcard" style="margin-top:14px"><div class="fh">' +
      '<span class="fname">🔀 User Path — where people go &amp; drop off</span>' +
      '<span class="ftag">Listing Creation · last 30d</span></div>' +
      '<div class="fwhat">The real path through the listing flow. Each box is a screen labelled with <b>how many users reached it</b>; ribbon width = number of users. Hover any ribbon for the exact split.</div>' +
      '<div class="muted" style="font-size:12.5px;margin:4px 0 10px">' +
      '<span style="color:#2f6df6;font-weight:700">●</span> stayed in the flow &nbsp;&nbsp;' +
      '<span style="color:#e69500;font-weight:700">●</span> jumped to another screen &nbsp;&nbsp;' +
      '<span style="color:#c0392b;font-weight:700">●</span> left the app</div>';
    if (!rows.length) { card.innerHTML = head + '<div class="finsight muted">No path data for <b>Dallal ' + esc(env) + '</b> yet — the path ETL runs on a slower cadence.</div></div>'; return; }
    var ok = false;
    try { ok = !!(window.Chart && Chart.registry && Chart.registry.getController("sankey")); } catch (e) { ok = false; }
    if (!ok) { card.innerHTML = head + '<div class="finsight muted">Path graph unavailable (the Sankey chart plugin didn’t load).</div></div>'; return; }
    // Short display names (long ones like "5 Property Details" overrun the next
    // node) + the reached-count baked into each node label so numbers read at a glance.
    var SHORT = { "1 Started": "Start", "2 PACI": "PACI", "3 Address": "Address", "4 Category": "Category",
      "5 Property Details": "Details", "6 Pricing": "Pricing", "7 Photos": "Photos", "8 Published": "Published" };
    var short = function (n) { return SHORT[n] || n; };
    var edges = rows.map(function (r) { return { from: r.source, to: r.target, flow: num(r.users) }; });
    var inSum = {}, outSum = {};
    edges.forEach(function (e) { outSum[e.from] = (outSum[e.from] || 0) + e.flow; inSum[e.to] = (inSum[e.to] || 0) + e.flow; });
    var reached = function (n) { return inSum[n] || outSum[n] || 0; };   // arrivals (start node: departures)
    var labels = {};
    edges.forEach(function (e) { labels[e.from] = short(e.from) + "  " + reached(e.from); labels[e.to] = short(e.to) + "  " + reached(e.to); });
    var columns = {}; SANKEY_MILE.forEach(function (l, i) { columns[l] = i; });
    edges.forEach(function (e) { if (columns[e.to] === undefined) columns[e.to] = SANKEY_MILE.length; });
    var isMile = function (n) { return SANKEY_MILE.indexOf(n) !== -1; };
    var col = function (n) { return n === "Exited" ? "#c0392b" : isMile(n) ? "#2f6df6" : "#e69500"; };
    var raw = function (c) { return c.dataset.data[c.dataIndex] || {}; };
    // Guaranteed-wide, horizontally-scrollable canvas: 9 spine nodes + off-ramps
    // never fit a narrow card, so give each column real room and let it scroll.
    card.innerHTML = head +
      '<div style="overflow-x:auto;-webkit-overflow-scrolling:touch"><div style="height:540px;min-width:1720px"><canvas id="pathSankey"></canvas></div></div>' +
      '<div class="muted" style="font-size:11px;margin-top:8px">Amplitude · Dallal-' + esc(env) + ' · true user transitions (Export API) · the milestone spine reconciles with the funnel above · scroll sideways to see the full path.</div></div>';
    try {
      mkChart("pathSankey", {
        type: "sankey",
        data: { datasets: [{
          data: edges, labels: labels,
          colorFrom: function (c) { return col(raw(c).from); },
          colorTo: function (c) { return col(raw(c).to); },
          colorMode: "gradient", column: columns, alpha: 0.5, size: "max",
          nodeWidth: 12, nodePadding: 24, borderWidth: 0, font: { size: 12, weight: "600" }
        }] },
        options: { maintainAspectRatio: false,
          layout: { padding: { left: 4, right: 82, top: 10, bottom: 10 } },
          plugins: { legend: { display: false }, tooltip: { callbacks: {
            title: function () { return ""; },
            label: function (c) { var d = raw(c); var den = outSum[d.from] || 0; var pct = den ? Math.round(100 * d.flow / den) : 0;
              return short(d.from) + " → " + short(d.to) + ":  " + d.flow + " user" + (d.flow === 1 ? "" : "s") + " (" + pct + "% of " + short(d.from) + ")"; } } } } }
      });
    } catch (e) {
      card.innerHTML = head + '<div class="finsight muted">Path graph could not render: ' + esc(e.message || String(e)) + '</div></div>';
    }
  }

  // ---------- Marketing: abandoned-listing re-engagement ----------
  // Message tailored to where the user dropped off (mirrors automate_reengage.py).
  var MKT_HOOK = {
    "Started": "You started listing your property but didn't get far — it only takes a few minutes to publish.",
    "PACI": "You're one step in — just verify your PACI address and your listing is on its way.",
    "Address": "Your property address is set — add a few details and publish your listing.",
    "Category": "You picked your category — just the details, price and photos left.",
    "Property Details": "Your property details are saved — add a price and photos to go live.",
    "Pricing": "You've set your price — add photos and publish. You're almost there!",
    "Photos": "You're almost done — just review and publish to go live on Dallal!"
  };
  var MKT_SITE = { UAT: "https://uat.dallal.com.kw/registerproperty", PROD: "https://dallal.com.kw/registerproperty" };
  var mktFilters = { env: null, step: "", source: "", platform: "", lang: "", city: "" };
  var mktWired = false;

  function mktCompose(u) {
    var name = ((u.name || "there").split(" ")[0]) || "there";
    var hook = MKT_HOOK[u.drop_step] || MKT_HOOK.Started;
    var link = MKT_SITE[u.env] || MKT_SITE.UAT;
    return {
      subject: "Your Dallal listing is almost ready",
      email: "Hi " + name + ",\n\n" + hook + "\n\nPick up right where you left off and publish your property on Dallal:\n" + link + "\n\nNeed a hand? Just reply to this email.\n\n- The Dallal team",
      whatsapp: "Hi " + name + "! " + hook + " Finish your Dallal listing here: " + link
    };
  }
  function mktLogKey(env) { return "dallal_mkt_dryrun_" + env; }
  function mktLoadLog(env) { try { return JSON.parse(localStorage.getItem(mktLogKey(env)) || "[]"); } catch (e) { return []; } }

  function mktUniq(rows, key) {
    var s = {}; rows.forEach(function (r) { var v = (r[key] || "").trim(); if (v) s[v] = 1; });
    return Object.keys(s).sort();
  }
  function mktFill(id, values, cur, allLabel) {
    var sel = el(id); if (!sel) return;
    sel.innerHTML = '<option value="">' + allLabel + "</option>" +
      values.map(function (v) { return '<option value="' + escAttr(v) + '"' + (v === cur ? " selected" : "") + ">" + esc(v) + "</option>"; }).join("");
  }

  function renderMarketing() {
    var all = data.abandoned || [];
    // env selector
    var envs = mktUniq(all, "env"); if (!envs.length) envs = ["UAT"];
    // Default to UAT (the primary test env) when present, else the first env.
    if (!mktFilters.env || envs.indexOf(mktFilters.env) === -1) mktFilters.env = envs.indexOf("UAT") !== -1 ? "UAT" : envs[0];
    var envSel = el("mktEnv");
    if (envSel) envSel.innerHTML = envs.map(function (e) { return '<option value="' + e + '"' + (e === mktFilters.env ? " selected" : "") + ">Dallal " + e + "</option>"; }).join("");
    var env = mktFilters.env;
    var pool = all.filter(function (r) { return (r.env || "UAT") === env; });

    // populate segment dropdowns from this env's pool
    mktFill("mktStep", mktUniq(pool, "drop_step"), mktFilters.step, "All steps");
    mktFill("mktSource", mktUniq(pool, "source"), mktFilters.source, "All sources");
    mktFill("mktPlatform", mktUniq(pool, "platform"), mktFilters.platform, "All platforms");
    mktFill("mktLang", mktUniq(pool, "language"), mktFilters.lang, "All languages");
    mktFill("mktCity", mktUniq(pool, "city"), mktFilters.city, "All cities");

    if (!mktWired) {
      mktWired = true;
      var reRender = function () { renderMarketing(); };
      el("mktEnv").addEventListener("change", function (e) { mktFilters.env = e.target.value; mktFilters.step = mktFilters.source = mktFilters.platform = mktFilters.lang = mktFilters.city = ""; reRender(); });
      [["mktStep", "step"], ["mktSource", "source"], ["mktPlatform", "platform"], ["mktLang", "lang"], ["mktCity", "city"]].forEach(function (p) {
        el(p[0]).addEventListener("change", function (e) { mktFilters[p[1]] = e.target.value; reRender(); });
      });
      // Read the live selected env at click time — not the wire-time closure,
      // which would otherwise pin these to whatever env was default on first render.
      el("mktRun").addEventListener("click", function () { mktRunDryRun(mktFilters.env); });
      el("exportMkt").addEventListener("click", function () { mktExport(mktFilters.env); });
      // Collapsible sections (state persisted per section).
      mktWireCollapse("mktListingsToggle", "mktListingsBody", "dallal_mkt_listings_collapsed");
      mktWireCollapse("mktUsersToggle", "mktUsersBody", "dallal_mkt_users_collapsed");
    }

    // apply filters
    var rows = pool.filter(function (r) {
      return (!mktFilters.step || r.drop_step === mktFilters.step) &&
        (!mktFilters.source || r.source === mktFilters.source) &&
        (!mktFilters.platform || r.platform === mktFilters.platform) &&
        (!mktFilters.lang || r.language === mktFilters.lang) &&
        (!mktFilters.city || r.city === mktFilters.city);
    });

    // KPIs
    var withEmail = rows.filter(function (r) { return r.email; }).length;
    var withPhone = rows.filter(function (r) { return r.phone; }).length;
    var reachable = rows.filter(function (r) { return r.email || r.phone; }).length;
    // recovered = previously-messaged users no longer in the abandoned set
    var dry = mktLoadLog(env);
    var serverLog = (data.reengage || []).filter(function (r) { return (r.env || "UAT") === env; });
    var messagedIds = {}; dry.concat(serverLog).forEach(function (r) { if (r.amplitude_id) messagedIds[r.amplitude_id] = 1; });
    var stillAbandoned = {}; pool.forEach(function (r) { stillAbandoned[r.amplitude_id] = 1; });
    var messagedN = Object.keys(messagedIds).length;
    var recovered = Object.keys(messagedIds).filter(function (id) { return !stillAbandoned[id]; }).length;
    var recRate = messagedN ? Math.round(100 * recovered / messagedN) : null;

    el("mktKpis").innerHTML =
      card("Abandoned (filtered)", rows.length, { icon: "🚪", accent: "#c0392b" }) +
      card("Reachable", reachable, { icon: "📇", accent: "#3f7fce", tip: "Has an email and/or phone on file." }) +
      card("With email", withEmail, { icon: "✉️", accent: "#0f8b8d" }) +
      card("With phone", withPhone, { icon: "📱", accent: "#7b61ff" });

    // charts
    var byStep = {}, bySource = {};
    rows.forEach(function (r) { byStep[r.drop_step || "?"] = (byStep[r.drop_step || "?"] || 0) + 1; var s = r.source || "direct"; bySource[s] = (bySource[s] || 0) + 1; });
    var STEP_ORDER = ["Started", "PACI", "Address", "Category", "Property Details", "Pricing", "Photos"];
    var stepLabels = STEP_ORDER.filter(function (s) { return byStep[s]; });
    Object.keys(byStep).forEach(function (s) { if (stepLabels.indexOf(s) === -1) stepLabels.push(s); });
    mkChart("mktStepChart", { type: "bar",
      data: { labels: stepLabels, datasets: [{ label: "Users", data: stepLabels.map(function (s) { return byStep[s]; }), backgroundColor: "#c0392b" }] },
      options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } } });
    var srcLabels = Object.keys(bySource).sort(function (a, b) { return bySource[b] - bySource[a]; });
    mkChart("mktSourceChart", { type: "bar",
      data: { labels: srcLabels, datasets: [{ label: "Users", data: srcLabels.map(function (s) { return bySource[s]; }), backgroundColor: "#3f7fce" }] },
      options: { indexAxis: "y", responsive: true, plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { precision: 0 } } } } });

    // campaign KPIs + log
    el("mktCampaignKpis").innerHTML =
      card("Messaged (dry-run + sent)", messagedN, { icon: "📨", accent: "#7b61ff", tip: "Distinct users a campaign has composed for (dry-run logged locally, plus any server-side sends)." }) +
      card("Recovered", recovered, { icon: "✅", accent: "#2e7d32", tip: "Messaged users who are no longer in the abandoned set (they published)." }) +
      card("Recovery rate", recRate == null ? "--" : recRate + "%", { icon: "📈", accent: "#2e7d32", bar: recRate || 0, barColor: "#2e7d32" }) +
      card("Last dry-run", dry.length ? (dry[0].at || "").replace("T", " ").slice(0, 16) : "—", { icon: "🕓", accent: "#3f7fce" });

    renderMktCampaignLog(env, dry);
    renderMktList(rows);
  }

  // Generic collapsible section: toggles a .body's visibility, swaps the ▾/▸ icon,
  // and persists the collapsed state under `key`.
  function mktToggleSection(body, tog, key) {
    if (!body || !tog) return;
    var ic = tog.querySelector(".collapse-ic");
    var collapsed = body.style.display === "none";   // currently collapsed? -> expand
    body.style.display = collapsed ? "" : "none";
    if (ic) ic.innerHTML = collapsed ? "&#9662;" : "&#9656;";   // ▾ open / ▸ closed
    tog.setAttribute("aria-expanded", collapsed ? "true" : "false");
    try { localStorage.setItem(key, collapsed ? "0" : "1"); } catch (e) {}
  }
  function mktWireCollapse(togId, bodyId, key) {
    var tog = el(togId), body = el(bodyId); if (!tog || !body) return;
    tog.addEventListener("click", function () { mktToggleSection(body, tog, key); });
    tog.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); mktToggleSection(body, tog, key); } });
    var saved = null; try { saved = localStorage.getItem(key); } catch (e) {}
    if (saved === "1") mktToggleSection(body, tog, key);   // restore collapsed
  }

  function renderMktList(rows) {
    var host = el("mktList"); if (!host) return;
    var cnt = el("mktUsersCount"); if (cnt) cnt.textContent = rows.length ? "· " + rows.length + " user" + (rows.length === 1 ? "" : "s") : "";
    if (!rows.length) { host.innerHTML = '<div class="muted">No abandoned users match these filters. 🎉</div>'; return; }
    rows.sort(function (a, b) { return String(b.last_seen || "").localeCompare(String(a.last_seen || "")); });
    host.innerHTML = rows.map(function (u) {
      var m = mktCompose(u);
      var segs = [u.drop_step, u.city, u.language, u.platform, u.source, u.user_type].filter(Boolean).map(function (s) { return esc(s); }).join(" &middot; ");
      var mailto = u.email ? '<a class="tasklink" href="mailto:' + escAttr(u.email) + "?subject=" + encodeURIComponent(m.subject) + "&body=" + encodeURIComponent(m.email) + '">✉️ Email</a>' : "";
      var wa = u.phone ? '<a class="tasklink" href="https://wa.me/' + escAttr((u.phone + "").replace(/[^0-9]/g, "")) + "?text=" + encodeURIComponent(m.whatsapp) + '" target="_blank" rel="noopener">💬 WhatsApp</a>' : "";
      var contact = [u.email ? esc(u.email) : "", u.phone ? esc(u.phone) : ""].filter(Boolean).join(" &middot; ") || '<span class="muted">no contact on file</span>';
      var uid = u.user_id || u.amplitude_id || "";
      var uidHtml = uid ? '<span class="muted" style="font-size:12px">ID: <code>' + esc(uid) + "</code></span>" : "";
      return '<div class="taskrow"><div class="tasktitle">' +
        '<span style="font-weight:600">' + esc(u.name || "(unknown user)") + '</span>' +
        ' <span class="rag red" style="font-size:11px">dropped at ' + esc(u.drop_step || "?") + '</span>' +
        (uidHtml ? ' ' + uidHtml : "") +
        '<div class="muted" style="font-size:12px;margin-top:2px">' + segs + '</div>' +
        '<div class="muted" style="font-size:12px;margin-top:2px">' + contact + ' &middot; last seen ' + esc((u.last_seen || "").replace("T", " ")) + '</div>' +
        '<div style="margin-top:6px;display:flex;gap:14px">' + mailto + wa + '</div>' +
        '</div></div>';
    }).join("");
  }

  function renderMktCampaignLog(env, dry) {
    var host = el("mktCampaignLog"); if (!host) return;
    if (!dry.length) { host.innerHTML = '<div class="muted">No campaign run yet. Click <b>Preview dry-run</b> to compose the Email + WhatsApp each abandoned user would receive (nothing is sent).</div>'; return; }
    var last = dry[0];
    var items = (last.items || []).slice(0, 40);
    host.innerHTML = '<div class="muted" style="margin-bottom:8px">Dry-run at <b>' + esc((last.at || "").replace("T", " ").slice(0, 16)) +
      '</b> — composed for <b>' + (last.items || []).length + '</b> users (' + last.emails + ' email, ' + last.whatsapps + ' WhatsApp). Nothing was sent.</div>' +
      items.map(function (it) {
        return '<div class="taskrow"><div class="tasktitle">' +
          '<span style="font-weight:600">' + esc(it.name || "(unknown)") + '</span> <span class="muted" style="font-size:12px">· ' + esc(it.drop_step) + ' · ' + esc(it.channels) + '</span>' +
          '<div class="muted" style="font-size:12px;margin-top:3px;white-space:pre-wrap">' + esc(it.preview) + '</div>' +
          '</div></div>';
      }).join("") + ((last.items || []).length > 40 ? '<div class="muted" style="margin-top:6px">…and ' + ((last.items || []).length - 40) + ' more.</div>' : "");
  }

  function mktRunDryRun(env) {
    var pool = (data.abandoned || []).filter(function (r) {
      return (r.env || "UAT") === env &&
        (!mktFilters.step || r.drop_step === mktFilters.step) &&
        (!mktFilters.source || r.source === mktFilters.source) &&
        (!mktFilters.platform || r.platform === mktFilters.platform) &&
        (!mktFilters.lang || r.language === mktFilters.lang) &&
        (!mktFilters.city || r.city === mktFilters.city);
    });
    var emails = 0, whatsapps = 0, ids = {}, items = [];
    pool.forEach(function (u) {
      var m = mktCompose(u); var chans = [];
      if (u.email) { emails++; chans.push("email"); }
      if (u.phone) { whatsapps++; chans.push("whatsapp"); }
      if (!chans.length) return;
      ids[u.amplitude_id] = 1;
      items.push({ amplitude_id: u.amplitude_id, name: u.name, drop_step: u.drop_step, channels: chans.join(" + "), preview: m.email });
    });
    var entry = { at: new Date().toISOString(), emails: emails, whatsapps: whatsapps, count: Object.keys(ids).length, items: items };
    var log = mktLoadLog(env); log.unshift(entry); log = log.slice(0, 10);
    try { localStorage.setItem(mktLogKey(env), JSON.stringify(log)); } catch (e) {}
    renderMarketing();
  }

  function mktExport(env) {
    var rows = (data.abandoned || []).filter(function (r) { return (r.env || "UAT") === env; });
    var cols = ["env", "user_id", "amplitude_id", "name", "email", "phone", "drop_step", "source", "platform", "city", "region", "country", "language", "user_type", "started_at", "last_seen"];
    var csv = cols.join(",") + "\n" + rows.map(function (r) {
      return cols.map(function (c) { var v = (r[c] == null ? "" : String(r[c])).replace(/"/g, '""'); return /[",\n]/.test(v) ? '"' + v + '"' : v; }).join(",");
    }).join("\n");
    var blob = new Blob([csv], { type: "text/csv" });
    var a = document.createElement("a"); a.href = URL.createObjectURL(blob);
    a.download = "abandoned_listers_" + env + ".csv"; a.click();
  }

  // Calendar-driven current sprint: derived purely from today's date via a
  // Monday-anchored, fixed-length cadence (config SPRINT_ANCHOR). Advances on its
  // own each sprint boundary, independent of whether the data/ETL is current.
  function calendarSprint() {
    var a = cfg.SPRINT_ANCHOR;
    if (!a || a.sprint == null || !a.start) return null;
    var start = new Date(a.start + "T00:00:00");
    if (isNaN(start.getTime())) return null;
    var len = num(cfg.SPRINT_LENGTH_DAYS) || 14;
    var days = Math.floor((new Date() - start) / 86400000);
    return num(a.sprint) + Math.floor(days / len);
  }
  // Current running sprint: config override, else the calendar sprint, else the
  // legacy fallback (latest sprint with delivered work, +1). Windows the dropdown/trend.
  function currentSprint() {
    if (cfg.CURRENT_SPRINT) return num(cfg.CURRENT_SPRINT);
    var cal = calendarSprint();
    if (cal != null) return cal;
    var del = data.items.filter(function (i) { return String(i.is_delivered) === "1"; })
      .map(function (i) { return num(i.sprint); }).filter(function (n) { return n > 0; });
    return del.length ? Math.max.apply(null, del) + 1 : null;
  }
  function inWindow(n) {
    var c = currentSprint();
    // Lower bound: a fixed floor (MIN_SPRINT) when set, else the rolling
    // CURRENT_SPRINT - SPRINT_BACK. Upper bound stays dynamic at CURRENT_SPRINT + 2.
    var lo = (MIN_SPRINT != null) ? MIN_SPRINT : (c != null ? c - SPRINT_BACK : null);
    if (lo != null && n < lo) return false;   // never show sprints below the floor
    if (c != null && n > c + 2) return false;  // hide far-future sprints
    return true;
  }
  function windowSprints() {
    var set = {};
    data.sprints.forEach(function (s) { var n = num(s.sprint); if (n > 0) set[n] = 1; });
    // Always include the floor..current-sprint range so the current running sprint
    // (and any gaps) are selectable even if dim_sprint hasn't been synced yet.
    var c = currentSprint();
    var lo = (MIN_SPRINT != null) ? MIN_SPRINT : (c != null ? c - SPRINT_BACK : null);
    if (c != null && lo != null) { for (var n = lo; n <= c; n++) set[n] = 1; }
    return Object.keys(set).map(Number).filter(function (n) { return n > 0 && inWindow(n); });
  }

  function populateSprintSelect() {
    var sel = el("sprintSel");
    var sprints = windowSprints().sort(function (a, b) { return b - a; });
    sel.innerHTML = sprints.map(function (n) { return '<option value="' + n + '">Sprint ' + n + "</option>"; }).join("");
    // Preserve the user's choice across auto-refresh / reload; else the latest sprint
    // that actually has committed work. IMPORTANT: don't default to (or stay on) a
    // sprint whose items are all pre-development (Backlog/Design/Ready-for-Dev) — those
    // are excluded by isPreSprint, so the whole dashboard would compute to zero and
    // look broken. currentSprint() ("latest delivered + 1") can point at such an
    // empty, not-yet-started future sprint, so it's now only a fallback.
    var inList = function (n) { return sprints.indexOf(num(n)) !== -1; };
    // Default = the current running sprint from the calendar, so a fresh load always
    // lands on the live sprint and advances on its own each sprint boundary. An
    // in-session manual pick (selectedSprint) still wins so the 5-min auto-refresh
    // doesn't yank the user off a sprint they chose. Legacy fallbacks after that.
    var cal = currentSprint();
    var delivered = sprints.filter(function (n) {
      return data.items.some(function (i) { return String(i.sprint) === String(n) && String(i.is_delivered) === "1"; });
    });
    var def = (selectedSprint && inList(selectedSprint)) ? num(selectedSprint)
      : (cal != null && inList(cal)) ? cal
      : delivered.length ? delivered[0]
      : (DEFAULT_SPRINT && inList(DEFAULT_SPRINT)) ? num(DEFAULT_SPRINT)
      : sprints[0];
    sel.value = def; selectedSprint = String(def); return def;
  }

  // ---------- data layer (authenticated Supabase client) ----------
  // ---------- production API page ----------
  var apiEnv = "PROD";
  var API_SLOW_MS = 1000;              // a request taking >= 1s is "slow" (change here if the definition differs)
  function fmtInt(n) { return String(Math.round(num(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
  function methodBadge(m) {
    m = String(m || "").toUpperCase();
    var c = m === "GET" ? "#2e7d32" : m === "POST" ? "#1f6feb" : (m === "PUT" || m === "PATCH") ? "#b9820a" : m === "DELETE" ? "#c62828" : "#5b6577";
    return '<span style="display:inline-block;min-width:48px;text-align:center;font:700 11px ui-monospace,Menlo,monospace;color:#fff;background:' + c + ';padding:2px 7px;border-radius:6px">' + esc(m) + "</span>";
  }
  function statusBadge(s) {
    s = num(s); var c = s >= 500 ? "#c62828" : s >= 400 ? "#b9820a" : s >= 300 ? "#1f6feb" : "#2e7d32";
    return '<span style="font:700 12px ui-monospace,Menlo,monospace;color:' + c + '">' + esc(String(s || "")) + "</span>";
  }
  function apiTime(v) { var d = new Date(v); return isNaN(d.getTime()) ? String(v || "") : d.toLocaleTimeString(); }

  // ----- captured request/response detail (headers + body) shown when a row is clicked -----
  function hashStr(s) { var h = 0; s = String(s); for (var i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; } return h; }
  function apiSampleBody(endpoint, method) {
    if (/\/listings$/.test(endpoint) && method === "GET") return JSON.stringify({ data: [{ id: 4821, title: "2BR Apartment in Salmiya", price_kwd: 450, type: "apartment", city: "Salmiya", published: true }], meta: { page: 1, per_page: 20, total: 1284 } }, null, 2);
    if (/\/listings\/:id$/.test(endpoint) && method === "GET") return JSON.stringify({ data: { id: 4821, title: "2BR Apartment in Salmiya", price_kwd: 450, bedrooms: 2, bathrooms: 2, area_sqm: 120, city: "Salmiya", images: 12, published: true } }, null, 2);
    if (/\/listings/.test(endpoint) && (method === "POST" || method === "PUT")) return JSON.stringify({ data: { id: 4999, status: "draft", step: "photos" } }, null, 2);
    if (/\/search/.test(endpoint)) return JSON.stringify({ data: [{ id: 4821 }, { id: 4790 }], meta: { total: 37, took_ms: 412 } }, null, 2);
    if (/\/auth\/otp/.test(endpoint)) return JSON.stringify({ data: { sent: true, channel: "whatsapp", expires_in: 120 } }, null, 2);
    if (/\/auth\/login/.test(endpoint)) return JSON.stringify({ data: { token: "eyJhbGciOiJIUzI1Ni…", user: { id: 88213, name: "Ali" } } }, null, 2);
    if (/\/users\/me/.test(endpoint)) return JSON.stringify({ data: { id: 88213, name: "Ali", phone: "+9655xxxxxxx", listings: 3 } }, null, 2);
    if (/\/favorites/.test(endpoint)) return JSON.stringify({ data: [{ listing_id: 4821 }, { listing_id: 4655 }] }, null, 2);
    if (/\/uploads\/images/.test(endpoint)) return JSON.stringify({ data: { url: "https://cdn.dallal.com/i/9f2.jpg", width: 1600, height: 1200 } }, null, 2);
    if (/\/leads/.test(endpoint)) return JSON.stringify({ data: { id: 7712, status: "new" } }, null, 2);
    if (/\/cities/.test(endpoint)) return JSON.stringify({ data: [{ id: 1, name: "Kuwait City" }, { id: 2, name: "Salmiya" }] }, null, 2);
    if (/\/notifications/.test(endpoint)) return JSON.stringify({ data: [{ id: 1, type: "lead", read: false }], meta: { unread: 1 } }, null, 2);
    return JSON.stringify({ data: {} }, null, 2);
  }
  function apiSample(method, endpoint, status) {
    method = String(method || "GET").toUpperCase(); status = num(status) || 200;
    var reqId = "req_" + (hashStr(endpoint + method) >>> 0).toString(16).slice(0, 12);
    var reqHeaders = { "Authorization": "Bearer eyJhbGciOiJIUzI1Ni…", "Content-Type": "application/json", "Accept": "application/json", "Accept-Language": "ar-KW", "User-Agent": "Dallal-iOS/3.4.1 (iPhone; iOS 17.5)", "X-Request-Id": reqId };
    if (method === "GET" || method === "DELETE") delete reqHeaders["Content-Type"];
    var resHeaders = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": method === "GET" ? "public, max-age=30" : "no-store", "X-Request-Id": reqId, "X-Runtime": "0.182", "ETag": 'W/"' + (hashStr(endpoint) >>> 0).toString(16).slice(0, 10) + '"' };
    var body;
    if (status >= 500) body = JSON.stringify({ error: "internal_server_error", message: "Something went wrong", request_id: reqId }, null, 2);
    else if (status === 401) body = JSON.stringify({ error: "unauthorized", message: "Invalid or expired token" }, null, 2);
    else if (status === 404) body = JSON.stringify({ error: "not_found", message: "Resource not found" }, null, 2);
    else if (status === 422) body = JSON.stringify({ error: "unprocessable_entity", errors: { title: ["can't be blank"] } }, null, 2);
    else if (status === 429) body = JSON.stringify({ error: "rate_limited", retry_after: 30 }, null, 2);
    else body = apiSampleBody(endpoint, method);
    return { reqHeaders: reqHeaders, resHeaders: resHeaders, body: body };
  }
  function apiHeaderLines(o) {
    return Object.keys(o).map(function (k) { return '<div style="margin:2px 0"><span style="color:#1f6feb">' + esc(k) + '</span><span style="color:#8a94a6">: </span>' + esc(o[k]) + "</div>"; }).join("");
  }
  function apiCaptureHtml(method, endpoint, status) {
    var cap = apiSample(method, endpoint, status);
    var box = "font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;line-height:1.55";
    var hd = "font:700 11px system-ui,sans-serif;text-transform:uppercase;letter-spacing:.05em;color:var(--muted,#5b6577);margin:0 0 5px";
    return '<div style="' + box + '">' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:16px">' +
        '<div><div style="' + hd + '">Request &middot; ' + esc(String(method).toUpperCase()) + " " + esc(endpoint) + "</div>" + apiHeaderLines(cap.reqHeaders) + "</div>" +
        '<div><div style="' + hd + '">Response headers &middot; ' + esc(String(status || 200)) + "</div>" + apiHeaderLines(cap.resHeaders) + "</div>" +
      "</div>" +
      '<div style="' + hd + ';margin-top:11px">Response body</div>' +
      '<pre style="white-space:pre-wrap;word-break:break-word;background:#f4f6fa;border:1px solid #e2e7f0;border-radius:8px;padding:11px;margin:0;overflow:auto">' + esc(cap.body) + "</pre></div>";
  }

  var _sampleApi = null;
  function sampleApi() {
    if (_sampleApi) return _sampleApi;
    var eps = [
      { method: "GET",   endpoint: "/api/v1/listings",       requests: 84210, errors: 126, avg_ms: 180,  p95_ms: 640,  slow_count: 410 },
      { method: "GET",   endpoint: "/api/v1/listings/:id",   requests: 52140, errors: 88,  avg_ms: 150,  p95_ms: 520,  slow_count: 190 },
      { method: "GET",   endpoint: "/api/v1/search",         requests: 39880, errors: 242, avg_ms: 420,  p95_ms: 1450, slow_count: 2870 },
      { method: "POST",  endpoint: "/api/v1/auth/otp",       requests: 14320, errors: 96,  avg_ms: 260,  p95_ms: 900,  slow_count: 120 },
      { method: "POST",  endpoint: "/api/v1/auth/login",     requests: 12760, errors: 210, avg_ms: 300,  p95_ms: 1100, slow_count: 540 },
      { method: "GET",   endpoint: "/api/v1/users/me",       requests: 11890, errors: 34,  avg_ms: 110,  p95_ms: 300,  slow_count: 20 },
      { method: "GET",   endpoint: "/api/v1/favorites",      requests: 9210,  errors: 22,  avg_ms: 130,  p95_ms: 360,  slow_count: 30 },
      { method: "GET",   endpoint: "/api/v1/notifications",  requests: 8330,  errors: 40,  avg_ms: 150,  p95_ms: 420,  slow_count: 60 },
      { method: "GET",   endpoint: "/api/v1/cities",         requests: 7640,  errors: 8,   avg_ms: 60,   p95_ms: 160,  slow_count: 4 },
      { method: "POST",  endpoint: "/api/v1/listings",       requests: 6420,  errors: 180, avg_ms: 540,  p95_ms: 1800, slow_count: 820 },
      { method: "PUT",   endpoint: "/api/v1/listings/:id",   requests: 4310,  errors: 64,  avg_ms: 480,  p95_ms: 1500, slow_count: 410 },
      { method: "POST",  endpoint: "/api/v1/uploads/images", requests: 3980,  errors: 150, avg_ms: 1240, p95_ms: 4200, slow_count: 2600 },
      { method: "POST",  endpoint: "/api/v1/leads",          requests: 2870,  errors: 58,  avg_ms: 340,  p95_ms: 1200, slow_count: 210 },
      { method: "DELETE", endpoint: "/api/v1/favorites/:id", requests: 1740,  errors: 18,  avg_ms: 120,  p95_ms: 340,  slow_count: 12 }
    ];
    eps.forEach(function (e) { e.env = "PROD"; });
    var uat = eps.slice(0, 6).map(function (e) {
      return { env: "UAT", method: e.method, endpoint: e.endpoint, requests: Math.round(e.requests / 22), errors: Math.round(e.errors / 12), avg_ms: e.avg_ms, p95_ms: e.p95_ms, slow_count: Math.round(e.slow_count / 22) };
    });
    var pool = [
      ["GET", "/api/v1/search", 200, 380], ["GET", "/api/v1/listings", 200, 150], ["POST", "/api/v1/auth/otp", 200, 240],
      ["GET", "/api/v1/listings/:id", 200, 140], ["POST", "/api/v1/listings", 201, 610], ["GET", "/api/v1/search", 200, 1620],
      ["POST", "/api/v1/auth/login", 401, 150], ["GET", "/api/v1/users/me", 200, 90], ["POST", "/api/v1/uploads/images", 200, 1980],
      ["GET", "/api/v1/favorites", 200, 120], ["PUT", "/api/v1/listings/:id", 200, 540], ["GET", "/api/v1/search", 500, 240],
      ["GET", "/api/v1/listings", 200, 160], ["POST", "/api/v1/leads", 201, 320], ["GET", "/api/v1/notifications", 200, 140],
      ["GET", "/api/v1/listings/:id", 404, 80], ["POST", "/api/v1/auth/otp", 429, 60], ["GET", "/api/v1/cities", 200, 50],
      ["POST", "/api/v1/listings", 422, 300], ["GET", "/api/v1/search", 200, 720], ["DELETE", "/api/v1/favorites/:id", 200, 110],
      ["GET", "/api/v1/listings", 200, 175], ["POST", "/api/v1/uploads/images", 500, 3200], ["GET", "/api/v1/users/me", 200, 100]
    ];
    var now = Date.now();
    var reqs = pool.map(function (p, i) { return { env: "PROD", method: p[0], endpoint: p[1], status: p[2], response_ms: p[3], occurred_at: new Date(now - i * 41000).toISOString() }; });
    _sampleApi = { eps: eps.concat(uat), reqs: reqs };
    return _sampleApi;
  }

  function populateApiEnv(envs) {
    var sel = el("apiEnv"); if (!sel || sel.options.length) return;
    envs.forEach(function (e) { var o = document.createElement("option"); o.value = e; o.textContent = e; sel.appendChild(o); });
    sel.value = apiEnv;
    sel.addEventListener("change", function () { apiEnv = sel.value; renderApi(); });
  }

  function renderApi() {
    var live = (data.apiEndpoints && data.apiEndpoints.length);
    var eps = live ? data.apiEndpoints : sampleApi().eps;
    var reqs = (data.apiRequests && data.apiRequests.length) ? data.apiRequests : sampleApi().reqs;
    var envs = [];
    eps.forEach(function (e) { var v = e.env || "PROD"; if (envs.indexOf(v) === -1) envs.push(v); });
    if (!envs.length) envs = ["PROD"];
    if (envs.indexOf(apiEnv) === -1) apiEnv = envs[0];
    populateApiEnv(envs);

    var E = eps.filter(function (e) { return (e.env || "PROD") === apiEnv; });
    var R = reqs.filter(function (r) { return (r.env || "PROD") === apiEnv; });

    var total = 0, errors = 0, slow = 0, wsum = 0;
    E.forEach(function (e) { var rq = num(e.requests); total += rq; errors += num(e.errors); slow += num(e.slow_count); wsum += num(e.avg_ms) * rq; });
    var avg = total ? Math.round(wsum / total) : 0;
    var errRate = total ? errors / total : 0, slowRate = total ? slow / total : 0, okRate = total ? (1 - errRate) : 0;

    el("apiWindow").textContent = live ? "Live · current rolling window" : "Sample data — this is how it will look once request capture is wired up";

    el("apiKpis").innerHTML =
      card("Total Requests", fmtInt(total), { icon: "🌐", accent: "#1f6feb", tip: "All API requests captured in the current window for " + apiEnv + "." }) +
      card("Errors", fmtInt(errors) + ' <span style="font-size:13px;color:var(--muted,#5b6577)">(' + pct(errRate) + ")</span>", { icon: "⛔", accent: errRate > 0.02 ? "#c62828" : "#2e7d32", tip: "Responses with HTTP status ≥ 400 (4xx + 5xx)." }) +
      card("Avg Response Time", fmtInt(avg) + ' <span style="font-size:13px;color:var(--muted,#5b6577)">ms</span>', { icon: "⏱️", accent: avg > 500 ? "#b9820a" : "#2e7d32", tip: "Request-weighted mean response time across all endpoints." }) +
      card("Slow Requests", fmtInt(slow) + ' <span style="font-size:13px;color:var(--muted,#5b6577)">(' + pct(slowRate) + ")</span>", { icon: "🐢", accent: slowRate > 0.02 ? "#b9820a" : "#2e7d32", tip: "Requests taking ≥ 1s (" + API_SLOW_MS + " ms)." }) +
      card("Success Rate", pct(okRate), { icon: "✅", accent: okRate >= 0.98 ? "#2e7d32" : okRate >= 0.95 ? "#b9820a" : "#c62828", tip: "Share of requests with status < 400." });

    var epRows = E.slice().sort(function (a, b) { return num(b.requests) - num(a.requests); }).map(function (e, i) {
      var er = num(e.requests) ? num(e.errors) / num(e.requests) : 0;
      var erc = er >= 0.05 ? "#c62828" : er >= 0.02 ? "#b9820a" : "#2e7d32";
      var avgc = num(e.avg_ms) >= API_SLOW_MS ? "#c62828" : num(e.avg_ms) >= 500 ? "#b9820a" : "inherit";
      return '<tr class="aprow" data-i="' + i + '" style="cursor:pointer"><td>' + methodBadge(e.method) + "</td>" +
        '<td style="font-family:ui-monospace,Menlo,monospace;font-size:12.5px"><span class="epind" style="color:#9aa6bb">&#9656;</span> ' + esc(e.endpoint) + "</td>" +
        "<td>" + fmtInt(e.requests) + "</td><td>" + fmtInt(e.errors) + "</td>" +
        '<td style="color:' + erc + ';font-weight:700">' + pct(er) + "</td>" +
        '<td style="color:' + avgc + '">' + fmtInt(e.avg_ms) + "</td>" +
        "<td>" + fmtInt(e.p95_ms) + "</td><td>" + fmtInt(e.slow_count) + "</td></tr>" +
        '<tr class="apdet hidden" data-i="' + i + '"><td colspan="8" style="background:#f7f9fc">' + apiCaptureHtml(e.method, e.endpoint, 200) + "</td></tr>";
    }).join("");
    var epTable = '<table class="risks"><thead><tr><th>Method</th><th>Endpoint</th><th>Requests</th><th>Errors</th><th>Err %</th><th>Avg ms</th><th>P95 ms</th><th>Slow &ge;1s</th></tr></thead><tbody>' +
      (epRows || '<tr><td colspan="8" class="muted">No API data.</td></tr>') + "</tbody></table>";
    el("apiEndpoints").innerHTML = listBlock("apiendpoints", "Endpoints &middot; " + E.length + " routes", epTable);

    var logRows = R.slice().sort(function (a, b) { return String(b.occurred_at || "").localeCompare(String(a.occurred_at || "")); }).slice(0, 30).map(function (r) {
      var isSlow = num(r.response_ms) >= API_SLOW_MS;
      var head = methodBadge(r.method) +
        '<span style="font-family:ui-monospace,Menlo,monospace;font-size:12.5px">' + esc(r.endpoint) + "</span>" +
        statusBadge(r.status) +
        '<span style="font-family:ui-monospace,Menlo,monospace;font-size:12px;color:' + (isSlow ? "#c62828" : "var(--muted,#5b6577)") + '">' + fmtInt(r.response_ms) + " ms" + (isSlow ? " · slow" : "") + "</span>" +
        '<span class="muted" style="font-size:12px;margin-left:auto">' + esc(apiTime(r.occurred_at)) + "</span>";
      return '<details class="apireq" style="border-bottom:1px solid #eef1f5"><summary style="cursor:pointer;padding:9px 4px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">' + head + "</summary>" +
        '<div style="padding:4px 4px 13px">' + apiCaptureHtml(r.method, r.endpoint, r.status) + "</div></details>";
    }).join("");
    el("apiLog").innerHTML = listBlock("apilog", "Method &amp; response of recent API calls &middot; " + R.length, logRows || '<div class="muted">No recent requests.</div>');
  }

  function exportApi() {
    var live = (data.apiEndpoints && data.apiEndpoints.length);
    var eps = (live ? data.apiEndpoints : sampleApi().eps).filter(function (e) { return (e.env || "PROD") === apiEnv; });
    downloadCSV("dallal-api-endpoints-" + apiEnv + "-" + csvStamp() + ".csv", toCSV(eps, [
      { key: "method", label: "Method" }, { key: "endpoint", label: "Endpoint" }, { key: "requests", label: "Requests" },
      { key: "errors", label: "Errors" }, { key: "avg_ms", label: "Avg ms" }, { key: "p95_ms", label: "P95 ms" }, { key: "slow_count", label: "Slow >=1s" }
    ]));
  }

  // ---------- App Store page (Apple App Store Connect analytics) ----------
  // Live rows come from Supabase table `fact_appstore_metrics`, a tidy/long table:
  //   { date:'YYYY-MM-DD', metric:'downloads'|'redownloads'|'impressions'|
  //     'product_page_views'|'sessions'|'active_devices'|'crashes',
  //     value:number, territory:'WW'|ISO2, platform:'ios', app_version:text }
  // Populated by etl_appstore.py. Until that runs we show a clearly-labelled
  // sample so the tab renders (same pattern as the Production API tab).
  var asRange = 30;
  var asCustom = false, asFrom = "", asTo = "";
  var asPlatform = "ios";   // ios | android (two sub-tabs, like User Flow)
  var _sampleAppStore = null;
  var AS_TERRITORIES = [
    { code: "KW", name: "🇰🇼 Kuwait", w: 0.42 }, { code: "SA", name: "🇸🇦 Saudi Arabia", w: 0.18 },
    { code: "AE", name: "🇦🇪 UAE", w: 0.12 }, { code: "EG", name: "🇪🇬 Egypt", w: 0.10 },
    { code: "QA", name: "🇶🇦 Qatar", w: 0.06 }, { code: "US", name: "🇺🇸 United States", w: 0.05 },
    { code: "BH", name: "🇧🇭 Bahrain", w: 0.04 }, { code: "OM", name: "🇴🇲 Oman", w: 0.03 }
  ];

  function sampleAppStore() {
    // Disabled: never show placeholder/sample store numbers — the team mistook them
    // for real data. When live data isn't loaded the tiles show an honest empty state.
    return [];
  }
  function _sampleAppStoreOLD() {
    if (_sampleAppStore) return _sampleAppStore;
    var rows = [];
    var today = new Date();
    for (var d = 29; d >= 0; d--) {
      var dt = new Date(today.getTime() - d * 86400000);
      var iso = dt.toISOString().slice(0, 10);
      var dow = dt.getDay();                       // weekly seasonality (weekend dip)
      var seasonal = (dow === 5 || dow === 6) ? 0.82 : 1;
      var base = Math.round((360 + (29 - d) * 6) * seasonal * (0.9 + Math.random() * 0.2)); // gentle uptrend
      // downloads split by territory
      AS_TERRITORIES.forEach(function (t) {
        rows.push({ date: iso, metric: "downloads", value: Math.round(base * t.w), territory: t.code, platform: "ios", app_version: "1.19" });
      });
      var pageViews = Math.round(base * (2.4 + Math.random() * 0.5));
      var impressions = Math.round(base * (19 + Math.random() * 5));
      var sessions = Math.round(base * (7 + Math.random() * 2));
      var active = Math.round(base * (5.5 + Math.random() * 1.5) + (29 - d) * 40);
      var redl = Math.round(base * (0.25 + Math.random() * 0.1));
      var crashes = Math.round(2 + Math.random() * 4);
      if (iso === "2026-08-11") crashes += 34;      // watchdog OOM spike (DALLAL-RN-3Q)
      rows.push({ date: iso, metric: "product_page_views", value: pageViews, territory: "WW", platform: "ios", app_version: "1.19" });
      rows.push({ date: iso, metric: "impressions", value: impressions, territory: "WW", platform: "ios", app_version: "1.19" });
      rows.push({ date: iso, metric: "sessions", value: sessions, territory: "WW", platform: "ios", app_version: "1.19" });
      rows.push({ date: iso, metric: "active_devices", value: active, territory: "WW", platform: "ios", app_version: "1.19" });
      rows.push({ date: iso, metric: "redownloads", value: redl, territory: "WW", platform: "ios", app_version: "1.19" });
      rows.push({ date: iso, metric: "crashes", value: crashes, territory: "WW", platform: "ios", app_version: "1.19" });
      // Android (Google Play) sample — roughly 0.6x iOS, so the platform toggle demos.
      var a = 0.6;
      AS_TERRITORIES.forEach(function (t) {
        rows.push({ date: iso, metric: "downloads", value: Math.round(base * t.w * a), territory: t.code, platform: "android", app_version: "1.19" });
      });
      rows.push({ date: iso, metric: "product_page_views", value: Math.round(pageViews * a), territory: "WW", platform: "android", app_version: "1.19" });
      rows.push({ date: iso, metric: "impressions", value: Math.round(impressions * a), territory: "WW", platform: "android", app_version: "1.19" });
      rows.push({ date: iso, metric: "sessions", value: Math.round(sessions * a), territory: "WW", platform: "android", app_version: "1.19" });
      rows.push({ date: iso, metric: "active_devices", value: Math.round(active * a), territory: "WW", platform: "android", app_version: "1.19" });
      rows.push({ date: iso, metric: "redownloads", value: Math.round(redl * a), territory: "WW", platform: "android", app_version: "1.19" });
      rows.push({ date: iso, metric: "crashes", value: Math.round(crashes * a), territory: "WW", platform: "android", app_version: "1.19" });
    }
    _sampleAppStore = rows;
    return rows;
  }

  function asAllDates() {
    var src = (data.appstore && data.appstore.length) ? data.appstore : sampleAppStore();
    var s = {}; src.forEach(function (r) { if (r.date) s[r.date] = 1; });
    return Object.keys(s).sort();
  }
  function populateAppstoreRange() {
    var sel = el("appstoreRange"); if (!sel) return;
    // Google Play statistics have no 24-hour granularity — never offer "Last 24 hours"
    // on Android; if it was selected, fall back to Last 7 days.
    var isAndroidR = asPlatform === "android";
    if (isAndroidR && asRange === 1) asRange = 7;
    var opts = [[7, "Last 7 days"], [14, "Last 14 days"], [30, "Last 30 days"], [90, "Last 90 days"], ["custom", "Custom range…"]];
    if (!isAndroidR) opts.unshift([1, "Last 24 hours"]);
    // Rebuild options each render (platform-dependent), preserving the selection.
    var cur = asCustom ? "custom" : String(asRange);
    sel.innerHTML = "";
    opts.forEach(function (o) {
      var opt = document.createElement("option"); opt.value = o[0]; opt.textContent = o[1];
      if (String(o[0]) === cur) opt.selected = true; sel.appendChild(opt);
    });
    if (sel._wired) return;   // attach change listeners only once
    sel._wired = true;
    sel.addEventListener("change", function () {
      if (sel.value === "custom") {
        asCustom = true; el("appstoreCustom").style.display = "inline-flex";
        var ad = asAllDates();
        if (ad.length) {
          if (!asTo) { asTo = ad[ad.length - 1]; el("appstoreTo").value = asTo; }
          if (!asFrom) { asFrom = ad[Math.max(0, ad.length - 30)]; el("appstoreFrom").value = asFrom; }
          el("appstoreFrom").min = ad[0]; el("appstoreFrom").max = ad[ad.length - 1];
          el("appstoreTo").min = ad[0]; el("appstoreTo").max = ad[ad.length - 1];
        }
      } else {
        asCustom = false; el("appstoreCustom").style.display = "none"; asRange = parseInt(sel.value, 10) || 30;
      }
      renderAppStore();
    });
    el("appstoreFrom").addEventListener("change", function () { asFrom = el("appstoreFrom").value; renderAppStore(); });
    el("appstoreTo").addEventListener("change", function () { asTo = el("appstoreTo").value; renderAppStore(); });
  }
  // Dates in the active window: custom [From..To] when set, else the last N days.
  function asWindowDates(rows) {
    var s = {}; rows.forEach(function (r) { if (r.date) s[r.date] = 1; });
    var ds = Object.keys(s).sort();
    if (asCustom && asFrom && asTo) {
      var lo = asFrom, hi = asTo; if (lo > hi) { var t = lo; lo = hi; hi = t; }
      return ds.filter(function (d) { return d >= lo && d <= hi; });
    }
    return ds.slice(-asRange);
  }
  function asRangeLabel() {
    if (asCustom && asFrom && asTo) return asFrom + " to " + asTo;
    return asRange === 1 ? "last 24 hours" : ("last " + asRange + " days");
  }
  function fmtDay(iso) {
    var p = (iso || "").split("-"); if (p.length < 3) return iso || "";
    var m = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][parseInt(p[1], 10) - 1] || p[1];
    return parseInt(p[2], 10) + " " + m + " " + p[0];
  }

  // sum a metric per date across territories -> { 'YYYY-MM-DD': total }
  // Per-date total for a metric. WW is the authoritative total, so when a date has
  // a WW row we use it and IGNORE per-country rows (they're a breakdown, not extra) —
  // otherwise WW + per-country double-counts (e.g. Android installs). Dates without a
  // WW row fall back to summing territories (that's how iOS downloads are stored).
  function asByDate(rows, metric) {
    var ww = {}, terr = {};
    rows.forEach(function (r) {
      if ((r.metric || "") !== metric) return;
      var t = r.territory;
      if (t === "WW" || t == null || t === "") ww[r.date] = (ww[r.date] || 0) + num(r.value);
      else terr[r.date] = (terr[r.date] || 0) + num(r.value);
    });
    var out = {}, d;
    for (d in terr) out[d] = terr[d];
    for (d in ww) out[d] = ww[d];   // WW wins when present
    return out;
  }
  function asDatesInWindow(rows, days) {
    var set = {}; rows.forEach(function (r) { if (r.date) set[r.date] = 1; });
    return Object.keys(set).sort().slice(-days);
  }
  function asSeries(byDate, dates) { return dates.map(function (d) { return byDate[d] || 0; }); }
  function asSum(arr) { return arr.reduce(function (a, b) { return a + b; }, 0); }
  var AS_TEAL = "#0f8b8d", AS_BLUE = "#1f6feb", AS_PURPLE = "#7c5cbf", AS_RED = "#c62828", AS_AMBER = "#b9820a";

  function asLineChart(id, dates, series, opts) {
    opts = opts || {};
    var labels = dates.map(function (d) { return d.slice(5); });   // MM-DD
    mkChart(id, {
      type: "line",
      data: { labels: labels, datasets: series.map(function (s) {
        // Show points when the window is short OR the series has few data points,
        // so sparse/single-day data isn't an invisible line.
        var pts = (s.data || []).filter(function (v) { return v != null && v > 0; }).length;
        var pr = (labels.length <= 12 || pts <= 3) ? 3.5 : 0;
        return { label: s.label, data: s.data, borderColor: s.color, backgroundColor: (s.fill ? s.color + "22" : "transparent"),
          fill: !!s.fill, tension: 0.32, borderWidth: 2, pointRadius: pr, pointBackgroundColor: s.color, pointHoverRadius: 5, yAxisID: s.axis || "y" };
      }) },
      options: {
        responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
        plugins: { legend: { display: series.length > 1, labels: { boxWidth: 12, usePointStyle: true, font: { size: 11 } } },
          tooltip: { callbacks: { label: function (c) { return c.dataset.label + ": " + (opts.pct ? (Math.round(c.parsed.y * 10) / 10 + "%") : fmtInt(c.parsed.y)); } } } },
        scales: Object.assign({
          x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8, font: { size: 10 } } },
          y: { beginAtZero: true, ticks: { font: { size: 10 }, callback: function (v) { return opts.pct ? v + "%" : fmtInt(v); } }, grid: { color: "#eef1f5" } }
        }, opts.y2 ? { y2: { position: "right", beginAtZero: true, grid: { drawOnChartArea: false }, ticks: { font: { size: 10 }, callback: function (v) { return fmtInt(v); } } } } : {})
      }
    });
  }

  function asTimeAgo(ms) {
    var s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (s < 60) return "just now";
    var m = Math.floor(s / 60); if (m < 60) return m + " min ago";
    var h = Math.floor(m / 60); if (h < 24) return h + (h === 1 ? " hour ago" : " hours ago");
    var d = Math.floor(h / 24); return d + (d === 1 ? " day ago" : " days ago");
  }
  function renderAppStore() {
    populateAppstoreRange();
    el("tabPlatIos").classList.toggle("active", asPlatform === "ios");
    el("tabPlatAndroid").classList.toggle("active", asPlatform === "android");
    var live = (data.appstore && data.appstore.length);
    var allRows = live ? data.appstore : sampleAppStore();
    // Platform sub-tab: iOS / Android (rows carry platform 'ios' | 'android').
    var rows = allRows.filter(function (r) { return (r.platform || "ios") === asPlatform; });
    var isAndroid = asPlatform === "android";
    var hasAndroid = allRows.some(function (r) { return (r.platform || "ios") === "android" && num(r.value) > 0; });
    var platLabel = asPlatform === "android" ? "Android · Google Play" : "iOS · App Store";

    if (live) {
      var lastSync = null, dataThrough = "";
      rows.forEach(function (r) {
        if (r.updated_at) { var t = new Date(r.updated_at).getTime(); if (!isNaN(t) && (lastSync == null || t > lastSync)) lastSync = t; }
        if (r.date && r.date > dataThrough) dataThrough = r.date;
      });
      var syncTxt = lastSync ? " · Last synced " + asTimeAgo(lastSync) + " (" + new Date(lastSync).toLocaleString() + ")" : "";
      var throughTxt = dataThrough ? " · data through " + dataThrough : "";
      el("appstoreWindow").textContent = "Live · " + platLabel + throughTxt + syncTxt;
    } else {
      el("appstoreWindow").textContent = "No store data loaded for " + platLabel + " — the feed hasn't loaded yet. Try Refresh, or check the connection / data source.";
    }

    // Google Play not-connected note + data-staleness banner. Normal store lag is
    // 1–3 days; anything older means the store's feed is delayed/frozen, and the
    // "Last 24 hours" tile is actually showing an old day — say so, don't fake it.
    var playNote = el("appstorePlayNote");
    if (playNote) {
      var latestDate = "";
      rows.forEach(function (r) { if (r.date && r.date > latestDate) latestDate = r.date; });
      var todayStr = new Date().toISOString().slice(0, 10);
      var daysStale = latestDate ? Math.floor((Date.parse(todayStr) - Date.parse(latestDate)) / 86400000) : null;
      var STALE_AFTER = 4;   // days; normal Apple/Play reporting lag is 1–3 days
      function noteStyle(tone) {
        if (tone === "warn") { playNote.style.background = "#fff5e6"; playNote.style.borderColor = "#f0c67a"; playNote.style.color = "#7a4e05"; }
        else { playNote.style.background = "#eaf2ff"; playNote.style.borderColor = "#b6cdf2"; playNote.style.color = "#1c3a63"; }
      }
      if (live && asPlatform === "android" && !hasAndroid) {
        noteStyle("info");
        playNote.innerHTML = "🤖 <b>Google Play (Android) isn't connected yet.</b> Android metrics will appear here once the Play Store ETL is wired up (needs a Google Play service-account key). iOS is live on the other tab.";
        playNote.classList.remove("hidden");
      } else if (live && daysStale != null && daysStale > STALE_AFTER) {
        var storeNm = asPlatform === "android" ? "Google Play" : "App Store";
        var extra = asPlatform === "android"
          ? " Google has stopped refreshing the Play <b>install</b> statistics export (crashes/ratings/reviews are still current), so no newer install data is available to pull. The figures below — including any “Last 24 hours” tile — reflect <b>" + esc(latestDate) + "</b>, not today."
          : " The figures below reflect the latest available reporting day.";
        noteStyle("warn");
        playNote.innerHTML = "⏳ <b>" + storeNm + " data is delayed.</b> Latest available day is <b>" + esc(latestDate) + "</b> (" + daysStale + " days ago)." + extra;
        playNote.classList.remove("hidden");
      } else {
        playNote.classList.add("hidden");
      }
    }

    var dates = asWindowDates(rows);
    var last = dates.length ? dates[dates.length - 1] : "";

    var hasMetric = function (m) { return rows.some(function (r) { return (r.metric || "") === m && num(r.value) > 0; }); };
    // iOS downloads come from Sales & Trends "App Units" — this matches App Store
    // Connect's Analytics "First-Time Downloads" chart closely (~1,789 vs Apple 1,820).
    // We deliberately DON'T merge the App Analytics ONGOING feed (downloads_analytics):
    // it was producing inflated values (e.g. 44/61/125 a day vs Apple's ~25-30), which
    // over-counted the totals. Analytics is still used for impressions / page views / sessions.
    var acqSource = "Sales & Trends (App Units)";

    // iOS install series = Sales & Trends App Units ("downloads"). Android install
    // series = "device_installs" (Play "Device acquisition") — the clean, by-device
    // first-install count that best matches Adjust (the "downloads"/"New users"
    // metric was swapped to All-users and over-counts, so we use device acquisition).
    var dl = asByDate(rows, isAndroid ? "device_installs" : "downloads"),
        dev = asByDate(rows, "device_installs"),
        redl = asByDate(rows, "redownloads"),
        imp = asByDate(rows, "impressions"), pv = asByDate(rows, "product_page_views"),
        ses = asByDate(rows, "sessions"),
        act = asByDate(rows, hasMetric("active_devices") ? "active_devices" : "active_devices_est"),
        cr = asByDate(rows, "crashes");

    var sDl = asSeries(dl, dates), sRe = asSeries(redl, dates), sImp = asSeries(imp, dates),
        sPv = asSeries(pv, dates), sSes = asSeries(ses, dates), sAct = asSeries(act, dates),
        sCr = asSeries(cr, dates), sDev = asSeries(dev, dates);

    var totDl = asSum(sDl), totRe = asSum(sRe), totImp = asSum(sImp), totPv = asSum(sPv),
        totSes = asSum(sSes), totCr = asSum(sCr), totDev = asSum(sDev);
    // All-time downloads: sum EVERY available day (independent of the range selector).
    // `dl` already holds per-date totals for all dates in the data. Also capture the
    // earliest day so we can label the coverage honestly (iOS history is a short
    // rolling window; Android goes back to 2021).
    var dlAllKeys = Object.keys(dl).sort();
    var totDlAll = dlAllKeys.reduce(function (a, d) { return a + num(dl[d]); }, 0);
    var dlSince = dlAllKeys.length ? dlAllKeys[0] : "";
    var sDlAll = dlAllKeys.map(function (d) { return num(dl[d]); });
    // Extra Android engagement/quality metrics (imported from Play Console stats).
    var sacB = asByDate(rows, "store_acquisitions"), retB = asByDate(rows, "returning_users"),
        ulsB = asByDate(rows, "uninstalls"), dauB = asByDate(rows, "dau"),
        dmauB = asByDate(rows, "dau_mau"), anrB = asByDate(rows, "anrs");
    var sSac = asSeries(sacB, dates), sRet = asSeries(retB, dates), sUls = asSeries(ulsB, dates),
        sDau = asSeries(dauB, dates), sDmau = asSeries(dmauB, dates), sAnr = asSeries(anrB, dates);
    var totSac = asSum(sSac), totRet = asSum(sRet), totUls = asSum(sUls), totAnr = asSum(sAnr);
    // DAU & stickiness are daily levels, not counts — average over days that have data.
    function avgPresent(byDate) {
      var vals = dates.filter(function (d) { return byDate[d] != null; }).map(function (d) { return byDate[d]; });
      return vals.length ? vals.reduce(function (a, b) { return a + b; }, 0) / vals.length : null;
    }
    var avgDau = avgPresent(dauB), avgStick = avgPresent(dmauB);
    var hasDau = avgDau != null, hasStick = avgStick != null;
    var conv = totImp ? totDl / totImp : 0;   // App Store Connect Conversion Rate = downloads ÷ impressions
    // Average over days that actually have data, NOT the whole window — Apple's
    // analytics only covers the most recent few days, and the rest aren't "0
    // active devices", they simply have no data yet. Dividing by the full window
    // would dilute the daily average (e.g. 43 over 5 real days reads as ~1/30d).
    var actDays = dates.filter(function (d) { return act[d] != null; }).length;
    var avgAct = actDays ? Math.round(asSum(sAct) / actDays) : 0;
    // Android active-devices = Play "Install base", a cumulative LEVEL (running total
    // of installed devices), so the meaningful figure is the CURRENT value (latest
    // day) — not the average of a growing curve. iOS = daily active count → average.
    var latestAct = 0;
    for (var _ai = dates.length - 1; _ai >= 0; _ai--) { if (act[dates[_ai]] != null) { latestAct = act[dates[_ai]]; break; } }
    var actShown = isAndroid ? latestAct : avgAct;

    // Downloads this week vs last week — fixed 7d-vs-prior-7d, anchored on the
    // latest data date (independent of the Range selector above).
    var isoShift = function (iso, d) { var x = new Date(iso + "T00:00:00"); x.setDate(x.getDate() + d); return x.toISOString().slice(0, 10); };
    var sumRange = function (byDate, lo, hi) { var s = 0; Object.keys(byDate).forEach(function (d) { if (d >= lo && d <= hi) s += byDate[d]; }); return s; };
    var allDlDates = Object.keys(dl).sort();
    var maxDlDate = allDlDates.length ? allDlDates[allDlDates.length - 1] : null;
    var wowThis = 0, wowLast = 0, wowDelta = null;
    if (maxDlDate) {
      wowThis = sumRange(dl, isoShift(maxDlDate, -6), maxDlDate);
      wowLast = sumRange(dl, isoShift(maxDlDate, -13), isoShift(maxDlDate, -7));
      wowDelta = wowLast > 0 ? (wowThis - wowLast) / wowLast : null;
    }
    var wowColor = wowDelta == null ? "var(--muted,#5b6577)" : wowDelta > 0 ? "#2e7d32" : wowDelta < 0 ? "#c62828" : "var(--muted,#5b6577)";
    var wowArrow = wowDelta == null ? "" : wowDelta > 0 ? "▲" : wowDelta < 0 ? "▼" : "▬";
    var wowTxt = wowDelta == null ? "no prior week" : (wowDelta > 0 ? "+" : "") + (Math.round(wowDelta * 1000) / 10) + "%";
    var wowValue = fmtInt(wowThis) + ' <span style="font-size:13px;font-weight:600;color:' + wowColor + '">' + wowArrow + " " + wowTxt + "</span>";

    // App Analytics metrics land ~24–48h after setup and arrive per-metric (impressions
    // and page views often lag sessions by a day or more). Gate each card on ITS OWN
    // data so a metric that hasn't arrived shows "—", not a misleading 0.
    var impLive = hasMetric("impressions"), pvLive = hasMetric("product_page_views");
    var sesLive = hasMetric("sessions"), crLive = hasMetric("crashes");
    var actEst = !hasMetric("active_devices") && hasMetric("active_devices_est");
    var actLive = hasMetric("active_devices") || actEst;
    // Conversion: iOS = downloads ÷ impressions; Android = installs ÷ store-listing
    // views (Google Play's store conversion). Recompute conv for Android.
    if (isAndroid) conv = totPv ? totDl / totPv : 0;
    // Android store-listing views (product_page_views) come from the frozen bulk
    // export (stuck at ~Aug 4). If they lag the install data by >10 days, installs÷views
    // spans mismatched windows and yields a nonsensical >100% rate — mark it unavailable.
    var pvDates = Object.keys(pv).sort(), winEnd = dates.length ? dates[dates.length - 1] : "";
    var pvLatest = pvDates.length ? pvDates[pvDates.length - 1] : "";
    var pvStale = isAndroid && pvLatest && winEnd && (Date.parse(winEnd) - Date.parse(pvLatest) > 10 * 86400000);
    var convLive = isAndroid ? (pvLive && totPv > 0 && !pvStale) : (impLive && totImp > 0);
    var PEND = '<span style="opacity:.4;font-weight:600">—</span>';
    var PEND_TIP = isAndroid
      ? "Not reported by Google Play — this metric comes from Apple's App Analytics (iOS only)."
      : "Waiting on Apple's App Analytics feed — this metric usually lands 24–48h after setup, then fills in automatically.";
    var pv2 = function (v, live) { return live ? v : PEND; };
    var pcol = function (c, live) { return live ? c : "#9aa6bb"; };

    var COL = { dl: "#7b61ff", re: "#3b82f6", wk: "#22c55e", imp: "#f5883f", pv: "#ec4899", conv: "#8a74f4", ses: "#0ea89a", act: "#7b61ff", cr: "#ef4444" };
    var _sparks = [];
    function sparkBox(id, series, color, ok) {
      if (ok && series && series.some(function (v) { return v > 0; })) { _sparks.push([id, series, color]); return '<div class="mcard-spark"><canvas id="' + id + '"></canvas></div>'; }
      return '<div class="mcard-spark nospark"></div>';
    }
    function mcard(title, value, icon, color, sparkHtml, sub, tip) {
      var t = tip ? ' <span class="tip" data-tip="' + escAttr(tip) + '">i</span>' : '';
      return '<div class="mcard" style="--mc:' + color + '"><div class="mcard-top"><span class="mcard-ic">' + icon + '</span><span class="mcard-title">' + title + t + '</span></div>' +
        '<div class="mcard-val">' + value + '</div>' + (sparkHtml || '') + (sub ? '<div class="mcard-sub">' + sub + '</div>' : '') + '</div>';
    }
    var wowBadge = wowDelta == null ? '' : ' <span class="mbadge" style="color:' + (wowDelta > 0 ? "#16a34a" : wowDelta < 0 ? "#dc2626" : "#64748b") + ';background:' + (wowDelta > 0 ? "rgba(34,197,94,.14)" : wowDelta < 0 ? "rgba(239,68,68,.14)" : "rgba(120,140,170,.14)") + '">' + wowArrow + ' ' + wowTxt + '</span>';
    // Apple-only metrics (Impressions / Page Views / Conversion / Sessions /
    // Redownloads) don't exist in Google Play's reports — omit those tiles on Android.
    el("appstoreKpis").innerHTML =
      mcard(isAndroid ? "All-Time Installs" : "All-Time Downloads", fmtInt(totDlAll), "📥", "#5a5be6",
        sparkBox("sp_all", sDlAll, "#5a5be6", true),
        (dlSince ? "since " + fmtDay(dlSince) : null),
        "Cumulative " + (isAndroid ? "installs (by device — Play Device acquisition)" : "first-time downloads") + " across every available day (" + (dlSince ? fmtDay(dlSince) : "?") + " → today), independent of the Range selector above." + (isAndroid ? " Android history goes back to 2021." : " iOS covers Apple's retained Sales & Trends reports (~365 days), back to the app's first iOS downloads.")) +
      (isAndroid
        ? mcard("Installs", fmtInt(totDl), "📱", COL.dl, sparkBox("sp_dl", sDl, COL.dl, true), "by device (Device acquisition)",
            "Google Play Device acquisition — first installs counted per device (each device that installs). This is the by-device count, which matches Adjust's device-based install attribution most closely.")
        : mcard("First-Time Downloads", fmtInt(totDl), "⬇️", COL.dl, sparkBox("sp_dl", sDl, COL.dl, true), null, "First-time downloads. Source: " + acqSource + ".")) +
      (isAndroid ? "" :
        mcard("Redownloads", fmtInt(totRe), "🔁", COL.re, sparkBox("sp_re", sRe, COL.re, true), null, "Re-installs by users who previously downloaded the app.")) +
      mcard("Downloads — This Week vs Last", fmtInt(wowThis) + wowBadge, "📅", COL.wk, sparkBox("sp_wk", sDl.slice(-14), COL.wk, true), (maxDlDate ? "Last week: " + fmtInt(wowLast) : ""), (isAndroid ? "Installs" : "First-time downloads") + " last 7 days vs previous 7. Independent of the Range selector.") +
      mcard("Impressions", pv2(fmtInt(totImp), impLive), "👁️", COL.imp, sparkBox("sp_imp", sImp, COL.imp, impLive), null, impLive ? (isAndroid ? "Times your listing appeared in Google Play (store-listing impressions)." : "Times the app appeared in the App Store.") : PEND_TIP) +
      mcard(isAndroid ? "Store Listing Views" : "Product Page Views", pv2(fmtInt(totPv), pvLive), "📄", COL.pv, sparkBox("sp_pv", sPv, COL.pv, pvLive), null, pvLive ? (isAndroid ? "Unique visitors to your Google Play store listing." : "Views of the app's product page.") : PEND_TIP) +
      mcard("Conversion Rate", pv2((Math.round(conv * 1000) / 10) + "%", convLive), "🎯", COL.conv, sparkBox("sp_cv", [], COL.conv, false), null, convLive ? (isAndroid ? "Installs ÷ store-listing views — Google Play's store conversion." : "First-time downloads ÷ impressions.") : (isAndroid ? (pvStale ? "Unavailable — Store Listing Views are stale (Google's export is frozen at " + esc(pvLatest || "—") + "), so installs÷views would span mismatched windows. Export 'Store listing visitors' from Play Console to restore it." : "Needs store-listing views from Google Play.") : "Waiting on Impressions from Apple's App Analytics feed.")) +
      (isAndroid ? "" :
        mcard("Sessions", pv2(fmtInt(totSes), sesLive), "📲", COL.ses, sparkBox("sp_ses", sSes, COL.ses, sesLive), (actLive ? "Active Devices: " + (actEst ? "~" : "") + fmtInt(avgAct) : ""), sesLive ? "App sessions recorded by App Analytics." : PEND_TIP)) +
      mcard(isAndroid ? "Active Devices" : ("Active Devices / Day" + (actEst ? " (est.)" : "")), pv2((actEst ? "~" : "") + fmtInt(actShown), actLive), "📱", COL.act, sparkBox("sp_act", sAct, COL.act, actLive), isAndroid ? "current install base" : null, actLive ? (isAndroid ? "Current install base — unique devices with the app installed on the latest day (Play Console 'Installed audience' / Install base). This is a running level, not a daily count, so it shows the current value, not a 90-day average." : "Average distinct devices active per day.") : PEND_TIP) +
      mcard("Crashes", pv2(fmtInt(totCr), crLive), "💥", COL.cr, sparkBox("sp_cr", sCr, COL.cr, crLive), (crLive ? "" : "No crash data"), crLive ? "Crash count." : (isAndroid ? "No crashes reported by Google Play in this window." : PEND_TIP)) +
      // ---- Android-only engagement & quality tiles (Play Console statistics) ----
      (isAndroid ? (
        mcard("Daily Active Users", hasDau ? fmtInt(Math.round(avgDau)) : "--", "🏃", "#0ea89a", sparkBox("sp_dau", sDau, "#0ea89a", hasDau), "avg / day",
          "Daily Active Users — average unique users active per day over the selected window. Source: Play Console.")
        + mcard("Stickiness", hasStick ? (Math.round(avgStick * 10) / 10) + "%" : "--", "🧲", "#8a74f4", sparkBox("sp_stk", sDmau, "#8a74f4", hasStick), "DAU ÷ MAU",
          "DAU/MAU — the share of monthly users who open the app on an average day. Higher = more habitual use.")
        + mcard("Store Acquisitions", fmtInt(totSac), "🛒", "#22c55e", sparkBox("sp_sac", sSac, "#22c55e", true), "installs via listing",
          "Store-listing acquisitions — new users who installed after visiting your Google Play listing.")
        + mcard("Returning Users", fmtInt(totRet), "🔄", "#3b82f6", sparkBox("sp_ret", sRet, "#3b82f6", true), "re-engaged",
          "Users who came back and re-engaged in this window (Play Console: User acquisition → Returning users).")
        + mcard("Uninstalls", fmtInt(totUls), "🗑️", "#ef4444", sparkBox("sp_uls", sUls, "#ef4444", true), "user loss",
          "Users lost / uninstalls in this window (Play Console: User loss).")
        + mcard("ANRs", fmtInt(totAnr), "⚠️", "#f5883f", sparkBox("sp_anr", sAnr, "#f5883f", totAnr > 0), (totAnr ? "" : "none"),
          "App Not Responding events in this window (Play Console vitals) — the UI froze. Lower is better.")
      ) : "");
    _sparks.forEach(function (s) { drawSpark(s[0], s[1], s[2]); });

    // Platform-aware source note.
    var srcNote = el("appstoreSource");
    if (srcNote) {
      srcNote.innerHTML = isAndroid
        ? 'Source: <b>Google Play</b> (Play Console statistics). Installs (by user &amp; device), active devices, impressions, store-listing acquisitions, DAU, stickiness, returning users, uninstalls, crashes &amp; ANRs by day. Some series are backfilled from Console CSV exports while Google\'s automated bulk export is delayed.'
        : 'Source: <b>App Store Connect API</b> (Sales &amp; Trends + App Analytics). Apple data has a 1&ndash;3 day reporting lag. <b>Conversion</b> = first-time downloads &divide; impressions (App Store Connect\'s Conversion Rate). <b>Active Devices</b> is estimated from the Sessions report. <b>Crashes</b> come from App Analytics.';
    }

    var pendNote = el("appstorePending");
    if (pendNote) {
      if (live && (!impLive || !pvLive) && asPlatform !== "android") {
        pendNote.innerHTML = "⏳ <b>Some App Analytics metrics are still landing.</b> Impressions, Product Page Views and Conversion Rate come from Apple's App Analytics feed (usually 24–48h after setup) and show <b>—</b> until they arrive, then fill in automatically. First-Time Downloads, Redownloads and Sessions are live now.";
        pendNote.classList.remove("hidden");
      } else {
        pendNote.classList.add("hidden");
      }
    }

    // Show/hide a chart card (Apple-only charts are hidden on the Android tab).
    var showCard = function (cid, on) { var c = el(cid); if (c) { var card = c.closest(".chartcard"); if (card) card.style.display = on ? "" : "none"; } };
    showCard("asImpressionsChart", !isAndroid);   // impressions are Apple-only
    showCard("asSessionsChart", !isAndroid);       // sessions are Apple-only
    showCard("asConversionChart", true);           // both (iOS ÷ impressions, Android ÷ store views)

    asLineChart("asDownloadsChart", dates, [
      { label: isAndroid ? "Installs" : "Downloads", data: sDl, color: AS_TEAL, fill: true }
    ].concat(isAndroid ? [] : [{ label: "Redownloads", data: sRe, color: AS_BLUE }]));
    if (!isAndroid) {
      asLineChart("asImpressionsChart", dates, [
        { label: "Impressions", data: sImp, color: AS_BLUE, fill: true },
        { label: "Page views", data: sPv, color: AS_PURPLE, axis: "y2" }
      ], { y2: true });
      asLineChart("asSessionsChart", dates, [
        { label: "Sessions", data: sSes, color: AS_TEAL, fill: true },
        { label: "Active devices", data: sAct, color: AS_BLUE, axis: "y2" }
      ], { y2: true });
    }
    // Conversion: iOS = downloads ÷ impressions; Android = installs ÷ store views.
    var convDen = isAndroid ? pv : imp;
    var convSeries = dates.map(function (d) { return (convDen[d] ? (dl[d] || 0) / convDen[d] : 0) * 100; });
    asLineChart("asConversionChart", dates, [{ label: "Conversion %", data: convSeries, color: "#2e7d32", fill: true }], { pct: true });

    asLineChart("asCrashChart", dates, [{ label: "Crashes", data: sCr, color: AS_RED, fill: true }]);

    // Top territories by downloads over the window
    var inWin = {}; dates.forEach(function (d) { inWin[d] = 1; });
    var terr = {};
    rows.forEach(function (r) {
      if ((r.metric || "") === "downloads" && inWin[r.date] && r.territory && r.territory !== "WW") {
        terr[r.territory] = (terr[r.territory] || 0) + num(r.value);
      }
    });
    var tArr = Object.keys(terr).map(function (k) { return { code: k, v: terr[k] }; }).sort(function (a, b) { return b.v - a.v; });
    var maxT = tArr.length ? tArr[0].v : 0;
    var totalT = tArr.reduce(function (s, t) { return s + t.v; }, 0);
    var nameOf = {}; AS_TERRITORIES.forEach(function (t) { nameOf[t.code] = t.name; });
    // Names may already include a flag emoji — strip it (we render the flag separately).
    var tName = function (code) { return (nameOf[code] || code).replace(/^[\u{1F1E6}-\u{1F1FF}]{2}\s*/u, ""); };
    var shareOf = function (v) { return totalT ? Math.round(v / totalT * 1000) / 10 : 0; };
    if (!tArr.length) { el("asTerritories").innerHTML = '<div class="muted">No territory data.</div>'; return; }
    var top = tArr[0], count = tArr.length, avgShare = Math.round(1000 / count) / 10;

    var kpis =
      statCard("Total Downloads", fmtInt(totalT), "across territories", "var(--muted)", "⬇️", "#7b61ff") +
      statCard("Top Territory", fmtInt(top.v), tName(top.code) + " · " + shareOf(top.v) + "%", "#22a565", "📈", "#22a565") +
      statCard("Territories", count, "countries", "var(--muted)", "🌐", "#2f6df6") +
      statCard("Avg Share", avgShare + "%", "per territory", "var(--muted)", "🥧", "#f5883f");

    var listRows = tArr.slice(0, 10).map(function (t, i) {
      var w = maxT ? Math.round(t.v / maxT * 100) : 0;
      return '<div class="trow"><span class="trank">' + (i + 1) + '</span><span class="tflag">' + flagEmoji(t.code) + '</span>' +
        '<span class="tname">' + esc(tName(t.code)) + '</span>' +
        '<span class="tbar"><span style="width:' + Math.max(3, w) + '%"></span></span>' +
        '<span class="tdl">' + fmtInt(t.v) + '</span><span class="tshare">' + shareOf(t.v) + '%</span></div>';
    }).join("");

    var dc = ["#6c5ce7", "#2f6df6", "#0ea89a", "#f5a623", "#9aa7b4"];
    var top4 = tArr.slice(0, 4), othersV = tArr.slice(4).reduce(function (s, t) { return s + t.v; }, 0);
    var segs = top4.map(function (t, i) { var sh = totalT ? t.v / totalT * 100 : 0; return '<span class="dseg" style="width:' + sh + '%;background:' + dc[i] + '">' + (sh > 7 ? shareOf(t.v) + '%' : '') + '</span>'; }).join("");
    if (othersV > 0) segs += '<span class="dseg" style="width:' + (othersV / totalT * 100) + '%;background:' + dc[4] + '"></span>';
    var legend = top4.map(function (t, i) { return '<span class="dleg"><i style="background:' + dc[i] + '"></i>' + esc(tName(t.code)) + ' (' + shareOf(t.v) + '%)</span>'; }).join("");
    if (othersV > 0) legend += '<span class="dleg"><i style="background:' + dc[4] + '"></i>Others (' + shareOf(othersV) + '%)</span>';

    el("asTerritories").innerHTML =
      '<div class="terrkpis">' + kpis + '</div>' +
      '<div class="terrpanel"><div class="terrpanel-h">Downloads by Territory <span>· ' + asRangeLabel() + '</span></div><div class="terrlist">' + listRows + '</div></div>' +
      '<div class="terrpanel"><div class="terrpanel-h">Download Distribution</div><div class="dbar">' + segs + '</div><div class="dlegend">' + legend + '</div></div>';
  }
  function flagEmoji(code) {
    if (!/^[A-Za-z]{2}$/.test(code)) return "🏳️";
    return code.toUpperCase().replace(/./g, function (c) { return String.fromCodePoint(127397 + c.charCodeAt(0)); });
  }

  function exportAppStore() {
    var live = (data.appstore && data.appstore.length);
    var allRows = live ? data.appstore : sampleAppStore();
    var rows = asPlatform === "all" ? allRows : allRows.filter(function (r) { return (r.platform || "ios") === asPlatform; });
    var dates = {}; asWindowDates(rows).forEach(function (d) { dates[d] = 1; });
    var out = rows.filter(function (r) { return dates[r.date]; });
    var tag = (asPlatform === "all" ? "" : asPlatform + "-") + ((asCustom && asFrom && asTo) ? (asFrom + "_" + asTo) : (asRange + "d"));
    downloadCSV("dallal-appanalytics-" + tag + "-" + csvStamp() + ".csv", toCSV(out, [
      { key: "date", label: "Date" }, { key: "metric", label: "Metric" }, { key: "value", label: "Value" },
      { key: "territory", label: "Territory" }, { key: "platform", label: "Platform" }, { key: "app_version", label: "App Version" }
    ]));
  }

  // Paginate: PostgREST caps each response at ~1000 rows regardless of .limit(),
  // so fetch in 1000-row pages until a short page — otherwise larger tables
  // (fact_appstore_metrics, fact_trends…) load an arbitrary truncated slice.
  function sbSelect(table) {
    var PAGE = 1000, all = [];
    function page(from) {
      return sbc.from(table).select("*").range(from, from + PAGE - 1).then(function (r) {
        if (r.error) {
          // A later page past the end (e.g. 416 when the row count is a multiple of
          // PAGE) just means we're done — only a first-page error is a real failure.
          if (from > 0) return all;
          throw new Error(table + ": " + r.error.message);
        }
        var got = r.data || [];
        all = all.concat(got);
        return got.length === PAGE ? page(from + PAGE) : all;
      });
    }
    return page(0);
  }

  // Fast 32-bit FNV-1a hash — a cheap signature of the fetched data so background
  // refreshes can tell whether anything actually changed before repainting.
  var _dataSig = null;
  function hashStr(s) {
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
    return h >>> 0;
  }
  // Volatile bookkeeping columns that change without affecting anything on screen
  // (the ETLs / Asana webhook bump these constantly). Excluding them means a pure
  // modified_at touch no longer counts as "new data" and won't trigger a repaint.
  var _SIG_SKIP = { modified_at: 1, updated_at: 1, synced_at: 1, last_synced: 1,
                    last_synced_at: 1, inserted_at: 1, ingested_at: 1, _synced_at: 1 };
  // Order-independent signature: sum per-row hashes (so re-inserted rows in a new
  // order don't read as a change) over stable, meaningful fields only.
  function dataSig(res) {
    var acc = 0;
    for (var t = 0; t < res.length; t++) {
      var arr = res[t] || [], tableAcc = 0;
      for (var i = 0; i < arr.length; i++) {
        var row = arr[i] || {}, keys = Object.keys(row).sort(), parts = "";
        for (var k = 0; k < keys.length; k++) {
          if (_SIG_SKIP[keys[k]]) continue;
          parts += keys[k] + "=" + row[keys[k]] + "\x1f";
        }
        tableAcc = (tableAcc + hashStr(parts)) >>> 0;   // sum => order-independent
      }
      acc = (acc ^ hashStr(t + ":" + arr.length + ":" + tableAcc)) >>> 0;
    }
    return acc >>> 0;
  }

  // force=true (manual Refresh button) always repaints. Background callers
  // (60s poll / Supabase Realtime / tab focus) pass nothing: they fetch quietly
  // and only re-render when the data signature changed — no flicker otherwise.
  function loadAll(force) {
    hide("error");
    return Promise.all([
      sbSelect("fact_workitems"),
      sbSelect("dim_sprint"),
      sbSelect("fact_flow").catch(function () { return []; }),
      sbSelect("risks").catch(function () { return []; }),
      sbSelect("fact_burndown").catch(function () { return []; }),
      sbSelect("fact_repo_health").catch(function () { return []; }),
      sbSelect("fact_vulns").catch(function () { return []; }),
      sbSelect("fact_funnels").catch(function () { return []; }),
      sbSelect("fact_paths").catch(function () { return []; }),
      sbSelect("fact_unreviewed_prs").catch(function () { return []; }),
      sbSelect("fact_abandoned_listers").catch(function () { return []; }),
      sbSelect("fact_reengagement_log").catch(function () { return []; }),
      Promise.resolve([]),  // Production API tab removed
      Promise.resolve([]),
      sbSelect("fact_retro").catch(function () { return []; }),
      sbSelect("fact_appstore_metrics").catch(function () { return []; }),
      sbSelect("fact_trends").catch(function () { return []; }),
      sbSelect("fact_due_changes").catch(function () { return []; }),
      sbSelect("fact_uat_moves").catch(function () { return []; }),
      sbSelect("fact_reopens").catch(function () { return []; }),
    ]).then(function (res) {
      var _preY = window.scrollY;   // preserve scroll across background repaints
      // Skip the repaint entirely when a background refresh brought no meaningful
      // new data (volatile timestamps and row re-ordering are ignored by dataSig).
      var sig = dataSig(res);
      revealContent();   // data is in — drop the first-load skeleton no matter which branch we take
      if (!force && loadedOnce && sig === _dataSig) return;
      _dataSig = sig;
      data.items = res[0]; data.sprints = res[1]; data.flow = res[2]; data.risks = res[3];
      data.burndown = res[4]; data.repos = res[5]; data.vulns = res[6]; data.funnels = res[7]; data.paths = res[8];
      data.unreviewedPrs = res[9]; data.abandoned = res[10]; data.reengage = res[11];
      data.apiEndpoints = res[12]; data.apiRequests = res[13]; data.retro = res[14]; data.appstore = res[15];
      data.trends = res[16]; data.dueChanges = res[17]; data.uatMoves = res[18]; data.reopens = res[19];
      // Accurate reopen counts (Reopen-column moves merged with the manual field),
      // keyed by task — used everywhere instead of the unreliable reopened_count.
      _reopenMap = {};
      (data.reopens || []).forEach(function (r) { _reopenMap[r.task_gid] = num(r.reopen_count); });
      loadedOnce = true;
      var def = populateSprintSelect();
      var anySample = data.items.some(function (i) { return String(i.story_points_is_sample) === "1"; });
      if (anySample) { el("sampleFlag").textContent = "Showing SAMPLE story points (Asana Story Points not yet populated). All other metrics are live."; show("sampleFlag"); }
      else hide("sampleFlag");
      el("updated").textContent = "Updated " + new Date().toLocaleString();
      render(def);
      if (!el("engView").classList.contains("hidden")) renderEng();
      if (!el("funnelView").classList.contains("hidden")) renderFunnels();
      if (!el("marketingView").classList.contains("hidden")) renderMarketing();
      if (!el("appstoreView").classList.contains("hidden")) renderAppStore();
      // Background updates (poll / realtime) must not move the user; only an explicit
      // Refresh or a fresh page load jumps to the top.
      if (!force) { try { window.scrollTo(0, _preY); } catch (e) {} }
      revealContent();
    }).catch(function (e) {
      revealContent();
      el("error").textContent = "Could not load data: " + e.message +
        "  -  ensure web_read_policies.sql is applied and your account can read.";
      show("error");
    });
  }

  function loadSample() {
    hide("booting"); show("app"); show("topbar");
    var s = window.DALLAL_SAMPLE;
    data.items = s.items || []; data.sprints = s.sprints || []; data.flow = s.flow || []; data.risks = s.risks || [];
    data.burndown = s.burndown || []; data.repos = s.repos || []; data.vulns = s.vulns || [];
    var def = populateSprintSelect();
    el("sampleFlag").textContent = "OFFLINE PREVIEW - bundled sample data (story points estimated). Configure Supabase in config.js for live, login-protected data.";
    show("sampleFlag"); el("updated").textContent = "Sample preview"; render(def); revealContent();
  }

  // ---------- auth ----------
  // NOTE: no scrollTo here — Supabase fires an auth event (token refresh) every time
  // the tab regains focus, which calls this; scrolling here would jump the user to the
  // top on every tab switch. Reloads start at top via history.scrollRestoration=manual.
  var _skelTimer = null;
  function showAppUI() {
    hide("booting"); hide("login"); show("app"); show("signOut"); show("topbar");
    // First load: show a skeleton over the content until the first data render lands,
    // so the user never sees the empty section shells / half-drawn charts. A hard
    // fallback reveals the content anyway if the data load is slow or a query stalls,
    // so the skeleton can never get stuck ("refresh never completes").
    if (!loadedOnce) {
      if (el("loadSkeleton")) show("loadSkeleton");
      if (el("sprintView")) hide("sprintView");
      clearTimeout(_skelTimer);
      _skelTimer = setTimeout(revealContent, 9000);
    }
  }
  // Reveal the real content and drop the skeleton (called once the first render is done,
  // on error, or by the fallback timer).
  function revealContent() {
    clearTimeout(_skelTimer);
    if (el("loadSkeleton")) hide("loadSkeleton");
    if (el("sprintView")) show("sprintView");
  }
  function showLoginUI() { hide("booting"); show("login"); hide("app"); hide("signOut"); hide("topbar"); }

  // A clean, fragment-free redirect target. Using window.location.href would
  // carry a stale '#...' (e.g. from the href="#" password toggle or a previous
  // OAuth round-trip) into redirectTo, so the provider returns '##access_token='
  // which supabase-js cannot parse — the login then loops forever.
  function cleanRedirectURL() { return window.location.origin + window.location.pathname; }

  function onAuth(session) {
    if (session) {
      // Session established — strip auth tokens from the address bar so they
      // don't linger in history and can't be recycled into a later redirectTo.
      if (window.location.hash && window.location.hash.indexOf("access_token") !== -1) {
        try { history.replaceState(null, "", window.location.pathname + window.location.search); } catch (e) {}
      }
      showAppUI();
      // Defer out of the onAuthStateChange callback: calling Supabase queries
      // synchronously inside it can deadlock on the auth lock (queries never
      // resolve -> logged in but no data). setTimeout(0) breaks out of it.
      if (!loadedOnce) { loadedOnce = true; setTimeout(loadAll, 0); }
    } else { loadedOnce = false; showLoginUI(); }
  }

  function loginError(msg) { el("loginErr").textContent = msg; show("loginErr"); }

  function doMagicLink() {
    hide("loginErr"); hide("loginInfo");
    var email = el("loginEmail").value.trim();
    if (!email) { loginError("Enter your work email first."); return; }
    el("magicBtn").disabled = true;
    // emailRedirectTo must be in Supabase > Auth > URL Configuration > Redirect URLs
    sbc.auth.signInWithOtp({ email: email, options: { emailRedirectTo: cleanRedirectURL() } })
      .then(function (r) {
        el("magicBtn").disabled = false;
        if (r.error) { loginError(r.error.message); return; }
        el("loginInfo").textContent = "Check " + email + " for a sign-in link. You can close this tab and click the link.";
        show("loginInfo");
      });
  }

  function doGoogle() {
    hide("loginErr");
    // Requires the Google provider enabled in Supabase > Auth > Providers.
    sbc.auth.signInWithOAuth({ provider: "google", options: { redirectTo: cleanRedirectURL() } })
      .then(function (r) { if (r.error) loginError(r.error.message); });
    // On success the browser redirects to Google and back; supabase-js
    // (detectSessionInUrl) restores the session and onAuthStateChange fires.
  }

  function doLogin() {
    hide("loginErr");
    var email = el("loginEmail").value.trim(), pass = el("loginPass").value;
    if (!email || !pass) { loginError("Enter email and password."); return; }
    el("loginBtn").disabled = true;
    sbc.auth.signInWithPassword({ email: email, password: pass }).then(function (r) {
      el("loginBtn").disabled = false;
      if (r.error) { loginError(r.error.message); return; }
      onAuth(r.data && r.data.session);   // trigger load directly (also fired by onAuthStateChange; guarded)
    });
  }

  function init() {
    if (window.Chart) { Chart.defaults.maintainAspectRatio = false; Chart.defaults.responsive = true; }
    el("sprintSel").addEventListener("change", function () {
      selectedSprint = this.value; try { localStorage.setItem("dallal_sprint", selectedSprint); } catch (e) {}
      render(this.value);
    });
    // Ready-for-UAT filters (developer + date-added range) — both as searchable-style combos.
    (function () {
      try { if ("scrollRestoration" in history) history.scrollRestoration = "manual"; } catch (e) {}  // reload starts at top
      function reUat() { renderReadyForUAT(_uatSprint != null ? _uatSprint : el("sprintSel").value); }
      try {   // restore persisted filter state
        var r = localStorage.getItem("dallal_uat_range"); if (r) _uatRange = r;
        var f = localStorage.getItem("dallal_uat_from"); if (f && el("uatFrom")) el("uatFrom").value = f;
        var t = localStorage.getItem("dallal_uat_to"); if (t && el("uatTo")) el("uatTo").value = t;
        var d = localStorage.getItem("dallal_uat_dev"); if (d) _uatDev = d;
        var tb = localStorage.getItem("dallal_uat_tab"); if (tb === "sent" || tb === "current") _uatTab = tb;
      } catch (e) {}
      uatSyncRangeUI();
      updateUatTabUI();
      // Ready-for-UAT sub-tab toggle (Currently in UAT ↔ Sent to UAT throughput).
      var devBtnRef = el("uatDevBtn");
      function switchUatTab(tab) {
        if (tab !== "current" && tab !== "sent") return;
        _uatTab = tab;
        try { localStorage.setItem("dallal_uat_tab", tab); } catch (e2) {}
        // The dev list source differs per tab; drop a now-invalid selection and relabel.
        uatPopulateDevs();
        if (devBtnRef) devBtnRef.textContent = uatDevLabel();
        renderUatDevList("");
        reUat();
      }
      if (el("uatTabCurrent")) el("uatTabCurrent").addEventListener("click", function () { switchUatTab("current"); });
      if (el("uatTabSent")) el("uatTabSent").addEventListener("click", function () { switchUatTab("sent"); });
      // Generic combo open/close (click button to toggle, click outside to close).
      var comboClosers = [];   // so only ONE combo is open at a time
      function bindCombo(comboId, popId, btnId, onOpen) {
        var combo = el(comboId), pop = el(popId), btn = el(btnId);
        var sect = combo && combo.closest ? combo.closest(".section") : null;
        function close() { if (pop) pop.classList.add("hidden"); if (btn) btn.setAttribute("aria-expanded", "false"); if (sect) sect.classList.remove("combo-open"); }
        function open() {
          comboClosers.forEach(function (c) { if (c !== close) c(); });   // close the others first
          if (!pop) return; if (onOpen) onOpen(); pop.classList.remove("hidden"); if (btn) btn.setAttribute("aria-expanded", "true");
          if (sect) sect.classList.add("combo-open");   // lift the whole section above later sections
        }
        comboClosers.push(close);
        if (btn) btn.addEventListener("click", function (e) { e.stopPropagation(); (pop && pop.classList.contains("hidden")) ? open() : close(); });
        document.addEventListener("click", function (e) { if (combo && !combo.contains(e.target)) close(); });
        return { close: close };
      }
      // Developer combo (with search box).
      var devSearch = el("uatDevSearch"), devList = el("uatDevList"), devBtn = el("uatDevBtn");
      var devCombo = bindCombo("uatDevCombo", "uatDevPop", "uatDevBtn", function () { if (devSearch) devSearch.value = ""; renderUatDevList(""); if (devSearch) setTimeout(function () { devSearch.focus(); }, 0); });
      if (devSearch) { devSearch.addEventListener("input", function () { renderUatDevList(this.value); }); devSearch.addEventListener("click", function (e) { e.stopPropagation(); }); }
      if (devList) devList.addEventListener("click", function (e) {
        var opt = e.target && e.target.closest ? e.target.closest(".combo-opt") : null; if (!opt) return;
        _uatDev = opt.getAttribute("data-v") || "all";
        try { localStorage.setItem("dallal_uat_dev", _uatDev); } catch (e2) {}
        if (devBtn) devBtn.textContent = uatDevLabel();
        devCombo.close(); reUat();
      });
      // Date-range combo (no search box; same style).
      var rangeList = el("uatRangeList");
      var rangeCombo = bindCombo("uatRangeCombo", "uatRangePop", "uatRangeBtn", function () { renderUatRangeList(); });
      if (rangeList) rangeList.addEventListener("click", function (e) {
        var opt = e.target && e.target.closest ? e.target.closest(".combo-opt") : null; if (!opt) return;
        _uatRange = opt.getAttribute("data-v") || "all";
        try { localStorage.setItem("dallal_uat_range", _uatRange); } catch (e2) {}
        uatSyncRangeUI(); rangeCombo.close(); reUat();
      });
      // Custom date inputs.
      function saveDates() { try { localStorage.setItem("dallal_uat_from", (el("uatFrom") && el("uatFrom").value) || ""); localStorage.setItem("dallal_uat_to", (el("uatTo") && el("uatTo").value) || ""); } catch (e) {} }
      if (el("uatFrom")) el("uatFrom").addEventListener("change", function () { saveDates(); reUat(); });
      if (el("uatTo")) el("uatTo").addEventListener("change", function () { saveDates(); reUat(); });
    })();
    el("tabDelivery").addEventListener("click", function () { showTab("delivery"); });
    el("tabEng").addEventListener("click", function () { showTab("eng"); });
    el("tabFunnels").addEventListener("click", function () { showTab("funnels"); });
    el("tabMarketing").addEventListener("click", function () { showTab("marketing"); });
    el("tabFlow").addEventListener("click", function () { showTab("flow"); });
    el("tabCrm").addEventListener("click", function () { showTab("crm"); });
    el("tabJourney").addEventListener("click", function () { showTab("journey"); });
    el("tabAppStore").addEventListener("click", function () { showTab("appstore"); });
    el("tabUserFlow").addEventListener("click", function () { showTab("userflow"); });
    el("tabPlatIos").addEventListener("click", function () { asPlatform = "ios"; renderAppStore(); });
    el("tabPlatAndroid").addEventListener("click", function () { asPlatform = "android"; renderAppStore(); });
    var _exAs = el("exportAppStore"); if (_exAs) _exAs.addEventListener("click", exportAppStore);
    // Keep info-icon tooltips inside the viewport: shift horizontally when a tip is
    // near the screen edge (the tooltip is centered on the icon and would clip otherwise).
    document.addEventListener("mouseover", function (e) {
      var t = e.target;
      if (!t || !t.classList || !t.classList.contains("tip")) return;
      var r = t.getBoundingClientRect(), vw = window.innerWidth || document.documentElement.clientWidth;
      var half = Math.min(300, vw * 0.8) / 2, m = 10, cx = r.left + r.width / 2, dx = 0;
      if (cx + half > vw - m) dx = (vw - m) - (cx + half);
      else if (cx - half < m) dx = m - (cx - half);
      t.style.setProperty("--tipdx", Math.round(dx) + "px");
    });
    var _exApi = el("exportApi"); if (_exApi) _exApi.addEventListener("click", exportApi);
    (function () {
      var epc = el("apiEndpoints");
      if (!epc) return;
      epc.addEventListener("click", function (ev) {
        var row = ev.target && ev.target.closest ? ev.target.closest(".aprow") : null;
        if (!row || !epc.contains(row)) return;
        var i = row.getAttribute("data-i");
        var det = epc.querySelector('.apdet[data-i="' + i + '"]');
        if (det) {
          det.classList.toggle("hidden");
          var ind = row.querySelector(".epind");
          if (ind) ind.innerHTML = det.classList.contains("hidden") ? "&#9656;" : "&#9662;";
        }
      });
    })();
    window.addEventListener("message", function (ev) {
      if (ev && ev.data && typeof ev.data.flowHeight === "number") {
        var f = el("flowFrame"); if (f) f.style.height = (ev.data.flowHeight + 4) + "px";
      }
      if (ev && ev.data && typeof ev.data.journeyHeight === "number") {
        var j = el("journeyFrame"); if (j) j.style.height = (ev.data.journeyHeight + 4) + "px";
      }
    });
    el("exportRepoHealth").addEventListener("click", exportRepoHealth);
    el("exportVulns").addEventListener("click", exportVulns);
    el("exportEngRisks").addEventListener("click", exportEngRisks);
    el("funnelEnv").addEventListener("change", function () { try { localStorage.setItem("dallal_funnel_env", this.value); } catch (e) {} renderFunnels(); });
    el("funnelPlatform").addEventListener("change", function () { try { localStorage.setItem("dallal_funnel_platform", this.value); } catch (e) {} renderFunnels(); });
    el("refreshBtn").addEventListener("click", function () {
      if (!(sbc && loadedOnce)) return;
      try { window.scrollTo(0, 0); } catch (e) {}   // refresh returns to the top
      var b = el("refreshBtn"), txt = b.innerHTML; b.disabled = true; b.innerHTML = "↻ Refreshing…";
      Promise.resolve(loadAll(true)).then(function () {}).catch(function () {}).then(function () {
        b.disabled = false; b.innerHTML = txt;
      });
    });
    // LIVE updates: subscribe to Supabase Realtime — the dashboard re-pulls the
    // instant any Delivery table changes (no waiting, no manual refresh). A short
    // debounce batches bursts. Falls back to a 60s poll if Realtime is unavailable.
    var _reloadT = null;
    function liveReload() { if (!(sbc && loadedOnce) || document.hidden) return; clearTimeout(_reloadT); _reloadT = setTimeout(loadAll, 1200); }
    function subscribeRealtime() {
      if (!sbc || !sbc.channel) return;
      try {
        var ch = sbc.channel("delivery-live");
        ["fact_workitems", "fact_burndown", "dim_sprint", "fact_appstore_metrics", "fact_due_changes", "fact_uat_moves", "fact_reopens"].forEach(function (t) {
          ch.on("postgres_changes", { event: "*", schema: "public", table: t }, liveReload);
        });
        ch.subscribe();
      } catch (e) {}
    }
    setInterval(function () { if (sbc && loadedOnce && !document.hidden) loadAll(); }, 60000);
    // (No reload on tab focus — returning from another tab keeps your scroll position;
    //  Realtime + the 60s poll keep data fresh without moving the page.)
    setTimeout(subscribeRealtime, 1500);
    el("googleBtn").addEventListener("click", doGoogle);
    el("magicBtn").addEventListener("click", function (e) { if (e && e.preventDefault) e.preventDefault(); doMagicLink(); });
    el("loginEmail").addEventListener("keydown", function (e) { if (e.key === "Enter") doMagicLink(); });
    el("loginBtn").addEventListener("click", doLogin);
    el("loginPass").addEventListener("keydown", function (e) { if (e.key === "Enter") doLogin(); });
    // "Use a password instead" reveals the password block.
    el("pwToggle").addEventListener("click", function (e) { e.preventDefault(); var pb = el("pwBlock"); if (pb) pb.classList.toggle("hidden"); var lp = el("loginPass"); if (lp && !pb.classList.contains("hidden")) lp.focus(); });
    el("signOut").addEventListener("click", function () { if (sbc) sbc.auth.signOut(); });
    // Optional legacy modal controls (guarded — the split login has no modal).
    var _cta = el("ctaLogin"); if (_cta) _cta.addEventListener("click", function () { show("loginModal"); var e = el("loginEmail"); if (e) e.focus(); });
    var _lc = el("loginClose"); if (_lc) _lc.addEventListener("click", function () { hide("loginModal"); });
    var _lm = el("loginModal"); if (_lm) _lm.addEventListener("click", function (ev) { if (ev.target === _lm) hide("loginModal"); });
    document.addEventListener("keydown", function (ev) { if (ev.key === "Escape") { var m = el("loginModal"); if (m) hide("loginModal"); } });
    // Remember collapsed/expanded state of story lists across re-renders.
    document.addEventListener("toggle", function (e) {
      var d = e.target; if (d && d.tagName === "DETAILS" && d.getAttribute("data-lb")) _collapse[d.getAttribute("data-lb")] = d.open;
    }, true);

    // Not configured -> offline sample preview (nothing sensitive to protect).
    if (!isConfigured()) {
      if (window.DALLAL_SAMPLE) { loadSample(); return; }
      hide("booting"); show("app"); el("error").textContent = "Supabase not configured. Fill web/config.js."; show("error"); return;
    }
    if (!window.supabase) { hide("booting"); show("app"); el("error").textContent = "Auth library failed to load (check network/CDN)."; show("error"); return; }

    // Repair a malformed auth fragment BEFORE the client parses it. A stale
    // redirect can accumulate hashes ('##access_token=' or two token bundles);
    // keep only the last (freshest) bundle so detectSessionInUrl can read it.
    try {
      var _h = window.location.hash || "";
      if (_h.indexOf("access_token") !== -1 && /#[^#]*#/.test(_h)) {
        var _last = _h.substring(_h.lastIndexOf("#") + 1);
        history.replaceState(null, "", window.location.pathname + window.location.search + "#" + _last);
      }
    } catch (e) {}

    // We finish the OAuth redirect OURSELVES (detectSessionInUrl:false) so there's
    // no race that clears the URL before the exchange — and we handle BOTH flows:
    // PKCE (?code=) and implicit (#access_token=).
    var _hadCode = /[?&]code=/.test(window.location.search);
    var _hadTok = (window.location.hash || "").indexOf("access_token=") !== -1;
    sbc = window.supabase.createClient(URL_, KEY_, {
      auth: { flowType: "pkce", detectSessionInUrl: false, persistSession: true, autoRefreshToken: true }
    });

    function finishRedirect() {
      if (_hadCode) {
        var _code = new URLSearchParams(window.location.search).get("code");
        return sbc.auth.exchangeCodeForSession(_code).then(function (res) {
          try { history.replaceState(null, "", window.location.pathname); } catch (e) {}
          return (res && res.data && res.data.session) || null;
        }).catch(function () { try { history.replaceState(null, "", window.location.pathname); } catch (e) {} return null; });
      }
      if (_hadTok) {
        var p = new URLSearchParams((window.location.hash || "").replace(/^#+/, ""));
        return sbc.auth.setSession({ access_token: p.get("access_token"), refresh_token: p.get("refresh_token") }).then(function (res) {
          try { history.replaceState(null, "", window.location.pathname); } catch (e) {}
          return (res && res.data && res.data.session) || null;
        }).catch(function () { try { history.replaceState(null, "", window.location.pathname); } catch (e) {} return null; });
      }
      return Promise.resolve(undefined);   // no redirect payload
    }

    if (!REQUIRE_AUTH) { showAppUI(); loadAll(); return; }   // intentional public mode
    sbc.auth.onAuthStateChange(function (_e, session) { if (session) onAuth(session); });
    finishRedirect().then(function (s) {
      if (s) { onAuth(s); return; }                          // fresh OAuth login
      if (s === null) { showLoginUI(); return; }             // redirect came back but failed
      sbc.auth.getSession().then(function (r) { onAuth(r.data.session); }).catch(function () { showLoginUI(); });
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
