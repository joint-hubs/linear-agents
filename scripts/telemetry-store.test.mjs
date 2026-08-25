// Contract test for the central telemetry store.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  applyEvent,
  applyEvents,
  clearRunTask,
  getRunTaskLinks,
  makeEvent,
  migrate,
  openTelemetryDb,
  queryHealth,
  queryPatterns,
  queryRuns,
  querySummary,
  queryTrace,
  recordDelegationLink,
  recordTaskLink,
  recordToolFact,
  orphanRunVerdict,
  ORPHAN_RUN_IDLE_MS,
  SCHEMA_VERSION,
  MIGRATION_VERSIONS,
} from "./telemetry-store.mjs";

let passed = 0;
let failed = 0;
const failures = [];
const temp = mkdtempSync(join(tmpdir(), "telemetry-store-test-"));
const dbPath = join(temp, "telemetry.sqlite");
const db = openTelemetryDb(dbPath);

function test(name, fn) {
  try {
    const result = fn();
    if (result instanceof Promise) {
      result.then(() => { passed++; console.log(`  PASS ${name}`); })
        .catch((error) => { failed++; failures.push(`${name}: ${error.message}`); console.log(`  FAIL ${name}: ${error.message}`); });
    } else {
      passed++; console.log(`  PASS ${name}`);
    }
  } catch (error) {
    failed++; failures.push(`${name}: ${error.message}`); console.log(`  FAIL ${name}: ${error.message}`);
  }
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
  assert(health.schemaVersion === 5, `schema=${health.schemaVersion}`);
  assert(health.issues.some((issue) => issue.type === "pricing_missing"), "pricing issue not reported");
});

test("cacheSavingsUSD computed from cache_read_tokens and model prices", () => {
  const runId = "run-cache-savings";
  applyEvent(db, makeEvent("run.started", { runId, squad: "dev", startedAt: "2026-07-25T08:00:00.000Z" }, { runId, observedAt: "2026-07-25T08:00:00.000Z", sourceKind: "test" }));
  // deepseek-v4-flash: input=0.088606, cacheRead=0.0177212 (real, from OpenRouter — JOI-79)
  // savings = (1M / 1M) * (0.088606 - 0.0177212) = 0.0708848
  //
  // This used to expect 0.126, which is what the input*0.1 FALLBACK produces when
  // config carries no cacheRead. That fallback is wrong in both directions — 12x too
  // high for DeepSeek V4 Pro, 2x too low for MiniMax — so config now carries real
  // per-model rates and this asserts the configured value wins. The fallback itself
  // is covered by the unpriced case below.
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
  assert(Math.abs(run.totals.cacheSavingsUSD - 0.0708848) < 0.001, `cacheSavingsUSD=${run.totals.cacheSavingsUSD} (expected ~0.0708848 from the configured cacheRead=0.0177212)`);
  // Per-model: deepseek-v4-flash has savings, unknown model does not
  const flashEntry = run.byModel["deepseek-v4-flash"];
  assert(flashEntry != null, "deepseek-v4-flash entry missing from byModel");
  assert(Math.abs(flashEntry.cacheSavingsUSD - 0.0708848) < 0.001, `byModel flash cacheSavingsUSD=${flashEntry.cacheSavingsUSD}`);
  const unknownEntry = run.byModel["unknown-model-v99"];
  assert(unknownEntry != null, "unknown-model-v99 entry missing from byModel");
  assert(unknownEntry.cacheSavingsUSD === 0, `byModel unknown cacheSavingsUSD=${unknownEntry.cacheSavingsUSD} (expected 0)`);
  // Summary must aggregate cacheSavingsUSD
  const summary = querySummary(db);
  assert(summary.totals.cacheSavingsUSD > 0, `summary cacheSavingsUSD=${summary.totals.cacheSavingsUSD} (expected > 0)`);
});

test("getRunTaskLinks returns current=null when no links exist", () => {
  const links = getRunTaskLinks(db, "run-no-links");
  assert(links.current === null, `current=${JSON.stringify(links.current)}`);
  assert(links.history.length === 0, `history.length=${links.history.length}`);
});

test("link with validFrom=startedAt moves ALL run cost to the task (retroactive)", () => {
  const runId = "run-retroactive";
  const startedAt = "2026-07-26T08:00:00.000Z";
  const ev = (type, payload, observedAt, sourceOffset = null) => applyEvent(db, makeEvent(type, payload, {
    runId, observedAt, sourceKind: "test", sourcePath: sourceOffset == null ? null : "C:/retro.jsonl", sourceOffset,
  }));
  ev("run.started", { runId, squad: "dev", startedAt }, startedAt);
  ev("usage.recorded", { runId, model: "deepseek-v4-flash", inputTokens: 100_000, outputTokens: 10_000, cacheReadTokens: 0, cacheCreationTokens: 0, observedAt: "2026-07-26T08:01:00.000Z" }, "2026-07-26T08:01:00.000Z", 1);
  ev("usage.recorded", { runId, model: "deepseek-v4-flash", inputTokens: 200_000, outputTokens: 20_000, cacheReadTokens: 0, cacheCreationTokens: 0, observedAt: "2026-07-26T08:02:00.000Z" }, "2026-07-26T08:02:00.000Z", 2);
  // Link with validFrom = startedAt (retroactive)
  ev("task.linked", { runId, taskId: "RETRO-1", source: "manual", confidence: 1, validFrom: startedAt }, "2026-07-26T08:03:00.000Z");
  const summary = querySummary(db);
  const bucket = summary.byTask["RETRO-1"];
  assert(bucket != null, "RETRO-1 must exist in byTask");
  assert(bucket.inputTokens === 300_000, `RETRO-1 inputTokens=${bucket.inputTokens} (expected 300000 — both pre and post link usage)`);
});

