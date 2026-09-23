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
// Round 6 (2026-09-23 review corrections): the freshness verdict moved wholly
// into codegraph-runtime.mjs (the CLI's own copy had drifted — P2) and gained
// the exact-HEAD proof `.codegraph/synced-head` (P1): a BACKDATED commit and a
// BACKWARDS checkout both read pending 0/0/0 with an in-order lastIndexed, and
// both used to answer from the stale graph. Case 7c proves the fix on the CALL
// relationship with the real CLI (rev1 has no caller, rev2 adds one — a stale
// answer names the rev2 caller after checking rev1 out). Cases 17–19 pin the
// rest through the fake CLI: the stamp bootstrap (one sync, then none), the
// schema-stale refusal (a sync cannot close a schema gap; `codegraph index`
// can), and the bounded query (a hung CLI dies at --timeout into UNKNOWN).
//
// All fixtures live in temp directories; the wrapper is COPIED into each fixture
// (its ROOT is script-relative, so the copy pins the wrapper to the fixture tree).
// The real worktree tree is never used as a fixture and is never modified.

import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, readFileSync, chmodSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { makeFakeCodegraphCli } from "./fixtures/codegraph-fake-cli.mjs";

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
  // The wrapper imports its contract from ./codegraph-runtime.mjs — the copy
  // pins the runtime to the fixture tree too, exactly as it pins the wrapper.
  copyFileSync(join(__dirname, "codegraph-runtime.mjs"), join(root, "scripts", "codegraph-runtime.mjs"));
  return root;
}

