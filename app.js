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

  var data = { items: [], sprints: [], flow: [], risks: [], burndown: [], repos: [], vulns: [], funnels: [], abandoned: [], reengage: [] };
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
  function isDone(i) { return /Ready for UAT|QA on UAT|In UAT|UAT Passed|Ready for Production|Released/i.test(i.section || "") || String(i.is_delivered) === "1"; }
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
  // Still-ideating columns excluded from every delivery/status metric — work that's
  // only an idea or in design, NOT yet committed. Excluded board columns:
  //   • Backlog - Idea / Refinement / Design
  //   • Design In-Progress
  // INCLUDED (committed scope): "Ready for Development (handoff complete)" and every
  // downstream column (In Development, QA, UAT, Released, Reopen, Sprint Planned…).
  function isPreSprint(i) {
    return /backlog\s*-\s*idea|design\s*in-?progress/i.test(i.section || "");
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
    var bugs = its.filter(isBug);
    function statusIn(list) { return its.filter(function (i) { return list.indexOf(i.status) !== -1; }).length; }
    var reopened = its.filter(function (i) { return num(i.reopened_count) > 0; }).length;
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
      progress: hCommit ? hDeliver / hCommit : null,
      predictability: hCommitment ? hDeliver / hCommitment : null,
      carryFwd: hCommit ? (usePts ? carryFwdSP : carryFwdItems) / hCommit : null,
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
      regression: bugs.filter(function (i) { return num(i.reopened_count) > 0; }).length,
      reopened: reopened,   // count of items reopened >=1x this sprint
      // Rework rate: delivered items that were reopened / delivered items (always <=100%).
      reopenedPct: completed ? its.filter(function (i) { return isDone(i) && num(i.reopened_count) > 0; }).length / completed : null,
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
    el("retroGrid").innerHTML =
      card("Committed", committed + " " + unit, { icon: "🎯", accent: "#1f6feb", tip: "Scope committed for this sprint (still-ideating columns excluded)." }) +
      card("Delivered", delivered + " " + unit, { icon: "✅", accent: "#2e7d32", tip: "Work that reached the UAT pipeline or shipped this sprint (Ready for UAT / QA on UAT / UAT Passed / Released)." }) +
      card("Completion", pct(comp), { icon: "📈", accent: compHex, tip: "Delivered ÷ committed." }) +
      card("Carryover", carriedItems + ' <span style="font-size:13px;color:var(--muted,#5b6577)">items · ' + carry + " " + unit + "</span>", { icon: "↪️", accent: carriedItems ? "#b9820a" : "#2e7d32", tip: "Committed work still in development or not yet started at sprint end. Items already in the QA/UAT pipeline (Ready for UAT / QA on UAT / UAT Passed) count as delivered, not carried over." }) +
      card("Velocity", m.velocity + " " + m.velocityUnit, { icon: "⚡", accent: "#0f8b8d", tip: "Throughput delivered this sprint." }) +
      card("Bugs Closed", m.bugsClosed + " / " + m.bugs, { icon: "🐞", accent: "#7c5cd6", tip: "Bugs resolved out of bugs in the sprint." }) +
      card("Rework", m.reopenedPct == null ? "--" : pct(m.reopenedPct), { icon: "🔁", accent: (m.reopenedPct || 0) <= 0.1 ? "#2e7d32" : (m.reopenedPct || 0) <= 0.25 ? "#b9820a" : "#c62828", tip: "Delivered items that were reopened at least once." });

    var ins = [];
    if (comp != null) ins.push({ k: comp >= 0.85 ? "good" : comp >= 0.6 ? "watch" : "bad", t: "Delivered " + delivered + " of " + committed + " " + unit + " committed (" + pct(comp) + ")." });
    if (carriedItems > 0) ins.push({ k: carriedItems <= 2 ? "watch" : "bad", t: carriedItems + " item(s) · " + carry + " " + unit + " carried over to the next sprint." });
    else ins.push({ k: "good", t: "No carry-forward — all committed work reached the QA/UAT pipeline or shipped." });
    if (m.predictability != null) ins.push({ k: m.predictability >= 0.85 ? "good" : m.predictability >= 0.6 ? "watch" : "bad", t: "Predictability vs the original commitment: " + pct(m.predictability) + "." });
    if (m.reopenedPct != null) ins.push({ k: m.reopenedPct <= 0.1 ? "good" : m.reopenedPct <= 0.25 ? "watch" : "bad", t: "Rework rate: " + pct(m.reopenedPct) + " of delivered items were reopened." });
    if (m.pCritical > 0) ins.push({ k: "bad", t: m.pCritical + " P1/Critical bug(s) were in this sprint." });
    if (m.escapeReliable && m.defectEscape > 0) ins.push({ k: m.defectEscape <= 0.1 ? "watch" : "bad", t: pct(m.defectEscape) + " of classified bugs escaped to Prod (" + m.bugsClassified + " of " + m.bugs + " bugs classified)." });
    if (m.cycleDays != null) ins.push({ k: m.cycleDays <= 5 ? "good" : m.cycleDays <= 10 ? "watch" : "bad", t: "Average cycle time: " + (Math.round(m.cycleDays * 10) / 10) + " days." });
    var insRows = ins.map(function (x) {
      return '<div class="taskrow"><div class="tasktitle" style="display:flex;align-items:center;gap:10px">' + retroBadge(x.k) + "<span>" + esc(x.t) + "</span></div></div>";
    }).join("");
    el("retroInsights").innerHTML = listBlock("retroinsights", "What the data says &middot; " + ins.length, insRows || '<div class="muted">No sprint data.</div>');

    // Stories to split — larger than 5 SP (action: slice at planning). Links to the Asana ticket.
    if (el("retroBig")) {
      var big = m.its.filter(function (i) { return num(i.story_points) > 5 && !/sub-?task/i.test(String(i.type || "")); })
        .sort(function (a, b) { return num(b.story_points) - num(a.story_points); });
      var bigRows = big.map(function (i) {
        return '<div class="taskrow"><div class="tasktitle">' +
          '<span class="rag amber" style="margin-right:8px">' + num(i.story_points) + " SP</span>" +
          esc(i.name || i.task_gid) +
          '<span class="muted" style="font-size:12px"> &middot; ' + esc(i.type || "—") + (i.status ? " &middot; " + esc(i.status) : "") + "</span> " +
          '<a class="tasklink" href="' + ASANA_TASK + esc(i.task_gid) + '" target="_blank" rel="noopener">Open &#8599;</a>' +
          "</div></div>";
      }).join("");
      el("retroBig").innerHTML = listBlock("retrobig", "Stories to split &middot; larger than 5 SP &middot; " + big.length, bigRows || '<div class="muted">No stories over 5 SP this sprint. 🎉</div>');
    }

    var notes = (data.retro && data.retro.length ? data.retro : sampleRetro(sprint)).filter(function (r) { return String(r.sprint) === String(sprint); });
    if (!notes.length) notes = sampleRetro(sprint);
    function noteList(dom, type, title) {
      var sel = notes.filter(function (r) { return r.type === type; });
      var rows = sel.map(function (r) {
        var meta = (r.owner || r.status) ? '<span class="muted" style="font-size:12px"> &middot; ' + esc([r.owner, r.status].filter(Boolean).join(" · ")) + "</span>" : "";
        return '<div class="taskrow"><div class="tasktitle">' + esc(r.text) + meta + "</div></div>";
      }).join("");
      el(dom).innerHTML = listBlock("retro_" + type, title + " &middot; " + sel.length, rows || '<div class="muted">No notes yet.</div>');
    }
    noteList("retroWell", "well", "✅ What went well");
    noteList("retroImprove", "improve", "🔧 What to improve");
    noteList("retroActions", "action", "🎯 Action items");
  }

  // ---------- render ----------
  function render(sprint) {
    var m = compute(sprint), rag = goalRag(m);
    renderRetro(sprint, m);
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
        card("Committed", (m.usePts ? Math.round(m.committedSP) + " SP" : m.planned + " items"), { icon: "📌", accent: "#3f7fce" }) +
        card("Delivered", (m.usePts ? Math.round(m.deliveredSP) + " SP" : m.completed + " items"), { icon: "✅", accent: "#2e7d32" }) +
      "</div>";
    drawGauge("gProgress", m.progress, goalHex);
    drawGauge("gPredict", m.predictability, "#1f6feb");
    drawGauge("gCarry", m.carryFwd, "#f29f05");
    el("healthNote").innerHTML = m.usePts
      ? 'Progress, Predictability &amp; Carry-Forward are measured in <b>story points</b>. <b>Delivered</b> = work that has reached the UAT pipeline or shipped (Ready&nbsp;for&nbsp;UAT → Released) — ' + Math.round(m.deliveredSP) + '/' + Math.round(m.committedSP) + ' SP (' + pct(m.progress) + '). <b>Carry-Forward</b> = ' + Math.round(m.carryFwdSP) + ' SP (' + pct(m.carryFwd) + '), the committed work still In&nbsp;Development or not yet started. By <b>item count</b> it\'s ' + m.completed + '/' + m.planned + ' stories delivered.'
      : "Story Points not set in Asana for this sprint — Sprint Health is showing item counts. It switches to SP automatically once tasks are estimated.";

    el("deliveryGrid").innerHTML =
      card("Stories Planned", m.planned, { icon: "📋", accent: "#3f7fce" }) +
      card("In Development", m.inDev, { icon: "🛠️", accent: "#7b61ff", tip: "Stories in the 'In Development' / Code Review board column (based on the board section, not the stale Status field)." }) +
      card("In QA", m.inQA, { icon: "🧪", accent: "#1f6feb", tip: "Stories in a testing column: QA on Dev / Ready for UAT / QA on UAT / In UAT." }) +
      card("Completed", m.completed, { icon: "✅", accent: "#2e7d32" }) +
      card("Blocked", m.blocked, { icon: "⛔", accent: "#c62828" }) +
      card("Released", m.released, { icon: "🚀", accent: "#0f8b8d", tip: "Stories in the 'Released' board column in Asana (shipped to production). 'Completed' above counts every delivered state — reached UAT or beyond (Ready for UAT / QA on UAT / In UAT / UAT Passed / Ready for Production / Released)." });
    var openItems = m.its.filter(function (i) { return !isDone(i); });
    el("openList").innerHTML = listBlock("open", "Not yet completed &middot; " + openItems.length + " of " + m.planned + " stories",
      (openItems.length ? openItems.map(taskRow).join("") : '<div class="muted">All committed stories completed. 🎉</div>'));

    el("qualityGrid").innerHTML =
      card("Total Bugs", m.bugs, { icon: "🐞", accent: "#6b7a8d", tip: "Tickets in this sprint whose title contains \"BUG\" (or Type = Bug)." }) +
      card("Bugs Closed", m.bugsClosed, { icon: "✅", accent: "#2e7d32", tip: "Bug tickets resolved this sprint (Released / UAT Passed / done). Total Bugs − Bugs Closed = still-open bugs." }) +
      card("Critical (P1)", m.pCritical, { icon: "🔴", accent: "#c62828", tip: "Bug tickets with task Priority = P1 Critical." }) +
      card("High (P2)", m.pHigh, { icon: "🟠", accent: "#f29f05", tip: "Bug tickets with task Priority = P2 High." }) +
      card("Reopened", m.reopened, { icon: "🔁", tip: "Count of items sent back for rework at least once this sprint (bounced to Raised by QA / Reopen / UAT Failed) — derived from Status history, refreshed on the daily flow sync. Rework rate of delivered items: " + pct(m.reopenedPct) + "." }) +
      card("Defect Escape", (m.escapeReliable ? pct(m.defectEscape) : "--") + ' <span style="font-size:13px;color:var(--muted,#5b6577)">' + m.bugsClassified + "/" + m.bugs + " classified</span>", { icon: "🪲", accent: m.escapeReliable ? undefined : "#5b6577", tip: "Share of bugs found in Prod, out of bugs that have a 'Found In' value (Dev/UAT/Prod). Bugs with no 'Found In' are excluded, and the rate shows '—' until at least 3 bugs and 50% of the sprint's bugs are classified in Asana." });
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
          { icon: "🛠️", accent: "#3f7fce", tip: "Average time a task spends being built — from entering 'In Development' to reaching the first testing stage (QA on Dev / Ready for UAT / In UAT). Derived from board section moves." }) +
        card("Avg QA Time", (m.qaDays != null ? m.qaDays.toFixed(1) : "--") + ' <small>days</small>',
          { icon: "🔍", accent: "#1f6feb", tip: "Average time in testing — from the first testing stage to Done (UAT Passed / Released, or task completion)." }) +
        card("Cycle Time", (m.cycleDays != null ? m.cycleDays.toFixed(1) : "--") + ' <small>days</small>',
          { icon: "🔄", accent: "#0f8b8d", tip: "Total active build + test time per task — from 'In Development' to Done. Lower is faster delivery." }) +
        card("Blocked Hours", (m.blockedHours != null ? m.blockedHours.toFixed(0) : "--"),
          { icon: "⛔", accent: "#c62828", tip: "Total hours tasks sat in the 'Blocked' board section this sprint. 0 means tasks weren't moved into Blocked (blocking tracked elsewhere)." });
      mkChart("flowChart", { type: "bar",
        data: { labels: ["Avg Dev", "Avg QA", "Cycle"],
          datasets: [{ data: [m.devDays || 0, m.qaDays || 0, m.cycleDays || 0],
            backgroundColor: ["#3f7fce", "#1f6feb", "#0f8b8d"], borderRadius: 6, barThickness: 28 }] },
        options: { indexAxis: "y", responsive: true, plugins: { legend: { display: false } },
          scales: { x: { beginAtZero: true, title: { display: true, text: "days" } } } } });
    } else {
      el("flowGrid").innerHTML = '<div class="card"><div class="label">Flow metrics</div>' +
        '<div class="muted">No flow data yet. Run the sync with <code>--with-flow</code> to populate dev/QA/cycle time &amp; blocked hours.</div></div>';
      if (_charts.flowChart) { _charts.flowChart.destroy(); delete _charts.flowChart; }
    }
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
    el("missingSPList").innerHTML = listBlock("missSP", "Stories needing an estimate &middot; " + missing.length,
      missing.length ? missing.map(taskRow).join("") : '<div class="muted">All committed stories are estimated. 🎉</div>');

    renderRisks(sprint);
    renderCharts(sprint, m);
    renderTrends(sprint, m);
    renderBurndown(sprint, m);
    renderScopeCreep(sprint, m);
  }

  function renderScopeCreep(sprint, m) {
    var dim = data.sprints.filter(function (s) { return String(s.sprint) === String(sprint); })[0] || {};
    var start = dim.planned_start || dim.inferred_start;
    var end = dim.planned_end || dim.inferred_end;
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
      card("Baseline scope", baseCount + ' <small>stories</small>', { icon: "📌", accent: "#3f7fce", tip: "Stories committed at sprint start (created on/before the start date, bugs excluded). ≈ " + Math.round(baseSP) + " SP." }) +
      card("Added mid-sprint", "+" + addCount + ' <small>tickets</small>', { icon: "➕", accent: "#f29f05", tip: creepTip }) +
      card("Scope Creep", creepPct == null ? "--" : "+" + Math.round(creepPct * 100) + "%", { icon: "📈", accent: (creepPct && creepPct > 0.1) ? "#c62828" : "#2e7d32", tip: "Added tickets ÷ baseline tickets." }) +
      card("Added story points", "+" + Math.round(addSP) + ' <small>SP</small>', { icon: "🔢", tip: "Story points of the added tickets — 0 if they aren't estimated yet." });

    var addedItems = stories.filter(function (i) { var cd = (i.created_at || "").slice(0, 10); return start && cd && cd > start; });
    el("scopeList").innerHTML = listBlock("scope", "Added mid-sprint &middot; " + addedItems.length + " stories (bugs excluded)",
      (addedItems.length ? addedItems.map(taskRow).join("") : '<div class="muted">No mid-sprint story additions.</div>'));

    if (!start || !end) { if (_charts.scopeChart) { _charts.scopeChart.destroy(); delete _charts.scopeChart; } var c = el("scopeChart"); if (c) c.getContext("2d").clearRect(0, 0, c.width, c.height); return; }
    var days = isoDays(start, end);
    var cum = days.map(function (d) { var n = 0; stories.forEach(function (i) { var cd = (i.created_at || "").slice(0, 10); if (cd && cd <= d) n++; }); return n; });
    var baseArr = days.map(function () { return baseCount; });
    mkChart("scopeChart", { type: "line",
      data: { labels: days.map(function (d) { return d.slice(5); }), datasets: [
        { label: "Stories (bugs excluded)", data: cum, borderColor: "#c62828", backgroundColor: "rgba(242,159,5,.18)", fill: 1, tension: .1, stepped: true },
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
    var rs = data.risks.filter(function (r) { return !isEngRisk(r) && String(r.sprint) === String(sprint); });
    var counts = { red: 0, amber: 0, green: 0 };
    rs.forEach(function (r) { var k = (r.rag || "").toLowerCase(); if (counts[k] != null) counts[k]++; });
    el("riskCards").innerHTML =
      card("Red", '<span class="dot red"></span> ' + counts.red) +
      card("Amber", '<span class="dot amber"></span> ' + counts.amber) +
      card("Green", '<span class="dot green"></span> ' + counts.green);
    el("riskList").innerHTML = rs.map(riskCardHtml).join("") ||
      '<div class="muted">No delivery risks logged for Sprint ' + esc(String(sprint)) + '. Risks are a <b>manually-curated</b> list (the Supabase <code>risks</code> table) — add rows there to surface them here. (Security/repo risks live on the Engineering tab.)</div>';
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
    el("trendKpiGrid").innerHTML =
      card("Avg Velocity", Math.round(avgVel) + ' <small>SP/sprint</small>', { icon: "⚡", accent: "#0f8b8d", tip: "Mean delivered story points across the last " + agg.length + " sprints — the number to forecast future capacity with." }) +
      card("Flow Efficiency", flowEff != null ? pct(flowEff) : "--", { icon: "🌊", accent: "#1f6feb", tip: "Active build+test time ÷ (active + blocked) time. Higher = less time stuck waiting. Needs the --with-flow sync." }) +
      card("Avg Age (open)", avgAge != null ? avgAge.toFixed(1) + ' <small>days</small>' : "--", { icon: "⏳", accent: "#f29f05", tip: "Average days the still-open stories have been alive (created → now). Rising = work is aging." }) +
      card("Oldest Open", maxAge != null ? Math.round(maxAge) + ' <small>days</small>' : "--", { icon: "🕰️", accent: "#c62828", tip: "Age of the oldest still-open story in this sprint — a candidate to unblock or split." });

    mkChart("predictChart", {
      type: "bar",
      data: { labels: labels, datasets: [
        { type: "bar", label: "Carryover SP", data: agg.map(function (a) { return a.carry; }), backgroundColor: "#f29f05", borderRadius: 5, yAxisID: "y" },
        { type: "line", label: "Predictability %", data: agg.map(function (a) { return a.predict; }), borderColor: "#1f6feb", backgroundColor: "transparent", tension: .3, yAxisID: "y1" } ] },
      options: { responsive: true, plugins: { legend: { position: "bottom" } },
        scales: { y: { beginAtZero: true, title: { display: true, text: "carryover SP" } },
          y1: { beginAtZero: true, suggestedMax: 100, position: "right", grid: { drawOnChartArea: false }, title: { display: true, text: "predictability %" } } } } });

    mkChart("cycleTrendChart", { type: "line",
      data: { labels: labels, datasets: [
        { label: "Cycle", data: agg.map(function (a) { return a.cycle; }), borderColor: "#0f8b8d", backgroundColor: "transparent", tension: .3 },
        { label: "Dev", data: agg.map(function (a) { return a.dev; }), borderColor: "#3f7fce", backgroundColor: "transparent", tension: .3 },
        { label: "QA", data: agg.map(function (a) { return a.qa; }), borderColor: "#7b61ff", backgroundColor: "transparent", tension: .3 } ] },
      options: { responsive: true, plugins: { legend: { position: "bottom" } }, scales: { y: { beginAtZero: true, title: { display: true, text: "days" } } } } });

    mkChart("bugTrendChart", { type: "bar",
      data: { labels: labels, datasets: [
        { label: "Total bugs in sprint", data: agg.map(function (a) { return a.bugsRaised; }), backgroundColor: "#c62828", borderRadius: 5 },
        { label: "Closed", data: agg.map(function (a) { return a.bugsClosed; }), backgroundColor: "#2e7d32", borderRadius: 5 } ] },
      options: { responsive: true, plugins: { legend: { position: "bottom" } }, scales: { y: { beginAtZero: true } } } });

    mkChart("wipChart", { type: "bar",
      data: { labels: ["In Dev", "In QA", "Blocked", "Ready", "Released"],
        datasets: [{ data: [m.inDev, m.inQA, m.blocked, m.ready, m.released],
          backgroundColor: ["#7b61ff", "#1f6feb", "#c62828", "#f29f05", "#0f8b8d"], borderRadius: 5, barThickness: 32 }] },
      options: { indexAxis: "y", responsive: true, plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, title: { display: true, text: "stories" } } } } });
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

  function showTab(which) {
    var isDel = which === "delivery", isEng = which === "eng", isFun = which === "funnels", isMkt = which === "marketing", isFlow = which === "flow", isCrm = which === "crm", isApi = which === "api", isJourney = which === "journey";
    el("sprintView").classList.toggle("hidden", !isDel);
    el("engView").classList.toggle("hidden", !isEng);
    el("funnelView").classList.toggle("hidden", !isFun);
    el("marketingView").classList.toggle("hidden", !isMkt);
    el("flowView").classList.toggle("hidden", !isFlow);
    el("crmView").classList.toggle("hidden", !isCrm);
    el("journeyView").classList.toggle("hidden", !isJourney);
    el("apiView").classList.toggle("hidden", !isApi);
    el("sprintSel").classList.toggle("hidden", !isDel);
    el("sprintLbl").classList.toggle("hidden", !isDel);
    el("tabDelivery").classList.toggle("active", isDel);
    el("tabEng").classList.toggle("active", isEng);
    el("tabFunnels").classList.toggle("active", isFun);
    el("tabMarketing").classList.toggle("active", isMkt);
    el("tabFlow").classList.toggle("active", isFlow);
    el("tabCrm").classList.toggle("active", isCrm);
    el("tabJourney").classList.toggle("active", isJourney);
    el("tabApi").classList.toggle("active", isApi);
    if (isEng) renderEng();
    if (isFun) renderFunnels();
    if (isMkt) renderMarketing();
    if (isApi) renderApi();
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

  function renderFunnels() {
    var env = populateFunnelEnv();
    var platform = populateFunnelPlatform(env);
    var fs = funnelsData(env, platform);
    var METRIC = { "Supply & Demand": 1, "Engagement": 1, "Time to Reach Step (sec)": 1, "Listings Published (weekly)": 1 };
    var metricFs = fs.filter(function (f) { return METRIC[f.funnel]; });
    var realFs = fs.filter(function (f) { return !METRIC[f.funnel]; });
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
          '<li><b>🔁 New-User Retention</b> — how many new users <i>come back</i> each week → <i>churn</i>. Here each “step” is a week, and the gap is who we lost.</li>' +
        '</ul>' +
        '<p class="muted">Source: Amplitude · ' + envNote + ' ' + platNote +
        ' Switch <b>Environment</b> (UAT / PROD) and <b>Platform</b> (Web / Android / iOS) above to slice each funnel.</p>' +
      '</div>';

    if (!fs.length) {
      el("funnelList").innerHTML = intro + '<div class="finsight">No funnel data for <b>Dallal ' + esc(env) +
        '</b> · <b>' + esc(platLabel) + '</b> yet — either no events in the last 30 days, or this platform isn\'t instrumented for these steps.</div>';
      renderProductMetrics(env, metricFs);
      renderPathSankey(env);
      return;
    }
    el("funnelList").innerHTML = intro + realFs.map(function (f) {
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
    renderProductMetrics(env, metricFs);
    renderPathSankey(env);
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
    // Preserve the user's choice across auto-refresh / reload; else the latest sprint
    // that actually has committed work. IMPORTANT: don't default to (or stay on) a
    // sprint whose items are all pre-development (Backlog/Design/Ready-for-Dev) — those
    // are excluded by isPreSprint, so the whole dashboard would compute to zero and
    // look broken. currentSprint() ("latest delivered + 1") can point at such an
    // empty, not-yet-started future sprint, so it's now only a fallback.
    var saved = selectedSprint; if (!saved) { try { saved = localStorage.getItem("dallal_sprint"); } catch (e) {} }
    var inList = function (n) { return sprints.indexOf(num(n)) !== -1; };
    // Default to the ACTIVE sprint = the latest sprint that has delivered work. Future
    // sprints now carry backlog/design items too, so "latest with any work" would jump
    // to the furthest future planning sprint — delivered-work is the right signal.
    var delivered = sprints.filter(function (n) {
      return data.items.some(function (i) { return String(i.sprint) === String(n) && String(i.is_delivered) === "1"; });
    });
    var def = (saved && inList(saved)) ? num(saved)
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
      sbSelect("fact_paths").catch(function () { return []; }),
      sbSelect("fact_unreviewed_prs").catch(function () { return []; }),
      sbSelect("fact_abandoned_listers").catch(function () { return []; }),
      sbSelect("fact_reengagement_log").catch(function () { return []; }),
      sbSelect("fact_api_endpoints").catch(function () { return []; }),
      sbSelect("fact_api_requests").catch(function () { return []; }),
      sbSelect("fact_retro").catch(function () { return []; }),
    ]).then(function (res) {
      data.items = res[0]; data.sprints = res[1]; data.flow = res[2]; data.risks = res[3];
      data.burndown = res[4]; data.repos = res[5]; data.vulns = res[6]; data.funnels = res[7]; data.paths = res[8];
      data.unreviewedPrs = res[9]; data.abandoned = res[10]; data.reengage = res[11];
      data.apiEndpoints = res[12]; data.apiRequests = res[13]; data.retro = res[14];
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
      if (!el("apiView").classList.contains("hidden")) renderApi();
    }).catch(function (e) {
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
    show("sampleFlag"); el("updated").textContent = "Sample preview"; render(def);
  }

  // ---------- auth ----------
  function showAppUI() { hide("booting"); hide("login"); show("app"); show("signOut"); show("topbar"); }
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
    el("tabDelivery").addEventListener("click", function () { showTab("delivery"); });
    el("tabEng").addEventListener("click", function () { showTab("eng"); });
    el("tabFunnels").addEventListener("click", function () { showTab("funnels"); });
    el("tabMarketing").addEventListener("click", function () { showTab("marketing"); });
    el("tabFlow").addEventListener("click", function () { showTab("flow"); });
    el("tabCrm").addEventListener("click", function () { showTab("crm"); });
    el("tabJourney").addEventListener("click", function () { showTab("journey"); });
    el("tabApi").addEventListener("click", function () { showTab("api"); });
    el("exportApi").addEventListener("click", exportApi);
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

    // Pin auth behaviour explicitly: implicit flow (tokens arrive in the URL
    // hash), detect them on load, and persist + auto-refresh the session. This
    // also guards against a future supabase-js defaulting to PKCE, which would
    // break this hash-based redirect flow (no exchangeCodeForSession call here).
    sbc = window.supabase.createClient(URL_, KEY_, {
      auth: {
        flowType: "implicit",
        detectSessionInUrl: true,
        persistSession: true,
        autoRefreshToken: true
      }
    });

    if (!REQUIRE_AUTH) { showAppUI(); loadAll(); return; }   // intentional public mode
    // #app/#topbar start hidden in the HTML; reveal only after the session check
    // resolves (via onAuth). The boot loader covers the gap so nothing flashes.
    sbc.auth.onAuthStateChange(function (_e, session) { onAuth(session); });
    sbc.auth.getSession()
      .then(function (r) { onAuth(r.data.session); })
      .catch(function () { showLoginUI(); });   // never hang on the loader if the check fails
  }

  document.addEventListener("DOMContentLoaded", init);
})();
