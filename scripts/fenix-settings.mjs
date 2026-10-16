// scripts/fenix-settings.mjs — the Settings overlay that survives `fenix
// update` (FOC-773/786). Reads, validates and atomically writes the
// settings.json whose location fenix-paths.settingsPath() decides: env
// overrides win, the repo-local .fenix/config is the fallback the overlay
// lives in. Validation is deliberately strict — this file drives model
// routing, so unknown keys and secret-looking values are refused outright.
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { settingsPath } from "./fenix-paths.mjs";

const PROVIDER_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;
const SQUAD_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
const KEY_NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const TIER_NAMES = ["opus", "sonnet", "haiku", "smallFast"];
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "host.docker.internal"]);
// Anything shaped like a real credential — the settings file is shared and
// diffed, so a pasted key must be caught before it lands on disk.
const SECRET_RE = /sk-or-|sk-ant-|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_|lin_api_/;

export function emptySettings() {
  return { provider: { active: null, custom: null }, routing: {} };
}

export function readSettings({ path = settingsPath() } = {}) {
  if (!existsSync(path)) return emptySettings();
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`settings.json is not valid JSON: ${path}`);
  }
  return parsed;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkSecrets(node, where, errors) {
  if (typeof node === "string") {
    if (SECRET_RE.test(node)) errors.push(`${where}: settings must not contain secrets`);
    return;
  }
  if (isPlainObject(node)) {
    for (const [key, value] of Object.entries(node)) {
      checkSecrets(value, `${where}.${key}`, errors);
    }
  }
}

function checkNonEmptyString(value, label, max, errors) {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    errors.push(`${label}: must be a non-empty string of at most ${max} characters`);
  }
}

function checkProviderCustom(custom, errors) {
  const allowed = ["baseUrl", "authStyle", "keyName", "tiers", "defaultModel"];
  for (const key of Object.keys(custom)) {
    if (!allowed.includes(key)) errors.push(`provider.custom.${key}: unknown key`);
  }
  let url;
  try {
    url = new URL(custom.baseUrl);
  } catch {
    url = null;
  }
  if (!url || !/^https?:$/.test(url.protocol)) {
    errors.push("provider.custom.baseUrl: must be an absolute http(s) URL");
  } else if (url.protocol === "http:" && !LOCAL_HOSTS.has(url.hostname)) {
    errors.push(
      `provider.custom.baseUrl: http is only allowed for 127.0.0.1, localhost or host.docker.internal, got ${url.hostname}`,
    );
  }
  if (custom.authStyle !== "token" && custom.authStyle !== "apikey") {
    errors.push('provider.custom.authStyle: must be "token" or "apikey"');
  }
  if (typeof custom.keyName !== "string" || !KEY_NAME_RE.test(custom.keyName)) {
    errors.push("provider.custom.keyName: must match /^[A-Z][A-Z0-9_]{1,63}$/");
  }
  if (!isPlainObject(custom.tiers)) {
    errors.push("provider.custom.tiers: must be an object");
  } else {
    for (const [tier, model] of Object.entries(custom.tiers)) {
      if (!TIER_NAMES.includes(tier)) errors.push(`provider.custom.tiers.${tier}: unknown tier`);
      else checkNonEmptyString(model, `provider.custom.tiers.${tier}`, 200, errors);
    }
  }
  checkNonEmptyString(custom.defaultModel, "provider.custom.defaultModel", 200, errors);
}

// FOC-901: the managed-task-session cap lives in the overlay so it survives
// `fenix update`. FOC-902 adds the opt-in autonomous pickup block. Kept in
// its own function so the open branches that edit the same validate loop
// keep merging trivially.
const AUTO_PICKUP_KEYS = new Set(["enabled", "pollSeconds", "states", "label", "workspace"]);
const AUTO_PICKUP_MAX_STATES = 10;
const AUTO_PICKUP_MAX_STRING = 100;

function autoPickupErrors(value, errors) {
  for (const key of Object.keys(value)) {
    if (!AUTO_PICKUP_KEYS.has(key)) errors.push(`taskSessions.autoPickup.${key}: unknown key`);
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    errors.push("taskSessions.autoPickup.enabled: must be a boolean");
  }
  if (
    value.pollSeconds !== undefined &&
    (!Number.isInteger(value.pollSeconds) || value.pollSeconds < 60 || value.pollSeconds > 3600)
  ) {
    errors.push("taskSessions.autoPickup.pollSeconds: must be an integer between 60 and 3600");
  }
  if (value.states !== undefined) {
    const states = value.states;
    const ok =
      Array.isArray(states) &&
      states.length >= 1 &&
      states.length <= AUTO_PICKUP_MAX_STATES &&
      states.every((s) => typeof s === "string" && s.trim() !== "" && s.length <= AUTO_PICKUP_MAX_STRING);
    if (!ok) {
      errors.push(
        `taskSessions.autoPickup.states: must be an array of 1 to ${AUTO_PICKUP_MAX_STATES} non-empty state names of at most ${AUTO_PICKUP_MAX_STRING} characters`,
      );
    }
  }
  if (
    value.label !== undefined &&
    value.label !== null &&
    (typeof value.label !== "string" || value.label.trim() === "" || value.label.length > AUTO_PICKUP_MAX_STRING)
  ) {
    errors.push(
      `taskSessions.autoPickup.label: must be null or a non-empty string of at most ${AUTO_PICKUP_MAX_STRING} characters`,
    );
  }
  if (
    value.workspace !== undefined &&
    value.workspace !== null &&
    (typeof value.workspace !== "string" || !/^[A-Za-z0-9._-]+$/.test(value.workspace) || value.workspace.length > 200)
  ) {
    errors.push(
      "taskSessions.autoPickup.workspace: must be null or a canonical workspace identifier matching /^[A-Za-z0-9._-]+$/ of at most 200 characters",
    );
  }
}

