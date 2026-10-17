// Tests for squad-config.mjs — writeSquadConfig — lead writes land in the
// settings overlay (routing.<squad>.lead through fenix-settings), unpriced
// models are refused, provider assignment maps onto provider.active, plus
// agent/pricing/provider-CRUD writes, validateSlug, dry-run and formatting
// preservation. Split from squad-config.test.mjs (code-audit-2026-07-30 §5).
//
// FOC-771: the launchers are two-line Node wrappers with no ANTHROPIC_MODEL
// lines, so nothing here touches bin/*.bat — a lead written into a wrapper
// would be a lie by construction.
//
// All tests operate on fixtures in a temp directory, NEVER on real repo files.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MODULE_PATH = pathToFileURL(join(__dirname, "squad-config.mjs")).href;
const CHILD_MODEL_PATH = pathToFileURL(join(__dirname, "child-model.mjs")).href;
const SETTINGS_PATH = pathToFileURL(join(__dirname, "fenix-settings.mjs")).href;

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.log(`  FAIL: ${label}`);
    failed++;
  }
}

function assertEq(actual, expected, label) {
  // Deep-compare non-strings (arrays/objects), strict-compare primitives.
  if (typeof actual === "string" || typeof expected === "string"
    ? actual === expected
    : JSON.stringify(actual) === JSON.stringify(expected)) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.log(`  FAIL: ${label}`);
    console.log(`    expected: ${JSON.stringify(expected)}`);
    console.log(`    actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

// Env keys the resolver chain depends on — snapshotted and restored so a host
// shell's LA_PROVIDER / SUPERVISOR_MODEL cannot decide a fixture's answer.
const ENV_KEYS = ["LA_SETTINGS_FILE", "LA_PROVIDER", "LA_PROVIDER_RESOLVED", "LA_PROVIDER_SOURCE", "SUPERVISOR_MODEL"];
const envBackup = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
for (const k of ENV_KEYS) delete process.env[k];

// The overlay lives at <root>/.fenix/config/settings.json for a fixture root
// (unless LA_SETTINGS_FILE is set — the explicit seam is tested separately).
const overlayPath = (root) => join(root, ".fenix", "config", "settings.json");

function writeOverlay(root, obj) {
  const p = overlayPath(root);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function buildFixture() {
  const root = mkdtempSync(join(tmpdir(), "squad-config-test-"));

  // agents/dev/agents/implementer.md (LF)
  mkdirSync(join(root, "agents", "dev", "agents"), { recursive: true });
  writeFileSync(
    join(root, "agents", "dev", "agents", "implementer.md"),
    "---\nname: implementer\ndescription: DEV squad — implementacja\nmodel: z-ai/glm-5.2\ntools: Read, Grep, Glob, Edit, Write, Bash\n---\nJesteś sub-agentem IMPLEMENTER.\n",
    "utf8"
  );

  // agents/dev/agents/recon.md (LF)
  writeFileSync(
    join(root, "agents", "dev", "agents", "recon.md"),
    "---\nname: recon\ndescription: DEV squad — recon\nmodel: minimax/minimax-m3\ntools: Read, Grep, Glob, Bash\n---\nJesteś sub-agentem RECON.\n",
    "utf8"
  );

  // agents/dev/agents/notool.md (LF, no tools line — for insert-after-model test)
  writeFileSync(
    join(root, "agents", "dev", "agents", "notool.md"),
    "---\nname: notool\ndescription: DEV squad — no tools yet\nmodel: z-ai/glm-5.2\n---\nJesteś sub-agentem BEZ NARZĘDZI.\n",
    "utf8"
  );

  // agents/dev/plugins/foo/agents/ignored.md — should be IGNORED
  mkdirSync(join(root, "agents", "dev", "plugins", "foo", "agents"), {
    recursive: true,
  });
  writeFileSync(
    join(root, "agents", "dev", "plugins", "foo", "agents", "ignored.md"),
    "---\nname: ignored\nmodel: openai/gpt-999\n---\nShould be ignored.\n",
    "utf8"
  );

  // config/ directory
  mkdirSync(join(root, "config"), { recursive: true });

  // config/tools.json (LF)
  writeFileSync(
    join(root, "config", "tools.json"),
    JSON.stringify(
      {
        _doc: "Katalog narzędzi",
        tools: {
          Read: { label: "Read", description: "Czyta plik.", risk: "safe" },
          Grep: { label: "Grep", description: "Szuka tekstu.", risk: "safe" },
          Glob: { label: "Glob", description: "Znajduje pliki.", risk: "safe" },
          Edit: { label: "Edit", description: "Zmienia plik.", risk: "writes-code" },
          Write: { label: "Write", description: "Tworzy plik.", risk: "writes-code" },
          Bash: { label: "Bash", description: "Uruchamia komendy.", risk: "writes-system" },
          Task: { label: "Task", description: "Deleguje.", risk: "architecture" },
        },
        riskLevels: {
          safe: { label: "bezpieczne", hint: "tylko odczyt" },
          "writes-code": { label: "zmienia kod", hint: "modyfikuje pliki" },
          "writes-system": { label: "zmienia system", hint: "uruchamia komendy" },
          architecture: { label: "zmienia architekturę", hint: "zagnieżdża delegację" },
        },
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  // config/models.json (CRLF) — includes _doc metadata in pricing and
  // top-level keys (ids, routing, providers, fallback) that must survive writes.
  // The lead-relevant entries (deepseek) are priced like the launcher requires.
  writeFileSync(
    join(root, "config", "models.json"),
    '{\r\n' +
    '  "_doc": "Model routing source of truth",\r\n' +
    '  "providers": {\r\n' +
    '    "openrouter": {\r\n' +
    '      "baseUrl": "https://openrouter.ai/api",\r\n' +
    '      "authEnv": "OPENROUTER_API_KEY",\r\n' +
    '      "authStyle": "token"\r\n' +
    '    },\r\n' +
    '    "zai_anthropic": {\r\n' +
    '      "baseUrl": "https://api.z.ai/api/anthropic",\r\n' +
    '      "authEnv": "ZAI_API_KEY",\r\n' +
    '      "authStyle": "token"\r\n' +
    '    }\r\n' +
    '  },\r\n' +
    '  "ids": {\r\n' +
    '    "glm": "z-ai/glm-5.2",\r\n' +
    '    "minimax": "minimax/minimax-m3"\r\n' +
    '  },\r\n' +
    '  "routing": {\r\n' +
    '    "dev": { "implement": "glm" }\r\n' +
    '  },\r\n' +
    '  "pricing": {\r\n' +
    '    "_doc": "USD per 1M tokens (input/output)",\r\n' +
    '    "openrouter": {\r\n' +
    '      "z-ai/glm-5.2": { "input": 1.40, "output": 4.40 },\r\n' +
    '      "minimax/minimax-m3": { "input": 0.30, "output": 1.20 },\r\n' +
    '      "deepseek/deepseek-v4-pro": { "input": 1.60, "output": 3.20 }\r\n' +
    '    }\r\n' +
    '  },\r\n' +
    '  "fallback": {\r\n' +
    '    "_note": "tool-call fail -> retry",\r\n' +
    '    "glm": ["kimi", "opus"]\r\n' +
    '  }\r\n' +
    '}\r\n',
    "utf8"
  );

  return root;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function runTests() {
  const { readSquadConfig, readToolCatalog, validateSlug, validateTools, validateProvidersPatch, writeSquadConfig } = await import(
    MODULE_PATH
  );
  const { childModelFor } = await import(CHILD_MODEL_PATH);
  const { readSettings } = await import(SETTINGS_PATH);

  // ---- Test 1: write lead lands in the settings overlay, not in a .bat ----
  {
    const root = buildFixture();
    const result = writeSquadConfig(
      { squads: { dev: { lead: "deepseek/deepseek-v4-pro" } } },
      root
    );
    assert(
      result.changed.length === 1,
      "write lead produces exactly 1 changed entry (the overlay)"
    );
    assertEq(result.changed[0]?.field, "lead", "changed entry field=lead");
    assertEq(result.changed[0]?.before, null, "no prior resolved lead → before=null");
    assertEq(result.changed[0]?.after, "deepseek/deepseek-v4-pro", "changed entry after=new lead");

    // The overlay now carries routing.dev.lead
    const overlay = readSettings({ path: overlayPath(root) });
    assertEq(overlay.routing?.dev?.lead, "deepseek/deepseek-v4-pro", "overlay routing.dev.lead written");

    // And the launcher-side resolver (childModelFor) picks it up from there
    const modelsConfig = JSON.parse(readFileSync(join(root, "config", "models.json"), "utf8"));
    const resolved = childModelFor({ squad: "dev", settings: overlay, modelsConfig });
    assertEq(resolved.model, "deepseek/deepseek-v4-pro", "childModelFor returns the written lead");
    assertEq(resolved.source, "settings:routing.dev", "childModelFor names the settings source");

    // No .bat file was created or needed
    assert(!existsSync(join(root, "bin")), "no bin/ directory in the write path");
    assertEq(result.refused.length, 0, "nothing refused");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 2: writing the already-resolving lead is a no-op (no overlay pin) ----
  {
    const root = buildFixture();
    // The routing table resolves dev → nothing here (implement only, no
    // defaultModel on the provider), so lead=null; writing null changes nothing.
    let result = writeSquadConfig({ squads: { dev: { lead: null } } }, root);
    assertEq(result.changed.length, 0, "no-op: null lead over a non-resolving squad changes nothing");
    assert(!existsSync(overlayPath(root)), "no-op does not create the overlay");

    // Now make the table resolve z-ai/glm-5.2 for dev and write exactly that —
    // it must NOT pin the table's answer into the overlay.
    const modelsPath = join(root, "config", "models.json");
    const models = JSON.parse(readFileSync(modelsPath, "utf8"));
    models.routing.dev = { worker: "glm" };
    writeFileSync(modelsPath, JSON.stringify(models, null, 2) + "\n", "utf8");

    result = writeSquadConfig({ squads: { dev: { lead: "z-ai/glm-5.2" } } }, root);
    assertEq(result.changed.length, 0, "no-op: writing the table's own answer changes nothing");
    assert(!existsSync(overlayPath(root)), "no-op does not pin routing.dev.lead into the overlay");

    // A genuine change still writes after a no-op
    result = writeSquadConfig({ squads: { dev: { lead: "minimax/minimax-m3" } } }, root);
    assertEq(
      result.changed[0]?.after,
      "minimax/minimax-m3",
      "a different lead still writes"
    );
    const overlay = readSettings({ path: overlayPath(root) });
    assertEq(overlay.routing?.dev?.lead, "minimax/minimax-m3", "second write lands in the overlay");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 3: an unpriced lead is refused like the launcher refuses ----
  {
    const root = buildFixture();
    const result = writeSquadConfig(
      { squads: { dev: { lead: "openai/gpt-unpriced" } } },
      root
    );
    assertEq(result.changed.length, 0, "unpriced lead: nothing changed");
    assert(
      result.refused.some((r) => r.squad === "dev" && r.field === "lead" && r.code === "model-unpriced"),
      "refused names code model-unpriced for dev"
    );
    assert(result.warnings.length >= 1, "unpriced refusal produces a user-facing warning");
    assert(!existsSync(overlayPath(root)), "refused write leaves the overlay untouched");

    // A priced lead in the same patch still goes through
    const result2 = writeSquadConfig(
      { squads: { dev: { lead: "deepseek/deepseek-v4-pro" } } },
      root
    );
    assertEq(result2.refused.length, 0, "priced lead after the refusal is accepted");
    assertEq(result2.changed.length, 1, "priced lead writes");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 3b: an invalid squad name is refused before any write ----
  {
    const root = buildFixture();
    const result = writeSquadConfig(
      { squads: { "Bad Name!": { lead: "z-ai/glm-5.2" } } },
      root
    );
    assertEq(result.changed.length, 0, "invalid squad name: nothing changed");
    assert(
      result.refused.some((r) => r.code === "invalid-squad-name"),
      "refused names code invalid-squad-name"
    );
    assert(!existsSync(overlayPath(root)), "invalid squad name never reaches settings.json");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 4: merge pricing ----
  {
    const root = buildFixture();
    const result = writeSquadConfig(
      {
        pricing: {
          openrouter: {
            "z-ai/glm-5.2": { input: 1.50, output: 5.00 },
            "new/model": { input: 0.10, output: 0.20 },
          },
        },
      },
      root
    );
    assert(
      result.changed.length === 2,
      "pricing merge changes 2 entries"
    );

    const config = readSquadConfig(root);
    assertEq(
      config.pricing.openrouter["z-ai/glm-5.2"].input,
      1.50,
      "pricing glm input updated"
    );
    assertEq(
      config.pricing.openrouter["z-ai/glm-5.2"].output,
      5.00,
      "pricing glm output updated"
    );
    assertEq(
      config.pricing.openrouter["new/model"].input,
      0.10,
      "pricing new model added"
    );
    // Existing entry untouched
    assertEq(
      config.pricing.openrouter["minimax/minimax-m3"].input,
      0.30,
      "pricing minimax untouched"
    );

    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 5: validateSlug ----
  {
    assertEq(validateSlug("").ok, false, "validateSlug empty string → false");
    assertEq(validateSlug(null).ok, false, "validateSlug null → false");
    assertEq(
      validateSlug("z-ai/glm-5.2").ok,
      true,
      "validateSlug valid slug → true"
    );
    assertEq(
      validateSlug("z-ai/glm-5.2").warning,
      null,
      "validateSlug valid slug → no warning"
    );
    const warnResult = validateSlug("glm-5.2");
    assertEq(warnResult.ok, true, "validateSlug no-slash → ok=true");
    assert(
      warnResult.warning !== null,
      "validateSlug no-slash → has warning"
    );
    assert(
      warnResult.warning.includes("OpenRouter"),
      "validateSlug warning mentions OpenRouter"
    );
  }

  // ---- Test 6: a multi-squad lead write lands whole in one settings write ----
  {
    const root = buildFixture();
    const result = writeSquadConfig(
      { squads: { dev: { lead: "minimax/minimax-m3" }, plan: { lead: "z-ai/glm-5.2" } } },
      root
    );
    assertEq(result.changed.length, 2, "two squads → two changed entries");
    assert(
      result.changed.every((c) => c.field === "lead" && c.file.endsWith(join(".fenix", "config", "settings.json"))),
      "both entries name the overlay file with field=lead"
    );
    const overlay = readSettings({ path: overlayPath(root) });
    assertEq(overlay.routing?.dev?.lead, "minimax/minimax-m3", "overlay dev lead");
    assertEq(overlay.routing?.plan?.lead, "z-ai/glm-5.2", "overlay plan lead");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 7: writeSquadConfig warnings for missing files ----
  {
    const root = buildFixture();
    const result = writeSquadConfig(
      {
        squads: {
          dev: { agents: { nonexistent: "some/model" } },
          test: { lead: "some/model" },
        },
      },
      root
    );
    assert(
      result.warnings.length >= 1,
      "warnings generated for missing role/file"
    );
    assert(
      result.refused.some((r) => r.squad === "test" && r.code === "model-unpriced"),
      "unpriced lead in the same patch is refused (not silently written)"
    );
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 8: dryRun does NOT modify files on disk ----
  {
    const root = buildFixture();
    const overlayBefore = existsSync(overlayPath(root)) ? readFileSync(overlayPath(root), "utf8") : null;
    const agentBefore = readFileSync(
      join(root, "agents", "dev", "agents", "implementer.md"),
      "utf8"
    );

    const result = writeSquadConfig(
      {
        squads: {
          dev: {
            lead: "deepseek/deepseek-v4-pro",
            agents: { implementer: { model: "some/other-model" } },
          },
        },
        pricing: { openrouter: { "z-ai/glm-5.2": { input: 9.99, output: 9.99 } } },
      },
      root,
      { dryRun: true }
    );

    // Files must be unchanged
    const overlayAfter = existsSync(overlayPath(root)) ? readFileSync(overlayPath(root), "utf8") : null;
    const agentAfter = readFileSync(
      join(root, "agents", "dev", "agents", "implementer.md"),
      "utf8"
    );
    assertEq(overlayAfter, overlayBefore, "dryRun: overlay unchanged on disk");
    assertEq(agentAfter, agentBefore, "dryRun: implementer.md unchanged on disk");

    // But changed array should reflect what WOULD change
    assert(
      result.changed.length >= 3,
      "dryRun: changed array has expected entries"
    );
    assert(
      result.changed.some((c) => c.file.endsWith(join(".fenix", "config", "settings.json")) && c.field === "lead"),
      "dryRun: the overlay lead change is in changed"
    );
    assert(
      result.changed.some((c) => c.file.endsWith("implementer.md")),
      "dryRun: implementer.md in changed"
    );

    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 9: dryRun returns identical changed as real write ----
  {
    const root1 = buildFixture();
    const root2 = buildFixture();

    const patch = {
      squads: {
        dev: {
          lead: "deepseek/deepseek-v4-pro",
          agents: { implementer: { model: "some/other-model" } },
        },
      },
      pricing: { openrouter: { "z-ai/glm-5.2": { input: 9.99, output: 9.99 } } },
    };

    const dryResult = writeSquadConfig(patch, root1, { dryRun: true });
    const realResult = writeSquadConfig(patch, root2);

    // Compare changed arrays (ignore file paths — they differ by temp dir)
    assertEq(
      dryResult.changed.length,
      realResult.changed.length,
      "dryRun vs real: same changed count"
    );
    for (let i = 0; i < dryResult.changed.length; i++) {
      assertEq(
        JSON.stringify(dryResult.changed[i].before),
        JSON.stringify(realResult.changed[i].before),
        `dryRun vs real: same before [${i}]`
      );
      assertEq(
        JSON.stringify(dryResult.changed[i].after),
        JSON.stringify(realResult.changed[i].after),
        `dryRun vs real: same after [${i}]`
      );
    }
    assertEq(
      dryResult.warnings.length,
      realResult.warnings.length,
      "dryRun vs real: same warnings count"
    );

    rmSync(root1, { recursive: true, force: true });
    rmSync(root2, { recursive: true, force: true });
  }

  // ---- Test 10: two-argument call still writes (backward compat) ----
  {
    const root = buildFixture();
    const result = writeSquadConfig(
      { squads: { dev: { lead: "z-ai/glm-5.2" } } },
      root
    );
    assert(
      result.changed.length >= 1,
      "2-arg call: changes detected"
    );
    const overlay = readSettings({ path: overlayPath(root) });
    assertEq(
      overlay.routing?.dev?.lead,
      "z-ai/glm-5.2",
      "2-arg call: the overlay actually written"
    );
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 10b: LA_SETTINGS_FILE wins over the root-derived overlay ----
  {
    const root = buildFixture();
    const seamPath = join(root, "seam-settings.json");
    try {
      process.env.LA_SETTINGS_FILE = seamPath;
      const result = writeSquadConfig({ squads: { dev: { lead: "minimax/minimax-m3" } } }, root);
      assertEq(result.changed.length, 1, "seam write reported");
      assertEq(result.changed[0]?.field, "lead", "seam entry field=lead");
      const overlay = readSettings({ path: seamPath });
      assertEq(overlay.routing?.dev?.lead, "minimax/minimax-m3", "LA_SETTINGS_FILE received the write");
      assert(!existsSync(overlayPath(root)), "root-derived overlay not created when the seam is set");
    } finally {
      delete process.env.LA_SETTINGS_FILE;
    }
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 11: writeSquadConfig preserves _doc in models.json ----
  {
    const root = buildFixture();
    writeSquadConfig(
      { pricing: { openrouter: { "z-ai/glm-5.2": { input: 9.99, output: 9.99 } } } },
      root
    );
    const raw = readFileSync(join(root, "config", "models.json"), "utf8");
    const data = JSON.parse(raw);
    assert(
      data.pricing["_doc"] !== undefined,
      "writeSquadConfig: _doc preserved in pricing after write"
    );
    assertEq(
      data.pricing["_doc"],
      "USD per 1M tokens (input/output)",
      "writeSquadConfig: _doc value unchanged"
    );
    assertEq(
      data.pricing.openrouter["z-ai/glm-5.2"].input,
      9.99,
      "writeSquadConfig: glm input updated"
    );
    // Top-level keys preserved
    assert(
      data.ids !== undefined,
      "writeSquadConfig: top-level 'ids' preserved"
    );
    assert(
      data.routing !== undefined,
      "writeSquadConfig: top-level 'routing' preserved"
    );
    assert(
      data.providers !== undefined,
      "writeSquadConfig: top-level 'providers' preserved"
    );
    assert(
      data.fallback !== undefined,
      "writeSquadConfig: top-level 'fallback' preserved"
    );
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 12: writeSquadConfig silently ignores _-prefixed keys in patch ----
  {
    const root = buildFixture();
    const result = writeSquadConfig(
      {
        pricing: {
          "_doc": "malicious provider-level overwrite",
          openrouter: {
            "_note": "malicious model-level note",
            "z-ai/glm-5.2": { input: 5.00, output: 10.00 },
          },
        },
      },
      root
    );
    // Should have changed only the real entry — metadata keys at both levels are ignored
    assert(
      result.changed.length === 1,
      "writeSquadConfig: _-prefixed keys in patch ignored, only 1 real change"
    );
    const raw = readFileSync(join(root, "config", "models.json"), "utf8");
    const data = JSON.parse(raw);
    assertEq(
      data.pricing["_doc"],
      "USD per 1M tokens (input/output)",
      "writeSquadConfig: provider-level _doc NOT overwritten by patch"
    );
    assert(
      data.pricing.openrouter["_note"] === undefined,
      "writeSquadConfig: model-level _note NOT written by patch"
    );
    assertEq(
      data.pricing.openrouter["z-ai/glm-5.2"].input,
      5.00,
      "writeSquadConfig: real pricing still updated"
    );
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 13: writeSquadConfig preserves ids/routing/providers/fallback ----
  {
    const root = buildFixture();
    writeSquadConfig(
      { pricing: { openrouter: { "new/model": { input: 0.10, output: 0.20 } } } },
      root
    );
    const raw = readFileSync(join(root, "config", "models.json"), "utf8");
    const data = JSON.parse(raw);
    assert(
      data.ids && data.ids.glm === "z-ai/glm-5.2",
      "writeSquadConfig: ids.glm preserved"
    );
    assert(
      data.routing && data.routing.dev && data.routing.dev.implement === "glm",
      "writeSquadConfig: routing.dev.implement preserved"
    );
    assert(
      data.providers && data.providers.openrouter !== undefined,
      "writeSquadConfig: providers preserved"
    );
    assert(
      data.providers.openrouter.baseUrl === "https://openrouter.ai/api",
      "writeSquadConfig: providers.openrouter.baseUrl intact after round-trip"
    );
    assert(
      data.providers.openrouter.authEnv === "OPENROUTER_API_KEY",
      "writeSquadConfig: providers.openrouter.authEnv intact after round-trip"
    );
    assert(
      data.providers.openrouter.authStyle === "token",
      "writeSquadConfig: providers.openrouter.authStyle intact after round-trip"
    );
    assert(
      data.fallback && data.fallback.glm !== undefined,
      "writeSquadConfig: fallback preserved"
    );
    assert(
      data.pricing.openrouter["new/model"] !== undefined,
      "writeSquadConfig: new pricing entry added under pricing.openrouter"
    );
    assertEq(
      Object.keys(data.pricing.openrouter).length,
      4,
      "writeSquadConfig: pre-existing pricing rows preserved under pricing.openrouter"
    );
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 14: string patch still changes model (backward compat) ----
  {
    const root = buildFixture();
    const result = writeSquadConfig(
      {
        squads: {
          dev: {
            agents: { implementer: "deepseek/deepseek-v4-pro" },
          },
        },
      },
      root
    );
    assert(
      result.changed.length === 1,
      "string patch changes 1 file"
    );
    assertEq(
      result.changed[0].field,
      "model",
      "string patch → field=model"
    );
    assertEq(
      result.changed[0].after,
      "deepseek/deepseek-v4-pro",
      "string patch → model updated"
    );

    const md = readFileSync(
      join(root, "agents", "dev", "agents", "implementer.md"),
      "utf8"
    );
    assert(
      md.includes("model: deepseek/deepseek-v4-pro"),
      "implementer.md model changed"
    );
    assert(
      md.includes("tools: Read, Grep, Glob, Edit, Write, Bash"),
      "implementer.md tools untouched"
    );
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 15: object patch with both model and tools changes both ----
  {
    const root = buildFixture();
    const result = writeSquadConfig(
      {
        squads: {
          dev: {
            agents: {
              implementer: {
                model: "deepseek/deepseek-v4-pro",
                tools: ["Read", "Bash"],
              },
            },
          },
        },
      },
      root
    );
    assert(
      result.changed.length === 2,
      "object patch with model+tools changes 2 entries"
    );
    assert(
      result.changed.some((c) => c.field === "model"),
      "has model change"
    );
    assert(
      result.changed.some((c) => c.field === "tools"),
      "has tools change"
    );

    const md = readFileSync(
      join(root, "agents", "dev", "agents", "implementer.md"),
      "utf8"
    );
    assert(
      md.includes("model: deepseek/deepseek-v4-pro"),
      "implementer.md model changed"
    );
    assert(
      md.includes("tools: Read, Bash"),
      "implementer.md tools changed"
    );
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 16: a uniform provider assignment writes provider.active ----
  {
    const root = buildFixture();

    // Assign: dev → zai_anthropic
    const r1 = writeSquadConfig({ squads: { dev: { provider: "zai_anthropic" } } }, root);
    assertEq(
      r1.changed.length,
      1,
      "provider assign produces 1 changed entry (provider.active)"
    );
    assertEq(r1.changed[0]?.field, "provider", "provider entry field=provider");
    assertEq(r1.changed[0]?.before, "openrouter", "provider entry before=openrouter");
    assertEq(r1.changed[0]?.after, "zai_anthropic", "provider entry after=zai_anthropic");
    const overlay1 = readSettings({ path: overlayPath(root) });
    assertEq(overlay1.provider?.active, "zai_anthropic", "overlay provider.active written");

    // The read now reports it for every squad
    let config = readSquadConfig(root);
    assertEq(config.squads.dev.provider, "zai_anthropic", "read reports zai_anthropic for dev");
    assertEq(config.squads.plan.provider, "zai_anthropic", "read reports zai_anthropic for plan");

    // Writing the already-active provider again is a no-op
    const r2 = writeSquadConfig({ squads: { dev: { provider: "zai_anthropic" } } }, root);
    assertEq(r2.changed.length, 0, "re-writing the active provider is a no-op");

    // Back to openrouter → provider.active is removed, not set to a literal
    const r3 = writeSquadConfig({ squads: { dev: { provider: "openrouter" } } }, root);
    assertEq(r3.changed.length, 1, "switching back to openrouter is a change");
    const overlay3 = readSettings({ path: overlayPath(root) });
    assertEq(overlay3.provider?.active, undefined, "openrouter → provider.active removed");
    config = readSquadConfig(root);
    assertEq(config.squads.dev.provider, "openrouter", "read reports openrouter after the reset");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 16b: divergent or unknown provider assignments are refused ----
  {
    const root = buildFixture();
    const result = writeSquadConfig(
      { squads: { dev: { provider: "zai_anthropic" }, plan: { provider: "openrouter" } } },
      root
    );
    assertEq(result.changed.length, 0, "divergent assignments change nothing");
    assertEq(result.refused.length, 2, "both squads refused");
    assert(
      result.refused.every((r) => r.field === "provider" && r.code === "divergent-provider"),
      "refusals name code divergent-provider for every squad in the patch"
    );

    const result2 = writeSquadConfig(
      { squads: { dev: { provider: "no_such_provider" } } },
      root
    );
    assertEq(result2.changed.length, 0, "unknown provider changes nothing");
    assert(
      result2.refused.some((r) => r.code === "unknown-provider" && r.squad === "dev"),
      "unknown provider refused (code unknown-provider)"
    );
    assert(!existsSync(overlayPath(root)), "no provider refusal ever touches the overlay");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 18: provider CRUD validation matrix ----
  {
    // Validation is pure — no fixture needed; a minimal current state suffices.
    const current = {
      providers: { openrouter: { baseUrl: "https://openrouter.ai/api", authEnv: "OPENROUTER_API_KEY", authStyle: "token" } },
      squads: { dev: { provider: "openrouter" } },
    };
    // Bad name
    assert(
      !validateProvidersPatch({ providers: { "Bad Name": { baseUrl: "https://x.com", authEnv: "X_KEY" } } }, current).ok,
      "bad provider name rejected"
    );
    // Bad URL
    assert(
      !validateProvidersPatch({ providers: { good: { baseUrl: "ftp://x.com", authEnv: "X_KEY" } } }, current).ok,
      "bad baseUrl rejected"
    );
    // Bad env-var name (must be uppercase NAME)
    assert(
      !validateProvidersPatch({ providers: { good: { baseUrl: "https://x.com", authEnv: "myKey" } } }, current).ok,
      "bad authEnv rejected"
    );
    // Bad authStyle
    assert(
      !validateProvidersPatch({ providers: { good: { baseUrl: "https://x.com", authEnv: "X_KEY", authStyle: "bearer" } } }, current).ok,
      "bad authStyle rejected"
    );
    // openrouter cannot be removed
    assert(
      !validateProvidersPatch({ providers: { openrouter: null } }, current).ok,
      "openrouter removal rejected"
    );
    // Valid add
    const ok = validateProvidersPatch(
      { providers: { zai_anthropic: { baseUrl: "https://api.z.ai/api/anthropic", authEnv: "ZAI_API_KEY", authStyle: "token", models: ["glm-5.2"] } } },
      current
    );
    assert(ok.ok, "valid provider add passes");
  }

  // ---- Test 19: referenced-provider deletion rejected ----
  {
    const root = buildFixture();
    // Create a custom provider, assign dev to it (→ provider.active), then try
    // to delete it. The read must report the assignment so the validator sees
    // the reference.
    writeSquadConfig(
      { providers: { zai_anthropic: { baseUrl: "https://api.z.ai/api/anthropic", authEnv: "ZAI_API_KEY", authStyle: "token" } } },
      root
    );
    writeSquadConfig({ squads: { dev: { provider: "zai_anthropic" } } }, root);

    const current = readSquadConfig(root);
    assertEq(
      current.squads.dev.provider,
      "zai_anthropic",
      "assignment visible to the validator through the read"
    );
    const pv = validateProvidersPatch({ providers: { zai_anthropic: null } }, current);
    assertEq(pv.ok, false, "referenced provider deletion rejected");
    assert(
      pv.errors.some((e) => e.includes("zai_anthropic") && e.includes("dev")),
      "deletion error names the provider and the referencing squad"
    );
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 20: provider removal also removes its pricing scope ----
  {
    const root = buildFixture();
    // Add provider + pricing under it
    writeSquadConfig(
      {
        providers: { zai_anthropic: { baseUrl: "https://api.z.ai/api/anthropic", authEnv: "ZAI_API_KEY", authStyle: "token" } },
        pricing: { zai_anthropic: { "glm-5.2": { input: 0.5, output: 2.0 } } },
      },
      root
    );
    let config = readSquadConfig(root);
    assert(
      config.providers.zai_anthropic !== undefined && config.pricing.zai_anthropic !== undefined,
      "provider + pricing scope present before removal"
    );

    // Remove the (unreferenced) provider
    writeSquadConfig({ providers: { zai_anthropic: null } }, root);
    config = readSquadConfig(root);
    assert(
      config.providers.zai_anthropic === undefined,
      "provider removed"
    );
    assert(
      config.pricing.zai_anthropic === undefined,
      "pricing scope removed with provider"
    );
    // openrouter untouched
    assert(
      config.providers.openrouter !== undefined && config.pricing.openrouter !== undefined,
      "openrouter provider + pricing scope untouched"
    );
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 20b: a UI-shaped save must not erase providers.<name>.tiers ----
  {
    const root = buildFixture();
    // Seed a provider that carries model tiers (consumed by provider-resolve.mjs
    // to set ANTHROPIC_DEFAULT_*/SMALL_FAST — including the tier Claude Code's
    // permission classifier runs on).
    writeSquadConfig(
      {
        providers: {
          nebul: {
            baseUrl: "https://api.inference.nebul.io",
            authEnv: "NEBUL_API_KEY",
            authStyle: "token",
            tiers: { opus: "zai-org/GLM-5.2-FP8", sonnet: "zai-org/GLM-5.2-FP8" },
          },
        },
      },
      root
    );
    let config = readSquadConfig(root);
    assertEq(config.providers.nebul.tiers.sonnet, "zai-org/GLM-5.2-FP8", "tiers stored on write");

    // The dashboard's provider form only knows baseUrl/authEnv/authStyle/models,
    // so it re-sends a profile with no `tiers` at all. That must not wipe them —
    // every launcher would come up with its model aliases unset.
    writeSquadConfig(
      {
        providers: {
          nebul: { baseUrl: "http://127.0.0.1:8899", authEnv: "NEBUL_API_KEY", authStyle: "token" },
        },
      },
      root
    );
    config = readSquadConfig(root);
    assertEq(config.providers.nebul.baseUrl, "http://127.0.0.1:8899", "baseUrl edit applied");
    assertEq(
      config.providers.nebul.tiers && config.providers.nebul.tiers.sonnet,
      "zai-org/GLM-5.2-FP8",
      "tiers survive a save that omits them"
    );

    // An explicit tiers patch still replaces them, and non-string values are dropped.
    writeSquadConfig(
      {
        providers: {
          nebul: {
            baseUrl: "http://127.0.0.1:8899", authEnv: "NEBUL_API_KEY", authStyle: "token",
            tiers: { opus: "zai-org/GLM-5.1-FP8", sonnet: 42 },
          },
        },
      },
      root
    );
    config = readSquadConfig(root);
    assertEq(config.providers.nebul.tiers.opus, "zai-org/GLM-5.1-FP8", "explicit tiers patch applied");
    assertEq(config.providers.nebul.tiers.sonnet, undefined, "non-string tier value rejected");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 21: provider-aware slug validation (both regimes) ----
  {
    // OpenRouter regime: existing vendor/model slug regex
    const orValid = validateSlug("z-ai/glm-5.2", "openrouter");
    assertEq(orValid.ok, true, "openrouter slug valid");
    assertEq(orValid.warning, null, "openrouter slug no warning");
    const orWarn = validateSlug("glm-5.2", "openrouter");
    assertEq(orWarn.ok, true, "openrouter no-slash → ok=true (non-blocking)");
    assert(orWarn.warning !== null, "openrouter no-slash → warning");

    // Custom regime: loose model-ID shape
    const cuValid = validateSlug("glm-5.2", "zai_anthropic");
    assertEq(cuValid.ok, true, "custom provider model valid");
    assertEq(cuValid.warning, null, "custom provider model no warning");
    const cuSlash = validateSlug("some/vendor-model", "zai_anthropic");
    assertEq(cuSlash.ok, true, "custom provider allows slash in model id");
    const cuBad = validateSlug("glm 5.2", "zai_anthropic");
    assertEq(cuBad.ok, false, "custom provider rejects space");
    const cuQuote = validateSlug('glm"5', "zai_anthropic");
    assertEq(cuQuote.ok, false, "custom provider rejects quote");
    const cuPercent = validateSlug("glm%5", "zai_anthropic");
    assertEq(cuPercent.ok, false, "custom provider rejects percent");
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  console.log("squad-config-write tests\n");
  try {
    await runTests();
  } finally {
    for (const [k, v] of envBackup) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();