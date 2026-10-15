// scripts/runtime-workflow.test.mjs — workflow selection, explicit completion,
// and the causal return end-to-end.
//
// Two layers:
//   · unit — recordRuntimeChoice (first / revision / dedup) and completeWorkflow
//     (idempotent on its deterministic event id) against temp sqlite DBs;
//   · end-to-end — a real supervisor-spawn → supervisor-followup sequence with
//     the mock claude, the child env captured at each turn, and that env fed
//     through recordHookEvent: the return_to_dev event is recorded ONLY from a
//     follow-up turn's SessionStart, survives a failed launch, and re-delivery
//     dedups to exactly one event.
//
// The e2e half writes .state/supervisor/<runId>/ in the real repo (runDir is
// repo-anchored) — serial lane, same as supervisor-followup.test.mjs.
//
// Run: node scripts/runtime-workflow.test.mjs

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// completeWorkflow() has no dbPath seam — it lands on telemetryDbPath(), which
// reads this env at CALL time. Point it at a temp store unconditionally so the
// test can never touch the live telemetry DB (and spawned children inherit it).
process.env.LA_TELEMETRY_DB = join(mkdtempSync(join(tmpdir(), "la-runtime-wf-store-")), "telemetry.sqlite");

import { readRegistry, runDir, writeRegistry } from "./supervisor-lib.mjs";
import { waitForStatus } from "./supervisor-test-fixtures.mjs";
import { queryRuntimeEvents } from "./runtime-events.mjs";
import { recordHookEvent, recordRuntimeChoice } from "./runtime-hook.mjs";
import { completeWorkflow } from "./runtime-workflow.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SPAWN = join(ROOT, "scripts", "supervisor-spawn.mjs");
const FOLLOWUP = join(ROOT, "scripts", "supervisor-followup.mjs");
const MOCK = join(ROOT, "scripts", "mock-claude.mjs");

let passed = 0;
const failures = [];
const cleanup = [];
cleanup.push(dirname(process.env.LA_TELEMETRY_DB)); // the seam store from the header

const test = (name, fn) => {
  try {
    fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
};
const fail = (msg) => {
  throw new Error(msg);
};

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "la-runtime-wf-"));
  cleanup.push(dir);
  return join(dir, "runtime.sqlite");
}

const contextEnv = (extra = {}) => ({
  LA_TASK_KEY: "task-foc-123",
  FENIX_SUPERVISOR_SESSION_ID: "sup-session-0001",
  LA_SUPERVISOR_RUN: "run-20261013-0001",
  FENIX_ACTOR_ID: "run-20261013-0001:supervisor",
  FENIX_ACTOR_ROLE: "supervisor",
  FENIX_ATTEMPT_ID: "supervisor:turn:0",
  ...extra,
});

// ── workflow choice: first / revision / dedup ────────────────────────────────
console.log("\nworkflow choice is first-recorded, revised on change, silent on repeat");

test("the first choice records workflow_selected", () => {
  const dbPath = tempDb();
  const row = recordRuntimeChoice(["dev"], { env: contextEnv(), dbPath });
  if (!row || row.eventType !== "workflow_selected") fail(`expected workflow_selected, got ${row?.eventType}`);
  if (JSON.stringify(row.payload.stages) !== JSON.stringify(["dev"])) fail(`stages drifted: ${JSON.stringify(row.payload.stages)}`);
});

test("the same choice again records nothing (dedup)", () => {
  const dbPath = tempDb();
  recordRuntimeChoice(["dev"], { env: contextEnv(), dbPath });
  const again = recordRuntimeChoice(["dev"], { env: contextEnv(), dbPath });
  if (again !== null) fail(`a repeated choice recorded ${again?.eventType}`);
  if (queryRuntimeEvents({ taskKey: "task-foc-123" }, { dbPath }).length !== 1) fail("the DB grew on a repeated choice");
});

