// scripts/supervisor-cleanup.test.mjs — the only script allowed to delete a checkout.
//
// supervisor-stop.test.mjs asserts that stop never removes a worktree. This is
// the other half: the one place that CAN, and every reason it must not.
//
// Two keys, and the tests are mostly about turning one of them and confirming
// nothing happens. That asymmetry is the point — a cleanup that runs when it
// should not is unrecoverable, and a cleanup that refuses when it could have run
// costs 4.8 MB of disk.
//
// Run: node scripts/supervisor-cleanup.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
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
import { SUPERVISOR_DENY, buildChildSettings, readRegistry, writeRegistry } from "./supervisor-lib.mjs";

const { test, fail, summary } = harness();

const CLEANUP = join(ROOT, "scripts", "supervisor-cleanup.mjs");
const GATE = join(ROOT, "scripts", "supervisor-gate.mjs");

const cleanup = (args, env = {}) => runScript(CLEANUP, args, env);
const gate = (args) => runScript(GATE, args);

// ── issue fixtures: the TEST key, offline ────────────────────────────────────
// --issue-file is the same seam supervisor-triage.mjs uses. There is no
// --test-approved flag anywhere in the script, deliberately: a key you can turn
// with a flag is not a key, and a test that used one would be proving nothing.

let issueCounter = 0;
function issueFile(dir, stateName, stateType) {
  const path = join(dir, `issue-${issueCounter++}.json`);
  writeFileSync(
    path,
    JSON.stringify({ identifier: "FOC-123", state: { name: stateName, type: stateType } }),
  );
  return path;
}

/**
 * A run + a real worktree + a registry entry pointing at it, which is the state
 * every one of these tests starts from.
 */
function scenario({ status = "exited", dirty = null } = {}) {
  const { base, repo } = fixtureRepo();
  const wt = fixtureWorktree(repo);
  const runId = fixtureRun();

  writeRegistry(runId, {
    runId,
    children: {
      "dev-1": {
        childId: "dev-1",
        squad: "dev",
        taskId: "FOC-123",
        sessionId: "11111111-2222-3333-4444-555555555555",
        status,
        turns: [{ pid: 1 }],
        worktree: wt.worktree,
        branch: wt.branch,
        baseRevision: wt.baseRevision,
        allowedPaths: [],
      },
    },
    reviewLoopCount: {},
  });

  if (dirty) writeFileSync(join(wt.worktree, dirty), "uncommitted\n");

  return { base, repo, runId, ...wt, done: issueFile(base, "Done", "completed") };
}

/** propose → answer, the happy path other tests start from. */
function approved(s, answer = "yes") {
  const out = parse(cleanup(["propose", "--run", s.runId, "--child", "dev-1", "--issue-file", s.done]), fail);
  assert.equal(out.ok, true, out.error);
  parse(gate(["answer", "--run", s.runId, "--gate", out.gateId, "--text", answer]), fail);
  return out.gateId;
}

// ── 1. identity: a child may never reclaim its own tree ──────────────────────
console.log("\ntożsamość — dziecko nie sprząta po sobie");

test("every subcommand refuses when LA_SUPERVISOR_CHILD is set", () => {
  // The env var supervisor-spawn.mjs sets for children. `list` is included on
  // purpose: a refusal that depends on which subcommand was typed has a hole
  // in it, and enumerating reclaimable trees is not a child's business either.
  for (const cmd of ["list", "propose", "remove"]) {
    const out = parse(cleanup([cmd, "--run", "any", "--child", "dev-1"], { LA_SUPERVISOR_CHILD: "dev-1" }), fail);
    assert.equal(out.ok, false, `${cmd} did not refuse`);
    assert.match(out.error, /LA_SUPERVISOR_CHILD/, `${cmd}: ${out.error}`);
  }
});

test("the identity check runs before any approval is read", () => {
  // A child with both keys legitimately turned must still be refused. If the
  // order were the other way round, the guard would be advisory.
  const s = scenario();
  approved(s);
  const out = parse(
    cleanup(["remove", "--run", s.runId, "--child", "dev-1", "--issue-file", s.done], { LA_SUPERVISOR_CHILD: "dev-1" }),
    fail,
  );
  assert.equal(out.ok, false);
  assert.match(out.error, /LA_SUPERVISOR_CHILD/);
  assert.ok(existsSync(s.worktree), "the tree was removed despite the identity refusal");
});

