// scripts/decision-log.test.mjs — FOC-449: the outcome side of the decision log.
//
// Covers the mask-only scrub variant the event record routes through (E1b),
// the label CLI (E2: manual outcomes, unknown events refused, bad flags
// refused), the three supervisor auto-joins (E3: gate answer → human, verdict
// → agent, merge → agent; provenance-absent skip; best-effort failure) and
// the deterministic pairing of repeatable provenance flags. All offline: the
// fixture run logs live in this repo's gitignored .state/runs/ under unique
// test run ids and are removed on exit — the same rule the supervisor suites
// follow for .state/supervisor/.
//
// Run: node scripts/decision-log.test.mjs

import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { scrub, scrubMask, MAX_ERROR_TEXT } from "./mcp/scrub.mjs";
import {
  RUNS_DIR,
  SPLIT_VERSION,
  appendLabel,
  exportDecisionEvents,
  findEventFile,
  labelRecord,
  pairDecisionEvents,
  splitFor,
} from "./decision-log.mjs";
import {
  ROOT,
  cleanupLater,
  fixtureChild,
  fixtureRepo,
  fixtureRun,
  fixtureWorktree,
  gitIn,
  harness,
  parse,
  runScript,
} from "./supervisor-test-fixtures.mjs";
import { writeRegistry } from "./supervisor-lib.mjs";

const { test, fail, summary } = harness();

const DECISION_LOG = join(ROOT, "scripts", "decision-log.mjs");
const GATE = join(ROOT, "scripts", "supervisor-gate.mjs");
const VERDICT = join(ROOT, "scripts", "supervisor-verdict.mjs");
const MERGE = join(ROOT, "scripts", "supervisor-merge.mjs");

// ── fixture: a run log holding decision events ───────────────────────────────

let runCounter = 0;

/**
 * A decisions.jsonl under the repo's real .state/runs/ (unique run id), with
 * the given event lines. Cleaned up on exit — the supervisor fixtures register
 * their run dirs the same way.
 */
function fixtureRunLog(events = []) {
  const runId = `test-dlog-${process.pid}-${runCounter++}`;
  mkdirSync(join(RUNS_DIR, runId), { recursive: true });
  const path = join(RUNS_DIR, runId, "decisions.jsonl");
  writeFileSync(
    path,
    events.map((e, i) => JSON.stringify({ type: "event", runId, ts: `2026-09-22T10:0${i}:00Z`, ...e })).join("\n") + "\n",
    "utf8",
  );
  cleanupLater(join(RUNS_DIR, runId));
  return { runId, path };
}

const readLog = (path) =>
  existsSync(path)
    ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];

/** The same layout in a hermetic temp dir, for the module-API tests. */
const mkdtempRuns = (lines) => {
  const runsDir = mkdtempSync(join(tmpdir(), "dlog-runs-"));
  cleanupLater(runsDir);
  const runId = "unit-run";
  mkdirSync(join(runsDir, runId), { recursive: true });
  const path = join(runsDir, runId, "decisions.jsonl");
  if (lines.length) writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  return { runsDir, runId, path };
};

const EVENT = (over = {}) => ({
  type: "event",
  eventId: randomUUID(),
  decisionId: "gate.screen",
  ok: true,
  answers: { q0: { type: "noul", noul: 0.9 } },
  ...over,
});

// ── 1. the mask-only scrub variant (E1b routing primitive) ───────────────────
console.log("\nscrubMask — key-shaped masking without the error cap");

test("scrubMask masks key-shaped material and keeps everything else", () => {
  const masked = scrubMask("call failed for api_key=sk-or-v1-0123456789abcdef0123456789abcdef with Bearer abc123def456");
  assert.ok(masked.includes("api_key=[REDACTED]"), `tokenized param masked: ${masked}`);
  assert.ok(masked.includes("Bearer [REDACTED]"), `header masked: ${masked}`);
  assert.ok(!masked.includes("sk-or-v1-0123456789abcdef0123456789abcdef"), "key value gone");
  assert.ok(masked.startsWith("call failed for "), "prose kept");
});

test("scrubMask never truncates — the 120-char cap stays on scrub() only", () => {
  const long = "plain prose sentence for the cap check. ".repeat(20);
  assert.ok(long.length > MAX_ERROR_TEXT, "precondition: longer than the error cap");
  assert.equal(scrubMask(long), long, "mask-only variant stores the full text");
  assert.equal(scrub(long).length, MAX_ERROR_TEXT, "scrub() still truncates at the cap");
  assert.ok(scrub(long).endsWith("..."), "truncation marker intact");
});

