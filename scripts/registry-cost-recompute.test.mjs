// scripts/registry-cost-recompute.test.mjs — the one-time recompute applies the
// same truth to old registries that the watcher now writes at turn end (FOC-760).
//
// What is locked down:
//
//   · a child with a transcript is REPRICED from it — SET, never added, and
//     `costUsdLegacy` keeps the inflated value the buggy accumulator recorded
//     (exactly once — a second --apply must not overwrite the original);
//   · a child without a transcript becomes `legacy-unverified`: value kept,
//     never silently trusted;
//   · an in-flight child is skipped — the watcher owns its cost right now;
//   · DRY RUN BY DEFAULT: without --apply not one byte changes;
//   · --run limits the sweep to one registry.
//
// Everything runs against temp dirs: LA_SUPERVISOR_STATE_HOME redirects the
// whole state tree, LA_SQUAD_HOME the squad config dirs the transcripts live
// under. The repo's real .state/ is never touched.
//
// Run: node scripts/registry-cost-recompute.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { cwdToHashName } from "./ledger.mjs";
import { ensureRunDir, readRegistry, runDir, writeRegistry } from "./supervisor-lib.mjs";
import { priceTranscripts } from "./transcript-cost.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RECOMPUTE = join(ROOT, "scripts", "registry-cost-recompute.mjs");

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

const base = mkdtempSync(join(tmpdir(), "la-recompute-"));
const stateHome = join(base, "state");
const squadHome = join(base, "agents");
const worktree = join(base, "wt");
// Pinned BEFORE any supervisor-lib call: the fixture runs must land in the
// temp tree, never in the repo's real .state/supervisor/.
process.env.LA_SUPERVISOR_STATE_HOME = stateHome;
process.env.LA_SQUAD_HOME = squadHome;
mkdirSync(stateHome, { recursive: true });
mkdirSync(join(squadHome, "dev"), { recursive: true });
mkdirSync(worktree, { recursive: true });
process.on("exit", () => {
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {}
});

// A priced model from the repo's own config (same path the script prices
// through via priceChildTranscripts' default pricing).
const MODEL = "z-ai/glm-5.2";
let sessionCounter = 0;

/**
 * Write a child transcript for `sessionId` under the squad config dir and
 * return the price the script must land on (derived through the same
 * priceTranscripts the script calls — pricing math is transcript-cost's tests'
 * job; here the wiring is).
 */
function fixtureTranscript(sessionId, cwd = worktree) {
  const dir = join(squadHome, "dev", "projects", cwdToHashName(cwd));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  const line = (id, inputTokens, outputTokens) =>
    JSON.stringify({
      type: "assistant",
      message: {
        id,
        model: MODEL,
        usage: { input_tokens: inputTokens, output_tokens: outputTokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    });
  writeFileSync(path, [line("msg-1", 100_000, 1_000), line("msg-2", 50_000, 2_000)].join("\n") + "\n");
  const priced = priceTranscripts([path]);
  assert.ok(priced && priced.costUsd !== null, "precondition: the fixture transcript must price");
  return { path, expected: priced.costUsd, messages: priced.messages };
}

const childEntry = (over = {}) => ({
  childId: "dev-1",
  squad: "dev",
  taskId: "FOC-999",
  sessionId: `recompute-${process.pid}-${sessionCounter++}`,
  status: "exited",
  turns: [{ pid: 1, endedAt: "2026-10-13T00:00:00.000Z" }],
  costUsd: 5.0, // the inflated accumulator figure the recompute replaces
  worktree,
  permissionMode: "bypassPermissions",
  ...over,
});

let runCounter = 0;
function fixtureRun(children) {
  const runId = `test-recompute-${process.pid}-${runCounter++}`;
  ensureRunDir(runId);
  writeRegistry(runId, { runId, children, rounds: {} });
  return runId;
}

const runCli = (extra = []) =>
  spawnSync(process.execPath, [RECOMPUTE, ...extra], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, LA_SUPERVISOR_STATE_HOME: stateHome, LA_SQUAD_HOME: squadHome },
  });
