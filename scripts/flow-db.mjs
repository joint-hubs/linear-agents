#!/usr/bin/env node
// flow-db.mjs — persistent step-response DB for the Fenix pipeline.
//
// Ingests every squad-session transcript (per step = subagent role) into a
// local SQLite database (.state/flowdb/flow.db) so that:
//   1. step responses survive ~/.claude transcript retention,
//   2. process patterns are queryable (step repetitions, REVIEW→DEV bounces,
//      full PLAN→DEV→REVIEW→TEST traces per task),
//   3. future agents can retrieve historical experience (see
//      docs/plans/flowdb-learning-loop.md — layer 3).
//
// Zero external deps: uses node:sqlite (built into Node >= 22.5).
//
// Usage:
//   node scripts/flow-db.mjs ingest [--dry-run] [--json]
//   node scripts/flow-db.mjs trace <taskId> [--json]
//   node scripts/flow-db.mjs patterns [--squad s] [--agent a] [--json]
//   node scripts/flow-db.mjs search --text "fragment" [--squad s] [--agent a] [--task t] [--k 10] [--json]
//
// Exports (for telemetry-server + tests):
//   openDb(path?), ingestRun(db, run, turnsByAgent), ingestAll(opts),
//   queryTrace(db, taskId), queryPatterns(db, filters), querySearch(db, opts)

import { mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as ledger from "./ledger.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, "..");
export const DEFAULT_DB_PATH = join(root, ".state", "flowdb", "flow.db");

// Node >= 22.5 guard — keep the error actionable for older runtimes.
let DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}

export function sqliteAvailable() {
  return DatabaseSync != null;
}

/**
 * Open (and initialize) the flow DB. Creates parent dirs + schema on first use.
 * @param {string} [path]  Defaults to .state/flowdb/flow.db
 */
