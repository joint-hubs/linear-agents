// scripts/supervisor-cleanup-prune.test.mjs — `prune`: retention for
// test-artifacts/ (FOC-649).
//
// The rule under test: retained = (newest 20 runs) ∩ (runs from the last 14
// days) — the intersection, never the union. Everything else in a run dir is
// evidence (children.json, wake-queue.jsonl, triage.json, merge.json, gates/)
// and must survive a prune that deletes the run's whole artifact payload.
//
// Isolation: every test builds its own throwaway state home and passes it via
// the LA_SUPERVISOR_STATE_HOME seam per invocation; run age is pinned with
// fs.utimesSync so the 14-day and newest-20 boundaries are exact, not
// clock-lottery. Nothing touches the repo's real .state/.
//
// Run: node scripts/supervisor-cleanup-prune.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ROOT, baseEnv, cleanupLater, harness, parse } from "./supervisor-test-fixtures.mjs";

const { test, fail, summary } = harness();

const CLEANUP = join(ROOT, "scripts", "supervisor-cleanup.mjs");
const DAY = 24 * 60 * 60 * 1000;
const pad = (i) => String(i).padStart(2, "0");

const prune = (args, env = {}) => {
  const e = baseEnv(env);
  if (!("LA_SUPERVISOR_CHILD" in env)) delete e.LA_SUPERVISOR_CHILD;
  return spawnSync(process.execPath, [CLEANUP, "prune", ...args], { cwd: ROOT, encoding: "utf8", env: e });
};

/**
 * A state home holding `n` runs; run i (0-based, run-00 the NEWEST) is
 * `ageOf(i)` ms old. Each run carries a 100-byte test-artifacts payload plus
 * the evidence files prune must never touch. utimesSync pins the run dir's
 * mtime AFTER all writes, so the age is exact.
 */
function stateHome(n, ageOf) {
  const home = mkdtempSync(join(tmpdir(), "la-sup-prune-"));
  cleanupLater(home);
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    const dir = join(home, `run-${pad(i)}`);
    const art = join(dir, "test-artifacts", "dev-1");
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "out.txt"), "x".repeat(100));
    writeFileSync(join(dir, "children.json"), "{}");
    writeFileSync(join(dir, "wake-queue.jsonl"), "");
    writeFileSync(join(dir, "triage.json"), "{}");
    writeFileSync(join(dir, "merge.json"), "{}");
    const ts = (now - ageOf(i)) / 1000;
    utimesSync(dir, ts, ts);
  }
  return home;
}

// ── identity ─────────────────────────────────────────────────────────────────
console.log("\ntożsamość");

test("prune sits behind the same identity guard as every other subcommand", () => {
  const out = parse(prune(["--dry-run"], { LA_SUPERVISOR_CHILD: "dev-1" }), fail);
  assert.equal(out.ok, false);
  assert.match(out.error, /LA_SUPERVISOR_CHILD/);
});

// ── the intersection ─────────────────────────────────────────────────────────
console.log("\nretencja — przecięcie, nie suma");

test("exactly 20 runs retained: the 25th-newest is pruned even though it is hours old", () => {
  const home = stateHome(25, (i) => i * 60_000); // every run inside the 14-day window
  const out = parse(prune([], { LA_SUPERVISOR_STATE_HOME: home }), fail);
  assert.equal(out.ok, true, out.error);
  assert.deepEqual(
    out.pruned.map((p) => p.run).sort(),
    ["run-20", "run-21", "run-22", "run-23", "run-24"],
    JSON.stringify(out.pruned),
  );
  assert.deepEqual(
    out.pruned.map((p) => p.rank).sort((a, b) => a - b),
    [21, 22, 23, 24, 25],
    "the pruned runs must be the five OUTSIDE the newest 20",
  );
  for (let i = 0; i < 20; i++) {
    assert.ok(existsSync(join(home, `run-${pad(i)}`, "test-artifacts", "dev-1", "out.txt")), `run-${pad(i)} lost its artifacts inside the window`);
  }
  for (let i = 20; i < 25; i++) {
    assert.ok(!existsSync(join(home, `run-${pad(i)}`, "test-artifacts")), `run-${pad(i)} kept artifacts outside the newest 20`);
  }
});

