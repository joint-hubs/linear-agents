// scripts/supervisor-wake.test.mjs — the Supervisor's waker (supervisor-wake.mjs,
// a Stop hook with asyncRewake) and the briefing's `waker` field.
//
// The properties worth protecting:
//   · a new row wakes the session (exit 2, stderr names it) — including a row
//     that landed just before the turn ended and was never drained;
//   · it never wakes in a loop: one wake per row (firedThrough), one waker per
//     session (lease), a superseded waker stands down without writing;
//   · it never exits 0 one poll before the row it exists for (grace window);
//   · it is READ-ONLY outside waker.json;
//   · the hook in agents/supervisor/settings.json stays in sync with the code.
//
// Everything runs through the LA_SUPERVISOR_STATE_HOME seam pointed at a
// mkdtemp dir, so no test touches the repo's real .state/supervisor/.
//
// Run: node scripts/supervisor-wake.test.mjs

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  appendWakeEvent,
  readWakerLease,
  runDir,
  wakeAckPath,
  wakeQueuePath,
  wakerPath,
  wakerState,
  registryPath,
  writeRegistry,
} from "./supervisor-lib.mjs";
import { DEFAULT_MAX_LIFETIME_MS, formatWakeMessage, freshRows } from "./supervisor-wake.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WAKE = join(ROOT, "scripts", "supervisor-wake.mjs");
const STATUS = join(ROOT, "scripts", "supervisor-status.mjs");
const SETTINGS = join(ROOT, "agents", "supervisor", "settings.json");

const HOME = mkdtempSync(join(tmpdir(), "la-sup-wake-"));
process.env.LA_SUPERVISOR_STATE_HOME = HOME;

const BASE_ENV = {
  ...process.env,
  LA_SUPERVISOR_RUN: "",
  LA_SUPERVISOR_WAKE_POLL_MS: "50",
  LA_SUPERVISOR_WAKE_GRACE_MS: "150",
  LA_SUPERVISOR_WAKE_MAX_MS: "4000",
};

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}
const fail = (msg) => {
  throw new Error(msg);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readOrNull = (path) => (existsSync(path) ? readFileSync(path, "utf8") : null);

let counter = 0;
function fixtureRun() {
  const runId = `wake-test-${process.pid}-${Date.now()}-${counter++}`;
  mkdirSync(join(runDir(runId), "gates"), { recursive: true });
  return runId;
}

function seedChild(runId, { childId = "dev-1", status = "running" } = {}) {
  writeRegistry(runId, {
    runId,
    children: {
      [childId]: {
        childId,
        squad: "dev",
        taskId: "FOC-WAKE",
        sessionId: "child-sess",
        status,
        turns: [{ pid: 999999, startedAt: new Date().toISOString(), endedAt: null, exitCode: null }],
      },
    },
    rounds: {},
  });
}

const exitRow = (childId = "dev-1", turn = 0) => ({
  event: "exit",
  childId,
  turn,
  detail: { status: "exited", exitCode: 0 },
});

function seedLease(runId, lease) {
  writeFileSync(wakerPath(runId), JSON.stringify(lease, null, 2) + "\n");
}

const payload = (session) => JSON.stringify({ session_id: session, hook_event_name: "Stop", stop_hook_active: false });

function runWakerSync(runId, { session = "sess-A", env = {}, withRun = true } = {}) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [WAKE, ...(withRun ? ["--run", runId] : [])], {
    encoding: "utf8",
    input: payload(session),
    env: { ...BASE_ENV, ...env },
  });
  return { code: r.status, stderr: r.stderr, elapsedMs: Date.now() - t0 };
}

