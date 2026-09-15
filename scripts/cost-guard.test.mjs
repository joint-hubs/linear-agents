// scripts/cost-guard.test.mjs — the over-budget kill-switch at its two launch gates.
//
// FOC-165: cost-guard wrote .state/over-budget.json on breach, but only
// cost-report.mjs ever consulted it. The launchers now refuse while the marker
// exists — bin/_lib.bat via `node scripts/cost-guard.mjs check` (bats cannot
// import ESM) and scripts/launch.mjs via assertNoOverBudgetMarker before
// spawnLauncher. This file is the CLI boundary: exit codes and the reason a
// real operator sees, not the internals.
//
// The marker path is overridable through COST_GUARD_MARKER_PATH (temp dirs in
// tests). Unset, the marker stays at <root>/.state/over-budget.json and default
// behaviour is unchanged. It must be set BEFORE importing launch.mjs — the path
// is read once at module load.
//
// Run: node scripts/cost-guard.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ROOT, harness, cleanupLater } from "./supervisor-test-fixtures.mjs";

const { test, summary } = harness();

const CLI = join(ROOT, "scripts", "cost-guard.mjs");

// One temp marker for the whole suite — each test plants or clears it.
const TMP = mkdtempSync(join(tmpdir(), "cost-guard-test-"));
cleanupLater(TMP);
const MARKER = join(TMP, "over-budget.json");
process.env.COST_GUARD_MARKER_PATH = MARKER;

const run = (verb) =>
  spawnSync(process.execPath, [CLI, verb], { encoding: "utf8", env: { ...process.env } });

const plantMarker = () => {
  writeFileSync(
    MARKER,
    JSON.stringify(
      { task: "TEST-1", spent: 12.5, budget: 2, at: "2026-09-15T00:00:00.000Z" },
      null,
      2,
    ) + "\n",
  );
};

const removeMarker = () => rmSync(MARKER, { force: true });

console.log("\nCLI: check");

test("no marker — check exits 0 and stays quiet", () => {
  removeMarker();
  const r = run("check");
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.equal(r.stdout, "");
});

test("marker present — check exits 1, reason + clear instruction on stderr", () => {
  plantMarker();
  const r = run("check");
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /OVER-BUDGET/);
  assert.match(r.stderr, /TEST-1/);
  assert.match(r.stderr, /cost-guard\.mjs clear/);
});

test("no verb — usage error exits 2, distinct from a block", () => {
  const r = spawnSync(process.execPath, [CLI], { encoding: "utf8", env: { ...process.env } });
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /usage/i);
});

console.log("\nCLI: clear");

test("clear removes the marker, exits 0, and the gate reopens", () => {
  plantMarker();
  const r = run("clear");
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.equal(existsSync(MARKER), false, "marker still exists after clear");
  assert.equal(run("check").status, 0, "check still blocks after clear");
});

test("clear with no marker is a no-op, still exit 0", () => {
  removeMarker();
  const r = run("clear");
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}\n${r.stdout}\n${r.stderr}`);
});

console.log("\nlaunch.mjs gate");

// Imported AFTER COST_GUARD_MARKER_PATH is set — the marker path is a module
// constant read at load time.
const { spawnLauncher, assertNoOverBudgetMarker } = await import("./launch.mjs");

test("assertNoOverBudgetMarker throws with the clear instruction while the marker exists", () => {
  plantMarker();
  assert.throws(() => assertNoOverBudgetMarker(), /OVER-BUDGET.*cost-guard\.mjs clear/s);
});

test("spawnLauncher refuses before spawning anything when the marker exists", () => {
  plantMarker();
  // The guard is the first statement of spawnLauncher, so a throw carrying the
  // marker reason proves the refusal happened before any spawn call.
  assert.throws(() => spawnLauncher("C:\\nonexistent\\wrapper.bat", TMP, "t"), /OVER-BUDGET/);
});

test("marker cleared — the launch gate reopens", () => {
  removeMarker();
  assert.doesNotThrow(() => assertNoOverBudgetMarker());
});

summary();
