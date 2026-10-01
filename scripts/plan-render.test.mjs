// scripts/plan-render.test.mjs — FOC-520: the plan.render [D] deterministic
// renderer.
//
// All offline. The registry entry and the graph step are the committed spec
// (loaded through the real loader — no fixture drift); the golden assertion
// pins the EXACT rendered text for a fixed fixture, determinism is pinned by
// rendering the same reads twice (byte-identical, key order irrelevant), and
// every fail-closed path (missing/empty reads, malformed DoD/AC/task items,
// over-cap text) is a typed invalid_input — never a partial or guessed issue.
// The runner section walks the committed graph with seeded predecessor
// records: plan.render executes before plan.gate2, the gate facts carry the
// rendered text VERBATIM, and the pushed payload's issueText is the same
// string 1:1 — what the gate showed is what would be written to Linear.
//
// Run: node scripts/plan-render.test.mjs

import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import assert from "node:assert/strict";
import { getRegistryEntry } from "./decision-registry.mjs";
import { loadGraph, validateGraph } from "./graph-validate.mjs";
import { createGraphRunner } from "./graph-runner.mjs";
import { ISSUE_TEXT_MAX, composeIssueText, runPlanRenderNode } from "./plan-render.mjs";

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

// ── shared fixtures (the committed spec + a fixed full-input fixture) ────────

const REGISTRY = getRegistryEntry("plan.render");
const GRAPH = loadGraph();
const PLAN = GRAPH.nodes.plan;
const RENDER_STEP = PLAN.steps["plan.render"];

const FIXTURE_READS = {
  "plan.dod.definitionOfDone": [
    { check: "node scripts/test-all.mjs is green", kind: "test", bounded: true },
    { check: "walk the supervisor e2e checklist by hand", kind: "manual", bounded: false },
  ],
  "plan.ac.acs": [
    { id: "AC-1", text: "The same reads render byte-identical issue text.", kind: "behaviour", evidence: "test" },
    { id: "AC-2", text: "Gate 2 facts carry the rendered text verbatim.", kind: "verification", evidence: "human_check" },
  ],
  "plan.spec.summary": "Deterministic issue rendering for the plan chain.",
  "plan.decompose.record": {
    stepId: "plan.decompose",
    key: "plan.decompose",
    status: "done",
    output: {
      tasks: [
        { title: "scripts/plan-render.mjs", size: "medium", labels: ["tech"], relations: [] },
        { title: "wire the runner", size: "small", labels: ["tech", "config"], relations: ["blocks:push"] },
      ],
    },
  },
};

// The golden text — every line pinned, byte for byte.
const GOLDEN = [
  "# Plan",
  "",
  "## Spec summary",
  "",
  "Deterministic issue rendering for the plan chain.",
  "",
  "## Acceptance criteria",
  "",
  "- AC-1 (behaviour, evidence: test): The same reads render byte-identical issue text.",
  "- AC-2 (verification, evidence: human_check): Gate 2 facts carry the rendered text verbatim.",
  "",
  "## Definition of done",
  "",
  "- [x] (test) node scripts/test-all.mjs is green",
  "- [ ] (manual) walk the supervisor e2e checklist by hand",
  "",
  "## Decomposed tasks",
  "",
  "1. scripts/plan-render.mjs (size: medium; labels: tech; relations: none)",
  "2. wire the runner (size: small; labels: tech, config; relations: blocks:push)",
].join("\n");

// The plan.render chain predecessor outputs the runner walk seeds as done
// records — the same fixture the committed spec's reads resolve from.
function seedDone(storePath, key, stepId, output) {
  appendFileSync(storePath, `${JSON.stringify({
    type: "graph.step",
    runId: "run-plan-render",
    ts: "2026-01-01T00:00:00.000Z",
    key,
    stepId,
    status: "done",
    output,
  })}\n`);
}

console.log("\nplan-render: the committed spec (real loader — no fixture drift)");

