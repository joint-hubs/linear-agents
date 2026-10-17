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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ROOT,
  baseEnv,
  cleanupLater,
  fixtureRepo,
  fixtureRun,
  fixtureWorktree,
  gitIn,
  harness,
  parse,
  runScript,
} from "./supervisor-test-fixtures.mjs";
import {
  SUPERVISOR_DENY,
  buildChildSettings,
  gatePath,
  readRegistry,
  supervisorStateHome,
  writeRegistry,
} from "./supervisor-lib.mjs";
import { openAgentState, setFact } from "./agent-state.mjs";

const { test, fail, summary } = harness();

const CLEANUP = join(ROOT, "scripts", "supervisor-cleanup.mjs");
const GATE = join(ROOT, "scripts", "supervisor-gate.mjs");

// FOC-256: build the spawn env explicitly instead of inheriting
// LA_SUPERVISOR_CHILD from the ambient process.env. Without this, every TEST
// child needed `env -u LA_SUPERVISOR_CHILD` to work around the identity guard
// — and the suite was green only when the ambient env was clean. Explicit is
// better: set LA_SUPERVISOR_CHILD only when the test says so.
const cleanup = (args, env = {}) => {
  const e = baseEnv(env);
  if (!("LA_SUPERVISOR_CHILD" in env)) delete e.LA_SUPERVISOR_CHILD;
  return spawnSync(process.execPath, [CLEANUP, ...args], { cwd: ROOT, encoding: "utf8", env: e });
};
const gate = (args, env = {}) => {
  const e = baseEnv(env);
  if (!("LA_SUPERVISOR_CHILD" in env)) delete e.LA_SUPERVISOR_CHILD;
  return spawnSync(process.execPath, [GATE, ...args], { cwd: ROOT, encoding: "utf8", env: e });
};

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
    rounds: {},
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
  const proposed = parse(cleanup(["propose", "--run", s.runId, "--child", "dev-1", "--issue-file", s.done]), fail);
  assert.equal(proposed.ok, true, proposed.error);

  // Layer 1: `answer` no longer records it at all — recording prose used to
  // burn the gate (gate-dev-5-2, run a93f) — so the gate stays answerable.
  const refused = parse(gate(["answer", "--run", s.runId, "--gate", proposed.gateId, "--text", "yes, but keep the log file"]), fail);
  assert.equal(refused.ok, false);
  assert.equal(JSON.parse(readFileSync(gatePath(s.runId, proposed.gateId), "utf8")).status, "pending");

  // Layer 2: a record that carries prose anyway (hand-edited, or written before
  // layer 1 existed) is still refused by the script that would act on it.
  const rec = JSON.parse(readFileSync(gatePath(s.runId, proposed.gateId), "utf8"));
  writeFileSync(
    gatePath(s.runId, proposed.gateId),
    JSON.stringify({ ...rec, status: "answered", answer: { text: "yes, but keep the log file", answeredAt: new Date().toISOString() } }),
  );
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

// ── 10. FOC-730: the working-state store closes with the task ────────────────
console.log("\nstan roboczy — archiwum i przycięcie przy zamknięciu zadania");

const seedStore = (dbPath, rows) => {
  const store = openAgentState(dbPath);
  try {
    for (const row of rows) setFact(store, row);
  } finally {
    store.close();
  }
};
const factStatus = (dbPath, namespace, key) => {
  const store = openAgentState(dbPath);
  try {
    return store.db.prepare("SELECT status FROM facts WHERE namespace = ? AND key = ?").get(namespace, key)?.status;
  } finally {
    store.close();
  }
};

test("task close archives the namespace, retires task+turn keys, keeps base and run keys", () => {
  const s = scenario();
  const dbPath = join(s.base, "agent-state.sqlite");
  const childNs = `child:${s.runId}/dev-1`;
  const supNs = `supervisor:${s.runId}`;
  seedStore(dbPath, [
    { namespace: childNs, key: "task_key", value: "v", reason: "task fact" },
    { namespace: childNs, key: "turn_key", value: "v", reason: "turn fact", scope: "turn" },
    { namespace: childNs, key: "anchor", value: "doc", tier: "base", source: "config", evidence: "docs/anchor.md", reason: "seed" },
    { namespace: supNs, key: "sup_task", value: "v", reason: "supervisor task fact" },
    { namespace: supNs, key: "sup_run", value: "v", reason: "supervisor run fact", scope: "run" },
    { namespace: "child:other-run/dev-9", key: "keep_key", value: "v", reason: "other run" },
  ]);

  approved(s);
  const out = parse(cleanup(["remove", "--run", s.runId, "--child", "dev-1", "--issue-file", s.done], { LA_AGENT_STATE_DB: dbPath }), fail);
  assert.equal(out.ok, true, out.error);

  // the archive sits next to the rest of the child's work product
  const archivePath = join(supervisorStateHome(), s.runId, "test-artifacts", "dev-1", "agent-state.json");
  assert.ok(existsSync(archivePath), "no agent-state.json next to the work product");
  const archive = JSON.parse(readFileSync(archivePath, "utf8"));
  assert.equal(archive.namespace, childNs);
  assert.ok(archive.exportedAt);
  assert.deepEqual(
    archive.facts.map((f) => f.key).sort(),
    ["anchor", "task_key", "turn_key"],
    "the archive carries every active AND retired row, base included",
  );
  assert.equal(archive.history.length, 3, "the archive carries the child namespace's op history");

  // task- and turn-scoped agent keys retire; base and run-scoped survive
  assert.equal(factStatus(dbPath, childNs, "task_key"), "retired");
  assert.equal(factStatus(dbPath, childNs, "turn_key"), "retired");
  assert.equal(factStatus(dbPath, childNs, "anchor"), "active");
  // this was the run's last standing child → the supervisor namespace's
  // task-scoped keys retire too, its run-scoped ones stay
  assert.equal(factStatus(dbPath, supNs, "sup_task"), "retired");
  assert.equal(factStatus(dbPath, supNs, "sup_run"), "active");
  assert.equal(factStatus(dbPath, "child:other-run/dev-9", "keep_key"), "active");

  const entry = readRegistry(s.runId).children["dev-1"];
  assert.ok(entry.workingStatePruned?.task, "no workingStatePruned.task on the child entry");
  assert.deepEqual([...entry.workingStatePruned.task.retired].sort(), ["task_key", "turn_key"]);
});

