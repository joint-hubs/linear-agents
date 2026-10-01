// scripts/plan-intent-select.mjs — FOC-516: the plan.intent.select [G] node.
//
// plan.intent writes the INTERPRETATION MAP but no questions (§3.12); THIS node
// decides what PLAN puts to Mateusz from it — which points become questions
// with options, which become confirmations ("Założyłem X — dobrze?"), which
// become "Rozumiem tak" lines, and which are listed as assumptions. It mirrors
// the plan.ac + plan.ac.testable pattern: a [G] step whose node carries a
// node-internal [J] seam call, here plan.intent.select.score (one call per
// map, two noul verdicts per interpretation through the instances channel —
// impact{i} and grounded{i}).
//
// The node itself makes NO [G] model call: selection is deterministic code
// over the map plus the two [J] verdicts per item. Every policy-shaped
// decision — the routing table, the per-round question cap, the ordering and
// the dedupe flag — lives in config/intent-select-policy.json and is consumed
// here (loadSelectPolicy); nothing policy-like is hardcoded in this module or
// in any [J] prompt.
//
// A0 discipline, twice over: the [J] scores are annotations that feed the
// routing and are recorded verbatim (never auto-acted — the gate is the
// action), and the selection itself only routes DISPLAY — every item of the
// map stays visible in the selection record (asked, confirmed, understood or
// assumption). Never dropped: an item overflowing the question cap falls to
// the assumptions with a reason naming the cap rank.
//
// Event-line discipline follows the transports: the node-internal [J] call
// appends ONE FOC-449 event line through the seam caller on success and
// nothing on failure; the selection itself is not a provider call.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TypedError } from "./mcp/envelope.mjs";
import { DECISION_STEP, canonicalJson } from "./decision-call.mjs";
import { labelRecord } from "./decision-log.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
export const SELECT_POLICY_PATH = join(__dir, "..", "config", "intent-select-policy.json");

// The node-internal scoring decision — the same seam the plan.ac.testable gate
// rides, addressed by registry id so provenance and autonomy stay the
// registry's.
export const SELECT_SCORE_DECISION = "plan.intent.select.score";

// The route vocabulary the policy's table must speak. A route the config names
// that is not one of these is a config failure, never a guessed fallback.
export const SELECT_ROUTES = ["question", "confirm", "understood", "assumption"];

// The impact split: a noul verdict at p ≥ 0.5 reads "high" — the same
// comparison plan-gates.mjs applies to every noul answer (answerValueOf).
export const IMPACT_THRESHOLD = 0.5;

function stateCap() {
  return DECISION_STEP.inputSchema.properties.state.maxLength;
}

// ── the policy (config/intent-select-policy.json) ────────────────────────────

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Load and validate the selection policy. Fail closed on any structural
 * problem: config drift is a construction failure, never a mid-run surprise.
 * The rows are the editable config — this loader pins their SHAPES (route
 * names ⊆ the vocabulary, exactly one impact/grounding split per source row),
 * never their content.
 */
