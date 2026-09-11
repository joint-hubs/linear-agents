#!/usr/bin/env node
/**
 * scripts/verdict-evidence.mjs — unify Supervisor and legacy verdict evidence
 * with round lineage (FOC-219).
 *
 * Two evidence stores describe the same review pipeline and never met:
 *   .state/supervisor/<runId>/verdicts/*.json  — structured verdicts (74 files /
 *       37 tasks in the FOC-219 corpus survey), schema-enforced, fingerprinted;
 *   .state/reviews/<taskId>-round<N>.md        — legacy round files (58 files /
 *       42 tasks), regex-parsed prose, classified by FOC-218's anchored
 *       allowlist (scripts/delegation-outcomes.mjs, reused verbatim here).
 *
 * This module projects both into one pure report — no ingestion state, no DB
 * writes, no mutation of anything under .state/ (FOC-219 hard rule: the
 * projection is a function of file contents; re-running it over the same
 * corpus is bit-identical by construction):
 *
 *   evidenceRows      — one row per source record, unique at
 *                       (issue, stage, source, attempt, round); stage is
 *                       derived per record from squad/childId, never assumed;
 *   logicalVerdicts   — the DoD tuple, unique at (issue, stage, round), with
 *                       resolvedVerdict / coverageClass / conflict / work and
 *                       every retained artifact from BOTH sides;
 *   coverage          — matched + unmatched + ambiguous === logicalVerdicts;
 *   perIssue          — REVIEW pass ≠ final TEST pass ≠ human acceptance
 *                       (three fields, never coalesced, no derived "done");
 *   corroborationHints— cross-round same-event candidates, hint-only;
 *   delegations       — optional telemetry axis (run_task_links join reused
 *                       from F1), attribution: "weak", cost-free.
 *
 * Rollup grouping note (verified against the design baseline on the real
 * corpus): a non-review-squad record whose body is review-shaped
 * (acMapping.length > 0 — e.g. FOC-151 r2, recorded by childId test-4) rolls
 * up at the review stage with qualityFlags ["cross-stage-recording"]; the row
 * keeps the stage as recorded. Without this, FOC-151 r2 could not meet its
 * legacy round 2 and the design's §4.6 baseline (118/11/104/3, FOC-151 r2
 * ambiguous with both sides named) would not reproduce.
 *
 * Usage:
 *   node scripts/verdict-evidence.mjs --json
 *   node scripts/verdict-evidence.mjs --json --supervisor-root <dir> --reviews-dir <dir>
 *
 * Read-only. Telemetry DB (optional delegation axis) opened read-only via
 * LA_TELEMETRY_DB or the same default path delegation-outcomes.mjs resolves.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { loadReviews, aggregateOutcomes, delegationsByTask } from "./delegation-outcomes.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SUPERVISOR_ROOT = join(ROOT, ".state", "supervisor");
const DEFAULT_REVIEWS = join(ROOT, ".state", "reviews");
const DEFAULT_ROUNDS = join(ROOT, ".state", "review-rounds.json");
// Same resolution as delegation-outcomes.mjs (LA_TELEMETRY_DB env seam) so both
// surfaces read the same telemetry store.
const DEFAULT_DB = process.env.LA_TELEMETRY_DB
  || join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"),
          "linear-agents", "telemetry", "telemetry.sqlite");

const DELEGATION_NOTE = "correlation, not causal credit — telemetry run_task_links (role=primary) via delegation-outcomes.delegationsByTask; cost and token volume deliberately omitted";

const sha12 = (content) => createHash("sha256").update(content).digest("hex").slice(0, 12);
const LINEAR_ID_RE = /^[A-Z]{2,10}-\d+$/;
const ARTIFACT_PATH_RE = /-verdict\.txt$/i;

/** Structured verdicts are lowercase pass|fail; legacy parseReview is uppercase. */
function normalizeVerdict(v) {
  return v === "pass" ? "PASS" : v === "fail" ? "FAIL" : "UNKNOWN";
}

/**
 * children.json shape (verified on the corpus): {runId, children: {childId:
 * {childId, squad, taskId, sessionId, status, tee, turns[], costUsd,
 * telemetryRunId, baseRevision, ...}}}. A missing/unparseable file is an
 * attempt-resolution fallback, not a failure (design §4.2).
 */
