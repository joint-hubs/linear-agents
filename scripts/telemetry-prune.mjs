#!/usr/bin/env node
// scripts/telemetry-prune.mjs — one-off compaction of a store damaged before
// the 2026-08-17 fixes. Authorised by Mateusz for the production store.
//
// Two kinds of junk accumulated:
//
// 1. quality.reported duplicates. Until the dedup fix, reportDataQuality()
//    emitted a fresh events row on every 15s ingest tick for every run whose
//    transcript was gone — no source path/offset, so the all-NULL UNIQUE key
//    never matched. Measured before this ran: 5 791 702 rows, 98.9% of the
//    events table, ~195k/hour, all collapsing into 276 projection rows.
//
// 2. Test-fixture runs. Older versions of the test suite wrote into the real
//    store instead of a temp one (the current suite no longer does — verified
//    2026-08-17). 50 rows with ids like test-cpid-*, test-hang, test-run-fk-2.
//    They carry zero usage and zero cost, so they never skewed a number; they
//    only inflated the run list (290 rows for 240 real runs).
//
// What survives: every non-quality event, plus the EARLIEST quality.reported
// per (run_id, issue type) — the "first seen" timestamp, the only thing the
// duplicates could tell you. Projections are not touched: data_quality_issues,
// runs, usage_facts, cost_facts, tool_facts and delegation_links are the live
// state and stay as they are, minus what cascades from the deleted test runs.
//
// Rebuild rather than DELETE for the events table: dropping 5.79M rows in place
// writes a multi-GB journal and still needs a VACUUM afterwards. Copying the
// ~65k survivors into a new table is seconds.
//
// Usage:
//   node scripts/telemetry-prune.mjs           report only, no writes
//   node scripts/telemetry-prune.mjs --apply   back up, prune, vacuum
//
// STOP telemetry-server first — node:sqlite is synchronous and the server holds
// the database across long ticks.

import { DatabaseSync } from "node:sqlite";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Resolved locally rather than imported: this script must stay runnable against
// a store whose schema the current code might not open cleanly.
function telemetryDbPath() {
  if (process.env.LA_TELEMETRY_DB) return process.env.LA_TELEMETRY_DB;
  const local = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  return join(local, "linear-agents", "telemetry", "telemetry.sqlite");
}

// Real run ids are timestamp-prefixed (2026-08-17T07-40-01-139-orch-ollama-f739),
// so a leading "test-" cannot collide with a genuine run — including runs of the
// TEST squad, which are timestamp-prefixed like every other squad.
const TEST_RUN_PREFIX = "test-";

const EVENTS_DDL = `
  CREATE TABLE events_pruned (
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
    UNIQUE (run_id, source_kind, source_path, source_offset, event_type)
  )`;

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const sizeOf = (p) => (existsSync(p) ? statSync(p).size : 0);
const n = (v) => Number(v).toLocaleString("en-US");

function survey(db) {
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  return {
    events: one("SELECT COUNT(*) n FROM events").n,
    quality: one("SELECT COUNT(*) n FROM events WHERE event_type='quality.reported'").n,
    qualityKeep: one(
      `SELECT COUNT(*) n FROM (SELECT MIN(rowid) FROM events WHERE event_type='quality.reported'
        GROUP BY run_id, json_extract(payload_json,'$.issueType'))`,
    ).n,
    testRuns: one("SELECT COUNT(*) n FROM runs WHERE run_id LIKE ?", `${TEST_RUN_PREFIX}%`).n,
    realRuns: one("SELECT COUNT(*) n FROM runs WHERE run_id NOT LIKE ?", `${TEST_RUN_PREFIX}%`).n,
    testUsage: one("SELECT COUNT(*) n FROM usage_facts WHERE run_id LIKE ?", `${TEST_RUN_PREFIX}%`).n,
    testCost: one("SELECT COALESCE(SUM(cost_usd),0) c FROM cost_facts WHERE run_id LIKE ?", `${TEST_RUN_PREFIX}%`).c,
  };
}

