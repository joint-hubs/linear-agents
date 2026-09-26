#!/usr/bin/env node
/**
 * scripts/telemetry-analysis.mjs — read-side panels for the dashboard "Analysis" screen.
 *
 * Why this exists. The dashboard needs honest fleet numbers, and the raw fact
 * tables cannot provide them: usage_facts double-counts physical calls twice
 * over (ADR-0008 run-scoped claims — every run that re-ingested a transcript
 * keeps its own copy of that file's rows — and FOC-381 per-message usage
 * lines). The only correct read surface is the pair of canonical views from
 * telemetry-canonical.mjs:
 *
 *   canonical_usage          one row per physical model call  (cost, turns)
 *   canonical_tool_facts     one row per physical tool call   (repeats, errors)
 *
 * The rule enforced here (and contract-tested in telemetry-analysis.test.mjs):
 * cost and turns are ALWAYS read off canonical_usage, tool calls ALWAYS off
 * canonical_tool_facts, and the raw usage_facts table is never aggregated by
 * this module. Where evidence is thin, the panels say so — every panel returns
 * `caveats` (level info|warn|crit) instead of hiding doubt inside a number.
 *
 * This module also refuses the store's own opener: openTelemetryDb() is
 * READ-WRITE and runs migrations on open, which a dashboard render must never
 * do. openAnalysisDb() below opens a strict READ-ONLY connection — it cannot
 * migrate, lock or write the store.
 *
 * Reuse over re-implementation: repeat classification (FOC-220 categories)
 * and the honest outcome triple come from agent-behavior.mjs's exported
 * analyseToolCalls(); this file only selects the rows (filters applied as
 * bound parameters, never string-concatenated) and shapes the result.
 *
 * Era split: FOC-397 moved the runner to a graph architecture, so pre/post
 * 2026-09-22 data are different regimes. `era` filters on the panel's time
 * column against ERA_BOUNDARY; rows with no timestamp are legacy history and
 * count as `pre` (post requires a timestamp that proves it).
 *
 * costPanel reads cost/token totals off canonical_usage only; handoffsPanel
 * reads delegation_links and derives each child's cost/turns/tokens from
 * canonical_usage — aggregated once per (parent_run_id, child_agent), so a
 * run holding several links to the same child never sums that child twice.
 *
 * Read-only. Panels throw Error with .code = "views_missing" when the
 * canonical views are absent — run `node scripts/telemetry-canonical.mjs
 * --ensure` (on a writable connection) to create them.
 */

import { DatabaseSync } from "node:sqlite";
import { telemetryDbPath } from "./telemetry-store.mjs";
import { analyseToolCalls, REPEAT_CATEGORIES } from "./agent-behavior.mjs";

/** FOC-397: the graph runner merge — the pre/post era boundary. */
export const ERA_BOUNDARY = "2026-09-22T00:00:00.000Z";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const ERAS = new Set(["all", "pre", "post"]);

// The token sum the synthetic predicate below and every cost breakdown use.
// Each term is COALESCEd: a NULL column on one row must not NULL out a SUM
// — and must not make a tokenless NULL-model row look like it has tokens.
const TOKENS_SQL = `COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)
  + COALESCE(cache_read_tokens, 0) + COALESCE(cache_creation_tokens, 0)`;

// Claude Code writes placeholder usage rows under a sentinel model id — no
// API call, cost NULL — so they can never be priced and must NOT feed the
// "unpriced" alarm. telemetry-store.mjs classifies them in JS with
// isSyntheticModel() (!model || sentinel); these panels classify inside SQL,
// so the fragments below mirror that predicate, made tokens-aware on the
// NULL side: a row with no model AND no tokens is the same placeholder
// shape, but a NULL-model row WITH tokens was a real call whose model was
// lost — that one is unpriced (a model-less row can never be priced), never
// synthetic, and shows up under the model label "(none)". Turns/tokens
// totals deliberately still include synthetic rows: they are rows of the
// view; only the unpriced classification excludes them.
const SYNTHETIC_SQL = `(model IN ('synthetic', '<synthetic>')
  OR (model IS NULL AND ${TOKENS_SQL} = 0))`;