test("link with validFrom=now does NOT move historical usage", () => {
  const runId = "run-now-scope";
  const startedAt = "2026-07-26T09:00:00.000Z";
  const ev = (type, payload, observedAt, sourceOffset = null) => applyEvent(db, makeEvent(type, payload, {
    runId, observedAt, sourceKind: "test", sourcePath: sourceOffset == null ? null : "C:/now.jsonl", sourceOffset,
  }));
  ev("run.started", { runId, squad: "dev", startedAt }, startedAt);
  ev("usage.recorded", { runId, model: "deepseek-v4-flash", inputTokens: 100_000, outputTokens: 10_000, cacheReadTokens: 0, cacheCreationTokens: 0, observedAt: "2026-07-26T09:01:00.000Z" }, "2026-07-26T09:01:00.000Z", 1);
  // Link with validFrom = now (AFTER the usage timestamp)
  ev("task.linked", { runId, taskId: "NOW-1", source: "manual", confidence: 1, validFrom: "2026-07-26T09:02:00.000Z" }, "2026-07-26T09:02:00.000Z");
  ev("usage.recorded", { runId, model: "deepseek-v4-flash", inputTokens: 200_000, outputTokens: 20_000, cacheReadTokens: 0, cacheCreationTokens: 0, observedAt: "2026-07-26T09:03:00.000Z" }, "2026-07-26T09:03:00.000Z", 2);
  const summary = querySummary(db);
  // Pre-link usage should be untagged
  assert(summary.byTask.__untagged__.inputTokens >= 100_000, `untagged inputTokens=${summary.byTask.__untagged__?.inputTokens} (expected >=100000)`);
  // Post-link usage should be on NOW-1
  const bucket = summary.byTask["NOW-1"];
  assert(bucket != null, "NOW-1 must exist in byTask");
  assert(bucket.inputTokens === 200_000, `NOW-1 inputTokens=${bucket.inputTokens} (expected 200000 — only post-link usage)`);
});

test("changing task: old link gets valid_to, new link is active, history has 2 entries", () => {
  const runId = "run-reassign";
  const ev = (type, payload, observedAt) => applyEvent(db, makeEvent(type, payload, {
    runId, observedAt, sourceKind: "test",
  }));
  ev("run.started", { runId, squad: "dev", startedAt: "2026-07-26T10:00:00.000Z" }, "2026-07-26T10:00:00.000Z");
  ev("task.linked", { runId, taskId: "FIRST-1", source: "manual", confidence: 1 }, "2026-07-26T10:01:00.000Z");
  ev("task.linked", { runId, taskId: "SECOND-2", source: "manual", confidence: 1 }, "2026-07-26T10:02:00.000Z");
  const links = getRunTaskLinks(db, runId);
  assert(links.current != null, "must have a current link");
  assert(links.current.taskId === "SECOND-2", `current.taskId=${links.current.taskId}`);
  assert(links.history.length === 2, `history.length=${links.history.length}`);
  assert(links.history[0].taskId === "SECOND-2", `history[0].taskId=${links.history[0].taskId}`);
  assert(links.history[0].validTo === null, `history[0].validTo=${links.history[0].validTo}`);
  assert(links.history[1].taskId === "FIRST-1", `history[1].taskId=${links.history[1].taskId}`);
  assert(links.history[1].validTo != null, "old link must have validTo set");
});

test("clearRunTask: current becomes null, history preserved, validTo collapsed to validFrom", () => {
  const runId = "run-clear";
  const ev = (type, payload, observedAt) => applyEvent(db, makeEvent(type, payload, {
    runId, observedAt, sourceKind: "test",
  }));
  ev("run.started", { runId, squad: "dev", startedAt: "2026-07-26T11:00:00.000Z" }, "2026-07-26T11:00:00.000Z");
  ev("task.linked", { runId, taskId: "CLEAR-1", source: "manual", confidence: 1 }, "2026-07-26T11:01:00.000Z");
  const before = getRunTaskLinks(db, runId);
  assert(before.current != null, "must have current before clear");
  assert(before.history.length === 1, "one link before clear");

  const result = clearRunTask(runId, { dbPath });
  assert(result.closed === true, "clearRunTask must report closed=true");
  assert(result.runId === runId, `runId=${result.runId}`);

  const after = getRunTaskLinks(db, runId);
  assert(after.current === null, "current must be null after clear");
  assert(after.history.length === 1, "history still has 1 entry (preserved, not deleted)");
  assert(after.history[0].taskId === "CLEAR-1", "history entry preserved");
  assert(after.history[0].validTo === after.history[0].validFrom, `validTo=${after.history[0].validTo} must equal validFrom=${after.history[0].validFrom} (zero-duration collapse)`);
});

