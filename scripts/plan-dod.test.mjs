// scripts/plan-dod.test.mjs — FOC-474: the plan.dod [G] Definition-of-Done
// generator node.
//
// All offline. The registry entry and the graph step are the committed spec
// (loaded through the real loader — no fixture drift). The runner contract is
// exercised through injected generators exactly as graph-runner.test.mjs does;
// the DEFAULT generator — the one live [G] calls actually ride — is exercised
// on an injected fetch: registry prompt + resolved reads reach the wire, the
// strict json_schema travels, and ONE FOC-449 event line lands in
// decisions.jsonl per successful call (input as sent, mask-only scrubbed,
// answers, usage/cost, latency) while every failure path appends NOTHING.
// The eval harness's input partition is tested against the committed fixture:
// the approved DoD section is ground truth and never enters the inputs.
//
// Run: node scripts/plan-dod.test.mjs

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { getRegistryEntry } from "./decision-registry.mjs";
import { loadGraph, validateGraph } from "./graph-validate.mjs";
import { createGraphRunner, createDefaultGenerator } from "./graph-runner.mjs";
import { SHADOW_EVENT_TYPE } from "./decision-call.mjs";
import { buildInputs, runAll } from "./plan-dod-eval.mjs";

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

// ── shared fixtures ──────────────────────────────────────────────────────────

const REGISTRY = getRegistryEntry("plan.dod");
const GRAPH = loadGraph();
const PLAN = GRAPH.nodes.plan;
const DOD_STEP = PLAN.steps["plan.dod"];
const AC_STEP = PLAN.steps["plan.ac"];

const DOD_OUTPUT = {
  definitionOfDone: [{ check: "node scripts/graph-runner.test.mjs is green", kind: "test", bounded: true }],
};
const AC_OUTPUT = {
  acs: [{ id: "AC-1", text: "The DoD node generates a bounded checklist.", kind: "behaviour" }],
  definitionOfDone: [{ check: "node scripts/plan-dod.test.mjs is green", kind: "test", bounded: true }],
};
const RUN_INPUTS = {
  "inbox.entry": "Dictated entry (test): the plan chain generates the DoD as a bounded checklist.",
  "repoState.pinned": { branch: "foc-474-dev", head: "e31d971" },
  "features.list": [{ name: "plan.dod [G] node" }],
};

// OpenRouter-shaped response the stubbed fetch serves.
function okResponse(content, usage = { input_tokens: 123, output_tokens: 45, cost: 0.000045 }) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      id: "resp-plan-dod-test",
      model: "z-ai/glm-5.3-flash",
      choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }],
      usage,
    }),
  };
}

