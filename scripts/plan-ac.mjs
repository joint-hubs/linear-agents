// scripts/plan-ac.mjs — FOC-475: the plan.ac [G] node's NODE-INTERNAL loop.
//
// plan.ac stays a [G] generator step (one bounded model call, cheap tier,
// schema-validated output) — but its execution carries a quality loop the
// runner drives through this module: the FOC-452 `plan.ac.testable` gate is
// consumed HERE, per criterion, by the node itself.
//
// One step execution:
//   1. compose the declared reads' payload — `inbox.entry` carries exactly
//      {issueId, title, scopeSummary, dorFacts} (dorFacts null when the run
//      state has none — the node never invents DoR facts; runtime composition
//      of DoR facts into the entry is a follow-up) and `features.list` the
//      candidate files the CALLER retrieved deterministically. The composed
//      payload is bounded by the seam's state cap and FAILS CLOSED before any
//      provider call over it — no truncation. Truncation precedent
//      (plan-gates STATE_CAP) covers [J] triage, where partial context is
//      acceptable; AC generation is not — silently truncated DoR facts would
//      generate acceptance criteria from half the facts.
//   2. one [G] generation call through the injected generator (the default
//      transport — registry prompt, strict schema, cheap tier).
//   3. EVERY generated criterion is scored through `plan.ac.testable` via the
//      seam's instances channel (one noul per criterion; verdict p ≥ 0.5,
//      plan-gates.mjs).
//   4. any criterion below the verdict → EXACTLY ONE regeneration whose reads
//      carry the failing criteria + the gate's reasons (a `revision` field on
//      the `inbox.entry` payload — caller composition, the FOC-474 precedent
//      of payload fields; the declared reads stay exactly two); ALL criteria
//      are re-scored.
//   5. still below → a typed ESCALATION record: per-criterion verdicts,
//      reasons and the attempt count, visibly typed on the graph.step record
//      (ADR-0012 D7 is the node contract). Success keeps the step output the
//      schema-valid `{acs}`.
//
// Event-line discipline follows the transports, not the loop: a successful
// [G] call appends ONE FOC-449 event line (success-only appendShadow), a
// failed call appends nothing, and the escalation itself is not a provider
// call — it lands as the typed graph.step record only. The gate is A0: its
// annotation gates the node's own iteration or a STOP (the escalation hands
// to the frontman) — never an operative write (no Linear write, no
// auto-advance).
//
// The loop is NODE-INTERNAL by design: no graph edge is added and the
// stepFlow stays the linear 8-step chain — the graph-level retry EDGE is
// FOC-476's.

import { TypedError } from "./mcp/envelope.mjs";
import { DECISION_STEP, canonicalJson } from "./decision-call.mjs";
import { getRegistryEntry } from "./decision-registry.mjs";

export const AC_TESTABLE_DECISION = "plan.ac.testable";

// The testable verdict: a criterion is testable when its `noul` probability
// of true is ≥ 0.5 — the same comparison plan-gates.mjs applies to every
// noul answer (answerValueOf).
export const TESTABLE_THRESHOLD = 0.5;

// The seam's state cap (DECISION_STEP.inputSchema) bounds the composed reads
// payload the same way it bounds a [J] step's state — one number, no second
// copy of the schema.
function stateCap() {
  return DECISION_STEP.inputSchema.properties.state.maxLength;
}

/**
 * Normalize the resolved reads into the exact plan.ac payload. Pure.
 *   - `inbox.entry` is the dictated entry text (string) or the composed
 *     payload object; both normalize to {issueId, title, scopeSummary,
 *     dorFacts} with absent fields null (dorFacts null when the state has
 *     none — never invented).
 *   - `features.list` is the candidate-files array the caller retrieved.
 * The whole reads payload (all reads JSON-serialized) is bounded by the
 * seam's state cap: over it the composition fails closed BEFORE any provider
 * call — zero fetch calls, no truncation.
 * Throws TypedError("invalid_input") — the runner records it as the step's
 * typed failure.
 */
