// Contract test for scripts/decision-analytics.mjs — the decision-quality
// panel over the FOC-449 decisions.jsonl log.
//
// Every assertion here is a way the panel can silently lie: dropping a legacy
// or malformed line without counting it, joining a label to the wrong event,
// letting a stale (not latest) label decide agreement, guessing an
// answers→outcome mapping for an unknown decision, or mis-splitting the
// pre/post era around the FOC-397 boundary. The fixture packs each failure
// mode into two run logs read by one readDecisionLog pass.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ROOT } from "./decision-log.mjs";
import {
  SMALL_SAMPLE_N,
  resolveRunsDir,
  readDecisionLog,
  decisionsPanel,
  decisionTables,
} from "./decision-analytics.mjs";

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    return;
  }
  failed++;
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

const approx = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// --- fixture: two run logs, every failure mode as one line -------------------
//
// ts layout around the era boundary 2026-09-22T00:00:00.000Z:
//   pre:  e1, e4 (09-21), e6 (09-20)          post: e2, e3, e5, e7, e8 (09-23)
// events: e1,e4,e5 triage_node · e2,e6 task_size · e3,e8 has_acceptance · e7 mystery

const BOUNDARY = "2026-09-22T00:00:00.000Z";

const runALines = [
  JSON.stringify({
    type: "event", eventId: "e1", decisionId: "intake.triage_node", runId: "run-a",
    ts: "2026-09-21T10:00:00.000Z", model: "m1", tier: 1, mode: "live", ok: true,
    confidence: 0.9, formatConfidence: null, durationMs: 100,
    usage: { inputTokens: 10, outputTokens: 5, cost: 0.001 }, error: null, taskKey: "K1",
    answers: { q0: { type: "choice", choice: "plan" } },
  }),
  JSON.stringify({
    type: "label", eventId: "e1", outcome: "plan", by: "agent", source: "auto",
    via: "gate", ts: "2026-09-21T11:00:00.000Z",
  }),
  JSON.stringify({
    type: "event", eventId: "e2", decisionId: "intake.task_size", runId: "run-a",
    ts: "2026-09-23T10:00:00.000Z", model: "m2", tier: 1, mode: "live", ok: true,
    confidence: 0.7, formatConfidence: null, durationMs: 200,
    usage: { inputTokens: 20, outputTokens: 8, cost: 0.004 }, error: null, taskKey: "K2",
    answers: { size: { type: "choice", choice: "medium" } },
  }),
  // Non-matching label: answer "medium", outcome "large" → agreement must see it.
  JSON.stringify({
    type: "label", eventId: "e2", outcome: "large", by: "human", source: "manual",
    ts: "2026-09-23T11:00:00.000Z",
  }),
  JSON.stringify({
    type: "event", eventId: "e3", decisionId: "intake.has_acceptance_criteria", runId: "run-a",
    ts: "2026-09-23T12:00:00.000Z", model: "m1", tier: 1, mode: "live", ok: true,
    confidence: 0.95, formatConfidence: null, durationMs: 50,
    usage: { inputTokens: 30, outputTokens: 3 }, error: null, taskKey: "K3",
    answers: { q0: { type: "noul", noul: 0.9 } },
  }),
  JSON.stringify({
    type: "event", eventId: "e4", decisionId: "intake.triage_node", runId: "run-a",
    ts: "2026-09-21T12:00:00.000Z", model: "m1", tier: 1, mode: "live", ok: false,
    confidence: 0.55, formatConfidence: null, durationMs: 300,
    usage: { inputTokens: 40, outputTokens: 6, cost: 0.002 }, error: "boom", taskKey: "K1",
    answers: { q0: { type: "choice", choice: "ask" } },
  }),
  JSON.stringify({
    type: "event", eventId: "e5", decisionId: "intake.triage_node", runId: "run-a",
    ts: "2026-09-23T14:00:00.000Z", model: "m2", tier: 1, mode: "live", ok: true,
    confidence: 0.25, formatConfidence: null, durationMs: 200,
    error: null, taskKey: "K4",
    answers: { q0: { type: "choice", choice: "plan" } },
  }),
  // Two labels for e5: the EARLIER one would match ("plan"); the LATEST ("dev")
  // must decide agreement — this pair proves latest-wins.
  JSON.stringify({
    type: "label", eventId: "e5", outcome: "plan", by: "agent", source: "auto",
    via: "verdict", ts: "2026-09-23T14:30:00.000Z",
  }),
  JSON.stringify({
    type: "label", eventId: "e5", outcome: "dev", by: "agent", source: "auto",
    via: "verdict", ts: "2026-09-23T15:00:00.000Z",
  }),
  // Legacy pre-FOC-449 line: no `type`, no eventId — skipped and counted.
  JSON.stringify({ ts: "2026-09-20T00:00:00.000Z", decisionId: "legacy.thing", ok: true }),
  // Malformed line: not JSON at all — a parseError, never a silent drop.
  '{"broken":',
  // Orphan label: points at an event that exists nowhere.
  JSON.stringify({
    type: "label", eventId: "ghost", outcome: "dev", by: "human", source: "manual",
    ts: "2026-09-23T16:00:00.000Z",
  }),
];