test("the harness deny list blocks the direct call too", () => {
  // Belt and braces alongside the identity check: SUPERVISOR_DENY stops a child
  // shelling out to git instead of going through this script. Same caveat as the
  // push rules — this catches the accidental call, not the determined one.
  for (const rule of ["Bash(git worktree remove:*)", "Bash(git worktree prune:*)"]) {
    assert.ok(SUPERVISOR_DENY.includes(rule), `SUPERVISOR_DENY lost ${rule}`);
    assert.ok(
      buildChildSettings({}).permissions.deny.includes(rule),
      `${rule} never reaches the generated child-settings.json`,
    );
  }
});

// ── 2. key 1: the TEST squad ─────────────────────────────────────────────────
console.log("\nklucz 1 — akceptacja TEST");

test("propose refuses an unfinished task and emits NO gate", () => {
  // Fail-closed and silent. Asking Mateusz to approve cleanup of work TEST has
  // not blessed teaches him to approve these without reading them, which is how
  // the second key stops being a key.
  const s = scenario();
  const wip = issueFile(s.base, "In Progress", "started");

  const out = parse(cleanup(["propose", "--run", s.runId, "--child", "dev-1", "--issue-file", wip]), fail);
  assert.equal(out.ok, false);
  assert.match(out.error, /TEST has not approved/);
  assert.match(out.error, /In Progress/, "the refusal must name the state it saw");
  assert.equal(out.noGateEmitted, true);

  const gates = parse(gate(["list", "--run", s.runId]), fail);
  assert.equal(gates.gates.length, 0, `a gate was emitted anyway: ${JSON.stringify(gates.gates)}`);
});

test("remove re-checks the TEST key rather than trusting the gate", () => {
  // The gap this closes: propose sees Done, Mateusz approves, and the issue is
  // dragged back to In Progress before removal. The approval was for finished
  // work; the work is no longer finished.
  const s = scenario();
  approved(s);
  const regressed = issueFile(s.base, "In Progress", "started");

  const out = parse(cleanup(["remove", "--run", s.runId, "--child", "dev-1", "--issue-file", regressed]), fail);
  assert.equal(out.ok, false);
  assert.match(out.error, /TEST has not approved/);
  assert.ok(existsSync(s.worktree));
});

// ── 3. key 2: Mateusz ────────────────────────────────────────────────────────
console.log("\nklucz 2 — zgoda Mateusza");

test("propose writes a pending gate carrying the facts, not a summary of them", () => {
  const s = scenario({ dirty: "scratch.txt" });
  const out = parse(cleanup(["propose", "--run", s.runId, "--child", "dev-1", "--issue-file", s.done]), fail);
  assert.equal(out.ok, true, out.error);

  const gates = parse(gate(["list", "--run", s.runId, "--status", "pending"]), fail);
  assert.equal(gates.gates.length, 1);
  const g = gates.gates[0];
  assert.equal(g.kind, "cleanup-approval");
  assert.equal(g.childId, "dev-1");

  assert.equal(g.facts.worktree, s.worktree);
  assert.equal(g.facts.branch, s.branch);
  assert.equal(g.facts.head, gitIn(s.worktree, "rev-parse", "HEAD"));
  assert.ok(g.facts.dirty.some((l) => l.includes("scratch.txt")), JSON.stringify(g.facts.dirty));
  assert.ok(g.facts.fingerprint, "no fingerprint — nothing to match the tree against later");

  // The question has to state the loss. An approval given without the file list
  // in front of him is not the approval this gate claims to be.
  assert.match(g.questions.join("\n"), /scratch\.txt/);
});

test("remove refuses while the gate is still pending", () => {
  const s = scenario();
  const out0 = parse(cleanup(["propose", "--run", s.runId, "--child", "dev-1", "--issue-file", s.done]), fail);

  const out = parse(cleanup(["remove", "--run", s.runId, "--child", "dev-1", "--issue-file", s.done]), fail);
  assert.equal(out.ok, false);
  assert.match(out.error, /pending/);
  assert.equal(out.gateId, out0.gateId, "the refusal must name the gate that is waiting");
  assert.ok(existsSync(s.worktree));
});

