// scripts/plan-intent.mjs — FOC-515: the plan.intent [G] node.
//
// One bounded model call writes the INTERPRETATION MAP — what PLAN understood
// from the inbox entry, from where (stated, inferred or unknown) and what it
// does not know — before anything is put to Mateusz. The node writes NO
// questions: which interpretations become questions is entirely FOC-516's
// (selection by significance and uncertainty).
//
// Two things live here, both fail closed:
//
//   1. the read surface — the declared reads normalize into one bounded
//      payload, and the ROUND is derived from them (design doc §3.12: round 1
//      reads `inbox.entry`, `plan.dor.gaps` and the task type; from round 2 the
//      two gate1 fields join, so their presence in the read map IS the round
//      marker the runner already tolerates as absent);
//   2. the three [D] checks — (a) coverage, (b) presence, (c) quote fidelity —
//      plus the four rules the schema cannot express. Each check REJECTS the
//      node's output; never a warning, never a partial map. A rejection is ONE
//      retry, then the step fails (`failure: "stop"`).
//
// The fold of the round-2 answers (mapVersion store, `idMap` renumbering,
// STALE detection, no inherited confirmation) runs BEFORE these checks on
// round ≥2 inputs and is fail-closed in the same sense.
//
// Event-line discipline follows the transports, not the node: a successful [G]
// call appends ONE FOC-449 event line through the generator, a failed call
// appends nothing.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TypedError } from "./mcp/envelope.mjs";
import { DECISION_STEP } from "./decision-call.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TABLE_PATH = join(__dir, "..", "config", "intent-perspectives.json");
const DEFAULT_LABELS_PATH = join(__dir, "..", "config", "linear", "labels.json");

// The perspective catalogue — the map's coverage grid (§3.12). Order is the
// catalogue's; check (b) compares sets, not order.
export const PERSPECTIVES = ["goal", "user", "scope", "success", "constraints", "risk", "priority", "terms"];

// The task-type taxonomy is config/linear/labels.json -> groups.type.labels —
// the seven keys `plan.labels.type` pins. Loaded, never re-typed here, so a
// label rename cannot leave this node behind.
export function loadTaskTypes({ labelsPath = DEFAULT_LABELS_PATH } = {}) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(labelsPath, "utf8"));
  } catch (err) {
    throw new TypedError("invalid_input", `plan.intent: cannot read the task-type taxonomy at ${labelsPath}: ${err?.message || "unreadable"}`);
  }
  const labels = raw?.groups?.type?.labels;
  if (!Array.isArray(labels) || labels.length === 0 || labels.some((l) => typeof l !== "string" || !l.trim())) {
    throw new TypedError("invalid_input", "plan.intent: config/linear/labels.json -> groups.type.labels must be a non-empty array of names");
  }
  return [...labels];
}

/**
 * Load and validate the task-type -> required-perspectives table
 * (config/intent-perspectives.json). Fail closed on any structural problem or
 * any drift from the taxonomy: config drift is a construction failure, never a
 * mid-run surprise. The rows themselves are the editable [D] config — this
 * loader pins their SHAPES (⊆ the catalogue, ⊇ `base`, one row per taxonomy
 * key), not their content.
 */
