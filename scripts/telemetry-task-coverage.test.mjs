// Task-attribution coverage + link validation (FOC-221).
//
// Attribution carries uncertainty, and the fleet surfaces must expose it
// instead of laundering it: every run lands in exactly one deterministic
// coverage class, ambiguity is flagged (never silently first-picked the way a
// bare `ORDER BY confidence DESC LIMIT 1` would), and a link is only accepted
// if its id even looks like a Linear identifier.
//
// Coverage classes, over a run's PRIMARY links:
//   unmatched   no active link — nothing is attributed
//   matched     one consistent attribution (a confidence>=1 link arbitrates,
//               or all links agree on the same task)
//   ambiguous   >=2 distinct tasks linked over the run's life, no confident
//               link — billed to the __ambiguous__ bucket with candidates

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  applyEvent, makeEvent, openTelemetryDb, querySummary, queryTrace, queryPatterns,
  runTaskCoverage, taskCoverageCounts,
} from "./telemetry-store.mjs";

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) { passed++; return; }
  failed++;
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

const temp = mkdtempSync(join(tmpdir(), "telemetry-task-coverage-test-"));
const db = openTelemetryDb(join(temp, "t.sqlite"));

const apply = (type, payload, observedAt = "2026-09-01T10:00:00.000Z", sourceOffset = null) =>
  applyEvent(db, makeEvent(type, payload, {
    runId: payload.runId, observedAt, sourceKind: "test",
    sourcePath: sourceOffset == null ? null : `C:/t/${payload.runId}.jsonl`, sourceOffset,
  }));

// --- link validation: an id that is not a Linear id never bills usage -----
apply("run.started", { runId: "run-garbage", squad: "dev", startedAt: "2026-09-01T10:00:00.000Z" }, "2026-09-01T10:00:00.000Z");
const garbage = apply("task.linked", { runId: "run-garbage", taskId: "hello-world", source: "launch", confidence: 1 }, "2026-09-01T10:01:00.000Z");
check("malformed id is rejected", garbage.rejected === true && garbage.reason === "task_id_malformed",
  JSON.stringify(garbage));
check("rejected link creates no link row",
  db.prepare("SELECT COUNT(*) n FROM run_task_links WHERE run_id='run-garbage'").get().n === 0);
check("rejected link creates no work item",
  db.prepare("SELECT COUNT(*) n FROM work_items WHERE task_id='hello-world'").get().n === 0);
check("rejection raises a visible quality issue",
  db.prepare("SELECT COUNT(*) n FROM data_quality_issues WHERE issue_type='task_id_malformed'").get().n === 1);
// Ids are uppercased BEFORE validation (normalizeTaskId) — lowercase input can
// become format-valid. That seam is deliberate; pin it so it stays visible.
check("lowercase input is normalised before validation",
  apply("task.linked", { runId: "run-norm", taskId: "focus-221", source: "launch", confidence: 1 }, "2026-09-01T10:01:00.000Z").rejected == null
  && db.prepare("SELECT COUNT(*) n FROM work_items WHERE task_id='FOCUS-221'").get().n === 1);

// Format-valid ids are accepted even when the team is unknown here — link
// validation is about FORMAT, not about resolving the team.
apply("task.linked", { runId: "run-formats", taskId: "ABC-123", source: "launch", confidence: 1 }, "2026-09-01T10:02:00.000Z");
apply("task.linked", { runId: "run-formats", taskId: "FOC-221", source: "manual", confidence: 1 }, "2026-09-01T10:03:00.000Z");
apply("task.linked", { runId: "run-formats", taskId: "JOI-1234567890", source: "agent_pick", confidence: 0.6 }, "2026-09-01T10:04:00.000Z");
check("format-valid ids land as links",
  db.prepare("SELECT COUNT(*) n FROM run_task_links WHERE run_id='run-formats'").get().n === 2);
check("FOC prefix is a first-class id",
  db.prepare("SELECT COUNT(*) n FROM work_items WHERE task_id='FOC-221'").get().n === 1);
