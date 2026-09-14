// Tests for scripts/codegraph-benchmark.mjs — run with: node scripts/codegraph-benchmark.test.mjs
//
// Covers the pure core only (grading, direct-arm merge, table rendering); the
// spawning runner is exercised for real by the benchmark run itself. All data
// here is synthetic — no repository symbol appears in this file, so the tests
// can never pollute the frozen question set's ground truth.

import { gradeAnswer, gradeRow, mergeDirect, renderTable } from "./codegraph-benchmark.mjs";

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.log(`  FAIL: ${label}`);
    failed++;
  }
}

function assertEq(actual, expected, label) {
  if (actual === expected) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.log(`  FAIL: ${label}`);
    console.log(`    expected: ${JSON.stringify(expected)}`);
    console.log(`    actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

// Array-aware sibling of assertEq — `===` compares arrays by reference.
function assertJsonEq(actual, expected, label) {
  assertEq(JSON.stringify(actual), JSON.stringify(expected), label);
}

const machineQuestion = {
  id: "synthetic-q1",
  class: "caller-chain",
  verb: "callers",
  groundTruthKind: "machine",
  expectedContains: ["src/alpha.mjs", "betaFn"],
};
const judgementQuestion = {
  id: "synthetic-q2",
  class: "judgement",
  verb: "callers",
  groundTruthKind: "judgement",
  expectedContains: [],
};

console.log("codegraph-benchmark core tests\n");

// ---- grading ----
{
  const good = "Callers of betaFn:\n  src/alpha.mjs:3";
  assertEq(good ? gradeAnswer(good, machineQuestion).verdict : "", "pass", "all hits present → pass");
  assertEq(gradeAnswer(good, machineQuestion).missing.length, 0, "pass carries no missing list");

  const winPaths = "betaFn mentioned in src\\alpha.mjs";
  assertEq(gradeAnswer(winPaths, machineQuestion).verdict, "pass", "backslash paths normalized before matching");

  const partial = "only src/alpha.mjs here";
  const graded = gradeAnswer(partial, machineQuestion);
  assertEq(graded.verdict, "fail", "missing needle → fail");
  assertJsonEq(graded.missing, ["betaFn"], "fail names the missing needles");

  assertEq(gradeAnswer("", machineQuestion).verdict, "fail", "empty output → fail, never silently pass");

  const judged = gradeAnswer("any answer at all", judgementQuestion);
  assertEq(judged.verdict, "manual", "judgement questions grade as manual, not pass/fail");
  assertJsonEq(judged.missing, [], "manual questions carry no missing list");
}

// ---- refusal grading (review round 1: an exit-3 refusal must never grade) ----
{
  const refusal =
    "[code-intel] No CodeGraph index in this repo (.codegraph/ is missing).\n\n" +
    "Nothing here can answer until it exists. Build it:  codegraph init\n" +
    "A negative result from this tool right now would be a lie, so it refuses instead.";
  assertEq(gradeRow(3, refusal, machineQuestion).verdict, "ungraded", "exit 3 refusal → ungraded, never graded");
  assertEq(gradeRow(3, refusal, machineQuestion).missing.length, 0, "ungraded carries no missing list");
  assertEq(gradeRow(3, "", machineQuestion).verdict, "ungraded", "exit 3 with empty output → ungraded (exit code is the signal)");
  assertEq(gradeRow(0, "Callers of betaFn:\n  src/alpha.mjs:3", machineQuestion).verdict, "pass", "exit 0 still grades normally");
  assertEq(gradeRow(1, "boom", machineQuestion).verdict, "fail", "non-refusal non-zero exit still grades the output it produced");
  assertEq(gradeRow(0, "anything", judgementQuestion).verdict, "manual", "judgement stays manual regardless");
}

// ---- direct-arm merge ----
{
  const results = [
    { id: "synthetic-q1", verdict: "pass" },
    { id: "synthetic-q2", verdict: "manual" },
  ];
  const merged = mergeDirect(results, [
    { id: "synthetic-q1", verdict: "fail", toolCalls: 4, transcript: "t1" },
  ]);
  assertEq(merged.length, 1, "direct entries merge onto their question");
  assertEq(merged[0].graphVerdict, "pass", "graph verdict carried through");
  assertEq(merged[0].directVerdict, "fail", "direct verdict carried through");
  assertEq(merged[0].toolCalls, 4, "direct tool-call count carried through");

  let threw = false;
  try {
    mergeDirect(results, [{ id: "ghost-id", verdict: "pass" }]);
  } catch {
    threw = true;
  }
  assert(threw, "unknown direct-arm id is an error, never a silent drop");
}

// ---- table rendering ----
{
  const cost = "inconclusive — shell arm, no token metering; agent-arm pricing out of slice";
  const rows = [
    { id: "synthetic-q1", class: "caller-chain", verb: "callers", verdict: "pass", bytes: 120, lines: 6, ms: 210, missing: [] },
    { id: "synthetic-q2", class: "judgement", verb: "callers", verdict: "manual", bytes: 90, lines: 4, ms: 200, missing: [] },
    { id: "synthetic-q3", class: "shared-symbol-impact", verb: "impact", verdict: "fail", bytes: 60, lines: 3, ms: 190, missing: ["missingRef"] },
  ];
  const directRows = [{ id: "synthetic-q1", graphVerdict: "pass", directVerdict: "fail", toolCalls: 5 }];
  const table = renderTable(rows, { costStatement: cost, directRows });

  assert(table.includes(cost), "cost honesty statement appears in the table");
  assert(table.includes("cost: inconclusive"), "cost is stated as inconclusive, never a number");
  assert(table.includes("graph    direct"), "combined section renders when direct rows are given");
  assert(table.includes("missing: missingRef"), "missing list printed for the row that has one");

  const graphOnly = renderTable(rows, { costStatement: cost });
  assert(!graphOnly.includes("direct"), "no combined section without direct rows");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
