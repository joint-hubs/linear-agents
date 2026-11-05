// scripts/bash-output-distribution.mjs — FOC-1072 Item 1.
//
// Measures the distribution of Bash tool-result sizes from the telemetry
// store, per role, so the Bash output cap (FOC-1072 Item 2) is chosen from a
// measured distribution rather than a guess — Mateusz reads distributions as
// p20–p80 + median, so those lead the report.
//
// Source data: tool_facts.tool_result_bytes (FOC-220) — UTF-8 byte size of the
// result text; 0 = present but empty; NULL = missing or unknown and is
// EXCLUDED, never read as a measurement. Rows are joined to runs for the squad
// label and the time window; a run belongs to the window when runs.started_at
// falls on/after the cutoff (runs.started_at NULL → not placeable → excluded).
//
// Role grouping reuses the split the telemetry already records (the same rule
// agent-behavior.mjs applies to delegation share): agent_key '_lead' → lead,
// anything else → subagent. The cap is per-process, so the lead/subagent split
// — not the squad split — is the axis a cap decision reads.
//
// The 3.3 GB store is never loaded whole: the query drives off
// idx_tool_facts_canon (tool_name_canon = 'bash' — LOWERCASE: that is the
// canon key config/tool-norm.json maps the raw names Bash/PowerShell/… onto;
// the raw name keeps its capital, the canon column does not) and rows stream
// through StatementSync.iterate(), accumulating only the byte values per role.
//
// Read-only per docs/TELEMETRY-EXPLAINED.md: the CLI opens the store with
// { readOnly: true }; the exported core takes an open db handle, so the test
// fixture and the CLI share one code path.
//
// Usage:
//   node scripts/bash-output-distribution.mjs [--days N] [--json] [--db <path>] [--help]
//
//   --days N   window in days (default 30); a run is in-window when
//              runs.started_at >= now - N days
//   --json     one JSON object on stdout, no extra formatting
//   --db PATH  store path override (default telemetryDbPath() from
//              fenix-paths.mjs; env seam LA_TELEMETRY_DB applies as usual)
//
// Exit codes: 0 ok, 3 DB missing or cannot be opened.

import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";

import { percentileNearestRank } from "./cost-quality.mjs";
import { telemetryDbPath } from "./fenix-paths.mjs";

const DAY_MS = 86_400_000;
const DEFAULT_DAYS = 30;
// Thresholds in bytes: 2 KB / 8 KB / 32 KB (binary KiB, matching how tool
// result sizes are discussed in the FOC-1072 kickoff).
const THRESHOLDS = [
  ["above2k", 2048],
  ["above8k", 8192],
  ["above32k", 32768],
];

/** Role of a tool_facts row — the store's own lead/subagent split. */
export function roleOf(agentKey) {
  return agentKey === "_lead" ? "lead" : "subagent";
}

/**
 * Distribution summary over raw byte values. Percentiles are nearest-rank
 * (the shared percentileNearestRank — one percentile rule in this repo).
 * countShare / bytesShare are fractions in [0,1].
 */
export function summarizeBytes(values) {
  const n = values.length;
  const bytes = values.reduce((a, b) => a + b, 0);
  const summary = {
    n,
    bytes,
    p20: percentileNearestRank(values, 20),
    p50: percentileNearestRank(values, 50),
    p80: percentileNearestRank(values, 80),
    p95: percentileNearestRank(values, 95),
  };
  for (const [key, threshold] of THRESHOLDS) {
    let count = 0;
    let aboveBytes = 0;
    for (const v of values) {
      if (v > threshold) {
        count++;
        aboveBytes += v;
      }
    }
    summary[key] = {
      count,
      countShare: n > 0 ? count / n : 0,
      bytes: aboveBytes,
      bytesShare: bytes > 0 ? aboveBytes / bytes : 0,
    };
  }
  return summary;
}

/**
 * Core measurement over an open DatabaseSync handle.
 * `sinceIso` — inclusive lower bound on runs.started_at (ISO string; the
 * column compares lexicographically against ISO timestamps in the store).
 * Returns { window, roles: { lead, subagent }, all }.
 */
