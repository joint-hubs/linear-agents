// scripts/plan-gates.test.mjs — FOC-452: the PLAN squad's registry-served
// gate decisions.
//
// Three things are worth failing a build over here.
//
// 1. THE QUESTIONS COME FROM THE REGISTRY. The fixed gates resolve by id; the
//    per-instance gates (plan.duplicate_of, plan.ac.testable) pass RAW
//    instance records ({key, title}, {id, text}) and the SEAM instantiates
//    the registry-owned templates over them — question text is never built
//    by the caller. The stub models the seam's validation faithfully (it
//    consults the real registry and the real loader), and two tests drive
//    the REAL seam (createDecisionCaller) end to end: the round-1 reviewer
//    probe (inline questions on a template entry → invalid_input) and the
//    fixed serve path through the real contract, instantiation included.
//
// 2. A0 HOLDS. The seam's annotations (answers + confidence + eventId) are
//    recorded verbatim and DISPLAYED; a seam/applied disagreement is shown,
//    never auto-acted, and nothing in this module applies a label.
//
// 3. OUTCOMES JOIN ONLY THEIR OWN EVENTS. An applied label becomes a FOC-449
//    label tied to the exact eventId its decision call carried — and only
//    when the event's taskKey IS this issue. A cross-issue outcome is
//    refused, loudly, before any write; a FAILED decision collects nothing
//    (it never produced an answer PLAN applied).
//
// Run: node scripts/plan-gates.test.mjs

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDecisionCaller } from "./decision-call.mjs";
import { getRegistryEntry, instantiateEntryQuestions, resolveEntryQuestions } from "./decision-registry.mjs";
import { buildPlanGates, disagreementsOf, displayPlanGates, labelAppliedPlan, PLAN_DECISIONS } from "./plan-gates.mjs";

// Hermetic by construction: a test run must never write telemetry or shadow
// lines outside the temp dir (decision-call.test.mjs pattern).
delete process.env.LA_RUN_ID;

let passed = 0;
const failures = [];
const asyncTests = [];

function testAsync(name, fn) {
  asyncTests.push({ name, fn });
}

