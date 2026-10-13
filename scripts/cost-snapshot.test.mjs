// FOC-785 W2 — the cost snapshot: ticketCostReport's byDay/byModel windows,
// per-run rework splits through the cutoffs file, and the read-only child
// process contract. The store is always a temp dir — never the real
// telemetry home — and every open of the fixture is read-only except the
// initial build.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const SCRIPTS = dirname(fileURLToPath(import.meta.url));

// Route every store write into a temp dir BEFORE the module under test is
// imported — same pattern as ticket-cost.test.mjs. The seam is set here and
// left set (the static audit rejects unsetting it).
const temp = mkdtempSync(join(tmpdir(), "cost-snapshot-test-"));
const dbPath = join(temp, "telemetry.sqlite");
process.env.LA_TELEMETRY_HOME = temp;
process.env.LA_TELEMETRY_DB = dbPath;

const { openTelemetryDb, makeEvent, applyEvent, pricingSnapshot } = await import("./telemetry-store.mjs");
const { buildCostSnapshot } = await import("./cost-snapshot.mjs");

// Expected costs derive from the same pricing snapshot the store prices
// through, not from literals — same rule as ticket-cost.test.mjs.
const PRICE_INPUT = pricingSnapshot().prices["deepseek/deepseek-v4-flash"].input;
const costOf = (inputTokens) => (inputTokens * PRICE_INPUT) / 1_000_000;
const close = (a, b) => Math.abs(a - b) < 1e-9;

let usageSeq = 0;

function usage(db, runId, at, inputTokens, { model = "deepseek-v4-flash" } = {}) {
  usageSeq++;
  return applyEvent(db, makeEvent("usage.recorded", {
    runId, agentKey: "_lead", model,
    observedAt: at, inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
  }, {
    runId, observedAt: at, sourceKind: "transcript",
    sourcePath: `C:/sessions/${runId}.jsonl`, sourceOffset: usageSeq,
  }));
}

function startRun(db, runId, squad, at, taskId) {
  const result = applyEvent(db, makeEvent("run.started", { runId, squad, startedAt: at }, {
    runId, observedAt: at, sourceKind: "test",
  }));
  if (taskId) {
    applyEvent(db, makeEvent("task.linked", { runId, taskId, source: "launch", confidence: 1 }, {
      runId, observedAt: at, sourceKind: "test",
    }));
  }
  return result;
}

// ── the fixture: two child runs, priced usage, one unpriced row ──────────────
// run-1: 2026-09-01 (all only), 2026-10-05 (30d+all), 2026-10-12 (every window)
// run-2: 2026-10-11 priced + 2026-10-12 unpriced (model the price set lacks)
const NOW = "2026-10-13T12:00:00.000Z";
const CUTOFFS = {
  "run-1": "2026-10-01T00:00:00.000Z", // splits run-1: 09-01 before, 10-05+10-12 after
  "run-2": "2026-10-12T00:00:00.000Z", // after run-2's only priced row → reworkUsd 0
};
{
  const db = openTelemetryDb(dbPath);
  startRun(db, "run-1", "dev", "2026-09-01T09:00:00.000Z", "FOC-10");
  startRun(db, "run-2", "dev", "2026-10-11T09:00:00.000Z", "FOC-20");
  usage(db, "run-1", "2026-09-01T10:00:00.000Z", 100_000);
  usage(db, "run-1", "2026-10-05T10:00:00.000Z", 200_000);
  usage(db, "run-1", "2026-10-12T10:00:00.000Z", 50_000);
  usage(db, "run-2", "2026-10-11T10:00:00.000Z", 80_000);
  usage(db, "run-2", "2026-10-12T10:00:00.000Z", 70_000, { model: "no-such-model" });
  db.close();
}
const cutoffsPath = join(temp, "cutoffs.json");
writeFileSync(cutoffsPath, `${JSON.stringify(CUTOFFS)}\n`, "utf8");

const snapshot = buildCostSnapshot({ dbPath, cutoffs: CUTOFFS, now: NOW });

test("windows respect their since bounds; all/30d/7d are ticketCostReport outputs", () => {
  assert.equal(snapshot.computedAt, NOW);
  const windows = snapshot.windows;
  // all: everything, the two tickets split by their runs' task links.
  assert.ok(close(windows.all.tickets.find((t) => t.taskId === "FOC-10").childrenUsd, costOf(350_000)),
    `FOC-10 all=${windows.all.tickets.find((t) => t.taskId === "FOC-10").childrenUsd}`);
  assert.ok(close(windows.all.tickets.find((t) => t.taskId === "FOC-20").childrenUsd, costOf(80_000)),
    `FOC-20 all=${windows.all.tickets.find((t) => t.taskId === "FOC-20").childrenUsd}`);
  assert.equal(windows.all.unpricedMessages, 1, "the no-such-model row is unpriced, never $0");
  // 30d: since = 2026-09-13T12:00Z — the 2026-09-01 row drops out.
  assert.ok(close(windows["30d"].tickets.find((t) => t.taskId === "FOC-10").childrenUsd, costOf(250_000)),
    `FOC-10 30d=${JSON.stringify(windows["30d"].tickets)}`);
  assert.equal(windows["30d"].since, "2026-09-13T12:00:00.000Z");
  // 7d: since = 2026-10-06T12:00Z — only run-1's 10-12 row and run-2 remain.
  assert.ok(close(windows["7d"].tickets.find((t) => t.taskId === "FOC-10").childrenUsd, costOf(50_000)),
    `FOC-10 7d=${JSON.stringify(windows["7d"].tickets)}`);
  assert.equal(windows["7d"].since, "2026-10-06T12:00:00.000Z");
  // byDay/byModel ride along in every window (the additive FOC-785 fields).
  assert.deepEqual(windows.all.byDay.map((d) => d.day), ["2026-09-01", "2026-10-05", "2026-10-11", "2026-10-12"]);
  assert.ok(windows["7d"].byModel.length >= 1, "7d carries a byModel split");
});

