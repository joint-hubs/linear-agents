// scripts/supervisor-spawn.test.mjs — spawn / watcher / stop / registry.
//
// Runs real child processes against a real (fixture) git repo, with a mock
// `claude` on LA_CLAUDE_BIN. Nothing here is stubbed except the model itself,
// because the things most likely to break are exactly the parts a stub would
// hide: worktree creation, detached-watcher liveness, and the win32 tree kill.
//
// Isolation: each test builds its own repo under the OS temp dir and its own
// run id, so worktrees land in <tmp>/<uniq>/la-wt and never touch this checkout.
// LA_SUPERVISOR_NO_TELEMETRY keeps run manifests out of .state/runs.
//
// Run: node scripts/supervisor-spawn.test.mjs

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { readRegistry, runDir } from "./supervisor-lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SPAWN = join(ROOT, "scripts", "supervisor-spawn.mjs");
const STOP = join(ROOT, "scripts", "supervisor-stop.mjs");
const MOCK = join(ROOT, "scripts", "mock-claude.mjs");

let passed = 0;
const failures = [];
const cleanup = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}
const fail = (msg) => { throw new Error(msg); };

function fixtureRepo() {
  const base = mkdtempSync(join(tmpdir(), "la-sup-"));
  const repo = join(base, "repo");
  mkdirSync(repo);
  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("init", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  writeFileSync(join(repo, "README.md"), "fixture\n");
  git("add", "-A");
  git("commit", "-m", "init");
  cleanup.push(base);
  return { base, repo };
}

let runCounter = 0;
function fixtureRun({ triage = true } = {}) {
  const runId = `test-${process.pid}-${Date.now()}-${runCounter++}`;
  const dir = runDir(runId);
  mkdirSync(join(dir, "children"), { recursive: true });
  mkdirSync(join(dir, "gates"), { recursive: true });
  if (triage) {
    writeFileSync(join(dir, "triage.json"), JSON.stringify({ issue: "FOC-123", verdict: "dev" }));
  }
  cleanup.push(dir);
  return runId;
}

function runSpawn(runId, repo, extra = [], env = {}) {
  return spawnSync(
    process.execPath,
    [SPAWN, "--run", runId, "--squad", "dev", "--task", "FOC-123", "--prompt", "kickoff", "--repo", repo, ...extra],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        LA_CLAUDE_BIN: MOCK,
        LA_SUPERVISOR_NO_TELEMETRY: "1",
        MOCK_CLAUDE_HANG_MS: "4000",
        ...env,
      },
    },
  );
}

const parse = (r) => {
  try {
    return JSON.parse(r.stdout);
  } catch {
    fail(`stdout was not JSON (exit ${r.status}):\n       ${r.stdout}\n       ${r.stderr}`);
  }
};

// ── fail-closed ──────────────────────────────────────────────────────────────
console.log("\nfail-closed");

test("refuses to spawn when no triage verdict is recorded", () => {
  const { repo } = fixtureRepo();
  const runId = fixtureRun({ triage: false });
  const r = runSpawn(runId, repo);
  if (r.status !== 1) fail(`expected exit 1, got ${r.status}`);
  const out = parse(r);
  if (out.ok !== false || !/triage/i.test(out.error)) fail(`unhelpful error: ${out.error}`);
  if (Object.keys(readRegistry(runId).children).length) fail("a child was registered anyway");
});

test("rejects a task id that is not a Linear identifier", () => {
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  const r = spawnSync(
    process.execPath,
    [SPAWN, "--run", runId, "--squad", "dev", "--task", "not-an-id", "--prompt", "x", "--repo", repo],
    { encoding: "utf8", env: { ...process.env, LA_CLAUDE_BIN: MOCK, LA_SUPERVISOR_NO_TELEMETRY: "1" } },
  );
  if (r.status !== 1) fail(`expected exit 1, got ${r.status}`);
  if (!parse(r).error.includes("TEAM-NUM")) fail("error did not explain the expected format");
});

test("refuses a second live child, naming the policy and the task that lifts it", () => {
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  const first = parse(runSpawn(runId, repo));
  if (!first.ok) fail("first spawn failed");

  const second = runSpawn(runId, repo, ["--task", "FOC-124", "--child", "dev-2"]);
  if (second.status !== 1) fail(`expected exit 1, got ${second.status}`);
  const out = parse(second);
  // The message must make clear this is policy, not a worktree collision —
  // otherwise the next reader "fixes" it by touching the worktree code.
  if (!/policy/i.test(out.error)) fail(`error does not say it is a policy limit: ${out.error}`);
  if (!/FOC-161/.test(out.error)) fail("error does not name the task that lifts the limit");

  spawnSync(process.execPath, [STOP, "--run", runId, "--child", first.childId], { encoding: "utf8" });
});

