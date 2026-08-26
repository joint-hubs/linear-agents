// scripts/supervisor-stop.test.mjs — stopping a child must not destroy its work.
//
// The whole point of this script is what it does NOT do. A child is killed
// mid-turn precisely when something has gone wrong, which is exactly when its
// uncommitted work is most likely to be the only copy in existence. So:
//
//   never `git reset`, never `git checkout`, never `git worktree remove`.
//
// ADR-0009 puts worktree cleanup on handoff, never on stop, for that reason.
// Half these tests assert an absence, which is unusual and deliberate: an
// absence is what regresses silently, because nothing fails when a tree
// quietly gets cleaned.
//
// Run: node scripts/supervisor-stop.test.mjs

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  STOP,
  fixtureRepo,
  fixtureRun,
  gitIn,
  harness,
  parse,
  runScript,
  runSpawn,
  waitForStatus,
} from "./_test_supervisor.mjs";
import { readRegistry } from "./supervisor-lib.mjs";

const { test, fail, summary } = harness();
const stop = (runId, childId, extra = []) =>
  runScript(STOP, ["--run", runId, "--child", childId, ...extra]);

// ── 1. a live child ──────────────────────────────────────────────────────────
console.log("\nzatrzymanie żywego dziecka");

test("stops a live child and marks it stopped", () => {
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  const child = parse(runSpawn(runId, repo, [], { MOCK_CLAUDE_HANG_MS: "20000" }), fail);

  const out = parse(stop(runId, child.childId), fail);
  assert.equal(out.ok, true, out.error);
  assert.equal(out.status, "stopped");
  assert.equal(out.stillAlive, false, "the process must actually be gone, not just relabelled");
});

test("the watcher does not relabel a deliberate stop as a crash", () => {
  // A killed child exits non-zero, which looks exactly like a crash. Conflating
  // them would make every operator-requested stop show up as a failure in the
  // digest — and would hide the real crashes among them.
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  const child = parse(runSpawn(runId, repo, [], { MOCK_CLAUDE_HANG_MS: "20000" }), fail);

  stop(runId, child.childId);
  const entry = waitForStatus(runId, child.childId, ["stopped", "crashed", "exited"]);
  assert.equal(entry.status, "stopped", `status was ${entry.status}`);
});

// ── 2. the worktree survives, dirty ──────────────────────────────────────────
console.log("\ndrzewo robocze przeżywa — brudne");

test("a dirty worktree is reported, not cleaned", () => {
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  const child = parse(runSpawn(runId, repo, [], { MOCK_CLAUDE_HANG_MS: "20000" }), fail);

  const scratch = join(child.worktree, "scratch.txt");
  writeFileSync(scratch, "uncommitted work\n");
  writeFileSync(join(child.worktree, "README.md"), "modified by the child\n");

  const out = parse(stop(runId, child.childId), fail);

  // Both kinds of dirt: an untracked file and a modified tracked one.
  const dirt = out.dirty.join(" ");
  assert.match(dirt, /scratch\.txt/, `untracked file missing from the report: ${dirt}`);
  assert.match(dirt, /README\.md/, `modified file missing from the report: ${dirt}`);

  assert.ok(existsSync(scratch), "stop reset the worktree — the only copy of that work is gone");
  assert.equal(readFileSync(scratch, "utf8"), "uncommitted work\n", "the file survived but its content did not");
  assert.ok(existsSync(child.worktree), "stop removed the worktree");
});

test("the worktree is still registered with git after a stop", () => {
  // rmSync on the directory would leave git with a stale administrative entry
  // and the next spawn for that branch would fail. Existence on disk is not the
  // same as git still knowing about it.
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  const child = parse(runSpawn(runId, repo, [], { MOCK_CLAUDE_HANG_MS: "20000" }), fail);

  stop(runId, child.childId);

  const listed = gitIn(repo, "worktree", "list", "--porcelain");
  assert.ok(
    listed.replace(/\\/g, "/").includes(child.worktree.replace(/\\/g, "/")),
    `git no longer lists the worktree:\n${listed}`,
  );
});

