// scripts/state-isolation.test.mjs — the FOC-602 guard: test fixtures never
// touch the live corpus.
//
// supervisor-test-fixtures.mjs points LA_SUPERVISOR_STATE_HOME at a per-process
// temp root at module load, so every fixture run dir — in-process or in a
// spawned child — lands outside the repo's real .state/supervisor/. This file
// pins that property from four sides:
//
//   1. importing the fixtures module leaves supervisorStateHome() outside
//      the repo's .state/;
//   2. a fixture run id carries the calling test file's name;
//   3. a child process that created a fixture run leaves NO temp root behind —
//      on the exit path everywhere, and on the SIGTERM path where the platform
//      actually delivers signals (win32's child.kill() is TerminateProcess, so
//      there the signal case is skipped, with the reason);
//   4. two fixtureRun()s leave the repo's real .state/supervisor/ exactly as
//      they found it.
//
// Run: node scripts/test-run.mjs state-isolation

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { ROOT, fixtureRun, fixtureStateHome } from "./supervisor-test-fixtures.mjs";
import { runDir, supervisorStateHome } from "./supervisor-lib.mjs";

const REPO_STATE_DIR = join(ROOT, ".state");
const REPO_SUPERVISOR_DIR = join(REPO_STATE_DIR, "supervisor");

/** True when `p` resolves to the repo's real .state/ tree (or inside it). */
const insideRepoState = (p) => {
  if (!p) return false;
  const rel = relative(REPO_STATE_DIR, resolve(p));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

// ── the child script used by test 3 ──────────────────────────────────────────
// Written into a parent-owned temp dir; imports the fixtures module by absolute
// path (passed through FIXTURES_MODULE so the string carries no machine paths).
// The child's env never receives LA_SUPERVISOR_STATE_HOME, so the fixtures
// module creates the child its OWN temp root — the thing that must be gone.

const childDir = mkdtempSync(join(tmpdir(), "la-state-isolation-"));
const childScript = join(childDir, "child.mjs");
writeFileSync(
  childScript,
  [
    'import { pathToFileURL } from "node:url";',
    'const fixtures = await import(pathToFileURL(process.env.FIXTURES_MODULE).href);',
    'const runId = fixtures.fixtureRun({});',
    'process.stdout.write(JSON.stringify({ stateHome: fixtures.fixtureStateHome(), runId }) + "\\n");',
    'if (process.env.FIXTURE_CHILD_WAIT === "1") setInterval(() => {}, 1 << 30);',
    "",
  ].join("\n"),
  "utf8",
);

// The child env: the parent's suite env MINUS the state-home seam, so the
// child's fixtures module creates its own root instead of reusing ours.
const childEnv = () => {
  const env = { ...process.env, FIXTURES_MODULE: join(ROOT, "scripts", "supervisor-test-fixtures.mjs") };
  delete env.LA_SUPERVISOR_STATE_HOME;
  return env;
};

const parseChildLine = (stdout) => {
  const line = stdout.split("\n").map((l) => l.trim()).find((l) => l.startsWith("{"));
  assert.ok(line, `child printed no state JSON; stdout was:\n${stdout}`);
  return JSON.parse(line);
};

// ── 1. the fixtures module never resolves to the real corpus ─────────────────

test("importing the fixtures module keeps supervisorStateHome() outside the repo's .state/", () => {
  const home = resolve(supervisorStateHome());
  assert.equal(fixtureStateHome(), home, "fixtureStateHome() and supervisorStateHome() agree");
  assert.equal(insideRepoState(home), false, `state home must not live under ${REPO_STATE_DIR}, got ${home}`);
  assert.ok(home.startsWith(resolve(tmpdir())), `state home must live under tmpdir, got ${home}`);
});

// ── 2. the run id names the test file that created it ────────────────────────

test("fixtureRun() id carries the calling test file name", () => {
  const runId = fixtureRun({});
  assert.match(runId, /^test-state-isolation-\d+-\d+-\d+$/, `unexpected id shape: ${runId}`);
  assert.ok(runId.includes(`-${process.pid}-`), `id must carry this pid: ${runId}`);
  // And the dir really is under the fixture home, not the repo.
  assert.ok(runDir(runId).startsWith(fixtureStateHome()), `run dir ${runDir(runId)} outside fixture home ${fixtureStateHome()}`);
  assert.ok(existsSync(runDir(runId)), "the run dir exists");
});

// ── 3. a child's temp root does not outlive the child ────────────────────────

test("a child that exits normally leaves no temp root behind", () => {
  const r = spawnSync(process.execPath, [childScript], { env: childEnv(), cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, `child exited ${r.status}: ${r.stderr}`);
  const { stateHome } = parseChildLine(r.stdout);
  assert.equal(existsSync(stateHome), false, `child's temp root survived a clean exit: ${stateHome}`);
});

test("a child killed with SIGTERM leaves no temp root behind", { skip: process.platform === "win32" && "win32 child.kill() is TerminateProcess: no signal handlers run, so the drain cannot fire — the exit-path test above covers the cleanup" }, async (t) => {
  const child = spawn(process.execPath, [childScript], {
    env: { ...childEnv(), FIXTURE_CHILD_WAIT: "1" },
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (c) => { stdout += c; });

  // Wait for the child to have created its run, bounded — a child that never
  // prints must fail the test, not hang it.
  const state = await new Promise((res, rej) => {
    const deadline = setTimeout(() => rej(new Error(`child never printed its state home; stdout:\n${stdout}`)), 15_000);
    const poll = setInterval(() => {
      const line = stdout.split("\n").map((l) => l.trim()).find((l) => l.startsWith("{"));
      if (line) {
        clearTimeout(deadline);
        clearInterval(poll);
        res(JSON.parse(line));
      }
    }, 50);
    child.once("exit", () => {
      clearTimeout(deadline);
      clearInterval(poll);
      rej(new Error(`child exited before printing its state home:\n${stdout}`));
    });
    t.after(() => { clearInterval(poll); clearTimeout(deadline); });
  });

  child.kill("SIGTERM");
  await new Promise((res) => child.once("exit", res));
  assert.equal(existsSync(state.stateHome), false, `child's temp root survived SIGTERM: ${state.stateHome}`);
});

// ── 4. the real corpus is untouched by fixture runs ──────────────────────────

test("fixtureRun()s leave the repo's real .state/supervisor/ exactly as they found it", () => {
  // Scoped to THIS file's id shape: a full-suite run has serial-lane files
  // (supervisor-gate and friends) creating their own legacy-format test-* dirs
  // in the real home concurrently — those are not this file's to count, and a
  // snapshot over them would flake against the parallel lane.
  const snapshot = () =>
    existsSync(REPO_SUPERVISOR_DIR)
      ? readdirSync(REPO_SUPERVISOR_DIR).filter((f) => f.startsWith("test-state-isolation-"))
      : [];
  const before = snapshot();
  fixtureRun({});
  fixtureRun({});
  assert.deepEqual(snapshot(), before, "fixture runs must not create dirs in the repo's real .state/supervisor/");
});

// The child-script temp dir is removed here directly — it is NOT registered
// with cleanupLater, because drain() removes the fixture home last and this
// dir is deliberately independent of it (the child creates its own root inside
// a clean env, not ours).
process.on("exit", () => {
  try { rmSync(childDir, { recursive: true, force: true }); } catch { /* best effort */ }
});