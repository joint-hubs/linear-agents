#!/usr/bin/env node
// scripts/codegraph-eval-harness.mjs — FOC-627 CodeGraph trajectory eval harness.
//
// Takes the frozen eval set (scripts/codegraph-eval-set.json) — real CodeGraph
// queries keyed by the tool_fact_id that recorded them — and for each entry
// replays its recorded trajectory: the tool_facts row, the later tool facts of
// the same run+agent, the tool result and assistant prose read from the
// transcript at the recorded source_offset. Outcomes come from the ONE
// implementation of the attribution vocabulary (codegraph-trajectory.mjs
// attributeQueries) — never a forked copy. The report is the machine-readable
// contract FOC-621 consumes; docs/tools/codegraph-eval-harness.md documents it
// field by field.
//
// READ-ONLY against the live telemetry DB. openTelemetryDb() migrates (writes),
// so this script opens node:sqlite DatabaseSync with readOnly:true directly; if
// a WAL-mode file refuses a read-only open (missing/unreadable -shm/-wal), it
// falls back to a TEMP COPY — the live DB file is never opened read-write here
// and nothing is written to it. Tests never touch the live DB at all: they set
// LA_TELEMETRY_DB to a fixture store.
//
// DETERMINISTIC (no wall clock, no iteration-order dependence): two runs over
// an unchanged tree and unchanged transcripts produce a byte-identical report.
//
// Usage:
//   node scripts/codegraph-eval-harness.mjs [--eval <path>] [--out <path>] [--db <path>] [--json]
//
// Exit codes: 0 = report produced; 2 = eval-set provenance violations (listed
// on stderr) or harness misuse; 3 = the telemetry DB could not be opened
// read-only and the temp-copy fallback failed.

import { closeSync, copyFileSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_EVAL = join(__dirname, "codegraph-eval-set.json");

import {
  attributeQueries,
  captureFromRecord,
  loadProseAfter,
  OUTCOMES,
  CODEGRAPH_TOOL_PREFIX,
  parseJsonArray,
} from "./codegraph-trajectory.mjs";
import { telemetryDbPath } from "./telemetry-store.mjs";

let DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}

// Same order as PROSE_SCAN_BYTES — a chunk-sized window past the query offset,
// enough to hold the query's own tool_use line, its tool_result and the
// turn's first follow-up actions.
const RESULT_WINDOW_BYTES = 1 << 18;

// ---------------------------------------------------------------------------
// Window parsing — the query's own result and the issuing turn's usage
// ---------------------------------------------------------------------------

/**
 * Parse one transcript window that STARTS at the query's source_offset (the
 * recorded offset of the assistant line holding the tool_use — telemetry-tool-
 * extract.mjs records byte-accurate line starts). Returns the tool result paired
 * to that tool_use by id, and the issuing assistant turn's usage block if the
 * transcript records one.
 *
 * Privacy: the result text stays in memory and feeds only the identifier
 * derivation (deriveCodegraphCapture via captureFromRecord). It is never printed
 * or written by the harness.
 *
 * A window whose first line is not the query's assistant line (offset shape
 * drift) degrades to null/null — attribution then runs on an empty capture and
 * the outcome degrades honestly, never fabricated.
 */
export function pairQueryWindow(windowText) {
  let resultText = null;
  let issuingTurnUsage = null;
  let ownToolUseId = null;
  const resultsById = new Map();
  for (const line of windowText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue; // a line cut in half by the window fails to parse and is dropped
    }
    const content = obj?.message?.content;
    if (!Array.isArray(content)) continue;
    if (obj.type === "assistant") {
      if (ownToolUseId === null) {
        for (const block of content) {
          if (block?.type === "tool_use" && block.id) {
            ownToolUseId = block.id;
            const u = obj.message?.usage;
            issuingTurnUsage = u && typeof u === "object" ? {
              inputTokens: u.input_tokens ?? null,
              outputTokens: u.output_tokens ?? null,
              cacheReadInputTokens: u.cache_read_input_tokens ?? null,
              cacheCreationInputTokens: u.cache_creation_input_tokens ?? null,
            } : null;
            break;
          }
        }
      }
    } else if (obj.type === "user" && ownToolUseId !== null) {
      for (const block of content) {
        if (block?.type === "tool_result" && block.tool_use_id) resultsById.set(block.tool_use_id, block);
      }
    }
  }
  const own = ownToolUseId !== null ? resultsById.get(ownToolUseId) : null;
  if (own) {
    resultText = typeof own.content === "string"
      ? own.content
      : Array.isArray(own.content) ? own.content.map((b) => b?.text ?? "").join("\n") : null;
  }
  return { resultText, issuingTurnUsage };
}

