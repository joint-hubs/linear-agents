// scripts/plan-ready.test.mjs — FOC-476: the plan.ready [J] readiness gate.
//
// All offline. The registry entries (plan.ready node + plan.readiness
// transport) and the graph step are the committed spec (loaded through the
// real loader — no fixture drift); the unit sections pin the deterministic
// verdict routing (item perspective → failedStep, the base-verdict catch-all),
// the fail-closed read composition, the per-run retry counter and the
// best-effort FOC-449 labels. The runner sections walk the committed graph
// with seeded predecessor records and stub callers/generators/effects:
// retry-then-escalate (the second ready:false in a run escalates, never a
// silent default), the draft-approval gate carrying the whole artifact
// (ADR-0012 D5), the rejected gate never pushing, and the egress screen
// refusing a secret-shaped payload before any Linear mutation.
//
// Secrets in this file are assembled at runtime from split literals (the
// egress-screen fixture convention) — never a secret-shaped source literal.
//
// Run: node scripts/plan-ready.test.mjs

import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import assert from "node:assert/strict";
import { getRegistryEntry } from "./decision-registry.mjs";
import { loadGraph, validateGraph } from "./graph-validate.mjs";
import { createGraphRunner } from "./graph-runner.mjs";
import {
  PLAN_READY_STEP,
  PLAN_READINESS_DECISION,
  READY_MAX_ATTEMPTS,
  readyRetriesPathFor,
  failedStepFor,
  composeReadyInputs,
  readyVerdict,
  serveReadiness,
  runPlanReadyNode,
} from "./plan-ready.mjs";
import { assertEgressClean } from "./egress-screen.mjs";

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

function eqCode(err, code, label) {
  if (err.code !== code) fail(`${label}: expected code ${code}, got ${err.code} (${err.message})`);
}

// Hermetic by construction: no env-configured shadow target leaks in.
delete process.env.LA_RUN_ID;
delete process.env.LA_TASK_ID;

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");

// Synthetic secret shape — assembled from split literals at runtime, never a
// secret-shaped source literal (the egress-screen.test.mjs fixture convention;
// the value matches the OpenRouter key-prefix family's SHAPE, it opens nothing).
const FAKE_SECRET = "sk-or-".concat("v1-", "a1B2c3D4e5F6g7H8i9J0");

// ── fixtures ─────────────────────────────────────────────────────────────────

const READY_NODE = getRegistryEntry(PLAN_READY_STEP);
const READINESS_TRANSPORT = getRegistryEntry(PLAN_READINESS_DECISION);
const GRAPH = loadGraph();
const PLAN = GRAPH.nodes.plan;
const READY_STEP = PLAN.steps[PLAN_READY_STEP];

// A confirmed intent with the three perspectives the routing contract names,
// plus one covered item — four coverage questions fan out (q0..q3).
const CONFIRMED = {
  goal: "readiness routing for the plan chain",
  why: "the plan is never decomposed on an unchecked artefact set",
  mapVersion: 1,
  interpretations: [
    { id: "IN-1", perspective: "success", claim: "the runner tests are green", source: "inferred", alternatives: [], covers: [] },
    { id: "IN-2", perspective: "scope", claim: "the scope is one runner file", source: "stated", alternatives: [], covers: [] },
    { id: "IN-3", perspective: "risk", claim: "record durability is the risk", source: "inferred", alternatives: [], covers: [] },
    { id: "IN-4", perspective: "goal", claim: "the goal is a routed readiness gate", source: "stated", alternatives: [], covers: [] },
  ],
};

const DOD_OUTPUT = { definitionOfDone: [{ check: "node scripts/test-all.mjs is green", kind: "test", bounded: true }] };
const AC_OUTPUT = { acs: [{ id: "AC-1", text: "ready:false routes to the failed step.", kind: "behaviour", evidence: "test" }] };
const SPEC_OUTPUT = { briefs: ["one brief"], adr: "ADR-0001: route by perspective", summary: "Deterministic readiness routing." };

// The step's reads: record VIEWS ({stepId, status, output}) + the confirmed map.
const READY_READS = {
  "plan.dod.record": { stepId: "plan.dod", key: "plan.dod", status: "done", output: DOD_OUTPUT },
  "plan.ac.record": { stepId: "plan.ac", key: "plan.ac", status: "done", output: AC_OUTPUT },
  "plan.spec.record": { stepId: "plan.spec", key: "plan.spec", status: "done", output: SPEC_OUTPUT },
  "plan.intent.confirmed": CONFIRMED,
};

// The stub caller's answers: the base verdict + one noul per confirmed item.
function readinessAnswers({ base = 0.9, uncovered = [] } = {}) {
  const answers = { ready: { type: "noul", noul: base } };
  CONFIRMED.interpretations.forEach((item, i) => {
    answers[`q${i}`] = { type: "noul", noul: uncovered.includes(item.id) ? 0.1 : 0.9 };
  });
  return answers;
}

function a0Envelope(decisionId, answers, eventId = null, confidence = 0.9) {
  return { ok: true, decisionId, autonomy: "A0", ...(eventId ? { eventId } : {}), annotation: { answers, confidence } };
}

// A seam caller keyed by decision id, with per-call overrides for plan.ready.
function makeCaller({ overrides = {}, onCall = null } = {}) {
  const calls = [];
  return {
    calls,
    caller: async (input) => {
      calls.push(input);
      if (input.decisionId === PLAN_READINESS_DECISION) {
        const next = overrides[calls.filter((c) => c.decisionId === PLAN_READINESS_DECISION).length - 1];
        if (!next) fail(`no readiness stub for call #${calls.length}`);
        if (next.throw) throw next.throw;
        if (next.envelope) return next.envelope;
        return a0Envelope(PLAN_READINESS_DECISION, readinessAnswers(next), next.eventId ?? null);
      }
      return next.caller ? next.caller(input) : fail(`unexpected caller decisionId ${input.decisionId}`);
    },
  };
}

