#!/usr/bin/env node
/**
 * scripts/agent-behavior.mjs — behavioural metrics over the canonical views.
 *
 * Cost telemetry answers "what did this cost". This answers "was the work any
 * good", using two signals that need no human labelling:
 *
 *   repeats      — the same tool called with the same arguments, by the same
 *                  agent, inside one run. A repeat PAST THE FIRST is not
 *                  automatically waste (FOC-220): every occurrence lands in an
 *                  honest category —
 *
 *                    reread_after_edit   a Read repeated after an Edit/Write on
 *                                        the same file in between
 *                    rerun_after_change  a repeat after any intervening
 *                                        mutation (e.g. a test rerun after a
 *                                        code change)
 *                    result_changed      no mutation observed, but the result
 *                                        digest differs — a poll whose world
 *                                        moved between calls
 *                    unchanged           no mutation, byte-identical result —
 *                                        the only provable
 *                                        no-new-information repeat
 *                    unknown             no evidence either way (missing
 *                                        tool_result, or a pre-FOC-220 row
 *                                        whose result was never measured)
 *
 *                  Classification never guesses: where the data cannot justify
 *                  the rerun AND cannot prove waste, the category is `unknown`.
 *                  Grouping keys on tool_input_id — an HMAC of the COMPLETE
 *                  input, key-order independent at every depth
 *                  (tool-identity.mjs) — so nested key reordering and a shared
 *                  1000-char preview prefix no longer merge or split calls.
 *                  Rows without an identity (pre-FOC-220, unrepaired) fall back
 *                  to the canonicalized preview; run the
 *                  telemetry-normalize-tools repair to fill theirs in.
 *
 *   error rate   — tool calls whose tool_result came back is_error. The
 *                  complement is NOT "ok": `outcome unknown` counts rows whose
 *                  result is missing or was never recorded (tool_result_state
 *                  NULL on historical rows), so a missing result is never
 *                  mistaken for a success.
 *
 * Both are per (run, agent), never fleet-wide strings: two agents reading the
 * same file is normal collaboration; one agent reading it 115 times is not.
 *
 * Ordering is a stable TOTAL order over tool facts — (observed_at, source_path,
 * source_offset, tool_index, tool_fact_id) — so identical inputs, identical
 * args and identical runs order deterministically regardless of SQLite's return
 * order, and the repeat/error details (--detail) are inspectable in that order.
 *
 * Reads canonical_usage / canonical_tool_facts (telemetry-canonical.mjs), so
 * run-scoped duplicates are already collapsed. Read-only.
 *
 * Usage:
 *   node scripts/agent-behavior.mjs                # all breakdowns
 *   node scripts/agent-behavior.mjs --by model     # one breakdown
 *   node scripts/agent-behavior.mjs --by run --min 50
 *   node scripts/agent-behavior.mjs --json
 *   node scripts/agent-behavior.mjs --json --detail
 */

import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { canonicalInputJson } from "./tool-identity.mjs";
import { telemetryDbPath } from "./telemetry-store.mjs";

const args = process.argv.slice(2);
const JSON_OUT = args.includes("--json");
const DETAIL = args.includes("--detail");
const BY = (() => {
  const i = args.indexOf("--by");
  return i >= 0 ? args[i + 1] : null;
})();
const MIN = (() => {
  const i = args.indexOf("--min");
  return i >= 0 ? Number(args[i + 1]) : null;
})();


/** Order-independent key for a tool call's arguments — at EVERY depth (FOC-220). */
export function normaliseArgs(input) {
  if (!input) return "";
  const canonical = canonicalInputJson(input);
  return canonical !== null ? canonical : String(input);
}

// Total order over tool facts (FOC-220): every component comes from the row
// itself, so the order never depends on SQLite's return order or the input row
// order. tool_fact_id is unique within the canonical view, which makes the
// order total even when two calls share observed_at, path, offset and index.
function orderKeyOf(row) {
  return [
    row.observed_at ?? "",
    row.source_path ?? "",
    row.source_offset ?? -1,
    row.tool_index ?? -1,
    row.tool_fact_id ?? "",
  ];
}