function main() {
  const apply = process.argv.includes("--apply");
  const path = telemetryDbPath();
  if (!existsSync(path)) {
    console.error(`[prune] database not found: ${path}`);
    process.exit(1);
  }
  console.log(`[prune] database: ${path}`);
  console.log(`[prune] size:     ${mb(sizeOf(path))} + ${mb(sizeOf(`${path}-wal`))} wal`);

  let db = new DatabaseSync(path, { readOnly: !apply });
  db.exec("PRAGMA busy_timeout = 30000");
  const before = survey(db);

  console.log(`[prune] events:          ${n(before.events)}  (quality.reported ${n(before.quality)})`);
  console.log(`[prune]   quality to keep ${n(before.qualityKeep)} — earliest per run x issue type`);
  console.log(`[prune] runs:            ${n(before.realRuns)} real + ${n(before.testRuns)} test fixtures`);
  console.log(`[prune]   test fixtures carry ${n(before.testUsage)} usage rows, $${Number(before.testCost).toFixed(4)} cost`);

  if (before.testUsage > 0 || Number(before.testCost) > 0) {
    console.error("[prune] REFUSING: test-prefixed runs carry real usage or cost — inspect before deleting.");
    db.close();
    process.exit(1);
  }

  if (!apply) {
    db.close();
    console.log("\n[prune] dry run — nothing written. Re-run with --apply.");
    return;
  }
  db.close();

  // Timestamped so a second run never destroys the first run's rollback point,
  // and so the script stays usable after the initial cleanup (test fixtures can
  // leak in again — they did, hours after the first pass).
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backupPath = `${path}.pre-prune-${stamp}.sqlite`;
  if (existsSync(backupPath)) {
    console.error(`[prune] backup already exists, refusing to overwrite: ${backupPath}`);
    process.exit(1);
  }
  // VACUUM INTO, not a file copy: it folds the WAL in and yields one
  // self-consistent file that does not depend on -wal/-shm siblings surviving.
  let t = Date.now();
  db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 30000");
  db.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
  db.close();
  console.log(`[prune] backup:  ${backupPath} (${mb(sizeOf(backupPath))}, ${((Date.now() - t) / 1000).toFixed(1)}s)`);

  db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 30000");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");

  // Step 1 — rebuild events. No table has a foreign key into events (the
  // projections all key on run_id), so it can be swapped without touching
  // foreign_keys.
  t = Date.now();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(EVENTS_DDL);
    db.exec(`
      INSERT INTO events_pruned
      SELECT * FROM events
       WHERE event_type <> 'quality.reported'
         AND (run_id IS NULL OR run_id NOT LIKE '${TEST_RUN_PREFIX}%');
      INSERT INTO events_pruned
      SELECT * FROM events
       WHERE rowid IN (
         SELECT MIN(rowid) FROM events WHERE event_type='quality.reported'
          GROUP BY run_id, json_extract(payload_json,'$.issueType')
       )
         AND (run_id IS NULL OR run_id NOT LIKE '${TEST_RUN_PREFIX}%');
      DROP TABLE events;
      ALTER TABLE events_pruned RENAME TO events;
    `);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    try { db.exec("DROP TABLE IF EXISTS events_pruned"); } catch {}
    db.close();
    console.error(`[prune] events rebuild FAILED, rolled back: ${error.message}`);
    process.exit(1);
  }
  console.log(`[prune] events rebuilt in ${((Date.now() - t) / 1000).toFixed(1)}s`);

  // Step 2 — drop the test-fixture runs. foreign_keys ON so the ON DELETE
  // CASCADE declarations clean the dependent projection rows for us.
  t = Date.now();
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("BEGIN IMMEDIATE");
  try {
    const removed = db.prepare("DELETE FROM runs WHERE run_id LIKE ?").run(`${TEST_RUN_PREFIX}%`);
    db.exec("COMMIT");
    console.log(`[prune] deleted ${n(removed.changes)} test-fixture runs in ${((Date.now() - t) / 1000).toFixed(1)}s`);
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    db.close();
    console.error(`[prune] run deletion FAILED, rolled back: ${error.message}`);
    process.exit(1);
  }

  // Guard before the irreversible space reclaim: the counts that must not move.
  const after = survey(db);
  const expectedEvents = before.events - before.quality + before.qualityKeep;
  if (after.realRuns !== before.realRuns) {
    console.error(`[prune] REFUSING TO VACUUM: real runs changed ${before.realRuns} -> ${after.realRuns}`);
    db.close();
    process.exit(1);
  }
  if (after.events > expectedEvents) {
    console.error(`[prune] REFUSING TO VACUUM: events ${after.events} exceeds expected <= ${expectedEvents}`);
    db.close();
    process.exit(1);
  }

  t = Date.now();
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.exec("VACUUM");
  const fk = db.prepare("PRAGMA foreign_key_check").all();
  const integrity = db.prepare("PRAGMA integrity_check").get();
  db.close();

  console.log(`[prune] vacuum in ${((Date.now() - t) / 1000).toFixed(1)}s`);
  console.log(`[prune] events now:      ${n(after.events)}  (quality.reported ${n(after.quality)})`);
  console.log(`[prune] runs now:        ${n(after.realRuns)} real + ${n(after.testRuns)} test`);
  console.log(`[prune] integrity_check: ${Object.values(integrity)[0]}`);
  console.log(`[prune] foreign_key_check: ${fk.length === 0 ? "clean" : JSON.stringify(fk)}`);
  console.log(`[prune] size now: ${mb(sizeOf(path))} + ${mb(sizeOf(`${path}-wal`))} wal`);
}

main();
