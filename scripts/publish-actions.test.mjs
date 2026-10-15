// scripts/publish-actions.test.mjs — FOC-788, slice S1.
//
// Local git fixtures only: a bare "origin" plus a clone and its worktrees, all
// under one mkdtemp — never the network, never the repo's own checkout. Read
// the git seam as the real thing (execFileSync against those fixtures).
//
// Run: node --test scripts/publish-actions.test.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPublishPreview,
  confirmToken,
  deriveChecks,
  diffSummary,
  discoverCheckout,
  verifyConfirmToken,
} from "./publish-actions.mjs";

const git = (args, cwd) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }).replace(/\r\n/g, "\n").trimEnd();

// ── fixture: bare origin + clone + three worktrees ───────────────────────────
//
//   origin.git            bare remote (main at seed)
//   clone/                the shared clone, main checked out
//   la-wt/dev…            branch with one commit  ("dev work")  → carries work
//   la-wt/review…         pin AT the dev head, own branch name   → same sha
//   la-wt/test…           pin at main                           → no work

const ROOT = mkdtempSync(join(tmpdir(), "publish-actions-test-"));
const SEED = join(ROOT, "seed");
const ORIGIN = join(ROOT, "origin.git");
const CLONE = join(ROOT, "clone");
const WT = join(ROOT, "la-wt");

const DEV_BRANCH = "foc-123-dev-abc123def456";
const REVIEW_BRANCH = "foc-123-review-789abc012def";
const TEST_BRANCH = "foc-123-test-fedcba987654";

git(["init", "-b", "main", SEED]);
git(["config", "user.name", "Fixture"], SEED);
git(["config", "user.email", "fixture@example.invalid"], SEED);
writeFileSync(join(SEED, "README.md"), "seed\n");
git(["add", "README.md"], SEED);
git(["commit", "-m", "seed"], SEED);

git(["init", "--bare", ORIGIN]);
git(["symbolic-ref", "HEAD", "refs/heads/main"], ORIGIN);
git(["remote", "add", "origin", ORIGIN], SEED);
git(["push", "origin", "main"], SEED);

git(["clone", ORIGIN, CLONE]);
git(["config", "user.name", "Fixture"], CLONE);
git(["config", "user.email", "fixture@example.invalid"], CLONE);

const MAIN_SHA = git(["rev-parse", "HEAD"], CLONE);

git(["worktree", "add", "-b", DEV_BRANCH, join(WT, DEV_BRANCH), "main"], CLONE);
writeFileSync(join(WT, DEV_BRANCH, "feature.txt"), "feature\n");
git(["add", "feature.txt"], join(WT, DEV_BRANCH));
git(["commit", "-m", "dev work"], join(WT, DEV_BRANCH));
const DEV_HEAD = git(["rev-parse", "HEAD"], join(WT, DEV_BRANCH));

git(["worktree", "add", "-b", REVIEW_BRANCH, join(WT, REVIEW_BRANCH), DEV_HEAD], CLONE);
git(["worktree", "add", "-b", TEST_BRANCH, join(WT, TEST_BRANCH), "main"], CLONE);

const at = (minutesAgo) => new Date(Date.parse("2026-10-15T12:00:00.000Z") - minutesAgo * 60_000).toISOString();

const childFact = (childId, patch = {}) => ({
  childId,
  squad: "dev",
  status: "exited",
  startedAt: at(60),
  branch: DEV_BRANCH,
  worktree: join(WT, DEV_BRANCH),
  baseRevision: MAIN_SHA,
  ...patch,
});

const factsOf = (children, verdicts = []) => ({ taskId: "FOC-123", children, verdicts });

// ── discoverCheckout ─────────────────────────────────────────────────────────

test("discoverCheckout finds the work-carrying dev checkout and never invents a path", () => {
  const r = discoverCheckout(factsOf([childFact("dev-1")]));
  assert.equal(r.ok, true);
  assert.equal(r.checkout.branch, DEV_BRANCH);
  assert.equal(r.checkout.worktree, join(WT, DEV_BRANCH));
  assert.equal(r.checkout.head, DEV_HEAD);
  assert.equal(r.checkout.base, "main");
  assert.equal(r.checkout.baseSha, MAIN_SHA);
  assert.equal(r.checkout.baseRevision, MAIN_SHA);
  assert.equal(r.checkout.remote, "origin");
  assert.equal(r.checkout.repoPath, CLONE);
});

