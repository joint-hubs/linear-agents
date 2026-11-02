// scripts/supervisor-watch-grandchild-reap.test.mjs — a grandchild spawned by a
// supervisor-watched child must NOT survive the child's NORMAL-path finalize
// (exit 0) on win32 (FOC-1162).
//
// End-to-end through supervisor-watch.mjs with a fake claude behind the
// LA_CLAUDE_BIN seam (the same seam supervisor-watch.test.mjs and
// supervisor-watch-linger.test.mjs use). The bug: the normal-path finalizeTurn
// reaps strays only through the FOC-808 sweep (sweepChildProcesses), which is
// /proc-only — on win32 it returns skipped: "no /proc" and kills nothing. The
// child's own exit takes nothing else with it (no process-group signal runs on
// the exit-0 path), so a detached grandchild the child spawned simply survives
// the finalize and is left orphaned on the box.
//
//   AC-1: fake claude emits system/init, spawns a long-lived DETACHED grandchild
//         (node -e setTimeout 60 s, detached, stdio ignore — no pipe hold, so
//         `close` fires promptly), writes the grandchild pid to GC_PID_FILE and
//         exits 0. The watcher finalizes the NORMAL path (exit row, registry
//         status "exited", exitCode 0). THEN the grandchild must be gone.
//         On the current code the grandchild is still alive → RED.
//
// Liveness is verified by PID EXISTENCE only — signal 0 (ESRCH means dead,
// any other answer means alive), which works identically on win32 and POSIX.
// The poll window is bounded (15 s past finalize) so a fixed tree can pass;
// 15 s ≪ the grandchild's 60 s lifetime, so it cannot die of old age inside
// the window and fake a pass.
//
// Teardown is unconditional: the test's own grandchild is killed (taskkill /T
// /F via killTree) whether the assertion passes, fails or throws — a RED run
// must never leak the very stray this bug describes.
//
// Everything runs in temp dirs (LA_SUPERVISOR_STATE_HOME, LA_SQUAD_HOME,
// CLAUDE_CONFIG_DIR, LA_SUPERVISOR_NO_TELEMETRY=1, LA_SUPERVISOR_NO_CODEGRAPH=1).
//
// Run: node scripts/supervisor-watch-grandchild-reap.test.mjs

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
  teeAbsPath,
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

const base = mkdtempSync(join(tmpdir(), "la-watch-grandchild-"));
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

// The fake is a generated .mjs file with its OWN module scope — the `out`
// helper is defined INSIDE the fake, not borrowed from this test module.
const FAKE_CLAUDE_GRANDCHILD = join(base, "fake-claude-grandchild.mjs");
const gcPidFile = join(base, "grandchild.pid");
writeFileSync(
  FAKE_CLAUDE_GRANDCHILD,
  [
    `import { spawn } from "node:child_process";`,
    `import { writeFileSync } from "node:fs";`,
    `const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");`,
    `out({ type: "system", subtype: "init", session_id: process.env.FAKE_SESSION_ID, tools: [], model: "fake/model" });`,
    // The grandchild: long-lived (60 s ≫ the whole test), detached so the
    // parent's exit takes nothing with it, stdio ignored so it cannot hold the
    // child's stdout pipe open (close must fire on the child's own exit).
    `const gc = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: "ignore" });`,
    `gc.unref();`,
    `writeFileSync(process.env.GC_PID_FILE, String(gc.pid));`,
    `process.exit(0); // the NORMAL exit — finalizeTurn(0), never a kill`,
    ``,
  ].join("\n"),
);

const promptFile = join(base, "prompt.txt");
writeFileSync(promptFile, "kickoff", "utf8");

const runId = "test-watch-grandchild-reap";
const EXIT_KEY = `exit:dev-1:0`;

ensureRunDir(runId);
writeRegistry(runId, {
  runId,
  children: {
    "dev-1": {
      childId: "dev-1",
      squad: "dev",
      taskId: "FOC-1162",
      status: "starting",
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
        CLAUDE_CONFIG_DIR: configDir,
        LA_SUPERVISOR_NO_TELEMETRY: "1",
        LA_SUPERVISOR_NO_CODEGRAPH: "1",
        LA_CLAUDE_BIN: FAKE_CLAUDE_GRANDCHILD,
        FAKE_SESSION_ID: `${runId}-session`,
        GC_PID_FILE: gcPidFile,
      },
    },
  );

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Waits for the turn's exit wake row — the same shape the linger test uses.
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
// is there. (A powershell CIM probe here would report every pid dead on a
// POSIX host — empty stdout — and pass the test vacuously.)
const aliveBySignal = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== "ESRCH";
  }
};

const grandchildPid = () => {
  try {
    const s = readFileSync(gcPidFile, "utf8").trim();
    return /^\d+$/.test(s) ? Number(s) : null;
  } catch {
    return null; // the fake never got as far as spawning — nothing to reap
  }
};

// Unconditional teardown: the test's own grandchild dies no matter how the
// assertions land. Tracked globally so an early throw still reaps it.
process.on("exit", () => {
  const pid = grandchildPid();
  if (pid) killTree(pid, "force");
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
  assert.equal(exit.detail?.finishedLingering, undefined, "a normal exit must not be marked as a reap");
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

test("the grandchild spawned by the child is GONE after the normal-path finalize", async () => {
  await waitForExitRow();
  const pid = grandchildPid();
  assert.ok(pid, `the fake claude never recorded a grandchild pid (${gcPidFile} missing or unreadable)`);
  // A bounded poll AFTER finalize: on a fixed tree the sweep/reap has already
  // run by the time the exit row lands, so the first probe settles it; the
  // window only allows for watcher shutdown jitter. 15 s ≪ the grandchild's
  // 60 s lifetime — it cannot expire inside the window and fake a pass.
  const deadline = Date.now() + 15_000;
  let alive = true;
  while (Date.now() < deadline) {
    alive = aliveBySignal(pid);
    if (!alive) break;
    await sleep(500);
  }
  assert.ok(!alive, `RED (FOC-1162): grandchild pid ${pid} SURVIVED the child's normal-path finalize (exit 0) — still alive ${15}s past finalize`);
});

console.log("");
await Promise.allSettled(pending);
if (failures.length) {
  console.log(`${passed} passed, ${failures.length} FAILED`);
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);