function startWaker(runId, { session = "sess-A", env = {} } = {}) {
  const t0 = Date.now();
  const child = spawn(process.execPath, [WAKE, "--run", runId], {
    env: { ...BASE_ENV, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(payload(session));
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const done = new Promise((resolve) =>
    child.on("exit", (code) => resolve({ code, stderr, elapsedMs: Date.now() - t0, pid: child.pid })),
  );
  return { child, done };
}

// ── pure helpers ─────────────────────────────────────────────────────────────

await test("freshRows: only rows above BOTH the ack watermark and firedThrough, in seq order", () => {
  const rows = [3, 1, 4, 2, 5].map((seq) => ({ seq, event: "exit", childId: `c${seq}` }));
  const got = freshRows({ rows, ackedThrough: 1, firedThrough: 3 }).map((r) => r.seq);
  if (JSON.stringify(got) !== "[4,5]") fail(`got ${JSON.stringify(got)}`);
});

await test("formatWakeMessage: ids and kinds only, at most 5 rows listed, drain command named", () => {
  const rows = [
    { seq: 1, event: "exit", childId: "dev-1", detail: { status: "exited" } },
    { seq: 2, event: "gate", gateId: "gate-dev-1-1", detail: { kind: "question" } },
    { seq: 3, event: "stall", childId: "dev-2" },
    ...[4, 5, 6, 7].map((seq) => ({ seq, event: "exit", childId: `c${seq}`, detail: { status: "crashed" } })),
  ];
  const msg = formatWakeMessage("run-x", rows);
  for (const part of ["7 new wake event(s) in run run-x", "#1 exit dev-1 (exited)", "#2 gate gate-dev-1-1 [question]", "#3 stall dev-2", "+2 more", "--drain"]) {
    if (!msg.includes(part)) fail(`message lacks "${part}": ${msg}`);
  }
  if (msg.includes("#6")) fail(`more than 5 rows listed: ${msg}`);
});

// ── stand-down paths (exit 0) ────────────────────────────────────────────────

await test("no run resolvable → exit 0, nothing written", () => {
  const before = readdirSync(HOME).length;
  const r = runWakerSync("ignored", { withRun: false });
  if (r.code !== 0) fail(`expected exit 0, got ${r.code} (${r.stderr})`);
  if (readdirSync(HOME).length !== before) fail("the waker created state with no run");
});

await test("nothing live and no fresh row → exit 0 after the grace window, lease ended", () => {
  const runId = fixtureRun();
  seedChild(runId, { status: "exited" });
  const r = runWakerSync(runId);
  if (r.code !== 0) fail(`expected exit 0, got ${r.code} (${r.stderr})`);
  if (r.stderr.includes("supervisor-wake:")) fail(`woke for nothing: ${r.stderr}`);
  const lease = readWakerLease(runId);
  if (!lease?.endedAt) fail(`lease not ended: ${JSON.stringify(lease)}`);
  if (wakerState(lease) !== "ended") fail(`state ${wakerState(lease)}`);
});

await test("a row already woken for is not woken for again (firedThrough survives takeover)", () => {
  const runId = fixtureRun();
  seedChild(runId, { status: "exited" });
  appendWakeEvent(runId, exitRow());
  seedLease(runId, { pid: 1, sessionId: "old", heartbeatAt: new Date(Date.now() - 3_600_000).toISOString(), firedThrough: 1 });
  const r = runWakerSync(runId);
  if (r.code !== 0) fail(`expected exit 0 (no re-fire), got ${r.code} (${r.stderr})`);
  if (readWakerLease(runId).firedThrough !== 1) fail("firedThrough moved");
});

await test("a live waker of the SAME session is on duty → exit 0, lease bytes untouched", () => {
  const runId = fixtureRun();
  seedChild(runId);
  seedLease(runId, { pid: 424242, sessionId: "sess-A", startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), firedThrough: 0 });
  const before = readFileSync(wakerPath(runId), "utf8");
  const r = runWakerSync(runId, { session: "sess-A" });
  if (r.code !== 0) fail(`expected exit 0, got ${r.code}`);
  if (r.elapsedMs > 3000) fail(`took ${r.elapsedMs} ms — it should stand down at once`);
  if (readFileSync(wakerPath(runId), "utf8") !== before) fail("lease was rewritten");
});

// ── wake paths (exit 2) ──────────────────────────────────────────────────────

await test("a row appended while waiting wakes the session (exit 2) and names it; read-only elsewhere", async () => {
  const runId = fixtureRun();
  seedChild(runId);
  const { done } = startWaker(runId);
  await sleep(400);
  appendWakeEvent(runId, exitRow());
  const queueBytes = readOrNull(wakeQueuePath(runId));
  const registryBytes = readOrNull(registryPath(runId));
  const r = await done;
  if (r.code !== 2) fail(`expected exit 2, got ${r.code} (${r.stderr})`);
  if (!r.stderr.includes("#1 exit dev-1 (exited)")) fail(`stderr: ${r.stderr}`);
  if (r.elapsedMs > 3500) fail(`woke after ${r.elapsedMs} ms`);
  const lease = readWakerLease(runId);
  if (lease.firedThrough !== 1) fail(`firedThrough ${lease.firedThrough}`);
  if (!lease.endedAt) fail("lease not ended after the wake");
  if (readOrNull(wakeQueuePath(runId)) !== queueBytes) fail("the waker wrote the queue");
  if (readOrNull(registryPath(runId)) !== registryBytes) fail("the waker wrote the registry");
  if (existsSync(wakeAckPath(runId))) fail("the waker wrote the ack");
});

await test("an unacked row that landed before the turn ended wakes immediately", () => {
  const runId = fixtureRun();
  seedChild(runId);
  appendWakeEvent(runId, exitRow());
  const r = runWakerSync(runId);
  if (r.code !== 2) fail(`expected exit 2, got ${r.code}`);
  if (!r.stderr.includes("#1 exit dev-1")) fail(`stderr: ${r.stderr}`);
});

await test("grace window: child turns terminal BEFORE its exit row lands → still exit 2", async () => {
  const runId = fixtureRun();
  seedChild(runId);
  const { done } = startWaker(runId);
  await sleep(400);
  seedChild(runId, { status: "exited" });
  await sleep(100);
  appendWakeEvent(runId, exitRow());
  const r = await done;
  if (r.code !== 2) fail(`expected exit 2 (row inside the grace window), got ${r.code}`);
});

await test("lifetime runs out with a live child and nothing new → exit 2 that only re-arms", () => {
  const runId = fixtureRun();
  seedChild(runId);
  appendWakeEvent(runId, exitRow("dev-0"));
  writeFileSync(wakeAckPath(runId), JSON.stringify({ ackedThrough: 1 }));
  const r = runWakerSync(runId, { env: { LA_SUPERVISOR_WAKE_MAX_MS: "800" } });
  if (r.code !== 2) fail(`expected exit 2, got ${r.code} (${r.stderr})`);
  if (!/still waiting on 1 live child/.test(r.stderr)) fail(`stderr: ${r.stderr}`);
  if (!r.stderr.includes("re-arms")) fail(`stderr: ${r.stderr}`);
});

// ── lease handover ───────────────────────────────────────────────────────────

await test("a live lease of a DIFFERENT session (orphan of a closed session) is taken over", () => {
  const runId = fixtureRun();
  seedChild(runId);
  seedLease(runId, { pid: 424242, sessionId: "dead-session", heartbeatAt: new Date().toISOString(), firedThrough: 0 });
  const r = runWakerSync(runId, { session: "sess-B", env: { LA_SUPERVISOR_WAKE_MAX_MS: "600" } });
  if (r.code !== 2) fail(`expected the takeover to run to its deadline (exit 2), got ${r.code}`);
  const lease = readWakerLease(runId);
  if (lease.sessionId !== "sess-B") fail(`lease session ${lease.sessionId}`);
  if (lease.pid === 424242) fail("lease still names the orphan");
});

await test("superseded mid-wait → exit 0 within ~1 s, the newer lease is left untouched", async () => {
  const runId = fixtureRun();
  seedChild(runId);
  const { done } = startWaker(runId, { env: { LA_SUPERVISOR_WAKE_MAX_MS: "6000" } });
  await sleep(500);
  const newer = { pid: 1, sessionId: "sess-newer", heartbeatAt: new Date().toISOString(), firedThrough: 0 };
  seedLease(runId, newer);
  const t0 = Date.now();
  const r = await done;
  if (r.code !== 0) fail(`expected exit 0, got ${r.code} (${r.stderr})`);
  if (Date.now() - t0 > 1500) fail(`stood down after ${Date.now() - t0} ms`);
  const lease = readWakerLease(runId);
  if (lease.pid !== 1 || lease.endedAt) fail(`superseded waker wrote the lease: ${JSON.stringify(lease)}`);
});

// ── config sync + briefing ───────────────────────────────────────────────────

await test("settings.json: the waker is a Stop hook with asyncRewake and a timeout above its lifetime", () => {
  const settings = JSON.parse(readFileSync(SETTINGS, "utf8"));
  const hooks = (settings.hooks?.Stop ?? []).flatMap((m) => m.hooks ?? []);
  if (!hooks.some((h) => String(h.command).includes("supervisor-guard.mjs"))) fail("the guard hook is gone");
  const wake = hooks.find((h) => String(h.command).includes("supervisor-wake.mjs"));
  if (!wake) fail("no supervisor-wake.mjs Stop hook");
  if (wake.asyncRewake !== true) fail(`asyncRewake is ${wake.asyncRewake}`);
  if (!(wake.timeout * 1000 > DEFAULT_MAX_LIFETIME_MS)) {
    fail(`hook timeout ${wake.timeout}s does not exceed the waker lifetime ${DEFAULT_MAX_LIFETIME_MS} ms — the harness would kill it first`);
  }
});

await test("briefing shows waker.state absent / alive / ended", () => {
  const runId = fixtureRun();
  seedChild(runId);
  const brief = () => {
    const r = spawnSync(process.execPath, [STATUS, "--run", runId, "--briefing"], { encoding: "utf8", env: { ...BASE_ENV } });
    try {
      return JSON.parse(r.stdout);
    } catch {
      fail(`briefing stdout not JSON (exit ${r.status}): ${r.stdout} ${r.stderr}`);
    }
  };
  if (brief().waker?.state !== "absent") fail("expected absent without a lease");
  seedLease(runId, { pid: 1, sessionId: "s", heartbeatAt: new Date().toISOString(), firedThrough: 3 });
  const alive = brief().waker;
  if (alive.state !== "alive" || alive.firedThrough !== 3) fail(`alive: ${JSON.stringify(alive)}`);
  seedLease(runId, { pid: 1, sessionId: "s", heartbeatAt: new Date().toISOString(), endedAt: new Date().toISOString() });
  if (brief().waker.state !== "ended") fail("expected ended");
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