// ---------------------------------------------------------------------------
// Eval-set validation (AC1 — provenance)
// ---------------------------------------------------------------------------

const RE_TOOL_FACT_ID = /^[0-9a-f]{40}$/;
const GRADING_KINDS = new Set(["reference", "rubric"]);

/**
 * Structural validation of the eval set — everything checkable WITHOUT the DB.
 * Returns a list of violations; empty means valid.
 */
export function validateEvalSet(evalSet) {
  const violations = [];
  const entries = Array.isArray(evalSet?.entries) ? evalSet.entries : null;
  if (!entries) {
    violations.push("eval set has no entries array");
    return violations;
  }
  const seenIds = new Map();
  for (const entry of entries) {
    const where = `entry "${entry?.id ?? "<missing id>"}"`;
    if (typeof entry?.id !== "string" || !entry.id) violations.push(`${where}: missing id`);
    if (typeof entry?.tool_fact_id !== "string" || !RE_TOOL_FACT_ID.test(entry.tool_fact_id)) {
      violations.push(`${where}: tool_fact_id is not well-formed 40-hex — "${entry?.tool_fact_id ?? ""}"`);
    } else if (seenIds.has(entry.tool_fact_id)) {
      violations.push(`${where}: tool_fact_id duplicates entry "${seenIds.get(entry.tool_fact_id)}"`);
    } else {
      seenIds.set(entry.tool_fact_id, entry.id ?? "<missing id>");
    }
    if (typeof entry?.tool !== "string" || !entry.tool) violations.push(`${where}: missing tool`);
    if (typeof entry?.run_id !== "string" || !entry.run_id) violations.push(`${where}: missing run_id`);
    if (typeof entry?.agent_key !== "string" || !entry.agent_key) violations.push(`${where}: missing agent_key`);
    if (typeof entry?.args !== "object" || entry?.args === null) violations.push(`${where}: missing args object`);
    const grading = entry?.grading;
    if (!grading || !GRADING_KINDS.has(grading.kind)) {
      violations.push(`${where}: grading.kind must be "reference" or "rubric"`);
    } else if (!Array.isArray(grading.mustName) || grading.mustName.length === 0
        || !grading.mustName.every((m) => typeof m === "string" && m.length > 0)) {
      violations.push(`${where}: grading.mustName must be a non-empty array of identifier strings`);
    }
  }
  return violations;
}

/**
 * Provenance against the DB: every tool_fact_id must exist in tool_facts, and
 * the row it names must agree with the entry's recorded run_id/agent_key/tool.
 */
