// scripts/supervisor-merge.test.mjs — two green patches are not one green patch.
//
// The premise under test is a single sentence: a candidate green in isolation is
// never sufficient. So the load-bearing case is pass + pass → combined FAIL →
// reject, and it is built deliberately — two changes that each satisfy their own
// check and contradict each other when applied together.
//
// Run: node scripts/supervisor-merge.test.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { ROOT, fixtureRepo, fixtureRun, harness, parse, runScript } from "./supervisor-test-fixtures.mjs";
import { runDir, writeRegistry } from "./supervisor-lib.mjs";

const { test, fail, summary } = harness();
const MERGE = join(ROOT, "scripts", "supervisor-merge.mjs");

const gitIn = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();

// A verify command that reads a file the candidates write. `node -e` keeps it
// self-contained: no test runner in the fixture repo, and the merge node must
// work against whatever command it is handed.
const VERIFY =
  'node -e "const v=require(\'fs\').readFileSync(\'value.txt\',\'utf8\').trim();process.exit(v===\'ok\'?0:1)"';

/**
 * A repo whose `value.txt` must read "ok", plus N candidate branches with their
 * own worktrees — the shape supervisor-spawn produces.
 */
function fixture(candidates) {
  const { base, repo } = fixtureRepo();
  writeFileSync(join(repo, "value.txt"), "ok\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-m", "base: value is ok");
  const baseRevision = gitIn(repo, "rev-parse", "HEAD");

  const children = {};
  for (const [i, c] of candidates.entries()) {
    const branch = c.branch ?? `foc-${100 + i}-dev`;
    const worktree = resolve(join(repo, "..", "la-wt", branch));
    gitIn(repo, "worktree", "add", "-b", branch, worktree, baseRevision);
    c.write?.(worktree);
    if (c.commit !== false) {
      gitIn(worktree, "add", "-A");
      gitIn(worktree, "commit", "-m", `${branch}: work`);
    }
    children[`dev-${i + 1}`] = {
      childId: `dev-${i + 1}`,
      squad: "dev",
      taskId: `FOC-${100 + i}`,
      status: "exited",
      turns: [{ pid: 1 }],
      costUsd: 0,
      worktree,
      branch,
      baseRevision,
      allowedPaths: c.allowedPaths ?? [],
    };
  }

  const runId = fixtureRun();
  writeRegistry(runId, { runId, children, rounds: {} });
  return { base, repo, runId, baseRevision };
}

const merge = (runId, extra = [], cmd = VERIFY) =>
  runScript(MERGE, ["--run", runId, "--verify", cmd, ...extra]);

// Two features that each work alone and are mutually exclusive: the check allows
// at most one .feature file. No textual conflict — different files, different
// hunks — and the combination still has to be rejected. That is the AC's point
// that absence of a conflict is not evidence of compatibility.
const AT_MOST_ONE =
  `node -e "const n=require('fs').readdirSync('.').filter(f=>f.endsWith('.feature')).length;process.exit(n<=1?0:1)"`;

// ── 1. the refusal that keeps this honest ────────────────────────────────────
console.log("\nbez komendy weryfikującej nie ma zielonego");

test("--verify is required", () => {
  // A merge node that guesses the test command can report green by running
  // nothing, and a green from a command that does not exist is the worst thing
  // this script could produce.
  const f = fixture([{ write: (w) => writeFileSync(join(w, "a.txt"), "a\n") }]);
  const out = parse(runScript(MERGE, ["--run", f.runId]), fail);
  assert.equal(out.ok, false);
  assert.match(out.error, /--verify/);
});

test("a verify command that cannot start is a failure, not a pass", () => {
  // spawnSync reports an unstartable command as status null. Treating null as 0
  // would turn "the runner is missing" into "everything is fine".
  const f = fixture([{ write: (w) => writeFileSync(join(w, "a.txt"), "a\n") }]);
  const r = runScript(MERGE, ["--run", f.runId, "--verify", "definitely-not-a-real-command-xyz"]);
  const out = parse(r, fail);
  assert.equal(out.accepted, false);
  assert.equal(r.status, 1);
});

