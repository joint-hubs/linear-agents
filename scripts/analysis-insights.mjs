#!/usr/bin/env node
/**
 * scripts/analysis-insights.mjs — FOC-787 Insights panels: tickets, money,
 * outliers.
 *
 * The three analyses live in the marimo notebook (fenix/tasks.py,
 * fenix/outliers.py, fenix/stats.py) and run only in a Python runtime on a
 * parquet copy. This module ports the definitions 1:1 to plain JS so the
 * dashboard's Analysis screen can serve them live from the derived analysis
 * cache (scripts/analysis-cache.mjs):
 *
 *   tickets  — the price of a ticket: direct cost per task (run→task links,
 *              asof-backward attribution like the notebook's assign_tasks),
 *              plus the loaded cost (supervisor overhead allocated by the
 *              active/adjacent/idle rule), summarized p20/p50/p80 per era.
 *   money    — where the money goes: cost per squad, the supervisor split
 *              active/adjacent/idle, and concentration of direct task cost
 *              (Gini, Lorenz curve, top-k shares).
 *   outliers — the outlier ledger: modified z-score (MAD, |z| > 3.5) and
 *              Tukey fences (mild 1.5·IQR / far 3·IQR) on log10(cost);
 *              consensus = 2 flags (MAD_Z / MIN_CONSENSUS from fenix/config.py).
 *
 * Units with no direct cost are masked out of every detector (the notebook's
 * audit BŁĄD-3): they carry direction "unpriced", null scores and no flags.
 * Isolation forest and MCD need sklearn and stay in the notebook — the panel
 * states that in its definition line.
 *
 * Read-only: panels take an already-open read-only db (the cache) and only
 * SELECT. Filter values travel as bound parameters via filterSql — never
 * string-concatenated. Money and shares are rounded to 4 decimals.
 */

import { normalizeFilters, filterSql } from "./telemetry-analysis.mjs";

/** The child squads whose usage attributes to tickets; everything else is overhead. */
const TASK_SQUADS = ["plan", "dev", "review", "test"];
const SUP_SQUAD = "supervisor";

// fenix/config.py, ported verbatim.
export const MAD_Z = 3.5;
export const MIN_CONSENSUS = 2;
export const TUKEY_MILD = 1.5;
export const TUKEY_FAR = 3;
export const MAX_GAP_MIN = 30;
export const LOG_FLOOR = 1e-4;

const round4 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10000) / 10000);

// Mirror of telemetry-analysis.mjs's SYNTHETIC predicate in JS: a Claude Code
// placeholder row (sentinel model, or no model and no tokens) can never be
// priced, so it is not "unpriced" either.
function isSynthetic(row) {
  if (row.model === "synthetic" || row.model === "<synthetic>") return true;
  const tokens = (row.input_tokens ?? 0) + (row.output_tokens ?? 0)
    + (row.cache_read_tokens ?? 0) + (row.cache_creation_tokens ?? 0);
  return (row.model == null) && tokens === 0;
}

// ---------------------------------------------------------------------------
// Pure statistics helpers (fenix/stats.py, numpy-default linear interpolation)
// ---------------------------------------------------------------------------

/**
 * Percentiles with numpy's default "linear" interpolation: for quantile q,
 * h = (n-1)·q and the result is x[floor(h)] + (h - floor(h))·(x[floor(h)+1] - x[floor(h)]).
 * Nulls and non-finite values are dropped first (like the notebook's dropna()).
 */
