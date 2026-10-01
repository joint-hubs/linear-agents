// scripts/plan-intent-select.test.mjs — FOC-516: the plan.intent.select node.
//
// Covers, all offline: the policy loader (config-consumed, fail closed), the
// read composition and the round-dependent dedupe, the routing table (the
// policy decides, the code applies — including the alternatives override and
// the per-round question cap with its never-dropped overflow), the
// node-internal plan.intent.select.score seam call (one call per map, two noul
// verdicts per instance, fail-closed parsing), the FOC-449 delta label as an
// exported pure function, the runner wiring at the gate1 done path (the label
// lands in an INJECTED runs dir — never the live .state/runs), and the
// policy/schema anti-drift pin.
//
// Run: node scripts/plan-intent-select.test.mjs

import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import Ajv from "ajv";
import { TypedError } from "./mcp/envelope.mjs";
import { loadSelectPolicy, composeSelectInputs, dedupeItems, routeOf, selectFromMap, runPlanIntentSelectNode, selectDeltaLabel, SELECT_SCORE_DECISION, SELECT_ROUTES, SELECT_POLICY_PATH } from "./plan-intent-select.mjs";
import { createGraphRunner } from "./graph-runner.mjs";

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
const deepEq = (a, b, label) => { try { assert.deepStrictEqual(a, b); } catch (err) { fail(`${label}: ${err.message}`); } };

function eqCode(err, code, label) {
  if (err.code !== code) fail(`${label}: expected code ${code}, got ${err.code} (${err.message})`);
}

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");

// ── fixtures ─────────────────────────────────────────────────────────────────

const CLAIM_U = "Rozumiem, że licznik ma działać offline.";
const CLAIM_G = "Rozumiem, że celem jest czytelny graf.";
const CLAIM_S = "Rozumiem, że w zakresie jest tylko selekcja.";
const CLAIM_R = "Rozumiem, że ryzykiem jest utrata odpowiedzi.";

// A round-1 map covering every route: IN-1 unknown with options (the question
// route), IN-2 inferred (confirm at high impact, assumption at low), IN-3
// stated (the "Rozumiem tak" route when grounding reads yes), IN-4 inferred
// with two alternatives (the alternatives override — always a question).
const MAP_OUTPUT = {
  goal: "g",
  why: "w",
  mapVersion: 1,
  interpretations: [
    {
      id: "IN-1", perspective: "terms", claim: CLAIM_U, source: "unknown", alternatives: [], covers: [],
      options: [
        { text: "Offline tak", recommended: true, reason: "the dictated entry says local-first" },
        { text: "Offline nie", recommended: false },
      ],
    },
    { id: "IN-2", perspective: "goal", claim: CLAIM_G, source: "inferred", alternatives: [], covers: [] },
    { id: "IN-3", perspective: "scope", claim: CLAIM_S, source: "stated", quote: "selekcja", alternatives: [], covers: [] },
    { id: "IN-4", perspective: "risk", claim: CLAIM_R, source: "inferred", alternatives: ["alternatywa pierwsza", "alternatywa druga"], covers: [] },
  ],
};

const recordView = (output, extra = {}) => ({ stepId: "plan.intent", key: "plan.intent", status: "done", output, ...extra });

const readsFor = (map = MAP_OUTPUT, extraReads = {}) => ({ "plan.intent.record": recordView(map), ...extraReads });

// The scoring stub: two noul verdicts per instance, keyed by instance id so a
// test controls each item's impact/grounding explicitly.
function scoreCaller(impact = {}, grounded = {}) {
  return async (input) => {
    if (input.decisionId !== SELECT_SCORE_DECISION) fail(`unexpected decisionId ${input.decisionId}`);
    const answers = {};
    (input.instances ?? []).forEach((inst, i) => {
      answers[`impact${i}`] = { type: "noul", noul: impact[inst.id] ?? 0.9 };
      answers[`grounded${i}`] = { type: "noul", noul: grounded[inst.id] ?? 0.9 };
    });
    return { ok: true, eventId: "evt-select-test", annotation: { answers, confidence: 0.9 } };
  };
}

