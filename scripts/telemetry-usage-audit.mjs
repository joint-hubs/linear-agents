#!/usr/bin/env node
/**
 * scripts/telemetry-usage-audit.mjs — FOC-221 audit: what the fleet cost
 * surfaces used to count vs what they count now, with every difference
 * explained by mechanism and count.
 *
 * Read-only by construction, on a COPY of the live store (never the live
 * file): the database is opened with readOnly + `PRAGMA query_only = ON`, and
 * integrity_check runs before anything else. All numbers are derived from the
 * RAW tables with SQL written out here — the views are only cross-checked
 * against, never trusted, so the audit stays meaningful even if a view
 * definition drifts.
 *
 * Two canonical layers are compared (see docs/research/telemetry-analysis-2026-09.md
 * F7.1b and the header of telemetry-store.mjs):
 *
 *   before  run-scoped dedup (ADR-0008, the FOC-102 canonical_usage): among
 *           runs claiming one (source_path, source_offset), one winner. This
 *           still counts a message once per JSONL line that repeats its usage.
 *   after   the per-message island collapse (FOC-221): lines of one message
 *           share an identical token tuple and sit within MESSAGE_GAP_MS, so
 *           they collapse to one row.
 *
 * Usage:
 *   node scripts/telemetry-usage-audit.mjs --db <copy.sqlite> [--out PATH] [--json]
 *
 * Exit 0 only when integrity holds; every other outcome exits non-zero with
 * the reason. Nothing in the source database is written.
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, "..");

const args = process.argv.slice(2);
const dbArg = (() => {
  const i = args.indexOf("--db");
  return i >= 0 ? args[i + 1] : null;
})();
const outArg = (() => {
  const i = args.indexOf("--out");
  return i >= 0 ? args[i + 1] : join(root, ".state", "foc221-audit", "usage-audit.json");
})();
const JSON_ONLY = args.includes("--json");

if (!dbArg || args.includes("--help") || !existsSync(dbArg)) {
  console.log(`Usage: node scripts/telemetry-usage-audit.mjs --db <store-copy.sqlite> [--out PATH] [--json]

  --db    Path to a COPY of the telemetry store (the live file is never opened).
  --out   Audit JSON destination (default .state/foc221-audit/usage-audit.json).
  --json  Print the JSON to stdout too, skip the console tables.`);
  process.exit(dbArg && existsSync(dbArg) ? 0 : 2);
}

const db = new DatabaseSync(dbArg, { readOnly: true });
db.exec("PRAGMA query_only = ON;");

// --- gate: integrity first — an audit of a corrupt copy proves nothing ----
const integrity = db.prepare("PRAGMA integrity_check").get();
if (integrity.integrity_check !== "ok") {
  console.error(`integrity_check failed on ${dbArg}: ${integrity.integrity_check}`);
  console.error("Report this as a limitation; the audit did not run.");
  process.exit(1);
}

// --- raw truth (pinned join; the only cost join that is not multiplied) ---
const RAW_SQL = `
  SELECT COUNT(*) AS rows,
         SUM(u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_creation_tokens) AS tokens,
         ROUND(SUM(c.cost_usd), 2) AS usd,
         ROUND(SUM(CASE WHEN c.cost_usd IS NULL AND u.model IS NOT NULL
                          AND u.model NOT IN ('synthetic','<synthetic>')
                    THEN u.input_tokens + u.output_tokens
                         + u.cache_read_tokens + u.cache_creation_tokens ELSE 0 END), 0) AS unpriced_tokens,
         SUM(CASE WHEN c.cost_usd IS NULL AND u.model IS NOT NULL
                    AND u.model NOT IN ('synthetic','<synthetic>') THEN 1 ELSE 0 END) AS unpriced_rows,
         SUM(CASE WHEN u.input_tokens + u.output_tokens
                    + u.cache_read_tokens + u.cache_creation_tokens = 0 THEN 1 ELSE 0 END) AS zero_rows
  FROM usage_facts u JOIN runs r ON r.run_id = u.run_id
  LEFT JOIN cost_facts c ON c.run_id = u.run_id AND c.usage_id = u.usage_id AND c.price_set_id = r.price_set_id`;

// --- BEFORE: the FOC-102 canonical rule (one winner per physical line) ----
const BEFORE_SQL = `
  WITH claims AS (
    SELECT u.source_path, u.source_offset, u.usage_id, u.run_id, u.model, u.observed_at,
           u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_creation_tokens,
           r.started_at, r.ended_at,
           CASE
             WHEN u.observed_at IS NULL OR r.started_at IS NULL THEN 3
             WHEN u.observed_at >= r.started_at
                  AND (r.ended_at IS NULL OR u.observed_at <= r.ended_at) THEN 0
             WHEN u.observed_at > COALESCE(r.ended_at, r.started_at) THEN 1
             ELSE 2
           END AS fit_rank
    FROM usage_facts u JOIN runs r ON r.run_id = u.run_id
  ),
  ranked AS (
    SELECT *, ROW_NUMBER() OVER (
      PARTITION BY source_path, source_offset
      ORDER BY fit_rank, ABS(julianday(observed_at) - julianday(started_at)), run_id, usage_id
    ) AS rn
    FROM claims
  )
  SELECT COUNT(*) AS rows,
         SUM(b.input_tokens + b.output_tokens + b.cache_read_tokens + b.cache_creation_tokens) AS tokens
  FROM ranked b WHERE b.rn = 1`;

const BEFORE_COST_SQL = `
  WITH claims AS (
    SELECT u.source_path, u.source_offset, u.usage_id, u.run_id, u.model, u.observed_at,
           u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_creation_tokens,
           r.started_at, r.ended_at, r.price_set_id,
           CASE
             WHEN u.observed_at IS NULL OR r.started_at IS NULL THEN 3
             WHEN u.observed_at >= r.started_at
                  AND (r.ended_at IS NULL OR u.observed_at <= r.ended_at) THEN 0
             WHEN u.observed_at > COALESCE(r.ended_at, r.started_at) THEN 1
             ELSE 2
           END AS fit_rank
    FROM usage_facts u JOIN runs r ON r.run_id = u.run_id
  ),
  ranked AS (
    SELECT *, ROW_NUMBER() OVER (
      PARTITION BY source_path, source_offset
      ORDER BY fit_rank, ABS(julianday(observed_at) - julianday(started_at)), run_id, usage_id
    ) AS rn
    FROM claims
  )
  SELECT ROUND(SUM(c.cost_usd), 2) AS usd,
         SUM(CASE WHEN c.cost_usd IS NULL AND b.model IS NOT NULL
                    AND b.model NOT IN ('synthetic','<synthetic>') THEN 1 ELSE 0 END) AS unpriced_rows
  FROM ranked b
  LEFT JOIN cost_facts c ON c.run_id = b.run_id AND c.usage_id = b.usage_id AND c.price_set_id = b.price_set_id
  WHERE b.rn = 1`;

// --- AFTER: the per-message island collapse (independent copy of the rule) -
const AFTER_SQL = `
  WITH ordered AS (
    SELECT u.usage_id, u.run_id, u.agent_key, u.model, u.observed_at,
           u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_creation_tokens,
           u.source_path, u.source_offset, r.squad, r.started_at, r.ended_at, r.price_set_id,
           CASE
             WHEN u.observed_at IS NULL OR r.started_at IS NULL THEN 3
             WHEN u.observed_at >= r.started_at
                  AND (r.ended_at IS NULL OR u.observed_at <= r.ended_at) THEN 0
             WHEN u.observed_at > COALESCE(r.ended_at, r.started_at) THEN 1
             ELSE 2
           END AS fit_rank,
           LAG(u.input_tokens)          OVER w AS p_input,
           LAG(u.output_tokens)         OVER w AS p_output,
           LAG(u.cache_read_tokens)     OVER w AS p_cache_read,
           LAG(u.cache_creation_tokens) OVER w AS p_cache_creation,
           LAG(u.observed_at)           OVER w AS p_observed_at
    FROM usage_facts u JOIN runs r ON r.run_id = u.run_id
    WINDOW w AS (PARTITION BY u.source_path, u.agent_key, u.model
                 ORDER BY u.source_offset, u.run_id, u.usage_id)
  ),
  flagged AS (
    SELECT *,
      CASE
        WHEN p_input IS NULL THEN 0
        WHEN input_tokens != p_input OR output_tokens != p_output
          OR cache_read_tokens != p_cache_read
          OR cache_creation_tokens != p_cache_creation THEN 1
        WHEN observed_at IS NOT NULL AND p_observed_at IS NOT NULL
          AND ABS(julianday(observed_at) - julianday(p_observed_at)) * 86400 > 300 THEN 1
        ELSE 0
      END AS is_boundary
    FROM ordered
  ),
  islands AS (
    SELECT *,
      SUM(is_boundary) OVER (PARTITION BY source_path, agent_key, model
        ORDER BY source_offset, run_id, usage_id ROWS UNBOUNDED PRECEDING) AS island_id
    FROM flagged
  ),
  island_stats AS (
    SELECT source_path, agent_key, model, island_id,
      COUNT(*) AS line_count, COUNT(DISTINCT run_id) AS claim_count
    FROM islands GROUP BY source_path, agent_key, model, island_id
  ),
  ranked AS (
    SELECT *,
      ROW_NUMBER() OVER (
        PARTITION BY source_path, agent_key, model, island_id
        ORDER BY fit_rank, ABS(julianday(observed_at) - julianday(started_at)), run_id, usage_id
      ) AS rn
    FROM islands
  )
  SELECT
    k.source_path, k.source_offset, k.usage_id, k.run_id, k.squad, k.agent_key, k.model,
    k.started_at, k.ended_at,
    k.input_tokens, k.output_tokens, k.cache_read_tokens, k.cache_creation_tokens,
    s.claim_count, s.line_count,
    CASE k.fit_rank WHEN 0 THEN 'in_window' WHEN 1 THEN 'after_end'
      WHEN 2 THEN 'before_start' ELSE 'no_timestamp' END AS attribution,
    c.cost_usd
  FROM ranked k
  JOIN island_stats s ON s.source_path = k.source_path AND s.agent_key = k.agent_key
    AND s.model IS k.model AND s.island_id = k.island_id
  LEFT JOIN cost_facts c
    ON c.run_id = k.run_id AND c.usage_id = k.usage_id AND c.price_set_id = k.price_set_id
  WHERE k.rn = 1`;

// --- run -------------------------------------------------------------------
const one = (sql) => db.prepare(sql).get();
const raw = one(RAW_SQL);
const beforeRows = one(BEFORE_SQL);
const beforeCost = one(BEFORE_COST_SQL);
const islands = db.prepare(AFTER_SQL).all();

const after = {
  rows: islands.length,
  tokens: islands.reduce((s, r) => s + r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_creation_tokens, 0),
  usd: Math.round(islands.reduce((s, r) => s + (r.cost_usd ?? 0), 0) * 100) / 100,
  unpricedRows: islands.filter((r) => r.cost_usd == null && r.model != null && r.model !== "synthetic" && r.model !== "<synthetic>").length,
  // Population labels (FOC-221 review): the three unpriced counters in the
  // wild measure different populations — say so next to the numbers instead of
  // letting a reader diff them into a phantom trend.
  unpricedRowsNote: "NULL-cost islands whose model is KNOWN and non-synthetic — synthetic-model and NULL-model islands are excluded here",
  bySquadNote: "per-squad `unpriced` counts EVERY NULL-cost island, synthetic and NULL models included — a wider population than unpricedRows above",
  collapsedLines: islands.reduce((s, r) => s + (r.line_count - 1), 0),
  contestedIslands: islands.filter((r) => r.claim_count > 1).length,
  zeroTokenIslands: islands.filter((r) => r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_creation_tokens === 0).length,
  attribution: {},
  bySquad: {},
  unpricedModels: {},
};
for (const r of islands) {
  after.attribution[r.attribution] = (after.attribution[r.attribution] || 0) + 1;
  const squad = r.squad ?? "—";
  const s = after.bySquad[squad] ||= { turns: 0, usd: 0, unpriced: 0 };
  s.turns++;
  s.usd += r.cost_usd ?? 0;
  if (r.cost_usd == null) s.unpriced++;
  if (r.cost_usd == null && r.model != null) {
    after.unpricedModels[r.model] = (after.unpricedModels[r.model] || 0) + 1;
  }
}
after.usd = Math.round(after.usd * 100) / 100;
for (const s of Object.values(after.bySquad)) s.usd = Math.round(s.usd * 100) / 100;

// Source refs retained: every island winner must resolve to a raw fact.
const rawRefs = new Set(db.prepare("SELECT run_id || '|' || usage_id AS k FROM usage_facts").all().map((r) => r.k));
const winnersResolvable = islands.filter((r) => rawRefs.has(`${r.run_id}|${r.usage_id}`)).length;

// --- cross-check against the view, if the copy carries one -----------------
// A pristine copy still carries the OLD (run-scoped) view definition; a copy
// ensured after the FOC-221 change carries the island definition. Both are
// legitimate: the audit says which one it saw and checks the island set
// against it accordingly.
const viewNames = db.prepare("SELECT name FROM sqlite_master WHERE type='view'").all().map((r) => r.name);
let crossCheck;
if (viewNames.includes("canonical_usage")) {
  const v = one(`SELECT COUNT(*) AS rows,
      SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) AS tokens,
      ROUND(SUM(COALESCE(cost_usd, 0)), 2) AS usd
    FROM canonical_usage`);
  const vRefs = new Set(db.prepare("SELECT source_path || '|' || source_offset || '|' || usage_id AS k FROM canonical_usage").all().map((r) => r.k));
  const islandRefs = new Set(islands.map((r) => `${r.source_path}|${r.source_offset}|${r.usage_id}`));
  let onlyInView = 0;
  for (const k of vRefs) if (!islandRefs.has(k)) onlyInView++;
  let onlyInIslands = 0;
  for (const k of islandRefs) if (!vRefs.has(k)) onlyInIslands++;
  const viewMatchesAfterRule = v.rows === after.rows;
  const viewMatchesBeforeRule = v.rows === beforeRows.rows;
  crossCheck = {
    view: "canonical_usage",
    viewRows: v.rows,
    definition: viewMatchesAfterRule ? "island (FOC-221)" : viewMatchesBeforeRule ? "run-scoped (pre-FOC-221 copy)" : "unknown",
    rowsEqual: v.rows === after.rows,
    tokensEqual: v.tokens === after.tokens,
    usdEqual: Math.abs(v.usd - after.usd) < 0.005,
    winnerSetsEqual: onlyInView === 0 && onlyInIslands === 0,
    islandsSubsetOfView: onlyInIslands === 0,
    onlyInView, onlyInIslands,
  };
} else {
  crossCheck = { view: null, note: "canonical_usage not present on this copy — nothing to cross-check" };
}

const usd = (v) => `$${Number(v ?? 0).toFixed(2)}`;
const audit = {
  generatedAt: new Date().toISOString(),
  db: dbArg,
  integrity: integrity.integrity_check,
  raw: {
    rows: raw.rows, tokens: raw.tokens, usd: raw.usd,
    unpricedRows: raw.unpriced_rows, unpricedTokens: raw.unpriced_tokens, zeroRows: raw.zero_rows,
    note: "usage_facts summed per claiming run at the run's own price snapshot — the raw truth the surfaces start from",
  },
  before: {
    label: "run-scoped canonical (ADR-0008 / FOC-102 rule)",
    rows: beforeRows.rows, tokens: beforeRows.tokens, usd: beforeCost.usd, unpricedRows: beforeCost.unpriced_rows,
  },
  after: {
    label: "per-message island canonical (FOC-221 rule)",
    ...after,
  },
  explanations: [
    {
      mechanism: "run-scoped claim copies (ADR-0008)",
      rowsRemoved: raw.rows - beforeRows.rows,
      usdDelta: Math.round(((beforeCost.usd ?? 0) - (raw.usd ?? 0)) * 100) / 100,
      note: "several runs claim one physical line; each kept its own row. The before-rule picks one winner per (source_path, source_offset) — raw rows above that are other runs' copies.",
    },
    {
      mechanism: "per-message repeated usage lines (FOC-221)",
      rowsRemoved: beforeRows.rows - after.rows,
      usdDelta: Math.round((after.usd - (beforeCost.usd ?? 0)) * 100) / 100,
      note: "one assistant message spans several JSONL lines (thinking/text/tool_use), each repeating the same usage object; ingest keyed rows by byte offset, so the repeats became distinct rows. The island rule collapses identical token tuples within the 300 s gap threshold — measured ground truth: per-message span max 173 s.",
    },
    {
      mechanism: "collapsed per-message lines",
      linesFolded: after.collapsedLines,
      note: "SUM(line_count-1) over islands — the count of JSONL lines that no longer get their own usage row.",
    },
    {
      mechanism: "unknown prices stay unknown",
      unpricedIslands: after.unpricedRows,
      note: "islands whose winner's model is missing from the run's price snapshot report NULL cost and are counted, never folded to 0. Population: known non-synthetic models only — bySquad.unpriced below counts every NULL-cost island including synthetic ones.",
    },
    {
      mechanism: "zero-token islands stay events",
      zeroTokenIslands: after.zeroTokenIslands,
      note: "zero rows never bridge two different token tuples (strict identical tuples only), so a zero-token line remains its own island and cannot hide a real call.",
    },
    {
      mechanism: "contested islands kept visible",
      contestedIslands: after.contestedIslands,
      note: "islands claimed by more than one run; claim_count reports them and the winner selection is deterministic (fit, time distance, run_id, usage_id).",
    },
    {
      mechanism: "source refs retained",
      winnersResolvable,
      note: "every canonical row keeps the (run_id, usage_id) of the raw fact that won — nothing is silently rewritten.",
    },
  ],
  crossCheck,
};

mkdirSync(dirname(outArg), { recursive: true });
writeFileSync(outArg, JSON.stringify(audit, null, 2) + "\n", "utf8");

if (JSON_ONLY) console.log(JSON.stringify(audit, null, 2));
else {
  console.log(`integrity: ${audit.integrity}`);
  console.log(`raw        ${raw.rows} rows   ${raw.tokens} tokens   ${usd(raw.usd)}   (${raw.unpriced_rows} unpriced, ${raw.zero_rows} zero-token)`);
  console.log(`before     ${beforeRows.rows} rows   ${beforeRows.tokens} tokens   ${usd(beforeCost.usd)}   (run-scoped dedup)`);
  console.log(`after      ${after.rows} rows   ${after.tokens} tokens   ${usd(after.usd)}   (per-message islands)`);
  console.log(`\nmechanisms:`);
  for (const e of audit.explanations) {
    console.log(`  ${e.mechanism}: ${e.rowsRemoved ?? e.linesFolded ?? e.unpricedIslands ?? e.zeroTokenIslands ?? e.contestedIslands ?? e.winnersResolvable} ${e.usdDelta != null ? `${e.usdDelta > 0 ? "+" : ""}${usd(e.usdDelta)}` : ""}`);
  }
  console.log(`\nby squad (after):`);
  for (const [squad, s] of Object.entries(after.bySquad).sort((a, b) => b[1].usd - a[1].usd)) {
    console.log(`  ${squad.padEnd(12)} ${String(s.turns).padStart(7)} turns  ${usd(s.usd).padStart(10)}  ${s.unpriced} unpriced`);
  }
  const topModels = Object.entries(after.unpricedModels).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (topModels.length) console.log(`\ntop unpriced models: ${topModels.map(([m, n]) => `${m} (${n})`).join(", ")}`);
  console.log(`\ncross-check: ${JSON.stringify(crossCheck)}`);
  console.log(`wrote ${outArg}`);
}
db.close();
// Pass criteria: refs resolve, and the view agrees — fully when it carries the
// island definition; for a pristine pre-change copy (old definition) the
// island set must at least be a subset of the view's rows.
const viewAgrees = crossCheck.view == null
  || (crossCheck.definition === "island (FOC-221)"
    ? crossCheck.rowsEqual && crossCheck.tokensEqual && crossCheck.usdEqual && crossCheck.winnerSetsEqual
    : crossCheck.islandsSubsetOfView);
process.exit(viewAgrees && winnersResolvable === after.rows ? 0 : 1);
