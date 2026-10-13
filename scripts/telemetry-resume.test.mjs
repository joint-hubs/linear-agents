// FOC-761 slice S3 — resumed child turns reach telemetry.
//
// A resumed child turn reuses the run id; before this slice the second
// `run-manifest end` emitted a `run.ended` identical to the first, the dedup
// dropped it, and the run stayed settled at turn 1's end. These tests cover
// the reopen verb, the per-turn end identity and the out-of-order replay
// guards. The store is always a temp dir — never the real telemetry home.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPTS, "..");

// Route every store write (and the event spool) into a temp dir before the
// module under test is imported — same pattern as telemetry-ingest.test.mjs.
const temp = mkdtempSync(join(tmpdir(), "telemetry-resume-test-"));
const dbPath = join(temp, "telemetry.sqlite");
const stateRoot = join(temp, "state");
process.env.LA_TELEMETRY_HOME = temp;
process.env.LA_TELEMETRY_DB = dbPath;
process.env.LA_STATE_ROOT = stateRoot;

const { openTelemetryDb, makeEvent, applyEvent, recordManifest } = await import("./telemetry-store.mjs");

const SOURCE_PATH = join(stateRoot, "runs", "manifest.json");

/** Manifest shaped like what run-manifest.mjs writes. */
function manifest(runId, fields = {}) {
  return {
    runId,
    squad: "dev",
    source: null,
    brief: null,
    taskId: null,
    taskIdAuto: null,
    startedAt: "2026-10-13T08:00:00.000Z",
    endedAt: null,
    cwd: ROOT,
    gitBranch: "fenix-cost-truth",
    gitRefType: "branch",
    gitHeadSha: null,
    native: false,
    provider: "openrouter",
    interactive: false,
    claudeConfigDir: null,
    ...fields,
  };
}

function runRow(db, runId) {
  const row = db.prepare(
    "SELECT status, ended_at AS endedAt, exit_code AS exitCode FROM runs WHERE run_id=?",
  ).get(runId);
  return row && { ...row }; // plain object: sqlite rows have a null prototype
}

function runEvents(db, runId) {
  return db.prepare(
    `SELECT event_type AS eventType, source_kind AS sourceKind, source_offset AS sourceOffset
     FROM events WHERE run_id=? ORDER BY observed_at, source_kind`,
  ).all(runId).map((row) => ({ ...row }));
}

test("start -> end -> reopen -> second end keeps the run open and records the later end", () => {
  const db = openTelemetryDb(dbPath);
  const runId = "run-resume-1";
  const opts = { sourcePath: SOURCE_PATH };

  recordManifest(manifest(runId), "started", opts);

  // First end — the historic identity (kind `manifest`, offset 1).
  recordManifest(manifest(runId, {
    endedAt: "2026-10-13T08:05:00.000Z", exitCode: 0, endSeq: 1,
  }), "ended", opts);

  // (b) reopen: the run is open again before the second end lands.
  recordManifest(manifest(runId, {
    resumedAt: "2026-10-13T08:06:00.000Z", turns: 2,
  }), "resumed", { ...opts, turn: 1 });
  assert.deepEqual(runRow(db, runId), { status: "running", endedAt: null, exitCode: null });

  // Second end — new identity via endSeq.
  recordManifest(manifest(runId, {
    endedAt: "2026-10-13T08:10:00.000Z", exitCode: 0, endSeq: 2,
  }), "ended", opts);

  // (a) the run settles at the SECOND end.
  assert.deepEqual(runRow(db, runId), { status: "completed", endedAt: "2026-10-13T08:10:00.000Z", exitCode: 0 });
  // workspace.observed fires once, with `started` only — resume and per-turn
  // ends must not re-observe the workspace.
  assert.deepEqual(runEvents(db, runId), [
    { eventType: "run.started", sourceKind: "manifest", sourceOffset: 0 },
    { eventType: "workspace.observed", sourceKind: "manifest-workspace", sourceOffset: 0 },
    { eventType: "run.ended", sourceKind: "manifest", sourceOffset: 1 },
    { eventType: "run.resumed", sourceKind: "manifest-turn", sourceOffset: 1 },
    { eventType: "run.ended", sourceKind: "manifest-turn-end", sourceOffset: 2 },
  ]);
  db.close();
});

test("out-of-order replay: a resume older than the recorded end does not re-open the run", () => {
  const db = openTelemetryDb(dbPath);
  const runId = "run-resume-2";
  const opts = { sourcePath: SOURCE_PATH };

  recordManifest(manifest(runId), "started", opts);
  recordManifest(manifest(runId, { endedAt: "2026-10-13T08:05:00.000Z", exitCode: 0, endSeq: 1 }), "ended", opts);
  recordManifest(manifest(runId, { endedAt: "2026-10-13T08:10:00.000Z", exitCode: 0, endSeq: 2 }), "ended", opts);

  // The resume replays AFTER the later end (reprojection order is not
  // guaranteed): it must not move ended_at back to open.
  applyEvent(db, makeEvent("run.resumed", { runId, resumedAt: "2026-10-13T08:06:00.000Z", turns: 2 }, {
    runId,
    observedAt: "2026-10-13T08:06:00.000Z",
    sourceKind: "manifest-turn",
    sourcePath: SOURCE_PATH,
    sourceOffset: 1,
  }));
  assert.deepEqual(runRow(db, runId), { status: "completed", endedAt: "2026-10-13T08:10:00.000Z", exitCode: 0 });
  db.close();
});

