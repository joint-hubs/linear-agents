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

  const folded = round >= 2
    ? [...(Array.isArray(answers) ? answers : []), ...(Array.isArray(corrections) ? corrections : [])]
    : [];
  const anchors = anchorSet(folded, entry);
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
 * Run every [D] check against one candidate map. The fold runs FIRST on round
 * ≥2 inputs (the answer contract, fail-closed in the same sense) and has
 * already dropped whatever it found STALE from the anchor set.
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

// ── the answer contract (the fold) ──────────────────────────────────────────
//
// What the two gate1 fields must satisfy (§3.12, closed 2026-09-24). The
// validator reads its ground truth from two IMMUTABLE run-record stores, never
// from the answer's own copy:
//
//   maps      run-record.plan.intent.maps[mapVersion] — the map exactly as
//             generated and persisted for that version, append-only per
//             conversation; a persisted version is immutable once written.
//   presented run-record.gate.plan.gate1.presented[round] — the exact items
//             and option texts actually put to the user in that round.
//
// Their write side is FOC-517's (the gate1 fields plus the §3.6 contract
// update); this side is the read and the validation. A gate record carries the
// reference triple (`round`, `mapVersion`, `interpretationId`), the `about`
// snapshot it answered, and the user's own words:
//
//   { round, mapVersion, interpretationId,
//     about: { claim, option? },
//     answer,                // the user's actual answer
//     corrected?,            // a correction's corrected content
//     acceptedOptions? }     // option texts the user explicitly accepted
//
// `about` must MATCH the persisted texts verbatim but alone validates nothing —
// a record whose `about` is right and whose triple is wrong is still STALE.

const IN_ID = /^IN-([1-9]|1[0-2])$/;

/**
 * The code's allocation at persist time: monotonic within the conversation and
 * never reused for a different map (Decision 2026-09-24). The generator's
 * `mapVersion` is a hint and must match this number — the store, not the
 * model, owns identity.
 */
export function allocateMapVersion(maps) {
  const highest = Object.keys(maps ?? {}).reduce((m, k) => {
    const n = Number(k);
    return Number.isInteger(n) && n > m ? n : m;
  }, 0);
  return highest + 1;
}

function sameText(a, b) {
  return typeof a === "string" && typeof b === "string" && a === b;
}

function sameOptions(a, b) {
  const left = (a ?? []).map((o) => o?.text);
  const right = (b ?? []).map((o) => o?.text);
  return left.length === right.length && left.every((t, i) => sameText(t, right[i]));
}

/**
 * Persist ONE map. Append-only: a version is immutable once written, so a
 * second write of the same `mapVersion` is refused rather than merged. The
 * emitted `mapVersion` is validated against the allocation above; a mismatch
 * is a rejection, never a silent renumber.
 */
export function persistMap(maps, map) {
  const store = maps ?? {};
  const allocated = allocateMapVersion(store);
  if (!map || !Number.isInteger(map.mapVersion)) {
    throw new TypedError("invalid_input", "plan.intent: the map carries no integer mapVersion to persist");
  }
  if (store[map.mapVersion] !== undefined) {
    throw new TypedError("invalid_input", `plan.intent: mapVersion ${map.mapVersion} is already persisted and immutable`);
  }
  if (map.mapVersion !== allocated) {
    throw new TypedError(
      "invalid_input",
      `plan.intent: mapVersion ${map.mapVersion} is not the next persisted version (${allocated}) — `
        + "the store allocates identity, monotonic and never reused",
    );
  }
  return { maps: { ...store, [map.mapVersion]: map }, mapVersion: map.mapVersion };
}

/**
 * The `idMap` legality rule: an entry is legal ONLY between items whose
 * content is verbatim-identical (same claim, same options where present) — it
 * is pure id translation. An entry whose target content differs is
 * CONTRACT-ILLEGAL: the fold rejects it and the reference is stale. `idMap`
 * NEVER carries a user's confirmation onto a changed claim or option.
 *
 * Renumbering happens between TWO map versions, so the old side is read from
 * the map immediately before the declaring one; with no predecessor every
 * entry is illegal (you cannot renumber from nothing).
 */
