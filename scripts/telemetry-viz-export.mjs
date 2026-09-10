#!/usr/bin/env node
/**
 * scripts/telemetry-viz-export.mjs — one JSON payload behind every chart in
 * docs/research/telemetry-analysis-2026-09.md.
 *
 * The report's findings live in three different places: the telemetry store
 * (cost, cache, tool behaviour), the research scratch JSONs the analysis squad
 * left behind (failures, gates, findings, first-turn re-derivation), and
 * config/graph.json (the budget hints reality is compared against). A chart
 * that re-derives any of them by hand is a chart that will disagree with the
 * report by next week. This collects all of it once, with provenance.
 *
 * Every series is tagged with the finding it belongs to (F1…F7), so a
 * visualisation can be built section by section without re-reading the prose.
 *
 * Data honesty rules carried into the payload:
 *   - cost comes from canonical_usage (run-scoped duplicates already collapsed)
 *   - `unpriced` counts are exported next to every cost figure, never folded in
 *   - `inflation` reports BOTH known over-counts, because they multiply
 *   - scratch-derived series degrade to null when .state/research-scratch is
 *     absent, and `sources` says which ones made it
 *
 * Read-only. Usage:
 *   node scripts/telemetry-viz-export.mjs [--out report/viz-data.json] [--deep]
 *
 *   --deep  also rescans transcripts to measure the message-id inflation
 *           factor (~1 min over 600 MB); otherwise the stored estimate is used.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { telemetryDbPath } from "./telemetry-store.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRATCH = join(root, ".state", "research-scratch");

const args = process.argv.slice(2);
const DEEP = args.includes("--deep");
const OUT = (() => {
  const i = args.indexOf("--out");
  return i >= 0 ? args[i + 1] : join(root, "report", "viz-data.json");
})();

if (args.includes("--help")) {
  console.log(`Usage: node scripts/telemetry-viz-export.mjs [--out PATH] [--deep]

  --out   Output path (default report/viz-data.json)
  --deep  Rescan transcripts for the message-id inflation factor (~1 min)`);
  process.exit(0);
}

const db = new DatabaseSync(telemetryDbPath(), { readOnly: true });
const all = (sql, ...p) => db.prepare(sql).all(...p);
const one = (sql, ...p) => db.prepare(sql).get(...p);

const views = all("SELECT name FROM sqlite_master WHERE type='view'").map((r) => r.name);
if (!views.includes("canonical_usage")) {
  console.error("Missing canonical_usage. Run: node scripts/telemetry-canonical.mjs --ensure");
  process.exit(1);
}

const sources = { telemetry: true, scratch: existsSync(SCRATCH), graph: false };
const readScratch = (name) => {
  const p = join(SCRATCH, name);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
};

// ---------------------------------------------------------------------------
// F2 — cost
// ---------------------------------------------------------------------------
const costBySquad = all(`SELECT squad AS label, COUNT(*) AS turns,
    ROUND(SUM(COALESCE(cost_usd,0)),2) AS usd, SUM(cost_usd IS NULL) AS unpriced
  FROM canonical_usage GROUP BY 1 ORDER BY usd DESC`);

const costByModel = all(`SELECT model AS label, COUNT(*) AS turns,
    ROUND(SUM(COALESCE(cost_usd,0)),2) AS usd, SUM(cost_usd IS NULL) AS unpriced
  FROM canonical_usage WHERE model IS NOT NULL GROUP BY 1 ORDER BY usd DESC`);

// Week buckets: ISO-ish, good enough for a trend line and stable across runs.
const costByWeek = all(`SELECT strftime('%Y-W%W', observed_at) AS label,
    COUNT(*) AS turns, ROUND(SUM(COALESCE(cost_usd,0)),2) AS usd
  FROM canonical_usage WHERE observed_at IS NOT NULL GROUP BY 1 ORDER BY 1`);

const leadVsSub = all(`SELECT CASE WHEN agent_key='_lead' THEN 'lead' ELSE 'subagent' END AS label,
    COUNT(*) AS turns, ROUND(SUM(COALESCE(cost_usd,0)),2) AS usd
  FROM canonical_usage GROUP BY 1`);

const costByRole = all(`SELECT agent_key AS label, COUNT(*) AS turns,
    ROUND(SUM(COALESCE(cost_usd,0)),2) AS usd
  FROM canonical_usage WHERE agent_key <> '_lead' AND agent_key NOT LIKE 'agent-%'
  GROUP BY 1 ORDER BY usd DESC LIMIT 20`);

// Budget shares measured against graph.json's own hints (F2).
let budgetShares = null;
const graphPath = join(root, "config", "graph.json");
if (existsSync(graphPath)) {
  try {
    const graph = JSON.parse(readFileSync(graphPath, "utf8"));
    sources.graph = true;
    const totals = Object.fromEntries(costBySquad.map((r) => [r.label, r.usd]));
    const staged = ["plan", "dev", "review", "test"];
    const denom = staged.reduce((a, s) => a + (totals[s] || 0), 0);
    budgetShares = staged.map((squad) => ({
      label: squad,
      stage: graph.nodes?.[squad]?.budget?.stage ?? null,
      measuredShare: denom > 0 ? Number(((totals[squad] || 0) / denom).toFixed(4)) : null,
      hintShare: graph.nodes?.[squad]?.budget?.shareHint ?? null,
    })).map((r) => ({
      ...r,
      deltaPp: r.measuredShare != null && r.hintShare != null
        ? Number((100 * (r.measuredShare - r.hintShare)).toFixed(1)) : null,
    }));
  } catch { /* graph unreadable — leave null */ }
}

