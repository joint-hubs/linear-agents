// scripts/supervisor-pinned-state.test.mjs — FOC-286: the nine-field kickoff
// prologue, and the spawn-time verification that backs it.
//
// Two halves, both measured here:
//   · the prologue — a fixed machine-templated shape, so the tests assert the
//     nine labels, their order, and that every value comes from spawn's own
//     data;
//   · the verification — it runs BEFORE anything is written or launched, so
//     every refusal is asserted to leave NO registry entry and NO generated
//     settings file behind (no partial spawn).
//
// The git-facts refusals (branch, base revision, dirt on a fresh tree) are
// unit-tested against real worktrees because the public CLI cannot reach them
// honestly: ensureWorktree fails on the same conditions before verification
// ever runs. The refusal WIRING is covered end-to-end through the two ways
// that do reach it — an unreadable --prompt-file, and a corrupt worktree index
// that makes `git status` (but not `rev-parse`) fail inside the worktree.
//
// Run: node scripts/supervisor-pinned-state.test.mjs

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ROOT,
  SPAWN,
  STOP,
  fixtureRepo,
  fixtureRun,
  fixtureWorktree,
  harness,
  parse,
  runScript,
  runSpawn,
} from "./supervisor-test-fixtures.mjs";
import {
  childSettingsPath,
  pinnedStatePrologue,
  readRegistry,
  verifyPinnedState,
} from "./supervisor-lib.mjs";

const { test, fail, summary } = harness();

// ── the prologue template ────────────────────────────────────────────────────
console.log("\nprologue — nine fields from spawn's own data");

const STATE = {
  repo: "C:/repo/linear-agents",
  laRoot: "C:/repo/linear-agents",
  worktree: "C:/la-wt/linear-agents/foc-286-dev",
  branch: "foc-286-dev",
  baseRevision: "674f8f424b684ea902cfcd8759e7b644bf096262",
  cleanAtSpawn: true,
  dirtyPaths: [],
  task: "FOC-286",
  runId: "run-x",
  childId: "dev-1",
  laRunId: "2026-09-11T08-12-39-879-dev-bc97",
  verification: {
    ok: true,
    at: "2026-09-11T08:30:00.000Z",
    checks: [
      { name: "worktree-exists", ok: true },
      { name: "branch-match", ok: true },
      { name: "base-revision-match", ok: true },
      { name: "tree-state", ok: true },
    ],
    reasons: [],
  },
};

test("renders the nine labeled fields in a fixed order, values from the input", () => {
  const text = pinnedStatePrologue(STATE);
  const lines = text.split("\n");
  if (lines[0] !== "=== PINNED STATE ===") fail(`no header line: ${lines[0]}`);
  if (lines[lines.length - 1] !== "=== END PINNED STATE ===") fail("no end marker");
  // The nine labels, in the order a child reads them — fixed on purpose: this
  // is a template, not prose, and a shape that moves is a shape nobody parses.
  const expected = [
    "repo:",
    "worktree:",
    "branch:",
    "clean-at-spawn:",
    "issue:",
    "run:",
    "spawn-verified:",
    "pre-authorized:",
    "known-quirks:",
  ];
  const labels = lines.slice(1, -1).map((l) => l.slice(0, l.indexOf(":") + 1));
  if (JSON.stringify(labels) !== JSON.stringify(expected)) fail(`labels drifted: ${JSON.stringify(labels)}`);
  for (const needle of [
    STATE.repo,
    STATE.worktree,
    STATE.branch,
    STATE.baseRevision,
    STATE.task,
    STATE.runId,
    STATE.childId,
    STATE.laRunId,
    "PASS at 2026-09-11T08:30:00.000Z",
  ]) {
    if (!text.includes(needle)) fail(`prologue does not carry ${needle}`);
  }
});

