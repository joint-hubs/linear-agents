#!/usr/bin/env node
// scripts/codegraph-expert-brief.mjs — the codegraph-expert skill's
// deterministic consumption path for an eval-harness report (FOC-621).
//
// WHY THIS EXISTS. The skill (agents/_shared/skills/codegraph-expert/SKILL.md)
// advises on CodeGraph query craft and fallback, grounded in a report from
// scripts/codegraph-eval-harness.mjs (schema contract:
// docs/tools/codegraph-eval-harness.md). Advice that re-derived outcomes
// itself would be a second grader — the one implementation of the vocabulary
// is attributeOne in scripts/codegraph-trajectory.mjs, so this script imports
// OUTCOMES from it rather than carrying a private copy, and a vocabulary
// change flows through instead of silently diverging.
//
// DETERMINISM (same contract as the report itself): the output is a pure
// function of the report JSON — no wall-clock field, no collapsed success
// number, no baked-in counts; tools are walked sorted, outcome classes in
// OUTCOMES order. Two runs over the same report are byte-identical.
//
// PRIVACY (FOC-220): the report carries identifiers only, and this script
// echoes nothing but identifiers, tool names and counts.
//
// Run: node scripts/codegraph-expert-brief.mjs --report <report.json>
// Exit 0 = brief printed; exit 1 = missing/malformed report (JSON error).

import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { OUTCOMES } from "./codegraph-trajectory.mjs";
import { failJson } from "./supervisor-lib.mjs";

/**
 * Structural check of one codegraph-eval-harness report. Returns violations;
 * an empty array means the brief can be built from it.
 */
export function validateReport(report) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return ["the report is not a JSON object"];
  }
  const violations = [];
  if (report.report !== "codegraph-eval-harness") {
    violations.push(`report discriminator is ${JSON.stringify(report.report ?? null)}, expected "codegraph-eval-harness"`);
  }
  if (!Number.isInteger(report.schemaVersion)) violations.push("schemaVersion is not an integer");
  if (!report.byOutcome || typeof report.byOutcome !== "object" || Array.isArray(report.byOutcome)) {
    violations.push("byOutcome is missing or not an object");
  } else {
    for (const outcome of OUTCOMES) {
      if (typeof report.byOutcome[outcome] !== "number") violations.push(`byOutcome is missing the "${outcome}" count`);
    }
  }
  if (!report.byTool || typeof report.byTool !== "object" || Array.isArray(report.byTool)) {
    violations.push("byTool is missing or not an object");
  }
  if (!Array.isArray(report.queries)) violations.push("queries is missing or not an array");
  return violations;
}

const ADVICE = {
  fallback: (tool, n) =>
    `${tool}: ${n} graded fallback — the graph returned no usable answer and the agent went to the files. Check index freshness first (a stale or missing index is the usual cause), then query craft: name concrete symbols and files instead of asking a vague question.`,
  unused: (tool, n) =>
    `${tool}: ${n} graded unused — results came back but nothing returned was ever named. A graph answer is only worth its cost if a later tool call or the turn's prose names one of the returned identifiers; narrow the query to what you will actually use.`,
  unknown: (tool, n) =>
    `${tool}: ${n} graded unknown — nothing at all followed the query, so it cannot be judged. Always follow a graph query with the tool call or verdict that uses it; when nothing follows, the report refuses to guess.`,
};

/**
 * The advice brief, grounded in the report. Throws when the report is not a
 * codegraph-eval-harness report — the CLI turns that into a JSON error.
 */
export function buildBrief(report) {
  const violations = validateReport(report);
  if (violations.length) {
    throw new Error(`not a codegraph-eval-harness report:\n${violations.map((v) => `  - ${v}`).join("\n")}`);
  }

  const lines = [];
  lines.push(`codegraph-expert — advice grounded in the eval report: ${report.evalSet ?? "(unnamed eval set)"}`);
  lines.push("");
  lines.push("Outcome mix (all four classes, never collapsed):");
  lines.push(`  ${OUTCOMES.map((o) => `${o} ${report.byOutcome[o]}`).join(" · ")}`);
  lines.push("");
  lines.push("Per tool (sorted — the honest failures live here):");
  const tools = Object.keys(report.byTool).sort();
  if (!tools.length) lines.push("  (this report carries no per-tool breakdown)");
  for (const tool of tools) {
    const t = report.byTool[tool];
    lines.push(`  ${tool}: ${t.count} queries — ${OUTCOMES.map((o) => `${o} ${t.byOutcome?.[o] ?? 0}`).join(" · ")}`);
  }
  lines.push("");
  lines.push("What this says, and what to do about it:");
  for (const tool of tools) {
    const byOutcome = report.byTool[tool].byOutcome ?? {};
    for (const outcome of ["fallback", "unused", "unknown"]) {
      if ((byOutcome[outcome] ?? 0) > 0) lines.push(`  ${ADVICE[outcome](tool, byOutcome[outcome])}`);
    }
  }
  if (report.byOutcome.answered > 0) {
    lines.push(`  answered: ${report.byOutcome.answered} query results were later used — that is the working pattern; keep it.`);
  }
  const offenders = ["fallback", "unused", "unknown"]
    .map((outcome) => ({ outcome, ids: report.queries.filter((q) => q.outcome === outcome).map((q) => q.id) }))
    .filter(({ ids }) => ids.length > 0);
  if (offenders.length) {
    lines.push("");
    lines.push("Query ids behind the failing classes:");
    for (const { outcome, ids } of offenders) lines.push(`  ${outcome}: ${ids.join(", ")}`);
  }
  lines.push("");
  lines.push("Facts of this report, not opinions:");
  lines.push("  - the outcome vocabulary is graded by attributeOne in scripts/codegraph-trajectory.mjs — never re-derive it here.");
  lines.push("  - answered is sticky: evidence of use wins outright, and a later pass can only widen it.");
  lines.push("  - there is no score and no wall clock in this report by contract — the classes are the deliverable, never their sum.");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage(code = 2) {
  console.error(
    [
      "Usage: node scripts/codegraph-expert-brief.mjs --report <report.json>",
      "",
      "The codegraph-expert skill's deterministic consumption path: reads one",
      "codegraph-eval-harness report and prints the advice brief grounded in it",
      "(FOC-621). Exit 0 = brief printed; exit 1 = missing or malformed report.",
    ].join("\n"),
  );
  process.exit(code);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help")) usage(0);
  const flagIndex = argv.indexOf("--report");
  const reportPath = flagIndex >= 0 ? argv[flagIndex + 1] : null;
  if (!reportPath) failJson("--report <path> is required — point it at a codegraph-eval-harness report");
  if (!existsSync(reportPath)) failJson(`no such report: ${reportPath}`);
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch (err) {
    failJson(`${reportPath} is not readable JSON: ${err.message}`);
  }
  try {
    console.log(buildBrief(report));
  } catch (err) {
    failJson(err.message);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();