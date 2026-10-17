// REVIEW squad round counter — wraps utils.reviewRound.
// `next` increments (escalated at max), `peek` reads without mutating, `reset` clears all.
//
// FOC-903: in a supervised run (`LA_SUPERVISOR_RUN`) the counter lives per run
// (`<runDir>/review-rounds.json`) and round files under `<runDir>/scratch/reviews/`;
// standalone squads keep the legacy `.state/` locations. `peek` therefore reads
// the union of every run's counter (newest run wins per task) with the legacy
// global file as the fallback.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { reviewRound, resetReviewRounds } from "./utils.mjs";
import { collectRunScratch } from "./supervisor-lib.mjs";
import { stateRoot } from "./fenix-paths.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function usage(exitCode) {
  process.stderr.write(`Usage:
  node scripts/review-round.mjs next <taskId> [--max N]   Increment round, print {round,status}
  node scripts/review-round.mjs peek <taskId> [--max N]   Read current round without mutating
  node scripts/review-round.mjs reset                     Clear all review rounds
`);
  process.exit(exitCode);
}

function parseMaxArg(args) {
  const idx = args.indexOf("--max");
  if (idx === -1 || idx + 1 >= args.length) return 2;
  const n = parseInt(args[idx + 1], 10);
  return Number.isFinite(n) && n >= 1 ? n : 2;
}

function stripMaxArg(args) {
  return args.filter((a) => a !== "--max").filter((a) => a === "--max" || !/^\d+$/.test(a));
  // ^ crude but effective: remove --max and the digit that follows it
}

// ---------------------------------------------------------------------------
// Peek — the union of every run's counter, legacy file as fallback, no mutation
// ---------------------------------------------------------------------------

function peek(taskId, maxRounds) {
  let round = collectRunScratch().rounds.get(taskId)?.round ?? 0;
  if (!round) {
    // Legacy fallback: the task carries no per-run counter — read the global
    // file exactly as before (the state-root seam, LA_STATE_ROOT aware).
    const storePath = join(stateRoot(), "review-rounds.json");
    if (existsSync(storePath)) {
      try {
        const data = JSON.parse(readFileSync(storePath, "utf8"));
        round = typeof data[taskId] === "number" ? data[taskId] : 0;
      } catch {
        // corrupt or unparseable — treat as empty
      }
    }
  }
  const status = round >= maxRounds ? "escalated" : "review";
  return { round, status };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (args.length === 0) usage(2);

const subcommand = args[0];

switch (subcommand) {
  case "next": {
    const taskId = args[1];
    if (!taskId || taskId.startsWith("--")) {
      process.stderr.write("Error: <taskId> is required for 'next'.\n");
      usage(2);
    }
    const maxRounds = parseMaxArg(args);
    const result = reviewRound({ taskId, maxRounds });
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exit(0);
    break;
  }

  case "peek": {
    const taskId = args[1];
    if (!taskId || taskId.startsWith("--")) {
      process.stderr.write("Error: <taskId> is required for 'peek'.\n");
      usage(2);
    }
    const maxRounds = parseMaxArg(args);
    const result = peek(taskId, maxRounds);
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exit(0);
    break;
  }

  case "reset": {
    resetReviewRounds();
    process.stdout.write(JSON.stringify({ reset: true }) + "\n");
    process.exit(0);
    break;
  }

  default:
    process.stderr.write(`Error: unknown subcommand '${subcommand}'.\n`);
    usage(2);
}
