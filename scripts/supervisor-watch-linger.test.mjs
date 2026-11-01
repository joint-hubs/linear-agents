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
//   AC-1: init + `result success`, then the child hangs → NO stall row; at the
//         SAME SLA the stall would have used, the watcher reaps the child and
//         finalizes through the NORMAL finalizeTurn path — an
//         `exit:<childId>:<turn>` wake row, the registry's normal terminal
//         status, and the watcher process exits. The reap REPLACES the stall,
//         it does not preempt it: at the SLA exactly one of the two fires.
//         (Review round 1 #1 — the threshold is stallSilenceMs(), not a
//         shorter grace, because a real child re-emits cumulative results
//         mid-turn and can then sit tee-silent for a background task's
//         duration; a sub-SLA grace would kill that healthy child.)
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
// ("1000" → stallSilenceMs() = 5 s; the re-emit scenario uses "4000" → 20 s to
// outrun the rejected sub-SLA grace), so the whole file stays around two
// minutes. Test pids come ONLY from the fixtures' own registry entries — the
// suite never scans for or kills processes it did not spawn.
//
// Run: node scripts/supervisor-watch-linger.test.mjs

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ensureRunDir,
  gatesDir,
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

// The fakes are generated .mjs files with their OWN module scope — the `out`
// helper must be defined INSIDE each fake, not borrowed from this test module.
const FAKE_OUT = `const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");`;
const FAKE_INIT = `out({ type: "system", subtype: "init", session_id: process.env.FAKE_SESSION_ID, tools: [], model: "fake/model" });`;
const FAKE_RESULT = `out({ type: "result", subtype: "success", session_id: process.env.FAKE_SESSION_ID, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } });`;
const FAKE_ASSISTANT = `out({ type: "assistant", message: { id: "post-rewake" } });`;
const FAKE_HANG = `setInterval(() => {}, 1 << 30); // the turn never ends on its own`;

// AC-1 fake: emits system/init + a terminal `result success`, then LINGERS —
// keeps its event loop alive without ever writing another byte. On win32 this
// is exactly what real claude does after the result.
const FAKE_CLAUDE_LINGER = join(base, "fake-claude-linger.mjs");
writeFileSync(FAKE_CLAUDE_LINGER, [FAKE_OUT, FAKE_INIT, FAKE_RESULT, FAKE_HANG, ``].join("\n"));

// AC-2 fake: emits system/init (a NON-terminal event) and then goes silent —
// the exact shape the stall SLA exists for.
const FAKE_CLAUDE_SILENT = join(base, "fake-claude-silent.mjs");
writeFileSync(FAKE_CLAUDE_SILENT, [FAKE_OUT, FAKE_INIT, FAKE_HANG, ``].join("\n"));

// Reset-path fake (review round 1 nit a): result, then a NON-terminal event —
// the gate flips off and the stall SLA must apply again.
const FAKE_CLAUDE_RESET = join(base, "fake-claude-reset.mjs");
writeFileSync(FAKE_CLAUDE_RESET, [FAKE_OUT, FAKE_INIT, FAKE_RESULT, FAKE_ASSISTANT, FAKE_HANG, ``].join("\n"));

// Re-arm fake (review round 1 nit c): result → non-terminal → result — the
// second terminal result re-arms the linger gate.
const FAKE_CLAUDE_REARM = join(base, "fake-claude-rearm.mjs");
writeFileSync(FAKE_CLAUDE_REARM, [FAKE_OUT, FAKE_INIT, FAKE_RESULT, FAKE_ASSISTANT, FAKE_RESULT, FAKE_HANG, ``].join("\n"));