const NOT_SYNTHETIC_SQL = `((model IS NOT NULL AND model NOT IN ('synthetic', '<synthetic>'))
  OR (model IS NULL AND ${TOKENS_SQL} > 0))`;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Open the telemetry store for ANALYSIS: strict read-only, never migrates,
 * never writes. Deliberately NOT openTelemetryDb(), which is read-write and
 * migrates on open — a dashboard render must not mutate the store as a side
 * effect of reading it.
 */
export function openAnalysisDb(path = telemetryDbPath()) {
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec("PRAGMA busy_timeout = 10000;");
  return db;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse one filter date into an ISO string. Dates are UTC. A date-only value
 * ("2026-09-26") means the whole UTC day: `from` (endOfDay = false) reads it
 * as the day's start, `to` (endOfDay = true) as the day's END — a date-only
 * `to` read as midnight would silently drop the entire chosen day. Full
 * datetimes pass through unchanged.
 */
function parseDate(value, label, { endOfDay = false } = {}) {
  const raw = typeof value === "string" ? value.trim() : value;
  if (endOfDay && typeof raw === "string" && DATE_ONLY.test(raw)) {
    const dayStart = new Date(`${raw}T00:00:00.000Z`);
    if (Number.isNaN(dayStart.getTime())) {
      throw fail("bad_filter", `${label} is not a parseable date: ${JSON.stringify(value)}`);
    }
    return new Date(dayStart.getTime() + 24 * 60 * 60 * 1000 - 1).toISOString();
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw fail("bad_filter", `${label} is not a parseable date: ${JSON.stringify(value)}`);
  }
  return date.toISOString();
}

/**
 * Normalize dashboard filter input (URLSearchParams or plain object) into the
 * canonical filter shape. All dates are UTC; a date-only `from`/`to` means
 * the start/end of that UTC day. Invalid input throws Error with .code =
 * "bad_filter" — never silently ignored, a silently dropped filter lies in
 * the numbers.
 */
export function normalizeFilters(input = {}) {
  const raw = input instanceof URLSearchParams ? Object.fromEntries(input.entries()) : (input ?? {});
  const pick = (value) => (value == null || value === "" ? undefined : value);

  const to = parseDate(pick(raw.to) ?? new Date().toISOString(), "to", { endOfDay: true });
  const from = parseDate(pick(raw.from) ?? new Date(Date.parse(to) - THIRTY_DAYS_MS).toISOString(), "from");
  if (Date.parse(from) > Date.parse(to)) {
    throw fail("bad_filter", `from (${from}) is after to (${to})`);
  }

  const era = pick(raw.era) ?? "post";
  if (!ERAS.has(era)) {
    throw fail("bad_filter", `era must be one of "all" | "pre" | "post", got ${JSON.stringify(era)}`);
  }
  const eraBoundary = parseDate(pick(raw.eraBoundary) ?? ERA_BOUNDARY, "eraBoundary");

  const shortString = (value, label) => {
    const s = pick(value);
    if (s == null) return null;
    if (typeof s !== "string" || s.length > 100) {
      throw fail("bad_filter", `${label} must be a string of at most 100 characters`);
    }
    return s;
  };

  return {
    from,
    to,
    squad: shortString(raw.squad, "squad"),
    model: shortString(raw.model, "model"),
    era,
    eraBoundary,
  };
}

/**
 * WHERE clause + bound parameters for the normalized filters, against the
 * caller's column names (both canonical views expose observed_at / squad /
 * model, so the default fits). Values travel ONLY as bound parameters — the
 * where string contains column names and operators, never a filter value.
 */
export function filterSql(
  filters,
  cols = { time: "observed_at", squad: "squad", model: "model" },
) {
  if (filters.era !== "all" && filters.eraBoundary == null) {
    throw fail("bad_filter", `era "${filters.era}" requires eraBoundary (normalizeFilters supplies it)`);
  }
  const parts = [];
  const params = [];
  if (filters.from != null) { parts.push(`${cols.time} >= ?`); params.push(filters.from); }
  if (filters.to != null) { parts.push(`${cols.time} <= ?`); params.push(filters.to); }
  if (filters.squad != null) { parts.push(`${cols.squad} = ?`); params.push(filters.squad); }
  if (filters.model != null) { parts.push(`${cols.model} = ?`); params.push(filters.model); }
  // Era split on the same time column. A row with no timestamp cannot prove
  // it belongs to the post-graph-runner world, so "post" excludes it and
  // "pre" keeps it (legacy rows are pre-FOC-220 history by construction).
  if (filters.era === "pre") {
    parts.push(`(${cols.time} IS NULL OR ${cols.time} < ?)`);
    params.push(filters.eraBoundary);
  } else if (filters.era === "post") {
    parts.push(`${cols.time} >= ?`);
    params.push(filters.eraBoundary);
  }
  return { where: parts.length ? `WHERE ${parts.join(" AND ")}` : "", params };
}

/**
 * The canonical views are the only read surface — fail loudly without them.
 * TABLE counts too: the derived analysis cache (scripts/analysis-cache.mjs)
 * materialises the views as plain tables under the same names, so panels work
 * unchanged against either the store or the cache file.
 */
function requireCanonicalViews(db) {
  const names = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type IN ('view','table')").all().map((r) => r.name),
  );
  const missing = ["canonical_usage", "canonical_tool_facts"].filter((n) => !names.has(n));
  if (missing.length) {
    throw fail(
      "views_missing",
      `Canonical view(s) ${missing.join(", ")} missing from this database. ` +
      "Run: node scripts/telemetry-canonical.mjs --ensure",
    );
  }
}