// ── worktree isolation ───────────────────────────────────────────────────────
console.log("\nworktree isolation");

test("creates a worktree and runs the child there, never in the repo root", () => {
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  const out = parse(runSpawn(runId, repo));

  if (!out.ok) fail(`spawn failed: ${out.error}`);
  if (!out.worktreeCreated) fail("expected a fresh worktree");
  if (out.worktree === repo) fail("the child was given the repo root as cwd");
  if (!existsSync(out.worktree)) fail(`worktree path does not exist: ${out.worktree}`);
  if (!out.branch.startsWith("foc-123-")) fail(`unexpected branch name: ${out.branch}`);

  const entry = readRegistry(runId).children[out.childId];
  for (const field of ["worktree", "branch", "baseRevision", "allowedPaths"]) {
    if (entry[field] === undefined) fail(`registry entry is missing "${field}"`);
  }

  spawnSync(process.execPath, [STOP, "--run", runId, "--child", out.childId], { encoding: "utf8" });
});

test("reuses an existing worktree and leaves the main tree's HEAD untouched", () => {
  const { repo } = fixtureRepo();
  const headBefore = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  const branchBefore = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

  const runA = fixtureRun();
  const first = parse(runSpawn(runA, repo));
  spawnSync(process.execPath, [STOP, "--run", runA, "--child", first.childId], { encoding: "utf8" });

  const runB = fixtureRun();
  const second = parse(runSpawn(runB, repo));

  if (second.worktreeCreated) fail("a second worktree was created for the same branch");
  if (second.worktree !== first.worktree) fail("reuse resolved to a different path");

  // This is the regression that shared-tree runs kept producing: a branch
  // switched under the main checkout while a run was live.
  const headAfter = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  const branchAfter = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  if (headAfter !== headBefore) fail("main tree HEAD moved");
  if (branchAfter !== branchBefore) fail(`main tree branch changed: ${branchBefore} → ${branchAfter}`);

  spawnSync(process.execPath, [STOP, "--run", runB, "--child", second.childId], { encoding: "utf8" });
});

test("two different tasks resolve to two different worktrees", () => {
  const { repo } = fixtureRepo();
  const runA = fixtureRun();
  const a = parse(runSpawn(runA, repo));
  spawnSync(process.execPath, [STOP, "--run", runA, "--child", a.childId], { encoding: "utf8" });

  const runB = fixtureRun();
  const b = parse(runSpawn(runB, repo, ["--task", "FOC-124"]));
  if (a.worktree === b.worktree) fail("two tasks shared one checkout — the whole point of this change");
  spawnSync(process.execPath, [STOP, "--run", runB, "--child", b.childId], { encoding: "utf8" });
});

test("records allowedPaths as a declaration when given", () => {
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  const out = parse(runSpawn(runId, repo, ["--allowed-path", "src/auth/", "--allowed-path", "src/session/"]));
  const entry = readRegistry(runId).children[out.childId];
  if (entry.allowedPaths.length !== 2) fail(`expected 2 declared paths, got ${JSON.stringify(entry.allowedPaths)}`);
  spawnSync(process.execPath, [STOP, "--run", runId, "--child", out.childId], { encoding: "utf8" });
});

// ── session identity + tee ───────────────────────────────────────────────────
console.log("\nsession identity and the event tee");

test("captures session_id from system/init and tees the raw stream", () => {
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  const out = parse(runSpawn(runId, repo, [], { MOCK_CLAUDE_SESSION_ID: "abc-123-session" }));

  if (out.sessionId !== "abc-123-session") fail(`sessionId was ${out.sessionId}`);
  if (out.status !== "running") fail(`status was ${out.status}`);

  const tee = join(runDir(runId), out.tee);
  if (!existsSync(tee)) fail("no tee file");
  if (!readFileSync(tee, "utf8").includes("abc-123-session")) fail("tee does not carry the init event");

  spawnSync(process.execPath, [STOP, "--run", runId, "--child", out.childId], { encoding: "utf8" });
});

test("survives an init event split across two stdout chunks", () => {
  // stream-json is NDJSON; a chunk boundary mid-line used to corrupt the tee and
  // lose the session_id entirely.
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  const out = parse(runSpawn(runId, repo, [], { MOCK_CLAUDE_SPLIT: "1" }));
  if (!out.sessionId) fail("split init lost the session_id");
  spawnSync(process.execPath, [STOP, "--run", runId, "--child", out.childId], { encoding: "utf8" });
});

