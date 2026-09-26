#!/usr/bin/env node
// Independent reference measurement for the per-message usage dedup (FOC-381).
//
// Why this exists: Claude Code writes ONE assistant message to its transcript
// (.jsonl) as SEVERAL lines — separate lines for thinking, text and tool_use
// blocks — and each of those lines carries the same `message.usage` object (or
// zeros). Summing usage over lines therefore over-counts tokens ~2-3x. Ingest
// will dedup at the message level; to verify that fix we need a measurement
// that shares NO code with scripts/telemetry-ingest.mjs — this module is that
// independent check. It re-reads the raw transcripts directly and computes,
// per squad, the naive line-sum versus the per-message total.
//
// Method:
//   - Input: every *.jsonl under <root>/<squad>/projects/** where <root> is an
//     `agents` directory and <squad> is the directory name directly under it.
//   - Only lines that parse as JSON with type === "assistant" and a
//     message.usage object are considered.
//   - Counters: input_tokens, output_tokens, cache_read_input_tokens,
//     cache_creation_input_tokens (missing -> 0). Tokens = sum of the four.
//   - Naive   = sum of each counter over all such lines.
//   - Per-message = group lines by message.id WITHIN ONE FILE; for each group
//     take the MAXIMUM of each counter across its lines (duplicate lines carry
//     an identical copy or zeros, so max is the real total). Lines with no
//     message.id each count as their own message.
//   - Per squad: files, lines, messages, linesPerMessage, naive vs per-message
//     totals per counter, naiveTokens, perMessageTokens,
//     factor = naiveTokens / perMessageTokens, and the share of fleet tokens
//     raw (naive) and corrected (per-message).
//
// CLI: node scripts/telemetry-message-scan.mjs [--root <agentsDir>] [--json]
//   Default root is the `agents` directory of the repo this script lives in;
//   LA_TRANSCRIPT_ROOT overrides that default, --root overrides everything.
// Files are streamed line by line (some transcripts are tens of MB).
// Unparseable lines are skipped and counted (parseErrors); unreadable files
// are skipped and counted (unreadableFiles). Read-only: never writes anywhere.

