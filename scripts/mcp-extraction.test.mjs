// scripts/mcp-extraction.test.mjs — FOC-401: the extraction decision server.
//
// Covers the fail-closed contract end to end: input/output schema accept and
// reject cases, the deterministic candidate split, typed error codes for
// provider failures, and the confidence rule (ADR-0012 D3.6 — measured
// sources only, otherwise null). The tier-1 Jev path is exercised through an
// injected fetch stub — these tests never touch the network.
//
// Run: node scripts/mcp-extraction.test.mjs

import Ajv from "ajv";
import { runDecision, TypedError } from "./mcp/envelope.mjs";
import { EXTRACTION_STEP, splitCandidates } from "./mcp/steps.mjs";
import { createOfflineProvider } from "./mcp/provider-offline.mjs";
import { createJevProvider, probabilityOf, choiceOf } from "./mcp/provider-jev.mjs";
import { createExtractionServer } from "./mcp/server-extraction.mjs";

// Hermetic by construction: the launcher env carries LA_RUN_ID (the telemetry
// gate in mcp/envelope.mjs), and a test run must never write telemetry. The
// read happens at call time, so closing the gate here — before any decision
// call — is enough.
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
const validateOutput = (data) => ajv.compile(EXTRACTION_STEP.outputSchema)(data);
const offline = createOfflineProvider(EXTRACTION_STEP);
const run = (input, provider = offline) => runDecision(EXTRACTION_STEP, input, { provider });

console.log("\nextraction: input schema");

await test("accepts a valid dictated input", async () => {
  const envelope = await run({ text: "kif i czeryf", language: "pl" });
  if (envelope.ok !== true) fail("expected ok, got " + JSON.stringify(envelope));
});

await test("rejects an empty text with invalid_input and no decision", async () => {
  const envelope = await run({ text: "" });
  if (envelope.ok !== false) fail("expected ok:false");
  if (envelope.error.code !== "invalid_input") fail("code: " + envelope.error.code);
  if ("decision" in envelope) fail("a failed call must not carry a decision");
});

await test("rejects unknown properties and wrong types", async () => {
  const envelope = await run({ text: "x", sneaky: true });
  if (envelope.error?.code !== "invalid_input") fail("unknown property accepted");
  const envelope2 = await run({ text: 42 });
  if (envelope2.error?.code !== "invalid_input") fail("wrong type accepted");
});

await test("error messages carry schema paths, never input values", async () => {
  const envelope = await run({ text: "SECRET-USER-CONTENT", language: "de" });
  if (envelope.error?.code !== "invalid_input") fail("expected invalid_input");
  if (envelope.error.message.includes("SECRET-USER-CONTENT")) fail("error message leaks input content");
});

console.log("\nextraction: deterministic split ([D] part)");

await test("splitCandidates splits the corrupted-dictation sample", () => {
  const candidates = splitCandidates("kif i czeryf");
  if (JSON.stringify(candidates) !== JSON.stringify(["kif", "czeryf"])) fail("got " + JSON.stringify(candidates));
});

await test("splitCandidates is deterministic and capped at 12", () => {
  const text = Array.from({ length: 30 }, (_, i) => "feature " + i).join(", ");
  const first = splitCandidates(text);
  const second = splitCandidates(text);
  if (JSON.stringify(first) !== JSON.stringify(second)) fail("not deterministic");
  if (first.length !== 12) fail("cap: " + first.length);
});

console.log("\nextraction: offline path (no model call)");

await test("returns candidates as unverified features with confidence null", async () => {
  const envelope = await run({ text: "kif i czeryf" });
  if (envelope.mode !== "offline") fail("mode: " + envelope.mode);
  if (envelope.tier !== null || envelope.model !== null) fail("offline must carry tier/model null");
  if (envelope.confidence !== null) fail("offline confidence must be null (measured sources only)");
  const names = envelope.decision.features.map((f) => f.name);
  if (JSON.stringify(names) !== JSON.stringify(["kif", "czeryf"])) fail("features: " + JSON.stringify(names));
  if (!validateOutput(envelope.decision)) fail("offline decision violates the output schema");
  if (typeof envelope.measuredAt !== "string" || !/\d{4}-\d{2}-\d{2}T/.test(envelope.measuredAt)) fail("measuredAt not ISO");
  if (typeof envelope.durationMs !== "number") fail("durationMs missing");
});