test("clearRunTask returns cost to untagged (the core bug fix)", () => {
  const runId = "run-clear-cost";
  const startedAt = "2026-07-27T08:00:00.000Z";
  const ev = (type, payload, observedAt, sourceOffset = null) => applyEvent(db, makeEvent(type, payload, {
    runId, observedAt, sourceKind: "test", sourcePath: sourceOffset == null ? null : "C:/clear.jsonl", sourceOffset,
  }));
  ev("run.started", { runId, squad: "dev", startedAt }, startedAt);
  ev("usage.recorded", { runId, model: "deepseek-v4-flash", inputTokens: 100_000, outputTokens: 10_000, cacheReadTokens: 0, cacheCreationTokens: 0, observedAt: "2026-07-27T08:01:00.000Z" }, "2026-07-27T08:01:00.000Z", 1);
  ev("task.linked", { runId, taskId: "CLEARME-1", source: "manual", confidence: 1, validFrom: startedAt }, "2026-07-27T08:02:00.000Z");
  ev("usage.recorded", { runId, model: "deepseek-v4-flash", inputTokens: 50_000, outputTokens: 5_000, cacheReadTokens: 0, cacheCreationTokens: 0, observedAt: "2026-07-27T08:03:00.000Z" }, "2026-07-27T08:03:00.000Z", 2);

  // Before clear: all usage on CLEARME-1
  let summary = querySummary(db);
  assert(summary.byTask["CLEARME-1"] != null, "CLEARME-1 must exist before clear");
  assert(summary.byTask["CLEARME-1"].inputTokens === 150_000, `CLEARME-1 tokens=${summary.byTask["CLEARME-1"].inputTokens} (expected 150000)`);

  clearRunTask(runId, { dbPath });

  // After clear: CLEARME-1 gone, usage in __untagged__
  summary = querySummary(db);
  assert(summary.byTask["CLEARME-1"] == null, "CLEARME-1 must be ABSENT after clear (cost returned to untagged)");
  const untagged = summary.byTask.__untagged__;
  assert(untagged.inputTokens >= 150_000, `untagged tokens=${untagged.inputTokens} (expected >=150000, got cost back)`);
});

test("clearRunTask with options.at preserves old 'close from now' behavior", () => {
  const runId = "run-clear-at";
  const startedAt = "2026-07-27T09:00:00.000Z";
  const ev = (type, payload, observedAt, sourceOffset = null) => applyEvent(db, makeEvent(type, payload, {
    runId, observedAt, sourceKind: "test", sourcePath: sourceOffset == null ? null : "C:/clearat.jsonl", sourceOffset,
  }));
  ev("run.started", { runId, squad: "dev", startedAt }, startedAt);
  ev("usage.recorded", { runId, model: "deepseek-v4-flash", inputTokens: 100_000, outputTokens: 10_000, cacheReadTokens: 0, cacheCreationTokens: 0, observedAt: "2026-07-27T09:01:00.000Z" }, "2026-07-27T09:01:00.000Z", 1);
  ev("task.linked", { runId, taskId: "AT-1", source: "manual", confidence: 1, validFrom: startedAt }, "2026-07-27T09:02:00.000Z");
  ev("usage.recorded", { runId, model: "deepseek-v4-flash", inputTokens: 50_000, outputTokens: 5_000, cacheReadTokens: 0, cacheCreationTokens: 0, observedAt: "2026-07-27T09:03:00.000Z" }, "2026-07-27T09:03:00.000Z", 2);

  // Close from 09:02:30 — first usage (09:01) stays on AT-1, second (09:03) becomes untagged
  clearRunTask(runId, { dbPath, at: "2026-07-27T09:02:30.000Z" });

  const summary = querySummary(db);
  // AT-1 should still have the first usage (100k tokens, observed at 09:01 < 09:02:30)
  assert(summary.byTask["AT-1"] != null, "AT-1 must still exist (pre-at usage stays)");
  assert(summary.byTask["AT-1"].inputTokens === 100_000, `AT-1 tokens=${summary.byTask["AT-1"].inputTokens} (expected 100000 — only pre-at usage)`);
  // Second usage (50k, observed at 09:03 > 09:02:30) should be untagged
  assert(summary.byTask.__untagged__.inputTokens >= 50_000, `untagged tokens=${summary.byTask.__untagged__.inputTokens} (expected >=50000)`);
});

test("clearRunTask on run with no link → closed:false, no exception", () => {
  const result = clearRunTask("run-no-links-ever", { dbPath });
  assert(result.closed === false, "closed must be false when no active link exists");
  assert(result.runId === "run-no-links-ever", "runId preserved");
});

