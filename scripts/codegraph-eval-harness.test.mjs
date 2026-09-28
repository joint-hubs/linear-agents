// Contract test for scripts/codegraph-eval-harness.mjs (FOC-627).
//
// What is pinned, and why it can fail loudly:
//   - PROVENANCE (AC1): every entry's tool_fact_id must be well-formed 40-hex
//     AND exist in tool_facts, and the recorded run/agent/tool must agree with
//     the row it names — a corrupted provenance key must fail the run, never
//     silently grade a guessed trajectory;
//   - OUTCOMES: the four classes (answered/fallback/unused/unknown) are derived
//     through codegraph-trajectory.mjs attributeQueries — the one implementation
//     — and a crafted fixture must be able to produce each of them distinctly;
//   - DETERMINISM (AC4): two runs over the same tree and transcripts produce a
//     byte-identical report (no wall-clock fields, no map-order dependence);
//   - SCHEMA (AC3): the report never collapses to a single success number.
//
// HERMETIC. Every check runs against a temp telemetry store and temp
// transcripts; the live telemetry DB is never opened (the CLI cases pass
// --db explicitly).

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  runHarness,
  validateEvalSet,
  validateProvenance,
  pairQueryWindow,
  DEFAULT_EVAL,
} from "./codegraph-eval-harness.mjs";
import { OUTCOMES, CODEGRAPH_TOOL_PREFIX } from "./codegraph-trajectory.mjs";
import { openTelemetryDb, makeEvent, applyEvent } from "./telemetry-store.mjs";
import { ingestTranscript } from "./telemetry-ingest.mjs";

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

const temp = mkdtempSync(join(tmpdir(), "foc-627-eval-"));

// Route every ambient DB open at the temp store BEFORE anything opens one.
const dbPath = join(temp, "telemetry.sqlite");
process.env.LA_TELEMETRY_HOME = temp;
process.env.LA_TELEMETRY_DB = dbPath;

const CG_EXPLORE = `${CODEGRAPH_TOOL_PREFIX}explore`;
const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// A recognised CodeGraph answer whose returned identifiers the fixtures reuse.
const ANSWER = [
  "**Exploration: how does ingestToolFactsRange work**",
  "",
  "**`scripts/telemetry-ingest.mjs`**",
  "- `ingestToolFactsRange` (scripts/telemetry-ingest.mjs:452) — one range's tool facts.",
  "",
  "Found 1 symbol across 1 file.",
].join("\n");

// A refusal for an unindexed project — the recorded shape of a NOT-answered query.
const REFUSAL = "The project at C:/tmp/not-indexed isn't indexed with codegraph (no .codegraph/ directory found walking up from it), so codegraph cannot query it. Use your built-in tools (Read/Grep/Glob) for that codebase instead.";

const assistant = (timestamp, blocks, withUsage = true) => ({
  type: "assistant", timestamp, sessionId: "s", cwd: "C:/repos/linear-agents",
  message: {
    role: "assistant", model: "test-model",
    usage: withUsage ? { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 } : undefined,
    content: blocks,
  },
});
const userResults = (timestamp, results) => ({
  type: "user", timestamp, sessionId: "s",
  message: { role: "user", content: results.map((r) => ({ type: "tool_result", ...r })) },
});

// Four trajectories, one per outcome class. Each is its own run so attribution
// never crosses runs.
const RUNS = {
  answered: { tool: CG_EXPLORE, result: ANSWER, tail: [
    ["assistant", [{ type: "tool_use", id: "rd-a", name: "Read", input: { file_path: "scripts/telemetry-ingest.mjs" } }]],
    ["user", null, [{ tool_use_id: "rd-a", content: "…source…" }]],
  ] },
  fallback: { tool: CG_EXPLORE, result: REFUSAL, tail: [
    ["assistant", [{ type: "tool_use", id: "rd-b", name: "Read", input: { file_path: "scripts/some-file.mjs" } }]],
    ["user", null, [{ tool_use_id: "rd-b", content: "…source…" }]],
  ] },
  unused: { tool: CG_EXPLORE, result: ANSWER, tail: [
    ["assistant", [{ type: "tool_use", id: "sh-c", name: "Bash", input: { command: "ls -la" } }]],
    ["user", null, [{ tool_use_id: "sh-c", content: "file list" }]],
  ] },
  unknown: { tool: CG_EXPLORE, result: ANSWER, tail: [] },
};

