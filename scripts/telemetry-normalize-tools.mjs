#!/usr/bin/env node
/**
 * scripts/telemetry-normalize-tools.mjs — fill the two tool_facts columns that
 * the extractor left empty for every row written before 2026-09-04.
 *
 * `tool_name_canon` was written as NULL with the comment "filled by
 * normalization pass"; that pass never existed, because config/tool-norm.json
 * (agent-intelligence PRD §10) was never committed. `tool_has_error` was
 * written as 0 for the same reason — the verdict lives in a tool_result block
 * that appears LATER in the transcript than the tool_use it describes, so a
 * single streaming pass could not resolve it. Both are now filled at extraction
 * time (telemetry-tool-extract.mjs); this script repairs the existing rows.
 *
 * Two passes, deliberately separate because they have different requirements:
 *
 *   canon  — pure function of tool_name_raw and the config map. Needs no files,
 *            so it repairs every row including those whose transcript is gone.
 *   errors — needs the transcript re-read to pair tool_use with tool_result.
 *            Rows whose source file no longer exists keep tool_has_error = 0
 *            and are reported as `unverifiable`, never silently as "no errors".
 *
 * Idempotent: re-running changes nothing once both passes have applied.
 *
 * Usage:
 *   node scripts/telemetry-normalize-tools.mjs [--dry] [--json] [--canon-only] [--help]
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { telemetryDbPath } from "./telemetry-store.mjs";
import { loadToolNormMap, bucketUnknownTool, extractToolFacts } from "./telemetry-tool-extract.mjs";

/**
 * Reproduce the stored primary key. `extractToolFacts` returns its own
 * `tool_fact_id`, but `recordToolFact` (telemetry-store.mjs) ignores it and
 * recomputes sha1(source_path:source_offset:tool_index) — so the extractor's id
 * never reaches the database and matching on it finds nothing. `tool_index` is
 * the position of a tool_use within its assistant message, assigned by the
 * (unexported) addToolIndex in telemetry-ingest.mjs; the grouping is repeated
 * here rather than imported, and is asserted against real rows by --dry.
 */
function storedToolFactIds(records) {
  const counters = new Map();
  return records.map((record) => {
    const key = `${record.source_path}:${record.source_offset}`;
    const index = counters.get(key) ?? 0;
    counters.set(key, index + 1);
    return {
      ...record,
      storedId: createHash("sha1").update(`${record.source_path}:${record.source_offset}:${index}`).digest("hex"),
    };
  });
}

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const JSON_OUT = args.includes("--json");
const CANON_ONLY = args.includes("--canon-only");

if (args.includes("--help")) {
  console.log(`Usage: node scripts/telemetry-normalize-tools.mjs [--dry] [--json] [--canon-only]

  --dry         Report what would change; write nothing.
  --json        Machine-readable summary on stdout.
  --canon-only  Skip the transcript re-read (fast; canon column only).
  --help        This message.`);
  process.exit(0);
}

const log = (...a) => { if (!JSON_OUT) console.log(...a); };

const db = new DatabaseSync(telemetryDbPath());
db.exec("PRAGMA busy_timeout = 15000;");

const summary = { canon: {}, errors: {}, dry: DRY };

// ---------------------------------------------------------------------------
// Pass 1 — canonical tool names
// ---------------------------------------------------------------------------
const { rawToCanon } = loadToolNormMap();
const rawNames = db.prepare("SELECT DISTINCT tool_name_raw FROM tool_facts").all();

const mapping = rawNames.map(({ tool_name_raw: raw }) => ({
  raw,
  canon: rawToCanon.resolve(raw) || bucketUnknownTool(raw),
}));
const bucketed = mapping.filter((m) => m.canon?.startsWith("other_"));

const pending = db.prepare("SELECT COUNT(*) n FROM tool_facts WHERE tool_name_canon IS NULL").get().n;
summary.canon = {
  distinctNames: mapping.length,
  rowsPending: pending,
  bucketedNames: bucketed.map((b) => `${b.raw} -> ${b.canon}`),
};

log(`canon: ${mapping.length} distinct tool names, ${pending} rows with NULL canon`);
if (bucketed.length) log(`  ${bucketed.length} name(s) fell through to other_*: ${bucketed.map((b) => b.raw).join(", ")}`);

if (!DRY && pending > 0) {
  const update = db.prepare("UPDATE tool_facts SET tool_name_canon=? WHERE tool_name_raw=? AND tool_name_canon IS NULL");
  db.exec("BEGIN");
  let changed = 0;
  for (const { raw, canon } of mapping) changed += update.run(canon, raw).changes;
  db.exec("COMMIT");
  summary.canon.rowsUpdated = changed;
  log(`  updated ${changed} rows`);
}

// ---------------------------------------------------------------------------
// Pass 2 — error verdicts (needs the transcripts)
// ---------------------------------------------------------------------------
if (!CANON_ONLY) {
  // One re-read per (source_path, run_id, agent_key): tool_fact_id is derived
  // from path+offset+index, so re-extraction reproduces the same ids and the
  // update is a straight key match.
  const groups = db.prepare(
    `SELECT source_path, run_id, agent_key, COUNT(*) n FROM tool_facts GROUP BY 1,2,3`,
  ).all();

  const present = groups.filter((g) => existsSync(g.source_path));
  const gone = groups.filter((g) => !existsSync(g.source_path));
  const unverifiableRows = gone.reduce((a, g) => a + g.n, 0);

  log(`errors: ${groups.length} transcript groups — ${present.length} readable, ${gone.length} missing (${unverifiableRows} rows unverifiable)`);

  let flagged = 0;
  let scanned = 0;
  let unmatched = 0;
  const update = db.prepare("UPDATE tool_facts SET tool_has_error=1 WHERE run_id=? AND tool_fact_id=? AND tool_has_error=0");
  const exists = db.prepare("SELECT 1 FROM tool_facts WHERE run_id=? AND tool_fact_id=?");

  for (const g of present) {
    let records;
    try {
      records = await extractToolFacts(g.source_path, g.run_id, g.agent_key);
    } catch {
      continue; // unreadable mid-run; counted as unverifiable below
    }
    scanned++;
    const errored = storedToolFactIds(records).filter((r) => r.tool_has_error === 1);
    if (!errored.length) continue;
    if (DRY) {
      // Verify the reconstructed key actually addresses a stored row — a silent
      // key mismatch is exactly how this pass reported 2074 findings and wrote 0.
      for (const r of errored) {
        if (exists.get(g.run_id, r.storedId)) flagged++;
        else unmatched++;
      }
    } else {
      db.exec("BEGIN");
      for (const r of errored) {
        const changes = update.run(g.run_id, r.storedId).changes;
        if (changes) flagged += changes;
        else unmatched++;
      }
      db.exec("COMMIT");
    }
  }

  summary.errors = {
    groups: groups.length,
    scanned,
    missingTranscripts: gone.length,
    unverifiableRows,
    rowsFlagged: flagged,
    rowsUnmatched: unmatched,
  };
  log(`  ${flagged} rows flagged as errored across ${scanned} transcripts`);
  if (unmatched) {
    log(`  ${unmatched} errored call(s) had no stored row — transcript grew since ingest, or the key scheme drifted`);
  }
}

if (JSON_OUT) console.log(JSON.stringify(summary, null, 2));
db.close();