function tempDir(prefix = "plan-dod-test-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function readLines(path) {
  return readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

// ── the registry entry (loaded through the real loader — no fixture) ─────────

console.log("\nplan-dod: the registry entry (real loader)");

await test("the plan.dod entry carries the D7 contract: exactly-kind, cheap tier, fail-closed stop, run-record writes", () => {
  eq(REGISTRY.id, "plan.dod", "entry id");
  eq(REGISTRY.kind, "G", "kind");
  eq(REGISTRY.tier, "cheap", "cheap tier (D7: [G] runs cheap by default)");
  eq(REGISTRY.failure, "stop", "failure stop — the chain stops at one typed failure record");
  eq(REGISTRY.writes, "run-record", "writes run-record");
  deepEq(REGISTRY.reads, ["inbox.entry"], "single declared read (input partition: title + accepted scope summary)");
  eq(REGISTRY.autonomy, null, "no autonomy — a [G] node never decides a gate");
  eq(REGISTRY.threshold, null, "no threshold until calibration");
  eq(REGISTRY.criteriaVersion, 1, "criteria version");
  deepEq(REGISTRY.metrics, ["durationMs", "inputTokens", "outputTokens", "cost"], "metrics without confidence");
  eq(REGISTRY.fallback.tier2, "disabled", "tier-2 disabled (FOC-473 posture)");
});

await test("the registry prompt carries the role, the declared inputs, the kind taxonomy and the no-invented-scope rule — under 4000 chars", () => {
  const prompt = REGISTRY.prompt;
  eq(typeof prompt, "string", "prompt is a string");
  if (prompt.length > 4000) fail(`prompt is ${prompt.length} chars — the design caps it at 4000`);
  for (const needle of [
    "You generate the Definition of Done for one planning inbox entry", // the role
    "declared inputs", // only the declared inputs
    "no invented scope", // never invent scope
    "1 to 12", // bounded checklist size
    "200 characters", // per-item cap
    "test (a named test", "lint (the linter", "manual (a human verification", "linear (a Linear-side fact", // the kind taxonomy
    "bounded", // the bounded flag
    "output schema", // schema-validated output
    "cheap tier", // the tier statement
  ]) {
    if (!prompt.includes(needle)) fail(`prompt is missing "${needle}"`);
  }
  // The prompt never carries the ground truth of any fixture issue.
  if (/FOC-\d+/.test(prompt)) fail("the prompt must not name fixture issues");
});

await test("the output schema is the design's bounded checklist schema", () => {
  const dod = REGISTRY.output.properties.definitionOfDone;
  eq(REGISTRY.output.type, "object", "object output");
  deepEq(REGISTRY.output.required, ["definitionOfDone"], "required key");
  eq(REGISTRY.output.additionalProperties, false, "closed schema");
  eq(dod.type, "array", "array");
  eq(dod.minItems, 1, "minItems 1");
  eq(dod.maxItems, 12, "maxItems 12");
  const item = dod.items;
  deepEq(item.required, ["check", "kind", "bounded"], "item keys");
  eq(item.additionalProperties, false, "closed items");
  eq(item.properties.check.type, "string", "check is a string");
  eq(item.properties.check.maxLength, 200, "check capped at 200");
  deepEq(item.properties.kind.enum, ["test", "lint", "manual", "linear"], "kind taxonomy");
  eq(item.properties.bounded.type, "boolean", "bounded is a boolean");
});

// ── the graph wiring (the committed spec) ────────────────────────────────────

console.log("\nplan-dod: the graph wiring");

await test("8 plan steps, 7 sequence edges, plan.dod sits between plan.dor and plan.ac", () => {
  eq(validateGraph(GRAPH).length, 0, "the committed graph validates");
  const stepIds = Object.keys(PLAN.steps);
  eq(stepIds.length, 8, `8 steps, got ${stepIds.length}`);
  if (!stepIds.includes("plan.dod")) fail("plan.dod missing from the steps map");
  eq(PLAN.stepFlow.length, 7, "7 sequence edges");
  const chain = PLAN.stepFlow.map((e) => `${e.from}>${e.to}`).join(" ");
  eq(
    chain,
    "plan.dor>plan.dod plan.dod>plan.ac plan.ac>plan.spec plan.spec>plan.gate1 plan.gate1>plan.decompose plan.decompose>plan.gate2 plan.gate2>plan.push",
    "the chain runs dor → dod → ac → spec → gate1 → decompose → gate2 → push",
  );
  eq(PLAN.steps["plan.dor"].kind, "J", "plan.dor stays [J]");
  eq(DOD_STEP.kind, "G", "plan.dod is [G]");
  eq(AC_STEP.kind, "G", "plan.ac stays [G] (FOC-475 owns any split)");
});

await test("the graph step deep-equals the registry entry on the D7 contract (one spec, two views)", () => {
  for (const field of ["kind", "reads", "output", "tier", "failure", "writes"]) {
    deepEq(DOD_STEP[field], REGISTRY[field], `step.${field} === entry.${field}`);
  }
});

// ── the runner executes plan.dod (injected generator, like the other suites) ─

function seedDone(storePath, stepId, output) {
  appendFileSync(storePath, `${JSON.stringify({
    type: "graph.step",
    runId: "run-plan-dod",
    ts: "2026-01-01T00:00:00.000Z",
    key: PLAN.steps[stepId].kind === "H" ? `gate.${stepId}` : stepId,
    stepId,
    status: "done",
    output,
  })}\n`);
}

function makeRunner({ generator, storePath, caller = async () => { fail("the caller must not fire when plan.dor is already done"); } }) {
  return createGraphRunner({
    runId: "run-plan-dod",
    storePath,
    caller,
    generator,
    gateEmitter: async () => ({ gateId: "gate-test" }),
    linearEffect: async () => ({}),
  });
}

// plan.dor is already done (the frontman resolved it) — the walk executes
// plan.dod, then plan.ac, then stops at the plan.spec [A] hand-off.
function seedPlanDor(storePath) {
  seedDone(storePath, "plan.dor", { ready: true, gaps: [] });
}

console.log("\nplan-dod: the runner executes plan.dod");

await test("the walk executes plan.dod [G] through the generator: one call, resolved reads, done record, schema-validated", async () => {
  const { dir, storePath } = (() => {
    const d = mkdtempSync(join(tmpdir(), "plan-dod-test-"));
    return { dir: d, storePath: join(d, "graph-steps.jsonl"), cleanup: () => rmSync(d, { recursive: true, force: true }) };
  })();
  try {
    seedPlanDor(storePath);
    const genCalls = [];
    const generator = async ({ stepId, step, reads }) => {
      genCalls.push({ stepId, step, reads });
      if (stepId === "plan.dod") {
        if (step.reads.length !== 1 || step.reads[0] !== "inbox.entry") fail("plan.dod declares one read: inbox.entry");
        if (typeof reads["inbox.entry"] === "undefined") fail("inbox.entry read missing");
        return DOD_OUTPUT;
      }
      eq(stepId, "plan.ac", "generator serves plan.dod then plan.ac");
      return AC_OUTPUT;
    };
    const result = await makeRunner({ generator, storePath }).run({ inputs: RUN_INPUTS });
    eq(result.status, "stopped", "run stops at the [A] hand-off after the [G]s");
    eq(result.stepId, "plan.spec", "stops at plan.spec");
    eq(genCalls.length, 2, "exactly two [G] calls (plan.dod, plan.ac)");
    eq(genCalls[0].stepId, "plan.dod", "plan.dod first");

    const records = readLines(storePath);
    const dodRecord = records.find((r) => r.key === "plan.dod" && r.status === "done");
    if (!dodRecord) fail("no done record for plan.dod");
    eq(dodRecord.stepId, "plan.dod", "record stepId");
    deepEq(dodRecord.output, DOD_OUTPUT, "the validated output lands in the record");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("a schema-invalid plan.dod output lands as ONE typed failed record — terminal on resume, never re-executed", async () => {
  const d = mkdtempSync(join(tmpdir(), "plan-dod-test-"));
  const storePath = join(d, "graph-steps.jsonl");
  try {
    seedPlanDor(storePath);
    const generator = async ({ stepId }) => (stepId === "plan.dod" ? { definitionOfDone: [] } : AC_OUTPUT); // minItems 1 violated
    const runner = makeRunner({ generator, storePath });
    let result = await runner.run({ inputs: RUN_INPUTS });
    eq(result.status, "stopped", "run stops on the invalid output");
    eq(result.record.status, "failed", "failed record");
    eq(result.record.error.code, "schema_invalid", "typed schema_invalid");
    eq(result.record.key, "plan.dod", "the failure keys to plan.dod");

    // Resume: failed is terminal — the same failed record, no re-execution.
    result = await runner.run({ inputs: RUN_INPUTS });
    eq(result.status, "stopped", "still stopped");
    eq(result.record.status, "failed", "the failed record is terminal");
    eq(result.record.error.code, "schema_invalid", "same failure returned");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

// ── the DEFAULT generator — the transport live [G] calls ride ────────────────
// The fix under test (FOC-474): runGStep passes {stepId, step, reads}; the
// default generator now destructures exactly that, resolves the registry
// entry by stepId and rides its prompt — the old code stringified a `state`
// that was never supplied (STATE: undefined) and ignored the registry prompt.

console.log("\nplan-dod: the default generator (registry prompt + event line)");

await test("plan.dod rides the registry prompt, the resolved reads and the strict schema; ONE event line carries the input as sent", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const fetchCalls = [];
    const fetchImpl = async (url, options) => {
      fetchCalls.push({ url, options });
      return okResponse(DOD_OUTPUT);
    };
    const generate = createDefaultGenerator({
      apiKey: "test-key",
      runId: "run-g-test",
      taskKey: "T1",
      shadowDir: dir,
      fetchImpl,
    });
    const output = await generate({ stepId: "plan.dod", step: DOD_STEP, reads: { "inbox.entry": { title: "DoD generator", scope: "runs the plan chain" } } });
    deepEq(output, DOD_OUTPUT, "parsed output returned");

    eq(fetchCalls.length, 1, "ONE fetch call");
    const { url, options } = fetchCalls[0];
    eq(url, "https://openrouter.ai/api/v1/chat/completions", "OpenRouter endpoint");
    eq(options.headers.Authorization, "Bearer test-key", "key from the injected apiKey, never logged");
    const body = JSON.parse(options.body);
    eq(body.model, "z-ai/glm-5.3-flash", "cheap-tier model resolved from config/models.json routing.plan.discovery");
    const message = body.messages[0].content;
    if (!message.includes("You generate the Definition of Done for one planning inbox entry")) fail("the REGISTRY PROMPT is on the wire (the fix)");
    if (!message.includes('Produce the "plan.dod" step output')) fail("the step ask names the step id");
    if (!message.includes("- inbox.entry: {\"title\":\"DoD generator\",\"scope\":\"runs the plan chain\"}")) fail("the RESOLVED reads are the inputs (never STATE:undefined)");
    if (/STATE:/.test(message)) fail("no state dump — the declared reads only");
    deepEq(body.response_format, { type: "json_schema", json_schema: { name: "plan.dod", strict: true, schema: DOD_STEP.output } }, "strict json_schema with the step's output schema");
    deepEq(body.usage, { include: true }, "usage requested — cost honesty");
    if (!(options.signal instanceof AbortSignal)) fail("an abort signal bounds the call");

    // The FOC-449 event line — one, complete, scrubbed.
    const lines = readLines(join(dir, "decisions.jsonl"));
    eq(lines.length, 1, "exactly one event line");
    const line = lines[0];
    eq(line.type, SHADOW_EVENT_TYPE, "type event");
    eq(line.runId, "run-g-test", "runId keys the line to the run");
    eq(line.taskKey, "T1", "taskKey joins the issue");
    eq(line.decisionId, "plan.dod", "decisionId = stepId");
    eq(line.criteriaVersion, REGISTRY.criteriaVersion, "criteriaVersion from the entry");
    eq(line.tier, "cheap", "cheap tier on the line");
    eq(line.mode, "live", "live mode");
    eq(line.ok, true, "ok");
    eq(line.pinnedModel, null, "no pinned model — a [G] call is not a seam call");
    eq(line.model, "z-ai/glm-5.3-flash", "served model");
    deepEq(line.answers, DOD_OUTPUT, "answers = parsed output");
    eq(line.confidence, null, "no confidence claim");
    eq(line.formatConfidence, null, "no format confidence");
    deepEq(line.usage, { inputTokens: 123, outputTokens: 45, cost: 0.000045 }, "usage normalized");
    eq(line.responseId, "resp-plan-dod-test", "response id");
    deepEq(line.error, null, "no error on success");
    eq(typeof line.eventId, "string", "event id present");
    if (line.eventId.length < 10) fail("event id looks like a UUID");
    if (!/^[0-9a-f]{64}$/.test(line.hash)) fail("hash is a sha256 hex string");
    eq(line.input.questions, null, "questions null — a [G] generation sends no question set");
    if (typeof line.input.state !== "string" || !line.input.state.includes("You generate the Definition of Done")) fail("the scrubbed input-as-sent carries the prompt");
    if (!line.input.state.includes('"title":"DoD generator"')) fail("the scrubbed input carries the resolved read");
    deepEq(line.scrub, { variant: "mask-only", redacted: false, note: line.scrub.note }, "scrub provenance, unredacted");
    if (!line.scrub.note.includes("mask-only")) fail("the scrub note names the variant");
    eq(typeof line.durationMs, "number", "latency recorded");
    eq(typeof line.ts, "string", "timestamp recorded");
  } finally {
    cleanup();
  }
});

await test("plan.ac rides the same generator: its own registry prompt, its reads, its schema — and its own event line", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const fetchCalls = [];
    const fetchImpl = async (url, options) => {
      fetchCalls.push({ options });
      return okResponse(AC_OUTPUT);
    };
    const generate = createDefaultGenerator({ apiKey: "test-key", runId: "run-g-test", taskKey: "T1", shadowDir: dir, fetchImpl });
    const output = await generate({ stepId: "plan.ac", step: AC_STEP, reads: { "inbox.entry": "the dictated entry", "features.list": [{ name: "f1" }] } });
    deepEq(output, AC_OUTPUT, "parsed output returned");

    const body = JSON.parse(fetchCalls[0].options.body);
    const message = body.messages[0].content;
    if (!message.includes("You generate acceptance criteria and a definition of done for one planning inbox entry")) fail("plan.ac's REGISTRY PROMPT is on the wire (FOC-475 inherits the fixed transport)");
    if (!message.includes('- inbox.entry: "the dictated entry"') || !message.includes("- features.list: ")) fail("both declared reads reach the message");
    deepEq(body.response_format, { type: "json_schema", json_schema: { name: "plan.ac", strict: true, schema: AC_STEP.output } }, "plan.ac's schema");

    const lines = readLines(join(dir, "decisions.jsonl"));
    eq(lines.length, 1, "one event line");
    eq(lines[0].decisionId, "plan.ac", "decisionId = plan.ac");
  } finally {
    cleanup();
  }
});

console.log("\nplan-dod: the default generator fails closed (no event line, ever)");

await test("an HTTP failure throws provider_error and appends NOTHING to decisions.jsonl", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });
    const generate = createDefaultGenerator({ apiKey: "test-key", runId: "r", taskKey: "T", shadowDir: dir, fetchImpl });
    let err;
    try {
      await generate({ stepId: "plan.dod", step: DOD_STEP, reads: { "inbox.entry": "x" } });
      fail("must throw");
    } catch (e) {
      err = e;
    }
    eqCode(err, "provider_error", "typed provider_error");
    eq(existsSync(join(dir, "decisions.jsonl")), false, "no event line may exist for a failed call");
  } finally {
    cleanup();
  }
});

