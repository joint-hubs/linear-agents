// scripts/supervisor-watch-linger.test.mjs — a turn whose LAST stream event is a
// terminal `result` must not be reported as stalled (FOC-1154).
//
// End-to-end through supervisor-watch.mjs, with a fake claude behind the
// LA_CLAUDE_BIN seam (the same seam supervisor-watch.test.mjs uses). The bug:
// scanStall judges silence from the tee's size and mtime alone, so a child that
// emitted `result success` and then lingers (the win32 reality — claude never
// exits on its own after the result) looks exactly like a silent child, and the
// watcher queues a false `stall` row after the SLA, wasting a Supervisor wake.
//
//   AC-1: init + `result success`, then the child hangs → NO stall row; the
//         watcher reaps the child after a short grace and finalizes through the
//         NORMAL finalizeTurn path — an `exit:<childId>:<turn>` wake row, the
//         registry's normal terminal status, and the watcher process exits.
//   AC-2: init only (a NON-terminal last event), then silence → the `stall` row
//         still appears after the SLA, one row per silence episode (FOC-621).
//
// Real claude can emit MULTIPLE cumulative result events in one turn
// (background-task wake-ups re-emit, see supervisor-watch-cost.test.mjs), so
// the gate is "the LAST parsed event is a result", never "a result was seen".
//
// Everything runs in temp dirs (LA_SUPERVISOR_STATE_HOME, LA_SQUAD_HOME,
// CLAUDE_CONFIG_DIR, LA_SUPERVISOR_NO_TELEMETRY=1, LA_SUPERVISOR_NO_CODEGRAPH=1)
// and the stall SLA is shrunk through the existing LA_SUPERVISOR_POLL_MS seam
// ("1000" → stallSilenceMs() = 5 s), so the whole file stays in the tens of
// seconds. Test pids come ONLY from the fixtures' own registry entries — the
// suite never scans for or kills processes it did not spawn.
//
// Run: node scripts/supervisor-watch-linger.test.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureRunDir, killTree, readRegistry, readWakeQueue, teeAbsPath, writeRegistry } from "./supervisor-lib.mjs";
import { scrubbedEnv } from "./supervisor-test-fixtures.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WATCH = join(ROOT, "scripts", "supervisor-watch.mjs");

