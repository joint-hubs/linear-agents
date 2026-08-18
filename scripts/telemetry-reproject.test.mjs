// Replaying the event log into the projections.
//
// Reproduces the state run 2026-07-27T07-10-36-661-dev-96ed was stuck in: the
// usage.recorded events are in `events`, usage_facts is empty, and re-ingest
// cannot help because eventAlreadyApplied correctly reports the events as
// already recorded. Before reprojectEvents there was no way back.
//
// Run: node scripts/telemetry-reproject.test.mjs

import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  applyEvent, makeEvent, openTelemetryDb, projectEvent, queryRuns, reprojectEvents,
} from "./telemetry-store.mjs";

let passed = 0;
let failed = 0;
const failures = [];
const temp = mkdtempSync(join(tmpdir(), "telemetry-reproject-"));
const db = openTelemetryDb(join(temp, "telemetry.sqlite"));

function test(name, fn) {
  try { fn(); passed++; console.log(`  PASS ${name}`); }
  catch (error) { failed++; failures.push(`${name}: ${error.message}`); console.log(`  FAIL ${name}: ${error.message}`); }
}
const assert = (v, m) => { if (!v) throw new Error(m || "assertion failed"); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m}: expected ${b}, got ${a}`); };

// Platform-native spelling, i.e. what makeEvent's canonicalisation produces.
// Fixtures that write the log directly must match it, or the dedup lookups in
// applyEvent will not recognise their own rows.
const SHARED = resolve("C:/sessions/shared.jsonl");

const usageRows = (runId) => db.prepare("SELECT COUNT(*) n FROM usage_facts WHERE run_id=?").get(runId).n;
const eventRows = (runId) => db.prepare("SELECT COUNT(*) n FROM events WHERE run_id=? AND event_type='usage.recorded'").get(runId).n;

/** An events row with no projection — exactly the stuck state. */
function orphanUsageEvent(runId, offset) {
  const event = makeEvent("usage.recorded", {
    runId, agentKey: "implementer", model: "deepseek-v4-flash",
    inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0,
    observedAt: "2026-07-27T08:00:00.000Z",
  }, {
    runId, observedAt: "2026-07-27T08:00:00.000Z", sourceKind: "transcript",
    sourcePath: SHARED, sourceOffset: offset,
  });
  // Write the log row directly, skipping the projection — the damage pattern.
  db.prepare(
    `INSERT INTO events (event_id, event_type, run_id, observed_at, host_id, source_kind,
       source_path, source_offset, payload_json, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(event.eventId, event.eventType, runId, event.observedAt, "test", "transcript",
    SHARED, offset, JSON.stringify(event.payload), event.observedAt);
  return event;
}

applyEvent(db, makeEvent("run.started", { runId: "run-stuck", squad: "dev", startedAt: "2026-07-27T07:00:00.000Z" }, { runId: "run-stuck" }));
for (let i = 0; i < 5; i++) orphanUsageEvent("run-stuck", 100 + i);

test("1. the stuck state is real: events present, projection empty", () => {
  eq(eventRows("run-stuck"), 5, "usage.recorded events");
  eq(usageRows("run-stuck"), 0, "usage_facts rows");
});

test("2. re-applying the same events cannot fix it (why re-ingest failed)", () => {
  // applyEvent sees the events as already recorded and returns duplicate before
  // reaching the handler. This is the trap, asserted so it stays understood.
  const row = db.prepare(
    "SELECT * FROM events WHERE run_id='run-stuck' AND event_type='usage.recorded' ORDER BY source_offset LIMIT 1",
  ).get();
  const result = applyEvent(db, makeEvent("usage.recorded", JSON.parse(row.payload_json), {
    runId: "run-stuck", observedAt: row.observed_at, sourceKind: row.source_kind,
    sourcePath: row.source_path, sourceOffset: row.source_offset,
  }));
  assert(result.duplicate, "a re-ingest of the same source location must be a duplicate");
  eq(usageRows("run-stuck"), 0, "usage_facts after re-ingest");
});

test("3. reprojectEvents rebuilds the projection from the log", () => {
  const summary = reprojectEvents(db, { runId: "run-stuck" });
  eq(summary.scanned, 5, "scanned");
  eq(summary.projected, 5, "projected");
  eq(summary.failed, 0, "failed");
  eq(usageRows("run-stuck"), 5, "usage_facts after reprojection");
});

test("4. the recovered facts carry real numbers, not empty rows", () => {
  const run = queryRuns(db, { runId: "run-stuck" })[0];
  eq(run.totals.inputTokens, 5000, "inputTokens");
  eq(run.totals.outputTokens, 500, "outputTokens");
  assert(run.totals.costUSD > 0, `costUSD=${run.totals.costUSD}`);
});

test("5. replay is idempotent — running it again changes nothing", () => {
  const before = usageRows("run-stuck");
  const summary = reprojectEvents(db, { runId: "run-stuck" });
  eq(usageRows("run-stuck"), before, "usage_facts after a second replay");
  eq(summary.duplicate, 5, "second pass must report every event as already projected");
});

test("6. replay never deletes: the events log is untouched", () => {
  eq(eventRows("run-stuck"), 5, "events after two replays");
});

