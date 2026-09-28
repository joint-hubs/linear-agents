// scripts/supervisor-guard.test.mjs — the Stop-hook turn-end guard (FOC-609)
// and the SessionStart briefing mode.
//
// The two properties worth protecting:
//   · the guard is a LOOP BREAKER, not a loop maker: stop_hook_active exits 0
//     immediately, and 4 consecutive blocks end in exactly one alarm + an
//     allowed stop, never a hook that blocks forever.
//   · the guard is READ-ONLY outside guard/: a block decision may not mutate
//     the registry, the wake queue, gates or held records.
//
// Everything runs through the LA_SUPERVISOR_STATE_HOME seam pointed at a
// mkdtemp dir, so no test touches the repo's real .state/supervisor/.
//
// Run: node scripts/supervisor-guard.test.mjs

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  appendWakeEvent,
  guardAlarmsPath,
  guardStatePath,
  runDir,
  waitArmedPath,
  writeRegistry,
} from "./supervisor-lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GUARD = join(ROOT, "scripts", "supervisor-guard.mjs");
const STATUS = join(ROOT, "scripts", "supervisor-status.mjs");

// The seam: every run dir (in-process and in spawned guard/status processes,
// which inherit the env) resolves under this temp home.
const HOME = mkdtempSync(join(tmpdir(), "la-sup-guard-"));
process.env.LA_SUPERVISOR_STATE_HOME = HOME;

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}
const fail = (msg) => { throw new Error(msg); };

const readUtf8 = (path) => readFileSync(path, "utf8");
const readUtf8OrNull = (path) => {
  try {
    return readUtf8(path);
  } catch {
    return null;
  }
};

let counter = 0;
function fixtureRun() {
  const runId = `guard-test-${process.pid}-${Date.now()}-${counter++}`;
  mkdirSync(join(runDir(runId), "children"), { recursive: true });
  mkdirSync(join(runDir(runId), "gates"), { recursive: true });
  return runId;
}

// A child entry written by hand, so the test controls the registry without a
// live process — the same shape the status tests seed.
function seedChild(runId, { childId = "dev-1", status: st = "running" } = {}) {
  writeRegistry(runId, {
    runId,
    children: {
      [childId]: {
        childId,
        squad: "dev",
        taskId: "FOC-609",
        sessionId: "sess-1",
        status: st,
        turns: [{ pid: 999999, startedAt: new Date().toISOString(), endedAt: null, exitCode: null }],
      },
    },
    rounds: {},
  });
}

// A held-spawn record in the shape spawn writes; hand-written so the test does
// not have to drive the real semaphore.
function seedHeld(runId, heldId) {
  mkdirSync(join(runDir(runId), "held"), { recursive: true });
  writeFileSync(
    join(runDir(runId), "held", `${heldId}.json`),
    JSON.stringify({ heldId, squad: "dev", taskId: "FOC-609", heldAt: new Date().toISOString() }),
  );
}

const guard = (runId, payload = {}) =>
  spawnSync(process.execPath, [GUARD, ...(runId ? ["--run", runId] : [])], {
    encoding: "utf8",
    input: JSON.stringify(payload),
    env: { ...process.env },
  });

const status = (runId, extra = []) =>
  spawnSync(process.execPath, [STATUS, "--run", runId, ...extra], {
    encoding: "utf8",
    env: { ...process.env },
  });

const parse = (r) => {
  try {
    return JSON.parse(r.stdout);
  } catch {
    fail(`stdout was not JSON (exit ${r.status}):\n       ${r.stdout}\n       ${r.stderr}`);
  }
};

// ── allow paths ──────────────────────────────────────────────────────────────
console.log("\nallow paths");

test("an empty run is allowed with exit 0", () => {
  const runId = fixtureRun();
  const r = guard(runId);
  if (r.status !== 0) fail(`expected exit 0, got ${r.status} (stderr: ${r.stderr})`);
});

test("no run resolvable (no --run, no LA_SUPERVISOR_RUN) exits 0", () => {
  const r = spawnSync(process.execPath, [GUARD], {
    encoding: "utf8",
    input: JSON.stringify({}),
    env: { ...process.env, LA_SUPERVISOR_RUN: "" },
  });
  if (r.status !== 0) fail(`expected exit 0, got ${r.status}`);
});

test("stop_hook_active: true exits 0 immediately, even with a live child", () => {
  const runId = fixtureRun();
  seedChild(runId);
  const r = guard(runId, { stop_hook_active: true });
  if (r.status !== 0) fail(`expected exit 0 (no loop), got ${r.status}`);
  if (readUtf8OrNull(guardStatePath(runId)) !== null) {
    fail("stop_hook_active must not write guard state");
  }
});

