// scripts/supervisor-watch-dead-intermediate-reap.test.mjs — the REAL orphan
// shape on win32 (FOC-1168): a DEAD intermediate between the child and what it
// left behind. The FOC-1162 reap walks the process table from the child's pid
// through LIVE rows only, so `child → X (dead) → Y (alive)` is never reached —
// Y survives every finalize. Every real host orphan on 2026-11-02 had this
// shape (server-codegraph.mjs dead → codegraph serve grandchild; bash dead →
// env.exe → node --test suites), and a read-only run of the FOC-1162 rules
// over 237 turns found 0 processes while those orphans were alive.
//
// End-to-end through supervisor-watch.mjs with a fake claude behind the
// LA_CLAUDE_BIN seam (the same seam supervisor-watch.test.mjs and the
// FOC-1162 grandchild-reap e2e use):
//
//   fake claude (the child) spawns an INTERMEDIATE (its own child, so the
//   intermediate's ppid is the child's pid); the intermediate spawns a
//   long-lived DETACHED grandchild, writes both pids to LINEAGE_PID_FILE, then
//   STAYS ALIVE ~3 s so a lineage tick can see it, and exits; the child waits
//   for the intermediate and exits 0. At finalize the intermediate is already
//   gone from the process table — the pre-fix walk stops at the hole.
//
// The grandchild must be gone after the NORMAL-path finalize. On the pre-fix
// tree the reap never reaches it → RED.
//
// The intermediate's 3 s lifetime is what makes this test fair rather than
// vacuous: the watcher's first lineage tick (shortly after spawn) must see the
// intermediate ALIVE to remember it — a short-lived intermediate no tick saw
// stays a documented safe miss (FOC-1168). 3 s ≫ the tick delay, ≪ the 15 s
// poll window; the grandchild's 60 s lifetime ≫ the whole test, so it cannot
// die of old age inside the window and fake a pass.
//
// Teardown is unconditional: the test kills its own intermediate (if it somehow
// lingers) and grandchild via killTree force on process.exit — a RED run must
// never leak the very strays this bug describes.
//
// Everything runs in temp dirs (LA_SUPERVISOR_STATE_HOME, LA_SQUAD_HOME,
// CLAUDE_CONFIG_DIR, LA_SUPERVISOR_NO_TELEMETRY=1, LA_SUPERVISOR_NO_CODEGRAPH=1).
//
// Run: node scripts/supervisor-watch-dead-intermediate-reap.test.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ensureRunDir,
  killTree,
  readRegistry,
  readWakeQueue,
  writeRegistry,
} from "./supervisor-lib.mjs";
import { scrubbedEnv } from "./supervisor-test-fixtures.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WATCH = join(ROOT, "scripts", "supervisor-watch.mjs");

let passed = 0;
const failures = [];
const pending = [];
function test(name, fn) {
  const settle = (err) => {
    if (err) {
      failures.push(name);
      console.log(`  FAIL ${name}\n       ${err.message}`);
    } else {
      passed++;
      console.log(`  PASS ${name}`);
    }
  };
  try {
    const r = fn();
    if (r instanceof Promise) pending.push(r.then(() => settle(), settle));
    else settle();
  } catch (err) {
    settle(err);
  }
}

const base = mkdtempSync(join(tmpdir(), "la-watch-dead-intermediate-"));
const stateHome = join(base, "state");
const squadHome = join(base, "agents");
const configDir = join(base, "config");
const cwd = join(base, "wt");
// Pinned BEFORE any supervisor-lib call: the fixture registry must land in the
// temp tree, never in the repo's real .state/supervisor/.
process.env.LA_SUPERVISOR_STATE_HOME = stateHome;
process.env.LA_SQUAD_HOME = squadHome;
mkdirSync(stateHome, { recursive: true });
mkdirSync(join(squadHome, "dev"), { recursive: true });
mkdirSync(configDir, { recursive: true });
mkdirSync(cwd, { recursive: true });
process.on("exit", () => {
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {}
});

