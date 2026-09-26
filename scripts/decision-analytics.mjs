#!/usr/bin/env node
/**
 * scripts/decision-analytics.mjs — read-side analytics over the decision I/O
 * log (FOC-449's .state/runs/<runId>/decisions.jsonl), for the dashboard's
 * decision-quality panel.
 *
 * Why this exists. The log is the only place that holds, per registry-backed
 * decision call, BOTH sides of the story: what the model answered (the event
 * line — answers, confidence, usage, duration) and what actually happened
 * (the label line — the observed outcome). Neither the telemetry store nor
 * the raw transcripts join those two, so decision quality (agreement between
 * answer and outcome, confidence distribution, cost per decision) can only be
 * measured here. Like the other analysis modules, this one is strictly
 * read-only and says where the evidence is thin instead of hiding doubt
 * inside a number: every panel returns `caveats` (level info|warn), and
 * agreement is computed ONLY for decisions whose answers→outcome mapping is
 * proven from config/decisions.json — for anything else the panel emits
 * agreement_unknown rather than guessing.
 *
 * Line types (see scripts/decision-log.mjs, the writer):
 *   · {type:"event", ...} — one per decision call; joined to labels on eventId.
 *   · {type:"label", ...} — the observed outcome for an event. Several labels
 *     may exist; the latest by ts decides agreement.
 *   · legacy lines (no `type`) predate FOC-449, carry no eventId, can never be
 *     labelled — skipped and counted, never silently dropped.
 *
 * answers→outcome mapping (each decision has ONE question whose answer is the
 * primary output; evidence: config/decisions.json questions blocks):
 *   · intake.triage_node            answers.q0.choice  — criteria plan|dev|review|test|ask
 *   · intake.has_acceptance_criteria answers.q0.noul   — noul is P(true); the
 *     codebase's canonical reading is `noul >= 0.5 → "true"` (plan-gates.mjs,
 *     supervisor-triage.mjs), criteria labels are exactly "true"/"false"
 *     (decision-call.mjs).
 *   · intake.task_size              answers.size.choice — small|medium|large
 *
 * Era split follows telemetry-analysis.mjs: FOC-397's graph-runner merge
 * (2026-09-22) is the pre/post boundary; an event with no parseable ts counts
 * as pre (post requires a timestamp that proves it).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, SHADOW_LABEL_TYPE } from "./decision-log.mjs";
import { SHADOW_EVENT_TYPE, SHADOW_FILENAME } from "./decision-call.mjs";

/** Below this per-decision event count the rates are noise, not signal. */
export const SMALL_SAMPLE_N = 30;

const ERAS = new Set(["all", "pre", "post"]);

// decisionId → the question whose answer is the decision's primary output,
// and how that answer becomes the string a label `outcome` compares against.
// Every entry is backed by the decision's questions block in
// config/decisions.json; a decisionId absent here has NO proven mapping.
const ANSWER_SOURCES = {
  "intake.triage_node": { qid: "q0", kind: "choice" },
  "intake.has_acceptance_criteria": { qid: "q0", kind: "noul" },
  "intake.task_size": { qid: "size", kind: "choice" },
};

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** The runs directory this module reads: env override, else the repo's .state/runs. */
export function resolveRunsDir() {
  return process.env.LA_DECISION_RUNS_DIR || join(ROOT, ".state", "runs");
}

/**
 * The primary answer of one decision as the string a label outcome corresponds
 * to. choice → the chosen criteria label verbatim; noul → P(true) read with
 * the codebase's canonical `>= 0.5` threshold. null when the decision has no
 * proven mapping, or the answer is missing/malformed — never a guess.
 */
