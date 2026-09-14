// Tests for scripts/code-intel.mjs — run with: node scripts/code-intel.test.mjs
//
// FOC-114 AC2: the safety semantics of the degraded-index states, each grounded
// in an observation recorded in docs/benchmark/codegraph-missing-index-evidence.md:
//
//   missing index  → exit 3, refusal names the fix, never claims the symbol absent
//   no CLI on PATH → exit 3 (win32 needed a fix: cmd.exe ate the ENOENT, pre-fix
//                    exit 1 was observed and captured in the evidence file)
//   pending file   → `status --json` exposes pendingChanges (the UNKNOWN signal);
//                    the raw CLI's query verbs report confident absence — tripwire
//   stale edit     → `status --json` exposes modified; the raw CLI answers from the
//                    outdated index without any banner — tripwire
//   spot assertion → a caller-chain answer cites the exact current file:line
//
// Round 4 (wrapper freshness guard): the wrapper now proves index freshness
// before every query verb — syncs when changes are pending, exits 3 (UNKNOWN)
// when cleanliness cannot be proven. The guarded behavior is asserted in cases
// 6/7 (pending → found; stale → current file:line) and case 8 (unprovable
// state → exit 3). Cases 4/5 spawn the RAW CLI on purpose: they pin upstream's
// answer layer, which the wrapper guard must never hide.
//
// Round 5 (guard hardening): "proven" now also requires a git baseline — the
// CLI's pendingChanges is computed against it and reports false zeros without
// one (a tree with no own `.git` nested where an enclosing repo ignores it:
// both CLI versions lie; a repo before its first commit: CLI 1.5.0 lies —
// measured, evidence §7). Round 4's fixtures all committed a baseline, so the
// suite could not see the blind spots; cases 9/10 pin the refusal for both
// shapes, case 11 pins the sync-failed no-leak property deterministically (a
// read-only index DB), and case 12 pins quoting for repo paths with spaces.
// Both mutations verified (see the round-5 report): baseline check removed →
// exactly cases 9/10 red; guard removed entirely → every guarded assertion red
// while the raw-CLI tripwires stay green.
//
// All fixtures live in temp directories; the wrapper is COPIED into each fixture
// (its ROOT is script-relative, so the copy pins the wrapper to the fixture tree).
// The real worktree tree is never used as a fixture and is never modified.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, readFileSync, chmodSync, readdirSync } from "node:fs";
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