export function loadSelectPolicy({ path = SELECT_POLICY_PATH } = {}) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new TypedError("invalid_input", `plan.intent.select: cannot read the selection policy at ${path}: ${err?.message || "unreadable"}`);
  }
  if (!isPlainObject(raw)) {
    throw new TypedError("invalid_input", "plan.intent.select: the selection policy must be a JSON object");
  }
  if (!Number.isInteger(raw.cap?.questions) || raw.cap.questions < 1 || raw.cap.questions > 12) {
    throw new TypedError("invalid_input", 'plan.intent.select: the policy\'s "cap.questions" must be an integer between 1 and 12');
  }
  if (raw.dedupe !== true && raw.dedupe !== false) {
    throw new TypedError("invalid_input", 'plan.intent.select: the policy\'s "dedupe" must be a boolean');
  }
  if (raw.ordering !== "impactProbability") {
    throw new TypedError("invalid_input", 'plan.intent.select: the policy\'s "ordering" must be "impactProbability" — questions and confirmations rank by the impact verdict');
  }
  const alt = raw.alternatives;
  if (!isPlainObject(alt) || !Number.isInteger(alt.min) || alt.min < 2
    || alt.route !== "question" || alt.overridesTable !== true) {
    throw new TypedError(
      "invalid_input",
      'plan.intent.select: the policy\'s "alternatives" must be {min: integer >= 2, route: "question", overridesTable: true} — two or more alternative readings always force a question carrying them as options',
    );
  }
  const routes = raw.routes;
  if (!isPlainObject(routes) || !isPlainObject(routes.unknown) || !isPlainObject(routes.inferred) || !isPlainObject(routes.stated)) {
    throw new TypedError("invalid_input", 'plan.intent.select: the policy\'s "routes" must carry unknown, inferred and stated rows');
  }
  const validRoute = (r) => SELECT_ROUTES.includes(r);
  const validSplit = (row, label) => {
    if (!isPlainObject(row) || !validRoute(row.high) || !validRoute(row.low)) {
      throw new TypedError("invalid_input", `plan.intent.select: the policy's routes.${label} row must map "high" and "low" to route names (${SELECT_ROUTES.join(", ")})`);
    }
  };
  validSplit(routes.unknown, "unknown");
  validSplit(routes.inferred, "inferred");
  if (!validRoute(routes.stated["grounded-yes"])) {
    throw new TypedError("invalid_input", 'plan.intent.select: the policy\'s routes.stated row must map "grounded-yes" to a route name');
  }
  validSplit(routes.stated["grounded-no"], "stated.grounded-no");
  return {
    capQuestions: raw.cap.questions,
    dedupe: raw.dedupe,
    ordering: raw.ordering,
    alternatives: { min: alt.min, route: alt.route, overridesTable: true },
    routes: {
      unknown: { high: routes.unknown.high, low: routes.unknown.low },
      inferred: { high: routes.inferred.high, low: routes.inferred.low },
      stated: {
        groundedYes: routes.stated["grounded-yes"],
        groundedNo: { high: routes.stated["grounded-no"].high, low: routes.stated["grounded-no"].low },
      },
    },
  };
}

// ── the read surface ─────────────────────────────────────────────────────────

const IN_ID = /^IN-([1-9]|1[0-2])$/;
const SOURCES = ["stated", "inferred", "unknown"];

/**
 * Normalize the resolved reads into the selection payload. Pure, fail closed.
 *   - `plan.intent.record` is the record view of the map step (resolveRead):
 *     status must be "done" and its output must carry the persisted map
 *     (mapVersion + interpretations). A missing, failed or malformed record
 *     fails the step — a selection over half a map would silently hide items.
 *   - `gate.plan.gate1.answers` / `.corrections` are round-dependent and ABSENT
 *     in round 1 — absence is the round marker, not a missing-input failure.
 *     When present they must be arrays of record objects; the record shape
 *     inside is provisional (the write side is FOC-517's), so this composition
 *     reads only the fields dedupe needs (about.claim) and leaves deeper
 *     validation to the fold upstream.
 *   - the record's fold `stale` log (carried on the record view when
 *     non-empty) marks answers the fold REFUSED — their claims are excluded
 *     from the dedupe evidence, so a refused answer can never silently remove
 *     the point it was about.
 */
export function composeSelectInputs(reads) {
  const record = reads?.["plan.intent.record"];
  if (record === undefined || record === null) {
    throw new TypedError("invalid_input", 'plan.intent.select: the "plan.intent.record" read is missing — nothing to select from');
  }
  if (!isPlainObject(record) || record.status !== "done" || !isPlainObject(record.output)) {
    throw new TypedError("invalid_input", 'plan.intent.select: the "plan.intent.record" read is not a DONE record view — a selection runs only over a persisted map');
  }
  const map = record.output;
  if (!Number.isInteger(map.mapVersion) || map.mapVersion < 1) {
    throw new TypedError("invalid_input", 'plan.intent.select: the map record carries no integer "mapVersion"');
  }
  const items = map.interpretations;
  if (!Array.isArray(items) || items.length === 0) {
    throw new TypedError("invalid_input", 'plan.intent.select: the map record carries no interpretations — nothing to select from');
  }
  for (const [i, item] of items.entries()) {
    if (!isPlainObject(item) || !IN_ID.test(item.id ?? "") || !SOURCES.includes(item.source)
      || typeof item.claim !== "string" || !item.claim.trim() || !Array.isArray(item.alternatives)) {
      throw new TypedError("invalid_input", `plan.intent.select: interpretation ${i} is not a well-formed map item (id, claim, source, alternatives)`);
    }
  }

  const gateRead = (name) => {
    const value = reads?.[name];
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((r) => !isPlainObject(r))) {
      throw new TypedError("invalid_input", `plan.intent.select: the "${name}" read must be an array of answer records`);
    }
    return value;
  };
  const answers = gateRead("gate.plan.gate1.answers");
  const corrections = gateRead("gate.plan.gate1.corrections");

  const staleClaims = new Set();
  for (const stale of Array.isArray(record.stale) ? record.stale : []) {
    const claim = stale?.record?.about?.claim;
    if (typeof claim === "string" && claim.trim()) staleClaims.add(claim);
  }

  return { record, mapVersion: map.mapVersion, items, answers, corrections, staleClaims };
}