function taskSessionsErrors(value) {
  const errors = [];
  if (!isPlainObject(value)) {
    errors.push("taskSessions: must be an object");
    return errors;
  }
  for (const key of Object.keys(value)) {
    if (key !== "maxActive" && key !== "autoPickup") errors.push(`taskSessions.${key}: unknown key`);
  }
  if (value.maxActive !== undefined && (!Number.isInteger(value.maxActive) || value.maxActive < 1 || value.maxActive > 8)) {
    errors.push("taskSessions.maxActive: must be an integer between 1 and 8");
  }
  if (value.autoPickup !== undefined) {
    if (!isPlainObject(value.autoPickup)) errors.push("taskSessions.autoPickup: must be an object");
    else autoPickupErrors(value.autoPickup, errors);
  }
  return errors;
}

function checkTaskSessions(value, errors) {
  errors.push(...taskSessionsErrors(value));
}

export function validateSettings(obj) {
  const errors = [];
  if (!isPlainObject(obj)) return { ok: false, errors: ["settings: must be a JSON object"] };

  for (const key of Object.keys(obj)) {
    if (key !== "provider" && key !== "routing" && key !== "taskSessions") errors.push(`${key}: unknown top-level key`);
  }

  if (obj.taskSessions !== undefined) checkTaskSessions(obj.taskSessions, errors);

  const provider = obj.provider;
  if (provider !== undefined) {
    if (!isPlainObject(provider)) errors.push("provider: must be an object");
    else {
      for (const key of Object.keys(provider)) {
        if (key !== "active" && key !== "custom") errors.push(`provider.${key}: unknown key`);
      }
      if (provider.active !== null && provider.active !== undefined) {
        if (typeof provider.active !== "string" || !PROVIDER_NAME_RE.test(provider.active)) {
          errors.push("provider.active: must be null or match /^[a-z][a-z0-9_]{0,31}$/");
        }
      }
      if (provider.active === "custom" && !isPlainObject(provider.custom)) {
        errors.push("provider.custom: required when active is custom");
      }
      if (provider.custom !== null && provider.custom !== undefined) {
        if (!isPlainObject(provider.custom)) errors.push("provider.custom: must be an object");
        else checkProviderCustom(provider.custom, errors);
      }
    }
  }

  const routing = obj.routing;
  if (routing !== undefined) {
    if (!isPlainObject(routing)) errors.push("routing: must be an object");
    else {
      for (const [squad, entry] of Object.entries(routing)) {
        if (!SQUAD_NAME_RE.test(squad)) {
          errors.push(`routing.${squad}: squad name must match /^[a-z][a-z0-9-]{0,31}$/`);
          continue;
        }
        if (!isPlainObject(entry)) errors.push(`routing.${squad}: must be an object`);
        else {
          for (const key of Object.keys(entry)) {
            if (key !== "lead") errors.push(`routing.${squad}.${key}: unknown key`);
          }
          checkNonEmptyString(entry.lead, `routing.${squad}.lead`, 200, errors);
        }
      }
    }
  }

  checkSecrets(obj, "settings", errors);
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Read side for non-CLI callers (task-session-host, fenix-doctor): the
// task-session cap and the FOC-902 auto-pickup config from the overlay.
// Never throws — a missing, unreadable or invalid overlay reads as
// { maxActive: null, autoPickup: null } and the caller falls back to its
// default. Exactly one stderr line names what was ignored and why —
// unless opts.quiet is set (UI/doctor contexts that must not print mid-run):
// then the line is suppressed and returned as `error` for the caller to
// surface where it fits.
// autoPickup, when configured, is returned NORMALIZED with the documented
// defaults filled in: { enabled: false, pollSeconds: 300, states: ["Backlog"],
// label: null, workspace: null }. An invalid overlay discards the whole
// taskSessions section — never half a config.
// ---------------------------------------------------------------------------

const AUTO_PICKUP_DEFAULTS = { enabled: false, pollSeconds: 300, states: ["Backlog"], label: null, workspace: null };

export function normalizeAutoPickup(raw) {
  return {
    enabled: raw.enabled ?? AUTO_PICKUP_DEFAULTS.enabled,
    pollSeconds: raw.pollSeconds ?? AUTO_PICKUP_DEFAULTS.pollSeconds,
    states: Array.isArray(raw.states) && raw.states.length > 0 ? [...raw.states] : [...AUTO_PICKUP_DEFAULTS.states],
    label: typeof raw.label === "string" ? raw.label : AUTO_PICKUP_DEFAULTS.label,
    workspace: typeof raw.workspace === "string" ? raw.workspace : AUTO_PICKUP_DEFAULTS.workspace,
  };
}

export function readTaskSessionsSettings(env = process.env, { quiet = false } = {}) {
  const fail = (message) => {
    if (!quiet) console.error(message);
    return quiet ? { maxActive: null, autoPickup: null, error: message } : { maxActive: null, autoPickup: null };
  };
  let settings;
  try {
    settings = readSettings({ path: settingsPath(env) });
  } catch (err) {
    return fail(`settings: ${err?.message ?? err} — taskSessions settings ignored`);
  }
  const value = isPlainObject(settings) ? settings.taskSessions : undefined;
  if (value === undefined) return { maxActive: null, autoPickup: null };
  const errors = taskSessionsErrors(value);
  if (errors.length > 0) {
    return fail(`settings ${errors[0]} — ignoring the taskSessions section`);
  }
  return {
    maxActive: value.maxActive ?? null,
    autoPickup: value.autoPickup !== undefined ? normalizeAutoPickup(value.autoPickup) : null,
  };
}

// Deep merge where a `null` patch value deletes the key from the result —
// the only way to go back from a configured provider to the built-in one.
function mergeInto(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete target[key];
    } else if (isPlainObject(value) && isPlainObject(target[key])) {
      mergeInto(target[key], value);
    } else if (isPlainObject(value)) {
      target[key] = mergeInto({}, value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

export function writeSettings(patch, { path = settingsPath(), dryRun = false } = {}) {
  const current = readSettings({ path });
  const merged = mergeInto(
    isPlainObject(current) ? current : emptySettings(),
    isPlainObject(patch) ? patch : {},
  );
  const { ok, errors } = validateSettings(merged);
  if (!ok) {
    throw new Error(`settings.json validation failed:\n- ${errors.join("\n- ")}`);
  }
  if (dryRun) return merged;
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.settings-${randomUUID()}.tmp`);
  writeFileSync(temp, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  try {
    renameSync(temp, path);
  } catch (err) {
    try {
      unlinkSync(temp); // never leave a stray temp next to the real file
    } catch {}
    throw err;
  }
  return merged;
}

// ---------------------------------------------------------------------------
// CLI — `get <dotted.path>` and `set <dotted.path> <value>` for shell callers
// (the entrypoint's Supervisor model chain, the fenix key wizard). `get`
// prints the string at the path, or nothing when it is missing; `set` parses
// the value as JSON when it parses (so `null` deletes, objects replace) and
// falls back to the raw string. Both fail loudly on stderr so the caller can
// react: exit 1 on settings/validation errors, 2 on usage.
// ---------------------------------------------------------------------------

function getValue(obj, dotted) {
  let node = obj;
  for (const key of dotted.split(".")) {
    if (!isPlainObject(node)) return undefined;
    node = node[key];
  }
  return node;
}

/** Build a nested patch { a: { b: value } } from "a.b" and a raw CLI value. */
function patchFrom(dotted, raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    value = raw; // not JSON — store it as a plain string
  }
  const keys = dotted.split(".");
  const patch = {};
  let node = patch;
  for (let i = 0; i < keys.length - 1; i++) {
    node = node[keys[i]] = {};
  }
  node[keys[keys.length - 1]] = value;
  return patch;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "get" && rest.length === 1) {
    let settings;
    try {
      settings = readSettings();
    } catch (err) {
      console.error(err?.message || String(err));
      process.exit(1);
    }
    const { ok, errors } = validateSettings(settings);
    if (!ok) {
      console.error(`settings.json is invalid:\n- ${errors.join("\n- ")}`);
      process.exit(1);
    }
    const value = getValue(settings, rest[0]);
    if (typeof value === "string") console.log(value);
    return;
  }
  if ((cmd === "set" || cmd === "validate") && rest.length === 2) {
    try {
      writeSettings(patchFrom(rest[0], rest[1]), { dryRun: cmd === "validate" });
    } catch (err) {
      console.error(err?.message || String(err));
      process.exit(1);
    }
    return;
  }
  console.error("Usage: node scripts/fenix-settings.mjs get <dotted.path>");
  console.error("       node scripts/fenix-settings.mjs set|validate <dotted.path> <value>");
  console.error("  The value is parsed as JSON when it parses (null deletes the key),");
  console.error("  otherwise stored as a plain string.");
  process.exit(2);
}

// Guard: only run main() when called directly (not when imported as module)
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  main();
}