export function loadPerspectiveTable({ path = DEFAULT_TABLE_PATH, labelsPath = DEFAULT_LABELS_PATH } = {}) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new TypedError("invalid_input", `plan.intent: cannot read the perspective table at ${path}: ${err?.message || "unreadable"}`);
  }
  const perspectives = raw?.perspectives;
  if (!Array.isArray(perspectives) || perspectives.length !== PERSPECTIVES.length
    || PERSPECTIVES.some((p) => !perspectives.includes(p)) || perspectives.some((p) => !PERSPECTIVES.includes(p))) {
    throw new TypedError("invalid_input", `plan.intent: the table's "perspectives" must be exactly the eight catalogue names ${PERSPECTIVES.join(", ")}`);
  }
  const all = raw?.sets?.all;
  const base = raw?.sets?.base;
  for (const [name, set] of [["all", all], ["base", base]]) {
    if (!Array.isArray(set) || set.some((p) => !PERSPECTIVES.includes(p)) || new Set(set).size !== set.length) {
      throw new TypedError("invalid_input", `plan.intent: the table's "sets.${name}" must be a duplicate-free list of catalogue names`);
    }
  }
  if (!base.includes("risk")) {
    // Decision 2026-09-24: `risk` is required in the internal map for EVERY
    // task type — it enters every row through `base`.
    throw new TypedError("invalid_input", 'plan.intent: the table\'s "sets.base" must carry "risk" (required for every task type)');
  }
  for (const p of all) {
    if (!base.includes(p)) {
      throw new TypedError("invalid_input", `plan.intent: "sets.base" is "sets.all" plus "risk" — "${p}" is missing from base`);
    }
  }
  const taskTypes = loadTaskTypes({ labelsPath });
  const rows = raw?.byType;
  if (!rows || typeof rows !== "object" || Array.isArray(rows)) {
    throw new TypedError("invalid_input", 'plan.intent: the table\'s "byType" must be an object of task-type rows');
  }
  const rowKeys = Object.keys(rows);
  if (rowKeys.length !== taskTypes.length || taskTypes.some((t) => !rowKeys.includes(t)) || rowKeys.some((k) => !taskTypes.includes(k))) {
    throw new TypedError(
      "invalid_input",
      `plan.intent: the table's "byType" keys must be exactly the task-type taxonomy (${taskTypes.join(", ")}) — `
        + `found (${rowKeys.join(", ")})`,
    );
  }
  for (const [type, row] of Object.entries(rows)) {
    if (!Array.isArray(row) || row.some((p) => !PERSPECTIVES.includes(p)) || new Set(row).size !== row.length) {
      throw new TypedError("invalid_input", `plan.intent: the "${type}" row must be a duplicate-free list of catalogue names`);
    }
    for (const p of base) {
      if (!row.includes(p)) {
        throw new TypedError("invalid_input", `plan.intent: the "${type}" row must carry every "base" perspective — "${p}" is missing`);
      }
    }
  }
  // The fail-closed set is DERIVED, not hand-written: the union of every type
  // row is what an unknown/absent/out-of-taxonomy type requires. A table whose
  // rows no longer span the catalogue would silently under-require, so the
  // derivation is checked here.
  const unknown = [...new Set(Object.values(rows).flat())];
  if (PERSPECTIVES.some((p) => !unknown.includes(p))) {
    throw new TypedError(
      "invalid_input",
      `plan.intent: the union of the type rows must span all eight perspectives — ${PERSPECTIVES.filter((p) => !unknown.includes(p)).join(", ")} unreachable`,
    );
  }
  return {
    perspectives: [...perspectives],
    sets: { all: [...all], base: [...base] },
    byType: Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, [...v]])),
    unknown,
  };
}

/**
 * The perspectives ONE task requires. Fail closed on the task type: an absent
 * type, the explicit `unknown`, or a value outside the taxonomy requires ALL
 * EIGHT (the union of every type row). Never a partial set, never a guess.
 */
export function requiredPerspectives(taskType, { table = loadPerspectiveTable() } = {}) {
  const type = typeof taskType === "string" ? taskType.trim() : "";
  const row = type && type !== "unknown" ? table.byType[type] : undefined;
  return {
    perspectives: row ? [...row] : [...table.unknown],
    taskType: row ? type : "unknown",
    failClosed: !row,
  };
}

// ── the read surface ────────────────────────────────────────────────────────

