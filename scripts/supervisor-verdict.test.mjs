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
import { progressFingerprint, readRegistry, writeRegistry } from "./supervisor-lib.mjs";
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
// made to fail fast by stripping both Linear credential vars, so graphql()
// refuses locally before any fetch. linear-ops' loadEnv() backfills an UNSET
// var from .env at the repo root — which is exactly why these tests are
// guarded on HAS_DOTENV: where a checkout carries one, the recipe cannot prove
// the op stays offline and the guarded tests skip with evidence instead of
// risking a live call. (.env is gitignored, so extractions never carry it.)
const verdict = (args, env = {}, opts = {}) => {
  const e = baseEnv({ REVIEW_DRY_RUN: "1", ...env });
  delete e.LA_SUPERVISOR_CHILD;
  if (env.LA_SUPERVISOR_CHILD !== undefined) e.LA_SUPERVISOR_CHILD = env.LA_SUPERVISOR_CHILD;
  if (opts.stripCreds) {
    delete e.LINEAR_API_KEY;
    delete e.LINEAR_API_KEY_PISI;
  }
  return spawnSync(process.execPath, [VERDICT, ...args], { cwd: ROOT, encoding: "utf8", env: e });
};
const followup = (runId, childId, extra = []) =>
  runScript(FOLLOWUP, ["--run", runId, "--child", childId, "--prompt", "again", ...extra]);

const HAS_DOTENV = existsSync(join(ROOT, ".env"));
let skippedGuarded = 0;
const skipGuarded = (name) => {
  skippedGuarded++;
  console.log(`  SKIP ${name} — .env at the repo root would backfill the stripped credentials; the offline-real recipe cannot stay provably offline`);
};

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

// ── 5. the fail transition (FOC-284) ─────────────────────────────────────────
console.log("\nprzejście powrotu po failu recenzji");

test("a review fail stamps the return flag and transitions In Progress (offline dry-run)", () => {
  const s = scenario();
  const out = record(s, ["--verdict", "fail", "--finding", CITED]);
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
  record(s, ["--verdict", "fail", "--finding", CITED]);
  const onDisk = JSON.parse(readFileSync(join(ROOT, ".state", "supervisor", s.runId, "verdicts", "foc-123-round1.json"), "utf8"));
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

  const out = parse(verdict(["record", "--run", runId, "--child", "test-1", "--verdict", "fail", "--finding", CITED]), fail);
  assert.equal(out.ok, true, out.error);
  assert.equal(out.squad, "test");
  assert.equal(out.linearEffects.label.status, "not-applicable");
  assert.match(out.linearEffects.label.detail, /FOC-165/, out.linearEffects.label.detail);
  assert.equal(out.linearEffects.transition.status, "not-applicable");
});

test("inside a spawned child the writes are skipped — and the verdict still lands", () => {
  const s = scenario();
  const out = parse(
    verdict(["record", "--run", s.runId, "--child", "review-1", "--verdict", "fail", "--finding", CITED], { LA_SUPERVISOR_CHILD: "review-1" }),
    fail,
  );
  assert.equal(out.ok, true, out.error);
  assert.equal(out.linearEffects.label.status, "skipped");
  assert.equal(out.linearEffects.transition.status, "skipped");
  assert.match(out.linearEffects.label.detail, /FOC-167/);
  assert.ok(out.warnings.some((w) => /skipped inside child/.test(w)), JSON.stringify(out.warnings));
  // The point of warnings-only: the verdict file exists anyway.
  assert.ok(existsSync(join(ROOT, ".state", "supervisor", s.runId, "verdicts", "foc-123-round1.json")));
  // The child guard is the real run's job, not a failed return — no gate (F3).
  assert.equal(out.linearEffects.gate, undefined);
});

test("a linear-ops failure degrades to a warning; the verdict is still written", () => {
  // FOC-777 is not in the offline fixture, so linear-ops exits 1 on both
  // operations — the exact shape of "label not yet bootstrapped in the
  // workspace". Recording must survive it.
  const s = scenario();
  const out = record(s, ["--verdict", "fail", "--finding", CITED, "--work-child", "dev-1", "--task", "FOC-777"]);
  assert.equal(out.ok, true, out.error);
  assert.equal(out.linearEffects.label.status, "failed");
  assert.equal(out.linearEffects.transition.status, "failed");
  assert.ok(out.warnings.some((w) => /return label failed/.test(w)), JSON.stringify(out.warnings));
  assert.ok(out.warnings.some((w) => /return transition failed/.test(w)), JSON.stringify(out.warnings));
  assert.ok(existsSync(join(ROOT, ".state", "supervisor", s.runId, "verdicts", "foc-777-round1.json")));
  // A dry-run failure is exercise, not enforcement — no gate (F3).
  assert.equal(out.linearEffects.gate, undefined);
});

