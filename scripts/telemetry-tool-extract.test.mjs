// Contract test for telemetry-tool-extract (FOC-220).
//
// The extractor feeds the only write path (recordToolFact), so the identity
// assertions here run end-to-end: extract → recordToolFact → read the row back.
// What is pinned, and why it can fail loudly:
//   - a MISSING tool_result is 'missing' — the old scheme was unable to tell it
//     apart from success, which is exactly the lie FOC-220 removes;
//   - an EMPTY result is present-and-empty (bytes 0), distinct from missing (NULL);
//   - unknown tool names are bucketed, and bucketing never corrupts the outcome;
//   - identity is taken over the COMPLETE input (never the 1000-char preview),
//     key-order independent at every depth, keyed by a per-store salt.
//
// The extract-only checks run everywhere; the identity checks need node:sqlite
// and are reported as SKIP when the build lacks it (never counted as a pass).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractToolFacts } from "./telemetry-tool-extract.mjs";
import { openTelemetryDb, recordToolFact } from "./telemetry-store.mjs";

let DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) { passed++; return; }
  failed++;
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

class TestSkip extends Error {}

const temp = mkdtempSync(join(tmpdir(), "foc-220-extract-"));

function writeJsonl(name, lines) {
  const path = join(temp, name);
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
  return path;
}

const assistant = (timestamp, blocks) => ({
  type: "assistant", timestamp,
  message: { role: "assistant", model: "test-model", content: blocks },
});
const userResults = (timestamp, results) => ({
  type: "user", timestamp,
  message: { role: "user", content: results.map((r) => ({ type: "tool_result", ...r })) },
});
const toolUse = (id, name, input) => ({ type: "tool_use", id, name, input });

// --- one fixture covering the outcome matrix -------------------------------
// m1: errored result with content; m2: empty ok result; m3: never answered
// (missing); m4: unknown tool name with a normal ok result; two tool_use
// blocks in one message pin tool_index.
const outcomeFixture = writeJsonl("outcomes.jsonl", [
  assistant("2026-09-12T10:00:00.000Z", [
    toolUse("m1", "Bash", { command: "ls -la" }),
    toolUse("m2", "Grep", { pattern: "TODO" }),
  ]),
  userResults("2026-09-12T10:00:05.000Z", [
    { tool_use_id: "m1", is_error: true, content: "boom: exit 1" },
    { tool_use_id: "m2", content: "" },
  ]),
  assistant("2026-09-12T10:00:10.000Z", [
    toolUse("m3", "Read", { file_path: "/tmp/a.txt" }),
  ]),
  userResults("2026-09-12T10:00:15.000Z", [
    { tool_use_id: "m9", content: "answer to a call that is not in this file" },
  ]),
  assistant("2026-09-12T10:00:20.000Z", [
    toolUse("m4", "Frobnicate", { widget: "x" }),
  ]),
  userResults("2026-09-12T10:00:25.000Z", [
    { tool_use_id: "m4", content: "frobnicated fine" },
  ]),
]);

const outcomes = await extractToolFacts(outcomeFixture, "run-extract", "lead");
const byRaw = Object.fromEntries(outcomes.map((r) => [r.tool_name_raw, r]));

check("all four tool_use blocks extracted", outcomes.length === 4, `got ${outcomes.length}`);

check("errored call: state error and tool_has_error 1",
  byRaw.Bash.tool_result_state === "error" && byRaw.Bash.tool_has_error === 1,
  `state=${byRaw.Bash.tool_result_state} has_error=${byRaw.Bash.tool_has_error}`);
check("errored call: bytes measured, never NULL when a result exists",
  byRaw.Bash.tool_result_bytes === Buffer.byteLength("boom: exit 1"), `bytes=${byRaw.Bash.tool_result_bytes}`);

check("empty result: present-and-empty (bytes 0, state ok) — NOT missing",
  byRaw.Grep.tool_result_state === "ok" && byRaw.Grep.tool_result_bytes === 0 && byRaw.Grep.tool_has_error === 0,
  `state=${byRaw.Grep.tool_result_state} bytes=${byRaw.Grep.tool_result_bytes}`);

