// Contract test for scripts/provider-resolve.mjs — per-squad provider resolution.
//
// Uses temp fixture config/.env files (never the real .env, never real keys).
// Secret values are asserted to be ABSENT from --check output.

import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import {
  resolveProvider,
  formatSetLines,
  formatTierLines,
  parseEnvFile,
} from "./provider-resolve.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const RESOLVER_PATH = join(__dir, "provider-resolve.mjs");

const OPENROUTER_KEY = "sk-test-openrouter-123456";
const ZAI_KEY = "sk-test-zai-789012";

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (error) {
    failed++;
    failures.push(`${name}: ${error.message}`);
    console.log(`  FAIL ${name}: ${error.message}`);
  }
}

function assert(value, message) {
  if (!value) throw new Error(message || "assertion failed");
}

// --- fixtures --------------------------------------------------------------

const temp = mkdtempSync(join(tmpdir(), "provider-resolve-test-"));

function writeConfig(providers) {
  const path = join(temp, "models.json");
  writeFileSync(path, JSON.stringify({ providers }, null, 2), "utf8");
  return path;
}

// Settings overlay fixture (FOC-773). Content mirrors what fenix-settings.mjs
// would persist — the resolver reads it through readSettings.
function writeSettingsFile(content) {
  const path = join(temp, "settings-" + Math.random().toString(36).slice(2) + ".json");
  writeFileSync(path, JSON.stringify(content, null, 2), "utf8");
  return path;
}

const CUSTOM_SETTINGS = writeSettingsFile({
  provider: {
    active: "custom",
    custom: {
      baseUrl: "http://127.0.0.1:9000",
      authStyle: "apikey",
      keyName: "MY_CUSTOM_KEY",
      tiers: { opus: "custom-opus", sonnet: "custom-sonnet" },
      defaultModel: "custom-default",
    },
  },
  routing: {},
});

function writeEnv(lines) {
  const path = join(temp, "env-" + Math.random().toString(36).slice(2) + ".env");
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
  return path;
}

const CONFIG = writeConfig({
  openrouter: { baseUrl: "https://openrouter.ai/api", authEnv: "OPENROUTER_API_KEY", authStyle: "token" },
  anthropic: { baseUrl: "https://api.anthropic.com", authEnv: "ANTHROPIC_API_KEY", authStyle: "apikey" },
  zai_anthropic: {
    baseUrl: "https://api.z.ai/api/anthropic", authEnv: "ZAI_API_KEY", authStyle: "token",
    tiers: { opus: "glm-5.3", sonnet: "glm-5.2", haiku: "glm-5.2", smallFast: "glm-5.2" },
  },
});

const ENV_FULL = writeEnv([
  `OPENROUTER_API_KEY=${OPENROUTER_KEY}`,
  `ZAI_API_KEY=${ZAI_KEY}`,
  "# full-line comment is skipped",
]);

// --- direct resolution ------------------------------------------------------

test("defaults to openrouter when no provider is given", () => {
  const r = resolveProvider(undefined, { configPath: CONFIG, envPath: ENV_FULL, env: {} });
  assert(r.provider === "openrouter", `provider=${r.provider}`);
  assert(r.baseUrl === "https://openrouter.ai/api", `baseUrl=${r.baseUrl}`);
  assert(r.authVar === "ANTHROPIC_AUTH_TOKEN", `authVar=${r.authVar}`);
  assert(r.authEnv === "OPENROUTER_API_KEY", `authEnv=${r.authEnv}`);
  assert(r.present === true, "openrouter key must be present");
});

test("token authStyle maps to ANTHROPIC_AUTH_TOKEN (zai_anthropic)", () => {
  const r = resolveProvider("zai_anthropic", { configPath: CONFIG, envPath: ENV_FULL, env: {} });
  assert(r.authVar === "ANTHROPIC_AUTH_TOKEN", `authVar=${r.authVar}`);
  assert(r.authEnv === "ZAI_API_KEY", `authEnv=${r.authEnv}`);
  assert(r.authValue === ZAI_KEY, "auth value must come from .env");
});

test("apikey authStyle maps to ANTHROPIC_API_KEY (anthropic)", () => {
  const r = resolveProvider("anthropic", { configPath: CONFIG, envPath: ENV_FULL, env: {} });
  assert(r.authVar === "ANTHROPIC_API_KEY", `authVar=${r.authVar}`);
  assert(r.authEnv === "ANTHROPIC_API_KEY", `authEnv=${r.authEnv}`);
});