const tmp = mkdtempSync(join(tmpdir(), "la-plan-gates-test-"));
process.on("exit", () => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

const STATE = "Title: Gantt snapshot lib\n\nExport the schedule as a PNG.";
const RUN_ID = "test-plan-gates";

// The stub models the REAL seam's validation faithfully — the same branch
// structure createDecisionCaller.callDecisions runs, over the REAL registry:
//   · inline questions + an entry carrying its own question set → invalid_input
//     (the round-1 blocker: plan-gates must NEVER send this shape);
//   · instances + a non-template entry → invalid_input;
//   · a plain decisionId on a template entry → invalid_input (the loader
//     refuses half-resolved templates);
//   · instances + a template entry → instantiated via the REAL loader.
// Answers are typed records exactly like normalizeAnswers emits. No network,
// no key, ever.
const NOUL_BY_ID = {
  "plan.dor.criteria_testable": 1,
  "plan.dor.scope_clear": 1,
  "plan.dor.context_sufficient": 0,
  "plan.needs_adr": 0,
  "plan.security_sensitive": 0,
};
const CHOICE_BY_ID = { "plan.labels.type": "feature", "plan.labels.risk": "none" };

function stubCaller({ overrides = {}, failIds = [] } = {}) {
  const calls = [];
  const resolved = [];
  const shapeRefusal = (input, code, message) => ({
    ok: false,
    decisionId: input.decisionId ?? null,
    error: { code, message },
    eventId: input.decisionId ? `evt-${input.decisionId}` : null,
  });
  const caller = async (input) => {
    calls.push(input);
    if (input.questions !== undefined && input.instances !== undefined) {
      return shapeRefusal(input, "invalid_input", "questions and instances are mutually exclusive");
    }
    if (input.instances !== undefined && input.decisionId === undefined) {
      return shapeRefusal(input, "invalid_input", "instances require a decisionId");
    }
    if (input.decisionId === undefined) {
      return shapeRefusal(input, "invalid_input", "this stub serves registry-backed calls only");
    }
    const entry = getRegistryEntry(input.decisionId);
    let questions;
    if (input.questions !== undefined) {
      if (entry.questions !== undefined) {
        return shapeRefusal(
          input,
          "invalid_input",
          `decision "${input.decisionId}" carries its own question set — inline questions and that decisionId are mutually exclusive`,
        );
      }
      questions = input.questions;
    } else if (input.instances !== undefined) {
      if (!Object.keys(entry.questions ?? {}).some((k) => k.includes("{i}"))) {
        return shapeRefusal(
          input,
          "invalid_input",
          `decision "${input.decisionId}" carries no question templates — instances are only for template entries`,
        );
      }
      questions = instantiateEntryQuestions(input.decisionId, input.instances);
    } else {
      questions = resolveEntryQuestions(input.decisionId).questions;
    }
    resolved.push({ decisionId: input.decisionId, questions });
    if (failIds.includes(input.decisionId)) {
      return {
        ok: false,
        decisionId: input.decisionId,
        error: { code: "auth_missing", message: "OPENROUTER_API_KEY is not set" },
        eventId: `evt-${input.decisionId}`,
      };
    }
    const answers = Object.fromEntries(Object.entries(questions).map(([k, q], i) => [
      k,
      q.type === "noul"
        ? { type: "noul", noul: k.startsWith("ac") ? (i % 2 === 0 ? 1 : 0) : NOUL_BY_ID[input.decisionId], confidence: 0.9 }
        : q.type === "choice"
          ? { type: "choice", choice: k.startsWith("cand") ? (i === 1 ? "duplicate" : "related") : CHOICE_BY_ID[input.decisionId], confidence: 0.9 }
          : { type: "score", score: 2, confidence: null },
    ]));
    return {
      ok: true,
      decisionId: input.decisionId,
      annotation: { answers: overrides[input.decisionId] ?? answers, confidence: 0.9 },
      eventId: `evt-${input.decisionId}`,
    };
  };
  return { calls, resolved, caller };
}

const CANDIDATES = [
  { key: "FEN-10", title: "Gantt snapshot export" },
  { key: "FEN-11", title: "webhook retry backoff" },
];
const ACS = [
  { id: "AC-1", text: "returns a PNG data-URL for a populated schedule" },
  { id: "AC-2", text: "empty schedule throws EmptyScheduleError" },
];

const serveAll = async (extra = {}) => {
  const stub = stubCaller(extra.stub ?? {});
  const { record, warnings } = await buildPlanGates({
    issue: "FEN-100",
    state: STATE,
    caller: stub.caller,
    candidates: CANDIDATES,
    acs: ACS,
    runId: RUN_ID,
    ...extra.args,
  });
  return { record, warnings, stub };
};

// The real seam, driven over an injected fetch: every request body is
// captured, and the response answers exactly the questions the body carried
// (typed like the real Jev decisions endpoint answers them).
const jevBody = (body) => ({
  model: "typesafe/jev-1.13-20260917",
  answers: Object.fromEntries(Object.entries(body.questions).map(([k, q], i) => [
    k,
    q.type === "noul" ? { type: "noul", noul: 0.9 }
      : q.type === "choice" ? { type: "choice", choice: k.startsWith("cand") ? (i === 1 ? "duplicate" : "related") : Object.keys(q.criteria)[0] }
        : { type: "score", score: 2 },
  ])),
  usage: { input_tokens: 10, output_tokens: 2, cost: 0.000001 },
  id: "gen-plan-gates-test",
  provider: "TypeSafe",
});

// ── serving ──────────────────────────────────────────────────────────────────
console.log("\nserving — the ten PLAN gates resolve through the seam");

testAsync("all ten gates serve and record the annotation shape (answer(s), confidence, eventId)", async () => {
  const { record, warnings } = await serveAll();
  assert.equal(warnings.length, 0, JSON.stringify(warnings));
  assert.deepEqual(Object.keys(record.decisions), PLAN_DECISIONS, "serve order");
  assert.equal(record.issue, "FEN-100");
  assert.equal(record.runId, RUN_ID);
  for (const id of PLAN_DECISIONS) {
    const d = record.decisions[id];
    assert.equal(d.ok, true, id);
    assert.equal(d.confidence, 0.9, id);
    assert.equal(d.eventId, `evt-${id}`, id);
  }
  for (const id of PLAN_DECISIONS.filter((x) => !["plan.duplicate_of", "plan.ac.testable"].includes(x))) {
    const d = record.decisions[id];
    assert.ok(d.answer && typeof d.answer === "object" && d.answer.type, `${id} carries the typed seam answer`);
  }
  assert.equal(record.decisions["plan.labels.type"].answer.choice, "feature");
  assert.equal(record.decisions["plan.dor.context_sufficient"].answer.noul, 0);
  assert.equal(record.decisions["plan.estimate"].answer.score, 2);
});

testAsync("the per-instance gates pass raw instances — the seam instantiates the registry templates", async () => {
  const { stub } = await serveAll();
  const dup = stub.calls.find((c) => c.decisionId === "plan.duplicate_of");
  assert.ok(dup, "duplicate_of was called");
  assert.deepEqual(dup.instances, CANDIDATES, "the raw candidate records ride the call — never question text");
  assert.ok(!("questions" in dup), "no inline questions key on a template gate");
  const dupResolved = stub.resolved.find((r) => r.decisionId === "plan.duplicate_of");
  assert.deepEqual(Object.keys(dupResolved.questions), ["cand0", "cand1"], "the seam fanned the template out per candidate");
  assert.ok(dupResolved.questions.cand0.instructions.includes("Gantt snapshot export"), "candidate 0 title substituted");
  assert.ok(dupResolved.questions.cand1.instructions.includes("webhook retry backoff"), "candidate 1 title substituted");
  assert.ok(dupResolved.questions.cand0.instructions.includes("FEN-10"), "candidate 0 key substituted");
  const ac = stub.calls.find((c) => c.decisionId === "plan.ac.testable");
  assert.ok(ac, "ac.testable was called");
  assert.deepEqual(ac.instances, ACS, "the raw criterion records ride the call");
  const acResolved = stub.resolved.find((r) => r.decisionId === "plan.ac.testable");
  assert.deepEqual(Object.keys(acResolved.questions), ["ac0", "ac1"], "the seam fanned the template out per criterion");
  assert.ok(acResolved.questions.ac0.instructions.includes("AC-1"), "criterion id substituted");
  assert.ok(acResolved.questions.ac0.instructions.includes("returns a PNG data-URL"), "criterion text substituted");
  // The fixed gates ride the plain decisionId shape — no inline questions, no instances.
  const type = stub.calls.find((c) => c.decisionId === "plan.labels.type");
  assert.ok(type && !("questions" in type) && !("instances" in type), "fixed gates carry no inline questions and no instances");
});

testAsync("the reviewer's round-1 probe, verbatim, against the REAL seam: inline questions on a template entry are invalid_input; instances are accepted", async () => {
  const probe = createDecisionCaller({
    apiKey: null,
    fetchImpl: async () => { throw new Error("network must never be reached by these probes"); },
    delayFn: async () => {},
    runId: null,
    shadowDir: null,
    meter: () => {},
  });
  const rejected = await probe({
    state: STATE,
    decisionId: "plan.duplicate_of",
    questions: { cand0: { type: "choice", instructions: "how does this task relate?", criteria: { duplicate: "d", related: "r", distinct: "x" } } },
  });
  assert.equal(rejected.ok, false, "the exact payload the round-1 blocker pinned");
  assert.equal(rejected.error.code, "invalid_input");
  assert.match(rejected.error.message, /mutually exclusive/);
  const accepted = await probe({
    state: STATE,
    decisionId: "plan.duplicate_of",
    instances: [{ key: "FEN-10", title: "Gantt snapshot export" }],
  });
  assert.equal(accepted.ok, false);
  assert.equal(accepted.error.code, "auth_missing", "the same call with instances passes the shape — it fails later, at the missing key, never at the contract");
  const noTemplates = await probe({ state: STATE, decisionId: "gate.screen", instances: [{ a: "b" }] });
  assert.equal(noTemplates.ok, false);
  assert.equal(noTemplates.error.code, "invalid_input", "instances on a non-template entry fail closed too");
});

testAsync("through the REAL seam: buildPlanGates over createDecisionCaller serves all ten gates and the labels join real events", async () => {
  const bodies = [];
  const runsDir = join(tmp, "runs-real");
  const realCaller = createDecisionCaller({
    apiKey: "test-key",
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      bodies.push(body);
      return { ok: true, status: 200, json: async () => jevBody(body) };
    },
    delayFn: async () => {},
    runId: RUN_ID,
    shadowDir: join(runsDir, RUN_ID),
    taskKey: "FEN-100",
    meter: () => {},
  });
  const { record, warnings } = await buildPlanGates({
    issue: "FEN-100",
    state: STATE,
    caller: realCaller,
    candidates: CANDIDATES,
    acs: ACS,
    runId: RUN_ID,
  });
  assert.equal(warnings.length, 0, JSON.stringify(warnings));
  for (const id of PLAN_DECISIONS) {
    assert.equal(record.decisions[id].ok, true, id);
    assert.ok(record.decisions[id].eventId, `${id} carries a real eventId from the shadow log`);
  }
  // The SEAM instantiated the templates — the outgoing bodies carry the
  // registry-owned question text with the injected data substituted in.
  const dupBody = bodies.find((b) => b.questions.cand0);
  assert.ok(dupBody, "duplicate_of request captured");
  assert.ok(dupBody.questions.cand0.instructions.includes("Gantt snapshot export"), "candidate title substituted by the seam");
  assert.ok(dupBody.questions.cand1.instructions.includes("FEN-11"), "candidate key substituted by the seam");
  const acBody = bodies.find((b) => b.questions.ac0);
  assert.ok(acBody, "ac.testable request captured");
  assert.ok(acBody.questions.ac0.instructions.includes("AC-1"), "criterion id substituted by the seam");
  assert.equal(record.decisions["plan.duplicate_of"].duplicateOf, "FEN-11", "duplicateOf derived from the seam's own answers");
  // The full FOC-449 loop against the REAL event lines the seam wrote.
  const { labelled, warnings: labelWarnings } = labelAppliedPlan({
    record,
    applied: { type: "feature", risk: "none", estimate: "M" },
    issue: "FEN-100",
    runsDir,
  });
  assert.equal(labelWarnings.length, 0, JSON.stringify(labelWarnings));
  assert.equal(labelled.length, 3, "type + risk + estimate joined to real events");
});

