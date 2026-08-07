#!/usr/bin/env node
/**
 * scripts/backfill-tool-and-delegation.mjs — one-shot backfill for tool_facts
 * and delegation_links tables.
 *
 * Processes every transcript_sources row where parse_status='parsed', extracts
 * tool_use facts via extractToolFacts() and delegation links via
 * reconstructDelegationLinks(), then writes them to the telemetry SQLite store.
 *
 * Idempotent — recordToolFact and recordDelegationLink use INSERT OR IGNORE,
 * so re-runs are safe and do not increase row counts.
 *
 * Usage:
 *   node scripts/backfill-tool-and-delegation.mjs [--limit N] [--dry] [--test] [--help]
 *
 * Flags:
 *   --limit N   Process only the first N transcripts (for testing)
 *   --dry       Report what would be done without writing
 *   --test      Self-test: process 3 real transcripts, assert no crash
 *   --help      Show this help
 */

import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { extractToolFacts } from "./telemetry-tool-extract.mjs";
import { reconstructDelegationLinks } from "./telemetry-delegation-recon.mjs";
import {
  openTelemetryDb,
  recordDelegationLink,
  recordToolFact,
  sqliteAvailable,
} from "./telemetry-store.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Determine the agent_key for a transcript path.
 *
 * For the lead transcript (no "subagents" in path), returns "_lead".
 * For subagent transcripts, scans the first few lines for attributionAgent
 * or agentId, falling back to the filename.
 */
function agentKeyFromTranscript(path) {
  const isLead = !path.includes("subagents");
  if (isLead) return "_lead";
  try {
    const content = readFileSync(path, "utf8");
    for (const line of content.split("\n").filter(Boolean)) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.attributionAgent) return parsed.attributionAgent;
        if (parsed.agentId) return `agent-${parsed.agentId}`;
      } catch { /* skip unparseable lines */ }
    }
  } catch { /* file not readable */ }
  return basename(path).replace(/\.jsonl$/, "");
}

/**
 * Add a tool_index field to each record so recordToolFact can compute a unique
 * hash. Groups records by (source_path, source_offset) and assigns 0, 1, 2, …
 * within each group.
 */
function addToolIndex(records) {
  const counters = {};
  for (const record of records) {
    const key = `${record.source_path}:${record.source_offset}`;
    counters[key] = (counters[key] || 0) + 1;
    record.tool_index = counters[key] - 1;
  }
  return records;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help")) {
    console.log(`
Usage: node scripts/backfill-tool-and-delegation.mjs [options]

Process all parsed transcripts and populate tool_facts + delegation_links.

Options:
  --limit N   Process only the first N transcripts
  --dry       Report what would be done without writing
  --test      Self-test: process 3 real transcripts, assert no crash
  --help      Show this help
`);
    process.exit(0);
  }

  const limitIndex = args.indexOf("--limit");
  const limit = limitIndex >= 0 ? parseInt(args[limitIndex + 1], 10) : null;
  const dry = args.includes("--dry");
  const selfTest = args.includes("--test");

  if (!sqliteAvailable()) {
    console.error("ERROR: node:sqlite is required (Node 22+ with --experimental-sqlite)");
    process.exit(1);
  }

  const db = openTelemetryDb();
  let transcripts;
  try {
    transcripts = db.prepare(
      "SELECT source_path, run_id, session_id FROM transcript_sources WHERE parse_status='parsed' ORDER BY source_path",
    ).all();
  } finally {
    db.close();
  }

  if (transcripts.length === 0) {
    console.log("No parsed transcripts found. Nothing to do.");
    process.exit(0);
  }

  const effectiveLimit = selfTest ? 3 : limit || transcripts.length;
  const batch = transcripts.slice(0, effectiveLimit);

  console.log(`Found ${transcripts.length} parsed transcripts, processing ${batch.length}${limit ? ` (--limit ${limit})` : ""}${dry ? " [DRY RUN]" : ""}`);

  let toolInserted = 0;
  let toolDuplicates = 0;
  let delegationInserted = 0;
  let delegationDuplicates = 0;
  let skipped = 0;

  for (let i = 0; i < batch.length; i++) {
    const { source_path, run_id, session_id } = batch[i];
    const transcriptPath = source_path;

    if (!existsSync(transcriptPath)) {
      console.error(`[warn] transcript not found on disk: ${transcriptPath}`);
      skipped++;
      continue;
    }

    const agentKey = agentKeyFromTranscript(transcriptPath);
    const isLead = !transcriptPath.includes("subagents");

    // --- Extract tool facts ---
    const toolRecords = await extractToolFacts(transcriptPath, run_id, agentKey);
    addToolIndex(toolRecords);

    if (!dry) {
      for (const record of toolRecords) {
        const result = await recordToolFact(record);
        if (result.recorded) toolInserted++;
        else toolDuplicates++;
      }
    } else {
      toolInserted += toolRecords.length;
    }

    // --- Extract delegation links (lead only) ---
    let delegationRecords = [];
    if (isLead) {
      delegationRecords = reconstructDelegationLinks({
        runId: run_id,
        parentAgent: "_lead",
        transcriptPath,
      });

      if (!dry) {
        for (const record of delegationRecords) {
          const result = await recordDelegationLink(record);
          if (result.recorded) delegationInserted++;
          else delegationDuplicates++;
        }
      } else {
        delegationInserted += delegationRecords.length;
      }
    }

    // Progress logging every 50 records (or at the end)
    if ((i + 1) % 50 === 0 || i === batch.length - 1) {
      const toolTotal = toolInserted + toolDuplicates;
      const delTotal = delegationInserted + delegationDuplicates;
      console.log(
        `Progress: ${i + 1}/${batch.length} tool_facts=${toolInserted}/${toolDuplicates} delegation_links=${delegationInserted}/${delegationDuplicates}`,
      );
    }
  }

  console.log(`\nDone. Processed ${batch.length} transcripts (${skipped} skipped).`);
  console.log(`  tool_facts:        ${toolInserted} inserted, ${toolDuplicates} duplicates`);
  console.log(`  delegation_links:  ${delegationInserted} inserted, ${delegationDuplicates} duplicates`);

  if (selfTest) {
    // Verify that some records were actually inserted
    const verifyDb = openTelemetryDb();
    try {
      const toolCount = verifyDb.prepare("SELECT COUNT(*) AS count FROM tool_facts").get().count;
      const delCount = verifyDb.prepare("SELECT COUNT(*) AS count FROM delegation_links").get().count;
      console.log(`\nSelf-test: tool_facts=${toolCount}, delegation_links=${delCount}`);
      if (toolCount === 0 && toolInserted > 0) {
        console.error("FAIL: tool_facts table is empty after insert");
        process.exit(1);
      }
      console.log("PASS: backfill self-test completed without errors");
    } finally {
      verifyDb.close();
    }
  }

  process.exit(0);
}

main().catch((error) => {
  console.error(`[backfill-tool-and-delegation] ${error.message}`);
  process.exit(1);
});
