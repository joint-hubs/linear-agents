// scripts/graph-runner.test.mjs — FOC-397: the graph.json v2 executor.
//
// Covers the runner contract end to end, all offline: the resumable walk over
// the committed PLAN subgraph (11 steps, 10 sequence edges) with every external
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
import { createGraphRunner, createLiveCaller, G_TIMEOUT_MS } from "./graph-runner.mjs";

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

// plan.intent joined the chain between plan.dor and plan.dod (FOC-515). The
// stub map is round 1 with the task type unknown, so §3.12 requires all eight
// perspectives. The items exercise every FOC-516 selection route: IN-1/IN-2
// inferred (confirmations at high impact), IN-3 stated with a quote (the
// "Rozumiem tak" route when grounding reads yes), IN-4..IN-7 inferred low
// (assumptions), IN-8 unknown with options (the question route — a map item
// the schema REQUIRES to carry options). plan.dor resolves with no gaps here,
// so the coverage check is vacuous — the check itself is pinned in
// scripts/plan-intent.test.mjs.
const INTENT_OUTPUT = {
  goal: "The runner executes the PLAN subgraph with typed run records.",
  why: "So the executor is provably resumable before it runs a real task.",
  mapVersion: 1,
  interpretations: [
    { id: "IN-1", perspective: "goal", claim: "Rozumiem, że zmiana dotyczy wykonawcy grafu.", source: "inferred", alternatives: [], covers: [] },
    { id: "IN-2", perspective: "user", claim: "Rozumiem, że odbiorcą jest zespół utrzymujący runnera.", source: "inferred", alternatives: [], covers: [] },
    { id: "IN-3", perspective: "scope", claim: "Rozumiem, że w zakresie jest tylko wykonawca grafu.", source: "stated", quote: "the PLAN subgraph", alternatives: [], covers: [] },
    { id: "IN-4", perspective: "success", claim: "Rozumiem, że sukces to zielony test runnera.", source: "inferred", alternatives: [], covers: [] },
    { id: "IN-5", perspective: "constraints", claim: "Rozumiem, że nie wolno zmieniać kontraktu rekordów.", source: "inferred", alternatives: [], covers: [] },
    { id: "IN-6", perspective: "risk", claim: "Rozumiem, że ryzykiem jest trwałość rekordów runu.", source: "inferred", alternatives: [], covers: [] },
    { id: "IN-7", perspective: "priority", claim: "Rozumiem, że ważniejsza jest poprawność niż szybkość.", source: "inferred", alternatives: [], covers: [] },
    {
      id: "IN-8", perspective: "terms", claim: "Rozumiem, że opis nie zawiera niejasnych terminów.", source: "unknown", alternatives: [], covers: [],
      options: [
        { text: "Rozumiem, że opis nie zawiera niejasnych terminów.", recommended: true, reason: "the reading the dictated entry supports" },
        { text: "Rozumiem, że opis używa terminów wymagających słownika.", recommended: false },
      ],
    },
  ],
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

// The node-internal plan.intent.select.score call (FOC-516): two noul verdicts
// per interpretation instance, keyed by instance id. IN-1/IN-2 impact 0.9
// (inferred high → confirmations), IN-3 grounded 0.9 (stated grounded-yes →
// "Rozumiem tak"), IN-4..IN-7 impact 0.1 (inferred low → assumptions), IN-8
// impact 0.9 (unknown high → the question route). The eventId rides the
// envelope so the gate1 approval can label the delta next to this event.
const SELECT_IMPACT = { "IN-1": 0.9, "IN-2": 0.9, "IN-3": 0.1, "IN-4": 0.1, "IN-5": 0.1, "IN-6": 0.1, "IN-7": 0.1, "IN-8": 0.9 };
const SELECT_GROUNDED = { "IN-1": 0.9, "IN-2": 0.9, "IN-3": 0.9, "IN-4": 0.1, "IN-5": 0.1, "IN-6": 0.1, "IN-7": 0.1, "IN-8": 0.1 };
function selectScoreEnvelope(input) {
  const answers = {};
  (input.instances ?? []).forEach((inst, i) => {
    if (!(inst.id in SELECT_IMPACT)) fail(`unexpected select instance ${inst.id}`);
    answers[`impact${i}`] = { type: "noul", noul: SELECT_IMPACT[inst.id] };
    answers[`grounded${i}`] = { type: "noul", noul: SELECT_GROUNDED[inst.id] };
  });
  return { ok: true, decisionId: "plan.intent.select.score", autonomy: "A0", eventId: "evt-select-walk", annotation: { answers, confidence: 0.9 } };
}

// The frontman's pen: resolution records are appended by the DECIDING agent —
// the runner consumes them, never creates them. The ts is deliberately in the
// future relative to the runner's real now(): a resolution older than the
// pending gate record is STALE under the FOC-517 re-entry contract (it answered
// an earlier round), and the fixtures must not look stale.
function resolve(storePath, key, output, by = "frontman") {
  appendFileSync(storePath, `${JSON.stringify({
    type: "graph.resolution",
    runId: "run-e2e",
    ts: "2030-01-01T00:00:00.000Z",
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

// A runner wired to injected stubs; each test gets its own store dir. The
// delta-label runs dir (FOC-516) defaults to a temp sibling of the store —
// a gate1 approval must never write the live .state/runs ledger.
function makeRunner({ caller, generator, gateEmitter, linearEffect, storePath, runId = "run-e2e", decisionRunsDir }) {
  return createGraphRunner({
    runId, storePath, caller, generator, gateEmitter, linearEffect,
    decisionRunsDir: decisionRunsDir ?? join(dirname(storePath), "runs"),
  });
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

await test("the full resumable walk: 12 steps, 2 [J] annotations + the node-internal selection score + the readiness seam call, 3 [G] calls, 2 gates, one push, idempotent resume", async () => {
  const { dir, storePath } = tempStore();
  // The FOC-449 delta-label ledger: a temp runs dir pre-seeded with the event
  // the selection's scoring call will log, so the gate1 approval can write its
  // label next to it — never the live .state/runs.
  const runsDir = join(dir, "label-runs");
  mkdirSync(join(runsDir, "run-e2e"), { recursive: true });
  appendFileSync(join(runsDir, "run-e2e", "decisions.jsonl"), `${JSON.stringify({ type: "event", eventId: "evt-select-walk", decisionId: "plan.intent.select.score" })}\n`);
  const callerCalls = [];
  const caller = async (input) => {
    callerCalls.push(input);
    if (input.decisionId === "plan.dor") return a0Envelope("plan.dor", { q_ready: { type: "noul", noul: 0.9 } });
    if (input.decisionId === "plan.intent.select.score") return selectScoreEnvelope(input);
    if (input.decisionId === "plan.ac.testable") return testableEnvelope(input);
    if (input.decisionId === "plan.readiness") {
      // FOC-476: the readiness gate — the base verdict clears and every
      // confirmed item is covered, so the chain continues to plan.decompose.
      const answers = { ready: { type: "noul", noul: 0.9 } };
      INTENT_OUTPUT.interpretations.forEach((_, i) => { answers[`q${i}`] = { type: "noul", noul: 0.9 }; });
      return a0Envelope("plan.readiness", answers);
    }
    if (input.decisionId === "plan.decompose") return a0Envelope("plan.decompose", { q_size: { type: "choice", choice: "medium", probabilities: { medium: 0.9 } }, q_relations: { type: "choice", choice: "standalone", probabilities: { standalone: 0.8 } } });
    return fail(`unexpected caller decisionId ${input.decisionId}`);
  };
  let generatorCalls = 0;
  const generator = async ({ stepId, reads }) => {
    generatorCalls++;
    if (stepId === "plan.intent") {
      if (typeof reads["inbox.entry"] === "undefined") fail("inbox.entry read missing");
      if (typeof reads["plan.dor.gaps"] === "undefined") fail("plan.dor.gaps read missing");
      if ("intake.taskType" in reads) fail("the round-1 reads are absent by design, not supplied empty");
      return INTENT_OUTPUT;
    }
    if (stepId === "plan.dod") {
      // FOC-517: plan.dod reads the runner-appended confirmed-intent record,
      // not the raw inbox entry — the plan is never built on an unconfirmed
      // intent.
      const confirmed = reads["plan.intent.confirmed"];
      if (typeof confirmed !== "object" || confirmed?.goal !== INTENT_OUTPUT.goal) fail("plan.intent.confirmed read missing");
      if (confirmed?.round !== 1) fail("the confirmed record carries the round");
      return DOD_OUTPUT;
    }
    eq(stepId, "plan.ac", "generator serves plan.intent, plan.dod then plan.ac");
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

  const runner = makeRunner({ caller, generator, gateEmitter, linearEffect, storePath, decisionRunsDir: runsDir });

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

  // Run 2 — plan.intent [G] executes, plan.intent.select routes the map (its
  // node-internal [J] call, no [G] generator call), and the REPOSITIONED gate1
  // emits the supervisor gate and stops gate-pending (FOC-516).
  result = await runner.run({ inputs: RUN_INPUTS });
  eq(result.status, "stopped", "run 2 stops");
  eq(result.stepId, "plan.gate1", "run 2 stops at the repositioned [H] step");
  eq(result.record.status, "gate-pending", "gate record pending");
  eq(result.record.gateId, "gate-test-1", "gate id provenance");
  eq(generatorCalls, 1, "only plan.intent made a [G] call — the selection is node-internal code + one [J] call");
  eq(callerCalls.length, 1, "one seam call: the selection's plan.intent.select.score");
  eq(callerCalls[0].decisionId, "plan.intent.select.score", "call by registry id");
  eq(callerCalls[0].instances.length, 8, "one instance per interpretation");
  eq(gateCalls[0].gateKind, "plan.gate1", "gate kind is a supervisor kind");
  if (!gateCalls[0].summary.includes("intent conversation")) fail("gate summary names the FOC-517 intent conversation");
  eq(gateCalls[0].facts.round, 1, "round bookkeeping in the gate facts");
  if (!gateCalls[0].facts.display.includes("Czy dobrze rozumiem? (runda 1/3)")) fail("the gate facts carry the round-1 display");
  eq(gateCalls[0].facts.reads["plan.intent.select.record"].status, "done", "gate facts carry the selection record view");

  records = readRecords(storePath);
  const sel = latest(records, "plan.intent.select");
  eq(sel.status, "done", "the selection record landed before the gate");
  eq(sel.output.questions.length, 1, "IN-8 (unknown, high impact) is the one question");
  eq(sel.output.questions[0].id, "IN-8", "the question carries the map's own options");
  eq(sel.output.confirmations.map((c) => c.id).join(","), "IN-1,IN-2", "inferred high-impact items are confirmations");
  eq(sel.output.understood.map((c) => c.id).join(","), "IN-3", "the stated item reads as a 'Rozumiem tak' line");
  eq(sel.output.assumptions.length, 4, "the inferred low-impact items stay listed as assumptions");
  eq(sel.eventId, "evt-select-walk", "the scoring event id rides the record");

  resolve(storePath, "gate.plan.gate1", { approved: true, answer: "ok" }, "mateusz");

  // Run 3 — the gate completes via the FOC-517 settlement: "ok" accepts every
  // recommendation, so the round confirms, the runner appends the
  // plan.intent.confirmed record and the chain continues; the FOC-449 delta
  // label is written next to the scoring event (every recommendation taken →
  // the honest marker is "accepted"); plan.dod + plan.ac [G] execute; plan.spec
  // [A] hands off.
  result = await runner.run({ inputs: RUN_INPUTS });
  eq(result.status, "stopped", "run 3 stops");
  eq(result.stepId, "plan.spec", "run 3 stops at the [A] step");
  eq(result.record.status, "handed-off", "plan.spec hands off");
  deepEq(result.record.handoff.reads["plan.ac.acs"], AC_OUTPUT.acs, "the [A] hand-off carries the resolved reads");
  deepEq(result.record.handoff.reads["plan.intent.confirmed"].interpretations, INTENT_OUTPUT.interpretations, "the confirmed intent rides the hand-off reads");
  eq(generatorCalls, 3, "[G] executed exactly once each (plan.intent, plan.dod, plan.ac)");
  records = readRecords(storePath);
  eq(latest(records, "gate.plan.gate1").status, "done", "gate completed by resolution");
  eq(latest(records, "gate.plan.gate1").resolvedBy, "mateusz", "resolution provenance on the done record");
  eq(latest(records, "gate.plan.gate1").output.confirmed, true, "the runner computed confirmed");
  eq(latest(records, "gate.plan.gate1").output.round, 1, "round bookkeeping on the done record");
  eq(latest(records, "gate.plan.gate1").output.answers.length, 1, "the 'ok' answer became one answer record (the presented question)");
  const confirmedRecord = records.find((r) => r.key === "plan.intent.confirmed");
  eq(confirmedRecord?.status, "done", "the confirmed-intent record landed");
  eq(confirmedRecord?.output?.round, 1, "confirmed in round 1");
  eq(confirmedRecord?.output?.mapVersion, 1, "the presented mapVersion is the confirmed one");
  eq(latest(records, "gate.plan.gate1").deltaLabel?.outcome, "accepted", "'ok' took every recommendation — no delta to label");
  eq(latest(records, "gate.plan.gate1").deltaLabelWritten, join(runsDir, "run-e2e", "decisions.jsonl"), "the label landed next to the scoring event");

  resolve(storePath, "plan.spec", SPEC_OUTPUT, "spec-agent");

  // Run 4 — plan.decompose A0 hands off.
  result = await runner.run({ inputs: RUN_INPUTS });
  eq(result.status, "stopped", "run 4 stops");
  eq(result.stepId, "plan.decompose", "run 4 stops at the second [J] step");
  eq(result.record.status, "handed-off", "plan.decompose hands off");

  resolve(storePath, "plan.decompose", DECOMPOSE_OUTPUT, "mateusz");

  // Run 5 — plan.render [D] composes the issue text deterministically, then
  // draft-approval emits and waits. The gate's resolved reads are the facts
  // shown to the human, so they carry the rendered text VERBATIM.
  result = await runner.run({ inputs: RUN_INPUTS });
  eq(result.status, "stopped", "run 5 stops");
  eq(result.stepId, "draft-approval", "run 5 stops at the draft-approval [H] step");
  eq(result.record.status, "gate-pending", "draft-approval pending");
  records = readRecords(storePath);
  const renderRecord = latest(records, "plan.render");
  eq(renderRecord.status, "done", "plan.render executed before the gate");
  if (typeof renderRecord.output?.issueText !== "string" || !renderRecord.output.issueText.includes("AC-1")) {
    fail("the render record carries the composed issue text");
  }
  eq(gateCalls[1].facts.reads["plan.render.issueText"], renderRecord.output.issueText, "draft-approval facts carry the rendered text verbatim");

  resolve(storePath, "gate.draft-approval", { approved: true }, "mateusz");

  // Run 6 — plan.push [D] through the injected Linear boundary.
  result = await runner.run({ inputs: RUN_INPUTS });
  eq(result.status, "completed", "run 6 completes the subgraph");
  eq(linearCalls.length, 1, "one Linear-boundary call");
  eq(linearCalls[0].action, "push-plan", "action shape");
  eq(linearCalls[0].payload.issueText, renderRecord.output.issueText, "the pushed issueText is the rendered text 1:1 — no rewording");
  eq(linearCalls[0].payload.children.length, 1, "payload carries the decomposed tasks");
  eq(linearCalls[0].payload.children[0].title, "graph-runner.mjs", "payload task title");
  records = readRecords(storePath);
  eq(latest(records, "plan.push").status, "done", "push done");
  eq(latest(records, "plan.push").output.epicId, "FEN-900", "push output recorded");
  eq(generatorCalls, 3, "[G] never re-executed across resumes");
  eq(callerCalls.length, 4, "four seam calls since the reset (plan.intent.select.score, plan.ac.testable, plan.readiness, plan.decompose)");

  // Run 7 — fully idempotent: every step done, nothing re-runs.
  const callsBefore = callerCalls.length;
  result = await runner.run({ inputs: RUN_INPUTS });
  eq(result.status, "completed", "run 7 completed");
  eq(callerCalls.length, callsBefore, "no seam call on a completed run");
});

console.log("\ngraph-runner: the FOC-517 intent conversation (gate1)");

// A fresh runner+store walked to the round-1 gate: plan.dor resolved, the map
// generated and selected, gate1 pending. Returns the runner and the store path.
async function walkToGate1({ caller, generator, storePath }) {
  const runner = makeRunner({ caller, generator, gateEmitter: async ({ stepId, gateKind, summary, facts }) => ({ gateId: `gate-test-${stepId}-${facts.round}` }), linearEffect: async () => ({}), storePath });
  let result = await runner.run({ inputs: RUN_INPUTS });
  eq(result.stepId, "plan.dor", "walk: run 1 stops at plan.dor");
  resolve(storePath, "plan.dor", { ready: true, gaps: [] }, "mateusz");
  result = await runner.run({ inputs: RUN_INPUTS });
  eq(result.stepId, "plan.gate1", "walk: run 2 stops at gate1");
  eq(result.record.status, "gate-pending", "walk: gate1 pending");
  return { runner, result };
}

const CORRECTION_CLAIM = INTENT_OUTPUT.interpretations[0].claim; // IN-1, the first block-2 letter
const roundNCorrection = (n) => ({
  round: n,
  mapVersion: n, // the fold's cross-check: the reference names the mapVersion round n actually presented
  interpretationId: "IN-1",
  about: { claim: CORRECTION_CLAIM },
  corrected: `Rozumiem, że poprawka rundy ${n} obowiązuje.`,
});

// Each round regenerates the map — the persisted store requires the NEXT
// mapVersion, so the Nth plan.intent call returns a map stamped N.
const intentMapForCall = (call) => ({ ...INTENT_OUTPUT, mapVersion: call });

await test("round 1 answered with a correction re-enters plan.intent; the exact resolution key settles the round and round 2 confirms", async () => {
  const { storePath } = tempStore();
  const genReads = [];
  let intentCalls = 0;
  const generator = async ({ stepId, reads }) => {
    if (stepId === "plan.intent") { genReads.push(reads); return intentMapForCall(++intentCalls); }
    if (stepId === "plan.dod") return DOD_OUTPUT;
    return AC_OUTPUT;
  };
  const caller = async (input) => {
    if (input.decisionId === "plan.dor") return a0Envelope("plan.dor", { q_ready: { type: "noul", noul: 0.9 } });
    if (input.decisionId === "plan.intent.select.score") return selectScoreEnvelope(input);
    if (input.decisionId === "plan.ac.testable") return testableEnvelope(input);
    if (input.decisionId === "plan.decompose") return a0Envelope("plan.decompose", { q_size: { type: "choice", choice: "medium", probabilities: { medium: 0.9 } }, q_relations: { type: "choice", choice: "standalone", probabilities: { standalone: 0.8 } } });
    return fail(`unexpected caller decisionId ${input.decisionId}`);
  };
  const gateRounds = [];
  const gateEmitter = async ({ facts }) => { gateRounds.push(facts.round); return { gateId: `gate-test-r${facts.round}` }; };
  const runner = makeRunner({ caller, generator, gateEmitter, linearEffect: async () => ({}), storePath });
  let result = await runner.run({ inputs: RUN_INPUTS });
  eq(result.stepId, "plan.dor", "run 1 stops at plan.dor");
  resolve(storePath, "plan.dor", { ready: true, gaps: [] }, "mateusz");
  result = await runner.run({ inputs: RUN_INPUTS });
  eq(result.stepId, "plan.gate1", "run 2 stops at gate1 round 1");
  eq(result.record.output.round, 1, "the pending record carries the round");
  deepEq(Object.keys(result.record.output.presented), ["1"], "round 1 presented exactly one slice");
  const shown = result.record.output.presented["1"];
  eq(shown.mapVersion, 1, "the presented slice stamps the map's version");
  deepEq(shown.confirmations.map((c) => c.id), ["IN-1", "IN-2"], "the display's block-2 letters come from the confirmations first");
  if (!gateRounds.includes(1)) fail("the gate emitter saw round 1");

  // The frontman answers with a block-2 correction — the round cannot confirm.
  resolve(storePath, "gate.plan.gate1", { approved: true, answer: "a nie Rozumiem, że poprawka rundy 1 obowiązuje." }, "mateusz");
  result = await runner.run({ inputs: RUN_INPUTS });
  eq(result.stepId, "plan.gate1", "the re-entry walks back to gate1 round 2");
  eq(result.record.status, "gate-pending", "round 2 pending");
  eq(result.record.output.round, 2, "the round advanced");
  deepEq(Object.keys(result.record.output.presented).sort(), ["1", "2"], "the presented map accumulates across rounds");
  eq(gateRounds[gateRounds.length - 1], 2, "the gate emitter saw round 2");
  eq(genReads.length, 2, "plan.intent re-executed for the folded map");
  deepEq(genReads[1]["gate.plan.gate1.corrections"], [roundNCorrection(1)], "round-2 reads carry the settled correction from the reset record");

  // The append-only store rode the re-entry: reset records for the re-entered
  // steps (the re-walk then re-executes them, so the LATEST record is done
  // again), the done record for the unconfirmed round.
  let records = readRecords(storePath);
  eq(records.some((r) => r.key === "plan.intent" && r.status === "reset"), true, "plan.intent rode a reset record");
  eq(records.some((r) => r.key === "plan.intent.select" && r.status === "reset"), true, "plan.intent.select rode a reset record");
  eq(records.some((r) => r.key === "gate.plan.gate1" && r.status === "reset"), true, "gate.plan.gate1 rode a reset record carrying the round's answers/corrections");
  const round1Done = records.filter((r) => r.key === "gate.plan.gate1" && r.status === "done")[0];
  eq(round1Done?.output?.confirmed, false, "round 1 landed as a done record with confirmed=false");
  deepEq(round1Done?.output?.corrections, [roundNCorrection(1)], "the settled correction rides the done record");

  // Round 2: "ok" answers every presented question on the recommendation and
  // corrects nothing — the round confirms.
  resolve(storePath, "gate.plan.gate1", { approved: true, answer: "ok" }, "mateusz");
  result = await runner.run({ inputs: RUN_INPUTS });
  eq(result.stepId, "plan.spec", "the confirmed round continues the chain to the [A] hand-off");
  records = readRecords(storePath);
  const settled = records.filter((r) => r.key === "gate.plan.gate1" && r.status === "done").pop();
  eq(settled.output.confirmed, true, "round 2 confirmed");
  eq(settled.output.round, 2, "the round bookkeeping is the runner's, not the resolution's");
  const confirmedRecord = records.find((r) => r.key === "plan.intent.confirmed");
  eq(confirmedRecord?.status, "done", "the confirmed-intent record landed");
  eq(confirmedRecord?.output?.round, 2, "it stamps the confirming round");
  eq(confirmedRecord?.output?.mapVersion, 2, "and the round-2 presented mapVersion (the re-generated map)");
  deepEq(confirmedRecord?.output?.corrections, [], "the confirmed record carries the CONFIRMING round's corrections — round 2's 'ok' corrected nothing; round 1's correction lives on its own done record");
  // THE exact resolution key the frontman writes — no alias exists.
  const resolutionKeys = [...new Set(records.filter((r) => r.type === "graph.resolution").map((r) => r.key))];
  deepEq(resolutionKeys.filter((k) => k.includes("gate1")), ["gate.plan.gate1.resolution"], "the resolution key is exactly gate.plan.gate1.resolution");
});

await test("a free-text answer is annotated by plan.intent.reply and settled only by a NEW resolution carrying answers", async () => {
  const { storePath } = tempStore();
  const replyCalls = [];
  const caller = async (input) => {
    if (input.decisionId === "plan.dor") return a0Envelope("plan.dor", { q_ready: { type: "noul", noul: 0.9 } });
    if (input.decisionId === "plan.intent.select.score") return selectScoreEnvelope(input);
    if (input.decisionId === "plan.intent.reply") {
      replyCalls.push(input);
      // touched0: the annotation pins the answer to IN-1's point.
      return a0Envelope("plan.intent.reply", {
        reply: { type: "choice", choice: "corrected", probabilities: { corrected: 0.7, confirmed: 0.2, new_scope: 0.1, stop: 0.0 } },
        touched0: { type: "noul", noul: true },
      });
    }
    if (input.decisionId === "plan.ac.testable") return testableEnvelope(input);
    return fail(`unexpected caller decisionId ${input.decisionId}`);
  };
  const generator = async ({ stepId }) => (stepId === "plan.intent" ? INTENT_OUTPUT : stepId === "plan.dod" ? DOD_OUTPUT : AC_OUTPUT);
  const { runner, result } = await (async () => {    const r = makeRunner({ caller, generator, gateEmitter: async ({ facts }) => ({ gateId: `gate-test-r${facts.round}` }), linearEffect: async () => ({}), storePath });
    let res = await r.run({ inputs: RUN_INPUTS });
    eq(res.stepId, "plan.dor", "run 1 stops at plan.dor");
    resolve(storePath, "plan.dor", { ready: true, gaps: [] }, "mateusz");
    res = await r.run({ inputs: RUN_INPUTS });
    eq(res.stepId, "plan.gate1", "run 2 stops at gate1");
    return { runner: r, result: res };
  })();

  // The frontman answers in free text — the annotation route.
  const freeAnswer = "Chodzi mi głównie o szybkość, reszta ok.";
  resolve(storePath, "gate.plan.gate1", { approved: true, answer: freeAnswer }, "mateusz");
  let res = await runner.run({ inputs: RUN_INPUTS });
  eq(res.status, "stopped", "the free-text round waits");
  eq(res.record.status, "handed-off", "the gate record hands off for the annotation");
  eq(replyCalls.length, 1, "ONE plan.intent.reply seam call");
  eq(replyCalls[0].instances.length, 8, "the instances are the presented items");
  if (!replyCalls[0].state.includes(freeAnswer)) fail("the annotation state carries the raw answer");
  eq(res.record.output.reply.classification, "corrected", "the annotation's classification rides the record");
  deepEq(res.record.output.reply.touched, ["IN-3"], "touched names the points the answer pinned (instances run understood → confirmations → assumptions → questions, so touched0 is IN-3)");
  eq(res.record.output.answer, freeAnswer, "the raw answer is kept verbatim — the annotation never replaces it");
  if (res.record.output.answers?.length) fail("the annotation never settles the round");

  // Repeating the same free-text resolution changes nothing.
  const before = readRecords(storePath).length;
  resolve(storePath, "gate.plan.gate1", { approved: true, answer: freeAnswer }, "mateusz");
  res = await runner.run({ inputs: RUN_INPUTS });
  eq(res.record.status, "handed-off", "still waiting on the same handed-off record");
  eq(replyCalls.length, 1, "no second annotation for the same answer");
  eq(readRecords(storePath).length, before + 1, "only the new resolution was appended");

  // The frontman settles the round with a NEW resolution carrying answers —
  // every presented question answered, nothing corrected → confirmed.
  resolve(storePath, "gate.plan.gate1", {
    approved: true,
    answer: freeAnswer,
    answers: [{
      round: 1, mapVersion: 1, interpretationId: "IN-8",
      about: { claim: INTENT_OUTPUT.interpretations[7].claim, option: INTENT_OUTPUT.interpretations[7].options[0].text },
      answer: INTENT_OUTPUT.interpretations[7].options[0].text,
      acceptedOptions: [INTENT_OUTPUT.interpretations[7].options[0].text],
    }],
    corrections: [],
  }, "mateusz");
  res = await runner.run({ inputs: RUN_INPUTS });
  eq(res.stepId, "plan.spec", "the settled round confirms and the chain continues");
  const records = readRecords(storePath);
  const confirmedRecord = records.find((r) => r.key === "plan.intent.confirmed");
  eq(confirmedRecord?.status, "done", "the confirmed-intent record landed");
  eq(confirmedRecord?.output?.round, 1, "round 1 confirmed");
  deepEq(confirmedRecord?.output?.answers[0]?.interpretationId, "IN-8", "the settled answer rode the fold");
});

await test("a resolution older than the pending gate record is STALE — it waits, nothing is applied", async () => {
  const { storePath } = tempStore();
  const caller = async (input) => {
    if (input.decisionId === "plan.dor") return a0Envelope("plan.dor", { q_ready: { type: "noul", noul: 0.9 } });
    if (input.decisionId === "plan.intent.select.score") return selectScoreEnvelope(input);
    return fail(`unexpected caller decisionId ${input.decisionId}`);
  };
  const generator = async ({ stepId }) => (stepId === "plan.intent" ? INTENT_OUTPUT : stepId === "plan.dod" ? DOD_OUTPUT : AC_OUTPUT);
  const runner = makeRunner({ caller, generator, gateEmitter: async ({ facts }) => ({ gateId: `gate-test-r${facts.round}` }), linearEffect: async () => ({}), storePath });
  let result = await runner.run({ inputs: RUN_INPUTS });
  resolve(storePath, "plan.dor", { ready: true, gaps: [] }, "mateusz");
  result = await runner.run({ inputs: RUN_INPUTS });
  const pendingTs = result.record.ts;

  // A resolution timestamped BEFORE the pending record answered an earlier
  // round (the re-entry re-emitted the gate) — the runner waits without
  // applying it.
  appendFileSync(storePath, `${JSON.stringify({
    type: "graph.resolution", runId: "run-e2e", ts: "2020-01-01T00:00:00.000Z",
    key: "gate.plan.gate1.resolution", stepId: "plan.gate1", by: "mateusz",
    output: { approved: true, answer: "ok" },
  })}\n`);
  result = await runner.run({ inputs: RUN_INPUTS });
  eq(result.status, "stopped", "stopped");
  eq(result.stepId, "plan.gate1", "still at the gate");
  eq(result.record.status, "gate-pending", "the pending record is untouched");
  eq(result.record.ts, pendingTs, "the SAME pending record — the stale resolution was not applied");
  const records = readRecords(storePath);
  if (records.some((r) => r.key === "plan.intent.confirmed")) fail("a stale resolution must not confirm the intent");
  if (records.some((r) => r.status === "reset")) fail("a stale resolution must not trigger the re-entry");
});

await test("three rounds without confirmation stop typed: intent_not_settled — the plan is never built on an unconfirmed intent", async () => {
  const { storePath } = tempStore();
  const genCalls = [];
  let intentCalls = 0;
  const generator = async ({ stepId }) => {
    genCalls.push(stepId);
    if (stepId === "plan.intent") return intentMapForCall(++intentCalls);
    return stepId === "plan.dod" ? DOD_OUTPUT : AC_OUTPUT;
  };
  const caller = async (input) => {
    if (input.decisionId === "plan.dor") return a0Envelope("plan.dor", { q_ready: { type: "noul", noul: 0.9 } });
    if (input.decisionId === "plan.intent.select.score") return selectScoreEnvelope(input);
    return fail(`unexpected caller decisionId ${input.decisionId}`);
  };
  const runner = makeRunner({ caller, generator, gateEmitter: async ({ facts }) => ({ gateId: `gate-test-r${facts.round}` }), linearEffect: async () => ({}), storePath });
  let result = await runner.run({ inputs: RUN_INPUTS });
  eq(result.stepId, "plan.dor", "run 1 stops at plan.dor");
  resolve(storePath, "plan.dor", { ready: true, gaps: [] }, "mateusz");

  // Each run() settles ONE round and walks the re-entry to the NEXT pending
  // gate — the conversation is three runs of corrections, then the cap.
  result = await runner.run({ inputs: RUN_INPUTS });
  eq(result.record.status, "gate-pending", "round 1 pending");
  eq(result.record.output.round, 1, "the runner counts round 1");
  resolve(storePath, "gate.plan.gate1", { approved: true, answer: "a nie poprawka" }, "mateusz");

  result = await runner.run({ inputs: RUN_INPUTS });
  eq(result.record.status, "gate-pending", "the corrected round 1 re-enters");
  eq(result.record.output.round, 2, "the runner counts round 2");
  resolve(storePath, "gate.plan.gate1", { approved: true, answer: "a nie poprawka" }, "mateusz");

  result = await runner.run({ inputs: RUN_INPUTS });
  eq(result.record.status, "gate-pending", "the corrected round 2 re-enters");
  eq(result.record.output.round, 3, "the runner counts round 3");
  resolve(storePath, "gate.plan.gate1", { approved: true, answer: "a nie poprawka" }, "mateusz");

  // The round-3 correction cannot confirm — the cap stops the chain typed.
  result = await runner.run({ inputs: RUN_INPUTS });
  eq(result.status, "stopped", "the run stops");
  eq(result.record.status, "failed", "a terminal failed record");
  eq(result.record.error.code, "intent_not_settled", "the typed code");
  if (!result.record.error.message.includes("did not settle in 3 rounds")) fail("the message names the cap");
  eq(result.record.output.round, 3, "the record carries the exhausted round");
  eq(result.record.output.confirmed, false, "never confirmed");
  const records = readRecords(storePath);
  if (records.some((r) => r.key === "plan.intent.confirmed")) fail("no confirmed-intent record on an unsettled conversation");
  if (genCalls.includes("plan.dod")) fail("the plan is never built on an unconfirmed intent — plan.dod never ran");
});

await test("runner-built questions ride the seam call (registry id governs provenance)", async () => {  const { storePath } = tempStore();
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
    caller: async (input) => (input.decisionId === "plan.intent.select.score" ? selectScoreEnvelope(input) : a0Envelope("plan.dor", { q_ready: { type: "noul", noul: 0.9 } })),
    // plan.intent and plan.dod run first and must pass; the invalid shape fails plan.ac's output schema
    generator: async ({ stepId }) => (stepId === "plan.intent" ? INTENT_OUTPUT : stepId === "plan.dod" ? DOD_OUTPUT : { acs: "not-a-list" }),
    gateEmitter: async () => ({}),
    linearEffect: async () => ({}),
    storePath,
  });
  await runner.run({ inputs: RUN_INPUTS }); // plan.dor handed-off
  resolve(storePath, "plan.dor", { ready: true, gaps: [] });
  await runner.run({ inputs: RUN_INPUTS }); // the selection routes the map; gate1 stops gate-pending
  resolve(storePath, "gate.plan.gate1", { approved: true, answer: "ok" });
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
    caller: async (input) => (input.decisionId === "plan.intent.select.score" ? selectScoreEnvelope(input) : a0Envelope("plan.dor", { q_ready: { type: "noul", noul: 0.9 } })),
    generator: async ({ stepId }) => (stepId === "plan.intent" ? INTENT_OUTPUT : stepId === "plan.dod" ? DOD_OUTPUT : AC_OUTPUT),
    gateEmitter: async () => ({}),
    linearEffect: async () => ({}),
    storePath,
  });
  await runner.run({ inputs: RUN_INPUTS }); // plan.dor handed-off
  resolve(storePath, "plan.dor", { ready: true, gaps: [] });
  resolve(storePath, "plan.ac", AC_OUTPUT); // a resolution with NO plan.ac run record
  await runner.run({ inputs: RUN_INPUTS }); // plan.dor completes; the selection routes; gate1 stops gate-pending
  resolve(storePath, "gate.plan.gate1", { approved: true, answer: "ok" });
  const result = await runner.run({ inputs: RUN_INPUTS }); // plan.dod runs; plan.ac hits the orphan
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
  appendFileSync(storePath, done("plan.intent", "plan.intent", INTENT_OUTPUT) + "\n");
  appendFileSync(storePath, done("plan.intent.select", "plan.intent.select", { mapVersion: 1, questions: [], confirmations: [], understood: [], assumptions: [] }) + "\n"); // FOC-516
  appendFileSync(storePath, done("plan.dod", "plan.dod", DOD_OUTPUT) + "\n");
  appendFileSync(storePath, done("plan.ac", "plan.ac", AC_OUTPUT) + "\n");
  appendFileSync(storePath, done("plan.spec", "plan.spec", SPEC_OUTPUT) + "\n");
  // FOC-476: plan.ready sits between plan.spec and plan.decompose — seed it
  // done so the seeded walk skips the readiness seam call entirely.
  appendFileSync(storePath, done("plan.ready", "plan.ready", { ready: true, failedStep: "none", reason: "ok" }) + "\n");
  appendFileSync(storePath, done("gate.plan.gate1", "plan.gate1", { approved: true }) + "\n");
  appendFileSync(storePath, done("plan.decompose", "plan.decompose", DECOMPOSE_OUTPUT) + "\n");
  appendFileSync(storePath, done("plan.render", "plan.render", { issueText: "Rendered issue text (seed)." }) + "\n");
  appendFileSync(storePath, done("gate.draft-approval", "draft-approval", { approved: true }) + "\n");
  const result = await runner.run({ inputs: RUN_INPUTS });
  eq(result.status, "stopped", "run stops at the boundary refusal");
  eq(result.record.status, "failed", "failed record");
  eq(result.record.error.code, "provider_error", "typed code");
  if (!result.record.error.message.includes("performs no writes")) fail("message names the refusal");
});

await test("a gate answered rejected records gate-rejected and stops (downstream never runs)", async () => {
  const { storePath } = tempStore();
  const runner = makeRunner({
    caller: async (input) => (input.decisionId === "plan.intent.select.score" ? selectScoreEnvelope(input)
      : input.decisionId === "plan.ac.testable" ? testableEnvelope(input)
      : a0Envelope("plan.dor", { q_ready: { type: "noul", noul: 0.9 } })),
    generator: async ({ stepId }) => (stepId === "plan.intent" ? INTENT_OUTPUT : stepId === "plan.dod" ? DOD_OUTPUT : AC_OUTPUT),
    gateEmitter: async () => ({ gateId: "gate-test-1" }),
    linearEffect: async () => { fail("linear effect must not run after a rejection"); },
    storePath,
  });
  await runner.run({ inputs: RUN_INPUTS }); // plan.dor handed-off
  resolve(storePath, "plan.dor", { ready: true, gaps: [] });
  const result = await runner.run({ inputs: RUN_INPUTS }); // the selection routes the map; gate1 pending (FOC-516: before dod/ac/spec)
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

console.log("\ngraph-runner: FOC-518 — eventId on handed-off [J] records, live-caller run context, [G] timeout");

await test("plan.dor handed-off record carries the seam's eventId when the envelope supplies one", async () => {
  const { storePath } = tempStore();
  const runner = makeRunner({
    caller: async () => ({ ...a0Envelope("plan.dor", { q_ready: { type: "noul", noul: 0.9 } }), eventId: "evt-1" }),
    generator: async () => ({}),
    gateEmitter: async () => ({}),
    linearEffect: async () => ({}),
    storePath,
  });
  const result = await runner.run({ inputs: RUN_INPUTS });
  eq(result.status, "stopped", "run stops at plan.dor");
  eq(result.record.status, "handed-off", "handed-off record");
  eq(result.record.eventId, "evt-1", "eventId is the FOC-451 join key, carried through");
});

await test("plan.dor handed-off record carries eventId null when the envelope has none", async () => {
  const { storePath } = tempStore();
  const runner = makeRunner({
    caller: async () => a0Envelope("plan.dor", { q_ready: { type: "noul", noul: 0.9 } }),
    generator: async () => ({}),
    gateEmitter: async () => ({}),
    linearEffect: async () => ({}),
    storePath,
  });
  const result = await runner.run({ inputs: RUN_INPUTS });
  eq(result.record.status, "handed-off", "handed-off record");
  eq(result.record.eventId, null, "absent eventId normalizes to null");
});

await test("createLiveCaller passes the run id explicitly (the [J] events key to the CLI's --run-id)", () => {
  const calls = [];
  const spy = (opts) => { calls.push(opts); return "caller"; };
  const out = createLiveCaller({ runId: "run-x", apiKey: "k", create: spy });
  eq(out, "caller", "returns the created caller");
  deepEq(calls, [{ apiKey: "k", runId: "run-x" }], "runId forwarded explicitly, not ambient");
});

await test("G_TIMEOUT_MS is 420 s (FOC-474: 120 s timed out on 7/12 eval calls)", () => {
  eq(G_TIMEOUT_MS, 420000, "default [G] timeout");
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