// The raw one-shot CLI (the same binary the wrapper resolves to on win32).
// Used ONLY by the tripwire cases 4/5: they pin upstream's answer layer, which
// the round-4 wrapper guard deliberately does not fix or hide.
const runRawCli = (root, args) =>
  spawnSync("codegraph", args, {
    cwd: root,
    shell: process.platform === "win32",
    encoding: "utf8",
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

  // ---- Case 2: CLI unrunnable → exit 3, same no-absence property ----
  // With the round-4 guard this is also the "sync/status impossible" case: the
  // guard's instrument (status --json) cannot run, so cleanliness cannot be
  // proven — the refusal fires before any query, never a silent pass-through.
  // Ordering note (round 5): the guard checks its instrument BEFORE the git
  // baseline, so this fixture — which has no .git either — still gets the
  // specific not-on-PATH refusal, not a baseline refusal.
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

      // KNOWN GAP (FOC-114 evidence §5): the RAW CLI's query verbs report
      // confident absence for a pending symbol — no pending/UNKNOWN marker,
      // exit 0. Desired contract: surface UNKNOWN/pending instead. This
      // assertion documents the observed behavior as a tripwire against the
      // raw CLI (the wrapper now guards — case 6): if the CLI ever starts
      // auto-syncing or flagging pending state, this FAILS and must be updated
      // to assert the improved behavior (and the benchmark docs with it).
      const probe = runRawCli(root, ["node", "foc114ProbeOnDisk", "--path", root]);
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

      // KNOWN GAP (FOC-114 evidence §6): the RAW CLI's answer still cites the
      // stale location (line 1) with a fresh snippet and no staleness marker,
      // exit 0. Tripwire against the raw CLI (the wrapper now guards —
      // case 7): if the CLI ever auto-syncs or flags staleness, this FAILS and
      // must be updated to assert the new behavior.
      const probe = runRawCli(root, ["node", "foc114ProbeTarget", "--path", root]);
      const out = norm(probe.stdout) + norm(probe.stderr);
      assertEq(probe.status, 0, "stale query: observed exit 0");
      assert(out.includes("src/lib.mjs:1"), "stale query: answer cites the outdated location (line 1), not the current one (line 5)");
      // Same name-strip as Case 4: the symbol's own name must never count as a hit.
      const outNoName = out.split("foc114ProbeTarget").join("");
      assert(!/pending|stale|outdated|⚠/i.test(outNoName), "stale query: no staleness banner anywhere");
    }

    // ---- Case 6: pending file THROUGH THE WRAPPER — guard syncs, then answers ----
    {
      console.log("\npending file through the wrapper (round 4 guard: sync, then answer)");
      // Same pending state case 4 left behind (newer.mjs on disk, never synced):
      // the raw CLI just answered "not found" for it; the wrapper must not.
      const probe = runWrapper(root, ["symbol", "foc114ProbeOnDisk"]);
      const out = norm(probe.stdout) + norm(probe.stderr);
      assertEq(probe.status, 0, "guarded pending-symbol query exits 0 after the guard synced");
      assert(out.includes("src/newer.mjs:1"), "guarded answer cites the pending symbol's real location (src/newer.mjs:1)");
      assert(!/not found/i.test(out), "guarded query never reports confident absence for a pending symbol");
    }

    // ---- Case 7: stale edit THROUGH THE WRAPPER — guard syncs, current file:line ----
    {
      console.log("\nstale edit through the wrapper (round 4 guard: sync, then answer)");
      // A fresh stale edit (case 6's guard already synced case 5's rewrite):
      // target moves from line 5 to line 6; the raw CLI in case 5 cited line 1.
      writeFileSync(
        join(root, "src", "lib.mjs"),
        [
          "export function foc114ProbeHelper() {",
          "  return 42;",
          "}",
          "",
          "// second edit",
          "export function foc114ProbeTarget() {",
          "  return foc114ProbeHelper();",
          "}",
          "",
        ].join("\n"),
      );
      settle(2000);
      // Settle note (round 5): on CLI 1.5.0 the one-shot `status`/`sync` scan the
      // tree at invocation (probe: a file written with zero settle was detected
      // as pending and synced), so the watcher is not in this answer path; the
      // wait is belt-and-braces for other versions. If a future CLI defers
      // pending detection to a watcher that misses this window, the note
      // assertion below goes red without any wrapper defect — an accepted,
      // named flakiness risk, not silent.
      const probe = runWrapper(root, ["symbol", "foc114ProbeTarget"]);
      const out = norm(probe.stdout) + norm(probe.stderr);
      assertEq(probe.status, 0, "guarded stale-symbol query exits 0 after the guard synced");
      assert(out.includes("src/lib.mjs:6"), "guarded answer cites the CURRENT location (src/lib.mjs:6), not the pre-edit one (line 5)");
      // No "not :5" assertion here on purpose: after earlier rewrites other
      // symbols can legitimately occupy those lines. Staleness is proven by the
      // current location being cited (a stale answer never contains it) and by
      // the guard's sync note.
      assert(out.includes("synced before answering"), "guard reports that it synced a stale index before answering");
    }

    // ---- Case 8: unprovable index state → exit 3 UNKNOWN, never pass-through ----
    {
      console.log("\nunprovable index state (corrupt .codegraph) → exit 3 UNKNOWN");
      // Destructive to the fixture — therefore last. `status --json` answers
      // {"initialized":false} with exit 0 and NO pendingChanges (measured,
      // FOC-114 round 4): nothing proves the state, so the guard refuses.
      rmSync(join(root, ".codegraph"), { recursive: true, force: true });
      mkdirSync(join(root, ".codegraph"));
      writeFileSync(join(root, ".codegraph", "corrupt.bin"), "not a database");
      const probe = runWrapper(root, ["symbol", "foc114ProbeOnDisk"]);
      const out = norm(probe.stdout) + norm(probe.stderr);
      assertEq(probe.status, 3, "unprovable index state → exit 3 (never a silent pass-through)");
      assert(!out.includes("foc114ProbeOnDisk"), "refusal never names the queried symbol");
      assert(out.includes("codegraph init"), "refusal names the fix (codegraph init)");
    }

    // ---- Case 9: no git baseline (round 5 blind spot) → exit 3 UNKNOWN ----
    {
      console.log("\nno git baseline (no .git at the project root) → exit 3 UNKNOWN");
      // Round-4's fixtures always committed, so the guard's instrument was
      // truthful in every shipped test and the blind spots were invisible.
      // Here there is NO git at all: measured (evidence §7), the CLI's
      // pendingChanges is computed against a git baseline and can report a
      // false zero here — 1.5.0 truthful in some no-git shapes, 1.6.0 not,
      // depending on what git discovery finds above the tree. Whatever the
      // instrument says, freshness is UNPROVABLE, so the guard refuses before
      // trusting any pendingChanges value.
      const root = makeFixture("nogit");
      mkdirSync(join(root, "src"));
      writeFileSync(
        join(root, "src", "lib.mjs"),
        ["export function foc114ProbeTarget() {", "  return 1;", "}", ""].join("\n"),
      );
      const init = spawnSync("codegraph", ["init", "."], { cwd: root, shell: true, encoding: "utf8" });
      assertEq(init.status, 0, "codegraph init succeeds without git (fixture self-check)");
      writeFileSync(
        join(root, "src", "newer.mjs"),
        ["export function foc114NogitPending() {", "  return 2;", "}", ""].join("\n"),
      );
      const probe = runWrapper(root, ["symbol", "foc114NogitPending"]);
      const out = norm(probe.stdout) + norm(probe.stderr);
      assertEq(probe.status, 3, "no git baseline → exit 3 (never an answer from an unproven index)");
      assert(!out.includes("foc114NogitPending"), "no-baseline refusal never names the queried symbol");
      assert(out.includes("no git repository"), "no-baseline refusal names what is missing");
      assert(out.includes("git init"), "no-baseline refusal names the fix");
    }

    // ---- Case 10: git repo before the first commit (round 5 blind spot) ----
    {
      console.log("\ngit repo with no commit (unresolvable HEAD) → exit 3 UNKNOWN");
      // Nothing staged, nothing committed — the shape where CLI 1.5.0 measured
      // a false `added:0` with a file pending (evidence §7). The guard refuses
      // on the unresolvable HEAD alone; the pending file additionally proves
      // the refusal is not an accidentally-clean answer.
      const root = makeFixture("nocommit");
      mkdirSync(join(root, "src"));
      writeFileSync(
        join(root, "src", "lib.mjs"),
        ["export function foc114ProbeTarget() {", "  return 1;", "}", ""].join("\n"),
      );
      const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
      git("init", "-b", "main");
      git("config", "user.email", "test@example.com");
      git("config", "user.name", "test");
      const init = spawnSync("codegraph", ["init", "."], { cwd: root, shell: true, encoding: "utf8" });
      assertEq(init.status, 0, "codegraph init succeeds in an unborn repo (fixture self-check)");
      writeFileSync(
        join(root, "src", "newer.mjs"),
        ["export function foc114UnbornPending() {", "  return 2;", "}", ""].join("\n"),
      );
      const probe = runWrapper(root, ["symbol", "foc114UnbornPending"]);
      const out = norm(probe.stdout) + norm(probe.stderr);
      assertEq(probe.status, 3, "unresolvable HEAD → exit 3 (never an answer from an unproven index)");
      assert(!out.includes("foc114UnbornPending"), "no-baseline refusal never names the queried symbol");
      assert(out.includes("unresolvable"), "no-baseline refusal names what is missing");
      assert(out.includes("git commit"), "no-baseline refusal names the fix");
    }

    // ---- Case 11: sync impossible (read-only DB) → exit 3, no-leak pinned ----
    {
      console.log("\nsync impossible (read-only index DB) → exit 3, refusal leaks no symbol");
      // Deterministic sync failure: the reviewer verified `attrib +R` makes
      // sync fail with "attempt to write a readonly database"; chmod 0o444 is
      // the same read-only bit cross-platform. This pins the no-leak property
      // on the sync-failed refusal (round-4 left it un-pinned; still-pending
      // has no deterministic trigger and stays reviewed-by-construction).
      const root = makeFixture("syncfail");
      buildIndexedFixture(root);
      writeFileSync(
        join(root, "src", "blocked.mjs"),
        ["export function foc114ProbeBlocked() {", "  return 3;", "}", ""].join("\n"),
      );
      const dbDir = join(root, ".codegraph");
      let probe = null;
      let locked = true;
      try {
        for (const f of readdirSync(dbDir)) chmodSync(join(dbDir, f), 0o444);
      } catch {
        locked = false;
      }
      if (!locked) {
        skip("sync-failed no-leak pin", "could not set the read-only bit on the index DB");
      } else {
        try {
          probe = runWrapper(root, ["symbol", "foc114ProbeBlocked"]);
        } finally {
          try {
            for (const f of readdirSync(dbDir)) chmodSync(join(dbDir, f), 0o666);
          } catch {
            /* restore best effort; cleanup retries below */
          }
        }
        const out = norm(probe.stdout) + norm(probe.stderr);
        assertEq(probe.status, 3, "failed sync → exit 3 (a refusal, never a false answer)");
        assert(!out.includes("foc114ProbeBlocked"), "sync-failed refusal never names the queried symbol (no-leak pin)");
        assert(out.includes("codegraph sync"), "sync-failed refusal names the fix (codegraph sync)");
      }
    }

    // ---- Case 12: repo path with a space — quoted ROOT survives shell:true ----
    {
      console.log("\nrepo path with a space (quoted ROOT under shell:true)");
      // shell:true hands the command line to cmd.exe unquoted; a space in the
      // repo path would misparse the sync positional and the --path value.
      // Quoting is round-5 hardening; this fixture proves both survive.
      const outer = mkdtempSync(join(tmpdir(), "codeintel-space-"));
      cleanupDirs.push(outer);
      const root = join(outer, "repo with space");
      mkdirSync(join(root, "scripts"), { recursive: true });
      copyFileSync(WRAPPER_SRC, join(root, "scripts", "code-intel.mjs"));
      mkdirSync(join(root, "src"));
      writeFileSync(
        join(root, "src", "lib.mjs"),
        ["export function foc114ProbeTarget() {", "  return 1;", "}", ""].join("\n"),
      );
      const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
      git("init", "-b", "main");
      git("config", "user.email", "test@example.com");
      git("config", "user.name", "test");
      git("add", "-A");
      git("commit", "-m", "init");
      const init = spawnSync("codegraph", ["init", "."], { cwd: root, shell: true, encoding: "utf8" });
      assertEq(init.status, 0, "codegraph init succeeds in a space-containing path (fixture self-check)");
      writeFileSync(
        join(root, "src", "newer.mjs"),
        ["export function foc114SpacePending() {", "  return 2;", "}", ""].join("\n"),
      );
      const probe = runWrapper(root, ["symbol", "foc114SpacePending"]);
      const out = norm(probe.stdout) + norm(probe.stderr);
      assertEq(probe.status, 0, "space-path repo: guarded query exits 0 (quoted sync + quoted --path both worked)");
      assert(out.includes("src/newer.mjs:1"), "space-path repo: pending symbol found after the quoted sync");
      assert(out.includes("synced before answering"), "space-path repo: guard's sync note present (the sync ran, quoted)");
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
