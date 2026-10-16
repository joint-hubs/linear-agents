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

import { ensureRunDir, installEnvFileSignalHandlers, readRegistry, runDir, writeRegistry } from "./supervisor-lib.mjs";

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
        ...process.env,
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

  test("SIGTERM removes the env file and kills the watcher", () => {
    watcher.kill("SIGTERM");
    const deadline = Date.now() + 10_000;
    while (watcher.exitCode === null && watcher.signalCode === null && Date.now() < deadline) sleepSync(50);
    assert.ok(
      watcher.exitCode !== null || watcher.signalCode !== null,
      "the watcher survived SIGTERM",
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

// ── unit: the signal handler removes the file, then re-raises exactly once ───
// Runs on every platform: the re-raise is injected, so nothing here kills the
// test process.
test("installEnvFileSignalHandlers removes the file and re-raises, once per signal", () => {
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
});

test("a remove failure never swallows the re-raise", () => {
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

console.log("");
if (failures.length) {
  console.log(`${passed} passed, ${failures.length} FAILED`);
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);
