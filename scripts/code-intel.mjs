#!/usr/bin/env node
// scripts/code-intel.mjs — code intelligence for squads, over the GitNexus graph.
//
// Answers "where is X / what calls Y / what breaks if I change Z" with one
// command instead of a grep-and-read expedition. A recon subagent that opens
// fifteen files to answer a structural question is the single most expensive
// pattern in this repo; this exists to remove the excuse.
//
// Usage:
//   node scripts/code-intel.mjs find "<concept>"        execution flows around a concept
//   node scripts/code-intel.mjs symbol <name>           callers, callees, processes
//   node scripts/code-intel.mjs impact <name>           blast radius before changing it
//   node scripts/code-intel.mjs path <from> <to>        shortest call path A -> B
//   node scripts/code-intel.mjs cycles                  circular imports
//   node scripts/code-intel.mjs raw <cypher>            raw graph query (advanced)
//   node scripts/code-intel.mjs status                  is the index present and fresh
//
// Flags: --json (machine-readable), --repo <name> (defaults to this repo)
//
// Requires a GitNexus index (.gitnexus/). If absent, every command says so and
// exits 3 — it does NOT silently return nothing, because an empty answer that
// looks like "no results" would send the agent down a wrong path.

import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");
const REPO_DEFAULT = basename(ROOT);

const SUBCOMMANDS = {
  find: "query",
  symbol: "context",
  impact: "impact",
  path: "trace",
  cycles: "check",
  raw: "cypher",
  status: "status",
};

function usage(code = 2) {
  const lines = [
    "Usage: node scripts/code-intel.mjs <command> [args] [--json] [--repo <name>]",
    "",
    "  find \"<concept>\"      execution flows related to a concept",
    "  symbol <name>          360-degree view: callers, callees, processes",
    "  impact <name>          what breaks if you change it",
    "  path <from> <to>       shortest call path between two symbols",
    "  cycles                 circular imports",
    "  raw \"<cypher>\"        raw graph query (read gitnexus schema first)",
    "  status                 index present / fresh?",
    "",
    "Ask the graph BEFORE grepping. One call here replaces a read-and-search sweep.",
  ];
  console.error(lines.join("\n"));
  process.exit(code);
}

/** Locate a runnable GitNexus entry point. Returns argv prefix for `node`. */
function resolveGitNexus() {
  const local = join(ROOT, ".gitnexus", "run.cjs");
  if (existsSync(local)) return [local];
  return null;
}

/**
 * Warn when the index predates HEAD.
 *
 * A stale index is worse than a missing one: it answers "not found" for a
 * symbol that exists, and an agent reasonably concludes the symbol is gone.
 * Loud warning, not silence.
 */
function stalenessWarning() {
  try {
    const meta = JSON.parse(readFileSync(join(ROOT, ".gitnexus", "gitnexus.json"), "utf8"));
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8", cwd: ROOT,
    }).trim();
    if (meta.lastCommit && head && !head.startsWith(meta.lastCommit) && meta.lastCommit !== head) {
      return (
        `[code-intel] WARNING: index is at ${String(meta.lastCommit).slice(0, 7)}, HEAD is at ${head.slice(0, 7)}.\n` +
        "Anything added since then reads as 'not found'. Treat a negative result as UNKNOWN,\n" +
        "not as absent — confirm with Grep before reporting it. Refresh: node .gitnexus/run.cjs analyze\n"
      );
    }
  } catch { /* no metadata — the missing-index check already covered it */ }
  return null;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") usage(0);

  const command = argv[0];
  const sub = SUBCOMMANDS[command];
  if (!sub) {
    console.error(`Unknown command: ${command}`);
    usage();
  }

  // Split our flags from the positional arguments passed through.
  const rest = [];
  let json = false;
  let repo = REPO_DEFAULT;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--json") { json = true; continue; }
    if (argv[i] === "--repo" && i + 1 < argv.length) { repo = argv[++i]; continue; }
    rest.push(argv[i]);
  }

  if (!existsSync(join(ROOT, ".gitnexus"))) {
    console.error(
      "[code-intel] No GitNexus index in this repo (.gitnexus/ is absent).\n" +
      "It is gitignored, so a fresh clone has none. Build it once:\n" +
      "  npx gitnexus analyze\n" +
      "Until then use Grep/Glob and say so in your summary — do NOT report 'not found'."
    );
    process.exit(3);
  }

  const entry = resolveGitNexus();
  if (!entry) {
    console.error("[code-intel] .gitnexus/run.cjs missing — regenerate with: npx gitnexus analyze");
    process.exit(3);
  }

  // `cycles` maps to `check --cycles`; everything else passes positionals through.
  const passthrough = command === "cycles" ? ["--cycles"] : rest;
  if (command !== "cycles" && command !== "status" && passthrough.length === 0) {
    console.error(`[code-intel] '${command}' needs an argument.`);
    usage();
  }

  // status is repo-local and takes no --repo
  const repoArgs = command === "status" ? [] : ["--repo", repo];
  const args = [...entry, sub, ...repoArgs, ...passthrough];
  if (json && command !== "status") args.push("--json");

  const stale = command === "status" ? null : stalenessWarning();
  if (stale) process.stderr.write(stale);

  try {
    const out = execFileSync("node", args, {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      cwd: ROOT,
      // GitNexus writes a JSON warning about the missing FTS extension to
      // stderr on every call. Swallowing stderr here keeps it out of the
      // agent's context; real failures still surface via the catch below.
      stdio: ["ignore", "pipe", "pipe"],
    });
    process.stdout.write(
      out.split("\n").filter((l) => !l.includes('"name":"gitnexus"')).join("\n")
    );
  } catch (err) {
    const stderr = (err.stderr || "").toString();
    if (stderr.includes("Multiple repositories indexed")) {
      console.error(
        `[code-intel] Several repos are indexed and '${repo}' did not match.\n` +
        "Pass --repo <name> explicitly."
      );
      process.exit(4);
    }
    console.error(stderr || err.message);
    process.exit(err.status || 1);
  }
}

main();
