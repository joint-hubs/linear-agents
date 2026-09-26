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
  checkCoverage,
  checkMap,
  checkPresence,
  checkQuoteFidelity,
  checkSchemaExternal,
  composeIntentInputs,
  loadPerspectiveTable,
  loadTaskTypes,
  requiredPerspectives,
} from "./plan-intent.mjs";
import { DECISION_STEP } from "./decision-call.mjs";

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

  console.log(`plan-intent: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log("FAILED: " + failures.join(" | "));
    process.exitCode = 1;
  }
}

await main();
