// Contract test for the central telemetry store.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  applyEvent,
  makeEvent,
  openTelemetryDb,
  queryHealth,
  queryPatterns,
  queryRuns,
  querySummary,
  queryTrace,
} from "./telemetry-store.mjs";

let passed = 0;
let failed = 0;
const failures = [];
const temp = mkdtempSync(join(tmpdir(), "telemetry-store-test-"));
const dbPath = join(temp, "telemetry.sqlite");
const db = openTelemetryDb(dbPath);

function test(name, fn) {
  try { fn(); passed++; console.log(`  PASS ${name}`); }
  catch (error) { failed++; failures.push(`${name}: ${error.message}`); console.log(`  FAIL ${name}: ${error.message}`); }
}

function assert(value, message) {
  if (!value) throw new Error(message || "assertion failed");
}

function apply(type, payload, options = {}) {
  return applyEvent(db, makeEvent(type, payload, { runId: "run-1", observedAt: options.observedAt || "2026-07-24T08:00:00.000Z", sourceKind: options.sourceKind || "test", sourcePath: options.sourcePath, sourceOffset: options.sourceOffset }));
}

test("run and exact session link are persisted", () => {
  apply("run.started", { runId: "run-1", squad: "dev", startedAt: "2026-07-24T08:00:00.000Z", cwd: "C:/repos/office" });
  apply("session.linked", { runId: "run-1", sessionId: "session-1", transcriptPath: "C:/sessions/session-1.jsonl" });
  const run = queryRuns(db)[0];
  assert(run.sessionId === "session-1", `sessionId=${run.sessionId}`);
  assert(run.status === "running", `status=${run.status}`);
});

test("workspace timeline retains a worktree branch", () => {
  apply("workspace.observed", {
    runId: "run-1", cwd: "C:/repos/office/.claude/worktrees/foc-36", commonDir: "C:/repos/office/.git",
    gitDir: "C:/repos/office/.git/worktrees/foc-36", refType: "branch", refName: "foc-36-design-system", headSha: "abc123",
  }, { observedAt: "2026-07-24T08:05:00.000Z" });
  const run = queryRuns(db)[0];
  assert(run.gitBranch === "foc-36-design-system", `gitBranch=${run.gitBranch}`);
  assert(run.worktreePath.endsWith("foc-36"), `worktree=${run.worktreePath}`);
});

test("late manifest evidence cannot override runtime worktree", () => {
  apply("workspace.observed", {
    runId: "run-1", cwd: "C:/repos/office", commonDir: "C:/repos/office/.git",
    refType: "branch", refName: "main", headSha: "old123", source: "manifest",
  }, { observedAt: "2026-07-24T08:10:00.000Z" });
  const run = queryRuns(db)[0];
  assert(run.gitRef.name === "foc-36-design-system", `branch=${run.gitRef.name}`);
});

test("detached HEAD is represented without inventing a branch", () => {
  apply("workspace.observed", {
    runId: "run-1", cwd: "C:/repos/office/.claude/worktrees/detached", commonDir: "C:/repos/office/.git",
    refType: "detached", refName: null, headSha: "deadbeef", source: "transcript",
  }, { observedAt: "2026-07-24T08:11:00.000Z" });
  const run = queryRuns(db)[0];
  assert(run.gitRef.type === "detached", `type=${run.gitRef.type}`);
  assert(run.gitBranch === null, `branch=${run.gitBranch}`);
  assert(run.gitRef.headSha === "deadbeef", `sha=${run.gitRef.headSha}`);
});

test("task links are temporal and explicit", () => {
  apply("task.linked", { runId: "run-1", taskId: "FOC-36", source: "launch", confidence: 1 }, { observedAt: "2026-07-24T08:06:00.000Z" });
  const run = queryRuns(db)[0];
  assert(run.taskId === "FOC-36", `task=${run.taskId}`);
  assert(run.taskAttribution.confidence === 1, "explicit task confidence must be 1");
});