export function composeAcInputs(reads, { cap = stateCap() } = {}) {
  const entry = reads?.["inbox.entry"];
  const features = reads?.["features.list"];
  if (entry === undefined || entry === null) {
    throw new TypedError("invalid_input", 'plan.ac: the "inbox.entry" read is missing — nothing to compose from');
  }
  if (features === undefined || features === null) {
    throw new TypedError("invalid_input", 'plan.ac: the "features.list" read is missing — no candidate files composed');
  }
  const source = typeof entry === "string"
    ? { scopeSummary: entry }
    : entry && typeof entry === "object" && !Array.isArray(entry) ? entry : null;
  if (!source) {
    throw new TypedError(
      "invalid_input",
      'plan.ac: the "inbox.entry" read must be the dictated entry text or a {issueId, title, scopeSummary, dorFacts} payload',
    );
  }
  if (!Array.isArray(features)) {
    throw new TypedError("invalid_input", 'plan.ac: the "features.list" read must be the candidate-files array');
  }
  const payload = {
    issueId: typeof source.issueId === "string" && source.issueId.trim() ? source.issueId : null,
    title: typeof source.title === "string" ? source.title : null,
    scopeSummary: typeof source.scopeSummary === "string" ? source.scopeSummary : null,
    dorFacts: source.dorFacts ?? null,
  };
  if (!(typeof payload.scopeSummary === "string" && payload.scopeSummary.trim())
    && !(typeof payload.title === "string" && payload.title.trim())) {
    throw new TypedError(
      "invalid_input",
      "plan.ac: the composed entry carries neither a scope summary nor a title — nothing to generate acceptance criteria from",
    );
  }
  const composed = { "inbox.entry": payload, "features.list": features };
  const serialized = JSON.stringify(composed);
  if (serialized.length > cap) {
    throw new TypedError(
      "invalid_input",
      `plan.ac: the composed reads payload exceeds the seam's state cap (${serialized.length} > ${cap}) — `
        + "fail closed before any provider call, no truncation (AC generation from truncated DoR facts would "
        + "generate acceptance criteria from half the facts)",
    );
  }
  return { payload, candidateFiles: features, composed, serialized };
}

/**
 * Serve the plan.ac.testable gate for one generated criteria list through the
 * seam's instances channel, and return the per-criterion scores
 * [{id, text, verdict}] (verdict = the noul probability of true). Fails
 * closed — throws TypedError — when the seam call fails, the envelope is not
 * ok, or an answer is missing/malformed: a gate that cannot score can never
 * become a silent pass.
 */
async function serveTestableGate({ payload, acs, caller }) {
  const state = canonicalJson(payload);
  if (state.length > stateCap()) {
    throw new TypedError("invalid_input", `plan.ac: the gate state exceeds the seam's state cap (${state.length} > ${stateCap()})`);
  }
  const instances = acs.map((a) => ({ id: a.id, text: a.text }));
  let envelope;
  try {
    envelope = await caller({ state, decisionId: AC_TESTABLE_DECISION, instances });
  } catch (err) {
    throw new TypedError(
      err instanceof Error && err.code ? err.code : "provider_error",
      `plan.ac: the ${AC_TESTABLE_DECISION} gate call failed closed: ${err?.message || "caller threw"}`,
    );
  }
  if (!envelope.ok) {
    throw new TypedError(
      envelope.error?.code ?? "provider_error",
      `plan.ac: the ${AC_TESTABLE_DECISION} gate returned an error envelope: ${envelope.error?.message ?? "unknown"}`,
    );
  }
  const answers = envelope.annotation?.answers ?? {};
  return acs.map((a, i) => {
    const answer = answers[`ac${i}`];
    if (!answer || answer.type !== "noul" || typeof answer.noul !== "number") {
      throw new TypedError(
        "unparseable_output",
        `plan.ac: the ${AC_TESTABLE_DECISION} gate returned no usable noul verdict for criterion ${a.id}`,
      );
    }
    return { id: a.id, text: a.text, verdict: answer.noul };
  });
}

/** The gate's own false-criterion text — the reason a failing criterion carries. */
function gateFalseCriteria() {
  const template = getRegistryEntry(AC_TESTABLE_DECISION)?.questions?.["ac{i}"];
  return template?.criteria?.false ?? null;
}

function reasonFor(verdict, threshold, falseCriteria) {
  return `plan.ac.testable verdict p=${verdict} < ${threshold}`
    + (falseCriteria ? `: ${falseCriteria}` : "");
}

// The regeneration note rides the `inbox.entry` payload as a `revision` field
// (one regeneration, node-internal): the declared reads stay exactly two, and
// the note is the loop's own feedback — node-internal state, not a new
// declared input and not a sibling call's output.
const REGEN_NOTE = "One regeneration: the previous acceptance-criteria list failed the node-internal "
  + "plan.ac.testable gate for the criteria listed under failing (their verdict p fell below the "
  + "threshold — the gate judged them not concrete and checkable as written). Regenerate the FULL "
  + "list; every criterion must satisfy the gate's true criterion: concrete and checkable as written.";