await test("a network failure throws provider_error and appends NOTHING", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const fetchImpl = async () => { throw new Error("ECONNRESET"); };
    const generate = createDefaultGenerator({ apiKey: "test-key", runId: "r", taskKey: "T", shadowDir: dir, fetchImpl });
    let err;
    try {
      await generate({ stepId: "plan.dod", step: DOD_STEP, reads: { "inbox.entry": "x" } });
      fail("must throw");
    } catch (e) {
      err = e;
    }
    eqCode(err, "provider_error", "typed provider_error");
    eq(existsSync(join(dir, "decisions.jsonl")), false, "no event line");
  } finally {
    cleanup();
  }
});

await test("a timed-out request is provider_error — never 'response is not JSON' — and appends NOTHING", async () => {
  const { dir, cleanup } = tempDir();
  try {
    // The abort can fire while the body streams (measured on the eval's first
    // pass): the read's rejection carries the abort shape.
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "AbortError" });
      },
    });
    const generate = createDefaultGenerator({ apiKey: "test-key", runId: "r", taskKey: "T", shadowDir: dir, fetchImpl, timeoutMs: 50 });
    let err;
    try {
      await generate({ stepId: "plan.dod", step: DOD_STEP, reads: { "inbox.entry": "x" } });
      fail("must throw");
    } catch (e) {
      err = e;
    }
    eqCode(err, "provider_error", "a timeout is a provider failure");
    if (!err.message.includes("timed out")) fail(`the message names the timeout: ${err.message}`);
    eq(existsSync(join(dir, "decisions.jsonl")), false, "no event line");
  } finally {
    cleanup();
  }
});

