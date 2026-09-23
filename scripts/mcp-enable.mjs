#!/usr/bin/env node
// scripts/mcp-enable.mjs — approve this repo's .mcp.json servers for every squad.
//
//   node scripts/mcp-enable.mjs [--verify] [--squad <name>]
//   node scripts/mcp-enable.mjs --project-root <target> [--squad <name>] [--config-dir <dir>]
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
// Measured truth table (every row a FRESH config dir + FRESH project dir — the
// first "trust only → Connected" observation below was contaminated by a
// settings.local.json an earlier CLI run had silently left in the project):
//
//   codegraph 1.5.0 (2026-08-26)              CLI 2.1.280 (2026-09-23)
//   nothing set .................. Pending     nothing ....................... Pending
//   trust only ................... Pending     trust only ..................... Pending
//   enabledMcpjsonServers only .. Pending     enabled in .claude.json only ... Pending (inert there)
//   BOTH in .claude.json ....... Connected     enabled in settings.local only . Pending
//   trust + disabledMcpjson .... hidden        trust + settings.local enabled . CONNECTED
//                                             (disabled list still hides)
//
// So an approval has TWO halves. 1.5.0 reads both from .claude.json's project
// entry. 2.1.280 reads trust from there but moved the enabled half: it reads
// `enabledMcpjsonServers` from <project>/.claude/settings.local.json — exactly
// where its own interactive dialog writes it — and the copy under the
// .claude.json project entry is inert. Trust + that file, both present, is
// CONNECTED (verified on a plain repo AND a linked git worktree); either alone
// stays ⏸ Pending. So this script writes all three: trust + the enabled list
// into .claude.json (1.5.0), and the enabled list into the target's
// settings.local.json (2.1.280). Claude Code later clears the .claude.json
// `enabledMcpjsonServers` once connected and keeps working without it — which
// is why the ROOT mode does NOT try to infer "already done" from the file.
// Re-writing is harmless and restores them. To find out whether it actually
// WORKS, ask Claude Code with --verify rather than reading tea leaves out of
// its own state.
//
// --project-root (2026-09-23, plan §4 "headless access"): a supervisor child's
// worktree is a NEW project key for Claude Code, and the ROOT approval above
// only covers the main checkout — a headless worktree stayed `Pending approval`
// forever. The flag trusts ONE explicitly named target root in the selected
// squad's config and enables ONLY the `codegraph` server there — BOTH halves
// of the approval: trust + enabled list in the squad's .claude.json (1.5.0),
// and the enabled list in the target's own .claude/settings.local.json
// (2.1.280; machine-local state the CLI itself keeps out of git via the user's
// global git ignore), and only when
// the target's own .mcp.json carries the repo-owned GUARDED boundary entry
// (node + scripts/mcp/server-codegraph.mjs). A foreign repo — or this repo
// after `codegraph install` rewrote .mcp.json back to the raw upstream entry —
// gets NO approval and NO write: prompts already route external repos to the
// guarded CLI, and blessing an unguarded server would defeat the boundary.
// Everything else in the config file is preserved verbatim.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
const SQUADS = ["plan", "dev", "review", "test", "cadence", "supervisor"];

// Claude Code keys a project by z$(realpath(cwd)): on win32 every backslash
// becomes a forward slash, and the casing is the one the filesystem answers
// with — nothing lowercases it. MEASURED on CLI 2.1.280 (2026-09-23): a
// backslash-spelled or case-variant key in .claude.json is INVISIBLE — the
// project server stays ⏸ Pending approval even with hasTrustDialogAccepted
// and enabledMcpjsonServers sitting under that key. So the approval must land
// on the CLI's own spelling of the path, computed the same way.
const cliProjectKey = (projectRoot) => {
  let abs = resolve(projectRoot);
  try {
    if (existsSync(abs)) abs = realpathSync(abs);
  } catch {
    /* keep the resolved literal — the CLI falls back the same way */
  }
  return abs.replace(/\\/g, "/");
};