export function openDb(path = DEFAULT_DB_PATH) {
  if (!sqliteAvailable()) {
    throw new Error(
      "node:sqlite is not available — flow-db requires Node >= 22.5 (current: " +
        process.version + ")",
    );
  }
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS runs (
      run_id      TEXT PRIMARY KEY,
      squad       TEXT,
      task_id     TEXT,
      started_at  TEXT,
      ended_at    TEXT,
      status      TEXT,
      cost_usd    REAL DEFAULT 0,
      ingested_at TEXT
    );
    CREATE TABLE IF NOT EXISTS steps (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id         TEXT NOT NULL,
      squad          TEXT,
      agent          TEXT NOT NULL,
      task_id        TEXT,
      turn_idx       INTEGER NOT NULL,
      ts             TEXT,
      model          TEXT,
      text           TEXT,
      truncated      INTEGER DEFAULT 0,
      tool_uses      TEXT,
      input_tokens   INTEGER DEFAULT 0,
      output_tokens  INTEGER DEFAULT 0,
      cache_read     INTEGER DEFAULT 0,
      cache_creation INTEGER DEFAULT 0,
      cost_usd       REAL DEFAULT 0,
      UNIQUE(run_id, agent, turn_idx)
    );
    CREATE INDEX IF NOT EXISTS idx_steps_task  ON steps(task_id);
    CREATE INDEX IF NOT EXISTS idx_steps_agent ON steps(squad, agent);
    CREATE INDEX IF NOT EXISTS idx_runs_task   ON runs(task_id);
  `);
  return db;
}

/**
 * Ingest one run + its per-agent turn logs. Idempotent: re-ingesting a run
 * replaces its steps (needed when a previously "running" run has ended).
 *
 * @param {object} db             Open DatabaseSync
 * @param {object} run            scanRuns() item
 * @param {Object<string, Array>} turnsByAgent  agentKey -> extractAgentTurns() output
 * @returns {number} inserted step rows
 */
export function ingestRun(db, run, turnsByAgent) {
  db.prepare("DELETE FROM steps WHERE run_id = ?").run(run.runId);
  db.prepare(
    `INSERT INTO runs (run_id, squad, task_id, started_at, ended_at, status, cost_usd, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id) DO UPDATE SET
       squad=excluded.squad, task_id=excluded.task_id, started_at=excluded.started_at,
       ended_at=excluded.ended_at, status=excluded.status, cost_usd=excluded.cost_usd,
       ingested_at=excluded.ingested_at`,
  ).run(
    run.runId,
    run.squad || null,
    run.taskId || null,
    run.startedAt || null,
    run.endedAt || null,
    run.status || null,
    run.totals?.costUSD ?? 0,
    new Date().toISOString(),
  );

  const ins = db.prepare(
    `INSERT OR REPLACE INTO steps
       (run_id, squad, agent, task_id, turn_idx, ts, model, text, truncated,
        tool_uses, input_tokens, output_tokens, cache_read, cache_creation, cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  let count = 0;
  for (const [agentKey, turns] of Object.entries(turnsByAgent || {})) {
    turns.forEach((t, i) => {
      const cost = ledger.costTokens(
        {
          inputTokens: t.usage?.inputTokens ?? 0,
          outputTokens: t.usage?.outputTokens ?? 0,
          cacheRead: t.usage?.cacheRead ?? 0,
          cacheCreation: t.usage?.cacheCreation ?? 0,
        },
        t.model,
      );
      ins.run(
        run.runId,
        run.squad || null,
        agentKey,
        run.taskId || null,
        i,
        t.ts || null,
        t.model || null,
        t.text || "",
        t.truncated ? 1 : 0,
        JSON.stringify(t.toolUses || []),
        t.usage?.inputTokens ?? 0,
        t.usage?.outputTokens ?? 0,
        t.usage?.cacheRead ?? 0,
        t.usage?.cacheCreation ?? 0,
        cost,
      );
      count++;
    });
  }
  return count;
}

/** Should this run be (re-)ingested? Skip runs already stored in a final state. */
function needsIngest(db, run) {
  const row = db
    .prepare("SELECT status, ended_at FROM runs WHERE run_id = ?")
    .get(run.runId);
  if (!row) return true;
  if (row.status === "running") return true; // was live at last ingest
  if (row.ended_at !== (run.endedAt || null)) return true;
  return false;
}

/** Resolve a run's transcript path (same logic as /api/flow/log). */
function transcriptPathForRun(run) {
  return (
    run.transcriptPath ||
    (run.sessionId ? join(ledger.listTranscriptDir(), run.sessionId + ".jsonl") : null)
  );
}

/**
 * Ingest all runs (scanRuns) into the DB. Skips already-final runs.
 * @param {{ dbPath?: string, dryRun?: boolean, maxTextLen?: number }} [opts]
 */
export async function ingestAll(opts = {}) {
  const { dbPath = DEFAULT_DB_PATH, dryRun = false, maxTextLen = 20000 } = opts;
  const runs = await ledger.scanRuns();
  const db = openDb(dbPath);

  const summary = { scanned: runs.length, ingested: 0, skipped: 0, steps: 0, noTranscript: 0 };
  try {
    for (const run of runs) {
      if (!needsIngest(db, run)) {
        summary.skipped++;
        continue;
      }
      const tp = transcriptPathForRun(run);
      if (!tp || !existsSync(tp)) {
        summary.noTranscript++;
        continue;
      }
      const windowStart = run.startedAt ? new Date(run.startedAt).getTime() : null;
      const windowEnd = run.endedAt
        ? new Date(run.endedAt).getTime() + 60 * 1000
        : Date.now() + 60 * 1000;

      const turnsByAgent = {};
      for (const agentKey of Object.keys(run.byAgent || {})) {
        turnsByAgent[agentKey] = ledger.extractAgentTurns(tp, agentKey, {
          windowStart,
          windowEnd,
          maxTextLen,
        });
      }
      if (dryRun) {
        summary.ingested++;
        summary.steps += Object.values(turnsByAgent).reduce((n, t) => n + t.length, 0);
        continue;
      }
      summary.steps += ingestRun(db, run, turnsByAgent);
      summary.ingested++;
    }
  } finally {
    db.close();
  }
  return summary;
}

/**
 * Full process trace for one task: run chain (chronological, cross-squad),
 * per-run step summary, and REVIEW→DEV bounce detection.
 */
export function queryTrace(db, taskId) {
  const runs = db
    .prepare(
      `SELECT run_id, squad, started_at, ended_at, status, cost_usd
       FROM runs WHERE task_id = ? ORDER BY started_at`,
    )
    .all(taskId);

  const stepsStmt = db.prepare(
    `SELECT agent, COUNT(*) AS turns, SUM(cost_usd) AS cost,
            MIN(ts) AS first_ts, MAX(ts) AS last_ts
     FROM steps WHERE run_id = ? GROUP BY agent ORDER BY MIN(ts)`,
  );

  const chain = runs.map((r) => ({
    runId: r.run_id,
    squad: r.squad,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    status: r.status,
    costUSD: r.cost_usd,
    steps: stepsStmt.all(r.run_id).map((s) => ({
      agent: s.agent,
      turns: s.turns,
      costUSD: s.cost,
      firstTs: s.first_ts,
      lastTs: s.last_ts,
    })),
  }));

  // Bounce = a DEV run that starts AFTER a REVIEW run of the same task
  // (review sent it back — Conventional Comments -> In Progress).
  let bounces = 0;
  let lastReviewStart = null;
  const squadRepeats = {};
  for (const r of chain) {
    squadRepeats[r.squad] = (squadRepeats[r.squad] || 0) + 1;
    if (r.squad === "review") lastReviewStart = r.startedAt;
    if (r.squad === "dev" && lastReviewStart && r.startedAt > lastReviewStart) bounces++;
  }
  const repeatedSquads = Object.fromEntries(
    Object.entries(squadRepeats).filter(([, n]) => n > 1),
  );

  return {
    taskId,
    runs: chain,
    totalCostUSD: chain.reduce((n, r) => n + (r.costUSD || 0), 0),
    reviewDevBounces: bounces,
    squadRepeats: repeatedSquads,
  };
}

/**
 * Cross-task patterns: per-step stats + repetition + per-task bounce table.
 */
export function queryPatterns(db, filters = {}) {
  const where = [];
  const params = [];
  if (filters.squad) { where.push("squad = ?"); params.push(filters.squad); }
  if (filters.agent) { where.push("agent = ?"); params.push(filters.agent); }
  const W = where.length ? "WHERE " + where.join(" AND ") : "";

  const stepStats = db
    .prepare(
      `SELECT squad, agent,
              COUNT(DISTINCT run_id) AS executions,
              COUNT(*) AS turns,
              ROUND(AVG(cnt), 2) AS avg_turns_per_run,
              SUM(cost) AS cost_usd
       FROM (
         SELECT run_id, squad, agent, COUNT(*) AS cnt, SUM(cost_usd) AS cost
         FROM steps ${W} GROUP BY run_id, squad, agent
       ) GROUP BY squad, agent ORDER BY squad, agent`,
    )
    .all(...params);

  // Step repetition: same (task, squad, agent) executed in >1 run — the
  // "how many times did this step have to be repeated" signal.
  const repeats = db
    .prepare(
      `SELECT task_id, squad, agent, COUNT(DISTINCT run_id) AS times
       FROM steps ${W ? W + " AND" : "WHERE"} task_id IS NOT NULL
       GROUP BY task_id, squad, agent
       HAVING times > 1 ORDER BY times DESC, task_id LIMIT 50`,
    )
    .all(...params);

  // REVIEW→DEV bounces per task (run-sequence heuristic, same as queryTrace).
  const taskRuns = db
    .prepare(
      `SELECT task_id, squad, started_at FROM runs
       WHERE task_id IS NOT NULL ORDER BY task_id, started_at`,
    )
    .all();
  const bounceByTask = {};
  let cur = null;
  let lastReview = null;
  for (const r of taskRuns) {
    if (r.task_id !== cur) { cur = r.task_id; lastReview = null; }
    if (r.squad === "review") lastReview = r.started_at;
    if (r.squad === "dev" && lastReview && r.started_at > lastReview) {
      bounceByTask[cur] = (bounceByTask[cur] || 0) + 1;
    }
  }
  const bounces = Object.entries(bounceByTask)
    .map(([taskId, n]) => ({ taskId, bounces: n }))
    .sort((a, b) => b.bounces - a.bounces);

  const failures = db
    .prepare(
      `SELECT squad, COUNT(*) AS runs,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM runs GROUP BY squad ORDER BY squad`,
    )
    .all();

  return { stepStats, repeats, bounces, failures };
}

/**
 * Simple historical search over step responses (LIKE match). Layer-3
 * experience packets will build on this (see docs/plans/flowdb-learning-loop.md).
 */
export function querySearch(db, opts = {}) {
  const { text = "", squad, agent, task, k = 10 } = opts;
  const where = ["text LIKE ?"];
  const params = ["%" + text + "%"];
  if (squad) { where.push("squad = ?"); params.push(squad); }
  if (agent) { where.push("agent = ?"); params.push(agent); }
  if (task) { where.push("task_id = ?"); params.push(task); }
  return db
    .prepare(
      `SELECT run_id, squad, agent, task_id, ts, model,
              SUBSTR(text, 1, 400) AS snippet, cost_usd
       FROM steps WHERE ${where.join(" AND ")}
       ORDER BY ts DESC LIMIT ?`,
    )
    .all(...params, k);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function argVal(args, name, dflt = null) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const asJson = args.includes("--json");
  const dbPath = argVal(args, "--db", DEFAULT_DB_PATH);

  const usage = `Usage:
  node scripts/flow-db.mjs ingest [--dry-run] [--db path] [--json]
  node scripts/flow-db.mjs trace <taskId> [--db path] [--json]
  node scripts/flow-db.mjs patterns [--squad s] [--agent a] [--db path] [--json]
  node scripts/flow-db.mjs search --text "fragment" [--squad s] [--agent a] [--task t] [--k 10] [--json]`;

  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(usage);
    process.exit(cmd ? 0 : 2);
  }

  if (cmd === "ingest") {
    const summary = await ingestAll({ dbPath, dryRun: args.includes("--dry-run") });
    if (asJson) console.log(JSON.stringify(summary, null, 2));
    else
      console.log(
        `[flow-db] scanned=${summary.scanned} ingested=${summary.ingested} ` +
          `skipped=${summary.skipped} steps=${summary.steps} no-transcript=${summary.noTranscript}` +
          (args.includes("--dry-run") ? " (dry-run)" : ""),
      );
    return;
  }

  const db = openDb(dbPath);
  try {
    if (cmd === "trace") {
      const taskId = args[1];
      if (!taskId || taskId.startsWith("--")) {
        console.error("trace requires a taskId");
        process.exit(2);
      }
      const t = queryTrace(db, taskId);
      if (asJson) { console.log(JSON.stringify(t, null, 2)); return; }
      console.log(`Trace ${t.taskId} — ${t.runs.length} runs, $${t.totalCostUSD.toFixed(2)}, ` +
        `review→dev bounces: ${t.reviewDevBounces}`);
      for (const r of t.runs) {
        console.log(`  [${r.startedAt}] ${(r.squad || "?").padEnd(7)} ${r.status || "?"} $${(r.costUSD || 0).toFixed(2)} (${r.runId})`);
        for (const s of r.steps) console.log(`     - ${s.agent}: ${s.turns} turns, $${(s.costUSD || 0).toFixed(3)}`);
      }
      if (Object.keys(t.squadRepeats).length)
        console.log(`  repeated squads: ${JSON.stringify(t.squadRepeats)}`);
    } else if (cmd === "patterns") {
      const p = queryPatterns(db, { squad: argVal(args, "--squad"), agent: argVal(args, "--agent") });
      if (asJson) { console.log(JSON.stringify(p, null, 2)); return; }
      console.log("Step stats (squad/agent · executions · avg turns/run · cost):");
      for (const s of p.stepStats)
        console.log(`  ${s.squad}/${s.agent}: ${s.executions}× · ${s.avg_turns_per_run} · $${(s.cost_usd || 0).toFixed(2)}`);
      console.log("Repeated steps (same task, >1 run):");
      for (const r of p.repeats) console.log(`  ${r.task_id} ${r.squad}/${r.agent}: ${r.times}×`);
      console.log("Review→dev bounces per task:");
      for (const b of p.bounces) console.log(`  ${b.taskId}: ${b.bounces}`);
      console.log("Failures per squad:");
      for (const f of p.failures) console.log(`  ${f.squad}: ${f.failed}/${f.runs} failed`);
    } else if (cmd === "search") {
      const text = argVal(args, "--text");
      if (!text) { console.error('search requires --text "fragment"'); process.exit(2); }
      const rows = querySearch(db, {
        text,
        squad: argVal(args, "--squad"),
        agent: argVal(args, "--agent"),
        task: argVal(args, "--task"),
        k: parseInt(argVal(args, "--k", "10"), 10),
      });
      if (asJson) { console.log(JSON.stringify(rows, null, 2)); return; }
      for (const r of rows) {
        console.log(`— [${r.ts}] ${r.squad}/${r.agent} ${r.task_id || ""} (${r.model})`);
        console.log(`  ${r.snippet.replace(/\n/g, "\n  ")}`);
      }
      if (!rows.length) console.log("(no matches)");
    } else {
      console.log(usage);
      process.exit(2);
    }
  } finally {
    db.close();
  }
}

// Run CLI only when executed directly (not when imported by server/tests).
const isDirect =
  process.argv[1] &&
  fileURLToPath(import.meta.url).toLowerCase() ===
    (await import("node:path")).resolve(process.argv[1]).toLowerCase();
if (isDirect) {
  main().catch((e) => {
    console.error("[flow-db] " + e.message);
    process.exit(1);
  });
}
