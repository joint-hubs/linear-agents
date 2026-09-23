// scripts/plan-ac.test.mjs — FOC-475: the plan.ac [G] node and its
// NODE-INTERNAL testable-gate loop.
//
// All offline. The registry entry and the graph step are the committed spec
// (loaded through the real loader — no fixture drift). The loop is exercised
// through injected generators and callers exactly as graph-runner.test.mjs
// does; the DEFAULT generator — the one live [G] calls actually ride — is
// exercised on an injected fetch (registry prompt + the composed payload on
// the wire, the strict json_schema, the FOC-449 event line, and the
// over-length fail-closed posture with zero fetch calls). The eval harness's
// input partition is tested against the committed fixture: the AC ground
// truth is the answer key and never enters the inputs.
//
// Run: node scripts/plan-ac.test.mjs

import { existsSync, mkdtempSync, readFileSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import Ajv from "ajv";
import { getRegistryEntry, loadRegistry } from "./decision-registry.mjs";
import { loadGraph, validateGraph } from "./graph-validate.mjs";
import { createGraphRunner, createDefaultGenerator } from "./graph-runner.mjs";
import { DECISION_STEP, SHADOW_EVENT_TYPE } from "./decision-call.mjs";
import { AC_TESTABLE_DECISION, TESTABLE_THRESHOLD, composeAcInputs, runPlanAcNode } from "./plan-ac.mjs";
import { buildInputs } from "./plan-ac-eval.mjs";

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

// Hermetic by construction: no env-configured shadow target leaks in.
delete process.env.LA_RUN_ID;
delete process.env.LA_TASK_ID;

const __dir = dirname(fileURLToPath(import.meta.url));

// ── the committed spec ───────────────────────────────────────────────────────

const GRAPH = loadGraph();
const PLAN = GRAPH.nodes.plan;
const AC_STEP = PLAN.steps["plan.ac"];
const AC_REGISTRY = getRegistryEntry("plan.ac");
const GATE_REGISTRY = getRegistryEntry(AC_TESTABLE_DECISION);
const registry = loadRegistry().entries;

const STATE_CAP = DECISION_STEP.inputSchema.properties.state.maxLength;

const AC_OUTPUT = {
  acs: [{ id: "AC-1", text: "The runner executes the PLAN subgraph with typed run records.", kind: "behaviour", evidence: "test" }],
};
// plan.dod executes before plan.ac in the walk — the fetch stubs serve it first.
const DOD_OUTPUT = {
  definitionOfDone: [{ check: "node scripts/plan-ac.test.mjs is green", kind: "test", bounded: true }],
};

const RUN_INPUTS = {
  "inbox.entry": "Dictated entry (test): the plan chain generates acceptance criteria as bounded statements.",
  "features.list": [{ name: "plan.ac [G] node" }],
  "repoState.pinned": { branch: "foc-475-dev", head: "9a6d20e" },
};

const okResponse = (content) => ({
  ok: true,
  status: 200,
  json: async () => ({
    id: "resp-plan-ac-test",
    model: "z-ai/glm-5.3-flash",
    choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }],
    usage: { input_tokens: 123, output_tokens: 45, cost: 0.000045 },
  }),
});