test("the first end keeps its identity and replays are still deduplicated", () => {
  const db = openTelemetryDb(dbPath);
  const runId = "run-resume-3";
  const opts = { sourcePath: SOURCE_PATH };

  recordManifest(manifest(runId), "started", opts);
  const first = recordManifest(manifest(runId, { endedAt: "2026-10-13T08:05:00.000Z", exitCode: 0 }), "ended", opts);
  assert.equal(first.ingested, true);

  // (d) same end again — same identity, dropped by the dedup.
  const replay = recordManifest(manifest(runId, { endedAt: "2026-10-13T08:05:00.000Z", exitCode: 0 }), "ended", opts);
  assert.equal(replay.duplicate, true);

  const ends = runEvents(db, runId).filter((e) => e.eventType === "run.ended");
  assert.equal(ends.length, 1);
  assert.deepEqual(ends[0], { eventType: "run.ended", sourceKind: "manifest", sourceOffset: 1 });
  db.close();
});

test("a resumed recordManifest without `turn` reuses the explicit-turn identity", () => {
  const db = openTelemetryDb(dbPath);
  const runId = "run-resume-5";
  const opts = { sourcePath: SOURCE_PATH };

  recordManifest(manifest(runId), "started", opts);
  // Explicit turn=1 — what cmdReopen writes after moving turns to 2.
  recordManifest(manifest(runId, { resumedAt: "2026-10-13T09:00:00.000Z", turns: 2 }), "resumed", { ...opts, turn: 1 });
  // A caller omitting `turn` but carrying the same post-resume turns must
  // land on the SAME identity (turns - 1), not mint a second resume event
  // under offset 2 (the old `options.turn ?? manifest.turns` fallback).
  recordManifest(manifest(runId, { resumedAt: "2026-10-13T09:00:00.000Z", turns: 2 }), "resumed", opts);

  const resumes = runEvents(db, runId).filter((e) => e.eventType === "run.resumed");
  assert.equal(resumes.length, 1, "with and without `turn`, one resume = one identity");
  assert.deepEqual(resumes[0], { eventType: "run.resumed", sourceKind: "manifest-turn", sourceOffset: 1 });

  // No turns at all → the 0-based first-turn index, never negative.
  recordManifest(manifest(runId), "resumed", opts);
  const resumedOffsets = runEvents(db, runId)
    .filter((e) => e.eventType === "run.resumed")
    .map((e) => e.sourceOffset)
    .sort((a, b) => a - b);
  assert.deepEqual(resumedOffsets, [0, 1], "a turns-less resume is a different (first-turn) identity");
  db.close();
});

test("run-manifest reopen on a missing manifest warns and exits 0", () => {
  const temp2 = mkdtempSync(join(tmpdir(), "telemetry-resume-cli-"));
  try {
    const result = spawnSync(
      process.execPath,
      [join(SCRIPTS, "run-manifest.mjs"), "reopen", "nope", "1"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          LA_STATE_ROOT: join(temp2, "state"),
          LA_TELEMETRY_DB: join(temp2, "telemetry.sqlite"),
        },
      },
    );
    assert.equal(result.status, 0, `exit ${result.status}: ${result.stderr}`);
    assert.match(result.stderr, /manifest not found/);
    assert.equal(existsSync(join(temp2, "state", "runs", "nope.json")), false);
  } finally {
    rmSync(temp2, { recursive: true, force: true });
  }
});

test("run-manifest reopen writes the manifest and emits run.resumed", () => {
  const temp3 = mkdtempSync(join(tmpdir(), "telemetry-resume-cli-"));
  try {
    const runsDir = join(temp3, "state", "runs");
    mkdirSync(runsDir, { recursive: true });
    const manifestPath = join(runsDir, "run-resume-4.json");
    writeFileSync(manifestPath, JSON.stringify(manifest("run-resume-4", {
      endedAt: "2026-10-13T08:05:00.000Z", exitCode: 0, consolePid: 12345,
    })), "utf8");

    const result = spawnSync(
      process.execPath,
      [join(SCRIPTS, "run-manifest.mjs"), "reopen", "run-resume-4", "1"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          LA_STATE_ROOT: join(temp3, "state"),
          LA_TELEMETRY_DB: dbPath, // shared temp store, never the real one
        },
      },
    );
    assert.equal(result.status, 0, `exit ${result.status}: ${result.stderr}`);

    const written = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(written.endedAt, null);
    assert.equal(written.exitCode, null);
    assert.equal(written.consolePid, null, "reopen clears the stale turn-0 console pid");
    assert.equal(written.turns, 2);
    assert.ok(written.resumedAt, "resumedAt set");

    const db = openTelemetryDb(dbPath);
    try {
      const resumed = runEvents(db, "run-resume-4").filter((e) => e.eventType === "run.resumed");
      assert.equal(resumed.length, 1);
      assert.deepEqual(resumed[0], { eventType: "run.resumed", sourceKind: "manifest-turn", sourceOffset: 1 });
      assert.deepEqual(runRow(db, "run-resume-4"), { status: "running", endedAt: null, exitCode: null });
    } finally {
      db.close();
    }
  } finally {
    rmSync(temp3, { recursive: true, force: true });
  }
});