export function validateProvenance(entries, db) {
  const violations = [];
  const existing = new Set(db.prepare("SELECT tool_fact_id FROM tool_facts").all().map((r) => r.tool_fact_id));
  for (const entry of entries) {
    const where = `entry "${entry.id}"`;
    if (!RE_TOOL_FACT_ID.test(entry.tool_fact_id)) continue; // already reported structurally
    if (!existing.has(entry.tool_fact_id)) {
      violations.push(`${where}: tool_fact_id ${entry.tool_fact_id} does not exist in tool_facts`);
      continue;
    }
    const row = db.prepare(
      "SELECT run_id, agent_key, tool_name_raw, tool_name_canon FROM tool_facts WHERE tool_fact_id = ?",
    ).get(entry.tool_fact_id);
    if (row.run_id !== entry.run_id || row.agent_key !== entry.agent_key) {
      violations.push(`${where}: recorded run_id/agent_key (${entry.run_id}/${entry.agent_key}) does not match tool_facts (${row.run_id}/${row.agent_key})`);
    }
    const tool = row.tool_name_raw.startsWith(CODEGRAPH_TOOL_PREFIX)
      ? row.tool_name_raw.slice(CODEGRAPH_TOOL_PREFIX.length)
      : row.tool_name_raw;
    if (tool !== entry.tool) {
      violations.push(`${where}: recorded tool "${entry.tool}" does not match tool_facts ("${tool}")`);
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Trajectory replay — one entry at a time, through the ONE attribution pass
// ---------------------------------------------------------------------------

const LATER_COLUMNS = "tool_fact_id, run_id, agent_key, source_offset, tool_index, tool_name_raw, tool_name_canon, tool_input";

function shortTool(raw) {
  return raw.startsWith(CODEGRAPH_TOOL_PREFIX) ? raw.slice(CODEGRAPH_TOOL_PREFIX.length) : raw;
}

function readWindow(sourcePath, offset, maxBytes = RESULT_WINDOW_BYTES) {
  let handle;
  try {
    handle = openSync(sourcePath, "r");
  } catch {
    return ""; // transcript gone or unreadable: degrade to empty, never guess
  }
  try {
    const buf = Buffer.alloc(maxBytes);
    const start = Number.isInteger(offset) && offset > 0 ? offset : 0;
    const { bytesRead } = readSync(handle, buf, 0, maxBytes, start);
    return buf.subarray(0, bytesRead).toString("utf8");
  } catch {
    return "";
  } finally {
    closeSync(handle);
  }
}

/**
 * Replay one entry's recorded trajectory and produce its report row. Uses
 * captureFromRecord + attributeQueries + loadProseAfter from
 * codegraph-trajectory.mjs — the same implementation the ingest wiring uses —
 * so the outcome classes cannot drift between collection and eval.
 */
export async function replayEntry(entry, db, laterRowsCache) {
  const row = db.prepare("SELECT * FROM tool_facts WHERE tool_fact_id = ?").get(entry.tool_fact_id);
  const cacheKey = `${row.run_id}\u0000${row.agent_key}`;
  let toolRows = laterRowsCache.get(cacheKey);
  if (!toolRows) {
    toolRows = db.prepare(
      `SELECT ${LATER_COLUMNS} FROM tool_facts WHERE run_id = ? AND agent_key = ? ORDER BY source_offset, tool_index`,
    ).all(row.run_id, row.agent_key);
    laterRowsCache.set(cacheKey, toolRows);
  }

  const { resultText, issuingTurnUsage } = pairQueryWindow(readWindow(row.source_path, row.source_offset));

  // captureFromRecord derives freshness + returned identifiers from the result
  // text. A missing/unreadable result yields null — fall back to an unknown
  // capture so attribution still runs and the outcome degrades honestly.
  const captured = captureFromRecord(row, { resultText });
  const queryRow = captured
    ? { ...captured, tool_fact_id: entry.tool_fact_id }
    : {
      tool_fact_id: entry.tool_fact_id, run_id: row.run_id, agent_key: row.agent_key,
      freshness: "unknown", graph_answered: 0, returns_files: "[]", returns_symbols: "[]",
    };

  const proseByOffset = await loadProseAfter([queryRow]);
  attributeQueries({ queries: [queryRow], toolRows, proseByOffset });

  const returnsFiles = parseJsonArray(queryRow.returns_files);
  const returnsSymbols = parseJsonArray(queryRow.returns_symbols);
  const usedFiles = parseJsonArray(queryRow.used_files);
  const usedSymbols = parseJsonArray(queryRow.used_symbols);

  return {
    id: entry.id,
    toolFactId: entry.tool_fact_id,
    tool: entry.tool,
    runId: entry.run_id,
    agentKey: entry.agent_key,
    args: entry.args,
    grading: { kind: entry.grading.kind, mustName: entry.grading.mustName },
    outcome: queryRow.outcome,
    freshness: queryRow.freshness,
    graphAnswered: Boolean(queryRow.graph_answered),
    returnedIdentifiers: { files: returnsFiles, symbols: returnsSymbols },
    usedIdentifiers: { files: usedFiles, symbols: usedSymbols },
    returnedCount: returnsFiles.length + returnsSymbols.length,
    usedCount: usedFiles.length + usedSymbols.length,
    trajectoryToolCalls: 1 + toolRows.filter((r) =>
      r.run_id === row.run_id && r.agent_key === row.agent_key && orderAfterRow(r, row)).length,
    issuingTurnUsage,
  };
}

function orderAfterRow(r, row) {
  if (r.source_offset !== row.source_offset) return (r.source_offset ?? -1) > (row.source_offset ?? -1);
  return (r.tool_index ?? -1) > (row.tool_index ?? -1);
}

// ---------------------------------------------------------------------------
// Report assembly
// ---------------------------------------------------------------------------

function tallyOutcomes(rows) {
  const byOutcome = {};
  for (const o of OUTCOMES) byOutcome[o] = 0;
  for (const r of rows) byOutcome[r.outcome] = (byOutcome[r.outcome] || 0) + 1;
  return byOutcome;
}

export function buildReport(evalSet, evalPath, queries) {
  const byTool = {};
  for (const q of queries) {
    const t = byTool[q.tool] || (byTool[q.tool] = { count: 0, byOutcome: tallyOutcomes([]) });
    t.count++;
    t.byOutcome[q.outcome] = (t.byOutcome[q.outcome] || 0) + 1;
  }
  return {
    report: "codegraph-eval-harness",
    schemaVersion: 1,
    evalSet: evalPath,
    evalSetDescription: evalSet.evalSet ?? null,
    byOutcome: tallyOutcomes(queries),
    byTool: Object.fromEntries(Object.keys(byTool).sort().map((k) => [k, byTool[k]])),
    tokenUsage: {
      entriesWithIssuingTurnUsage: queries.filter((q) => q.issuingTurnUsage != null).length,
      // Fact, not a metric: the transcripts record message.usage per assistant
      // turn, so the per-query number is the ISSUING TURN's cost (context and
      // all), not attributable to the query alone. No aggregate token number is
      // computed — a sum over issuing turns is not a query cost.
      note: "per-entry issuingTurnUsage is the assistant turn that issued the query, as recorded in the transcript's message.usage block; no aggregate is computed",
    },
    queries,
  };
}

// ---------------------------------------------------------------------------
// DB open — read-only against the live path, temp-copy fallback for WAL
// ---------------------------------------------------------------------------

export function openDbReadOnly(dbPath) {
  try {
    return { db: new DatabaseSync(dbPath, { readOnly: true }), mode: "readonly" };
  } catch (error) {
    // WAL caveat: a WAL-mode db whose -shm/-wal are absent or unreadable can
    // refuse a read-only open. Copy db + sidecars to a temp dir and open the
    // COPY (read-write) — the live DB is still never written.
    const tmp = mkdtempSync(join(tmpdir(), "foc-627-eval-"));
    const name = basename(dbPath);
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(dbPath + suffix)) copyFileSync(dbPath + suffix, join(tmp, name + suffix));
    }
    try {
      return { db: new DatabaseSync(join(tmp, name)), mode: "temp-copy", fallbackReason: error.message };
    } catch (copyError) {
      const err = new Error(`telemetry DB could not be opened read-only (${error.message}) and the temp-copy fallback failed (${copyError.message})`);
      err.code = "DB_OPEN";
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Harness entry point
// ---------------------------------------------------------------------------

export async function runHarness({ evalPath = DEFAULT_EVAL, dbPath, out = null } = {}) {
  const evalSet = JSON.parse(readFileSync(evalPath, "utf8"));

  let violations = validateEvalSet(evalSet);
  if (violations.length === 0) {
    const opened = openDbReadOnly(dbPath ?? telemetryDbPath());
    const db = opened.db;
    try {
      violations = validateProvenance(evalSet.entries, db);
      if (violations.length > 0) {
        const err = new Error(`eval-set provenance violations:\n${violations.map((v) => `  - ${v}`).join("\n")}`);
        err.code = "PROVENANCE";
        err.violations = violations;
        throw err;
      }
      const laterRowsCache = new Map();
      const queries = [];
      for (const entry of evalSet.entries) {
        queries.push(await replayEntry(entry, db, laterRowsCache));
      }
      const report = buildReport(evalSet, evalPath, queries);
      if (out) writeFileSync(out, JSON.stringify(report, null, 2) + "\n", "utf8");
      return { report, dbMode: opened.mode };
    } finally {
      db.close();
    }
  } else {
    const err = new Error(`eval-set validation violations:\n${violations.map((v) => `  - ${v}`).join("\n")}`);
    err.code = "PROVENANCE";
    err.violations = violations;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage(code = 2) {
  console.error(
    [
      "Usage: node scripts/codegraph-eval-harness.mjs [--eval <path>] [--out <path>] [--db <path>] [--json]",
      "",
      "Replays the frozen eval set's recorded CodeGraph trajectories and emits one",
      "deterministic JSON report (FOC-627). Read-only against the telemetry DB.",
    ].join("\n"),
  );
  process.exit(code);
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : null;
  };
  const evalPath = flag("--eval") ?? DEFAULT_EVAL;
  const out = flag("--out");
  const dbPath = flag("--db");
  const asJson = argv.includes("--json");

  const { report, dbMode } = await runHarness({ evalPath, dbPath, out });

  if (asJson) console.log(JSON.stringify(report, null, 2));
  else {
    const byOutcome = report.byOutcome;
    console.log(`[codegraph-eval] eval set: ${evalPath}`);
    console.log(`[codegraph-eval] db: ${dbMode}`);
    console.log(`[codegraph-eval] entries: ${report.queries.length} — byOutcome ${JSON.stringify(byOutcome)}`);
    for (const [tool, t] of Object.entries(report.byTool)) {
      console.log(`[codegraph-eval]   ${tool}: ${t.count} — ${JSON.stringify(t.byOutcome)}`);
    }
    console.log(`[codegraph-eval] token usage: ${report.tokenUsage.entriesWithIssuingTurnUsage}/${report.queries.length} entries carry the issuing turn's recorded usage (no aggregate is computed)`);
    if (out) console.log(`[codegraph-eval] report written: ${out}`);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    if (err.code === "PROVENANCE") {
      console.error(`[codegraph-eval] ${err.message}`);
      process.exit(2);
    }
    if (err.code === "DB_OPEN") {
      console.error(`[codegraph-eval] ${err.message}`);
      process.exit(3);
    }
    console.error(`[codegraph-eval] ${err.message}`);
    process.exit(1);
  });
}