function tempDir(prefix = "plan-ac-test-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function readLines(path) {
  return readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

const validate = new Ajv({ allErrors: true }).compile(AC_STEP.output);

// The gate stub: an A0 annotation answering ABOVE (good) or BELOW (bad) the
// verdict threshold for every criterion instance — the shape the real seam
// returns (annotation.answers keyed ac0..acN-1).
function gateStub(verdict = 0.9) {
  const calls = [];
  return {
    calls,
    caller: async (input) => {
      calls.push(input);
      return {
        ok: true,
        step: "decision-call",
        decisionId: AC_TESTABLE_DECISION,
        criteriaVersion: 1,
        autonomy: "A0",
        annotation: {
          answers: Object.fromEntries((input.instances ?? []).map((_, i) => [`ac${i}`, { type: "noul", noul: verdict }])),
          confidence: 0.9,
        },
        pinnedModel: "typesafe/jev-1.13",
      };
    },
  };
}

// ── (a) the config cross-check: the D7 contract, both views ──────────────────

console.log("\nplan-ac: the config cross-check (graph.json ↔ decisions.json)");

await test("plan.ac is AC-only with the evidence field; the step deep-equals the registry entry on the D7 contract", () => {
  eq(validateGraph(GRAPH).length, 0, "the committed graph validates");
  deepEq(AC_STEP.reads, AC_REGISTRY.reads, "reads");
  deepEq(AC_STEP.output, AC_REGISTRY.output, "output");
  eq(AC_STEP.tier, "cheap", "tier cheap");
  eq(AC_STEP.failure, "stop", "failure stop");
  eq(AC_STEP.writes, "run-record", "writes run-record");
  eq(AC_REGISTRY.autonomy, null, "autonomy null (the [G] mirror)");
  eq(AC_REGISTRY.threshold, null, "threshold null");
  eq(AC_REGISTRY.fallback.tier2, "disabled", "tier 2 disabled");
  eq(AC_REGISTRY.criteriaVersion, 1, "criteriaVersion 1");
  deepEq(AC_REGISTRY.metrics, ["durationMs", "inputTokens", "outputTokens", "cost"], "the same metrics as plan.dod");
  if (AC_STEP.output.properties.definitionOfDone) fail("plan.ac is AC-only — the DoD half lives on plan.dod");
  const item = AC_STEP.output.properties.acs.items;
  deepEq(item.required, ["id", "text", "kind", "evidence"], "acs items require evidence (AC2)");
  deepEq(item.properties.evidence.enum, ["test", "command_output", "file_state", "human_check"], "evidence enum");
});

await test("the gate entry the node binds is A0, threshold null, tier-2 dead — and the declared reads stay exactly two", () => {
  eq(GATE_REGISTRY.autonomy, "A0", "the gate is A0");
  eq(GATE_REGISTRY.threshold, null, "the gate carries no threshold");
  eq(GATE_REGISTRY.fallback.tier2, "disabled", "the gate's tier 2 is disabled");
  deepEq(AC_STEP.reads, ["inbox.entry", "features.list"], "plan.ac declares exactly two reads — issueId rides the payload (wrong-id carry)");
});

// ── (g) plan.spec reads plan.dod.definitionOfDone ────────────────────────────

await test("plan.spec reads plan.dod.definitionOfDone — never the retired merged field", () => {
  const expected = ["inbox.entry", "plan.dod.definitionOfDone", "plan.ac.acs", "repoState.pinned"];
  deepEq(PLAN.steps["plan.spec"].reads, expected, "graph step reads");
  deepEq(registry["plan.spec"].reads, expected, "registry entry reads");
  if (PLAN.steps["plan.spec"].reads.includes("plan.ac.definitionOfDone")) fail("the merged field is retired everywhere");
});

// ── (h) the counts hold: 27 entries, 8 steps / 7 edges, 6 decision edges ─────

await test("the seed partition survives the restructure: 27 entries, 8 steps on the 7-edge chain, 6 decision edges", () => {
  eq(Object.keys(registry).length, 27, "27 registry entries (no new ids)");
  const stepIds = Object.keys(PLAN.steps);
  eq(stepIds.length, 8, "8 steps");
  eq(PLAN.stepFlow.length, 7, "7 sequence edges — no graph edge was added for the loop (FOC-476's)");
  eq(GRAPH.decisionEdges.length, 6, "6 decision edges — the testable gate is node-internal, not an edge");
  const chain = PLAN.stepFlow.map((e) => `${e.from}>${e.to}`).join(" ");
  eq(chain, "plan.dor>plan.dod plan.dod>plan.ac plan.ac>plan.spec plan.spec>plan.gate1 plan.gate1>plan.decompose plan.decompose>plan.gate2 plan.gate2>plan.push", "the chain is unchanged");
});

// ── composeAcInputs: the payload partition + the over-length posture ─────────

console.log("\nplan-ac: composeAcInputs — the payload partition and the fail-closed cap");

await test("the entry payload carries exactly the four ingredients (+issueId), extra fields dropped", () => {
  const { payload, composed } = composeAcInputs({
    "inbox.entry": { issueId: "FOC-473", title: "t", scopeSummary: "s", dorFacts: ["f"], linearComments: "never", telemetry: "never" },
    "features.list": ["scripts/mcp/steps.mjs"],
  });
  deepEq(Object.keys(payload).sort(), ["dorFacts", "issueId", "scopeSummary", "title"], "exactly four payload fields");
  deepEq(payload, { issueId: "FOC-473", title: "t", scopeSummary: "s", dorFacts: ["f"] }, "the four ingredients");
  deepEq(Object.keys(composed), ["inbox.entry", "features.list"], "exactly the two declared reads compose");
});

await test("a string entry composes as the scope summary; absent dorFacts compose null — never invented", () => {
  const a = composeAcInputs({ "inbox.entry": "dictated text", "features.list": [] });
  deepEq(a.payload, { issueId: null, title: null, scopeSummary: "dictated text", dorFacts: null }, "string entry → scopeSummary, dorFacts null");
  const b = composeAcInputs({ "inbox.entry": { title: "t", scopeSummary: "s" }, "features.list": [] });
  eq(b.payload.dorFacts, null, "no dorFacts in state → null (runtime composition deferred)");
  eq(b.payload.issueId, null, "no issueId in state → null");
});

await test("over the seam's state cap the composition fails closed BEFORE any provider call — no truncation, zero fetch", async () => {
  const big = "x".repeat(STATE_CAP + 100);
  let thrown = null;
  try {
    composeAcInputs({ "inbox.entry": { title: "t", scopeSummary: big }, "features.list": [] });
  } catch (err) {
    thrown = err;
  }
  if (!thrown) fail("an over-cap payload must fail closed");
  eq(thrown.code, "invalid_input", "typed invalid_input");
  if (!thrown.message.includes("no truncation")) fail("the message names the no-truncation posture");

  // Through the node: zero generator calls (zero provider fetches) on cap.
  let genCalls = 0;
  const result = await runPlanAcNode({
    step: AC_STEP,
    reads: { "inbox.entry": { title: "t", scopeSummary: big }, "features.list": [] },
    generator: async () => { genCalls++; return AC_OUTPUT; },
    caller: async () => { fail("the gate must not be reached when composition fails closed"); },
    validate,
  });
  eq(result.status, "failed", "failed record");
  eq(result.error.code, "invalid_input", "typed code");
  eq(genCalls, 0, "zero provider calls — fail before the wire");
});

await test("an empty entry (no scope, no title) fails closed; a non-array features.list fails closed", () => {
  let thrown = null;
  try {
    composeAcInputs({ "inbox.entry": { dorFacts: ["only facts"] }, "features.list": [] });
  } catch (err) { thrown = err; }
  if (!thrown || thrown.code !== "invalid_input") fail("an entry with nothing to generate from fails typed");
  thrown = null;
  try {
    composeAcInputs({ "inbox.entry": "text", "features.list": "not-an-array" });
  } catch (err) { thrown = err; }
  if (!thrown || !thrown.message.includes("candidate-files array")) fail("a non-array features.list fails typed");
});

// ── (d) the node-internal loop ───────────────────────────────────────────────

console.log("\nplan-ac: the node-internal testable loop");

await test("above-threshold on the first pass: ONE [G] call, one gate call, no regeneration, done", async () => {
  const gate = gateStub(0.9);
  let genCalls = 0;
  const generator = async ({ stepId, step, reads }) => {
    if (stepId !== "plan.ac") fail(`the loop generates for plan.ac only, got ${stepId}`);
    void reads;
    genCalls++;
    return AC_OUTPUT;
  };
  const result = await runPlanAcNode({
    stepId: "plan.ac",
    step: AC_STEP,
    reads: { "inbox.entry": { issueId: "FOC-1", title: "t", scopeSummary: "s", dorFacts: null }, "features.list": ["a.mjs"] },
    generator,
    caller: gate.caller,
    validate,
  });
  eq(result.status, "done", "done on the first pass");
  eq(result.attempts, 1, "single attempt");
  deepEq(result.output, AC_OUTPUT, "the schema-valid output returns");
  eq(genCalls, 1, "exactly one [G] call");
  eq(gate.calls.length, 1, "exactly one gate call");
  eq(gate.calls[0].decisionId, AC_TESTABLE_DECISION, "the gate served by registry id");
  deepEq(gate.calls[0].instances, [{ id: "AC-1", text: AC_OUTPUT.acs[0].text }], "the seam's instances channel carries {id, text}");
  if (typeof gate.calls[0].state !== "string" || !gate.calls[0].state.includes("s")) fail("the gate sees the composed situation");
});

await test("below-threshold → EXACTLY ONE regeneration carrying the failing criteria + the gate reasons → re-score all → done", async () => {
  // Attempt 1 scores PER CRITERION: AC-1 and AC-2 below the verdict, AC-3
  // above. Attempt 2 re-scores ALL — above.
  const verdictsByAttempt = [[0.2, 0.2, 0.9], [0.9, 0.9, 0.9]];
  let gateCall = 0;
  const gateCalls = [];
  const caller = async (input) => {
    gateCalls.push(input);
    const per = verdictsByAttempt[Math.min(gateCall++, 1)];
    return {
      ok: true,
      decisionId: AC_TESTABLE_DECISION,
      autonomy: "A0",
      annotation: { answers: Object.fromEntries((input.instances ?? []).map((_, i) => [`ac${i}`, { type: "noul", noul: per[i] ?? 0.9 }])), confidence: 0.9 },
    };
  };
  const genReads = [];
  const outputs = [
    { acs: [{ id: "AC-1", text: "vague one", kind: "behaviour", evidence: "test" }, { id: "AC-2", text: "vague two", kind: "boundary", evidence: "file_state" }, { id: "AC-3", text: "checkable", kind: "verification", evidence: "command_output" }] },
    { acs: [{ id: "AC-1", text: "better one", kind: "behaviour", evidence: "test" }, { id: "AC-2", text: "better two", kind: "boundary", evidence: "file_state" }, { id: "AC-3", text: "better three", kind: "verification", evidence: "human_check" }] },
  ];
  let genCall = 0;
  const generator = async ({ reads }) => { genReads.push(reads); return outputs[genCall++] ?? outputs[1]; };

  const result = await runPlanAcNode({
    stepId: "plan.ac",
    step: AC_STEP,
    reads: { "inbox.entry": { issueId: "FOC-1", title: "t", scopeSummary: "s", dorFacts: ["fact"] }, "features.list": [] },
    generator,
    caller,
    validate,
  });
  eq(result.status, "done", "the regenerated list passes");
  eq(result.attempts, 2, "two attempts");
  eq(genReads.length, 2, "exactly one regeneration");
  eq(gateCalls.length, 2, "ALL criteria re-scored after the regeneration");
  deepEq(gateCalls[1].instances.map((i) => i.id), ["AC-1", "AC-2", "AC-3"], "re-score ALL criteria, not just the failing ones");

  const revision = genReads[1]["inbox.entry"].revision;
  eq(revision.attempt, 2, "the revision names attempt 2");
  deepEq(revision.failing.map((f) => f.id), ["AC-1", "AC-2"], "the failing criteria ride the revision");
  deepEq(revision.failing.map((f) => f.verdict), [0.2, 0.2], "their measured verdicts ride too");
  for (const f of revision.failing) {
    if (!f.reason.includes("vague, unmeasurable or unverifiable as written")) fail("the gate's reason rides the revision");
    if (!f.reason.includes(`p=${f.verdict}`)) fail("the measured verdict rides the reason");
  }
  if (!genReads[1]["inbox.entry"].revision.note.includes("Regenerate the FULL list")) fail("the regeneration note is on the payload");
  deepEq(genReads[1]["features.list"], [], "the declared reads stay exactly two");
});

await test("still below after the one regeneration → a typed ESCALATION with per-criterion verdicts, reasons, attempt count", async () => {
  const caller = async (input) => ({
    ok: true,
    decisionId: AC_TESTABLE_DECISION,
    autonomy: "A0",
    annotation: { answers: Object.fromEntries((input.instances ?? []).map((_, i) => [`ac${i}`, { type: "noul", noul: 0.3 }])), confidence: 0.3 },
  });
  const genReads = [];
  const generator = async ({ reads }) => { genReads.push(reads); return AC_OUTPUT; };
  const result = await runPlanAcNode({
    stepId: "plan.ac",
    step: AC_STEP,
    reads: { "inbox.entry": { title: "t", scopeSummary: "s" }, "features.list": [] },
    generator,
    caller,
    validate,
  });
  eq(result.status, "failed", "escalation is a failed (terminal) step outcome");
  eq(result.error.code, "escalated", "the typed escalation code");
  if (!result.error.message.includes("handed to the frontman")) fail("the escalation names the frontman hand-off");
  eq(result.escalation.attempts, 2, "attempt count visible");
  eq(result.escalation.threshold, TESTABLE_THRESHOLD, "threshold visible");
  eq(result.escalation.gate, AC_TESTABLE_DECISION, "the gate named");
  deepEq(result.escalation.criteria.map((c) => c.id), ["AC-1"], "per-criterion verdicts visible");
  eq(result.escalation.criteria[0].testable, false, "the verdict typed");
  if (!result.escalation.criteria[0].reason.includes("vague, unmeasurable or unverifiable as written")) fail("the reason rides the record");
  eq(genReads.length, 2, "exactly one regeneration happened");
  deepEq(Object.keys(genReads[1]["inbox.entry"].revision.failing[0]), ["id", "text", "verdict", "reason"], "the revision's failing record shape");
});

await test("a gate failure fails closed — envelope not ok, a throwing caller, a malformed answer: never a silent pass", async () => {
  const notOk = await runPlanAcNode({
    step: AC_STEP,
    reads: { "inbox.entry": { title: "t", scopeSummary: "s" }, "features.list": [] },
    generator: async () => AC_OUTPUT,
    caller: async () => ({ ok: false, error: { code: "provider_error", message: "the decisions endpoint failed" } }),
    validate,
  });
  eq(notOk.status, "failed", "not-ok envelope fails the step");
  eq(notOk.error.code, "provider_error", "the envelope's code surfaces");

  const throwing = await runPlanAcNode({
    step: AC_STEP,
    reads: { "inbox.entry": { title: "t", scopeSummary: "s" }, "features.list": [] },
    generator: async () => AC_OUTPUT,
    caller: async () => { throw new Error("caller blew up"); },
    validate,
  });
  eq(throwing.status, "failed", "a throwing caller fails the step");
  eq(throwing.error.code, "provider_error", "typed provider_error");

  const malformed = await runPlanAcNode({
    step: AC_STEP,
    reads: { "inbox.entry": { title: "t", scopeSummary: "s" }, "features.list": [] },
    generator: async () => AC_OUTPUT,
    caller: async () => ({ ok: true, annotation: { answers: {}, confidence: 1 } }),
    validate,
  });
  eq(malformed.status, "failed", "a missing verdict fails closed");
  eq(malformed.error.code, "unparseable_output", "typed unparseable_output");
});

await test("a schema-invalid [G] output fails typed BEFORE the gate — no gate call for unvalidated text", async () => {
  let gateCalls = 0;
  const result = await runPlanAcNode({
    step: AC_STEP,
    reads: { "inbox.entry": { title: "t", scopeSummary: "s" }, "features.list": [] },
    generator: async () => ({ acs: "not-a-list" }),
    caller: async () => { gateCalls++; return { ok: true, annotation: { answers: {} } }; },
    validate,
  });
  eq(result.status, "failed", "failed");
  eq(result.error.code, "schema_invalid", "typed schema_invalid");
  eq(gateCalls, 0, "no gate call on an invalid output");
});

// ── (b) the wire: the four ingredients and NOTHING else ──────────────────────

console.log("\nplan-ac: the default generator transport — the composed payload is the whole input");

await test("the four ingredients (+issueId) reach the message and nothing else — no repo tree, no telemetry, no Linear comments", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const fetchCalls = [];
    const generator = createDefaultGenerator({ apiKey: "test-key", runId: "run-ac-test", taskKey: "T1", shadowDir: dir, fetchImpl: async (url, options) => { fetchCalls.push({ url, options }); return okResponse(AC_OUTPUT); } });
    const payload = { issueId: "FOC-473", title: "Fifth kind", scopeSummary: "the accepted scope", dorFacts: ["one fact"] };
    await generator({ stepId: "plan.ac", step: AC_STEP, reads: composeAcInputs({ "inbox.entry": payload, "features.list": ["scripts/plan-ac.mjs"] }).composed });

    eq(fetchCalls.length, 1, "one fetch");
    const message = JSON.parse(fetchCalls[0].options.body).messages[0].content;
    if (!message.includes("You generate acceptance criteria for one planning inbox entry")) fail("the AC-only registry prompt is on the wire");
    if (!message.includes('- inbox.entry: {"issueId":"FOC-473","title":"Fifth kind","scopeSummary":"the accepted scope","dorFacts":["one fact"]}')) {
      fail("the EXACT four-ingredient payload is the declared input (nothing else reaches the wire)");
    }
    if (!message.includes('- features.list: ["scripts/plan-ac.mjs"]')) fail("the candidate files are the second read");
    const inputLines = message.split("\n").filter((l) => /^- [a-z]/.test(l));
    eq(inputLines.length, 2, "exactly the two declared reads — nothing else on the wire");
    // The INPUTS section (not the prompt, which legitimately names the
    // forbidden shapes) carries nothing beyond the declared payload.
    const inputs = inputLines.join("\n");
    for (const banned of ["definitionOfDone", "repoState", "Linear comment", "telemetry", "plan.dod."]) {
      if (inputs.includes(banned)) fail(`forbidden input shape on the wire: ${banned}`);
    }
    deepEq(JSON.parse(fetchCalls[0].options.body).response_format, { type: "json_schema", json_schema: { name: "plan.ac", strict: true, schema: AC_STEP.output } }, "strict json_schema with the AC-only output schema");
  } finally {
    cleanup();
  }
});

