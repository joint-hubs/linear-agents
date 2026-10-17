// scripts/fenix-integrations.mjs — the optional-integrations switch (FOC-772).
//
// Atlas, the pisi workspace and the personal memory are Mateusz's local setup;
// a stock Fenix install has none of them. The three flags live in the Settings
// overlay under `integrations` (validated by fenix-settings.mjs) and every one
// defaults to false. `nebul` is deliberately not an overlay flag: it is derived
// from the resolved active provider (provider-resolve.mjs), which has been
// opt-in on its own since FOC-773.
//
// CLI:
//   node scripts/fenix-integrations.mjs show [--json]   → flags + source + prerequisites
//   node scripts/fenix-integrations.mjs enabled <name>  → exit 0 when on, 1 when off,
//                                                         2 on usage/unknown name or a
//                                                         settings error
//
// Env overrides for tests: LA_SETTINGS_FILE (via fenix-paths.settingsPath) and
// the provider-resolve seams (LA_PROVIDER_CONFIG, LA_PROVIDER_ENV_FILE).

import { statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { settingsPath } from "./fenix-paths.mjs";
import { readSettings, validateSettings } from "./fenix-settings.mjs";
import { providerEnvOverride, resolveProvider } from "./provider-resolve.mjs";

export const INTEGRATIONS = ["atlas", "pisi", "memory", "nebul"];

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value) {
  return value !== undefined && value !== null && value !== "";
}

// Derive the active provider name with the resolver's precedence, but from the
// settings object the caller handed in: env override (providerEnvOverride, so a
// derived LA_PROVIDER does not masquerade as a user choice) >
// settings.provider.active > openrouter. The name is then passed to the
// resolver as an explicit arg — resolveProvider would otherwise re-read the
// settings file, and here the caller's settings object is authoritative
// (the doctor and tests inject it; there may be no file behind it at all).
function activeProviderName(settings, env) {
  const override = providerEnvOverride(env);
  if (override) return override;
  const active = settings?.provider?.active;
  return nonEmpty(active) ? active : "openrouter";
}

/** Pass the provider-resolve seams through from the injected env so a test or
 *  caller never falls back to process.env behind its own env object. */
function resolverOptions(env) {
  return {
    env,
    configPath: nonEmpty(env.LA_PROVIDER_CONFIG) ? env.LA_PROVIDER_CONFIG : undefined,
    envPath: nonEmpty(env.LA_PROVIDER_ENV_FILE) ? env.LA_PROVIDER_ENV_FILE : undefined,
  };
}

/**
 * Read the integrations switch.
 *
 * @param {object} [options]
 * @param {object} [options.settings] - settings overlay (default: readSettings())
 * @param {object} [options.env] - environment map (default: process.env)
 * @returns {{ atlas: boolean, pisi: boolean, memory: boolean, nebul: boolean,
 *   source: "overlay"|"default" }}
 *   The three overlay flags default to false and come ONLY from the overlay.
 *   `nebul` is true when the resolved active provider is "nebul" — a missing
 *   or unknown provider config is treated as false, never thrown.
 *   `source` says whether the overlay carried an `integrations` key.
 * @throws {Error} when the settings fail validation — same contract as
 *   writeSettings; an invalid overlay must not silently read as "all off".
 */
export function readIntegrations({ settings = readSettings(), env = process.env } = {}) {
  const { ok, errors } = validateSettings(settings);
  if (!ok) {
    throw new Error(`settings.json validation failed:\n- ${errors.join("\n- ")}`);
  }
  const overlay = isPlainObject(settings.integrations) ? settings.integrations : null;
  const flag = (name) => overlay?.[name] === true;

  let resolved = null;
  try {
    resolved = resolveProvider(activeProviderName(settings, env), resolverOptions(env));
  } catch {
    resolved = null; // missing/unknown provider config — treat nebul as off
  }

  return {
    atlas: flag("atlas"),
    pisi: flag("pisi"),
    memory: flag("memory"),
    nebul: resolved?.provider === "nebul",
    source: overlay ? "overlay" : "default",
  };
}

// The warn-once ledger for readIntegrationsSafe: one line per process per
// distinct validation message, so a hot path consulted on every request
// cannot spam the log (the message dedupes, not the call).
const warnedInvalid = new Set();

