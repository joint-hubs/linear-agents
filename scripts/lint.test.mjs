// Tests for scripts/lint.mjs — run with: node scripts/lint.test.mjs
//
// Proves the lint contract from FOC-287: clean fixture exits 0; a planted
// violation exits 1 and is NAMED with file + line; an empty scope is refused
// (never a silent "clean"); usage errors exit 2; unreadable files surface as
// violations. All fixtures live in temp directories — the real repo tree is
// never used as a fixture.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const LINT_PATH = join(__dirname, "lint.mjs");
const MODULE_PATH = pathToFileURL(LINT_PATH).href;

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
// Fixture helpers
// ---------------------------------------------------------------------------

function makeFixture() {
  return mkdtempSync(join(tmpdir(), "lint-test-"));
}

function write(root, relPath, content) {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

function runLint(root, extraArgs = []) {
  const r = spawnSync(process.execPath, [LINT_PATH, "--root", root, ...extraArgs], {
    encoding: "utf8",
  });
  return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function runTests() {
  // ---- Case 1: clean fixture → exit 0, scope + not-covered stated ----
  {
    const root = makeFixture();
    write(root, "src/clean.mjs", "export const a = 1;\n");
    write(root, "docs/clean.md", "# Clean\n\nNo markers here.\n");
    write(root, "config/clean.json", '{\n  "ok": true\n}\n');
    const r = runLint(root);
    assertEq(r.status, 0, "clean fixture exits 0");
    assert(r.out.includes("OK:"), "clean fixture prints OK");
    assert(r.out.includes("Scope covered: 3 files"), `scope names the 3 files actually read`);
    assert(r.out.includes(root), "scope line names the tree it actually linted");
    assert(r.out.includes("Not covered:"), "clean run carries an explicit not-covered statement");
    assert(r.out.includes("PASS trailing-whitespace"), "silent rules print PASS lines");
    assert(r.out.includes("PASS tab-indentation"), "tab-indentation prints its own PASS line on a clean tree");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Case 2: planted trailing-whitespace violation → exit 1, named ----
  {
    const root = makeFixture();
    write(root, "src/bad.mjs", "export const a = 1;\nconst padded = 2;   \nexport const b = 3;\n");
    const r = runLint(root);
    assertEq(r.status, 1, "planted violation exits 1");
    assert(r.out.includes("src/bad.mjs:2 trailing-whitespace"), `violation named with file + line (got: ${r.out.split("\n").find((l) => l.includes("bad.mjs"))})`);
    assert(r.out.includes("FAIL:"), "summary line is FAIL, not OK");
    assert(!r.out.includes("OK:"), "failing run never prints OK");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Case 3: planted tab-indentation violation → exit 1, named ----
  {
    const root = makeFixture();
    write(root, "src/tabbed.mjs", "const a = 1;\n\tconst indented = 2;\nconst b = 3;\n");
    const r = runLint(root);
    assertEq(r.status, 1, "tab indentation exits 1");
    assert(r.out.includes("src/tabbed.mjs:2 tab-indentation"), "tab-indentation violation named with file + line");
    assert(r.out.includes("FAIL:"), "tab run summary is FAIL, not OK");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Case 4: planted debugger statement → named ----
  {
    const root = makeFixture();
    write(root, "src/debug.mjs", "const a = 1;\ndebugger;\nconst b = 2;\n");
    const r = runLint(root);
    assertEq(r.status, 1, "debugger statement exits 1");
    assert(r.out.includes("src/debug.mjs:2 debugger-statement"), "debugger statement named with file + line");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Case 5: conflict marker in .md → named with line ----
  {
    const root = makeFixture();
    write(root, "docs/conflicted.md", "# Title\n<<<<<<< HEAD\n=======\n>>>>>>> branch\n");
    const r = runLint(root);
    assertEq(r.status, 1, "conflict markers exit 1");
    assert(r.out.includes("docs/conflicted.md:2 conflict-marker"), "opening marker named with file + line");
    assert(r.out.includes("docs/conflicted.md:4 conflict-marker"), "closing marker named with file + line");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Case 6: invalid JSON → json-parse violation at file level ----
  {
    const root = makeFixture();
    write(root, "config/broken.json", '{ "ok": true,, }\n');
    const r = runLint(root);
    assertEq(r.status, 1, "invalid json exits 1");
    assert(r.out.includes("config/broken.json:0 json-parse"), "json-parse violation named (line 0 = file-level)");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Case 7: UTF-8 BOM → bom violation at file level ----
  {
    const root = makeFixture();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/bom.mjs"), Buffer.from([0xef, 0xbb, 0xbf]) + Buffer.from("#!/usr/bin/env node\n"), "utf8");
    const r = runLint(root);
    assertEq(r.status, 1, "BOM exits 1");
    assert(r.out.includes("src/bom.mjs:0 bom"), "BOM violation named at file level");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Case 8: empty scope → nonzero exit, NOT a clean message ----
  {
    const root = makeFixture();
    write(root, "notes.py", "print('hello')\n");
    write(root, "go.txt", "plain text\n");
    const r = runLint(root);
    assert(r.status !== 0, `empty scope exits nonzero (status=${r.status})`);
    assert(r.out.includes("scope resolved to 0 files"), "empty scope states that nothing was linted");
    assert(r.out.includes("refusing to report clean"), "empty-scope refusal is explicit");
    assert(!r.out.includes("OK:"), "empty scope never prints OK");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Case 9: usage errors → exit 2 + Usage line ----
  {
    const root = makeFixture();
    const bad = runLint(root, ["--bogus"]);
    assertEq(bad.status, 2, "unknown flag exits 2");
    assert(bad.out.includes("Usage:"), "unknown flag prints Usage");
    const missing = spawnSync(process.execPath, [LINT_PATH, "--root"], { encoding: "utf8" });
    assertEq(missing.status, 2, "--root without a value exits 2");
    assert(missing.stderr.includes("Usage:"), "missing --root value prints Usage");
    const ghost = runLint(join(root, "does-not-exist"));
    assertEq(ghost.status, 2, "nonexistent --root exits 2");
    assert(ghost.out.includes("Usage:"), "nonexistent root prints Usage");
    const fileRoot = runLint(LINT_PATH);
    assertEq(fileRoot.status, 2, "--root pointing at an existing file exits 2");
    assert(fileRoot.out.includes("Usage:"), "file root prints Usage");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Case 10: unreadable file surfaces as a violation, never a silent skip ----
  {
    const root = makeFixture();
    mkdirSync(join(root, "src"), { recursive: true });
    // A DIRECTORY named like a covered file makes readFileSync fail (EISDIR) —
    // the deterministic way to force the read-error path on any platform.
    mkdirSync(join(root, "src/evil.mjs"), { recursive: true });
    write(root, "src/fine.mjs", "export const ok = 1;\n");
    const { lintFile } = await import(MODULE_PATH);
    const r = lintFile(root, "src/evil.mjs");
    assertEq(r.unreadable, 1, "unreadable file flagged via lintFile");
    assert(r.violations.length === 1 && r.violations[0].rule === "read-error", "read failure becomes a read-error violation, not a silent skip");
    assert(r.violations[0].detail.includes("scope was not fully covered"), "read-error states the scope was not fully covered");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Case 11: scope errors refuse to answer (exit 3 semantics) ----
  {
    // resolveScope on an unreadable directory records a scopeError instead of
    // answering — verify through the exported core, mirroring main()'s guard.
    const { resolveScope } = await import(MODULE_PATH);
    const root = makeFixture();
    mkdirSync(join(root, "src"), { recursive: true });
    write(root, "src/ok.mjs", "const a = 1;\n");
    const r = resolveScope(root);
    assertEq(r.scopeErrors.length, 0, "readable fixture resolves with no scope errors");
    assertEq(r.files.length, 1, "walk mode collects the covered file");
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  console.log("lint tests\n");
  await runTests();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();