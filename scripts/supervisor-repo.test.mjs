// scripts/supervisor-repo.test.mjs — a child works in the task's repo, not ours.
//
// Found on a real run (2026-08-31): a child sent to work on a Fraud-Prediction
// task got a worktree of linear-agents — the ORCHESTRATION repo — reported the
// fraud code as missing, and stalled on a configuration blocker. `--repo`
// existed and nothing ever passed it, so `args.repo || ROOT` meant ROOT every
// single time, and the Supervisor's own prompt never mentioned the flag.
//
// The fix is not a Linear project→repo mapping. Every supervisor launch in the
// telemetry store has a DIFFERENT cwd — Fraud-Prediction, joint-flows,
// moto_computer_vision, landing, linear-agents — because bin/supervisor.bat is
// launched FROM the repo being worked on. The launch directory IS the answer;
// bin/supervisor.bat captures it as LA_SUPERVISOR_REPO before anything can cd.
//
// Two properties this file exists to keep:
//   1. resolution order (flag → launcher → cwd) with NO fallback to ROOT — a
//      silent default to linear-agents is the whole bug;
//   2. worktree paths are scoped per repo, because two repos under one parent
//      directory built the same ../la-wt/<branch> from the same Linear id.
//
// Run: node scripts/supervisor-repo.test.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

import { ROOT, SPAWN, harness, fixtureRepo, fixtureRun, baseEnv } from "./supervisor-test-fixtures.mjs";
import { worktreePathFor, worktreeRoot } from "./supervisor-lib.mjs";

const { test, fail, summary } = harness();

console.log("\nworktree należy do repo zadania");

test("the worktree path is scoped by repo name", () => {
  // Both of these live under one parent, exactly like linear-agents and
  // Fraud-Prediction under GitHub/. Before the scoping they collided.
  const base = mkdtempSync(join(tmpdir(), "la-repo-"));
  const a = join(base, "alpha");
  const b = join(base, "beta");
  mkdirSync(a);
  mkdirSync(b);

  const pa = worktreePathFor(a, "foc-174-dev");
  const pb = worktreePathFor(b, "foc-174-dev");
  assert.notEqual(pa, pb, "two repos under one parent still share a worktree path");
  assert.ok(pa.includes("alpha"), pa);
  assert.ok(pb.includes("beta"), pb);
});

test("the scoped root still sits beside the repo, never inside it", () => {
  // Nesting a worktree under the repo puts it in the parent's own git status
  // and in every glob the agents run — the confusion worktrees exist to remove.
  const { repo } = fixtureRepo();
  const root = resolve(worktreeRoot(repo));
  assert.ok(!root.startsWith(resolve(repo) + sep), `worktree root is inside the repo: ${root}`);
  assert.equal(basename(root), basename(repo), "the scoped segment is not the repo name");
});

console.log("\nrozwiązywanie repo — kolejność i brak cichego defaultu");

/** Run spawn past the triage gate and return its parsed JSON refusal. */
function refusal(args, env, cwd) {
  const runId = fixtureRun();
  let out = "";
  try {
    out = execFileSync(
      process.execPath,
      [SPAWN, "--run", runId, "--squad", "dev", "--task", "FOC-123", "--prompt", "k", ...args],
      { cwd, encoding: "utf8", env: { ...baseEnv(), ...env }, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (err) {
    out = String(err.stdout || "") + String(err.stderr || "");
  }
  const at = out.indexOf("{");
  if (at === -1) return fail(`expected JSON on stdout, got:\n${out.slice(0, 400)}`);
  try {
    return JSON.parse(out.slice(at));
  } catch {
    return fail(`stdout was not JSON:\n${out.slice(0, 400)}`);
  }
}

test("an explicit --repo that is not a repo FAILS — it does not fall through", () => {
  // The defect in the first version of this change, caught by
  // supervisor-triage.test.mjs: a bad --repo fell through to the next
  // candidate, reached process.cwd() = linear-agents, and started a child
  // there. It left a real worktree behind. An explicit flag is an instruction.
  const nowhere = mkdtempSync(join(tmpdir(), "la-norepo-"));
  const parsed = refusal(["--repo", nowhere], {}, ROOT);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /--repo/, parsed.error);
  assert.match(parsed.error, /not inside a git repository/i, parsed.error);
});

test("with no --repo and nothing usable, spawn refuses instead of using linear-agents", () => {
  // The old behaviour was `args.repo || ROOT`: an ABSENT --repo quietly
  // resolved to this checkout. Here both remaining candidates are non-repos,
  // so the only honest answer is a refusal that names what it tried.
  const nowhere = mkdtempSync(join(tmpdir(), "la-norepo-"));
  const parsed = refusal([], { LA_SUPERVISOR_REPO: nowhere }, nowhere);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /which repository/i, parsed.error);
  assert.ok(Array.isArray(parsed.tried) && parsed.tried.length > 0, "the refusal does not say what it tried");
  if (/linear-agents/.test(JSON.stringify(parsed.tried))) {
    fail(`linear-agents is still a candidate: ${JSON.stringify(parsed.tried)}`);
  }
});

test("spawn source keeps the resolution order and no ROOT fallback", () => {
  // Source assertion: exercising all three candidates end to end needs a real
  // child per case. The ordering is one array and the regression is one word.
  const src = readFileSync(SPAWN, "utf8")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");

  assert.match(src, /args\.repo/, "the explicit flag is no longer a candidate");
  assert.match(src, /LA_SUPERVISOR_REPO/, "the launcher's captured directory is no longer a candidate");
  assert.match(src, /process\.cwd\(\)/, "the current directory is no longer a candidate");

  const flagAt = src.indexOf("args.repo");
  const envAt = src.indexOf("LA_SUPERVISOR_REPO");
  const cwdAt = src.indexOf("process.cwd()");
  assert.ok(flagAt < envAt && envAt < cwdAt, "resolution order changed: --repo, then launcher, then cwd");

  if (/resolveGitRoot\(\s*args\.repo\s*\|\|\s*ROOT\s*\)/.test(src)) {
    fail("the `args.repo || ROOT` fallback is back — an unspecified repo means linear-agents again");
  }
});

test("the launcher captures its start directory before anything can cd", () => {
  const bat = readFileSync(join(ROOT, "bin", "supervisor.bat"), "utf8");
  assert.match(bat, /set "LA_SUPERVISOR_REPO=%CD%"/, "supervisor.bat no longer captures its launch directory");

  const capture = bat.indexOf("LA_SUPERVISOR_REPO=%CD%");
  const lib = bat.indexOf('call "%~dp0_lib.bat"');
  assert.ok(capture < lib, "LA_SUPERVISOR_REPO must be captured BEFORE _lib.bat runs");
});

test("spawn reports which repo it chose and where that came from", () => {
  // A wrong repo caught at spawn time costs a sentence; caught by a child that
  // cannot find the code it costs the run.
  const src = readFileSync(SPAWN, "utf8");
  assert.match(src, /repo:\s*gitRoot/);
  assert.match(src, /repoFrom/);
});

summary();
