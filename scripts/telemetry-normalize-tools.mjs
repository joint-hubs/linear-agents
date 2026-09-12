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
 *   identity (FOC-220) — needs the transcript re-read too: fills tool_input_id
 *            (full-input identity), tool_index, tool_result_state / bytes / id
 *            for rows whose transcript still exists. Rows whose transcript is
 *            gone stay NULL — which reads as UNKNOWN, never as a measured zero
 *            or a verified ok.
 *
 * Idempotent: re-running changes nothing once all passes have applied.
 *
 * Usage:
 *   node scripts/telemetry-normalize-tools.mjs [--dry] [--json] [--canon-only] [--help]
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { openTelemetryDb, telemetryDbPath, toolIdentitySalt } from "./telemetry-store.mjs";
import { contentDigest, inputIdentity } from "./tool-identity.mjs";
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

// openTelemetryDb (not a raw DatabaseSync) so the FOC-220 additive columns and
// the identity salt exist before the passes below write them.
const db = openTelemetryDb(telemetryDbPath());
db.exec("PRAGMA busy_timeout = 15000;");
const identitySalt = toolIdentitySalt(db);

const summary = { canon: {}, errors: {}, identity: {}, dry: DRY };

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
// Pass 2 + 3 — transcript-backed repairs (error verdicts, then FOC-220 identity)
// ---------------------------------------------------------------------------
// One re-read per (source_path, run_id, agent_key) feeds both repairs:
// tool_fact_id is derived from path+offset+index, so re-extraction reproduces
// the same ids and every update is a straight key match.
if (!CANON_ONLY) {
  const groups = db.prepare(
    `SELECT source_path, run_id, agent_key, COUNT(*) n FROM tool_facts GROUP BY 1,2,3`,
  ).all();

  const present = groups.filter((g) => existsSync(g.source_path));
  const gone = groups.filter((g) => !existsSync(g.source_path));
  const unverifiableRows = gone.reduce((a, g) => a + g.n, 0);

  log(`errors+identity: ${groups.length} transcript groups — ${present.length} readable, ${gone.length} missing (${unverifiableRows} rows unverifiable)`);

  let flagged = 0;
  let scanned = 0;
  let unmatched = 0;
  let identityRepaired = 0;
  let identityUnmatched = 0;
  const updateError = db.prepare("UPDATE tool_facts SET tool_has_error=1 WHERE run_id=? AND tool_fact_id=? AND tool_has_error=0");
  // FOC-220: fill the identity/outcome columns only where they are still NULL —
  // never overwrite a value, never fabricate one for a row we cannot re-derive.
  const updateIdentity = db.prepare(`UPDATE tool_facts SET
      tool_input_id=?, tool_index=?, tool_result_state=?, tool_result_bytes=?, tool_result_id=?
    WHERE run_id=? AND tool_fact_id=? AND (tool_input_id IS NULL OR tool_result_state IS NULL)`);
  const exists = db.prepare("SELECT 1 FROM tool_facts WHERE run_id=? AND tool_fact_id=?");
  const needsIdentity = DRY
    ? db.prepare("SELECT 1 FROM tool_facts WHERE run_id=? AND tool_fact_id=? AND (tool_input_id IS NULL OR tool_result_state IS NULL)")
    : null;
  const RESULT_STATES = new Set(["ok", "error", "missing"]);

  const identityFields = (r) => [
    r.tool_input_full != null ? inputIdentity(r.tool_input_full, identitySalt) : null,
    Number.isInteger(r.tool_index) ? r.tool_index : null,
    RESULT_STATES.has(r.tool_result_state) ? r.tool_result_state : null,
    Number.isInteger(r.tool_result_bytes) ? r.tool_result_bytes : null,
    typeof r.tool_result_full === "string" && r.tool_result_state && r.tool_result_state !== "missing"
      ? contentDigest(r.tool_result_full, identitySalt)
      : null,
  ];

  for (const g of present) {
    let records;
    try {
      records = await extractToolFacts(g.source_path, g.run_id, g.agent_key);
    } catch {
      continue; // unreadable mid-run; counted as unverifiable below
    }
    scanned++;
    const stored = storedToolFactIds(records);

    if (DRY) {
      // Verify the reconstructed key actually addresses a stored row — a silent
      // key mismatch is exactly how this pass reported 2074 findings and wrote 0.
      for (const r of stored) {
        if (!exists.get(g.run_id, r.storedId)) {
          if (r.tool_has_error === 1) unmatched++;
          identityUnmatched++;
          continue;
        }
        if (r.tool_has_error === 1) flagged++;
        if (needsIdentity.get(g.run_id, r.storedId)) identityRepaired++;
      }
    } else {
      db.exec("BEGIN");
      try {
        for (const r of stored) {
          if (r.tool_has_error === 1) {
            const changes = updateError.run(g.run_id, r.storedId).changes;
            if (changes) flagged += changes;
            else unmatched++;
          }
          const repaired = updateIdentity.run(...identityFields(r), g.run_id, r.storedId).changes;
          if (repaired) identityRepaired++;
          else if (!exists.get(g.run_id, r.storedId)) identityUnmatched++;
        }
        db.exec("COMMIT");
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
        throw error;
      }
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
  summary.identity = {
    rowsRepaired: identityRepaired,
    rowsUnmatched: identityUnmatched,
    rowsUnverifiable: unverifiableRows,
  };
  log(`  ${flagged} rows flagged as errored across ${scanned} transcripts`);
  if (unmatched) {
    log(`  ${unmatched} errored call(s) had no stored row — transcript grew since ingest, or the key scheme drifted`);
  }
  log(`  ${identityRepaired} rows given tool_input_id / tool_result columns${DRY ? " (dry run — nothing written)" : ""}`);
  if (identityUnmatched) {
    log(`  ${identityUnmatched} re-extracted call(s) had no stored row — transcript grew since ingest, or the key scheme drifted`);
  }
  if (gone.length) {
    log(`  ${unverifiableRows} rows in ${gone.length} missing transcript(s) stay NULL = unknown (never guessed)`);
  }
}

if (JSON_OUT) console.log(JSON.stringify(summary, null, 2));
db.close();