// The plan.ready chain predecessor outputs the runner walk seeds as done
// records — the same shapes the reads resolve from.
function seedDone(storePath, key, stepId, output) {
  appendFileSync(storePath, `${JSON.stringify({
    type: "graph.step",
    runId: "run-plan-ready",
    ts: "2026-01-01T00:00:00.000Z",
    key,
    stepId,
    status: "done",
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

function resolve(storePath, key, output, by = "mateusz") {
  appendFileSync(storePath, `${JSON.stringify({
    type: "graph.resolution",
    runId: "run-plan-ready",
    ts: "2030-01-01T00:00:00.000Z",
    key: `${key}.resolution`,
    stepId: key,
    by,
    output,
  })}\n`);
}

// Hermetic store + seeded label ledger. The decisions.jsonl carries the event
// lines the stub callers' eventIds anchor their labels to — never the live
// .state/runs.
function tempStore({ runId = "run-plan-ready", eventIds = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "plan-ready-test-"));
  const storePath = join(dir, "runs", runId, "graph-steps.jsonl");
  const runsDir = join(dir, "runs");
  mkdirSync(join(runsDir, runId), { recursive: true });
  const logPath = join(runsDir, runId, "decisions.jsonl");
  for (const eventId of eventIds) {
    appendFileSync(logPath, `${JSON.stringify({ type: "event", eventId, decisionId: PLAN_READINESS_DECISION })}\n`);
  }
  return { dir, storePath, runsDir, logPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

console.log("\nplan-ready: the committed spec (real loader — no fixture drift)");

await test("plan.ready sits between plan.spec and plan.decompose; draft-approval replaced plan.gate2", () => {
  eq(validateGraph(GRAPH).length, 0, "the committed graph validates");
  const stepIds = Object.keys(PLAN.steps);
  eq(stepIds.length, 12, "12 steps");
  eq(PLAN.stepFlow.length, 13, "13 stepFlow edges — 11 sequence + reentry + the decide edge");
  const chain = PLAN.stepFlow.filter((e) => e.type === "sequence").map((e) => `${e.from}>${e.to}`).join(" ");
  eq(
    chain,
    "plan.dor>plan.intent plan.intent>plan.intent.select plan.intent.select>plan.gate1 plan.gate1>plan.dod plan.dod>plan.ac plan.ac>plan.spec plan.spec>plan.ready plan.ready>plan.decompose plan.decompose>plan.render plan.render>draft-approval draft-approval>plan.push",
    "plan.ready sits after plan.spec; draft-approval sits after plan.render (FOC-476)",
  );
  const decide = PLAN.stepFlow.find((e) => e.type === "decide");
  if (!decide) fail("the step-level decide edge exists");
  eq(decide.from, PLAN_READY_STEP, "the decide edge starts at plan.ready");
  deepEq(decide.to, ["plan.dod", "plan.ac", "plan.spec"], "the candidate targets are the enumerated artefact steps");
  eq(decide.registry, PLAN_READINESS_DECISION, "the decide edge binds the plan.readiness transport");
  eq(READY_STEP.kind, "J", "kind J");
  deepEq(READY_STEP.tier, { cascade: true, min: 1 }, "cascade tier pin");
  eq(READY_STEP.failure, "escalate", "failure escalate — the second ready:false escalates");
  eq(READY_STEP.writes, "run-record", "writes run-record");
  deepEq(READY_STEP.reads, ["plan.dod.record", "plan.ac.record", "plan.spec.record", "plan.intent.confirmed"], "the reads are exactly the artefact records + the confirmed intent");
  deepEq(READY_NODE.reads, READY_STEP.reads, "registry reads === graph reads");
  deepEq(READY_NODE.output, READY_STEP.output, "registry output === graph output");
  eq(READY_NODE.autonomy, "A0", "A0 — annotation contract");
  eq(READY_NODE.threshold, null, "no threshold");
  eq(READY_NODE.fallback.tier2, "disabled", "tier-2 disabled (FOC-473 posture)");
  eq(READINESS_TRANSPORT.kind, "J", "the transport is kind J");
  if (!READINESS_TRANSPORT.questions?.ready) fail("the transport carries the fixed ready question");
  if (!READINESS_TRANSPORT.questions["q{i}"]) fail("the transport carries the q{i} coverage template");
  eq(PLAN.steps["draft-approval"].kind, "H", "draft-approval is the [H] gate step");
  eq(PLAN.steps["draft-approval"].reads.join(","), "plan.render.issueText", "draft-approval reads the rendered artifact");
  if (PLAN.steps["plan.gate2"]) fail("plan.gate2 is retired from the steps");
  eq(PLAN.steps["plan.push"].reads.includes("gate.draft-approval.record"), true, "plan.push reads the draft-approval gate record");
  if (PLAN.steps["plan.push"].reads.includes("gate.plan.gate2.record")) fail("plan.push no longer reads gate.plan.gate2.record");
});

await test("the output schema pins ready/failedStep/reason (anti-drift)", () => {
  const schema = READY_STEP.output;
  deepEq(schema.required, ["ready", "failedStep", "reason"], "required fields");
  eq(schema.additionalProperties, false, "closed schema");
  deepEq(schema.properties.failedStep.enum, ["plan.dod", "plan.ac", "plan.spec", "none"], "the failedStep enum");
  eq(schema.properties.reason.maxLength, 300, "reason capped at 300");
  const validate = new Ajv().compile(schema);
  eq(validate({ ready: true, failedStep: "none", reason: "all covered" }), true, "the happy shape passes");
  eq(validate({ ready: false, failedStep: "none", reason: "x" }), false, "ready:false with failedStep none fails");
  eq(validate({ ready: "yes", failedStep: "none", reason: "x" }), false, "a non-boolean ready fails");
  eq(validate({ ready: true, failedStep: "plan.intent", reason: "x" }), false, "a foreign failedStep fails");
});

console.log("\nplan-ready: the deterministic verdict routing");

await test("failedStepFor: perspective 'success' → plan.dod, 'scope' → plan.ac, everything else → plan.spec", () => {
  eq(failedStepFor("success"), "plan.dod", "success is the DoD's to fix");
  eq(failedStepFor("scope"), "plan.ac", "scope is the ACs' to fix");
  eq(failedStepFor("risk"), "plan.spec", "risk routes to the spec");
  eq(failedStepFor("terms"), "plan.spec", "terms routes to the spec");
  eq(failedStepFor(undefined), "plan.spec", "an unknown perspective is the catch-all");
});

await test("ready:true happy path — base verdict clears and every item is covered", () => {
  const verdict = readyVerdict({
    base: { type: "noul", noul: 0.9 },
    instances: CONFIRMED.interpretations.map((it) => ({ id: it.id, claim: it.claim, perspective: it.perspective })),
    itemAnswers: CONFIRMED.interpretations.map(() => ({ type: "noul", noul: 0.9 })),
  });
  deepEq(verdict, { ready: true, failedStep: "none", reason: "the DoD, the ACs and the spec read consistent and ready; all 4 confirmed intent item(s) covered" }, "the happy verdict");
});

await test("an uncovered item routes by perspective and the reason names the item id", () => {
  const instances = CONFIRMED.interpretations.map((it) => ({ id: it.id, claim: it.claim, perspective: it.perspective }));
  const noul = (v) => ({ type: "noul", noul: v });
  // IN-3 is perspective "risk" → plan.spec
  let verdict = readyVerdict({ base: noul(0.9), instances, itemAnswers: [noul(0.9), noul(0.9), noul(0.1), noul(0.9)] });
  eq(verdict.ready, false, "ready false");
  eq(verdict.failedStep, "plan.spec", "risk routes to the spec");
  if (!verdict.reason.includes("IN-3")) fail(`the reason names the item id: ${verdict.reason}`);
  if (!verdict.reason.includes("risk")) fail("the reason names the perspective");
  if (!verdict.reason.includes("record durability is the risk")) fail("the reason quotes the claim");
  // IN-2 is perspective "scope" → plan.ac
  verdict = readyVerdict({ base: noul(0.9), instances, itemAnswers: [noul(0.9), noul(0.1), noul(0.9), noul(0.9)] });
  eq(verdict.failedStep, "plan.ac", "scope routes to the ACs");
  if (!verdict.reason.includes("IN-2")) fail("the reason names the item id");
  // IN-1 is perspective "success" → plan.dod
  verdict = readyVerdict({ base: noul(0.9), instances, itemAnswers: [noul(0.1), noul(0.9), noul(0.9), noul(0.9)] });
  eq(verdict.failedStep, "plan.dod", "success routes to the DoD");
  // the FIRST uncovered item routes; the rest are counted
  verdict = readyVerdict({ base: noul(0.9), instances, itemAnswers: [noul(0.1), noul(0.1), noul(0.9), noul(0.9)] });
  eq(verdict.failedStep, "plan.dod", "the first uncovered item routes");
  if (!verdict.reason.includes("(+1 more uncovered item(s))")) fail(`the reason counts the rest: ${verdict.reason}`);
  // a 0.5 verdict counts as covered — a maybe is not a no
  verdict = readyVerdict({ base: noul(0.5), instances, itemAnswers: CONFIRMED.interpretations.map(() => noul(0.5)) });
  eq(verdict.ready, true, "0.5 clears the threshold");
});

await test("a base-verdict miss with every item covered is the plan.spec catch-all", () => {
  const instances = CONFIRMED.interpretations.map((it) => ({ id: it.id, claim: it.claim, perspective: it.perspective }));
  const noul = (v) => ({ type: "noul", noul: v });
  const verdict = readyVerdict({ base: noul(0.2), instances, itemAnswers: instances.map(() => noul(0.9)) });
  eq(verdict.ready, false, "ready false");
  eq(verdict.failedStep, "plan.spec", "the catch-all routes to the spec");
  if (!verdict.reason.includes("0.2")) fail("the reason carries the verdict");
});

console.log("\nplan-ready: the seam call (compose + serve, fail-closed)");

await test("composeReadyInputs builds the filtered payload and the coverage instances", () => {
  const { payload, instances, state } = composeReadyInputs(READY_READS);
  eq(instances.length, 4, "one instance per confirmed item");
  deepEq(instances[0], { id: "IN-1", claim: CONFIRMED.interpretations[0].claim, perspective: "success" }, "instance vars carry id/claim/perspective");
  eq(payload.artifacts.dod.status, "done", "the dod record view's status rides the payload");
  deepEq(payload.artifacts.dod.definitionOfDone, DOD_OUTPUT.definitionOfDone, "the DoD rides the payload");
  eq(payload.artifacts.spec.summary, SPEC_OUTPUT.summary, "the spec summary rides the payload");
  eq(payload.intent.goal, CONFIRMED.goal, "the confirmed goal rides the payload");
  eq(payload.intent.items.length, 4, "the confirmed items ride the payload");
  if (typeof state !== "string" || !state.includes("readiness routing")) fail("the state is the canonical JSON of the payload");
});

await test("an empty confirmed map is legal — the base question only", () => {
  const { instances } = composeReadyInputs({
    ...READY_READS,
    "plan.intent.confirmed": { ...CONFIRMED, interpretations: [] },
  });
  eq(instances.length, 0, "no coverage instances");
});

async function failsTyped(mutate, code, needle, label) {
  const reads = { ...READY_READS };
  mutate(reads);
  let thrown = null;
  try {
    composeReadyInputs(reads);
  } catch (err) {
    thrown = err;
  }
  if (!thrown) fail(`${label}: the composition must fail closed`);
  eqCode(thrown, code, `${label}: typed code`);
  if (needle && !thrown.message.includes(needle)) fail(`${label}: message should name "${needle}", got: ${thrown.message}`);
}

await test("each missing/malformed read fails typed, naming the read", async () => {
  await failsTyped((r) => { delete r["plan.intent.confirmed"]; }, "invalid_input", "plan.intent.confirmed", "no confirmed intent");
  await failsTyped((r) => { r["plan.intent.confirmed"] = { goal: "g", interpretations: "all" }; }, "invalid_input", "plan.intent.confirmed", "malformed interpretations");
  await failsTyped((r) => { delete r["plan.dod.record"]; }, "invalid_input", "plan.dod.record", "no dod record");
  await failsTyped((r) => { delete r["plan.ac.record"]; }, "invalid_input", "plan.ac.record", "no ac record");
  await failsTyped((r) => { delete r["plan.spec.record"]; }, "invalid_input", "plan.spec.record", "no spec record");
  await failsTyped((r) => { r["plan.dod.record"] = { status: "done" }; }, "invalid_input", "plan.dod.record", "dod record without output");
  await failsTyped((r) => { r["plan.ac.record"] = { status: "done", output: { acs: [] } }; }, "invalid_input", "plan.ac.record", "empty acs");
  await failsTyped((r) => { r["plan.spec.record"] = { status: "done", output: { briefs: ["b"], adr: "a" } }; }, "invalid_input", "plan.spec.record", "spec record without summary");
  await failsTyped((r) => { r["plan.intent.confirmed"] = { ...CONFIRMED, interpretations: [{ id: "IN-1", claim: "c" }] }; }, "invalid_input", "malformed at item 0", "item without perspective");
});

await test("more than 12 confirmed items and an over-cap state fail closed — never truncated", async () => {
  const thirteen = Array.from({ length: 13 }, (_, i) => ({ id: `IN-${i + 1}`, perspective: "goal", claim: `claim ${i}`, source: "inferred", alternatives: [], covers: [] }));
  await failsTyped((r) => { r["plan.intent.confirmed"] = { ...CONFIRMED, interpretations: thirteen }; }, "invalid_input", "instance cap (12)", "13 items");
  const hugeClaim = "x".repeat(20000);
  await failsTyped((r) => { r["plan.intent.confirmed"] = { ...CONFIRMED, interpretations: [{ id: "IN-1", perspective: "goal", claim: hugeClaim, source: "inferred", alternatives: [], covers: [] }] }; }, "invalid_input", "state cap", "over-cap state");
});

await test("serveReadiness turns the seam envelope into a verdict; noul-shape failures fail closed", async () => {
  const { caller } = makeCaller({ overrides: [{ uncovered: [] }] });
  const served = await serveReadiness({ reads: READY_READS, caller });
  eq(served.verdict.ready, true, "the happy verdict");
  eq(served.confidence, 0.9, "confidence rides through");
  eq(served.eventId, null, "no eventId on a stub without one");

  const bad = makeCaller({ overrides: [{ envelope: a0Envelope(PLAN_READINESS_DECISION, { ready: { type: "noul", noul: 0.9 } }) }] });
  let thrown = null;
  try {
    await serveReadiness({ reads: READY_READS, caller: bad.caller });
  } catch (err) {
    thrown = err;
  }
  if (!thrown) fail("a missing q0 must fail closed");
  eqCode(thrown, "unparseable_output", "typed code");
  if (!thrown.message.includes("q0")) fail("the message names the missing answer");

  const noBase = makeCaller({ overrides: [{ envelope: a0Envelope(PLAN_READINESS_DECISION, {}) }] });
  thrown = null;
  try {
    await serveReadiness({ reads: READY_READS, caller: noBase.caller });
  } catch (err) {
    thrown = err;
  }
  eqCode(thrown, "unparseable_output", "no base verdict");

  const thrown2 = await serveReadiness({ reads: READY_READS, caller: makeCaller({ overrides: [{ throw: Object.assign(new Error("boom"), { code: "auth_missing" }) }] }).caller })
    .then(() => null, (err) => err);
  eqCode(thrown2, "auth_missing", "a caller throw keeps its code");

  const errEnv = makeCaller({ overrides: [{ envelope: { ok: false, error: { code: "provider_error", message: "down" } } }] });
  thrown = null;
  try {
    await serveReadiness({ reads: READY_READS, caller: errEnv.caller });
  } catch (err) {
    thrown = err;
  }
  eqCode(thrown, "provider_error", "an error envelope fails closed");
});

console.log("\nplan-ready: the retry counter (per run) + the node outcomes");

await test("the counter file lives next to the run store", () => {
  eq(readyRetriesPathFor(join("x", "runs", "r1", "graph-steps.jsonl")).endsWith(join("runs", "r1", "plan-ready.retries.json")), true, "per-run path");
  eq(READY_MAX_ATTEMPTS, 2, "one retry, then escalate");
});

async function nodeRun({ overrides, eventIds = [], counterSeed = null, reads = READY_READS, validate } = {}) {
  const { dir, storePath, runsDir, logPath, cleanup } = tempStore({ eventIds });
  const retriesPath = readyRetriesPathFor(storePath);
  if (counterSeed !== null) writeFileSync(retriesPath, JSON.stringify(counterSeed), "utf8");
  const harness = makeCaller({ overrides });
  const schemaValidate = validate ?? new Ajv().compile(READY_NODE.output);
  const result = await runPlanReadyNode({
    stepId: PLAN_READY_STEP,
    reads,
    caller: harness.caller,
    validate: schemaValidate,
    retriesPath,
    runId: "run-plan-ready",
    decisionRunsDir: runsDir,
    now: () => "2026-01-01T00:00:00.000Z",
  });
  const labels = existsSync(logPath)
    ? readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.type === "label")
    : [];
  return { result, labels, retriesPath, cleanup, calls: harness.calls };
}

await test("(a) ready=true — done, the plan.ready.true label, no counter write", async () => {
  const { result, labels, retriesPath, cleanup, calls } = await nodeRun({ overrides: [{ uncovered: [], eventId: "evt-ready-a" }], eventIds: ["evt-ready-a"] });
  try {
    eq(result.status, "done", "done");
    deepEq(result.output, { ready: true, failedStep: "none", reason: "the DoD, the ACs and the spec read consistent and ready; all 4 confirmed intent item(s) covered" }, "the output shape");
    eq(result.attempt, 1, "attempt 1");
    eq(result.eventId, "evt-ready-a", "the seam event id rides the result");
    deepEq(result.labels, ["plan.ready.true"], "the verdict label");
    deepEq(result.labelWarnings, [], "no warnings");
    eq(calls[0].decisionId, PLAN_READINESS_DECISION, "the call by transport id");
    eq(calls[0].instances.length, 4, "the coverage instances ride the call");
    deepEq(labels.map((l) => l.outcome), ["plan.ready.true"], "the label next to the event");
    eq(labels[0].by, "agent", "the seam verdict is agent-vouched");
    eq(labels[0].via, "seam", "via the seam");
    if (existsSync(retriesPath)) fail("a ready run writes no counter");
  } finally {
    cleanup();
  }
});

await test("(b) ready=false → retry at plan.dod → ready=true — attempt 2 carries the retry marker", async () => {
  const { result, labels, retriesPath, cleanup, calls } = await nodeRun({
    overrides: [{ uncovered: ["IN-1"], eventId: "evt-ready-b" }],
    eventIds: ["evt-ready-b"],
  });
  try {
    eq(result.status, "retry", "the first ready:false is a retry");
    eq(result.failedStep, "plan.dod", "IN-1 is perspective success → the DoD");
    eq(result.attempt, 1, "attempt 1");
    deepEq(result.labels, ["plan.ready.false", "plan.ready.first"], "the verdict + stage labels");
    eq(JSON.parse(readFileSync(retriesPath, "utf8")).attempts, 1, "the retry persisted the counter");
    deepEq(labels.map((l) => l.outcome), ["plan.ready.false", "plan.ready.first"], "the labels next to the event");
    eq(calls.length, 1, "one seam call");

    // The SAME counter state, next attempt: the persisted budget drives the
    // attempt number, and a ready:true on attempt 2 carries the retry marker.
    const second = await nodeRun({
      overrides: [{ uncovered: [], eventId: "evt-ready-b2" }],
      eventIds: ["evt-ready-b2"],
      counterSeed: { attempts: 1 },
    });
    eq(second.result.status, "done", "the second attempt with every item covered is done");
    eq(second.result.attempt, 2, "attempt 2");
    deepEq(second.result.labels, ["plan.ready.true", "plan.ready.retry"], "the retry marker");
  } finally {
    cleanup();
  }
});

await test("(c) ready=false twice → escalate — the second ready:false is terminal", async () => {
  const { result, labels, cleanup, calls } = await nodeRun({
    overrides: [{ uncovered: ["IN-2"], eventId: "evt-ready-c" }],
    eventIds: ["evt-ready-c"],
    counterSeed: { attempts: 1 },
  });
  try {
    eq(result.status, "escalate", "the second ready:false escalates");
    eq(result.attempt, 2, "attempt 2");
    eq(result.output.failedStep, "plan.ac", "the verdict still names the failed step");
    eq(result.escalation.reason, "second ready:false in this run — the readiness retry budget is spent (over-escalation is fail-safe)", "the escalation reason");
    eq(result.escalation.failedStep, "plan.ac", "the escalation carries the failed step");
    deepEq(result.labels, ["plan.ready.false", "plan.ready.escalated"], "the escalated marker");
    eq(calls.length, 1, "exactly one call — the budget is spent");
    deepEq(labels.map((l) => l.outcome), ["plan.ready.false", "plan.ready.escalated"], "the label next to the event");
  } finally {
    cleanup();
  }
});

await test("(d) the committed schema validates the node's output; a schema-invalid verdict fails typed", async () => {
  const { result, cleanup } = await nodeRun({
    overrides: [{ uncovered: ["IN-3"] }],
  });
  try {
    eq(result.status, "retry", "IN-3 is risk → plan.spec, attempt 1");
    eq(result.failedStep, "plan.spec", "risk routes to the spec");
    if (!result.output.reason.includes("IN-3")) fail("the reason names the item id");
    const bad = new Ajv().compile({ type: "object", required: ["nope"], additionalProperties: false, properties: { nope: { type: "boolean" } } });
    const refused = await nodeRun({ overrides: [{ uncovered: [] }], validate: bad });
    eq(refused.result.status, "failed", "a validator mismatch is a typed failure");
    eq(refused.result.error.code, "schema_invalid", "typed code");
  } finally {
    cleanup();
  }
});

await test("a corrupt counter fails closed; a missing counter is attempt 1", async () => {
  const corrupt = await nodeRun({ overrides: [{ uncovered: [] }], counterSeed: { attempts: "one" } });
  eq(corrupt.result.status, "failed", "a corrupt counter fails the node");
  eq(corrupt.result.error.code, "provider_error", "typed code");
  if (!corrupt.result.error.message.includes("corrupt")) fail("the message names the corruption");
  eq(corrupt.calls.length, 0, "no seam call on a corrupt counter");

  const fresh = await nodeRun({ overrides: [{ uncovered: [], eventId: "evt-fresh" }], eventIds: ["evt-fresh"] });
  eq(fresh.result.attempt, 1, "no counter file → attempt 1");
});

await test("a run without an eventId labels nothing and warns nothing", async () => {
  const { result, labels, cleanup } = await nodeRun({ overrides: [{ uncovered: [] }] });
  try {
    eq(result.status, "done", "done");
    deepEq(result.labels, [], "no labels without an event");
    deepEq(result.labelWarnings, [], "no warnings either");
    eq(labels.length, 0, "the ledger untouched");
  } finally {
    cleanup();
  }
});

console.log("\nplan-ready: the runner executes plan.ready (the step-level decide edge)");

// The predecessor chain seeds the walk straight to plan.ready.
function seedPredecessors(storePath, { specSummary = SPEC_OUTPUT.summary } = {}) {
  seedDone(storePath, "plan.dor", "plan.dor", { ready: true, gaps: [] });
  seedDone(storePath, "plan.intent", "plan.intent", { goal: CONFIRMED.goal, why: CONFIRMED.why, mapVersion: 1, interpretations: CONFIRMED.interpretations });
  seedDone(storePath, "plan.intent.select", "plan.intent.select", { mapVersion: 1, questions: [], confirmations: [], understood: [], assumptions: [] });
  seedDone(storePath, "gate.plan.gate1", "plan.gate1", { approved: true, answer: "ok", confirmed: true, round: 1 });
  seedDone(storePath, "plan.intent.confirmed", "plan.intent.confirmed", CONFIRMED);
  seedDone(storePath, "plan.dod", "plan.dod", DOD_OUTPUT);
  seedDone(storePath, "plan.ac", "plan.ac", AC_OUTPUT);
  seedDone(storePath, "plan.spec", "plan.spec", SPEC_OUTPUT);
  if (specSummary !== SPEC_OUTPUT.summary) {
    const records = readRecords(storePath);
    const spec = records[records.length - 1];
    spec.output = { ...SPEC_OUTPUT, summary: specSummary };
    const lines = records.map((r) => (r === spec ? spec : r));
    writeFileSync(storePath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  }
}

await test("the walk: ready:false → plan.dod re-executes → ready:true → the chain continues", async () => {
  const { dir, storePath, runsDir, logPath, cleanup } = tempStore({ eventIds: ["evt-ready-walk-1", "evt-ready-walk-2"] });
  try {
    seedPredecessors(storePath);
    const genCalls = [];
    const readinessCalls = [];
    const caller = async (input) => {
      if (input.decisionId === PLAN_READINESS_DECISION) {
        readinessCalls.push(input);
        const attempt = readinessCalls.length;
        const uncovered = attempt === 1 ? ["IN-1"] : [];
        return a0Envelope(PLAN_READINESS_DECISION, readinessAnswers({ uncovered }), `evt-ready-walk-${attempt}`);
      }
      return fail(`unexpected caller decisionId ${input.decisionId}`);
    };
    const generator = async ({ stepId }) => {
      genCalls.push(stepId);
      if (stepId === "plan.dod") return DOD_OUTPUT;
      fail(`unexpected generator step ${stepId}`);
    };
    const runner = createGraphRunner({
      runId: "run-plan-ready",
      storePath,
      caller,
      generator,
      gateEmitter: async () => fail("no gate on this walk"),
      linearEffect: async () => fail("no push on this walk"),
      decisionRunsDir: runsDir,
    });

    // Run 1 — plan.ready answers ready:false (attempt 1), the walk re-enters
    // plan.dod, which re-executes, and plan.ready re-asks (attempt 2,
    // ready:true). The chain stops at plan.decompose ([J] hand-off).
    const result = await runner.run({ inputs: {} });
    eq(result.status, "stopped", "run 1 stops");
    eq(result.stepId, "plan.decompose", "the walk continues past the retry to the [J] hand-off");
    // plan.dod is seeded done (the walk skips it on pass 1), so the single
    // generator call IS the re-execution the decide edge caused — dodRecords
    // pins the same fact: done + reset + re-executed done.
    deepEq(genCalls, ["plan.dod"], "plan.dod re-executed exactly once");
    eq(readinessCalls.length, 2, "two readiness calls — the retry");
    eq(readinessCalls[1].instances.length, 4, "the second call carries the same coverage instances");

    const records = readRecords(storePath);
    const readyRecords = records.filter((r) => r.key === PLAN_READY_STEP);
    eq(readyRecords.length, 3, "ready:false done + reset + ready:true done");
    eq(readyRecords[0].output.ready, false, "the first record is the ready:false verdict");
    eq(readyRecords[0].attempt, 1, "attempt 1 on the record");
    eq(readyRecords[0].status, "done", "the retry's verdict is a done record");
    eq(readyRecords[1].status, "reset", "plan.ready's reset marker");
    eq(readyRecords[2].output.ready, true, "the re-ask answers ready");
    eq(readyRecords[2].attempt, 2, "attempt 2");
    deepEq(readyRecords[2].labels, ["plan.ready.true", "plan.ready.retry"], "the retry marker on the record");
    const dodRecords = records.filter((r) => r.key === "plan.dod");
    eq(dodRecords.length, 3, "done + reset + re-executed done");
    eq(dodRecords[1].status, "reset", "the failed step's reset marker");
    if (!dodRecords[1].output?.readyReason?.includes("IN-1")) fail("the reset carries the readiness reason");
    if (!readyRecords[0].output.reason.includes("IN-1")) fail("the ready:false reason names the item");

    const labels = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.type === "label");
    deepEq(labels.map((l) => l.outcome), ["plan.ready.false", "plan.ready.first", "plan.ready.true", "plan.ready.retry"], "every outcome labelled next to its event");
  } finally {
    cleanup();
  }
});

await test("the walk: ready:false twice escalates — typed, terminal, no third call", async () => {
  const { dir, storePath, runsDir, logPath, cleanup } = tempStore({ eventIds: ["evt-ready-esc-1", "evt-ready-esc-2"] });
  try {
    seedPredecessors(storePath);
    let readinessCalls = 0;
    const caller = async (input) => {
      if (input.decisionId === PLAN_READINESS_DECISION) {
        readinessCalls++;
        return a0Envelope(PLAN_READINESS_DECISION, readinessAnswers({ uncovered: ["IN-2"] }), `evt-ready-esc-${readinessCalls}`);
      }
      if (input.decisionId === "plan.ac.testable") {
        // the re-executed plan.ac's node-internal quality loop (FOC-475) —
        // one passing verdict per criterion, no regeneration
        return a0Envelope("plan.ac.testable", { ac0: { type: "noul", noul: 0.9 } }, null);
      }
      return fail(`unexpected caller decisionId ${input.decisionId}`);
    };
    const runner = createGraphRunner({
      runId: "run-plan-ready",
      storePath,
      caller,
      // plan.ac is the failed step (IN-2 is perspective "scope") — the decide
      // edge re-executes it before plan.ready re-asks, so the generator must
      // serve it; plan.dod and the rest stay seeded done.
      generator: async ({ stepId }) => {
        if (stepId === "plan.ac") return AC_OUTPUT;
        return fail(`unexpected generator step ${stepId}`);
      },
      gateEmitter: async () => fail("no gate on an escalated walk"),
      linearEffect: async () => fail("no push on an escalated walk"),
      decisionRunsDir: runsDir,
    });
    // plan.ac re-executes on the retry pass (it is the failed step) — its
    // [G] node composes from the confirmed intent + the candidate files, so
    // the run input carries the features.list the real frontman passes.
    const result = await runner.run({ inputs: { "features.list": ["scripts/plan-ready.mjs"] } });
    eq(result.status, "stopped", "the escalated run stops");
    eq(result.stepId, PLAN_READY_STEP, "stopped at plan.ready");
    eq(result.record.status, "failed", "a failed record — terminal on resume");
    eq(result.record.error.code, "readiness_escalated", "the typed escalation code");
    eq(result.record.attempt, 2, "attempt 2 on the record");
    eq(result.record.escalation.failedStep, "plan.ac", "the escalation carries the failed step");
    eq(readinessCalls, 2, "exactly two calls — the budget is spent");
    // A resume stays stopped: failed is terminal.
    const again = await runner.run({ inputs: {} });
    eq(again.stepId, PLAN_READY_STEP, "the resume stops at the same failed record");
    eq(readinessCalls, 2, "no further seam call on resume");
    const labels = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.type === "label");
    deepEq(labels.map((l) => l.outcome), ["plan.ready.false", "plan.ready.first", "plan.ready.false", "plan.ready.escalated"], "the first attempt's labels are on the ledger too");
  } finally {
    cleanup();
  }
});

console.log("\nplan-ready: the draft-approval gate + the no-push outcomes");

const GOLDEN_ISSUE = [
  "# Plan",
  "",
  "## Spec summary",
  "",
  SPEC_OUTPUT.summary,
  "",
  "## Acceptance criteria",
  "",
  `- ${AC_OUTPUT.acs[0].id} (${AC_OUTPUT.acs[0].kind}, evidence: ${AC_OUTPUT.acs[0].evidence}): ${AC_OUTPUT.acs[0].text}`,
  "",
  "## Definition of done",
  "",
  `- [x] (${DOD_OUTPUT.definitionOfDone[0].kind}) ${DOD_OUTPUT.definitionOfDone[0].check}`,
  "",
  "## Decomposed tasks",
  "",
  "1. scripts/plan-ready.mjs (size: medium; labels: tech; relations: none)",
].join("\n");

await test("(e) draft-approval carries the whole artifact; the approved push is egress-clean", async () => {
  const { dir, storePath, runsDir, logPath, cleanup } = tempStore({ eventIds: ["evt-ready-push"] });
  try {
    seedPredecessors(storePath);
    seedDone(storePath, PLAN_READY_STEP, PLAN_READY_STEP, { ready: true, failedStep: "none", reason: "clean" });
    // carry the seam eventId on the plan.ready record — the label anchor
    const seeded = readRecords(storePath);
    seeded[seeded.length - 1].eventId = "evt-ready-push";
    writeFileSync(storePath, seeded.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    seedDone(storePath, "plan.decompose", "plan.decompose", { tasks: [{ title: "scripts/plan-ready.mjs", size: "medium", labels: ["tech"], relations: [] }] });
    // plan.render is NOT seeded — it executes in the walk and composes the
    // issue text from the seeded reads.

    const gateCalls = [];
    const linearCalls = [];
    const runner = createGraphRunner({
      runId: "run-plan-ready",
      storePath,
      caller: async () => fail("no seam call on a fully seeded walk"),
      generator: async () => fail("no generator call on a fully seeded walk"),
      gateEmitter: async (input) => {
        gateCalls.push(input);
        return { gateId: "gate-test-1" };
      },
      // The boundary screens the payload exactly as the real Linear caller
      // does before any write — a clean payload passes, a secret refuses.
      linearEffect: async ({ action, payload }) => {
        assertEgressClean(payload.issueText, "issueText");
        linearCalls.push({ action, payload });
        return { epicId: "FEN-900", childrenIds: ["FEN-901"], handoffCommentPosted: true };
      },
      decisionRunsDir: runsDir,
    });

    // Run 1 — plan.render composes, draft-approval emits with the artifact.
    const result = await runner.run({ inputs: {} });
    eq(result.status, "stopped", "run 1 stops at the gate");
    eq(result.stepId, "draft-approval", "draft-approval is where the walk waits");
    eq(gateCalls.length, 1, "one gate emit");
    eq(gateCalls[0].gateKind, "draft-approval", "the gate kind is the step id");
    eq(gateCalls[0].facts.reads["plan.render.issueText"], GOLDEN_ISSUE, "the gate facts carry the rendered text verbatim");
    if (typeof gateCalls[0].artifact !== "string") fail("the gate emit carries the artifact path (ADR-0012 D5)");
    if (!existsSync(gateCalls[0].artifact)) fail("the artifact file exists");
    eq(readFileSync(gateCalls[0].artifact, "utf8"), GOLDEN_ISSUE, "the artifact IS the whole rendered issue, 1:1");
    if (!gateCalls[0].artifact.endsWith("draft-approval-issue.md")) fail("the artifact lives in the run dir");
    if (!gateCalls[0].facts.artifact) fail("the gate facts point at the artifact");
    if (!gateCalls[0].summary.includes("plan.render")) fail("the gate summary names the rendered issue");

    // The human approves. Run 2 — plan.push through the screened boundary.
    resolve(storePath, "gate.draft-approval", { approved: true });
    const done = await runner.run({ inputs: {} });
    eq(done.status, "completed", "the walk completes after the approval");
    eq(linearCalls.length, 1, "one Linear-boundary call");
    eq(linearCalls[0].payload.issueText, GOLDEN_ISSUE, "the pushed issueText is the rendered text 1:1");
    if (!linearCalls[0].payload.handoffComment.includes("draft-approval done")) fail("the hand-off comment names the draft-approval gate");
    const records = readRecords(storePath);
    eq(latest(records, "plan.push").output.epicId, "FEN-900", "push output recorded");
    const labels = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.type === "label");
    eq(labels.length, 0, "an approved push carries no no-push label");
  } finally {
    cleanup();
  }
});

await test("(f) approved:false — no push, the plan.ready.approved=false label on the plan.ready event", async () => {
  const { dir, storePath, runsDir, logPath, cleanup } = tempStore({ eventIds: ["evt-ready-gate"] });
  try {
    seedPredecessors(storePath);
    seedDone(storePath, PLAN_READY_STEP, PLAN_READY_STEP, { ready: true, failedStep: "none", reason: "clean" });
    // carry the seam eventId on the plan.ready record — the label anchor
    const records0 = readRecords(storePath);
    records0[records0.length - 1].eventId = "evt-ready-gate";
    writeFileSync(storePath, records0.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    seedDone(storePath, "plan.decompose", "plan.decompose", { tasks: [{ title: "scripts/plan-ready.mjs", size: "medium", labels: ["tech"], relations: [] }] });
    seedDone(storePath, "plan.render", "plan.render", { issueText: GOLDEN_ISSUE });

    const runner = createGraphRunner({
      runId: "run-plan-ready",
      storePath,
      caller: async () => fail("no seam call on a fully seeded walk"),
      generator: async () => fail("no generator call on a fully seeded walk"),
      gateEmitter: async () => ({ gateId: "gate-test-1" }),
      linearEffect: async () => fail("a rejected draft NEVER pushes"),
      decisionRunsDir: runsDir,
    });
    const result = await runner.run({ inputs: {} });
    eq(result.status, "stopped", "run 1 stops gate-pending");
    eq(result.stepId, "draft-approval", "the gate waits");
    resolve(storePath, "gate.draft-approval", { approved: false });
    const rejected = await runner.run({ inputs: {} });
    eq(rejected.status, "stopped", "the rejected run stops");
    eq(rejected.record.status, "gate-rejected", "gate-rejected — terminal on resume");
    const records = readRecords(storePath);
    if (records.some((r) => r.key === "plan.push")) fail("no push record after a rejection");
    const labels = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.type === "label");
    deepEq(labels.map((l) => l.outcome), ["plan.ready.approved=false"], "the rejection label next to the plan.ready event");
    eq(labels[0].by, "human", "a human gate answer is human-vouched");
    eq(labels[0].via, "gate", "via the gate join");
    eq(rejected.record.noPushLabel.outcome, "plan.ready.approved=false", "the label provenance rides the record");
  } finally {
    cleanup();
  }
});

await test("(g) a secret-shaped issue text never reaches Linear — egress refusal, typed stop, label", async () => {
  const { dir, storePath, runsDir, logPath, cleanup } = tempStore({ eventIds: ["evt-ready-egress"] });
  try {
    seedPredecessors(storePath, { specSummary: `Deterministic readiness routing. key ${FAKE_SECRET} leaked in the summary.` });
    seedDone(storePath, PLAN_READY_STEP, PLAN_READY_STEP, { ready: true, failedStep: "none", reason: "clean" });
    const records0 = readRecords(storePath);
    records0[records0.length - 1].eventId = "evt-ready-egress";
    writeFileSync(storePath, records0.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    seedDone(storePath, "plan.decompose", "plan.decompose", { tasks: [{ title: "scripts/plan-ready.mjs", size: "medium", labels: ["tech"], relations: [] }] });

    const runner = createGraphRunner({
      runId: "run-plan-ready",
      storePath,
      caller: async () => fail("no seam call on a fully seeded walk"),
      generator: async () => fail("no generator call on a fully seeded walk"),
      gateEmitter: async () => ({ gateId: "gate-test-1" }),
      // The real Linear caller screens before it writes; the stub does the
      // same — the refusal happens INSIDE the effect, before any mutation.
      linearEffect: async ({ payload }) => {
        assertEgressClean(payload.issueText, "issueText");
        return { epicId: "FEN-900", childrenIds: [], handoffCommentPosted: true };
      },
      decisionRunsDir: runsDir,
    });
    // Run 1 stops gate-pending (the artifact carries the text — the gate is
    // human-side, not the egress boundary; the refusal fires at the push).
    const pending = await runner.run({ inputs: {} });
    eq(pending.stepId, "draft-approval", "the gate waits first");
    resolve(storePath, "gate.draft-approval", { approved: true });
    const result = await runner.run({ inputs: {} });
    eq(result.status, "stopped", "the refused run stops");
    eq(result.stepId, "plan.push", "stopped at the push");
    eq(result.record.status, "failed", "failed record");
    eq(result.record.error.code, "EGRESS_BLOCKED", "the typed egress code on the record");
    if (!result.record.error.message.includes("secret")) fail("the refusal names the screen");
    const records = readRecords(storePath);
    if (records.some((r) => r.key === "plan.push" && r.status === "done")) fail("no done push record after a refusal");
    const labels = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.type === "label");
    deepEq(labels.map((l) => l.outcome), ["plan.push.egress_blocked"], "the egress label next to the plan.ready event");
    eq(labels[0].by, "agent", "a code-side refusal is agent-vouched");
    eq(labels[0].via, "egress-screen", "via the egress join");
  } finally {
    cleanup();
  }
});

console.log(`\nplan-ready: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("\nfailed tests:");
  for (const name of failures) console.error("  - " + name);
  process.exit(1);
}
