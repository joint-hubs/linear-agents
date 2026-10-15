// scripts/agent-launch-profile.test.mjs — the launch-owned child config dir.
//
// Pure unit tests over temp dirs: no child processes, no git, no network. The
// launch utility must hold four lines by itself, because nothing downstream
// can compensate for them:
//   · the snapshot records the profile revision and the diff against the PRIOR
//     safe snapshot (restart previews the profile diff — PRD §7);
//   · provider-key shapes are refused outright — a copied key outlives the
//     turn, and the provider env is env-only by contract, never persisted;
//   · config isolation: only the allowlisted squad sources are copied, shared
//     state (projects/, auth, user config) never is, and symlinks are not
//     followed;
//   · resume-history confinement: a follow-up copies ONLY the same child's
//     previous launch history — the whole tree of a launch-owned dir, or a
//     legacy shared dir's single matching transcript — never another child's.

import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  actorIdFor,
  attemptIdFor,
  launchDirFor,
  prepareAgentLaunch,
} from "./agent-launch-profile.mjs";

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

function base(name) {
  const dir = join(tmpdir(), `la-launch-${name}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  cleanup.push(dir);
  return dir;
}

// An isolated env for every call: the registry and the squad home point into
// the test's temp tree, so the user's real tool-profiles.json and the repo's
// agents/ can never leak into these assertions.
function launchEnv(dir, extra = {}) {
  return { LA_TOOL_PROFILES_FILE: join(dir, "tool-profiles.json"), LA_SQUAD_HOME: join(dir, "squads"), ...extra };
}

function fixtureSquad(dir, { settings = '{"permissions":{"deny":[]}}' } = {}) {
  const squad = join(dir, "squads", "dev");
  mkdirSync(join(squad, "agents"), { recursive: true });
  mkdirSync(join(squad, "skills"), { recursive: true });
  writeFileSync(join(squad, "CLAUDE.md"), "# dev squad\n");
  writeFileSync(join(squad, "settings.json"), settings);
  writeFileSync(join(squad, "agents", "worker.md"), "---\nname: worker\n---\nwork\n");
  writeFileSync(join(squad, "skills", "run.md"), "runbook\n");
  // The shared state that must NEVER travel into a launch dir.
  mkdirSync(join(squad, "projects", "proj-a"), { recursive: true });
  writeFileSync(join(squad, "projects", "proj-a", "sess-1.jsonl"), "{}\n");
  writeFileSync(join(squad, ".credentials.json"), '{"ANTHROPIC_API_KEY":"nope"}');
  writeFileSync(join(squad, ".claude.json"), '{"hasTrustDialogAccepted":true}');
  return squad;
}

function writeRegistry(dir, obj) {
  writeFileSync(join(dir, "tool-profiles.json"), JSON.stringify(obj));
}

const readSnapshot = (dir) => JSON.parse(readFileSync(join(dir, "snapshot.json"), "utf8"));

// ── the utility ──────────────────────────────────────────────────────────────
console.log("\nthe launch utility");

test("assembles the launch dir, the snapshot files and the CLI args", () => {
  const dir = base("shape");
  fixtureSquad(dir);
  const outputDir = join(dir, "launch", "dev-1", "turn-0");

  const out = prepareAgentLaunch({ squad: "dev", outputDir, env: launchEnv(dir) });

  if (out.configDir !== outputDir) fail(`configDir was ${out.configDir}`);
  if (!existsSync(join(outputDir, "snapshot.json"))) fail("no snapshot.json in the launch dir");
  if (!existsSync(join(outputDir, "mcp.json"))) fail("no mcp.json in the launch dir");
  const mcp = JSON.parse(readFileSync(join(outputDir, "mcp.json"), "utf8"));
  if (typeof mcp.mcpServers !== "object") fail("mcp.json carries no mcpServers map");

  // --mcp-config ADDS the profile's servers; the project's own stay (never
  // --strict-mcp-config), and restriction is --tools and a server-side MCP subset, never
  // --allowedTools (which only pre-approves permissions and restricts nothing).
  const tail = out.cliArgs.slice(-2);
  if (tail[0] !== "--mcp-config") fail(`cliArgs do not end with --mcp-config: ${JSON.stringify(out.cliArgs)}`);
  if (tail[1] !== join(outputDir, "mcp.json")) fail(`--mcp-config points at ${tail[1]}`);
  if (out.cliArgs.includes("--allowedTools")) fail("cliArgs carry --allowedTools — it restricts nothing");
  if (out.cliArgs.includes("--strict-mcp-config")) fail("cliArgs carry --strict-mcp-config — project servers must survive");

  // Default registry: the thoughtmap server is disabled, so its five tools are
  // not attached; with tools=null no --tools
  // restriction is applied (the lead keeps native availability).
  if (out.cliArgs.includes('--disallowedTools')) fail('role restrictions must not become global native-child denials');
  const restrictedMcp = JSON.parse(readFileSync(out.cliArgs[out.cliArgs.indexOf('--mcp-config')+1], 'utf8'));
  if (restrictedMcp.mcpServers.thoughtmap) fail('unselected Thoughtmap server was attached');
  if (out.cliArgs.includes("--tools")) fail(`--tools applied with a null tool list: ${JSON.stringify(out.cliArgs)}`);

  // Only the allowlisted squad sources were copied.
  for (const wanted of ["CLAUDE.md", "settings.json", "worker.md", "run.md"]) {
    if (!out.copied.some((p) => p.split(/[\\/]/).pop() === wanted)) {
      fail(`expected copy missing: ${wanted} (got ${JSON.stringify(out.copied)})`);
    }
  }
  if (out.copied.some((p) => p.includes("projects") || p.includes(".credentials") || p.includes(".claude.json"))) {
    fail(`shared state was copied: ${JSON.stringify(out.copied)}`);
  }
  if (existsSync(join(outputDir, "projects"))) fail("a projects dir exists in a fresh launch dir");
});

test("an explicit tool list becomes --tools with the builtins only", () => {
  const dir = base("tools");
  fixtureSquad(dir);
  writeRegistry(dir, { version: 1, revision: 2, mcp: { thoughtmap: { enabled: false } }, leadTools: { dev: ["Read", "Bash"] }, globalTools: null, squadTools: {} });

  const out = prepareAgentLaunch({ squad: "dev", outputDir: join(dir, "launch"), env: launchEnv(dir) });

  const toolsAt = out.cliArgs.indexOf("--tools");
  if (toolsAt === -1) fail(`no --tools in ${JSON.stringify(out.cliArgs)}`);
  const tools = out.cliArgs[toolsAt + 1];
  if (tools !== "Read,Bash") fail(`--tools carried non-builtins: ${tools}`);
  if (out.cliArgs.includes('--disallowedTools')) fail('role restrictions must not become global native-child denials');
  const restrictedMcp = JSON.parse(readFileSync(out.cliArgs[out.cliArgs.indexOf('--mcp-config')+1], 'utf8'));
  if (restrictedMcp.mcpServers.thoughtmap) fail('unselected Thoughtmap server was attached');
  if (out.profile.revision !== 2) fail(`profile revision was ${out.profile.revision}`);
});

// ── the snapshot diff (restart previews the profile diff — PRD §7) ──────────
console.log("\nsnapshot changes vs the prior safe snapshot");

test("a follow-up launch diffs against the prior snapshot and records the rows", () => {
  const dir = base("diff");
  fixtureSquad(dir);
  const first = prepareAgentLaunch({ squad: "dev", outputDir: join(dir, "t0"), env: launchEnv(dir) });
  if (first.profileInitial !== true) fail("a fresh launch is not marked initial");
  if (first.changes.length) fail(`a fresh launch recorded changes: ${JSON.stringify(first.changes)}`);

  // The registry moved on between the two processes: new revision, fewer tools.
  writeRegistry(dir, { version: 1, revision: 9, mcp: { thoughtmap: { enabled: false } }, leadTools: { dev: ["Read"] }, globalTools: null, squadTools: {} });
  const second = prepareAgentLaunch({
    squad: "dev",
    outputDir: join(dir, "t1"),
    previousConfigDir: join(dir, "t0"),
    historyMode: "tree",
    env: launchEnv(dir),
  });

  if (second.profileInitial !== false) fail("a launch with a prior snapshot is not marked as a diff");
  const paths = second.changes.map((c) => c.path);
  if (!paths.includes("profile.revision")) fail(`no revision row: ${JSON.stringify(second.changes)}`);
  if (!paths.includes("profile.tools")) fail(`no tools row: ${JSON.stringify(second.changes)}`);
  const revisionRow = second.changes.find((c) => c.path === "profile.revision");
  if (revisionRow.before !== first.profile.revision || revisionRow.after !== 9) {
    fail(`revision row was ${JSON.stringify(revisionRow)}`);
  }
  const toolsRow = second.changes.find((c) => c.path === "profile.tools");
  if (JSON.stringify(toolsRow.before) !== JSON.stringify(first.profile.tools) || JSON.stringify(toolsRow.after) !== JSON.stringify(["Read"])) {
    fail(`tools row was ${JSON.stringify(toolsRow)}`);
  }
  if (readSnapshot(join(dir, "t1")).revision !== 9) fail("the new snapshot does not carry the new revision");
});

test("a prior launch dir without a snapshot reads as an initial profile, not a diff", () => {
  const dir = base("no-prior");
  fixtureSquad(dir);
  mkdirSync(join(dir, "prev"), { recursive: true }); // launch-owned, but no snapshot.json
  const out = prepareAgentLaunch({
    squad: "dev",
    outputDir: join(dir, "next"),
    previousConfigDir: join(dir, "prev"),
    historyMode: "tree",
    env: launchEnv(dir),
  });
  if (out.profileInitial !== true) fail("a missing prior snapshot was treated as a diff");
  if (out.changes.length) fail(`changes recorded without a prior: ${JSON.stringify(out.changes)}`);
});

// ── secrets never travel ─────────────────────────────────────────────────────
console.log("\nprovider secrets are refused, never copied");

test("a credential-shaped squad settings.json refuses the launch and is never written", () => {
  const dir = base("secret");
  fixtureSquad(dir, { settings: '{"note":"sk-or-v1-abcdefghijklmnop"}' });
  const outputDir = join(dir, "launch");

  let threw = null;
  try {
    prepareAgentLaunch({ squad: "dev", outputDir, env: launchEnv(dir) });
  } catch (err) {
    threw = err;
  }
  if (!threw) fail("a credential-shaped source file did not refuse the launch");
  if (!/credential/.test(threw.message)) fail(`the refusal does not name the reason: ${threw.message}`);
  if (existsSync(join(outputDir, "settings.json"))) fail("the offending file was copied anyway");
  // The launch dir may hold earlier copies (the refusal is per-file) but never
  // the tool-profile snapshot — the launch as a whole was refused.
  if (existsSync(join(outputDir, "snapshot.json"))) fail("a refused launch still wrote its snapshot");
  if (existsSync(join(outputDir, "mcp.json"))) fail("a refused launch still wrote mcp.json");
});

test("a symlinked source is skipped, never followed", () => {
  const dir = base("symlink");
  const squad = fixtureSquad(dir);
  const outside = join(dir, "outside.txt");
  writeFileSync(outside, "private\n");
  try {
    symlinkSync(outside, join(squad, "agents", "escape.md"), "file");
  } catch {
    console.log("  SKIP symlink test (this platform/filesystem refuses symlinks)");
    return;
  }
  const outputDir = join(dir, "launch");
  const out = prepareAgentLaunch({ squad: "dev", outputDir, env: launchEnv(dir) });

  if (existsSync(join(outputDir, "agents", "escape.md"))) fail("a symlinked source was copied");
  if (!out.skipped.some((s) => s.why === "symlink-not-followed")) fail("the symlink skip was not reported");
  if (readFileSync(outside, "utf8") !== "private\n") fail("the symlink target was disturbed");
});

// ── resume-history confinement ───────────────────────────────────────────────
console.log("\nresume history confinement");

test("tree mode copies the previous launch's whole projects tree and nothing else of it", () => {
  const dir = base("history-tree");
  fixtureSquad(dir);
  const prev = join(dir, "t0");
  prepareAgentLaunch({ squad: "dev", outputDir: prev, env: launchEnv(dir) });
  // The previous turn's own transcripts, as the CLI would have written them.
  mkdirSync(join(prev, "projects", "wt-slug"), { recursive: true });
  writeFileSync(join(prev, "projects", "wt-slug", "sess-a.jsonl"), "{}\n");
  writeFileSync(join(prev, "projects", "wt-slug", "sess-b.jsonl"), "{}\n");
  // Auth next to it must not travel.
  writeFileSync(join(prev, ".credentials.json"), '{"ANTHROPIC_API_KEY":"nope"}');

  const out = prepareAgentLaunch({
    squad: "dev",
    outputDir: join(dir, "t1"),
    previousConfigDir: prev,
    historyMode: "tree",
    env: launchEnv(dir),
  });

  if (!existsSync(join(dir, "t1", "projects", "wt-slug", "sess-a.jsonl"))) fail("the child's own transcript was not carried over");
  if (!existsSync(join(dir, "t1", "projects", "wt-slug", "sess-b.jsonl"))) fail("a forked transcript of the same child was not carried over");
  if (existsSync(join(dir, "t1", ".credentials.json"))) fail("auth was copied out of the previous launch dir");
  if (out.history.copied.length !== 2) fail(`history copy count: ${JSON.stringify(out.history.copied)}`);
});

test("session mode copies ONLY this child's transcript out of a legacy shared dir", () => {
  const dir = base("history-session");
  const squad = fixtureSquad(dir);
  // A second child's transcript sits in the SAME shared dir — the shape that
  // makes a blind projects/ copy a leak.
  mkdirSync(join(squad, "projects", "proj-b"), { recursive: true });
  writeFileSync(join(squad, "projects", "proj-b", "other-child.jsonl"), "{}\n");

  const out = prepareAgentLaunch({
    squad: "dev",
    outputDir: join(dir, "launch"),
    previousConfigDir: squad,
    historyMode: "session",
    previousSessionId: "sess-1",
    env: launchEnv(dir),
  });

  const copied = out.history.copied.map((p) => p.split(/[\\/]/).pop());
  if (JSON.stringify(copied) !== JSON.stringify(["sess-1.jsonl"])) {
    fail(`history copy was not confined to the child's session: ${JSON.stringify(copied)}`);
  }
  if (existsSync(join(dir, "launch", "projects", "proj-b"))) fail("another child's project dir was copied");
  if (existsSync(join(dir, "launch", ".credentials.json"))) fail("auth was copied out of the shared dir");
});