// Re-emit fake (review round 1 #1): the HEALTHY mid-turn shape — a terminal
// result, a long tee-silent background wait (16 s: past the rejected 10 s
// grace, under the 20 s SLA this scenario runs with), a re-emitted result and
// more work, then a normal self-exit. A sub-SLA grace force-kills this child
// before the re-emit; the SLA-anchored reap must let it finish.
const FAKE_CLAUDE_REEMIT = join(base, "fake-claude-reemit.mjs");
writeFileSync(
  FAKE_CLAUDE_REEMIT,
  [
    FAKE_OUT,
    FAKE_INIT,
    FAKE_RESULT,
    `await new Promise((r) => setTimeout(r, 16000)); // the background task runs tee-silent`,
    FAKE_RESULT,
    FAKE_ASSISTANT,
    `process.exit(0);`,
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
function spawnWatcher(runId, fakeBin, pollMs = "1000") {
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
        LA_SUPERVISOR_POLL_MS: pollMs,
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

const ALL_RUN_IDS = [
  "test-watch-linger-result",
  "test-watch-linger-gate",
  "test-watch-linger-silent",
  "test-watch-linger-reset",
  "test-watch-linger-rearm",
];
process.on("exit", () => {
  for (const runId of ALL_RUN_IDS) {
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

const EXIT_KEY = `exit:dev-1:0`;
const reapNotedIn = (runId) => {
  try {
    return readFileSync(teeAbsPath(runId, "dev-1"), "utf8").includes("result_linger_reap");
  } catch {
    return false;
  }
};

// ── AC-1: a terminal result is not a stall — the linger is reaped at the SLA ──
console.log("\nAC-1: init + result, potem cisza — keine stall, reap na SLA przez finalizeTurn (FOC-1154)");

const runIdResult = "test-watch-linger-result";
fixtureChild(runIdResult);
const watcherResult = spawnWatcher(runIdResult, FAKE_CLAUDE_LINGER);

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
  assert.equal(exit.detail?.finishedLingering, true, "the reap marker is missing from the exit row");
  assert.ok(reapNotedIn(runIdResult), "the tee does not carry the result_linger_reap note");
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

// ── Gate precedence on the linger path (review round 1 nit b) ────────────────
console.log("\nAC-1b: lingering child + pending gate — waiting_gate wygrywa (FOC-1154)");

const runIdGate = "test-watch-linger-gate";
fixtureChild(runIdGate);
const watcherGate = spawnWatcher(runIdGate, FAKE_CLAUDE_LINGER);

test("a lingering child with a pending gate finalizes waiting_gate", async () => {
  // The gate appears while the child is still lingering — well before the
  // SLA-anchored reap fires.
  mkdirSync(gatesDir(runIdGate), { recursive: true });
  writeFileSync(
    join(gatesDir(runIdGate), "gate-linger.json"),
    JSON.stringify({ gateId: "gate-linger", childId: "dev-1", status: "pending", kind: "question" }),
  );
  const exit = await waitForExitRow(runIdGate);
  assert.equal(exit.detail?.status, "waiting_gate", `expected waiting_gate, got ${exit.detail?.status}`);
  assert.equal(
    readRegistry(runIdGate).children["dev-1"].status,
    "waiting_gate",
    "the registry did not record waiting_gate for the reaped turn",
  );
  assert.equal(
    readWakeQueue(runIdGate).filter((r) => r.event === "stall").length,
    0,
    "a stall row was queued despite the pending gate",
  );
  const deadline = Date.now() + 10_000;
  while (watcherGate.exitCode === null && watcherGate.signalCode === null && Date.now() < deadline) {
    await sleep(100);
  }
  assert.ok(
    watcherGate.exitCode !== null || watcherGate.signalCode !== null,
    "the watcher outlived the waiting_gate reap",
  );
  reapAll(runIdGate);
});

// ── AC-2: a non-terminal last event still stalls, exactly as today ───────────
console.log("\nAC-2: init bez wyniku, cisza — stall po SLA jak dotad (FOC-621 nietknięty)");

const runIdSilent = "test-watch-linger-silent";
fixtureChild(runIdSilent);
spawnWatcher(runIdSilent, FAKE_CLAUDE_SILENT);

test("a silent child whose last event is NOT a result still produces a stall row after the SLA", async () => {
  const deadline = Date.now() + 25_000 + 5_000;
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
  const deadline = Date.now() + 25_000 + 5_000;
  while (!readWakeQueue(runIdSilent).some((r) => r.event === "stall") && Date.now() < deadline) {
    await sleep(150);
  }
  await sleep(5_000 + 1_000);
  const stallRows = readWakeQueue(runIdSilent).filter((r) => r.event === "stall");
  assert.equal(stallRows.length, 1, `the same silence episode was recorded ${stallRows.length} times`);
  reapAll(runIdSilent);
});

// ── Reset path (review round 1 nit a): the gate flips OFF on a non-result ────
console.log("\nAC-2b: result -> zdarzenie nieterminalne -> stall znowu dziala (FOC-1154 reset)");

const runIdReset = "test-watch-linger-reset";
fixtureChild(runIdReset);
spawnWatcher(runIdReset, FAKE_CLAUDE_RESET);

test("a non-terminal event after the result re-arms the stall SLA — the stall row fires", async () => {
  const deadline = Date.now() + 30_000;
  let stallRows = [];
  while (Date.now() < deadline) {
    stallRows = readWakeQueue(runIdReset).filter((r) => r.event === "stall");
    if (stallRows.length) break;
    await sleep(150);
  }
  assert.ok(stallRows.length > 0, "no stall row after a result → non-result reset — the gate would be stuck on");
  assert.equal(reapNotedIn(runIdReset), false, "the linger path reaped a turn whose last event was NOT a result");
  reapAll(runIdReset);
});

// ── Re-arm (review round 1 nit c): the second result re-arms the linger gate ──
console.log("\nAC-1c: result -> zdarzenie -> result -> cisza — reap na SLA (FOC-1154 re-arm)");

const runIdRearm = "test-watch-linger-rearm";
fixtureChild(runIdRearm);
spawnWatcher(runIdRearm, FAKE_CLAUDE_REARM);

test("a second terminal result re-arms the linger gate — reap at the SLA, never a stall", async () => {
  const exit = await waitForExitRow(runIdRearm);
  assert.equal(exit.detail?.finishedLingering, true, "the re-armed reap did not land");
  assert.equal(
    readWakeQueue(runIdRearm).filter((r) => r.event === "stall").length,
    0,
    "a stall row was queued for a turn whose last event was a terminal result",
  );
  assert.equal(readRegistry(runIdRearm).children["dev-1"].status, "exited");
  reapAll(runIdRearm);
});

// ── The healthy mid-turn re-emit (review round 1 #1) ─────────────────────────
console.log("\nAC-1d: result -> dlugie tlo -> re-emit -> praca -> normalny koniec (FOC-1154)");

// LA_SUPERVISOR_POLL_MS=4000 → SLA 20 s: the 16 s background wait stays under
// the SLA (no reap) while sitting far past the rejected 10 s grace, which would
// have force-killed this healthy child before its re-emit.
fixtureChild("test-watch-linger-reemit");
const resultReemit = spawnSync(
  process.execPath,
  [WATCH, "--run", "test-watch-linger-reemit", "--child", "dev-1", "--cwd", cwd, "--prompt-file", promptFile, "--turn", "0"],
  {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 90_000,
    env: {
      ...scrubbedEnv(),
      FENIX_IN_CONTAINER: "",
      FENIX_CHILD_ISOLATION: "",
      LA_SUPERVISOR_STATE_HOME: stateHome,
      LA_SQUAD_HOME: squadHome,
      CLAUDE_CONFIG_DIR: configDir,
      LA_SUPERVISOR_NO_TELEMETRY: "1",
      LA_SUPERVISOR_NO_CODEGRAPH: "1",
      LA_SUPERVISOR_POLL_MS: "4000",
      LA_CLAUDE_BIN: FAKE_CLAUDE_REEMIT,
      FAKE_SESSION_ID: "test-watch-linger-reemit-session",
    },
  },
);

test("a healthy child re-emitting after a long background wait finishes normally — never reaped", () => {
  assert.equal(resultReemit.status, 0, `watcher exit ${resultReemit.status}: ${resultReemit.stderr}`);
  const entry = readRegistry("test-watch-linger-reemit").children["dev-1"];
  assert.equal(entry.status, "exited", `status was ${entry.status}`);
  assert.equal(entry.exitCode, 0, "the child's own exit code was replaced by a kill artifact");
  const tee = readFileSync(teeAbsPath("test-watch-linger-reemit", "dev-1"), "utf8");
  assert.ok(tee.includes("post-rewake"), "the child never got to do work after the re-emit");
  assert.ok(!tee.includes("result_linger_reap"), "the linger path reaped a healthy background-wait child");
  const exit = readWakeQueue("test-watch-linger-reemit").find((r) => r.dedupKey === EXIT_KEY);
  assert.ok(exit, "the exit wake row is missing");
  assert.equal(
    exit.detail?.finishedLingering,
    undefined,
    "a normal self-exit was marked as a reap",
  );
  assert.equal(
    readWakeQueue("test-watch-linger-reemit").filter((r) => r.event === "stall").length,
    0,
    "a stall row was queued for a turn whose last event was a terminal result",
  );
});

console.log("");
await Promise.allSettled(pending);
if (failures.length) {
  console.log(`${passed} passed, ${failures.length} FAILED`);
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);
