// scripts/runtime-hook.test.mjs — the runtime hook's event recording.
//
// The hook is the ONLY writer of supervisor workflow events, so the tests pin
// the shapes everything downstream reads: deterministic event ids (a re-fired
// hook dedups, first write wins), the stage dependency allowlist, the Stop →
// idle state change that must NOT complete a workflow, and the payload
// allowlist that keeps prompts and credentials out of the metadata.
//
// Every case uses an explicit temp sqlite dbPath — the default telemetry DB is
// never opened. Run: node scripts/runtime-hook.test.mjs

import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  recordRuntimeEvent,
  queryRuntimeEvents,
  RUNTIME_EVENT_TYPES,
} from "./runtime-events.mjs";
import { recordHookEvent } from "./runtime-hook.mjs";

let passed = 0;
const failures = [];
const cleanup = [];

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

// A temp DB per test: isolation without seams.
function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "la-runtime-hook-"));
  cleanup.push(dir);
  return join(dir, "runtime.sqlite");
}

// A full valid child context (a dev child of a managed run). Every value must
// pass isRuntimeToken — that is the hook's own admission gate.
const childEnv = (extra = {}) => ({
  LA_TASK_KEY: "task-foc-123",
  FENIX_SUPERVISOR_SESSION_ID: "sup-session-0001",
  LA_SUPERVISOR_RUN: "run-20261013-0001",
  FENIX_ACTOR_ID: "run-20261013-0001:dev-1",
  FENIX_ACTOR_ROLE: "squadlead",
  FENIX_ATTEMPT_ID: "dev-1:turn:1",
  ...extra,
});
const sessionStart = (session = "sess-child-0001") => ({
  hook_event_name: "SessionStart",
  session_id: session,
});

// ── hook dedup ───────────────────────────────────────────────────────────────
console.log("\nhook events dedup on their deterministic ids");

test("a re-fired SessionStart records nothing new (first write wins)", () => {
  const dbPath = tempDb();
  const env = childEnv({ FENIX_STAGE: "dev", FENIX_DEPENDS_ON_ATTEMPTS: '["review-1:turn:0"]' });

  const first = recordHookEvent(sessionStart(), { env, dbPath });
  if (first.length !== 2) fail(`expected actor_started + stage_attempt_started, got ${first.map((r) => r.eventType)}`);
  const second = recordHookEvent(sessionStart(), { env, dbPath });
  if (second.length !== 2) fail(`the re-fire did not return the stored rows: ${second.length}`);
  for (let i = 0; i < 2; i++) {
    if (second[i].eventId !== first[i].eventId) fail(`row ${i} got a new event id on re-fire`);
    if (second[i].eventType !== first[i].eventType) fail(`row ${i} changed type on re-fire`);
  }
  const events = queryRuntimeEvents({ taskKey: "task-foc-123" }, { dbPath });
  if (events.length !== 2) fail(`the DB accumulated ${events.length} rows for one SessionStart fired twice`);
});

test("a real re-observation is deduped even across processes (same ids, stored payload)", () => {
  // The hook is a fresh process per fire; dedup must come from the ids alone.
  const dbPath = tempDb();
  const env = childEnv({ FENIX_STAGE: "dev" });
  const input = sessionStart();
  recordHookEvent(input, { env, dbPath });
  // Replay through the recorded rows: the ids must be stable functions of the
  // input, so a second process re-derives them and lands on the same rows.
  const again = recordHookEvent(input, { env, dbPath });
  const stored = queryRuntimeEvents({ taskKey: "task-foc-123" }, { dbPath });
  if (stored.length !== again.length) fail(`stored ${stored.length} but replay returned ${again.length}`);
});

// ── stage dependencies ───────────────────────────────────────────────────────
console.log("\nstage dependencies are validated, never trusted");