await test("plan.render sits on the chain between plan.decompose and plan.gate2, kind D, tier null", () => {
  eq(validateGraph(GRAPH).length, 0, "the committed graph validates");
  const stepIds = Object.keys(PLAN.steps);
  eq(stepIds.length, 10, "10 steps");
  eq(PLAN.stepFlow.length, 9, "9 sequence edges");
  const chain = PLAN.stepFlow.map((e) => `${e.from}>${e.to}`).join(" ");
  eq(
    chain,
    "plan.dor>plan.intent plan.intent>plan.dod plan.dod>plan.ac plan.ac>plan.spec plan.spec>plan.gate1 plan.gate1>plan.decompose plan.decompose>plan.render plan.render>plan.gate2 plan.gate2>plan.push",
    "plan.render joined the chain between plan.decompose and plan.gate2 (FOC-520)",
  );
  eq(RENDER_STEP.kind, "D", "kind D — deterministic, no model tier");
  eq(RENDER_STEP.tier, null, "tier null");
  eq(RENDER_STEP.failure, "stop", "failure stop");
  eq(RENDER_STEP.writes, "run-record", "writes run-record");
  deepEq(
    RENDER_STEP.reads,
    ["plan.dod.definitionOfDone", "plan.ac.acs", "plan.spec.summary", "plan.decompose.record"],
    "the reads are exactly the inputs the ticket names",
  );
  deepEq(REGISTRY.reads, RENDER_STEP.reads, "registry reads === graph reads");
  deepEq(REGISTRY.output, RENDER_STEP.output, "registry output === graph output");
  eq(REGISTRY.tier, RENDER_STEP.tier, "registry tier === graph tier");
  eq(REGISTRY.failure, RENDER_STEP.failure, "registry failure === graph failure");
  eq(REGISTRY.writes, RENDER_STEP.writes, "registry writes === graph writes");
  eq(REGISTRY.autonomy, null, "no autonomy — a [D] node never decides");
  eq(REGISTRY.threshold, null, "no threshold");
  eq(REGISTRY.fallback.tier2, "disabled", "tier-2 disabled (FOC-473 posture)");
});

await test("the output schema pins issueText; maxLength === ISSUE_TEXT_MAX (anti-drift)", () => {
  const schema = RENDER_STEP.output;
  deepEq(schema.required, ["issueText"], "required issueText");
  eq(schema.additionalProperties, false, "closed schema");
  eq(schema.properties.issueText.type, "string", "issueText is a string");
  eq(schema.properties.issueText.minLength, 1, "minLength 1");
  eq(schema.properties.issueText.maxLength, ISSUE_TEXT_MAX, "maxLength === the module's ISSUE_TEXT_MAX");
  const validate = new Ajv().compile(schema);
  eq(validate({ issueText: GOLDEN }), true, "the golden text passes the schema");
  eq(validate({ issueText: "" }), false, "empty text fails");
  eq(validate({ issueText: "x" + "y".repeat(ISSUE_TEXT_MAX) }), false, "over-cap text fails");
  eq(validate({ nope: 1 }), false, "a foreign shape fails");
});

console.log("\nplan-render: the golden text + determinism");

await test("full-input golden: the fixed fixture renders the exact expected text", () => {
  const issueText = composeIssueText(FIXTURE_READS);
  eq(issueText, GOLDEN, "byte-identical to the committed golden");
});

await test("the same reads render byte-identical text — twice, key order irrelevant", () => {
  const a = composeIssueText(FIXTURE_READS);
  const b = composeIssueText(FIXTURE_READS);
  eq(a, b, "two renders of the same reads are byte-identical");
  // The reads map rebuilt in a different key order renders the same text —
  // the text is a pure function of the VALUES, never of the map shape.
  const reordered = {
    "plan.decompose.record": FIXTURE_READS["plan.decompose.record"],
    "plan.spec.summary": FIXTURE_READS["plan.spec.summary"],
    "plan.ac.acs": FIXTURE_READS["plan.ac.acs"],
    "plan.dod.definitionOfDone": FIXTURE_READS["plan.dod.definitionOfDone"],
  };
  eq(composeIssueText(reordered), GOLDEN, "key order irrelevant");
  // No timestamps, no run ids — nothing nondeterministic may leak in.
  if (/\d{4}-\d{2}-\d{2}|run-/.test(a)) fail("the rendered text carries no timestamp or run id");
});

