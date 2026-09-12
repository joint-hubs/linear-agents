#!/usr/bin/env node
/**
 * scripts/telemetry-canonical.mjs — one row per PHYSICAL model call.
 *
 * Why this exists. ADR-0008 made facts run-scoped: when several runs share one
 * transcript file, each run gets its own copy of that file's rows. That is
 * correct for "what did run X cost" — but it makes every FLEET question
 * ("what did I spend", "which model errors most") count the same API call once
 * per claiming run. On top of that sits a second over-count: a single
 * assistant message is several JSONL lines (thinking / text / tool_use), and
 * every one of them repeats the same usage object; ingest keys rows by byte
 * offset, so the repeats became distinct rows. Measured 2026-09-12 on a copy
 * of the live store: 182 796 usage rows → 74 086 physical calls; the pinned
 * raw sum $7 029.53 → $1 557.42 once both layers are removed (FOC-221).
 *
 * The rule (two layers, both read-side):
 *   1. Run-scoped claims on one call are NOT summed — among the runs claiming
 *      a call, one representative wins (fit, then time distance, then ids).
 *   2. The repeated per-message usage lines are collapsed into one row:
 *      partition by (source_path, agent_key, model), order by byte offset, and
 *      keep rows on the same island while the token tuple is IDENTICAL and the
 *      gap to the previous line stays within MESSAGE_GAP_MS (300 s; the
 *      largest observed per-message span is 173 s). The representative line
 *      carries the message's usage; `line_count` says how many lines were
 *      folded, `collapsed_lines` in the report is the sum of line_count-1.
 *
 * Identical tuples only: zero-token rows never bridge two messages (checked
 * against message.id ground truth on 2 161 real messages — islands match
 * messages exactly).
 *
 * The representative row keeps an `attribution` label rather than hiding the
 * guesswork:
 *
 *   in_window     the call happened between the run's start and end   ← trusted
 *   after_end     the run had already finished; nearest start wins
 *   before_start  the run had not started yet
 *   no_timestamp  no time on either side; run_id breaks the tie
 *
 * Cost is joined at the run's OWN price_set_id. cost_facts holds a row per
 * price snapshot, so a join without that predicate multiplies every sum — the
 * trap ADR-0008 names under "Join complexity". A call whose model was missing
 * from the snapshot yields NULL, never 0: unpriced is not free, and `--report`
 * counts those rows separately.
 *
 * This file is now a thin CLI over the store: the SQL lives in
 * telemetry-store.mjs next to its JS twin (collapseUsageIslands) so the two
 * cannot drift apart — the contract test in telemetry-canonical.test.mjs
 * asserts they agree row for row.
 *
 * Usage:
 *   node scripts/telemetry-canonical.mjs --ensure    # (re)create the views
 *   node scripts/telemetry-canonical.mjs --report    # fleet totals, raw vs canonical
 *   node scripts/telemetry-canonical.mjs --report --json
 */

import { DatabaseSync } from "node:sqlite";
import { telemetryDbPath, CANONICAL_USAGE_SQL, CANONICAL_TOOL_SQL, ensureCanonicalViews } from "./telemetry-store.mjs";

export { CANONICAL_USAGE_SQL, CANONICAL_TOOL_SQL };

/**
 * Create both views, replacing any earlier definition. DROP+CREATE rather than
 * CREATE IF NOT EXISTS: a view that silently kept a stale definition after this
 * file changed would be worse than no view at all. Safe to call on every open —
 * a view holds no data. (The store already calls this at the end of migrate();
 * the CLI keeps its own entry point for databases opened read-write here.)
 */
export function ensureViews(db) {
  return ensureCanonicalViews(db);
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
        SUM(line_count - 1) collapsed_lines,
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
      usage: {
        raw: rawUsage, canonical: canon.n, removed: rawUsage - canon.n,
        contested: canon.contested,
        collapsedLines: canon.collapsed_lines ?? 0,
      },
      cost: {
        rawUsd: rawCost, canonicalUsd: canon.usd, unpricedRows: canon.unpriced,
        // Population label (FOC-221 review): this counts EVERY canonical row
        // with NULL cost — synthetic and unknown models included. The
        // usage-audit's unpricedRows is narrower (known non-synthetic models
        // only); the two are deliberately different populations.
        unpricedRowsNote: "every canonical row with NULL cost — synthetic models and NULL models included",
      },
      toolFacts: { raw: rawTool, canonical: canonTool.n, errors: canonTool.errors },
      attribution: Object.fromEntries(attribution.map((r) => [r.attribution, r.n])),
      bySquad,
    };

    if (JSON_OUT) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      const pct = (a, b) => `${(100 * (b - a) / b).toFixed(1)}%`;
      log(`usage rows   ${rawUsage} raw -> ${canon.n} canonical  (${pct(canon.n, rawUsage)} were over-counted)`);
      log(`  per-message usage lines collapsed: ${canon.collapsed_lines ?? 0}`);
      log(`  contested by more than one run: ${canon.contested}`);
      log(`tool facts   ${rawTool} raw -> ${canonTool.n} canonical  (${canonTool.errors} errored calls)`);
      log(`cost         $${rawCost} summed per run  ->  $${canon.usd} for distinct calls`);
      log(`  ${canon.unpriced} rows have no price for their model (counted as unknown, not $0; ALL NULL-cost rows — synthetic + unknown models included)`);
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