// ---------------------------------------------------------------------------
// F3 — behaviour: repeats, errors, cache
// ---------------------------------------------------------------------------
const normaliseArgs = (input) => {
  if (!input) return "";
  try {
    const p = JSON.parse(input);
    if (!p || typeof p !== "object") return String(input);
    return JSON.stringify(Object.keys(p).sort().map((k) => [k, p[k]]));
  } catch { return String(input); }
};

const toolRows = all(`SELECT run_id, agent_key, squad, model, tool_name_canon, tool_input, tool_has_error
  FROM canonical_tool_facts`);
const groups = new Map();
for (const row of toolRows) {
  const key = JSON.stringify([row.run_id, row.agent_key, row.tool_name_canon, normaliseArgs(row.tool_input)]);
  const g = groups.get(key);
  if (g) g.push(row); else groups.set(key, [row]);
}
const dims = { model: new Map(), tool: new Map(), squad: new Map() };
const behaviourTotals = { calls: 0, repeats: 0, errors: 0 };
for (const members of groups.values()) {
  members.forEach((row, i) => {
    const repeat = i > 0;
    behaviourTotals.calls++;
    if (repeat) behaviourTotals.repeats++;
    if (row.tool_has_error) behaviourTotals.errors++;
    for (const [map, key] of [[dims.model, row.model], [dims.tool, row.tool_name_canon], [dims.squad, row.squad]]) {
      if (key == null) continue;
      let e = map.get(key);
      if (!e) { e = { label: key, calls: 0, repeats: 0, errors: 0 }; map.set(key, e); }
      e.calls++;
      if (repeat) e.repeats++;
      if (row.tool_has_error) e.errors++;
    }
  });
}
const withRates = (map, min) => [...map.values()]
  .filter((v) => v.calls >= min)
  .map((v) => ({ ...v,
    repeatPct: Number((100 * v.repeats / v.calls).toFixed(1)),
    errorPct: Number((100 * v.errors / v.calls).toFixed(1)) }))
  .sort((a, b) => b.repeatPct - a.repeatPct);

const cacheBySquad = all(`SELECT squad AS label, COUNT(*) AS turns,
    ROUND(100.0*SUM(cache_read_tokens)/NULLIF(SUM(cache_read_tokens+input_tokens),0),1) AS cacheHitPct
  FROM canonical_usage GROUP BY 1 ORDER BY cacheHitPct DESC`);
const cacheByModel = all(`SELECT model AS label, COUNT(*) AS turns,
    ROUND(100.0*SUM(cache_read_tokens)/NULLIF(SUM(cache_read_tokens+input_tokens),0),1) AS cacheHitPct
  FROM canonical_usage WHERE model IS NOT NULL GROUP BY 1 HAVING turns>200 ORDER BY cacheHitPct ASC`);

