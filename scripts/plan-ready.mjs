// scripts/plan-ready.mjs — FOC-476: the plan.ready [J] step (the readiness gate).
//
// The PLAN chain used to flow plan.spec → plan.decompose unchecked: nothing
// judged whether the DoD, the acceptance criteria and the spec are consistent
// with the CONFIRMED intent before decomposition. plan.ready closes that gap —
// one seam call per attempt (the plan.readiness transport entry, the
// plan.ac ↔ plan.ac.testable precedent: the node entry carries the D7
// contract, the transport entry carries the question set) judges the three
// artefacts as a whole AND every confirmed intent item for coverage (FOC-517
// intent coverage: the "q{i}" template fans out one question per confirmed
// item; Jev receives the already-filtered artefacts — record views and the
// confirmed map — never the raw repo or run state).
//
// Verdict → routing (the step-level decide edge, config/graph.json stepFlow):
//   ready:true                       → the chain continues to plan.decompose
//   ready:false, attempt 1           → flow back to output.failedStep
//                                      (an uncovered item's perspective
//                                      "success" names plan.dod, "scope"
//                                      plan.ac, everything else — and a
//                                      base-verdict miss with every item
//                                      covered — plan.spec); the runner
//                                      re-executes that step and re-asks
//   ready:false, attempt 2           → escalate typed (readiness_escalated) —
//                                      the SECOND ready:false in a run
//                                      escalates regardless of which step
//                                      produced it (over-escalation is
//                                      fail-safe; it kills the infinite
//                                      dod→ac→spec loop). Never a silent
//                                      default.
//
// The attempt counter persists per run (<run dir>/plan-ready.retries.json) so
// the retry budget survives process restarts; a corrupt counter fails closed.
// Outcomes are labelled next to the seam event (FOC-449, best-effort — a
// failed label is a warning on the record, never a broken primary flow):
// plan.ready.true / plan.ready.false, plus the stage markers
// plan.ready.first / plan.ready.retry / plan.ready.escalated.
//
// Fail-closed discipline (the plan-ac posture): a missing or malformed read,
// a state over the seam's cap, a non-noul answer or a corrupt counter is a
// typed error the runner records as the step's typed failure — the step never
// guesses, never truncates, never invents a verdict.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { TypedError } from "./mcp/envelope.mjs";
import { canonicalJson, DECISION_STEP } from "./decision-call.mjs";
import { appendLabel } from "./decision-log.mjs";

export const PLAN_READY_STEP = "plan.ready";
export const PLAN_READINESS_DECISION = "plan.readiness";

// Retry-then-escalate: ONE retry (the first ready:false flows back), the
// SECOND ready:false in the same run escalates. Fail-safe over-escalation —
// a budget drift can only ever escalate EARLIER, never loop.
export const READY_MAX_ATTEMPTS = 2;

// The noul threshold a verdict must clear: the base "ready" answer and every
// per-item coverage answer. Below it counts as false — a maybe is not a yes.
export const READY_NOUL_MIN = 0.5;

// The retry-counter file lives NEXT TO the run store (.state/runs/<runId>/),
// so the budget is per run by construction and dies with the run directory.
export function readyRetriesPathFor(storePath) {
  return join(dirname(storePath), "plan-ready.retries.json");
}