test("manual link PROTECTED: branch (conf 0.5) does NOT override manual (conf 1)", () => {
  const runId = "run-protect-branch";
  const ev = (type, payload, observedAt) => applyEvent(db, makeEvent(type, payload, {
    runId, observedAt, sourceKind: "test",
  }));
  ev("run.started", { runId, squad: "dev", startedAt: "2026-07-26T12:00:00.000Z" }, "2026-07-26T12:00:00.000Z");
  ev("task.linked", { runId, taskId: "MANUAL-1", source: "manual", confidence: 1 }, "2026-07-26T12:01:00.000Z");
  // Branch detection tries to override — must be IGNORED
  const result = applyEvent(db, makeEvent("task.linked", {
    runId, taskId: "BRANCH-2", source: "branch", confidence: 0.5,
  }, { runId, observedAt: "2026-07-26T12:02:00.000Z", sourceKind: "test" }));
  assert(result.ignored === true, `result.ignored=${result.ignored}`);
  assert(result.reason === "manual link wins", `reason=${result.reason}`);
  const links = getRunTaskLinks(db, runId);
  assert(links.current.taskId === "MANUAL-1", `current.taskId=${links.current.taskId} — manual survives branch`);
  assert(links.history.length === 1, `history.length=${links.history.length} — no new entry from ignored branch`);
});

test("manual link PROTECTED: kickoff (conf <1) does NOT override manual", () => {
  const runId = "run-protect-kickoff";
  const ev = (type, payload, observedAt) => applyEvent(db, makeEvent(type, payload, {
    runId, observedAt, sourceKind: "test",
  }));
  ev("run.started", { runId, squad: "dev", startedAt: "2026-07-26T13:00:00.000Z" }, "2026-07-26T13:00:00.000Z");
  ev("task.linked", { runId, taskId: "MANUAL-1", source: "manual", confidence: 1 }, "2026-07-26T13:01:00.000Z");
  const result = applyEvent(db, makeEvent("task.linked", {
    runId, taskId: "KICKOFF-9", source: "kickoff", confidence: 0.5,
  }, { runId, observedAt: "2026-07-26T13:02:00.000Z", sourceKind: "test" }));
  assert(result.ignored === true, "kickoff must be ignored when manual is active");
  const links = getRunTaskLinks(db, runId);
  assert(links.current.taskId === "MANUAL-1", "manual survives kickoff");
  assert(links.history.length === 1, "no new entry from ignored kickoff");
});

test("manual → manual (different task): newer wins (user correcting themselves)", () => {
  const runId = "run-manual-reassign";
  const ev = (type, payload, observedAt) => applyEvent(db, makeEvent(type, payload, {
    runId, observedAt, sourceKind: "test",
  }));
  ev("run.started", { runId, squad: "dev", startedAt: "2026-07-26T14:00:00.000Z" }, "2026-07-26T14:00:00.000Z");
  ev("task.linked", { runId, taskId: "WRONG-1", source: "manual", confidence: 1 }, "2026-07-26T14:01:00.000Z");
  ev("task.linked", { runId, taskId: "CORRECT-2", source: "manual", confidence: 1 }, "2026-07-26T14:02:00.000Z");
  const links = getRunTaskLinks(db, runId);
  assert(links.current.taskId === "CORRECT-2", `current.taskId=${links.current.taskId} — manual→manual must work`);
  assert(links.history.length === 2, `history.length=${links.history.length}`);
  assert(links.history[1].taskId === "WRONG-1", "old manual link closed");
  assert(links.history[1].validTo != null, "old manual link has validTo");
});

test("manual → launch (conf 1): newer wins (explicit dashboard launch)", () => {
  const runId = "run-launch-over-manual";
  const ev = (type, payload, observedAt) => applyEvent(db, makeEvent(type, payload, {
    runId, observedAt, sourceKind: "test",
  }));
  ev("run.started", { runId, squad: "dev", startedAt: "2026-07-26T15:00:00.000Z" }, "2026-07-26T15:00:00.000Z");
  ev("task.linked", { runId, taskId: "MANUAL-1", source: "manual", confidence: 1 }, "2026-07-26T15:01:00.000Z");
  ev("task.linked", { runId, taskId: "LAUNCH-2", source: "launch", confidence: 1 }, "2026-07-26T15:02:00.000Z");
  const links = getRunTaskLinks(db, runId);
  assert(links.current.taskId === "LAUNCH-2", `current.taskId=${links.current.taskId} — launch must override manual`);
  assert(links.history.length === 2, "history has 2 entries");
});

test("branch → branch: newer wins (no change from before)", () => {
  const runId = "run-branch-branch";
  const ev = (type, payload, observedAt) => applyEvent(db, makeEvent(type, payload, {
    runId, observedAt, sourceKind: "test",
  }));
  ev("run.started", { runId, squad: "dev", startedAt: "2026-07-26T16:00:00.000Z" }, "2026-07-26T16:00:00.000Z");
  ev("task.linked", { runId, taskId: "BRANCH-1", source: "branch", confidence: 0.5 }, "2026-07-26T16:01:00.000Z");
  ev("task.linked", { runId, taskId: "BRANCH-2", source: "branch", confidence: 0.5 }, "2026-07-26T16:02:00.000Z");
  const links = getRunTaskLinks(db, runId);
  assert(links.current.taskId === "BRANCH-2", "newer branch wins over older branch");
  assert(links.history.length === 2, "history has 2 entries");
});