await test("the node returns the schema-valid output through the injected validator", () => {
  const validate = new Ajv().compile(RENDER_STEP.output);
  const result = runPlanRenderNode({ stepId: "plan.render", reads: FIXTURE_READS, validate });
  deepEq(result, { status: "done", output: { issueText: GOLDEN } }, "done with the exact output shape");
});

await test("a missing validator is a caller bug — typed invalid_input, never a guessed pass", () => {
  let thrown = null;
  try {
    runPlanRenderNode({ stepId: "plan.render", reads: FIXTURE_READS, validate: undefined });
  } catch (err) {
    thrown = err;
  }
  if (!thrown) fail("a missing validator must fail the call");
  eqCode(thrown, "invalid_input", "typed code");
});

console.log("\nplan-render: fail-closed — missing, empty and malformed reads");

async function failsTyped(reads, code, needle) {
  let thrown = null;
  try {
    composeIssueText(reads);
  } catch (err) {
    thrown = err;
  }
  if (!thrown) fail("the composition must fail closed");
  eqCode(thrown, code, "typed code");
  if (needle && !thrown.message.includes(needle)) fail(`message should name "${needle}", got: ${thrown.message}`);
  // Through the node: the same read shape is a FAILED step outcome, never a throw into the runner.
  const result = runPlanRenderNode({ stepId: "plan.render", reads, validate: () => true });
  eq(result.status, "failed", "node returns a failed outcome");
  eq(result.error.code, code, "node carries the typed code");
}

await test("a non-object reads map fails typed", async () => {
  await failsTyped(undefined, "invalid_input", "resolved reads");
  await failsTyped(null, "invalid_input", "resolved reads");
  await failsTyped([1, 2], "invalid_input", "resolved reads");
});

await test("each missing read fails typed, naming the read", async () => {
  const { "plan.dod.definitionOfDone": _dod, ...noDod } = FIXTURE_READS;
  const { "plan.ac.acs": _acs, ...noAcs } = FIXTURE_READS;
  const { "plan.spec.summary": _sum, ...noSummary } = FIXTURE_READS;
  const { "plan.decompose.record": _dec, ...noDecompose } = FIXTURE_READS;
  await failsTyped(noDod, "invalid_input", "plan.dod.definitionOfDone");
  await failsTyped(noAcs, "invalid_input", "plan.ac.acs");
  await failsTyped(noSummary, "invalid_input", "plan.spec.summary");
  await failsTyped(noDecompose, "invalid_input", "plan.decompose.record");
});

await test("empty reads fail typed — a partial issue is never rendered", async () => {
  await failsTyped({ ...FIXTURE_READS, "plan.dod.definitionOfDone": [] }, "invalid_input", "plan.dod.definitionOfDone");
  await failsTyped({ ...FIXTURE_READS, "plan.ac.acs": [] }, "invalid_input", "plan.ac.acs");
  await failsTyped({ ...FIXTURE_READS, "plan.spec.summary": "" }, "invalid_input", "plan.spec.summary");
  await failsTyped({ ...FIXTURE_READS, "plan.spec.summary": "   " }, "invalid_input", "plan.spec.summary");
  await failsTyped({ ...FIXTURE_READS, "plan.decompose.record": { status: "done", output: { tasks: [] } } }, "invalid_input", "plan.decompose.record");
  await failsTyped({ ...FIXTURE_READS, "plan.decompose.record": { status: "done" } }, "invalid_input", "plan.decompose.record");
});