const round1 = (x) => Math.round(x * 10) / 10;
const sharePct = (part, whole) => (whole > 0 ? round1((100 * part) / whole) : 0);

// Columns analyseToolCalls needs — the same selection agent-behavior.mjs's CLI
// reads off canonical_tool_facts, so the two surfaces classify identically.
const TOOL_ROW_COLUMNS = `tool_fact_id, run_id, agent_key, squad, model, tool_name_canon,
  tool_input, tool_input_id, tool_index, tool_has_error, tool_result_state, tool_result_id,
  observed_at, source_path, source_offset`;

/**
 * Store overview: data window, distinct squads/models, and the canonical
 * counts (turns off canonical_usage, tool calls off canonical_tool_facts;
 * runs = distinct runs that hold canonical turns).
 */
export function metaPanel(db) {
  requireCanonicalViews(db);
  const window = db
    .prepare("SELECT MIN(observed_at) AS first, MAX(observed_at) AS last FROM canonical_usage")
    .get();
  const squads = db
    .prepare("SELECT DISTINCT squad FROM canonical_usage WHERE squad IS NOT NULL ORDER BY squad")
    .all().map((r) => r.squad);
  const models = db
    .prepare("SELECT DISTINCT model FROM canonical_usage WHERE model IS NOT NULL ORDER BY model")
    .all().map((r) => r.model);
  const counts = db.prepare(`
    SELECT (SELECT COUNT(DISTINCT run_id) FROM canonical_usage)      AS runs,
           (SELECT COUNT(*) FROM canonical_usage)                    AS turns,
           (SELECT COUNT(*) FROM canonical_tool_facts)               AS toolCalls
  `).get();
  const caveats = counts.turns === 0
    ? [{ level: "info", code: "empty", message: "the store holds no canonical usage rows yet" }]
    : [];
  return {
    data: {
      window: { first: window.first, last: window.last },
      squads,
      models,
      eraBoundary: ERA_BOUNDARY,
      counts: { runs: counts.runs, turns: counts.turns, toolCalls: counts.toolCalls },
    },
    caveats,
  };
}

function breakdownOf(map) {
  return [...map.values()]
    .sort((a, b) => b.calls - a.calls)
    .map((e) => ({
      label: e.label,
      calls: e.calls,
      repeats: e.repeats,
      errors: e.errors,
      repeatPct: sharePct(e.repeats, e.calls),
      errorPct: sharePct(e.errors, e.calls),
    }));
}

/**
 * Tool-behaviour panel: totals plus the FOC-220 honest repeat categories and
 * per-tool/model/squad breakdowns. Classification is delegated wholesale to
 * agent-behavior.mjs's analyseToolCalls on rows read off canonical_tool_facts.
 */