test("a run inside the newest 20 but older than 14 days is pruned anyway", () => {
  const home = stateHome(3, (i) => (i === 0 ? 15 * DAY : i * 60_000)); // run-00: newest AND stale
  const out = parse(prune([], { LA_SUPERVISOR_STATE_HOME: home }), fail);
  assert.ok(out.pruned.some((p) => p.run === "run-00"), JSON.stringify(out.pruned));
  assert.ok(!existsSync(join(home, "run-00", "test-artifacts")));
});

test("exactly 14 days old sits OUTSIDE the window: age < window retains, pinned from both sides", () => {
  const home = stateHome(2, (i) => (i === 0 ? 14 * DAY - 5 * 60_000 : 14 * DAY + 5 * 60_000));
  const out = parse(prune([], { LA_SUPERVISOR_STATE_HOME: home }), fail);
  assert.deepEqual(out.pruned.map((p) => p.run), ["run-01"], "5 minutes past the window must go");
  assert.ok(existsSync(join(home, "run-00", "test-artifacts", "dev-1", "out.txt")), "5 minutes inside the window must stay");
});

// ── dry run ──────────────────────────────────────────────────────────────────
console.log("\n--dry-run");

test("--dry-run lists exactly what a real run removes, and deletes nothing", () => {
  const home = stateHome(25, (i) => i * 60_000);
  const dry = parse(prune(["--dry-run"], { LA_SUPERVISOR_STATE_HOME: home }), fail);
  assert.equal(dry.dryRun, true);
  assert.equal(dry.pruned.length, 5, JSON.stringify(dry.pruned));
  for (let i = 20; i < 25; i++) {
    assert.ok(existsSync(join(home, `run-${pad(i)}`, "test-artifacts", "dev-1", "out.txt")), "dry run deleted bytes");
  }

  const real = parse(prune([], { LA_SUPERVISOR_STATE_HOME: home }), fail);
  assert.deepEqual(
    real.pruned.map((p) => p.run).sort(),
    dry.pruned.map((p) => p.run).sort(),
    "the dry-run list and the real deletion set disagree",
  );
});

// ── a real prune ─────────────────────────────────────────────────────────────
console.log("\nprawdziwe cięcie");

test("a real prune reports per-run byte totals and never touches the evidence files", () => {
  const home = stateHome(3, (i) => (30 - i) * DAY); // all ancient — age side prunes all three
  const out = parse(prune([], { LA_SUPERVISOR_STATE_HOME: home }), fail);
  assert.equal(out.dryRun, false);
  assert.equal(out.pruned.length, 3, JSON.stringify(out.pruned));
  assert.equal(out.bytes, 300, "3 runs x 100 bytes — the totals must add up");

  for (const run of readdirSync(home)) {
    // The evidence survives even though it is the oldest content in the tree.
    assert.ok(existsSync(join(home, run, "children.json")), `${run}/children.json was pruned`);
    assert.ok(existsSync(join(home, run, "wake-queue.jsonl")), `${run}/wake-queue.jsonl was pruned`);
    assert.ok(existsSync(join(home, run, "triage.json")), `${run}/triage.json was pruned`);
    assert.ok(existsSync(join(home, run, "merge.json")), `${run}/merge.json was pruned`);
    assert.ok(!existsSync(join(home, run, "test-artifacts")), `${run}/test-artifacts survived a real prune`);
  }
});

test("--run prunes only that run; a retained run is reported as retained", () => {
  const home = stateHome(25, (i) => i * 60_000);

  const kept = parse(prune(["--run", "run-03"], { LA_SUPERVISOR_STATE_HOME: home }), fail);
  assert.equal(kept.retained, true);
  assert.equal(kept.pruned.length, 0);
  assert.ok(existsSync(join(home, "run-03", "test-artifacts", "dev-1", "out.txt")));

  const gone = parse(prune(["--run", "run-24"], { LA_SUPERVISOR_STATE_HOME: home }), fail);
  assert.deepEqual(gone.pruned.map((p) => p.run), ["run-24"]);
  assert.ok(!existsSync(join(home, "run-24", "test-artifacts")));
  // Single-run narrowing must not leak: a sibling outside the newest 20 keeps
  // its artifacts, and run-24's evidence files stay.
  assert.ok(existsSync(join(home, "run-23", "test-artifacts", "dev-1", "out.txt")));
  assert.ok(existsSync(join(home, "run-24", "children.json")));
});

summary();