await test("the regeneration's wire message carries the failing criteria + the gate reason", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const fetchBodies = [];
    // First [G] call returns a vague list; the gate scores it below; the
    // regeneration rides the real transport too.
    const vague = { acs: [{ id: "AC-1", text: "some vague thing the gate will fail", kind: "behaviour", evidence: "test" }] };
    const fetchImpl = async (url, options) => {
      fetchBodies.push(JSON.parse(options.body));
      return okResponse(vague);
    };
    const caller = async (input) => ({
      ok: true,
      decisionId: AC_TESTABLE_DECISION,
      autonomy: "A0",
      annotation: { answers: Object.fromEntries((input.instances ?? []).map((_, i) => [`ac${i}`, { type: "noul", noul: 0.1 }])), confidence: 0.1 },
    });
    const result = await runPlanAcNode({
      stepId: "plan.ac",
      step: AC_STEP,
      reads: { "inbox.entry": { title: "t", scopeSummary: "s" }, "features.list": [] },
      generator: createDefaultGenerator({ apiKey: "test-key", runId: "run-ac-regen", taskKey: "T2", shadowDir: dir, fetchImpl }),
      caller,
      validate,
    });
    eq(result.status, "failed", "still below after the regen — escalated");
    eq(fetchBodies.length, 2, "two [G] calls on the wire");
    const regenMessage = fetchBodies[1].messages[0].content;
    if (!regenMessage.includes('"revision"')) fail("the revision field reaches the wire");
    if (!regenMessage.includes("some vague thing the gate will fail")) fail("placeholder never matches — the failing criterion TEXT must ride the message");
    if (!regenMessage.includes("some vague thing")) fail("the failing criterion's text is on the wire");
    if (!regenMessage.includes("vague, unmeasurable or unverifiable as written")) fail("the gate's reason is on the wire");
    if (!regenMessage.includes('"verdict":0.1')) fail("the measured verdict is on the wire");
    eq(fetchBodies[1].messages[0].content.includes('"attempt":2'), true, "the revision names attempt 2");
  } finally {
    cleanup();
  }
});

