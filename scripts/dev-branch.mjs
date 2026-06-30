#!/usr/bin/env node
/**
 * scripts/dev-branch.mjs — DEV branch helper: naming + checkout.
 *
 * DEV branch helper — no push, no destructive git; rebase existing branch onto main if it exists.
 *
 * Branch convention: <teamKeyLower>-<number>-<slug>
 *   e.g. FEN-30 + slug "gantt-snapshot" → fen-30-gantt-snapshot
 *
 * Subcommands:
 *   name <identifier> [slug] [--team-key <KEY>]
 *       Print branch name to stdout, no git ops.
 *   start <identifier> [slug] [--team-key <KEY>] [--base <git-ref>] [--dry-run]
 *       Create branch from <base> (default: current HEAD), or checkout + rebase existing.
 *
 * Dependencies: Node 18+, zero npm deps.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { loadEnv } from "./linear-client.mjs";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, "..");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sanitize a slug: lowercase, trim, replace any run of non-[a-z0-9] with
 * single hyphen, strip leading/trailing hyphen. Returns "task" if empty.
 */
function sanitizeSlug(raw) {
  if (!raw || !raw.trim()) return "task";
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "task";
}

/**
 * Parse identifier like "FEN-30" into { key, number }.
 * Validates /^[A-Z]+-\d+$/i — exits 2 on mismatch.
 */
function parseIdentifier(id) {
  const m = String(id).match(/^([A-Za-z]+)-(\d+)$/);
  if (!m) {
    console.error(`Invalid identifier: ${id} (expected TEAM-NUM)`);
    process.exit(2);
  }
  return { key: m[1], number: m[2] };
}

/**
 * Resolve team key: --team-key flag > env LINEAR_TEAM_KEY > default "fen".
 * Prints a stderr note when falling back to default.
 */
function resolveTeamKey(teamKeyFlag) {
  if (teamKeyFlag) return teamKeyFlag;
  if (process.env.LINEAR_TEAM_KEY) return process.env.LINEAR_TEAM_KEY;
  console.error("[dev-branch] LINEAR_TEAM_KEY not set, defaulting to FEN");
  return "fen";
}

/** Build branch name from identifier, optional slug, and optional team-key override. */
function buildBranchName(identifier, slug, teamKeyFlag) {
  const { key, number } = parseIdentifier(identifier);
  const teamKey = resolveTeamKey(teamKeyFlag).toLowerCase();
  const safeSlug = sanitizeSlug(slug);
  return `${teamKey}-${number}-${safeSlug}`;
}

/**
 * Resolve the git ref to use as branch base.
 * Defaults to current HEAD. When --base is provided, validates it resolves.
 * Exits 1 on failure.
 */
function resolveBaseRef(baseFlag) {
  if (baseFlag) {
    try {
      execFileSync("git", ["rev-parse", "--verify", baseFlag], {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      console.error(`[dev-branch] --base '${baseFlag}' does not resolve to a valid git ref`);
      process.exit(1);
    }
    return baseFlag;
  }

  // Default: current HEAD
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    }).toString().trim();
  } catch {
    console.error(`[dev-branch] failed to resolve current HEAD`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

/** `name` subcommand: print branch name to stdout only. */
function cmdName(identifier, slug, teamKeyFlag) {
  const branch = buildBranchName(identifier, slug, teamKeyFlag);
  console.log(branch);
}

/** `start` subcommand: create branch from baseRef, or checkout + rebase existing. */
function cmdStart(identifier, slug, teamKeyFlag, dryRun, baseRef) {
  const branch = buildBranchName(identifier, slug, teamKeyFlag);

  if (dryRun) {
    console.log(`git checkout -b ${branch} ${baseRef}`);
    console.log(`# (if ${branch} exists locally: git checkout ${branch} && git rebase ${baseRef})`);
    return;
  }

  // Attempt to create the branch from baseRef
  try {
    execFileSync("git", ["checkout", "-b", branch, baseRef], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    console.log(`branch: ${branch}`);
    return;
  } catch (createErr) {
    const stderr = (createErr.stderr || "").toString().toLowerCase();

    // Branch already exists locally — checkout and rebase onto baseRef
    if (stderr.includes("already exists")) {
      try {
        execFileSync("git", ["checkout", branch], {
          cwd: root,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (checkoutErr) {
        const msg = (checkoutErr.stderr || "").toString().trim();
        console.error(`[dev-branch] git checkout ${branch} failed: ${msg}`);
        process.exit(1);
      }

      try {
        execFileSync("git", ["rebase", baseRef], {
          cwd: root,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (rebaseErr) {
        const msg = (rebaseErr.stderr || "").toString().trim();
        console.error(`[dev-branch] rebase onto ${baseRef} failed — resolve manually`);
        if (msg) console.error(`  stderr: ${msg}`);
        process.exit(1);
      }

      console.log(`branch: ${branch}`);
      return;
    }

    // Unexpected error
    const msg = (createErr.stderr || "").toString().trim();
    console.error(`[dev-branch] git checkout -b ${branch} ${baseRef} failed: ${msg}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  loadEnv();

  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error("Usage:");
    console.error("  node scripts/dev-branch.mjs name <identifier> [slug] [--team-key <KEY>]");
    console.error("  node scripts/dev-branch.mjs start <identifier> [slug] [--team-key <KEY>] [--base <git-ref>] [--dry-run]");
    process.exit(2);
  }

  const subcommand = args[0];
  const identifier = args[1];

  // Parse optional slug and flags from remaining args
  let slug = null;
  let teamKeyFlag = null;
  let baseFlag = null;
  let dryRun = false;

  for (let i = 2; i < args.length; i++) {
    if (args[i] === "--team-key" && i + 1 < args.length) {
      teamKeyFlag = args[++i];
    } else if (args[i] === "--base" && i + 1 < args.length) {
      baseFlag = args[++i];
    } else if (args[i] === "--dry-run") {
      dryRun = true;
    } else if (slug === null) {
      slug = args[i];
    }
  }

  switch (subcommand) {
    case "name":
      cmdName(identifier, slug, teamKeyFlag);
      break;
    case "start": {
      const baseRef = resolveBaseRef(baseFlag);
      cmdStart(identifier, slug, teamKeyFlag, dryRun, baseRef);
      break;
    }
    default:
      console.error(`Unknown subcommand: ${subcommand} (expected name|start)`);
      process.exit(2);
  }
}

main();
