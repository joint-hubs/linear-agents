#!/usr/bin/env node
// scripts/mcp-enable.mjs — approve this repo's .mcp.json servers for every squad.
//
//   node scripts/mcp-enable.mjs [--verify] [--squad <name>]
//
// Run once per machine after cloning. Writing is idempotent.
//
// WHY THIS EXISTS — three facts that only line up if you test them:
//
// 1. `mcpServers` in `agents/<squad>/settings.json` IS NOT READ. Claude Code
//    takes MCP config from `.claude.json` (user scope) and `.mcp.json` (project
//    scope), never from settings.json. This repo carried a dead
//    `mcpServers.linear` in two squads; `claude mcp list` under a squad's
//    CLAUDE_CONFIG_DIR answered "No MCP servers configured".
//
// 2. So the servers live in the repo's `.mcp.json`, which IS committable and
//    applies whatever CLAUDE_CONFIG_DIR a child runs under.
//
// 3. But a project-scoped server starts as `⏸ Pending approval` and stays inert
//    until the config dir approves it. That approval is an interactive trust
//    dialog — and supervisor children run headless, where no dialog can appear.
//    It is recorded in `.claude.json`, which is gitignored runtime state, so a
//    fresh clone cannot inherit it.
//
// Measured truth table on a clean config dir (codegraph 1.5.0):
//
//   nothing set ........................ Pending approval
//   hasTrustDialogAccepted only ........ Pending approval
//   enabledMcpjsonServers only ......... Pending approval
//   BOTH ............................... Connected
//   trust + disabledMcpjsonServers ..... server hidden entirely
//
// So both keys go in. Claude Code later clears `enabledMcpjsonServers` once the
// connection is established and keeps working without it — which is why this
// script does NOT try to infer "already done" from the file. Re-writing is
// harmless and restores them. To find out whether it actually WORKS, ask Claude
// Code with --verify rather than reading tea leaves out of its own state.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
const SQUADS = ["plan", "dev", "review", "test", "cadence", "supervisor"];

const servers = Object.keys(
  JSON.parse(readFileSync(join(ROOT, ".mcp.json"), "utf8")).mcpServers ?? {},
);

const args = process.argv.slice(2);
const verify = args.includes("--verify");
const only = args.includes("--squad") ? args[args.indexOf("--squad") + 1] : null;

let written = 0;
let missing = 0;

// Claude Code keys projects by path, and on win32 it writes FORWARD slashes
// while node's resolve() gives backslashes. Creating a key in the other spelling
// makes a second, invisible entry: the approval lands there and the real one
// stays `Pending approval` forever. Same class of bug as the worktree paths in
// supervisor-lib.mjs — two spellings of one directory.
const sameDir = (a, b) => a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();

function askClaude(squad) {
  const res = spawnSync("claude", ["mcp", "list"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, CLAUDE_CONFIG_DIR: join(ROOT, "agents", squad) },
    shell: process.platform === "win32",
    timeout: 90_000,
  });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  if (/Connected/.test(out)) return "connected";
  if (/Pending approval/.test(out)) return "PENDING — not usable";
  if (/No MCP servers/.test(out)) return "NOT CONFIGURED";
  return `unknown (${res.error?.message ?? "no recognisable output"})`;
}

for (const squad of SQUADS) {
  if (only && squad !== only) continue;

  const configPath = join(ROOT, "agents", squad, ".claude.json");
  if (!existsSync(configPath)) {
    // The file appears the first time that squad's launcher runs. Not an error.
    console.log(`  ${squad.padEnd(11)} no .claude.json yet (run bin/${squad}.bat once, then re-run this)`);
    missing++;
    continue;
  }

  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    // Live runtime state that Claude Code owns. If it is not parseable, refuse
    // rather than overwrite — rewriting would drop that squad's whole history.
    console.error(`  ${squad.padEnd(11)} REFUSED: ${configPath} is not readable JSON (${err.message})`);
    process.exitCode = 1;
    continue;
  }

  config.projects ??= {};
  const existingKey = Object.keys(config.projects).find((k) => sameDir(k, ROOT));
  const entry = (config.projects[existingKey ?? ROOT.replace(/\\/g, "/")] ??= {});

  const enabled = new Set(entry.enabledMcpjsonServers ?? []);
  for (const name of servers) enabled.add(name);
  entry.enabledMcpjsonServers = [...enabled];
  entry.disabledMcpjsonServers = (entry.disabledMcpjsonServers ?? []).filter((n) => !enabled.has(n));
  entry.hasTrustDialogAccepted = true;

  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  written++;

  if (verify) {
    const state = askClaude(squad);
    if (state !== "connected") process.exitCode = 1;
    console.log(`  ${squad.padEnd(11)} written → ${state}`);
  } else {
    console.log(`  ${squad.padEnd(11)} written: ${servers.join(", ")}`);
  }
}

console.log("");
console.log(`${written} squad config dir(s) written.`);
if (missing) console.log(`${missing} squad(s) have no config dir yet — harmless, re-run after their first launch.`);
if (!verify) console.log("Confirm it actually works:  node scripts/mcp-enable.mjs --verify");
