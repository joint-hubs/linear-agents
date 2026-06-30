#!/usr/bin/env node
/**
 * scripts/publish-linear-comment.mjs — Render and publish a run summary as a Linear comment.
 *
 * One shared helper that all squads call. Renders a standard comment body from
 * data, then delegates the actual post to scripts/linear-ops.mjs comment (which
 * handles dedup via the first-line marker and GraphQL).
 *
 * Usage:
 *   node scripts/publish-linear-comment.mjs --issue <id> --tag <tag> --squad <name> --what <desc> \
 *     [--run-id <id>] [--state-file <path>] [--next <text>] [--body-file <path>] \
 *     [--tier T1|T2|T3] --summary <bullet> [--summary <bullet> ...]
 *
 * Dependencies: Node 18+. No npm install required.
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// CLI argument parser
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const args = { summary: [] };
  const rest = [];

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--issue" && i + 1 < argv.length) {
      args.issue = argv[++i];
    } else if (a === "--tag" && i + 1 < argv.length) {
      args.tag = argv[++i];
    } else if (a === "--squad" && i + 1 < argv.length) {
      args.squad = argv[++i];
    } else if (a === "--what" && i + 1 < argv.length) {
      args.what = argv[++i];
    } else if (a === "--run-id" && i + 1 < argv.length) {
      args.runId = argv[++i];
    } else if (a === "--state-file" && i + 1 < argv.length) {
      args.stateFile = argv[++i];
    } else if (a === "--next" && i + 1 < argv.length) {
      args.next = argv[++i];
    } else if (a === "--body-file" && i + 1 < argv.length) {
      args.bodyFile = argv[++i];
    } else if (a === "--tier" && i + 1 < argv.length) {
      args.tier = argv[++i];
    } else if (a === "--summary" && i + 1 < argv.length) {
      args.summary.push(argv[++i]);
    } else if (a === "--help" || a === "-h") {
      args.help = true;
    } else if (a.startsWith("--")) {
      // Unknown flag — skip
    } else {
      rest.push(a);
    }
  }

  args._ = rest;
  return args;
}

function printUsage() {
  console.error("Usage:");
  console.error("  node scripts/publish-linear-comment.mjs --issue <id> --tag <tag> --squad <name> --what <desc> \\");
  console.error("    [--run-id <id>] [--state-file <path>] [--next <text>] [--body-file <path>] \\");
  console.error("    [--tier T1|T2|T3] --summary <bullet> [--summary <bullet> ...]");
}

// ---------------------------------------------------------------------------
// Body rendering
// ---------------------------------------------------------------------------

const TIER_FOOTER = {
  T1: (stateFile) => `_Pełny artefakt: ${stateFile} (committed in repo)_`,
  T2: (runId) => `_Pełna treść inline powyżej (artefakt w .state/runs/${runId}/, gitignored)_`,
  T3: () => `_Digest inline powyżej; mirror opcjonalny w docs/digests/_`,
};

/**
 * Render the standard comment body.
 * @param {{ issue: string, tag: string, squad: string, what: string,
 *   runId?: string, stateFile?: string, next?: string,
 *   extraBody?: string, tier?: string, summary: string[] }} opts
 * @returns {string}
 */
export function renderBody({ issue, tag, squad, what, runId, stateFile, next, extraBody, tier, summary }) {
  const t = tier || "T2";
  const lines = [];

  // First line MUST be exactly the dedup marker (no leading whitespace)
  lines.push(`<!-- run:${tag} -->`);

  // Header
  const runIdStr = runId || "—";
  lines.push(`## ${squad} · ${what} · ${runIdStr}`);
  lines.push("");

  // Fields table
  const when = new Date().toISOString();
  const sf = stateFile || "—";
  lines.push("| Field | Value |");
  lines.push("|---|---|");
  lines.push(`| **Issue** | ${issue} |`);
  lines.push(`| **Squad** | ${squad} |`);
  lines.push(`| **When** | ${when} |`);
  lines.push(`| **State file** | ${sf} |`);
  lines.push("");

  // Summary bullets
  lines.push("### Skrót");
  for (const bullet of summary || []) {
    lines.push(`- ${bullet}`);
  }
  lines.push("");

  // Next steps
  lines.push("### Co dalej");
  lines.push(next || "—");
  lines.push("");

  // Separator
  lines.push("---");
  lines.push("");

  // Tier footer
  const footerFn = TIER_FOOTER[t] || TIER_FOOTER.T2;
  const footerArg = t === "T1" ? sf : runIdStr;
  lines.push(footerFn(footerArg));

  // Optional extra body
  if (extraBody) {
    lines.push("");
    lines.push(extraBody);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// pisi guard
// ---------------------------------------------------------------------------

/**
 * If LINEAR_WORKSPACE is "pisi", print dry-run plan and return true.
 * Caller should exit 0 when this returns true.
 * @param {string} body
 * @returns {boolean}
 */
export function pisiGuard(body) {
  if (process.env.LINEAR_WORKSPACE === "pisi") {
    console.log("=== DRY-RUN PLAN (pisi read-only) ===");
    console.log(body);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    printUsage();
    process.exit(2);
  }

  // Validate required args
  if (!args.issue || !args.tag || !args.squad || !args.what) {
    printUsage();
    process.exit(2);
  }

  // Read extra body file if provided
  let extraBody = null;
  if (args.bodyFile) {
    try {
      extraBody = readFileSync(args.bodyFile, "utf8");
    } catch (err) {
      console.error(`Error reading --body-file "${args.bodyFile}": ${err.message}`);
      process.exit(1);
    }
  }

  const body = renderBody({
    issue: args.issue,
    tag: args.tag,
    squad: args.squad,
    what: args.what,
    runId: args.runId,
    stateFile: args.stateFile,
    next: args.next,
    extraBody,
    tier: args.tier,
    summary: args.summary,
  });

  // pisi guard — dry-run only, no write
  if (pisiGuard(body)) {
    process.exit(0);
  }

  // Write body to temp file
  const tmpDir = mkdtempSync(join(tmpdir(), "linear-comment-"));
  const tmpFile = join(tmpDir, "body.md");
  writeFileSync(tmpFile, body, "utf8");

  let exitCode = 3;
  try {
    const result = spawnSync("node", [
      "scripts/linear-ops.mjs", "comment", args.issue,
      "--body-file", tmpFile,
      "--dedup-tag", args.tag,
    ], { stdio: "inherit" });
    exitCode = result.status !== null ? result.status : 3;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  process.exit(exitCode);
}

// Guard: only run main() when called directly
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  main();
}