export function toolsPanel(db, filters) {
  requireCanonicalViews(db);
  const f = normalizeFilters(filters);
  const { where, params } = filterSql(f);
  const rows = db
    .prepare(`SELECT ${TOOL_ROW_COLUMNS} FROM canonical_tool_facts ${where}`)
    .all(...params);
  const analysis = analyseToolCalls(rows);
  const t = analysis.totals;

  const data = {
    totals: { calls: t.calls, repeats: t.repeats, errors: t.errors, outcomeUnknown: t.outcomeUnknown },
    repeatCategories: REPEAT_CATEGORIES.map((c) => ({ category: c, n: t.repeatCategories[c] })),
    byTool: breakdownOf(analysis.byTool),
    byModel: breakdownOf(analysis.byModel),
    bySquad: breakdownOf(analysis.bySquad),
  };

  const caveats = [];
  if (t.outcomeUnknown > 0) {
    const unknownShare = sharePct(t.outcomeUnknown, t.calls);
    caveats.push({
      level: unknownShare > 10 ? "warn" : "info",
      code: "outcome_unknown",
      message: `${unknownShare}% of tool calls have no verifiable outcome (missing tool_result or pre-FOC-220 rows) — missing is not ok`,
      count: t.outcomeUnknown,
    });
  }
  return { filters: f, data, caveats };
}

/**
 * Data-quality panel over the canonical views, plus the store's open
 * data_quality_issues (deliberately NOT time-filtered — an open issue is open
 * regardless of the dashboard window).
 */
export function qualityPanel(db, filters) {
  requireCanonicalViews(db);
  const f = normalizeFilters(filters);
  const { where, params } = filterSql(f);
  const cond = (extra) => (where ? `${where} AND (${extra})` : `WHERE ${extra}`);
  const one = (sql) => db.prepare(sql).get(...params);
  const all = (sql) => db.prepare(sql).all(...params);

  const totalTurns = one(`SELECT COUNT(*) AS n FROM canonical_usage ${where}`).n;

  // Synthetic placeholders (sentinel model, or no model and no tokens) can
  // never be priced, so they are not "unpriced" either — only a real model
  // with cost_usd NULL is. A NULL-model row WITH tokens is a real call whose
  // model was lost: it counts as unpriced under the label "(none)" (a NULL
  // label would render as nothing in the UI).
  const unpricedByModel = all(`
    SELECT COALESCE(model, '(none)') AS model, COUNT(*) AS turns
    FROM canonical_usage ${cond(`cost_usd IS NULL AND ${NOT_SYNTHETIC_SQL}`)}
    GROUP BY model ORDER BY turns DESC, model
  `);
  const attributionMix = all(`
    SELECT attribution, COUNT(*) AS turns
    FROM canonical_usage ${where}
    GROUP BY attribution ORDER BY turns DESC
  `);
  const contestedRows = one(`SELECT COUNT(*) AS n FROM canonical_usage ${cond("claim_count > 1")}`).n;
  const collapsedRows = one(`SELECT COUNT(*) AS n FROM canonical_usage ${cond("line_count > 1")}`).n;
  const syntheticRows = one(`SELECT COUNT(*) AS n FROM canonical_usage ${cond(SYNTHETIC_SQL)}`).n;

  const toolTotals = one(`
    SELECT COUNT(*) AS n, COALESCE(SUM(tool_name_canon IS NULL), 0) AS nullCanon
    FROM canonical_tool_facts ${where}
  `);
  const canonCoverage = {
    rows: toolTotals.n,
    nullCanon: toolTotals.nullCanon,
    pct: toolTotals.n > 0 ? round1((100 * (toolTotals.n - toolTotals.nullCanon)) / toolTotals.n) : null,
  };
  // Same definition as agent-behavior.mjs's outcomeUnknown: not an error AND
  // not a verified 'ok' — missing result is never mistaken for a success.
  const outcomeUnknownRows = one(`
    SELECT COUNT(*) AS n FROM canonical_tool_facts
    ${cond("tool_has_error = 0 AND tool_result_state IS NOT 'ok'")}
  `).n;

  const openIssues = db.prepare(`
    SELECT issue_type, COUNT(*) AS n
    FROM data_quality_issues WHERE resolved_at IS NULL
    GROUP BY issue_type ORDER BY n DESC, issue_type
  `).all();

  const unpricedTurns = unpricedByModel.reduce((sum, r) => sum + r.turns, 0);
  const caveats = [];
  if (unpricedTurns > 0) {
    caveats.push({
      level: "crit",
      code: "unpriced",
      message: `${unpricedTurns} turns have no price for their model (cost_usd NULL) — unpriced is not free; any cost total that drops them undercounts`,
      count: unpricedTurns,
    });
  }
  if (syntheticRows > 0) {
    caveats.push({
      level: "info",
      code: "synthetic_excluded",
      message: `${syntheticRows} synthetic turns (Claude Code placeholder rows: a sentinel model, or no model and no tokens) are not counted as unpriced`,
      count: syntheticRows,
    });
  }
  if (collapsedRows > 0) {
    caveats.push({
      level: "warn",
      code: "line_collapsed",
      // After the FOC-381 history rewrite, the remaining per-line rows are
      // legacy rows whose transcript is gone — nobody can re-derive them.
      message: `${collapsedRows} turns come from legacy per-line history (transcript no longer on disk, so the FOC-381 rewrite could not re-derive them) — the view de-duplicates them heuristically; totals for these are approximate`,
      count: collapsedRows,
    });
  }
  if (contestedRows > 0) {
    caveats.push({
      level: "info",
      code: "contested",
      message: `${contestedRows} turns are claimed by more than one run (ADR-0008 run-scoping); the view keeps one representative`,
      count: contestedRows,
    });
  }

  return {
    filters: f,
    data: {
      unpricedByModel,
      attributionMix,
      contested: { rows: contestedRows, share: sharePct(contestedRows, totalTurns) },
      lineCollapsed: { rows: collapsedRows, share: sharePct(collapsedRows, totalTurns) },
      canonCoverage,
      outcomeUnknown: { rows: outcomeUnknownRows, share: sharePct(outcomeUnknownRows, toolTotals.n) },
      openIssues,
    },
    caveats,
  };
}

