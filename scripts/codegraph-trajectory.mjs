#!/usr/bin/env node
// scripts/codegraph-trajectory.mjs — CodeGraph query-trajectory capture (FOC-624,
// collection half only; the eval set and harness are FOC-627).
//
// WHY THIS EXISTS. Mateusz is fine-tuning a model for using CodeGraph. That needs
// a corpus of real query trajectories BEFORE any training, so capture has to start
// early and accumulate. Two things were genuinely missing from `tool_facts`:
// freshness at query time, and which returned symbols/files were later used.
//
// WHAT IS ALREADY CAPTURED (do not duplicate). `tool_facts` holds the sequence and
// most of the tuple: `tool_name_raw`/`tool_name_canon` (tool), `tool_input` (arguments,
// a 1000-char preview — `tool_input_full` feeds only the identity digest),
// `tool_result_bytes` (result size), `tool_result_id` (salted digest), and
// `tool_index`/`turn_index`/`source_offset` (order).
//
// PRIVACY (FOC-220). The tool result TEXT is never persisted — only a salted digest
// and a byte count. So "which symbols/files did this query return" cannot be derived
// retroactively from anything on disk today; it must be read while the result text is
// in hand. What this module stores is therefore NEW content, kept minimal and
// deliberate: IDENTIFIERS ONLY (file paths and symbol names). No source text, no
// prose, no result excerpts, ever.
//
// TWO PASSES, because "later used" is future information:
//   1. CAPTURE  — deriveCodegraphCapture() runs while the result text is in hand and
//      stores freshness + the returned identifiers. Wired from telemetry-ingest.
//   2. ATTRIBUTE — attributeUse() back-fills which identifiers a later tool call or
//      the turn's own prose named, and the 3-way outcome FOC-627 grades. It is an
//      UPDATE, idempotent, and safe to re-run as a transcript grows.
//
// NEVER FABRICATE. Every derivation degrades to `unknown` rather than guessing, in the
// idiom of agent-behavior.mjs classifyOccurrence().
//
// Usage:
//   node scripts/codegraph-trajectory.mjs list  [--run <id>] [--agent <key>] [--json]
//   node scripts/codegraph-trajectory.mjs stats [--run <id>]
//   node scripts/codegraph-trajectory.mjs attribute [--run <id>]   (back-fill pass)

import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Which tool calls this covers
// ---------------------------------------------------------------------------

/** The eight CodeGraph MCP tools FOC-620 put in the subagent allowlists. */
export const CODEGRAPH_TOOL_PREFIX = "mcp__codegraph__codegraph_";

export function isCodegraphTool(toolNameRaw, toolNameCanon) {
  if (typeof toolNameRaw === "string" && toolNameRaw.startsWith(CODEGRAPH_TOOL_PREFIX)) return true;
  // `code_intel` is the canonical name tool-norm.json maps the MCP tools onto.
  return toolNameCanon === "code_intel";
}

// ---------------------------------------------------------------------------
// Derivation 1 — freshness and returned identifiers (capture-time)
// ---------------------------------------------------------------------------