test("7. scoping to a run leaves other runs alone", () => {
  applyEvent(db, makeEvent("run.started", { runId: "run-other", squad: "dev", startedAt: "2026-07-27T07:00:00.000Z" }, { runId: "run-other" }));
  for (let i = 0; i < 3; i++) orphanUsageEvent("run-other", 200 + i);
  reprojectEvents(db, { runId: "run-stuck" });
  eq(usageRows("run-other"), 0, "the other run must not be touched");
  reprojectEvents(db, { runId: "run-other" });
  eq(usageRows("run-other"), 3, "the other run replays on request");
});

test("8. dry run reports without writing", () => {
  for (let i = 0; i < 2; i++) orphanUsageEvent("run-dry", 300 + i);
  applyEvent(db, makeEvent("run.started", { runId: "run-dry", squad: "dev", startedAt: "2026-07-27T07:00:00.000Z" }, { runId: "run-dry" }));
  const summary = reprojectEvents(db, { runId: "run-dry", dryRun: true });
  eq(summary.scanned, 2, "dry run must still count");
  eq(summary.projected, 0, "dry run must not project");
  eq(usageRows("run-dry"), 0, "dry run must not write");
});

test("9. a malformed event is counted, not fatal", () => {
  db.prepare(
    `INSERT INTO events (event_id, event_type, run_id, observed_at, host_id, source_kind,
       source_path, source_offset, payload_json, ingested_at)
     VALUES ('broken-1','usage.recorded','run-broken','2026-07-27T08:00:00.000Z','test','transcript',NULL,NULL,'{}','2026-07-27T08:00:00.000Z')`,
  ).run();
  const summary = reprojectEvents(db, { runId: "run-broken" });
  eq(summary.failed, 1, "the malformed event must be reported as failed");
  assert(summary.errors.length === 1, "the error must be surfaced");
});

test("10. projectEvent is what applyEvent uses, not a parallel copy", () => {
  // Guards against the two paths drifting: a handler added to one and not the
  // other would silently make replay incomplete.
  const before = usageRows("run-stuck");
  projectEvent(db, {
    eventId: "direct-1", eventType: "usage.recorded", runId: "run-stuck",
    observedAt: "2026-07-27T09:00:00.000Z",
    source: { kind: "transcript", path: SHARED, offset: 999 },
    payload: { runId: "run-stuck", agentKey: "_lead", model: "deepseek-v4-flash", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
  });
  eq(usageRows("run-stuck"), before + 1, "projectEvent must write a fact on its own");
});

// --- path canonicalisation -------------------------------------------------
// The same file under two spellings used to become two usage_ids and double the
// cost. makeEvent now canonicalises, so the second spelling is a duplicate.

test("11. the same file under two spellings is one fact, not two", () => {
  const runId = "run-spelling";
  applyEvent(db, makeEvent("run.started", { runId, squad: "dev", startedAt: "2026-08-01T10:00:00.000Z" }, { runId }));
  const usage = {
    runId, agentKey: "implementer", model: "deepseek-v4-flash",
    inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0,
    observedAt: "2026-08-01T10:01:00.000Z",
  };
  const opts = (path) => ({
    runId, observedAt: "2026-08-01T10:01:00.000Z", sourceKind: "transcript",
    sourcePath: path, sourceOffset: 42,
  });
  applyEvent(db, makeEvent("usage.recorded", usage, opts("C:\\sessions\\spelling.jsonl")));
  const second = applyEvent(db, makeEvent("usage.recorded", usage, opts("C:/sessions/spelling.jsonl")));

  assert(second.duplicate, "the same file spelled the other way must be a duplicate");
  eq(usageRows(runId), 1, "usage_facts rows for one turn recorded twice");
  const run = queryRuns(db, { runId })[0];
  eq(run.totals.inputTokens, 1000, "tokens must not double");
});

test("12. canonicalisation does not merge genuinely different files", () => {
  const runId = "run-distinct";
  applyEvent(db, makeEvent("run.started", { runId, squad: "dev", startedAt: "2026-08-01T11:00:00.000Z" }, { runId }));
  const usage = {
    runId, agentKey: "implementer", model: "deepseek-v4-flash",
    inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0,
    observedAt: "2026-08-01T11:01:00.000Z",
  };
  for (const path of ["C:\\sessions\\a.jsonl", "C:\\sessions\\b.jsonl"]) {
    applyEvent(db, makeEvent("usage.recorded", usage, {
      runId, observedAt: "2026-08-01T11:01:00.000Z", sourceKind: "transcript",
      sourcePath: path, sourceOffset: 7,
    }));
  }
  eq(usageRows(runId), 2, "two different files at the same offset are two facts");
});

test("13. a relative path is left alone, not resolved against cwd", () => {
  // Resolving it would invent an identity from whatever directory the caller
  // happened to be in, which is worse than leaving it as written.
  const event = makeEvent("usage.recorded", {}, { sourcePath: "relative/thing.jsonl" });
  eq(event.source.path, "relative/thing.jsonl", "relative path must survive verbatim");
});

db.close();
rmSync(temp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) console.log(failures.map((f) => `  - ${f}`).join("\n"));
process.exit(failed === 0 ? 0 : 1);
