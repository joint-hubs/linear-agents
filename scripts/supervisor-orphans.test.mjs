// scripts/supervisor-orphans.test.mjs — FOC-799: orphaned children after a
// container restart.
//
// Covers the restart rule (a turn that started before this container's PID 1
// cannot be alive here) and the crash-shaped marking, over registry fixtures
// only. supervisor-lib reads LA_SUPERVISOR_STATE_HOME at load, so the seam is
// pointed at a mkdtemp dir BEFORE the module under test is imported — nothing
// here touches the real `.state/supervisor/`, ports, sockets or telemetry.
//
// Run: node scripts/supervisor-orphans.test.mjs

import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stateHome = mkdtempSync(join(tmpdir(), "supervisor-orphans-"));
process.env.LA_SUPERVISOR_STATE_HOME = stateHome;

const { containerStartMs, markOrphans, ORPHAN_ERROR } = await import("./supervisor-orphans.mjs");

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  PASS " + name);
  } catch (err) {
    failures.push(name);
    console.log("  FAIL " + name + "\n       " + err.message);
  }
}

const fail = (msg) => { throw new Error(msg); };
const eq = (a, b, label) => { if (a !== b) fail(`${label}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };
const ok = (cond, label) => { if (!cond) fail(label); };

// One registry file per run dir, shaped exactly like the watcher leaves it.
const registry = (runId, children) => {
  const dir = join(stateHome, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "children.json"), JSON.stringify({ runId, children, rounds: {} }, null, 2) + "\n", "utf8");
};
const readBack = (runId) => JSON.parse(readFileSync(join(stateHome, runId, "children.json"), "utf8"));

const BEFORE = "2026-01-01T00:00:00.000Z"; // turn started before the container
const AFTER = "2030-01-01T00:00:00.000Z";  // turn started after it
const CONTAINER_START = Date.parse("2026-06-01T00:00:00.000Z");
const NOW = new Date("2026-06-02T00:00:00.000Z");

try {
  console.log("\nsupervisor-orphans: markOrphans over registry fixtures");

  await test("running child whose last turn started before containerStart → crashed, crash-shaped", async () => {
    registry("run-orphan", {
      "child-a": {
        childId: "child-a",
        status: "running",
        pid: 4242,
        startedAt: BEFORE,
        turns: [{ startedAt: BEFORE }],
      },
    });
    const { marked, unknown, errors } = markOrphans({ stateRoot: stateHome, containerStart: CONTAINER_START, now: NOW });
    eq(marked.length, 1, "one child marked");
    eq(marked[0].runId, "run-orphan", "marked runId");
    eq(marked[0].childId, "child-a", "marked childId");
    eq(marked[0].startedAt, BEFORE, "marked startedAt");
    eq(unknown.length, 0, "nothing unknown");
    eq(errors.length, 0, "no errors");
    const child = readBack("run-orphan").children["child-a"];
    eq(child.status, "crashed", "status crashed");
    eq(child.exitCode, null, "exitCode null");
    eq(child.signal, null, "signal null");
    eq(child.endedAt, NOW.toISOString(), "endedAt set");
    eq(child.error, ORPHAN_ERROR, "error names the orphaning");
    eq(child.orphanedBy, "container-restart", "orphanedBy recorded");
    eq(child.turns[0].endedAt, NOW.toISOString(), "last turn endedAt set");
    eq(child.turns[0].exitCode, null, "last turn exitCode null");
    eq(child.turns[0].endedBy, "container-restart", "last turn endedBy container-restart");
  });

  await test("running child started after containerStart → untouched", async () => {
    registry("run-alive", {
      "child-b": { childId: "child-b", status: "running", startedAt: AFTER, turns: [{ startedAt: AFTER }] },
    });
    const { marked } = markOrphans({ stateRoot: stateHome, containerStart: CONTAINER_START, now: NOW });
    eq(marked.length, 0, "nothing marked");
    const child = readBack("run-alive").children["child-b"];
    eq(child.status, "running", "status untouched");
    ok(!("orphanedBy" in child), "no orphanedBy field added");
  });

  await test("exited/crashed/stopped children untouched even when started before", async () => {
    registry("run-terminal", {
      "child-c": { childId: "child-c", status: "exited", startedAt: BEFORE, turns: [{ startedAt: BEFORE }] },
      "child-d": { childId: "child-d", status: "crashed", startedAt: BEFORE, turns: [{ startedAt: BEFORE }] },
      "child-e": { childId: "child-e", status: "stopped", startedAt: BEFORE, turns: [{ startedAt: BEFORE }] },
    });
    const { marked, errors } = markOrphans({ stateRoot: stateHome, containerStart: CONTAINER_START, now: NOW });
    eq(marked.length, 0, "terminal children never marked");
    eq(errors.length, 0, "no errors");
    const reg = readBack("run-terminal");
    eq(reg.children["child-c"].status, "exited", "exited untouched");
    eq(reg.children["child-d"].status, "crashed", "crashed untouched");
    eq(reg.children["child-e"].status, "stopped", "stopped untouched");
  });

  await test("run dir without children.json skipped; corrupt children.json → error entry, no throw", async () => {
    mkdirSync(join(stateHome, "run-no-registry"), { recursive: true });
    mkdirSync(join(stateHome, "run-corrupt"), { recursive: true });
    writeFileSync(join(stateHome, "run-corrupt", "children.json"), "{ not json", "utf8");
    let result = null;
    try {
      result = markOrphans({ stateRoot: stateHome, containerStart: CONTAINER_START, now: NOW });
    } catch (err) {
      fail(`markOrphans must not throw on a bad run dir: ${err.message}`);
    }
    eq(result.errors.length, 1, "exactly one error entry");
    eq(result.errors[0].runId, "run-corrupt", "the corrupt run is named");
    ok(result.errors[0].error.includes("not readable JSON"), `error carries the parse problem: ${result.errors[0].error}`);
    ok(!result.errors.some((e) => e.runId === "run-no-registry"), "a dir without children.json is skipped, not an error");
  });

  await test("idempotent: a second markOrphans marks 0", async () => {
    registry("run-idem", {
      "child-f": { childId: "child-f", status: "running", startedAt: BEFORE, turns: [{ startedAt: BEFORE }] },
    });
    const first = markOrphans({ stateRoot: stateHome, containerStart: CONTAINER_START, now: NOW });
    eq(first.marked.length, 1, "first pass marks the orphan");
    const second = markOrphans({ stateRoot: stateHome, containerStart: CONTAINER_START, now: NOW });
    eq(second.marked.length, 0, "second pass marks nothing");
    const child = readBack("run-idem").children["child-f"];
    eq(child.status, "crashed", "still crashed");
    eq(child.turns[0].endedAt, NOW.toISOString(), "endedAt unchanged by the second pass");
  });

  await test("a starting child before containerStart → crashed too", async () => {
    registry("run-starting", {
      "child-g": { childId: "child-g", status: "starting", startedAt: BEFORE, turns: [] },
    });
    const { marked } = markOrphans({ stateRoot: stateHome, containerStart: CONTAINER_START, now: NOW });
    eq(marked.length, 1, "starting child marked");
    eq(marked[0].turn, 0, "no turns yet → turn 0");
    const child = readBack("run-starting").children["child-g"];
    eq(child.status, "crashed", "starting child crashed");
    eq(child.orphanedBy, "container-restart", "orphanedBy recorded");
  });

  await test("child with missing startedAt → left alone, reported as unknown", async () => {
    registry("run-unknown", {
      "child-h": { childId: "child-h", status: "running", turns: [{}] },
      "child-i": { childId: "child-i", status: "running", startedAt: "not a date" },
    });
    const { marked, unknown } = markOrphans({ stateRoot: stateHome, containerStart: CONTAINER_START, now: NOW });
    eq(marked.length, 0, "nothing marked");
    eq(unknown.length, 2, "both children reported unknown");
    eq(unknown.map((u) => u.childId).sort().join(","), "child-h,child-i", "unknown children named");
    eq(readBack("run-unknown").children["child-h"].status, "running", "missing startedAt left untouched");
    eq(readBack("run-unknown").children["child-i"].status, "running", "unparseable startedAt left untouched");
  });

  console.log("\nsupervisor-orphans: containerStartMs with injected readFile");

  // /proc/1/stat: fields 3..21 after the last ")" are zeros, field 22 = 500;
  // comm "sleep infinity" carries a space, which is why parsing starts after
  // the LAST parenthesis. Built positionally so the field count cannot drift.
  const PROC_1_STAT = ["1 (sleep infinity) S", ...Array(18).fill("0"), "500", "0", "0"].join(" ") + "\n";
  const procReadFile = (path) => {
    if (path === "/proc/stat") return "btime 1000\n";
    if (path === "/proc/1/stat") return PROC_1_STAT;
    throw new Error(`unexpected path ${path}`);
  };

  await test("btime 1000 + starttime 500 at CLK_TCK 100 → (1000 + 5) * 1000", async () => {
    eq(containerStartMs({ readFile: procReadFile, clkTck: 100 }), 1_005_000, "container start in epoch ms");
  });

  await test("injected readFile that throws → null (never guess)", async () => {
    eq(containerStartMs({ readFile: () => { throw new Error("no /proc"); }, clkTck: 100 }), null, "unreadable /proc → null");
  });

  await test("missing btime line → null", async () => {
    eq(containerStartMs({ readFile: (path) => (path === "/proc/stat" ? "cpu 0 0 0 0\n" : PROC_1_STAT), clkTck: 100 }), null, "no btime → null");
  });
} finally {
  rmSync(stateHome, { recursive: true, force: true });
}

console.log(`\nsupervisor-orphans: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("FAILURES:\n - " + failures.join("\n - "));
  process.exit(1);
}
