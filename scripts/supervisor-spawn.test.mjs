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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ensureWorktree,
  PRINT_BG_WAIT_CEILING_MS,
  PRINT_BG_WAIT_ENV,
  SUPERVISOR_DENY,
  TURN_END_CONTRACT,
  WORKING_STATE_SESSION_START_HOOK,
  buildChildSettings,
  childSettingsPath,
  heldDir,
  printBgWaitCeilingEnv,
  readHeld,
  readHolds,
  readRegistry,
  registryPath,
  runDir,
} from "./supervisor-lib.mjs";
import { openAgentState } from "./agent-state.mjs";
import { makeFakeCodegraphCli } from "./fixtures/codegraph-fake-cli.mjs";
import { readFocus } from "./supervisor-focus.mjs";
import { scrubbedEnv } from "./supervisor-test-fixtures.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SPAWN = join(ROOT, "scripts", "supervisor-spawn.mjs");
const STOP = join(ROOT, "scripts", "supervisor-stop.mjs");
const MOCK = join(ROOT, "scripts", "mock-claude.mjs");
const REAL_REGISTRY = join(ROOT, "config", "agent-state.json");

// FOC-802 M3: the run-dir mode assertions below pin 02775 (setgid + group
// write) and 0644 — under a default umask of 022 the group-write bit would be
// stripped at creation and the pinned shape unreadable. The container runs
// umask 0002; the test process's umask is inherited by every spawned child, so
// setting it here reproduces that exactly. POSIX only — Windows ignores modes.
if (process.platform !== "win32") process.umask(0o002);

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

// FOC-729: spawn seeds the working-state store — point LA_AGENT_STATE_DB at a
// temp dir so no case writes the repo's real .state/agent-state/. Cases that
// need a specific store (the seeding assertion, the broken store) override it
// in their own env.
const AGENT_STATE_DB_DIR = mkdtempSync(join(tmpdir(), "la-sup-agent-state-"));
cleanup.push(AGENT_STATE_DB_DIR);

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
function fixtureRun({ triage = true, runId } = {}) {
  // `runId` override: the auto-focus tests need a run id that matches the
  // RUN_ID_RE shape (supervisor-focus refuses others), which the counter ids
  // below deliberately do not have.
  const id = runId ?? `test-${process.pid}-${Date.now()}-${runCounter++}`;
  const dir = runDir(id);
  // The run DIR only. The shared subdirs (children/gates/verdicts/launch) are
  // left to ensureRunDir — spawn's first write — because the FOC-802 M3 mode
  // test pins the modes THAT function creates them with; pre-creating them
  // here would mask those modes behind this process's mkdir.
  mkdirSync(dir, { recursive: true });
  if (triage) {
    writeFileSync(join(dir, "triage.json"), JSON.stringify({ issue: "FOC-123", verdict: "dev" }));
  }
  cleanup.push(dir);
  return id;
}

// A run id that matches RUN_ID_RE (supervisor-current-run.mjs) — the shape the
// focus declaration refuses to work without.
const validRunId = (n) => `2026-10-13T10-00-00-000-supervisor-000${n}`;