// The intermediate: its own module so the child can spawn it by path. It
// spawns the DETACHED grandchild (60 s lifetime ≫ the whole test, stdio
// ignored so it cannot hold any pipe), records both pids, then STAYS ALIVE for
// 3 s — long enough for the watcher's post-spawn lineage tick to see it in the
// table — and exits. Its death is the whole point: from that moment the
// pre-fix reap has no live row to walk through.
const FAKE_ORPHAN_INTERMEDIATE = join(base, "fake-orphan-intermediate.mjs");
writeFileSync(
  FAKE_ORPHAN_INTERMEDIATE,
  [
    `import { spawn } from "node:child_process";`,
    `import { writeFileSync } from "node:fs";`,
    `const gc = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: "ignore" });`,
    `gc.unref();`,
    `writeFileSync(process.env.LINEAGE_PID_FILE, JSON.stringify({ intermediatePid: process.pid, grandchildPid: gc.pid }));`,
    `setTimeout(() => process.exit(0), 3000);`,
    ``,
  ].join("\n"),
);

// The fake claude (the watched child): behave well enough for a turn (init +
// result), spawn the intermediate, wait for it to die, then exit 0 — the
// NORMAL exit, so finalizeTurn runs the reap and never a kill path.
const FAKE_CLAUDE_DEAD_INTERMEDIATE = join(base, "fake-claude-dead-intermediate.mjs");
writeFileSync(
  FAKE_CLAUDE_DEAD_INTERMEDIATE,
  [
    `import { spawn } from "node:child_process";`,
    `const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");`,
    `out({ type: "system", subtype: "init", session_id: process.env.FAKE_SESSION_ID, tools: [], model: "fake/model" });`,
    `out({ type: "result", subtype: "success", session_id: process.env.FAKE_SESSION_ID, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } });`,
    `const intermediate = spawn(process.execPath, [process.env.FAKE_ORPHAN_INTERMEDIATE], {`,
    `  stdio: "ignore",`,
    `  env: { ...process.env, LINEAGE_PID_FILE: process.env.LINEAGE_PID_FILE },`,
    `});`,
    `intermediate.on("exit", () => setTimeout(() => process.exit(0), 300));`,
    ``,
  ].join("\n"),
);

const promptFile = join(base, "prompt.txt");
writeFileSync(promptFile, "kickoff", "utf8");

const runId = "test-watch-dead-intermediate-reap";
const EXIT_KEY = `exit:dev-1:0`;
// The teardown mark, carried the way production carries it (FOC-808, slice B).
const CHILD_MARK = `${runId}/dev-1/dev-1:turn:0`;

ensureRunDir(runId);
writeRegistry(runId, {
  runId,
  children: {
    "dev-1": {
      childId: "dev-1",
      squad: "dev",
      taskId: "FOC-1168",
      status: "starting",
      mark: CHILD_MARK,
      sessionId: null,
      costUsd: 0,
      turns: [],
      worktree: cwd,
      permissionMode: "bypassPermissions",
    },
  },
  rounds: {},
});

const spawned = [];
const spawnWatcher = () =>
  spawn(
    process.execPath,
    [WATCH, "--run", runId, "--child", "dev-1", "--cwd", cwd, "--prompt-file", promptFile, "--turn", "0"],
    {
      cwd: ROOT,
      stdio: "ignore",
      env: {
        ...scrubbedEnv(),
        FENIX_IN_CONTAINER: "",
        FENIX_CHILD_ISOLATION: "",
        LA_SUPERVISOR_STATE_HOME: stateHome,
        LA_SQUAD_HOME: squadHome,
        LA_CHILD_MARK: CHILD_MARK,
        CLAUDE_CONFIG_DIR: configDir,
        LA_SUPERVISOR_NO_TELEMETRY: "1",
        LA_SUPERVISOR_NO_CODEGRAPH: "1",
        LA_CLAUDE_BIN: FAKE_CLAUDE_DEAD_INTERMEDIATE,
        FAKE_SESSION_ID: `${runId}-session`,
        FAKE_ORPHAN_INTERMEDIATE,
        LINEAGE_PID_FILE: lineagePidFile,
      },
    },
  );

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForExitRow(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = readWakeQueue(runId);
    const exit = rows.find((r) => r.dedupKey === EXIT_KEY);
    if (exit) return exit;
    await sleep(150);
  }
  throw new Error(`the watcher never enqueued ${EXIT_KEY} within ${timeoutMs} ms`);
}