function compareOrderKeys(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

const byOrderKey = (a, b) => compareOrderKeys(orderKeyOf(a), orderKeyOf(b));

// Canon names from config/tool-norm.json. Only direct file mutations count as
// rerun evidence: a Bash call may or may not mutate anything, so it can neither
// justify a repeat nor prove waste — the result digest decides those cases.
const MUTATING_TOOLS = new Set(["edit_file", "write_file"]);
const READ_TOOLS = new Set(["read_file"]);

/** Best-effort path a Read/Edit/Write targeted. In-memory only, never logged. */
function targetedPath(row) {
  try {
    const parsed = JSON.parse(row.tool_input);
    if (parsed && typeof parsed === "object") {
      return parsed.file_path ?? parsed.notebook_path ?? null;
    }
  } catch { /* not JSON — no path */ }
  return null;
}

/** Positions p of a sorted list with lo < p < hi. */
function positionsBetween(sorted, lo, hi) {
  let a = 0;
  let b = sorted.length;
  while (a < b) {
    const mid = (a + b) >> 1;
    if (sorted[mid] <= lo) a = mid + 1;
    else b = mid;
  }
  const out = [];
  for (let i = a; i < sorted.length && sorted[i] < hi; i++) out.push(sorted[i]);
  return out;
}

const evidenceOf = (row) => ({
  tool_fact_id: row.tool_fact_id ?? null,
  source_path: row.source_path ?? null,
  source_offset: row.source_offset ?? null,
  tool_name_canon: row.tool_name_canon ?? null,
});

/**
 * Classify one repeat occurrence (members[index], index > 0) against the
 * occurrence before it, looking only at the ordered calls of the same
 * (run, agent) in between. Never fabricates: without mutation evidence AND
 * comparable result digests the category is `unknown`.
 */
function classifyOccurrence({ members, index, ordered, posOf, positionsByRunAgent }) {
  const row = members[index];
  const prev = members[index - 1];
  const positions = positionsByRunAgent.get(`${row.run_id ?? ""}\u0000${row.agent_key ?? ""}`) || [];
  const window = positionsBetween(positions, posOf.get(prev), posOf.get(row));

  const mutations = window.map((p) => ordered[p]).filter((w) => MUTATING_TOOLS.has(w.tool_name_canon));
  if (mutations.length) {
    const readPath = READ_TOOLS.has(row.tool_name_canon) ? targetedPath(row) : null;
    const match = readPath != null ? mutations.find((m) => targetedPath(m) === readPath) : null;
    if (match) {
      return { category: "reread_after_edit", evidence: { mutatedBy: evidenceOf(match), path: readPath } };
    }
    return { category: "rerun_after_change", evidence: { mutatedBy: evidenceOf(mutations[0]) } };
  }
  if (row.tool_result_id != null && prev.tool_result_id != null) {
    const equal = row.tool_result_id === prev.tool_result_id;
    return {
      category: equal ? "unchanged" : "result_changed",
      evidence: {
        comparedTo: prev.tool_fact_id ?? null,
        priorBytes: prev.tool_result_bytes ?? null,
        bytes: row.tool_result_bytes ?? null,
      },
    };
  }
  return {
    category: "unknown",
    evidence: { reason: "no mutation observed; result digest unavailable (missing tool_result or pre-FOC-220 row)" },
  };
}

const REPEAT_CATEGORIES = ["reread_after_edit", "rerun_after_change", "result_changed", "unchanged", "unknown"];
const emptyCategories = () => Object.fromEntries(REPEAT_CATEGORIES.map((c) => [c, 0]));

// A call whose outcome cannot be vouched for: the result never came back
// ('missing'), or the row predates result measurement (state NULL) and was
// never flagged as an error. Counted separately so missing is never ok.
const outcomeUnknown = (row) => {
  if (row.tool_has_error) return false;
  if (row.tool_result_state === "ok") return false;
  return true;
};

/**
 * Group tool calls, count repeats past the first, classify every repeat into an
 * honest category, and collect the ordered inspection details.
 * @returns {{ totals, details, byModel, bySquad, byTool, byRun, byAgent }}
 */
export function analyseToolCalls(rows) {
  // Model is deliberately NOT part of the key: an agent that repeats a call
  // after switching models is still looping. But a group can therefore span
  // models, so each row is attributed on its own — crediting a whole group to
  // its first row would file a second model's calls under the first.
  const ordered = [...rows].sort(byOrderKey);
  const posOf = new Map(ordered.map((row, i) => [row, i]));
  const positionsByRunAgent = new Map();
  ordered.forEach((row, i) => {
    const key = `${row.run_id ?? ""}\u0000${row.agent_key ?? ""}`;
    const list = positionsByRunAgent.get(key);
    if (list) list.push(i);
    else positionsByRunAgent.set(key, [i]);
  });

  const groups = new Map();
  for (const row of ordered) {
    // Identity first: the full-input digest. The preview fallback exists only
    // for rows that carry no identity (pre-FOC-220, unrepaired) — a truncated
    // preview never poses as an identity when the real one exists.
    const argKey = row.tool_input_id ?? `preview:${normaliseArgs(row.tool_input)}`;
    const key = JSON.stringify([row.run_id, row.agent_key, row.tool_name_canon, argKey]);
    const existing = groups.get(key);
    if (existing) existing.push(row);
    else groups.set(key, [row]);
  }

  const dims = { byModel: new Map(), bySquad: new Map(), byTool: new Map(), byRun: new Map(), byAgent: new Map() };
  const totals = { calls: 0, repeats: 0, repeatCategories: emptyCategories(), errors: 0, outcomeUnknown: 0 };
  const details = [];

  const entryFor = (map, key) => {
    if (key == null || key === "") return null;
    let entry = map.get(key);
    if (!entry) {
      entry = { calls: 0, repeats: 0, repeatCategories: emptyCategories(), errors: 0, outcomeUnknown: 0, label: key };
      map.set(key, entry);
    }
    return entry;
  };

  for (const members of groups.values()) {
    members.forEach((row, index) => {
      totals.calls++;
      const isRepeat = index > 0;
      let category = null;
      let evidence = null;
      if (isRepeat) {
        ({ category, evidence } = classifyOccurrence({ members, index, ordered, posOf, positionsByRunAgent }));
        totals.repeats++;
        totals.repeatCategories[category]++;
      }
      const rowUnknown = outcomeUnknown(row);
      if (row.tool_has_error) totals.errors++;
      if (rowUnknown) totals.outcomeUnknown++;

      for (const [map, key] of [
        [dims.byModel, row.model], [dims.bySquad, row.squad], [dims.byTool, row.tool_name_canon],
        [dims.byRun, row.run_id], [dims.byAgent, row.agent_key],
      ]) {
        const entry = entryFor(map, key);
        if (!entry) continue;
        entry.calls++;
        if (isRepeat) { entry.repeats++; entry.repeatCategories[category]++; }
        if (row.tool_has_error) entry.errors++;
        if (rowUnknown) entry.outcomeUnknown++;
      }

      // Inspectable evidence (FOC-220 AC4), in the stable total order.
      const base = {
        tool_fact_id: row.tool_fact_id ?? null,
        run_id: row.run_id ?? null,
        agent_key: row.agent_key ?? null,
        tool_name_canon: row.tool_name_canon ?? null,
        model: row.model ?? null,
        observed_at: row.observed_at ?? null,
        source_path: row.source_path ?? null,
        source_offset: row.source_offset ?? null,
        tool_index: row.tool_index ?? null,
      };
      if (isRepeat) details.push({ kind: "repeat", category, evidence, ...base });
      if (row.tool_has_error) {
        details.push({ kind: "error", category: "error", evidence: { outcome: row.tool_result_state ?? "flagged" }, ...base });
      }
    });
  }

  details.sort(byOrderKey);
  return { totals, details, ...dims };
}

// ---------------------------------------------------------------------------
// CLI — skipped on import so the module can be unit-tested.
// ---------------------------------------------------------------------------

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  if (args.includes("--help")) {
    console.log(`Usage: node scripts/agent-behavior.mjs [--by model|squad|tool|run|agent] [--min N] [--json] [--detail]

  --by     Restrict output to one breakdown (default: all).
  --min    Minimum tool calls for a group to be listed.
  --json   Machine-readable output.
  --detail Include the ordered repeat/error details with evidence (JSON key
           "details"; in text mode the first 20 lines).`);
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
  // A view created before FOC-220 lacks the identity/outcome columns; grouping
  // on the full-input identity is the point of this report, so fail with the
  // fix instead of silently degrading to the truncated preview.
  const toolCols = new Set(db.prepare("PRAGMA table_info(canonical_tool_facts)").all().map((c) => c.name));
  for (const needed of ["tool_input_id", "tool_result_state", "tool_result_id"]) {
    if (!toolCols.has(needed)) {
      console.error(`View canonical_tool_facts is stale (missing ${needed}). Run: node scripts/telemetry-canonical.mjs --ensure`);
      process.exit(1);
    }
  }

  const rows = db.prepare(`SELECT tool_fact_id, run_id, agent_key, squad, model, tool_name_canon,
      tool_input, tool_input_id, tool_index, tool_has_error, tool_result_state, tool_result_id,
      observed_at, source_path, source_offset
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
  // Rank on provable waste: repeats whose args AND result were byte-identical
  // with nothing in between. A bare repeat count is no longer a verdict.
  const unchangedOf = (entry) => entry.repeatCategories.unchanged;
  const rank = (map, min) => [...map.values()]
    .filter((v) => v.calls >= (min ?? 0))
    .sort((a, b) => pct(unchangedOf(b), b.calls) - pct(unchangedOf(a), a.calls));

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
    if (DETAIL) out.details = result.details;
    console.log(JSON.stringify(out, null, 2));
  } else {
    const t = result.totals;
    const catSummary = REPEAT_CATEGORIES.map((c) => `${c} ${t.repeatCategories[c]}`).join(", ");
    console.log(`tool calls ${t.calls}  |  repeats past first ${t.repeats} (${pct(t.repeats, t.calls).toFixed(1)}%) — ${catSummary}`);
    console.log(`errors ${t.errors} (${pct(t.errors, t.calls).toFixed(1)}%)  |  outcome unknown ${t.outcomeUnknown} (${pct(t.outcomeUnknown, t.calls).toFixed(1)}%) — missing result is not ok`);
    console.log(`delegation: subagents hold ${(100 * delegationShare).toFixed(1)}% of cost ($${sub.usd} of $${(lead.usd + sub.usd).toFixed(2)}) — squad playbooks require >=40%`);

    for (const dim of Object.keys(TITLES)) {
      if (BY && `by${BY[0].toUpperCase()}${BY.slice(1)}` !== dim) continue;
      const listed = rank(result[dim], MIN ?? DEFAULT_MIN[dim]).slice(0, 12);
      if (!listed.length) continue;
      console.log(`\n${TITLES[dim]}  (unchanged% / error% / calls)`);
      for (const r of listed) {
        console.log(`  ${pct(unchangedOf(r), r.calls).toFixed(1).padStart(5)}%  ${pct(r.errors, r.calls).toFixed(1).padStart(5)}%  ${String(r.calls).padStart(6)}  ${r.label}`);
      }
    }

    if (DETAIL) {
      console.log(`\nrepeats & errors in stable fact order (first 20 of ${result.details.length}):`);
      for (const d of result.details.slice(0, 20)) {
        console.log(`  [${d.category}] ${d.tool_fact_id ?? "?"} @${d.source_path ?? "?"}:${d.source_offset ?? "?"} ${d.tool_name_canon ?? "?"} ${d.run_id ?? "?"}/${d.agent_key ?? "?"} ${JSON.stringify(d.evidence)}`);
      }
    }
  }

  db.close();
}