// ── 2. the premise ───────────────────────────────────────────────────────────
console.log("\ndwie zielone łatki to nie jedna zielona łatka");

test("pass + pass with compatible changes is accepted", () => {
  const f = fixture([
    { write: (w) => writeFileSync(join(w, "a.txt"), "a\n") },
    { write: (w) => writeFileSync(join(w, "b.txt"), "b\n") },
  ]);
  const r = merge(f.runId);
  const out = parse(r, fail);
  assert.equal(out.accepted, true, JSON.stringify(out.findings));
  assert.equal(r.status, 0);
  assert.ok(out.isolation.every((i) => i.ok));
  assert.ok(out.combined.ok);
  assert.ok(out.candidates.every((c) => c.accepted));
});

test("pass + pass whose COMBINATION fails is rejected — the whole premise", () => {
  // Each candidate adds ONE .feature file. Alone, each satisfies "at most one".
  // Together there are two. Different files, no textual conflict, and the
  // integration must still be rejected.
  const f = fixture([
    { write: (w) => writeFileSync(join(w, "one.feature"), "1\n") },
    { write: (w) => writeFileSync(join(w, "two.feature"), "2\n") },
  ]);

  const r = merge(f.runId, [], AT_MOST_ONE);
  const out = parse(r, fail);

  // Both passed alone. That is the setup, not the result.
  assert.ok(out.isolation.every((i) => i.ok), JSON.stringify(out.isolation.map((i) => i.tail)));
  // Nothing conflicted textually. That is the trap this test exists to spring:
  // absence of a conflict is not evidence of compatibility.
  assert.ok(out.replays.every((x) => x.ok), JSON.stringify(out.replays));

  assert.equal(out.combined.ok, false, "the combined suite passed on an incompatible pair");
  assert.equal(out.accepted, false);
  assert.equal(r.status, 1);
  assert.ok(out.findings.some((x) => /combined suite failed/.test(x)), JSON.stringify(out.findings));

  // A candidate green in isolation is never sufficient.
  assert.ok(out.candidates.every((c) => c.isolation === true && c.accepted === false));
});

test("a candidate that fails alone rejects the whole integration", () => {
  const f = fixture([
    { write: (w) => writeFileSync(join(w, "keep.txt"), "keep\n") },
    { write: (w) => writeFileSync(join(w, "value.txt"), "broken\n") },
  ]);

  const r = merge(f.runId);
  const out = parse(r, fail);
  assert.equal(out.accepted, false);
  assert.equal(r.status, 1);
  // Including the one that passed: no candidate is accepted when the
  // integration is not.
  assert.ok(out.candidates.every((c) => c.accepted === false));
  assert.ok(out.findings.some((x) => /failed its own verify/.test(x)), JSON.stringify(out.findings));
});

// ── 3. textual conflict ──────────────────────────────────────────────────────
console.log("\nkonflikt tekstowy");

test("a textual conflict is rejected and names the files", () => {
  const f = fixture([
    { write: (w) => writeFileSync(join(w, "shared.txt"), "from one\n") },
    { write: (w) => writeFileSync(join(w, "shared.txt"), "from two\n") },
  ]);
  const r = merge(f.runId);
  const out = parse(r, fail);

  assert.equal(out.accepted, false);
  const conflicted = out.replays.flatMap((x) => x.conflicts);
  assert.ok(conflicted.includes("shared.txt"), JSON.stringify(out.replays));
  assert.ok(out.findings.some((x) => /textual conflict/.test(x)), JSON.stringify(out.findings));
});

test("the combined suite is not run when the replay failed", () => {
  // Running it would report a result about a tree that is not the integration.
  const f = fixture([
    { write: (w) => writeFileSync(join(w, "shared.txt"), "one\n") },
    { write: (w) => writeFileSync(join(w, "shared.txt"), "two\n") },
  ]);
  const out = parse(merge(f.runId), fail);
  assert.equal(out.combined, null);
  assert.ok(out.findings.some((x) => /was not run/.test(x)));
});

