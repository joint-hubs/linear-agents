// scripts/mcp-prompt-refinement.test.mjs — FOC-401: the prompt refinement
// decision server. Covers the size→squads routing map ([D] half of the
// ADR-0009 amendment), schema accept/reject, fail-closed typed errors, the
// measured-confidence rule, and the tier-1 Jev mapping through an injected
// fetch stub — these tests never touch the network.
//
// Run: node scripts/mcp-prompt-refinement.test.mjs

import Ajv from "ajv";
import { runDecision } from "./mcp/envelope.mjs";
import { PROMPT_REFINEMENT_STEP, squadsForSize } from "./mcp/steps.mjs";
import { createOfflineProvider } from "./mcp/provider-offline.mjs";
import { createJevProvider } from "./mcp/provider-jev.mjs";
import { createPromptRefinementServer } from "./mcp/server-prompt-refinement.mjs";

// Hermetic by construction: close the LA_RUN_ID telemetry gate before any
// decision call (see mcp-extraction.test.mjs).
delete process.env.LA_RUN_ID;

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
const ajv = new Ajv({ allErrors: false });
const validateOutput = (data) => ajv.compile(PROMPT_REFINEMENT_STEP.outputSchema)(data);
const offline = createOfflineProvider(PROMPT_REFINEMENT_STEP);
const run = (input, provider = offline) => runDecision(PROMPT_REFINEMENT_STEP, input, { provider });
const VALID_INPUT = { prompt: "DEV implementer: add the snapshot export.", features: [{ name: "snapshot export" }, { name: "date range picker" }] };

console.log("\nprompt-refinement: size → squads routing ([D] half)");

await test("small → no squads (supervisor solo, ADR-0009 amendment)", () => {
  if (JSON.stringify(squadsForSize("small")) !== "[]") fail("small: " + JSON.stringify(squadsForSize("small")));
});
await test("medium → DEV + TEST", () => {
  if (JSON.stringify(squadsForSize("medium")) !== JSON.stringify(["dev", "test"])) fail("medium routing");
});
await test("large → full triage PLAN → DEV → REVIEW → TEST", () => {
  if (JSON.stringify(squadsForSize("large")) !== JSON.stringify(["plan", "dev", "review", "test"])) fail("large routing");
});
await test("unknown size routes to nothing (never a guess)", () => {
  if (JSON.stringify(squadsForSize("huge")) !== "[]") fail("unknown size routed somewhere");
});

console.log("\nprompt-refinement: input schema");

await test("accepts a valid prompt + features", async () => {
  const envelope = await run(VALID_INPUT);
  if (envelope.ok !== true) fail("expected ok, got " + JSON.stringify(envelope));
});

await test("rejects a missing prompt, >8 features, unknown properties", async () => {
  if ((await run({ features: [] })).error?.code !== "invalid_input") fail("missing prompt accepted");
  const many = Array.from({ length: 9 }, (_, i) => ({ name: "f" + i }));
  if ((await run({ prompt: "p", features: many })).error?.code !== "invalid_input") fail(">8 features accepted");
  if ((await run({ prompt: "p", extra: 1 })).error?.code !== "invalid_input") fail("unknown property accepted");
});

console.log("\nprompt-refinement: offline path (no model call)");

await test("static sample passes the output schema with confidence null", async () => {
  const envelope = await run(VALID_INPUT);
  if (envelope.mode !== "offline") fail("mode: " + envelope.mode);
  if (envelope.confidence !== null) fail("offline confidence must be null");
  if (!validateOutput(envelope.decision)) fail("offline sample violates the output schema");
  if (envelope.decision.size !== "medium") fail("sample size: " + envelope.decision.size);
  if (JSON.stringify(envelope.decision.squads) !== JSON.stringify(["dev", "test"])) fail("sample squads");
  if (envelope.decision.rationale !== null) fail("rationale must stay null offline");
});

console.log("\nprompt-refinement: fail-closed on provider failures");

await test("provider_error → typed error, nothing partial", async () => {
  const provider = { decide: async () => { throw new Error("socket hang up"); } };
  const envelope = await run(VALID_INPUT, provider);
  if (envelope.error?.code !== "provider_error") fail("code: " + envelope.error?.code);
  if ("decision" in envelope) fail("partial data leaked");
});

await test("schema-invalid decision → schema_invalid", async () => {
  const provider = { decide: async () => ({ decision: { size: "gigantic", squads: [] }, confidence: 0.9 }) };
  const envelope = await run(VALID_INPUT, provider);
  if (envelope.error?.code !== "schema_invalid") fail("code: " + envelope.error?.code);
});

console.log("\nprompt-refinement: tier-1 Jev provider (injected fetch, no network)");

// Response shape measured live (2026-09-19): answers is a RECORD keyed by the
// question ids ("size", "rel0", ...) — choice answers carry the chosen label,
// a native probabilities distribution and a confidence.
function jevStub(answers) {
  return createJevProvider({
    apiKey: "k",
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body.model !== "typesafe/jev-1.13") fail("model not pinned: " + body.model);
      if (!body.state.includes(VALID_INPUT.prompt)) fail("prompt missing from state");
      if (Array.isArray(body.questions)) fail("questions must be a record (measured contract)");
      if (Object.keys(body.questions).length !== 3) fail("expected 1 size + 2 relation questions, got " + Object.keys(body.questions).length);
      return { ok: true, status: 200, json: async () => ({ answers }) };
    },
  });
}

