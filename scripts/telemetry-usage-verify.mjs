#!/usr/bin/env node
// Independent verification of the per-message usage dedup in the telemetry
// store (FOC-381). This module shares NO code with telemetry-store.mjs or
// telemetry-ingest.mjs — independence is the whole point: it re-derives the
// expected usage from the raw transcripts and compares it against what the
// store recorded.
//
// Why this exists: Claude Code writes ONE assistant message to its transcript
// as 2-3 lines, each repeating message.usage (some with zeros) under the same
// message.id. After the rewrite, usage_facts holds ONE row per message per run
// for history with message_id; legacy rows (message_id IS NULL) are per-line
// and still inflated — they are reported separately, never compared.
//
// Method (mirrors scripts/telemetry-message-scan.mjs parsing rules exactly —
// that module is the committed independent reference; its helpers are not
// exported, so the single-line parse is re-implemented here line for line):
//   - Store side: usage_facts rows with message_id IS NOT NULL, grouped by
//     (source_path, message_id); per group take the MAX of each counter.
//     If two runs sharing the same file disagree on a message's counters,
//     that is a run_disagreement (MAX still wins for the comparison).
//   - Scan side: read each transcript once; for every qualifying assistant
//     line whose byte START offset is < the ingest horizon for that file
//     (MAX(byte_offset) in transcript_sources — the store was snapshotted
//     while transcripts kept growing, so lines past the horizon were never
//     seen by ingest and must not count), group by message.id and take the
//     MAX of each counter across the group's lines.
//   - Compare per message: matched / mismatched / missingInStore /
//     missingInScan, plus a strict "at most one usage_facts row per
//     (run_id, source_path, message_id)" check (duplicateMessageRows) — the
//     FOC-381 invariant is one row per message per FILE per run. Pass = every
//     squad within tolerance AND mismatched === missingInStore ===
//     missingInScan === duplicateMessageRows === 0 — per-squad tolerance
//     alone could hide a small constant leak, the zero counts cannot.
//   - Informational, does NOT gate pass: crossFileDuplicates counts messages
//     logged under the same (run_id, message_id) in MORE than one transcript
//     file — e.g. the lead transcript and a subagent transcript of the same
//     session share one OpenRouter gen-... id at the subagent's first
//     assistant line. Each file correctly holds ONE row, so the per-file
//     invariant holds; the overlap is a cross-file logging phenomenon and a
//     follow-up, not a FOC-381 failure. Reported with its extra token volume
//     so the double-counted amount stays visible.
//
// Byte offsets: split on \n keeping terminators and advance by the line's
// UTF-8 byte length (Buffer.byteLength), exactly like ingest — a \r\n
// terminator and multi-byte characters both stay inside the line's byte
// span, so offsets computed this way always agree with the store's.
//
// Read-only: the database is opened with readOnly:true and nothing is
// written anywhere. CLI: node scripts/telemetry-usage-verify.mjs --db <path>
//   [--json] [--tolerance 0.01]  — exit 0 pass, 1 fail, 2 usage error.

import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The four counters, in one order everywhere. Store column names differ from
// transcript usage field names for the cache pair — both are mapped here.
const STORE_COLS = ["input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens"];
const USAGE_FIELDS = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"];

const DEFAULT_TOLERANCE = 0.01;
const MAX_EXAMPLES = 20;

function blankVals() {
  return { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
}

// Parse ONE transcript line into its four counters + message.id. Mirrors
// usageOf() in telemetry-message-scan.mjs rule for rule: only lines of type
// "assistant" carrying a message.usage object qualify; missing/non-finite
// counters count as 0; message.id must be a non-empty string.
function usageOf(line) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return { parseError: true };
  }
  const msg = obj && obj.type === "assistant" ? obj.message : null;
  if (!msg || typeof msg !== "object" || !msg.usage || typeof msg.usage !== "object") return null;
  const usage = msg.usage;
  const vals = {};
  for (const f of USAGE_FIELDS) {
    vals[f] = typeof usage[f] === "number" && Number.isFinite(usage[f]) ? usage[f] : 0;
  }
  return { vals, id: typeof msg.id === "string" && msg.id ? msg.id : null };
}

