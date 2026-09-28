// Contract test for scripts/codegraph-trajectory.mjs (FOC-624, collection half).
//
// What is pinned, and why it can fail loudly:
//   - CAPTURE is lossless where it matters: freshness at query time and the
//     returned IDENTIFIERS (FOC-220 keeps the result text out of the store, so
//     this table is the only place the shape of an answer survives — losing an
//     identifier here is unrecoverable);
//   - it never fabricates: an unrecognised render is `unknown`, `Found 0` is NOT
//     an answer, and a re-capture never erases a completed attribution;
//   - ATTRIBUTION is future information, so it is a second, idempotent pass, and
//     its outcome vocabulary is the contract FOC-627 grades (answered / fallback /
//     unused, plus `unknown`);
//   - the two telemetry-ingest hooks actually fire — the unit checks above would
//     all pass with the wiring missing.
//
// HERMETIC. Every check runs against a temp telemetry store and a temp
// transcript; the live telemetry DB is never opened.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  isCodegraphTool,
  deriveCodegraphCapture,
  toolFactIdOf,
  captureFromRecord,
  recordCodegraphCapture,
  attributeOne,
  attributeQueries,
  loadProseAfter,
  OUTCOMES,
  CODEGRAPH_TOOL_PREFIX,
} from "./codegraph-trajectory.mjs";
import { openTelemetryDb, makeEvent, applyEvent } from "./telemetry-store.mjs";
import { ingestTranscript } from "./telemetry-ingest.mjs";
import { extractToolFacts } from "./telemetry-tool-extract.mjs";

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

function section(title) {
  console.log(`\n--- ${title} ---`);
}

const temp = mkdtempSync(join(tmpdir(), "foc-624-traj-"));

// Route every ambient DB open at the temp store BEFORE anything opens one.
const dbPath = join(temp, "telemetry.sqlite");
process.env.LA_TELEMETRY_HOME = temp;
process.env.LA_TELEMETRY_DB = dbPath;

function writeJsonl(path, lines) {
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
  return path;
}

