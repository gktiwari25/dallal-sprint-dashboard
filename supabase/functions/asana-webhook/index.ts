// Asana webhook -> Supabase Edge Function: REAL-TIME Delivery sync (~1s).
//
// On every task change Asana calls this; we recompute that task's full row EXACTLY
// like the authoritative etl_asana.py (dallal-dashboard-sync), upsert it, then
// rebuild dim_sprint + today's burndown from all rows in Supabase. Supabase
// Realtime pushes the change to the browser instantly. The hourly GitHub Action
// stays only as a nightly backstop (+ --with-flow cycle-time, which this omits).
//
// Deploy (public — Asana can't send a JWT):
//   supabase functions deploy asana-webhook --no-verify-jwt --project-ref dgcxiznnyvhddzsoaxsd
//   supabase secrets set ASANA_PAT=... ASANA_PROJECT_GID=1214388950902741
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ASANA_PAT = Deno.env.get("ASANA_PAT")!;
const PROJECT = Deno.env.get("ASANA_PROJECT_GID") ?? "1214388950902741";
const sb = createClient(SUPABASE_URL, SERVICE_ROLE);
const A = "https://app.asana.com/api/1.0";
const AH = { Authorization: `Bearer ${ASANA_PAT}` };

// Custom-field GIDs (mirror etl_asana.py CF map)
const CF: Record<string, string> = {
  status: "1214389204514067", type: "1214486362368206", priority: "1214488235261634",
  layer: "1214488235497773", repo: "1214486362992044", sprint: "1214486363833795",
  severity: "1214486365153150", efforts_hours: "1214489426851178", found_in: "1214488238671010",
  root_cause: "1214486365532208", release: "1214486860044025", story_points: "1216141249950274",
};
const SECTION_DONE = /UAT Passed|Released|Ready for Production/i;
const TASK_FIELDS =
  "name,completed,completed_at,created_at,modified_at,assignee.name,num_subtasks,parent.gid," +
  "memberships.section.name,memberships.project.gid," +
  "custom_fields.gid,custom_fields.enum_value.name,custom_fields.number_value,custom_fields.text_value";

type Idx = Record<string, any>;
const cfIndex = (t: any): Idx => Object.fromEntries((t.custom_fields ?? []).map((f: any) => [f.gid, f]));
const enumName = (idx: Idx, k: string) => { const f = idx[CF[k]]; const ev = f?.enum_value; return ev ? String(ev.name).trim() : null; };
const numVal = (idx: Idx, k: string) => { const f = idx[CF[k]]; return f?.number_value ?? null; };
const textVal = (idx: Idx, k: string) => { const f = idx[CF[k]]; const v = f?.text_value; return typeof v === "string" ? v.trim() : (v ?? null); };
const sprintNumber = (raw: any) => { if (raw == null) return null; const m = String(raw).match(/(\d+)/); return m ? parseInt(m[1], 10) : null; };
function sectionOf(t: any): string | null {
  for (const m of t.memberships ?? []) {
    const p = m.project?.gid;
    if (m.section?.name && (p == null || p === PROJECT)) return m.section.name;
  }
  return null;
}
// Only top-level members of the tracked project are stories. Subtasks (and tasks
// removed from the board) roll up into their parent's superseded SP — they must
// NOT get their own row (that's what created the orphan "Unestimated" entries).
const isProjectMember = (t: any) => (t.memberships ?? []).some((m: any) => m.project?.gid === PROJECT);