// ---------------------------------------------------------------------------
// F7 — data quality. Both inflation factors, because they multiply.
// ---------------------------------------------------------------------------
const rawCost = one(`SELECT COUNT(*) AS turns, ROUND(SUM(c.cost_usd),2) AS usd
  FROM usage_facts u JOIN runs r USING(run_id)
  LEFT JOIN cost_facts c ON c.run_id=u.run_id AND c.usage_id=u.usage_id AND c.price_set_id=r.price_set_id`);
const canonCost = one(`SELECT COUNT(*) AS turns, ROUND(SUM(COALESCE(cost_usd,0)),2) AS usd,
    SUM(cost_usd IS NULL) AS unpriced FROM canonical_usage`);

function measureMessageInflation() {
  const FIELDS = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"];
  let naive = 0, dedup = 0, lines = 0, messages = 0;
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith(".jsonl")) continue;
      let text;
      try { if (statSync(p).size > 80e6) continue; text = readFileSync(p, "utf8"); } catch { continue; }
      const perMessage = new Map();
      for (const line of text.split("\n")) {
        if (!line) continue;
        let x;
        try { x = JSON.parse(line); } catch { continue; }
        if (x.type !== "assistant") continue;
        const u = x.message?.usage;
        if (!u) continue;
        lines++;
        const id = x.message?.id ?? `line-${lines}`;
        let m = perMessage.get(id);
        if (!m) { m = {}; perMessage.set(id, m); }
        for (const f of FIELDS) {
          const v = u[f] || 0;
          naive += v;
          if (!(m[f] > v)) m[f] = v;   // max wins: the real value, not the zero copies
        }
      }
      messages += perMessage.size;
      for (const m of perMessage.values()) for (const f of FIELDS) dedup += m[f] || 0;
    }
  };
  walk(join(root, "agents"));
  const archive = join(root, ".state", "transcript-archive-20260910");
  if (existsSync(archive)) walk(archive);
  return {
    lines, messages,
    linesPerMessage: messages ? Number((lines / messages).toFixed(2)) : null,
    naiveTokens: naive, perMessageTokens: dedup,
    factor: dedup ? Number((naive / dedup).toFixed(2)) : null,
  };
}

const runScoped = {
  rawTurns: rawCost.turns, canonicalTurns: canonCost.turns,
  rawUsd: rawCost.usd, canonicalUsd: canonCost.usd,
  factor: canonCost.usd ? Number((rawCost.usd / canonCost.usd).toFixed(2)) : null,
};
const messageScoped = DEEP ? measureMessageInflation() : { factor: 2.19, note: "stored estimate; rerun with --deep to re-measure" };

const canonCoverage = one(`SELECT COUNT(*) AS rows, SUM(tool_name_canon IS NULL) AS nullCanon FROM tool_facts`);
const unpricedModels = all(`SELECT model AS label, COUNT(*) AS turns FROM canonical_usage
  WHERE cost_usd IS NULL AND model IS NOT NULL GROUP BY 1 ORDER BY turns DESC LIMIT 10`);
const attribution = all(`SELECT attribution AS label, COUNT(*) AS turns FROM canonical_usage GROUP BY 1 ORDER BY turns DESC`);

// ---------------------------------------------------------------------------
// F1 / F4 / F5 / F6 — from the analysis squad's scratch data
// ---------------------------------------------------------------------------
const crashes = readScratch("A2-crash-classified.json");
const failureTaxonomy = Array.isArray(crashes)
  ? Object.entries(crashes.reduce((acc, c) => { acc[c.cause || "unknown"] = (acc[c.cause || "unknown"] || 0) + 1; return acc; }, {}))
      .map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n)
  : null;

const gateInv = readScratch("B1-inventory.json");
const gates = gateInv ? {
  total: gateInv.total ?? null,
  byKind: Object.entries(gateInv.byKind || {}).map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n),
  bySquad: Object.entries(gateInv.bySquad || {}).map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n),
  latency: gateInv.latency ?? null,
  pending: Array.isArray(gateInv.pending) ? gateInv.pending.length : (gateInv.pending ?? null),
} : null;