test('historyMode "session" without a session id is a caller bug', () => {
  const dir = base("history-bug");
  fixtureSquad(dir);
  let threw = null;
  try {
    prepareAgentLaunch({ squad: "dev", outputDir: join(dir, "l"), previousConfigDir: join(dir, "squads", "dev"), historyMode: "session", env: launchEnv(dir) });
  } catch (err) {
    threw = err;
  }
  if (!threw) fail("session-mode history without a session id did not refuse");
});

// ── the OTel identity ────────────────────────────────────────────────────────
console.log("\nruntime telemetry identity");

const CONTEXT = {
  taskKey: "FOC-123",
  supervisorSessionId: "sup-session-1",
  workflowRunId: "2026-10-13T10-00-00-000-supervisor-0001",
  attemptId: "dev-1:turn:0",
  actorId: "2026-10-13T10-00-00-000-supervisor-0001:dev-1",
  role: "squadlead",
};

test("a valid context yields the loopback OTel env with the fenix identity", () => {
  const dir = base("otel");
  fixtureSquad(dir);
  const out = prepareAgentLaunch({ squad: "dev", outputDir: join(dir, "launch"), env: launchEnv(dir), context: CONTEXT });

  if (out.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT !== "http://127.0.0.1:4318/v1/traces") {
    fail(`collector endpoint: ${out.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT}`);
  }
  const attrs = out.env.OTEL_RESOURCE_ATTRIBUTES ?? "";
  for (const pair of ["fenix.task_key=FOC-123", "fenix.supervisor_session_id=sup-session-1", "fenix.actor_id=", "fenix.attempt_id=dev-1%3Aturn%3A0", "fenix.role=squadlead"]) {
    if (!attrs.includes(pair)) fail(`resource attributes missing ${pair}: ${attrs}`);
  }

  // The same identity ALSO rides as plain env: the child's own scoped
  // current-run resolution reads FENIX_SUPERVISOR_SESSION_ID and LA_TASK_KEY
  // from the environment, not from the OTel resource attributes.
  if (out.env.FENIX_SUPERVISOR_SESSION_ID !== "sup-session-1") fail(`plain session id: ${out.env.FENIX_SUPERVISOR_SESSION_ID}`);
  if (out.env.LA_TASK_KEY !== "FOC-123") fail(`plain task key: ${out.env.LA_TASK_KEY}`);
  if (out.env.FENIX_ACTOR_ID !== CONTEXT.actorId) fail(`plain actor id: ${out.env.FENIX_ACTOR_ID}`);
  if (out.env.FENIX_ATTEMPT_ID !== "dev-1:turn:0") fail(`plain attempt id: ${out.env.FENIX_ATTEMPT_ID}`);
  if (out.env.FENIX_ACTOR_ROLE !== "squadlead") fail(`plain actor role: ${out.env.FENIX_ACTOR_ROLE}`);
});

