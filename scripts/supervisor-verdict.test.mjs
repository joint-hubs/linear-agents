// scripts/supervisor-verdict.test.mjs — grounded verdicts and progress fingerprints.
//
// Replaces the round-cap tests that used to live in supervisor-followup.test.mjs.
// The cap counted; this measures. The difference is the whole point, so two of
// these tests assert the pair that a counter could never separate:
//
//   · a repeated round is refused  (the cap got this right, by luck)
//   · a THIRD differing round is allowed  (the cap got this wrong, always)
//
// Run: node scripts/supervisor-verdict.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  FOLLOWUP,
  ROOT,
  baseEnv,
  fixtureRepo,
  fixtureRun,
  fixtureWorktree,
  gitIn,
  harness,
  parse,
  runScript,
} from "./supervisor-test-fixtures.mjs";
import { gatesDir, progressFingerprint, readRegistry, runDir, verdictPath, verdictsDir, writeRegistry } from "./supervisor-lib.mjs";
import { returnGateQuestion } from "./supervisor-verdict.mjs";

const { test, fail, summary } = harness();
const VERDICT = join(ROOT, "scripts", "supervisor-verdict.mjs");

// Every record call here runs linear-ops offline: REVIEW_DRY_RUN=1 makes
// linear-ops serve the mock fixture below instead of the live API (its --dry-run
// flag alone still reads, so the env is what keeps the suite hermetic). And the
// suites are never supervisor children, but this session may BE one —
// LA_SUPERVISOR_CHILD is set by supervisor-spawn, runScript would inherit it,
// and the FOC-167 guard would skip exactly the fail transition these tests
// prove. It is scrubbed, and re-settable per call.
//
// `opts.stripCreds` (round 3) is the offline-REAL recipe: a dryRun:false op is
// made to fail fast by stripping both Linear credential vars AND setting
// LA_LINEAR_NO_ENV_FILE=1 so loadEnv() cannot backfill them from .env.
// linear-ops' loadEnv() backfills an UNSET var from .env at the repo root —
// LA_LINEAR_NO_ENV_FILE skips that read so the recipe stays hermetic on
// any checkout, not just a clean worktree.
const verdict = (args, env = {}, opts = {}) => {
  const e = baseEnv({ REVIEW_DRY_RUN: "1", ...env });
  delete e.LA_SUPERVISOR_CHILD;
  if (env.LA_SUPERVISOR_CHILD !== undefined) e.LA_SUPERVISOR_CHILD = env.LA_SUPERVISOR_CHILD;
  if (opts.stripCreds) {
    delete e.LINEAR_API_KEY;
    delete e.LINEAR_API_KEY_PISI;
    // FOC-355: prevent loadEnv() in linear-client.mjs from backfilling the
    // stripped keys from .env at the repo root. Without this, the offline-real
    // recipe only works in a clean worktree (no .env); on the main checkout
    // .env backfills and linear-ops runs with a real key — a live write.
    e.LA_LINEAR_NO_ENV_FILE = "1";
  }
  return spawnSync(process.execPath, [VERDICT, ...args], { cwd: ROOT, encoding: "utf8", env: e });
};
const followup = (runId, childId, extra = []) =>
  runScript(FOLLOWUP, ["--run", runId, "--child", childId, "--prompt", "again", ...extra]);

// The offline fixtures linear-ops (and linear-query) serve under *_DRY_RUN=1.
// Any prior local file is restored on exit — .state is scratch, but it is not
// ours to throw away. foo-task.json is the scrub pin's counterfactual (R2-1):
// a NON-allowlisted FOO_DRY_RUN=1 with a matching fixture is the exact
// silent-applied shape the scrub exists to kill, so the scrubbed op must never
// reach it.
const MOCK_DIR = join(ROOT, ".state", "mock");
const MOCK_FIXTURE = join(MOCK_DIR, "review-task.json");
const MOCK_FOO_FIXTURE = join(MOCK_DIR, "foo-task.json");
const priorMock = existsSync(MOCK_FIXTURE) ? readFileSync(MOCK_FIXTURE, "utf8") : null;
const priorFooMock = existsSync(MOCK_FOO_FIXTURE) ? readFileSync(MOCK_FOO_FIXTURE, "utf8") : null;
const hadMockDir = existsSync(MOCK_DIR);
mkdirSync(MOCK_DIR, { recursive: true });
const writeMockFixture = (path, identifier) =>
  writeFileSync(
    path,
    JSON.stringify({
      issue: {
        identifier,
        state: { name: "In Review" },
        labels: { nodes: [] },
        description: "## Acceptance Criteria\n\n**Given** g **When** w **Then** t\n",
      },
    }),
    "utf8",
  );
writeMockFixture(MOCK_FIXTURE, "FOC-123");
writeMockFixture(MOCK_FOO_FIXTURE, "FOC-777");
process.on("exit", () => {
  try {
    if (priorMock !== null) writeFileSync(MOCK_FIXTURE, priorMock, "utf8");
    else rmSync(MOCK_FIXTURE, { force: true });
    if (priorFooMock !== null) writeFileSync(MOCK_FOO_FIXTURE, priorFooMock, "utf8");
    else rmSync(MOCK_FOO_FIXTURE, { force: true });
    if (!hadMockDir) rmSync(MOCK_DIR, { recursive: true, force: true });
  } catch { /* best effort, like the fixtures cleanup */ }
});

// A finding that would satisfy the schema, for tests that are about something else.
const CITED = JSON.stringify({ text: "resolvePrice ignores cacheRead", evidence: "scripts/ledger.mjs:88 resolvePrice" });

let issueCounter = 0;
function issueFile(dir, acs) {
  const path = join(dir, `issue-${issueCounter++}.json`);
  const body =
    "## Acceptance Criteria\n\n" +
    Array.from({ length: acs }, (_, i) => `**Given** g${i}\n**When** w${i}\n**Then** t${i}\n`).join("\n");
  writeFileSync(path, JSON.stringify({ identifier: "FOC-123", description: body }));
  return path;
}

/**
 * A REVIEW child and the DEV child whose work it reviews, each with a REAL
 * worktree.
 *
 * Both are required, and that is the shape of a real run rather than test
 * scaffolding: a review with no dev child is a review of nothing, and the
 * fingerprint has to measure DEV's tree. `s.worktree` is DEV's — the one that
 * moves — because that is what every progress assertion here is about.
 */
function scenario() {
  const { base, repo } = fixtureRepo();
  const dev = fixtureWorktree(repo, "foc-123-dev");
  const review = fixtureWorktree(repo, "foc-123-review");
  const runId = fixtureRun();

  const child = (childId, squad, wt) => ({
    childId,
    squad,
    taskId: "FOC-123",
    sessionId: "11111111-2222-3333-4444-555555555555",
    status: "exited",
    turns: [{ pid: 1 }],
    permissionMode: "bypassPermissions",
    worktree: wt.worktree,
    branch: wt.branch,
    baseRevision: wt.baseRevision,
  });

  writeRegistry(runId, {
    runId,
    children: {
      "dev-1": child("dev-1", "dev", dev),
      "review-1": child("review-1", "review", review),
    },
    rounds: {},
  });
  return { base, repo, runId, ...dev, reviewTree: review.worktree };
}

/** Move the work on, so the next round fingerprints differently. */
function advance(s, name) {
  writeFileSync(join(s.worktree, name), `work ${name}\n`);
  gitIn(s.worktree, "add", "-A");
  gitIn(s.worktree, "commit", "-m", name);
}

const record = (s, extra = []) =>
  parse(verdict(["record", "--run", s.runId, "--child", "review-1", ...extra]), fail);

/**
 * An output file the reviewer produced, under the run's scratch reviews dir —
 * the same place the REVIEW round files go when supervised. `body` empty is
 * how the empty-outputRef case is built.
 */
const scratchEvidence = (s, name, body) => {
  const dir = join(runDir(s.runId), "scratch", "reviews");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, body, "utf8");
  return path;
};
const ranFlag = (s, name = "evidence.txt", body = "12 passed, 0 failed\n") =>
  JSON.stringify({ cmd: "node scripts/supervisor-verdict.test.mjs", exit: 0, outputRef: scratchEvidence(s, name, body) });
const redFirstFlag = (s, name = "red-first.txt", baseExit = 1, candidateExit = 0) =>
  JSON.stringify({
    cmd: "node scripts/supervisor-verdict.test.mjs",
    baseExit,
    candidateExit,
    outputRef: scratchEvidence(s, name, `base exit ${baseExit}, candidate exit ${candidateExit}\n`),
  });

// ── 1. every finding cites something ─────────────────────────────────────────
console.log("\nkażde ustalenie musi coś cytować");

test("an uncited finding is refused by name", () => {
  const s = scenario();
  const out = record(s, ["--verdict", "fail", "--finding", JSON.stringify({ text: "this is wrong" })]);

  assert.equal(out.ok, false);
  assert.match(out.error, /uncited/);
  // Naming WHICH finding is the difference between a usable refusal and one the
  // reviewer has to guess at.
  assert.ok(out.uncited.some((u) => /this is wrong/.test(u)), JSON.stringify(out.uncited));
});

test("placeholder evidence does not count as evidence", () => {
  // A requirement that a dash satisfies is not a requirement. The cheapest way
  // past this gate has to be actually looking.
  const s = scenario();
  for (const cheat of ["-", "n/a", "TODO", "", "see above"]) {
    const out = record(s, [
      "--verdict", "fail",
      "--finding", JSON.stringify({ text: "something", evidence: cheat }),
    ]);
    assert.equal(out.ok, false, `"${cheat}" was accepted as a citation`);
  }
});

test("a cited finding is recorded, with the citation kept verbatim", () => {
  const s = scenario();
  const out = record(s, ["--verdict", "fail", "--finding", CITED, "--failing-test", "suite/a"]);
  assert.equal(out.ok, true, out.error);
  assert.equal(out.findings[0].evidence, "scripts/ledger.mjs:88 resolvePrice");
  assert.equal(out.round, 1);
});