/**
 * Round-dependent dedupe (AC): an item whose claim Mateusz already answered or
 * corrected in a previous round is not asked again this round — filtered
 * against the gate1 fields per the policy's dedupe flag. Matching is by
 * claim TEXT (the answer contract keys records by interpretationId, but ids
 * renumber between map versions while a renumber is pure id translation over
 * verbatim-identical content — the claim text is the stable join key).
 * Claims the fold found STALE are excluded from the evidence: a refused
 * answer must re-ask, never silently disappear.
 */
export function dedupeItems({ items, answers, corrections, staleClaims }) {
  const answered = new Set();
  for (const rec of [...answers, ...corrections]) {
    const claim = rec?.about?.claim;
    if (typeof claim === "string" && claim.trim() && !staleClaims.has(claim)) answered.add(claim);
  }
  const kept = items.filter((i) => !answered.has(i.claim));
  const dedupedIds = items.filter((i) => answered.has(i.claim)).map((i) => i.id);
  return { kept, dedupedIds };
}

// ── the node-internal [J] scoring call ───────────────────────────────────────

/**
 * Score EVERY remaining interpretation through plan.intent.select.score in ONE
 * seam call (instances channel, two template keys per instance). The state is
 * the minimal payload the verdicts need — id, claim, source, alternatives
 * presence — never full quotes; it is bounded by the seam's state cap and
 * fails closed over it (no truncation: verdicts over half a map would route
 * half a selection). Fails closed when the seam call fails, the envelope is
 * not ok, or any impact{i}/grounded{i} answer is missing or malformed: a gate
 * that cannot score can never become a silent pass.
 */
async function serveSelectScore({ items, caller }) {
  const state = canonicalJson({ items: items.map((i) => ({ id: i.id, claim: i.claim, source: i.source, alternatives: i.alternatives.length })) });
  if (state.length > stateCap()) {
    throw new TypedError("invalid_input", `plan.intent.select: the scoring state exceeds the seam's state cap (${state.length} > ${stateCap()})`);
  }
  const instances = items.map((i) => ({ id: i.id, claim: i.claim, source: i.source }));
  let envelope;
  try {
    envelope = await caller({ state, decisionId: SELECT_SCORE_DECISION, instances });
  } catch (err) {
    throw new TypedError(
      err instanceof Error && err.code ? err.code : "provider_error",
      `plan.intent.select: the ${SELECT_SCORE_DECISION} call failed closed: ${err?.message || "caller threw"}`,
    );
  }
  if (!envelope.ok) {
    throw new TypedError(
      envelope.error?.code ?? "provider_error",
      `plan.intent.select: the ${SELECT_SCORE_DECISION} call returned an error envelope: ${envelope.error?.message ?? "unknown"}`,
    );
  }
  const answers = envelope.annotation?.answers ?? {};
  const scores = items.map((item, i) => {
    const impact = answers[`impact${i}`];
    const grounded = answers[`grounded${i}`];
    if (!impact || impact.type !== "noul" || typeof impact.noul !== "number"
      || !grounded || grounded.type !== "noul" || typeof grounded.noul !== "number") {
      throw new TypedError(
        "unparseable_output",
        `plan.intent.select: the ${SELECT_SCORE_DECISION} call returned no usable impact/grounded noul pair for ${item.id}`,
      );
    }
    return { id: item.id, impactProbability: impact.noul, groundedProbability: grounded.noul };
  });
  return { scores, eventId: envelope.eventId ?? null, confidence: envelope.annotation?.confidence ?? null };
}

