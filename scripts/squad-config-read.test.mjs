// Tests for squad-config.mjs — reading configuration — leads from the routing
// sources (overlay > models.json routing > provider default, exactly what the
// Node entry point resolves), the provider through resolveProvider, subagents,
// pricing, missing files, no _doc leak.
//
// FOC-771: the .bat launchers are two-line wrappers carrying no ANTHROPIC_MODEL
// lines, so nothing here reads bin/*.bat — a "lead" read from a wrapper would
// be a lie by construction (FOC-170's class of drift, relocated).
//
// All tests operate on fixtures in a temp directory, NEVER on real repo files.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
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

// Env keys the fixtures and assertions depend on — snapshotted and restored so
// a host shell's LA_PROVIDER / SUPERVISOR_MODEL cannot decide a fixture's
// answer one run and not the next.
const ENV_KEYS = ["LA_SETTINGS_FILE", "LA_PROVIDER", "LA_PROVIDER_RESOLVED", "LA_PROVIDER_SOURCE", "SUPERVISOR_MODEL"];
const envBackup = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
for (const k of ENV_KEYS) delete process.env[k];

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

  // agents/dev/agents/notool.md (LF, no tools line)
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

  writeModelsConfig(root, {
    providers: {
      openrouter: {
        baseUrl: "https://openrouter.ai/api",
        authEnv: "OPENROUTER_API_KEY",
        authStyle: "token",
        defaultModel: "xiaomi/mimo-v2.6-pro",
      },
      zai_anthropic: {
        baseUrl: "https://api.z.ai/api/anthropic",
        authEnv: "ZAI_API_KEY",
        authStyle: "token",
        defaultModel: "glm-5.3",
      },
    },
    ids: {
      glm: "z-ai/glm-5.2",
      minimax: "minimax/minimax-m3",
    },
    routing: {
      dev: { implement: "glm", worker: "glm" },
    },
    pricing: {
      _doc: "USD per 1M tokens (input/output)",
      openrouter: {
        _note: "model-level metadata",
        "z-ai/glm-5.2": { input: 1.4, output: 4.4 },
        "minimax/minimax-m3": { input: 0.3, output: 1.2 },
        "deepseek/deepseek-v4-pro": { input: 1.6, output: 3.2 },
        "xiaomi/mimo-v2.6-pro": { input: 0.435, output: 0.87 },
      },
    },
  });

  return root;
}

function writeModelsConfig(root, data) {
  writeFileSync(join(root, "config", "models.json"), JSON.stringify(data, null, 2) + "\n", "utf8");
}

// The overlay the library reads for a custom (fixture) root lives at
// <root>/.fenix/config/settings.json — join() so the label assertions stay
// OS-independent.
const overlayPath = (root) => join(root, ".fenix", "config", "settings.json");