// ── 2. label records ─────────────────────────────────────────────────────────
console.log("\nlabelRecord / appendLabel");

test("a manual label record carries the outcome, who vouches for it and nothing derived", () => {
  const rec = labelRecord({ eventId: "e-1", outcome: "ship it", by: "human", now: () => "2026-09-22T10:00:00Z" });
  assert.deepEqual(rec, {
    type: "label",
    eventId: "e-1",
    outcome: "ship it",
    by: "human",
    source: "manual",
    ts: "2026-09-22T10:00:00Z",
  });
  if ("answers" in rec) fail("a label never carries the event's answers");
  assert.throws(() => labelRecord({ eventId: "e-1", outcome: "x", by: "model" }), /--by must be one of/);
  assert.throws(() => labelRecord({ eventId: "e-1", by: "human" }), /--outcome/);
  assert.throws(() => labelRecord({ outcome: "x", by: "human" }), /--event/);
});

test("appendLabel writes the label next to the event, and refuses an unknown event", () => {
  const eventId = randomUUID();
  const f = mkdtempRuns([EVENT({ eventId })]);
  const { path } = appendLabel({ eventId, outcome: "correct", by: "human", runsDir: f.runsDir });
  assert.equal(path, f.path, "label lands in the run file holding the event");
  const lines = readLog(f.path);
  assert.equal(lines.length, 2);
  assert.equal(lines[1].type, "label");
  assert.equal(lines[1].eventId, eventId);
  assert.equal(lines[1].outcome, "correct", "the outcome is the argument, never the event's answers");
  assert.equal(lines[1].source, "manual");
  assert.throws(() => appendLabel({ eventId: randomUUID(), outcome: "x", by: "human", runsDir: f.runsDir }), /not found/);
});

test("scan mode finds the event wherever it lives; a --run log without it is refused", () => {
  const eventId = randomUUID();
  const f = mkdtempRuns([EVENT({ eventId })]);
  const found = findEventFile(eventId, { runsDir: f.runsDir });
  assert.equal(found.runId, "unit-run", "the scan finds the holding log");
  const { path } = appendLabel({ eventId, outcome: "ok", by: "agent", runsDir: f.runsDir });
  assert.equal(path, f.path);
  // The event exists, but not in THIS run's log — --run pointing elsewhere is refused.
  const other = mkdtempRuns([EVENT()]);
  assert.throws(() => findEventFile(eventId, { runId: other.runId, runsDir: other.runsDir }), /not in the log of run/);
});

// ── 3. the label CLI ─────────────────────────────────────────────────────────
console.log("\nlabel CLI");

test("label appends a manual label record and exits 0", () => {
  const eventId = randomUUID();
  const f = fixtureRunLog([EVENT({ eventId })]);
  const r = runScript(DECISION_LOG, ["label", "--event", eventId, "--outcome", "rób A", "--by", "human", "--run", f.runId]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = parse(r, fail);
  assert.equal(out.ok, true);
  assert.equal(out.runId, f.runId);
  const lines = readLog(f.path);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[1], { type: "label", eventId, outcome: "rób A", by: "human", source: "manual", ts: lines[1].ts });
  assert.ok(lines[1].ts, "ts recorded");
});

