#!/usr/bin/env node
// provider-resolve.mjs — resolve the per-squad provider at launch.
//
// CLI:
//   node scripts/provider-resolve.mjs [provider]           → emit set lines
//   node scripts/provider-resolve.mjs [provider] --check   → print resolution summary
//   node scripts/provider-resolve.mjs --list               → name<TAB>baseUrl per provider
//
// The provider name comes from the CLI arg, then LA_PROVIDER env, then the
// settings overlay's provider.active (FOC-773), then defaults to "openrouter".
// A provider named "custom" resolves entirely from settings.provider.custom.
// Reads config/models.json (providers map) and .env (key values). Emits set
// "VAR=value" lines for cmd for /f consumption.
//
// Env overrides for tests:
//   LA_PROVIDER_CONFIG     path to the models.json (defaults to config/models.json)
//   LA_PROVIDER_ENV_FILE   path to the .env file (defaults to .env)
//   LA_SETTINGS_FILE       path to the settings overlay (via fenix-paths)
//
// --check prints the resolution (no secret values) and exits 0 when the
// provider is resolvable, 1 when the key is missing or unknown. Secret values
// are never printed except in the set lines themselves (consumed, not echoed).

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readSettings } from "./fenix-settings.mjs";
import { settingsPath } from "./fenix-paths.mjs";

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

/** A launcher exports the resolved provider for child tools. That derived
 * value is not a user override: re-read Settings on the next resolution.
 * An explicit LA_PROVIDER still wins, including a changed value in a shell. */
export function providerEnvOverride(env = process.env) {
  if (!nonEmpty(env.LA_PROVIDER)) return null;
  const inherited = env.LA_PROVIDER_RESOLVED === env.LA_PROVIDER
    && ["settings", "default"].includes(env.LA_PROVIDER_SOURCE);
  return inherited ? null : env.LA_PROVIDER;
}

/** Mounted secret files are authoritative and re-read on every resolution.
 * In-place rotation is visible through both the API mount and Compose secrets.
 * Empty mounted files must not resurrect a key inherited from an old process. */
function mountedProviderKey(authEnv, env) {
  const dir = env.LA_SECRETS_DIR || (env.FENIX_IN_CONTAINER === "1" ? "/run/secrets" : null);
  if (!dir) return null;
  const names = [...new Set([
    /^[A-Z][A-Z0-9_]*$/.test(authEnv || "") ? authEnv.toLowerCase() : null,
    "provider_api_key",
  ].filter(Boolean))];
  let mounted = false;
  for (const name of names) {
    try {
      const value = readFileSync(join(dir, name), "utf8").trim();
      mounted = true;
      if (value) return { value };
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error("Cannot read mounted provider credential");
    }
  }
  return mounted ? { value: null } : null;
}

/**
 * Read the settings overlay for provider resolution. Errors propagate named —
 * a broken overlay must never silently fall back to the default provider.
 */
function readSettingsForResolve(options) {
  return readSettings({ path: options.settingsPath ?? settingsPath(options.env || process.env) });
}

/**
 * Resolve a provider by name.
 *
 * Active provider precedence: explicit arg > env.LA_PROVIDER >
 * settings.provider.active > "openrouter"; `providerSource` records which rule
 * won (arg|env|settings|default). A provider named "custom" resolves from
 * settings.provider.custom (baseUrl, authStyle, keyName, tiers, defaultModel).
 *
 * @param {string} [provider] - explicit provider name
 * @param {object} [options]
 * @param {string} [options.configPath] - path to models.json (default: config/models.json)
 * @param {string} [options.envPath] - path to .env (default: .env)
 * @param {object} [options.env] - environment map (default: process.env)
 * @param {string} [options.settingsPath] - path to the settings overlay
 *   (default: fenix-paths.settingsPath, i.e. LA_SETTINGS_FILE-aware)
 * @returns {{ provider, providerSource, baseUrl, authVar, authEnv, authStyle,
 *   authValue, authSource, present, tiers, defaultModel }}
 *   present is true when the auth key was found; authSource is
 *   secret|env|envfile|generic|unset (mounted files precede env; generic = the shared PROVIDER_API_KEY secret).
 * @throws {Error} on unknown provider, missing provider.custom, or a settings
 *   read error (never silently defaulted).
 */
