// scripts/decision-call.mjs — THE decision-call seam (FOC-386).
//
// One entry point for every [J] decision step in the pipeline: callers pass
// {state, questions} (noul / choice / score questions with instructions +
// criteria) and receive a typed, schema-validated answer set with
// probabilities/confidence, the model version and usage.cost. Everything
// later (MCP step family, graph [D] nodes, calibration harness) calls through
// this seam; no caller builds its own provider.
//
// Measured alpha contract (live probe 2026-09-20, HTTP 200, single call):
//   · request  {model: "typesafe/jev-1.13", state, questions} — questions is
//     a RECORD keyed by question id (an array is rejected with 400);
//   · response {model, answers, usage, id, provider} where model echoes the
//     RESOLVED dated build ("typesafe/jev-1.13-20260917" at probe time — the
//     pinned alias was sent), answers.<qid> holds the typed answer
//     ({type:"noul", noul: 0.98} measured; choice per the catalog:
//     {type:"choice", choice, probabilities, confidence}), usage carries
//     input_tokens / output_tokens / cost (probe cost $0.000013692), and id
//     is a "gen-dec-…" generation id;
//   · there is no top-level confidence field — for noul the native
//     probability itself is the measured source (ADR-0012 D3.6).
// The client records BOTH model facts on every decision: the pinned request
// version (pinnedModel) and the echoed resolved build (model).
//
// Tiering (ADR-0012 D2/D3):
//   · tier 1 — Jev via createJevProvider (ONE POST implementation, reused —
//     this module never forks the decisions-endpoint transport);
//   · retry on 429/5xx at the call boundary (bounded, small backoff) by
//     wrapping the injected fetch — 4xx other than 429 and network errors do
//     not retry;
//   · tier 2 — fallback on tier-1 failure (down, 4xx/5xx after retries, or a
//     tier-1 body that no longer matches the measured shape): a NON-THINKING
//     model via chat/completions with response_format json_schema,
//     provider.require_parameters: true and logprobs. Confidence comes ONLY
//     from the returned logprobs (mean token probability, exp of mean
//     logprob); with no logprob source confidence is null — never estimated.
//     A noul verdict maps to noul 1|0 — that is the verdict's ENCODING, not a
//     measured probability: per-answer confidence stays null at tier 2, the
//     honest uncertainty lives in the envelope confidence (logprob-derived),
//     and the envelope tier/mode say which path served the call;
//   · auth_missing fails closed directly — no fallback attempt without
//     credentials (both tiers share the same key);
//   · after the cascade the seam fails closed to the relay/HITL path: one
//     typed error envelope, never an invented answer.
//
// Metering: every HTTP response is metered under the seam's own agent key
// ("decision-call") with OpenRouter's usage.cost verbatim; a decision that
// fell back produces one event per reported call (the serving call carries
// the usage, failed attempts carry status with costUsd null — a 429 costs
// nothing, and inventing a cost would be fabrication). Telemetry is
// best-effort and gated on LA_RUN_ID, exactly like mcp/envelope.mjs.
//
// Shadow log: every terminal decision (ok or fail-closed) is appended as one
// JSONL line to <repo>/.state/runs/<LA_RUN_ID>/decisions.jsonl with the
// inputs hash, answers, confidence, both model versions and usage.cost, so
// the harness can later join it with the real outcome. The inputs hash is
// sha256 over the canonical (key-sorted) JSON of {model: pinned, state,
// questions}. Writes are best-effort (a shadow failure never degrades the
// decision) and skipped when there is no run directory to write to.
//
// Secrets: error paths never echo Authorization values or key material —
// every message this module composes goes through mcp/scrub.mjs, the one
// scrubber shared with the envelope, the Jev provider and the JSON-RPC layer
// (FOC-411 lesson, unified in FOC-417).
//
// Run: import { createDecisionCaller } from "./decision-call.mjs" (no CLI —
// callers are the MCP step family and the graph runner).

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runDecision, TypedError } from "./mcp/envelope.mjs";
import { scrub } from "./mcp/scrub.mjs";
import { createJevProvider, JEV_MODEL, probabilityOf, choiceOf, confidenceOf } from "./mcp/provider-jev.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, "..");

// Tier-2 fallback: a non-thinking model with logprob support that ALREADY has
// a pricing row in config/models.json (input 0.075 / output 0.25 USD per 1M),
// so live fallback spend stays measurable under cost caps.
export const FALLBACK_MODEL = "z-ai/glm-5.3-flash";
export const FALLBACK_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
// Metering key — every decision-call HTTP usage is metered under this key.
export const DECISION_AGENT_KEY = "decision-call";
export const SHADOW_FILENAME = "decisions.jsonl";
export const DECISION_EVENT_TYPE = "decision.call.usage";

