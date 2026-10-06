// Contract test for the codegraph-expert skill's report consumption path
// (FOC-621): scripts/codegraph-expert-brief.mjs + the skill's SKILL.md.
//
// What is pinned, and why it can fail loudly:
//   - GROUNDED (AC): the brief's output names what the report actually says —
//     a per-tool failure in byTool must surface as that tool named together
//     with its failing outcome; a brief that reports "answered" where the
//     report says "fallback" is a fail, not a nuance;
//   - NO SCORE, NO WALL CLOCK (frozen decision): the output carries no
//     collapsed success number and no wall-clock field — the four outcome
//     classes are the deliverable, never their sum;
//   - VOCABULARY SINGLE-SOURCE (frozen decision): the outcome vocabulary has
//     one implementation, OUTCOMES in scripts/codegraph-trajectory.mjs. The
//     script imports it (no private copy in code), and the SKILL.md must name
//     every class OUTCOMES carries — so changing attributeOne's vocabulary
//     breaks THIS test instead of silently diverging;
//   - NO BAKED-IN COUNTS (frozen decision): the skill never hard-codes a
//     count, not even in a prose example — the live report is the only
//     source of numbers.
//
// HERMETIC. The fixture report is a hand-built JSON object written under a
// mkdtemp dir; no telemetry DB is opened, no live .state is touched.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import { OUTCOMES } from "./codegraph-trajectory.mjs";
import { buildBrief, validateReport } from "./codegraph-expert-brief.mjs";

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) { passed++; return; }
  failed++;
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