import { createReadStream, existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const COUNTERS = [
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
];

function blankTally() {
  return { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
}

function addInto(target, src) {
  for (const c of COUNTERS) target[c] += src[c];
  return target;
}

function tokensOf(tally) {
  let sum = 0;
  for (const c of COUNTERS) sum += tally[c];
  return sum;
}

function blankStats() {
  return {
    files: 0,
    unreadableFiles: 0,
    parseErrors: 0,
    lines: 0,
    messages: 0,
    noIdLines: 0,
    naive: blankTally(),
    perMessage: blankTally(),
    naiveTokens: 0,
    perMessageTokens: 0,
    factor: 1,
    shareRaw: 0,
    shareCorrected: 0,
  };
}

// Extract the four counters from an assistant line. Returns null when the line
// is not a qualifying assistant line (wrong type, no message, no usage object).
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
  for (const c of COUNTERS) {
    vals[c] = typeof usage[c] === "number" && Number.isFinite(usage[c]) ? usage[c] : 0;
  }
  return { vals, id: typeof msg.id === "string" && msg.id ? msg.id : null };
}

// Scan one file: returns { lines, noIdLines, parseErrors, naive, perMessage }
// where naive is the line-sum and perMessage the max-per-counter of every
// message.id group in the file plus one entry per no-id line.
async function scanFile(filePath) {
  const groups = new Map(); // message.id -> per-counter max
  const out = { lines: 0, noIdLines: 0, parseErrors: 0, naive: blankTally(), perMessage: blankTally() };
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line) continue;
      const parsed = usageOf(line);
      if (!parsed) continue;
      if (parsed.parseError) { out.parseErrors++; continue; }
      out.lines++;
      const { vals, id } = parsed;
      addInto(out.naive, vals);
      if (id) {
        const cur = groups.get(id);
        if (!cur) groups.set(id, vals);
        else for (const c of COUNTERS) if (vals[c] > cur[c]) cur[c] = vals[c];
      } else {
        // No message.id: each such line is its own message.
        out.noIdLines++;
        addInto(out.perMessage, vals);
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  for (const vals of groups.values()) addInto(out.perMessage, vals);
  out.messages = groups.size + out.noIdLines;
  return out;
}

async function listTranscripts(agentsRoot, squad) {
  const projectsDir = join(agentsRoot, squad, "projects");
  if (!existsSync(projectsDir)) return [];
  const entries = await readdir(projectsDir, { withFileTypes: true, recursive: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    // Dirent.parentPath (Node >=20.12) is the directory the entry was found in.
    const dir = typeof entry.parentPath === "string" ? entry.parentPath : projectsDir;
    files.push(join(dir, entry.name));
  }
  files.sort();
  return files;
}

/**
 * Scan the raw Claude Code transcripts under an `agents` directory and compute
 * the naive line-sum vs the per-message total of token usage, per squad and
// fleet-wide. See the module header for the method. Read-only.
 *
 * @param {string} agentsRoot  e.g. <repo>/agents
 * @param {{ squads?: string[] | null }} [opts]  restrict to these squad names
 */
export async function scanTranscripts(agentsRoot, { squads = null } = {}) {
  let squadNames = (await readdir(agentsRoot, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  if (squads) {
    const wanted = new Set(squads);
    squadNames = squadNames.filter((s) => wanted.has(s));
  }

  const squadResults = {};
  for (const squad of squadNames) {
    const stats = blankStats();
    const files = await listTranscripts(agentsRoot, squad);
    stats.files = files.length;
    for (const filePath of files) {
      let fileStats;
      try {
        fileStats = await scanFile(filePath);
      } catch {
        // Unreadable (permissions, vanished mid-scan, ...): skip and count.
        stats.unreadableFiles++;
        continue;
      }
      stats.parseErrors += fileStats.parseErrors;
      stats.lines += fileStats.lines;
      stats.noIdLines += fileStats.noIdLines;
      stats.messages += fileStats.messages;
      addInto(stats.naive, fileStats.naive);
      addInto(stats.perMessage, fileStats.perMessage);
    }
    finishStats(stats);
    squadResults[squad] = stats;
  }

  const totals = blankStats();
  for (const stats of Object.values(squadResults)) {
    totals.files += stats.files;
    totals.unreadableFiles += stats.unreadableFiles;
    totals.parseErrors += stats.parseErrors;
    totals.lines += stats.lines;
    totals.messages += stats.messages;
    totals.noIdLines += stats.noIdLines;
    addInto(totals.naive, stats.naive);
    addInto(totals.perMessage, stats.perMessage);
  }
  finishStats(totals);

  for (const stats of Object.values(squadResults)) {
    stats.shareRaw = totals.naiveTokens > 0 ? stats.naiveTokens / totals.naiveTokens : 0;
    stats.shareCorrected = totals.perMessageTokens > 0 ? stats.perMessageTokens / totals.perMessageTokens : 0;
  }
  totals.shareRaw = 1;
  totals.shareCorrected = 1;

  return { root: agentsRoot, squads: squadResults, totals };
}

function finishStats(stats) {
  stats.naiveTokens = tokensOf(stats.naive);
  stats.perMessageTokens = tokensOf(stats.perMessage);
  stats.factor = stats.perMessageTokens > 0 ? stats.naiveTokens / stats.perMessageTokens : 1;
  stats.linesPerMessage = stats.messages > 0 ? stats.lines / stats.messages : 0;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function defaultRoot() {
  if (process.env.LA_TRANSCRIPT_ROOT) return process.env.LA_TRANSCRIPT_ROOT;
  // The repo this script lives in: <repo>/scripts/*.mjs -> <repo>/agents
  return join(dirname(fileURLToPath(import.meta.url)), "..", "agents");
}

function parseArgs(argv) {
  const args = { root: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--root") args.root = argv[++i];
    else if (arg === "--json") args.json = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
  }
  return args;
}

function fmtInt(n) {
  return n.toLocaleString("en-US");
}

function printReport(result) {
  const rows = Object.entries(result.squads)
    .sort((a, b) => b[1].perMessageTokens - a[1].perMessageTokens || (a[0] < b[0] ? -1 : 1));
  const widths = { squad: 13, linesPerMsg: 10, factor: 8, share: 21 };
  const pad = (s, w) => s.padEnd(w);
  const header = `${pad("squad", widths.squad)}${pad("lines/msg", widths.linesPerMsg)}${pad("factor", widths.factor)}share raw -> corrected`;
  console.log(header);
  console.log("-".repeat(header.length));
  const row = (name, s) => {
    const linesPerMsg = s.messages > 0 ? s.lines / s.messages : 0;
    const share = `${(100 * s.shareRaw).toFixed(1)}% -> ${(100 * s.shareCorrected).toFixed(1)}%`;
    console.log(
      `${pad(name, widths.squad)}${pad(linesPerMsg.toFixed(2), widths.linesPerMsg)}${pad(s.factor.toFixed(2) + "x", widths.factor)}${share}`,
    );
  };
  for (const [squad, s] of rows) row(squad, s);
  row("TOTAL", result.totals);
  const t = result.totals;
  console.log(
    `\nfiles ${fmtInt(t.files)} (unreadable ${fmtInt(t.unreadableFiles)}), lines ${fmtInt(t.lines)}, ` +
      `messages ${fmtInt(t.messages)} (no-id lines ${fmtInt(t.noIdLines)}), parse errors ${fmtInt(t.parseErrors)}`,
  );
  console.log(
    `naive tokens ${fmtInt(t.naiveTokens)} -> per-message tokens ${fmtInt(t.perMessageTokens)}` +
      ` (over-count ${t.factor.toFixed(2)}x)`,
  );
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log("usage: node scripts/telemetry-message-scan.mjs [--root <agentsDir>] [--json]");
    console.log("  default root: $LA_TRANSCRIPT_ROOT, else the repo's agents/ directory");
    return 0;
  }
  const root = args.root ?? defaultRoot();
  if (!existsSync(root)) {
    console.error(`transcript root not found: ${root}`);
    return 2;
  }
  const result = await scanTranscripts(root);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`transcript root: ${result.root}`);
    printReport(result);
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err?.stack || err?.message || String(err));
      process.exit(1);
    },
  );
}