test("a live child with an unexpired armed-wait marker is allowed", () => {
  const runId = fixtureRun();
  seedChild(runId);
  writeFileSync(waitArmedPath(runId), JSON.stringify({ armedAt: new Date().toISOString(), expiresAt: Date.now() + 60_000 }));
  const r = guard(runId);
  if (r.status !== 0) fail(`expected exit 0, got ${r.status} (stderr: ${r.stderr})`);
});

test("an EXPIRED armed-wait marker does not allow the stop", () => {
  const runId = fixtureRun();
  seedChild(runId);
  writeFileSync(waitArmedPath(runId), JSON.stringify({ armedAt: "stale", expiresAt: Date.now() - 1000 }));
  const r = guard(runId);
  if (r.status !== 2) fail(`an expired marker allowed the stop (exit ${r.status})`);
});

// ── block paths ──────────────────────────────────────────────────────────────
console.log("\nblock paths");

test("blocks (exit 2) with a live child, naming it in the reason", () => {
  const runId = fixtureRun();
  seedChild(runId, { childId: "dev-9" });
  const r = guard(runId);
  if (r.status !== 2) fail(`expected exit 2, got ${r.status}`);
  if (!r.stderr.includes("dev-9")) fail(`reason does not name the live child: ${r.stderr}`);
});

test("blocks (exit 2) with a held spawn, even with no live child", () => {
  const runId = fixtureRun();
  seedHeld(runId, "held-7");
  const r = guard(runId);
  if (r.status !== 2) fail(`expected exit 2, got ${r.status}`);
  if (!r.stderr.includes("held-7")) fail(`reason does not name the held spawn: ${r.stderr}`);
});

test("blocks (exit 2) with a pending gate, even with no live child", () => {
  const runId = fixtureRun();
  writeFileSync(
    join(runDir(runId), "gates", "g-9.json"),
    JSON.stringify({ gateId: "g-9", status: "pending", kind: "question", summary: "need an answer", questions: [] }),
  );
  const r = guard(runId);
  if (r.status !== 2) fail(`expected exit 2, got ${r.status}`);
  if (!r.stderr.includes("g-9")) fail(`reason does not name the pending gate: ${r.stderr}`);
});

test("an answered gate no longer blocks", () => {
  const runId = fixtureRun();
  writeFileSync(
    join(runDir(runId), "gates", "g-done.json"),
    JSON.stringify({ gateId: "g-done", status: "answered", kind: "question", summary: "", questions: [] }),
  );
  const r = guard(runId);
  if (r.status !== 0) fail(`an answered gate still blocked the stop (exit ${r.status})`);
});

test("the guard never mutates the registry, gates or held records", () => {
  const runId = fixtureRun();
  seedChild(runId, { childId: "dev-keep" });
  const gatePath = join(runDir(runId), "gates", "g-keep.json");
  writeFileSync(gatePath, JSON.stringify({ gateId: "g-keep", status: "pending", kind: "question", summary: "s", questions: [] }));
  const before = readUtf8(join(runDir(runId), "children.json")) + readUtf8(gatePath);

  guard(runId);
  guard(runId);

  const after = readUtf8(join(runDir(runId), "children.json")) + readUtf8(gatePath);
  if (before !== after) fail("the guard wrote outside guard/");
});

// ── block budget ─────────────────────────────────────────────────────────────
console.log("\nblock budget of 3");

test("blocks 1-3 exit 2; the 4th exits 0 and records exactly one alarm", () => {
  const runId = fixtureRun();
  seedChild(runId, { childId: "dev-loop" });

  for (let i = 1; i <= 3; i++) {
    const r = guard(runId);
    if (r.status !== 2) fail(`block ${i}: expected exit 2, got ${r.status}`);
  }
  const fourth = guard(runId);
  if (fourth.status !== 0) fail(`the 4th block must allow (exit 0), got ${fourth.status}`);
  if (!fourth.stderr.includes("alarm")) fail(`the 4th block does not mention the alarm: ${fourth.stderr}`);

  const lines = readUtf8(guardAlarmsPath(runId)).trim().split("\n").filter(Boolean);
  if (lines.length !== 1) fail(`expected exactly one alarm record, got ${lines.length}`);
  const alarm = JSON.parse(lines[0]);
  if (!alarm.ts) fail("alarm has no ts");
  if (!alarm.reason) fail("alarm has no reason summary");
  if (!alarm.live.some((c) => c.childId === "dev-loop")) fail("alarm does not record what was live");
});

test("after the alarm the counter restarts from 1/3", () => {
  const runId = fixtureRun();
  seedChild(runId, { childId: "dev-again" });
  for (let i = 0; i < 4; i++) guard(runId); // exhaust the budget once
  const r = guard(runId);
  if (r.status !== 2) fail(`expected a fresh block, got exit ${r.status}`);
  const state = JSON.parse(readUtf8(guardStatePath(runId)));
  if (state.consecutiveBlocks !== 1) fail(`counter did not restart: ${state.consecutiveBlocks}`);
});

