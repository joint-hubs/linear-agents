// scripts/decisions-registry.test.mjs — FOC-448: the decision & node registry.
//
// Validates config/decisions.json end to end against the loader's own
// schemas (scripts/decision-registry.mjs), pins the contracted seed content,
// and anti-drifts the registry against the seam: every transport question
// value is validated against decision-call's OWN question schema — derived
// here from DECISION_STEP.inputSchema, the identical object the seam
// validates a resolved question set against at call time — and the shipped
// tier2:"disabled" posture is tied to the shipped FALLBACK_MODEL constant
// (FOC-473). Also covers the loader's fail-closed exits and the template
// instantiation the migrated FOC-401 steps now run through, pinned
// byte-identical to the pre-migration literals.
//
// Run: node scripts/decisions-registry.test.mjs

import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv from "ajv";
import {
  loadRegistry, getRegistryEntry, resolveEntryQuestions, instantiateEntryQuestions,
  ENTRY_SCHEMA, REGISTRY_SCHEMA,
} from "./decision-registry.mjs";
import { DECISION_STEP, FALLBACK_MODEL } from "./decision-call.mjs";
import { TypedError } from "./mcp/envelope.mjs";

// Hermetic by construction: a test run must never write telemetry.
delete process.env.LA_RUN_ID;

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
const deepEq = (a, b, label) => {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) fail(`${label}: ${sa} !== ${sb}`);
};

// Sync loader → sync throws helper. Asserts the typed code and, when given,
// a message needle, so a failure names the actual rule that fired.
const throwsCode = (fn, code, needle) => {
  try {
    fn();
  } catch (err) {
    if (!(err instanceof TypedError)) fail(`expected TypedError, got ${err?.name}: ${err?.message}`);
    eq(err.code, code, "typed error code");
    if (needle && !String(err.message).includes(needle)) fail(`message should include "${needle}", got: ${err.message}`);
    return err;
  }
  fail(`expected a ${code} TypedError, none thrown`);
};

// ── anti-drift derivation ───────────────────────────────────────────────────
// The seam's own question schema, taken from the shipped DECISION_STEP — the
// identical object decision-call validates a resolved registry question set
// against on every decisionId call. A registry drift fails here AND at the
// seam; no second copy of the schema is maintained.
const QUESTION_SCHEMA = DECISION_STEP.inputSchema.properties.questions.additionalProperties;
const QUESTION_VALIDATE = new Ajv().compile(QUESTION_SCHEMA);

// ── the shipped seed set ────────────────────────────────────────────────────
const SEED_IDS = [
  "plan.dor", "plan.ac", "plan.spec", "plan.gate1", "plan.decompose",
  "plan.gate2", "plan.push", "gate.screen", "extraction", "prompt-refinement",
  // The five FOC-397 decide-edge entries (graph decisionEdges bindings) plus
  // the FOC-451 DoR intake gate, bound the same way.
  "intake.triage_node", "intake.has_acceptance_criteria", "intake.task_size", "review.depth",
  "orchestration.next_step", "monitor.child_state",
];
const NODE_IDS = SEED_IDS.slice(0, 7);
// The decide-edge bindings (config/graph.json decisionEdges): kind-J transport
// entries that additionally pin their cascade ladder start (tier {cascade, min}).
const DECIDE_EDGE_IDS = SEED_IDS.slice(10);
const TRANSPORT_IDS = SEED_IDS.slice(7);
// OUT of scope per the FOC-448 contract — they enter when their owners land.
const OUT_OF_SCOPE = ["egress.contains_secret", "test.failure.cause"];
const AUTONOMY_MAP = {
  "plan.dor": "A0", "plan.ac": null, "plan.spec": null, "plan.gate1": null,
  "plan.decompose": "A0", "plan.gate2": null, "plan.push": null,
  "gate.screen": "A0", "extraction": "A0", "prompt-refinement": "A0",
  "intake.triage_node": "A0", "intake.has_acceptance_criteria": "A0", "intake.task_size": "A0", "review.depth": "A0",
  "orchestration.next_step": "A0", "monitor.child_state": "A0",
};
const METRICS_BY_ID = {
  "plan.dor": ["durationMs", "inputTokens", "outputTokens", "cost", "confidence"],
  "plan.decompose": ["durationMs", "inputTokens", "outputTokens", "cost", "confidence"],
  "gate.screen": ["durationMs", "inputTokens", "outputTokens", "cost", "confidence"],
  extraction: ["durationMs", "inputTokens", "outputTokens", "cost", "confidence"],
  "prompt-refinement": ["durationMs", "inputTokens", "outputTokens", "cost", "confidence"],
  "plan.ac": ["durationMs", "inputTokens", "outputTokens", "cost"],
  "plan.spec": ["durationMs", "inputTokens", "outputTokens", "cost"],
  "plan.gate1": [],
  "plan.gate2": [],
  "plan.push": [],
};
for (const id of DECIDE_EDGE_IDS) {
  METRICS_BY_ID[id] = ["durationMs", "inputTokens", "outputTokens", "cost", "confidence"];
}