const runBLines = [
  JSON.stringify({
    type: "event", eventId: "e6", decisionId: "intake.task_size", runId: "run-b",
    ts: "2026-09-20T09:00:00.000Z", model: "m1", tier: 1, mode: "live", ok: true,
    confidence: 0.6, formatConfidence: null, durationMs: 150,
    error: null, taskKey: "K5",
    answers: { size: { type: "choice", choice: "small" } },
  }),
  // Unmapped decision: agreement MUST be null, never a guess.
  JSON.stringify({
    type: "event", eventId: "e7", decisionId: "mystery.decision", runId: "run-b",
    ts: "2026-09-23T09:00:00.000Z", model: "m1", tier: 1, mode: "live", ok: true,
    confidence: 0.8, formatConfidence: null, durationMs: 80,
    error: null, taskKey: "K6",
    answers: { x: { type: "choice", choice: "whatever" } },
  }),
  // noul below 0.5 → answer "false" (the canonical plan-gates.mjs reading).
  JSON.stringify({
    type: "event", eventId: "e8", decisionId: "intake.has_acceptance_criteria", runId: "run-b",
    ts: "2026-09-23T13:00:00.000Z", model: "m1", tier: 1, mode: "live", ok: true,
    confidence: 0.85, formatConfidence: null, durationMs: 45,
    error: null, taskKey: "K7",
    answers: { q0: { type: "noul", noul: 0.3 } },
  }),
];

