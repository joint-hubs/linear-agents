// scripts/supervisor-watch.test.mjs — the watcher consumes the launch profile's
// --claude-args and puts them on the REAL claude command line.
//
// End-to-end through supervisor-watch.mjs, with a fake claude behind the
// LA_CLAUDE_BIN seam (the same seam supervisor-watch-cost.test.mjs uses): the
// fake dumps the argv it was actually invoked with, then emits system/init +
// a result so the turn completes. A parser-level test could never catch the
// regression this file exists for — spawn/followup already passed
// --claude-args and the watcher silently ignored it — so the assertions here
// read the fake's argv dump: --tools, --mcp-config and --disallowedTools must
// arrive at claude itself, in BOTH the fresh and the --resume path, beside the
// flags the watcher sets itself (permission mode, settings, model, session).
//
// Malformed payloads are refused BEFORE the spawn: claude is never launched,
// the registry entry goes crashed with the reason, and the tee carries the
// note. The argv dump file's absence is the proof of "never launched".
//
// Everything runs in temp dirs: LA_SUPERVISOR_STATE_HOME, LA_SQUAD_HOME,
// CLAUDE_CONFIG_DIR, LA_SUPERVISOR_NO_TELEMETRY=1 and no --telemetry-run flag,
// so the real .state/ and the telemetry store are never touched.
//
// Run: node scripts/supervisor-watch.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureRunDir, readRegistry, runDir, writeRegistry } from "./supervisor-lib.mjs";
import { openAgentState, setFact } from "./agent-state.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WATCH = join(ROOT, "scripts", "supervisor-watch.mjs");

let passed = 0;
const failures = [];
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

const base = mkdtempSync(join(tmpdir(), "la-watch-args-"));
const stateHome = join(base, "state");
const squadHome = join(base, "agents");
const configDir = join(base, "config");
const cwd = join(base, "wt");
// Pinned BEFORE any supervisor-lib call: the fixture registries must land in
// the temp tree, never in the repo's real .state/supervisor/.
process.env.LA_SUPERVISOR_STATE_HOME = stateHome;
process.env.LA_SQUAD_HOME = squadHome;
mkdirSync(stateHome, { recursive: true });
mkdirSync(join(squadHome, "dev"), { recursive: true });
mkdirSync(configDir, { recursive: true });
mkdirSync(cwd, { recursive: true });
process.on("exit", () => {
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {}
});

// The fake claude: dump the argv it was ACTUALLY invoked with, then behave well
// enough for a turn (init + result + clean exit).
const FAKE_CLAUDE = join(base, "fake-claude.mjs");
writeFileSync(
  FAKE_CLAUDE,
  [
    `import { writeFileSync } from "node:fs";`,
    `writeFileSync(process.env.FAKE_ARGV_PATH, JSON.stringify(process.argv.slice(2), null, 2));`,
    `const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");`,
    `out({ type: "system", subtype: "init", session_id: process.env.FAKE_SESSION_ID, tools: [], model: "fake/model" });`,
    `out({ type: "result", subtype: "success", session_id: process.env.FAKE_SESSION_ID, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } });`,
    `process.exit(0);`,
    ``,
  ].join("\n"),
);

const promptFile = join(base, "prompt.txt");
writeFileSync(promptFile, "kickoff", "utf8");
const settingsFile = join(base, "child-settings.json");
writeFileSync(settingsFile, JSON.stringify({ permissions: { deny: [] } }), "utf8");

const mcpConfigPath = join(configDir, "mcp.json");
// A value with shell metacharacters: if anything between here and claude
// interpolated or re-split it, the dump below would show fragments, not this
// string as ONE element.
const disallowed = "mcp__thoughtmap__delete_all; rm -rf / && echo pwned";

const PROFILE_ARGS = ["--tools", "builtins", "--mcp-config", mcpConfigPath, "--disallowedTools", disallowed];

