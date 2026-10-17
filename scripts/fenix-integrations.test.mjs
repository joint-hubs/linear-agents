// scripts/fenix-integrations.test.mjs — FOC-772: the optional-integrations
// switch. Pins: the three overlay flags default to false and come only from
// the overlay, `nebul` is derived from the resolved active provider (env
// override and settings precedence included, and false — never thrown — when
// the provider config is missing/unknown), invalid overlays throw a
// validation error on the write-time read (readIntegrations) but fail closed
// to off on the hot-path read (readIntegrationsSafe, one warn per distinct
// message), the per-request memo (cachedIntegrations, path+mtime key),
// prerequisites per name, and the CLI exit codes over a temp settings file
// via LA_SETTINGS_FILE.
//
// Run: node scripts/test-run.mjs fenix-integrations
//      (also: node --test scripts/fenix-integrations.test.mjs)
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  INTEGRATIONS,
  cachedIntegrations,
  integrationEnabled,
  prerequisites,
  readIntegrations,
  readIntegrationsSafe,
  resetIntegrationsCache,
} from "./fenix-integrations.mjs";

const execFileP = promisify(execFile);
const CLI = fileURLToPath(new URL("./fenix-integrations.mjs", import.meta.url));
const MODELS_CONFIG = fileURLToPath(new URL("../config/models.json", import.meta.url));

function tempDir() {
  return mkdtempSync(join(tmpdir(), "foc-772-"));
}

function settingsFile(dir) {
  return join(dir, "settings.json");
}

// Empty strings read as "missing" everywhere (nonEmpty semantics), so the
// machine's real integrations env and LA_PROVIDER cannot leak into a case.
// The provider config/.env are pinned to repo/no-such paths so the nebul
// derivation never depends on a real .env.
const CLEAN = {
  LA_PROVIDER: "",
  LA_PROVIDER_RESOLVED: "",
  LA_PROVIDER_SOURCE: "",
  ATLAS_ROOT: "",
  ATLAS_VENV_PYTHON: "",
  LINEAR_API_KEY_PISI: "",
  NEBUL_API_KEY: "",
  LA_PROVIDER_CONFIG: MODELS_CONFIG,
  LA_PROVIDER_ENV_FILE: join(tmpdir(), "foc-772-no-such.env"),
};

function envWith(extra) {
  return { ...CLEAN, ...extra };
}

test("defaults: no overlay key → all four off, source default", () => {
  assert.deepEqual(readIntegrations({ settings: {}, env: envWith() }), {
    atlas: false,
    pisi: false,
    memory: false,
    nebul: false,
    source: "default",
  });
});

test("overlay flags on → source overlay; the unset flag stays off", () => {
  const r = readIntegrations({ settings: { integrations: { atlas: true, memory: true } }, env: envWith() });
  assert.equal(r.atlas, true);
  assert.equal(r.memory, true);
  assert.equal(r.pisi, false);
  assert.equal(r.nebul, false);
  assert.equal(r.source, "overlay");
});

test("nebul derives from settings.provider.active", () => {
  assert.equal(readIntegrations({ settings: { provider: { active: "nebul" } }, env: envWith() }).nebul, true);
  assert.equal(readIntegrations({ settings: { provider: { active: "openrouter" } }, env: envWith() }).nebul, false);
});

test("nebul derives from LA_PROVIDER", () => {
  assert.equal(readIntegrations({ settings: {}, env: envWith({ LA_PROVIDER: "nebul" }) }).nebul, true);
});

test("a derived LA_PROVIDER (LA_PROVIDER_RESOLVED) does not override the overlay", () => {
  const env = envWith({
    LA_PROVIDER: "nebul",
    LA_PROVIDER_RESOLVED: "nebul",
    LA_PROVIDER_SOURCE: "settings",
  });
  assert.equal(readIntegrations({ settings: { provider: { active: "openrouter" } }, env }).nebul, false);
});

test("unknown provider config → nebul false, never thrown", () => {
  const r = readIntegrations({ settings: { provider: { active: "nosuchprovider" } }, env: envWith() });
  assert.equal(r.nebul, false);
  assert.equal(r.source, "default");
});

