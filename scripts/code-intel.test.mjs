// Tests for scripts/code-intel.mjs — run with: node scripts/code-intel.test.mjs
//
// FOC-114 AC2: the safety semantics of the degraded-index states, each grounded
// in an observation recorded in docs/benchmark/codegraph-missing-index-evidence.md:
//
//   missing index  → exit 3, refusal names the fix, never claims the symbol absent
//   no CLI on PATH → exit 3 (win32 needed a fix: cmd.exe ate the ENOENT, pre-fix
//                    exit 1 was observed and captured in the evidence file)
//   pending file   → `status --json` exposes pendingChanges (the UNKNOWN signal);
//                    the query verbs themselves currently report confident absence —
//                    encoded below as a labeled tripwire, not hidden
//   stale edit     → `status --json` exposes modified; the query verbs currently
//                    answer from the outdated index without any banner — tripwire
//   spot assertion → a caller-chain answer cites the exact current file:line
//
// All fixtures live in temp directories; the wrapper is COPIED into each fixture
// (its ROOT is script-relative, so the copy pins the wrapper to the fixture tree).
// The real worktree tree is never used as a fixture and is never modified.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WRAPPER_SRC = join(__dirname, "code-intel.mjs");

// ---------------------------------------------------------------------------
// Test harness (lint.test.mjs pattern)
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
let skipped = 0;

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

function skip(label, reason) {
  console.log(`  SKIP: ${label} — ${reason}`);
  skipped++;
}

const norm = (s) => (s || "").replace(/\\/g, "/");
const settle = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// ---------------------------------------------------------------------------
// Fixture helpers — every fixture gets its own copy of the wrapper
// ---------------------------------------------------------------------------

const cleanupDirs = [];
process.on("exit", () => {
  for (const dir of cleanupDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort — .codegraph can hold a WAL lock briefly on win32 */
    }
  }
});

function makeFixture(name) {
  const root = mkdtempSync(join(tmpdir(), `codeintel-${name}-`));
  cleanupDirs.push(root);
  mkdirSync(join(root, "scripts"));
  copyFileSync(WRAPPER_SRC, join(root, "scripts", "code-intel.mjs"));
  return root;
}