// The anchor set for a `quote` (answer contract): `inbox.entry`, the user's
// ACTUAL answers and explicitly ACCEPTED options from an earlier round. The
// model's own proposal never becomes `stated` by being offered, so the `about`
// snapshot — the persisted claim/option text the record ANSWERS — is never
// anchor text and is deliberately not collected here. The gate records' write
// side is FOC-517's; the contract names their content (the answer text, a
// correction's corrected content, an accepted option's text), and this
// collector is the single place to adapt when FOC-517 pins the field names.
function anchorStringsOf(value, out = []) {
  if (typeof value === "string") {
    if (value.length) out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) anchorStringsOf(item, out);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) if (k !== "about") anchorStringsOf(v, out);
  }
  return out;
}

function maxGateRound(...groups) {
  let max = 0;
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const record of group) {
      const r = record?.round;
      if (Number.isInteger(r) && r > max) max = r;
    }
  }
  return max;
}

/**
 * Normalize the resolved reads into the exact plan.intent payload. Pure, and
 * bounded by the seam's state cap — over it the composition fails closed
 * BEFORE any provider call (no truncation: an interpretation map built from
 * half the entry would assert readings the entry never made).
 *
 *   - `inbox.entry` is the dictated entry text (string) or a composed payload
 *     object; either way it is the round's anchor text.
 *   - `plan.dor.gaps` is DoR's gap list — plain strings without ids (§3.1's
 *     `{ready, gaps[≤8 × ≤200]}`), so a `covers` reference carries the gap
 *     text itself.
 *   - `intake.taskType` is the intake side's task type, or its explicit
 *     `unknown` — and it may be ABSENT in round 1 (the field is a contract to
 *     be implemented on the intake side, FOC-397). Absence is the `unknown`
 *     path, not a missing-input failure.
 *   - `gate.plan.gate1.answers` / `.corrections` join from round 2. Their
 *     presence in the read map IS the round marker.
 *
 * Throws TypedError("invalid_input") — the runner records it as the step's
 * typed failure.
 */
export function composeIntentInputs(reads, { cap = stateCap() } = {}) {
  const entry = reads?.["inbox.entry"];
  const gaps = reads?.["plan.dor.gaps"];
  if (entry === undefined || entry === null) {
    throw new TypedError("invalid_input", 'plan.intent: the "inbox.entry" read is missing — nothing to interpret');
  }
  if (!Array.isArray(gaps) || gaps.length > 8 || gaps.some((g) => typeof g !== "string" || !g.trim())) {
    throw new TypedError(
      "invalid_input",
      'plan.intent: the "plan.dor.gaps" read must be the DoR gap list — at most 8 non-empty strings',
    );
  }
  const answers = reads?.["gate.plan.gate1.answers"];
  const corrections = reads?.["gate.plan.gate1.corrections"];
  const gatePresent = "gate.plan.gate1.answers" in (reads ?? {}) || "gate.plan.gate1.corrections" in (reads ?? {});
  // Round 1 reads no gate fields; from round 2 they join. No read carries the
  // conversation's round — that bookkeeping is FOC-517's — so the number is
  // derived from the records that do reference one: the highest round this
  // fold reaches, floored at 2 whenever the gate fields are present. The
  // checks branch only on 1 vs ≥2 (check (a)'s counting rule and check (c)'s
  // anchor set), so the floor is what makes the derivation correct under
  // either numbering convention FOC-517 may pick for an answer's `round`.
  const round = gatePresent ? Math.max(2, maxGateRound(answers, corrections)) : 1;

  const anchors = anchorStringsOf(entry);
  if (round >= 2) {
    for (const record of [...(Array.isArray(answers) ? answers : []), ...(Array.isArray(corrections) ? corrections : [])]) {
      anchorStringsOf({ answer: record?.answer, corrected: record?.corrected, acceptedOptions: record?.acceptedOptions }, anchors);
    }
  }
  if (anchors.length === 0) {
    throw new TypedError(
      "invalid_input",
      'plan.intent: the "inbox.entry" read carries no text — no anchor for a "quote" and nothing to interpret',
    );
  }

  const { taskType, perspectives, failClosed } = requiredPerspectives(reads?.["intake.taskType"]);
  const payload = {
    "inbox.entry": entry,
    "plan.dor.gaps": [...gaps],
    ...(reads?.["intake.taskType"] === undefined ? {} : { "intake.taskType": reads["intake.taskType"] }),
    ...(round >= 2 ? {
      "gate.plan.gate1.answers": Array.isArray(answers) ? answers : [],
      "gate.plan.gate1.corrections": Array.isArray(corrections) ? corrections : [],
    } : {}),
  };
  const serialized = JSON.stringify(payload);
  if (serialized.length > cap) {
    throw new TypedError(
      "invalid_input",
      `plan.intent: the composed reads payload exceeds the seam's state cap (${serialized.length} > ${cap}) — `
        + "fail closed before any provider call, no truncation",
    );
  }
  return { round, taskType, required: perspectives, failClosedType: failClosed, gaps: [...gaps], anchors, payload, serialized };
}

