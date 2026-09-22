#!/usr/bin/env node
// scripts/decision-log.mjs — the decision I/O log's outcome labels (FOC-449).
//
//   node scripts/decision-log.mjs label --event <eventId> --outcome <value>
//        --by human|agent [--run <runId>]
//
// decisions.jsonl (one file per LA_RUN_ID under <repo>/.state/runs/) carries
// two line types:
//   · {type:"event", ...} — one per registry-backed decision call, written by
//     decision-call.mjs: identity (eventId), the scrubbed input AS SENT, the
//     typed output, usage/cost facts, taskKey. Legacy lines (pre-FOC-449, no
//     `type`) are decision records without an eventId; they still parse but
//     cannot carry a label.
//   · {type:"label", ...} — one recorded outcome per event: what ACTUALLY
//     happened. Never derived from the event's own answers — the outcome is
//     an argument here (source:"manual"), or the gate/verdict/merge result
//     whose caller passed explicit provenance for the event (source:"auto",
//     via:"gate"|"verdict"|"merge").
//
// The label lands in the run file HOLDING the event: directly when --run is
// given, otherwise by a newest-first scan of .state/runs/*/decisions.jsonl.
// Unknown events are refused — an outcome pointing at nothing is worse than
// none, because the export joins on it. Errors exit non-zero; the auto-join
// callers treat every failure from appendLabel as a warning instead.

import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SHADOW_EVENT_TYPE, SHADOW_FILENAME } from "./decision-call.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dir, "..");
// Same layout decision-call.mjs writes to: one decisions.jsonl per run id.
export const RUNS_DIR = join(ROOT, ".state", "runs");

export const SHADOW_LABEL_TYPE = "label";
export const LABEL_BY = ["human", "agent"];

const defaultNow = () => new Date().toISOString();

/**
 * Build one label record. `by` is who vouches for the outcome, `source` who
 * wrote the line (manual CLI vs supervisor auto-join), `via` which join (auto
 * only). Throws on a missing/bad field — the CLI turns that into exit 1, the
 * auto-joins into a warning.
 */
export function labelRecord({ eventId, outcome, by, source = "manual", via = null, now = defaultNow }) {
  if (typeof eventId !== "string" || !eventId.trim()) throw new Error("--event <eventId> is required");
  if (typeof outcome !== "string" || !outcome.trim()) throw new Error("--outcome <value> is required");
  if (!LABEL_BY.includes(by)) throw new Error(`--by must be one of ${LABEL_BY.join(" | ")}, got "${by}"`);
  return {
    type: SHADOW_LABEL_TYPE,
    eventId,
    outcome,
    by,
    source,
    ...(via ? { via } : {}),
    ts: now(),
  };
}

