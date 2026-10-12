// scripts/fenix-paths.test.mjs — FOC-770: the on-disk path contract in one place.
//
// Pins the per-OS defaults (byte-identical to what the scripts built for
// themselves before this module existed, so existing installs keep their
// store, rewards and worktrees), the env-override precedence chain, and the
// FOC-770 AC1 guard: no other scripts/*.mjs may hardcode LOCALAPPDATA,
// "AppData" or "la-wt" — those live only in fenix-paths.mjs now.
//
// Every expected path is built with join() — never string literals with
// separators — so the suite runs on Windows and Linux alike.
//
// Run: node scripts/fenix-paths.test.mjs

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  dataHome,
  telemetryHome,
  telemetryDbPath,
  liveTelemetryDbPath,
  rewardsHome,
  squadConfigRoot,
  squadConfigDir,
  projectsConfigPath,
  worktreeRoot,
  integrationTreePath,
  hostTokenPath,
  stateRoot,
  runsDir,
} from "./fenix-paths.mjs";

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  PASS " + name);
  } catch (err) {
    failures.push(name);
    console.log("  FAIL " + name + "\n       " + err.message);
  }
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");

console.log("\nfenix-paths: win32 defaults");

test("win32 with LOCALAPPDATA: every home lands under it", () => {
  const env = { LOCALAPPDATA: join("x", "local") };
  assert.equal(dataHome(env, "win32"), join("x", "local", "linear-agents"));
  assert.equal(telemetryHome(env, "win32"), join("x", "local", "linear-agents", "telemetry"));
  assert.equal(
    telemetryDbPath(env, "win32"),
    join("x", "local", "linear-agents", "telemetry", "telemetry.sqlite"),
  );
  assert.equal(
    liveTelemetryDbPath(env, "win32"),
    join("x", "local", "linear-agents", "telemetry", "telemetry.sqlite"),
  );
  assert.equal(rewardsHome(env, "win32"), join("x", "local", "linear-agents", "rewards"));
});

test("win32 without LOCALAPPDATA: falls back to ~/AppData/Local", () => {
  const env = {};
  assert.equal(
    dataHome(env, "win32"),
    join(homedir(), "AppData", "Local", "linear-agents"),
  );
});

console.log("\nfenix-paths: POSIX defaults");

test("POSIX with XDG_DATA_HOME: data home follows XDG", () => {
  const env = { XDG_DATA_HOME: join("x", "xdg") };
  assert.equal(dataHome(env, "linux"), join("x", "xdg", "linear-agents"));
});

test("POSIX without XDG_DATA_HOME: falls back to ~/.local/share", () => {
  const env = {};
  assert.equal(
    dataHome(env, "linux"),
    join(homedir(), ".local", "share", "linear-agents"),
  );
});

console.log("\nfenix-paths: env override precedence");

test("LA_DATA_HOME beats the platform default on both platforms", () => {
  assert.equal(dataHome({ LA_DATA_HOME: join("d", "1") }, "win32"), join("d", "1"));
  assert.equal(dataHome({ LA_DATA_HOME: join("d", "2") }, "linux"), join("d", "2"));
});

test("LA_TELEMETRY_HOME beats the data home; LA_TELEMETRY_DB beats the telemetry home", () => {
  const base = { LOCALAPPDATA: join("x", "local") };
  assert.equal(
    telemetryHome({ ...base, LA_TELEMETRY_HOME: join("t", "home") }, "win32"),
    join("t", "home"),
  );
  assert.equal(
    telemetryDbPath({ ...base, LA_TELEMETRY_HOME: join("t", "home") }, "win32"),
    join("t", "home", "telemetry.sqlite"),
  );
  assert.equal(
    telemetryDbPath({ ...base, LA_TELEMETRY_DB: join("t", "db.sqlite") }, "win32"),
    join("t", "db.sqlite"),
  );
});

test("LA_REWARDS_HOME beats the data home", () => {
  const env = { LOCALAPPDATA: join("x", "local"), LA_REWARDS_HOME: join("r", "home") };
  assert.equal(rewardsHome(env, "win32"), join("r", "home"));
});

console.log("\nfenix-paths: liveTelemetryDbPath ignores telemetry overrides");

test("live store ignores LA_TELEMETRY_HOME and LA_TELEMETRY_DB but honours LA_DATA_HOME", () => {
  const overridden = {
    LA_DATA_HOME: join("d", "home"),
    LA_TELEMETRY_HOME: join("t", "home"),
    LA_TELEMETRY_DB: join("t", "db.sqlite"),
  };
  assert.equal(
    liveTelemetryDbPath(overridden, "win32"),
    join("d", "home", "telemetry", "telemetry.sqlite"),
  );
  assert.equal(
    liveTelemetryDbPath(overridden, "linux"),
    join("d", "home", "telemetry", "telemetry.sqlite"),
  );
  // Without LA_DATA_HOME the live store still leads to the platform data home.
  assert.equal(
    liveTelemetryDbPath({ LA_TELEMETRY_DB: join("t", "db.sqlite") }, "linux"),
    join(homedir(), ".local", "share", "linear-agents", "telemetry", "telemetry.sqlite"),
  );
});

console.log("\nfenix-paths: host token (FOC-783)");

test("hostTokenPath: <dataHome>/run/host.token on both platforms, honouring LA_DATA_HOME", () => {
  assert.equal(
    hostTokenPath({ LOCALAPPDATA: join("x", "local") }, "win32"),
    join("x", "local", "linear-agents", "run", "host.token"),
  );
  assert.equal(
    hostTokenPath({ XDG_DATA_HOME: join("x", "xdg") }, "linux"),
    join("x", "xdg", "linear-agents", "run", "host.token"),
  );
  assert.equal(
    hostTokenPath({ LA_DATA_HOME: join("d", "1") }, "linux"),
    join("d", "1", "run", "host.token"),
  );
});