// ── (e) the over-length posture mirrors the seam's cap — one number ──────────

await test("the composed-payload cap is the seam's state cap, not a second copy", () => {
  eq(STATE_CAP, 16000, "the seam's state cap (decision-call.mjs, the one source)");
});

// ── (c) the eval harness input partition: the AC ground truth never enters ───

console.log("\nplan-ac: the eval harness input partition");

await test("buildInputs on the committed fixture: 12 rows, 11 with AC ground truth, FOC-406 reported UNKNOWN", () => {
  const fixture = JSON.parse(readFileSync(join(__dir, "plan-dod-eval-fixture.json"), "utf8"));
  eq(fixture.issues.length, 12, "12 fixture issues");
  const built = fixture.issues.map(buildInputs);
  eq(built.length, 12, "every row builds");
  const noGt = built.filter((b) => !b.hasGroundTruth);
  deepEq(noGt.map((b) => b.id), ["FOC-406"], "FOC-406 carries no AC section — no ground truth");
  for (const b of built.filter((x) => x.hasGroundTruth)) {
    if (!b.acGroundTruth || b.acGroundTruth.length < 20) fail(`${b.id}: ground truth implausibly short`);
    if (!b.scopeSummary) fail(`${b.id}: empty scope summary`);
    deepEq(Object.keys(b).sort(), ["acGroundTruth", "candidateFiles", "dorFacts", "hasGroundTruth", "id", "issueId", "scopeSummary", "title"], "the composed partition shape");
  }
});