const temp = mkdtempSync(join(tmpdir(), "decision-analytics-test-"));
try {
  for (const [runId, lines] of [["run-a", runALines], ["run-b", runBLines]]) {
    const runDir = join(temp, runId);
    mkdirSync(runDir);
    writeFileSync(join(runDir, "decisions.jsonl"), lines.join("\n") + "\n", "utf8");
  }

  // --- readDecisionLog: counts ------------------------------------------------
  const log = readDecisionLog(temp);
  check("files: one per run dir with a decisions.jsonl", log.files === 2, `got ${log.files}`);
  check("events: 8 parsed", log.events.length === 8, `got ${log.events.length}`);
  check("labels: 5 parsed", log.labels.length === 5, `got ${log.labels.length}`);
  check("legacyLines: 1 counted", log.legacyLines === 1, `got ${log.legacyLines}`);
  check("parseErrors: 1 counted (malformed line)", log.parseErrors === 1, `got ${log.parseErrors}`);

  const e1 = log.events.find((e) => e.eventId === "e1");
  check("event carries usage-derived cost/tokens", e1 && e1.costUsd === 0.001 && e1.inputTokens === 10 && e1.outputTokens === 5);
  check("choice answer mapped (q0.choice)", e1 && e1.answer === "plan", `got ${e1?.answer}`);
  const e3 = log.events.find((e) => e.eventId === "e3");
  check("noul >= 0.5 → answer \"true\"", e3 && e3.answer === "true", `got ${e3?.answer}`);
  check("usage without cost → costUsd null (never 0)", e3 && e3.costUsd === null);
  const e8 = log.events.find((e) => e.eventId === "e8");
  check("noul < 0.5 → answer \"false\"", e8 && e8.answer === "false", `got ${e8?.answer}`);
  const e5 = log.events.find((e) => e.eventId === "e5");
  check("no usage → tokens null", e5 && e5.inputTokens === null && e5.outputTokens === null && e5.costUsd === null);
  const e7 = log.events.find((e) => e.eventId === "e7");
  check("unmapped decision → answer null (no guess)", e7 && e7.answer === null, `got ${e7?.answer}`);

  const labelE2 = log.labels.find((l) => l.eventId === "e2");
  check(
    "label record shape (via null when absent)",
    labelE2 && labelE2.outcome === "large" && labelE2.by === "human" && labelE2.source === "manual" && labelE2.via === null,
  );

  // --- panel, era all ----------------------------------------------------------
  const all = decisionsPanel({ era: "all", eraBoundary: BOUNDARY }, { runsDir: temp });
  check("totals.events across both runs", all.data.totals.events === 8, `got ${all.data.totals.events}`);
  check("totals.labelled = e1, e2, e5", all.data.totals.labelled === 3, `got ${all.data.totals.labelled}`);
  check("totals.decisions = 4 distinct ids", all.data.totals.decisions === 4, `got ${all.data.totals.decisions}`);
  check("totals.legacyLinesSkipped", all.data.totals.legacyLinesSkipped === 1);
  check("totals.parseErrors", all.data.totals.parseErrors === 1);

  const rows = all.data.decisions;
  check("sorted by n desc", rows[0].n >= rows[1].n && rows[1].n >= rows[2].n && rows[2].n >= rows[3].n);
  const triage = rows.find((d) => d.decisionId === "intake.triage_node");
  const size = rows.find((d) => d.decisionId === "intake.task_size");
  const ac = rows.find((d) => d.decisionId === "intake.has_acceptance_criteria");
  const mystery = rows.find((d) => d.decisionId === "mystery.decision");

  check("triage n=3", triage && triage.n === 3);
  check("triage okRate = 2/3", triage && approx(triage.okRate, 2 / 3), `got ${triage?.okRate}`);
  check("triage errorCount=1 (ok:false + error)", triage && triage.errorCount === 1);
  check(
    "triage agreement: e1 matches, e5 latest label (dev) does not",
    triage && triage.agreement && triage.agreement.compared === 2 && triage.agreement.matched === 1 && approx(triage.agreement.rate, 0.5),
    `got ${JSON.stringify(triage?.agreement)}`,
  );
  check(
    "triage confidence spread + buckets (0.25→[.2,.4), 0.55→[.4,.6), 0.9→[.8,1])",
    triage && triage.confidence && triage.confidence.min === 0.25 && triage.confidence.p50 === 0.55 && triage.confidence.max === 0.9 && JSON.stringify(triage.confidence.buckets) === "[0,1,1,0,1]",
    `got ${JSON.stringify(triage?.confidence)}`,
  );
  check(
    "triage duration p50/p90 nearest-rank",
    triage && triage.durationMs && triage.durationMs.p50 === 200 && triage.durationMs.p90 === 300,
  );
  check(
    "triage cost total 0.003, perPricedEvent 0.0015 (2 priced of 3 events)",
    triage && triage.costUsd && approx(triage.costUsd.total, 0.003) && approx(triage.costUsd.perPricedEvent, 0.0015),
    `got ${JSON.stringify(triage?.costUsd)}`,
  );
  check(
    "perEvent aliases perPricedEvent (UI compatibility, same value — not the old n-based average)",
    triage && triage.costUsd && approx(triage.costUsd.perEvent, 0.0015) && triage.costUsd.perEvent === triage.costUsd.perPricedEvent,
    `got ${JSON.stringify(triage?.costUsd)}`,
  );
  check("triage models distinct+sorted", triage && JSON.stringify(triage.models) === '["m1","m2"]');
  check("triage smallSample flag", triage && triage.smallSample === true);

  check(
    "task_size: mismatching label counted (compared 1, matched 0, rate 0)",
    size && size.agreement && size.agreement.compared === 1 && size.agreement.matched === 0 && size.agreement.rate === 0,
    `got ${JSON.stringify(size?.agreement)}`,
  );
  check(
    "has_acceptance: mapped but no labels → rate null, not agreement_unknown",
    ac && ac.agreement && ac.agreement.compared === 0 && ac.agreement.matched === 0 && ac.agreement.rate === null,
    `got ${JSON.stringify(ac?.agreement)}`,
  );
  check("mystery.decision: agreement null (no mapping)", mystery && mystery.agreement === null);

  const codes = all.caveats.map((c) => `${c.level}:${c.code}`);
  check("small_sample caveat per small decision", all.caveats.filter((c) => c.code === "small_sample").length === 4);
  check("unlabelled caveat counts e3,e4,e6,e7,e8", (() => {
    const c = all.caveats.find((x) => x.code === "unlabelled");
    return c && c.count === 5 && c.level === "info";
  })());
  check("legacy_skipped caveat (info)", codes.includes("info:legacy_skipped"));
  check("orphan_labels caveat: the ghost", (() => {
    const c = all.caveats.find((x) => x.code === "orphan_labels");
    return c && c.count === 1 && c.level === "info";
  })());
  check("agreement_unknown caveat for mystery.decision (warn)", (() => {
    const c = all.caveats.find((x) => x.code === "agreement_unknown");
    return c && c.level === "warn" && c.message.includes("mystery.decision");
  })());
  check("partially_priced caveat fires for the mixed decisions (triage 1 of 3, task_size 1 of 2)", (() => {
    const cs = all.caveats.filter((x) => x.code === "partially_priced");
    return cs.length === 2 && cs.every((c) => c.level === "info" && c.count === 1) &&
      cs.some((c) => c.message.includes("intake.triage_node")) &&
      cs.some((c) => c.message.includes("intake.task_size"));
  })());
  check("no partially_priced caveat for fully-costless decisions (has_acceptance, mystery)", (() => {
    // has_acceptance e3/e8 and mystery e7 carry no cost at all — costUsd is
    // null there, which already says "no cost data"; no number to misreport.
    return !all.caveats.some((x) => x.code === "partially_priced" &&
      (x.message.includes("intake.has_acceptance_criteria") || x.message.includes("mystery.decision")));
  })());

  // --- era split ---------------------------------------------------------------
  const pre = decisionsPanel({ era: "pre", eraBoundary: BOUNDARY }, { runsDir: temp });
  const post = decisionsPanel({ era: "post", eraBoundary: BOUNDARY }, { runsDir: temp });
  check("pre-era: only e1, e4, e6", pre.data.totals.events === 3, `got ${pre.data.totals.events}`);
  check("pre-era: 2 decisions", pre.data.totals.decisions === 2, `got ${pre.data.totals.decisions}`);
  check("post-era: e2, e3, e5, e7, e8", post.data.totals.events === 5, `got ${post.data.totals.events}`);
  check("post-era: 4 decisions", post.data.totals.decisions === 4, `got ${post.data.totals.decisions}`);
  check("post-era triage n=1 (only e5)", post.data.decisions.find((d) => d.decisionId === "intake.triage_node")?.n === 1);
  check("pre-era agreement: e1 matches, e4 unlabelled", (() => {
    const a = pre.data.decisions.find((d) => d.decisionId === "intake.triage_node")?.agreement;
    return a && a.compared === 1 && a.matched === 1 && a.rate === 1;
  })());

  // --- from/to window ------------------------------------------------------------
  const windowed = decisionsPanel(
    { from: "2026-09-21T00:00:00.000Z", to: "2026-09-21T23:59:59.999Z", era: "all", eraBoundary: BOUNDARY },
    { runsDir: temp },
  );
  check("from/to window keeps only e1, e4", windowed.data.totals.events === 2, `got ${windowed.data.totals.events}`);

  // Date-only from/to mean the whole UTC day — a date-only `to` at midnight
  // would drop e1/e4 (both on 09-21) entirely.
  const dayWindow = decisionsPanel(
    { from: "2026-09-21", to: "2026-09-21", era: "all", eraBoundary: BOUNDARY },
    { runsDir: temp },
  );
  check("date-only from/to cover the whole UTC day (keeps e1, e4)",
    dayWindow.data.totals.events === 2, `got ${dayWindow.data.totals.events}`);

  // --- filter validation ----------------------------------------------------------
  const badEra = (() => {
    try {
      decisionsPanel({ era: "bogus" }, { runsDir: temp });
      return null;
    } catch (err) {
      return err;
    }
  })();
  check("bad era throws bad_filter", badEra && badEra.code === "bad_filter", `got ${badEra?.code}`);
  const noBoundary = (() => {
    try {
      decisionsPanel({ era: "post" }, { runsDir: temp });
      return null;
    } catch (err) {
      return err;
    }
  })();
  check("era pre/post without eraBoundary throws bad_filter", noBoundary && noBoundary.code === "bad_filter");
  const badFrom = (() => {
    try {
      decisionsPanel({ era: "all", from: "not-a-date" }, { runsDir: temp });
      return null;
    } catch (err) {
      return err;
    }
  })();
  check("unparseable from throws bad_filter", badFrom && badFrom.code === "bad_filter");

  // --- decisionTables: flat scalar shape for a SQL console ------------------------
  const tables = decisionTables(log);
  check(
    "decision_events columns cover the contract",
    tables.decision_events.columns.includes("answer") && tables.decision_events.columns.includes("costUsd"),
  );
  check("decision_events rows: one per event", tables.decision_events.rows.length === 8);
  check(
    "decision_events rows aligned with columns, scalars only",
    tables.decision_events.rows.every((row) => row.length === tables.decision_events.columns.length && row.every((v) => v === null || ["string", "number", "boolean"].includes(typeof v))),
  );
  const e3Row = tables.decision_events.rows[tables.decision_events.rows.findIndex((r) => r[0] === "e3")];
  check("decision_events row carries the mapped answer", e3Row && e3Row[tables.decision_events.columns.indexOf("answer")] === "true");
  check("decision_labels columns exact", JSON.stringify(tables.decision_labels.columns) === '["eventId","outcome","by","source","via","ts"]');
  check("decision_labels rows: one per label", tables.decision_labels.rows.length === 5);
  check("decision_labels rows scalars only", tables.decision_labels.rows.every((row) => row.every((v) => v === null || ["string", "number", "boolean"].includes(typeof v))));

  // --- missing runs dir: empty, not a throw ----------------------------------------
  const emptyLog = readDecisionLog(join(temp, "absent"));
  check(
    "missing dir → empty result, files 0",
    emptyLog.files === 0 && emptyLog.events.length === 0 && emptyLog.labels.length === 0 && emptyLog.legacyLines === 0 && emptyLog.parseErrors === 0,
  );
  const emptyPanel = decisionsPanel({ era: "all", eraBoundary: BOUNDARY }, { runsDir: join(temp, "absent") });
  check("missing dir → empty panel, no caveats", emptyPanel.data.totals.events === 0 && emptyPanel.data.decisions.length === 0 && emptyPanel.caveats.length === 0);

  // --- resolveRunsDir: env override, repo default -----------------------------------
  process.env.LA_DECISION_RUNS_DIR = join(temp, "custom-runs");
  check("LA_DECISION_RUNS_DIR wins", resolveRunsDir() === join(temp, "custom-runs"));
  delete process.env.LA_DECISION_RUNS_DIR;
  check("default is <repo root>/.state/runs", resolveRunsDir() === join(ROOT, ".state", "runs"), `got ${resolveRunsDir()}`);

  check("SMALL_SAMPLE_N is 30", SMALL_SAMPLE_N === 30);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log(`decision-analytics: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(1);
}
