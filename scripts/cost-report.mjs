// Cost guardrail (W6): pull OpenRouter activity, aggregate tokens+cost per model,
// compare to budget. Feeds the cost/token dashboard.
//
//   OPENROUTER_API_KEY=... node scripts/cost-report.mjs [--since=ISO] [--json] [--dry-run]
//
// Reads .env for OPENROUTER_API_KEY and COST_BUDGET_USD_PER_TASK (default 2).
// Uses Node 18+ global fetch. Zero runtime deps.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, "..");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Manual .env parser — zero deps, mirrors bootstrap-linear.mjs convention. */
function loadEnv() {
  try {
    const text = readFileSync(join(root, ".env"), "utf8");
    for (const line of text.split("\n")) {
      const s = line.trim();
      if (!s || s.startsWith("#")) continue;
      const eq = s.indexOf("=");
      if (eq < 0) continue;
      const k = s.slice(0, eq).trim();
      const v = s.slice(eq + 1).trim();
      // Don't override already-set env vars (e.g. from shell)
      if (!process.env[k]) process.env[k] = v;
    }
  } catch {
    // .env missing or unreadable — user may have set env vars directly
  }
}

function parseFlags(args) {
  const flags = { since: null, json: false, dryRun: false };
  for (const a of args) {
    if (a === "--json") flags.json = true;
    else if (a === "--dry-run") flags.dryRun = true;
    else if (a.startsWith("--since=")) flags.since = a.slice(8);
  }
  return flags;
}

function loadPricing() {
  try {
    const cfg = JSON.parse(readFileSync(join(root, "config", "models.json"), "utf8"));
    return cfg.pricing || {};
  } catch {
    return {};
  }
}

const fmt = (n) => Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const fmtInt = (n) => Number(n).toLocaleString("en-US");

// ---------------------------------------------------------------------------
// OpenRouter API
// ---------------------------------------------------------------------------

const ACTIVITY_URL = "https://openrouter.ai/api/v1/activity";

/**
 * Fetch activity from OpenRouter.
 * Returns array of ActivityItem: { prompt_tokens, completion_tokens, reasoning_tokens,
 *   usage, byok_usage_inference, requests, model, model_permaslug, date,
 *   provider_name, endpoint_id }.
 * The endpoint returns last 30 days grouped by endpoint (model + date).
 * No pagination — one response covers the window.
 * Cost = usage (OpenRouter credits) + byok_usage_inference (BYOK external credits).
 */