// Same-directory detection for MIGRATING dead-spelled entries — see
// cliProjectKey. Comparison is case/separator-insensitive because Windows
// paths have two spellings; the canonical WRITE is cliProjectKey's.
const sameDir = (a, b) => a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();

// ── importable helpers (supervisor-spawn.mjs uses them for worktree approval) ──

/**
 * The repo-owned guarded codegraph server names a target declares — `["codegraph"]`
 * when <target>/.mcp.json carries the fail-closed boundary (node +
 * scripts/mcp/server-codegraph.mjs), `[]` otherwise. The guard matters twice:
 * a foreign repo's own `codegraph` entry is NOT ours to approve, and this repo's
 * entry after `codegraph install` rewrote it to the raw `codegraph serve --mcp`
 * is the UNGUARDED upstream — approving it silently would swap the boundary for
 * the thing it exists to gate.
 */
export function guardedCodegraphServersOf(projectRoot) {
  const mcpJson = join(projectRoot, ".mcp.json");
  if (!existsSync(mcpJson)) return [];
  let config;
  try {
    config = JSON.parse(readFileSync(mcpJson, "utf8"));
  } catch {
    return [];
  }
  const entry = config?.mcpServers?.codegraph;
  if (!entry || typeof entry !== "object") return [];
  const args = Array.isArray(entry.args) ? entry.args.join(" ") : "";
  if (String(entry.command) !== "node" || !args.includes("server-codegraph.mjs")) return [];
  return ["codegraph"];
}

/**
 * Approve `servers` for `projectRoot` in one Claude Code config file, preserving
 * everything else in it. The approval lands on the CLI's own spelling of the
 * path (cliProjectKey); an existing key for the same directory in a dead
 * spelling — one the CLI does not read — is migrated into it, fields carried
 * over, so the entry can never fork into a second, invisible duplicate.
 * `force: false` skips the write when nothing would change — callers that run
 * per-spawn must not churn a file Claude Code rewrites on its own.
 *
 * @returns {{ok: boolean, written: boolean, projectKey?: string, reason?: string}}
 */
export function approveServersForProject({ configPath, projectRoot, servers, force = false }) {
  if (!servers.length) return { ok: false, written: false, reason: "no servers to approve" };
  if (!existsSync(configPath)) {
    // The file appears the first time that squad's launcher runs. Not an error —
    // the caller reports it; approving into a config dir that does not exist
    // yet would write a file the squad's first launch would then overwrite.
    return { ok: false, written: false, reason: `no .claude.json at ${configPath} yet (run the squad's launcher once, then re-run)` };
  }
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    // Live runtime state that Claude Code owns. If it is not parseable, refuse
    // rather than overwrite — rewriting would drop that squad's whole history.
    return { ok: false, written: false, reason: `${configPath} is not readable JSON (${err.message})` };
  }

  const before = JSON.stringify(config);
  config.projects ??= {};
  // The CLI reads exactly ONE spelling of a project path (cliProjectKey —
  // measured: backslash/case variants stay ⏸ Pending approval). An existing
  // key for the same directory in any other spelling is dead weight: updating
  // it in place would leave the approval invisible. Migrate such entries into
  // the canonical key — same project, one visible entry, no invisible
  // duplicates — carrying over every field the dead entry had; the canonical
  // entry wins on conflicting fields.
  const canonical = cliProjectKey(projectRoot);
  const dead = Object.keys(config.projects).filter((k) => k !== canonical && sameDir(k, projectRoot));
  if (dead.length) {
    const carried = {};
    for (const k of dead) Object.assign(carried, config.projects[k]);
    config.projects[canonical] = { ...carried, ...(config.projects[canonical] ?? {}) };
    for (const k of dead) delete config.projects[k];
  }
  const projectKey = canonical;
  const entry = (config.projects[projectKey] ??= {});

  const enabled = new Set(entry.enabledMcpjsonServers ?? []);
  for (const name of servers) enabled.add(name);
  entry.enabledMcpjsonServers = [...enabled];
  entry.disabledMcpjsonServers = (entry.disabledMcpjsonServers ?? []).filter((n) => !enabled.has(n));
  entry.hasTrustDialogAccepted = true;

  if (JSON.stringify(config) === before && !force) {
    return { ok: true, written: false, projectKey };
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  return { ok: true, written: true, projectKey };
}