// An uncovered item's perspective picks the step that must redo its work:
// "success" belongs to the DoD, "scope" to the acceptance criteria, every
// other perspective (risk, constraints, terms, …) to the spec.
export function failedStepFor(perspective) {
  if (perspective === "success") return "plan.dod";
  if (perspective === "scope") return "plan.ac";
  return "plan.spec";
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isNoul(value) {
  return Boolean(value) && typeof value === "object" && value.type === "noul"
    && typeof value.noul === "number" && Number.isFinite(value.noul) && value.noul >= 0 && value.noul <= 1;
}

// The confirmed-intent item a coverage question is asked about — exactly the
// {{id}} / {{claim}} / {{perspective}} vars the q{i} template substitutes.
function instanceOf(item) {
  return { id: item.id, claim: item.claim, perspective: item.perspective };
}

/**
 * Compose the seam call's inputs from the step's resolved reads. Fail-closed:
 * a missing or malformed read throws TypedError("invalid_input") naming the
 * offending read — the runner records it as the step's typed failure; it
 * never guesses a section and never truncates.
 *
 * The reads are record VIEWS (resolveRead's ".record" shape: {stepId, status,
 * output}) plus the derived plan.intent.confirmed record — the already-filtered
 * state, never the raw inbox entry or a run input.
 */
export function composeReadyInputs(reads) {
  if (!reads || typeof reads !== "object" || Array.isArray(reads)) {
    throw new TypedError("invalid_input", "plan.ready: the resolved reads must be an object");
  }
  const confirmed = reads["plan.intent.confirmed"];
  if (!confirmed || typeof confirmed !== "object" || Array.isArray(confirmed)
    || !nonEmptyString(confirmed.goal) || !Array.isArray(confirmed.interpretations)) {
    throw new TypedError("invalid_input", 'plan.ready: the "plan.intent.confirmed" read is missing or malformed — readiness is judged against the confirmed intent, never an unconfirmed map');
  }
  const items = confirmed.interpretations;
  if (items.length > 12) {
    throw new TypedError("invalid_input", `plan.ready: ${items.length} confirmed intent items exceeds the seam's instance cap (12) — fail closed, never truncate the coverage check`);
  }
  for (const [i, item] of items.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)
      || !nonEmptyString(item.id) || !nonEmptyString(item.claim) || !nonEmptyString(item.perspective)) {
      throw new TypedError("invalid_input", `plan.ready: the confirmed intent is malformed at item ${i} — each item carries {id, claim, perspective}`);
    }
  }
  const recordRead = (read, fields) => {
    const record = reads[read];
    if (!record || typeof record !== "object" || Array.isArray(record)
      || !nonEmptyString(record.status) || !record.output || typeof record.output !== "object") {
      throw new TypedError("invalid_input", `plan.ready: the "${read}" read is missing or malformed — a record view carries {status, output}`);
    }
    for (const field of fields) {
      const value = record.output[field];
      const ok = Array.isArray(value) ? value.length > 0 : nonEmptyString(value);
      if (!ok) {
        throw new TypedError("invalid_input", `plan.ready: the "${read}" read carries no usable "${field}" — a done record carries the step's full output`);
      }
    }
    return record;
  };
  const dod = recordRead("plan.dod.record", ["definitionOfDone"]);
  const ac = recordRead("plan.ac.record", ["acs"]);
  const spec = recordRead("plan.spec.record", ["summary"]);

  const payload = {
    artifacts: {
      dod: { status: dod.status, definitionOfDone: dod.output.definitionOfDone },
      ac: { status: ac.status, acs: ac.output.acs },
      spec: { status: spec.status, briefs: spec.output.briefs ?? null, adr: spec.output.adr ?? null, summary: spec.output.summary },
    },
    intent: {
      goal: confirmed.goal,
      why: confirmed.why ?? null,
      mapVersion: confirmed.mapVersion ?? null,
      items: items.map(instanceOf),
    },
  };
  const cap = DECISION_STEP.inputSchema.properties.state.maxLength;
  const state = canonicalJson(payload);
  if (state.length > cap) {
    throw new TypedError("invalid_input", `plan.ready: the composed state exceeds the seam's state cap (${state.length} > ${cap}) — fail closed, never truncate what readiness is judged on`);
  }
  return { payload, instances: items.map(instanceOf), state };
}

/**
 * The deterministic verdict over the seam's answers. noul ≥ 0.5 counts as
 * true; the first uncovered item routes the decide edge, a base-verdict miss
 * with every item covered is the plan.spec catch-all.
 */