function primaryAnswer(decisionId, answers) {
  const source = ANSWER_SOURCES[decisionId];
  if (!source) return null;
  const answer = answers?.[source.qid];
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return null;
  if (source.kind === "choice" && answer.type === "choice" && typeof answer.choice === "string") {
    return answer.choice;
  }
  if (source.kind === "noul" && answer.type === "noul" && typeof answer.noul === "number") {
    return answer.noul >= 0.5 ? "true" : "false";
  }
  return null;
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Read every run log under runsDir into flat event/label lists.
 *
 * Deterministic: run dirs are scanned name-ascending (same order as
 * decision-log.mjs's export — mtimes move, analysis must not). Legacy lines
 * are counted, not returned; a line that is neither a well-formed event, a
 * well-formed label, nor a legacy line (unparseable JSON, wrong shape, unknown
 * `type`) counts as a parseError. A missing runsDir is an empty log, not a
 * throw — an unlaunched machine still gets a panel, just an empty one.
 */
export function readDecisionLog(runsDir) {
  const out = { events: [], labels: [], files: 0, legacyLines: 0, parseErrors: 0 };
  if (!existsSync(runsDir)) return out;
  for (const runId of readdirSync(runsDir).sort()) {
    const path = join(runsDir, runId, SHADOW_FILENAME);
    if (!existsSync(path)) continue;
    out.files++;
    for (const text of readFileSync(path, "utf8").split("\n").map((l) => l.trim()).filter(Boolean)) {
      let line;
      try {
        line = JSON.parse(text);
      } catch {
        out.parseErrors++;
        continue;
      }
      if (line === null || typeof line !== "object" || Array.isArray(line)) {
        out.parseErrors++;
        continue;
      }
      if (line.type === SHADOW_EVENT_TYPE) {
        if (typeof line.eventId !== "string" || !line.eventId || typeof line.decisionId !== "string" || !line.decisionId) {
          out.parseErrors++;
          continue;
        }
        const usage = line.usage && typeof line.usage === "object" && !Array.isArray(line.usage) ? line.usage : null;
        out.events.push({
          eventId: line.eventId,
          decisionId: line.decisionId,
          runId,
          ts: typeof line.ts === "string" ? line.ts : null,
          model: typeof line.model === "string" ? line.model : null,
          tier: num(line.tier),
          mode: typeof line.mode === "string" ? line.mode : null,
          ok: typeof line.ok === "boolean" ? line.ok : null,
          confidence: num(line.confidence),
          formatConfidence: num(line.formatConfidence),
          durationMs: num(line.durationMs),
          costUsd: usage ? num(usage.cost) : null,
          inputTokens: usage ? num(usage.inputTokens) : null,
          outputTokens: usage ? num(usage.outputTokens) : null,
          error: typeof line.error === "string" && line.error ? line.error : null,
          answer: primaryAnswer(line.decisionId, line.answers),
          taskKey: typeof line.taskKey === "string" ? line.taskKey : null,
        });
      } else if (line.type === SHADOW_LABEL_TYPE) {
        if (typeof line.eventId !== "string" || !line.eventId || typeof line.outcome !== "string" || !line.outcome) {
          out.parseErrors++;
          continue;
        }
        out.labels.push({
          eventId: line.eventId,
          outcome: line.outcome,
          by: typeof line.by === "string" ? line.by : null,
          source: typeof line.source === "string" ? line.source : null,
          via: typeof line.via === "string" ? line.via : null,
          ts: typeof line.ts === "string" ? line.ts : null,
        });
      } else if (line.type === undefined) {
        out.legacyLines++;
      } else {
        out.parseErrors++;
      }
    }
  }
  return out;
}

// ── panel ────────────────────────────────────────────────────────────────────

const tsMs = (ts) => {
  if (typeof ts !== "string") return null;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : ms;
};

/** Nearest-rank percentile over a non-empty ascending-sorted array. */
const percentile = (sorted, p) => sorted[Math.ceil((p / 100) * sorted.length) - 1];

/** The 5 confidence buckets [0,.2) [.2,.4) [.4,.6) [.6,.8) [.8,1] as index. */
const bucketOf = (c) => Math.min(4, Math.max(0, Math.floor(c * 5)));

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse one filter date to epoch ms. Dates are UTC. A date-only value
 * ("2026-09-21") means the whole UTC day: `from` (endOfDay = false) reads it
 * as the day's start, `to` (endOfDay = true) as the day's END — a date-only
 * `to` read as midnight would silently drop the entire chosen day. Full
 * datetimes pass through unchanged (the server route passes values already
 * normalized by telemetry-analysis.mjs's normalizeFilters, so the rule is
 * never applied twice).
 */
function requireDateMs(value, label, { endOfDay = false } = {}) {
  const raw = typeof value === "string" ? value.trim() : value;
  if (endOfDay && typeof raw === "string" && DATE_ONLY.test(raw)) {
    const ms = Date.parse(`${raw}T23:59:59.999Z`);
    if (Number.isNaN(ms)) throw fail("bad_filter", `${label} is not a parseable date: ${JSON.stringify(value)}`);
    return ms;
  }
  const ms = tsMs(value);
  if (ms === null) throw fail("bad_filter", `${label} is not a parseable date: ${JSON.stringify(value)}`);
  return ms;
}

/**
 * The decision-quality panel: per decisionId — volume, ok rate, cost, latency,
 * confidence spread, and (where the mapping is proven) agreement between the
 * model's answer and the latest recorded outcome. filters {from, to, era,
 * eraBoundary} apply to event ts (era "post" = ts >= eraBoundary; an event
 * with no ts counts as pre; from/to exclude events whose ts cannot prove
 * membership). All dates are UTC; a date-only from/to means the start/end of
 * that UTC day. Labels join on eventId across the whole log — the label lives
 * next to its event, but the join must not depend on file layout.
 */
export function decisionsPanel(filters = {}, { runsDir = resolveRunsDir() } = {}) {
  const era = filters.era ?? "all";
  if (!ERAS.has(era)) throw fail("bad_filter", `era must be one of ${[...ERAS].join(" | ")}, got ${JSON.stringify(filters.era)}`);
  const fromMs = filters.from !== undefined && filters.from !== null ? requireDateMs(filters.from, "from") : null;
  const toMs = filters.to !== undefined && filters.to !== null ? requireDateMs(filters.to, "to", { endOfDay: true }) : null;
  const boundaryMs =
    filters.eraBoundary !== undefined && filters.eraBoundary !== null ? requireDateMs(filters.eraBoundary, "eraBoundary") : null;
  if (era !== "all" && boundaryMs === null) {
    throw fail("bad_filter", `era "${era}" needs eraBoundary (ISO string)`);
  }

  const log = readDecisionLog(runsDir);

  // Latest label per event (ts decides; same-ts ties go to the later line).
  const labelsByEvent = new Map();
  log.labels.forEach((label, index) => {
    const prev = labelsByEvent.get(label.eventId);
    if (prev === undefined) {
      labelsByEvent.set(label.eventId, { label, index });
      return;
    }
    const a = tsMs(label.ts) ?? Number.NEGATIVE_INFINITY;
    const b = tsMs(prev.label.ts) ?? Number.NEGATIVE_INFINITY;
    if (a > b || (a === b && index > prev.index)) labelsByEvent.set(label.eventId, { label, index });
  });

  const passes = (event) => {
    const ms = tsMs(event.ts);
    if (fromMs !== null && (ms === null || ms < fromMs)) return false;
    if (toMs !== null && (ms === null || ms > toMs)) return false;
    if (era === "pre" && ms !== null && ms >= boundaryMs) return false;
    if (era === "post" && (ms === null || ms < boundaryMs)) return false;
    return true;
  };

  const events = log.events.filter(passes);
  const byDecision = new Map();
  for (const event of events) {
    if (!byDecision.has(event.decisionId)) byDecision.set(event.decisionId, []);
    byDecision.get(event.decisionId).push(event);
  }

  const decisions = [];
  const caveats = [];
  let labelledCount = 0;
  let unlabelledCount = 0;

  for (const [decisionId, group] of [...byDecision.entries()].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1))) {
    const n = group.length;
    const labelled = group.filter((e) => labelsByEvent.has(e.eventId));
    labelledCount += labelled.length;
    unlabelledCount += n - labelled.length;

    // Agreement: only where the answers→outcome mapping is proven. Unknown
    // mapping → agreement null + a caveat; never a guess.
    let agreement = null;
    if (ANSWER_SOURCES[decisionId]) {
      let compared = 0;
      let matched = 0;
      for (const event of labelled) {
        if (event.answer === null) continue;
        compared++;
        if (event.answer === labelsByEvent.get(event.eventId).label.outcome) matched++;
      }
      agreement = { compared, matched, rate: compared > 0 ? matched / compared : null };
    } else {
      caveats.push({
        level: "warn",
        code: "agreement_unknown",
        message: `decision ${decisionId}: no proven answers→outcome mapping (not in config/decisions.json intake set) — agreement not computed`,
        count: n,
      });
    }

    const confidences = group.map((e) => e.confidence).filter((c) => c !== null).sort((a, b) => a - b);
    const durations = group.map((e) => e.durationMs).filter((d) => d !== null).sort((a, b) => a - b);
    const costs = group.map((e) => e.costUsd).filter((c) => c !== null);
    const costTotal = costs.reduce((sum, c) => sum + c, 0);

    if (n < SMALL_SAMPLE_N) {
      caveats.push({
        level: "warn",
        code: "small_sample",
        message: `decision ${decisionId}: ${n} event(s) is below SMALL_SAMPLE_N (${SMALL_SAMPLE_N}) — rates are noise, not signal`,
        count: n,
      });
    }

    // Mixed pricing: dividing the total by ALL events would fold the costless
    // ones in as free. perPricedEvent divides by the priced events only;
    // perEvent stays as an alias with the SAME value so existing UI consumers
    // keep working (the alias is not the old n-based average).
    const priced = costs.length;
    if (priced > 0 && priced < n) {
      caveats.push({
        level: "info",
        code: "partially_priced",
        message: `decision ${decisionId}: ${n - priced} of ${n} event(s) carry no cost — perPricedEvent (and the perEvent alias) average the ${priced} priced event(s) only`,
        count: n - priced,
      });
    }

    decisions.push({
      decisionId,
      n,
      okRate: n > 0 ? group.filter((e) => e.ok === true).length / n : null,
      errorCount: group.filter((e) => e.ok === false || e.error !== null).length,
      labelled: labelled.length,
      agreement,
      confidence: confidences.length
        ? {
            min: confidences[0],
            p50: percentile(confidences, 50),
            max: confidences[confidences.length - 1],
            buckets: [0, 1, 2, 3, 4].map((i) => confidences.filter((c) => bucketOf(c) === i).length),
          }
        : null,
      durationMs: durations.length ? { p50: percentile(durations, 50), p90: percentile(durations, 90) } : null,
      costUsd: costs.length ? { total: costTotal, perPricedEvent: costTotal / costs.length, perEvent: costTotal / costs.length } : null,
      models: [...new Set(group.map((e) => e.model).filter((m) => m !== null))].sort(),
      smallSample: n < SMALL_SAMPLE_N,
    });
  }

  if (unlabelledCount > 0) {
    caveats.push({
      level: "info",
      code: "unlabelled",
      message: `${unlabelledCount} event(s) carry no outcome label — they count towards volume and cost, not agreement`,
      count: unlabelledCount,
    });
  }
  if (log.legacyLines > 0) {
    caveats.push({
      level: "info",
      code: "legacy_skipped",
      message: `${log.legacyLines} legacy pre-FOC-449 line(s) skipped — no eventId, can never carry a label`,
      count: log.legacyLines,
    });
  }
  const eventIds = new Set(log.events.map((e) => e.eventId));
  const orphanLabels = log.labels.filter((l) => !eventIds.has(l.eventId)).length;
  if (orphanLabels > 0) {
    caveats.push({
      level: "info",
      code: "orphan_labels",
      message: `${orphanLabels} label(s) point at events missing from the log — no join partner`,
      count: orphanLabels,
    });
  }

  return {
    filters: { ...filters },
    data: {
      totals: {
        events: events.length,
        labelled: labelledCount,
        decisions: decisions.length,
        legacyLinesSkipped: log.legacyLines,
        parseErrors: log.parseErrors,
      },
      decisions,
    },
    caveats,
  };
}

// ── flat tables ──────────────────────────────────────────────────────────────

const EVENT_COLUMNS = [
  "eventId",
  "decisionId",
  "runId",
  "ts",
  "model",
  "tier",
  "mode",
  "ok",
  "confidence",
  "formatConfidence",
  "durationMs",
  "costUsd",
  "inputTokens",
  "outputTokens",
  "error",
  "answer",
  "taskKey",
];
const LABEL_COLUMNS = ["eventId", "outcome", "by", "source", "via", "ts"];

/**
 * The log as two flat, scalar-only tables (columns + aligned row arrays) so a
 * SQL console can load them directly. No nested values: `answers` is already
 * reduced to the single `answer` string on each event.
 */
export function decisionTables(log) {
  return {
    decision_events: {
      columns: EVENT_COLUMNS,
      rows: log.events.map((event) => EVENT_COLUMNS.map((c) => event[c] ?? null)),
    },
    decision_labels: {
      columns: LABEL_COLUMNS,
      rows: log.labels.map((label) => LABEL_COLUMNS.map((c) => label[c] ?? null)),
    },
  };
}
