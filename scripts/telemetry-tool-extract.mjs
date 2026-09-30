#!/usr/bin/env node
// telemetry-tool-extract.mjs — extract tool_use facts from transcript JSONL files.
//
// Standalone module with one primary export: extractToolFacts(transcriptPath, runId, agentKey).
// Wired into telemetry-ingest.mjs; rows are persisted by recordToolFact
// (telemetry-store.mjs), which also derives the FOC-220 identity digests from
// the transient full-content fields this module carries.
//
// Zero deps except node:crypto and existing project utils. ESM (.mjs), Node 18+.

import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { open as fsOpen } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, dirname, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, "..");

// FOC-547: transcript reads are chunked and yield to the event loop between
// chunks. 256 KiB keeps the synchronous work per chunk (decode + split +
// the consumer's JSON.parse of that chunk) in the low tens of milliseconds on
// the real corpus, so ingest never blocks request serving for longer than a
// single chunk.
export const TRANSCRIPT_CHUNK_BYTES = 1 << 18;

/** Yield the main thread back to the event loop (macrotask boundary). */
export function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Pacer for per-item synchronous work (FOC-547 AC2): call the returned function
 * after every item; it yields to the event loop only when the caller's current
 * un-yielded run has exceeded `softMs`. Time-based, not count-based, so the
 * bound holds whatever the per-item cost (a 10 KB tool input costs orders of
 * magnitude more than a 100 B one). The check itself is nanoseconds.
 */
export function createPacer(softMs = 40) {
  let last = performance.now();
  return async () => {
    if (performance.now() - last < softMs) return;
    last = performance.now();
    await yieldToEventLoop();
  };
}

// ---------------------------------------------------------------------------
// Exported: jsonlChunksFrom / jsonlLinesFrom
// ---------------------------------------------------------------------------

/**
 * Stream a JSONL file in chunks, starting at `startOffset` (default 0).
 *
 * Yields one object per chunk: { lines, endOffset, atEof, tail? } where `lines`
 * is an array of { raw, offset } (raw = trimmed line text, offset = the line's
 * absolute START byte offset) and endOffset is the byte offset after the last
 * complete line in the chunk — the resume point for the next incremental pass.
 *
 * The unterminated tail (no trailing newline) is still yielded in `lines` —
 * full-parse callers want the final line of such a file — but it is EXCLUDED
 * from endOffset and reported as `tail: { offset, end } | null`, because the
 * same bytes are exactly a live writer caught mid-append: resuming past a torn
 * write loses the line that completes it (FOC-597). Consumers commit the tail
 * (its `end`) only once it parses as a whole record; otherwise the next pass
 * resumes at `tail.offset`.
 *
 * Offsets are byte-accurate and identical to what a full-file line split would
 * produce (Buffer.byteLength of each raw part, newline included), so events
 * and tool facts derived from an incremental pass carry the same
 * (source_path, source_offset) keys as a full parse — the dedup natural keys
 * stay valid (FOC-547 AC7).
 *
 * StringDecoder reassembles multi-byte UTF-8 characters split across chunk
 * boundaries; "\n" can never appear inside a multi-byte sequence, so line
 * splits are never corrupted by the chunking.
 *
 * @param {string} filePath
 * @param {number} [startOffset]  Byte offset to resume from (line boundary)
 * @param {{ chunkBytes?: number }} [opts]
 */