await test("malformed DoD items fail typed (missing kind, non-boolean bounded, empty check)", async () => {
  await failsTyped({ ...FIXTURE_READS, "plan.dod.definitionOfDone": [{ check: "c", bounded: true }] }, "invalid_input", "malformed at item 0");
  await failsTyped({ ...FIXTURE_READS, "plan.dod.definitionOfDone": [{ check: "c", kind: "test" }] }, "invalid_input", "malformed at item 0");
  await failsTyped({ ...FIXTURE_READS, "plan.dod.definitionOfDone": [{ check: "", kind: "test", bounded: true }] }, "invalid_input", "malformed at item 0");
  await failsTyped({ ...FIXTURE_READS, "plan.dod.definitionOfDone": ["check"] }, "invalid_input", "malformed at item 0");
  await failsTyped({ ...FIXTURE_READS, "plan.dod.definitionOfDone": [FIXTURE_READS["plan.dod.definitionOfDone"][0], { check: "c", kind: "lint", bounded: "yes" }] }, "invalid_input", "malformed at item 1");
});

await test("malformed AC items fail typed", async () => {
  await failsTyped({ ...FIXTURE_READS, "plan.ac.acs": [{ id: "AC-1", text: "t", kind: "behaviour" }] }, "invalid_input", "malformed at item 0");
  await failsTyped({ ...FIXTURE_READS, "plan.ac.acs": [{ id: "", text: "t", kind: "behaviour", evidence: "test" }] }, "invalid_input", "malformed at item 0");
});

await test("malformed decompose tasks fail typed", async () => {
  await failsTyped({ ...FIXTURE_READS, "plan.decompose.record": { status: "done", output: { tasks: [{ size: "small", labels: [], relations: [] }] } } }, "invalid_input", "malformed at task 0");
  await failsTyped({ ...FIXTURE_READS, "plan.decompose.record": { status: "done", output: { tasks: [{ title: "t", size: "small", labels: "tech", relations: [] }] } } }, "invalid_input", "malformed at task 0");
  await failsTyped({ ...FIXTURE_READS, "plan.decompose.record": { status: "done", output: { tasks: [{ title: "t", size: "small", labels: [], relations: "none" }] } } }, "invalid_input", "malformed at task 0");
  await failsTyped({ ...FIXTURE_READS, "plan.decompose.record": { status: "done", output: { tasks: "all" } } }, "invalid_input", "plan.decompose.record");
  await failsTyped({ ...FIXTURE_READS, "plan.decompose.record": "record" }, "invalid_input", "plan.decompose.record");
});

await test("over-cap text fails closed BEFORE the gate — never truncated", async () => {
  const big = "x".repeat(ISSUE_TEXT_MAX + 1);
  await failsTyped({ ...FIXTURE_READS, "plan.spec.summary": big }, "invalid_input", "fail closed");
});

console.log("\nplan-render: the runner executes plan.render before plan.gate2");

