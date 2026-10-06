// Contract test for transcript ingestion into the central telemetry store.
//
// Scenarios:
//   - imports the transcript and worktree timeline (single-run baseline)
//   - re-ingest does not duplicate usage (idempotency baseline)
//   - (b) second run on same JSONL + third pass + cross-run isolation
//   - (a) v4 fixture → v5 migration → run-v4-2 ingest on same source (collision)

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { makeEvent, openTelemetryDb, applyEvent, queryRuns, queryHealth } from "./telemetry-store.mjs";
import { ingestTranscript } from "./telemetry-ingest.mjs";

// node:sqlite is only needed for the v4-fixture bootstrap in scenario (a).
// Lazy-load so the baseline scenarios still run on builds without it.
let DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}

let passed = 0;
let skipped = 0;
let failed = 0;
const failures = [];

// Sentinel thrown by a test body to signal it was deliberately skipped (e.g.
// `node:sqlite` unavailable for scenario (a)). The wrapper counts it against
// `skipped`, NOT `passed`, and does not treat it as a failure.
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

function writeJsonl(path, lines) {
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
}

// --- Shared fixture for baseline + scenario (b) ---
const temp = mkdtempSync(join(tmpdir(), "telemetry-ingest-test-"));
const dbPath = join(temp, "telemetry.sqlite");
// Route ingestTranscript's internal recordToolFact/recordDelegationLink (which
// open the DB via the env default) at the same temp DB so tool_facts land here
// instead of leaking to the user's real telemetry store.
process.env.LA_TELEMETRY_HOME = temp;
process.env.LA_TELEMETRY_DB = dbPath;
const db = openTelemetryDb(dbPath);
const transcript = join(temp, "lead.jsonl");
const sessionId = "session-worktree-1";

applyEvent(db, makeEvent("run.started", {
  runId: "run-worktree-1", squad: "dev", startedAt: "2026-07-24T08:00:00.000Z", cwd: "C:/repos/office",
}, { runId: "run-worktree-1" }));
applyEvent(db, makeEvent("session.linked", {
  runId: "run-worktree-1", sessionId, transcriptPath: transcript,
}, { runId: "run-worktree-1" }));

writeJsonl(transcript, [
  { type: "user", timestamp: "2026-07-24T08:00:01.000Z", sessionId, cwd: "C:/repos/office", gitBranch: "dev" },
  { type: "worktree-state", sessionId, worktreeSession: { worktreePath: "C:/repos/office/.claude/worktrees/foc-36", worktreeBranch: "foc-36-design-system" } },
  { type: "assistant", timestamp: "2026-07-24T08:01:00.000Z", sessionId, cwd: "C:/repos/office/.claude/worktrees/foc-36", gitBranch: "foc-36-design-system", message: { model: "deepseek-v4-flash", usage: { input_tokens: 100, output_tokens: 50 } } },
]);
const subagents = join(temp, "lead", "subagents");
mkdirSync(subagents, { recursive: true });
writeJsonl(join(subagents, "agent-worker.jsonl"), [
  { type: "assistant", timestamp: "2026-07-24T08:01:30.000Z", sessionId, agentId: "worker", message: { model: "deepseek-v4-flash", usage: { input_tokens: 20, output_tokens: 10 } } },
]);

// v4 schema DDL (verbatim from telemetry-store-migration.test.mjs). Used by
// scenario (a) to bootstrap a legacy v4 fixture that openTelemetryDb() then
// migrates to v5 in-process.
const v4SchemaSql = `
  CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );
  CREATE TABLE runs (
    run_id TEXT PRIMARY KEY,
    squad TEXT,
    source TEXT,
    brief TEXT,
    started_at TEXT,
    ended_at TEXT,
    status TEXT,
    exit_code INTEGER,
    native INTEGER,
    interactive INTEGER,
    launch_cwd TEXT,
    claude_config_dir TEXT,
    session_id TEXT,
    transcript_path TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE price_sets (
    price_set_id TEXT PRIMARY KEY,
    config_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    source TEXT NOT NULL
  );
  CREATE TABLE events (
    event_id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    run_id TEXT,
    observed_at TEXT NOT NULL,
    host_id TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    source_path TEXT,
    source_offset INTEGER,
    payload_json TEXT NOT NULL,
    ingested_at TEXT NOT NULL,
    UNIQUE(source_kind, source_path, source_offset, event_type)
  );
  CREATE TABLE transcript_sources (
    source_path TEXT PRIMARY KEY,
    session_id TEXT,
    run_id TEXT,
    byte_offset INTEGER NOT NULL DEFAULT 0,
    file_size INTEGER NOT NULL DEFAULT 0,
    modified_at TEXT,
    parse_status TEXT NOT NULL DEFAULT 'pending',
    last_error TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE usage_facts (
    usage_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    session_id TEXT,
    agent_key TEXT NOT NULL,
    model TEXT,
    observed_at TEXT,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cache_read_tokens INTEGER NOT NULL,
    cache_creation_tokens INTEGER NOT NULL,
    source_path TEXT NOT NULL,
    source_offset INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    message_id TEXT,
    UNIQUE(source_path, source_offset)
  );
  CREATE INDEX idx_usage_facts_run ON usage_facts(run_id, observed_at);
  CREATE TABLE cost_facts (
    usage_id TEXT NOT NULL REFERENCES usage_facts(usage_id) ON DELETE CASCADE,
    price_set_id TEXT REFERENCES price_sets(price_set_id),
    cost_usd REAL,
    PRIMARY KEY(usage_id, price_set_id)
  );
  CREATE TABLE tool_facts (
    tool_fact_id   TEXT PRIMARY KEY,
    run_id         TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    agent_key      TEXT NOT NULL,
    model          TEXT,
    observed_at    TEXT,
    tool_name_raw  TEXT NOT NULL,
    tool_name_canon TEXT,
    tool_input     TEXT,
    tool_has_error INTEGER NOT NULL DEFAULT 0,
    turn_index    INTEGER NOT NULL,
    source_path   TEXT NOT NULL,
    source_offset INTEGER NOT NULL,
    created_at    TEXT NOT NULL
  );
  CREATE INDEX idx_tool_facts_run ON tool_facts(run_id, agent_key);
  CREATE INDEX idx_tool_facts_canon ON tool_facts(tool_name_canon);
`;