export function bashOutputDistribution(db, { sinceIso }) {
  // Drive off idx_tool_facts_canon, join runs by PK, stream — never .all()
  // over the production store.
  const stmt = db.prepare(`
    SELECT CASE WHEN u.agent_key = '_lead' THEN 'lead' ELSE 'subagent' END AS role,
           u.tool_result_bytes AS bytes
      FROM tool_facts u
      JOIN runs r USING(run_id)
     WHERE u.tool_name_canon = 'bash'
       AND u.tool_result_bytes IS NOT NULL
       AND r.started_at IS NOT NULL
       AND r.started_at >= ?
  `);
  const byRole = { lead: [], subagent: [] };
  for (const row of stmt.iterate(sinceIso)) {
    byRole[row.role].push(row.bytes);
  }
  return {
    window: { sinceIso },
    roles: { lead: summarizeBytes(byRole.lead), subagent: summarizeBytes(byRole.subagent) },
    all: summarizeBytes([...byRole.lead, ...byRole.subagent]),
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function usage() {
  const text = `
bash-output-distribution.mjs — distribution of Bash tool-result sizes (FOC-1072)

USAGE:
  node scripts/bash-output-distribution.mjs [OPTIONS]

OPTIONS:
  --days N     Window in days (default: 30); a run is in-window when
               runs.started_at >= now - N days
  --json       Output JSON to stdout (one object, no extra formatting)
  --db PATH    Telemetry store path override (default: telemetryDbPath())
  --help       Print this message and exit

EXIT CODES:
  0  OK
  3  DB_ERROR  database not found or cannot be opened

ROLE SPLIT:
  agent_key '_lead' → lead, anything else → subagent (the store's own split;
  the same rule agent-behavior.mjs uses for the delegation share).

NOTES:
  - tool_result_bytes NULL (unknown) rows are excluded, never read as zero.
  - byte 0 (present but empty) IS a measurement and stays in the distribution.
  - percentiles are nearest-rank; the default window is runs.started_at-based.
`.trim();
  console.log(text);
}

// Binary units, honestly labelled: the divisors are 1024, so the labels say
// KiB/MiB — a "MB" label on a /1024 value misstates the measurement by ~4.9%.
function fmtBytes(n) {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${n} B`;
}

function pct(n) {
  return n == null ? "—" : `${(n / 1024).toFixed(1)} KiB`;
}

function printHuman(result) {
  const { roles, all } = result;
  const row = (label, s) => {
    const band = s.n > 0 ? `p20=${pct(s.p20)} p50=${pct(s.p50)} p80=${pct(s.p80)} p95=${pct(s.p95)}` : "no data";
    const shares = s.n > 0
      ? `>2KB: ${(s.above2k.countShare * 100).toFixed(1)}% of calls / ${(s.above2k.bytesShare * 100).toFixed(1)}% of bytes`
      : "";
    console.log(`  ${label.padEnd(10)} n=${String(s.n).padStart(7)}  ${band}`);
    if (shares) console.log(`  ${"".padEnd(10)} ${shares}  >8KB: ${(s.above8k.countShare * 100).toFixed(1)}% / ${(s.above8k.bytesShare * 100).toFixed(1)}%  >32KB: ${(s.above32k.countShare * 100).toFixed(1)}% / ${(s.above32k.bytesShare * 100).toFixed(1)}%`);
    if (s.n > 0) console.log(`  ${"".padEnd(10)} total Bash bytes: ${fmtBytes(s.bytes)}`);
  };
  console.log(`Bash tool-result size distribution (window: since ${result.window.sinceIso})`);
  row("lead", roles.lead);
  row("subagent", roles.subagent);
  row("all", all);
}

async function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help") {
      usage();
      return 0;
    }
    if (a === "--json") args.json = true;
    else if (a === "--days") args.days = Number(argv[++i]);
    else if (a === "--db") args.db = argv[++i];
    else {
      console.error(`unknown argument: ${a} (see --help)`);
      return 2;
    }
  }
  const days = Number.isFinite(args.days) && args.days > 0 ? args.days : DEFAULT_DAYS;
  const sinceIso = new Date(Date.now() - days * DAY_MS).toISOString();

  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    console.error(`node:sqlite is required (current: ${process.version})`);
    return 3;
  }
  const path = args.db || telemetryDbPath();
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch (err) {
    console.error(`cannot open telemetry store (read-only): ${path}\n  ${err.message}`);
    return 3;
  }

  try {
    db.exec("PRAGMA busy_timeout = 10000;");
    const result = bashOutputDistribution(db, { sinceIso });
    if (args.json) {
      console.log(JSON.stringify({ ...result, window: { ...result.window, days } }, null, 2));
    } else {
      printHuman(result);
    }
    return 0;
  } finally {
    db.close();
  }
}

// CLI entry — only when executed directly, never when the test imports the
// module (pathToFileURL + realpath: the same trick node --test files use).
const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMain) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err.message);
      process.exit(3);
    });
}
