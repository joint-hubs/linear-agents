// scripts/mcp/envelope.mjs — shared fail-closed envelope for MCP-hosted [J]
// decision steps (FOC-401; the pattern is ADR-0012 D5).
//
// Every decision call flows through runDecision():
//   input  → validated against the step's input JSON Schema (ajv)
//   model  → the step's provider (tier-1 Jev, or the deterministic offline
//            path used by tests and the shadow run)
//   output → validated against the step's output JSON Schema BEFORE return
//
// Fail-closed: a provider error, an unparseable provider response, or a
// schema-invalid result all become one typed error envelope
// ({ok:false, error:{code,message}}) — never a silent degrade, never partial
// data. The HITL/relay path is the CALLER's fallback; this module only
// returns the typed error for it to act on.
//
// Confidence (ADR-0012 D3.6, FIXED): measured sources only — tier-1 native
// Decisions-API probabilities or tier-2 logprobs. The offline path and any
// provider that cannot measure return null. Never estimated, never fabricated.
//
// Context isolation (D5): the caller receives only the final typed JSON. The
// model's intermediate reasoning never crosses this boundary, and error
// messages carry schema paths and statuses, never provider or prompt content.
// Provider-originated text that does reach an error message is scrubbed of
// key-shaped material and capped at MAX_ERROR_TEXT (FOC-417, mcp/scrub.mjs).
//
// Telemetry is best-effort by contract: a telemetry failure must never fail
// or degrade the decision call. An event is written only when LA_RUN_ID is
// set (so hermetic test runs and the shadow run write nothing), the payload
// carries no prompt or decision content, and every failure inside the writer
// is swallowed.

import Ajv from "ajv";
import { scrub } from "./scrub.mjs";

// Machine-readable error codes (documented in docs/mcp-decision-steps-catalog.md).
export const ERROR_CODES = {
  invalid_input: "the decision input failed the step's input schema",
  auth_missing: "provider credentials are absent from the environment",
  provider_error: "the provider call failed (network, timeout, non-2xx)",
  unparseable_output: "the provider response could not be parsed into the expected shape",
  schema_invalid: "the provider's parsed result failed the step's output schema",
};

// Typed provider failures. A provider throws these for everything it cannot
// turn into a raw result; runDecision re-shapes them into error envelopes.
export class TypedError extends Error {
  constructor(code, message) {
    if (!ERROR_CODES[code]) throw new Error(`unknown typed error code: ${code}`);
    super(message);
    this.name = "TypedError";
    this.code = code;
  }
}

const ajv = new Ajv({ allErrors: false });
const compiled = new WeakMap();

function compile(schema) {
  let validate = compiled.get(schema);
  if (!validate) {
    validate = ajv.compile(schema);
    compiled.set(schema, validate);
  }
  return validate;
}

// Short, value-free ajv error summary: schema paths and keywords only, never
// the offending data — inputs and outputs may carry user-dictated content.
export function schemaErrors(validate) {
  return (validate.errors || []).slice(0, 3).map((e) => ({
    path: e.instancePath || "(root)",
    keyword: e.keyword,
  }));
}

function describe(errors) {
  return errors.map((e) => `${e.path}: ${e.keyword}`).join("; ");
}

function normalizeConfidence(value) {
  return typeof value === "number" && value >= 0 && value <= 1 ? value : null;
}

// Best-effort telemetry (contract above). Dotted event name follows the
// store's convention ("run.started", "quality.reported", ...). The store is
// loaded lazily and only when LA_RUN_ID is set — decision servers pay no
// node:sqlite import (and no experimental warning) in the common path.
async function emitTelemetry(envelope) {
  if (!process.env.LA_RUN_ID) return;
  try {
    const { makeEvent, emitEvent } = await import("../telemetry-store.mjs");
    emitEvent(makeEvent("mcp.decision.recorded", {
      step: envelope.step,
      ok: envelope.ok === true,
      mode: envelope.mode ?? null,
      tier: envelope.tier ?? null,
      model: envelope.model ?? null,
      confidence: envelope.confidence ?? null,
      errorCode: envelope.error?.code ?? null,
      durationMs: envelope.durationMs ?? null,
      // No prompt, no decision payload — the event stays non-sensitive by design.
    }, { runId: process.env.LA_RUN_ID, sourceKind: "mcp-decision-server" }));
  } catch {
    // Best-effort by contract: never fail or degrade the decision call.
  }
}