testAsync("plan.duplicate_of derives duplicateOf from the answered candidate", async () => {
  const { record } = await serveAll();
  assert.equal(record.decisions["plan.duplicate_of"].duplicateOf, "FEN-11", "the candidate answered duplicate");
  const none = await serveAll({
    stub: {
      overrides: {
        "plan.duplicate_of": {
          cand0: { type: "choice", choice: "distinct", confidence: 0.8 },
          cand1: { type: "choice", choice: "related", confidence: 0.8 },
        },
      },
    },
  });
  assert.equal(none.record.decisions["plan.duplicate_of"].duplicateOf, null, "nothing judged a duplicate");
});

testAsync("empty injected lists skip the per-instance gates, visibly, and the rest still serve", async () => {
  const { record, warnings } = await serveAll({ args: { candidates: [], acs: [] } });
  assert.equal(record.decisions["plan.duplicate_of"].ok, false);
  assert.equal(record.decisions["plan.duplicate_of"].code, "no_candidates");
  assert.equal(record.decisions["plan.ac.testable"].ok, false);
  assert.equal(record.decisions["plan.ac.testable"].code, "no_acs");
  assert.equal(warnings.length, 2, JSON.stringify(warnings));
  assert.match(warnings[0], /plan\.duplicate_of skipped/);
  assert.match(warnings[1], /plan\.ac\.testable skipped/);
  assert.equal(record.decisions["plan.labels.type"].ok, true, "the fixed gates are unaffected");
});

