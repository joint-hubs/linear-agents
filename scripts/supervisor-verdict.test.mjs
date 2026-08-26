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
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  FOLLOWUP,
  ROOT,
  fixtureRepo,
  fixtureRun,
  fixtureWorktree,
  gitIn,
  harness,
  parse,
  runScript,
} from "./supervisor-test-fixtures.mjs";
import { progressFingerprint, readRegistry, writeRegistry } from "./supervisor-lib.mjs";

const { test, fail, summary } = harness();
const VERDICT = join(ROOT, "scripts", "supervisor-verdict.mjs");

const verdict = (args) => runScript(VERDICT, args);
const followup = (runId, childId, extra = []) =>
  runScript(FOLLOWUP, ["--run", runId, "--child", childId, "--prompt", "again", ...extra]);

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
  const out = record(s, ["--verdict", "fail", "--finding", CITED]);
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
    verdict(["record", "--run", runId, "--child", "review-1", "--verdict", "fail", "--finding", CITED]),
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

// ── 4. what replaced the cap ─────────────────────────────────────────────────
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
  record(s, ["--verdict", "fail", "--finding", CITED]);

  parse(followup(s.runId, "review-1"), fail);
  assert.deepEqual(readRegistry(s.runId).rounds, {}, "a plain follow-up was counted as a review round");
});

test("recording the same round twice is refused", () => {
  const s = scenario();
  record(s, ["--verdict", "fail", "--finding", CITED]);
  const again = record(s, ["--verdict", "fail", "--finding", CITED, "--round", "1"]);
  assert.equal(again.ok, false);
  assert.match(again.error, /recorded once/);
});

// ── 5. the two stall conditions stay distinct ────────────────────────────────
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
