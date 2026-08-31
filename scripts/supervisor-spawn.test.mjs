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

import { SUPERVISOR_DENY, buildChildSettings, childSettingsPath, readRegistry, runDir } from "./supervisor-lib.mjs";

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
