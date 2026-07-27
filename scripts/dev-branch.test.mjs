// scripts/dev-branch.test.mjs — branch naming + WHICH REPO the branch lands in.
//
// The repo-targeting tests are the point of this file. dev-branch.mjs used to
// hardcode git's cwd to its own parent (linear-agents), so a DEV run for a task
// belonging to another repo created the branch in the ORCHESTRATOR repo and left
// it checked out there. That is how linear-agents collected foc-15-… and
// foc-49-… while the real work sat in sce/ and office/. These tests build two
// real throwaway repos and assert the branch lands in the caller's repo only.
//
// Run: node scripts/dev-branch.test.mjs

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { sanitizeSlug, parseIdentifier, buildBranchName, resolveGitRoot } from "./dev-branch.mjs";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "dev-branch.mjs");
const ORCHESTRATOR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Every branch these tests create carries this run-unique marker. Two reasons:
// a fixed name like "fen-30-thing" could collide with a real branch, and if the
// script regresses the branches land HERE, in the orchestrator repo — the marker
// is what lets the final sweep identify and remove exactly our own leakage
// without touching anything real. (Learned the hard way: verifying these tests
// against a deliberately broken script left three junk branches behind.)
const MARK = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg || ""} expected ${e}, got ${a}`);
}

function ok(cond, msg) {
  if (!cond) throw new Error(msg || "expected truthy");
}

// --- helpers ---------------------------------------------------------------

function git(repo, args) {
  return execFileSync("git", args, {
    cwd: repo,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  }).toString().trim();
}

/** Create a throwaway git repo with one commit. Returns its path. */
function makeRepo(label) {
  const dir = mkdtempSync(join(tmpdir(), `devbranch-${label}-`));
  git(dir, ["init", "--initial-branch=main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, "README.md"), `# ${label}\n`, "utf8");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "init"]);
  return dir;
}

function branches(repo) {
  return git(repo, ["branch", "--format=%(refname:short)"])
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Run dev-branch.mjs FROM `cwd`. Returns {status, stdout, stderr}. */
function runScript(cwd, args) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      env: { ...process.env, LINEAR_TEAM_KEY: "FEN" },
    }).toString();
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return {
      status: err.status ?? 1,
      stdout: (err.stdout || "").toString(),
      stderr: (err.stderr || "").toString(),
    };
  }
}

// --- pure helpers ----------------------------------------------------------

console.log("\ndev-branch: naming");

test("sanitizeSlug lowercases and hyphenates", () => {
  eq(sanitizeSlug("FinBERT Sentiment Aggregation"), "finbert-sentiment-aggregation");
});

test("sanitizeSlug collapses runs and trims hyphens", () => {
  eq(sanitizeSlug("  --Gantt__snapshot!! "), "gantt-snapshot");
});

test("sanitizeSlug falls back to 'task' when empty", () => {
  eq(sanitizeSlug(""), "task");
  eq(sanitizeSlug("!!!"), "task");
});

test("parseIdentifier splits TEAM-NUM", () => {
  eq(parseIdentifier("FOC-49"), { key: "FOC", number: "49" });
});

test("branch name takes its prefix from the identifier, not the env", () => {
  // JOI-70 with LINEAR_TEAM_KEY=FEN must stay joi-70-… — a wrong prefix here
  // poisons branch-based task attribution in telemetry.
  const prev = process.env.LINEAR_TEAM_KEY;
  process.env.LINEAR_TEAM_KEY = "FEN";
  try {
    eq(buildBranchName("JOI-70", "control plane"), "joi-70-control-plane");
  } finally {
    if (prev === undefined) delete process.env.LINEAR_TEAM_KEY;
    else process.env.LINEAR_TEAM_KEY = prev;
  }
});

test("--team-key overrides the identifier prefix", () => {
  eq(buildBranchName("JOI-70", "x", "FEN"), "fen-70-x");
});

// --- repo targeting (the regression these tests exist for) -----------------

console.log("\ndev-branch: which repo does the branch land in");

