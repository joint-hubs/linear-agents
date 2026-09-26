#!/usr/bin/env node
// telemetry-usage-rewrite.mjs — FOC-381 (B5): one-off rewrite of legacy
// per-LINE usage_facts history into per-MESSAGE rows, WITHOUT deleting the
// event log.
//
// History written before FOC-381 (B1/B2) stored one usage_facts row per
// transcript line, so one assistant message arriving as N lines was counted N
// times (~2.1x inflation). The events table still holds one usage.recorded
// event per line, so the fix is to write the line's message.id into each
// stored event's payload — exactly what a fresh ingest emits — and reproject
// that pair. Events are updated in place, never deleted or re-keyed.
//
// The rewrite is deliberately paranoid. A pair (run_id, source_path) is only
// rewritten when every existing usage_facts row of the pair traces to an
// event (rows whose events were pruned can never be rebuilt — rewriting would
// lose them irreversibly), and every event traces back to its transcript line
// with counters that match byte-for-byte (the transcript is the ground
// truth; an edited transcript must not silently reprice history). Any doubt
// leaves the pair untouched and raises a usage_legacy_inflated data-quality
// issue instead: a skipped pair keeps inflated numbers, but a wrong rewrite
// loses history permanently.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  hasOpenQualityIssue,
  openTelemetryDb,
  reprojectEvents,
  reportDataQuality,
  resolveQualityIssue,
  telemetryDbPath,
} from "./telemetry-store.mjs";

// `busy` is a lock (e.g. the telemetry server holding a write), not a data
// problem: the pair stays healthy, a later run rewrites it.
const SKIP_REASONS = ["transcript_missing", "events_pruned", "unverifiable", "busy", "reproject_failed"];

function zeroSkips() {
  return Object.fromEntries(SKIP_REASONS.map((reason) => [reason, 0]));
}

function inTransaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* connection already rolled back */ }
    throw error;
  }
}

// SQLITE_BUSY / SQLITE_LOCKED mean the store is merely locked right now, not
// that the pair is broken. Separating them from real reprojection failures
// keeps a healthy pair out of the usage_legacy_inflated bucket — flagging it
// would misreport data quality for a condition that a re-run clears.
function isBusyError(error) {
  const message = String(error?.message || "");
  return message.includes("database is locked")
    || message.includes("database table is locked")
    || message.includes("SQLITE_BUSY")
    || message.includes("SQLITE_LOCKED");
}

// offset → trimmed JSON text, with byte offsets computed by the SAME
// arithmetic as jsonLineEvents (telemetry-ingest.mjs): split on newlines with
// lookbehind, advance by Buffer.byteLength of each raw line. Any divergence
// here would make stored event offsets miss this map and every pair would
// come back "unverifiable".
function transcriptLinesByOffset(path) {
  const content = readFileSync(path, "utf8");
  const byOffset = new Map();
  let offset = 0;
  for (const rawLine of content.split(/(?<=\n)/)) {
    const lineOffset = offset;
    offset += Buffer.byteLength(rawLine, "utf8");
    const raw = rawLine.trim();
    if (!raw) continue;
    byOffset.set(lineOffset, raw);
  }
  return byOffset;
}

// Map one pair's usage.recorded events back to transcript lines and verify
// each against its payload, using ingest's exact field mapping. Returns
// { plan } on success — plan[i] = { eventId, payload, messageId }, the write
// set for the transaction — or { reason: "unverifiable" } on any doubt.
function verifyPair(events, linesByOffset) {
  const plan = [];
  for (const event of events) {
    const payload = JSON.parse(event.payload_json);
    // An offset that is not at a line start, or a line that no longer parses,
    // means the transcript no longer matches the stored events.
    const raw = linesByOffset.get(event.source_offset);
    let line = null;
    if (raw != null) { try { line = JSON.parse(raw); } catch { /* edited line */ } }
    const message = line?.message;
    const usage = message?.usage;
    const messageId = typeof message?.id === "string" && message.id ? message.id : null;
    // Same ?? 0 mapping as jsonLineEvents, so a counter the ingest coerced
    // to 0 from null/undefined still compares equal to the line's null.
    const countersMatch = usage != null
      && (usage.input_tokens ?? 0) === (payload.inputTokens ?? 0)
      && (usage.output_tokens ?? 0) === (payload.outputTokens ?? 0)
      && (usage.cache_read_input_tokens ?? 0) === (payload.cacheReadTokens ?? 0)
      && (usage.cache_creation_input_tokens ?? 0) === (payload.cacheCreationTokens ?? 0);
    // An event that already carries a messageId (partially re-ingested pair)
    // must agree with its line's message.id.
    const idConsistent = payload.messageId == null || payload.messageId === messageId;
    if (!messageId || !countersMatch || !idConsistent) return { reason: "unverifiable" };
    plan.push({ eventId: event.event_id, payload, messageId });
  }
  return { plan };
}

