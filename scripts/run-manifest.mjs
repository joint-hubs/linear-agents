// Run manifest helper — lightweight launcher instrumentation for telemetry.
//
// CLI:
//   node scripts/run-manifest.mjs gen-id <squad>
//   node scripts/run-manifest.mjs start <runId> <squad> [sourcePath]
//   node scripts/run-manifest.mjs end <runId> [exitCode]
//
// ESM, zero runtime deps (Node 18+).

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, statSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
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
    taskId: process.env.LA_TASK_ID || null,
    taskIdAuto: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    cwd: process.cwd(),
    gitBranch: getGitBranch(),
    native: process.env.NATIVE !== undefined,
    interactive: true,
    claudeConfigDir: process.env.CLAUDE_CONFIG_DIR || null,
  };

  ensureRunsDir();
  const filePath = join(RUNS_DIR, `${runId}.json`);
  atomicWriteJSON(filePath, manifest);
}

function cmdTag(runId, taskId) {
  if (!runId || !taskId) {
    console.error("Usage: node scripts/run-manifest.mjs tag <runId> <taskId>");
    process.exit(1);
  }

  const filePath = join(RUNS_DIR, `${runId}.json`);
  if (!existsSync(filePath)) {
    process.exit(0); // idempotent, non-fatal
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    process.exit(0);
  }

  const normalized = normalizeTaskId(taskId);

  if (manifest.taskId === null) {
    manifest.taskIdAuto = normalized;
  }
  // else: explicit env tag wins — leave taskIdAuto unchanged

  atomicWriteJSON(filePath, manifest);
}

function cmdSetTask(runId, taskId) {
  if (!runId || !taskId) {
    console.error("Usage: node scripts/run-manifest.mjs set-task <runId> <taskId>");
    process.exit(1);
  }

  const filePath = join(RUNS_DIR, `${runId}.json`);
  if (!existsSync(filePath)) {
    console.error(`set-task: manifest not found: ${runId}`);
    process.exit(0);
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    console.error(`set-task: manifest not found: ${runId}`);
    process.exit(0);
  }

  manifest.taskId = normalizeTaskId(taskId);
  atomicWriteJSON(filePath, manifest);
}

/** Normalize a task id: uppercase if it matches /^[A-Za-z]+-\d+$/, else warn on stderr. */
function normalizeTaskId(taskId) {
  const trimmed = taskId.trim();
  if (/^[A-Za-z]+-\d+$/.test(trimmed)) {
    return trimmed.toUpperCase();
  }
  console.error(`tag: invalid task id format "${taskId}", storing as-is`);
  return trimmed;
}