async function fetchActivity(key) {
  const res = await fetch(ACTIVITY_URL, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "(empty)");
    throw new Error(`OpenRouter API ${res.status} ${res.statusText}\n${body}`);
  }
  const data = await res.json();
  // Defensive: the response may be an array, or wrapped in { data: [...] }
  return Array.isArray(data) ? data : data.data || data.activity || [];
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function aggregate(rows, pricing) {
  const byModel = {};

  for (const r of rows) {
    const model = r.model || r.model_permaslug || "unknown";
    if (!byModel[model]) {
      byModel[model] = { prompt_tokens: 0, completion_tokens: 0, requests: 0, cost: 0, reasoning_tokens: 0 };
    }
    const a = byModel[model];
    a.prompt_tokens += r.prompt_tokens || 0;
    a.completion_tokens += r.completion_tokens || 0;
    a.requests += r.requests || 0;
    a.cost += (r.usage || 0) + (r.byok_usage_inference || 0);
    a.reasoning_tokens += r.reasoning_tokens || 0;
  }

  // Sort by cost descending
  const entries = Object.entries(byModel).sort((a, b) => b[1].cost - a[1].cost);

  const total = { prompt_tokens: 0, completion_tokens: 0, requests: 0, cost: 0, calcCost: 0 };
  const models = [];

  for (const [model, agg] of entries) {
    const p = pricing[model];
    const calcCost =
      p != null
        ? (agg.prompt_tokens / 1_000_000) * p.input + (agg.completion_tokens / 1_000_000) * p.output
        : null;

    total.prompt_tokens += agg.prompt_tokens;
    total.completion_tokens += agg.completion_tokens;
    total.requests += agg.requests;
    total.cost += agg.cost;
    total.calcCost += calcCost ?? 0;

    models.push({ model, ...agg, calcCost });
  }

  return { models, total };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function printTable({ models, total, budget, period }) {
  const out = (s) => process.stdout.write(s + "\n");

  out("");
  out("=== OpenRouter Cost Report ===");
  out(`Period: ${period.start} – ${period.end}  (${period.label})`);
  out("");

  // Header
  const cols = [
    { key: "model", label: "Model", width: 42 },
    { key: "prompt_tokens", label: "In Tok", width: 12, align: "right" },
    { key: "completion_tokens", label: "Out Tok", width: 12, align: "right" },
    { key: "requests", label: "Reqs", width: 8, align: "right" },
    { key: "cost", label: "Cost (API)", width: 14, align: "right" },
    { key: "calcCost", label: "Cost (calc)", width: 14, align: "right" },
  ];

  const header = cols.map((c) => c.label.padStart(c.align === "right" ? c.width : 0).padEnd(c.width)).join(" ");
  const sep = "─".repeat(header.length);

  out(header);
  out(sep);

  for (const m of models) {
    const costApi = `$${fmt(m.cost)}`;
    const costCalc = m.calcCost != null ? `$${fmt(m.calcCost)}` : "N/A";

    // Flag divergence >10% when both are non-zero
    const div =
      m.calcCost != null && m.cost > 0
        ? Math.abs(m.cost - m.calcCost) / Math.max(m.cost, m.calcCost)
        : 0;
    const marker = div > 0.1 ? " ⚠" : "";

    const row = [
      m.model.padEnd(42),
      fmtInt(m.prompt_tokens).padStart(12),
      fmtInt(m.completion_tokens).padStart(12),
      fmtInt(m.requests).padStart(8),
      costApi.padStart(14),
      costCalc.padStart(14) + marker,
    ].join(" ");
    out(row);
  }

  out(sep);

  const totalRow = [
    "TOTAL".padEnd(42),
    fmtInt(total.prompt_tokens).padStart(12),
    fmtInt(total.completion_tokens).padStart(12),
    fmtInt(total.requests).padStart(8),
    `$${fmt(total.cost)}`.padStart(14),
    `$${fmt(total.calcCost)}`.padStart(14),
  ].join(" ");
  out(totalRow);

  out("");
  const delta = total.cost - budget;
  const over = delta > 0 ? " ⚠ OVER BUDGET" : "";
  out(`Budget: $${fmt(budget)}/task | Total: $${fmt(total.cost)} | Delta: $${fmt(delta)}${over}`);

  // Per-model divergence detail
  const diverged = models.filter((m) => m.calcCost != null && m.cost > 0 && Math.abs(m.cost - m.calcCost) / Math.max(m.cost, m.calcCost) > 0.1);
  if (diverged.length) {
    out("");
    out("⚠ Cost divergence (>10% between API-reported and calculated):");
    for (const m of diverged) {
      out(`  ${m.model}: API $${fmt(m.cost)} vs calc $${fmt(m.calcCost)}`);
    }
  }
}

function printJson({ models, total, budget, period }) {
  const obj = {
    meta: {
      period,
      budget_per_task: budget,
      total_cost: total.cost,
      total_cost_calculated: total.calcCost,
      delta: total.cost - budget,
      over_budget: total.cost > budget,
    },
    models: Object.fromEntries(
      models.map((m) => [
        m.model,
        {
          prompt_tokens: m.prompt_tokens,
          completion_tokens: m.completion_tokens,
          reasoning_tokens: m.reasoning_tokens,
          requests: m.requests,
          cost_api: m.cost,
          cost_calculated: m.calcCost,
        },
      ])
    ),
  };
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Dry-run
// ---------------------------------------------------------------------------

function printDryRun(key, budget, flags, pricing) {
  const out = (s) => process.stdout.write(s + "\n");
  out("");
  out("=== Cost Report — Dry Run ===");
  out("");
  out("Config:");
  out(`  OPENROUTER_API_KEY:       ${key.slice(0, 8)}...${key.slice(-4)}`);
  out(`  COST_BUDGET_USD_PER_TASK: $${budget}`);
  out(`  --since:                  ${flags.since || "(none — fetch last 30 days)"}`);
  out(`  --json:                   ${flags.json}`);
  out("");
  out("Pricing loaded from config/models.json:");
  for (const [model, p] of Object.entries(pricing).sort()) {
    if (model.startsWith("_")) continue; // skip metadata keys
    out(`  ${model}: $${p.input}/$${p.output} per 1M tok`);
  }
  out("");
  out("API calls:");
  out(`  GET ${ACTIVITY_URL}`);
  out("  Headers: { Authorization: Bearer <key> }");
  out("  Response: { data: ActivityItem[] } — each item: { prompt_tokens, completion_tokens, reasoning_tokens, usage, byok_usage_inference, requests, model, model_permaslug, date, provider_name, endpoint_id }");
  out("  Note: returns last 30 days, grouped by endpoint (model + date). No pagination.");
  out("");
  out("Post-processing:");
  out("  1. Filter rows by --since (client-side Date comparison)");
  out("  2. Aggregate by model (sum tokens, requests, cost)");
  out("  3. Compute cost two ways:");
  out("     a) From API usage field (OpenRouter-reported cost)");
  out("     b) From pricing × tokens (fallback: input_tok/1M * price_in + output_tok/1M * price_out)");
  out("  4. Flag divergence >10% between (a) and (b)");
  out("  5. Compare total cost to budget per task");
  out("");
  out("Output:");
  out("  - Console table (per model + grand total + budget delta)");
  if (flags.json) out("  - Machine-readable JSON to stdout");
  out("");
  out("Dry-run complete. Remove --dry-run to execute.");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  loadEnv();

  const flags = parseFlags(process.argv.slice(2));
  const budget = Number(process.env.COST_BUDGET_USD_PER_TASK ?? 2);
  const pricing = loadPricing();

  // --dry-run: print plan and exit (no API key required)
  if (flags.dryRun) {
    const key = process.env.OPENROUTER_API_KEY || "(not set — set OPENROUTER_API_KEY in .env)";
    printDryRun(key, budget, flags, pricing);
    return;
  }

  const KEY = process.env.OPENROUTER_API_KEY;
  if (!KEY) {
    console.error("Missing OPENROUTER_API_KEY — set in .env or environment");
    process.exit(1);
  }

  // Fetch activity
  const rows = await fetchActivity(KEY);
  if (!rows.length) {
    console.log("No activity data returned from OpenRouter.");
    return;
  }

  // Filter by --since (do this first so period reflects the actual window)
  let filtered = rows;
  if (flags.since) {
    // Normalize both sides to UTC midnight for timezone-safe comparison
    const since = new Date(flags.since + "T00:00:00Z");
    if (isNaN(since.getTime())) {
      console.error(`Invalid --since value: ${flags.since} (use ISO 8601, e.g. 2026-06-01)`);
      process.exit(1);
    }
    filtered = rows.filter((r) => {
      const d = new Date(r.date + "T00:00:00Z");
      return d >= since;
    });
  }

  if (!filtered.length) {
    console.log("No activity data in the filtered period.");
    return;
  }

  // Determine period from filtered rows
  const dates = filtered.map((r) => r.date).filter(Boolean).sort();
  const period = {
    start: dates[0] || "?",
    end: dates[dates.length - 1] || "?",
    label: flags.since ? `filtered since ${flags.since}` : "last 30 days",
  };

  // Aggregate
  const { models, total } = aggregate(filtered, pricing);

  // Output
  if (flags.json) {
    // When --json, table goes to stderr, JSON to stdout (pipe-friendly)
    const _stdout = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s) => process.stderr.write(s);
    printTable({ models, total, budget, period });
    process.stdout.write = _stdout;
    printJson({ models, total, budget, period });
  } else {
    printTable({ models, total, budget, period });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