test("a changed choice records workflow_revised, keeping the selection history", () => {
  const dbPath = tempDb();
  recordRuntimeChoice(["dev"], { env: contextEnv(), dbPath });
  const revised = recordRuntimeChoice(["dev", "review"], { env: contextEnv(), dbPath });
  if (!revised || revised.eventType !== "workflow_revised") fail(`expected workflow_revised, got ${revised?.eventType}`);
  if (JSON.stringify(revised.payload.stages) !== JSON.stringify(["dev", "review"])) {
    fail(`revised stages drifted: ${JSON.stringify(revised.payload.stages)}`);
  }
  const events = queryRuntimeEvents({ taskKey: "task-foc-123" }, { dbPath });
  if (events.length !== 2 || events[0].eventType !== "workflow_selected") {
    fail(`selection history lost: ${events.map((e) => e.eventType)}`);
  }
});

test("an empty choice normalizes to the supervisor-only workflow", () => {
  const dbPath = tempDb();
  const row = recordRuntimeChoice([], { env: contextEnv(), dbPath });
  if (!row || JSON.stringify(row.payload.stages) !== JSON.stringify(["supervisor"])) {
    fail(`empty choice normalized to ${JSON.stringify(row?.payload.stages)}`);
  }
});

test("a choice without a valid runtime context records nothing", () => {
  const dbPath = tempDb();
  if (recordRuntimeChoice(["dev"], { env: {}, dbPath }) !== null) fail("a context-less choice recorded an event");
  if (queryRuntimeEvents({ taskKey: "task-foc-123" }, { dbPath }).length !== 0) fail("a row appeared without context");
});

// ── explicit completion ──────────────────────────────────────────────────────
console.log("\nworkflow completion is explicit and idempotent");

// completeWorkflow() has NO dbPath seam — it lands on the default store, whose
// path is LA_TELEMETRY_DB read at CALL time. Re-point the seam per test so the
// completion rows land in an isolated temp store and never in the live DB.
const withSeamDb = (fn) => {
  const prev = process.env.LA_TELEMETRY_DB;
  process.env.LA_TELEMETRY_DB = tempDb();
  try {
    fn(process.env.LA_TELEMETRY_DB);
  } finally {
    process.env.LA_TELEMETRY_DB = prev;
  }
};

test("completeWorkflow records workflow_completed once — a second call is the same row", () => {
  withSeamDb((dbPath) => {
    const first = completeWorkflow(contextEnv()); // store = LA_TELEMETRY_DB seam
    if (!first || first.eventType !== "workflow_completed") fail(`expected workflow_completed, got ${first?.eventType}`);
    if (first.eventId !== "run-20261013-0001:workflow-completed") fail(`event id was ${first.eventId}`);
    if (first.payload.status !== "completed") fail(`status was ${first.payload.status}`);

    const second = completeWorkflow(contextEnv());
    if (second.eventId !== first.eventId) fail("the second completion got a new event id");
    const events = queryRuntimeEvents({ taskKey: "task-foc-123" }, { dbPath });
    if (events.length !== 1) fail(`completion is not idempotent: ${events.length} rows`);
  });
});

test("completeWorkflow without the runtime context throws — it never fabricates", () => {
  withSeamDb((dbPath) => {
    let threw = false;
    try {
      completeWorkflow({});
    } catch {
      threw = true;
    }
    if (!threw) fail("a context-less completion recorded an event");
    if (queryRuntimeEvents({ taskKey: "task-foc-123" }, { dbPath }).length !== 0) fail("a row appeared anyway");
  });
});

test("a Stop event alone never completes the workflow — only the helper does", () => {
  withSeamDb((dbPath) => {
    recordHookEvent(
      { hook_event_name: "Stop", session_id: "sess-sup-0001" },
      { env: contextEnv({ FENIX_STAGE: "supervisor" }), dbPath },
    );
    let events = queryRuntimeEvents({ taskKey: "task-foc-123" }, { dbPath });
    if (events.some((e) => e.eventType === "workflow_completed")) fail("Stop completed the workflow");
    completeWorkflow(contextEnv());
    events = queryRuntimeEvents({ taskKey: "task-foc-123" }, { dbPath });
    if (events.filter((e) => e.eventType === "workflow_completed").length !== 1) {
      fail("the explicit helper did not record exactly one completion");
    }
  });
});

// ── the causal return, end-to-end ────────────────────────────────────────────
// spawn (turn 0) → hook: NO return_to_dev. The verdict sets pendingRuntimeReturn
// on the dev child; the follow-up (turn 1) carries it in the child env; the
// SessionStart hook records exactly one return_to_dev; a failed launch or a
// later turn re-delivers the SAME pending and dedups onto that one event.
console.log("\nthe causal return: only an actual follow-up SessionStart records it");