check("missing result: state missing, never error and never ok",
  byRaw.Read.tool_result_state === "missing" && byRaw.Read.tool_has_error === 0,
  `state=${byRaw.Read.tool_result_state} has_error=${byRaw.Read.tool_has_error}`);
check("missing result: bytes stay NULL (unknown, not measured zero)",
  byRaw.Read.tool_result_bytes === null && byRaw.Read.tool_result_full === null,
  `bytes=${byRaw.Read.tool_result_bytes}`);

check("unknown tool name is bucketed other_*",
  byRaw.Frobnicate.tool_name_canon === "other_frobnicate", `canon=${byRaw.Frobnicate.tool_name_canon}`);
check("unknown name does not corrupt the outcome",
  byRaw.Frobnicate.tool_result_state === "ok" && byRaw.Frobnicate.tool_has_error === 0,
  `state=${byRaw.Frobnicate.tool_result_state}`);

check("tool_index is the position within its assistant message",
  byRaw.Bash.tool_index === 0 && byRaw.Grep.tool_index === 1,
  `bash=${byRaw.Bash.tool_index} grep=${byRaw.Grep.tool_index}`);

check("normal ok path: positive bytes",
  byRaw.Frobnicate.tool_result_bytes === Buffer.byteLength("frobnicated fine"),
  `bytes=${byRaw.Frobnicate.tool_result_bytes}`);

check("a tool_result for an unknown tool_use_id flags nothing",
  outcomes.every((r) => r.tool_has_error === (r.tool_name_raw === "Bash" ? 1 : 0)),
  outcomes.map((r) => `${r.tool_name_raw}:${r.tool_has_error}`).join(","));

// --- long inputs: full vs preview ------------------------------------------
const longA = "/data/" + "x".repeat(1100) + "-tail-A";
const longB = "/data/" + "x".repeat(1100) + "-tail-B";
const longFixture = writeJsonl("long.jsonl", [
  assistant("2026-09-12T11:00:00.000Z", [toolUse("l1", "Read", { file_path: longA })]),
  assistant("2026-09-12T11:00:10.000Z", [toolUse("l2", "Read", { file_path: longB })]),
]);
const longRecords = await extractToolFacts(longFixture, "run-extract", "lead");
check("preview is capped at 1000 chars",
  longRecords.every((r) => r.tool_input.length === 1000),
  longRecords.map((r) => r.tool_input.length).join(","));
check("tool_input_full keeps the COMPLETE input",
  longRecords[0].tool_input_full === JSON.stringify({ file_path: longA }) &&
  longRecords[1].tool_input_full === JSON.stringify({ file_path: longB }),
  "full serialization must survive the display truncation");
check("the two long previews are identical — the old collision, by construction",
  longRecords[0].tool_input === longRecords[1].tool_input,
  "fixture broken: the previews must share the 1000-char prefix for this test to mean anything");

