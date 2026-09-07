// scripts/telemetry-settled.test.mjs — a finished run stops being re-read.
//
// Reported 2026-09-05 as "the Fenix dashboard is very slow". Measured, not
// guessed: /api/runs took 24 871 ms, and even a 404 on a route that does no
// work took 25 606 ms — everything queued behind one blocked event loop.
//
// It was not the database. Indexes were present, COUNT by run_id took 1 ms and
// a GROUP BY over the whole table 15 ms. It was ingestKnownRuns, which runs on
// a 15-second timer: 68.7 MB of JSON re-parsed every cycle.
//
// The reason a FINISHED run kept re-parsing is that the skip cache in
// ingestTranscript compares FILE SIZE, and a transcript that is still growing
// never matches. Completed runs kept getting a growing file because of stale
// run->session links: one live 16.7 MB transcript was claimed by four
// supervisor runs from August, so it was parsed four times per cycle on behalf
// of runs that had ended ten days earlier.
//
// The gate is deliberately narrow, and each of these tests pins one edge of it:
// terminal status, past the flush grace, and already parsed at least once. A
// run that ended but was never ingested must still get its one pass.
//
// Run: node scripts/telemetry-settled.test.mjs

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ROOT, harness } from "./supervisor-test-fixtures.mjs";

const { test, fail, summary } = harness();

const homes = [];
process.on("exit", () => {
  for (const h of homes) {
    try {
      rmSync(h, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

const SRC = readFileSync(join(ROOT, "scripts", "telemetry-ingest.mjs"), "utf8");
const code = SRC.split("\n")
  .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
  .join("\n");

console.log("\nskonczony run nie jest czytany w kolko");

test("the gate is checked BEFORE the per-run filesystem lookup", () => {
  // transcriptForSession stats a path and may search three roots for it. Doing
  // that first would keep most of the per-run cost this gate exists to remove.
  //
  // Scoped to the loop body: both names also appear as function DEFINITIONS
  // earlier in the file, and a first draft of this test compared those instead
  // — it failed against correct code, which is the worse kind of red.
  const loopAt = code.indexOf("for (const run of queryRuns(db))");
  assert.ok(loopAt > -1, "the ingest loop no longer iterates queryRuns");
  const body = code.slice(loopAt);

  const gate = body.indexOf("settledRun(db, run)");
  const lookup = body.indexOf("transcriptForSession(run)");
  assert.ok(gate > -1, "settledRun is no longer called from the ingest loop");
  assert.ok(lookup > -1, "transcriptForSession is no longer called in the loop");
  assert.ok(gate < lookup, "settledRun must be checked before transcriptForSession");
});

test("only ended runs can settle", () => {
  // A running run's transcript grows because the run is writing it. That is
  // the case the loop exists for and must never be skipped.
  assert.match(code, /TERMINAL_RUN_STATUSES\s*=\s*new Set\(\[\s*"completed",\s*"failed"\s*\]\)/);
  assert.match(code, /if\s*\(!TERMINAL_RUN_STATUSES\.has\(run\.status\)\)\s*return false/);
});

test("a flush grace protects the tail of a just-ended run", () => {
  // run-manifest end writes the manifest before the transcript's last lines
  // are necessarily flushed. Settling immediately would drop that tail.
  assert.match(code, /REINGEST_GRACE_MS/);
  assert.match(code, /Date\.now\(\)\s*-\s*ended\s*<=\s*REINGEST_GRACE_MS/);
});

test("an unknown end time never settles", () => {
  // NaN comparisons are false, so a missing endedAt would otherwise fall
  // through the grace check and settle immediately.
  assert.match(code, /if\s*\(!Number\.isFinite\(ended\)\)\s*return false/);
});

test("a run that ended but was never ingested still gets its pass", () => {
  // The dangerous version of this gate: skip everything terminal. A run that
  // crashed mid-ingest, or ended before the server ever saw it, would then be
  // lost permanently rather than picked up on the next cycle.
  assert.match(code, /parse_status='parsed'/);
  assert.match(code, /parse_status<>'parsed'/);
  assert.match(code, /\(parsed\?\.c\s*\?\?\s*0\)\s*>\s*0/);
  assert.match(code, /\(pending\?\.c\s*\?\?\s*0\)\s*===\s*0/);
});

test("skipped runs are counted, not silently dropped", () => {
  // A loop that quietly does nothing is indistinguishable from a broken one.
  assert.match(code, /summary\.settled\+\+/);
  assert.match(code, /settled:\s*0/);
});

console.log("\nzachowanie na zywej bazie");

// Set up and run the real loop HERE, at module top level, not inside test().
// harness()'s test() calls fn() without awaiting it, so an async body resolves
// after summary() has already printed — it reports PASS whatever the
// assertions do. A first draft of this file was async and "passed" while
// throwing a NOT NULL error after the summary line.
const home = mkdtempSync(join(tmpdir(), "la-settled-"));
homes.push(home);
const dbPath = join(home, "telemetry.sqlite");
const savedDbEnv = process.env.LA_TELEMETRY_DB;
process.env.LA_TELEMETRY_DB = dbPath;

const store = await import("./telemetry-store.mjs");
const ingest = await import("./telemetry-ingest.mjs");

const oldTs = new Date(Date.now() - 60 * 60 * 1000).toISOString();
{
  const db = store.openTelemetryDb(dbPath);
  for (const [id, status, endedAt] of [
    ["run-settled", "completed", oldTs],
    ["run-fresh", "completed", new Date().toISOString()],
    ["run-live", "running", null],
    ["run-never-ingested", "completed", oldTs],
  ]) {
    db.prepare(
      "INSERT INTO runs (run_id, squad, started_at, ended_at, status, session_id, updated_at) VALUES (?,?,?,?,?,?,?)",
    ).run(id, "dev", oldTs, endedAt, status, `sess-${id}`, oldTs);
  }
  // Everything except run-never-ingested has already been parsed once.
  for (const id of ["run-settled", "run-fresh", "run-live"]) {
    db.prepare(
      "INSERT INTO transcript_sources (source_path, run_id, file_size, parse_status, updated_at) VALUES (?,?,?,?,?)",
    ).run(`C:/fake/${id}.jsonl`, id, 10, "parsed", oldTs);
  }
  db.close();
}

const result = await ingest.ingestKnownRuns({ dbPath });
if (savedDbEnv === undefined) delete process.env.LA_TELEMETRY_DB;
else process.env.LA_TELEMETRY_DB = savedDbEnv;

test("exactly the finished, parsed, past-grace run settles", () => {
  // run-fresh ended seconds ago (inside the grace), run-live has not ended,
  // run-never-ingested has no parsed source yet. Only run-settled qualifies.
  assert.equal(result.settled, 1, `expected 1 settled run, got ${result.settled}`);
});

test("the other three are still processed", () => {
  // They have no real transcript on disk, so they land in missingTranscripts —
  // what matters is that the gate did not swallow them.
  assert.equal(
    result.settled + result.missingTranscripts,
    4,
    `all four runs must be accounted for, got settled=${result.settled} missing=${result.missingTranscripts}`,
  );
});

summary();