function runSpawn(runId, repo, extra = [], env = {}) {
  return spawnSync(
    process.execPath,
    [SPAWN, "--run", runId, "--squad", "dev", "--task", "FOC-123", "--prompt", "kickoff", "--repo", repo, ...extra],
    {
      encoding: "utf8",
      env: {
        ...scrubbedEnv(), OPENROUTER_API_KEY: "test-supervisor-provider-key",
        LA_CLAUDE_BIN: MOCK,
        LA_AGENT_STATE_DB: join(AGENT_STATE_DB_DIR, "agent-state.sqlite"),
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
    { encoding: "utf8", env: { ...scrubbedEnv(), OPENROUTER_API_KEY: "test-supervisor-provider-key", LA_CLAUDE_BIN: MOCK, LA_SUPERVISOR_NO_TELEMETRY: "1", LA_SUPERVISOR_NO_CODEGRAPH: "1" } },
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

test("a launch dir left by an earlier attempt for this child id is skipped, not re-prepared (FOC-989)", () => {
  // In Docker the earlier attempt's dir was handed over to fenix-child, so
  // preparing INTO it died on EPERM. The behaviour that makes that irrelevant:
  // the occupied dir is left alone and the child launches from the next free one.
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  const occupied = join(runDir(runId), "launch", "dev-9", "turn-0");
  mkdirSync(occupied, { recursive: true });
  writeFileSync(join(occupied, "CLAUDE.md"), "left by the failed attempt");

  const r = runSpawn(runId, repo, ["--child", "dev-9"]);
  const out = parse(r);
  if (!out.ok) fail(`spawn failed: ${out.error}`);

  const entry = readRegistry(runId).children[out.childId];
  if (entry.launchConfigDir === occupied) fail("the launch was prepared into the occupied dir");
  if (!/turn-0-r1$/.test(entry.launchConfigDir)) fail(`unexpected launch dir: ${entry.launchConfigDir}`);
  if (readFileSync(join(occupied, "CLAUDE.md"), "utf8") !== "left by the failed attempt") fail("the occupied dir was modified");
  if (!/already exists/.test(r.stderr)) fail(`the reuse avoidance was silent: ${r.stderr}`);

  spawnSync(process.execPath, [STOP, "--run", runId, "--child", out.childId], { encoding: "utf8" });
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

// Branches are unique per attempt now: the managed branch carries a sha256
// hash of `runId:childId`, so two children — even with the same slug, even in
// two runs — never share a worktree, and the owner claim (ensureWorktree's
// ownerId) vouches for it. Reuse survives only as a RETRY of the same
// run:child. What must not regress is the original failure this test guarded:
// the main tree's HEAD/branch moving while a run is live.
test("a second child resolves to its OWN worktree and leaves the main tree's HEAD untouched", () => {
  const { repo } = fixtureRepo();
  const headBefore = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  const branchBefore = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

  const runA = fixtureRun();
  const first = parse(runSpawn(runA, repo));
  spawnSync(process.execPath, [STOP, "--run", runA, "--child", first.childId], { encoding: "utf8" });

  const runB = fixtureRun();
  const second = parse(runSpawn(runB, repo));

  if (!second.worktreeCreated) fail("expected a fresh worktree — a new run:child never reuses another child's checkout");
  if (second.worktree === first.worktree) fail("two run:child attempts shared one checkout");
  // Same slug, same task → the same BASE branch name, but the per-child hash
  // suffix must differ, or the second child would land on the first's branch.
  if (!second.branch.startsWith("foc-123-dev-")) fail(`unexpected branch name: ${second.branch}`);
  if (!/-[0-9a-f]{12}$/.test(second.branch)) fail(`branch carries no attempt hash: ${second.branch}`);
  if (second.branch === first.branch) fail(`two children got one branch: ${second.branch}`);

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
// registry recorded `model: null`. FOC-762 closes the hole from the other
// side: the Supervisor's ANTHROPIC_MODEL is never the answer — the child runs
// on the routing table's pick, and the source is recorded.
test("without --model the child runs on the routing table's pick, never the Supervisor's model", () => {
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  const dir = mkdtempSync(join(tmpdir(), "la-sup-model-"));
  cleanup.push(dir);
  const configPath = join(dir, "models.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      providers: {
        openrouter: { baseUrl: "http://127.0.0.1:9/api", authEnv: "OPENROUTER_API_KEY", authStyle: "token" },
      },
      ids: { routed: "routed/from-fixture" },
      routing: { dev: { worker: "routed" } },
    }),
  );
  const r = runSpawn(runId, repo, [], {
    ANTHROPIC_MODEL: "supervisor/own-model",
    LA_PROVIDER_CONFIG: configPath,
  });
  const out = parse(r);
  const entry = readRegistry(runId).children[out.childId];
  if (entry.model !== "routed/from-fixture") fail(`registry model was ${entry.model}`);
  if (entry.modelSource !== "routing:dev") fail(`modelSource was ${entry.modelSource}`);
  if (!/no --model/.test(r.stderr)) fail(`no warning on stderr: ${r.stderr}`);
  spawnSync(process.execPath, [STOP, "--run", runId, "--child", out.childId], { encoding: "utf8" });
});

test("an explicit --model wins over the inherited one and draws no warning", () => {
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  // FOC-607: a dev squad may not take --model at all, so the explicit-id path
  // is pinned on a squad that accepts it (plan) with a PRICED id from the
  // repo's own config/models.json (LA_MODELS_ROOT unset → the repo's config).
  const r = runSpawn(runId, repo, ["--squad", "plan", "--model", "z-ai/glm-5.3-flash"], {
    ANTHROPIC_MODEL: "supervisor/own-model",
  });
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

// The per-child attempt hash made "a second child with the same slug" a NEW
// branch, so the old collision refusal is not the second child's story anymore.
// What must hold instead: the second --candidate child gets its OWN independent
// workspace pinned at the candidate, the first child's tree is never reset,
// and a duplicate explicit --child is still refused rather than overwritten.
test("a second --candidate child gets its own workspace and never resets another child's (FOC-406)", () => {
  const { repo } = fixtureRepo();
  const candidate = fixtureCandidate(repo);
  const runId = fixtureRun();
  const first = parse(runSpawn(runId, repo)); // DEV child, its own branch at the base commit
  if (!first.ok) fail(`first spawn failed: ${first.error}`);
  spawnSync(process.execPath, [STOP, "--run", runId, "--child", first.childId], { encoding: "utf8" });

  const second = parse(runSpawn(runId, repo, ["--slug", "dev", "--candidate", candidate]));
  if (!second.ok) fail(`second spawn failed: ${second.error}`);
  if (second.worktree === first.worktree) fail("the second child landed in the first child's worktree");
  if (second.branch === first.branch) fail(`two children got one branch: ${second.branch}`);
  if (second.baseRevision !== candidate) fail(`baseRevision was ${second.baseRevision}, not the candidate`);
  if (shaOf("HEAD", second.worktree) !== candidate) fail("second worktree HEAD is not the candidate");
  // "No other's reset": the first child's tree still stands where it did.
  if (shaOf("HEAD", first.worktree) !== first.baseRevision) fail("the first child's worktree was reset");

  spawnSync(process.execPath, [STOP, "--run", runId, "--child", second.childId], { encoding: "utf8" });
});

test("a duplicate explicit --child is refused, never overwritten", () => {
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  const first = parse(runSpawn(runId, repo, [], { MOCK_CLAUDE_HANG_MS: "20000" }));
  if (!first.ok) fail(`first spawn failed: ${first.error}`);

  const r = runSpawn(runId, repo, ["--child", first.childId]);
  if (r.status !== 1) fail(`expected exit 1, got ${r.status}`);
  const out = parse(r);
  if (out.reason !== "duplicate-child-id") fail(`no duplicate-child-id reason: ${out.error}`);
  const children = readRegistry(runId).children;
  if (Object.keys(children).length !== 1) fail(`the registry was touched: ${JSON.stringify(Object.keys(children))}`);
  if (children[first.childId].sessionId !== first.sessionId) fail("the first child's session was orphaned");

  spawnSync(process.execPath, [STOP, "--run", runId, "--child", first.childId], { encoding: "utf8" });
});

// With per-child branches there is no shared standing worktree a candidate
// could mismatch against through the CLI anymore — a new run:child resolves to
// its own branch, created fresh at the candidate. The mismatch REFUSAL that
// guard still exists for (a branch that exists but does not stand at the
// candidate) lives in ensureWorktree and is asserted at that level below.
test("a --candidate spawn pins its OWN branch at the candidate and leaves the other run's worktree alone (FOC-406)", () => {
  const { repo } = fixtureRepo();
  const runA = fixtureRun();
  const first = parse(runSpawn(runA, repo)); // its own worktree on its own branch at the base commit
  if (!first.ok) fail(`first spawn failed: ${first.error}`);
  spawnSync(process.execPath, [STOP, "--run", runA, "--child", first.childId], { encoding: "utf8" });

  // A commit the standing worktree does not have.
  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  writeFileSync(join(repo, "candidate.txt"), "candidate\n");
  git("add", "-A");
  git("commit", "-m", "candidate");
  const candidate = shaOf("HEAD", repo);

  const runB = fixtureRun();
  const out = parse(runSpawn(runB, repo, ["--slug", "dev", "--candidate", candidate]));
  if (!out.ok) fail(`candidate spawn refused: ${out.error}`);
  if (out.worktree === first.worktree) fail("the candidate spawn reused the other run's worktree");
  if (out.baseRevision !== candidate) fail(`baseRevision was ${out.baseRevision}, not the candidate`);
  if (shaOf("HEAD", out.worktree) !== candidate) fail("worktree HEAD is not the candidate");
  if (shaOf("HEAD", first.worktree) !== first.baseRevision) fail("the other run's worktree was reset");

  spawnSync(process.execPath, [STOP, "--run", runB, "--child", out.childId], { encoding: "utf8" });
});

test("ensureWorktree refuses an existing branch that does not stand at the candidate (FOC-406 validation)", () => {
  const { repo } = fixtureRepo();
  const candidate = fixtureCandidate(repo);
  // A branch that exists at main — NOT at the candidate.
  execFileSync("git", ["branch", "stale-branch", "main"], { cwd: repo, stdio: "ignore" });

  let refused = null;
  try {
    ensureWorktree(repo, "stale-branch", candidate, { ownerId: "test:candidate-validation" });
  } catch (err) {
    refused = err.message;
  }
  if (!refused || !/start point|not at the requested/.test(refused)) {
    fail(`an existing branch at the wrong commit was not refused: ${refused ?? "no error"}`);
  }

  // And a branch standing AT the candidate starts without a refusal.
  const okTree = ensureWorktree(repo, "candidate-branch", candidate, { ownerId: "test:candidate-validation" });
  if (okTree.baseRevision !== candidate) fail(`a branch at the candidate was refused: ${okTree.baseRevision}`);
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

test("FOC-730: the raw working-state writes are denied for every child", () => {
  // One writer — the agent-state CLI. A child that edits the store file (or
  // shells into it through node -e / sqlite3) would walk past the reason,
  // cap and history the CLI enforces, so the file and both eval routes are
  // on the deny list the generated settings carry.
  const rules = [
    "Bash(sqlite3 *agent-state*)",
    "Bash(node -e *agent-state*)",
    "Bash(node --eval *agent-state*)",
    "Edit(//**/agent-state.sqlite)",
    "Write(//**/agent-state.sqlite)",
  ];
  for (const rule of rules) {
    if (!SUPERVISOR_DENY.includes(rule)) fail(`SUPERVISOR_DENY lost ${rule}`);
    if (!buildChildSettings({}).permissions.deny.includes(rule)) fail(`${rule} never reaches the generated child settings`);
  }
});
test("the dashboard write routes are denied from a child shell (FOC-788 follow-up)", () => {
  // A natively spawned child is a host process and could curl the dashboard's
  // loopback — push/PR, the supervisor message forward, settings, gates and
  // holds are denied in both shells. The generated file must carry them too.
  const expected = [
    "Bash(*127.0.0.1:7331*)",
    "Bash(*localhost:7331*)",
    "Bash(*/api/work/*)",
    "Bash(*/api/supervisor/*)",
    "Bash(*/api/settings/*)",
    "Bash(*/api/gates/*)",
    "Bash(*/api/holds/*)",
    "PowerShell(*127.0.0.1:7331*)",
    "PowerShell(*localhost:7331*)",
    "PowerShell(*/api/work/*)",
    "PowerShell(*/api/supervisor/*)",
    "PowerShell(*/api/settings/*)",
    "PowerShell(*/api/gates/*)",
    "PowerShell(*/api/holds/*)",
  ];
  for (const rule of expected) {
    if (!SUPERVISOR_DENY.includes(rule)) fail(`SUPERVISOR_DENY is missing ${rule}`);
    if (!buildChildSettings({}).permissions.deny.includes(rule)) fail(`generated settings are missing ${rule}`);
  }
});

test("the generated file carries the deny list and exactly the working-state SessionStart hook", () => {
  // `claude --settings` loads ADDITIONAL settings. An allow entry here could only
  // grant, never remove; the squad's own hooks block is NOT copied (double
  // registration) — the one hook this file carries is the working-state
  // SessionStart re-injection (FOC-729), unique to this settings layer.
  const out = buildChildSettings({
    permissions: { allow: ["Bash(node:*)"], deny: [] },
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: "x" }] }] },
    theme: "dark",
  });
  if (JSON.stringify([...Object.keys(out)].sort()) !== '["hooks","permissions"]') {
    fail(`extra keys: ${Object.keys(out)}`);
  }
  if (JSON.stringify(Object.keys(out.permissions)) !== '["deny"]') fail(`not deny-only: ${Object.keys(out.permissions)}`);
  const entries = out.hooks?.SessionStart ?? [];
  if (entries.length !== 1) fail(`expected exactly one SessionStart entry: ${JSON.stringify(out.hooks)}`);
  if (JSON.stringify(entries[0].hooks) !== JSON.stringify([WORKING_STATE_SESSION_START_HOOK])) {
    fail(`SessionStart hooks drifted: ${JSON.stringify(entries[0].hooks)}`);
  }
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

test("spawn seeds the child's base keys from PINNED STATE", () => {
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  // A store of this case's own, so the assertions see exactly what THIS spawn
  // seeded (runSpawn's default LA_AGENT_STATE_DB is shared by the whole file).
  const dbDir = mkdtempSync(join(tmpdir(), "la-sup-seed-"));
  cleanup.push(dbDir);
  const laRoot = join(dbDir, "la-root");
  const out = parse(runSpawn(runId, repo, [], {
    MOCK_CLAUDE_HANG_MS: "0",
    LA_AGENT_STATE_DB: join(dbDir, "agent-state.sqlite"),
    LA_AGENT_STATE_REGISTRY: REAL_REGISTRY,
    LA_ROOT: laRoot,
  }));
  if (!out.ok) fail(`spawn failed: ${out.error}`);

  // The PINNED STATE facts, as tier-base rows in the child's namespace.
  const namespace = `child:${runId}/${out.childId}`;
  const store = openAgentState(join(dbDir, "agent-state.sqlite"));
  try {
    const expected = {
      repo: "repo",
      // The prologue and the store agree by construction: both read LA_ROOT
      // and nothing else.
      la_root: laRoot,
      run_id: runId,
      role: "dev",
      issue: "FOC-123",
      worktree: out.worktree,
      branch: out.branch,
      base_revision: out.baseRevision,
    };
    for (const [key, value] of Object.entries(expected)) {
      const row = store.db
        .prepare("SELECT value, tier, source, evidence FROM facts WHERE namespace = ? AND key = ?")
        .get(namespace, key);
      if (!row) fail(`no seeded fact for ${key}`);
      if (row.tier !== "base") fail(`${key} is not base tier`);
      if (row.source !== "spawn") fail(`${key} source was ${row.source}`);
      if (row.evidence !== "supervisor-spawn PINNED STATE") fail(`${key} evidence was ${row.evidence}`);
      if (row.value !== value) fail(`${key} was ${row.value}, expected ${value}`);
    }
  } finally {
    store.close();
  }

  // The registry record says WHAT was seeded.
  const entry = readRegistry(runId).children[out.childId];
  if (!entry.workingStateSeeded?.keys?.includes("issue")) {
    fail(`registry has no workingStateSeeded.keys with issue: ${JSON.stringify(entry.workingStateSeeded)}`);
  }

  // Without LA_ROOT the la_root row is absent — no gitRoot fallback at spawn;
  // the registry's la_root chain fills the key at hook time instead.
  // spawnSync drops undefined env values, so a host LA_ROOT cannot leak in.
  const runId2 = fixtureRun();
  const out2 = parse(runSpawn(runId2, repo, [], {
    MOCK_CLAUDE_HANG_MS: "0",
    LA_AGENT_STATE_DB: join(dbDir, "agent-state-2.sqlite"),
    LA_AGENT_STATE_REGISTRY: REAL_REGISTRY,
    LA_ROOT: undefined,
  }));
  if (!out2.ok) fail(`spawn failed: ${out2.error}`);
  const store2 = openAgentState(join(dbDir, "agent-state-2.sqlite"));
  try {
    const row = store2.db
      .prepare("SELECT value FROM facts WHERE namespace = ? AND key = 'la_root'")
      .get(`child:${runId2}/${out2.childId}`);
    if (row) fail(`la_root was seeded without LA_ROOT: ${row.value}`);
  } finally {
    store2.close();
  }
  const entry2 = readRegistry(runId2).children[out2.childId];
  if (entry2.workingStateSeeded?.keys?.includes("la_root")) {
    fail(`workingStateSeeded.keys has la_root without LA_ROOT: ${JSON.stringify(entry2.workingStateSeeded)}`);
  }

  spawnSync(process.execPath, [STOP, "--run", runId, "--child", out.childId], { encoding: "utf8" });
  spawnSync(process.execPath, [STOP, "--run", runId2, "--child", out2.childId], { encoding: "utf8" });
});

test("a broken store never blocks a spawn", () => {
  const { base, repo } = fixtureRepo();
  const runId = fixtureRun();
  // LA_AGENT_STATE_DB INSIDE a path that is an existing file: opening the store
  // cannot even create its parent directory.
  const blocker = join(base, "blocker");
  writeFileSync(blocker, "not a directory\n");
  const r = runSpawn(runId, repo, [], {
    MOCK_CLAUDE_HANG_MS: "0",
    LA_AGENT_STATE_DB: join(blocker, "x.sqlite"),
    LA_AGENT_STATE_REGISTRY: REAL_REGISTRY,
  });
  if (r.status !== 0) {
    fail(`spawn failed with a broken store (exit ${r.status}):\n       ${r.stdout}\n       ${r.stderr}`);
  }
  const seeded = readRegistry(runId).children[parse(r).childId].workingStateSeeded;
  if (seeded === null || typeof seeded !== "object") {
    fail(`expected a workingStateSeeded object with keys null, got ${JSON.stringify(seeded)}`);
  }
  if (seeded.keys !== null) fail(`expected keys null, got ${JSON.stringify(seeded.keys)}`);
  if (typeof seeded.error !== "string" || seeded.error.length === 0) {
    fail(`expected a non-empty error, got ${JSON.stringify(seeded.error)}`);
  }
});
// FOC-802 M3: the entrypoint's fix_permissions runs only at container start, so
// the modes of a run created afterwards must come from the writers themselves.
// The fixture run dir is created WITHOUT pre-made subdirs (see fixtureRun), so
// what is asserted here is exactly what ensureRunDir and the run-root writers
// produce under the container's umask (0002, set at the top of this file).
test("run-root state is pinned: 0644 files, 02775 shared subdirs (FOC-802 M3)", () => {
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  const out = parse(runSpawn(runId, repo, [], { MOCK_CLAUDE_HANG_MS: "0" }));
  if (!out.ok) fail(`spawn failed: ${out.error}`);

  if (process.platform === "win32") {
    // No POSIX mode bits on NTFS — assert only that the writes happened.
    if (!existsSync(registryPath(runId))) fail("children.json was not written");
    if (!existsSync(childSettingsPath(runId, out.childId))) fail("the generated settings were not written");
    spawnSync(process.execPath, [STOP, "--run", runId, "--child", out.childId], { encoding: "utf8" });
    return;
  }

  const modeOf = (p) => statSync(p).mode & 0o7777;
  const jsonMode = (p, name) => {
    const m = modeOf(p) & 0o777;
    if (m !== 0o644) fail(`${name} was ${m.toString(8)}, expected 644`);
  };
  jsonMode(registryPath(runId), "children.json");
  jsonMode(childSettingsPath(runId, out.childId), "child-settings");
  for (const sub of ["children", "gates", "verdicts", "launch"]) {
    const m = modeOf(join(runDir(runId), sub));
    if (m !== 0o2775) fail(`${sub}/ was ${m.toString(8)}, expected 2775 (setgid + group write)`);
  }

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

test("the deny list covers relative, absolute and PowerShell forms of every Linear helper and the gh wrapper", () => {
  // FOC-511: the launcher-form rules cut only `node $LA_ROOT/scripts/<x>.mjs …`.
  // Each helper also gets the wildcard form, which matches the whole command
  // text — relative, absolute and PowerShell invocations fall under the same
  // deny. Membership here pins the list itself; scripts/supervisor-deny.test.mjs
  // (written against the documented matcher) proves the matching semantics.
  const forms = [
    "Bash(node *linear-ops.mjs*)",
    "PowerShell(node *linear-ops.mjs*)",
    "Bash(node *publish-linear-comment.mjs*)",
    "PowerShell(node *publish-linear-comment.mjs*)",
    "Bash(node *linear-query.mjs*)",
    "PowerShell(node *linear-query.mjs*)",
    "Bash(node *linear-push.mjs*)",
    "PowerShell(node *linear-push.mjs*)",
    "Bash(node *gh-screened.mjs*)",
    "PowerShell(node *gh-screened.mjs*)",
  ];
  for (const rule of forms) {
    if (!SUPERVISOR_DENY.includes(rule)) fail(`SUPERVISOR_DENY is missing ${rule}`);
    const deny = buildChildSettings({ permissions: { deny: [] } }).permissions.deny;
    if (!deny.includes(rule)) fail(`generated child settings are missing ${rule}`);
  }
});

test("dev, review and test committed settings.json deny mcp__linear__* and only plan allows it", () => {
  // FOC-511: a test child made live Linear mutations on FOC-450 through the MCP
  // server the squad still allowed. TEST never talks to Linear — the Supervisor
  // relays — so the allow goes and a deny comes. PLAN keeps its allow; cutting
  // PLAN's MCP reads is a separate decision.
  for (const squad of ["dev", "review", "test"]) {
    const perms = JSON.parse(readFileSync(join(ROOT, "agents", squad, "settings.json"), "utf8")).permissions;
    if (!(perms?.deny ?? []).includes("mcp__linear__*")) fail(`agents/${squad}/settings.json no longer denies mcp__linear__*`);
    if ((perms?.allow ?? []).includes("mcp__linear__*")) fail(`agents/${squad}/settings.json still allows mcp__linear__*`);
  }
  JSON.parse(readFileSync(join(ROOT, "agents", "plan", "settings.json"), "utf8"));
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

// Branches are per-child now, so the second spawn provisions the index of its
// OWN new worktree — what must hold is the "once per MISSING index, own root
// only" shape: init exactly once, at the second child's root, and no call
// addressing the first child's tree (that would be a cross-child reset).
test("a second child's OWN worktree is readied at launch — one init for its missing index, never another child's root", () => {
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  const first = fakeCodegraphEnv({ mode: "ready" });
  const out1 = parse(runSpawn(runId, repo, ["--child", "dev-1"], { ...first.env, MOCK_CLAUDE_HANG_MS: "0" }));
  spawnSync(process.execPath, [STOP, "--run", runId, "--child", out1.childId], { encoding: "utf8" });

  const second = fakeCodegraphEnv({ mode: "ready" });
  const out2 = parse(runSpawn(runId, repo, ["--child", "dev-2"], { ...second.env, MOCK_CLAUDE_HANG_MS: "0" }));
  if (out2.worktreeCreated !== true) fail("the second child did not get its own worktree");
  if (norm(out2.worktree) === norm(out1.worktree)) fail("the second child reused the first child's worktree");
  const cg = out2.codegraph;
  if (cg.ok !== true) fail(`second child's worktree not ready: ${JSON.stringify(cg)}`);
  if (cg.initialized !== true) fail("the second child's missing index was not provisioned");

  const calls = second.readLog();
  const inits = calls.filter((c) => c.cmd === "init" && !c.args.includes("--help"));
  if (inits.length !== 1) fail(`init did not run exactly once for the new index: ${JSON.stringify(calls)}`);
  if (norm(inits[0].args[inits[0].args.length - 1]) !== norm(out2.worktree)) {
    fail(`init addressed the wrong root: ${JSON.stringify(inits[0])}`);
  }
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

// ── background-wait ceiling + turn-end contract (FOC-522) ────────────────────
// Turn teardown kills a child's in-flight background tasks after at most
// CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS; the CLI default (600 s) sits BELOW our
// full suite. Both halves of option C are pinned here: the FINITE ceiling this
// carrier sets, and the contract text every kickoff embeds.
console.log("\nbackground-wait ceiling and the turn-end contract");

test("the ceiling is one finite constant above the full suite, exposed through one helper (FOC-522)", () => {
  // 45 min: >3x the 640-740 s full suite, and finite — a hung turn is still the
  // supervisor-status stall SLA's to catch, never an infinite wait.
  if (!Number.isFinite(PRINT_BG_WAIT_CEILING_MS) || PRINT_BG_WAIT_CEILING_MS <= 0) {
    fail(`the ceiling must be finite and positive, got ${PRINT_BG_WAIT_CEILING_MS}`);
  }
  if (PRINT_BG_WAIT_CEILING_MS !== 2_700_000) fail(`the 45 min decision drifted: ${PRINT_BG_WAIT_CEILING_MS}`);
  if (PRINT_BG_WAIT_ENV !== "CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS") {
    fail(`the env name drifted from the CLI's own message: ${PRINT_BG_WAIT_ENV}`);
  }
  const env = printBgWaitCeilingEnv();
  if (JSON.stringify(env) !== `{"${PRINT_BG_WAIT_ENV}":"2700000"}`) {
    fail(`the helper does more than carry the value: ${JSON.stringify(env)}`);
  }
});

test("the spawn env carries the ceiling end-to-end — the first carrier (FOC-522)", () => {
  // MOCK_CLAUDE_ENV_FILE records the environment claude actually received, so
  // this proves the value survived spawn → watcher → claude, not just that the
  // script mentions it.
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  const envFile = join(runDir(runId), "env.log");
  parse(runSpawn(runId, repo, [], { MOCK_CLAUDE_ENV_FILE: envFile, MOCK_CLAUDE_HANG_MS: "0" }));
  if (!existsSync(envFile)) fail("the mock never recorded an env — claude was not invoked");
  const env = JSON.parse(readFileSync(envFile, "utf8"));
  if (env[PRINT_BG_WAIT_ENV] !== "2700000") {
    fail(`${PRINT_BG_WAIT_ENV} was ${JSON.stringify(env[PRINT_BG_WAIT_ENV])} in the child env`);
  }
});

test("every kickoff embeds the turn-end contract without displacing the kickoff body (FOC-522)", () => {
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  const argvFile = join(runDir(runId), "argv.log");
  parse(runSpawn(runId, repo, ["--prompt", "KICKOFF BODY MARKER"], { MOCK_CLAUDE_ARGV_FILE: argvFile, MOCK_CLAUDE_HANG_MS: "0" }));
  const argv = JSON.parse(readFileSync(argvFile, "utf8"));
  const payload = argv[argv.indexOf("-p") + 1];
  if (payload === undefined) fail(`claude was not given a -p payload: ${JSON.stringify(argv)}`);
  for (const line of TURN_END_CONTRACT.split("\n")) {
    if (!payload.includes(line)) fail(`the prompt claude received lost the contract line: "${line}"`);
  }
  if (!payload.includes("FOREGROUND")) fail("the contract does not state the foreground rule");
  if (!payload.includes("KICKOFF BODY MARKER")) fail("the contract displaced the kickoff body");
});

// ── auto-focus (FOC-769) ─────────────────────────────────────────────────────
console.log("\nauto-focus");

// The focus declaration writes into the state home; these tests point
// LA_SUPERVISOR_STATE_HOME at their own temp tree so nothing lands in the
// checkout's .state. Restored in `finally` so the later tests stay on the
// default home their fixtureRun dirs were built for.
function withFocusHome(fn) {
  const home = mkdtempSync(join(tmpdir(), "la-sup-focus-"));
  cleanup.push(home);
  const prev = process.env.LA_SUPERVISOR_STATE_HOME;
  process.env.LA_SUPERVISOR_STATE_HOME = home;
  try {
    fn(home);
  } finally {
    if (prev === undefined) delete process.env.LA_SUPERVISOR_STATE_HOME;
    else process.env.LA_SUPERVISOR_STATE_HOME = prev;
  }
}

test("a successful spawn declares the child's ticket as the focus (source spawn)", () => {
  withFocusHome((home) => {
    const { repo } = fixtureRepo();
    const runId = fixtureRun({ runId: validRunId(1) });
    const out = parse(runSpawn(runId, repo, [], { MOCK_CLAUDE_HANG_MS: "0" }));

    if (!out.focus || out.focus.changed !== true || out.focus.taskId !== "FOC-123") {
      fail(`spawn did not declare the focus: ${JSON.stringify(out.focus)}`);
    }
    if (out.focusError !== undefined) fail(`spawn reported a focus error: ${out.focusError}`);
    const { current, history } = readFocus(runId, { stateHome: home });
    if (!current || current.taskId !== "FOC-123" || current.kind !== "ticket" || current.source !== "spawn") {
      fail(`focus.jsonl does not carry the spawn declaration: ${JSON.stringify(current)}`);
    }
    if (history.length !== 1) fail(`expected exactly 1 focus line, got ${history.length}`);
  });
});

test("a spawn that cannot attribute focus still succeeds", () => {
  // The counter run id is not a RUN_ID_RE run id — the declaration must skip
  // it silently, never fail the spawn, and never half-report a focus.
  withFocusHome((home) => {
    const { repo } = fixtureRepo();
    const runId = fixtureRun();
    const out = parse(runSpawn(runId, repo, [], { MOCK_CLAUDE_HANG_MS: "0" }));

    if (out.ok !== true) fail(`spawn failed: ${out.error}`);
    if (out.focus !== undefined) fail(`a focus was declared for an unattributable run id: ${JSON.stringify(out.focus)}`);
    if (out.focusError !== undefined) fail(`the skip was reported as an error: ${out.focusError}`);
    if (readFocus(runId, { stateHome: home }).history.length) fail("a focus line was written anyway");
  });
});

// ── child model + per-child provider env (FOC-762/FOC-773) ───────────────────
console.log("\nchild model + provider env");

test("a settings overlay routing.<squad>.lead picks the child's model and records the source", () => {
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  const overlayDir = mkdtempSync(join(tmpdir(), "la-sup-overlay-"));
  cleanup.push(overlayDir);
  // Only the overlay file matters here; readSettings takes it via LA_SETTINGS_FILE.
  const overlay = join(overlayDir, "settings.json");
  writeFileSync(
    overlay,
    JSON.stringify({ provider: { active: null, custom: null }, routing: { dev: { lead: "overlay/lead-model" } } }),
  );
  const out = parse(runSpawn(runId, repo, [], { LA_SETTINGS_FILE: overlay, MOCK_CLAUDE_HANG_MS: "0" }));
  if (out.ok !== true) fail(`spawn failed: ${out.error}`);
  if (out.model !== "overlay/lead-model") fail(`spawn reported model ${out.model}`);
  if (out.modelSource !== "settings:routing.dev") fail(`spawn reported modelSource ${out.modelSource}`);
  const entry = readRegistry(runId).children[out.childId];
  if (entry.model !== "overlay/lead-model") fail(`registry model: ${entry.model}`);
  if (entry.modelSource !== "settings:routing.dev") fail(`registry modelSource: ${entry.modelSource}`);
});

test("the child env carries the overlay's provider — base URL, auth vars and tiers", () => {
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  const dir = mkdtempSync(join(tmpdir(), "la-sup-prov-"));
  cleanup.push(dir);
  // A custom provider reachable only through the resolution inputs: config file,
  // key file and the overlay naming it active (LA_PROVIDER keeps the test
  // deterministic while provider-resolve gains overlay support).
  const configPath = join(dir, "models.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      providers: {
        mockprov: {
          baseUrl: "http://127.0.0.1:9443/api",
          authEnv: "MOCKPROV_API_KEY",
          authStyle: "token",
          tiers: { opus: "prov/opus-model" },
        },
      },
    }),
  );
  const envPath = join(dir, ".env");
  writeFileSync(envPath, "MOCKPROV_API_KEY=dummy-key\n");
  const overlay = join(dir, "settings.json");
  writeFileSync(overlay, JSON.stringify({ provider: { active: "mockprov", custom: null }, routing: {} }));
  const claudeEnvFile = join(dir, "claude-env.jsonl");

  const out = parse(
    runSpawn(runId, repo, [], {
      LA_PROVIDER: "mockprov",
      LA_PROVIDER_CONFIG: configPath,
      LA_PROVIDER_ENV_FILE: envPath,
      LA_SETTINGS_FILE: overlay,
      MOCK_CLAUDE_ENV_FILE: claudeEnvFile,
      MOCK_CLAUDE_HANG_MS: "0",
    }),
  );
  if (out.ok !== true) fail(`spawn failed: ${out.error}`);

  // The mock claude appends its env as one JSON object per line; the watcher
  // passes the child env straight through, so what lands here is what the
  // child actually ran with.
  const deadline = Date.now() + 10_000;
  let childEnv = null;
  while (Date.now() < deadline) {
    try {
      const lines = readFileSync(claudeEnvFile, "utf8").split(/\r?\n/).filter(Boolean);
      if (lines.length) {
        childEnv = JSON.parse(lines[lines.length - 1]);
        break;
      }
    } catch {
      /* not written yet */
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
  }
  if (!childEnv) fail(`mock claude never wrote its env to ${claudeEnvFile}`);
  if (childEnv.ANTHROPIC_BASE_URL !== "http://127.0.0.1:9443/api") {
    fail(`child base URL: ${childEnv.ANTHROPIC_BASE_URL}`);
  }
  if (childEnv.LA_PROVIDER !== "mockprov") fail(`child LA_PROVIDER: ${childEnv.LA_PROVIDER}`);
  if (childEnv.ANTHROPIC_AUTH_TOKEN !== "dummy-key") fail(`child auth token: ${childEnv.ANTHROPIC_AUTH_TOKEN}`);
  // The inactive auth var must be cleared, never left inherited.
  if (childEnv.ANTHROPIC_API_KEY !== "") fail(`inactive auth var: "${childEnv.ANTHROPIC_API_KEY}"`);
  if (childEnv.ANTHROPIC_DEFAULT_OPUS_MODEL !== "prov/opus-model") {
    fail(`child opus tier: ${childEnv.ANTHROPIC_DEFAULT_OPUS_MODEL}`);
  }
  // FOC-762/FOC-773: the resolved provider is recorded in the registry entry,
  // so a follow-up turn can pin the SAME provider after a switch in the
  // settings overlay.
  const entry = readRegistry(runId).children[out.childId];
  if (entry.provider !== "mockprov") fail(`registry provider: ${entry.provider}`);
});

test("a provider resolution error refuses the spawn (fail closed)", () => {
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  const r = runSpawn(runId, repo, [], { LA_PROVIDER: "does-not-exist" });
  if (r.status !== 1) fail(`expected exit 1, got ${r.status}`);
  const out = parse(r);
  if (out.ok !== false) fail(`expected ok:false, got ${JSON.stringify(out)}`);
  if (out.reason !== "provider-resolution-failed") fail(`expected a named refusal, got: ${JSON.stringify(out)}`);
  if (!/does-not-exist/.test(out.error)) fail(`error does not name the provider: ${out.error}`);
  if (Object.keys(readRegistry(runId).children).length) fail("a child was registered anyway");
});

// ── FOC-607: the --model policy, fail closed before anything starts ──────────
// The gate sits with the argument checks in supervisor-spawn.mjs, above the
// admission/hold branch and the worktree claim, so a refused spawn must leave
// NOTHING behind — asserted the same way the provider refusal tests do (empty
// registry), plus no worktree directory on disk.
test("FOC-607: --model on a dev squad is refused before anything starts", () => {
  const { base, repo } = fixtureRepo();
  const runId = fixtureRun();
  const r = runSpawn(runId, repo, ["--model", "z-ai/glm-5.3"]);
  if (r.status !== 1) fail(`expected exit 1, got ${r.status}`);
  const out = parse(r);
  if (out.ok !== false) fail(`expected ok:false, got ${JSON.stringify(out)}`);
  if (out.error !== "model-override-banned") fail(`error was ${JSON.stringify(out.error)}`);
  if (!/routing table/.test(out.message) || !/drop --model/.test(out.message)) {
    fail(`message does not point at the fix: ${out.message}`);
  }
  if (Object.keys(readRegistry(runId).children).length) fail("a child was registered anyway");
  if (existsSync(join(base, "la-wt"))) fail("a worktree was created for a refused spawn");
});

test("FOC-607: an unpriced --model on a non-dev squad is refused before anything starts", () => {
  const { base, repo } = fixtureRepo();
  const runId = fixtureRun();
  const r = runSpawn(runId, repo, ["--squad", "plan", "--model", "totally/unpriced-id"]);
  if (r.status !== 1) fail(`expected exit 1, got ${r.status}`);
  const out = parse(r);
  if (out.ok !== false) fail(`expected ok:false, got ${JSON.stringify(out)}`);
  if (out.error !== "model-unpriced") fail(`error was ${JSON.stringify(out.error)}`);
  if (!/totally\/unpriced-id/.test(out.message) || !/config\/models\.json/.test(out.message)) {
    fail(`message does not name the id and the config: ${out.message}`);
  }
  if (Object.keys(readRegistry(runId).children).length) fail("a child was registered anyway");
  if (existsSync(join(base, "la-wt"))) fail("a worktree was created for a refused spawn");
});

// The gate sits ABOVE the admission/hold branch: a banned --model is refused
// at capacity too, and never consumes a hold record it would then fail on
// replay (the request would otherwise be lost).
test("FOC-607: a banned --model at capacity is refused, not held", () => {
  const { base, repo } = fixtureRepo();
  const runId = fixtureRun();
  const first = parse(runSpawn(runId, repo));
  if (!first.ok) fail("first spawn failed");
  // The capacity-setup spawn already created its own worktree, so the refused
  // spawn is pinned by the COUNT of worktrees staying flat, not by absence.
  const laWt = join(base, "la-wt");
  const worktreesBefore = existsSync(laWt) ? readdirSync(laWt).length : 0;

  const r = runSpawn(runId, repo, ["--task", "FOC-124", "--child", "dev-2", "--model", "z-ai/glm-5.3"]);
  if (r.status !== 1) fail(`expected exit 1 for a banned --model even at capacity, got ${r.status}`);
  const out = parse(r);
  if (out.ok !== false) fail(`expected ok:false, got ${JSON.stringify(out)}`);
  if (out.error !== "model-override-banned") fail(`error was ${JSON.stringify(out.error)}`);
  // Refused above the hold branch: no held-request record was written for a
  // request that can never start.
  if (existsSync(heldDir(runId))) fail("a held-request record was written for a refused spawn");
  if (readHeld(runId).length) fail("held records remain for a refused spawn");
  // Only the first child was registered; the refused request started nothing.
  if (Object.keys(readRegistry(runId).children).length !== 1) fail("a child was registered for the refused spawn");
  if (existsSync(laWt) && readdirSync(laWt).length !== worktreesBefore) {
    fail("a worktree was created for a refused spawn");
  }

  spawnSync(process.execPath, [STOP, "--run", runId, "--child", first.childId], { encoding: "utf8" });
});
// A priced explicit id on a non-dev squad still spawning is pinned by the
// updated "an explicit --model wins over the inherited one" test above
// (plan + z-ai/glm-5.3-flash), and dev WITHOUT --model by the routing-table
// test — both kept green rather than duplicated here.

test("an empty mounted key refuses spawn even when the Supervisor holds a stale key", () => {
  const { base, repo } = fixtureRepo(); const runId = fixtureRun();
  const secrets = join(base, "secrets"); mkdirSync(secrets);
  writeFileSync(join(secrets, "openrouter_api_key"), "");
  const r = runSpawn(runId, repo, [], {LA_PROVIDER: "openrouter", LA_SECRETS_DIR: secrets});
  const out = parse(r);
  if (r.status !== 1 || out.reason !== "provider-resolution-failed") fail("missing mounted key was not refused");
  if (Object.keys(readRegistry(runId).children).length) fail("missing-key request registered a child");
});

test("the next spawn re-reads provider, mounted key and routing despite inherited launch values", () => {
  const { base, repo } = fixtureRepo(); const runId = fixtureRun();
  const secrets = join(base, "secrets"); mkdirSync(secrets);
  writeFileSync(join(secrets, "provider_api_key"), "rotated-fixture-key");
  const overlay = join(base, "settings.json");
  writeFileSync(overlay, JSON.stringify({provider: {active: "custom", custom: {baseUrl: "http://127.0.0.1:9449", authStyle: "token", keyName: "PROVIDER_API_KEY", defaultModel: "custom/default", tiers: {}}}, routing: {dev: {lead: "custom/routed"}}}));
  const envLog = join(base, "child-env.jsonl");
  const out = parse(runSpawn(runId, repo, [], {LA_SETTINGS_FILE: overlay, LA_SECRETS_DIR: secrets, LA_PROVIDER: "openrouter", LA_PROVIDER_SOURCE: "settings", LA_PROVIDER_RESOLVED: "openrouter", PROVIDER_API_KEY: "stale-fixture-key", ANTHROPIC_DEFAULT_OPUS_MODEL: "stale/opus", MOCK_CLAUDE_ENV_FILE: envLog, MOCK_CLAUDE_HANG_MS: "0"}));
  if (!out.ok || out.model !== "custom/routed") fail("new routing was not used");
  const env = JSON.parse(readFileSync(envLog, "utf8").trim().split("\n").pop());
  if (env.LA_PROVIDER !== "custom" || env.ANTHROPIC_BASE_URL !== "http://127.0.0.1:9449") fail("inherited provider masked overlay");
  if (env.ANTHROPIC_AUTH_TOKEN !== "rotated-fixture-key") fail("mounted key rotation was not seen");
  if (env.ANTHROPIC_DEFAULT_OPUS_MODEL !== "") fail("stale tier survived provider switch");
});

// ── ownership (FOC-848) ──────────────────────────────────────────────────────
console.log("\nownership (FOC-848)");

// Every spawn below must see a KNOWN ownership config — a developer's real
// settings overlay (which may carry a restricted `ownership` key) must never
// leak in. The env-file rung short-circuits the loader before the overlay is
// read, so pinning LA_TASK_OWNERSHIP_CONFIG at module load makes every test
// unrestricted by default; the restricted tests override it per spawn.
const OWNERSHIP_TMP = mkdtempSync(join(tmpdir(), "la-spawn-own-"));
cleanup.push(OWNERSHIP_TMP);
const UNRESTRICTED_OWNERSHIP = join(OWNERSHIP_TMP, "ownership-unrestricted.json");
writeFileSync(UNRESTRICTED_OWNERSHIP, JSON.stringify({ version: 1, owners: {}, unlisted: "allow" }), "utf8");
process.env.LA_TASK_OWNERSHIP_CONFIG = UNRESTRICTED_OWNERSHIP;

const RESTRICTED_OWNERSHIP = join(OWNERSHIP_TMP, "ownership-restricted.json");
writeFileSync(
  RESTRICTED_OWNERSHIP,
  JSON.stringify({
    version: 1,
    owners: {
      orchestrator: { linearProjects: ["Fenix — wydanie 1.0 i kontrola kosztów"] },
      supervisor: { linearProjects: ["proj-jw-id"] },
    },
    unlisted: "ask",
  }),
  "utf8",
);
// The stamp triage.json carries on a restricted install after an allowed record.
const OWNED_STAMP = (owner = "supervisor") => ({
  owner,
  verdict: "owned",
  allowed: true,
  project: { id: "proj-jw-id", name: "JW" },
});
// A run whose triage.json the test controls (fixtureRun writes a bare one).
function restrictedRun(triage) {
  const runId = fixtureRun({ triage: false });
  writeFileSync(join(runDir(runId), "triage.json"), JSON.stringify(triage));
  return runId;
}
const restrictedSpawn = (runId, repo, extra = [], env = {}) =>
  runSpawn(runId, repo, extra, { LA_TASK_OWNERSHIP_CONFIG: RESTRICTED_OWNERSHIP, LA_TASK_OWNER: "supervisor", ...env });

test("restricted install + a triage.json without a stamp → ownership-unverified, no child, hold written", () => {
  const { repo } = fixtureRepo();
  const runId = restrictedRun({ issue: "FOC-123", verdict: "dev" }); // no ownership stamp
  const r = restrictedSpawn(runId, repo);
  if (r.status !== 1) fail(`expected exit 1, got ${r.status}`);
  const out = parse(r);
  if (out.code !== "ownership-unverified") fail(`expected ownership-unverified, got ${out.code}`);
  if (!/record triage for FOC-123 as owner supervisor first/.test(out.hint ?? "")) fail(`hint does not name the fix: ${out.hint}`);
  if (Object.keys(readRegistry(runId).children).length) fail("a child was registered despite the refusal");
  const holds = readHolds(runId).holds;
  if (holds.length !== 1) fail(`expected exactly one hold, got ${holds.length}`);
  if (holds[0].origin !== "ownership" || holds[0].state !== "open") fail(`wrong hold: ${JSON.stringify(holds[0])}`);
  if (out.hold !== holds[0].id) fail("the refusal does not name the hold it recorded");
  // Idempotent: a retried spawn does not pile up a second hold.
  const r2 = restrictedSpawn(runId, repo);
  if (r2.status !== 1) fail(`retry changed the exit: ${r2.status}`);
  if (readHolds(runId).holds.length !== 1) fail("the retried refusal wrote a second hold");
});

test("a stamp for ANOTHER task is refused", () => {
  const { repo } = fixtureRepo();
  const runId = restrictedRun({ issue: "FOC-999", verdict: "dev", ownership: OWNED_STAMP() });
  const r = restrictedSpawn(runId, repo); // --task FOC-123
  if (r.status !== 1) fail(`expected exit 1, got ${r.status}`);
  if (parse(r).code !== "ownership-unverified") fail("the mismatch was not an ownership refusal");
  if (Object.keys(readRegistry(runId).children).length) fail("a child was registered despite the refusal");
});

test("a stamp recorded by ANOTHER owner is refused", () => {
  const { repo } = fixtureRepo();
  const runId = restrictedRun({ issue: "FOC-123", verdict: "dev", ownership: OWNED_STAMP("orchestrator") });
  const r = restrictedSpawn(runId, repo, [], { LA_TASK_OWNER: "supervisor" });
  if (r.status !== 1) fail(`expected exit 1, got ${r.status}`);
  if (parse(r).code !== "ownership-unverified") fail("the owner mismatch was not an ownership refusal");
  if (Object.keys(readRegistry(runId).children).length) fail("a child was registered despite the refusal");
});

test("a proper stamp lets the spawn proceed — the happy path, unchanged (issue matched case-insensitively)", () => {
  const { repo } = fixtureRepo();
  const runId = restrictedRun({ issue: "foc-123", verdict: "dev", ownership: OWNED_STAMP() });
  const out = parse(restrictedSpawn(runId, repo));
  if (!out.ok) fail(`spawn failed: ${out.error}`);
  if (!out.worktreeCreated) fail("expected a fresh worktree");
  if (!out.branch.startsWith("foc-123-")) fail(`unexpected branch name: ${out.branch}`);
  const entry = readRegistry(runId).children[out.childId];
  for (const field of ["worktree", "branch", "baseRevision"]) {
    if (entry[field] === undefined) fail(`registry entry is missing "${field}"`);
  }
  if (readHolds(runId).holds.length) fail("a successful spawn wrote a hold");
  spawnSync(process.execPath, [STOP, "--run", runId, "--child", out.childId], { encoding: "utf8" });
});

test("the child env carries LA_TASK_OWNER explicitly (FOC-848)", () => {
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  const envFile = join(runDir(runId), "owner-env.log");
  // LA_TASK_OWNER="" in the parent means "the default owner" — the child must
  // still receive the explicit "supervisor", not the inherited blank.
  parse(runSpawn(runId, repo, [], { LA_TASK_OWNER: "", MOCK_CLAUDE_ENV_FILE: envFile, MOCK_CLAUDE_HANG_MS: "0" }));
  if (!existsSync(envFile)) fail("the mock never recorded an env — claude was not invoked");
  const env = JSON.parse(readFileSync(envFile, "utf8"));
  if (env.LA_TASK_OWNER !== "supervisor") fail(`LA_TASK_OWNER was ${JSON.stringify(env.LA_TASK_OWNER)} in the child env`);
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