// Per-pair projection stats: row count, token total, and cost joined at the
// run's OWN price_set_id (the same join querySummary uses), plus the squad
// for the per-squad token summary.
function pairStats(db, runId, sourcePath) {
  const rows = db.prepare(
    `SELECT u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_creation_tokens, r.squad, c.cost_usd
       FROM usage_facts u
       JOIN runs r ON r.run_id = u.run_id
       LEFT JOIN cost_facts c ON c.run_id=u.run_id AND c.usage_id=u.usage_id AND c.price_set_id=r.price_set_id
      WHERE u.run_id=? AND u.source_path=?`,
  ).all(runId, sourcePath);
  let tokens = 0;
  let cost = 0;
  let squad = null;
  for (const row of rows) {
    tokens += row.input_tokens + row.output_tokens + row.cache_read_tokens + row.cache_creation_tokens;
    cost += row.cost_usd || 0;
    squad = row.squad ?? squad;
  }
  return { rows: rows.length, tokens, cost, squad };
}

/**
 * Rewrite legacy per-line usage_facts history into per-message rows.
 *
 * Unit of work = one (run_id, source_path) pair holding rows with
 * message_id IS NULL. Per pair: guards (transcript exists → every row has an
 * event → every event verifies against its transcript line), then ONE
 * transaction that adds messageId to each event's payload, deletes the pair's
 * usage rows, and reprojects exactly that pair. Pairs failing any guard keep
 * their rows untouched and are reported via ONE usage_legacy_inflated issue
 * per affected run.
 *
 * Idempotent: a pair with no message_id IS NULL rows is not a unit of work, so
 * a second full run finds zero pairs and changes nothing.
 *
 * @param {object} db open connection from openTelemetryDb()
 * @param {{dryRun?: boolean, runId?: string, sourcePath?: string,
 *   onProgress?: (progress: {index: number, total: number, runId: string,
 *   sourcePath: string, outcome: string, reason: string|null, error: string|null}) => void}} [options]
 *   dryRun defaults to true — the safe default for an irreversible rewrite.
 *   sourcePath filters pairs and must be the stored canonical (resolve()d)
 *   path; the CLI resolves the --source value before passing it.
 * @returns {object} summary (pairs, rows/tokens/cost before vs after, per-squad
 *   tokens, issues). In dry run nothing is written and all `after` values are
 *   null — they describe the state AFTER a write that did not happen.
 */
