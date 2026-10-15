// scripts/settings-routes.mjs — the Settings HTTP routes (FOC-786 slice G),
// dispatched by telemetry-server.mjs right beside the Work board routes.
//
// Transport only — the logic lives in the slice libraries this module wires
// together: fenix-settings (the overlay), key-check (live key validation),
// provider-resolve (provider entries), child-model + squad-config (routing
// rows and pricing), fenix-repos (the clone inventory), fenix-retention.
// The binding payload contracts are in docs/plans/fenix-settings-keys.md
// ("Settings API contracts").
//
// THE SECURITY BOUNDARY (FOC-778): no response, log line or stored record
// ever carries a key value or a request body. Key files are written IN PLACE
// (truncate + fchmod 0600 — never rename, the Compose bind mounts pin the
// inode) under LA_SECRETS_DIR, only after the candidate key passed its live
// check. `present` is a file-size/env-set fact, never a read of the value.
//
// Test seams: setSettingsDeps() swaps the check/library implementations for
// unit tests; the endpoint env seams (LA_LINEAR_CHECK_URL, LA_GITHUB_CHECK_URL,
// LA_OPENROUTER_KEY_URL) redirect the live checks at a local fake server, and
// provider-resolve's own LA_PROVIDER_BASEURL_* override moves the provider
// base URL — integration tests use those against the REAL server process.

import { accessSync, closeSync, existsSync, fchmodSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readSettings, validateSettings, writeSettings } from "./fenix-settings.mjs";
import { dataHome } from "./fenix-paths.mjs";
import { resolveProvider, loadProviders, providerEnvOverride } from "./provider-resolve.mjs";
import { checkProviderKey, checkLinearKey, checkGithubToken } from "./key-check.mjs";
import { listRepos, startClone, getCloneJob, listCloneJobs, unmapRepo, reposRoot } from "./fenix-repos.mjs";
import { cachedRetention } from "./fenix-retention.mjs";
import { readSquadConfig } from "./squad-config.mjs";
import { benchmarkFor } from "./model-benchmarks.mjs";
import { childModelFor } from "./child-model.mjs";
import { writeGuards } from "./cockpit-routes.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dir, "..");

// The same ceiling telemetry-server.mjs defaults readJsonBody to (8 KB).
const BODY_CAP = 8192;

const KEYS_NOTE =
  "a rotated key is used by new children at once; the Supervisor picks it up on its next fresh session";
const EFFECTIVE_ON = "the next child spawn; the Supervisor on its next fresh session";

// The key allow-list — anything else is a 404. `envNames` are ALL set on a
// successful save (github_token maps both spellings) and ALL count for
// `present`; `envName` is the canonical one shown in the UI.
const KEY_DEFS = [
  { name: "openrouter_api_key", label: "OpenRouter", envNames: ["OPENROUTER_API_KEY"], required: true },
  { name: "provider_api_key", label: "Custom provider", envNames: ["PROVIDER_API_KEY"], required: false },
  { name: "linear_api_key", label: "Linear", envNames: ["LINEAR_API_KEY"], required: true },
  { name: "github_token", label: "GitHub", envNames: ["GITHUB_TOKEN", "GH_TOKEN"], required: true },
];
const KEY_BY_NAME = new Map(KEY_DEFS.map((def) => [def.name, def]));

// ---------------------------------------------------------------------------
// Injectable dependencies (tests) — setSettingsDeps() swaps any of them.
// ---------------------------------------------------------------------------

const deps = {
  checks: { checkProviderKey, checkLinearKey, checkGithubToken },
  resolveProvider,
  loadProviders,
  readSettings,
  writeSettings,
  validateSettings,
  readSquadConfig,
  childModelFor,
  benchmarkFor,
  listRepos,
  startClone,
  getCloneJob,
  listCloneJobs,
  unmapRepo,
  reposRoot,
  cachedRetention,
};