export function readyVerdict({ base, instances, itemAnswers }) {
  const uncovered = [];
  instances.forEach((item, i) => {
    if (itemAnswers[i].noul < READY_NOUL_MIN) uncovered.push(item);
  });
  if (base.noul >= READY_NOUL_MIN && uncovered.length === 0) {
    return {
      ready: true,
      failedStep: "none",
      reason: `the DoD, the ACs and the spec read consistent and ready; all ${instances.length} confirmed intent item(s) covered`,
    };
  }
  if (uncovered.length > 0) {
    const first = uncovered[0];
    const more = uncovered.length - 1;
    return {
      ready: false,
      failedStep: failedStepFor(first.perspective),
      reason: capReason(`confirmed intent item ${first.id} (${first.perspective}) is uncovered: "${first.claim}"${more ? ` (+${more} more uncovered item(s))` : ""}`),
    };
  }
  return {
    ready: false,
    failedStep: "plan.spec",
    reason: capReason(`the artefacts do not read ready as a whole (verdict ${base.noul}) although every confirmed intent item is covered — re-check the spec and the artefacts' consistency`),
  };
}

// The step's output schema caps the reason at 300 — slice deterministically
// rather than fail a verdict over prose length.
function capReason(reason) {
  return reason.length > 300 ? reason.slice(0, 300) : reason;
}

/**
 * ONE plan.readiness seam call: state in, answers + confidence out. Throws
 * TypedError on a failed/caller-thrown/error-envelope call and on any answer
 * that is not a usable noul verdict (fail closed — never an invented answer).
 */
export async function serveReadiness({ reads, caller }) {
  const { instances, state } = composeReadyInputs(reads);
  let envelope;
  try {
    envelope = await caller({ state, decisionId: PLAN_READINESS_DECISION, instances });
  } catch (err) {
    throw new TypedError(
      err instanceof Error && err.code ? err.code : "provider_error",
      `plan.ready: the ${PLAN_READINESS_DECISION} call failed closed: ${err?.message || "caller threw"}`,
    );
  }
  if (!envelope?.ok) {
    throw new TypedError(
      envelope?.error?.code ?? "provider_error",
      `plan.ready: the ${PLAN_READINESS_DECISION} call returned an error envelope: ${envelope?.error?.message ?? "unknown"}`,
    );
  }
  const answers = envelope.annotation?.answers ?? {};
  if (!isNoul(answers.ready)) {
    throw new TypedError("unparseable_output", `plan.ready: the ${PLAN_READINESS_DECISION} answer carries no usable "ready" noul verdict — fail closed, never an invented readiness`);
  }
  const itemAnswers = instances.map((_, i) => {
    const answer = answers[`q${i}`];
    if (!isNoul(answer)) {
      throw new TypedError("unparseable_output", `plan.ready: the ${PLAN_READINESS_DECISION} answer carries no usable "q${i}" noul verdict for confirmed item ${instances[i].id}`);
    }
    return answer;
  });
  return {
    verdict: readyVerdict({ base: answers.ready, instances, itemAnswers }),
    eventId: envelope.eventId ?? null,
    confidence: envelope.annotation?.confidence ?? null,
  };
}

// ── the attempt counter (per run) ────────────────────────────────────────────
// { attempts: n } next to the run store. Absent file = no attempt yet; a
// corrupt file fails closed — a counter nobody can parse must not silently
// reset the escalation budget.