export function rewriteUsageHistory(db, options = {}) {
  const dryRun = options.dryRun ?? true;
  const onProgress = options.onProgress ?? null;

  const clauses = ["message_id IS NULL"];
  const args = [];
  if (options.runId) { clauses.push("run_id = ?"); args.push(options.runId); }
  if (options.sourcePath) { clauses.push("source_path = ?"); args.push(options.sourcePath); }
  const pairs = db.prepare(
    `SELECT run_id, source_path, COUNT(*) AS legacy_rows
       FROM usage_facts WHERE ${clauses.join(" AND ")}
       GROUP BY run_id, source_path ORDER BY run_id, source_path`,
  ).all(...args);

  const summary = {
    dryRun,
    pairs: { total: pairs.length, eligible: 0, rewritten: 0, skippedTotal: 0, skipped: zeroSkips(), failures: [] },
    usageRows: { before: 0, after: null },
    tokens: { before: 0, after: null, bySquad: {} },
    cost: { before: 0, after: null },
    issues: { runsAffected: 0, runsFlagged: 0, runsResolved: 0 },
  };
  const bySquad = new Map(); // squad → { before, after } token totals
  const skippedByRun = new Map(); // runId → { sources: Set, rows, reasons }

  const addBefore = (stats) => {
    summary.usageRows.before += stats.rows;
    summary.tokens.before += stats.tokens;
    summary.cost.before += stats.cost;
    const key = stats.squad ?? "(none)";
    const bucket = bySquad.get(key) || { before: 0, after: null };
    bucket.before += stats.tokens;
    bySquad.set(key, bucket);
  };

  let index = 0;
  for (const pair of pairs) {
    index++;
    addBefore(pairStats(db, pair.run_id, pair.source_path));
    let reason = null;
    let firstError = null;
    let plan = null;

    // (a) The transcript is the ground truth the events are verified against;
    // without it the pair is untouchable.
    if (!existsSync(pair.source_path)) {
      reason = "transcript_missing";
    } else {
      const events = db.prepare(
        "SELECT event_id, source_offset, payload_json FROM events WHERE run_id=? AND source_path=? AND event_type='usage.recorded' ORDER BY source_offset",
      ).all(pair.run_id, pair.source_path);
      const rows = db.prepare(
        "SELECT source_offset FROM usage_facts WHERE run_id=? AND source_path=?",
      ).all(pair.run_id, pair.source_path);
      // (b) Coverage guard: every row must have its event. Events were pruned
      // for some sources (telemetry-prune.mjs), and a delete would leave rows
      // the log can no longer rebuild — irreversible loss.
      const eventOffsets = new Set(events.map((event) => event.source_offset));
      if (rows.some((row) => !eventOffsets.has(row.source_offset))) {
        reason = "events_pruned";
      } else {
        // (c) Verify every event against its transcript line. Read the file
        // once per pair; transcripts can be tens of MB.
        let linesByOffset;
        try { linesByOffset = transcriptLinesByOffset(pair.source_path); }
        catch { reason = "unverifiable"; }
        if (!reason) {
          const verdict = verifyPair(events, linesByOffset);
          if (verdict.reason) reason = verdict.reason;
          else plan = verdict.plan;
        }
      }
    }

    if (reason === null) {
      // (d) One transaction per pair: event payloads get messageId, the
      // pair's rows are deleted and rebuilt by reprojection. Any failure
      // rolls the whole pair back to its untouched legacy state.
      // `eligible` stays DISJOINT from `skipped`: a pair whose write fails
      // (busy lock, reprojection failure) is counted only as skipped, so
      // the report never double-counts a pair as both eligible and failed.
      if (dryRun) {
        summary.pairs.eligible++;
      } else {
        try {
          inTransaction(db, () => {
            const updatePayload = db.prepare("UPDATE events SET payload_json=? WHERE event_id=?");
            for (const item of plan) {
              // Only the messageId key is added; every other key, value and
              // order in the payload is preserved.
              updatePayload.run(JSON.stringify({ ...item.payload, messageId: item.messageId }), item.eventId);
            }
            // cost_facts cascades with usage_facts when foreign_keys=ON (openTelemetryDb
            // sets it), but the rewrite must not depend on the caller's PRAGMA
            // state — delete the pair's cost rows explicitly first.
            db.prepare(
              "DELETE FROM cost_facts WHERE run_id=? AND usage_id IN (SELECT usage_id FROM usage_facts WHERE run_id=? AND source_path=?)",
            ).run(pair.run_id, pair.run_id, pair.source_path);
            db.prepare("DELETE FROM usage_facts WHERE run_id=? AND source_path=?")
              .run(pair.run_id, pair.source_path);
            const reproject = reprojectEvents(db, {
              runId: pair.run_id, sourcePath: pair.source_path, eventTypes: ["usage.recorded"],
            });
            if (reproject.failed > 0) {
              const error = new Error(reproject.errors[0] || "reprojection reported failures");
              error.allErrors = reproject.errors;
              throw error;
            }
          });
          summary.pairs.eligible++;
          summary.pairs.rewritten++;
        } catch (error) {
          reason = isBusyError(error) ? "busy" : "reproject_failed";
          firstError = error.message;
        }
      }
    }

    if (reason !== null) {
      summary.pairs.skipped[reason]++;
      summary.pairs.skippedTotal++;
      // `failures` = write attempts that errored (busy / reproject_failed);
      // guard rejections are already fully described by `skipped[reason]`.
      if (reason === "busy" || reason === "reproject_failed") {
        summary.pairs.failures.push({ runId: pair.run_id, sourcePath: pair.source_path, reason, error: firstError });
      }
      if (reason !== "busy") {
        // Only data problems feed the usage_legacy_inflated issue — a busy
        // pair is untouched and healthy, flagging it would be a false alarm.
        const record = skippedByRun.get(pair.run_id) || { sources: new Set(), rows: 0, reasons: {} };
        record.sources.add(pair.source_path);
        record.rows += pair.legacy_rows;
        record.reasons[reason] = (record.reasons[reason] || 0) + 1;
        skippedByRun.set(pair.run_id, record);
      }
    }

    onProgress?.({
      index, total: pairs.length, runId: pair.run_id, sourcePath: pair.source_path,
      outcome: reason || (dryRun ? "eligible" : "rewritten"), reason, error: firstError,
    });
  }

  // After-state over the same scope. Skipped pairs are untouched, so their
  // numbers are identical before and after; rewritten pairs show the merge.
  if (!dryRun) {
    summary.usageRows.after = 0;
    summary.tokens.after = 0;
    summary.cost.after = 0;
    for (const bucket of bySquad.values()) bucket.after = 0;
    for (const pair of pairs) {
      const stats = pairStats(db, pair.run_id, pair.source_path);
      summary.usageRows.after += stats.rows;
      summary.tokens.after += stats.tokens;
      summary.cost.after += stats.cost;
      const bucket = bySquad.get(stats.squad ?? "(none)");
      bucket.after += stats.tokens;
    }
  }
  summary.tokens.bySquad = Object.fromEntries([...bySquad].map(([squad, b]) => [squad, { ...b }]));

  // (e) ONE data-quality issue per affected run. reportDataQuality routes
  // through applyQualityReported → raiseIssue, whose (run_id, issue_type,
  // open) dedup — enforced again at event level by eventAlreadyApplied —
  // means re-runs do not multiply issues.
  summary.issues.runsAffected = skippedByRun.size;
  if (!dryRun) {
    for (const [runId, record] of skippedByRun) {
      if (hasOpenQualityIssue(db, runId, "usage_legacy_inflated")) continue;
      reportDataQuality(runId, "usage_legacy_inflated", {
        sources: [...record.sources].sort(),
        rows: record.rows,
        reasons: record.reasons,
      }, { severity: "warning" });
      summary.issues.runsFlagged++;
    }

    // (f) A run whose legacy rows are ALL rewritten (no message_id IS NULL
    // row remains for it anywhere in the store) is no longer inflated, so a
    // usage_legacy_inflated issue left open by an earlier pass must close.
    // Resolved through the store's existing resolveQualityIssue path — the
    // same mechanism ingest uses when a missing artifact reappears — never
    // a hand-rolled UPDATE.
    for (const { run_id: runId } of db.prepare(
      "SELECT run_id FROM data_quality_issues WHERE issue_type='usage_legacy_inflated' AND resolved_at IS NULL AND run_id IS NOT NULL",
    ).all()) {
      const remaining = db.prepare(
        "SELECT 1 FROM usage_facts WHERE run_id=? AND message_id IS NULL LIMIT 1",
      ).get(runId);
      if (remaining) continue;
      const { closed } = resolveQualityIssue(db, runId, "usage_legacy_inflated");
      if (closed) summary.issues.runsResolved++;
    }
  }
  return summary;
}

