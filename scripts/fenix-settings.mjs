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
// Owner ids for the `ownership` key (task ownership, FOC-848). Kept local —
// scripts/task-ownership.mjs imports this module for readSettings, so the
// constant cannot be shared without a cycle; the two regexes must not drift.
const OWNER_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
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

export function validateSettings(obj) {
  const errors = [];
  if (!isPlainObject(obj)) return { ok: false, errors: ["settings: must be a JSON object"] };

  for (const key of Object.keys(obj)) {
    if (key !== "provider" && key !== "routing" && key !== "publish" && key !== "ownership") errors.push(`${key}: unknown top-level key`);
  }

  // The publish overlay (FOC-788 follow-up): the dashboard's push/PR act as a
  // human by default; letting an AI actor through is an explicit operator
  // decision, so the only key here is the boolean aiActor and it defaults to
  // off by its absence.
  const publish = obj.publish;
  if (publish !== undefined) {
    if (!isPlainObject(publish)) errors.push("publish: must be an object");
    else {
      for (const key of Object.keys(publish)) {
        if (key !== "aiActor") errors.push(`publish.${key}: unknown key`);
      }
      if (publish.aiActor !== undefined && typeof publish.aiActor !== "boolean") {
        errors.push("publish.aiActor: must be a boolean");
      }
    }
  }

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

  // The `ownership` key (FOC-848): owners → Linear projects, plus the policy
  // for unlisted projects. Same shape rules the task-ownership loader's schema
  // enforces; validated here too so a malformed map never lands on disk.
  const ownership = obj.ownership;
  if (ownership !== undefined) {
    if (!isPlainObject(ownership)) errors.push("ownership: must be an object");
    else {
      for (const key of Object.keys(ownership)) {
        if (key !== "version" && key !== "owners" && key !== "unlisted") {
          errors.push(`ownership.${key}: unknown key`);
        }
      }
      if (ownership.version !== undefined && ownership.version !== 1) {
        errors.push("ownership.version: must be 1");
      }
      const owners = ownership.owners;
      if (!isPlainObject(owners)) errors.push("ownership.owners: must be an object");
      else {
        for (const [ownerId, entry] of Object.entries(owners)) {
          if (!OWNER_ID_RE.test(ownerId)) {
            errors.push(`ownership.owners.${ownerId}: owner id must match /^[a-z][a-z0-9-]{0,31}$/`);
            continue;
          }
          if (!isPlainObject(entry)) errors.push(`ownership.owners.${ownerId}: must be an object`);
          else {
            for (const key of Object.keys(entry)) {
              if (key !== "linearProjects") {
                errors.push(`ownership.owners.${ownerId}.${key}: unknown key`);
              }
            }
            const projects = entry.linearProjects;
            if (!Array.isArray(projects) || projects.length === 0) {
              errors.push(`ownership.owners.${ownerId}.linearProjects: must be a non-empty array`);
            } else {
              for (const [i, project] of projects.entries()) {
                if (typeof project !== "string" || !project.trim()) {
                  errors.push(`ownership.owners.${ownerId}.linearProjects[${i}]: must be a non-empty string`);
                }
              }
            }
          }
        }
      }
      if (ownership.unlisted !== undefined && ownership.unlisted !== "allow" && ownership.unlisted !== "ask") {
        errors.push('ownership.unlisted: must be "allow" or "ask"');
      }
    }
  }

  checkSecrets(obj, "settings", errors);
  return { ok: errors.length === 0, errors };
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