export function quantiles(values, qs = [0.2, 0.5, 0.8]) {
  const x = (values ?? []).filter((v) => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  return qs.map((q) => {
    if (x.length === 0) return null;
    const h = (x.length - 1) * q;
    const lo = Math.floor(h);
    const hi = Math.ceil(h);
    return lo === hi ? x[lo] : x[lo] + (h - lo) * (x[hi] - x[lo]);
  });
}

/**
 * Seeded PRNG (mulberry32, a standard 32-bit generator) so the bootstrap CI is
 * reproducible — the same seed always yields the same interval, which the
 * ticket panel's contract promises (seed = 42, 2000 resamples).
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const median = (sorted) => {
  const n = sorted.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * Percentile bootstrap CI of the median (fenix/stats.py bootstrap_ci with
 * stat=np.median, n_boot=2000, alpha=0.05). Resample indices are drawn from
 * the seeded mulberry32 generator; the interval bounds are the alpha/2 and
 * 1-alpha/2 quantiles (linear interpolation) of the bootstrap medians.
 * Returns [lo, hi]; nulls when there are no finite values.
 */
export function bootstrapMedianCi(values, { seed = 42, n = 2000, alpha = 0.05 } = {}) {
  const x = (values ?? []).filter((v) => v != null && Number.isFinite(v));
  if (x.length === 0) return [null, null];
  const rng = mulberry32(seed);
  const boots = new Array(n);
  for (let b = 0; b < n; b++) {
    const sample = new Array(x.length);
    for (let i = 0; i < x.length; i++) sample[i] = x[Math.floor(rng() * x.length)];
    sample.sort((a, b2) => a - b2);
    boots[b] = median(sample);
  }
  boots.sort((a, b2) => a - b2);
  const at = (q) => {
    const h = (n - 1) * q;
    const lo = Math.floor(h);
    const hi = Math.ceil(h);
    return lo === hi ? boots[lo] : boots[lo] + (h - lo) * (boots[hi] - boots[lo]);
  };
  return [at(alpha / 2), at(1 - alpha / 2)];
}

/**
 * Gini coefficient (fenix/stats.py gini): sorted values, weighted sum
 * (2·Σ i·x_i − (n+1)·Σx) / (n·Σx) with i starting at 1. 0 = perfectly equal,
 * → 1 = all cost in one unit. Empty or zero-sum input → null (nothing to say).
 */
export function gini(values) {
  const x = (values ?? []).filter((v) => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  const n = x.length;
  const total = x.reduce((s, v) => s + v, 0);
  if (n === 0 || total === 0) return null;
  let weighted = 0;
  for (let i = 1; i <= n; i++) weighted += (2 * i - n - 1) * x[i - 1];
  return weighted / (n * total);
}

/**
 * Lorenz curve of `values` on 21 evenly spaced steps 0..1 (the contract's
 * point count; the notebook returns one point per unit). Point i is
 * (i/20, cumulative cost share of the ceil(i·n/20) cheapest units), so it runs
 * [0,0] → [1,1].
 */
export function lorenz(values) {
  const x = (values ?? []).filter((v) => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  const total = x.reduce((s, v) => s + v, 0);
  const points = [];
  for (let i = 0; i <= 20; i++) {
    if (x.length === 0 || total === 0) { points.push([i / 20, i / 20]); continue; }
    const k = Math.ceil((i / 20) * x.length);
    const cum = x.slice(0, k).reduce((s, v) => s + v, 0);
    points.push([i / 20, cum / total]);
  }
  return points;
}

/**
 * Top-k concentration: the share of the total held by the top k fraction of
 * units, k = max(1, ceil(frac·n)) (fenix/stats.py top_share semantics — the
 * panel contract's "share of the total spent by the top k %").
 */
export function hillTail(values, kFracs = [0.05, 0.1, 0.2]) {
  const x = (values ?? []).filter((v) => v != null && Number.isFinite(v)).sort((a, b) => b - a);
  const total = x.reduce((s, v) => s + v, 0);
  return kFracs.map((k) => {
    if (x.length === 0 || total === 0) return { k, share: null };
    const top = Math.max(1, Math.ceil(k * x.length));
    return { k, share: round4(x.slice(0, top).reduce((s, v) => s + v, 0) / total) };
  });
}

// ---------------------------------------------------------------------------
// Outlier detectors (fenix/outliers.py, detectors 1–2; 3–4 stay in the notebook)
// ---------------------------------------------------------------------------

/**
 * Modified z-score (Iglewicz & Hoaglin) on already-log10-ed values:
 * 0.6745·(x − median)/MAD, MAD = median absolute deviation. A zero MAD (all
 * values equal) yields null — nothing is an outlier in a constant population.
 * Input entries may be null (unpriced units) → null z.
 */
export function modifiedZ(logValues) {
  const finite = (logValues ?? []).filter((v) => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  const med = median(finite);
  if (med == null) return logValues.map(() => null);
  const deviations = finite.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
  const mad = median(deviations);
  if (!mad) return logValues.map(() => null);
  return logValues.map((v) => (v == null || !Number.isFinite(v) ? null : (0.6745 * (v - med)) / mad));
}

/**
 * Tukey fences on already-log10-ed values: q1/q3 with linear interpolation,
 * mild = 1.5·IQR, far = 3·IQR. Returns per-value flags { mild, far }.
 */
export function tukeyFlags(logValues) {
  const finite = (logValues ?? []).filter((v) => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  const [q1, q3] = quantiles(finite, [0.25, 0.75]);
  if (q1 == null || q3 == null) {
    return (logValues ?? []).map(() => ({ mild: false, far: false }));
  }
  const iqr = q3 - q1;
  return (logValues ?? []).map((v) => {
    if (v == null || !Number.isFinite(v)) return { mild: false, far: false };
    return {
      mild: v < q1 - TUKEY_MILD * iqr || v > q3 + TUKEY_MILD * iqr,
      far: v < q1 - TUKEY_FAR * iqr || v > q3 + TUKEY_FAR * iqr,
    };
  });
}

/**
 * detectOutliers(tasks) — the notebook's detect() restricted to the two JS
 * detectors. `tasks` = [{ taskId, costUsd (null = unpriced), ... }]. Cost is
 * log10(max(cost, 1e-4)); unpriced tasks are masked out of the detectors
 * (audit BŁĄD-3): null scores, no flags, direction "unpriced".
 * nFlags counts flagMad + flagTukeyFar (the plan's contract: flag_tukey = far;
 * the notebook's mild/far distinction kept in flagTukeyMild/flagTukeyFar).
 * consensus = nFlags >= MIN_CONSENSUS (2).
 */
export function detectOutliers(tasks, { madZ = MAD_Z, consensusMin = MIN_CONSENSUS } = {}) {
  const logValues = tasks.map((t) =>
    (t.costUsd == null || !Number.isFinite(t.costUsd) ? null : Math.log10(Math.max(t.costUsd, LOG_FLOOR))));
  const zs = modifiedZ(logValues);
  const tukeys = tukeyFlags(logValues);
  return tasks.map((t, i) => {
    const z = zs[i];
    const logCost = logValues[i];
    if (logCost == null) {
      return { ...t, logCost: null, madZ: null, flagMad: false, flagTukeyMild: false, flagTukeyFar: false, nFlags: 0, consensus: false, direction: "unpriced" };
    }
    const flagMad = z != null && Math.abs(z) > madZ;
    const flagTukeyMild = tukeys[i].mild;
    const flagTukeyFar = tukeys[i].far;
    const nFlags = (flagMad ? 1 : 0) + (flagTukeyFar ? 1 : 0);
    return {
      ...t,
      logCost,
      madZ: z,
      flagMad,
      flagTukeyMild,
      flagTukeyFar,
      nFlags,
      consensus: nFlags >= consensusMin,
      // np.where(mad_z >= 0, "high", "low"): a null z (MAD = 0) is NaN there
      // and falls to "low" — mirror that exactly.
      direction: z != null && z >= 0 ? "high" : "low",
    };
  });
}

// ---------------------------------------------------------------------------
// Task attribution + supervisor allocation (fenix/tasks.py)
// ---------------------------------------------------------------------------

/** Era of a timestamp against the boundary; null timestamps have no era. */
export function eraOf(ts, boundary) {
  if (ts == null) return null;
  return Date.parse(ts) < Date.parse(boundary) ? "pre" : "post";
}

/**
 * Attribute canonical_usage rows to tasks (fenix/tasks.py assign_tasks, the
 * asof-backward merge): per run, the link with the newest valid_from <= the
 * message time; messages before the run's first link go to that first link
 * (pre_link). SUP: ids are synthetic and never count as tickets; rows of runs
 * with no link (or after only-SUP links) are dropped. Both are counted.
 *
 * usageRows: [{ usageId, runId, observedAt, costUsd, model, inputTokens, ... }]
 * links:     [{ runId, taskId, validFrom }]
 * → { tasks: Map<taskId, { taskId, firstTs, lastTs, msgs, unpricedMsgs, unpricedShare, costUsd, runs:Set }>,
 *     droppedSup, droppedNoLink, droppedUsd }
 */
export function buildTaskTable(usageRows, links, { eraBoundary } = {}) {
  const byRun = new Map();
  for (const l of links ?? []) {
    if (!byRun.has(l.runId)) byRun.set(l.runId, []);
    byRun.get(l.runId).push(l);
  }
  for (const list of byRun.values()) list.sort((a, b) => a.validFrom.localeCompare(b.validFrom));

  const tasks = new Map();
  let droppedSup = 0;
  let droppedNoLink = 0;
  let droppedUsd = 0;

  for (const row of usageRows ?? []) {
    const runLinks = byRun.get(row.runId) ?? [];
    let assigned = null;
    let alloc = "unlinked";
    if (runLinks.length > 0) {
      // newest link with valid_from <= observedAt (binary search over the
      // sorted list — the asof-backward merge)
      let lo = 0;
      let hi = runLinks.length - 1;
      let found = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (runLinks[mid].validFrom.localeCompare(row.observedAt) <= 0) { found = mid; lo = mid + 1; }
        else hi = mid - 1;
      }
      if (found >= 0) {
        assigned = runLinks[found].taskId;
        alloc = "window";
      } else {
        // pre_link fallback: the run's earliest link
        assigned = runLinks[0].taskId;
        alloc = "pre_link";
      }
    }
    if (assigned == null) { droppedNoLink++; continue; }
    if (assigned.startsWith("SUP:")) {
      droppedSup++;
      const c = row.costUsd ?? 0;
      if (Number.isFinite(c)) droppedUsd += c;
      continue;
    }

    const synthetic = isSynthetic(row);
    const unpriced = row.costUsd == null && !synthetic;
    let t = tasks.get(assigned);
    if (!t) {
      t = { taskId: assigned, firstTs: null, lastTs: null, msgs: 0, unpricedMsgs: 0, costSum: 0, hasPriced: false, runs: new Set() };
      tasks.set(assigned, t);
    }
    t.msgs++;
    if (unpriced) t.unpricedMsgs++;
    if (row.costUsd != null && Number.isFinite(row.costUsd)) { t.costSum += row.costUsd; t.hasPriced = true; }
    if (row.observedAt != null) {
      if (t.firstTs == null || row.observedAt < t.firstTs) t.firstTs = row.observedAt;
      if (t.lastTs == null || row.observedAt > t.lastTs) t.lastTs = row.observedAt;
    }
    if (row.runId != null) t.runs.add(row.runId);
  }

  for (const t of tasks.values()) {
    t.costUsd = t.hasPriced ? t.costSum : null; // min_count=1: no priced row → null, not 0
    t.unpricedShare = t.msgs > 0 ? t.unpricedMsgs / t.msgs : 0;
    t.era = eraOf(t.firstTs, eraBoundary);
  }
  return { tasks, droppedSup, droppedNoLink, droppedUsd };
}

/**
 * Allocate supervisor-session messages to the tickets being worked at that
 * moment (fenix/tasks.py allocate_supervisor_overhead, max_gap_min = 30):
 *
 *   active   — a plan/dev/review/test run that is linked to ≥ 1 real task
 *              overlaps the message time; cost split equally over those runs'
 *              tasks (w = 1/n over the union).
 *   adjacent — no child running, but one starts/ends within maxGapMin of the
 *              message (the nearest run by that distance); its tasks.
 *   idle     — otherwise: pure overhead, task = none.
 *
 * supRows: [{ usageId, runId, observedAt, costUsd }]
 * childRuns: [{ runId, startedAt, endedAt }] (endedAt null → the horizon)
 * tasksByRun: Map<runId, string[]> — real (non-SUP:) tasks per run.
 * → [{ usageId, runId, mode, tasks, w, costUsd }] — w sums to 1 per message.
 */
export function allocateSupervisorOverhead(supRows, childRuns, tasksByRun, { maxGapMin = MAX_GAP_MIN, horizon } = {}) {
  const gapMs = maxGapMin * 60 * 1000;
  const kids = (childRuns ?? [])
    .filter((r) => (tasksByRun.get(r.runId) ?? []).length > 0)
    .map((r) => ({
      runId: r.runId,
      start: Date.parse(r.startedAt),
      end: r.endedAt != null ? Date.parse(r.endedAt) : Date.parse(horizon),
      tasks: tasksByRun.get(r.runId),
    }))
    .filter((k) => Number.isFinite(k.start))
    .sort((a, b) => a.start - b.start);

  return (supRows ?? []).map((row) => {
    const t = Date.parse(row.observedAt);
    const base = { usageId: row.usageId, runId: row.runId, costUsd: row.costUsd, observedAt: row.observedAt };
    if (!Number.isFinite(t) || kids.length === 0) return { ...base, mode: "idle", tasks: [], w: 1 };

    const overlapping = kids.filter((k) => k.start <= t && t <= k.end);
    if (overlapping.length > 0) {
      const taskSet = new Set();
      for (const k of overlapping) for (const task of k.tasks) taskSet.add(task);
      const tasks = [...taskSet].sort();
      return { ...base, mode: "active", tasks, w: 1 / tasks.length };
    }
    let nearest = null;
    let best = Infinity;
    for (const k of kids) {
      const dist = Math.max(Math.max(k.start - t, t - k.end), 0);
      if (dist < best) { best = dist; nearest = k; }
    }
    if (nearest && best <= gapMs) {
      return { ...base, mode: "adjacent", tasks: nearest.tasks, w: 1 / nearest.tasks.length };
    }
    return { ...base, mode: "idle", tasks: [], w: 1 };
  });
}

/**
 * fenix/tasks.py add_loaded_cost: sup_active/sup_adjacent per task (Σ w·cost),
 * cost_loaded = direct + active + adjacent. NaN semantics (audit BŁĄD-2): a
 * missing allocation is a true 0, but a missing DIRECT cost is unknown —
 * cost_loaded stays null for such tasks instead of quietly becoming
 * "supervisor slice only". cost_loaded_partial marks tasks whose direct cost
 * is known but whose messages were only partly priced.
 */
export function addLoadedCost(taskTable, alloc) {
  const sup = new Map(); // taskId → { active, adjacent }
  for (const a of alloc ?? []) {
    if (a.mode === "idle" || !a.tasks?.length) continue;
    const c = (a.costUsd ?? 0) * a.w;
    if (!Number.isFinite(c)) continue;
    for (const taskId of a.tasks) {
      const s = sup.get(taskId) ?? { active: 0, adjacent: 0 };
      s[a.mode] += c;
      sup.set(taskId, s);
    }
  }
  for (const t of taskTable.values()) {
    const s = sup.get(t.taskId) ?? { active: 0, adjacent: 0 };
    t.supActive = s.active;
    t.supAdjacent = s.adjacent;
    t.costLoaded = t.costUsd == null ? null : t.costUsd + s.active + s.adjacent;
    t.partial = t.costLoaded != null && t.unpricedShare > 0;
  }
  return taskTable;
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

const DEFINITION_TICKETS =
  "direct = priced cost of plan/dev/review/test messages attributed to the ticket by the run→task links; " +
  "loaded = direct + the Supervisor messages active on or adjacent (≤ 30 min) to its runs";
const DEFINITION_MONEY =
  "priced cost per squad; Supervisor messages split into active / adjacent / idle by the allocation rule; " +
  "concentration of direct ticket cost";
const DEFINITION_OUTLIERS =
  "task cost on log10; modified z-score (MAD, |z| > 3.5) and Tukey far fence (3·IQR); consensus = both; " +
  "isolation forest and MCD stay in the notebook";

/**
 * Read the task-attribution inputs off the cache WITHOUT any filters — the
 * full-history inputs the cache build runs the same attribution the panels
 * would run per request (FOC-915: the derived task_table + supervisor_alloc
 * are built ONCE here, so the panels read indexed rows instead of recomputing
 * the run→task attribution of ~180k rows on every call).
 *
 * Same selects as loadTasks below, with no filter WHERE on the usage rows and
 * no era narrowing — the caller filters afterwards, per task first_ts
 * (tickets, concentration) or per message time (spend).
 */
export function loadTasksUnfiltered(db) {
  const usageRows = db.prepare(`
    SELECT usage_id AS usageId, run_id AS runId, observed_at AS observedAt,
           cost_usd AS costUsd, model, input_tokens AS inputTokens,
           output_tokens AS outputTokens, cache_read_tokens AS cacheReadTokens,
           cache_creation_tokens AS cacheCreationTokens
    FROM canonical_usage WHERE squad IN (${TASK_SQUADS.map((s) => `'${s}'`).join(", ")})
  `).all();

  const supRows = db.prepare(`
    SELECT usage_id AS usageId, run_id AS runId, observed_at AS observedAt, cost_usd AS costUsd
    FROM canonical_usage WHERE squad = '${SUP_SQUAD}'
  `).all();

  const links = db.prepare(
    "SELECT run_id AS runId, task_id AS taskId, valid_from AS validFrom FROM run_task_links",
  ).all();

  const childRuns = db.prepare(`
    SELECT r.run_id AS runId, r.started_at AS startedAt, r.ended_at AS endedAt
    FROM runs r WHERE r.squad IN ('plan', 'dev', 'review', 'test')
  `).all();

  const horizon = db.prepare("SELECT MAX(observed_at) AS m FROM canonical_usage").get().m;

  const tasksByRun = new Map();
  for (const l of links) {
    if (l.taskId.startsWith("SUP:")) continue;
    if (!tasksByRun.has(l.runId)) tasksByRun.set(l.runId, new Set());
    tasksByRun.get(l.runId).add(l.taskId);
  }
  const tasksByRunArr = new Map([...tasksByRun].map(([k, v]) => [k, [...v].sort()]));

  return { usageRows, supRows, links, childRuns, horizon, tasksByRun: tasksByRunArr };
}

/**
 * The precomputed task table, as persisted by the cache build (FOC-915):
 * one row per task with its direct cost, supervisor split and loaded cost.
 * Column names follow the tickets panel's row shape so the panels can consume
 * the rows with the same mapping they already apply.
 *
 * `era` is RE-DERIVED at read time from first_ts against the caller's
 * boundary (the query may carry a custom eraBoundary; the persisted column
 * holds the build-time default only). One Date.parse per task, no recompute
 * of the attribution itself.
 */
function readTaskTable(db, boundary) {
  const rows = db.prepare(`
    SELECT task_id AS taskId, first_ts AS firstTs, msgs,
           cost_usd AS costUsd, unpriced_share AS unpricedShare,
           sup_active AS supActive, sup_adjacent AS supAdjacent,
           cost_loaded AS costLoaded, partial
    FROM insight_task_table
  `).all();
  // SQLite has no boolean type: partial is stored as 0/1 and round-tripped
  // through JSON as a number — the panels emit `partial: true/false`, so the
  // row is normalized here, at the read boundary.
  for (const r of rows) {
    r.partial = Boolean(r.partial);
    r.era = eraOf(r.firstTs, boundary);
  }
  return rows;
}

/** The precomputed supervisor allocation, as persisted by the cache build. */
function readSupervisorAlloc(db) {
  return db.prepare(`
    SELECT usage_id AS usageId, run_id AS runId, observed_at AS observedAt,
           mode, cost_usd AS costUsd, tasks_json AS tasksJson
    FROM insight_supervisor_alloc
  `).all();
}

/**
 * The build-time attribution-drop counts (insight_meta), for the caveats the
 * tickets panel emits: rows attributed to SUP: ids and rows of runs with no
 * link. Absent (older cache, or a cache whose build predates the table) →
 * zeros — the caveats simply do not fire.
 */
function readInsightMeta(db) {
  const rows = db.prepare("SELECT key, value FROM insight_meta").all();
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    droppedSup: Number(m.dropped_sup_rows ?? 0),
    droppedUsd: Number(m.dropped_sup_usd ?? 0),
    droppedNoLink: Number(m.dropped_no_link_rows ?? 0),
  };
}

function distributionStats(values) {
  const [p20, p50, p80] = quantiles(values);
  const [lo, hi] = bootstrapMedianCi(values);
  return { p20: round4(p20), p50: round4(p50), p80: round4(p80), medianCi: [round4(lo), round4(hi)] };
}

/**
 * GET /api/analysis/tickets — the price of a ticket. Era filters on the
 * task's first_ts; era=all gives both eras side by side.
 *
 * FOC-915: the task table is PRECOMPUTED in the cache (insight_task_table);
 * this panel reads those rows and narrows them by the filters — per task
 * first_ts (from/to via the era-carrying window, era per first_ts) — instead
 * of re-attributing ~180k usage rows per request. The payload is the shape
 * the panel has always returned.
 *
 * The `usageRows`-based time window: a task is in scope when its first message
 * falls in [from, to] — the same window the panel documented when it computed
 * the table from filtered rows, now applied to the precomputed rows directly.
 */
export function ticketsPanel(db, filters) {
  const f = normalizeFilters(filters);
  const meta = readInsightMeta(db);
  return ticketsPanelFromRows(readTaskTable(db, f.eraBoundary), readSupervisorAlloc(db), f, meta);
}

/**
 * The tickets panel over precomputed rows — exported for the cache-build
 * self-check and tests that pin the payload against hand-computed numbers.
 */
export function ticketsPanelFromRows(taskRows, _allocRows, f, meta = { droppedSup: 0, droppedUsd: 0, droppedNoLink: 0 }) {
  // Era filters on the task's first_ts (D2); from/to narrow the same column.
  let tasks = taskRows.filter((t) =>
    (f.from == null || (t.firstTs != null && t.firstTs >= f.from)) &&
    (f.to == null || (t.firstTs != null && t.firstTs <= f.to)));
  const noTs = taskRows.filter((t) => t.firstTs == null).length;
  tasks = tasks.filter((t) => t.firstTs != null); // D1: no timestamp → no era → excluded, counted
  const inEra = f.era === "all" ? tasks : tasks.filter((t) => t.era === f.era);

  const eras = (f.era === "all" ? ["pre", "post"] : [f.era]).map((era) => {
    const group = inEra.filter((t) => t.era === era);
    const direct = group.filter((t) => t.costUsd != null).map((t) => t.costUsd);
    const loaded = group.filter((t) => t.costLoaded != null).map((t) => t.costLoaded);
    return {
      era,
      tasks: group.length,
      direct: distributionStats(direct),
      loaded: distributionStats(loaded),
      partial: group.filter((t) => t.partial).length,
    };
  });

  const unpricedTasks = inEra.filter((t) => t.costUsd == null).length;
  const caveats = [];
  if (unpricedTasks > 0) {
    caveats.push({
      level: "warn",
      code: "unpriced_tasks",
      message: `${unpricedTasks} task(s) have no priced cost at all (cost_usd NULL on every message) — they are excluded from the percentile and concentration statistics, not counted as $0`,
      count: unpricedTasks,
    });
  }
  if (meta.droppedSup > 0) {
    caveats.push({
      level: "info",
      code: "sup_links_dropped",
      message: `${meta.droppedSup} message(s) attributed to a SUP: supervisor-session id ($${round4(meta.droppedUsd)}) are not counted as tickets`,
      count: meta.droppedSup,
    });
  }
  if (meta.droppedNoLink > 0) {
    caveats.push({
      level: "info",
      code: "unattributed_rows",
      message: `${meta.droppedNoLink} message(s) of runs with no task link are unattributed`,
      count: meta.droppedNoLink,
    });
  }
  if (inEra.length === 0) {
    caveats.push({ level: "info", code: "empty", message: "no tasks match the current filters" });
  }
  if (f.squad || f.model) {
    caveats.push({
      level: "warn",
      code: "supervisor_rows_unfiltered",
      message: "the Supervisor allocation ignores the squad/model filter (it is a property of the ticket, not of the filter)",
    });
  }

  const rows = inEra
    .sort((a, b) => (b.costUsd ?? -Infinity) - (a.costUsd ?? -Infinity))
    .map((t) => ({
      taskId: t.taskId,
      era: t.era,
      firstTs: t.firstTs,
      msgs: t.msgs,
      costUsd: round4(t.costUsd),
      costLoaded: round4(t.costLoaded),
      supActive: round4(t.supActive),
      supAdjacent: round4(t.supAdjacent),
      unpricedShare: round4(t.unpricedShare),
      partial: t.partial,
    }));

  return {
    filters: f,
    data: {
      definition: DEFINITION_TICKETS,
      tasks: inEra.length,
      priced: inEra.filter((t) => t.costUsd != null).length,
      unpriced: unpricedTasks,
      eras,
      rows,
    },
    caveats,
  };
}

/**
 * GET /api/analysis/money — where the money goes: per-squad cost, the
 * supervisor active/adjacent/idle split, and the concentration of direct
 * ticket cost.
 *
 * FOC-915: spend (total, bySquad) reads canonical_usage through the SAME
 * indexed WHERE as before — it was never the bottleneck. The supervisor split
 * reads the precomputed insight_supervisor_alloc rows (narrowed by message
 * time); concentration reads insight_task_table narrowed by task first_ts —
 * the windows the panel documents today.
 */
export function moneyPanel(db, filters) {
  const f = normalizeFilters(filters);
  const { where, params } = filterSql(f);
  const cond = (extra) => (where ? `${where} AND (${extra})` : `WHERE ${extra}`);
  const one = (sql) => db.prepare(sql).get(...params);

  const totalRow = one(`
    SELECT COUNT(*) AS turns, SUM(COALESCE(cost_usd, 0)) AS usd FROM canonical_usage ${where}
  `);
  const total = totalRow.usd ?? 0;

  const bySquad = db.prepare(`
    SELECT squad, SUM(COALESCE(cost_usd, 0)) AS usd
    FROM canonical_usage ${cond("squad IS NOT NULL")}
    GROUP BY squad ORDER BY usd DESC, squad
  `).all(...params).map((r) => ({
    squad: r.squad,
    costUsd: round4(r.usd ?? 0),
    share: total > 0 ? round4((r.usd ?? 0) / total) : 0,
  }));

  // The supervisor split, from the precomputed allocation narrowed by message
  // time. The sup rows carry no squad/model/era — exactly what the old
  // loadTasks did (fRows forced era:'all' and deleted squad/model): the
  // allocation is a property of the ticket, not of the filter — the caveat
  // below says so when one is set. The time parts (from/to) stay.
  const { where: supWhere, params: supParams } = filterSql({
    ...f,
    era: "all",
    squad: undefined,
    model: undefined,
  });
  const supCond = (extra) => (supWhere ? `${supWhere} AND (${extra})` : `WHERE ${extra}`);
  const allocRows = db.prepare(`
    SELECT usage_id AS usageId, run_id AS runId, observed_at AS observedAt, mode, cost_usd AS costUsd
    FROM insight_supervisor_alloc ${supCond("mode IS NOT NULL")}
  `).all(...supParams);

  const supCost = allocRows.reduce((s, r) => s + (r.costUsd ?? 0), 0);
  const byMode = { active: 0, adjacent: 0, idle: 0 };
  for (const a of allocRows) byMode[a.mode] += a.costUsd ?? 0;

  // Concentration over the tasks IN SCOPE — precomputed rows narrowed by
  // first_ts (D2: the same first_ts era rule; from/to on first_ts).
  const taskRows = readTaskTable(db, f.eraBoundary).filter((t) =>
    (f.from == null || (t.firstTs != null && t.firstTs >= f.from)) &&
    (f.to == null || (t.firstTs != null && t.firstTs <= f.to)));
  const inEra = f.era === "all"
    ? taskRows
    : taskRows.filter((t) => t.era === f.era);

  const pricedCosts = inEra.filter((t) => t.costUsd != null).map((t) => t.costUsd);
  const concentration = {
    gini: round4(gini(pricedCosts)),
    top: hillTail(pricedCosts),
    lorenz: lorenz(pricedCosts).map(([p, c]) => [round4(p), round4(c)]),
  };

  const caveats = [];
  // total/bySquad/supervisor filter the rows by observed_at, concentration
  // filters the tasks by first_ts — state the split so the two windows are
  // not read as one.
  caveats.push({
    level: "info",
    code: "money_mixed_windows",
    message: "spend is counted by message time; concentration by the ticket's first message",
  });
  if (f.squad || f.model) {
    caveats.push({
      level: "warn",
      code: "supervisor_rows_unfiltered",
      message: "the Supervisor allocation ignores the squad/model filter (it is a property of the ticket, not of the filter)",
    });
  }
  if (supCost > 0 && byMode.idle / supCost > 0.5) {
    caveats.push({
      level: "warn",
      code: "sup_idle_heavy",
      message: `${round4((100 * byMode.idle) / supCost)}% of supervisor spend is idle (no child run within 30 min) — pure overhead, attributable to no ticket`,
      count: null,
    });
  }
  if (totalRow.turns === 0) {
    caveats.push({ level: "info", code: "empty", message: "no canonical usage rows match the current filters" });
  }

  return {
    filters: f,
    data: {
      definition: DEFINITION_MONEY,
      total: round4(total),
      bySquad,
      supervisor: {
        costUsd: round4(supCost),
        active: round4(byMode.active),
        adjacent: round4(byMode.adjacent),
        idle: round4(byMode.idle),
        idleShare: supCost > 0 ? round4(byMode.idle / supCost) : 0,
      },
      concentration,
    },
    caveats,
  };
}

/**
 * GET /api/analysis/outliers — the outlier ledger. Every task is listed with
 * its detector columns so the evidence behind a point is one click away
 * (/work/<taskId>).
 *
 * FOC-915: the detectors run over the PRECOMPUTED task table narrowed by
 * first_ts (from/to/era) instead of re-attributing the usage rows per request.
 * The detection itself is unchanged — the same detectOutliers over the same
 * per-task costs.
 */
export function outliersPanel(db, filters) {
  const f = normalizeFilters(filters);
  const taskRows = readTaskTable(db, f.eraBoundary).filter((t) =>
    (f.from == null || (t.firstTs != null && t.firstTs >= f.from)) &&
    (f.to == null || (t.firstTs != null && t.firstTs <= f.to)));
  // Era filters on the task's first_ts, like the tickets panel (D2).
  const all = f.era === "all"
    ? taskRows
    : taskRows.filter((t) => t.era === f.era);
  const detected = detectOutliers(all.map((t) => ({ taskId: t.taskId, era: t.era, costUsd: t.costUsd, msgs: t.msgs })));
  const consensusRows = detected.filter((r) => r.consensus);

  const priced = all.filter((t) => t.costUsd != null);
  const consensusIds = new Set(consensusRows.map((r) => r.taskId));
  const without = priced.filter((t) => !consensusIds.has(t.taskId));
  const sortedAll = priced.map((t) => t.costUsd).sort((a, b) => a - b);
  const sortedWithout = without.map((t) => t.costUsd).sort((a, b) => a - b);

  const caveats = [];
  const unpricedCount = all.filter((t) => t.costUsd == null).length;
  if (unpricedCount > 0) {
    caveats.push({
      level: "info",
      code: "unpriced_masked",
      message: `${unpricedCount} task(s) with no direct cost are masked out of the detectors (audit BŁĄD-3) — direction "unpriced", no flags`,
      count: unpricedCount,
    });
  }
  caveats.push({
    level: "info",
    code: "notebook_detectors",
    message: "isolation forest and MCD (detectors 3–4) need sklearn and stay in the notebook — consensus here means MAD + Tukey far",
  });
  if (all.length === 0) {
    caveats.push({ level: "info", code: "empty", message: "no tasks match the current filters" });
  }

  return {
    filters: f,
    data: {
      definition: DEFINITION_OUTLIERS,
      tasks: all.length,
      flagged: consensusRows.length,
      detectors: ["mad", "tukey"],
      consensusMin: MIN_CONSENSUS,
      rows: detected
        .sort((a, b) => (b.costUsd ?? -Infinity) - (a.costUsd ?? -Infinity))
        .map((r) => ({
          taskId: r.taskId,
          era: r.era,
          costUsd: round4(r.costUsd),
          logCost: r.logCost == null ? null : round4(r.logCost),
          madZ: r.madZ == null ? null : round4(r.madZ),
          flagMad: r.flagMad,
          flagTukeyMild: r.flagTukeyMild,
          flagTukeyFar: r.flagTukeyFar,
          nFlags: r.nFlags,
          consensus: r.consensus,
          direction: r.direction,
          msgs: r.msgs,
        })),
      sensitivity: {
        medianAll: round4(median(sortedAll)),
        medianWithout: round4(median(sortedWithout)),
        totalAll: round4(sortedAll.reduce((s, v) => s + v, 0)),
        totalWithout: round4(sortedWithout.reduce((s, v) => s + v, 0)),
      },
    },
    caveats,
  };
}