function writeOverlay(root, obj) {
  const p = overlayPath(root);
  mkdirSync(dirname(p), { recursive: true });
  if (obj === null) {
    rmSync(p, { force: true });
    return;
  }
  writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function runTests() {
  const { readSquadConfig } = await import(MODULE_PATH);
  const { relative } = await import("node:path");

  // ---- Test 1: read lead from the routing table (worker alias → ids) ----
  {
    const root = buildFixture();
    const config = readSquadConfig(root);
    assertEq(config.squads.dev.lead, "z-ai/glm-5.2", "read lead from routing.dev (worker → ids)");
    assertEq(config.squads.dev.leadSource, "routing:dev", "dev lead source is routing:dev");
    assertEq(
      config.squads.dev.leadFiles,
      ["config/models.json"],
      "dev leadFiles name config/models.json (no .bat paths)"
    );
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 2: the settings overlay outranks the routing table ----
  {
    const root = buildFixture();
    writeOverlay(root, { routing: { dev: { lead: "deepseek/deepseek-v4-pro" } } });
    const config = readSquadConfig(root);
    assertEq(
      config.squads.dev.lead,
      "deepseek/deepseek-v4-pro",
      "overlay routing.dev.lead wins over the routing table"
    );
    assertEq(
      config.squads.dev.leadSource,
      "settings:routing.dev",
      "dev lead source is settings:routing.dev"
    );
    assertEq(
      config.squads.dev.leadFiles,
      [relative(root, overlayPath(root))],
      "dev leadFiles name the overlay file"
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
      config.pricing.openrouter !== undefined,
      "pricing has openrouter scope"
    );
    assert(
      config.pricing.openrouter["z-ai/glm-5.2"] !== undefined,
      "pricing has glm entry under openrouter"
    );
    assertEq(
      config.pricing.openrouter["z-ai/glm-5.2"].input,
      1.4,
      "pricing glm input"
    );
    assertEq(
      config.pricing.openrouter["minimax/minimax-m3"].output,
      1.2,
      "pricing minimax output"
    );
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 5: a squad with no routing entry resolves the provider default ----
  {
    const root = buildFixture();
    const config = readSquadConfig(root);
    // test squad exists via the base floor and has no routing entry
    assert(
      config.squads.test !== undefined,
      "test squad exists in config"
    );
    assertEq(
      config.squads.test.lead,
      "xiaomi/mimo-v2.6-pro",
      "test squad lead falls back to the provider's defaultModel"
    );
    assertEq(config.squads.test.leadSource, "default", "test squad lead source is default");
    assertEq(
      config.squads.test.leadFiles,
      ["config/models.json"],
      "test squad leadFiles name config/models.json"
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
      config.pricing.openrouter["_note"] === undefined,
      "readSquadConfig: _note key is absent from pricing.openrouter"
    );
    assert(
      config.pricing.openrouter["z-ai/glm-5.2"] !== undefined,
      "readSquadConfig: real pricing entries still present"
    );
    assertEq(
      config.pricing.openrouter["z-ai/glm-5.2"].input,
      1.4,
      "readSquadConfig: glm input correct"
    );
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 7: readSquadConfig exposes the providers map ----
  {
    const root = buildFixture();
    const config = readSquadConfig(root);
    assert(
      config.providers !== undefined,
      "readSquadConfig: providers map present"
    );
    assert(
      config.providers.openrouter !== undefined,
      "readSquadConfig: openrouter provider present"
    );
    assertEq(
      config.providers.openrouter.baseUrl,
      "https://openrouter.ai/api",
      "readSquadConfig: openrouter baseUrl"
    );
    assertEq(
      config.providers.openrouter.authEnv,
      "OPENROUTER_API_KEY",
      "readSquadConfig: openrouter authEnv"
    );
    assertEq(
      config.providers.openrouter.authStyle,
      "token",
      "readSquadConfig: openrouter authStyle"
    );
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 8: the provider comes from resolveProvider, shared by every squad ----
  {
    const root = buildFixture();
    // No explicit provider anywhere → the openrouter default
    let config = readSquadConfig(root);
    assertEq(config.squads.dev.provider, "openrouter", "dev provider defaults to openrouter");
    assertEq(config.squads.plan.provider, "openrouter", "plan provider defaults to openrouter");

    // LA_PROVIDER env wins — resolveProvider's documented precedence, and the
    // same override the launchers run under. Every squad reports the SAME
    // provider: a per-squad LA_PROVIDER line no longer exists (FOC-771).
    process.env.LA_PROVIDER = "zai_anthropic";
    try {
      config = readSquadConfig(root);
      assertEq(config.squads.dev.provider, "zai_anthropic", "dev provider via LA_PROVIDER env");
      assertEq(config.squads.plan.provider, "zai_anthropic", "plan provider via LA_PROVIDER env");
    } finally {
      delete process.env.LA_PROVIDER;
    }

    // The settings overlay's provider.active wins over nothing-explicit.
    writeOverlay(root, { provider: { active: "zai_anthropic", custom: null } });
    config = readSquadConfig(root);
    assertEq(config.squads.dev.provider, "zai_anthropic", "dev provider via provider.active");
    assertEq(config.squads.plan.provider, "zai_anthropic", "plan provider via provider.active");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 9: the supervisor chain — env > routing.supervisor > fallback ----
  {
    const root = buildFixture();

    // No env; routing.supervisor exists but names no role → the built-in
    // fallback (the squad is visible because the routing key exists, but the
    // table resolves no model for it).
    const models0 = JSON.parse(readFileSync(join(root, "config", "models.json"), "utf8"));
    models0.routing.supervisor = {};
    writeModelsConfig(root, models0);
    let config = readSquadConfig(root);
    assertEq(
      config.squads.supervisor.lead,
      "x-ai/grok-4.7",
      "supervisor falls back to x-ai/grok-4.7"
    );
    assertEq(config.squads.supervisor.leadSource, "fallback", "supervisor fallback source");
    assertEq(config.squads.supervisor.leadFiles, [], "supervisor fallback names no file");

    // routing.supervisor.default is the CHILDREN's alias — the frontman's lead
    // must NOT come from it (FOC-771): no env, no overlay lead → the fallback.
    const models = JSON.parse(readFileSync(join(root, "config", "models.json"), "utf8"));
    models.routing.supervisor = { default: "glm", worker: "minimax" };
    writeModelsConfig(root, models);
    config = readSquadConfig(root);
    assertEq(config.squads.supervisor.lead, "x-ai/grok-4.7", "supervisor ignores routing.supervisor.default (children's alias)");
    assertEq(config.squads.supervisor.leadSource, "fallback", "supervisor stays on fallback with only the table's default");
    assertEq(config.squads.supervisor.leadFiles, [], "supervisor fallback names no file");

    // The overlay's routing.supervisor.lead beats the routing table
    writeOverlay(root, { routing: { supervisor: { lead: "deepseek/deepseek-v4-pro" } } });
    config = readSquadConfig(root);
    assertEq(
      config.squads.supervisor.lead,
      "deepseek/deepseek-v4-pro",
      "overlay routing.supervisor.lead wins"
    );
    assertEq(
      config.squads.supervisor.leadSource,
      "settings:routing.supervisor",
      "supervisor overlay source"
    );

    // SUPERVISOR_MODEL env beats everything (the launcher's chain)
    process.env.SUPERVISOR_MODEL = "  openai/gpt-999  ";
    try {
      config = readSquadConfig(root);
      assertEq(config.squads.supervisor.lead, "openai/gpt-999", "SUPERVISOR_MODEL env wins, trimmed");
      assertEq(config.squads.supervisor.leadSource, "env:SUPERVISOR_MODEL", "supervisor env source");
    } finally {
      delete process.env.SUPERVISOR_MODEL;
    }
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 10: a broken settings overlay degrades loudly instead of throwing ----
  {
    const root = buildFixture();
    writeOverlay(root, { routing: { dev: { lead: "deepseek/deepseek-v4-pro" } } });
    writeFileSync(overlayPath(root), "{ not json", "utf8");
    const config = readSquadConfig(root); // must not throw
    assertEq(
      config.squads.dev.lead,
      "z-ai/glm-5.2",
      "broken overlay: dev falls back to the routing table"
    );
    assertEq(
      config.squads.dev.provider,
      "openrouter",
      "broken overlay: provider falls back to the default"
    );
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 11: the dashboard-facing squad shape is additive (keys pinned) ----
  {
    const root = buildFixture();
    const config = readSquadConfig(root);
    assertEq(
      Object.keys(config.squads.dev).slice().sort().join(","),
      "agents,lead,leadFiles,leadSource,provider",
      "squad entry keys: lead/provider/leadFiles shape kept, leadSource added"
    );
    assertEq(
      Object.keys(config).slice().sort().join(","),
      "pricing,providers,squads",
      "top-level keys are exactly squads+pricing+providers"
    );
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  console.log("squad-config-read tests\n");
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