test("a REAL failed apply raises a pending Supervisor gate naming the manual fix (F3)", () => {
  // No REVIEW_DRY_RUN: the verdict's dry-run is off. Round-3 rework (R2-1): the
  // old FOO_DRY_RUN=1 + unknown-fixture recipe dies WITH the scrub — the var no
  // longer reaches the spawned op by design, so the failure has to come from
  // somewhere else. Recipe (a): both credential vars stripped and no .env at
  // the root (HAS_DOTENV guard) → linear-ops fails fast inside graphql(),
  // before any fetch, on both ops. FOC-777 (unknown on any workspace) keeps the
  // worst case a live READ, never a write, even if credentials ever leaked
  // back in. Failed statuses + real context = the enforcement gate, attached
  // to the DEV child the Supervisor resumes next.
  if (HAS_DOTENV) return skipGuarded("real failed apply raises the enforcement gate (F3)");
  const s = scenario();
  const out = parse(
    verdict(
      ["record", "--run", s.runId, "--child", "review-1", "--verdict", "fail", "--finding", CITED, "--work-child", "dev-1", "--task", "FOC-777"],
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
    readFileSync(join(ROOT, ".state", "supervisor", s.runId, "gates", `${gate.gateId}.json`), "utf8"),
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
  const vDir = join(ROOT, ".state", "supervisor", s.runId, "verdicts");
  const verdicts = existsSync(vDir) ? readdirSync(vDir) : [];
  assert.deepEqual(verdicts, [], `no verdict file may exist for a garbage id, got ${JSON.stringify(verdicts)}`);
  const gDir = join(ROOT, ".state", "supervisor", s.runId, "gates");
  const gates = existsSync(gDir) ? readdirSync(gDir) : [];
  assert.deepEqual(gates, [], `no gate may fire for a garbage id, got ${JSON.stringify(gates)}`);
});

test("a non-allowlisted *_DRY_RUN is scrubbed from the spawned op's env (R2-1)", () => {
  // The R2-1 bug verbatim as the counterfactual: FOO_DRY_RUN=1 with a matching
  // .state/mock/foo-task.json used to drive linear-ops' offline path while the
  // record claimed dryRun:false + "applied" — no warning, no gate. Scrubbed,
  // the op runs REAL: credentials stripped + no .env (guarded) → graphql()
  // refuses locally before any fetch, both ops fail, and the real-context
  // failure raises the enforcement gate instead of a silent apply. FOC-777
  // keeps the worst case a live READ even if credentials ever leaked back.
  if (HAS_DOTENV) return skipGuarded("non-allowlisted *_DRY_RUN scrubbed from the spawn env (R2-1)");
  const s = scenario();
  const out = parse(
    verdict(
      ["record", "--run", s.runId, "--child", "review-1", "--verdict", "fail", "--finding", CITED, "--work-child", "dev-1", "--task", "FOC-777"],
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
  // anywhere. Scrubbed, linear-query runs REAL: credentials stripped + no .env
  // (guarded) → graphql() refuses locally before any fetch, acCount reads that
  // refusal as UNKNOWN (null), and the record says completeness unverified.
  // FOC-777 keeps the worst case a live READ even if credentials ever leaked
  // back in.
  if (HAS_DOTENV) return skipGuarded("non-allowlisted *_DRY_RUN scrubbed from the acCount spawn (R2-1)");
  const s = scenario();
  const out = parse(
    verdict(
      [
        "record", "--run", s.runId, "--child", "review-1", "--verdict", "pass",
        "--work-child", "dev-1", "--task", "FOC-777",
        "--ac", JSON.stringify({ ac: "AC-1", evidence: "scripts/a.test.mjs:10 asserts it" }),
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
  // flag-only trigger. Attempted per the round-2 review's pre-authorization —
  // and hermetic: with no dry-run env, linear-ops' dryRunContext never touches
  // a fixture; the spawned op goes down the REAL path and fails fast on the
  // stripped credentials (no .env, guarded) before any network.
  if (HAS_DOTENV) return skipGuarded("--dry-run flag-only trigger naming (R2-N4)");
  const s = scenario();
  const out = parse(
    verdict(
      ["record", "--run", s.runId, "--child", "review-1", "--verdict", "fail", "--finding", CITED, "--dry-run"],
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
  record(s, ["--verdict", "fail", "--finding", CITED]);
  const again = record(s, ["--verdict", "fail", "--finding", CITED, "--round", "1"]);
  assert.equal(again.ok, false);
  assert.match(again.error, /recorded once/);
  assert.equal(again.linearEffects, undefined);
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
if (skippedGuarded) {
  console.log(`${skippedGuarded} skipped (offline-real pins guarded on .env absence — see SKIP lines above)`);
}