test("clearRunTask closes manual link (explicit user action bypasses protection)", () => {
  const runId = "run-clear-manual";
  const ev = (type, payload, observedAt) => applyEvent(db, makeEvent(type, payload, {
    runId, observedAt, sourceKind: "test",
  }));
  ev("run.started", { runId, squad: "dev", startedAt: "2026-07-26T17:00:00.000Z" }, "2026-07-26T17:00:00.000Z");
  ev("task.linked", { runId, taskId: "MANUAL-1", source: "manual", confidence: 1 }, "2026-07-26T17:01:00.000Z");
  const result = clearRunTask(runId, { dbPath });
  assert(result.closed === true, "clearRunTask must close manual link");
  const links = getRunTaskLinks(db, runId);
  assert(links.current === null, "current must be null after clear");
  assert(links.history.length === 1, "history preserved");
});

test("ignored branch does NOT move cost — usage stays on manual task", () => {
  const runId = "run-cost-protection";
  const startedAt = "2026-07-26T18:00:00.000Z";
  const ev = (type, payload, observedAt, sourceOffset = null) => applyEvent(db, makeEvent(type, payload, {
    runId, observedAt, sourceKind: "test", sourcePath: sourceOffset == null ? null : "C:/cost.jsonl", sourceOffset,
  }));
  ev("run.started", { runId, squad: "dev", startedAt }, startedAt);
  ev("usage.recorded", { runId, model: "deepseek-v4-flash", inputTokens: 50_000, outputTokens: 5_000, cacheReadTokens: 0, cacheCreationTokens: 0, observedAt: "2026-07-26T18:01:00.000Z" }, "2026-07-26T18:01:00.000Z", 1);
  ev("task.linked", { runId, taskId: "MANUAL-1", source: "manual", confidence: 1, validFrom: startedAt }, "2026-07-26T18:02:00.000Z");
  ev("usage.recorded", { runId, model: "deepseek-v4-flash", inputTokens: 30_000, outputTokens: 3_000, cacheReadTokens: 0, cacheCreationTokens: 0, observedAt: "2026-07-26T18:03:00.000Z" }, "2026-07-26T18:03:00.000Z", 2);
  // Branch tries to steal — must be ignored
  applyEvent(db, makeEvent("task.linked", {
    runId, taskId: "BRANCH-9", source: "branch", confidence: 0.5,
  }, { runId, observedAt: "2026-07-26T18:04:00.000Z", sourceKind: "test" }));
  ev("usage.recorded", { runId, model: "deepseek-v4-flash", inputTokens: 20_000, outputTokens: 2_000, cacheReadTokens: 0, cacheCreationTokens: 0, observedAt: "2026-07-26T18:05:00.000Z" }, "2026-07-26T18:05:00.000Z", 3);
  const summary = querySummary(db);
  const bucket = summary.byTask["MANUAL-1"];
  assert(bucket != null, "MANUAL-1 must exist in byTask");
  assert(bucket.inputTokens === 100_000, `MANUAL-1 inputTokens=${bucket.inputTokens} (expected 100000 — ALL usage, branch was ignored)`);
  assert(summary.byTask["BRANCH-9"] == null, "BRANCH-9 must NOT appear in byTask (link was ignored)");
});

test("recordToolFact deduplicates on same source_path+source_offset+tool_index", async () => {
  const r1 = await recordToolFact({
    run_id: "test", agent_key: "x", tool_name_raw: "Read", tool_input: "{}",
    turn_index: 0, source_path: "/tmp/x", source_offset: 0, tool_index: 0,
  }, { dbPath });
  assert(r1.recorded === true, `first call recorded=${r1.recorded}`);
  assert(typeof r1.id === "string" && r1.id.length > 0, `first call id=${r1.id}`);
  const r2 = await recordToolFact({
    run_id: "test", agent_key: "x", tool_name_raw: "Read", tool_input: "{}",
    turn_index: 0, source_path: "/tmp/x", source_offset: 0, tool_index: 0,
  }, { dbPath });
  assert(r2.recorded === false, `second call recorded=${r2.recorded}`);
  assert(r2.reason === "duplicate", `reason=${r2.reason}`);
});

test("recordDelegationLink deduplicates on same parent_run_id+parent_agent+child_agent+observed_at", async () => {
  const d1 = await recordDelegationLink({
    parent_run_id: "test", parent_agent: "lead", child_agent: "implementer",
    observed_at: "2026-08-03T12:00:00.000Z", source: "transcript",
  }, { dbPath });
  assert(d1.recorded === true, `first call recorded=${d1.recorded}`);
  assert(typeof d1.id === "string" && d1.id.length > 0, `first call id=${d1.id}`);
  const d2 = await recordDelegationLink({
    parent_run_id: "test", parent_agent: "lead", child_agent: "implementer",
    observed_at: "2026-08-03T12:00:00.000Z", source: "transcript",
  }, { dbPath });
  assert(d2.recorded === false, `second call recorded=${d2.recorded}`);
  assert(d2.reason === "duplicate", `reason=${d2.reason}`);
});