test("a clean worktree reports clean rather than nothing", () => {
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  const child = parse(runSpawn(runId, repo, [], { MOCK_CLAUDE_HANG_MS: "20000" }), fail);

  const out = parse(stop(runId, child.childId), fail);
  assert.deepEqual(out.dirty, [], "a clean tree has no dirty paths");
  assert.match(out.cleanup, /clean/i, "the operator needs to be told it was clean, not left guessing");
});

test("the main checkout's HEAD is untouched by a stop", () => {
  // The failure this whole worktree design exists to prevent: a branch switched
  // under a live run. Stop must not move it either.
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  const before = gitIn(repo, "rev-parse", "HEAD");
  const branchBefore = gitIn(repo, "rev-parse", "--abbrev-ref", "HEAD");

  const child = parse(runSpawn(runId, repo, [], { MOCK_CLAUDE_HANG_MS: "20000" }), fail);
  stop(runId, child.childId);

  assert.equal(gitIn(repo, "rev-parse", "HEAD"), before, "HEAD moved");
  assert.equal(gitIn(repo, "rev-parse", "--abbrev-ref", "HEAD"), branchBefore, "branch switched");
});

// ── 3. refusals ──────────────────────────────────────────────────────────────
console.log("\nodmowy");

test("stopping an unknown child names the ones it knows", () => {
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  const child = parse(runSpawn(runId, repo, [], { MOCK_CLAUDE_HANG_MS: "5000" }), fail);

  const out = parse(stop(runId, "ghost-9"), fail);
  assert.equal(out.ok, false);
  assert.ok(Array.isArray(out.known), "the error must list what it knows, or the operator is guessing");
  assert.ok(out.known.includes(child.childId));

  stop(runId, child.childId);
});

test("stopping an unknown run is refused rather than reported empty", () => {
  const out = parse(stop("no-such-run-at-all", "dev-1"), fail);
  assert.equal(out.ok, false);
});

// ── 4. stopping twice ────────────────────────────────────────────────────────
console.log("\nidempotencja");

test("stopping an already-finished child is harmless and still reports the tree", () => {
  // The Supervisor stops a child it believes is stalled; by the time the kill
  // lands the child may have exited on its own. That race must not be an error,
  // and it must still surface what the child left behind.
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  const child = parse(runSpawn(runId, repo, [], { MOCK_CLAUDE_HANG_MS: "0" }), fail);
  waitForStatus(runId, child.childId, ["exited", "crashed", "waiting_gate"]);

  writeFileSync(join(child.worktree, "left-behind.txt"), "x\n");
  const out = parse(stop(runId, child.childId), fail);

  assert.equal(out.ok, true, out.error);
  assert.equal(out.stillAlive, false);
  assert.ok(out.dirty.some((l) => l.includes("left-behind.txt")), JSON.stringify(out.dirty));
  assert.ok(existsSync(child.worktree));
});

// ── 5. the absence that matters ──────────────────────────────────────────────
console.log("\nczego stop NIE robi");

test("supervisor-stop.mjs contains no destructive git verb", () => {
  // Belt and braces alongside the behavioural tests above. Those assert the
  // observable outcome for the cases they cover; this catches a destructive
  // verb added on a path no test happens to exercise — `git clean` in an error
  // branch, say, which would only fire on a machine having a bad day.
  const src = readFileSync(STOP, "utf8");
  const code = src
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
    .join("\n");

  for (const verb of ["worktree\", \"remove", "reset", "checkout", "clean", "restore"]) {
    assert.ok(
      !new RegExp(`"${verb}"`).test(code) && !code.includes(`git ${verb}`),
      `supervisor-stop.mjs looks like it runs \`git ${verb}\` — cleanup belongs on handoff, never on stop (ADR-0009)`,
    );
  }
});

test("the registry keeps the worktree fields after a stop", () => {
  // Whoever picks this up later — the merge node, or Mateusz by hand — needs to
  // know where the work is. Clearing the fields on stop would orphan it.
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  const child = parse(runSpawn(runId, repo, [], { MOCK_CLAUDE_HANG_MS: "20000" }), fail);
  stop(runId, child.childId);

  const entry = readRegistry(runId).children[child.childId];
  assert.equal(entry.worktree, child.worktree);
  assert.equal(entry.branch, child.branch);
  assert.ok(entry.baseRevision, "baseRevision is how you diff what the child did");
});

summary();