export async function* jsonlChunksFrom(filePath, startOffset = 0, opts = {}) {
  const chunkBytes = opts.chunkBytes || TRANSCRIPT_CHUNK_BYTES;
  // A chunk that completes no line (a single line larger than the chunk — up
  // to 3.7 MB measured in the real corpus) used to keep reading without a
  // single event-loop turn, and re-split the ACCUMULATED text with
  // text.split(/(?<=\n)/) on every read — O(n²) in the line length (measured
  // 38.6 s of pure regex time across one backfill, FOC-547). This rewrite
  // scans only unscanned text (indexOf) and compacts the consumed prefix
  // instead of re-deriving it, and HEARTBEAT_BYTES bounds how long the reader
  // runs without handing the loop a turn: consumers see a `{ lines: [] }`
  // heartbeat chunk, which every caller skips harmlessly.
  const HEARTBEAT_BYTES = 1 << 23; // 8 MiB
  const COMPACT_THRESHOLD = 1 << 20; // 1 MiB of consumed prefix before slicing
  let handle = null;
  try {
    handle = await fsOpen(filePath, "r");
    const size = (await handle.stat()).size;
    let position = Math.min(Math.max(startOffset, 0), size);
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.alloc(chunkBytes);
    let text = "";
    let textStart = position; // byte offset of text[0]
    let lineStart = 0;        // char index in text where the next line starts
    let scanned = 0;          // char index in text already scanned for "\n"
    let consumedBytes = 0;    // bytes before lineStart, relative to textStart
    let bytesSinceYield = 0;
    while (position < size || text.length > 0) {
      if (position < size) {
        const length = Math.min(chunkBytes, size - position);
        const { bytesRead } = await handle.read(buffer, 0, length, position);
        if (bytesRead <= 0) break;
        position += bytesRead;
        bytesSinceYield += bytesRead;
        text += decoder.write(buffer.subarray(0, bytesRead));
      }
      const lines = [];
      let nl;
      while ((nl = text.indexOf("\n", scanned)) !== -1) {
        const part = text.slice(lineStart, nl);
        if (part.trim()) lines.push({ raw: part.trim(), offset: textStart + consumedBytes });
        consumedBytes += Buffer.byteLength(text.slice(lineStart, nl + 1), "utf8");
        lineStart = nl + 1;
        scanned = nl + 1;
      }
      if (position >= size) {
        // End of file. The tail is the final line (files may lack a trailing
        // newline) — but it is also exactly the shape of a live writer caught
        // mid-append, so it is yielded in `lines` (full-parse parity) yet left
        // OUT of endOffset and reported as `tail` (FOC-597): resuming past a
        // torn write loses the line that completes it. Empty tail = the file
        // ended with a newline.
        text += decoder.end(); // flush a split multi-byte char instead of dropping its bytes (FOC-597)
        const tailOffset = textStart + consumedBytes;
        const tail = text.slice(lineStart);
        if (tail.trim()) lines.push({ raw: tail.trim(), offset: tailOffset });
        yield {
          lines,
          endOffset: tailOffset,
          atEof: true,
          tail: tailOffset < size ? { offset: tailOffset, end: size } : null,
        };
        return;
      }
      if (lines.length > 0) {
        yield { lines, endOffset: textStart + consumedBytes, atEof: false };
        bytesSinceYield = 0;
        if (lineStart >= COMPACT_THRESHOLD) {
          // Drop the consumed prefix (only when it is worth the copy); the
          // index bookkeeping keeps the byte offsets exact.
          text = text.slice(lineStart);
          textStart += consumedBytes;
          scanned -= lineStart;
          lineStart = 0;
          consumedBytes = 0;
        }
        // One event-loop turn per chunk — ingest work and request serving
        // interleave instead of the loop starving (FOC-547 AC1/AC2).
        await yieldToEventLoop();
      } else if (bytesSinceYield >= HEARTBEAT_BYTES) {
        yield { lines: [], endOffset: textStart + consumedBytes, atEof: false };
        bytesSinceYield = 0;
        await yieldToEventLoop();
      }
    }
    yield { lines: [], endOffset: textStart + consumedBytes, atEof: true };
  } finally {
    if (handle) {
      try { await handle.close(); } catch { /* best-effort close */ }
    }
  }
}

/** Per-line convenience wrapper over jsonlChunksFrom (same { raw, offset }). */
export async function* jsonlLinesFrom(filePath, startOffset = 0, opts = {}) {
  for await (const chunk of jsonlChunksFrom(filePath, startOffset, opts)) {
    for (const line of chunk.lines) yield line;
  }
}

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
 * Caller-held link state for incremental extraction (FOC-547).
 *
 * `results` carries tool_result outcomes across passes so a result arriving in
 * a later chunk can still resolve the tool_use recorded by an earlier pass
 * (results always arrive AFTER their tool_use line — see extractToolFacts).
 * `uses` tracks pending tool_use facts (by tool_use_id) whose outcome is not
 * known yet, so the caller can upgrade them the moment their result appears.
 * `turnIndex` carries the running assistant-turn counter so turn_index stays
 * file-global instead of restarting at 0 on every incremental pass.
 */
