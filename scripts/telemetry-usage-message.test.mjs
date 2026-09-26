// Contract test for FOC-381 (B): usage_facts keyed per assistant MESSAGE, not
// per transcript line.
//
// Claude Code writes one assistant message as several JSONL lines (thinking /
// text / tool_use), each repeating the same message.usage object — or zeros on
// some lines. The events keep their per-line identity (B1); the projection
// merges them into one usage_facts row via message.id (B2), with MAX() per
// counter so the merge is idempotent and order-independent.
//
// Every assertion here is a way that intent can silently break:
//   - counting one message as several rows (the ~2.1x over-count this fixes)
//   - an explicit payload.usageId re-keying one message into N rows that
//     verify would still pass
//   - a zeros line lowering or freezing a real counter (frozen-partial bug)
//   - a reproject replay diverging from the incremental ingest result
//   - two runs sharing one transcript merging into one row (ADR-0008 scope)
//   - a legacy per-line row squatting an offset throwing mid-batch
//   - lines without message.id changing behaviour (must stay legacy)
//   - the v8 migration not adding (or re-adding) message_id

import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  applyEvent,
  calculateCost,
  dropCanonicalViews,
  makeEvent,
  MIGRATION_VERSIONS,
  openTelemetryDb,
  reprojectEvents,
} from "./telemetry-store.mjs";
import { ingestTranscript } from "./telemetry-ingest.mjs";

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

function appendJsonl(path, lines) {
  appendFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
}

const MODEL = "foc381-model";
// Deliberate, non-round rates so a doubled or halved cost cannot masquerade as
// the correct one. cache_write_price stays NULL: the writer must fall back to
// the input rate (1), which the expected-cost helper below encodes too.
const PRICE_MAP = { [MODEL]: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: null } };

// The one-copy cost the projection must produce for a merged message row —
// never N copies, never the zeros of a partial write.
function oneCopyCost(usage) {
  const cost = calculateCost(usage, MODEL, PRICE_MAP);
  assert(cost != null, "fixture model must be priced");
  return cost;
}

const REAL_USAGE = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 300, cache_creation_input_tokens: 40 };
const REAL_COST = oneCopyCost({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 300, cacheCreationTokens: 40 });
const ZEROS_USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

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

function messageUsageId(transcriptPath, messageId) {
  // Mirrors applyUsageRecorded: event.source.path is the canonicalized
  // (resolve()d) transcript path, hashed as `${path}:msg:${messageId}`.
  return createHash("sha256").update(`${resolve(transcriptPath)}:msg:${messageId}`).digest("hex");
}

function lineUsageId(transcriptPath, offset) {
  return createHash("sha256").update(`${resolve(transcriptPath)}:${offset}`).digest("hex");
}

function usageRows(db, runId) {
  return db.prepare("SELECT * FROM usage_facts WHERE run_id=? ORDER BY source_offset").all(runId);
}

function costRow(db, runId, usageId) {
  return db.prepare("SELECT cost_usd FROM cost_facts WHERE run_id=? AND usage_id=?").get(runId, usageId);
}