console.log("\nextraction: fail-closed on provider failures");

await test("provider_error → typed error, nothing partial", async () => {
  const provider = { decide: async () => { throw new TypedError("provider_error", "HTTP 500"); } };
  const envelope = await run({ text: "kif i czeryf" }, provider);
  if (envelope.ok !== false || envelope.error.code !== "provider_error") fail(JSON.stringify(envelope));
  if ("decision" in envelope || "features" in envelope) fail("partial data leaked");
});

await test("unexpected provider crash → provider_error, not a degrade", async () => {
  const provider = { decide: async () => { throw new Error("boom"); } };
  const envelope = await run({ text: "kif i czeryf" }, provider);
  if (envelope.error?.code !== "provider_error") fail("code: " + envelope.error?.code);
});

await test("non-object provider decision → unparseable_output", async () => {
  const provider = { decide: async () => ({ decision: "free-form model prose", confidence: 0.9 }) };
  const envelope = await run({ text: "kif i czeryf" }, provider);
  if (envelope.error?.code !== "unparseable_output") fail("code: " + envelope.error?.code);
  if (envelope.error.message.includes("free-form")) fail("error message leaks provider content");
});

await test("schema-invalid decision → schema_invalid, nothing leaks", async () => {
  const provider = {
    decide: async () => ({
      decision: { features: "not-an-array", hugeBlob: "x".repeat(500) },
      confidence: 0.99,
    }),
  };
  const envelope = await run({ text: "kif i czeryf" }, provider);
  if (envelope.error?.code !== "schema_invalid") fail("code: " + envelope.error?.code);
  if ("decision" in envelope) fail("partial decision leaked");
  if (envelope.error.message.includes("xxx")) fail("error message leaks data");
});

await test("confidence outside [0,1] normalizes to null, never fabricated", async () => {
  const provider = {
    decide: async () => ({
      decision: { features: [{ name: "kif", kind: "feature", confidence: null }], notes: null },
      confidence: "pretty sure",
    }),
  };
  const envelope = await run({ text: "kif" }, provider);
  if (envelope.confidence !== null) fail("confidence: " + envelope.confidence);
});

console.log("\nextraction: tier-1 Jev provider (injected fetch, no network)");

await test("missing OPENROUTER_API_KEY → auth_missing without a fetch", async () => {
  let fetched = 0;
  const provider = createJevProvider({ apiKey: undefined, fetchImpl: async () => { fetched++; return { ok: true }; } });
  const envelope = await run({ text: "kif" }, provider);
  if (envelope.error?.code !== "auth_missing") fail("code: " + envelope.error?.code);
  if (fetched !== 0) fail("fetch called without a key");
});

await test("HTTP 500 → provider_error carrying only the status", async () => {
  const provider = createJevProvider({ apiKey: "k", fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
  const envelope = await run({ text: "kif i czeryf" }, provider);
  if (envelope.error?.code !== "provider_error") fail("code: " + envelope.error?.code);
  if (!envelope.error.message.includes("500")) fail("status missing from message");
});

await test("non-JSON body → unparseable_output", async () => {
  const provider = createJevProvider({ apiKey: "k", fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error("invalid json"); } }) });
  const envelope = await run({ text: "kif" }, provider);
  if (envelope.error?.code !== "unparseable_output") fail("code: " + envelope.error?.code);
});