const round4 = (x) => Math.round(x * 10000) / 10000;

/**
 * Cost panel: totals and breakdowns read exclusively off canonical_usage.
 * unpriced (cost_usd NULL on a real, non-synthetic model) is never folded
 * into usd as 0 — it is reported next to it, here and in the crit caveat,
 * because unpriced is not free. Synthetic placeholder rows (sentinel model)
 * are not priceable by definition, so they are reported separately as
 * totals.synthetic + an info caveat instead of poisoning the crit alarm.
 */
export function costPanel(db, filters) {
  requireCanonicalViews(db);
  const f = normalizeFilters(filters);
  const { where, params } = filterSql(f);
  const cond = (extra) => (where ? `${where} AND (${extra})` : `WHERE ${extra}`);
  const one = (sql) => db.prepare(sql).get(...params);
  const all = (sql) => db.prepare(sql).all(...params);

  const totals = one(`
    SELECT COUNT(*) AS turns,
           SUM(COALESCE(cost_usd, 0)) AS usd,
           SUM(cost_usd IS NULL AND ${NOT_SYNTHETIC_SQL}) AS unpriced,
           SUM(${SYNTHETIC_SQL}) AS synthetic,
           SUM(COALESCE(input_tokens, 0)) AS inputTokens,
           SUM(COALESCE(output_tokens, 0)) AS outputTokens,
           SUM(COALESCE(cache_read_tokens, 0)) AS cacheReadTokens,
           SUM(COALESCE(cache_creation_tokens, 0)) AS cacheCreationTokens,
           SUM(${TOKENS_SQL}) AS tokens
    FROM canonical_usage ${where}
  `);
  const t = {
    turns: totals.turns ?? 0,
    usd: totals.usd ?? 0,
    unpriced: totals.unpriced ?? 0,
    synthetic: totals.synthetic ?? 0,
    tokens: totals.tokens ?? 0,
    inputTokens: totals.inputTokens ?? 0,
    outputTokens: totals.outputTokens ?? 0,
    cacheReadTokens: totals.cacheReadTokens ?? 0,
    cacheCreationTokens: totals.cacheCreationTokens ?? 0,
  };
  const cacheDenom = t.cacheReadTokens + t.inputTokens;

  // Shared shape for every breakdown row: { label, turns, usd, unpriced, tokens }.
  const andCond = (extra) => (extra ? (where ? `${where} AND (${extra})` : `WHERE ${extra}`) : where);
  const breakdown = (labelExpr, extra = "", limit = "") =>
    all(`
      SELECT ${labelExpr} AS label,
             COUNT(*) AS turns,
             SUM(COALESCE(cost_usd, 0)) AS usd,
             SUM(cost_usd IS NULL AND ${NOT_SYNTHETIC_SQL}) AS unpriced,
             SUM(${TOKENS_SQL}) AS tokens
      FROM canonical_usage ${andCond(extra)}
      GROUP BY label ORDER BY usd DESC, label${limit}
    `).map((r) => ({
      label: r.label,
      turns: r.turns,
      usd: r.usd ?? 0,
      unpriced: r.unpriced ?? 0,
      tokens: r.tokens ?? 0,
    }));

  const byWeek = breakdown(`strftime('%Y-W%W', observed_at)`, "observed_at IS NOT NULL")
    .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));

  // Lead vs everyone else, as fixed two-row shape (a missing side is 0, not
  // absent — shares below must always sum to 1).
  const leadRows = all(`
    SELECT CASE WHEN agent_key = '_lead' THEN 'lead' ELSE 'subagent' END AS label,
           COUNT(*) AS turns,
           SUM(COALESCE(cost_usd, 0)) AS usd,
           SUM(cost_usd IS NULL AND ${NOT_SYNTHETIC_SQL}) AS unpriced,
           SUM(${TOKENS_SQL}) AS tokens
    FROM canonical_usage ${where}
    GROUP BY label
  `);
  const leadVsSubagent = ["lead", "subagent"].map((label) => {
    const row = leadRows.find((r) => r.label === label) ?? { turns: 0, usd: 0, unpriced: 0, tokens: 0 };
    return {
      label,
      turns: row.turns,
      usd: row.usd ?? 0,
      unpriced: row.unpriced ?? 0,
      tokens: row.tokens ?? 0,
      usdShare: t.usd > 0 ? round4((row.usd ?? 0) / t.usd) : 0,
    };
  });

  const collapsedRows = one(`SELECT COUNT(*) AS n FROM canonical_usage ${cond("line_count > 1")}`).n;
  const caveats = [];
  if (t.unpriced > 0) {
    caveats.push({
      level: "crit",
      code: "unpriced",
      message: `${t.unpriced} turns have cost_usd NULL — unpriced is not free; it is reported next to usd, never folded into it as 0`,
      count: t.unpriced,
    });
  }
  if (t.synthetic > 0) {
    caveats.push({
      level: "info",
      code: "synthetic_excluded",
      message: `${t.synthetic} synthetic turns (Claude Code placeholder rows: a sentinel model, or no model and no tokens) are not counted as unpriced`,
      count: t.synthetic,
    });
  }
  if (collapsedRows > 0) {
    caveats.push({
      level: "warn",
      code: "line_collapsed_in_scope",
      // After the FOC-381 history rewrite, the remaining per-line rows are
      // legacy rows whose transcript is gone — nobody can re-derive them.
      message: `${collapsedRows} turns come from legacy per-line history (transcript no longer on disk, so the FOC-381 rewrite could not re-derive them) — the view de-duplicates them heuristically; totals for these are approximate`,
      count: collapsedRows,
    });
  }
  if (t.turns === 0) {
    caveats.push({ level: "info", code: "empty", message: "no canonical usage rows match the current filters" });
  }

  return {
    filters: f,
    data: {
      totals: {
        ...t,
        cacheHitPct: cacheDenom > 0 ? round1((100 * t.cacheReadTokens) / cacheDenom) : null,
      },
      bySquad: breakdown("squad"),
      // NULL model (a real call whose model was lost) shows as "(none)" —
      // a NULL label would render as nothing in the UI.
      byModel: breakdown("COALESCE(model, '(none)')"),
      // Ephemeral handles (agent-%) are one-shot scaffolding, not roles.
      byRole: breakdown("agent_key", "agent_key IS NOT '_lead' AND agent_key NOT LIKE 'agent-%'", " LIMIT 25"),
      byWeek,
      leadVsSubagent,
    },
    caveats,
  };
}

