// Runtime statistics pure helpers (PRD §9–10, phase P3). No React, no env
// access — everything takes what it needs as arguments so the plain-node
// tests (_tests_statistics.mjs) can pin the behavior outside Vite. The fetch
// helper lives here too (same error contract as api.js's apiFetch) because
// api.js is outside this slice's file set — the parent may move it later.
//
// Honest-numbers rules carried over from scripts/runtime-statistics.mjs:
//   - a missing denominator renders "Unavailable", never 0 or 100;
//   - 0 is a real value and formats as "0…" (never collapsed into null);
//   - coverage always shows known and unknown durations ADJACENT, so a
//     percentage is never read without its denominator;
//   - planned workflow proportions, observed completed routes and in-progress
//     routes stay in separate sections — never one mixed "routes" list.
//
// Accessibility rule (spec §7): colour is never the only signal — every bar
// rides with its text value.

// The timeframe filter: 24h/7d use the API's `window` shorthand; "all" sends
// no window (the server still bounds `to` at now, so open lifetimes stay
// measurable).
export const TIMEFRAMES = [
  { key: '24h', label: 'Last 24h' },
  { key: '7d', label: 'Last 7 days' },
  { key: 'all', label: 'All time' },
];

const TIMEFRAME_KEYS = TIMEFRAMES.map((t) => t.key);
const DEFAULT_TIMEFRAME = '24h';