const runWrapper = (root, args, env = {}) =>
  spawnSync(process.execPath, [join(root, "scripts", "code-intel.mjs"), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

// The wrapper's refusal happens BEFORE any CLI spawn, so this works with or
// without a codegraph binary installed.
const ALL_VERBS = [
  ["explore", "foc114GhostSymbol question"],
  ["symbol", "foc114GhostSymbol"],
  ["impact", "foc114GhostSymbol"],
  ["callers", "foc114GhostSymbol"],
  ["callees", "foc114GhostSymbol"],
  ["find", "foc114GhostSymbol"],
  ["files"],
  ["affected", "scripts/lib.mjs"],
  ["status"],
];

// A real index in the fixture (skipped cleanly when no codegraph CLI exists).
const codegraphAvailable = () =>
  spawnSync("codegraph", ["--version"], { shell: true, encoding: "utf8" }).status === 0;

function buildIndexedFixture(root) {
  mkdirSync(join(root, "src"));
  writeFileSync(
    join(root, "src", "lib.mjs"),
    [
      "export function foc114ProbeTarget() {",
      "  return foc114ProbeHelper();",
      "}",
      "",
      "export function foc114ProbeHelper() {",
      "  return 1;",
      "}",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "src", "app.mjs"),
    [
      'import { foc114ProbeTarget } from "./lib.mjs";',
      "",
      "export function foc114ProbeMain() {",
      "  return foc114ProbeTarget();",
      "}",
      "",
    ].join("\n"),
  );
  const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  git("add", "-A");
  git("commit", "-m", "init");
  // No `-y`: the CLI resolved through shell:true on win32 is 1.5.0, which
  // rejects the flag (1.6.0-only); plain init does not prompt either way.
  return spawnSync("codegraph", ["init", "."], { cwd: root, shell: true, encoding: "utf8" });
}

const statusJson = (root) => {
  const r = runWrapper(root, ["status", "--json"]);
  const start = (r.stdout || "").indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(r.stdout.slice(start));
  } catch {
    return null;
  }
};

const currentLineOf = (file, needle) =>
  readFileSync(file, "utf8").split("\n").findIndex((l) => l.includes(needle)) + 1;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function runTests() {
  // ---- Case 1: missing index → exit 3 on every verb, no absence claim ----
  {
    console.log("\nmissing index (un-initialized fixture)");
    const root = makeFixture("noindex");
    for (const args of ALL_VERBS) {
      const r = runWrapper(root, args);
      assertEq(r.status, 3, `exit 3 for: ${args.join(" ")}`);
      // Header claim holds for every verb, not a sampled one (review round 1):
      // the refusal path is a single constant string in requireIndex, so the
      // queried symbol can never leak into any verb's output.
      const out = norm(r.stdout) + norm(r.stderr);
      assert(!out.includes("foc114GhostSymbol"), `no absence claim for: ${args.join(" ")}`);
    }
    const probe = runWrapper(root, ["symbol", "foc114GhostSymbol"]);
    const out = norm(probe.stdout) + norm(probe.stderr);
    assert(!out.includes("foc114GhostSymbol"), "refusal never names the queried symbol (no absence claim)");
    assert(out.includes("codegraph init"), "refusal names the fix (codegraph init)");
    assert(out.includes("would be a lie"), "refusal states why it refuses instead of answering");
  }

  // ---- Case 2: codegraph not on PATH → exit 3, same no-absence property ----
  {
    console.log("\ncodegraph not on PATH (fixture with an empty .codegraph dir)");
    if (process.platform !== "win32") {
      // The win32 shell:true path is the one the defect lived on; POSIX falls
      // into the ENOENT branch, which Case 1's refusal shape already covers.
      skip("not-on-PATH", "win32-only spawn semantics (shell:true + cmd.exe)");
    } else {
      const root = makeFixture("nopath");
      mkdirSync(join(root, ".codegraph")); // requireIndex passes; the spawn is the test
      const r = runWrapper(root, ["symbol", "foc114GhostSymbol"], { PATH: "C:\\Windows\\System32" });
      const out = norm(r.stdout) + norm(r.stderr);
      assertEq(r.status, 3, "exit 3 after the win32 not-on-PATH fix (pre-fix observed: exit 1)");
      assert(out.includes("not on PATH"), "not-on-PATH refusal printed");
      assert(!out.includes("foc114GhostSymbol"), "refusal never names the queried symbol");
      assert(out.includes("npm i -g @colbymchenry/codegraph"), "refusal names the install fix");
    }
  }

  // ---- Cases 3-5 need a real index: one fixture, built once ----
  if (!codegraphAvailable()) {
    skip("indexed-fixture cases (spot assertion / pending / stale)", "codegraph CLI not on PATH");
  } else {
    const root = makeFixture("indexed");
    const init = buildIndexedFixture(root);
    assertEq(init.status, 0, "codegraph init in temp fixture succeeds");

    // ---- Case 3: caller-chain spot assertion — exact current file:line ----
    {
      console.log("\nspot assertion (indexed fixture, ground truth = fixture source)");
      const sym = runWrapper(root, ["symbol", "foc114ProbeTarget"]);
      const symOut = norm(sym.stdout) + norm(sym.stderr);
      assertEq(sym.status, 0, "symbol verb exits 0 on an indexed fixture");
      assert(symOut.includes("src/lib.mjs:1"), "symbol answer cites the exact definition line (src/lib.mjs:1)");
      const callers = runWrapper(root, ["callers", "foc114ProbeTarget"]);
      const callOut = norm(callers.stdout) + norm(callers.stderr);
      assertEq(callers.status, 0, "callers verb exits 0 on an indexed fixture");
      assert(callOut.includes("foc114ProbeMain"), "callers answer names the calling function");
      assert(callOut.includes("src/app.mjs:3"), "callers answer cites the exact caller location (src/app.mjs:3)");
    }

    // ---- Case 4: pending file — status exposes it; query verbs do not ----
    {
      console.log("\npending file (on disk, absent from the index)");
      writeFileSync(
        join(root, "src", "newer.mjs"),
        ['export function foc114ProbeOnDisk() {', '  return "only-on-disk";', "}", ""].join("\n"),
      );
      settle(2000); // observed: no one-shot auto-sync within this window
      const st = statusJson(root);
      assert(st !== null, "status --json returns parseable JSON");
      assert((st?.pendingChanges?.added ?? 0) >= 1, "status --json exposes pendingChanges.added >= 1 (the UNKNOWN signal)");

      // KNOWN GAP (FOC-114 evidence §5): the query verbs report confident
      // absence for a pending symbol — no pending/UNKNOWN marker, exit 0.
      // Desired contract: surface UNKNOWN/pending instead. This assertion
      // documents the observed behavior as a tripwire: if the CLI ever starts
      // auto-syncing or flagging pending state, this FAILS and must be updated
      // to assert the improved behavior (and the benchmark docs with it).
      const probe = runWrapper(root, ["symbol", "foc114ProbeOnDisk"]);
      const out = norm(probe.stdout) + norm(probe.stderr);
      assertEq(probe.status, 0, "pending-symbol query: observed exit 0 (desired: refusal or pending marker)");
      assert(/not found/i.test(out), "pending-symbol query: observed confident 'not found' (the gap itself)");
      // Check for markers with the queried name stripped out, so the symbol's
      // own name can never count as a hit.
      const outNoName = out.split("foc114ProbeOnDisk").join("");
      assert(!/pending|stale|outdated|unknown|⚠/i.test(outNoName), "pending-symbol query: no staleness/pending marker anywhere");
    }

    // ---- Case 5: stale edit — status exposes it; answers go stale silently ----
    {
      console.log("\nstale edit (indexed file rewritten, index not synced)");
      writeFileSync(
        join(root, "src", "lib.mjs"),
        [
          "export function foc114ProbeHelper() {",
          "  return 42;",
          "}",
          "",
          "export function foc114ProbeTarget() {",
          "  return foc114ProbeHelper();",
          "}",
          "",
        ].join("\n"),
      );
      settle(2000);
      const st = statusJson(root);
      assert((st?.pendingChanges?.modified ?? 0) >= 1, "status --json exposes pendingChanges.modified >= 1");

      const nowLine = currentLineOf(join(root, "src", "lib.mjs"), "export function foc114ProbeTarget");
      assertEq(nowLine, 5, "fixture self-check: symbol moved to line 5 on disk");

      // KNOWN GAP (FOC-114 evidence §6): the answer still cites the stale
      // location (line 1) with a fresh snippet and no staleness marker, exit 0.
      // Tripwire: if the CLI ever auto-syncs or flags staleness, this FAILS and
      // must be updated to assert the new behavior.
      const probe = runWrapper(root, ["symbol", "foc114ProbeTarget"]);
      const out = norm(probe.stdout) + norm(probe.stderr);
      assertEq(probe.status, 0, "stale query: observed exit 0");
      assert(out.includes("src/lib.mjs:1"), "stale query: answer cites the outdated location (line 1), not the current one (line 5)");
      // Same name-strip as Case 4: the symbol's own name must never count as a hit.
      const outNoName = out.split("foc114ProbeTarget").join("");
      assert(!/pending|stale|outdated|⚠/i.test(outNoName), "stale query: no staleness banner anywhere");
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log("code-intel safety-semantics tests\n");
runTests();
console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}`);
if (skipped) console.log("(skips are named above — a skipped check is not a verified one)");
process.exit(failed > 0 ? 1 : 0);
