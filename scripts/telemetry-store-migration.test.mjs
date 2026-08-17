// Migration tests for schema v5 (JOI-260 / ADR-0008).
//
// Verifies that openTelemetryDb() migrates a legacy v4 database to v5:
//   (a) fresh v4 fixture → v5, composite PK, cost_facts.run_id populated, snapshot taken
//   (b) reopening the same DB does NOT overwrite the pre-v5 snapshot
//   (c) composite PK shape on usage_facts; DELETE FROM runs cascades to usage + cost
//   (d) a brand-new fresh DB records BOTH v4 and v5 markers in schema_migrations
//
// The v4 fixture is built with raw SQL on a separate DatabaseSync instance
// (only the tables needed to exercise the migration — createBaseSchema fills
// in the rest as empty IF NOT EXISTS tables when openTelemetryDb runs).

import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { openTelemetryDb, queryHealth, recordToolFact } from "./telemetry-store.mjs";

// tool_fact_id is sha1(source_path:source_offset:tool_index) per recordToolFact.
// Computed once so the v4 fixture row and the run-B ingest collide on the same id.
const TOOL_FACT_ID = createHash("sha1").update("C:/sessions/s1.jsonl:1:0").digest("hex");

let DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

// Thrown by a scenario that cannot run in this environment. The runner counts it
// separately from a pass, so "no SQLite" can never be mistaken for "migration
// verified". Mirrors the sentinel in telemetry-ingest.test.mjs.
class TestSkip extends Error {}

function assert(value, message) {
  if (!value) throw new Error(message || "assertion failed");
}

/** Every scenario here needs node:sqlite; call this first inside each one. */
function requireSqlite() {
  if (!DatabaseSync) throw new TestSkip("node:sqlite unavailable");
}

const testQueue = [];
function test(name, fn) {
  testQueue.push({ name, fn });
}

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