test("valid dependency attempt ids ride stage_attempt_started", () => {
  const dbPath = tempDb();
  const env = childEnv({
    FENIX_STAGE: "dev",
    FENIX_DEPENDS_ON_ATTEMPTS: '["review-1:turn:0","review-1:turn:0","dev-9:turn:2"]',
  });
  recordHookEvent(sessionStart(), { env, dbPath });
  const [event] = queryRuntimeEvents({ taskKey: "task-foc-123" }, { dbPath }).filter(
    (e) => e.eventType === "stage_attempt_started",
  );
  if (!event) fail("no stage_attempt_started recorded");
  const deps = event.payload.dependsOnAttemptIds;
  if (JSON.stringify(deps) !== JSON.stringify(["review-1:turn:0", "dev-9:turn:2"])) {
    fail(`dependencies not deduped/ordered as sent: ${JSON.stringify(deps)}`);
  }
  if (JSON.stringify(event.payload.stages) !== JSON.stringify(["dev"])) fail("stages did not ride the payload");
  if (event.attemptId !== "dev-1:turn:1") fail(`attempt id lost: ${event.attemptId}`);
});

test("an unreadable or unsafe dependency list degrades to [] and still starts the stage", () => {
  const dbPath = tempDb();
  recordHookEvent(sessionStart(), {
    env: childEnv({ FENIX_STAGE: "dev", FENIX_DEPENDS_ON_ATTEMPTS: "not json" }),
    dbPath,
  });
  recordHookEvent(sessionStart("sess-child-0002"), {
    env: childEnv({ FENIX_STAGE: "dev", FENIX_DEPENDS_ON_ATTEMPTS: '["a b; drop table"]' }),
    dbPath,
  });
  const started = queryRuntimeEvents({ taskKey: "task-foc-123" }, { dbPath }).filter(
    (e) => e.eventType === "stage_attempt_started",
  );
  if (started.length !== 2) fail(`expected both attempts recorded, got ${started.length}`);
  for (const e of started) {
    if (JSON.stringify(e.payload.dependsOnAttemptIds) !== "[]") {
      fail(`unsafe dependencies leaked into the payload: ${JSON.stringify(e.payload.dependsOnAttemptIds)}`);
    }
  }
});

// ── Stop → idle, and nothing else ────────────────────────────────────────────
console.log("\nStop records idle state — never a workflow completion");

test("Stop records actor_state_changed idle and no completion event exists", () => {
  const dbPath = tempDb();
  const env = childEnv({ FENIX_STAGE: "dev" });
  const rows = recordHookEvent({ hook_event_name: "Stop", session_id: "sess-child-0001" }, { env, dbPath });
  if (rows.length !== 1 || rows[0].eventType !== "actor_state_changed") {
    fail(`Stop recorded ${rows.map((r) => r.eventType)}`);
  }
  if (rows[0].payload.state !== "idle") fail(`Stop state was ${rows[0].payload.state}`);
  const events = queryRuntimeEvents({ taskKey: "task-foc-123" }, { dbPath });
  if (events.some((e) => e.eventType === "workflow_completed")) {
    fail("a Stop marked the workflow complete — only the explicit completion helper may");
  }
  // Stop is a state TIMELINE, not an idempotent fact: two stops are two rows
  // (each carries its own random event id by design).
  recordHookEvent({ hook_event_name: "Stop", session_id: "sess-child-0001" }, { env, dbPath });
  const idles = queryRuntimeEvents({ taskKey: "task-foc-123" }, { dbPath }).filter(
    (e) => e.eventType === "actor_state_changed",
  );
  if (idles.length !== 2) fail(`the second Stop was swallowed by dedup (${idles.length} idle rows)`);
});

test("the completion event type exists for the explicit helper alone", () => {
  if (!RUNTIME_EVENT_TYPES.includes("workflow_completed")) fail("workflow_completed is not a known event type");
});

// ── causal return: return_to_dev from the follow-up's SessionStart ──────────
console.log("\nthe causal return is recorded from FENIX_RUNTIME_RETURN at SessionStart");

