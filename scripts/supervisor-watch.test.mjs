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
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  childShareHelperArgv,
  ensureRunDir,
  installEnvFileSignalHandlers,
  readRegistry,
  runDir,
  shareChildTranscripts,
  sweepChildProcesses,
  sweepMarkFor,
  writeRegistry,
} from "./supervisor-lib.mjs";
import { openAgentState, setFact } from "./agent-state.mjs";
import { scrubbedEnv } from "./supervisor-test-fixtures.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WATCH = join(ROOT, "scripts", "supervisor-watch.mjs");

let passed = 0;
const failures = [];
const pending = [];
function test(name, fn) {
  // An async fn is supported for the tests that must wait on the event loop:
  // a child-process object only learns of an exit on a loop tick, which a
  // synchronous Atomics.wait spin never gives it (FOC-802).
  const settle = (err) => {
    if (err) {
      failures.push(name);
      console.log(`  FAIL ${name}\n       ${err.message}`);
    } else {
      passed++;
      console.log(`  PASS ${name}`);
    }
  };
  try {
    const r = fn();
    if (r instanceof Promise) pending.push(r.then(() => settle(), settle));
    else settle();
  } catch (err) {
    settle(err);
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

// ── FOC-979: the sweep mark selection (sweepMarkFor, unit level) ──────────────
console.log("\nFOC-979: wybór marki do sweepa (unit)");

const SWEEP_RUN = "test-sweep-mark-run";
const SWEEP_CHILD = "dev-1";

test("FOC-979: entry.mark wins over anything in the environment", () => {
  const entry = { mark: `${SWEEP_RUN}/${SWEEP_CHILD}/at-entry`, attemptId: "at-entry-fallback" };
  const res = sweepMarkFor(entry, {
    env: { LA_CHILD_MARK: `${SWEEP_RUN}/${SWEEP_CHILD}/at-env` },
    runId: SWEEP_RUN,
    childId: SWEEP_CHILD,
  });
  assert.equal(res.mark, `${SWEEP_RUN}/${SWEEP_CHILD}/at-entry`);
  assert.equal(res.foreignEnvMark, null, "a proper entry mark means no foreign mark to report");
});

test("FOC-979: a matching env mark is used when the entry carries none", () => {
  const res = sweepMarkFor(
    {},
    {
      env: { LA_CHILD_MARK: `${SWEEP_RUN}/${SWEEP_CHILD}/at-env` },
      runId: SWEEP_RUN,
      childId: SWEEP_CHILD,
    },
  );
  assert.equal(res.mark, `${SWEEP_RUN}/${SWEEP_CHILD}/at-env`);
  assert.equal(res.foreignEnvMark, null);
});

test("FOC-979: a foreign env mark is rejected and reported", () => {
  const res = sweepMarkFor(
    {},
    {
      env: { LA_CHILD_MARK: "other-run/other-child/at-turn" },
      runId: SWEEP_RUN,
      childId: SWEEP_CHILD,
    },
  );
  assert.equal(res.mark, null, "a foreign mark must never be swept with");
  assert.equal(res.foreignEnvMark, "other-run/other-child/at-turn");
});

test("FOC-979: the attemptId fallback still applies after a foreign mark", () => {
  const res = sweepMarkFor(
    { attemptId: "dev-1:turn:0" },
    {
      env: { LA_CHILD_MARK: "other-run/other-child/at-turn" },
      runId: SWEEP_RUN,
      childId: SWEEP_CHILD,
    },
  );
  assert.equal(res.mark, `${SWEEP_RUN}/${SWEEP_CHILD}/dev-1:turn:0`, "the entry's own attemptId builds a mark");
  assert.equal(res.foreignEnvMark, "other-run/other-child/at-turn");
});

test("FOC-979: no mark anywhere yields null", () => {
  const res = sweepMarkFor(
    {},
    {
      env: {},
      runId: SWEEP_RUN,
      childId: SWEEP_CHILD,
    },
  );
  assert.equal(res.mark, null);
  assert.equal(res.foreignEnvMark, null, "an absent mark is not a foreign mark");
});

// The fake claude: dump the argv it was ACTUALLY invoked with, then behave well
// enough for a turn (init + result + clean exit). FAKE_SKIP_INIT suppresses the
// init event; FAKE_INIT_MODEL overrides the served model; the FOC-607 probe
// dumps what the turn record carries WHILE the child is still alive.
const FAKE_CLAUDE = join(base, "fake-claude.mjs");
writeFileSync(
  FAKE_CLAUDE,
  [
    `import { readFileSync, writeFileSync } from "node:fs";`,
    `writeFileSync(process.env.FAKE_ARGV_PATH, JSON.stringify(process.argv.slice(2), null, 2));`,
    `const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");`,
    `if (!process.env.FAKE_SKIP_INIT) {`,
    `  out({ type: "system", subtype: "init", session_id: process.env.FAKE_SESSION_ID, tools: [], model: process.env.FAKE_INIT_MODEL ?? "fake/model" });`,
    `}`,
    `if (process.env.FAKE_PROBE_PATH) {`,
    `  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));`,
    `  let probe = { initModel: null, endedAt: "(turn record not seen)" };`,
    `  for (let i = 0; i < 120; i++) {`,
    `    try {`,
    `      const turn = JSON.parse(readFileSync(process.env.FAKE_REGISTRY_PATH, "utf8")).children["dev-1"].turns[0];`,
    `      if (turn?.initModel) { probe = { initModel: turn.initModel, endedAt: turn.endedAt }; break; }`,
    `    } catch {}`,
    `    await sleep(25);`,
    `  }`,
    `  writeFileSync(process.env.FAKE_PROBE_PATH, JSON.stringify(probe));`,
    `}`,
    `out({ type: "result", subtype: "success", session_id: process.env.FAKE_SESSION_ID, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } });`,
    `process.exit(0);`,
    ``,
  ].join("\n"),
);

// A claude that dumps its argv and then FAILS with exit 2 — the L2 case: under
// isolation that must read as a normal child exit 2 (crashed), never as an
// isolation error (the helper's refusal is exit 97, deliberately unambiguous).
const FAKE_CLAUDE_FAIL = join(base, "fake-claude-fail.mjs");
writeFileSync(
  FAKE_CLAUDE_FAIL,
  [
    `import { writeFileSync } from "node:fs";`,
    `writeFileSync(process.env.FAKE_ARGV_PATH, JSON.stringify(process.argv.slice(2), null, 2));`,
    `process.exit(2);`,
    ``,
  ].join("\n"),
);

// A claude that hangs — keeps the watcher (and the env file) alive long enough
// for the SIGTERM test below to kill the watcher mid-turn.
const FAKE_CLAUDE_HANG = join(base, "fake-claude-hang.mjs");
writeFileSync(
  FAKE_CLAUDE_HANG,
  [
    `setInterval(() => {}, 1000); // never exits`,
    ``,
  ].join("\n"),
);

// FOC-913: a claude that spawns a grandchild in its OWN process group holding
// the inherited stdout pipe, then stays alive itself until a signal lands. The
// watcher's group kill reaches the child but not the holder, so `close` is
// delayed ~3 s past the child's exit — the exact case the TAIL_DRAIN_MS bound
// exists for, and the one where the old signal terminator raced the finalizer.
const FAKE_CLAUDE_PIPE_HOLDER = join(base, "fake-claude-pipe-holder.mjs");
writeFileSync(
  FAKE_CLAUDE_PIPE_HOLDER,
  [
    `import { spawn } from "node:child_process";`,
    `import { writeFileSync } from "node:fs";`,
    `const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");`,
    `out({ type: "system", subtype: "init", session_id: process.env.FAKE_SESSION_ID, tools: [], model: "fake/model" });`,
    `out({ type: "result", subtype: "success", session_id: process.env.FAKE_SESSION_ID, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } });`,
    `const holder = spawn(process.execPath,`,
    `  ["-e", "setTimeout(() => process.exit(0), 3000)"],`,
    `  { detached: true, stdio: ["ignore", "inherit", "ignore"] });`,
    `holder.unref();`,
    `// Written AFTER the holder exists, so the test's readiness poll can never`,
    `// signal before the pipe is actually held.`,
    `writeFileSync(process.env.FAKE_ARGV_PATH, "holder-spawned");`,
    `setInterval(() => {}, 1000); // the child itself waits for the watcher's signal`,
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
        ...scrubbedEnv(),
        // Deterministic isolation state for every run below: not in a container,
        // so each spawn takes today's unisolated path unless a test opts in.
        FENIX_IN_CONTAINER: "",
        FENIX_CHILD_ISOLATION: "",
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
// ── child isolation (FOC-802) ────────────────────────────────────────────────
console.log("\nchild isolation: the claude spawn goes through the drop-privilege helper");

// The helper itself is built by another worker (docker/fenix-spawn-as-child.sh);
// the watcher only checks that SOMETHING exists at the configured path, so the
// fixture is a marker file — `sudo` is faked below, the helper is never execed.
const HELPER_PATH = join(base, "fenix-spawn-as-child");
writeFileSync(HELPER_PATH, "#!/bin/sh\nexit 0\n", "utf8");

// The fake sudo: records the argv it received plus the env file it was handed
// (contents and mode — the watcher deletes the file when the child exits, so
// this observation is the only chance to assert them), then applies the env
// file as the real helper does and execs what follows `--` with it.
const FAKE_SUDO = join(base, "fake-sudo.mjs");
writeFileSync(
  FAKE_SUDO,
  [
    `import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";`,
    `import { spawn } from "node:child_process";`,
    `const argv = process.argv.slice(2);`,
    `if (process.env.FAKE_SUDO_CALLS_PATH) appendFileSync(process.env.FAKE_SUDO_CALLS_PATH, "call\\n");`,
    `if (process.env.FAKE_SUDO_REFUSE) process.exit(97); // the refusal code, unambiguous vs a child's exit 2 (L2)`,
    `const envFile = argv[2];`,
    `const sep = argv.indexOf("--");`,
    `const env = {};`,
    `for (const line of readFileSync(envFile, "utf8").split("\\n")) {`,
    `  if (!line) continue;`,
    `  const at = line.indexOf("=");`,
    `  env[line.slice(0, at)] = line.slice(at + 1);`,
    `}`,
    `if (process.env.FAKE_SUDO_OBS_PATH) {`,
    `  writeFileSync(process.env.FAKE_SUDO_OBS_PATH, JSON.stringify({`,
    `    argv,`,
    `    envFileMode: statSync(envFile).mode & 0o777,`,
    `    envFile: readFileSync(envFile, "utf8"),`,
    `  }, null, 2));`,
    `}`,
    `const child = spawn(argv[sep + 1], argv.slice(sep + 2), { env, stdio: ["ignore", "pipe", "pipe"] });`,
    `child.stdout.pipe(process.stdout);`,
    `child.stderr.pipe(process.stderr);`,
    `child.on("exit", (code) => process.exit(code ?? 1));`,
    `child.on("error", () => process.exit(1));`,
    ``,
  ].join("\n"),
);

const envFilePath = join(configDir, "child.env");
const teeOf = (runId) => join(runDir(runId), "children", "dev-1.jsonl");
const callCount = (path) => (existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").length : 0);

// ── isolated path ────────────────────────────────────────────────────────────
const runIdIso = `test-watch-iso-${process.pid}`;
fixtureChild(runIdIso);
const dumpIso = join(base, "argv-iso.json");
const obsIso = join(base, "sudo-obs-iso.json");
const callsIso = join(base, "sudo-calls-iso.txt");
const resultIso = runWatcher(
  runIdIso,
  ["--settings", settingsFile],
  {
    FENIX_IN_CONTAINER: "1",
    LA_CHILD_SPAWN_HELPER: HELPER_PATH,
    LA_SUDO_BIN: FAKE_SUDO,
    FAKE_ARGV_PATH: dumpIso,
    FAKE_SESSION_ID: `watch-iso-${process.pid}`,
    FAKE_SUDO_OBS_PATH: obsIso,
    FAKE_SUDO_CALLS_PATH: callsIso,
  },
);

test("the isolated turn ran the fake claude to a clean exit", () => {
  assert.equal(resultIso.status, 0, `watcher exit ${resultIso.status}: ${resultIso.stderr}`);
  assert.equal(readRegistry(runIdIso).children["dev-1"].status, "exited");
});

test("sudo argv: -n <helper> <env-file> <worktree> <config-dir> -- <claude argv…>", () => {
  assert.ok(existsSync(obsIso), "the fake sudo was never invoked");
  const { argv } = JSON.parse(readFileSync(obsIso, "utf8"));
  assert.deepEqual(
    argv.slice(0, 6),
    ["-n", HELPER_PATH, envFilePath, cwd, configDir, "--"],
    `sudo argv prefix: ${JSON.stringify(argv)}`,
  );
  // After `--`: the resolved claude command (a .mjs seam rides node) plus
  // EXACTLY the args the fake claude reports it was invoked with.
  assert.equal(argv[6], process.execPath);
  assert.equal(argv[7], FAKE_CLAUDE);
  assert.deepEqual(argv.slice(8), readDump(dumpIso));
});

test("the env file carries the child env verbatim, KEY=VALUE, one per line", () => {
  const obs = JSON.parse(readFileSync(obsIso, "utf8"));
  const lines = obs.envFile.split("\n").filter(Boolean);
  for (const line of lines) assert.match(line, /^[^=\n]+=/, `not KEY=VALUE: ${line}`);
  assert.ok(lines.includes(`CLAUDE_CONFIG_DIR=${configDir}`), "the config dir is not in the env file");
  assert.ok(lines.some((l) => l.startsWith(`FAKE_SESSION_ID=`)), "the watcher's env was not carried");
});

test("the test seam never reaches the child env", () => {
  const obs = JSON.parse(readFileSync(obsIso, "utf8"));
  assert.ok(!obs.envFile.includes("LA_CHILD_SPAWN_HELPER="), "LA_CHILD_SPAWN_HELPER leaked into the env file");
});

test("the env file is 0640", () => {
  if (process.platform === "win32") return; // no POSIX mode bits on NTFS
  const obs = JSON.parse(readFileSync(obsIso, "utf8"));
  assert.equal(obs.envFileMode & 0o777, 0o640, `mode was ${obs.envFileMode.toString(8)}`);
});

test("the env file is removed when the child exits", () => {
  assert.ok(!existsSync(envFilePath), "child.env outlived the turn");
});

test("the turn record says isolated: true", () => {
  assert.equal(readRegistry(runIdIso).children["dev-1"].turns[0].isolated, true);
});

test("exactly one sudo call — no fallback spawn", () => {
  assert.equal(callCount(callsIso), 1);
});

// ── refusal: fail closed, no second spawn ────────────────────────────────────
const runIdRef = `test-watch-iso-refusal-${process.pid}`;
fixtureChild(runIdRef);
const dumpRef = join(base, "argv-refusal.json");
const callsRef = join(base, "sudo-calls-refusal.txt");
const resultRef = runWatcher(
  runIdRef,
  ["--settings", settingsFile],
  {
    FENIX_IN_CONTAINER: "1",
    LA_CHILD_SPAWN_HELPER: HELPER_PATH,
    LA_SUDO_BIN: FAKE_SUDO,
    FAKE_SUDO_REFUSE: "1",
    FAKE_ARGV_PATH: dumpRef,
    FAKE_SESSION_ID: `watch-iso-ref-${process.pid}`,
    FAKE_SUDO_CALLS_PATH: callsRef,
  },
);

test("a helper refusal fails the turn closed — no unisolated fallback", () => {
  const entry = readRegistry(runIdRef).children["dev-1"];
  assert.equal(entry.status, "crashed", `status was ${entry.status}`);
  assert.match(entry.turns[0]?.isolationError ?? "", /refus/, "no isolationError on the turn record");
  assert.match(entry.error ?? "", /isolat/, "no clear isolation error at entry level");
});

test("a refusal never launches claude", () => {
  assert.ok(!existsSync(dumpRef), "claude was launched despite the refusal");
  assert.equal(callCount(callsRef), 1, "the watcher spawned more than once");
});

test("a refusal leaves a note in the tee", () => {
  assert.ok(
    readFileSync(teeOf(runIdRef), "utf8").includes("isolation_refused"),
    "the tee does not carry the refusal note",
  );
});

test("the refusal is the unambiguous 97, not a code a child can produce", () => {
  assert.match(
    readFileSync(teeOf(runIdRef), "utf8"),
    /exit 97/,
    "the refusal note does not name exit 97",
  );
});

// ── L2: a child that itself exits 2 under isolation is NOT an isolation error ─
const runIdTwo = `test-watch-iso-claude-exit2-${process.pid}`;
fixtureChild(runIdTwo);
const dumpTwo = join(base, "argv-claude-exit2.json");
const resultTwo = runWatcher(
  runIdTwo,
  ["--settings", settingsFile],
  {
    FENIX_IN_CONTAINER: "1",
    LA_CHILD_SPAWN_HELPER: HELPER_PATH,
    LA_SUDO_BIN: FAKE_SUDO,
    LA_CLAUDE_BIN: FAKE_CLAUDE_FAIL,
    FAKE_ARGV_PATH: dumpTwo,
    FAKE_SESSION_ID: `watch-iso-exit2-${process.pid}`,
  },
);

test("a claude exiting 2 under isolation is recorded as a normal exit 2", () => {
  assert.equal(resultTwo.status, 0, `watcher exit ${resultTwo.status}: ${resultTwo.stderr}`);
  const entry = readRegistry(runIdTwo).children["dev-1"];
  assert.equal(entry.status, "crashed", `status was ${entry.status}`);
  assert.equal(entry.exitCode, 2, `exitCode was ${entry.exitCode}`);
  assert.equal(entry.turns[0]?.exitCode, 2, "the turn record lost the child's own exit code");
  assert.ok(!("isolationError" in (entry.turns[0] ?? {})), "a child's exit 2 was dressed up as an isolation error");
  assert.equal(entry.error ?? null, null, "an isolation error leaked to entry level on a child's own exit 2");
  assert.ok(existsSync(dumpTwo), "claude was never launched");
  assert.ok(
    !readFileSync(teeOf(runIdTwo), "utf8").includes("isolation_refused"),
    "the tee carries a refusal note for a child's own exit 2",
  );
});

test("the env file is gone after a child that exited 2 as well", () => {
  assert.ok(!existsSync(envFilePath), "child.env outlived a crashed child");
});

// ── M1: a hard-killed watcher must not leave the env file behind ─────────────
// `process.on("exit")` does not run on SIGTERM — the Supervisor kills detached
// watchers hard, so the signal handlers are the removal that counts. POSIX
// only: on Windows a signal from another process terminates the process
// unconditionally without running Node handlers, so there is nothing to test
// end-to-end; the handler itself is unit-tested below on every platform.
if (process.platform !== "win32") {
  console.log("\nSIGTERM: the env file does not outlive a killed watcher");

  const runIdSig = `test-watch-iso-sigterm-${process.pid}`;
  fixtureChild(runIdSig);
  const watcher = spawn(
    process.execPath,
    [WATCH, "--run", runIdSig, "--child", "dev-1", "--cwd", cwd, "--prompt-file", promptFile, "--turn", "0", "--settings", settingsFile],
    {
      cwd: ROOT,
      stdio: "ignore",
      env: {
        ...scrubbedEnv(),
        FENIX_IN_CONTAINER: "1",
        LA_CHILD_SPAWN_HELPER: HELPER_PATH,
        LA_SUDO_BIN: FAKE_SUDO,
        LA_CLAUDE_BIN: FAKE_CLAUDE_HANG,
        LA_SUPERVISOR_STATE_HOME: stateHome,
        LA_SQUAD_HOME: squadHome,
        CLAUDE_CONFIG_DIR: configDir,
        LA_SUPERVISOR_NO_TELEMETRY: "1",
        LA_SUPERVISOR_NO_CODEGRAPH: "1",
        FAKE_SESSION_ID: `watch-iso-sig-${process.pid}`,
      },
    },
  );

  const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

  test("the watcher writes the env file and stays alive while the child hangs", () => {
    const deadline = Date.now() + 10_000;
    while (!existsSync(envFilePath) && Date.now() < deadline) sleepSync(50);
    assert.ok(existsSync(envFilePath), "the env file never appeared");
    assert.equal(watcher.exitCode, null, `the watcher exited on its own: ${watcher.exitCode}`);
  });

  test("SIGTERM removes the env file and kills the watcher", async () => {
    watcher.kill("SIGTERM");
    // The wait MUST yield: exitCode/signalCode are set from the child's exit
    // event, which only runs on an event-loop tick — a synchronous
    // Atomics.wait spin never observes the death and would report a watcher
    // that died instantly as a survivor (FOC-802). The watcher exits 143 once
    // it has killed the child's process group, within its own 2 s bound.
    const deadline = Date.now() + 10_000;
    while (watcher.exitCode === null && watcher.signalCode === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(
      watcher.exitCode === 143 || watcher.signalCode !== null,
      `the watcher survived SIGTERM or died wrongly: exit=${watcher.exitCode} signal=${watcher.signalCode}`,
    );
    assert.ok(!existsSync(envFilePath), "child.env outlived a SIGTERMed watcher");
    // The helper never ran to completion (the fake claude hangs forever), so
    // the fake sudo and its hanging child are still alive — kill the group the
    // detached watcher put them in, by the pid the registry recorded.
    const pid = readRegistry(runIdSig).children["dev-1"]?.turns?.[0]?.pid;
    if (pid) {
      try { process.kill(-pid, "SIGKILL"); } catch {}
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  });
}

// ── FOC-913: SIGTERM while a grandchild holds the stdout pipe ────────────────
// The old terminator fired 2 s after the SIGNAL, but the finalizer's
// TAIL_DRAIN_MS window only starts when the child's 'exit' lands — strictly
// later. With a grandchild in its own process group keeping the pipe open
// past that bound, the terminator fired first and the whole finalization was
// lost: registry left "running", no turn-end cost patch, no wake row. POSIX
// only, for the same reason as the SIGTERM block above: on win32 an external
// signal terminates the process unconditionally without running Node
// handlers, so the race has nothing end-to-end to exercise there.
if (process.platform !== "win32") {
  console.log("\nSIGTERM race: a pipe-holding grandchild must not beat the finalizer");

  const runIdRace = `test-watch-sigterm-race-${process.pid}`;
  fixtureChild(runIdRace);
  const dumpRace = join(base, "argv-sigterm-race.txt");
  // Mirrors the watcher's terminator deadline (TAIL_DRAIN_MS + 1500) — the
  // constant lives in the watcher, not in anything this test can import.
  const TAIL_DRAIN_BOUND_MS = 2000 + 1500;
  const watcher = spawn(
    process.execPath,
    [WATCH, "--run", runIdRace, "--child", "dev-1", "--cwd", cwd, "--prompt-file", promptFile, "--turn", "0"],
    {
      cwd: ROOT,
      stdio: "ignore",
      env: {
        ...scrubbedEnv(),
        // Unisolated on purpose: the drop-privilege helper sits between the
        // watcher and claude, and the holder would then inherit the pipe INTO
        // the helper — the helper's own exit would close the watcher's pipe
        // and the delay would never reach it. The direct spawn is the path
        // where the holder genuinely holds the watcher's stdout.
        FENIX_IN_CONTAINER: "",
        FENIX_CHILD_ISOLATION: "",
        LA_SUPERVISOR_STATE_HOME: stateHome,
        LA_SQUAD_HOME: squadHome,
        CLAUDE_CONFIG_DIR: configDir,
        LA_SUPERVISOR_NO_TELEMETRY: "1",
        LA_SUPERVISOR_NO_CODEGRAPH: "1",
        LA_CLAUDE_BIN: FAKE_CLAUDE_PIPE_HOLDER,
        FAKE_ARGV_PATH: dumpRace,
        FAKE_SESSION_ID: `watch-sig-race-${process.pid}`,
      },
    },
  );

  test("SIGTERM with the pipe held: the turn is finalized and the watcher exits within its bound", async () => {
    // Ready when the child has spawned the holder — the dump is written right
    // after the spawn, so dumping earlier would risk the kill landing before
    // the pipe was held and the race never exercised.
    const deadline = Date.now() + 10_000;
    while (!existsSync(dumpRace) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(existsSync(dumpRace), "the watcher never got the child and its pipe holder running");
    assert.equal(watcher.exitCode, null, `the watcher exited on its own: ${watcher.exitCode}`);

    watcher.kill("SIGTERM");
    const sentAt = Date.now();
    const killDeadline = sentAt + 15_000;
    while (watcher.exitCode === null && watcher.signalCode === null && Date.now() < killDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(
      watcher.exitCode === 143 || watcher.signalCode !== null,
      `the watcher survived SIGTERM: exit=${watcher.exitCode} signal=${watcher.signalCode}`,
    );
    // The finalizer runs at child-exit + TAIL_DRAIN_MS; the terminator's
    // deadline (TAIL_DRAIN_MS + 1500 from the signal) must stay strictly
    // beyond it — the watcher settles inside that bound, never past it.
    const elapsed = Date.now() - sentAt;
    assert.ok(elapsed < TAIL_DRAIN_BOUND_MS + 2500, `the watcher took ${elapsed} ms to settle — the bound leaked`);

    const entry = readRegistry(runIdRace).children["dev-1"];
    assert.ok(
      ["exited", "crashed", "stopped", "waiting_gate"].includes(entry.status),
      `the registry was left non-terminal ("${entry.status}") — the terminator fired before finalizeTurn`,
    );
    const turn = entry.turns?.[0] ?? {};
    assert.notEqual(turn.endedAt, null, "the turn record was never closed — finalizeTurn never ran");
    assert.equal(entry.signal, "SIGTERM", "the terminal signal was not recorded on the entry");
    assert.equal(entry.costSource, "result-max", "no turn-end cost patch — the finalization was lost");
  });
} else {
  console.log(
    "SKIP SIGTERM race test — win32 has no external-signal handler semantics, so the race cannot be exercised end-to-end",
  );
}

// ── unit: the signal handler removes the file, then re-raises exactly once ───
// Runs on every platform: the re-raise is injected, so nothing here kills the
// test process. The emits are IN-PROCESS, so the fixture drain-and-re-raise
// handlers (supervisor-test-fixtures.mjs installs them module-wide) must step
// aside for the duration: their re-raise kills the process unconditionally on
// win32 and would re-enter the test on POSIX.
const suspendForeignSignalHandlers = () => {
  const saved = {};
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    saved[signal] = process.listeners(signal);
    for (const listener of saved[signal]) process.removeListener(signal, listener);
  }
  return saved;
};
const restoreSignalHandlers = (saved) => {
  for (const [signal, listeners] of Object.entries(saved)) {
    for (const listener of listeners) process.on(signal, listener);
  }
};

test("installEnvFileSignalHandlers removes the file and re-raises, once per signal", () => {
  const saved = suspendForeignSignalHandlers();
  try {
    const removed = [];
    const raised = [];
    const handlers = installEnvFileSignalHandlers(() => removed.push("x"), { raise: (sig) => raised.push(sig) });
    try {
      process.emit("SIGTERM");
      process.emit("SIGINT");
      assert.deepEqual(raised, ["SIGTERM", "SIGINT"], `the re-raise went missing: ${JSON.stringify(raised)}`);
      // The listener removed itself before re-raising — a second signal of the
      // same kind takes the default action, not the handler again.
      process.emit("SIGTERM");
      assert.deepEqual(removed, ["x", "x"], `the file was not removed once per handled signal: ${JSON.stringify(removed)}`);
    } finally {
      for (const [sig, handler] of Object.entries(handlers)) process.removeListener(sig, handler);
    }
  } finally {
    restoreSignalHandlers(saved);
  }
});

test("a remove failure never swallows the re-raise", () => {
  const saved = suspendForeignSignalHandlers();
  try {
    const raised = [];
    const handlers = installEnvFileSignalHandlers(
      () => { throw new Error("unlink failed"); },
      { raise: (sig) => raised.push(sig) },
    );
    try {
      assert.doesNotThrow(() => process.emit("SIGHUP"));
      assert.deepEqual(raised, ["SIGHUP"], "a failing remove stopped the re-raise");
    } finally {
      for (const [sig, handler] of Object.entries(handlers)) process.removeListener(sig, handler);
    }
  } finally {
    restoreSignalHandlers(saved);
  }
});

// ── FENIX_CHILD_ISOLATION=off: today's path ──────────────────────────────────
const runIdOff = `test-watch-iso-off-${process.pid}`;
fixtureChild(runIdOff);
const dumpOff = join(base, "argv-off.json");
const obsOff = join(base, "sudo-obs-off.json");
const resultOff = runWatcher(
  runIdOff,
  ["--settings", settingsFile],
  {
    FENIX_IN_CONTAINER: "1",
    FENIX_CHILD_ISOLATION: "off",
    LA_CHILD_SPAWN_HELPER: HELPER_PATH,
    LA_SUDO_BIN: FAKE_SUDO,
    FAKE_ARGV_PATH: dumpOff,
    FAKE_SESSION_ID: `watch-iso-off-${process.pid}`,
    FAKE_SUDO_OBS_PATH: obsOff,
  },
);

test("FENIX_CHILD_ISOLATION=off takes today's unisolated path", () => {
  assert.equal(resultOff.status, 0, `watcher exit ${resultOff.status}: ${resultOff.stderr}`);
  assert.equal(readRegistry(runIdOff).children["dev-1"].status, "exited");
  assert.equal(readRegistry(runIdOff).children["dev-1"].turns[0].isolated, false);
  assert.ok(existsSync(dumpOff), "the claude spawn did not happen");
  assert.ok(!existsSync(obsOff), "sudo was invoked despite isolation=off");
});

// ── helper missing in container: warning + today's path ──────────────────────
const runIdMiss = `test-watch-iso-missing-${process.pid}`;
fixtureChild(runIdMiss);
const dumpMiss = join(base, "argv-missing.json");
const resultMiss = runWatcher(
  runIdMiss,
  ["--settings", settingsFile],
  {
    FENIX_IN_CONTAINER: "1",
    LA_CHILD_SPAWN_HELPER: join(base, "no-such-helper"),
    FAKE_ARGV_PATH: dumpMiss,
    FAKE_SESSION_ID: `watch-iso-miss-${process.pid}`,
  },
);

test("a missing helper in container warns and takes today's unisolated path", () => {
  assert.equal(resultMiss.status, 0, `watcher exit ${resultMiss.status}: ${resultMiss.stderr}`);
  const entry = readRegistry(runIdMiss).children["dev-1"];
  assert.equal(entry.status, "exited");
  assert.equal(entry.turns[0].isolated, false);
  assert.ok(existsSync(dumpMiss), "the claude spawn did not happen");
  assert.ok(
    readFileSync(teeOf(runIdMiss), "utf8").includes("isolation_helper_missing"),
    "the tee does not carry the missing-helper warning",
  );
});

// ── FOC-607: the turn record carries requestedModel vs initModel ─────────────
console.log("\nFOC-607: requested vs served model on the turn record");

const runIdDrift = `test-watch-model-drift-${process.pid}`;
fixtureChild(runIdDrift);
const probeDrift = join(base, "init-probe-drift.json");
const resultDrift = runWatcher(
  runIdDrift,
  ["--model", "requested/model"],
  {
    FAKE_ARGV_PATH: join(base, "argv-drift.json"),
    FAKE_SESSION_ID: `watch-drift-${process.pid}`,
    FAKE_INIT_MODEL: "served/other-model",
    FAKE_PROBE_PATH: probeDrift,
    FAKE_REGISTRY_PATH: join(runDir(runIdDrift), "children.json"),
  },
);

test("initModel is patched onto the turn record while the turn is still live", () => {
  assert.equal(resultDrift.status, 0, `watcher exit ${resultDrift.status}: ${resultDrift.stderr}`);
  const probe = JSON.parse(readFileSync(probeDrift, "utf8"));
  assert.equal(probe.initModel, "served/other-model", `the probe saw ${JSON.stringify(probe)}`);
  assert.equal(probe.endedAt, null, "the turn was already closed when init was seen");
});

test("a diverging system/init lands both models on the closed turn record", () => {
  const turn = readRegistry(runIdDrift).children["dev-1"].turns[0];
  assert.equal(turn.requestedModel, "requested/model");
  assert.equal(turn.initModel, "served/other-model");
  assert.notEqual(turn.endedAt, null, "the turn record was not closed");
  assert.notEqual(turn.exitCode, null, "the turn record has no exit code");
});

const runIdNoInit = `test-watch-no-init-${process.pid}`;
fixtureChild(runIdNoInit);
const resultNoInit = runWatcher(
  runIdNoInit,
  ["--model", "requested/model"],
  {
    FAKE_ARGV_PATH: join(base, "argv-no-init.json"),
    FAKE_SESSION_ID: `watch-noinit-${process.pid}`,
    FAKE_SKIP_INIT: "1",
  },
);

test("no system/init: requestedModel is kept, initModel stays null", () => {
  assert.equal(resultNoInit.status, 0, `watcher exit ${resultNoInit.status}: ${resultNoInit.stderr}`);
  const turn = readRegistry(runIdNoInit).children["dev-1"].turns[0];
  assert.equal(turn.requestedModel, "requested/model");
  assert.equal(turn.initModel, null);
});

// ── FOC-808 (slice B): the child sweep and the child TMPDIR ──────────────────
console.log("\nFOC-808: stray helpers swept at turn end, the child TMPDIR removed");

// A fixture /proc tree: <root>/<pid>/environ (NUL-separated) + comm. The
// production scan reads the real /proc (Linux container); the seam makes the
// same code testable here.
const makeProc = (root, pid, { environ, comm = "helper" }) => {
  const dir = join(root, String(pid));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "environ"), environ, "utf8");
  writeFileSync(join(dir, "comm"), `${comm}\n`, "utf8");
};

// A stray spawned by THIS process is a zombie after the kill until the event
// loop reaps it (POSIX): a liveness probe is only meaningful after a tick.
const strayAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
};
const reaped = (pid, ms = 3000) =>
  new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => (!strayAlive(pid) || Date.now() - t0 > ms ? resolve() : setTimeout(tick, 50));
    setTimeout(tick, 0);
  });

test("sweepChildProcesses signals exactly the processes carrying the mark", () => {
  const procRoot = join(base, "proc-unit");
  const MARK = "run-x/dev-1/dev-1:turn:0";
  makeProc(procRoot, 4210001, { environ: `PATH=/usr/bin\0LA_CHILD_MARK=${MARK}\0`, comm: "sleep" });
  makeProc(procRoot, 4210002, { environ: `LA_CHILD_MARK=${MARK}\0LANG=C`, comm: "postgres" });
  makeProc(procRoot, 4210003, { environ: `LA_CHILD_MARK=other/run/r:turn:0`, comm: "other" });
  makeProc(procRoot, 4210004, { environ: `LA_CHILD_MARK=${MARK}\0`, comm: "excluded" });
  const calls = [];
  const probes = new Map();
  const kill = (pid, sig) => {
    calls.push({ pid, sig });
    if (sig === 0) {
      const n = (probes.get(pid) ?? 0) + 1;
      probes.set(pid, n);
      // 4210001 dies (ESRCH) from its third liveness probe on; 4210002 ignores
      // SIGTERM and must be SIGKILLed after the grace.
      if (pid === 4210001 && n >= 3) {
        const err = new Error("no such process");
        err.code = "ESRCH";
        throw err;
      }
    }
  };
  const res = sweepChildProcesses({ mark: MARK, excludePids: [4210004], graceMs: 250, procRoot, kill });
  assert.deepEqual(res.skipped, null, "a fixture scan is not a skip");
  assert.deepEqual(
    res.killed.map((k) => k.pid).sort((a, b) => a - b),
    [4210001, 4210002],
    `the matched set was wrong: ${JSON.stringify(res.killed)}`,
  );
  assert.deepEqual(res.killed.find((k) => k.pid === 4210002)?.comm, "postgres", "the comm did not come along");
  const got = (pid, sig) => calls.some((c) => c.pid === pid && c.sig === sig);
  assert.ok(got(4210001, "SIGTERM"), "the first match got no SIGTERM");
  assert.ok(got(4210002, "SIGTERM"), "the second match got no SIGTERM");
  assert.ok(!calls.some((c) => c.pid === 4210003), "the non-matching pid was signalled");
  assert.ok(!calls.some((c) => c.pid === 4210004), "the excluded pid was signalled");
  assert.ok(got(4210002, "SIGKILL"), "the SIGTERM survivor got no SIGKILL after the grace");
  assert.ok(!got(4210001, "SIGKILL"), "a pid that died inside the grace was SIGKILLed anyway");
});

test("an empty /proc and a non-Linux host with the real /proc default both skip", () => {
  assert.deepEqual(sweepChildProcesses({ mark: "a/b/c", procRoot: join(base, "proc-not-there") }), {
    killed: [],
    skipped: "no /proc",
  });
  if (process.platform === "win32") {
    assert.deepEqual(sweepChildProcesses({ mark: "a/b/c" }), { killed: [], skipped: "no /proc" });
  }
});

test("sweepChildProcesses takes the root helper path when asked: TERM, grace, KILL for the survivors", () => {
  const helperCalls = [];
  const helper = (args) => {
    helperCalls.push(args);
    return args[1] === "TERM"
      ? { status: 0, stdout: "4242 postgres\n4243 sleep\n", stderr: "", error: null }
      : { status: 0, stdout: "4242 postgres\n", stderr: "", error: null };
  };
  const kill = (pid, sig) => {
    if (sig !== 0) return;
    if (pid === 4242) {
      const e = new Error("perm");
      e.code = "EPERM";
      throw e;
    }
    const e = new Error("gone");
    e.code = "ESRCH";
    throw e;
  };
  const res = sweepChildProcesses({
    mark: "run-x/dev-1/dev-1:turn:0",
    excludePids: [4210004],
    graceMs: 250,
    useHelper: true,
    helper,
    kill,
  });
  assert.deepEqual(res.via, "helper", "the helper path was not taken");
  assert.deepEqual(res.skipped, null, "a ran helper scan is not a skip");
  assert.deepEqual(
    res.killed.map((k) => k.pid).sort((a, b) => a - b),
    [4242, 4243],
    `the reported set was wrong: ${JSON.stringify(res.killed)}`,
  );
  assert.deepEqual(res.killed.find((k) => k.pid === 4242)?.comm, "postgres", "the comm did not come along");
  assert.deepEqual(helperCalls.length, 2, `expected TERM then KILL, got ${helperCalls.length} calls`);
  assert.deepEqual(helperCalls[0][0], "run-x/dev-1/dev-1:turn:0", "the mark was not passed to the helper");
  assert.deepEqual(helperCalls[0][1], "TERM", "the first sweep was not TERM");
  assert.deepEqual(helperCalls[1][1], "KILL", "the survivor got no KILL after the grace");
  assert.ok(helperCalls[0].includes(String(process.pid)), "the watcher pid was not excluded");
  assert.ok(helperCalls[0].includes("4210004"), "the given exclude pid was not passed to the helper");
});

test("a failing helper is a skip, never a throw", () => {
  const helper = () => ({ status: 1, stdout: "", stderr: "sudo: a password is required", error: null });
  const res = sweepChildProcesses({ mark: "run-x/dev-1/dev-1:turn:0", useHelper: true, helper });
  assert.deepEqual(res.via, "helper", "a failing helper still reports its path");
  assert.deepEqual(res.killed, [], "a failing helper reported kills");
  assert.ok(
    res.skipped.startsWith("helper failed"),
    `the skip did not name the helper: ${JSON.stringify(res.skipped)}`,
  );
});

// ── FOC-980: the fenix-child-share helper widens the child's transcripts ─────
console.log("\nFOC-980: the child's transcripts are group-shared before anyone reads them");

test("shareChildTranscripts passes the launch dir to the helper and reports the change count", () => {
  const calls = [];
  const helper = (args) => {
    calls.push(args);
    return { status: 0, stdout: "3\n", stderr: "", error: null };
  };
  const res = shareChildTranscripts("/data/state/supervisor/run-1/launch/dev-1", {
    useHelper: true,
    helper,
  });
  assert.deepEqual(res, { ok: true, changed: 3, skipped: null });
  assert.deepEqual(calls.length, 1, `expected one helper call, got ${calls.length}`);
  assert.deepEqual(
    calls[0],
    ["/data/state/supervisor/run-1/launch/dev-1"],
    "the launch dir was not the helper's only argument",
  );
});

// The production spawn is `sudo -n -u fenix-child /usr/local/sbin/fenix-child-share <dir>`
// — the sudoers entry (docker/sudoers-fenix-child) only matches that exact
// shape, so it is pinned here by value, not via the constants it would change
// with (a silent constant change would break every share until sudo starts
// refusing).
test("childShareHelperArgv pins the production sudo argv shape (FOC-980)", () => {
  assert.deepEqual(childShareHelperArgv(["/data/state/supervisor/run-1/launch/dev-1"]), [
    "-n",
    "-u",
    "fenix-child",
    "/usr/local/sbin/fenix-child-share",
    "/data/state/supervisor/run-1/launch/dev-1",
  ]);
});

test("shareChildTranscripts never throws on a failing helper — a structured skip instead", () => {
  const helper = () => ({ status: 2, stdout: "", stderr: "fenix-child-share: refused: not a supervisor launch dir", error: null });
  const res = shareChildTranscripts("/etc/passwd", { useHelper: true, helper });
  assert.deepEqual(res, { ok: false, changed: 0, skipped: "helper failed: exit 2 fenix-child-share: refused: not a supervisor launch dir" });
  // A helper that itself throws (sudo vanished mid-call) is folded the same way.
  const throwing = () => {
    throw new Error("spawn sudo ENOENT");
  };
  assert.deepEqual(shareChildTranscripts("/data/state/supervisor/r/launch/c", { useHelper: true, helper: throwing }), {
    ok: false,
    changed: 0,
    skipped: "helper failed: spawn sudo ENOENT",
  });
});

test("shareChildTranscripts outside the container is a no-op skip", () => {
  const helper = () => {
    throw new Error("the helper must never be called outside the container");
  };
  const res = shareChildTranscripts("/data/state/supervisor/r/launch/c", { useHelper: false, helper });
  assert.deepEqual(res, { ok: false, changed: 0, skipped: "not in container" });
});

test("shareChildTranscripts without a launch dir has nothing to share", () => {
  const helper = () => {
    throw new Error("the helper must not be called without a dir");
  };
  assert.deepEqual(shareChildTranscripts(null, { useHelper: true, helper }), {
    ok: false,
    changed: 0,
    skipped: "no launch dir",
  });
  assert.deepEqual(shareChildTranscripts("", { useHelper: true, helper }), {
    ok: false,
    changed: 0,
    skipped: "no launch dir",
  });
});

test("the /proc path drops a pid that vanished before its first signal", () => {
  const procRoot = join(base, "proc-esrch");
  const MARK = "run-x/dev-1/dev-1:turn:0";
  makeProc(procRoot, 4220001, { environ: `LA_CHILD_MARK=${MARK}\0`, comm: "a" });
  makeProc(procRoot, 4220002, { environ: `LA_CHILD_MARK=${MARK}\0`, comm: "b" });
  const kill = (pid, sig) => {
    if (pid === 4220001) {
      if (sig === "SIGTERM" || sig === 0) {
        const e = new Error("no such process");
        e.code = "ESRCH";
        throw e;
      }
      return;
    }
    if (sig === 0) {
      const e = new Error("no such process");
      e.code = "ESRCH";
      throw e; // 4220002 died after its SIGTERM — not a first-signal failure
    }
  };
  const res = sweepChildProcesses({ mark: MARK, graceMs: 100, procRoot, kill });
  assert.deepEqual(res.via, "proc", "the /proc path was not taken");
  assert.deepEqual(res.killed.map((k) => k.pid), [4220002], `the gone pid stayed in the report: ${JSON.stringify(res.killed)}`);
});

test("sweepChildProcesses takes the root helper path when asked: TERM, grace, KILL for the survivors", () => {
  const helperCalls = [];
  const helper = (args) => {
    helperCalls.push(args);
    return args[1] === "TERM"
      ? { status: 0, stdout: "4242 postgres\n4243 sleep\n", stderr: "", error: null }
      : { status: 0, stdout: "4242 postgres\n", stderr: "", error: null };
  };
  const kill = (pid, sig) => {
    if (sig !== 0) return;
    if (pid === 4242) {
      const e = new Error("perm");
      e.code = "EPERM";
      throw e;
    }
    const e = new Error("gone");
    e.code = "ESRCH";
    throw e;
  };
  const res = sweepChildProcesses({
    mark: "run-x/dev-1/dev-1:turn:0",
    excludePids: [4210004],
    graceMs: 250,
    useHelper: true,
    helper,
    kill,
  });
  assert.deepEqual(res.via, "helper", "the helper path did not serve the sweep");
  assert.deepEqual(res.skipped, null, "a ran helper scan is not a skip");
  assert.deepEqual(
    res.killed.map((k) => k.pid).sort((a, b) => a - b),
    [4242, 4243],
    `the reported set was wrong: ${JSON.stringify(res.killed)}`,
  );
  assert.deepEqual(res.killed.find((k) => k.pid === 4242)?.comm, "postgres", "the comm did not come along");
  assert.deepEqual(helperCalls.length, 2, `expected TERM + KILL helper calls, got ${JSON.stringify(helperCalls)}`);
  assert.deepEqual(helperCalls[0][0], "run-x/dev-1/dev-1:turn:0", "the mark was not passed to the helper");
  assert.deepEqual(helperCalls[0][1], "TERM", "the first helper call was not TERM");
  assert.deepEqual(helperCalls[1][1], "KILL", "the survivor follow-up was not KILL");
  assert.ok(helperCalls[0].includes(String(process.pid)), "the watcher's own pid was not excluded");
  assert.ok(helperCalls[0].includes("4210004"), "the caller's excludes were not forwarded");
});

test("a failing helper is a skip, never a throw", () => {
  const res = sweepChildProcesses({
    mark: "run-x/dev-1/dev-1:turn:0",
    useHelper: true,
    helper: () => ({ status: 1, stdout: "", stderr: "sudo: a password is required", error: null }),
    kill: () => {},
  });
  assert.deepEqual(res.via, "helper", "the failure should still report the helper path");
  assert.deepEqual(res.killed, [], "a failed helper must not report kills");
  assert.ok(res.skipped.startsWith("helper failed"), `skip reason was wrong: ${JSON.stringify(res.skipped)}`);
});

test("the /proc path drops a pid that vanished before its first signal", () => {
  const procRoot = join(base, "proc-esrch");
  const MARK = "run-x/dev-2/dev-2:turn:0";
  makeProc(procRoot, 4220001, { environ: `LA_CHILD_MARK=${MARK}\0`, comm: "a" });
  makeProc(procRoot, 4220002, { environ: `LA_CHILD_MARK=${MARK}\0`, comm: "b" });
  const kill = (pid, sig) => {
    if (pid === 4220001) {
      if (sig === "SIGTERM" || sig === 0) {
        const e = new Error("no such process");
        e.code = "ESRCH";
        throw e;
      }
      return;
    }
    if (sig === 0) {
      const e = new Error("no such process");
      e.code = "ESRCH";
      throw e;
    }
  };
  const res = sweepChildProcesses({ mark: MARK, graceMs: 250, procRoot, kill });
  assert.deepEqual(res.via, "proc", "the /proc path did not serve the sweep");
  assert.deepEqual(
    res.killed.map((k) => k.pid),
    [4220002],
    `the vanished pid should have left the report: ${JSON.stringify(res.killed)}`,
  );
});

// ── end-to-end: finalizeTurn sweeps and removes the child TMPDIR ─────────────
const runIdSweep = `test-watch-sweep-${process.pid}`;
fixtureChild(runIdSweep);
const sweepProcRoot = join(base, "proc-e2e");
const SWEEP_MARK = `${runIdSweep}/dev-1/dev-1:turn:0`;
// The stray is a REAL process: the watcher sweeps with the real process.kill,
// and a pid that does not exist is (correctly) reported as not killed. The
// fixture /proc tree only tells the scan whom to look at; the signal is real,
// and so is the "it is dead afterwards" check below. unref + ignored stdio so
// a surviving stray can never keep this test process alive; the exit hook is
// the belt and braces.
const sweepStray = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
sweepStray.unref();
process.on("exit", () => {
  try {
    process.kill(sweepStray.pid, "SIGKILL");
  } catch {}
});
makeProc(sweepProcRoot, sweepStray.pid, { environ: `LA_CHILD_MARK=${SWEEP_MARK}\0`, comm: "pgserver" });
makeProc(sweepProcRoot, 4220002, { environ: `LA_CHILD_MARK=unrelated/mark`, comm: "other" });
mkdirSync(join(tmpdir(), "fenix-child"), { recursive: true });
const childTmp = mkdtempSync(join(tmpdir(), "fenix-child", "watch-e2e-"));
writeFileSync(join(childTmp, "scratch.txt"), "x", "utf8");
const resultSweep = runWatcher(
  runIdSweep,
  [],
  {
    FAKE_ARGV_PATH: join(base, "argv-sweep.json"),
    FAKE_SESSION_ID: `watch-sweep-${process.pid}`,
    LA_CHILD_MARK: SWEEP_MARK,
    LA_PROC_ROOT: sweepProcRoot,
    TMPDIR: childTmp,
  },
);

test("finalizeTurn swept the marked stray and recorded sweptPids on the turn", async () => {
  assert.equal(resultSweep.status, 0, `watcher exit ${resultSweep.status}: ${resultSweep.stderr}`);
  const turn = readRegistry(runIdSweep).children["dev-1"].turns[0];
  assert.deepEqual(turn.sweptPids, [sweepStray.pid], `sweptPids was ${JSON.stringify(turn.sweptPids)}`);
  await reaped(sweepStray.pid);
  assert.ok(!strayAlive(sweepStray.pid), `the stray ${sweepStray.pid} survived the sweep`);
  assert.ok(
    readFileSync(teeOf(runIdSweep), "utf8").includes("child sweep: killed 1 stray process(es)"),
    "the tee does not carry the sweep line",
  );
});

test("the child TMPDIR is removed at turn end", () => {
  assert.ok(!existsSync(childTmp), "the child TMPDIR outlived the turn");
});

// LA_KEEP_CHILD_TMP=1 keeps the directory for debugging.
const runIdKeep = `test-watch-sweep-keep-${process.pid}`;
fixtureChild(runIdKeep);
const keepTmp = mkdtempSync(join(tmpdir(), "fenix-child", "watch-keep-"));
const resultKeep = runWatcher(
  runIdKeep,
  [],
  {
    FAKE_ARGV_PATH: join(base, "argv-sweep-keep.json"),
    FAKE_SESSION_ID: `watch-sweep-keep-${process.pid}`,
    LA_CHILD_MARK: `${runIdKeep}/dev-1/dev-1:turn:0`,
    LA_PROC_ROOT: sweepProcRoot,
    TMPDIR: keepTmp,
    LA_KEEP_CHILD_TMP: "1",
  },
);

test("LA_KEEP_CHILD_TMP=1 keeps the child TMPDIR", () => {
  assert.equal(resultKeep.status, 0, `watcher exit ${resultKeep.status}: ${resultKeep.stderr}`);
  assert.ok(existsSync(keepTmp), "LA_KEEP_CHILD_TMP=1 did not keep the tmp dir");
  try {
    rmSync(keepTmp, { recursive: true, force: true });
  } catch {}
});

// A watcher without the mark (not spawned by supervisor-spawn) must never
// remove the ambient TMPDIR.
const runIdNoMark = `test-watch-sweep-nomark-${process.pid}`;
fixtureChild(runIdNoMark);
const ambientTmp = join(base, "ambient-tmp");
mkdirSync(ambientTmp, { recursive: true });
const resultNoMark = runWatcher(
  runIdNoMark,
  [],
  {
    FAKE_ARGV_PATH: join(base, "argv-sweep-nomark.json"),
    FAKE_SESSION_ID: `watch-sweep-nomark-${process.pid}`,
    TMPDIR: ambientTmp,
  },
);

test("no LA_CHILD_MARK: no sweep, the ambient TMPDIR is untouched", () => {
  assert.equal(resultNoMark.status, 0, `watcher exit ${resultNoMark.status}: ${resultNoMark.stderr}`);
  assert.deepEqual(readRegistry(runIdNoMark).children["dev-1"].turns[0].sweptPids, []);
  assert.ok(existsSync(ambientTmp), "the ambient TMPDIR was removed by a markless watcher");
});

// POSIX only: a REAL detached stray (its own session, the setsid shape) whose
// env carries the mark is swept by the production /proc path.
if (process.platform !== "win32") {
  const runIdReal = `test-watch-sweep-real-${process.pid}`;
  fixtureChild(runIdReal);
  const REAL_MARK = `${runIdReal}/dev-1/dev-1:turn:0`;
  const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const stray = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
    env: scrubbedEnv({ LA_CHILD_MARK: REAL_MARK }),
  });
  stray.unref();
  sleepSync(300); // let the stray land in /proc before the watcher sweeps
  const resultReal = runWatcher(
    runIdReal,
    [],
    {
      FAKE_ARGV_PATH: join(base, "argv-sweep-real.json"),
      FAKE_SESSION_ID: `watch-sweep-real-${process.pid}`,
      LA_CHILD_MARK: REAL_MARK,
      FENIX_IN_CONTAINER: "",
    },
  );
  test("a real detached stray carrying the mark is swept through the real /proc", async () => {
    assert.equal(resultReal.status, 0, `watcher exit ${resultReal.status}: ${resultReal.stderr}`);
    const turn = readRegistry(runIdReal).children["dev-1"].turns[0];
    assert.ok(
      turn.sweptPids.includes(stray.pid),
      `sweptPids ${JSON.stringify(turn.sweptPids)} misses the stray ${stray.pid}`,
    );
    await reaped(stray.pid);
    const gone = !strayAlive(stray.pid);
    assert.ok(gone, "the stray process survived the sweep");
  });
} else {
  console.log("SKIP real detached-stray sweep — win32 has no setsid/process-group semantics for this fixture");
}

// The second guard: even WITH the mark, a TMPDIR that does not sit under
// <os tmpdir>/fenix-child/ must be left in place (and noted as skipped) — the
// path guard is what protects a hand-run watcher's ambient TMPDIR.
const runIdOutside = `test-watch-sweep-outside-${process.pid}`;
fixtureChild(runIdOutside);
const outsideTmp = mkdtempSync(join(base, "tmp-outside-"));
const resultOutside = runWatcher(
  runIdOutside,
  [],
  {
    FAKE_ARGV_PATH: join(base, "argv-sweep-outside.json"),
    FAKE_SESSION_ID: `watch-sweep-outside-${process.pid}`,
    LA_CHILD_MARK: `${runIdOutside}/dev-1/dev-1:turn:0`,
    LA_PROC_ROOT: sweepProcRoot,
    TMPDIR: outsideTmp,
  },
);

test("finalizeTurn leaves a TMPDIR outside <tmpdir>/fenix-child in place", () => {
  assert.equal(resultOutside.status, 0, `watcher exit ${resultOutside.status}: ${resultOutside.stderr}`);
  assert.ok(existsSync(outsideTmp), "a TMPDIR outside fenix-child was removed anyway");
  assert.ok(
    readFileSync(teeOf(runIdOutside), "utf8").includes("child_tmpdir_skipped"),
    "the tee carries no child_tmpdir_skipped note",
  );
});

// FOC-979 regression, POSIX only: the suite itself can run inside a Fenix DEV
// child, so a watcher a test spawns carries that OUTER child's mark in its env.
// At turn end the watcher must refuse a mark that does not belong to its own
// entry (the `<runId>/<childId>/` prefix) — pre-fix it swept /proc for the outer
// mark and killed the very child that ran the suite: its claude, its MCP
// servers, the test itself (the repro was this file exiting 143 inside a child).
// The sentinel is a REAL detached process carrying the outer mark on its real
// environ; after the fixture turn ends it must still be alive, and the tee must
// carry the foreign-mark note.
if (process.platform !== "win32") {
  const runIdForeign = `test-watch-sweep-foreign-${process.pid}`;
  fixtureChild(runIdForeign);
  const OUTER_MARK = "foc-979-outer/outer-dev/outer-attempt";
  const sleepSyncForeign = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  // The sentinel stands in for the outer child: a live process whose environ
  // the production /proc sweep would match on the foreign mark.
  const sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
    env: scrubbedEnv({ LA_CHILD_MARK: OUTER_MARK }),
  });
  sentinel.unref();
  process.on("exit", () => {
    try {
      process.kill(sentinel.pid, "SIGKILL");
    } catch {}
  });
  sleepSyncForeign(300); // let the sentinel land in /proc before the watcher runs
  const resultForeign = runWatcher(
    runIdForeign,
    [],
    {
      FAKE_ARGV_PATH: join(base, "argv-sweep-foreign.json"),
      FAKE_SESSION_ID: `watch-sweep-foreign-${process.pid}`,
      // The foreign mark, exactly as the outer child would leak it to a
      // test-spawned watcher through the inherited environ.
      LA_CHILD_MARK: OUTER_MARK,
    },
  );
  test("a foreign env mark is refused: no sweep, the outer child's process survives", async () => {
    assert.equal(resultForeign.status, 0, `watcher exit ${resultForeign.status}: ${resultForeign.stderr}`);
    assert.deepEqual(readRegistry(runIdForeign).children["dev-1"].turns[0].sweptPids, []);
    assert.ok(strayAlive(sentinel.pid), `the sentinel carrying ${OUTER_MARK} was killed by the sweep`);
    assert.ok(
      readFileSync(teeOf(runIdForeign), "utf8").includes("child_sweep_foreign_mark"),
      "the tee does not carry the foreign-mark note",
    );
  });
} else {
  console.log("SKIP foreign-env-mark sweep guard — win32 has no /proc environ for this fixture to sweep");
}

console.log("");
await Promise.all(pending);
if (failures.length) {
  console.log(`${passed} passed, ${failures.length} FAILED`);
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);
