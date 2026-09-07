// Contract test for the canonical views (one row per physical model call).
//
// The views exist to answer fleet questions after ADR-0008 made facts
// run-scoped. Every assertion here is a way that intent can silently break:
// picking the wrong claimant, losing an uncontested row, or letting the
// 52-snapshot cost_facts table multiply a sum.

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openTelemetryDb } from "./telemetry-store.mjs";
import { ensureViews } from "./telemetry-canonical.mjs";

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) { passed++; return; }
  failed++;
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

const temp = mkdtempSync(join(tmpdir(), "telemetry-canonical-test-"));
const db = openTelemetryDb(join(temp, "t.sqlite"));
ensureViews(db);

// --- fixture -------------------------------------------------------------
// Two runs share one transcript. Run A was live when the call happened; run B
// started later and merely re-ingested the same file — the exact shape that
// inflated `supervisor` by 44% in production.
db.prepare(`INSERT INTO runs (run_id, squad, started_at, ended_at, price_set_id, status, updated_at)
  VALUES (?,?,?,?,?,?,'2026-09-01T00:00:00.000Z')`).run("runA", "dev", "2026-09-01T10:00:00.000Z", "2026-09-01T11:00:00.000Z", "ps1", "completed");
db.prepare(`INSERT INTO runs (run_id, squad, started_at, ended_at, price_set_id, status, updated_at)
  VALUES (?,?,?,?,?,?,'2026-09-01T00:00:00.000Z')`).run("runB", "dev", "2026-09-01T20:00:00.000Z", "2026-09-01T20:00:03.000Z", "ps1", "completed");
db.prepare(`INSERT INTO runs (run_id, squad, started_at, ended_at, price_set_id, status, updated_at)
  VALUES (?,?,?,?,?,?,'2026-09-01T00:00:00.000Z')`).run("runC", "plan", "2026-09-02T10:00:00.000Z", "2026-09-02T11:00:00.000Z", "ps1", "completed");

db.prepare("INSERT INTO price_sets (price_set_id, config_hash, created_at, source) VALUES (?,?,?,?)")
  .run("ps1", "hash1", "2026-09-01T00:00:00.000Z", "test");
db.prepare("INSERT INTO price_sets (price_set_id, config_hash, created_at, source) VALUES (?,?,?,?)")
  .run("ps2", "hash2", "2026-09-01T00:00:00.000Z", "test");

const usage = db.prepare(`INSERT INTO usage_facts
  (usage_id, run_id, session_id, agent_key, model, observed_at,
   input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
   source_path, source_offset, created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);

// The contested call: offset 100, made at 10:30 — inside runA, long before runB.
for (const runId of ["runA", "runB"]) {
  usage.run("u100", runId, "s1", "_lead", "m1", "2026-09-01T10:30:00.000Z",
    10, 20, 0, 0, "/t.jsonl", 100, "2026-09-01T10:30:00.000Z");
}
// An uncontested call in another run entirely.
usage.run("u200", "runC", "s2", "implementer", "m1", "2026-09-02T10:30:00.000Z",
  5, 5, 0, 0, "/other.jsonl", 200, "2026-09-02T10:30:00.000Z");

// Cost for the contested call exists in BOTH price snapshots. Only the run's
// own snapshot (ps1) may be counted; ps2 is a reprice of the same call.
const cost = db.prepare("INSERT INTO cost_facts (run_id, usage_id, price_set_id, cost_usd) VALUES (?,?,?,?)");
cost.run("runA", "u100", "ps1", 1.0);
cost.run("runA", "u100", "ps2", 99.0);
cost.run("runB", "u100", "ps1", 1.0);
cost.run("runB", "u100", "ps2", 99.0);
// runC's call is deliberately left unpriced.

// --- assertions ----------------------------------------------------------
const rows = db.prepare("SELECT * FROM canonical_usage ORDER BY source_offset").all();

check("one row per physical call", rows.length === 2, `got ${rows.length}`);

const contested = rows.find((r) => r.source_offset === 100);
check("contested row survives", contested != null);
check("winner is the run that was live", contested?.run_id === "runA", `got ${contested?.run_id}`);
check("winner is marked in_window", contested?.attribution === "in_window", `got ${contested?.attribution}`);
check("claim_count reports both claimants", contested?.claim_count === 2, `got ${contested?.claim_count}`);
check("cost is not multiplied by price snapshots", contested?.cost_usd === 1.0, `got ${contested?.cost_usd}`);

const solo = rows.find((r) => r.source_offset === 200);
check("uncontested row is kept", solo != null);
check("uncontested claim_count is 1", solo?.claim_count === 1, `got ${solo?.claim_count}`);
check("unpriced stays NULL, never 0", solo?.cost_usd === null, `got ${solo?.cost_usd}`);

// A sum over the view must not exceed the sum of distinct calls.
const total = db.prepare("SELECT ROUND(SUM(COALESCE(cost_usd,0)),2) usd FROM canonical_usage").get().usd;
check("fleet cost counts each call once", total === 1.0, `got ${total}`);

// --- tool facts ----------------------------------------------------------
const tool = db.prepare(`INSERT INTO tool_facts
  (tool_fact_id, run_id, agent_key, model, observed_at, tool_name_raw, tool_name_canon,
   tool_input, tool_has_error, turn_index, source_path, source_offset, created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
for (const runId of ["runA", "runB"]) {
  tool.run("tf1", runId, "_lead", "m1", "2026-09-01T10:30:00.000Z", "Bash", "bash",
    "{}", 1, 0, "/t.jsonl", 100, "2026-09-01T10:30:00.000Z");
}

const toolRows = db.prepare("SELECT * FROM canonical_tool_facts").all();
check("tool call deduplicated to one row", toolRows.length === 1, `got ${toolRows.length}`);
check("tool winner is the live run", toolRows[0]?.run_id === "runA", `got ${toolRows[0]?.run_id}`);
check("error flag preserved", toolRows[0]?.tool_has_error === 1);

// --- idempotence ---------------------------------------------------------
ensureViews(db);
ensureViews(db);
check("ensureViews is idempotent",
  db.prepare("SELECT COUNT(*) n FROM canonical_usage").get().n === 2);

// --- report --------------------------------------------------------------
db.close();
rmSync(temp, { recursive: true, force: true });

console.log(`${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  FAIL: ${f}`).join("\n"));
  process.exit(1);
}