// The real output schema, compiled once — the node must emit what the
// committed graph.json promises.
const GRAPH = JSON.parse(readFileSync(join(ROOT, "config", "graph.json"), "utf8"));
const ajv = new Ajv({ strict: false, allErrors: true });
const validateSelection = ajv.compile(GRAPH.nodes.plan.steps["plan.intent.select"].output);

// ── the policy ───────────────────────────────────────────────────────────────

console.log("\nplan-intent-select: the policy (config-consumed, fail closed)");

await test("loadSelectPolicy returns the normalized policy from the committed config", () => {
  const policy = loadSelectPolicy();
  eq(policy.capQuestions, 4, "the per-round question cap");
  eq(policy.dedupe, true, "dedupe on");
  eq(policy.ordering, "impactProbability", "ordering");
  deepEq(policy.alternatives, { min: 2, route: "question", overridesTable: true }, "the alternatives override");
  deepEq(policy.routes.unknown, { high: "question", low: "assumption" }, "unknown row");
  deepEq(policy.routes.inferred, { high: "confirm", low: "assumption" }, "inferred row");
  eq(policy.routes.stated.groundedYes, "understood", "stated grounded-yes");
  deepEq(policy.routes.stated.groundedNo, { high: "confirm", low: "assumption" }, "stated grounded-no row");
});

await test("an unreadable policy path fails typed", () => {
  try {
    loadSelectPolicy({ path: join(ROOT, "config", "no-such-policy.json") });
    fail("must refuse");
  } catch (err) {
    eqCode(err, "invalid_input", "unreadable policy");
  }
});