test("usage is source-offset idempotent", () => {
  const event = makeEvent("usage.recorded", {
    runId: "run-1", sessionId: "session-1", agentKey: "implementer", model: "deepseek-v4-flash",
    observedAt: "2026-07-24T08:07:00.000Z", inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheCreationTokens: 0,
  }, { runId: "run-1", observedAt: "2026-07-24T08:07:00.000Z", sourceKind: "transcript", sourcePath: "C:/sessions/session-1.jsonl", sourceOffset: 42, eventId: "usage-1" });
  applyEvent(db, event);
  applyEvent(db, event);
  const run = queryRuns(db)[0];
  assert(run.byAgent.implementer.turns === 1, `turns=${run.byAgent.implementer.turns}`);
  assert(run.totals.costUSD > 0, `cost=${run.totals.costUSD}`);
});

test("unknown price is an issue, not a zero cost", () => {
  applyEvent(db, makeEvent("usage.recorded", {
    runId: "run-1", sessionId: "session-1", agentKey: "_lead", model: "unknown-model-v99",
    observedAt: "2026-07-24T08:08:00.000Z", inputTokens: 50, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0,
  }, { runId: "run-1", observedAt: "2026-07-24T08:08:00.000Z", sourceKind: "transcript", sourcePath: "C:/sessions/session-1.jsonl", sourceOffset: 84, eventId: "usage-2" }));
  const run = queryRuns(db)[0];
  assert(run.totals.costUSD === null, `cost=${run.totals.costUSD}`);
  assert(run.dataQuality.some((issue) => issue.type === "pricing_missing"), "missing pricing issue absent");
});

test("usage follows the task link active at turn time", () => {
  const event = (type, payload, observedAt, sourceOffset = null) => applyEvent(db, makeEvent(type, payload, {
    runId: "run-temporal", observedAt, sourceKind: "temporal-test",
    sourcePath: sourceOffset == null ? null : "C:/sessions/temporal.jsonl", sourceOffset,
  }));
  event("run.started", { runId: "run-temporal", squad: "dev", startedAt: "2026-07-24T09:00:00.000Z" }, "2026-07-24T09:00:00.000Z");
  event("usage.recorded", { runId: "run-temporal", model: "deepseek-v4-flash", inputTokens: 10, outputTokens: 1, observedAt: "2026-07-24T09:01:00.000Z" }, "2026-07-24T09:01:00.000Z", 10);
  event("task.linked", { runId: "run-temporal", taskId: "FOC-1", source: "agent_pick" }, "2026-07-24T09:02:00.000Z");
  event("usage.recorded", { runId: "run-temporal", model: "deepseek-v4-flash", inputTokens: 20, outputTokens: 2, observedAt: "2026-07-24T09:03:00.000Z" }, "2026-07-24T09:03:00.000Z", 20);
  event("task.linked", { runId: "run-temporal", taskId: "FOC-2", source: "manual" }, "2026-07-24T09:04:00.000Z");
  event("usage.recorded", { runId: "run-temporal", model: "deepseek-v4-flash", inputTokens: 30, outputTokens: 3, observedAt: "2026-07-24T09:05:00.000Z" }, "2026-07-24T09:05:00.000Z", 30);
  const summary = querySummary(db);
  assert(summary.byTask.__untagged__.inputTokens === 10, "pre-pick usage must stay untagged");
  assert(summary.byTask["FOC-1"].inputTokens === 20, "middle usage must belong to FOC-1");
  assert(summary.byTask["FOC-2"].inputTokens === 30, "latest usage must belong to FOC-2");
});

test("central flow trace and patterns use temporal task usage", () => {
  const trace = queryTrace(db, "FOC-1");
  assert(trace.runs.length === 1, `trace runs=${trace.runs.length}`);
  assert(trace.runs[0].steps[0].turns === 1, "trace must include only the FOC-1 turn");
  const patterns = queryPatterns(db, { squad: "dev", agent: "_lead" });
  assert(patterns.stepStats.length === 1, `stepStats=${patterns.stepStats.length}`);
  assert(patterns.stepStats[0].executions >= 1, "patterns must include central usage");
});

