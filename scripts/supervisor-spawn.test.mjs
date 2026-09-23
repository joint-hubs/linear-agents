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
import { delimiter, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { SUPERVISOR_DENY, buildChildSettings, childSettingsPath, readHeld, readRegistry, runDir } from "./supervisor-lib.mjs";
import { makeFakeCodegraphCli } from "./fixtures/codegraph-fake-cli.mjs";

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
        // The codegraph preflight has `initialize: true` and this machine has
        // the real CLI on PATH — without this seam every mock test below would
        // provision a REAL index in its fixture repo. The readiness tests at
        // the bottom turn the seam off and use the fake CLI instead.
        LA_SUPERVISOR_NO_CODEGRAPH: "1",
        MOCK_CLAUDE_HANG_MS: "4000",
        ...env,
      },
    },
  );
}

// A DEV candidate for the --candidate tests (FOC-406): a second commit on the
// branch a DEV child would own (foc-123-dev), while the Supervisor's tree stays
// on main at the base commit — so the pin is observable as a diff between the
// base revision and the candidate. Returns the candidate commit sha.
function fixtureCandidate(repo) {
  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("checkout", "-b", "foc-123-dev");
  writeFileSync(join(repo, "candidate.txt"), "candidate\n");
  git("add", "-A");
  git("commit", "-m", "candidate");
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  git("checkout", "main");
  return sha;
}

const shaOf = (ref, cwd) =>
  execFileSync("git", ["rev-parse", ref], { cwd, encoding: "utf8" }).trim();

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
    { encoding: "utf8", env: { ...process.env, LA_CLAUDE_BIN: MOCK, LA_SUPERVISOR_NO_TELEMETRY: "1", LA_SUPERVISOR_NO_CODEGRAPH: "1" } },
  );
  if (r.status !== 1) fail(`expected exit 1, got ${r.status}`);
  if (!parse(r).error.includes("TEAM-NUM")) fail("error did not explain the expected format");
});

