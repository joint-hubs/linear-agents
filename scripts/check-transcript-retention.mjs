#!/usr/bin/env node
// check-transcript-retention.mjs — report what percentage of recent usage_facts
// rows still have a live source transcript on disk.
//
// Usage:
//   node scripts/check-transcript-retention.mjs [--days N] [--json] [--by-run] [--test] [--help]
//
// Exit codes: 0=OK, 1=WARNING, 2=CRITICAL, 3=DB_ERROR

import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));

// ── Help ────────────────────────────────────────────────────────────────────

function usage() {
  const text = `
check-transcript-retention.mjs — check transcript file retention for usage_facts

USAGE:
  node scripts/check-transcript-retention.mjs [OPTIONS]

OPTIONS:
  --days N     Window in days (default: 30)
  --json       Output JSON to stdout (one object, no extra formatting)
  --by-run     Include per-run breakdown in human output
  --test       Run self-test against a temp SQLite DB, then exit
  --help       Print this message and exit

EXIT CODES:
  0  OK        coverage_pct >= 90%
  1  WARNING   coverage_pct >= 70% but < 90%
  2  CRITICAL  coverage_pct < 70%
  3  DB_ERROR  database not found or cannot be opened

DB PATH:
  %LOCALAPPDATA%/linear-agents/telemetry/telemetry.sqlite
  Override via LA_TELEMETRY_DB env var.
`.trim();
  console.log(text);
}

// ── DB path ─────────────────────────────────────────────────────────────────

function telemetryDbPath() {
  if (process.env.LA_TELEMETRY_DB) return process.env.LA_TELEMETRY_DB;
  const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  return join(localAppData, "linear-agents", "telemetry", "telemetry.sqlite");
}

// ── SQLite helpers ───────────────────────────────────────────────────────────

let DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}

function openDb(path) {
  if (!DatabaseSync) {
    throw new Error(`node:sqlite is required (current: ${process.version})`);
  }
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000;");
  return db;
}

// ── Core logic ──────────────────────────────────────────────────────────────

/**
 * Run the retention check against an open database.
 *
 * @param {object} db        — open DatabaseSync instance
 * @param {number} days      — window in days
 * @param {boolean} byRun    — whether to include per-run breakdown
 * @returns {object}         — result object matching §12 schema
 */
function checkRetention(db, days, includeByRun) {
  // Query usage_facts joined with runs for squad
  const rows = db.prepare(`
    SELECT u.run_id, u.agent_key, u.source_path, u.observed_at,
           COALESCE(r.squad, 'unknown') AS squad
    FROM usage_facts u
    LEFT JOIN runs r ON r.run_id = u.run_id
    WHERE u.observed_at >= datetime('now', '-' || ? || ' days')
       OR (u.observed_at IS NULL AND u.created_at >= datetime('now', '-' || ? || ' days'))
  `).all(days, days);

  const total = rows.length;
  let live = 0;
  let missing = 0;

  // Per-run aggregation
  const runMap = new Map(); // run_id -> { squad, agentKeys: Set, total, live, transcriptPaths: Set }

  for (const row of rows) {
    const pathExists = existsSync(row.source_path);
    if (pathExists) live++;
    else missing++;

    // Aggregate per run
    let entry = runMap.get(row.run_id);
    if (!entry) {
      entry = { squad: row.squad, agentKeys: new Set(), total: 0, live: 0, transcriptPaths: new Set() };
      runMap.set(row.run_id, entry);
    }
    entry.agentKeys.add(row.agent_key);
    entry.total++;
    if (pathExists) entry.live++;
    entry.transcriptPaths.add(row.source_path);
  }

  const coveragePct = total > 0 ? Math.round((live / total) * 1000) / 10 : 100;

  let alarm;
  if (coveragePct >= 90) alarm = "OK";
  else if (coveragePct >= 70) alarm = "WARNING";
  else alarm = "CRITICAL";

  // Build by_run array
  const byRun = [];
  for (const [runId, entry] of runMap) {
    const transcriptExists = entry.live > 0;
    // Use the first transcript path as representative
    const transcriptPath = entry.transcriptPaths.values().next().value || null;
    byRun.push({
      run_id: runId,
      squad: entry.squad,
      agent_key: [...entry.agentKeys].join(","),
      usage_fact_count: entry.total,
      transcript_exists: transcriptExists,
      transcript_path: transcriptPath,
    });
  }
  byRun.sort((a, b) => b.usage_fact_count - a.usage_fact_count);

  // Build by_squad aggregation
  const squadMap = new Map();
  for (const [runId, entry] of runMap) {
    let sq = squadMap.get(entry.squad);
    if (!sq) {
      sq = { squad: entry.squad, total: 0, live: 0 };
      squadMap.set(entry.squad, sq);
    }
    sq.total += entry.total;
    sq.live += entry.live;
  }
  const bySquad = [];
  for (const [squad, sq] of squadMap) {
    const pct = sq.total > 0 ? Math.round((sq.live / sq.total) * 1000) / 10 : 100;
    let status;
    if (pct >= 90) status = "OK";
    else if (pct >= 70) status = "WARNING";
    else status = "CRITICAL";
    bySquad.push({ squad, coverage_pct: pct, live: sq.live, total: sq.total, alarm: status });
  }
  bySquad.sort((a, b) => b.total - a.total);

  const result = {
    checked_at: new Date().toISOString(),
    window_days: days,
    total_usage_facts: total,
    live_transcripts: live,
    missing_transcripts: missing,
    coverage_pct: coveragePct,
    alarm,
    by_run: byRun,
    by_squad: bySquad,
  };

  return result;
}