let db;
let fixtureEvalPath;
try {
  if (!DatabaseSync) throw new TestSkip("node:sqlite unavailable");

  section("Fixture store — four crafted trajectories, one per outcome class");

  db = openTelemetryDb(dbPath);
  for (const [name, spec] of Object.entries(RUNS)) {
    const runId = `run-${name}`;
    const sessionId = `session-${name}`;
    const transcript = join(temp, `${name}.jsonl`);
    mkdirSync(join(temp, `${name}`, "subagents"), { recursive: true });

    applyEvent(db, makeEvent("run.started", {
      runId, squad: "dev", startedAt: "2026-09-28T12:00:00.000Z", cwd: "C:/repos/linear-agents",
    }, { runId }));
    applyEvent(db, makeEvent("session.linked", { runId, sessionId, transcriptPath: transcript }, { runId }));

    const lines = [
      { type: "user", timestamp: "2026-09-28T12:00:01.000Z", sessionId, cwd: "C:/repos/linear-agents", gitBranch: "main" },
      assistant("2026-09-28T12:00:02.000Z", [
        { type: "text", text: "Looking up the ingest flow." },
        { type: "tool_use", id: `cg-${name}`, name: spec.tool, input: { query: `how does ${name} work` } },
      ], name !== "unknown"), // the `unknown` run's assistant line records no usage block
      userResults("2026-09-28T12:00:03.000Z", [{ tool_use_id: `cg-${name}`, content: spec.result }]),
    ];
    for (const [type, blocks, results] of spec.tail) {
      if (type === "assistant") lines.push(assistant("2026-09-28T12:00:04.000Z", blocks));
      else lines.push(userResults("2026-09-28T12:00:05.000Z", results));
    }
    writeFileSync(transcript, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
    await ingestTranscript(db, runId, transcript, sessionId);
  }

  // The eval set under test: one entry per crafted run, keyed by the REAL ids
  // the ingest wrote into tool_facts.
  const entries = [];
  for (const name of Object.keys(RUNS)) {
    const row = db.prepare(
      "SELECT tool_fact_id, tool_name_raw, run_id, agent_key, tool_input FROM tool_facts WHERE run_id=? AND tool_name_raw LIKE 'mcp__codegraph%'",
    ).get(`run-${name}`);
    entries.push({
      id: `q-fixture-${name}`,
      tool: row.tool_name_raw.replace(CODEGRAPH_TOOL_PREFIX, ""),
      tool_fact_id: row.tool_fact_id,
      run_id: row.run_id,
      agent_key: row.agent_key,
      args: JSON.parse(row.tool_input),
      question: `Fixture question for the ${name} trajectory.`,
      grading: { kind: "reference", mustName: ["ingestToolFactsRange"], grounded: "fixture rubric" },
    });
  }
  const fixtureEvalSet = {
    evalSet: "fixture — FOC-627 harness contract test",
    entries,
  };
  fixtureEvalPath = join(temp, "eval-set-fixture.json");
  writeFileSync(fixtureEvalPath, JSON.stringify(fixtureEvalSet, null, 2) + "\n", "utf8");

  // ---------------------------------------------------------------------------
  // A. pairQueryWindow — result pairing and usage extraction
  // ---------------------------------------------------------------------------

  section("A. pairQueryWindow");

  {
    const lines = [
      JSON.stringify({ type: "user", message: { content: [] } }),
      JSON.stringify(assistant("t1", [{ type: "tool_use", id: "u1", name: CG_EXPLORE, input: { query: "q" } }])),
      JSON.stringify(userResults("t2", [{ tool_use_id: "u1", content: ANSWER }])),
      JSON.stringify(assistant("t3", [{ type: "text", text: "verdict" }])),
    ];
    const { resultText, issuingTurnUsage } = pairQueryWindow(lines.join("\n") + "\n");
    check("the query's own result is paired by tool_use id", resultText === ANSWER, JSON.stringify(resultText?.slice(0, 40)));
    check("the issuing turn's usage is extracted", issuingTurnUsage?.inputTokens === 10 && issuingTurnUsage?.outputTokens === 5,
      JSON.stringify(issuingTurnUsage));
    check("cache token counts are carried through",
      issuingTurnUsage?.cacheReadInputTokens === 100 && issuingTurnUsage?.cacheCreationInputTokens === 20,
      JSON.stringify(issuingTurnUsage));

    const noUsage = pairQueryWindow([
      JSON.stringify({ type: "user", message: { content: [] } }),
      JSON.stringify(assistant("t1", [{ type: "tool_use", id: "u2", name: CG_EXPLORE, input: { query: "q" } }], false)),
      JSON.stringify(userResults("t2", [{ tool_use_id: "u2", content: ANSWER }])),
    ].join("\n") + "\n");
    check("an assistant line without a usage block yields null usage, not a guess", noUsage.issuingTurnUsage === null);
    check("  ...but the result is still paired", noUsage.resultText === ANSWER);

    const empty = pairQueryWindow("not json at all\n");
    check("an unparseable window degrades to null/null", empty.resultText === null && empty.issuingTurnUsage === null);
  }

  // ---------------------------------------------------------------------------
  // B. validateEvalSet — structural provenance (no DB needed)
  // ---------------------------------------------------------------------------

  section("B. validateEvalSet — structural");

  {
    const ok = validateEvalSet({ entries: [{
      id: "q1", tool: "explore", tool_fact_id: "a".repeat(40), run_id: "r", agent_key: "_lead",
      args: { query: "x" }, question: "?", grading: { kind: "reference", mustName: ["sym"] },
    }] });
    check("a well-formed entry passes with no violations", ok.length === 0, JSON.stringify(ok));

    const bad = validateEvalSet({ entries: [
      { id: "q-bad-id", tool: "explore", tool_fact_id: "nothex", run_id: "r", agent_key: "_lead", args: {}, grading: { kind: "reference", mustName: ["s"] } },
      { id: "q-dup", tool: "explore", tool_fact_id: "b".repeat(40), run_id: "r", agent_key: "_lead", args: {}, grading: { kind: "reference", mustName: ["s"] } },
      { id: "q-dup-2", tool: "explore", tool_fact_id: "b".repeat(40), run_id: "r", agent_key: "_lead", args: {}, grading: { kind: "reference", mustName: ["s"] } },
      { id: "q-bad-kind", tool: "explore", tool_fact_id: "c".repeat(40), run_id: "r", agent_key: "_lead", args: {}, grading: { kind: "insightful", mustName: ["s"] } },
      { id: "q-empty-mustname", tool: "explore", tool_fact_id: "d".repeat(40), run_id: "r", agent_key: "_lead", args: {}, grading: { kind: "reference", mustName: [] } },
    ] });
    check("a malformed id is a violation", bad.some((v) => v.includes("q-bad-id") && v.includes("40-hex")), JSON.stringify(bad));
    check("a duplicate tool_fact_id is a violation", bad.some((v) => v.includes("q-dup-2") && v.includes("duplicates")));
    check("a non-mechanical grading kind is a violation", bad.some((v) => v.includes("q-bad-kind")));
    check("an empty mustName is a violation", bad.some((v) => v.includes("q-empty-mustname")));

    check("a set with no entries array is a violation",
      validateEvalSet({}).length > 0);
  }

  // ---------------------------------------------------------------------------
  // C. validateProvenance — against the DB (AC1 must be able to FAIL)
  // ---------------------------------------------------------------------------

  section("C. validateProvenance — corrupted provenance must be caught");

  {
    const corrupted = entries.map((e) => ({ ...e, tool_fact_id: "e".repeat(40) }));
    const violations = validateProvenance(corrupted, db);
    check("a well-formed but nonexistent tool_fact_id is rejected", violations.length === corrupted.length,
      JSON.stringify(violations));
    check("the violation names the offending entry",
      violations.every((v) => v.includes("does not exist in tool_facts")));

    const mismatched = entries.map((e) => ({ ...e, run_id: "run-elsewhere" }));
    const mismatches = validateProvenance(mismatched, db);
    check("a recorded run_id that disagrees with tool_facts is rejected",
      mismatches.some((v) => v.includes("does not match tool_facts")), JSON.stringify(mismatches));

    check("the honest entries pass provenance", validateProvenance(entries, db).length === 0);
  }

  // ---------------------------------------------------------------------------
  // D. runHarness end-to-end — outcomes through the ONE attribution pass
  // ---------------------------------------------------------------------------

  section("D. runHarness — outcome classes on crafted trajectories");

  let report1;
  {
    const { report } = await runHarness({ evalPath: fixtureEvalPath, dbPath, out: join(temp, "report-1.json") });
    report1 = report;
    const byId = Object.fromEntries(report.queries.map((q) => [q.id, q]));
    check("the answered trajectory grades ANSWERED", byId["q-fixture-answered"]?.outcome === "answered",
      byId["q-fixture-answered"]?.outcome);
    check("the refusal trajectory with a later file read grades FALLBACK",
      byId["q-fixture-fallback"]?.outcome === "fallback", byId["q-fixture-fallback"]?.outcome);
    check("the answered-but-never-named trajectory grades UNUSED",
      byId["q-fixture-unused"]?.outcome === "unused", byId["q-fixture-unused"]?.outcome);
    check("the trajectory with nothing after the query grades UNKNOWN",
      byId["q-fixture-unknown"]?.outcome === "unknown", byId["q-fixture-unknown"]?.outcome);

    check("the answered entry records which file was used",
      JSON.stringify(byId["q-fixture-answered"]?.usedIdentifiers.files) === JSON.stringify(["scripts/telemetry-ingest.mjs"]),
      JSON.stringify(byId["q-fixture-answered"]?.usedIdentifiers));

    check("freshness is derived from the recorded result (fresh for a recognised answer)",
      byId["q-fixture-answered"]?.freshness === "fresh", byId["q-fixture-answered"]?.freshness);
    check("a refusal is NOT graph-answered",
      byId["q-fixture-fallback"]?.graphAnswered === false);

    check("the report echoes each entry's provenance key",
      byId["q-fixture-answered"]?.toolFactId === entries.find((e) => e.id === "q-fixture-answered").tool_fact_id);

    check("token usage comes from the transcript's recorded usage block",
      byId["q-fixture-answered"]?.issuingTurnUsage?.inputTokens === 10
        && byId["q-fixture-answered"]?.issuingTurnUsage?.outputTokens === 5,
      JSON.stringify(byId["q-fixture-answered"]?.issuingTurnUsage));
    check("a turn without a recorded usage block reports null, never an invented number",
      byId["q-fixture-unknown"]?.issuingTurnUsage === null);

    check("trajectoryToolCalls counts the query plus its later tool facts",
      byId["q-fixture-answered"]?.trajectoryToolCalls === 2
        && byId["q-fixture-unknown"]?.trajectoryToolCalls === 1,
      `${byId["q-fixture-answered"]?.trajectoryToolCalls}/${byId["q-fixture-unknown"]?.trajectoryToolCalls}`);
  }

  // ---------------------------------------------------------------------------
  // E. Schema shape (AC3) — outcomes distinct, never one success number
  // ---------------------------------------------------------------------------

  section("E. schema shape");

  {
    check("byOutcome carries exactly the four outcome classes",
      JSON.stringify(Object.keys(report1.byOutcome)) === JSON.stringify(OUTCOMES),
      JSON.stringify(Object.keys(report1.byOutcome)));
    check("each outcome class is present exactly once across the four fixtures",
      report1.byOutcome.answered === 1 && report1.byOutcome.fallback === 1
        && report1.byOutcome.unused === 1 && report1.byOutcome.unknown === 1,
      JSON.stringify(report1.byOutcome));
    const serialized = JSON.stringify(report1);
    check("no collapsed success number exists in the report",
      !/successRate|passRate|"score"|overallSuccess/i.test(serialized));
    check("no wall-clock field exists in the report",
      !/generatedAt|"timestamp"|"ts"|elapsedMs|durationMs/i.test(serialized));
    check("the report carries no source text (privacy) — the longest string is an identifier/query-length line",
      JSON.stringify(report1).length < 20000 && !report1.queries.some((q) => JSON.stringify(q).includes("verbatim, current on-disk source")),
      "report size sanity");
    check("tokenUsage states the fact without an aggregate number",
      report1.tokenUsage?.note != null && report1.tokenUsage.entriesWithIssuingTurnUsage === 3,
      JSON.stringify(report1.tokenUsage));
  }

  // ---------------------------------------------------------------------------
  // F. Determinism (AC4) — two runs, byte-identical output
  // ---------------------------------------------------------------------------

  section("F. determinism");

  {
    await runHarness({ evalPath: fixtureEvalPath, dbPath, out: join(temp, "report-2.json") });
    const a = readFileSync(join(temp, "report-1.json"), "utf8");
    const b = readFileSync(join(temp, "report-2.json"), "utf8");
    check("two runs over the unchanged fixture produce byte-identical reports", a === b);
  }

  // ---------------------------------------------------------------------------
  // G. The committed eval set passes structural validation
  // ---------------------------------------------------------------------------

  section("G. committed eval set");

  {
    const committed = JSON.parse(readFileSync(DEFAULT_EVAL, "utf8"));
    const violations = validateEvalSet(committed);
    check("the committed eval set is structurally valid", violations.length === 0, JSON.stringify(violations));
    check("the committed eval set excludes its ungradeable rows explicitly",
      Array.isArray(committed.excluded) && committed.excluded.length > 0
        && committed.excluded.every((x) => typeof x.reason === "string" && Array.isArray(x.toolFactIds)),
      "excluded section shape");
    check("the committed eval set stores identifiers only (privacy self-check: no long prose strings)",
      JSON.stringify(committed).split('"').every((s) => s.length <= 400));
  }

  // ---------------------------------------------------------------------------
  // H. CLI — exit codes (AC1's failure must be visible to a caller)
  // ---------------------------------------------------------------------------

  section("H. CLI exit codes");

  {
    const corruptedPath = join(temp, "eval-set-corrupted.json");
    const corrupted = JSON.parse(JSON.stringify(fixtureEvalSet));
    corrupted.entries[0].tool_fact_id = "f".repeat(40);
    writeFileSync(corruptedPath, JSON.stringify(corrupted, null, 2) + "\n", "utf8");

    const bad = spawnSync(process.execPath, [join(__dirname, "codegraph-eval-harness.mjs"), "--eval", corruptedPath, "--db", dbPath], { encoding: "utf8" });
    check("a corrupted provenance key exits nonzero", bad.status === 2, `exit=${bad.status} stderr=${(bad.stderr || "").slice(0, 200)}`);
    check("the CLI names the offending entry on stderr", (bad.stderr || "").includes("q-fixture-answered"));

    const good = spawnSync(process.execPath, [join(__dirname, "codegraph-eval-harness.mjs"), "--eval", fixtureEvalPath, "--db", dbPath], { encoding: "utf8" });
    check("a clean run exits 0", good.status === 0, `exit=${good.status} stderr=${(good.stderr || "").slice(0, 200)}`);
  }
} catch (error) {
  if (error instanceof TestSkip) { skipped++; console.log(`  SKIP: ${error.message}`); }
  else { failed++; failures.push(`setup/end-to-end — ${error.message}`); }
} finally {
  if (db) db.close();
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