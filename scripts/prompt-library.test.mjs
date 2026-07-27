// Tests for prompt-library.mjs — run with: node scripts/prompt-library.test.mjs
//
// All tests operate on fixtures in a temp directory, NEVER on real repo files.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MODULE_PATH = pathToFileURL(join(__dirname, "prompt-library.mjs")).href;

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
  const root = mkdtempSync(join(tmpdir(), "prompt-library-test-"));

  // bin/dev.bat (needed by squad-config)
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(
    join(root, "bin", "dev.bat"),
    '@echo off\r\nsetlocal\r\nset "ANTHROPIC_MODEL=z-ai/glm-5.2"\r\nclaude %*\r\nendlocal\r\n',
    "utf8"
  );

  // bin/plan.bat
  writeFileSync(
    join(root, "bin", "plan.bat"),
    '@echo off\r\nsetlocal\r\nif defined NATIVE (\r\n    set "ANTHROPIC_MODEL=claude-opus-4-8"\r\n) else (\r\n    set "ANTHROPIC_MODEL=anthropic/claude-opus-4.8"\r\n)\r\nclaude %*\r\nendlocal\r\n',
    "utf8"
  );

  // bin/review.bat
  writeFileSync(
    join(root, "bin", "review.bat"),
    '@echo off\r\nsetlocal\r\nset "ANTHROPIC_MODEL=z-ai/glm-5.2"\r\nclaude %*\r\nendlocal\r\n',
    "utf8"
  );

  // bin/test.bat
  writeFileSync(
    join(root, "bin", "test.bat"),
    '@echo off\r\nsetlocal\r\nset "ANTHROPIC_MODEL=minimax/minimax-m3"\r\nclaude %*\r\nendlocal\r\n',
    "utf8"
  );

  // bin/cadence.bat
  writeFileSync(
    join(root, "bin", "cadence.bat"),
    '@echo off\r\nsetlocal\r\nset "ANTHROPIC_MODEL=minimax/minimax-m3"\r\nclaude %*\r\nendlocal\r\n',
    "utf8"
  );

  // agents/dev/agents/implementer.md
  mkdirSync(join(root, "agents", "dev", "agents"), { recursive: true });
  writeFileSync(
    join(root, "agents", "dev", "agents", "implementer.md"),
    "---\nname: implementer\ndescription: DEV squad — implementacja\nmodel: z-ai/glm-5.2\ntools: Read, Grep, Glob, Edit, Write, Bash\n---\nJesteś sub-agentem IMPLEMENTER.\n",
    "utf8"
  );

  // agents/dev/agents/recon.md
  writeFileSync(
    join(root, "agents", "dev", "agents", "recon.md"),
    "---\nname: recon\ndescription: DEV squad — recon\nmodel: minimax/minimax-m3\ntools: Read, Grep, Glob, Bash\n---\nJesteś sub-agentem RECON.\n",
    "utf8"
  );

  // agents/dev/CLAUDE.md
  writeFileSync(
    join(root, "agents", "dev", "CLAUDE.md"),
    "# Agent: DEV (squad lead)\n\nJesteś lead-orkiestratorem obszaru DEVELOPMENTU.\n",
    "utf8"
  );

  // agents/plan/agents/discovery.md
  mkdirSync(join(root, "agents", "plan", "agents"), { recursive: true });
  writeFileSync(
    join(root, "agents", "plan", "agents", "discovery.md"),
    "---\nname: discovery\nmodel: minimax/minimax-m3\ntools: Read, Grep, Glob, Write, Bash\n---\nJesteś sub-agentem DISCOVERY.\n",
    "utf8"
  );

  // agents/plan/CLAUDE.md
  writeFileSync(
    join(root, "agents", "plan", "CLAUDE.md"),
    "# Agent: PLAN (squad lead)\n\nJesteś lead-orkiestratorem obszaru PLANOWANIA.\n",
    "utf8"
  );

  // agents/dev/plugins/foo/agents/ignored.md — should be SKIPPED
  mkdirSync(join(root, "agents", "dev", "plugins", "foo", "agents"), {
    recursive: true,
  });
  writeFileSync(
    join(root, "agents", "dev", "plugins", "foo", "agents", "ignored.md"),
    "---\nname: ignored\nmodel: openai/gpt-999\ntools: Read\n---\nShould be ignored.\n",
    "utf8"
  );

  // config/models.json (needed by squad-config)
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(
    join(root, "config", "models.json"),
    JSON.stringify({
      pricing: {
        "z-ai/glm-5.2": { input: 1.40, output: 4.40 },
        "minimax/minimax-m3": { input: 0.30, output: 1.20 },
        "anthropic/claude-opus-4.8": { input: 15.00, output: 75.00 },
      },
    }),
    "utf8"
  );

  return root;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function runTests() {
  const { buildPromptTree, readRoleDoc, readLeadDoc } = await import(MODULE_PATH);

  // ---- Test 1: buildPromptTree returns intents ----
  {
    const root = buildFixture();
    const tree = buildPromptTree(root);
    assert(Array.isArray(tree.intents), "intents is an array");
    assertEq(tree.intents.length, 6, "6 intents");
    assertEq(tree.intents[0].id, "plan", "first intent is plan");
    assertEq(tree.intents[5].id, "single", "last intent is single");
    assertEq(tree.intents[5].squad, null, "single has squad null");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 2: buildPromptTree returns 5 squads ----
  {
    const root = buildFixture();
    const tree = buildPromptTree(root);
    const squadNames = Object.keys(tree.squads);
    assertEq(squadNames.length, 5, "5 squads");
    assert(squadNames.includes("dev"), "has dev");
    assert(squadNames.includes("plan"), "has plan");
    assert(squadNames.includes("review"), "has review");
    assert(squadNames.includes("test"), "has test");
    assert(squadNames.includes("cadence"), "has cadence");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 3: squad has kickoff, entryCondition, lead, roles, agentCmd ----
  {
    const root = buildFixture();
    const tree = buildPromptTree(root);
    const dev = tree.squads.dev;
    assertEq(dev.squad, "dev", "dev.squad");
    assert(Array.isArray(dev.kickoff) && dev.kickoff.length > 0, "dev.kickoff non-empty");
    assert(typeof dev.entryCondition === "string" && dev.entryCondition.length > 0, "dev.entryCondition non-empty");
    assert(dev.lead && typeof dev.lead.model === "string", "dev.lead.model is string");
    assertEq(dev.lead.model, "z-ai/glm-5.2", "dev lead model from squad-config");
    assert(Array.isArray(dev.roles) && dev.roles.length >= 2, "dev.roles has entries");
    assertEq(dev.agentCmd, "bin\\agent.bat dev <rola>", "dev.agentCmd");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 4: roles contain model and tools ----
  {
    const root = buildFixture();
    const tree = buildPromptTree(root);
    const impl = tree.squads.dev.roles.find((r) => r.role === "implementer");
    assert(impl !== undefined, "implementer role exists");
    assertEq(impl.model, "z-ai/glm-5.2", "implementer model");
    assert(Array.isArray(impl.tools) && impl.tools.length > 0, "implementer has tools");
    assert(impl.tools.includes("Read"), "implementer has Read tool");
    assert(impl.tools.includes("Bash"), "implementer has Bash tool");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 5: plugins/ agents are excluded ----
  {
    const root = buildFixture();
    const tree = buildPromptTree(root);
    const ignored = tree.squads.dev.roles.find((r) => r.role === "ignored");
    assert(ignored === undefined, "plugins/ignored.md is excluded");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 6: readRoleDoc returns model, tools, body ----
  {
    const root = buildFixture();
    const doc = readRoleDoc("dev", "implementer", root);
    assert(!doc.error, "no error");
    assertEq(doc.squad, "dev", "squad correct");
    assertEq(doc.role, "implementer", "role correct");
    assertEq(doc.model, "z-ai/glm-5.2", "model correct");
    assert(Array.isArray(doc.tools) && doc.tools.includes("Bash"), "tools correct");
    assert(doc.body.includes("Jesteś sub-agentem IMPLEMENTER"), "body has content");
    assert(!doc.body.includes("---"), "body does NOT contain frontmatter markers");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 7: readRoleDoc rejects bad squad ----
  {
    const root = buildFixture();
    const doc = readRoleDoc("evil", "implementer", root);
    assert(doc.error !== undefined, "bad squad returns error");
    assert(doc.error.includes("invalid squad"), "error mentions invalid squad");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 8: readRoleDoc rejects path traversal role ----
  {
    const root = buildFixture();
    const doc = readRoleDoc("dev", "../../etc/passwd", root);
    assert(doc.error !== undefined, "path traversal role returns error");
    assert(doc.error.includes("invalid role"), "error mentions invalid role");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 9: readRoleDoc rejects role with special chars ----
  {
    const root = buildFixture();
    const doc = readRoleDoc("dev", "role;rm -rf /", root);
    assert(doc.error !== undefined, "special chars role returns error");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 10: readRoleDoc not found ----
  {
    const root = buildFixture();
    const doc = readRoleDoc("dev", "nonexistent", root);
    assertEq(doc.error, "not found", "nonexistent role returns not found");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 11: readLeadDoc returns body ----
  {
    const root = buildFixture();
    const doc = readLeadDoc("dev", root);
    assert(!doc.error, "no error");
    assertEq(doc.squad, "dev", "squad correct");
    assert(doc.body.includes("DEV (squad lead)"), "body has content");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 12: readLeadDoc rejects bad squad ----
  {
    const root = buildFixture();
    const doc = readLeadDoc("evil", root);
    assert(doc.error !== undefined, "bad squad returns error");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 13: readLeadDoc not found ----
  {
    const root = buildFixture();
    const doc = readLeadDoc("test", root);
    assertEq(doc.error, "not found", "missing CLAUDE.md returns not found");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 14: entry conditions match HOW-TO §3 ----
  {
    const root = buildFixture();
    const tree = buildPromptTree(root);
    assert(tree.squads.plan.entryCondition.includes("Approved feature"), "plan entry condition");
    assert(tree.squads.dev.entryCondition.includes("dor-ok"), "dev entry condition");
    assert(tree.squads.review.entryCondition.includes("In Review"), "review entry condition");
    assert(tree.squads.test.entryCondition.includes("stage:testing"), "test entry condition");
    assert(tree.squads.cadence.entryCondition.includes("cotygodniowo"), "cadence entry condition");
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  console.log("prompt-library tests\n");
  await runTests();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