// The seam's state cap (DECISION_STEP.inputSchema) bounds the composed reads
// payload the same way it bounds a [J] step's state — one number, no second
// copy of the schema.
function stateCap() {
  return DECISION_STEP.inputSchema.properties.state.maxLength;
}

// ── the [D] checks (fail closed) ────────────────────────────────────────────
//
// Each check REJECTS the map — never a warning. A rejected map is ONE retry,
// then the step fails (`failure: "stop"`); a partial map is never persisted.
// Every check returns `{ ok, errors }` with the errors in the order found, so
// the retry note can name them.

const isBlank = (s) => typeof s !== "string" || !s.trim();

/**
 * The four rules the schema cannot express (§3.12): exactly one
 * `recommended: true` per `options`; `reason` present iff `recommended`; every
 * `id` EXACTLY ONCE within `interpretations` (answers/corrections are keyed by
 * `IN-` id — a duplicate or alias would corrupt the round-2 fold); and no
 * blank strings anywhere in the output. The schema pins `minLength: 1`, which
 * a whitespace-only string passes — so this check trims.
 */
export function checkSchemaExternal(output) {
  const errors = [];
  const seen = new Set();
  for (const item of output?.interpretations ?? []) {
    if (seen.has(item?.id)) {
      errors.push(`interpretation id "${item?.id}" appears more than once — every id must be EXACTLY ONCE per map`);
    }
    seen.add(item?.id);
    const options = item?.options;
    if (options !== undefined) {
      const recommended = options.filter((o) => o?.recommended === true);
      if (recommended.length !== 1) {
        errors.push(`${item?.id}: options must carry EXACTLY ONE "recommended": true — found ${recommended.length}`);
      }
      for (const option of options) {
        const hasReason = option && Object.prototype.hasOwnProperty.call(option, "reason");
        if (option?.recommended === true && !hasReason) {
          errors.push(`${item?.id}: the recommended option "${option.text}" must carry a "reason"`);
        }
        if (option?.recommended !== true && hasReason) {
          errors.push(`${item?.id}: option "${option.text}" is not recommended and must not carry a "reason"`);
        }
      }
    }
  }
  for (const path of blankPaths(output)) {
    errors.push(`blank string at ${path} — no empty strings anywhere in the output`);
  }
  return { ok: errors.length === 0, errors };
}

/** Every blank string in the output, as a JSON-ish path. Iterative, bounded. */
function blankPaths(output, root = "output", out = []) {
  const stack = [[output, root]];
  while (stack.length) {
    const [value, path] = stack.pop();
    if (typeof value === "string") {
      if (isBlank(value)) out.push(path);
    } else if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) stack.push([value[i], `${path}[${i}]`]);
    } else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) stack.push([v, `${path}.${k}`]);
    }
  }
  return out;
}

