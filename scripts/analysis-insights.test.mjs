// Tests for the FOC-787 Insights panels (scripts/analysis-insights.mjs).
//
// Two layers:
//   1. pure helpers on tiny vectors — every number hand-computed in comments;
//   2. the three panels over a fixture cache built with the REAL buildCache
//      from a fixture store (mkdtemp; the repo's real telemetry.sqlite and the
//      real analysis cache are never touched, no ports, no sockets).
//
// The fixture (all dates 2026; ERA_BOUNDARY = 2026-09-22T00:00:00.000Z):
//
//   run     squad        window              usage rows (cost)
//   rPre    plan         09-20 10:00–11:00   u1  10:30  1.0         → FOC-101
//   rNoLink plan         09-23 10:00–11:00   u12 10:30  0.5         → no link: dropped
//   rPost   dev          09-24 10:00–11:00   u2  10:30  2.0         → FOC-102
//   rHigh   dev          09-25 10:00–11:00   u3  10:30  100.0       → FOC-103 (high outlier)
//   rUnpr   review       09-26 10:00–11:00   u4  10:30  NULL        → FOC-104 (unpriced)
//   rMulti  test         09-27 10:00–11:00   u5  09:00  1.0 pre_link→ FOC-105
//                                            u6  10:15  2.0 window → FOC-105
//                                            u6b 10:15  NULL window→ FOC-105 (unpriced msg)
//                                            u7b 10:25  0.5 window → SUP:X (dropped)
//                                            u7  10:45  4.0 window → FOC-106
//   rSup    supervisor   09-27 08:00–12:00   u8  08:30  0.25 idle
//                                            u9  10:30  1.0  active (rMulti)
//                                            u10 11:20  0.5  adjacent (rMulti, 20 min)
//                                            u11 11:50  0.25 idle (50 min > 30)
//
// Tasks (direct = priced cost of attributed rows; loaded = direct + allocated sup):
//   FOC-101  pre   msgs 1  cost 1     loaded 1      sup 0/0          share 0
//   FOC-102  post  msgs 1  cost 2     loaded 2      sup 0/0          share 0
//   FOC-103  post  msgs 1  cost 100   loaded 100    sup 0/0          share 0
//   FOC-104  post  msgs 1  cost null  loaded null   sup 0/0          share 1     (unpriced)
//   FOC-105  post  msgs 3  cost 3     loaded 3.75   sup 0.5/0.25     share 1/3   (partial)
//   FOC-106  post  msgs 1  cost 4     loaded 4.75   sup 0.5/0.25     share 0
//
// Hand-computed statistics over the five priced tasks [1, 2, 100, 3, 4] (Σ=110):
//   gini: sorted [1,2,3,4,100]; Σ i·x_i = 1+4+9+16+500 = 530;
//         (2·530 − 6·110)/(5·110) = 400/550 = 0.727272… → 0.7273
//   percentiles (numpy linear): p20 h=0.8 → 1.8; p50 = 3; p80 h=3.2 → 4+0.2·96 = 23.2
//   lorenz (21 pts, k(i)=ceil(i·5/20)): cum shares /110 → 0, 1/110, 3/110, 6/110, 10/110, 1
//   top-k: top 1 of 5 (ceil(0.05·5)=1) holds 100/110 = 0.9091 for k=0.05/0.1/0.2
//   outliers on log10: [0, 0.30103, 2, 0.477121, 0.60206] (FOC-104 masked)
//     median = log10(3) = 0.477121; MAD = log10(1.5) = 0.176091
//     z(FOC-103) = 0.6745·1.522879/0.176091 ≈ 5.8332  → |z| > 3.5 flagMad
//     z(FOC-102) = 0.6745·(−0.176091)/0.176091 = −0.6745
//     z(FOC-101) = −0.6745·2.709511 ≈ −1.8277 (direction low)
//     z(FOC-106) = 0.6745·0.124939/0.176091 ≈ 0.4786;  z(FOC-105) = 0 (the median)
//     Tukey: q1 = 0.30103, q3 = 0.60206, IQR = 0.30103; far fences 1.50515 → only
//     log10(100) = 2 is far out (and mild, fence 1.05361) → FOC-103 nFlags = 2 = consensus.
//   sensitivity: median all 3, without consensus [1,2,4] → 2; totals 110 / 10.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { openTelemetryDb } from "./telemetry-store.mjs";
import { ensureViews } from "./telemetry-canonical.mjs";
import { buildCache, CACHE_SCHEMA_VERSION } from "./analysis-cache.mjs";
import { openAnalysisDb, ERA_BOUNDARY } from "./telemetry-analysis.mjs";
import {
  quantiles,
  bootstrapMedianCi,
  gini,
  lorenz,
  hillTail,
  modifiedZ,
  tukeyFlags,
  detectOutliers,
  buildTaskTable,
  allocateSupervisorOverhead,
  addLoadedCost,
  ticketsPanel,
  ticketsPanelFromRows,
  moneyPanel,
  outliersPanel,
} from "./analysis-insights.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) { passed++; return; }
  failed++;
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

const close = (a, b, eps = 1e-3) => a != null && b != null && Math.abs(a - b) < eps;

