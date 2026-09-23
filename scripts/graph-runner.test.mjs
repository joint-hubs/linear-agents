// scripts/graph-runner.test.mjs — FOC-397: the graph.json v2 executor.
//
// Covers the runner contract end to end, all offline: the resumable walk over
// the committed PLAN subgraph (8 steps, 7 sequence edges) with every external
// dependency injected — the seam caller stub (never a real decision call, and
// never a real Linear write or gate emit), the [G] generator, the supervisor
// gate emitter and the Linear boundary. The run-record store is a temp-dir
// JSONL: every stop writes one typed record, resolutions are appended by the
// "deciding agent" (the test plays the frontman), and a run resumes by
// reading the latest record per key — done steps are never re-executed.
// Fail-closed paths each get their own case: provider error → cascade tier 3
// hand-off, schema-invalid [G] output, missing read, corrupt store line,
// resolution without a base record, invalid resolution refused (nothing
// appended), the default Linear boundary's refusal, unknown record status,
// unknown decision edge, and the CLI's typed-envelope exits.
//
// Run: node scripts/graph-runner.test.mjs

import { appendFileSync, existsSync, readFileSync, rmSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { createGraphRunner } from "./graph-runner.mjs";

let passed = 0;
const failures = [];

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log("  PASS " + name);
    })
    .catch((err) => {
      failures.push(name);
      console.log("  FAIL " + name + "\n       " + err.message);
    });
}