export function verifyIdMap(maps) {
  const errors = [];
  for (const key of Object.keys(maps ?? {}).sort((a, b) => Number(a) - Number(b))) {
    const version = Number(key);
    const map = maps[key];
    const idMap = map?.idMap;
    if (!idMap || Object.keys(idMap).length === 0) continue;
    const previous = maps[version - 1];
    if (!previous) {
      errors.push(`mapVersion ${version} declares an idMap with no mapVersion ${version - 1} to renumber from`);
      continue;
    }
    for (const [oldId, newId] of Object.entries(idMap)) {
      const from = (previous.interpretations ?? []).find((i) => i?.id === oldId);
      const to = (map.interpretations ?? []).find((i) => i?.id === newId);
      if (!from) {
        errors.push(`mapVersion ${version}: idMap "${oldId}" -> "${newId}" — "${oldId}" is not in mapVersion ${version - 1}`);
        continue;
      }
      if (!to) {
        errors.push(`mapVersion ${version}: idMap "${oldId}" -> "${newId}" — "${newId}" is not in mapVersion ${version}`);
        continue;
      }
      if (!sameText(from.claim, to.claim) || !sameOptions(from.options, to.options)) {
        errors.push(
          `mapVersion ${version}: idMap "${oldId}" -> "${newId}" is CONTRACT-ILLEGAL — the content is not verbatim-identical `
            + "(a renumber is pure id translation and never carries a confirmation onto a changed claim or option)",
        );
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Resolve one (mapVersion, interpretationId) pair against the persisted store.
 * An old reference resolves ONLY through its own persisted map and its `idMap`
 * chain, never into another map.
 */
export function resolveReference({ maps, mapVersion, interpretationId }) {
  const map = maps?.[mapVersion];
  if (!map) {
    return { ok: false, reason: `no persisted map for mapVersion ${mapVersion}` };
  }
  const direct = (map.interpretations ?? []).find((i) => i?.id === interpretationId);
  if (direct) return { ok: true, item: direct, mapVersion, id: interpretationId };
  // Renumbered within this map: the id the reference names is a declared
  // source of the map's own idMap, so it reaches the item the id became.
  const renumbered = map.idMap?.[interpretationId];
  const via = renumbered ? (map.interpretations ?? []).find((i) => i?.id === renumbered) : undefined;
  if (via) return { ok: true, item: via, mapVersion, id: renumbered, renumberedFrom: interpretationId };
  return { ok: false, reason: `interpretationId ${interpretationId} is not in mapVersion ${mapVersion} (nor reachable through its idMap)` };
}

/**
 * Fold the gate1 answers and corrections into the validated set. Every
 * reference must resolve AND its `about` must match the persisted claim/option
 * verbatim; anything else is STALE — detected, recorded, NOT applied. The
 * affected point must then reappear as `unknown`/`inferred` in the new map
 * (check (a) still covers it).
 */
export function foldGateAnswers({ round, maps, presented, answers = [], corrections = [] }) {
  const idMapCheck = verifyIdMap(maps);
  const valid = [];
  const stale = [];
  for (const [kind, record] of [
    ...answers.map((r) => ["answer", r]),
    ...corrections.map((r) => ["correction", r]),
  ]) {
    const triple = `${record?.round}/${record?.mapVersion}/${record?.interpretationId}`;
    const push = (reason) => stale.push({ kind, record, round: record?.round, mapVersion: record?.mapVersion, interpretationId: record?.interpretationId, reason });
    if (!Number.isInteger(record?.round) || !Number.isInteger(record?.mapVersion) || !IN_ID.test(record?.interpretationId ?? "")) {
      push("the record carries no complete (round, mapVersion, interpretationId) reference triple");
      continue;
    }
    if (record.round > round) {
      push(`the reference names round ${record.round} but the current round is ${round}`);
      continue;
    }
    if (!presented?.[record.round]) {
      push(`round ${record.round} has no presented record — nothing was actually put to the user in it`);
      continue;
    }
    if (!idMapCheck.ok) {
      push(`the maps store carries an illegal idMap (${idMapCheck.errors[0]})`);
      continue;
    }
    const resolved = resolveReference({ maps, mapVersion: record.mapVersion, interpretationId: record.interpretationId });
    if (!resolved.ok) {
      push(resolved.reason);
      continue;
    }
    const aboutClaim = record.about?.claim;
    if (!sameText(aboutClaim, resolved.item.claim)) {
      push(`about.claim does not match the persisted claim of ${record.mapVersion}/${resolved.id} verbatim`);
      continue;
    }
    const aboutOption = record.about?.option;
    if (aboutOption !== undefined) {
      const texts = (resolved.item.options ?? []).map((o) => o?.text);
      if (!texts.some((t) => sameText(t, aboutOption))) {
        push(`about.option does not match any persisted option text of ${record.mapVersion}/${resolved.id} verbatim`);
        continue;
      }
    }
    valid.push({ kind, record, mapVersion: record.mapVersion, interpretationId: resolved.id, item: resolved.item, ...(resolved.renumberedFrom ? { renumberedFrom: resolved.renumberedFrom } : {}) });
  }
  return { valid, stale, anchors: anchorSet(valid.map((v) => v.record)), idMap: idMapCheck };
}

/**
 * The round's anchor text: `inbox.entry`, the user's ACTUAL answers, and the
 * options they explicitly ACCEPTED. A model proposal never becomes `stated` by
 * being offered, so the `about` snapshot is never collected here.
 */
export function anchorSet(records, entry) {
  const out = [];
  if (entry !== undefined) anchorStringsOf(entry, out);
  for (const record of records ?? []) {
    anchorStringsOf({ answer: record?.answer, corrected: record?.corrected, acceptedOptions: record?.acceptedOptions }, out);
  }
  return out;
}

// ── the node ────────────────────────────────────────────────────────────────

const REGEN_NOTE = "One regeneration: the interpretation map below was rejected before anything reached "
  + "the user. The reasons are listed under problems. Regenerate the FULL map against the same reads, "
  + "with every problem resolved: the map is all-or-nothing and a partially valid map is never kept.";

/**
 * Run ONE plan.intent step execution: compose → fold → generate → validate →
 * persist. A rejected map is ONE retry carrying the rejection reasons and the
 * rejected map itself, then the step fails — `failure: "stop"`, one typed
 * record, never a partial map.
 *
 * `maps` / `presented` are the two immutable run-record stores of the answer
 * contract; their write side is FOC-517's (the gate1 fields) and the intake
 * side FOC-397's. In round 1 both are empty and the fold is a no-op. The
 * result carries the folded `stale` log so the run record can carry it too.
 *
 * Returns `{status:"done", output, mapVersion, maps, checks, fold, attempts}`
 * or `{status:"failed", error, checks?, fold}` — it never throws on data
 * failures (fail-closed typed shapes), only on missing wiring.
 */
export async function runPlanIntentNode({
  stepId = "plan.intent",
  step,
  reads,
  generator,
  validate,
  maps = {},
  presented = {},
} = {}) {
  if (typeof generator !== "function") {
    throw new TypedError("invalid_input", "runPlanIntentNode needs the [G] generator (the default transport)");
  }
  if (typeof validate !== "function") {
    throw new TypedError("invalid_input", "runPlanIntentNode needs the step's output validator");
  }
  if (!step) {
    throw new TypedError("invalid_input", "runPlanIntentNode needs the plan.intent step object");
  }

  // 1. compose — malformed or over-cap reads fail closed BEFORE any provider
  //    call (zero fetch calls).
  let inputs;
  try {
    inputs = composeIntentInputs(reads);
  } catch (err) {
    return { status: "failed", error: { code: err?.code ?? "invalid_input", message: err?.message ?? "composition failed" } };
  }
  const { round, gaps, required, payload } = inputs;

  // 2. the fold — round ≥2 only, and fail-closed in the same sense. Whatever
  //    it finds STALE is dropped from the anchor set, so a stale point cannot
  //    come back as `stated` and must reappear as unknown/inferred.
  let fold = { valid: [], stale: [], anchors: [], idMap: { ok: true, errors: [] } };
  if (round >= 2) {
    fold = foldGateAnswers({
      round,
      maps,
      presented,
      answers: reads?.["gate.plan.gate1.answers"] ?? [],
      corrections: reads?.["gate.plan.gate1.corrections"] ?? [],
    });
    if (!fold.idMap.ok) {
      return {
        status: "failed",
        error: { code: "invalid_input", message: `plan.intent: the maps store carries an illegal idMap — ${fold.idMap.errors[0]}` },
        fold,
      };
    }
  }
  const anchors = anchorSet(fold.valid.map((v) => v.record), reads?.["inbox.entry"]);

  // 3–4. generate → validate → (one regeneration) → validate → stop.
  let previousMap = null;
  let problems = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    let raw;
    try {
      raw = await generator({ stepId, step, reads: attempt === 1 ? payload : regenReads(payload, previousMap, problems) });
    } catch (err) {
      return {
        status: "failed",
        fold,
        error: { code: err instanceof Error && err.code ? err.code : "provider_error", message: err?.message || "generator threw" },
      };
    }

    problems = [];
    if (!validate(raw)) {
      problems.push("the map failed the step's output schema");
    } else {
      // Identity is the STORE's to allocate: monotonic, never reused. A
      // mis-numbered map is a rejection, never a silent renumber.
      const allocated = allocateMapVersion(maps);
      if (raw.mapVersion !== allocated) {
        problems.push(`mapVersion ${raw.mapVersion} is not the next persisted version (${allocated})`);
      }
      const checked = checkMap({ output: raw, gaps, round, anchors, required });
      problems.push(...checked.errors);
      if (problems.length === 0) {
        const persisted = persistMap(maps, raw);
        return {
          status: "done",
          output: raw,
          mapVersion: persisted.mapVersion,
          maps: persisted.maps,
          checks: checked.checks,
          fold,
          attempts: attempt,
          taskType: inputs.taskType,
          failClosedType: inputs.failClosedType,
        };
      }
      if (attempt === 2) {
        return { status: "failed", error: { code: "schema_invalid", message: rejectedMessage(stepId, problems) }, checks: checked.checks, fold, problems };
      }
      previousMap = raw;
      continue;
    }

    // Schema-invalid: the four [D] checks have nothing to say about a map the
    // validator already refused.
    if (attempt === 2) {
      return { status: "failed", error: { code: "schema_invalid", message: rejectedMessage(stepId, problems) }, fold, problems };
    }
    previousMap = raw;
  }
  // Unreachable: the loop returns on every branch.
  throw new TypedError("provider_error", "plan.intent: the node exited without a verdict");
}

function rejectedMessage(stepId, problems) {
  return `[G] ${stepId} map rejected after one retry (${problems.length} problem${problems.length === 1 ? "" : "s"}): ${problems.join(" | ")}`;
}

/**
 * The regeneration reads: the SAME payload with a `revision` field carrying
 * the rejection reasons and the rejected map. Payload fields are caller
 * composition (the FOC-474 precedent the plan.ac loop follows) — the declared
 * reads stay exactly five, and `inbox.entry` is left VERBATIM so the anchor
 * set cannot pick up our own feedback as quote text.
 */
function regenReads(payload, previous, problems) {
  return {
    ...payload,
    revision: {
      attempt: 2,
      note: REGEN_NOTE,
      problems: [...problems],
      previous: previous ?? null,
    },
  };
}