console.log("\nfenix-paths: squad config and worktrees");

test("squadConfigRoot: <repo>/agents by default, or LA_SQUAD_HOME", () => {
  assert.equal(squadConfigRoot({}), join(REPO_ROOT, "agents"));
  assert.equal(squadConfigRoot({ LA_SQUAD_HOME: join("s", "home") }), join("s", "home"));
});

test("squadConfigDir: agents/<squad> under the repo root, or LA_SQUAD_HOME", () => {
  assert.equal(squadConfigDir("dev", {}), join(REPO_ROOT, "agents", "dev"));
  assert.equal(squadConfigDir("dev", { LA_SQUAD_HOME: join("s", "home") }), join("s", "home", "dev"));
});

test("projectsConfigPath: LA_PROJECTS_FILE wins only when it exists; else the repo map", () => {
  const repoMap = join(REPO_ROOT, "config", "projects.json");
  // Set and present — the user-owned file wins.
  assert.equal(
    projectsConfigPath({ LA_PROJECTS_FILE: join("u", "projects.json") }, () => true),
    join("u", "projects.json"),
  );
  // Set but missing — fall back to the repo's map.
  assert.equal(
    projectsConfigPath({ LA_PROJECTS_FILE: join("u", "projects.json") }, () => false),
    repoMap,
  );
  // Unset — the repo's map.
  assert.equal(projectsConfigPath({}, () => true), repoMap);
});

test("worktreeRoot: ../la-wt/<repo> by default, or LA_WORKTREE_HOME/<repo>", () => {
  const repo = join("x", "repos", "office");
  assert.equal(worktreeRoot(repo, {}), join("x", "repos", "office", "..", "la-wt", "office"));
  assert.equal(worktreeRoot(repo, { LA_WORKTREE_HOME: join("w", "home") }), join("w", "home", "office"));
});

test("integrationTreePath: ../la-wt/<name> by default, or LA_WORKTREE_HOME/<name>", () => {
  const mainRepo = join("x", "repos", "linear-agents");
  assert.equal(
    integrationTreePath(mainRepo, "merge-integration", {}),
    join("x", "repos", "linear-agents", "..", "la-wt", "merge-integration"),
  );
  assert.equal(
    integrationTreePath(mainRepo, "merge-integration", { LA_WORKTREE_HOME: join("w", "home") }),
    join("w", "home", "merge-integration"),
  );
});

console.log("\nfenix-paths: run-state tree (FOC-811)");

test("stateRoot: LA_STATE_ROOT when set, <repo>/.state when not", () => {
  assert.equal(stateRoot({}), join(REPO_ROOT, ".state"));
  // Relative overrides resolve against the cwd — the seam the FOC-599
  // ledger/telemetry-server copies established. Pin it with an absolute path.
  const abs = mkdtempSync(join(tmpdir(), "foc-811-"));
  try {
    assert.equal(stateRoot({ LA_STATE_ROOT: abs }), abs);
  } finally {
    rmSync(abs, { recursive: true, force: true });
  }
});

test("runsDir: <stateRoot>/runs with and without the override", () => {
  assert.equal(runsDir({}), join(REPO_ROOT, ".state", "runs"));
  const abs = mkdtempSync(join(tmpdir(), "foc-811-"));
  try {
    assert.equal(runsDir({ LA_STATE_ROOT: abs }), join(abs, "runs"));
  } finally {
    rmSync(abs, { recursive: true, force: true });
  }
});

test("run-manifest start --headless writes to LA_STATE_ROOT, never the repo's .state/runs", () => {
  const tmp = mkdtempSync(join(tmpdir(), "foc-811-"));
  const runId = `foc811-${Date.now().toString(36)}`;
  try {
    const env = {
      ...process.env,
      LA_STATE_ROOT: tmp,
      // Keep the central telemetry store in the sandbox too.
      LA_DATA_HOME: tmp,
    };
    // An exported dev seam must not leak in on top of the overrides above —
    // only LA_STATE_ROOT/LA_DATA_HOME decide where the child writes.
    for (const key of ["LA_TELEMETRY_HOME", "LA_TELEMETRY_DB", "LA_SUPERVISOR_STATE_HOME", "LA_DECISION_RUNS_DIR"]) {
      delete env[key];
    }
    const result = spawnSync(
      process.execPath,
      [join(HERE, "run-manifest.mjs"), "start", runId, "dev", "--headless"],
      {
        cwd: tmp,
        env,
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, `run-manifest start failed: ${result.stderr}`);
    assert.ok(existsSync(join(tmp, "runs", `${runId}.json`)), "manifest written to the override root");
    assert.ok(
      !existsSync(join(REPO_ROOT, ".state", "runs", `${runId}.json`)),
      "nothing leaked into the repo's own .state/runs",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

console.log("\nfenix-paths: AC1 guard — no hardcoded paths outside this module");

test("no scripts/*.mjs hardcodes LOCALAPPDATA, AppData or la-wt", () => {
  const banned = [/process\.env\.LOCALAPPDATA/, /["']AppData["']/, /["']la-wt["']/];
  const hits = [];
  for (const name of readdirSync(HERE)) {
    if (!name.endsWith(".mjs") || name.endsWith(".test.mjs") || name === "fenix-paths.mjs") continue;
    const lines = readFileSync(join(HERE, name), "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
      for (const re of banned) {
        if (re.test(lines[i])) hits.push(`${name}:${i + 1} matches ${re}`);
      }
    }
  }
  assert.deepEqual(hits, []);
});

console.log(`\nfenix-paths: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("FAILURES:\n - " + failures.join("\n - "));
  process.exit(1);
}
