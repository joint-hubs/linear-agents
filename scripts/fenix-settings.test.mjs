// scripts/fenix-settings.test.mjs — FOC-773 slice A1: the Settings overlay
// contract. Pins: defaults on a missing file, invalid-JSON failure, the deep
// merge with null-deletes semantics, every validation rule (including
// secret-shaped values refused and http only for local hosts), and the
// atomic write (temp file in the same dir + rename, nothing left behind).
//
// Run: node --test scripts/fenix-settings.test.mjs
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { readSettings, validateSettings, writeSettings } from "./fenix-settings.mjs";

const execFileP = promisify(execFile);
const CLI = fileURLToPath(new URL("./fenix-settings.mjs", import.meta.url));

/** Runs the `get` CLI against a settings file via LA_SETTINGS_FILE. */
function runGet(path, dotted) {
  return execFileP(process.execPath, [CLI, "get", dotted], {
    env: { ...process.env, LA_SETTINGS_FILE: path },
    windowsHide: true,
  });
}

/** Runs the `set` CLI against a settings file via LA_SETTINGS_FILE. */
function runSet(path, dotted, value) {
  return execFileP(process.execPath, [CLI, "set", dotted, value], {
    env: { ...process.env, LA_SETTINGS_FILE: path },
    windowsHide: true,
  });
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), "foc-773-"));
}

function settingsFile(dir) {
  return join(dir, "settings.json");
}

const VALID_CUSTOM = {
  baseUrl: "https://openrouter.ai/api/v1",
  authStyle: "apikey",
  keyName: "OPENROUTER_API_KEY",
  tiers: { opus: "z-ai/glm-5.3", smallFast: "z-ai/glm-5.3-flash" },
  defaultModel: "z-ai/glm-5.3",
};

const VALID = {
  provider: { active: "openrouter", custom: VALID_CUSTOM },
  routing: { "fenix-dev": { lead: "Claude" } },
};

