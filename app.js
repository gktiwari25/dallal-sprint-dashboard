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
  var REQUIRE_AUTH = cfg.REQUIRE_AUTH !== false;

  var data = { items: [], sprints: [], flow: [], risks: [], burndown: [], repos: [], vulns: [], funnels: [] };
  var velChart, statusChart, burnChart, vulnChart, sbc = null, loadedOnce = false, selectedSprint = null, _collapse = {};

  // ---------- helpers ----------
  function num(v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; }
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
  // A ticket is a bug if its title contains "BUG" (team convention) or Type=Bug.
  function isBug(i) { return String(i.is_bug) === "1" || /\bbug/i.test(i.name || ""); }
  // The board SECTION (column) is the source of truth for where a ticket is — the
  // Status custom field is often left stale — so all stage counts use the section.
  function sectionStage(sec) {
    sec = sec || "";
    if (sec === "Blocked") return "blocked";
    if (/Released/i.test(sec)) return "released";
    if (/UAT Passed|Ready for Production/i.test(sec)) return "ready";
    if (/QA on Dev|Ready for UAT|In UAT/i.test(sec)) return "qa";
    if (/In Development|Code Review|Merged to Develop|Sub-tasks/i.test(sec)) return "dev";
    if (/Backlog|Ready for Development|Sprint Planned|Refinement|Design/i.test(sec)) return "planned";
    return "other";
  }
  // "Done" = in a Released / UAT-Passed column (board truth), or the Asana complete flag.
  function isDone(i) { var s = sectionStage(i.section); return s === "released" || s === "ready" || String(i.is_delivered) === "1"; }
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
  // Collapsible list block (native <details>) that remembers open/closed across re-renders.
  function listBlock(id, title, rowsHtml) {
    var open = _collapse[id] !== false; // default open
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
  function compute(sprint) {
    var its = data.items.filter(function (i) { return String(i.sprint) === String(sprint); });
    var dim = data.sprints.filter(function (s) { return String(s.sprint) === String(sprint); })[0] || {};
    var committedSP = its.reduce(function (a, i) { return a + num(i.story_points); }, 0);
    var delivered = its.filter(isDone);
    var deliveredSP = delivered.reduce(function (a, i) { return a + num(i.story_points); }, 0);
    var commitmentSP = num(dim.commitment_sp) || committedSP;
    var completed = delivered.length, planned = its.length;
    // Fallback: if no Story Points are set for this sprint, drive Sprint Health
    // off item counts instead of SP, and label the unit accordingly.
    var usePts = committedSP > 0;
    var hCommit = usePts ? committedSP : planned;
    var hDeliver = usePts ? deliveredSP : completed;
    var hCommitment = usePts ? commitmentSP : planned;
    var bugs = its.filter(isBug);
    function statusIn(list) { return its.filter(function (i) { return list.indexOf(i.status) !== -1; }).length; }
    var reopened = its.filter(function (i) { return num(i.reopened_count) > 0; }).length;

    var gids = {}; its.forEach(function (i) { gids[i.task_gid] = 1; });
    var fl = data.flow.filter(function (f) { return gids[f.task_gid]; });
    function avg(field) {
      var vals = fl.map(function (f) { return num(f[field]); }).filter(function (v) { return v > 0; });
      return vals.length ? vals.reduce(function (a, b) { return a + b; }, 0) / vals.length : null;
    }
    return {
      its: its, committedSP: committedSP, deliveredSP: deliveredSP,
      usePts: usePts, velocity: hDeliver, velocityUnit: usePts ? "SP" : "items",
      progress: hCommit ? hDeliver / hCommit : null,
      predictability: hCommitment ? hDeliver / hCommitment : null,
      carryFwd: hCommit ? (hCommit - hDeliver) / hCommit : null,
      planned: planned, completed: completed,
      inDev: its.filter(function (i) { return sectionStage(i.section) === "dev"; }).length,
      inQA: its.filter(function (i) { return sectionStage(i.section) === "qa"; }).length,
      blocked: its.filter(function (i) { return sectionStage(i.section) === "blocked"; }).length,
      ready: its.filter(function (i) { return sectionStage(i.section) === "ready"; }).length,
      bugs: bugs.length,
      pCritical: bugs.filter(function (i) { return (i.priority || "").indexOf("P1") === 0; }).length,
      pHigh: bugs.filter(function (i) { return (i.priority || "").indexOf("P2") === 0; }).length,
      pMedium: bugs.filter(function (i) { return (i.priority || "").indexOf("P3") === 0; }).length,
      regression: bugs.filter(function (i) { return num(i.reopened_count) > 0; }).length,
      reopenedPct: completed ? reopened / completed : null,
      defectEscape: bugs.length ? bugs.filter(function (i) { return i.found_in === "UAT" || i.found_in === "Prod"; }).length / bugs.length : null,
      devDays: avg("dev_days"), qaDays: avg("qa_days"), cycleDays: avg("cycle_days"),
      blockedHours: fl.length ? fl.reduce(function (a, f) { return a + num(f.blocked_hours); }, 0) : null,
      hasFlow: fl.length > 0,
    };
  }

  // ---------- render ----------
  function render(sprint) {
    var m = compute(sprint), rag = goalRag(m);
    var goalHex = { green: "#2e7d32", amber: "#f29f05", red: "#c62828" }[rag[0]] || "#0f8b8d";
    el("healthGrid").innerHTML =
      '<div class="gauges">' +
        gaugeTile("gProgress", "Sprint Progress", m.progress, goalHex) +
        gaugeTile("gPredict", "Predictability", m.predictability, "#1f6feb") +
        gaugeTile("gCarry", "Carry Forward", m.carryFwd, "#f29f05") +
      "</div>" +
      '<div class="grid">' +
        card("Velocity", m.velocity + ' <small>' + m.velocityUnit + "</small>", { icon: "⚡", accent: "#0f8b8d" }) +
        card("Sprint Goal", "", { rag: rag[0], ragText: rag[1], icon: "🎯" }) +
        card("Committed", (m.usePts ? Math.round(m.committedSP) + " SP" : m.planned + " items"), { icon: "📌", accent: "#163a5f" }) +
        card("Delivered", (m.usePts ? Math.round(m.deliveredSP) + " SP" : m.completed + " items"), { icon: "✅", accent: "#2e7d32" }) +
      "</div>";
    drawGauge("gProgress", m.progress, goalHex);
    drawGauge("gPredict", m.predictability, "#1f6feb");
    drawGauge("gCarry", m.carryFwd, "#f29f05");
    el("healthNote").textContent = m.usePts ? "" :
      "Story Points not set in Asana for this sprint — Sprint Health is showing item counts. It switches to SP automatically once tasks are estimated.";

    el("deliveryGrid").innerHTML =
      card("Stories Planned", m.planned, { icon: "📋", accent: "#163a5f" }) +
      card("In Development", m.inDev, { icon: "🛠️", accent: "#7b61ff", tip: "Stories in the 'In Development' / Code Review board column (based on the board section, not the stale Status field)." }) +
      card("In QA", m.inQA, { icon: "🧪", accent: "#1f6feb", tip: "Stories in a testing column: QA on Dev / Ready for UAT / In UAT." }) +
      card("Completed", m.completed, { icon: "✅", accent: "#2e7d32" }) +
      card("Blocked", m.blocked, { icon: "⛔", accent: "#c62828" }) +
      card("Ready for Release", m.ready, { icon: "🚀", accent: "#0f8b8d" });
    var openItems = m.its.filter(function (i) { return !isDone(i); });
    el("openList").innerHTML = listBlock("open", "Not yet completed &middot; " + openItems.length + " of " + m.planned + " stories",
      (openItems.length ? openItems.map(taskRow).join("") : '<div class="muted">All committed stories completed. 🎉</div>'));

    el("qualityGrid").innerHTML =
      card("Total Bugs", m.bugs, { icon: "🐞", accent: "#6b7a8d", tip: "Tickets in this sprint whose title contains \"BUG\" (or Type = Bug)." }) +
      card("Critical (P1)", m.pCritical, { icon: "🔴", accent: "#c62828", tip: "Bug tickets with task Priority = P1 Critical." }) +
      card("High (P2)", m.pHigh, { icon: "🟠", accent: "#f29f05", tip: "Bug tickets with task Priority = P2 High." }) +
      card("Reopened", pct(m.reopenedPct), { icon: "🔁", tip: "Share of completed items with Reopened Count > 0. Needs the 'Reopened Count' field filled in Asana." }) +
      card("Defect Escape", pct(m.defectEscape), { icon: "🪲", tip: "Share of bugs found in UAT or Prod (vs Dev). Needs the 'Found In' field filled in Asana." });
    mkChart("qualityChart", { type: "doughnut",
      data: { labels: ["Critical", "High", "Medium", "Other"],
        datasets: [{ data: [m.pCritical, m.pHigh, m.pMedium, Math.max(0, m.bugs - m.pCritical - m.pHigh - m.pMedium)],
          backgroundColor: ["#c62828", "#f29f05", "#1f6feb", "#9aa7b4"], borderWidth: 0 }] },
      options: { cutout: "60%", responsive: true, plugins: { legend: { position: "right", labels: { boxWidth: 12, font: { size: 11 } } } } } });
    var bugItems = m.its.filter(isBug);
    el("bugList").innerHTML = listBlock("bugs", "Bug tickets &middot; " + bugItems.length,
      (bugItems.length ? bugItems.map(taskRow).join("") : '<div class="muted">No bug tickets this sprint.</div>'));

    if (m.hasFlow) {
      el("flowGrid").innerHTML =
        card("Avg Dev Time", (m.devDays != null ? m.devDays.toFixed(1) : "--") + ' <small>days</small>',
          { icon: "🛠️", accent: "#163a5f", tip: "Average time a task spends being built — from entering 'In Development' to reaching the first testing stage (QA on Dev / Ready for UAT / In UAT). Derived from board section moves." }) +
        card("Avg QA Time", (m.qaDays != null ? m.qaDays.toFixed(1) : "--") + ' <small>days</small>',
          { icon: "🔍", accent: "#1f6feb", tip: "Average time in testing — from the first testing stage to Done (UAT Passed / Released, or task completion)." }) +
        card("Cycle Time", (m.cycleDays != null ? m.cycleDays.toFixed(1) : "--") + ' <small>days</small>',
          { icon: "🔄", accent: "#0f8b8d", tip: "Total active build + test time per task — from 'In Development' to Done. Lower is faster delivery." }) +
        card("Blocked Hours", (m.blockedHours != null ? m.blockedHours.toFixed(0) : "--"),
          { icon: "⛔", accent: "#c62828", tip: "Total hours tasks sat in the 'Blocked' board section this sprint. 0 means tasks weren't moved into Blocked (blocking tracked elsewhere)." });
      mkChart("flowChart", { type: "bar",
        data: { labels: ["Avg Dev", "Avg QA", "Cycle"],
          datasets: [{ data: [m.devDays || 0, m.qaDays || 0, m.cycleDays || 0],
            backgroundColor: ["#163a5f", "#1f6feb", "#0f8b8d"], borderRadius: 6, barThickness: 28 }] },
        options: { indexAxis: "y", responsive: true, plugins: { legend: { display: false } },
          scales: { x: { beginAtZero: true, title: { display: true, text: "days" } } } } });
    } else {
      el("flowGrid").innerHTML = '<div class="card"><div class="label">Flow metrics</div>' +
        '<div class="muted">No flow data yet. Run the sync with <code>--with-flow</code> to populate dev/QA/cycle time &amp; blocked hours.</div></div>';
      if (_charts.flowChart) { _charts.flowChart.destroy(); delete _charts.flowChart; }
    }
    renderRisks(sprint);
    renderCharts(sprint, m);
    renderBurndown(sprint, m);
    renderScopeCreep(sprint, m);
  }

  function renderScopeCreep(sprint, m) {
    var dim = data.sprints.filter(function (s) { return String(s.sprint) === String(sprint); })[0] || {};
    var start = dim.planned_start || dim.inferred_start;
    var end = dim.planned_end || dim.inferred_end;
    // Baseline = created on/before sprint start; Added = created after start (mid-sprint).
    // Measured by TICKET COUNT (always meaningful; many added tickets aren't estimated yet).
    var baseCount = 0, addCount = 0, baseSP = 0, addSP = 0;
    m.its.forEach(function (i) {
      var cd = (i.created_at || "").slice(0, 10), sp = num(i.story_points);
      if (start && cd && cd > start) { addCount++; addSP += sp; }
      else { baseCount++; baseSP += sp; }
    });
    var creepPct = baseCount > 0 ? addCount / baseCount : null;
    var creepTip = "Tickets added after the sprint start date (approximated by ticket creation date vs sprint start). High = lots of unplanned work entered the sprint.";
    el("scopeGrid").innerHTML =
      card("Baseline scope", baseCount + ' <small>tickets</small>', { icon: "📌", accent: "#163a5f", tip: "Tickets committed at sprint start (created on/before the start date). ≈ " + Math.round(baseSP) + " SP." }) +
      card("Added mid-sprint", "+" + addCount + ' <small>tickets</small>', { icon: "➕", accent: "#f29f05", tip: creepTip }) +
      card("Scope Creep", creepPct == null ? "--" : "+" + Math.round(creepPct * 100) + "%", { icon: "📈", accent: (creepPct && creepPct > 0.1) ? "#c62828" : "#2e7d32", tip: "Added tickets ÷ baseline tickets." }) +
      card("Added story points", "+" + Math.round(addSP) + ' <small>SP</small>', { icon: "🔢", tip: "Story points of the added tickets — 0 if they aren't estimated yet." });

    var addedItems = m.its.filter(function (i) { var cd = (i.created_at || "").slice(0, 10); return start && cd && cd > start; });
    el("scopeList").innerHTML = listBlock("scope", "Added mid-sprint &middot; " + addedItems.length + " stories",
      (addedItems.length ? addedItems.map(taskRow).join("") : '<div class="muted">No mid-sprint additions.</div>'));

    if (!start || !end) { if (_charts.scopeChart) { _charts.scopeChart.destroy(); delete _charts.scopeChart; } var c = el("scopeChart"); if (c) c.getContext("2d").clearRect(0, 0, c.width, c.height); return; }
    var days = isoDays(start, end);
    var cum = days.map(function (d) { var n = 0; m.its.forEach(function (i) { var cd = (i.created_at || "").slice(0, 10); if (cd && cd <= d) n++; }); return n; });
    var baseArr = days.map(function () { return baseCount; });
    mkChart("scopeChart", { type: "line",
      data: { labels: days.map(function (d) { return d.slice(5); }), datasets: [
        { label: "Total tickets", data: cum, borderColor: "#c62828", backgroundColor: "rgba(242,159,5,.18)", fill: 1, tension: .1, stepped: true },
        { label: "Baseline (at start)", data: baseArr, borderColor: "#6b7a8d", borderDash: [6, 4], pointRadius: 0, fill: false } ] },
      options: { plugins: { legend: { position: "bottom" } }, scales: { y: { beginAtZero: true, title: { display: true, text: "tickets" } } } } });
  }

  function isoDays(start, end) {
    var out = [], a = new Date(start + "T00:00:00Z"), b = new Date(end + "T00:00:00Z");
    if (isNaN(a.getTime()) || isNaN(b.getTime()) || b < a) return out;
    for (var d = a; d <= b; d = new Date(d.getTime() + 86400000)) out.push(d.toISOString().slice(0, 10));
    return out;
  }
  function renderBurndown(sprint, m) {
    var dim = data.sprints.filter(function (s) { return String(s.sprint) === String(sprint); })[0] || {};
    var start = dim.planned_start || dim.inferred_start;
    var end = dim.planned_end || dim.inferred_end;
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
        { label: "Remaining (actual)", data: actual, borderColor: "#c62828", backgroundColor: "rgba(198,40,40,.10)", fill: true, tension: .2, spanGaps: true },
        { label: "Ideal", data: ideal, borderColor: "#6b7a8d", borderDash: [6, 4], pointRadius: 0, fill: false } ] },
      options: { responsive: true, plugins: { legend: { position: "bottom" },
        tooltip: { callbacks: { title: function (t) { return "Day " + (t[0].dataIndex + 1) + " (" + t[0].label + ")"; } } } },
        scales: { y: { beginAtZero: true, title: { display: true, text: "story points" } } } },
    });
  }

  function renderRisks(sprint) {
    // Delivery Risks: curated current risks (not sprint-filtered — carryover risks
    // like the Map epic span sprints). Repo/security risks live on Engineering.
    var rs = data.risks.filter(function (r) { return !isEngRisk(r); });
    var counts = { red: 0, amber: 0, green: 0 };
    rs.forEach(function (r) { var k = (r.rag || "").toLowerCase(); if (counts[k] != null) counts[k]++; });
    el("riskCards").innerHTML =
      card("Red", '<span class="dot red"></span> ' + counts.red) +
      card("Amber", '<span class="dot amber"></span> ' + counts.amber) +
      card("Green", '<span class="dot green"></span> ' + counts.green);
    el("riskList").innerHTML = rs.map(riskCardHtml).join("") ||
      '<div class="muted">No delivery risks recorded for this sprint.</div>';
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
    if (velChart) velChart.destroy();
    velChart = new Chart(el("velChart"), {
      type: "bar",
      data: { labels: labels, datasets: [
        { label: "Delivered SP", data: sorted.map(function (s) { return num(s.delivered_sp); }), backgroundColor: "#0f8b8d" },
        { label: "Committed SP", data: sorted.map(function (s) { return num(s.committed_sp); }), type: "line", borderColor: "#1f6feb", backgroundColor: "transparent", tension: .3 } ] },
      options: { responsive: true, plugins: { legend: { position: "bottom" } }, scales: { y: { beginAtZero: true } } },
    });
    var mix = {}; m.its.forEach(function (i) { var s = i.section || "(none)"; mix[s] = (mix[s] || 0) + 1; });
    if (statusChart) statusChart.destroy();
    statusChart = new Chart(el("statusChart"), {
      type: "doughnut",
      data: { labels: Object.keys(mix), datasets: [{ data: Object.values(mix),
        backgroundColor: ["#0f8b8d", "#1f6feb", "#f29f05", "#c62828", "#2e7d32", "#6b7a8d", "#9c27b0", "#00897b", "#5d4037"] }] },
      options: { responsive: true, plugins: { legend: { position: "right", labels: { boxWidth: 12, font: { size: 10 } } } } },
    });
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
  function postureReason(r) {
    var out = [], c = r.open_critical, h = r.open_high;
    if (c === "" && h === "") out.push("vuln scan pending");
    else if (num(c) > 0 || num(h) > 0) out.push(num(c) + " Critical + " + num(h) + " High CVEs");
    var dep = String(r.dependabot_enabled) === "1", sec = String(r.secret_scanning_enabled) === "1";
    if (!dep && !sec) out.push("Dependabot & secret scanning off");
    else { if (!dep) out.push("Dependabot off"); if (!sec) out.push("secret scanning off"); }
    if (num(r.unreviewed_merges_30d) > 0) out.push(r.unreviewed_merges_30d + " unreviewed feature merges");
    if (r.ci_pass_rate_pct !== "" && num(r.ci_pass_rate_pct) < 50) out.push("CI pass rate " + r.ci_pass_rate_pct + "%");
    return out;
  }
  function flag(v) { return (String(v) === "1") ? '<span class="flag-ok">on</span>' : '<span class="flag-no">off</span>'; }
  function pctOr(v) { return (v == null || v === "") ? "--" : v + "%"; }

  function renderEng() {
    var repos = data.repos;
    el("repoCards").innerHTML = repos.map(function (r) {
      var reason = postureReason(r);
      return '<div class="repocard"><div class="rh"><span class="rn">' + esc(r.repo) + "</span>" +
        '<span class="rag ' + postureClass(r.posture) + '">' + esc(r.posture) + "</span></div>" +
        (reason.length ? '<div class="preason">Why ' + esc(r.posture) + ": " + reason.map(esc).join(" &middot; ") + "</div>" : "") +
        kv("PR review coverage", pctOr(r.review_coverage_pct), "Share of FEATURE PRs into dev merged with an approving review. Release-promotion PRs (dev→uat) are excluded. NB: this is code-review %, not test coverage.") +
        kv("Unreviewed feature merges", r.unreviewed_merges_30d, "Feature PRs merged into dev with no approving review. Promotion PRs (dev→uat) are NOT counted.") +
        kv("CI pass rate", pctOr(r.ci_pass_rate_pct), "Share of the last ~30 CI workflow runs that passed.") +
        kv("Open Critical / High", (r.open_critical || "?") + " / " + (r.open_high || "?"), "Open dependency vulnerabilities. Each is listed below with a link + the version to upgrade to.") +
        kv("Dependabot", flag(r.dependabot_enabled), "Auto-alerts for known-vulnerable dependencies. FREE on private repos — enable in repo Settings → Code security → Dependabot.") +
        kv("Secret scanning", flag(r.secret_scanning_enabled), "Detects API keys / tokens accidentally committed. Enable in Settings → Code security → Secret scanning.") +
        kv("Branch protection", flag(r.branch_protection), "Rules requiring review / passing CI before merging. For PRIVATE repos this needs GitHub Team/Pro.") + "</div>";
    }).join("") || '<div class="card muted">No repo data. Run etl_github.py.</div>';

    el("postureCards").innerHTML = repos.map(function (r) {
      return card(r.repo.replace("Dallal-", ""), "", { rag: postureClass(r.posture), ragText: r.posture });
    }).join("");

    // aggregate governance
    var cov = repos.map(function (r) { return num(r.review_coverage_pct); }).filter(function (v) { return v > 0; });
    var ci = repos.map(function (r) { return num(r.ci_pass_rate_pct); });
    var avg = function (a) { return a.length ? Math.round(a.reduce(function (x, y) { return x + y; }, 0) / a.length * 10) / 10 : null; };
    el("govCards").innerHTML =
      card("Unreviewed merges (30d)", repos.reduce(function (a, r) { return a + num(r.unreviewed_merges_30d); }, 0)) +
      card("Avg review coverage", pctOr(avg(cov))) +
      card("Avg CI pass rate", pctOr(avg(ci))) +
      card("Repos w/ branch protection", repos.filter(function (r) { return String(r.branch_protection) === "1"; }).length + " / " + repos.length) +
      card("Repos w/ secret scanning", repos.filter(function (r) { return String(r.secret_scanning_enabled) === "1"; }).length + " / " + repos.length);

    // vuln chart (stacked)
    var labels = repos.map(function (r) { return r.repo.replace("Dallal-", ""); });
    if (vulnChart) vulnChart.destroy();
    vulnChart = new Chart(el("vulnChart"), {
      type: "bar",
      data: { labels: labels, datasets: [
        { label: "Critical", data: repos.map(function (r) { return num(r.open_critical); }), backgroundColor: "#c62828" },
        { label: "High", data: repos.map(function (r) { return num(r.open_high); }), backgroundColor: "#f29f05" },
        { label: "Medium", data: repos.map(function (r) { return num(r.open_medium); }), backgroundColor: "#1f6feb" } ] },
      options: { responsive: true, plugins: { legend: { position: "bottom" } },
        scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } } },
    });

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
  }

  function showTab(which) {
    var isDel = which === "delivery", isEng = which === "eng", isFun = which === "funnels";
    el("sprintView").classList.toggle("hidden", !isDel);
    el("engView").classList.toggle("hidden", !isEng);
    el("funnelView").classList.toggle("hidden", !isFun);
    el("sprintSel").classList.toggle("hidden", !isDel);
    el("sprintLbl").classList.toggle("hidden", !isDel);
    el("tabDelivery").classList.toggle("active", isDel);
    el("tabEng").classList.toggle("active", isEng);
    el("tabFunnels").classList.toggle("active", isFun);
    if (isEng) renderEng();
    if (isFun) renderFunnels();
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
    var live = rowsFor(data.funnels, env, platform);
    var rows = live.length ? live : rowsFor(window.DALLAL_FUNNELS, env, platform);
    if (!rows.length) return [];
    var isLive = live.length > 0;
    var g = {};
    rows.forEach(function (r) { (g[r.funnel] = g[r.funnel] || []).push(r); });
    var src = "Amplitude · Dallal-" + env + (platform === "All" ? "" : " · " + (PLATFORM_LABEL[platform] || platform)) + (isLive ? " · live" : " · last 30d");
    return Object.keys(g).map(function (fn) {
      var steps = g[fn].slice().sort(function (a, b) { return num(a.step_index) - num(b.step_index); })
        .map(function (r) { return { name: r.step_name, users: num(r.users) }; });
      return { funnel: fn, source: src, steps: steps };
    });
  }
  var FUNNEL_INFO = {
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
    }
  };
  // Plain-language meaning of each step (covers UAT + PROD event names).
  var STEP_GLOSSARY = {
    "Listing Started": "Opened the create-listing flow.",
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

  function renderFunnels() {
    var env = populateFunnelEnv();
    var platform = populateFunnelPlatform(env);
    var fs = funnelsData(env, platform);
    var platLabel = PLATFORM_LABEL[platform] || platform;
    var envNote = env === "PROD"
      ? "<b>Dallal PRODUCTION</b> — real users, last 30 days."
      : "<b>Dallal UAT</b> (test environment), last 30 days. Volumes are low by design — read the <b>shape and drop-off points</b>, not the absolute counts.";
    var platNote = platform === "All"
      ? "All platforms combined."
      : "Filtered to <b>" + esc(platLabel) + "</b> (from the <code>platform</code> event property). For a single platform, Discovery starts at <b>View Details</b> — its Search step isn't platform-tagged.";
    var intro =
      '<div class="ftabhead">' +
        '<h3>User Funnel Analytics — how leadership should read this</h3>' +
        '<p>A <b>funnel</b> is a journey users take, one step at a time. The bars show <b>how many people reach each step</b>; the gap between two bars is <b>where we lose them</b>. We track three journeys:</p>' +
        '<ul class="ftablist">' +
          '<li><b>🏠 Listing Creation</b> — owners/agents publishing property → marketplace <i>supply</i>.</li>' +
          '<li><b>🔎 Property Discovery</b> — buyers searching → contacting agents → marketplace <i>demand</i>.</li>' +
          '<li><b>👤 User Registration</b> — new users signing up → account <i>growth</i>.</li>' +
        '</ul>' +
        '<p class="muted">Source: Amplitude · ' + envNote + ' ' + platNote +
        ' Switch <b>Environment</b> (UAT / PROD) and <b>Platform</b> (Web / Android / iOS) above to slice each funnel.</p>' +
      '</div>';

    if (!fs.length) {
      el("funnelList").innerHTML = intro + '<div class="finsight">No funnel data for <b>Dallal ' + esc(env) +
        '</b> · <b>' + esc(platLabel) + '</b> yet — either no events in the last 30 days, or this platform isn\'t instrumented for these steps.</div>';
      return;
    }
    el("funnelList").innerHTML = intro + fs.map(function (f) {
      var users = f.steps.map(function (s) { return s.users; });
      var top = users[0] || 0;
      var ins = funnelInsight(f);
      var info = FUNNEL_INFO[f.funnel] || { icon: "📈", tag: "", what: "", biz: "", lens: "" };
      var oc = ins.overall >= 40 ? "green" : ins.overall >= 15 ? "amber" : "red";
      var worstIdx = (function () { var b = 1, bd = -1; for (var k = 1; k < users.length; k++) { var d = users[k - 1] - users[k]; if (d > bd) { bd = d; b = k; } } return b; })();
      var bars = f.steps.map(function (s, i) {
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
      var read = "Of <b>" + ins.entered + "</b> who started, <b>" + ins.completed + "</b> reached the end — a <b>" + ins.overall + "% completion rate</b>. " +
        "The biggest single fall-off is <b>" + esc(ins.fromName) + " → " + esc(ins.toName) + "</b>, losing <b>" + ins.dropPct + "%</b> of the people at that point (" + ins.fromN + " → " + ins.toN + " users).";
      return '<div class="funnelcard">' +
        '<div class="fh"><span class="fname">' + info.icon + ' ' + esc(f.funnel) +
          (info.tag ? ' <span class="ftag">' + info.tag + '</span>' : '') + '</span>' +
          '<span class="rag ' + oc + '">' + ins.overall + '% complete</span></div>' +
        '<div class="fwhat">' + info.what + ' <br>' + info.biz + '</div>' +
        '<div class="fkpis">' +
          '<div class="fkpi"><span class="fkn">' + ins.entered + '</span><span class="fkl">Entered</span></div>' +
          '<div class="fkpi arrow">→</div>' +
          '<div class="fkpi"><span class="fkn">' + ins.completed + '</span><span class="fkl">Completed</span></div>' +
          '<div class="fkpi"><span class="fkn ' + oc + '">' + ins.overall + '%</span><span class="fkl">Completion</span></div>' +
          '<div class="fkpi"><span class="fkn red">' + ins.dropPct + '%</span><span class="fkl">Biggest drop</span></div>' +
        '</div>' +
        '<div class="funnel">' + bars + '</div>' +
        '<div class="finsight"><b>📊 What the data says:</b> ' + read + '<br><b>👉 Where to look:</b> ' + info.lens + '</div>' +
        '<div class="muted" style="font-size:11px;margin-top:8px">' + esc(f.source) + ' · each step shows its plain-language meaning · the red step is the biggest drop-off.</div>' +
        '</div>';
    }).join("") || '<div class="muted">No funnel data.</div>';
  }

  // Current running sprint: config override, else latest sprint with delivered
  // work, +1 (the next one is "running"). Used to window the dropdown/trend.
  function currentSprint() {
    if (cfg.CURRENT_SPRINT) return num(cfg.CURRENT_SPRINT);
    var del = data.items.filter(function (i) { return String(i.is_delivered) === "1"; })
      .map(function (i) { return num(i.sprint); }).filter(function (n) { return n > 0; });
    return del.length ? Math.max.apply(null, del) + 1 : null;
  }
  function inWindow(n) {
    var c = currentSprint();
    if (!c) return true;
    return n >= (c - SPRINT_BACK) && n <= (c + 2);
  }
  function windowSprints() {
    return data.sprints.map(function (s) { return num(s.sprint); })
      .filter(function (n) { return n > 0 && inWindow(n); });
  }

  function populateSprintSelect() {
    var sel = el("sprintSel");
    var sprints = windowSprints().sort(function (a, b) { return b - a; });
    sel.innerHTML = sprints.map(function (n) { return '<option value="' + n + '">Sprint ' + n + "</option>"; }).join("");
    // Preserve the user's choice across auto-refresh / reload; else current sprint.
    var saved = selectedSprint; if (!saved) { try { saved = localStorage.getItem("dallal_sprint"); } catch (e) {} }
    var inList = function (n) { return sprints.indexOf(num(n)) !== -1; };
    var def = (saved && inList(saved)) ? num(saved)
      : (currentSprint() && inList(currentSprint())) ? currentSprint()
      : (DEFAULT_SPRINT && inList(DEFAULT_SPRINT)) ? num(DEFAULT_SPRINT)
      : sprints[0];
    sel.value = def; selectedSprint = String(def); return def;
  }

  // ---------- data layer (authenticated Supabase client) ----------
  function sbSelect(table) {
    return sbc.from(table).select("*").limit(5000).then(function (r) {
      if (r.error) throw new Error(table + ": " + r.error.message);
      return r.data || [];
    });
  }

  function loadAll() {
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
    ]).then(function (res) {
      data.items = res[0]; data.sprints = res[1]; data.flow = res[2]; data.risks = res[3];
      data.burndown = res[4]; data.repos = res[5]; data.vulns = res[6]; data.funnels = res[7];
      loadedOnce = true;
      var def = populateSprintSelect();
      var anySample = data.items.some(function (i) { return String(i.story_points_is_sample) === "1"; });
      if (anySample) { el("sampleFlag").textContent = "Showing SAMPLE story points (Asana Story Points not yet populated). All other metrics are live."; show("sampleFlag"); }
      else hide("sampleFlag");
      el("updated").textContent = "Updated " + new Date().toLocaleString();
      render(def);
      if (!el("engView").classList.contains("hidden")) renderEng();
      if (!el("funnelView").classList.contains("hidden")) renderFunnels();
    }).catch(function (e) {
      el("error").textContent = "Could not load data: " + e.message +
        "  -  ensure web_read_policies.sql is applied and your account can read.";
      show("error");
    });
  }

  function loadSample() {
    var s = window.DALLAL_SAMPLE;
    data.items = s.items || []; data.sprints = s.sprints || []; data.flow = s.flow || []; data.risks = s.risks || [];
    data.burndown = s.burndown || []; data.repos = s.repos || []; data.vulns = s.vulns || [];
    var def = populateSprintSelect();
    el("sampleFlag").textContent = "OFFLINE PREVIEW - bundled sample data (story points estimated). Configure Supabase in config.js for live, login-protected data.";
    show("sampleFlag"); el("updated").textContent = "Sample preview"; render(def);
  }

  // ---------- auth ----------
  function showAppUI() { hide("login"); show("app"); show("signOut"); show("topbar"); }
  function showLoginUI() { show("login"); hide("app"); hide("signOut"); hide("topbar"); }

  function onAuth(session) {
    if (session) {
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
    sbc.auth.signInWithOtp({ email: email, options: { emailRedirectTo: window.location.href } })
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
    sbc.auth.signInWithOAuth({ provider: "google", options: { redirectTo: window.location.href } })
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
    el("tabDelivery").addEventListener("click", function () { showTab("delivery"); });
    el("tabEng").addEventListener("click", function () { showTab("eng"); });
    el("tabFunnels").addEventListener("click", function () { showTab("funnels"); });
    el("funnelEnv").addEventListener("change", function () { try { localStorage.setItem("dallal_funnel_env", this.value); } catch (e) {} renderFunnels(); });
    el("funnelPlatform").addEventListener("change", function () { try { localStorage.setItem("dallal_funnel_platform", this.value); } catch (e) {} renderFunnels(); });
    el("refreshBtn").addEventListener("click", function () { if (sbc && loadedOnce) loadAll(); });
    // Live auto-refresh: re-pull from Supabase every 5 min and when the tab regains focus — no manual reload.
    setInterval(function () { if (sbc && loadedOnce && !document.hidden) loadAll(); }, 300000);
    document.addEventListener("visibilitychange", function () { if (!document.hidden && sbc && loadedOnce) loadAll(); });
    el("googleBtn").addEventListener("click", doGoogle);
    el("magicBtn").addEventListener("click", doMagicLink);
    el("loginEmail").addEventListener("keydown", function (e) { if (e.key === "Enter") doMagicLink(); });
    el("loginBtn").addEventListener("click", doLogin);
    el("loginPass").addEventListener("keydown", function (e) { if (e.key === "Enter") doLogin(); });
    el("pwToggle").addEventListener("click", function (e) { e.preventDefault(); el("pwBlock").classList.toggle("hidden"); });
    el("signOut").addEventListener("click", function () { if (sbc) sbc.auth.signOut(); });
    // Landing -> sign-in modal
    el("ctaLogin").addEventListener("click", function () { show("loginModal"); var e = el("loginEmail"); if (e) e.focus(); });
    el("loginClose").addEventListener("click", function () { hide("loginModal"); });
    el("loginModal").addEventListener("click", function (ev) { if (ev.target === el("loginModal")) hide("loginModal"); });
    document.addEventListener("keydown", function (ev) { if (ev.key === "Escape") hide("loginModal"); });
    // Remember collapsed/expanded state of story lists across re-renders.
    document.addEventListener("toggle", function (e) {
      var d = e.target; if (d && d.tagName === "DETAILS" && d.getAttribute("data-lb")) _collapse[d.getAttribute("data-lb")] = d.open;
    }, true);

    // Not configured -> offline sample preview (nothing sensitive to protect).
    if (!isConfigured()) {
      if (window.DALLAL_SAMPLE) { loadSample(); return; }
      el("error").textContent = "Supabase not configured. Fill web/config.js."; show("error"); hide("app"); return;
    }
    if (!window.supabase) { el("error").textContent = "Auth library failed to load (check network/CDN)."; show("error"); return; }
    sbc = window.supabase.createClient(URL_, KEY_);

    if (!REQUIRE_AUTH) { showAppUI(); loadAll(); return; }   // intentional public mode
    hide("app"); hide("topbar");   // avoid flashing the dashboard/header before the session check resolves
    sbc.auth.onAuthStateChange(function (_e, session) { onAuth(session); });
    sbc.auth.getSession().then(function (r) { onAuth(r.data.session); });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
