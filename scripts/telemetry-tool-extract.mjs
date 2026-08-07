#!/usr/bin/env node
// telemetry-tool-extract.mjs — extract tool_use facts from transcript JSONL files.
//
// Standalone module with one primary export: extractToolFacts(transcriptPath, runId, agentKey).
// Designed to be wired into telemetry-ingest.mjs by a follow-up commit.
//
// Zero deps except node:crypto and existing project utils. ESM (.mjs), Node 18+.

import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, dirname, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, "..");

/**
 * Deterministic hash from (source_path, source_offset, tool_index).
 * Matches the tool_fact_id scheme in the PRD schema.
 */
function hashToolFactId(sourcePath, sourceOffset, toolIndex) {
  const h = createHash("sha256");
  h.update(`${sourcePath}\0${sourceOffset}\0${toolIndex}`);
  return h.digest("hex").slice(0, 16);
}

/**
 * Stream a JSONL file line-by-line, yielding { line, byteOffset } tuples.
 * Tracks byte offset via Buffer.byteLength so source_offset is accurate
 * even for multi-byte UTF-8 characters.
 */
async function* jsonlLines(filePath) {
  const stream = createReadStream(filePath, { encoding: "utf8", highWaterMark: 65536 });
  let remainder = "";
  let byteOffset = 0;

  for await (const chunk of stream) {
    remainder += chunk;
    const lines = remainder.split(/(?<=\n)/);
    // The last element may be an incomplete line — keep it as remainder
    remainder = lines.pop() || "";

    for (const rawLine of lines) {
      const lineByteLen = Buffer.byteLength(rawLine, "utf8");
      const trimmed = rawLine.trim();
      if (!trimmed) {
        byteOffset += lineByteLen;
        continue;
      }
      yield { raw: trimmed, byteOffset };
      byteOffset += lineByteLen;
    }
  }

  // Emit the final line if there's no trailing newline
  if (remainder.trim()) {
    yield { raw: remainder.trim(), byteOffset };
  }
}

// ---------------------------------------------------------------------------
// Exported: extractToolFacts
// ---------------------------------------------------------------------------

/**
 * Extract tool_use facts from a transcript JSONL file.
 *
 * @param {string} transcriptPath  Path to the .jsonl transcript file
 * @param {string} runId           Run ID to stamp on every record
 * @param {string} agentKey        Agent key (e.g. 'lead', 'implementer', 'first-pass')
 * @returns {Promise<Array>}       Array of tool_fact records ready for SQLite insert
 */
export async function extractToolFacts(transcriptPath, runId, agentKey) {
  if (!transcriptPath || !existsSync(transcriptPath)) {
    return [];
  }

  const records = [];
  let turnIndex = 0;
  const now = new Date().toISOString();

  for await (const { raw, byteOffset } of jsonlLines(transcriptPath)) {
    let line;
    try {
      line = JSON.parse(raw);
    } catch {
      continue; // skip malformed lines
    }

    // Only process assistant messages
    if (line.type !== "assistant") continue;

    const observedAt = line.timestamp || null;
    const content = line.message?.content;
    if (!Array.isArray(content)) {
      turnIndex++;
      continue;
    }

    // Extract model from the message if available
    const model = line.message?.model || null;

    let toolIndex = 0;
    for (const block of content) {
      if (block?.type !== "tool_use") continue;
      const name = block.name;
      if (!name) continue; // skip nameless tool_use blocks

      // Serialize input, truncated to 1000 chars
      let input = "";
      try {
        input = JSON.stringify(block.input);
      } catch {
        input = "";
      }
      if (input.length > 1000) input = input.slice(0, 1000);

      records.push({
        tool_fact_id: hashToolFactId(transcriptPath, byteOffset, toolIndex),
        run_id: runId,
        agent_key: agentKey,
        model,
        observed_at: observedAt,
        tool_name_raw: name,
        tool_name_canon: null, // filled by normalization pass
        tool_input: input,
        tool_has_error: 0,     // filled by follow-up pass (checks next assistant message)
        turn_index: turnIndex,
        source_path: transcriptPath,
        source_offset: byteOffset,
        created_at: now,
      });

      toolIndex++;
    }

    turnIndex++;
  }

  return records;
}

// ---------------------------------------------------------------------------
// Exported: loadToolNormMap
// ---------------------------------------------------------------------------

/**
 * Load the tool normalization map from config/tool-norm.json.
 *
 * Returns a map { [rawName: string]: canonName } built from the JSON config.
 * Handles the mcp__* prefix rule: longest prefix match wins.
 * For unmatched names, returns null (caller decides fallback via bucketUnknownTool).
 *
 * @returns {Object}  { canonMap: { [rawName]: canonName|null }, rawToCanon: { [rawName]: canonName|null } }
 */