export function createToolLinkState() {
  return { results: new Map(), uses: new Map(), turnIndex: 0 };
}

// ---------------------------------------------------------------------------
// Exported: extractToolFacts
// ---------------------------------------------------------------------------

/**
 * Model-visible text of a tool_result block's content. Content is a string, an
 * array of typed parts (text parts use their text, anything else is serialized
 * so its presence still counts toward the size), or absent. Used for the result
 * SIZE measurement and — in recordToolFact — for the salted result digest; the
 * text itself is never persisted (FOC-220).
 */
function toolResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part.text === "string" ? part.text : JSON.stringify(part ?? null)))
      .join("\n");
  }
  if (content == null) return "";
  try { return JSON.stringify(content); } catch { return ""; }
}

/**
 * Extract tool_use facts from a transcript JSONL file.
 *
 * The returned records carry three TRANSIENT fields (tool_input_full,
 * tool_result_full) holding the complete, untruncated input serialization and
 * the result text. They exist so recordToolFact can derive the salted identity
 * digests at the single write point; they are never persisted and must not be
 * logged. All other fields map 1:1 onto the tool_facts columns.
 *
 * FOC-547 incremental mode: pass `startOffset` to scan only the range from
 * that byte offset, and `linkState` (createToolLinkState()) to carry
 * tool_result outcomes across passes. With linkState, an unresolved tool_use
 * keeps its `_toolUseId` and a NULL outcome — NOT a final 'missing' — so the
 * caller can register it as pending; the ingest layer finalizes genuinely
 * missing outcomes once the file has stopped growing (telemetry-ingest.mjs).
 * Without linkState the behavior is the original end-of-file semantics: a
 * tool_result that never appears yields state 'missing'.
 *
 * @param {string} transcriptPath  Path to the .jsonl transcript file
 * @param {string} runId           Run ID to stamp on every record
 * @param {string} agentKey        Agent key (e.g. 'lead', 'implementer', 'first-pass')
 * @param {{ startOffset?: number, linkState?: object }} [opts]
 * @returns {Promise<Array>}       Array of tool_fact records ready for SQLite insert
 */
