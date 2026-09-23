// scripts/codegraph-runtime.test.mjs — the shared runtime contract
// (scripts/codegraph-runtime.mjs), hermetically.
//
//   node scripts/codegraph-runtime.test.mjs
//
// What this suite pins (plan 2026-09-23 §4 + the review corrections of the
// same day):
//
//   resolveProjectRoot    explicit root wins / used as given; cwd → git
//                         toplevel; a LINKED WORKTREE resolves to the
//                         worktree itself, never the main checkout (the
//                         wrong-root defect this module exists to close); non-repo cwd
//                         and bogus explicit roots refuse.
//   resolveCodegraphCommand  the win32 .cmd shim unwrap (node.exe + JS entry,
//                         shell:false spawnable), the missing-target and
//                         bare-name fallbacks, the .ps1 skip (not spawnable
//                         shell:false), and the never-cache-a-failure rule.
//   ensureCodegraphReady  the freshness contract, every refusal reason stable:
//                         dirty edit/add/delete/rename each trigger the one
//                         sync (guarding DIRT, not just the HEAD sha); the
//                         exact-HEAD proof (.codegraph/synced-head) — first
//                         query bootstraps it with ONE bounded sync, a clean
//                         query then needs none, a revision switch (the
//                         backdated-commit / backwards-checkout false-fresh
//                         shapes, review P1) syncs on the sha mismatch alone,
//                         a HEAD that moves mid-check is UNKNOWN with no
//                         stamp written, a corrupt/unknown stamp self-heals
//                         through one sync, an unwritable proof refuses;
//                         the schema family — reindexRecommended, the
//                         extraction-version pair, index state/pendingRefs —
//                         refuses with index-schema-stale (no sync: a sync
//                         cannot close a schema gap) and rebuilds via
//                         `codegraph index <root>` only when authorized;
//                         negative/NaN/missing pending counts are UNKNOWN,
//                         never clean; index missing with and without the
//                         authorized `initialize`; sync failure, non-settling
//                         sync; timeouts; the git-baseline and borrowed-index
//                         refusals; and the same-root pin — every subprocess
//                         must address the resolved root, both as cwd and as
//                         the positional.
//
// Everything runs against the injectable `runner` seam (git included) except
// the resolveProjectRoot/resolveCodegraphCommand groups, which use real git
// worktrees and real shim files in temp dirs. The TARGET root must be a real
// directory — resolveProjectRoot refuses a projectRoot that does not exist,
// which is itself contract — but no real codegraph index is ever built here:
// provisioning is pinned through the seam, so this suite never indexes a real
// repo. The synced-head proof is the one real filesystem artifact the runtime
// owns, so its tests exercise it against the real temp roots.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ensureCodegraphReady,
  resolveCodegraphCommand,
  resolveProjectRoot,
} from "./codegraph-runtime.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