const registry = loadRegistry();
const entries = registry.entries;

console.log("\ndecisions-registry: seed set + per-entry contract");

await test("registry loads, passes REGISTRY_SCHEMA directly, and carries _doc + entries", () => {
  const ajv = new Ajv();
  eq(ajv.validate(REGISTRY_SCHEMA, registry), true, "shipped registry passes REGISTRY_SCHEMA");
  if (!registry._doc || typeof registry._doc !== "object") fail("_doc missing");
  eq(Object.keys(entries).length, SEED_IDS.length, "entry count");
});

await test("the seed set is exactly the sixteen contracted ids", () => {
  deepEq([...Object.keys(entries)].sort(), [...SEED_IDS].sort(), "id set");
});

await test("out-of-scope judgments are absent (they enter when their owners land)", () => {
  for (const id of OUT_OF_SCOPE) eq(entries[id], undefined, `${id} absent`);
});

await test("every entry id equals its key and passes ENTRY_SCHEMA directly", () => {
  const ajv = new Ajv();
  const validate = ajv.compile(ENTRY_SCHEMA);
  for (const [key, entry] of Object.entries(entries)) {
    eq(entry.id, key, `id === key for ${key}`);
    if (!validate(entry)) fail(`${key}: ${JSON.stringify(validate.errors)}`);
  }
});

await test("autonomy map is exactly the seed posture (nothing calibrated, nothing wired)", () => {
  for (const id of SEED_IDS) eq(entries[id].autonomy, AUTONOMY_MAP[id], `autonomy of ${id}`);
});

await test("threshold is null in every seed entry — FOC-387 writes calibration rows", () => {
  for (const id of SEED_IDS) eq(entries[id].threshold, null, `threshold of ${id}`);
});

await test("criteriaVersion is 1 everywhere", () => {
  for (const id of SEED_IDS) eq(entries[id].criteriaVersion, 1, `criteriaVersion of ${id}`);
});

await test("metrics sets match the contract per kind", () => {
  for (const id of SEED_IDS) deepEq(entries[id].metrics, METRICS_BY_ID[id], `metrics of ${id}`);
});

console.log("\ndecisions-registry: serving scope + structural autonomy (review round 1)");

// Serving is pinned per kind-J entry. The seam NAME is reserved for the
// A0-enforced decisionId channel (loader rule); the step servers' inline
// channel names itself "seam (inline)" and stays the declared boundary gated
// to FOC-387. plan.dor / plan.decompose gained their real seam serving with
// FOC-397, as did the decide edges (FOC-451 added the DoR intake gate).
const SEAM_SERVING = [{ via: "seam", actsOnAnswers: false, a0Enforced: true }];
const SERVING_BY_ID = {
  extraction: [{ via: "seam (inline)", actsOnAnswers: true, a0Enforced: false, gate: "FOC-387" }],
  "prompt-refinement": [{ via: "seam (inline)", actsOnAnswers: true, a0Enforced: false, gate: "FOC-387" }],
  "gate.screen": SEAM_SERVING,
  "plan.dor": SEAM_SERVING,
  "plan.decompose": SEAM_SERVING,
  "intake.triage_node": SEAM_SERVING,
  "intake.has_acceptance_criteria": SEAM_SERVING,
  "intake.task_size": SEAM_SERVING,
  "review.depth": SEAM_SERVING,
  "orchestration.next_step": SEAM_SERVING,
  "monitor.child_state": SEAM_SERVING,
};

await test("serving is pinned per kind-J entry: enforced seam paths + the declared inline boundary", () => {
  for (const id of SEED_IDS) {
    if (entries[id].serving === undefined) continue; // node configs carry none — structural test below
    deepEq(entries[id].serving, SERVING_BY_ID[id], `serving of ${id}`);
  }
});

