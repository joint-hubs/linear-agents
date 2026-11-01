// scripts/supervisor-watch-linger-short-reap.test.mjs — the FOC-1160 short
// reap: a turn whose LAST stream event PROVES the CLI's background-task
// registry is empty (after a terminal `result`) must be reaped after a short
// grace, not left lingering the full 600 s stall SLA.
//
// End-to-end through supervisor-watch.mjs, with a fake claude behind the
// LA_CLAUDE_BIN seam (the same harness supervisor-watch-linger.test.mjs uses).
// Run-3409: on win32 a turn whose background task was force-killed at turn end
// leaves the CLI in its print-mode bg-wait drain — the teardown tail
// (result → task_updated → task_notification → `background_tasks_changed`
// tasks: []) flips the FOC-1154 `lastEventIsResult` gate OFF, so the SLA reap
// stands down and the child lingers the whole SLA doing nothing.
//
// The approved rule is "result AND empty-registry proof", never "result OR":
//   SA-1: result → `background_tasks_changed` with `tasks: []` → silence → the
//         short reap fires on the 60 s grace (shrunk through the
//         LA_SUPERVISOR_LINGER_GRACE_MS seam), well before the SLA. The exit
//         row carries `finishedLingering` AND the `finishedLingeringShort`
//         marker; the tee carries a `result_linger_reap_short` note.
//   SA-2: a BARE terminal result (no proof) is NEVER short-reaped — only the
//         SLA reap may land, exactly as FOC-1154 built it (AC-1 semantics
//         untouched). Pinned via the reap duration (≥ the SLA) and the notes.
//   SA-3: result → `background_tasks_changed` with a NON-empty `tasks` array →
//         silence: no short reap — a live background task could still resolve
//         the CLI's wait, so only the ordinary stall SLA applies.
//   SA-4: proof → any further non-terminal event → silence: the short reap is
//         DISARMED (the proof must be the last parsed event); no reap before
//         the SLA.
//   SA-5: a pending gate stands the short reap down (the Supervisor is already
//         engaged on the turn).
//
// Everything runs in temp dirs (LA_SUPERVISOR_STATE_HOME, LA_SQUAD_HOME,
// CLAUDE_CONFIG_DIR, LA_SUPERVISOR_NO_TELEMETRY=1, LA_SUPERVISOR_NO_CODEGRAPH=1).
// The SLA is shrunk through LA_SUPERVISOR_POLL_MS ("5000" → 25 s) and the
// grace through LA_SUPERVISOR_LINGER_GRACE_MS ("6500" — sits between two
// 5 s scanner ticks, so the first tick cannot reap and the second must). The
// reap's wall position is asserted from the DURABLE turn record (startedAt →
// endedAt), not from polling clocks: the watcher writes startedAt before the
// child spawns and endedAt only in finalizeTurn, so that duration is always ≥
// the silence the reap required. Test pids come ONLY from the fixtures' own
// registry entries — the suite never scans for or kills processes it did not
// spawn.
//
// Run: node scripts/supervisor-watch-linger-short-reap.test.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const base = mkdtempSync(join(tmpdir(), "la-watch-linger-short-"));
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
const FAKE_ASSISTANT = `out({ type: "assistant", message: { id: "post-proof" } });`;
const FAKE_HANG = `setInterval(() => {}, 1 << 30); // the turn never ends on its own`;
// Top-level `tasks` — the exact field run-3409's tees carry on
// background_tasks_changed (payload nesting would not match the real shape).
const bgChanged = (tasks) =>
  `out({ type: "system", subtype: "background_tasks_changed", tasks: ${JSON.stringify(tasks)} });`;
const EMPTY_TASKS = [];
const LIVE_TASKS = [
  { task_id: "b20xtp93o", run_id: "0mvy5nv5z-b2cce8b4", task_type: "local_bash", description: "fake live task" },
  { task_id: "b2kfed8bu", run_id: "0mvy5qq61-34d2174f", task_type: "local_bash", description: "fake live task 2" },
];

// SA-1 (and SA-5) fake: the dev-3 tail shape — terminal result, then the
// teardown event that PROVES the registry is empty, then the CLI's
// unresolvable drain wait.
const FAKE_CLAUDE_SHORT_REAP = join(base, "fake-claude-short-reap.mjs");
writeFileSync(
  FAKE_CLAUDE_SHORT_REAP,
  [FAKE_OUT, FAKE_INIT, FAKE_RESULT, bgChanged(EMPTY_TASKS), FAKE_HANG, ``].join("\n"),
);

