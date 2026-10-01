// scripts/plan-intent.test.mjs — FOC-515: the plan.intent read surface and the
// task-type -> required-perspectives table (design doc §3.12).
//
// All offline. The table and the taxonomy are the committed config, loaded
// through the real loaders — no fixture drift — and the §3.12 rows are pinned
// here so a config edit cannot quietly re-draw them. The loaders are exercised
// on temp copies for their fail-closed refusals, never on the committed file.
//
// Run: node scripts/plan-intent.test.mjs

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import Ajv from "ajv";
import { getRegistryEntry } from "./decision-registry.mjs";
import {
  PERSPECTIVES,
  allocateMapVersion,
  checkCoverage,
  checkMap,
  checkPresence,
  checkQuoteFidelity,
  checkSchemaExternal,
  composeIntentInputs,
  foldGateAnswers,
  loadPerspectiveTable,
  loadTaskTypes,
  persistMap,
  requiredPerspectives,
  resolveReference,
  runPlanIntentNode,
  verifyIdMap,
} from "./plan-intent.mjs";
import { DECISION_STEP } from "./decision-call.mjs";
import { buildInputs, splitGroundTruth } from "./plan-intent-eval.mjs";

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

const __dir = dirname(fileURLToPath(import.meta.url));

// ── the committed config ────────────────────────────────────────────────────

const TABLE = loadPerspectiveTable();
const TASK_TYPES = loadTaskTypes();
const STATE_CAP = DECISION_STEP.inputSchema.properties.state.maxLength;

// The §3.12 rows, restated from the approved design so a config edit that
// re-draws one is a test failure and not a silent policy change. `base` is
// all + risk (Decision 2026-09-24: risk for EVERY task type, no question
// obligation).
const BASE = ["goal", "scope", "success", "terms", "risk"];
const SPEC_ROWS = {
  feature: [...BASE, "user", "constraints", "priority"],
  bug: [...BASE],
  spike: [...BASE, "constraints", "priority"],
  tech: [...BASE, "constraints"],
  docs: [...BASE],
  test: [...BASE],
  chore: [...BASE],
};

const ENTRY = "FEN-30 — Gantt snapshot lib. Squad nodes keep their v1 contract fields. "
  + "Export one PNG per view. Out of scope: the mobile layout.";
const GAPS = ["brak określenia formatu eksportu", "nie wiadomo, czy snapshot jest zapisywany"];

function sorted(list) {
  return [...list].sort();
}

// ── map fixtures ────────────────────────────────────────────────────────────
//
// One claim per perspective so a map can be built for any required set. The
// claims are Polish and first person ("Rozumiem, że …") as §3.12 words them.

const CLAIMS = {
  goal: "Rozumiem, że ma powstać biblioteka snapshotów Gantta.",
  user: "Rozumiem, że użytkownikiem jest Mateusz i jego zespół.",
  scope: "Rozumiem, że zmiana obejmuje eksport jednego PNG na widok.",
  success: "Rozumiem, że sukces to poprawny PNG dla każdego widoku.",
  constraints: "Rozumiem, że pola kontraktu v1 nie mogą się zmienić.",
  risk: "Rozumiem, że zmiana dotyka zapisu plików na dysk.",
  priority: "Rozumiem, że ważniejsze jest pełne formatowanie niż szybkość.",
  terms: "Rozumiem, że „snapshot” oznacza pojedynczy eksport widoku.",
};

const OPTIONS = [
  { text: "Ustalamy format z Mateuszem.", recommended: true, reason: "Bez formatu nie ma akceptacji." },
  { text: "Zostawiamy do wyboru przy implementacji.", recommended: false },
];

/**
 * Build a map over the given perspectives. `source` is one value or one per
 * item; `quotes`/`covers` are keyed by perspective. A `stated` item gets a
 * quote (the schema requires one) defaulting to an anchored phrase of ENTRY,
 * and an `unknown` item carries the two options the schema requires — so every
 * fixture here is schema-valid as well as check-shaped.
 */
function mapWith({ perspectives = PERSPECTIVES, source = "inferred", quotes = {}, covers = {}, mapVersion = 1 } = {}) {
  return {
    goal: "Rozumiem, że ma powstać biblioteka snapshotów Gantta.",
    why: "Rozumiem, że potrzebny jest eksport widoków do PNG.",
    mapVersion,
    interpretations: perspectives.map((p, i) => {
      const src = Array.isArray(source) ? source[i] : source;
      const item = {
        id: `IN-${i + 1}`,
        perspective: p,
        claim: CLAIMS[p],
        source: src,
        alternatives: [],
        covers: covers[p] ?? [],
      };
      if (src === "unknown") item.options = OPTIONS;
      if (quotes[p] !== undefined) item.quote = quotes[p];
      else if (src === "stated") item.quote = "Export one PNG per view";
      return item;
    }),
  };
}

/** A full 12-slot map — the schema's `maxItems` is the cap, so ids run IN-1..IN-12. */
function mapOf12(version = 1) {
  const map = mapWith({ mapVersion: version });
  for (let i = PERSPECTIVES.length + 1; i <= 12; i++) {
    map.interpretations.push({
      id: `IN-${i}`,
      perspective: "scope",
      claim: `Rozumiem, że punkt ${i} jest w zakresie zmiany.`,
      source: "inferred",
      alternatives: [],
      covers: [],
    });
  }
  return map;
}