await test("autonomy encoding is structural: null IFF kind is not J; kind J declares non-empty serving", () => {
  for (const id of SEED_IDS) {
    const e = entries[id];
    if (e.kind === "J") {
      if (e.autonomy !== "A0" && e.autonomy !== "A1" && e.autonomy !== "A2") fail(`${id}: kind J must carry A0/A1/A2`);
      if (!Array.isArray(e.serving) || e.serving.length === 0) fail(`${id}: kind J must declare non-empty serving`);
    } else {
      eq(e.autonomy, null, `node config ${id} is autonomy-null`);
      if (e.serving !== undefined) fail(`${id}: non-J entries carry no serving`);
    }
  }
});

await test("fallback tier2 is disabled everywhere and corresponds to the shipped FALLBACK_MODEL", () => {
  for (const id of SEED_IDS) {
    const fb = entries[id].fallback;
    eq(fb.tier2, "disabled", `tier2 of ${id}`);
    // The drift pin: tier2 "disabled" ⇔ FALLBACK_MODEL === null (FOC-473).
    // Re-arming either side is a deliberate change to BOTH.
    eq(fb.tier2 === "disabled", FALLBACK_MODEL === null, `tier2 ↔ FALLBACK_MODEL for ${id}`);
    if (typeof fb.onModelFailure !== "string" || fb.onModelFailure.length === 0) fail(`${id}: empty onModelFailure`);
  }
});

console.log("\ndecisions-registry: D7 node entries (design doc §3.1–§3.9, verbatim)");

// Full D7 pins per node entry — reads / tier / failure / writes verbatim from
// the design doc; output schemas are covered by the compile + sample tests.
const D7 = {
  "plan.dor": { reads: ["inbox.entry", "repoState.pinned"], tier: { cascade: true, min: 1 }, failure: "escalate", writes: "run-record" },
  "plan.ac": { reads: ["inbox.entry", "features.list"], tier: "cheap", failure: "stop", writes: "run-record" },
  "plan.spec": { reads: ["inbox.entry", "plan.ac.acs", "plan.ac.definitionOfDone", "repoState.pinned"], tier: "agent", failure: "escalate", writes: "run-record" },
  "plan.gate1": { reads: ["plan.spec.record"], tier: null, failure: "stop", writes: "graph-state" },
  "plan.decompose": { reads: ["plan.spec.record", "plan.ac.acs"], tier: { cascade: true, min: 1 }, failure: "escalate", writes: "run-record" },
  "plan.gate2": { reads: ["plan.decompose.record", "gate.plan.gate1.record"], tier: null, failure: "stop", writes: "graph-state" },
  "plan.push": { reads: ["plan.decompose.record", "gate.plan.gate2.record"], tier: null, failure: "stop", writes: "run-record" },
};

await test("the seven node entries carry the full D7 contract; transports carry no D7 fields", () => {
  for (const id of NODE_IDS) {
    const e = entries[id];
    deepEq(e.reads, D7[id].reads, `reads of ${id}`);
    deepEq(e.tier, D7[id].tier, `tier of ${id}`);
    eq(e.failure, D7[id].failure, `failure of ${id}`);
    eq(e.writes, D7[id].writes, `writes of ${id}`);
    if (e.questions !== undefined) fail(`${id}: node entry must not carry a question set`);
  }
  for (const id of TRANSPORT_IDS) {
    const e = entries[id];
    if (e.questions === undefined) fail(`${id}: transport entry must carry a question set`);
    for (const field of ["reads", "output", "failure", "writes", "prompt"]) {
      if (e[field] !== undefined) fail(`${id}: transport entry must not carry ${field}`);
    }
    // FOC-397: the cascade-tier pin is allowed on a decide edge and forbidden
    // on every other transport entry — no other question-carrying entry needs
    // a ladder, and a stray tier on one would be unexplained configuration.
    if (DECIDE_EDGE_IDS.includes(id)) {
      deepEq(e.tier, { cascade: true, min: 1 }, `cascade tier pin of ${id}`);
    } else if (e.tier !== undefined) {
      fail(`${id}: transport entry must not carry tier`);
    }
  }
});