const USAGE = "Usage: node scripts/telemetry-usage-rewrite.mjs [--apply] [--json] [--run <id>] [--source <path>] [--live]";

function parseArgs(args) {
  const flags = { apply: false, json: false, live: false, run: null, source: null };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--apply" || arg === "--json" || arg === "--live") { flags[arg.slice(2)] = true; continue; }
    if (arg === "--run" || arg === "--source") {
      const value = args[++i];
      if (!value || value.startsWith("--")) {
        console.error(`[telemetry-usage-rewrite] ${arg} requires a value\n${USAGE}`);
        process.exit(2);
      }
      flags[arg.slice(2)] = value;
      continue;
    }
    console.error(`[telemetry-usage-rewrite] unknown flag: ${arg}\n${USAGE}`);
    process.exit(2);
  }
  return flags;
}

function printSummary(summary) {
  const skipped = Object.entries(summary.pairs.skipped).filter(([, count]) => count > 0)
    .map(([reason, count]) => `${reason}=${count}`).join(", ") || "none";
  console.log(`[telemetry-usage-rewrite] mode=${summary.dryRun ? "dry-run (nothing written)" : "apply"}`);
  console.log(`[telemetry-usage-rewrite] pairs: total=${summary.pairs.total} eligible=${summary.pairs.eligible} rewritten=${summary.pairs.rewritten} skipped=${summary.pairs.skippedTotal} (${skipped})`);
  console.log(`[telemetry-usage-rewrite] usage rows: before=${summary.usageRows.before} after=${summary.usageRows.after ?? "(dry run)"}`);
  console.log(`[telemetry-usage-rewrite] tokens: before=${summary.tokens.before} after=${summary.tokens.after ?? "(dry run)"}`);
  for (const [squad, stat] of Object.entries(summary.tokens.bySquad)) {
    console.log(`[telemetry-usage-rewrite] tokens[${squad}]: before=${stat.before} after=${stat.after ?? "(dry run)"}`);
  }
  console.log(`[telemetry-usage-rewrite] cost: before=${summary.cost.before} after=${summary.cost.after ?? "(dry run)"}`);
  console.log(`[telemetry-usage-rewrite] usage_legacy_inflated: affectedRuns=${summary.issues.runsAffected} flagged=${summary.issues.runsFlagged} resolved=${summary.issues.runsResolved}`);
  for (const failure of summary.pairs.failures) {
    console.log(`[telemetry-usage-rewrite] ${failure.reason} run=${failure.runId} source=${failure.sourcePath}: ${failure.error}`);
  }
  if (summary.dryRun) {
    console.log("[telemetry-usage-rewrite] DRY RUN — nothing was written. Re-run with --apply (plus --live for the default store) to write.");
  }
}

