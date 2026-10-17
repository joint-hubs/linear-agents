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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

// ── 6. the tree is built by merging, not cherry-picking (FOC-726) ────────────
console.log("\nscalanie, nie cherry-pick");

/**
 * Register one candidate by hand — for the fixtures below the `fixture()`
 * helper's single-commit-per-branch shape is exactly what is under test, so
 * the history is built directly and only the registry entry is shared.
 */
function registerChild(runId, { childId = "dev-1", taskId = "FOC-100", branch, worktree, baseRevision, allowedPaths = [] }) {
  writeRegistry(runId, {
    runId,
    children: {
      [childId]: { childId, squad: "dev", taskId, status: "exited", turns: [{ pid: 1 }], costUsd: 0, worktree, branch, baseRevision, allowedPaths },
    },
    rounds: {},
  });
}

test("a candidate whose history carries a merge commit is merged, not cherry-picked", () => {
  // Every landing goes branch→PR→merge, so a real candidate's history contains
  // merge commits — which cherry-pick refuses outright. The defect this test
  // pins: the combination used to be reported as a verification REJECT without
  // a single tree ever being tested.
  const { repo } = fixtureRepo();
  writeFileSync(join(repo, "value.txt"), "ok\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-m", "base: value is ok");
  const baseRevision = gitIn(repo, "rev-parse", "HEAD");

  // A side branch the candidate will merge in, so base..candidate contains a
  // merge commit — exactly the shape that used to kill the replay.
  gitIn(repo, "checkout", "-b", "side", baseRevision);
  writeFileSync(join(repo, "side.txt"), "side\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-m", "side: its own file");

  const branch = "foc-100-dev";
  gitIn(repo, "checkout", "-b", branch, baseRevision);
  writeFileSync(join(repo, "main.txt"), "main\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-m", `${branch}: work`);
  gitIn(repo, "merge", "--no-ff", "side", "-m", `${branch}: merge side`);
  gitIn(repo, "checkout", "main");

  const worktree = resolve(join(repo, "..", "la-wt", branch));
  gitIn(repo, "worktree", "add", worktree, branch);

  const runId = fixtureRun();
  registerChild(runId, { branch, worktree, baseRevision });

  const r = merge(runId);
  const out = parse(r, fail);

  assert.equal(out.accepted, true, JSON.stringify(out.findings));
  assert.equal(out.status, "accepted");
  assert.equal(r.status, 0);
  // The combined suite actually RAN — this is the assertion that separates
  // "merged" from "silently skipped".
  assert.ok(out.combined && out.combined.ok, JSON.stringify(out.combined));
  assert.ok(out.replays[0].ok, JSON.stringify(out.replays));
  // The branch carried its own commit, the side commit and the merge commit.
  assert.ok(out.replays[0].commits >= 2, JSON.stringify(out.replays));
  // Built by merging: the integration branch's own history has a merge commit.
  const merges = gitIn(repo, "log", "--merges", "--format=%s", `la-merge/${runId}`);
  assert.ok(merges.length > 0, `no merge commit on la-merge/${runId}`);
});

test("a merge refusal without conflicts is a tool error, not a verification reject", () => {
  // The candidate sits on an unrelated history: its own verify passes (it
  // carries the same value.txt), but git refuses the merge outright. No tree
  // was tested, so `accepted` must stay null — a tool failure dressed as a
  // reject is exactly how a verdict nobody earned gets believed.
  const { repo } = fixtureRepo();
  writeFileSync(join(repo, "value.txt"), "ok\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-m", "base: value is ok");
  const baseRevision = gitIn(repo, "rev-parse", "HEAD");

  gitIn(repo, "checkout", "--orphan", "orphan");
  gitIn(repo, "rm", "-rf", ".");
  writeFileSync(join(repo, "value.txt"), "ok\n");
  writeFileSync(join(repo, "own.txt"), "own\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-m", "orphan: unrelated history");
  gitIn(repo, "checkout", "main");

  const worktree = resolve(join(repo, "..", "la-wt", "orphan"));
  gitIn(repo, "worktree", "add", worktree, "orphan");

  const runId = fixtureRun();
  registerChild(runId, { branch: "orphan", worktree, baseRevision });

  const r = merge(runId);
  const out = parse(r, fail);

  assert.equal(out.status, "tool_error");
  assert.equal(out.accepted, null);
  assert.equal(out.combined, null);
  assert.equal(r.status, 2);
  // The git error reaches the findings, not a fabricated rejection.
  assert.ok(out.findings.some((x) => /unrelated histories/.test(x)), JSON.stringify(out.findings));
  // No candidate is marked rejected by a tool failure, and none is accepted.
  assert.ok(out.candidates.every((c) => c.accepted === null), JSON.stringify(out.candidates));
  // The untested tree is kept for inspection, the child's tree untouched.
  assert.equal(out.integration.keptForInspection, true);
  assert.ok(out.integration.worktree && existsSync(out.integration.worktree));
  assert.ok(existsSync(worktree), "the child's worktree was touched by a tool failure");
  assert.match(out.next, /not a verification result/i);
});