test("a second live child is HELD by the semaphore, not refused (FOC-161)", () => {
  // This used to assert the one-live-child CONSTANT and the message naming
  // FOC-161 as the task that would lift it. That task landed: the limit now
  // comes from `nodes.dev.concurrency` in config/graph.json and a blocked spawn
  // is held rather than refused. Rewritten rather than deleted — the behaviour
  // it guards (a second child does not just start) still has to be guarded.
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  const first = parse(runSpawn(runId, repo));
  if (!first.ok) fail("first spawn failed");

  const second = runSpawn(runId, repo, ["--task", "FOC-124", "--child", "dev-2"]);
  // Held is not a failure: exit 0, ok true, and a record on disk.
  if (second.status !== 0) fail(`expected exit 0 for a held request, got ${second.status}`);
  const out = parse(second);
  if (out.held !== true) fail(`expected held:true, got ${JSON.stringify(out)}`);
  if (out.reason !== "node-full") fail(`expected reason node-full, got ${out.reason}`);
  // The limit has to be traceable to the graph, or the next reader looks for a
  // constant that no longer exists.
  if (!/graph\.json/.test(out.detail)) fail(`detail does not name where the limit lives: ${out.detail}`);
  if (!out.heldId) fail("no heldId to release later");

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

// Run a93f, 2026-09-12: four children spawned without --model ran on the
// Supervisor's own deepseek-v4.1-flash (inherited ANTHROPIC_MODEL) while the
// registry recorded `model: null`.
test("without --model the registry records the model the child inherits, and says so", () => {
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  const r = runSpawn(runId, repo, [], { ANTHROPIC_MODEL: "supervisor/own-model" });
  const out = parse(r);
  const entry = readRegistry(runId).children[out.childId];
  if (entry.model !== "supervisor/own-model") fail(`registry model was ${entry.model}`);
  if (entry.modelSource !== "inherited:ANTHROPIC_MODEL") fail(`modelSource was ${entry.modelSource}`);
  if (!/no --model/.test(r.stderr)) fail(`no warning on stderr: ${r.stderr}`);
  spawnSync(process.execPath, [STOP, "--run", runId, "--child", out.childId], { encoding: "utf8" });
});

test("an explicit --model wins over the inherited one and draws no warning", () => {
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  const r = runSpawn(runId, repo, ["--model", "z-ai/glm-5.3-flash"], { ANTHROPIC_MODEL: "supervisor/own-model" });
  const out = parse(r);
  const entry = readRegistry(runId).children[out.childId];
  if (entry.model !== "z-ai/glm-5.3-flash") fail(`registry model was ${entry.model}`);
  if (entry.modelSource !== "--model") fail(`modelSource was ${entry.modelSource}`);
  if (/no --model/.test(r.stderr)) fail("warned although --model was given");
  spawnSync(process.execPath, [STOP, "--run", runId, "--child", out.childId], { encoding: "utf8" });
});

// ── --candidate: pin the worktree at the DEV candidate (FOC-406) ─────────────
// Without the flag a REVIEW/TEST worktree starts at the base revision and the
// reviewer has to checkout the candidate by hand — and nothing fails when they
// forget. With it, the branch is CREATED at the resolved commit, or the spawn
// refuses; it never falls back to the base revision.
console.log("\n--candidate pins the worktree at the DEV candidate");

test("a --candidate sha starts a fresh worktree at that commit (FOC-406)", () => {
  const { repo } = fixtureRepo();
  const candidate = fixtureCandidate(repo);
  const runId = fixtureRun();
  const out = parse(runSpawn(runId, repo, ["--squad", "review", "--child", "review-1", "--candidate", candidate]));

  if (!out.ok) fail(`spawn failed: ${out.error}`);
  if (!out.worktreeCreated) fail("expected a fresh worktree");
  if (out.baseRevision !== candidate) fail(`baseRevision was ${out.baseRevision}, not the candidate`);
  if (out.branch === "foc-123-dev") fail(`the review child took the DEV branch name: ${out.branch}`);
  if (shaOf("HEAD", out.worktree) !== candidate) fail("worktree HEAD is not the candidate");
  // The prologue the child is told must pin the same commit the result claims.
  const entry = readRegistry(runId).children[out.childId];
  if (!entry.pinnedStateVerification.prologue.includes(`base-revision: ${candidate}`)) {
    fail("prologue does not pin the candidate");
  }

  spawnSync(process.execPath, [STOP, "--run", runId, "--child", out.childId], { encoding: "utf8" });
});

test("a --candidate branch name resolves to its commit (FOC-406)", () => {
  const { repo } = fixtureRepo();
  const candidate = fixtureCandidate(repo);
  const runId = fixtureRun();
  const out = parse(runSpawn(runId, repo, ["--squad", "review", "--child", "review-1", "--candidate", "foc-123-dev"]));

  if (!out.ok) fail(`spawn failed: ${out.error}`);
  if (!out.worktreeCreated) fail("expected a fresh worktree");
  if (out.baseRevision !== candidate) fail(`baseRevision was ${out.baseRevision}, not the branch tip`);
  if (shaOf("HEAD", out.worktree) !== candidate) fail("worktree HEAD is not the branch tip");

  spawnSync(process.execPath, [STOP, "--run", runId, "--child", out.childId], { encoding: "utf8" });
});

test("an unresolvable --candidate refuses and names the input (FOC-406)", () => {
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  const r = runSpawn(runId, repo, ["--candidate", "no-such-sha-or-branch"]);
  if (r.status !== 1) fail(`expected exit 1, got ${r.status}`);
  const out = parse(r);
  if (out.ok !== false) fail(`expected ok:false, got ${JSON.stringify(out)}`);
  if (!/no-such-sha-or-branch/.test(out.error)) fail("error does not name the unresolved input");
  if (!/candidate-unresolved/.test(out.error)) fail("error carries no stable reason slug");
  if (Object.keys(readRegistry(runId).children).length) fail("a child was registered anyway");
});

test("--candidate without a value is refused, not read as boolean true (FOC-406)", () => {
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  const r = runSpawn(runId, repo, ["--candidate"]);
  if (r.status !== 1) fail(`expected exit 1, got ${r.status}`);
  const out = parse(r);
  if (!/needs a value/.test(out.error)) fail(`unhelpful error: ${out.error}`);
});

test("--candidate refuses a branch a recorded child already owns (FOC-406)", () => {
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  const first = parse(runSpawn(runId, repo)); // DEV child, branch foc-123-dev
  if (!first.ok) fail(`first spawn failed: ${first.error}`);
  spawnSync(process.execPath, [STOP, "--run", runId, "--child", first.childId], { encoding: "utf8" });

  // Same slug → the same branch name; a candidate spawn must not land a second
  // child on a branch another child of this run already owns.
  const r = runSpawn(runId, repo, ["--slug", "dev", "--candidate", "main"]);
  if (r.status !== 1) fail(`expected exit 1, got ${r.status}`);
  const out = parse(r);
  if (!/candidate-branch-collision/.test(out.error)) fail(`no collision slug: ${out.error}`);
  if (!/foc-123-dev/.test(out.error)) fail("error does not name the conflicting branch");
});

test("--candidate refuses to reuse a worktree standing at the wrong commit (FOC-406)", () => {
  const { repo } = fixtureRepo();
  const runA = fixtureRun();
  const first = parse(runSpawn(runA, repo)); // creates the worktree on foc-123-dev at the base commit
  spawnSync(process.execPath, [STOP, "--run", runA, "--child", first.childId], { encoding: "utf8" });

  // A commit the standing worktree does not have. The second run's registry is
  // empty, so the collision guard cannot fire before the reuse check.
  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  writeFileSync(join(repo, "candidate.txt"), "candidate\n");
  git("add", "-A");
  git("commit", "-m", "candidate");
  const candidate = shaOf("HEAD", repo);

  const runB = fixtureRun();
  const r = runSpawn(runB, repo, ["--slug", "dev", "--candidate", candidate]);
  if (r.status !== 1) fail(`expected exit 1, got ${r.status}`);
  const out = parse(r);
  if (!/candidate-head-mismatch/.test(out.error)) fail(`no mismatch slug: ${out.error}`);
});

test("a held --candidate request records the flag for replay (FOC-406)", () => {
  const { repo } = fixtureRepo();
  const candidate = fixtureCandidate(repo);
  const runId = fixtureRun();
  const first = parse(runSpawn(runId, repo, [], { MOCK_CLAUDE_HANG_MS: "20000" }));
  if (!first.ok) fail(`first spawn failed: ${first.error}`);

  const second = runSpawn(runId, repo, ["--task", "FOC-124", "--candidate", candidate, "--child", "dev-2"]);
  if (parse(second).held !== true) fail("second spawn was not held");
  const [held] = readHeld(runId);
  // The record replays the request verbatim — the candidate must ride along,
  // or the released child would silently start at the base revision.
  if (!held.argv.includes("--candidate")) fail(`held argv lost --candidate: ${JSON.stringify(held.argv)}`);
  if (!held.argv.includes(candidate)) fail(`held argv lost the candidate value: ${JSON.stringify(held.argv)}`);

  spawnSync(process.execPath, [STOP, "--run", runId, "--child", first.childId], { encoding: "utf8" });
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
// Moved to scripts/supervisor-stop.test.mjs (FOC-127): stop has its own script,
// so it gets its own suite, and the "what stop must NOT do" cases needed room.

// ── P9: the generated deny list ──────────────────────────────────────────────
// The push gate must hold whether or not the child cooperates, so it lives in a
// settings file the child does not write.
console.log("\nP9 — wygenerowana lista deny");

test("buildChildSettings unions squad denies with the Supervisor's, deduped", () => {
  const out = buildChildSettings({ permissions: { deny: ["Bash(rm -rf:*)", "Bash(git push:*)"] } });
  const deny = out.permissions.deny;
  // The squad's own rules come first and keep their order; git push appears once
  // even though both lists carry it.
  if (deny[0] !== "Bash(rm -rf:*)" || deny[1] !== "Bash(git push:*)") {
    fail(`squad denies lost their order: ${JSON.stringify(deny)}`);
  }
  if (deny.filter((r) => r === "Bash(git push:*)").length !== 1) fail(`not deduped: ${JSON.stringify(deny)}`);
  for (const rule of SUPERVISOR_DENY) if (!deny.includes(rule)) fail(`missing ${rule}`);
});

test("the generated file is deny-only — no allow, no hooks", () => {
  // `claude --settings` loads ADDITIONAL settings. An allow entry here could only
  // grant, never remove; a repeated hooks block risks the SessionStart telemetry
  // hook firing twice and double-counting the run.
  const out = buildChildSettings({
    permissions: { allow: ["Bash(node:*)"], deny: [] },
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: "x" }] }] },
    theme: "dark",
  });
  if (JSON.stringify(Object.keys(out)) !== '["permissions"]') fail(`extra keys: ${Object.keys(out)}`);
  if (JSON.stringify(Object.keys(out.permissions)) !== '["deny"]') fail(`not deny-only: ${Object.keys(out.permissions)}`);
});