test("custom provider resolves but never yields nebul", () => {
  const dir = tempDir();
  try {
    // resolveProvider re-reads the overlay only for "custom" — point it at a
    // temp copy of the same settings so nothing real is consulted.
    const settings = {
      provider: {
        active: "custom",
        custom: {
          baseUrl: "http://127.0.0.1:8000/v1",
          authStyle: "token",
          keyName: "MY_KEY",
          tiers: { opus: "m" },
          defaultModel: "m",
        },
      },
    };
    const path = settingsFile(dir);
    writeFileSync(path, JSON.stringify(settings), "utf8");
    const r = readIntegrations({ settings, env: envWith({ LA_SETTINGS_FILE: path }) });
    assert.equal(r.nebul, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid overlay → a validation error, same contract as writeSettings", () => {
  assert.throws(
    () => readIntegrations({ settings: { integrations: { atlas: true, bogus: true } }, env: envWith() }),
    (err) => err.message.includes("validation failed") && err.message.includes("integrations.bogus"),
  );
  assert.throws(
    () => readIntegrations({ settings: { integrations: { atlas: "yes" } }, env: envWith() }),
    (err) => err.message.includes("integrations.atlas: must be a boolean"),
  );
  assert.throws(
    () => readIntegrations({ settings: { sneaky: true }, env: envWith() }),
    (err) => err.message.includes("sneaky") && err.message.includes("unknown top-level key"),
  );
});

// --- the fail-closed read (hot paths) and the per-request memo --------------

test("readIntegrationsSafe: corrupt overlay → all off, source invalid, warns once per message", () => {
  const warns = [];
  const warn = (message) => warns.push(message);
  const settings = { integrations: { atlas: "yes" } };
  const first = readIntegrationsSafe({ settings, env: envWith(), warn });
  assert.deepEqual(
    { atlas: first.atlas, pisi: first.pisi, memory: first.memory, nebul: first.nebul },
    { atlas: false, pisi: false, memory: false, nebul: false },
  );
  assert.equal(first.source, "invalid");
  assert.ok(first.error.includes("integrations.atlas: must be a boolean"), first.error);
  // Second call with the same corruption: same result, no second warn.
  const second = readIntegrationsSafe({ settings, env: envWith(), warn });
  assert.equal(second.source, "invalid");
  assert.equal(warns.length, 1);
  assert.ok(warns[0].includes("[warn] settings invalid — integrations treated as off"), warns[0]);
  assert.ok(warns[0].includes("must be a boolean"), warns[0]);
});

test("readIntegrationsSafe: a distinct error message warns again (per-message dedup)", () => {
  const warns = [];
  const warn = (message) => warns.push(message);
  readIntegrationsSafe({ settings: { sneakySafeReadA: true }, env: envWith(), warn });
  readIntegrationsSafe({ settings: { sneakySafeReadB: true }, env: envWith(), warn });
  assert.equal(warns.length, 2);
});

test("integrationEnabled: corrupt overlay reads false (safe reader), never throws", () => {
  const warns = [];
  assert.equal(integrationEnabled("pisi", { settings: { integrations: { pisi: "yes" } }, env: envWith(), warn: (m) => warns.push(m) }), false);
  assert.equal(warns.length, 1);
});

test("cachedIntegrations: two calls within the TTL read the file once; an mtime bump invalidates", () => {
  resetIntegrationsCache();
  const dir = tempDir();
  try {
    const path = settingsFile(dir);
    writeFileSync(path, JSON.stringify({ integrations: { atlas: true } }), "utf8");
    let reads = 0;
    const readSettingsImpl = () => {
      reads += 1;
      return { integrations: { atlas: true } };
    };
    const env = envWith({ LA_SETTINGS_FILE: path });
    assert.equal(cachedIntegrations({ env, readSettingsImpl }).atlas, true);
    assert.equal(cachedIntegrations({ env, readSettingsImpl }).atlas, true);
    assert.equal(reads, 1, "second call within the TTL is served from the memo");
    // A settings write bumps the mtime → next read re-validates.
    utimesSync(path, new Date(), new Date(Date.now() + 1000));
    assert.equal(cachedIntegrations({ env, readSettingsImpl }).atlas, true);
    assert.equal(reads, 2, "changed mtime invalidates the memo");
  } finally {
    resetIntegrationsCache();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integrationEnabled without an injected settings object goes through the memo", () => {
  resetIntegrationsCache();
  const dir = tempDir();
  try {
    const path = settingsFile(dir);
    writeFileSync(path, JSON.stringify({ integrations: { memory: true } }), "utf8");
    let reads = 0;
    const readSettingsImpl = () => {
      reads += 1;
      return { integrations: { memory: true } };
    };
    const env = envWith({ LA_SETTINGS_FILE: path });
    assert.equal(integrationEnabled("memory", { env, readSettingsImpl }), true);
    assert.equal(integrationEnabled("memory", { env, readSettingsImpl }), true);
    assert.equal(reads, 1, "the overlay is read once across both calls");
    // An injected settings object bypasses the memo entirely.
    assert.equal(integrationEnabled("memory", { settings: { integrations: { memory: false } }, env }), false);
    assert.equal(reads, 1);
  } finally {
    resetIntegrationsCache();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prerequisites: atlas, pisi, memory, nebul", () => {
  const atlas = prerequisites("atlas", envWith());
  assert.equal(atlas.ok, false);
  assert.deepEqual(atlas.missing, ["ATLAS_ROOT", "ATLAS_VENV_PYTHON"]);
  assert.ok(
    prerequisites("atlas", envWith({ ATLAS_ROOT: "/a", ATLAS_VENV_PYTHON: "python" })).ok,
  );

  assert.deepEqual(prerequisites("pisi", envWith()), { ok: false, missing: ["LINEAR_API_KEY_PISI"], required: ["LINEAR_API_KEY_PISI"] });
  assert.ok(prerequisites("pisi", envWith({ LINEAR_API_KEY_PISI: "lin_api_x" })).ok);

  assert.deepEqual(prerequisites("memory", envWith()), { ok: true, missing: [], required: [] });

  const nebulMissing = prerequisites("nebul", envWith());
  assert.equal(nebulMissing.ok, false);
  assert.deepEqual(nebulMissing.missing, ["NEBUL_API_KEY"]);
  assert.ok(prerequisites("nebul", envWith({ NEBUL_API_KEY: "n" })).ok);
});

test("prerequisites: unknown name → TypeError", () => {
  assert.throws(() => prerequisites("bogus", envWith()), TypeError);
});

test("INTEGRATIONS: the four names, in reporting order", () => {
  assert.deepEqual(INTEGRATIONS, ["atlas", "pisi", "memory", "nebul"]);
});

test("integrationEnabled: overlay flag on/off; unknown name → TypeError", () => {
  const opts = { settings: { integrations: { atlas: true } }, env: envWith() };
  assert.equal(integrationEnabled("atlas", opts), true);
  assert.equal(integrationEnabled("pisi", opts), false);
  assert.equal(integrationEnabled("nebul", opts), false);
  assert.throws(
    () => integrationEnabled("bogus", opts),
    (err) => err instanceof TypeError && err.message.includes("unknown integration: bogus"),
  );
});

// --- CLI: `show [--json]` and `enabled <name>` ------------------------------

function runCli(args, extraEnv = {}) {
  return execFileP(process.execPath, [CLI, ...args], {
    env: { ...process.env, ...CLEAN, ...extraEnv },
    windowsHide: true,
  });
}

test("CLI show: prints the four flags + source + the enabled one's prerequisites", async () => {
  const dir = tempDir();
  try {
    const path = settingsFile(dir);
    writeFileSync(path, JSON.stringify({ integrations: { atlas: true } }), "utf8");
    const { stdout } = await runCli(["show"], { LA_SETTINGS_FILE: path });
    const lines = stdout.trim().split("\n");
    assert.deepEqual(lines.slice(0, 5), ["atlas=on", "pisi=off", "memory=off", "nebul=off", "source=overlay"]);
    assert.deepEqual(lines.slice(5), ["atlas: missing ATLAS_ROOT, ATLAS_VENV_PYTHON"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI show --json: parses; prerequisites carry ok/missing", async () => {
  const dir = tempDir();
  try {
    const path = settingsFile(dir);
    writeFileSync(path, JSON.stringify({ integrations: { pisi: true } }), "utf8");
    const { stdout } = await runCli(["show", "--json"], {
      LA_SETTINGS_FILE: path,
      LINEAR_API_KEY_PISI: "lin_api_x",
    });
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.atlas, false);
    assert.equal(parsed.pisi, true);
    assert.equal(parsed.nebul, false);
    assert.equal(parsed.source, "overlay");
    assert.deepEqual(parsed.prerequisites.pisi, { ok: true, missing: [] });
    assert.deepEqual(parsed.prerequisites.atlas.missing, ["ATLAS_ROOT", "ATLAS_VENV_PYTHON"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI show: an invalid settings file → stderr, exit 1", async () => {
  const dir = tempDir();
  try {
    const path = settingsFile(dir);
    writeFileSync(path, "{ not json", "utf8");
    await assert.rejects(runCli(["show"], { LA_SETTINGS_FILE: path }), (err) => {
      assert.equal(err.code, 1);
      assert.ok(err.stderr.includes("not valid JSON"));
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI enabled: exit 0 when on, 1 when off, 2 on an unknown name", async () => {
  const dir = tempDir();
  try {
    const path = settingsFile(dir);
    writeFileSync(path, JSON.stringify({ integrations: { atlas: true } }), "utf8");
    const on = await runCli(["enabled", "atlas"], { LA_SETTINGS_FILE: path });
    assert.equal(on.stdout, "atlas: enabled\n");
    await assert.rejects(runCli(["enabled", "pisi"], { LA_SETTINGS_FILE: path }), (err) => {
      assert.equal(err.code, 1);
      assert.ok(err.stdout.includes("pisi: disabled"));
      return true;
    });
    await assert.rejects(runCli(["enabled", "bogus"], { LA_SETTINGS_FILE: path }), (err) => {
      assert.equal(err.code, 2);
      assert.ok(err.stderr.includes("unknown integration: bogus"));
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI enabled: a corrupt overlay is a settings error → exit 2, never a plain off", async () => {
  const dir = tempDir();
  try {
    const path = settingsFile(dir);
    writeFileSync(path, JSON.stringify({ integrations: { atlas: "yes" } }), "utf8");
    await assert.rejects(runCli(["enabled", "atlas"], { LA_SETTINGS_FILE: path }), (err) => {
      assert.equal(err.code, 2);
      assert.ok(err.stderr.includes("integrations.atlas: must be a boolean"));
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: wrong arguments → usage on stderr, exit 2", async () => {
  await assert.rejects(runCli([]), (err) => {
    assert.equal(err.code, 2);
    assert.ok(err.stderr.includes("Usage"));
    return true;
  });
  await assert.rejects(runCli(["enabled"]), (err) => err.code === 2);
});