// Boundary shapes of the format: team A-Z then 0-9, up to 10 chars; 1-10 digits.
check("team longer than 10 chars is rejected",
  apply("task.linked", { runId: "run-formats", taskId: "TOOLONGTEAM-1", source: "agent_pick" }, "2026-09-01T10:05:00.000Z").rejected === true);
check("more than 10 digits is rejected",
  apply("task.linked", { runId: "run-formats", taskId: "ABC-12345678901", source: "agent_pick" }, "2026-09-01T10:06:00.000Z").rejected === true);
check("single-char team is valid",
  apply("task.linked", { runId: "run-formats", taskId: "A-1", source: "agent_pick", confidence: 0.6 }, "2026-09-01T10:07:00.000Z").rejected == null);

// --- coverage fixtures ----------------------------------------------------
// The garbage run still produces usage — which must then be untagged, never
// billed against a rejected id.
apply("usage.recorded", { runId: "run-garbage", model: "deepseek-v4-flash", inputTokens: 400, outputTokens: 1, observedAt: "2026-09-01T11:10:00.000Z" },
  "2026-09-01T11:10:00.000Z", 10);
const runWith = (runId, squad, links, usage) => {
  apply("run.started", { runId, squad, startedAt: "2026-09-01T11:00:00.000Z" }, "2026-09-01T11:00:00.000Z");
  links.forEach(([taskId, source, confidence, at, validTo], i) => {
    apply("task.linked", { runId, taskId, source, confidence, validTo: validTo ?? null },
      `2026-09-01T11:0${i + 1}:00.000Z`);
  });
  usage.forEach(([tokens, model, offset], i) => {
    apply("usage.recorded", { runId, model, inputTokens: tokens, outputTokens: 1, observedAt: `2026-09-01T11:1${i}:00.000Z` },
      `2026-09-01T11:1${i}:00.000Z`, offset);
  });
};

// matched by arbitration: a confidence-1 launch link
runWith("run-conf", "dev", [["FEN-10", "launch", 1]], [[100, "deepseek-v4-flash", 10]]);
// matched by agreement: two inferential links, same task
runWith("run-agree", "dev", [["FEN-11", "agent_pick", 0.6], ["FEN-11", "branch_inference", 0.4]], [[200, "deepseek-v4-flash", 10]]);
// ambiguous: two competing tasks, no confident link — flagged, not first-picked
runWith("run-ambig", "dev", [["FEN-20", "agent_pick", 0.6], ["FEN-21", "agent_pick", 0.6]], [[300, "deepseek-v4-flash", 10]]);
// unmatched: the only link was explicitly closed — nothing active
runWith("run-closed", "test", [["FEN-30", "agent_pick", 0.6, "2026-09-01T11:01:00.000Z", "2026-09-01T11:02:00.000Z"]], [[400, "deepseek-v4-flash", 10]]);
// matched by manual arbitration over an earlier weak pick
runWith("run-arb", "review", [["FEN-40", "agent_pick", 0.6], ["FEN-41", "manual", 1]], [[500, "deepseek-v4-flash", 10]]);
// format-valid run with usage: its usage must bill the active link's task
runWith("run-formats", "dev", [], [[600, "deepseek-v4-flash", 10]]);
// an unpriced turn on a matched run: cost must go null, not zero
apply("usage.recorded", { runId: "run-conf", model: "unknown-model-v99", inputTokens: 7, outputTokens: 1, observedAt: "2026-09-01T11:20:00.000Z" },
  "2026-09-01T11:20:00.000Z", 20);

// --- runTaskCoverage: one row per link, class from the run ---------------
const coverage = runTaskCoverage(db);
const linksOf = (runId) => coverage.filter((r) => r.run_id === runId);
check("confident link is matched", linksOf("run-conf").length === 1 && linksOf("run-conf")[0].coverage === "matched",
  JSON.stringify(linksOf("run-conf")));