const runJson = (extra = []) => {
  const r = runCli(["--json", ...extra]);
  assert.equal(r.status, 0, `exit 0 expected, got ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout);
};
const registryBytes = (runId) => readFileSync(join(runDir(runId), "children.json"), "utf8");

// ── dry run ──────────────────────────────────────────────────────────────────
console.log("\ndry run nic nie zapisuje");

test("dry run reports the recompute and writes nothing", () => {
  const sessionId = `recompute-dry-${sessionCounter++}`;
  const { expected } = fixtureTranscript(sessionId);
  const runId = fixtureRun({ "dev-1": childEntry({ sessionId }) });
  const before = registryBytes(runId);
  const out = runJson();
  const run = out.runs.find((r) => r.runId === runId);
  assert.ok(run, "the run is enumerated");
  assert.equal(run.recomputed, 1);
  assert.equal(out.totals.recomputed, 1);
  assert.equal(out.dryRun, true);
  const c = run.children.find((x) => x.childId === "dev-1");
  assert.equal(c.verdict, "recomputed");
  assert.equal(c.costUsdNew, expected);
  assert.equal(registryBytes(runId), before, "dry run must not touch the registry");
});

// ── apply ────────────────────────────────────────────────────────────────────
console.log("\n--apply zapisuje");

test("--apply sets the transcript price and keeps the legacy figure", () => {
  const sessionId = `recompute-apply-${sessionCounter++}`;
  const { expected, messages } = fixtureTranscript(sessionId);
  const runId = fixtureRun({ "dev-1": childEntry({ sessionId }) });
  const out = runJson(["--apply"]);
  const run = out.runs.find((r) => r.runId === runId);
  assert.equal(run.recomputed, 1);
  const entry = readRegistry(runId).children["dev-1"];
  assert.equal(entry.costUsd, expected, "costUsd is SET from the transcript, not added");
  assert.equal(entry.costSource, "transcript");
  assert.equal(entry.costMessages, messages);
  assert.equal(entry.costUsdLegacy, 5.0, "the inflated pre-recompute value is preserved as evidence");
});

test("a second --apply keeps the ORIGINAL costUsdLegacy", () => {
  const sessionId = `recompute-idem-${sessionCounter++}`;
  fixtureTranscript(sessionId);
  const runId = fixtureRun({ "dev-1": childEntry({ sessionId }) });
  runJson(["--apply"]);
  // The transcript "moves" between runs (a pricing sync would do the same) —
  // the recompute updates costUsd but must not touch the legacy evidence.
  const dir = dirname(join(squadHome, "dev", "projects", cwdToHashName(worktree), `${sessionId}.jsonl`));
  writeFileSync(join(dir, `${sessionId}.jsonl`), "corrupted-but-repriced\n");
  runJson(["--apply"]);
  const entry = readRegistry(runId).children["dev-1"];
  assert.equal(entry.costUsdLegacy, 5.0, "a re-run never overwrites the original legacy figure");
});

// ── the children nothing can be done for ─────────────────────────────────────
console.log("\nlegacy-unverified i in-flight");

test("a child without a transcript becomes legacy-unverified, value kept", () => {
  const runId = fixtureRun({
    "dev-1": childEntry({ sessionId: "no-such-session-anywhere", costUsd: 2.5 }),
  });
  const out = runJson(["--apply"]);
  const run = out.runs.find((r) => r.runId === runId);
  assert.equal(run.unverifiable, 1);
  const entry = readRegistry(runId).children["dev-1"];
  assert.equal(entry.costUsd, 2.5, "the uncheckable value is kept, never zeroed");
  assert.equal(entry.costSource, "legacy-unverified");
  assert.equal(entry.costUsdLegacy, undefined, "nothing was repriced, so there is no legacy to keep");
});

test("a child already priced from its transcript is left alone", () => {
  const runId = fixtureRun({
    "dev-1": childEntry({ sessionId: "no-such-session-anywhere", costUsd: 1.5, costSource: "transcript" }),
  });
  const out = runJson(["--apply"]);
  const run = out.runs.find((r) => r.runId === runId);
  assert.equal(run.recomputed, 0);
  assert.equal(run.unverifiable, 0);
  const entry = readRegistry(runId).children["dev-1"];
  assert.equal(entry.costSource, "transcript", "verified at its own turn end — never downgraded");
  assert.equal(entry.costUsd, 1.5);
});

test("an in-flight child is skipped, registry untouched", () => {
  const sessionId = `recompute-live-${sessionCounter++}`;
  fixtureTranscript(sessionId);
  const runId = fixtureRun({
    "dev-1": childEntry({ sessionId, status: "running" }),
    "dev-2": childEntry({ childId: "dev-2", sessionId: `recompute-live2-${sessionCounter++}`, turns: [{ pid: 2 }] }),
  });
  const before = registryBytes(runId);
  const out = runJson(["--apply"]);
  const run = out.runs.find((r) => r.runId === runId);
  assert.equal(run.skipped, 2, "status running AND a turn without endedAt both count");
  const registry = readRegistry(runId);
  assert.equal(registry.children["dev-1"].costUsd, 5.0);
  assert.equal(registry.children["dev-1"].costSource, undefined);
  assert.equal(registry.children["dev-2"].costUsd, 5.0);
  assert.equal(registryBytes(runId), before, "nothing to write — no bytes change");
});

test("a corrupt children.json is an error row — the sweep continues, apply writes only computed runs", () => {
  const sessionId = `recompute-corrupt-${sessionCounter++}`;
  const { expected } = fixtureTranscript(sessionId);
  const good = fixtureRun({ "dev-1": childEntry({ sessionId }) });
  const corrupt = fixtureRun({
    "dev-1": childEntry({ sessionId: `recompute-corrupt2-${sessionCounter++}` }),
  });
  writeFileSync(join(runDir(corrupt), "children.json"), "{ not json", "utf8");

  const out = runJson(["--apply"]);
  const badRow = out.runs.find((r) => r.runId === corrupt);
  assert.ok(badRow && /unreadable/.test(badRow.error ?? ""), `error row expected, got ${JSON.stringify(badRow)}`);
  const goodRow = out.runs.find((r) => r.runId === good);
  assert.equal(goodRow.recomputed, 1, "the corrupt run must not stop the sweep");
  assert.equal(readRegistry(good).children["dev-1"].costUsd, expected, "the computed run was written");
  assert.equal(
    readFileSync(join(runDir(corrupt), "children.json"), "utf8"),
    "{ not json",
    "apply wrote nothing to the run that could not be computed",
  );
});

test("a child that started a turn between compute and apply is skipped (in-flight-at-apply)", () => {
  const sessionId = `recompute-race-${sessionCounter++}`;
  fixtureTranscript(sessionId);
  const runId = fixtureRun({ "dev-1": childEntry({ sessionId }) });
  const registryPath = join(runDir(runId), "children.json");

  // The race, replayed deterministically: a --require preload serves the
  // watcher's write (the child went live) on the CLI's SECOND read of this
  // registry — apply's re-read — while compute still saw it settled.
  const flipped = JSON.parse(readFileSync(registryPath, "utf8"));
  flipped.children["dev-1"].status = "running";
  const preload = join(base, "flip-second-read.cjs");
  writeFileSync(
    preload,
    [
      `const fs = require("node:fs");`,
      `const path = require("node:path");`,
      `const target = ${JSON.stringify(registryPath)};`,
      `const flipped = ${JSON.stringify(JSON.stringify(flipped))};`,
      `const orig = fs.readFileSync;`,
      `let seen = 0;`,
      `fs.readFileSync = function (p, ...rest) {`,
      `  const result = orig.call(fs, p, ...rest);`,
      `  if (p && path.resolve(String(p)) === path.resolve(target) && ++seen === 2) return flipped;`,
      `  return result;`,
      `};`,
      ``,
    ].join("\n"),
    "utf8",
  );
  const r = spawnSync(process.execPath, [RECOMPUTE, "--json", "--apply"], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      LA_SUPERVISOR_STATE_HOME: stateHome,
      LA_SQUAD_HOME: squadHome,
      NODE_OPTIONS: `--require ${preload}`,
    },
  });
  assert.equal(r.status, 0, `exit 0 expected, got ${r.status}: ${r.stderr}`);

  const out = JSON.parse(r.stdout);
  const run = out.runs.find((x) => x.runId === runId);
  const row = run.children.find((c) => c.childId === "dev-1");
  assert.equal(row.verdict, "skipped", `verdict=${row.verdict}`);
  assert.equal(row.reason, "in-flight-at-apply", `reason=${row.reason}`);
  assert.equal(run.recomputed, 0, "the recomputed verdict moved to skipped");
  assert.equal(run.skipped, 1);
  const entry = readRegistry(runId).children["dev-1"];
  assert.equal(entry.costUsd, 5.0, "the live child's cost was not patched under its watcher");
  assert.equal(entry.costSource, undefined, "no costSource was written either");
});

// ── filters and totals ───────────────────────────────────────────────────────
console.log("\nfiltry i sumy");

test("--run limits the sweep to one registry", () => {
  const sessionId = `recompute-filter-${sessionCounter++}`;
  const { expected } = fixtureTranscript(sessionId);
  const runA = fixtureRun({ "dev-1": childEntry({ sessionId }) });
  const runB = fixtureRun({ "dev-1": childEntry({ sessionId: "no-such-session-anywhere", costUsd: 9 }) });
  const out = runJson(["--apply", "--run", runA]);
  assert.deepEqual(out.runs.map((r) => r.runId), [runA]);
  assert.equal(readRegistry(runA).children["dev-1"].costUsd, expected);
  assert.equal(readRegistry(runB).children["dev-1"].costUsd, 9, "the other registry is untouched");
  assert.equal(readRegistry(runB).children["dev-1"].costSource, undefined);
});

test("totals and the old/new ratio reflect the whole sweep", () => {
  const sessionId = `recompute-total-${sessionCounter++}`;
  const { expected } = fixtureTranscript(sessionId);
  const runId = fixtureRun({
    "dev-1": childEntry({ sessionId, costUsd: 5.0 }),
    "dev-2": childEntry({ childId: "dev-2", sessionId: "no-such-session-anywhere", costUsd: 2.0 }),
  });
  const out = runJson();
  const run = out.runs.find((r) => r.runId === runId);
  assert.equal(run.oldTotalUsd, 7.0);
  assert.equal(run.newTotalUsd, expected + 2.0, "the unverified child keeps its value in both totals");
  assert.ok(out.totals.ratioOldOverNew > 1, "the sweep must report how much the registries were inflated");
});

test("a run with an unpriced child reports UNKNOWN totals, never 0", () => {
  const sessionId = `recompute-null-${sessionCounter++}`;
  const dir = join(squadHome, "dev", "projects", cwdToHashName(worktree));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${sessionId}.jsonl`),
    JSON.stringify({
      type: "assistant",
      message: { id: "msg-u", model: "acme/nobody-priced-this", usage: { input_tokens: 1000, output_tokens: 0 } },
    }) + "\n",
  );
  const runId = fixtureRun({ "dev-1": childEntry({ sessionId }) });
  const out = runJson();
  const run = out.runs.find((r) => r.runId === runId);
  assert.equal(run.newTotalUsd, null, "one unpriced child drags the total to null");
});

console.log("");
if (failures.length) {
  console.log(`${passed} passed, ${failures.length} FAILED`);
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);