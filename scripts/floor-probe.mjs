#!/usr/bin/env node
// scripts/floor-probe.mjs — what is the fixed floor of a squad session made of?
//
//   node scripts/floor-probe.mjs --spend [--squad dev] [--json]
//
// context-attribution.mjs measures the floor as ONE number (~38k tokens, 35% of
// the cache-read bill). It cannot say what that number is made of, because a
// transcript does not record the system prompt. This does, by difference: run
// the same trivial `-p` call under configurations that differ in exactly one
// thing, and read the prompt size the provider reports back.
//
// COSTS REAL MONEY. Six calls, ~40k prompt tokens each, on the cheapest routed
// model — cents, not dollars, but not zero, so it refuses without --spend.
//
// RE-RUNNABLE ON PURPOSE. Every number here is a property of the Claude Code
// build, not of this repo: a release that adds a tool moves the floor, and the
// conclusion ("the floor is the biggest term, and most of it is not our prompt")
// has to be re-checkable rather than quoted from a doc forever.
//
// Measured 2026-08-26, claude-code with glm-5.2 via OpenRouter, squad `dev`:
//
//   trusted, no squad prompt ....................... 25.8k
//   + agents/dev/CLAUDE.md ......................... 30.2k   (+4.3k)
//   + cached feature flags ......................... 41.8k   (+11.7k)
//   real config dir, no MCP ........................ 39.7k
//   real config dir, MCP on ........................ 42.8k   (+3.1k for codegraph)
//   flags on, 4 unusable tools --disallowed-tools .. 33.1k   (-8.7k)
//   flags on, same 4 via permissions.deny .......... 33.1k   (-8.7k)
//
// The last two lines are the finding, and they agree. Artifact, PushNotification,
// ListAgents and Monitor are tools a headless squad child cannot use — it has no
// browser to publish to, no phone to notify, no sibling sessions to list — and
// their schemas cost 8.7k tokens on every single call, twice the whole squad
// prompt.
//
// `permissions.deny` removes them from the prompt, not just from the caller's
// hand. That was worth measuring rather than assuming: the assumption here was
// the opposite (deny blocks the CALL, so the schema still ships), and it was
// wrong. It matters because it decides where the fix lives — a committed
// settings.json, which config-drift.test.mjs can guard, rather than a launcher
// flag that every new entry point has to remember.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, all) =>
    a.startsWith("--") ? [[a.slice(2), all[i + 1]?.startsWith("--") === false ? all[i + 1] : true]] : [],
  ),
);

if (!args.spend) {
  console.error(
    [
      "floor-probe.mjs spends money: 6 model calls of ~40k prompt tokens each.",
      "",
      "Re-run it when Claude Code changes the tool surface, not routinely —",
      "scripts/context-attribution.mjs answers the day-to-day question for free.",
      "",
      "  node scripts/floor-probe.mjs --spend [--squad dev] [--json]",
    ].join("\n"),
  );
  process.exit(2);
}

const SQUAD = args.squad === true || !args.squad ? "dev" : args.squad;
const squadDir = join(ROOT, "agents", SQUAD);
if (!existsSync(squadDir)) {
  console.error(`no such squad config dir: ${squadDir}`);
  process.exit(2);
}

// The provider the squads actually run on. Reading the key from .env rather than
// the environment keeps this working from a bare shell, the same way the .bat
// launchers do.
function openrouterKey() {
  const envFile = join(ROOT, ".env");
  if (!existsSync(envFile)) return null;
  const m = readFileSync(envFile, "utf8").match(/^OPENROUTER_API_KEY=(.*)$/m);
  return m ? m[1].trim().replace(/^"|"$/g, "") : null;
}

const KEY = openrouterKey();
if (!KEY) {
  console.error("no OPENROUTER_API_KEY in .env — this probe needs the provider the squads use.");
  process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), "la-floor-"));
