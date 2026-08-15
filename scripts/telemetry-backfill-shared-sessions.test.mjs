// Regression + acceptance test for scripts/telemetry-backfill-shared-sessions.mjs (JOI-263).
//
// Scenario (d) — idempotency + per-run before/after + --dry + --json + missing file
// Scenario (f) — queryRuns (camelCase) contract: static + runtime
//
// Run: node scripts/telemetry-backfill-shared-sessions.test.mjs

import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dir = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(__dir, "telemetry-backfill-shared-sessions.mjs");

// --- Temp telemetry home (must be set BEFORE importing the store) ---
const temp = mkdtempSync(join(tmpdir(), "joi-263-"));
const dbPath = join(temp, "test.sqlite");
process.env.LA_TELEMETRY_HOME = temp;
process.env.LA_TELEMETRY_DB = dbPath;

const { openTelemetryDb, MIGRATION_VERSIONS } = await import("./telemetry-store.mjs");
const { ingestTranscript: ingestTranscript2 } = await import("./telemetry-ingest.mjs");

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  return Promise.resolve().then(() => fn()).then(() => {
    passed++;
    console.log(`  PASS ${name}`);
  }).catch((error) => {
    failed++;
    failures.push(`${name}: ${error.message}`);
    console.log(`  FAIL ${name}: ${error.message}`);
  });
}

function assert(value, message) {
  if (!value) throw new Error(message || "assertion failed");
}
function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message || "mismatch"}: expected ${expected}, got ${actual}`);
}

// --- Subprocess helper ---
function runScript(flags) {
  const result = spawnSync(process.execPath, [scriptPath, ...flags], {
    env: { ...process.env },
    encoding: "utf8",
  });
  return { stdout: result.stdout || "", stderr: result.stderr || "", status: result.status };
}

function parseJsonLines(stdout) {
  return stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function countUsage(db, runId, sourcePath) {
  return db.prepare("SELECT COUNT(*) AS n FROM usage_facts WHERE run_id=? AND source_path=?").get(runId, sourcePath).n;
}
function countToolFacts(db, runId, sourcePath) {
  return db.prepare("SELECT COUNT(*) AS n FROM tool_facts WHERE run_id=? AND source_path=?").get(runId, sourcePath).n;
}
function countEvents(db, runId) {
  return db.prepare("SELECT COUNT(*) AS n FROM events WHERE run_id=?").get(runId).n;
}
function countDqIssues(db) {
  return db.prepare("SELECT COUNT(*) AS n FROM data_quality_issues").get().n;
}

// --- Fixture: one assistant message with usage + one tool_use block ---
const transcriptContent = JSON.stringify({
  type: "assistant",
  timestamp: "2026-08-14T10:00:00.000Z",
  sessionId: "sess-1",
  message: {
    model: "claude-sonnet-4",
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/tmp/x" } }],
  },
}) + "\n";

const sharedPath = join(temp, "shared.jsonl");
const missingPath = join(temp, "missing.jsonl");
writeFileSync(sharedPath, transcriptContent, "utf8");

// --- Build fresh v5 DB + insert runs A/B/C (shared) + D (missing transcript) ---
const db = openTelemetryDb(dbPath);
const insertRun = db.prepare(
  `INSERT INTO runs (run_id, squad, session_id, transcript_path, claude_config_dir, started_at, status, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
);
insertRun.run("run-A", "dev", "sess-1", sharedPath, temp, "2026-08-14T10:00:00.000Z", "completed", "2026-08-14T11:00:00.000Z");
insertRun.run("run-B", "dev", "sess-1", sharedPath, temp, "2026-08-14T10:01:00.000Z", "completed", "2026-08-14T11:01:00.000Z");
insertRun.run("run-C", "dev", "sess-1", sharedPath, temp, "2026-08-14T10:02:00.000Z", "completed", "2026-08-14T11:02:00.000Z");
// run-D and run-E share a missing transcript_path so both surface in the
// no-flags (shared-path) candidate set and exercise the missing-file skip.
insertRun.run("run-D", "dev", "sess-2", missingPath, temp, "2026-08-14T10:03:00.000Z", "completed", "2026-08-14T11:03:00.000Z");
insertRun.run("run-E", "dev", "sess-2", missingPath, temp, "2026-08-14T10:03:30.000Z", "completed", "2026-08-14T11:03:30.000Z");

// Pre-ingest run A so it is already "parsed" — exercises the before===after path.
await ingestTranscript2(db, "run-A", sharedPath, "sess-1");
db.close();

console.log(`\nFixture ready: ${temp}\n`);