// ── the routing (pure — the policy decides, the code applies) ────────────────

/**
 * Route ONE interpretation by the policy table. The alternatives override
 * fires first: an item the map itself carries policy.alternatives.min or more
 * alternative readings for ALWAYS becomes a question carrying those
 * alternatives as options — whatever its source, impact or grounding.
 */
export function routeOf(item, score, policy) {
  if (item.alternatives.length >= policy.alternatives.min) return policy.alternatives.route;
  const high = score.impactProbability >= IMPACT_THRESHOLD;
  if (item.source === "unknown") return policy.routes.unknown[high ? "high" : "low"];
  if (item.source === "inferred") return policy.routes.inferred[high ? "high" : "low"];
  const grounded = score.groundedProbability >= IMPACT_THRESHOLD;
  return grounded ? policy.routes.stated.groundedYes : policy.routes.stated.groundedNo[high ? "high" : "low"];
}

/** The question's options. Unknown items use the map's own options verbatim
 *  (exactly one recommended — checked here fail-closed even though the map
 *  checks enforce it upstream: a selection shown with two recommendations is
 *  a broken question). The alternatives override builds the options from the
 *  claim (recommended, the map's current reading) plus the alternatives. */
function optionsFor(item, policy) {
  if (item.alternatives.length >= policy.alternatives.min) {
    return [
      { text: item.claim, recommended: true, reason: "the map's current reading" },
      ...item.alternatives.map((t) => ({ text: t, recommended: false })),
    ];
  }
  const options = item.options;
  if (!Array.isArray(options) || options.length < 2
    || options.filter((o) => o?.recommended === true).length !== 1
    || options.some((o) => typeof o?.text !== "string" || !o.text.trim())) {
    throw new TypedError("invalid_input", `plan.intent.select: ${item.id} needs a question but carries no usable options (2+, exactly one recommended)`);
  }
  return options.map((o) => ({ text: o.text, recommended: o.recommended === true, ...(o.recommended === true && typeof o.reason === "string" ? { reason: o.reason } : {}) }));
}

/**
 * Route every item and build the per-route payloads. Pure. The ask-queue
 * (questions + confirmations) ranks by impact probability, highest first,
 * ties in map order; the top policy.capQuestions are kept and the overflow
 * falls to the assumptions with a reason naming the cap rank — listed, never
 * dropped (A0 honesty).
 */
export function selectFromMap({ items, scores, policy, mapVersion }) {
  const scoreOf = new Map(scores.map((s) => [s.id, s]));
  const routed = { question: [], confirm: [], understood: [], assumption: [] };
  for (const item of items) {
    const score = scoreOf.get(item.id);
    if (!score) {
      throw new TypedError("invalid_input", `plan.intent.select: ${item.id} carries no impact/grounding verdict — the scoring call is incomplete`);
    }
    const route = routeOf(item, score, policy);
    const base = { id: item.id, claim: item.claim };
    if (route === "question") {
      routed.question.push({ ...base, options: optionsFor(item, policy), impactProbability: score.impactProbability });
    } else if (route === "confirm") {
      routed.confirm.push({ ...base, impactProbability: score.impactProbability });
    } else if (route === "understood") {
      routed.understood.push({ ...base, groundedProbability: score.groundedProbability });
    } else {
      const high = score.impactProbability >= IMPACT_THRESHOLD;
      const table = item.source === "stated"
        ? `stated.grounded-no.${high ? "high" : "low"}`
        : `${item.source}.${high ? "high" : "low"}`;
      routed.assumption.push({ ...base, impactProbability: score.impactProbability, reason: `policy route ${table} → assumption` });
    }
  }
  // The cap: rank the ask-queue by impact probability (stable on map order),
  // keep the top cap, overflow → assumptions.
  const ask = [...routed.question, ...routed.confirm];
  const ranked = ask
    .map((q, idx) => ({ q, idx }))
    .sort((a, b) => b.q.impactProbability - a.q.impactProbability || a.idx - b.idx);
  const kept = ranked.slice(0, policy.capQuestions).map((r) => r.q);
  // An overflowed question/confirmation becomes an assumption: the options
  // field has no place in the assumption shape and is dropped here — the map
  // record itself still carries the alternatives and options verbatim.
  const overflow = ranked.slice(policy.capQuestions).map((r, i) => ({
    id: r.q.id,
    claim: r.q.claim,
    impactProbability: r.q.impactProbability,
    // The rank is the item's standing in the IMPACT ordering (post-sort), not
    // its map-order position — measured on FOC-443/FOC-406 (2026-10-01), where
    // a map-order-2 item ranked 8th by impact had been labelled "rank 2".
    reason: `below the ${policy.capQuestions}-question cap (rank ${policy.capQuestions + i + 1}) — listed, never dropped (A0 honesty)`,
  }));
  return {
    mapVersion,
    questions: kept.filter((q) => Array.isArray(q.options)),
    confirmations: kept.filter((q) => !Array.isArray(q.options)),
    understood: routed.understood,
    assumptions: [...routed.assumption, ...overflow],
  };
}