// ── 1. pure helpers ──────────────────────────────────────────────────────────

// quantiles [1..10], numpy-default linear interpolation:
// p20: h = 9·0.2 = 1.8 → x1 + 0.8·(x2−x1) = 2.8; p50: h = 4.5 → 5.5; p80: h = 7.2 → 8.2
{
  const [p20, p50, p80] = quantiles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  check("quantiles [1..10] p20=2.8", p20 === 2.8, String(p20));
  check("quantiles [1..10] p50=5.5", p50 === 5.5, String(p50));
  check("quantiles [1..10] p80=8.2", p80 === 8.2, String(p80));
  check("quantiles empty → nulls", quantiles([]).every((v) => v === null));
}

// gini: [1,1,1,1] → perfectly equal → 0; [0,0,0,10] → (2·40 − 5·10)/(4·10) = 0.75
{
  check("gini [1,1,1,1] = 0", gini([1, 1, 1, 1]) === 0, String(gini([1, 1, 1, 1])));
  check("gini [0,0,0,10] = 0.75", gini([0, 0, 0, 10]) === 0.75, String(gini([0, 0, 0, 10])));
  check("gini empty → null", gini([]) === null);
  check("gini all-zero → null", gini([0, 0]) === null);
}

// bootstrap: a constant population gives an exactly constant CI; the same seed
// must reproduce the same interval bit-for-bit (the panel's reproducibility
// contract); NaNs are dropped like the notebook's dropna().
{
  const [lo, hi] = bootstrapMedianCi([5, 5, 5]);
  check("bootstrap constant → [5,5]", lo === 5 && hi === 5, `[${lo},${hi}]`);
  const a = bootstrapMedianCi([1, 2, 3, 4, 100], { seed: 42 });
  const b = bootstrapMedianCi([1, 2, 3, 4, 100], { seed: 42 });
  check("bootstrap seed 42 reproducible", JSON.stringify(a) === JSON.stringify(b), `${a} vs ${b}`);
  const [lo2, hi2] = a;
  check("bootstrap CI brackets the median (3)", lo2 <= 3 && 3 <= hi2, `[${lo2},${hi2}]`);
  const [lo3, hi3] = bootstrapMedianCi([1, NaN, 3, null, 3]);
  // dropna → [1,3,3]; P(bootstrap median = 1) = 7/27 ≈ 26% > 2.5%, so the low
  // bound is 1, not 3.
  check("bootstrap drops NaN/null → CI [1,3]", lo3 === 1 && hi3 === 3, `[${lo3},${hi3}]`);
  check("bootstrap empty → [null,null]", bootstrapMedianCi([]).every((v) => v === null));
}

