// Tests for the write half of prompt-library.mjs — writeContextFile.
// run with: node scripts/prompt-write.test.mjs
//
// Covers docs/ui/prompt-editing.md §3's guard order and the EOL-preserving
// atomic write. All tests operate on fixtures in a temp directory, NEVER on
// real repo files.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
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
  const root = mkdtempSync(join(tmpdir(), "prompt-write-test-"));

  // DEV lead — CRLF file, references a read-doc, a tool script, a config
  // file, a launcher .bat and a `.state/*.md` file (all real, all extracted
  // by extractRefs so they land in listContextFiles).
  write(
    root,
    "agents/dev/CLAUDE.md",
    [
      "# Agent: DEV (squad lead)",
      "",
      "Spec: `docs/CONVENTIONS.md`.",
      "Wołaj `node $LA_ROOT/scripts/linear-query.mjs issues`.",
      "Target deployu z `config/projects.json`.",
      "Uruchom `bin/agent.bat dev recon`.",
      "Stan WIP w `.state/dev-wip.md`.",
      "",
    ].join("\r\n")
  );

  // Role doc — auto-loaded source, kind "auto".
  write(
    root,
    "agents/dev/agents/implementer.md",
    [
      "---",
      "name: implementer",
      "model: z-ai/glm-5.2",
      "tools: Read, Edit, Bash",
      "---",
      "Jesteś sub-agentem IMPLEMENTER.",
      "",
    ].join("\n")
  );

  // Read doc, referenced by the lead. CRLF line endings — the write-preserves-EOL test.
  write(root, "docs/CONVENTIONS.md", "# Konwencje\r\n\r\nKod po angielsku.\r\n");

  // Referenced but wrong kind: `.state/*.md` exists and is in the allowlist,
  // but must still be refused by the kind guard (state, not auto/read).
  write(root, ".state/dev-wip.md", "# WIP\n\nRuntime artefact — nie jest promptem.\n");

  // Referenced but wrong extension — must be refused by the .md guard even
  // though they are legitimately part of the reference graph.
  write(root, "scripts/linear-query.mjs", "// linear-query\n");
  write(root, "config/projects.json", '{\n  "projects": []\n}\n');
  write(root, "bin/agent.bat", "@echo off\r\nclaude %*\r\n");

  // A real .md file that NO prompt references — allowlist must exclude it.
  write(root, "docs/UNRELATED.md", "# Nikt na mnie nie wskazuje\n");

  return root;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function runTests() {
  const { writeContextFile } = await import(MODULE_PATH);

  // ---- Test 1: write works, content lands on disk ----
  {
    const root = buildFixture();
    const newBody = "Jesteś sub-agentem IMPLEMENTER.\nZaktualizowana instrukcja.\n";
    const result = writeContextFile(root, "agents/dev/agents/implementer.md", newBody);
    assert(!result.error, "no error");
    assertEq(result.changed, true, "changed:true");
    const onDisk = readFileSync(join(root, "agents/dev/agents/implementer.md"), "utf8");
    assertEq(onDisk, newBody, "new body landed on disk verbatim (source was already LF)");
    assertEq(result.after, newBody, "result.after matches what was written");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 2: dryRun returns before/after and does NOT touch the file ----
  {
    const root = buildFixture();
    const before = readFileSync(join(root, "agents/dev/CLAUDE.md"), "utf8");
    const newBody = before.replace("DEV (squad lead)", "DEV (squad lead) v2");
    const result = writeContextFile(root, "agents/dev/CLAUDE.md", newBody, { dryRun: true });
    assert(!result.error, "no error");
    assertEq(result.changed, true, "dryRun still reports changed:true");
    assert(result.before === before, "before echoes original content");
    assert(result.after.includes("v2"), "after reflects the proposed change");
    const onDisk = readFileSync(join(root, "agents/dev/CLAUDE.md"), "utf8");
    assertEq(onDisk, before, "file on disk is untouched by dryRun");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 3: identical content -> changed:false, no write ----
  {
    const root = buildFixture();
    const before = readFileSync(join(root, "docs/CONVENTIONS.md"), "utf8");
    const result = writeContextFile(root, "docs/CONVENTIONS.md", before);
    assert(!result.error, "no error");
    assertEq(result.changed, false, "identical content -> changed:false");
    const onDisk = readFileSync(join(root, "docs/CONVENTIONS.md"), "utf8");
    assertEq(onDisk, before, "file untouched when content is identical");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 4: CRLF file stays CRLF after write (byte-level check) ----
  {
    const root = buildFixture();
    // Body deliberately uses LF only — the write must still land as CRLF.
    const lfBody = "# Konwencje\n\nZaktualizowane zasady zespolu.\n";
    const result = writeContextFile(root, "docs/CONVENTIONS.md", lfBody);
    assert(!result.error, "no error");
    assertEq(result.changed, true, "changed:true");
    const raw = readFileSync(join(root, "docs/CONVENTIONS.md"), "utf8");
    assert(raw.includes("\r\n"), "written file contains CRLF sequences");
    assert(!/(?<!\r)\n/.test(raw), "no bare LF survives — every \\n is preceded by \\r");
    assertEq(raw, "# Konwencje\r\n\r\nZaktualizowane zasady zespolu.\r\n", "exact CRLF-normalised bytes");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 5: disallowed extensions refused (.mjs, .json, .bat) — 403-style ----
  {
    const root = buildFixture();
    for (const relPath of ["scripts/linear-query.mjs", "config/projects.json", "bin/agent.bat"]) {
      const result = writeContextFile(root, relPath, "malicious content\n");
      assert(result.error, `${relPath} refused`);
      assert(result.error.startsWith("forbidden"), `${relPath} refused as forbidden`);
      assert(result.error.includes("only .md files"), `${relPath} refused for the .md-only reason`);
    }
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 6: path traversal refused ----
  {
    const root = buildFixture();
    // Non-.md traversal attempts — caught by the .md guard (guard 1) already.
    for (const attack of [
      "../../../etc/passwd",
      "..\\..\\Windows\\System32\\drivers\\etc\\hosts",
    ]) {
      const result = writeContextFile(root, attack, "x\n");
      assert(result.error, `traversal refused: ${attack}`);
      assert(result.error.startsWith("forbidden"), `traversal refused as forbidden: ${attack}`);
    }
    // .md-suffixed traversal attempts — must be caught by the path-escape
    // guard (guard 2) specifically, not just fall through on extension.
    for (const attack of ["docs/../../outside.md", "..\\..\\secrets.md"]) {
      const result = writeContextFile(root, attack, "x\n");
      assert(result.error, `.md traversal refused: ${attack}`);
      assertEq(result.error, "forbidden: path escapes repo root", `guard 2 fired for: ${attack}`);
    }
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 7: existing file, but not referenced by any prompt -> refused ----
  {
    const root = buildFixture();
    const result = writeContextFile(root, "docs/UNRELATED.md", "hijacked\n");
    assert(result.error, "unreferenced .md refused");
    assertEq(result.error, "forbidden: not referenced by any prompt", "guard 3 fired");
    const onDisk = readFileSync(join(root, "docs/UNRELATED.md"), "utf8");
    assertEq(onDisk, "# Nikt na mnie nie wskazuje\n", "unreferenced file left untouched");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 8: `.state/**/*.md` refused even though referenced and .md ----
  {
    const root = buildFixture();
    const result = writeContextFile(root, ".state/dev-wip.md", "hijacked\n");
    assert(result.error, ".state/*.md refused");
    assertEq(result.error, "forbidden: not an editable prompt document", "guard 4 fired (kind=state)");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 9: non-string body refused ----
  {
    const root = buildFixture();
    for (const badBody of [123, null, undefined, { not: "a string" }, ["a", "b"]]) {
      const result = writeContextFile(root, "docs/CONVENTIONS.md", badBody);
      assert(result.error, `non-string body (${JSON.stringify(badBody)}) refused`);
      assertEq(result.error, "body is required", `guard 5 fired for ${JSON.stringify(badBody)}`);
    }
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 10: lead CLAUDE.md (kind "auto") is editable, not just "read" docs ----
  {
    const root = buildFixture();
    const before = readFileSync(join(root, "agents/dev/CLAUDE.md"), "utf8");
    const newBody = before.replace("DEV (squad lead)", "DEV (squad lead, updated)");
    const result = writeContextFile(root, "agents/dev/CLAUDE.md", newBody);
    assert(!result.error, "auto-kind lead doc is writable");
    assertEq(result.changed, true, "changed:true");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 11: bytes reflects the byte length of the written content ----
  {
    const root = buildFixture();
    const body = "# Konwencje\n\nKrótki tekst.\n";
    const result = writeContextFile(root, "docs/CONVENTIONS.md", body);
    assert(!result.error, "no error");
    assertEq(result.bytes, Buffer.byteLength(result.after, "utf8"), "bytes matches byte length of after");
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  console.log("prompt-write tests\n");
  await runTests();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
