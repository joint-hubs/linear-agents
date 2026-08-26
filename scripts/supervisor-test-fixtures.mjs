// scripts/supervisor-test-fixtures.mjs — shared fixtures for the supervisor test suites.
//
// Five test files were each carrying their own `fixtureRepo()` (and a sixth
// spelled it `sandboxRepo()`). They had already drifted: one forgot
// LA_CLAUDE_BIN and would have started the REAL claude, and one forgot --repo
// and left a worktree attached to this checkout. Both were caught by accident.
//
// NOT named `_test_*.mjs`: .gitignore excludes that whole pattern as scratch
// files, so the first version of this helper was silently untracked while the
// suite importing it was committed — a fresh clone would have failed on import.
// test-all.mjs only picks up `*.test.mjs`, so this name is skipped anyway.
//
// THE TWO NON-NEGOTIABLES, and why they live here rather than in each file:
//
//   · every spawn gets --repo <sandbox>. Without it the worktree lands in this
//     repo, next to the developer's real work.
//   · every spawn gets LA_CLAUDE_BIN=mock-claude. Without it the tests invoke a
//     real model — slowly, and for money.
//
// Both are easy to forget in one file out of six, and neither fails loudly.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureRunDir, readRegistry, runDir, writeRegistry } from "./supervisor-lib.mjs";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SPAWN = join(ROOT, "scripts", "supervisor-spawn.mjs");
export const WATCH = join(ROOT, "scripts", "supervisor-watch.mjs");
export const STOP = join(ROOT, "scripts", "supervisor-stop.mjs");
export const STATUS = join(ROOT, "scripts", "supervisor-status.mjs");
export const FOLLOWUP = join(ROOT, "scripts", "supervisor-followup.mjs");
export const GATE = join(ROOT, "scripts", "supervisor-gate.mjs");
export const TRIAGE = join(ROOT, "scripts", "supervisor-triage.mjs");
export const MOCK = join(ROOT, "scripts", "mock-claude.mjs");

// ── the PASS/FAIL harness every suite in this repo uses ──────────────────────

export function harness() {
  const state = { passed: 0, failures: [] };

  const test = (name, fn) => {
    try {
      fn();
      state.passed++;
      console.log(`  PASS ${name}`);
    } catch (err) {
      state.failures.push(name);
      console.log(`  FAIL ${name}\n       ${err.message}`);
    }
  };

  const fail = (msg) => {
    throw new Error(msg);
  };

  const summary = () => {
    console.log("");
    if (state.failures.length) {
      console.log(`${state.passed} passed, ${state.failures.length} FAILED`);
      process.exit(1);
    }
    console.log(`${state.passed} passed, 0 failed`);
  };

  return { test, fail, summary, state };
}

// ── cleanup ──────────────────────────────────────────────────────────────────
// Registered once. Temp dirs and worktrees can hold locks briefly on win32, so
// every removal is best-effort — a failed cleanup must not fail a green suite.

const cleanup = [];
export const cleanupLater = (path) => cleanup.push(path);

process.on("exit", () => {
  for (const path of cleanup) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

// ── a throwaway git repo ─────────────────────────────────────────────────────

/**
 * A real git repo in a temp dir: one commit on `main`, its own identity.
 *
 * Its own identity matters. `git config user.email` on a repo with none falls
 * through to the global config, and a test that sets it globally rewrites the
 * developer's git identity — which is exactly what happened here once, when a
 * stray `git init` ran in the project root.
 *
 * @returns {{ base: string, repo: string }} base is the parent (worktrees land
 *   in base/la-wt/), repo is the checkout itself.
 */
export function fixtureRepo() {
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

  cleanupLater(base);
  return { base, repo };
}

export const gitIn = (repo, ...args) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

// ── a run directory ──────────────────────────────────────────────────────────

let runCounter = 0;

/**
 * A run dir under .state/supervisor/, with a triage verdict already recorded
 * unless the test is specifically about spawn's fail-closed behaviour.
 */
export function fixtureRun({ triage = true, children = null } = {}) {
  const runId = `test-${process.pid}-${Date.now()}-${runCounter++}`;
  ensureRunDir(runId);
  if (triage) {
    writeFileSync(
      join(runDir(runId), "triage.json"),
      JSON.stringify({ issue: "FOC-123", verdict: "dev", node: "dev", confidence: 90 }),
    );
  }
  if (children) writeRegistry(runId, { runId, children, reviewLoopCount: {} });
  cleanupLater(runDir(runId));
  return runId;
}

/** A registry entry with the fields every supervisor script reads. */
export const fixtureChild = (over = {}) => ({
  childId: "dev-1",
  squad: "dev",
  taskId: "FOC-123",
  sessionId: "11111111-2222-3333-4444-555555555555",
  status: "exited",
  turns: [{ pid: 1 }],
  costUsd: 0,
  worktree: join(tmpdir(), "fixture-worktree"),
  permissionMode: "bypassPermissions",
  ...over,
});

// ── running the scripts ──────────────────────────────────────────────────────

/**
 * The env every supervisor test needs. LA_CLAUDE_BIN keeps a real model out of
 * the suite; LA_SUPERVISOR_NO_TELEMETRY keeps test runs out of the cost ledger.
 */
export const baseEnv = (extra = {}) => ({
  ...process.env,
  LA_CLAUDE_BIN: MOCK,
  LA_SUPERVISOR_NO_TELEMETRY: "1",
  MOCK_CLAUDE_HANG_MS: "0",
  ...extra,
});

export const runScript = (script, args, env = {}) =>
  spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: baseEnv(env),
  });

/**
 * Spawn a child. `repo` is REQUIRED — there is no default, deliberately: the
 * one time it was omitted, the worktree was created in this checkout.
 */
export const runSpawn = (runId, repo, extra = [], env = {}) =>
  runScript(
    SPAWN,
    ["--run", runId, "--squad", "dev", "--task", "FOC-123", "--prompt", "kickoff", "--repo", repo, ...extra],
    env,
  );

export function parse(result, fail) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    const message = `stdout was not JSON (exit ${result.status}):\n       ${result.stdout}\n       ${result.stderr}`;
    if (fail) return fail(message);
    throw new Error(message);
  }
}

/**
 * Wait for a child to reach one of `statuses`, reading the registry.
 *
 * Polls rather than sleeps: the watcher is a detached process and there is no
 * handle to await. Returns the entry, or throws naming what it saw instead —
 * a timeout that says "expected exited" and nothing else costs a debugging
 * session every time it fires.
 */
export function waitForStatus(runId, childId, statuses, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let entry;
  while (Date.now() < deadline) {
    entry = readRegistry(runId).children[childId];
    if (entry && statuses.includes(entry.status)) return entry;
    sleepSync(120);
  }
  throw new Error(
    `child ${childId} never reached ${statuses.join("|")} within ${timeoutMs} ms (last: ${entry?.status ?? "no entry"})`,
  );
}

// A blocking sleep in a synchronous test body. `Atomics.wait` on a throwaway
// buffer is the only one node offers without going async, and these suites are
// deliberately synchronous — the harness reports PASS/FAIL line by line.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