test("an unknown severity is refused rather than silently accepted", () => {
  const s = scenario();
  const out = record(s, [
    "--verdict", "fail",
    "--finding", JSON.stringify({ text: "x", evidence: "scripts/a.mjs:1", severity: "catastrophic" }),
  ]);
  assert.equal(out.ok, false);
  assert.match(out.uncited.join(" "), /severity/);
});

// ── 2. an approve is a claim with a trail ────────────────────────────────────
console.log("\naprobata to twierdzenie z dowodem, nie brak zastrzeżeń");

test("a pass without an AC mapping is refused", () => {
  const s = scenario();
  const out = record(s, ["--verdict", "pass", "--issue-file", issueFile(s.base, 2)]);
  assert.equal(out.ok, false);
  assert.match(out.error, /AC-by-AC/);
});

test("a partial AC mapping is refused, and says how partial", () => {
  // The failure this catches: mapping the two criteria you looked at and
  // approving the third by omission.
  const s = scenario();
  const out = record(s, [
    "--verdict", "pass",
    "--issue-file", issueFile(s.base, 3),
    "--ac", JSON.stringify({ ac: "AC-1", evidence: "scripts/a.test.mjs:10" }),
  ]);
  assert.equal(out.ok, false);
  assert.equal(out.declaredAcs, 3);
  assert.equal(out.mapped, 1);
});

test("a complete AC mapping passes", () => {
  const s = scenario();
  const out = record(s, [
    "--verdict", "pass",
    "--issue-file", issueFile(s.base, 2),
    "--ac", JSON.stringify({ ac: "AC-1", evidence: "scripts/a.test.mjs:10 asserts it" }),
    "--ac", JSON.stringify({ ac: "AC-2", evidence: "scripts/b.test.mjs:44 asserts it" }),
    "--ran", ranFlag(s),
  ]);
  assert.equal(out.ok, true, out.error);
  assert.equal(out.acMapping.length, 2);
});

test("an unreadable issue warns instead of blocking the approve", () => {
  // Linear being down must not stop a legitimate approve — but the record has to
  // say that completeness was never verified, or it claims more than it knows.
  const s = scenario();
  const out = record(s, [
    "--verdict", "pass",
    "--issue-file", join(s.base, "no-such-issue.json"),
    "--ac", JSON.stringify({ ac: "AC-1", evidence: "scripts/a.test.mjs:10 asserts it" }),
    "--ran", ranFlag(s),
  ]);
  assert.equal(out.ok, true, out.error);
  assert.equal(out.declaredAcs, null);
  assert.ok(out.warnings.some((w) => /unverified/.test(w)), JSON.stringify(out.warnings));
});

test("a pass cannot carry a blocking issue finding", () => {
  const s = scenario();
  const out = record(s, [
    "--verdict", "pass",
    "--issue-file", issueFile(s.base, 1),
    "--ac", JSON.stringify({ ac: "AC-1", evidence: "scripts/a.test.mjs:10 asserts it" }),
    "--finding", JSON.stringify({ text: "leaks a handle", evidence: "scripts/a.mjs:9", severity: "issue" }),
  ]);
  assert.equal(out.ok, false);
  assert.match(out.error, /blocking/);
});

// ── 2b. the pass cites a command the reviewer ran itself (FOC-1170) ─────────
console.log("\nevidence as code — a pass cites a command the reviewer ran");

test("a review pass without an evidence run is refused (review-pass-without-evidence-run)", () => {
  // The three false passes of 2026-11-01/02 all accepted output that could not
  // have come out differently. Absence of objections is not evidence, and
  // neither is a diff read; the tool refuses a pass that cites nothing ran.
  const s = scenario();
  const out = record(s, [
    "--verdict", "pass",
    "--issue-file", issueFile(s.base, 1),
    "--ac", JSON.stringify({ ac: "AC-1", evidence: "scripts/a.test.mjs:10 asserts it" }),
  ]);
  assert.equal(out.ok, false);
  assert.match(out.error, /review-pass-without-evidence-run/);
});

test("a --ran whose outputRef does not exist is refused", () => {
  const s = scenario();
  const out = record(s, [
    "--verdict", "pass",
    "--issue-file", issueFile(s.base, 1),
    "--ac", JSON.stringify({ ac: "AC-1", evidence: "scripts/a.test.mjs:10 asserts it" }),
    "--ran", JSON.stringify({ cmd: "node scripts/x.mjs", exit: 0, outputRef: join(runDir(s.runId), "scratch", "no-such-output.txt") }),
  ]);
  assert.equal(out.ok, false);
  assert.match(out.error, /evidence-outputRef-missing/);
});

test("an empty outputRef is refused", () => {
  // A zero-byte file is a citation of nothing — the same cheat as a dash.
  const s = scenario();
  const out = record(s, [
    "--verdict", "pass",
    "--issue-file", issueFile(s.base, 1),
    "--ac", JSON.stringify({ ac: "AC-1", evidence: "scripts/a.test.mjs:10 asserts it" }),
    "--ran", ranFlag(s, "empty.txt", ""),
  ]);
  assert.equal(out.ok, false);
  assert.match(out.error, /evidence-outputRef-empty/);
});

test("an outputRef outside the run's scratch and the reviewer's worktree is refused", () => {
  // DEV's tree is neither: an output the reviewer "ran" in the work tree under
  // review is exactly the evidence nobody can audit after the fact.
  const s = scenario();
  const outside = join(s.worktree, "dev-tree-output.txt");
  writeFileSync(outside, "looks like evidence\n", "utf8");
  const out = record(s, [
    "--verdict", "pass",
    "--issue-file", issueFile(s.base, 1),
    "--ac", JSON.stringify({ ac: "AC-1", evidence: "scripts/a.test.mjs:10 asserts it" }),
    "--ran", JSON.stringify({ cmd: "node scripts/x.mjs", exit: 0, outputRef: outside }),
  ]);
  assert.equal(out.ok, false);
  assert.match(out.error, /evidence-outputRef-outside-run/);
});

test("a valid --ran under the reviewer's worktree is recorded", () => {
  const s = scenario();
  const path = join(s.reviewTree, "lint-output.txt");
  writeFileSync(path, "0 violations\n", "utf8");
  const out = record(s, [
    "--verdict", "pass",
    "--issue-file", issueFile(s.base, 1),
    "--ac", JSON.stringify({ ac: "AC-1", evidence: "scripts/a.test.mjs:10 asserts it" }),
    "--ran", JSON.stringify({ cmd: "node scripts/lint.mjs", exit: 0, outputRef: path }),
  ]);
  assert.equal(out.ok, true, out.error);
  assert.equal(out.ran.length, 1);
  assert.equal(out.ran[0].cmd, "node scripts/lint.mjs");
  assert.equal(out.ran[0].exit, 0);
  assert.equal(out.ran[0].outputRef, path);
});

test("a --ran given as a path relative to the reviewer's worktree resolves", () => {
  // The reviewer runs from its own tree, so a relative citation is the natural
  // shape; resolving it there (not against the tool's cwd) is what keeps the
  // record's absolute path the one the reviewer actually produced.
  const s = scenario();
  writeFileSync(join(s.reviewTree, "test-output.txt"), "all green\n", "utf8");
  const out = record(s, [
    "--verdict", "pass",
    "--issue-file", issueFile(s.base, 1),
    "--ac", JSON.stringify({ ac: "AC-1", evidence: "scripts/a.test.mjs:10 asserts it" }),
    "--ran", JSON.stringify({ cmd: "node scripts/suite.mjs", exit: 0, outputRef: "test-output.txt" }),
  ]);
  assert.equal(out.ok, true, out.error);
  assert.equal(out.ran[0].outputRef, join(s.reviewTree, "test-output.txt"));
});

test("an outputRef whose path casing differs from the root is still contained (win32)", () => {
  // The containment compare used to be case-sensitive: a citation typed with a
  // lowercase drive letter (`c:/users/...`) resolved fine on the
  // case-insensitive win32 filesystem but was refused as outside-run although
  // the file sat inside the reviewer's worktree (review round 1, probe P15).
  // Case-folding is a win32 property — posix paths ARE case-sensitive, so on
  // other platforms this scenario does not exist and the test steps aside.
  if (process.platform !== "win32") return;
  const s = scenario();
  const path = join(s.reviewTree, "cased-output.txt");
  writeFileSync(path, "same file, typed differently\n", "utf8");
  const lowered = path.replace(/^([A-Za-z]):/, (m, d) => `${d.toLowerCase()}:`);
  const out = record(s, [
    "--verdict", "pass",
    "--issue-file", issueFile(s.base, 1),
    "--ac", JSON.stringify({ ac: "AC-1", evidence: "scripts/a.test.mjs:10 asserts it" }),
    "--ran", JSON.stringify({ cmd: "node scripts/lint.mjs", exit: 0, outputRef: lowered }),
  ]);
  assert.equal(out.ok, true, out.error);
  assert.equal(out.ran[0].outputRef, lowered);
});

test("--red-first with equal exits is refused (red-first-not-red)", () => {
  const s = scenario();
  const out = record(s, [
    "--verdict", "pass",
    "--issue-file", issueFile(s.base, 1),
    "--ac", JSON.stringify({ ac: "AC-1", evidence: "scripts/a.test.mjs:10 asserts it" }),
    "--ran", ranFlag(s),
    "--red-first", redFirstFlag(s, "equal.txt", 1, 1),
  ]);
  assert.equal(out.ok, false);
  assert.match(out.error, /red-first-not-red/);
});