await test("the walk renders, gate2 facts carry the text verbatim, the push payload is 1:1", async () => {
  const dir = mkdtempSync(join(tmpdir(), "plan-render-test-"));
  const storePath = join(dir, "graph-steps.jsonl");
  try {
    // Seed every predecessor done — the walk starts straight at plan.render.
    seedDone(storePath, "plan.dor", "plan.dor", { ready: true, gaps: [] });
    seedDone(storePath, "plan.intent", "plan.intent", { goal: "g", why: "w", mapVersion: 1, interpretations: [] });
    seedDone(storePath, "plan.dod", "plan.dod", { definitionOfDone: FIXTURE_READS["plan.dod.definitionOfDone"] });
    seedDone(storePath, "plan.ac", "plan.ac", { acs: FIXTURE_READS["plan.ac.acs"] });
    seedDone(storePath, "plan.spec", "plan.spec", { briefs: ["b"], adr: "a", summary: FIXTURE_READS["plan.spec.summary"] });
    seedDone(storePath, "gate.plan.gate1", "plan.gate1", { approved: true });
    seedDone(storePath, "plan.decompose", "plan.decompose", { tasks: FIXTURE_READS["plan.decompose.record"].output.tasks });

    const gateCalls = [];
    const linearCalls = [];
    const runner = createGraphRunner({
      runId: "run-plan-render",
      storePath,
      caller: async () => fail("no seam call on a fully seeded walk"),
      generator: async () => fail("no generator call on a fully seeded walk"),
      gateEmitter: async (input) => {
        gateCalls.push(input);
        return { gateId: "gate-test-1" };
      },
      linearEffect: async ({ action, payload }) => {
        linearCalls.push({ action, payload });
        return { epicId: "FEN-900", childrenIds: ["FEN-901", "FEN-902"], handoffCommentPosted: true };
      },
    });

    // Run 1 — plan.render composes deterministically, then plan.gate2 stops gate-pending.
    const result = await runner.run({ inputs: {} });
    eq(result.status, "stopped", "run stops at gate2");
    eq(result.stepId, "plan.gate2", "gate2 is where the walk waits");
    eq(result.record.status, "gate-pending", "gate record pending");
    eq(gateCalls.length, 1, "one gate emit");
    if (!gateCalls[0].summary.includes("plan.render")) fail("the gate summary names the rendered issue");

    const records = readFileSync(storePath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const renderRecord = records.filter((r) => r.key === "plan.render").pop();
    eq(renderRecord.status, "done", "plan.render done before the gate");
    eq(renderRecord.output.issueText, GOLDEN, "the record's issueText is the golden text");
    eq(gateCalls[0].facts.reads["plan.render.issueText"], GOLDEN, "the gate facts carry the rendered text VERBATIM");

    // The frontman approves. Run 2 — plan.push through the injected boundary.
    appendFileSync(storePath, `${JSON.stringify({
      type: "graph.resolution",
      runId: "run-plan-render",
      ts: "2026-01-01T00:00:00.000Z",
      key: "gate.plan.gate2.resolution",
      stepId: "plan.gate2",
      by: "mateusz",
      output: { approved: true },
    })}\n`);
    const done = await runner.run({ inputs: {} });
    eq(done.status, "completed", "the walk completes after the approval");
    eq(linearCalls.length, 1, "one Linear-boundary call");
    eq(linearCalls[0].action, "push-plan", "action shape");
    eq(linearCalls[0].payload.issueText, GOLDEN, "the pushed issueText is the rendered text 1:1 — no rewording");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("a failed render stops the run before the gate — the gate never sees a partial issue", async () => {
  const dir = mkdtempSync(join(tmpdir(), "plan-render-test-"));
  const storePath = join(dir, "graph-steps.jsonl");
  try {
    seedDone(storePath, "plan.dor", "plan.dor", { ready: true, gaps: [] });
    seedDone(storePath, "plan.intent", "plan.intent", { goal: "g", why: "w", mapVersion: 1, interpretations: [] });
    seedDone(storePath, "plan.dod", "plan.dod", { definitionOfDone: FIXTURE_READS["plan.dod.definitionOfDone"] });
    // plan.ac done with an EMPTY acs list — valid for the schema? No: the
    // schema pins minItems 1, but a hand-seeded record bypasses nothing here;
    // the renderer itself fails closed on the empty list.
    seedDone(storePath, "plan.ac", "plan.ac", { acs: [] });
    seedDone(storePath, "plan.spec", "plan.spec", { briefs: ["b"], adr: "a", summary: FIXTURE_READS["plan.spec.summary"] });
    seedDone(storePath, "gate.plan.gate1", "plan.gate1", { approved: true });
    seedDone(storePath, "plan.decompose", "plan.decompose", { tasks: FIXTURE_READS["plan.decompose.record"].output.tasks });

    const runner = createGraphRunner({
      runId: "run-plan-render",
      storePath,
      caller: async () => fail("no seam call"),
      generator: async () => fail("no generator call"),
      gateEmitter: async () => fail("the gate must not emit on a failed render"),
      linearEffect: async () => fail("the push must not run on a failed render"),
    });
    const result = await runner.run({ inputs: {} });
    eq(result.status, "stopped", "run stops");
    eq(result.stepId, "plan.render", "stopped at the render step");
    eq(result.record.status, "failed", "failed record");
    eq(result.record.error.code, "invalid_input", "typed code");
    if (!result.record.error.message.includes("plan.ac.acs")) fail("the failure names the malformed read");
    const records = readFileSync(storePath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    if (records.some((r) => r.key === "gate.plan.gate2")) fail("gate2 never emitted after a failed render");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`\nplan-render: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("\nfailed tests:");
  for (const name of failures) console.error("  - " + name);
  process.exit(1);
}