function readRunChildren(supervisorRoot, runId) {
  const p = join(supervisorRoot, runId, "children.json");
  if (!existsSync(p)) return { children: [], parseError: null };
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    const kids = parsed && typeof parsed === "object" && parsed.children && typeof parsed.children === "object"
      ? Object.values(parsed.children)
      : Array.isArray(parsed) ? parsed : [];
    return { children: kids.filter((c) => c && typeof c === "object"), parseError: null };
  } catch (error) {
    return { children: [], parseError: String(error?.message || error) };
  }
}

/** Work child for a record: same run + same task; DEV child first, then childId sort. */
function resolveWorkChild(children, taskId) {
  const matches = children.filter((c) => c.taskId === taskId);
  if (!matches.length) return null;
  const sorted = [...matches].sort((a, b) => String(a.childId).localeCompare(String(b.childId)));
  return sorted.find((c) => c.squad === "dev") || sorted[0];
}

/**
 * Rollup stage inside buildLogicalVerdicts: a review-shaped record recorded
 * from a non-review squad joins the review cells (see module header); the
 * record's own stage stays on the row.
 */
function groupStageOf(row) {
  return row.qualityFlags.includes("cross-stage-recording") ? "review" : row.stage;
}

const SOURCE_ORDER = { structured: 0, legacy: 1 };

function rowSort(a, b) {
  return (SOURCE_ORDER[a.source] ?? 2) - (SOURCE_ORDER[b.source] ?? 2)
    || String(a.attempt).localeCompare(String(b.attempt))
    || (a.round ?? -1) - (b.round ?? -1);
}

/**
 * Fold evidence rows into logical verdicts (design §4.3). Pure: same rows →
 * same output. One row per source per cell; agreeing sources = matched; a
 * decided conflict = ambiguous (resolvedVerdict by supervisor-precedence,
 * both sides retained); decided + UNKNOWN = matched with resolution
 * "evidence-asymmetry". No cross-round merging — same-event rounds stay
 * separate logical verdicts and surface only as corroborationHints.
 */