await test("unparseable content throws unparseable_output and appends NOTHING", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const fetchImpl = async () => okResponse("this is not JSON");
    const generate = createDefaultGenerator({ apiKey: "test-key", runId: "r", taskKey: "T", shadowDir: dir, fetchImpl });
    let err;
    try {
      await generate({ stepId: "plan.dod", step: DOD_STEP, reads: { "inbox.entry": "x" } });
      fail("must throw");
    } catch (e) {
      err = e;
    }
    eqCode(err, "unparseable_output", "typed unparseable_output");
    eq(existsSync(join(dir, "decisions.jsonl")), false, "no event line — no fabricated answers");
  } finally {
    cleanup();
  }
});

await test("a response with no message content throws unparseable_output and appends NOTHING", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: {} }] }) });
    const generate = createDefaultGenerator({ apiKey: "test-key", runId: "r", taskKey: "T", shadowDir: dir, fetchImpl });
    let err;
    try {
      await generate({ stepId: "plan.dod", step: DOD_STEP, reads: { "inbox.entry": "x" } });
      fail("must throw");
    } catch (e) {
      err = e;
    }
    eqCode(err, "unparseable_output", "typed unparseable_output");
    eq(existsSync(join(dir, "decisions.jsonl")), false, "no event line");
  } finally {
    cleanup();
  }
});