test("formatSetLines emits base URL, active auth var, cleared inactive var, and LA_PROVIDER", () => {
  const r = resolveProvider("openrouter", { configPath: CONFIG, envPath: ENV_FULL, env: {} });
  const lines = formatSetLines(r);
  assert(lines.some((l) => l === `set "ANTHROPIC_BASE_URL=https://openrouter.ai/api"`), "base URL line missing");
  assert(lines.some((l) => l === `set "ANTHROPIC_AUTH_TOKEN=${OPENROUTER_KEY}"`), "active auth var line missing");
  assert(lines.some((l) => l === `set "ANTHROPIC_API_KEY="`), "inactive auth var must be cleared");
  assert(lines.some((l) => l === `set "LA_PROVIDER=openrouter"`), "LA_PROVIDER line missing");
});

test("unknown provider throws and lists valid names", () => {
  let threw = null;
  try {
    resolveProvider("bogus", { configPath: CONFIG, envPath: ENV_FULL, env: {} });
  } catch (err) {
    threw = err;
  }
  assert(threw != null, "unknown provider must throw");
  assert(/bogus/.test(threw.message), `message=${threw.message} must name the provider`);
  assert(/openrouter, anthropic, zai_anthropic/.test(threw.message), `message=${threw.message} must list valid names`);
});

test("missing authEnv yields present=false and names provider + env var", () => {
  const envMissing = writeEnv([`OPENROUTER_API_KEY=${OPENROUTER_KEY}`]); // no ZAI_API_KEY
  const r = resolveProvider("zai_anthropic", { configPath: CONFIG, envPath: envMissing, env: {} });
  assert(r.present === false, "present must be false when authEnv is missing");
});

test("parseEnvFile skips comments and blank lines", () => {
  const envPath = writeEnv([
    "FIRST=one",
    "",
    "# comment",
    "SECOND=two",
  ]);
  const parsed = parseEnvFile(envPath);
  assert(parsed.FIRST === "one", `FIRST=${parsed.FIRST}`);
  assert(parsed.SECOND === "two", `SECOND=${parsed.SECOND}`);
  assert(parsed["# comment"] === undefined, "comment line must be skipped");
});

// --- CLI: exit codes + --check output --------------------------------------