// ── 4. declaration versus reality ────────────────────────────────────────────
console.log("\ndeklaracja kontra rzeczywistość");

test("writing outside allowedPaths is a first-class finding", () => {
  // allowedPaths is not enforced at runtime — supervisor-spawn says so where it
  // records the field. This is the only place the declaration is ever checked
  // against what actually happened.
  const f = fixture([
    {
      allowedPaths: ["src"],
      write: (w) => {
        writeFileSync(join(w, "elsewhere.txt"), "outside the declaration\n");
      },
    },
  ]);
  const out = parse(merge(f.runId), fail);

  const d = out.allowedPathDrift[0];
  assert.deepEqual(d.declared, ["src"]);
  assert.ok(d.outside.includes("elsewhere.txt"), JSON.stringify(d));
  assert.equal(out.accepted, false, "path drift did not reject the integration");
  assert.ok(out.findings.some((x) => /outside its declared allowedPaths/.test(x)));
});

test("an empty declaration means undeclared, not everything-forbidden", () => {
  // Reporting every path as a violation there would bury the real ones.
  const f = fixture([{ allowedPaths: [], write: (w) => writeFileSync(join(w, "anything.txt"), "x\n") }]);
  const out = parse(merge(f.runId), fail);
  const d = out.allowedPathDrift[0];
  assert.equal(d.undeclared, true);
  assert.deepEqual(d.outside, []);
  assert.equal(out.accepted, true, JSON.stringify(out.findings));
});

// ── 5. what it must never do ─────────────────────────────────────────────────
console.log("\nczego węzeł scalający NIE robi");

test("a rejected integration leaves every child worktree intact", () => {
  const f = fixture([
    { write: (w) => writeFileSync(join(w, "shared.txt"), "one\n") },
    { write: (w) => writeFileSync(join(w, "shared.txt"), "two\n") },
  ]);
  const out = parse(merge(f.runId), fail);
  assert.equal(out.accepted, false);
  for (const c of out.candidates) {
    assert.ok(existsSync(c.worktree), `${c.childId}'s worktree was removed by the merge node`);
  }
});

test("a rejected integration is kept on disk for inspection", () => {
  // Removing it would throw away the one artefact showing what the combination
  // actually did.
  const f = fixture([
    { write: (w) => writeFileSync(join(w, "shared.txt"), "one\n") },
    { write: (w) => writeFileSync(join(w, "shared.txt"), "two\n") },
  ]);
  const out = parse(merge(f.runId), fail);
  assert.equal(out.integration.keptForInspection, true);
  assert.ok(out.integration.worktree);
  assert.ok(existsSync(out.integration.worktree));
});

test("no retry is attempted, and the report says so", () => {
  const f = fixture([
    { write: (w) => writeFileSync(join(w, "shared.txt"), "one\n") },
    { write: (w) => writeFileSync(join(w, "shared.txt"), "two\n") },
  ]);
  const out = parse(merge(f.runId), fail);
  assert.match(out.next, /No retry/i);
  assert.match(out.next, /no worktree was cleaned/i);
});

test("the verdict is written to the run directory", () => {
  const f = fixture([{ write: (w) => writeFileSync(join(w, "a.txt"), "a\n") }]);
  merge(f.runId);
  const path = join(runDir(f.runId), "merge.json");
  assert.ok(existsSync(path));
  assert.ok(JSON.parse(readFileSync(path, "utf8")).verifyCommand);
});

test("a live child cannot be integrated", () => {
  // A moving tree cannot be integrated: the diff would be of a state that no
  // longer exists by the time the combined suite runs.
  const f = fixture([{ write: (w) => writeFileSync(join(w, "a.txt"), "a\n") }]);
  const reg = JSON.parse(readFileSync(join(runDir(f.runId), "children.json"), "utf8"));
  reg.children["dev-1"].status = "running";
  writeFileSync(join(runDir(f.runId), "children.json"), JSON.stringify(reg));

  const out = parse(merge(f.runId, ["--child", "dev-1"]), fail);
  assert.equal(out.ok, false);
  assert.match(out.error, /in flight/);
});

summary();