const RETURN = JSON.stringify({
  sourceAttemptId: "review-1:turn:0",
  source: "review",
  reason: "rejected",
  evidenceRef: "run-20261013-0001:verdict:FOC-123:1",
  evidenceKind: "direct",
});

test("a follow-up SessionStart carrying the pending return records return_to_dev", () => {
  const dbPath = tempDb();
  const env = childEnv({ FENIX_STAGE: "dev", FENIX_RUNTIME_RETURN: RETURN });
  recordHookEvent(sessionStart(), { env, dbPath });
  const returns = queryRuntimeEvents({ taskKey: "task-foc-123" }, { dbPath }).filter(
    (e) => e.eventType === "return_to_dev",
  );
  if (returns.length !== 1) fail(`expected exactly one return_to_dev, got ${returns.length}`);
  const p = returns[0].payload;
  if (p.fromAttemptId !== "review-1:turn:0") fail(`fromAttemptId was ${p.fromAttemptId}`);
  if (p.toAttemptId !== "dev-1:turn:1") fail(`toAttemptId was ${p.toAttemptId} — must be the consuming attempt`);
  if (p.source !== "review" || p.reason !== "rejected") fail(`source/reason drifted: ${p.source}/${p.reason}`);
  if (p.evidenceRef !== "run-20261013-0001:verdict:FOC-123:1") fail(`evidenceRef was ${p.evidenceRef}`);
  if (p.evidenceKind !== "direct") fail(`evidenceKind was ${p.evidenceKind}`);
});

test("a re-delivered return (retry, later turn) dedups to the SAME single event", () => {
  const dbPath = tempDb();
  const first = childEnv({ FENIX_STAGE: "dev", FENIX_RUNTIME_RETURN: RETURN });
  const second = childEnv({
    FENIX_STAGE: "dev",
    FENIX_RUNTIME_RETURN: RETURN,
    FENIX_ATTEMPT_ID: "dev-1:turn:2", // a later turn: different attempt id
  });
  recordHookEvent(sessionStart("sess-child-0001"), { env: first, dbPath });
  recordHookEvent(sessionStart("sess-child-0002"), { env: second, dbPath });
  const returns = queryRuntimeEvents({ taskKey: "task-foc-123" }, { dbPath }).filter(
    (e) => e.eventType === "return_to_dev",
  );
  if (returns.length !== 1) fail(`the re-delivery duplicated the return (${returns.length} rows)`);
  // The stored row names the attempt that CONSUMED the return — the first one.
  if (returns[0].payload.toAttemptId !== "dev-1:turn:1") {
    fail(`first write did not win: toAttemptId was ${returns[0].payload.toAttemptId}`);
  }
});

test("a malformed pending return is swallowed — the stage still starts", () => {
  const dbPath = tempDb();
  const env = childEnv({ FENIX_STAGE: "dev", FENIX_RUNTIME_RETURN: "{not json" });
  const rows = recordHookEvent(sessionStart(), { env, dbPath });
  if (rows.some((r) => r.eventType === "return_to_dev")) fail("a malformed return produced an event");
  if (!rows.some((r) => r.eventType === "stage_attempt_started")) fail("the stage start was lost with the bad return");
});

test("a turn-0 spawn env (empty FENIX_RUNTIME_RETURN) records no return_to_dev", () => {
  const dbPath = tempDb();
  const env = childEnv({ FENIX_STAGE: "dev", FENIX_RUNTIME_RETURN: "" });
  recordHookEvent(sessionStart(), { env, dbPath });
  const events = queryRuntimeEvents({ taskKey: "task-foc-123" }, { dbPath });
  if (events.some((e) => e.eventType === "return_to_dev")) fail("an empty return still recorded one");
});

// ── subagent identity ────────────────────────────────────────────────────────
console.log("\nsubagent events carry the child identity");