test("a review pin at the same head sha yields to the dev task branch", () => {
  const r = discoverCheckout(
    factsOf([
      childFact("review-2", {
        squad: "review",
        startedAt: at(10),
        branch: REVIEW_BRANCH,
        worktree: join(WT, REVIEW_BRANCH),
      }),
      childFact("dev-1"),
    ]),
  );
  assert.equal(r.ok, true);
  assert.equal(r.checkout.branch, DEV_BRANCH, "the branch the work was authored on wins a head-sha tie");
});

test("a pin at base (no work) never beats the branch that carries the work", () => {
  const r = discoverCheckout(
    factsOf([
      childFact("test-3", {
        squad: "test",
        startedAt: at(5),
        branch: TEST_BRANCH,
        worktree: join(WT, TEST_BRANCH),
      }),
      childFact("dev-1"),
    ]),
  );
  assert.equal(r.ok, true);
  assert.equal(r.checkout.branch, DEV_BRANCH);
  assert.equal(r.checkout.head, DEV_HEAD);
});

test("diverged carriers pick the most recent child — the state of the work", () => {
  const REVIEW2 = "foc-123-review2-111122223333";
  git(["worktree", "add", "-b", REVIEW2, join(WT, REVIEW2), DEV_HEAD], CLONE);
  writeFileSync(join(WT, REVIEW2, "review-note.md"), "note\n");
  git(["add", "review-note.md"], join(WT, REVIEW2));
  git(["commit", "-m", "review note"], join(WT, REVIEW2));
  const review2Head = git(["rev-parse", "HEAD"], join(WT, REVIEW2));

  const r = discoverCheckout(
    factsOf([
      childFact("review-4", {
        squad: "review",
        startedAt: at(1),
        branch: REVIEW2,
        worktree: join(WT, REVIEW2),
      }),
      childFact("dev-1"),
    ]),
  );
  assert.equal(r.ok, true);
  assert.equal(r.checkout.branch, REVIEW2);
  assert.equal(r.checkout.head, review2Head);
});

test("nothing qualifying → no-checkout with a named reason (never a guess)", () => {
  const empty = discoverCheckout(factsOf([]));
  assert.equal(empty.ok, false);
  assert.equal(empty.error, "no-checkout");
  assert.equal(empty.reason, "no-children");

  const gone = discoverCheckout(factsOf([childFact("dev-1", { worktree: join(ROOT, "nope") })]));
  assert.equal(gone.ok, false);
  assert.equal(gone.error, "no-checkout");
  assert.equal(gone.reason, "worktree-missing");

  // The review worktree's HEAD is REVIEW_BRANCH — a child claiming DEV_BRANCH
  // there is a mismatch, not a checkout.
  const mismatch = discoverCheckout(
    factsOf([
      childFact("dev-1", {
        branch: DEV_BRANCH,
        worktree: join(WT, REVIEW_BRANCH),
      }),
    ]),
  );
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.error, "no-checkout");
  assert.equal(mismatch.reason, "head-mismatch");
});

test("the remote URL is credential-stripped before it is ever shown", () => {
  const before = git(["remote", "get-url", "origin"], CLONE);
  git(["remote", "set-url", "origin", "https://fixture:sekret@example.invalid/repo.git"], CLONE);
  try {
    const r = discoverCheckout(factsOf([childFact("dev-1")]));
    assert.equal(r.ok, true);
    assert.equal(r.checkout.remoteUrl, "https://example.invalid/repo.git");
    assert.ok(!JSON.stringify(r).includes("sekret"), "the fixture password leaked into the checkout payload");
  } finally {
    git(["remote", "set-url", "origin", before], CLONE);
  }
});

// ── diffSummary ──────────────────────────────────────────────────────────────

test("diffSummary counts the branch's commits, files and lines — and the dirty worktree", () => {
  const checkout = discoverCheckout(factsOf([childFact("dev-1")])).checkout;
  const clean = diffSummary(checkout);
  assert.equal(clean.commits, 1);
  assert.deepEqual(clean.commitSubjects, ["dev work"]);
  assert.equal(clean.files, 1);
  assert.equal(clean.insertions, 1);
  assert.equal(clean.deletions, 0);
  assert.equal(clean.dirty, false);

  const stray = join(checkout.worktree, "untracked.txt");
  writeFileSync(stray, "not committed\n");
  try {
    const dirty = diffSummary(checkout);
    assert.equal(dirty.dirty, true, "an uncommitted worktree change must show as dirty");
    assert.equal(dirty.commits, 1, "dirty state does not change the committed diff");
  } finally {
    rmSync(stray, { force: true });
  }
});

