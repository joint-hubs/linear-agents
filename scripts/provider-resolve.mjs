#!/usr/bin/env node
// provider-resolve.mjs — resolve the per-squad provider at launch.
//
// CLI:
//   node scripts/provider-resolve.mjs [provider]           → emit set lines
//   node scripts/provider-resolve.mjs [provider] --check   → print resolution summary
//
// The provider name comes from the CLI arg, then LA_PROVIDER env, then
// defaults to "openrouter". Reads config/models.json (providers map) and
// .env (key values). Emits set "VAR=value" lines for cmd for /f consumption.
//
// Env overrides for tests:
//   LA_PROVIDER_CONFIG     path to the models.json (defaults to config/models.json)
//   LA_PROVIDER_ENV_FILE   path to the .env file (defaults to .env)
//
// --check prints the resolution (no secret values) and exits 0 when the
// provider is resolvable, 1 when the key is missing or unknown. Secret values
// are never printed except in the set lines themselves (consumed, not echoed).

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, "..");

const DEFAULT_PROVIDER = "openrouter";

// ---------------------------------------------------------------------------
// File readers
// ---------------------------------------------------------------------------

/** Parse a .env file into a { KEY: value } map, matching _lib.bat's semantics:
 *  eol=# (skip full-line comments), delims== (split on first =), no inline
 *  comment stripping. Blank lines and empty keys are skipped. */
export function parseEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (let line of readFileSync(path, "utf8").split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!key) continue;
    out[key] = value;
  }
  return out;
}

/** Load the `providers` map from a models.json config file. */
export function loadProviders(configPath) {
  const source = readFileSync(configPath, "utf8");
  const config = JSON.parse(source);
  return config.providers || {};
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Return true when a value is present (non-empty, not null/undefined). */
function nonEmpty(value) {
  return value !== undefined && value !== null && value !== "";
}

/**
 * Resolve a provider by name.
 *
 * @param {string} [provider] - explicit provider name
 * @param {object} [options]
 * @param {string} [options.configPath] - path to models.json (default: config/models.json)
 * @param {string} [options.envPath] - path to .env (default: .env)
 * @param {object} [options.env] - environment map (default: process.env)
 * @returns {{ provider, baseUrl, authVar, authEnv, authStyle, authValue, present }}
 *   present is true when the auth key was found.
 * @throws {Error} on unknown provider (missing config entry).
 */
export function resolveProvider(provider, options = {}) {
  const configPath = options.configPath
    || process.env.LA_PROVIDER_CONFIG
    || join(root, "config", "models.json");
  const envPath = options.envPath
    || process.env.LA_PROVIDER_ENV_FILE
    || join(root, ".env");
  const env = options.env || process.env;

  const providers = loadProviders(configPath);
  const name = provider || env.LA_PROVIDER || DEFAULT_PROVIDER;

  const entry = providers[name];
  if (!entry) {
    const valid = Object.keys(providers).join(", ");
    throw new Error(`Unknown provider "${name}" (valid: ${valid})`);
  }

  const authStyle = entry.authStyle || "token";
  const authVar = authStyle === "apikey" ? "ANTHROPIC_API_KEY" : "ANTHROPIC_AUTH_TOKEN";
  const authEnv = entry.authEnv;

  const envFile = parseEnvFile(envPath);
  const authValue = nonEmpty(env[authEnv]) ? env[authEnv] : envFile[authEnv];

  return {
    provider: name,
    baseUrl: entry.baseUrl,
    authVar,
    authEnv,
    authStyle,
    authValue: authValue ?? null,
    present: Boolean(authValue),
    tiers: entry.tiers && typeof entry.tiers === "object" ? entry.tiers : null,
  };
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

// The model-tier variables Claude Code resolves aliases against. Their values
// belong to the PROVIDER, not to the squad: a slug that exists on OpenRouter
// (anthropic/claude-opus-4.8) is a 404 on Nebul, which serves open models only.
// Keeping them here means switching LA_PROVIDER switches them too — including
// the sonnet tier, which Claude Code claims for its own auto-mode permission
// classifier and which therefore fails on EVERY tool call when it points at a
// model the active provider does not host.
const TIER_VARS = {
  opus: "ANTHROPIC_DEFAULT_OPUS_MODEL",
  sonnet: "ANTHROPIC_DEFAULT_SONNET_MODEL",
  haiku: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  smallFast: "ANTHROPIC_SMALL_FAST_MODEL",
};

/** Emit `set "VAR=value"` lines for each tier the provider declares. A squad
 *  that needs a different model for one tier sets it AFTER calling _lib.bat,
 *  which overrides the provider default for that launcher only. */
export function formatTierLines(resolved) {
  if (!resolved.tiers) return [];
  const lines = [];
  for (const [tier, variable] of Object.entries(TIER_VARS)) {
    const model = resolved.tiers[tier];
    if (nonEmpty(model)) lines.push(`set "${variable}=${model}"`);
  }
  return lines;
}

export function formatSetLines(resolved) {
  const inactiveVar = resolved.authVar === "ANTHROPIC_AUTH_TOKEN"
    ? "ANTHROPIC_API_KEY"
    : "ANTHROPIC_AUTH_TOKEN";
  return [
    `set "ANTHROPIC_BASE_URL=${resolved.baseUrl}"`,
    `set "${resolved.authVar}=${resolved.authValue}"`,
    `set "${inactiveVar}="`,
    `set "LA_PROVIDER=${resolved.provider}"`,
    ...formatTierLines(resolved),
  ];
}

function formatCheck(resolved) {
  const lines = [
    `provider=${resolved.provider}`,
    `baseUrl=${resolved.baseUrl}`,
    `authVar=${resolved.authVar}`,
    `authEnv=${resolved.authEnv}`,
    `authPresent=${resolved.present ? "set" : "unset"}`,
  ];
  for (const [tier, variable] of Object.entries(TIER_VARS)) {
    const model = resolved.tiers?.[tier];
    lines.push(`${variable}=${nonEmpty(model) ? model : "(unset — squad launcher must provide it)"}`);
  }
  return lines;
}

function errorMessage(resolved) {
  return `Provider "${resolved.provider}" requires ${resolved.authEnv} (missing in environment or .env)`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const providerArg = args.find((a) => !a.startsWith("--")) || undefined;

  let resolved;
  try {
    resolved = resolveProvider(providerArg);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  if (check) {
    for (const line of formatCheck(resolved)) {
      console.log(line);
    }
    if (!resolved.present) {
      console.error(errorMessage(resolved));
      process.exit(1);
    }
    process.exit(0);
  }

  if (!resolved.present) {
    console.error(errorMessage(resolved));
    process.exit(1);
  }

  for (const line of formatSetLines(resolved)) {
    console.log(line);
  }
  process.exit(0);
}

// Run the CLI only when invoked directly, never on import (tests import the
// exported helpers without triggering a resolution against the real .env).
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main();
}