export function buildLogicalVerdicts(evidenceRows) {
  const grouped = new Map();
  for (const row of evidenceRows) {
    const stage = groupStageOf(row);
    const key = `${row.issue}|${stage}|${row.round === null ? "~" : row.round}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }

  const logicalVerdicts = [];
  const anomalies = [];
  // (issue, attempt, verdict) -> cells, unmatched-only — the hint surface.
  const hints = new Map();

  for (const key of [...grouped.keys()].sort()) {
    const rows = grouped.get(key).sort(rowSort);
    const issue = rows[0].issue;
    const stage = groupStageOf(rows[0]);
    const round = rows[0].round;
    const sources = [...new Set(rows.map((r) => r.source))].sort((a, b) => (SOURCE_ORDER[a] ?? 2) - (SOURCE_ORDER[b] ?? 2));
    const decided = rows.filter((r) => r.verdict === "PASS" || r.verdict === "FAIL");
    const decidedSet = new Set(decided.map((r) => r.verdict));
    const structuredSide = rows.filter((r) => r.source === "structured");
    const legacySide = rows.filter((r) => r.source === "legacy");
    const firstDecided = (side) => side.find((r) => r.verdict === "PASS" || r.verdict === "FAIL") || null;

    let resolvedVerdict;
    let coverageClass;
    let resolution = null;
    let conflict = null;
    if (decidedSet.size > 1) {
      // Decided conflict. Supervisor-precedence (design §4.3 option A, Mateusz
      // 2026-09-07): the structured side decides resolvedVerdict when it has a
      // decided row; sides carry each source's verdict AS RECORDED (structured
      // lowercase, legacy uppercase — design §4.6).
      coverageClass = "ambiguous";
      resolvedVerdict = (firstDecided(structuredSide) || firstDecided(legacySide)).verdict;
      const sRaw = [...new Set(structuredSide.filter((r) => r.verdict === "PASS" || r.verdict === "FAIL").map((r) => r.rawVerdict))].join("|");
      const lRaw = [...new Set(legacySide.filter((r) => r.verdict === "PASS" || r.verdict === "FAIL").map((r) => r.rawVerdict))].join("|");
      conflict = { resolvedBy: "supervisor-precedence", sides: { structured: sRaw || null, legacy: lRaw || null } };
      anomalies.push({ reason: "source-conflict", issue, stage, round, sides: conflict.sides });
    } else if (sources.length > 1) {
      coverageClass = "matched";
      resolvedVerdict = decided.length ? decided[0].verdict : "UNKNOWN";
      if (decided.length && decided.length < rows.length) resolution = "evidence-asymmetry";
    } else {
      coverageClass = "unmatched";
      resolvedVerdict = decided.length ? decided[0].verdict : "UNKNOWN";
    }

    const structuredRow = structuredSide[0] || null;
    const attempt = structuredRow ? structuredRow.attempt : rows[0].attempt;
    const qualityFlags = [...new Set(rows.flatMap((r) => r.qualityFlags))].sort();
    const artifacts = rows.flatMap((r) => r.artifacts);

    logicalVerdicts.push({
      issue,
      stage,
      round,
      attempt,
      resolvedVerdict,
      coverageClass,
      resolution,
      conflict,
      work: { workId: structuredRow ? structuredRow.work.workId : null },
      qualityFlags,
      sources,
      artifacts,
    });

    if (coverageClass === "unmatched") {
      // Exact attempt join only: the "unsupervised:<issue>" fallback is a
      // pseudo-attempt and never corroborates (design §4.3).
      const attempts = [...new Set(rows.map((r) => r.attempt).filter((a) => !String(a).startsWith("unsupervised:")))].sort();
      for (const a of attempts) {
        const hk = `${issue}|${a}|${resolvedVerdict}`;
        if (!hints.has(hk)) hints.set(hk, { issue, attempt: a, verdict: resolvedVerdict, cells: [] });
        const hint = hints.get(hk);
        if (!hint.cells.some((c) => c.stage === stage && c.round === round)) {
          hint.cells.push({ stage, round });
        }
      }
    }
  }

  const corroborationHints = [...hints.values()]
    .filter((h) => h.cells.length > 1)
    .map((h) => ({
      issue: h.issue,
      attempt: h.attempt,
      verdict: h.verdict,
      cells: h.cells.sort((a, b) => String(a.stage).localeCompare(String(b.stage)) || (a.round ?? -1) - (b.round ?? -1)),
    }))
    .sort((a, b) => a.issue.localeCompare(b.issue) || a.attempt.localeCompare(b.attempt) || a.verdict.localeCompare(b.verdict));

  logicalVerdicts.sort((a, b) =>
    a.issue.localeCompare(b.issue) || String(a.stage).localeCompare(String(b.stage)) || (a.round ?? -1) - (b.round ?? -1));

  const coverage = {
    logicalVerdicts: logicalVerdicts.length,
    matched: logicalVerdicts.filter((l) => l.coverageClass === "matched").length,
    unmatched: logicalVerdicts.filter((l) => l.coverageClass === "unmatched").length,
    ambiguous: logicalVerdicts.filter((l) => l.coverageClass === "ambiguous").length,
  };
  if (coverage.matched + coverage.unmatched + coverage.ambiguous !== coverage.logicalVerdicts) {
    // Invariant by construction; thrown rather than served broken (design §4.6).
    throw new Error(`coverage invariant violated: ${JSON.stringify(coverage)}`);
  }

  return { logicalVerdicts, coverage, corroborationHints, anomalies };
}

// ── evidence rows ─────────────────────────────────────────────────────────────

function structuredRow(rec, runId, file, content, children) {
  const issue = String(rec.taskId);
  const stage = rec.squad != null && rec.squad !== ""
    ? String(rec.squad)
    : rec.childId ? String(rec.childId).replace(/-\d+$/, "") : null;
  const rawVerdict = rec.verdict == null ? null : String(rec.verdict);
  const verdict = normalizeVerdict(rawVerdict);
  const unknownReasons = verdict === "UNKNOWN" ? ["unrecognized-verdict-value"] : [];
  const acMapping = Array.isArray(rec.acMapping) ? rec.acMapping : [];
  const qualityFlags = stage !== "review" && acMapping.length > 0 ? ["cross-stage-recording"] : [];
  const workChild = resolveWorkChild(children, issue);
  const fingerprint = rec.fingerprint && rec.fingerprint.combined != null ? String(rec.fingerprint.combined) : null;

  return {
    issue,
    stage,
    source: "structured",
    attempt: rec.runId != null && rec.runId !== "" ? String(rec.runId) : runId,
    round: Number.isInteger(rec.round) ? rec.round : null,
    verdict,
    rawVerdict,
    unknownReasons,
    qualityFlags,
    childId: rec.childId != null ? String(rec.childId) : null,
    work: {
      workId: fingerprint ? `fp:${fingerprint}` : null,
      fingerprint,
      baseRevision: workChild && workChild.baseRevision != null ? String(workChild.baseRevision) : null,
      reviewRunId: null,
      workTurns: workChild && Array.isArray(workChild.turns) ? workChild.turns.length : null,
    },
    artifacts: [{ kind: "verdict-json", path: `supervisor/${runId}/verdicts/${file}`, sha256: sha12(content) }],
    recordedAt: rec.recordedAt != null ? String(rec.recordedAt) : null,
    findings: Array.isArray(rec.findings) ? rec.findings : [],
    acMapping,
    evidenceLine: null,
    conflictingEvidence: null,
  };
}

function legacyRow(r, reviewsDir, telemetryIndex) {
  const joined = r.reviewRunId ? telemetryIndex.get(r.reviewRunId) : undefined;
  // loadReviews() owns parsing; this re-read exists only for the artifact
  // digest (12-hex content hash — every retained artifact carries one).
  let sha = null;
  try {
    sha = sha12(readFileSync(join(reviewsDir, `${r.taskId}-round${r.round}.md`), "utf8"));
  } catch { sha = null; } // loadReviews already surfaced read errors as anomalies
  return {
    issue: r.taskId,
    stage: "review", // corpus contract: reviews/ holds review-round files only
    source: "legacy",
    attempt: joined || `unsupervised:${r.taskId}`,
    round: r.round,
    verdict: r.verdict,
    rawVerdict: r.verdict,
    unknownReasons: [...(r.unknownReasons || [])],
    qualityFlags: LINEAR_ID_RE.test(r.taskId) ? [] : ["non-linear-id"],
    childId: null,
    work: { workId: null, fingerprint: null, baseRevision: null, reviewRunId: r.reviewRunId || null, workTurns: null },
    artifacts: [{ kind: "review-md", path: `reviews/${r.taskId}-round${r.round}.md`, sha256: sha }],
    recordedAt: null,
    findings: [],
    acMapping: [],
    evidenceLine: r.evidence ? { line: r.evidence.line, lineNo: r.evidence.lineNo, anchor: r.evidence.anchor } : null,
    conflictingEvidence: r.conflictingEvidence
      ? r.conflictingEvidence.map((c) => ({ line: c.line, lineNo: c.lineNo, anchor: c.anchor }))
      : null,
  };
}

// ── per-issue layer (design §4.4) ─────────────────────────────────────────────

function buildPerIssue(logicalVerdicts, gatesByTask, testReportsByTask) {
  const issues = new Set(logicalVerdicts.map((l) => l.issue));
  for (const t of gatesByTask.keys()) issues.add(t);
  for (const t of testReportsByTask.keys()) issues.add(t);

  const perIssue = [];
  for (const issue of [...issues].sort((a, b) => a.localeCompare(b))) {
    const reviewCells = logicalVerdicts
      .filter((l) => l.issue === issue && l.stage === "review")
      .sort((a, b) => (a.round ?? -1) - (b.round ?? -1) || String(a.attempt).localeCompare(String(b.attempt)));
    const round1 = reviewCells.filter((l) => l.round === 1);
    const r1 = round1.length ? round1[round1.length - 1] : null;
    const testCells = logicalVerdicts.filter((l) => l.issue === issue && l.stage === "test");
    const doneGates = gatesByTask.get(issue)?.done || [];

    // testAcceptance (design §4.4 + Mateusz decision 2026-09-07): a gate with
    // facts.testState === "Done" counts as final TEST acceptance, artifact-
    // linked. Pass-conditions first (a PASS test verdict or a Done gate), then
    // an explicit FAIL verdict, else unknown. The three acceptance fields are
    // never coalesced and no derived "done" field exists anywhere.
    const testAcceptance = doneGates.length > 0 || testCells.some((l) => l.resolvedVerdict === "PASS")
      ? "pass"
      : testCells.some((l) => l.resolvedVerdict === "FAIL") ? "fail" : "unknown";

    perIssue.push({
      issue,
      review: {
        finalVerdict: reviewCells.length ? reviewCells[reviewCells.length - 1].resolvedVerdict : null,
        firstPassClean: r1 ? (r1.resolvedVerdict === "PASS" ? true : r1.resolvedVerdict === "FAIL" ? false : null) : null,
        rounds: reviewCells.length ? Math.max(...reviewCells.map((l) => l.round ?? 0)) : 0,
      },
      testAcceptance,
      testAcceptanceArtifacts: doneGates,
      // No structured human-acceptance record exists (gate answer prose is a
      // trace, not a verdict) — unknown by design, with the trace surface kept
      // so a future structured record slots in without schema change.
      humanAcceptance: "unknown",
      humanAcceptanceTraces: gatesByTask.get(issue)?.traces || [],
      testReportArtifacts: testReportsByTask.get(issue) || [],
    });
  }
  return perIssue;
}

// ── optional telemetry delegation axis ────────────────────────────────────────

function loadDelegations(dbPath, anomalies) {
  const empty = { available: false, attribution: "weak", attributionNote: DELEGATION_NOTE, byTask: {} };
  if (dbPath === null || dbPath === undefined) return empty;
  if (!existsSync(dbPath)) return empty;
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (error) {
    anomalies.push({ reason: "delegations-db-error", detail: String(error?.message || error) });
    return empty;
  }
  let byTaskMap;
  try {
    byTaskMap = delegationsByTask(db);
  } catch (error) {
    db.close();
    anomalies.push({ reason: "delegations-db-error", detail: String(error?.message || error) });
    return empty;
  }
  db.close();
  const byTask = {};
  for (const taskId of [...byTaskMap.keys()].sort((a, b) => String(a).localeCompare(String(b)))) {
    byTask[taskId] = byTaskMap.get(taskId)
      .map((d) => ({ squad: d.squad ?? null, agent: d.agent ?? null, model: d.model ?? null, turns: d.turns }))
      .sort((a, b) => String(a.squad).localeCompare(String(b.squad))
        || String(a.agent).localeCompare(String(b.agent))
        || String(a.model).localeCompare(String(b.model)));
  }
  return { available: true, attribution: "weak", attributionNote: DELEGATION_NOTE, byTask };
}

/** Valid degraded shape — the server route serves exactly this when there is nothing to read. */
export function emptyVerdictEvidence() {
  return {
    coverage: { logicalVerdicts: 0, matched: 0, unmatched: 0, ambiguous: 0 },
    evidenceRows: [],
    logicalVerdicts: [],
    perIssue: [],
    corroborationHints: [],
    anomalies: [],
    legacyTaskOutcomes: [],
    delegations: { available: false, attribution: "weak", attributionNote: DELEGATION_NOTE, byTask: {} },
  };
}

// ── the projection ────────────────────────────────────────────────────────────

/**
 * Pure, stateless projection over the two evidence stores (+ optional
 * telemetry axis). Never throws for absent inputs: each source degrades
 * independently and the report stays a valid shape (server-route contract).
 */
export function projectVerdictEvidence({
  supervisorRoot = DEFAULT_SUPERVISOR_ROOT,
  reviewsDir = DEFAULT_REVIEWS,
  roundsPath = DEFAULT_ROUNDS,
  dbPath = DEFAULT_DB,
} = {}) {
  const anomalies = [];
  const evidenceRows = [];
  const gatesByTask = new Map(); // taskId -> { done: [], traces: [] }
  const testReportsByTask = new Map(); // taskId -> [artifact]

  // ── structured store + run-dir lineage ─────────────────────────────────────
  const runs = existsSync(supervisorRoot)
    ? readdirSync(supervisorRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
    : [];

  const childrenByRun = new Map();
  const telemetryIndex = new Map(); // telemetryRunId -> supervisor runId (first sorted wins)
  const telemetryDupes = new Map();
  for (const runId of runs) {
    const { children, parseError } = readRunChildren(supervisorRoot, runId);
    childrenByRun.set(runId, children);
    if (parseError) anomalies.push({ reason: "children-json-parse-error", runId, detail: parseError });
    for (const child of children) {
      if (!child.telemetryRunId) continue;
      if (telemetryIndex.has(child.telemetryRunId) && telemetryIndex.get(child.telemetryRunId) !== runId) {
        if (!telemetryDupes.has(child.telemetryRunId)) telemetryDupes.set(child.telemetryRunId, [telemetryIndex.get(child.telemetryRunId)]);
        telemetryDupes.get(child.telemetryRunId).push(runId);
      } else if (!telemetryIndex.has(child.telemetryRunId)) {
        telemetryIndex.set(child.telemetryRunId, runId);
      }
    }
  }
  for (const id of [...telemetryDupes.keys()].sort()) {
    anomalies.push({ reason: "telemetry-run-id-duplicate", telemetryRunId: id, runs: telemetryDupes.get(id).sort() });
  }

  for (const runId of runs) {
    const runDir = join(supervisorRoot, runId);
    const vDir = join(runDir, "verdicts");
    if (existsSync(vDir)) {
      for (const file of readdirSync(vDir).sort()) {
        if (!file.endsWith(".json")) continue;
        const p = join(vDir, file);
        let rec;
        let content;
        try {
          content = readFileSync(p, "utf8");
          rec = JSON.parse(content);
        } catch (error) {
          anomalies.push({ reason: "verdict-parse-error", path: `supervisor/${runId}/verdicts/${file}`, detail: String(error?.message || error) });
          continue;
        }
        const row = structuredRow(rec, runId, file, content, childrenByRun.get(runId) || []);
        if (row.verdict === "UNKNOWN" && row.rawVerdict !== "UNKNOWN" && !["pass", "fail"].includes(row.rawVerdict)) {
          anomalies.push({ reason: "unrecognized-verdict-value", path: row.artifacts[0].path, value: row.rawVerdict });
        }
        evidenceRows.push(row);
      }
    }

    const gDir = join(runDir, "gates");
    if (existsSync(gDir)) {
      for (const file of readdirSync(gDir).sort()) {
        if (!file.endsWith(".json")) continue;
        let g;
        try {
          g = JSON.parse(readFileSync(join(gDir, file), "utf8"));
        } catch (error) {
          anomalies.push({ reason: "gate-parse-error", path: `supervisor/${runId}/gates/${file}`, detail: String(error?.message || error) });
          continue;
        }
        const taskId = g.taskId != null ? String(g.taskId) : null;
        if (!taskId) {
          anomalies.push({ reason: "gate-no-task", path: `supervisor/${runId}/gates/${file}` });
          continue;
        }
        const artifact = {
          kind: "gate-json",
          path: `supervisor/${runId}/gates/${file}`,
          sha256: sha12(readFileSync(join(gDir, file), "utf8")),
          gateId: g.gateId != null ? String(g.gateId) : null,
        };
        if (!gatesByTask.has(taskId)) gatesByTask.set(taskId, { done: [], traces: [] });
        const entry = gatesByTask.get(taskId);
        if (g.facts && g.facts.testState === "Done") {
          entry.done.push({ ...artifact, testState: "Done" });
        }
        const answerText = g.answer && typeof g.answer.text === "string" ? g.answer.text : "";
        if (g.status === "answered" && answerText.trim() !== "") {
          entry.traces.push({
            kind: "gate-json",
            path: artifact.path,
            sha256: artifact.sha256,
            gateId: artifact.gateId,
            answeredAt: g.answer.answeredAt != null ? String(g.answer.answeredAt) : null,
          });
        }
      }
    }

    // Free-text TEST reports: linked as artifacts, never parsed (§9.4).
    for (const file of readdirSync(runDir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort()) {
      if (!ARTIFACT_PATH_RE.test(file)) continue;
      const base = file.replace(ARTIFACT_PATH_RE, "");
      const children = childrenByRun.get(runId) || [];
      const exact = children.find((c) => c.childId === base);
      const prefixed = exact ? null : children
        .filter((c) => c.childId && (base === c.childId || base.startsWith(c.childId + "-")))
        .sort((a, b) => b.childId.length - a.childId.length || String(a.childId).localeCompare(String(b.childId)))[0] || null;
      const child = exact || prefixed;
      if (!child || !child.taskId) {
        anomalies.push({ reason: "test-report-no-task", path: `supervisor/${runId}/${file}` });
        continue;
      }
      if (!testReportsByTask.has(child.taskId)) testReportsByTask.set(child.taskId, []);
      testReportsByTask.get(child.taskId).push({
        kind: "test-report-txt",
        path: `supervisor/${runId}/${file}`,
        sha256: sha12(readFileSync(join(runDir, file), "utf8")),
      });
    }
  }

  // ── legacy store (F1's loader + classifier, verbatim) ───────────────────────
  const { reviews, readErrors } = loadReviews(reviewsDir);
  anomalies.push(...readErrors);
  for (const r of reviews) evidenceRows.push(legacyRow(r, reviewsDir, telemetryIndex));

  // Round counter — REVIEW's own state; malformed counter degrades to {}
  // (same contract as F1's computeOutcomes).
  let counter = {};
  if (existsSync(roundsPath)) {
    try {
      counter = JSON.parse(readFileSync(roundsPath, "utf8"));
      if (!counter || typeof counter !== "object" || Array.isArray(counter)) counter = {};
    } catch (error) {
      anomalies.push({ reason: "rounds-counter-parse-error", detail: String(error?.message || error) });
      counter = {};
    }
  }
  const { byTask: taskOutcomes, anomalies: aggregateAnomalies } = aggregateOutcomes(reviews, counter);
  const legacyTaskOutcomes = [...taskOutcomes.values()]
    .map((t) => ({
      taskId: t.taskId,
      rounds: t.rounds,
      blockers: t.blockers,
      issues: t.issues,
      returned: t.returned,
      firstPassClean: t.firstPassClean,
      outcome: t.outcome,
      unknownReasons: [...(t.unknownReasons || [])],
      roundVerdicts: (t.roundVerdicts || []).map((rv) => ({ round: rv.round, verdict: rv.verdict })),
      evidence: t.evidence ? { line: t.evidence.line, lineNo: t.evidence.lineNo, anchor: t.evidence.anchor } : null,
      ...(t.roundsOnly ? { roundsOnly: true } : {}),
      qualityFlags: LINEAR_ID_RE.test(t.taskId) ? [] : ["non-linear-id"],
    }))
    .sort((a, b) => a.taskId.localeCompare(b.taskId));

  // ── rollup + per-issue + delegations ────────────────────────────────────────
  const rollup = buildLogicalVerdicts(evidenceRows);
  anomalies.push(...rollup.anomalies);
  anomalies.push(...aggregateAnomalies);

  const perIssue = buildPerIssue(rollup.logicalVerdicts, gatesByTask, testReportsByTask);
  const delegations = loadDelegations(dbPath, anomalies);

  evidenceRows.sort((a, b) =>
    a.issue.localeCompare(b.issue) || String(a.stage).localeCompare(String(b.stage))
    || (SOURCE_ORDER[a.source] ?? 2) - (SOURCE_ORDER[b.source] ?? 2)
    || String(a.attempt).localeCompare(String(b.attempt))
    || (a.round ?? -1) - (b.round ?? -1));

  return {
    coverage: rollup.coverage,
    evidenceRows,
    logicalVerdicts: rollup.logicalVerdicts,
    perIssue,
    corroborationHints: rollup.corroborationHints,
    anomalies,
    legacyTaskOutcomes,
    delegations,
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const opts = {};
  const supervisorRoot = opt("--supervisor-root");
  const reviewsDir = opt("--reviews-dir");
  if (supervisorRoot !== undefined) opts.supervisorRoot = supervisorRoot;
  if (reviewsDir !== undefined) opts.reviewsDir = reviewsDir;

  const report = projectVerdictEvidence(opts);
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const c = report.coverage;
  console.log(`\n  Werdyki ujednolicone: ${c.logicalVerdicts}  ·  zgodne: ${c.matched}  ·  pojedyncze źródło: ${c.unmatched}  ·  sprzeczne: ${c.ambiguous}`);
  console.log(`  wiersze dowodowe: ${report.evidenceRows.length}  ·  zadania: ${report.perIssue.length}  ·  wskazówki korelacji: ${report.corroborationHints.length}  ·  anomalie: ${report.anomalies.length}`);
  console.log(`  delegacje telemetrii: ${report.delegations.available ? "dostępne (sygnał słaby — korelacja, nie przyczynowość)" : "niedostępne"}`);
  if (c.ambiguous > 0) {
    console.log("\n  Komórki sprzeczne (obie strony zachowane, resolvedVerdict wg nadzorcy):");
    for (const l of report.logicalVerdicts.filter((x) => x.coverageClass === "ambiguous").slice(0, 10)) {
      console.log(`    ${l.issue} ${l.stage} r${l.round} — structured: ${l.conflict.sides.structured ?? "—"} vs legacy: ${l.conflict.sides.legacy ?? "—"}`);
    }
  }
  console.log("");
}

// Only run the CLI when executed directly (same guard as delegation-outcomes.mjs).
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