// Freshness follows the repo's own vocabulary (CLAUDE.md "Freshness and fallback"):
// the MCP server checks target identity and index staleness before every query, so a
// recognised successful answer is FRESH unless it carries a staleness banner. A
// missing/stale/unprovable index is UNKNOWN and the caller is told to fall back to
// reading files. A `⚠️` banner is never ignored — it is STALE.
const RE_STALE_BANNER = /⚠️|staleness banner|index is stale|pending (index )?(sync|changes)/i;
const RE_FRESHNESS_UNPROVEN = /freshness cannot be (proven|established)|\bno index\b|index (is )?missing|not indexed|unknown: fall back/i;
// Shapes of a real CodeGraph answer. Absence means the response was not one.
const RE_ANSWER_SHAPE = /^\*\*Exploration:/m;
const RE_FOUND_COUNT = /^Found (\d+) symbols? across (\d+) files?/m;
const RE_FILE_HEADER = /^\*\*`([^`\n]+)`\*\*/gm;
// `file:line` inside a code-span, e.g. (`scripts/telemetry-ingest.mjs:391`)
const RE_FILE_LINE_REF = /`([A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+:\d+)`/g;
// Blast-radius bullets: - `symbolName` (file:line) — ...
const RE_SYMBOL_BULLET = /^-\s+`([A-Za-z_$][\w$]*)`\s+\(/gm;

const unique = (items) => [...new Set(items.filter(Boolean))];

/**
 * Best-effort read of a CodeGraph result while its text is still in hand.
 * Best-effort by construction: the rendering is not a stable API, so a shape this
 * parser does not recognise yields empty identifier lists and `freshness: unknown`
 * — never a guess.
 *
 * @param {{resultText?: string}} input
 * @returns {{freshness: 'fresh'|'stale'|'unknown', graphAnswered: boolean,
 *            returnsFiles: string[], returnsSymbols: string[],
 *            reason: string}}
 */
export function deriveCodegraphCapture({ resultText } = {}) {
  const text = typeof resultText === "string" ? resultText : "";
  if (!text) {
    return { freshness: "unknown", graphAnswered: false, returnsFiles: [], returnsSymbols: [], reason: "no result text" };
  }

  // --- freshness ---
  let freshness = "unknown";
  let reason = "no freshness evidence in the result";
  if (RE_STALE_BANNER.test(text)) {
    freshness = "stale";
    reason = "staleness banner present";
  } else if (RE_FRESHNESS_UNPROVEN.test(text)) {
    freshness = "unknown";
    reason = "result reports an unproven or missing index";
  } else if (RE_ANSWER_SHAPE.test(text) || RE_FOUND_COUNT.test(text)) {
    // The MCP server enforces the freshness guard before answering, so a recognised
    // successful answer is the only thing that may claim `fresh`.
    freshness = "fresh";
    reason = "recognised answer shape with no staleness marker";
  }

  // --- returned identifiers (identifiers only, never the text) ---
  const files = [];
  for (const m of text.matchAll(RE_FILE_HEADER)) files.push(m[1]);
  for (const m of text.matchAll(RE_FILE_LINE_REF)) files.push(m[1].replace(/:\d+$/, ""));
  const symbols = [];
  for (const m of text.matchAll(RE_SYMBOL_BULLET)) symbols.push(m[1]);

  const returnsFiles = unique(files.map(normaliseIdentPath));
  const returnsSymbols = unique(symbols);

  // The graph "answered" when the response is a recognised CodeGraph answer whose
  // freshness is established and which carried usable content. `Found 0 symbols` and
  // a render this parser does not recognise both count as NOT answered: there was no
  // content the agent could have used, so `fallback`/`unknown` is the honest outcome.
  // `foundCount > 0` is accepted as content even when the identifier regexes matched
  // nothing — the render changed, the answer did not.
  const found = RE_FOUND_COUNT.exec(text);
  const foundCount = found ? Number(found[1]) : null;
  const shapeRecognised = RE_ANSWER_SHAPE.test(text) || foundCount != null;
  const hasReturns = returnsFiles.length > 0 || returnsSymbols.length > 0;
  const graphAnswered = Boolean(shapeRecognised && freshness !== "unknown" && (hasReturns || foundCount > 0));

  return { freshness, graphAnswered, returnsFiles, returnsSymbols, reason };
}

function normaliseIdentPath(p) {
  return String(p).replace(/\\/g, "/").replace(/^\.\//, "");
}

// ---------------------------------------------------------------------------
// The capture record
// ---------------------------------------------------------------------------

/**
 * Same identity as recordToolFact: sha1(source_path:source_offset:tool_index). This
 * module deliberately does NOT call recordToolFact (whose blast radius is 11 callers
 * across 4 test files) — it keys its own table on the same id so the two join.
 */
export function toolFactIdOf(record) {
  return createHash("sha1")
    .update(`${record.source_path}:${record.source_offset}:${record.tool_index}`)
    .digest("hex");
}

/**
 * Build the capture row for one tool fact, or null when this is not a CodeGraph call
 * or there is no result text to derive from.
 *
 * Two distinct "no text" cases, and deliberately NEITHER is captured:
 *   - a pending use — the result has not arrived yet. Capture runs again from
 *     resolvePendingToolFacts the moment it does;
 *   - a use finalized as `missing` — the transcript stopped growing with no result,
 *     i.e. the record is INCOMPLETE, not evidence that the tool returned nothing.
 *
 * A trajectory is query -> result -> use; with no result there is no freshness to
 * record and nothing to attribute against, so a row here would be assertion without
 * evidence. The call itself is not lost: `tool_facts` already carries it with
 * `tool_result_state = 'missing'`, so the SEQUENCE is reconstructable regardless.
 */
export function captureFromRecord(record, { resultText } = {}) {
  if (!isCodegraphTool(record.tool_name_raw, record.tool_name_canon)) return null;
  const text = resultText != null ? resultText : record.tool_result_full;
  if (typeof text !== "string") return null;
  const derived = deriveCodegraphCapture({ resultText: text });
  return {
    tool_fact_id: toolFactIdOf(record),
    run_id: record.run_id,
    agent_key: record.agent_key,
    turn_index: Number.isInteger(record.turn_index) ? record.turn_index : null,
    tool_name_raw: record.tool_name_raw,
    observed_at: record.observed_at || null,
    source_path: record.source_path,
    source_offset: record.source_offset,
    tool_index: Number.isInteger(record.tool_index) ? record.tool_index : null,
    freshness: derived.freshness,
    graph_answered: derived.graphAnswered ? 1 : 0,
    returns_files: JSON.stringify(derived.returnsFiles),
    returns_symbols: JSON.stringify(derived.returnsSymbols),
  };
}

const CAPTURE_COLUMNS = [
  "tool_fact_id", "run_id", "agent_key", "turn_index", "tool_name_raw", "observed_at",
  "source_path", "source_offset", "tool_index", "freshness", "graph_answered",
  "returns_files", "returns_symbols",
];

/**
 * INSERT OR REPLACE the capture row. REPLACE on purpose: a second pass sees more of a
 * growing transcript and may derive better returns. The ATTRIBUTION columns are
 * preserved rather than reset, so a re-capture never erases a completed attribution;
 * `created_at` is likewise kept from the first capture.
 */
export function recordCodegraphCapture(db, row) {
  const allColumns = [...CAPTURE_COLUMNS, "created_at"];
  const sets = CAPTURE_COLUMNS.map((c) => `  ${c} = excluded.${c}`).join(",\n");
  const sql = `
    INSERT INTO codegraph_query_facts (${allColumns.join(", ")})
    VALUES (${allColumns.map(() => "?").join(", ")})
    ON CONFLICT(tool_fact_id) DO UPDATE SET
${sets},
      created_at   = codegraph_query_facts.created_at,
      used_files   = codegraph_query_facts.used_files,
      used_symbols = codegraph_query_facts.used_symbols,
      outcome      = codegraph_query_facts.outcome
  `;
  return db.prepare(sql).run(...CAPTURE_COLUMNS.map((c) => row[c] ?? null), row.created_at || new Date().toISOString());
}

// ---------------------------------------------------------------------------
// Derivation 2 — which returned identifiers were later used (attribution-time)
// ---------------------------------------------------------------------------

// The three outcomes FOC-627's harness grades. A fourth value, `unknown`, exists so
// the classification never fabricates — the same contract as agent-behavior.mjs.
export const OUTCOMES = ["answered", "fallback", "unused", "unknown"];

// "Read, edited" is evidenced by a later tool call whose ARGUMENTS name the
// identifier. "Cited in a verdict or plan" is evidenced by the turn's own prose after
// the query — read from the transcript at source_offset, since FOC-220 keeps prose out
// of the store. Identifiers are matched as normalised substrings: cheap, and it can
// only under-report, never invent a use.
const PROSE_SCAN_BYTES = 1 << 18; // 256 KB past the query — same order as a chunk

// A file read/edited/grepped after the query is what "fell back to reading files"
// means. Both canonical snake_case names (config/tool-norm.json) and raw tool names
// are accepted — a fact row may carry either or both.
const FILE_TOOLS = new Set([
  "read_file", "edit_file", "write_file", "grep", "glob",
  "Read", "Edit", "Write", "Grep", "Glob", "NotebookEdit",
]);

function inputBlob(row) {
  const raw = row.tool_input_full != null ? row.tool_input_full : row.tool_input;
  return typeof raw === "string" ? raw : "";
}

/**
 * Attribute ONE query against (a) the tool facts that follow it in the same
 * run+agent and (b) the transcript prose after it. Mutates and returns the row.
 */
export function attributeOne(row, { laterRows = [], proseAfter = "" } = {}) {
  const returnsFiles = parseJsonArray(row.returns_files);
  const returnsSymbols = parseJsonArray(row.returns_symbols);
  const haystacks = laterRows.map(inputBlob);

  const hitInTools = (id) => haystacks.some((h) => h.includes(id));
  const hitInProse = (id) => proseAfter.includes(id);

  // WIDEN-ONLY. The pass re-runs as a transcript grows, and a later run can see a
  // narrower window than an earlier one (a truncated tool_input preview, a shorter
  // prose slice, a source that went unreadable). A use once seen is therefore unioned
  // in, never recomputed away: what the corpus needs is what WAS used, not a fresh
  // proof of it.
  const usedFiles = unique([
    ...parseJsonArray(row.used_files),
    ...returnsFiles.filter((id) => hitInTools(id) || hitInProse(id)),
  ]);
  const usedSymbols = unique([
    ...parseJsonArray(row.used_symbols),
    ...returnsSymbols.filter((id) => hitInTools(id) || hitInProse(id)),
  ]);
  const usedCount = usedFiles.length + usedSymbols.length;

  const laterFileReads = laterRows.filter((r) => FILE_TOOLS.has(r.tool_name_canon) || FILE_TOOLS.has(r.tool_name_raw)).length;

  // The three outcomes FOC-627 grades, plus `unknown` so the classification never
  // fabricates. Precedence is deliberate:
  //   fallback  — the graph produced no usable answer and the agent went to the files.
  //   answered  — something later named a returned identifier. Evidence of use wins
  //               outright: it is the one thing here that cannot be a coincidence.
  //   unused    — the agent kept working past the query and never named anything the
  //               result contained. "Result was returned but not used."
  //   unknown   — nothing at all follows the query. The turn may simply have ended
  //               there, so "not used" would be a claim without evidence.
  let outcome = "unknown";
  if (usedCount > 0) outcome = "answered";
  else if (!row.graph_answered && laterFileReads > 0) outcome = "fallback";
  else if (laterRows.length > 0) outcome = "unused";
  // `answered` is sticky for the same reason the used sets widen: the evidence was
  // seen once, and a later pass seeing less must not un-see it.
  if (row.outcome === "answered" && outcome !== "answered") outcome = "answered";

  row.used_files = JSON.stringify(usedFiles);
  row.used_symbols = JSON.stringify(usedSymbols);
  row.outcome = outcome;
  return row;
}

// Exported for the FOC-627 eval harness (the only consumer outside this file);
// semantics unchanged.
export function parseJsonArray(value) {
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Back-fill the used identifiers and the outcome for every captured query of one
 * transcript. Idempotent and
 * non-destructive: re-running over a grown transcript can only widen `used` and move
 * `unused`/`unknown` towards `answered`. It never narrows a use it once saw.
 *
 * Reads the transcript prose once per call (capped) and the later tool facts from the
 * caller-supplied rows, so tests can drive it with no database at all.
 */
export function attributeQueries({ queries = [], toolRows = [], proseByOffset = new Map() } = {}) {
  for (const row of queries) {
    const later = toolRows
      .filter((r) =>
        r.run_id === row.run_id &&
        r.agent_key === row.agent_key &&
        orderAfter(r, row))
      .sort((a, b) => (a.tool_index ?? -1) - (b.tool_index ?? -1));
    attributeOne(row, { laterRows: later, proseAfter: proseByOffset.get(row.tool_fact_id) || "" });
  }
  return queries;
}

function orderAfter(r, row) {
  if (r.source_offset !== row.source_offset) return (r.source_offset ?? -1) > (row.source_offset ?? -1);
  return (r.tool_index ?? -1) > (row.tool_index ?? -1);
}

/**
 * The ASSISTANT prose in a transcript window — text blocks of `type:"assistant"`
 * lines, nothing else.
 *
 * Tool results live in `type:"user"` lines and MUST stay out of this: a query's own
 * result necessarily names its own returned identifiers, so scanning it as prose
 * would label every return "used" by its own answer. That self-fulfilling label is
 * exactly what FOC-627 must never be trained on. A line the window cut in half fails
 * to parse and is dropped — under-report, never invent.
 */
function assistantProseFromWindow(windowText) {
  const out = [];
  for (const line of windowText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (obj?.type !== "assistant") continue;
    const content = obj?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && block.type === "text" && typeof block.text === "string") out.push(block.text);
    }
  }
  return out.join("\n");
}

/**
 * Read the assistant prose that follows each query's offset, once per source file.
 * Identifiers are matched as substrings, so this is a presence check, not a parse —
 * and it can only under-report.
 *
 * Reads a BOUNDED WINDOW at each offset, never the whole file: transcripts run to
 * tens of MB and this runs on every ingest pass. A source that cannot be opened
 * yields no entry at all — attribution degrades to `unknown`, never to a guess.
 */
export async function loadProseAfter(queries, { maxBytes = PROSE_SCAN_BYTES } = {}) {
  const bySource = new Map();
  for (const q of queries) {
    const list = bySource.get(q.source_path) || [];
    list.push(q);
    bySource.set(q.source_path, list);
  }
  const proseByOffset = new Map();
  for (const [path, list] of bySource) {
    let handle;
    try {
      handle = await open(path, "r");
    } catch {
      continue; // transcript gone or unreadable: attribution stays `unknown`, never guessed
    }
    try {
      const buf = Buffer.alloc(maxBytes);
      for (const q of list) {
        const start = Number.isInteger(q.source_offset) && q.source_offset > 0 ? q.source_offset : 0;
        let text = "";
        try {
          const { bytesRead } = await handle.read(buf, 0, maxBytes, start);
          text = assistantProseFromWindow(buf.subarray(0, bytesRead).toString("utf8"));
        } catch {
          text = "";
        }
        proseByOffset.set(q.tool_fact_id, text);
      }
    } finally {
      await handle.close();
    }
  }
  return proseByOffset;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const verb = argv[0] || "list";
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : null;
  };
  const runFilter = flag("--run");
  const agentFilter = flag("--agent");
  const asJson = argv.includes("--json");

  const { openTelemetryDb } = await import("./telemetry-store.mjs");
  const db = openTelemetryDb();
  try {
    const where = [];
    const params = [];
    if (runFilter) { where.push("run_id = ?"); params.push(runFilter); }
    if (agentFilter) { where.push("agent_key = ?"); params.push(agentFilter); }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";

    if (verb === "attribute") {
      const queries = db.prepare(`SELECT * FROM codegraph_query_facts ${clause}`).all(...params);
      const toolRows = db.prepare(
        `SELECT tool_fact_id, run_id, agent_key, source_offset, tool_index, tool_name_raw, tool_name_canon, tool_input
           FROM tool_facts ${clause}`,
      ).all(...params);
      const proseByOffset = await loadProseAfter(queries);
      attributeQueries({ queries, toolRows, proseByOffset });
      for (const row of queries) {
        db.prepare("UPDATE codegraph_query_facts SET used_files=?, used_symbols=?, outcome=? WHERE tool_fact_id=?")
          .run(row.used_files, row.used_symbols, row.outcome, row.tool_fact_id);
      }
      console.log(`[codegraph-trajectory] attributed ${queries.length} queries`);
      return;
    }

    const rows = db.prepare(`SELECT * FROM codegraph_query_facts ${clause} ORDER BY observed_at, tool_index`).all(...params);
    if (verb === "stats") {
      const byOutcome = {};
      const byFreshness = {};
      for (const r of rows) {
        byOutcome[r.outcome ?? "not attributed"] = (byOutcome[r.outcome ?? "not attributed"] || 0) + 1;
        byFreshness[r.freshness] = (byFreshness[r.freshness] || 0) + 1;
      }
      const out = { queries: rows.length, byOutcome, byFreshness };
      console.log(JSON.stringify(out, null, 2));
      return;
    }

    if (asJson) {
      console.log(JSON.stringify(rows.map(toJsonRow), null, 2));
      return;
    }
    for (const r of rows) {
      const files = parseJsonArray(r.returns_files).length;
      const symbols = parseJsonArray(r.returns_symbols).length;
      const usedF = parseJsonArray(r.used_files).length;
      const usedS = parseJsonArray(r.used_symbols).length;
      console.log(
        `${r.observed_at ?? "-"}  ${String(r.agent_key).padEnd(26)} ${String(r.tool_name_raw).replace(CODEGRAPH_TOOL_PREFIX, "cg:").padEnd(22)} ` +
        `fresh=${String(r.freshness).padEnd(7)} answered=${r.graph_answered} ` +
        `returns=${files}f/${symbols}s used=${usedF}f/${usedS}s outcome=${r.outcome ?? "not attributed"}`,
      );
    }
  } finally {
    db.close();
  }
}

function toJsonRow(r) {
  return {
    ...r,
    returns_files: parseJsonArray(r.returns_files),
    returns_symbols: parseJsonArray(r.returns_symbols),
    used_files: parseJsonArray(r.used_files),
    used_symbols: parseJsonArray(r.used_symbols),
    graph_answered: Boolean(r.graph_answered),
  };
}

if (process.argv[1] && process.argv[1].endsWith("codegraph-trajectory.mjs")) {
  main().catch((error) => { console.error(`[codegraph-trajectory] ${error.message}`); process.exit(1); });
}
