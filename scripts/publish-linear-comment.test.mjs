// scripts/publish-linear-comment.test.mjs — a flag the publisher does not know is refused, not skipped.
//
// 2026-09-12, run a93f: the Supervisor rehearsed its FOC-287 close-out with
// `--dry-run`. parseArgs had no such flag and its catch-all skipped unknown
// flags silently, so the "rehearsal" posted the comment to Linear for real.
// The content happened to be right; the next one might not be. An outward
// write is the one place where "ignore what you don't understand" is the wrong
// default.
//
// The pure parser cases live in _test_publish-linear-comment.mjs; this file is
// the CLI boundary, where the post either happens or does not.
//
// Run: node scripts/publish-linear-comment.test.mjs

import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseArgs } from "./publish-linear-comment.mjs";
import { ROOT, harness } from "./supervisor-test-fixtures.mjs";

const { test, summary } = harness();

const CLI = join(ROOT, "scripts", "publish-linear-comment.mjs");

// FOC-848: the spawned linear-ops children now consult the task-ownership
// config. Pin it to a temp copy of the shipped (unrestricted) default so a
// developer's restricted .fenix/config/settings.json can never leak in.
const OWNERSHIP_PATH = join(
  mkdtempSync(join(tmpdir(), "publish-linear-own-")),
  "task-ownership.json",
);
copyFileSync(join(ROOT, "config", "task-ownership.json"), OWNERSHIP_PATH);

// Two independent reasons a real post cannot happen from these tests even if
// the refusal regressed: no usable key, and an issue that does not exist.
const run = (extra) =>
  spawnSync(
    process.execPath,
    [CLI, "--issue", "ZZZ-999999", "--tag", "test:publish-cli", "--squad", "dev", "--what", "probe", "--summary", "s", ...extra],
    { encoding: "utf8", env: { ...process.env, LINEAR_API_KEY: "invalid-test-key", LINEAR_API_KEY_PISI: "invalid-test-key", LA_TASK_OWNERSHIP_CONFIG: OWNERSHIP_PATH, LA_TASK_OWNER: "supervisor" } },
  );

console.log("\nunknown flags");

test("parseArgs collects unknown flags instead of dropping them", () => {
  const args = parseArgs(["node", "publish-linear-comment.mjs", "--issue", "FEN-1", "--dry-rn", "--colour"]);
  assert.deepEqual(args.unknown, ["--dry-rn", "--colour"]);
  assert.equal(args.issue, "FEN-1");
});

test("parseArgs recognises --clear-returned-by-review as a known boolean flag", () => {
  const args = parseArgs(["node", "publish-linear-comment.mjs", "--issue", "FEN-1", "--clear-returned-by-review"]);
  assert.equal(args.clearReturnedByReview, true);
  assert.deepEqual(args.unknown, []);
});

test("an unknown flag exits 2 and names the flag, before anything is posted", () => {
  const r = run(["--no-such-flag"]);
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /unknown flag.*--no-such-flag/i);
  assert.doesNotMatch(r.stdout, /comment posted/i);
});

console.log("\n--dry-run");

test("--dry-run prints the rendered body and exits 0 without posting", () => {
  const r = run(["--dry-run"]);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /dry-run/i);
  // The body a real run would post, marker first — so the rehearsal shows the
  // dedup tag exactly as Linear would receive it.
  assert.match(r.stdout, /<!-- run:test:publish-cli -->/);
  assert.doesNotMatch(r.stdout + r.stderr, /comment posted/i);
});

console.log("\n--clear-returned-by-review (pass-time label removal, FOC-165)");

test("pass flag + --dry-run prints the would-be label removal and exits 0", () => {
  const r = run(["--clear-returned-by-review", "--dry-run"]);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.match(
    r.stdout,
    /would remove label returned-by:review from ZZZ-999999/,
    `no planned removal in output\n${r.stdout}`,
  );
  // The exact command a reader would run by hand, verbatim.
  assert.match(r.stdout, /linear-ops\.mjs label ZZZ-999999 --remove returned-by:review/);
});

test("pass flag with the comment refused: label removal is skipped, visibly, exit non-zero", () => {
  const r = run(["--clear-returned-by-review"]);
  assert.notEqual(r.status, 0, `expected failure (invalid key + nonexistent issue)\n${r.stdout}\n${r.stderr}`);
  // The removal did not run — and the output says so instead of staying silent.
  assert.match(r.stdout + r.stderr, /NOT removed.*comment post failed/s);
  assert.doesNotMatch(r.stdout + r.stderr, /clearing returned-by:review/);
});

test("without the pass flag no label step runs at all", () => {
  const r = run([]);
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stdout + r.stderr, /returned-by:review/);
});

console.log("\npisi integration switch (FOC-772)");

// A pisi target is the env the linear-ops child inherits (LINEAR_WORKSPACE);
// the integrations switch is read through LA_SETTINGS_FILE.
const runWith = (extra, envPatch) =>
  spawnSync(
    process.execPath,
    [CLI, "--issue", "ZZZ-999999", "--tag", "test:publish-cli", "--squad", "dev", "--what", "probe", "--summary", "s", ...extra],
    { encoding: "utf8", env: { ...process.env, ...envPatch } },
  );

const settingsOverlay = (name, flag) => {
  const path = join(tmpdir(), `publish-settings-${name}-${process.pid}-${Date.now()}.json`);
  writeFileSync(path, JSON.stringify({ integrations: { pisi: flag } }));
  return path;
};

test("a pisi target with the integration off exits 1 with the hint, before any network call", () => {
  const off = settingsOverlay("off", false);
  try {
    const r = runWith([], { LINEAR_WORKSPACE: "pisi", LA_SETTINGS_FILE: off });
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}\n${r.stdout}\n${r.stderr}`);
    assert.match(
      r.stderr,
      /the pisi workspace is off — enable it with: node scripts\/fenix-settings\.mjs set integrations/,
      `no refusal hint in output\n${r.stdout}\n${r.stderr}`,
    );
    assert.doesNotMatch(r.stdout + r.stderr, /comment posted/i);
  } finally {
    rmSync(off, { force: true });
  }
});

test("a pisi target with the integration on does not hit the refusal (dry-run proceeds)", () => {
  const on = settingsOverlay("on", true);
  try {
    const r = runWith(["--dry-run"], { LINEAR_WORKSPACE: "pisi", LA_SETTINGS_FILE: on });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /dry-run/i);
    assert.doesNotMatch(r.stdout + r.stderr, /pisi workspace is off/);
  } finally {
    rmSync(on, { force: true });
  }
});

summary();
