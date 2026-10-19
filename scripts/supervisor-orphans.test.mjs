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
import os, { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const stateHome = mkdtempSync(join(tmpdir(), "supervisor-orphans-"));
process.env.LA_SUPERVISOR_STATE_HOME = stateHome;

const { containerStartMs, markOrphans, ORPHAN_ERROR, runOrphansCli } = await import("./supervisor-orphans.mjs");

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

  console.log("\nsupervisor-orphans: FOC-905 owner-aware scan");

  const HOST = os.hostname();
  // The current identity the fixtures relate against. markOrphans defaults to
  // currentOwner(), whose containerStartMs is unprovable on this Windows host —
  // every owner-aware test injects the value it needs.
  const CURRENT = {
    sessionId: null,
    hostname: HOST,
    containerStartMs: CONTAINER_START,
    pid: 1,
    recordedAt: "2026-06-01T00:00:00.000Z",
  };
  const writeOwner = (runId, over = {}) =>
    writeFileSync(join(stateHome, runId, "owner.json"), JSON.stringify({ ...CURRENT, ...over }), "utf8");

  await test("owner mine + turn before containerStart → marked (as today), relation recorded", async () => {
    registry("run-mine-before", {
      "child-m1": { childId: "child-m1", status: "running", startedAt: BEFORE, turns: [{ startedAt: BEFORE }] },
    });
    writeOwner("run-mine-before");
    const { marked, skipped, errors } = markOrphans({
      stateRoot: stateHome,
      containerStart: CONTAINER_START,
      now: NOW,
      current: CURRENT,
    });
    eq(marked.length, 1, "the mine orphan is marked");
    eq(marked[0].relation, "mine", "the marked entry names the relation");
    eq(skipped.length, 0, "nothing skipped");
    // Earlier sections left a deliberately corrupt run dir behind — its error
    // entry is expected; THIS run must not add one.
    ok(!errors.some((e) => e.runId === "run-mine-before"), "no errors for this run");
  });

  await test("owner mine + turn after containerStart → untouched", async () => {
    registry("run-mine-after", {
      "child-m2": { childId: "child-m2", status: "running", startedAt: AFTER, turns: [{ startedAt: AFTER }] },
    });
    writeOwner("run-mine-after");
    const { marked } = markOrphans({
      stateRoot: stateHome,
      containerStart: CONTAINER_START,
      now: NOW,
      current: CURRENT,
    });
    eq(marked.length, 0, "a live turn of this container stays untouched");
    eq(readBack("run-mine-after").children["child-m2"].status, "running");
  });

  await test("owner restarted → marked even with a recent turn", async () => {
    registry("run-restarted", {
      "child-r1": { childId: "child-r1", status: "running", startedAt: AFTER, turns: [{ startedAt: AFTER }] },
    });
    // The owner's container instance started BEFORE this one — it is gone.
    writeOwner("run-restarted", { containerStartMs: CONTAINER_START - 60_000 });
    const { marked } = markOrphans({
      stateRoot: stateHome,
      containerStart: CONTAINER_START,
      now: NOW,
      current: CURRENT,
    });
    eq(marked.length, 1, "the restarted owner's live child is marked");
    eq(marked[0].relation, "restarted", "relation restarted");
    eq(readBack("run-restarted").children["child-r1"].status, "crashed", "crashed despite the recent turn");
  });

  await test("owner foreign → skipped and untouched; only --all applies the time rule", async () => {
    registry("run-foreign", {
      "child-f1": { childId: "child-f1", status: "running", startedAt: BEFORE, turns: [{ startedAt: BEFORE }] },
    });
    writeOwner("run-foreign", { hostname: "other-container" });
    let res = markOrphans({
      stateRoot: stateHome,
      containerStart: CONTAINER_START,
      now: NOW,
      current: CURRENT,
    });
    eq(res.marked.length, 0, "a foreign run is never marked by default");
    eq(res.skipped.length, 1, "the foreign run is reported");
    eq(res.skipped[0].runId, "run-foreign", "the foreign run is named");
    eq(res.skipped[0].relation, "foreign", "relation foreign");
    eq(readBack("run-foreign").children["child-f1"].status, "running", "its children are untouched");

    res = markOrphans({
      stateRoot: stateHome,
      containerStart: CONTAINER_START,
      now: NOW,
      current: CURRENT,
      all: true,
    });
    eq(res.marked.length, 1, "with --all the time rule applies to the foreign run");
    eq(res.marked[0].relation, "foreign", "the marked entry still says whose run it was");
    eq(readBack("run-foreign").children["child-f1"].status, "crashed", "marked under the override");
  });

  await test("owner mine + owner session terminal in a temp task-sessions store → marked regardless of time", async () => {
    const { sqliteAvailable, createTaskSessionStore, readSessionRows } = await import("./task-sessions.mjs");
    if (!sqliteAvailable()) {
      console.log("  SKIP node:sqlite unavailable in this Node build");
      return;
    }
    const storeDir = mkdtempSync(join(tmpdir(), "supervisor-orphans-store-"));
    const store = createTaskSessionStore({ dbPath: join(storeDir, "task-sessions.sqlite") });
    try {
      // ensure() creates a queued row — queued is an active (non-terminal)
      // status, exactly what the first pass needs.
      const rec = store.ensure({
        taskKey: "acme:ENG-905",
        taskId: "ENG-905",
        workspace: "acme",
        issueId: "ENG-905",
      });

      registry("run-terminal-owner", {
        "child-t1": { childId: "child-t1", status: "running", startedAt: AFTER, turns: [{ startedAt: AFTER }] },
      });
      writeOwner("run-terminal-owner", { sessionId: rec.sessionId });

      // Active (non-terminal) session → the ordinary time rule: the recent
      // turn is untouched.
      let res = markOrphans({
        stateRoot: stateHome,
        containerStart: CONTAINER_START,
        now: NOW,
        current: CURRENT,
        sessions: readSessionRows(store.dbPath),
      });
      eq(res.marked.length, 0, "an active owner session does not shorten the rule");

      store.update(rec.sessionId, { status: "stopped" });
      res = markOrphans({
        stateRoot: stateHome,
        containerStart: CONTAINER_START,
        now: NOW,
        current: CURRENT,
        sessions: readSessionRows(store.dbPath),
      });
      eq(res.marked.length, 1, "a terminal owner session marks the run regardless of the turn time");
      eq(res.marked[0].relation, "mine", "relation mine");
      eq(readBack("run-terminal-owner").children["child-t1"].status, "crashed", "marked");
    } finally {
      store.close();
      rmSync(storeDir, { recursive: true, force: true });
    }
  });

  await test("no owner.json (legacy run) → today's rule, relation unknown", async () => {
    registry("run-legacy", {
      "child-l1": { childId: "child-l1", status: "running", startedAt: BEFORE, turns: [{ startedAt: BEFORE }] },
    });
    const { marked, skipped } = markOrphans({
      stateRoot: stateHome,
      containerStart: CONTAINER_START,
      now: NOW,
      current: CURRENT,
    });
    eq(marked.length, 1, "legacy runs are judged by the time rule exactly as before");
    eq(marked[0].relation, "unknown", "relation unknown");
    eq(skipped.length, 0, "a legacy run is never skipped");
  });

  console.log("\nsupervisor-orphans: FOC-905 CLI (--json, --all/--yes)");

  // runOrphansCli prints through console.log; capture without silencing the
  // harness's own lines.
  const capture = (fn) => {
    const lines = [];
    const orig = console.log;
    console.log = (line) => lines.push(String(line));
    try {
      return { lines, code: fn() };
    } finally {
      console.log = orig;
    }
  };

  await test("--json report shape: marked with relation, skipped foreign, unknown count", async () => {
    registry("run-json-mine", {
      "child-j1": { childId: "child-j1", status: "running", startedAt: BEFORE, turns: [{ startedAt: BEFORE }] },
    });
    writeOwner("run-json-mine");
    registry("run-json-foreign", {
      "child-j2": { childId: "child-j2", status: "running", startedAt: BEFORE, turns: [{ startedAt: BEFORE }] },
    });
    writeOwner("run-json-foreign", { hostname: "other-container" });
    registry("run-json-unknown", {
      "child-j3": { childId: "child-j3", status: "running", turns: [{}] }, // no startedAt
    });
    const { lines, code } = capture(() =>
      runOrphansCli({ argv: ["--container", "--json"], containerStart: CONTAINER_START }),
    );
    eq(code, 0, "the scan always exits 0");
    eq(lines.length, 1, "--json prints exactly the report");
    const report = JSON.parse(lines[0]);
    eq(report.containerStart, CONTAINER_START, "the report names the container start it judged by");
    eq(report.marked.length, 1, "the mine orphan is marked");
    eq(report.marked[0].runId, "run-json-mine", "marked runId");
    eq(report.marked[0].childId, "child-j1", "marked childId");
    eq(report.marked[0].relation, "mine", "marked relation");
    eq(report.skipped.length, 1, "the foreign run is skipped");
    eq(report.skipped[0].runId, "run-json-foreign", "skipped runId");
    eq(report.skipped[0].relation, "foreign", "skipped relation");
    eq(report.unknown, 3, "the unparseable-start children count as unknown (this one + the two from the legacy section)");
    eq(readBack("run-json-mine").children["child-j1"].status, "crashed", "mine marked");
    eq(readBack("run-json-foreign").children["child-j2"].status, "running", "foreign untouched");
  });

  await test("--all without --yes prints the foreign list and exits 2 (no marking)", async () => {
    const { lines, code } = capture(() =>
      runOrphansCli({ argv: ["--container", "--all"], containerStart: CONTAINER_START }),
    );
    eq(code, 2, "the override is two flags on purpose");
    ok(lines.some((l) => l.includes("skip run-json-foreign")), "the foreign list is printed");
    eq(readBack("run-json-foreign").children["child-j2"].status, "running", "still untouched");
  });

  await test("--all --yes marks the foreign run", async () => {
    const { code } = capture(() =>
      runOrphansCli({ argv: ["--container", "--all", "--yes"], containerStart: CONTAINER_START }),
    );
    eq(code, 0, "the confirmed override succeeds");
    eq(readBack("run-json-foreign").children["child-j2"].status, "crashed", "the foreign run was swept");
  });

  await test("CLI without --container → usage, exit 2", async () => {
    const errLines = [];
    const origErr = console.error;
    console.error = (line) => errLines.push(String(line));
    let code;
    try {
      code = runOrphansCli({ argv: [] });
    } finally {
      console.error = origErr;
    }
    eq(code, 2, "usage refusal exits 2");
    ok(errLines.some((l) => l.includes("usage:")), "the usage line is printed");
  });
  console.log("\nsupervisor-orphans: FOC-808 container sweep of dead children's strays");

  // The sweep's proc root is the LA_PROC_ROOT seam (sweepChildProcesses reads
  // it); a fixture tree of environ/comm files stands in for /proc here.
  const sweepTmp = mkdtempSync(join(tmpdir(), "supervisor-orphans-sweep-"));
  const procRoot = join(sweepTmp, "proc");
  const mkProc = (pid, env, comm) => {
    mkdirSync(join(procRoot, String(pid)), { recursive: true });
    writeFileSync(join(procRoot, String(pid), "environ"), env, "utf8");
    writeFileSync(join(procRoot, String(pid), "comm"), `${comm}\n`, "utf8");
  };
  const DEAD_MARK = "run-sweep/child-dead/child-dead:turn:0";
  const LIVE_MARK = "run-sweep/child-live/child-live:turn:0";
  // The sweep signals with the real process.kill and reports a pid that is not
  // a real process as not killed — so every stray that must be swept is a live
  // idle node process whose pid the fixture /proc tree names.
  const strays = [];
  const spawnStray = (env, comm) => {
    const p = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
    p.unref();
    strays.push(p.pid);
    mkProc(p.pid, env, comm);
    return p.pid;
  };
  const strayAlive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return err.code === "EPERM";
    }
  };
  process.on("exit", () => {
    for (const pid of strays) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  });
  const deadStray = spawnStray(`LA_CHILD_MARK=${DEAD_MARK}\0PATH=/usr/bin`, "pgserver");
  mkProc(4310002, `LA_CHILD_MARK=${LIVE_MARK}\0`, "liveserver");

  await test("a dead child's marked stray is swept; a live child's is not", async () => {
    registry("run-sweep", {
      // "running" but started before the container → markOrphans marks it
      // crashed, so the sweep then sees a terminal child and kills its stray.
      "child-dead": {
        childId: "child-dead",
        status: "running",
        pid: 4242,
        startedAt: BEFORE,
        turns: [{ startedAt: BEFORE }],
        mark: DEAD_MARK,
      },
      // Genuinely live: status running, pid alive (this test process).
      "child-live": {
        childId: "child-live",
        status: "running",
        pid: process.pid,
        startedAt: AFTER,
        turns: [{ startedAt: AFTER }],
        mark: LIVE_MARK,
      },
      // Terminal with a mark but no fixture process: swept, nothing matched.
      "child-gone": {
        childId: "child-gone",
        status: "exited",
        startedAt: AFTER,
        turns: [{ startedAt: AFTER }],
        mark: "run-sweep/child-gone/child-gone:turn:0",
      },
    });
    process.env.LA_PROC_ROOT = procRoot;
    try {
      const { lines, code } = capture(() =>
        runOrphansCli({ argv: ["--container", "--json"], containerStart: CONTAINER_START }),
      );
      eq(code, 0, "the scan still exits 0");
      const report = JSON.parse(lines[0]);
      eq(report.sweptPids.length, 1, `exactly one stray swept: ${JSON.stringify(report.sweptPids)}`);
      eq(report.sweptPids[0].pid, deadStray, "the dead child's stray was swept");
      ok(!strayAlive(deadStray), "the dead child's stray survived the sweep");
      eq(report.sweptPids[0].childId, "child-dead", "the swept entry names the child");
      eq(report.sweptPids[0].runId, "run-sweep", "the swept entry names the run");
      eq(report.sweptPids[0].comm, "pgserver", "the swept entry carries the comm");

      // The first run killed the stray; the text run needs a fresh one (the
      // old fixture entry goes, so a reused pid can never be matched).
      rmSync(join(procRoot, String(deadStray)), { recursive: true, force: true });
      const deadStray2 = spawnStray(`LA_CHILD_MARK=${DEAD_MARK}\0`, "pgserver");
      const { lines: textLines } = capture(() =>
        runOrphansCli({ argv: ["--container"], containerStart: CONTAINER_START }),
      );
      ok(
        textLines.some((l) => l.includes("orphans: killed 1 stray helper(s)")),
        `the text output carries no sweep line: ${JSON.stringify(textLines)}`,
      );
      ok(!strayAlive(deadStray2), "the second stray survived the sweep");
      rmSync(join(procRoot, String(deadStray2)), { recursive: true, force: true });
    } finally {
      delete process.env.LA_PROC_ROOT;
    }
  });

  await test("a pre-FOC-808 entry without a mark is skipped by the sweep", async () => {
    registry("run-sweep-legacy", {
      "child-old": {
        childId: "child-old",
        status: "exited",
        startedAt: BEFORE,
        turns: [{ startedAt: BEFORE }],
        // no mark field
      },
    });
    process.env.LA_PROC_ROOT = procRoot;
    const deadStray3 = spawnStray(`LA_CHILD_MARK=${DEAD_MARK}\0`, "pgserver");
    try {
      const { lines, code } = capture(() =>
        runOrphansCli({ argv: ["--container", "--json"], containerStart: CONTAINER_START }),
      );
      eq(code, 0);
      const report = JSON.parse(lines[0]);
      eq(report.sweptPids.length, 1, `only the earlier fixture stray again: ${JSON.stringify(report.sweptPids)}`);
      eq(report.sweptPids[0].pid, deadStray3, "the marked run's stray again, the markless entry contributed nothing");
    } finally {
      delete process.env.LA_PROC_ROOT;
    }
  });

  await test("a foreign run's dead child is not swept without --all --yes", async () => {
    const FOREIGN_MARK = "run-sweep-foreign/child-dead/child-dead:turn:0";
    registry("run-sweep-foreign", {
      "child-dead": {
        childId: "child-dead",
        status: "exited",
        startedAt: BEFORE,
        turns: [{ startedAt: BEFORE }],
        mark: FOREIGN_MARK,
      },
    });
    writeOwner("run-sweep-foreign", { hostname: "other-container" });
    const foreignStray = spawnStray(`LA_CHILD_MARK=${FOREIGN_MARK}\0`, "foreignserver");
    process.env.LA_PROC_ROOT = procRoot;
    try {
      const { lines, code } = capture(() =>
        runOrphansCli({ argv: ["--container", "--json"], containerStart: CONTAINER_START }),
      );
      eq(code, 0);
      const report = JSON.parse(lines[0]);
      ok(
        !report.sweptPids.some((s) => s.pid === foreignStray),
        `the foreign run's stray was swept: ${JSON.stringify(report.sweptPids)}`,
      );
      ok(strayAlive(foreignStray), "the foreign run's stray was killed");
    } finally {
      delete process.env.LA_PROC_ROOT;
      try {
        process.kill(foreignStray, "SIGKILL");
      } catch {}
    }
  });

  rmSync(sweepTmp, { recursive: true, force: true });
} finally {
  rmSync(stateHome, { recursive: true, force: true });
}

console.log(`\nsupervisor-orphans: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("FAILURES:\n - " + failures.join("\n - "));
  process.exit(1);
}
