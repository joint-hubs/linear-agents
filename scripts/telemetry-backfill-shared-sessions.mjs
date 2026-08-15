#!/usr/bin/env node
/**
 * scripts/telemetry-backfill-shared-sessions.mjs — one-shot backfill for runs
 * that share a transcript_path with another run.
 *
 * Background: pre-JOI-259 the ingest skip-cache keyed on source_path alone, so
 * when runs A and B pointed at the same transcript file, ingesting A silently
 * dropped B's usage_facts / tool_facts / events. The v5 (JOI-260) re-keying
 * made transcript_sources and usage_facts run-scoped, but the rows for the
 * shadowed runs were never recovered. This script finds every shared-path run
 * (or an explicit --run list), re-calls ingestTranscript for each, and emits a
 * per-run before/after report.
 *
 * Idempotent — ingestTranscript's skip-cache is run-scoped via the
 * (source_path, run_id) PK post-v5, and recordToolFact / recordDelegationLink
 * use INSERT OR IGNORE, so a second run reports before === after for every run.
 *
 * Naming + flag shape mirror scripts/backfill-tool-and-delegation.mjs.
 *
 * Usage:
 *   node scripts/telemetry-backfill-shared-sessions.mjs [--dry] [--run ID ...] [--json] [--help]
 *
 * Flags:
 *   --dry       Report candidates + before-snapshot without writing.
 *   --run ID    Limit to the given run_id (repeatable). Skips shared-path filter.
 *   --json      Emit one JSON object per line (machine-readable, no prose).
 *   --help      Show this help.
 *
 * Exit codes: 0 on success (including all-skipped), 1 on v5-marker-missing
 * or fatal error.
 */

import {
  MIGRATION_VERSIONS,
  openTelemetryDb,
  queryRuns,
  sqliteAvailable,
} from "./telemetry-store.mjs";
import { ingestTranscript, transcriptForSession } from "./telemetry-ingest.mjs";

// ---------------------------------------------------------------------------
// Row counters — (run_id, source_path) scoped so the report reflects only the
// lead transcript for this run (subagent transcripts have their own rows).
// ---------------------------------------------------------------------------

function countUsageFacts(db, runId, sourcePath) {
  return db.prepare(
    "SELECT COUNT(*) AS n FROM usage_facts WHERE run_id=? AND source_path=?",
  ).get(runId, sourcePath).n;
}

function countToolFacts(db, runId, sourcePath) {
  return db.prepare(
    "SELECT COUNT(*) AS n FROM tool_facts WHERE run_id=? AND source_path=?",
  ).get(runId, sourcePath).n;
}

function countEvents(db, runId) {
  return db.prepare("SELECT COUNT(*) AS n FROM events WHERE run_id=?").get(runId ?? null).n;
}

function countDataQualityIssues(db, runId) {
  return db.prepare("SELECT COUNT(*) AS n FROM data_quality_issues WHERE run_id=?").get(runId ?? null).n;
}

// ---------------------------------------------------------------------------
// Candidate resolution
// ---------------------------------------------------------------------------

/**
 * Build the candidate run set.
 *
 * - If `runIds` is non-empty (--run mode): use them verbatim, no shared-path
 *   filter. `shared` is not known for these, reported as `false`.
 * - Otherwise: raw SQL on runs.transcript_path to find paths shared by >1 run
 *   (allowed per DoD), then enumerate every run row on those paths and resolve
 *   each via queryRuns(db, {runId}) to get a camelCase projection. `shared=true`
 *   for all rows in this branch.
 *
 * Returns an array of { runId, shared } in stable order.
 */
function resolveCandidates(db, runIds) {
  if (runIds.length > 0) {
    // Dedup while preserving order.
    const seen = new Set();
    const out = [];
    for (const id of runIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ runId: id, shared: false });
    }
    return out;
  }
  const sharedRows = db.prepare(
    "SELECT transcript_path, COUNT(DISTINCT run_id) AS c FROM runs WHERE transcript_path IS NOT NULL GROUP BY transcript_path HAVING c>1",
  ).all();
  if (sharedRows.length === 0) return [];
  const placeholders = sharedRows.map(() => "?").join(",");
  const runRows = db.prepare(
    `SELECT run_id FROM runs WHERE transcript_path IN (${placeholders}) ORDER BY run_id`,
  ).all(...sharedRows.map((row) => row.transcript_path));
  return runRows.map((row) => ({ runId: row.run_id, shared: true }));
}

// ---------------------------------------------------------------------------
// Per-run processing
// ---------------------------------------------------------------------------

function buildReport({ runId, shared, status, transcriptPath, before, after, events, toolFactsBefore, toolFactsAfter, extra = {} }) {
  return {
    runId,
    shared,
    status,
    ...(transcriptPath !== undefined ? { transcriptPath } : {}),
    before,
    after,
    events,
    toolFactsBefore,
    toolFactsAfter,
    ...extra,
  };
}