await test("decide-edge entries pin the cascade ladder and exactly one question each", () => {
  // QTYPE: the FOC-397 MAP questions are choices; the FOC-451 DoR intake gate
  // is a noul (boolean-with-confidence), matching its true/false criteria.
  const QTYPE = {
    "intake.triage_node": "choice",
    "intake.has_acceptance_criteria": "noul",
    "intake.task_size": "choice",
    "review.depth": "choice",
    "orchestration.next_step": "choice",
    "monitor.child_state": "choice",
  };
  const CRITERIA = {
    "intake.triage_node": ["plan", "dev", "review", "test", "ask"],
    "intake.has_acceptance_criteria": ["true", "false"],
    "intake.task_size": ["small", "medium", "large"],
    "review.depth": ["first-pass", "deep", "security"],
    "orchestration.next_step": ["wait", "resume", "advance", "escalate", "ask"],
    "monitor.child_state": ["stuck", "working", "waiting"],
  };
  for (const id of DECIDE_EDGE_IDS) {
    const e = entries[id];
    deepEq(e.tier, { cascade: true, min: 1 }, `tier pin of ${id}`);
    eq(e.autonomy, "A0", `autonomy of ${id}`);
    deepEq(e.serving, [{ via: "seam", actsOnAnswers: false, a0Enforced: true }], `serving of ${id}`);
    const qids = Object.keys(e.questions);
    if (qids.length !== 1) fail(`${id}: expected one decide question, got ${qids.length}`);
    const q = e.questions[qids[0]];
    eq(q.type, QTYPE[id], `question type of ${id}`);
    deepEq(Object.keys(q.criteria), CRITERIA[id], `criteria labels of ${id}`);
  }
});

await test("every node output schema compiles and accepts a valid sample / rejects an invalid one", () => {
  const SAMPLES = {
    "plan.dor": { ok: { ready: true, gaps: ["x"] }, bad: { ready: "yes", gaps: [] } },
    "plan.ac": { ok: { acs: [{ id: "AC-1", text: "t", kind: "behaviour" }], definitionOfDone: [{ check: "c", kind: "test", bounded: true }] }, bad: { acs: [], definitionOfDone: [] } },
    "plan.spec": { ok: { briefs: ["b"], adr: "a", summary: "s" }, bad: { briefs: "b", adr: "a", summary: "s" } },
    "plan.gate1": { ok: { approved: true }, bad: { approved: "yes" } },
    "plan.gate2": { ok: { approved: true }, bad: {} },
    "plan.decompose": { ok: { tasks: [{ title: "t", size: "small", labels: [], relations: [] }] }, bad: { tasks: [] } },
    "plan.push": { ok: { epicId: "FEN-1", childrenIds: ["FEN-2"], handoffCommentPosted: false }, bad: { epicId: "FEN-1", childrenIds: ["FEN-2"], handoffCommentPosted: false, extra: 1 } },
  };
  const ajv = new Ajv();
  for (const id of NODE_IDS) {
    const validate = ajv.compile(entries[id].output); // throws on a non-compilable schema
    if (validate(SAMPLES[id].ok) !== true) fail(`${id}: valid sample rejected: ${JSON.stringify(validate.errors)}`);
    if (validate(SAMPLES[id].bad) !== false) fail(`${id}: invalid sample accepted: ${JSON.stringify(SAMPLES[id].bad)}`);
  }
});