testAsync("malformed serve-time instances fail closed before any call", async () => {
  for (const bad of [
    { candidates: [{ key: "FEN-10" }] },
    { candidates: "nope" },
    { candidates: [{ key: "FEN-10", title: "t" }, { key: "FEN-11", title: "" }] },
    { candidates: Array.from({ length: 13 }, (_, i) => ({ key: `K${i}`, title: "t" })) },
    { acs: [{ id: "AC-1" }] },
    { acs: Array.from({ length: 13 }, (_, i) => ({ id: `AC-${i}`, text: "t" })) },
  ]) {
    const stub = stubCaller();
    await assert.rejects(
      () => buildPlanGates({ issue: "FEN-100", state: STATE, caller: stub.caller, ...bad }),
      /buildPlanGates/,
      "the malformed input must be refused",
    );
    assert.equal(stub.calls.length, 0, "the refusal precedes any seam call");
  }
});

testAsync("a failed decision is recorded ok:false and the rest still serve", async () => {
  const { record, warnings } = await serveAll({ stub: { failIds: ["plan.labels.type", "plan.needs_adr"] } });
  const failed = record.decisions["plan.labels.type"];
  assert.equal(failed.ok, false);
  assert.equal(failed.code, "auth_missing");
  assert.equal(failed.eventId, "evt-plan.labels.type", "a failed call still carries its event id");
  assert.equal(record.decisions["plan.needs_adr"].ok, false);
  assert.equal(record.decisions["plan.dor.criteria_testable"].ok, true);
  assert.equal(warnings.length, 2, JSON.stringify(warnings));
  assert.match(warnings[0], /plan\.labels\.type failed closed \(auth_missing\)/);
});