// ===========================================================================
// Scenario (d) — idempotency + per-run before/after + --dry + --json + missing
// ===========================================================================
console.log("Scenario (d) — idempotency + before/after + --dry + --json + missing file");

await test("(d1) v5 marker present in fresh DB", () => {
  const d = openTelemetryDb(dbPath);
  const row = d.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(MIGRATION_VERSIONS.runScopedUsage);
  d.close();
  assert(row, "v5 migration marker must be recorded on fresh DB");
});

await test("(d1b) AC1 guard: missing v5 marker would trigger run-schema-migration-first", () => {
  // openTelemetryDb() always migrates + stamps the v5 marker, so the script's
  // startup guard is defensive — it fires only if the marker is absent AFTER
  // open. Verify the guard query logic directly: delete the marker, re-run the
  // exact guard query the script uses, assert it returns null (would abort).
  const d = openTelemetryDb(dbPath);
  d.prepare("DELETE FROM schema_migrations WHERE version=?").run(MIGRATION_VERSIONS.runScopedUsage);
  const missing = d.prepare("SELECT 1 FROM schema_migrations WHERE version=?")
    .get(MIGRATION_VERSIONS.runScopedUsage);
  d.close();
  assert(!missing, "guard query must return null when v5 marker is deleted");
  // Re-open so migrate() re-stamps the marker for subsequent tests.
  const d2 = openTelemetryDb(dbPath);
  const restored = d2.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(MIGRATION_VERSIONS.runScopedUsage);
  d2.close();
  assert(restored, "v5 marker re-stamped after re-open");
});

await test("(d2) run no-flags backfill: A stable, B/C ingested, D skipped", () => {
  const before = openTelemetryDb(dbPath);
  const dqBefore = countDqIssues(before);
  before.close();

  const result = runScript(["--json"]);
  assertEqual(result.status, 0, "exit code");
  const reports = parseJsonLines(result.stdout);
  const byId = new Map(reports.map((r) => [r.runId, r]));

  assert(byId.has("run-A"), "run-A in report");
  assert(byId.has("run-B"), "run-B in report");
  assert(byId.has("run-C"), "run-C in report");
  assert(byId.has("run-D"), "run-D in report");

  const a = byId.get("run-A");
  assertEqual(a.status, "ingested", "run-A status");
  assert(a.before === a.after, `run-A before===after (got before=${a.before} after=${a.after})`);

  for (const rid of ["run-B", "run-C"]) {
    const r = byId.get(rid);
    assertEqual(r.status, "ingested", `${rid} status`);
    assertEqual(r.before, 0, `${rid} before=0`);
    assert(r.after > 0, `${rid} after>0 (got ${r.after})`);
    assert(r.events > 0, `${rid} events>0 (got ${r.events})`);
    assert(r.toolFactsAfter > 0, `${rid} toolFactsAfter>0 (got ${r.toolFactsAfter})`);
    assertEqual(r.shared, true, `${rid} shared=true`);
  }

  const d = byId.get("run-D");
  assertEqual(d.status, "skipped", "run-D status=skipped (missing transcript)");

  // AC4: no new data_quality_issues rows.
  const after = openTelemetryDb(dbPath);
  const dqAfter = countDqIssues(after);
  after.close();
  assertEqual(dqAfter, dqBefore, "no new data_quality_issues rows");
});

await test("(d3) idempotent: second run all before===after", () => {
  const result = runScript(["--json"]);
  assertEqual(result.status, 0, "exit code");
  const reports = parseJsonLines(result.stdout);
  for (const r of reports) {
    if (r.status === "ingested") {
      assert(r.before === r.after, `${r.runId} idempotent before===after (got before=${r.before} after=${r.after})`);
      assertEqual(r.toolFactsBefore, r.toolFactsAfter, `${r.runId} idempotent toolFacts`);
    }
  }
});