// The wrapper takes the target from the CALLER'S cwd (git toplevel) or an
// explicit --project-root — never from the script's own location. So every
// fixture run must execute FROM the fixture root.
const runWrapper = (root, args, env = {}) =>
  spawnSync(process.execPath, [join(root, "scripts", "code-intel.mjs"), ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

// A committed baseline for a fixture — the shape every guarded query needs
// (round 5: pendingChanges is computed against git HEAD).
function gitInitFixture(root) {
  const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  writeFileSync(join(root, "README.md"), "fixture\n");
  git("add", "README.md");
  git("commit", "-m", "init");
}

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
    gitInitFixture(root); // the target must resolve before anything else can refuse
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
  // baseline, so this fixture still gets the specific not-on-PATH refusal,
  // not a baseline refusal. git itself must stay findable: the wrapper resolves
  // the target root WITH GIT before any CLI spawn, so a PATH that hid git too
  // would test root resolution, not the CLI probe.
  {
    console.log("\ncodegraph not on PATH (fixture with an empty .codegraph dir)");
    if (process.platform !== "win32") {
      // The win32 shell:true path is the one the defect lived on; POSIX falls
      // into the ENOENT branch, which Case 1's refusal shape already covers.
      skip("not-on-PATH", "win32-only spawn semantics (shell:true + cmd.exe)");
    } else {
      const root = makeFixture("nopath");
      gitInitFixture(root);
      mkdirSync(join(root, ".codegraph")); // requireIndex passes; the spawn is the test
      const gitDir = dirname(
        spawnSync("where", ["git"], { encoding: "utf8" }).stdout.trim().split(/\r?\n/)[0],
      );
      const r = runWrapper(root, ["symbol", "foc114GhostSymbol"], {
        PATH: [gitDir, "C:\\Windows\\System32"].join(";"),
      });
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

    // ---- Case 7b: a COMMIT after the sync (HEAD switch) — the pending-zero blind spot ----
    {
      console.log("\ncommitted HEAD switch through the wrapper (the pendingChanges blind spot)");
      // pendingChanges compares the tree against git HEAD: commit the current
      // tree and the counts read 0/0/0 while the index still predates the new
      // HEAD (measured 2026-09-23). Only the exact-HEAD stamp sees the switch —
      // the sha it recorded is the previous commit — so the guard re-proves with
      // one bounded sync; never a confident stale answer.
      const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
      git("add", "src"); // never a blind `git add -A`: it would baseline .codegraph
      git("commit", "-m", "second");
      settle(1000);
      const probe = runWrapper(root, ["symbol", "foc114ProbeTarget"]);
      const out = norm(probe.stdout) + norm(probe.stderr);
      assertEq(probe.status, 0, "guarded query after a commit exits 0 (the stamp mismatch settled it)");
      assert(out.includes("not proven for the current git HEAD"), "guard reports the stamp-mismatch sync");
      assert(out.includes("src/lib.mjs:6"), "post-switch answer still cites the current location");
    }

    // ---- Case 7c: the P1 false-fresh shapes, proven on the CALL graph ----
    {
      console.log("\nbackwards checkout + backdated commit (P1 false-fresh, call-graph end to end)");
      // Review 2026-09-23 P1: `lastIndexed >= HEAD commit time` could not tell
      // "synced after this HEAD" from "an OLDER revision was checked out / a
      // BACKDATED commit landed" — both read pending 0/0/0 with an in-order
      // lastIndexed, so the stale graph answered. The exact-HEAD stamp
      // (.codegraph/synced-head) closes both, and the proof here is the CALL
      // RELATIONSHIP, not just source lines: rev1 has NO caller for
      // focRevTarget, rev2 ADDS one — a stale answer would name the rev2
      // caller while HEAD is rev1.
      const revRoot = makeFixture("revswitch");
      mkdirSync(join(revRoot, "src"));
      writeFileSync(join(revRoot, "src", "lib.mjs"), 'export function focRevTarget() {\n  return 1;\n}\n');
      writeFileSync(join(revRoot, "src", "app.mjs"), 'export function focRevMain() {\n  return 0;\n}\n');
      const git = (...args) => spawnSync("git", args, { cwd: revRoot, encoding: "utf8" });
      git("init", "-b", "main");
      git("config", "user.email", "test@example.com");
      git("config", "user.name", "test");
      git("add", "src");
      git("commit", "-m", "first"); // rev1: nothing calls focRevTarget
      writeFileSync(
        join(revRoot, "src", "app.mjs"),
        'import { focRevTarget } from "./lib.mjs";\n\nexport function focRevMain() {\n  return focRevTarget();\n}\n',
      );
      git("add", "src");
      git("commit", "-m", "second"); // rev2: focRevMain calls focRevTarget
      const init = spawnSync("codegraph", ["init", "."], { cwd: revRoot, shell: true, encoding: "utf8" });
      assertEq(init.status, 0, "codegraph init at rev2 succeeds (fixture self-check)");
      settle(2000);

      // (a) rev2 through the wrapper: the caller relationship answers.
      const rev2 = runWrapper(revRoot, ["callers", "focRevTarget"]);
      const rev2Out = norm(rev2.stdout) + norm(rev2.stderr);
      assertEq(rev2.status, 0, "rev2 query exits 0 (guard bootstrapped the stamp)");
      assert(rev2Out.includes("focRevMain"), "rev2 answer names the caller (focRevMain)");

      // (b) BACKWARDS CHECKOUT to rev1: pending 0/0/0 (the tree matches HEAD
      // again), lastIndexed in-order — the old timestamp comparison called
      // this fresh; the recorded sha does not. One proof sync, and the CALL
      // GRAPH follows the checkout: no focRevMain caller at rev1.
      git("checkout", "HEAD~1");
      settle(2000);
      const rev1 = runWrapper(revRoot, ["callers", "focRevTarget"]);
      const rev1Out = norm(rev1.stdout) + norm(rev1.stderr);
      assertEq(rev1.status, 0, "backwards checkout: guard re-proved (one sync) and answered");
      assert(!rev1Out.includes("focRevMain"), "rev1 answer has NO focRevMain caller — the call graph followed the checkout");
      assert(rev1Out.includes("not proven for the current git HEAD"), "the stamp-mismatch sync is reported");

      // (c) BACKDATED COMMIT on top of rev2: identical tree, the commit clock
      // set to 2020 — pending 0 and a lastIndexed after every honest reading,
      // the exact shape the time comparison could not see. The stamp (rev1's
      // sha) vs the new HEAD decides.
      git("checkout", "-");
      spawnSync("git", ["commit", "--allow-empty", "-m", "backdated"], {
        cwd: revRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_COMMITTER_DATE: "2020-01-01T00:00:00",
          GIT_AUTHOR_DATE: "2020-01-01T00:00:00",
        },
      });
      const back = runWrapper(revRoot, ["callers", "focRevTarget"]);
      const backOut = norm(back.stdout) + norm(back.stderr);
      assertEq(back.status, 0, "backdated commit: guard re-proved (one sync) and answered");
      assert(backOut.includes("focRevMain"), "the rev2 caller relationship answers again (the tree is rev2)");
      assert(backOut.includes("not proven for the current git HEAD"), "the stamp-mismatch sync is reported");
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

    // ---- Case 9: no git at all — two refusals, both round-5 meaningful ----
    {
      console.log("\nno git baseline (no .git at the project root) → exit 3 UNKNOWN");
      // Round-4's fixtures always committed, so the guard's instrument was
      // truthful in every shipped test and the blind spots were invisible.
      // Measured (evidence §7), the CLI's pendingChanges is computed against a
      // git baseline and can report a false zero without one. Two shapes now:
      //
      //  (a) cwd-based targeting in a non-repo directory → the wrapper cannot
      //      even resolve a target root and refuses with the fix named. This is
      //      the 2026-09-23 root contract: NO fallback to the script location,
      //      no silent default — the wrong-checkout defect class, closed at the
      //      boundary.
      //  (b) an EXPLICIT --project-root at the same tree → the root resolves
      //      (explicit means the caller decided), the index check passes, and
      //      the ROUND-5 refusal fires on the missing git baseline itself.
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
      const cwdProbe = runWrapper(root, ["symbol", "foc114NogitPending"]);
      const cwdOut = norm(cwdProbe.stdout) + norm(cwdProbe.stderr);
      assertEq(cwdProbe.status, 3, "non-repo cwd → exit 3 (no root to check, so no answer either)");
      assert(!cwdOut.includes("foc114NogitPending"), "root refusal never names the queried symbol");
      assert(cwdOut.includes("Cannot determine the target project root"), "root refusal names what is missing");
      assert(cwdOut.includes("--project-root"), "root refusal names the fix");
      const probe = runWrapper(root, ["symbol", "foc114NogitPending", "--project-root", root]);
      const out = norm(probe.stdout) + norm(probe.stderr);
      assertEq(probe.status, 3, "explicit root without git → exit 3 (never an answer from an unproven index)");
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
      copyFileSync(join(__dirname, "codegraph-runtime.mjs"), join(root, "scripts", "codegraph-runtime.mjs"));
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

    // ---- Case 14: two repos — an explicit --project-root retargets EVERYTHING ----
    {
      console.log("\ntwo repos: --project-root B from cwd A answers about B, guard included");
      // A guard that checked A while the query hit B would be the exact
      // wrong-checkout hole: freshness proven for one tree, answered from
      // another. A distinct symbol per repo makes the target observable.
      const rootB = makeFixture("repo-b");
      mkdirSync(join(rootB, "src"));
      writeFileSync(
        join(rootB, "src", "other.mjs"),
        ["export function foc114OtherRepoSymbol() {", "  return 9;", "}", ""].join("\n"),
      );
      const gitB = (...args) => spawnSync("git", args, { cwd: rootB, encoding: "utf8" });
      gitB("init", "-b", "main");
      gitB("config", "user.email", "test@example.com");
      gitB("config", "user.name", "test");
      gitB("add", "src");
      gitB("commit", "-m", "init");
      const initB = spawnSync("codegraph", ["init", "."], { cwd: rootB, shell: true, encoding: "utf8" });
      assertEq(initB.status, 0, "codegraph init in repo B succeeds (fixture self-check)");
      // Run FROM repo A (cwd), targeted AT repo B.
      const probe = runWrapper(root, ["symbol", "foc114OtherRepoSymbol", "--project-root", rootB]);
      const out = norm(probe.stdout) + norm(probe.stderr);
      assertEq(probe.status, 0, "explicit --project-root B answers from B");
      assert(out.includes("foc114OtherRepoSymbol"), "the answer names B's symbol");
      assert(out.includes("src/other.mjs"), "the answer cites B's file");
    }

    // ---- Case 15: a linked worktree targets THE WORKTREE, never the main checkout ----
    {
      console.log("\nlinked worktree: cwd resolution and one-index-per-worktree");
      // The wrong-main-root defect this whole contract closes: invoked from a
      // worktree, the wrapper used to query the script-location checkout and
      // the wrong tree answered confidently. Two pins:
      //  (a) before the worktree has its own index: a refusal naming THE
      //      WORKTREE — never a silent answer from the main repo's index;
      //  (b) after bootstrap: the answer comes from the worktree's own index.
      const wtOuter = mkdtempSync(join(tmpdir(), "codeintel-wt-"));
      cleanupDirs.push(wtOuter);
      const main = join(wtOuter, "main");
      mkdirSync(main);
      const gitM = (...args) => spawnSync("git", args, { cwd: main, encoding: "utf8" });
      gitM("init", "-b", "main");
      gitM("config", "user.email", "test@example.com");
      gitM("config", "user.name", "test");
      mkdirSync(join(main, "scripts"));
      copyFileSync(WRAPPER_SRC, join(main, "scripts", "code-intel.mjs"));
      copyFileSync(join(__dirname, "codegraph-runtime.mjs"), join(main, "scripts", "codegraph-runtime.mjs"));
      mkdirSync(join(main, "src"));
      writeFileSync(
        join(main, "src", "wt.mjs"),
        ["export function foc114WtSymbol() {", "  return 5;", "}", ""].join("\n"),
      );
      gitM("add", "src", "scripts");
      gitM("commit", "-m", "init");
      const initM = spawnSync("codegraph", ["init", "."], { cwd: main, shell: true, encoding: "utf8" });
      assertEq(initM.status, 0, "codegraph init in main repo succeeds (fixture self-check)");
      const wt = join(wtOuter, "wt");
      spawnSync("git", ["worktree", "add", wt], { cwd: main, encoding: "utf8" });
      // (a) no index in the worktree yet → refusal naming THE WORKTREE root.
      const noIndex = runWrapper(wt, ["symbol", "foc114WtSymbol"]);
      const noIndexOut = norm(noIndex.stdout) + norm(noIndex.stderr);
      assertEq(noIndex.status, 3, "worktree without its own index refuses (never borrows main's)");
      assert(noIndexOut.includes(norm(wt)), "the refusal names THE WORKTREE as the target");
      assert(
        !/foc114WtSymbol/.test(noIndexOut.split(norm(wt)).join("")),
        "refusal never names the queried symbol",
      );
      // (b) bootstrap the worktree's own index → the answer comes from it.
      const initWt = spawnSync("codegraph", ["init", "."], { cwd: wt, shell: true, encoding: "utf8" });
      assertEq(initWt.status, 0, "codegraph init in the worktree succeeds (bootstrap)");
      const probe = runWrapper(wt, ["symbol", "foc114WtSymbol"]);
      const out = norm(probe.stdout) + norm(probe.stderr);
      assertEq(probe.status, 0, "worktree query answers from the worktree's own index");
      assert(out.includes("src/wt.mjs"), "the answer cites the worktree's file");
    }
  }

  // ---- Case 13: `--path` passthrough is rejected — it would bypass the guard ----
  // Needs no codegraph at all: the refusal fires before anything is spawned.
  {
    console.log("\n--path passthrough rejection");
    const root = makeFixture("pathflag");
    gitInitFixture(root);
    for (const spelling of [
      ["symbol", "focX", "--path", join(root, "elsewhere")],
      ["symbol", "focX", "--path=" + join(root, "elsewhere")],
    ]) {
      const r = runWrapper(root, spelling);
      const out = norm(r.stdout) + norm(r.stderr);
      assertEq(r.status, 2, `exit 2 for: ${spelling.join(" ")}`);
      assert(out.includes("--path` is not accepted"), "the refusal names the flag");
      assert(out.includes("--project-root"), "the refusal names the sanctioned spelling");
    }
  }

  // ---- Case 16: same-root pin, end to end — the fake CLI's invocation log ----
  // The real CLI cannot show WHICH root its status/sync/query addressed; a
  // wrong root answers confidently, which is the defect. The fake shim
  // (unwrapped through the same .cmd path production takes on win32) logs
  // every invocation, so this pins the ONE-root contract for
  // baseline+status+sync+query together — for the cwd-derived root AND for an
  // explicit --project-root that disagrees with the cwd.
  {
    console.log("\nsame-root pin (fake CLI log: status/sync/query address one root)");
    const holder = mkdtempSync(join(tmpdir(), "codeintel-fakecli-"));
    cleanupDirs.push(holder);
    const logPath = join(holder, "calls.log");
    const fake = makeFakeCodegraphCli({ dir: join(holder, "bin"), mode: "dirty", logPath });
    const envWithFake = {
      PATH: [fake.dir, process.env.PATH].join(";"),
      ...fake.env,
    };
    const fixture = makeFixture("sameroot");
    gitInitFixture(fixture);
    mkdirSync(join(fixture, ".codegraph")); // requireIndex passes; the fake provides status
    // The fake's own "index present" marker + a dirty one: status must report
    // initialized-with-pending so the guard runs its sync → re-check → answer
    // sequence end to end.
    writeFileSync(join(fixture, ".codegraph", "fake-initialized"), "1\n");
    writeFileSync(join(fixture, ".codegraph", "fake-dirty"), "1\n");
    const probe = runWrapper(fixture, ["symbol", "focSameRootProbe"], envWithFake);
    const out = norm(probe.stdout) + norm(probe.stderr);
    assertEq(probe.status, 0, "guarded query exits 0 through the fake CLI (dirty → sync → answer)");
    const calls = fake.readLog(readFileSync).filter((c) => c.cmd !== "init");
    assert(calls.length >= 4, "status, sync, status and the query all ran");
    // The root each invocation addressed: the positional for status/sync, the
    // value after --path for query verbs.
    const rootOf = (c) =>
      norm(c.args[c.cmd === "status" || c.cmd === "sync" ? 0 : c.args.indexOf("--path") + 1]);
    const roots = new Set(calls.map(rootOf));
    assertEq(roots.size, 1, "every codegraph invocation addressed exactly ONE root");
    assert([...roots][0].endsWith(norm(fixture).split("/").pop()), "and that root is the fixture (the cwd's toplevel)");
    const q = calls.find((c) => c.cmd === "node");
    assert(q && norm(q.args[q.args.length - 1]).includes(norm(fixture)), "the query verb carried the same root via --path");
    assert(out.includes("synced before answering"), "the guard's sync note printed for the dirty marker");

    // Same pin with an explicit --project-root: cwd is the fixture, the target
    // is another directory — every invocation must follow the flag, not cwd.
    const other = makeFixture("sameroot-other");
    gitInitFixture(other);
    mkdirSync(join(other, ".codegraph"));
    writeFileSync(join(other, ".codegraph", "fake-initialized"), "1\n");
    writeFileSync(join(other, ".codegraph", "fake-dirty"), "1\n");
    writeFileSync(logPath, ""); // fresh log
    const probe2 = runWrapper(fixture, ["symbol", "focSameRootProbe", "--project-root", other], envWithFake);
    assertEq(probe2.status, 0, "explicit --project-root query exits 0 through the fake CLI");
    const calls2 = fake.readLog(readFileSync).filter((c) => c.cmd !== "init");
    assert(calls2.length >= 4, "the full guard sequence ran for the explicit root too");
    const roots2 = new Set(calls2.map(rootOf));
    assertEq(roots2.size, 1, "one root again");
    assert([...roots2][0].endsWith(norm(other).split("/").pop()), "and it is the --project-root target, not the cwd");
  }

  // ---- Case 17: the stamp bootstrap — first query syncs ONCE, the clean query none ----
  // The exact-HEAD proof is a per-worktree artifact, so its lifecycle is pinned
  // end to end through the fake CLI's invocation log: a first query on a
  // stamp-less index pays ONE bounded sync and writes the stamp into the
  // TARGET's .codegraph; a second query on the unchanged tree pays none —
  // proof, not a per-query rebuild.
  {
    console.log("\nstamp bootstrap (fake CLI log: one proof sync, then none)");
    const holder = mkdtempSync(join(tmpdir(), "codeintel-stamp-"));
    cleanupDirs.push(holder);
    const logPath = join(holder, "calls.log");
    const fake = makeFakeCodegraphCli({ dir: join(holder, "bin"), mode: "ready", logPath });
    const envWithFake = {
      PATH: [fake.dir, process.env.PATH].join(";"),
      ...fake.env,
    };
    const fixture = makeFixture("stampboot");
    gitInitFixture(fixture);
    mkdirSync(join(fixture, ".codegraph"));
    writeFileSync(join(fixture, ".codegraph", "fake-initialized"), "1\n");
    const first = runWrapper(fixture, ["symbol", "focStampProbe"], envWithFake);
    assertEq(first.status, 0, "first query exits 0 (the missing stamp cost one bounded sync)");
    const firstLog = fake.readLog(readFileSync);
    assert(firstLog.some((c) => c.cmd === "sync"), "the missing stamp caused ONE sync");
    assert(firstLog.some((c) => c.cmd === "node"), "and the query ran after it");
    assert(
      existsSync(join(fixture, ".codegraph", "synced-head")),
      "the stamp was written into the TARGET's own .codegraph (per-worktree proof)",
    );

    writeFileSync(logPath, ""); // fresh log
    const second = runWrapper(fixture, ["symbol", "focStampProbe"], envWithFake);
    const secondOut = norm(second.stdout) + norm(second.stderr);
    assertEq(second.status, 0, "clean query on a proven stamp exits 0");
    const secondLog = fake.readLog(readFileSync);
    assert(!secondLog.some((c) => c.cmd === "sync"), "a proven stamp answers with ZERO syncs — no per-query rebuild");
    assert(!secondOut.includes("synced before answering"), "no sync note for a proven-fresh query");
    assert(secondLog.some((c) => c.cmd === "node"), "and the query answered");
  }

  // ---- Case 18: schema-stale index — queries refuse; only a rebuild clears it ----
  // The fake's `schema` mode reports the schema-stale `index` block
  // (reindexRecommended=true, a mismatched extraction pair, state/pendingRefs)
  // until a rebuild writes its marker — `sync` deliberately never does. The
  // wrapper must refuse (a sync cannot close a schema gap), name the fix
  // (`codegraph index` — full rebuild), leak no symbol, and answer once the
  // rebuild landed.
  {
    console.log("\nschema-stale index (fake CLI): queries refuse; a rebuild clears it");
    const holder = mkdtempSync(join(tmpdir(), "codeintel-schema-"));
    cleanupDirs.push(holder);
    const logPath = join(holder, "calls.log");
    const fake = makeFakeCodegraphCli({ dir: join(holder, "bin"), mode: "schema", logPath });
    const envWithFake = {
      PATH: [fake.dir, process.env.PATH].join(";"),
      ...fake.env,
    };
    const fixture = makeFixture("schemastale");
    gitInitFixture(fixture);
    mkdirSync(join(fixture, ".codegraph"));
    writeFileSync(join(fixture, ".codegraph", "fake-initialized"), "1\n"); // NO fake-schema-ok
    const probe = runWrapper(fixture, ["symbol", "focSchemaProbe"], envWithFake);
    const out = norm(probe.stdout) + norm(probe.stderr);
    assertEq(probe.status, 3, "schema-stale index → exit 3 (refused, never a confidently wrong answer)");
    assert(!out.includes("focSchemaProbe"), "refusal never names the queried symbol");
    assert(out.includes("index-schema-stale"), "refusal names the schema state");
    assert(out.includes("reindexRecommended"), "refusal carries the instrument's own signal");
    assert(out.includes("codegraph index"), "refusal names the fix (codegraph index — full rebuild)");
    const log = fake.readLog(readFileSync);
    assert(!log.some((c) => c.cmd === "sync"), "a sync cannot close a schema gap — none ran");
    assert(!log.some((c) => c.cmd === "node"), "the query never spawned");

    // The fix, applied — what `codegraph index <project-root>` does to the marker:
    writeFileSync(join(fixture, ".codegraph", "fake-schema-ok"), "ok\n");
    const after = runWrapper(fixture, ["symbol", "focSchemaProbe"], envWithFake);
    assertEq(after.status, 0, "after the rebuild the query answers (exit 0)");
  }

  // ---- Case 19: a hung query is BOUNDED — --timeout kills it into UNKNOWN ----
  // The fake's `hang` mode answers status/sync normally and never answers a
  // query verb (it outlives any sane budget). The wrapper must die at its own
  // budget and refuse — a wrapper that can hang is not a guarded one.
  {
    console.log("\nhung query (fake CLI hang mode): --timeout refuses instead of hanging");
    const holder = mkdtempSync(join(tmpdir(), "codeintel-hang-"));
    cleanupDirs.push(holder);
    const logPath = join(holder, "calls.log");
    const fake = makeFakeCodegraphCli({ dir: join(holder, "bin"), mode: "hang", logPath });
    const envWithFake = {
      PATH: [fake.dir, process.env.PATH].join(";"),
      ...fake.env,
    };
    const fixture = makeFixture("hangquery");
    gitInitFixture(fixture);
    mkdirSync(join(fixture, ".codegraph"));
    writeFileSync(join(fixture, ".codegraph", "fake-initialized"), "1\n");
    const t0 = Date.now();
    const probe = runWrapper(fixture, ["symbol", "focHangProbe", "--timeout", "5000"], envWithFake);
    const elapsed = Date.now() - t0;
    const out = norm(probe.stdout) + norm(probe.stderr);
    assertEq(probe.status, 3, "a hung query is killed at the budget and refused (UNKNOWN)");
    assert(elapsed < 20_000, `bounded: refused in ${elapsed}ms — never the fake's 30s+ eternity`);
    assert(out.includes("did not answer within 5000ms"), "the refusal names the budget");
    assert(!out.includes("focHangProbe"), "refusal never names the queried symbol");
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