test("an allowed stop in between breaks the consecutive streak", () => {
  const runId = fixtureRun();
  seedChild(runId, { childId: "dev-x" });
  guard(runId);
  guard(runId);
  // The lead arms a wait; the guard allows and resets the counter.
  writeFileSync(waitArmedPath(runId), JSON.stringify({ armedAt: new Date().toISOString(), expiresAt: Date.now() + 60_000 }));
  if (guard(runId).status !== 0) fail("armed wait did not allow the stop");
  rmSync(waitArmedPath(runId), { force: true });
  const r = guard(runId);
  const state = JSON.parse(readUtf8(guardStatePath(runId)));
  if (state.consecutiveBlocks !== 1) fail(`streak was not broken: ${state.consecutiveBlocks}`);
  if (r.status !== 2) fail(`expected exit 2 after the reset, got ${r.status}`);
});

// ── briefing ─────────────────────────────────────────────────────────────────
// ── briefing ─────────────────────────────────────────────────────────────────
console.log("\nbriefing mode");

test("--briefing prints run id, live/held children, pending gates, unread wake rows and last action per child", () => {
  const runId = fixtureRun();
  writeRegistry(runId, {
    runId,
    children: {
      "dev-brief": { childId: "dev-brief", squad: "dev", taskId: "FOC-609", status: "running", turns: [] },
      "dev-done": {
        childId: "dev-done",
        squad: "dev",
        taskId: "FOC-609",
        status: "exited",
        turns: [{ pid: 1, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), exitCode: 0 }],
      },
    },
    rounds: {},
  });
  seedHeld(runId, "held-brief");
  writeFileSync(
    join(runDir(runId), "gates", "g-brief.json"),
    JSON.stringify({ gateId: "g-brief", status: "pending", kind: "question", summary: "waiting on Mateusz", questions: [] }),
  );
  appendWakeEvent(runId, { event: "exit", childId: "dev-done", turn: 1 });

  const out = parse(status(runId, ["--briefing"]));
  if (out.mode !== "briefing") fail(`mode was ${out.mode}`);
  if (out.ok !== true) fail("ok is not true");
  if (out.runId !== runId) fail(`runId was ${out.runId}`);
  if (!out.live.some((c) => c.childId === "dev-brief")) fail("live children missing");
  if (out.live.some((c) => c.childId === "dev-done")) fail("a terminal child listed as live");
  if (!out.held.some((h) => h.heldId === "held-brief")) fail("held spawns missing");
  if (!out.pendingGates.some((g) => g.gateId === "g-brief" && g.kind === "question")) fail("pending gates missing");
  if (out.wake.unackedCount !== 1) fail(`unackedCount was ${out.wake.unackedCount}`);
  if (!out.wake.unacked.some((r) => r.event === "exit" && r.childId === "dev-done")) fail("wake rows not summarised");
  const last = out.lastAction.find((c) => c.childId === "dev-done");
  if (!last || last.status !== "exited") fail("last action per child missing");
});

test("--briefing counts only un-acked wake rows, honouring the ack watermark", () => {
  const runId = fixtureRun();
  seedChild(runId, { childId: "dev-a" });
  appendWakeEvent(runId, { event: "exit", childId: "dev-a", turn: 1 });
  appendWakeEvent(runId, { event: "gate", gateId: "g-1" });
  // Retire the first row the way the lead does, then brief.
  if (status(runId, ["--ack", "1"]).status !== 0) fail("ack failed");
  const out = parse(status(runId, ["--briefing"]));
  if (out.wake.unackedCount !== 1) fail(`unackedCount was ${out.wake.unackedCount}, expected 1 after ack`);
});

test("--briefing with no run resolvable exits 0 with empty stdout (hook-safe)", () => {
  const r = spawnSync(process.execPath, [STATUS, "--briefing"], {
    encoding: "utf8",
    env: { ...process.env, LA_SUPERVISOR_RUN: "" },
  });
  if (r.status !== 0) fail(`expected exit 0, got ${r.status}`);
  if (r.stdout.trim()) fail(`expected empty stdout, got: ${r.stdout}`);
});

test("existing snapshot mode output is unchanged", () => {
  const runId = fixtureRun();
  seedChild(runId, { childId: "dev-snap" });
  const out = parse(status(runId));
  if (out.mode !== "snapshot") fail(`mode was ${out.mode}`);
  if (out.totals.live !== 1) fail(`totals.live was ${out.totals.live}`);
  if (!Array.isArray(out.pendingGates)) fail("snapshot shape lost");
});

// ── summary ──────────────────────────────────────────────────────────────────
try {
  rmSync(HOME, { recursive: true, force: true });
} catch {
  /* best effort */
}

console.log("");
if (failures.length) {
  console.log(`${passed} passed, ${failures.length} FAILED`);
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);