// --- identity end-to-end (needs node:sqlite) --------------------------------
if (DatabaseSync) {
  try {
    const dbPath = join(temp, "telemetry.sqlite");
    const db = openTelemetryDb(dbPath);
    db.prepare("INSERT INTO runs (run_id, squad, status, updated_at) VALUES ('run-extract','dev','completed','2026-09-12T00:00:00.000Z')").run();

    // Reordered nested args, from REAL extracted records (not hand-made rows),
    // so the extractor→store handoff of tool_input_full is exercised too.
    const reorderFixture = writeJsonl("reorder.jsonl", [
      assistant("2026-09-12T12:00:00.000Z", [toolUse("r1", "Read", {
        file_path: "/f", opts: { z: 1, a: { k: 2, j: 3 } },
      })]),
      assistant("2026-09-12T12:00:10.000Z", [toolUse("r2", "Read", {
        opts: { a: { j: 3, k: 2 }, z: 1 }, file_path: "/f",
      })]),
    ]);
    for (const record of await extractToolFacts(reorderFixture, "run-extract", "lead")) {
      const result = await recordToolFact(record, { dbPath });
      if (!result.recorded) throw new Error(`recordToolFact not recorded: ${JSON.stringify(result)}`);
    }
    const reorderRows = db.prepare("SELECT tool_input_id, tool_input FROM tool_facts WHERE tool_input LIKE '%\"file_path\":\"/f\"%' OR tool_input LIKE '%\"opts\"%'").all();
    check("both reordered-arg rows stored", reorderRows.length === 2, `got ${reorderRows.length}`);
    check("reordered nested args produce the SAME identity (any depth)",
      reorderRows.length === 2 && reorderRows[0].tool_input_id === reorderRows[1].tool_input_id,
      `ids=${reorderRows.map((r) => r.tool_input_id).join(",")}`);

    for (const [i, record] of longRecords.entries()) {
      await recordToolFact({ ...record, source_offset: 5000 + i * 10 }, { dbPath });
    }
    const longRows = db.prepare("SELECT tool_input_id, tool_input FROM tool_facts WHERE source_offset >= 5000 ORDER BY source_offset").all();
    check("long-prefix previews stored identically — identity must still differ",
      longRows.length === 2 && longRows[0].tool_input === longRows[1].tool_input && longRows[0].tool_input_id !== longRows[1].tool_input_id,
      `ids equal: ${longRows[0]?.tool_input_id === longRows[1]?.tool_input_id}`);

    // Missing-result row through the store: state 'missing', never fabricated ok.
    const missingRow = db.prepare("SELECT tool_result_state, tool_result_bytes FROM tool_facts WHERE source_offset >= 5000 ORDER BY source_offset").get();
    check("store keeps 'missing' as missing",
      missingRow.tool_result_state === "missing" && missingRow.tool_result_bytes === null,
      `state=${missingRow.tool_result_state}`);

    db.close();
  } catch (error) {
    failed++;
    failures.push(`identity end-to-end — ${error.message}`);
  }
} else {
  skipped += 5;
  console.log("  SKIP identity end-to-end: node:sqlite unavailable");
}