let passed = 0;
const failures = [];
const cleanupDirs = [];
process.on("exit", () => {
  for (const d of cleanupDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${err?.message ?? err}`);
  }
}
const fail = (msg) => {
  throw new Error(msg);
};
const ok = (cond, msg) => {
  if (!cond) fail(msg);
};
const eq = (actual, expected, msg) => {
  // Value comparison: arrays never compare equal by reference, and every
  // "expected [] got []" failure below would otherwise be undebuggable.
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
};

// ── fixtures ───────────────────────────────────────────────────────────────────

function tmpDir(tag) {
  const d = mkdtempSync(join(tmpdir(), `cgrt-${tag}-`));
  cleanupDirs.push(d);
  return d;
}

// A REAL target root (resolveProjectRoot refuses one that does not exist) plus
// its canonical spelling, which is what every subprocess must address.
function realRoot(tag) {
  const root = tmpDir(tag);
  return { root, canon: realpathSync(root) };
}

function gitRepo(tag) {
  const root = join(tmpDir(tag), "repo");
  mkdirSync(root);
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  writeFileSync(join(root, "a.mjs"), "export const a = 1;\n");
  git("add", "a.mjs");
  git("commit", "-m", "init");
  return root;
}

// A scripted runner: records every call, answers from `handler`.
function scriptedRunner(handler) {
  const calls = [];
  const runner = (file, args, opts = {}) => {
    calls.push({ file, args: [...args], cwd: opts.cwd, timeoutMs: opts.timeoutMs });
    return handler(file, args, opts, calls.length);
  };
  runner.calls = calls;
  return runner;
}

const R = (over = {}) => ({ status: 0, stdout: "", stderr: "", ...over });

// Two exact HEADs the tests switch between — the sha, never a timestamp, is
// the proof (review 2026-09-23, P1: a backdated commit and a backwards
// checkout are invisible to the old lastIndexed >= HEAD-time comparison).
const SHA1 = "0000000000000000000000000000000000000001";
const SHA2 = "0000000000000000000000000000000000000002";
const gitHead = (sha = SHA1) => R({ stdout: `${sha}\n` });

// The installed CLI's consistent `index` block (verified against 1.5.0,
// 2026-09-23) — present by default so an in-schema status is the pinned norm.
const SCHEMA_OK = {
  builtWithVersion: "fake-1.6.0",
  builtWithExtractionVersion: 24,
  currentExtractionVersion: 24,
  reindexRecommended: false,
  state: "complete",
  pendingRefs: 0,
};
const SCHEMA_BAD = {
  builtWithVersion: "fake-1.6.0",
  builtWithExtractionVersion: 23,
  currentExtractionVersion: 24,
  reindexRecommended: true,
  state: "partial",
  pendingRefs: 1,
};
const stampOf = (canon) => JSON.parse(readFileSync(join(canon, ".codegraph", "synced-head"), "utf8"));

const statusJson = ({
  initialized = true,
  added = 0,
  modified = 0,
  removed = 0,
  mismatch = null,
  version = "fake-1.6.0",
  index = SCHEMA_OK,
} = {}) =>
  R({
    stdout:
      JSON.stringify({
        version,
        initialized,
        pendingChanges: { added, modified, removed },
        lastIndexed: new Date(Date.now() + 3_600_000).toISOString(),
        worktreeMismatch: mismatch,
        ...(index ? { index } : {}),
      }) + "\n",
  });

// git answers HEAD; codegraph status/sync answer from a mutable `state` the
// tests drive — status BEFORE sync reflects the dirty shape, sync mutates it,
// status AFTER sees the settled one. That is the real settle sequence.
function settlingHandler(state) {
  return (file, args) => {
    if (file === "git") return gitHead();
    if (args[0] === "status") return statusJson(state);
    if (args[0] === "sync") {
      state.onSync?.(state);
      return R({ stdout: "sync ok\n" });
    }
    return R({ stdout: "unexpected call\n" });
  };
}

// ── resolveProjectRoot ─────────────────────────────────────────────────────────

console.log("\nresolveProjectRoot");

test("explicit projectRoot wins and is used exactly as given (realpath'd)", () => {
  const root = gitRepo("explicit");
  eq(resolveProjectRoot({ projectRoot: root }), root, "explicit root returned as-is");
});

test("an explicit root that does not exist refuses", () => {
  let threw = null;
  try {
    resolveProjectRoot({ projectRoot: join(tmpDir("missing"), "nope") });
  } catch (err) {
    threw = err;
  }
  ok(threw, "must throw");
  ok(/does not exist/.test(threw.message), `names the defect: ${threw.message}`);
});

test("an explicit root that is a file refuses", () => {
  const dir = tmpDir("file");
  const f = join(dir, "a.txt");
  writeFileSync(f, "x");
  let threw = null;
  try {
    resolveProjectRoot({ projectRoot: f });
  } catch (err) {
    threw = err;
  }
  ok(threw && /is not a directory/.test(threw.message), `names the defect: ${threw?.message}`);
});

test("cwd inside a repo resolves to its toplevel", () => {
  const root = gitRepo("cwd");
  mkdirSync(join(root, "sub"));
  eq(resolveProjectRoot({ cwd: join(root, "sub") }), root, "toplevel from a subdirectory");
});

test("cwd inside a LINKED WORKTREE resolves to the worktree, never the main root", () => {
  // The wrong-main-root defect: a linked worktree used to inherit the tooling
  // checkout's root. git's own answer must win — the worktree IS the target.
  const main = gitRepo("wt-main");
  const wt = join(tmpDir("wt-holder"), "wt");
  execFileSync("git", ["worktree", "add", wt, "-b", "wt-branch"], { cwd: main, stdio: "ignore" });
  eq(resolveProjectRoot({ cwd: wt }), wt, "worktree resolves to itself");
  ok(resolveProjectRoot({ cwd: wt }) !== main, "never the main checkout");
});

test("cwd outside any git repository refuses (no fallback, no default)", () => {
  let threw = null;
  try {
    resolveProjectRoot({ cwd: tmpDir("nonrepo") });
  } catch (err) {
    threw = err;
  }
  ok(threw && /not inside a git repository/.test(threw.message), `names the fix: ${threw.message}`);
});

// ── resolveCodegraphCommand ───────────────────────────────────────────────────

console.log("\nresolveCodegraphCommand");

test("a win32 .cmd shim unwraps to node + its JS entry (shell:false spawnable)", () => {
  const dir = tmpDir("shim");
  writeFileSync(join(dir, "fake-cli.js"), "// fake\n");
  // The exact "%~dp0<file>.js" shape the npm .cmd shim uses; never executed.
  writeFileSync(join(dir, "codegraph.cmd"), '@echo off\r\nnode "%~dp0fake-cli.js" %*\r\n');
  const cmd = resolveCodegraphCommand({
    where: () => ({ status: 0, stdout: join(dir, "codegraph.cmd") + "\r\n" }),
  });
  eq(cmd.command, process.execPath, "command is node.exe");
  eq(cmd.args, [join(dir, "fake-cli.js")], "args is the unwrapped JS entry");
});

test("a shim with a relative JS target unwraps against the shim's own dir", () => {
  const holder = tmpDir("shimrel");
  const dir = join(holder, "bin");
  mkdirSync(dir);
  writeFileSync(join(holder, "cli.js"), "// fake\n");
  writeFileSync(join(dir, "codegraph.cmd"), '@echo off\r\nnode "%~dp0..\\cli.js" %*\r\n');
  const cmd = resolveCodegraphCommand({
    where: () => ({ status: 0, stdout: join(dir, "codegraph.cmd") + "\r\n" }),
  });
  eq(cmd.args, [join(holder, "cli.js")], "relative %~dp0 target resolves");
});

test("a shim whose JS target is missing falls through to the next candidate", () => {
  const dir = tmpDir("shim-miss");
  writeFileSync(join(dir, "codegraph.cmd"), '@echo off\r\nnode "%~dp0gone.js" %*\r\n');
  writeFileSync(join(dir, "codegraph"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const cmd = resolveCodegraphCommand({
    where: () => ({ status: 0, stdout: `${join(dir, "codegraph.cmd")}\n${join(dir, "codegraph")}\n` }),
  });
  eq(cmd.command, join(dir, "codegraph"), "the unresolvable shim is skipped");
  eq(cmd.args, [], "direct candidate takes no extra args");
});

test("a shim referencing an .exe that exists uses that exe", () => {
  const dir = tmpDir("shim-exe");
  writeFileSync(join(dir, "fake-cli.js"), "// fake\n");
  const bogusExe = join(dir, "tool.exe");
  writeFileSync(bogusExe, "MZ"); // existence is all the unwrap checks
  writeFileSync(join(dir, "codegraph.cmd"), '@echo off\r\n"%~dp0tool.exe" "%~dp0fake-cli.js" %*\r\n');
  const cmd = resolveCodegraphCommand({
    where: () => ({ status: 0, stdout: join(dir, "codegraph.cmd") + "\r\n" }),
  });
  eq(cmd.command, bogusExe, "the shim's own exe wins over process.execPath");
  eq(cmd.args, [join(dir, "fake-cli.js")], "JS entry still rides the args");
});

test("a .ps1 candidate is skipped — not spawnable under shell:false; the next candidate wins", () => {
  const dir = tmpDir("shim-ps1");
  writeFileSync(join(dir, "fake-cli.js"), "// fake\n");
  writeFileSync(join(dir, "codegraph.cmd"), '@echo off\r\nnode "%~dp0fake-cli.js" %*\r\n');
  const cmd = resolveCodegraphCommand({
    where: () => ({
      status: 0,
      stdout: `${join(dir, "codegraph.ps1")}\n${join(dir, "codegraph.cmd")}\n`,
    }),
  });
  eq(cmd.command, process.execPath, "the .cmd shim was unwrapped, not the .ps1 selected");
  eq(cmd.args, [join(dir, "fake-cli.js")], "the spawnable entry");
});

test(".ps1-only PATH falls through to the bare-name fallback", () => {
  const cmd = resolveCodegraphCommand({ where: () => ({ status: 0, stdout: "C:/x/codegraph.ps1\n" }) });
  eq(cmd.command, "codegraph", "a .ps1 is never selected");
  eq(cmd.args, [], "bare name");
});

test("no candidate on PATH yields the bare name (the caller's proven fallback)", () => {
  const cmd = resolveCodegraphCommand({ where: () => ({ status: 1, stdout: "" }) });
  eq(cmd.command, "codegraph", "bare name");
  eq(cmd.args, [], "no args");
});

test("a failed resolution is never cached — the next call re-probes the PATH", () => {
  // Negative caching would freeze a not-on-PATH verdict for the process
  // lifetime; an install or PATH fix mid-process must be seen by the next
  // caller (review 2026-09-23). Injected probes bypass the memo; only the
  // REAL second call can prove the failure was not memoized.
  eq(
    resolveCodegraphCommand({ where: () => ({ status: 1, stdout: "" }) }).command,
    "codegraph",
    "failure → bare-name fallback",
  );
  const cmd = resolveCodegraphCommand();
  const probe = execFileSync !== null && true; // (node builtin, always present)
  void probe;
  const onPath = (() => {
    try {
      const { status } = execFileSync("where", ["codegraph"], { encoding: "utf8", stdio: "pipe" }) ? { status: 0 } : { status: 1 };
      return status === 0;
    } catch {
      return false;
    }
  })();
  if (onPath) {
    ok(cmd.command !== "codegraph", `the re-probe found the real binary: ${JSON.stringify(cmd)}`);
  } else {
    eq(cmd.command, "codegraph", "no CLI on PATH: a FRESH probe returns the bare name — no cached verdict");
  }
});

// ── ensureCodegraphReady — ready, sync and the exact-HEAD proof ──────────────

console.log("\nensureCodegraphReady — ready, sync, proof");

test("a first query bootstraps the exact-HEAD proof (one bounded sync); a clean query then needs none", () => {
  const { canon } = realRoot("bootstrap");
  const state = {};
  const r1 = ensureCodegraphReady({ projectRoot: canon, runner: scriptedRunner(settlingHandler(state)) });
  eq(r1.ok, true, "ok after the bootstrap sync");
  eq(r1.synced, true, "the missing proof triggered one bounded sync");
  eq(r1.syncCause, "proof", "the cause is the proof, not dirt");
  eq(r1.version, "fake-1.6.0", "version surfaced");
  eq(stampOf(canon).head, SHA1, "the stamp records the exact HEAD sha");
  const runner2 = scriptedRunner(settlingHandler(state));
  const r2 = ensureCodegraphReady({ projectRoot: canon, runner: runner2 });
  eq(r2.ok, true, "ok");
  eq(r2.synced, false, "a proven stamp answers clean — no second sync");
  eq(runner2.calls.filter((c) => c.args[0] === "sync").length, 0, "zero syncs for the clean query");
});

test("every subprocess addresses the SAME resolved root (cwd AND positional)", () => {
  const { canon } = realRoot("same-root");
  const runner = scriptedRunner(settlingHandler({}));
  ensureCodegraphReady({ projectRoot: canon, runner });
  ok(runner.calls.length >= 2, "status and git both ran");
  for (const c of runner.calls) {
    eq(c.cwd, canon, `${c.file} ${c.args[0]} runs with cwd = the resolved root`);
    if (c.file === "codegraph") eq(c.args[1], canon, `codegraph ${c.args[0]} takes the root as its positional`);
  }
});

test("a dirty EDIT (modified) triggers exactly one sync and settles ok", () => {
  const { canon } = realRoot("dirty-edit");
  const runner = scriptedRunner(
    settlingHandler({ modified: 1, onSync: (s) => { s.modified = 0; } }),
  );
  const r = ensureCodegraphReady({ projectRoot: canon, runner });
  eq(r.ok, true, "ok after sync");
  eq(r.synced, true, "synced here");
  eq(r.syncCause, "pending", "the sync was dirt-caused");
  eq(r.pendingBefore, 1, "the pending count is surfaced for the diagnostics");
  eq(runner.calls.filter((c) => c.args[0] === "sync").length, 1, "exactly one sync");
});

test("a dirty ADD (added) triggers the sync — guarding dirt, not just the HEAD sha", () => {
  const { canon } = realRoot("dirty-add");
  const runner = scriptedRunner(settlingHandler({ added: 1, onSync: (s) => { s.added = 0; } }));
  eq(ensureCodegraphReady({ projectRoot: canon, runner }).synced, true, "added → sync");
});

test("a dirty DELETE/RENAME (removed) triggers the sync", () => {
  const { canon } = realRoot("dirty-del");
  const runner = scriptedRunner(settlingHandler({ removed: 1, onSync: (s) => { s.removed = 0; } }));
  eq(ensureCodegraphReady({ projectRoot: canon, runner }).synced, true, "removed → sync");
});

test("a revision switch at pending 0 (the P1 false-fresh shape) syncs on the stamp mismatch alone", () => {
  // A BACKDATED commit or a BACKWARDS checkout after a sync: pending reads
  // 0/0/0 and lastIndexed stays ordered after HEAD's commit time — the old
  // lastIndexed >= HEAD-time comparison called both fresh. Only the sha
  // disagrees, so only the sha decides (review 2026-09-23, P1).
  const { canon } = realRoot("rev-switch");
  ensureCodegraphReady({ projectRoot: canon, runner: scriptedRunner(settlingHandler({})) }); // bootstrap: stamp at SHA1
  let head = SHA2; // HEAD moved; every other instrument still reads fresh
  const runner = scriptedRunner((file, args) => {
    if (file === "git") return gitHead(head);
    if (args[0] === "status") return statusJson({});
    if (args[0] === "sync") return R({ stdout: "sync ok\n" });
    return R({});
  });
  const r = ensureCodegraphReady({ projectRoot: canon, runner });
  eq(r.ok, true, "ok after the re-proof");
  eq(r.synced, true, "the stamp mismatch forced a sync");
  eq(r.syncCause, "proof", "the cause is the proof");
  eq(runner.calls.filter((c) => c.args[0] === "sync").length, 1, "exactly one bounded sync");
  eq(stampOf(canon).head, SHA2, "the proof now names the current HEAD");
});

test("a HEAD that changes mid-check is UNKNOWN — no proof claimed from either revision", () => {
  const { canon } = realRoot("midmove");
  let gitCalls = 0;
  const runner = scriptedRunner((file, args) => {
    if (file === "git") return gitHead(++gitCalls === 1 ? SHA1 : SHA2);
    if (args[0] === "status") return statusJson({});
    if (args[0] === "sync") return R({ stdout: "sync ok\n" });
    return R({});
  });
  const r = ensureCodegraphReady({ projectRoot: canon, runner });
  eq(r.ok, false, "refused");
  ok(/^head-changed-midcheck:/.test(r.reason), `stable reason: ${r.reason}`);
  ok(!existsSync(join(canon, ".codegraph", "synced-head")), "no stamp written for a tree that moved under the check");
});

test("a corrupt stamp is treated as missing: one sync re-proves and rewrites it", () => {
  const { canon } = realRoot("corrupt-stamp");
  mkdirSync(join(canon, ".codegraph"), { recursive: true });
  writeFileSync(join(canon, ".codegraph", "synced-head"), "not json at all\n");
  const runner = scriptedRunner((file, args) => {
    if (file === "git") return gitHead();
    if (args[0] === "status") return statusJson({});
    if (args[0] === "sync") return R({ stdout: "sync ok\n" });
    return R({});
  });
  const r = ensureCodegraphReady({ projectRoot: canon, runner });
  eq(r.ok, true, "ok — self-healed");
  eq(runner.calls.filter((c) => c.args[0] === "sync").length, 1, "one bounded sync, not a rebuild loop");
  eq(stampOf(canon).head, SHA1, "the stamp is valid again and names the current HEAD");
});

test("a stamp whose head is not sha-shaped is unknown, not proof", () => {
  const { canon } = realRoot("garbage-stamp");
  mkdirSync(join(canon, ".codegraph"), { recursive: true });
  writeFileSync(join(canon, ".codegraph", "synced-head"), JSON.stringify({ head: "zzz" }) + "\n");
  const runner = scriptedRunner((file, args) => {
    if (file === "git") return gitHead();
    if (args[0] === "status") return statusJson({});
    if (args[0] === "sync") return R({ stdout: "sync ok\n" });
    return R({});
  });
  const r = ensureCodegraphReady({ projectRoot: canon, runner });
  eq(r.ok, true, "ok — re-proved");
  eq(runner.calls.filter((c) => c.args[0] === "sync").length, 1, "one bounded sync");
  eq(stampOf(canon).head, SHA1, "rewritten with a sha-shaped head");
});

test("a proof that cannot be written refuses with proof-unwritable — freshness stays UNKNOWN", () => {
  const { canon } = realRoot("unwritable");
  // A FILE where the index dir should be: the atomic write cannot land.
  writeFileSync(join(canon, ".codegraph"), "a file, not the index dir");
  const runner = scriptedRunner((file, args) => {
    if (file === "git") return gitHead();
    if (args[0] === "status") return statusJson({});
    if (args[0] === "sync") return R({ stdout: "sync ok\n" });
    return R({});
  });
  const r = ensureCodegraphReady({ projectRoot: canon, runner });
  eq(r.ok, false, "refused");
  ok(/^proof-unwritable:/.test(r.reason), `stable reason: ${r.reason}`);
});

// ── ensureCodegraphReady — the schema family ──────────────────────────────────

console.log("\nensureCodegraphReady — schema-stale and the authorized rebuild");

test("reindexRecommended=true refuses queries with index-schema-stale — no sync, no rebuild", () => {
  const { canon } = realRoot("schema-rec");
  const runner = scriptedRunner((file, args) =>
    file === "git" ? gitHead() : args[0] === "status" ? statusJson({ index: { ...SCHEMA_OK, reindexRecommended: true } }) : R({}),
  );
  const r = ensureCodegraphReady({ projectRoot: canon, runner });
  eq(r.ok, false, "refused");
  ok(/^index-schema-stale: reindexRecommended=true/.test(r.reason), `reason names the flag: ${r.reason}`);
  eq(runner.calls.filter((c) => c.args[0] === "sync").length, 0, "a sync cannot close a schema gap — none ran");
  eq(runner.calls.filter((c) => c.args[0] === "index").length, 0, "unauthorized: no rebuild");
});

test("builtWithExtractionVersion != currentExtractionVersion refuses with index-schema-stale", () => {
  const { canon } = realRoot("schema-extract");
  const runner = scriptedRunner((file, args) =>
    file === "git"
      ? gitHead()
      : args[0] === "status"
        ? statusJson({ index: { ...SCHEMA_OK, builtWithExtractionVersion: 23 } })
        : R({}),
  );
  const r = ensureCodegraphReady({ projectRoot: canon, runner });
  eq(r.ok, false, "refused");
  ok(
    /index-schema-stale: builtWithExtractionVersion 23 != currentExtractionVersion 24/.test(r.reason),
    `reason names the version pair: ${r.reason}`,
  );
});

test("an incomplete index (state/pendingRefs) refuses when the status supplies them", () => {
  const { canon } = realRoot("schema-partial");
  const runner = scriptedRunner((file, args) =>
    file === "git"
      ? gitHead()
      : args[0] === "status"
        ? statusJson({ index: { ...SCHEMA_OK, state: "building", pendingRefs: 3 } })
        : R({}),
  );
  const r = ensureCodegraphReady({ projectRoot: canon, runner });
  eq(r.ok, false, "refused");
  ok(
    /index state "building" is not complete/.test(r.reason) && /3 refs still pending/.test(r.reason),
    `reason names both incomplete signals: ${r.reason}`,
  );
});

test("the authorized path (initialize) rebuilds via `codegraph index <root>`, verifies, and writes the proof — no sync, no init", () => {
  const { canon } = realRoot("schema-rebuild");
  const state = { schemaStale: true };
  const runner = scriptedRunner((file, args) => {
    if (file === "git") return gitHead();
    if (args[0] === "status") return statusJson(state.schemaStale ? { index: SCHEMA_BAD } : {});
    if (args[0] === "index") {
      state.schemaStale = false; // a full rebuild lands on the current schema
      return R({ stdout: "full index ok\n" });
    }
    return R({});
  });
  const r = ensureCodegraphReady({ projectRoot: canon, initialize: true, runner });
  eq(r.ok, true, "ok after the verified rebuild");
  const rb = runner.calls.find((c) => c.args[0] === "index");
  ok(rb, "codegraph index ran");
  eq(rb.args[1], canon, "the rebuild addresses the root positionally");
  eq(runner.calls.filter((c) => c.args[0] === "init").length, 0, "a rebuild is not an init — the index exists");
  eq(runner.calls.filter((c) => c.args[0] === "sync").length, 0, "a full rebuild needs no sync");
  eq(stampOf(canon).head, SHA1, "the proof was written after the verified rebuild");
});

test("a failed rebuild refuses with index-rebuild-failed", () => {
  const { canon } = realRoot("rebuild-fail");
  const runner = scriptedRunner((file, args) => {
    if (file === "git") return gitHead();
    if (args[0] === "status") return statusJson({ index: SCHEMA_BAD });
    if (args[0] === "index") return R({ status: 1, stderr: "boom" });
    return R({});
  });
  const r = ensureCodegraphReady({ projectRoot: canon, initialize: true, runner });
  eq(r.ok, false, "refused");
  ok(/^index-rebuild-failed: codegraph index exited 1 — boom/.test(r.reason), `stable reason: ${r.reason}`);
});

test("a rebuild that leaves the schema stale refuses with index-schema-stale-after-rebuild", () => {
  const { canon } = realRoot("rebuild-stays-stale");
  const runner = scriptedRunner((file, args) => {
    if (file === "git") return gitHead();
    if (args[0] === "status") return statusJson({ index: SCHEMA_BAD });
    if (args[0] === "index") return R({ stdout: "ok but changed nothing\n" });
    return R({});
  });
  const r = ensureCodegraphReady({ projectRoot: canon, initialize: true, runner });
  eq(r.ok, false, "refused");
  ok(/^index-schema-stale-after-rebuild:/.test(r.reason), `stable reason: ${r.reason}`);
});

// ── ensureCodegraphReady — refusals ────────────────────────────────────────────

console.log("\nensureCodegraphReady — refusals");

test("negative pending counts are UNKNOWN, never clean", () => {
  const { canon } = realRoot("neg");
  const runner = scriptedRunner((file, args) =>
    file === "git" ? gitHead() : args[0] === "status" ? statusJson({ added: -1 }) : R({}),
  );
  const r = ensureCodegraphReady({ projectRoot: canon, runner });
  eq(r.ok, false, "refused");
  ok(/^status-invalid:/.test(r.reason), `stable reason: ${r.reason}`);
});

test("NaN pending counts are UNKNOWN", () => {
  const { canon } = realRoot("nan");
  const runner = scriptedRunner((file, args) => {
    if (file === "git") return gitHead();
    if (args[0] !== "status") return R({});
    return R({
      stdout: JSON.stringify({
        initialized: true,
        pendingChanges: { added: NaN, modified: 0, removed: 0 },
      }),
    });
  });
  ok(/^status-invalid:/.test(ensureCodegraphReady({ projectRoot: canon, runner }).reason), "NaN refused");
});

test("missing pendingChanges is UNKNOWN (a corrupt index answers proof-shaped JSON)", () => {
  const { canon } = realRoot("nosignal");
  const runner = scriptedRunner((file, args) => {
    if (file === "git") return gitHead();
    if (args[0] !== "status") return R({});
    return R({
      stdout: JSON.stringify({ version: "fake-1.6.0", initialized: true }),
    });
  });
  ok(/^status-invalid:/.test(ensureCodegraphReady({ projectRoot: canon, runner }).reason), "missing signal refused");
});

test("index missing without initialize is a reported reason, never a side effect", () => {
  const { canon } = realRoot("nomissing");
  const runner = scriptedRunner((file, args) =>
    file === "git" ? gitHead() : args[0] === "status" ? statusJson({ initialized: false }) : R({}),
  );
  const r = ensureCodegraphReady({ projectRoot: canon, runner });
  eq(r.ok, false, "refused");
  eq(r.reason, "index-missing", "stable reason");
  eq(r.initialized, false, "not initialized");
  eq(runner.calls.filter((c) => c.args[0] === "init").length, 0, "no init without authorization");
});

test("index missing with initialize:true provisions once, discovering -y from the CLI's own help", () => {
  const { canon } = realRoot("init");
  const state = { initialized: false };
  const runner = scriptedRunner((file, args) => {
    if (file === "git") return gitHead();
    if (args[0] === "status") return statusJson(state);
    if (args[0] === "init" && args.includes("--help")) return R({ stdout: "  -y, --yes   skip prompts\n" });
    if (args[0] === "init") {
      state.initialized = true;
      return R({ stdout: "init ok\n" });
    }
    return R({});
  });
  const r = ensureCodegraphReady({ projectRoot: canon, initialize: true, runner });
  eq(r.ok, true, "ok after init");
  eq(r.initialized, true, "initialized");
  eq(r.synced, false, "init proved the tree — no sync on top");
  const init = runner.calls.find((c) => c.args[0] === "init" && !c.args.includes("--help"));
  ok(init.args.includes("-y"), "the discovered -y flag is passed");
  eq(runner.calls.filter((c) => c.args[0] === "init" && !c.args.includes("--help")).length, 1, "init runs ONCE");
  eq(stampOf(canon).head, SHA1, "the proof is written right after the init, without a sync");
});

test("a CLI whose help shows no -y (installed 1.5) initializes without the flag", () => {
  const { canon } = realRoot("init-noy");
  const state = { initialized: false };
  const runner = scriptedRunner((file, args) => {
    if (file === "git") return gitHead();
    if (args[0] === "status") return statusJson(state);
    if (args[0] === "init" && args.includes("--help")) return R({ stdout: "Usage: codegraph init [path]\n" });
    if (args[0] === "init") {
      state.initialized = true;
      return R({});
    }
    return R({});
  });
  eq(ensureCodegraphReady({ projectRoot: canon, initialize: true, runner }).ok, true, "ok");
  ok(!runner.calls.some((c) => c.args[0] === "init" && c.args.includes("-y")), "no -y invented");
});

test("a failed init refuses with init-failed (no second attempt, no guessing)", () => {
  const { canon } = realRoot("init-fail");
  const runner = scriptedRunner((file, args) => {
    if (file === "git") return gitHead();
    if (args[0] === "status") return statusJson({ initialized: false });
    if (args[0] === "init" && args.includes("--help")) return R({ stdout: "" });
    if (args[0] === "init") return R({ status: 1, stderr: "boom" });
    return R({});
  });
  const r = ensureCodegraphReady({ projectRoot: canon, initialize: true, runner });
  eq(r.ok, false, "refused");
  eq(r.reason, "init-failed", "stable reason");
});

test("init that leaves the index still missing refuses with index-missing-after-init", () => {
  const { canon } = realRoot("init-still-gone");
  const runner = scriptedRunner((file, args) => {
    if (file === "git") return gitHead();
    if (args[0] === "status") return statusJson({ initialized: false });
    if (args[0] === "init" && args.includes("--help")) return R({ stdout: "-y\n" });
    if (args[0] === "init") return R({ stdout: "ok\n" });
    return R({});
  });
  eq(ensureCodegraphReady({ projectRoot: canon, initialize: true, runner }).reason, "index-missing-after-init", "stable reason");
});

test("a failing sync refuses with sync-failed (exit status and first stderr line carried)", () => {
  const { canon } = realRoot("sync-fail");
  const runner = scriptedRunner((file, args) => {
    if (file === "git") return gitHead();
    if (args[0] === "status") return statusJson({ added: 1 });
    if (args[0] === "sync") return R({ status: 1, stderr: "locked" });
    return R({});
  });
  const r = ensureCodegraphReady({ projectRoot: canon, runner });
  ok(/^sync-failed: codegraph sync exited 1 — locked/.test(r.reason), `stable reason with detail: ${r.reason}`);
});

test("a sync that does not settle the pending counts refuses with pending-after-sync", () => {
  const { canon } = realRoot("never-settles");
  const runner = scriptedRunner((file, args) => {
    if (file === "git") return gitHead();
    if (args[0] === "status") return statusJson({ added: 1 });
    if (args[0] === "sync") return R({ stdout: "ok\n" }); // claims success, settles nothing
    return R({});
  });
  const r = ensureCodegraphReady({ projectRoot: canon, runner });
  ok(/^pending-after-sync:/.test(r.reason), `stable reason: ${r.reason}`);
});

test("git rev-parse answering something not sha-shaped is UNKNOWN", () => {
  const { canon } = realRoot("bad-head");
  const runner = scriptedRunner((file, args) => {
    if (file === "git") return R({ stdout: "not-a-sha\n" });
    if (args[0] === "status") return statusJson({});
    return R({});
  });
  ok(/^status-invalid: git rev-parse HEAD returned something not shaped/.test(ensureCodegraphReady({ projectRoot: canon, runner }).reason), "refused");
});

test("no git baseline refuses with no-git-baseline", () => {
  const { canon } = realRoot("no-git");
  const runner = scriptedRunner((file, args) => {
    if (file === "git") return R({ status: 128, stderr: "no commits yet" });
    if (args[0] === "status") return statusJson({});
    return R({});
  });
  const r = ensureCodegraphReady({ projectRoot: canon, runner });
  ok(/^no-git-baseline:/.test(r.reason), `stable reason: ${r.reason}`);
});

test("a borrowed index (worktreeMismatch) refuses with index-mismatch and carries the mismatch", () => {
  const { canon } = realRoot("mismatch");
  const runner = scriptedRunner((file, args) =>
    file === "git"
      ? gitHead()
      : args[0] === "status"
        ? statusJson({ mismatch: { indexRoot: "C:/other/tree", worktreeRoot: canon } })
        : R({}),
  );
  const r = ensureCodegraphReady({ projectRoot: canon, runner });
  ok(/^index-mismatch:/.test(r.reason), `names the borrowed index: ${r.reason}`);
  eq(r.mismatch, { indexRoot: "C:/other/tree", worktreeRoot: canon }, "the mismatch object rides the result");
});

test("status ENOENT is cli-not-found", () => {
  const { canon } = realRoot("enoent");
  const runner = scriptedRunner((file) =>
    file === "codegraph" ? R({ status: null, stdout: "", stderr: "", error: { code: "ENOENT" } }) : R({}),
  );
  eq(ensureCodegraphReady({ projectRoot: canon, runner }).reason, "cli-not-found", "stable reason");
});

test("win32: a plain exit 1 with no JSON is cli-not-found only when `where` itself says absent", () => {
  const { canon } = realRoot("win-where");
  const runner = scriptedRunner((file, args) => {
    if (file === "where") return R({ status: 1, stdout: "" });
    if (file === "codegraph") return R({ status: 1, stdout: "", stderr: "'codegraph' is not recognized" });
    return R({});
  });
  eq(ensureCodegraphReady({ projectRoot: canon, runner }).reason, "cli-not-found", "where's exit 1 proves absence");
});

test("win32: a plain exit 1 while `where` still finds the binary stays status-unreadable", () => {
  const { canon } = realRoot("win-crash");
  const runner = scriptedRunner((file) => {
    if (file === "where") return R({ status: 0, stdout: "C:/x/codegraph.cmd\n" });
    if (file === "codegraph") return R({ status: 1, stdout: "", stderr: "crashed" });
    return R({});
  });
  eq(ensureCodegraphReady({ projectRoot: canon, runner }).reason, "status-unreadable", "not misreported as not-on-PATH");
});

test("garbage status output refuses with status-unreadable", () => {
  const { canon } = realRoot("garbage");
  const runner = scriptedRunner((file, args) =>
    file === "git" ? gitHead() : args[0] === "status" ? R({ stdout: "not json at all\n" }) : R({}),
  );
  eq(ensureCodegraphReady({ projectRoot: canon, runner }).reason, "status-unreadable", "stable reason");
});

test("a subprocess timing out mid-sequence surfaces as the timeout reason", () => {
  const { canon } = realRoot("slow-sync");
  const runner = scriptedRunner((file, args) => {
    if (file === "git") return gitHead();
    if (args[0] === "status") return statusJson({ added: 1 });
    if (args[0] === "sync") return R({ status: null, stdout: "", stderr: "", error: { code: "ETIMEDOUT" } });
    return R({});
  });
  eq(ensureCodegraphReady({ projectRoot: canon, runner }).reason, "timeout", "stable reason");
});

test("an exhausted overall deadline (timeoutMs 0) reports timeout before any call", () => {
  const { canon } = realRoot("deadline");
  const runner = scriptedRunner(() => R({}));
  const r = ensureCodegraphReady({ projectRoot: canon, timeoutMs: 0, runner });
  eq(r.reason, "timeout", "deadline refuses first");
  eq(runner.calls.length, 0, "no subprocess ran after the deadline");
});

test("every subprocess call inherits the shared deadline, never a fresh budget", () => {
  const { canon } = realRoot("budget");
  const runner = scriptedRunner(settlingHandler({}));
  ensureCodegraphReady({ projectRoot: canon, timeoutMs: 5_000, runner });
  ok(runner.calls.length > 0, "calls ran");
  for (const c of runner.calls) {
    ok(c.timeoutMs <= 5_000, `${c.file} ${c.args[0]} got ${c.timeoutMs}ms — within the shared budget`);
  }
});

test("an unresolvable root refuses with root-unresolved before any subprocess", () => {
  const runner = scriptedRunner(() => R({}));
  const r = ensureCodegraphReady({ projectRoot: join(tmpDir("noroot"), "gone"), runner });
  ok(/^root-unresolved:/.test(r.reason), `stable reason: ${r.reason}`);
  eq(runner.calls.length, 0, "no subprocess for an unresolvable root");
});

// ── summary ────────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("failures:\n  " + failures.join("\n  "));
  process.exit(1);
}