// ── step descriptor (schemas run through the shared fail-closed envelope) ───

const ANSWER_CONFIDENCE = { type: ["number", "null"], minimum: 0, maximum: 1 };

const NOUL_ANSWER = {
  type: "object",
  required: ["type", "noul"],
  additionalProperties: false,
  properties: {
    type: { const: "noul" },
    noul: { type: "number", minimum: 0, maximum: 1 },
    confidence: { type: ["number", "null"], minimum: 0, maximum: 1 },
  },
};

const CHOICE_ANSWER = {
  type: "object",
  required: ["type", "choice"],
  additionalProperties: false,
  properties: {
    type: { const: "choice" },
    choice: { type: "string", minLength: 1, maxLength: 120 },
    probabilities: { type: "object", minProperties: 1, additionalProperties: { type: "number", minimum: 0, maximum: 1 } },
    confidence: { type: ["number", "null"], minimum: 0, maximum: 1 },
  },
};

const SCORE_ANSWER = {
  type: "object",
  required: ["type", "score"],
  additionalProperties: false,
  properties: {
    type: { const: "score" },
    score: { type: "number" },
    confidence: { type: ["number", "null"], minimum: 0, maximum: 1 },
  },
};

const QUESTION_SCHEMA = {
  type: "object",
  required: ["type", "instructions", "criteria"],
  additionalProperties: false,
  properties: {
    type: { enum: ["noul", "choice", "score"] },
    instructions: { type: "string", minLength: 1, maxLength: 2000 },
    criteria: {
      type: "object",
      minProperties: 1,
      maxProperties: 8,
      additionalProperties: { type: "string", minLength: 1, maxLength: 500 },
    },
  },
  // noul criteria labels are exactly "true"/"false" (measured contract) —
  // reject a malformed question at the seam instead of at the alpha endpoint.
  allOf: [{
    if: { properties: { type: { const: "noul" } }, required: ["type"] },
    then: {
      type: "object",
      properties: {
        criteria: {
          type: "object",
          required: ["true", "false"],
          additionalProperties: false,
          properties: {
            true: { type: "string", minLength: 1, maxLength: 500 },
            false: { type: "string", minLength: 1, maxLength: 500 },
          },
        },
      },
    },
  }],
};

export const DECISION_STEP = {
  name: "decision-call",
  inputSchema: {
    type: "object",
    required: ["state", "questions"],
    additionalProperties: false,
    properties: {
      state: { type: "string", minLength: 1, maxLength: 16000 },
      questions: { type: "object", minProperties: 1, maxProperties: 12, additionalProperties: QUESTION_SCHEMA },
    },
  },
  outputSchema: {
    type: "object",
    required: ["answers"],
    additionalProperties: false,
    properties: {
      answers: { type: "object", minProperties: 1, maxProperties: 12, additionalProperties: { oneOf: [NOUL_ANSWER, CHOICE_ANSWER, SCORE_ANSWER] } },
    },
  },
};

// ── helpers ──────────────────────────────────────────────────────────────────

// Key-sorted JSON — the canonical form the inputs hash is taken over.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

// Deterministic join key: pinned model + state + questions, key-sorted.
export function inputsHash(input) {
  return createHash("sha256")
    .update(canonicalJson({ model: JEV_MODEL, state: input?.state, questions: input?.questions }))
    .digest("hex");
}

// Hash of an arbitrary caller input; unserializable input hashes to null
// (the shadow join tolerates a missing hash).
function safeHash(input) {
  try {
    return inputsHash(input);
  } catch {
    return null;
  }
}

function usageOf(usage) {
  if (!usage || typeof usage !== "object") return null;
  const inputTokens = usage.input_tokens ?? usage.prompt_tokens;
  const outputTokens = usage.output_tokens ?? usage.completion_tokens;
  return {
    inputTokens: Number.isInteger(inputTokens) ? inputTokens : null,
    outputTokens: Number.isInteger(outputTokens) ? outputTokens : null,
    cost: typeof usage.cost === "number" ? usage.cost : null,
  };
}

