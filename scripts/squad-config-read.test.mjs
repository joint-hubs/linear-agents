// Tests for squad-config.mjs — reading configuration — leads, subagents, pricing, missing files, no _doc leak.
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

  // ---- Test 5: readSquadConfig handles missing dry-run bat ----
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

  // ---- Test 6: readSquadConfig does NOT return _doc in pricing ----
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
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  console.log("squad-config-read tests\n");
  await runTests();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