/**
 * The fail-closed read for hot paths. Same result shape as readIntegrations,
 * but a corrupt/unreadable overlay never throws: every flag reads as false,
 * `source` is "invalid" and `error` carries the validation message, preceded
 * by ONE warn per process per distinct message:
 * `[warn] settings invalid — integrations treated as off: …`
 *
 * Use THIS on any read-only path that runs per request (work routes, board
 * lookups, findIssueProject, seeding). Use readIntegrations at write time or
 * in the doctor, where a corrupt overlay must surface as a thrown error.
 *
 * @param {object} [options]
 * @param {object} [options.settings] - settings overlay (default: readSettings())
 * @param {object} [options.env] - environment map (default: process.env)
 * @param {function} [options.warn] - warn sink (default: console.warn)
 * @returns {{ atlas: boolean, pisi: boolean, memory: boolean, nebul: boolean,
 *   source: "overlay"|"default"|"invalid", error?: string }}
 */
export function readIntegrationsSafe({ settings, env = process.env, warn = console.warn } = {}) {
  try {
    return readIntegrations({ settings: settings !== undefined ? settings : readSettings(), env });
  } catch (err) {
    const error = err?.message || String(err);
    if (!warnedInvalid.has(error)) {
      warnedInvalid.add(error);
      warn(`[warn] settings invalid — integrations treated as off: ${error}`);
    }
    return { atlas: false, pisi: false, memory: false, nebul: false, source: "invalid", error };
  }
}

// Per-request memo for cachedIntegrations. Keyed by the settings file path +
// mtime (plus the provider env overrides that feed nebul's derivation), so an
// external settings write invalidates the entry on the next read — the 5 s TTL
// only bounds how long a read survives when the file's mtime does not change.
// The settings write path (fenix-settings.mjs) is deliberately not imported
// here to clear the cache: the mtime key is enough.
const INTEGRATIONS_CACHE_TTL_MS = 5000;
const integrationsCache = new Map(); // "<path>:<mtime|absent>:<provider-env>" → { ts, value }

/** Clear the cachedIntegrations memo (tests). */
export function resetIntegrationsCache() {
  integrationsCache.clear();
}

/**
 * Memoized readIntegrationsSafe for the per-request hot paths. The overlay
 * file is read and validated at most once per 5 s per path+mtime; a settings
 * write bumps the mtime and the next read re-validates. A path with no file
 * behind it caches under an "absent" key, so a file that appears invalidates
 * immediately.
 *
 * @param {object} [options]
 * @param {object} [options.env] - environment map (default: process.env); its
 *   LA_SETTINGS_FILE / LA_PROJECTS_FILE pick the overlay path
 * @param {number} [options.ttlMs] - cache TTL (default 5000)
 * @param {function} [options.readSettingsImpl] - the reader (default
 *   readSettings), injectable so tests can count reads
 * @returns {{ atlas: boolean, pisi: boolean, memory: boolean, nebul: boolean,
 *   source: string, error?: string }}
 */
export function cachedIntegrations({ env = process.env, ttlMs = INTEGRATIONS_CACHE_TTL_MS, readSettingsImpl = readSettings, warn = console.warn } = {}) {
  const path = settingsPath(env);
  let mtime;
  try {
    mtime = statSync(path).mtimeMs;
  } catch {
    mtime = null; // no file yet — readSettings' emptySettings path
  }
  // The provider envs feed nebul's derivation (activeProviderName), so they
  // belong in the key beside the file identity.
  const key = `${path}:${mtime === null ? "absent" : mtime}:${env.LA_PROVIDER || ""}:${env.LA_PROVIDER_RESOLVED || ""}`;
  const now = Date.now();
  const hit = integrationsCache.get(key);
  if (hit && now - hit.ts < ttlMs) return hit.value;
  const value = readIntegrationsSafe({ settings: readSettingsImpl({ path }), env, warn });
  integrationsCache.set(key, { ts: now, value });
  return value;
}

/**
 * Whether an integration is enabled.
 *
 * With a `settings` object injected the overlay is read directly (no cache —
 * the caller owns the freshness). Without one the read goes through
 * cachedIntegrations (5 s TTL keyed by the settings path + mtime), so the
 * per-request hot paths do not re-read and re-validate the overlay file on
 * every call. Either way an invalid overlay fails closed to off
 * (readIntegrationsSafe, one warn per process) — this never throws for a
 * corrupt settings file.
 *
 * @param {string} name - one of INTEGRATIONS
 * @param {object} [opts] - readIntegrationsSafe options ({ settings, env, warn }),
 *   plus { ttlMs, readSettingsImpl, warn } forwarded to the cached read
 * @returns {boolean}
 * @throws {TypeError} on an unknown integration name
 */
export function integrationEnabled(name, opts = {}) {
  if (!INTEGRATIONS.includes(name)) {
    throw new TypeError(`unknown integration: ${name} (valid: ${INTEGRATIONS.join(", ")})`);
  }
  const { settings, env = process.env, ttlMs, readSettingsImpl, warn } = opts;
  const read = settings !== undefined
    ? readIntegrationsSafe({ settings, env, warn })
    : cachedIntegrations({ env, ttlMs, readSettingsImpl, warn });
  return Boolean(read[name]);
}