/**
 * Handoff panel: delegation links joined to the child's canonical usage. The
 * child's cost/turns/tokens come ONLY from canonical_usage — the link's own
 * child_tokens/child_cost_usd/child_turns are NULL on historical rows. The
 * child usage is aggregated once per (parent_run_id, child_agent) in a
 * subquery, and summed once per (run, child) pair below, because one run can
 * hold several links to the same child_agent.
 */
export function handoffsPanel(db, filters) {
  requireCanonicalViews(db);
  const f = normalizeFilters(filters);
  const { where, params } = filterSql(f, { time: "d.observed_at", squad: "r.squad", model: "d.child_model" });

  const rows = db.prepare(`
    SELECT d.delegation_id, d.parent_run_id, d.parent_agent, d.child_agent,
           d.child_model, d.observed_at, r.squad AS squad,
           cu.turns AS childTurns, cu.usd AS childUsd, cu.tokens AS childTokens
    FROM delegation_links d
    JOIN runs r ON r.run_id = d.parent_run_id
    LEFT JOIN (
      SELECT run_id, agent_key,
             COUNT(*) AS turns,
             SUM(COALESCE(cost_usd, 0)) AS usd,
             SUM(${TOKENS_SQL}) AS tokens
      FROM canonical_usage
      GROUP BY run_id, agent_key
    ) cu ON cu.run_id = d.parent_run_id AND cu.agent_key = d.child_agent
    ${where}
  `).all(...params);

  const links = rows.length;
  const resolved = rows.filter((r) => (r.childTurns ?? 0) > 0).length;

  // Child usage is counted once per (parent_run_id, child_agent) across all
  // aggregations — the second link to the same child must not sum it twice.
  const countedUsage = new Set();
  const pairs = new Map();
  const squads = new Map();
  for (const r of rows) {
    const usageKey = `${r.parent_run_id}\u0000${r.child_agent}`;
    const fresh = !countedUsage.has(usageKey);
    countedUsage.add(usageKey);
    const childTurns = fresh ? (r.childTurns ?? 0) : 0;
    const childUsd = fresh ? (r.childUsd ?? 0) : 0;
    const childTokens = fresh ? (r.childTokens ?? 0) : 0;

    const pairKey = `${r.parent_agent}\u0000${r.child_agent}\u0000${r.child_model ?? ""}`;
    const pair = pairs.get(pairKey) ?? {
      parent: r.parent_agent, child: r.child_agent, childModel: r.child_model,
      links: 0, childTurns: 0, childUsd: 0, childTokens: 0,
    };
    pair.links += 1;
    pair.childTurns += childTurns;
    pair.childUsd += childUsd;
    pair.childTokens += childTokens;
    pairs.set(pairKey, pair);

    const sq = squads.get(r.squad) ?? { label: r.squad, links: 0, childUsd: 0 };
    sq.links += 1;
    sq.childUsd += childUsd;
    squads.set(r.squad, sq);
  }

  const unresolved = links - resolved;
  const caveats = [];
  // The time/model filters bind to the LINKS, while childUsd aggregates the
  // child's whole run (the canonical usage subquery is deliberately
  // unfiltered — a run's spend does not stop at the window's edge) — say so,
  // or the number invites a false comparison with the cost panel's total.
  caveats.push({
    level: "info",
    code: "handoff_child_scope",
    message: "child spend covers the child's whole run, not the filtered window — it is not comparable with the cost panel's window total",
  });
  if (unresolved > 0) {
    caveats.push({
      level: "warn",
      code: "unresolved_children",
      message: `${unresolved} of ${links} links (${sharePct(unresolved, links)}%) have no canonical usage for their child — the delegation points at a transcript the canonical views never saw`,
      count: unresolved,
    });
  }
  if (links === 0) {
    caveats.push({ level: "info", code: "empty", message: "no delegation links match the current filters" });
  }

  return {
    filters: f,
    data: {
      totals: { links, resolved, unresolved },
      byPair: [...pairs.values()].sort((a, b) => b.links - a.links).slice(0, 30),
      bySquad: [...squads.values()].sort((a, b) => b.links - a.links),
    },
    caveats,
  };
}