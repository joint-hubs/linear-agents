// Cost guardrail kill-switch (T-A5).
//
//   assertBudget({ spent, budget, label })  — check spend vs budget, write
//     .state/over-budget.json marker on breach, return STOP signal.
//   checkOverBudgetMarker()                 — pre-flight: does a prior breach
//     marker exist? Returns parsed content or null.
//   clearOverBudgetMarker()                 — reset for a new task.
//
// Squad launchers (agent.bat, dev.bat, etc.) can source this via Node:
//   import { assertBudget, checkOverBudgetMarker } from "./cost-guard.mjs";
//
// Marker file (.state/over-budget.json) is LOCAL only — never sent to Linear.
// Delete it manually to override: rm .state/over-budget.json

import { writeFileSync, readFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, "..");
const STATE_DIR = join(root, ".state");
const MARKER_PATH = join(STATE_DIR, "over-budget.json");

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
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
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
