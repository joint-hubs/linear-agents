// Tests for the external prompt roots — run with: node scripts/prompt-external.test.mjs
//
// This is the security boundary of POST /api/prompts/file once it reaches
// outside the repo (docs/ui/prompt-editing-external.md §2). Everything runs
// against fixture roots in a temp directory; the real ~/.claude and hermes
// installations are never touched.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MODULE_PATH = pathToFileURL(join(__dirname, "prompt-library.mjs")).href;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) { console.log(`  PASS: ${label}`); passed++; }
  else { console.log(`  FAIL: ${label}`); failed++; }
}

function assertEq(actual, expected, label) {
  if (actual === expected) { console.log(`  PASS: ${label}`); passed++; }
  else {
    console.log(`  FAIL: ${label}`);
    console.log(`    expected: ${JSON.stringify(expected)}`);
    console.log(`    actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Fixture: a fake repo root whose config points at a fake external root
// ---------------------------------------------------------------------------

function write(base, rel, content) {
  const abs = join(base, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
  return abs;
}

function buildFixture() {
  const repo = mkdtempSync(join(tmpdir(), "prompt-ext-repo-"));
  const ext = mkdtempSync(join(tmpdir(), "prompt-ext-home-"));
  const outside = mkdtempSync(join(tmpdir(), "prompt-ext-outside-"));

  // Editable, per the include list.
  write(ext, "CLAUDE.md", "# Globalne\r\nLinia druga\r\n");          // CRLF on purpose
  write(ext, "memory/orchestration.md", "# Orkiestracja\nfoo\n");     // LF on purpose
  write(ext, "memory/workflow.md", "# Workflow\n");
  write(ext, "skills/dev/SKILL.md", "# dev skill\n");
  write(ext, "skills/refine/SKILL.md", "# refine skill\n");

  // Present but NOT editable.
  write(ext, "config.yaml", "model: x\n");            // not .md
  write(ext, "plans/scratch.md", "# plan\n");         // excluded
  write(ext, "cache/changelog.md", "# cache\n");      // excluded
  write(ext, "run.bat", "@echo off\n");               // not .md
  write(ext, "memory/notes.txt", "hello\n");          // not .md

  // A file the root must never be able to reach.
  write(outside, "secret.md", "SECRET\n");

  write(
    repo,
    "config/prompt-roots.json",
    JSON.stringify({
      roots: [
        {
          id: "home",
          label: "Fixture root",
          hint: "test",
          path: ext.replace(/\\/g, "/"),
          include: ["CLAUDE.md", "memory/*.md", "skills/*/SKILL.md"],
          exclude: ["plans/*", "cache/*"],
        },
      ],
    })
  );

  return { repo, ext, outside };
}

function cleanup(f) {
  for (const d of [f.repo, f.ext, f.outside]) rmSync(d, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function runTests() {
  const {
    readPromptRoots, listExternalPromptFiles, readExternalFile,
    writeExternalFile, isExternalPath,
  } = await import(MODULE_PATH);

  // ---- Test 1: isExternalPath distinguishes the two path spaces ----
  {
    assert(isExternalPath("@home/CLAUDE.md"), "@-prefixed path is external");
    assert(!isExternalPath("agents/dev/CLAUDE.md"), "repo-relative path is not external");
    assert(!isExternalPath("@nosuffix"), "@ without a slash is not a valid external path");
    assert(!isExternalPath("@/x.md"), "@ with an empty root id is rejected");
    assert(!isExternalPath(null), "null is not an external path");
  }

  // ---- Test 2: roots load from config ----
  {
    const f = buildFixture();
    const roots = readPromptRoots(f.repo);
    assertEq(roots.length, 1, "one root configured");
    assertEq(roots[0].id, "home", "root id read");
    assertEq(roots[0].include.length, 3, "include globs read");
    cleanup(f);
  }

  // ---- Test 3: a missing config yields zero roots, not a crash ----
  {
    const empty = mkdtempSync(join(tmpdir(), "prompt-ext-none-"));
    assertEq(readPromptRoots(empty).length, 0, "absent config degrades to no roots");
    assertEq(listExternalPromptFiles(empty).length, 0, "…and no files");
    rmSync(empty, { recursive: true, force: true });
  }

  // ---- Test 4: enumeration returns exactly the include list ----
  {
    const f = buildFixture();
    const files = listExternalPromptFiles(f.repo).map((x) => x.path).sort();
    assertEq(files.length, 5, "five editable files found");
    assert(files.includes("@home/CLAUDE.md"), "top-level CLAUDE.md listed");
    assert(files.includes("@home/memory/orchestration.md"), "memory/*.md listed");
    assert(files.includes("@home/skills/dev/SKILL.md"), "skills/*/SKILL.md listed");
    assert(!files.some((p) => p.includes("config.yaml")), "config.yaml not listed");
    assert(!files.some((p) => p.includes("plans/")), "excluded plans/ not listed");
    assert(!files.some((p) => p.includes("cache/")), "excluded cache/ not listed");
    assert(!files.some((p) => p.includes(".txt")), "non-.md not listed");
    assert(!files.some((p) => p.includes("run.bat")), "run.bat not listed");
    cleanup(f);
  }

  // ---- Test 5: reading an allowed file works ----
  {
    const f = buildFixture();
    const doc = readExternalFile(f.repo, "@home/memory/orchestration.md");
    assert(doc.body.includes("Orkiestracja"), "allowed file reads back");
    assertEq(doc.path, "@home/memory/orchestration.md", "path echoed");
    cleanup(f);
  }

  // ---- Test 6: every rejection path ----
  {
    const f = buildFixture();
    const cases = [
      ["@home/../../../secret.md", "escapes", "traversal out of the root"],
      ["@home/config.yaml", "only .md", "non-.md extension"],
      ["@home/run.bat", "only .md", "a .bat file"],
      ["@home/plans/scratch.md", "include", "path outside the include list"],
      ["@home/cache/changelog.md", "include", "path in an excluded directory"],
      ["@nosuch/CLAUDE.md", "unknown prompt root", "unknown root id"],
      ["agents/dev/CLAUDE.md", "not an external", "a repo path sent to the external reader"],
    ];
    for (const [p, needle, label] of cases) {
      const r = readExternalFile(f.repo, p);
      assert(r.error && r.error.includes(needle), `refused: ${label}`);
      assert(!r.body, `no content leaked: ${label}`);
    }
    cleanup(f);
  }

  // ---- Test 7: a directory junction inside the root cannot smuggle a path out ----
  //
  // The junction has to sit where the resulting path still MATCHES an include
  // glob — otherwise the include check rejects it first and this test proves
  // nothing about realpath. `skills/*/SKILL.md` is the shape that allows it:
  // skills/escape/SKILL.md matches the glob, while its real directory is
  // outside the root. resolve() would accept it; only realpath refuses.
  {
    const f = buildFixture();
    writeFileSync(join(f.outside, "SKILL.md"), "STOLEN\n", "utf8");
    let made = true;
    try {
      symlinkSync(f.outside, join(f.ext, "skills", "escape"), "junction");
    } catch {
      made = false; // junction creation needs privileges on some systems
    }
    if (made) {
      const r = readExternalFile(f.repo, "@home/skills/escape/SKILL.md");
      assert(r.error && r.error.includes("escapes"), "junction out of the root is refused by realpath");
      assert(!r.body, "junction did not leak the outside file");

      const w = writeExternalFile(f.repo, "@home/skills/escape/SKILL.md", "hijacked\n");
      assert(w.error, "writing through the junction is refused");
      assertEq(readFileSync(join(f.outside, "SKILL.md"), "utf8"), "STOLEN\n",
        "the file outside the root was never written");
    } else {
      console.log("  SKIP: junction test (insufficient privileges)");
    }
    cleanup(f);
  }

  // ---- Test 8: write reaches disk ----
  {
    const f = buildFixture();
    const r = writeExternalFile(f.repo, "@home/memory/workflow.md", "# Nowa treść\n");
    assertEq(r.changed, true, "write reports changed");
    const onDisk = readFileSync(join(f.ext, "memory", "workflow.md"), "utf8");
    assert(onDisk.includes("Nowa treść"), "new content is on disk");
    cleanup(f);
  }

  // ---- Test 9: dryRun never touches the file ----
  {
    const f = buildFixture();
    const before = readFileSync(join(f.ext, "memory", "workflow.md"), "utf8");
    const r = writeExternalFile(f.repo, "@home/memory/workflow.md", "# Inna\n", { dryRun: true });
    assertEq(r.changed, true, "dry run reports it would change");
    assertEq(readFileSync(join(f.ext, "memory", "workflow.md"), "utf8"), before,
      "dry run left the file byte-identical");
    cleanup(f);
  }

  // ---- Test 10: CRLF stays CRLF, LF stays LF ----
  {
    const f = buildFixture();

    writeExternalFile(f.repo, "@home/CLAUDE.md", "# Globalne\nLinia druga\nTrzecia\n");
    const crlfFile = readFileSync(join(f.ext, "CLAUDE.md"), "utf8");
    assertEq((crlfFile.match(/\r\n/g) || []).length, 3, "CRLF file keeps CRLF");
    assert(!/(?<!\r)\n/.test(crlfFile), "CRLF file has no bare LF");

    writeExternalFile(f.repo, "@home/memory/orchestration.md", "# Orkiestracja\r\nbar\r\n");
    const lfFile = readFileSync(join(f.ext, "memory", "orchestration.md"), "utf8");
    assert(!lfFile.includes("\r"), "LF file stays LF even when given CRLF input");

    cleanup(f);
  }

  // ---- Test 11: identical content is a no-op ----
  {
    const f = buildFixture();
    const same = readFileSync(join(f.ext, "memory", "workflow.md"), "utf8");
    const r = writeExternalFile(f.repo, "@home/memory/workflow.md", same);
    assertEq(r.changed, false, "identical content reports changed:false");
    cleanup(f);
  }

  // ---- Test 12: writes are refused everywhere reads are ----
  {
    const f = buildFixture();
    for (const p of [
      "@home/../../../secret.md",
      "@home/config.yaml",
      "@home/run.bat",
      "@home/plans/scratch.md",
      "@nosuch/CLAUDE.md",
    ]) {
      const r = writeExternalFile(f.repo, p, "hijacked\n");
      assert(r.error, `write refused: ${p}`);
    }
    assertEq(readFileSync(join(f.outside, "secret.md"), "utf8"), "SECRET\n",
      "the outside file was never written");
    assertEq(readFileSync(join(f.ext, "config.yaml"), "utf8"), "model: x\n",
      "config.yaml was never written");
    cleanup(f);
  }

  // ---- Test 13: a non-string body is refused ----
  {
    const f = buildFixture();
    for (const bad of [null, undefined, 42, {}, []]) {
      const r = writeExternalFile(f.repo, "@home/memory/workflow.md", bad);
      assert(r.error, `non-string body refused: ${JSON.stringify(bad) ?? "undefined"}`);
    }
    cleanup(f);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  console.log("prompt-external tests\n");
  await runTests();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
