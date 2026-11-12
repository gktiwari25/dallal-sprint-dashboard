/* =========================================================================
 * Dallal KPI Command Center — app logic
 * -------------------------------------------------------------------------
 * Reads LIVE data from the same Supabase project the sprint dashboard uses
 * (config.js), behind the same sign-in/RLS. No value is ever fabricated:
 *   - Delivery KPIs are computed in-browser from fact_workitems / dim_sprint /
 *     fact_cycle_time / fact_appstore_metrics (formulas validated vs. workbook).
 *   - Push A-series come from fact_push_kpis, populated server-side by
 *     etl_push.py from the UAT Admin Analytics API (browser can't call it:
 *     admin JWT + no CORS). Until synced, those cards show "awaiting sync".
 *   - Not-instrumented KPIs show the required instrumentation, not a number.
 * ====================================================================== */
(function () {
  "use strict";
  const CFG = window.DALLAL_CONFIG || {};
  const CAT = window.KPI_CATALOG || [];
  const CATBY = Object.fromEntries(CAT.map(k => [k.id, k]));
  const EXCLUDE = (CFG.EXCLUDE_ASSIGNEES || []).map(s => s.toLowerCase());
  const ANCHOR = CFG.SPRINT_ANCHOR || { sprint: 14, start: "2026-08-14" };
  const SLEN = CFG.SPRINT_LENGTH_DAYS || 14;
  const MIN_SPRINT = CFG.MIN_SPRINT || 10;
  const DAY = 86400000;

  let sbc = null;
  let DATA = {};               // raw table rows
  let PUSH = {};               // period_key -> { kpi_id -> row }
  let pushTableOk = true;      // false if fact_push_kpis is missing
  let lastFetch = null;
  let period = "30d";
  let custom = { from: null, to: null };
  let charts = {};

  /* ----------------------------- utilities ----------------------------- */
  const $ = s => document.querySelector(s);
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmtDate = d => d ? new Date(d).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" }) : "—";
  const fmtDateShort = d => d ? new Date(d).toLocaleDateString(undefined, { day: "2-digit", month: "short" }) : "—";
  const isoDay = d => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
  const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };
  const median = arr => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

  /* ----------------------------- work-item predicates ------------------- */
  const sLower = it => String(it.section || "").toLowerCase();
  const isExcl = a => EXCLUDE.includes(String(a || "").toLowerCase());
  const isPreSprint = it => /backlog|idea|refinement|design/.test(sLower(it));
  const isDone = it => !!it.completed_at || it.is_completed == 1 || it.is_delivered == 1 ||
    /ready for uat|qa on uat|in uat|uat passed|ready for production|released|done|complete|resolved/.test(sLower(it));
  const isBug = it => it.is_bug == 1 || /bug/i.test(String(it.type || ""));
  const isCritical = it => /^(p0|p1|critical|urgent|blocker)/i.test(String(it.priority || "").trim());

  /* ----------------------------- sprint model --------------------------- */
  const anchorStart = new Date(ANCHOR.start + "T00:00:00").getTime();
  const sprintForDate = d => ANCHOR.sprint + Math.floor((new Date(d).getTime() - anchorStart) / (SLEN * DAY));
  const sprintStart = n => anchorStart + (n - ANCHOR.sprint) * SLEN * DAY;
  const currentSprint = () => (CFG.CURRENT_SPRINT != null) ? CFG.CURRENT_SPRINT : sprintForDate(Date.now());
  function sprintsInWindow(from, to) {
    const out = [];
    const hi = currentSprint() + 1;
    for (let n = MIN_SPRINT; n <= hi; n++) {
      const s = sprintStart(n), e = s + SLEN * DAY;
      if (e > from.getTime() && s <= to.getTime()) out.push(n);
    }
    return out;
  }

  /* ----------------------------- period windows ------------------------- */
  function windowFor(p) {
    const now = new Date();
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    let from, to = end, label = "", len = 0;
    if (p === "7d") { from = new Date(end.getTime() - 6 * DAY); label = "Last 7 days"; }
    else if (p === "30d") { from = new Date(end.getTime() - 29 * DAY); label = "Last 30 days"; }
    else if (p === "this_month") { from = new Date(now.getFullYear(), now.getMonth(), 1); label = "This month"; }
    else if (p === "last_month") { from = new Date(now.getFullYear(), now.getMonth() - 1, 1); to = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999); label = "Last month"; }
    else if (p === "qtd") { const q = Math.floor(now.getMonth() / 3); from = new Date(now.getFullYear(), q * 3, 1); label = "Quarter to date"; }
    else if (p === "custom") { from = custom.from ? new Date(custom.from + "T00:00:00") : new Date(end.getTime() - 29 * DAY); to = custom.to ? new Date(custom.to + "T23:59:59") : end; label = "Custom range"; }
    len = Math.max(1, Math.round((to - from) / DAY) + 1);
    const prevTo = new Date(from.getTime() - DAY);
    const prevFrom = new Date(prevTo.getTime() - (len - 1) * DAY);
    return { from, to, label, len, prevFrom, prevTo };
  }
  const inWin = (d, w) => { if (!d) return false; const t = new Date(d).getTime(); return t >= w.from.getTime() && t <= w.to.getTime(); };

  /* ======================================================================
   *  DATA LOAD
   * ==================================================================== */
  async function loadAll() {
    const tables = ["fact_workitems", "dim_sprint", "fact_cycle_time", "fact_appstore_metrics", "fact_repo_health"];
    const res = await Promise.all(tables.map(t => sbSelect(t)));
    const EXCL_GIDS = new Set((CFG.EXCLUDE_TASK_GIDS || []).map(g => String(g).trim()));
    tables.forEach((t, i) => {
      let rows = res[i] || [];
      // Drop individually-excluded Asana stories (config.EXCLUDE_TASK_GIDS) from
      // the work-item feed so no delivery KPI counts them.
      if (t === "fact_workitems") rows = rows.filter(r => !EXCL_GIDS.has(String(r && r.task_gid).trim()));
      DATA[t] = rows;
    });
    await loadPush();
    lastFetch = new Date();
  }

  async function sbSelect(table) {
    let all = [], from = 0, step = 1000;
    for (;;) {
      const { data, error } = await sbc.from(table).select("*").range(from, from + step - 1);
      if (error) { console.warn("read", table, error.message); break; }
      all = all.concat(data || []);
      if (!data || data.length < step) break;
      from += step;
    }
    return all;
  }

  async function loadPush() {
    PUSH = {}; pushTableOk = true;
    const { data, error } = await sbc.from("fact_push_kpis").select("*");
    if (error) {
      // relation missing / not deployed yet, or no read grant — treat as not-synced
      pushTableOk = false;
      return;
    }
    (data || []).forEach(r => { (PUSH[r.period_key] = PUSH[r.period_key] || {})[r.kpi_id] = r; });
  }

  /* ======================================================================
   *  KPI COMPUTATION  →  returns { id: result }
   *  result = { value, na, display, unit, prev, trendDir, trendGood,
   *             trendPct, updated, components }
   * ==================================================================== */
  function computeAll(w) {
    const r = {};
    const items = DATA.fact_workitems || [];
    const cyc = DATA.fact_cycle_time || [];
    const app = DATA.fact_appstore_metrics || [];

    /* ---- DL1 sprint commitment (delivered SP / committed SP) ---- */
    const dl1 = sprintCommitment(sprintsInWindow(w.from, w.to), items);
    const dl1p = sprintCommitment(sprintsInWindow(w.prevFrom, w.prevTo), items);
    r.DL1 = mk(dl1.rate, "%", dl1p.rate, false, { committed: dl1.committed, delivered: dl1.delivered, sprints: dl1.sprints, basis: dl1.basis });

    /* ---- DL2 releases in period (distinct iOS app_version) ---- */
    const vers = new Set(app.filter(x => x.platform === "ios" && x.app_version && inWin(x.date, w)).map(x => x.app_version));
    const versP = new Set(app.filter(x => x.platform === "ios" && x.app_version && x.date >= isoDay(w.prevFrom) && x.date <= isoDay(w.prevTo)).map(x => x.app_version));
    r.DL2 = app.length ? mk(vers.size, "", versP.size, false, { versions: [...vers] }) : naRes();

    /* ---- DL4 prod bugs per release (per sprint proxy) ---- */
    const prodBugs = items.filter(it => isBug(it) && /prod/i.test(String(it.found_in || "")) && inWin(it.created_at, w) && !isExcl(it.assignee));
    const nSpr = Math.max(1, sprintsInWindow(w.from, w.to).length);
    const prodBugsP = items.filter(it => isBug(it) && /prod/i.test(String(it.found_in || "")) && it.created_at && new Date(it.created_at) >= w.prevFrom && new Date(it.created_at) <= w.prevTo && !isExcl(it.assignee));
    const nSprP = Math.max(1, sprintsInWindow(w.prevFrom, w.prevTo).length);
    r.DL4 = mk(prodBugs.length / nSpr, "/rel", prodBugsP.length / nSprP, true, { prodBugs: prodBugs.length, sprints: nSpr, list: prodBugs.map(b => ({ gid: b.task_gid, name: b.name, sprint: b.sprint, created: b.created_at })) });

    /* ---- DL5 open bugs > 14d (snapshot now; trend vs window start) ---- */
    r.DL5 = (function () {
      const now = Date.now();
      const cur = openBugsOlderThan(items, now);
      const prev = openBugsOlderThan(items, w.from.getTime());
      const o = mk(cur.length, "", prev.length, true, { list: cur.map(b => ({ gid: b.task_gid, name: b.name, sprint: b.sprint, created: b.created_at, ageDays: Math.floor((now - new Date(b.created_at)) / DAY) })) });
      o.snapshot = true; return o;
    })();

    /* ---- DL6 critical bugs fixed within 24h / critical reported ---- */
    r.DL6 = critFixed(items, w);
    const dl6p = critFixed(items, { from: w.prevFrom, to: w.prevTo });
    r.DL6.prev = dl6p.value; applyTrend(r.DL6, false);

    /* ---- DL7 cycle time median (released_at in window) ---- */
    const cv = cyc.filter(x => x.cycle_days != null && x.released_at && inWin(x.released_at, w)).map(x => num(x.cycle_days));
    const cvP = cyc.filter(x => x.cycle_days != null && x.released_at && new Date(x.released_at) >= w.prevFrom && new Date(x.released_at) <= w.prevTo).map(x => num(x.cycle_days));
    const med = median(cv), medP = median(cvP);
    r.DL7 = cv.length ? mk(med, "d", medP, true, { n: cv.length, values: cv }) : naRes();
    r.DL7.updated = cyc.length ? (cyc.reduce((m, x) => x.released_at > m ? x.released_at : m, "")) : null;

    /* ---- X1 crash-free sessions (iOS) ---- */
    r.X1 = crashFree(app, w);
    const x1p = crashFree(app, { from: w.prevFrom, to: w.prevTo });
    r.X1.prev = x1p.value; applyTrend(r.X1, false);

    /* ---- Not-instrumented / manual delivery KPIs ---- */
    ["DL3", "DL8", "DL9", "F15", "DL10", "LC24", "LC25"].forEach(id => { r[id] = naRes(); });

    /* ---- A-series push (from fact_push_kpis) ---- */
    const pk = PUSH[period] || {};
    ["A10", "A11", "A12", "A14", "A19", "A20", "A21", "A22"].forEach(id => {
      const row = pk[id];
      const k = CATBY[id];
      if (!row || row.value == null) { r[id] = naRes(); r[id].pushMissing = true; return; }
      const unit = k.map.unitKind === "pct" ? "%" : (k.map.unitKind === "ratio_raw" ? "" : "");
      const o = mk(num(row.value), unit, row.prev_value != null ? num(row.prev_value) : null, !!k.map.lowerIsBetter, row.components || {});
      o.updated = row.captured_at || null;
      if (k.map.companion && row.components && row.components.tap_rate_percentage != null) o.companion = { label: "Tap rate", value: num(row.components.tap_rate_percentage), unit: "%" };
      r[id] = o;
    });

    // stamp freshness for live/derived
    ["DL1", "DL2", "DL4", "DL5", "DL6", "X1"].forEach(id => { if (r[id] && !r[id].na && !r[id].updated) r[id].updated = lastFetch; });
    return r;
  }

  function sprintCommitment(sprints, items) {
    const set = new Set(sprints.map(String));
    const scope = items.filter(it => set.has(String(it.sprint)) && !isPreSprint(it) && !isExcl(it.assignee));
    let cSP = 0, dSP = 0, cN = 0, dN = 0;
    scope.forEach(it => { const sp = num(it.story_points); cSP += sp; cN++; if (isDone(it)) { dSP += sp; dN++; } });
    const basis = cSP > 0 ? "points" : "count";
    const committed = basis === "points" ? cSP : cN;
    const delivered = basis === "points" ? dSP : dN;
    return { rate: committed > 0 ? 100 * delivered / committed : null, committed, delivered, sprints, basis };
  }
  function openBugsOlderThan(items, atMs) {
    return items.filter(it => {
      if (!isBug(it) || !it.created_at) return false;
      if (isExcl(it.assignee)) return false;
      if (it.sprint && Number(it.sprint) > currentSprint()) return false;      // future-sprint items excluded
      const openAt = !it.completed_at || new Date(it.completed_at).getTime() > atMs; // still open at `atMs`
      return openAt && (atMs - new Date(it.created_at).getTime()) > 14 * DAY;
    });
  }
  function critFixed(items, w) {
    const reported = items.filter(it => isBug(it) && isCritical(it) && it.created_at && new Date(it.created_at) >= w.from && new Date(it.created_at) <= w.to && !isExcl(it.assignee));
    const fixed24 = reported.filter(it => it.completed_at && (new Date(it.completed_at) - new Date(it.created_at)) <= DAY);
    if (!reported.length) { const o = naRes(); o.components = { reported: 0 }; return o; }
    return mk(100 * fixed24.length / reported.length, "%", null, false, { reported: reported.length, fixed24: fixed24.length });
  }
  function crashFree(app, w) {
    let sess = 0, crash = 0;
    app.forEach(x => {
      if (x.platform !== "ios") return;
      const d = x.date; if (!(d >= isoDay(w.from) && d <= isoDay(w.to))) return;
      if (x.metric === "sessions") sess += num(x.value);
      else if (x.metric === "crashes") crash += num(x.value);
    });
    if (sess <= 0) return naRes();
    return mk(100 * (1 - crash / sess), "%", null, false, { sessions: sess, crashes: crash });
  }

  /* result builders */
  function mk(value, unit, prev, lowerIsBetter, components) {
    const o = { value: (value == null ? null : value), na: value == null, unit: unit || "", prev: (prev == null ? null : prev), components: components || {}, updated: null };
    applyTrend(o, lowerIsBetter);
    return o;
  }
  function naRes() { return { value: null, na: true, unit: "", prev: null, components: {}, updated: null }; }
  function applyTrend(o, lowerIsBetter) {
    o.trendDir = "flat"; o.trendPct = null; o.trendGood = null;
    if (o.value == null || o.prev == null || o.prev === 0) { if (o.value != null && o.prev === 0 && o.value > 0) { o.trendDir = "up"; } return; }
    const delta = o.value - o.prev;
    o.trendPct = 100 * delta / Math.abs(o.prev);
    if (Math.abs(o.trendPct) < 0.5) { o.trendDir = "flat"; o.trendGood = null; return; }
    o.trendDir = delta > 0 ? "up" : "down";
    const good = lowerIsBetter ? delta < 0 : delta > 0;
    o.trendGood = good;
  }

  /* value formatting for a KPI */
  function display(id, res) {
    if (!res || res.na) return { txt: "—", na: true };
    const k = CATBY[id], kind = k.map.unitKind;
    let v = res.value;
    if (kind === "pct") return { txt: v.toFixed(1) + "%" };
    if (kind === "days") return { txt: v.toFixed(1), unit: "days" };
    if (kind === "count1") return { txt: v.toFixed(2), unit: res.unit };
    if (kind === "ratio_raw") return { txt: v.toFixed(2) };
    if (kind === "count") return { txt: Math.round(v).toLocaleString(), unit: res.unit };
    if (kind === "stage") return { txt: v == null ? "—" : String(v) };
    return { txt: String(v), unit: res.unit };
  }

  function statusFor(k, res) {
    const a = k.map.avail;
    if (a === "none") return { label: "Not instrumented", cls: "na" };
    if (a === "manual") return { label: "Manual", cls: "info" };
    if (a === "etl") return res && !res.na ? { label: "Live · ETL", cls: "ok" } : { label: "Awaiting sync", cls: "warn" };
    if (a === "derived") return res && !res.na ? { label: "Derived", cls: "info" } : { label: "No data", cls: "na" };
    return res && !res.na ? { label: "Live", cls: "ok" } : { label: "No data", cls: "na" };
  }

  /* ======================================================================
   *  RENDER
   * ==================================================================== */
  let RES = {}, WIN = null;
  function renderAll() {
    WIN = windowFor(period);
    RES = computeAll(WIN);
    $("#summarySub").textContent = WIN.label + " · vs previous " + WIN.len + "d";
    renderSourceHealth();
    renderSummary();
    renderEng();
    renderPush();
    renderScorecard();
    renderCharts();
    $("#refreshedAt").innerHTML = "Last refreshed <b>" + lastFetch.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + "</b>";
    $("#footerNote").innerHTML = `Dallal KPI Command Center · 22 KPIs from <b>${esc(window.KPI_META.workbook)}</b> (base ${esc(window.KPI_META.base)}). ` +
      `Delivery KPIs computed live from Supabase; push A-series via the authorised <code>etl_push.py</code> → <code>fact_push_kpis</code> pipeline. No value is fabricated.`;
  }

  const trendChip = res => {
    if (!res || res.na || res.trendDir === "flat" || res.trendPct == null) return `<span class="trend flat">— </span>`;
    const arrow = res.trendDir === "up" ? "▲" : "▼";
    const cls = res.trendGood === true ? "up" : res.trendGood === false ? "down" : "flat";
    return `<span class="trend ${cls}">${arrow} ${Math.abs(res.trendPct).toFixed(0)}%</span>`;
  };

  const SUMMARY_ORDER = ["DL1", "X1", "DL6", "DL5", "DL4", "DL2", "A14", "A19", "A10"];
  function renderSummary() {
    const g = $("#summaryGrid"); g.innerHTML = "";
    SUMMARY_ORDER.forEach(id => g.appendChild(card(id, RES[id], true)));
  }
  function renderEng() {
    const g = $("#engGrid"); g.innerHTML = "";
    ["DL1", "DL2", "DL3", "DL4", "DL5", "DL6", "DL7", "DL8", "DL9", "F15", "DL10", "X1"].forEach(id => g.appendChild(card(id, RES[id], false)));
  }
  function renderPush() {
    const g = $("#pushGrid"); g.innerHTML = "";
    ["A10", "A11", "A12", "A14", "A19", "A20", "A21", "A22"].forEach(id => g.appendChild(card(id, RES[id], false)));
    const banner = $("#pushBanner");
    if (!pushTableOk) {
      banner.innerHTML = `<div class="callout warn" style="margin-bottom:16px">
        <b>Push analytics not yet connected.</b> The eight A-series KPIs are fully specified in the UAT Admin Analytics API
        (<span class="mono">/api/admin/analytics/push_notifications</span>), but the browser cannot call it directly
        (admin sign-in required + no cross-origin access). Run <span class="mono">etl_push.py</span> with admin credentials to populate
        <span class="mono">fact_push_kpis</span>; these cards then go live. No placeholder numbers are shown.</div>`;
    } else if (!PUSH[period]) {
      banner.innerHTML = `<div class="callout info" style="margin-bottom:16px">
        No push snapshot for <b>${esc(WIN.label)}</b> yet. etl_push.py stores snapshots per period
        (7d · 30d · this_month · last_month · qtd). Showing available data only.</div>`;
    } else { banner.innerHTML = ""; }
  }

  function card(id, res, isSummary) {
    const k = CATBY[id];
    const c = el("div", "card clickable");
    c.dataset.kid = id;
    const d = display(id, res);
    const st = statusFor(k, res);
    const valHtml = d.na
      ? `<div class="kval na">${k.map.avail === "none" ? "Not instrumented" : k.map.avail === "manual" ? "Manual entry" : k.map.avail === "etl" ? "Awaiting sync" : "No data"}</div>`
      : `<div class="kval">${esc(d.txt)}${d.unit ? `<span class="kunit">${esc(d.unit)}</span>` : ""}</div>`;
    const comp = (res && res.companion) ? `<span class="src">· ${esc(res.companion.label)} ${res.companion.value.toFixed(1)}${res.companion.unit}</span>` : "";
    c.innerHTML =
      `<div style="display:flex;align-items:center;gap:8px"><span class="kid">${id}</span><span class="avail ${k.map.avail}">${availLabel(k.map.avail)}</span></div>
       <div class="ktitle">${esc(k.name)}</div>
       ${valHtml}
       <div class="kmeta">${res && !res.na ? trendChip(res) : ""}<span class="status-dot"><span class="d ${st.cls}"></span>${st.label}</span>${comp}</div>
       <div class="note-inline"><span class="src">◆ ${esc(sourceShort(k))}</span></div>`;
    c.addEventListener("click", () => openDrawer(id));
    return c;
  }
  const availLabel = a => ({ live: "Live", derived: "Derived", etl: "Admin API", manual: "Manual", none: "Not instrumented" }[a] || a);
  const sourceShort = k => k.map.table || (k.map.avail === "etl" ? "UAT Admin Analytics" : k.source);

  /* ---------- source health ---------- */
  function renderSourceHealth() {
    const box = $("#srcHealth"); box.innerHTML = "";
    const sources = [
      { name: "Asana / Delivery", ok: (DATA.fact_workitems || []).length > 0, n: (DATA.fact_workitems || []).length, unit: "items" },
      { name: "Cycle time", ok: (DATA.fact_cycle_time || []).length > 0, n: (DATA.fact_cycle_time || []).length, unit: "rows" },
      { name: "App Store (crash/sessions)", ok: (DATA.fact_appstore_metrics || []).some(x => x.platform === "ios"), n: (DATA.fact_appstore_metrics || []).length, unit: "rows" },
      { name: "Push (admin API → fact_push_kpis)", ok: pushTableOk && Object.keys(PUSH).length > 0, warn: pushTableOk && Object.keys(PUSH).length === 0, n: Object.values(PUSH).reduce((a, o) => a + Object.keys(o).length, 0), unit: "metrics" },
    ];
    sources.forEach(s => {
      const cls = s.ok ? "ok" : s.warn ? "warn" : "bad";
      const p = el("div", "srcpill", `<span class="dot ${cls}"></span>${esc(s.name)} <span style="opacity:.7">· ${s.n} ${s.unit}</span>`);
      box.appendChild(p);
    });
  }

  /* ---------- charts ---------- */
  function themeColors() {
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    return { grid: dark ? "rgba(180,189,214,.14)" : "rgba(68,80,106,.12)", tick: dark ? "#b4bdd6" : "#44506a" };
  }
  function renderCharts() {
    const tc = themeColors();
    Chart.defaults.font.family = "Inter, system-ui, sans-serif";
    Chart.defaults.color = tc.tick;

    // commitment chart — last 6 sprints
    const cur = currentSprint();
    const sprs = [];
    for (let n = Math.max(MIN_SPRINT, cur - 5); n <= cur; n++) sprs.push(n);
    const items = DATA.fact_workitems || [];
    const comm = sprs.map(n => sprintCommitment([n], items));
    mkChart("chartCommit", {
      type: "bar",
      data: {
        labels: sprs.map(n => "S" + n),
        datasets: [
          { label: "Committed", data: comm.map(c => c.committed), backgroundColor: "rgba(90,91,230,.25)", borderRadius: 6 },
          { label: "Delivered", data: comm.map(c => c.delivered), backgroundColor: "#5a5be6", borderRadius: 6 },
        ],
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" } },
        scales: { x: { grid: { display: false } }, y: { beginAtZero: true, grid: { color: tc.grid } } } },
    });

    // crash-free daily (iOS) over window
    const app = DATA.fact_appstore_metrics || [];
    const byDay = {};
    app.forEach(x => { if (x.platform !== "ios") return; if (!inWin(x.date, WIN)) return; const b = byDay[x.date] || (byDay[x.date] = { s: 0, c: 0 }); if (x.metric === "sessions") b.s += num(x.value); else if (x.metric === "crashes") b.c += num(x.value); });
    const days = Object.keys(byDay).sort();
    const cf = days.map(d => byDay[d].s > 0 ? 100 * (1 - byDay[d].c / byDay[d].s) : null);
    mkChart("chartCrash", {
      type: "line",
      data: { labels: days.map(fmtDateShort), datasets: [{ label: "Crash-free %", data: cf, borderColor: "#0ea89a", backgroundColor: "rgba(14,168,154,.12)", fill: true, tension: .3, spanGaps: true, pointRadius: 2 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
        scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 8 } }, y: { grid: { color: tc.grid }, suggestedMin: 98, suggestedMax: 100, ticks: { callback: v => v + "%" } } } },
    });
    if (!days.length) emptyChartNote("chartCrash", "No iOS session data in this window");
  }
  function mkChart(id, cfg) { if (charts[id]) charts[id].destroy(); const c = document.getElementById(id); if (c) charts[id] = new Chart(c, cfg); }
  function emptyChartNote(id, msg) { const c = document.getElementById(id); if (c && c.parentElement) c.parentElement.insertAdjacentHTML("beforeend", `<div style="position:absolute;inset:0;display:grid;place-items:center;color:var(--muted);font-size:12.5px">${esc(msg)}</div>`); }

  /* ======================================================================
   *  SCORECARD
   * ==================================================================== */
  let scSort = { key: "id", dir: 1 };
  function buildFilters() {
    const uniq = (f) => [...new Set(CAT.map(f))].sort();
    fill("#fSection", ["All sections", ...uniq(k => k.section)]);
    fill("#fType", ["All types", ...uniq(k => k.type)]);
    fill("#fAvail", ["All availability", "live", "derived", "etl", "manual", "none"]);
    fill("#fSource", ["All sources", ...uniq(k => k.source)]);
    fill("#fFreq", ["All frequencies", ...uniq(k => k.frequency)]);
    fill("#fStatus", ["All statuses", "Live", "Live · ETL", "Derived", "Awaiting sync", "Manual", "Not instrumented", "No data"]);
  }
  function fill(sel, opts) { const s = $(sel); s.innerHTML = opts.map((o, i) => `<option value="${i === 0 ? "" : esc(o)}">${esc(o)}</option>`).join(""); }

  function scoreRows() {
    const q = ($("#scSearch").value || "").toLowerCase().trim();
    const fS = $("#fSection").value, fT = $("#fType").value, fA = $("#fAvail").value, fSrc = $("#fSource").value, fF = $("#fFreq").value, fSt = $("#fStatus").value;
    let rows = CAT.map(k => {
      const res = RES[k.id]; const d = display(k.id, res); const st = statusFor(k, res);
      return {
        k, res, d, st,
        valueNum: res && !res.na ? res.value : -Infinity,
        prevNum: res && res.prev != null ? res.prev : -Infinity,
        trend: res && res.trendPct != null ? res.trendPct : 0,
        updated: res && res.updated ? new Date(res.updated).getTime() : 0,
      };
    });
    rows = rows.filter(r => {
      if (q && !(`${r.k.id} ${r.k.name} ${r.k.definition}`.toLowerCase().includes(q))) return false;
      if (fS && r.k.section !== fS) return false;
      if (fT && r.k.type !== fT) return false;
      if (fA && r.k.map.avail !== fA) return false;
      if (fSrc && r.k.source !== fSrc) return false;
      if (fF && r.k.frequency !== fF) return false;
      if (fSt && r.st.label !== fSt) return false;
      return true;
    });
    const key = scSort.key, dir = scSort.dir;
    rows.sort((a, b) => {
      let va = a[key] != null ? a[key] : (a.k[key] != null ? a.k[key] : ""), vb = b[key] != null ? b[key] : (b.k[key] != null ? b.k[key] : "");
      if (typeof va === "string") return dir * va.localeCompare(vb);
      return dir * ((va || 0) - (vb || 0));
    });
    return rows;
  }
  function renderScorecard() {
    const body = $("#scoreBody"); body.innerHTML = "";
    scoreRows().forEach(r => {
      const tr = el("tr");
      tr.dataset.kid = r.k.id;
      const val = r.d.na ? `<span style="color:var(--na)">—</span>` : `${esc(r.d.txt)}${r.d.unit ? " " + esc(r.d.unit) : ""}`;
      const prev = (r.res && r.res.prev != null) ? fmtNum(r.k, r.res.prev) : "—";
      tr.innerHTML =
        `<td><span class="kid">${r.k.id}</span></td>
         <td><span class="kname">${esc(r.k.name)}</span></td>
         <td style="font-size:11.5px">${esc(cap(r.k.section))}</td>
         <td><span class="badge type-${r.k.type}">${r.k.type}</span></td>
         <td style="font-weight:700;color:var(--ink)">${val}</td>
         <td style="font-size:11.5px">${esc(r.k.unit)}</td>
         <td style="font-size:12px">${prev}</td>
         <td>${trendChip(r.res)}</td>
         <td><span class="status-dot"><span class="d ${r.st.cls}"></span>${r.st.label}</span></td>
         <td style="font-size:11.5px">${esc(r.k.source)}</td>
         <td style="font-size:11.5px">${esc(r.k.frequency)}</td>
         <td style="font-size:11.5px">${r.res && r.res.updated ? fmtDate(r.res.updated) : "—"}</td>
         <td><span class="avail ${r.k.map.avail}">${availLabel(r.k.map.avail)}</span></td>`;
      tr.addEventListener("click", () => openDrawer(r.k.id));
      body.appendChild(tr);
    });
  }
  const cap = s => s.replace(/\b\w/g, c => c.toUpperCase()).replace(/And/g, "&");
  function fmtNum(k, v) { const kind = k.map.unitKind; if (kind === "pct") return v.toFixed(1) + "%"; if (kind === "days") return v.toFixed(1); if (kind === "count1") return v.toFixed(2); if (kind === "ratio_raw") return v.toFixed(2); return Math.round(v).toLocaleString(); }

  /* ======================================================================
   *  DETAIL DRAWER
   * ==================================================================== */
  function openDrawer(id) {
    const k = CATBY[id], res = RES[id]; const d = display(id, res); const st = statusFor(k, res);
    $("#dKid").textContent = id;
    $("#dAvail").textContent = availLabel(k.map.avail); $("#dAvail").className = "avail " + k.map.avail;
    $("#dName").textContent = k.name;
    const body = $("#dBody");
    const valBlock = d.na
      ? `<div class="bigval" style="color:var(--na);font-size:26px">${k.map.avail === "none" ? "Not instrumented" : k.map.avail === "manual" ? "Manual entry" : k.map.avail === "etl" ? "Awaiting ETL sync" : "No data in window"}</div>`
      : `<div class="bigval">${esc(d.txt)}${d.unit ? ` <span style="font-size:18px;color:var(--muted)">${esc(d.unit)}</span>` : ""}</div>
         <div>${trendChip(res)} <span class="status-dot"><span class="d ${st.cls}"></span>${st.label}</span></div>`;

    let comp = "";
    if (res && res.components && Object.keys(res.components).length) {
      const rows = Object.entries(res.components).filter(([, v]) => typeof v !== "object").map(([kk, v]) => `<dt>${esc(labelize(kk))}</dt><dd>${esc(fmtComp(v))}</dd>`).join("");
      if (rows) comp = `<div class="dfield"><div class="lbl">Components (this period)</div><dl class="kv">${rows}</dl></div>`;
    }
    const target = `<div class="dfield"><div class="lbl">Target</div><div class="val">No approved target in the workbook (base ${esc(k.base)}). Attainment is not shown.</div></div>`;

    body.innerHTML =
      valBlock +
      `<div class="dfield"><div class="lbl">Definition</div><div class="val">${esc(k.definition)}</div></div>
       <div class="dfield"><div class="lbl">How it is measured</div><div class="val formula">${esc(k.map.formula)}</div></div>` +
      comp +
      `<div class="detailchart" id="dChart" style="${drawerChartable(id) ? "" : "display:none"}"><canvas id="dCanvas"></canvas></div>` +
      `<div class="dfield"><div class="lbl">Details</div><dl class="kv">
         <dt>Section</dt><dd>${esc(cap(k.section))}</dd>
         <dt>Type</dt><dd>${esc(k.type)}</dd>
         <dt>Unit</dt><dd>${esc(k.unit)}</dd>
         <dt>Frequency</dt><dd>${esc(k.frequency)}</dd>
         <dt>Workbook source</dt><dd>${esc(k.source)}</dd>
         <dt>Live source</dt><dd>${esc(sourceShort(k))}</dd>
         <dt>Supports</dt><dd>${esc(k.supports)}</dd>
         <dt>Checks</dt><dd>${esc(k.checks)}</dd>
         <dt>Data freshness</dt><dd>${res && res.updated ? fmtDate(res.updated) + (k.map.avail === "live" || k.map.avail === "derived" ? " (this session)" : "") : "—"}</dd>
         <dt>Previous period</dt><dd>${res && res.prev != null ? fmtNum(k, res.prev) : "—"}</dd>
       </dl></div>` +
      target +
      (k.map.plannedDate ? `<div class="dfield"><div class="lbl">Rollout</div><div class="val">Planned live <b>${esc(fmtDate(k.map.plannedDate))}</b>. Stages: 0 Not started · 1 In build · 2 Beta · 3 Live.</div></div>` : "") +
      `<div class="callout ${k.map.avail === "none" || k.map.avail === "manual" ? "warn" : "info"}">${esc(k.map.note)}</div>` +
      (k.comment ? `<div class="dfield"><div class="lbl">PM comment (workbook)</div><div class="val">“${esc(k.comment)}”</div></div>` : "") +
      (k.decision ? `<div class="dfield"><div class="lbl">Decision</div><div class="val">${esc(k.decision)}</div></div>` : "");

    // mini historical chart where we have a real series
    drawDrawerChart(id);
    $("#scrim").classList.add("show"); $("#drawer").classList.add("show");
  }
  function closeDrawer() { $("#scrim").classList.remove("show"); $("#drawer").classList.remove("show"); if (charts.dCanvas) { charts.dCanvas.destroy(); delete charts.dCanvas; } }
  const labelize = s => s.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  const fmtComp = v => typeof v === "number" ? (Number.isInteger(v) ? v.toLocaleString() : v.toFixed(2)) : String(v);
  const drawerChartable = id => ["DL1", "DL7", "X1"].includes(id);
  function drawDrawerChart(id) {
    if (!drawerChartable(id)) return;
    const tc = themeColors(); let cfg = null;
    if (id === "DL1") {
      const cur = currentSprint(), sprs = []; for (let n = Math.max(MIN_SPRINT, cur - 5); n <= cur; n++) sprs.push(n);
      const items = DATA.fact_workitems || [], c = sprs.map(n => sprintCommitment([n], items));
      cfg = { type: "line", data: { labels: sprs.map(n => "S" + n), datasets: [{ label: "Delivery %", data: c.map(x => x.rate), borderColor: "#5a5be6", backgroundColor: "rgba(90,91,230,.12)", fill: true, tension: .3, spanGaps: true }] }, options: lineOpts(tc, "%") };
    } else if (id === "DL7") {
      const cyc = (DATA.fact_cycle_time || []).filter(x => x.cycle_days != null && x.released_at).sort((a, b) => a.released_at < b.released_at ? -1 : 1).slice(-30);
      cfg = { type: "line", data: { labels: cyc.map(x => fmtDateShort(x.released_at)), datasets: [{ label: "Cycle days", data: cyc.map(x => num(x.cycle_days)), borderColor: "#0ea89a", backgroundColor: "rgba(14,168,154,.12)", fill: true, tension: .3, pointRadius: 2 }] }, options: lineOpts(tc, "d") };
    } else if (id === "X1") {
      const app = DATA.fact_appstore_metrics || [], byDay = {};
      app.forEach(x => { if (x.platform !== "ios") return; if (!inWin(x.date, WIN)) return; const b = byDay[x.date] || (byDay[x.date] = { s: 0, c: 0 }); if (x.metric === "sessions") b.s += num(x.value); else if (x.metric === "crashes") b.c += num(x.value); });
      const days = Object.keys(byDay).sort();
      cfg = { type: "line", data: { labels: days.map(fmtDateShort), datasets: [{ label: "Crash-free %", data: days.map(d => byDay[d].s > 0 ? 100 * (1 - byDay[d].c / byDay[d].s) : null), borderColor: "#0ea89a", backgroundColor: "rgba(14,168,154,.12)", fill: true, tension: .3, spanGaps: true }] }, options: lineOpts(tc, "%") };
    }
    if (cfg) { if (charts.dCanvas) charts.dCanvas.destroy(); const el2 = document.getElementById("dCanvas"); if (el2) charts.dCanvas = new Chart(el2, cfg); }
  }
  const lineOpts = (tc, suf) => ({ responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 8 } }, y: { grid: { color: tc.grid }, ticks: { callback: v => v + (suf === "%" ? "%" : "") } } } });

  /* ======================================================================
   *  AUTH
   * ==================================================================== */
  function initClient() {
    sbc = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
      auth: { flowType: "pkce", persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
    sbc.auth.onAuthStateChange((_e, session) => onAuth(session));
    sbc.auth.getSession().then(({ data }) => onAuth(data.session));
  }
  async function onAuth(session) {
    if (session && session.user) {
      $("#gate").style.display = "none";
      $("#controlsWrap").style.display = "block";
      $("#dash").style.display = "block";
      $("#signOutBtn").style.display = "inline-flex";
      $("#userBox").textContent = session.user.email || "";
      if (!lastFetch) { await boot(); }
    } else {
      $("#gate").style.display = "block";
      $("#controlsWrap").style.display = "none";
      $("#dash").style.display = "none";
      $("#signOutBtn").style.display = "none";
      $("#userBox").textContent = "";
    }
  }
  async function boot() {
    $("#bootLoading").style.display = "block"; $("#dashContent").style.display = "none";
    try {
      await loadAll();
      $("#bootLoading").style.display = "none"; $("#dashContent").style.display = "block";
      buildFilters(); renderAll();
    } catch (e) {
      console.error(e);
      $("#bootLoading").innerHTML = `<div class="callout warn">Could not load data: ${esc(e.message || e)}</div>`;
    }
  }

  /* ======================================================================
   *  WIRING
   * ==================================================================== */
  function wire() {
    // period segment
    $("#periodSeg").addEventListener("click", e => {
      const b = e.target.closest("button[data-p]"); if (!b) return;
      period = b.dataset.p;
      [...$("#periodSeg").children].forEach(x => x.classList.toggle("active", x === b));
      $("#customRange").classList.toggle("hidden", period !== "custom");
      if (period !== "custom") renderAll();
    });
    $("#applyCustom").addEventListener("click", () => { custom.from = $("#cFrom").value || null; custom.to = $("#cTo").value || null; renderAll(); });
    $("#refreshBtn").addEventListener("click", async () => { const b = $("#refreshBtn"); b.innerHTML = '<span class="spin"></span>'; await loadAll(); renderAll(); b.innerHTML = "↻ Refresh"; });

    // scorecard filters
    ["#scSearch", "#fSection", "#fType", "#fAvail", "#fSource", "#fFreq", "#fStatus"].forEach(s => $(s).addEventListener("input", renderScorecard));
    document.querySelectorAll("#scoreTable th[data-sort]").forEach(th => th.addEventListener("click", () => {
      const key = th.dataset.sort; scSort.dir = (scSort.key === key) ? -scSort.dir : 1; scSort.key = key; renderScorecard();
    }));

    // drawer
    $("#dClose").addEventListener("click", closeDrawer);
    $("#scrim").addEventListener("click", closeDrawer);
    document.addEventListener("keydown", e => { if (e.key === "Escape") closeDrawer(); });

    // sign out
    $("#signOutBtn").addEventListener("click", () => sbc.auth.signOut());

    // auth gate
    $("#gLogin").addEventListener("click", doLogin);
    $("#gPass").addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });
    $("#gMagic").addEventListener("click", async e => { e.preventDefault(); const email = $("#gEmail").value.trim(); if (!email) return err("Enter your email first."); const { error } = await sbc.auth.signInWithOtp({ email, options: { emailRedirectTo: location.href } }); err(error ? error.message : "Magic link sent — check your inbox."); });
    $("#gGoogle").addEventListener("click", async e => { e.preventDefault(); await sbc.auth.signInWithOAuth({ provider: "google", options: { redirectTo: location.href } }); });
  }
  async function doLogin() {
    const email = $("#gEmail").value.trim(), password = $("#gPass").value;
    if (!email || !password) return err("Enter email and password.");
    err(""); $("#gLogin").textContent = "Signing in…";
    const { error } = await sbc.auth.signInWithPassword({ email, password });
    $("#gLogin").textContent = "Sign in";
    if (error) err(error.message);
  }
  const err = m => { $("#gErr").textContent = m || ""; };

  /* ----------------------------- start ----------------------------- */
  document.addEventListener("DOMContentLoaded", () => {
    if (!window.supabase || !CFG.SUPABASE_URL) { document.body.innerHTML = '<div class="loading">Config/Supabase client failed to load.</div>'; return; }
    wire(); initClient();
    // react to OS theme change for charts
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (lastFetch) renderCharts(); });
  });
})();
