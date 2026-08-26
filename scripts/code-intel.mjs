#!/usr/bin/env node
// scripts/code-intel.mjs — code intelligence for squads, over the CodeGraph index.
//
// Answers "where is X / what calls Y / what breaks if I change Z" with one
// command instead of a grep-and-read expedition. A recon subagent that opens
// fifteen files to answer a structural question is the single most expensive
// pattern in this repo; this exists to remove the excuse.
//
// Usage:
//   node scripts/code-intel.mjs explore "<question>"    relevant source + call paths, one shot
//   node scripts/code-intel.mjs symbol <name>           one symbol: source, callers, callees
//   node scripts/code-intel.mjs impact <name>           blast radius before changing it
//   node scripts/code-intel.mjs callers <name>          who calls it
//   node scripts/code-intel.mjs callees <name>          what it calls
//   node scripts/code-intel.mjs find "<term>"           symbol search (--kind, --limit)
//   node scripts/code-intel.mjs files                   file structure from the index
//   node scripts/code-intel.mjs affected [<file> ...]   test files hit by a change
//   node scripts/code-intel.mjs status                  index present and in sync?
//
// Flags pass through to codegraph: --json, --limit N, --kind K, --depth N, ...
//
// WHY THIS WRAPPER STILL EXISTS now that CodeGraph ships an MCP server:
//   · Children run with an isolated CLAUDE_CONFIG_DIR per squad, so MCP has to
//     be wired per squad (agents/*/settings.json). This works with none of that.
//   · The MCP surface lists ONE tool by default (`codegraph_explore`); the
//     narrower ones are unlisted unless CODEGRAPH_MCP_TOOLS re-enables them.
//     Here every verb is always reachable.
//   · Scripts and hooks can call it. An MCP tool is only reachable from a model.
// When you are a lead with the MCP tools available, prefer `codegraph_explore`
// — it is one call and it returns source. This is the floor, not the ceiling.
//
// Requires a CodeGraph index (`.codegraph/`). If absent, every command says so
// and exits 3 — it does NOT silently return nothing, because an empty answer
// that looks like "no results" would send the agent down a wrong path.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");

// Verb → codegraph subcommand. The left column is this repo's vocabulary, which
// the five squad CLAUDE.md files already speak; the right is CodeGraph's.
const SUBCOMMANDS = {
  explore: "explore",
  symbol: "node",
  impact: "impact",
  callers: "callers",
  callees: "callees",
  find: "query",
  files: "files",
  affected: "affected",
  status: "status",
};

// Verbs the GitNexus-backed version had that CodeGraph does not answer. Saying
// so beats a wrapper that maps them onto something adjacent: an agent told
// "cycles: none found" when nothing was checked will report a clean bill.
const RETIRED = {
  path: 'use: code-intel explore "how does <from> reach <to>" — CodeGraph returns call paths inline',
  cycles: "no equivalent — CodeGraph has no circular-import check. Use `npx madge --circular` or Grep.",
  raw: "no equivalent — CodeGraph is not a Cypher store.",
};

function usage(code = 2) {
  console.error(
    [
      "Usage: node scripts/code-intel.mjs <command> [args] [codegraph flags]",
      "",
      '  explore "<question>"   relevant symbols\' source + call paths, one shot (start here)',
      "  symbol <name>          one symbol: source, callers, callees",
      "  impact <name>          what breaks if you change it (--depth N, --json)",
      "  callers <name>         who calls it (--limit N, --json)",
      "  callees <name>         what it calls (--limit N, --json)",
      '  find "<term>"          symbol search (--kind function|class, --limit N, --json)',
      "  files                  file structure from the index (--filter, --pattern, --json)",
      "  affected [<file> ...]  test files hit by changing these (--depth N, --json)",
      "  status                 index present and in sync?",
      "",
      "Ask the graph BEFORE grepping. One call here replaces a read-and-search sweep.",
    ].join("\n"),
  );
  process.exit(code);
}

// Exit 3, never 0-with-nothing. An agent that reads "no results" from a missing
// index concludes the symbol does not exist and acts on it.
function requireIndex() {
  if (existsSync(join(ROOT, ".codegraph"))) return;
  console.error(
    [
      "[code-intel] No CodeGraph index in this repo (.codegraph/ is missing).",
      "",
      "Nothing here can answer until it exists. Build it:  codegraph init",
      "A negative result from this tool right now would be a lie, so it refuses instead.",
    ].join("\n"),
  );
  process.exit(3);
}

function main() {
  const argv = process.argv.slice(2);
  const verb = argv[0];

  if (!verb || verb === "--help" || verb === "-h") usage(0);

  if (RETIRED[verb]) {
    console.error(`[code-intel] "${verb}" was a GitNexus verb and has no CodeGraph equivalent.\n  ${RETIRED[verb]}`);
    process.exit(2);
  }

  const sub = SUBCOMMANDS[verb];
  if (!sub) {
    console.error(`[code-intel] unknown command "${verb}"\n`);
    usage(2);
  }

  requireIndex();

  // `--path ROOT` because squads run from a worktree or a subdirectory, and
  // CodeGraph would otherwise resolve the index relative to cwd and report
  // "no index" for a repo that has one.
  //
  // `status` is the one subcommand that does NOT accept --path (it takes only
  // --json). Passing it there is a hard `error: unknown option` — found by
  // running it, not by reading the flag table.
  const args = [sub, ...argv.slice(1), ...(sub === "status" ? [] : ["--path", ROOT])];

  const res = spawnSync("codegraph", args, { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" });

  if (res.error?.code === "ENOENT") {
    console.error(
      [
        "[code-intel] The `codegraph` CLI is not on PATH.",
        "",
        "Install:  npm i -g @colbymchenry/codegraph",
        "Then:     codegraph init",
      ].join("\n"),
    );
    process.exit(3);
  }
  process.exit(res.status ?? 1);
}

main();
