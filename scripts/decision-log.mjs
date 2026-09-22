#!/usr/bin/env node
// scripts/decision-log.mjs — the decision I/O log's outcome labels (FOC-449).
//
//   node scripts/decision-log.mjs label --event <eventId> --outcome <value>
//        --by human|agent [--run <runId>]
//   node scripts/decision-log.mjs export --decision <decisionId> [--out <path>]
//
// decisions.jsonl (one file per LA_RUN_ID under <repo>/.state/runs/) carries
// two line types:
//   · {type:"event", ...} — one per registry-backed decision call, written by
//     decision-call.mjs: identity (eventId), the scrubbed input AS SENT, the
//     typed output, usage/cost facts, taskKey. Legacy lines (pre-FOC-449, no
//     `type`) are decision records without an eventId; they still parse but
//     cannot carry a label and are skipped by the export.
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
//
// The export joins every event of one decisionId with its labels and assigns
// a training split deterministically: sha256("<eventId>|<decisionId>") gives
// a bucket (first 8 hex chars, mod 1000); < 800 → train, < 900 → val, else
// test. Same log content ⇒ byte-identical output — the seed, the thresholds
// and the record key order are constants of this script (splitVersion: 1;
// changing any of them is a new splitVersion, never a silent reshuffle).

import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SHADOW_EVENT_TYPE, SHADOW_FILENAME } from "./decision-call.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dir, "..");
// Same layout decision-call.mjs writes to: one decisions.jsonl per run id.
export const RUNS_DIR = join(ROOT, ".state", "runs");

export const SHADOW_LABEL_TYPE = "label";
export const LABEL_BY = ["human", "agent"];

// Split assignment (E4): deterministic per (eventId, decisionId), never
// re-drawn. Bumping the seed, the thresholds or the record shape is a new
// splitVersion — the number exists so a consumer can tell reshuffles apart.
export const SPLIT_VERSION = 1;
const SPLIT_TRAIN_BELOW = 800;
const SPLIT_VAL_BELOW = 900;

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

/**
 * The training split of one event: sha256("<eventId>|<decisionId>") → bucket
 * (first 8 hex chars mod 1000) → < 800 train, < 900 val, else test. Pure and
 * stable: the same pair always maps to the same split, no matter when it is
 * asked or which log holds the event.
 */
export function splitFor(eventId, decisionId) {
  const hex = createHash("sha256").update(`${eventId}|${decisionId}`).digest("hex").slice(0, 8);
  const bucket = parseInt(hex, 16) % 1000;
  if (bucket < SPLIT_TRAIN_BELOW) return "train";
  if (bucket < SPLIT_VAL_BELOW) return "val";
  return "test";
}

/**
 * One export record per event line of `decisionId`, joined with the labels
 * that live in the same run file. Deterministic twice over: run logs are
 * scanned name-ascending (NOT the label lookup's newest-first — mtimes move,
 * exports must not), and each record's key order is the literal below. Legacy
 * lines (no `type`, no eventId) parse but are skipped.
 */
export function exportDecisionEvents(decisionId, { runsDir = RUNS_DIR } = {}) {
  const records = [];
  const logs = existsSync(runsDir)
    ? readdirSync(runsDir)
        .sort()
        .map((runId) => ({ runId, path: join(runsDir, runId, SHADOW_FILENAME) }))
        .filter((f) => existsSync(f.path))
    : [];
  for (const { runId, path } of logs) {
    const lines = readJsonl(path);
    for (const line of lines) {
      if (line?.type !== SHADOW_EVENT_TYPE || line?.decisionId !== decisionId || !line?.eventId) continue;
      const eventId = line.eventId;
      const labels = lines.filter((l) => l?.type === SHADOW_LABEL_TYPE && l?.eventId === eventId);
      records.push({
        splitVersion: SPLIT_VERSION,
        split: splitFor(eventId, decisionId),
        eventId,
        decisionId,
        ts: line.ts ?? null,
        taskKey: line.taskKey ?? null,
        runId,
        input: line.input ?? null,
        output: {
          ok: line.ok ?? null,
          answers: line.answers ?? null,
          confidence: line.confidence ?? null,
          formatConfidence: line.formatConfidence ?? null,
          model: line.model ?? null,
          pinnedModel: line.pinnedModel ?? null,
          tier: line.tier ?? null,
          mode: line.mode ?? null,
          usage: line.usage ?? null,
          responseId: line.responseId ?? null,
          error: line.error ?? null,
        },
        labels,
      });
    }
  }
  return records;
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

function cmdExport(args) {
  const decisionId = requireValue(args.decision, "[decision-log] --decision <decisionId> is required");
  if (args.out === true) fail("--out needs a file path (or drop it and the records go to stdout as JSONL)");
  const out = args.out === undefined ? null : String(args.out).trim();
  let records;
  try {
    records = exportDecisionEvents(decisionId);
  } catch (err) {
    return fail(err.message);
  }
  if (out) {
    writeFileSync(out, records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : ""), "utf8");
    const counts = { train: 0, val: 0, test: 0 };
    for (const r of records) counts[r.split]++;
    console.log(
      JSON.stringify({ ok: true, decisionId, splitVersion: SPLIT_VERSION, path: out, total: records.length, counts }, null, 2),
    );
  } else {
    // Pure JSONL on stdout: one training record per line, in scan order.
    for (const r of records) console.log(JSON.stringify(r));
  }
}

function main() {
  const args = parseCli(process.argv.slice(2));
  const cmd = args._[0];
  if (cmd === "label") return cmdLabel(args);
  if (cmd === "export") return cmdExport(args);
  console.error(`[decision-log] unknown subcommand "${cmd ?? ""}" — expected label | export`);
  process.exit(1);
}

if (process.argv[1]?.endsWith("decision-log.mjs")) main();