test("renders the dirty list, the quirks, and the honest (none) fallbacks", () => {
  const dirty = pinnedStatePrologue({
    ...STATE,
    cleanAtSpawn: false,
    dirtyPaths: [" M scripts/a.mjs", "?? notes.txt"],
    laRunId: null,
    preAuthorized: ["node scripts/test-all.mjs supervisor"],
    knownQuirks: ["la-wt worktrees hold locks briefly after a kill"],
  });
  for (const needle of [
    "clean-at-spawn: false",
    "M scripts/a.mjs",
    "?? notes.txt",
    "LA_RUN_ID: (none",
    "node scripts/test-all.mjs supervisor",
    "la-wt worktrees hold locks briefly after a kill",
  ]) {
    if (!dirty.includes(needle)) fail(`dirty prologue missing "${needle}"`);
  }
  const clean = pinnedStatePrologue(STATE);
  if (!clean.includes("dirty: (none)")) fail("a clean tree did not render (none)");
  if (!clean.includes("LA_ROOT: C:/repo/linear-agents")) fail("laRoot lost on the clean path");
  if (!clean.includes("issue: FOC-286")) fail("issue field lost");
});

// ── verification against real worktrees ───────────────────────────────────────
console.log("\nverification — the facts against the worktree");

test("passes on a clean worktree and reports clean-at-spawn", () => {
  const { repo } = fixtureRepo();
  const v = verifyPinnedState(fixtureWorktree(repo));
  if (!v.ok) fail(`verification refused a clean worktree: ${v.reasons.join(", ")}`);
  if (v.cleanAtSpawn !== true) fail(`cleanAtSpawn was ${v.cleanAtSpawn}`);
  if (v.dirtyPaths.length) fail(`a clean tree reported dirty: ${JSON.stringify(v.dirtyPaths)}`);
  const names = v.checks.map((c) => c.name);
  if (JSON.stringify(names) !== JSON.stringify(["worktree-exists", "branch-match", "base-revision-match", "tree-state"])) {
    fail(`unexpected checks: ${JSON.stringify(names)}`);
  }
});

test("pins a reused dirty worktree instead of refusing it", () => {
  // FOC-167 reuse: a dirty tree is legitimate state to resume into, so the
  // prologue must SAY so, not pretend the tree was clean — a reused checkout
  // pinned as clean is exactly the lie this feature exists to remove.
  const { repo } = fixtureRepo();
  const wt = fixtureWorktree(repo);
  writeFileSync(join(wt.worktree, "uncommitted.txt"), "left over\n");
  const v = verifyPinnedState({ ...wt, created: false });
  if (!v.ok) fail(`reuse of a dirty tree refused: ${v.reasons.join(", ")}`);
  if (v.cleanAtSpawn !== false) fail("dirty reuse pinned as clean");
  if (!v.dirtyPaths.some((p) => p.includes("uncommitted.txt"))) fail(`dirty list lost the file: ${JSON.stringify(v.dirtyPaths)}`);
});

test("refuses with a named reason when the worktree is gone", () => {
  const v = verifyPinnedState({
    worktree: join(tmpdir(), "la-pinned-gone"),
    branch: "foc-286-dev",
    baseRevision: "deadbeef",
    created: true,
  });
  if (v.ok) fail("a missing worktree passed");
  if (v.reasons[0] !== "worktree-missing") fail(`unnamed refusal: ${JSON.stringify(v.reasons)}`);
});

test("refuses on branch mismatch and names what the tree actually is", () => {
  const { repo } = fixtureRepo();
  const wt = fixtureWorktree(repo);
  const v = verifyPinnedState({ ...wt, branch: "foc-999-other" });
  if (v.ok) fail("a branch mismatch passed");
  if (v.reasons[0] !== "branch-mismatch") fail(`unnamed refusal: ${JSON.stringify(v.reasons)}`);
  if (v.checks.find((c) => c.name === "branch-match").actual !== wt.branch) {
    fail("payload does not name the branch the tree actually has");
  }
});

test("refuses on base-revision mismatch", () => {
  const { repo } = fixtureRepo();
  const wt = fixtureWorktree(repo);
  const v = verifyPinnedState({ ...wt, baseRevision: "0".repeat(40) });
  if (v.ok) fail("a base-revision mismatch passed");
  if (v.reasons[0] !== "base-revision-mismatch") fail(`unnamed refusal: ${JSON.stringify(v.reasons)}`);
});

