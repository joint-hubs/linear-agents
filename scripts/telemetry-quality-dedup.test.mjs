// Regression test for the quality.reported event leak.
//
// telemetry-server re-runs ingestKnownRuns() every 15s. Every run whose
// transcript is gone used to append a brand-new quality.reported row on every
// tick: reportDataQuality() supplies no source path/offset, so neither the
// generic dedup nor UNIQUE(source_kind, source_path, source_offset, event_type)
// could catch it (SQLite treats all-NULL unique keys as distinct).
//
// Observed on the production database 2026-08-14 before the fix:
//   events                5 856 829 rows   (4.6 GB, ~195k new rows/hour)
//   quality.reported      5 791 702 rows   98.9% of the table, across 189 runs
//   data_quality_issues         276 rows   what they all collapse into
//
// The rebuild those rows forced (schema v5) took four hours, and openTelemetryDb()
// re-runs migrations on every open — so every launcher inherited the stall.
//
// Run: node scripts/telemetry-quality-dedup.test.mjs

import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const temp = mkdtempSync(join(tmpdir(), "telemetry-quality-dedup-"));
const dbPath = join(temp, "telemetry.sqlite");
process.env.LA_TELEMETRY_HOME = temp;
process.env.LA_TELEMETRY_DB = dbPath;

const {
  applyEvent, emitEvent, makeEvent, openTelemetryDb, reportDataQuality,
  resolveQualityIssue, hasOpenQualityIssue, spoolPaths,
} = await import("./telemetry-store.mjs");

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (error) {
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

const db = openTelemetryDb(dbPath);
const countEvents = (runId) => db.prepare(
  "SELECT COUNT(*) n FROM events WHERE event_type='quality.reported' AND run_id IS ?",
).get(runId ?? null).n;
const countIssues = (runId) => db.prepare(
  "SELECT COUNT(*) n FROM data_quality_issues WHERE run_id IS ?",
).get(runId ?? null).n;

function seedRun(runId) {
  applyEvent(db, makeEvent("run.started", { runId, squad: "dev", startedAt: "2026-08-14T08:00:00.000Z" }, {
    runId, sourceKind: "test", sourcePath: `${runId}.json`, sourceOffset: 0,
  }));
}

function report(runId, issueType = "transcript_missing", details = {}) {
  return applyEvent(db, makeEvent("quality.reported", { runId, issueType, details, severity: "warning" }, {
    runId, sourceKind: "runtime",
  }));
}

// ---------------------------------------------------------------- the leak

test("1. first report is recorded", () => {
  seedRun("run-leak");
  const result = report("run-leak");
  assert(!result.duplicate, "first report must not be treated as a duplicate");
  assertEqual(countEvents("run-leak"), 1, "events after first report");
  assertEqual(countIssues("run-leak"), 1, "issues after first report");
});

test("2. an identical repeat is a duplicate, not a new row", () => {
  const result = report("run-leak");
  assert(result.duplicate, "repeat must report duplicate:true");
  assertEqual(countEvents("run-leak"), 1, "events after repeat");
});

test("3. 500 ticks of the ingest loop add nothing (the actual regression)", () => {
  for (let i = 0; i < 500; i++) report("run-leak");
  assertEqual(countEvents("run-leak"), 1, "events after 500 ticks");
  assertEqual(countIssues("run-leak"), 1, "issues after 500 ticks");
});

test("4. changing only the details payload does not defeat the dedup", () => {
  // The projection keys on (run_id, issue_type); details vary per tick
  // (sessionId, manifestPath), so keying the event on details would have
  // reopened the leak at a slower rate.
  report("run-leak", "transcript_missing", { sessionId: "s-1" });
  report("run-leak", "transcript_missing", { sessionId: "s-2" });
  report("run-leak", "transcript_missing", { manifestPath: "x.json" });
  assertEqual(countEvents("run-leak"), 1, "events after varied details");
});

// ------------------------------------------------- what must still get through

test("5. a different issue type is a separate event", () => {
  report("run-leak", "legacy_session_ambiguous");
  assertEqual(countEvents("run-leak"), 2, "events after a second issue type");
  assertEqual(countIssues("run-leak"), 2, "issues after a second issue type");
});

test("6. a different run is a separate event", () => {
  seedRun("run-other");
  report("run-other");
  assertEqual(countEvents("run-other"), 1, "events for the second run");
  assertEqual(countEvents("run-leak"), 2, "first run is unaffected");
});

test("7. re-raising after resolve still records a new event", () => {
  resolveQualityIssue(db, "run-other", "transcript_missing");
  assert(!hasOpenQualityIssue(db, "run-other", "transcript_missing"), "issue should be resolved");
  const result = report("run-other");
  assert(!result.duplicate, "a resolved issue must be reportable again");
  assertEqual(countEvents("run-other"), 2, "events after re-raise");
});

test("8. hasOpenQualityIssue reflects open/resolved state", () => {
  assert(hasOpenQualityIssue(db, "run-leak", "transcript_missing"), "open issue must read as open");
  assert(!hasOpenQualityIssue(db, "run-leak", "never_raised"), "unknown type must read as not open");
  assert(!hasOpenQualityIssue(db, "run-missing", "transcript_missing"), "unknown run must read as not open");
});

test("9. a report with no issueType is rejected, not silently deduped", () => {
  // Via emitEvent, because applyEvent() inserts the row before dispatching to
  // applyQualityReported() — only the surrounding transaction rolls the orphan
  // row back. A bare applyEvent() here would leave one behind and make test 10
  // count it.
  const before = countEvents("run-leak");
  const result = emitEvent(makeEvent("quality.reported", { runId: "run-leak", severity: "warning" }, {
    runId: "run-leak", sourceKind: "runtime",
  }));
  assert(!result.ingested, "an event without issueType must not be ingested");
  assert(/issueType/.test(result.error || ""), `expected an issueType error, got: ${result.error}`);
  assertEqual(countEvents("run-leak"), before, "rejected event must leave no row behind");
});

// ------------------------------------------------------- the full emit path

test("10. duplicate emits leave no spool file behind", () => {
  // emitEvent() writes a pending file before touching the database and moves it
  // to the archive on success. A duplicate must delete it instead — otherwise
  // the leak just moves from the events table to the filesystem.
  db.close();
  const { archive, pending } = spoolPaths();
  const count = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith(".json")).length : 0);

  // Deltas, not absolutes: test 9 deliberately leaves one file in pending (an
  // event that failed to apply is spooled for replay — that path is unrelated).
  const archiveBefore = count(archive);
  const pendingBefore = count(pending);
  for (let i = 0; i < 25; i++) reportDataQuality("run-leak", "transcript_missing", { sessionId: `s-${i}` });
  assertEqual(count(archive) - archiveBefore, 0, "archive files added by 25 duplicate emits");
  assertEqual(count(pending) - pendingBefore, 0, "pending files added by 25 duplicate emits");

  const verify = openTelemetryDb(dbPath);
  const total = verify.prepare("SELECT COUNT(*) n FROM events WHERE event_type='quality.reported'").get().n;
  verify.close();
  assertEqual(total, 4, "total quality.reported rows across the whole test");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) console.log(failures.map((f) => `  - ${f}`).join("\n"));
rmSync(temp, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