test("the Supervisor's denies survive a squad file that is missing or corrupt", () => {
  // Half the guarantee is the Supervisor's own list; an unparseable squad file
  // must not silently reduce it to nothing.
  for (const base of [{}, undefined, { permissions: null }]) {
    const deny = buildChildSettings(base).permissions.deny;
    for (const rule of SUPERVISOR_DENY) if (!deny.includes(rule)) fail(`missing ${rule} for ${JSON.stringify(base)}`);
  }
});

test("regenerating produces a byte-identical file", () => {
  // A file that churns on every spawn is a file nobody can diff.
  const squad = { permissions: { deny: ["Bash(rm -rf:*)"] } };
  const a = JSON.stringify(buildChildSettings(squad));
  const b = JSON.stringify(buildChildSettings(squad));
  if (a !== b) fail("two builds disagree");
});

test("spawn writes the file and points claude at it", () => {
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  const argvFile = join(mkdtempSync(join(tmpdir(), "la-argv-")), "argv.json");
  const out = parse(runSpawn(runId, repo, [], { MOCK_CLAUDE_ARGV_FILE: argvFile, MOCK_CLAUDE_HANG_MS: "0" }));

  const path = childSettingsPath(runId, out.childId);
  if (!existsSync(path)) fail(`no generated settings at ${path}`);
  const written = JSON.parse(readFileSync(path, "utf8"));
  for (const rule of SUPERVISOR_DENY) {
    if (!written.permissions.deny.includes(rule)) fail(`generated file is missing ${rule}`);
  }

  // The registry records the GENERATED path, which is what supervisor-followup
  // reuses — a follow-up under a looser settings file would be a hole in P9.
  if (readRegistry(runId).children[out.childId].settings !== path) fail("registry does not point at the generated file");

  const argv = JSON.parse(readFileSync(argvFile, "utf8"));
  const at = argv.indexOf("--settings");
  if (at === -1) fail(`claude was invoked without --settings: ${JSON.stringify(argv)}`);
  if (argv[at + 1] !== path) fail(`--settings pointed at ${argv[at + 1]}`);

  spawnSync(process.execPath, [STOP, "--run", runId, "--child", out.childId], { encoding: "utf8" });
});