test("refuses a freshly created worktree that is somehow dirty", () => {
  const { repo } = fixtureRepo();
  const wt = fixtureWorktree(repo);
  writeFileSync(join(wt.worktree, "stray.txt"), "who put this here\n");
  const v = verifyPinnedState({ ...wt, created: true });
  if (v.ok) fail("a dirty 'fresh' worktree passed");
  if (v.reasons[0] !== "tree-state-mismatch") fail(`unnamed refusal: ${JSON.stringify(v.reasons)}`);
});

// ── what the child actually receives ──────────────────────────────────────────
console.log("\nspawn — what the child was told");

test("the child's kickoff starts with the prologue, body intact, record matching", () => {
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  const argvFile = join(mkdtempSync(join(tmpdir(), "la-argv-")), "argv.json");
  const out = parse(runSpawn(runId, repo, [], { MOCK_CLAUDE_ARGV_FILE: argvFile }), fail);
  if (!out.ok) fail(`spawn failed: ${out.error}`);

  const argv = JSON.parse(readFileSync(argvFile, "utf8"));
  const prompt = argv[argv.indexOf("-p") + 1];
  if (!prompt.startsWith("=== PINNED STATE ===")) fail("the kickoff does not start with the pinned-state block");
  for (const label of [
    "repo:", "worktree:", "branch:", "clean-at-spawn:", "issue:", "run:",
    "spawn-verified:", "pre-authorized:", "known-quirks:",
  ]) {
    if (!prompt.includes(label)) fail(`the child's kickoff lacks "${label}"`);
  }
  // Every value below is spawn's OWN data, echoed back from the success JSON —
  // the prologue is templated from what spawn holds, never invented.
  for (const needle of [out.repo, out.worktree, out.branch, out.baseRevision, "FOC-123", runId, out.childId, "worktree-exists"]) {
    if (!prompt.includes(needle)) fail(`prologue does not pin ${needle}`);
  }
  // Telemetry is off in this suite (LA_SUPERVISOR_NO_TELEMETRY), so the honest
  // rendering of LA_RUN_ID here is the "(none)" fallback.
  if (!prompt.includes("LA_RUN_ID: (none")) fail("LA_RUN_ID not rendered honestly with telemetry off");
  if (!prompt.endsWith("kickoff")) fail(`the author's kickoff body was lost: ...${prompt.slice(-80)}`);

  // The registry must carry WHAT THE CHILD WAS TOLD, verbatim.
  const entry = readRegistry(runId).children[out.childId];
  if (!prompt.startsWith(entry.pinnedStateVerification.prologue)) fail("the recorded prologue is not the prologue the child received");

  spawnSync(process.execPath, [STOP, "--run", runId, "--child", out.childId], { encoding: "utf8" });
});

test("the child record carries the verification: timestamp, checks, outcome", () => {
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  const out = parse(runSpawn(runId, repo), fail);
  const v = readRegistry(runId).children[out.childId].pinnedStateVerification;
  if (!v) fail("registry entry has no pinnedStateVerification");
  if (v.ok !== true) fail(`recorded verification is not ok: ${JSON.stringify(v.reasons)}`);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v.at)) fail(`no verification timestamp: ${v.at}`);
  for (const name of ["worktree-exists", "branch-match", "base-revision-match", "tree-state"]) {
    if (!v.checks.some((c) => c.name === name && c.ok)) fail(`check "${name}" missing or not ok`);
  }
  if (!v.prologue.includes("=== PINNED STATE ===")) fail("the record does not carry the prologue text");

  spawnSync(process.execPath, [STOP, "--run", runId, "--child", out.childId], { encoding: "utf8" });
});

test("the success JSON reports the verification alongside the facts", () => {
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  const out = parse(runSpawn(runId, repo), fail);
  if (out.pinnedStateVerification?.ok !== true) fail("the success JSON does not report a passing verification");
  if (!out.pinnedStateVerification.prologue.includes(out.branch)) fail("the reported prologue lost the branch");

  spawnSync(process.execPath, [STOP, "--run", runId, "--child", out.childId], { encoding: "utf8" });
});

