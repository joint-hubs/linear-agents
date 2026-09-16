// Tests for scripts/codegraph-benchmark.mjs — run with: node scripts/codegraph-benchmark.test.mjs
//
// Covers the pure core (grading, direct-arm merge, table rendering) and one
// end-to-end run of the spawning harness (review round 2: the wiring —
// runGraphArm grading through gradeRow, and main()'s exit-3-on-ungraded path —
// must be asserted, not just exercised operationally). All graded data is
// synthetic; the end-to-end run asserts exit codes and summary counts only,
// never answer content, so no repository symbol's ground truth is touched.

import { gradeAnswer, gradeRow, mergeDirect, renderTable } from "./codegraph-benchmark.mjs";

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HARNESS = join(__dirname, "codegraph-benchmark.mjs");
const WRAPPER_SRC = join(__dirname, "code-intel.mjs");
const MANIFEST = join(__dirname, "codegraph-benchmark-questions.json");

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

// ---- end-to-end: the wiring grades refusals and exits 3 (review round 2) ----
// Unit tests pin gradeRow's contract; this pins the call site and the run
// exit path. Runs the committed harness in a temp fixture with no .codegraph/:
// the wrapper's refusal fires before any CLI spawn, so no codegraph binary is
// needed. Outputs land in the fixture (DEFAULT_OUT is harness-relative).
{
  const root = mkdtempSync(join(tmpdir(), "foc114-bench-e2e-"));
  mkdirSync(join(root, "scripts"));
  copyFileSync(HARNESS, join(root, "scripts", "codegraph-benchmark.mjs"));
  copyFileSync(WRAPPER_SRC, join(root, "scripts", "code-intel.mjs"));
  copyFileSync(MANIFEST, join(root, "scripts", "codegraph-benchmark-questions.json"));

  const res = spawnSync(process.execPath, [join(root, "scripts", "codegraph-benchmark.mjs")], {
    encoding: "utf8",
  });
  assertEq(res.status, 3, "e2e: unindexed run exits 3 (UNKNOWN propagated from the wrapper)");
  assert(
    (res.stdout || "").includes("0 pass, 0 fail, 0 manual, 7 ungraded"),
    "e2e: summary counts every refusal as ungraded (call-site wiring, not just gradeRow)",
  );
  assert(
    (res.stderr || "").includes("does not grade the frozen set"),
    "e2e: run-level warning printed on the exit-3 path",
  );
  const results = JSON.parse(
    readFileSync(join(root, ".state", "foc-114", "benchmark", "results.json"), "utf8"),
  );
  assertEq(results.summary.ungraded, 7, "e2e: results.json records 7 ungraded rows");

  rmSync(root, { recursive: true, force: true });
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