// ── 7. the generated task-journal index (FOC-904) ────────────────────────────
console.log("\nthe generated task-journal index");

// A base STATE.md that already carries the generated block, the shape after
// FOC-904 lands: the index is machine-owned, the rest is hand-written.
const STATE_WITH_BLOCK = [
  "# STATE — fixture",
  "",
  "> header line.",
  "",
  "<!-- state-index:start -->",
  "## Task journals (generated)",
  "",
  "<!-- state-index:end -->",
  "",
  "## 2026-10-01 10:00 — base entry",
  "",
  "body.",
  "",
].join("\n");

/** A journal file as a child session would create it through state-journal.mjs. */
const journalFile = (id, stamp) =>
  [
    `# ${id} — journal`,
    "",
    `Task: ${id}`,
    "Session: sess-1",
    "Run: run-1",
    `Branch: b-${id}`,
    "PR: -",
    "Status: in progress",
    "",
    `## ${stamp} — first entry`,
    "",
    "work.",
    "",
  ].join("\n");

/** Two children that each add their own journal file AND append their own line to the index block. */
function journalFixture() {
  const { base, repo } = fixtureRepo();
  writeFileSync(join(repo, "value.txt"), "ok\n");
  mkdirSync(join(repo, "docs"), { recursive: true });
  writeFileSync(join(repo, "docs", "STATE.md"), STATE_WITH_BLOCK);
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-m", "base: value is ok, index block present");
  const baseRevision = gitIn(repo, "rev-parse", "HEAD");

  const children = {};
  for (const [i, id] of [["FOC-100", "2026-10-16 10:00"], ["FOC-101", "2026-10-16 11:00"]].entries()) {
    const [taskId, stamp] = id;
    const branch = `foc-${100 + i}-dev`;
    const worktree = resolve(join(repo, "..", "la-wt", branch));
    gitIn(repo, "worktree", "add", "-b", branch, worktree, baseRevision);
    mkdirSync(join(worktree, "docs", "state"), { recursive: true });
    writeFileSync(join(worktree, "docs", "state", `${taskId}.md`), journalFile(taskId, stamp));
    // The child also commits ITS OWN rendering of the index block (what a
    // diligent session running state-index --write produces): a whole-span
    // rewrite listing only its own journal. Two children therefore rewritten
    // the same span differently — the merge cannot dodge that conflict.
    const block = readFileSync(join(worktree, "docs", "STATE.md"), "utf8");
    const rewritten = block.replace(
      /<!-- state-index:start -->[\s\S]*<!-- state-index:end -->/,
      [
        "<!-- state-index:start -->",
        "## Task journals (generated)",
        "",
        `- ${taskId} — in progress — last entry ${stamp} — b-${taskId} — -`,
        "<!-- state-index:end -->",
      ].join("\n"),
    );
    writeFileSync(join(worktree, "docs", "STATE.md"), rewritten);
    gitIn(worktree, "add", "-A");
    gitIn(worktree, "commit", "-m", `${branch}: own journal + index line`);
    children[`dev-${i + 1}`] = {
      childId: `dev-${i + 1}`,
      squad: "dev",
      taskId,
      status: "exited",
      turns: [{ pid: 1 }],
      costUsd: 0,
      worktree,
      branch,
      baseRevision,
      allowedPaths: [],
    };
  }

  const runId = fixtureRun();
  writeRegistry(runId, { runId, children, rounds: {} });
  return { base, repo, runId, baseRevision };
}

