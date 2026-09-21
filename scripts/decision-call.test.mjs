// scripts/decision-call.test.mjs — FOC-386: the decision-call seam.
//
// Covers the seam contract end to end, all offline: the typed envelope over
// {state, questions}, the pinned-vs-resolved model facts, usage.cost
// metering under the seam's own agent key, retry on 429/5xx at the call
// boundary, the tier-2 chat/completions mechanism (json_schema + logprobs;
// formatConfidence null without a logprob source) exercised through the
// fallbackModel TEST SEAM, the tier-2 DISABLED state (FALLBACK_MODEL = null,
// FOC-473: a tier-1 failure fails closed with zero fallback calls),
// fail-closed exits, the shadow JSONL log and its inputs hash, and the
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