// Per-answer confidence = measured certainty only (ADR-0012 D3.6): noul →
// max(p, 1−p) so a confident rejection reads as confidence (catalog rule),
// choice → native confidence, score → no measured source (null).
function normalizeAnswers(rawAnswers, questions) {
  if (!rawAnswers || typeof rawAnswers !== "object" || Array.isArray(rawAnswers)) {
    throw new TypedError("unparseable_output", "answers is not a record");
  }
  const asked = Object.keys(questions);
  const unknown = Object.keys(rawAnswers).filter((k) => !asked.includes(k));
  if (unknown.length) throw new TypedError("unparseable_output", "answers carry unknown question ids");

  const answers = {};
  const certainties = [];
  for (const qid of asked) {
    const question = questions[qid];
    const answer = rawAnswers[qid];
    if (!answer || typeof answer !== "object" || Array.isArray(answer)) {
      throw new TypedError("unparseable_output", `answers.${qid}: missing answer object`);
    }
    if (question.type === "noul") {
      const p = probabilityOf(answer);
      if (p === null) throw new TypedError("unparseable_output", `answers.${qid}: no noul probability in [0,1]`);
      const certainty = Math.max(p, 1 - p);
      answers[qid] = { type: "noul", noul: p, confidence: certainty };
      certainties.push(certainty);
    } else if (question.type === "choice") {
      const label = choiceOf(answer, Object.keys(question.criteria));
      if (label === null) throw new TypedError("unparseable_output", `answers.${qid}: no known choice label`);
      const confidence = confidenceOf(answer);
      const out = { type: "choice", choice: label, confidence };
      const probs = answer.probabilities;
      if (probs && typeof probs === "object" && !Array.isArray(probs)) out.probabilities = probs;
      answers[qid] = out;
      if (confidence !== null) certainties.push(confidence);
    } else {
      const score = answer.score;
      if (typeof score !== "number" || !Number.isFinite(score)) {
        throw new TypedError("unparseable_output", `answers.${qid}: no numeric score`);
      }
      answers[qid] = { type: "score", score, confidence: null };
    }
  }
  return { answers, confidence: certainties.length ? Math.min(...certainties) : null };
}

// Tier-2 answers come back as one strict-schema JSON object whose answers
// record carries a PRIMITIVE per asked question (noul → boolean, choice →
// one of the criteria labels, score → number); normalization types them.
function normalizeFallbackAnswers(raw, questions) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypedError("unparseable_output", "fallback answer is not an object");
  }
  const rawAnswers = raw.answers;
  if (!rawAnswers || typeof rawAnswers !== "object" || Array.isArray(rawAnswers)) {
    throw new TypedError("unparseable_output", "fallback answers is not a record");
  }
  const answers = {};
  for (const [qid, question] of Object.entries(questions)) {
    const value = rawAnswers[qid];
    if (question.type === "noul") {
      if (typeof value !== "boolean") throw new TypedError("unparseable_output", `answers.${qid}: noul verdict is not boolean`);
      answers[qid] = { type: "noul", noul: value === true ? 1 : 0, confidence: null };
    } else if (question.type === "choice") {
      if (typeof value !== "string" || !Object.keys(question.criteria).includes(value)) {
        throw new TypedError("unparseable_output", `answers.${qid}: choice is not a known label`);
      }
      answers[qid] = { type: "choice", choice: value, confidence: null };
    } else {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new TypedError("unparseable_output", `answers.${qid}: score is not numeric`);
      }
      answers[qid] = { type: "score", score: value, confidence: null };
    }
  }
  return answers;
}

// Strict per-call schema for the fallback: every asked question becomes a
// required, typed property (noul → boolean, choice → criteria enum, score →
// number) — the model's call must END with schema-constrained typed JSON
// (ADR-0012 D5), and dynamic records cannot be expressed under strict mode.
export function fallbackAnswerSchema(questions) {
  const properties = {};
  for (const [qid, question] of Object.entries(questions)) {
    if (question.type === "noul") properties[qid] = { type: "boolean" };
    else if (question.type === "choice") properties[qid] = { type: "string", enum: Object.keys(question.criteria) };
    else properties[qid] = { type: "number" };
  }
  return {
    type: "object",
    additionalProperties: false,
    required: ["answers"],
    properties: {
      answers: { type: "object", additionalProperties: false, required: Object.keys(questions), properties },
    },
  };
}

// Tier-2 measured confidence: mean probability over the generated content
// tokens = exp(mean logprob). Any missing/absent logprob → null.
function logprobConfidence(logprobs) {
  const tokens = logprobs?.content;
  if (!Array.isArray(tokens) || tokens.length === 0) return null;
  let sum = 0;
  for (const token of tokens) {
    if (typeof token?.logprob !== "number") return null;
    sum += token.logprob;
  }
  return Math.min(1, Math.max(0, Math.exp(sum / tokens.length)));
}

