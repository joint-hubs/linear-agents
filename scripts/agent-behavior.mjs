#!/usr/bin/env node
/**
 * scripts/agent-behavior.mjs — behavioural metrics over the canonical views.
 *
 * Cost telemetry answers "what did this cost". This answers "was the work any
 * good", using two signals that need no human labelling:
 *
 *   repeat rate  — the same tool called with byte-identical arguments, by the
 *                  same agent, inside one run. A second identical call cannot
 *                  return new information (the transcript already holds the
 *                  first result), so every repeat past the first is an agent
 *                  going in circles. Observed worst case: one file read 703
 *                  times in a single run, 115 of them byte-identical.
 *   error rate   — tool calls whose tool_result came back is_error.
 *
 * Both are per (run, agent), never fleet-wide strings: two agents reading the
 * same file is normal collaboration; one agent reading it 115 times is not.
 * JSON keys are order-normalised first, because the same call serialises as
 * both {"limit":1,"offset":608,...} and {"offset":608,"limit":1,...} — grouping
 * on the raw string undercounts repeats by roughly half.
 *
 * Reads canonical_usage / canonical_tool_facts (telemetry-canonical.mjs), so
 * run-scoped duplicates are already collapsed. Read-only.
 *
 * Usage:
 *   node scripts/agent-behavior.mjs                # all breakdowns
 *   node scripts/agent-behavior.mjs --by model     # one breakdown
 *   node scripts/agent-behavior.mjs --by run --min 50
 *   node scripts/agent-behavior.mjs --json
 */

import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { telemetryDbPath } from "./telemetry-store.mjs";

const args = process.argv.slice(2);
const JSON_OUT = args.includes("--json");
const BY = (() => {
  const i = args.indexOf("--by");
  return i >= 0 ? args[i + 1] : null;
})();
const MIN = (() => {
  const i = args.indexOf("--min");
  return i >= 0 ? Number(args[i + 1]) : null;
})();


/** Order-independent key for a tool call's arguments. */
export function normaliseArgs(input) {
  if (!input) return "";
  try {
    const parsed = JSON.parse(input);
    if (!parsed || typeof parsed !== "object") return String(input);
    return JSON.stringify(Object.keys(parsed).sort().map((k) => [k, parsed[k]]));
  } catch {
    return String(input);
  }
}

/**
 * Group tool calls and count exact repeats.
 * @returns {{ totals, byModel, bySquad, byTool, byRun, byAgent }}
 */
export function analyseToolCalls(rows) {
  // Model is deliberately NOT part of the key: an agent that repeats a call
  // after switching models is still looping. But a group can therefore span
  // models, so each row is attributed on its own — crediting a whole group to
  // its first row would file a second model's calls under the first.
  const groups = new Map();
  for (const row of rows) {
    const key = JSON.stringify([row.run_id, row.agent_key, row.tool_name_canon, normaliseArgs(row.tool_input)]);
    const existing = groups.get(key);
    if (existing) existing.push(row);
    else groups.set(key, [row]);
  }

  const dims = { byModel: new Map(), bySquad: new Map(), byTool: new Map(), byRun: new Map(), byAgent: new Map() };
  const totals = { calls: 0, repeats: 0, errors: 0 };

  const entryFor = (map, key) => {
    if (key == null || key === "") return null;
    let entry = map.get(key);
    if (!entry) { entry = { calls: 0, repeats: 0, errors: 0, label: key }; map.set(key, entry); }
    return entry;
  };

  for (const members of groups.values()) {
    members.forEach((row, index) => {
      const isRepeat = index > 0;
      totals.calls++;
      if (isRepeat) totals.repeats++;
      if (row.tool_has_error) totals.errors++;
      for (const [map, key] of [
        [dims.byModel, row.model], [dims.bySquad, row.squad], [dims.byTool, row.tool_name_canon],
        [dims.byRun, row.run_id], [dims.byAgent, row.agent_key],
      ]) {
        const entry = entryFor(map, key);
        if (!entry) continue;
        entry.calls++;
        if (isRepeat) entry.repeats++;
        if (row.tool_has_error) entry.errors++;
      }
    });
  }

  return { totals, ...dims };
}

