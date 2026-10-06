// scripts/plan-intent-gate.test.mjs — FOC-517: the gate1 conversation surface.
//
// All offline, all pure: renderGate1Display (the ≤14-line Polish display and
// the presented[round] slice it implies) and parseGate1Answer (the structured
// pick/correction/"ok" parsing with the free-text fallback). The display is
// tested as TEXT — the frontman reads exactly these lines; the parser is
// tested as RECORDS — the fold consumes exactly these shapes.
//
// Run: node scripts/plan-intent-gate.test.mjs

import assert from "node:assert/strict";
import { GATE1_MAX_LINES, GATE1_MAX_ROUNDS, parseGate1Answer, renderGate1Display } from "./plan-intent-gate.mjs";

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

// ── a full selection: every block populated ──────────────────────────────────

const SELECTION = {
  mapVersion: 1,
  understood: [
    { id: "IN-1", claim: "Rozumiem, że celem jest czytelny graf." },
    { id: "IN-2", claim: "Rozumiem, że licznik działa offline." },
  ],
  confirmations: [{ id: "IN-3", claim: "Rozumiem, że zakres to tylko selekcja." }],
  assumptions: [{ id: "IN-4", claim: "Rozumiem, że ryzykiem jest utrata odpowiedzi." }],
  questions: [
    {
      id: "IN-5",
      claim: "Czy widok listy jest w zakresie?",
      options: [{ text: "Tak, w pierwszym wydaniu", recommended: true }, { text: "Nie, tylko graf", recommended: false }],
    },
  ],
};

const INTERPRETATIONS = [
  { id: "IN-1", claim: "Rozumiem, że celem jest czytelny graf.", quote: "czytelny graf" },
  { id: "IN-2", claim: "Rozumiem, że licznik działa offline.", quote: null },
];

// ── renderGate1Display ───────────────────────────────────────────────────────

console.log("\nplan-intent-gate: renderGate1Display — the ≤14-line display and the presented slice");

await test("the full selection renders header, three blocks in order, and the recommended marker", () => {
  const { display, presented, dropped } = renderGate1Display({ round: 1, selection: SELECTION, interpretations: INTERPRETATIONS });
  eq(dropped, 0, "nothing dropped");
  const lines = display.split("\n");
  eq(lines[0], "Czy dobrze rozumiem? (runda 1/3)", "the header names the round and the cap");
  eq(lines[1], "Rozumiem tak:", "block 1 header");
  eq(lines[2], "• Rozumiem, że celem jest czytelny graf. — „czytelny graf\"", "a grounded claim quotes the map verbatim");
  eq(lines[3], "• Rozumiem, że licznik działa offline.", "an ungrounded claim carries no quote");
  eq(lines[4], "Założyłem — popraw, jeśli źle:", "block 2 header");
  eq(lines[5], "a) Rozumiem, że zakres to tylko selekcja.", "confirmations letter first");
  eq(lines[6], "b) Rozumiem, że ryzykiem jest utrata odpowiedzi.", "assumptions follow");
  eq(lines[7], "Pytania:", "block 3 header");
  eq(lines[8], "1) Czy widok listy jest w zakresie?", "questions number in display order");
  eq(lines[9], "   a) Tak, w pierwszym wydaniu ◀ rekomendowane   b) Nie, tylko graf", "the options line marks the recommendation");
  eq(lines.length, 10, "10 lines — well under the budget");
  eq(lines.length <= GATE1_MAX_LINES, true, "the display never exceeds the budget");

  deepEq(presented, {
    mapVersion: 1,
    understood: SELECTION.understood,
    confirmations: SELECTION.confirmations,
    assumptions: SELECTION.assumptions,
    questions: SELECTION.questions,
  }, "the presented slice carries exactly what was shown (nothing dropped here)");
});

await test("the budget drops from the end of the lowest-priority block and counts the overflow marker", () => {
  // 2 questions (2 lines each + 1 header) + 2 block-2 items + 12 understood
  // would overflow: understood drops first, one per line over.
  const selection = {
    mapVersion: 2,
    understood: Array.from({ length: 12 }, (_, i) => ({ id: `IN-${i + 1}`, claim: `Rozumiem, że punkt ${i + 1} jest w zakresie.` })),
    confirmations: [],
    assumptions: [],
    questions: [{ id: "IN-12", claim: "Pytanie pierwsze?", options: [{ text: "A", recommended: true }, { text: "B", recommended: false }] }],
  };
  const { display, presented, dropped } = renderGate1Display({ round: 2, selection, interpretations: [] });
  const lines = display.split("\n");
  eq(lines.length, GATE1_MAX_LINES, "the display sits exactly at the budget");
  eq(lines[0], "Czy dobrze rozumiem? (runda 2/3)", "round 2 in the header");
  eq(lines[lines.length - 1], "… (+4 w rekordzie)", "the overflow marker counts the dropped lines");
  // 1 header + 1 block1 header + 8 understood + 1 block3 header + 2 question lines + 1 marker = 14
  eq(lines[1], "Rozumiem tak:", "block 1 renders before the questions (display order)");
  eq(lines[10], "Pytania:", "the question block survives the drop (highest priority)");
  eq(lines[2], "• Rozumiem, że punkt 1 jest w zakresie.", "the drop cuts from the END of the understood block");
  eq(presented.understood.length, 8, "the presented slice carries only the SHOWN items");
  eq(presented.understood[0].id, "IN-1", "the first shown item is the map's first");
  eq(presented.understood[7].id, "IN-8", "the last shown item is IN-8 — IN-9..IN-12 were dropped");
  eq(presented.mapVersion, 2, "the presented slice stamps the map's version");
  if (presented.understood.some((u) => u.id === "IN-9")) fail("a dropped item must not be presented — it was never shown");
  eq(dropped, 4, "4 items dropped");
});