export function loadToolNormMap() {
  const configPath = join(root, "config", "tool-norm.json");

  // Shared identity resolve for when config is missing.
  // TODO: Once config/tool-norm.json exists, replace this with the real normalization map.
  // Until then, raw names pass through as their own canonical name (identity mapping).
  const identityResolve = (rawName) => rawName || null;

  if (!existsSync(configPath)) {
    return {
      canonMap: { resolve: identityResolve },
      rawToCanon: { resolve: identityResolve },
    };
  }

  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return {
      canonMap: { resolve: identityResolve },
      rawToCanon: { resolve: identityResolve },
    };
  }

  // Build reverse map: raw name → canonical name
  // Also collect mcp__ prefix patterns for longest-prefix matching
  const rawToCanon = {};
  const mcpPrefixes = []; // { prefix, canon }

  for (const [canon, rawNames] of Object.entries(config)) {
    if (!Array.isArray(rawNames)) continue;
    for (const raw of rawNames) {
      if (raw.startsWith("mcp__")) {
        // This is a prefix pattern (e.g. "mcp__atlas__read")
        mcpPrefixes.push({ prefix: raw, canon });
      } else {
        rawToCanon[raw] = canon;
      }
    }
  }

  // Sort MCP prefixes longest-first for longest-prefix-match
  mcpPrefixes.sort((a, b) => b.prefix.length - a.prefix.length);

  // Helper to resolve a single raw name
  function resolve(rawName) {
    // 1. Exact match first (case-insensitive)
    const lower = rawName.toLowerCase();
    for (const [raw, canon] of Object.entries(rawToCanon)) {
      if (raw.toLowerCase() === lower) return canon;
    }

    // 2. MCP prefix match (longest wins)
    for (const { prefix, canon } of mcpPrefixes) {
      if (rawName.startsWith(prefix)) return canon;
    }

    // 3. Generic mcp__ catch-all
    if (rawName.startsWith("mcp__")) return "other_mcp";

    return null;
  }

  // Build canonMap lazily — resolve on first access
  return {
    canonMap: {
      resolve(rawName) {
        if (rawName in this) return this[rawName];
        this[rawName] = resolve(rawName);
        return this[rawName];
      },
    },
    rawToCanon: {
      resolve(rawName) {
        const canon = resolve(rawName);
        if (canon) {
          if (!(rawName in this)) this[rawName] = canon;
          return this[rawName];
        }
        return null;
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Exported: bucketUnknownTool
// ---------------------------------------------------------------------------

/**
 * Bucket an unrecognized tool name into an other_* category.
 *
 * Returns `other_<first_word_lower>` where first_word is the first
 * space-or-underscore-delimited segment of the raw name.
 *
 * @param {string} rawName  The raw tool name
 * @returns {string|null}   Bucket name, or null if rawName is empty
 */
export function bucketUnknownTool(rawName) {
  if (!rawName) return null;
  const first = rawName.split(/[\s_-]/)[0];
  if (!first) return null;
  return `other_${first.toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);

  // --test mode: run in-memory smoke test
  if (args.includes("--test")) {
    const { writeFileSync, unlinkSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const testPath = join(tmpdir(), `telemetry-extract-test-${randomBytes(4).toString("hex")}.jsonl`);

    // Write a 3-line fixture: 1 user line + 2 assistant lines with tool_use blocks
    const fixture = [
      JSON.stringify({
        type: "user",
        timestamp: "2026-08-03T10:00:00.000Z",
        message: { role: "user", content: "Hello" },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-08-03T10:00:01.000Z",
        message: {
          role: "assistant",
          model: "claude-sonnet-5-20251001",
          content: [
            { type: "text", text: "Let me check." },
            { type: "tool_use", id: "call_1", name: "Read", input: { file_path: "/tmp/test.txt" } },
            { type: "tool_use", id: "call_2", name: "Grep", input: { pattern: "TODO" } },
          ],
        },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-08-03T10:00:02.000Z",
        message: {
          role: "assistant",
          model: "claude-sonnet-5-20251001",
          content: [
            { type: "tool_use", id: "call_3", name: "Bash", input: { command: "ls -la" } },
          ],
        },
      }),
    ].join("\n") + "\n";

    writeFileSync(testPath, fixture, "utf8");

    try {
      const records = await extractToolFacts(testPath, "test-run-001", "lead");

      if (records.length !== 3) {
        console.error(`FAIL: expected 3 records, got ${records.length}`);
        process.exit(1);
      }

      // Verify record structure
      const r0 = records[0];
      if (!r0.tool_fact_id || !r0.run_id || !r0.agent_key || !r0.tool_name_raw) {
        console.error("FAIL: record missing required fields", JSON.stringify(r0));
        process.exit(1);
      }

      if (r0.tool_name_raw !== "Read") {
        console.error(`FAIL: expected first tool "Read", got "${r0.tool_name_raw}"`);
        process.exit(1);
      }

      if (r0.turn_index !== 0) {
        console.error(`FAIL: expected turn_index 0, got ${r0.turn_index}`);
        process.exit(1);
      }

      if (records[1].turn_index !== 0) {
        console.error("FAIL: second tool_use in same turn should have turn_index 0");
        process.exit(1);
      }

      if (records[2].turn_index !== 1) {
        console.error("FAIL: second assistant turn should have turn_index 1");
        process.exit(1);
      }

      if (r0.model !== "claude-sonnet-5-20251001") {
        console.error(`FAIL: expected model "claude-sonnet-5-20251001", got "${r0.model}"`);
        process.exit(1);
      }

      console.log(`PASS: ${records.length} records extracted, all checks passed`);
      process.exit(0);
    } finally {
      try { unlinkSync(testPath); } catch { /* ignore */ }
    }
    return;
  }

  // CLI mode: print first 3 records as JSON
  const transcriptPath = args[0];
  if (!transcriptPath) {
    console.error("Usage: node scripts/telemetry-tool-extract.mjs <transcript.jsonl> [--test]");
    process.exit(1);
  }

  const records = await extractToolFacts(transcriptPath, "cli-test-run", "lead");
  const preview = records.slice(0, 3);
  console.log(JSON.stringify(preview, null, 2));
}

// Run if executed directly — compare resolved absolute paths
const isMain = process.argv[1] && (
  fileURLToPath(import.meta.url) === pathToFileURL(process.argv[1]).href ||
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
);
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