function tokensOf(vals) {
  let sum = 0;
  for (const f of USAGE_FIELDS) sum += vals[f];
  return sum;
}

function maxInto(target, src) {
  for (const f of USAGE_FIELDS) if (src[f] > target[f]) target[f] = src[f];
  return target;
}

// Scan one file up to `horizon` bytes: returns a Map message.id ->
// per-counter MAX over the qualifying lines that START before the horizon.
// The file is read once and split on \n keeping the terminator; the running
// offset advances by the line's UTF-8 byte length, so a line's START offset
// matches the offset ingest would have computed for it.
function scanFileBeforeHorizon(filePath, horizon) {
  const groups = new Map();
  const buf = readFileSync(filePath);
  let offset = 0;
  let start = 0;
  // Slice [start, next \n] inclusive of the terminator: the terminator's
  // bytes belong to this line's span, so the next line's START is exact.
  while (start < buf.length) {
    let end = buf.indexOf(0x0a, start);
    end = end === -1 ? buf.length : end + 1;
    const lineStart = offset;
    offset += end - start; // raw byte length == Buffer.byteLength of the decoded slice
    if (lineStart < horizon) {
      const parsed = usageOf(buf.slice(start, end).toString("utf8"));
      if (parsed && !parsed.parseError && parsed.id) {
        // Only id-bearing lines are comparable against message_id-keyed
        // store rows; no-id lines belong to the legacy bucket (step 6).
        const cur = groups.get(parsed.id);
        if (!cur) groups.set(parsed.id, parsed.vals);
        else maxInto(cur, parsed.vals);
      }
    }
    start = end;
  }
  return groups;
}

// Squad of a transcript path: the segment right after the `agents` segment
// (`...\agents\<squad>\projects\...`), either slash flavor. Returns null so
// the caller can fall back to runs.squad.
function squadFromPath(sourcePath) {
  const segs = sourcePath.split(/[\\/]/);
  for (let i = segs.length - 1; i >= 0; i--) {
    if (segs[i] === "agents") {
      const next = segs[i + 1];
      return next ? next : null;
    }
  }
  return null;
}

function diffPct(store, scan) {
  // No scan tokens to divide by: zero store is a perfect match, anything
  // above zero is an unbounded miss (Infinity, never within tolerance).
  if (scan > 0) return (store - scan) / scan;
  return store === 0 ? 0 : Infinity;
}

/**
 * Verify the store's per-message usage against the raw transcripts.
 * Read-only. Returns the report described in the module header.
 *
 * @param {{ dbPath: string, onProgress?: (p: {filesDone: number, filesTotal: number}) => void }} opts
 */
