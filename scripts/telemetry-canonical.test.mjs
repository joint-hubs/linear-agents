// Contract test for the canonical views (one row per physical model call).
//
// The views exist to answer fleet questions after ADR-0008 made facts
// run-scoped. Every assertion here is a way that intent can silently break:
// picking the wrong claimant, merging two calls into one, splitting one call
// into two, losing an uncontested row, or letting the 52-snapshot cost_facts
// table multiply a sum.
//
// Each fixture scenario targets one failure mode; the derived quantities
// (island boundaries, claim_count, line_count, attribution, winner selection)
// each have at least one assertion that fails if the logic is mutated.

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openTelemetryDb, collapseUsageIslands, MESSAGE_GAP_MS } from "./telemetry-store.mjs";
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

const insertRun = db.prepare(`INSERT INTO runs (run_id, squad, started_at, ended_at, price_set_id, status, updated_at)
  VALUES (?,?,?,?,?,?,'2026-09-01T00:00:00.000Z')`);
const usage = db.prepare(`INSERT INTO usage_facts
  (usage_id, run_id, session_id, agent_key, model, observed_at,
   input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
   source_path, source_offset, created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const cost = db.prepare("INSERT INTO cost_facts (run_id, usage_id, price_set_id, cost_usd) VALUES (?,?,?,?)");

// --- fixture: run-scoped claims ------------------------------------------
// Two runs share one transcript. Run A was live when the call happened; run B
// started later and merely re-ingested the same file — the exact shape that
// inflated `supervisor` by 44% in production.
insertRun.run("runA", "dev", "2026-09-01T10:00:00.000Z", "2026-09-01T11:00:00.000Z", "ps1", "completed");
insertRun.run("runB", "dev", "2026-09-01T20:00:00.000Z", "2026-09-01T20:00:03.000Z", "ps1", "completed");
insertRun.run("runC", "plan", "2026-09-02T10:00:00.000Z", "2026-09-02T11:00:00.000Z", "ps1", "completed");

db.prepare("INSERT INTO price_sets (price_set_id, config_hash, created_at, source) VALUES (?,?,?,?)")
  .run("ps1", "hash1", "2026-09-01T00:00:00.000Z", "test");
db.prepare("INSERT INTO price_sets (price_set_id, config_hash, created_at, source) VALUES (?,?,?,?)")
  .run("ps2", "hash2", "2026-09-01T00:00:00.000Z", "test");

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
cost.run("runA", "u100", "ps1", 1.0);
cost.run("runA", "u100", "ps2", 99.0);
cost.run("runB", "u100", "ps1", 1.0);
cost.run("runB", "u100", "ps2", 99.0);
// runC's call is deliberately left unpriced.

// --- fixture: per-message island collapse (FOC-221) ----------------------
// One assistant message is several JSONL lines, each repeating the same usage
// object; ingest keyed them by byte offset, so they became distinct rows.
// Ground truth (2,161 real messages): the lines of one message carry DIFFERENT
// timestamps but IDENTICAL token tuples, and the widest observed span is
// 173 s — hence: identical tuples only, gap threshold 300 s, zeros never
// bridge two different tuples.

insertRun.run("runD", "review", "2026-09-01T12:00:00.000Z", "2026-09-01T13:00:00.000Z", "ps1", "completed");
insertRun.run("runE", "dev", "2026-09-01T10:00:00.000Z", "2026-09-01T11:00:00.000Z", "ps1", "completed");
insertRun.run("runF", "plan", "2026-09-01T20:00:00.000Z", "2026-09-01T20:30:00.000Z", "ps1", "completed");
insertRun.run("runM", "dev", "2026-09-01T09:00:00.000Z", "2026-09-01T11:00:00.000Z", "ps1", "completed");
insertRun.run("runM2", "test", "2026-09-01T10:00:00.000Z", "2026-09-01T11:00:00.000Z", "ps1", "completed");
insertRun.run("runN", "dev", null, null, "ps1", "completed");
insertRun.run("runP", "plan", "2026-09-01T10:00:00.000Z", "2026-09-01T11:00:00.000Z", "ps1", "completed");
insertRun.run("runQ", "plan", "2026-09-01T10:00:00.000Z", "2026-09-01T10:55:00.000Z", "ps1", "completed");
insertRun.run("runR", "dev", "2026-09-01T12:00:00.000Z", "2026-09-01T14:00:00.000Z", "ps1", "completed");
insertRun.run("runS", "test", "2026-09-01T10:00:00.000Z", "2026-09-01T11:00:00.000Z", "ps1", "completed");

// /msg.jsonl — one run, one partition, offsets ordered 10..80:
//   10/20/30  one message repeated across three lines (100,200,10,5)
//   40        a zero-token row (its own event — zeros never bridge)
//   50/60     identical tuples 400 s apart (beyond the 300 s gap)
//   70/80     identical tuples 10 s apart (within the gap — conservative merge)
usage.run("m10", "runM", "sm", "implementer", "m1", "2026-09-01T10:00:00.000Z", 100, 200, 10, 5, "/msg.jsonl", 10, "2026-09-01T10:00:00.000Z");
usage.run("m20", "runM", "sm", "implementer", "m1", "2026-09-01T10:00:05.000Z", 100, 200, 10, 5, "/msg.jsonl", 20, "2026-09-01T10:00:05.000Z");
usage.run("m30", "runM", "sm", "implementer", "m1", "2026-09-01T10:00:10.000Z", 100, 200, 10, 5, "/msg.jsonl", 30, "2026-09-01T10:00:10.000Z");
usage.run("m40", "runM", "sm", "implementer", "m1", "2026-09-01T10:00:30.000Z", 0, 0, 0, 0, "/msg.jsonl", 40, "2026-09-01T10:00:30.000Z");
usage.run("m50", "runM", "sm", "implementer", "m1", "2026-09-01T11:00:00.000Z", 50, 60, 0, 0, "/msg.jsonl", 50, "2026-09-01T11:00:00.000Z");
usage.run("m60", "runM", "sm", "implementer", "m1", "2026-09-01T11:06:40.000Z", 50, 60, 0, 0, "/msg.jsonl", 60, "2026-09-01T11:06:40.000Z");
usage.run("m70", "runM", "sm", "implementer", "m1", "2026-09-01T12:00:00.000Z", 11, 12, 0, 0, "/msg.jsonl", 70, "2026-09-01T12:00:00.000Z");
usage.run("m80", "runM", "sm", "implementer", "m1", "2026-09-01T12:00:10.000Z", 11, 12, 0, 0, "/msg.jsonl", 80, "2026-09-01T12:00:10.000Z");
cost.run("runM", "m10", "ps1", 2.0);
cost.run("runM", "m40", "ps1", 0.0); // priced at zero — a real free call, not an unknown price
cost.run("runM", "m50", "ps1", 3.0);
cost.run("runM", "m70", "ps1", 4.0);

// Missing timestamps: a run with no start/end and two usage lines with no
// observed_at at all (fit_rank 3). They must form their own island and their
// winner must be labelled no_timestamp — never folded into a $0 sum.
usage.run("n90", "runN", "sn", "observer", "m1", null, 7, 8, 0, 0, "/null.jsonl", 90, "2026-09-01T10:00:00.000Z");
usage.run("n95", "runN", "sn", "observer", "m1", null, 7, 8, 0, 0, "/null.jsonl", 95, "2026-09-01T10:00:00.000Z");

// A timestamped line and a timestampless line with the same tuple on one file:
// the timestampless line attaches to the timestamped call (no phantom call),
// and the in-window claim wins the representation.
usage.run("x50", "runN", "sx", "observer", "m1", null, 7, 8, 0, 0, "/mixed.jsonl", 50, "2026-09-01T10:00:00.000Z");
usage.run("x55", "runM2", "sx", "observer", "m1", "2026-09-01T10:30:00.000Z", 7, 8, 0, 0, "/mixed.jsonl", 55, "2026-09-01T10:30:00.000Z");
cost.run("runM2", "x55", "ps1", 5.0);

// Resumed session: the same conversation written to two files. Each file is a
// physical record; the dedup never spans files (documented limitation).
usage.run("r10", "runR", "sr", "worker", "m1", "2026-09-01T13:00:00.000Z", 33, 44, 0, 0, "/s1.jsonl", 10, "2026-09-01T13:00:00.000Z");
usage.run("r10b", "runR", "sr", "worker", "m1", "2026-09-01T13:00:20.000Z", 33, 44, 0, 0, "/s2.jsonl", 10, "2026-09-01T13:00:20.000Z");

// A shared message claimed by two runs: six lines, one island, two claimants.
for (const [runId, suffix] of [["runP", "p"], ["runQ", "q"]]) {
  for (const [offset, ts] of [[10, "2026-09-01T10:30:00.000Z"], [20, "2026-09-01T10:30:05.000Z"], [30, "2026-09-01T10:30:10.000Z"]]) {
    usage.run(`s${suffix}${offset}`, runId, "ss", "researcher", "m2",
      ts, 90, 91, 0, 0, "/shared.jsonl", offset, ts);
  }
}
cost.run("runP", "sp10", "ps1", 6.0);

// A message straddling the run boundary: the in-window line wins, the
// after-end line does not split off into a phantom call.
usage.run("st10", "runS", "sst", "tester", "m2", "2026-09-01T10:59:59.000Z", 71, 72, 0, 0, "/straddle.jsonl", 10, "2026-09-01T10:59:59.000Z");
usage.run("st20", "runS", "sst", "tester", "m2", "2026-09-01T11:00:01.000Z", 71, 72, 0, 0, "/straddle.jsonl", 20, "2026-09-01T11:00:01.000Z");

// Exact tie: two runs equidistant from their call, both in-window. run_id
// breaks the tie deterministically.
// The same physical line re-ingested by two runs carries the SAME timestamp —
// it is the line's own time from the file, not the ingest time.
usage.run("tieA", "runA", "st", "debugger", "m1", "2026-09-01T10:30:00.000Z", 21, 22, 0, 0, "/tie.jsonl", 10, "2026-09-01T10:30:00.000Z");
usage.run("tieD", "runD", "st", "debugger", "m1", "2026-09-01T10:30:00.000Z", 21, 22, 0, 0, "/tie.jsonl", 10, "2026-09-01T10:30:00.000Z");
cost.run("runA", "tieA", "ps1", 7.0);

// Boundary fit: a claimant that was live (runE) against one that had not
// started yet (runF) — fit outranks everything else.
usage.run("bE", "runE", "sb", "implementer", "m2", "2026-09-01T10:30:00.000Z", 61, 62, 0, 0, "/boundary.jsonl", 10, "2026-09-01T10:30:00.000Z");
usage.run("bF", "runF", "sb", "implementer", "m2", "2026-09-01T10:30:00.000Z", 61, 62, 0, 0, "/boundary.jsonl", 10, "2026-09-01T10:30:00.000Z");

// --- assertions ----------------------------------------------------------
const rows = db.prepare("SELECT * FROM canonical_usage ORDER BY source_path, source_offset").all();
const byKey = (path, offset) => rows.find((r) => r.source_path === path && r.source_offset === offset);
check("MESSAGE_GAP_MS is the measured 300 s threshold", MESSAGE_GAP_MS === 300000, `got ${MESSAGE_GAP_MS}`);

// Original run-scoped fixture — unchanged semantics under the island rule.
const contested = byKey("/t.jsonl", 100);
check("contested row survives", contested != null);
check("winner is the run that was live", contested?.run_id === "runA", `got ${contested?.run_id}`);
check("winner is marked in_window", contested?.attribution === "in_window", `got ${contested?.attribution}`);
check("claim_count reports both claimants", contested?.claim_count === 2, `got ${contested?.claim_count}`);
check("cost is not multiplied by price snapshots", contested?.cost_usd === 1.0, `got ${contested?.cost_usd}`);
check("repeated per-message lines collapse with the claim", contested?.line_count === 2, `got ${contested?.line_count}`);

const solo = byKey("/other.jsonl", 200);
check("uncontested row is kept", solo != null);
check("uncontested claim_count is 1", solo?.claim_count === 1, `got ${solo?.claim_count}`);
check("unpriced stays NULL, never 0", solo?.cost_usd === null, `got ${solo?.cost_usd}`);

// One message, three lines -> one row carrying the message's usage.
const msg = byKey("/msg.jsonl", 10);
check("3 repeated lines collapse to one row", msg != null && rows.filter((r) => r.source_path === "/msg.jsonl").length === 5,
  `got ${rows.filter((r) => r.source_path === "/msg.jsonl").length} rows for /msg.jsonl`);
check("collapsed message keeps full tokens", msg?.input_tokens === 100 && msg?.output_tokens === 200,
  `got ${msg?.input_tokens}/${msg?.output_tokens}`);
check("collapsed message line_count is 3", msg?.line_count === 3, `got ${msg?.line_count}`);
check("collapsed message keeps its cost", msg?.cost_usd === 2.0, `got ${msg?.cost_usd}`);
check("collapsed message is in_window", msg?.attribution === "in_window", `got ${msg?.attribution}`);

// Zero tokens are a real event, and priced-zero is not unpriced.
const zero = byKey("/msg.jsonl", 40);
check("zero-token row is its own island", zero?.line_count === 1, `got ${zero?.line_count}`);
check("priced zero stays 0, never NULL", zero?.cost_usd === 0, `got ${zero?.cost_usd}`);

// 400 s apart: beyond the gap, two islands.
const late = byKey("/msg.jsonl", 50);
const later = byKey("/msg.jsonl", 60);
check("identical tuples 400 s apart stay separate", late != null && later != null && late.usage_id !== later.usage_id);
check("first of the 400 s pair wins in_window", late?.attribution === "in_window", `got ${late?.attribution}`);
check("second of the 400 s pair is after_end", later?.attribution === "after_end", `got ${later?.attribution}`);
check("after-end line is not silently dropped", later?.cost_usd === null, `got ${later?.cost_usd}`);

// 10 s apart: within the gap, conservatively merged into one row.
const near = byKey("/msg.jsonl", 70);
check("identical tuples 10 s apart merge (documented conservative merge)",
  near?.line_count === 2 && rows.find((r) => r.source_path === "/msg.jsonl" && r.source_offset === 80) == null,
  `line_count ${near?.line_count}`);

// Missing timestamps: own island, no_timestamp label, unpriced not zeroed.
const noTs = byKey("/null.jsonl", 90);
check("timestampless lines form one island", noTs?.line_count === 2, `got ${noTs?.line_count}`);
check("timestampless winner is labelled no_timestamp", noTs?.attribution === "no_timestamp", `got ${noTs?.attribution}`);
check("timestampless usage stays unpriced NULL", noTs?.cost_usd === null, `got ${noTs?.cost_usd}`);

// Timestampless line attached to a timestamped call: no phantom call, and the
// in-window claim represents the island.
const mixed = byKey("/mixed.jsonl", 55);
check("timestampless line merges with timestamped call", mixed != null &&
  rows.find((r) => r.source_path === "/mixed.jsonl" && r.source_offset === 50) == null, `row @50 should be gone`);
check("mixed island line_count is 2", mixed?.line_count === 2, `got ${mixed?.line_count}`);
check("in-window claim wins the mixed island", mixed?.run_id === "runM2", `got ${mixed?.run_id}`);
check("mixed island attribution is in_window", mixed?.attribution === "in_window", `got ${mixed?.attribution}`);
check("mixed island claim_count counts both runs", mixed?.claim_count === 2, `got ${mixed?.claim_count}`);

// Resumed session: two files stay two physical records (documented limitation).
const resumed = rows.filter((r) => r.source_path === "/s1.jsonl" || r.source_path === "/s2.jsonl");
check("resumed session keeps one row per file", resumed.length === 2 &&
  resumed.every((r) => r.line_count === 1), `got ${resumed.length} rows`);

// Shared message across two runs: one island, six lines, two claimants.
const shared = byKey("/shared.jsonl", 10);
check("shared message collapses to one row",
  rows.filter((r) => r.source_path === "/shared.jsonl").length === 1, `got shared rows`);
check("shared message line_count is 6", shared?.line_count === 6, `got ${shared?.line_count}`);
check("shared message claim_count is 2", shared?.claim_count === 2, `got ${shared?.claim_count}`);
check("shared message cost is not doubled", shared?.cost_usd === 6.0, `got ${shared?.cost_usd}`);

// Straddling the run boundary: the in-window line represents the call.
const straddle = byKey("/straddle.jsonl", 10);
check("straddling message is one island", straddle?.line_count === 2, `got ${straddle?.line_count}`);
check("straddling message wins with the in-window line", straddle?.run_id === "runS" && straddle?.attribution === "in_window",
  `got ${straddle?.run_id}/${straddle?.attribution}`);

// Exact tie: run_id breaks it deterministically.
const tie = byKey("/tie.jsonl", 10);
check("exact tie is decided by run_id", tie?.run_id === "runA", `got ${tie?.run_id}`);
check("exact tie claim_count is 2", tie?.claim_count === 2, `got ${tie?.claim_count}`);
check("exact tie line_count is 2", tie?.line_count === 2, `got ${tie?.line_count}`);
check("exact tie cost from winner's price pin", tie?.cost_usd === 7.0, `got ${tie?.cost_usd}`);

// Fit boundary: in-window beats before-start.
const boundary = byKey("/boundary.jsonl", 10);
check("in-window beats before-start claimant", boundary?.run_id === "runE", `got ${boundary?.run_id}`);
check("before-start claimant survives in claim_count", boundary?.claim_count === 2, `got ${boundary?.claim_count}`);

// A sum over the view must not exceed the sum of distinct calls: 8 priced
// islands ($1+$2+$0+$3+$4+$5+$6+$7), 7 unpriced rows stay NULL.
const totals = db.prepare(`SELECT COUNT(*) n, ROUND(SUM(COALESCE(cost_usd,0)),2) usd,
    SUM(cost_usd IS NULL) unpriced FROM canonical_usage`).get();
check("one row per physical call across all scenarios", totals.n === 15, `got ${totals.n}`);
check("fleet cost counts each call once", totals.usd === 28.0, `got ${totals.usd}`);
check("unpriced rows counted, never folded to 0", totals.unpriced === 7, `got ${totals.unpriced}`);

// --- JS twin vs view (contract) ------------------------------------------
// aggregateUsageByTask runs the collapse in JS for speed; the view is the
// batch surface. They must agree row for row on the same raw input.
const rawRows = db.prepare(
  `SELECT u.usage_id, u.run_id, u.session_id, u.agent_key, u.model, u.observed_at,
     u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_creation_tokens,
     u.source_path, u.source_offset, r.squad, r.started_at, r.ended_at,
     c.cost_usd
   FROM usage_facts u
   JOIN runs r ON r.run_id=u.run_id
   LEFT JOIN cost_facts c ON c.run_id=u.run_id AND c.usage_id=u.usage_id AND c.price_set_id=r.price_set_id`,
).all();
const keyOf = (r) => `${r.source_path}|${r.source_offset}|${r.usage_id}`;
const viewByKey = new Map(rows.map((r) => [keyOf(r), r]));
const twinRows = collapseUsageIslands(rawRows);
check("twin produces the same number of islands", twinRows.length === rows.length,
  `view ${rows.length} vs twin ${twinRows.length}`);
const onlyInView = [...viewByKey.keys()].filter((k) => !twinRows.some((t) => keyOf(t) === k));
const onlyInTwin = twinRows.map(keyOf).filter((k) => !viewByKey.has(k));
check("twin and view select the same island keys", onlyInView.length === 0 && onlyInTwin.length === 0,
  `view-only: ${onlyInView.join(" ; ")} twin-only: ${onlyInTwin.join(" ; ")}`);
let twinMismatches = 0;
for (const t of twinRows) {
  const v = viewByKey.get(keyOf(t));
  if (!v) { twinMismatches++; continue; }
  for (const field of ["source_path", "source_offset", "usage_id", "run_id", "session_id", "squad",
    "agent_key", "model", "observed_at", "started_at", "ended_at",
    "input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens",
    "claim_count", "line_count", "attribution", "cost_usd"]) {
    if (v[field] !== t[field]) {
      twinMismatches++;
      failures.push(`twin/view diverge on ${keyOf(t)} field ${field}: view=${JSON.stringify(v[field])} twin=${JSON.stringify(t[field])}`);
      break;
    }
  }
}
check("twin matches the view row for row", twinMismatches === 0, `${twinMismatches} mismatches`);

// Determinism: the same input collapses to byte-identical output twice.
const twinAgain = collapseUsageIslands(rawRows);
check("twin is deterministic", JSON.stringify(twinRows) === JSON.stringify(twinAgain));

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

// FOC-220: the view rides along with the identity/outcome columns. A row
// inserted without them (the legacy shape) must read UNKNOWN on every one —
// never a measured zero, never a verified ok.
check("view exposes FOC-220 columns",
  ["tool_input_id", "tool_index", "tool_result_state", "tool_result_bytes", "tool_result_id"]
    .every((c) => c in toolRows[0]),
  Object.keys(toolRows[0] ?? {}).join(","));
check("legacy-shape rows read unknown on the FOC-220 columns",
  toolRows[0]?.tool_input_id === null && toolRows[0]?.tool_result_state === null &&
  toolRows[0]?.tool_result_bytes === null && toolRows[0]?.tool_result_id === null,
  JSON.stringify(toolRows[0]));

// --- idempotence ---------------------------------------------------------
const countBefore = totals.n;
ensureViews(db);
ensureViews(db);
check("ensureViews is idempotent",
  db.prepare("SELECT COUNT(*) n FROM canonical_usage").get().n === countBefore);

db.close();
rmSync(temp, { recursive: true, force: true });

console.log(`${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  FAIL: ${f}`).join("\n"));
  process.exit(1);
}