await test("the drop order is understood → assumptions → confirmations → whole questions (never split from options)", () => {
  const selection = {
    mapVersion: 1,
    understood: [],
    confirmations: Array.from({ length: 4 }, (_, i) => ({ id: `IN-${i + 1}`, claim: `Potwierdzenie ${i + 1}.` })),
    assumptions: Array.from({ length: 12 }, (_, i) => ({ id: `IN-${i + 1}`, claim: `Założenie ${i + 1}.` })),
    questions: [
      { id: "IN-9", claim: "Pytanie pierwsze?", options: [{ text: "A", recommended: true }, { text: "B", recommended: false }] },
      { id: "IN-10", claim: "Pytanie drugie?", options: [{ text: "C", recommended: true }, { text: "D", recommended: false }] },
      { id: "IN-11", claim: "Pytanie trzecie?", options: [{ text: "E", recommended: true }, { text: "F", recommended: false }] },
      { id: "IN-12", claim: "Pytanie czwarte?", options: [{ text: "G", recommended: true }, { text: "H", recommended: false }] },
    ],
  };
  const { presented, dropped } = renderGate1Display({ round: 1, selection, interpretations: [] });
  // 1 header + questions (1 + 2·shown) + block2 (1 + shown) + 1 marker vs 14:
  // assumptions (12) drop first, then confirmations (4), only then questions —
  // and a question always leaves WITH its options line.
  eq(presented.assumptions.length, 0, "assumptions drop first");
  eq(presented.confirmations.length, 2, "confirmations drop next — before any question goes");
  eq(presented.questions.length, 4, "no question is dropped while anything else can be");
  eq(presented.questions.every((q) => q.options.length === 2), true, "a shown question never loses its options line");
  eq(dropped, 14, "12 assumptions + 2 confirmations");
  const total = 1 + (1 + presented.questions.length * 2) + (1 + presented.confirmations.length) + 1;
  eq(total, GATE1_MAX_LINES, "the shown blocks fill the budget exactly");
});

await test("malformed inputs fail typed — no display from nothing", () => {
  let thrown = null;
  try { renderGate1Display({ round: 1, selection: null }); } catch (err) { thrown = err; }
  if (!thrown || thrown.code !== "invalid_input") fail("a missing selection fails typed");
  thrown = null;
  try { renderGate1Display({ round: 0, selection: SELECTION }); } catch (err) { thrown = err; }
  if (!thrown || thrown.code !== "invalid_input") fail("a non-positive round fails typed");
});

await test("GATE1_MAX_ROUNDS is 3 — the conversation cap the schema and the runner both bind", () => {
  eq(GATE1_MAX_ROUNDS, 3, "three rounds, then intent_not_settled");
});

// ── parseGate1Answer ─────────────────────────────────────────────────────────

console.log("\nplan-intent-gate: parseGate1Answer — picks, corrections, the whole-'ok' accept, the free fallback");

const PRESENTED = {
  mapVersion: 3,
  understood: [{ id: "IN-1", claim: "Punkt pierwszy." }],
  confirmations: [{ id: "IN-2", claim: "Potwierdzenie." }, { id: "IN-3", claim: "Drugie potwierdzenie." }],
  assumptions: [{ id: "IN-4", claim: "Założenie." }],
  questions: [
    { id: "IN-5", claim: "Pytanie pierwsze?", options: [{ text: "Offline tak", recommended: true }, { text: "Offline nie", recommended: false }] },
    { id: "IN-6", claim: "Pytanie drugie?", options: [{ text: "Wydanie A", recommended: false }, { text: "Wydanie B", recommended: true }] },
  ],
};
const ROUND = 2;

