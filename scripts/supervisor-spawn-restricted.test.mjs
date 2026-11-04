// scripts/supervisor-spawn-restricted.test.mjs — supervisor-spawn, the
// restricted/ownership half (FOC-1074).
//
// Split from scripts/supervisor-spawn.test.mjs (2 282 lines, 242 s in the
// parallel lane — the lane's tail): the plain spawn pipeline stayed there,
// this file owns the cases where the child must NOT get free rein — the P9
// generated deny list and child settings, the FOC-607 --model policy (fail
// closed before anything starts), and the FOC-848 task-ownership gate.
//
// Runs real child processes against a real (fixture) git repo, with a mock
// `claude` on LA_CLAUDE_BIN. Nothing here is stubbed except the model itself,
// because the things most likely to break are exactly the parts a stub would
// hide: the generated settings file and the restricted-config gating.
//
// Isolation: each test builds its own repo under the OS temp dir and its own
// run id, so worktrees land in <tmp>/<uniq>/la-wt and never touch this
// checkout. LA_SUPERVISOR_NO_TELEMETRY keeps run manifests out of .state/runs.
//
// Every spawn below must see a KNOWN ownership config — a developer's real
// settings overlay (which may carry a restricted `ownership` key) must never
// leak in. The env-file rung short-circuits the loader before the overlay is
// read, so pinning LA_TASK_OWNERSHIP_CONFIG at module load makes every test
// unrestricted by default; the restricted tests override it per spawn.
//
// Run: node scripts/supervisor-spawn-restricted.test.mjs

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SUPERVISOR_DENY,
  WORKING_STATE_SESSION_START_HOOK,
  buildChildSettings,
  childSettingsPath,
  heldDir,
  readHeld,
  readHolds,
  readRegistry,
  registryPath,
  runDir,
} from "./supervisor-lib.mjs";
import { openAgentState } from "./agent-state.mjs";
import { scrubbedEnv } from "./supervisor-test-fixtures.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SPAWN = join(ROOT, "scripts", "supervisor-spawn.mjs");
const STOP = join(ROOT, "scripts", "supervisor-stop.mjs");
const MOCK = join(ROOT, "scripts", "mock-claude.mjs");
const REAL_REGISTRY = join(ROOT, "config", "agent-state.json");

// FOC-802 M3: the run-dir mode assertions below pin 02755 (setgid + group
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
  // `runId` override: kept for the callers that need a run id matching the
  // RUN_ID_RE shape; the counter ids below deliberately do not.
  const id = runId ?? `test-${process.pid}-${Date.now()}-${runCounter++}`;
  const dir = runDir(id);
  // The run DIR only. The shared subdirs (children/gates/verdicts/launch) are
  // left to ensureRunDir — spawn's first write.
  mkdirSync(dir, { recursive: true });
  if (triage) {
    writeFileSync(join(dir, "triage.json"), JSON.stringify({ issue: "FOC-123", verdict: "dev" }));
  }
  cleanup.push(dir);
  return id;
}

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
        LA_SUPERVISOR_NO_CODEGRAPH: "1",
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

test("FOC-1166: a worktree-isolated subagent delegation is refused for every child", () => {
  // Three incidents (FOC-1161, the FOC-1151 fix round, FOC-1162) had the same
  // shape: a child delegated an Agent call with isolation: "worktree", the
  // harness created a .claude/worktrees/agent-<id> tree under the MAIN
  // checkout — outside the run's registry — and the child fast-forwarded onto
  // the stray branch it found there. The refusal lives in the block
  // buildChildSettings appends itself, so no squad file or --settings extra
  // can end up without it. `Agent(isolation:worktree)` is the documented
  // input-parameter rule form for the Agent tool; a subagent call that omits
  // the parameter is never matched, so plain Agent calls stay allowed.
  // `EnterWorktree` is the dedicated tool for the same move, which the Agent
  // rule alone does not cover.
  const rules = ["Agent(isolation:worktree)", "EnterWorktree"];
  for (const rule of rules) {
    if (!SUPERVISOR_DENY.includes(rule)) fail(`SUPERVISOR_DENY is missing ${rule}`);
    if (!buildChildSettings({}).permissions.deny.includes(rule)) {
      fail(`${rule} never reaches the generated child settings`);
    }
  }
  // And they stay the Supervisor's own single entries: a squad file (or
  // --settings extra) carrying them too is deduped to one copy, as everywhere
  // else on the list.
  const deny = buildChildSettings({ permissions: { deny: [...rules] } }).permissions.deny;
  for (const rule of rules) {
    if (deny.filter((r) => r === rule).length !== 1) fail(`not deduped: ${JSON.stringify(deny)}`);
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
// updated "an explicit --model wins over the inherited one" test in the spawn
// half (plan + z-ai/glm-5.3-flash), and dev WITHOUT --model by the routing-table
// test there — both kept green rather than duplicated here.

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