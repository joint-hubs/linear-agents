// Tests for the context-tracing half of prompt-library.mjs —
// run with: node scripts/prompt-refs.test.mjs
//
// Covers extractRefs / resolvePromptRefs / listContextFiles / readContextFile.
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
// Fixture builder — a miniature repo with a known reference graph
// ---------------------------------------------------------------------------

function write(root, relPath, content) {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

function buildFixture() {
  const root = mkdtempSync(join(tmpdir(), "prompt-refs-test-"));

  // Launchers — squad-config reads these when the tree is built.
  for (const squad of ["plan", "dev", "review", "test", "cadence"]) {
    write(root, `bin/${squad}.bat`, '@echo off\r\nclaude %*\r\n');
  }
  write(root, "bin/agent.bat", '@echo off\r\nclaude %*\r\n');

  // DEV lead — references a doc, a script, a config, a state file,
  // a template glob and one file that does NOT exist.
  write(
    root,
    "agents/dev/CLAUDE.md",
    [
      "# Agent: DEV (squad lead)",
      "",
      "Spec: `docs/prd/prd-development.md`.",
      "Wołaj `node $LA_ROOT/scripts/linear-query.mjs issues`.",
      "Modele subagentów w `agents/dev/agents/*.md`.",
      "Target deployu z `config/projects.json`.",
      "Stan WIP w `.state/dev-wip.json`.",
      "Nieistniejący: `docs/prd/prd-ghost.md`.",
      "ADR wg `docs/adr/NNN-slug.md`.",
      "",
    ].join("\n")
  );

  // A role doc that adds one more reference.
  write(
    root,
    "agents/dev/agents/implementer.md",
    [
      "---",
      "name: implementer",
      "model: z-ai/glm-5.2",
      "tools: Read, Edit, Bash",
      "---",
      "Jesteś IMPLEMENTER. Trzymaj się `docs/CONVENTIONS.md`.",
      "",
    ].join("\n")
  );

  // Depth-1 doc which itself references a depth-2 doc, doc-relatively.
  write(
    root,
    "docs/prd/prd-development.md",
    [
      "# PRD — DEVELOPMENT",
      "",
      "Spec: [agent-2-dev](../agents/agent-2-dev.md).",
      "Launcher: `bin/dev.bat`.",
      "",
    ].join("\n")
  );

  // The depth-2 target of that relative link.
  write(root, "docs/agents/agent-2-dev.md", "# agent-2-dev\n\nOpis roli.\n");

  write(root, "docs/CONVENTIONS.md", "# Konwencje\n\nKod po angielsku.\n");
  write(root, "config/projects.json", '{\n  "projects": []\n}\n');
  write(root, "scripts/linear-query.mjs", "// linear-query\n");

  // A file NOT referenced by any prompt — the allowlist must exclude it.
  write(root, ".env", "SECRET=nie-czytaj-mnie\n");
  write(root, "docs/UNRELATED.md", "# Nikt na mnie nie wskazuje\n");

  // A minimal second squad so listContextFiles has something to union.
  write(root, "agents/plan/CLAUDE.md", "# Agent: PLAN\n\nBrief w `planning/inbox/<plik>.md`.\n");

  return root;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function runTests() {
  const { extractRefs, resolvePromptRefs, listContextFiles, readContextFile } =
    await import(MODULE_PATH);

  // ---- Test 1: extractRefs finds repo-relative paths ----
  {
    const refs = extractRefs("Spec: `docs/prd/prd-development.md` oraz config/projects.json.");
    const paths = refs.map((r) => r.path);
    assert(paths.includes("docs/prd/prd-development.md"), "extractRefs finds a doc path");
    assert(paths.includes("config/projects.json"), "extractRefs finds a config path");
    assertEq(refs.length, 2, "extractRefs returns exactly the two paths");
  }

  // ---- Test 2: $LA_ROOT prefix is stripped ----
  {
    const refs = extractRefs("node $LA_ROOT/scripts/linear-query.mjs issues");
    assertEq(refs[0].path, "scripts/linear-query.mjs", "$LA_ROOT prefix stripped");
  }

  // ---- Test 3: Windows backslashes normalised ----
  {
    const refs = extractRefs("Uruchom bin\\agent.bat dev recon");
    assertEq(refs[0].path, "bin/agent.bat", "backslash path normalised to /");
  }

  // ---- Test 4: relative prefixes are preserved for later resolution ----
  {
    const refs = extractRefs("Spec: [x](../agents/agent-2-dev.md).");
    assertEq(refs[0].path, "../agents/agent-2-dev.md", "../ prefix kept, not silently dropped");
  }

  // ---- Test 5: templates flagged, not treated as real paths ----
  {
    const refs = extractRefs("`agents/dev/agents/*.md` i `docs/adr/NNN-slug.md` i `planning/inbox/<plik>.md`");
    assertEq(refs.length, 3, "three template refs extracted");
    assert(refs.every((r) => r.isTemplate), "all three flagged as templates");
  }

  // ---- Test 6: URLs are not mistaken for repo files ----
  {
    const refs = extractRefs("Zobacz https://example.com/docs/spec.md po szczegóły.");
    assertEq(refs.length, 0, "URL is not extracted as a repo reference");
  }

  // ---- Test 7: bare filenames are ignored ----
  {
    const refs = extractRefs("Trzymaj się swojego CLAUDE.md i README.md.");
    assertEq(refs.length, 0, "single-segment filenames are not references");
  }

  // ---- Test 8: dedup keeps first occurrence only ----
  {
    const refs = extractRefs("a docs/x.md b docs/x.md c docs/x.md");
    assertEq(refs.length, 1, "repeated reference deduped");
  }

  // ---- Test 9: sources are the auto-loaded documents ----
  {
    const root = buildFixture();
    const r = resolvePromptRefs(root, { squad: "dev" });
    const ids = r.sources.map((s) => s.id);
    assert(ids.includes("kickoff"), "kickoff is a source");
    assert(ids.includes("agents/dev/CLAUDE.md"), "lead CLAUDE.md is a source");
    assert(ids.includes("agents/dev/agents/implementer.md"), "role doc is a source");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 10: auto-loaded docs are depth 0 with no referencedBy ----
  {
    const root = buildFixture();
    const r = resolvePromptRefs(root, { squad: "dev" });
    const lead = r.refs.find((x) => x.path === "agents/dev/CLAUDE.md");
    assertEq(lead.kind, "auto", "lead CLAUDE.md classified as auto");
    assertEq(lead.depth, 0, "lead CLAUDE.md is depth 0");
    assertEq(lead.referencedBy.length, 0, "auto source has empty referencedBy");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 11: kinds separate what is read, run and configured ----
  {
    const root = buildFixture();
    const r = resolvePromptRefs(root, { squad: "dev" });
    const kind = (p) => (r.refs.find((x) => x.path === p) || {}).kind;
    assertEq(kind("docs/prd/prd-development.md"), "read", "PRD classified as read");
    assertEq(kind("scripts/linear-query.mjs"), "tool", "script classified as tool");
    assertEq(kind("config/projects.json"), "config", "json classified as config");
    assertEq(kind(".state/dev-wip.json"), "state", ".state/ classified as state");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 12: doc-relative link resolves against the referencing doc ----
  {
    const root = buildFixture();
    const r = resolvePromptRefs(root, { squad: "dev" });
    const target = r.refs.find((x) => x.path === "docs/agents/agent-2-dev.md");
    assert(target, "../agents/agent-2-dev.md resolved to docs/agents/agent-2-dev.md");
    assertEq(target.exists, true, "resolved relative target exists");
    assertEq(target.depth, 2, "relative target sits at depth 2");
    assert(
      !r.refs.some((x) => x.path === "agents/agent-2-dev.md"),
      "the ../-stripped path is NOT recorded (would be a phantom broken link)"
    );
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 13: a genuinely missing file is reported ----
  {
    const root = buildFixture();
    const r = resolvePromptRefs(root, { squad: "dev" });
    const ghost = r.refs.find((x) => x.path === "docs/prd/prd-ghost.md");
    assertEq(ghost.exists, false, "nonexistent doc marked as missing");
    assertEq(r.stats.missing, 1, "stats.missing counts exactly the one broken link");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 14: templates and .state are excluded from the missing count ----
  {
    const root = buildFixture();
    const r = resolvePromptRefs(root, { squad: "dev" });
    const tpl = r.refs.find((x) => x.path === "docs/adr/NNN-slug.md");
    assertEq(tpl.isTemplate, true, "NNN-slug.md flagged as template");
    assertEq(tpl.exists, null, "template has no exists verdict");
    const state = r.refs.find((x) => x.path === ".state/dev-wip.json");
    assertEq(state.exists, false, "absent state file records exists:false");
    // stats.missing === 1 (only prd-ghost) is asserted in Test 13 — proving
    // neither the template nor the state file inflated it.
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 15: referencedBy records provenance ----
  {
    const root = buildFixture();
    const r = resolvePromptRefs(root, { squad: "dev" });
    const prd = r.refs.find((x) => x.path === "docs/prd/prd-development.md");
    assert(
      prd.referencedBy.includes("agents/dev/CLAUDE.md"),
      "PRD records the lead doc as its referrer"
    );
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 16: recursion stops at depth 2 ----
  {
    const root = buildFixture();
    const r = resolvePromptRefs(root, { squad: "dev" });
    assert(r.refs.every((x) => x.depth <= 2), "no reference exceeds depth 2");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 17: file metadata is populated ----
  {
    const root = buildFixture();
    const r = resolvePromptRefs(root, { squad: "dev" });
    const conv = r.refs.find((x) => x.path === "docs/CONVENTIONS.md");
    assert(conv.lines > 0, "existing file reports a line count");
    assert(conv.bytes > 0, "existing file reports a byte size");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 18: role scope narrows to that role's own document ----
  {
    const root = buildFixture();
    const r = resolvePromptRefs(root, { squad: "dev", role: "implementer" });
    assertEq(r.sources.length, 1, "role scope has exactly one source");
    assert(
      r.refs.some((x) => x.path === "docs/CONVENTIONS.md"),
      "role scope includes the role's own reference"
    );
    assert(
      !r.refs.some((x) => x.path === "scripts/linear-query.mjs"),
      "role scope excludes references that only the lead makes"
    );
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 19: invalid squad / role rejected ----
  {
    const root = buildFixture();
    assert(resolvePromptRefs(root, { squad: "nope" }).error, "invalid squad rejected");
    assert(
      resolvePromptRefs(root, { squad: "dev", role: "../../etc/passwd" }).error,
      "invalid role rejected"
    );
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 20: allowlist contains referenced files and nothing else ----
  {
    const root = buildFixture();
    const files = listContextFiles(root);
    assert(files.has("docs/prd/prd-development.md"), "allowlist includes a referenced doc");
    assert(files.has("scripts/linear-query.mjs"), "allowlist includes a referenced script");
    assert(!files.has(".env"), "allowlist excludes .env");
    assert(!files.has("docs/UNRELATED.md"), "allowlist excludes an unreferenced doc");
    assert(!files.has("docs/prd/prd-ghost.md"), "allowlist excludes a missing file");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 21: readContextFile serves a referenced file ----
  {
    const root = buildFixture();
    const doc = readContextFile(root, "docs/CONVENTIONS.md");
    assert(doc.body.includes("Konwencje"), "referenced file body returned");
    assertEq(doc.path, "docs/CONVENTIONS.md", "path echoed back");
    assert(doc.lines > 0, "line count returned");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 22: unreferenced file refused even though it exists ----
  {
    const root = buildFixture();
    const denied = readContextFile(root, ".env");
    assert(denied.error, ".env refused");
    assert(denied.error.includes("forbidden"), ".env refused as forbidden, not 'not found'");
    assert(!denied.body, "no body leaked for a refused file");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 23: path traversal refused ----
  {
    const root = buildFixture();
    for (const attack of [
      "../../../etc/passwd",
      "..\\..\\Windows\\System32\\drivers\\etc\\hosts",
      "docs/../../outside.md",
    ]) {
      const denied = readContextFile(root, attack);
      assert(denied.error, `traversal refused: ${attack}`);
      assert(!denied.body, `no body leaked for: ${attack}`);
    }
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 24: empty/garbage path refused ----
  {
    const root = buildFixture();
    assert(readContextFile(root, "").error, "empty path refused");
    assert(readContextFile(root, null).error, "null path refused");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 25: every squad resolves without throwing ----
  {
    const root = buildFixture();
    for (const squad of ["plan", "dev", "review", "test", "cadence"]) {
      const r = resolvePromptRefs(root, { squad });
      assert(!r.error, `squad ${squad} resolves without error`);
      assert(Array.isArray(r.refs), `squad ${squad} returns a refs array`);
    }
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  console.log("prompt-refs tests\n");
  await runTests();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