/**
 * Swap dependencies for tests. `checks` is merged key-by-key so a test can
 * stub one check and keep the real others.
 *
 * @param {object} [overrides]
 */
export function setSettingsDeps(overrides = {}) {
  const { checks, ...rest } = overrides;
  Object.assign(deps, rest);
  if (checks) Object.assign(deps.checks, checks);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** The secrets directory (Docker: /fenix-secrets) — null when unset. */
function secretsDir() {
  const dir = process.env.LA_SECRETS_DIR;
  return dir && dir.trim() !== "" ? dir : null;
}

/** True when the secrets dir exists AND is writable (W_OK). */
function secretsWritable() {
  const dir = secretsDir();
  if (!dir || !existsSync(dir)) return false;
  try {
    accessSync(dir, 2 /* W_OK */);
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** Endpoint seams for the live checks (tests); each key only when set. */
function checkEndpoints() {
  const endpoints = {};
  if (process.env.LA_LINEAR_CHECK_URL) endpoints.linear = process.env.LA_LINEAR_CHECK_URL;
  if (process.env.LA_GITHUB_CHECK_URL) endpoints.github = process.env.LA_GITHUB_CHECK_URL;
  if (process.env.LA_OPENROUTER_KEY_URL) endpoints.openrouterKey = process.env.LA_OPENROUTER_KEY_URL;
  return endpoints;
}

/** The models.json path — provider-resolve's own default resolution. */
function modelsConfigPath() {
  return process.env.LA_PROVIDER_CONFIG || join(REPO_ROOT, "config", "models.json");
}

/** Parsed models.json, or {} when it cannot be read (rows empty, no crash). */
function readModelsConfig() {
  try {
    return JSON.parse(readFileSync(modelsConfigPath(), "utf8"));
  } catch {
    return {};
  }
}

/** The settings overlay, or emptySettings()-shaped nulls on a read error. */
function readSettingsSafe() {
  try {
    return deps.readSettings();
  } catch {
    return { provider: { active: null, custom: null }, routing: {} };
  }
}

/** Active provider name: LA_PROVIDER env > overlay > "openrouter". */
function activeProviderName() {
  const override = providerEnvOverride(process.env);
  if (override) return override.trim();
  const active = readSettingsSafe()?.provider?.active;
  return active || "openrouter";
}

/** The provider's cheapest-tier model: smallFast is the cheap tier by
 *  convention (the entrypoint maps ANTHROPIC_SMALL_FAST_MODEL from it). */
function cheapestModel(tiers) {
  if (!tiers || typeof tiers !== "object") return null;
  return tiers.smallFast || tiers.haiku || tiers.sonnet || tiers.opus || null;
}

/**
 * The state of one secrets file: the Compose bind mount pins the inode, so a
 * CLI rotation (or `fenix keys`) rewrites it in place while this process's env
 * still holds the stale start-up value. An existing file is therefore
 * AUTHORITATIVE: non-empty → its value, EMPTY → the key was cleared (env must
 * not resurrect it). Env counts only when the file does not exist at all.
 */
function storedFileState(name) {
  const dir = secretsDir();
  if (!dir) return { exists: false, value: null };
  try {
    const raw = readFileSync(join(dir, name), "utf8").trim();
    return { exists: true, value: raw !== "" ? raw : null };
  } catch {
    return { exists: false, value: null };
  }
}

/** present = a non-empty secrets file (SIZE only), else any env spelling. */
function keyPresent(def) {
  const file = storedFileState(def.name);
  if (file.exists) return file.value !== null;
  for (const envName of def.envNames) {
    const v = process.env[envName];
    if (typeof v === "string" && v.trim() !== "") return true;
  }
  return false;
}

/** The stored key for a name — the secrets file first (authoritative, an
 *  empty file means cleared), then the env spellings. The value never leaves
 *  this module except into a check call. */
function readStoredKey(def) {
  const file = storedFileState(def.name);
  if (file.exists) return file.value;
  for (const envName of def.envNames) {
    const v = process.env[envName];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return null;
}

/**
 * The key a provider check uses: the candidate spellings' FILES first (the
 * same authoritative rule — an existing file wins over env, an empty one
 * means cleared), then the env spelling. Only names, never values, reach a
 * response.
 */
function storedProviderKey(envName) {
  const dir = secretsDir();
  if (dir) {
    let sawFile = false;
    for (const file of [envName ? envName.toLowerCase() : null, "provider_api_key"]) {
      if (!file) continue;
      const state = storedFileState(file);
      if (state.exists) {
        sawFile = true;
        if (state.value !== null) return state.value;
      }
    }
    if (sawFile) return null; // a mounted file exists — never resurrect from env
  }
  if (envName && typeof process.env[envName] === "string" && process.env[envName].trim() !== "") {
    return process.env[envName].trim();
  }
  return null;
}

/** lastCheck ledger — `<dataHome>/settings/key-checks.json`, no values. */
function lastChecksPath() {
  return join(dataHome(), "settings", "key-checks.json");
}

function readLastChecks() {
  try {
    const parsed = JSON.parse(readFileSync(lastChecksPath(), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveLastCheck(name, check) {
  const all = readLastChecks();
  all[name] = {
    at: new Date().toISOString(),
    ok: Boolean(check?.ok),
    reason: String(check?.reason || ""),
  };
  mkdirSync(dirname(lastChecksPath()), { recursive: true });
  writeFileSync(lastChecksPath(), `${JSON.stringify(all, null, 2)}\n`, "utf8");
}

/**
 * Write a key file IN PLACE: open with O_TRUNC (mode 0600 at creation),
 * write, then fchmod 0600 — the Compose bind mounts pin the inode, so the
 * file is never replaced via rename.
 */
function writeKeyFile(path, value) {
  const fd = openSync(path, "w", 0o600);
  try {
    writeSync(fd, value, null, "utf8");
    try {
      fchmodSync(fd, 0o600);
    } catch {
      /* Windows: mode is a no-op, the ACL governs */
    }
  } finally {
    closeSync(fd);
  }
}

/** Live check for one allow-listed key against the candidate value. */
async function runKeyCheck(name, value, teamKey) {
  if (name === "linear_api_key") {
    return deps.checks.checkLinearKey({
      key: value,
      teamKey: teamKey || process.env.LINEAR_TEAM_KEY || undefined,
      endpoints: checkEndpoints(),
    });
  }
  if (name === "github_token") {
    return deps.checks.checkGithubToken({ token: value, endpoints: checkEndpoints() });
  }
  // openrouter_api_key and provider_api_key both go through the provider
  // entry: openrouter pinned by name, provider_api_key on the ACTIVE one.
  try {
    const resolved =
      name === "openrouter_api_key"
        ? deps.resolveProvider("openrouter")
        : deps.resolveProvider();
    return deps.checks.checkProviderKey({
      baseUrl: resolved.baseUrl,
      authStyle: resolved.authStyle,
      key: value,
      model: cheapestModel(resolved.tiers) || resolved.defaultModel || undefined,
      endpoints: checkEndpoints(),
    });
  } catch (err) {
    return { ok: false, reason: String(err?.message || err).split("\n")[0] };
  }
}

/** Live check for a provider (builtin name or a custom block) with a
 *  CANDIDATE key — PUT /provider's optional key candidate, checked against
 *  the NEW provider before anything is written. Used by providerPut. */
async function runProviderCheckWithKey({ active, custom, key }) {
  try {
    let baseUrl, authStyle, model;
    if (custom) {
      baseUrl = custom.baseUrl;
      authStyle = custom.authStyle || "token";
      model = cheapestModel(custom.tiers) || custom.defaultModel || undefined;
    } else {
      const resolved = deps.resolveProvider(active);
      baseUrl = resolved.baseUrl;
      authStyle = resolved.authStyle;
      model = cheapestModel(resolved.tiers) || resolved.defaultModel || undefined;
    }
    return deps.checks.checkProviderKey({ baseUrl, authStyle, key, model, endpoints: checkEndpoints() });
  } catch (err) {
    return { ok: false, reason: String(err?.message || err).split("\n")[0] };
  }
}

/** The key file a provider's candidate key is saved under: openrouter_api_key
 *  for OpenRouter (its own secret), the generic provider_api_key otherwise. */
function providerKeyTarget(active) {
  return active === "openrouter"
    ? { file: "openrouter_api_key", envNames: ["OPENROUTER_API_KEY"] }
    : { file: "provider_api_key", envNames: ["PROVIDER_API_KEY"] };
}

/** Live check for a provider (builtin name or a custom block) with the
 *  STORED key. Used by PUT /provider (no candidate given), POST /provider/test. */
async function runProviderCheck({ active, custom }) {
  try {
    let baseUrl, authStyle, model, keyEnv;
    if (custom) {
      baseUrl = custom.baseUrl;
      authStyle = custom.authStyle || "token";
      model = cheapestModel(custom.tiers) || custom.defaultModel || undefined;
      keyEnv = custom.keyName || "PROVIDER_API_KEY";
    } else {
      const resolved = deps.resolveProvider(active);
      baseUrl = resolved.baseUrl;
      authStyle = resolved.authStyle;
      model = cheapestModel(resolved.tiers) || resolved.defaultModel || undefined;
      keyEnv = resolved.authEnv;
    }
    const key = storedProviderKey(keyEnv);
    if (!key) return { ok: false, reason: `no key stored for ${keyEnv}` };
    return deps.checks.checkProviderKey({ baseUrl, authStyle, key, model, endpoints: checkEndpoints() });
  } catch (err) {
    return { ok: false, reason: String(err?.message || err).split("\n")[0] };
  }
}

/** An optional JSON body — {} when absent/unparseable, 413 still propagates
 *  (POST /keys/:name/validate takes no body; the others require one). */
async function readOptionalBody(req, readJsonBody) {
  try {
    return await readJsonBody(req, BODY_CAP);
  } catch (err) {
    if (err?.tooLarge) throw err;
    return {};
  }
}

/** Percent-encoded path segment, tolerated. */
function decodePart(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// ---------------------------------------------------------------------------
// Payload builders
// ---------------------------------------------------------------------------

function keysPayload() {
  const last = readLastChecks();
  return {
    writable: secretsWritable(),
    keys: KEY_DEFS.map((def) => ({
      name: def.name,
      label: def.label,
      required: def.required,
      present: keyPresent(def),
      envName: def.envNames[0],
      lastCheck: last[def.name] || null,
    })),
    note: KEYS_NOTE,
  };
}

function providerPayload() {
  let providers = [];
  try {
    const entries = deps.loadProviders(modelsConfigPath()) || {};
    providers = Object.entries(entries).map(([name, entry]) => ({
      name,
      baseUrl: entry?.baseUrl || null,
      authStyle: entry?.authStyle || "token",
      keyName: entry?.authEnv || null,
      defaultModel: entry?.defaultModel || null,
      tiers: entry?.tiers && typeof entry.tiers === "object" ? entry.tiers : null,
      builtin: true,
    }));
  } catch {
    providers = [];
  }
  const settings = readSettingsSafe();
  let active = settings?.provider?.active || null;
  let source = "settings";
  const override = providerEnvOverride(process.env);
  if (override) {
    active = override.trim();
    source = "env";
  } else if (!active) {
    active = "openrouter";
    source = "default";
  }
  return {
    active,
    source,
    providers,
    custom: settings?.provider?.custom || null,
    effectiveOn: EFFECTIVE_ON,
  };
}

/**
 * The Supervisor's actual model chain (docker/entrypoint.sh supervisor-run):
 * SUPERVISOR_MODEL > the overlay's routing.supervisor.lead > the provider's
 * defaultModel > the hard-coded xiaomi/mimo-v2.6-pro. models.json
 * routing.supervisor is NOT in this chain — the row must not show it.
 */
function supervisorModel({ settings, providerEntry }) {
  const envModel = process.env.SUPERVISOR_MODEL;
  if (typeof envModel === "string" && envModel.trim() !== "") {
    return { model: envModel.trim(), source: "env:SUPERVISOR_MODEL" };
  }
  const lead = settings?.routing?.supervisor?.lead;
  if (typeof lead === "string" && lead.trim() !== "") {
    return { model: lead.trim(), source: "settings:routing.supervisor" };
  }
  const defaultModel = providerEntry?.defaultModel;
  if (typeof defaultModel === "string" && defaultModel.trim() !== "") {
    return { model: defaultModel.trim(), source: "provider-default" };
  }
  return { model: "xiaomi/mimo-v2.6-pro", source: "fallback:xiaomi/mimo-v2.6-pro" };
}

function routingPayload() {
  const models = readModelsConfig();
  const { pricing } = deps.readSquadConfig();
  const provider = activeProviderName();
  const settings = readSettingsSafe();
  const providerEntry =
    provider === "custom" ? settings?.provider?.custom : models.providers?.[provider] || null;

  // Overlay-only squads must be listed too (and clearable via PUT) — the valid
  // set below is what PUT validates against.
  const routingKeys = Object.keys(models.routing || {}).filter((k) => !k.startsWith("_"));
  const overlayKeys = Object.keys(settings?.routing || {}).filter((k) => !k.startsWith("_"));
  const squads = [...new Set([...routingKeys, ...overlayKeys, "supervisor"])].sort();

  const priceOf = (modelId) => {
    const entry = modelId ? pricing?.[provider]?.[modelId] : null;
    return entry ? { input: entry.input, output: entry.output } : null;
  };

  const rows = squads.map((squad) => {
    const { model, source } =
      squad === "supervisor"
        ? supervisorModel({ settings, providerEntry })
        : deps.childModelFor({
            squad,
            explicitModel: null,
            settings,
            modelsConfig: models,
            provider,
            providerEntry,
          });
    const rowSource =
      source === null
        ? null
        : source.startsWith("settings:")
          ? "settings"
          : source.startsWith("routing:")
            ? "models.json"
            : source.startsWith("env:")
              ? "env"
              : source.startsWith("fallback:")
                ? "fallback"
                : "provider-default";
    const price = priceOf(model);
    return { squad, lead: model, source: rowSource, price, unpriced: price === null, benchmark: deps.benchmarkFor(model, provider) };
  });

  const scope = pricing?.[provider] || {};
  const modelsList = Object.keys(scope)
    .filter((id) => !id.startsWith("_"))
    .sort()
    .map((id) => ({ id, price: priceOf(id), benchmark: deps.benchmarkFor(id, provider) }));

  return { provider, rows, models: modelsList };
}

// ---------------------------------------------------------------------------
// Route handlers (one flat dispatcher, work-routes style)
// ---------------------------------------------------------------------------

export async function handleSettingsRoute(req, res, url, ctx) {
  const { readJsonBody, respondBodyError, json, log } = ctx;
  const method = req.method;
  const path = url.pathname;
  if (!path.startsWith("/api/settings/")) return false;

  const isWrite = method === "POST" || method === "PUT" || method === "DELETE";
  if (isWrite && !writeGuards(req, res, path, ctx)) return true;

  try {
    let m;

    // --- GET /api/settings/keys --------------------------------------------
    if (path === "/api/settings/keys") {
      if (method !== "GET") return methodMismatch(res, method, path, ctx);
      json(res, 200, keysPayload());
      log(method, path, 200);
      return true;
    }

    // --- POST /api/settings/keys/:name/validate -----------------------------
    if ((m = /^\/api\/settings\/keys\/([^/]+)\/validate$/.exec(path))) {
      if (method !== "POST") return methodMismatch(res, method, path, ctx);
      const def = KEY_BY_NAME.get(decodePart(m[1]));
      if (!def) return notFound(res, method, path, ctx);
      const body = await readOptionalBody(req, readJsonBody);
      const stored = readStoredKey(def);
      const check = stored
        ? await runKeyCheck(def.name, stored, body?.teamKey)
        : { ok: false, reason: `no key stored for ${def.name}` };
      if (stored) saveLastCheck(def.name, check);
      json(res, 200, { name: def.name, check });
      log(method, path, 200);
      return true;
    }

    // --- PUT /api/settings/keys/:name ---------------------------------------
    if ((m = /^\/api\/settings\/keys\/([^/]+)$/.exec(path))) {
      if (method !== "PUT") return methodMismatch(res, method, path, ctx);
      const def = KEY_BY_NAME.get(decodePart(m[1]));
      if (!def) return notFound(res, method, path, ctx);
      if (!secretsWritable()) {
        json(res, 503, { error: "secrets-not-writable" });
        log(method, path, 503);
        return true;
      }
      let body;
      try {
        body = await readJsonBody(req, BODY_CAP);
      } catch (err) {
        log(method, path, respondBodyError(res, err));
        return true;
      }
      const value = typeof body?.value === "string" ? body.value.trim() : "";
      if (value === "") {
        json(res, 400, { error: "empty" });
        log(method, path, 400);
        return true;
      }
      const check = await runKeyCheck(def.name, value, body?.teamKey);
      if (!check.ok) {
        json(res, 400, { error: "key-rejected", check });
        log(method, path, 400);
        return true;
      }
      // The check passed — write IN PLACE, then update this process's env,
      // then the lastCheck ledger. The value is dropped right after use.
      writeKeyFile(join(secretsDir(), def.name), value);
      for (const envName of def.envNames) process.env[envName] = value;
      saveLastCheck(def.name, check);
      body = null;
      json(res, 200, { name: def.name, saved: true, check });
      log(method, path, 200);
      return true;
    }

    // --- GET/PUT /api/settings/provider -------------------------------------
    if (path === "/api/settings/provider") {
      if (method === "GET") {
        json(res, 200, providerPayload());
        log(method, path, 200);
        return true;
      }
      if (method !== "PUT") return methodMismatch(res, method, path, ctx);
      return await providerPut(req, res, url, ctx);
    }

    // --- POST /api/settings/provider/test -----------------------------------
    if (path === "/api/settings/provider/test") {
      if (method !== "POST") return methodMismatch(res, method, path, ctx);
      const body = await readOptionalBody(req, readJsonBody);
      const check = await runProviderCheck({ active: body?.active, custom: body?.custom });
      json(res, 200, { check });
      log(method, path, 200);
      return true;
    }

    // --- GET/PUT /api/settings/routing --------------------------------------
    if (path === "/api/settings/routing") {
      if (method === "GET") {
        json(res, 200, routingPayload());
        log(method, path, 200);
        return true;
      }
      if (method !== "PUT") return methodMismatch(res, method, path, ctx);
      let body;
      try {
        body = await readJsonBody(req, BODY_CAP);
      } catch (err) {
        log(method, path, respondBodyError(res, err));
        return true;
      }
      const { squad, lead } = body || {};
      const valid = new Set(routingPayload().rows.map((r) => r.squad));
      if (typeof squad !== "string" || !valid.has(squad)) {
        json(res, 400, { error: "unknown squad" });
        log(method, path, 400);
        return true;
      }
      if (lead !== null && (typeof lead !== "string" || lead.trim() === "" || lead.length > 200)) {
        json(res, 400, { error: "invalid lead" });
        log(method, path, 400);
        return true;
      }
      try {
        // null deletes the overlay entry (mergeInto semantics) — back to
        // models.json; a string sets routing.<squad>.lead.
        deps.writeSettings({ routing: { [squad]: lead === null ? null : { lead } } });
      } catch (err) {
        json(res, 400, { error: "invalid", errors: [String(err?.message || err)] });
        log(method, path, 400);
        return true;
      }
      json(res, 200, routingPayload());
      log(method, path, 200);
      return true;
    }

    // --- GET/POST /api/settings/repos ---------------------------------------
    if (path === "/api/settings/repos") {
      if (method === "GET") {
        const root = deps.reposRoot();
        const repos = await deps.listRepos({ root });
        json(res, 200, { root, repos, jobs: deps.listCloneJobs() });
        log(method, path, 200);
        return true;
      }
      if (method !== "POST") return methodMismatch(res, method, path, ctx);
      let body;
      try {
        body = await readJsonBody(req, BODY_CAP);
      } catch (err) {
        log(method, path, respondBodyError(res, err));
        return true;
      }
      const result = deps.startClone({
        url: body?.url,
        project: body?.project,
        root: deps.reposRoot(),
        allowLocal: process.env.FENIX_REPOS_ALLOW_LOCAL === "1",
      });
      if (result?.jobId) {
        json(res, 202, { jobId: result.jobId });
        log(method, path, 202);
      } else {
        json(res, 400, { error: String(result?.error || "clone refused") });
        log(method, path, 400);
      }
      return true;
    }

    // --- GET /api/settings/repos/jobs/:id -----------------------------------
    if ((m = /^\/api\/settings\/repos\/jobs\/([^/]+)$/.exec(path))) {
      if (method !== "GET") return methodMismatch(res, method, path, ctx);
      const job = deps.getCloneJob(decodePart(m[1]));
      if (!job) return notFound(res, method, path, ctx);
      json(res, 200, job);
      log(method, path, 200);
      return true;
    }

    // --- DELETE /api/settings/repos/:name/mapping ---------------------------
    if ((m = /^\/api\/settings\/repos\/([^/]+)\/mapping$/.exec(path))) {
      if (method !== "DELETE") return methodMismatch(res, method, path, ctx);
      const { removed } = deps.unmapRepo(decodePart(m[1]));
      json(res, 200, { removed });
      log(method, path, 200);
      return true;
    }

    // --- GET /api/settings/retention ----------------------------------------
    if (path === "/api/settings/retention") {
      if (method !== "GET") return methodMismatch(res, method, path, ctx);
      try {
        const payload = await deps.cachedRetention();
        json(res, 200, payload);
        log(method, path, 200);
      } catch (err) {
        json(res, 500, { error: String(err?.message || err).split("\n")[0] });
        log(method, path, 500);
      }
      return true;
    }

    // A /api/settings/* path with no route — the server's fall-through 404
    // would answer anyway; answer here so the settings log lines stay whole.
    json(res, 404, { error: "not found" });
    log(method, path, 404);
    return true;
  } catch (err) {
    json(res, 500, { error: String(err?.message || err).split("\n")[0] });
    log(method, path, 500);
    return true;
  }
}

/**
 * PUT /api/settings/provider — validate, live-check, only then write the
 * overlay. Settings are unchanged on any refusal.
 *
 * `key: { value }` is an OPTIONAL key candidate (the onboarding path: a new
 * provider cannot be selected without a valid stored key, so the form may
 * carry one). The candidate is validated against the NEW provider first, then
 * saved under its key file IN PLACE (openrouter_api_key for OpenRouter,
 * provider_api_key for the others) with the same safety helper as PUT /keys —
 * and only then does the overlay change. No response, log line or ledger
 * record ever carries the value.
 */
async function providerPut(req, res, url, ctx) {
  const { readJsonBody, respondBodyError, json, log } = ctx;
  const path = url.pathname;
  let body;
  try {
    body = await readJsonBody(req, BODY_CAP);
  } catch (err) {
    log(req.method, path, respondBodyError(res, err));
    return true;
  }
  const active = body?.active;
  const custom = body?.custom;
  const keyCandidate = body?.key;

  // Schema preview: the merged overlay must validate BEFORE anything runs.
  const current = readSettingsSafe();
  if (typeof active !== "string" || active.trim() === "") {
    json(res, 400, { error: "invalid", errors: ["provider.active: must be a provider name"] });
    log(req.method, path, 400);
    return true;
  }
  const builtin = (() => {
    try {
      return deps.loadProviders(modelsConfigPath()) || {};
    } catch {
      return {};
    }
  })();
  const merged = {
    ...current,
    provider: { ...(current?.provider || {}), active, ...(custom !== undefined ? { custom } : {}) },
  };
  const errors = [];
  if (active !== "custom" && !builtin[active]) {
    errors.push(`provider.active: unknown provider "${active}"`);
  }
  if (active === "custom" && !custom && !current?.provider?.custom) {
    errors.push("provider.custom: required when active is custom");
  }
  const { ok, errors: schemaErrors } = deps.validateSettings(merged);
  if (!ok) errors.push(...schemaErrors);
  if (errors.length) {
    json(res, 400, { error: "invalid", errors });
    log(req.method, path, 400);
    return true;
  }

  // A candidate key needs the secrets mount and a non-empty value.
  let candidate = null;
  if (keyCandidate !== undefined) {
    if (!secretsWritable()) {
      json(res, 503, { error: "secrets-not-writable" });
      log(req.method, path, 503);
      return true;
    }
    const value = typeof keyCandidate?.value === "string" ? keyCandidate.value.trim() : "";
    if (value === "") {
      json(res, 400, { error: "empty" });
      log(req.method, path, 400);
      return true;
    }
    candidate = value;
  }

  // Live test: the CANDIDATE against the NEW provider when one was given,
  // the STORED key otherwise (the custom block from the body when one is
  // being set, the overlay's otherwise).
  const check = candidate !== null
    ? await runProviderCheckWithKey({
        active,
        custom: active === "custom" ? custom || current?.provider?.custom || null : null,
        key: candidate,
      })
    : await runProviderCheck({
        active,
        custom: active === "custom" ? custom || current?.provider?.custom || null : null,
      });
  if (!check.ok) {
    json(res, 400, { error: "provider-check-failed", check });
    log(req.method, path, 400);
    return true;
  }

  // The settings rename is atomic; roll back the in-place secret write if
  // the overlay cannot be saved. Never switch only half of the provider.
  const target = candidate !== null ? providerKeyTarget(active) : null;
  const keyPath = target ? join(secretsDir(), target.file) : null;
  const hadFile = keyPath ? existsSync(keyPath) : false;
  const previousKey = hadFile ? readFileSync(keyPath, "utf8") : null;
  const patch = { provider: { active } };
  if (custom !== undefined) patch.provider.custom = custom;
  try {
    if (target) writeKeyFile(keyPath, candidate);
    deps.writeSettings(patch);
  } catch (err) {
    if (target) {
      if (hadFile) writeKeyFile(keyPath, previousKey);
      else if (existsSync(keyPath)) unlinkSync(keyPath);
    }
    json(res, 400, { error: "invalid", errors: [String(err?.message || err)] });
    log(req.method, path, 400);
    return true;
  }
  if (target) {
    for (const envName of target.envNames) process.env[envName] = candidate;
    saveLastCheck(target.file, check);
  }
  candidate = null;
  body = null;
  json(res, 200, { ...providerPayload(), check });
  log(req.method, path, 200);
  return true;
}

function methodMismatch(res, method, path, ctx) {
  ctx.json(res, 405, { error: "method not allowed" });
  ctx.log(method, path, 405);
  return true;
}

function notFound(res, method, path, ctx) {
  ctx.json(res, 404, { error: "not found" });
  ctx.log(method, path, 404);
  return true;
}