async function cmdEnd(runId, exitCodeStr) {
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

  // Discover squad session transcript
  try {
    const { cwdToHashName } = await import("./ledger.mjs");

    // Capture claudeConfigDir from env if not set at start time
    // (launcher .bat files set CLAUDE_CONFIG_DIR after _lib.bat runs start)
    if (!manifest.claudeConfigDir) {
      manifest.claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || null;
    }

    // Build candidate roots for transcript discovery.
    // Squad launchers set CLAUDE_CONFIG_DIR=agents/<squad>, so the squad's
    // claude subprocess writes its transcript to <claudeConfigDir>/projects/<hash>/,
    // NOT to ~/.claude/projects/<hash>/.
    const hashName = cwdToHashName(manifest.cwd || process.cwd());
    const candidateRoots = [];

    // Root A: squad's config dir (if set) — e.g. agents/plan/projects/<hash>/
    if (manifest.claudeConfigDir) {
      const resolvedConfigDir = resolve(manifest.cwd || process.cwd(), manifest.claudeConfigDir);
      candidateRoots.push(join(resolvedConfigDir, "projects", hashName));
    }

    // Root B: default ~/.claude/projects/<hash>/
    candidateRoots.push(join(homedir(), ".claude", "projects", hashName));

    // Collect top-level *.jsonl files from all candidate roots (skip subagents/ dirs)
    const allFiles = [];
    for (const rootDir of candidateRoots) {
      if (!existsSync(rootDir)) continue;
      const entries = readdirSync(rootDir).filter(
        (f) => f.endsWith(".jsonl") && statSync(join(rootDir, f)).isFile(),
      );
      for (const f of entries) {
        allFiles.push({ file: f, rootDir });
      }
    }

    if (allFiles.length > 0) {
      const startedAt = new Date(manifest.startedAt).getTime();
      const endedAt = new Date(manifest.endedAt).getTime();
      const birthWindowStart = startedAt - 30 * 1000;
      const birthWindowEnd = endedAt + 60 * 1000;
      // Content-based fallback window: wider, since the session may have started before the run
      const contentWindowStart = startedAt - 5 * 1000;
      const contentWindowEnd = endedAt + 60 * 1000;

      // --- Pass 1: birthtime fast path ---
      const candidates = [];
      for (const { file, rootDir } of allFiles) {
        const absPath = join(rootDir, file);
        const stats = statSync(absPath);
        const birthtime =
          stats.birthtime && stats.birthtime.getTime()
            ? stats.birthtime.getTime()
            : stats.mtime.getTime();
        if (birthtime >= birthWindowStart && birthtime <= birthWindowEnd) {
          candidates.push({ file, rootDir, birthtime, diff: Math.abs(birthtime - startedAt) });
        }
      }

      if (candidates.length > 0) {
        // Sort by closest to startedAt, tie-break by newest birthtime
        candidates.sort((a, b) => a.diff - b.diff || b.birthtime - a.birthtime);
        const best = candidates[0];
        manifest.sessionId = best.file.replace(/\.jsonl$/, "");
        manifest.transcriptPath = join(best.rootDir, best.file);
        manifest.sessionAmbiguous =
          candidates.length > 1 && candidates[1].diff - best.diff < 2000;
      } else {
        // --- Pass 2: content-based fallback ---
        // The claude CLI may reuse an existing session whose birthtime predates the run.
        // Scan each transcript for a timestamp within the run window [startedAt, endedAt+60s].
        const contentCandidates = [];
        for (const { file, rootDir } of allFiles) {
          const absPath = join(rootDir, file);
          try {
            const allLines = readFileSync(absPath, "utf8").split("\n").filter(Boolean);
            for (const raw of allLines) {
              let line;
              try { line = JSON.parse(raw); } catch { continue; }
              if (line && line.timestamp) {
                const ts = new Date(line.timestamp).getTime();
                if (ts >= contentWindowStart && ts <= contentWindowEnd) {
                  contentCandidates.push({ file, rootDir, ts, diff: Math.abs(ts - startedAt) });
                  break; // first in-window timestamp for this file
                }
              }
            }
          } catch {
            continue; // skip unreadable files
          }
        }

        if (contentCandidates.length > 0) {
          contentCandidates.sort((a, b) => a.diff - b.diff || b.ts - a.ts);
          const best = contentCandidates[0];
          manifest.sessionId = best.file.replace(/\.jsonl$/, "");
          manifest.transcriptPath = join(best.rootDir, best.file);
          manifest.sessionAmbiguous =
            contentCandidates.length > 1 && contentCandidates[1].diff - best.diff < 2000;
        } else {
          manifest.sessionId = null;
          console.error(
            `[run-manifest] Warning: no session transcript found for run ${runId} (will fall back to window match)`,
          );
        }
      }
    }
  } catch (err) {
    console.error(`[run-manifest] Warning: transcript discovery failed: ${err.message}`);
  }

  atomicWriteJSON(filePath, manifest);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const command = process.argv[2];

(async () => {
  switch (command) {
    case "gen-id":
      cmdGenId(process.argv[3]);
      break;
    case "start":
      cmdStart(process.argv[3], process.argv[4], process.argv[5]);
      break;
    case "end":
      await cmdEnd(process.argv[3], process.argv[4]);
      break;
    case "tag":
      cmdTag(process.argv[3], process.argv[4]);
      break;
    case "set-task":
      cmdSetTask(process.argv[3], process.argv[4]);
      break;
    default:
      console.error("Usage:");
      console.error("  node scripts/run-manifest.mjs gen-id <squad>");
      console.error("  node scripts/run-manifest.mjs start <runId> <squad> [sourcePath]");
      console.error("  node scripts/run-manifest.mjs end <runId> [exitCode]");
      console.error("  node scripts/run-manifest.mjs tag <runId> <taskId>");
      console.error("  node scripts/run-manifest.mjs set-task <runId> <taskId>");
      process.exit(1);
  }
})();