testAsync("a throwing caller fails that decision closed (typed record + warning) and the rest still serve", async () => {
  const base = stubCaller();
  const throwing = async (input) => {
    if (input.decisionId === "plan.labels.type") throw new Error("connection reset mid-serve");
    return base.caller(input);
  };
  const { record, warnings } = await buildPlanGates({
    issue: "FEN-100",
    state: STATE,
    caller: throwing,
    candidates: CANDIDATES,
    acs: ACS,
    runId: RUN_ID,
  });
  const failed = record.decisions["plan.labels.type"];
  assert.equal(failed.ok, false);
  assert.equal(failed.code, null, "a plain Error carries no typed code — recorded honestly as null");
  assert.equal(failed.message, "connection reset mid-serve");
  assert.equal(record.decisions["plan.dor.criteria_testable"].ok, true, "the rest still serve");
  const warning = warnings.find((w) => w.includes("plan.labels.type"));
  assert.ok(warning, JSON.stringify(warnings));
  assert.match(warning, /plan\.labels\.type failed closed \(error\)/);
});

testAsync("a state over the seam's 16000-char cap is truncated, never refused (supervisor-triage precedent)", async () => {
  const { stub, warnings } = await serveAll({ args: { state: "x".repeat(20000) } });
  assert.equal(warnings.length, 0, JSON.stringify(warnings));
  assert.equal(stub.calls.length, 10, "all ten gates still serve");
  for (const call of stub.calls) assert.equal(call.state.length, 16000, "every call rides the capped state");
  const { stub: short } = await serveAll();
  assert.equal(short.calls[0].state, STATE, "an under-cap state passes through untouched");
});