// SA-2 fake: a BARE terminal result, then silence — the FOC-1154 shape the SLA
// reap exists for. No proof event, so the short reap must never fire.
const FAKE_CLAUDE_BARE = join(base, "fake-claude-bare.mjs");
writeFileSync(FAKE_CLAUDE_BARE, [FAKE_OUT, FAKE_INIT, FAKE_RESULT, FAKE_HANG, ``].join("\n"));

// SA-3 fake: the teardown event arrives but the registry is NOT empty — a live
// background task could still resolve the wait. Not a proof.
const FAKE_CLAUDE_NONEMPTY = join(base, "fake-claude-nonempty.mjs");
writeFileSync(
  FAKE_CLAUDE_NONEMPTY,
  [FAKE_OUT, FAKE_INIT, FAKE_RESULT, bgChanged(LIVE_TASKS), FAKE_HANG, ``].join("\n"),
);

// SA-4 fake: the proof arrives, then ANOTHER event — the proof is no longer
// the last parsed event, so the short reap is disarmed.
const FAKE_CLAUDE_DISARMED = join(base, "fake-claude-disarmed.mjs");
writeFileSync(
  FAKE_CLAUDE_DISARMED,
  [FAKE_OUT, FAKE_INIT, FAKE_RESULT, bgChanged(EMPTY_TASKS), FAKE_ASSISTANT, FAKE_HANG, ``].join("\n"),
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

// Every spawned watcher is tracked PER RUN (the scenarios run in parallel — a
// shared kill list would murder a scenario's watcher mid-test) and reaped on
// process exit, so a failing assertion can never leak a lingering watcher or
// fake claude into the box.
const watchers = new Map();
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
        LA_SUPERVISOR_POLL_MS: "5000", // stall SLA 25 s — the short reap must beat it
        LA_SUPERVISOR_LINGER_GRACE_MS: "6500", // between two 5 s scanner ticks
        LA_CLAUDE_BIN: fakeBin,
        FAKE_SESSION_ID: `${runId}-session`,
      },
    },
  );
  watchers.set(runId, watcher);
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
  const w = watchers.get(runId);
  if (w) {
    try {
      w.kill();
    } catch {}
    watchers.delete(runId);
  }
}