/**
 * Run ONE plan.ac step execution through the node-internal testable loop.
 * Returns the step outcome — `{status:"done", output}` or
 * `{status:"failed", error, escalation?}` — the runner wraps into its
 * records; it never throws on data failures (fail-closed typed shapes), only
 * on missing wiring (a caller bug).
 */
export async function runPlanAcNode({ stepId = "plan.ac", step, reads, generator, caller, validate, threshold = TESTABLE_THRESHOLD }) {
  if (typeof generator !== "function") {
    throw new TypedError("invalid_input", "runPlanAcNode needs the [G] generator (the default transport)");
  }
  if (typeof caller !== "function") {
    throw new TypedError("invalid_input", `runPlanAcNode needs the decision-call seam caller (${AC_TESTABLE_DECISION})`);
  }
  if (typeof validate !== "function") {
    throw new TypedError("invalid_input", "runPlanAcNode needs the step's output validator");
  }
  if (!step) {
    throw new TypedError("invalid_input", "runPlanAcNode needs the plan.ac step object");
  }

  // 1. compose — over-cap or malformed reads fail closed BEFORE any provider
  //    call (zero fetch calls).
  let inputs;
  try {
    inputs = composeAcInputs(reads);
  } catch (err) {
    return { status: "failed", error: { code: err?.code ?? "invalid_input", message: err?.message ?? "composition failed" } };
  }
  const { payload, composed } = inputs;

  // 2–4. the loop: generate → score → (one regeneration) → score → escalate.
  const falseCriteria = gateFalseCriteria();
  let scores = null; // the previous attempt's per-criterion scores
  for (let attempt = 1; attempt <= 2; attempt++) {
    // The [G] call. The generator owns the transport discipline: one event
    // line on success, none on failure, typed errors on throw.
    let raw;
    try {
      raw = await generator({
        stepId,
        step,
        reads: attempt === 1 ? composed : regenReads(payload, composed, scores, threshold, falseCriteria),
      });
    } catch (err) {
      return {
        status: "failed",
        error: { code: err instanceof Error && err.code ? err.code : "provider_error", message: err?.message || "generator threw" },
      };
    }
    if (!validate(raw)) {
      return { status: "failed", error: { code: "schema_invalid", message: `[G] ${stepId} output failed the step's output schema` } };
    }

    // 3. score EVERY criterion through the gate.
    try {
      scores = await serveTestableGate({ payload, acs: raw.acs, caller });
    } catch (err) {
      return { status: "failed", error: { code: err?.code ?? "provider_error", message: err?.message ?? "gate failed" } };
    }
    const failing = scores.filter((s) => s.verdict < threshold);

    // 4. everything testable → done (attempt 1: a single call, no regen).
    if (failing.length === 0) {
      return { status: "done", output: raw, scores, attempts: attempt };
    }
    if (attempt === 2) {
      // 5. still below after the one regeneration → typed ESCALATION.
      return {
        status: "failed",
        error: {
          code: "escalated",
          message: `plan.ac: ${failing.length} of ${scores.length} criteria still below the ${AC_TESTABLE_DECISION} `
            + `threshold (${threshold}) after one regeneration — handed to the frontman`,
        },
        escalation: {
          reason: "criteria below the plan.ac.testable threshold after the one node-internal regeneration",
          attempts: 2,
          threshold,
          gate: AC_TESTABLE_DECISION,
          criteria: scores.map((s) => ({
            id: s.id,
            text: s.text,
            verdict: s.verdict,
            testable: s.verdict >= threshold,
            ...(s.verdict < threshold ? { reason: reasonFor(s.verdict, threshold, falseCriteria) } : {}),
          })),
        },
      };
    }
    // Exactly one regeneration follows — attempt 2 carries the failing
    // criteria + the gate's reasons in the reads.
  }
  // Unreachable: the loop returns on every branch (done / failed / escalate).
  throw new TypedError("provider_error", "plan.ac: the node-internal loop exited without a verdict");
}

/**
 * The regeneration reads: the SAME composed payload with a `revision` field
 * carrying the failing criteria and the gate's reasons. Payload fields are
 * caller composition (the FOC-474 precedent) — the declared reads stay
 * exactly two.
 */
function regenReads(payload, composed, previousScores, threshold, falseCriteria) {
  const failing = (previousScores ?? []).filter((s) => s.verdict < threshold);
  return {
    ...composed,
    "inbox.entry": {
      ...payload,
      revision: {
        attempt: 2,
        note: REGEN_NOTE,
        failing: failing.map((s) => ({
          id: s.id,
          text: s.text,
          verdict: s.verdict,
          reason: reasonFor(s.verdict, threshold, falseCriteria),
        })),
      },
    },
  };
}