export async function extractToolFacts(transcriptPath, runId, agentKey, opts = {}) {
  if (!transcriptPath || !existsSync(transcriptPath)) {
    return [];
  }
  const startOffset = Number.isInteger(opts.startOffset) && opts.startOffset > 0 ? opts.startOffset : 0;
  const linkState = opts.linkState || null;

  const records = [];
  // tool_use_id → how that call came back. Filled from tool_result blocks,
  // which is why it cannot be resolved inside the loop (below).
  const resultByToolUseId = new Map();
  // Outcomes recorded by EARLIER passes are still live in incremental mode.
  if (linkState) {
    for (const [id, result] of linkState.results) resultByToolUseId.set(id, result);
  }
  let turnIndex = linkState ? linkState.turnIndex : 0;
  const now = new Date().toISOString();

  // FOC-547 (AC2): per-line work (JSON.parse, result-size scans, input
  // serializations) is synchronous; the time-based pacer keeps the loop's
  // un-yielded runs below the block bar whatever the line sizes are.
  const pacer = createPacer();
  for await (const { raw, offset: byteOffset } of jsonlLinesFrom(transcriptPath, startOffset)) {
    await pacer();
    if (!raw) continue;
    let line;
    try {
      line = JSON.parse(raw);
    } catch {
      continue; // skip malformed lines
    }

    const content = line.message?.content;

    // A tool_result carries the OUTCOME of a tool_use recorded earlier in the
    // file. Claude Code writes it as a `user` line, so it always arrives AFTER
    // the record it describes — collect outcomes by id here and apply them once
    // the whole file is read (records are buffered in memory anyway).
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === "tool_result" && block.tool_use_id) {
          const text = toolResultText(block.content);
          const result = {
            isError: block.is_error === true,
            bytes: Buffer.byteLength(text, "utf8"),
            text,
          };
          resultByToolUseId.set(block.tool_use_id, result);
          // Carry the outcome forward for later passes (incremental mode).
          if (linkState) linkState.results.set(block.tool_use_id, result);
        }
      }
    }

    // Only process assistant messages
    if (line.type !== "assistant") continue;

    const observedAt = line.timestamp || null;
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

      // Serialize the COMPLETE input first (identity source, FOC-220), then cut
      // the display preview down to 1000 chars. The full string is carried
      // transiently in tool_input_full so recordToolFact digests the untruncated
      // input; it is never persisted.
      let inputFull = "";
      try {
        inputFull = JSON.stringify(block.input ?? null);
      } catch {
        inputFull = "";
      }
      const input = inputFull.length > 1000 ? inputFull.slice(0, 1000) : inputFull;

      records.push({
        tool_fact_id: hashToolFactId(transcriptPath, byteOffset, toolIndex),
        run_id: runId,
        agent_key: agentKey,
        model,
        observed_at: observedAt,
        tool_name_raw: name,
        tool_name_canon: null, // resolved after the loop — needs the config map
        tool_input: input,
        tool_input_full: inputFull,
        tool_has_error: 0,     // resolved after the loop — needs the tool_result
        // FOC-220: position of this tool_use within its assistant message —
        // the input to tool_fact_id's sha1, now also stored as a column.
        tool_index: toolIndex,
        // Resolved after the loop from the matching tool_result block.
        tool_result_state: null,
        tool_result_bytes: null,
        tool_result_full: null,
        turn_index: turnIndex,
        source_path: transcriptPath,
        source_offset: byteOffset,
        created_at: now,
        // Not a column — the join key to resultByToolUseId, dropped below.
        _toolUseId: block.id || null,
      });

      toolIndex++;
    }

    turnIndex++;
  }

  if (linkState) linkState.turnIndex = turnIndex;

  // Three things could not be filled during the streaming pass: the canonical
  // category (needs config/tool-norm.json) and the outcome fields (need the
  // tool_result that appears later in the file). Resolve them here, and drop
  // the temporary join key so the record matches the tool_facts columns.
  //
  // A tool_use whose tool_result never appears in the file gets state
  // 'missing' — NOT ok, NOT error. Under the old scheme that case was
  // indistinguishable from success (tool_has_error stayed 0). In incremental
  // mode (linkState) the outcome stays UNKNOWN instead — the caller owns the
  // 'missing' finalization, which must only happen once the file has stopped
  // growing (a later chunk may still deliver the result).
  const { rawToCanon } = normMap();
  for (const record of records) {
    record.tool_name_canon =
      rawToCanon.resolve(record.tool_name_raw) || bucketUnknownTool(record.tool_name_raw);
    const result = record._toolUseId ? resultByToolUseId.get(record._toolUseId) : undefined;
    if (result) {
      record.tool_has_error = result.isError ? 1 : 0;
      record.tool_result_state = result.isError ? "error" : "ok";
      record.tool_result_bytes = result.bytes;
      record.tool_result_full = result.text;
      if (linkState) linkState.results.delete(record._toolUseId);
      delete record._toolUseId;
    } else if (linkState) {
      // Outcome not yet known — leave it to the caller (pending registration).
      record.tool_has_error = null;
      record.tool_result_state = null;
      record.tool_result_bytes = null;
      record.tool_result_full = null;
    } else {
      record.tool_has_error = 0;
      record.tool_result_state = "missing";
      record.tool_result_bytes = null;
      record.tool_result_full = null;
      delete record._toolUseId;
    }
  }

  return records;
}

// loadToolNormMap() reads and parses a file; extractToolFacts runs once per
// transcript (900+ on a full backfill), so the map is read once per process.
let normMapCache = null;
function normMap() {
  if (!normMapCache) normMapCache = loadToolNormMap();
  return normMapCache;
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
  // Strip the transient full-content fields before printing: they exist only so
  // recordToolFact can derive digests, and a preview CLI must not dump tool
  // arguments or result bodies to stdout.
  const preview = records.slice(0, 3).map(({ tool_input_full, tool_result_full, ...rest }) => rest);
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