function fixtureChild(runId, { sessionId = null } = {}) {
  ensureRunDir(runId);
  writeRegistry(runId, {
    runId,
    children: {
      "dev-1": {
        childId: "dev-1",
        squad: "dev",
        taskId: "FOC-999",
        status: "starting",
        sessionId,
        costUsd: 0,
        turns: [],
        worktree: cwd,
        permissionMode: "bypassPermissions",
      },
    },
    rounds: {},
  });
}

function runWatcher(runId, extraArgs = [], env = {}) {
  return spawnSync(
    process.execPath,
    [WATCH, "--run", runId, "--child", "dev-1", "--cwd", cwd, "--prompt-file", promptFile, "--turn", "0", ...extraArgs],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        LA_SUPERVISOR_STATE_HOME: stateHome,
        LA_SQUAD_HOME: squadHome,
        CLAUDE_CONFIG_DIR: configDir,
        LA_SUPERVISOR_NO_TELEMETRY: "1",
        LA_SUPERVISOR_NO_CODEGRAPH: "1",
        LA_CLAUDE_BIN: FAKE_CLAUDE,
        ...env,
      },
    },
  );
}

const readDump = (path) => JSON.parse(readFileSync(path, "utf8"));

// ── fresh turn ───────────────────────────────────────────────────────────────
console.log("\nfresh turn: the profile reaches the real claude argv");

const runIdA = `test-watch-args-fresh-${process.pid}`;
fixtureChild(runIdA);
const dumpA = join(base, "argv-fresh.json");
const resultA = runWatcher(
  runIdA,
  [
    "--settings", settingsFile,
    "--model", "z-ai/glm-5.3-flash",
    "--claude-args", JSON.stringify(PROFILE_ARGS),
  ],
  { FAKE_ARGV_PATH: dumpA, FAKE_SESSION_ID: `watch-args-fresh-${process.pid}` },
);

test("the watcher ran the fake claude to a clean exit", () => {
  assert.equal(resultA.status, 0, `watcher exit ${resultA.status}: ${resultA.stderr}`);
  assert.equal(readRegistry(runIdA).children["dev-1"].status, "exited");
});

test("the mock claude received --tools builtins, --mcp-config and --disallowedTools", () => {
  assert.ok(existsSync(dumpA), "the fake claude was never invoked");
  const argv = readDump(dumpA);
  const indexOf = (flag) => argv.indexOf(flag);
  assert.notEqual(indexOf("--tools"), -1, `no --tools in argv: ${JSON.stringify(argv)}`);
  assert.equal(argv[indexOf("--tools") + 1], "builtins");
  assert.notEqual(indexOf("--mcp-config"), -1, `no --mcp-config in argv: ${JSON.stringify(argv)}`);
  assert.equal(argv[indexOf("--mcp-config") + 1], mcpConfigPath);
  assert.notEqual(indexOf("--disallowedTools"), -1, `no --disallowedTools in argv: ${JSON.stringify(argv)}`);
  assert.equal(argv[indexOf("--disallowedTools") + 1], disallowed);
});

test("the profile args ride beside the flags the watcher sets itself", () => {
  const argv = readDump(dumpA);
  for (const [flag, value] of [
    ["--permission-mode", "bypassPermissions"],
    ["--settings", settingsFile],
    ["--model", "z-ai/glm-5.3-flash"],
    ["-p", "kickoff"],
    ["--output-format", "stream-json"],
    ["--verbose"],
  ]) {
    const at = argv.indexOf(flag);
    assert.notEqual(at, -1, `the watcher's own ${flag} disappeared: ${JSON.stringify(argv)}`);
    if (value !== undefined) assert.equal(argv[at + 1], value, `${flag} lost its value`);
  }
});

test("a shell-metacharacter value arrived verbatim as ONE argv element — no interpolation", () => {
  const argv = readDump(dumpA);
  assert.ok(
    argv.some((a) => a === disallowed),
    `the value was split, quoted away or rewritten: ${JSON.stringify(argv)}`,
  );
  assert.ok(!argv.includes("pwned"), "the metacharacter value leaked as separate tokens");
});

test("the fresh path passes no --resume", () => {
  assert.ok(!readDump(dumpA).includes("--resume"), "a fresh turn must not resume");
});