async function computeRow(t: any) {
  const idx = cfIndex(t);
  const section = sectionOf(t);
  const completed = !!t.completed;
  let delivered = completed || (!!section && SECTION_DONE.test(section));

  // Story points + parent-delivered, mirroring etl_derived.py's SUPERSEDE rule in
  // ONE subtask fetch: a parent's own SP is replaced by the SUM of its subtasks'
  // SP when ANY subtask is pointed; the parent is also delivered when ALL its
  // subtasks are completed.
  let sp: number | null = numVal(idx, "story_points");
  if ((t.num_subtasks ?? 0) > 0) {
    const r = await fetch(`${A}/tasks/${t.gid}/subtasks?opt_fields=completed,custom_fields.gid,custom_fields.number_value`, { headers: AH });
    if (r.ok) {
      const subs = (await r.json()).data ?? [];
      if (subs.length) {
        let ssum = 0, anySp = false, allDone = true;
        for (const s of subs) {
          for (const f of s.custom_fields ?? []) {
            if (f.gid === CF.story_points && f.number_value != null) { ssum += f.number_value; anySp = true; }
          }
          if (!s.completed) allDone = false;
        }
        if (anySp) sp = Math.round(ssum * 100) / 100;   // supersede parent's own SP
        if (allDone) delivered = true;
      }
    }
  }
  const type = enumName(idx, "type");
  return {
    task_gid: t.gid,
    name: t.name ?? "",
    sprint: sprintNumber(textVal(idx, "sprint")),
    status: enumName(idx, "status"),
    section,
    type,
    priority: enumName(idx, "priority"),
    severity: enumName(idx, "severity"),
    layer: enumName(idx, "layer"),
    repo: enumName(idx, "repo"),
    found_in: enumName(idx, "found_in"),
    root_cause: enumName(idx, "root_cause"),
    story_points: sp,   // real-time now, via the supersede rule above
    efforts_hours: numVal(idx, "efforts_hours"),
    release: textVal(idx, "release"),
    assignee: t.assignee?.name ?? null,
    is_completed: completed ? 1 : 0,
    is_delivered: delivered ? 1 : 0,
    is_bug: (type ?? "") === "Bug" ? 1 : 0,
    created_at: t.created_at ?? null,
    completed_at: t.completed_at ?? null,
    modified_at: t.modified_at ?? null,
    // NOTE: reopened_count / flow timestamps come from the daily --with-flow run.
  };
}

async function syncTask(gid: string, depth = 0) {
  const r = await fetch(`${A}/tasks/${gid}?opt_fields=${TASK_FIELDS}`, { headers: AH });
  if (!r.ok) return;
  const t = (await r.json()).data;
  if (isProjectMember(t)) {
    await sb.from("fact_workitems").upsert(await computeRow(t), { onConflict: "task_gid" });
  } else {
    // Not a tracked story (a subtask, or a task removed from the board): never keep
    // it as its own row — that pollutes "Unestimated" and risks double-counting.
    // Drop any stale row, and if it's a subtask, re-sync its PARENT so the rolled-up
    // (superseded) story points and delivered status update in real time.
    await sb.from("fact_workitems").delete().eq("task_gid", gid);
    if (t.parent?.gid && depth < 2) await syncTask(t.parent.gid, depth + 1);
  }
}

// Rebuild dim_sprint aggregates + today's burndown snapshot from ALL rows.
async function rebuildAggregates() {
  const { data } = await sb.from("fact_workitems").select("sprint,story_points,is_delivered,completed_at").limit(5000);
  const bySprint: Record<string, any> = {};
  for (const w of data ?? []) {
    const s = w.sprint;
    if (s == null) continue;
    const d = (bySprint[s] ??= { items: 0, committed: 0, delivered: 0, remaining: 0, min: null, max: null });
    d.items++;
    const sp = w.story_points ?? 0;
    d.committed += sp;
    if (w.is_delivered) d.delivered += sp; else d.remaining += sp;
    if (w.completed_at) {
      const dt = String(w.completed_at).slice(0, 10);
      d.min = d.min && d.min < dt ? d.min : dt;
      d.max = d.max && d.max > dt ? d.max : dt;
    }
  }
  const today = new Date().toISOString().slice(0, 10);
  const dim = [], burn = [];
  for (const s of Object.keys(bySprint)) {
    const d = bySprint[s];
    dim.push({
      sprint: Number(s), sprint_label: `Sprint ${s}`,
      inferred_start: d.min, inferred_end: d.max, items: d.items,
      committed_sp: Math.round(d.committed * 10) / 10, delivered_sp: Math.round(d.delivered * 10) / 10,
    });
    burn.push({ snapshot_date: today, sprint: Number(s), remaining_sp: Math.round(d.remaining * 10) / 10 });
  }
  if (dim.length) await sb.from("dim_sprint").upsert(dim, { onConflict: "sprint" });
  if (burn.length) await sb.from("fact_burndown").upsert(burn, { onConflict: "snapshot_date,sprint" });
}