await test("'ok' accepts every question on its recommended option — and stamps round/mapVersion", () => {
  const parsed = parseGate1Answer("ok", ROUND, PRESENTED);
  eq(parsed.kind, "structured", "structured");
  eq(parsed.corrections.length, 0, "no corrections");
  deepEq(parsed.answers, [
    { round: ROUND, mapVersion: 3, interpretationId: "IN-5", about: { claim: "Pytanie pierwsze?", option: "Offline tak" }, answer: "Offline tak", acceptedOptions: ["Offline tak"] },
    { round: ROUND, mapVersion: 3, interpretationId: "IN-6", about: { claim: "Pytanie drugie?", option: "Wydanie B" }, answer: "Wydanie B", acceptedOptions: ["Wydanie B"] },
  ], "one answer per presented question, the recommended option, the 0-based round stamped");
  const bare = parseGate1Answer("OK!", 1, PRESENTED);
  eq(bare.kind, "structured", "ok!/Ok. variants accept too");
});

await test("an 'ok' with no presented questions accepts nothing — corrections empty, answers empty", () => {
  const parsed = parseGate1Answer("ok", 1, { ...PRESENTED, questions: [] });
  deepEq(parsed, { kind: "structured", answers: [], corrections: [] }, "the whole-accept of a question-less map is an empty structured answer");
});

await test("picks bind question number + option letter; round and mapVersion stamp every record", () => {
  const parsed = parseGate1Answer("1b 2a", ROUND, PRESENTED);
  eq(parsed.kind, "structured", "structured");
  eq(parsed.corrections.length, 0, "no corrections");
  eq(parsed.answers.length, 2, "one answer per pick");
  deepEq(parsed.answers[0], {
    round: ROUND, mapVersion: 3, interpretationId: "IN-5",
    about: { claim: "Pytanie pierwsze?", option: "Offline nie" },
    answer: "Offline nie", acceptedOptions: ["Offline nie"],
  }, "1b → the first question's option b");
  deepEq(parsed.answers[1], {
    round: ROUND, mapVersion: 3, interpretationId: "IN-6",
    about: { claim: "Pytanie drugie?", option: "Wydanie A" },
    answer: "Wydanie A", acceptedOptions: ["Wydanie A"],
  }, "2a → the second question's option a (NOT the recommendation)");
});

await test("corrections bind block-2 letters and carry the corrected text", () => {
  const parsed = parseGate1Answer("a nie Rozumiem, że zakres obejmuje też widok listy.", ROUND, PRESENTED);
  eq(parsed.kind, "structured", "structured");
  eq(parsed.answers.length, 0, "no answers");
  deepEq(parsed.corrections, [{
    round: ROUND, mapVersion: 3, interpretationId: "IN-2",
    about: { claim: "Potwierdzenie." },
    corrected: "Rozumiem, że zakres obejmuje też widok listy.",
  }], "letter a → the first block-2 item (confirmations before assumptions)");
  const second = parseGate1Answer("b nie inne założenie", ROUND, PRESENTED);
  eq(second.corrections[0].interpretationId, "IN-3", "letter b → the second confirmation");
  const assumption = parseGate1Answer("c nie poprawione założenie", ROUND, PRESENTED);
  eq(assumption.corrections[0].interpretationId, "IN-4", "letter c → the assumption (after the confirmations)");
});

await test("a mixed answer carries both channels in one structured parse", () => {
  const parsed = parseGate1Answer("2b b nie poprawka", ROUND, PRESENTED);
  eq(parsed.kind, "structured", "structured");
  eq(parsed.answers.length, 1, "the pick");
  eq(parsed.corrections.length, 1, "the correction");
  eq(parsed.answers[0].interpretationId, "IN-6", "the pick's question");
  eq(parsed.corrections[0].interpretationId, "IN-3", "the correction's item");
});

await test("anything unparseable is FREE — never a half-folded answer", () => {
  const cases = [
    ["chyba wszystko ok, ale punkt 7?", "leading prose"],
    ["1b, ale czemu nie C", "trailing prose after a pick"],
    ["1a 1b", "a duplicate pick"],
    ["9a", "an out-of-range question number"],
    ["1e", "an out-of-range option letter"],
    ["a nie", "an empty correction body"],
    ["z niepoprawną literą", "a block-2 letter beyond the presented items"],
    ["", "an empty answer"],
  ];
  for (const [raw, why] of cases) {
    const parsed = parseGate1Answer(raw, ROUND, PRESENTED);
    eq(parsed.kind, "free", `${why} → free (${JSON.stringify(raw)})`);
  }
});

await test("the parser needs the presented slice — and stamps ITS mapVersion, not an assumed one", () => {
  let thrown = null;
  try { parseGate1Answer("ok", 1, null); } catch (err) { thrown = err; }
  if (!thrown || thrown.code !== "invalid_input") fail("a missing presented slice fails typed");
  const other = parseGate1Answer("1a", 1, { ...PRESENTED, mapVersion: 7 });
  eq(other.answers[0].mapVersion, 7, "the stamp follows the presented slice");
});

console.log(`\nplan-intent-gate: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log("  FAILED: " + f);
  process.exit(1);
}