const fail = (msg) => { throw new Error(msg); };
const eq = (a, b, label) => { if (a !== b) fail(`${label}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };
const deepEq = (a, b, label) => { try { assert.deepStrictEqual(a, b); } catch (err) { fail(`${label}: ${err.message}`); } };

// TypedError-shaped: every runner failure is one of the envelope codes.
function eqCode(err, code, label) {
  if (err.code !== code) fail(`${label}: expected code ${code}, got ${err.code} (${err.message})`);
}

// Hermetic by construction: a test run must never write telemetry or shadow
// lines, and every store lives in a temp dir.
delete process.env.LA_RUN_ID;

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");

// ── fixtures ─────────────────────────────────────────────────────────────────
// The committed graph + registry are the real spec; the stubs only stand in
// for the network, the supervisor gate and Linear.

const RUN_INPUTS = {
  "inbox.entry": "Dictated entry (test): the runner executes the PLAN subgraph with typed run records.",
  "repoState.pinned": { branch: "foc-397-dev", head: "ec6816b" },
  "features.list": [{ name: "graph runner" }],
};

const AC_OUTPUT = {
  acs: [{ id: "AC-1", text: "The runner executes the PLAN subgraph with typed run records.", kind: "behaviour", evidence: "test" }],
};

const DOD_OUTPUT = {
  definitionOfDone: [{ check: "node scripts/graph-runner.test.mjs is green", kind: "test", bounded: true }],
};

const SPEC_OUTPUT = { briefs: ["brief: implement the runner"], adr: "ADR-0013", summary: "Runner executes steps with typed records." };

const DECOMPOSE_OUTPUT = {
  tasks: [{ title: "graph-runner.mjs", size: "medium", labels: ["tech"], relations: [] }],
};

function a0Envelope(decisionId, answers, confidence = 0.9) {
  return {
    ok: true,
    step: "decision-call",
    decisionId,
    criteriaVersion: 1,
    autonomy: "A0",
    annotation: { answers, confidence },
    pinnedModel: "typesafe/jev-1.13",
    usage: { input_tokens: 10, output_tokens: 2, cost: 0.000001 },
  };
}

// The node-internal plan.ac.testable gate answering ABOVE the verdict
// threshold (p ≥ 0.5) for every criterion instance — the happy-path stub.
function testableEnvelope(input) {
  const answers = Object.fromEntries((input.instances ?? []).map((_, i) => [`ac${i}`, { type: "noul", noul: 0.9 }]));
  return a0Envelope("plan.ac.testable", answers);
}

// The frontman's pen: resolution records are appended by the DECIDING agent —
// the runner consumes them, never creates them.
function resolve(storePath, key, output, by = "frontman") {
  appendFileSync(storePath, `${JSON.stringify({
    type: "graph.resolution",
    runId: "run-e2e",
    ts: "2026-01-01T00:00:00.000Z",
    key: `${key}.resolution`,
    stepId: key,
    by,
    output,
  })}\n`);
}

function readRecords(storePath) {
  return readFileSync(storePath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

function latest(records, key) {
  const matching = records.filter((r) => r.key === key);
  return matching[matching.length - 1] ?? null;
}

// A runner wired to injected stubs; each test gets its own store dir.
function makeRunner({ caller, generator, gateEmitter, linearEffect, storePath, runId = "run-e2e" }) {
  return createGraphRunner({ runId, storePath, caller, generator, gateEmitter, linearEffect });
}

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "graph-runner-test-"));
  const storePath = join(dir, "runs", "run-e2e", "graph-steps.jsonl");
  mkdirSync(dirname(storePath), { recursive: true }); // tests that append directly need the dir
  return { dir, storePath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

console.log("\ngraph-runner: construction fails closed");

await test("a broken graph fails at construction, never mid-run", () => {
  const { dir, storePath } = tempStore();
  try {
    const broken = join(dir, "broken-graph.json");
    const graph = JSON.parse(readFileSync(join(ROOT, "config", "graph.json"), "utf8"));
    graph.nodes.plan.steps["plan.dor"].kind = "X"; // unknown kind — graph-validate v2 refuses
    writeFileSync(broken, JSON.stringify(graph));
    try {
      createGraphRunner({ runId: "r", graphPath: broken, caller: async () => ({}), generator: async () => ({}) });
      fail("construction must refuse a broken graph");
    } catch (err) {
      eqCode(err, "schema_invalid", "broken graph");
    }
    eq(existsSync(storePath), false, "no store writes on a construction failure");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("a [J] step whose registry posture the runner cannot serve fails at construction", () => {
  const dir = mkdtempSync(join(tmpdir(), "graph-runner-test-"));
  try {
    // The runner's posture check (A0 + threshold null + tier 2 disabled) is
    // its own gate: validateGraph's step cross-check covers the D7 fields but
    // NOT autonomy, so only the runner can refuse a registry drifted to A1.
    // The drift must survive the registry's OWN schema first: the a0Enforced
    // ⇒ A0 rule would refuse "A1" while the seam serving stands, so the
    // fixture also swaps the serving path to a manual, un-enforced one.
    const registry = JSON.parse(readFileSync(join(ROOT, "config", "decisions.json"), "utf8"));
    registry.entries["plan.dor"].autonomy = "A1";
    registry.entries["plan.dor"].serving = [{ via: "manual", actsOnAnswers: false, a0Enforced: false }];
    const regPath = join(dir, "broken-registry.json");
    writeFileSync(regPath, JSON.stringify(registry));
    try {
      createGraphRunner({ runId: "r", registryPath: regPath, caller: async () => ({}), generator: async () => ({}) });
      fail("construction must refuse a non-A0 [J] entry");
    } catch (err) {
      eqCode(err, "schema_invalid", "non-A0 entry");
      if (!err.message.includes("not an A0 entry")) fail("message names the posture rule");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("missing caller / generator / runId fail at construction with typed errors", () => {
  try {
    createGraphRunner({ runId: "r", caller: undefined, generator: async () => ({}) });
    fail("missing caller must refuse");
  } catch (err) {
    eqCode(err, "invalid_input", "missing caller");
  }
  try {
    createGraphRunner({ runId: "r", caller: async () => ({}), generator: undefined });
    fail("missing generator must refuse");
  } catch (err) {
    eqCode(err, "invalid_input", "missing generator");
  }
  try {
    createGraphRunner({ caller: async () => ({}), generator: async () => ({}) });
    fail("missing runId must refuse");
  } catch (err) {
    eqCode(err, "invalid_input", "missing runId");
  }
});

console.log("\ngraph-runner: the PLAN subgraph end to end (all stubs injected)");

await test("the full resumable walk: 8 steps, 2 A0 annotations, 2 [G] calls, 2 gates, one push, idempotent resume", async () => {
  const { storePath } = tempStore();
  const callerCalls = [];
  const caller = async (input) => {
    callerCalls.push(input);
    if (input.decisionId === "plan.dor") return a0Envelope("plan.dor", { q_ready: { type: "noul", noul: 0.9 } });
    if (input.decisionId === "plan.ac.testable") return testableEnvelope(input);
    if (input.decisionId === "plan.decompose") return a0Envelope("plan.decompose", { q_size: { type: "choice", choice: "medium", probabilities: { medium: 0.9 } }, q_relations: { type: "choice", choice: "standalone", probabilities: { standalone: 0.8 } } });
    return fail(`unexpected caller decisionId ${input.decisionId}`);
  };
  let generatorCalls = 0;
  const generator = async ({ stepId, reads }) => {
    generatorCalls++;
    if (stepId === "plan.dod") {
      if (typeof reads["inbox.entry"] === "undefined") fail("inbox.entry read missing");
      return DOD_OUTPUT;
    }
    eq(stepId, "plan.ac", "generator serves plan.dod then plan.ac");
    if (typeof reads["features.list"] === "undefined") fail("features.list read missing");
    return AC_OUTPUT;
  };
  const gateCalls = [];
  const gateEmitter = async ({ stepId, gateKind, summary, facts }) => {
    gateCalls.push({ stepId, gateKind, summary, facts });
    return { gateId: `gate-test-${gateCalls.length}` };
  };
  const linearCalls = [];
  const linearEffect = async ({ action, payload }) => {
    linearCalls.push({ action, payload });
    return { epicId: "FEN-900", childrenIds: ["FEN-901"], handoffCommentPosted: true };
  };

  const runner = makeRunner({ caller, generator, gateEmitter, linearEffect, storePath });

  // Run 1 — plan.dor executes, A0 annotation recorded, run stops handed-off.
  let result = await runner.run({ inputs: RUN_INPUTS });
  eq(result.status, "stopped", "run 1 stops");
  eq(result.stepId, "plan.dor", "run 1 stops at the [J] step");
  eq(result.record.status, "handed-off", "plan.dor hands off");
  eq(result.record.tier, 1, "served at tier 1");
  if (!result.record.annotation?.answers?.q_ready) fail("annotation on the handed-off record");
  if ("output" in result.record) fail("an A0 annotation is never an operative output");

  // The seam call carried the registry id AND the runner-built questions.
  eq(callerCalls.length, 1, "one seam call");
  eq(callerCalls[0].decisionId, "plan.dor", "call by registry id");
  if (!callerCalls[0].questions?.q_ready) fail("runner-built questions sent");
  if (typeof callerCalls[0].state !== "string" || !callerCalls[0].state.includes("Dictated entry")) fail("state composed from reads");

  // Run 1 again — the handed-off step waits, nothing re-executes.
  callerCalls.length = 0;
  result = await runner.run({ inputs: RUN_INPUTS });
  eq(result.status, "stopped", "run 1 replay still waits");
  eq(result.stepId, "plan.dor", "same handed-off record returned");
  eq(callerCalls.length, 0, "no re-execution while waiting");

  // The frontman resolves DoR. Before the resolution exists, the store carried
  // no resolution records at all — the runner never writes one itself.
  let records = readRecords(storePath);
  if (records.some((r) => r.type === "graph.resolution")) fail("the runner never writes resolutions");
  resolve(storePath, "plan.dor", { ready: true, gaps: [] }, "mateusz");

  // Run 2 — plan.dod + plan.ac [G] execute, plan.spec [A] hands off.
  result = await runner.run({ inputs: RUN_INPUTS });
  eq(result.status, "stopped", "run 2 stops");
  eq(result.stepId, "plan.spec", "run 2 stops at the [A] step");
  eq(result.record.status, "handed-off", "plan.spec hands off");
  deepEq(result.record.handoff.reads["plan.ac.acs"], AC_OUTPUT.acs, "the [A] hand-off carries the resolved reads");
  eq(generatorCalls, 2, "[G] executed exactly once each (plan.dod, plan.ac)");

  resolve(storePath, "plan.spec", SPEC_OUTPUT, "spec-agent");

  // Run 3 — plan.gate1 emits the supervisor gate and stops gate-pending.
  result = await runner.run({ inputs: RUN_INPUTS });
  eq(result.status, "stopped", "run 3 stops");
  eq(result.stepId, "plan.gate1", "run 3 stops at the [H] step");
  eq(result.record.status, "gate-pending", "gate record pending");
  eq(result.record.gateId, "gate-test-1", "gate id provenance");
  eq(gateCalls[0].gateKind, "plan.gate1", "gate kind is a supervisor kind");
  if (!gateCalls[0].summary.includes("SPEC")) fail("gate summary names what is approved");
  eq(gateCalls[0].facts.reads["plan.spec.record"].status, "done", "gate facts carry the record view");
  eq(gateCalls[0].facts.reads["plan.spec.record"].resolvedBy, "spec-agent", "resolution provenance rides the record view");

  resolve(storePath, "gate.plan.gate1", { approved: true }, "mateusz");

  // Run 4 — the gate completes via resolution; plan.decompose A0 hands off.
  result = await runner.run({ inputs: RUN_INPUTS });
  eq(result.status, "stopped", "run 4 stops");
  eq(result.stepId, "plan.decompose", "run 4 stops at the second [J] step");
  eq(result.record.status, "handed-off", "plan.decompose hands off");
  records = readRecords(storePath);
  eq(latest(records, "gate.plan.gate1").status, "done", "gate completed by resolution");
  eq(latest(records, "gate.plan.gate1").resolvedBy, "mateusz", "resolution provenance on the done record");

  resolve(storePath, "plan.decompose", DECOMPOSE_OUTPUT, "mateusz");

  // Run 5 — plan.gate2 emits and waits.
  result = await runner.run({ inputs: RUN_INPUTS });
  eq(result.status, "stopped", "run 5 stops");
  eq(result.stepId, "plan.gate2", "run 5 stops at gate2");
  eq(result.record.status, "gate-pending", "gate2 pending");

  resolve(storePath, "gate.plan.gate2", { approved: true }, "mateusz");

  // Run 6 — plan.push [D] through the injected Linear boundary.
  result = await runner.run({ inputs: RUN_INPUTS });
  eq(result.status, "completed", "run 6 completes the subgraph");
  eq(linearCalls.length, 1, "one Linear-boundary call");
  eq(linearCalls[0].action, "push-plan", "action shape");
  eq(linearCalls[0].payload.children.length, 1, "payload carries the decomposed tasks");
  eq(linearCalls[0].payload.children[0].title, "graph-runner.mjs", "payload task title");
  records = readRecords(storePath);
  eq(latest(records, "plan.push").status, "done", "push done");
  eq(latest(records, "plan.push").output.epicId, "FEN-900", "push output recorded");
  eq(generatorCalls, 2, "[G] never re-executed across resumes");
  eq(callerCalls.length, 2, "two seam calls since the reset (plan.ac.testable, plan.decompose)");

  // Run 7 — fully idempotent: every step done, nothing re-runs.
  const callsBefore = callerCalls.length;
  result = await runner.run({ inputs: RUN_INPUTS });
  eq(result.status, "completed", "run 7 completed");
  eq(callerCalls.length, callsBefore, "no seam call on a completed run");
});

await test("runner-built questions ride the seam call (registry id governs provenance)", async () => {
  const { storePath } = tempStore();
  const calls = [];
  const runner = makeRunner({
    caller: async (input) => { calls.push(input); return a0Envelope("plan.dor", { q_ready: { type: "noul", noul: 0.5 } }); },
    generator: async () => ({}),
    gateEmitter: async () => ({}),
    linearEffect: async () => ({}),
    storePath,
  });
  await runner.run({ inputs: RUN_INPUTS });
  eq(calls.length, 1, "one call");
  eq(calls[0].decisionId, "plan.dor", "decisionId present");
  if (!calls[0].questions) fail("runner-built questions present");
  eq(Object.keys(calls[0].questions).length, 1, "plan.dor carries exactly one runner-built question");
});

console.log("\ngraph-runner: fail-closed paths");

await test("a [J] provider error exhausts the cascade: tier 2 dead, tier 3 frontman hand-off", async () => {
  const { storePath } = tempStore();
  let calls = 0;
  const runner = makeRunner({
    caller: async () => { calls++; return { ok: false, error: { code: "provider_error", message: "tier-1 down (stub)" } }; },
    generator: async () => ({}),
    gateEmitter: async () => ({}),
    linearEffect: async () => ({}),
    storePath,
  });
  const result = await runner.run({ inputs: RUN_INPUTS });
  eq(result.status, "stopped", "run stops");
  eq(result.record.status, "handed-off", "hand-off, not a hard failure — the frontman decides");
  eq(result.record.tier, 3, "cascade rung recorded");
  if (!result.record.reason.includes("tier 2 is disabled")) fail("reason names the dead rung");
  eq(result.record.error.code, "provider_error", "triggering error carried WITH the record");
  eq(calls, 1, "one seam call — the seam owns retries, the runner owns the ladder");
});

await test("a schema-invalid [G] output fails the step and stops the run", async () => {
  const { storePath } = tempStore();
  const runner = makeRunner({
    caller: async () => a0Envelope("plan.dor", { q_ready: { type: "noul", noul: 0.9 } }),
    // plan.dod runs first and must pass; the invalid shape fails plan.ac's output schema
    generator: async ({ stepId }) => (stepId === "plan.dod" ? DOD_OUTPUT : { acs: "not-a-list" }),
    gateEmitter: async () => ({}),
    linearEffect: async () => ({}),
    storePath,
  });
  await runner.run({ inputs: RUN_INPUTS }); // plan.dor handed-off
  resolve(storePath, "plan.dor", { ready: true, gaps: [] });
  const result = await runner.run({ inputs: RUN_INPUTS }); // plan.ac [G] runs
  eq(result.status, "stopped", "run stops");
  eq(result.stepId, "plan.ac", "stopped at the [G] step");
  eq(result.record.status, "failed", "failed record");
  eq(result.record.error.code, "schema_invalid", "typed code");
  const records = readRecords(storePath);
  eq(latest(records, "plan.ac").status, "failed", "failure persisted");
  if (records.some((r) => r.key === "plan.spec")) fail("nothing downstream executes");
});

await test("a missing read is a typed failure record, never a guess", async () => {
  const { storePath } = tempStore();
  const runner = makeRunner({
    caller: async () => ({}),
    generator: async () => ({}),
    gateEmitter: async () => ({}),
    linearEffect: async () => ({}),
    storePath,
  });
  const result = await runner.run({ inputs: { "repoState.pinned": { branch: "x" } } }); // inbox.entry missing
  eq(result.status, "stopped", "run stops");
  eq(result.record.status, "failed", "failed record");
  eq(result.record.error.code, "invalid_input", "typed code");
  if (!result.record.error.message.includes('inbox.entry')) fail("message names the missing read");
});

await test("a corrupt store line refuses to resume (the history is the state)", async () => {
  const { storePath } = tempStore();
  writeFileSync(storePath, '{"type":"graph.step","key":"plan.dor"\n');
  const runner = makeRunner({
    caller: async () => ({}),
    generator: async () => ({}),
    gateEmitter: async () => ({}),
    linearEffect: async () => ({}),
    storePath,
  });
  try {
    await runner.run({ inputs: RUN_INPUTS });
    fail("a corrupt store must refuse");
  } catch (err) {
    eqCode(err, "schema_invalid", "corrupt store");
    if (!err.message.includes("line 1")) fail("message names the corrupt line");
  }
});

await test("an invalid resolution is refused, not recorded — the step can be re-resolved", async () => {
  const { storePath } = tempStore();
  const runner = makeRunner({
    caller: async () => a0Envelope("plan.dor", { q_ready: { type: "noul", noul: 0.9 } }),
    generator: async () => ({}),
    gateEmitter: async () => ({}),
    linearEffect: async () => ({}),
    storePath,
  });
  await runner.run({ inputs: RUN_INPUTS }); // plan.dor handed-off
  resolve(storePath, "plan.dor", { ready: "yes" }); // fails the output schema (ready must be boolean)
  const before = readFileSync(storePath, "utf8");
  try {
    await runner.run({ inputs: RUN_INPUTS });
    fail("an invalid resolution must be refused");
  } catch (err) {
    eqCode(err, "schema_invalid", "invalid resolution");
  }
  eq(readFileSync(storePath, "utf8"), before, "nothing appended on the refusal");
});

await test("a resolution without a base run record is a typed failure, not a silent continue", async () => {
  const { storePath } = tempStore();
  const runner = makeRunner({
    caller: async () => a0Envelope("plan.dor", { q_ready: { type: "noul", noul: 0.9 } }),
    generator: async ({ stepId }) => (stepId === "plan.dod" ? DOD_OUTPUT : AC_OUTPUT),
    gateEmitter: async () => ({}),
    linearEffect: async () => ({}),
    storePath,
  });
  await runner.run({ inputs: RUN_INPUTS }); // plan.dor handed-off
  resolve(storePath, "plan.dor", { ready: true, gaps: [] });
  resolve(storePath, "plan.ac", AC_OUTPUT); // a resolution with NO plan.ac run record
  const result = await runner.run({ inputs: RUN_INPUTS }); // plan.dor completes; plan.ac hits the orphan
  eq(result.status, "stopped", "run stops");
  eq(result.stepId, "plan.ac", "stopped at the orphaned step");
  eq(result.record.status, "failed", "failed record");
  eq(result.record.error.code, "invalid_input", "typed code");
  if (!result.record.error.message.includes("no run record")) fail("message names the unexpected state");
});

await test("the default Linear boundary refuses — the runner never writes to Linear on its own", async () => {
  const { storePath } = tempStore();
  // Seed the store with the resolved predecessors; plan.push then faces the
  // default boundary with no injected effect.
  writeFileSync(storePath, "");
  const runner = makeRunner({
    caller: async () => a0Envelope("plan.dor", { q_ready: { type: "noul", noul: 0.9 } }),
    generator: async () => ({}),
    gateEmitter: async () => ({}),
    linearEffect: undefined, // the default refusal
    storePath,
  });
  // Drive the predecessors by hand-recorded resolutions: seed done records.
  const done = (key, stepId, output) => JSON.stringify({ type: "graph.step", runId: "run-e2e", ts: "2026-01-01T00:00:00.000Z", key, status: "done", stepId, output });
  appendFileSync(storePath, done("plan.dor", "plan.dor", { ready: true, gaps: [] }) + "\n");
  appendFileSync(storePath, done("plan.dod", "plan.dod", DOD_OUTPUT) + "\n");
  appendFileSync(storePath, done("plan.ac", "plan.ac", AC_OUTPUT) + "\n");
  appendFileSync(storePath, done("plan.spec", "plan.spec", SPEC_OUTPUT) + "\n");
  appendFileSync(storePath, done("gate.plan.gate1", "plan.gate1", { approved: true }) + "\n");
  appendFileSync(storePath, done("plan.decompose", "plan.decompose", DECOMPOSE_OUTPUT) + "\n");
  appendFileSync(storePath, done("gate.plan.gate2", "plan.gate2", { approved: true }) + "\n");
  const result = await runner.run({ inputs: RUN_INPUTS });
  eq(result.status, "stopped", "run stops at the boundary refusal");
  eq(result.record.status, "failed", "failed record");
  eq(result.record.error.code, "provider_error", "typed code");
  if (!result.record.error.message.includes("performs no writes")) fail("message names the refusal");
});

await test("a gate answered rejected records gate-rejected and stops (downstream never runs)", async () => {
  const { storePath } = tempStore();
  const runner = makeRunner({
    caller: async (input) => (input.decisionId === "plan.ac.testable" ? testableEnvelope(input) : a0Envelope("plan.dor", { q_ready: { type: "noul", noul: 0.9 } })),
    generator: async ({ stepId }) => (stepId === "plan.dod" ? DOD_OUTPUT : AC_OUTPUT),
    gateEmitter: async () => ({ gateId: "gate-test-1" }),
    linearEffect: async () => { fail("linear effect must not run after a rejection"); },
    storePath,
  });
  await runner.run({ inputs: RUN_INPUTS }); // plan.dor handed-off
  resolve(storePath, "plan.dor", { ready: true, gaps: [] });
  await runner.run({ inputs: RUN_INPUTS }); // plan.ac done, plan.spec handed-off
  resolve(storePath, "plan.spec", SPEC_OUTPUT);
  const result = await runner.run({ inputs: RUN_INPUTS }); // gate1 pending
  eq(result.record.status, "gate-pending", "gate waited");
  resolve(storePath, "gate.plan.gate1", { approved: false }, "mateusz");
  const rejected = await runner.run({ inputs: RUN_INPUTS });
  eq(rejected.status, "stopped", "run stops");
  eq(rejected.record.status, "gate-rejected", "gate-rejected record");
  const records = readRecords(storePath);
  if (records.some((r) => r.key === "plan.decompose")) fail("decompose must never run after a rejection");
});

await test("an unknown record status is a typed failure (unexpected state, never guessed)", async () => {
  const { storePath } = tempStore();
  appendFileSync(storePath, `${JSON.stringify({ type: "graph.step", runId: "run-e2e", ts: "2026-01-01T00:00:00.000Z", key: "plan.dor", status: "quantum", stepId: "plan.dor" })}\n`);
  const runner = makeRunner({
    caller: async () => ({}),
    generator: async () => ({}),
    gateEmitter: async () => ({}),
    linearEffect: async () => ({}),
    storePath,
  });
  const result = await runner.run({ inputs: RUN_INPUTS });
  eq(result.record.status, "failed", "failed record");
  eq(result.record.error.code, "invalid_input", "typed code");
  if (!result.record.error.message.includes("quantum")) fail("message names the unknown status");
});

console.log("\ngraph-runner: decide edges (D4 — the cascade ladder, A0 posture)");

await test("orchestration.next_step serves through the seam's registry channel and hands off", async () => {
  const { storePath } = tempStore();
  const calls = [];
  const runner = makeRunner({
    caller: async (input) => { calls.push(input); return a0Envelope("orchestration.next_step", { next: { type: "choice", choice: "advance", probabilities: { advance: 0.9 } } }); },
    generator: async () => ({}),
    gateEmitter: async () => ({}),
    linearEffect: async () => ({}),
    storePath,
  });
  const result = await runner.decideEdge("orchestration.next_step", { state: "Frontman checkpoint: what next?" });
  eq(result.status, "handed-off", "handed to the frontman");
  eq(result.record.status, "handed-off", "handed-off record");
  if (!result.record.annotation?.answers?.next) fail("annotation recorded");
  if ("output" in result.record) fail("an A0 annotation is never an operative output — never auto-act");
  eq(result.record.tier, 1, "served at tier 1");
  eq(calls.length, 1, "one call");
  eq(calls[0].decisionId, "orchestration.next_step", "registry id call");
  if ("questions" in calls[0]) fail("decide edges carry their own registry question set — no runner-built questions");
  // Idempotent: a second decide does not re-call while handed off.
  const again = await runner.decideEdge("orchestration.next_step", { state: "again" });
  eq(again.status, "handed-off", "still waiting");
  eq(calls.length, 1, "no second HTTP call");
});

await test("a decide-edge provider error lands at tier 3 with the triggering error", async () => {
  const { storePath } = tempStore();
  const runner = makeRunner({
    caller: async () => ({ ok: false, error: { code: "provider_error", message: "down (stub)" } }),
    generator: async () => ({}),
    gateEmitter: async () => ({}),
    linearEffect: async () => ({}),
    storePath,
  });
  const result = await runner.decideEdge("orchestration.next_step", { state: "s" });
  eq(result.status, "handed-off", "frontman hand-off, not a crash");
  eq(result.record.tier, 3, "cascade rung recorded");
  eq(result.record.error.code, "provider_error", "triggering error carried");
});

await test("an unknown decision edge throws typed invalid_input with no record", async () => {
  const { storePath } = tempStore();
  const runner = makeRunner({
    caller: async () => ({}),
    generator: async () => ({}),
    gateEmitter: async () => ({}),
    linearEffect: async () => ({}),
    storePath,
  });
  try {
    await runner.decideEdge("no.such.edge", { state: "x" });
    fail("unknown edge must refuse");
  } catch (err) {
    eqCode(err, "invalid_input", "unknown edge");
  }
  eq(existsSync(storePath), false, "nothing recorded for an unknown edge");
});

console.log("\ngraph-runner: CLI (typed envelope, no network)");

await test("the CLI refuses an unknown edge with a typed envelope and exit 1", () => {
  const { dir, storePath } = tempStore();
  try {
    const res = spawnSync(process.execPath, [join(__dir, "graph-runner.mjs"), "decide", "--edge", "no.such.edge", "--run-id", "run-cli", "--store", storePath], { encoding: "utf8" });
    eq(res.status, 1, "exit 1");
    const out = JSON.parse(res.stdout);
    eq(out.ok, false, "typed failure envelope");
    eq(out.error.code, "invalid_input", "typed code");
    if (!out.error.message.includes("no.such.edge")) fail("message names the edge");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("the CLI refuses to run without --run-id", () => {
  const res = spawnSync(process.execPath, [join(__dir, "graph-runner.mjs"), "run"], { encoding: "utf8" });
  eq(res.status, 1, "exit 1");
  const out = JSON.parse(res.stdout);
  eq(out.error.code, "provider_error", "failCli default code");
  if (!out.error.message.includes("--run-id")) fail("message names the missing flag");
});

console.log(`\ngraph-runner: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("\nfailed tests:");
  for (const name of failures) console.error("  - " + name);
  process.exit(1);
}