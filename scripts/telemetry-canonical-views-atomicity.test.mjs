// Deterministic reproduction of the canonical-view recreate race.
//
// Two openers racing migrate() used to interleave statement-by-statement:
// opener B drops the views, opener A's CREATE slips into the gap, and B's own
// CREATE fails with "view canonical_usage already exists" — a failed telemetry
// hook write, i.e. under-reported spend. This test does not race: it INJECTS
// the concurrent CREATE exactly into the drop→create gap of the connection
// under test via a wrapper around db.exec, so the pre-fix failure happens on
// every run, and the post-fix recreate (one BEGIN IMMEDIATE transaction holds
// the write lock across drop and both CREATEs) repels it on every run.

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { openTelemetryDb, ensureCanonicalViews } from "./telemetry-store.mjs";

const temp = mkdtempSync(join(tmpdir(), "telemetry-views-atomicity-test-"));
// Declared out here so the finally below can release them even when the
// assertions throw — open handles would make the Windows cleanup EBUSY.
let intruder;
let store;
try {
  const dbPath = join(temp, "telemetry.sqlite");
  // `intruder` simulates the concurrent opener whose CREATE VIEW slips into
  // `store`'s drop→create gap; both are real openers of the same file.
  intruder = openTelemetryDb(dbPath);
  store = openTelemetryDb(dbPath);
  // Once the recreate is atomic the intruder cannot take the write lock while
  // store holds it; keep its wait short so the proof fails fast, not in 10s.
  intruder.exec("PRAGMA busy_timeout = 50");

  let injected = false;
  const rawExec = store.exec.bind(store);
  store.exec = (sql) => {
    if (!injected && /^\s*CREATE VIEW canonical_usage\b/.test(String(sql))) {
      injected = true;
      try {
        intruder.exec("CREATE VIEW canonical_usage AS SELECT 1 AS one");
      } catch {
        // Expected once the recreate is atomic: the intruder loses the write
        // lock. Its fate is decided by the assertions below, not here.
      }
    }
    return rawExec(sql);
  };

  ensureCanonicalViews(store);

  // The injection must have fired and the store must have won: the committed
  // view carries the canonical body, not the intruder's stub.
  assert.equal(injected, true, "injected concurrent CREATE never fired");
  const committed = store.prepare("SELECT sql FROM sqlite_master WHERE name='canonical_usage'").get();
  assert.ok(committed, "canonical_usage missing after ensureCanonicalViews");
  assert.match(committed.sql, /WITH ordered AS/, "intruder stub won the recreate race");

  console.log("PASS canonical view recreate survives an interleaved concurrent CREATE");
} finally {
  try { store?.close(); } catch { /* best effort */ }
  try { intruder?.close(); } catch { /* best effort */ }
  // Windows releases the sqlite file lock a beat AFTER the last connection
  // closes, so an immediate recursive rmSync can hit EBUSY/ENOTEMPTY even
  // though every connection was closed in code. Retry briefly instead of
  // failing the test on the race.
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      rmSync(temp, { recursive: true, force: true });
      break;
    } catch (error) {
      if (!["EBUSY", "ENOTEMPTY", "EPERM"].includes(error.code) || attempt === 9) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