test("a malformed --red-first shape is refused", () => {
  const s = scenario();
  const out = record(s, [
    "--verdict", "pass",
    "--issue-file", issueFile(s.base, 1),
    "--ac", JSON.stringify({ ac: "AC-1", evidence: "scripts/a.test.mjs:10 asserts it" }),
    "--ran", ranFlag(s),
    "--red-first", JSON.stringify({ cmd: "node scripts/x.mjs", baseExit: 1 }),
  ]);
  assert.equal(out.ok, false);
  assert.ok(out.problems.some((p) => /--red-first #1/.test(p)), JSON.stringify(out.problems));
});

test("a valid --red-first is stored on the record as redFirst", () => {
  const s = scenario();
  const out = record(s, [
    "--verdict", "pass",
    "--issue-file", issueFile(s.base, 1),
    "--ac", JSON.stringify({ ac: "AC-1", evidence: "scripts/a.test.mjs:10 asserts it" }),
    "--ran", ranFlag(s),
    "--red-first", redFirstFlag(s),
  ]);
  assert.equal(out.ok, true, out.error);
  assert.equal(out.redFirst.length, 1);
  assert.equal(out.redFirst[0].baseExit, 1);
  assert.equal(out.redFirst[0].candidateExit, 0);
  assert.ok(existsSync(out.redFirst[0].outputRef));
});

test("a fail without --ran still records — the gate is a pass gate", () => {
  const s = scenario();
  const out = record(s, ["--verdict", "fail", "--finding", CITED, "--failing-test", "suite/a"]);
  assert.equal(out.ok, true, out.error);
  assert.equal(out.ran, undefined, "no ran key without the flag — the record shape stays as it was");
});

test("a --ran cited on a fail still has to point at real output", () => {
  // The gate protects the pass; the SHAPE check protects every record. Evidence
  // that does not exist is not evidence on a fail either — it just fails
  // softer, so the shape check does not get a verdict-dependent blind spot.
  const s = scenario();
  const out = record(s, [
    "--verdict", "fail",
    "--finding", CITED,
    "--failing-test", "suite/a",
    "--ran", JSON.stringify({ cmd: "node scripts/x.mjs", exit: 1, outputRef: join(runDir(s.runId), "scratch", "never-written.txt") }),
  ]);
  assert.equal(out.ok, false);
  assert.match(out.error, /evidence-outputRef-missing/);
});

// ── 3. the fingerprint ───────────────────────────────────────────────────────
console.log("\nodcisk postępu");

test("the same tree and the same failures fingerprint the same", () => {
  const s = scenario();
  const a = progressFingerprint({ worktree: s.worktree, baseRevision: s.baseRevision, failingTests: ["t1", "t2"] });
  const b = progressFingerprint({ worktree: s.worktree, baseRevision: s.baseRevision, failingTests: ["t2", "t1"] });
  // Order out of a test runner is not stable; an unsorted set would make every
  // round look different for free, which is a cap of infinity in disguise.
  assert.equal(a.combined, b.combined, "failing-test order changed the fingerprint");
});

test("a commit changes it, and so does an untracked file", () => {
  const s = scenario();
  const before = progressFingerprint({ worktree: s.worktree, baseRevision: s.baseRevision });

  advance(s, "one.txt");
  const afterCommit = progressFingerprint({ worktree: s.worktree, baseRevision: s.baseRevision });
  assert.notEqual(afterCommit.combined, before.combined);

  // A diff never shows untracked files. A round whose only output is a new file
  // would otherwise fingerprint as "nothing happened".
  writeFileSync(join(s.worktree, "scratch.txt"), "untracked\n");
  const afterUntracked = progressFingerprint({ worktree: s.worktree, baseRevision: s.baseRevision });
  assert.notEqual(afterUntracked.combined, afterCommit.combined, "an untracked file left no trace");
});

test("the fingerprint measures the WORK, not the reviewer's own tree", () => {
  // The bug this catches shipped and was caught by writing the scenario out:
  // the fingerprint was taken from the recording child's worktree. A REVIEW
  // child's tree does not contain DEV's changes and barely moves, so two
  // consecutive rounds fingerprinted identically and the loop refused at round 2
  // however much DEV had fixed — worse than the counter it replaced, which at
  // least allowed two rounds.
  const s = scenario();
  const first = record(s, ["--verdict", "fail", "--finding", CITED, "--failing-test", "suite/a"]);

  advance(s, "dev-fixed-it.txt"); // DEV makes real progress in its own tree

  const second = record(s, ["--verdict", "fail", "--finding", CITED, "--failing-test", "suite/a"]);
  assert.notEqual(
    second.fingerprint.combined,
    first.fingerprint.combined,
    "DEV committed real work and the fingerprint did not move — it is measuring the wrong tree",
  );
  // And it says whose tree it used, so nobody has to infer it.
  assert.ok(second.warnings.some((w) => /dev-1/.test(w)), JSON.stringify(second.warnings));
});

test("a review with no work to review is refused, not guessed at", () => {
  // Fail-closed: guessing here is how a verdict fingerprints a tree nobody was
  // reviewing, and a wrong fingerprint is silent — it reads as "no progress".
  const { base, repo } = fixtureRepo();
  const review = fixtureWorktree(repo, "orphan-review");
  const runId = fixtureRun();
  writeRegistry(runId, {
    runId,
    rounds: {},
    children: {
      "review-1": {
        childId: "review-1",
        squad: "review",
        taskId: "FOC-999",
        status: "exited",
        turns: [],
        worktree: review.worktree,
        branch: review.branch,
        baseRevision: review.baseRevision,
      },
    },
  });

  const out = parse(
    verdict([
      "record", "--run", runId, "--child", "review-1", "--verdict", "fail",
      "--finding", CITED, "--failing-test", "suite/a",
    ]),
    fail,
  );
  assert.equal(out.ok, false);
  assert.match(out.error, /no dev child/);
  assert.match(out.hint, /--work-child/);
});

test("an unreadable tree is UNKNOWN, not empty", () => {
  // Hashing "" would make two unreadable rounds compare EQUAL, and equal means
  // "no progress, escalate" — the system would escalate on its own inability to
  // look rather than on the child's failure to move.
  const fp = progressFingerprint({ worktree: join(ROOT, "no-such-tree"), baseRevision: "HEAD" });
  assert.equal(fp.combined, null);
  assert.ok(fp.error);
});

// ── 4. the failing-test axis is declared (FOC-220) ──────────────────────────
console.log("\nbrak failing-test to deklaracja, nie domyślenie");

// A fail that is not test-backed — a design failure — is a real category, so
// the gate is escapable; but the escape is an explicit declaration with a
// reason, and it rides the record out. "Declared none, here is why" and "an
// empty axis by omission" must never look the same on disk.
const NO_TESTS_REASON = "design failure: the AC contradicts the spec, no test can be red";

test("a fail with no failing test and no declaration is refused, writing nothing", () => {
  const s = scenario();
  const out = record(s, ["--verdict", "fail", "--finding", CITED]);
  assert.equal(out.ok, false);
  assert.match(out.error, /must declare its failing tests/);
  assert.match(out.hint, /--no-failing-tests/);
  // Refused means refused: a half-written verdict is worse than none.
  assert.equal(existsSync(verdictPath(s.runId, "FOC-123", 1)), false);
});

test("a declared design failure is recorded, and the record carries the declaration", () => {
  const s = scenario();
  const out = record(s, ["--verdict", "fail", "--finding", CITED, "--no-failing-tests", NO_TESTS_REASON]);
  assert.equal(out.ok, true, out.error);

  // The operator's view is the FILE on disk, not the stdout echo.
  const onDisk = JSON.parse(readFileSync(verdictPath(s.runId, "FOC-123", out.round), "utf8"));
  assert.deepEqual(onDisk.fingerprint.failingTests, []);
  // Present BECAUSE it was declared — this field is what "on purpose" looks like.
  assert.equal(onDisk.noFailingTests.reason, NO_TESTS_REASON);
});

test("the declaration without a reason is refused", () => {
  const s = scenario();
  // Flag last in argv: parseArgs turns a bare flag into `true`.
  const out = record(s, ["--verdict", "fail", "--finding", CITED, "--no-failing-tests"]);
  assert.equal(out.ok, false);
  assert.match(out.error, /needs a reason/);
});

test("a placeholder reason is not a declaration", () => {
  // The same cheat the citation gate refuses, refused here too: a requirement
  // a dash satisfies is not a requirement.
  const s = scenario();
  for (const cheat of ["-", "n/a", "none", "  "]) {
    const out = record(s, ["--verdict", "fail", "--finding", CITED, "--no-failing-tests", cheat]);
    assert.equal(out.ok, false, `"${cheat}" was accepted as a reason`);
  }
});

test("the declaration contradicts --failing-test, and that is refused", () => {
  const s = scenario();
  const out = record(s, [
    "--verdict", "fail",
    "--finding", CITED,
    "--failing-test", "suite/a",
    "--no-failing-tests", NO_TESTS_REASON,
  ]);
  assert.equal(out.ok, false);
  assert.match(out.error, /contradict/);
});

test("whitespace-only failing tests do not count as declared", () => {
  // The enforcement normalizes the set exactly as the fingerprint hashes it;
  // otherwise `--failing-test " "` passes a length check and still hashes "".
  const s = scenario();
  const out = record(s, ["--verdict", "fail", "--finding", CITED, "--failing-test", "  "]);
  assert.equal(out.ok, false);
  assert.match(out.error, /must declare its failing tests/);
});

test("the declaration only means something on a fail verdict", () => {
  const s = scenario();
  const out = record(s, [
    "--verdict", "pass",
    "--issue-file", issueFile(s.base, 1),
    "--ac", JSON.stringify({ ac: "AC-1", evidence: "scripts/a.test.mjs:10 asserts it" }),
    "--no-failing-tests", NO_TESTS_REASON,
  ]);
  assert.equal(out.ok, false);
  assert.match(out.error, /only means something on a fail/);
});

// ── 5. what replaced the cap ─────────────────────────────────────────────────
console.log("\nto, co zastąpiło cap");

test("--review-loop without a recorded verdict is refused", () => {
  // Closes the bypass the old counter existed to remove: never record a verdict
  // and you could loop forever.
  const s = scenario();
  const out = parse(followup(s.runId, "review-1", ["--review-loop"]), fail);
  assert.equal(out.ok, false);
  assert.match(out.error, /no REVIEW verdict recorded/);
});

test("a round that reproduced the previous one is refused, showing both", () => {
  const s = scenario();
  advance(s, "attempt.txt");
  record(s, ["--verdict", "fail", "--finding", CITED, "--failing-test", "suite/a"]);
  // Nothing changed in the tree; DEV produced the same work and the same failure.
  record(s, ["--verdict", "fail", "--finding", CITED, "--failing-test", "suite/a"]);

  const out = parse(followup(s.runId, "review-1", ["--review-loop"]), fail);
  assert.equal(out.ok, false);
  assert.match(out.error, /reproduced round/);
  assert.equal(out.fingerprints.previous.combined, out.fingerprints.latest.combined);
  // The operator has to be able to see WHAT stood still, not just be told it did.
  assert.deepEqual(out.failingTests, ["suite/a"]);
  assert.match(out.hint, /change strategy/);
});

test("a pass followed by a fail on the same tree is a new opinion, not a reproduced round", () => {
  // FOC-1146: two verdicts on one tree hash identically — the fingerprint
  // measures the WORK, never the judgment about it. A pass the operator
  // re-records as a fail (same tree, no failing tests either way) carries a
  // new opinion, and the round must open for the rework the fail asks for.
  const s = scenario();
  advance(s, "attempt.txt");
  record(s, [
    "--verdict", "pass",
    "--issue-file", issueFile(s.base, 1),
    "--ac", JSON.stringify({ ac: "AC-1", evidence: "scripts/a.test.mjs:10 asserts it" }),
    "--ran", ranFlag(s),
  ]);
  record(s, ["--verdict", "fail", "--finding", CITED, "--no-failing-tests", NO_TESTS_REASON]);

  const out = parse(followup(s.runId, "review-1", ["--review-loop"]), fail);
  assert.equal(out.ok, true, out.error);
  // `repeated` stays the raw fingerprint comparison: the tree really did not move.
  assert.equal(out.progress.repeated, true);
  assert.equal(out.progress.rounds, 2);
});

test("a repeat with a NEW finding is allowed — the finding is something to act on", () => {
  // Same verdict, same tree, same failing tests — but the reviewer looked
  // harder and found one more thing. Refusing that would refuse the fix.
  const s = scenario();
  advance(s, "attempt.txt");
  record(s, ["--verdict", "fail", "--finding", CITED, "--failing-test", "suite/a"]);
  record(s, [
    "--verdict", "fail",
    "--finding", CITED,
    "--finding", JSON.stringify({ text: "the retry path drops the lock", evidence: "scripts/ledger.mjs:91 retry" }),
    "--failing-test", "suite/a",
  ]);

  const out = parse(followup(s.runId, "review-1", ["--review-loop"]), fail);
  assert.equal(out.ok, true, out.error);
  assert.equal(out.progress.repeated, true);
});

test("a third DIFFERING round is allowed — the old cap of 2 is gone", () => {
  // The case a counter always got wrong: a run that is converging, cut off at
  // the same number as one going in circles.
  const s = scenario();
  for (const n of [1, 2, 3]) {
    advance(s, `round${n}.txt`);
    record(s, ["--verdict", "fail", "--finding", CITED, "--failing-test", `suite/${n}`]);
  }

  const out = parse(followup(s.runId, "review-1", ["--review-loop"]), fail);
  assert.equal(out.ok, true, out.error);
  assert.equal(out.progress.repeated, false);
  assert.equal(out.progress.rounds, 3);
});

test("a plain follow-up does not touch the progress record", () => {
  const s = scenario();
  advance(s, "a.txt");
  record(s, ["--verdict", "fail", "--finding", CITED, "--failing-test", "suite/a"]);

  parse(followup(s.runId, "review-1"), fail);
  assert.deepEqual(readRegistry(s.runId).rounds, {}, "a plain follow-up was counted as a review round");
});

test("recording the same round twice is refused", () => {
  const s = scenario();
  record(s, ["--verdict", "fail", "--finding", CITED, "--failing-test", "suite/a"]);
  const again = record(s, ["--verdict", "fail", "--finding", CITED, "--failing-test", "suite/a", "--round", "1"]);
  assert.equal(again.ok, false);
  assert.match(again.error, /recorded once/);
});

// ── 5. the fail transition (FOC-284) ─────────────────────────────────────────
console.log("\nprzejście powrotu po failu recenzji");

test("a review fail stamps the return flag and transitions In Progress (offline dry-run)", () => {
  const s = scenario();
  const out = record(s, ["--verdict", "fail", "--finding", CITED, "--failing-test", "suite/a"]);
  assert.equal(out.ok, true, out.error);
  assert.equal(out.linearEffects.dryRun, true, "the suite must exercise linear-ops offline, never live");
  assert.equal(out.linearEffects.label.status, "applied");
  assert.match(out.linearEffects.label.detail, /returned-by:review/, out.linearEffects.label.detail);
  assert.equal(out.linearEffects.transition.status, "applied");
  assert.match(out.linearEffects.transition.detail, /In Progress/, out.linearEffects.transition.detail);
  // F2 (round 2): dry-run in a NON-child context is the production shape that
  // once turned a real fail-record into a silent no-op recorded as "applied".
  // The warning names the trigger, so a stale env var is visible, not inferred.
  assert.ok(
    out.warnings.some((w) => /dry-run mode \(trigger: REVIEW_DRY_RUN=1\)/.test(w)),
    JSON.stringify(out.warnings),
  );
  // A dry run exercises the branch; it does not enforce it — no gate.
  assert.equal(out.linearEffects.gate, undefined);
});

test("the verdict file carries the same audit block the CLI printed", () => {
  const s = scenario();
  record(s, ["--verdict", "fail", "--finding", CITED, "--failing-test", "suite/a"]);
  const onDisk = JSON.parse(readFileSync(verdictPath(s.runId, "FOC-123", 1), "utf8"));
  assert.equal(onDisk.linearEffects.label.status, "applied");
  assert.equal(onDisk.linearEffects.transition.status, "applied");
  assert.equal(onDisk.linearEffects.dryRun, true);
  // R2-N1 (round 3): WHICH trigger engaged dry-run is persisted in the record,
  // not left in the unpersisted warnings[] for a later `show` consumer to infer.
  assert.equal(onDisk.linearEffects.dryRunTrigger, "REVIEW_DRY_RUN=1");
});

test("a pass records no side effects at all", () => {
  const s = scenario();
  const out = record(s, [
    "--verdict", "pass",
    "--issue-file", issueFile(s.base, 1),
    "--ac", JSON.stringify({ ac: "AC-1", evidence: "scripts/a.test.mjs:10 asserts it" }),
    "--ran", ranFlag(s),
  ]);
  assert.equal(out.ok, true, out.error);
  assert.equal(out.linearEffects.label.status, "not-applicable");
  assert.equal(out.linearEffects.transition.status, "not-applicable");
  assert.match(out.linearEffects.label.detail, /verdict "pass"/);
});

test("a non-review fail is recorded inert — no test emitter exists (F-05 → FOC-165)", () => {
  const { base, repo } = fixtureRepo();
  const testTree = fixtureWorktree(repo, "foc-123-test");
  const reviewTree = fixtureWorktree(repo, "foc-123-test-review");
  const runId = fixtureRun();
  const child = (childId, squad, wt) => ({
    childId,
    squad,
    taskId: "FOC-123",
    sessionId: "11111111-2222-3333-4444-555555555555",
    status: "exited",
    turns: [{ pid: 1 }],
    permissionMode: "bypassPermissions",
    worktree: wt.worktree,
    branch: wt.branch,
    baseRevision: wt.baseRevision,
  });
  writeRegistry(runId, {
    runId,
    children: {
      "test-1": child("test-1", "test", testTree),
      "review-1": child("review-1", "review", reviewTree),
    },
    rounds: {},
  });

  const out = parse(verdict(["record", "--run", runId, "--child", "test-1", "--verdict", "fail", "--finding", CITED, "--failing-test", "suite/a"]), fail);
  assert.equal(out.ok, true, out.error);
  assert.equal(out.squad, "test");
  assert.equal(out.linearEffects.label.status, "not-applicable");
  assert.match(out.linearEffects.label.detail, /FOC-165/, out.linearEffects.label.detail);
  assert.equal(out.linearEffects.transition.status, "not-applicable");
});

test("inside a spawned child the writes are skipped — and the verdict still lands", () => {
  const s = scenario();
  const out = parse(
    verdict(["record", "--run", s.runId, "--child", "review-1", "--verdict", "fail", "--finding", CITED, "--failing-test", "suite/a"], { LA_SUPERVISOR_CHILD: "review-1" }),
    fail,
  );
  assert.equal(out.ok, true, out.error);
  assert.equal(out.linearEffects.label.status, "skipped");
  assert.equal(out.linearEffects.transition.status, "skipped");
  assert.match(out.linearEffects.label.detail, /FOC-167/);
  assert.ok(out.warnings.some((w) => /skipped inside child/.test(w)), JSON.stringify(out.warnings));
  // The point of warnings-only: the verdict file exists anyway.
  assert.ok(existsSync(verdictPath(s.runId, "FOC-123", 1)));
  // The child guard is the real run's job, not a failed return — no gate (F3).
  assert.equal(out.linearEffects.gate, undefined);
});

test("a linear-ops failure degrades to a warning; the verdict is still written", () => {
  // FOC-777 is not in the offline fixture, so linear-ops exits 1 on both
  // operations — the exact shape of "label not yet bootstrapped in the
  // workspace". Recording must survive it.
  const s = scenario();
  const out = record(s, ["--verdict", "fail", "--finding", CITED, "--failing-test", "suite/a", "--work-child", "dev-1", "--task", "FOC-777"]);
  assert.equal(out.ok, true, out.error);
  assert.equal(out.linearEffects.label.status, "failed");
  assert.equal(out.linearEffects.transition.status, "failed");
  assert.ok(out.warnings.some((w) => /return label failed/.test(w)), JSON.stringify(out.warnings));
  assert.ok(out.warnings.some((w) => /return transition failed/.test(w)), JSON.stringify(out.warnings));
  assert.ok(existsSync(verdictPath(s.runId, "FOC-777", 1)));
  // A dry-run failure is exercise, not enforcement — no gate (F3).
  assert.equal(out.linearEffects.gate, undefined);
});

test("a REAL failed apply raises a pending Supervisor gate naming the manual fix (F3)", () => {
  // No REVIEW_DRY_RUN: the verdict's dry-run is off. Round-3 rework (R2-1): the
  // old FOO_DRY_RUN=1 + unknown-fixture recipe dies WITH the scrub — the var no
  // longer reaches the spawned op by design, so the failure has to come from
  // somewhere else. Recipe (a): both credential vars stripped + LA_LINEAR_NO_ENV_FILE
  // → linear-ops fails fast inside graphql(), before any fetch, on both ops.
  // FOC-777 (unknown on any workspace) keeps the worst case a live READ, never
  // a write, even if credentials ever leaked back in. Failed statuses + real
  // context = the enforcement gate, attached to the DEV child the Supervisor
  // resumes next.
  const s = scenario();
  const out = parse(
    verdict(
      ["record", "--run", s.runId, "--child", "review-1", "--verdict", "fail",
       "--finding", CITED, "--no-failing-tests", "env-scrub test: not a real failing review",
       "--work-child", "dev-1", "--task", "FOC-777"],
      { REVIEW_DRY_RUN: "" },
      { stripCreds: true },
    ),
    fail,
  );
  assert.equal(out.ok, true, out.error);
  assert.equal(out.linearEffects.dryRun, false);
  assert.equal(out.linearEffects.label.status, "failed");
  // The offline-failure signature: the credential refusal is thrown before any
  // network attempt. If this ever stops matching, the op got further than the
  // recipe promised and the test must be treated as broken, not green.
  assert.match(out.linearEffects.label.detail, /LINEAR_API_KEY not set/);
  assert.equal(out.linearEffects.transition.status, "failed");

  const gate = out.linearEffects.gate;
  assert.ok(gate?.emitted, JSON.stringify(out.linearEffects));
  assert.match(gate.gateId, /^gate-dev-1-\d+$/);
  const onDisk = JSON.parse(
    readFileSync(join(gatesDir(s.runId), `${gate.gateId}.json`), "utf8"),
  );
  assert.equal(onDisk.kind, "question");
  assert.equal(onDisk.childId, "dev-1");
  assert.equal(onDisk.status, "pending");
  assert.match(onDisk.summary, /FOC-777/);
  assert.match(onDisk.summary, /round 1/);
  assert.match(onDisk.questions.join(" "), /returned-by:review/);
  assert.match(onDisk.questions.join(" "), /In Progress/);
});

test("a garbage taskId is refused at entry — no record, no ops, no gate (R2-2)", () => {
  // Round-2's N2 refused the OPS but still wrote a verdict keyed by the
  // garbage id — and the gate interpolated it RAW into the paste-able manual
  // fix ("../evil --status Done" smuggles a --status flag into the command a
  // human is told to run; the verdict file name derives from it too). Round 3
  // hoists the shape check to cmdRecord entry: nothing is derived from an
  // invalid id at all. A valid-id end-to-end path stays pinned by every other
  // record test in this suite.
  const s = scenario();
  const r = verdict([
    "record", "--run", s.runId, "--child", "review-1", "--verdict", "fail",
    "--finding", CITED, "--work-child", "dev-1", "--task", "../evil --status Done",
  ]);
  assert.equal(r.status, 1, `expected the failJson refusal exit, got ${r.status}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, false);
  assert.match(out.error, /neither an issue identifier/);
  assert.match(out.error, /\.\.\/evil --status Done/, "the refusal must name the value");
  // Nothing on disk may derive from it: no verdict file, no gate.
  const vDir = verdictsDir(s.runId);
  const verdicts = existsSync(vDir) ? readdirSync(vDir) : [];
  assert.deepEqual(verdicts, [], `no verdict file may exist for a garbage id, got ${JSON.stringify(verdicts)}`);
  const gDir = gatesDir(s.runId);
  const gates = existsSync(gDir) ? readdirSync(gDir) : [];
  assert.deepEqual(gates, [], `no gate may fire for a garbage id, got ${JSON.stringify(gates)}`);
});

test("a non-allowlisted *_DRY_RUN is scrubbed from the spawned op's env (R2-1)", () => {
  // The R2-1 bug verbatim as the counterfactual: FOO_DRY_RUN=1 with a matching
  // .state/mock/foo-task.json used to drive linear-ops' offline path while the
  // record claimed dryRun:false + "applied" — no warning, no gate. Scrubbed,
  // the op runs REAL: credentials stripped + LA_LINEAR_NO_ENV_FILE → graphql()
  // refuses locally before any fetch, both ops fail, and the real-context
  // failure raises the enforcement gate instead of a silent apply. FOC-777
  // keeps the worst case a live READ even if credentials ever leaked back.
  const s = scenario();
  const out = parse(
    verdict(
      ["record", "--run", s.runId, "--child", "review-1", "--verdict", "fail",
       "--finding", CITED, "--no-failing-tests", "env-scrub test: not a real failing review",
       "--work-child", "dev-1", "--task", "FOC-777"],
      { REVIEW_DRY_RUN: "", FOO_DRY_RUN: "1" },
      { stripCreds: true },
    ),
    fail,
  );
  assert.equal(out.ok, true, out.error);
  assert.equal(out.linearEffects.dryRun, false, "the verdict-level dry-run must not engage on a non-allowlisted var");
  // The discriminator: the op ran REAL and failed on the credential refusal —
  // had FOO_DRY_RUN reached it, the fixture would have served an offline apply
  // ("applied", [dry-run] detail, no gate) and this test would fail.
  assert.equal(out.linearEffects.label.status, "failed");
  assert.match(out.linearEffects.label.detail, /LINEAR_API_KEY not set/);
  assert.doesNotMatch(out.linearEffects.label.detail, /\[dry-run/);
  assert.equal(out.linearEffects.transition.status, "failed");
  assert.match(out.linearEffects.transition.detail, /LINEAR_API_KEY not set/);
  const gate = out.linearEffects.gate;
  assert.ok(gate?.emitted, `expected the enforcement gate, got: ${JSON.stringify(out.linearEffects)}`);
  assert.equal(gate.childId, "dev-1");
});

test("a non-allowlisted *_DRY_RUN cannot feed a fake issue into declaredAcs (R2-1, acCount)", () => {
  // The OTHER spawn carrying the same hazard (round-3 extension): acCount runs
  // linear-query, whose detectDryRun honours the same ANY-<NAME>_DRY_RUN=1
  // glob. Unscrubbed, FOO_DRY_RUN=1 + the matching foo-task.json fixture
  // (identifier FOC-777) would hand a FAKE issue description to the AC count —
  // one **Given** → declaredAcs:1 — and a pass mapping "covering" it would be
  // approved as complete against a fabricated criterion, with no warning
  // anywhere. Scrubbed, linear-query runs REAL: credentials stripped +
  // LA_LINEAR_NO_ENV_FILE → graphql() refuses locally before any fetch,
  // acCount reads that refusal as UNKNOWN (null), and the record says
  // completeness unverified. FOC-777 keeps the worst case a live READ even if
  // credentials ever leaked back.
  const s = scenario();
  const out = parse(
    verdict(
      [
        "record", "--run", s.runId, "--child", "review-1", "--verdict", "pass",
        "--work-child", "dev-1", "--task", "FOC-777",
        "--ac", JSON.stringify({ ac: "AC-1", evidence: "scripts/a.test.mjs:10 asserts it" }),
        "--ran", ranFlag(s, "scrub-evidence.txt"),
      ],
      { REVIEW_DRY_RUN: "", FOO_DRY_RUN: "1" },
      { stripCreds: true },
    ),
    fail,
  );
  assert.equal(out.ok, true, out.error);
  assert.equal(out.acMapping.length, 1, "the mapping itself must survive the unread issue");
  // The discriminator: had FOO_DRY_RUN reached linear-query, the fixture would
  // have served its fake description with one **Given** — declaredAcs:1 and NO
  // unverified warning — and this test would fail.
  assert.equal(out.declaredAcs, null);
  assert.ok(
    out.warnings.some((w) => /COMPLETENESS is unverified/.test(w)),
    JSON.stringify(out.warnings),
  );
});

test("a --dry-run flag with no dry-run env names the flag as the trigger (R2-N4)", () => {
  // The last untested branch of the F2 warning (round-2 dev-reported): the
  // flag-only trigger. Hermetic: with no dry-run env, linear-ops' dryRunContext
  // never touches a fixture; the spawned op goes down the REAL path and fails
  // fast on the stripped credentials + LA_LINEAR_NO_ENV_FILE before any network.
  const s = scenario();
  const out = parse(
    verdict(
      ["record", "--run", s.runId, "--child", "review-1", "--verdict", "fail",
       "--finding", CITED, "--no-failing-tests", "env-scrub test: not a real failing review",
       "--dry-run"],
      { REVIEW_DRY_RUN: "" },
      { stripCreds: true },
    ),
    fail,
  );
  assert.equal(out.ok, true, out.error);
  assert.equal(out.linearEffects.dryRun, true);
  assert.equal(out.linearEffects.dryRunTrigger, "--dry-run flag");
  assert.ok(
    out.warnings.some((w) => /dry-run mode \(trigger: --dry-run flag\)/.test(w)),
    JSON.stringify(out.warnings),
  );
  assert.equal(out.linearEffects.label.status, "failed");
  assert.match(out.linearEffects.label.detail, /LINEAR_API_KEY not set/, "the op must fail fast offline, before any live read");
  // A dry run exercises the branch; it does not enforce it — no gate.
  assert.equal(out.linearEffects.gate, undefined);
});

// ── 5b. the gate question is edge-derived (R2-N3) ────────────────────────────
console.log("\nthe gate question is edge-derived (R2-N3)");

test("the gate question carries the edge-resolved flag, whatever the edge says", () => {
  // The flag comes from config/graph.json's edge via returnFlagFor — a FOC-165
  // test-side gate must print the test flag, not a hardcoded review one.
  const q = returnGateQuestion("FOC-165", "returned-by:test", "test-to-dev-return");
  assert.match(q, /--add returned-by:test/);
  assert.match(q, /transition FOC-165 --status "In Progress"/);
});

test("an unresolvable return flag degrades the question instead of inventing one", () => {
  const q = returnGateQuestion("FOC-123", null, "review-to-dev-return");
  assert.doesNotMatch(q, /returned-by:[a-z]+/, "no flag name may be invented when the edge cannot resolve");
  assert.match(q, /review-to-dev-return/, "the broken edge must be named");
  assert.match(q, /not resolvable/);
  assert.match(q, /In Progress/, "the transition half of the manual fix survives");
});

test("a refused re-record of the same round touches no Linear write", () => {
  // The record-once guard fires BEFORE the side effects — re-recording round 1
  // must not stamp the label twice.
  const s = scenario();
  record(s, ["--verdict", "fail", "--finding", CITED, "--failing-test", "suite/a"]);
  const again = record(s, ["--verdict", "fail", "--finding", CITED, "--failing-test", "suite/a", "--round", "1"]);
  assert.equal(again.ok, false);
  assert.match(again.error, /recorded once/);
  assert.equal(again.linearEffects, undefined);
});

// ── 5c. delivery verdicts (FOC-1169) ─────────────────────────────────────────
console.log("\ndelivery verdykty — etykiety bez dziecka");

const deliveryRecord = (s, extra = []) =>
  parse(verdict(["record", "--delivery", "--run", s.runId, "--task", "FOC-123", ...extra]), fail);

// The byte-level pin of a NORMAL record, captured from the pre-FOC-1169 tool
// (the recordedAt, runId and fingerprint hashes are the only dynamic parts —
// normalized to "<ts>", "<run>" and "<hash>"). It is a regression guard, not an
// evidence test: its job is to fail if `--delivery` ever leaks a key into the
// normal shape. A pin that could only have been written one way is honest about
// exactly that.
const GOLDEN_NORMAL_RECORD = `{
  "taskId": "FOC-123",
  "runId": "<run>",
  "childId": "review-1",
  "squad": "review",
  "round": 1,
  "verdict": "fail",
  "findings": [
    {
      "text": "resolvePrice ignores cacheRead",
      "evidence": "scripts/ledger.mjs:88 resolvePrice"
    }
  ],
  "acMapping": [],
  "declaredAcs": 1,
  "fingerprint": {
    "diff": "<hash>",
    "tests": "<hash>",
    "combined": "<hash>",
    "changedFiles": 0,
    "failingTests": [
      "suite/a"
    ],
    "error": null
  },
  "recordedAt": "<ts>",
  "linearEffects": {
    "dryRun": true,
    "dryRunTrigger": "REVIEW_DRY_RUN=1",
    "label": {
      "status": "applied",
      "detail": "[dry-run] would set labels: current=[] planned=[returned-by:review]"
    },
    "transition": {
      "status": "applied",
      "detail": "[dry-run:review] would transition FOC-123 -> In Progress"
    }
  }
}`;

test("the record shape without --delivery is unchanged (byte-level pin)", () => {
  const s = scenario();
  advance(s, "golden.txt");
  record(s, ["--verdict", "fail", "--finding", CITED, "--failing-test", "suite/a"]);
  const rec = JSON.parse(readFileSync(verdictPath(s.runId, "FOC-123", 1), "utf8"));
  const norm = {
    ...rec,
    runId: "<run>",
    recordedAt: "<ts>",
    fingerprint: { ...rec.fingerprint, diff: "<hash>", tests: "<hash>", combined: "<hash>" },
  };
  // Key ORDER is part of the shape: a key appended later shifts every byte after it.
  assert.equal(
    Object.keys(rec).join(","),
    "taskId,runId,childId,squad,round,verdict,findings,acMapping,declaredAcs,fingerprint,recordedAt,linearEffects",
  );
  assert.equal(JSON.stringify(norm, null, 2), GOLDEN_NORMAL_RECORD);
  // The delivery-only keys must not leak into a normal record.
  for (const k of ["recordedBy", "reason", "backfill"]) {
    assert.ok(!(k in rec), `${k} leaked into a record without --delivery`);
  }
});

test("a delivery fail is recorded without a child, fingerprinting the dev child's tree", () => {
  const s = scenario();
  advance(s, "attempt.txt");
  const out = deliveryRecord(s, ["--verdict", "fail", "--reason", "design", "--no-failing-tests", NO_TESTS_REASON]);
  assert.equal(out.ok, true, out.error);
  assert.equal(out.squad, "delivery");
  assert.equal(out.childId, null);
  assert.equal(out.recordedBy, "delivery");
  assert.equal(out.reason, "design");
  assert.equal(out.verdict, "fail");
  assert.equal(out.round, 1);
  // The fingerprint measures DEV's tree — the work being delivered, not a reviewer's.
  const fp = progressFingerprint({ worktree: s.worktree, baseRevision: s.baseRevision, failingTests: [] });
  assert.equal(out.fingerprint.combined, fp.combined);
  // Delivery has no return emitter: the side effects are inert BY SHAPE.
  assert.equal(out.linearEffects.label.status, "not-applicable");
  assert.equal(out.linearEffects.transition.status, "not-applicable");
  const onDisk = JSON.parse(readFileSync(verdictPath(s.runId, "FOC-123", 1), "utf8"));
  assert.equal(onDisk.recordedBy, "delivery");
  assert.equal(onDisk.childId, null);
});

test("a delivery pass needs no reason and no AC mapping", () => {
  const s = scenario();
  advance(s, "attempt.txt");
  const out = deliveryRecord(s, ["--verdict", "pass"]);
  assert.equal(out.ok, true, out.error);
  assert.equal(out.squad, "delivery");
  assert.equal(out.recordedBy, "delivery");
  assert.equal(out.reason, null);
  assert.deepEqual(out.acMapping, []);
  assert.deepEqual(out.findings, []);
  assert.equal(out.ran, undefined, "no ran key without the flag — the delivery record shape stays as it was");
});

test("--ran is refused in --delivery mode — an evidence run is a REVIEW pass requirement", () => {
  // FOC-1170 round 1: the evidence flags parsed and VANISHED in delivery mode —
  // the exact silent-accept class this ticket exists to kill, one layer over.
  const s = scenario();
  advance(s, "attempt.txt");
  const out = deliveryRecord(s, ["--verdict", "pass", "--ran", ranFlag(s, "delivery-evidence.txt")]);
  assert.equal(out.ok, false);
  assert.match(out.error, /--ran is not used in --delivery mode/);
});

test("--red-first is refused in --delivery mode", () => {
  const s = scenario();
  advance(s, "attempt.txt");
  const out = deliveryRecord(s, ["--verdict", "pass", "--red-first", redFirstFlag(s, "delivery-red-first.txt")]);
  assert.equal(out.ok, false);
  assert.match(out.error, /--red-first is not used in --delivery mode/);
});

test("--recorded-at without --backfill is refused", () => {
  const s = scenario();
  const out = deliveryRecord(s, [
    "--verdict", "fail", "--reason", "ci",
    "--recorded-at", "2026-11-01T10:00:00.000Z",
    "--no-failing-tests", NO_TESTS_REASON,
  ]);
  assert.equal(out.ok, false);
  assert.match(out.error, /--recorded-at/);
});

test("--recorded-at with --backfill lands with backfill:true and the given timestamp", () => {
  const s = scenario();
  advance(s, "attempt.txt");
  const out = deliveryRecord(s, [
    "--verdict", "fail", "--reason", "ci", "--failing-test", "suite/ci",
    "--recorded-at", "2026-11-01T10:00:00.000Z", "--backfill",
  ]);
  assert.equal(out.ok, true, out.error);
  assert.equal(out.backfill, true);
  assert.equal(out.recordedAt, "2026-11-01T10:00:00.000Z");
  assert.equal(out.reason, "ci");
});

test("an unknown delivery reason is refused", () => {
  const s = scenario();
  const out = deliveryRecord(s, ["--verdict", "fail", "--reason", "vibes", "--no-failing-tests", NO_TESTS_REASON]);
  assert.equal(out.ok, false);
  assert.match(out.error, /unknown delivery reason "vibes"/);
});

test("a delivery fail without a reason is refused", () => {
  const s = scenario();
  const out = deliveryRecord(s, ["--verdict", "fail", "--no-failing-tests", NO_TESTS_REASON]);
  assert.equal(out.ok, false);
  assert.match(out.error, /--reason/);
});

test("--child is refused in --delivery mode — the record has no child", () => {
  const s = scenario();
  const out = parse(
    verdict(["record", "--delivery", "--run", s.runId, "--task", "FOC-123", "--child", "review-1", "--verdict", "pass"]),
    fail,
  );
  assert.equal(out.ok, false);
  assert.match(out.error, /--child/);
});

test("a delivery fail after a REVIEW pass on the same tree opens the round (FOC-1146 interplay)", () => {
  // The FOC-1146 guard refuses only a repeat of verdict AND findings. A REVIEW
  // pass contradicted by a delivery fail on the same tree is a NEW opinion, so
  // the round it asks for must open — the delivery verdict joins the same
  // roundsFor chain that guard reads.
  const s = scenario();
  advance(s, "attempt.txt");
  record(s, [
    "--verdict", "pass",
    "--issue-file", issueFile(s.base, 1),
    "--ac", JSON.stringify({ ac: "AC-1", evidence: "scripts/a.test.mjs:10 asserts it" }),
    "--ran", ranFlag(s),
  ]);
  const out = deliveryRecord(s, ["--verdict", "fail", "--reason", "design", "--no-failing-tests", NO_TESTS_REASON]);
  assert.equal(out.ok, true, out.error);
  assert.equal(out.round, 2, "the delivery verdict joins the task's round chain");

  const loop = parse(followup(s.runId, "review-1", ["--review-loop"]), fail);
  assert.equal(loop.ok, true, loop.error);
  assert.equal(loop.progress.repeated, true, "the tree did not move — and that is not the blocker");
  assert.equal(loop.progress.rounds, 2);
});

test("--ac is refused in --delivery mode — an AC mapping is a REVIEW approve requirement", () => {
  const s = scenario();
  advance(s, "attempt.txt");
  const out = parse(
    verdict([
      "record", "--delivery", "--run", s.runId, "--task", "FOC-123", "--verdict", "pass",
      "--ac", JSON.stringify({ ac: "AC-1", evidence: "scripts/a.test.mjs:10 asserts it" }),
    ]),
    fail,
  );
  assert.equal(out.ok, false);
  assert.match(out.error, /--ac/);
});

test("--backfill without --recorded-at is refused — a backfill without its when is half a declaration", () => {
  // The AC only forces --recorded-at without --backfill to be refused; the
  // mirror case is a policy call, pinned here: backfill:true with a NOW
  // timestamp would claim to be history without saying when that history was.
  const s = scenario();
  advance(s, "attempt.txt");
  const out = deliveryRecord(s, ["--verdict", "fail", "--reason", "ci", "--failing-test", "suite/ci", "--backfill"]);
  assert.equal(out.ok, false);
  assert.match(out.error, /--recorded-at/);
});

test("a delivery verdict with no dev child in the run is refused, not guessed at", () => {
  const { repo } = fixtureRepo();
  const review = fixtureWorktree(repo, "foc-123-review");
  const runId = fixtureRun();
  writeRegistry(runId, {
    runId,
    children: {
      "review-1": {
        childId: "review-1", squad: "review", taskId: "FOC-123", status: "exited", turns: [],
        worktree: review.worktree, baseRevision: review.baseRevision,
      },
    },
    rounds: {},
  });
  const out = parse(
    verdict([
      "record", "--delivery", "--run", runId, "--task", "FOC-123",
      "--verdict", "fail", "--reason", "design", "--no-failing-tests", NO_TESTS_REASON,
    ]),
    fail,
  );
  assert.equal(out.ok, false);
  assert.match(out.error, /no dev child for FOC-123/);
  // The hint names WHO would be fingerprinted — not a null childId.
  assert.ok(!String(out.hint ?? "").includes("null"), `the hint interpolates a null childId: ${out.hint}`);
});

test("two dev children for the task are ambiguous — --work-child names the tree", () => {
  const { repo } = fixtureRepo();
  const devA = fixtureWorktree(repo, "foc-123-dev-a");
  const devB = fixtureWorktree(repo, "foc-123-dev-b");
  const runId = fixtureRun();
  const child = (id, wt) => ({
    childId: id, squad: "dev", taskId: "FOC-123", status: "exited", turns: [],
    worktree: wt.worktree, baseRevision: wt.baseRevision,
  });
  writeRegistry(runId, { runId, children: { "dev-1": child("dev-1", devA), "dev-2": child("dev-2", devB) }, rounds: {} });
  const mk = (extra = []) =>
    parse(
      verdict([
        "record", "--delivery", "--run", runId, "--task", "FOC-123",
        "--verdict", "fail", "--reason", "design", "--no-failing-tests", NO_TESTS_REASON,
        ...extra,
      ]),
      fail,
    );

  const refused = mk();
  assert.equal(refused.ok, false);
  assert.match(refused.error, /2 dev children carry FOC-123/);

  // Naming one resolves the ambiguity; the record still has no child.
  const named = mk(["--work-child", "dev-2"]);
  assert.equal(named.ok, true, named.error);
  assert.equal(named.childId, null);
});

test("a --recorded-at that Date.parse accepts but ISO does not is refused", () => {
  // Todo-1 round 1: Date.parse("11/01/2026") is readable, but a backdated
  // record whose when is locale-shaped is not a baseline anyone can reproduce.
  const s = scenario();
  advance(s, "attempt.txt");
  const out = deliveryRecord(s, [
    "--verdict", "fail", "--reason", "ci", "--failing-test", "suite/ci",
    "--recorded-at", "11/01/2026", "--backfill",
  ]);
  assert.equal(out.ok, false);
  assert.match(out.error, /--recorded-at/);
});

test("a calendar-overflow --recorded-at is refused, not rolled over to a date the operator never typed", () => {
  // Round 2: Date.parse("2026-02-30T00:00:00Z") is 2026-03-02 — a backfill
  // storing that WHEN would reorder the signal inputs by a stamp nobody
  // typed. Every rollover case refuses; the message names the typed date.
  for (const stamp of ["2026-02-30T00:00:00Z", "2026-02-29T00:00:00Z", "2026-04-31T00:00:00Z"]) {
    const s = scenario();
    advance(s, "attempt.txt");
    const out = deliveryRecord(s, [
      "--verdict", "fail", "--reason", "ci", "--failing-test", "suite/ci",
      "--recorded-at", stamp, "--backfill",
    ]);
    assert.equal(out.ok, false, `${stamp} was accepted`);
    assert.match(out.error, new RegExp(`--recorded-at "${stamp}" is not a real calendar date`));
  }
});

test("a --recorded-at offset is bounded to ISO 8601 (±14:00 exactly), a real offset still records", () => {
  // Round 2 nit 1: [+-]\d{2}:\d{2} read +99:99. Bounded to ±14:00 per ISO.
  // Round 3: the first bound was ±14:59 — (?:0\d|1[0-4]):[0-5]\d admits
  // +14:01..+14:59 and Date.parse does not NaN them, so the gate accepted
  // them end-to-end while every comment claimed ±14:00. Hour 14 admits only
  // :00 now, and the boundary pins below can actually go red.
  for (const stamp of [
    "2026-11-01T10:00:00+99:99",
    "2026-11-01T10:00:00+14:01",
    "2026-11-01T10:00:00+14:59",
  ]) {
    const s = scenario();
    advance(s, "attempt.txt");
    const refused = deliveryRecord(s, [
      "--verdict", "fail", "--reason", "ci", "--failing-test", "suite/ci",
      "--recorded-at", stamp, "--backfill",
    ]);
    assert.equal(refused.ok, false, `${stamp} was accepted`);
    assert.ok(
      refused.error.includes(`--recorded-at "${stamp}" is not an ISO timestamp`),
      refused.error,
    );
  }

  // A +14:00 stamp legitimately shifts the UTC instant (23:30+14:00 is
  // 09:30Z) — the record keeps the parsed instant, not the typed wall clock.
  const s = scenario();
  advance(s, "attempt.txt");
  const out = deliveryRecord(s, [
    "--verdict", "fail", "--reason", "ci", "--failing-test", "suite/ci",
    "--recorded-at", "2026-11-01T23:30:00+14:00", "--backfill",
  ]);
  assert.equal(out.ok, true, out.error);
  assert.equal(out.recordedAt, "2026-11-01T09:30:00.000Z");
});

// ── 5d. backfilled delivery fingerprints name the round they contradict (FOC-1194) ──
console.log("\nbackfill --contradicts-round — osadzony w tej samej twarzy co wyrok");

test("--contradicts-round without --backfill is refused", () => {
  const s = scenario();
  advance(s, "attempt.txt");
  const out = deliveryRecord(s, [
    "--verdict", "fail", "--reason", "ci", "--failing-test", "suite/ci",
    "--contradicts-round", "1",
  ]);
  assert.equal(out.ok, false);
  assert.match(out.error, /--contradicts-round/);
  assert.match(out.error, /--backfill/);
});

test("a backfilled delivery fail with --contradicts-round carries the judged round's fingerprint, source round-N", () => {
  // The motivating case: the dev worktree is GONE by the time the baseline is
  // backfilled (FOC-1147, 1151, 1156, …) — recomputing reads diff: null and the
  // reviewFalsePass pair is uncountable. --contradicts-round N copies the
  // fingerprint round N judged, so the record means "the tree as that round
  // saw it", not "the tree now".
  const s = scenario();
  advance(s, "attempt.txt");
  record(s, [
    "--verdict", "pass",
    "--issue-file", issueFile(s.base, 1),
    "--ac", JSON.stringify({ ac: "AC-1", evidence: "scripts/a.test.mjs:10 asserts it" }),
    "--ran", ranFlag(s),
  ]);
  const passRecord = JSON.parse(readFileSync(verdictPath(s.runId, "FOC-123", 1), "utf8"));
  assert.ok(passRecord.fingerprint.diff, "the review pass round 1 fingerprinted a real tree");

  rmSync(s.worktree, { recursive: true, force: true });

  const out = deliveryRecord(s, [
    "--verdict", "fail", "--reason", "ci", "--failing-test", "suite/ci",
    "--recorded-at", "2026-11-02T10:00:00.000Z", "--backfill",
    "--contradicts-round", "1",
  ]);
  assert.equal(out.ok, true, out.error);
  assert.equal(out.round, 2);
  assert.equal(out.fingerprint.diff, passRecord.fingerprint.diff);
  assert.equal(out.fingerprint.combined, passRecord.fingerprint.combined);
  assert.equal(out.fingerprint.source, "round-1");
  assert.equal(out.fingerprint.error, undefined, "a copied fingerprint is not UNKNOWN");
  // All FIVE identity fields, not a subset: a field dropped from the copy
  // destructure would otherwise pass unnoticed (r2 nit 7).
  assert.equal(out.fingerprint.tests, passRecord.fingerprint.tests);
  assert.equal(out.fingerprint.changedFiles, passRecord.fingerprint.changedFiles);
  assert.deepEqual(out.fingerprint.failingTests, passRecord.fingerprint.failingTests);
  const onDisk = JSON.parse(readFileSync(verdictPath(s.runId, "FOC-123", 2), "utf8"));
  assert.equal(onDisk.fingerprint.source, "round-1");
});

test("backfill without --contradicts-round still recomputes (UNKNOWN warning on a removed tree)", () => {
  // Item 3 of the ticket: without the flag, backfill behaves exactly as today.
  const s = scenario();
  advance(s, "attempt.txt");
  record(s, [
    "--verdict", "pass",
    "--issue-file", issueFile(s.base, 1),
    "--ac", JSON.stringify({ ac: "AC-1", evidence: "scripts/a.test.mjs:10 asserts it" }),
    "--ran", ranFlag(s),
  ]);
  rmSync(s.worktree, { recursive: true, force: true });
  const out = deliveryRecord(s, [
    "--verdict", "fail", "--reason", "ci", "--failing-test", "suite/ci",
    "--recorded-at", "2026-11-02T10:00:00.000Z", "--backfill",
  ]);
  assert.equal(out.ok, true, out.error);
  assert.equal(out.fingerprint.diff, null);
  assert.ok(out.fingerprint.error, "the recomputed fingerprint on a removed tree is UNKNOWN");
  assert.ok(!("source" in out.fingerprint), "no source key on a recomputed fingerprint");
});

test("--contradicts-round naming a round that does not exist is refused", () => {
  const s = scenario();
  advance(s, "attempt.txt");
  const out = deliveryRecord(s, [
    "--verdict", "fail", "--reason", "ci", "--failing-test", "suite/ci",
    "--recorded-at", "2026-11-02T10:00:00.000Z", "--backfill",
    "--contradicts-round", "3",
  ]);
  assert.equal(out.ok, false);
  assert.match(out.error, /round 3 of FOC-123/);
});

test("--contradicts-round naming a round without a diff is refused", () => {
  // A REVIEW round whose fingerprint has no diff (the tree was already
  // unreadable when it was recorded) has nothing to copy, and a null diff
  // would silently match nothing. r2: the named round is a fixture REVIEW
  // record — a delivery round is refused one step earlier (not a REVIEW pass).
  const s = scenario();
  advance(s, "attempt.txt");
  mkdirSync(verdictsDir(s.runId), { recursive: true });
  writeFileSync(
    verdictPath(s.runId, "FOC-123", 1),
    JSON.stringify({
      taskId: "FOC-123",
      runId: s.runId,
      childId: null,
      squad: "review",
      round: 1,
      verdict: "pass",
      findings: [],
      acMapping: [],
      declaredAcs: null,
      fingerprint: { diff: null, tests: null, combined: null, changedFiles: null, failingTests: [], error: "worktree or baseRevision missing" },
      reason: null,
      recordedBy: "review",
      recordedAt: "2026-11-02T09:00:00.000Z",
    }),
  );
  const out = deliveryRecord(s, [
    "--verdict", "fail", "--reason", "ci", "--failing-test", "suite/ci",
    "--recorded-at", "2026-11-02T10:00:00.000Z", "--backfill",
    "--contradicts-round", "1",
  ]);
  assert.equal(out.ok, false);
  assert.match(out.error, /round 1 of FOC-123/);
  // r2 nit 5: the /round 1 of FOC-123/ assertion alone also matches the
  // missing-round message — pin the no-diff branch by its own words.
  assert.match(out.error, /no diff/);
});

test("--contradicts-round with --verdict pass is refused — a pass contradicts nothing", () => {
  // r2, finding 4 — decision: the flag's name is its contract. A delivery PASS
  // does not falsify the round it names; letting it carry the fingerprint would
  // put named delivery passes into the contradicted set with nothing to
  // falsify. Refused like the sibling delivery-mode flags, not silently shaped.
  const s = scenario();
  advance(s, "attempt.txt");
  record(s, [
    "--verdict", "pass",
    "--issue-file", issueFile(s.base, 1),
    "--ac", JSON.stringify({ ac: "AC-1", evidence: "scripts/a.test.mjs:10 asserts it" }),
    "--ran", ranFlag(s),
  ]);
  const out = deliveryRecord(s, [
    "--verdict", "pass",
    "--recorded-at", "2026-11-02T10:00:00.000Z", "--backfill",
    "--contradicts-round", "1",
  ]);
  assert.equal(out.ok, false);
  assert.match(out.error, /--contradicts-round/);
  assert.match(out.error, /pass contradicts nothing|is a fail's provenance/);
});

test("--contradicts-round naming a delivery round is refused — the copy must come from the REVIEW pass", () => {
  // r2, finding 2: the source marker has to RESOLVE to the pass being
  // contradicted (reviewFalsePass pairs review rows by round). A chain of
  // copies — naming a round that is itself a backfilled copy — yields a source
  // no consumer can resolve. A named round that is not a REVIEW record is
  // refused, so every copied source points at a genuine review round.
  const s = scenario();
  advance(s, "attempt.txt");
  record(s, [
    "--verdict", "pass",
    "--issue-file", issueFile(s.base, 1),
    "--ac", JSON.stringify({ ac: "AC-1", evidence: "scripts/a.test.mjs:10 asserts it" }),
    "--ran", ranFlag(s),
  ]);
  const copied = deliveryRecord(s, [
    "--verdict", "fail", "--reason", "ci", "--failing-test", "suite/ci",
    "--recorded-at", "2026-11-02T10:00:00.000Z", "--backfill",
    "--contradicts-round", "1",
  ]);
  assert.equal(copied.ok, true, copied.error);
  assert.equal(copied.round, 2);
  const out = deliveryRecord(s, [
    "--verdict", "fail", "--reason", "design", "--failing-test", "suite/design",
    "--recorded-at", "2026-11-02T11:00:00.000Z", "--backfill",
    "--contradicts-round", "2",
  ]);
  assert.equal(out.ok, false);
  assert.match(out.error, /round 2 of FOC-123/);
  assert.match(out.error, /not a REVIEW/);
});

test("the copy path carries the operator's --failing-test declaration separately", () => {
  // r2, finding 3: the FOC-220-gated declaration has no carrier once the copy
  // overwrites fingerprint.failingTests with round N's — the operator's own
  // words would vanish from the record. Carried as declaredFailingTests (the
  // --no-failing-tests variant was already carried as noFailingTests).
  const s = scenario();
  advance(s, "attempt.txt");
  record(s, [
    "--verdict", "pass",
    "--issue-file", issueFile(s.base, 1),
    "--ac", JSON.stringify({ ac: "AC-1", evidence: "scripts/a.test.mjs:10 asserts it" }),
    "--ran", ranFlag(s),
  ]);
  const out = deliveryRecord(s, [
    "--verdict", "fail", "--reason", "ci", "--failing-test", "suite/ci",
    "--recorded-at", "2026-11-02T10:00:00.000Z", "--backfill",
    "--contradicts-round", "1",
  ]);
  assert.equal(out.ok, true, out.error);
  assert.deepEqual(out.declaredFailingTests, ["suite/ci"], "the declaration survives the copy");
  assert.deepEqual(out.fingerprint.failingTests, [], "the fingerprint's axis is round N's, not the declaration");
  assert.ok(
    out.warnings.some((w) => w.includes("superseded")),
    `the warning must say the declaration is superseded: ${JSON.stringify(out.warnings)}`,
  );
});

// ── 6. the two stall conditions stay distinct ────────────────────────────────
console.log("\ndwa warunki zastoju, osobno raportowane");

test("status reports a repeated fingerprint separately from silence", () => {
  // Silence means no output. A repeated fingerprint means output that changed
  // nothing. They need opposite responses, so collapsing them into one "stuck"
  // flag would leave the lead unable to tell which it is looking at.
  const s = scenario();
  advance(s, "x.txt");
  record(s, ["--verdict", "fail", "--finding", CITED, "--failing-test", "suite/a"]);
  record(s, ["--verdict", "fail", "--finding", CITED, "--failing-test", "suite/a"]);
  followup(s.runId, "review-1", ["--review-loop"]); // refused, but records the comparison

  const reg = readRegistry(s.runId);
  reg.rounds = { "FOC-123": { rounds: 2, latest: "abc", previous: "abc", repeated: true } };
  writeRegistry(s.runId, reg);

  const out = parse(runScript(join(ROOT, "scripts", "supervisor-status.mjs"), ["--run", s.runId]), fail);
  assert.ok(Array.isArray(out.repeatedTasks));
  assert.equal(out.repeatedTasks[0].taskId, "FOC-123");
  // The silence-based field still exists and is a different thing.
  assert.ok("stallSilenceMs" in out, "the wall-clock silence contract disappeared");
});

test("no counter survives anywhere", () => {
  // "Replaced" has to mean replaced. An unused counter left in the schema is
  // worse than none: the next reader takes it for the live control.
  const s = scenario();
  const reg = readRegistry(s.runId);
  assert.equal(reg.reviewLoopCount, undefined, "the registry still carries reviewLoopCount");

  const out = parse(runScript(join(ROOT, "scripts", "supervisor-status.mjs"), ["--run", s.runId]), fail);
  assert.equal(out.reviewLoopCount, undefined, "status still reports reviewLoopCount");
});

summary();