export function verifyUsage({ dbPath, onProgress, tolerance = DEFAULT_TOLERANCE }) {
  // readOnly:true — verification must never mutate the store (and must fail
  // loudly rather than create an empty database if the path is wrong).
  const db = new DatabaseSync(dbPath, { readOnly: true });

  // --- store side -----------------------------------------------------
  const runSquad = new Map(); // run_id -> squad
  try {
    for (const r of db.prepare("SELECT run_id, squad FROM runs").all()) {
      if (typeof r.squad === "string" && r.squad) runSquad.set(r.run_id, r.squad);
    }
  } catch {
    // runs may be absent in a minimal fixture; the path rule still works.
  }

  const facts = db
    .prepare(
      `SELECT run_id, source_path, message_id, ${STORE_COLS.join(", ")}
       FROM usage_facts WHERE message_id IS NOT NULL`,
    )
    .all();
  // Group key: (source_path, message_id). Within a group, MAX per counter
  // across all rows; runs are tracked separately to spot disagreement.
  const storeGroups = new Map();
  for (const row of facts) {
    const key = `${row.source_path}\u0000${row.message_id}`;
    let g = storeGroups.get(key);
    if (!g) {
      g = { source_path: row.source_path, message_id: row.message_id, max: blankVals(), runs: new Map() };
      storeGroups.set(key, g);
    }
    const vals = {};
    for (let i = 0; i < 4; i++) vals[USAGE_FIELDS[i]] = typeof row[STORE_COLS[i]] === "number" ? row[STORE_COLS[i]] : 0;
    maxInto(g.max, vals);
    const prev = g.runs.get(row.run_id);
    if (!prev) g.runs.set(row.run_id, vals);
    else maxInto(prev, vals);
  }
  // Two runs on the same file disagreeing on a message's counters means one
  // of the runs recorded something different — count it, keep MAX for the
  // comparison so the verification itself is not skewed by the smaller copy.
  const runDisagreements = new Set();
  for (const g of storeGroups.values()) {
    if (g.runs.size < 2) continue;
    let ref = null;
    for (const vals of g.runs.values()) {
      if (!ref) { ref = vals; continue; }
      for (const f of USAGE_FIELDS) if (vals[f] !== ref[f]) { runDisagreements.add(g); break; }
      if (runDisagreements.has(g)) break;
    }
  }

  // Strict per-message uniqueness: at most ONE usage_facts row per
  // (run_id, source_path, message_id) is the FOC-381 contract — one row per
  // message per FILE per run. Rows that slipped past the projection identity
  // (e.g. an explicit usageId override) still MAX-compare equal above — the
  // tolerance below could never catch them, so they are counted separately
  // and gate pass on their own.
  let duplicateMessageRows = 0;
  const duplicateExamples = [];
  {
    const rowsPerGroup = new Map(); // run_id\0source_path\0message_id -> rows
    for (const row of facts) {
      const key = `${row.run_id}\u0000${row.source_path}\u0000${row.message_id}`;
      rowsPerGroup.set(key, (rowsPerGroup.get(key) || 0) + 1);
    }
    for (const [key, rows] of rowsPerGroup) {
      if (rows <= 1) continue;
      duplicateMessageRows++;
      if (duplicateExamples.length < 10) {
        const [runId, sourcePath, messageId] = key.split("\u0000");
        duplicateExamples.push({ run_id: runId, source_path: sourcePath, message_id: messageId, rows });
      }
    }
  }

  // Informational cross-file overlap: the same API call (same run_id +
  // message_id) can be logged in more than one transcript file — the lead
  // transcript and a subagent transcript of the same session both record the
  // OpenRouter gen-... id at the subagent's first assistant line. Each file
  // still holds exactly one row, so the per-file invariant above holds and
  // this must NOT gate pass; it is reported so the double-counted token
  // volume stays visible. extraTokens: per group, the sum of all rows' four
  // counters minus the largest single row — i.e. what a "count once"
  // policy would save. Examples keep paths and per-row token totals in the
  // same (insertion) order so they read as parallel arrays.
  const crossFileDuplicates = { messages: 0, rows: 0, extraTokens: 0, examples: [] };
  {
    const perRunMessage = new Map(); // run_id\0message_id -> { paths:Set, rowTokens:[{path, tokens}] }
    for (const row of facts) {
      const key = `${row.run_id}\u0000${row.message_id}`;
      let g = perRunMessage.get(key);
      if (!g) {
        g = { paths: new Set(), rowTokens: [] };
        perRunMessage.set(key, g);
      }
      g.paths.add(row.source_path);
      const vals = {};
      for (let i = 0; i < 4; i++) vals[USAGE_FIELDS[i]] = typeof row[STORE_COLS[i]] === "number" ? row[STORE_COLS[i]] : 0;
      g.rowTokens.push({ path: row.source_path, tokens: tokensOf(vals) });
    }
    for (const [key, g] of perRunMessage) {
      if (g.paths.size < 2) continue;
      crossFileDuplicates.messages++;
      crossFileDuplicates.rows += g.rowTokens.length;
      let max = 0;
      for (const r of g.rowTokens) {
        crossFileDuplicates.extraTokens += r.tokens;
        if (r.tokens > max) max = r.tokens;
      }
      crossFileDuplicates.extraTokens -= max;
      if (crossFileDuplicates.examples.length < 10) {
        const [runId, messageId] = key.split("\u0000");
        crossFileDuplicates.examples.push({
          run_id: runId,
          message_id: messageId,
          paths: g.rowTokens.map((r) => r.path),
          rowsTokens: g.rowTokens.map((r) => r.tokens),
        });
      }
    }
  }

  const horizons = new Map(); // source_path -> MAX(byte_offset)
  try {
    for (const r of db.prepare("SELECT source_path, MAX(byte_offset) AS horizon FROM transcript_sources GROUP BY source_path").all()) {
      if (typeof r.horizon === "number") horizons.set(r.source_path, r.horizon);
    }
  } catch {
    // No transcript_sources: every horizon stays undefined -> 0, so all
    // store messages will surface as missingInScan instead of passing.
  }
  db.close();

  // --- scan side + comparison -----------------------------------------
  const perPath = new Map(); // source_path -> { squad, store: [groups], scan: Map }
  for (const g of storeGroups.values()) {
    let p = perPath.get(g.source_path);
    if (!p) {
      p = { store: [], scan: null, onDisk: existsSync(g.source_path) };
      perPath.set(g.source_path, p);
    }
    p.store.push(g);
  }

  let filesChecked = 0;
  let filesMissing = 0;
  let matched = 0;
  let mismatched = 0;
  let missingInStore = 0;
  let missingInScan = 0;
  const mismatchExamples = [];
  const squadAgg = new Map(); // squad -> { storeTokens, scanTokens }

  const paths = [...perPath.keys()].sort();
  for (const sourcePath of paths) {
    const p = perPath.get(sourcePath);
    // Squad: path segment after `agents`, else the squad of any run that has
    // rows on this file, else (unknown).
    let squad = squadFromPath(sourcePath);
    if (!squad) {
      for (const g of p.store) {
        for (const runId of g.runs.keys()) {
          if (runSquad.has(runId)) { squad = runSquad.get(runId); break; }
        }
        if (squad) break;
      }
    }
    if (!squad) squad = "(unknown)";

    if (!p.onDisk) {
      // No transcript to check against — counted under filesMissing and
      // excluded from the comparison (nothing can be proven either way).
      filesMissing++;
      continue;
    }
    filesChecked++;
    const horizon = horizons.get(sourcePath) ?? 0;
    p.scan = scanFileBeforeHorizon(sourcePath, horizon);
    if (onProgress && filesChecked % 100 === 0) {
      onProgress({ filesDone: filesChecked, filesTotal: paths.length - filesMissing });
    }
    if (!onProgress && filesChecked % 100 === 0) {
      process.stderr.write(`telemetry-usage-verify: ${filesChecked} files checked\n`);
    }

    const agg = squadAgg.get(squad) ?? { storeTokens: 0, scanTokens: 0 };
    squadAgg.set(squad, agg);

    const scanKeys = new Set(p.scan.keys());
    // scanTokens counts EVERY in-horizon scan message — matched, mismatched
    // or store-less. It is deliberately the scan side alone: a store message
    // with no counterpart before the horizon (missingInScan) then shows up
    // as store > scan in the squad diff, which is the signal we want.
    for (const vals of p.scan.values()) agg.scanTokens += tokensOf(vals);
    for (const g of p.store) {
      agg.storeTokens += tokensOf(g.max);
      const scanVals = p.scan.get(g.message_id);
      if (!scanVals) {
        // In the store but the file (up to the horizon) has no such message.
        missingInScan++;
        continue;
      }
      scanKeys.delete(g.message_id);
      let equal = true;
      for (const f of USAGE_FIELDS) if (g.max[f] !== scanVals[f]) { equal = false; break; }
      if (equal) {
        matched++;
      } else {
        mismatched++;
        if (mismatchExamples.length < MAX_EXAMPLES) {
          mismatchExamples.push({ source_path: g.source_path, message_id: g.message_id, store: g.max, scan: scanVals });
        }
      }
    }
    for (const id of scanKeys) {
      // Scan-only message (id left over after store matching): the store
      // never deduped it into a row.
      missingInStore++;
    }
  }

  const bySquad = [...squadAgg.entries()]
    .map(([squad, a]) => {
      const dp = diffPct(a.storeTokens, a.scanTokens);
      return {
        squad,
        storeTokens: a.storeTokens,
        scanTokens: a.scanTokens,
        diffPct: dp,
        pass: Number.isFinite(dp) && Math.abs(dp) <= tolerance,
      };
    })
    .sort((a, b) => a.squad < b.squad ? -1 : 1);

  const overallAgg = { storeTokens: 0, scanTokens: 0 };
  for (const a of squadAgg.values()) {
    overallAgg.storeTokens += a.storeTokens;
    overallAgg.scanTokens += a.scanTokens;
  }
  const overallDiff = diffPct(overallAgg.storeTokens, overallAgg.scanTokens);
  const overall = {
    storeTokens: overallAgg.storeTokens,
    scanTokens: overallAgg.scanTokens,
    diffPct: overallDiff,
    pass: Number.isFinite(overallDiff) && Math.abs(overallDiff) <= tolerance,
  };

  // --- legacy remainder (message_id IS NULL, per-line, still inflated) --
  const legacy = { rows: 0, tokens: 0, bySquad: [] };
  const legacyAgg = new Map();
  for (const row of db_openLegacy(dbPath)) {
    const vals = {};
    for (let i = 0; i < 4; i++) vals[USAGE_FIELDS[i]] = typeof row[STORE_COLS[i]] === "number" ? row[STORE_COLS[i]] : 0;
    legacy.rows++;
    legacy.tokens += tokensOf(vals);
    let squad = squadFromPath(row.source_path);
    if (!squad) squad = runSquad.get(row.run_id) ?? "(unknown)";
    const a = legacyAgg.get(squad) ?? { rows: 0, tokens: 0 };
    a.rows++;
    a.tokens += tokensOf(vals);
    legacyAgg.set(squad, a);
  }
  legacy.bySquad = [...legacyAgg.entries()]
    .map(([squad, a]) => ({ squad, rows: a.rows, tokens: a.tokens }))
    .sort((a, b) => a.squad < b.squad ? -1 : 1);

  const storeMessageCount = storeGroups.size;
  const scanMessageCount = [...perPath.values()].reduce((n, p) => n + (p.scan ? p.scan.size : 0), 0);

  // pass: every squad within tolerance AND every strict count zero. The
  // zero-count gates exist because a small leak can sit inside tolerance —
  // "within 1%" must not be able to hide a missing or duplicated message.
  const pass = bySquad.every((s) => s.pass)
    && mismatched === 0 && missingInStore === 0 && missingInScan === 0
    && duplicateMessageRows === 0;

  return {
    dbPath,
    tolerance,
    files: { checked: filesChecked, missing: filesMissing },
    messages: {
      store: storeMessageCount,
      scan: scanMessageCount,
      matched,
      mismatched,
      missingInStore,
      missingInScan,
      runDisagreements: runDisagreements.size,
      duplicateMessageRows,
    },
    mismatchExamples,
    duplicateExamples,
    crossFileDuplicates,
    bySquad,
    overall,
    legacy,
    pass,
  };
}