// ── Output formatting ───────────────────────────────────────────────────────

function printHuman(result, showByRun) {
  const bar = "─".repeat(45);
  console.log(`Transcript retention check (last ${result.window_days} days)`);
  console.log(bar);
  console.log(`Usage facts:      ${result.total_usage_facts.toLocaleString()}`);
  console.log(`Live transcripts: ${result.live_transcripts.toLocaleString()} (${result.coverage_pct}%)`);
  console.log(`Missing:          ${result.missing_transcripts.toLocaleString()}`);

  const statusSymbol =
    result.alarm === "OK" ? "✓" :
    result.alarm === "WARNING" ? "⚠" : "✗";
  console.log(`Status:           ${result.alarm} ${statusSymbol}`);
  console.log("");

  if (result.by_squad && result.by_squad.length > 0) {
    console.log("Coverage by squad:");
    const maxSquadLen = Math.max(...result.by_squad.map((s) => s.squad.length), 5);
    for (const sq of result.by_squad) {
      const padded = sq.squad.padEnd(maxSquadLen + 1);
      const sym = sq.alarm === "OK" ? "✓" : sq.alarm === "WARNING" ? "⚠" : "✗";
      console.log(`  ${padded} ${sq.coverage_pct}% (${sq.alarm} ${sym})`);
    }
    console.log("");
  }

  if (showByRun && result.by_run && result.by_run.length > 0) {
    console.log("Per-run breakdown:");
    // Show top 20 runs
    const display = result.by_run.slice(0, 20);
    for (const run of display) {
      const sym = run.transcript_exists ? "✓" : "✗";
      console.log(`  ${sym} ${run.run_id}  ${run.squad.padEnd(10)} ${String(run.usage_fact_count).padStart(5)} facts  ${run.transcript_path || "(no path)"}`);
    }
    if (result.by_run.length > 20) {
      console.log(`  ... and ${result.by_run.length - 20} more runs`);
    }
    console.log("");
  }
}

// ── Self-test ───────────────────────────────────────────────────────────────