/**
 * (a) coverage — every entry of `plan.dor.gaps` is `covers`-referenced by at
 * least one COUNTING interpretation. An interpretation counts when (i) its
 * `source` is `unknown` or `inferred`, or (ii) it is round ≥2 and `stated`
 * with its `quote` anchored per the answer contract (the resolved case).
 * Explicitly: round 1 counts only `unknown`/`inferred` items — a `stated`
 * item's `covers` is ignored here; from round 2, gate-anchored `stated` items
 * count too.
 *
 * Sub-check: each `covers` entry equals a `plan.dor.gaps` entry verbatim — the
 * `covers` field exists because gaps are plain strings without ids (§3.1), so
 * a reference carries the gap text itself.
 *
 * Decision 2026-09-24 (formerly F1): this confirms the FORMAL linkage only —
 * the semantic quality of each linkage is judged in the eval, not here.
 */
export function checkCoverage({ interpretations, gaps, round, anchors }) {
  const errors = [];
  const gapSet = new Set(gaps ?? []);
  for (const item of interpretations ?? []) {
    for (const ref of item?.covers ?? []) {
      if (!gapSet.has(ref)) {
        errors.push(`${item?.id}: covers "${ref}" — no such entry in plan.dor.gaps (verbatim equality)`);
      }
    }
  }
  const counts = (item) => item?.source !== "stated"
    || (round >= 2 && (item?.quote === undefined || isQuoteAnchored(item.quote, anchors)));
  const counting = (interpretations ?? []).filter(counts);
  for (const gap of gaps ?? []) {
    const hit = counting.some((item) => (item?.covers ?? []).includes(gap));
    if (!hit) {
      errors.push(`plan.dor.gaps entry "${gap}" is not covered by any COUNTING interpretation`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * (b) presence — every perspective the task-type table requires for this task
 * appears in at least one interpretation. `risk` is in every row via `base`
 * (Decision 2026-09-24: required in the internal map for every task type, no
 * question obligation).
 */
export function checkPresence({ interpretations, required }) {
  const errors = [];
  const present = new Set((interpretations ?? []).map((i) => i?.perspective));
  for (const perspective of required ?? []) {
    if (!present.has(perspective)) {
      errors.push(`required perspective "${perspective}" appears in no interpretation`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * (c) quote fidelity — every `quote` occurs verbatim in the round's anchor
 * text: `inbox.entry` alone in round 1; from round 2 `inbox.entry` plus the
 * user's actual answers and explicitly accepted options. Extended to ANY
 * present `quote` — an `inferred` quote, when present, is verbatim too (the AC
 * words the check for `stated` only; this deviation stands by Decision
 * 2026-09-24). "Verbatim" is strict substring containment with no
 * normalisation: §3.12 specifies none.
 */
export function checkQuoteFidelity({ interpretations, anchors }) {
  const errors = [];
  for (const item of interpretations ?? []) {
    const quote = item?.quote;
    if (quote === undefined) continue;
    if (!isQuoteAnchored(quote, anchors)) {
      errors.push(`${item?.id}: quote "${quote}" occurs verbatim in no anchor text of this round`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function isQuoteAnchored(quote, anchors) {
  return (anchors ?? []).some((anchor) => typeof anchor === "string" && anchor.includes(quote));
}

/**
 * Run every [D] check against one candidate map. `fold` runs FIRST on round
 * ≥2 inputs (the answer contract, fail-closed in the same sense) and is
 * expected to have already dropped whatever it found STALE.
 */
export function checkMap({ output, gaps, round, anchors, required }) {
  const checks = {
    schemaExternal: checkSchemaExternal(output),
    coverage: checkCoverage({ interpretations: output?.interpretations, gaps, round, anchors }),
    presence: checkPresence({ interpretations: output?.interpretations, required }),
    quoteFidelity: checkQuoteFidelity({ interpretations: output?.interpretations, anchors }),
  };
  const errors = Object.values(checks).flatMap((c) => c.errors);
  return { ok: errors.length === 0, errors, checks };
}

