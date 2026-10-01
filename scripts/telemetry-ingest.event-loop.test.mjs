#!/usr/bin/env node
// FOC-547 AC5 regression: a background-ingest tick must NOT re-read an
// unchanged large transcript, and a tick's synchronous work must stay bounded.
//
// Scenarios (all on synthetic fixtures in a tmp store — nothing touches the
// real .state):
//   1. Full first pass over a ~20 MB transcript — establishes the timing
//      baseline (T_full) the later assertions budget against.
//   2. THE AC5 ASSERTION: a second tick over the SAME file (parse state reset
//      to simulate a fresh process) applies ZERO new events and returns in a
//      fraction of T_full. If the skip-cache regresses to a full re-read, the
//      re-parse takes ~T_full and this test FAILS.
//   3. A GROWING transcript is parsed incrementally: appending 60 lines costs
//      ~60 lines of work (not a 20 MB re-read), and no single synchronous
//      block during the tick exceeds 250 ms (AC2).
//   4. Tool-fact trap (AC7): a tool_use recorded while its tool_result had not
//      arrived yet stays pending (NULL outcome, never a premature 'missing');
//      the result arriving in a later pass upgrades the row in place — across
//      a simulated process restart; a fact whose result never arrives is
//      finalized as 'missing' only when the file has stopped growing.
//
// Deterministic: fixed synthetic content, wall-clock assertions are budgeted
// against the MEASURED T_full of the same fixture in the same run (no absolute
// machine-speed assumption beyond "re-reading 20 MB is not 20x faster than
// parsing it"), and the whole file runs well under 60 s.

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { makeEvent, openTelemetryDb, applyEvent } from "./telemetry-store.mjs";
import { ingestTranscript, ingestKnownRuns, _resetTranscriptParseStateForTests } from "./telemetry-ingest.mjs";

let passed = 0;
let skipped = 0;
let failed = 0;
const failures = [];

class TestSkip extends Error {}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (error) {
    if (error instanceof TestSkip) {
      skipped++;
      console.log(`  SKIP ${name}: ${error.message}`);
      return;
    }
    failed++;
    failures.push(`${name}: ${error.message}`);
    console.log(`  FAIL ${name}: ${error.message}`);
  }
}