test("an index-block-only STATE.md conflict is regenerated, not rejected", () => {
  // Journals are per task, so the only STATE.md overlap two candidates can
  // produce is the generated block — machine-owned, fully derived from
  // docs/state/. The merge node resolves it by regenerating, and the block
  // must then list BOTH journals.
  const f = journalFixture();
  const r = merge(f.runId);
  const out = parse(r, fail);

  assert.equal(out.accepted, true, JSON.stringify(out.findings));
  assert.equal(r.status, 0);
  assert.ok(out.replays.every((x) => x.ok), JSON.stringify(out.replays));
  assert.ok(
    out.replays.some((x) => /inside the generated index block/.test(x.note ?? "")),
    JSON.stringify(out.replays),
  );
  const state = gitIn(f.repo, "show", `la-merge/${f.runId}:docs/STATE.md`);
  assert.match(state, /- FOC-101 — in progress — last entry 2026-10-16 11:00 — b-FOC-101 — -/);
  assert.match(state, /- FOC-100 — in progress — last entry 2026-10-16 10:00 — b-FOC-100 — -/);
  // Newest first, as the generator renders it.
  assert.ok(state.indexOf("- FOC-101") < state.indexOf("- FOC-100"));
  // The hand-written part survived the resolution untouched.
  assert.match(state, /^## 2026-10-01 10:00 — base entry$/m);
});

test("a STATE.md conflict outside the index block is still a hard reject", () => {
  const { base, repo } = fixtureRepo();
  writeFileSync(join(repo, "value.txt"), "ok\n");
  mkdirSync(join(repo, "docs"), { recursive: true });
  writeFileSync(join(repo, "docs", "STATE.md"), STATE_WITH_BLOCK);
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-m", "base: index block present");
  const baseRevision = gitIn(repo, "rev-parse", "HEAD");

  const children = {};
  for (const [i, text] of [["one", "rewritten by one"], ["two", "rewritten by two"]].entries()) {
    const branch = `foc-${200 + i}-dev`;
    const worktree = resolve(join(repo, "..", "la-wt", branch));
    gitIn(repo, "worktree", "add", "-b", branch, worktree, baseRevision);
    // The collision is in the HAND-WRITTEN region — outside the markers.
    writeFileSync(
      join(worktree, "docs", "STATE.md"),
      readFileSync(join(worktree, "docs", "STATE.md"), "utf8").replace("base entry", text),
    );
    gitIn(worktree, "add", "-A");
    gitIn(worktree, "commit", "-m", `${branch}: edit outside the block`);
    children[`dev-${i + 1}`] = {
      childId: `dev-${i + 1}`,
      squad: "dev",
      taskId: `FOC-${200 + i}`,
      status: "exited",
      turns: [{ pid: 1 }],
      costUsd: 0,
      worktree,
      branch,
      baseRevision,
      allowedPaths: [],
    };
  }
  const runId = fixtureRun();
  writeRegistry(runId, { runId, children, rounds: {} });

  const r = merge(runId);
  const out = parse(r, fail);
  assert.equal(out.accepted, false);
  assert.equal(r.status, 1);
  assert.ok(out.replays.some((x) => (x.conflicts ?? []).includes("docs/STATE.md")), JSON.stringify(out.replays));
  assert.ok(out.findings.some((x) => /textual conflict/.test(x)), JSON.stringify(out.findings));
  // The merged child's journal file did not sneak into a rejected integration's verdict.
  assert.equal(out.combined, null);
});

test("an index regen failure on an accepted integration is a note, not a rejection", () => {
  // A dangling start marker makes `state-index --write` REFUSE (exit 2). The
  // replays themselves are clean, so the regen failure is bookkeeping, not a
  // verification result — the verdict stays what the real checks computed.
  const STATE_DANGLING_MARKER = [
    "# STATE — fixture",
    "",
    "> header line.",
    "",
    "<!-- state-index:start -->",
    "## Task journals (generated)",
    "",
    "body under a dangling marker.",
    "",
  ].join("\n");

  const { base, repo } = fixtureRepo();
  writeFileSync(join(repo, "value.txt"), "ok\n");
  mkdirSync(join(repo, "docs"), { recursive: true });
  writeFileSync(join(repo, "docs", "STATE.md"), STATE_DANGLING_MARKER);
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-m", "base: value is ok, dangling index start marker");
  const baseRevision = gitIn(repo, "rev-parse", "HEAD");

  const children = {};
  for (const [i, id] of [["FOC-300", "2026-10-16 10:00"], ["FOC-301", "2026-10-16 11:00"]].entries()) {
    const [taskId, stamp] = id;
    const branch = `foc-${300 + i}-dev`;
    const worktree = resolve(join(repo, "..", "la-wt", branch));
    gitIn(repo, "worktree", "add", "-b", branch, worktree, baseRevision);
    mkdirSync(join(worktree, "docs", "state"), { recursive: true });
    writeFileSync(join(worktree, "docs", "state", `${taskId}.md`), journalFile(taskId, stamp));
    gitIn(worktree, "add", "-A");
    gitIn(worktree, "commit", "-m", `${branch}: own journal`);
    children[`dev-${i + 1}`] = {
      childId: `dev-${i + 1}`,
      squad: "dev",
      taskId,
      status: "exited",
      turns: [{ pid: 1 }],
      costUsd: 0,
      worktree,
      branch,
      baseRevision,
      allowedPaths: [],
    };
  }
  const runId = fixtureRun();
  writeRegistry(runId, { runId, children, rounds: {} });

  const r = merge(runId);
  const out = parse(r, fail);
  assert.equal(out.accepted, true, JSON.stringify({ findings: out.findings, notes: out.notes }));
  assert.equal(r.status, 0);
  assert.ok(out.replays.every((x) => x.ok), JSON.stringify(out.replays));
  assert.ok(
    out.notes.some((x) => /task journal index was not regenerated/.test(x)),
    JSON.stringify(out.notes),
  );
  assert.ok(out.findings.length === 0, JSON.stringify(out.findings));
});

summary();