const parseJsonArray = (value) => {
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// A recognisable CodeGraph answer. Every marker below is one the real
// deriveCodegraphCapture regexes key on; if the MCP render changes shape these
// fixtures must change with it, which is the point.
const ANSWER = [
  "**Exploration: how does ingestToolFactsRange work**",
  "",
  "**`scripts/telemetry-ingest.mjs`**",
  "- `ingestToolFactsRange` (scripts/telemetry-ingest.mjs:452) — one range's tool facts.",
  "- `captureCodegraphFact` (scripts/telemetry-ingest.mjs:399) — FOC-624 capture hook.",
  "",
  "**`scripts/codegraph-trajectory.mjs`**",
  "- `attributeQueries` (scripts/codegraph-trajectory.mjs:289) — attribution pass.",
  "",
  "Found 3 symbols across 2 files.",
].join("\n");

const EXPECTED_FILES = ["scripts/telemetry-ingest.mjs", "scripts/codegraph-trajectory.mjs"];
const EXPECTED_SYMBOLS = ["ingestToolFactsRange", "captureCodegraphFact", "attributeQueries"];

const CG_EXPLORE = `${CODEGRAPH_TOOL_PREFIX}explore`;

// ---------------------------------------------------------------------------
// A. Which tool calls this covers
// ---------------------------------------------------------------------------

section("A. isCodegraphTool");

check("mcp__codegraph__codegraph_explore counts", isCodegraphTool(CG_EXPLORE, null));
check("mcp__codegraph__codegraph_impact counts", isCodegraphTool(`${CODEGRAPH_TOOL_PREFIX}impact`, null));
check("canonical code_intel counts even with another raw name", isCodegraphTool("CodeIntel", "code_intel"));
check("Read is not a CodeGraph call", !isCodegraphTool("Read", "read_file"));
check("Grep is not a CodeGraph call", !isCodegraphTool("Grep", "grep"));

// ---------------------------------------------------------------------------
// B. Identity — must join tool_facts without a second scheme
// ---------------------------------------------------------------------------

section("B. toolFactIdOf");

{
  const record = { source_path: "C:/t/lead.jsonl", source_offset: 4096, tool_index: 2 };
  const expected = createHash("sha1").update("C:/t/lead.jsonl:4096:2").digest("hex");
  check("is sha1(source_path:source_offset:tool_index)", toolFactIdOf(record) === expected,
    `got ${toolFactIdOf(record)}`);
  check("tool_index is part of the identity",
    toolFactIdOf({ ...record, tool_index: 3 }) !== toolFactIdOf(record));
  check("source_offset is part of the identity",
    toolFactIdOf({ ...record, source_offset: 8192 }) !== toolFactIdOf(record));
}

// ---------------------------------------------------------------------------
// C. Capture derivation — freshness + returned identifiers
// ---------------------------------------------------------------------------

section("C. deriveCodegraphCapture");

{
  const cap = deriveCodegraphCapture({ resultText: ANSWER });
  check("a recognised answer is FRESH (no staleness banner)", cap.freshness === "fresh", cap.reason);
  check("a recognised answer with content counts as answered", cap.graphAnswered === true, cap.reason);
  check("returned files are extracted and normalised",
    JSON.stringify(cap.returnsFiles) === JSON.stringify(EXPECTED_FILES),
    `got ${JSON.stringify(cap.returnsFiles)}`);
  check("returned symbols are extracted in order",
    JSON.stringify(cap.returnsSymbols) === JSON.stringify(EXPECTED_SYMBOLS),
    `got ${JSON.stringify(cap.returnsSymbols)}`);
}

{
  const cap = deriveCodegraphCapture({ resultText: `${ANSWER}\n\n⚠️ index is stale` });
  check("a staleness banner forces STALE", cap.freshness === "stale", cap.reason);
}
{
  const cap = deriveCodegraphCapture({ resultText: "⚠️ staleness banner: pending sync" });
  check("a banner alone is STALE, never fresh", cap.freshness === "stale", cap.reason);
}
{
  const cap = deriveCodegraphCapture({ resultText: "Index is missing — fall back to reading the files." });
  check("an unproven/missing index is UNKNOWN", cap.freshness === "unknown", cap.reason);
}
{
  const cap = deriveCodegraphCapture({ resultText: "**Exploration: nothing here**\n\nFound 0 symbols across 0 files." });
  check("Found 0 is NOT an answer", cap.graphAnswered === false, cap.reason);
  check("Found 0 still reports a recognised shape", cap.freshness === "fresh", cap.reason);
}
{
  const cap = deriveCodegraphCapture({ resultText: "Sorry, I could not answer that from the index." });
  check("an unrecognised render is UNKNOWN", cap.freshness === "unknown", cap.reason);
  check("an unrecognised render is NOT answered", cap.graphAnswered === false, cap.reason);
  check("an unrecognised render returns no identifiers",
    cap.returnsFiles.length === 0 && cap.returnsSymbols.length === 0,
    JSON.stringify(cap.returnsFiles));
}
{
  const cap = deriveCodegraphCapture({ resultText: "" });
  check("empty result text degrades to unknown", cap.freshness === "unknown" && !cap.graphAnswered, cap.reason);
}
{
  const cap = deriveCodegraphCapture({});
  check("a missing result degrades to unknown, never a guess",
    cap.freshness === "unknown" && !cap.graphAnswered, cap.reason);
}

// ---------------------------------------------------------------------------
// D. captureFromRecord
// ---------------------------------------------------------------------------

section("D. captureFromRecord");

{
  const base = {
    run_id: "run-1", agent_key: "_lead", turn_index: 3, observed_at: "2026-09-28T10:00:00.000Z",
    source_path: "C:/t/lead.jsonl", source_offset: 100, tool_index: 0,
    tool_name_raw: CG_EXPLORE, tool_name_canon: "code_intel", tool_result_full: ANSWER,
  };
  const row = captureFromRecord(base);
  check("a CodeGraph call with a result is captured", row != null);
  check("the capture row carries recordToolFact's identity", row.tool_fact_id === toolFactIdOf(base));
  check("the capture row carries freshness", row.freshness === "fresh");
  check("the capture row stores returns as JSON identifier arrays",
    JSON.stringify(parseJsonArray(row.returns_files)) === JSON.stringify(EXPECTED_FILES),
    row.returns_files);
  check("graph_answered is 1/0, not a boolean", row.graph_answered === 1);

  check("a non-CodeGraph call is not captured",
    captureFromRecord({ ...base, tool_name_raw: "Read", tool_name_canon: "read_file" }) === null);

  const pending = captureFromRecord({ ...base, tool_result_full: null });
  check("a pending use (no result yet) is not captured — it is captured on resolve", pending === null);
}

// ---------------------------------------------------------------------------
// E. recordCodegraphCapture — persistence semantics
// ---------------------------------------------------------------------------

section("E. recordCodegraphCapture");

{
  let db;
  try {
    db = openTelemetryDb(dbPath);
    db.prepare("SELECT 1 FROM codegraph_query_facts LIMIT 1").get();

    const rec = {
      run_id: "run-e", agent_key: "_lead", turn_index: 0, observed_at: "2026-09-28T11:00:00.000Z",
      source_path: "C:/t/lead.jsonl", source_offset: 200, tool_index: 1,
      tool_name_raw: CG_EXPLORE, tool_name_canon: "code_intel", tool_result_full: ANSWER,
    };
    const row = captureFromRecord(rec);
    recordCodegraphCapture(db, row);
    const read = db.prepare("SELECT * FROM codegraph_query_facts WHERE tool_fact_id=?").get(row.tool_fact_id);
    check("a capture row is persisted", read != null);
    check("created_at is populated (NOT NULL column)", Boolean(read?.created_at), String(read?.created_at));
    check("attribution columns start NULL", read?.outcome == null && read?.used_files == null);
    check("returns_files is persisted as JSON", JSON.stringify(parseJsonArray(read?.returns_files)) === JSON.stringify(EXPECTED_FILES));

    // Simulate the attribution pass, then re-capture (a later ingest pass sees
    // more of a grown transcript and may derive better returns).
    db.prepare("UPDATE codegraph_query_facts SET used_files=?, used_symbols=?, outcome=? WHERE tool_fact_id=?")
      .run(JSON.stringify(["scripts/telemetry-ingest.mjs"]), JSON.stringify(["ingestToolFactsRange"]), "answered", row.tool_fact_id);
    const createdAtBefore = db.prepare("SELECT created_at FROM codegraph_query_facts WHERE tool_fact_id=?").get(row.tool_fact_id).created_at;
    recordCodegraphCapture(db, captureFromRecord(rec));
    const again = db.prepare("SELECT * FROM codegraph_query_facts WHERE tool_fact_id=?").get(row.tool_fact_id);
    check("a re-capture PRESERVES the completed attribution", again?.outcome === "answered", String(again?.outcome));
    check("a re-capture PRESERVES used_files", JSON.stringify(parseJsonArray(again?.used_files)) === JSON.stringify(["scripts/telemetry-ingest.mjs"]));
    check("a re-capture PRESERVES created_at", again?.created_at === createdAtBefore,
      `${again?.created_at} vs ${createdAtBefore}`);

    // And it does not leave a second row behind.
    const count = db.prepare("SELECT COUNT(*) AS n FROM codegraph_query_facts WHERE tool_fact_id=?").get(row.tool_fact_id).n;
    check("a re-capture is idempotent (one row per tool fact)", count === 1, String(count));
  } catch (error) {
    if (error instanceof TestSkip) skipped++;
    else { failed++; failures.push(`E. persistence — ${error.message}`); }
  } finally {
    if (db) db.close();
  }
}

// ---------------------------------------------------------------------------
// F. attributeOne — the outcome vocabulary FOC-627 grades
// ---------------------------------------------------------------------------

section("F. attributeOne outcomes");

check("OUTCOMES is exactly answered/fallback/unused/unknown",
  JSON.stringify(OUTCOMES) === JSON.stringify(["answered", "fallback", "unused", "unknown"]),
  JSON.stringify(OUTCOMES));

const queryRow = (overrides = {}) => ({
  tool_fact_id: "q1", run_id: "run-1", agent_key: "_lead",
  graph_answered: 1,
  returns_files: JSON.stringify(EXPECTED_FILES),
  returns_symbols: JSON.stringify(EXPECTED_SYMBOLS),
  ...overrides,
});
const toolRow = (raw, input, offset = 200, index = 0) => ({
  tool_fact_id: `${raw}-${offset}-${index}`, run_id: "run-1", agent_key: "_lead",
  tool_name_raw: raw, tool_name_canon: null, tool_input: input,
  source_offset: offset, tool_index: index,
});

{
  const row = attributeOne(queryRow(), {
    laterRows: [toolRow("Read", '{"file_path":"scripts/codegraph-trajectory.mjs"}')],
  });
  check("a later tool naming a returned file is ANSWERED", row.outcome === "answered", row.outcome);
  check("  ...and records which file was used",
    JSON.stringify(parseJsonArray(row.used_files)) === JSON.stringify(["scripts/codegraph-trajectory.mjs"]),
    row.used_files);
}
{
  const row = attributeOne(queryRow(), {
    laterRows: [toolRow("Read", '{"file_path":"unrelated.txt"}')],
    proseAfter: "The verdict cites `ingestToolFactsRange` as the fixed site.",
  });
  check("a symbol named in the turn's prose is ANSWERED (cited in a verdict/plan)",
    row.outcome === "answered", row.outcome);
  check("  ...and records which symbol was used",
    JSON.stringify(parseJsonArray(row.used_symbols)) === JSON.stringify(["ingestToolFactsRange"]),
    row.used_symbols);
}
{
  // The realistic `fallback`: the graph gave nothing usable (so there is nothing
  // to use), and the agent went to the files.
  const row = attributeOne(queryRow({ graph_answered: 0, returns_files: "[]", returns_symbols: "[]" }), {
    laterRows: [toolRow("Read", '{"file_path":"scripts/telemetry-ingest.mjs"}')],
  });
  check("no answer + going to the files is FALLBACK", row.outcome === "fallback", row.outcome);
}
{
  const row = attributeOne(queryRow(), {
    laterRows: [toolRow("Bash", '{"command":"npm test"}'), toolRow("Read", '{"file_path":"unrelated.txt"}')],
  });
  check("later work that names nothing returned is UNUSED", row.outcome === "unused", row.outcome);
  check("  ...and records that nothing was used",
    parseJsonArray(row.used_files).length === 0 && parseJsonArray(row.used_symbols).length === 0);
}
{
  const row = attributeOne(queryRow());
  check("nothing at all after the query is UNKNOWN, not 'unused'", row.outcome === "unknown", row.outcome);
}
{
  // Evidence of use wins outright, even when the graph also failed.
  const row = attributeOne(queryRow({ graph_answered: 0 }), {
    laterRows: [toolRow("Read", '{"file_path":"scripts/telemetry-ingest.mjs"}')],
    proseAfter: EXPECTED_SYMBOLS[0],
  });
  check("named use beats the fallback heuristic", row.outcome === "answered", row.outcome);
}

// ---------------------------------------------------------------------------
// G. attributeQueries — "later" means later in the transcript
// ---------------------------------------------------------------------------

section("G. attributeQueries ordering");

{
  const q = queryRow({ tool_fact_id: "qA", source_offset: 100, tool_index: 0 });
  const before = toolRow("Read", '{"file_path":"scripts/telemetry-ingest.mjs"}', 50, 5);
  const sameOffsetEarlier = toolRow("Read", '{"file_path":"scripts/telemetry-ingest.mjs"}', 100, 0);
  const sameOffsetLater = toolRow("Read", '{"file_path":"scripts/codegraph-trajectory.mjs"}', 100, 1);
  const after = toolRow("Bash", '{"command":"ls"}', 500, 0);
  const [out] = attributeQueries({ queries: [q], toolRows: [before, sameOffsetEarlier, sameOffsetLater, after] });
  check("a row at an earlier offset is NOT 'later'",
    parseJsonArray(out.used_files).includes("scripts/telemetry-ingest.mjs") === false, out.used_files);
  check("a row at the same offset and same tool_index is NOT 'later'",
    parseJsonArray(out.used_files).length <= 1, out.used_files);
  check("a row at the same offset and a later tool_index IS 'later'",
    out.outcome === "answered" && parseJsonArray(out.used_files).includes("scripts/codegraph-trajectory.mjs"),
    `${out.outcome} ${out.used_files}`);
}
{
  const q1 = queryRow({ tool_fact_id: "qB", source_offset: 100, tool_index: 0 });
  const q2 = queryRow({ tool_fact_id: "qC", source_offset: 300, tool_index: 0 });
  const rows = [toolRow("Read", '{"file_path":"scripts/telemetry-ingest.mjs"}', 200, 0)];
  attributeQueries({ queries: [q1, q2], toolRows: rows });
  check("only the earlier of two queries claims the read as its use",
    q1.outcome === "answered" && q2.outcome === "unknown", `${q1.outcome}/${q2.outcome}`);
}
{
  // Widening, not recomputation: a later pass can see a narrower window than an
  // earlier one (truncated tool_input preview, shorter prose slice). A use once
  // seen must survive it.
  const q = queryRow({ tool_fact_id: "qD", source_offset: 100, tool_index: 0 });
  attributeQueries({ queries: [q], toolRows: [toolRow("Read", '{"file_path":"scripts/telemetry-ingest.mjs"}', 200, 0)] });
  check("first pass sees the use", q.outcome === "answered", q.outcome);
  const seenFiles = q.used_files;
  const seenSymbols = q.used_symbols;

  attributeQueries({ queries: [q], toolRows: [] }); // a pass that sees nothing
  check("a second pass never narrows used_files", q.used_files === seenFiles, q.used_files);
  check("a second pass never narrows used_symbols", q.used_symbols === seenSymbols, q.used_symbols);
  check("a second pass never downgrades an ANSWERED outcome", q.outcome === "answered", q.outcome);
}

// ---------------------------------------------------------------------------
// H. loadProseAfter — bounded window, never the whole transcript
// ---------------------------------------------------------------------------

section("H. loadProseAfter");

{
  // The window is JSONL-aware: it must keep ASSISTANT prose and drop tool results.
  // Scanning raw bytes would let a query's own result name its own returned
  // identifiers and so label every return "used" by its own answer — the
  // self-fulfilling label FOC-627 must never be trained on.
  const transcriptPath = join(temp, "prose.jsonl");
  const lead = JSON.stringify({ type: "user", message: { content: [] } });
  const call = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "a", name: CG_EXPLORE, input: { query: "x" } }] } });
  const result = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a", content: "names `secretSymbol` inside the tool result" }] } });
  const verdict = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "the verdict cites `verdictSymbol` here" }] } });
  const tail = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "z".repeat(4096) }] } });
  const offset = lead.length + 1 + call.length + 1;
  writeFileSync(transcriptPath, [lead, call, result, verdict, tail].join("\n") + "\n", "utf8");

  const prose = await loadProseAfter([{ tool_fact_id: "qP", source_path: transcriptPath, source_offset: offset }], { maxBytes: 2048 });
  const text = prose.get("qP");
  check("the prose window keeps assistant text after the query", text.includes("verdictSymbol"),
    JSON.stringify(text.slice(0, 80)));
  check("the prose window EXCLUDES tool_result content (no self-labelling)", text.includes("secretSymbol") === false,
    JSON.stringify(text.slice(0, 200)));

  const wide = await loadProseAfter([{ tool_fact_id: "qW", source_path: transcriptPath, source_offset: offset }], { maxBytes: 64 });
  check("the window is capped at maxBytes", (wide.get("qW") || "").length <= 64, String((wide.get("qW") || "").length));

  const qEnd = [{ tool_fact_id: "qZ", source_path: transcriptPath, source_offset: 1 << 20 }];
  const proseEnd = await loadProseAfter(qEnd);
  check("an offset past EOF yields an empty window, not a throw", proseEnd.get("qZ") === "");

  const qMissing = [{ tool_fact_id: "qM", source_path: join(temp, "nope.jsonl"), source_offset: 0 }];
  const proseMissing = await loadProseAfter(qMissing);
  check("an unreadable source yields NO entry (attribution stays unknown)",
    proseMissing.has("qM") === false);
}

