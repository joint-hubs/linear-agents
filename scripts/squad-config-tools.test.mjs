// Tests for squad-config.mjs — tool catalog + per-role tool writes + validateTools.
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

  // ---- Test 1: readToolCatalog returns tools and riskLevels, skips _doc ----
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

  // ---- Test 2: readToolCatalog with broken file returns empty catalog ----
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

  // ---- Test 3: readToolCatalog with missing file returns empty catalog ----
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

  // ---- Test 4: write tools changes ONLY the tools line ----
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

  // ---- Test 5: write tools preserves CRLF ----
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

  // ---- Test 6: role without tools line → line inserted after model ----
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

  // ---- Test 7: dryRun for tools does NOT write file ----
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

  // ---- Test 8: validateTools — empty/not-array → ok=false ----
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

  // ---- Test 9: validateTools — unknown tool → warning, ok=true ----
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

  // ---- Test 10: validateTools — Task → architecture warning ----
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

  // ---- Test 11: validateTools — all known tools → clean ----
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
  console.log("squad-config-tools tests\n");
  await runTests();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