// ── the FOC-449 delta label (exported pure — wired at the gate1 done path) ───

/**
 * The outcome label for the gate1 approval (FOC-449): did Mateusz's answers
 * DIFFER from the selection's recommendations, CORRECT a "Rozumiem tak" line,
 * or accept as recommended? Pure: selection output + the gate1 answer records
 * → one labelRecord-shaped record (decision-log.mjs), or null when there is
 * nothing to label (no eventId, no selection). Matching is by claim text —
 * the same join key dedupe uses.
 *
 * Provisional answer shape (FOC-517 must confirm): { round, mapVersion,
 * interpretationId, about: { claim, option? }, answer, corrected?,
 * acceptedOptions? }. Difference evidence, in order: about.option names a
 * non-recommended option; acceptedOptions names anything beyond the
 * recommended text; the answer text itself equals a non-recommended option's
 * text. Anything else reads as accepted — the label records what the gate
 * fields prove, never what it guesses.
 *
 * Outcome vocabulary: "accepted" | "differed:IN-x[,...]" |
 * "corrected:IN-x[,...]" | "unanswered:IN-x[,...]" (answers exist but not for
 * every asked item) | "approved-unanswered" (no answer records at all while
 * questions were asked — the provisional shape's honest marker) |
 * "unmatched:N" (answer/correction records whose claim matches no selection
 * item — contract drift, flagged not swallowed).
 */