test("--settings can only tighten: it is folded in, never substituted", () => {
  // There must be no flag that hands a child the push it is not allowed to have.
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  const extra = join(mkdtempSync(join(tmpdir(), "la-extra-")), "extra.json");
  writeFileSync(extra, JSON.stringify({ permissions: { allow: ["Bash(git push:*)"], deny: ["Bash(curl:*)"] } }));

  const out = parse(runSpawn(runId, repo, ["--settings", extra], { MOCK_CLAUDE_HANG_MS: "0" }));
  const written = JSON.parse(readFileSync(childSettingsPath(runId, out.childId), "utf8"));
  if (!written.permissions.deny.includes("Bash(curl:*)")) fail("the extra file's deny was dropped");
  if (!written.permissions.deny.includes("Bash(git push:*)")) fail("the extra file's allow overrode the push deny");
  if (written.permissions.allow) fail("an allow entry reached the generated file");

  spawnSync(process.execPath, [STOP, "--run", runId, "--child", out.childId], { encoding: "utf8" });
});

test("every squad's committed settings.json already denies git push", () => {
  // The generated file is a second layer, not the only one. If a squad ever
  // loses its own deny, the union still covers it — but the drift is worth
  // knowing about, because the squad also runs standalone from bin/<squad>.bat,
  // where no generated file exists at all.
  for (const squad of ["plan", "dev", "review", "test"]) {
    const deny = JSON.parse(readFileSync(join(ROOT, "agents", squad, "settings.json"), "utf8")).permissions?.deny ?? [];
    if (!deny.includes("Bash(git push:*)")) fail(`agents/${squad}/settings.json no longer denies git push`);
  }
});