check("agreeing links are matched", linksOf("run-agree").length === 2 && linksOf("run-agree").every((r) => r.coverage === "matched"));
check("both links of an ambiguous run carry ambiguous",
  linksOf("run-ambig").length === 2 && linksOf("run-ambig").every((r) => r.coverage === "ambiguous"),
  JSON.stringify(linksOf("run-ambig")));
check("closed link is unmatched", linksOf("run-closed").length === 1 && linksOf("run-closed")[0].coverage === "unmatched");
check("manual arbitration resolves to matched", linksOf("run-arb").length === 2 && linksOf("run-arb").every((r) => r.coverage === "matched"));
check("coverage rows carry link provenance",
  linksOf("run-arb").every((r) => r.link_id && r.task_id && r.source && r.valid_from));

// --- taskCoverageCounts: per class, over runs with canonical usage --------
const counts = taskCoverageCounts(db);
check("coverage counts: 4 matched", counts.matched === 4, JSON.stringify(counts));
check("coverage counts: 1 ambiguous", counts.ambiguous === 1, JSON.stringify(counts));
check("coverage counts: 2 unmatched (closed link + garbage run)", counts.unmatched === 2, JSON.stringify(counts));

// --- fleet surface: byTask buckets ---------------------------------------
const summary = querySummary(db);
const ambig = summary.byTask.__ambiguous__;
check("ambiguous usage is billed to its own bucket", ambig != null && ambig.coverage === "ambiguous");
check("ambiguous bucket carries the candidates, sorted", JSON.stringify(ambig?.candidateTaskIds) === JSON.stringify(["FEN-20", "FEN-21"]),
  JSON.stringify(ambig?.candidateTaskIds));
check("ambiguous bucket is not first-picked into FEN-20 or FEN-21",
  summary.byTask["FEN-20"] == null && summary.byTask["FEN-21"] == null);
check("matched buckets expose their class", summary.byTask["FEN-10"]?.coverage === "matched");
check("FOC-221 usage bills its active link", summary.byTask["FOC-221"]?.inputTokens === 600
  && summary.byTask["FOC-221"].coverage === "matched", JSON.stringify(summary.byTask["FOC-221"]));
check("untagged bucket exposes unmatched class", summary.byTask.__untagged__?.coverage === "unmatched");
check("garbage-run usage lands in __untagged__, not a fake task key",
  summary.byTask.__untagged__?.inputTokens === 800, JSON.stringify(summary.byTask.__untagged__));
check("summary exposes taskCoverage counts", JSON.stringify(summary.taskCoverage) === JSON.stringify(counts));

// Unknown price on a matched run: cost null with the count next to it.
check("matched bucket with an unpriced turn reports null cost, count kept",
  summary.byTask["FEN-10"].costUSD === null && summary.byTask["FEN-10"].unpricedUsageCount === 1,
  `cost=${summary.byTask["FEN-10"].costUSD} unpriced=${summary.byTask["FEN-10"].unpricedUsageCount}`);

// --- trace: unknown price is null and counted, never folded to 0 ----------
const trace = queryTrace(db, "FEN-10");
const steps = trace.runs.flatMap((r) => r.steps);
check("trace propagates unpriced turns as null cost",
  steps.some((s) => s.costUSD === null && s.unpriced >= 1), JSON.stringify(steps));
check("trace total is null, not a partial sum laundered as truth", trace.totalCostUSD === null, `total=${trace.totalCostUSD}`);

// --- patterns: unpriced turns counted per squad/agent --------------------
const patterns = queryPatterns(db);
const confStep = patterns.stepStats.find((s) => s.squad === "dev" && s.agent === "_lead");
check("patterns carry unpriced_turns", confStep && confStep.unpriced_turns === 1, JSON.stringify(confStep));
check("patterns cost still sums the priced turns", confStep.cost_usd > 0, `cost=${confStep?.cost_usd}`);

db.close();
rmSync(temp, { recursive: true, force: true });

console.log(`${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  FAIL: ${f}`).join("\n"));
  process.exit(1);
}