test("proposing twice for an unchanged tree is refused, but a moved tree gets a new gate", () => {
  // Otherwise a Supervisor in a loop stacks five identical questions in his
  // queue, all of them permanently pending — a gate is answered once.
  const s = scenario();
  const first = parse(cleanup(["propose", "--run", s.runId, "--child", "dev-1", "--issue-file", s.done]), fail);

  const again = parse(cleanup(["propose", "--run", s.runId, "--child", "dev-1", "--issue-file", s.done]), fail);
  assert.equal(again.ok, false);
  assert.equal(again.gateId, first.gateId, "the refusal must point at the gate already waiting");

  // A tree that moved is a different question, so it does get asked.
  writeFileSync(join(s.worktree, "new-work.txt"), "changed\n");
  const third = parse(cleanup(["propose", "--run", s.runId, "--child", "dev-1", "--issue-file", s.done]), fail);
  assert.equal(third.ok, true, third.error);
  assert.notEqual(third.gateId, first.gateId);
});

test("remove refuses when no gate was ever emitted", () => {
  const s = scenario();
  const out = parse(cleanup(["remove", "--run", s.runId, "--child", "dev-1", "--issue-file", s.done]), fail);
  assert.equal(out.ok, false);
  assert.match(out.error, /has not been asked/);
});

test('"yes, but keep the log file" is a conversation, not an approval', () => {
  // The failure mode worth refusing: reading the "yes" out of a qualified answer
  // and deleting the log file anyway would be answering a question nobody asked.
  const s = scenario({ dirty: "build.log" });
  approved(s, "yes, but keep the log file");

  const out = parse(cleanup(["remove", "--run", s.runId, "--child", "dev-1", "--issue-file", s.done]), fail);
  assert.equal(out.ok, false);
  assert.match(out.error, /not an unambiguous approval/);
  assert.ok(Array.isArray(out.accepted), "the refusal must list what it does accept, or he is guessing");
  assert.ok(existsSync(join(s.worktree, "build.log")));
});

test("an explicit no says so, instead of being lumped in with malformed answers", () => {
  const s = scenario();
  approved(s, "nie");

  const out = parse(cleanup(["remove", "--run", s.runId, "--child", "dev-1", "--issue-file", s.done]), fail);
  assert.equal(out.ok, false);
  assert.match(out.error, /said no/);
  assert.ok(existsSync(s.worktree));
});

test("the affirmative set takes his actual words, in either language", () => {
  for (const word of ["yes", "tak", "approve", "Approved.", "  ZATWIERDZAM  "]) {
    const s = scenario();
    approved(s, word);
    const out = parse(cleanup(["remove", "--run", s.runId, "--child", "dev-1", "--issue-file", s.done]), fail);
    assert.equal(out.ok, true, `"${word}" was not accepted: ${out.error}`);
  }
});

// ── 4. the fingerprint: what the yes actually covered ────────────────────────
console.log("\nodcisk drzewa — zgoda dotyczy tego, co pokazano");

test("a commit made after the approval invalidates it", () => {
  const s = scenario();
  approved(s);

  writeFileSync(join(s.worktree, "late.txt"), "after the yes\n");
  gitIn(s.worktree, "add", "-A");
  gitIn(s.worktree, "commit", "-m", "late work");

  const out = parse(cleanup(["remove", "--run", s.runId, "--child", "dev-1", "--issue-file", s.done]), fail);
  assert.equal(out.ok, false);
  assert.match(out.error, /changed since gate/);
  assert.notEqual(out.approved.head, out.now.head, "the report must show both heads");
  assert.ok(existsSync(s.worktree));
});

test("new uncommitted work after the approval invalidates it", () => {
  // The one that matters most: removal destroys uncommitted work, so a dirty set
  // that grew since the yes is work nobody was shown and nobody approved losing.
  const s = scenario();
  approved(s);

  writeFileSync(join(s.worktree, "surprise.txt"), "written after he said yes\n");

  const out = parse(cleanup(["remove", "--run", s.runId, "--child", "dev-1", "--issue-file", s.done]), fail);
  assert.equal(out.ok, false);
  assert.match(out.error, /changed since gate/);
  assert.ok(out.now.dirty.some((l) => l.includes("surprise.txt")), JSON.stringify(out.now.dirty));
  assert.ok(existsSync(join(s.worktree, "surprise.txt")));
});

