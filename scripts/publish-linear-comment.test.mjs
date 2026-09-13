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
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { parseArgs } from "./publish-linear-comment.mjs";
import { ROOT, harness } from "./supervisor-test-fixtures.mjs";

const { test, summary } = harness();

const CLI = join(ROOT, "scripts", "publish-linear-comment.mjs");

// Two independent reasons a real post cannot happen from these tests even if
// the refusal regressed: no usable key, and an issue that does not exist.
const run = (extra) =>
  spawnSync(
    process.execPath,
    [CLI, "--issue", "ZZZ-999999", "--tag", "test:publish-cli", "--squad", "dev", "--what", "probe", "--summary", "s", ...extra],
    { encoding: "utf8", env: { ...process.env, LINEAR_API_KEY: "invalid-test-key", LINEAR_API_KEY_PISI: "invalid-test-key" } },
  );

console.log("\nunknown flags");

test("parseArgs collects unknown flags instead of dropping them", () => {
  const args = parseArgs(["node", "publish-linear-comment.mjs", "--issue", "FEN-1", "--dry-rn", "--colour"]);
  assert.deepEqual(args.unknown, ["--dry-rn", "--colour"]);
  assert.equal(args.issue, "FEN-1");
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

summary();
