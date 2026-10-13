// Contract test for sweepSettledGrowth (FOC-761): a resumed turn appends to a
// transcript whose run already settled, and the 15 s ingest tick must keep
// skipping settled runs (AC3) — the sweep is what re-pends the grown file so
// the NEXT ingestKnownRuns pass reads the new tail from the stored byte offset.
//
// Never opens a real telemetry store: every test builds its own temp home
// (LA_TELEMETRY_HOME / LA_TELEMETRY_DB), same seam as telemetry-ingest.test.mjs.
//
// Run: node --test scripts/telemetry-sweep.test.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync, appendFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeEvent, openTelemetryDb, applyEvent } from "./telemetry-store.mjs";
import { ingestTranscript, ingestKnownRuns, sweepSettledGrowth } from "./telemetry-ingest.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const TEN_MINUTES_MS = 10 * 60 * 1000;

function writeJsonl(path, lines) {
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
}

function assistantLine(sessionId, timestamp, inputTokens) {
  return {
    type: "assistant", timestamp, sessionId,
    message: { id: `msg_${timestamp}`, model: "deepseek-v4-flash", usage: { input_tokens: inputTokens, output_tokens: 10 } },
  };
}

async function withTempStore(fn) {
  const home = mkdtempSync(join(tmpdir(), "la-sweep-"));
  const dbPath = join(home, "telemetry.sqlite");
  // Point the store's seams at this test's fresh temp dir and leave them set:
  // the unset state would resolve the live default telemetry DB path, so these
  // env vars are never deleted here (static isolation audit, test-run.mjs).
  process.env.LA_TELEMETRY_HOME = home;
  process.env.LA_TELEMETRY_DB = dbPath;
  try {
    const db = openTelemetryDb(dbPath);
    try {
      await fn({ home, dbPath, db });
    } finally {
      await db.close();
    }
  } finally {
    try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// Build a terminal run with an ingested transcript. ingestTranscript writes the
// transcript_sources row (parse_status='parsed' at the current file size), so
// the run is settled exactly like one the 15 s tick would skip.
async function buildSettledRun(db, { runId, sessionId, transcript, endedMsAgo }) {
  const startedAt = new Date(Date.now() - endedMsAgo - 60 * 1000).toISOString();
  const endedAt = new Date(Date.now() - endedMsAgo).toISOString();
  applyEvent(db, makeEvent("run.started", { runId, squad: "dev", startedAt, cwd: "C:/repos/x" }, { runId }));
  applyEvent(db, makeEvent("run.ended", { runId, endedAt, exitCode: 0, sessionId, transcriptPath: transcript }, { runId }));
  await ingestTranscript(db, runId, transcript, sessionId);
}

const sourceRow = (db, runId) =>
  db.prepare("SELECT parse_status, file_size FROM transcript_sources WHERE run_id=?").get(runId);
const openIssues = (db, runId) =>
  db.prepare(
    "SELECT COUNT(*) AS c FROM data_quality_issues WHERE run_id=? AND issue_type='transcript_grew_after_settle' AND resolved_at IS NULL",
  ).get(runId).c;
const usageCount = (db, runId) =>
  db.prepare("SELECT COUNT(*) AS c FROM usage_facts WHERE run_id=?").get(runId).c;

test("(a) an unchanged transcript is left alone — grown 0, row still parsed", async () => {
  await withTempStore(async ({ db, dbPath }) => {
    const sessionId = "sess-a";
    const transcript = join(tmpdir(), `la-sweep-a-${Date.now()}.jsonl`);
    writeJsonl(transcript, [assistantLine(sessionId, "2026-10-13T08:00:00.000Z", 100)]);
    await buildSettledRun(db, { runId: "run-sweep-a", sessionId, transcript, endedMsAgo: TEN_MINUTES_MS });

    const result = await sweepSettledGrowth({ dbPath });
    assert.equal(result.grown, 0, "an unchanged file must not be re-pended");
    assert.equal(result.checked, 1, "the settled run's row must have been checked");
    assert.deepEqual(result.runs, []);
    assert.equal(sourceRow(db, "run-sweep-a").parse_status, "parsed");
    unlinkSync(transcript);
  });
});

test("(b) growth re-pends the row, raises the issue once, and the next ingest reads the tail", async () => {
  await withTempStore(async ({ db, dbPath }) => {
    const sessionId = "sess-b";
    const transcript = join(tmpdir(), `la-sweep-b-${Date.now()}.jsonl`);
    writeJsonl(transcript, [assistantLine(sessionId, "2026-10-13T08:00:00.000Z", 100)]);
    await buildSettledRun(db, { runId: "run-sweep-b", sessionId, transcript, endedMsAgo: TEN_MINUTES_MS });
    const usageBefore = usageCount(db, "run-sweep-b");

    // The resumed turn appends after the run settled.
    appendFileSync(transcript, JSON.stringify(assistantLine(sessionId, "2026-10-13T09:00:00.000Z", 77)) + "\n", "utf8");

    const sweep = await sweepSettledGrowth({ dbPath });
    assert.equal(sweep.grown, 1);
    assert.deepEqual(sweep.runs, ["run-sweep-b"]);
    assert.equal(sourceRow(db, "run-sweep-b").parse_status, "pending", "the row must be pending so the tick re-reads it");
    assert.equal(openIssues(db, "run-sweep-b"), 1, "one open transcript_grew_after_settle issue");

    const ingest = await ingestKnownRuns({ dbPath });
    assert.equal(ingest.usageEvents, 1, "the appended message's usage must be ingested");
    assert.equal(usageCount(db, "run-sweep-b"), usageBefore + 1);
    assert.equal(sourceRow(db, "run-sweep-b").parse_status, "parsed", "the row is parsed again after re-ingest");
    // FOC-761 review fix: once the transcript has been re-read, the issue is
    // resolved — otherwise it stays open forever and a second growth on the
    // same run can never re-report.
    const issuesAfterFirstGrowth = db.prepare(
      "SELECT resolved_at FROM data_quality_issues WHERE run_id='run-sweep-b' AND issue_type='transcript_grew_after_settle'",
    ).all();
    assert.equal(issuesAfterFirstGrowth.length, 1);
    assert.ok(issuesAfterFirstGrowth[0].resolved_at, "the issue is resolved after the re-ingest");

    // A second growth after the resolve raises a NEW issue row (open again).
    appendFileSync(transcript, JSON.stringify(assistantLine(sessionId, "2026-10-13T10:00:00.000Z", 44)) + "\n", "utf8");
    const secondSweep = await sweepSettledGrowth({ dbPath });
    assert.equal(secondSweep.grown, 1);
    assert.deepEqual(secondSweep.runs, ["run-sweep-b"], "the resolved issue must not suppress the new growth report");
    const issuesAfterSecondGrowth = db.prepare(
      "SELECT issue_id, resolved_at FROM data_quality_issues WHERE run_id='run-sweep-b' AND issue_type='transcript_grew_after_settle' ORDER BY opened_at",
    ).all();
    assert.equal(issuesAfterSecondGrowth.length, 2, "a second growth raises a NEW issue row");
    assert.ok(!issuesAfterSecondGrowth[1].resolved_at, "the new issue is open");
    unlinkSync(transcript);
  });
});

test("(c) a second sweep while the issue is open does not add another issue row", async () => {
  await withTempStore(async ({ db, dbPath }) => {
    const sessionId = "sess-c";
    const transcript = join(tmpdir(), `la-sweep-c-${Date.now()}.jsonl`);
    writeJsonl(transcript, [assistantLine(sessionId, "2026-10-13T08:00:00.000Z", 100)]);
    await buildSettledRun(db, { runId: "run-sweep-c", sessionId, transcript, endedMsAgo: TEN_MINUTES_MS });
    appendFileSync(transcript, JSON.stringify(assistantLine(sessionId, "2026-10-13T09:00:00.000Z", 55)) + "\n", "utf8");

    await sweepSettledGrowth({ dbPath });
    await sweepSettledGrowth({ dbPath });
    const total = db.prepare(
      "SELECT COUNT(*) AS c FROM data_quality_issues WHERE run_id='run-sweep-c' AND issue_type='transcript_grew_after_settle'",
    ).get().c;
    assert.equal(total, 1, "the issue must be raised once per run, not once per sweep");
    unlinkSync(transcript);
  });
});

test("(d) maxAgeDays excludes an old run; maxAgeDays null (boot pass) includes it", async () => {
  await withTempStore(async ({ db, dbPath }) => {
    const sessionId = "sess-d";
    const transcript = join(tmpdir(), `la-sweep-d-${Date.now()}.jsonl`);
    writeJsonl(transcript, [assistantLine(sessionId, "2026-09-20T08:00:00.000Z", 100)]);
    await buildSettledRun(db, { runId: "run-sweep-d", sessionId, transcript, endedMsAgo: 20 * DAY_MS });
    appendFileSync(transcript, JSON.stringify(assistantLine(sessionId, "2026-10-13T09:00:00.000Z", 66)) + "\n", "utf8");

    const windowed = await sweepSettledGrowth({ dbPath, maxAgeDays: 14 });
    assert.equal(windowed.grown, 0, "a run ended 20 days ago is outside the 14-day window");
    assert.equal(sourceRow(db, "run-sweep-d").parse_status, "parsed");

    const bootPass = await sweepSettledGrowth({ dbPath, maxAgeDays: null });
    assert.equal(bootPass.grown, 1, "the boot pass has no age limit");
    assert.equal(sourceRow(db, "run-sweep-d").parse_status, "pending");
    unlinkSync(transcript);
  });
});

test("(e) a missing transcript file is skipped without throwing", async () => {
  await withTempStore(async ({ db, dbPath }) => {
    const sessionId = "sess-e";
    const transcript = join(tmpdir(), `la-sweep-e-${Date.now()}.jsonl`);
    writeJsonl(transcript, [assistantLine(sessionId, "2026-10-13T08:00:00.000Z", 100)]);
    await buildSettledRun(db, { runId: "run-sweep-e", sessionId, transcript, endedMsAgo: TEN_MINUTES_MS });
    unlinkSync(transcript);
    assert.throws(() => statSync(transcript), "fixture sanity: the file is really gone");

    const result = await sweepSettledGrowth({ dbPath });
    assert.equal(result.grown, 0);
    assert.equal(result.checked, 1, "the row was examined, then skipped");
    assert.equal(sourceRow(db, "run-sweep-e").parse_status, "parsed");
  });
});

test("(f) a running run is not touched", async () => {
  await withTempStore(async ({ db, dbPath }) => {
    const sessionId = "sess-f";
    const transcript = join(tmpdir(), `la-sweep-f-${Date.now()}.jsonl`);
    writeJsonl(transcript, [assistantLine(sessionId, "2026-10-13T08:00:00.000Z", 100)]);
    const startedAt = new Date(Date.now() - TEN_MINUTES_MS).toISOString();
    applyEvent(db, makeEvent("run.started", { runId: "run-sweep-f", squad: "dev", startedAt, cwd: "C:/repos/x" }, { runId: "run-sweep-f" }));
    await ingestTranscript(db, "run-sweep-f", transcript, sessionId);
    appendFileSync(transcript, JSON.stringify(assistantLine(sessionId, "2026-10-13T09:00:00.000Z", 88)) + "\n", "utf8");

    const result = await sweepSettledGrowth({ dbPath });
    assert.equal(result.checked, 0, "a running run has no settled row to check");
    assert.equal(result.grown, 0);
    assert.equal(sourceRow(db, "run-sweep-f").parse_status, "parsed");
    unlinkSync(transcript);
  });
});