export function resolveProvider(provider, options = {}) {
  const configPath = options.configPath
    || process.env.LA_PROVIDER_CONFIG
    || join(root, "config", "models.json");
  const envPath = options.envPath
    || process.env.LA_PROVIDER_ENV_FILE
    || join(root, ".env");
  const env = options.env || process.env;

  // The overlay is read lazily: only when it actually decides the provider
  // (nothing explicit) or a "custom" entry needs its block. Existing callers
  // that pass an explicit built-in name never touch it.
  let settings = null;
  let name;
  let providerSource;
  if (provider) {
    name = provider;
    providerSource = "arg";
  } else if (providerEnvOverride(env)) {
    name = providerEnvOverride(env);
    providerSource = "env";
  } else {
    settings = readSettingsForResolve(options);
    const active = settings?.provider?.active;
    if (nonEmpty(active)) {
      name = active;
      providerSource = "settings";
    } else {
      name = DEFAULT_PROVIDER;
      providerSource = "default";
    }
  }

  let entry;
  if (name === "custom") {
    settings = settings || readSettingsForResolve(options);
    const custom = settings?.provider?.custom;
    if (!custom) {
      throw new Error("provider 'custom' selected but settings.json has no provider.custom");
    }
    entry = {
      baseUrl: custom.baseUrl,
      authEnv: custom.keyName || "PROVIDER_API_KEY",
      authStyle: custom.authStyle,
      tiers: custom.tiers,
      defaultModel: custom.defaultModel,
    };
  } else {
    const providers = loadProviders(configPath);
    entry = providers[name];
    if (!entry) {
      const valid = Object.keys(providers).join(", ");
      throw new Error(`Unknown provider "${name}" (valid: ${valid})`);
    }
  }

  const authStyle = entry.authStyle || "token";
  const authVar = authStyle === "apikey" ? "ANTHROPIC_API_KEY" : "ANTHROPIC_AUTH_TOKEN";
  const authEnv = entry.authEnv;

  const envFile = parseEnvFile(envPath);
  // Key precedence: freshly read mounted files, then the provider's own
  // env var (process env, then .env), then
  // the generic Compose secret PROVIDER_API_KEY that the entrypoint maps to
  // the active provider's authEnv at start. The value never leaves this
  // function except inside the set lines (consumed, not echoed).
  let authValue = null;
  let authSource = "unset";
  const mounted = mountedProviderKey(authEnv, env);
  if (mounted) {
    authValue = mounted.value;
    authSource = "secret";
  } else if (nonEmpty(env[authEnv])) {
    authValue = env[authEnv];
    authSource = "env";
  } else if (nonEmpty(envFile[authEnv])) {
    authValue = envFile[authEnv];
    authSource = "envfile";
  } else if (authEnv !== "PROVIDER_API_KEY" && nonEmpty(env.PROVIDER_API_KEY)) {
    authValue = env.PROVIDER_API_KEY;
    authSource = "generic";
  }

  // FOC-164: env override for baseUrl — LA_PROVIDER_BASEURL_<PROVIDER>.
  // Uppercase the provider name, non-alphanumeric → '_'. Additive: when
  // unset, the config baseUrl is used unchanged (no behaviour change).
  const envOverrideKey = `LA_PROVIDER_BASEURL_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  const envBaseUrl = nonEmpty(env[envOverrideKey]) ? env[envOverrideKey] : null;
  const baseUrl = envBaseUrl || entry.baseUrl;
  const baseUrlSource = envBaseUrl ? "env" : "config";

  return {
    provider: name,
    providerSource,
    baseUrl,
    baseUrlSource,
    authVar,
    authEnv,
    authStyle,
    authValue: authValue ?? null,
    authSource,
    present: Boolean(authValue),
    tiers: entry.tiers && typeof entry.tiers === "object" ? entry.tiers : null,
    defaultModel: entry.defaultModel || null,
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
    `set "${resolved.authVar}=${resolved.authValue ?? ""}"`,
    `set "${inactiveVar}="`,
    `set "LA_PROVIDER=${resolved.provider}"`,
    `set "LA_PROVIDER_SOURCE=${resolved.providerSource || "arg"}"`,
    `set "LA_PROVIDER_RESOLVED=${resolved.provider}"`,
    // FOC-773: a provider may declare its default model — the Supervisor's
    // model when nothing else (routing, --model) is set.
    ...(resolved.defaultModel
      ? [`set "LA_PROVIDER_DEFAULT_MODEL=${resolved.defaultModel}"`]
      : []),
    ...formatTierLines(resolved),
  ];
}

function formatCheck(resolved) {
  const lines = [
    `provider=${resolved.provider}`,
    `providerSource=${resolved.providerSource || "arg"}`,
    `baseUrl=${resolved.baseUrl}`,
    `baseUrlSource=${resolved.baseUrlSource || "config"}`,
    `authVar=${resolved.authVar}`,
    `authEnv=${resolved.authEnv}`,
    `authSource=${resolved.authSource || "unset"}`,
    `authPresent=${resolved.present ? "set" : "unset"}`,
    `defaultModel=${resolved.defaultModel || "(unset)"}`,
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

  // FOC-778: list the configured providers as `name<TAB>baseUrl` lines for the
  // fenix key wizard's provider menu (the overlay's "custom" entry is added by
  // the caller). No key resolution, no key values.
  if (args.includes("--list")) {
    const providers = loadProviders(
      process.env.LA_PROVIDER_CONFIG || join(root, "config", "models.json"),
    );
    for (const [name, entry] of Object.entries(providers)) {
      console.log(`${name}\t${entry?.baseUrl || ""}`);
    }
    process.exit(0);
  }

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