/**
 * Call-boundary retry: re-issues 429/5xx up to `retries` extra times with a
 * small backoff; everything else (other 4xx, network errors) propagates
 * immediately. Network errors are scrubbed before leaving the wrapper.
 */
function makeRetryFetch(baseFetch, { retries, backoffMs, delayFn, onError }) {
  let attempts = 0;
  const call = async (url, options = {}) => {
    for (let i = 0; ; i++) {
      attempts = i + 1;
      let response;
      try {
        response = await baseFetch(url, options);
      } catch (err) {
        throw new Error(scrub(err?.message || "network error"));
      }
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && i < retries) {
        onError?.({ url, status: response.status, attempts });
        await delayFn(backoffMs[Math.min(i, backoffMs.length - 1)]);
        continue;
      }
      return response;
    }
  };
  call.attempts = () => attempts;
  return call;
}

// Best-effort metering (same contract as mcp/envelope.mjs telemetry): gated
// on LA_RUN_ID, lazy store import, failures swallowed — metering never gates
// the decision return.
function defaultMeter(record) {
  if (!process.env.LA_RUN_ID) return;
  void (async () => {
    try {
      const { makeEvent, emitEvent } = await import("./telemetry-store.mjs");
      emitEvent(makeEvent(DECISION_EVENT_TYPE, { agentKey: DECISION_AGENT_KEY, ...record }, {
        runId: process.env.LA_RUN_ID,
        sourceKind: "decision-call",
      }));
    } catch {
      // Best-effort by contract.
    }
  })();
}

function defaultShadowDir(runId) {
  return runId ? join(root, ".state", "runs", runId) : null;
}

function appendShadow(shadowDir, line) {
  if (!shadowDir) return;
  try {
    mkdirSync(shadowDir, { recursive: true });
    appendFileSync(join(shadowDir, SHADOW_FILENAME), `${JSON.stringify(line)}\n`);
  } catch {
    // Best-effort by contract: the harness join tolerates a missing line.
  }
}

/**
 * The decision-call seam. Returns an async call({state, questions}) →
 * envelope (the shared fail-closed shape, plus answers/usage/responseId and
 * pinnedModel on success).
 *
 * Options:
 *   apiKey     — OPENROUTER_API_KEY value (both tiers; auth_missing without)
 *   fetchImpl  — injectable fetch (tests never touch the network)
 *   timeoutMs  — per-request timeout (default 30000)
 *   retries    — extra attempts for 429/5xx at the call boundary (default 2)
 *   backoffMs  — backoff schedule between retries (default [250, 1000])
 *   delayFn    — injectable sleeper (tests pass an instant resolver)
 *   meter      — per-call metering sink (default: LA_RUN_ID-gated telemetry)
 *   shadowDir  — directory for decisions.jsonl (default
 *                <repo>/.state/runs/<LA_RUN_ID>; explicit dir writes even
 *                without LA_RUN_ID)
 *   runId      — run id recorded in shadow lines and meter events
 *                (default process.env.LA_RUN_ID)
 *   now        — clock for measuredAt (tests)
 */