function buildV4Fixture(path) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(v4SchemaSql);
  db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(4, "2026-08-01T00:00:00.000Z");
  db.prepare("INSERT INTO runs (run_id, squad, started_at, status, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run("run-v4-1", "dev", "2026-08-01T10:00:00.000Z", "completed", "2026-08-01T11:00:00.000Z");
  db.prepare("INSERT INTO price_sets (price_set_id, config_hash, created_at, source) VALUES (?, ?, ?, ?)")
    .run("ps-1", "hash-1", "2026-08-01T00:00:00.000Z", "test");
  // usage_facts v4: usage_id globally unique, single PK
  db.prepare(
    `INSERT INTO usage_facts (usage_id, run_id, session_id, agent_key, model, observed_at,
     input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
     source_path, source_offset, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("usage-1", "run-v4-1", "sess-1", "implementer", "deepseek-v4-flash", "2026-08-01T10:05:00.000Z",
    100, 10, 0, 0, "C:/sessions/s1.jsonl", 1, "2026-08-01T10:05:00.000Z");
  // cost_facts v4: no run_id column
  db.prepare("INSERT INTO cost_facts (usage_id, price_set_id, cost_usd) VALUES (?, ?, ?)")
    .run("usage-1", "ps-1", 0.001);
  // events v4: one row
  db.prepare(
    `INSERT INTO events (event_id, event_type, run_id, observed_at, host_id, source_kind,
     source_path, source_offset, payload_json, ingested_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("evt-1", "usage.recorded", "run-v4-1", "2026-08-01T10:05:00.000Z", "local", "transcript",
    "C:/sessions/s1.jsonl", 1, "{}", "2026-08-01T10:05:00.000Z");
  // transcript_sources v4: one row with NULL run_id (legacy unattributed)
  db.prepare(
    `INSERT INTO transcript_sources (source_path, session_id, run_id, byte_offset, file_size,
     modified_at, parse_status, last_error, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("C:/sessions/s1.jsonl", "sess-1", null, 0, 100, "2026-08-01T10:00:00.000Z", "parsed", null, "2026-08-01T10:00:00.000Z");
  // tool_facts v4: one row for run-v4-1. tool_fact_id is sha1(source_path:source_offset:tool_index),
  // chosen so a second run on the same source location collides on the OLD single-column PK.
  db.prepare(
    `INSERT INTO tool_facts (tool_fact_id, run_id, agent_key, model, observed_at, tool_name_raw,
     tool_name_canon, tool_input, tool_has_error, turn_index, source_path, source_offset, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(TOOL_FACT_ID, "run-v4-1", "implementer", "deepseek-v4-flash", "2026-08-01T10:05:00.000Z",
    "Read", "Read", null, 0, 0, "C:/sessions/s1.jsonl", 1, "2026-08-01T10:05:00.000Z");
  db.close();
}

// No global bail-out here: exiting 0 up front made a SQLite-less runner report
// success for scenarios that never executed. Each scenario now declares the
// dependency itself and the runner reports it as SKIP.

// (a) fresh v4 fixture → v5
let scenarioAPass = false;
test("scenario (a): v4 DB migrated to v5 with composite PK and cost_facts.run_id populated", async () => {
  requireSqlite();
  const temp = mkdtempSync(join(tmpdir(), "joi-260-a-"));
  try {
    const dbPath = join(temp, "telemetry.sqlite");
    buildV4Fixture(dbPath);
    const backupPath = `${dbPath}.pre-v5-backup.sqlite`;
    assert(!existsSync(backupPath), "pre-v5 backup must not exist before first open");

    const db = openTelemetryDb(dbPath);
    try {
      const health = queryHealth(db);
      assert(health.schemaVersion === 5, `schemaVersion=${health.schemaVersion} (expected 5)`);

      // composite PK: usage_facts has two pk>0 columns
      const cols = db.prepare("PRAGMA table_info(usage_facts)").all();
      const pkCols = cols.filter((c) => c.pk > 0);
      assert(pkCols.length === 2, `usage_facts pk cols=${pkCols.length} (expected 2)`);
      const pkNames = pkCols.map((c) => c.name).sort();
      assert(pkNames.join(",") === "run_id,usage_id", `pk names=${pkNames.join(",")}`);

      // cost_facts.run_id populated from JOIN with usage_facts
      const costRow = db.prepare("SELECT run_id, usage_id, price_set_id, cost_usd FROM cost_facts WHERE usage_id=?").get("usage-1");
      assert(costRow != null, "cost_facts row missing after migration");
      assert(costRow.run_id === "run-v4-1", `cost_facts.run_id=${costRow.run_id} (expected run-v4-1)`);
      // The amount, not just the key. migrateRunScopedUsage rebuilds cost_facts
      // through a JOIN onto usage_facts; if that JOIN ever doubles, zeroes or
      // transforms the value, a run_id-only check still passes and the money
      // changes silently. 0.001 is what the v4 fixture inserts.
      assert(costRow.cost_usd === 0.001,
        `cost_facts.cost_usd=${costRow.cost_usd} (expected 0.001 — the v4 fixture value, unchanged by the rebuild)`);
      const costRows = db.prepare("SELECT COUNT(*) AS n FROM cost_facts").get().n;
      assert(costRows === 1, `cost_facts rows=${costRows} (expected 1 — a JOIN fan-out would multiply them)`);

      // events row survived
      const evtCount = db.prepare("SELECT COUNT(*) AS n FROM events").get().n;
      assert(evtCount === 1, `events count=${evtCount} (expected 1)`);

      // transcript_sources row migrated with sentinel '' run_id
      const tsRow = db.prepare("SELECT run_id FROM transcript_sources WHERE source_path=?").get("C:/sessions/s1.jsonl");
      assert(tsRow != null, "transcript_sources row missing after migration");
      assert(tsRow.run_id === "", `transcript_sources.run_id=${JSON.stringify(tsRow.run_id)} (expected '' sentinel)`);

      // v5 marker present
      const v5 = db.prepare("SELECT 1 FROM schema_migrations WHERE version=5").get();
      assert(v5 != null, "schema_migrations missing v5 marker");

      // backup snapshot taken before rebuild
      assert(existsSync(backupPath), "pre-v5-backup.sqlite not created");
      const backupDb = new DatabaseSync(backupPath);
      try {
        // backup is a v4 snapshot: usage_facts has single PK
        const bkpCols = backupDb.prepare("PRAGMA table_info(usage_facts)").all();
        const bkpPk = bkpCols.filter((c) => c.pk > 0);
        assert(bkpPk.length === 1, `backup usage_facts pk cols=${bkpPk.length} (expected 1 — pre-v5 snapshot)`);
        const bkpUsage = backupDb.prepare("SELECT COUNT(*) AS n FROM usage_facts").get().n;
        assert(bkpUsage === 1, `backup usage_facts rows=${bkpUsage} (expected 1)`);
        // backup tool_facts still has single-column PK (pre-v5 snapshot)
        const bkpTfCols = backupDb.prepare("PRAGMA table_info(tool_facts)").all();
        const bkpTfPk = bkpTfCols.filter((c) => c.pk > 0);
        assert(bkpTfPk.length === 1, `backup tool_facts pk cols=${bkpTfPk.length} (expected 1 — pre-v5 snapshot)`);
        assert(bkpTfPk[0].name === "tool_fact_id", `backup tool_facts pk name=${bkpTfPk[0].name}`);
      } finally { backupDb.close(); }

      // tool_facts composite PK: (run_id, tool_fact_id)
      const tfCols = db.prepare("PRAGMA table_info(tool_facts)").all();
      const tfPk = tfCols.filter((c) => c.pk > 0);
      assert(tfPk.length === 2, `tool_facts pk cols=${tfPk.length} (expected 2)`);
      const tfPkNames = tfPk.map((c) => c.name).sort();
      assert(tfPkNames.join(",") === "run_id,tool_fact_id", `tool_facts pk names=${tfPkNames.join(",")}`);
      // idx_tool_facts_run and idx_tool_facts_canon recreated after rename
      const tfIdx = db.prepare("PRAGMA index_list(tool_facts)").all().map((r) => r.name);
      assert(tfIdx.includes("idx_tool_facts_run"), `idx_tool_facts_run missing (have ${tfIdx.join(",")})`);
      assert(tfIdx.includes("idx_tool_facts_canon"), `idx_tool_facts_canon missing (have ${tfIdx.join(",")})`);

      // pre-existing v4 tool_facts row preserved losslessly (AC3)
      const preRows = db.prepare("SELECT tool_fact_id, run_id FROM tool_facts WHERE tool_fact_id=?").all(TOOL_FACT_ID);
      assert(preRows.length === 1, `pre-ingest tool_facts rows=${preRows.length} (expected 1 — v4 row preserved)`);
      assert(preRows[0].run_id === "run-v4-1", `pre-ingest run_id=${preRows[0].run_id} (expected run-v4-1)`);

      // ingest run B on the same source location → same tool_fact_id, different run_id (AC1/AC4)
      db.prepare("INSERT INTO runs (run_id, squad, started_at, status, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run("run-v4-2", "dev", "2026-08-01T12:00:00.000Z", "completed", "2026-08-01T13:00:00.000Z");
      const ingest = await recordToolFact({
        run_id: "run-v4-2", agent_key: "implementer", model: "deepseek-v4-flash",
        observed_at: "2026-08-01T12:05:00.000Z", tool_name_raw: "Read", tool_name_canon: "Read",
        tool_input: null, tool_has_error: false, turn_index: 0,
        source_path: "C:/sessions/s1.jsonl", source_offset: 1, tool_index: 0,
      }, { dbPath });
      assert(ingest.recorded === true, `run-B ingest recorded=${ingest.recorded} (expected true — composite PK scopes by run_id)`);
      assert(ingest.id === TOOL_FACT_ID, `run-B tool_fact_id=${ingest.id} (expected collision with v4 row)`);
      // 2 rows, same tool_fact_id, distinct run_id; no run-B row dropped as duplicate (AC4)
      const rows = db.prepare("SELECT run_id FROM tool_facts WHERE tool_fact_id=? ORDER BY run_id").all(TOOL_FACT_ID);
      assert(rows.length === 2, `tool_facts rows for colliding id=${rows.length} (expected 2)`);
      assert(rows[0].run_id === "run-v4-1" && rows[1].run_id === "run-v4-2",
        `run_ids=${rows.map((r) => r.run_id).join(",")} (expected run-v4-1,run-v4-2 — no run-B drop)`);
    } finally { db.close(); }
    scenarioAPass = true;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

// (b) reopening the same DB does NOT overwrite the snapshot
test("scenario (b): reopening same DB preserves existing pre-v5-backup snapshot", () => {
  requireSqlite();
  assert(scenarioAPass, "scenario (a) must pass first (dependency)");
  const temp = mkdtempSync(join(tmpdir(), "joi-260-b-"));
  try {
    const dbPath = join(temp, "telemetry.sqlite");
    buildV4Fixture(dbPath);
    const backupPath = `${dbPath}.pre-v5-backup.sqlite`;

    const db1 = openTelemetryDb(dbPath);
    db1.close();
    assert(existsSync(backupPath), "first open should create backup");
    // write a sentinel into the backup file so we can detect overwrite
    const sentinel = "joi-260-sentinel-" + Date.now();
    writeFileSync(backupPath, sentinel, "utf8");
    const sizeBefore = statSync(backupPath).size;

    // re-open: should NOT overwrite (file exists → skip VACUUM INTO)
    const db2 = openTelemetryDb(dbPath);
    db2.close();
    const sizeAfter = statSync(backupPath).size;
    assert(sizeAfter === sizeBefore, `backup size changed ${sizeBefore}→${sizeAfter} (reopening must not overwrite)`);
    // ensure the DB is still usable at v5 after second open
    const db3 = openTelemetryDb(dbPath);
    try {
      const h = queryHealth(db3);
      assert(h.schemaVersion === 5, `schemaVersion after reopen=${h.schemaVersion}`);
    } finally { db3.close(); }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

// (c) composite PK shape + DELETE FROM runs cascades to usage + cost
test("scenario (c): composite PK on usage_facts; DELETE FROM runs cascades to usage+cost", () => {
  requireSqlite();
  const temp = mkdtempSync(join(tmpdir(), "joi-260-c-"));
  try {
    const dbPath = join(temp, "telemetry.sqlite");
    buildV4Fixture(dbPath);

    // pre-migration: tool_facts has single-column PK on tool_fact_id alone
    const preDb = new DatabaseSync(dbPath);
    try {
      const preTfCols = preDb.prepare("PRAGMA table_info(tool_facts)").all();
      const preTfPk = preTfCols.filter((c) => c.pk > 0);
      assert(preTfPk.length === 1, `pre-migration tool_facts pk cols=${preTfPk.length} (expected 1 — v4 single-column PK)`);
      assert(preTfPk[0].name === "tool_fact_id", `pre-migration tool_facts pk name=${preTfPk[0].name}`);
      assert(preDb.prepare("SELECT COUNT(*) AS n FROM tool_facts").get().n === 1, "pre-migration tool_facts should hold the v4 fixture row");
    } finally { preDb.close(); }

    const db = openTelemetryDb(dbPath);
    try {
      // composite PK shape
      const cols = db.prepare("PRAGMA table_info(usage_facts)").all();
      const pkCols = cols.filter((c) => c.pk > 0);
      assert(pkCols.length === 2, `usage_facts pk cols=${pkCols.length} (expected 2)`);

      // cost_facts PK is (run_id, usage_id, price_set_id)
      const costCols = db.prepare("PRAGMA table_info(cost_facts)").all();
      const costPk = costCols.filter((c) => c.pk > 0);
      assert(costPk.length === 3, `cost_facts pk cols=${costPk.length} (expected 3)`);

      // pre-condition: one usage + one cost row for run-v4-1
      assert(db.prepare("SELECT COUNT(*) AS n FROM usage_facts WHERE run_id=?").get("run-v4-1").n === 1, "usage_facts pre-condition");
      assert(db.prepare("SELECT COUNT(*) AS n FROM cost_facts WHERE run_id=?").get("run-v4-1").n === 1, "cost_facts pre-condition");

      // post-migration tool_facts: composite PK on (run_id, tool_fact_id), pre-existing row preserved (AC3/AC4)
      const tfCols = db.prepare("PRAGMA table_info(tool_facts)").all();
      const tfPk = tfCols.filter((c) => c.pk > 0);
      assert(tfPk.length === 2, `post-migration tool_facts pk cols=${tfPk.length} (expected 2)`);
      const tfPkNames = tfPk.map((c) => c.name).sort();
      assert(tfPkNames.join(",") === "run_id,tool_fact_id", `post-migration tool_facts pk names=${tfPkNames.join(",")}`);
      const tfRow = db.prepare("SELECT tool_fact_id, run_id FROM tool_facts WHERE tool_fact_id=?").get(TOOL_FACT_ID);
      assert(tfRow != null, "tool_facts pre-existing row lost during migration (AC3)");
      assert(tfRow.run_id === "run-v4-1", `tool_facts pre-existing run_id=${tfRow.run_id} (expected run-v4-1)`);

      // DELETE the run → cascade to usage_facts (ON DELETE CASCADE) → cascade to cost_facts (FK ON DELETE CASCADE)
      // and to tool_facts (ON DELETE CASCADE on the new FK)
      db.prepare("DELETE FROM runs WHERE run_id=?").run("run-v4-1");
      const usageAfter = db.prepare("SELECT COUNT(*) AS n FROM usage_facts WHERE run_id=?").get("run-v4-1").n;
      const costAfter = db.prepare("SELECT COUNT(*) AS n FROM cost_facts WHERE run_id=?").get("run-v4-1").n;
      const tfAfter = db.prepare("SELECT COUNT(*) AS n FROM tool_facts WHERE run_id=?").get("run-v4-1").n;
      assert(usageAfter === 0, `usage_facts after run delete=${usageAfter} (expected 0 — cascade)`);
      assert(costAfter === 0, `cost_facts after run delete=${costAfter} (expected 0 — cascade)`);
      assert(tfAfter === 0, `tool_facts after run delete=${tfAfter} (expected 0 — cascade)`);
    } finally { db.close(); }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

// (d) a brand-new fresh DB records BOTH v4 and v5 markers in schema_migrations
test("scenario (d): fresh DB has both v4 and v5 markers in schema_migrations", () => {
  requireSqlite();
  const temp = mkdtempSync(join(tmpdir(), "joi-260-d-"));
  try {
    const dbPath = join(temp, "fresh.sqlite");
    const db = openTelemetryDb(dbPath);
    try {
      const versions = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((r) => r.version);
      assert(versions.includes(4), `schema_migrations missing v4 (have ${versions.join(",")})`);
      assert(versions.includes(5), `schema_migrations missing v5 (have ${versions.join(",")})`);
      const h = queryHealth(db);
      assert(h.schemaVersion === 5, `fresh DB schemaVersion=${h.schemaVersion}`);
    } finally { db.close(); }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

// :memory: skips the VACUUM INTO snapshot
test(":memory: DB skips pre-v5 backup snapshot", () => {
  requireSqlite();
  const db = openTelemetryDb(":memory:");
  try {
    const h = queryHealth(db);
    assert(h.schemaVersion === 5, `:memory: schemaVersion=${h.schemaVersion}`);
    const versions = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((r) => r.version);
    assert(versions.includes(4) && versions.includes(5), `:memory: missing markers (have ${versions.join(",")})`);
  } finally { db.close(); }
});

for (const { name, fn } of testQueue) {
  try {
    await fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (error) {
    if (error instanceof TestSkip) {
      skipped++;
      console.log(`  SKIP ${name}: ${error.message}`);
      continue;
    }
    failed++;
    failures.push(`${name}: ${error.message}`);
    console.log(`  FAIL ${name}: ${error.message}`);
  }
}
console.log(`\n${passed} passed, ${skipped} skipped, ${failed} failed`);
if (failed) console.log(failures.join("\n"));
// Skips are not failures: a build without node:sqlite exits 0, a real assertion
// failure exits 1.
process.exit(failed ? 1 : 0);
