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
