// Tests for squad-config.mjs — writeSquadConfig — lead/model/pricing writes, validateSlug, CRLF, dry-run, backward compat, formatting preservation.
// Split from squad-config.test.mjs (code-audit-2026-07-30 §5: 1138 lines /
// 7 exported symbols was the largest test file in the repo, by a wide margin).
//
// All tests operate on fixtures in a temp directory, NEVER on real repo files.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MODULE_PATH = pathToFileURL(join(__dirname, "squad-config.mjs")).href;

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
  if (actual === expected) {
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

function buildFixture() {
  const root = mkdtempSync(join(tmpdir(), "squad-config-test-"));

  // bin/
  mkdirSync(join(root, "bin"), { recursive: true });

  // bin/dev.bat (CRLF, simple — no NATIVE branch)
  writeFileSync(
    join(root, "bin", "dev.bat"),
    '@echo off\r\nsetlocal\r\ncall "%~dp0_lib.bat" || exit /b 1\r\nset "ANTHROPIC_MODEL=z-ai/glm-5.2"\r\nset "ANTHROPIC_SMALL_FAST_MODEL=minimax/minimax-m3"\r\nclaude %*\r\nendlocal\r\n',
    "utf8"
  );

  // bin/dev-dry.bat (CRLF)
  writeFileSync(
    join(root, "bin", "dev-dry.bat"),
    '@echo off\r\nsetlocal\r\ncall "%~dp0_lib.bat" || exit /b 1\r\nset "ANTHROPIC_MODEL=z-ai/glm-5.2"\r\nset "DEV_DRY_RUN=1"\r\nclaude -p "dry" %*\r\nendlocal\r\n',
    "utf8"
  );

  // bin/plan.bat (CRLF, with NATIVE/else split)
  writeFileSync(
    join(root, "bin", "plan.bat"),
    '@echo off\r\nsetlocal\r\ncall "%~dp0_lib.bat" || exit /b 1\r\nif defined NATIVE (\r\n    set "ANTHROPIC_MODEL=claude-opus-4-8"\r\n) else (\r\n    set "ANTHROPIC_MODEL=anthropic/claude-opus-4.8"\r\n)\r\nclaude %*\r\nendlocal\r\n',
    "utf8"
  );

  // bin/plan-dry.bat (CRLF, no NATIVE split — just the OpenRouter model)
  writeFileSync(
    join(root, "bin", "plan-dry.bat"),
    '@echo off\r\nsetlocal\r\ncall "%~dp0_lib.bat" || exit /b 1\r\nset "ANTHROPIC_MODEL=anthropic/claude-opus-4.8"\r\nset "PLAN_DRY_RUN=1"\r\nclaude -p "dry" %*\r\nendlocal\r\n',
    "utf8"
  );

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
  writeFileSync(
    join(root, "config", "models.json"),
    '{\r\n' +
    '  "_doc": "Model routing source of truth",\r\n' +
    '  "providers": {\r\n' +
    '    "openrouter": {\r\n' +
    '      "baseUrl": "https://openrouter.ai/api",\r\n' +
    '      "authEnv": "OPENROUTER_API_KEY",\r\n' +
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
    '      "minimax/minimax-m3": { "input": 0.30, "output": 1.20 }\r\n' +
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

  // ---- Test 1: write lead updates BOTH .bat files ----
  {
    const root = buildFixture();
    const result = writeSquadConfig(
      { squads: { dev: { lead: "deepseek/deepseek-v4-pro" } } },
      root
    );
    assert(
      result.changed.length === 2,
      "write lead changes 2 files (dev.bat + dev-dry.bat)"
    );

    // Verify dev.bat
    const devBat = readFileSync(join(root, "bin", "dev.bat"), "utf8");
    assert(
      devBat.includes('set "ANTHROPIC_MODEL=deepseek/deepseek-v4-pro"'),
      "dev.bat has new lead model"
    );
    assert(
      devBat.includes('set "ANTHROPIC_SMALL_FAST_MODEL=minimax/minimax-m3"'),
      "dev.bat SMALL_FAST_MODEL untouched"
    );

    // Verify dev-dry.bat
    const dryBat = readFileSync(join(root, "bin", "dev-dry.bat"), "utf8");
    assert(
      dryBat.includes('set "ANTHROPIC_MODEL=deepseek/deepseek-v4-pro"'),
      "dev-dry.bat has new lead model"
    );

    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 2: write lead for plan does NOT touch NATIVE branch ----
  {
    const root = buildFixture();
    const result = writeSquadConfig(
      { squads: { plan: { lead: "z-ai/glm-5.2" } } },
      root
    );
    assert(
      result.changed.length >= 1,
      "write plan lead changes at least 1 file"
    );

    const planBat = readFileSync(join(root, "bin", "plan.bat"), "utf8");
    // NATIVE branch must stay unchanged
    assert(
      planBat.includes('set "ANTHROPIC_MODEL=claude-opus-4-8"'),
      "plan.bat NATIVE branch untouched"
    );
    // else branch must be updated
    assert(
      planBat.includes('set "ANTHROPIC_MODEL=z-ai/glm-5.2"'),
      "plan.bat else branch updated"
    );

    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 3: write agent model (string patch) preserves rest of frontmatter ----
  {
    const root = buildFixture();
    const result = writeSquadConfig(
      { squads: { dev: { agents: { implementer: "deepseek/deepseek-v4-pro" } } } },
      root
    );
    assert(
      result.changed.length === 1,
      "write agent model changes 1 file"
    );
    assertEq(
      result.changed[0].field,
      "model",
      "changed entry has field=model"
    );

    const md = readFileSync(
      join(root, "agents", "dev", "agents", "implementer.md"),
      "utf8"
    );
    assert(
      md.includes("model: deepseek/deepseek-v4-pro"),
      "implementer.md has new model"
    );
    assert(
      md.includes("name: implementer"),
      "implementer.md name field preserved"
    );
    assert(
      md.includes("description: DEV squad — implementacja"),
      "implementer.md description preserved"
    );
    assert(
      md.includes("tools: Read, Grep, Glob, Edit, Write, Bash"),
      "implementer.md tools preserved"
    );
    assert(
      md.includes("Jesteś sub-agentem IMPLEMENTER."),
      "implementer.md body preserved"
    );
    // LF preserved (no CR)
    assert(
      !md.includes("\r"),
      "implementer.md line endings are LF (not CRLF)"
    );

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

  // ---- Test 6: CRLF preserved in .bat files ----
  {
    const root = buildFixture();
    writeSquadConfig(
      { squads: { dev: { lead: "test/model-123" } } },
      root
    );
    const devBat = readFileSync(join(root, "bin", "dev.bat"), "utf8");
    assert(
      devBat.includes("\r\n"),
      "dev.bat preserves CRLF after write"
    );
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
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 8: dryRun does NOT modify files on disk ----
  {
    const root = buildFixture();
    const devBatBefore = readFileSync(join(root, "bin", "dev.bat"), "utf8");
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
    const devBatAfter = readFileSync(join(root, "bin", "dev.bat"), "utf8");
    const agentAfter = readFileSync(
      join(root, "agents", "dev", "agents", "implementer.md"),
      "utf8"
    );
    assertEq(devBatAfter, devBatBefore, "dryRun: dev.bat unchanged on disk");
    assertEq(agentAfter, agentBefore, "dryRun: implementer.md unchanged on disk");

    // But changed array should reflect what WOULD change
    assert(
      result.changed.length >= 3,
      "dryRun: changed array has expected entries"
    );
    assert(
      result.changed.some((c) => c.file.endsWith("dev.bat")),
      "dryRun: dev.bat in changed"
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
      { squads: { dev: { lead: "test/model-xyz" } } },
      root
    );
    assert(
      result.changed.length >= 1,
      "2-arg call: changes detected"
    );
    const devBat = readFileSync(join(root, "bin", "dev.bat"), "utf8");
    assert(
      devBat.includes('set "ANTHROPIC_MODEL=test/model-xyz"'),
      "2-arg call: dev.bat actually written"
    );
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
      3,
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

  // ---- Test 16: LA_PROVIDER line round-trip (insert/update/remove) ----
  {
    const root = buildFixture();

    // Insert: assign dev to a custom provider
    const r1 = writeSquadConfig({ squads: { dev: { provider: "zai_anthropic" } } }, root);
    assert(
      r1.changed.length === 2,
      "provider insert changes 2 files (dev.bat + dev-dry.bat)"
    );

    const devBat = readFileSync(join(root, "bin", "dev.bat"), "utf8");
    assert(
      devBat.includes('set "LA_PROVIDER=zai_anthropic"'),
      "dev.bat has LA_PROVIDER line"
    );
    assert(
      devBat.includes("\r\n"),
      "dev.bat preserves CRLF after provider insert"
    );
    // Line must sit immediately before the _lib.bat call
    const devLines = devBat.split("\r\n");
    const callIdx = devLines.findIndex((l) => l.includes('call "%~dp0_lib.bat"'));
    assert(
      callIdx > 0 && devLines[callIdx - 1].includes('set "LA_PROVIDER=zai_anthropic"'),
      "LA_PROVIDER line is immediately before the _lib.bat call"
    );

    const devDryBat = readFileSync(join(root, "bin", "dev-dry.bat"), "utf8");
    assert(
      devDryBat.includes('set "LA_PROVIDER=zai_anthropic"'),
      "dev-dry.bat has LA_PROVIDER line"
    );

    // Update: switch to a different custom provider
    writeSquadConfig({ squads: { dev: { provider: "anthropic" } } }, root);
    const devBat2 = readFileSync(join(root, "bin", "dev.bat"), "utf8");
    assert(
      devBat2.includes('set "LA_PROVIDER=anthropic"'),
      "dev.bat LA_PROVIDER updated to anthropic"
    );
    assert(
      !devBat2.includes('set "LA_PROVIDER=zai_anthropic"'),
      "old LA_PROVIDER value removed"
    );

    // Remove: back to openrouter = line removed
    writeSquadConfig({ squads: { dev: { provider: "openrouter" } } }, root);
    const devBat3 = readFileSync(join(root, "bin", "dev.bat"), "utf8");
    assert(
      !devBat3.includes("LA_PROVIDER"),
      "openrouter = no LA_PROVIDER line (removed)"
    );
    const configAfter = readSquadConfig(root);
    assertEq(
      configAfter.squads.dev.provider,
      "openrouter",
      "readSquadConfig reports openrouter after line removal"
    );

    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 17: openrouter provider write leaves untouched bats byte-identical ----
  {
    const root = buildFixture();
    const devBefore = readFileSync(join(root, "bin", "dev.bat"), "utf8");
    const dryBefore = readFileSync(join(root, "bin", "dev-dry.bat"), "utf8");

    const r = writeSquadConfig({ squads: { dev: { provider: "openrouter" } } }, root);
    assert(
      r.changed.length === 0,
      "openrouter write reports no changes"
    );

    const devAfter = readFileSync(join(root, "bin", "dev.bat"), "utf8");
    const dryAfter = readFileSync(join(root, "bin", "dev-dry.bat"), "utf8");
    assertEq(devAfter, devBefore, "dev.bat byte-identical (openrouter = no line)");
    assertEq(dryAfter, dryBefore, "dev-dry.bat byte-identical (openrouter = no line)");
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
    // Create a custom provider, assign dev to it, then try to delete it.
    writeSquadConfig(
      { providers: { zai_anthropic: { baseUrl: "https://api.z.ai/api/anthropic", authEnv: "ZAI_API_KEY", authStyle: "token" } } },
      root
    );
    writeSquadConfig({ squads: { dev: { provider: "zai_anthropic" } } }, root);

    const current = readSquadConfig(root);
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
  await runTests();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