await test("(c) the ground truth never enters the inputs: no AC line (>25 chars) from any fixture issue in any composed payload", () => {
  const fixture = JSON.parse(readFileSync(join(__dir, "plan-dod-eval-fixture.json"), "utf8"));
  for (const issue of fixture.issues) {
    const b = buildInputs(issue);
    const payloadJson = JSON.stringify({
      "inbox.entry": { issueId: b.issueId, title: b.title, scopeSummary: b.scopeSummary, dorFacts: b.dorFacts },
      "features.list": b.candidateFiles,
    });
    const gtLines = (b.acGroundTruth ?? "").split("\n").map((s) => s.trim()).filter((s) => s.length > 25);
    if (!gtLines.length && b.hasGroundTruth) fail(`${b.id}: AC ground truth present but no >25-char lines found — the strip rule is broken`);
    const leaked = gtLines.filter((l) => payloadJson.includes(l));
    if (leaked.length) fail(`${b.id}: ${leaked.length} AC ground-truth line(s) present in the composed payload`);
    if (payloadJson.includes("fenix-roadmap")) fail(`${b.id}: roadmap metadata leaked into the payload`);
  }
});

await test("buildInputs rejects malformed fixture rows and composes deterministically", () => {
  let thrown = null;
  try { buildInputs({ id: "X", title: "t" }); } catch (err) { thrown = err; }
  if (!thrown || !(thrown instanceof TypeError)) fail("a missing description is a TypeError (external input, validated)");
  const built = buildInputs({ id: " FOC-999 ", title: "T", description: "Scope.\n\n**Source:** FOC-1 review.\n\n**Deliverable:** a thing.\n\nSee `scripts/plan-ac.mjs:1,50-61` and `node scripts/test-all.mjs`." });
  eq(built.id, "FOC-999", "id trimmed");
  eq(built.issueId, "FOC-999", "issueId = the fixture id");
  deepEq(built.dorFacts, ["**Source:** FOC-1 review.", "**Deliverable:** a thing."], "line-start bold-keyed fact lines compose dorFacts");
  deepEq(built.candidateFiles, ["scripts/plan-ac.mjs"], "repo-ish backticked paths compose candidateFiles (line refs stripped, prose tokens dropped)");
});