/**
 * Environment prerequisites an integration needs before it actually works.
 * Only the process env is consulted here — the doctor and the CLI callers
 * report what is missing by NAME, never by value.
 *
 * @param {string} name - one of INTEGRATIONS
 * @param {object} [env] - environment map (default: process.env)
 * @returns {{ ok: boolean, missing: string[], required: string[] }}
 *   `missing` names the absent variables (empty when ok); `required` lists
 *   every variable the integration wants (memory needs none; for nebul it is
 *   the provider credential name provider-resolve uses — its authEnv).
 * @throws {TypeError} on an unknown integration name
 */
export function prerequisites(name, env = process.env) {
  const checkEnv = (required) => {
    const missing = required.filter((variable) => !nonEmpty(env[variable]));
    return { ok: missing.length === 0, missing, required };
  };
  if (name === "atlas") return checkEnv(["ATLAS_ROOT", "ATLAS_VENV_PYTHON"]);
  if (name === "pisi") return checkEnv(["LINEAR_API_KEY_PISI"]);
  if (name === "memory") return { ok: true, missing: [], required: [] };
  if (name === "nebul") {
    // The credential name comes from the resolver (models.json's authEnv), not
    // a hardcoded string, so a provider-table rename stays one edit.
    try {
      const resolved = resolveProvider("nebul", resolverOptions(env));
      return resolved.present
        ? { ok: true, missing: [], required: [resolved.authEnv] }
        : { ok: false, missing: [resolved.authEnv], required: [resolved.authEnv] };
    } catch {
      return { ok: false, missing: ["NEBUL_API_KEY"], required: ["NEBUL_API_KEY"] };
    }
  }
  throw new TypeError(`unknown integration: ${name} (valid: ${INTEGRATIONS.join(", ")})`);
}

// ---------------------------------------------------------------------------
// CLI — `show` and `enabled <name>` for shell callers (launchers ask "is atlas
// on?" via the exit code, without parsing JSON). `enabled` exit codes: 0 on,
// 1 off, 2 usage/unknown name/settings error — the check is fail-closed
// (readIntegrationsSafe), so a corrupt overlay surfaces as source "invalid"
// and exits 2, never as a plain "off". `show` keeps 1 for a settings error;
// it is a human diagnostic, not a launcher check.
// ---------------------------------------------------------------------------

function usage() {
  console.error("Usage: node scripts/fenix-integrations.mjs show [--json]");
  console.error("       node scripts/fenix-integrations.mjs enabled <atlas|pisi|memory|nebul>");
  process.exit(2);
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "show" && rest.every((arg) => arg === "--json")) {
    let integrations;
    try {
      integrations = readIntegrations();
    } catch (err) {
      console.error(err?.message || String(err));
      process.exit(1);
    }
    if (rest.includes("--json")) {
      const prereqs = {};
      for (const name of INTEGRATIONS) {
        const { ok, missing } = prerequisites(name);
        prereqs[name] = { ok, missing };
      }
      console.log(JSON.stringify({ ...integrations, prerequisites: prereqs }, null, 2));
    } else {
      for (const name of INTEGRATIONS) console.log(`${name}=${integrations[name] ? "on" : "off"}`);
      console.log(`source=${integrations.source}`);
      for (const name of INTEGRATIONS) {
        if (!integrations[name]) continue;
        const { ok, missing } = prerequisites(name);
        console.log(ok ? `${name}: prerequisites present` : `${name}: missing ${missing.join(", ")}`);
      }
    }
    return;
  }
  if (cmd === "enabled" && rest.length === 1) {
    const name = rest[0];
    if (!INTEGRATIONS.includes(name)) {
      console.error(`unknown integration: ${name} (valid: ${INTEGRATIONS.join(", ")})`);
      process.exit(2);
    }
    // Fail-closed check: a corrupt overlay reads as source "invalid" and exits
    // 2 (check failed) — launchers warn on errorlevel 2, never read it as off.
    // The validation message is already on stderr via the one-time
    // readIntegrationsSafe warn; the exit code is the launcher's signal.
    const integrations = readIntegrationsSafe();
    if (integrations.source === "invalid") {
      process.exit(2);
    }
    const on = Boolean(integrations[name]);
    console.log(`${name}: ${on ? "enabled" : "disabled"}`);
    process.exit(on ? 0 : 1);
  }
  usage();
}

// Guard: only run main() when called directly (not when imported as module)
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  main();
}