// Test for FOC-381 (B5): telemetry-usage-rewrite.mjs — legacy per-LINE usage
// history rewritten into per-MESSAGE rows without deleting the event log.
//
// Every assertion here is a way the rewrite's safety contract can silently
// break:
//   - a rewrite that loses events or rows (irreversible history loss)
//   - a rewrite that "fixes" a pair whose events were pruned (rows the log
//     can no longer rebuild would be gone forever)
//   - a rewrite trusting an edited transcript (silent repricing of history)
//   - a dry run that writes anyway
//   - an --apply that touches the default live store without --live —
//     including via env overrides that point right back at it
//   - a locked (SQLITE_BUSY) store flagging healthy pairs or losing their rows
//   - a stale usage_legacy_inflated issue surviving a successful rewrite
//   - two runs sharing one transcript merging across runs
//   - a re-run re-doing work (idempotency)
//
// Legacy fixtures: produced by ingesting a transcript whose lines DO carry
// message.id (modern ingest → per-message rows), then stripping `messageId`
// from the stored event payloads — the pre-B1 jsonLineEvents never emitted
// that key — and rebuilding the projection from the stripped events. The
// reproject then runs the legacy per-line branch (INSERT OR IGNORE,
// usage_id = hash(path:offset)), yielding per-line rows and per-line cost rows
// in exactly the shape the old code wrote. (Alternative considered: inserting
// legacy rows/events directly; rejected because the strip-and-reproject path
// exercises the real historical code branch instead of a hand-copied guess
// at its output.)

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  applyEvent,
  calculateCost,
  makeEvent,
  openTelemetryDb,
  reprojectEvents,
} from "./telemetry-store.mjs";
import { ingestTranscript } from "./telemetry-ingest.mjs";
import { rewriteUsageHistory } from "./telemetry-usage-rewrite.mjs";

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
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

function writeJsonl(path, lines) {
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
}

const MODEL = "foc381-model";
// Same deliberate non-round rates as telemetry-usage-message.test.mjs so a
// doubled or halved cost cannot masquerade as the correct one.
const PRICE_MAP = { [MODEL]: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: null } };
const REAL_USAGE = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 300, cache_creation_input_tokens: 40 };
const ZEROS_USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
// 100*1 + 50*2 + 300*0.1 + 40*1 (cacheWrite NULL falls back to the input rate).
const REAL_COST = calculateCost({
  inputTokens: 100, outputTokens: 50, cacheReadTokens: 300, cacheCreationTokens: 40,
}, MODEL, PRICE_MAP);
const REAL_TOKENS = 490; // 100 + 50 + 300 + 40

function assistantLine(messageId, usage, opts = {}) {
  const message = { model: opts.model || MODEL, usage };
  if (messageId != null) message.id = messageId;
  const line = {
    type: "assistant",
    timestamp: opts.timestamp || "2026-09-01T08:01:00.000Z",
    sessionId: "sess-1",
    message,
  };
  if (opts.agentKey) line.attributionAgent = opts.agentKey;
  return line;
}

function usageRows(db, runId) {
  return db.prepare("SELECT * FROM usage_facts WHERE run_id=? ORDER BY source_offset").all(runId);
}

function costSum(db, runId) {
  return db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM cost_facts WHERE run_id=?").get(runId).total;
}

function pairEvents(db, runId, sourcePath) {
  return db.prepare(
    "SELECT event_id, payload_json FROM events WHERE run_id=? AND source_path=? AND event_type='usage.recorded' ORDER BY source_offset",
  ).all(runId, sourcePath);
}

// Rebuild the exact legacy shape: strip messageId from the run's usage.recorded
// payloads, drop the projection, replay the legacy per-line branch. See the
// header comment for why this is the fixture-production method.
function legacyfy(db, runId) {
  const events = db.prepare(
    "SELECT event_id, payload_json FROM events WHERE run_id=? AND event_type='usage.recorded'",
  ).all(runId);
  for (const event of events) {
    const payload = JSON.parse(event.payload_json);
    delete payload.messageId;
    db.prepare("UPDATE events SET payload_json=? WHERE event_id=?").run(JSON.stringify(payload), event.event_id);
  }
  db.prepare("DELETE FROM usage_facts WHERE run_id=?").run(runId); // cost_facts cascades (FK ON)
  const summary = reprojectEvents(db, { runId, eventTypes: ["usage.recorded"] });
  if (summary.failed) throw new Error(`legacyfy reproject failed: ${summary.errors.join("; ")}`);
}