function section(title) {
  console.log(`\n--- ${title} ---`);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const temp = mkdtempSync(join(tmpdir(), "foc-621-brief-"));
const SKILL_PATH = join(__dirname, "..", "agents", "_shared", "skills", "codegraph-expert", "SKILL.md");
const SCRIPT_PATH = join(__dirname, "codegraph-expert-brief.mjs");

// ---------------------------------------------------------------------------
// Fixture — a hand-built report in the contract shape
// (docs/tools/codegraph-eval-harness.md). Identifiers only, per FOC-220.
// ---------------------------------------------------------------------------

const byOutcome = { answered: 2, fallback: 2, unused: 1, unknown: 0 };
const fixtureReport = {
  report: "codegraph-eval-harness",
  schemaVersion: 1,
  evalSet: "fixture — FOC-621 codegraph-expert consumption test",
  evalSetDescription: "hand-built fixture; identifiers only",
  byOutcome,
  byTool: {
    explore: { count: 4, byOutcome: { answered: 2, fallback: 0, unused: 1, unknown: 0 } },
    node: { count: 2, byOutcome: { answered: 0, fallback: 2, unused: 0, unknown: 0 } },
  },
  tokenUsage: { entriesWithIssuingTurnUsage: 3, note: "fixture note" },
  queries: [
    {
      id: "q-fixture-explore-used", tool: "explore", outcome: "answered",
      freshness: "fresh", graphAnswered: true,
      returnedIdentifiers: { files: ["scripts/telemetry-ingest.mjs"], symbols: ["ingestToolFactsRange"] },
      usedIdentifiers: { files: ["scripts/telemetry-ingest.mjs"], symbols: [] },
      returnedCount: 2, usedCount: 1, trajectoryToolCalls: 2, issuingTurnUsage: null,
    },
    {
      id: "q-fixture-explore-shelved", tool: "explore", outcome: "unused",
      freshness: "fresh", graphAnswered: true,
      returnedIdentifiers: { files: [], symbols: ["wakeQueueMaxSeq"] },
      usedIdentifiers: { files: [], symbols: [] },
      returnedCount: 1, usedCount: 0, trajectoryToolCalls: 3, issuingTurnUsage: null,
    },
    {
      id: "q-fixture-node-refused", tool: "node", outcome: "fallback",
      freshness: "stale", graphAnswered: false,
      returnedIdentifiers: { files: [], symbols: [] },
      usedIdentifiers: { files: [], symbols: [] },
      returnedCount: 0, usedCount: 0, trajectoryToolCalls: 2, issuingTurnUsage: null,
    },
    {
      id: "q-fixture-node-stale", tool: "node", outcome: "fallback",
      freshness: "unknown", graphAnswered: false,
      returnedIdentifiers: { files: [], symbols: [] },
      usedIdentifiers: { files: [], symbols: [] },
      returnedCount: 0, usedCount: 0, trajectoryToolCalls: 2, issuingTurnUsage: null,
    },
    {
      id: "q-fixture-explore-cited", tool: "explore", outcome: "answered",
      freshness: "fresh", graphAnswered: true,
      returnedIdentifiers: { files: [], symbols: ["patchTurn"] },
      usedIdentifiers: { files: [], symbols: ["patchTurn"] },
      returnedCount: 1, usedCount: 1, trajectoryToolCalls: 1, issuingTurnUsage: null,
    },
  ],
};

try {
  // ---------------------------------------------------------------------------
  // A. validateReport — the brief refuses what is not the contract shape
  // ---------------------------------------------------------------------------

  section("A. validateReport — shape refusals");

  {
    check("a well-formed fixture report has no violations", validateReport(fixtureReport).length === 0,
      JSON.stringify(validateReport(fixtureReport)));
    check("a non-object is refused", validateReport("nope").length === 1);
    check("a wrong discriminator is refused",
      validateReport({ ...fixtureReport, report: "something-else" }).some((v) => v.includes("discriminator")));
    check("a byOutcome missing one class is refused",
      validateReport({ ...fixtureReport, byOutcome: { answered: 1, fallback: 0, unused: 0 } }).some((v) => v.includes('missing the "unknown" count')),
      "the all-four-keys rule is the contract, not a nicety");
    check("a missing queries array is refused", validateReport({ ...fixtureReport, queries: undefined }).some((v) => v.includes("queries")));
  }

  // ---------------------------------------------------------------------------
  // B. buildBrief — grounded in the report, per-tool failures named (AC-a)
  // ---------------------------------------------------------------------------

  section("B. buildBrief — names what the report says");

  {
    const brief = buildBrief(fixtureReport);

    check("the brief names the per-tool failure the report carries (node graded fallback)",
      /node: 2 queries.*fallback 2/.test(brief) && /node: 2 graded fallback/.test(brief),
      "a brief saying 'answered' where the report says fallback is a fail");
    check("the brief names the per-tool working pattern",
      /explore: 4 queries.*answered 2/.test(brief));
    check("the brief carries the full outcome mix",
      OUTCOMES.every((o) => brief.includes(`${o} ${byOutcome[o]}`)), JSON.stringify(byOutcome));
    check("the brief names the failing query ids",
      ["q-fixture-node-refused", "q-fixture-node-stale", "q-fixture-explore-shelved"].every((id) => brief.includes(id)));
    check("the brief does NOT name an identifier the report never returned",
      !brief.includes("no-such-identifier"));
    check("every tool in byTool appears in the brief, sorted",
      brief.indexOf("explore: 4") < brief.indexOf("node: 2"));
  }

  // ---------------------------------------------------------------------------
  // C. No score, no wall clock (AC-b)
  // ---------------------------------------------------------------------------

  section("C. no collapsed success number, no wall clock");

  {
    const brief = buildBrief(fixtureReport);
    check("no collapsed success number exists in the output",
      !/successRate|passRate|"score"|overallSuccess/i.test(brief));
    check("no wall-clock field exists in the output",
      !/generatedAt|"timestamp"|"ts"|elapsedMs|durationMs/i.test(brief));
  }

  // ---------------------------------------------------------------------------
  // D. Determinism — a pure function of the report
  // ---------------------------------------------------------------------------

  section("D. determinism");

  {
    check("two builds over the same report are byte-identical", buildBrief(fixtureReport) === buildBrief(fixtureReport));
    const reordered = { ...fixtureReport, byTool: { node: fixtureReport.byTool.node, explore: fixtureReport.byTool.explore } };
    check("byTool key order on input cannot change the output", buildBrief(reordered) === buildBrief(fixtureReport));
  }

  // ---------------------------------------------------------------------------
  // E. Vocabulary single-source (AC-c) — OUTCOMES owns the class list
  // ---------------------------------------------------------------------------

  section("E. vocabulary single-source");

  {
    const skill = readFileSync(SKILL_PATH, "utf8");
    const script = readFileSync(SCRIPT_PATH, "utf8");

    check("the script imports OUTCOMES from codegraph-trajectory.mjs — no private copy in code",
      script.includes('import { OUTCOMES } from "./codegraph-trajectory.mjs"'));
    check("the script defines no literal outcome array of its own",
      !/\[\s*"answered"\s*,/.test(script));

    // Every class OUTCOMES carries must be named by the skill text. Renaming
    // or dropping a class in attributeOne's vocabulary breaks this assertion
    // — the divergence is loud, not silent.
    for (const outcome of OUTCOMES) {
      check(`the skill names the "${outcome}" class`, skill.includes(outcome));
    }
    check("the skill carries no quoted array-literal copy of the class list",
      !/"answered"\s*,\s*"fallback"/.test(skill) && !/OUTCOMES\s*=/.test(skill));
    check("the skill carries no outcome-adjacent count (no baked-in numbers)",
      !OUTCOMES.some((o) => new RegExp(`${o}[^.\\n]{0,60}?\\d`).test(skill)),
      "the live report is the only source of numbers");
    check("the skill carries no wall-clock field name",
      !/generatedAt|elapsedMs|durationMs/i.test(skill));
    check("the skill defers to the consumption path instead of re-grading",
      skill.includes("codegraph-expert-brief.mjs"));
  }

  // ---------------------------------------------------------------------------
  // F. CLI — exit codes and the JSON error contract
  // ---------------------------------------------------------------------------

  section("F. CLI");

  {
    const reportPath = join(temp, "report.json");
    writeFileSync(reportPath, JSON.stringify(fixtureReport, null, 2) + "\n", "utf8");

    const good = spawnSync(process.execPath, [SCRIPT_PATH, "--report", reportPath], { encoding: "utf8" });
    check("a clean run exits 0", good.status === 0, `exit=${good.status} stderr=${(good.stderr || "").slice(0, 200)}`);
    check("the CLI output names the per-tool failure too", (good.stdout || "").includes("node: 2 graded fallback"));

    const malformedPath = join(temp, "malformed.json");
    writeFileSync(malformedPath, JSON.stringify({ report: "not-the-harness" }) + "\n", "utf8");
    const bad = spawnSync(process.execPath, [SCRIPT_PATH, "--report", malformedPath], { encoding: "utf8" });
    check("a malformed report exits 1", bad.status === 1, `exit=${bad.status}`);
    check("the refusal is a JSON error contract", (() => {
      try { return JSON.parse(bad.stdout).ok === false; } catch { return false; }
    })(), (bad.stdout || "").slice(0, 120));

    const missing = spawnSync(process.execPath, [SCRIPT_PATH, "--report", join(temp, "nope.json")], { encoding: "utf8" });
    check("a missing report file exits 1", missing.status === 1);

    const noFlag = spawnSync(process.execPath, [SCRIPT_PATH], { encoding: "utf8" });
    check("a run without --report exits 1", noFlag.status === 1);
  }
} catch (error) {
  failed++;
  failures.push(`setup/end-to-end — ${error.message}`);
} finally {
  try {
    rmSync(temp, { recursive: true, force: true });
  } catch {
    // best-effort temp cleanup; a leftover tmpdir is not a test failure
  }
}

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
for (const f of failures) console.error(`FAIL: ${f}`);
process.exit(failed > 0 ? 1 : 0);