await test("valid decisions response → measured features + measured confidence", async () => {
  // Response shape measured live (2026-09-19): answers is a record keyed by
  // question id, noul probability in the `noul` field; the response names the
  // resolved model build.
  const provider = createJevProvider({
    apiKey: "k",
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      if (!body.model.includes("jev")) fail("model not pinned: " + body.model);
      if (body.state.includes("apiKey")) fail("bad request shape");
      if (Array.isArray(body.questions) || Object.keys(body.questions).length !== 2) fail("questions must be a record of 2");
      if (Object.keys(body.questions.q0.criteria).join() !== "true,false") fail("noul criteria labels: " + JSON.stringify(body.questions.q0.criteria));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: "typesafe/jev-1.13-20260917",
          answers: { q0: { type: "noul", noul: 0.93 }, q1: { type: "noul", noul: 0.41 } },
        }),
      };
    },
  });
  const envelope = await run({ text: "kif i czeryf" }, provider);
  if (envelope.ok !== true) fail("expected ok, got " + JSON.stringify(envelope));
  if (envelope.mode !== "live" || envelope.tier !== 1) fail("meta: " + JSON.stringify(envelope));
  if (envelope.model !== "typesafe/jev-1.13-20260917") fail("resolved build not carried: " + envelope.model);
  // Certainty of the verdict, not probability of "true": the accepted answer
  // (0.93) carries certainty 0.93, the rejected one (0.41) carries certainty
  // 1−0.41 = 0.59; the envelope aggregates min over those = 0.59. A raw min
  // over p would report the rejection's probability-of-wrongness (0.41) — the
  // inverted semantics fixed in FOC-401 review round 1.
  // 1−0.41 is 0.5900000000000001 in IEEE 754 — compare with a tolerance.
  if (Math.abs(envelope.confidence - 0.59) > 1e-9) fail("confidence should be min(max(p,1-p)): " + envelope.confidence);
  const names = envelope.decision.features.map((f) => f.name);
  // p=0.93 > 0.5 → in; p=0.41 <= 0.5 → out (coin-flip reading, not a calibrated threshold)
  if (JSON.stringify(names) !== JSON.stringify(["kif"])) fail("features: " + JSON.stringify(names));
  if (!validateOutput(envelope.decision)) fail("live decision violates the output schema");
});

await test("answers with no numeric noul probability → unparseable_output", async () => {
  const provider = createJevProvider({
    apiKey: "k",
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ answers: { q0: { type: "noul", note: "probably yes" } } }) }),
  });
  const envelope = await run({ text: "kif" }, provider);
  if (envelope.error?.code !== "unparseable_output") fail("code: " + envelope.error?.code);
});

await test("old-shape array answers (measured dead 2026-09-19) → unparseable_output", async () => {
  // GAPS §2.3 recorded answers as an array on the morning of 2026-09-19; the
  // live endpoint now rejects that request shape with 400 and returns records.
  // The old shape must fail closed, never be coerced.
  const provider = createJevProvider({
    apiKey: "k",
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ answers: [{ noul: 0.9 }] }) }),
  });
  const envelope = await run({ text: "kif" }, provider);
  if (envelope.error?.code !== "unparseable_output") fail("code: " + envelope.error?.code);
});

await test("strict parsers: probabilityOf/choiceOf never fabricate", () => {
  if (probabilityOf({ noul: 1.2 }) !== null) fail("out-of-range probability accepted");
  if (probabilityOf({ noul: "0.9" }) !== null) fail("non-numeric probability accepted");
  if (probabilityOf({}) !== null) fail("absent probability fabricated");
  if (choiceOf({ probabilities: { medium: 0.7, large: 0.2 } }, ["small", "medium", "large"]) !== "medium") fail("argmax fallback");
  if (choiceOf({ choice: "banana" }, ["small", "medium", "large"]) !== null) fail("unknown label accepted");
});

console.log("\nextraction: MCP tools/call surface");

await test("valid call round-trips an ok envelope", async () => {
  const server = createExtractionServer({});
  const response = await server.handleMessage({
    jsonrpc: "2.0", id: 7, method: "tools/call",
    params: { name: "extract_features", arguments: { text: "kif i czeryf" } },
  });
  if (response.result.isError === true) fail("isError on a valid call");
  const envelope = JSON.parse(response.result.content[0].text);
  if (envelope.ok !== true || !Array.isArray(envelope.decision.features)) fail("envelope: " + response.result.content[0].text.slice(0, 80));
});

await test("invalid arguments → isError:true carrying the typed code", async () => {
  const server = createExtractionServer({});
  const response = await server.handleMessage({
    jsonrpc: "2.0", id: 8, method: "tools/call",
    params: { name: "extract_features", arguments: { text: "" } },
  });
  if (response.result.isError !== true) fail("fail-closed must be isError:true");
  const envelope = JSON.parse(response.result.content[0].text);
  if (envelope.ok !== false || envelope.error.code !== "invalid_input") fail("envelope: " + JSON.stringify(envelope));
});

await test("unknown tool → JSON-RPC error -32602", async () => {
  const server = createExtractionServer({});
  const response = await server.handleMessage({
    jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "nope", arguments: {} },
  });
  if (response.error?.code !== -32602) fail("code: " + response.error?.code);
});

console.log("\n" + passed + " passed.");
if (failures.length > 0) {
  console.error(failures.length + " test(s) failed.");
  process.exit(1);
}