// hillTail (top_share semantics): [1..10] top 20% = ceil(2)=2 units → 19/55 = 0.345455
{
  const shares = hillTail([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [0.2]);
  check("hillTail [1..10] k=0.2 → 19/55", close(shares[0].share, 0.3455, 1e-3), JSON.stringify(shares));
  const degenerate = hillTail([1, 2, 3, 4, 100], [0.05, 0.1, 0.2]);
  check("hillTail top-1-of-5 always 100/110 for k≤0.2",
    degenerate.every((s) => close(s.share, 0.9091, 1e-3)), JSON.stringify(degenerate));
}

// lorenz: 21 points, [0,0] first, [1,1] last; monotone non-decreasing.
{
  const pts = lorenz([0, 0, 0, 10]);
  check("lorenz has 21 points", pts.length === 21, String(pts.length));
  check("lorenz starts [0,0] ends [1,1]",
    pts[0][0] === 0 && pts[0][1] === 0 && pts[20][0] === 1 && pts[20][1] === 1,
    JSON.stringify([pts[0], pts[20]]));
  // n=4: k(i) = ceil(i·4/20) — k(15) = 3 (still 0 cost), k(16) = 4 (all in).
  check("lorenz [0,0,0,10] flat 0 until k covers all four (i=16)",
    close(pts[15][1], 0) && close(pts[16][1], 1), JSON.stringify([pts[15], pts[16]]));
}

// modifiedZ / tukeyFlags on plain numbers (no log floor involved here).
{
  // [1,1,2,3]: med 1.5, MAD 0.5 → z = 0.6745·(v−1.5)/0.5 = 1.349·(v−1.5);
  // ends: v=1 → −0.6745, v=3 → 2.0235.
  const zs = modifiedZ([1, 1, 2, 3]);
  check("modifiedZ ends −0.6745 / 2.0235", close(zs[0], -0.6745, 1e-3) && close(zs[3], 2.0235, 1e-3), JSON.stringify(zs));
  check("modifiedZ constant → nulls", modifiedZ([2, 2, 2]).every((v) => v === null));
  check("modifiedZ keeps null slots", modifiedZ([1, null, 3])[1] === null);

  // [1..10]: q1 3.25, q3 7.75, IQR 4.5 → mild fences −3.5/14.5, far −10.25/21.25 → nothing flags
  const none = tukeyFlags([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  check("tukeyFlags [1..10] nothing flags", none.every((f) => !f.mild && !f.far));
  // [1..10, 100]: q1 3.5, q3 8.5, IQR 5 → 100 > 16 (mild) and > 23.5 (far)
  const flagged = tukeyFlags([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 100]);
  check("tukeyFlags 100 is mild+far", flagged[10].mild && flagged[10].far && !flagged[0].mild, JSON.stringify(flagged[10]));
}

// detectOutliers: unpriced masking (audit BŁĄD-3) — no flags, direction unpriced.
// MAD 0 → z null → np.where(NaN >= 0, …) is False → "low" (matches the notebook).
{
  const out = detectOutliers([{ taskId: "A", costUsd: null }, { taskId: "B", costUsd: 10 }]);
  check("detectOutliers unpriced masked", out[0].direction === "unpriced" && out[0].nFlags === 0 && out[0].madZ === null);
  check("detectOutliers single priced value has no flags (MAD 0 → direction low)",
    out[1].flagMad === false && out[1].nFlags === 0 && out[1].madZ === null && out[1].direction === "low", JSON.stringify(out[1]));
}

// buildTaskTable: the pre_link fallback — a row older than every link of its
// run (no link with valid_from <= the message time) attributes to the run's
// EARLIEST link's task, not to the newest one.
{
  const built = buildTaskTable(
    [{ usageId: "u0", runId: "r1", observedAt: "2026-09-01T08:00:00.000Z", costUsd: 2 }],
    [
      { runId: "r1", taskId: "T-late", validFrom: "2026-09-01T09:00:00.000Z" },
      { runId: "r1", taskId: "T-early", validFrom: "2026-09-01T07:00:00.000Z" },
    ],
  );
  check("buildTaskTable pre_link fallback: row before every link → the earliest link's task",
    built.tasks.size === 1 && built.tasks.get("T-early")?.msgs === 1 &&
    built.tasks.get("T-early")?.costUsd === 2 && built.tasks.get("T-late") == null,
    JSON.stringify([...built.tasks.keys()]));
}

// ── 2. fixture store + real cache ────────────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), "analysis-insights-"));
const dbPath = join(dir, "telemetry.sqlite");
const cacheFile = join(dir, "analysis-cache.sqlite");

{
  const db = openTelemetryDb(dbPath);
  ensureViews(db);

  db.prepare("INSERT INTO price_sets (price_set_id, config_hash, created_at, source) VALUES (?,?,?,?)")
    .run("ps1", "hash1", "2026-09-01T00:00:00.000Z", "test");
  const insertRun = db.prepare(`INSERT INTO runs (run_id, squad, started_at, ended_at, price_set_id, status, updated_at)
    VALUES (?,?,?,?,?,?,'2026-09-01T00:00:00.000Z')`);
  insertRun.run("rPre", "plan", "2026-09-20T10:00:00.000Z", "2026-09-20T11:00:00.000Z", "ps1", "completed");
  insertRun.run("rNoLink", "plan", "2026-09-23T10:00:00.000Z", "2026-09-23T11:00:00.000Z", "ps1", "completed");
  insertRun.run("rPost", "dev", "2026-09-24T10:00:00.000Z", "2026-09-24T11:00:00.000Z", "ps1", "completed");
  insertRun.run("rHigh", "dev", "2026-09-25T10:00:00.000Z", "2026-09-25T11:00:00.000Z", "ps1", "completed");
  insertRun.run("rUnpr", "review", "2026-09-26T10:00:00.000Z", "2026-09-26T11:00:00.000Z", "ps1", "completed");
  insertRun.run("rMulti", "test", "2026-09-27T10:00:00.000Z", "2026-09-27T11:00:00.000Z", "ps1", "completed");
  insertRun.run("rSup", "supervisor", "2026-09-27T08:00:00.000Z", "2026-09-27T12:00:00.000Z", "ps1", "completed");

  const wi = db.prepare("INSERT INTO work_items (task_id, provider, workspace, identifier, created_at) VALUES (?,?,?,?,?)");
  for (const id of ["FOC-101", "FOC-102", "FOC-103", "FOC-104", "FOC-105", "FOC-106"]) {
    wi.run(id, "linear", "jointhubs", id, "2026-09-01T00:00:00.000Z");
  }
  wi.run("SUP:X", "linear", "jointhubs", "SUP:X", "2026-09-01T00:00:00.000Z");

  const link = db.prepare(`INSERT INTO run_task_links
    (link_id, run_id, task_id, role, valid_from, source, confidence, created_at)
    VALUES (?,?,?,?,?,?,?,'2026-09-01T00:00:00.000Z')`);
  link.run("l1", "rPre", "FOC-101", "primary", "2026-09-20T09:00:00.000Z", "test", 1);
  link.run("l2", "rPost", "FOC-102", "primary", "2026-09-24T09:00:00.000Z", "test", 1);
  link.run("l3", "rHigh", "FOC-103", "primary", "2026-09-25T09:00:00.000Z", "test", 1);
  link.run("l4", "rUnpr", "FOC-104", "primary", "2026-09-26T09:00:00.000Z", "test", 1);
  // One ACTIVE primary link per run is a store invariant (partial UNIQUE
  // index); a run that hops between tasks holds the older links superseded —
  // modelled here with role 'session' for the later hops. Attribution reads
  // all links regardless of role.
  link.run("l5", "rMulti", "FOC-105", "primary", "2026-09-27T09:30:00.000Z", "test", 1);
  link.run("l6", "rMulti", "SUP:X", "session", "2026-09-27T10:20:00.000Z", "test", 1);
  link.run("l7", "rMulti", "FOC-106", "session", "2026-09-27T10:30:00.000Z", "test", 1);
  link.run("l8", "rSup", "SUP:X", "primary", "2026-09-27T07:00:00.000Z", "test", 1);

  const usage = db.prepare(`INSERT INTO usage_facts
    (usage_id, run_id, session_id, agent_key, model, observed_at,
     input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
     source_path, source_offset, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const cost = db.prepare("INSERT INTO cost_facts (run_id, usage_id, price_set_id, cost_usd) VALUES (?,?,?,?)");
  const u = (id, run, at, agent, price) => {
    usage.run(id, run, "s1", agent, "m1", at, 100, 50, 0, 0, `/${id}.jsonl`, 10, at);
    if (price != null) cost.run(run, id, "ps1", price);
  };
  u("u1", "rPre", "2026-09-20T10:30:00.000Z", "_lead", 1.0);
  u("u12", "rNoLink", "2026-09-23T10:30:00.000Z", "_lead", 0.5);
  u("u2", "rPost", "2026-09-24T10:30:00.000Z", "_lead", 2.0);
  u("u3", "rHigh", "2026-09-25T10:30:00.000Z", "_lead", 100.0);
  u("u4", "rUnpr", "2026-09-26T10:30:00.000Z", "_lead", null); // no cost_facts row → unpriced
  // 09:00 is before l5's valid_from (09:30), so no link is <= the message
  // time and the pre_link fallback (the run's earliest link) must fire.
  u("u5", "rMulti", "2026-09-27T09:00:00.000Z", "_lead", 1.0);   // pre_link → FOC-105
  u("u6", "rMulti", "2026-09-27T10:15:00.000Z", "worker-1", 2.0); // window → FOC-105
  u("u6b", "rMulti", "2026-09-27T10:15:00.000Z", "worker-2", null); // FOC-105, unpriced msg
  u("u7b", "rMulti", "2026-09-27T10:25:00.000Z", "worker-3", 0.5); // window → SUP:X, dropped
  u("u7", "rMulti", "2026-09-27T10:45:00.000Z", "worker-4", 4.0); // window → FOC-106
  u("u8", "rSup", "2026-09-27T08:30:00.000Z", "_lead", 0.25);  // idle (90 min to rMulti)
  u("u9", "rSup", "2026-09-27T10:30:00.000Z", "_lead", 1.0);   // active on rMulti
  u("u10", "rSup", "2026-09-27T11:20:00.000Z", "_lead", 0.5);  // adjacent (20 min)
  u("u11", "rSup", "2026-09-27T11:50:00.000Z", "_lead", 0.25); // idle (50 min)

  db.close();
}

await buildCache({ storePath: dbPath, cachePath: cacheFile });

const db = openAnalysisDb(cacheFile);

const FILTERS = { from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z", era: "all" };

// ── 2b. the precomputed insight tables (FOC-915) ─────────────────────────────

{
  // The build derived the SAME task table the panels used to compute per
  // request — same rows, same numbers, from the same JS functions.
  const tt = db.prepare("SELECT * FROM insight_task_table ORDER BY task_id").all();
  check("insight_task_table: 6 tasks", tt.length === 6, JSON.stringify(tt.map((r) => r.task_id)));
  const t105 = tt.find((r) => r.task_id === "FOC-105");
  check("insight_task_table FOC-105: msgs 3, cost 3, sup 0.5/0.25, loaded 3.75, partial 1",
    t105.msgs === 3 && t105.cost_usd === 3 && t105.sup_active === 0.5 &&
    t105.sup_adjacent === 0.25 && t105.cost_loaded === 3.75 && t105.partial === 1,
    JSON.stringify(t105));
  const t104 = tt.find((r) => r.task_id === "FOC-104");
  check("insight_task_table FOC-104: unpriced (cost null, loaded null, share 1)",
    t104.cost_usd === null && t104.cost_loaded === null && t104.unpriced_share === 1,
    JSON.stringify(t104));
  check("insight_task_table FOC-101 era pre", tt.find((r) => r.task_id === "FOC-101").era === "pre");

  const sa = db.prepare("SELECT * FROM insight_supervisor_alloc ORDER BY usage_id").all();
  check("insight_supervisor_alloc: 4 supervisor messages", sa.length === 4, JSON.stringify(sa.map((r) => r.usage_id)));
  const u9 = sa.find((r) => r.usage_id === "u9");
  check("insight_supervisor_alloc u9: active, tasks [FOC-105,FOC-106]",
    u9.mode === "active" && JSON.parse(u9.tasks_json).join(",") === "FOC-105,FOC-106", JSON.stringify(u9));
  const u8 = sa.find((r) => r.usage_id === "u8");
  check("insight_supervisor_alloc u8: idle, empty tasks", u8.mode === "idle" && JSON.parse(u8.tasks_json).length === 0);

  const meta = Object.fromEntries(db.prepare("SELECT key, value FROM insight_meta").all().map((r) => [r.key, r.value]));
  check("insight_meta: 1 SUP row dropped ($0.5), 1 unlinked",
    meta.dropped_sup_rows === "1" && meta.dropped_sup_usd === "0.5" && meta.dropped_no_link_rows === "1",
    JSON.stringify(meta));

  // The panels must READ the precomputed rows, not recompute: the panel is
  // fed a SECOND cache built from a store whose FOC-105 row costs differently
  // — readTaskTable is the only source the panel has, so the numbers must
  // follow the table (a panel that recomputed from canonical_usage would be
  // identical on both caches only if it ignored the table — it does not: the
  // poisoned table is the panel's input here, proved by the payload change).
  const poisonDb = new DatabaseSync(cacheFile, { readOnly: false });
  try {
    poisonDb.exec("UPDATE insight_task_table SET cost_usd = 999.0 WHERE task_id = 'FOC-105'");
  } finally {
    poisonDb.close();
  }
  const poisoned = ticketsPanel(db, FILTERS);
  const p105 = poisoned.data.rows.find((r) => r.taskId === "FOC-105");
  check("tickets panel reads the precomputed table (poisoned cost surfaces)",
    p105.costUsd === 999, JSON.stringify(p105));
  const healDb = new DatabaseSync(cacheFile, { readOnly: false });
  try {
    healDb.exec("UPDATE insight_task_table SET cost_usd = 3.0 WHERE task_id = 'FOC-105'");
  } finally {
    healDb.close();
  }
  const restored = ticketsPanel(db, FILTERS);
  check("tickets panel back to the real number after restoring the row",
    restored.data.rows.find((r) => r.taskId === "FOC-105").costUsd === 3, "");
}

// The cache must carry the two new link tables (schema v2 copy list).
{
  const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
  check("cache carries run_task_links + work_items", names.has("run_task_links") && names.has("work_items"));
  check("cache schema version bumped to 3 (FOC-915 adds the insight tables)", CACHE_SCHEMA_VERSION === 3, String(CACHE_SCHEMA_VERSION));
  const rtl = db.prepare("SELECT COUNT(*) AS n FROM run_task_links").get().n;
  check("cache run_task_links rows copied (8)", rtl === 8, String(rtl));
}


// ── 3. ticketsPanel ──────────────────────────────────────────────────────────

{
  const { data, caveats } = ticketsPanel(db, FILTERS);
  check("tickets: definition present", typeof data.definition === "string" && /direct =/.test(data.definition));
  check("tickets: 6 tasks, 5 priced, 1 unpriced",
    data.tasks === 6 && data.priced === 5 && data.unpriced === 1,
    JSON.stringify({ tasks: data.tasks, priced: data.priced, unpriced: data.unpriced }));

  const pre = data.eras.find((e) => e.era === "pre");
  const post = data.eras.find((e) => e.era === "post");
  check("tickets: both eras side by side (era=all)", pre && post && data.eras.length === 2);

  // pre: the single task costs 1 → all percentiles 1, bootstrap CI exactly [1,1].
  check("tickets pre: 1 task, direct p20/p50/p80 = 1",
    pre.tasks === 1 && pre.direct.p20 === 1 && pre.direct.p50 === 1 && pre.direct.p80 === 1,
    JSON.stringify(pre.direct));
  check("tickets pre: medianCi exactly [1,1]",
    pre.direct.medianCi[0] === 1 && pre.direct.medianCi[1] === 1, JSON.stringify(pre.direct.medianCi));
  check("tickets pre: loaded p50 = 1, partial 0",
    pre.loaded.p50 === 1 && pre.partial === 0, JSON.stringify(pre.loaded));

  // post priced directs [2,3,4,100]: p20 h=0.6 → 2.6; p50 h=1.5 → 3.5; p80 h=2.4 → 42.4
  check("tickets post: 5 tasks, direct 2.6/3.5/42.4",
    post.tasks === 5 && post.direct.p20 === 2.6 && post.direct.p50 === 3.5 && post.direct.p80 === 42.4,
    JSON.stringify(post.direct));
  // post loaded [2, 3.75, 4.75, 100]: p20 3.05; p50 4.25; p80 42.85
  check("tickets post: loaded 3.05/4.25/42.85",
    post.loaded.p20 === 3.05 && post.loaded.p50 === 4.25 && post.loaded.p80 === 42.85,
    JSON.stringify(post.loaded));
  check("tickets post: medianCi brackets the median 3.5",
    post.direct.medianCi[0] <= 3.5 && 3.5 <= post.direct.medianCi[1],
    JSON.stringify(post.direct.medianCi));
  check("tickets post: 1 partial (FOC-105)", post.partial === 1, String(post.partial));

  const byId = Object.fromEntries(data.rows.map((r) => [r.taskId, r]));
  check("tickets rows: FOC-105 msgs 3, cost 3, supActive 0.5, supAdjacent 0.25, loaded 3.75",
    byId["FOC-105"].msgs === 3 && byId["FOC-105"].costUsd === 3 &&
    byId["FOC-105"].supActive === 0.5 && byId["FOC-105"].supAdjacent === 0.25 &&
    byId["FOC-105"].costLoaded === 3.75,
    JSON.stringify(byId["FOC-105"]));
  check("tickets rows: FOC-105 unpricedShare 1/3, partial true",
    close(byId["FOC-105"].unpricedShare, 0.3333, 1e-3) && byId["FOC-105"].partial === true,
    JSON.stringify(byId["FOC-105"]));
  check("tickets rows: FOC-104 unpriced (cost null, loaded null, share 1)",
    byId["FOC-104"].costUsd === null && byId["FOC-104"].costLoaded === null &&
    byId["FOC-104"].unpricedShare === 1 && byId["FOC-104"].partial === false,
    JSON.stringify(byId["FOC-104"]));
  check("tickets rows: FOC-106 loaded 4.75", byId["FOC-106"].costLoaded === 4.75, JSON.stringify(byId["FOC-106"]));
  check("tickets rows: FOC-101 era pre", byId["FOC-101"].era === "pre");
  check("tickets rows sorted cost desc", data.rows[0].taskId === "FOC-103", data.rows[0].taskId);

  check("tickets caveats: unpriced_tasks warn",
    caveats.some((c) => c.code === "unpriced_tasks" && c.level === "warn" && c.count === 1),
    JSON.stringify(caveats));
  check("tickets caveats: SUP link dropped with its $0.5",
    caveats.some((c) => c.code === "sup_links_dropped" && c.count === 1 && /0\.5/.test(c.message)),
    JSON.stringify(caveats));
  check("tickets caveats: unattributed row counted",
    caveats.some((c) => c.code === "unattributed_rows" && c.count === 1), JSON.stringify(caveats));

  // D2: era=post shows only the post era (single-entry eras array).
  const postOnly = ticketsPanel(db, { ...FILTERS, era: "post" });
  check("tickets era=post: one era, 5 tasks",
    postOnly.data.eras.length === 1 && postOnly.data.eras[0].era === "post" && postOnly.data.tasks === 5,
    JSON.stringify(postOnly.data.eras));
  check("tickets era=post: FOC-101 absent", !postOnly.data.rows.some((r) => r.taskId === "FOC-101"));

  // A CUSTOM eraBoundary re-derives the era at READ time from first_ts (the
  // persisted era column holds the build-time default): a boundary after
  // FOC-101's first message (2026-09-20) but before the next (2026-09-24)
  // pushes FOC-101 into "pre" — already true — while one BEFORE it flips the
  // whole table to post. Both checked against the read-time derivation.
  const early = ticketsPanel(db, { ...FILTERS, eraBoundary: "2026-09-19T00:00:00.000Z" });
  check("tickets custom eraBoundary 09-19: FOC-101 era flips to post",
    early.data.rows.find((r) => r.taskId === "FOC-101").era === "post", JSON.stringify(early.data.rows.find((r) => r.taskId === "FOC-101")));
  const postEarly = ticketsPanel(db, { ...FILTERS, era: "all", eraBoundary: "2026-09-19T00:00:00.000Z" });
  check("tickets custom eraBoundary 09-19: pre era is empty (all tasks post)",
    postEarly.data.eras.find((e) => e.era === "pre").tasks === 0 &&
    postEarly.data.eras.find((e) => e.era === "post").tasks === 6,
    JSON.stringify(postEarly.data.eras));

  // squad=test keeps the supervisor split alive (the sup rows ignore squad/
  // model): u9 active + u10 adjacent still land on FOC-105 (0.5 + 0.25) and
  // the panel says so in a supervisor_rows_unfiltered caveat.
  const testTickets = ticketsPanel(db, { ...FILTERS, squad: "test" });
  const t105 = testTickets.data.rows.find((r) => r.taskId === "FOC-105");
  check("tickets squad=test: supActive 0.5 / supAdjacent 0.25 survive the squad filter",
    t105 != null && t105.supActive === 0.5 && t105.supAdjacent === 0.25 && t105.costLoaded === 3.75,
    JSON.stringify(t105));
  check("tickets squad=test: supervisor_rows_unfiltered caveat",
    testTickets.caveats.some((c) => c.code === "supervisor_rows_unfiltered" && c.level === "warn"),
    JSON.stringify(testTickets.caveats));
  check("tickets no squad/model → no supervisor_rows_unfiltered caveat",
    !caveats.some((c) => c.code === "supervisor_rows_unfiltered"), JSON.stringify(caveats));
}

// ── 4. moneyPanel ────────────────────────────────────────────────────────────

{
  const { data, caveats } = moneyPanel(db, FILTERS);
  check("money: definition present", typeof data.definition === "string" && /per squad/.test(data.definition));
  // priced rows: 1+2+100+1+2+4+0.5 (test, incl. the SUP-attributed 0.5) + 1.5 (plan)
  // + 0 (review) + 0.25+1+0.5+0.25 (supervisor) = 113.0
  check("money: total 113.0", data.total === 113, String(data.total));
  const squad = Object.fromEntries(data.bySquad.map((r) => [r.squad, r]));
  check("money: bySquad plan 1.5 / dev 102 / review 0 / test 7.5 / supervisor 2",
    squad.plan.costUsd === 1.5 && squad.dev.costUsd === 102 && squad.review.costUsd === 0 &&
    squad.test.costUsd === 7.5 && squad.supervisor.costUsd === 2,
    JSON.stringify(data.bySquad));
  check("money: shares sum to 1 (4dp)",
    close(data.bySquad.reduce((s, r) => s + r.share, 0), 1, 1e-3),
    JSON.stringify(data.bySquad.map((r) => r.share)));
  check("money: dev share 102/113 = 0.9027", close(squad.dev.share, 0.9027, 1e-3), String(squad.dev.share));

  check("money supervisor: 2.0 total, active 1, adjacent 0.5, idle 0.5, idleShare 0.25",
    data.supervisor.costUsd === 2 && data.supervisor.active === 1 &&
    data.supervisor.adjacent === 0.5 && data.supervisor.idle === 0.5 &&
    data.supervisor.idleShare === 0.25,
    JSON.stringify(data.supervisor));

  // concentration over the five priced tasks [1,2,100,3,4]:
  // gini 400/550 = 0.7273; top-k all ceil(0.05·5)=1 → 100/110 = 0.9091;
  // lorenz 21 points [0,0]…[1,1].
  check("money concentration: gini 0.7273", close(data.concentration.gini, 0.7273, 1e-3), String(data.concentration.gini));
  check("money concentration: top k=0.05/0.1/0.2 all 0.9091",
    data.concentration.top.length === 3 &&
    data.concentration.top.every((t) => close(t.share, 0.9091, 1e-3)),
    JSON.stringify(data.concentration.top));
  const lorenzPts = data.concentration.lorenz;
  check("money concentration: lorenz 21 pts, ends [1,1]",
    lorenzPts.length === 21 && lorenzPts[0][0] === 0 && lorenzPts[20][1] === 1, JSON.stringify(lorenzPts));
  check("money concentration: lorenz point 5 = [0.25, 3/110]",
    lorenzPts[5][0] === 0.25 && close(lorenzPts[5][1], 0.0273, 1e-3), JSON.stringify(lorenzPts[5]));

  check("money: no idle-heavy caveat at 25%", !caveats.some((c) => c.code === "sup_idle_heavy"), JSON.stringify(caveats));

  // era=post drops the pre task and its 1.0 → total 112.0
  const postMoney = moneyPanel(db, { ...FILTERS, era: "post" });
  check("money era=post: total 112.0", postMoney.data.total === 112, String(postMoney.data.total));

  // the two windows are stated: rows by observed_at, concentration by first_ts
  check("money caveats: money_mixed_windows stated",
    caveats.some((c) => c.code === "money_mixed_windows" && /message time/.test(c.message)),
    JSON.stringify(caveats));

  // squad=dev keeps the supervisor split (the sup rows ignore squad/model)…
  const devMoney = moneyPanel(db, { ...FILTERS, squad: "dev" });
  check("money squad=dev: supervisor split intact (2.0, active 1 / adjacent 0.5 / idle 0.5)",
    devMoney.data.supervisor.costUsd === 2 && devMoney.data.supervisor.active === 1 &&
    devMoney.data.supervisor.adjacent === 0.5 && devMoney.data.supervisor.idle === 0.5,
    JSON.stringify(devMoney.data.supervisor));
  check("money squad=dev: supervisor_rows_unfiltered caveat",
    devMoney.caveats.some((c) => c.code === "supervisor_rows_unfiltered" && c.level === "warn"),
    JSON.stringify(devMoney.caveats));
  check("money no squad/model → no supervisor_rows_unfiltered caveat",
    !caveats.some((c) => c.code === "supervisor_rows_unfiltered"), JSON.stringify(caveats));

  // era=pre narrows CONCENTRATION to the pre task (FOC-101), but the supervisor
  // split stays message-time-windowed only — the era is a property of the
  // ticket's first_ts, not of the sup rows (the old loadTasks forced era:'all'
  // on them; FOC-915 keeps that). All 4 sup messages are 09-27 (post-eraness
  // aside), so the split stays 2.0 total / active 1 / adjacent 0.5 / idle 0.5.
  const preMoney = moneyPanel(db, { ...FILTERS, era: "pre" });
  check("money era=pre: supervisor split unaffected by the era filter",
    preMoney.data.supervisor.costUsd === 2 && preMoney.data.supervisor.active === 1 &&
    preMoney.data.supervisor.adjacent === 0.5 && preMoney.data.supervisor.idle === 0.5,
    JSON.stringify(preMoney.data.supervisor));
  check("money era=pre: concentration narrowed to the 1 pre task",
    close(preMoney.data.concentration.gini, 0, 1e-3), JSON.stringify(preMoney.data.concentration));
}

// ── 5. outliersPanel ─────────────────────────────────────────────────────────

{
  const { data, caveats } = outliersPanel(db, FILTERS);
  check("outliers: definition present", typeof data.definition === "string" && /log10/.test(data.definition));
  check("outliers: 6 tasks, 1 flagged, detectors mad+tukey, consensusMin 2",
    data.tasks === 6 && data.flagged === 1 && JSON.stringify(data.detectors) === '["mad","tukey"]' &&
    data.consensusMin === 2, JSON.stringify({ tasks: data.tasks, flagged: data.flagged }));

  const byId = Object.fromEntries(data.rows.map((r) => [r.taskId, r]));
  // log10(100) = 2; z ≈ 5.8332 → flagMad; Tukey far fence 1.50515 → far (and mild);
  // nFlags 2 → consensus, direction high.
  check("outliers FOC-103: logCost 2, madZ ≈ 5.8332, both flags, consensus, high",
    byId["FOC-103"].logCost === 2 && close(byId["FOC-103"].madZ, 5.8332, 1e-2) &&
    byId["FOC-103"].flagMad && byId["FOC-103"].flagTukeyMild && byId["FOC-103"].flagTukeyFar &&
    byId["FOC-103"].nFlags === 2 && byId["FOC-103"].consensus && byId["FOC-103"].direction === "high",
    JSON.stringify(byId["FOC-103"]));
  check("outliers FOC-105: the median → madZ 0, no flags",
    byId["FOC-105"].madZ === 0 && byId["FOC-105"].nFlags === 0, JSON.stringify(byId["FOC-105"]));
  check("outliers FOC-102: madZ −0.6745 (exactly one MAD below)",
    close(byId["FOC-102"].madZ, -0.6745, 1e-3), JSON.stringify(byId["FOC-102"]));
  check("outliers FOC-101: direction low (z ≈ −1.8277)",
    close(byId["FOC-101"].madZ, -1.8277, 1e-2) && byId["FOC-101"].direction === "low",
    JSON.stringify(byId["FOC-101"]));
  check("outliers FOC-106: madZ ≈ 0.4786, no flags",
    close(byId["FOC-106"].madZ, 0.4786, 1e-2) && byId["FOC-106"].nFlags === 0, JSON.stringify(byId["FOC-106"]));
  check("outliers FOC-104: masked unpriced (nulls, direction unpriced)",
    byId["FOC-104"].costUsd === null && byId["FOC-104"].logCost === null &&
    byId["FOC-104"].madZ === null && byId["FOC-104"].direction === "unpriced",
    JSON.stringify(byId["FOC-104"]));
  check("outliers rows sorted cost desc (FOC-104 null last)",
    data.rows[0].taskId === "FOC-103" && data.rows[5].taskId === "FOC-104",
    JSON.stringify(data.rows.map((r) => r.taskId)));

  // sensitivity over priced [1,2,3,4,100]: median 3; consensus removes only
  // FOC-103 → [1,2,3,4]: median 2.5, totals 110/10.
  check("outliers sensitivity: medianAll 3, medianWithout 2.5, totalAll 110, totalWithout 10",
    data.sensitivity.medianAll === 3 && data.sensitivity.medianWithout === 2.5 &&
    data.sensitivity.totalAll === 110 && data.sensitivity.totalWithout === 10,
    JSON.stringify(data.sensitivity));

  check("outliers caveats: unpriced masked + notebook detectors note",
    caveats.some((c) => c.code === "unpriced_masked" && c.count === 1) &&
    caveats.some((c) => c.code === "notebook_detectors"),
    JSON.stringify(caveats));

  // era=pre: single task → MAD 0 → z null → no flags, direction "low"
  // (np.where(NaN >= 0, …) is False), not "high".
  const pre = outliersPanel(db, { ...FILTERS, era: "pre" });
  check("outliers era=pre: 1 task, 0 flagged (MAD 0 → z null, direction low)",
    pre.data.tasks === 1 && pre.data.flagged === 0 && pre.data.rows[0].madZ === null &&
    pre.data.rows[0].direction === "low",
    JSON.stringify(pre.data.rows[0]));
}

// ── 6. FOC-915 window semantics ──────────────────────────────────────────────

// no_first_ts: a task row with no timestamp is excluded (no era can be
// provable) and counted — the caveat the pre-FOC-915 panel emitted verbatim.
{
  const { caveats } = ticketsPanelFromRows(
    [{ taskId: "T-1", firstTs: null, era: null, costUsd: 1, costLoaded: 1, msgs: 1, partial: false }],
    FILTERS,
  );
  check("ticketsPanelFromRows: no_first_ts caveat counts the timestamp-less row",
    caveats.some((c) => c.code === "no_first_ts" && c.count === 1), JSON.stringify(caveats));
}

// tasks_by_first_ts: the FOC-915 window semantics caveat fires unconditionally
// on all three panels — tasks are selected by first message and carry their
// full-history cost, even though spend by squad stays message-time windowed.
{
  for (const [name, panel] of [["tickets", ticketsPanel], ["money", moneyPanel], ["outliers", outliersPanel]]) {
    const { caveats } = panel(db, FILTERS);
    check(`${name}: tasks_by_first_ts caveat present`,
      caveats.some((c) => c.code === "tasks_by_first_ts" && c.level === "info"), JSON.stringify(caveats));
  }
}

db.close();

rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

console.log(`${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  FAIL: ${f}`).join("\n"));
  process.exit(1);
}