await test("measured size + relations → squads derived in code, confidence = min(measured)", async () => {
  const provider = jevStub({
    size: { type: "choice", choice: "medium", confidence: 0.88, probabilities: { small: 0.05, medium: 0.88, large: 0.07 } },
    rel0: { type: "choice", choice: "standalone", confidence: 0.91 },
    rel1: { type: "choice", choice: "extension", confidence: 0.62 },
  });
  const envelope = await run(VALID_INPUT, provider);
  if (envelope.ok !== true) fail("expected ok, got " + JSON.stringify(envelope));
  if (envelope.decision.size !== "medium") fail("size: " + envelope.decision.size);
  if (JSON.stringify(envelope.decision.squads) !== JSON.stringify(["dev", "test"])) fail("squads: " + JSON.stringify(envelope.decision.squads));
  if (envelope.decision.relations[1].relation !== "extension") fail("relations: " + JSON.stringify(envelope.decision.relations));
  if (envelope.confidence !== 0.62) fail("confidence should be min(0.88, 0.91, 0.62): " + envelope.confidence);
  if (!validateOutput(envelope.decision)) fail("live decision violates the output schema");
});

await test("argmax over native probabilities is a valid measured reading", async () => {
  const provider = jevStub({
    size: { type: "choice", probabilities: { small: 0.1, medium: 0.85, large: 0.05 } },
    rel0: { type: "choice", choice: "standalone" },
    rel1: { type: "choice", choice: "standalone" },
  });
  const envelope = await run(VALID_INPUT, provider);
  if (envelope.decision.size !== "medium") fail("argmax size: " + envelope.decision.size);
  if (envelope.confidence !== null) fail("no confidence field in answers → must stay null");
});

await test("answer outside the allowed labels → unparseable_output", async () => {
  const provider = jevStub({
    size: { type: "choice", choice: "galactic", confidence: 0.9 },
    rel0: { type: "choice", choice: "standalone" },
    rel1: { type: "choice", choice: "standalone" },
  });
  const envelope = await run(VALID_INPUT, provider);
  if (envelope.error?.code !== "unparseable_output") fail("code: " + envelope.error?.code);
});

await test("a missing per-feature answer → unparseable_output", async () => {
  const provider = jevStub({ size: { type: "choice", choice: "medium" } });
  const envelope = await run(VALID_INPUT, provider);
  if (envelope.error?.code !== "unparseable_output") fail("code: " + envelope.error?.code);
});

await test("old-shape array answers (measured dead 2026-09-19) → unparseable_output", async () => {
  // GAPS §2.3 recorded answers as an array on the morning of 2026-09-19; the
  // live endpoint now expects a record. The old shape must fail closed.
  const provider = createJevProvider({
    apiKey: "k",
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ answers: [{ choice: "medium" }] }) }),
  });
  const envelope = await run(VALID_INPUT, provider);
  if (envelope.error?.code !== "unparseable_output") fail("code: " + envelope.error?.code);
});

await test("HTTP 401 from the alpha endpoint → provider_error", async () => {
  const provider = createJevProvider({ apiKey: "k", fetchImpl: async () => ({ ok: false, status: 401 }) });
  const envelope = await run(VALID_INPUT, provider);
  if (envelope.error?.code !== "provider_error") fail("code: " + envelope.error?.code);
  if (!envelope.error.message.includes("401")) fail("status missing");
});

console.log("\nprompt-refinement: MCP tools/call surface");

await test("valid call round-trips an ok envelope with size + squads", async () => {
  const server = createPromptRefinementServer({});
  const response = await server.handleMessage({
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "refine_prompt", arguments: VALID_INPUT },
  });
  if (response.result.isError === true) fail("isError on a valid call");
  const envelope = JSON.parse(response.result.content[0].text);
  if (envelope.ok !== true || envelope.decision.size !== "medium") fail("envelope: " + response.result.content[0].text.slice(0, 120));
});

await test("invalid arguments → isError:true carrying invalid_input", async () => {
  const server = createPromptRefinementServer({});
  const response = await server.handleMessage({
    jsonrpc: "2.0", id: 4, method: "tools/call",
    params: { name: "refine_prompt", arguments: { prompt: "" } },
  });
  if (response.result.isError !== true) fail("fail-closed must be isError:true");
  const envelope = JSON.parse(response.result.content[0].text);
  if (envelope.error.code !== "invalid_input") fail("code: " + envelope.error.code);
});

await test("unknown tool → JSON-RPC error -32602", async () => {
  const server = createPromptRefinementServer({});
  const response = await server.handleMessage({
    jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "extract_features", arguments: {} },
  });
  if (response.error?.code !== -32602) fail("this server must not serve another family's tool");
});

console.log("\n" + passed + " passed.");
if (failures.length > 0) {
  console.error(failures.length + " test(s) failed.");
  process.exit(1);
}
