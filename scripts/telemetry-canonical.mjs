#!/usr/bin/env node
/**
 * scripts/telemetry-canonical.mjs — one row per PHYSICAL model call.
 *
 * Why this exists. ADR-0008 made facts run-scoped: when several runs share one
 * transcript file, each run gets its own copy of that file's rows. That is
 * correct for "what did run X cost" — but it makes every FLEET question
 * ("what did I spend", "which model errors most") count the same API call once
 * per claiming run. Measured on 2026-09-04: 124 237 usage rows describe 106 325
 * distinct calls, and `supervisor` alone is inflated 44%.
 *
 * The deeper cause is that ingestTranscript attributes EVERY line of a file to
 * the run it is ingesting for, with no boundary — so a run that lasted three
 * seconds can own 2 524 turns spanning ten days. These views do not fix that
 * (a re-ingest would); they make it measurable and stop it from silently
 * inflating aggregates.
 *
 * The rule. A physical call is identified by (source_path, source_offset) —
 * a byte position in a file, which no amount of re-attribution changes. Among
 * the runs claiming it, one wins:
 *
 *   in_window     the call happened between the run's start and end   ← trusted
 *   after_end     the run had already finished; nearest start wins
 *   before_start  the run had not started yet
 *   no_timestamp  no time on either side; run_id breaks the tie
 *
 * `attribution` is kept in the view rather than filtered away, so an analysis
 * can demand in_window when it needs certainty instead of inheriting a guess.
 * `claim_count` says how many runs wanted the row — 1 means uncontested.
 *
 * Cost is joined at the run's OWN price_set_id. cost_facts holds a row per
 * price snapshot (52 of them), so a join without that predicate multiplies
 * every sum — the trap ADR-0008 names under "Join complexity". A call whose
 * model was missing from the snapshot yields NULL, never 0: unpriced is not
 * free, and `--report` counts those rows separately.
 *
 * Usage:
 *   node scripts/telemetry-canonical.mjs --ensure    # (re)create the views
 *   node scripts/telemetry-canonical.mjs --report    # fleet totals, raw vs canonical
 *   node scripts/telemetry-canonical.mjs --report --json
 */

import { DatabaseSync } from "node:sqlite";
import { telemetryDbPath } from "./telemetry-store.mjs";

// Ranking shared by both views: lower is a better claim on the row.
const FIT_RANK = `
    CASE
      WHEN u.observed_at IS NULL OR r.started_at IS NULL THEN 3
      WHEN u.observed_at >= r.started_at
           AND (r.ended_at IS NULL OR u.observed_at <= r.ended_at) THEN 0
      WHEN u.observed_at > COALESCE(r.ended_at, r.started_at) THEN 1
      ELSE 2
    END`;

const FIT_LABEL = `
    CASE k.fit_rank
      WHEN 0 THEN 'in_window'
      WHEN 1 THEN 'after_end'
      WHEN 2 THEN 'before_start'
      ELSE 'no_timestamp'
    END`;

export const CANONICAL_USAGE_SQL = `
CREATE VIEW canonical_usage AS
WITH claims AS (
  SELECT
    u.source_path, u.source_offset, u.usage_id, u.run_id, u.session_id,
    u.agent_key, u.model, u.observed_at,
    u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_creation_tokens,
    r.squad, r.started_at, r.price_set_id,
    ${FIT_RANK} AS fit_rank
  FROM usage_facts u JOIN runs r USING(run_id)
),
ranked AS (
  SELECT *,
    ROW_NUMBER() OVER (
      PARTITION BY source_path, source_offset
      ORDER BY fit_rank, ABS(julianday(observed_at) - julianday(started_at)), run_id
    ) AS rn,
    COUNT(*) OVER (PARTITION BY source_path, source_offset) AS claim_count
  FROM claims
)
SELECT
  k.source_path, k.source_offset, k.usage_id, k.run_id, k.session_id, k.squad,
  k.agent_key, k.model, k.observed_at,
  k.input_tokens, k.output_tokens, k.cache_read_tokens, k.cache_creation_tokens,
  k.claim_count,
  ${FIT_LABEL} AS attribution,
  c.cost_usd
FROM ranked k
LEFT JOIN cost_facts c
  ON c.run_id = k.run_id AND c.usage_id = k.usage_id AND c.price_set_id = k.price_set_id
WHERE k.rn = 1`;

// tool_fact_id is sha1(source_path:source_offset:tool_index) — already a
// physical identity, independent of which run claimed it. Same tie-break.
export const CANONICAL_TOOL_SQL = `
CREATE VIEW canonical_tool_facts AS
WITH claims AS (
  SELECT
    u.tool_fact_id, u.run_id, u.agent_key, u.model, u.observed_at,
    u.tool_name_raw, u.tool_name_canon, u.tool_has_error, u.turn_index,
    u.tool_input, u.source_path, u.source_offset,
    r.squad, r.started_at,
    ${FIT_RANK} AS fit_rank
  FROM tool_facts u JOIN runs r USING(run_id)
),
ranked AS (
  SELECT *,
    ROW_NUMBER() OVER (
      PARTITION BY tool_fact_id
      ORDER BY fit_rank, ABS(julianday(observed_at) - julianday(started_at)), run_id
    ) AS rn,
    COUNT(*) OVER (PARTITION BY tool_fact_id) AS claim_count
  FROM claims
)
SELECT
  k.tool_fact_id, k.run_id, k.squad, k.agent_key, k.model, k.observed_at,
  k.tool_name_raw, k.tool_name_canon, k.tool_has_error, k.turn_index,
  k.tool_input, k.source_path, k.source_offset, k.claim_count,
  ${FIT_LABEL} AS attribution
FROM ranked k
WHERE k.rn = 1`;