function runSelfTest() {
  if (!DatabaseSync) {
    console.error("node:sqlite is required for self-test");
    process.exit(1);
  }

  const tmpDir = tmpdir();
  const dbPath = join(tmpDir, `retention-test-${process.pid}.sqlite`);
  const existingFile = join(tmpDir, `retention-test-existing-${process.pid}.jsonl`);
  const existingFile2 = join(tmpDir, `retention-test-existing2-${process.pid}.jsonl`);
  const missingFile = join(tmpDir, `retention-test-missing-${process.pid}.jsonl`);

  try {
    // Create the two "existing" files
    writeFileSync(existingFile, '{"test": true}\n', "utf8");
    writeFileSync(existingFile2, '{"test": true}\n', "utf8");

    // Create temp DB with the same schema subset
    const db = openDb(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        squad TEXT
      );
      CREATE TABLE IF NOT EXISTS usage_facts (
        usage_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        agent_key TEXT NOT NULL,
        source_path TEXT NOT NULL,
        source_offset INTEGER NOT NULL,
        observed_at TEXT,
        created_at TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens INTEGER NOT NULL DEFAULT 0
      );
    `);

    const now = new Date().toISOString();
    db.prepare("INSERT INTO runs (run_id, squad) VALUES (?, ?)").run("test-run-1", "dev");
    db.prepare("INSERT INTO runs (run_id, squad) VALUES (?, ?)").run("test-run-2", "review");

    // Row 1: existing file
    db.prepare(
      `INSERT INTO usage_facts (usage_id, run_id, agent_key, source_path, source_offset, observed_at, created_at, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("test-uf-1", "test-run-1", "lead", existingFile, 0, now, now, 100, 50, 0, 0);

    // Row 2: existing file (different run)
    db.prepare(
      `INSERT INTO usage_facts (usage_id, run_id, agent_key, source_path, source_offset, observed_at, created_at, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("test-uf-2", "test-run-2", "lead", existingFile2, 0, now, now, 200, 100, 0, 0);

    // Row 3: missing file
    db.prepare(
      `INSERT INTO usage_facts (usage_id, run_id, agent_key, source_path, source_offset, observed_at, created_at, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("test-uf-3", "test-run-1", "lead", missingFile, 0, now, now, 150, 75, 0, 0);

    const result = checkRetention(db, 365, true);

    // Assertions
    let passed = 0;
    let failed = 0;

    function assert(condition, label) {
      if (condition) { passed++; console.log(`  ✓ ${label}`); }
      else { failed++; console.error(`  ✗ ${label}`); }
    }

    assert(result.total_usage_facts === 3, `total_usage_facts === 3 (got ${result.total_usage_facts})`);
    assert(result.live_transcripts === 2, `live_transcripts === 2 (got ${result.live_transcripts})`);
    assert(result.missing_transcripts === 1, `missing_transcripts === 1 (got ${result.missing_transcripts})`);
    assert(result.coverage_pct === 66.7, `coverage_pct === 66.7 (got ${result.coverage_pct})`);
    assert(result.alarm === "CRITICAL", `alarm === "CRITICAL" (got ${result.alarm})`);
    assert(result.by_run.length === 2, `by_run.length === 2 (got ${result.by_run.length})`);
    assert(result.by_squad.length === 2, `by_squad.length === 2 (got ${result.by_squad.length})`);

    console.log(`\n${passed} passed, ${failed} failed`);
    db.close();
    return failed === 0 ? 0 : 1;
  } finally {
    // Cleanup
    try { rmSync(dbPath, { force: true }); } catch {}
    try { rmSync(existingFile, { force: true }); } catch {}
    try { rmSync(existingFile2, { force: true }); } catch {}
    try { rmSync(missingFile, { force: true }); } catch {}
  }
}

// ── CLI entry point ──────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { days: 30, json: false, byRun: false, test: false, help: false };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--days":
        opts.days = parseInt(args[++i], 10);
        if (isNaN(opts.days) || opts.days < 1) {
          console.error("--days requires a positive integer");
          process.exit(3);
        }
        break;
      case "--json":
        opts.json = true;
        break;
      case "--by-run":
        opts.byRun = true;
        break;
      case "--test":
        opts.test = true;
        break;
      case "--help":
      case "-h":
        opts.help = true;
        break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        usage();
        process.exit(3);
    }
  }

  return opts;
}

async function main() {
  const opts = parseArgs();

  if (opts.help) {
    usage();
    process.exit(0);
  }

  if (opts.test) {
    const exitCode = runSelfTest();
    process.exit(exitCode);
  }

  // Open real DB
  const dbPath = telemetryDbPath();
  if (!existsSync(dbPath)) {
    console.error(`Database not found: ${dbPath}`);
    process.exit(3);
  }

  let db;
  try {
    db = openDb(dbPath);
  } catch (err) {
    console.error(`Failed to open database: ${err.message}`);
    process.exit(3);
  }

  try {
    const result = checkRetention(db, opts.days, opts.byRun);

    if (opts.json) {
      // Strip by_squad from JSON output to match §12 schema exactly
      const jsonOutput = {
        checked_at: result.checked_at,
        window_days: result.window_days,
        total_usage_facts: result.total_usage_facts,
        live_transcripts: result.live_transcripts,
        missing_transcripts: result.missing_transcripts,
        coverage_pct: result.coverage_pct,
        alarm: result.alarm,
        by_run: result.by_run,
      };
      console.log(JSON.stringify(jsonOutput));
    } else {
      printHuman(result, opts.byRun);
    }

    // Exit code
    if (result.alarm === "OK") process.exit(0);
    if (result.alarm === "WARNING") process.exit(1);
    process.exit(2);
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(3);
});