// --- FOC-547: jsonlChunksFrom — offsets, giant-line heartbeats, resume ------
// The chunker feeds every incremental ingest pass, so three properties are
// pinned here:
//   1. byte-accurate parity with a full-file line split, at chunk sizes both
//      larger and far smaller than the lines (multi-byte UTF-8 included);
//   2. a single line larger than the whole chunk stream cannot hold the event
//      loop: the reader emits `{ lines: [] }` heartbeat chunks so callers
//      interleave (pre-fix it read and re-split the accumulated text without a
//      single yield — measured 38.6 s of regex time across one backfill);
//   3. a resumed pass (start at a previous chunk's endOffset) emits exactly the
//      same (raw, offset) keys as a full parse — the dedup natural keys stay
//      valid across incremental runs (FOC-547 AC7).
{
  const { jsonlChunksFrom } = await import("./telemetry-tool-extract.mjs");
  const { openSync, readSync, closeSync, statSync } = await import("node:fs");

  // Reference: full-file byte-accurate line offsets.
  function fullSplitOffsets(path) {
    const size = statSync(path).size;
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(size);
    readSync(fd, buf, 0, size, 0);
    closeSync(fd);
    const lines = [];
    let start = 0;
    for (let i = 0; i <= buf.length; i++) {
      if (i === buf.length || buf[i] === 0x0a) {
        const raw = buf.toString("utf8", start, i).trim();
        if (raw) lines.push({ raw, offset: start });
        start = i + 1;
      }
    }
    return lines;
  }

  async function collect(path, startOffset = 0, opts = {}) {
    const out = [];
    let heartbeats = 0;
    for await (const chunk of jsonlChunksFrom(path, startOffset, opts)) {
      if (chunk.lines.length === 0) heartbeats++;
      out.push(...chunk.lines);
    }
    return { lines: out, heartbeats };
  }

  const chunkerPath = join(temp, "chunker.jsonl");
  const SAMPLE_LINES = [
    JSON.stringify({ n: 0, text: "ascii line" }),
    JSON.stringify({ n: 1, text: "multi-byte ✓ ünïcödé ✓ line" }),
    JSON.stringify({ n: 2, pad: "p".repeat(5000) }),
    JSON.stringify({ n: 3 }),
    "   leading spaces preserved in offset, trimmed in raw",
    JSON.stringify({ n: 5, pad: "q".repeat(200000) }),
    JSON.stringify({ n: 6 }),
  ];
  writeFileSync(chunkerPath, SAMPLE_LINES.join("\n") + "\n", "utf8");
  const expected = fullSplitOffsets(chunkerPath);

  for (const chunkBytes of [64, 1024, 1 << 18]) {
    const { lines } = await collect(chunkerPath, 0, { chunkBytes });
    check(`chunker offset parity (chunkBytes=${chunkBytes})`,
      lines.length === expected.length &&
      lines.every((l, i) => l.offset === expected[i].offset && l.raw === expected[i].raw),
      `got ${lines.length} lines vs ${expected.length}`);
  }

  // Giant line: one line bigger than the 8 MiB heartbeat budget.
  const giantPath = join(temp, "giant.jsonl");
  const GIANT = "g".repeat(20 * 1024 * 1024);
  writeFileSync(giantPath,
    JSON.stringify({ n: 0 }) + "\n" + JSON.stringify({ pad: GIANT }) + "\n" + JSON.stringify({ n: 2 }) + "\n",
    "utf8");
  const giantExpected = fullSplitOffsets(giantPath);
  const giant = await collect(giantPath);
  check("giant line parses with full-offset parity",
    giant.lines.length === giantExpected.length &&
    giant.lines.every((l, i) => l.offset === giantExpected[i].offset && l.raw === giantExpected[i].raw),
    `got ${giant.lines.length} lines vs ${giantExpected.length}`);
  check("giant line yields heartbeat chunks (event loop interleaves)", giant.heartbeats >= 1,
    `heartbeats=${giant.heartbeats}`);

  // Resume parity: parse [0, mid) then resume at the recorded endOffset —
  // the union must equal the full parse, key for key.
  const first = [];
  let resumeAt = null;
  for await (const chunk of jsonlChunksFrom(chunkerPath, 0, { chunkBytes: 1024 })) {
    if (chunk.atEof) break;
    first.push(...chunk.lines);
    resumeAt = chunk.endOffset;
    break; // stop after the FIRST chunk — the next pass resumes from its endOffset
  }
  const resumed = await collect(chunkerPath, resumeAt);
  const union = [...first, ...resumed.lines];
  check("resumed pass emits identical (raw, offset) keys as a full parse",
    union.length === expected.length &&
    union.every((l, i) => l.offset === expected[i].offset && l.raw === expected[i].raw),
    `first=${first.length} resumed=${resumed.lines.length} expected=${expected.length}`);

  // --- FOC-597: the unterminated EOF tail is held back, not consumed --------
  // The tail after the last newline is both "the final line" (files may lack a
  // trailing newline — the shape full-parse callers rely on) and the exact shape
  // of a live writer caught mid-append. It stays in `lines`, but it is EXCLUDED
  // from endOffset: committing past a torn write loses the line that later
  // completes it (FOC-597 fact loss). Consumers commit the tail only once it
  // parses as a whole record.
  const tornPath = join(temp, "torn.jsonl");
  const TORN_HEAD = JSON.stringify({ n: 0 }) + "\n";
  const TORN_TAIL = '{"n":1,"text":"mid-wri';
  writeFileSync(tornPath, TORN_HEAD + TORN_TAIL, "utf8");
  const tornBoundary = Buffer.byteLength(TORN_HEAD, "utf8");
  const tornSize = statSync(tornPath).size;
  const torn = await collect(tornPath);
  let tornEof = null;
  for await (const chunk of jsonlChunksFrom(tornPath, 0, { chunkBytes: 1 << 18 })) {
    if (chunk.atEof) tornEof = chunk;
  }
  check("FOC-597 torn tail: still yielded as a line (full-parse parity)",
    torn.lines.length === 2 && torn.lines[1].raw === TORN_TAIL && torn.lines[1].offset === tornBoundary,
    `got ${torn.lines.length} lines, tail raw=${JSON.stringify(torn.lines[1]?.raw)}`);
  check("FOC-597 torn tail: endOffset stops at the tail, tail reports [offset,end)",
    tornEof && tornEof.endOffset === tornBoundary &&
    tornEof.tail && tornEof.tail.offset === tornBoundary && tornEof.tail.end === tornSize,
    `endOffset=${tornEof?.endOffset} tail=${JSON.stringify(tornEof?.tail)}`);
  const rereadTail = await collect(tornPath, tornBoundary);
  check("FOC-597 torn tail: resuming at endOffset re-reads the whole tail (nothing lost)",
    rereadTail.lines.length === 1 && rereadTail.lines[0].offset === tornBoundary &&
    rereadTail.lines[0].raw === TORN_TAIL,
    `got ${rereadTail.lines.length} lines`);

  // Twin: a final line WITHOUT a trailing newline is still a line — the
  // generator documents that shape and full-parse callers take the last line.
  const finalPath = join(temp, "final-no-newline.jsonl");
  writeFileSync(finalPath, JSON.stringify({ n: 0 }) + "\n" + JSON.stringify({ n: 1 }), "utf8");
  const finalExpected = fullSplitOffsets(finalPath);
  const finalParsed = await collect(finalPath);
  check("FOC-597 no-trailing-newline file: full-split parity (final line kept)",
    finalParsed.lines.length === finalExpected.length &&
    finalParsed.lines.every((l, i) => l.offset === finalExpected[i].offset && l.raw === finalExpected[i].raw),
    `got ${finalParsed.lines.length} vs ${finalExpected.length}`);
  let finalEof = null;
  for await (const chunk of jsonlChunksFrom(finalPath, 0)) { if (chunk.atEof) finalEof = chunk; }
  check("FOC-597 no-trailing-newline file: tail marked, endOffset stops at its start",
    finalEof && finalEof.tail && finalEof.tail.offset === finalEof.endOffset &&
    finalEof.tail.end === statSync(finalPath).size,
    `endOffset=${finalEof?.endOffset} tail=${JSON.stringify(finalEof?.tail)}`);

  const closedPath = join(temp, "closed.jsonl");
  writeFileSync(closedPath, JSON.stringify({ n: 0 }) + "\n", "utf8");
  let closedEof = null;
  for await (const chunk of jsonlChunksFrom(closedPath, 0)) { if (chunk.atEof) closedEof = chunk; }
  check("FOC-597 newline-terminated file: no tail, endOffset at EOF",
    closedEof && closedEof.tail == null && closedEof.endOffset === statSync(closedPath).size,
    `endOffset=${closedEof?.endOffset} tail=${JSON.stringify(closedEof?.tail)}`);

  // Related (same issue): decoder.end() flushes a multi-byte char split at EOF
  // instead of silently dropping its bytes from the tail text.
  const midCharPath = join(temp, "mid-char.jsonl");
  const MID_CHAR_SIZE = 10; // '{"text":"' + first byte of U+2713
  writeFileSync(midCharPath, Buffer.concat([Buffer.from('{"text":"'), Buffer.from([0xe2])]));
  const midChar = [];
  let midCharEof = null;
  for await (const chunk of jsonlChunksFrom(midCharPath, 0)) {
    midChar.push(...chunk.lines);
    if (chunk.atEof) midCharEof = chunk;
  }
  check("FOC-597 split multi-byte char at EOF: flushed via decoder.end(), tail at file size",
    midChar.length === 1 && midChar[0].raw === '{"text":"�' &&
    midCharEof?.tail && midCharEof.tail.offset === 0 && midCharEof.tail.end === MID_CHAR_SIZE,
    `raw=${JSON.stringify(midChar[0]?.raw)} tail=${JSON.stringify(midCharEof?.tail)}`);
}

// Windows can hold the SQLite file briefly after close (AV/indexer) — the same
// reason telemetry-ingest.test.mjs ignores cleanup failures. A leftover temp
// directory must not fail an otherwise green run.
try {
  rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
} catch { /* ignore */ }

console.log(`${passed} passed, ${skipped} skipped, ${failed} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  FAIL: ${f}`).join("\n"));
  process.exit(1);
}