// ---------------------------------------------------------------------------
// CLI — skipped on import so the module can be unit-tested.
// ---------------------------------------------------------------------------

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  if (args.includes("--help")) {
    console.log(`Usage: node scripts/agent-behavior.mjs [--by model|squad|tool|run|agent] [--min N] [--json]

  --by     Restrict output to one breakdown (default: all).
  --min    Minimum tool calls for a group to be listed.
  --json   Machine-readable output.`);
    process.exit(0);
  }

  const db = new DatabaseSync(telemetryDbPath(), { readOnly: true });

  const views = db.prepare("SELECT name FROM sqlite_master WHERE type='view'").all().map((r) => r.name);
  for (const needed of ["canonical_tool_facts", "canonical_usage"]) {
    if (!views.includes(needed)) {
      console.error(`Missing view ${needed}. Run: node scripts/telemetry-canonical.mjs --ensure`);
      process.exit(1);
    }
  }

  const rows = db.prepare(`SELECT run_id, agent_key, squad, model, tool_name_canon, tool_input, tool_has_error
    FROM canonical_tool_facts`).all();
  const result = analyseToolCalls(rows);

  // Delegation share: the squads' CLAUDE.md all require ">=40% of a run's cost at
  // subagents". Measured here rather than asserted.
  const share = db.prepare(`SELECT
      CASE WHEN agent_key='_lead' THEN 'lead' ELSE 'subagent' END AS who,
      COUNT(*) turns, ROUND(SUM(COALESCE(cost_usd,0)),2) usd
    FROM canonical_usage GROUP BY 1`).all();
  const lead = share.find((r) => r.who === "lead") || { usd: 0, turns: 0 };
  const sub = share.find((r) => r.who === "subagent") || { usd: 0, turns: 0 };
  const delegationShare = (lead.usd + sub.usd) > 0 ? sub.usd / (lead.usd + sub.usd) : 0;

  const pct = (a, b) => (b > 0 ? (100 * a) / b : 0);
  const rank = (map, min) => [...map.values()]
    .filter((v) => v.calls >= (min ?? 0))
    .sort((a, b) => pct(b.repeats, b.calls) - pct(a.repeats, a.calls));

  const DEFAULT_MIN = { byModel: 400, bySquad: 0, byTool: 300, byRun: 50, byAgent: 300 };
  const TITLES = {
    byModel: "by model", bySquad: "by squad", byTool: "by tool",
    byRun: "by run", byAgent: "by agent key",
  };

  if (JSON_OUT) {
    const out = { totals: result.totals, delegation: { leadUsd: lead.usd, subagentUsd: sub.usd, subagentShare: delegationShare } };
    for (const dim of Object.keys(TITLES)) {
      if (BY && `by${BY[0].toUpperCase()}${BY.slice(1)}` !== dim) continue;
      out[dim] = rank(result[dim], MIN ?? DEFAULT_MIN[dim]);
    }
    console.log(JSON.stringify(out, null, 2));
  } else {
    const t = result.totals;
    console.log(`tool calls ${t.calls}  |  exact repeats ${t.repeats} (${pct(t.repeats, t.calls).toFixed(1)}%)  |  errors ${t.errors} (${pct(t.errors, t.calls).toFixed(1)}%)`);
    console.log(`delegation: subagents hold ${(100 * delegationShare).toFixed(1)}% of cost ($${sub.usd} of $${(lead.usd + sub.usd).toFixed(2)}) — squad playbooks require >=40%`);

    for (const dim of Object.keys(TITLES)) {
      if (BY && `by${BY[0].toUpperCase()}${BY.slice(1)}` !== dim) continue;
      const listed = rank(result[dim], MIN ?? DEFAULT_MIN[dim]).slice(0, 12);
      if (!listed.length) continue;
      console.log(`\n${TITLES[dim]}  (repeat% / error% / calls)`);
      for (const r of listed) {
        console.log(`  ${pct(r.repeats, r.calls).toFixed(1).padStart(5)}%  ${pct(r.errors, r.calls).toFixed(1).padStart(5)}%  ${String(r.calls).padStart(6)}  ${r.label}`);
      }
    }
  }

  db.close();
}
