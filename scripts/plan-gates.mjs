// scripts/plan-gates.mjs — the PLAN squad's registry-served gate decisions (FOC-452).
//
// Ten PLAN gate entries live in config/decisions.json: the three DoR questions
// (MAP §3A #3), the label gates (MAP §3A #4 — type, risk, estimate, ADR,
// security), the duplicate/relation check (MAP §3A #5) and the per-criterion
// AC testability judgment. This module is their serve path — SEPARATE from
// supervisor-triage.mjs, whose INTAKE_DECISIONS stay hardcoded to the intake
// ids. The PLAN runtime calls buildPlanGates with its own state text and its
// own serve-time inputs; nothing here reads an issue store, runs a search or
// touches Linear.
//
// A0 discipline (the same posture as the intake path): every decision is
// served through the seam's decisionId channel, so every answer arrives as
// the A0 envelope — annotation (answers + confidence), eventId, never an
// action flag. The annotations are recorded verbatim and DISPLAYED; a
// seam/applied disagreement (disagreementsOf + displayPlanGates) is shown
// and recordable, never auto-acted — the applied labels stay the PLAN
// squad's call.
//
// Two entries are per-instance templates served through the seam's third
// call shape {state, decisionId, questions}:
//   · plan.duplicate_of — one choice question per candidate issue; the
//     candidate list ({key, title} records, chosen by code at serve time)
//     is injected here and instantiated via the registry loader;
//   · plan.ac.testable — one noul per acceptance criterion; the AC list
//     ({id, text}) is injected the same way (FOC-475 owns the real
//     plan.ac consumer; fixture instances until then).
//
// Outcomes: when PLAN applies its labels, labelAppliedPlan ties each applied
// value back to the exact decision eventIds as FOC-449 labels — the same
// join discipline as supervisor-triage's labelRecordedIntake: the event's
// taskKey must BE this issue (a cross-issue outcome is never joined, however
// the record came to carry it), and every failure is a best-effort warning,
// never a broken plan run. Only the applied labels join here; the boolean
// gates' outcomes belong to the routing decision (plan.ready, FOC-476) and
// are deliberately not labelled by this module.
//
// All suites that exercise this module are offline: the caller is a stub or
// an injected seam, never the network.

import { readFileSync } from "node:fs";

import { SHADOW_EVENT_TYPE } from "./decision-call.mjs";
import { autoLabel, findEventFile } from "./decision-log.mjs";
import { instantiateEntryQuestions } from "./decision-registry.mjs";

// The ten PLAN gate decision ids, in serve order: DoR readiness first, then
// the label gates, then the duplicate check and the per-criterion testability.
export const PLAN_DECISIONS = [
  "plan.dor.criteria_testable",
  "plan.dor.scope_clear",
  "plan.dor.context_sufficient",
  "plan.labels.type",
  "plan.labels.risk",
  "plan.estimate",
  "plan.needs_adr",
  "plan.security_sensitive",
  "plan.duplicate_of",
  "plan.ac.testable",
];

// The label decisions whose FINAL choices become FOC-449 outcomes via
// labelAppliedPlan. The other gates have no applied-label outcome here.
export const PLAN_LABEL_DECISIONS = ["plan.labels.type", "plan.labels.risk", "plan.estimate"];

// The applied-value field of each label decision, and the t-shirt scale the
// estimate score maps to (plan.estimate answers a score 0–4; the applied
// estimate and the criteria anchors are the sizes).
const LABEL_FIELD = { "plan.labels.type": "type", "plan.labels.risk": "risk", "plan.estimate": "estimate" };
const TSHIRT_SIZES = ["XS", "S", "M", "L", "XL"];

// The seam's question cap (DECISION_STEP.inputSchema questions maxProperties):
// one question per instance, so an injected list cannot exceed it. Checked
// here for a clear message instead of a seam roundtrip.
const INSTANCE_CAP = 12;

const defaultNow = () => new Date().toISOString();

function assertInstances(name, list, fields) {
  if (!Array.isArray(list)) {
    throw new Error(`buildPlanGates: ${name} must be an array of {${fields.join(", ")}} records`);
  }
  if (list.length > INSTANCE_CAP) {
    throw new Error(`buildPlanGates: ${name} exceeds the seam's ${INSTANCE_CAP}-question cap (${list.length})`);
  }
  list.forEach((v, i) => {
    const ok = v && typeof v === "object" && !Array.isArray(v)
      && fields.every((f) => typeof v[f] === "string" && v[f].trim());
    if (!ok) {
      throw new Error(`buildPlanGates: ${name}[${i}] must carry a non-empty ${fields.join(" + ")}`);
    }
  });
}