// ── CodeGraph launch readiness (plan §4) ─────────────────────────────────────
// runSpawn defaults to LA_SUPERVISOR_NO_CODEGRAPH=1, so the tests above never
// provision a real index. The ones below are the only place the preflight runs —
// against the fake CLI (fixtures/codegraph-fake-cli.mjs), which records every
// call it receives; the real bundle stays behind it on PATH and is never hit.
console.log("\nCodeGraph launch readiness");

const norm = (p) => String(p).replace(/\\/g, "/").toLowerCase();

function fakeCodegraphEnv({ mode = "ready" } = {}) {
  const base = mkdtempSync(join(tmpdir(), "la-cg-"));
  cleanup.push(base);
  const logPath = join(base, "log.jsonl");
  const fake = makeFakeCodegraphCli({ dir: join(base, "bin"), mode, logPath });
  return {
    env: {
      PATH: `${fake.dir}${delimiter}${process.env.PATH}`,
      LA_SUPERVISOR_NO_CODEGRAPH: "0",
      ...fake.env,
    },
    readLog: () => fake.readLog(readFileSync),
  };
}

test("the seam skips the preflight — no index is ever provisioned in a mock suite", () => {
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  const out = parse(runSpawn(runId, repo, [], { MOCK_CLAUDE_HANG_MS: "0" }));
  const cg = out.codegraph;
  if (cg?.skipped !== true) fail(`the preflight ran anyway: ${JSON.stringify(cg)}`);
  if (!cg.reason.includes("LA_SUPERVISOR_NO_CODEGRAPH")) fail(`reason does not name the seam: ${cg.reason}`);
  if (!cg.kickoff.includes("SKIPPED")) fail(`kickoff does not say SKIPPED:\n${cg.kickoff}`);
  if (existsSync(join(out.worktree, ".codegraph"))) fail("a mock-suite worktree got an index");
  spawnSync(process.execPath, [STOP, "--run", runId, "--child", out.childId], { encoding: "utf8" });
});

test("a NEW worktree: init -y at the worktree once, ready kickoff, no approval for an unguarded target", () => {
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  const fake = fakeCodegraphEnv({ mode: "ready" });
  const out = parse(runSpawn(runId, repo, [], { ...fake.env, MOCK_CLAUDE_HANG_MS: "0" }));

  const cg = out.codegraph;
  if (cg.ok !== true) fail(`preflight not ready: ${JSON.stringify(cg)}`);
  if (cg.initialized !== true) fail("the index was not reported as initialized");
  if (cg.synced !== false) fail("a clean worktree needed a sync?");
  if (cg.version !== "fake-1.6.0") fail(`unexpected CLI version: ${cg.version}`);
  if (!cg.kickoff.includes("status: ready") || !cg.kickoff.includes("graph-first")) {
    fail(`kickoff does not route graph-first:\n${cg.kickoff}`);
  }
  if (!existsSync(join(out.worktree, ".codegraph", "fake-initialized"))) fail("no index marker in the worktree");

  const calls = fake.readLog();
  const init = calls.find((c) => c.cmd === "init" && !c.args.includes("--help"));
  if (!init) fail(`the index was never provisioned: ${JSON.stringify(calls)}`);
  if (init.args[0] !== "-y") fail(`init was not non-interactive: ${JSON.stringify(init)}`);
  if (norm(init.args[init.args.length - 1]) !== norm(out.worktree)) fail(`init addressed the wrong root: ${JSON.stringify(init)}`);
  for (const c of calls) {
    const rootArg = c.args.find((a) => !a.startsWith("-"));
    if (rootArg && norm(rootArg) !== norm(out.worktree)) fail(`a call addressed another root: ${JSON.stringify(c)}`);
  }

  // The fixture has no .mcp.json: no approval may happen — and none may be
  // attempted against the real agents/dev config either.
  const mcp = cg.mcp;
  if (mcp.ok !== false || mcp.written !== false) fail(`unguarded target was approved: ${JSON.stringify(mcp)}`);
  if (!cg.kickoff.includes("mcp: not approved")) fail("kickoff does not show the CLI fallback");
  spawnSync(process.execPath, [STOP, "--run", runId, "--child", out.childId], { encoding: "utf8" });
});