// ---------------------------------------------------------------------------
// I. End-to-end through the telemetry-ingest hooks
// ---------------------------------------------------------------------------

section("I. end-to-end capture + attribution (the wiring)");

{
  let db;
  try {
    if (!DatabaseSync) throw new TestSkip("node:sqlite unavailable");

    db = openTelemetryDb(dbPath);
    const runId = "run-e2e";
    const sessionId = "session-e2e";
    const transcript = join(temp, "e2e.jsonl");
    mkdirSync(join(temp, "e2e", "subagents"), { recursive: true });

    applyEvent(db, makeEvent("run.started", {
      runId, squad: "dev", startedAt: "2026-09-28T12:00:00.000Z", cwd: "C:/repos/linear-agents",
    }, { runId }));
    applyEvent(db, makeEvent("session.linked", {
      runId, sessionId, transcriptPath: transcript,
    }, { runId }));

    const assistant = (timestamp, blocks) => ({
      type: "assistant", timestamp, sessionId, cwd: "C:/repos/linear-agents",
      message: { role: "assistant", model: "test-model", usage: { input_tokens: 10, output_tokens: 5 }, content: blocks },
    });
    const userResults = (timestamp, results) => ({
      type: "user", timestamp, sessionId,
      message: { role: "user", content: results.map((r) => ({ type: "tool_result", ...r })) },
    });

    writeJsonl(transcript, [
      { type: "user", timestamp: "2026-09-28T12:00:01.000Z", sessionId, cwd: "C:/repos/linear-agents", gitBranch: "main" },
      assistant("2026-09-28T12:00:02.000Z", [
        { type: "text", text: "Looking up the ingest flow." },
        { type: "tool_use", id: "cg1", name: CG_EXPLORE, input: { query: "how does ingestToolFactsRange work" } },
      ]),
      userResults("2026-09-28T12:00:03.000Z", [{ tool_use_id: "cg1", content: ANSWER }]),
      assistant("2026-09-28T12:00:04.000Z", [
        { type: "tool_use", id: "rd1", name: "Read", input: { file_path: "scripts/telemetry-ingest.mjs" } },
      ]),
      userResults("2026-09-28T12:00:05.000Z", [{ tool_use_id: "rd1", content: "…source…" }]),
    ]);

    await ingestTranscript(db, runId, transcript, sessionId);

    const row = db.prepare("SELECT * FROM codegraph_query_facts WHERE run_id=?").get(runId);
    check("the capture hook fires from ingestTranscript", row != null);
    if (row) {
      check("  ...with freshness derived at capture time", row.freshness === "fresh", row.freshness);
      check("  ...and the returned identifiers", JSON.stringify(parseJsonArray(row.returns_files)) === JSON.stringify(EXPECTED_FILES),
        row.returns_files);
      check("  ...keyed on recordToolFact's identity",
        row.tool_fact_id === toolFactIdOf({
          source_path: row.source_path, source_offset: row.source_offset, tool_index: row.tool_index,
        }), row.tool_fact_id);
      check("  ...and joined to tool_facts on that identity",
        db.prepare("SELECT 1 FROM tool_facts WHERE tool_fact_id=?").get(row.tool_fact_id) != null);
      check("the attribution hook fires from ingestTranscript", row.outcome != null, String(row.outcome));
      check("  ...and the later Read of a returned file is ANSWERED", row.outcome === "answered", row.outcome);
      check("  ...naming exactly the file that was read",
        JSON.stringify(parseJsonArray(row.used_files)) === JSON.stringify(["scripts/telemetry-ingest.mjs"]),
        row.used_files);
    }

    // A non-CodeGraph tool leaves nothing behind (scoped to this run — section E
    // writes its own fixture row into the same store).
    const all = db.prepare(
      "SELECT tool_fact_id, source_offset, tool_index, tool_name_raw, freshness FROM codegraph_query_facts WHERE run_id=? ORDER BY source_offset, tool_index",
    ).all(runId);
    check("only CodeGraph calls are captured", all.length === 1, JSON.stringify(all));
  } catch (error) {
    if (error instanceof TestSkip) { skipped++; console.log(`  SKIP: ${error.message}`); }
    else { failed++; failures.push(`I. end-to-end — ${error.message}`); }
  } finally {
    if (db) db.close();
  }
}

// ---------------------------------------------------------------------------

try {
  rmSync(temp, { recursive: true, force: true });
} catch {
  // best-effort temp cleanup; a leftover tmpdir is not a test failure
}

console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}`);
for (const f of failures) console.error(`FAIL: ${f}`);
process.exit(failed > 0 ? 1 : 0);