testAsync("bad arguments fail closed before any call (identity, state, caller)", async () => {
  const stub = stubCaller();
  await assert.rejects(() => buildPlanGates({ state: STATE, caller: stub.caller }), /issue identity/);
  await assert.rejects(() => buildPlanGates({ issue: "FEN-100", caller: stub.caller }), /state text/);
  await assert.rejects(() => buildPlanGates({ issue: "FEN-100", state: "   ", caller: stub.caller }), /state text/);
  await assert.rejects(() => buildPlanGates({ issue: "FEN-100", state: STATE }), /seam caller/);
  assert.equal(stub.calls.length, 0);
});

// ── A0 display ───────────────────────────────────────────────────────────────
console.log("\nA0 — annotations are displayed, never auto-acted");

testAsync("seam/applied disagreements are surfaced with both values", async () => {
  const { record } = await serveAll();
  const shown = disagreementsOf(record, { type: "bug", risk: null, estimate: "M" });
  assert.deepEqual(shown, [{ decisionId: "plan.labels.type", seam: "feature", applied: "bug" }]);
  // The record keeps the seam answer verbatim — never swapped for the applied value.
  assert.equal(record.decisions["plan.labels.type"].answer.choice, "feature");
});

testAsync("agreement is not invented: matching values, risk silence and score→size reads produce none", async () => {
  const { record } = await serveAll();
  assert.deepEqual(disagreementsOf(record, { type: "feature", risk: null, estimate: "M" }), []);
  // estimate: the seam answered score 2 → "M"; the comparison reads the size both sides share.
  const disagree = disagreementsOf(record, { type: "feature", risk: "high", estimate: "L" });
  assert.deepEqual(disagree, [
    { decisionId: "plan.labels.risk", seam: "none", applied: "high" },
    { decisionId: "plan.estimate", seam: "M", applied: "L" },
  ]);
});

testAsync("incomparable sides are skipped, never resolved into fake agreement or fake disagreement", async () => {
  const { record } = await serveAll({
    stub: { overrides: { "plan.estimate": { q0: { type: "score", score: 9, confidence: null } } } },
  });
  assert.deepEqual(disagreementsOf(record, { type: "feature", risk: null, estimate: "L" }), [], "score 9 has no size");
  assert.deepEqual(disagreementsOf(record, { type: "feature", risk: null }), [], "no applied estimate → nothing to compare");
  assert.deepEqual(disagreementsOf(record, { type: "feature", risk: null, estimate: "huge" }), [], "an unknown size is not comparable");
  const failed = await serveAll({ stub: { failIds: ["plan.labels.type"] } });
  assert.deepEqual(disagreementsOf(failed.record, { type: "bug", risk: null, estimate: "M" }), [], "a failed decision carries no seam value");
});

testAsync("displayPlanGates announces each disagreement and returns it for the record", async () => {
  const { record } = await serveAll();
  const orig = console.error;
  const lines = [];
  console.error = (l) => lines.push(l);
  let shown;
  try {
    shown = displayPlanGates(record, { type: "bug", risk: null, estimate: "L" });
  } finally {
    console.error = orig;
  }
  assert.equal(shown.length, 2);
  assert.match(lines[0], /\[plan-gates\] A0 disagreement — seam plan\.labels\.type says "feature", the applied value is "bug"/);
  assert.match(lines[1], /seam plan\.estimate says "M", the applied value is "L"/);
  for (const line of lines) assert.match(line, /displayed, never auto-acted/);
  const quiet = [];
  console.error = (l) => quiet.push(l);
  try {
    displayPlanGates(record, { type: "feature", risk: null, estimate: "M" });
  } finally {
    console.error = orig;
  }
  assert.equal(quiet.length, 0, "agreement displays nothing");
});