await test("no apiKey fails closed before any fetch; an unknown stepId fails on the registry lookup", async () => {
  const { dir, cleanup } = tempDir();
  try {
    let fetched = 0;
    const fetchImpl = async () => { fetched++; return okResponse(DOD_OUTPUT); };
    const noKey = createDefaultGenerator({ runId: "r", taskKey: "T", shadowDir: dir, fetchImpl });
    let err;
    try {
      await noKey({ stepId: "plan.dod", step: DOD_STEP, reads: { "inbox.entry": "x" } });
      fail("must throw");
    } catch (e) {
      err = e;
    }
    eqCode(err, "auth_missing", "typed auth_missing");
    eq(fetched, 0, "no fetch without a key");

    const unknown = createDefaultGenerator({ apiKey: "test-key", runId: "r", taskKey: "T", shadowDir: dir, fetchImpl });
    try {
      await unknown({ stepId: "plan.nope", step: DOD_STEP, reads: { "inbox.entry": "x" } });
      fail("must throw");
    } catch (e) {
      eqCode(e, "invalid_input", "unknown stepId → typed invalid_input from the registry");
    }
    eq(fetched, 0, "never a guessed message on the wire");
    eq(existsSync(join(dir, "decisions.jsonl")), false, "no event line");
  } finally {
    cleanup();
  }
});