test("readSettings: missing file → the empty default", () => {
  const dir = tempDir();
  try {
    assert.deepEqual(readSettings({ path: settingsFile(dir) }), {
      provider: { active: null, custom: null },
      routing: {},
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readSettings: invalid JSON throws with the path in the message", () => {
  const dir = tempDir();
  try {
    const path = settingsFile(dir);
    writeFileSync(path, "{ not json", "utf8");
    assert.throws(() => readSettings({ path }), (err) =>
      err.message.includes("settings.json is not valid JSON") && err.message.includes(path),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validateSettings: a fully valid object passes", () => {
  assert.deepEqual(validateSettings(VALID), { ok: true, errors: [] });
});

test("validateSettings: unknown top-level key refused", () => {
  const { ok, errors } = validateSettings({ ...VALID, sneaky: true });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("sneaky") && e.includes("unknown top-level key")));
});

test("validateSettings: provider.active must be null or a short lowercase name", () => {
  assert.deepEqual(validateSettings({ provider: { active: null } }), { ok: true, errors: [] });
  assert.equal(validateSettings({ provider: { active: "openrouter" } }).ok, true);
  assert.equal(validateSettings({ provider: { active: "Openrouter" } }).ok, false);
  assert.equal(validateSettings({ provider: { active: "a".repeat(33) } }).ok, false);
  assert.equal(validateSettings({ provider: { active: "1bad" } }).ok, false);
});

test("validateSettings: provider.custom unknown keys refused", () => {
  const { ok, errors } = validateSettings({
    provider: { custom: { ...VALID_CUSTOM, extra: 1 } },
  });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("provider.custom.extra")));
});

test("validateSettings: https baseUrl always allowed; http only for local hosts", () => {
  const https = validateSettings({ provider: { custom: { ...VALID_CUSTOM, baseUrl: "https://x.example/api" } } });
  assert.equal(https.ok, true);
  for (const host of ["127.0.0.1", "localhost", "host.docker.internal"]) {
    const local = validateSettings({
      provider: { custom: { ...VALID_CUSTOM, baseUrl: `http://${host}:8000/v1` } },
    });
    assert.equal(local.ok, true, `http to ${host} should pass`);
  }
  const remote = validateSettings({
    provider: { custom: { ...VALID_CUSTOM, baseUrl: "http://openrouter.ai/api/v1" } },
  });
  assert.equal(remote.ok, false);
  assert.ok(remote.errors.some((e) => e.includes("http is only allowed")));
  assert.equal(
    validateSettings({ provider: { custom: { ...VALID_CUSTOM, baseUrl: "ftp://x" } } }).ok,
    false,
  );
});

test("validateSettings: authStyle, keyName, tiers and defaultModel rules", () => {
  assert.equal(
    validateSettings({ provider: { custom: { ...VALID_CUSTOM, authStyle: "bearer" } } }).ok,
    false,
  );
  assert.equal(
    validateSettings({ provider: { custom: { ...VALID_CUSTOM, keyName: "bad-name" } } }).ok,
    false,
  );
  assert.equal(
    validateSettings({ provider: { custom: { ...VALID_CUSTOM, tiers: { gpt: "x" } } } }).ok,
    false,
  );
  assert.equal(
    validateSettings({ provider: { custom: { ...VALID_CUSTOM, tiers: { opus: "" } } } }).ok,
    false,
  );
  assert.equal(
    validateSettings({ provider: { custom: { ...VALID_CUSTOM, defaultModel: "" } } }).ok,
    false,
  );
  assert.equal(
    validateSettings({ provider: { custom: { ...VALID_CUSTOM, defaultModel: "m".repeat(201) } } }).ok,
    false,
  );
});

test("validateSettings: routing squad names, entries and lead limits", () => {
  assert.equal(validateSettings({ routing: { Web: { lead: "x" } } }).ok, false);
  assert.equal(validateSettings({ routing: { web: { lead: "" } } }).ok, false);
  assert.equal(validateSettings({ routing: { web: { lead: "l".repeat(201) } } }).ok, false);
  assert.equal(validateSettings({ routing: { web: { lead: "x", extra: 1 } } }).ok, false);
  assert.equal(validateSettings({ routing: { web: { lead: "Claude" } } }).ok, true);
});

// --- the `ownership` top-level key (FOC-848) ---------------------------------

test("validateSettings: a valid ownership map passes, with or without version/unlisted", () => {
  const full = validateSettings({
    ownership: {
      version: 1,
      owners: {
        orchestrator: { linearProjects: ["proj-id", "Fenix — wydanie 1.0"] },
        supervisor: { linearProjects: ["JW", "WSKM"] },
      },
      unlisted: "ask",
    },
  });
  assert.deepEqual(full, { ok: true, errors: [] });
  // version and unlisted are optional; owners is required.
  assert.deepEqual(
    validateSettings({ ownership: { owners: { supervisor: { linearProjects: ["x"] } } } }),
    { ok: true, errors: [] },
  );
});

test("validateSettings: malformed ownership maps are refused", () => {
  const cases = [
    { ownership: { owners: { "Bad Owner!": { linearProjects: ["x"] } } }, hit: "owner id must match" },
    { ownership: { owners: { supervisor: { linearProjects: [] } } }, hit: "non-empty array" },
    { ownership: { owners: { supervisor: { linearProjects: [""] } } }, hit: "non-empty string" },
    { ownership: { owners: { supervisor: { linearProjects: "x" } } }, hit: "non-empty array" },
    { ownership: { owners: { supervisor: { projects: ["x"] } } }, hit: "unknown key" },
    { ownership: { owners: { supervisor: { linearProjects: ["x"] }, extra: 1 } }, hit: "must be an object" },
    { ownership: { owners: {}, unlisted: "maybe" }, hit: 'must be "allow" or "ask"' },
    { ownership: { owners: {}, version: 2 }, hit: "must be 1" },
    { ownership: "nope", hit: "must be an object" },
    { ownership: { nope: 1 }, hit: "unknown key" },
  ];
  for (const { ownership, hit } of cases) {
    const { ok, errors } = validateSettings({ ownership });
    assert.equal(ok, false, JSON.stringify(ownership));
    assert.ok(errors.some((e) => e.includes(hit)), `${hit} missing from ${JSON.stringify(errors)}`);
  }
});


test("validateSettings: secret-looking values refused anywhere", () => {
  const secrets = [
    "sk-or-v1-0123456789abcdef",
    "sk-ant-api03-0123456789abcdef",
    "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    "github_pat_0123456789abcdef0123",
    "lin_api_0123456789abcdef",
  ];
  for (const secret of secrets) {
    const top = validateSettings({ provider: { active: secret } });
    assert.equal(top.ok, false, `${secret} must be refused`);
    assert.ok(top.errors.some((e) => e.includes("settings must not contain secrets")));
    const nested = validateSettings({ routing: { web: { lead: secret } } });
    assert.equal(nested.ok, false, `${secret} must be refused when nested`);
  }
});

test("writeSettings: merges into the defaults and persists", () => {
  const dir = tempDir();
  try {
    const path = settingsFile(dir);
    const merged = writeSettings(
      { provider: { active: "openrouter" }, routing: { "fenix-dev": { lead: "Claude" } } },
      { path },
    );
    assert.equal(merged.provider.active, "openrouter");
    assert.equal(merged.provider.custom, null);
    assert.deepEqual(readSettings({ path }), {
      provider: { active: "openrouter", custom: null },
      routing: { "fenix-dev": { lead: "Claude" } },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeSettings: merges over an existing file; null deletes a key", () => {
  const dir = tempDir();
  try {
    const path = settingsFile(dir);
    writeSettings(
      { provider: { active: "openrouter", custom: VALID_CUSTOM }, routing: { web: { lead: "A" } } },
      { path },
    );
    const merged = writeSettings({ provider: { active: null }, routing: { web: { lead: "B" } } }, { path });
    assert.equal(merged.provider.active, undefined);
    assert.deepEqual(merged.provider.custom, VALID_CUSTOM);
    assert.equal(merged.routing.web.lead, "B");
    const onDisk = readSettings({ path });
    assert.equal(onDisk.provider.custom.baseUrl, VALID_CUSTOM.baseUrl);
    assert.equal(onDisk.routing.web.lead, "B");
    // A null squad entry removes it entirely.
    writeSettings({ routing: { web: null } }, { path });
    assert.deepEqual(readSettings({ path }).routing, {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeSettings: validation failure throws and leaves the file untouched", () => {
  const dir = tempDir();
  try {
    const path = settingsFile(dir);
    writeSettings({ provider: { active: "openrouter" } }, { path });
    const before = readFileSync(path, "utf8");
    assert.throws(
      () => writeSettings({ provider: { active: "BAD NAME" } }, { path }),
      (err) => err.message.includes("validation failed") && err.message.includes("provider.active"),
    );
    assert.equal(readFileSync(path, "utf8"), before);
    // Unknown keys are refused the same way — file untouched, no temp left.
    assert.throws(() => writeSettings({ nope: true }, { path }));
    assert.equal(readFileSync(path, "utf8"), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeSettings: atomic write leaves only settings.json behind", () => {
  const dir = tempDir();
  try {
    const path = settingsFile(dir);
    writeSettings({ provider: { active: "openrouter" } }, { path });
    assert.deepEqual(readdirSync(dir), ["settings.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- CLI: `get <dotted.path>` ----------------------------------------------

test("CLI get: prints the string at the dotted path", async () => {
  const dir = tempDir();
  try {
    const path = settingsFile(dir);
    writeSettings({ routing: { supervisor: { lead: "z-ai/glm-5.3" } } }, { path });
    const { stdout } = await runGet(path, "routing.supervisor.lead");
    assert.equal(stdout, "z-ai/glm-5.3\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI get: missing path or file → empty stdout, exit 0", async () => {
  const dir = tempDir();
  try {
    const missingKey = await runGet(settingsFile(dir), "routing.supervisor.lead");
    assert.equal(missingKey.stdout, "");
    const missingFile = await runGet(settingsFile(tempDir()), "routing.supervisor.lead");
    assert.equal(missingFile.stdout, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI get: invalid JSON → stderr message, exit 1", async () => {
  const dir = tempDir();
  try {
    const path = settingsFile(dir);
    writeFileSync(path, "{ not json", "utf8");
    await assert.rejects(runGet(path, "routing.supervisor.lead"), (err) => {
      assert.equal(err.code, 1);
      assert.ok(err.stderr.includes("not valid JSON"));
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI get: settings that fail validation → stderr, exit 1", async () => {
  const dir = tempDir();
  try {
    const path = settingsFile(dir);
    writeFileSync(path, JSON.stringify({ routing: { supervisor: { lead: "" } } }), "utf8");
    await assert.rejects(runGet(path, "routing.supervisor.lead"), (err) => {
      assert.equal(err.code, 1);
      assert.ok(err.stderr.includes("routing.supervisor.lead"));
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- CLI: `set <dotted.path> <value>` ----------------------------------------

test("CLI set: a non-JSON value is stored as a string", async () => {
  const dir = tempDir();
  try {
    const path = settingsFile(dir);
    await runSet(path, "provider.active", "openrouter");
    assert.equal(readSettings({ path }).provider.active, "openrouter");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI set: a JSON object value replaces the whole node", async () => {
  const dir = tempDir();
  try {
    const path = settingsFile(dir);
    await runSet(path, "routing.web", '{"lead":"Claude"}');
    assert.equal(readSettings({ path }).routing.web.lead, "Claude");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI set: null deletes the key", async () => {
  const dir = tempDir();
  try {
    const path = settingsFile(dir);
    await runSet(path, "provider.active", "openrouter");
    await runSet(path, "provider.active", "null");
    const onDisk = readSettings({ path });
    assert.equal(onDisk.provider.active, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI set: validation failure → stderr, exit 1, file untouched", async () => {
  const dir = tempDir();
  try {
    const path = settingsFile(dir);
    await runSet(path, "provider.active", "openrouter");
    const before = readFileSync(path, "utf8");
    await assert.rejects(runSet(path, "provider.active", "BAD NAME"), (err) => {
      assert.equal(err.code, 1);
      assert.ok(err.stderr.includes("validation failed"));
      assert.ok(err.stderr.includes("provider.active"));
      return true;
    });
    assert.equal(readFileSync(path, "utf8"), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI set: wrong argument count → usage on stderr, exit 2", async () => {
  const dir = tempDir();
  try {
    const path = settingsFile(dir);
    await assert.rejects(
      execFileP(process.execPath, [CLI, "set", "provider.active"], {
        env: { ...process.env, LA_SETTINGS_FILE: path },
        windowsHide: true,
      }),
      (err) => {
        assert.equal(err.code, 2);
        assert.ok(err.stderr.includes("Usage"));
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test("custom remains valid when patches delete its configuration; dry-run writes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "settings-transaction-"));
  try {
    const path = join(dir, "settings.json");
    writeSettings({ provider: { active: "custom", custom: VALID_CUSTOM } }, { path });
    const before = readFileSync(path, "utf8");
    assert.throws(() => writeSettings({ provider: { custom: null } }, { path }), /required when active is custom/);
    assert.equal(readFileSync(path, "utf8"), before);
    const preview = writeSettings({ provider: { active: "openrouter" } }, { path, dryRun: true });
    assert.equal(preview.provider.active, "openrouter");
    assert.equal(readFileSync(path, "utf8"), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