test("no context (a legacy flow) means no OTel env at all", () => {
  const dir = base("otel-legacy");
  fixtureSquad(dir);
  const out = prepareAgentLaunch({ squad: "dev", outputDir: join(dir, "launch"), env: launchEnv(dir) });
  if (Object.keys(out.env).some((key) => key.startsWith("OTEL_") || key.startsWith("CLAUDE_CODE_"))) {
    fail(`legacy flow received telemetry env: ${JSON.stringify(Object.keys(out.env))}`);
  }
  // Nor the plain scoped identity — a legacy child must never trip the scoped
  // current-run resolution by carrying half of it.
  for (const key of ["FENIX_SUPERVISOR_SESSION_ID", "LA_TASK_KEY", "FENIX_ACTOR_ID", "FENIX_ATTEMPT_ID", "FENIX_ACTOR_ROLE"]) {
    if (out.env[key] !== undefined) fail(`legacy flow received ${key}`);
  }
});

test("a context with an invalid token throws instead of reaching the collector", () => {
  const dir = base("otel-bad");
  fixtureSquad(dir);
  let threw = null;
  try {
    prepareAgentLaunch({ squad: "dev", outputDir: join(dir, "launch"), env: launchEnv(dir), context: { ...CONTEXT, actorId: "bad actor id" } });
  } catch (err) {
    threw = err;
  }
  if (!threw) fail("an invalid telemetry context did not throw");
});