let counter = 0;
function fixtureRun() {
  const id = `test-wf-${process.pid}-${Date.now()}-${counter++}`;
  const dir = runDir(id);
  mkdirSync(join(dir, "children"), { recursive: true });
  mkdirSync(join(dir, "gates"), { recursive: true });
  writeFileSync(join(dir, "triage.json"), JSON.stringify({ issue: "FOC-123", verdict: "dev" }));
  cleanup.push(dir);
  return id;
}

function fixtureRepo() {
  const base = mkdtempSync(join(tmpdir(), "la-runtime-wf-repo-"));
  const repo = join(base, "repo");
  mkdirSync(repo);
  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("init", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  writeFileSync(join(repo, "README.md"), "fixture\n");
  git("add", "-A");
  git("commit", "-m", "init");
  cleanup.push(base);
  return repo;
}

const baseEnv = (extra = {}) => ({
  ...process.env,
  OPENROUTER_API_KEY: "test-supervisor-provider-key",
  LA_CLAUDE_BIN: MOCK,
  LA_SUPERVISOR_NO_TELEMETRY: "1",
  LA_SUPERVISOR_NO_CODEGRAPH: "1",
  FENIX_SUPERVISOR_SESSION_ID: "sup-session-0001",
  ...extra,
});

const parseOk = (r) => {
  let out;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    fail(`stdout was not JSON (exit ${r.status}):\n       ${r.stdout}\n       ${r.stderr}`);
  }
  if (!out || out.ok !== true) fail(`the script reported failure (exit ${r.status}): ${out?.error ?? JSON.stringify(out)}`);
  return out;
};

const spawnChild = (runId, repo, env = {}) => {
  const r = spawnSync(
    process.execPath,
    [SPAWN, "--run", runId, "--squad", "dev", "--task", "FOC-123", "--prompt", "kickoff", "--repo", repo],
    { encoding: "utf8", env: baseEnv({ MOCK_CLAUDE_HANG_MS: "0", ...env }) },
  );
  return parseOk(r);
};

const followup = (runId, childId, env = {}) =>
  spawnSync(process.execPath, [FOLLOWUP, "--run", runId, "--child", childId, "--prompt", "answer"], {
    encoding: "utf8",
    env: baseEnv({ MOCK_CLAUDE_HANG_MS: "0", ...env }),
  });

const lastRecordedEnv = (envFile) => JSON.parse(readFileSync(envFile, "utf8").trim().split("\n").pop());

const returnsFor = (dbPath, taskKey) =>
  queryRuntimeEvents({ taskKey }, { dbPath }).filter((e) => e.eventType === "return_to_dev");

