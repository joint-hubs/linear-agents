// Run manifest helper — lightweight launcher instrumentation for telemetry.
//
// CLI:
//   node scripts/run-manifest.mjs gen-id <squad>
//   node scripts/run-manifest.mjs start <runId> <squad> [sourcePath]
//   node scripts/run-manifest.mjs end <runId> [exitCode]
//
// ESM, zero runtime deps (Node 18+).

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, "..");
const RUNS_DIR = join(root, ".state", "runs");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Ensure .state/runs/ exists. */
function ensureRunsDir() {
  if (!existsSync(RUNS_DIR)) mkdirSync(RUNS_DIR, { recursive: true });
}

/**
 * Atomically write a JSON file: write to a temp path, then rename over target.
 * Prevents partial reads by concurrent processes on most filesystems.
 */
function atomicWriteJSON(filePath, data) {
  const tmp = filePath + "." + randomBytes(4).readUInt32BE(0).toString(36);
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  renameSync(tmp, filePath);
}

/** Get current git branch, swallowing errors. */
function getGitBranch() {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      encoding: "utf8",
      cwd: root,
      timeout: 5000,
    }).trim();
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdGenId(squad) {
  if (!squad) {
    console.error("Usage: node scripts/run-manifest.mjs gen-id <squad>");
    process.exit(1);
  }
  const now = new Date().toISOString(); // "2026-06-25T13:02:07.000Z"
  const ts = now.replace(/:/g, "-").replace(/\.\d+Z$/, "");
  console.log(`${ts}-${squad}`);
}

function cmdStart(runId, squad, sourcePath) {
  if (!runId || !squad) {
    console.error("Usage: node scripts/run-manifest.mjs start <runId> <squad> [sourcePath]");
    process.exit(1);
  }

  const manifest = {
    runId,
    squad,
    source: sourcePath && sourcePath.length > 0 ? sourcePath : null,
    brief: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    cwd: process.cwd(),
    gitBranch: getGitBranch(),
    native: process.env.NATIVE !== undefined,
    interactive: true,
  };

  ensureRunsDir();
  const filePath = join(RUNS_DIR, `${runId}.json`);
  atomicWriteJSON(filePath, manifest);
}

function cmdEnd(runId, exitCodeStr) {
  if (!runId) {
    console.error("Usage: node scripts/run-manifest.mjs end <runId> [exitCode]");
    process.exit(1);
  }

  const filePath = join(RUNS_DIR, `${runId}.json`);
  if (!existsSync(filePath)) {
    console.error(`[run-manifest] Warning: manifest not found: ${filePath}`);
    process.exit(0);
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    console.error(`[run-manifest] Warning: could not parse manifest: ${filePath}`);
    process.exit(0);
  }

  const exitCode = exitCodeStr !== undefined && exitCodeStr.length > 0
    ? parseInt(exitCodeStr, 10)
    : null;

  manifest.endedAt = new Date().toISOString();
  manifest.exitCode = exitCode;
  atomicWriteJSON(filePath, manifest);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const command = process.argv[2];

switch (command) {
  case "gen-id":
    cmdGenId(process.argv[3]);
    break;
  case "start":
    cmdStart(process.argv[3], process.argv[4], process.argv[5]);
    break;
  case "end":
    cmdEnd(process.argv[3], process.argv[4]);
    break;
  default:
    console.error("Usage:");
    console.error("  node scripts/run-manifest.mjs gen-id <squad>");
    console.error("  node scripts/run-manifest.mjs start <runId> <squad> [sourcePath]");
    console.error("  node scripts/run-manifest.mjs end <runId> [exitCode]");
    process.exit(1);
}