test("summary uses central projections", () => {
  const summary = querySummary(db);
  assert(summary.totals.runs === 2, `runs=${summary.totals.runs}`);
  assert(summary.byTask["FOC-36"].runs === 1, "task summary missing run");
  assert(summary.byRepo.office.runs === 1, "repo summary missing repository");
});

test("health exposes store state", () => {
  const health = queryHealth(db);
  assert(health.schemaVersion === 2, `schema=${health.schemaVersion}`);
  assert(health.issues.some((issue) => issue.type === "pricing_missing"), "pricing issue not reported");
});

test("cacheSavingsUSD computed from cache_read_tokens and model prices", () => {
  const runId = "run-cache-savings";
  applyEvent(db, makeEvent("run.started", { runId, squad: "dev", startedAt: "2026-07-25T08:00:00.000Z" }, { runId, observedAt: "2026-07-25T08:00:00.000Z", sourceKind: "test" }));
  // deepseek-v4-flash: input=0.14, no cacheRead → cacheReadPrice=0.014
  // savings = (1M / 1M) * (0.14 - 0.014) = 0.126
  applyEvent(db, makeEvent("usage.recorded", {
    runId, model: "deepseek-v4-flash", inputTokens: 1_000_000, outputTokens: 100_000,
    cacheReadTokens: 1_000_000, cacheCreationTokens: 0, observedAt: "2026-07-25T08:01:00.000Z",
  }, { runId, observedAt: "2026-07-25T08:01:00.000Z", sourceKind: "transcript", sourcePath: "C:/sessions/cache.jsonl", sourceOffset: 1, eventId: "cache-usage-1" }));
  // Model without price → savings contribution 0
  applyEvent(db, makeEvent("usage.recorded", {
    runId, model: "unknown-model-v99", inputTokens: 500_000, outputTokens: 50_000,
    cacheReadTokens: 500_000, cacheCreationTokens: 0, observedAt: "2026-07-25T08:02:00.000Z",
  }, { runId, observedAt: "2026-07-25T08:02:00.000Z", sourceKind: "transcript", sourcePath: "C:/sessions/cache.jsonl", sourceOffset: 2, eventId: "cache-usage-2" }));
  const run = queryRuns(db, { runId })[0];
  assert(run.totals.cacheSavingsUSD > 0, `cacheSavingsUSD=${run.totals.cacheSavingsUSD} (expected > 0)`);
  assert(Math.abs(run.totals.cacheSavingsUSD - 0.126) < 0.001, `cacheSavingsUSD=${run.totals.cacheSavingsUSD} (expected ~0.126)`);
  // Per-model: deepseek-v4-flash has savings, unknown model does not
  const flashEntry = run.byModel["deepseek-v4-flash"];
  assert(flashEntry != null, "deepseek-v4-flash entry missing from byModel");
  assert(Math.abs(flashEntry.cacheSavingsUSD - 0.126) < 0.001, `byModel flash cacheSavingsUSD=${flashEntry.cacheSavingsUSD}`);
  const unknownEntry = run.byModel["unknown-model-v99"];
  assert(unknownEntry != null, "unknown-model-v99 entry missing from byModel");
  assert(unknownEntry.cacheSavingsUSD === 0, `byModel unknown cacheSavingsUSD=${unknownEntry.cacheSavingsUSD} (expected 0)`);
  // Summary must aggregate cacheSavingsUSD
  const summary = querySummary(db);
  assert(summary.totals.cacheSavingsUSD > 0, `summary cacheSavingsUSD=${summary.totals.cacheSavingsUSD} (expected > 0)`);
});

db.close();
assert(existsSync(dbPath), "database was not created");
rmSync(temp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) console.log(failures.join("\n"));
process.exit(failed ? 1 : 0);