function readAttempts(retriesPath) {
  let raw;
  try {
    raw = readFileSync(retriesPath, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return 0;
    throw new TypedError("provider_error", `plan.ready: the retry counter is unreadable: ${err?.message || "read failed"}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TypedError("provider_error", "plan.ready: the retry counter is corrupt — not JSON; the retry budget must not silently reset");
  }
  if (!parsed || typeof parsed !== "object" || !Number.isInteger(parsed.attempts) || parsed.attempts < 0) {
    throw new TypedError("provider_error", "plan.ready: the retry counter is corrupt — no usable attempts count");
  }
  return parsed.attempts;
}

function writeAttempts(retriesPath, attempts, now) {
  try {
    writeFileSync(retriesPath, `${JSON.stringify({ attempts, ts: now() })}\n`, "utf8");
  } catch (err) {
    throw new TypedError("provider_error", `plan.ready: the retry counter could not be written: ${err?.message || "write failed"}`);
  }
}

// ── FOC-449 labels (best-effort) ─────────────────────────────────────────────
// One label per outcome, next to the seam event. No eventId → nothing to
// anchor on: nothing labelled, nothing warned (the A0 annotation contract).

function writeLabel({ eventId, outcome, runId, runsDir }) {
  if (!eventId) return null;
  try {
    const res = appendLabel({ eventId, outcome, by: "agent", source: "auto", via: "seam", runId, runsDir });
    return { outcome, written: res.path };
  } catch (err) {
    return { outcome, warning: err?.message ?? "label write failed" };
  }
}

// Verdict label + the stage marker: the first ready:false is "first", a
// ready:true on a later attempt is "retry", a spent budget is "escalated".
function attemptOutcomes(attempt, ready) {
  if (ready) {
    return attempt > 1 ? ["plan.ready.true", "plan.ready.retry"] : ["plan.ready.true"];
  }
  return attempt >= READY_MAX_ATTEMPTS
    ? ["plan.ready.false", "plan.ready.escalated"]
    : ["plan.ready.false", "plan.ready.first"];
}

/**
 * Run ONE plan.ready [J] step attempt. Never throws on data failures (the
 * runner records the typed failure) — only on missing wiring. Returns:
 *   {status:"done",     output, eventId, confidence, attempt, labels, labelWarnings}
 *   {status:"escalate", output, attempt, escalation, …}  — the SECOND ready:false
 *   {status:"retry",    output, failedStep, attempt, …}  — the FIRST ready:false;
 *                                             the retry counter is persisted
 *   {status:"failed",   error:{code, message}}
 * The runner wraps these into the run records; it is the only store writer.
 */
export async function runPlanReadyNode({
  stepId = PLAN_READY_STEP,
  reads,
  caller,
  validate,
  retriesPath,
  runId,
  decisionRunsDir,
  now = () => new Date().toISOString(),
}) {
  if (typeof caller !== "function") {
    throw new TypedError("invalid_input", "runPlanReadyNode needs the seam caller");
  }
  if (typeof validate !== "function") {
    throw new TypedError("invalid_input", "runPlanReadyNode needs the step's output validator");
  }
  if (typeof retriesPath !== "string" || !retriesPath.trim()) {
    throw new TypedError("invalid_input", "runPlanReadyNode needs the retry-counter path (per run dir)");
  }
  let attempt;
  try {
    attempt = readAttempts(retriesPath) + 1;
  } catch (err) {
    return { status: "failed", error: { code: err?.code ?? "provider_error", message: err?.message ?? "counter read failed" } };
  }

  let served;
  try {
    served = await serveReadiness({ reads, caller });
  } catch (err) {
    return { status: "failed", error: { code: err?.code ?? "provider_error", message: err?.message ?? "readiness call failed" } };
  }

  const output = {
    ready: served.verdict.ready,
    failedStep: served.verdict.failedStep,
    reason: served.verdict.reason,
  };
  if (!validate(output)) {
    return { status: "failed", error: { code: "schema_invalid", message: `[J] ${stepId} output fails the step's output schema` } };
  }

  const base = {
    output,
    eventId: served.eventId ?? null,
    confidence: served.confidence ?? null,
    attempt,
  };
  const labelResults = attemptOutcomes(attempt, output.ready)
    .map((outcome) => writeLabel({ eventId: served.eventId, outcome, runId, runsDir: decisionRunsDir }))
    .filter(Boolean);
  const labels = labelResults.filter((r) => !r.warning).map((r) => r.outcome);
  const labelWarnings = labelResults.filter((r) => r.warning).map((r) => `${r.outcome}: ${r.warning}`);
  const extras = {
    ...base,
    labels,
    labelWarnings,
  };

  if (output.ready) {
    return { status: "done", ...extras };
  }
  if (attempt >= READY_MAX_ATTEMPTS) {
    return {
      status: "escalate",
      ...extras,
      escalation: {
        reason: "second ready:false in this run — the readiness retry budget is spent (over-escalation is fail-safe)",
        failedStep: output.failedStep,
      },
    };
  }
  try {
    writeAttempts(retriesPath, attempt, now);
  } catch (err) {
    return { status: "failed", error: { code: err?.code ?? "provider_error", message: err?.message ?? "counter write failed" } };
  }
  return { status: "retry", ...extras, failedStep: output.failedStep };
}
