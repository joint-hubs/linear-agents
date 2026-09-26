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
import {
  PERSPECTIVES,
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

  console.log(`plan-intent: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log("FAILED: " + failures.join(" | "));
    process.exitCode = 1;
  }
}

await main();