export function createDecisionCaller({
  apiKey,
  fetchImpl = fetch,
  timeoutMs = 30000,
  retries = 2,
  backoffMs = [250, 1000],
  delayFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  meter = defaultMeter,
  shadowDir,
  runId = process.env.LA_RUN_ID,
  now = () => new Date().toISOString(),
} = {}) {
  function meterRecord(kind) {
    return (record) => meter({ kind, agentKey: DECISION_AGENT_KEY, ...record });
  }

  // ── closure state (declared BEFORE the returned caller) ──
  let captured = { usage: null, responseId: null, model: null };
  const runIdActual = () => runId;
  // tier 1 — the shared Jev transport over the retry-wrapped fetch; tier 2 —
  // the fallback transport with its own retry budget.
  const jevRetry = makeRetryFetch(fetchImpl, { retries, backoffMs, delayFn, onError: (r) => meterRecord("retry")({ endpoint: "decisions", tier: 1, model: JEV_MODEL, status: r.status, attempts: r.attempts, usage: null, responseId: null }) });
  const tier2Retry = makeRetryFetch(fetchImpl, { retries, backoffMs, delayFn, onError: (r) => meterRecord("retry")({ endpoint: "chat-completions", tier: 2, model: FALLBACK_MODEL, status: r.status, attempts: r.attempts, usage: null, responseId: null }) });
  const jevProvider = createJevProvider({ apiKey, fetchImpl: jevRetry, timeoutMs });

  async function callDecisions(input = {}) {
    const hash = safeHash(input);
    const envelope = await runDecision(DECISION_STEP, input, { provider: decisionProvider(), now });

    envelope.pinnedModel = JEV_MODEL;
    if (envelope.ok) {
      envelope.usage = captured.usage ? { inputTokens: captured.usage.inputTokens, outputTokens: captured.usage.outputTokens, cost: captured.usage.cost } : null;
      envelope.responseId = captured.responseId;
    }
    appendShadow(shadowDir ?? defaultShadowDir(runIdActual()), {
      ts: now(),
      runId: runIdActual(),
      hash,
      pinnedModel: JEV_MODEL,
      model: envelope.model ?? null,
      tier: envelope.tier ?? null,
      mode: envelope.mode ?? null,
      ok: envelope.ok === true,
      answers: envelope.ok ? envelope.decision.answers : null,
      confidence: envelope.confidence ?? null,
      usage: envelope.ok ? envelope.usage : null,
      responseId: envelope.ok ? envelope.responseId : null,
      error: envelope.ok ? null : { code: envelope.error.code },
    });
    return envelope;
  }

  function decisionProvider() {
    return {
      tier: 1,
      model: JEV_MODEL,
      mode: "live",
      async decide({ input }) {
        const questions = input.questions;
        const adapterStep = {
          name: DECISION_STEP.name,
          toJev: (inp) => ({ state: inp.state, questions: inp.questions }),
          fromJev: (body) => {
            const parsed = normalizeAnswers(body?.answers, questions);
            const usage = usageOf(body?.usage);
            const responseId = typeof body?.id === "string" ? body.id : null;
            const model = typeof body?.model === "string" && body.model ? body.model : null;
            captured = { usage, responseId, model };
            meterRecord("served")({ endpoint: "decisions", tier: 1, attempts: jevRetry.attempts(), model, status: null, usage, responseId });
            return { decision: { answers: parsed.answers }, confidence: parsed.confidence };
          },
        };

        try {
          return await jevProvider.decide({ step: adapterStep, input });
        } catch (err) {
          if (err instanceof TypedError && err.code === "auth_missing") throw err;
          return fallbackDecide(input, err);
        }
      },
    };
  }

  async function fallbackDecide(input, tier1Error) {
    let response;
    try {
      response = await tier2Retry(FALLBACK_ENDPOINT, {
        method: "POST",
        headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: FALLBACK_MODEL,
          messages: [
            { role: "system", content: "You resolve typed decision questions. Reply with the JSON object only — no prose." },
            { role: "user", content: JSON.stringify({ state: input.state, questions: input.questions }) },
          ],
          response_format: { type: "json_schema", json_schema: { name: "decision_answers", strict: true, schema: fallbackAnswerSchema(input.questions) } },
          logprobs: true,
          top_logprobs: 5,
          provider: { require_parameters: true },
          usage: { include: true },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new TypedError("provider_error", `fallback call failed: ${scrub(err?.message || "network error")}`);
    }

    if (!response.ok) {
      // Status only — never the body.
      throw new TypedError("provider_error", `fallback returned HTTP ${response.status} (tier-1: ${tier1Error?.code || "error"})`);
    }

    let body;
    try {
      body = await response.json();
    } catch {
      throw new TypedError("unparseable_output", "fallback response is not valid JSON");
    }

    let parsed;
    try {
      const content = body?.choices?.[0]?.message?.content;
      parsed = normalizeFallbackAnswers(typeof content === "string" ? JSON.parse(content) : null, input.questions);
    } catch (err) {
      if (err instanceof TypedError) throw err;
      throw new TypedError("unparseable_output", "fallback answer is not valid JSON");
    }

    const usage = usageOf(body?.usage);
    const model = typeof body?.model === "string" && body.model ? body.model : FALLBACK_MODEL;
    const confidence = logprobConfidence(body?.choices?.[0]?.logprobs);
    captured = { usage, responseId: null, model };
    meterRecord("served")({ endpoint: "chat-completions", tier: 2, attempts: tier2Retry.attempts(), model, status: null, usage, responseId: null });
    return { tier: 2, model, mode: "live", decision: { answers: parsed }, confidence };
  }

  return callDecisions;
}
