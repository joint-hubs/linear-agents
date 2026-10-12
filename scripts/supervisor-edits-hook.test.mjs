// scripts/supervisor-edits-hook.test.mjs — the UserPromptSubmit hook that
// re-surfaces unseen record edits (FOC-795, supervisor-edits-hook.mjs).
//
// The properties worth protecting:
//   · unseen rows are printed as context and the run's seenThrough advances
//     to the last SHOWN row (a cut-off tail stays unseen and re-delivers);
//   · a second run prints nothing — one delivery per row, like the wake queue;
//   · a run untouched for 14 days is ignored;
//   · a torn or malformed edits.jsonl line is skipped, never fatal;
//   · nothing unseen means empty stdout; the hook NEVER fails (always exit 0).
//
// Everything runs through the LA_SUPERVISOR_STATE_HOME seam pointed at a
// mkdtemp dir set BEFORE the import; the hook itself runs as a child process
// with empty stdin, exactly as the harness invokes it.
//
// Run: node scripts/supervisor-edits-hook.test.mjs

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = join(ROOT, "scripts", "supervisor-edits-hook.mjs");

const HOME = mkdtempSync(join(tmpdir(), "la-sup-edits-"));
process.env.LA_SUPERVISOR_STATE_HOME = HOME;

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  PASS " + name);
  } catch (err) {
    failures.push(name);
    console.log("  FAIL " + name + "\n       " + err.message);
  }
}

const fail = (msg) => { throw new Error(msg); };
const eq = (a, b, label) => { if (a !== b) fail(`${label}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };

let counter = 0;
function fixtureRun() {
  const runId = `edits-test-${process.pid}-${Date.now()}-${counter++}`;
  mkdirSync(join(HOME, runId), { recursive: true });
  return runId;
}

const editRow = (seq, { path = "triage.json", type = "triage", fields = ["node"] } = {}) => ({
  seq,
  ts: new Date().toISOString(),
  who: "dashboard",
  path,
  type,
  changes: fields.map((field) => ({ field, before: "old", after: "new" })),
});

const writeEdits = (runId, rows) =>
  writeFileSync(join(HOME, runId, "edits.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

const seenPath = (runId) => join(HOME, runId, "edits-seen.json");

// The harness runs the hook with its payload on stdin; the tests feed empty
// stdin and expect the tolerated-empty path.
function runHook() {
  const r = spawnSync(process.execPath, [HOOK], {
    encoding: "utf8",
    input: "",
    env: { ...process.env, LA_SUPERVISOR_STATE_HOME: HOME },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const listedLines = (stdout) => stdout.split("\n").filter((l) => l.startsWith("- ["));

console.log("\nsupervisor-edits-hook: unseen rows are printed once and recorded");

test("no edits anywhere → empty stdout, exit 0", () => {
  fixtureRun(); // a run dir with no edits.jsonl
  const r = runHook();
  eq(r.code, 0, "exit code");
  eq(r.stdout, "", "stdout empty");
});

test("unseen rows are printed and seenThrough advances to the last row", () => {
  const runId = fixtureRun();
  writeEdits(runId, [
    editRow(1, { path: "triage.json", type: "triage", fields: ["node"] }),
    editRow(2, { path: "gates/gate-dev-1-1.json", type: "gate", fields: ["facts.branch", "facts.notes"] }),
  ]);
  const r = runHook();
  eq(r.code, 0, "exit code");
  if (!r.stdout.includes("Mateusz edited records since your last turn — re-read before acting:")) {
    fail(`headline missing: ${r.stdout}`);
  }
  if (!r.stdout.includes(`- [${runId}] #1 triage triage.json: node`)) fail(`row 1 missing: ${r.stdout}`);
  if (!r.stdout.includes(`- [${runId}] #2 gate gates/gate-dev-1-1.json: facts.branch, facts.notes`)) {
    fail(`row 2 missing: ${r.stdout}`);
  }
  const seen = JSON.parse(readFileSync(seenPath(runId), "utf8"));
  eq(seen.seenThrough, 2, "seenThrough advanced");
  if (typeof seen.seenAt !== "string") fail(`seenAt missing: ${JSON.stringify(seen)}`);
});

test("a second run prints nothing (one delivery per row)", () => {
  const r = runHook();
  eq(r.code, 0, "exit code");
  eq(r.stdout, "", "stdout empty");
});

console.log("\nsupervisor-edits-hook: tolerance and recency");

test("malformed lines are skipped, the valid row still prints", () => {
  const runId = fixtureRun();
  writeFileSync(
    join(HOME, runId, "edits.jsonl"),
    [
      "not json",
      JSON.stringify({ noSeq: true }),
      JSON.stringify(editRow(1, { path: "intake.json", type: "intake", fields: ["summary"] })),
      "{torn",
      "",
    ].join("\n"),
  );
  const r = runHook();
  eq(r.code, 0, "exit code");
  if (!r.stdout.includes(`- [${runId}] #1 intake intake.json: summary`)) fail(`stdout: ${r.stdout}`);
  const seen = JSON.parse(readFileSync(seenPath(runId), "utf8"));
  eq(seen.seenThrough, 1, "seenThrough advanced past the malformed lines");
});

test("a run older than 14 days is ignored", () => {
  const runId = fixtureRun();
  writeEdits(runId, [editRow(1)]);
  const old = new Date(Date.now() - 20 * 24 * 3_600_000);
  utimesSync(join(HOME, runId), old, old);
  utimesSync(join(HOME, runId, "edits.jsonl"), old, old);
  const r = runHook();
  eq(r.code, 0, "exit code");
  eq(r.stdout, "", "old run ignored");
  if (existsSync(seenPath(runId))) fail("a watermark was written for a run nobody read");
});

test("more than 20 rows truncate with a +N more line; seenThrough advances only through the shown rows", () => {
  const runId = fixtureRun();
  writeEdits(runId, Array.from({ length: 25 }, (_, i) => editRow(i + 1)));
  const r = runHook();
  eq(r.code, 0, "exit code");
  eq(listedLines(r.stdout).length, 20, "exactly 20 rows listed");
  if (!r.stdout.includes("+5 more")) fail(`"+5 more" missing: ${r.stdout}`);
  const seen = JSON.parse(readFileSync(seenPath(runId), "utf8"));
  eq(seen.seenThrough, 20, "seenThrough stops at the last shown row");
});

try {
  rmSync(HOME, { recursive: true, force: true });
} catch {
  /* best effort */
}

console.log(`\nsupervisor-edits-hook: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("FAILURES:\n - " + failures.join("\n - "));
  process.exit(1);
}