test("a degraded index is DEGRADED-UNKNOWN with sanctioned Read/Grep — the spawn still proceeds", () => {
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  const fake = fakeCodegraphEnv({ mode: "degraded" });
  const r = runSpawn(runId, repo, [], { ...fake.env, MOCK_CLAUDE_HANG_MS: "0" });
  if (r.status !== 0) fail(`a degraded index refused the spawn (exit ${r.status}):\n${r.stdout}\n${r.stderr}`);
  const out = parse(r);
  const cg = out.codegraph;
  if (cg.ok !== false) fail("degraded readiness reported ok");
  if (!String(cg.reason ?? "").startsWith("pending-after-sync")) fail(`unexpected reason: ${cg.reason}`);
  if (!cg.kickoff.includes("DEGRADED-UNKNOWN")) fail("kickoff does not shout DEGRADED-UNKNOWN");
  if (!cg.kickoff.includes("Read/Grep are SANCTIONED")) fail("kickoff does not sanction the fallback");
  if (!fake.readLog().some((c) => c.cmd === "sync")) fail("the degraded index was never synced");
  spawnSync(process.execPath, [STOP, "--run", runId, "--child", out.childId], { encoding: "utf8" });
});

test("a REUSED worktree is re-checked at launch — status only, same root, never a second init", () => {
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  const first = fakeCodegraphEnv({ mode: "ready" });
  const out1 = parse(runSpawn(runId, repo, ["--child", "dev-1"], { ...first.env, MOCK_CLAUDE_HANG_MS: "0" }));
  spawnSync(process.execPath, [STOP, "--run", runId, "--child", out1.childId], { encoding: "utf8" });

  const reuse = fakeCodegraphEnv({ mode: "ready" });
  const out2 = parse(runSpawn(runId, repo, ["--child", "dev-2"], { ...reuse.env, MOCK_CLAUDE_HANG_MS: "0" }));
  if (out2.worktreeCreated !== false) fail("the second spawn created a new worktree instead of reusing");
  if (norm(out2.worktree) !== norm(out1.worktree)) fail("the second spawn used a different worktree");
  const cg = out2.codegraph;
  if (cg.ok !== true) fail(`reused worktree not ready: ${JSON.stringify(cg)}`);
  if (cg.synced !== false) fail("a settled worktree was synced for no reason");

  const calls = reuse.readLog();
  if (!calls.some((c) => c.cmd === "status")) fail("the reused worktree was not re-checked at launch");
  if (calls.some((c) => c.cmd === "init")) fail(`once per MISSING index only — init ran again: ${JSON.stringify(calls)}`);
  for (const c of calls) {
    const rootArg = c.args.find((a) => !a.startsWith("-"));
    if (rootArg && norm(rootArg) !== norm(out2.worktree)) fail(`a call addressed another root: ${JSON.stringify(c)}`);
  }
  spawnSync(process.execPath, [STOP, "--run", runId, "--child", out2.childId], { encoding: "utf8" });
});