test("an unchanged tree keeps its approval valid", () => {
  // The other side of the same invariant: re-reading an untouched tree must
  // produce the same fingerprint, or every approval would expire on arrival.
  const s = scenario({ dirty: "scratch.txt" });
  approved(s);

  const out = parse(cleanup(["remove", "--run", s.runId, "--child", "dev-1", "--issue-file", s.done]), fail);
  assert.equal(out.ok, true, out.error);
});

// ── 5. removal ───────────────────────────────────────────────────────────────
console.log("\nusunięcie");

test("both keys turned removes the checkout from disk and from git", () => {
  const s = scenario();
  approved(s);

  const out = parse(cleanup(["remove", "--run", s.runId, "--child", "dev-1", "--issue-file", s.done]), fail);
  assert.equal(out.ok, true, out.error);
  assert.equal(out.removed, s.worktree);
  assert.ok(!existsSync(s.worktree), "the directory is still there");

  // Not the same assertion. rmSync would satisfy the first and leave git with a
  // stale administrative entry that breaks the next spawn of this branch.
  const listed = gitIn(s.repo, "worktree", "list", "--porcelain").replace(/\\/g, "/");
  assert.ok(!listed.includes(s.worktree.replace(/\\/g, "/")), `git still lists it:\n${listed}`);
});

test("the branch and its commits survive the removal", () => {
  // What removal actually costs, stated as a test: `git worktree remove` deletes
  // a checkout, not history. Only uncommitted work dies.
  const s = scenario();
  writeFileSync(join(s.worktree, "work.txt"), "committed work\n");
  gitIn(s.worktree, "add", "-A");
  gitIn(s.worktree, "commit", "-m", "real work");
  const sha = gitIn(s.worktree, "rev-parse", "HEAD");

  approved(s);
  const out = parse(cleanup(["remove", "--run", s.runId, "--child", "dev-1", "--issue-file", s.done]), fail);
  assert.equal(out.ok, true, out.error);

  assert.equal(gitIn(s.repo, "rev-parse", s.branch), sha, "the branch moved or vanished");
  assert.match(out.branchNote, /untouched/);
  assert.equal(
    gitIn(s.repo, "show", `${sha}:work.txt`),
    "committed work",
    "the commit is no longer readable from the main checkout",
  );
});

test("a dirty tree is removed only because those exact paths were approved", () => {
  const s = scenario({ dirty: "scratch.txt" });
  approved(s);

  const out = parse(cleanup(["remove", "--run", s.runId, "--child", "dev-1", "--issue-file", s.done]), fail);
  assert.equal(out.ok, true, out.error);
  assert.equal(out.forced, true, "git refuses a dirty tree without --force; the report must admit using it");
  assert.ok(out.destroyed.some((l) => l.includes("scratch.txt")), JSON.stringify(out.destroyed));
  assert.ok(!existsSync(s.worktree));
});

test("the report names both keys it turned", () => {
  // An audit trail that says "removed" and nothing else cannot be checked later.
  const s = scenario();
  const gateId = approved(s);
  const out = parse(cleanup(["remove", "--run", s.runId, "--child", "dev-1", "--issue-file", s.done]), fail);

  assert.match(out.keys.test, /Done/);
  assert.match(out.keys.human, new RegExp(gateId));
  assert.ok(out.keys.fingerprint);
});

// ── 6. refusals that have nothing to do with approval ────────────────────────
console.log("\npozostałe odmowy");

test("a live child's worktree is never reclaimable", () => {
  const s = scenario({ status: "running" });
  const out = parse(cleanup(["remove", "--run", s.runId, "--child", "dev-1", "--issue-file", s.done]), fail);
  assert.equal(out.ok, false);
  assert.match(out.error, /running/);
  assert.ok(existsSync(s.worktree));
});

test("remove refuses to delete the directory it is standing in", () => {
  // Half-succeeds otherwise: git left with a stale entry, and this process's own
  // cwd a path that no longer exists.
  const s = scenario();
  approved(s);

  const res = spawnSync(
    process.execPath,
    [CLEANUP, "remove", "--run", s.runId, "--child", "dev-1", "--issue-file", s.done, "--repo", s.repo],
    { cwd: s.worktree, encoding: "utf8", env: baseEnv() },
  );
  const out = parse(res, fail);
  assert.equal(out.ok, false);
  assert.match(out.error, /inside the worktree/);
  assert.ok(existsSync(s.worktree));
});

