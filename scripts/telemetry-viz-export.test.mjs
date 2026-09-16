// scripts/telemetry-viz-export.test.mjs — every F2_cost series carries the
// unpriced count (FOC-221 review round 1).
//
// The exporter's own header promises: "`unpriced` counts are exported next to
// every cost figure, never folded in." costBySquad and costByModel kept that
// promise (SUM(cost_usd IS NULL) AS unpriced); costByWeek, leadVsSub and
// costByRole did not — three series where NULL-cost turns silently vanished
// from view. This suite builds a fixture store in a temp dir (never the live
// one), runs the CLI against it via the LA_TELEMETRY_DB seam, and asserts:
//   - the three fixed series each carry `unpriced`, counted not folded,
//   - shape parity with costBySquad/costByModel (same four fields per row),
//   - the exact fixture numbers, so a wrong bucket or a folded NULL goes red.
//
// MUTATION GUIDE (the suite must fail if the derivation is broken): in any of
// the three series change `SUM(cost_usd IS NULL)` to `SUM(cost_usd IS NOT
// NULL)` — the ground-truth asserts below go red. Dropping the column from any
// series breaks the shape-parity check.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openTelemetryDb } from "./telemetry-store.mjs";
import { ensureViews } from "./telemetry-canonical.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "telemetry-viz-export.mjs");

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) { passed++; return; }
  failed++;
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

const close = (a, b) => Math.abs(a - b) < 1e-9;

const temp = mkdtempSync(join(tmpdir(), "telemetry-viz-export-test-"));
const dbPath = join(temp, "t.sqlite");
const db = openTelemetryDb(dbPath);

// --- fixture: 7 canonical calls across 2 squads×roles, 2 weeks, 2 unpriced --
db.prepare("INSERT INTO price_sets (price_set_id, config_hash, created_at, source) VALUES (?,?,?,?)")
  .run("ps1", "hash", "2026-08-01T00:00:00.000Z", "test");
const insertRun = db.prepare(`INSERT INTO runs (run_id, squad, started_at, ended_at, price_set_id, status, updated_at)
  VALUES (?,?,?,?,?,'completed','2026-09-01T00:00:00.000Z')`);