await test("the event line's input-as-sent is mask-only scrubbed — a key-shaped read never reaches .state raw", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const secret = "sk-or-v1-abcdefghijklmnopqrst";
    const fetchImpl = async () => okResponse(DOD_OUTPUT);
    const generate = createDefaultGenerator({ apiKey: "test-key", runId: "r", taskKey: "T", shadowDir: dir, fetchImpl });
    await generate({ stepId: "plan.dod", step: DOD_STEP, reads: { "inbox.entry": `entry with key=${secret} inside` } });
    const line = readLines(join(dir, "decisions.jsonl"))[0];
    if (line.input.state.includes(secret)) fail("the raw key leaked into the event line");
    if (!line.input.state.includes("[REDACTED]")) fail("the key shape was masked");
  } finally {
    cleanup();
  }
});

// ── both ledgers (integration): the run record AND the I/O log event line ────

console.log("\nplan-dod: both ledgers (integration)");

await test("a real runner + the default generator: the graph-steps done record AND the decisions.jsonl event line, keyed to the same run", async () => {
  const d = mkdtempSync(join(tmpdir(), "plan-dod-test-"));
  const storePath = join(d, "graph-steps.jsonl");
  const shadowDir = join(d, "shadow");
  try {
    seedPlanDor(storePath);
    // The default generator rides the real registry prompt per call; the
    // stubbed fetch answers plan.dod then plan.ac.
    let calls = 0;
    const generator = createDefaultGenerator({
      apiKey: "test-key",
      runId: "run-both-ledgers",
      shadowDir, // no taskKey — the runner composes its own provenance
      fetchImpl: async () => {
        calls++;
        return okResponse(calls === 1 ? DOD_OUTPUT : AC_OUTPUT);
      },
    });
    const runner = makeRunner({ generator, storePath });
    const result = await runner.run({ inputs: RUN_INPUTS });
    eq(result.stepId, "plan.spec", "the [G]s executed; run stopped at the [A] hand-off");
    eq(calls, 2, "both [G] calls went through the default generator");

    // Ledger 1 — the run record store.
    const records = readLines(storePath);
    const dodDone = records.find((r) => r.key === "plan.dod" && r.status === "done");
    if (!dodDone) fail("no done record for plan.dod in graph-steps.jsonl");
    deepEq(dodDone.output, DOD_OUTPUT, "the validated output in the run record");

    // Ledger 2 — the I/O log: one event line per successful [G] call.
    const events = readLines(join(shadowDir, "decisions.jsonl"));
    eq(events.length, 2, "two event lines (plan.dod, plan.ac)");
    eq(events.map((e) => e.decisionId).sort().join(","), "plan.ac,plan.dod", "both steps logged");
    eq(events[0].runId, "run-both-ledgers", "the event line keys to the run");
    if (!events.every((e) => e.ok === true && e.type === "event")) fail("served event lines only");
    const dodEvent = events.find((e) => e.decisionId === "plan.dod");
    deepEq(dodEvent.answers, DOD_OUTPUT, "the answers in the I/O log match the run record's output");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

// ── the eval harness input partition (committed fixture) ─────────────────────

console.log("\nplan-dod: the eval harness input partition");

await test("buildInputs on the committed fixture: 12 rows, 11 with ground truth, FOC-406 reported UNKNOWN", () => {
  const fixture = JSON.parse(readFileSync(join(__dir, "plan-dod-eval-fixture.json"), "utf8"));
  eq(fixture.issues.length, 12, "12 fixture issues");
  const built = fixture.issues.map(buildInputs);
  eq(built.length, 12, "every row builds");
  const noGt = built.filter((b) => !b.hasGroundTruth);
  deepEq(noGt.map((b) => b.id), ["FOC-406"], "FOC-406 carries no approved DoD — no ground truth");
  if (noGt[0].dodGroundTruth !== null) fail("no ground truth means null, not an empty string");
  for (const b of built.filter((x) => x.hasGroundTruth)) {
    if (!b.dodGroundTruth || b.dodGroundTruth.length < 20) fail(`${b.id}: ground truth implausibly short`);
    if (!b.scopeSummary) fail(`${b.id}: empty scope summary`);
  }
  // All three DoD shapes extract: heading (FOC-416), **Definition of done:** (FOC-441), **DoD:** (FOC-443).
  const f416 = built.find((b) => b.id === "FOC-416");
  if (!f416.dodGroundTruth.includes("One commit on the candidate branch")) fail("heading-form ground truth (FOC-416)");
  const f441 = built.find((b) => b.id === "FOC-441");
  if (!f441.dodGroundTruth.includes("One commit: `docs(mcp)")) fail("inline **Definition of done:** form (FOC-441)");
  const f443 = built.find((b) => b.id === "FOC-443");
  if (!f443.dodGroundTruth.includes("one commit `fix(mcp)")) fail("inline **DoD:** form (FOC-443)");
});

await test("the ground truth never enters the inputs: no DoD line, no roadmap metadata in any scope summary", () => {
  const fixture = JSON.parse(readFileSync(join(__dir, "plan-dod-eval-fixture.json"), "utf8"));
  for (const issue of fixture.issues) {
    const b = buildInputs(issue);
    if (/fenix-roadmap/i.test(b.scopeSummary)) fail(`${b.id}: roadmap metadata leaked into the scope summary`);
    if (!b.hasGroundTruth) continue;
    const gtLines = b.dodGroundTruth.split("\n").map((s) => s.trim()).filter((s) => s.length > 25);
    const leaked = gtLines.filter((l) => b.scopeSummary.includes(l));
    if (leaked.length) fail(`${b.id}: ${leaked.length} ground-truth line(s) present in the scope summary`);
  }
});

await test("buildInputs rejects malformed fixture rows (the fixture is external input)", () => {
  for (const [row, why] of [
    [null, "non-object"],
    [{ title: "t", description: "d" }, "missing id"],
    [{ id: "X", description: "d" }, "missing title"],
    [{ id: "X", title: "t" }, "missing description"],
  ]) {
    let threw = false;
    try {
      buildInputs(row);
    } catch (err) {
      threw = err instanceof TypeError;
    }
    if (!threw) fail(`a malformed row (${why}) must throw TypeError`);
  }
});

await test("runAll offline: rows, schema validity, the UNKNOWN note, usage joined from the event lines — with a stubbed fetch", async () => {
  const { dir, cleanup } = tempDir("plan-dod-eval-test-");
  try {
    const issues = [
      { id: "FOC-T1", title: "heading form", description: "Scope: build it.\n\n## Definition of Done\n\n- suite green\n- lint 0" },
      { id: "FOC-T2", title: "no ground truth", description: "Scope: build the other thing. Parent epic: FOC-380." },
    ];
    const summary = await runAll({
      issues,
      outDir: dir,
      apiKey: "test-key",
      runId: "eval-test",
      fetchImpl: async () => okResponse(DOD_OUTPUT),
    });
    eq(summary.issues, 2, "both rows ran");
    eq(summary.ok, 2, "both calls served");
    eq(summary.schemaValid, 2, "both outputs schema-valid");
    deepEq(summary.noGroundTruth, ["FOC-T2"], "FOC-T2 reported UNKNOWN");
    eq(summary.totalInputTokens, 246, "tokens joined from the event lines (2 × 123)");
    eq(summary.totalOutputTokens, 90, "output tokens joined (2 × 45)");
    if (!(summary.totalCostUsd > 0)) fail("cost metered");
    deepEq(summary.model, ["z-ai/glm-5.3-flash"], "the model that actually served");

    const rows = readLines(join(dir, "outputs.jsonl"));
    eq(rows.length, 2, "one outputs row per issue");
    eq(rows[0].hasGroundTruth, true, "row 1 has ground truth");
    eq(rows[0].dodGroundTruth.includes("suite green"), true, "row 1's ground truth extracted");
    if (!rows[0].scopeSummary.includes("Scope: build it.")) fail("row 1's scope summary built");
    eq(rows[1].hasGroundTruth, false, "row 2 has no ground truth");
    if (!String(rows[1].note).includes("UNKNOWN")) fail("the no-ground-truth note says UNKNOWN");
    if (rows[0].usage?.inputTokens !== 123) fail("usage joined onto the row");
    if (rows[0].schemaValid !== true) fail("schema validity measured");

    eq(existsSync(join(dir, "summary.json")), true, "summary.json written");
    eq(existsSync(join(dir, "table.txt")), true, "table.txt written");
    const events = readLines(join(dir, "eval-test", "decisions.jsonl"));
    eq(events.length, 2, "the FOC-449 event lines exist too (the eval rides the same ledger)");
    deepEq(events.map((e) => e.taskKey).sort(), ["FOC-T1", "FOC-T2"], "event lines keyed by issue id");

    const one = await runAll({ issues, outDir: join(dir, "limit"), apiKey: "test-key", runId: "l", fetchImpl: async () => okResponse(DOD_OUTPUT), limit: 1 });
    eq(one.issues, 1, "limit honored");
  } finally {
    cleanup();
  }
});

// ── tail ─────────────────────────────────────────────────────────────────────

console.log(`\nplan-dod: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("  FAILED: " + failures.join(" | "));
  process.exit(1);
}
