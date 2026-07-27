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

  // agents/dev/plugins/foo/agents/ignored.md — should be IGNORED
  mkdirSync(join(root, "agents", "dev", "plugins", "foo", "agents"), {
    recursive: true,
  });
  writeFileSync(
    join(root, "agents", "dev", "plugins", "foo", "agents", "ignored.md"),
    "---\nname: ignored\nmodel: openai/gpt-999\n---\nShould be ignored.\n",
    "utf8"
  );

  // config/models.json (CRLF) — includes _doc metadata in pricing and
  // top-level keys (ids, routing, providers, fallback) that must survive writes.
  mkdirSync(join(root, "config"), { recursive: true });
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
  const { readSquadConfig, validateSlug, writeSquadConfig } = await import(
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

  // ---- Test 3: read subagent models, skip plugins/ ----
  {
    const root = buildFixture();
    const config = readSquadConfig(root);
    assertEq(
      config.squads.dev.agents.implementer,
      "z-ai/glm-5.2",
      "read implementer model"
    );
    assertEq(
      config.squads.dev.agents.recon,
      "minimax/minimax-m3",
      "read recon model"
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

  // ---- Test 7: write agent model preserves rest of frontmatter ----
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
            agents: { implementer: "some/other-model" },
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
          agents: { implementer: "some/other-model" },
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
        dryResult.changed[i].before,
        realResult.changed[i].before,
        `dryRun vs real: same before [${i}]`
      );
      assertEq(
        dryResult.changed[i].after,
        realResult.changed[i].after,
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
