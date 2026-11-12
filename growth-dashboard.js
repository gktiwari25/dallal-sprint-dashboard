/* =========================================================================
 * Dallal Growth Dashboard — Acquisition → Activation across Adjust + GA4 +
 * Amplitude. Reads live Supabase tables under the signed-in user's JWT
 * (same auth/RLS as the sprint dashboard). No value is fabricated: a source
 * that isn't synced yet shows "awaiting sync", never a placeholder number.
 *
 *   Adjust    -> fact_adjust_daily  (etl_adjust.py)
 *   GA4       -> fact_ga4_daily      (etl_ga4.py)
 *   Amplitude -> fact_funnels + fact_trends (etl_amplitude.py, already live)
 * ====================================================================== */
(function () {
  "use strict";
  const CFG = window.DALLAL_CONFIG || {};
  const DAY = 86400000;
  let sbc = null, lastFetch = null, period = "30d", custom = { from: null, to: null };
  let DATA = {}, AV = {}, charts = {}, WIN = null;

  /* ------------ utils ------------ */
  const $ = s => document.querySelector(s);
  const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };
  const isoDay = d => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
  const fmtK = n => { if (n == null) return "—"; n = Number(n); if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + "M"; if (Math.abs(n) >= 1e4) return (n / 1e3).toFixed(1) + "k"; if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(2) + "k"; return (Math.round(n * 10) / 10).toLocaleString(); };
  const fmtInt = n => n == null ? "—" : Math.round(n).toLocaleString();
  const pct = (a, b) => (b > 0 ? 100 * a / b : null);
  const fmtPct = v => v == null ? "—" : v.toFixed(1) + "%";
  const fmtDateShort = d => new Date(d).toLocaleDateString(undefined, { day: "2-digit", month: "short" });

  /* ------------ period windows ------------ */
  function windowFor(p) {
    const now = new Date();
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    let from, to = end, label = "";
    if (p === "7d") { from = new Date(end - 6 * DAY); label = "Last 7 days"; }
    else if (p === "30d") { from = new Date(end - 29 * DAY); label = "Last 30 days"; }
    else if (p === "this_month") { from = new Date(now.getFullYear(), now.getMonth(), 1); label = "This month"; }
    else if (p === "last_month") { from = new Date(now.getFullYear(), now.getMonth() - 1, 1); to = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999); label = "Last month"; }
    else if (p === "qtd") { const q = Math.floor(now.getMonth() / 3); from = new Date(now.getFullYear(), q * 3, 1); label = "Quarter to date"; }
    else { from = custom.from ? new Date(custom.from + "T00:00:00") : new Date(end - 29 * DAY); to = custom.to ? new Date(custom.to + "T23:59:59") : end; label = "Custom range"; }
    const len = Math.max(1, Math.round((to - from) / DAY) + 1);
    const prevTo = new Date(from - DAY), prevFrom = new Date(prevTo - (len - 1) * DAY);
    return { from, to, label, len, prevFrom, prevTo, fromISO: isoDay(from), toISO: isoDay(to), pFromISO: isoDay(prevFrom), pToISO: isoDay(prevTo) };
  }
  const inRange = (d, a, b) => d >= a && d <= b;

  /* ------------ data load ------------ */
  async function loadAll() {
    const tables = ["fact_adjust_daily", "fact_ga4_daily", "fact_funnels", "fact_trends"];
    const out = await Promise.all(tables.map(sbSelect));
    tables.forEach((t, i) => { DATA[t] = out[i].rows; AV[t] = out[i]; });
    lastFetch = new Date();
  }
  async function sbSelect(table) {
    let all = [], from = 0, step = 1000, missing = false;
    for (;;) {
      const { data, error } = await sbc.from(table).select("*").range(from, from + step - 1);
      if (error) { missing = true; break; }
      all = all.concat(data || []);
      if (!data || data.length < step) break;
      from += step;
    }
    return { rows: all, missing, empty: !missing && all.length === 0, ok: !missing && all.length > 0 };
  }

  /* ========================================================================
   *  COMPUTE
   * ===================================================================== */
  function sumWin(rows, dateKey, a, b, cols) {
    const t = {}; cols.forEach(c => t[c] = 0); let n = 0;
    rows.forEach(r => { if (inRange(r[dateKey], a, b)) { n++; cols.forEach(c => t[c] += num(r[c])); } });
    t._rows = n; return t;
  }
  const ADJ_COLS = ["installs", "reattributions", "sessions", "daus", "clicks", "impressions", "cost"];
  const GA4_COLS = ["sessions", "total_users", "new_users", "engaged_sessions", "key_events", "page_views"];

  function computeAdjust(w) {
    const rows = DATA.fact_adjust_daily || [];
    const cur = sumWin(rows, "date", w.fromISO, w.toISO, ADJ_COLS);
    const prev = sumWin(rows, "date", w.pFromISO, w.pToISO, ADJ_COLS);
    // by network (installs) within window
    const net = {};
    rows.forEach(r => { if (inRange(r.date, w.fromISO, w.toISO)) net[r.network] = (net[r.network] || 0) + num(r.installs); });
    const networks = Object.entries(net).map(([k, v]) => ({ name: k, installs: v })).sort((a, b) => b.installs - a.installs);
    // daily series
    const daily = {};
    rows.forEach(r => { if (inRange(r.date, w.fromISO, w.toISO)) { const d = daily[r.date] || (daily[r.date] = { installs: 0, reattributions: 0 }); d.installs += num(r.installs); d.reattributions += num(r.reattributions); } });
    return { cur, prev, networks, daily };
  }
  function computeGA4(w) {
    const rows = DATA.fact_ga4_daily || [];
    const cur = sumWin(rows, "date", w.fromISO, w.toISO, GA4_COLS);
    const prev = sumWin(rows, "date", w.pFromISO, w.pToISO, GA4_COLS);
    const ch = {};
    rows.forEach(r => { if (inRange(r.date, w.fromISO, w.toISO)) ch[r.channel] = (ch[r.channel] || 0) + num(r.sessions); });
    const channels = Object.entries(ch).map(([k, v]) => ({ name: k, sessions: v })).sort((a, b) => b.sessions - a.sessions);
    const daily = {};
    rows.forEach(r => { if (inRange(r.date, w.fromISO, w.toISO)) { const d = daily[r.date] || (daily[r.date] = { sessions: 0, new_users: 0 }); d.sessions += num(r.sessions); d.new_users += num(r.new_users); } });
    return { cur, prev, channels, daily };
  }
  /* Amplitude activation funnel + retention — a current snapshot (not windowed). */
  function computeAmplitude() {
    const rows = (DATA.fact_funnels || []);
    if (!rows.length) return { funnel: null, retention: null, env: null, platform: null };
    // choose env/platform with data: prefer PROD + All
    const envs = [...new Set(rows.map(r => r.env))];
    const env = envs.includes("PROD") ? "PROD" : envs[0];
    const plats = [...new Set(rows.filter(r => r.env === env).map(r => r.platform))];
    const platform = plats.includes("All") ? "All" : plats[0];
    const scope = rows.filter(r => r.env === env && r.platform === platform);
    // retention pseudo-funnel: window_days==0 or name contains retention
    const retRows = scope.filter(r => Number(r.window_days) === 0 || /retention/i.test(r.funnel || ""));
    let retention = null;
    if (retRows.length) {
      const name = retRows[0].funnel;
      const steps = retRows.filter(r => r.funnel === name).sort((a, b) => a.step_index - b.step_index)
        .map(r => ({ label: r.step_name, users: num(r.users) }));
      if (steps.length > 1) retention = { name, steps, w1: pct(steps[1].users, steps[0].users) };
    }
    // activation funnel: non-retention, prefer a listing/registration/activation funnel, else biggest
    const funnelRows = scope.filter(r => Number(r.window_days) !== 0 && !/retention/i.test(r.funnel || ""));
    const byName = {};
    funnelRows.forEach(r => (byName[r.funnel] = byName[r.funnel] || []).push(r));
    const names = Object.keys(byName);
    let chosen = names.find(n => /listing creation|registration|activation|sign ?up|onboard/i.test(n));
    if (!chosen && names.length) chosen = names.sort((a, b) => {
      const s0 = f => Math.max(...byName[f].map(r => num(r.users))); return s0(b) - s0(a);
    })[0];
    let funnel = null;
    if (chosen) {
      const steps = byName[chosen].sort((a, b) => a.step_index - b.step_index).map(r => ({ label: r.step_name, users: num(r.users) }));
      if (steps.length) funnel = { name: chosen, steps, conv: pct(steps[steps.length - 1].users, steps[0].users), env, platform };
    }
    return { funnel, retention, env, platform };
  }
  /* App active users from Amplitude trends (DAU chart) or Adjust DAU fallback */
  function computeActive(w, adj) {
    const tr = (DATA.fact_trends || []).filter(r => /active user|dau/i.test(r.chart || "") && inRange(r.date, w.fromISO, w.toISO));
    if (tr.length) {
      const byDate = {}; tr.forEach(r => byDate[r.date] = (byDate[r.date] || 0) + num(r.value));
      const vals = Object.values(byDate); const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      return { value: avg, src: "amplitude", unit: "avg daily" };
    }
    // Adjust daus averaged over days present
    const rows = (DATA.fact_adjust_daily || []).filter(r => inRange(r.date, w.fromISO, w.toISO));
    if (rows.length) {
      const byDate = {}; rows.forEach(r => byDate[r.date] = (byDate[r.date] || 0) + num(r.daus));
      const vals = Object.values(byDate).filter(v => v > 0);
      if (vals.length) return { value: vals.reduce((a, b) => a + b, 0) / vals.length, src: "adjust", unit: "avg daily" };
    }
    return { value: null, src: null };
  }

  /* ========================================================================
   *  RENDER
   * ===================================================================== */
  let ADJ, G4, AM, ACT;
  function renderAll() {
    WIN = windowFor(period);
    ADJ = computeAdjust(WIN); G4 = computeGA4(WIN); AM = computeAmplitude(); ACT = computeActive(WIN, ADJ);
    $("#topSub").textContent = WIN.label + " · vs previous " + WIN.len + "d";
    renderHealth(); renderTiles(); renderFunnel(); renderAcquisition(); renderWeb(); renderActivation(); renderBlend();
    $("#refreshedAt").innerHTML = "Last refreshed <b>" + lastFetch.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + "</b>";
    $("#footerNote").innerHTML = `Growth dashboard · <b>Adjust</b> (installs/attribution) → <b>GA4</b> (web &amp; app traffic) → <b>Amplitude</b> (activation &amp; retention). ` +
      `Delivery data is live from Supabase under your account; un-synced sources show “awaiting sync”. No value is fabricated.`;
  }

  const srcState = tbl => { const a = AV[tbl] || {}; return a.ok ? "ok" : a.empty ? "warn" : "bad"; };
  function renderHealth() {
    const box = $("#srcHealth"); box.innerHTML = "";
    const defs = [
      { n: "Adjust", t: "fact_adjust_daily", u: "rows" },
      { n: "GA4", t: "fact_ga4_daily", u: "rows" },
      { n: "Amplitude funnels", t: "fact_funnels", u: "rows" },
      { n: "Amplitude trends", t: "fact_trends", u: "rows" },
    ];
    defs.forEach(d => {
      const a = AV[d.t] || {}; const cls = srcState(d.t);
      const note = a.missing ? "not deployed" : a.empty ? "awaiting sync" : `${a.rows.length} ${d.u}`;
      box.appendChild(el("div", "srcpill", `<span class="dot ${cls}"></span>${esc(d.n)} <span style="opacity:.7">· ${note}</span>`));
    });
  }

  function trendChip(cur, prev, higherGood) {
    if (cur == null || prev == null || prev === 0) return `<span class="trend flat">—</span>`;
    const d = cur - prev, p = 100 * d / Math.abs(prev);
    if (Math.abs(p) < 0.5) return `<span class="trend flat">—</span>`;
    const up = d > 0, good = higherGood ? up : !up;
    return `<span class="trend ${good ? "up" : "down"}">${up ? "▲" : "▼"} ${Math.abs(p).toFixed(0)}%</span>`;
  }

  function tile(kid, srcCls, srcLabel, title, valHtml, trend, note) {
    return `<div class="card"><div style="display:flex;align-items:center;gap:8px">
        <span class="srcbadge ${srcCls}">${srcLabel}</span></div>
      <div class="ktitle">${esc(title)}</div>${valHtml}
      <div class="kmeta">${trend || ""}${note ? `<span class="src">${note}</span>` : ""}</div></div>`;
  }
  const bigVal = (txt, na) => na ? `<div class="kval na">${esc(txt)}</div>` : `<div class="kval">${esc(txt)}</div>`;

  function renderTiles() {
    const g = $("#topGrid"); const cards = [];
    const adjOk = AV.fact_adjust_daily && AV.fact_adjust_daily.ok;
    const g4Ok = AV.fact_ga4_daily && AV.fact_ga4_daily.ok;
    const amOk = (DATA.fact_funnels || []).length > 0;
    const await_ = tbl => (AV[tbl] && AV[tbl].missing) ? "Awaiting sync" : "No data";

    // Installs (Adjust)
    cards.push(tile("installs", "adjust", "Adjust", "Installs",
      adjOk ? bigVal(fmtInt(ADJ.cur.installs)) : bigVal(await_("fact_adjust_daily"), true),
      adjOk ? trendChip(ADJ.cur.installs, ADJ.prev.installs, true) : "", "net of reattribution"));
    // New web users (GA4)
    cards.push(tile("newusers", "ga4", "GA4", "New users (web + app)",
      g4Ok ? bigVal(fmtInt(G4.cur.new_users)) : bigVal(await_("fact_ga4_daily"), true),
      g4Ok ? trendChip(G4.cur.new_users, G4.prev.new_users, true) : "", "first-time users"));
    // Active users (Amplitude/Adjust)
    cards.push(tile("active", ACT.src === "adjust" ? "adjust" : "amplitude", ACT.src === "adjust" ? "Adjust" : "Amplitude", "Active users",
      ACT.value != null ? bigVal(fmtInt(ACT.value)) : bigVal("Awaiting sync", true), "", ACT.unit || "avg daily"));
    // Activation rate (Amplitude)
    cards.push(tile("activation", "amplitude", "Amplitude", "Activation rate",
      (amOk && AM.funnel) ? bigVal(fmtPct(AM.funnel.conv)) : bigVal(amOk ? "No funnel" : "Awaiting sync", true), "",
      (amOk && AM.funnel) ? esc(shortName(AM.funnel.name)) : "in-app funnel"));
    // W1 retention (Amplitude)
    cards.push(tile("retention", "amplitude", "Amplitude", "Week-1 retention",
      (amOk && AM.retention && AM.retention.w1 != null) ? bigVal(fmtPct(AM.retention.w1)) : bigVal(amOk ? "No data" : "Awaiting sync", true), "", "new-user cohort"));
    // Ad spend / CPI (Adjust)
    const spend = adjOk ? ADJ.cur.cost : null, cpi = (adjOk && ADJ.cur.installs > 0 && ADJ.cur.cost > 0) ? ADJ.cur.cost / ADJ.cur.installs : null;
    cards.push(tile("spend", "adjust", "Adjust", "Ad spend · CPI",
      adjOk ? bigVal(spend > 0 ? ("$" + fmtK(spend)) : "—") : bigVal(await_("fact_adjust_daily"), true),
      "", cpi != null ? ("CPI $" + cpi.toFixed(2)) : "no cost linked"));

    g.innerHTML = cards.join("");
  }
  const shortName = n => n.length > 26 ? n.slice(0, 24) + "…" : n;

  /* ---- the three-lane funnel ---- */
  function laneStages(laneCls, stages) {
    const max = Math.max(...stages.map(s => s.value || 0), 1);
    return stages.map((s, i) => {
      const w = s.value != null ? Math.max(2, 100 * s.value / max) : 0;
      const conv = (i > 0 && stages[i - 1].value > 0 && s.value != null)
        ? `<div class="conv">↳ <b>${(100 * s.value / stages[i - 1].value).toFixed(1)}%</b> from ${esc(stages[i - 1].label)}</div>` : "";
      const val = s.value == null ? `<span class="stage-val na">—</span>` : `<span class="stage-val">${fmtK(s.value)}</span>`;
      return `<div class="stage"><div class="stage-top"><span class="stage-label">${esc(s.label)}</span>${val}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${w}%"></div></div>${conv}</div>`;
    }).join("");
  }
  function renderFunnel() {
    const f = $("#funnel"); f.innerHTML = "";
    const adjOk = AV.fact_adjust_daily && AV.fact_adjust_daily.ok;
    const g4Ok = AV.fact_ga4_daily && AV.fact_ga4_daily.ok;

    // Lane 1 — Adjust acquisition
    let l1;
    if (adjOk) {
      const st = [
        { label: "Impressions", value: ADJ.cur.impressions || null },
        { label: "Clicks", value: ADJ.cur.clicks || null },
        { label: "Installs", value: ADJ.cur.installs },
      ].filter(s => s.value != null || s.label === "Installs");
      const ir = (ADJ.cur.clicks > 0) ? pct(ADJ.cur.installs, ADJ.cur.clicks) : null;
      l1 = laneCard("adjust", "Adjust", "Acquisition", st, "Install rate", ir == null ? "—" : ir.toFixed(1) + "%", "Current period");
    } else l1 = laneAwaiting("adjust", "Adjust", "Acquisition", "fact_adjust_daily");

    // Lane 2 — GA4 web/app traffic
    let l2;
    if (g4Ok) {
      const st = [
        { label: "Sessions", value: G4.cur.sessions },
        { label: "Engaged sessions", value: G4.cur.engaged_sessions },
        { label: "Key events", value: G4.cur.key_events || null },
      ];
      const er = pct(G4.cur.engaged_sessions, G4.cur.sessions);
      l2 = laneCard("ga4", "GA4", "Web & app traffic", st, "Engagement", er == null ? "—" : er.toFixed(1) + "%", "Current period");
    } else l2 = laneAwaiting("ga4", "GA4", "Web & app traffic", "fact_ga4_daily");

    // Lane 3 — Amplitude activation
    let l3;
    if (AM.funnel) {
      const st = AM.funnel.steps.map(s => ({ label: s.label, value: s.users }));
      l3 = laneCard("amplitude", "Amplitude", "In-app activation", st, "End-to-end",
        AM.funnel.conv == null ? "—" : AM.funnel.conv.toFixed(1) + "%",
        `${AM.env} · ${AM.platform} · ${shortName(AM.funnel.name)}`);
    } else l3 = laneAwaiting("amplitude", "Amplitude", "In-app activation", "fact_funnels");

    f.innerHTML = l1 + l2 + l3;
  }
  function laneCard(cls, badge, title, stages, footLabel, footBig, subName) {
    return `<div class="lane ${cls}"><div class="lane-head"><span class="srcbadge ${cls}">${badge}</span><h3>${esc(title)}</h3></div>
      <div class="lane-sub">${esc(subName || "Current period")}</div>
      ${laneStages(cls, stages)}
      <div class="lane-foot"><span>${esc(footLabel)}</span><span class="big">${esc(footBig)}</span></div></div>`;
  }
  function laneAwaiting(cls, badge, title, tbl) {
    const a = AV[tbl] || {};
    const msg = a.missing
      ? `Table <span class="mono">${tbl}</span> not created yet. Apply <span class="mono">sql/fact_growth.sql</span> and run the ETL.`
      : `No data yet. Add credentials and run the ETL to populate <span class="mono">${tbl}</span>.`;
    return `<div class="lane ${cls} awaiting"><div class="lane-head"><span class="srcbadge ${cls}">${badge}</span><h3>${esc(title)}</h3></div>
      <div class="lane-sub">Awaiting sync</div><div class="await-note">${msg}</div></div>`;
  }

  /* ---- breakdown tables ---- */
  function rankTable(items, valKey, valFmt, chipbg) {
    if (!items.length) return `<div class="await-note">No rows in this period.</div>`;
    const max = Math.max(...items.map(i => i[valKey]), 1);
    const total = items.reduce((a, b) => a + b[valKey], 0);
    const body = items.slice(0, 8).map(it => {
      const w = (100 * it[valKey] / max).toFixed(1);
      const share = total > 0 ? (100 * it[valKey] / total).toFixed(0) : 0;
      return `<tr><td class="rankbar" style="--w:${w}%;--chipbg:${chipbg}"><span>${esc(it.name || "—")}</span></td>
        <td>${valFmt(it[valKey])}</td><td style="color:var(--muted)">${share}%</td></tr>`;
    }).join("");
    return `<table class="bd"><thead><tr><th>Source</th><th>Value</th><th>Share</th></tr></thead><tbody>${body}</tbody></table>`;
  }
  function renderAcquisition() {
    $("#adjustNetworks").innerHTML = (AV.fact_adjust_daily && AV.fact_adjust_daily.ok)
      ? rankTable(ADJ.networks, "installs", fmtInt, "rgba(245,140,63,.14)")
      : `<div class="await-note">Adjust not synced yet — add <span class="mono">ADJUST_API_TOKEN</span> and run <span class="mono">etl_adjust.py</span>.</div>`;
    const tc = themeColors();
    const d = ADJ ? ADJ.daily : {}; const days = Object.keys(d).sort();
    mkChart("chartInstalls", {
      type: "bar",
      data: { labels: days.map(fmtDateShort), datasets: [
        { label: "Installs", data: days.map(x => d[x].installs), backgroundColor: "#f5883f", borderRadius: 5 },
        { label: "Reattributions", data: days.map(x => d[x].reattributions), backgroundColor: "rgba(245,140,63,.4)", borderRadius: 5 },
      ] },
      options: barOpts(tc, true),
    });
    if (!days.length) emptyNote("chartInstalls", adjAwaitMsg());
  }
  function renderWeb() {
    $("#ga4Channels").innerHTML = (AV.fact_ga4_daily && AV.fact_ga4_daily.ok)
      ? rankTable(G4.channels, "sessions", fmtInt, "rgba(47,109,246,.12)")
      : `<div class="await-note">GA4 not synced yet — add <span class="mono">GA4_PROPERTY_ID</span> + service account and run <span class="mono">etl_ga4.py</span>.</div>`;
    const tc = themeColors();
    const d = G4 ? G4.daily : {}; const days = Object.keys(d).sort();
    mkChart("chartSessions", {
      type: "line",
      data: { labels: days.map(fmtDateShort), datasets: [
        { label: "Sessions", data: days.map(x => d[x].sessions), borderColor: "#2f6df6", backgroundColor: "rgba(47,109,246,.12)", fill: true, tension: .3, pointRadius: 0 },
        { label: "New users", data: days.map(x => d[x].new_users), borderColor: "#5a8bf6", borderDash: [5, 4], tension: .3, pointRadius: 0 },
      ] },
      options: lineOpts(tc),
    });
    if (!days.length) emptyNote("chartSessions", "GA4 not synced yet");
  }
  function renderActivation() {
    const tc = themeColors();
    if (AM.funnel) {
      $("#actFunnelSub").textContent = `${AM.env} · ${AM.platform} · ${shortName(AM.funnel.name)}`;
      const s = AM.funnel.steps;
      mkChart("chartActFunnel", {
        type: "bar",
        data: { labels: s.map(x => x.label), datasets: [{ label: "Users", data: s.map(x => x.users), backgroundColor: "#7c3aed", borderRadius: 5 }] },
        options: Object.assign(barOpts(tc, false), { indexAxis: "y" }),
      });
    } else { mkChart("chartActFunnel", emptyChart()); emptyNote("chartActFunnel", amAwaitMsg()); }

    if (AM.retention) {
      $("#retSub").textContent = shortName(AM.retention.name);
      const s = AM.retention.steps, base = s[0].users || 1;
      mkChart("chartRetention", {
        type: "line",
        data: { labels: s.map(x => x.label), datasets: [{ label: "Retained %", data: s.map(x => 100 * x.users / base), borderColor: "#7c3aed", backgroundColor: "rgba(124,58,237,.12)", fill: true, tension: .3 }] },
        options: Object.assign(lineOpts(tc), { scales: { x: { grid: { display: false } }, y: { grid: { color: tc.grid }, ticks: { callback: v => v + "%" }, suggestedMin: 0, suggestedMax: 100 } } }),
      });
    } else { mkChart("chartRetention", emptyChart()); emptyNote("chartRetention", amAwaitMsg()); }
  }
  function renderBlend() {
    const tc = themeColors();
    const dates = new Set();
    Object.keys(ADJ.daily || {}).forEach(d => dates.add(d));
    Object.keys(G4.daily || {}).forEach(d => dates.add(d));
    const days = [...dates].sort();
    mkChart("chartBlend", {
      type: "line",
      data: { labels: days.map(fmtDateShort), datasets: [
        { label: "Installs (Adjust)", data: days.map(d => ADJ.daily[d] ? ADJ.daily[d].installs : null), borderColor: "#f5883f", backgroundColor: "rgba(245,140,63,.1)", fill: false, tension: .3, spanGaps: true, pointRadius: 0 },
        { label: "Web sessions (GA4)", data: days.map(d => G4.daily[d] ? G4.daily[d].sessions : null), borderColor: "#2f6df6", backgroundColor: "rgba(47,109,246,.1)", fill: false, tension: .3, spanGaps: true, pointRadius: 0, yAxisID: "y1" },
      ] },
      options: { responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false }, plugins: { legend: { position: "bottom" } },
        scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 10 } },
          y: { position: "left", grid: { color: tc.grid }, title: { display: true, text: "Installs" } },
          y1: { position: "right", grid: { display: false }, title: { display: true, text: "Sessions" } } } },
    });
    if (!days.length) emptyNote("chartBlend", "Add Adjust and/or GA4 credentials to populate this chart");
  }
  const adjAwaitMsg = () => (AV.fact_adjust_daily && AV.fact_adjust_daily.missing) ? "Apply sql/fact_growth.sql + run etl_adjust.py" : "Adjust not synced yet";
  const amAwaitMsg = () => (DATA.fact_funnels || []).length ? "No matching funnel in fact_funnels" : "Amplitude funnels not loaded";

  /* ---- chart helpers ---- */
  function themeColors() { const dark = matchMedia("(prefers-color-scheme: dark)").matches; return { grid: dark ? "rgba(180,189,214,.14)" : "rgba(68,80,106,.12)", tick: dark ? "#b4bdd6" : "#44506a" }; }
  function mkChart(id, cfg) { if (charts[id]) charts[id].destroy(); const c = document.getElementById(id); if (c) { Chart.defaults.font.family = "Inter, system-ui, sans-serif"; Chart.defaults.color = themeColors().tick; charts[id] = new Chart(c, cfg); } }
  const barOpts = (tc, stacked) => ({ responsive: true, maintainAspectRatio: false, plugins: { legend: { display: stacked, position: "bottom" } }, scales: { x: { stacked, grid: { display: false }, ticks: { maxTicksLimit: 10 } }, y: { stacked, beginAtZero: true, grid: { color: tc.grid } } } });
  const lineOpts = tc => ({ responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" } }, scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 10 } }, y: { beginAtZero: true, grid: { color: tc.grid } } } });
  const emptyChart = () => ({ type: "bar", data: { labels: [], datasets: [] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } } });
  function emptyNote(id, msg) { const c = document.getElementById(id); if (c && c.parentElement) { const n = el("div", "", esc(msg)); n.style.cssText = "position:absolute;inset:0;display:grid;place-items:center;color:var(--muted);font-size:12.5px;text-align:center;padding:0 20px"; c.parentElement.appendChild(n); } }

  /* ========================================================================
   *  AUTH  (same PKCE flow as the sprint dashboard)
   * ===================================================================== */
  function initClient() {
    sbc = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, { auth: { flowType: "pkce", persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
    sbc.auth.onAuthStateChange((_e, s) => onAuth(s));
    sbc.auth.getSession().then(({ data }) => onAuth(data.session));
  }
  async function onAuth(session) {
    if (session && session.user) {
      $("#gate").style.display = "none"; $("#controlsWrap").style.display = "block"; $("#dash").style.display = "block";
      $("#signOutBtn").style.display = "inline-flex"; $("#userBox").textContent = session.user.email || "";
      if (!lastFetch) await boot();
    } else {
      $("#gate").style.display = "block"; $("#controlsWrap").style.display = "none"; $("#dash").style.display = "none";
      $("#signOutBtn").style.display = "none"; $("#userBox").textContent = "";
    }
  }
  async function boot() {
    $("#bootLoading").style.display = "block"; $("#dashContent").style.display = "none";
    try { await loadAll(); $("#bootLoading").style.display = "none"; $("#dashContent").style.display = "block"; renderAll(); }
    catch (e) { console.error(e); $("#bootLoading").innerHTML = `<div class="callout warn">Could not load data: ${esc(e.message || e)}</div>`; }
  }

  /* ------------ wiring ------------ */
  function wire() {
    $("#periodSeg").addEventListener("click", e => {
      const b = e.target.closest("button[data-p]"); if (!b) return;
      period = b.dataset.p; [...$("#periodSeg").children].forEach(x => x.classList.toggle("active", x === b));
      $("#customRange").classList.toggle("hidden", period !== "custom"); if (period !== "custom") renderAll();
    });
    $("#applyCustom").addEventListener("click", () => { custom.from = $("#cFrom").value || null; custom.to = $("#cTo").value || null; renderAll(); });
    $("#refreshBtn").addEventListener("click", async () => { const b = $("#refreshBtn"); b.innerHTML = '<span class="spin"></span>'; await loadAll(); renderAll(); b.innerHTML = "↻ Refresh"; });
    $("#signOutBtn").addEventListener("click", () => sbc.auth.signOut());
    $("#gLogin").addEventListener("click", doLogin);
    $("#gPass").addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });
    $("#gMagic").addEventListener("click", async e => { e.preventDefault(); const email = $("#gEmail").value.trim(); if (!email) return gerr("Enter your email first."); const { error } = await sbc.auth.signInWithOtp({ email, options: { emailRedirectTo: location.href } }); gerr(error ? error.message : "Magic link sent — check your inbox."); });
    $("#gGoogle").addEventListener("click", async e => { e.preventDefault(); await sbc.auth.signInWithOAuth({ provider: "google", options: { redirectTo: location.href } }); });
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (lastFetch) renderAll(); });
  }
  async function doLogin() {
    const email = $("#gEmail").value.trim(), password = $("#gPass").value;
    if (!email || !password) return gerr("Enter email and password.");
    gerr(""); $("#gLogin").textContent = "Signing in…";
    const { error } = await sbc.auth.signInWithPassword({ email, password });
    $("#gLogin").textContent = "Sign in"; if (error) gerr(error.message);
  }
  const gerr = m => { $("#gErr").textContent = m || ""; };

  document.addEventListener("DOMContentLoaded", () => {
    if (!window.supabase || !CFG.SUPABASE_URL) { document.body.innerHTML = '<div class="loading">Config/Supabase client failed to load.</div>'; return; }
    wire(); initClient();
  });
})();