const ALL_RUN_IDS = [
  "test-watch-linger-short",
  "test-watch-linger-short-bare",
  "test-watch-linger-short-nonempty",
  "test-watch-linger-short-disarmed",
  "test-watch-linger-short-gated",
];
process.on("exit", () => {
  for (const runId of ALL_RUN_IDS) {
    try {
      const pid = fixturePid(runId);
      if (pid) killTree(pid, "force");
      const w = watchers.get(runId);
      if (w) {
        try {
          w.kill();
        } catch {}
      }
    } catch {}
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Waits for the turn's exit wake row, failing fast the moment a stall row shows
// up (that is the regression: a proof-shaped turn owned by the short reap must
// never be declared stalled on the way). An async fn body runs synchronously
// until its first await, so every post-spawn assertion below MUST go through
// this wait first — a direct read at t0 would only see an empty queue.
async function waitForExitRow(runId, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = readWakeQueue(runId);
    const stallRows = rows.filter((r) => r.event === "stall");
    if (stallRows.length) {
      throw new Error(`a stall row was queued for a turn the short reap should have owned: ${JSON.stringify(stallRows[0] ?? null)}`);
    }
    const exit = rows.find((r) => r.dedupKey === EXIT_KEY);
    if (exit) return exit;
    await sleep(150);
  }
  throw new Error(`the watcher never enqueued ${EXIT_KEY} within ${timeoutMs} ms`);
}

const EXIT_KEY = `exit:dev-1:0`;
// Exact-subtype matches: `result_linger_reap` is a PREFIX of
// `result_linger_reap_short` and of `result_linger_reap_failed`, so a bare
// includes() would conflate the three. The note JSON has no spaces, so the
// quote-delimited key is exact.
const teeText = (runId) => {
  try {
    return readFileSync(teeAbsPath(runId, "dev-1"), "utf8");
  } catch {
    return "";
  }
};
const shortNotedIn = (runId) => teeText(runId).includes('"subtype":"result_linger_reap_short"');
const slaNotedIn = (runId) => teeText(runId).includes('"subtype":"result_linger_reap"');

// The turn record's wall duration (startedAt → endedAt), the durable witness of
// WHEN the reap fired: the watcher writes startedAt before the child spawns and
// endedAt only in finalizeTurn, so that duration is always ≥ the silence the
// reap required — grace for the short path, the full SLA for the FOC-1154 one.
const turnDurationMs = (runId) => {
  const turn = readRegistry(runId).children["dev-1"]?.turns?.[0];
  if (!turn?.startedAt || !turn?.endedAt) return null;
  return new Date(turn.endedAt) - new Date(turn.startedAt);
};

// Waits for the FIRST stall row (the FOC-621 machinery is what owns a silent
// turn the short reap correctly refuses to touch). With the SLA at 25 s the
// stall can land as late as the 30 s tick — the deadline allows for it.
async function waitForStallRow(runId, timeoutMs = 35_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const stallRows = readWakeQueue(runId).filter((r) => r.event === "stall");
    if (stallRows.length) return stallRows[0];
    await sleep(150);
  }
  throw new Error(`no stall row within ${timeoutMs} ms — the stall SLA regressed`);
}

// ── SA-1: result + empty-registry proof → short reap on the grace ────────────
console.log("\nSA-1: result -> background_tasks_changed tasks:[] -> cisza — short reap na grace (FOC-1160)");

const runIdShort = "test-watch-linger-short";
fixtureChild(runIdShort);
const watcherShort = spawnWatcher(runIdShort, FAKE_CLAUDE_SHORT_REAP);

test("the empty-registry proof short-reaps the lingering child on the grace, before the SLA", async () => {
  const exit = await waitForExitRow(runIdShort);
  assert.equal(exit.event, "exit", "the event type must be exit, not a new class");
  assert.equal(exit.childId, "dev-1");
  assert.equal(exit.turn, 0);
  assert.equal(exit.detail?.status, "exited", `the reap must read as a clean exit, got ${exit.detail?.status}`);
  assert.equal(exit.detail?.finishedLingering, true, "the reap marker is missing from the exit row");
  assert.equal(exit.detail?.finishedLingeringShort, true, "the short-reap marker is missing from the exit row");
  const duration = turnDurationMs(runIdShort);
  assert.ok(duration !== null, "the turn record lost startedAt/endedAt");
  assert.ok(duration >= 6_500, `the reap fired after only ${duration} ms — below the 6.5 s grace`);
  assert.ok(duration < 25_000, `the reap took ${duration} ms — the SLA, not the grace, fired`);
});

test("the tee carries the short-reap note and never the SLA note", async () => {
  await waitForExitRow(runIdShort);
  assert.ok(shortNotedIn(runIdShort), "the tee does not carry the result_linger_reap_short note");
  assert.equal(slaNotedIn(runIdShort), false, "the SLA reap note landed on a proof-shaped turn");
});

test("the registry carries the normal terminal status after the short reap", async () => {
  await waitForExitRow(runIdShort);
  const deadline = Date.now() + 15_000;
  let entry;
  while (Date.now() < deadline) {
    entry = readRegistry(runIdShort).children["dev-1"];
    if (["exited", "waiting_gate"].includes(entry?.status)) break;
    await sleep(100);
  }
  assert.ok(
    ["exited", "waiting_gate"].includes(entry?.status),
    `the turn was not finalized normally: ${entry?.status ?? "no entry"}`,
  );
});

test("the watcher process actually exits after the short reap", async () => {
  await waitForExitRow(runIdShort);
  const deadline = Date.now() + 10_000;
  while (watcherShort.exitCode === null && watcherShort.signalCode === null && Date.now() < deadline) {
    await sleep(100);
  }
  assert.ok(
    watcherShort.exitCode !== null || watcherShort.signalCode !== null,
    "the watcher outlived the short reap — the linger would burn the wake budget forever",
  );
  if (watcherShort.exitCode !== null) assert.equal(watcherShort.exitCode, 0);
  reapAll(runIdShort);
});

// ── SA-2: a BARE result is never short-reaped — the SLA reap is the only one ─
console.log("\nSA-2: sam result bez dowodu — tylko SLA reap (FOC-1154 AC-1 nietkniety)");

const runIdBare = "test-watch-linger-short-bare";
fixtureChild(runIdBare);
spawnWatcher(runIdBare, FAKE_CLAUDE_BARE);

test("a bare terminal result waits out the full SLA and reaps through the FOC-1154 path", async () => {
  const exit = await waitForExitRow(runIdBare);
  assert.equal(exit.detail?.finishedLingering, true, "the SLA reap marker is missing");
  assert.equal(
    exit.detail?.finishedLingeringShort,
    undefined,
    "a bare result was short-reaped — the approved rule is result AND proof, never result OR",
  );
  const duration = turnDurationMs(runIdBare);
  assert.ok(duration !== null, "the turn record lost startedAt/endedAt");
  assert.ok(duration >= 24_500, `the reap fired after only ${duration} ms — a bare result must wait out the 25 s SLA`);
});

test("the bare-result reap is noted as the FOC-1154 SLA reap, never the short one", async () => {
  await waitForExitRow(runIdBare);
  assert.ok(slaNotedIn(runIdBare), "the SLA reap note is missing");
  assert.equal(shortNotedIn(runIdBare), false, "a short-reap note landed on a bare-result turn");
  reapAll(runIdBare);
});

// ── SA-3: a non-empty registry is not proof — no short reap, stall still runs ─
console.log("\nSA-3: result -> background_tasks_changed non-empty -> cisza — zadnego short reap (FOC-1160)");

const runIdNonempty = "test-watch-linger-short-nonempty";
fixtureChild(runIdNonempty);
spawnWatcher(runIdNonempty, FAKE_CLAUDE_NONEMPTY);

test("a live background task in the registry stands the short reap down — the stall row still fires", async () => {
  const stall = await waitForStallRow(runIdNonempty);
  assert.match(stall.dedupKey, /^stall:dev-1:0:/, `the stall row lost its FOC-621 episode key: ${stall.dedupKey}`);
  assert.equal(
    readWakeQueue(runIdNonempty).some((r) => r.dedupKey === EXIT_KEY),
    false,
    "the turn was reaped despite a non-empty task registry",
  );
  assert.equal(shortNotedIn(runIdNonempty), false, "a short reap fired on a non-empty registry");
  assert.equal(slaNotedIn(runIdNonempty), false, "the SLA reap fired on a non-result last event");
  reapAll(runIdNonempty);
});

// ── SA-4: an event after the proof disarms the short reap ────────────────────
console.log("\nSA-4: dowód -> kolejne zdarzenie -> cisza — short reap rozbrojony (FOC-1160)");

const runIdDisarmed = "test-watch-linger-short-disarmed";
fixtureChild(runIdDisarmed);
spawnWatcher(runIdDisarmed, FAKE_CLAUDE_DISARMED);

test("any event after the proof disarms the short reap — only the stall SLA applies", async () => {
  await waitForStallRow(runIdDisarmed);
  assert.equal(
    readWakeQueue(runIdDisarmed).some((r) => r.dedupKey === EXIT_KEY),
    false,
    "the turn was reaped although the proof was not the last parsed event",
  );
  assert.equal(shortNotedIn(runIdDisarmed), false, "a short reap fired after the proof was disarmed");
  assert.equal(slaNotedIn(runIdDisarmed), false, "the SLA reap fired on a non-result last event");
  reapAll(runIdDisarmed);
});

// ── SA-5: a pending gate stands the short reap down ──────────────────────────
console.log("\nSA-5: dowód + oczekujaca bramka — short reap stanie w miejscu (FOC-1160)");

const runIdGated = "test-watch-linger-short-gated";
fixtureChild(runIdGated);
const watcherGated = spawnWatcher(runIdGated, FAKE_CLAUDE_SHORT_REAP);
// The gate is written while the child lingers — the watcher's first scanGates
// tick (5 s) will still see it pending, long before any reap could fire.
mkdirSync(gatesDir(runIdGated), { recursive: true });
writeFileSync(
  join(gatesDir(runIdGated), "gate-short.json"),
  JSON.stringify({ gateId: "gate-short", childId: "dev-1", status: "pending", kind: "question" }),
);

test("a pending gate stands the short reap down — no reap while the Supervisor is engaged", async () => {
  // Past the grace (6.5 s) AND past the SLA (25 s): neither path may reap a
  // gated turn whose last event is the proof — the stall machinery owns the
  // silence instead, which is the contract's "no pending gate" condition.
  await sleep(30_000);
  assert.equal(
    readWakeQueue(runIdGated).some((r) => r.dedupKey === EXIT_KEY),
    false,
    "the gated turn was reaped — the short reap must stand down while a gate is pending",
  );
  assert.equal(shortNotedIn(runIdGated), false, "a short reap fired under a pending gate");
  assert.equal(
    watcherGated.exitCode ?? watcherGated.signalCode ?? null,
    null,
    "the watcher finalized the gated turn itself instead of standing down",
  );
  reapAll(runIdGated);
});

console.log("");
await Promise.allSettled(pending);
if (failures.length) {
  console.log(`${passed} passed, ${failures.length} FAILED`);
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);