/**
 * Run one decision-shaped step, fail-closed end to end.
 *
 * step:     { name, inputSchema, outputSchema } from steps.mjs
 * input:    the caller's arguments (validated against step.inputSchema)
 * provider: { decide({step, input}) → {decision, confidence, tier, model, mode} }
 *           or throws TypedError; the offline factory (provider-offline.mjs)
 *           and the tier-1 Jev provider (provider-jev.mjs) both fit.
 *
 * Returns the envelope the caller receives — the ONLY thing that crosses the
 * MCP boundary:
 *   { ok:true,  step, tier, model, mode, decision, confidence, measuredAt, durationMs }
 *   { ok:false, step, tier, model, mode, error:{code, message}, measuredAt, durationMs }
 */
export async function runDecision(step, input, { provider, now = () => new Date().toISOString() } = {}) {
  const startedAt = Date.now();
  const measuredAt = now();
  const finish = (envelope) => {
    envelope.measuredAt = measuredAt;
    envelope.durationMs = Date.now() - startedAt;
    void emitTelemetry(envelope); // fire-and-forget — telemetry never gates the return
    return envelope;
  };
  const base = { step: step.name, tier: null, model: null, mode: null };

  // 1. Input validation — the caller's shape is the first fail-closed gate.
  const validateIn = compile(step.inputSchema);
  if (!validateIn(input ?? null)) {
    return finish({ ...base, ...failure("invalid_input", describe(schemaErrors(validateIn))) });
  }

  // 2. The provider produces a RAW result; free-form model text never reaches
  //    the caller. Every exit from here is a typed error or a typed object.
  let raw;
  try {
    raw = await provider.decide({ step, input });
  } catch (err) {
    // Both echoes are scrubbed (FOC-417): a provider message may carry a
    // credential that a transport error quoted, even when the provider's own
    // error text was composed here. Fail-closed shape is untouched.
    if (err instanceof TypedError) {
      return finish({ ...base, ...failure(err.code, scrub(err.message)) });
    }
    // An unexpected provider crash is a provider failure, not a degrade.
    return finish({ ...base, ...failure("provider_error", scrub(err?.message || String(err))) });
  }

  const meta = {
    tier: Number.isInteger(raw?.tier) ? raw.tier : null,
    model: typeof raw?.model === "string" ? raw.model : null,
    mode: typeof raw?.mode === "string" ? raw.mode : null,
  };

  // 3. The provider must hand back a decision object; anything else is an
  //    unparseable provider output, not an empty result.
  if (!raw || typeof raw.decision !== "object" || raw.decision === null || Array.isArray(raw.decision)) {
    return finish({ ...base, ...meta, ...failure("unparseable_output", "provider returned no decision object") });
  }

  // 4. Fail-closed output validation — the model may think, but what it ends
  //    with must be the schema-validated typed JSON (ADR-0012 D5). On failure
  //    nothing partial leaks: the envelope carries paths, never fragments.
  const validateOut = compile(step.outputSchema);
  if (!validateOut(raw.decision)) {
    return finish({ ...base, ...meta, ...failure("schema_invalid", describe(schemaErrors(validateOut))) });
  }

  const confidence = normalizeConfidence(raw.confidence);
  return finish({
    ...base,
    ...meta,
    ok: true,
    decision: raw.decision,
    confidence,
  });
}

function failure(code, message) {
  return { ok: false, error: { code, message } };
}
