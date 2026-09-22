// scripts/decision-call.test.mjs — FOC-386: the decision-call seam.
//
// Covers the seam contract end to end, all offline: the typed envelope over
// {state, questions}, the pinned-vs-resolved model facts, usage.cost
// metering under the seam's own agent key, retry on 429/5xx at the call
// boundary, the tier-2 chat/completions mechanism (json_schema + logprobs;
// formatConfidence null without a logprob source) exercised through the
// fallbackModel TEST SEAM, the tier-2 DISABLED state (FALLBACK_MODEL = null,
// FOC-473: a tier-1 failure fails closed with zero fallback calls),
// fail-closed exits, the shadow JSONL log and its inputs hash, the full event
// record registry-backed calls gain (FOC-449: eventId, the scrubbed input as
// sent, taskKey, durationMs — inline lines byte-identical), and the
// ADR-0012 drift guard (the shipped FALLBACK_MODEL constant ↔ the ADR quote,
// test-enforced per ADR-0012 D2 as amended). Every HTTP path runs through an
// injected fetch stub — these tests never touch the network.
//
// Run: node scripts/decision-call.test.mjs

import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDecisionCaller, inputsHash, canonicalJson, DECISION_STEP, FALLBACK_MODEL } from "./decision-call.mjs";
import { JEV_MODEL, JEV_ENDPOINT } from "./mcp/provider-jev.mjs";

// The shipped constant (null = tier-2 disabled) and the ADR that must agree
// with it — the drift guard below fails on divergence between the two.
const ADR_0012 = new URL("../docs/adr/0012-decision-shaped-steps-four-kinds.md", import.meta.url);

