// scripts/plan-render.mjs — FOC-520: the plan.render [D] deterministic renderer.
//
// The plan chain used to push decomposition straight to Linear: GATE 2 approved
// an abstract "the decomposition" while the issue text was composed somewhere
// else entirely. plan.render closes that gap — the issue text is rendered
// BEFORE the gate, from the same resolved reads the runner already holds, so
// the gate approves exactly the text plan.push writes (verbatim, 1:1 — no
// rewording anywhere in the chain).
//
// Pure deterministic code: the same resolved reads always render a
// byte-identical issueText. No model call, no randomness, no timestamps, no
// boundary — a [D] step's tier is null by contract. The composed text carries
// everything the ticket names: the spec summary (plan.spec), the acceptance
// criteria (plan.ac), the Definition of Done (plan.dod) and the decomposed
// task list (plan.decompose), in that order, each item in the array order the
// upstream steps produced.
//
// Fail-closed discipline (the plan-ac posture): a missing, empty or malformed
// read is a typed invalid_input error — the runner records it as the step's
// typed failure and the run stops. The renderer never guesses a missing
// section, never renders a partial issue, never truncates: a text over the
// schema's cap fails closed rather than silently clipping the DoD a reviewer
// was supposed to approve.

import { TypedError } from "./mcp/envelope.mjs";

// The issueText cap — the same number the step's output schema pins as
// maxLength (config/graph.json + config/decisions.json; the anti-drift test
// in plan-render.test.mjs keeps the two from drifting). Bounded above by the
// schema-max inputs: a 2000-char summary, 12 DoD checks, 12 ACs and 12 tasks
// with their label/relation fans-out compose to well under 30000.
export const ISSUE_TEXT_MAX = 30000;

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function stringArray(value) {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

// Fail-closed composition. Throws TypedError("invalid_input") naming the
// offending read — the runner turns it into the step's typed failure record;
// it never throws anything else and never returns a partial text.
export function composeIssueText(reads) {
  if (!reads || typeof reads !== "object" || Array.isArray(reads)) {
    throw new TypedError("invalid_input", "plan.render: the resolved reads must be an object");
  }
  const dod = reads["plan.dod.definitionOfDone"];
  const acs = reads["plan.ac.acs"];
  const summary = reads["plan.spec.summary"];
  const decompose = reads["plan.decompose.record"];

  if (!Array.isArray(dod) || dod.length === 0) {
    throw new TypedError("invalid_input", 'plan.render: the "plan.dod.definitionOfDone" read is missing or empty — a rendered issue carries its Definition of Done, never a guessed one');
  }
  for (const [i, item] of dod.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)
      || !nonEmptyString(item.check)
      || !nonEmptyString(item.kind)
      || typeof item.bounded !== "boolean") {
      throw new TypedError("invalid_input", `plan.render: the "plan.dod.definitionOfDone" read is malformed at item ${i} — each item carries {check, kind, bounded}`);
    }
  }
  if (!Array.isArray(acs) || acs.length === 0) {
    throw new TypedError("invalid_input", 'plan.render: the "plan.ac.acs" read is missing or empty — a rendered issue carries its acceptance criteria, never a guessed list');
  }
  for (const [i, item] of acs.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)
      || !nonEmptyString(item.id) || !nonEmptyString(item.text)
      || !nonEmptyString(item.kind) || !nonEmptyString(item.evidence)) {
      throw new TypedError("invalid_input", `plan.render: the "plan.ac.acs" read is malformed at item ${i} — each criterion carries {id, text, kind, evidence}`);
    }
  }
  if (!nonEmptyString(summary)) {
    throw new TypedError("invalid_input", 'plan.render: the "plan.spec.summary" read is missing or empty — nothing to summarize the issue from');
  }
  const tasks = decompose?.output?.tasks;
  if (!decompose || typeof decompose !== "object" || Array.isArray(decompose)
    || !Array.isArray(tasks) || tasks.length === 0) {
    throw new TypedError("invalid_input", 'plan.render: the "plan.decompose.record" read is missing, malformed or carries no tasks — a rendered issue carries the decomposed task list');
  }
  for (const [i, task] of tasks.entries()) {
    if (!task || typeof task !== "object" || Array.isArray(task)
      || !nonEmptyString(task.title) || !nonEmptyString(task.size)
      || !stringArray(task.labels) || !stringArray(task.relations)) {
      throw new TypedError("invalid_input", `plan.render: the "plan.decompose.record" read is malformed at task ${i} — each task carries {title, size, labels[], relations[]}`);
    }
  }

  const lines = [];
  lines.push("# Plan");
  lines.push("");
  lines.push("## Spec summary");
  lines.push("");
  lines.push(summary.trim());
  lines.push("");
  lines.push("## Acceptance criteria");
  lines.push("");
  for (const ac of acs) {
    lines.push(`- ${ac.id} (${ac.kind}, evidence: ${ac.evidence}): ${ac.text}`);
  }
  lines.push("");
  lines.push("## Definition of done");
  lines.push("");
  for (const item of dod) {
    lines.push(`- [${item.bounded ? "x" : " "}] (${item.kind}) ${item.check}`);
  }
  lines.push("");
  lines.push("## Decomposed tasks");
  lines.push("");
  for (const [i, task] of tasks.entries()) {
    const labels = task.labels.length ? task.labels.join(", ") : "none";
    const relations = task.relations.length ? task.relations.join(", ") : "none";
    lines.push(`${i + 1}. ${task.title} (size: ${task.size}; labels: ${labels}; relations: ${relations})`);
  }
  const issueText = lines.join("\n");
  if (issueText.length > ISSUE_TEXT_MAX) {
    throw new TypedError(
      "invalid_input",
      `plan.render: the composed issue text exceeds the schema cap (${issueText.length} > ${ISSUE_TEXT_MAX}) — fail closed, never truncate what the gate is asked to approve`,
    );
  }
  return issueText;
}

/**
 * Run ONE plan.render [D] step execution. Pure — no boundary, no model call.
 * Returns the step outcome — `{status:"done", output:{issueText}}` or
 * `{status:"failed", error:{code, message}}` — the runner wraps into its
 * records; it never throws on data failures (fail-closed typed shapes), only
 * on missing wiring (a validate bug).
 */
export function runPlanRenderNode({ stepId = "plan.render", reads, validate }) {
  if (typeof validate !== "function") {
    throw new TypedError("invalid_input", "runPlanRenderNode needs the step's output validator");
  }
  let issueText;
  try {
    issueText = composeIssueText(reads);
  } catch (err) {
    return { status: "failed", error: { code: err?.code ?? "invalid_input", message: err?.message ?? "composition failed" } };
  }
  const output = { issueText };
  if (!validate(output)) {
    return { status: "failed", error: { code: "schema_invalid", message: `[D] ${stepId} rendered issue text fails the step's output schema` } };
  }
  return { status: "done", output };
}