test("fails, kills and explains when no system/init ever arrives", () => {
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  const r = runSpawn(runId, repo, [], { MOCK_CLAUDE_NO_INIT: "1", MOCK_CLAUDE_HANG_MS: "1000" });
  if (r.status !== 1) fail(`expected exit 1, got ${r.status}`);
  const out = parse(r);
  if (!/system\/init/.test(out.error)) fail(`error does not name the missing event: ${out.error}`);
  if (!/resumable/.test(out.error)) fail("error does not explain why this is fatal");
});

// ── watcher owns liveness ────────────────────────────────────────────────────
console.log("\nwatcher owns liveness");

test("watcher records a clean exit without any polling by the caller", async () => {
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  const out = parse(runSpawn(runId, repo, [], { MOCK_CLAUDE_HANG_MS: "0" }));

  const deadline = Date.now() + 8000;
  let entry;
  while (Date.now() < deadline) {
    entry = readRegistry(runId).children[out.childId];
    if (entry.status === "exited") break;
    execFileSync(process.execPath, ["-e", "setTimeout(()=>{},150)"]);
  }
  if (entry.status !== "exited") fail(`status stuck at "${entry.status}"`);
  if (entry.exitCode !== 0) fail(`exitCode was ${entry.exitCode}`);
  if (!entry.endedAt) fail("endedAt not recorded");
  if (!entry.turns?.[0]?.endedAt) fail("turn was not closed");
});

test("a non-zero exit is recorded as crashed, with no automatic respawn", async () => {
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  const out = parse(runSpawn(runId, repo, [], { MOCK_CLAUDE_EXIT: "3", MOCK_CLAUDE_HANG_MS: "0" }));

  const deadline = Date.now() + 8000;
  let entry;
  while (Date.now() < deadline) {
    entry = readRegistry(runId).children[out.childId];
    if (["crashed", "exited"].includes(entry.status)) break;
    execFileSync(process.execPath, ["-e", "setTimeout(()=>{},150)"]);
  }
  if (entry.status !== "crashed") fail(`expected crashed, got "${entry.status}"`);
  if (entry.exitCode !== 3) fail(`exitCode was ${entry.exitCode}`);

  const registry = readRegistry(runId);
  if (Object.keys(registry.children).length !== 1) fail("something respawned the child");
  if (entry.turns.length !== 1) fail(`expected one turn, got ${entry.turns.length}`);
});

// ── stop ─────────────────────────────────────────────────────────────────────
console.log("\nstop");

test("stops a live child and reports the worktree instead of cleaning it", () => {
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  const out = parse(runSpawn(runId, repo, [], { MOCK_CLAUDE_HANG_MS: "20000" }));

  writeFileSync(join(out.worktree, "scratch.txt"), "uncommitted work\n");

  const r = spawnSync(process.execPath, [STOP, "--run", runId, "--child", out.childId], { encoding: "utf8" });
  const stopped = parse(r);

  if (!stopped.ok) fail(`stop failed: ${stopped.error}`);
  if (stopped.status !== "stopped") fail(`status was ${stopped.status}`);
  if (!stopped.dirty.some((l) => l.includes("scratch.txt"))) {
    fail(`dirty report missed the file: ${JSON.stringify(stopped.dirty)}`);
  }
  // The uncommitted file must still be there — auto-reset would destroy the only
  // copy of whatever the child had not committed.
  if (!existsSync(join(out.worktree, "scratch.txt"))) fail("stop reset the worktree");
  if (!existsSync(out.worktree)) fail("stop removed the worktree");
});

test("a stopped child is not relabelled as crashed by the watcher", async () => {
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  const out = parse(runSpawn(runId, repo, [], { MOCK_CLAUDE_HANG_MS: "20000" }));
  spawnSync(process.execPath, [STOP, "--run", runId, "--child", out.childId], { encoding: "utf8" });

  // Give the watcher time to see the exit and write its own status.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    execFileSync(process.execPath, ["-e", "setTimeout(()=>{},200)"]);
    if (readRegistry(runId).children[out.childId].endedAt) break;
  }
  const entry = readRegistry(runId).children[out.childId];
  if (entry.status !== "stopped") {
    fail(`deliberate stop was recorded as "${entry.status}" — it would read as a failure in the digest`);
  }
});

test("stopping an unknown child names what it knows", () => {
  const runId = fixtureRun();
  const r = spawnSync(process.execPath, [STOP, "--run", runId, "--child", "ghost"], { encoding: "utf8" });
  if (r.status !== 1) fail(`expected exit 1, got ${r.status}`);
  const out = parse(r);
  if (!Array.isArray(out.known)) fail("error does not list the known children");
});

// ── summary ──────────────────────────────────────────────────────────────────
for (const dir of cleanup) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort — temp dirs and worktrees can hold locks briefly on win32 */
  }
}

console.log("");
if (failures.length) {
  console.log(`${passed} passed, ${failures.length} FAILED`);
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);