test("label without --run scans the runs and still lands in the holding file", () => {
  const eventId = randomUUID();
  const f = fixtureRunLog([EVENT({ eventId })]);
  const r = runScript(DECISION_LOG, ["label", "--event", eventId, "--outcome", "poprawione", "--by", "agent"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const lines = readLog(f.path);
  assert.equal(lines.length, 2, "label appended to the scanned file");
  assert.equal(lines[1].eventId, eventId);
  assert.equal(lines[1].source, "manual");
});

test("label refuses an unknown event, a bad --by and a missing outcome — exit non-zero, nothing written", () => {
  const f = fixtureRunLog([EVENT()]);
  const before = readLog(f.path);
  for (const [name, args] of [
    ["unknown event", ["label", "--event", randomUUID(), "--outcome", "x", "--by", "human", "--run", f.runId]],
    ["bad --by", ["label", "--event", "no-such", "--outcome", "x", "--by", "model", "--run", f.runId]],
    ["missing --by", ["label", "--event", randomUUID(), "--outcome", "x", "--run", f.runId]],
    ["missing --outcome", ["label", "--event", randomUUID(), "--by", "human", "--run", f.runId]],
    ["missing --event", ["label", "--outcome", "x", "--by", "human", "--run", f.runId]],
    ["--run without a value", ["label", "--event", randomUUID(), "--outcome", "x", "--by", "human", "--run"]],
  ]) {
    const r = runScript(DECISION_LOG, args);
    assert.notEqual(r.status, 0, `${name} was accepted`);
    assert.ok(r.stderr.trim(), `${name} says why on stderr`);
  }
  assert.deepEqual(readLog(f.path), before, "a refused label writes nothing");
});

// ── 4. provenance pairing ────────────────────────────────────────────────────
console.log("\npairDecisionEvents");

test("one run covers every event; N runs pair positionally; none means scan", () => {
  const one = pairDecisionEvents(["e1", "e2", "e3"], ["run-a"]);
  assert.deepEqual(one, [
    { eventId: "e1", runId: "run-a" },
    { eventId: "e2", runId: "run-a" },
    { eventId: "e3", runId: "run-a" },
  ]);
  const positional = pairDecisionEvents(["e1", "e2"], ["run-a", "run-b"]);
  assert.deepEqual(positional, [
    { eventId: "e1", runId: "run-a" },
    { eventId: "e2", runId: "run-b" },
  ]);
  assert.deepEqual(pairDecisionEvents(["e1"], []), [{ eventId: "e1", runId: null }], "no run → null, the label scan decides");
  assert.deepEqual(pairDecisionEvents([], []), [], "no events → no provenance");
  assert.throws(() => pairDecisionEvents(["e1", "e2", "e3"], ["run-a", "run-b"]), /--decision-run given 2 times/);
});

// ── 5. gate auto-join ────────────────────────────────────────────────────────
console.log("\ngate answer auto-join");

const gateCli = (args) => runScript(GATE, args);

test("emit carries the provenance and the answer labels the events as human via gate", () => {
  const runId = fixtureRun({ children: { "dev-1": fixtureChild() } });
  const eventId = randomUUID();
  const dlog = fixtureRunLog([EVENT({ eventId })]);
  const emitted = parse(
    gateCli([
      "emit", "--run", runId, "--child", "dev-1", "--kind", "plan.gate1",
      "--summary", "s", "--question", "q?", "--decision-event", eventId, "--decision-run", dlog.runId,
    ]),
    fail,
  );
  assert.deepEqual(emitted.decisionEvents, [{ eventId, runId: dlog.runId }], "provenance on the record");

  const answered = parse(gateCli(["answer", "--run", runId, "--gate", emitted.gateId, "--text", "rób A"]), fail);
  assert.equal(answered.ok, true, answered.error);
  assert.deepEqual(answered.warnings, [], "no warnings on a clean join");
  const lines = readLog(dlog.path);
  assert.equal(lines.length, 2, "one label appended");
  assert.equal(lines[1].type, "label");
  assert.equal(lines[1].eventId, eventId);
  assert.equal(lines[1].outcome, "rób A", "outcome = the answer value");
  assert.equal(lines[1].by, "human", "a gate answer is human work");
  assert.equal(lines[1].source, "auto");
  assert.equal(lines[1].via, "gate");
  if ("answers" in lines[1]) fail("the label never inherits the event's answers");
});

test("a gate without provenance labels nothing and says nothing", () => {
  const runId = fixtureRun({ children: { "dev-1": fixtureChild() } });
  const dlog = fixtureRunLog([EVENT()]);
  const before = readLog(dlog.path);
  const emitted = parse(
    gateCli(["emit", "--run", runId, "--child", "dev-1", "--kind", "question", "--summary", "s", "--question", "q?"]),
    fail,
  );
  if ("decisionEvents" in emitted) fail("no provenance key without provenance flags");
  const answered = parse(gateCli(["answer", "--run", runId, "--gate", emitted.gateId, "--text", "ok"]), fail);
  assert.equal(answered.ok, true);
  assert.equal(answered.warnings.length, 0, "silent skip — no label warning");
  assert.deepEqual(readLog(dlog.path), before, "no label written");
});

test("a failed label is a warning, never a broken answer", () => {
  const runId = fixtureRun({ children: { "dev-1": fixtureChild() } });
  fixtureRunLog([EVENT()]);
  const ghost = randomUUID();
  const emitted = parse(
    gateCli([
      "emit", "--run", runId, "--child", "dev-1", "--kind", "question",
      "--summary", "s", "--question", "q?", "--decision-event", ghost, "--decision-run", "test-dlog-ghost",
    ]),
    fail,
  );
  const r = gateCli(["answer", "--run", runId, "--gate", emitted.gateId, "--text", "rób A"]);
  assert.equal(r.status, 0, `the primary flow must not break: ${r.stdout}`);
  assert.match(r.stderr, /decision label for event .*was not written/, "the failure is observable");
  const answered = parse(r, fail);
  assert.equal(answered.status, "answered", "the gate record is the primary flow and it landed");
  assert.equal(answered.warnings.length, 1, "the warning rides the answer output too");
});

// ── 6. verdict auto-join ─────────────────────────────────────────────────────
console.log("\nverdict auto-join");

/**
 * A REVIEW child and the DEV child whose work it reviews — the shape the
 * verdict CLI fingerprints. Same recipe as supervisor-verdict.test.mjs.
 */
function verdictScenario() {
  const { base, repo } = fixtureRepo();
  const dev = fixtureWorktree(repo, "foc-123-dev");
  const review = fixtureWorktree(repo, "foc-123-review");
  const runId = fixtureRun({ triage: false });
  writeRegistry(runId, {
    runId,
    children: {
      "dev-1": fixtureChild({
        worktree: dev.worktree,
        branch: dev.branch,
        baseRevision: dev.baseRevision,
      }),
      "review-1": fixtureChild({
        childId: "review-1",
        squad: "review",
        worktree: review.worktree,
        branch: review.branch,
        baseRevision: review.baseRevision,
      }),
    },
    rounds: {},
  });
  return { base, runId };
}

let issueCounter = 0;
function issueFile(dir, acs) {
  const path = join(dir, `issue-${issueCounter++}.json`);
  const body =
    "## Acceptance Criteria\n\n" +
    Array.from({ length: acs }, (_, i) => `**Given** g${i}\n**When** w${i}\n**Then** t${i}\n`).join("\n");
  writeFileSync(path, JSON.stringify({ identifier: "FOC-123", description: body }));
  return path;
}

// Offline recipe from supervisor-verdict.test.mjs: the dry-run env keeps any
// Linear op offline, and LA_SUPERVISOR_CHILD is scrubbed so the FOC-167 child
// guard never skips what these tests are about.
const recordVerdict = (s, extra = []) => {
  const saved = process.env.LA_SUPERVISOR_CHILD;
  delete process.env.LA_SUPERVISOR_CHILD;
  try {
    return runScript(VERDICT, ["record", "--run", s.runId, "--child", "review-1", ...extra], { REVIEW_DRY_RUN: "1" });
  } finally {
    if (saved !== undefined) process.env.LA_SUPERVISOR_CHILD = saved;
  }
};

const ONE_AC = JSON.stringify({ ac: "AC-1", evidence: "scripts/a.test.mjs:10 asserts it" });

test("a pass verdict labels its decision events as agent via verdict", () => {
  const s = verdictScenario();
  const eventId = randomUUID();
  const dlog = fixtureRunLog([EVENT({ eventId })]);
  const out = parse(
    recordVerdict(s, [
      "--verdict", "pass", "--issue-file", issueFile(s.base, 1), "--ac", ONE_AC,
      "--decision-event", eventId, "--decision-run", dlog.runId,
    ]),
    fail,
  );
  assert.equal(out.ok, true, out.error);
  assert.deepEqual(out.decisionEvents, [{ eventId, runId: dlog.runId }], "provenance on the verdict record");
  const lines = readLog(dlog.path);
  assert.equal(lines.length, 2, "one label appended");
  assert.equal(lines[1].outcome, "pass", "outcome = the verdict value");
  assert.equal(lines[1].by, "agent", "a review verdict is agent work");
  assert.equal(lines[1].source, "auto");
  assert.equal(lines[1].via, "verdict");
});

test("a verdict without provenance labels nothing", () => {
  const s = verdictScenario();
  const dlog = fixtureRunLog([EVENT()]);
  const before = readLog(dlog.path);
  const out = parse(
    recordVerdict(s, ["--verdict", "pass", "--issue-file", issueFile(s.base, 1), "--ac", ONE_AC]),
    fail,
  );
  assert.equal(out.ok, true, out.error);
  if ("decisionEvents" in out) fail("no provenance key without provenance flags");
  assert.deepEqual(readLog(dlog.path), before, "no label written");
});

test("a fail verdict labels with the verdict value too", () => {
  const s = verdictScenario();
  const eventId = randomUUID();
  const dlog = fixtureRunLog([EVENT({ eventId })]);
  const out = parse(
    recordVerdict(s, [
      "--verdict", "fail",
      "--finding", JSON.stringify({ text: "x", evidence: "scripts/a.mjs:1 resolvePrice" }),
      "--failing-test", "suite/a",
      "--decision-event", eventId, "--decision-run", dlog.runId,
    ]),
    fail,
  );
  assert.equal(out.ok, true, out.error);
  const lines = readLog(dlog.path);
  assert.equal(lines[1].outcome, "fail", "outcome = the verdict value");
  assert.equal(lines[1].by, "agent");
  assert.equal(lines[1].via, "verdict");
});

// ── 7. merge auto-join ───────────────────────────────────────────────────────
console.log("\nmerge auto-join");

const VERIFY_OK = 'node -e "process.exit(0)"';
const VERIFY_FAIL = 'node -e "process.exit(1)"';

/**
 * One finished candidate — the shape supervisor-merge.test.mjs builds: a real
 * worktree one commit ahead of its recorded base.
 */
function mergeFixture() {
  const { repo } = fixtureRepo();
  const wt = fixtureWorktree(repo, "foc-100-dev");
  writeFileSync(join(wt.worktree, "value.txt"), "ok\n");
  gitIn(wt.worktree, "add", "-A");
  gitIn(wt.worktree, "commit", "-m", "foc-100: work");
  const runId = fixtureRun({
    triage: false,
    children: {
      "dev-1": fixtureChild({
        worktree: wt.worktree,
        branch: wt.branch,
        baseRevision: wt.baseRevision,
        allowedPaths: [],
      }),
    },
  });
  return { runId };
}

test("an accepted merge labels the events as agent via merge with outcome merged", () => {
  const f = mergeFixture();
  const eventId = randomUUID();
  const dlog = fixtureRunLog([EVENT({ eventId })]);
  const out = parse(
    runScript(MERGE, ["--run", f.runId, "--verify", VERIFY_OK, "--decision-event", eventId, "--decision-run", dlog.runId]),
    fail,
  );
  assert.equal(out.accepted, true, JSON.stringify(out.findings));
  assert.deepEqual(out.decisionEvents, [{ eventId, runId: dlog.runId }], "provenance on the merge report");
  const lines = readLog(dlog.path);
  assert.equal(lines.length, 2, "one label appended");
  assert.equal(lines[1].outcome, "merged", "accepted → merged");
  assert.equal(lines[1].by, "agent");
  assert.equal(lines[1].source, "auto");
  assert.equal(lines[1].via, "merge");
});

test("a rejected merge labels not-merged and still exits 1", () => {
  const f = mergeFixture();
  const eventId = randomUUID();
  const dlog = fixtureRunLog([EVENT({ eventId })]);
  const r = runScript(MERGE, ["--run", f.runId, "--verify", VERIFY_FAIL, "--decision-event", eventId, "--decision-run", dlog.runId]);
  assert.equal(r.status, 1, "a rejected integration still exits 1");
  const out = parse(r, fail);
  assert.equal(out.accepted, false);
  const lines = readLog(dlog.path);
  assert.equal(lines[1].outcome, "not-merged", "rejected → not-merged");
  assert.equal(lines[1].by, "agent");
  assert.equal(lines[1].via, "merge");
});

test("a merge without provenance labels nothing", () => {
  const f = mergeFixture();
  const dlog = fixtureRunLog([EVENT()]);
  const before = readLog(dlog.path);
  const out = parse(runScript(MERGE, ["--run", f.runId, "--verify", VERIFY_OK]), fail);
  assert.equal(out.accepted, true, JSON.stringify(out.findings));
  if ("decisionEvents" in out) fail("no provenance key without provenance flags");
  assert.deepEqual(readLog(dlog.path), before, "no label written");
});

// ── 8. export ────────────────────────────────────────────────────────────────
console.log("\nexport");

// The export scans EVERY run log name-ascending, so these tests scope to a
// unique decisionId — the auto-join tests above legitimately wrote events of
// other decisions into the same runs dir.
let exportCounter = 0;
const EXPORT_DEC = () => `export.test.${process.pid}.${exportCounter++}`;

/** A UUID that hashes into the named split for this decisionId. */
const eventIdForSplit = (split, decisionId) => {
  for (;;) {
    const id = randomUUID();
    if (splitFor(id, decisionId) === split) return id;
  }
};

test("splitFor is a pure function with all three buckets reachable", () => {
  const dec = EXPORT_DEC();
  const a = splitFor("e-1", dec);
  assert.equal(splitFor("e-1", dec), a, "same pair → same split");
  for (const split of ["train", "val", "test"]) {
    const id = eventIdForSplit(split, dec);
    assert.equal(splitFor(id, dec), split);
  }
});

test("export joins events with their labels, deterministically and byte-identically", () => {
  const dec = EXPORT_DEC();
  const e1 = EVENT({ decisionId: dec });
  const e2 = EVENT({ decisionId: dec });
  const f = fixtureRunLog([e1, e2]);
  const r = runScript(DECISION_LOG, ["label", "--event", e1.eventId, "--outcome", "rób A", "--by", "human", "--run", f.runId]);
  assert.equal(r.status, 0, r.stderr);

  const first = runScript(DECISION_LOG, ["export", "--decision", dec]);
  const second = runScript(DECISION_LOG, ["export", "--decision", dec]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout, second.stdout, "same log content ⇒ byte-identical output");

  const records = first.stdout.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(records.length, 2, "one record per event, legacy-free log");
  assert.ok(records.every((rec) => rec.splitVersion === SPLIT_VERSION && rec.decisionId === dec), "split assignment present");
  const byId = new Map(records.map((rec) => [rec.eventId, rec]));
  assert.deepEqual(byId.get(e1.eventId).labels.map((l) => l.outcome), ["rób A"], "labels joined");
  assert.deepEqual(byId.get(e2.eventId).labels, [], "an unlabelled event exports with an empty label list");
  const rec = byId.get(e1.eventId);
  assert.equal(rec.split, splitFor(e1.eventId, dec), "the recorded split IS splitFor()");
  assert.equal(rec.runId, f.runId, "group key: runId");
  assert.deepEqual(Object.keys(rec).sort(), ["decisionId", "eventId", "input", "labels", "output", "runId", "split", "splitVersion", "taskKey", "ts"]);
});

test("export skips legacy lines without a type and never crashes on them", () => {
  const dec = EXPORT_DEC();
  const f = fixtureRunLog([EVENT({ decisionId: dec })]);
  appendFileSync(f.path, JSON.stringify({ runId: f.runId, decisionId: dec, ok: true, answers: {} }) + "\n", "utf8");
  const r = runScript(DECISION_LOG, ["export", "--decision", dec]);
  assert.equal(r.status, 0, r.stderr);
  const records = r.stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(records.length, 1, "the legacy line (no type, no eventId) is skipped, not exported");
});

test("--out writes the JSONL file and a summary on stdout", () => {
  const dec = EXPORT_DEC();
  fixtureRunLog([EVENT({ decisionId: dec }), EVENT({ decisionId: dec })]);
  const out = join(tmpdir(), `dlog-export-${process.pid}-${runCounter++}.jsonl`);
  cleanupLater(out);
  const r = runScript(DECISION_LOG, ["export", "--decision", dec, "--out", out]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const s = parse(r, fail);
  assert.equal(s.ok, true);
  assert.equal(s.splitVersion, SPLIT_VERSION);
  assert.equal(s.total, 2);
  assert.deepEqual(Object.keys(s.counts).sort(), ["test", "train", "val"]);
  assert.equal(s.counts.train + s.counts.val + s.counts.test, 2);
  const lines = readLog(out);
  assert.equal(lines.length, 2, "file holds the same records the summary counts");
});

test("export of a decision nobody called is an empty, successful JSONL", () => {
  const r = runScript(DECISION_LOG, ["export", "--decision", EXPORT_DEC()]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout.trim(), "", "no records");
});

test("the module API matches the CLI", () => {
  const dec = EXPORT_DEC();
  const e = EVENT({ decisionId: dec });
  const f = fixtureRunLog([e]);
  const records = exportDecisionEvents(dec);
  assert.equal(records.length, 1, "exactly the fixture's event");
  assert.equal(records[0].eventId, e.eventId);
  assert.equal(records[0].runId, f.runId);
  assert.ok(records[0].ts, "event ts carried");
});

// ── summary ──────────────────────────────────────────────────────────────────
summary();