// ── (f) the runner wiring: ledgers, event-line discipline, the escalation ────

console.log("\nplan-ac: the runner wiring — ledgers, event-line discipline, escalation");

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "plan-ac-runner-test-"));
  return { dir, storePath: join(dir, "graph-steps.jsonl"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// A runner with the REAL default generator (stubbed fetch) and a stub caller —
// the live wiring minus the network. plan.dor is seeded done: the walk under
// test is plan.ac's node loop.
function makeRunner({ generator, caller, storePath }) {
  appendFileSync(storePath, `${JSON.stringify({
    type: "graph.step", runId: "run-ac-runner", ts: "2026-01-01T00:00:00.000Z", key: "plan.dor", stepId: "plan.dor", status: "done", output: { ready: true, gaps: [] },
  })}\n`);
  return createGraphRunner({
    runId: "run-ac-runner",
    storePath,
    caller,
    generator,
    gateEmitter: async () => ({ gateId: "gate-test" }),
    linearEffect: async () => ({}),
  });
}

await test("success: ONE [G] call, one event line, a done record whose output is the schema-valid {acs}", async () => {
  const { dir, storePath, cleanup } = tempStore();
  const shadowDir = join(dir, "shadow");
  try {
    let gcall = 0;
    const generator = createDefaultGenerator({ apiKey: "test-key", runId: "run-ac-runner", shadowDir, fetchImpl: async () => okResponse(++gcall === 1 ? DOD_OUTPUT : AC_OUTPUT) });
    const caller = async (input) => ({
      ok: true,
      decisionId: AC_TESTABLE_DECISION,
      autonomy: "A0",
      annotation: { answers: Object.fromEntries((input.instances ?? []).map((_, i) => [`ac${i}`, { type: "noul", noul: 0.9 }])), confidence: 0.9 },
    });
    const result = await makeRunner({ generator, caller, storePath }).run({ inputs: RUN_INPUTS });
    eq(result.stepId, "plan.spec", "plan.ac completed; the run continued to the [A] hand-off");
    const records = readLines(storePath);
    const acRecord = records.find((r) => r.key === "plan.ac");
    if (!acRecord) fail("no record for plan.ac");
    eq(acRecord.status, "done", "done record");
    deepEq(acRecord.output, AC_OUTPUT, "the schema-valid output lands in the record");

    const events = readLines(join(shadowDir, "decisions.jsonl"));
    eq(events.length, 2, "one event line per successful [G] call (plan.dod first, then plan.ac — success-only)");
    const acEvents = events.filter((e) => e.decisionId === "plan.ac");
    eq(acEvents.length, 1, "ONE plan.ac event line for ONE successful [G] call");
    eq(acEvents[0].ok, true, "ok");
    eq(acEvents[0].runId, "run-ac-runner", "the event line keys to the run");
  } finally {
    cleanup();
  }
});

await test("(f) the escalation lands as a typed graph.step record; the [G] event lines stay success-only", async () => {
  const { dir, storePath, cleanup } = tempStore();
  const shadowDir = join(dir, "shadow");
  try {
    let calls = 0;
    const generator = createDefaultGenerator({ apiKey: "test-key", runId: "run-ac-runner", shadowDir, fetchImpl: async () => { calls++; return okResponse(calls === 1 ? DOD_OUTPUT : AC_OUTPUT); } });
    const caller = async (input) => ({
      ok: true,
      decisionId: AC_TESTABLE_DECISION,
      autonomy: "A0",
      annotation: { answers: Object.fromEntries((input.instances ?? []).map((_, i) => [`ac${i}`, { type: "noul", noul: 0.2 }])), confidence: 0.2 },
    });
    const result = await makeRunner({ generator, caller, storePath }).run({ inputs: RUN_INPUTS });
    eq(result.status, "stopped", "the escalation stops the run");
    eq(result.record.status, "failed", "terminal failed record");
    eq(result.record.error.code, "escalated", "typed escalation code on the record");
    eq(result.record.escalation.attempts, 2, "the escalation payload rides the record");
    deepEq(result.record.escalation.criteria.map((c) => c.id), ["AC-1"], "per-criterion verdicts on the record");
    if (!result.record.escalation.criteria[0].reason) fail("the reason rides the record");

    // Ledger 1 — graph-steps: ONE record for the step (the escalation), no
    // intermediate done record for the failed attempt.
    const records = readLines(storePath);
    const acRecords = records.filter((r) => r.key === "plan.ac");
    eq(acRecords.length, 1, "one terminal record per execution");
    eq(acRecords[0].status, "failed", "the escalation IS the record");

    // Ledger 2 — decisions.jsonl: every successful [G] call — plan.dod once,
    // plan.ac twice (initial + regeneration); the failed gate attempts log nothing.
    const events = readLines(join(shadowDir, "decisions.jsonl"));
    eq(events.length, 3, "one event line per successful [G] call (plan.dod, plan.ac ×2 — success-only transport)");
    if (!events.every((e) => e.ok === true)) fail("only successful [G] calls logged");
    if (!events.every((e) => e.decisionId === "plan.ac" || e.decisionId === "plan.dod")) fail("only the two [G] steps logged");
    const acEvents = events.filter((e) => e.decisionId === "plan.ac");
    eq(acEvents.length, 2, "two plan.ac event lines (initial + regeneration)");
    if (events.some((e) => e.decisionId === "escalation" || e.decisionId === AC_TESTABLE_DECISION)) {
      fail("the escalation itself is not a provider call — it lands as the graph.step record");
    }
  } finally {
    cleanup();
  }
});

await test("a failed [G] call appends NOTHING to decisions.jsonl and lands the typed failed record", async () => {
  const { dir, storePath, cleanup } = tempStore();
  const shadowDir = join(dir, "shadow");
  try {
    const generator = createDefaultGenerator({ apiKey: "test-key", runId: "run-ac-runner", shadowDir, fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ error: { message: "boom" } }) }) });
    const result = await makeRunner({ generator, caller: async () => { fail("the gate must not fire when the [G] call failed"); }, storePath }).run({ inputs: RUN_INPUTS });
    eq(result.status, "stopped", "stopped");
    eq(result.record.status, "failed", "failed record");
    eq(result.record.error.code, "provider_error", "typed provider_error");
    if (existsSync(join(shadowDir, "decisions.jsonl"))) fail("a failed call appends no event line (success-only)");
  } finally {
    cleanup();
  }
});

console.log(`\nplan-ac: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log("  FAILED: " + f);
  process.exit(1);
}