test("FOC-104 poison pill: not-a-repo → is-a-repo keeps worktree_id stable (no FK rollback, usage lands)", () => {
  // Reproduces the worktree_id poison pill: a path registered as "not a git
  // repo" (repositoryId=null) on day 1, then re-registered as a git repo on
  // day 2. Under the old formula the computed worktree_id changed between
  // sessions, but ON CONFLICT(path) preserved the OLD id → the next INSERT
  // INTO workspace_observations used the NEW id → FK violation → the entire
  // applyEvents txn (including the usage.recorded row in the same batch)
  // rolled back, silently dropping usage for that run.
  const runId = "run-foc104";
  const cwdRaw = join(temp, "foc104", "trading_assist");
  const normalizedCwd = cwdRaw.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const commonDir = `${cwdRaw}/.git`;
  const observedAt1 = "2026-08-12T10:00:00.000Z";
  const observedAt2 = "2026-08-13T10:00:00.000Z";
  const usageObs = "2026-08-13T10:01:00.000Z";

  // Day 1: path is NOT a git repo → no commonDir → repositoryId stays null.
  applyEvent(db, makeEvent("run.started", { runId, squad: "dev", startedAt: observedAt1, cwd: cwdRaw },
    { runId, observedAt: observedAt1, sourceKind: "test", sourcePath: "C:/sessions/foc104.jsonl", sourceOffset: 0 }));
  applyEvent(db, makeEvent("workspace.observed",
    { runId, cwd: cwdRaw, refType: "unknown", refName: null, headSha: null, source: "runtime" },
    { runId, observedAt: observedAt1, sourceKind: "runtime", sourcePath: "C:/sessions/foc104.jsonl", sourceOffset: 1, eventId: "ws-foc104-d1" }));

  // Day 2: path IS a git repo → commonDir set. Batched with a usage.recorded
  // event in the SAME applyEvents txn — the poison pill rolled back BOTH.
  applyEvents(db, [
    makeEvent("workspace.observed",
      { runId, cwd: cwdRaw, commonDir, gitDir: commonDir, refType: "branch", refName: "foc-88-prices-yahoo-pipeline", headSha: "abc123", source: "runtime" },
      { runId, observedAt: observedAt2, sourceKind: "runtime", sourcePath: "C:/sessions/foc104.jsonl", sourceOffset: 2, eventId: "ws-foc104-d2" }),
    makeEvent("usage.recorded",
      { runId, model: "deepseek-v4-flash", inputTokens: 100_000, outputTokens: 10_000, cacheReadTokens: 0, cacheCreationTokens: 0, observedAt: usageObs },
      { runId, observedAt: usageObs, sourceKind: "transcript", sourcePath: "C:/sessions/foc104.jsonl", sourceOffset: 3, eventId: "usage-foc104" }),
  ]);

  // (a) usage.recorded committed (NOT dropped by FK rollback)
  const run = queryRuns(db, { runId })[0];
  assert(run != null, "run-foc104 missing from queryRuns");
  assert(run.totals.inputTokens === 100_000, `inputTokens=${run.totals.inputTokens} (expected 100000 — usage must survive the transition)`);
  const usageRow = db.prepare("SELECT input_tokens FROM usage_facts WHERE run_id=?").get(runId);
  assert(usageRow != null, "usage_facts row missing — txn rolled back");
  assert(usageRow.input_tokens === 100_000, `usage_facts.input_tokens=${usageRow.input_tokens} (expected 100000)`);

  // (b) workspace_observations row exists with a worktree_id that satisfies
  // the FK (referenced row present in worktrees) — the assertion that actually
  // broke under the old formula.
  const obs = db.prepare("SELECT worktree_id, repository_id FROM workspace_observations WHERE run_id=? ORDER BY id DESC LIMIT 1").get(runId);
  assert(obs != null, "workspace_observations row missing for run-foc104");
  const wt = db.prepare("SELECT worktree_id, repository_id FROM worktrees WHERE worktree_id=?").get(obs.worktree_id);
  assert(wt != null, `FK broken: workspace_observations.worktree_id=${obs.worktree_id} not in worktrees`);

  // (c) worktree_id is now keyed on path only (no repositoryId salt) and
  // repository_id got backfilled from day 2 git detection.
  const expectedWorktreeId = createHash("sha256").update(normalizedCwd).digest("hex");
  assert(wt.worktree_id === expectedWorktreeId, `worktree_id=${wt.worktree_id} expected hash(cwd)=${expectedWorktreeId}`);
  assert(wt.repository_id != null, "repository_id must be populated after day 2 git detection");
});

  test("FOC-104 backfillWorktreeIds upgrade: v3 worktree_id + referencing observation are rewritten and FK check stays clean", () => {
  // Simulate a database that was last written by v3 code, where worktree_id
  // was keyed on hash(`${repositoryId}:${cwd}`) instead of hash(path). We
  // open a fresh db (which runs migrate and marks schema as v4), undo the
  // schema_migrations marker so the backfill guard treats the db as pre-v4,
  // inject v3-style rows directly, then reopen — triggering backfillWorktreeIds
  // on real data — and verify both the worktrees PK and the FK reference in
  // workspace_observations are rewritten and the FK check is clean.
  const upgradeDbPath = join(temp, "telemetry-upgrade-test.sqlite");
  const v3db = openTelemetryDb(upgradeDbPath);

  const cwd = join(temp, "foc104-upgrade", "project").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const repositoryId = createHash("sha256").update(`${cwd}/.git`).digest("hex");
  const oldWorktreeId = createHash("sha256").update(`${repositoryId}:${cwd}`).digest("hex");
  const newWorktreeId = createHash("sha256").update(cwd).digest("hex");

  // Seed v3-style rows: worktrees row with old ID and a workspace_observation
  // that references it. Both use the same old ID so FK is satisfied at seed time.
  v3db.exec("PRAGMA foreign_keys = OFF");
  v3db.prepare(
    "INSERT INTO runs (run_id, updated_at) VALUES (?, ?)",
  ).run("run-upgrade-v3", "2026-07-01T00:00:00.000Z");
  v3db.prepare(
    "INSERT INTO repositories (repository_id, common_dir, created_at) VALUES (?, ?, ?)",
  ).run(repositoryId, `${cwd}/.git`, "2026-07-01T00:00:00.000Z");
  v3db.prepare(
    "INSERT INTO worktrees (worktree_id, repository_id, path, git_dir, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(oldWorktreeId, repositoryId, cwd, `${cwd}/.git`, "2026-07-01T00:00:00.000Z");
  v3db.prepare(
    "INSERT INTO workspace_observations (run_id, observed_at, cwd, repository_id, worktree_id, ref_type, ref_name, head_sha, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("run-upgrade-v3", "2026-07-01T00:00:00.000Z", cwd, repositoryId, oldWorktreeId, "branch", "main", "abc123", "runtime");
  v3db.exec("PRAGMA foreign_keys = ON");

  // Remove the schema_migrations marker so backfillWorktreeIds treats this
  // database as pre-v4 and actually rewrites the rows.
  v3db.prepare("DELETE FROM schema_migrations WHERE version=?").run(MIGRATION_VERSIONS.worktreeRekey);
  v3db.close();

  // Reopen: migrate() runs, backfillWorktreeIds fires and rewrites old IDs.
  const upgraded = openTelemetryDb(upgradeDbPath);

  const wt = upgraded.prepare("SELECT worktree_id FROM worktrees WHERE path=?").get(cwd);
  assert(wt != null, "worktrees row missing after upgrade");
  assert(wt.worktree_id === newWorktreeId, `worktrees.worktree_id=${wt.worktree_id} expected hash(path)=${newWorktreeId}`);

  const obs = upgraded.prepare("SELECT worktree_id FROM workspace_observations WHERE run_id=?").get("run-upgrade-v3");
  assert(obs != null, "workspace_observations row missing after upgrade");
  assert(obs.worktree_id === newWorktreeId, `workspace_observations.worktree_id=${obs.worktree_id} expected ${newWorktreeId}`);

  const fkViolations = upgraded.prepare("PRAGMA foreign_key_check").all();
  assert(fkViolations.length === 0, `foreign_key_check found violations: ${JSON.stringify(fkViolations)}`);

  upgraded.close();
});

test("cross-run isolation: two runs sharing a JSONL keep separate cost_facts", () => {
  // JOI-261: usage_facts PK is (run_id, usage_id) and cost_facts PK is
  // (run_id, usage_id, price_set_id) — both run-scoped (v5, JOI-260). Two runs
  // ingesting the SAME source_path:offset derive the SAME usage_id hash but
  // must each land their own usage_facts / cost_facts rows; the run-scoped
  // joins (c.run_id=u.run_id) must NOT cross-attach run A's cost to run B.
  const run1Before = queryRuns(db).find((r) => r.runId === "run-1");
  const cost1Before = run1Before.totals.costUSD;
  applyEvent(db, makeEvent("run.started", {
    runId: "run-2", squad: "dev", startedAt: "2026-07-24T09:00:00.000Z", cwd: "C:/repos/office",
  }, { runId: "run-2" }));
  // Same source_path:offset as run-1's idempotent event → identical usageId hash.
  applyEvent(db, makeEvent("usage.recorded", {
    runId: "run-2", sessionId: "session-1", agentKey: "implementer", model: "deepseek-v4-flash",
    observedAt: "2026-07-24T09:07:00.000Z", inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheCreationTokens: 0,
  }, { runId: "run-2", observedAt: "2026-07-24T09:07:00.000Z", sourceKind: "transcript", sourcePath: "C:/sessions/session-1.jsonl", sourceOffset: 42, eventId: "usage-run2-1" }));
  const usage2 = db.prepare("SELECT COUNT(*) AS n FROM usage_facts WHERE run_id=?").get("run-2");
  assert(usage2.n === 1, `run-2 usage_facts rows=${usage2.n}`);
  const cost2 = db.prepare("SELECT COUNT(*) AS n FROM cost_facts WHERE run_id=?").get("run-2");
  assert(cost2.n === 1, `run-2 cost_facts rows=${cost2.n}`);
  const run2 = queryRuns(db).find((r) => r.runId === "run-2");
  assert(run2.totals.costUSD > 0, `run-2 cost=${run2.totals.costUSD}`);
  // Run A's cost is unchanged — run B's row did not cross-join into it.
  const run1After = queryRuns(db).find((r) => r.runId === "run-1");
  assert(run1After.totals.costUSD === cost1Before, `run-1 cost drifted ${cost1Before} → ${run1After.totals.costUSD}`);
  assert(run1After.byAgent.implementer.turns === 1, `run-1 turns drifted=${run1After.byAgent.implementer.turns}`);
});

// --- orphanRunVerdict ------------------------------------------------------
// Guards the immortal-run bug: reconcileDeadRuns() only ever closed runs whose
// console pid was gone, so a run with NO pid could never be closed by anything.
// Two leaked test fixtures sat in the production Live view as permanently
// ACTIVE until 2026-08-17.

const NOW = Date.parse("2026-08-17T15:00:00.000Z");
const ago = (ms) => new Date(NOW - ms).toISOString();

test("orphanRunVerdict: a live console pid is never the orphan path's business", () => {
  const v = orphanRunVerdict({ runId: "r", consolePid: 4321, startedAt: ago(50 * 3600_000) }, NOW);
  assert(v === null, `expected null for a run with a pid, got ${JSON.stringify(v)}`);
});

test("orphanRunVerdict: an already-ended run is left alone", () => {
  const v = orphanRunVerdict({ runId: "r", endedAt: ago(0), startedAt: ago(50 * 3600_000) }, NOW);
  assert(v === null, `expected null for an ended run, got ${JSON.stringify(v)}`);
});

test("orphanRunVerdict: no pid but recently active → still running, leave it", () => {
  const v = orphanRunVerdict({ runId: "r", consolePid: null, startedAt: ago(20 * 3600_000), lastActivityAt: ago(60_000) }, NOW);
  assert(v === null, `a run active a minute ago must not be closed, got ${JSON.stringify(v)}`);
});

test("orphanRunVerdict: lastActivityAt wins over an old startedAt", () => {
  // The 3h runs in the dashboard are real. Only idleness counts, not age.
  const v = orphanRunVerdict({ runId: "r", consolePid: null, startedAt: ago(40 * 3600_000), lastActivityAt: ago(3 * 3600_000) }, NOW);
  assert(v === null, `long-running but recently active must survive, got ${JSON.stringify(v)}`);
});

test("orphanRunVerdict: no pid and idle past the window → close, ending at last activity", () => {
  const last = ago(13 * 3600_000);
  const v = orphanRunVerdict({ runId: "r", consolePid: null, startedAt: ago(40 * 3600_000), lastActivityAt: last }, NOW);
  assert(v != null, "13h idle with no pid must be closed");
  assert(v.endedAt === last, `endedAt=${v.endedAt} must be the last activity, not now`);
  assert(/idle for 13h/.test(v.reason), `reason=${v.reason}`);
});

test("orphanRunVerdict: the idle window boundary is pinned on both sides", () => {
  // "idle for at least ORPHAN_RUN_IDLE_MS" is the rule: one millisecond short
  // survives, exactly at the window closes.
  const justUnder = orphanRunVerdict({ runId: "r", consolePid: null, lastActivityAt: ago(ORPHAN_RUN_IDLE_MS - 1) }, NOW);
  assert(justUnder === null, `1 ms short of the window must survive, got ${JSON.stringify(justUnder)}`);
  const atWindow = orphanRunVerdict({ runId: "r", consolePid: null, lastActivityAt: ago(ORPHAN_RUN_IDLE_MS) }, NOW);
  assert(atWindow != null, "exactly at the window must close");
});

test("orphanRunVerdict: the real leaked fixtures — no pid, no timeline at all", () => {
  // Exactly the two rows found in the production store: squad null, started_at
  // null, console_pid null, zero usage. Nothing to age them against, so they
  // are closed immediately rather than living forever.
  for (const runId of ["test-run-fk-2", "test-1786714377"]) {
    const v = orphanRunVerdict({ runId, consolePid: null, startedAt: null, lastActivityAt: null }, NOW);
    assert(v != null, `${runId} must be closable`);
    assert(v.endedAt === null, `${runId} endedAt=${v.endedAt} — no timeline to end at, caller substitutes now`);
    assert(/no timeline/.test(v.reason), `${runId} reason=${v.reason}`);
  }
});

test("orphanRunVerdict: an unparsable timestamp is treated as no timeline, not as fresh", () => {
  const v = orphanRunVerdict({ runId: "r", consolePid: null, lastActivityAt: "not-a-date" }, NOW);
  assert(v != null, "a garbage timestamp must not keep a run alive forever");
  assert(/unparsable/.test(v.reason), `reason=${v.reason}`);
});

test("orphanRunVerdict: consolePid 0 and negatives count as no pid", () => {
  for (const pid of [0, -1]) {
    const v = orphanRunVerdict({ runId: "r", consolePid: pid, lastActivityAt: ago(20 * 3600_000) }, NOW);
    assert(v != null, `consolePid=${pid} must fall through to the orphan path`);
  }
});

db.close();
assert(existsSync(dbPath), "database was not created");
rmSync(temp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) console.log(failures.join("\n"));
process.exit(failed ? 1 : 0);