await test("malformed policy rows fail typed — every structural mutation", async () => {
  const base = JSON.parse(readFileSync(SELECT_POLICY_PATH, "utf8"));
  const mutations = [
    ["cap.questions = 0", { cap: { questions: 0 } }],
    ["cap.questions = 13", { cap: { questions: 13 } }],
    ["cap.questions fractional", { cap: { questions: 2.5 } }],
    ["dedupe = \"yes\"", { dedupe: "yes" }],
    ["ordering wrong", { ordering: "cheapest" }],
    ["alternatives.min = 1", { alternatives: { min: 1, route: "question", overridesTable: true } }],
    ["alternatives.route wrong", { alternatives: { min: 2, route: "assumption", overridesTable: true } }],
    ["alternatives.overridesTable false", { alternatives: { min: 2, route: "question", overridesTable: false } }],
    ["routes missing a row", { routes: { unknown: { high: "question", low: "assumption" }, inferred: { high: "confirm", low: "assumption" } } }],
    ["route outside the vocabulary", { routes: { unknown: { high: "hide", low: "assumption" }, inferred: { high: "confirm", low: "assumption" }, stated: { "grounded-yes": "understood", "grounded-no": { high: "confirm", low: "assumption" } } } }],
    ["stated.grounded-yes missing", { routes: { unknown: { high: "question", low: "assumption" }, inferred: { high: "confirm", low: "assumption" }, stated: { "grounded-no": { high: "confirm", low: "assumption" } } } }],
    ["stated.grounded-no not a split", { routes: { unknown: { high: "question", low: "assumption" }, inferred: { high: "confirm", low: "assumption" }, stated: { "grounded-yes": "understood", "grounded-no": "assumption" } } }],
  ];
  for (const [label, patch] of mutations) {
    const broken = JSON.parse(JSON.stringify(base));
    for (const [k, v] of Object.entries(patch)) broken[k] = v;
    const path = join(ROOT, "config", "intent-select-policy.json");
    // The loader reads a path, so each mutation is validated through a
    // serialized temp copy — the committed file itself is never touched.
    const d = mkdtempSync(join(tmpdir(), "policy-test-"));
    const p = join(d, "policy.json");
    writeFileSync(p, JSON.stringify(broken));
    try {
      loadSelectPolicy({ path: p });
      fail(`policy mutation must be refused: ${label}`);
    } catch (err) {
      eqCode(err, "invalid_input", label);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }
});

// ── composition and dedupe ───────────────────────────────────────────────────

console.log("\nplan-intent-select: composition and dedupe (pure, fail closed)");

await test("composeSelectInputs normalizes the reads; absent gate reads are the round-1 marker", () => {
  const inputs = composeSelectInputs(readsFor());
  eq(inputs.mapVersion, 1, "mapVersion");
  eq(inputs.items.length, 4, "items");
  deepEq(inputs.answers, [], "no answers in round 1");
  deepEq(inputs.corrections, [], "no corrections in round 1");
  eq(inputs.staleClaims.size, 0, "no stale claims");
});

await test("composeSelectInputs fails closed on a missing, failed or malformed map record", () => {
  const cases = [
    [{}, "missing record"],
    [{ "plan.intent.record": null }, "null record"],
    [{ "plan.intent.record": { status: "failed", output: {} } }, "failed record"],
    [{ "plan.intent.record": { status: "done", output: { interpretations: MAP_OUTPUT.interpretations } } }, "no mapVersion"],
    [{ "plan.intent.record": { status: "done", output: { mapVersion: 1, interpretations: [] } } }, "empty interpretations"],
    [{ "plan.intent.record": { status: "done", output: { mapVersion: 1, interpretations: [{ id: "IN-1", claim: "c", source: "weird", alternatives: [] }] } } }, "bad source"],
    [{ "plan.intent.record": { status: "done", output: { mapVersion: 1, interpretations: [{ id: "IN-13", claim: "c", source: "inferred", alternatives: [] }] } } }, "bad id"],
    [{ "plan.intent.record": { status: "done", output: { mapVersion: 1, interpretations: [{ id: "IN-1", source: "inferred", alternatives: [] }] } } }, "no claim"],
  ];
  for (const [reads, label] of cases) {
    try {
      composeSelectInputs(reads);
      fail(`must refuse: ${label}`);
    } catch (err) {
      eqCode(err, "invalid_input", label);
    }
  }
});

await test("composeSelectInputs collects the fold's stale claims from the record view", () => {
  const stale = [{ record: { about: { claim: CLAIM_U } } }, { record: {} }];
  const inputs = composeSelectInputs(readsFor(MAP_OUTPUT, { "gate.plan.gate1.answers": [] }));
  eq(inputs.staleClaims.size, 0, "no stale log — none collected");
  const withStale = composeSelectInputs({ "plan.intent.record": recordView(MAP_OUTPUT, { stale }) });
  eq(withStale.staleClaims.size, 1, "the refused answer's claim is collected");
  eq(withStale.staleClaims.has(CLAIM_U), true, "by claim text");
});

await test("composeSelectInputs rejects non-array gate reads", () => {
  try {
    composeSelectInputs(readsFor(MAP_OUTPUT, { "gate.plan.gate1.answers": "all of them" }));
    fail("must refuse");
  } catch (err) {
    eqCode(err, "invalid_input", "non-array answers");
  }
});

await test("dedupeItems matches by claim text, skips stale claims, reports the deduped ids", () => {
  const { kept, dedupedIds } = dedupeItems({
    items: MAP_OUTPUT.interpretations,
    answers: [{ about: { claim: CLAIM_G } }],
    corrections: [{ about: { claim: CLAIM_S } }],
    staleClaims: new Set([CLAIM_U]),
  });
  deepEq(kept.map((i) => i.id), ["IN-1", "IN-4"], "the answered claims are out, the stale-refused claim STAYS (a refused answer re-asks)");
  deepEq(dedupedIds, ["IN-2", "IN-3"], "the deduped ids ride the result");
});

// ── routing ──────────────────────────────────────────────────────────────────

console.log("\nplan-intent-select: routing (the policy decides, the code applies)");

await test("routeOf walks every policy row and fires the alternatives override first", () => {
  const policy = loadSelectPolicy();
  const score = (impactProbability, groundedProbability = 0.1) => ({ id: "x", impactProbability, groundedProbability });
  const item = (source, alternatives = []) => ({ source, alternatives });
  eq(routeOf(item("inferred", ["a", "b"]), score(0.1), policy), "question", "override: two alternatives ALWAYS a question, whatever the table says");
  eq(routeOf(item("unknown"), score(0.9), policy), "question", "unknown high");
  eq(routeOf(item("unknown"), score(0.1), policy), "assumption", "unknown low");
  eq(routeOf(item("inferred"), score(0.5), policy), "confirm", "inferred high (threshold inclusive)");
  eq(routeOf(item("inferred"), score(0.1), policy), "assumption", "inferred low");
  eq(routeOf(item("stated"), score(0.1, 0.9), policy), "understood", "stated grounded-yes → 'Rozumiem tak'");
  eq(routeOf(item("stated"), score(0.9, 0.1), policy), "confirm", "stated grounded-no high");
  eq(routeOf(item("stated"), score(0.1, 0.1), policy), "assumption", "stated grounded-no low");
});

await test("selectFromMap builds question options from the map verbatim (exactly one recommended)", () => {
  const policy = loadSelectPolicy();
  const out = selectFromMap({
    items: [MAP_OUTPUT.interpretations[0]],
    scores: [{ id: "IN-1", impactProbability: 0.9, groundedProbability: 0.1 }],
    policy,
    mapVersion: 1,
  });
  eq(out.questions.length, 1, "one question");
  deepEq(out.questions[0].options, MAP_OUTPUT.interpretations[0].options, "the map's options verbatim, reason preserved");
  eq(out.questions[0].impactProbability, 0.9, "the impact verdict rides the question");
});

await test("selectFromMap: the alternatives override builds options from the claim + the alternatives", () => {
  const policy = loadSelectPolicy();
  const out = selectFromMap({
    items: [MAP_OUTPUT.interpretations[3]],
    scores: [{ id: "IN-4", impactProbability: 0.1, groundedProbability: 0.1 }],
    policy,
    mapVersion: 1,
  });
  eq(out.questions.length, 1, "the override routes to question even at inferred-low impact");
  deepEq(out.questions[0].options, [
    { text: CLAIM_R, recommended: true, reason: "the map's current reading" },
    { text: "alternatywa pierwsza", recommended: false },
    { text: "alternatywa druga", recommended: false },
  ], "the claim is the recommended option, the alternatives the rest");
});

await test("a question-routed item without usable options fails closed", () => {
  const policy = loadSelectPolicy();
  try {
    selectFromMap({
      items: [{ id: "IN-9", claim: "c", source: "unknown", alternatives: [] }],
      scores: [{ id: "IN-9", impactProbability: 0.9, groundedProbability: 0.1 }],
      policy,
      mapVersion: 1,
    });
    fail("must refuse");
  } catch (err) {
    eqCode(err, "invalid_input", "no usable options");
  }
});

await test("selectFromMap: the cap ranks by impact probability (ties in map order); overflow becomes assumptions naming the rank", () => {
  const policy = loadSelectPolicy(); // cap 4
  const items = [1, 2, 3, 4, 5, 6].map((n) => ({ id: `IN-${n}`, claim: `claim ${n}`, source: "inferred", alternatives: [] }));
  const impacts = [0.9, 0.85, 0.8, 0.75, 0.7, 0.65];
  const out = selectFromMap({ items, scores: items.map((it, i) => ({ id: it.id, impactProbability: impacts[i], groundedProbability: 0.1 })), policy, mapVersion: 1 });
  deepEq(out.confirmations.map((q) => q.id), ["IN-1", "IN-2", "IN-3", "IN-4"], "the top four by impact (inferred-high routes to confirmations)");
  eq(out.questions.length, 0, "no questions — these items carry no options");
  deepEq(out.assumptions.map((a) => a.id), ["IN-5", "IN-6"], "the overflow is LISTED, never dropped");
  if (!out.assumptions[0].reason.includes("rank 5")) fail(`the overflow reason names the rank: ${out.assumptions[0].reason}`);
  if (!out.assumptions[0].reason.includes("never dropped")) fail("the overflow reason carries the A0 honesty note");
});

await test("selectFromMap: ties rank in map order and table-routed assumptions carry the policy row", () => {
  const policy = loadSelectPolicy();
  const items = [
    { id: "IN-1", claim: "b", source: "inferred", alternatives: [] },
    { id: "IN-2", claim: "a", source: "inferred", alternatives: [] },
    { id: "IN-3", claim: "c", source: "unknown", alternatives: [] },
  ];
  const out = selectFromMap({
    items,
    scores: [
      { id: "IN-1", impactProbability: 0.7, groundedProbability: 0.1 },
      { id: "IN-2", impactProbability: 0.7, groundedProbability: 0.1 },
      { id: "IN-3", impactProbability: 0.1, groundedProbability: 0.1 },
    ],
    policy,
    mapVersion: 2,
  });
  deepEq(out.confirmations.map((q) => q.id), ["IN-1", "IN-2"], "equal impact keeps the map order");
  eq(out.assumptions.length, 1, "the unknown-low item");
  if (!out.assumptions[0].reason.includes("unknown.low")) fail(`the assumption names its policy route: ${out.assumptions[0].reason}`);
  eq(out.mapVersion, 2, "mapVersion carried");
});

// ── the node ─────────────────────────────────────────────────────────────────

console.log("\nplan-intent-select: the node (compose → dedupe → score → route → validate)");

await test("the happy path: schema-validated selection, scores, eventId, confidence, dedupedIds", async () => {
  const result = await runPlanIntentSelectNode({
    reads: readsFor(),
    caller: scoreCaller({ "IN-2": 0.8, "IN-3": 0.1 }, { "IN-3": 0.9 }),
    validate: validateSelection,
  });
  eq(result.status, "done", "done");
  eq(result.attempts, 1, "one attempt");
  eq(result.eventId, "evt-select-test", "the scoring event id");
  eq(result.confidence, 0.9, "the annotation confidence");
  deepEq(result.dedupedIds, [], "nothing deduped in round 1");
  eq(result.scores.length, 4, "one score pair per item");
  eq(validateSelection(result.output), true, "the selection passes the committed output schema");
  eq(result.output.mapVersion, 1, "mapVersion");
  eq(result.output.questions.length, 2, "IN-1 (unknown high) + IN-4 (alternatives override)");
  deepEq(result.output.confirmations.map((c) => c.id), ["IN-2"], "the inferred-high item");
  deepEq(result.output.understood.map((c) => c.id), ["IN-3"], "the stated grounded-yes item");
  eq(result.output.assumptions.length, 0, "nothing assumed this round");
});

await test("everything already answered → an empty selection with NO seam call", async () => {
  const answers = MAP_OUTPUT.interpretations.map((i) => ({ about: { claim: i.claim } }));
  let called = 0;
  const result = await runPlanIntentSelectNode({
    reads: readsFor(MAP_OUTPUT, { "gate.plan.gate1.answers": answers }),
    caller: async () => { called++; return { ok: true, annotation: { answers: {} } }; },
    validate: validateSelection,
  });
  eq(result.status, "done", "done — the gate still runs on the empty selection");
  eq(result.output.questions.length, 0, "no questions");
  eq(result.output.confirmations.length, 0, "no confirmations");
  eq(result.output.understood.length, 0, "no understood lines");
  eq(result.output.assumptions.length, 0, "no assumptions — every item is answered");
  eq(result.eventId, null, "no scoring event");
  eq(called, 0, "the seam is never called over an empty ask");
  deepEq(result.dedupedIds, ["IN-1", "IN-2", "IN-3", "IN-4"], "all four deduped");
});

await test("seam failures land typed: a thrown caller, an error envelope, unparseable answers", async () => {
  const cases = [
    [async () => { throw new Error("boom"); }, "provider_error", "caller threw"],
    [async () => ({ ok: false, error: { code: "provider_error", message: "down" } }), "provider_error", "error envelope"],
    [async () => ({ ok: false, error: { code: "not-a-known-code", message: "down" } }), "provider_error", "unknown envelope code normalizes to provider_error"],
    [async () => ({ ok: true, annotation: { answers: {} } }), "unparseable_output", "no answers"],
    [async () => ({ ok: true, annotation: { answers: { impact0: { type: "noul", noul: 0.9 } } } }), "unparseable_output", "missing grounded"],
    [async () => ({ ok: true, annotation: { answers: { impact0: { type: "choice", choice: "x" }, grounded0: { type: "noul", noul: 0.9 } } } }), "unparseable_output", "non-noul impact"],
  ];
  for (const [caller, code, label] of cases) {
    const result = await runPlanIntentSelectNode({ reads: readsFor(), caller, validate: validateSelection });
    eq(result.status, "failed", label);
    eq(result.error.code, code, label);
  }
});

await test("composition or routing failures land typed, never thrown", async () => {
  const bad = await runPlanIntentSelectNode({ reads: {}, caller: scoreCaller(), validate: validateSelection });
  eq(bad.status, "failed", "failed");
  eq(bad.error.code, "invalid_input", "missing map record");
  const noOptions = await runPlanIntentSelectNode({
    reads: readsFor({ ...MAP_OUTPUT, interpretations: [{ id: "IN-1", claim: "c", source: "unknown", alternatives: [] }] }),
    caller: scoreCaller(),
    validate: validateSelection,
  });
  eq(noOptions.status, "failed", "failed");
  eq(noOptions.error.code, "invalid_input", "question without options");
});

await test("missing wiring throws before anything runs", async () => {
  try {
    await runPlanIntentSelectNode({ reads: readsFor(), validate: validateSelection });
    fail("missing caller must refuse");
  } catch (err) {
    eqCode(err, "invalid_input", "missing caller");
  }
  try {
    await runPlanIntentSelectNode({ reads: readsFor(), caller: scoreCaller() });
    fail("missing validator must refuse");
  } catch (err) {
    eqCode(err, "invalid_input", "missing validator");
  }
});

// ── the FOC-449 delta label ──────────────────────────────────────────────────

console.log("\nplan-intent-select: the FOC-449 delta label (pure)");

const SEL = {
  mapVersion: 1,
  questions: [{ id: "IN-1", claim: CLAIM_U, options: MAP_OUTPUT.interpretations[0].options, impactProbability: 0.9 }],
  confirmations: [{ id: "IN-2", claim: CLAIM_G, impactProbability: 0.8 }],
  understood: [{ id: "IN-3", claim: CLAIM_S, groundedProbability: 0.9 }],
  assumptions: [],
};
const EV = "evt-select-test";

await test("accepted as recommended → outcome 'accepted'; the shape matches labelRecord", () => {
  const label = selectDeltaLabel({
    selection: SEL,
    answers: [{ about: { claim: CLAIM_U, option: "Offline tak" }, answer: "Offline tak" }, { about: { claim: CLAIM_G } }],
    corrections: [],
    eventId: EV,
    now: () => "2026-01-01T00:00:00.000Z",
  });
  eq(label.outcome, "accepted", "the recommendation was taken");
  deepEq(label, { type: "label", eventId: EV, outcome: "accepted", by: "human", source: "auto", via: "gate", ts: "2026-01-01T00:00:00.000Z" }, "labelRecord shape");
});

await test("differed — every evidence channel: about.option, acceptedOptions, the answer text", () => {
  const byOption = selectDeltaLabel({ selection: SEL, answers: [{ about: { claim: CLAIM_U, option: "Offline nie" } }, { about: { claim: CLAIM_G } }], eventId: EV });
  eq(byOption.outcome, "differed:IN-1", "about.option names a non-recommended option");
  const byAccepted = selectDeltaLabel({ selection: SEL, answers: [{ about: { claim: CLAIM_U }, acceptedOptions: ["Offline tak", "Offline nie"] }, { about: { claim: CLAIM_G } }], eventId: EV });
  eq(byAccepted.outcome, "differed:IN-1", "acceptedOptions reaches beyond the recommendation");
  const byText = selectDeltaLabel({ selection: SEL, answers: [{ about: { claim: CLAIM_U }, answer: "Offline nie" }, { about: { claim: CLAIM_G } }], eventId: EV });
  eq(byText.outcome, "differed:IN-1", "the answer text itself equals a non-recommended option");
});

await test("corrected 'Rozumiem tak' lines and correction-supersedes-answer", () => {
  const corrected = selectDeltaLabel({ selection: SEL, corrections: [{ about: { claim: CLAIM_S } }], eventId: EV });
  eq(corrected.outcome, "corrected:IN-3 unanswered:IN-1,IN-2", "the understood line was corrected; the ask went unanswered");
  const both = selectDeltaLabel({
    selection: SEL,
    answers: [{ about: { claim: CLAIM_U, option: "Offline nie" } }],
    corrections: [{ about: { claim: CLAIM_U } }],
    eventId: EV,
  });
  eq(both.outcome, "corrected:IN-1 unanswered:IN-2", "the correction supersedes the differed answer it corrects");
});

await test("partial answers → unanswered; no answers at all → approved-unanswered; unmatched counted", () => {
  const partial = selectDeltaLabel({ selection: SEL, answers: [{ about: { claim: CLAIM_U, option: "Offline tak" } }], eventId: EV });
  eq(partial.outcome, "unanswered:IN-2", "the confirmation got no answer");
  const none = selectDeltaLabel({ selection: SEL, answers: [], corrections: [], eventId: EV });
  eq(none.outcome, "approved-unanswered", "an approval with questions asked and nothing answered — the honest marker");
  const unmatched = selectDeltaLabel({ selection: SEL, answers: [{ about: { claim: "obce twierdzenie" } }], eventId: EV });
  eq(unmatched.outcome, "unanswered:IN-1,IN-2 unmatched:1", "a record matching no selection item is flagged, not swallowed");
});

await test("nothing to label → null (no eventId, no selection, malformed selection); an empty ask still records 'accepted'", () => {
  eq(selectDeltaLabel({ selection: SEL, eventId: null }), null, "no eventId");
  eq(selectDeltaLabel({ selection: null, eventId: EV }), null, "no selection");
  eq(selectDeltaLabel({ selection: {}, eventId: EV }), null, "selection without a questions array");
  const empty = { mapVersion: 1, questions: [], confirmations: [], understood: [], assumptions: [] };
  eq(selectDeltaLabel({ selection: empty, answers: [], corrections: [], eventId: EV }).outcome, "accepted", "nothing was asked, nothing differed — the gate still approved the selection");
});

// ── the runner wiring ────────────────────────────────────────────────────────

console.log("\nplan-intent-select: the runner wiring (the gate1 done path)");

await test("a gate1 approval writes the delta label next to the scoring event — in the INJECTED runs dir, never the live ledger", async () => {
  const dir = mkdtempSync(join(tmpdir(), "select-wire-"));
  const storePath = join(dir, "graph-steps.jsonl");
  const runsDir = join(dir, "runs");
  try {
    mkdirSync(join(runsDir, "run-wire"), { recursive: true });
    appendFileSync(join(runsDir, "run-wire", "decisions.jsonl"), `${JSON.stringify({ type: "event", eventId: "evt-wire", decisionId: SELECT_SCORE_DECISION })}\n`);
    const step = (key, stepId, output, extra = {}) => JSON.stringify({ type: "graph.step", runId: "run-wire", ts: "2026-01-01T00:00:00.000Z", key, stepId, status: "done", output, ...extra });
    appendFileSync(storePath, step("plan.dor", "plan.dor", { ready: true, gaps: [] }) + "\n");
    appendFileSync(storePath, step("plan.intent", "plan.intent", MAP_OUTPUT) + "\n");
    appendFileSync(storePath, step("plan.intent.select", "plan.intent.select", SEL, { eventId: "evt-wire" }) + "\n");
    appendFileSync(storePath, JSON.stringify({ type: "graph.step", runId: "run-wire", ts: "2026-01-01T00:00:00.000Z", key: "gate.plan.gate1", stepId: "plan.gate1", status: "gate-pending", gateKind: "plan.gate1", gateId: "g1" }) + "\n");
    appendFileSync(storePath, JSON.stringify({ type: "graph.resolution", runId: "run-wire", ts: "2026-01-01T00:00:00.000Z", key: "gate.plan.gate1.resolution", stepId: "plan.gate1", by: "mateusz", output: { approved: true } }) + "\n");

    const runner = createGraphRunner({
      runId: "run-wire",
      storePath,
      caller: async () => fail("no seam call on a seeded walk"),
      generator: async () => fail("no generator call on a seeded walk"),
      gateEmitter: async () => fail("gate1 is already pending"),
      linearEffect: async () => ({}),
      decisionRunsDir: runsDir,
    });
    await runner.run({
      inputs: { "gate.plan.gate1.answers": [{ about: { claim: CLAIM_U, option: "Offline nie" }, answer: "Offline nie" }] },
    }); // gate1 completes (label written); the walk then stops at the unseeded plan.dod

    const records = readFileSync(storePath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const done = records.filter((r) => r.key === "gate.plan.gate1").pop();
    eq(done.status, "done", "the gate completed");
    eq(done.deltaLabel?.outcome, "differed:IN-1 unanswered:IN-2", "Mateusz's answer differed from the recommendation; the confirmation went unanswered");
    eq(done.deltaLabelWritten, join(runsDir, "run-wire", "decisions.jsonl"), "the label landed next to the event");
    const ledger = readFileSync(join(runsDir, "run-wire", "decisions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const label = ledger.find((l) => l.type === "label");
    if (!label) fail("the label line is in the ledger");
    eq(label.eventId, "evt-wire", "label keyed to the scoring event");
    eq(label.outcome, "differed:IN-1 unanswered:IN-2", "outcome recorded");
    eq(label.source, "auto", "auto-join provenance");
    eq(label.via, "gate", "via the gate");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("anti-drift: the policy's question cap IS the step schema's question cap", () => {
  const policy = loadSelectPolicy();
  const schemaMax = GRAPH.nodes.plan.steps["plan.intent.select"].output.properties.questions.maxItems;
  eq(policy.capQuestions, schemaMax, "cap.questions === output.questions.maxItems");
  const flat = (v) => (typeof v === "string" ? [v] : Object.values(v).flatMap(flat));
  for (const route of flat(policy.routes)) {
    if (!SELECT_ROUTES.includes(route)) fail(`policy route "${route}" is outside the vocabulary`);
  }
});

console.log(`\nplan-intent-select: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("\nfailed tests:");
  for (const name of failures) console.error("  - " + name);
  process.exit(1);
}