// The default live store path with LA_TELEMETRY_DB / LA_TELEMETRY_HOME
// IGNORED — the same derivation as telemetryDbPath(), but those env vars can
// point right back AT the live store, so the guard below must decide by WHERE
// the resolved target leads, never by which env vars happen to be set.
function defaultLiveDbPath() {
  const home = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  return join(home, "linear-agents", "telemetry", "telemetry.sqlite");
}

function sameDbFile(a, b) {
  const [ra, rb] = [resolve(a), resolve(b)];
  // Path equality on win32 is case-insensitive (NTFS); on POSIX it is not.
  return process.platform === "win32" ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  const dbPath = telemetryDbPath();
  console.error(`[telemetry-usage-rewrite] db: ${dbPath}${flags.apply ? "" : " (dry run)"}`);

  // Safety: --apply against the default live store needs an explicit --live.
  // The decision is WHERE the resolved path leads: an env override aimed at
  // the live store is no safer than no override at all, and this rewrite is
  // irreversible. Refuse BEFORE opening the DB — openTelemetryDb would
  // create/migrate the directory.
  if (flags.apply && !flags.live && sameDbFile(dbPath, defaultLiveDbPath())) {
    console.error(
      `[telemetry-usage-rewrite] REFUSING --apply against the default live store:\n` +
      `  ${dbPath}\n` +
      `  This rewrite is irreversible. Either point LA_TELEMETRY_DB / LA_TELEMETRY_HOME\n` +
      `  at a copy OUTSIDE the default live location, or re-run with --live to confirm\n` +
      `  writing the live store.`,
    );
    process.exit(2);
  }

  const db = openTelemetryDb(dbPath); // migrates to v8 — intended: message_id must exist
  try {
    // Long per-pair transactions on a possibly busy live store.
    db.exec("PRAGMA busy_timeout = 30000;");
    const summary = rewriteUsageHistory(db, {
      dryRun: !flags.apply,
      runId: flags.run,
      sourcePath: flags.source ? resolve(flags.source) : null,
      onProgress: (progress) => {
        // Every 20 pairs — enough for a long run, quiet for a short one.
        if (progress.index % 20 !== 0 && progress.index !== progress.total) return;
        console.error(`[telemetry-usage-rewrite] pair ${progress.index}/${progress.total} ${progress.outcome} run=${progress.runId} source=${progress.sourcePath}`);
      },
    });
    if (flags.json) console.log(JSON.stringify(summary, null, 2));
    else printSummary(summary);
  } finally {
    db.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(`[telemetry-usage-rewrite] ${error.message}`);
    process.exit(1);
  }
}