export function selectDeltaLabel({ selection, answers = [], corrections = [], eventId, by = "human", now }) {
  if (!eventId || !selection || typeof selection !== "object" || !Array.isArray(selection.questions)) {
    return null;
  }
  const ask = [...selection.questions, ...(selection.confirmations ?? [])];
  const understood = selection.understood ?? [];
  const recordsOf = (arr) => (Array.isArray(arr) ? arr : []);

  const recommendedText = (item) => (item.options ?? []).find((o) => o?.recommended === true)?.text ?? null;
  const claims = new Map();
  for (const item of ask) claims.set(item.claim, { id: item.id, kind: "ask", item });
  for (const item of understood) if (!claims.has(item.claim)) claims.set(item.claim, { id: item.id, kind: "understood", item });

  const differed = [];
  const corrected = [];
  const unanswered = new Set(ask.map((i) => i.id));
  let unmatched = 0;
  const answerDiffers = (rec, item) => {
    const rec_ = recommendedText(item);
    if (rec_ === null) return false;
    if (typeof rec.about?.option === "string" && rec.about.option !== rec_) return true;
    const accepted = Array.isArray(rec.acceptedOptions) ? rec.acceptedOptions.filter((t) => typeof t === "string") : [];
    if (accepted.length && accepted.some((t) => t !== rec_)) return true;
    if (typeof rec.answer === "string" && (item.options ?? []).some((o) => o?.recommended !== true && o?.text === rec.answer)) return true;
    return false;
  };
  for (const rec of recordsOf(answers)) {
    const claim = typeof rec?.about?.claim === "string" ? rec.about.claim : null;
    const hit = claim !== null ? claims.get(claim) : undefined;
    if (!hit) { unmatched++; continue; }
    unanswered.delete(hit.id);
    if (hit.kind === "ask" && answerDiffers(rec, hit.item)) differed.push(hit.id);
  }
  for (const rec of recordsOf(corrections)) {
    const claim = typeof rec?.about?.claim === "string" ? rec.about.claim : null;
    const hit = claim !== null ? claims.get(claim) : undefined;
    if (!hit) { unmatched++; continue; }
    unanswered.delete(hit.id);
    if (!corrected.includes(hit.id)) corrected.push(hit.id);
    const d = differed.indexOf(hit.id);
    if (d !== -1) differed.splice(d, 1); // a correction supersedes the answer it corrects
  }

  const parts = [];
  if (differed.length) parts.push(`differed:${differed.join(",")}`);
  if (corrected.length) parts.push(`corrected:${corrected.join(",")}`);
  if (unanswered.size) {
    parts.push(recordsOf(answers).length || recordsOf(corrections).length
      ? `unanswered:${[...unanswered].join(",")}`
      : "approved-unanswered");
  }
  if (unmatched) parts.push(`unmatched:${unmatched}`);
  const outcome = parts.length ? parts.join(" ") : "accepted";
  return labelRecord({ eventId, outcome, by, source: "auto", via: "gate", ...(now ? { now } : {}) });
}

// ── the node ─────────────────────────────────────────────────────────────────

/**
 * Run ONE plan.intent.select step execution: compose → dedupe → score (the
 * node-internal [J] call) → route → cap → validate. Returns
 * `{status:"done", output, scores, eventId, confidence, dedupedIds, attempts}`
 * or `{status:"failed", error}` — it never throws on data failures
 * (fail-closed typed shapes), only on missing wiring (a caller bug).
 */
export async function runPlanIntentSelectNode({
  stepId = "plan.intent.select",
  reads,
  caller,
  validate,
  policy = loadSelectPolicy(),
} = {}) {
  if (typeof caller !== "function") {
    throw new TypedError("invalid_input", `runPlanIntentSelectNode needs the decision-call seam caller (${SELECT_SCORE_DECISION})`);
  }
  if (typeof validate !== "function") {
    throw new TypedError("invalid_input", "runPlanIntentSelectNode needs the step's output validator");
  }

  let inputs;
  try {
    inputs = composeSelectInputs(reads);
  } catch (err) {
    return { status: "failed", error: { code: err?.code ?? "invalid_input", message: err?.message ?? "composition failed" } };
  }

  const { kept, dedupedIds } = policy.dedupe
    ? dedupeItems({ items: inputs.items, answers: inputs.answers, corrections: inputs.corrections, staleClaims: inputs.staleClaims })
    : { kept: inputs.items, dedupedIds: [] };

  // Everything already answered → an empty selection; the gate still runs on
  // it, there is just nothing new to ask.
  if (kept.length === 0) {
    return {
      status: "done",
      output: { mapVersion: inputs.mapVersion, questions: [], confirmations: [], understood: [], assumptions: [] },
      scores: [],
      eventId: null,
      confidence: null,
      dedupedIds,
      attempts: 1,
    };
  }

  let served;
  try {
    served = await serveSelectScore({ items: kept, caller });
  } catch (err) {
    return { status: "failed", error: { code: err?.code ?? "provider_error", message: err?.message ?? "scoring failed" } };
  }

  let output;
  try {
    output = selectFromMap({ items: kept, scores: served.scores, policy, mapVersion: inputs.mapVersion });
  } catch (err) {
    return { status: "failed", error: { code: err?.code ?? "invalid_input", message: err?.message ?? "routing failed" } };
  }
  if (!validate(output)) {
    return { status: "failed", error: { code: "schema_invalid", message: `[G] ${stepId} selection failed the step's output schema` } };
  }
  return {
    status: "done",
    output,
    scores: served.scores,
    eventId: served.eventId,
    confidence: served.confidence,
    dedupedIds,
    attempts: 1,
  };
}