test("resolveGitRoot returns the caller's repo, not this script's repo", () => {
  const target = makeRepo("target");
  try {
    const resolved = resolveGitRoot(target);
    // realpath both sides: macOS/Windows temp dirs are symlinked/8.3-shortened.
    const expected = git(target, ["rev-parse", "--show-toplevel"]);
    eq(resolve(resolved), resolve(expected), "resolveGitRoot must follow cwd");
    ok(!resolve(resolved).includes("linear-agents"), "must not resolve to the orchestrator repo");
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("start creates the branch in the CALLER's repo", () => {
  const target = makeRepo("caller");
  try {
    const r = runScript(target, ["start", "FOC-49", `finbert ${MARK}`]);
    eq(r.status, 0, `script failed: ${r.stderr}`);
    ok(
      branches(target).includes(`foc-49-finbert-${MARK}`),
      `branch missing in caller repo; branches=${branches(target).join(",")}`,
    );
    eq(git(target, ["branch", "--show-current"]), `foc-49-finbert-${MARK}`);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("start does NOT touch the orchestrator repo (linear-agents)", () => {
  // The actual bug: a task belonging to another repo left its branch here.
  // Use an identifier that cannot already exist locally — asserting on a real
  // one (FOC-49) would trip over the stray branch the old bug already left
  // behind, which says nothing about what THIS run did.
  const before = branches(ORCHESTRATOR);
  const headBefore = git(ORCHESTRATOR, ["branch", "--show-current"]);

  const target = makeRepo("elsewhere");
  try {
    const r = runScript(target, ["start", "ZZZ-49", MARK]);
    eq(r.status, 0, `script failed: ${r.stderr}`);

    // It must exist in the caller's repo...
    ok(branches(target).includes(`zzz-49-${MARK}`), "branch missing in the caller repo");

    // ...and nowhere in the orchestrator.
    const after = branches(ORCHESTRATOR);
    eq(after, before, "orchestrator branch list must be unchanged");
    eq(git(ORCHESTRATOR, ["branch", "--show-current"]), headBefore, "orchestrator HEAD must not move");
    ok(
      !after.some((b) => b.includes(MARK)),
      "a branch for another repo's task leaked into the orchestrator — the exact regression under test",
    );
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("existing branch is checked out and rebased in the caller's repo", () => {
  const target = makeRepo("existing");
  try {
    git(target, ["branch", `fen-30-${MARK}`]);
    const r = runScript(target, ["start", "FEN-30", MARK]);
    eq(r.status, 0, `script failed: ${r.stderr}`);
    eq(git(target, ["branch", "--show-current"]), `fen-30-${MARK}`);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("outside a git repo: exits non-zero and says so, creates nothing", () => {
  const notARepo = mkdtempSync(join(tmpdir(), "devbranch-norepo-"));
  const before = branches(ORCHESTRATOR);
  try {
    const r = runScript(notARepo, ["start", "FOC-49", MARK]);
    ok(r.status !== 0, "must fail rather than silently pick another repo");
    ok(/not inside a git repository/i.test(r.stderr), `unhelpful stderr: ${r.stderr}`);
    eq(branches(ORCHESTRATOR), before, "must not fall back to the orchestrator repo");
  } finally {
    rmSync(notARepo, { recursive: true, force: true });
  }
});

test("dry-run prints the target repo and creates no branch", () => {
  const target = makeRepo("dry");
  try {
    const before = branches(target);
    const r = runScript(target, ["start", "FOC-49", MARK, "--dry-run"]);
    eq(r.status, 0, `script failed: ${r.stderr}`);
    ok(new RegExp(`git checkout -b foc-49-${MARK}`).test(r.stdout), `missing plan line: ${r.stdout}`);
    ok(/# in: /.test(r.stdout), `dry-run must disclose the target repo: ${r.stdout}`);
    eq(branches(target), before, "dry-run must not create a branch");
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("name subcommand prints only the name, touches no repo", () => {
  const target = makeRepo("nameonly");
  try {
    const before = branches(target);
    const r = runScript(target, ["name", "FOC-49", `finbert ${MARK}`]);
    eq(r.status, 0, `script failed: ${r.stderr}`);
    eq(r.stdout.trim(), `foc-49-finbert-${MARK}`);
    eq(branches(target), before, "name must not create a branch");
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

// --- safety sweep ----------------------------------------------------------
// If the script regresses, `start` writes into the orchestrator repo instead of
// the temp one and the failures above will say so. Leaving that debris behind
// would then pollute a real repo, so remove anything carrying this run's marker
// and report it loudly. Only marked branches are touched — never a real one.

function sweepOrchestrator() {
  let leaked = [];
  try {
    leaked = branches(ORCHESTRATOR).filter((b) => b.includes(MARK));
    if (!leaked.length) return;
    const current = git(ORCHESTRATOR, ["branch", "--show-current"]);
    if (leaked.includes(current)) {
      // The broken script also moved HEAD; step off before deleting.
      git(ORCHESTRATOR, ["checkout", "main"]);
    }
    for (const b of leaked) git(ORCHESTRATOR, ["branch", "-D", b]);
  } catch (err) {
    console.log(`  !! sweep failed, clean up by hand: ${err.message}`);
    return;
  }
  console.log(`  !! ${leaked.length} branch(es) leaked into ${ORCHESTRATOR} and were removed:`);
  for (const b of leaked) console.log(`     - ${b}`);
  console.log("     This means dev-branch.mjs is writing to the orchestrator repo again.");
}

// --- summary ---------------------------------------------------------------

console.log("");
sweepOrchestrator();
if (failures.length) {
  console.log(`${passed} passed, ${failures.length} FAILED`);
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);
