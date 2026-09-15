// Cost guardrail kill-switch (T-A5).
//
//   assertBudget({ spent, budget, label })  — check spend vs budget, write
//     .state/over-budget.json marker on breach, return STOP signal.
//   checkOverBudgetMarker()                 — pre-flight: does a prior breach
//     marker exist? Returns parsed content or null.
//   clearOverBudgetMarker()                 — reset for a new task.
//
// Squad launchers (bin/*.bat) cannot import ESM — they go through the CLI
// bridge at the bottom of this file (run from bin/_lib.bat before claude);
// scripts/launch.mjs imports the API directly.
//
// Marker file (.state/over-budget.json) is LOCAL only — never sent to Linear.
// Delete it manually to override: rm .state/over-budget.json
// or run: node scripts/cost-guard.mjs clear

import { writeFileSync, readFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, "..");
const STATE_DIR = join(root, ".state");
// Test plumbing (FOC-165): point the marker at a temp path without changing
// default behaviour — unset, the marker lives in <root>/.state as before.
// Read once at module load, so importers must set it before the first import.
const MARKER_PATH = process.env.COST_GUARD_MARKER_PATH
  ? resolve(process.env.COST_GUARD_MARKER_PATH)
  : join(STATE_DIR, "over-budget.json");
const MARKER_DIR = dirname(MARKER_PATH);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Assert that `spent` does not exceed `budget`.
 *
 * On ok:   returns `{ ok: true }`.
 * On breach: writes `.state/over-budget.json`, prints OVER-BUDGET to stderr,
 *            returns `{ stop: true, reason }`.
 *
 * @param {{ spent: number, budget: number, label?: string }} opts
 * @returns {{ ok: true } | { stop: true, reason: string }}
 */
export function assertBudget({ spent, budget, label = "task" }) {
  if (spent <= budget) return { ok: true };

  const reason = `OVER-BUDGET: spent $${spent.toFixed(2)} > budget $${budget.toFixed(2)} — STOP (${label})`;
  console.error("\n" + reason + "\n");

  // Write marker file so squads / subsequent sessions can detect the breach
  if (!existsSync(MARKER_DIR)) mkdirSync(MARKER_DIR, { recursive: true });
  writeFileSync(
    MARKER_PATH,
    JSON.stringify({ task: label, spent, budget, at: new Date().toISOString() }, null, 2) + "\n",
  );

  return { stop: true, reason };
}

/**
 * Pre-flight check: does a prior over-budget marker exist?
 * Returns the parsed marker object, or null if none / unreadable.
 *
 * @returns {{ task: string, spent: number, budget: number, at: string } | null}
 */
export function checkOverBudgetMarker() {
  try {
    if (existsSync(MARKER_PATH)) {
      return JSON.parse(readFileSync(MARKER_PATH, "utf8"));
    }
  } catch {
    // Corrupt marker — treat as absent
  }
  return null;
}

/**
 * Clear the over-budget marker (e.g. when a new task starts).
 */
export function clearOverBudgetMarker() {
  try {
    if (existsSync(MARKER_PATH)) unlinkSync(MARKER_PATH);
  } catch {
    // Already absent — no-op
  }
}

// ---------------------------------------------------------------------------
// CLI bridge — bin/_lib.bat runs `node scripts/cost-guard.mjs check` before
// claude starts (FOC-165). Exit contract (bin/_lib.bat blocks on >=1):
//   check — 0 no marker · 1 marker present (reason on stderr) · 2 usage error
//   clear — 0 marker deleted (or already absent)
// Importers (cost-report.mjs, launch.mjs) must see no side effects, hence the
// main-guard at the bottom.
// ---------------------------------------------------------------------------

function printUsage() {
  console.error(
    "usage: node scripts/cost-guard.mjs <check|clear>\n" +
    "  check — exit 0 when no over-budget marker exists, exit 1 (reason on\n" +
    "          stderr) when one does\n" +
    "  clear — delete the marker (resets the kill-switch)",
  );
}

function main() {
  const verb = process.argv[2];
  if (verb === "check") {
    const marker = checkOverBudgetMarker();
    if (!marker) process.exit(0);
    console.error(
      "\nOVER-BUDGET: launch blocked — .state/over-budget.json exists.\n" +
      `  Task:   ${marker.task}\n` +
      `  Spent:  $${Number(marker.spent).toFixed(2)}\n` +
      `  Budget: $${Number(marker.budget).toFixed(2)}\n` +
      `  At:     ${marker.at}\n` +
      "\nClear it (resets the kill-switch): node scripts/cost-guard.mjs clear\n",
    );
    process.exit(1);
  }
  if (verb === "clear") {
    clearOverBudgetMarker();
    process.exit(0);
  }
  printUsage();
  process.exit(2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