await test("plan.ac §3.9 bounds are pinned (schema facts AND behavior)", () => {
  const acs = entries["plan.ac"].output.properties.acs;
  const dod = entries["plan.ac"].output.properties.definitionOfDone;
  eq(acs.minItems, 1, "acs minItems");
  eq(acs.maxItems, 12, "acs maxItems");
  deepEq(acs.items.required, ["id", "text", "kind"], "acs item required");
  eq(acs.items.properties.id.pattern, "^AC-[0-9]{1,2}$", "acs id pattern");
  eq(acs.items.properties.text.maxLength, 300, "acs text bound");
  deepEq(acs.items.properties.kind.enum, ["behaviour", "boundary", "verification"], "acs kind enum");
  eq(dod.minItems, 1, "DoD minItems");
  eq(dod.maxItems, 12, "DoD maxItems");
  deepEq(dod.items.required, ["check", "kind", "bounded"], "DoD item required");
  eq(dod.items.properties.check.maxLength, 200, "DoD check bound");
  deepEq(dod.items.properties.kind.enum, ["test", "lint", "manual", "linear"], "DoD kind enum");
  eq(dod.items.properties.bounded.type, "boolean", "DoD bounded type");

  const validate = new Ajv().compile(entries["plan.ac"].output);
  const acs12 = Array.from({ length: 12 }, (_, i) => ({ id: `AC-${i + 1}`, text: "t", kind: "behaviour" }));
  const acs13 = Array.from({ length: 13 }, (_, i) => ({ id: `AC-${i + 1}`, text: "t", kind: "behaviour" }));
  const dod1 = [{ check: "c", kind: "test", bounded: true }];
  eq(validate({ acs: acs12, definitionOfDone: dod1 }), true, "12 acs pass");
  eq(validate({ acs: acs13, definitionOfDone: dod1 }), false, "13 acs fail");
  eq(validate({ acs: [{ id: "AC-123", text: "t", kind: "behaviour" }], definitionOfDone: dod1 }), false, "AC-123 fails the id pattern");
  eq(validate({ acs: [{ id: "AC-1", text: "x".repeat(301), kind: "behaviour" }], definitionOfDone: dod1 }), false, "301-char text fails");
  eq(validate({ acs: [{ id: "AC-1", text: "t", kind: "cosmetic" }], definitionOfDone: dod1 }), false, "bad ac kind fails");
  eq(validate({ acs: acs12, definitionOfDone: [{ check: "x".repeat(201), kind: "test", bounded: true }] }), false, "201-char check fails");
  eq(validate({ acs: acs12, definitionOfDone: [{ check: "c", kind: "someday", bounded: true }] }), false, "bad DoD kind fails");
  eq(validate({ acs: acs12, definitionOfDone: [{ check: "c", kind: "test", bounded: "yes" }] }), false, "non-boolean bounded fails");
});

await test("plan.ac carries the §4 seed [G] prompt, marked pending the runner", () => {
  const p = entries["plan.ac"].prompt;
  if (typeof p !== "string" || p.length === 0) fail("plan.ac prompt missing");
  for (const needle of ["declared inputs", "no tool loop", "never count, size or compute anything", "^AC-[0-9]{1,2}$", "cheap tier", "fail-closed"]) {
    if (!p.includes(needle)) fail(`seed prompt should mention "${needle}"`);
  }
  if (p.includes("FOC-397")) fail("prompt is content, not bookkeeping — the pending marker lives in owner");
  eq(entries["plan.ac"].owner.includes("FOC-397"), true, "owner marks the runner pending");
});

console.log("\ndecisions-registry: transport entries (anti-drift + byte-identity)");

await test("every transport question value passes decision-call's own question schema (anti-drift)", () => {
  for (const id of TRANSPORT_IDS) {
    for (const [qid, q] of Object.entries(entries[id].questions)) {
      if (!QUESTION_VALIDATE(q)) fail(`${id}/${qid} drifted from the seam schema: ${JSON.stringify(QUESTION_VALIDATE.errors)}`);
    }
  }
});

await test("gate.screen carries the advisory FOC-391 seed noul question", () => {
  const qs = entries["gate.screen"].questions;
  deepEq(Object.keys(qs), ["q0"], "single seed question");
  eq(qs.q0.type, "noul", "seed type");
  if (!qs.q0.instructions.includes("FOC-391")) fail("seed question must be marked pending FOC-391");
  if (!qs.q0.instructions.includes("never decides the gate")) fail("seed question must state it never decides the gate");
  eq(qs.q0.criteria.true.includes("ready for the human"), true, "true criterion is advisory");
});

await test("extraction template is byte-identical to the pre-migration step literal", () => {
  deepEq(Object.keys(entries.extraction.questions), ["q{i}"], "template key");
  const q = entries.extraction.questions["q{i}"];
  eq(q.type, "noul", "type");
  eq(q.instructions, `Is this dictated fragment a concrete, buildable expectation? Fragment: "{{name}}". Answer true only if a developer could open a task from it without asking the user what the words mean.`, "instructions");
  deepEq(q.criteria, { true: "concrete expected feature or change", false: "greeting, context, meta-talk, or unactionable fragment" }, "criteria");
});