/**
 * Create both views, replacing any earlier definition. DROP+CREATE rather than
 * CREATE IF NOT EXISTS: a view that silently kept a stale definition after this
 * file changed would be worse than no view at all. Safe to call on every open —
 * a view holds no data.
 */
export function ensureViews(db) {
  db.exec("DROP VIEW IF EXISTS canonical_usage");
  db.exec("DROP VIEW IF EXISTS canonical_tool_facts");
  db.exec(CANONICAL_USAGE_SQL);
  db.exec(CANONICAL_TOOL_SQL);
  return ["canonical_usage", "canonical_tool_facts"];
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    console.log(`Usage: node scripts/telemetry-canonical.mjs [--ensure] [--report] [--json]

  --ensure   (Re)create canonical_usage and canonical_tool_facts.
  --report   Fleet totals: raw vs canonical, attribution mix, unpriced rows.
  --json     Machine-readable report.`);
    process.exit(0);
  }

  const db = new DatabaseSync(telemetryDbPath());
  db.exec("PRAGMA busy_timeout = 15000;");
  const JSON_OUT = args.includes("--json");
  const log = (...a) => { if (!JSON_OUT) console.log(...a); };

  if (args.includes("--ensure")) {
    const views = ensureViews(db);
    log(`created views: ${views.join(", ")}`);
  }

  if (args.includes("--report")) {
    // Ensure first so --report alone works on a database that never had them.
    if (!args.includes("--ensure")) ensureViews(db);

    const one = (sql) => db.prepare(sql).get();
    const all = (sql) => db.prepare(sql).all();

    const rawUsage = one("SELECT COUNT(*) n FROM usage_facts").n;
    const canon = one(`SELECT COUNT(*) n,
        SUM(claim_count > 1) contested,
        SUM(cost_usd IS NULL) unpriced,
        ROUND(SUM(COALESCE(cost_usd, 0)), 2) usd
      FROM canonical_usage`);
    const rawCost = one(`SELECT ROUND(SUM(c.cost_usd), 2) usd
      FROM usage_facts u JOIN runs r USING(run_id)
      LEFT JOIN cost_facts c ON c.run_id=u.run_id AND c.usage_id=u.usage_id AND c.price_set_id=r.price_set_id`).usd;

    const attribution = all("SELECT attribution, COUNT(*) n FROM canonical_usage GROUP BY 1 ORDER BY n DESC");
    const bySquad = all(`SELECT squad, COUNT(*) turns, ROUND(SUM(COALESCE(cost_usd,0)),2) usd,
        SUM(cost_usd IS NULL) unpriced
      FROM canonical_usage GROUP BY 1 ORDER BY usd DESC`);
    const rawTool = one("SELECT COUNT(*) n FROM tool_facts").n;
    const canonTool = one("SELECT COUNT(*) n, SUM(tool_has_error) errors FROM canonical_tool_facts");

    const report = {
      usage: { raw: rawUsage, canonical: canon.n, removed: rawUsage - canon.n, contested: canon.contested },
      cost: { rawUsd: rawCost, canonicalUsd: canon.usd, unpricedRows: canon.unpriced },
      toolFacts: { raw: rawTool, canonical: canonTool.n, errors: canonTool.errors },
      attribution: Object.fromEntries(attribution.map((r) => [r.attribution, r.n])),
      bySquad,
    };

    if (JSON_OUT) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      const pct = (a, b) => `${(100 * (b - a) / b).toFixed(1)}%`;
      log(`usage rows   ${rawUsage} raw -> ${canon.n} canonical  (${pct(canon.n, rawUsage)} were duplicate attributions)`);
      log(`  contested by more than one run: ${canon.contested}`);
      log(`tool facts   ${rawTool} raw -> ${canonTool.n} canonical  (${canonTool.errors} errored calls)`);
      log(`cost         $${rawCost} summed per run  ->  $${canon.usd} for distinct calls`);
      log(`  ${canon.unpriced} rows have no price for their model (counted as unknown, not $0)`);
      log(`\nattribution confidence:`);
      for (const r of attribution) log(`  ${String(r.n).padStart(7)}  ${r.attribution}`);
      log(`\nby squad (canonical):`);
      for (const r of bySquad) {
        log(`  ${String(r.squad ?? "—").padEnd(12)} ${String(r.turns).padStart(6)} turns  $${String(r.usd).padStart(9)}  ${r.unpriced} unpriced`);
      }
    }
  }

  db.close();
}