async function hmacHex(secret: string, body: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const getSecret = async () => (await sb.from("asana_webhook").select("secret").eq("id", 1).maybeSingle()).data?.secret ?? null;

const TEST = Deno.args?.[0] === "--test";
const handler = async (req: Request) => {
  const body = await req.text();
  const hookSecret = req.headers.get("x-hook-secret");
  if (hookSecret) { // handshake
    await sb.from("asana_webhook").upsert({ id: 1, secret: hookSecret });
    return new Response("ok", { headers: { "X-Hook-Secret": hookSecret } });
  }
  const sig = req.headers.get("x-hook-signature") ?? "";
  const secret = await getSecret();
  if (secret && sig && (await hmacHex(secret, body)) !== sig) return new Response("bad signature", { status: 401 });

  let payload: any = {}; try { payload = JSON.parse(body); } catch { /* ignore */ }
  const gids = new Set<string>();
  for (const e of payload.events ?? []) if (e.resource?.resource_type === "task" && e.resource?.gid) gids.add(e.resource.gid);
  if (gids.size) {
    await Promise.allSettled([...gids].map(syncTask));
    await rebuildAggregates();
  }
  return new Response("ok");
};

// Local test: `deno run -A index.ts --test <gid>` computes + prints the row
// WITHOUT writing, so we can diff against Supabase/Python before deploy.
if (TEST) {
  const gid = Deno.args[1];
  const r = await fetch(`${A}/tasks/${gid}?opt_fields=${TASK_FIELDS}`, { headers: AH });
  console.log(JSON.stringify(await computeRow((await r.json()).data), null, 2));
} else if (Deno.args?.[0] === "--verify") {
  // Fetch all project tasks, compute rows, diff key fields vs Supabase.
  const tasks: any[] = [];
  let off: string | undefined;
  do {
    const u = new URL(`${A}/tasks`);
    u.searchParams.set("project", PROJECT); u.searchParams.set("opt_fields", TASK_FIELDS); u.searchParams.set("limit", "100");
    if (off) u.searchParams.set("offset", off);
    const j = await (await fetch(u, { headers: AH })).json();
    tasks.push(...(j.data ?? [])); off = j.next_page?.offset;
  } while (off);
  // Rate-limit-safe: compute in small batches so the bulk subtask fetches don't
  // trip Asana's limit (the live webhook only ever handles a handful at once).
  const rows: any[] = [];
  for (let i = 0; i < tasks.length; i += 5) rows.push(...await Promise.all(tasks.slice(i, i + 5).map(computeRow)));
  const cur: Record<string, any> = {};
  const q = await fetch(`${SUPABASE_URL}/rest/v1/fact_workitems?select=*&limit=5000`, { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` } });
  for (const x of await q.json()) cur[x.task_gid] = x;
  const fields = ["name", "sprint", "status", "section", "type", "priority", "story_points", "is_bug", "is_completed", "is_delivered", "layer", "repo", "found_in"];
  const miss: Record<string, number> = {}; const samp: Record<string, string> = {};
  let compared = 0;
  for (const row of rows) {
    const c = cur[row.task_gid]; if (!c) continue; compared++;
    for (const f of fields) {
      let a = c[f], b = (row as any)[f];
      if (["is_bug", "is_completed", "is_delivered"].includes(f)) { a = a ? 1 : 0; b = b ? 1 : 0; }
      if (f === "story_points") { a = a == null ? null : Number(a); b = b == null ? null : Number(b); }
      if (String(a ?? "") !== String(b ?? "")) { miss[f] = (miss[f] ?? 0) + 1; if (!samp[f]) samp[f] = `${JSON.stringify(a)} -> ${JSON.stringify(b)} (${String(c.name).slice(0, 40)})`; }
    }
  }
  console.log(`compared ${compared} tasks`);
  for (const f of fields) console.log(`  ${f.padEnd(14)} ${miss[f] ?? 0}` + (samp[f] ? `   e.g. sb=${samp[f]}` : ""));
} else {
  Deno.serve(handler);
}