// ── resume turn ──────────────────────────────────────────────────────────────
console.log("\nresume turn: the profile reaches the real claude argv too");

const runIdB = `test-watch-args-resume-${process.pid}`;
const previousSession = `watch-args-prev-${process.pid}`;
fixtureChild(runIdB, { sessionId: previousSession });
const dumpB = join(base, "argv-resume.json");
const resultB = runWatcher(
  runIdB,
  [
    "--session", previousSession,
    "--turn", "1",
    "--settings", settingsFile,
    "--model", "z-ai/glm-5.3-flash",
    "--claude-args", JSON.stringify(PROFILE_ARGS),
  ],
  { FAKE_ARGV_PATH: dumpB, FAKE_SESSION_ID: `watch-args-res-${process.pid}` },
);

test("the resumed turn carries BOTH --resume and the profile args", () => {
  assert.equal(resultB.status, 0, `watcher exit ${resultB.status}: ${resultB.stderr}`);
  const argv = readDump(dumpB);
  const at = argv.indexOf("--resume");
  assert.notEqual(at, -1, `no --resume in argv: ${JSON.stringify(argv)}`);
  assert.equal(argv[at + 1], previousSession);
  assert.notEqual(argv.indexOf("--tools"), -1, "the fresh path got --tools, the resume path lost it");
  assert.equal(argv[argv.indexOf("--tools") + 1], "builtins");
  assert.equal(argv[argv.indexOf("--mcp-config") + 1], mcpConfigPath);
  assert.equal(argv[argv.indexOf("--disallowedTools") + 1], disallowed);
  assert.equal(argv[argv.indexOf("--model") + 1], "z-ai/glm-5.3-flash", "the pinned model must survive");
  assert.equal(argv[argv.indexOf("--settings") + 1], settingsFile, "the deny-list settings must survive");
});

// ── malformed --claude-args: refused before launch ───────────────────────────
console.log("\nmalformed --claude-args: claude is never launched");

const MALFORMED = [
  ["not valid JSON", "{not json"],
  ["a JSON object, not an array", JSON.stringify({ evil: "--permission-mode" })],
  ["an array with a non-string element", JSON.stringify(["--tools", 42])],
  ["a bare flag, no value", true],
];

for (const [why, payload] of MALFORMED) {
  const runId = `test-watch-args-bad-${process.pid}-${MALFORMED.findIndex(([w]) => w === why)}`;
  fixtureChild(runId);
  const dump = join(base, `argv-bad-${Math.random().toString(36).slice(2)}.json`);
  const extra = payload === true ? ["--claude-args"] : ["--claude-args", payload];
  const r = runWatcher(runId, extra, { FAKE_ARGV_PATH: dump, FAKE_SESSION_ID: `watch-args-bad-${process.pid}` });

  test(`refused before launch: ${why}`, () => {
    assert.notEqual(r.status, 0, `the watcher exited 0 on a malformed profile: ${r.stdout}`);
    const entry = readRegistry(runId).children["dev-1"];
    assert.equal(entry.status, "crashed", `the child was not marked crashed: ${JSON.stringify(entry)}`);
    assert.match(entry.error, /claude-args/, `the error does not name the flag: ${entry.error}`);
    assert.ok(!existsSync(dump), "claude was launched despite a malformed profile");
    // The tee is where a headless watcher explains itself.
    const tee = join(runDir(runId), "children", "dev-1.jsonl");
    assert.ok(existsSync(tee), "no tee note for the refusal");
    assert.ok(
      readFileSync(tee, "utf8").includes("claude_args_rejected"),
      "the tee does not carry the rejection note",
    );
  });
}

test("no --claude-args flag: the watcher behaves exactly as before", () => {
  const runId = `test-watch-args-none-${process.pid}`;
  fixtureChild(runId);
  const dump = join(base, "argv-none.json");
  const r = runWatcher(runId, [], { FAKE_ARGV_PATH: dump, FAKE_SESSION_ID: `watch-args-none-${process.pid}` });
  assert.equal(r.status, 0, `watcher exit ${r.status}: ${r.stderr}`);
  assert.equal(readRegistry(runId).children["dev-1"].status, "exited");
  const argv = readDump(dump);
  assert.equal(argv.indexOf("--tools"), -1, "a phantom --tools appeared with no profile");
});