/**
 * The 2.1.280 half of an approval: the enabled-server list the CLI actually
 * reads lives in <projectRoot>/.claude/settings.local.json — the file its own
 * interactive dialog writes; the copy under the .claude.json project entry is
 * inert there (see the truth table). Merge `servers` into that file,
 * preserving every other key in it. A no-op write is skipped, so per-spawn
 * callers do not churn it. A corrupt or non-object file is refused, never
 * clobbered — it may hold the operator's own local permissions.
 *
 * @returns {{ok: boolean, written: boolean, reason?: string}}
 */
export function enableServersInProjectSettings({ projectRoot, servers }) {
  if (!servers.length) return { ok: false, written: false, reason: "no servers to enable" };
  const settingsPath = join(projectRoot, ".claude", "settings.local.json");
  let settings = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch (err) {
      return { ok: false, written: false, reason: `${settingsPath} is not readable JSON (${err.message})` };
    }
    if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
      return { ok: false, written: false, reason: `${settingsPath} is not a settings object` };
    }
  }
  const before = JSON.stringify(settings);
  const enabled = new Set(settings.enabledMcpjsonServers ?? []);
  for (const name of servers) enabled.add(name);
  settings.enabledMcpjsonServers = [...enabled];
  if (JSON.stringify(settings) === before) return { ok: true, written: false };
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
  return { ok: true, written: true };
}

/**
 * Headless access for one explicitly trusted target root (plan §4): approve
 * ONLY the repo-owned guarded codegraph server for the target — BOTH halves of
 * the approval: trust + enabled list under the target's key in `squad`'s role
 * config (1.5.0), and the enabled list in the target's own
 * .claude/settings.local.json (2.1.280 — without it a trusted target still
 * shows ⏸ Pending approval headlessly). A target without the guarded boundary
 * gets no write at all, to either file — the reason says so instead.
 * `configDir` defaults to the squad's role config directory under this repo;
 * tests and the CLI can point it elsewhere.
 */
export function approveGuardedCodegraphForProject({ squad, projectRoot, configDir = null }) {
  const servers = guardedCodegraphServersOf(projectRoot);
  if (!servers.length) {
    return {
      ok: false,
      written: false,
      reason:
        `no repo-owned guarded codegraph MCP at ${projectRoot} — nothing to approve ` +
        "(external repos use the guarded CLI; a rewritten .mcp.json needs the boundary re-applied)",
    };
  }
  const dir = configDir ?? join(ROOT, "agents", squad);
  const config = approveServersForProject({ configPath: join(dir, ".claude.json"), projectRoot, servers });
  if (!config.ok) return config; // nothing approved — the target's settings were never touched either
  const settings = enableServersInProjectSettings({ projectRoot, servers });
  if (!settings.ok) {
    return { ok: false, written: config.written, projectKey: config.projectKey, reason: settings.reason };
  }
  return { ok: true, written: config.written || settings.written, projectKey: config.projectKey };
}

// ── the CLI ────────────────────────────────────────────────────────────────────

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

function usage() {
  console.error(
    [
      "Usage: node scripts/mcp-enable.mjs [--verify] [--squad <name>]",
      "       node scripts/mcp-enable.mjs --project-root <target> [--squad <name>] [--config-dir <dir>]",
      "",
      "Default (no --project-root): approve every server in the repo's .mcp.json for the",
      "main checkout, in every squad's config dir (or --squad's only). Always rewrites —",
      "restoring keys Claude Code clears is the point.",
      "",
      "--project-root <target>: trust ONE explicit target root (e.g. a supervisor child's",
      "worktree) and enable ONLY the repo-owned guarded codegraph server for it — in the",
      "selected squad's config AND in the target's own .claude/settings.local.json.",
      "No guarded boundary at the target → no write at all.",
      "Nothing outside the named target is touched.",
    ].join("\n"),
  );
  process.exit(2);
}