async function main() {
  await test("the perspective catalogue is the eight named readings", () => {
    deepEq(TABLE.perspectives, PERSPECTIVES, "table perspectives");
    eq(PERSPECTIVES.length, 8, "catalogue size");
    deepEq(TABLE.sets, { all: ["goal", "scope", "success", "terms"], base: BASE }, "sets.all / sets.base");
  });

  await test("the table's keys are exactly the task-type taxonomy (labels.json type.labels)", () => {
    deepEq(TASK_TYPES, ["feature", "bug", "spike", "tech", "docs", "test", "chore"], "taxonomy");
    deepEq(sorted(Object.keys(TABLE.byType)), sorted(TASK_TYPES), "byType keys");
  });

  await test("every §3.12 task-type row is exactly the approved required set", () => {
    for (const [type, spec] of Object.entries(SPEC_ROWS)) {
      deepEq(sorted(TABLE.byType[type]), sorted(spec), `${type} row`);
    }
  });

  await test("risk is required for EVERY task type via the base set", () => {
    eq(TABLE.sets.base.includes("risk"), true, "base carries risk");
    for (const [type, row] of Object.entries(TABLE.byType)) {
      eq(row.includes("risk"), true, `${type} row carries risk`);
      for (const p of TABLE.sets.base) eq(row.includes(p), true, `${type} row carries base ${p}`);
    }
  });

  await test("the fail-closed set is the union of every type row — all eight", () => {
    deepEq(sorted(TABLE.unknown), sorted(PERSPECTIVES), "unknown set");
  });

  await test("requiredPerspectives serves a known type's own row", () => {
    const got = requiredPerspectives("feature", { table: TABLE });
    deepEq(sorted(got.perspectives), sorted(SPEC_ROWS.feature), "feature perspectives");
    eq(got.taskType, "feature", "resolved type");
    eq(got.failClosed, false, "not fail-closed");
  });

  await test("requiredPerspectives fails closed on an absent or explicit-unknown type", () => {
    for (const input of [undefined, null, "", "   ", "unknown"]) {
      const got = requiredPerspectives(input, { table: TABLE });
      deepEq(sorted(got.perspectives), sorted(PERSPECTIVES), `perspectives for ${JSON.stringify(input)}`);
      eq(got.taskType, "unknown", "resolved type");
      eq(got.failClosed, true, "fail-closed");
    }
  });

  await test("requiredPerspectives fails closed on a type outside the taxonomy", () => {
    for (const input of ["Feature", "refactor", "research", "nonsense", 42, {}]) {
      const got = requiredPerspectives(input, { table: TABLE });
      deepEq(sorted(got.perspectives), sorted(PERSPECTIVES), `perspectives for ${JSON.stringify(input)}`);
      eq(got.failClosed, true, "fail-closed");
    }
  });

  await test("a row that drops a base perspective is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "foc-515-persp-"));
    try {
      const raw = JSON.parse(readFileSync(join(__dir, "..", "config", "intent-perspectives.json"), "utf8"));
      raw.byType.feature = raw.byType.feature.filter((p) => p !== "risk");
      const path = join(dir, "dropped.json");
      writeFileSync(path, JSON.stringify(raw), "utf8");
      let thrown = null;
      try { loadPerspectiveTable({ path }); } catch (err) { thrown = err; }
      eq(Boolean(thrown), true, "refused");
      eq(thrown?.code, "invalid_input", "typed as invalid_input");
      eq(/"risk" is missing/.test(thrown?.message), true, `names the missing perspective: ${thrown?.message}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("rows that drift from the taxonomy are refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "foc-515-persp-"));
    try {
      const raw = JSON.parse(readFileSync(join(__dir, "..", "config", "intent-perspectives.json"), "utf8"));
      raw.byType.feature2 = raw.byType.feature;
      const path = join(dir, "drifted.json");
      writeFileSync(path, JSON.stringify(raw), "utf8");
      let thrown = null;
      try { loadPerspectiveTable({ path }); } catch (err) { thrown = err; }
      eq(Boolean(thrown), true, "refused");
      eq(/exactly the task-type taxonomy/.test(thrown?.message), true, `names the drift: ${thrown?.message}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("a perspective outside the catalogue is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "foc-515-persp-"));
    try {
      const raw = JSON.parse(readFileSync(join(__dir, "..", "config", "intent-perspectives.json"), "utf8"));
      raw.byType.docs = [...raw.byType.docs, "mood"];
      const path = join(dir, "unknown-perspective.json");
      writeFileSync(path, JSON.stringify(raw), "utf8");
      let thrown = null;
      try { loadPerspectiveTable({ path }); } catch (err) { thrown = err; }
      eq(Boolean(thrown), true, "refused");
      eq(/duplicate-free list of catalogue names/.test(thrown?.message), true, `names the problem: ${thrown?.message}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("round 1: no gate fields, the entry and the gaps only", () => {
    const got = composeIntentInputs({ "inbox.entry": ENTRY, "plan.dor.gaps": GAPS, "intake.taskType": "feature" });
    eq(got.round, 1, "round");
    eq(got.taskType, "feature", "task type");
    eq(got.failClosedType, false, "type resolved");
    deepEq(got.gaps, GAPS, "gaps");
    deepEq(Object.keys(got.payload), ["inbox.entry", "plan.dor.gaps", "intake.taskType"], "payload reads");
  });

  await test("round 1 with no task type takes the explicit unknown path, not a failure", () => {
    const got = composeIntentInputs({ "inbox.entry": ENTRY, "plan.dor.gaps": GAPS });
    eq(got.round, 1, "round");
    eq(got.taskType, "unknown", "task type");
    eq(got.failClosedType, true, "type unresolved");
    deepEq(sorted(got.required), sorted(PERSPECTIVES), "all eight perspectives required");
    deepEq(Object.keys(got.payload), ["inbox.entry", "plan.dor.gaps"], "payload reads");
  });

  await test("from round 2 the gate fields join and the round is derived from them", () => {
    const answers = [{ round: 2, mapVersion: 1, interpretationId: "IN-1", answer: "Tak, tylko walidator." }];
    const corrections = [{ round: 2, mapVersion: 1, interpretationId: "IN-2", answer: "Nie — cały plik." }];
    const got = composeIntentInputs({
      "inbox.entry": ENTRY,
      "plan.dor.gaps": GAPS,
      "intake.taskType": "tech",
      "gate.plan.gate1.answers": answers,
      "gate.plan.gate1.corrections": corrections,
    });
    eq(got.round, 2, "round");
    deepEq(Object.keys(got.payload), ["inbox.entry", "plan.dor.gaps", "intake.taskType", "gate.plan.gate1.answers", "gate.plan.gate1.corrections"], "payload reads");
  });

  await test("the round is the highest the fold reaches, floored at 2", () => {
    const answers = [
      { round: 2, mapVersion: 1, interpretationId: "IN-1", answer: "Tak." },
      { round: 3, mapVersion: 2, interpretationId: "IN-1", answer: "Zmieniam zdanie." },
    ];
    const got = composeIntentInputs({
      "inbox.entry": ENTRY,
      "plan.dor.gaps": GAPS,
      "intake.taskType": "bug",
      "gate.plan.gate1.answers": answers,
      "gate.plan.gate1.corrections": [],
    });
    eq(got.round, 3, "round = the highest round the folded records reference");
    const bare = composeIntentInputs({
      "inbox.entry": ENTRY,
      "plan.dor.gaps": GAPS,
      "gate.plan.gate1.answers": [{ answer: "Tak." }],
      "gate.plan.gate1.corrections": [],
    });
    eq(bare.round, 2, "floored at 2 whenever the gate fields are present");
  });

  await test("the anchor set is the entry plus the user's own words — never the about snapshot", () => {
    const answers = [{
      round: 2,
      mapVersion: 1,
      interpretationId: "IN-1",
      about: { claim: "Rozumiem, że zmiana dotyczy wyłącznie walidatora.", option: "Zostawiamy v1." },
      answer: "Nie, cały plik przechodzi przegląd.",
      acceptedOptions: ["Zostawiamy v1."],
    }];
    const got = composeIntentInputs({
      "inbox.entry": ENTRY,
      "plan.dor.gaps": GAPS,
      "intake.taskType": "tech",
      "gate.plan.gate1.answers": answers,
      "gate.plan.gate1.corrections": [],
    });
    eq(got.anchors.some((a) => a.includes("cały plik przechodzi przegląd")), true, "the answer text is anchor text");
    eq(got.anchors.some((a) => a.includes("Zostawiamy v1.")), true, "an explicitly accepted option is anchor text");
    eq(got.anchors.some((a) => a.includes("Rozumiem, że zmiana dotyczy wyłącznie walidatora.")), false, "the about claim is never anchor text");
    eq(got.anchors.some((a) => a === ENTRY), true, "the entry itself is anchor text");
  });

  await test("a payload over the seam's state cap fails closed before any provider call", () => {
    const huge = "x".repeat(STATE_CAP + 1);
    let thrown = null;
    try { composeIntentInputs({ "inbox.entry": huge, "plan.dor.gaps": GAPS }); } catch (err) { thrown = err; }
    eq(Boolean(thrown), true, "refused");
    eq(thrown?.code, "invalid_input", "typed as invalid_input");
    eq(/state cap/.test(thrown?.message), true, `names the cap: ${thrown?.message}`);
  });

  await test("a missing or malformed read is a typed failure, never a guess", () => {
    const cases = [
      [{ "plan.dor.gaps": GAPS }, /"inbox.entry" read is missing/],
      [{ "inbox.entry": ENTRY }, /"plan.dor.gaps" read must be the DoR gap list/],
      [{ "inbox.entry": ENTRY, "plan.dor.gaps": [...GAPS, "a", "b", "c", "d", "e", "f", "g"] }, /at most 8 non-empty strings/],
      [{ "inbox.entry": ENTRY, "plan.dor.gaps": [1, 2] }, /at most 8 non-empty strings/],
      [{ "inbox.entry": { dorFacts: null }, "plan.dor.gaps": [] }, /carries no text/],
      [{ "inbox.entry": "", "plan.dor.gaps": [] }, /carries no text/],
    ];
    for (const [reads, pattern] of cases) {
      let thrown = null;
      try { composeIntentInputs(reads); } catch (err) { thrown = err; }
      eq(Boolean(thrown), true, `refused for ${JSON.stringify(reads).slice(0, 60)}`);
      eq(thrown?.code, "invalid_input", "typed as invalid_input");
      eq(pattern.test(thrown?.message), true, `message ${pattern}: ${thrown?.message}`);
    }
  });

  await test("a composed payload object is accepted and carries its text into the anchors", () => {
    const got = composeIntentInputs({
      "inbox.entry": { issueId: "FEN-30", title: "Gantt snapshot lib", scopeSummary: ENTRY, dorFacts: null },
      "plan.dor.gaps": GAPS,
    });
    eq(got.anchors.some((a) => a.includes("Gantt snapshot lib")), true, "title is anchor text");
    eq(got.anchors.some((a) => a === ENTRY), true, "scopeSummary is anchor text");
  });

  // ── the fixtures are the real contract ────────────────────────────────────

  await test("every fixture map satisfies the committed plan.intent output schema", () => {
    const validate = new Ajv({ allErrors: true }).compile(getRegistryEntry("plan.intent").output);
    const fixtures = {
      inferred: mapWith(),
      stated: mapWith({ source: "stated", quotes: { goal: "Gantt snapshot lib" } }),
      unknown: mapWith({ source: "unknown" }),
      partial: mapWith({ perspectives: BASE }),
    };
    for (const [name, map] of Object.entries(fixtures)) {
      eq(validate(map), true, `${name} is schema-valid: ${JSON.stringify(validate.errors)}`);
    }
  });

  await test("the schema already refuses what the four rules add — except the ones it cannot express", () => {
    const validate = new Ajv({ allErrors: true }).compile(getRegistryEntry("plan.intent").output);
    const map = mapWith({ perspectives: ["goal"], source: "unknown" });
    map.interpretations[0].options = [
      { text: "A", recommended: true, reason: "bo A" },
      { text: "B", recommended: true, reason: "bo B" },
    ];
    eq(validate(map), true, "two recommended is schema-VALID — the schema cannot express exactly-one");
    map.interpretations[0].claim = "   ";
    eq(validate(map), true, "a whitespace claim is schema-VALID — minLength passes it");
    eq(checkSchemaExternal(map).ok, false, "and the code check refuses both");
  });

  // ── the four rules the schema cannot express ───────────────────────────────

  await test("a clean map passes the schema-external rules", () => {
    const got = checkSchemaExternal(mapWith({ source: "unknown" }));
    eq(got.ok, true, `ok: ${got.errors.join(" | ")}`);
    eq(got.errors.length, 0, "no errors");
  });

  await test("options carry EXACTLY ONE recommended: true", () => {
    const map = mapWith({ perspectives: ["goal"], source: "unknown" });
    map.interpretations[0].options = [
      { text: "A", recommended: true, reason: "bo A" },
      { text: "B", recommended: true, reason: "bo B" },
    ];
    let got = checkSchemaExternal(map);
    eq(got.ok, false, "two recommended refused");
    eq(/EXACTLY ONE "recommended": true/.test(got.errors[0]), true, `names the rule: ${got.errors[0]}`);
    map.interpretations[0].options = [{ text: "A", recommended: false }, { text: "B", recommended: false }];
    got = checkSchemaExternal(map);
    eq(got.ok, false, "zero recommended refused");
    eq(/found 0/.test(got.errors[0]), true, `names the count: ${got.errors[0]}`);
  });

  await test("reason is present iff recommended", () => {
    const map = mapWith({ perspectives: ["goal"], source: "unknown" });
    map.interpretations[0].options = [
      { text: "A", recommended: true },
      { text: "B", recommended: false, reason: "niepotrzebne" },
    ];
    const got = checkSchemaExternal(map);
    eq(got.ok, false, "refused");
    eq(got.errors.length, 2, `both halves of the rule: ${got.errors.join(" | ")}`);
    eq(got.errors.some((e) => /must carry a "reason"/.test(e)), true, "recommended without reason named");
    eq(got.errors.some((e) => /must not carry a "reason"/.test(e)), true, "unrecommended with reason named");
  });

  await test("every id appears EXACTLY ONCE — a duplicate would corrupt the round-2 fold", () => {
    const map = mapWith({ perspectives: ["goal", "scope"] });
    map.interpretations[1].id = "IN-1";
    const got = checkSchemaExternal(map);
    eq(got.ok, false, "refused");
    eq(/appears more than once/.test(got.errors[0]), true, `names the rule: ${got.errors[0]}`);
  });

  await test("no blank strings anywhere — minLength passes whitespace, this check trims", () => {
    const map = mapWith({ perspectives: ["goal", "scope"] });
    map.interpretations[1].claim = "   ";
    const got = checkSchemaExternal(map);
    eq(got.ok, false, "refused");
    eq(/blank string at .*interpretations\[1\]\.claim/.test(got.errors[0]), true, `names the path: ${got.errors[0]}`);
  });

  // ── (a) coverage ──────────────────────────────────────────────────────────

  await test("check (a): round 1 counts only unknown/inferred — a stated item's covers is ignored", () => {
    const inferredOnly = mapWith({ covers: { goal: [GAPS[0]], scope: [GAPS[1]] } });
    const round1 = checkCoverage({ interpretations: inferredOnly.interpretations, gaps: GAPS, round: 1, anchors: [ENTRY] });
    eq(round1.ok, true, `inferred items cover both gaps: ${round1.errors.join(" | ")}`);
    const statedCoversOne = mapWith({
      source: ["stated", "inferred", "inferred", "inferred", "inferred", "inferred", "inferred", "inferred"],
      quotes: { goal: "Gantt snapshot lib" },
      covers: { goal: [GAPS[0]], scope: [GAPS[1]] },
    });
    const refused = checkCoverage({ interpretations: statedCoversOne.interpretations, gaps: GAPS, round: 1, anchors: [ENTRY] });
    eq(refused.ok, false, "round 1 ignores the stated item's covers");
    eq(refused.errors.length, 1, `only the gap the stated item claimed surfaces: ${refused.errors.join(" | ")}`);
    eq(refused.errors.some((e) => e.includes(GAPS[0])), true, "the gap the stated item covers is uncovered");
    const onlyStated = mapWith({
      source: "stated",
      quotes: { goal: "Gantt snapshot lib", scope: "Export one PNG per view" },
      covers: { goal: [GAPS[0]], scope: [GAPS[1]] },
    });
    const allRefused = checkCoverage({ interpretations: onlyStated.interpretations, gaps: GAPS, round: 1, anchors: [ENTRY] });
    eq(allRefused.ok, false, "round 1 refuses a map whose gaps are covered by stated items only");
    eq(allRefused.errors.length, 2, `both gaps surface: ${allRefused.errors.join(" | ")}`);
  });

  await test("check (a): from round 2 a gate-anchored stated item counts", () => {
    const map = mapWith({
      source: ["stated", "stated", "inferred", "inferred", "inferred", "inferred", "inferred", "inferred"],
      quotes: { goal: "Gantt snapshot lib", scope: "Export one PNG per view" },
      covers: { goal: [GAPS[0]], scope: [GAPS[1]] },
    });
    const round1 = checkCoverage({ interpretations: map.interpretations, gaps: GAPS, round: 1, anchors: [ENTRY] });
    eq(round1.ok, false, "round 1 refuses it");
    const round2 = checkCoverage({ interpretations: map.interpretations, gaps: GAPS, round: 2, anchors: [ENTRY] });
    eq(round2.ok, true, `round 2 counts the anchored stated items: ${round2.errors.join(" | ")}`);
  });

  await test("check (a): a round-2 stated item whose quote is not anchored does not count", () => {
    const map = mapWith({
      source: ["stated", "inferred", "inferred", "inferred", "inferred", "inferred", "inferred", "inferred"],
      quotes: { goal: "tego w opisie nie ma" },
      covers: { goal: [GAPS[0]], scope: [GAPS[1]] },
    });
    const got = checkCoverage({ interpretations: map.interpretations, gaps: GAPS, round: 2, anchors: [ENTRY] });
    eq(got.ok, false, "refused");
    eq(got.errors.some((e) => e.includes(GAPS[0])), true, `the gap surfaces as uncovered: ${got.errors.join(" | ")}`);
  });

  await test("check (a): an unknown item counts in round 1", () => {
    const map = mapWith({
      source: ["unknown", "inferred", "inferred", "inferred", "inferred", "inferred", "inferred", "inferred"],
      covers: { goal: [GAPS[0]], scope: [GAPS[1]] },
    });
    const got = checkCoverage({ interpretations: map.interpretations, gaps: GAPS, round: 1, anchors: [ENTRY] });
    eq(got.ok, true, `counts: ${got.errors.join(" | ")}`);
  });

  await test("check (a) sub-check: a covers entry must equal a plan.dor.gaps entry verbatim", () => {
    const map = mapWith({ covers: { goal: ["brak określenia formatu eksportu."], scope: [GAPS[1]] } });
    const got = checkCoverage({ interpretations: map.interpretations, gaps: GAPS, round: 1, anchors: [ENTRY] });
    eq(got.ok, false, "refused");
    eq(/no such entry in plan.dor.gaps/.test(got.errors[0]), true, `names the rule: ${got.errors[0]}`);
    eq(got.errors.some((e) => e.includes(GAPS[0])), true, "the gap also surfaces as uncovered");
  });

  // ── (b) presence ──────────────────────────────────────────────────────────

  await test("check (b): every required perspective appears in at least one interpretation", () => {
    const got = checkPresence({ interpretations: mapWith().interpretations, required: PERSPECTIVES });
    eq(got.ok, true, `ok: ${got.errors.join(" | ")}`);
    const missing = mapWith({ perspectives: PERSPECTIVES.filter((p) => p !== "risk") });
    const refused = checkPresence({ interpretations: missing.interpretations, required: PERSPECTIVES });
    eq(refused.ok, false, "refused");
    eq(refused.errors.length, 1, `one missing perspective: ${refused.errors.join(" | ")}`);
    eq(/"risk" appears in no interpretation/.test(refused.errors[0]), true, "names the perspective");
  });

  await test("check (b): a feature task requires all eight; a base-only map is refused", () => {
    const { perspectives: required, failClosed } = requiredPerspectives("feature", { table: TABLE });
    eq(failClosed, false, "feature resolves");
    eq(required.length, 8, "all eight");
    const baseOnly = mapWith({ perspectives: BASE });
    const got = checkPresence({ interpretations: baseOnly.interpretations, required });
    eq(got.ok, false, "refused");
    eq(got.errors.length, 3, `user, constraints, priority missing: ${got.errors.join(" | ")}`);
  });

  await test("check (b): a chore task is satisfied by the base set", () => {
    const { perspectives: required } = requiredPerspectives("chore", { table: TABLE });
    eq(required.length, BASE.length, "the base set is all a chore needs");
    const got = checkPresence({ interpretations: mapWith({ perspectives: BASE }).interpretations, required });
    eq(got.ok, true, `ok: ${got.errors.join(" | ")}`);
    const dropped = mapWith({ perspectives: BASE.filter((p) => p !== "terms") });
    eq(checkPresence({ interpretations: dropped.interpretations, required }).ok, false, "a base perspective dropped is refused");
  });

  // ── (c) quote fidelity ────────────────────────────────────────────────────

  await test("check (c): every quote occurs verbatim in the round's anchor text", () => {
    const map = mapWith({ source: "inferred", quotes: { goal: "Gantt snapshot lib", scope: "Export one PNG per view" } });
    const got = checkQuoteFidelity({ interpretations: map.interpretations, anchors: [ENTRY] });
    eq(got.ok, true, `ok: ${got.errors.join(" | ")}`);
  });

  await test("check (c): an inferred quote is verbatim too (Decision 2026-09-24 deviation)", () => {
    const map = mapWith({ source: "inferred", quotes: { goal: "snapshot jest zapisywany na dysk" } });
    const got = checkQuoteFidelity({ interpretations: map.interpretations, anchors: [ENTRY] });
    eq(got.ok, false, "an unanchored inferred quote is refused");
    eq(got.errors.length, 1, `one error: ${got.errors.join(" | ")}`);
  });

  await test("check (c): the anchor set grows from round 2 with the user's own words", () => {
    const map = mapWith({ source: "inferred", quotes: { goal: "cały plik przechodzi przegląd" } });
    eq(checkQuoteFidelity({ interpretations: map.interpretations, anchors: [ENTRY] }).ok, false, "round 1 refuses it");
    const composed = composeIntentInputs({
      "inbox.entry": ENTRY,
      "plan.dor.gaps": GAPS,
      "intake.taskType": "tech",
      "gate.plan.gate1.answers": [{ round: 2, mapVersion: 1, interpretationId: "IN-1", answer: "Nie, cały plik przechodzi przegląd." }],
      "gate.plan.gate1.corrections": [],
    });
    eq(composed.round, 2, "round 2");
    eq(checkQuoteFidelity({ interpretations: map.interpretations, anchors: composed.anchors }).ok, true, "round 2 anchors it");
  });

  await test("check (c): no quotes is trivially satisfied", () => {
    eq(checkQuoteFidelity({ interpretations: mapWith().interpretations, anchors: [] }).ok, true, "ok");
  });

  // ── the aggregate ─────────────────────────────────────────────────────────

  await test("checkMap aggregates every check and reports each one separately", () => {
    const composed = composeIntentInputs({ "inbox.entry": ENTRY, "plan.dor.gaps": GAPS, "intake.taskType": "feature" });
    const map = mapWith({
      covers: { goal: [GAPS[0]], scope: [GAPS[1]] },
      quotes: { risk: "Out of scope: the mobile layout" },
    });
    const got = checkMap({
      output: map,
      gaps: composed.gaps,
      round: composed.round,
      anchors: composed.anchors,
      required: composed.required,
    });
    eq(got.ok, true, `the committed entry and gaps admit a valid map: ${got.errors.join(" | ")}`);
    deepEq(sorted(Object.keys(got.checks)), ["coverage", "presence", "quoteFidelity", "schemaExternal"], "check names");
    eq(got.checks.coverage.ok, true, "coverage");
    eq(got.checks.presence.ok, true, "presence");
    eq(got.checks.quoteFidelity.ok, true, "quoteFidelity");
    eq(got.checks.schemaExternal.ok, true, "schemaExternal");
  });

  await test("checkMap never returns a partial pass — one broken rule fails the whole map", () => {
    const composed = composeIntentInputs({ "inbox.entry": ENTRY, "plan.dor.gaps": GAPS, "intake.taskType": "feature" });
    const map = mapWith({ covers: { goal: [GAPS[0]] }, quotes: { risk: "tego nie ma" } });
    const got = checkMap({
      output: map,
      gaps: composed.gaps,
      round: composed.round,
      anchors: composed.anchors,
      required: composed.required,
    });
    eq(got.ok, false, "refused");
    eq(got.checks.quoteFidelity.ok, false, "quoteFidelity failed");
    eq(got.errors.some((e) => e.includes(GAPS[1])), true, "coverage failure surfaces too");
  });

  // ── the answer contract (fold) ────────────────────────────────────────────

  await test("persistMap allocates identity: monotonic, never reused, mismatched versions refused", () => {
    eq(allocateMapVersion({}), 1, "an empty store starts at 1");
    const first = persistMap({}, mapOf12(1));
    eq(first.mapVersion, 1, "first version");
    eq(allocateMapVersion(first.maps), 2, "the next allocation");
    let thrown = null;
    try { persistMap(first.maps, mapWith({ mapVersion: 1 })); } catch (err) { thrown = err; }
    eq(thrown?.code, "invalid_input", "a reused version is refused");
    eq(/already persisted and immutable/.test(thrown?.message), true, `names the rule: ${thrown?.message}`);
    thrown = null;
    try { persistMap(first.maps, mapWith({ mapVersion: 5 })); } catch (err) { thrown = err; }
    eq(thrown?.code, "invalid_input", "a non-allocated version is refused");
    eq(/is not the next persisted version \(2\)/.test(thrown?.message), true, `names the allocation: ${thrown?.message}`);
  });

  await test("a persisted version is immutable — the maps store is append-only", () => {
    const { maps } = persistMap({}, mapOf12(1));
    const mutated = { ...maps, 1: mapWith({ mapVersion: 1 }) };
    eq(mutated[1].interpretations.length, 8, "an in-memory overwrite is possible");
    eq(maps[1].interpretations.length, 12, "but the persisted store never sees it");
  });

  // ── required test 1: a full 12-slot map and a correction ──────────────────

  await test("answer contract 1: a full 12-slot map and a correction — the next round proceeds, the cap binds the ACTIVE map", () => {
    const v1 = mapOf12(1);
    eq(v1.interpretations.length, 12, "round 1 uses every slot");
    const validate = new Ajv({ allErrors: true }).compile(getRegistryEntry("plan.intent").output);
    eq(validate(v1), true, `12 items is schema-valid: ${JSON.stringify(validate.errors)}`);
    const thirteen = mapOf12(1);
    thirteen.interpretations.push({ id: "IN-1", perspective: "goal", claim: "Rozumiem, że to jest punkt trzynasty.", source: "inferred", alternatives: [], covers: [] });
    eq(validate(thirteen), false, "13 items is schema-invalid — the cap is 12 per map version");

    const { maps } = persistMap({}, v1);
    const presented = { 1: { round: 1, mapVersion: 1, items: v1.interpretations.map((i) => ({ interpretationId: i.id, claim: i.claim })) } };
    const corrections = [{
      round: 1,
      mapVersion: 1,
      interpretationId: "IN-7",
      about: { claim: v1.interpretations[6].claim },
      answer: "Niezupełnie.",
      corrected: "Rozumiem, że punkt 7 obejmuje też widok listy.",
    }];
    const fold = foldGateAnswers({ round: 2, maps, presented, answers: [], corrections });
    eq(fold.stale.length, 0, `nothing stale: ${JSON.stringify(fold.stale)}`);
    eq(fold.valid.length, 1, "the correction is applied");
    eq(fold.valid[0].kind, "correction", "typed as a correction");
    eq(fold.anchors.some((a) => a.includes("Rozumiem, że punkt 7 obejmuje też widok listy.")), true, "the corrected content is anchor text");

    // The next round writes a NEW map. The 12 cap binds the ACTIVE map, and
    // identity is the pair (mapVersion, interpretationId) — IN-1 may recur.
    const v2 = mapWith({ mapVersion: 2 });
    const next = persistMap(maps, v2);
    eq(next.mapVersion, 2, "the next round gets a fresh version");
    eq(v2.interpretations.some((i) => i.id === "IN-1"), true, "IN-1 recurs in the new map");
    eq(resolveReference({ maps: next.maps, mapVersion: 1, interpretationId: "IN-1" }).item.claim, v1.interpretations[0].claim, "and (1, IN-1) still resolves to the FIRST map's item");
    eq(resolveReference({ maps: next.maps, mapVersion: 2, interpretationId: "IN-1" }).item.claim, v2.interpretations[0].claim, "while (2, IN-1) resolves to the second");
    eq(resolveReference({ maps: next.maps, mapVersion: 1, interpretationId: "IN-12" }).ok, true, "the superseded map keeps its history");
    eq(resolveReference({ maps: next.maps, mapVersion: 2, interpretationId: "IN-12" }).ok, false, "and the new map carries only its own 8");
  });

  // ── required test 2: an answer to a stale mapVersion ──────────────────────

  await test("answer contract 2: an answer to a stale mapVersion is STALE — detected, logged, never applied", () => {
    const { maps } = persistMap({}, mapOf12(1));
    const presented = { 1: { round: 1, mapVersion: 1, items: [{ interpretationId: "IN-1", claim: maps[1].interpretations[0].claim }] } };
    const good = {
      round: 1,
      mapVersion: 1,
      interpretationId: "IN-1",
      about: { claim: maps[1].interpretations[0].claim },
      answer: "Tak.",
    };
    const fold = foldGateAnswers({
      round: 2,
      maps,
      presented,
      answers: [good],
      corrections: [
        { ...good, mapVersion: 99, about: { claim: maps[1].interpretations[0].claim }, answer: "mapVersion 99 nigdy nie istniał" },
        { ...good, round: 5, answer: "z przyszłej rundy" },
        { ...good, round: 2, answer: "runda 2 nic nie zaprezentowała" },
        { ...good, interpretationId: "IN-12", answer: "IN-12 jest w mapie, ale about nie pasuje" },
        { ...good, interpretationId: "IN-9", about: { claim: "czegoś takiego w mapie nie ma" }, answer: "about nie pasuje" },
        { answer: "bez potrójnej referencji" },
      ],
    });
    eq(fold.valid.length, 1, `only the resolvable reference is applied: ${JSON.stringify(fold.stale.map((s) => s.reason))}`);
    eq(fold.valid[0].record, good, "and it is the good one");
    eq(fold.stale.length, 6, "every other reference is stale");
    const reasons = fold.stale.map((s) => s.reason).join(" | ");
    eq(/names mapVersion 99 but round 1 presented mapVersion 1/.test(reasons), true, "an unallocated mapVersion is stale (the FOC-517 presented-mapVersion cross-check fires first)");
    eq(/names round 5 but the current round is 2/.test(reasons), true, "a future round is stale");
    eq(/round 2 has no presented record/.test(reasons), true, "a round that presented nothing is stale");
    eq(/about.claim does not match/.test(reasons), true, "an about that does not match the persisted claim is stale");
    eq(/no complete \(round, mapVersion, interpretationId\)/.test(reasons), true, "an incomplete triple is stale");
    eq(fold.anchors.length, 1, "a stale record contributes no anchor text — its point must reappear as unknown/inferred");
    eq(fold.anchors.some((a) => a.includes("mapVersion 99 nigdy nie istniał")), false, "the stale answer is not anchor text");
  });

  // ── required test 3: a content change inherits no confirmation ────────────

  await test("answer contract 3: a content change inherits no confirmation — renumber never carries it", () => {
    const v1 = mapWith({ mapVersion: 1 });
    const confirmedClaim = v1.interpretations[2].claim;
    const v2 = mapWith({ mapVersion: 2 });
    v2.interpretations[2].claim = "Rozumiem, że zmiana obejmuje też widok listy."; // a DIFFERENT reading
    const presented = {
      1: { round: 1, mapVersion: 1, items: [{ interpretationId: "IN-3", claim: confirmedClaim }] },
      2: { round: 2, mapVersion: 2, items: [{ interpretationId: "IN-3", claim: v2.interpretations[2].claim }] },
    };
    const { maps } = persistMap(persistMap({}, v1).maps, v2);

    // The old confirmation, replayed against the changed claim.
    const inherited = {
      round: 2,
      mapVersion: 2,
      interpretationId: "IN-3",
      about: { claim: confirmedClaim },
      answer: "Tak, potwierdzam.",
    };
    const fold = foldGateAnswers({ round: 3, maps, presented, answers: [inherited], corrections: [] });
    eq(fold.valid.length, 0, "the old confirmation is NOT applied to the changed claim");
    eq(fold.stale.length, 1, "it is detected");
    eq(/about.claim does not match the persisted claim of 2\/IN-3/.test(fold.stale[0].reason), true, `logged as stale: ${fold.stale[0].reason}`);
    eq(fold.anchors.length, 0, "and it is not anchor text — the point reappears as unknown/inferred");

    // A fresh answer about the NEW content is a different reading and applies.
    const fresh = { ...inherited, about: { claim: v2.interpretations[2].claim } };
    const applied = foldGateAnswers({ round: 3, maps, presented, answers: [fresh], corrections: [] });
    eq(applied.valid.length, 1, "the fresh answer applies");
    eq(applied.stale.length, 0, "cleanly");

    // Renumbering between DIFFERENT content is CONTRACT-ILLEGAL.
    const illegal = {
      ...maps,
      2: { ...v2, idMap: { "IN-3": "IN-3" } },
    };
    const idMapCheck = verifyIdMap(illegal);
    eq(idMapCheck.ok, false, "an idMap onto changed content is refused");
    eq(/CONTRACT-ILLEGAL/.test(idMapCheck.errors[0]), true, `named as such: ${idMapCheck.errors[0]}`);
    const refused = foldGateAnswers({ round: 3, maps: illegal, presented, answers: [fresh], corrections: [] });
    eq(refused.valid.length, 0, "and no reference folds while the store carries it");
  });

  await test("an idMap between verbatim-identical content is legal and resolves the renumbered id", () => {
    const v1 = mapWith({ mapVersion: 1 });
    const claimA = v1.interpretations[2].claim;
    // v2 renumbers v1's IN-3 to IN-7: the SAME content under a new id, so the
    // translation is pure and the id IN-3 no longer appears in v2 at all.
    const v2 = mapWith({ mapVersion: 2, perspectives: ["goal", "user", "scope"] });
    v2.interpretations[2].id = "IN-7";
    v2.interpretations[2].claim = claimA;
    v2.idMap = { "IN-3": "IN-7" };
    const { maps } = persistMap(persistMap({}, v1).maps, v2);
    const idMapCheck = verifyIdMap(maps);
    eq(idMapCheck.ok, true, `a verbatim-identical renumber is legal: ${idMapCheck.errors.join(" | ")}`);
    const resolved = resolveReference({ maps, mapVersion: 2, interpretationId: "IN-3" });
    eq(resolved.ok, true, "the renamed-away id still resolves");
    eq(resolved.id, "IN-7", "through the map's own idMap");
    eq(resolved.renumberedFrom, "IN-3", "and the link is visible");
    eq(resolved.item.claim, claimA, "to the identical content");
  });

  await test("an idMap with no predecessor to renumber from is refused", () => {
    const v1 = mapWith({ mapVersion: 1 });
    v1.idMap = { "IN-1": "IN-2" };
    const got = verifyIdMap({ 1: v1 });
    eq(got.ok, false, "refused");
    eq(/no mapVersion 0 to renumber from/.test(got.errors[0]), true, `named: ${got.errors[0]}`);
  });

  // ── the node: one retry, then stop ────────────────────────────────────────

  const STEP = { kind: "G", reads: ["inbox.entry", "plan.dor.gaps", "intake.taskType", "gate.plan.gate1.answers", "gate.plan.gate1.corrections"] };
  const validate = new Ajv({ allErrors: true }).compile(getRegistryEntry("plan.intent").output);
  const RUN_READS = { "inbox.entry": ENTRY, "plan.dor.gaps": GAPS, "intake.taskType": "feature" };

  await test("the node returns a done map and persists it as the next version", async () => {
    const map = mapWith({ covers: { goal: [GAPS[0]], scope: [GAPS[1]] }, quotes: { risk: "Out of scope: the mobile layout" } });
    const seen = [];
    const result = await runPlanIntentNode({
      step: STEP,
      reads: RUN_READS,
      generator: async (args) => { seen.push(args); return map; },
      validate,
    });
    eq(result.status, "done", `done: ${JSON.stringify(result.error)}`);
    eq(result.mapVersion, 1, "the first persisted version");
    eq(result.maps[1], map, "and the store carries it");
    eq(result.attempts, 1, "one call, no retry");
    eq(seen.length, 1, "one generator call");
    deepEq(Object.keys(seen[0].reads).sort(), ["inbox.entry", "intake.taskType", "plan.dor.gaps"], "the declared reads, no revision on the first attempt");
  });

  await test("the node retries ONCE carrying the reasons and the rejected map, then stops", async () => {
    const bad = mapWith({ covers: { goal: [GAPS[0]] }, quotes: { risk: "tego w opisie nie ma" } });
    const seen = [];
    const result = await runPlanIntentNode({
      step: STEP,
      reads: RUN_READS,
      generator: async (args) => { seen.push(args); return bad; },
      validate,
    });
    eq(result.status, "failed", "refused");
    eq(result.error.code, "schema_invalid", "typed as schema_invalid");
    eq(seen.length, 2, "exactly ONE retry");
    eq(/rejected after one retry/.test(result.error.message), true, `names the retry: ${result.error.message}`);
    eq(result.problems.length, 2, `both problems surface: ${result.problems.join(" | ")}`);
    eq(result.problems.some((p) => p.includes(GAPS[1])), true, "the uncovered gap is named");
    eq(result.problems.some((p) => /occurs verbatim in no anchor text/.test(p)), true, "the unanchored quote is named");

    const revision = seen[1].reads.revision;
    eq(revision.attempt, 2, "the second attempt is marked");
    eq(revision.problems.length, 2, "carries the reasons");
    eq(revision.previous, bad, "and the rejected map itself");
    eq(seen[1].reads["inbox.entry"], ENTRY, "the entry stays VERBATIM — our feedback is never quote-able anchor text");
    deepEq(seen[1].reads["plan.dor.gaps"], GAPS, "the declared reads are unchanged on the retry");
  });

  await test("a schema-invalid map is refused before the checks run", async () => {
    const notAMap = { goal: "g", why: "w", mapVersion: 1 };
    const result = await runPlanIntentNode({
      step: STEP,
      reads: RUN_READS,
      generator: async () => notAMap,
      validate,
    });
    eq(result.status, "failed", "refused");
    eq(result.error.code, "schema_invalid", "typed");
    eq(result.problems.length, 1, `one problem: ${result.problems.join(" | ")}`);
    eq(result.checks, undefined, "the [D] checks never saw it");
  });

  await test("a mis-numbered mapVersion is a rejection — the store allocates identity", async () => {
    const map = mapWith({ covers: { goal: [GAPS[0]], scope: [GAPS[1]] }, quotes: { risk: "Out of scope: the mobile layout" }, mapVersion: 7 });
    const result = await runPlanIntentNode({
      step: STEP,
      reads: RUN_READS,
      generator: async () => map,
      validate,
    });
    eq(result.status, "failed", "refused");
    eq(result.problems.some((p) => /mapVersion 7 is not the next persisted version \(1\)/.test(p)), true, `named: ${result.problems.join(" | ")}`);
  });

  await test("the node fails closed on malformed reads with zero generator calls", async () => {
    let calls = 0;
    const result = await runPlanIntentNode({
      step: STEP,
      reads: { "inbox.entry": ENTRY, "plan.dor.gaps": ["x", "y", "z", "a", "b", "c", "d", "e", "f"] },
      generator: async () => { calls++; return mapWith(); },
      validate,
    });
    eq(result.status, "failed", "refused");
    eq(result.error.code, "invalid_input", "typed as invalid_input");
    eq(calls, 0, "zero provider calls");
  });

  await test("the node needs its wiring and says so rather than guessing", async () => {
    for (const broken of [{ generator: undefined, validate }, { generator: async () => mapWith(), validate: undefined }, { generator: async () => mapWith(), validate, step: undefined }]) {
      let thrown = null;
      try { await runPlanIntentNode({ step: STEP, reads: RUN_READS, ...broken }); } catch (err) { thrown = err; }
      eq(thrown?.code, "invalid_input", `typed: ${thrown?.message}`);
    }
  });

  await test("round 2: the fold drops a stale answer from the anchors, so its point cannot come back as stated", async () => {
    const v1 = mapWith({ mapVersion: 1 });
    const { maps } = persistMap({}, v1);
    const presented = { 1: { round: 1, mapVersion: 1, items: [{ interpretationId: "IN-1", claim: v1.interpretations[0].claim }] } };
    const staleAnswer = {
      round: 1,
      mapVersion: 42,
      interpretationId: "IN-1",
      about: { claim: v1.interpretations[0].claim },
      answer: "Tak, w całości po polsku.",
    };
    const reads = {
      ...RUN_READS,
      "gate.plan.gate1.answers": [staleAnswer],
      "gate.plan.gate1.corrections": [],
    };
    // The map quotes the stale answer — which is NOT anchor text once the fold
    // has dropped it, so the map must be rejected.
    const map = mapWith({ mapVersion: 2, covers: { goal: [GAPS[0]], scope: [GAPS[1]] }, quotes: { risk: "Tak, w całości po polsku." } });
    const result = await runPlanIntentNode({
      step: STEP,
      reads,
      generator: async () => map,
      validate,
      maps,
      presented,
    });
    eq(result.status, "failed", "refused");
    eq(result.problems.some((p) => /occurs verbatim in no anchor text/.test(p)), true, `the stale quote is not anchor text: ${result.problems.join(" | ")}`);
    eq(result.fold.stale.length, 1, "the stale answer is logged, not applied");
    eq(/names mapVersion 42 but round 1 presented mapVersion 1/.test(result.fold.stale[0].reason), true, `logged: ${result.fold.stale[0].reason}`);
  });

  await test("an illegal idMap in the store stops the node before any provider call", async () => {
    const v1 = mapWith({ mapVersion: 1 });
    const v2 = mapWith({ mapVersion: 2 });
    v2.interpretations[2].claim = "Rozumiem, że to jest inny odczyt niż w wersji pierwszej.";
    v2.idMap = { "IN-3": "IN-3" };
    let calls = 0;
    const result = await runPlanIntentNode({
      step: STEP,
      reads: { ...RUN_READS, "gate.plan.gate1.answers": [], "gate.plan.gate1.corrections": [] },
      generator: async () => { calls++; return mapWith({ mapVersion: 3 }); },
      validate,
      maps: { 1: v1, 2: v2 },
      presented: { 1: { round: 1, mapVersion: 1, items: [] }, 2: { round: 2, mapVersion: 2, items: [] } },
    });
    eq(result.status, "failed", "refused");
    eq(result.error.code, "invalid_input", "typed");
    eq(/illegal idMap/.test(result.error.message), true, `named: ${result.error.message}`);
    eq(calls, 0, "zero provider calls");
  });

  // ── the eval harness's input partition (scripts/plan-intent-eval.mjs) ─────
  //
  // Pinned here because the ground-truth strip is the one thing whose quiet
  // failure would invalidate every number in docs/benchmark/plan-intent-eval.md:
  // if an Acceptance-criteria or Definition-of-done line ever reaches the
  // model's inputs, the map is reading the answer key.

  await test("no ground-truth marker and no roadmap metadata reaches any eval scope summary", () => {
    const fx = JSON.parse(readFileSync(join(__dir, "plan-intent-eval-fixture.json"), "utf8"));
    eq(fx.issues.length, 12, "12 cases");
    for (const row of fx.issues) {
      const i = buildInputs(row);
      eq(/\*\*(?:Acceptance criteria|AC|Definition of done|DoD):\*\*/.test(i.scopeSummary), false, `${i.id}: an inline ground-truth marker leaked`);
      eq(/^## (?:Acceptance|Definition of)/m.test(i.scopeSummary), false, `${i.id}: a ground-truth heading leaked`);
      eq(/fenix-roadmap/.test(i.scopeSummary), false, `${i.id}: roadmap metadata leaked`);
    }
  });

  await test("the eval fixture copies the FOC-474 descriptions verbatim", () => {
    const dod = JSON.parse(readFileSync(join(__dir, "plan-dod-eval-fixture.json"), "utf8"));
    const fx = JSON.parse(readFileSync(join(__dir, "plan-intent-eval-fixture.json"), "utf8"));
    eq(fx.issues.length, dod.issues.length, "the same 12 cases");
    for (const row of fx.issues) {
      const src = dod.issues.find((i) => i.id === row.id);
      eq(src !== undefined, true, `${row.id}: present in the FOC-474 fixture`);
      eq(row.description, src.description, `${row.id}: description copied verbatim`);
      eq(row.title, src.title, `${row.id}: title copied verbatim`);
    }
  });

  await test("the eval gaps respect the DoR gap contract and never quote the answer key", () => {
    const fx = JSON.parse(readFileSync(join(__dir, "plan-intent-eval-fixture.json"), "utf8"));
    for (const row of fx.issues) {
      const i = buildInputs(row);
      eq(i.gaps.length <= 8, true, `${i.id}: at most 8 gaps`);
      eq(i.gaps.length > 0, true, `${i.id}: the gap list is what drives coverage — it is never empty`);
      for (const gap of i.gaps) {
        eq(gap.trim().length > 0, true, `${i.id}: a gap is non-empty`);
        eq(gap.length <= 200, true, `${i.id}: a gap is at most 200 chars`);
        // The gaps are authored from the Context/Scope text only, so a gap may
        // not quote the stripped answer key — that would leak it through
        // `covers` even with the sections cut from the entry.
        eq(i.groundTruth === null || !i.groundTruth.includes(gap), true, `${i.id}: a gap quotes the stripped ground truth`);
      }
    }
  });

  await test("FOC-406 has no ground truth and takes the fail-closed task-type path", () => {
    const fx = JSON.parse(readFileSync(join(__dir, "plan-intent-eval-fixture.json"), "utf8"));
    const i = buildInputs(fx.issues.find((r) => r.id === "FOC-406"));
    eq(i.hasGroundTruth, false, "no AC and no DoD section — coverage is UNKNOWN");
    eq(i.taskType, "unknown", "type never set — the explicit unknown path");
    eq(requiredPerspectives(i.taskType).failClosed, true, "all eight perspectives, fail closed");
  });

  await test("the split keeps the entry's own text and reports the key it cut out", () => {
    const { scopeText, groundTruth } = splitGroundTruth(
      "## Context\nbody text\n\n## Acceptance criteria\n* AC-1: one\n\n## Definition of done\n* done-1\n",
    );
    eq(/body text/.test(scopeText), true, "context kept");
    eq(/AC-1/.test(scopeText), false, "AC cut from the entry");
    eq(/AC-1/.test(groundTruth), true, "AC reported as the key");
    eq(/done-1/.test(groundTruth), true, "DoD reported as the key");
  });

  await test("buildInputs refuses a malformed fixture row rather than trusting it", () => {
    const ok = { id: "X-1", title: "t", description: "d", taskType: "tech", gaps: ["g"] };
    eq(buildInputs(ok).id, "X-1", "a well-formed row builds");
    for (const [label, bad] of [
      ["no id", { ...ok, id: "" }],
      ["no title", { ...ok, title: " " }],
      ["no description", { ...ok, description: undefined }],
      ["no taskType", { ...ok, taskType: "" }],
      ["gaps not a list", { ...ok, gaps: "g" }],
      ["a blank gap", { ...ok, gaps: [" "] }],
      ["an over-long gap", { ...ok, gaps: ["x".repeat(201)] }],
      ["more than 8 gaps", { ...ok, gaps: Array.from({ length: 9 }, (_, n) => `g${n}`) }],
    ]) {
      let threw = false;
      try { buildInputs(bad); } catch { threw = true; }
      eq(threw, true, `${label} is refused`);
    }
  });

  console.log(`plan-intent: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log("FAILED: " + failures.join(" | "));
    process.exitCode = 1;
  }
}

await main();