function assert(value, message) {
  if (!value) throw new Error(message || "assertion failed");
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message || "mismatch"}: expected ${expected}, got ${actual}`);
}

// --- Event-loop sampler: max gap between consecutive macrotask ticks --------
// The gap between two setImmediate callbacks is an upper bound on how long the
// loop was blocked by synchronous work between them.
function startLoopSampler() {
  const state = { maxBlockMs: 0, stopped: false };
  let last = performance.now();
  const tick = () => {
    if (state.stopped) return;
    const now = performance.now();
    const gap = now - last;
    if (gap > state.maxBlockMs) state.maxBlockMs = gap;
    last = now;
    setImmediate(tick);
  };
  setImmediate(tick);
  state.stop = () => { state.stopped = true; };
  return state;
}

// --- Temp store (env seams keep every write inside the tmp dir) -------------
const temp = mkdtempSync(join(tmpdir(), "telemetry-event-loop-test-"));
const dbPath = join(temp, "telemetry.sqlite");
process.env.LA_TELEMETRY_HOME = temp;
process.env.LA_TELEMETRY_DB = dbPath;
const db = openTelemetryDb(dbPath);

// --- Large-transcript fixture (~20 MB of padded assistant lines) ------------
const largeDir = join(temp, "large");
mkdirSync(largeDir, { recursive: true });
const largeTranscript = join(largeDir, "lead.jsonl");
const largeSessionId = "session-large-1";
const largeRunId = "run-large-1";
const LINE_COUNT = 2400;
const FILLER = "x".repeat(7900); // ~8.1 KB per line → ~20 MB total

function usageLine(index, sessionId) {
  return JSON.stringify({
    type: "assistant",
    timestamp: new Date(Date.UTC(2026, 8, 1, 8, 0, 0) + index * 1000).toISOString(),
    sessionId,
    cwd: "C:/repos/fenix",
    gitBranch: "foc-547",
    filler: FILLER, // inert padding — the ingest path must ignore it
    message: { model: "deepseek-v4-flash", usage: { input_tokens: 100 + index, output_tokens: 50 } },
  });
}

writeFileSync(largeTranscript, Array.from({ length: LINE_COUNT }, (_, i) => usageLine(i, largeSessionId)).join("\n") + "\n", "utf8");
const LARGE_BYTES = statSync(largeTranscript).size;
console.log(`  fixture: ${LINE_COUNT} lines, ${(LARGE_BYTES / 1024 / 1024).toFixed(1)} MB`);

applyEvent(db, makeEvent("run.started", {
  runId: largeRunId, squad: "dev", startedAt: "2026-09-01T08:00:00.000Z", cwd: "C:/repos/fenix",
}, { runId: largeRunId }));
applyEvent(db, makeEvent("session.linked", {
  runId: largeRunId, sessionId: largeSessionId, transcriptPath: largeTranscript,
}, { runId: largeRunId }));

let T_full = 0;

// --- Scenario 1: full first pass --------------------------------------------
await test("full first pass parses the whole ~20 MB transcript (baseline)", async () => {
  const sampler = startLoopSampler();
  const t0 = performance.now();
  const summary = await ingestKnownRuns({ dbPath });
  T_full = performance.now() - t0;
  sampler.stop();
  // summary.usageEvents counts ALL applied events (its name predates
  // workspace events): 2400 usage.recorded + 1 workspace.observed.
  assertEqual(summary.usageEvents, LINE_COUNT + 1, "one usage event per assistant line + the workspace observation");
  assertEqual(summary.settled, 0, "a running run is never settled — the tick must reach the ingest path");
  console.log(`    T_full=${T_full.toFixed(0)}ms maxBlock=${sampler.maxBlockMs.toFixed(0)}ms`);
  assert(T_full > 0);
});

// --- Scenario 2: THE AC5 assertion — unchanged file is NOT re-read ----------
await test("unchanged tick applies 0 events and skips the re-read (AC5)", async () => {
  assert(T_full > 0, "baseline missing");
  // Simulate a fresh process: the in-memory parse state is gone, so only the
  // transcript_sources skip-cache (byte_offset + file_size) can save the tick.
  _resetTranscriptParseStateForTests();
  const sampler = startLoopSampler();
  const t0 = performance.now();
  const again = await ingestKnownRuns({ dbPath });
  const elapsed = performance.now() - t0;
  sampler.stop();
  assertEqual(again.usageEvents, 0, "an unchanged file must not re-emit usage events");
  assertEqual(again.settled, 0, "run is still running — the skip must come from the size gate, not the settle gate");
  // FOC-599: T_full/10, not max(400, T_full/5). A genuine full re-read of this
  // fixture measures 200-275 ms (POKE 201 ms; 274 ms forced, this box) — BELOW
  // the old 400 ms floor, so the headline assertion stayed green on its own
  // target regression. A warm full re-parse costs about T_full/5, so the budget
  // must sit under that: T_full/10 leaves the skip path (measured 5 ms) ~20x
  // headroom and trips at ~2-3x under a real re-read.
  const budget = T_full / 10;
  assert(
    elapsed < budget,
    `unchanged tick took ${elapsed.toFixed(0)}ms (budget ${budget.toFixed(0)}ms, T_full ${T_full.toFixed(0)}ms) — the unchanged transcript was re-read`,
  );
  assert(sampler.maxBlockMs < 250, `unchanged tick blocked the event loop ${sampler.maxBlockMs.toFixed(0)}ms (AC2 budget 250ms)`);
  console.log(`    skip pass: ${elapsed.toFixed(0)}ms (budget ${budget.toFixed(0)}ms), maxBlock=${sampler.maxBlockMs.toFixed(0)}ms`);
});

// --- Scenario 3: growth is incremental ---------------------------------------
await test("growth tick parses only the appended lines, bounded sync blocks", async () => {
  const APPENDED = 60;
  const nextIndex = LINE_COUNT;
  appendFileSync(
    largeTranscript,
    Array.from({ length: APPENDED }, (_, i) => usageLine(nextIndex + i, largeSessionId)).join("\n") + "\n",
    "utf8",
  );
  const sampler = startLoopSampler();
  const t0 = performance.now();
  // No state reset: this is the same-process live tick over a grown file.
  // (The previous scenario reset the state, so the resume starts from the
  // stored byte_offset — exactly the crash/restart resume path.)
  const growth = await ingestTranscript(db, largeRunId, largeTranscript, largeSessionId);
  const elapsed = performance.now() - t0;
  sampler.stop();
  // 60 usage events + 1 workspace.observed (fresh parse state re-emits the
  // first cwd:branch it sees) — the PRE-EXISTING 2400 lines are all dedup
  // absorbed, never re-emitted.
  assertEqual(growth.events, APPENDED + 1, "appended lines emitted, pre-existing lines deduped");
  const budget = Math.max(400, T_full / 5);
  assert(
    elapsed < budget,
    `growth tick took ${elapsed.toFixed(0)}ms (budget ${budget.toFixed(0)}ms, T_full ${T_full.toFixed(0)}ms) — the full transcript was re-read`,
  );
  assert(sampler.maxBlockMs < 250, `growth tick blocked the event loop ${sampler.maxBlockMs.toFixed(0)}ms (AC2 budget 250ms)`);
  console.log(`    growth pass: ${elapsed.toFixed(0)}ms (budget ${budget.toFixed(0)}ms), maxBlock=${sampler.maxBlockMs.toFixed(0)}ms`);
});

// --- Scenario 4: tool-fact trap (AC7) on a small fixture --------------------
const toolsDir = join(temp, "tools");
mkdirSync(toolsDir, { recursive: true });
const toolsTranscript = join(toolsDir, "lead.jsonl");
const toolsSessionId = "session-tools-1";
const toolsRunId = "run-tools-1";

function toolsLine(obj) {
  return JSON.stringify(obj) + "\n";
}

function toolUseLine(ts, id, name, input) {
  return {
    type: "assistant",
    timestamp: ts,
    sessionId: toolsSessionId,
    message: {
      model: "deepseek-v4-flash",
      usage: { input_tokens: 10, output_tokens: 5 },
      content: [{ type: "tool_use", id, name, input }],
    },
  };
}

function toolResultLine(ts, forId, text, isError = false) {
  return {
    type: "user",
    timestamp: ts,
    sessionId: toolsSessionId,
    message: { content: [{ type: "tool_result", tool_use_id: forId, content: text, is_error: isError }] },
  };
}

writeFileSync(toolsTranscript, [
  toolsLine({ type: "user", timestamp: "2026-09-01T09:00:00.000Z", sessionId: toolsSessionId, cwd: "C:/repos/fenix", gitBranch: "foc-547" }),
  toolsLine(toolUseLine("2026-09-01T09:00:01.000Z", "call_A", "Read", { file_path: "/tmp/a.txt" })),
  toolsLine(toolUseLine("2026-09-01T09:00:02.000Z", "call_B", "Bash", { command: "ls" })),
].join(""), "utf8");

applyEvent(db, makeEvent("run.started", {
  runId: toolsRunId, squad: "dev", startedAt: "2026-09-01T09:00:00.000Z", cwd: "C:/repos/fenix",
}, { runId: toolsRunId }));
applyEvent(db, makeEvent("session.linked", {
  runId: toolsRunId, sessionId: toolsSessionId, transcriptPath: toolsTranscript,
}, { runId: toolsRunId }));

function toolFactStates() {
  return db.prepare("SELECT tool_name_raw, tool_result_state, tool_result_bytes FROM tool_facts WHERE run_id=? AND source_path=? ORDER BY tool_name_raw")
    .all(toolsRunId, toolsTranscript);
}

await test("tool_use with no result yet is pending NULL, never premature 'missing'", async () => {
  const pass1 = await ingestTranscript(db, toolsRunId, toolsTranscript, toolsSessionId);
  assertEqual(pass1.missing, false, "transcript present");
  const rows = toolFactStates();
  assertEqual(rows.length, 2, "both tool_uses recorded");
  for (const row of rows) {
    assertEqual(row.tool_result_state, null, `${row.tool_name_raw} must be pending (NULL), not 'missing' — its result may still arrive`);
  }
});

await test("a tool_result arriving after a restart upgrades the pending fact", async () => {
  appendFileSync(toolsTranscript, toolsLine(toolResultLine("2026-09-01T09:00:05.000Z", "call_A", "alpha result text")));
  // Fresh process: in-memory link state is gone; only the stored offset
  // carries the pass forward and the recorded NULL row is what can upgrade.
  _resetTranscriptParseStateForTests();
  await ingestTranscript(db, toolsRunId, toolsTranscript, toolsSessionId);
  const rows = toolFactStates();
  const a = rows.find((r) => r.tool_name_raw === "Read");
  const b = rows.find((r) => r.tool_name_raw === "Bash");
  assertEqual(a.tool_result_state, "ok", "call_A must be upgraded to 'ok' by its late tool_result");
  assert(a.tool_result_bytes > 0, "upgraded row must carry the result size");
  assertEqual(b.tool_result_state, null, "call_B has no result yet — still pending, not 'missing'");
});

await test("a fact whose result never arrives is finalized only when the file stops growing", async () => {
  // No append since the last pass — the skip-cache matches (parsed at this
  // size), which is the OLD full-file EOF semantics: now 'missing' is final.
  _resetTranscriptParseStateForTests();
  await ingestTranscript(db, toolsRunId, toolsTranscript, toolsSessionId);
  const rows = toolFactStates();
  const a = rows.find((r) => r.tool_name_raw === "Read");
  const b = rows.find((r) => r.tool_name_raw === "Bash");
  assertEqual(a.tool_result_state, "ok", "resolved outcome must survive the finalize pass");
  assertEqual(b.tool_result_state, "missing", "call_B's result never arrived and the file is idle — 'missing' now");
});

// --- Scenario 5 (FOC-547 D1): same-process pending upgrade -------------------
// The crash the real-corpus driver exposed: pass 1 registers a pending
// tool_use in the SAME process's link state; the tool_result arrives while the
// file grows; the next pass resolves the pending use through recordToolFact.
// The pending entry must carry every bound column — the pre-fix snapshot held
// only the natural key, so agent_key (SQLite parameter 3) was undefined and
// node:sqlite threw "Provided value cannot be bound to SQLite parameter 3".
const tools2Dir = join(temp, "tools2");
mkdirSync(tools2Dir, { recursive: true });
const tools2Transcript = join(tools2Dir, "lead.jsonl");
const tools2SessionId = "session-tools2-1";
const tools2RunId = "run-tools2-1";

writeFileSync(tools2Transcript, [
  toolsLine({ type: "user", timestamp: "2026-09-01T10:00:00.000Z", sessionId: tools2SessionId, cwd: "C:/repos/fenix", gitBranch: "foc-547" }),
  toolsLine(toolUseLine("2026-09-01T10:00:01.000Z", "call_C", "Read", { file_path: "/tmp/c.txt" })),
  toolsLine(toolUseLine("2026-09-01T10:00:02.000Z", "call_D", "Bash", { command: "pwd" })),
].join(""), "utf8");

applyEvent(db, makeEvent("run.started", {
  runId: tools2RunId, squad: "dev", startedAt: "2026-09-01T10:00:00.000Z", cwd: "C:/repos/fenix",
}, { runId: tools2RunId }));
applyEvent(db, makeEvent("session.linked", {
  runId: tools2RunId, sessionId: tools2SessionId, transcriptPath: tools2Transcript,
}, { runId: tools2RunId }));

function toolFactRows2() {
  return db.prepare("SELECT agent_key, tool_name_raw, tool_result_state, tool_result_bytes FROM tool_facts WHERE run_id=? AND source_path=? ORDER BY tool_name_raw")
    .all(tools2RunId, tools2Transcript);
}

await test("same-process pass resolves a pending fact once its result arrives (D1)", async () => {
  const passA = await ingestTranscript(db, tools2RunId, tools2Transcript, tools2SessionId);
  assertEqual(passA.missing, false, "transcript present");
  let rows = toolFactRows2();
  assertEqual(rows.length, 2, "both tool_uses recorded pending");
  for (const row of rows) {
    assertEqual(row.agent_key, "_lead", "pending row carries its agent_key from the start");
    assertEqual(row.tool_result_state, null, "both pending (NULL) after pass A");
  }
  appendFileSync(tools2Transcript, toolsLine(toolResultLine("2026-09-01T10:00:05.000Z", "call_C", "gamma result text")));
  // NO state reset — same process, same link state, the live-tick shape.
  await ingestTranscript(db, tools2RunId, tools2Transcript, tools2SessionId);
  rows = toolFactRows2();
  const c = rows.find((r) => r.tool_name_raw === "Read");
  const d = rows.find((r) => r.tool_name_raw === "Bash");
  assertEqual(c.tool_result_state, "ok", "call_C resolved in-process once its result arrived");
  assert(c.tool_result_bytes > 0, "resolved row carries the result size");
  assertEqual(c.agent_key, "_lead", "resolved row keeps its identity fields");
  assertEqual(d.tool_result_state, null, "call_D still pending");
});

await test("same-process finalize of a still-pending fact keeps identity (D1)", async () => {
  // File unchanged since the last pass → the skip branch finalizes the
  // in-memory pending registry. The finalize re-bind must see every column.
  await ingestTranscript(db, tools2RunId, tools2Transcript, tools2SessionId);
  const rows = toolFactRows2();
  const d = rows.find((r) => r.tool_name_raw === "Bash");
  assertEqual(d.tool_result_state, "missing", "call_D finalized as 'missing' once the file is idle");
  assertEqual(d.agent_key, "_lead", "finalized row keeps its identity fields");
});

// --- Cleanup + summary -------------------------------------------------------
db.close();
try { rmSync(temp, { recursive: true, force: true }); } catch { /* Windows file locks */ }

console.log(`\n${passed} passed, ${skipped} skipped, ${failed} failed`);
if (failed > 0) {
  for (const failure of failures) console.error(`  FAILED: ${failure}`);
  process.exit(1);
}
