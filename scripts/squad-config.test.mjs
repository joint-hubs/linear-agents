// Tests for squad-config.mjs — run with: node scripts/_test_squad-config.mjs
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
    '@echo off\r\nsetlocal\r\nset "ANTHROPIC_MODEL=z-ai/glm-5.2"\r\nset "ANTHROPIC_SMALL_FAST_MODEL=minimax/minimax-m3"\r\nclaude %*\r\nendlocal\r\n',
    "utf8"
  );

  // bin/dev-dry.bat (CRLF)
  writeFileSync(
    join(root, "bin", "dev-dry.bat"),
    '@echo off\r\nsetlocal\r\nset "ANTHROPIC_MODEL=z-ai/glm-5.2"\r\nset "DEV_DRY_RUN=1"\r\nclaude -p "dry" %*\r\nendlocal\r\n',
    "utf8"
  );

  // bin/plan.bat (CRLF, with NATIVE/else split)
  writeFileSync(
    join(root, "bin", "plan.bat"),
    '@echo off\r\nsetlocal\r\nif defined NATIVE (\r\n    set "ANTHROPIC_MODEL=claude-opus-4-8"\r\n) else (\r\n    set "ANTHROPIC_MODEL=anthropic/claude-opus-4.8"\r\n)\r\nclaude %*\r\nendlocal\r\n',
    "utf8"
  );

  // bin/plan-dry.bat (CRLF, no NATIVE split — just the OpenRouter model)
  writeFileSync(
    join(root, "bin", "plan-dry.bat"),
    '@echo off\r\nsetlocal\r\nset "ANTHROPIC_MODEL=anthropic/claude-opus-4.8"\r\nset "PLAN_DRY_RUN=1"\r\nclaude -p "dry" %*\r\nendlocal\r\n',
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
    '    "openrouter": "https://openrouter.ai/api/v1"\r\n' +
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
    '    "z-ai/glm-5.2": { "input": 1.40, "output": 4.40 },\r\n' +
    '    "minimax/minimax-m3": { "input": 0.30, "output": 1.20 }\r\n' +
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
  const { readSquadConfig, readToolCatalog, validateSlug, validateTools, writeSquadConfig } = await import(
    MODULE_PATH
  );

  // ---- Test 1: read lead model from simple .bat ----
  {
    const root = buildFixture();
    const config = readSquadConfig(root);
    assertEq(config.squads.dev.lead, "z-ai/glm-5.2", "read lead from dev.bat");
    assert(
      config.squads.dev.leadFiles.includes("bin/dev.bat"),
      "leadFiles includes dev.bat"
    );
    assert(
      config.squads.dev.leadFiles.includes("bin/dev-dry.bat"),
      "leadFiles includes dev-dry.bat"
    );
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 2: read lead from plan.bat (NATIVE/else split) ----
  {
    const root = buildFixture();
    const config = readSquadConfig(root);
    assertEq(
      config.squads.plan.lead,
      "anthropic/claude-opus-4.8",
      "read lead from plan.bat (else branch, not NATIVE)"
    );
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 3: read subagent configs (model + tools), skip plugins/ ----
  {
    const root = buildFixture();
    const config = readSquadConfig(root);
    assertEq(
      config.squads.dev.agents.implementer.model,
      "z-ai/glm-5.2",
      "read implementer model"
    );
    assert(
      Array.isArray(config.squads.dev.agents.implementer.tools),
      "read implementer tools is array"
    );
    assert(
      config.squads.dev.agents.implementer.tools.includes("Read"),
      "read implementer tools includes Read"
    );
    assertEq(
      config.squads.dev.agents.recon.model,
      "minimax/minimax-m3",
      "read recon model"
    );
    assert(
      config.squads.dev.agents.recon.tools.includes("Bash"),
      "read recon tools includes Bash"
    );
    // plugins/ignored.md should NOT appear
    assert(
      config.squads.dev.agents.ignored === undefined,
      "plugins/ agents are NOT included"
    );
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 4: read pricing ----
  {
    const root = buildFixture();
    const config = readSquadConfig(root);
    assert(
      config.pricing["z-ai/glm-5.2"] !== undefined,
      "pricing has glm entry"
    );
    assertEq(
      config.pricing["z-ai/glm-5.2"].input,
      1.40,
      "pricing glm input"
    );
    assertEq(
      config.pricing["minimax/minimax-m3"].output,
      1.20,
      "pricing minimax output"
    );
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 5: write lead updates BOTH .bat files ----
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

  // ---- Test 6: write lead for plan does NOT touch NATIVE branch ----
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

  // ---- Test 7: write agent model (string patch) preserves rest of frontmatter ----
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

  // ---- Test 8: merge pricing ----
  {
    const root = buildFixture();
    const result = writeSquadConfig(
      {
        pricing: {
          "z-ai/glm-5.2": { input: 1.50, output: 5.00 },
          "new/model": { input: 0.10, output: 0.20 },
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
      config.pricing["z-ai/glm-5.2"].input,
      1.50,
      "pricing glm input updated"
    );
    assertEq(
      config.pricing["z-ai/glm-5.2"].output,
      5.00,
      "pricing glm output updated"
    );
    assertEq(
      config.pricing["new/model"].input,
      0.10,
      "pricing new model added"
    );
    // Existing entry untouched
    assertEq(
      config.pricing["minimax/minimax-m3"].input,
      0.30,
      "pricing minimax untouched"
    );

    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 9: validateSlug ----
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

  // ---- Test 10: CRLF preserved in .bat files ----
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

  // ---- Test 11: writeSquadConfig warnings for missing files ----
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

  // ---- Test 12: readSquadConfig handles missing dry-run bat ----
  {
    const root = buildFixture();
    // test squad has no .bat files in fixture
    const config = readSquadConfig(root);
    // test squad should exist but with null lead and empty leadFiles
    assert(
      config.squads.test !== undefined,
      "test squad exists in config"
    );
    assertEq(
      config.squads.test.lead,
      null,
      "test squad lead is null (no .bat file)"
    );
    assert(
      config.squads.test.leadFiles.length === 0,
      "test squad has empty leadFiles"
    );
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 13: dryRun does NOT modify files on disk ----
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
        pricing: { "z-ai/glm-5.2": { input: 9.99, output: 9.99 } },
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

  // ---- Test 14: dryRun returns identical changed as real write ----
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
      pricing: { "z-ai/glm-5.2": { input: 9.99, output: 9.99 } },
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

  // ---- Test 15: two-argument call still writes (backward compat) ----
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

  // ---- Test 16: readSquadConfig does NOT return _doc in pricing ----
  {
    const root = buildFixture();
    const config = readSquadConfig(root);
    assert(
      config.pricing["_doc"] === undefined,
      "readSquadConfig: _doc key is absent from pricing"
    );
    assert(
      config.pricing["z-ai/glm-5.2"] !== undefined,
      "readSquadConfig: real pricing entries still present"
    );
    assertEq(
      config.pricing["z-ai/glm-5.2"].input,
      1.40,
      "readSquadConfig: glm input correct"
    );
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 17: writeSquadConfig preserves _doc in models.json ----
  {
    const root = buildFixture();
    writeSquadConfig(
      { pricing: { "z-ai/glm-5.2": { input: 9.99, output: 9.99 } } },
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
      data.pricing["z-ai/glm-5.2"].input,
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

  // ---- Test 18: writeSquadConfig silently ignores _doc in patch ----
  {
    const root = buildFixture();
    const result = writeSquadConfig(
      {
        pricing: {
          "_doc": "malicious overwrite attempt",
          "z-ai/glm-5.2": { input: 5.00, output: 10.00 },
        },
      },
      root
    );
    // Should have changed only the real entry, not _doc
    assert(
      result.changed.length === 1,
      "writeSquadConfig: _doc in patch ignored, only 1 real change"
    );
    const raw = readFileSync(join(root, "config", "models.json"), "utf8");
    const data = JSON.parse(raw);
    assertEq(
      data.pricing["_doc"],
      "USD per 1M tokens (input/output)",
      "writeSquadConfig: _doc NOT overwritten by patch"
    );
    assertEq(
      data.pricing["z-ai/glm-5.2"].input,
      5.00,
      "writeSquadConfig: real pricing still updated"
    );
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 19: writeSquadConfig preserves ids/routing/providers/fallback ----
  {
    const root = buildFixture();
    writeSquadConfig(
      { pricing: { "new/model": { input: 0.10, output: 0.20 } } },
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
      data.fallback && data.fallback.glm !== undefined,
      "writeSquadConfig: fallback preserved"
    );
    assert(
      data.pricing["new/model"] !== undefined,
      "writeSquadConfig: new pricing entry added"
    );
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 20: readToolCatalog returns tools and riskLevels, skips _doc ----
  {
    const root = buildFixture();
    const catalog = readToolCatalog(root);
    assert(
      Object.keys(catalog.tools).length >= 7,
      "readToolCatalog: has tools"
    );
    assertEq(
      catalog.tools["_doc"],
      undefined,
      "readToolCatalog: _doc key is absent from tools"
    );
    assert(
      catalog.tools.Read !== undefined,
      "readToolCatalog: Read tool present"
    );
    assertEq(
      catalog.tools.Read.risk,
      "safe",
      "readToolCatalog: Read risk is safe"
    );
    assert(
      Object.keys(catalog.riskLevels).length >= 4,
      "readToolCatalog: has riskLevels"
    );
    assert(
      catalog.riskLevels.safe !== undefined,
      "readToolCatalog: safe risk level present"
    );
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 21: readToolCatalog with broken file returns empty catalog ----
  {
    const root = buildFixture();
    // Corrupt the file
    writeFileSync(join(root, "config", "tools.json"), "not valid json {{{", "utf8");
    const catalog = readToolCatalog(root);
    assertEq(
      Object.keys(catalog.tools).length,
      0,
      "readToolCatalog: broken file → empty tools"
    );
    assertEq(
      Object.keys(catalog.riskLevels).length,
      0,
      "readToolCatalog: broken file → empty riskLevels"
    );
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 22: readToolCatalog with missing file returns empty catalog ----
  {
    const root = buildFixture();
    rmSync(join(root, "config", "tools.json"));
    const catalog = readToolCatalog(root);
    assertEq(
      Object.keys(catalog.tools).length,
      0,
      "readToolCatalog: missing file → empty tools"
    );
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 23: write tools changes ONLY the tools line ----
  {
    const root = buildFixture();
    const result = writeSquadConfig(
      {
        squads: {
          dev: {
            agents: { implementer: { tools: ["Read", "Bash"] } },
          },
        },
      },
      root
    );
    assert(
      result.changed.length === 1,
      "write tools changes 1 file"
    );
    assertEq(
      result.changed[0].field,
      "tools",
      "changed entry has field=tools"
    );

    const md = readFileSync(
      join(root, "agents", "dev", "agents", "implementer.md"),
      "utf8"
    );
    assert(
      md.includes("tools: Read, Bash"),
      "implementer.md has new tools line"
    );
    assert(
      md.includes("name: implementer"),
      "implementer.md name preserved"
    );
    assert(
      md.includes("model: z-ai/glm-5.2"),
      "implementer.md model preserved"
    );
    assert(
      md.includes("Jesteś sub-agentem IMPLEMENTER."),
      "implementer.md body preserved"
    );
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 24: write tools preserves CRLF ----
  {
    const root = buildFixture();
    // Create a CRLF agent file
    writeFileSync(
      join(root, "agents", "dev", "agents", "crlf-agent.md"),
      "---\r\nname: crlf-agent\r\nmodel: test/model\r\ntools: Read, Grep\r\n---\r\nBody.\r\n",
      "utf8"
    );
    writeSquadConfig(
      {
        squads: {
          dev: {
            agents: { "crlf-agent": { tools: ["Read", "Bash", "Glob"] } },
          },
        },
      },
      root
    );
    const md = readFileSync(
      join(root, "agents", "dev", "agents", "crlf-agent.md"),
      "utf8"
    );
    assert(
      md.includes("\r\n"),
      "CRLF preserved after tools write"
    );
    assert(
      md.includes("tools: Read, Bash, Glob\r\n"),
      "tools line has correct format with CRLF"
    );
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 25: role without tools line → line inserted after model ----
  {
    const root = buildFixture();
    const result = writeSquadConfig(
      {
        squads: {
          dev: {
            agents: { notool: { tools: ["Read", "Glob"] } },
          },
        },
      },
      root
    );
    assert(
      result.changed.length === 1,
      "write tools for notool changes 1 file"
    );

    const md = readFileSync(
      join(root, "agents", "dev", "agents", "notool.md"),
      "utf8"
    );
    assert(
      md.includes("tools: Read, Glob"),
      "notool.md now has tools line"
    );
    // Verify tools line is after model line
    const lines = md.split("\n");
    const modelIdx = lines.findIndex((l) => l.startsWith("model:"));
    const toolsIdx = lines.findIndex((l) => l.startsWith("tools:"));
    assert(
      toolsIdx === modelIdx + 1,
      "tools line inserted directly after model line"
    );
    assert(
      md.includes("name: notool"),
      "notool.md name preserved"
    );
    assert(
      md.includes("Jesteś sub-agentem BEZ NARZĘDZI."),
      "notool.md body preserved"
    );
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 26: string patch still changes model (backward compat) ----
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

  // ---- Test 27: object patch with both model and tools changes both ----
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

  // ---- Test 28: dryRun for tools does NOT write file ----
  {
    const root = buildFixture();
    const agentBefore = readFileSync(
      join(root, "agents", "dev", "agents", "implementer.md"),
      "utf8"
    );

    const result = writeSquadConfig(
      {
        squads: {
          dev: {
            agents: { implementer: { tools: ["Read", "Bash"] } },
          },
        },
      },
      root,
      { dryRun: true }
    );

    const agentAfter = readFileSync(
      join(root, "agents", "dev", "agents", "implementer.md"),
      "utf8"
    );
    assertEq(agentAfter, agentBefore, "dryRun tools: implementer.md unchanged on disk");
    assert(
      result.changed.length === 1,
      "dryRun tools: changed has 1 entry"
    );
    assertEq(
      result.changed[0].field,
      "tools",
      "dryRun tools: field=tools"
    );
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 29: validateTools — empty/not-array → ok=false ----
  {
    const root = buildFixture();
    const catalog = readToolCatalog(root);

    const r1 = validateTools([], catalog);
    assertEq(r1.ok, false, "validateTools: empty array → ok=false");

    const r2 = validateTools(null, catalog);
    assertEq(r2.ok, false, "validateTools: null → ok=false");

    const r3 = validateTools("not array", catalog);
    assertEq(r3.ok, false, "validateTools: string → ok=false");

    const r4 = validateTools(["Read", ""], catalog);
    assertEq(r4.ok, false, "validateTools: empty string in array → ok=false");

    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 30: validateTools — unknown tool → warning, ok=true ----
  {
    const root = buildFixture();
    const catalog = readToolCatalog(root);

    const r = validateTools(["Read", "NonExistentTool"], catalog);
    assertEq(r.ok, true, "validateTools: unknown tool → ok=true (non-blocking)");
    assert(
      r.unknown.includes("NonExistentTool"),
      "validateTools: unknown tool listed"
    );
    assert(
      r.warnings.length >= 1,
      "validateTools: warning generated for unknown tool"
    );

    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 31: validateTools — Task → architecture warning ----
  {
    const root = buildFixture();
    const catalog = readToolCatalog(root);

    const r = validateTools(["Read", "Task"], catalog);
    assertEq(r.ok, true, "validateTools: Task → ok=true");
    assert(
      r.warnings.some((w) => w.includes("zagnieżdżoną delegację")),
      "validateTools: Task triggers architecture warning"
    );

    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 32: validateTools — all known tools → clean ----
  {
    const root = buildFixture();
    const catalog = readToolCatalog(root);

    const r = validateTools(["Read", "Grep", "Bash"], catalog);
    assertEq(r.ok, true, "validateTools: all known → ok=true");
    assertEq(r.unknown.length, 0, "validateTools: no unknown tools");
    assertEq(r.warnings.length, 0, "validateTools: no warnings");

    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  console.log("squad-config tests\n");
  await runTests();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