// Fresh isolated scenario: temp home + DB (env routed at it, so the ingest's
// internal recordToolFact and the rewrite's reportDataQuality both land in the
// same temp store), one run, session link, and a priced model in the run's
// snapshot.
function freshScenario(tag, squad = "dev") {
  const temp = mkdtempSync(join(tmpdir(), `telemetry-usage-rewrite-${tag}-`));
  const dbPath = join(temp, "telemetry.sqlite");
  const prevHome = process.env.LA_TELEMETRY_HOME;
  const prevDb = process.env.LA_TELEMETRY_DB;
  process.env.LA_TELEMETRY_HOME = temp;
  process.env.LA_TELEMETRY_DB = dbPath;
  const db = openTelemetryDb(dbPath);
  const transcript = join(temp, "lead.jsonl");
  const runId = `run-${tag}`;
  const startRun = (id, squadName, sessionId, transcriptPath) => {
    applyEvent(db, makeEvent("run.started", {
      runId: id, squad: squadName, startedAt: "2026-09-01T08:00:00.000Z", cwd: "C:/repos/office",
    }, { runId: id }));
    applyEvent(db, makeEvent("session.linked", {
      runId: id, sessionId, transcriptPath,
    }, { runId: id }));
    const psId = db.prepare("SELECT price_set_id FROM runs WHERE run_id=?").get(id).price_set_id;
    db.prepare(
      "INSERT OR REPLACE INTO model_prices (price_set_id, model_key, provider, input_price, output_price, cache_read_price) VALUES (?,?,?,?,?,?)",
    ).run(psId, MODEL, "openrouter", 1, 2, 0.1);
  };
  startRun(runId, squad, "sess-1", transcript);
  return {
    temp, db, dbPath, transcript, runId,
    addRun: (id, squadName, sessionId, transcriptPath) => startRun(id, squadName, sessionId, transcriptPath),
    restore() {
      db.close();
      process.env.LA_TELEMETRY_HOME = prevHome;
      process.env.LA_TELEMETRY_DB = prevDb;
      try { rmSync(temp, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

async function run() {
  await test("happy path: one message over 3 identical-usage lines → 3 legacy rows become 1 message row, events gain messageId only", async () => {
    const s = freshScenario("merge3");
    try {
      writeJsonl(s.transcript, [
        assistantLine("msg_1", REAL_USAGE, { timestamp: "2026-09-01T08:01:00.000Z" }),
        assistantLine("msg_1", REAL_USAGE, { timestamp: "2026-09-01T08:01:05.000Z" }),
        assistantLine("msg_1", REAL_USAGE, { timestamp: "2026-09-01T08:01:10.000Z" }),
      ]);
      await ingestTranscript(s.db, s.runId, s.transcript, "sess-1");
      legacyfy(s.db, s.runId);
      assertEqual(usageRows(s.db, s.runId).length, 3, "legacy fixture must be 3 per-line rows");
      const payloadsBefore = new Map(pairEvents(s.db, s.runId, s.transcript)
        .map((event) => [event.event_id, JSON.parse(event.payload_json)]));

      const summary = rewriteUsageHistory(s.db, { dryRun: false });
      assertEqual(summary.pairs.total, 1, "one unit of work");
      assertEqual(summary.pairs.rewritten, 1, "pair rewritten");
      assertEqual(summary.pairs.skippedTotal, 0, "nothing skipped");
      assertEqual(summary.issues.runsFlagged, 0, "no issue for a fully rewritten run");

      const rows = usageRows(s.db, s.runId);
      assertEqual(rows.length, 1, "one merged usage row");
      assertEqual(rows[0].message_id, "msg_1", "message_id stored");
      assertEqual(rows[0].input_tokens, 100, "input_tokens");
      assertEqual(rows[0].output_tokens, 50, "output_tokens");
      assertEqual(rows[0].cache_read_tokens, 300, "cache_read_tokens");
      assertEqual(rows[0].cache_creation_tokens, 40, "cache_creation_tokens");
      assert(Math.abs(costSum(s.db, s.runId) - REAL_COST) < 1e-9,
        `cost of ONE copy expected ${REAL_COST}, got ${costSum(s.db, s.runId)}`);

      const eventsAfter = pairEvents(s.db, s.runId, s.transcript);
      assertEqual(eventsAfter.length, payloadsBefore.size, "event count unchanged — log never deleted");
      for (const event of eventsAfter) {
        const after = JSON.parse(event.payload_json);
        assertEqual(after.messageId, "msg_1", "every event payload carries messageId");
        const before = payloadsBefore.get(event.event_id);
        const { messageId, ...rest } = after;
        assertEqual(JSON.stringify(rest), JSON.stringify(before), "only the messageId key was added");
      }

      assertEqual(summary.usageRows.before, 3, "summary rows before");
      assertEqual(summary.usageRows.after, 1, "summary rows after");
      assertEqual(summary.tokens.before, 3 * REAL_TOKENS, "summary tokens before (3 lines)");
      assertEqual(summary.tokens.after, REAL_TOKENS, "summary tokens after (one copy)");
      assert(Math.abs(summary.cost.before - 3 * REAL_COST) < 1e-9, "summary cost before");
      assert(Math.abs(summary.cost.after - REAL_COST) < 1e-9, "summary cost after");
    } finally {
      s.restore();
    }
  });

  await test("zeros line + real line of one message → after: real counters", async () => {
    const s = freshScenario("zeros");
    try {
      writeJsonl(s.transcript, [
        assistantLine("msg_z", ZEROS_USAGE, { timestamp: "2026-09-01T08:01:00.000Z" }),
        assistantLine("msg_z", REAL_USAGE, { timestamp: "2026-09-01T08:01:05.000Z" }),
      ]);
      await ingestTranscript(s.db, s.runId, s.transcript, "sess-1");
      legacyfy(s.db, s.runId);
      assertEqual(usageRows(s.db, s.runId).length, 2, "legacy fixture: zeros row + real row");

      const summary = rewriteUsageHistory(s.db, { dryRun: false });
      assertEqual(summary.pairs.rewritten, 1, "pair rewritten");
      const rows = usageRows(s.db, s.runId);
      assertEqual(rows.length, 1, "one merged usage row");
      assertEqual(rows[0].input_tokens, 100, "input_tokens is the real line's");
      assertEqual(rows[0].output_tokens, 50, "output_tokens is the real line's");
      assertEqual(rows[0].cache_read_tokens, 300, "cache_read_tokens");
      assertEqual(rows[0].cache_creation_tokens, 40, "cache_creation_tokens");
      assert(Math.abs(costSum(s.db, s.runId) - REAL_COST) < 1e-9, "cost of one copy");
    } finally {
      s.restore();
    }
  });

  await test("pruned: one event of the pair deleted → skipped events_pruned, rows untouched, usage_legacy_inflated raised", async () => {
    const s = freshScenario("pruned");
    try {
      writeJsonl(s.transcript, [
        assistantLine("msg_p", REAL_USAGE, { timestamp: "2026-09-01T08:01:00.000Z" }),
        assistantLine("msg_p", REAL_USAGE, { timestamp: "2026-09-01T08:01:05.000Z" }),
      ]);
      await ingestTranscript(s.db, s.runId, s.transcript, "sess-1");
      legacyfy(s.db, s.runId);
      const rowsBefore = usageRows(s.db, s.runId);
      assertEqual(rowsBefore.length, 2, "legacy fixture: 2 per-line rows");
      // Simulate telemetry-prune.mjs having removed one event row.
      s.db.prepare(
        "DELETE FROM events WHERE run_id=? AND source_path=? AND event_type='usage.recorded' AND source_offset=?",
      ).run(s.runId, s.transcript, rowsBefore[0].source_offset);

      const summary = rewriteUsageHistory(s.db, { dryRun: false });
      assertEqual(summary.pairs.total, 1, "one unit of work");
      assertEqual(summary.pairs.rewritten, 0, "nothing rewritten");
      assertEqual(summary.pairs.skipped.events_pruned, 1, "skipped as events_pruned");
      const rowsAfter = usageRows(s.db, s.runId);
      assertEqual(rowsAfter.length, 2, "rows untouched");
      assertEqual(JSON.stringify(rowsAfter), JSON.stringify(rowsBefore), "rows byte-identical to before");

      const issue = s.db.prepare(
        "SELECT details_json FROM data_quality_issues WHERE run_id=? AND issue_type='usage_legacy_inflated' AND resolved_at IS NULL",
      ).get(s.runId);
      assert(issue, "usage_legacy_inflated issue raised");
      const details = JSON.parse(issue.details_json);
      assertEqual(details.reasons.events_pruned, 1, "issue reasons count");
      assertEqual(details.rows, 2, "issue carries the affected legacy row count");
      assert(details.sources.includes(s.transcript), "issue carries the affected source");
      assertEqual(summary.issues.runsFlagged, 1, "summary counts the flag");
    } finally {
      s.restore();
    }
  });

  await test("transcript missing → skipped transcript_missing, flagged", async () => {
    const s = freshScenario("missing");
    try {
      writeJsonl(s.transcript, [
        assistantLine("msg_m", REAL_USAGE, { timestamp: "2026-09-01T08:01:00.000Z" }),
      ]);
      await ingestTranscript(s.db, s.runId, s.transcript, "sess-1");
      legacyfy(s.db, s.runId);
      const rowsBefore = JSON.stringify(usageRows(s.db, s.runId));
      rmSync(s.transcript, { force: true });

      const summary = rewriteUsageHistory(s.db, { dryRun: false });
      assertEqual(summary.pairs.skipped.transcript_missing, 1, "skipped as transcript_missing");
      assertEqual(summary.pairs.rewritten, 0, "nothing rewritten");
      assertEqual(JSON.stringify(usageRows(s.db, s.runId)), rowsBefore, "rows untouched");
      const issue = s.db.prepare(
        "SELECT 1 FROM data_quality_issues WHERE run_id=? AND issue_type='usage_legacy_inflated' AND resolved_at IS NULL",
      ).get(s.runId);
      assert(issue, "usage_legacy_inflated issue raised");
    } finally {
      s.restore();
    }
  });

  await test("counter mismatch at an offset → skipped unverifiable, rows untouched", async () => {
    const s = freshScenario("mismatch");
    try {
      writeJsonl(s.transcript, [
        assistantLine("msg_v", REAL_USAGE, { timestamp: "2026-09-01T08:01:00.000Z" }),
        assistantLine("msg_v", REAL_USAGE, { timestamp: "2026-09-01T08:01:05.000Z" }),
      ]);
      await ingestTranscript(s.db, s.runId, s.transcript, "sess-1");
      legacyfy(s.db, s.runId);
      const rowsBefore = JSON.stringify(usageRows(s.db, s.runId));
      // Simulate a transcript edited after ingest: one event's counters no
      // longer match the line it points at.
      const event = s.db.prepare(
        "SELECT event_id, payload_json FROM events WHERE run_id=? AND source_path=? AND event_type='usage.recorded' ORDER BY source_offset LIMIT 1",
      ).get(s.runId, s.transcript);
      const payload = JSON.parse(event.payload_json);
      payload.inputTokens = 999;
      s.db.prepare("UPDATE events SET payload_json=? WHERE event_id=?").run(JSON.stringify(payload), event.event_id);

      const summary = rewriteUsageHistory(s.db, { dryRun: false });
      assertEqual(summary.pairs.skipped.unverifiable, 1, "skipped as unverifiable");
      assertEqual(summary.pairs.rewritten, 0, "nothing rewritten");
      assertEqual(JSON.stringify(usageRows(s.db, s.runId)), rowsBefore, "rows untouched");
      const issue = s.db.prepare(
        "SELECT 1 FROM data_quality_issues WHERE run_id=? AND issue_type='usage_legacy_inflated' AND resolved_at IS NULL",
      ).get(s.runId);
      assert(issue, "usage_legacy_inflated issue raised");
    } finally {
      s.restore();
    }
  });

  await test("SQLITE_BUSY on the pair transaction → skipped busy, no issue raised, rows intact, re-run rewrites", async () => {
    const s = freshScenario("busy");
    try {
      writeJsonl(s.transcript, [
        assistantLine("msg_b", REAL_USAGE, { timestamp: "2026-09-01T08:01:00.000Z" }),
        assistantLine("msg_b", REAL_USAGE, { timestamp: "2026-09-01T08:01:05.000Z" }),
      ]);
      await ingestTranscript(s.db, s.runId, s.transcript, "sess-1");
      legacyfy(s.db, s.runId);
      const rowsBefore = JSON.stringify(usageRows(s.db, s.runId));
      assertEqual(usageRows(s.db, s.runId).length, 2, "legacy fixture: 2 per-line rows");

      // Simulate the telemetry server holding the write lock: BEGIN IMMEDIATE
      // on a second connection, and a SHORT busy_timeout on the rewrite
      // connection so BEGIN IMMEDIATE gives up fast instead of stalling 30 s.
      // A lock must not be mistaken for a broken pair — the pair is healthy,
      // just busy right now.
      const holder = new DatabaseSync(s.dbPath);
      holder.exec("BEGIN IMMEDIATE");
      s.db.exec("PRAGMA busy_timeout = 100;");
      const summary = rewriteUsageHistory(s.db, { dryRun: false });
      holder.exec("ROLLBACK");
      holder.close();

      assertEqual(summary.pairs.total, 1, "one unit of work");
      assertEqual(summary.pairs.rewritten, 0, "nothing rewritten while locked");
      assertEqual(summary.pairs.eligible, 0, "a failed pair must NOT also count as eligible");
      assertEqual(summary.pairs.skipped.busy, 1, "skipped as busy, not reproject_failed");
      assertEqual(summary.pairs.skipped.reproject_failed, 0, "a lock is not a reprojection failure");
      assertEqual(JSON.stringify(usageRows(s.db, s.runId)), rowsBefore, "rows byte-identical to before");
      const issue = s.db.prepare(
        "SELECT 1 FROM data_quality_issues WHERE run_id=? AND issue_type='usage_legacy_inflated' AND resolved_at IS NULL",
      ).get(s.runId);
      assert(!issue, "a locked database must not flag a healthy pair as inflated");

      // Once the lock is gone the SAME pair rewrites cleanly — busy is
      // transient by definition, nothing was permanently consumed.
      const rerun = rewriteUsageHistory(s.db, { dryRun: false });
      assertEqual(rerun.pairs.rewritten, 1, "re-run rewrites the pair");
      assertEqual(rerun.pairs.skippedTotal, 0, "nothing skipped on the re-run");
      const rows = usageRows(s.db, s.runId);
      assertEqual(rows.length, 1, "one per-message row");
      assertEqual(rows[0].message_id, "msg_b", "message_id stored");
    } finally {
      s.restore();
    }
  });

  await test("a run flagged earlier, later fully rewritten → open usage_legacy_inflated issue resolved", async () => {
    const s = freshScenario("resolve");
    try {
      writeJsonl(s.transcript, [
        assistantLine("msg_res", REAL_USAGE, { timestamp: "2026-09-01T08:01:00.000Z" }),
      ]);
      await ingestTranscript(s.db, s.runId, s.transcript, "sess-1");
      legacyfy(s.db, s.runId);

      // First pass: the transcript is gone → the run is flagged.
      rmSync(s.transcript, { force: true });
      let summary = rewriteUsageHistory(s.db, { dryRun: false });
      assertEqual(summary.pairs.skipped.transcript_missing, 1, "flagged while the transcript was gone");
      assertEqual(summary.issues.runsFlagged, 1, "summary counts the flag");
      const open = s.db.prepare(
        "SELECT 1 FROM data_quality_issues WHERE run_id=? AND issue_type='usage_legacy_inflated' AND resolved_at IS NULL",
      ).get(s.runId);
      assert(open, "issue open after the failed pass");

      // The transcript reappears (restored backup / resurfaced archive): the
      // next pass rewrites the pair and must also close the stale issue —
      // the run no longer holds any message_id IS NULL row.
      writeJsonl(s.transcript, [
        assistantLine("msg_res", REAL_USAGE, { timestamp: "2026-09-01T08:01:00.000Z" }),
      ]);
      summary = rewriteUsageHistory(s.db, { dryRun: false });
      assertEqual(summary.pairs.rewritten, 1, "pair rewritten");
      assertEqual(summary.issues.runsResolved, 1, "summary counts the resolve");
      const stillOpen = s.db.prepare(
        "SELECT 1 FROM data_quality_issues WHERE run_id=? AND issue_type='usage_legacy_inflated' AND resolved_at IS NULL",
      ).get(s.runId);
      assert(!stillOpen, "issue resolved after the run's pairs were all rewritten");
      const resolved = s.db.prepare(
        "SELECT resolved_at FROM data_quality_issues WHERE run_id=? AND issue_type='usage_legacy_inflated'",
      ).get(s.runId);
      assert(resolved?.resolved_at, "resolved_at is stamped (through the store's resolve path)");
      assertEqual(usageRows(s.db, s.runId).length, 1, "one per-message row");
    } finally {
      s.restore();
    }
  });

  await test("two runs sharing one transcript → each run rewritten separately, never merged across runs", async () => {
    const s = freshScenario("tworuns");
    try {
      const run2 = "run-tworuns-2";
      s.addRun(run2, "dev", "sess-1", s.transcript);
      writeJsonl(s.transcript, [
        assistantLine("msg_shared", REAL_USAGE, { timestamp: "2026-09-01T08:01:00.000Z" }),
        assistantLine("msg_shared", REAL_USAGE, { timestamp: "2026-09-01T08:01:05.000Z" }),
      ]);
      await ingestTranscript(s.db, s.runId, s.transcript, "sess-1");
      await ingestTranscript(s.db, run2, s.transcript, "sess-1");
      legacyfy(s.db, s.runId);
      legacyfy(s.db, run2);
      assertEqual(usageRows(s.db, s.runId).length, 2, "run-1 legacy rows");
      assertEqual(usageRows(s.db, run2).length, 2, "run-2 legacy rows");

      const summary = rewriteUsageHistory(s.db, { dryRun: false });
      assertEqual(summary.pairs.total, 2, "two pairs: one per (run, path)");
      assertEqual(summary.pairs.rewritten, 2, "both rewritten");
      assertEqual(usageRows(s.db, s.runId).length, 1, "run-1 has one row");
      assertEqual(usageRows(s.db, run2).length, 1, "run-2 has one row");
      assertEqual(usageRows(s.db, s.runId)[0].usage_id, usageRows(s.db, run2)[0].usage_id,
        "same usage_id (path+messageId) but run-scoped rows");
      assert(Math.abs(costSum(s.db, s.runId) - REAL_COST) < 1e-9, "run-1 cost of one copy");
      assert(Math.abs(costSum(s.db, run2) - REAL_COST) < 1e-9, "run-2 cost of one copy");
    } finally {
      s.restore();
    }
  });

  await test("idempotent second run → zero pairs, nothing changes, no new issues", async () => {
    const s = freshScenario("idem");
    try {
      writeJsonl(s.transcript, [
        assistantLine("msg_i", REAL_USAGE, { timestamp: "2026-09-01T08:01:00.000Z" }),
        assistantLine("msg_i", REAL_USAGE, { timestamp: "2026-09-01T08:01:05.000Z" }),
      ]);
      await ingestTranscript(s.db, s.runId, s.transcript, "sess-1");
      legacyfy(s.db, s.runId);
      rewriteUsageHistory(s.db, { dryRun: false });
      const rowsSnapshot = JSON.stringify(usageRows(s.db, s.runId));
      const issuesBefore = s.db.prepare("SELECT COUNT(*) AS n FROM data_quality_issues").get().n;

      const summary = rewriteUsageHistory(s.db, { dryRun: false });
      assertEqual(summary.pairs.total, 0, "no legacy rows left → no units of work");
      assertEqual(summary.pairs.rewritten, 0, "nothing rewritten");
      assertEqual(JSON.stringify(usageRows(s.db, s.runId)), rowsSnapshot, "rows unchanged");
      assertEqual(s.db.prepare("SELECT COUNT(*) AS n FROM data_quality_issues").get().n, issuesBefore,
        "no new issues");
    } finally {
      s.restore();
    }
  });

  await test("dry run writes nothing (rows, payloads, issues identical) but reports eligibility", async () => {
    const s = freshScenario("dryrun");
    try {
      writeJsonl(s.transcript, [
        assistantLine("msg_d", REAL_USAGE, { timestamp: "2026-09-01T08:01:00.000Z" }),
        assistantLine("msg_d", REAL_USAGE, { timestamp: "2026-09-01T08:01:05.000Z" }),
      ]);
      await ingestTranscript(s.db, s.runId, s.transcript, "sess-1");
      legacyfy(s.db, s.runId);
      const rowsBefore = JSON.stringify(usageRows(s.db, s.runId));
      const payloadsBefore = JSON.stringify(pairEvents(s.db, s.runId, s.transcript));
      const issuesBefore = s.db.prepare("SELECT COUNT(*) AS n FROM data_quality_issues").get().n;

      const summary = rewriteUsageHistory(s.db, { dryRun: true });
      assertEqual(summary.pairs.total, 1, "one unit of work found");
      assertEqual(summary.pairs.eligible, 1, "pair would be rewritten");
      assertEqual(summary.pairs.rewritten, 0, "dry run rewrites nothing");
      assertEqual(summary.usageRows.after, null, "dry run reports no after state");
      assertEqual(summary.issues.runsFlagged, 0, "dry run raises no issues");

      assertEqual(JSON.stringify(usageRows(s.db, s.runId)), rowsBefore, "usage rows identical");
      assertEqual(JSON.stringify(pairEvents(s.db, s.runId, s.transcript)), payloadsBefore, "event payloads identical");
      assertEqual(s.db.prepare("SELECT COUNT(*) AS n FROM data_quality_issues").get().n, issuesBefore,
        "issues identical");
    } finally {
      s.restore();
    }
  });

  await test("--apply refused against the default live path without --live (exit 2, no DB created)", async () => {
    const localAppData = mkdtempSync(join(tmpdir(), "telemetry-usage-rewrite-cli-"));
    try {
      const script = fileURLToPath(new URL("./telemetry-usage-rewrite.mjs", import.meta.url));
      const env = { ...process.env };
      // No LA_TELEMETRY_HOME / LA_TELEMETRY_DB: the resolved path IS the
      // default live store, here redirected into a throwaway LOCALAPPDATA so
      // nothing real is ever touched.
      delete env.LA_TELEMETRY_HOME;
      delete env.LA_TELEMETRY_DB;
      env.LOCALAPPDATA = localAppData;

      const result = spawnSync(process.execPath, [script, "--apply"], { env, encoding: "utf8" });
      assertEqual(result.status, 2, `exit code 2 (stderr: ${result.stderr})`);
      assert(result.stderr.includes("REFUSING"), "refusal message explains why");
      assert(!existsSync(join(localAppData, "linear-agents", "telemetry", "telemetry.sqlite")),
        "no DB file may be created when the rewrite refuses");
    } finally {
      rmSync(localAppData, { recursive: true, force: true });
    }
  });

  await test("--apply with env overrides pointing AT the default live path → still refused (guard decides by path, not env)", async () => {
    const localAppData = mkdtempSync(join(tmpdir(), "telemetry-usage-rewrite-cli2-"));
    try {
      const script = fileURLToPath(new URL("./telemetry-usage-rewrite.mjs", import.meta.url));
      const liveDefault = join(localAppData, "linear-agents", "telemetry", "telemetry.sqlite");
      const env = { ...process.env, LOCALAPPDATA: localAppData };
      delete env.LA_TELEMETRY_HOME;
      delete env.LA_TELEMETRY_DB;

      // LA_TELEMETRY_DB aimed straight at the default live store: the old
      // guard treated "an env var is set" as "not the live store" and let it
      // through — the decision must be WHERE the path leads.
      env.LA_TELEMETRY_DB = liveDefault;
      const viaDb = spawnSync(process.execPath, [script, "--apply"], { env, encoding: "utf8" });
      assertEqual(viaDb.status, 2, `exit code 2 (stderr: ${viaDb.stderr})`);
      assert(viaDb.stderr.includes("REFUSING"), "refusal message explains why");

      // The same store reached through LA_TELEMETRY_HOME.
      delete env.LA_TELEMETRY_DB;
      env.LA_TELEMETRY_HOME = dirname(liveDefault);
      const viaHome = spawnSync(process.execPath, [script, "--apply"], { env, encoding: "utf8" });
      assertEqual(viaHome.status, 2, `exit code 2 (stderr: ${viaHome.stderr})`);

      // win32 paths are case-insensitive: a differently-cased target is the
      // same file and must refuse exactly the same way.
      if (process.platform === "win32") {
        delete env.LA_TELEMETRY_HOME;
        env.LA_TELEMETRY_DB = liveDefault.toUpperCase();
        const viaCase = spawnSync(process.execPath, [script, "--apply"], { env, encoding: "utf8" });
        assertEqual(viaCase.status, 2, `exit code 2 for a case variant (stderr: ${viaCase.stderr})`);
      }
      assert(!existsSync(liveDefault), "no DB file may be created when the rewrite refuses");
    } finally {
      rmSync(localAppData, { recursive: true, force: true });
    }
  });

  await test("--apply with LA_TELEMETRY_DB at a non-default temp path → allowed (copy store is a legitimate target)", async () => {
    const localAppData = mkdtempSync(join(tmpdir(), "telemetry-usage-rewrite-cli3-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "telemetry-usage-rewrite-cli4-"));
    try {
      const script = fileURLToPath(new URL("./telemetry-usage-rewrite.mjs", import.meta.url));
      const dbPath = join(elsewhere, "copy.sqlite");
      const env = { ...process.env, LOCALAPPDATA: localAppData, LA_TELEMETRY_DB: dbPath };
      delete env.LA_TELEMETRY_HOME;

      // A path that is NOT the default live location must proceed: an
      // operator's VACUUM INTO copy is exactly the workflow this guard exists
      // to keep usable.
      const result = spawnSync(process.execPath, [script, "--apply"], { env, encoding: "utf8" });
      assertEqual(result.status, 0, `expected exit 0 on a copy store (stderr: ${result.stderr})`);
      assert(existsSync(dbPath), "the CLI proceeded: the copy store was opened");
    } finally {
      rmSync(localAppData, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  await test("per-squad token summary before/after correct on a two-squad fixture", async () => {
    const s = freshScenario("squad-dev", "dev");
    try {
      const run2 = "run-squad-review";
      const transcript2 = join(s.temp, "lead2.jsonl");
      s.addRun(run2, "review", "sess-2", transcript2);
      writeJsonl(s.transcript, [
        assistantLine("msg_a", REAL_USAGE, { timestamp: "2026-09-01T08:01:00.000Z" }),
        assistantLine("msg_a", REAL_USAGE, { timestamp: "2026-09-01T08:01:05.000Z" }),
      ]);
      writeJsonl(transcript2, [
        assistantLine("msg_b", REAL_USAGE, { timestamp: "2026-09-01T08:02:00.000Z" }),
        assistantLine("msg_b", REAL_USAGE, { timestamp: "2026-09-01T08:02:05.000Z" }),
        assistantLine("msg_b", REAL_USAGE, { timestamp: "2026-09-01T08:02:10.000Z" }),
      ]);
      await ingestTranscript(s.db, s.runId, s.transcript, "sess-1");
      await ingestTranscript(s.db, run2, transcript2, "sess-2");
      legacyfy(s.db, s.runId);
      legacyfy(s.db, run2);

      const summary = rewriteUsageHistory(s.db, { dryRun: false });
      assertEqual(summary.pairs.total, 2, "two pairs, one per run+transcript");
      assertEqual(summary.pairs.rewritten, 2, "both rewritten");
      assertEqual(summary.tokens.before, 5 * REAL_TOKENS, "overall tokens before (2+3 lines)");
      assertEqual(summary.tokens.after, 2 * REAL_TOKENS, "overall tokens after (one copy per message)");
      assertEqual(summary.tokens.bySquad.dev.before, 2 * REAL_TOKENS, "dev tokens before");
      assertEqual(summary.tokens.bySquad.dev.after, REAL_TOKENS, "dev tokens after");
      assertEqual(summary.tokens.bySquad.review.before, 3 * REAL_TOKENS, "review tokens before");
      assertEqual(summary.tokens.bySquad.review.after, REAL_TOKENS, "review tokens after");
    } finally {
      s.restore();
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) console.log(failures.join("\n"));
  process.exit(failed ? 1 : 0);
}

run().catch((error) => { console.error(error); process.exit(1); });