// The seam normalizes answers into typed records (noul/choice/score); the
// comparisons and displays here read the primitive each type encodes:
// noul → its probability-of-true verdict (p ≥ 0.5), choice → the label,
// score → the number.
function answerValueOf(a) {
  if (a === null || a === undefined) return null;
  if (typeof a !== "object") return a;
  if (a.type === "noul") return typeof a.noul === "number" ? a.noul >= 0.5 : null;
  if (a.type === "choice") return typeof a.choice === "string" ? a.choice : null;
  if (a.type === "score") return typeof a.score === "number" && Number.isFinite(a.score) ? a.score : null;
  return null;
}

// The candidate whose per-candidate question was answered "duplicate" —
// the first match wins. Null when nothing was judged a duplicate.
function duplicateKeyOf(answers, candidates) {
  for (let i = 0; i < candidates.length; i++) {
    if (answerValueOf(answers[`cand${i}`]) === "duplicate") return candidates[i].key;
  }
  return null;
}

/**
 * Serve the ten PLAN gate decisions and build the annotation record. A failed
 * decision (no API key, provider error, schema refusal) is recorded as
 * ok:false with its typed code — fail-closed and visible, the plan run
 * proceeds without the annotation. The injected serve-time inputs (the
 * duplicate candidates, the acceptance criteria) are validated before any
 * call: malformed instances are a caller bug, not a decision to swallow.
 */
export async function buildPlanGates({ issue, state, caller, candidates = [], acs = [], runId = null, now = defaultNow }) {
  if (typeof issue !== "string" || !issue.trim()) {
    throw new Error("buildPlanGates needs the issue identity the decisions are served for");
  }
  if (typeof state !== "string" || !state.trim()) {
    throw new Error("buildPlanGates needs the state text (title + body, composed like supervisor-triage.stateOf)");
  }
  if (typeof caller !== "function") {
    throw new Error("buildPlanGates needs the decision-call seam caller");
  }
  assertInstances("candidates", candidates, ["key", "title"]);
  assertInstances("acs", acs, ["id", "text"]);

  const decisions = {};
  const warnings = [];
  const record = { issue, createdAt: now(), runId, decisions };

  // questionsOf is a thunk so a template-instantiation failure lands in the
  // per-decision record (fail-closed, visible) instead of aborting the serve.
  const serve = async (decisionId, questionsOf = null) => {
    try {
      const questions = questionsOf ? questionsOf() : undefined;
      const envelope = questions
        ? await caller({ state, decisionId, questions })
        : await caller({ state, decisionId });
      if (!envelope.ok) {
        decisions[decisionId] = {
          ok: false,
          code: envelope.error?.code ?? null,
          message: envelope.error?.message ?? null,
          ...(envelope.eventId ? { eventId: envelope.eventId } : {}),
        };
        warnings.push(`${decisionId} failed closed (${envelope.error?.code ?? "error"}) — the plan run proceeds without the annotation`);
        return;
      }
      const answers = envelope.annotation?.answers ?? {};
      if (decisionId === "plan.duplicate_of") {
        decisions[decisionId] = {
          ok: true,
          answers,
          confidence: envelope.annotation?.confidence ?? null,
          eventId: envelope.eventId ?? null,
          duplicateOf: duplicateKeyOf(answers, candidates),
        };
      } else if (decisionId === "plan.ac.testable") {
        decisions[decisionId] = {
          ok: true,
          answers,
          confidence: envelope.annotation?.confidence ?? null,
          eventId: envelope.eventId ?? null,
        };
      } else {
        decisions[decisionId] = {
          ok: true,
          answer: Object.values(answers)[0] ?? null,
          confidence: envelope.annotation?.confidence ?? null,
          eventId: envelope.eventId ?? null,
        };
      }
    } catch (err) {
      decisions[decisionId] = { ok: false, code: err?.code ?? null, message: err?.message ?? null };
      warnings.push(`${decisionId} failed closed (${err?.code ?? "error"}) — the plan run proceeds without the annotation`);
    }
  };

  for (const decisionId of PLAN_DECISIONS) {
    if (decisionId === "plan.duplicate_of") {
      if (!candidates.length) {
        decisions[decisionId] = { ok: false, code: "no_candidates", message: "no duplicate candidates injected — nothing to judge against" };
        warnings.push("plan.duplicate_of skipped — no candidates injected");
        continue;
      }
      await serve(decisionId, () => instantiateEntryQuestions(decisionId, candidates));
      continue;
    }
    if (decisionId === "plan.ac.testable") {
      if (!acs.length) {
        decisions[decisionId] = { ok: false, code: "no_acs", message: "no acceptance criteria injected — nothing to judge" };
        warnings.push("plan.ac.testable skipped — no acceptance criteria injected");
        continue;
      }
      await serve(decisionId, () => instantiateEntryQuestions(decisionId, acs));
      continue;
    }
    await serve(decisionId);
  }

  return { record, warnings };
}

// The seam value a disagreement view reads for one label decision. plan.estimate
// answers a score; the comparison and the display use the t-shirt size both
// sides share — a score outside 0–4 has no size and cannot be compared.
function seamValueOf(decisionId, answer) {
  if (decisionId === "plan.estimate") {
    const score = answerValueOf(answer);
    return Number.isInteger(score) && score >= 0 && score < TSHIRT_SIZES.length ? TSHIRT_SIZES[score] : null;
  }
  const v = answerValueOf(answer);
  return typeof v === "string" && v.trim() ? v : null;
}