test("a checkout with nothing beyond base reports commits: 0 — never an invented diff", () => {
  const r = discoverCheckout(factsOf([childFact("test-3", {
    squad: "test",
    branch: TEST_BRANCH,
    worktree: join(WT, TEST_BRANCH),
  })]));
  assert.equal(r.ok, true);
  assert.equal(r.checkout.branch, TEST_BRANCH);
  const diff = diffSummary(r.checkout);
  assert.equal(diff.commits, 0);
  assert.deepEqual(diff.commitSubjects, []);
  assert.equal(diff.files, 0);
});

// ── deriveChecks (AC-2: the failing check is what the dialog must show) ──────

test("deriveChecks is the local verdicts, not GitHub checks", () => {
  const facts = factsOf(
    [childFact("dev-1"), childFact("review-2", { squad: "review", startedAt: at(10) })],
    [
      { round: 1, verdict: "PASS", at: at(30) },
      { round: 2, verdict: "FAIL", at: at(20) },
    ],
  );
  const checks = deriveChecks(facts);
  assert.equal(checks.latest, "FAIL");
  assert.equal(checks.failing.length, 1);
  assert.equal(checks.failing[0].round, 2);
  assert.equal(checks.verdicts.length, 2);
  assert.deepEqual(
    checks.children.map((c) => c.childId).sort(),
    ["dev-1", "review-2"],
  );

  const bare = deriveChecks(factsOf([]));
  assert.equal(bare.latest, null);
  assert.deepEqual(bare.failing, []);
});

// ── confirm token ────────────────────────────────────────────────────────────

test("the confirm token binds action+ticket+branch+head+base and moves with the head", () => {
  const base = { action: "push", ticket: "FOC-123", branch: DEV_BRANCH, head: DEV_HEAD, base: "main" };
  const t1 = confirmToken(base);
  assert.equal(t1, confirmToken(base), "same state → same token");
  assert.equal(t1.length, 64);
  assert.notEqual(t1, confirmToken({ ...base, action: "pr" }));
  assert.notEqual(t1, confirmToken({ ...base, head: MAIN_SHA }), "a moved head changes the token");

  const checkout = { branch: DEV_BRANCH, head: DEV_HEAD, base: "main" };
  assert.equal(verifyConfirmToken({ action: "push", ticket: "FOC-123", checkout, token: t1 }).ok, true);

  const missing = verifyConfirmToken({ action: "push", ticket: "FOC-123", checkout, token: "" });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, "confirmToken (string) is required");

  const stale = verifyConfirmToken({
    action: "push",
    ticket: "FOC-123",
    checkout: { ...checkout, head: MAIN_SHA },
    token: t1,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.error, "stale-preview");
});

// ── buildPublishPreview ──────────────────────────────────────────────────────

test("buildPublishPreview assembles exactly what the confirm dialog shows", () => {
  const preview = buildPublishPreview({
    ticket: "FOC-123",
    action: "push",
    facts: factsOf([childFact("dev-1")], [{ round: 1, verdict: "PASS", at: at(30) }]),
  });
  assert.equal(preview.ok, true);
  assert.equal(preview.ticket, "FOC-123");
  assert.equal(preview.action, "push");
  assert.equal(preview.checkout.branch, DEV_BRANCH);
  assert.equal(preview.diff.commits, 1);
  assert.equal(preview.checks.latest, "PASS");
  assert.equal(
    preview.confirmToken,
    confirmToken({
      action: "push",
      ticket: "FOC-123",
      branch: DEV_BRANCH,
      head: DEV_HEAD,
      base: "main",
    }),
  );

  const bad = buildPublishPreview({ ticket: "FOC-123", action: "merge", facts: factsOf([childFact("dev-1")]) });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "bad-action");

  const none = buildPublishPreview({ ticket: "FOC-123", action: "pr", facts: factsOf([]) });
  assert.equal(none.ok, false);
  assert.equal(none.error, "no-checkout");
  assert.ok(!("checkout" in none), "no-checkout offers no action — there is nothing to confirm");
});