test("SubagentStart/Stop record under the parent with the native agent id", () => {
  const dbPath = tempDb();
  const env = childEnv();
  const start = recordHookEvent(
    { hook_event_name: "SubagentStart", session_id: "sess-child-0001", agent_id: "agent-abc", agent_type: "Explore" },
    { env, dbPath },
  );
  if (start.length !== 1 || start[0].eventType !== "actor_started") fail(`SubagentStart recorded ${start.map((r) => r.eventType)}`);
  if (start[0].actorId !== "run-20261013-0001:dev-1:agent-abc") fail(`child actorId was ${start[0].actorId}`);
  if (start[0].parentActorId !== "run-20261013-0001:dev-1") fail(`parentActorId was ${start[0].parentActorId}`);
  if (start[0].role !== "Explore") fail(`child role was ${start[0].role}`);

  const stop = recordHookEvent(
    { hook_event_name: "SubagentStop", session_id: "sess-child-0001", agent_id: "agent-abc" },
    { env, dbPath },
  );
  if (stop.length !== 1 || stop[0].eventType !== "actor_stopped") fail(`SubagentStop recorded ${stop.map((r) => r.eventType)}`);

  // No native agent id → no child identity → nothing recorded (fail closed).
  const ghost = recordHookEvent(
    { hook_event_name: "SubagentStart", session_id: "sess-child-0001" },
    { env, dbPath },
  );
  if (ghost.length !== 0) fail("a subagent event without agent_id still recorded a row");
});

test("the supervisor's own SessionStart records supervisor_started, not actor_started", () => {
  const dbPath = tempDb();
  const env = childEnv({ FENIX_ACTOR_ROLE: "supervisor", FENIX_ATTEMPT_ID: "supervisor:turn:0" });
  const rows = recordHookEvent(sessionStart("sess-sup-0001"), { env, dbPath });
  if (!rows.some((r) => r.eventType === "supervisor_started")) fail(`got ${rows.map((r) => r.eventType)}`);
  if (rows.some((r) => r.eventType === "actor_started")) fail("the supervisor was recorded as a plain actor");
  // Without a known stage, no stage events either.
  if (rows.some((r) => r.eventType.startsWith("stage_"))) fail("stage events fired without FENIX_STAGE");
});

// ── metadata carries no canary content ───────────────────────────────────────
console.log("\nthe payload allowlist keeps prompts and credentials out");

test("secret-shaped and free-text payload values are refused before the insert", () => {
  const dbPath = tempDb();
  const canaryKey = "sk-ant-canary-DO-NOT-STORE";
  const canaryPrompt = "please fix the failing test in src/app.ts";
  let threw = 0;
  try {
    recordRuntimeEvent(
      {
        eventId: "evt:canary-key", eventType: "return_to_dev", taskKey: "task-foc-123",
        supervisorSessionId: "sup-session-0001", workflowRunId: "run-20261013-0001",
        actorId: "run-20261013-0001:dev-1", role: "squadlead",
        payload: { fromAttemptId: "review-1:turn:0", evidenceRef: canaryKey },
      },
      { dbPath },
    );
  } catch {
    threw++;
  }
  try {
    recordRuntimeEvent(
      {
        eventId: "evt:canary-prompt", eventType: "actor_state_changed", taskKey: "task-foc-123",
        supervisorSessionId: "sup-session-0001", workflowRunId: "run-20261013-0001",
        actorId: "run-20261013-0001:dev-1", role: "squadlead",
        payload: { state: "idle", prompt: canaryPrompt }, // unknown key
      },
      { dbPath },
    );
  } catch {
    threw++;
  }
  if (threw !== 2) fail(`expected both canary attempts to throw, ${threw} did`);
  const events = queryRuntimeEvents({ taskKey: "task-foc-123" }, { dbPath });
  if (events.length !== 0) fail(`rows were stored anyway: ${events.map((e) => e.eventType)}`);
  const raw = readFileSync(dbPath, "utf8");
  if (raw.includes("canary-DO-NOT-STORE") || raw.includes("fix the failing test")) {
    fail("the canary reached the database file despite the throw");
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