// The canonical taskKey shape (`workspace:issueId`) — the same class the
// route validates with, mirrored so the UI never sends a 400 it could have
// prevented. Not a full match object: a strict-equality-safe boolean check.
const TASK_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*:[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export function isCanonicalTaskKey(value) {
  return typeof value === 'string' && TASK_KEY_RE.test(value);
}

// filtersFromQuery(queryString) -> { timeframe, taskKey }. An unknown or
// missing timeframe falls back to the default; taskKey is trimmed, an empty
// or non-canonical value is null (the input stays free-form — the filter is
// only APPLIED when canonical, so a half-typed key never silently widens the
// view to "everything").
export function filtersFromQuery(queryString) {
  const params = new URLSearchParams(queryString || '');
  const rawTimeframe = params.get('timeframe');
  const timeframe = TIMEFRAME_KEYS.includes(rawTimeframe) ? rawTimeframe : DEFAULT_TIMEFRAME;
  const rawTaskKey = (params.get('taskKey') || '').trim();
  return { timeframe, taskKey: isCanonicalTaskKey(rawTaskKey) ? rawTaskKey : null };
}

// queryFromFilters(filters) -> the query string ('' or '?…'), the inverse of
// filtersFromQuery (canonical taskKey only — a non-canonical draft never
// round-trips into the URL).
export function queryFromFilters(filters) {
  const f = filters || {};
  const q = new URLSearchParams();
  // The default timeframe is omitted so the URL stays clean (filtersFromQuery
  // applies it anyway); a non-canonical taskKey never round-trips.
  if (TIMEFRAME_KEYS.includes(f.timeframe) && f.timeframe !== DEFAULT_TIMEFRAME) {
    q.set('timeframe', f.timeframe);
  }
  if (isCanonicalTaskKey(f.taskKey)) q.set('taskKey', f.taskKey);
  const s = q.toString();
  return s ? '?' + s : '';
}

// The fetch helper — same-origin, same error contract as api.js's apiFetch
// (err.status, err.data). timeframe 24h/7d rides the `window` shorthand; "all"
// sends no window at all.
export async function getRuntimeStatistics(filters, signal) {
  const f = filters || {};
  const q = new URLSearchParams();
  if (f.timeframe && f.timeframe !== 'all') q.set('window', f.timeframe);
  if (isCanonicalTaskKey(f.taskKey)) q.set('taskKey', f.taskKey);
  const qs = q.toString();
  const r = await fetch('/api/runtime-statistics' + (qs ? '?' + qs : ''), { signal });
  if (!r.ok) {
    const data = await r.json().catch(() => null);
    const err = new Error((data && data.error) || 'API ' + r.status);
    err.status = r.status;
    if (data) err.data = data;
    throw err;
  }
  return r.json();
}

// ---------------------------------------------------------------- formatting

// formatDuration(ms) -> "850 ms" / "12.5 s" / "3.25 min" / "2.4 h" / "1.5 d",
// or null when there is no value. 0 is a value: "0 ms".
export function formatDuration(ms) {
  if (ms == null || typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1_000) return Math.round(ms) + ' ms';
  if (ms < 60_000) return trim1(ms / 1_000) + ' s';
  if (ms < 3_600_000) return trim1(ms / 60_000) + ' min';
  if (ms < 86_400_000) return trim1(ms / 3_600_000) + ' h';
  return trim1(ms / 86_400_000) + ' d';
}

// formatPct(value) -> "0%" / "42.3%" / "100%", or null when absent. The
// aggregation rounds to 2 decimals; trailing zeros are trimmed for display.
export function formatPct(value) {
  if (value == null || typeof value !== 'number' || !Number.isFinite(value)) return null;
  return trim1(value) + '%';
}

function trim1(x) {
  const s = (Math.round(x * 100) / 100).toString();
  return s;
}

// formatCount(n) -> "12", or null when absent. 0 is a value: "0".
export function formatCount(n) {
  if (n == null || typeof n !== 'number' || !Number.isFinite(n)) return null;
  return String(Math.round(n));
}

// The "value or Unavailable" rule for text cells: null/undefined render as
// the word, never as "0".
export function textOr(value, fallback = 'Unavailable') {
  return value == null ? fallback : value;
}

// barPercent(pct) -> 0..100 for the CSS bar width. Null/NaN clamp to 0 —
// the bar must exist (a zero-width bar with its text label is honest; a
// MISSING bar would hide the row).
export function barPercent(pct) {
  if (pct == null || typeof pct !== 'number' || !Number.isFinite(pct)) return 0;
  return Math.max(0, Math.min(100, pct));
}

// Occupancy wording (PRD §10): "active" is interaction time (LLM requests +
// tool execution, including model latency), never CPU.
export const OCCUPANCY_NOTE =
  'Active share counts model interaction time (LLM requests + tool execution, including model latency) — not CPU.';

// ------------------------------------------------------------- row builders

// The metrics block every actor/role/team row shares (the aggregation's field
// set verbatim — no invented fields).
function metricsRow(entry) {
  if (!entry || typeof entry !== 'object') return null;
  return {
    eligibleMs: entry.eligibleMs ?? null,
    knownMs: entry.knownMs ?? null,
    unknownMs: entry.unknownMs ?? null,
    busyMs: entry.busyMs ?? null,
    waitingOnChildMs: entry.waitingOnChildMs ?? null,
    waitingOnHumanMs: entry.waitingOnHumanMs ?? null,
    activePct: entry.activePct ?? null,
    activeText: formatPct(entry.activePct ?? null),
    activeBarPct: barPercent(entry.activePct ?? null),
    coveragePct: entry.coveragePct ?? null,
    coverageText: formatPct(entry.coveragePct ?? null),
    // Known/unknown durations ALWAYS adjacent (the percentage's denominator
    // is visible wherever the percentage is).
    knownText: formatDuration(entry.knownMs ?? null),
    unknownText: formatDuration(entry.unknownMs ?? null),
    eligibleText: formatDuration(entry.eligibleMs ?? null),
    waitingOnChildText: formatDuration(entry.waitingOnChildMs ?? null),
    waitingOnHumanText: formatDuration(entry.waitingOnHumanMs ?? null),
  };
}

// actorRows(statistics) — sorted by actorId (the aggregation's order).
export function actorRows(statistics) {
  const actors = statistics?.actors;
  if (!Array.isArray(actors)) return [];
  return actors
    .map((a) => (a ? { actorId: String(a.actorId), role: a.role ?? 'unknown', taskKey: a.taskKey ?? null, ...metricsRow(a) } : null))
    .filter(Boolean);
}

// roleRows(statistics) — the pooled per-role rows, aggregation order.
export function roleRows(statistics) {
  const roles = statistics?.roles;
  if (!Array.isArray(roles)) return [];
  return roles
    .map((r) => (r ? { role: r.role ?? 'unknown', actorsCount: r.actors ?? 0, ...metricsRow(r) } : null))
    .filter(Boolean);
}

// teamRow(statistics) — the single pooled team row, or null without data.
export function teamRow(statistics) {
  return statistics?.team ? { actorsCount: statistics.team.actors ?? 0, ...metricsRow(statistics.team) } : null;
}

// ------------------------------------------------------- workflow row groups

// plannedRows(statistics) — the initial-choice proportions. pct is of
// runsKnown (runs with a known choice), stated so the denominator travels
// with the rows; runsUnknownChoice is the honest remainder.
export function plannedRows(statistics) {
  const c = statistics?.workflows?.initialChoice;
  if (!c) return { rows: [], runsTotal: null, runsKnown: null, runsUnknownChoice: null };
  return {
    rows: (c.proportions || []).map((p) => ({
      stagesText: (p.stages || []).join(' > '),
      runs: p.runs ?? 0,
      runsText: formatCount(p.runs ?? 0),
      pctText: formatPct(p.pct ?? null),
      barPct: barPercent(p.pct ?? null),
    })),
    runsTotal: c.runsTotal ?? null,
    runsKnown: c.runsKnown ?? null,
    runsUnknownChoice: c.runsUnknownChoice ?? null,
  };
}

// completedRouteRows / inProgressRouteRows — the observed routes. Completed
// rows carry a pct of completedRuns; in-progress rows are COUNTS ONLY (the
// aggregation deliberately gives them no denominator).
export function completedRouteRows(statistics) {
  const o = statistics?.workflows?.observedRoutes;
  if (!o) return { rows: [], completedRuns: null };
  return {
    rows: (o.completed || []).map((r) => ({
      route: r.route,
      runs: r.runs ?? 0,
      runsText: formatCount(r.runs ?? 0),
      pctText: formatPct(r.pct ?? null),
      barPct: barPercent(r.pct ?? null),
    })),
    completedRuns: o.completedRuns ?? null,
  };
}

export function inProgressRouteRows(statistics) {
  const o = statistics?.workflows?.observedRoutes;
  if (!o) return { rows: [], unattributedRuns: null };
  return {
    rows: (o.inProgress || []).map((r) => ({
      route: r.route,
      runs: r.runs ?? 0,
      runsText: formatCount(r.runs ?? 0),
      pctText: null,
      barPct: 0,
    })),
    unattributedRuns: o.unattributedRuns ?? null,
  };
}

// revisionRows(statistics) — workflow_revised counts by target stages.
export function revisionRows(statistics) {
  const r = statistics?.workflows?.revisions;
  if (!r) return { count: null, rows: [] };
  return {
    count: r.count ?? 0,
    rows: (r.byTarget || []).map((t) => ({
      stagesText: (t.stages || []).join(' > '),
      count: t.count ?? 0,
      countText: formatCount(t.count ?? 0),
    })),
  };
}

// ------------------------------------------------------------------- rework

const REWORK_REASONS = ['review', 'test', 'human', 'other', 'unknown'];
const REWORK_SOURCES = ['direct', 'inferred', 'other'];

// reworkReasonRows / reworkSourceRows — EVERY enum bucket, zero counts
// included (a hidden zero would read as "no data yet" instead of "none").
export function reworkReasonRows(rework) {
  const by = rework?.byReason || {};
  return REWORK_REASONS.map((reason) => ({
    reason,
    count: by[reason] ?? 0,
    countText: formatCount(by[reason] ?? 0),
  }));
}

export function reworkSourceRows(rework) {
  const by = rework?.bySource || {};
  return REWORK_SOURCES.map((source) => ({
    source,
    count: by[source] ?? 0,
    countText: formatCount(by[source] ?? 0),
  }));
}

// reworkSummary(rework) — the headline numbers incl. the excluded buckets
// (infrastructure retries / same-attempt pairs are NOT rework; they stay
// visible so the count's denominator is auditable).
export function reworkSummary(rework) {
  if (!rework) return null;
  return {
    count: rework.count ?? 0,
    countText: formatCount(rework.count ?? 0),
    completedTasks: rework.completedTasks ?? 0,
    completedTasksText: formatCount(rework.completedTasks ?? 0),
    completedTasksAffected: rework.completedTasksAffected ?? 0,
    completedTasksAffectedText: formatCount(rework.completedTasksAffected ?? 0),
    affectedPct: rework.affectedPct ?? null,
    affectedPctText: formatPct(rework.affectedPct ?? null),
    excluded: {
      infrastructureRetry: rework.excluded?.infrastructureRetry ?? 0,
      sameAttempt: rework.excluded?.sameAttempt ?? 0,
      incomplete: rework.excluded?.incomplete ?? 0,
      unattributed: rework.excluded?.unattributed ?? 0,
    },
  };
}

// reworkEventRows(rework) — the drilldown events the payload may carry
// (rework.events, added by the parent slice). Only the payload's own fields
// are rendered; a canonical taskKey gets an exact cockpit link, anything
// else stays a plain row (no invented links).
export function reworkEventRows(rework) {
  const events = rework?.events;
  if (!Array.isArray(events)) return [];
  return events.map((e, i) => {
    const taskKey = e?.taskKey ?? null;
    return {
      key: String(e?.evidenceRef ?? e?.workflowRunId ?? i),
      taskKey,
      taskKeyHref: isCanonicalTaskKey(taskKey)
        ? '/work/' + encodeURIComponent(taskKey) + '/cockpit'
        : null,
      workflowRunId: e?.workflowRunId ?? null,
      fromAttemptId: e?.fromAttemptId ?? null,
      toAttemptId: e?.toAttemptId ?? null,
      reason: e?.reason ?? null,
      source: e?.source ?? null,
      evidenceRef: e?.evidenceRef ?? null,
    };
  });
}

// ----------------------------------------------------------------- coverage

// coverageWarnings(statistics) — the explanatory list behind the partial-data
// banner, one human sentence per nonzero data-quality counter, plus the
// unknown-coverage case. Zero counters never appear (no noise), and nothing
// here invents a cause.
export function coverageWarnings(statistics) {
  const c = statistics?.coverage;
  if (!c) return [];
  const out = [];
  const push = (n, sentence) => { if ((n ?? 0) > 0) out.push(`${n} ${sentence}`); };
  push(c.duplicateEventIds, 'duplicate event records ignored (idempotent replay)');
  push(c.duplicateSpanIds, 'duplicate span records ignored');
  push(c.invalidEvents, 'event records dropped as malformed');
  push(c.openSpansDropped, 'open or invalid spans dropped (never extended)');
  push(c.spansWithoutActor, 'spans dropped for lack of an actor');
  push(c.attemptEventsWithoutId, 'stage attempt events without an attemptId ignored');
  push(c.actorsWithoutEligible, 'actors with an unknown eligible lifetime (missing supervisor lifecycle)');
  for (const u of c.unknownEventTypes || []) out.push(`${u.count} events of an unknown type "${u.type}" ignored`);
  for (const u of c.unknownSpanNames || []) out.push(`${u.count} spans of an unknown name "${u.name}" ignored`);
  // Coverage unknown (e.g. open lifetime without a window bound) is a warning
  // in its own right — a null percentage must be explained, not shown mute.
  if (c.coveragePct == null) {
    out.push('team coverage is unknown (no bounded eligible lifetime in this window)');
  }
  return out;
}