/** Every run log on disk, newest first (label target lookup order). */
function runLogFiles(runsDir) {
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir)
    .map((runId) => {
      const path = join(runsDir, runId, SHADOW_FILENAME);
      if (!existsSync(path)) return null;
      try {
        return { runId, path, mtimeMs: statSync(path).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs || (a.runId < b.runId ? 1 : -1));
}

/** One parsed JSONL line per non-empty line; unparseable lines are skipped. */
function readJsonl(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function fileHasEvent(path, eventId) {
  return readJsonl(path).some((line) => line?.type === SHADOW_EVENT_TYPE && line?.eventId === eventId);
}

/**
 * The run file holding an event: the given run's log when `runId` is passed,
 * otherwise the newest log containing it. Throws when the event is nowhere —
 * an unknown event must not collect an outcome.
 */
export function findEventFile(eventId, { runId = null, runsDir = RUNS_DIR } = {}) {
  if (runId) {
    const path = join(runsDir, runId, SHADOW_FILENAME);
    if (!existsSync(path)) throw new Error(`no decisions log for run ${runId}: ${path}`);
    if (!fileHasEvent(path, eventId)) throw new Error(`event ${eventId} is not in the log of run ${runId}`);
    return { runId, path };
  }
  const found = runLogFiles(runsDir).find((f) => fileHasEvent(f.path, eventId));
  if (!found) throw new Error(`event ${eventId} not found in any run log under ${runsDir}`);
  return { runId: found.runId, path: found.path };
}

/**
 * Append one label record next to the event it labels. Throws on an unknown
 * event or an unwritable log — callers decide whether that is fatal (CLI) or
 * a warning (auto-joins).
 */
export function appendLabel({ eventId, outcome, by, source = "manual", via = null, runId = null, runsDir = RUNS_DIR, now = defaultNow }) {
  const record = labelRecord({ eventId, outcome, by, source, via, now });
  const found = findEventFile(eventId, { runId, runsDir });
  appendFileSync(found.path, `${JSON.stringify(record)}\n`);
  return { record, path: found.path, runId: found.runId };
}

/**
 * The supervisor auto-join (FOC-449 E3): label every event a gate/verdict/
 * merge carried explicit provenance for. Best-effort by contract — a failed
 * label (unknown event, unwritable log) is a warning, never a broken primary
 * flow. No provenance → nothing labelled, nothing warned.
 */
export function autoLabel(pairs, { outcome, by, via, runsDir = RUNS_DIR } = {}) {
  const labelled = [];
  const warnings = [];
  for (const pair of pairs ?? []) {
    try {
      const { runId } = appendLabel({
        eventId: pair.eventId,
        outcome,
        by,
        source: "auto",
        via,
        runId: pair.runId ?? null,
        runsDir,
      });
      labelled.push({ eventId: pair.eventId, runId });
    } catch (err) {
      warnings.push(`decision label for event ${pair.eventId} was not written: ${err.message}`);
    }
  }
  return { labelled, warnings };
}

/**
 * Pair repeatable --decision-event/--decision-run flags into provenance
 * records. One run covers every event; N runs pair positionally and must
 * match the event count. No events → no provenance.
 */
export function pairDecisionEvents(eventIds, runIds) {
  const events = (eventIds ?? []).map((v) => String(v ?? "").trim()).filter(Boolean);
  const runs = (runIds ?? []).map((v) => String(v ?? "").trim()).filter(Boolean);
  if (!events.length) return [];
  if (runs.length > 1 && runs.length !== events.length) {
    throw new Error(
      `--decision-run given ${runs.length} times for ${events.length} --decision-event value(s) — ` +
        `pass one run for all events, or one per event in the same order`,
    );
  }
  return events.map((eventId, i) => ({ eventId, runId: runs[i] ?? runs[runs.length - 1] ?? null }));
}

// ── CLI ──────────────────────────────────────────────────────────────────────

// Same flag semantics as supervisor-lib.parseArgs (last value wins), without
// importing the supervisor library: this module serves the decision domain and
// is imported by the supervisor scripts, not the other way around.
function parseCli(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      out._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

const requireValue = (v, message) => {
  if (v === undefined || v === true || !String(v).trim()) {
    console.error(message);
    process.exit(1);
  }
  return String(v).trim();
};

const fail = (message) => {
  console.error(`[decision-log] ${message}`);
  process.exit(1);
};

function cmdLabel(args) {
  const eventId = requireValue(args.event, "[decision-log] --event <eventId> is required");
  const outcome = requireValue(args.outcome, "[decision-log] --outcome <value> is required");
  const by = requireValue(args.by, "[decision-log] --by human|agent is required");
  const runId = args.run === undefined || args.run === true ? null : String(args.run).trim();
  if (args.run === true) fail("--run needs a run id (or drop it and let the log be scanned)");
  try {
    const { path, runId: foundRun, record } = appendLabel({ eventId, outcome, by, runId });
    console.log(JSON.stringify({ ok: true, path, runId: foundRun, record }, null, 2));
  } catch (err) {
    fail(err.message);
  }
}

function main() {
  const args = parseCli(process.argv.slice(2));
  const cmd = args._[0];
  if (cmd === "label") return cmdLabel(args);
  console.error(`[decision-log] unknown subcommand "${cmd ?? ""}" — expected label`);
  process.exit(1);
}

if (process.argv[1]?.endsWith("decision-log.mjs")) main();