process.on("exit", () => {
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// Trust matters and is easy to miss: an unapproved directory runs with a
// REDUCED tool set, so a probe without this measures a floor no real session
// ever has. Found the hard way — the first run of this experiment was 9k light
// and the gap looked like it came from .claude.json's contents.
const trust = (extra = {}) =>
  JSON.stringify({
    projects: {
      [ROOT.replace(/\\/g, "/")]: {
        hasTrustDialogAccepted: true,
        hasCompletedProjectOnboarding: true,
        allowedTools: [],
        mcpServers: {},
        enabledMcpjsonServers: [],
        disabledMcpjsonServers: [],
      },
    },
    ...extra,
  });

function config(name, { claudeMd = false, flags = false, deny = null } = {}) {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  let extra = {};
  if (flags) {
    const real = join(squadDir, ".claude.json");
    if (existsSync(real)) {
      const parsed = JSON.parse(readFileSync(real, "utf8"));
      if (parsed.cachedGrowthBookFeatures) extra = { cachedGrowthBookFeatures: parsed.cachedGrowthBookFeatures };
    }
  }
  writeFileSync(join(dir, ".claude.json"), trust(extra));
  if (claudeMd) copyFileSync(join(squadDir, "CLAUDE.md"), join(dir, "CLAUDE.md"));
  if (deny) writeFileSync(join(dir, "settings.json"), JSON.stringify({ permissions: { deny } }, null, 2));
  return dir;
}

/** One `-p` call; returns the prompt size the provider reported. */
function probe(configDir, extraArgs = []) {
  const out = execFileSync(
    "claude",
    ["-p", "Reply with the single word: ok", "--output-format", "json", ...extraArgs],
    {
      cwd: ROOT,
      encoding: "utf8",
      shell: process.platform === "win32",
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: configDir,
        ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
        ANTHROPIC_AUTH_TOKEN: KEY,
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_MODEL: "z-ai/glm-5.2",
        ANTHROPIC_SMALL_FAST_MODEL: "z-ai/glm-5.2",
      },
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  const line = out.split("\n").filter((l) => l.trim().startsWith("{")).pop();
  const j = JSON.parse(line);
  const u = j.usage || {};
  return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
}

// Tools a headless squad child cannot use: no browser to publish to, no phone to
// notify, no sibling sessions to list or message, nothing to watch interactively.
const UNUSABLE_HEADLESS = ["Artifact", "PushNotification", "ListAgents", "Monitor"];

const steps = [
  ["trusted, no squad prompt", () => probe(config("t1"), ["--strict-mcp-config"])],
  [`+ agents/${SQUAD}/CLAUDE.md`, () => probe(config("t2", { claudeMd: true }), ["--strict-mcp-config"])],
  ["+ cached feature flags", () => probe(config("t3", { claudeMd: true, flags: true }), ["--strict-mcp-config"])],
  ["real config dir, no MCP", () => probe(squadDir, ["--strict-mcp-config"])],
  ["real config dir, MCP on", () => probe(squadDir, [])],
  [
    `flags on, ${UNUSABLE_HEADLESS.length} unusable via --disallowed-tools`,
    () => probe(config("t5", { claudeMd: true, flags: true }), ["--strict-mcp-config", "--disallowed-tools", ...UNUSABLE_HEADLESS]),
  ],
  [
    `flags on, same 4 via permissions.deny`,
    () => probe(config("t6", { claudeMd: true, flags: true, deny: UNUSABLE_HEADLESS }), ["--strict-mcp-config"]),
  ],
];

const results = [];
for (const [label, run] of steps) {
  let tokens = null;
  let error = null;
  try {
    tokens = run();
  } catch (err) {
    error = err.message.split("\n")[0];
  }
  results.push({ label, tokens, error });
  if (!args.json) {
    console.log(`  ${label.padEnd(46)}${(tokens === null ? "FAILED" : `${(tokens / 1000).toFixed(1)}k`).padStart(9)}${error ? `  ${error}` : ""}`);
  }
}

const by = (i) => results[i]?.tokens ?? null;
const delta = (a, b) => (by(a) === null || by(b) === null ? null : by(a) - by(b));

const summary = {
  squad: SQUAD,
  steps: results,
  squadPromptTokens: delta(1, 0),
  featureFlagTokens: delta(2, 1),
  mcpTokens: delta(4, 3),
  savingFromDisallowing: delta(2, 5),
  savingFromDeny: delta(2, 6),
  unusableHeadless: UNUSABLE_HEADLESS,
};

if (args.json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log("");
  console.log(`  squad CLAUDE.md ................ ${fmt(summary.squadPromptTokens)}`);
  console.log(`  cached feature flags ........... ${fmt(summary.featureFlagTokens)}`);
  console.log(`  MCP servers .................... ${fmt(summary.mcpTokens)}`);
  console.log(`  RECLAIMABLE, --disallowed-tools . ${fmt(summary.savingFromDisallowing)}   ${UNUSABLE_HEADLESS.join(", ")}`);
  console.log(`  RECLAIMABLE, permissions.deny ... ${fmt(summary.savingFromDeny)}   same four, and it works the same`);
  console.log("");
  console.log("  deny removes the SCHEMA, not just the permission to call it — so the fix is a");
  console.log("  committed settings.json, which config-drift.test.mjs can guard.");
}

function fmt(n) {
  return n === null ? "n/a" : `${n >= 0 ? "+" : ""}${(n / 1000).toFixed(1)}k tokens`;
}