// Fresh isolated scenario: temp home + DB, env routed at it (ingestTranscript's
// internal recordToolFact opens the DB via the env default), one run linked to
// a transcript, and a deterministic price row for MODEL in the run's snapshot.
function freshScenario(tag) {
  const temp = mkdtempSync(join(tmpdir(), `telemetry-usage-msg-${tag}-`));
  const dbPath = join(temp, "telemetry.sqlite");
  const prevHome = process.env.LA_TELEMETRY_HOME;
  const prevDb = process.env.LA_TELEMETRY_DB;
  process.env.LA_TELEMETRY_HOME = temp;
  process.env.LA_TELEMETRY_DB = dbPath;
  const db = openTelemetryDb(dbPath);
  const transcript = join(temp, "lead.jsonl");
  const runId = `run-${tag}`;
  applyEvent(db, makeEvent("run.started", {
    runId, squad: "dev", startedAt: "2026-09-01T08:00:00.000Z", cwd: "C:/repos/office",
  }, { runId }));
  applyEvent(db, makeEvent("session.linked", {
    runId, sessionId: "sess-1", transcriptPath: transcript,
  }, { runId }));
  // run.started resolved the run's price set (ensurePriceSet); pin MODEL's
  // rates inside it so the writer's loadPriceSet sees exactly PRICE_MAP.
  const psId = db.prepare("SELECT price_set_id FROM runs WHERE run_id=?").get(runId).price_set_id;
  db.prepare(
    "INSERT OR REPLACE INTO model_prices (price_set_id, model_key, provider, input_price, output_price, cache_read_price) VALUES (?,?,?,?,?,?)",
  ).run(psId, MODEL, "openrouter", 1, 2, 0.1);
  return {
    temp, db, dbPath, transcript, runId,
    restore() {
      db.close();
      process.env.LA_TELEMETRY_HOME = prevHome;
      process.env.LA_TELEMETRY_DB = prevDb;
      try { rmSync(temp, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

async function run() {
  await test("one message over 3 identical-usage lines → exactly 1 usage row, cost of one copy", async () => {
    const s = freshScenario("merge3");
    try {
      writeJsonl(s.transcript, [
        assistantLine("msg_1", REAL_USAGE, { timestamp: "2026-09-01T08:01:00.000Z" }),
        assistantLine("msg_1", REAL_USAGE, { timestamp: "2026-09-01T08:01:05.000Z" }),
        assistantLine("msg_1", REAL_USAGE, { timestamp: "2026-09-01T08:01:10.000Z" }),
      ]);
      const result = await ingestTranscript(s.db, s.runId, s.transcript, "sess-1");
      assertEqual(usageRows(s.db, s.runId).length, 1, "usage_facts rows for one message");
      const row = usageRows(s.db, s.runId)[0];
      assertEqual(row.usage_id, messageUsageId(s.transcript, "msg_1"), "usage_id = hash(path:msg:messageId)");
      assertEqual(row.message_id, "msg_1", "message_id stored");
      assertEqual(row.input_tokens, 100, "input_tokens");
      assertEqual(row.output_tokens, 50, "output_tokens");
      assertEqual(row.cache_read_tokens, 300, "cache_read_tokens");
      assertEqual(row.cache_creation_tokens, 40, "cache_creation_tokens");
      const cost = costRow(s.db, s.runId, row.usage_id);
      assert(cost != null, "cost_facts row missing");
      assert(Math.abs(cost.cost_usd - REAL_COST) < 1e-12, `cost of ONE copy expected ${REAL_COST}, got ${cost.cost_usd}`);
      assert(result.events > 0, "events were applied");
    } finally {
      s.restore();
    }
  });

  await test("explicit payload.usageId never overrides per-message identity: 3 lines, 3 different usageIds → one row", async () => {
    const s = freshScenario("usageid");
    try {
      // Three lines of ONE message, each carrying a DIFFERENT explicit
      // usageId — honouring it would re-key every line into its own row (N
      // rows per message) while verify still passes on the MAX. The identity
      // must be the message hash regardless.
      const lines = [
        { usage: REAL_USAGE, ts: "2026-09-01T08:01:00.000Z", offset: 0 },
        { usage: ZEROS_USAGE, ts: "2026-09-01T08:01:05.000Z", offset: 500 },
        { usage: REAL_USAGE, ts: "2026-09-01T08:01:10.000Z", offset: 900 },
      ];
      lines.forEach((line, i) => {
        applyEvent(s.db, makeEvent("usage.recorded", {
          runId: s.runId, sessionId: "sess-1", messageId: "msg_u", usageId: `explicit-${i}`,
          agentKey: "_lead", model: MODEL, observedAt: line.ts,
          inputTokens: line.usage.input_tokens, outputTokens: line.usage.output_tokens,
          cacheReadTokens: line.usage.cache_read_input_tokens, cacheCreationTokens: line.usage.cache_creation_input_tokens,
        }, { runId: s.runId, sourcePath: s.transcript, sourceOffset: line.offset }));
      });
      const rows = usageRows(s.db, s.runId);
      assertEqual(rows.length, 1, "exactly one row per message regardless of explicit usageIds");
      assertEqual(rows[0].usage_id, messageUsageId(s.transcript, "msg_u"), "usage_id is the message hash, never payload.usageId");
      assertEqual(rows[0].message_id, "msg_u", "message_id stored");
      assertEqual(rows[0].input_tokens, 100, "counters merged from the real lines (MAX)");
      assertEqual(rows[0].output_tokens, 50, "output_tokens merged");
      const cost = costRow(s.db, s.runId, rows[0].usage_id);
      assert(Math.abs(cost.cost_usd - REAL_COST) < 1e-12, `cost of ONE copy expected ${REAL_COST}, got ${cost.cost_usd}`);
    } finally {
      s.restore();
    }
  });

  await test("zeros line then real line in the SAME pass → real counters", async () => {
    const s = freshScenario("zerofirst");
    try {
      writeJsonl(s.transcript, [
        assistantLine("msg_z", ZEROS_USAGE, { timestamp: "2026-09-01T08:01:00.000Z" }),
        assistantLine("msg_z", REAL_USAGE, { timestamp: "2026-09-01T08:01:05.000Z" }),
      ]);
      await ingestTranscript(s.db, s.runId, s.transcript, "sess-1");
      const rows = usageRows(s.db, s.runId);
      assertEqual(rows.length, 1, "usage_facts rows");
      assertEqual(rows[0].input_tokens, 100, "input_tokens must be the real line's, not MAX-frozen zeros");
      assertEqual(rows[0].output_tokens, 50, "output_tokens");
      const cost = costRow(s.db, s.runId, rows[0].usage_id);
      assert(Math.abs(cost.cost_usd - REAL_COST) < 1e-12, `cost expected ${REAL_COST}, got ${cost.cost_usd}`);
    } finally {
      s.restore();
    }
  });

  await test("two ingest passes: zeros first, real appended later → row grows to real counters (frozen-partial regression)", async () => {
    const s = freshScenario("twopass");
    try {
      writeJsonl(s.transcript, [
        assistantLine("msg_p", ZEROS_USAGE, { timestamp: "2026-09-01T08:01:00.000Z" }),
      ]);
      await ingestTranscript(s.db, s.runId, s.transcript, "sess-1");
      let rows = usageRows(s.db, s.runId);
      assertEqual(rows.length, 1, "usage_facts rows after pass 1");
      assertEqual(rows[0].input_tokens, 0, "pass-1 counters are zeros");
      assertEqual(costRow(s.db, s.runId, rows[0].usage_id).cost_usd, 0, "pass-1 cost is zero");

      // Pass 2: the real line arrives late (late flush / second ingest cycle).
      appendJsonl(s.transcript, [
        assistantLine("msg_p", REAL_USAGE, { timestamp: "2026-09-01T08:02:00.000Z" }),
      ]);
      const result = await ingestTranscript(s.db, s.runId, s.transcript, "sess-1");
      assert(result.events > 0, "pass-2 appended line was applied");
      rows = usageRows(s.db, s.runId);
      assertEqual(rows.length, 1, "still exactly one row after pass 2");
      assertEqual(rows[0].input_tokens, 100, "input_tokens merged to the real value");
      assertEqual(rows[0].output_tokens, 50, "output_tokens merged to the real value");
      assertEqual(rows[0].cache_read_tokens, 300, "cache_read_tokens merged");
      assertEqual(rows[0].cache_creation_tokens, 40, "cache_creation_tokens merged");
      const cost = costRow(s.db, s.runId, rows[0].usage_id);
      assert(Math.abs(cost.cost_usd - REAL_COST) < 1e-12, `cost repriced to ${REAL_COST}, got ${cost.cost_usd}`);
    } finally {
      s.restore();
    }
  });

  await test("real line first, zeros line later → counters stay real", async () => {
    const s = freshScenario("realfirst");
    try {
      writeJsonl(s.transcript, [
        assistantLine("msg_r", REAL_USAGE, { timestamp: "2026-09-01T08:01:00.000Z" }),
      ]);
      await ingestTranscript(s.db, s.runId, s.transcript, "sess-1");
      appendJsonl(s.transcript, [
        assistantLine("msg_r", ZEROS_USAGE, { timestamp: "2026-09-01T08:02:00.000Z" }),
      ]);
      await ingestTranscript(s.db, s.runId, s.transcript, "sess-1");
      const rows = usageRows(s.db, s.runId);
      assertEqual(rows.length, 1, "usage_facts rows");
      assertEqual(rows[0].input_tokens, 100, "a zeros line must never lower a real counter (MAX)");
      assertEqual(rows[0].output_tokens, 50, "output_tokens stays real");
      const cost = costRow(s.db, s.runId, rows[0].usage_id);
      assert(Math.abs(cost.cost_usd - REAL_COST) < 1e-12, `cost stays ${REAL_COST}, got ${cost.cost_usd}`);
    } finally {
      s.restore();
    }
  });

  await test("reprojectEvents after deleting usage_facts reproduces identical rows", async () => {
    const s = freshScenario("reproject");
    try {
      writeJsonl(s.transcript, [
        assistantLine("msg_m", ZEROS_USAGE, { timestamp: "2026-09-01T08:01:00.000Z" }),
        assistantLine("msg_m", REAL_USAGE, { timestamp: "2026-09-01T08:01:05.000Z" }),
        assistantLine("msg_m", REAL_USAGE, { timestamp: "2026-09-01T08:01:10.000Z" }),
      ]);
      await ingestTranscript(s.db, s.runId, s.transcript, "sess-1");
      const before = usageRows(s.db, s.runId).map((r) => ({
        usage_id: r.usage_id, session_id: r.session_id, agent_key: r.agent_key, model: r.model,
        observed_at: r.observed_at, input_tokens: r.input_tokens, output_tokens: r.output_tokens,
        cache_read_tokens: r.cache_read_tokens, cache_creation_tokens: r.cache_creation_tokens,
        source_path: r.source_path, source_offset: r.source_offset, message_id: r.message_id,
      }));
      const costBefore = costRow(s.db, s.runId, before[0].usage_id).cost_usd;
      assertEqual(before.length, 1, "one merged row before reproject");

      // Simulate a lost projection (the reproject path exists for exactly this).
      s.db.prepare("DELETE FROM usage_facts WHERE run_id=?").run(s.runId);
      assertEqual(usageRows(s.db, s.runId).length, 0, "usage_facts emptied");
      assertEqual(s.db.prepare("SELECT COUNT(*) AS n FROM cost_facts WHERE run_id=?").get(s.runId).n, 0,
        "cost_facts cascaded away with usage_facts");

      const summary = reprojectEvents(s.db, { runId: s.runId });
      assertEqual(summary.failed, 0, `reproject failures: ${summary.errors.join("; ")}`);
      assert(summary.projected > 0, "reproject projected events");
      const after = usageRows(s.db, s.runId).map((r) => ({
        usage_id: r.usage_id, session_id: r.session_id, agent_key: r.agent_key, model: r.model,
        observed_at: r.observed_at, input_tokens: r.input_tokens, output_tokens: r.output_tokens,
        cache_read_tokens: r.cache_read_tokens, cache_creation_tokens: r.cache_creation_tokens,
        source_path: r.source_path, source_offset: r.source_offset, message_id: r.message_id,
      }));
      assertEqual(JSON.stringify(after), JSON.stringify(before), "reprojected rows identical to incremental rows");
      const costAfter = costRow(s.db, s.runId, after[0].usage_id).cost_usd;
      assert(Math.abs(costAfter - costBefore) < 1e-12, `reprojected cost identical (${costBefore} vs ${costAfter})`);
    } finally {
      s.restore();
    }
  });

  await test("two runs sharing one transcript → two rows, one per run, never merged", async () => {
    const s = freshScenario("tworuns");
    try {
      const run2 = "run-tworuns-2";
      applyEvent(s.db, makeEvent("run.started", {
        runId: run2, squad: "dev", startedAt: "2026-09-01T09:00:00.000Z", cwd: "C:/repos/office",
      }, { runId: run2 }));
      applyEvent(s.db, makeEvent("session.linked", {
        runId: run2, sessionId: "sess-1", transcriptPath: s.transcript,
      }, { runId: run2 }));
      const psId = s.db.prepare("SELECT price_set_id FROM runs WHERE run_id=?").get(run2).price_set_id;
      s.db.prepare(
        "INSERT OR REPLACE INTO model_prices (price_set_id, model_key, provider, input_price, output_price, cache_read_price) VALUES (?,?,?,?,?,?)",
      ).run(psId, MODEL, "openrouter", 1, 2, 0.1);

      writeJsonl(s.transcript, [
        assistantLine("msg_shared", REAL_USAGE, { timestamp: "2026-09-01T08:01:00.000Z" }),
        assistantLine("msg_shared", REAL_USAGE, { timestamp: "2026-09-01T08:01:05.000Z" }),
      ]);
      await ingestTranscript(s.db, s.runId, s.transcript, "sess-1");
      await ingestTranscript(s.db, run2, s.transcript, "sess-1");

      // Same usage_id (identity is path+messageId), but run-scoped: one row per run.
      const all = s.db.prepare("SELECT run_id, usage_id, input_tokens FROM usage_facts WHERE usage_id=? ORDER BY run_id")
        .all(messageUsageId(s.transcript, "msg_shared"));
      assertEqual(all.length, 2, "rows for the shared message");
      assert(all[0].run_id !== all[1].run_id, "rows must belong to distinct runs");
      for (const row of all) {
        assertEqual(row.input_tokens, 100, `input_tokens for ${row.run_id}`);
        assert(costRow(s.db, row.run_id, row.usage_id) != null, `cost_facts row for ${row.run_id}`);
      }
      assertEqual(usageRows(s.db, s.runId).length, 1, "run-1 row count");
      assertEqual(usageRows(s.db, run2).length, 1, "run-2 row count");
    } finally {
      s.restore();
    }
  });

  await test("a line without message.id → legacy per-line row, message_id NULL", async () => {
    const s = freshScenario("legacy");
    try {
      writeJsonl(s.transcript, [
        assistantLine(null, REAL_USAGE, { timestamp: "2026-09-01T08:01:00.000Z" }),
        assistantLine(null, { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          { timestamp: "2026-09-01T08:02:00.000Z" }),
      ]);
      await ingestTranscript(s.db, s.runId, s.transcript, "sess-1");
      const rows = usageRows(s.db, s.runId);
      assertEqual(rows.length, 2, "legacy lines stay one row per line");
      for (const row of rows) {
        assertEqual(row.message_id, null, "legacy rows have message_id NULL");
      }
      assertEqual(rows[0].usage_id, lineUsageId(s.transcript, rows[0].source_offset),
        "legacy usage_id = hash(path:offset)");
      assertEqual(rows[0].input_tokens, 100, "first legacy line counters");
      assertEqual(rows[1].input_tokens, 7, "second legacy line counters");
    } finally {
      s.restore();
    }
  });

  await test("legacy per-line row squats the message's first offset → absorbed, batch not rolled back", async () => {
    const s = freshScenario("squat");
    try {
      // A pre-FOC-381 row already occupies (run, path, offset 0) — the exact
      // deploy-window straddle the trailing ON CONFLICT DO NOTHING must absorb.
      const zeroLine = assistantLine("msg_s", ZEROS_USAGE, { timestamp: "2026-09-01T08:01:00.000Z" });
      const firstOffset = 0; // first line of the file
      s.db.prepare(
        `INSERT INTO usage_facts (usage_id, run_id, session_id, agent_key, model, observed_at,
         input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, source_path, source_offset, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(lineUsageId(s.transcript, firstOffset), s.runId, "sess-1", "_lead", MODEL,
        "2026-09-01T08:01:00.000Z", 0, 0, 0, 0, resolve(s.transcript), firstOffset, "2026-09-01T08:01:00.000Z");

      const secondLine = assistantLine("msg_s", REAL_USAGE, { timestamp: "2026-09-01T08:01:05.000Z" });
      writeJsonl(s.transcript, [zeroLine, secondLine]);
      // Must not throw: a throw would roll back the whole applyEvents batch.
      const result = await ingestTranscript(s.db, s.runId, s.transcript, "sess-1");
      assert(result.events > 0, "batch applied some events");

      // The batch survived: the transcript.progress event from the SAME
      // applyEvents transaction is visible.
      const ts = s.db.prepare("SELECT parse_status FROM transcript_sources WHERE source_path=? AND run_id=?")
        .get(resolve(s.transcript), s.runId);
      assert(ts?.parse_status === "parsed", "transcript.progress applied — batch not rolled back");

      const rows = usageRows(s.db, s.runId);
      assertEqual(rows.length, 2, "legacy squatter + message row");
      const legacy = rows.find((r) => r.usage_id === lineUsageId(s.transcript, firstOffset));
      const merged = rows.find((r) => r.usage_id === messageUsageId(s.transcript, "msg_s"));
      assert(legacy != null, "legacy squatter row untouched");
      assertEqual(legacy.input_tokens, 0, "legacy row keeps its own counters");
      assert(merged != null, "message row created by the non-squatted second line");
      assertEqual(merged.input_tokens, 100, "message row holds the second line's real counters");
      assertEqual(merged.message_id, "msg_s", "message row carries message_id");
    } finally {
      s.restore();
    }
  });

  await test("agent_key conflict within one message raises usage_message_field_conflict, keeps existing", async () => {
    const s = freshScenario("conflict");
    try {
      writeJsonl(s.transcript, [
        assistantLine("msg_c", REAL_USAGE, { agentKey: "agent-a", timestamp: "2026-09-01T08:01:00.000Z" }),
        assistantLine("msg_c", REAL_USAGE, { agentKey: "agent-b", timestamp: "2026-09-01T08:01:05.000Z" }),
      ]);
      await ingestTranscript(s.db, s.runId, s.transcript, "sess-1");
      const rows = usageRows(s.db, s.runId);
      assertEqual(rows.length, 1, "one merged row");
      assertEqual(rows[0].agent_key, "agent-a", "existing agent_key kept on conflict");
      const issue = s.db.prepare(
        "SELECT details_json FROM data_quality_issues WHERE run_id=? AND issue_type='usage_message_field_conflict' AND resolved_at IS NULL",
      ).get(s.runId);
      assert(issue, "usage_message_field_conflict issue raised");
      const details = JSON.parse(issue.details_json);
      assertEqual(details.field, "agent_key", "issue names the conflicting field");
      assertEqual(details.existingValue, "agent-a", "issue carries the existing value");
      assertEqual(details.incomingValue, "agent-b", "issue carries the incoming value");
      assertEqual(details.usageId, messageUsageId(s.transcript, "msg_c"), "issue carries the usageId");
    } finally {
      s.restore();
    }
  });

  await test("migration v8: fresh DB has message_id + index + marker; simulated v7 DB regains them; reopen idempotent", async () => {
    const temp = mkdtempSync(join(tmpdir(), "telemetry-usage-msg-mig-"));
    const dbPath = join(temp, "telemetry.sqlite");
    try {
      let db = openTelemetryDb(dbPath);
      const columnNames = () => db.prepare("PRAGMA table_info(usage_facts)").all().map((c) => c.name);
      assert(columnNames().includes("message_id"), "fresh DB: message_id column exists");
      const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_usage_facts_message'").get();
      assert(idx, "fresh DB: idx_usage_facts_message exists");
      const versions = db.prepare("SELECT version FROM schema_migrations").all().map((r) => r.version);
      assert(versions.includes(MIGRATION_VERSIONS.usageMessageId), `schema_migrations missing v8 (have ${versions.join(",")})`);

      // Simulate a DB last opened before FOC-381 (v7 shape): strip the column,
      // its index, and the marker — the next open must re-add all three.
      db.exec("DROP INDEX idx_usage_facts_message");
      // A real v7 DB's views predate message_id (views are DROP+CREATEd at the end of
      // migrate(), after addUsageMessageColumns), so the simulation must drop them first —
      // SQLite refuses to DROP COLUMN while canonical_usage references u.message_id.
      dropCanonicalViews(db);
      db.exec("ALTER TABLE usage_facts DROP COLUMN message_id");
      db.prepare("DELETE FROM schema_migrations WHERE version=?").run(MIGRATION_VERSIONS.usageMessageId);
      assert(!columnNames().includes("message_id"), "v7 simulation: column gone");
      db.close();

      db = openTelemetryDb(dbPath);
      assert(columnNames().includes("message_id"), "reopened v7 DB: message_id re-added");
      assert(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_usage_facts_message'").get(),
        "reopened v7 DB: index re-created");
      assert(db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(MIGRATION_VERSIONS.usageMessageId),
        "reopened v7 DB: v8 marker stamped");
      assertEqual(columnNames().filter((n) => n === "message_id").length, 1, "exactly one message_id column");
      const viewRow = db.prepare("SELECT name FROM sqlite_master WHERE type='view' AND name='canonical_usage'").get();
      assert(viewRow, "reopened v7 DB: canonical_usage view re-created");
      const viewCols = db.prepare("PRAGMA table_info(canonical_usage)").all().map((c) => c.name);
      assert(viewCols.includes("message_id"), "reopened v7 DB: canonical_usage exposes message_id");

      // Re-open again: PRAGMA guard must not re-ALTER or duplicate anything.
      db.close();
      db = openTelemetryDb(dbPath);
      assertEqual(columnNames().filter((n) => n === "message_id").length, 1, "idempotent reopen: still one message_id column");
      db.close();
    } finally {
      try { rmSync(temp, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) console.log(failures.join("\n"));
  process.exit(failed ? 1 : 0);
}

run().catch((error) => { console.error(error); process.exit(1); });