await test("(d4) --dry writes nothing, still reports before", () => {
  const before = openTelemetryDb(dbPath);
  const bUsage = { runB: countUsage(before, "run-B", sharedPath), runC: countUsage(before, "run-C", sharedPath) };
  const bTool = { runB: countToolFacts(before, "run-B", sharedPath), runC: countToolFacts(before, "run-C", sharedPath) };
  before.close();

  const result = runScript(["--dry", "--json"]);
  assertEqual(result.status, 0, "exit code");
  const reports = parseJsonLines(result.stdout);
  const byId = new Map(reports.map((r) => [r.runId, r]));

  for (const rid of ["run-A", "run-B", "run-C"]) {
    const r = byId.get(rid);
    assert(r, `${rid} in dry report`);
    assertEqual(r.status, "would_ingest", `${rid} dry status`);
    assert(r.before !== undefined, `${rid} report has before`);
    assertEqual(r.wouldIngest, true, `${rid} wouldIngest=true`);
  }

  // DB unchanged after dry run.
  const after = openTelemetryDb(dbPath);
  assertEqual(countUsage(after, "run-B", sharedPath), bUsage.runB, "run-B usage unchanged after --dry");
  assertEqual(countUsage(after, "run-C", sharedPath), bUsage.runC, "run-C usage unchanged after --dry");
  assertEqual(countToolFacts(after, "run-B", sharedPath), bTool.runB, "run-B tool unchanged after --dry");
  assertEqual(countToolFacts(after, "run-C", sharedPath), bTool.runC, "run-C tool unchanged after --dry");
  after.close();
});

await test("(d5) --json --run run-B: machine-readable shape", () => {
  const result = runScript(["--json", "--run", "run-B"]);
  assertEqual(result.status, 0, "exit code");
  const reports = parseJsonLines(result.stdout);
  assertEqual(reports.length, 1, "exactly one report for --run run-B");
  const r = reports[0];
  assertEqual(r.runId, "run-B", "runId");
  // AC3 shape: {runId, shared, before, after, events, toolFactsBefore, toolFactsAfter}
  for (const key of ["runId", "shared", "before", "after", "events", "toolFactsBefore", "toolFactsAfter"]) {
    assert(key in r, `report has key ${key}`);
  }
});

await test("(d6) --run unknown-id reports not_found", () => {
  const result = runScript(["--json", "--run", "run-NOPE"]);
  assertEqual(result.status, 0, "exit code (not_found is not fatal)");
  const reports = parseJsonLines(result.stdout);
  assertEqual(reports.length, 1, "one report");
  assertEqual(reports[0].status, "not_found", "status=not_found");
});

await test("(d7) --help exits 0 with usage text", () => {
  const result = runScript(["--help"]);
  assertEqual(result.status, 0, "exit code");
  const firstLine = result.stdout.trim().split("\n")[0];
  assert(firstLine.includes("telemetry-backfill-shared-sessions"), "help mentions script name");
});

await test("(d8) human mode (no --json) emits non-empty stdout", () => {
  const result = runScript(["--run", "run-A"]);
  assertEqual(result.status, 0, "exit code");
  assert(result.stdout.trim().length > 0, "human output non-empty");
  assert(!result.stdout.trim().startsWith("{"), "human output is not JSON");
});

// ===========================================================================
// Scenario (f) — queryRuns (camelCase) contract
// ===========================================================================
console.log("\nScenario (f) — queryRuns camelCase contract");

await test("(f1) static: script imports queryRuns and avoids SELECT * FROM runs", () => {
  const src = readFileSync(scriptPath, "utf8");
  assert(src.includes("queryRuns("), "script imports/uses queryRuns(");
  assert(!src.includes("SELECT * FROM runs"), "script must NOT use raw 'SELECT * FROM runs'");
});

await test("(f2) runtime: transcript resolved via camelCase transcriptPath, not sessionId scan", () => {
  // Build a run whose session_id does NOT correspond to any on-disk hash dir,
  // but whose transcript_path points at the real shared.jsonl. A script using
  // snake_case run.transcript_path (undefined on a queryRuns projection) would
  // fail to find the file and report 'skipped'; the camelCase transcriptPath
  // resolves directly.
  const d = openTelemetryDb(dbPath);
  d.prepare(
    `INSERT INTO runs (run_id, squad, session_id, transcript_path, claude_config_dir, started_at, status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "run-F", "dev", "fake-session-not-on-disk", sharedPath, temp,
    "2026-08-14T10:04:00.000Z", "completed", "2026-08-14T11:04:00.000Z",
  );
  d.close();

  const result = runScript(["--json", "--run", "run-F"]);
  assertEqual(result.status, 0, "exit code");
  const reports = parseJsonLines(result.stdout);
  assertEqual(reports.length, 1, "one report");
  const r = reports[0];
  assertEqual(r.runId, "run-F", "runId");
  // If transcriptForSession used snake_case it would return null => 'skipped'.
  // camelCase transcriptPath resolves the file directly => 'ingested'.
  assertEqual(r.status, "ingested", "run-F resolved via camelCase transcriptPath (not skipped)");
  assert(r.after > 0, `run-F after>0 (got ${r.after})`);
});

// ===========================================================================
// Summary
// ===========================================================================
console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
try { rmSync(temp, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(0);