// Minimal, deterministic environment: inherit the real env for node to run,
// then scrub the auth keys and provider overrides so the resolver reads only
// the fixture .env.
function scrubEnv() {
  const env = { ...process.env };
  for (const key of ["OPENROUTER_API_KEY", "ZAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "PROVIDER_API_KEY", "LA_PROVIDER", "LA_PROVIDER_CONFIG", "LA_PROVIDER_ENV_FILE", "LA_SETTINGS_FILE"]) {
    delete env[key];
  }
  return env;
}

function runResolver(args, env) {
  return execFileSync(process.execPath, [RESOLVER_PATH, ...args], {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("--check exits 0 and prints resolution without secrets", () => {
  const env = scrubEnv();
  env.LA_PROVIDER_CONFIG = CONFIG;
  env.LA_PROVIDER_ENV_FILE = ENV_FULL;
  const out = runResolver(["zai_anthropic", "--check"], env);
  assert(out.includes("provider=zai_anthropic"), `missing provider in:\n${out}`);
  assert(out.includes("baseUrl=https://api.z.ai/api/anthropic"), `missing baseUrl in:\n${out}`);
  assert(out.includes("authVar=ANTHROPIC_AUTH_TOKEN"), `missing authVar in:\n${out}`);
  assert(out.includes("authPresent=set"), `missing authPresent in:\n${out}`);
  assert(!out.includes(ZAI_KEY), "--check must not print the secret value");
  assert(!out.includes(OPENROUTER_KEY), "--check must not print the openrouter key");
});

test("--check exits 1 with a named error when the auth key is missing", () => {
  const envMissing = writeEnv([`OPENROUTER_API_KEY=${OPENROUTER_KEY}`]);
  const env = scrubEnv();
  env.LA_PROVIDER_CONFIG = CONFIG;
  env.LA_PROVIDER_ENV_FILE = envMissing;
  let code = 0;
  let stderr = "";
  try {
    runResolver(["zai_anthropic", "--check"], env);
  } catch (err) {
    code = err.status;
    stderr = String(err.stderr);
  }
  assert(code === 1, `exit code=${code} (expected 1)`);
  assert(/zai_anthropic/.test(stderr), `stderr must name the provider:\n${stderr}`);
  assert(/ZAI_API_KEY/.test(stderr), `stderr must name the missing env var:\n${stderr}`);
});

test("unknown provider exits 1 with a named error", () => {
  const env = scrubEnv();
  env.LA_PROVIDER_CONFIG = CONFIG;
  env.LA_PROVIDER_ENV_FILE = ENV_FULL;
  let code = 0;
  let stderr = "";
  try {
    runResolver(["bogus", "--check"], env);
  } catch (err) {
    code = err.status;
    stderr = String(err.stderr);
  }
  assert(code === 1, `exit code=${code} (expected 1)`);
  assert(/bogus/.test(stderr), `stderr must name the provider:\n${stderr}`);
  assert(/openrouter, anthropic, zai_anthropic/.test(stderr), `stderr must list valid names:\n${stderr}`);
});

test("set lines carry the secret (consumed) but --check does not", () => {
  const env = scrubEnv();
  env.LA_PROVIDER_CONFIG = CONFIG;
  env.LA_PROVIDER_ENV_FILE = ENV_FULL;
  const out = runResolver(["openrouter"], env);
  assert(out.includes(`set "ANTHROPIC_AUTH_TOKEN=${OPENROUTER_KEY}"`), "set lines must carry the resolved key");
  assert(out.includes('set "LA_PROVIDER=openrouter"'), "set lines must include LA_PROVIDER");
});

// --- provider-scoped model tiers -------------------------------------------

test("tiers travel with the provider so switching it switches the classifier model", () => {
  const withTiers = resolveProvider("zai_anthropic", { configPath: CONFIG, envPath: ENV_FULL, env: {} });
  const lines = formatSetLines(withTiers);
  assert(lines.some((l) => l === `set "ANTHROPIC_DEFAULT_OPUS_MODEL=glm-5.3"`), "opus tier line missing");
  // The sonnet tier is what Claude Code's auto-mode permission classifier uses;
  // pointing it at a model the active provider does not host breaks every call.
  assert(lines.some((l) => l === `set "ANTHROPIC_DEFAULT_SONNET_MODEL=glm-5.2"`), "sonnet tier line missing");
  assert(lines.some((l) => l === `set "ANTHROPIC_DEFAULT_HAIKU_MODEL=glm-5.2"`), "haiku tier line missing");
  assert(lines.some((l) => l === `set "ANTHROPIC_SMALL_FAST_MODEL=glm-5.2"`), "small-fast tier line missing");

  const other = resolveProvider("openrouter", { configPath: CONFIG, envPath: ENV_FULL, env: {} });
  assert(
    !formatSetLines(other).some((l) => l.includes("glm-5.2")),
    "another provider must not inherit these tier models",
  );
});

test("a provider without tiers emits no tier lines (launcher keeps its own)", () => {
  const r = resolveProvider("openrouter", { configPath: CONFIG, envPath: ENV_FULL, env: {} });
  assert(formatTierLines(r).length === 0, "no tiers configured must emit nothing, not empty assignments");
  assert(
    !formatSetLines(r).some((l) => l.startsWith('set "ANTHROPIC_DEFAULT_')),
    "set lines must not clear tier vars a launcher set itself",
  );
});

test("--check reports every tier so a misrouted classifier is visible before launch", () => {
  const out = runResolver(["zai_anthropic", "--check"], { ZAI_API_KEY: ZAI_KEY });
  assert(/ANTHROPIC_DEFAULT_SONNET_MODEL=glm-5\.2/.test(out), `--check must show the sonnet tier: ${out}`);
  assert(!out.includes(ZAI_KEY), "--check must not print the key");
});

// --- FOC-164: baseUrl env override ----------------------------------------

test("LA_PROVIDER_BASEURL_<PROVIDER> overrides config baseUrl", () => {
  const r = resolveProvider("openrouter", {
    configPath: CONFIG,
    envPath: ENV_FULL,
    env: { LA_PROVIDER_BASEURL_OPENROUTER: "http://localhost:8899" },
  });
  assert(r.baseUrl === "http://localhost:8899", `baseUrl=${r.baseUrl} (expected override)`);
  assert(r.baseUrlSource === "env", `baseUrlSource=${r.baseUrlSource}`);
});

test("baseUrl falls back to config when env override is unset", () => {
  const r = resolveProvider("openrouter", { configPath: CONFIG, envPath: ENV_FULL, env: {} });
  assert(r.baseUrl === "https://openrouter.ai/api", `baseUrl=${r.baseUrl}`);
  assert(r.baseUrlSource === "config", `baseUrlSource=${r.baseUrlSource}`);
});

test("baseUrl env override normalizes non-alphanumeric provider name (zai_anthropic)", () => {
  const r = resolveProvider("zai_anthropic", {
    configPath: CONFIG,
    envPath: ENV_FULL,
    env: { LA_PROVIDER_BASEURL_ZAI_ANTHROPIC: "http://localhost:7777" },
  });
  assert(r.baseUrl === "http://localhost:7777", `baseUrl=${r.baseUrl} (expected override for zai_anthropic)`);
  assert(r.baseUrlSource === "env", `baseUrlSource=${r.baseUrlSource}`);
});

// --- FOC-773: settings overlay drives provider selection --------------------

test("settings.provider.active selects the provider when no arg and no env", () => {
  const settingsPath = writeSettingsFile({ provider: { active: "zai_anthropic", custom: null }, routing: {} });
  const r = resolveProvider(undefined, { configPath: CONFIG, envPath: ENV_FULL, env: {}, settingsPath });
  assert(r.provider === "zai_anthropic", `provider=${r.provider}`);
  assert(r.providerSource === "settings", `providerSource=${r.providerSource}`);
  assert(r.authEnv === "ZAI_API_KEY", `authEnv=${r.authEnv}`);
});

test("settings without provider.active falls back to openrouter (providerSource=default)", () => {
  const settingsPath = writeSettingsFile({ provider: { active: null, custom: null }, routing: {} });
  const r = resolveProvider(undefined, { configPath: CONFIG, envPath: ENV_FULL, env: {}, settingsPath });
  assert(r.provider === "openrouter", `provider=${r.provider}`);
  assert(r.providerSource === "default", `providerSource=${r.providerSource}`);
});

test("env.LA_PROVIDER beats settings.provider.active", () => {
  const settingsPath = writeSettingsFile({ provider: { active: "zai_anthropic", custom: null }, routing: {} });
  const r = resolveProvider(undefined, { configPath: CONFIG, envPath: ENV_FULL, env: { LA_PROVIDER: "anthropic" }, settingsPath });
  assert(r.provider === "anthropic", `provider=${r.provider}`);
  assert(r.providerSource === "env", `providerSource=${r.providerSource}`);
});

test("explicit arg beats env and settings", () => {
  const settingsPath = writeSettingsFile({ provider: { active: "zai_anthropic", custom: null }, routing: {} });
  const r = resolveProvider("anthropic", { configPath: CONFIG, envPath: ENV_FULL, env: { LA_PROVIDER: "openrouter" }, settingsPath });
  assert(r.provider === "anthropic", `provider=${r.provider}`);
  assert(r.providerSource === "arg", `providerSource=${r.providerSource}`);
});

test("custom provider resolves entirely from settings.provider.custom", () => {
  const r = resolveProvider(undefined, {
    configPath: CONFIG,
    envPath: ENV_FULL,
    env: { MY_CUSTOM_KEY: "sk-custom-123" },
    settingsPath: CUSTOM_SETTINGS,
  });
  assert(r.provider === "custom", `provider=${r.provider}`);
  assert(r.providerSource === "settings", `providerSource=${r.providerSource}`);
  assert(r.baseUrl === "http://127.0.0.1:9000", `baseUrl=${r.baseUrl}`);
  assert(r.authEnv === "MY_CUSTOM_KEY", `authEnv=${r.authEnv}`);
  assert(r.authVar === "ANTHROPIC_API_KEY", `apikey style must map to ANTHROPIC_API_KEY, got ${r.authVar}`);
  assert(r.authValue === "sk-custom-123", "custom key must come from its own env var");
  assert(r.authSource === "env", `authSource=${r.authSource}`);
  assert(r.tiers.opus === "custom-opus", `tiers.opus=${r.tiers.opus}`);
  assert(r.defaultModel === "custom-default", `defaultModel=${r.defaultModel}`);

  const lines = formatSetLines(r);
  assert(lines.some((l) => l === `set "LA_PROVIDER_DEFAULT_MODEL=custom-default"`), "default model line missing");
  assert(lines.some((l) => l === `set "ANTHROPIC_DEFAULT_OPUS_MODEL=custom-opus"`), "custom opus tier line missing");
  assert(lines.some((l) => l === `set "ANTHROPIC_DEFAULT_SONNET_MODEL=custom-sonnet"`), "custom sonnet tier line missing");
});

test("custom without keyName falls back to PROVIDER_API_KEY as its authEnv", () => {
  const settingsPath = writeSettingsFile({
    provider: { active: "custom", custom: { baseUrl: "http://127.0.0.1:9000", authStyle: "token", tiers: {} } },
    routing: {},
  });
  const r = resolveProvider(undefined, {
    configPath: CONFIG,
    envPath: ENV_FULL,
    env: { PROVIDER_API_KEY: "sk-generic-123" },
    settingsPath,
  });
  assert(r.authEnv === "PROVIDER_API_KEY", `authEnv=${r.authEnv}`);
  assert(r.authValue === "sk-generic-123", "generic secret must be picked up as the custom key");
  assert(r.authSource === "env", `authSource=${r.authSource}`);
});

test("custom selected but settings has no provider.custom → named error", () => {
  const settingsPath = writeSettingsFile({ provider: { active: "custom", custom: null }, routing: {} });
  let threw = null;
  try {
    resolveProvider(undefined, { configPath: CONFIG, envPath: ENV_FULL, env: {}, settingsPath });
  } catch (err) {
    threw = err;
  }
  assert(threw != null, "missing provider.custom must throw");
  assert(
    threw.message.includes("provider 'custom' selected but settings.json has no provider.custom"),
    `message=${threw.message}`,
  );
});

test("generic PROVIDER_API_KEY is used when the provider's authEnv is missing (authSource=generic)", () => {
  const envMissing = writeEnv([`OPENROUTER_API_KEY=${OPENROUTER_KEY}`]); // no ZAI_API_KEY anywhere
  const r = resolveProvider("zai_anthropic", {
    configPath: CONFIG,
    envPath: envMissing,
    env: { PROVIDER_API_KEY: "sk-generic-canary" },
  });
  assert(r.present === true, "generic secret must satisfy the auth requirement");
  assert(r.authSource === "generic", `authSource=${r.authSource}`);
  assert(r.authValue === "sk-generic-canary", "the generic secret must become the auth value");
});

test("authSource=envfile when the key lives only in .env", () => {
  const r = resolveProvider("zai_anthropic", { configPath: CONFIG, envPath: ENV_FULL, env: {} });
  assert(r.authSource === "envfile", `authSource=${r.authSource}`);
});

test("invalid settings JSON → named error, never a silent default", () => {
  const badPath = join(temp, "settings-broken.json");
  writeFileSync(badPath, "{ not json", "utf8");
  let threw = null;
  try {
    resolveProvider(undefined, { configPath: CONFIG, envPath: ENV_FULL, env: {}, settingsPath: badPath });
  } catch (err) {
    threw = err;
  }
  assert(threw != null, "invalid settings must throw");
  assert(/not valid JSON/.test(threw.message), `message=${threw.message}`);
  assert(threw.message.includes(badPath), `message=${threw.message} must name the path`);
});

test("a built-in provider entry with defaultModel emits LA_PROVIDER_DEFAULT_MODEL", () => {
  const path = join(temp, "models-default.json");
  writeFileSync(path, JSON.stringify({
    providers: {
      openrouter: {
        baseUrl: "https://openrouter.ai/api",
        authEnv: "OPENROUTER_API_KEY",
        authStyle: "token",
        defaultModel: "xiaomi/mimo-v2.6-pro",
      },
    },
  }, null, 2), "utf8");
  const r = resolveProvider("openrouter", { configPath: path, envPath: ENV_FULL, env: {} });
  assert(r.defaultModel === "xiaomi/mimo-v2.6-pro", `defaultModel=${r.defaultModel}`);
  assert(
    formatSetLines(r).some((l) => l === `set "LA_PROVIDER_DEFAULT_MODEL=xiaomi/mimo-v2.6-pro"`),
    "default model set line missing",
  );

  // Entries without defaultModel emit nothing — launchers keep their own.
  const other = resolveProvider("openrouter", { configPath: CONFIG, envPath: ENV_FULL, env: {} });
  assert(
    !formatSetLines(other).some((l) => l.includes("LA_PROVIDER_DEFAULT_MODEL")),
    "no defaultModel configured must emit no line",
  );
});

test("--check output (stdout and stderr) never contains the key value", () => {
  const CANARY = "sk-or-canary-abcdef0123456789";
  const env = scrubEnv();
  env.LA_PROVIDER_CONFIG = CONFIG;
  env.LA_PROVIDER_ENV_FILE = ENV_FULL;
  env.LA_SETTINGS_FILE = writeSettingsFile({
    provider: { active: "custom", custom: { baseUrl: "http://127.0.0.1:9000", authStyle: "token", tiers: {} } },
    routing: {},
  });
  env.PROVIDER_API_KEY = CANARY;
  const result = spawnSync(process.execPath, [RESOLVER_PATH, "--check"], { encoding: "utf8", env });
  assert(result.status === 0, `exit=${result.status}, stderr=${result.stderr}`);
  const combined = `${result.stdout || ""}${result.stderr || ""}`;
  assert(!combined.includes(CANARY), "--check must never print the key value");
  assert(combined.includes("authSource=env"), `expected authSource=env in:\n${combined}`);
  assert(combined.includes("providerSource=settings"), `expected providerSource=settings in:\n${combined}`);
});

// A long-lived Supervisor must not pin a launcher-derived provider/key.
test("a settings change reaches the next resolution with the launcher's inherited env", () => {
  const settingsPath = writeSettingsFile({ provider: { active: "openrouter" }, routing: {} });
  const options = { configPath: CONFIG, envPath: ENV_FULL, env: {}, settingsPath };
  const initial = resolveProvider(undefined, options);
  const inherited = {};
  for (const line of formatSetLines(initial)) {
    const match = /^set "([^=]+)=(.*)"$/.exec(line);
    if (match) inherited[match[1]] = match[2];
  }
  writeFileSync(settingsPath, JSON.stringify({ provider: { active: "zai_anthropic" }, routing: {} }));
  const next = resolveProvider(undefined, { ...options, env: inherited });
  assert(next.provider === "zai_anthropic", "derived LA_PROVIDER must not hide changed Settings");
  assert(next.providerSource === "settings", "must preserve the actual source");
  const explicit = resolveProvider(undefined, { ...options, env: { ...inherited, LA_PROVIDER: "anthropic" } });
  assert(explicit.provider === "anthropic", "an explicit changed env override still wins");
  const pinned = resolveProvider("openrouter", { ...options, env: inherited });
  assert(pinned.provider === "openrouter", "a resumed child's explicit provider stays pinned");
});

test("mounted key rotation is fresh despite stale process and env-file values", () => {
  const dir = mkdtempSync(join(temp, "secrets-"));
  const secret = join(dir, "openrouter_api_key");
  const options = { configPath: CONFIG, envPath: ENV_FULL, env: { LA_SECRETS_DIR: dir, OPENROUTER_API_KEY: "old-parent-key" } };
  writeFileSync(secret, "first-mounted-key");
  assert(resolveProvider("openrouter", options).authValue === "first-mounted-key", "mounted key must win");
  writeFileSync(secret, "rotated-mounted-key");
  const rotated = resolveProvider("openrouter", options);
  assert(rotated.authValue === "rotated-mounted-key", "must re-read the file without restart");
  assert(rotated.authSource === "secret", "source must identify the mounted secret");
  writeFileSync(secret, "");
  assert(!resolveProvider("openrouter", options).present, "empty mounted secret must not revive stale env");
});

test("custom providers read the generic mounted key instead of stale inherited auth", () => {
  const dir = mkdtempSync(join(temp, "generic-secrets-"));
  writeFileSync(join(dir, "provider_api_key"), "fresh-generic-key");
  const r = resolveProvider("custom", { configPath: CONFIG, envPath: ENV_FULL, settingsPath: CUSTOM_SETTINGS, env: { LA_SECRETS_DIR: dir, MY_CUSTOM_KEY: "stale-custom-key" } });
  assert(r.authValue === "fresh-generic-key", "generic mounted key must be fresh");
});

// --- teardown --------------------------------------------------------------

rmSync(temp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) console.log(failures.join("\n"));
process.exit(failed ? 1 : 0);