// ── FOC-730: the turn-end working-state prune ────────────────────────────────
console.log("\nturn-end prune: turn-scoped facts retire at child exit");

// The store must exist BEFORE the watcher runs — a missing store is skipped
// silently (legacy runs never grow one), so the prune test seeds it up front.
const pruneDb = join(base, "agent-state.sqlite");
const runIdC = `test-watch-prune-${process.pid}`;
fixtureChild(runIdC);
{
  const store = openAgentState(pruneDb);
  try {
    setFact(store, { namespace: `child:${runIdC}/dev-1`, key: "turn_key", value: "t", reason: "turn fact", scope: "turn" });
    setFact(store, { namespace: `child:${runIdC}/dev-1`, key: "task_key", value: "k", reason: "task fact" });
    setFact(store, {
      namespace: `child:${runIdC}/dev-1`, key: "anchor", value: "doc",
      tier: "base", source: "config", evidence: "docs/anchor.md", reason: "seed",
    });
    setFact(store, { namespace: "child:other-run/dev-1", key: "keep_key", value: "v", reason: "other child" });
  } finally {
    store.close();
  }
}
const dumpC = join(base, "argv-prune.json");
const resultC = runWatcher(
  runIdC,
  [],
  { FAKE_ARGV_PATH: dumpC, FAKE_SESSION_ID: `watch-prune-${process.pid}`, LA_AGENT_STATE_DB: pruneDb },
);

test("the child exit retired turn-scoped facts only, and recorded it", () => {
  assert.equal(resultC.status, 0, `watcher exit ${resultC.status}: ${resultC.stderr}`);
  assert.equal(readRegistry(runIdC).children["dev-1"].status, "exited");
  const entry = readRegistry(runIdC).children["dev-1"];
  assert.ok(entry.workingStatePruned, "no workingStatePruned on the child entry");
  assert.deepEqual(entry.workingStatePruned.turn.retired, ["turn_key"]);
  const store = openAgentState(pruneDb);
  try {
    const status = (key, ns) =>
      store.db
        .prepare("SELECT status FROM facts WHERE namespace = ? AND key = ?")
        .get(ns, key)?.status;
    const ns = `child:${runIdC}/dev-1`;
    assert.equal(status("turn_key", ns), "retired");
    assert.equal(status("task_key", ns), "active");
    assert.equal(status("anchor", ns), "active"); // base keys are never pruned
    assert.equal(status("keep_key", "child:other-run/dev-1"), "active"); // other namespaces untouched
  } finally {
    store.close();
  }
});

test("an unopenable store skips the prune with one stderr line, exit still recorded", () => {
  // existsSync(dir) is true, so the watcher proceeds and openAgentState throws
  const notADb = join(base, "not-a-db");
  mkdirSync(notADb, { recursive: true });
  const runIdD = `test-watch-prune-fail-${process.pid}`;
  fixtureChild(runIdD);
  const dumpD = join(base, "argv-prune-fail.json");
  const r = runWatcher(
    runIdD,
    [],
    { FAKE_ARGV_PATH: dumpD, FAKE_SESSION_ID: `watch-prune-fail-${process.pid}`, LA_AGENT_STATE_DB: notADb },
  );
  assert.equal(r.status, 0, `watcher exit ${r.status}: ${r.stderr}`);
  const entry = readRegistry(runIdD).children["dev-1"];
  assert.equal(entry.status, "exited", "a failed prune must not change the exit status");
  assert.equal(entry.workingStatePruned, undefined);
  const lines = r.stderr.split("\n").filter((l) => l.includes("agent-state: turn prune skipped ("));
  assert.equal(lines.length, 1, `expected exactly one skip line, got: ${JSON.stringify(lines)}`);
});

console.log("");
if (failures.length) {
  console.log(`${passed} passed, ${failures.length} FAILED`);
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);