test("a guarded .mcp.json at the target gets codegraph approved in the config dir AND the worktree's settings.local.json", () => {
  const { repo } = fixtureRepo();
  // The guarded boundary entry, committed so it rides into the worktree.
  writeFileSync(
    join(repo, ".mcp.json"),
    JSON.stringify({
      mcpServers: { codegraph: { command: "node", args: ["scripts/mcp/server-codegraph.mjs"] } },
    }),
  );
  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("add", "-A");
  git("commit", "-m", "mcp");

  const runId = fixtureRun();
  const fake = fakeCodegraphEnv({ mode: "ready" });
  const configDir = mkdtempSync(join(tmpdir(), "la-mcp-"));
  cleanup.push(configDir);
  const configPath = join(configDir, ".claude.json");
  const seed = {
    helper: { keep: "me" },
    projects: {
      "C:/Users/elsewhere/other": { enabledMcpjsonServers: ["linear"], hasTrustDialogAccepted: true },
    },
  };
  writeFileSync(configPath, JSON.stringify(seed, null, 2) + "\n");

  const out = parse(runSpawn(runId, repo, [], { ...fake.env, MOCK_CLAUDE_HANG_MS: "0", LA_SUPERVISOR_MCP_CONFIG_DIR: configDir }));
  const mcp = out.codegraph.mcp;
  if (mcp.ok !== true || mcp.written !== true) fail(`guarded target not approved: ${JSON.stringify(mcp)}`);
  if (!out.codegraph.kickoff.includes("mcp: approved for this worktree")) fail("kickoff does not say the MCP is live");

  const cfg = JSON.parse(readFileSync(configPath, "utf8"));
  const wtKey = Object.keys(cfg.projects).find((k) => norm(k) === norm(out.worktree));
  if (!wtKey) fail(`no project key for the worktree: ${JSON.stringify(Object.keys(cfg.projects))}`);
  if (JSON.stringify(cfg.projects[wtKey].enabledMcpjsonServers) !== JSON.stringify(["codegraph"])) {
    fail(`enabled the wrong servers: ${JSON.stringify(cfg.projects[wtKey].enabledMcpjsonServers)}`);
  }
  if (cfg.projects[wtKey].hasTrustDialogAccepted !== true) fail("trust dialog not accepted");
  // The 2.1.280 half: without enabledMcpjsonServers in the worktree's own
  // .claude/settings.local.json the trusted server still shows ⏸ Pending.
  const local = JSON.parse(readFileSync(join(out.worktree, ".claude", "settings.local.json"), "utf8"));
  if (JSON.stringify(local.enabledMcpjsonServers) !== JSON.stringify(["codegraph"])) {
    fail(`the worktree's settings.local.json is wrong: ${JSON.stringify(local)}`);
  }
  if (JSON.stringify(cfg.projects["C:/Users/elsewhere/other"]) !== JSON.stringify(seed.projects["C:/Users/elsewhere/other"])) {
    fail("an unrelated project entry was touched");
  }
  if (JSON.stringify(cfg.helper) !== JSON.stringify(seed.helper)) fail("global keys were not preserved");
  spawnSync(process.execPath, [STOP, "--run", runId, "--child", out.childId], { encoding: "utf8" });
});

test("a target without the guarded .mcp.json gets NO approval and the config file is byte-identical", () => {
  const { repo } = fixtureRepo(); // no .mcp.json committed
  const runId = fixtureRun();
  const fake = fakeCodegraphEnv({ mode: "ready" });
  const configDir = mkdtempSync(join(tmpdir(), "la-mcp-"));
  cleanup.push(configDir);
  const configPath = join(configDir, ".claude.json");
  writeFileSync(configPath, JSON.stringify({ projects: {} }, null, 2) + "\n");
  const before = readFileSync(configPath, "utf8");

  const out = parse(runSpawn(runId, repo, [], { ...fake.env, MOCK_CLAUDE_HANG_MS: "0", LA_SUPERVISOR_MCP_CONFIG_DIR: configDir }));
  const mcp = out.codegraph.mcp;
  if (mcp.ok !== false || mcp.written !== false) fail(`unguarded target was approved: ${JSON.stringify(mcp)}`);
  if (!String(mcp.reason ?? "").includes("guarded codegraph MCP")) fail(`reason does not say why: ${mcp.reason}`);
  if (readFileSync(configPath, "utf8") !== before) fail("the config was rewritten despite refusing");
  if (existsSync(join(out.worktree, ".claude"))) fail("an unguarded worktree got a .claude dir anyway");
  if (!out.codegraph.kickoff.includes("mcp: not approved")) fail("kickoff does not show the CLI fallback");
  spawnSync(process.execPath, [STOP, "--run", runId, "--child", out.childId], { encoding: "utf8" });
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