await test("prompt-refinement templates are byte-identical to the pre-migration step literals", () => {
  deepEq(Object.keys(entries["prompt-refinement"].questions), ["size", "rel{i}"], "template keys");
  const size = entries["prompt-refinement"].questions.size;
  eq(size.type, "choice", "size type");
  eq(size.instructions, "Classify the overall task size for frontman engagement (ADR-0009 amendment).", "size instructions");
  deepEq(size.criteria, {
    small: "small and easy — the Supervisor does the work itself, no squads",
    medium: "medium or complicated — DEV + TEST squads",
    large: "large and very complex — full triage PLAN → DEV → REVIEW → TEST",
  }, "size criteria");
  const rel = entries["prompt-refinement"].questions["rel{i}"];
  eq(rel.type, "choice", "rel type");
  eq(rel.instructions, `How does the feature "{{name}}" relate to the other features in this task?`, "rel instructions");
  deepEq(rel.criteria, {
    standalone: "independent of the other features",
    extension: "extends or refines another feature listed here",
    alternative: "an alternative to another feature (either/or)",
  }, "rel criteria");
});

console.log("\ndecisions-registry: template instantiation (the FOC-401 migration path)");

await test("extraction instantiation reproduces the pre-migration step questions byte-identically", () => {
  const qs = instantiateEntryQuestions("extraction", [{ name: "kif i czeryf" }, { name: "webhook retry" }]);
  deepEq(Object.keys(qs), ["q0", "q1"], "fan-out keys");
  deepEq(qs.q0, {
    type: "noul",
    instructions: `Is this dictated fragment a concrete, buildable expectation? Fragment: "kif i czeryf". Answer true only if a developer could open a task from it without asking the user what the words mean.`,
    criteria: { true: "concrete expected feature or change", false: "greeting, context, meta-talk, or unactionable fragment" },
  }, "q0");
  deepEq(qs.q1, {
    type: "noul",
    instructions: `Is this dictated fragment a concrete, buildable expectation? Fragment: "webhook retry". Answer true only if a developer could open a task from it without asking the user what the words mean.`,
    criteria: { true: "concrete expected feature or change", false: "greeting, context, meta-talk, or unactionable fragment" },
  }, "q1");
});

await test("prompt-refinement instantiation reproduces the pre-migration step questions byte-identically", () => {
  const qs0 = instantiateEntryQuestions("prompt-refinement", []);
  deepEq(Object.keys(qs0), ["size"], "zero features → size only");
  deepEq(qs0.size, {
    type: "choice",
    instructions: "Classify the overall task size for frontman engagement (ADR-0009 amendment).",
    criteria: {
      small: "small and easy — the Supervisor does the work itself, no squads",
      medium: "medium or complicated — DEV + TEST squads",
      large: "large and very complex — full triage PLAN → DEV → REVIEW → TEST",
    },
  }, "size");
  const qs2 = instantiateEntryQuestions("prompt-refinement", [{ name: "kif (feature extraction)" }, { name: "webhook retry" }]);
  deepEq(Object.keys(qs2), ["size", "rel0", "rel1"], "fan-out keys");
  deepEq(qs2.rel0, {
    type: "choice",
    instructions: `How does the feature "kif (feature extraction)" relate to the other features in this task?`,
    criteria: {
      standalone: "independent of the other features",
      extension: "extends or refines another feature listed here",
      alternative: "an alternative to another feature (either/or)",
    },
  }, "rel0");
  deepEq(qs2.rel1.instructions, `How does the feature "webhook retry" relate to the other features in this task?`, "rel1 instructions");
});

await test("instantiation misuse fails closed (node entry, non-array, unresolved placeholder)", () => {
  throwsCode(() => instantiateEntryQuestions("plan.dor", []), "invalid_input", "no question templates");
  throwsCode(() => instantiateEntryQuestions("extraction", "nope"), "invalid_input", "instances must be an array");
  throwsCode(() => instantiateEntryQuestions("extraction", [{}]), "invalid_input", "unresolved placeholder {{name}}");
});

console.log("\ndecisions-registry: loader lookups");

await test("getRegistryEntry resolves known ids and fails closed otherwise", () => {
  eq(getRegistryEntry("plan.dor").id, "plan.dor", "known id resolves");
  eq(getRegistryEntry("gate.screen").id, "gate.screen", "transport id resolves");
  throwsCode(() => getRegistryEntry("nope"), "invalid_input", "unknown decision id");
  throwsCode(() => getRegistryEntry(42), "invalid_input", "non-empty string");
  throwsCode(() => getRegistryEntry(""), "invalid_input", "non-empty string");
});