test("a turn-0 spawn env records no return; the follow-up's does; re-delivery dedups", () => {
  const dbPath = tempDb();
  const repo = fixtureRepo();
  const runId = fixtureRun();
  const envFile = join(runDir(runId), "env.log");

  const child = spawnChild(runId, repo, { MOCK_CLAUDE_ENV_FILE: envFile });
  waitForStatus(runId, child.childId, ["exited", "crashed"]);

  // Turn 0: the spawn env carries an EMPTY return — the hook must not invent one.
  const env0 = lastRecordedEnv(envFile);
  if (env0.FENIX_RUNTIME_RETURN) fail(`turn 0 already carried a return: ${env0.FENIX_RUNTIME_RETURN}`);
  const taskKey = env0.LA_TASK_KEY;
  if (!taskKey) fail("turn 0 env carries no LA_TASK_KEY — the hook would run context-less");
  recordHookEvent({ hook_event_name: "SessionStart", session_id: "sess-0" }, { env: env0, dbPath });
  if (returnsFor(dbPath, taskKey).length !== 0) fail("turn 0 recorded a return_to_dev");

  // The verdict flow sets the pending return on the dev child (verdict shape).
  const pending = {
    sourceAttemptId: readRegistry(runId).children[child.childId].attemptId,
    source: "review",
    reason: "rejected",
    evidenceRef: `${runId}:verdict:FOC-123:1`,
    evidenceKind: "direct",
  };
  const registry = readRegistry(runId);
  registry.children[child.childId].pendingRuntimeReturn = pending;
  writeRegistry(runId, registry);

  // Follow-up turn 1: the child env carries the pending return AND the runtime
  // identity the hook needs.
  parseOk(followup(runId, child.childId, { MOCK_CLAUDE_ENV_FILE: envFile }));
  waitForStatus(runId, child.childId, ["exited", "crashed"]);
  const env1 = lastRecordedEnv(envFile);
  if (env1.FENIX_RUNTIME_RETURN !== JSON.stringify(pending)) {
    fail(`turn 1 env lost the pending return: ${env1.FENIX_RUNTIME_RETURN}`);
  }
  if (!JSON.parse(env1.FENIX_DEPENDS_ON_ATTEMPTS).includes(pending.sourceAttemptId)) {
    fail(`turn 1 dependencies lost the returned-from attempt: ${env1.FENIX_DEPENDS_ON_ATTEMPTS}`);
  }
  for (const key of ["LA_TASK_KEY", "FENIX_SUPERVISOR_SESSION_ID", "FENIX_ACTOR_ID", "FENIX_ATTEMPT_ID", "FENIX_ACTOR_ROLE"]) {
    if (!env1[key]) fail(`turn 1 env is missing the runtime identity ${key} — the hook would run context-less`);
  }

  // The hook fires on the follow-up's SessionStart: exactly one return_to_dev.
  recordHookEvent({ hook_event_name: "SessionStart", session_id: "sess-1" }, { env: env1, dbPath });
  let returns = returnsFor(dbPath, taskKey);
  if (returns.length !== 1) fail(`expected exactly one return_to_dev, got ${returns.length}`);
  const turn1 = readRegistry(runId).children[child.childId];
  if (returns[0].payload.fromAttemptId !== pending.sourceAttemptId) fail("fromAttemptId is not the returned-from attempt");
  if (returns[0].payload.toAttemptId !== turn1.attemptId) fail("toAttemptId is not the consuming (turn-1) attempt");
  if (returns[0].payload.evidenceRef !== pending.evidenceRef) fail("evidenceRef drifted");

  // The hook re-firing on the same session (crash-replay) adds nothing.
  recordHookEvent({ hook_event_name: "SessionStart", session_id: "sess-1" }, { env: env1, dbPath });
  if (returnsFor(dbPath, taskKey).length !== 1) fail("a hook replay duplicated the return");

  // A later turn (2) re-delivers the SAME pending under a NEW attempt id — the
  // content-keyed id must still collapse onto the one event, and the pending
  // stays in the registry (retained, never lost to a failed launch).
  const afterTurn1 = readRegistry(runId).children[child.childId];
  if (JSON.stringify(afterTurn1.pendingRuntimeReturn) !== JSON.stringify(pending)) {
    fail("the pending return was cleared by the follow-up — a failed launch would lose the evidence");
  }
  parseOk(followup(runId, child.childId, { MOCK_CLAUDE_ENV_FILE: envFile }));
  waitForStatus(runId, child.childId, ["exited", "crashed"]);
  const env2 = lastRecordedEnv(envFile);
  if (env2.FENIX_RUNTIME_RETURN !== JSON.stringify(pending)) fail("turn 2 env lost the retained pending return");
  recordHookEvent({ hook_event_name: "SessionStart", session_id: "sess-2" }, { env: env2, dbPath });
  returns = returnsFor(dbPath, taskKey);
  if (returns.length !== 1) fail(`re-delivery on turn 2 duplicated the return (${returns.length})`);
  if (returns[0].payload.toAttemptId !== turn1.attemptId) {
    fail("first write did not win: the event must keep the consuming attempt");
  }
  const afterTurn2 = readRegistry(runId).children[child.childId];
  if (JSON.stringify(afterTurn2.pendingRuntimeReturn) !== JSON.stringify(pending)) {
    fail("the pending return did not survive the second follow-up");
  }
});

// ── summary ──────────────────────────────────────────────────────────────────
for (const dir of cleanup) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

console.log("");
if (failures.length) {
  console.log(`${passed} passed, ${failures.length} FAILED`);
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);