test("--prompt-file: prologue prepended, caller's file untouched, check recorded", () => {
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  const dir = mkdtempSync(join(tmpdir(), "la-prompt-"));
  const callerFile = join(dir, "kickoff.txt");
  writeFileSync(callerFile, "AUTHOR'S KICKOFF BODY", "utf8");
  const argvFile = join(dir, "argv.json");
  const out = parse(
    runScript(SPAWN, [
      "--run", runId, "--squad", "dev", "--task", "FOC-123",
      "--prompt-file", callerFile, "--repo", repo,
    ], { MOCK_CLAUDE_ARGV_FILE: argvFile }),
    fail,
  );
  if (!out.ok) fail(`spawn failed: ${out.error}`);
  if (readFileSync(callerFile, "utf8") !== "AUTHOR'S KICKOFF BODY") fail("the caller's prompt file was rewritten");
  const argv = JSON.parse(readFileSync(argvFile, "utf8"));
  const prompt = argv[argv.indexOf("-p") + 1];
  if (!prompt.startsWith("=== PINNED STATE ===")) fail("no prologue on the --prompt-file path");
  if (!prompt.endsWith("AUTHOR'S KICKOFF BODY")) fail("the author's body was lost on the --prompt-file path");
  const v = readRegistry(runId).children[out.childId].pinnedStateVerification;
  if (!prompt.startsWith(v.prologue)) fail("recorded prologue ≠ what the child was told (--prompt-file path)");
  if (!v.checks.some((c) => c.name === "prompt-file-readable" && c.ok)) fail("prompt-file-readable not recorded");

  spawnSync(process.execPath, [STOP, "--run", runId, "--child", out.childId], { encoding: "utf8" });
});

// ── refusals: nothing is written, nothing is launched ─────────────────────────
console.log("\nrefusals — no partial spawn");

test("an unreadable --prompt-file refuses with a named reason and spawns nothing", () => {
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  const r = runScript(SPAWN, [
    "--run", runId, "--squad", "dev", "--task", "FOC-123",
    "--prompt-file", join(tmpdir(), "la-pinned-no-such-file.txt"), "--repo", repo,
  ]);
  if (r.status !== 1) fail(`expected exit 1, got ${r.status}`);
  const out = parse(r, fail);
  if (out.ok !== false) fail("the refusal reported ok");
  if (!out.error.includes("prompt-file-unreadable")) fail(`refusal does not name the reason: ${out.error}`);
  // No partial spawn: no child, no generated settings.
  if (Object.keys(readRegistry(runId).children).length) fail("a child was registered despite the refusal");
  if (existsSync(childSettingsPath(runId, "dev-1"))) fail("a settings file was generated despite the refusal");
});

test("a worktree whose state cannot be read refuses the spawn (corrupt index)", () => {
  // The one git-facts refusal the CLI can reach honestly: `git rev-parse`
  // never reads the index, `git status` does — so a corrupt index file lets
  // ensureWorktree succeed on reuse and verification is the first thing to
  // notice. (A stale index.lock does NOT work here, measured: `git status`
  // only wants the lock to write its stat-cache back, and without it still
  // answers — the corrupt file is what actually fails.)
  const { repo } = fixtureRepo();
  const runA = fixtureRun();
  const first = parse(runSpawn(runA, repo), fail);
  spawnSync(process.execPath, [STOP, "--run", runA, "--child", first.childId], { encoding: "utf8" });

  const gitDir = readFileSync(join(first.worktree, ".git"), "utf8").trim().replace(/^gitdir:\s*/, "");
  writeFileSync(join(gitDir, "index"), "garbage — not an index\n");

  const runB = fixtureRun();
  const r = runSpawn(runB, repo);
  if (r.status !== 1) fail(`expected exit 1, got ${r.status}`);
  const out = parse(r, fail);
  if (out.ok !== false) fail("the refusal reported ok");
  if (!out.error.includes("tree-state-unreadable")) fail(`refusal does not name the reason: ${out.error}`);
  if (Object.keys(readRegistry(runB).children).length) fail("a child was registered despite the refusal");
  if (existsSync(childSettingsPath(runB, "dev-1"))) fail("a settings file was generated despite the refusal");
});

summary();