await test("resolveEntryQuestions serves concrete entries and fails closed otherwise", () => {
  const resolved = resolveEntryQuestions("gate.screen");
  deepEq(Object.keys(resolved.questions), ["q0"], "questions served");
  eq(resolved.autonomy, "A0", "autonomy carried");
  eq(resolved.criteriaVersion, 1, "criteriaVersion carried");
  throwsCode(() => resolveEntryQuestions("plan.dor"), "invalid_input", "FOC-397");
  throwsCode(() => resolveEntryQuestions("extraction"), "invalid_input", "FOC-448");
  throwsCode(() => resolveEntryQuestions("prompt-refinement"), "invalid_input", "FOC-448");
  throwsCode(() => resolveEntryQuestions("nope"), "invalid_input", "unknown decision id");
});

console.log("\ndecisions-registry: corrupt-registry fixtures fail closed");

// Fixture seam: the loader takes {path}, so each negative case ships a
// purpose-broken registry file instead of mutating the real one.
const fixtureDir = mkdtempSync(join(tmpdir(), "decisions-registry-test-"));
let fixtureN = 0;
function fixture(mutate) {
  const base = {
    _doc: { note: "fixture" },
    entries: {
      "t.one": {
        id: "t.one", kind: "J", owner: "o", hookPoint: "h", autonomy: "A0", threshold: null,
        fallback: { tier2: "disabled", onModelFailure: "fail closed" },
        metrics: ["confidence"], criteriaVersion: 1,
        serving: [{ via: "seam", actsOnAnswers: false, a0Enforced: true }],
        questions: { q0: { type: "noul", instructions: "i", criteria: { true: "t", false: "f" } } },
      },
      "n.one": {
        id: "n.one", kind: "D", owner: "o", hookPoint: "h", autonomy: null, threshold: null,
        fallback: { tier2: "disabled", onModelFailure: "fail closed" },
        metrics: [], criteriaVersion: 1,
        reads: ["x"], output: { type: "object" }, tier: null, failure: "stop", writes: "run-record",
      },
    },
  };
  if (mutate) mutate(base);
  const reg = base;
  const path = join(fixtureDir, `reg-${++fixtureN}.json`);
  writeFileSync(path, JSON.stringify(reg, null, 2));
  return path;
}

await test("a minimal valid fixture registry loads clean", () => {
  const reg = loadRegistry({ path: fixture() });
  deepEq(Object.keys(reg.entries), ["t.one", "n.one"], "fixture entries");
});

await test("unparseable JSON → schema_invalid; unreadable file → provider_error", () => {
  const bad = join(fixtureDir, "broken.json");
  writeFileSync(bad, '{ "entries": ');
  throwsCode(() => loadRegistry({ path: bad }), "schema_invalid", "not valid JSON");
  throwsCode(() => loadRegistry({ path: join(fixtureDir, "nope.json") }), "provider_error", "not readable");
});

await test("schema-invalid shapes → schema_invalid (each negative case names its rule)", () => {
  throwsCode(() => loadRegistry({ path: fixture((r) => { r.extra = true; }) }), "schema_invalid", "failed its schema");
  throwsCode(() => loadRegistry({ path: fixture((r) => { r.entries["t.one"].id = "t.renamed"; }) }), "schema_invalid", "does not match its key");
  throwsCode(() => loadRegistry({ path: fixture((r) => { r.entries["t.one"].fallback.tier2 = "active"; }) }), "schema_invalid", "failed its schema");
  throwsCode(() => loadRegistry({ path: fixture((r) => { r.entries["t.one"].reads = ["x"]; }) }), "schema_invalid", "failed its schema");
  throwsCode(() => loadRegistry({ path: fixture((r) => { r.entries["n.one"].metrics = ["bogus"]; }) }), "schema_invalid", "failed its schema");
  throwsCode(() => loadRegistry({ path: fixture((r) => { r.entries["n.one"].prompt = "p"; }) }), "schema_invalid", "failed its schema");
  throwsCode(() => loadRegistry({
    path: fixture((r) => { Object.assign(r.entries["n.one"], { kind: "G", tier: "cheap" }); }),
  }), "schema_invalid", "failed its schema");
  throwsCode(() => loadRegistry({ path: fixture((r) => { r.entries["t.one"].questions.q0.type = "maybe"; }) }), "schema_invalid", "not a typed question");
});

