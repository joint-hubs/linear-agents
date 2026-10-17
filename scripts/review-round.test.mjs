// scripts/review-round.test.mjs — the REVIEW round counter CLI at its boundary
// (FOC-903): `next` writes the per-run counter when LA_SUPERVISOR_RUN is set,
// `peek` reads the union of every run's counter with the legacy global file as
// the fallback (newest run wins per task), `reset` clears only the addressed
// store, and an invalid run id is a hard error, never a silent legacy fallback.
//
// Every child runs against temp LA_SUPERVISOR_STATE_HOME / LA_STATE_ROOT dirs;
// the real repo .state/ is never touched.
//
// Run: node scripts/review-round.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ROOT, harness, cleanupLater } from "./supervisor-test-fixtures.mjs";

const { test, summary } = harness();

const CLI = join(ROOT, "scripts", "review-round.mjs");

const RUN_OLD = "2026-09-01T10-00-00-000-supervisor-aaaa";
const RUN_NEW = "2026-09-02T10-00-00-000-supervisor-bbbb";

const tmp = mkdtempSync(join(tmpdir(), "review-round-test-"));
cleanupLater(tmp);
const STATE_HOME = join(tmp, "supervisor");
const STATE_ROOT = join(tmp, "state-root");
mkdirSync(STATE_HOME, { recursive: true });
mkdirSync(STATE_ROOT, { recursive: true });

// One temp seam pair for the whole suite; per-test env passes them explicitly.
const env = (extra = {}) => ({
  ...process.env,
  LA_SUPERVISOR_STATE_HOME: STATE_HOME,
  LA_STATE_ROOT: STATE_ROOT,
  ...extra,
});

const run = (args, extraEnv) =>
  spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: env(extraEnv), cwd: ROOT });

const out = (r) => JSON.parse(r.stdout.trim());

console.log("\nnext: per-run counter via LA_SUPERVISOR_RUN");

test("next increments the per-run counter file, legacy file never created", () => {
  const r = run(["next", "T-1"], { LA_SUPERVISOR_RUN: RUN_NEW });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(out(r), { round: 1, status: "review" });
  assert.deepEqual(JSON.parse(readFileSync(join(STATE_HOME, RUN_NEW, "review-rounds.json"), "utf8")), { "T-1": 1 });
  assert.equal(existsSync(join(STATE_ROOT, "review-rounds.json")), false, "legacy file not created");
});

test("an invalid LA_SUPERVISOR_RUN is a hard error, not a legacy fallback", () => {
  const r = run(["next", "T-1"], { LA_SUPERVISOR_RUN: "test-123-456-789" });
  assert.notEqual(r.status, 0, `expected failure, got stdout: ${r.stdout}`);
  assert.match(r.stderr, /invalid supervisor run id/);
});

console.log("\npeek: union of every run's counter, legacy fallback");

test("peek reads the newest run's value per task; a task only an older run knows still reads", () => {
  mkdirSync(join(STATE_HOME, RUN_OLD), { recursive: true });
  writeFileSync(join(STATE_HOME, RUN_OLD, "review-rounds.json"), JSON.stringify({ "T-1": 1, "T-2": 1 }));
  mkdirSync(join(STATE_HOME, RUN_NEW), { recursive: true });
  writeFileSync(join(STATE_HOME, RUN_NEW, "review-rounds.json"), JSON.stringify({ "T-1": 3 }));

  const newest = run(["peek", "T-1"]);
  assert.equal(newest.status, 0, newest.stderr);
  assert.deepEqual(out(newest), { round: 3, status: "escalated" }, "newest run wins");

  const olderOnly = run(["peek", "T-2"]);
  assert.deepEqual(out(olderOnly), { round: 1, status: "review" }, "older run's task survives");
});

test("peek falls back to the legacy global file when no run claims the task", () => {
  writeFileSync(join(STATE_ROOT, "review-rounds.json"), JSON.stringify({ "T-LEG": 1 }));
  const r = run(["peek", "T-LEG"]);
  assert.deepEqual(out(r), { round: 1, status: "review" }, "legacy fallback");
});

console.log("\nreset: only the addressed store");

test("reset with LA_SUPERVISOR_RUN clears only that run's counter", () => {
  const r = run(["reset"], { LA_SUPERVISOR_RUN: RUN_NEW });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(out(r), { reset: true });
  assert.deepEqual(JSON.parse(readFileSync(join(STATE_HOME, RUN_NEW, "review-rounds.json"), "utf8")), {}, "run cleared");
  assert.deepEqual(
    JSON.parse(readFileSync(join(STATE_HOME, RUN_OLD, "review-rounds.json"), "utf8")),
    { "T-1": 1, "T-2": 1 },
    "older run untouched",
  );
});

summary();