let passed = 0;
const failures = [];
const pending = [];
function test(name, fn) {
  // An async fn is supported for the tests that must wait on the event loop:
  // a child-process object only learns of an exit on a loop tick, which a
  // synchronous Atomics.wait spin never gives it (the FOC-802 pattern).
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

const base = mkdtempSync(join(tmpdir(), "la-watch-linger-"));
const stateHome = join(base, "state");
const squadHome = join(base, "agents");
const configDir = join(base, "config");
const cwd = join(base, "wt");
// Pinned BEFORE any supervisor-lib call: the fixture registries must land in
// the temp tree, never in the repo's real .state/supervisor/.
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

// The SLA seam: pollBaseMs() = 1 s → stallSilenceMs() = 5 s. The linger grace
// (seconds, fixed in the watcher) must stay well inside every wait deadline
// below while still exceeding one scanner tick.
process.env.LA_SUPERVISOR_POLL_MS = "1000";
const STALL_SLA_MS = 5_000;

// AC-1 fake: emits system/init + a terminal `result success`, then LINGERS —
// keeps its event loop alive without ever writing another byte. On win32 this
// is exactly what real claude does after the result.
const FAKE_CLAUDE_LINGER = join(base, "fake-claude-linger.mjs");
writeFileSync(
  FAKE_CLAUDE_LINGER,
  [
    `const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");`,
    `out({ type: "system", subtype: "init", session_id: process.env.FAKE_SESSION_ID, tools: [], model: "fake/model" });`,
    `out({ type: "result", subtype: "success", session_id: process.env.FAKE_SESSION_ID, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } });`,
    `setInterval(() => {}, 1 << 30); // the turn never ends on its own`,
    ``,
  ].join("\n"),
);

// AC-2 fake: emits system/init (a NON-terminal event) and then goes silent —
// the exact shape the stall SLA exists for.
const FAKE_CLAUDE_SILENT = join(base, "fake-claude-silent.mjs");
writeFileSync(
  FAKE_CLAUDE_SILENT,
  [
    `const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");`,
    `out({ type: "system", subtype: "init", session_id: process.env.FAKE_SESSION_ID, tools: [], model: "fake/model" });`,
    `setInterval(() => {}, 1 << 30); // silent from here on`,
    ``,
  ].join("\n"),
);

const promptFile = join(base, "prompt.txt");
writeFileSync(promptFile, "kickoff", "utf8");

function fixtureChild(runId) {
  ensureRunDir(runId);
  writeRegistry(runId, {
    runId,
    children: {
      "dev-1": {
        childId: "dev-1",
        squad: "dev",
        taskId: "FOC-999",
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
}

// Every spawned watcher is tracked and reaped on process exit, so a failing
// assertion can never leak a lingering watcher or fake claude into the box.
const spawned = [];
function spawnWatcher(runId, fakeBin) {
  const watcher = spawn(
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
        LA_SUPERVISOR_POLL_MS: process.env.LA_SUPERVISOR_POLL_MS,
        LA_CLAUDE_BIN: fakeBin,
        FAKE_SESSION_ID: `${runId}-session`,
      },
    },
  );
  spawned.push(watcher);
  return watcher;
}

// The child's pid comes ONLY from the fixture's own registry entry (the watcher
// records it at spawn) — never a scan, never a guess.
const fixturePid = (runId) => {
  const entry = readRegistry(runId).children["dev-1"];
  return entry?.pid ?? entry?.turns?.[entry.turns.length - 1]?.pid ?? null;
};

function reapAll(runId) {
  const pid = fixturePid(runId);
  if (pid) killTree(pid, "force");
  for (const w of spawned.splice(0)) {
    try {
      w.kill();
    } catch {}
  }
}
process.on("exit", () => {
  for (const runId of ["test-watch-linger-result", "test-watch-linger-silent"]) {
    try {
      const pid = fixturePid(runId);
      if (pid) killTree(pid, "force");
    } catch {}
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Waits for the turn's exit wake row, failing fast the moment a stall row shows
// up (that is the regression, and on the unfixed tree it lands one scanner tick
// past the SLA — the red evidence). An async fn body runs synchronously until
// its first await, so every post-spawn assertion below MUST go through this
// wait first — a direct read at t0 would only see an empty queue.
async function waitForExitRow(runId, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = readWakeQueue(runId);
    const stallRows = rows.filter((r) => r.event === "stall");
    if (stallRows.length) {
      throw new Error(`a false stall row was queued for a finished turn: ${JSON.stringify(stallRows[0] ?? null)}`);
    }
    const exit = rows.find((r) => r.dedupKey === EXIT_KEY);
    if (exit) return exit;
    await sleep(150);
  }
  throw new Error(`the watcher never enqueued ${EXIT_KEY} within ${timeoutMs} ms`);
}

// ── AC-1: a terminal result is not a stall — the linger is reaped ────────────
console.log("\nAC-1: init + result, potem cisza — keine stall, reaping przez finalizeTurn (FOC-1154)");

const runIdResult = "test-watch-linger-result";
fixtureChild(runIdResult);
const watcherResult = spawnWatcher(runIdResult, FAKE_CLAUDE_LINGER);

const EXIT_KEY = `exit:dev-1:0`;

test("no stall row is ever queued for a turn whose last event is a terminal result", async () => {
  await waitForExitRow(runIdResult);
  assert.equal(
    readWakeQueue(runIdResult).filter((r) => r.event === "stall").length,
    0,
    "a stall row was queued for a turn whose last event was a terminal result",
  );
});

test("the exit row arrives through the NORMAL finalizeTurn path", async () => {
  const exit = await waitForExitRow(runIdResult);
  assert.equal(exit.event, "exit", "the event type must be exit, not a new class");
  assert.equal(exit.childId, "dev-1");
  assert.equal(exit.turn, 0);
  const status = exit.detail?.status;
  assert.ok(
    status === "exited" || status === "waiting_gate",
    `the normal terminal status was expected, got ${status}`,
  );
});

test("the registry carries the normal terminal status after the reap", async () => {
  await waitForExitRow(runIdResult);
  // Bounded: the watcher may still have its telemetry end + process.exit to do
  // after the row, and some orderings write the registry a beat later.
  const deadline = Date.now() + 15_000;
  let entry;
  while (Date.now() < deadline) {
    entry = readRegistry(runIdResult).children["dev-1"];
    if (["exited", "waiting_gate"].includes(entry?.status)) break;
    await sleep(100);
  }
  assert.ok(
    ["exited", "waiting_gate"].includes(entry?.status),
    `the turn was not finalized normally: ${entry?.status ?? "no entry"}`,
  );
});

test("the watcher process actually exits after reaping the lingering child", async () => {
  await waitForExitRow(runIdResult);
  const deadline = Date.now() + 10_000;
  while (watcherResult.exitCode === null && watcherResult.signalCode === null && Date.now() < deadline) {
    await sleep(100);
  }
  assert.ok(
    watcherResult.exitCode !== null || watcherResult.signalCode !== null,
    "the watcher outlived the reap — the linger would burn the wake budget forever",
  );
  if (watcherResult.exitCode !== null) assert.equal(watcherResult.exitCode, 0);
  reapAll(runIdResult); // the child is already dead on the fixed tree; a no-op there
});

// ── AC-2: a non-terminal last event still stalls, exactly as today ───────────
console.log("\nAC-2: init bez wyniku, cisza — stall po SLA jak dotad (FOC-621 nietknięty)");

const runIdSilent = "test-watch-linger-silent";
fixtureChild(runIdSilent);
const watcherSilent = spawnWatcher(runIdSilent, FAKE_CLAUDE_SILENT);

test("a silent child whose last event is NOT a result still produces a stall row after the SLA", async () => {
  const deadline = Date.now() + STALL_SLA_MS + 25_000;
  let stallRows = [];
  while (Date.now() < deadline) {
    stallRows = readWakeQueue(runIdSilent).filter((r) => r.event === "stall");
    if (stallRows.length) break;
    await sleep(150);
  }
  assert.ok(stallRows.length > 0, "no stall row within the SLA — the stall regression would hide a hung turn");
  const row = stallRows[0];
  assert.match(row.dedupKey, /^stall:dev-1:0:/, `the stall row lost its FOC-621 episode key: ${row.dedupKey}`);
  assert.ok(Number.isInteger(row.episode) && row.episode > 0, `episode must be the tee size at onset, got ${row.episode}`);
  assert.equal(row.episode, statSync(teeAbsPath(runIdSilent, "dev-1")).size, "episode is not the tee size at silence onset");
});

test("re-polls of the same silence dedup — still one row per episode", async () => {
  // Wait for the first row (the stall lands on a scanner tick, so up to two
  // ticks after the SLA), then one full extra SLA of re-polling must not add a
  // second row (FOC-621).
  const deadline = Date.now() + STALL_SLA_MS + 25_000;
  while (!readWakeQueue(runIdSilent).some((r) => r.event === "stall") && Date.now() < deadline) {
    await sleep(150);
  }
  await sleep(STALL_SLA_MS + 1_000);
  const stallRows = readWakeQueue(runIdSilent).filter((r) => r.event === "stall");
  assert.equal(stallRows.length, 1, `the same silence episode was recorded ${stallRows.length} times`);
  reapAll(runIdSilent);
});

console.log("");
await Promise.allSettled(pending);
if (failures.length) {
  console.log(`${passed} passed, ${failures.length} FAILED`);
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);