const classified = readScratch("b3-classified.json");
const findingClasses = Array.isArray(classified)
  ? Object.entries(classified.reduce((acc, f) => { const k = f.cls || "?"; acc[k] = (acc[k] || 0) + 1; return acc; }, {}))
      .map(([label, n]) => ({ label, n, pct: Number((100 * n / classified.length).toFixed(1)) }))
      .sort((a, b) => b.n - a.n)
  : null;
const findingsByRound = Array.isArray(classified)
  ? Object.entries(classified.reduce((acc, f) => { const k = `r${f.round ?? "?"}`; acc[k] = (acc[k] || 0) + 1; return acc; }, {}))
      .map(([label, n]) => ({ label, n })).sort((a, b) => a.label.localeCompare(b.label))
  : null;
const findingsBySeverity = Array.isArray(classified)
  ? Object.entries(classified.reduce((acc, f) => { const k = f.sev || "?"; acc[k] = (acc[k] || 0) + 1; return acc; }, {}))
      .map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n)
  : null;

const verdicts = readScratch("verdicts-flat.json");
const verdictOutcomes = Array.isArray(verdicts)
  ? Object.entries(verdicts.reduce((acc, v) => { const k = v.verdict || "?"; acc[k] = (acc[k] || 0) + 1; return acc; }, {}))
      .map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n)
  : null;

const b2 = readScratch("b2-aggregates.json");
const firstTurns = b2 ? {
  perSquad: b2.perSquad ?? null,
  quartiles: b2.quartiles ?? null,
  spearman: b2.spearman ?? null,
  acsImpact: b2.acsImpact ?? null,
} : null;

// ---------------------------------------------------------------------------
const payload = {
  generatedAt: new Date().toISOString(),
  sources,
  corpus: {
    firstTurn: one("SELECT MIN(observed_at) AS v FROM canonical_usage").v,
    lastTurn: one("SELECT MAX(observed_at) AS v FROM canonical_usage").v,
    runs: one("SELECT COUNT(*) AS n FROM runs").n,
    turns: canonCost.turns,
    toolCalls: behaviourTotals.calls,
  },
  F1_failures: { taxonomy: failureTaxonomy },
  F2_cost: {
    bySquad: costBySquad, byModel: costByModel, byWeek: costByWeek,
    leadVsSubagent: leadVsSub, byRole: costByRole, budgetShares,
  },
  F3_behaviour: {
    totals: {
      ...behaviourTotals,
      repeatPct: Number((100 * behaviourTotals.repeats / behaviourTotals.calls).toFixed(1)),
      errorPct: Number((100 * behaviourTotals.errors / behaviourTotals.calls).toFixed(1)),
    },
    byModel: withRates(dims.model, 200),
    byTool: withRates(dims.tool, 200),
    bySquad: withRates(dims.squad, 0),
    cacheBySquad, cacheByModel,
  },
  F4_gates: gates,
  F5_review: { findingClasses, findingsByRound, findingsBySeverity, verdictOutcomes },
  F6_firstTurns: firstTurns,
  F7_dataQuality: {
    inflation: {
      runScoped, messageScoped,
      combinedFactor: runScoped.factor && messageScoped.factor
        ? Number((runScoped.factor * messageScoped.factor).toFixed(2)) : null,
      note: "The two over-counts are independent and multiply. canonical_usage removes the run-scoped one only.",
    },
    canonCoverage: {
      rows: canonCoverage.rows, nullCanon: canonCoverage.nullCanon,
      coveragePct: Number((100 * (canonCoverage.rows - canonCoverage.nullCanon) / canonCoverage.rows).toFixed(1)),
    },
    unpricedModels, attribution,
  },
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(payload, null, 2), "utf8");
db.close();

const missing = Object.entries(sources).filter(([, v]) => !v).map(([k]) => k);
console.log(`wrote ${OUT} (${(JSON.stringify(payload).length / 1024).toFixed(0)} KB)`);
console.log(`  corpus: ${payload.corpus.turns} turns, ${payload.corpus.toolCalls} tool calls, ${payload.corpus.runs} runs`);
console.log(`  inflation: run-scoped ${runScoped.factor}x  message-id ${messageScoped.factor}x  combined ${payload.F7_dataQuality.inflation.combinedFactor}x`);
if (missing.length) console.log(`  degraded (missing sources): ${missing.join(", ")}`);