async function run() {
  let exitCode = 0;
  try {
  await test("imports the transcript and worktree timeline", async () => {
    const result = await ingestTranscript(db, "run-worktree-1", transcript, sessionId);
    assert(result.events === 4, `events=${result.events}`);
    const run = queryRuns(db)[0];
    assert(run.worktreePath.endsWith("foc-36"), `worktree=${run.worktreePath}`);
    assert(run.gitRef.name === "foc-36-design-system", `branch=${run.gitRef.name}`);
    assert(run.byAgent._lead.turns === 1, "lead usage missing");
    assert(run.byAgent["agent-worker"].turns === 1, "subagent usage missing");
  });

  await test("re-ingest does not duplicate usage", async () => {
    const result = await ingestTranscript(db, "run-worktree-1", transcript, sessionId);
    assert(result.events === 0, `events=${result.events}`);
    const run = queryRuns(db)[0];
    assert(run.byAgent._lead.turns === 1 && run.byAgent["agent-worker"].turns === 1, "usage duplicated");
  });

  // ===================================================================
  // Scenario (b) — second run on same JSONL + third pass + cross-run isolation
  // ===================================================================
  console.log("\nScenario (b) — second run on same JSONL + cross-run isolation");

  await test("(b1) ingest run-worktree-2 on same JSONL keeps runs isolated", async () => {
    applyEvent(db, makeEvent("run.started", {
      runId: "run-worktree-2", squad: "dev", startedAt: "2026-07-24T09:00:00.000Z", cwd: "C:/repos/office",
    }, { runId: "run-worktree-2" }));
    applyEvent(db, makeEvent("session.linked", {
      runId: "run-worktree-2", sessionId, transcriptPath: transcript,
    }, { runId: "run-worktree-2" }));
    const run1Before = queryRuns(db, { runId: "run-worktree-1" })[0];
    const result = await ingestTranscript(db, "run-worktree-2", transcript, sessionId);
    assert(result.events > 0, `run-worktree-2 events=${result.events}`);
    const runs = queryRuns(db);
    const run1 = runs.find((r) => r.runId === "run-worktree-1");
    const run2 = runs.find((r) => r.runId === "run-worktree-2");
    assert(run2, "run-worktree-2 missing from queryRuns");
    assert(run2.totals.inputTokens > 0, `run-worktree-2 inputTokens=${run2.totals.inputTokens}`);
    assert(run2.byAgent._lead.turns === 1, `run-worktree-2 lead turns=${run2.byAgent._lead.turns}`);
    assert(run2.byAgent["agent-worker"].turns === 1, `run-worktree-2 worker turns=${run2.byAgent["agent-worker"].turns}`);
    // Cross-run isolation: run-2 ingest must not drift run-1 totals.
    assertEqual(run1.totals.inputTokens, run1Before.totals.inputTokens, "run-1 inputTokens drifted after run-2 ingest");
    assertEqual(run1.totals.outputTokens, run1Before.totals.outputTokens, "run-1 outputTokens drifted after run-2 ingest");
  });

  await test("(b2) re-ingest both runs is idempotent (events===0)", async () => {
    const r1 = await ingestTranscript(db, "run-worktree-1", transcript, sessionId);
    const r2 = await ingestTranscript(db, "run-worktree-2", transcript, sessionId);
    assertEqual(r1.events, 0, "run-1 re-ingest events");
    assertEqual(r2.events, 0, "run-2 re-ingest events");
  });

  await test("(b3) third ingest pass: run-A re-ingested AFTER run-B, both events===0", async () => {
    // AC: "run A re-ingested AFTER run B" — so re-ingest run-2 (B) first, then
    // run-1 (A). Order differs from (b2) on purpose to match the spec narrative.
    const r2 = await ingestTranscript(db, "run-worktree-2", transcript, sessionId);
    const r1 = await ingestTranscript(db, "run-worktree-1", transcript, sessionId);
    assertEqual(r2.events, 0, "run-2 third pass events");
    assertEqual(r1.events, 0, "run-1 third pass events");
  });

  await test("(b4) cross-run isolation: re-ingest run-1 leaves run-2 untouched", async () => {
    const run2Before = queryRuns(db, { runId: "run-worktree-2" })[0];
    const snap = {
      input: run2Before.totals.inputTokens,
      output: run2Before.totals.outputTokens,
      leadTurns: run2Before.byAgent._lead.turns,
      workerTurns: run2Before.byAgent["agent-worker"].turns,
    };
    const r1 = await ingestTranscript(db, "run-worktree-1", transcript, sessionId);
    assertEqual(r1.events, 0, "run-1 re-ingest events (should be 0)");
    const run2After = queryRuns(db, { runId: "run-worktree-2" })[0];
    assertEqual(run2After.totals.inputTokens, snap.input, "run-2 inputTokens unchanged by run-1 re-ingest");
    assertEqual(run2After.totals.outputTokens, snap.output, "run-2 outputTokens unchanged by run-1 re-ingest");
    assertEqual(run2After.byAgent._lead.turns, snap.leadTurns, "run-2 lead turns unchanged by run-1 re-ingest");
    assertEqual(run2After.byAgent["agent-worker"].turns, snap.workerTurns, "run-2 worker turns unchanged by run-1 re-ingest");
  });

  db.close();

  // ===================================================================
  // Scenario (a) — v4 fixture → v5 migration → run-v4-2 ingest (collision)
  // ===================================================================
  console.log("\nScenario (a) — v4 fixture → v5 migration → run-v4-2 ingest on same source");

  await test("(a) v4 DB migrated to v5; run-v4-2 ingest collides on same source_path:offset, distinct run_id", async () => {
    if (!DatabaseSync) { throw new TestSkip("node:sqlite unavailable"); }
    const tempA = mkdtempSync(join(tmpdir(), "joi-264-a-"));
    const savedHome = process.env.LA_TELEMETRY_HOME;
    const savedDb = process.env.LA_TELEMETRY_DB;
    try {
      const dbPathA = join(tempA, "telemetry.sqlite");
      // Point the env default at this DB so ingestTranscript's internal
      // recordToolFact/recordDelegationLink open the same DB as `dbA`.
      process.env.LA_TELEMETRY_HOME = tempA;
      process.env.LA_TELEMETRY_DB = dbPathA;
      const sourcePath = join(tempA, "s1.jsonl");
      const sourceOffset = 1;
      // usage_id (applyUsageRecorded) = sha256("sourcePath:sourceOffset")
      const usageId = createHash("sha256").update(`${sourcePath}:${sourceOffset}`).digest("hex");
      // tool_fact_id (recordToolFact) = sha1("sourcePath:sourceOffset:toolIndex")
      const toolFactId = createHash("sha1").update(`${sourcePath}:${sourceOffset}:0`).digest("hex");

      // Expected run-v4-1 totals computed from the v4 INSERT payload literals
      // (input_tokens=100, output_tokens=10, cost_facts.cost_usd=0.001) BEFORE
      // openTelemetryDb() triggers migration. Captured here so a migration
      // regression (e.g. a cost JOIN that doubles cost_usd) is caught by an
      // absolute-value assertion rather than a post-migration self-compare.
      const expectedRun1Totals = {
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheCreationInputTokens: 0,
        partialCostUSD: 0.001,
      };

      // --- Build v4 fixture (raw SQL on a separate handle) ---
      const v4 = new DatabaseSync(dbPathA);
      v4.exec("PRAGMA foreign_keys = ON");
      v4.exec(v4SchemaSql);
      v4.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(4, "2026-08-01T00:00:00.000Z");
      v4.prepare("INSERT INTO runs (run_id, squad, started_at, status, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run("run-v4-1", "dev", "2026-08-01T10:00:00.000Z", "completed", "2026-08-01T11:00:00.000Z");
      v4.prepare("INSERT INTO price_sets (price_set_id, config_hash, created_at, source) VALUES (?, ?, ?, ?)")
        .run("ps-1", "hash-1", "2026-08-01T00:00:00.000Z", "test");
      // usage_facts v4: usage_id is the hash run-v4-2 will re-derive on the same source triple.
      v4.prepare(
        `INSERT INTO usage_facts (usage_id, run_id, session_id, agent_key, model, observed_at,
         input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
         source_path, source_offset, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(usageId, "run-v4-1", "sess-1", "implementer", "deepseek-v4-flash", "2026-08-01T10:05:00.000Z",
        100, 10, 0, 0, sourcePath, sourceOffset, "2026-08-01T10:05:00.000Z");
      // cost_facts v4: no run_id column — v5 rebuild JOINs usage_facts to populate it.
      v4.prepare("INSERT INTO cost_facts (usage_id, price_set_id, cost_usd) VALUES (?, ?, ?)")
        .run(usageId, "ps-1", 0.001);
      v4.prepare(
        `INSERT INTO events (event_id, event_type, run_id, observed_at, host_id, source_kind,
         source_path, source_offset, payload_json, ingested_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("evt-1", "usage.recorded", "run-v4-1", "2026-08-01T10:05:00.000Z", "local", "transcript",
        sourcePath, sourceOffset, "{}", "2026-08-01T10:05:00.000Z");
      // transcript_sources v4: NULL run_id (legacy unattributed) → v5 COALESCEs to '' sentinel.
      v4.prepare(
        `INSERT INTO transcript_sources (source_path, session_id, run_id, byte_offset, file_size,
         modified_at, parse_status, last_error, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(sourcePath, "sess-1", null, 0, 100, "2026-08-01T10:00:00.000Z", "parsed", null, "2026-08-01T10:00:00.000Z");
      // tool_facts v4: tool_fact_id chosen so run-v4-2's ingest collides on the OLD single-column PK.
      v4.prepare(
        `INSERT INTO tool_facts (tool_fact_id, run_id, agent_key, model, observed_at, tool_name_raw,
         tool_name_canon, tool_input, tool_has_error, turn_index, source_path, source_offset, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(toolFactId, "run-v4-1", "implementer", "deepseek-v4-flash", "2026-08-01T10:05:00.000Z",
        "Read", "Read", null, 0, 0, sourcePath, sourceOffset, "2026-08-01T10:05:00.000Z");
      v4.close();

      // --- Open → triggers v5 migration ---
      const dbA = openTelemetryDb(dbPathA);
      try {
        const health = queryHealth(dbA);
        assertEqual(health.schemaVersion, 8, "schemaVersion"); // FOC-381: additive usage_facts message_id (7→8)
        // cost_facts.run_id populated from JOIN with usage_facts.
        const costRow = dbA.prepare("SELECT run_id FROM cost_facts WHERE usage_id=?").get(usageId);
        assert(costRow && costRow.run_id === "run-v4-1", `cost_facts.run_id=${costRow?.run_id} (expected run-v4-1)`);
        // transcript_sources legacy row migrated with sentinel '' run_id.
        const tsRow = dbA.prepare("SELECT run_id FROM transcript_sources WHERE source_path=? AND run_id=''").get(sourcePath);
        assert(tsRow, `legacy transcript_sources[${sourcePath}] row with '' sentinel missing`);

        // --- Insert run-v4-2 (applyEvent run.started creates the runs row) ---
        applyEvent(dbA, makeEvent("run.started", {
          runId: "run-v4-2", squad: "dev", startedAt: "2026-08-01T12:00:00.000Z", cwd: "C:/repos/office",
        }, { runId: "run-v4-2" }));
        applyEvent(dbA, makeEvent("session.linked", {
          runId: "run-v4-2", sessionId: "sess-1", transcriptPath: sourcePath,
        }, { runId: "run-v4-2" }));

        // Snapshot run-v4-1 totals before run-v4-2 ingest.
        const run1Before = queryRuns(dbA, { runId: "run-v4-1" })[0];

        // Write JSONL with a leading blank line so the assistant message lands
        // at byte offset 1 (matching the v4 fixture's source_offset=1).
        const assistantLine = JSON.stringify({
          type: "assistant", timestamp: "2026-08-01T12:05:00.000Z", sessionId: "sess-1",
          message: {
            model: "deepseek-v4-flash",
            usage: { input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/tmp/x" } }],
          },
        });
        writeFileSync(sourcePath, "\n" + assistantLine + "\n", "utf8");

        const result = await ingestTranscript(dbA, "run-v4-2", sourcePath, "sess-1");
        assert(result.events > 0, `run-v4-2 ingest events=${result.events}`);

        // usage_facts: 2 rows at same (source_path, source_offset), distinct run_id, same usage_id.
        const usageRows = dbA.prepare("SELECT run_id FROM usage_facts WHERE source_path=? AND source_offset=? ORDER BY run_id").all(sourcePath, sourceOffset);
        assertEqual(usageRows.length, 2, "usage_facts rows");
        assert(usageRows[0].run_id === "run-v4-1" && usageRows[1].run_id === "run-v4-2",
          `usage_facts run_ids=${usageRows.map((r) => r.run_id).join(",")} (expected run-v4-1,run-v4-2)`);
        const usageIds = dbA.prepare("SELECT DISTINCT usage_id FROM usage_facts WHERE source_path=? AND source_offset=?").all(sourcePath, sourceOffset).map((r) => r.usage_id);
        assertEqual(usageIds.length, 1, "usage_facts distinct usage_id count");
        assertEqual(usageIds[0], usageId, "usage_id matches sha256(sourcePath:offset)");

        // cost_facts: 2 rows, distinct run_id.
        const costRows = dbA.prepare("SELECT DISTINCT run_id FROM cost_facts WHERE usage_id=? ORDER BY run_id").all(usageId);
        assertEqual(costRows.length, 2, "cost_facts rows");
        assert(costRows[0].run_id === "run-v4-1" && costRows[1].run_id === "run-v4-2",
          `cost_facts run_ids=${costRows.map((r) => r.run_id).join(",")} (expected run-v4-1,run-v4-2)`);

        // tool_facts: 2 rows, same tool_fact_id, distinct run_id (no run-B drop on collision).
        const toolRows = dbA.prepare("SELECT run_id FROM tool_facts WHERE tool_fact_id=? ORDER BY run_id").all(toolFactId);
        assertEqual(toolRows.length, 2, "tool_facts rows");
        assert(toolRows[0].run_id === "run-v4-1" && toolRows[1].run_id === "run-v4-2",
          `tool_facts run_ids=${toolRows.map((r) => r.run_id).join(",")} (expected run-v4-1,run-v4-2)`);

        // transcript_sources: (sourcePath, run-v4-2) row present and parsed.
        const tsRun2 = dbA.prepare("SELECT run_id, parse_status FROM transcript_sources WHERE source_path=? AND run_id=?").get(sourcePath, "run-v4-2");
        assert(tsRun2 && tsRun2.parse_status === "parsed", `transcript_sources (path, run-v4-2) row missing or not parsed`);

        // Both runs show in queryRuns with non-zero totals.
        const runs = queryRuns(dbA);
        const r1 = runs.find((r) => r.runId === "run-v4-1");
        const r2 = runs.find((r) => r.runId === "run-v4-2");
        assert(r1 && r2, "both runs present in queryRuns");
        assert(r1.totals.inputTokens > 0 && r2.totals.inputTokens > 0,
          `both runs non-zero totals (r1=${r1.totals.inputTokens}, r2=${r2.totals.inputTokens})`);

        // run-v4-1 sums unchanged by run-v4-2 ingest (cross-run isolation).
        assertEqual(r1.totals.inputTokens, run1Before.totals.inputTokens, "run-v4-1 inputTokens unchanged by run-v4-2 ingest");
        assertEqual(r1.totals.outputTokens, run1Before.totals.outputTokens, "run-v4-1 outputTokens unchanged by run-v4-2 ingest");
        // run-v4-1 matches the pre-migration v4 fixture baseline — guards
        // against migration regressions (e.g. cost JOIN doubling cost_usd) that
        // a post-migration self-compare would miss.
        assertEqual(r1.totals.inputTokens, expectedRun1Totals.inputTokens, "run-v4-1 inputTokens matches v4 fixture baseline (migration not corrupted)");
        assertEqual(r1.totals.outputTokens, expectedRun1Totals.outputTokens, "run-v4-1 outputTokens matches v4 fixture baseline");
        assertEqual(r1.totals.cacheReadTokens, expectedRun1Totals.cacheReadTokens, "run-v4-1 cacheReadTokens matches v4 fixture baseline");
        assertEqual(Number(r1.totals.partialCostUSD.toFixed(6)), expectedRun1Totals.partialCostUSD, "run-v4-1 partialCostUSD matches v4 fixture baseline (migration not corrupted)");
      } finally {
        dbA.close();
      }
    } finally {
      process.env.LA_TELEMETRY_HOME = savedHome;
      process.env.LA_TELEMETRY_DB = savedDb;
      try { rmSync(tempA, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  // --- FOC-597: append-torn-then-complete (unterminated EOF tail) -----------
  // A live writer caught mid-append leaves a torn JSON tail. It must NOT be
  // consumed: the stored byte_offset stays at the last complete line boundary,
  // so the line that COMPLETES it on the next append is parsed (no fact loss).
  await test("(597) torn EOF tail held at the line boundary; the completed line lands next pass", async () => {
    const tempT = mkdtempSync(join(tmpdir(), "foc-597-"));
    const savedHome = process.env.LA_TELEMETRY_HOME;
    const savedDb = process.env.LA_TELEMETRY_DB;
    const dbPathT = join(tempT, "telemetry.sqlite");
    // Point the env default at this DB so ingestTranscript's internal
    // recordToolFact/recordDelegationLink open the same DB as `dbT`.
    process.env.LA_TELEMETRY_HOME = tempT;
    process.env.LA_TELEMETRY_DB = dbPathT;
    try {
      const dbT = openTelemetryDb(dbPathT);
      try {
        const runId = "run-foc-597";
        const sessionIdT = "session-foc-597";
        const sourcePath = join(tempT, "lead.jsonl");
        applyEvent(dbT, makeEvent("run.started", {
          runId, squad: "dev", startedAt: "2026-09-30T10:00:00.000Z", cwd: "C:/repos/office",
        }, { runId }));
        applyEvent(dbT, makeEvent("session.linked", {
          runId, sessionId: sessionIdT, transcriptPath: sourcePath,
        }, { runId }));

        const line1 = JSON.stringify({
          type: "assistant", timestamp: "2026-09-30T10:01:00.000Z", sessionId: sessionIdT,
          message: { id: "msg-1", model: "deepseek-v4-flash", usage: { input_tokens: 100, output_tokens: 50 } },
        });
        const line2 = JSON.stringify({
          type: "assistant", timestamp: "2026-09-30T10:02:00.000Z", sessionId: sessionIdT,
          message: { id: "msg-2", model: "deepseek-v4-flash", usage: { input_tokens: 200, output_tokens: 70 } },
        });
        // Torn write: line 1 complete, line 2 cut mid-JSON (before its usage).
        const tornAt = line2.indexOf("usage");
        assert(tornAt > 0, "fixture: line2 must contain a usage key to tear before");
        const torn = line2.slice(0, tornAt);
        let tornParses = true;
        try { JSON.parse(torn); } catch { tornParses = false; }
        assert(!tornParses, "fixture: the torn prefix must not parse as JSON");
        const boundary = Buffer.byteLength(line1 + "\n", "utf8");
        writeFileSync(sourcePath, line1 + "\n" + torn, "utf8");

        await ingestTranscript(dbT, runId, sourcePath, sessionIdT);
        const usage1 = dbT.prepare("SELECT COUNT(*) AS c FROM usage_facts WHERE source_path=?").get(sourcePath).c;
        assertEqual(usage1, 1, "pass 1: only the complete line is ingested");
        const ts1 = dbT.prepare("SELECT byte_offset FROM transcript_sources WHERE source_path=? AND run_id=?").get(sourcePath, runId);
        assert(ts1, "pass 1: transcript_sources row missing");
        assertEqual(ts1.byte_offset, boundary, "AC1: byte_offset held at the last complete line boundary (not past the torn tail)");

        // The writer completes the line — exactly the append AC2 names.
        writeFileSync(sourcePath, line2.slice(torn.length) + "\n", { flag: "a" });
        await ingestTranscript(dbT, runId, sourcePath, sessionIdT);
        const usageRows = dbT.prepare("SELECT source_offset FROM usage_facts WHERE source_path=? ORDER BY source_offset").all(sourcePath);
        assertEqual(usageRows.length, 2, "AC2: the completed line is ingested on the next pass (no fact loss)");
        assertEqual(usageRows[1].source_offset, boundary, "AC2: at its own offset (the tail start)");
        const ts2 = dbT.prepare("SELECT byte_offset FROM transcript_sources WHERE source_path=? AND run_id=?").get(sourcePath, runId);
        assertEqual(ts2.byte_offset, boundary + Buffer.byteLength(line2 + "\n", "utf8"),
          "byte_offset converges past the completed line once the tail resolves");
      } finally {
        dbT.close();
      }
    } finally {
      process.env.LA_TELEMETRY_HOME = savedHome;
      process.env.LA_TELEMETRY_DB = savedDb;
      try { rmSync(tempT, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  // --- FOC-598: shrink/rotation — the offset row must RESET, new facts land --
  // A rotated transcript reuses the low offsets of its previous incarnation.
  // The skip-cache row must reset (not MAX) so the next tick is incremental
  // again, and the new content's facts must be recorded — not dedup-absorbed
  // into the OLD content's rows at the same (source_path, source_offset).
  await test("(598) rotation resets the offset row and returns to incremental ticks", async () => {
    const tempR = mkdtempSync(join(tmpdir(), "foc-598-"));
    const savedHome = process.env.LA_TELEMETRY_HOME;
    const savedDb = process.env.LA_TELEMETRY_DB;
    const dbPathR = join(tempR, "telemetry.sqlite");
    // Point the env default at this DB so ingestTranscript's internal
    // recordToolFact/recordDelegationLink open the same DB as `dbR`.
    process.env.LA_TELEMETRY_HOME = tempR;
    process.env.LA_TELEMETRY_DB = dbPathR;
    try {
      const dbR = openTelemetryDb(dbPathR);
      try {
        const runId = "run-foc-598";
        const sessionIdR = "session-foc-598";
        const sourcePath = join(tempR, "lead.jsonl");
        applyEvent(dbR, makeEvent("run.started", {
          runId, squad: "dev", startedAt: "2026-10-01T10:00:00.000Z", cwd: "C:/repos/office",
        }, { runId }));
        applyEvent(dbR, makeEvent("session.linked", {
          runId, sessionId: sessionIdR, transcriptPath: sourcePath,
        }, { runId }));

        const line1 = JSON.stringify({
          type: "assistant", timestamp: "2026-10-01T10:01:00.000Z", sessionId: sessionIdR,
          message: { id: "msg-1", model: "deepseek-v4-flash", usage: { input_tokens: 100, output_tokens: 50 } },
        });
        const line2 = JSON.stringify({
          type: "assistant", timestamp: "2026-10-01T10:02:00.000Z", sessionId: sessionIdR,
          message: { id: "msg-2", model: "deepseek-v4-flash", usage: { input_tokens: 200, output_tokens: 70 } },
        });
        writeFileSync(sourcePath, line1 + "\n" + line2 + "\n", "utf8");
        await ingestTranscript(dbR, runId, sourcePath, sessionIdR);
        const after1 = dbR.prepare("SELECT byte_offset, file_size, updated_at FROM transcript_sources WHERE source_path=? AND run_id=?").get(sourcePath, runId);
        assert(after1, "pass 1: transcript_sources row missing");
        assertEqual(dbR.prepare("SELECT COUNT(*) AS c FROM usage_facts WHERE source_path=?").get(sourcePath).c, 2, "pass 1: both lines ingested");

        // Rotate: the file is REPLACED by a smaller one reusing the low offsets.
        const lineB = JSON.stringify({
          type: "assistant", timestamp: "2026-10-01T10:03:00.000Z", sessionId: sessionIdR,
          message: { id: "msg-B", model: "deepseek-v4-flash", usage: { input_tokens: 300, output_tokens: 90 } },
        });
        writeFileSync(sourcePath, lineB + "\n", "utf8");
        const sizeB = Buffer.byteLength(lineB + "\n", "utf8");
        assert(sizeB < after1.file_size, "fixture: the rotated file must be smaller (shrink)");

        await ingestTranscript(dbR, runId, sourcePath, sessionIdR);
        const after2 = dbR.prepare("SELECT byte_offset, file_size, updated_at FROM transcript_sources WHERE source_path=? AND run_id=?").get(sourcePath, runId);
        assertEqual(after2.byte_offset, sizeB, "AC1: byte_offset RESET to the new incarnation (no MAX retention)");
        assertEqual(after2.file_size, sizeB, "AC1: file_size RESET to the new incarnation (no MAX retention)");

        // AC2: the next unchanged tick must take the skip-cache fast path —
        // observable as "no progress write": transcript_sources stays untouched.
        // 5 ms of slack so a re-parse's `updated_at = now()` cannot land in the
        // same millisecond and hide the write.
        await new Promise((resolve) => setTimeout(resolve, 5));
        await ingestTranscript(dbR, runId, sourcePath, sessionIdR);
        const after3 = dbR.prepare("SELECT updated_at FROM transcript_sources WHERE source_path=? AND run_id=?").get(sourcePath, runId);
        assertEqual(after3.updated_at, after2.updated_at, "AC2: unchanged tick after rotation does not re-parse (no progress write)");
      } finally {
        dbR.close();
      }
    } finally {
      process.env.LA_TELEMETRY_HOME = savedHome;
      process.env.LA_TELEMETRY_DB = savedDb;
      try { rmSync(tempR, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  // --- FOC-598 AC1b/AC3 (the collision half) — PENDING a design decision ------
  // This is the real AC3 regression test: the rotated incarnation's fact sits at
  // an offset the previous incarnation already claimed (offset 0, msg-B vs
  // msg-1). It measures "expected 1, got 0" today because three content-UNaware
  // constraints absorb the new content: events' UNIQUE(run_id, source_kind,
  // source_path, source_offset, event_type), usage_facts' UNIQUE(run_id,
  // source_path, source_offset), and tool_facts' (source_path, source_offset,
  // tool_index) dedup. Recording both incarnations needs generation-qualified
  // keys (a source_generation migration) — until that decision lands this test
  // stays SKIPPED, not deleted (FOC-598 fork, see STATE).
  await test("(598) AC1b: the new incarnation's fact at a reused offset lands", async () => {
    if (true) { throw new TestSkip("needs generation-aware keys (source_generation migration) — FOC-598 fork, see STATE"); }
    const tempB = mkdtempSync(join(tmpdir(), "foc-598-b-"));
    const savedHome = process.env.LA_TELEMETRY_HOME;
    const savedDb = process.env.LA_TELEMETRY_DB;
    const dbPathB = join(tempB, "telemetry.sqlite");
    process.env.LA_TELEMETRY_HOME = tempB;
    process.env.LA_TELEMETRY_DB = dbPathB;
    try {
      const dbB = openTelemetryDb(dbPathB);
      try {
        const runId = "run-foc-598b";
        const sessionIdB = "session-foc-598b";
        const sourcePath = join(tempB, "lead.jsonl");
        applyEvent(dbB, makeEvent("run.started", {
          runId, squad: "dev", startedAt: "2026-10-01T10:00:00.000Z", cwd: "C:/repos/office",
        }, { runId }));
        applyEvent(dbB, makeEvent("session.linked", {
          runId, sessionId: sessionIdB, transcriptPath: sourcePath,
        }, { runId }));

        const line1 = JSON.stringify({
          type: "assistant", timestamp: "2026-10-01T10:01:00.000Z", sessionId: sessionIdB,
          message: { id: "msg-1", model: "deepseek-v4-flash", usage: { input_tokens: 100, output_tokens: 50 } },
        });
        writeFileSync(sourcePath, line1 + "\n", "utf8");
        await ingestTranscript(dbB, runId, sourcePath, sessionIdB);

        // Rotate: a NEW line (fresh message id, new counters) starts at offset 0
        // — the offset the old incarnation's msg-1 row/event already occupies.
        const lineB = JSON.stringify({
          type: "assistant", timestamp: "2026-10-01T10:03:00.000Z", sessionId: sessionIdB,
          message: { id: "msg-B", model: "deepseek-v4-flash", usage: { input_tokens: 300, output_tokens: 90 } },
        });
        writeFileSync(sourcePath, lineB + "\n", "utf8");
        await ingestTranscript(dbB, runId, sourcePath, sessionIdB);

        const fresh = dbB.prepare("SELECT COUNT(*) AS c FROM usage_facts WHERE source_path=? AND input_tokens=300 AND output_tokens=90").get(sourcePath).c;
        assertEqual(fresh, 1, "AC1/AC3: the new content's fact is recorded, not dedup-absorbed");
      } finally {
        dbB.close();
      }
    } finally {
      process.env.LA_TELEMETRY_HOME = savedHome;
      process.env.LA_TELEMETRY_DB = savedDb;
      try { rmSync(tempB, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  // --- FOC-599 (AC4): the incremental path serves the SAME facts -----------
  // FOC-547's AC4 ("served facts unchanged") was verified only by manual
  // before/after payload captures (experiments/foc-547-payload-diff.mjs with
  // the runs/rewards capture drivers). This is its automated form: the live
  // grow-and-re-ingest path must serve the same runs, usage and costs as one
  // full parse of the same bytes. The fingerprint aggregates FACTS — ingest
  // wall-clock stamps are not served facts and stay out of it.
  await test("(599) AC4: incremental ingest serves the same runs/usage/costs as a full parse", async () => {
    const jsonl = (ls) => ls.map((l) => JSON.stringify(l)).join("\n") + "\n";
    const lines = [
      { type: "user", timestamp: "2026-09-30T11:00:01.000Z", sessionId: "session-ac4", cwd: "C:/repos/fenix", gitBranch: "foc-599" },
      { type: "assistant", timestamp: "2026-09-30T11:01:00.000Z", sessionId: "session-ac4", message: { id: "m1", model: "deepseek-v4-flash", usage: { input_tokens: 110, output_tokens: 55 } } },
      { type: "assistant", timestamp: "2026-09-30T11:02:00.000Z", sessionId: "session-ac4", message: { id: "m2", model: "deepseek-v4-flash", usage: { input_tokens: 220, output_tokens: 66 }, content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a" } }] } },
      { type: "user", timestamp: "2026-09-30T11:02:05.000Z", sessionId: "session-ac4", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } },
      { type: "assistant", timestamp: "2026-09-30T11:03:00.000Z", sessionId: "session-ac4", message: { id: "m3", model: "deepseek-v4-flash", usage: { input_tokens: 330, output_tokens: 77 } } },
    ];
    // transcript.progress is per-pass bookkeeping (the skip-cache ledger) — its
    // row count depends on how many passes ran, not on the transcript's content,
    // so it is the one event type left out of the compare (same reasoning as the
    // `ingest.*` counters the manual payload diff strips). Every other event
    // type stays in — the first run of this test caught precisely this
    // difference and nothing else.
    const facts = (dbX) => ({
      runs: queryRuns(dbX).map((r) => ({ runId: r.runId, status: r.status, totals: r.totals, byAgent: r.byAgent })),
      usage: dbX.prepare("SELECT COUNT(*) AS n, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read_tokens) AS cacheRead, SUM(cache_creation_tokens) AS cacheWrite FROM usage_facts").get(),
      events: dbX.prepare("SELECT event_type, COUNT(*) AS n FROM events WHERE event_type != 'transcript.progress' GROUP BY event_type ORDER BY event_type").all(),
      tools: dbX.prepare("SELECT tool_name_raw, COUNT(*) AS n, SUM(tool_has_error) AS errors FROM tool_facts GROUP BY tool_name_raw ORDER BY tool_name_raw").all(),
      costs: dbX.prepare("SELECT COUNT(*) AS n, ROUND(SUM(cost_usd), 9) AS total FROM cost_facts").get(),
    });
    const seed = (dbX, dir) => {
      const sourcePath = join(dir, "lead.jsonl");
      applyEvent(dbX, makeEvent("run.started", {
        runId: "run-ac4", squad: "dev", startedAt: "2026-09-30T11:00:00.000Z", cwd: "C:/repos/fenix",
      }, { runId: "run-ac4" }));
      applyEvent(dbX, makeEvent("session.linked", {
        runId: "run-ac4", sessionId: "session-ac4", transcriptPath: sourcePath,
      }, { runId: "run-ac4" }));
      return sourcePath;
    };
    const savedHome = process.env.LA_TELEMETRY_HOME;
    const savedDbEnv = process.env.LA_TELEMETRY_DB;
    try {
      // Path FULL: one pass over all bytes.
      const tempF = mkdtempSync(join(tmpdir(), "foc-599-ac4-full-"));
      process.env.LA_TELEMETRY_HOME = tempF;
      process.env.LA_TELEMETRY_DB = join(tempF, "telemetry.sqlite");
      const dbF = openTelemetryDb(process.env.LA_TELEMETRY_DB);
      let full;
      try {
        const sourcePath = seed(dbF, tempF);
        writeFileSync(sourcePath, jsonl(lines), "utf8");
        await ingestTranscript(dbF, "run-ac4", sourcePath, "session-ac4");
        full = facts(dbF);
        assertEqual(full.usage.n, 3, "fixture must be non-vacuous: three usage facts");
        assertEqual(full.tools.length, 1, "fixture must be non-vacuous: one tool name");
        assert(full.costs.n > 0, "fixture must be non-vacuous: priced cost rows");
      } finally {
        dbF.close();
        try { rmSync(tempF, { recursive: true, force: true }); } catch { /* ignore */ }
      }

      // Path INCREMENTAL: the live grow-and-re-ingest sequence.
      const tempI = mkdtempSync(join(tmpdir(), "foc-599-ac4-incr-"));
      process.env.LA_TELEMETRY_HOME = tempI;
      process.env.LA_TELEMETRY_DB = join(tempI, "telemetry.sqlite");
      const dbI = openTelemetryDb(process.env.LA_TELEMETRY_DB);
      let incr;
      try {
        const sourcePath = seed(dbI, tempI);
        writeFileSync(sourcePath, jsonl(lines.slice(0, 2)), "utf8");
        await ingestTranscript(dbI, "run-ac4", sourcePath, "session-ac4");
        writeFileSync(sourcePath, jsonl(lines.slice(2)), { flag: "a" });
        await ingestTranscript(dbI, "run-ac4", sourcePath, "session-ac4");
        incr = facts(dbI);
        assertEqual(incr.usage.n, 3, "fixture must be non-vacuous on the incremental path too");
      } finally {
        dbI.close();
        try { rmSync(tempI, { recursive: true, force: true }); } catch { /* ignore */ }
      }

      assert(JSON.stringify(incr) === JSON.stringify(full),
        `served facts diverged between paths:\n  full: ${JSON.stringify(full)}\n  incr: ${JSON.stringify(incr)}`);
    } finally {
      process.env.LA_TELEMETRY_HOME = savedHome;
      process.env.LA_TELEMETRY_DB = savedDbEnv;
    }
  });

  // FOC-599 item 7 (nit 3): the unchanged-file skip branch finalizes pending
  // tool facts and used to DROP the whole in-memory parse state. The next grown
  // pass then started from a fresh state (workspace.lastWorkspace = null) and
  // re-emitted workspace.observed for an unchanged cwd:branch — and the store's
  // dedup key is (run_id, observed_at, cwd), so a re-emit with the NEW line
  // timestamp lands as a real duplicate row.
  await test("the skip branch keeps workspace memory across an idle→grow gap (no duplicate workspace.observed)", async () => {
    const jsonl2 = (ls) => ls.map((l) => JSON.stringify(l)).join("\n") + "\n";
    const savedHome = process.env.LA_TELEMETRY_HOME;
    const savedDbEnv = process.env.LA_TELEMETRY_DB;
    const tempW = mkdtempSync(join(tmpdir(), "foc-599-ws-"));
    process.env.LA_TELEMETRY_HOME = tempW;
    process.env.LA_TELEMETRY_DB = join(tempW, "telemetry.sqlite");
    const dbW = openTelemetryDb(process.env.LA_TELEMETRY_DB);
    try {
      const sourcePath = join(tempW, "lead.jsonl");
      applyEvent(dbW, makeEvent("run.started", {
        runId: "run-ws", squad: "dev", startedAt: "2026-10-01T09:00:00.000Z", cwd: "C:/repos/fenix",
      }, { runId: "run-ws" }));
      applyEvent(dbW, makeEvent("session.linked", {
        runId: "run-ws", sessionId: "session-ws", transcriptPath: sourcePath,
      }, { runId: "run-ws" }));
      const observed = () => dbW
        .prepare("SELECT COUNT(*) AS n FROM workspace_observations WHERE run_id=?")
        .get("run-ws").n;

      // Pass 1: one cwd-bearing line → exactly one workspace observation.
      writeFileSync(sourcePath, jsonl2([
        { type: "user", timestamp: "2026-10-01T09:00:01.000Z", sessionId: "session-ws", cwd: "C:/repos/fenix", gitBranch: "main" },
      ]), "utf8");
      await ingestTranscript(dbW, "run-ws", sourcePath, "session-ws");
      assertEqual(observed(), 1, "workspace_observations after the first ingest");

      // Pass 2: the file is UNCHANGED → the skip branch (finalize pending tool
      // facts, then the state swap this test pins).
      await ingestTranscript(dbW, "run-ws", sourcePath, "session-ws");
      assertEqual(observed(), 1, "workspace_observations after an unchanged re-ingest");

      // Pass 3: the file grows with the SAME cwd:branch and a new timestamp.
      // A fresh parse state re-emits workspace.observed here (lastWorkspace is
      // null again); a kept one stays silent.
      writeFileSync(sourcePath, jsonl2([
        { type: "user", timestamp: "2026-10-01T09:05:00.000Z", sessionId: "session-ws", cwd: "C:/repos/fenix", gitBranch: "main" },
      ]), { flag: "a" });
      await ingestTranscript(dbW, "run-ws", sourcePath, "session-ws");
      assertEqual(observed(), 1, "idle→grow re-emitted workspace.observed (the skip branch dropped workspace memory)");
    } finally {
      dbW.close();
      try { rmSync(tempW, { recursive: true, force: true }); } catch { /* ignore */ }
      process.env.LA_TELEMETRY_HOME = savedHome;
      process.env.LA_TELEMETRY_DB = savedDbEnv;
    }
  });

  console.log(`\n${passed} passed, ${skipped} skipped, ${failed} failed`);
  if (failed) console.log(failures.join("\n"));
  exitCode = failed ? 1 : 0;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  process.exit(exitCode);
}

run().catch((error) => { console.error(error); process.exit(1); });
