#!/usr/bin/env node
// scripts/verdict-evidence.test.mjs — FOC-219 tests for the verdict-evidence
// projection (design §5 + §7). Hand-rolled check() convention, same as
// delegation-outcomes.test.mjs: plain script, counters, exit non-zero on any
// failure. Section map:
//   1. Six fixtures (duplicate_import, conflicting, resumed_dev, multi_round,
//      absent_test, stable_rerun) built in mkdtempSync dirs, inline goldens.
//   2. Pure buildLogicalVerdicts unit cases (determinism, conflict
//      classification, evidence-asymmetry, cross-round non-merge, numeric
//      round sort, cross-stage-recording rollup).
//   3. Idempotency: sha256(JSON.stringify(report)) equal across two separate
//      child processes (spawnSync) and across two creation-order variants of
//      a content-identical corpus.
//   4. Key-order guard: report equals a key-by-key rebuilt snapshot (catches
//      accidental raw-JSON spread or key-order drift on schema'd surfaces).
//   5. Real-corpus read-only A/B against the main checkout (skipped when
//      .state/ is absent, e.g. a fresh worktree), asserting the design
//      baseline: logicalVerdicts 118, matched 11, unmatched 104, ambiguous 3.
// The suite is hermetic: every fixture pins dbPath to null / a nonexistent
// LA_TELEMETRY_DB so the machine's real telemetry DB never leaks in.

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildLogicalVerdicts, projectVerdictEvidence } from "./verdict-evidence.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, "verdict-evidence.mjs");

// ── check() convention ────────────────────────────────────────────────────────