/**
 * The seam/applied disagreements for the label decisions: where the seam's
 * annotation differs from the value PLAN actually applied. Pure — the caller
 * decides whether to display (displayPlanGates) and record the result. Risk
 * reads its applied value as the config group does: no applied label IS the
 * "none" answer. An incomparable side (failed decision, out-of-range score,
 * absent field) is skipped, never invented into agreement.
 */
export function disagreementsOf(record, applied) {
  const out = [];
  if (!record || !applied || typeof applied !== "object") return out;
  for (const [decisionId, field] of Object.entries(LABEL_FIELD)) {
    const d = record.decisions?.[decisionId];
    if (!d?.ok) continue;
    const seam = seamValueOf(decisionId, d.answer);
    if (seam === null) continue;
    const value = applied[field];
    const appliedValue = decisionId === "plan.labels.risk" && value == null ? "none" : value;
    if (typeof appliedValue !== "string" || !appliedValue.trim()) continue;
    if (seam !== appliedValue) out.push({ decisionId, seam, applied: appliedValue });
  }
  return out;
}

/**
 * A0 display: each disagreement is announced on stderr — displayed, never
 * auto-acted — and returned so the caller can record it. Nothing here
 * changes an applied value or re-routes anything.
 */
export function displayPlanGates(record, applied = null) {
  const shown = disagreementsOf(record, applied);
  for (const d of shown) {
    console.error(
      `[plan-gates] A0 disagreement — seam ${d.decisionId} says "${d.seam}", ` +
        `the applied value is "${d.applied}": displayed, never auto-acted`,
    );
  }
  return shown;
}

// The taskKey of the run-log event an eventId points at — the issue the
// decision call actually served. Null when the event carries none; an event
// that is nowhere throws, and the caller turns that into the same
// unknown-event warning the label write would have produced.
function eventTaskKeyOf(eventId, { runId = null, runsDir } = {}) {
  const { path } = findEventFile(eventId, { runId, runsDir });
  const line = readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .find((l) => l?.type === SHADOW_EVENT_TYPE && l?.eventId === eventId);
  return line?.taskKey ?? null;
}

// The applied value an outcome labels, in the decision's own criteria
// vocabulary: type → the type:* suffix, risk → "high" or "none" (an explicit
// null means no risk label was applied — that IS the none answer; an absent
// field labels nothing), estimate → the t-shirt size. Nothing to label → null.
function outcomeFor(decisionId, applied) {
  if (!applied || typeof applied !== "object") return null;
  const value = applied[LABEL_FIELD[decisionId]];
  if (decisionId === "plan.labels.risk") {
    if (value === null) return "none";
    return typeof value === "string" && value.trim() ? value : null;
  }
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * The final-choice auto-join (FOC-449): the labels PLAN applied are the
 * OUTCOMES the label-gate events train against, so each applied value is
 * labelled tied to the exact eventId its decision call carried. Before
 * anything is written, every event is checked against the issue being
 * planned — its taskKey must BE this issue, or the label is skipped with a
 * warning: an outcome must never be joined to another issue's decision
 * event, however the record came to carry it. Fail-closed on the pairing,
 * best-effort by contract — a failed label (unknown event, unwritable log)
 * is a warning, never a broken plan run. No eventId or no applied value →
 * nothing labelled for that decision.
 */
export function labelAppliedPlan({ record, applied, issue, runsDir } = {}) {
  if (typeof issue !== "string" || !issue.trim()) {
    throw new Error(
      "labelAppliedPlan needs the issue being planned — the eventId→issue pairing cannot be verified without it",
    );
  }
  const decisions = record?.decisions ?? {};
  const runId = record?.runId ?? null;
  const labelled = [];
  const warnings = [];
  for (const decisionId of PLAN_LABEL_DECISIONS) {
    const outcome = outcomeFor(decisionId, applied);
    if (outcome === null) continue;
    const d = decisions[decisionId];
    if (!d?.eventId) continue;
    let taskKey = null;
    try {
      taskKey = eventTaskKeyOf(d.eventId, { runId, runsDir });
    } catch (err) {
      warnings.push(`decision label for event ${d.eventId} was not written: ${err.message}`);
      continue;
    }
    if (taskKey !== issue) {
      warnings.push(
        `decision label for event ${d.eventId} was not written: its taskKey is "${taskKey ?? "missing"}", ` +
          `not "${issue}" — a cross-issue outcome is never joined`,
      );
      continue;
    }
    const res = autoLabel([{ eventId: d.eventId, runId }], {
      outcome,
      by: "agent",
      via: "labels",
      ...(runsDir ? { runsDir } : {}),
    });
    labelled.push(...res.labelled);
    warnings.push(...res.warnings);
  }
  return { labelled, warnings };
}