// Liveness by PID EXISTENCE only — signal 0, cross-platform. ESRCH is the one
// unambiguous "no such process" answer; success or EPERM both mean something
// is there.
const aliveBySignal = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== "ESRCH";
  }
};

const lineagePidFile = join(base, "lineage.pids.json");
const readPids = () => {
  try {
    const parsed = JSON.parse(readFileSync(lineagePidFile, "utf8"));
    return /^\d+$/.test(String(parsed.intermediatePid)) && /^\d+$/.test(String(parsed.grandchildPid))
      ? parsed
      : null;
  } catch {
    return null; // the intermediate never got as far as spawning — nothing to reap
  }
};

// Unconditional teardown: the test's own intermediate and grandchild die no
// matter how the assertions land. Tracked globally so an early throw still
// reaps them.
process.on("exit", () => {
  const pids = readPids();
  if (!pids) return;
  for (const pid of [pids.intermediatePid, pids.grandchildPid]) killTree(pid, "force");
});

const watcher = spawnWatcher();
spawned.push(watcher);

test("the child exits 0 and the watcher finalizes the NORMAL path", async () => {
  const exit = await waitForExitRow();
  assert.equal(exit.event, "exit", "the event type must be exit");
  assert.equal(exit.childId, "dev-1");
  assert.equal(exit.turn, 0);
  assert.equal(exit.detail?.status, "exited", `expected a clean exit, got ${exit.detail?.status}`);
  assert.equal(exit.detail?.exitCode, 0, "the child's exit code was not 0");
  // The registry terminal state too — finalize really completed.
  const deadline = Date.now() + 15_000;
  let entry;
  while (Date.now() < deadline) {
    entry = readRegistry(runId).children["dev-1"];
    if (entry?.status === "exited") break;
    await sleep(100);
  }
  assert.equal(entry?.status, "exited", `the registry status was ${entry?.status ?? "no entry"}`);
  assert.equal(entry?.exitCode, 0, "the registry exit code was not 0");
});

test("the watcher process exits after finalizing", async () => {
  await waitForExitRow();
  const deadline = Date.now() + 10_000;
  while (watcher.exitCode === null && watcher.signalCode === null && Date.now() < deadline) {
    await sleep(100);
  }
  assert.ok(
    watcher.exitCode !== null || watcher.signalCode !== null,
    "the watcher outlived the finalize",
  );
  if (watcher.exitCode !== null) assert.equal(watcher.exitCode, 0);
});

test("the grandchild under the DEAD intermediate is GONE after the normal-path finalize", async () => {
  await waitForExitRow();
  const pids = readPids();
  assert.ok(pids, `the intermediate never recorded its pids (${lineagePidFile} missing or unreadable)`);
  // The intermediate must actually be dead by now — the shape under test. If
  // it were alive the reap would reach the grandchild through a LIVE row and
  // the test would pass without exercising the defect.
  assert.ok(!aliveBySignal(pids.intermediatePid), "the intermediate is unexpectedly still alive");
  // A bounded poll AFTER finalize: on a fixed tree the reap has already run by
  // the time the exit row lands, so the first probe settles it; the window
  // only allows for watcher shutdown jitter. 15 s ≪ the grandchild's 60 s
  // lifetime — it cannot expire inside the window and fake a pass.
  const deadline = Date.now() + 15_000;
  let alive = true;
  while (Date.now() < deadline) {
    alive = aliveBySignal(pids.grandchildPid);
    if (!alive) break;
    await sleep(500);
  }
  assert.ok(
    !alive,
    `RED (FOC-1168): grandchild pid ${pids.grandchildPid} under the DEAD intermediate pid ${pids.intermediatePid} SURVIVED the child's normal-path finalize (exit 0) — still alive 15s past finalize`,
  );
});

console.log("");
await Promise.allSettled(pending);
if (failures.length) {
  console.log(`${passed} passed, ${failures.length} FAILED`);
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);
