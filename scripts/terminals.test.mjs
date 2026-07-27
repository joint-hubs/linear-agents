// Tests for terminals.mjs — run with: node scripts/terminals.test.mjs
//
// All tests use synthetic run data with an injected probe — NO PowerShell calls.

import * as terminals from "./terminals.mjs";

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, message: e.message });
    console.log(`  \u2717 ${name}: ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

// ---------------------------------------------------------------------------
// Synthetic runs
// ---------------------------------------------------------------------------

const now = "2026-07-27T12:00:00.000Z";
const earlier = "2026-07-27T11:00:00.000Z";
const evenEarlier = "2026-07-27T10:00:00.000Z";

function makeRun(overrides = {}) {
  return {
    runId: overrides.runId || "run-1",
    squad: overrides.squad || "dev",
    taskId: overrides.taskId || "JOI-1",
    startedAt: overrides.startedAt || now,
    endedAt: overrides.endedAt ?? null,
    status: overrides.status || (overrides.endedAt ? "completed" : "running"),
    windowTitle: overrides.windowTitle ?? "fenix · dev · JOI-1",
    consolePid: overrides.consolePid ?? 12345,
    launchedBy: overrides.launchedBy ?? "dashboard",
    cwd: overrides.cwd || "C:\\repo",
    totals: overrides.totals || {
      costUSD: 0.05,
      partialCostUSD: 0.05,
      unpricedUsageCount: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests — listTerminals (PID-based)
// ---------------------------------------------------------------------------

// Test 1: alive runs first, sorted by startedAt desc
test("alive runs first, sorted by startedAt desc", () => {
  let probeCalls = 0;
  const probe = (pid) => { probeCalls++; return true; };

  const runs = [
    makeRun({ runId: "old-alive", startedAt: earlier, endedAt: null, consolePid: 100 }),
    makeRun({ runId: "new-alive", startedAt: now, endedAt: null, consolePid: 200 }),
    makeRun({ runId: "finished", startedAt: evenEarlier, endedAt: evenEarlier, consolePid: 300 }),
  ];

  const result = terminals.listTerminals(runs, { probe, finishedLimit: 15 });

  assert(result.length === 3, `expected 3 entries, got ${result.length}`);
  assert(result[0].runId === "new-alive", "newest alive first");
  assert(result[1].runId === "old-alive", "older alive second");
  assert(result[2].runId === "finished", "finished last");
  assert(result[0].alive === true, "new-alive is alive");
  assert(result[0].canFocus === true, "new-alive canFocus");
  assert(result[1].alive === true, "old-alive is alive");
  assert(result[2].alive === false, "finished is not alive");
  assert(result[2].canFocus === false, "finished cannot focus");
  assert(probeCalls === 2, `probe called 2 times (only for alive candidates), got ${probeCalls}`);
});

// Test 2: finished runs are NOT probed (performance guard)
test("finished runs skip probe entirely", () => {
  let probeCalls = 0;
  const probe = (pid) => { probeCalls++; return true; };

  const runs = [
    makeRun({ runId: "f1", startedAt: now, endedAt: now, consolePid: 100 }),
    makeRun({ runId: "f2", startedAt: earlier, endedAt: earlier, consolePid: 200 }),
  ];

  const result = terminals.listTerminals(runs, { probe, finishedLimit: 15 });

  assert(result.length === 2, "2 entries");
  assert(result.every((r) => r.alive === false), "all finished are alive=false");
  assert(probeCalls === 0, `probe NEVER called for finished runs, got ${probeCalls}`);
});

// Test 3: finishedLimit trims finished entries
test("finishedLimit trims finished entries", () => {
  const probe = (pid) => true;

  const runs = [];
  for (let i = 0; i < 20; i++) {
    runs.push(makeRun({
      runId: `finished-${i}`,
      startedAt: new Date(Date.parse(now) - i * 60000).toISOString(),
      endedAt: new Date(Date.parse(now) - i * 60000).toISOString(),
      consolePid: 100 + i,
    }));
  }
  runs.push(makeRun({ runId: "alive-1", startedAt: now, endedAt: null, consolePid: 999 }));

  const result = terminals.listTerminals(runs, { probe, finishedLimit: 5 });

  assert(result.length === 6, `1 alive + 5 finished = 6, got ${result.length}`);
  assert(result[0].runId === "alive-1", "alive first");
  assert(result.slice(1).every((r) => !r.alive), "rest are finished");
  assert(result.slice(1).length === 5, "exactly 5 finished");
});

// Test 4: cost fields are copied through
test("cost fields are copied from run totals", () => {
  const probe = (pid) => true;
  const runs = [
    makeRun({
      runId: "costly",
      startedAt: now,
      endedAt: null,
      consolePid: 100,
      totals: { costUSD: null, partialCostUSD: 1.23, unpricedUsageCount: 2 },
    }),
  ];

  const result = terminals.listTerminals(runs, { probe });

  assert(result[0].costUSD === null, "costUSD is null (unpriced)");
  assert(result[0].partialCostUSD === 1.23, "partialCostUSD copied");
  assert(result[0].unpricedUsageCount === 2, "unpricedUsageCount copied");
});

// Test 5: run without consolePid gets alive=false, canFocus=false, NO probe call
test("run without consolePid is never probed, alive=false, canFocus=false", () => {
  let probeCalls = 0;
  const probe = (pid) => { probeCalls++; return true; };

  // Bypass makeRun's default consolePid
  const runs = [{
    runId: "no-pid",
    squad: "dev",
    taskId: "JOI-1",
    startedAt: now,
    endedAt: null,
    status: "running",
    windowTitle: "fenix · dev · JOI-1",
    consolePid: null,
    launchedBy: "dashboard",
    cwd: "C:\\repo",
    totals: { costUSD: 0.05, partialCostUSD: 0.05, unpricedUsageCount: 0 },
  }];

  const result = terminals.listTerminals(runs, { probe });

  assert(result[0].alive === false, "no consolePid → alive=false");
  assert(result[0].canFocus === false, "no consolePid → canFocus=false");
  assert(result[0].consolePid === null, "consolePid is null in output");
  assert(probeCalls === 0, "probe not called when consolePid is null");
});

// Test 6: alive=false when probe returns false
test("alive=false when probe returns false", () => {
  const probe = (pid) => false;

  const runs = [
    makeRun({ runId: "dead", startedAt: now, endedAt: null, consolePid: 100 }),
  ];

  const result = terminals.listTerminals(runs, { probe });

  assert(result[0].alive === false, "probe returned false → alive=false");
  assert(result[0].canFocus === false, "probe returned false → canFocus=false");
});

// Test 7: empty runs array
test("empty runs returns empty array", () => {
  const result = terminals.listTerminals([], { probe: (pid) => true });
  assert(result.length === 0, "empty input → empty output");
});

// Test 8: launchedBy and cwd are passed through
test("launchedBy and cwd are passed through", () => {
  const probe = (pid) => true;
  const runs = [{
    runId: "manual",
    squad: "dev",
    taskId: "JOI-1",
    startedAt: now,
    endedAt: null,
    status: "running",
    windowTitle: "fenix · dev · JOI-1",
    consolePid: 100,
    launchedBy: null,
    cwd: "D:\\other-repo",
    totals: { costUSD: 0.05, partialCostUSD: 0.05, unpricedUsageCount: 0 },
  }];

  const result = terminals.listTerminals(runs, { probe });

  assert(result[0].launchedBy === null, "launchedBy null passed through");
  assert(result[0].cwd === "D:\\other-repo", "cwd passed through");
});

// Test 9: default finishedLimit is 15
test("default finishedLimit is 15", () => {
  const probe = (pid) => true;
  const runs = [];
  for (let i = 0; i < 20; i++) {
    runs.push(makeRun({
      runId: `f-${i}`,
      startedAt: new Date(Date.parse(now) - i * 60000).toISOString(),
      endedAt: new Date(Date.parse(now) - i * 60000).toISOString(),
      consolePid: 100 + i,
    }));
  }

  const result = terminals.listTerminals(runs, { probe });
  assert(result.length === 15, `default limit 15, got ${result.length}`);
});

// Test 10: consolePid is included in output
test("consolePid is included in output", () => {
  const probe = (pid) => true;
  const runs = [
    makeRun({ runId: "with-pid", startedAt: now, endedAt: null, consolePid: 4242 }),
  ];

  const result = terminals.listTerminals(runs, { probe });

  assert(result[0].consolePid === 4242, "consolePid 4242 in output");
  assert(result[0].alive === true, "alive true");
  assert(result[0].canFocus === true, "canFocus true");
  assert(result[0].canSignal === true, "canSignal true (alias for canFocus)");
});

// Test 11: invalid consolePid (0, negative, float) treated as null
test("invalid consolePid treated as null", () => {
  let probeCalls = 0;
  const probe = (pid) => { probeCalls++; return true; };

  const runs = [
    { runId: "zero", squad: "dev", taskId: "J-1", startedAt: now, endedAt: null, status: "running", windowTitle: "x", consolePid: 0, launchedBy: "d", cwd: "C:", totals: {} },
    { runId: "neg", squad: "dev", taskId: "J-2", startedAt: now, endedAt: null, status: "running", windowTitle: "x", consolePid: -1, launchedBy: "d", cwd: "C:", totals: {} },
    { runId: "float", squad: "dev", taskId: "J-3", startedAt: now, endedAt: null, status: "running", windowTitle: "x", consolePid: 1.5, launchedBy: "d", cwd: "C:", totals: {} },
  ];

  const result = terminals.listTerminals(runs, { probe });

  assert(result.every((r) => r.alive === false), "all invalid PIDs → alive=false");
  assert(result.every((r) => r.canFocus === false), "all invalid PIDs → canFocus=false");
  assert(result.every((r) => r.canSignal === false), "all invalid PIDs → canSignal=false");
  assert(result.every((r) => r.consolePid === null), "all invalid PIDs → consolePid=null");
  assert(probeCalls === 0, "probe never called for invalid PIDs");
});

// Test 12: isProcessAlive with invalid pid returns false
test("isProcessAlive with invalid pid returns false", () => {
  assert(terminals.isProcessAlive(0) === false, "0 → false");
  assert(terminals.isProcessAlive(-1) === false, "-1 → false");
  assert(terminals.isProcessAlive(1.5) === false, "1.5 → false");
  assert(terminals.isProcessAlive(null) === false, "null → false");
  assert(terminals.isProcessAlive(undefined) === false, "undefined → false");
  assert(terminals.isProcessAlive("123") === false, "string → false");
});

// Test 13: focusWindowByPid with invalid pid returns error
test("focusWindowByPid with invalid pid returns error", () => {
  const r1 = terminals.focusWindowByPid(0);
  assert(r1.ok === false, "0 → not ok");
  assert(r1.error != null, "0 → has error");

  const r2 = terminals.focusWindowByPid(null);
  assert(r2.ok === false, "null → not ok");
});

// Test 14: stopByPid with invalid pid returns error
test("stopByPid with invalid pid returns error", () => {
  const r1 = terminals.stopByPid(0);
  assert(r1.ok === false, "0 → not ok");

  const r2 = terminals.stopByPid(null);
  assert(r2.ok === false, "null → not ok");
});

// Test 15: flashWindowByPid with invalid pid returns error (no PowerShell)
test("flashWindowByPid with invalid pid returns error", () => {
  const r1 = terminals.flashWindowByPid(0);
  assert(r1.ok === false, "0 → not ok");
  assert(r1.error != null, "0 → has error");

  const r2 = terminals.flashWindowByPid(-1);
  assert(r2.ok === false, "-1 → not ok");

  const r3 = terminals.flashWindowByPid(1.5);
  assert(r3.ok === false, "1.5 → not ok");

  const r4 = terminals.flashWindowByPid(null);
  assert(r4.ok === false, "null → not ok");

  const r5 = terminals.flashWindowByPid("abc");
  assert(r5.ok === false, "string → not ok");
});

// ---------------------------------------------------------------------------
// Legacy API — basic validation tests (no PowerShell)
// ---------------------------------------------------------------------------

test("isWindowAlive with empty/null title returns false", () => {
  assert(terminals.isWindowAlive("") === false, "empty string → false");
  assert(terminals.isWindowAlive(null) === false, "null → false");
  assert(terminals.isWindowAlive(undefined) === false, "undefined → false");
});

test("focusWindow with empty/null title returns error", () => {
  const r1 = terminals.focusWindow("");
  assert(r1.ok === false, "empty string → not ok");
  const r2 = terminals.focusWindow(null);
  assert(r2.ok === false, "null → not ok");
});

test("stopWindow with empty/null title returns error", () => {
  const r1 = terminals.stopWindow("");
  assert(r1.ok === false, "empty string → not ok");
  const r2 = terminals.stopWindow(null);
  assert(r2.ok === false, "null → not ok");
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

console.log("");
if (failed > 0) {
  console.log("Failures:");
  for (const f of failures) console.log(`  ${f.name}: ${f.message}`);
}
console.log(`${passed} passed, ${failed} failed out of ${passed + failed}`);
console.log(failed === 0 ? `PASS ${passed}/${passed + failed}` : "FAIL");
process.exit(failed === 0 ? 0 : 1);