// ── outcome logging (FOC-449) ────────────────────────────────────────────────
console.log("\noutcomes — applied labels join their own events");

// A fixture run log holding the events the stubbed serve produced (the
// eventIds are the stub's `evt-<decisionId>`), in the run directory the
// record's runId names — the exact layout labelAppliedPlan looks up.
function fixtureLog(name, { withType = true, withRisk = true, withEstimate = true, foreignKey = null, taskKeyless = [] } = {}) {
  const runsDir = join(tmp, `runs-${name}`);
  const logDir = join(runsDir, RUN_ID);
  mkdirSync(logDir, { recursive: true });
  const key = foreignKey ?? "FEN-100";
  const events = [];
  if (withType) events.push({ type: "event", eventId: "evt-plan.labels.type", decisionId: "plan.labels.type", taskKey: key });
  if (withRisk) events.push({ type: "event", eventId: "evt-plan.labels.risk", decisionId: "plan.labels.risk", taskKey: key });
  if (withEstimate) events.push({ type: "event", eventId: "evt-plan.estimate", decisionId: "plan.estimate", taskKey: key });
  for (const id of taskKeyless) events.push({ type: "event", eventId: `evt-${id}`, decisionId: id });
  writeFileSync(join(logDir, "decisions.jsonl"), events.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  return runsDir;
}

const labelsIn = (runsDir) =>
  readFileSync(join(runsDir, RUN_ID, "decisions.jsonl"), "utf8")
    .trim().split("\n").map((l) => JSON.parse(l))
    .filter((l) => l.type === "label");

testAsync("applied labels become FOC-449 records tied to the exact eventIds", async () => {
  const { record } = await serveAll();
  const runsDir = fixtureLog("labels");
  const { labelled, warnings } = labelAppliedPlan({
    record,
    applied: { type: "feature", risk: null, estimate: "M" },
    issue: "FEN-100",
    runsDir,
  });
  assert.equal(warnings.length, 0, JSON.stringify(warnings));
  assert.equal(labelled.length, 3, "type + risk(none) + estimate");
  const byEvent = Object.fromEntries(labelsIn(runsDir).map((l) => [l.eventId, l]));
  assert.equal(byEvent["evt-plan.labels.type"].outcome, "feature");
  assert.equal(byEvent["evt-plan.labels.risk"].outcome, "none", "no applied risk label IS the none answer");
  assert.equal(byEvent["evt-plan.estimate"].outcome, "M", "the outcome is the t-shirt size, in the criteria vocabulary");
  for (const l of Object.values(byEvent)) {
    assert.equal(l.by, "agent");
    assert.equal(l.source, "auto");
    assert.equal(l.via, "labels");
  }
});

testAsync("a failed decision is never tied back, even with an eventId and a stated applied value", async () => {
  const { record } = await serveAll({ stub: { failIds: ["plan.labels.type"] } });
  const runsDir = fixtureLog("failed");
  const { labelled, warnings } = labelAppliedPlan({
    record,
    applied: { type: "feature", risk: null, estimate: "M" },
    issue: "FEN-100",
    runsDir,
  });
  assert.equal(labelled.length, 2, "risk(none) + estimate only — the failed type decision collects nothing");
  const events = labelsIn(runsDir).map((l) => l.eventId);
  assert.ok(!events.includes("evt-plan.labels.type"), "the failed decision's eventId never receives a label");
  assert.equal(warnings.length, 0, JSON.stringify(warnings));
});

testAsync("no eventIds and absent applied values label nothing and warn nobody", async () => {
  const bare = {
    runId: "nowhere",
    decisions: { "plan.labels.type": { ok: true, answer: { type: "choice", choice: "feature", confidence: 0.9 } } },
  };
  const { labelled, warnings } = labelAppliedPlan({
    record: bare,
    applied: { type: "feature", risk: null, estimate: "M" },
    issue: "FEN-100",
    runsDir: join(tmp, "runs-empty"),
  });
  assert.equal(labelled.length, 0);
  assert.equal(warnings.length, 0);

  const { record } = await serveAll();
  const runsDir = fixtureLog("labels-empty");
  const res = labelAppliedPlan({ record, applied: {}, issue: "FEN-100", runsDir });
  assert.equal(res.labelled.length, 0, "no applied value → no label");
  assert.equal(res.warnings.length, 0);
  assert.equal(labelsIn(runsDir).length, 0);
  const partial = labelAppliedPlan({ record, applied: { type: "feature" }, issue: "FEN-100", runsDir });
  assert.equal(partial.labelled.length, 1, "only the stated fields label");
});

testAsync("a cross-issue outcome is never joined — the taskKey refusal, before any write", async () => {
  const { record } = await serveAll();
  const runsDir = fixtureLog("pairing", { foreignKey: "FEN-888" });
  const { labelled, warnings } = labelAppliedPlan({
    record,
    applied: { type: "feature", risk: null, estimate: "M" },
    issue: "FEN-100",
    runsDir,
  });
  assert.equal(labelled.length, 0, "a mismatched event must not collect the outcome");
  assert.equal(warnings.length, 3, JSON.stringify(warnings));
  assert.match(warnings[0], /taskKey is "FEN-888", not "FEN-100"/);
  assert.match(warnings[0], /a cross-issue outcome is never joined/);
  assert.equal(labelsIn(runsDir).length, 0, "no label line reaches the log");
});

testAsync("an event that is nowhere and an event without a taskKey are best-effort warnings", async () => {
  const { record } = await serveAll();
  // Only the type event exists: the other two lookups warn "not found".
  const runsDir = fixtureLog("unknown", { withRisk: false, withEstimate: false });
  const { labelled, warnings } = labelAppliedPlan({
    record,
    applied: { type: "feature", risk: null, estimate: "M" },
    issue: "FEN-100",
    runsDir,
  });
  assert.equal(labelled.length, 1, "only the type event is joinable here");
  assert.equal(warnings.length, 2, JSON.stringify(warnings));
  assert.match(warnings[0], /decision label for event evt-plan\.labels\.risk was not written/);
  assert.match(warnings[1], /decision label for event evt-plan\.estimate was not written/);

  // An event present but carrying no taskKey cannot be verified → refused.
  // Only that event is in the log: the other two lookups warn "not found".
  const noKeyDir = fixtureLog("nokey", { withType: false, withRisk: false, withEstimate: false, taskKeyless: ["plan.estimate"] });
  const res = labelAppliedPlan({
    record,
    applied: { type: "feature", risk: null, estimate: "M" },
    issue: "FEN-100",
    runsDir: noKeyDir,
  });
  assert.equal(res.labelled.length, 0);
  assert.equal(res.warnings.length, 3, JSON.stringify(res.warnings));
  assert.match(res.warnings[2], /taskKey is "missing", not "FEN-100"/);
});

testAsync("labelAppliedPlan refuses without the issue identity", async () => {
  assert.throws(() => labelAppliedPlan({ record: {}, applied: {}, issue: "  " }), /issue being planned/);
  assert.throws(() => labelAppliedPlan({ record: {}, applied: {} }), /issue being planned/);
});

// ── summary ───────────────────────────────────────────────────────────────────
(async () => {
  for (const { name, fn } of asyncTests) {
    try {
      await fn();
      passed++;
      console.log(`  PASS ${name}`);
    } catch (err) {
      failures.push(name);
      const at = String(err.stack ?? "").split("\n").find((l) => l.includes("plan-gates.test.mjs:")) ?? "";
      console.log(`  FAIL ${name}\n       ${err.message}\n       ${at.trim()}`);
    }
  }
  console.log("");
  if (failures.length) {
    console.log(`${passed} passed, ${failures.length} FAILED`);
    process.exitCode = 1;
    return;
  }
  console.log(`${passed} passed, 0 failed`);
})();