test("an unknown child names the ones it knows", () => {
  const s = scenario();
  const out = parse(cleanup(["remove", "--run", s.runId, "--child", "ghost-9"]), fail);
  assert.equal(out.ok, false);
  assert.ok(out.known.includes("dev-1"));
});

// ── 7. idempotence ───────────────────────────────────────────────────────────
console.log("\nidempotencja");

test("removing an already-removed tree is a no-op, and needs no approval", () => {
  // No key is required here because the thing the keys protect — an existing
  // checkout with possibly-uncommitted work in it — is not there to protect.
  // Requiring approval to report "already gone" would be theatre.
  const s = scenario();
  approved(s);
  parse(cleanup(["remove", "--run", s.runId, "--child", "dev-1", "--issue-file", s.done]), fail);

  const again = parse(cleanup(["remove", "--run", s.runId, "--child", "dev-1"]), fail);
  assert.equal(again.ok, true, again.error);
  assert.equal(again.alreadyRemoved, true);
});

test("the registry keeps the worktree fields and records when it went", () => {
  // Whoever picks this up later needs to know which branch holds the work. The
  // branch outlives the checkout, so the record of it must too.
  const s = scenario();
  approved(s);
  parse(cleanup(["remove", "--run", s.runId, "--child", "dev-1", "--issue-file", s.done]), fail);

  const entry = readRegistry(s.runId).children["dev-1"];
  assert.equal(entry.worktree, s.worktree, "the path was cleared — the work is now unfindable");
  assert.equal(entry.branch, s.branch);
  assert.equal(entry.baseRevision, s.baseRevision);
  assert.ok(entry.worktreeRemovedAt, "nothing records that the checkout is gone");
});

// ── 8. list ──────────────────────────────────────────────────────────────────
console.log("\nlist");

test("list names the missing key instead of a bare yes/no", () => {
  const s = scenario();
  const before = parse(cleanup(["list", "--run", s.runId]), fail);
  const row = before.children.find((c) => c.childId === "dev-1");
  assert.equal(row.present, true);
  assert.ok(row.localBlockers.some((b) => /propose/.test(b)), JSON.stringify(row.localBlockers));

  // Offline by contract — the TEST key needs Linear, so it is reported as
  // unchecked rather than guessed. `list` runs on every digest; it must be cheap.
  assert.match(row.testApproval, /unchecked/);

  approved(s);
  const after = parse(cleanup(["list", "--run", s.runId]), fail);
  const row2 = after.children.find((c) => c.childId === "dev-1");
  assert.deepEqual(row2.localBlockers, []);

  // The name is the assertion: empty means "nothing visible from disk", not
  // "reclaimable". The TEST key still says unchecked right beside it.
  assert.equal(row2.blockers, undefined, "a field called `blockers` reading empty would claim the opposite");
  assert.match(row2.testApproval, /unchecked/);
});

// ── 9. the absence, on the other side ────────────────────────────────────────
console.log("\ngdzie NIE wolno usuwać drzewa");

test("supervisor-cleanup.mjs is the only script that runs `git worktree remove`", () => {
  // Companion to the same check in supervisor-stop.test.mjs. That one guards one
  // script; this one guards the rule — a removal added to spawn, followup or the
  // watcher would bypass both keys entirely, and nothing would fail.
  const others = ["supervisor-spawn.mjs", "supervisor-stop.mjs", "supervisor-watch.mjs", "supervisor-followup.mjs", "supervisor-lib.mjs"];
  for (const file of others) {
    const src = readFileSync(join(ROOT, "scripts", file), "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .join("\n")
      // `"Bash(git worktree remove:*)"` in SUPERVISOR_DENY is the exact opposite
      // of running it, and a check that cannot tell the rule from the act would
      // fail on the fix for the thing it is checking.
      .replace(/"Bash\([^"]*\)"/g, '""');
    assert.ok(
      !/"worktree",\s*"remove"/.test(src) && !/git worktree remove/.test(src),
      `${file} looks like it removes a worktree — that belongs behind the two keys in supervisor-cleanup.mjs`,
    );
  }
});

summary();
