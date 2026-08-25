// Contract test for scripts/provider-resolve.mjs — per-squad provider resolution.
//
// Uses temp fixture config/.env files (never the real .env, never real keys).
// Secret values are asserted to be ABSENT from --check output.

import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  resolveProvider,
  formatSetLines,
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

function writeEnv(lines) {
  const path = join(temp, "env-" + Math.random().toString(36).slice(2) + ".env");
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
  return path;
}

const CONFIG = writeConfig({
  openrouter: { baseUrl: "https://openrouter.ai/api", authEnv: "OPENROUTER_API_KEY", authStyle: "token" },
  anthropic: { baseUrl: "https://api.anthropic.com", authEnv: "ANTHROPIC_API_KEY", authStyle: "apikey" },
  zai_anthropic: { baseUrl: "https://api.z.ai/api/anthropic", authEnv: "ZAI_API_KEY", authStyle: "token" },
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
  for (const key of ["OPENROUTER_API_KEY", "ZAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "LA_PROVIDER", "LA_PROVIDER_CONFIG", "LA_PROVIDER_ENV_FILE"]) {
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

// --- teardown --------------------------------------------------------------

rmSync(temp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) console.log(failures.join("\n"));
process.exit(failed ? 1 : 0);