const usage = db.prepare(`INSERT INTO usage_facts
  (usage_id, run_id, session_id, agent_key, model, observed_at,
   input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
   source_path, source_offset, created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const cost = db.prepare("INSERT INTO cost_facts (run_id, usage_id, price_set_id, cost_usd) VALUES (?,?,?,?)");

insertRun.run("runA", "dev", "2026-08-20T09:00:00.000Z", "2026-08-20T11:00:00.000Z", "ps1");
insertRun.run("runB", "dev", "2026-09-02T09:00:00.000Z", "2026-09-02T11:00:00.000Z", "ps1");
insertRun.run("runC", "plan", "2026-08-20T09:00:00.000Z", "2026-08-20T11:00:00.000Z", "ps1");
insertRun.run("runD", "review", "2026-09-02T09:00:00.000Z", "2026-09-02T11:00:00.000Z", "ps1");

// One island per row: distinct token tuples, distinct offsets, one file.
// (run, agent, model, observedAt, in/out tokens, cost — null cost = unpriced)
const rows = [
  ["u1", "runA", "_lead", "m/glm", "2026-08-20T10:00:00.000Z", 100, 10, 1.0],
  ["u2", "runA", "_lead", "unknown-model-v99", "2026-08-20T10:05:00.000Z", 200, 20, null],
  ["u3", "runB", "implementer", "m/glm", "2026-09-02T10:00:00.000Z", 300, 30, 2.0],
  ["u4", "runC", "_lead", "m/glm", "2026-08-20T10:10:00.000Z", 400, 40, 0.5],
  ["u5", "runC", "researcher", "unknown-model-v99", "2026-08-20T10:15:00.000Z", 500, 50, null],
  ["u6", "runD", "implementer", "m/glm", "2026-09-02T10:05:00.000Z", 600, 60, 3.0],
  ["u7", "runA", "agent-sub", "m/glm", "2026-08-20T10:20:00.000Z", 700, 70, 4.0],
];
rows.forEach(([id, runId, agent, model, at, inTok, outTok, usd], i) => {
  usage.run(id, runId, "s1", agent, model, at, inTok, outTok, 0, 0, "/viz.jsonl", (i + 1) * 10, at);
  if (usd != null) cost.run(runId, id, "ps1", usd);
});
ensureViews(db);
db.close();

// --- run the exporter against the fixture via the env seam ------------------
const outPath = join(temp, "viz.json");
const env = { ...process.env, LA_TELEMETRY_DB: dbPath };
delete env.LA_SUPERVISOR;
delete env.LA_SUPERVISOR_CHILD;
delete env.LA_SUPERVISOR_RUN;
const result = spawnSync(process.execPath, [SCRIPT, "--out", outPath], {
  cwd: ROOT, encoding: "utf8", env,
});
check("exporter exits 0 on the fixture", result.status === 0,
  `status=${result.status} stderr=${(result.stderr || "").split("\n")[0]}`);

let payload = null;
try {
  payload = JSON.parse(readFileSync(outPath, "utf8"));
} catch (err) {
  check("exporter wrote parseable JSON", false, err.message);
}
if (payload) {
  const F2 = payload.F2_cost || {};
  const series = {
    bySquad: F2.bySquad, byModel: F2.byModel, byWeek: F2.byWeek,
    leadVsSubagent: F2.leadVsSubagent, byRole: F2.byRole,
  };

  // Shape parity: every cost series row carries exactly the same four fields —
  // label, turns, usd, unpriced. A series missing the count fails here.
  const shape = (row) => Object.keys(row || {}).sort().join(",");
  const wantShape = "label,turns,unpriced,usd";
  for (const [name, list] of Object.entries(series)) {
    check(`${name} exists`, Array.isArray(list) && list.length > 0, JSON.stringify(list));
    if (!Array.isArray(list)) continue;
    check(`${name} rows carry label/turns/usd/unpriced (parity with bySquad)`,
      list.every((row) => shape(row) === wantShape), list.map(shape).join(" | "));
    check(`${name} unpriced is a number on every row`,
      list.every((row) => Number.isInteger(row.unpriced) && row.unpriced >= 0),
      JSON.stringify(list.map((row) => row.unpriced)));
  }

  // Ground truth. usd folds nothing (the sums only span priced rows), but the
  // unpriced column must COUNT the NULL-cost rows — the mutation guide in the
  // header flips IS NULL to IS NOT NULL and every assert below goes red.
  const byLabel = (list) => Object.fromEntries((list || []).map((row) => [row.label, row]));
  const squads = byLabel(series.bySquad);
  check("bySquad dev: 4 turns, $7.00, 1 unpriced",
    squads.dev && squads.dev.turns === 4 && close(squads.dev.usd, 7.0) && squads.dev.unpriced === 1,
    JSON.stringify(squads.dev));
  check("bySquad plan: 2 turns, $0.50, 1 unpriced",
    squads.plan && squads.plan.turns === 2 && close(squads.plan.usd, 0.5) && squads.plan.unpriced === 1,
    JSON.stringify(squads.plan));
  check("bySquad review: 1 turn, $3.00, 0 unpriced",
    squads.review && squads.review.turns === 1 && close(squads.review.usd, 3.0) && squads.review.unpriced === 0,
    JSON.stringify(squads.review));

  const weeks = series.byWeek || [];
  check("byWeek: two buckets, week A 5 turns $5.50 2 unpriced, week B 2 turns $5.00 0 unpriced",
    weeks.length === 2
    && weeks[0].turns === 5 && close(weeks[0].usd, 5.5) && weeks[0].unpriced === 2
    && weeks[1].turns === 2 && close(weeks[1].usd, 5.0) && weeks[1].unpriced === 0,
    JSON.stringify(weeks));

  const leadSub = byLabel(series.leadVsSubagent);
  check("leadVsSubagent lead: 3 turns, $1.50, 1 unpriced",
    leadSub.lead && leadSub.lead.turns === 3 && close(leadSub.lead.usd, 1.5) && leadSub.lead.unpriced === 1,
    JSON.stringify(leadSub.lead));
  check("leadVsSubagent subagent: 4 turns, $9.00, 1 unpriced",
    leadSub.subagent && leadSub.subagent.turns === 4 && close(leadSub.subagent.usd, 9.0) && leadSub.subagent.unpriced === 1,
    JSON.stringify(leadSub.subagent));

  check("byRole implementer first: 2 turns, $5.00, 0 unpriced",
    series.byRole?.[0]?.label === "implementer" && series.byRole[0].turns === 2
    && close(series.byRole[0].usd, 5.0) && series.byRole[0].unpriced === 0,
    JSON.stringify(series.byRole?.[0]));
  check("byRole researcher: 1 turn, $0.00, 1 unpriced",
    series.byRole?.some((row) => row.label === "researcher" && row.turns === 1
      && close(row.usd, 0.0) && row.unpriced === 1),
    JSON.stringify(series.byRole));

  const models = byLabel(series.byModel);
  check("byModel m/glm: 5 turns, $10.50, 0 unpriced",
    models["m/glm"] && models["m/glm"].turns === 5 && close(models["m/glm"].usd, 10.5) && models["m/glm"].unpriced === 0,
    JSON.stringify(models["m/glm"]));
  check("byModel unknown-model-v99: 2 turns, $0.00, 2 unpriced",
    models["unknown-model-v99"] && models["unknown-model-v99"].turns === 2
    && close(models["unknown-model-v99"].usd, 0.0) && models["unknown-model-v99"].unpriced === 2,
    JSON.stringify(models["unknown-model-v99"]));
}

rmSync(temp, { recursive: true, force: true });

console.log(`${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  FAIL: ${f}`).join("\n"));
  process.exit(1);
}