// Legacy rows are read in a second open so verifyUsage's main connection is
// already closed when the caller inspects results; same read-only guarantee.
function db_openLegacy(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT run_id, source_path, ${STORE_COLS.join(", ")}
         FROM usage_facts WHERE message_id IS NULL`,
      )
      .all();
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { db: null, json: false, tolerance: DEFAULT_TOLERANCE };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--db") args.db = argv[++i];
    else if (arg === "--json") args.json = true;
    else if (arg === "--tolerance") args.tolerance = Number(argv[++i]);
    else if (arg === "--help" || arg === "-h") args.help = true;
    else return { error: `unknown argument: ${arg}` };
  }
  if (!args.db && !args.help) return { error: "missing required --db <path>" };
  if (Number.isNaN(args.tolerance)) return { error: "--tolerance must be a number" };
  return args;
}

function fmtInt(n) {
  return Number.isFinite(n) ? n.toLocaleString("en-US") : String(n);
}

function fmtPct(dp) {
  return Number.isFinite(dp) ? `${(100 * dp).toFixed(2)}%` : "∞";
}

function printReport(report) {
  const pad = (s, w) => String(s).padEnd(w);
  console.log(`db: ${report.dbPath}   tolerance: ${(100 * report.tolerance).toFixed(2)}%`);
  console.log(`files checked ${report.files.checked} (missing ${report.files.missing})`);
  const m = report.messages;
  console.log(
    `messages store ${m.store}, scan ${m.scan} | matched ${m.matched}, mismatched ${m.mismatched}, ` +
      `missingInStore ${m.missingInStore}, missingInScan ${m.missingInScan}, runDisagreements ${m.runDisagreements}, ` +
      `duplicates ${m.duplicateMessageRows}`,
  );
  console.log("");
  console.log(
    `${pad("squad", 14)}${pad("storeTokens", 14)}${pad("scanTokens", 14)}${pad("diff%", 10)}pass`,
  );
  console.log("-".repeat(60));
  for (const s of report.bySquad) {
    console.log(
      `${pad(s.squad, 14)}${pad(fmtInt(s.storeTokens), 14)}${pad(fmtInt(s.scanTokens), 14)}${pad(fmtPct(s.diffPct), 10)}${s.pass ? "yes" : "NO"}`,
    );
  }
  console.log(
    `${pad("overall", 14)}${pad(fmtInt(report.overall.storeTokens), 14)}${pad(fmtInt(report.overall.scanTokens), 14)}${pad(fmtPct(report.overall.diffPct), 10)}${report.overall.pass ? "yes" : "NO"}`,
  );
  if (report.legacy.rows > 0) {
    console.log(`\nlegacy (message_id IS NULL, per-line, usage_legacy_inflated): ${fmtInt(report.legacy.rows)} rows, ${fmtInt(report.legacy.tokens)} tokens`);
    for (const s of report.legacy.bySquad) {
      console.log(`  ${pad(s.squad, 14)}${pad(fmtInt(s.rows), 10)}${fmtInt(s.tokens)} tokens`);
    }
  }
  // Own line, informational: printed only when non-zero so clean runs stay
  // quiet. Paths and rowsTokens in each example are parallel arrays (per row).
  if (report.crossFileDuplicates.messages > 0) {
    const cfd = report.crossFileDuplicates;
    console.log(`\ncross-file duplicates: ${fmtInt(cfd.messages)} message(s) in more than one transcript, ${fmtInt(cfd.rows)} rows, ~${fmtInt(cfd.extraTokens)} extra tokens`);
    console.log(`  same API call logged in more than one transcript (e.g. lead + subagent) — counted once per file; follow-up, not FOC-381`);
    for (const ex of cfd.examples) {
      const pairs = ex.paths.map((p, i) => `${p}=${fmtInt(ex.rowsTokens[i])}`).join(", ");
      console.log(`  ${ex.run_id} #${ex.message_id}: ${pairs}`);
    }
  }
  if (report.mismatchExamples.length > 0) {
    console.log(`\nfirst ${report.mismatchExamples.length} mismatch(es):`);
    for (const ex of report.mismatchExamples) {
      console.log(`  ${ex.source_path} #${ex.message_id}`);
      console.log(`    store ${JSON.stringify(ex.store)}`);
      console.log(`    scan  ${JSON.stringify(ex.scan)}`);
    }
  }
  console.log(`\n${report.pass ? "PASS" : "FAIL"}`);
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.error) {
    console.error(`telemetry-usage-verify: ${args.error}`);
    console.error("usage: node scripts/telemetry-usage-verify.mjs --db <path> [--json] [--tolerance 0.01]");
    return 2;
  }
  if (args.help) {
    console.log("usage: node scripts/telemetry-usage-verify.mjs --db <path> [--json] [--tolerance 0.01]");
    return 0;
  }
  let report;
  try {
    report = verifyUsage({ dbPath: args.db, tolerance: args.tolerance });
  } catch (err) {
    // Unopenable database is an environment problem, not a verification
    // verdict — exit 2 like a usage error, never 0/1.
    console.error(`telemetry-usage-verify: cannot open ${args.db}: ${err?.message ?? err}`);
    return 2;
  }
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }
  return report.pass ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const code = main();
  process.exit(code);
}