async function processRun(db, { runId, shared }, { dry, json }) {
  // AC2: candidates come via queryRuns(db, {runId}) — camelCase projection.
  // Never enumerate runs with a raw star-select on the runs table bound to
  // snake_case fields; that is the scenario-(f) hazard.
  const runs = queryRuns(db, { runId });
  const run = runs[0];
  if (!run) {
    const report = { runId, shared, status: "not_found" };
    emit(report, json);
    return report;
  }

  // AC3: transcriptForSession reads run.sessionId / run.transcriptPath /
  // run.claudeConfigDir / run.squad (camelCase).
  const transcriptPath = transcriptForSession(run);
  if (!transcriptPath) {
    // AC4: missing transcript file on disk => skipped, NO data_quality_issues write.
    const report = { runId, shared, status: "skipped" };
    emit(report, json);
    return report;
  }

  const toolFactsBefore = countToolFacts(db, runId, transcriptPath);
  const before = countUsageFacts(db, runId, transcriptPath);
  const eventsBefore = countEvents(db, runId);
  const dqBefore = countDataQualityIssues(db, runId);

  if (dry) {
    // AC5: --dry writes nothing. Emit before snapshot + would_ingest flag.
    const report = buildReport({
      runId, shared, status: "would_ingest", transcriptPath,
      before, after: before,
      events: eventsBefore,
      toolFactsBefore, toolFactsAfter: toolFactsBefore,
      extra: { wouldIngest: true },
    });
    emit(report, json);
    return report;
  }

  // AC3: re-extract tool_facts + delegation_links via ingestTranscript.
  const ingestResult = await ingestTranscript(db, runId, transcriptPath, run.sessionId);

  const after = countUsageFacts(db, runId, transcriptPath);
  const toolFactsAfter = countToolFacts(db, runId, transcriptPath);
  const eventsAfter = countEvents(db, runId);
  const dqAfter = countDataQualityIssues(db, runId);

  // Sanity: AC4 invariant — this backfill should not create new data_quality_issues rows.
  // We surface before/after counts in the report so any unexpected delta is
  // visible in logs/--json output.
  const status = ingestResult.missing ? "skipped" : "ingested";
  const report = buildReport({
    runId, shared, status, transcriptPath,
    before, after,
    events: eventsAfter,
    toolFactsBefore, toolFactsAfter,
    extra: {
      ingest: ingestResult,
      // Surface DQ delta so a regression (new data_quality_issues row) is visible.
      dataQualityBefore: dqBefore,
      dataQualityAfter: dqAfter,
    },
  });
  emit(report, json);
  return report;
}

function emit(report, json) {
  if (json) {
    process.stdout.write(JSON.stringify(report) + "\n");
  } else {
    const { runId, shared, status, before, after, events, toolFactsBefore, toolFactsAfter } = report;
    const tag = shared ? "[shared]" : "[run]";
    if (status === "skipped" || status === "not_found") {
      console.log(`${tag} ${runId}: ${status}`);
    } else if (status === "would_ingest") {
      console.log(`${tag} ${runId}: would_ingest (before usage=${before} tool=${toolFactsBefore} events=${events})`);
    } else {
      console.log(`${tag} ${runId}: ${status} (usage ${before}->${after}, tool ${toolFactsBefore}->${toolFactsAfter}, events=${events})`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help")) {
    console.log(`
Usage: node scripts/telemetry-backfill-shared-sessions.mjs [options]

Re-ingest runs that share a transcript_path with another run, recovering
usage_facts / tool_facts / events rows that the pre-v5 skip-cache dropped.

Options:
  --dry       Report candidates + before-snapshot without writing
  --run ID    Limit to the given run_id (repeatable). Skips shared-path filter.
  --json      Emit one JSON object per line (machine-readable)
  --help      Show this help
`);
    return 0;
  }

  const dry = args.includes("--dry");
  const json = args.includes("--json");
  const runIds = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--run" && i + 1 < args.length) {
      runIds.push(args[++i]);
    }
  }

  if (!sqliteAvailable()) {
    console.error("ERROR: node:sqlite is required (Node 22+ with --experimental-sqlite)");
    return 1;
  }

  const db = openTelemetryDb();
  try {
    // AC1: v5 marker must be present. The run-scoped skip-cache + usage_facts
    // PK rely on the v5 migration; running against a pre-v5 DB would silently
    // re-introduce the original shadowing bug.
    const v5 = db.prepare("SELECT 1 FROM schema_migrations WHERE version=?")
      .get(MIGRATION_VERSIONS.runScopedUsage);
    if (!v5) {
      if (json) {
        process.stdout.write(JSON.stringify({ status: "error", code: "run-schema-migration-first" }) + "\n");
      } else {
        console.error("run-schema-migration-first");
      }
      return 1;
    }

    const candidates = resolveCandidates(db, runIds);

    if (!json) {
      console.log(
        `Found ${candidates.length} candidate run(s)${runIds.length ? " (--run)" : " (shared transcript_path)"}${dry ? " [DRY]" : ""}`,
      );
    }

    const reports = [];
    for (const candidate of candidates) {
      // Process serially: ingestTranscript writes to the shared DB and re-opens
      // connections inside recordToolFact/recordDelegationLink.
      reports.push(await processRun(db, candidate, { dry, json }));
    }

    if (!json) {
      const ingested = reports.filter((r) => r.status === "ingested").length;
      const skipped = reports.filter((r) => r.status === "skipped").length;
      const wouldIngest = reports.filter((r) => r.status === "would_ingest").length;
      const notFound = reports.filter((r) => r.status === "not_found").length;
      console.log(
        `\nDone: ${candidates.length} candidate(s) — ${ingested} ingested, ${wouldIngest} would-ingest, ${skipped} skipped, ${notFound} not-found.`,
      );
    }

    return 0;
  } catch (error) {
    if (json) {
      process.stdout.write(JSON.stringify({ status: "error", message: error.message }) + "\n");
    } else {
      console.error(`[backfill-shared-sessions] ${error.message}`);
    }
    return 1;
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error(`[backfill-shared-sessions] ${error.message}`);
    process.exitCode = 1;
  });