test("the supervisor namespace keeps its task keys while another child's worktree stands", () => {
  const s = scenario();
  const dbPath = join(s.base, "agent-state.sqlite");
  const supNs = `supervisor:${s.runId}`;
  // a second child whose worktree was never removed — dev-1 is not the last
  writeRegistry(s.runId, {
    runId: s.runId,
    children: {
      ...readRegistry(s.runId).children,
      "dev-2": {
        childId: "dev-2",
        squad: "dev",
        taskId: "FOC-123",
        status: "exited",
        turns: [],
        worktree: join(s.base, "elsewhere"),
        allowedPaths: [],
      },
    },
    rounds: {},
  });
  seedStore(dbPath, [
    { namespace: supNs, key: "sup_task", value: "v", reason: "supervisor task fact" },
  ]);

  approved(s);
  const out = parse(cleanup(["remove", "--run", s.runId, "--child", "dev-1", "--issue-file", s.done], { LA_AGENT_STATE_DB: dbPath }), fail);
  assert.equal(out.ok, true, out.error);
  assert.equal(factStatus(dbPath, supNs, "sup_task"), "active", "supervisor task facts died while dev-2's tree stands");
});

test("run retention drops the run's namespaces and reports them in the summary", () => {
  // A temp state home with one ancient run: the prune lane's fixture shape,
  // pinned with utimesSync so the retention window decides, not the clock.
  const home = mkdtempSync(join(tmpdir(), "la-sup-state-"));
  cleanupLater(home);
  const runId = "run-old";
  const art = join(home, runId, "test-artifacts", "dev-1");
  mkdirSync(art, { recursive: true });
  writeFileSync(join(art, "out.txt"), "x");
  const old = (Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000;
  utimesSync(join(home, runId), old, old);
  // A second ancient run with nothing archived: retention selects it, the
  // deletion loop skips it — its working state must survive untouched.
  const skippedId = "run-bare";
  mkdirSync(join(home, skippedId), { recursive: true });
  utimesSync(join(home, skippedId), old, old);

  const dbPath = join(home, "agent-state.sqlite");
  seedStore(dbPath, [
    { namespace: `supervisor:${runId}`, key: "focus", value: "FOC-1", reason: "r" },
    { namespace: `child:${runId}/dev-1`, key: "branch", value: "b", reason: "r" },
    { namespace: `supervisor:${skippedId}`, key: "focus", value: "FOC-2", reason: "r" },
    { namespace: "child:run-new/dev-1", key: "branch", value: "b2", reason: "r" }, // a live run's namespace
  ]);

  const e = baseEnv({ LA_SUPERVISOR_STATE_HOME: home, LA_AGENT_STATE_DB: dbPath });
  delete e.LA_SUPERVISOR_CHILD;
  const res = spawnSync(process.execPath, [CLEANUP, "prune"], { cwd: ROOT, encoding: "utf8", env: e });
  const out = parse(res, fail);
  assert.equal(out.ok, true, out.error);
  assert.deepEqual(
    (out.agentState?.namespaces ?? []).sort(),
    [`child:${runId}/dev-1`, `supervisor:${runId}`],
    `the summary does not name the dropped namespaces: ${JSON.stringify(out.agentState)}`,
  );
  assert.equal(factStatus(dbPath, `supervisor:${runId}`, "focus"), undefined);
  assert.equal(factStatus(dbPath, `child:${runId}/dev-1`, "branch"), undefined);
  assert.equal(factStatus(dbPath, "child:run-new/dev-1", "branch"), "active", "a live run's namespace was dropped");
  assert.equal(
    factStatus(dbPath, `supervisor:${skippedId}`, "focus"),
    "active",
    "a selected-but-skipped run (no artifacts) had its namespaces dropped",
  );
});

summary();