await test("a fixed-key question carrying a placeholder fails closed at instantiation", () => {
  const path = fixture((r) => {
    r.entries["t.one"].questions = { q0: { type: "noul", instructions: "Hello {{name}}", criteria: { true: "t", false: "f" } } };
  });
  const reg = loadRegistry({ path }); // loads fine — the misuse is at instantiation
  eq(reg.entries["t.one"].questions.q0.instructions, "Hello {{name}}", "fixture loaded");
  throwsCode(() => instantiateEntryQuestions("t.one", [], { path }), "invalid_input", "placeholder");
});

await test("serving/autonomy cross-rules fail closed (review round 1)", () => {
  // (a) kind J ⇒ serving present
  throwsCode(() => loadRegistry({ path: fixture((r) => { delete r.entries["t.one"].serving; }) }), "schema_invalid", "failed its schema");
  // serving is a kind-J concern — a node config carries none
  throwsCode(() => loadRegistry({ path: fixture((r) => { r.entries["n.one"].serving = []; }) }), "schema_invalid", "failed its schema");
  // a path that acts on answers without A0 enforcement must name its gate
  throwsCode(() => loadRegistry({
    path: fixture((r) => { r.entries["t.one"].serving = [{ via: "step-server", actsOnAnswers: true, a0Enforced: false }]; }),
  }), "schema_invalid", "failed its schema");
  // the same shape WITH the gate is the declared-boundary posture — loads
  const gated = loadRegistry({
    path: fixture((r) => { r.entries["t.one"].serving = [{ via: "step-server (FOC-401)", actsOnAnswers: true, a0Enforced: false, gate: "FOC-397" }]; }),
  });
  eq(gated.entries["t.one"].serving[0].gate, "FOC-397", "gated boundary loads");
  // a0Enforced ⇒ via is the seam (the loader-enforced channel)
  throwsCode(() => loadRegistry({
    path: fixture((r) => { r.entries["t.one"].serving = [{ via: "step-server", actsOnAnswers: false, a0Enforced: true }]; }),
  }), "schema_invalid", "failed its schema");
  // autonomy encoding: kind J must carry a value; node configs must be null
  throwsCode(() => loadRegistry({ path: fixture((r) => { r.entries["t.one"].autonomy = null; }) }), "schema_invalid", "failed its schema");
  throwsCode(() => loadRegistry({ path: fixture((r) => { r.entries["n.one"].autonomy = "A0"; }) }), "schema_invalid", "failed its schema");
});

await test("serving/autonomy cross-rules fail closed (FOC-397 round 2)", () => {
  // kind J ⇒ serving present AND non-empty — a path that serves the entry in
  // code must appear here; an empty array claims to serve nothing.
  throwsCode(() => loadRegistry({ path: fixture((r) => { r.entries["t.one"].serving = []; }) }), "schema_invalid", "failed its schema");
  // via "seam" ⇒ a0Enforced — the seam name is reserved for the enforced
  // decisionId channel; a seam path without enforcement is mislabeled.
  throwsCode(() => loadRegistry({
    path: fixture((r) => { r.entries["t.one"].serving = [{ via: "seam", actsOnAnswers: false, a0Enforced: false }]; }),
  }), "schema_invalid", "failed its schema");
  // a0Enforced on any serving path ⇒ the entry's autonomy is "A0" —
  // enforcement belongs to the entry, not to whoever happens to call it.
  throwsCode(() => loadRegistry({
    path: fixture((r) => { r.entries["t.one"].autonomy = "A1"; }),
  }), "schema_invalid", "failed its schema");
  // a gate names its owning issue: "FOC-397x" is not an issue key.
  throwsCode(() => loadRegistry({
    path: fixture((r) => { r.entries["t.one"].serving = [{ via: "step-server (FOC-401)", actsOnAnswers: true, a0Enforced: false, gate: "FOC-397x" }]; }),
  }), "schema_invalid", "failed its schema");
});

// A serving RECORD is always an object (ajv strict-mode fix round): a
// string/array standing in for a record fails closed, not vacuously.
await test("a non-object serving record fails closed", () => {
  throwsCode(() => loadRegistry({
    path: fixture((r) => { r.entries["t.one"].serving = ["seam"]; }),
  }), "schema_invalid", "failed its schema");
  throwsCode(() => loadRegistry({
    path: fixture((r) => { r.entries["t.one"].serving = [["seam", { a0Enforced: true }]]; }),
  }), "schema_invalid", "failed its schema");
});

rmSync(fixtureDir, { recursive: true, force: true });

console.log(`\ndecisions-registry: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("\nfailed tests:");
  for (const name of failures) console.error("  - " + name);
  process.exit(1);
}