const results = { pass: 0, fail: 0, skip: 0 };
const failures = [];
function check(name, ok, detail = "") {
  if (ok) {
    results.pass++;
    console.log(`  ok  ${name}`);
  } else {
    results.fail++;
    failures.push(name + (detail ? ` — ${detail}` : ""));
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const sumInvariant = (cov) =>
  cov.matched + cov.unmatched + cov.ambiguous === cov.logicalVerdicts;
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const isSha12 = (s) => typeof s === "string" && /^[0-9a-f]{12}$/.test(s);

// ── fixture corpus helpers ────────────────────────────────────────────────────

// Deterministic run ids (real-corpus shape: ISO stamp + supervisor-<4hex>).
const RUN = {
  dup: "2026-09-01T10-00-00-000-supervisor-ab12",
  conf: "2026-09-01T11-00-00-000-supervisor-cd34",
  res: "2026-09-01T12-00-00-000-supervisor-ef56",
  multi: "2026-09-01T13-00-00-000-supervisor-ab78",
  stable: "2026-09-01T14-00-00-000-supervisor-aa99",
};

const rec = (over = {}) => ({
  taskId: "FXT-1",
  round: 1,
  squad: "review",
  childId: "review-1",
  verdict: "pass",
  fingerprint: null,
  recordedAt: "2026-09-01T10:05:00.000Z",
  findings: [],
  acMapping: [],
  ...over,
});

const kid = (childId, squad, taskId, over = {}) => ({
  childId,
  squad,
  taskId,
  status: "completed",
  sessionId: null,
  telemetryRunId: null,
  baseRevision: null,
  turns: [],
  ...over,
});

function writeRun(supRoot, runId, { verdicts = [], gates = [], reports = [], children = null, extra = {} } = {}) {
  const dir = join(supRoot, runId);
  mkdirSync(join(dir, "verdicts"), { recursive: true });
  for (const r of verdicts) {
    writeFileSync(join(dir, "verdicts", `${r.taskId}-round${r.round}.json`), JSON.stringify(r, null, 2), "utf8");
  }
  if (gates.length) {
    mkdirSync(join(dir, "gates"), { recursive: true });
    for (const [name, gate] of gates) {
      writeFileSync(join(dir, "gates", name), JSON.stringify(gate, null, 2), "utf8");
    }
  }
  for (const [name, content] of reports) {
    writeFileSync(join(dir, name), content, "utf8");
  }
  if (children) {
    writeFileSync(join(dir, "children.json"), JSON.stringify({ runId, children }, null, 2), "utf8");
  }
  for (const [rel, content] of Object.entries(extra)) {
    writeFileSync(join(dir, rel), content, "utf8");
  }
}

// Review-md shape mirrored from delegation-outcomes.test.mjs known-good
// classifications: title carries "VERDICT: <X>", body carries the decisive
// token, optional **Run:** line carries the telemetry id for the attempt join.
function writeReview(reviewsDir, taskId, round, verdictWord, body, runId = null) {
  const parts = [`# REVIEW — ${taskId} — round ${round} — VERDICT: ${verdictWord}`, "", body];
  if (runId) parts.push("", `**Run:** \`${runId}\``);
  writeFileSync(join(reviewsDir, `${taskId}-round${round}.md`), parts.join("\n") + "\n", "utf8");
}
const PASS_BODY = "No `🔴 blocker`.";
const FAIL_BODY = "**Verdict:** 🔴 blocker → RETURN to DEV";
const UNKNOWN_BODY = "## VERDICT: UNKNOWN";

function mkCorpus(root) {
  const sup = join(root, "supervisor");
  const reviews = join(root, "reviews");
  mkdirSync(sup, { recursive: true });
  mkdirSync(reviews, { recursive: true });
  return { sup, reviews };
}

const project = ({ sup, reviews, dbPath = null }) =>
  projectVerdictEvidence({
    supervisorRoot: sup,
    reviewsDir: reviews,
    roundsPath: join(dirname(sup), "review-rounds.json"), // absent in every fixture
    dbPath,
  });

// Find helpers over the report.
const logicalOf = (report, issue, stage, round) =>
  report.logicalVerdicts.find((l) => l.issue === issue && l.stage === stage && l.round === round) || null;
const rowOf = (report, issue, source, round) =>
  report.evidenceRows.find((r) => r.issue === issue && r.source === source && r.round === round) || null;
const issueOf = (report, issue) => report.perIssue.find((p) => p.issue === issue) || null;

// ── temp root ─────────────────────────────────────────────────────────────────

let root;
try {
  root = mkdtempSync(join(tmpdir(), "foc219-vetest-"));
} catch (error) {
  console.error(`cannot create temp dir: ${error?.message || error}`);
  process.exit(1);
}

console.log(`# verdict-evidence.test.mjs — fixtures in ${root}\n`);

// ── 1a. fixture: duplicate_import (FOC-900) ───────────────────────────────────
// Same review event recorded by both stores; legacy attempt resolves through
// the reviewRunId → telemetryRunId → supervisor-run join (not unsupervised).

{
  const dir = join(root, "fix-duplicate_import");
  const c = mkCorpus(dir);
  writeRun(c.sup, RUN.dup, {
    verdicts: [
      rec({
        taskId: "FOC-900", round: 2, squad: "review", childId: "review-1", verdict: "pass",
        fingerprint: { combined: "0f9d8c7b6a5f4e3d" },
        acMapping: [{ ac: "AC1", status: "pass" }, { ac: "AC2", status: "pass" }],
      }),
    ],
    children: {
      "review-1": kid("review-1", "review", "FOC-900", { telemetryRunId: "2026-09-01T10-02-00-000-review-9a01" }),
      "dev-1": kid("dev-1", "dev", "FOC-900", {
        baseRevision: "abc1234567890",
        turns: [
          { startedAt: "2026-09-01T10:01:00.000Z", endedAt: "2026-09-01T10:04:00.000Z" },
          { startedAt: "2026-09-01T10:04:00.000Z", endedAt: null },
        ],
      }),
    },
  });
  writeReview(c.reviews, "FOC-900", 2, "PASS", PASS_BODY, "2026-09-01T10-02-00-000-review-9a01");

  const rep = project(c);
  check("duplicate_import: coverage {1,1,0,0}",
    JSON.stringify(rep.coverage) === JSON.stringify({ logicalVerdicts: 1, matched: 1, unmatched: 0, ambiguous: 0 }),
    JSON.stringify(rep.coverage));
  check("duplicate_import: sum invariant", sumInvariant(rep.coverage));
  check("duplicate_import: two evidence rows", rep.evidenceRows.length === 2, String(rep.evidenceRows.length));
  const l = logicalOf(rep, "FOC-900", "review", 2);
  check("duplicate_import: matched cell resolves PASS",
    !!l && l.coverageClass === "matched" && l.resolvedVerdict === "PASS" && l.resolution === null && l.conflict === null,
    JSON.stringify(l));
  check("duplicate_import: attempt joined via telemetry id (both rows)",
    rowOf(rep, "FOC-900", "structured", 2)?.attempt === RUN.dup && rowOf(rep, "FOC-900", "legacy", 2)?.attempt === RUN.dup,
    JSON.stringify([rowOf(rep, "FOC-900", "structured", 2)?.attempt, rowOf(rep, "FOC-900", "legacy", 2)?.attempt]));
  check("duplicate_import: both artifacts retained, structured first, sha12 digests",
    l?.artifacts.length === 2 && l.artifacts[0].kind === "verdict-json" && l.artifacts[1].kind === "review-md"
      && l.artifacts.every((a) => isSha12(a.sha256)),
    JSON.stringify(l?.artifacts));
  const srow = rowOf(rep, "FOC-900", "structured", 2);
  check("duplicate_import: work joins DEV child (baseRevision + workTurns 2)",
    srow?.work.workId === "fp:0f9d8c7b6a5f4e3d" && srow?.work.baseRevision === "abc1234567890" && srow?.work.workTurns === 2,
    JSON.stringify(srow?.work));
  const p = issueOf(rep, "FOC-900");
  check("duplicate_import: perIssue review final PASS, rounds 2, no r1 → firstPassClean null",
    p?.review.finalVerdict === "PASS" && p?.review.rounds === 2 && p?.review.firstPassClean === null,
    JSON.stringify(p?.review));
  check("duplicate_import: no test/human record → both unknown",
    p?.testAcceptance === "unknown" && p?.humanAcceptance === "unknown");
  check("duplicate_import: hermetic — delegations unavailable with dbPath null",
    rep.delegations.available === false && rep.delegations.attribution === "weak");
  check("duplicate_import: key-order guard", JSON.stringify(rep) === JSON.stringify(rebuildReport(rep)));
}

// ── 1b. fixture: conflicting (FOC-901) ────────────────────────────────────────
// Both stores decided, disagreeing: ambiguous, supervisor-precedence, both
// sides retained in native case.

{
  const dir = join(root, "fix-conflicting");
  const c = mkCorpus(dir);
  writeRun(c.sup, RUN.conf, {
    verdicts: [
      rec({
        taskId: "FOC-901", round: 1, squad: "review", childId: "review-2", verdict: "pass",
        fingerprint: { combined: "1111222233334444" }, findings: [{ id: "F1" }],
      }),
    ],
    children: {
      "review-2": kid("review-2", "review", "FOC-901", { telemetryRunId: "2026-09-01T11-01-00-000-review-9b02" }),
      "dev-2": kid("dev-2", "dev", "FOC-901", { baseRevision: "bcd2345678901", turns: [{}] }),
    },
  });
  writeReview(c.reviews, "FOC-901", 1, "FAIL", FAIL_BODY, "2026-09-01T11-01-00-000-review-9b02");

  const rep = project(c);
  check("conflicting: coverage {1,0,0,1}",
    JSON.stringify(rep.coverage) === JSON.stringify({ logicalVerdicts: 1, matched: 0, unmatched: 0, ambiguous: 1 }),
    JSON.stringify(rep.coverage));
  const l = logicalOf(rep, "FOC-901", "review", 1);
  check("conflicting: ambiguous, supervisor-precedence, resolved PASS (structured side)",
    !!l && l.coverageClass === "ambiguous" && l.resolvedVerdict === "PASS"
      && JSON.stringify(l.conflict) === JSON.stringify({ resolvedBy: "supervisor-precedence", sides: { structured: "pass", legacy: "FAIL" } }),
    JSON.stringify(l?.conflict));
  check("conflicting: both sources listed, both artifacts retained",
    JSON.stringify(l?.sources) === JSON.stringify(["structured", "legacy"]) && l?.artifacts.length === 2,
    JSON.stringify(l?.sources));
  check("conflicting: source-conflict anomaly raised",
    rep.anomalies.some((a) => a.reason === "source-conflict" && a.issue === "FOC-901"),
    JSON.stringify(rep.anomalies));
  const p = issueOf(rep, "FOC-901");
  check("conflicting: perIssue follows resolvedVerdict (final PASS, firstPassClean true — literal rule)",
    p?.review.finalVerdict === "PASS" && p?.review.firstPassClean === true,
    JSON.stringify(p?.review));
  check("conflicting: sum invariant", sumInvariant(rep.coverage));
}

// ── 1c. fixture: resumed_dev (FOC-902) ────────────────────────────────────────
// Structured-only task, FAIL round 1 → PASS round 2 in the same run; the work
// child's turn count (resumed session) rides on the rows.

{
  const dir = join(root, "fix-resumed_dev");
  const c = mkCorpus(dir);
  writeRun(c.sup, RUN.res, {
    verdicts: [
      rec({ taskId: "FOC-902", round: 1, childId: "review-3", verdict: "fail", findings: [{ id: "F1" }, { id: "F2" }] }),
      rec({ taskId: "FOC-902", round: 2, childId: "review-3", verdict: "pass", fingerprint: { combined: "aaaabbbbccccdddd" } }),
    ],
    children: {
      "dev-3": kid("dev-3", "dev", "FOC-902", {
        baseRevision: "cde3456789012",
        turns: [
          { startedAt: "2026-09-01T12:01:00.000Z", endedAt: "2026-09-01T12:40:00.000Z" },
          { startedAt: "2026-09-01T12:41:00.000Z", endedAt: null, reviewLoop: true },
        ],
      }),
    },
  });

  const rep = project(c);
  check("resumed_dev: coverage {2,0,2,0}",
    JSON.stringify(rep.coverage) === JSON.stringify({ logicalVerdicts: 2, matched: 0, unmatched: 0 + 2, ambiguous: 0 }),
    JSON.stringify(rep.coverage));
  check("resumed_dev: rounds stay separate, r1 before r2 (numeric)",
    rep.logicalVerdicts.length === 2
      && rep.logicalVerdicts[0].round === 1 && rep.logicalVerdicts[0].resolvedVerdict === "FAIL"
      && rep.logicalVerdicts[1].round === 2 && rep.logicalVerdicts[1].resolvedVerdict === "PASS",
    JSON.stringify(rep.logicalVerdicts.map((x) => [x.round, x.resolvedVerdict])));
  check("resumed_dev: no hints (same event, not cross-round corroboration)",
    rep.corroborationHints.length === 0, JSON.stringify(rep.corroborationHints));
  check("resumed_dev: rows carry run attempt + 2 workTurns",
    rep.evidenceRows.length === 2
      && rep.evidenceRows.every((r) => r.attempt === RUN.res && r.work.workTurns === 2 && r.work.baseRevision === "cde3456789012"),
    JSON.stringify(rep.evidenceRows.map((r) => [r.attempt, r.work.workTurns])));
  const p = issueOf(rep, "FOC-902");
  check("resumed_dev: perIssue final PASS, firstPassClean false, rounds 2",
    p?.review.finalVerdict === "PASS" && p?.review.firstPassClean === false && p?.review.rounds === 2,
    JSON.stringify(p?.review));
  check("resumed_dev: r1 has no fingerprint → workId null; r2 carries fp workId",
    logicalOf(rep, "FOC-902", "review", 1)?.work.workId === null
      && logicalOf(rep, "FOC-902", "review", 2)?.work.workId === "fp:aaaabbbbccccdddd");
}

// ── 1d. fixture: multi_round (FOC-903) ────────────────────────────────────────
// Two rounds, both stores agreeing per round → both cells matched; legacy
// aggregate (F1 byTask) rides along verbatim.

{
  const dir = join(root, "fix-multi_round");
  const c = mkCorpus(dir);
  writeRun(c.sup, RUN.multi, {
    verdicts: [
      rec({ taskId: "FOC-903", round: 1, childId: "review-4", verdict: "fail" }),
      rec({ taskId: "FOC-903", round: 2, childId: "review-4", verdict: "pass", fingerprint: { combined: "ddddeeeeffff0000" } }),
    ],
    children: {
      "review-4": kid("review-4", "review", "FOC-903", { telemetryRunId: "2026-09-01T13-01-00-000-review-9c03" }),
      "dev-4": kid("dev-4", "dev", "FOC-903", { baseRevision: "def4567890123", turns: [{}] }),
    },
  });
  writeReview(c.reviews, "FOC-903", 1, "FAIL", FAIL_BODY, "2026-09-01T13-01-00-000-review-9c03");
  writeReview(c.reviews, "FOC-903", 2, "PASS", PASS_BODY, "2026-09-01T13-01-00-000-review-9c03");

  const rep = project(c);
  check("multi_round: coverage {2,2,0,0}",
    JSON.stringify(rep.coverage) === JSON.stringify({ logicalVerdicts: 2, matched: 2, unmatched: 0, ambiguous: 0 }),
    JSON.stringify(rep.coverage));
  check("multi_round: both cells matched",
    logicalOf(rep, "FOC-903", "review", 1)?.coverageClass === "matched"
      && logicalOf(rep, "FOC-903", "review", 2)?.coverageClass === "matched");
  const p = issueOf(rep, "FOC-903");
  check("multi_round: perIssue final PASS, firstPassClean false, rounds 2",
    p?.review.finalVerdict === "PASS" && p?.review.firstPassClean === false && p?.review.rounds === 2,
    JSON.stringify(p?.review));
  const t = rep.legacyTaskOutcomes.find((x) => x.taskId === "FOC-903");
  check("multi_round: legacyTaskOutcomes verbatim F1 aggregate (FAIL→PASS, blockers 1, outcome PASS)",
    !!t && t.rounds === 2 && t.outcome === "PASS" && t.firstPassClean === false && t.blockers === 1
      && JSON.stringify(t.roundVerdicts) === JSON.stringify([{ round: 1, verdict: "FAIL" }, { round: 2, verdict: "PASS" }])
      && Array.isArray(t.qualityFlags) && t.qualityFlags.length === 0,
    JSON.stringify(t));
  check("multi_round: matched cells never hint", rep.corroborationHints.length === 0);
}

// ── 1e. fixture: absent_test (FOC-904) ────────────────────────────────────────
// No test stage, no gates, no reports: the three acceptance fields stay
// unknown and independent — no derived "done" key anywhere.

{
  const dir = join(root, "fix-absent_test");
  const c = mkCorpus(dir);
  writeRun(c.sup, RUN.dup.replace("ab12", "cc55"), {
    verdicts: [rec({ taskId: "FOC-904", round: 1, childId: "review-5", verdict: "pass", fingerprint: { combined: "9999888877776666" } })],
  });

  const rep = project(c);
  const p = issueOf(rep, "FOC-904");
  check("absent_test: perIssue key set exact (no derived acceptance fields)",
    !!p && JSON.stringify(Object.keys(p)) === JSON.stringify(
      ["issue", "review", "testAcceptance", "testAcceptanceArtifacts", "humanAcceptance", "humanAcceptanceTraces", "testReportArtifacts"]),
    JSON.stringify(p ? Object.keys(p) : null));
  check("absent_test: testAcceptance unknown, humanAcceptance unknown",
    p?.testAcceptance === "unknown" && p?.humanAcceptance === "unknown");
  check("absent_test: all artifact surfaces empty",
    p?.testAcceptanceArtifacts.length === 0 && p?.humanAcceptanceTraces.length === 0 && p?.testReportArtifacts.length === 0,
    JSON.stringify([p?.testAcceptanceArtifacts, p?.humanAcceptanceTraces, p?.testReportArtifacts]));
  check("absent_test: coverage {1,0,1,0}",
    JSON.stringify(rep.coverage) === JSON.stringify({ logicalVerdicts: 1, matched: 0, unmatched: 1, ambiguous: 0 }),
    JSON.stringify(rep.coverage));
}

// ── 1f. fixture: stable_rerun (x2, mirrored creation order) ──────────────────
// One corpus covering gates (Done + answered), a test-stage FAIL, test-report
// txt mapping (exact + longest-prefix), orphan report, broken gate JSON, a
// non-Linear legacy id, and cross-round corroboration — written twice into
// two dirs with mirrored creation order. Content identical; the report must
// be byte-identical across both dirs and across child processes.

const STABLE = {
  decoy: "0000-decoy-run",
  gates: [
    ["test-accept.json", {
      gateId: "test.accept-1", taskId: "FOC-905", status: "answered",
      facts: { testState: "Done" }, answer: { text: "Looks good; done.", answeredAt: "2026-09-01T15:00:00.000Z" },
    }],
    ["plan-gate.json", {
      gateId: "plan.approve-1", taskId: "FOC-905", status: "answered",
      facts: {}, answer: { text: "ok", answeredAt: "2026-09-01T14:30:00.000Z" },
    }],
  ],
  verdicts: [
    rec({ taskId: "FOC-905", round: 1, childId: "review-6", verdict: "pass", fingerprint: { combined: "eeee111122223333" } }),
    rec({ taskId: "FOC-905", round: 2, childId: "review-6", verdict: "pass", fingerprint: { combined: "ffff111122223333" } }),
    rec({ taskId: "FOC-226", round: 1, squad: "test", childId: "test-9", verdict: "fail", recordedAt: "2026-09-01T14:20:00.000Z" }),
  ],
  reports: [
    ["test-9-slice-verdict.txt", "TEST REPORT — FOC-905 — slice run\nall cases green except one known flake\n"],
    ["zombie-1-verdict.txt", "orphan report — no matching child\n"],
  ],
  children: {
    "review-6": kid("review-6", "review", "FOC-905"),
    "test-9": kid("test-9", "test", "FOC-905"),
    "dev-9": kid("dev-9", "dev", "FOC-905", { baseRevision: "efa9876543210", turns: [{}, {}] }),
    "dev-6": kid("dev-6", "dev", "FOC-226", { turns: [{}] }),
  },
};

function writeStableCorpus(base, order) {
  const c = mkCorpus(base);
  const rev = order === "forward" ? (arr) => arr : (arr) => [...arr].reverse();
  if (order === "forward") {
    writeDecoyRun(c.sup);
    writeRun(c.sup, RUN.stable, {
      verdicts: rev(STABLE.verdicts),
      gates: rev(STABLE.gates),
      reports: rev(STABLE.reports),
      children: STABLE.children,
    });
  } else {
    writeRun(c.sup, RUN.stable, {
      verdicts: rev(STABLE.verdicts),
      gates: rev(STABLE.gates),
      reports: rev(STABLE.reports),
      children: STABLE.children,
    });
    writeDecoyRun(c.sup);
  }
  // Legacy reviews: a non-Linear task id, UNKNOWN verdict, no Run line.
  writeReview(c.reviews, "_prompt", 1, "UNKNOWN", UNKNOWN_BODY);
  return c;
}
function writeDecoyRun(supRoot) {
  // A run dir that sorts FIRST, with a non-JSON verdicts file, a broken gate
  // JSON and a taskless gate: all three must degrade to deterministic
  // anomalies, never a crash.
  writeRun(supRoot, STABLE.decoy, {
    extra: { "verdicts/not-a-verdict.txt": "decoy — not json" },
    gates: [["notask.json", { gateId: "decoy.gate-1", status: "pending", facts: {} }]],
    children: {},
  });
  const gDir = join(supRoot, STABLE.decoy, "gates");
  mkdirSync(gDir, { recursive: true });
  writeFileSync(join(gDir, "broken.json"), "{not json", "utf8"); // raw, unparsable
}

const dirA = join(root, "stable-a");
const dirB = join(root, "stable-b");
const corpusA = writeStableCorpus(dirA, "forward");
const corpusB = writeStableCorpus(dirB, "reverse");

{
  const rep = project(corpusA);
  check("stable_rerun: coverage {4,0,4,0}",
    JSON.stringify(rep.coverage) === JSON.stringify({ logicalVerdicts: 4, matched: 0, unmatched: 4, ambiguous: 0 }),
    JSON.stringify(rep.coverage));
  check("stable_rerun: cross-round corroboration hint (same run, PASS, r1+r2)",
    JSON.stringify(rep.corroborationHints) === JSON.stringify([
      { issue: "FOC-905", attempt: RUN.stable, verdict: "PASS", cells: [{ stage: "review", round: 1 }, { stage: "review", round: 2 }] },
    ]),
    JSON.stringify(rep.corroborationHints));
  const p905 = issueOf(rep, "FOC-905");
  check("stable_rerun: Done gate wins over test FAIL cell → testAcceptance pass (decision 2026-09-07, FOC-225 literal)",
    p905?.testAcceptance === "pass" && p905?.testAcceptanceArtifacts.length === 1
      && p905?.testAcceptanceArtifacts[0].gateId === "test.accept-1" && p905?.testAcceptanceArtifacts[0].testState === "Done",
    JSON.stringify([p905?.testAcceptance, p905?.testAcceptanceArtifacts]));
  check("stable_rerun: both answered gates traced",
    p905?.humanAcceptanceTraces.length === 2
      && p905?.humanAcceptanceTraces.every((t) => t.answeredAt !== null),
    JSON.stringify(p905?.humanAcceptanceTraces));
  check("stable_rerun: test-report txt linked via longest-prefix childId match",
    p905?.testReportArtifacts.length === 1 && p905?.testReportArtifacts[0].path === `supervisor/${RUN.stable}/test-9-slice-verdict.txt`,
    JSON.stringify(p905?.testReportArtifacts));
  const p226 = issueOf(rep, "FOC-226");
  check("stable_rerun: test-stage FAIL without gates → testAcceptance fail",
    p226?.testAcceptance === "fail", JSON.stringify(p226?.testAcceptance));
  const pPrompt = issueOf(rep, "_prompt");
  check("stable_rerun: non-Linear legacy id flagged, unknown acceptance",
    !!pPrompt && pPrompt.testAcceptance === "unknown"
      && JSON.stringify(rep.legacyTaskOutcomes.find((t) => t.taskId === "_prompt")?.qualityFlags) === JSON.stringify(["non-linear-id"]),
    JSON.stringify(rep.legacyTaskOutcomes));
  check("stable_rerun: legacy unsupervised pseudo-attempt on _prompt row",
    rowOf(rep, "_prompt", "legacy", 1)?.attempt === "unsupervised:_prompt",
    rowOf(rep, "_prompt", "legacy", 1)?.attempt);
  const reasons = rep.anomalies.map((a) => a.reason).sort();
  check("stable_rerun: deterministic anomaly set (broken gate JSON + taskless gate + orphan report)",
    JSON.stringify(reasons) === JSON.stringify(["gate-no-task", "gate-parse-error", "test-report-no-task"]),
    JSON.stringify(rep.anomalies));
  check("stable_rerun: FOC-226 row keeps record stage test, logical stays test",
    rowOf(rep, "FOC-226", "structured", 1)?.stage === "test" && logicalOf(rep, "FOC-226", "test", 1)?.stage === "test");
  check("stable_rerun: sum invariant", sumInvariant(rep.coverage));
  check("stable_rerun: key-order guard", JSON.stringify(rep) === JSON.stringify(rebuildReport(rep)));
}

// ── 3. idempotency: two child processes × two creation-order variants ─────────

{
  const cliEnv = { ...process.env, LA_TELEMETRY_DB: join(root, "no-such-db.sqlite") };
  const runCli = (dir) => {
    const r = spawnSync(process.execPath, [CLI, "--json", "--supervisor-root", join(dir, "supervisor"), "--reviews-dir", join(dir, "reviews")],
      { encoding: "utf8", env: cliEnv });
    if (r.status !== 0) throw new Error(`CLI exit ${r.status}: ${String(r.stderr).slice(0, 300)}`);
    return JSON.parse(r.stdout);
  };
  const hashes = {};
  for (const [label, dir] of [["stable-a#1", dirA], ["stable-a#2", dirA], ["stable-b#1", dirB], ["stable-b#2", dirB]]) {
    hashes[label] = sha256(JSON.stringify(runCli(dir)));
  }
  const uniq = [...new Set(Object.values(hashes))];
  check("stable_rerun: sha256(report) identical across 2 child processes × 2 creation orders",
    uniq.length === 1, JSON.stringify(hashes, null, 1));

  // Module/CLI parity: in-process projection over stable-a equals the CLI's
  // report (defaults resolved the same way; dbPath null ≡ pinned-missing db).
  const inProc = project({ sup: join(dirA, "supervisor"), reviews: join(dirA, "reviews") });
  check("stable_rerun: in-process projection equals CLI report byte-for-byte",
    sha256(JSON.stringify(inProc)) === hashes["stable-a#1"]);
}

// ── 2. pure buildLogicalVerdicts unit cases ───────────────────────────────────

const mkRow = (over = {}) => ({
  issue: "FXT-1", stage: "review", source: "structured", attempt: "run-x", round: 1,
  verdict: "PASS", rawVerdict: "pass", unknownReasons: [], qualityFlags: [], childId: "review-1",
  work: { workId: "fp:a1b2c3d4e5f6", fingerprint: "a1b2c3d4e5f6", baseRevision: null, reviewRunId: null, workTurns: null },
  artifacts: [{ kind: "verdict-json", path: "supervisor/run-x/verdicts/FXT-1-round1.json", sha256: "0123456789ab" }],
  recordedAt: null, findings: [], acMapping: [], evidenceLine: null, conflictingEvidence: null,
  ...over,
});
const legacy = (over = {}) => mkRow({ source: "legacy", rawVerdict: over.verdict || "PASS", childId: null, work: { workId: null, fingerprint: null, baseRevision: null, reviewRunId: null, workTurns: null }, ...over });

console.log("\n# buildLogicalVerdicts units\n");

{
  const empty = buildLogicalVerdicts([]);
  check("unit: empty input → zero coverage, no anomalies",
    sumInvariant(empty.coverage) && empty.coverage.logicalVerdicts === 0 && empty.anomalies.length === 0
      && empty.logicalVerdicts.length === 0 && empty.corroborationHints.length === 0,
    JSON.stringify(empty));

  const rows = [
    mkRow({ round: 1, verdict: "PASS", rawVerdict: "pass" }),
    legacy({ round: 1, verdict: "PASS", rawVerdict: "PASS" }),
  ];
  const a = buildLogicalVerdicts(rows);
  const b = buildLogicalVerdicts(rows);
  check("unit: deterministic — same rows, same output", JSON.stringify(a) === JSON.stringify(b));
  check("unit: agreeing structured+legacy → matched, resolution null",
    a.logicalVerdicts.length === 1 && a.logicalVerdicts[0].coverageClass === "matched"
      && a.logicalVerdicts[0].resolution === null && a.logicalVerdicts[0].conflict === null
      && a.logicalVerdicts[0].resolvedVerdict === "PASS",
    JSON.stringify(a.logicalVerdicts));
  check("unit: matched cell artifacts = both sides, structured first",
    a.logicalVerdicts[0].artifacts.length === 2 && a.logicalVerdicts[0].sources[0] === "structured");
  check("unit: sum invariant", sumInvariant(a.coverage));
}

{
  // Same source never matches itself.
  const r = buildLogicalVerdicts([
    mkRow({ attempt: "run-1", verdict: "PASS", rawVerdict: "pass" }),
    mkRow({ attempt: "run-2", verdict: "PASS", rawVerdict: "pass" }),
  ]);
  check("unit: two structured runs agreeing → still unmatched",
    r.logicalVerdicts.length === 1 && r.logicalVerdicts[0].coverageClass === "unmatched"
      && JSON.stringify(r.logicalVerdicts[0].sources) === JSON.stringify(["structured"]),
    JSON.stringify(r.logicalVerdicts));
  // Both attempts land in ONE cell (same round) — hints are cell-based
  // (same issue + attempt + verdict, ≥2 cells), so no hint here. Verified by
  // the cross-round unit below, where two cells share an attempt.
  check("unit: same-cell multi-attempt duplicate → no hint (hints are cell-based)",
    r.corroborationHints.length === 0,
    JSON.stringify(r.corroborationHints));
}

{
  // Decided + UNKNOWN in one cell → matched with evidence-asymmetry.
  const r = buildLogicalVerdicts([
    mkRow({ verdict: "FAIL", rawVerdict: "fail" }),
    legacy({ verdict: "UNKNOWN", rawVerdict: "UNKNOWN" }),
  ]);
  check("unit: decided + UNKNOWN → matched with evidence-asymmetry",
    r.logicalVerdicts.length === 1 && r.logicalVerdicts[0].coverageClass === "matched"
      && r.logicalVerdicts[0].resolution === "evidence-asymmetry"
      && r.logicalVerdicts[0].resolvedVerdict === "FAIL" && r.logicalVerdicts[0].conflict === null,
    JSON.stringify(r.logicalVerdicts));
}

{
  // Conflict: input order must not matter; structured side decides; native case.
  const forward = buildLogicalVerdicts([
    mkRow({ verdict: "PASS", rawVerdict: "pass" }),
    legacy({ verdict: "FAIL", rawVerdict: "FAIL" }),
  ]);
  const backward = buildLogicalVerdicts([
    legacy({ verdict: "FAIL", rawVerdict: "FAIL" }),
    mkRow({ verdict: "PASS", rawVerdict: "pass" }),
  ]);
  const ok = (r) => r.logicalVerdicts.length === 1 && r.logicalVerdicts[0].coverageClass === "ambiguous"
    && r.logicalVerdicts[0].resolvedVerdict === "PASS"
    && JSON.stringify(r.logicalVerdicts[0].conflict) === JSON.stringify({ resolvedBy: "supervisor-precedence", sides: { structured: "pass", legacy: "FAIL" } });
  check("unit: ambiguous resolved by structured side (forward input)", ok(forward), JSON.stringify(forward.logicalVerdicts));
  check("unit: ambiguous resolved by structured side (legacy row first)", ok(backward), JSON.stringify(backward.logicalVerdicts));
  check("unit: source-conflict anomaly emitted",
    forward.anomalies.some((x) => x.reason === "source-conflict") && JSON.stringify(forward) === JSON.stringify(backward));
}

{
  // Cross-round: never merged; corroborates only as a hint (joined attempt).
  const r = buildLogicalVerdicts([
    mkRow({ round: 1, verdict: "PASS", rawVerdict: "pass" }),
    legacy({ round: 2, verdict: "PASS", rawVerdict: "PASS" }),
  ]);
  check("unit: cross-round same verdict → 2 unmatched logicals",
    r.logicalVerdicts.length === 2 && r.logicalVerdicts.every((l) => l.coverageClass === "unmatched"),
    JSON.stringify(r.logicalVerdicts.map((l) => [l.round, l.coverageClass])));
  check("unit: hint ties the rounds (issue, attempt, verdict, both cells)",
    JSON.stringify(r.corroborationHints) === JSON.stringify([
      { issue: "FXT-1", attempt: "run-x", verdict: "PASS", cells: [{ stage: "review", round: 1 }, { stage: "review", round: 2 }] },
    ]),
    JSON.stringify(r.corroborationHints));
}

{
  // The unsupervised pseudo-attempt never corroborates.
  const r = buildLogicalVerdicts([
    mkRow({ round: 1, attempt: "unsupervised:FXT-1", verdict: "PASS", rawVerdict: "pass" }),
    legacy({ round: 2, attempt: "unsupervised:FXT-1", verdict: "PASS", rawVerdict: "PASS" }),
  ]);
  check("unit: unsupervised fallback excluded from hints",
    r.logicalVerdicts.length === 2 && r.corroborationHints.length === 0,
    JSON.stringify(r.corroborationHints));
}

{
  // Numeric round sort: 2 before 10 (no lexicographic flip).
  const r = buildLogicalVerdicts([
    mkRow({ round: 10, verdict: "FAIL", rawVerdict: "fail" }),
    mkRow({ round: 2, verdict: "PASS", rawVerdict: "pass" }),
  ]);
  check("unit: rounds sort numerically",
    JSON.stringify(r.logicalVerdicts.map((l) => l.round)) === JSON.stringify([2, 10]),
    JSON.stringify(r.logicalVerdicts.map((l) => l.round)));
}

{
  // UNKNOWN-only cell.
  const r = buildLogicalVerdicts([legacy({ verdict: "UNKNOWN", rawVerdict: "UNKNOWN" })]);
  check("unit: UNKNOWN-only cell → unmatched UNKNOWN",
    r.logicalVerdicts.length === 1 && r.logicalVerdicts[0].coverageClass === "unmatched"
      && r.logicalVerdicts[0].resolvedVerdict === "UNKNOWN",
    JSON.stringify(r.logicalVerdicts));
  check("unit: sum invariant", sumInvariant(r.coverage));
}

{
  // cross-stage-recording: review-shaped record from a non-review squad joins
  // the review cells; a plain test record stays in test.
  const r = buildLogicalVerdicts([
    mkRow({ stage: "test", qualityFlags: ["cross-stage-recording"], verdict: "PASS", rawVerdict: "pass" }),
    legacy({ verdict: "PASS", rawVerdict: "PASS" }),
    mkRow({ issue: "FXT-2", stage: "test", verdict: "FAIL", rawVerdict: "fail" }),
  ]);
  check("unit: flagged record rolls up to review; plain test record does not",
    logicalOf({ logicalVerdicts: r.logicalVerdicts }, "FXT-1", "review", 1)?.coverageClass === "matched"
      && logicalOf({ logicalVerdicts: r.logicalVerdicts }, "FXT-2", "test", 1)?.coverageClass === "unmatched",
    JSON.stringify(r.logicalVerdicts.map((l) => [l.issue, l.stage, l.coverageClass])));
  // The flagged ROW keeping its own record-stage ("test") is asserted by the
  // stable_rerun fixture (rowOf FOC-226 + logicalOf).
}

// ── degraded empty shape (server-route contract) ─────────────────────────────
// The /api/verdict-evidence route serves exactly this when .state/ is absent:
// valid, all-zero, no throws.

{
  const rep = projectVerdictEvidence({
    supervisorRoot: join(root, "no-such-supervisor"),
    reviewsDir: join(root, "no-such-reviews"),
    roundsPath: join(root, "no-such-rounds.json"),
    dbPath: null,
  });
  check("degraded: absent .state/ → valid all-zero shape",
    JSON.stringify(rep.coverage) === JSON.stringify({ logicalVerdicts: 0, matched: 0, unmatched: 0, ambiguous: 0 })
      && rep.evidenceRows.length === 0 && rep.logicalVerdicts.length === 0 && rep.perIssue.length === 0
      && rep.corroborationHints.length === 0 && rep.legacyTaskOutcomes.length === 0
      && rep.delegations.available === false,
    JSON.stringify(rep.coverage));
  check("degraded: sum invariant holds on empty shape", sumInvariant(rep.coverage));
}

// ── 4. key-order guard helper ─────────────────────────────────────────────────
// Rebuilds the report with literal schema key order (design §4.6). The report
// must serialize identically — catches accidental raw-JSON spread, added or
// dropped keys, and key-order drift on every consumer-facing surface.

function rebuildReport(r) {
  return {
    coverage: {
      logicalVerdicts: r.coverage.logicalVerdicts,
      matched: r.coverage.matched,
      unmatched: r.coverage.unmatched,
      ambiguous: r.coverage.ambiguous,
    },
    evidenceRows: r.evidenceRows.map((w) => ({
      issue: w.issue,
      stage: w.stage,
      source: w.source,
      attempt: w.attempt,
      round: w.round,
      verdict: w.verdict,
      rawVerdict: w.rawVerdict,
      unknownReasons: w.unknownReasons,
      qualityFlags: w.qualityFlags,
      childId: w.childId,
      work: {
        workId: w.work.workId,
        fingerprint: w.work.fingerprint,
        baseRevision: w.work.baseRevision,
        reviewRunId: w.work.reviewRunId,
        workTurns: w.work.workTurns,
      },
      artifacts: w.artifacts.map((a) => ({ kind: a.kind, path: a.path, sha256: a.sha256 })),
      recordedAt: w.recordedAt,
      findings: w.findings,
      acMapping: w.acMapping,
      evidenceLine: w.evidenceLine && { line: w.evidenceLine.line, lineNo: w.evidenceLine.lineNo, anchor: w.evidenceLine.anchor },
      conflictingEvidence: w.conflictingEvidence && w.conflictingEvidence.map((c) => ({ line: c.line, lineNo: c.lineNo, anchor: c.anchor })),
    })),
    logicalVerdicts: r.logicalVerdicts.map((l) => ({
      issue: l.issue,
      stage: l.stage,
      round: l.round,
      attempt: l.attempt,
      resolvedVerdict: l.resolvedVerdict,
      coverageClass: l.coverageClass,
      resolution: l.resolution,
      conflict: l.conflict && { resolvedBy: l.conflict.resolvedBy, sides: { structured: l.conflict.sides.structured, legacy: l.conflict.sides.legacy } },
      work: { workId: l.work.workId },
      qualityFlags: l.qualityFlags,
      sources: l.sources,
      artifacts: l.artifacts.map((a) => ({ kind: a.kind, path: a.path, sha256: a.sha256 })),
    })),
    perIssue: r.perIssue.map((p) => ({
      issue: p.issue,
      review: { finalVerdict: p.review.finalVerdict, firstPassClean: p.review.firstPassClean, rounds: p.review.rounds },
      testAcceptance: p.testAcceptance,
      testAcceptanceArtifacts: p.testAcceptanceArtifacts.map((a) => ({ kind: a.kind, path: a.path, sha256: a.sha256, gateId: a.gateId, testState: a.testState })),
      humanAcceptance: p.humanAcceptance,
      humanAcceptanceTraces: p.humanAcceptanceTraces.map((a) => ({ kind: a.kind, path: a.path, sha256: a.sha256, gateId: a.gateId, answeredAt: a.answeredAt })),
      testReportArtifacts: p.testReportArtifacts.map((a) => ({ kind: a.kind, path: a.path, sha256: a.sha256 })),
    })),
    corroborationHints: r.corroborationHints.map((h) => ({
      issue: h.issue,
      attempt: h.attempt,
      verdict: h.verdict,
      cells: h.cells.map((c) => ({ stage: c.stage, round: c.round })),
    })),
    // Anomaly objects are free-form (reason + context); passed through as-is.
    anomalies: r.anomalies,
    legacyTaskOutcomes: r.legacyTaskOutcomes.map((t) => ({
      taskId: t.taskId,
      rounds: t.rounds,
      blockers: t.blockers,
      issues: t.issues,
      returned: t.returned,
      firstPassClean: t.firstPassClean,
      outcome: t.outcome,
      unknownReasons: t.unknownReasons,
      roundVerdicts: t.roundVerdicts.map((rv) => ({ round: rv.round, verdict: rv.verdict })),
      evidence: t.evidence && { line: t.evidence.line, lineNo: t.evidence.lineNo, anchor: t.evidence.anchor },
      ...(t.roundsOnly ? { roundsOnly: t.roundsOnly } : {}),
      qualityFlags: t.qualityFlags,
    })),
    delegations: {
      available: r.delegations.available,
      attribution: r.delegations.attribution,
      attributionNote: r.delegations.attributionNote,
      byTask: r.delegations.byTask,
    },
  };
}

// ── 5. real-corpus read-only A/B (skipped without the main checkout) ──────────

function mainCheckoutRoot() {
  const r = spawnSync("git", ["worktree", "list", "--porcelain"], { cwd: join(__dirname, ".."), encoding: "utf8" });
  if (r.status !== 0) return null;
  const m = r.stdout.match(/^worktree (.+)$/m); // the main worktree is listed first
  return m ? m[1] : null;
}

console.log("\n# real-corpus A/B\n");
const mainRoot = mainCheckoutRoot();
const supDir = mainRoot ? join(mainRoot, ".state", "supervisor") : null;
const revDir = mainRoot ? join(mainRoot, ".state", "reviews") : null;

if (mainRoot && supDir && revDir && existsSync(supDir) && existsSync(revDir)) {
  // Hermetic: pin dbPath to a nonexistent file so the machine's telemetry DB
  // (and anything machine-local) never leaks into the assertion.
  const rep = projectVerdictEvidence({
    supervisorRoot: supDir,
    reviewsDir: revDir,
    roundsPath: join(mainRoot, ".state", "review-rounds.json"),
    dbPath: join(root, "no-such-db.sqlite"),
  });

  check("real-corpus: coverage baseline {118, 11, 104, 3}",
    JSON.stringify(rep.coverage) === JSON.stringify({ logicalVerdicts: 118, matched: 11, unmatched: 104, ambiguous: 3 }),
    JSON.stringify(rep.coverage));
  check("real-corpus: sum invariant", sumInvariant(rep.coverage));

  const amb = new Map(rep.logicalVerdicts.filter((l) => l.coverageClass === "ambiguous")
    .map((l) => [`${l.issue}|${l.stage}|${l.round}`, l.conflict.sides]));
  check("real-corpus: exactly 3 ambiguous cells, supervisor-precedence, both sides named",
    amb.size === 3
      && JSON.stringify(amb.get("FOC-151|review|2")) === JSON.stringify({ structured: "pass", legacy: "FAIL" })
      && JSON.stringify(amb.get("FOC-151|review|3")) === JSON.stringify({ structured: "fail", legacy: "PASS" })
      && JSON.stringify(amb.get("FOC-156|review|1")) === JSON.stringify({ structured: "pass", legacy: "FAIL" })
      && rep.logicalVerdicts.filter((l) => l.coverageClass === "ambiguous").every((l) => l.conflict.resolvedBy === "supervisor-precedence"),
    JSON.stringify([...amb], null, 1));

  const r142legacy = rep.evidenceRows.filter((r) => r.issue === "FOC-142" && r.source === "legacy");
  check("real-corpus: FOC-142 legacy attempt resolves via reviewRunId join to run 2d75",
    r142legacy.length === 2 && r142legacy.every((r) =>
      r.attempt === "2026-08-27T06-45-08-262-supervisor-2d75"
      && r.work.reviewRunId === "2026-08-27T08-08-45-487-review-63bc"),
    JSON.stringify(r142legacy.map((r) => [r.round, r.attempt, r.work.reviewRunId])));
  const l142r1 = logicalOf(rep, "FOC-142", "review", 1);
  check("real-corpus: FOC-142 r1 decided + UNKNOWN → matched, evidence-asymmetry",
    l142r1?.coverageClass === "matched" && l142r1?.resolution === "evidence-asymmetry",
    JSON.stringify(l142r1));

  const r211 = rep.evidenceRows.find((r) => r.issue === "FOC-211" && r.source === "legacy");
  check("real-corpus: FOC-211 legacy row carries unsupervised pseudo-attempt",
    r211?.attempt === "unsupervised:FOC-211", r211?.attempt);

  const srow151 = rowOf(rep, "FOC-151", "structured", 2);
  const l151 = logicalOf(rep, "FOC-151", "review", 2);
  check("real-corpus: FOC-151 r2 cross-stage recording — row stays test, rolls up to review, flagged",
    srow151?.stage === "test" && srow151?.qualityFlags.includes("cross-stage-recording")
      && l151?.stage === "review" && l151?.coverageClass === "ambiguous"
      && typeof l151?.work.workId === "string" && l151.work.workId.startsWith("fp:"),
    JSON.stringify([srow151?.stage, srow151?.qualityFlags, l151?.stage, l151?.coverageClass, l151?.work.workId]));

  check("real-corpus: hermetic — delegations unavailable with pinned-missing dbPath",
    rep.delegations.available === false && rep.delegations.attribution === "weak");
  check("real-corpus: read-only A/B leaves no artifacts (sha12 digests only, paths .state-relative)",
    rep.evidenceRows.every((r) => r.artifacts.every((a) => isSha12(a.sha256)))
      && rep.evidenceRows.every((r) => r.artifacts.every((a) => !a.path.includes("\\") && (a.path.startsWith("supervisor/") || a.path.startsWith("reviews/")))));
} else {
  results.skip++;
  console.log(`  SKIP real-corpus A/B — main checkout .state not found (mainRoot=${mainRoot || "unknown"})`);
}

// ── wrap up ───────────────────────────────────────────────────────────────────

// Temp cleanup — best effort on Windows (EBUSY possible); leftovers reported.
try {
  rmSync(root, { recursive: true, force: true });
} catch (error) {
  console.error(`note: temp dir left behind (${root}): ${error?.message || error}`);
}

console.log(`\n${results.pass} passed, ${results.fail} failed${results.skip ? `, ${results.skip} skipped` : ""} (verdict-evidence)`);
if (failures.length) {
  console.error("\nfailures:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