test("runs: reworkUsd splits a run's rows at its cutoff; unpriced rows counted, never folded into usd", () => {
  // run-1's cutoff (10-01) keeps the 10-05 and 10-12 rows as rework, drops
  // the 09-01 one; run-2's priced row (10-11) is before its cutoff.
  const [run1, run2] = [snapshot.runs["run-1"], snapshot.runs["run-2"]];
  assert.ok(close(run1.usd, costOf(350_000)), `run-1 usd=${run1.usd}`);
  assert.ok(close(run1.reworkUsd, costOf(250_000)), `run-1 reworkUsd=${run1.reworkUsd}`);
  assert.deepEqual({ messages: run1.messages, unpricedMessages: run1.unpricedMessages }, { messages: 3, unpricedMessages: 0 });
  // The 10-12 row is at/after run-2's cutoff but unpriced — reworkUsd stays 0
  // and the row shows up as unpricedMessages instead of a fabricated $0.
  assert.ok(close(run2.usd, costOf(80_000)), `run-2 usd=${run2.usd}`);
  assert.equal(run2.reworkUsd, 0);
  assert.deepEqual({ messages: run2.messages, unpricedMessages: run2.unpricedMessages }, { messages: 2, unpricedMessages: 1 });
});

test("a store without run_focus still snapshots (all Supervisor spend unattributed)", () => {
  const strippedPath = join(temp, "stripped.sqlite");
  const stripped = openTelemetryDb(strippedPath);
  try {
    startRun(stripped, "sup-x", "supervisor", "2026-10-12T08:00:00.000Z");
    usage(stripped, "sup-x", "2026-10-12T08:05:00.000Z", 40_000);
    stripped.exec("DROP TABLE run_focus");
  } finally {
    stripped.close();
  }
  const bare = buildCostSnapshot({ dbPath: strippedPath, now: NOW });
  assert.ok(close(bare.windows.all.unattributedUsd, costOf(40_000)), `bare unattributed=${bare.windows.all.unattributedUsd}`);
  assert.deepEqual(bare.runs, {}, "no cutoffs file → runs is {}");
});

test("CLI --json returns the same numbers, read-only (db file untouched)", () => {
  const before = statSync(dbPath);
  const cli = spawnSync(process.execPath, [
    join(SCRIPTS, "cost-snapshot.mjs"), "--json", "--db", dbPath, "--cutoffs", cutoffsPath,
  ], { encoding: "utf8", env: { ...process.env, LA_TELEMETRY_DB: dbPath, LA_TELEMETRY_HOME: temp } });
  assert.equal(cli.status, 0, `exit ${cli.status}: ${cli.stderr}`);
  const fromCli = JSON.parse(cli.stdout);
  // The CLI uses wall-clock `now`; re-derive the library snapshot from the
  // CLI's own computedAt so the windows compare exactly.
  const expected = buildCostSnapshot({ dbPath, cutoffs: CUTOFFS, now: fromCli.computedAt });
  assert.deepEqual(fromCli, expected, "CLI JSON must equal the library snapshot");
  const after = statSync(dbPath);
  assert.equal(after.size, before.size, "read-only snapshot must not change the db file size");
  assert.equal(after.mtimeMs, before.mtimeMs, "read-only snapshot must not touch the db file mtime");

  // Without --cutoffs the runs section is empty, not an error.
  const bare = spawnSync(process.execPath, [
    join(SCRIPTS, "cost-snapshot.mjs"), "--json", "--db", dbPath,
  ], { encoding: "utf8", env: { ...process.env, LA_TELEMETRY_DB: dbPath, LA_TELEMETRY_HOME: temp } });
  assert.equal(bare.status, 0, `exit ${bare.status}: ${bare.stderr}`);
  assert.deepEqual(JSON.parse(bare.stdout).runs, {});
});

test("a missing store is exit 1 with a message on stderr", () => {
  const cli = spawnSync(process.execPath, [
    join(SCRIPTS, "cost-snapshot.mjs"), "--json", "--db", join(temp, "missing.sqlite"),
  ], { encoding: "utf8", env: { ...process.env, LA_TELEMETRY_DB: join(temp, "missing.sqlite"), LA_TELEMETRY_HOME: temp } });
  assert.equal(cli.status, 1, `exit ${cli.status}`);
  assert.match(cli.stderr, /cost-snapshot:/, `stderr: ${cli.stderr}`);
  assert.equal(cli.stdout, "", "no JSON on stdout for a failed run");
});

// The module-level temp dir is torn down only if every test above passed
// cleanly — leaving it behind on failure keeps the fixture inspectable.
process.on("exit", (code) => {
  if (code === 0) rmSync(temp, { recursive: true, force: true });
});