// ── the identity helpers ─────────────────────────────────────────────────────
console.log("\nidentity helpers");

test("attemptId is per-turn, actorId is stable for the child's life", () => {
  if (attemptIdFor("dev-1", 0) !== "dev-1:turn:0") fail(`attemptIdFor: ${attemptIdFor("dev-1", 0)}`);
  if (attemptIdFor("dev-1", 3) !== "dev-1:turn:3") fail(`attemptIdFor: ${attemptIdFor("dev-1", 3)}`);
  if (actorIdFor("run-a", "dev-1") !== "run-a:dev-1") fail(`actorIdFor: ${actorIdFor("run-a", "dev-1")}`);
  if (actorIdFor("run-a", "dev-1") !== actorIdFor("run-a", "dev-1")) fail("actorId is not stable");
  if (launchDirFor("/state/run-1", "dev-1", 2).split(/[\\/]/).slice(-3).join("/") !== "launch/dev-1/turn-2") {
    fail(`launchDirFor: ${launchDirFor("/state/run-1", "dev-1", 2)}`);
  }
});

test("a missing squad or outputDir is a caller bug", () => {
  const dir = base("validate");
  fixtureSquad(dir);
  const env = launchEnv(dir);
  for (const bad of [
    { outputDir: join(dir, "l"), env },
    { squad: "dev", env },
  ]) {
    let threw = null;
    try {
      prepareAgentLaunch(bad);
    } catch (err) {
      threw = err;
    }
    if (!threw) fail(`missing argument accepted: ${JSON.stringify(Object.keys(bad))}`);
  }
});

// ── summary ──────────────────────────────────────────────────────────────────
for (const dir of cleanup) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`failed: ${failures.join(" | ")}`);
  process.exitCode = 1;
}