function main() {
  const args = process.argv.slice(2);
  const verify = args.includes("--verify");
  const only = args.includes("--squad") ? args[args.indexOf("--squad") + 1] : null;
  const targetIdx = args.indexOf("--project-root");
  const configDirIdx = args.indexOf("--config-dir");

  let target = null;
  if (targetIdx >= 0) {
    target = args[targetIdx + 1];
    if (!target || target.startsWith("--")) usage();
  }
  const configDirBase = configDirIdx >= 0 ? args[configDirIdx + 1] : null;
  if (configDirBase && !target) usage(); // a config dir without a target approves nothing new

  let written = 0;
  let missing = 0;
  let refused = 0;

  const rootServers = target ? null : Object.keys(JSON.parse(readFileSync(join(ROOT, ".mcp.json"), "utf8")).mcpServers ?? {});
  if (!target) {
    // The 2.1.280 enabled half for the main checkout — one settings.local.json
    // covers every squad's sessions there (see the truth table).
    const settings = enableServersInProjectSettings({ projectRoot: ROOT, servers: rootServers });
    if (!settings.ok) {
      console.error(`  settings.local.json REFUSED: ${settings.reason}`);
      process.exitCode = 1;
    }
  }

  for (const squad of SQUADS) {
    if (only && squad !== only) continue;

    if (target) {
      // Target mode: one explicit root, only the guarded codegraph server,
      // no write when there is nothing of ours to approve.
      const r = approveGuardedCodegraphForProject({
        squad,
        projectRoot: resolve(target),
        ...(configDirBase ? { configDir: join(configDirBase, squad) } : {}),
      });
      if (!r.ok) {
        console.error(`  ${squad.padEnd(11)} REFUSED: ${r.reason}`);
        process.exitCode = 1;
        refused++;
        continue;
      }
      console.log(
        `  ${squad.padEnd(11)} ${r.written ? "written" : "already approved"}: codegraph → ${r.projectKey}`,
      );
      written++;
      continue;
    }

    // ROOT mode — unchanged behavior: every server from the repo's own .mcp.json,
    // for the main checkout, rewritten unconditionally (see the header: Claude
    // Code clears enabledMcpjsonServers once connected, so "already done" is
    // not inferable from the file).
    const configPath = join(ROOT, "agents", squad, ".claude.json");
    if (!existsSync(configPath)) {
      // The file appears the first time that squad's launcher runs. Not an error.
      console.log(`  ${squad.padEnd(11)} no .claude.json yet (run bin/${squad}.bat once, then re-run this)`);
      missing++;
      continue;
    }
    const r = approveServersForProject({ configPath, projectRoot: ROOT, servers: rootServers, force: true });
    if (!r.ok) {
      console.error(`  ${squad.padEnd(11)} REFUSED: ${r.reason}`);
      process.exitCode = 1;
      continue;
    }
    written++;

    if (verify) {
      const state = askClaude(squad);
      if (state !== "connected") process.exitCode = 1;
      console.log(`  ${squad.padEnd(11)} written → ${state}`);
    } else {
      console.log(`  ${squad.padEnd(11)} written: ${rootServers.join(", ")}`);
    }
  }

  console.log("");
  if (target) {
    console.log(`${written} squad config dir(s) approved for ${resolve(target)} (codegraph only).`);
    if (refused) console.log(`${refused} squad(s) refused — no guarded codegraph MCP at the target, nothing written.`);
  } else {
    console.log(`${written} squad config dir(s) written.`);
    if (missing) console.log(`${missing} squad(s) have no config dir yet — harmless, re-run after their first launch.`);
    if (!verify) console.log("Confirm it actually works:  node scripts/mcp-enable.mjs --verify");
  }
}

// Import-safe: supervisor-spawn.mjs imports the helpers above at spawn time; the
// CLI body must not run on import.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}