// Hermetic by construction: the launcher env carries LA_RUN_ID (the telemetry
// and shadow gates read it at call time), and a test run must never write
// telemetry. Closing the gate here — before any decision call — is enough.
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
const eq = (a, b, label) => { if (a !== b) fail(`${label}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };

const NOUL_INPUT = {
  state: "Probe (FOC-386): contract check, single arithmetic noul question.",
  questions: {
    q0: { type: "noul", instructions: "Is 2 greater than 1?", criteria: { true: "the statement is true", false: "the statement is not true" } },
  },
};

// The shape measured live on 2026-09-20 (single-probe contract check).
const PROBE_BODY = {
  model: "typesafe/jev-1.13-20260917",
  answers: { q0: { type: "noul", noul: 0.98 } },
  usage: { input_tokens: 326, output_tokens: 21, cost: 0.000013692 },
  id: "gen-dec-1789892790-qxWjw44sdEJ9Ll9UFQzV",
  provider: "TypeSafe",
};

const jsonResponse = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const statusResponse = (status) => ({ ok: false, status, json: async () => { throw new Error("body read on non-ok"); } });

// The fallbackModel TEST SEAM: production ships FALLBACK_MODEL = null (tier-2
// disabled, FOC-473); tests pass a model string so the dormant chat/
// completions mechanism stays covered without pretending the tier is live.
const SEAM_MODEL = "z-ai/glm-5.3-flash-test-seam";

const fallbackBody = (answers, { logprobs = [{ logprob: -0.1 }, { logprob: -0.2 }], cost = 0.0000021 } = {}) => ({
  model: SEAM_MODEL,
  choices: [{ message: { content: JSON.stringify({ answers }) }, logprobs: { content: logprobs } }],
  usage: { prompt_tokens: 50, completion_tokens: 10, cost },
});

const caller = (fetchImpl, opts = {}) => createDecisionCaller({
  apiKey: "test-key",
  fetchImpl,
  delayFn: async () => {},
  runId: null,
  shadowDir: null,
  meter: () => {},
  ...opts,
});

console.log("\ndecision-call: tier-1 live path (injected fetch, no network)");

await test("serves a probe-shaped tier-1 answer with pinned + resolved model, usage.cost and responseId", async () => {
  const seen = [];
  const envelope = await caller((url, options) => {
    seen.push(url);
    eq(url, JEV_ENDPOINT, "tier-1 endpoint");
    const body = JSON.parse(options.body);
    eq(body.model, JEV_MODEL, "pinned model in request");
    if (Array.isArray(body.questions)) fail("questions must be a record, not an array");
    return jsonResponse(PROBE_BODY);
  })(NOUL_INPUT);
  eq(seen.length, 1, "single HTTP call");
  eq(envelope.ok, true, "ok");
  eq(envelope.tier, 1, "tier");
  eq(envelope.model, "typesafe/jev-1.13-20260917", "resolved build echoed");
  eq(envelope.pinnedModel, JEV_MODEL, "pinned model recorded");
  eq(envelope.mode, "live", "mode");
  eq(envelope.decision.answers.q0.type, "noul", "answer type");
  eq(envelope.decision.answers.q0.noul, 0.98, "native probability");
  eq(envelope.confidence, 0.98, "certainty = max(p, 1-p)");
  eq(envelope.formatConfidence, null, "no format measurement at tier 1");
  eq(envelope.usage.cost, 0.000013692, "usage.cost verbatim");
  eq(envelope.usage.inputTokens, 326, "input tokens");
  eq(envelope.responseId, "gen-dec-1789892790-qxWjw44sdEJ9Ll9UFQzV", "response id");
});

await test("aggregate confidence is the min over per-answer certainty", async () => {
  const input = {
    state: "two questions",
    questions: {
      q0: { type: "noul", instructions: "i", criteria: { true: "t", false: "f" } },
      q1: { type: "choice", instructions: "i", criteria: { small: "s", large: "l" } },
    },
  };
  const impl = async () => jsonResponse({
    model: "typesafe/jev-1.13-20260917",
    answers: {
      q0: { type: "noul", noul: 0.9 },
      q1: { type: "choice", choice: "large", probabilities: { small: 0.1, large: 0.9 }, confidence: 0.8 },
    },
    usage: { input_tokens: 10, output_tokens: 5, cost: 0.000001 },
    id: "gen-2",
  });
  const envelope = await caller(impl)(input);
  eq(envelope.ok, true, "ok");
  eq(envelope.confidence, 0.8, "min(0.9, 0.8)");
});

console.log("\ndecision-call: input validation (fail-closed, before any call)");

await test("rejects a questions array with invalid_input", async () => {
  let calls = 0;
  const envelope = await caller(() => { calls++; return jsonResponse(PROBE_BODY); })({ state: "s", questions: [{ type: "noul", instructions: "i", criteria: { true: "t", false: "f" } }] });
  eq(envelope.ok, false, "ok:false");
  eq(envelope.error.code, "invalid_input", "code");
  eq(calls, 0, "no HTTP call made");
});

await test("rejects a noul question without the true/false criteria", async () => {
  const envelope = await caller(async () => jsonResponse(PROBE_BODY))({ state: "s", questions: { q0: { type: "noul", instructions: "i", criteria: { yes: "y" } } } });
  eq(envelope.ok, false, "ok:false");
  eq(envelope.error.code, "invalid_input", "code");
});

console.log("\ndecision-call: retry at the call boundary (429/5xx only)");

await test("retries a 429 and succeeds without falling back", async () => {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    return calls.length === 1 ? statusResponse(429) : jsonResponse(PROBE_BODY);
  };
  const records = [];
  const envelope = await caller(impl, { meter: (r) => records.push(r) })(NOUL_INPUT);
  eq(envelope.ok, true, "ok");
  eq(envelope.tier, 1, "served at tier 1");
  eq(calls.length, 2, "one retry");
  if (!records.some((r) => r.kind === "retry" && r.status === 429)) fail("retry attempt not metered");
  const served = records.find((r) => r.kind === "served");
  eq(served.agentKey, "decision-call", "own agent key");
  eq(served.endpoint, "decisions", "endpoint");
  eq(served.usage.cost, 0.000013692, "usage.cost on the serving call");
});

await test("does not retry a non-429 4xx", async () => {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    return url === JEV_ENDPOINT ? statusResponse(400) : fallbackOk({ q0: true });
  };
  const envelope = await caller(impl, { fallbackModel: SEAM_MODEL })(NOUL_INPUT);
  eq(envelope.ok, true, "ok (fallback served)");
  eq(envelope.tier, 2, "tier 2");
  eq(calls.filter((u) => u === JEV_ENDPOINT).length, 1, "single tier-1 attempt");
});

console.log("\ndecision-call: tier-2 mechanism via the fallbackModel test seam (chat/completions + json_schema + logprobs)");

function fallbackOk(answers, opts = {}) {
  return jsonResponse(fallbackBody(answers, opts));
}

await test("falls back after exhausted 5xx retries and serves tier 2 via the seam", async () => {
  const tier1Calls = [];
  const impl = async (url) => {
    if (url === JEV_ENDPOINT) { tier1Calls.push(url); return statusResponse(500); }
    return fallbackOk({ q0: true });
  };
  const envelope = await caller(impl, { fallbackModel: SEAM_MODEL })(NOUL_INPUT);
  eq(envelope.ok, true, "ok");
  eq(envelope.tier, 2, "tier 2");
  eq(envelope.model, SEAM_MODEL, "fallback model echoed");
  eq(envelope.decision.answers.q0.noul, 1, "verdict true → noul 1 (encoding, not measurement)");
  eq(envelope.decision.answers.q0.confidence, null, "per-answer confidence null at tier 2");
  eq(envelope.confidence, null, "envelope confidence null at tier 2 (no decision source)");
  eq(envelope.formatConfidence, Math.exp(-0.15), "formatConfidence = exp(mean logprob)");
  eq(envelope.usage.inputTokens, 50, "chat/completions usage normalized");
  eq(tier1Calls.length, 3, "1 + 2 retries before fallback");
});

await test("formatConfidence is null when the fallback returns no logprobs", async () => {
  const impl = async (url) => (url === JEV_ENDPOINT ? statusResponse(500) : fallbackOk({ q0: true }, { logprobs: [] }));
  const envelope = await caller(impl, { fallbackModel: SEAM_MODEL })(NOUL_INPUT);
  eq(envelope.ok, true, "ok");
  eq(envelope.confidence, null, "no decision source at tier 2 → null");
  eq(envelope.formatConfidence, null, "no logprob source → null, never estimated");
});

await test("score and choice questions survive the fallback", async () => {
  const input = {
    state: "mixed",
    questions: {
      q0: { type: "choice", instructions: "i", criteria: { small: "s", large: "l" } },
      q1: { type: "score", instructions: "i", criteria: { low: "l", high: "h" } },
    },
  };
  const impl = async (url) => {
    if (url === JEV_ENDPOINT) return statusResponse(503);
    return fallbackOk({ q0: "large", q1: 7 });
  };
  const envelope = await caller(impl, { fallbackModel: SEAM_MODEL })(input);
  eq(envelope.ok, true, "ok");
  eq(envelope.decision.answers.q0.choice, "large", "choice label");
  eq(envelope.decision.answers.q1.score, 7, "score value");
  eq(envelope.confidence, null, "envelope confidence null at tier 2");
  eq(envelope.formatConfidence, Math.exp(-0.15), "logprobs present → exp(mean logprob)");
});

await test("score and choice questions yield null formatConfidence without logprobs", async () => {
  const input = {
    state: "mixed",
    questions: {
      q0: { type: "choice", instructions: "i", criteria: { small: "s", large: "l" } },
      q1: { type: "score", instructions: "i", criteria: { low: "l", high: "h" } },
    },
  };
  const impl = async (url) => {
    if (url === JEV_ENDPOINT) return statusResponse(503);
    return fallbackOk({ q0: "large", q1: 7 }, { logprobs: [] });
  };
  const envelope = await caller(impl, { fallbackModel: SEAM_MODEL })(input);
  eq(envelope.ok, true, "ok");
  eq(envelope.confidence, null, "no decision source at tier 2 → null");
  eq(envelope.formatConfidence, null, "no logprob source → null, never estimated");
});

await test("a non-JSON fallback answer fails closed with unparseable_output", async () => {
  const impl = async (url) => {
    if (url === JEV_ENDPOINT) return statusResponse(500);
    return jsonResponse({ model: SEAM_MODEL, choices: [{ message: { content: "not json" } }] });
  };
  const envelope = await caller(impl, { fallbackModel: SEAM_MODEL })(NOUL_INPUT);
  eq(envelope.ok, false, "ok:false");
  eq(envelope.error.code, "unparseable_output", "code");
  if (envelope.decision !== undefined) fail("a failed envelope never carries a decision");
});

await test("a tier-1 shape drift (2xx without answers) falls back — the alpha trigger", async () => {
  const impl = async (url) => {
    if (url === JEV_ENDPOINT) return jsonResponse({ unexpected: "shape" });
    return fallbackOk({ q0: false });
  };
  const envelope = await caller(impl, { fallbackModel: SEAM_MODEL })(NOUL_INPUT);
  eq(envelope.ok, true, "ok");
  eq(envelope.tier, 2, "tier 2");
  eq(envelope.decision.answers.q0.noul, 0, "verdict false → noul 0");
});

await test("both tiers down fail closed with provider_error and no decision", async () => {
  const impl = async () => statusResponse(500);
  const envelope = await caller(impl, { fallbackModel: SEAM_MODEL })(NOUL_INPUT);
  eq(envelope.ok, false, "ok:false");
  eq(envelope.error.code, "provider_error", "code");
  if ("decision" in envelope) fail("failed envelope carries no decision");
});

console.log("\ndecision-call: tier-2 disabled (FALLBACK_MODEL = null, FOC-473)");

await test("a tier-1 5xx failure fails closed with the disabled-tier note and zero fallback calls", async () => {
  const calls = [];
  const impl = async (url) => { calls.push(url); return statusResponse(500); };
  const envelope = await caller(impl)(NOUL_INPUT);
  eq(envelope.ok, false, "ok:false");
  eq(envelope.error.code, "provider_error", "code");
  if (!envelope.error.message.includes("tier-2 disabled (FOC-473)")) fail(`must name the disabled tier: ${envelope.error.message}`);
  if (!envelope.error.message.includes("(tier-1: provider_error)")) fail(`must carry the tier-1 cause: ${envelope.error.message}`);
  eq(calls.filter((u) => u !== JEV_ENDPOINT).length, 0, "zero calls off the tier-1 endpoint");
  eq(calls.length, 3, "tier-1 retry budget unchanged (1 + 2 retries)");
});

await test("a tier-1 shape drift fails closed while tier 2 is disabled (no fallback attempt)", async () => {
  let fallbackCalls = 0;
  const impl = async (url) => {
    if (url === JEV_ENDPOINT) return jsonResponse({ unexpected: "shape" });
    fallbackCalls++;
    return fallbackOk({ q0: true });
  };
  const envelope = await caller(impl)(NOUL_INPUT);
  eq(envelope.ok, false, "ok:false");
  eq(envelope.error.code, "provider_error", "code");
  if (!envelope.error.message.includes("(tier-1: unparseable_output)")) fail(`must carry the tier-1 cause: ${envelope.error.message}`);
  eq(fallbackCalls, 0, "the dormant transport is never reached");
});

await test("a tier-1 network error fails closed through the disabled path with a single attempt", async () => {
  let calls = 0;
  const impl = async () => { calls++; throw new Error("connect ECONNREFUSED 127.0.0.1:443"); };
  const envelope = await caller(impl)(NOUL_INPUT);
  eq(envelope.ok, false, "ok:false");
  eq(envelope.error.code, "provider_error", "code");
  if (!envelope.error.message.includes("tier-2 disabled (FOC-473)")) fail(`must name the disabled tier: ${envelope.error.message}`);
  eq(calls, 1, "network errors do not retry and no fallback attempt follows");
});

console.log("\ndecision-call: credentials and secrets");

await test("auth_missing fails closed without a fallback attempt", async () => {
  let calls = 0;
  const impl = async () => { calls++; return jsonResponse(PROBE_BODY); };
  const noKey = createDecisionCaller({ fetchImpl: impl, delayFn: async () => {}, runId: null, shadowDir: null, meter: () => {} });
  const envelope = await noKey(NOUL_INPUT);
  eq(envelope.ok, false, "ok:false");
  eq(envelope.error.code, "auth_missing", "code");
  eq(calls, 0, "no HTTP attempt without credentials");
});

await test("error paths never echo key-shaped material", async () => {
  const leak = "sk-or-v1-0123456789abcdef0123456789abcdef";
  const impl = async () => { throw new Error(`connect ECONNREFUSED token=${leak}`); };
  const envelope = await caller(impl)(NOUL_INPUT);
  eq(envelope.ok, false, "ok:false");
  if (!envelope.error.message.includes("tier-2 disabled (FOC-473)")) fail(`expected the disabled-tier path: ${envelope.error.message}`);
  if (JSON.stringify(envelope).includes(leak)) fail("secret leaked through the error envelope");
  if (!JSON.stringify(envelope).includes("[REDACTED]")) fail("expected a scrubbed error message");
});

console.log("\ndecision-call: inputs hash and shadow log");

await test("inputs hash is deterministic and order-insensitive", async () => {
  const a = inputsHash(NOUL_INPUT);
  const b = inputsHash({ questions: { ...NOUL_INPUT.questions }, state: NOUL_INPUT.state });
  eq(a, b, "same input, different key order");
  const c = inputsHash({ ...NOUL_INPUT, state: "different" });
  if (a === c) fail("different input must hash differently");
  eq(a.length, 64, "sha256 hex");
});

await test("appends one JSONL shadow line per terminal decision", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decision-call-test-"));
  try {
    const impl = async (url) => (url === JEV_ENDPOINT ? jsonResponse(PROBE_BODY) : fallbackOk({ q0: true }));
    const okEnvelope = await caller(impl, { shadowDir: dir })(NOUL_INPUT);
    eq(okEnvelope.ok, true, "ok");
    const failed = await caller(async () => statusResponse(500), { shadowDir: dir })(NOUL_INPUT);
    eq(failed.ok, false, "second call fails (500 everywhere, tier 2 disabled)");
    const tier2Impl = async (url) => (url === JEV_ENDPOINT ? statusResponse(500) : fallbackOk({ q0: true }));
    const tier2 = await caller(tier2Impl, { shadowDir: dir, fallbackModel: SEAM_MODEL })(NOUL_INPUT);
    eq(tier2.ok, true, "third call served at tier 2 via the seam");

    const lines = readFileSync(join(dir, "decisions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    eq(lines.length, 3, "one line per decision");
    eq(lines[0].hash, inputsHash(NOUL_INPUT), "inputs hash");
    eq(lines[0].ok, true, "ok line");
    eq(lines[0].answers.q0.noul, 0.98, "answers recorded");
    eq(lines[0].confidence, 0.98, "confidence recorded");
    eq(lines[0].formatConfidence, null, "no format measurement at tier 1");
    eq(lines[0].pinnedModel, JEV_MODEL, "pinned model recorded");
    eq(lines[0].model, "typesafe/jev-1.13-20260917", "resolved build recorded");
    eq(lines[0].usage.cost, 0.000013692, "usage.cost recorded");
    eq(lines[1].ok, false, "failed line");
    eq(lines[1].error.code, "provider_error", "error code recorded");
    eq(lines[1].answers, null, "failed line carries no answers");
    eq(lines[1].formatConfidence, null, "failed line carries no format measurement");
    eq(lines[2].tier, 2, "tier-2 line");
    eq(lines[2].confidence, null, "tier-2 decision confidence null in the shadow log");
    eq(lines[2].formatConfidence, Math.exp(-0.15), "tier-2 formatConfidence recorded");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("without LA_RUN_ID and without shadowDir nothing is written and nothing throws", async () => {
  const envelope = await caller(async () => statusResponse(500))(NOUL_INPUT);
  eq(envelope.ok, false, "fail-closed still returns the envelope");
});

console.log("\ndecision-call: usage.cost of the fallback is metered under the same agent key");

await test("fallback serving call carries its own usage meter event", async () => {
  const impl = async (url) => (url === JEV_ENDPOINT ? statusResponse(429) : statusResponse(429));
  // both tiers exhaust → provider_error; the retry trail must be metered
  const records = [];
  const envelope = await caller(impl, { meter: (r) => records.push(r), retries: 1, fallbackModel: SEAM_MODEL })(NOUL_INPUT);
  eq(envelope.ok, false, "ok:false");
  const retries = records.filter((r) => r.kind === "retry");
  eq(retries.filter((r) => r.endpoint === "decisions").length, 1, "tier-1 retry metered");
  eq(retries.filter((r) => r.endpoint === "chat-completions").length, 1, "fallback retry metered");
});

console.log("\ndecision-call: registry decisionId calls (FOC-448)");

const deepEq = (a, b, label) => {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) fail(`${label}: ${sa} !== ${sb}`);
};

// gate.screen — the registry's one concrete (non-template) question set;
// the seed question is advisory and pending FOC-391, the autonomy is A0.
const GATE_STATE = "Probe (FOC-448): registry decisionId call — gate.screen seed, advisory pre-screen.";
const GATE_PROBE_BODY = {
  model: "typesafe/jev-1.13-20260917",
  answers: { q0: { type: "noul", noul: 0.98 } },
  usage: { input_tokens: 326, output_tokens: 21, cost: 0.000013692 },
  id: "gen-dec-1789892790-FOC448",
  provider: "TypeSafe",
};

await test("decisionId resolves the registry question set and serves an A0 annotation", async () => {
  const records = [];
  const envelope = await caller((url, options) => {
    eq(url, JEV_ENDPOINT, "tier-1 endpoint");
    const body = JSON.parse(options.body);
    deepEq(Object.keys(body.questions), ["q0"], "registry question set sent");
    if (!body.questions.q0.instructions.includes("FOC-391")) fail("registry seed question text not sent");
    return jsonResponse(GATE_PROBE_BODY);
  }, { meter: (r) => records.push(r) })({ state: GATE_STATE, decisionId: "gate.screen" });
  eq(envelope.ok, true, "ok");
  eq(envelope.step, "decision-call", "step");
  eq(envelope.decisionId, "gate.screen", "provenance on envelope");
  eq(envelope.criteriaVersion, 1, "criteriaVersion on envelope");
  eq(envelope.autonomy, "A0", "registry-owned autonomy surfaced");
  // A0: the annotation is the only readable answer channel.
  if ("decision" in envelope) fail("A0 envelope must not carry decision");
  if ("confidence" in envelope) fail("A0 envelope must not carry confidence");
  eq(envelope.annotation.answers.q0.noul, 0.98, "answers inside the annotation");
  eq(envelope.annotation.confidence, 0.98, "confidence inside the annotation");
  eq(envelope.pinnedModel, JEV_MODEL, "pinned model recorded");
  eq(envelope.usage.cost, 0.000013692, "usage recorded");
  const served = records.filter((r) => r.kind === "served");
  eq(served.length, 1, "one served meter record");
  eq(served[0].decisionId, "gate.screen", "provenance on meter event");
  eq(served[0].criteriaVersion, 1, "criteriaVersion on meter event");
});

await test("a failed registry call still records provenance and never an annotation", async () => {
  const records = [];
  const envelope = await caller(async () => statusResponse(500), { meter: (r) => records.push(r), retries: 1 })({ state: GATE_STATE, decisionId: "gate.screen" });
  eq(envelope.ok, false, "fail-closed");
  eq(envelope.error.code, "provider_error", "tier-2 disabled path");
  eq(envelope.decisionId, "gate.screen", "provenance on failed envelope");
  eq(envelope.criteriaVersion, 1, "criteriaVersion on failed envelope");
  if ("annotation" in envelope) fail("failed call carries no annotation");
  if ("decision" in envelope) fail("failed call carries no decision");
  if ("autonomy" in envelope) fail("autonomy is only surfaced on a served A0 call");
  eq(records.some((r) => r.kind === "served"), false, "no served meter record on failure");
});

await test("questions and decisionId together are a typed invalid_input with no HTTP call", async () => {
  let calls = 0;
  const impl = async () => { calls++; return jsonResponse(GATE_PROBE_BODY); };
  const envelope = await caller(impl)({ state: GATE_STATE, decisionId: "gate.screen", questions: NOUL_INPUT.questions });
  eq(envelope.ok, false, "fail-closed");
  eq(envelope.error.code, "invalid_input", "mutual exclusion");
  if (!envelope.error.message.includes("mutually exclusive")) fail("message names the rule");
  eq(typeof envelope.durationMs, "number", "pre-provider failure keeps the envelope shape");
  eq(calls, 0, "no HTTP attempt");
});

await test("unknown decisionId fails closed with no HTTP call", async () => {
  let calls = 0;
  const impl = async () => { calls++; return jsonResponse(GATE_PROBE_BODY); };
  const envelope = await caller(impl)({ state: GATE_STATE, decisionId: "intake.triage_node" });
  eq(envelope.ok, false, "fail-closed");
  eq(envelope.error.code, "invalid_input", "unknown id");
  if (!envelope.error.message.includes("unknown decision id")) fail("message names the failure");
  eq(calls, 0, "no HTTP attempt");
});

await test("registry template and node entries refuse a direct decisionId call", async () => {
  let calls = 0;
  const impl = async () => { calls++; return jsonResponse(GATE_PROBE_BODY); };
  const templated = await caller(impl)({ state: GATE_STATE, decisionId: "extraction" });
  eq(templated.ok, false, "template entry refuses");
  eq(templated.error.code, "invalid_input", "template code");
  if (!templated.error.message.includes("FOC-448")) fail("template refusal names the migration");
  const node = await caller(impl)({ state: GATE_STATE, decisionId: "plan.dor" });
  eq(node.ok, false, "node entry refuses");
  eq(node.error.code, "invalid_input", "node code");
  if (!node.error.message.includes("FOC-397")) fail("node refusal names the runner");
  eq(calls, 0, "no HTTP attempt for either");
});

await test("no caller parameter can request action semantics (structurally unreachable)", async () => {
  let calls = 0;
  const impl = async () => { calls++; return jsonResponse(GATE_PROBE_BODY); };
  const envelope = await caller(impl)({ state: GATE_STATE, decisionId: "gate.screen", asAction: true });
  eq(envelope.ok, false, "fail-closed");
  eq(envelope.error.code, "schema_invalid", "unknown parameter rejected by the raw-input gate");
  if (!envelope.error.message.includes("decisionId call input rejected")) fail("message names the raw-input gate");
  eq(calls, 0, "no HTTP attempt");
});

await test("shadow line for a registry call records decisionId, criteriaVersion and the measured answers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decision-call-test-"));
  try {
    const envelope = await caller(async () => jsonResponse(GATE_PROBE_BODY), { shadowDir: dir })({ state: GATE_STATE, decisionId: "gate.screen" });
    eq(envelope.ok, true, "ok");
    const line = JSON.parse(readFileSync(join(dir, "decisions.jsonl"), "utf8").trim());
    eq(line.decisionId, "gate.screen", "provenance in the shadow join");
    eq(line.criteriaVersion, 1, "criteriaVersion in the shadow join");
    eq(line.ok, true, "ok line");
    eq(line.answers.q0.noul, 0.98, "measured answers recorded despite the A0 wrap");
    eq(line.confidence, 0.98, "measured confidence recorded despite the A0 wrap");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("pre-provider failures stamp decisionId (criteriaVersion only where the entry resolved)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decision-call-test-"));
  try {
    let calls = 0;
    const impl = async () => { calls++; return jsonResponse(GATE_PROBE_BODY); };
    // mutual exclusion: the id is known, the entry never resolved
    const excluded = await caller(impl, { shadowDir: dir })({ state: GATE_STATE, decisionId: "gate.screen", questions: NOUL_INPUT.questions });
    eq(excluded.ok, false, "fail-closed");
    eq(excluded.error.code, "invalid_input", "mutual exclusion");
    eq(excluded.decisionId, "gate.screen", "id stamped on the failure envelope");
    if ("criteriaVersion" in excluded) fail("exclusion fires before resolution — no criteriaVersion");
    // unknown id: provenance even for a failed lookup
    const unknown = await caller(impl, { shadowDir: dir })({ state: GATE_STATE, decisionId: "intake.triage_node" });
    eq(unknown.ok, false, "fail-closed");
    eq(unknown.decisionId, "intake.triage_node", "id stamped on the failed lookup");
    if ("criteriaVersion" in unknown) fail("unknown id resolved nothing — no criteriaVersion");
    // raw-input reject: the id is still provenance
    const smuggled = await caller(impl)({ state: GATE_STATE, decisionId: "gate.screen", asAction: true });
    eq(smuggled.error.code, "schema_invalid", "raw-input gate");
    eq(smuggled.decisionId, "gate.screen", "id stamped on the raw-input reject");
    eq(calls, 0, "no HTTP attempt for any of the three");
    const lines = readFileSync(join(dir, "decisions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    eq(lines.length, 2, "one shadow line per failed call");
    for (const line of lines) {
      eq(line.ok, false, "failed line");
      if (typeof line.decisionId !== "string") fail("shadow line carries the id");
      if ("criteriaVersion" in line) fail("no criteriaVersion where the entry did not resolve");
    }
    eq(lines[0].decisionId, "gate.screen", "exclusion line id");
    eq(lines[1].decisionId, "intake.triage_node", "unknown-id line id");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("inline failures stamp nothing (byte-identity holds on error records too)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decision-call-test-"));
  try {
    const envelope = await caller(async () => statusResponse(500), { shadowDir: dir, retries: 1 })(NOUL_INPUT);
    eq(envelope.ok, false, "fail-closed");
    if ("decisionId" in envelope) fail("inline failure carries no decisionId");
    if ("criteriaVersion" in envelope) fail("inline failure carries no criteriaVersion");
    const line = JSON.parse(readFileSync(join(dir, "decisions.jsonl"), "utf8").trim());
    if ("decisionId" in line) fail("inline failure shadow line carries no decisionId");
    if ("criteriaVersion" in line) fail("inline failure shadow line carries no criteriaVersion");
    eq(line.error.code, "provider_error", "error recorded");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("inline-questions calls stay byte-identical (no provenance keys anywhere)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decision-call-test-"));
  try {
    const records = [];
    const envelope = await caller(async () => jsonResponse(PROBE_BODY), { shadowDir: dir, meter: (r) => records.push(r) })(NOUL_INPUT);
    eq(envelope.ok, true, "ok");
    if ("decisionId" in envelope) fail("inline envelope must not gain decisionId");
    if ("criteriaVersion" in envelope) fail("inline envelope must not gain criteriaVersion");
    if ("autonomy" in envelope) fail("inline call carries no autonomy");
    if ("annotation" in envelope) fail("inline call carries no annotation");
    eq(envelope.confidence, 0.98, "confidence stays top-level inline");
    const line = JSON.parse(readFileSync(join(dir, "decisions.jsonl"), "utf8").trim());
    if ("decisionId" in line) fail("inline shadow line must not gain decisionId");
    if ("criteriaVersion" in line) fail("inline shadow line must not gain criteriaVersion");
    eq(line.answers.q0.noul, 0.98, "answers recorded");
    if (records.some((r) => "decisionId" in r)) fail("inline meter records must not gain provenance");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log("\ndecision-call: full decision event record (FOC-449)");

// Secret-shaped state: a tokenized param, an sk-style key and a 32+ char run —
// the three shapes mcp/scrub.mjs exists to mask. Normal long prose has no such
// run and must survive UNTRUNCATED (the E1b point: no 120-char error cap on
// stored inputs).
const SECRET_STATE = "pre-screen for FOC-449; api_key=sk-or-v1-0123456789abcdef0123456789abcdef in state";
const LONG_PLAIN_STATE = "plain prose sentence for the no-cap check. ".repeat(12);

await test("a served registry call records a full event (identity, scrubbed input as sent, work key, latency)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decision-call-test-"));
  delete process.env.LA_TASK_ID;
  try {
    const envelope = await caller(async () => jsonResponse(GATE_PROBE_BODY), {
      shadowDir: dir,
      taskKey: "FOC-449",
    })({ state: GATE_STATE, decisionId: "gate.screen" });
    eq(envelope.ok, true, "ok");
    const line = JSON.parse(readFileSync(join(dir, "decisions.jsonl"), "utf8").trim());
    eq(line.type, "event", "type marker");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(line.eventId)) {
      fail(`eventId is not a random UUID: ${line.eventId}`);
    }
    eq(line.decisionId, "gate.screen", "provenance stays");
    eq(line.criteriaVersion, 1, "criteriaVersion stays");
    eq(line.taskKey, "FOC-449", "work key from the caller option");
    eq(typeof line.durationMs, "number", "latency recorded");
    eq(line.pinnedModel, JEV_MODEL, "pinned model recorded");
    eq(line.model, "typesafe/jev-1.13-20260917", "resolved build recorded");
    eq(line.usage.cost, 0.000013692, "usage.cost recorded");
    eq(line.input.state, GATE_STATE, "full state AS SENT, unmasked where harmless");
    eq(JSON.parse(line.input.questions).q0.type, "noul", "full questions AS SENT (serialized)");
    eq(line.scrub.variant, "mask-only", "scrub variant recorded");
    eq(line.scrub.redacted, false, "nothing needed redaction");
    if (!line.scrub.note.includes("mask-only")) fail(`scrub provenance note present: ${line.scrub.note}`);
    // Additive record: every field the FOC-448 join read is still there, in order.
    deepEq(Object.keys(line), [
      "ts", "runId", "hash", "pinnedModel", "model", "tier", "mode", "ok", "answers",
      "confidence", "formatConfidence", "usage", "responseId", "error",
      "decisionId", "criteriaVersion", "type", "eventId", "input", "scrub", "taskKey", "durationMs",
    ], "event record key order");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("a failed registry call keeps the input it actually sent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decision-call-test-"));
  try {
    const envelope = await caller(async () => statusResponse(500), { shadowDir: dir, retries: 1 })({ state: GATE_STATE, decisionId: "gate.screen" });
    eq(envelope.ok, false, "fail-closed");
    const line = JSON.parse(readFileSync(join(dir, "decisions.jsonl"), "utf8").trim());
    eq(line.type, "event", "failure is still an event");
    eq(line.ok, false, "failure recorded");
    eq(line.error.code, "provider_error", "error code recorded");
    eq(line.input.state, GATE_STATE, "the questions WERE sent — input recorded");
    eq(line.scrub.variant, "mask-only", "scrub provenance on the failure too");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("a pre-provider failure records the event with input null — nothing was sent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decision-call-test-"));
  try {
    let calls = 0;
    const impl = async () => { calls++; return jsonResponse(GATE_PROBE_BODY); };
    const envelope = await caller(impl, { shadowDir: dir })({ state: GATE_STATE, decisionId: "gate.screen", questions: NOUL_INPUT.questions });
    eq(envelope.ok, false, "fail-closed");
    eq(envelope.error.code, "invalid_input", "mutual exclusion");
    const line = JSON.parse(readFileSync(join(dir, "decisions.jsonl"), "utf8").trim());
    eq(line.type, "event", "registry-backed line is an event");
    if (!line.eventId) fail("eventId stamped even pre-provider");
    eq(line.decisionId, "gate.screen", "id provenance stays");
    eq(line.input, null, "nothing was sent — input null, honest");
    eq(line.scrub, null, "nothing scrubbed — no note, honest");
    eq(calls, 0, "no HTTP attempt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("taskKey falls back to LA_TASK_ID and stays null when absent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decision-call-test-"));
  process.env.LA_TASK_ID = "FOC-777";
  try {
    const withEnv = await caller(async () => jsonResponse(GATE_PROBE_BODY), { shadowDir: dir })({ state: GATE_STATE, decisionId: "gate.screen" });
    eq(withEnv.ok, true, "ok");
    let line = JSON.parse(readFileSync(join(dir, "decisions.jsonl"), "utf8").trim());
    eq(line.taskKey, "FOC-777", "env fallback");
  } finally {
    delete process.env.LA_TASK_ID;
    rmSync(dir, { recursive: true, force: true });
  }
  const dir2 = mkdtempSync(join(tmpdir(), "decision-call-test-"));
  try {
    const withoutEnv = await caller(async () => jsonResponse(GATE_PROBE_BODY), { shadowDir: dir2 })({ state: GATE_STATE, decisionId: "gate.screen" });
    eq(withoutEnv.ok, true, "ok");
    const line = JSON.parse(readFileSync(join(dir2, "decisions.jsonl"), "utf8").trim());
    eq(line.taskKey, null, "no env, no option — null, never guessed");
  } finally {
    rmSync(dir2, { recursive: true, force: true });
  }
});

await test("the stored input is masked without the error-text cap (E1b routing)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decision-call-test-"));
  try {
    const envelope = await caller(async () => jsonResponse(GATE_PROBE_BODY), { shadowDir: dir })({ state: SECRET_STATE, decisionId: "gate.screen" });
    eq(envelope.ok, true, "ok");
    const line = JSON.parse(readFileSync(join(dir, "decisions.jsonl"), "utf8").trim());
    if (line.input.state.includes("sk-or-v1-0123456789abcdef0123456789abcdef")) {
      fail("secret-shaped state material leaked into .state");
    }
    if (!line.input.state.includes("[REDACTED]")) fail("expected masked state");
    eq(line.input.state.startsWith("pre-screen for FOC-449;"), true, "readable prose kept");
    // A second call proves plain long text survives whole: no 120-char cap.
    const long = await caller(async () => jsonResponse(GATE_PROBE_BODY), { shadowDir: dir })({ state: LONG_PLAIN_STATE, decisionId: "gate.screen" });
    eq(long.ok, true, "ok");
    const lines = readFileSync(join(dir, "decisions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    eq(lines[1].input.state, LONG_PLAIN_STATE, `full ${LONG_PLAIN_STATE.length}-char state stored untruncated`);
    eq(lines[1].input.state.length > 120, true, "the error cap does not apply to stored inputs");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("inline shadow lines stay byte-identical — no event fields at all", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decision-call-test-"));
  try {
    const envelope = await caller(async () => jsonResponse(PROBE_BODY), { shadowDir: dir })(NOUL_INPUT);
    eq(envelope.ok, true, "ok");
    const line = JSON.parse(readFileSync(join(dir, "decisions.jsonl"), "utf8").trim());
    deepEq(Object.keys(line), [
      "ts", "runId", "hash", "pinnedModel", "model", "tier", "mode", "ok", "answers",
      "confidence", "formatConfidence", "usage", "responseId", "error",
    ], "inline key set unchanged");
    for (const key of ["type", "eventId", "input", "scrub", "taskKey", "durationMs"]) {
      if (key in line) fail(`inline line must not gain "${key}"`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log("\ndecision-call: ADR-0012 drift guard (code ↔ ADR agreement, FOC-473)");

await test("ADR-0012 states the tier-2 state the code ships (drift guard)", async () => {
  // A missing or unreadable ADR is drift too — it fails, it does not skip.
  const adr = readFileSync(ADR_0012, "utf8");
  // The anchor is derived from the shipped constant: the ADR must quote the
  // exact same fact the code runs with (ADR-0012 D2, re-enable conditions) —
  // and every quote of the constant in the ADR must agree, so a stale copy
  // cannot survive next to an updated one.
  const anchor = `FALLBACK_MODEL = ${JSON.stringify(FALLBACK_MODEL)}`;
  const quoted = adr.match(/FALLBACK_MODEL = [^`\s]+/g) ?? [];
  if (quoted.length === 0) fail("ADR-0012/code drift: the ADR never quotes the FALLBACK_MODEL constant");
  for (const q of quoted) {
    if (q !== anchor) fail(`ADR-0012/code drift: the ADR quotes "${q}" but the code ships "${anchor}"`);
  }
  if (FALLBACK_MODEL === null && !adr.includes("tier 2 is DISABLED")) {
    fail("ADR-0012/code drift: FALLBACK_MODEL is null but the ADR does not state tier 2 is disabled");
  }
});

console.log(`\ndecision-call: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("FAILURES:\n - " + failures.join("\n - "));
  process.exit(1);
}
