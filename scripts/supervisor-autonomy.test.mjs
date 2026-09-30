// scripts/supervisor-autonomy.test.mjs — recorded autonomy grants (FOC-613).
//
// config/autonomy.json records standing operator decisions; the loader
// (scripts/autonomy-grants.mjs) validates it fail-closed, and
// supervisor-cleanup.mjs `remove` consults the `cleanup-own-worktree` grant as
// a stand-in for the human key on trees entirely landed in main.
//
// What is asserted here and nowhere else:
//   · the shipped config loads and carries exactly the two seed grants, and
//     the cleanup grant's branch scope never covers a foc-*-review branch;
//   · AC1 — the grant path removes a landed tree with NO gate answered, and
//     refuses, NAMING the failed half, when the work is not landed, out of
//     scope, or no grant is recorded;
//   · AC2 — per neverCovers entry, asserted independently (five blocks, not
//     one loop): a grant naming the action is refused at load time, and no
//     code path performs it via a grant (static tripwires over the removal
//     script's non-comment source, so the grant path cannot quietly grow the
//     capability later);
//   · "landed" means ancestry against main, not against the registry's
//     baseRevision.
//
// FOC-649 additions (asserted here because the grant fixtures live here):
//   · AC1 — `remove`'s report names every ignored/untracked path before it
//     dies: work product in `archived`, rebuildable cache in `skippedCache`;
//   · AC2 — the archive automation copies work product out before ANY removal
//     path deletes, and a blocked destination refuses with nothing deleted;
//   · AC3 — both-tips containment: the grant refusal names the tip that
//     actually failed (never "0 commits" for a divergent tree), and the two-key
//     path refuses a HEAD on a branch the record does not name.
//
// Isolation: the supervisor state home is redirected to a mkdtemp dir at
// module load (the LA_SUPERVISOR_STATE_HOME seam, same as
// supervisor-guard.test.mjs) and the spawned cleanup processes inherit it; the
// autonomy config is redirected per-invocation via the LA_AUTONOMY_CONFIG seam
// pointed at temp files. Nothing touches the repo's real .state/.
//
// Run: node scripts/supervisor-autonomy.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  NEVER_COVERS,
  autonomyConfigPath,
  globMatch,
  grantIsActive,
  loadAutonomyGrants,
  validateAutonomy,
} from "./autonomy-grants.mjs";
import { allGates } from "./supervisor-gate.mjs";
import {
  ROOT,
  baseEnv,
  cleanupLater,
  fixtureRepo,
  fixtureRun,
  fixtureWorktree,
  gitIn,
  harness,
  parse,
} from "./supervisor-test-fixtures.mjs";
import { readRegistry, unarchivedIgnoredContent, writeRegistry } from "./supervisor-lib.mjs";

const { test, fail, summary } = harness();

// The seam: every run dir (in-process and in spawned cleanup/gate processes,
// which inherit the env) resolves under this temp home.
const STATE_HOME = mkdtempSync(join(tmpdir(), "la-sup-autonomy-"));
process.env.LA_SUPERVISOR_STATE_HOME = STATE_HOME;
cleanupLater(STATE_HOME);

const CLEANUP = join(ROOT, "scripts", "supervisor-cleanup.mjs");
const GATE = join(ROOT, "scripts", "supervisor-gate.mjs");

const cleanup = (args, env = {}) => {
  const e = baseEnv(env);
  if (!("LA_SUPERVISOR_CHILD" in env)) delete e.LA_SUPERVISOR_CHILD;
  return spawnSync(process.execPath, [CLEANUP, ...args], { cwd: ROOT, encoding: "utf8", env: e });
};
const gate = (args, env = {}) => {
  const e = baseEnv(env);
  if (!("LA_SUPERVISOR_CHILD" in env)) delete e.LA_SUPERVISOR_CHILD;
  return spawnSync(process.execPath, [GATE, ...args], { cwd: ROOT, encoding: "utf8", env: e });
};

// ── fixtures ─────────────────────────────────────────────────────────────────

let issueCounter = 0;
function issueFile(dir, stateName, stateType) {
  const path = join(dir, `issue-${issueCounter++}.json`);
  writeFileSync(path, JSON.stringify({ identifier: "FOC-123", state: { name: stateName, type: stateType } }));
  return path;
}

/** A run + a registry child + a real worktree: the state every remove test starts from. */
function scenario({ status = "exited", dirty = null, ignored = null } = {}) {
  const { base, repo } = fixtureRepo();
  if (ignored) {
    // The ignore rules must land on main BEFORE the worktree branches off, so
    // the ignored files stay ignored without moving the branch ahead of main
    // (which would break the landed proof the grant path needs).
    writeFileSync(join(repo, ".gitignore"), `${ignored.join("\n")}\n`);
    gitIn(repo, "add", ".gitignore");
    gitIn(repo, "commit", "-m", "gitignore");
  }
  const wt = fixtureWorktree(repo);
  const runId = fixtureRun();

  writeRegistry(runId, {
    runId,
    children: {
      "dev-1": {
        childId: "dev-1",
        squad: "dev",
        taskId: "FOC-123",
        sessionId: "11111111-2222-3333-4444-555555555555",
        status,
        turns: [{ pid: 1 }],
        worktree: wt.worktree,
        branch: wt.branch,
        baseRevision: wt.baseRevision,
        allowedPaths: [],
      },
    },
    rounds: {},
  });

  if (dirty) writeFileSync(join(wt.worktree, dirty), "uncommitted\n");
  if (ignored) {
    for (const rel of ignored) {
      const p = join(wt.worktree, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, "ignored content\n");
    }
  }

  return { base, repo, runId, repoName: basename(repo), ...wt, done: issueFile(base, "Done", "completed") };
}

/** The archive dir the grant's third precondition reads: state-home/<run>/test-artifacts/<child>/. */
const archivePath = (s, ...rest) => join(STATE_HOME, s.runId, "test-artifacts", "dev-1", ...rest);
const archiveFile = (s, rel) => {
  const p = archivePath(s, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, "archived copy\n");
};

/** A schema-valid autonomy config written to a temp dir, for the LA_AUTONOMY_CONFIG seam. */
let cfgCounter = 0;
const grantShape = (over = {}) => ({
  id: "cleanup-own-worktree",
  actions: ["cleanup-own-worktree"],
  scope: { repo: "*", branches: ["foc-*-dev"], clean: true, landed: true, ownership: "supervisor-worktree" },
  source: "test fixture grant (not a real operator decision)",
  grantedAt: "2026-09-29",
  expires: null,
  ...over,
});
function autonomyConfig(dir, grants) {
  const path = join(dir, `autonomy-${cfgCounter++}.json`);
  writeFileSync(path, JSON.stringify({ neverCovers: [...NEVER_COVERS], grants }));
  return path;
}

// ── 1. the loader and the shipped config ─────────────────────────────────────
console.log("\nloader — config/autonomy.json");

test("the shipped config loads and carries exactly the two seed grants", () => {
  assert.equal(autonomyConfigPath(), join(ROOT, "config", "autonomy.json"));
  const cfg = loadAutonomyGrants();
  assert.deepEqual(cfg.neverCovers, NEVER_COVERS);
  assert.deepEqual(
    cfg.grants.map((g) => g.id).sort(),
    ["cleanup-own-worktree", "land-local"],
    `unexpected seed grants: ${cfg.grants.map((g) => g.id).join(", ")}`,
  );
});

test("the shipped cleanup grant never covers a review branch, and covers dev/test trees", () => {
  const grant = loadAutonomyGrants().grants.find((g) => g.id === "cleanup-own-worktree");
  assert.ok(grant, "the seed grant is missing from the shipped config");
  assert.ok(grant.scope.branches.every((p) => !globMatch(p, "foc-613-review")), "a foc-*-review branch is covered");
  assert.ok(grant.scope.branches.some((p) => globMatch(p, "foc-613-dev")), "dev trees are not covered");
  assert.ok(grant.scope.branches.some((p) => globMatch(p, "foc-613-test")), "test trees are not covered");
});

test("widening neverCovers is refused at load time", () => {
  const cfg = { neverCovers: [...NEVER_COVERS, "merge"], grants: [] };
  assert.throws(() => validateAutonomy(cfg), /schema|neverCovers/);
});

test("trimming neverCovers is refused at load time", () => {
  const cfg = { neverCovers: NEVER_COVERS.slice(0, 4), grants: [] };
  assert.throws(() => validateAutonomy(cfg), /schema|neverCovers/);
});

test("grantIsActive: null expires is open-ended, a past expires is dead", () => {
  assert.equal(grantIsActive(grantShape({ expires: null })), true);
  assert.equal(grantIsActive(grantShape({ expires: "2020-01-01" })), false);
  assert.equal(grantIsActive(grantShape({ expires: "2999-01-01" })), true);
  assert.equal(grantIsActive(grantShape({ expires: "not-a-date" })), false);
});

test("globMatch: the scope patterns do what the grant claims", () => {
  assert.equal(globMatch("foc-*-dev", "foc-613-dev"), true);
  assert.equal(globMatch("foc-*-dev", "foc-613-review"), false);
  assert.equal(globMatch("main", "main"), true);
  assert.equal(globMatch("main", "maintenance"), false);
});

// ── 2. AC2: neverCovers, entry by entry ──────────────────────────────────────
console.log("\nneverCovers — nigdy objęte grantem");

// AC2 has two halves per entry, asserted independently per entry (five blocks,
// not one loop): (a) a grant naming the action is refused at load time, and
// (b) the removal script contains no code path that could perform the action
// via a grant — a static tripwire over its non-comment source. The one
// destructive act the script contains at all is `git worktree remove` (and its
// fingerprint-guarded --force), which none of the five names.

const cleanupSource = () =>
  readFileSync(CLEANUP, "utf8")
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("/*") && !t.startsWith("*");
    })
    .join("\n");

test("neverCovers 'push': ungrantable at load, and the removal script never pushes", () => {
  assert.throws(
    () =>
      validateAutonomy({
        neverCovers: [...NEVER_COVERS],
        grants: [grantShape({ id: "push-grant", actions: ["push"], scope: { repo: "*", branches: ["main"] } })],
      }),
    /\bpush\b/,
  );
  // Array.prototype.push and process.env are not git push — the tripwire
  // targets the shell spellings: a `git push` string or a "push" argument.
  assert.ok(
    !/\bgit\s+push\b|"push"|'push'/.test(cleanupSource()),
    "supervisor-cleanup.mjs pushes in executable code",
  );
});

test("neverCovers 'force': ungrantable at load, and no history-forcing command exists", () => {
  assert.throws(
    () =>
      validateAutonomy({
        neverCovers: [...NEVER_COVERS],
        grants: [grantShape({ id: "force-grant", actions: ["force"], scope: { repo: "*", branches: ["main"] } })],
      }),
    /\bforce\b/,
  );
  // The `--force` on `git worktree remove` is fingerprint-guarded dirty-checkout
  // removal, not a history-forcing act — that is why this tripwire targets the
  // history-forcing spellings, not the word itself.
  assert.ok(
    !/reset\s+--hard|push\s+--force|--force-with-lease/.test(cleanupSource()),
    "supervisor-cleanup.mjs contains a history-forcing command",
  );
});

test("neverCovers 'discard': ungrantable at load, and no work-discarding command exists", () => {
  assert.throws(
    () =>
      validateAutonomy({
        neverCovers: [...NEVER_COVERS],
        grants: [grantShape({ id: "discard-grant", actions: ["discard"], scope: { repo: "*", branches: ["main"] } })],
      }),
    /\bdiscard\b/,
  );
  assert.ok(
    !/\bgit\s+(restore|clean)\b|checkout\s+--|reset\s+--hard/.test(cleanupSource()),
    "supervisor-cleanup.mjs contains a work-discarding command",
  );
});

test("neverCovers 'delete-branch': ungrantable at load, and no branch deletion exists", () => {
  assert.throws(
    () =>
      validateAutonomy({
        neverCovers: [...NEVER_COVERS],
        grants: [grantShape({ id: "delete-branch-grant", actions: ["delete-branch"], scope: { repo: "*", branches: ["main"] } })],
      }),
    /delete-branch/,
  );
  assert.ok(
    !/\bbranch\s+-[dD]\b|push\s+.*--delete/.test(cleanupSource()),
    "supervisor-cleanup.mjs deletes branches",
  );
});

test("neverCovers 'secrets': ungrantable at load, and the script never touches credential paths", () => {
  assert.throws(
    () =>
      validateAutonomy({
        neverCovers: [...NEVER_COVERS],
        grants: [grantShape({ id: "secrets-grant", actions: ["secrets"], scope: { repo: "*", branches: ["main"] } })],
      }),
    /\bsecrets\b/,
  );
  // `process.env` is not a credential path — the tripwire targets `.env` /
  // key material file references, which always appear quoted or after a slash.
  assert.ok(
    !/(["'\/])\.env|id_rsa|credential/i.test(cleanupSource()),
    "supervisor-cleanup.mjs references credential paths",
  );
});

test("the loader is data-only: the grant path cannot grow an executor", () => {
  const src = readFileSync(join(ROOT, "scripts", "autonomy-grants.mjs"), "utf8");
  assert.ok(!/child_process|execFileSync|spawnSync/.test(src), "the loader executes something — grants must stay data");
});

// ── 3. AC1: the grant consulted where the gate is ────────────────────────────
console.log("\nAC1 — grant w miejscu bramki");

const coveringGrant = (s) => ({
  id: "cleanup-own-worktree",
  actions: ["cleanup-own-worktree"],
  scope: { repo: s.repoName, branches: ["foc-*-dev"], clean: true, landed: true, ownership: "supervisor-worktree" },
  source: "test fixture grant (not a real operator decision)",
  grantedAt: "2026-09-29",
  expires: null,
});

test("AC1 positive: a recorded grant + a landed tree removes with NO gate answered", () => {
  const s = scenario();
  const cfg = autonomyConfig(s.base, [coveringGrant(s)]);

  const out = parse(cleanup(["remove", "--run", s.runId, "--child", "dev-1", "--issue-file", s.done], { LA_AUTONOMY_CONFIG: cfg }), fail);
  assert.equal(out.ok, true, out.error);
  assert.equal(out.removed, s.worktree);
  assert.ok(!existsSync(s.worktree), "the directory survived the grant-path removal");

  // NO gate exists for this run — the grant stood in for the human key.
  assert.equal(allGates(s.runId).length, 0, "a gate was emitted for a grant-covered removal");
  assert.match(out.keys.grant, /cleanup-own-worktree/, "the report does not name the grant that fired");

  // The removal record says which grant fired.
  const entry = readRegistry(s.runId).children["dev-1"];
  assert.equal(entry.cleanupGrant, "cleanup-own-worktree");
  assert.ok(entry.worktreeRemovedAt, "the removal timestamp is missing");
});

test("AC1 negative: one commit outside main → refuses, naming 'not landed'", () => {
  const s = scenario();
  writeFileSync(join(s.worktree, "unlanded.txt"), "work main never saw\n");
  gitIn(s.worktree, "add", "-A");
  gitIn(s.worktree, "commit", "-m", "unlanded work");
  const cfg = autonomyConfig(s.base, [coveringGrant(s)]);

  const out = parse(cleanup(["remove", "--run", s.runId, "--child", "dev-1", "--issue-file", s.done], { LA_AUTONOMY_CONFIG: cfg }), fail);
  assert.equal(out.ok, false);
  assert.match(out.error, /not landed/);
  assert.match(out.error, /cleanup-own-worktree/, "the refusal does not name the grant that declined");
  assert.ok(existsSync(s.worktree), "the tree was removed despite the not-landed refusal");
});

test("AC1 negative: no grant recorded → refuses as the two-key rule always has", () => {
  const s = scenario();
  const cfg = autonomyConfig(s.base, []);

  const out = parse(cleanup(["remove", "--run", s.runId, "--child", "dev-1", "--issue-file", s.done], { LA_AUTONOMY_CONFIG: cfg }), fail);
  assert.equal(out.ok, false);
  assert.match(out.error, /has not been asked/);
  assert.ok(existsSync(s.worktree));

  // Positive control: the two keys still open the same door they always did,
  // with the grant absent.
  const proposed = parse(cleanup(["propose", "--run", s.runId, "--child", "dev-1", "--issue-file", s.done]), fail);
  assert.equal(proposed.ok, true, proposed.error);
  parse(gate(["answer", "--run", s.runId, "--gate", proposed.gateId, "--text", "yes"]), fail);
  const out2 = parse(cleanup(["remove", "--run", s.runId, "--child", "dev-1", "--issue-file", s.done], { LA_AUTONOMY_CONFIG: cfg }), fail);
  assert.equal(out2.ok, true, out2.error);
  assert.match(out2.keys.human, /answered/);
  assert.equal(out2.keys.grant, undefined, "the two-key path must not claim a grant");
  assert.equal(readRegistry(s.runId).children["dev-1"].cleanupGrant, undefined);
});

test("out of scope: a branch the grant's patterns decline is refused by name", () => {
  const s = scenario();
  const narrowed = autonomyConfig(s.base, [
    { ...coveringGrant(s), scope: { ...coveringGrant(s).scope, branches: ["foc-*-test"] } },
  ]);

  const out = parse(cleanup(["remove", "--run", s.runId, "--child", "dev-1", "--issue-file", s.done], { LA_AUTONOMY_CONFIG: narrowed }), fail);
  assert.equal(out.ok, false);
  assert.match(out.error, /out of scope/);
  assert.ok(existsSync(s.worktree));
});

test("out of scope: a dirty tree is not covered even on a landed branch", () => {
  const s = scenario({ dirty: "scratch.txt" });
  const cfg = autonomyConfig(s.base, [coveringGrant(s)]);

  const out = parse(cleanup(["remove", "--run", s.runId, "--child", "dev-1", "--issue-file", s.done], { LA_AUTONOMY_CONFIG: cfg }), fail);
  assert.equal(out.ok, false);
  assert.match(out.error, /out of scope/);
  assert.match(out.error, /dirty/);
  assert.ok(existsSync(s.worktree));
  assert.ok(existsSync(join(s.worktree, "scratch.txt")), "uncommitted work survived");
});

test("landed is ancestry against main, not against the registry's baseRevision", () => {
  const s = scenario();
  // One commit in the worktree, then landed on main locally: commitsAhead vs
  // the recorded baseRevision is now 1, but nothing is outside main.
  writeFileSync(join(s.worktree, "landed.txt"), "landed\n");
  gitIn(s.worktree, "add", "-A");
  gitIn(s.worktree, "commit", "-m", "landed work");
  gitIn(s.repo, "merge", "--ff-only", s.branch);

  const cfg = autonomyConfig(s.base, [coveringGrant(s)]);
  const out = parse(cleanup(["remove", "--run", s.runId, "--child", "dev-1", "--issue-file", s.done], { LA_AUTONOMY_CONFIG: cfg }), fail);
  assert.equal(out.ok, true, out.error);
  assert.match(out.keys.landed, /ancestors of main/);
  assert.ok(!existsSync(s.worktree));
});

// ── 4. the archive precondition (third half of the relaxed key) ──────────────
console.log("\nAC1 — warunek archiwizacji (trzeci warunek)");

test("archive precondition: archived ignored content + grant + landed removes with no gate", () => {
  const s = scenario({ ignored: ["debug.log"] });
  archiveFile(s, "debug.log");
  const cfg = autonomyConfig(s.base, [coveringGrant(s)]);

  const out = parse(cleanup(["remove", "--run", s.runId, "--child", "dev-1", "--issue-file", s.done], { LA_AUTONOMY_CONFIG: cfg }), fail);
  assert.equal(out.ok, true, out.error);
  assert.ok(!existsSync(s.worktree), "the directory survived the grant-path removal");
  assert.equal(allGates(s.runId).length, 0, "a gate was emitted for a grant-covered removal");
  assert.match(out.keys.grant, /cleanup-own-worktree/);
  assert.match(out.keys.archive, /1 ignored\/untracked file\(s\) covered by/, "the record does not say what was archived");
  assert.equal(readRegistry(s.runId).children["dev-1"].cleanupGrant, "cleanup-own-worktree");
});

test("archive precondition: ignored content NOT archived → refuses naming 'not archived', not 'not landed'", () => {
  const s = scenario({ ignored: ["debug.log"] });
  const cfg = autonomyConfig(s.base, [coveringGrant(s)]);

  const out = parse(cleanup(["remove", "--run", s.runId, "--child", "dev-1", "--issue-file", s.done], { LA_AUTONOMY_CONFIG: cfg }), fail);
  assert.equal(out.ok, false);
  assert.match(out.error, /not archived/, `wrong refusal: ${out.error}`);
  assert.doesNotMatch(out.error, /not landed/, "the refusal must blame the archive half, not the landed half");
  assert.doesNotMatch(out.error, /no recorded grant/, "the refusal must blame the archive half, not a missing grant");
  assert.ok(existsSync(s.worktree), "the tree was removed despite the archive refusal");
  assert.ok(existsSync(join(s.worktree, "debug.log")), "the only copy of the ignored file was destroyed");
});

test("archive precondition: an archive that misses one file does not cover", () => {
  const s = scenario({ ignored: ["debug.log", "trace.log"] });
  archiveFile(s, "debug.log");
  const cfg = autonomyConfig(s.base, [coveringGrant(s)]);

  const out = parse(cleanup(["remove", "--run", s.runId, "--child", "dev-1", "--issue-file", s.done], { LA_AUTONOMY_CONFIG: cfg }), fail);
  assert.equal(out.ok, false);
  assert.match(out.error, /not archived/);
  assert.match(out.error, /trace\.log/, "the refusal must name what it found uncovered");
  assert.ok(existsSync(join(s.worktree, "trace.log")));
});

test("archive coverage is path-preserving: .state/ content covers only at the same relative path", () => {
  const covered = scenario({ ignored: [".state/cache.json"] });
  archiveFile(covered, ".state/cache.json");
  const ok = parse(cleanup(["remove", "--run", covered.runId, "--child", "dev-1", "--issue-file", covered.done], { LA_AUTONOMY_CONFIG: autonomyConfig(covered.base, [coveringGrant(covered)]) }), fail);
  assert.equal(ok.ok, true, ok.error);

  // A flattened copy (content moved out of .state/) is out of convention —
  // an archive that renamed paths does not cover, fail-closed.
  const flattened = scenario({ ignored: [".state/cache.json"] });
  archiveFile(flattened, "cache.json");
  const out = parse(cleanup(["remove", "--run", flattened.runId, "--child", "dev-1", "--issue-file", flattened.done], { LA_AUTONOMY_CONFIG: autonomyConfig(flattened.base, [coveringGrant(flattened)]) }), fail);
  assert.equal(out.ok, false);
  assert.match(out.error, /not archived/);
  assert.ok(existsSync(join(flattened.worktree, ".state", "cache.json")));
});

test("archive precondition vacuous: no ignored/untracked content needs no archive directory", () => {
  const s = scenario();
  assert.ok(!existsSync(archivePath(s)), "the test premise broke: an archive dir exists");
  const cfg = autonomyConfig(s.base, [coveringGrant(s)]);

  const out = parse(cleanup(["remove", "--run", s.runId, "--child", "dev-1", "--issue-file", s.done], { LA_AUTONOMY_CONFIG: cfg }), fail);
  assert.equal(out.ok, true, out.error);
  assert.match(out.keys.archive, /nothing needed archiving/);
});

test("unarchivedIgnoredContent answers directly, for the FOC-472 reuse", () => {
  const s = scenario({ ignored: ["debug.log", ".state/x.json"] });
  const rep = unarchivedIgnoredContent(s.worktree, archivePath(s));
  assert.equal(rep.covered, false);
  assert.deepEqual(
    [...rep.unarchived].sort(),
    [".state/x.json", "debug.log"],
    `unexpected unarchived set: ${JSON.stringify(rep.unarchived)}`,
  );
  archiveFile(s, "debug.log");
  archiveFile(s, ".state/x.json");
  assert.equal(unarchivedIgnoredContent(s.worktree, archivePath(s)).covered, true);

  // Vacuous direction: clean tree, no ignored content, no archive dir.
  const s2 = scenario();
  const rep2 = unarchivedIgnoredContent(s2.worktree, archivePath(s2));
  assert.equal(rep2.covered, true);
  assert.ok(!existsSync(archivePath(s2)));
});

console.log("\nlist — grantPath per tree");
test("list reports the grant path honestly per tree", () => {
  // A covered tree must SAY it is covered (which grant), not sit there with
  // gate blockers that only stop the two-key route. A missing precondition
  // must be named — "not archived", not a bare covered:false.
  const s = scenario({ ignored: ["debug.log"] });
  const cfg = autonomyConfig(s.base, [coveringGrant(s)]);
  const row = () =>
    parse(cleanup(["list", "--run", s.runId], { LA_AUTONOMY_CONFIG: cfg }), fail).children.find(
      (c) => c.childId === "dev-1",
    );

  let r = row();
  assert.equal(r.grantPath.covered, false);
  assert.match(r.grantPath.note, /not archived/, `note must name the failed half: ${r.grantPath.note}`);
  assert.doesNotMatch(r.grantPath.note, /not landed/);
  assert.doesNotMatch(r.grantPath.note, /no recorded grant/);
  assert.ok(r.localBlockers.some((b) => /propose/.test(b)), JSON.stringify(r.localBlockers));

  archiveFile(s, "debug.log");
  r = row();
  assert.equal(r.grantPath.covered, true);
  assert.equal(r.grantPath.grantId, "cleanup-own-worktree");
  assert.deepEqual(r.localBlockers, [], "gate blockers stop only the two-key route");
  assert.match(r.testApproval, /unchecked/, "the TEST key is not granted away");

  // Shipped config: the repo scope does not match, so the tree keeps its
  // two-key blockers — the note says which half failed (repo).
  const f = scenario();
  const fr = parse(cleanup(["list", "--run", f.runId]), fail).children.find((c) => c.childId === "dev-1");
  assert.equal(fr.grantPath.covered, false);
  assert.match(fr.grantPath.note, /out of scope: repo/);
  assert.ok(fr.localBlockers.some((b) => /propose/.test(b)), JSON.stringify(fr.localBlockers));
});

test("with the shipped config, a foreign repo's tree falls through to the two-key path", () => {
  // The shipped grant scopes repo to "linear-agents"; a worktree of any other
  // repo is declined by the grant and handled by the unchanged two-key path.
  const s = scenario();
  const out = parse(cleanup(["remove", "--run", s.runId, "--child", "dev-1", "--issue-file", s.done]), fail);
  assert.equal(out.ok, false);
  assert.match(out.error, /has not been asked/);
  assert.match(out.error, /cleanup-own-worktree/, "the shipped grant is consulted but the refusal hides that");
  assert.ok(existsSync(s.worktree));
});

test("an unusable autonomy config never unlocks anything — the refusal says so", () => {
  const s = scenario();
  const out = parse(
    cleanup(["remove", "--run", s.runId, "--child", "dev-1", "--issue-file", s.done], {
      LA_AUTONOMY_CONFIG: join(s.base, "autonomy-missing.json"),
    }),
    fail,
  );
  assert.equal(out.ok, false);
  assert.match(out.error, /autonomy config/);
  assert.ok(existsSync(s.worktree));
});

test("a schema-invalid autonomy config is inert at the gate, not fatal", () => {
  const s = scenario();
  const bad = join(s.base, "autonomy-bad.json");
  writeFileSync(bad, JSON.stringify({ neverCovers: [...NEVER_COVERS, "merge"], grants: [] }));

  const out = parse(cleanup(["remove", "--run", s.runId, "--child", "dev-1", "--issue-file", s.done], { LA_AUTONOMY_CONFIG: bad }), fail);
  assert.equal(out.ok, false);
  assert.match(out.error, /autonomy config/);
  assert.ok(existsSync(s.worktree));
});

console.log("\nFOC-649 — honest report, archive automation, both-tips containment");

test("AC1: removal names the ignored content it destroys, and archives it first", () => {
  const s = scenario({ ignored: ["debug.log", ".state/cache.json"] });
  const proposed = parse(cleanup(["propose", "--run", s.runId, "--child", "dev-1", "--issue-file", s.done]), fail);
  parse(gate(["answer", "--run", s.runId, "--gate", proposed.gateId, "--text", "yes"]), fail);

  const out = parse(cleanup(["remove", "--run", s.runId, "--child", "dev-1", "--issue-file", s.done]), fail);
  assert.equal(out.ok, true, out.error);
  assert.equal(out.archived.count, 2, JSON.stringify(out.archived));
  assert.deepEqual([...out.archived.paths].sort(), [".state/cache.json", "debug.log"]);
  assert.match(out.destroyedKind, /tracked, uncommitted/, "the report must say which list is the tracked-dirty one");
  assert.ok(!existsSync(s.worktree), "the worktree survived a successful removal");
  assert.ok(existsSync(archivePath(s, "debug.log")), "the ignored file died with the tree, unarchived");
  assert.ok(existsSync(archivePath(s, ".state/cache.json")), "the .state file died with the tree, unarchived");
});

test("AC1: rebuildable cache is skipped by name, never archived", () => {
  const s = scenario({ ignored: ["node_modules/x.js", ".codegraph/i.db", ".state/cache.json"] });
  const proposed = parse(cleanup(["propose", "--run", s.runId, "--child", "dev-1", "--issue-file", s.done]), fail);
  parse(gate(["answer", "--run", s.runId, "--gate", proposed.gateId, "--text", "yes"]), fail);

  const out = parse(cleanup(["remove", "--run", s.runId, "--child", "dev-1", "--issue-file", s.done]), fail);
  assert.equal(out.ok, true, out.error);
  assert.deepEqual([...out.archived.paths].sort(), [".state/cache.json"], "only work product is archived");
  assert.deepEqual(
    [...out.skippedCache].sort(),
    [
      ".codegraph/ — 1 file(s), skipped: rebuildable by codegraph index init",
      "node_modules/ — 1 file(s), skipped: rebuildable by npm install",
    ],
    `the report must name what was skipped and why: ${JSON.stringify(out.skippedCache)}`,
  );
  assert.ok(!existsSync(archivePath(s, "node_modules")), "cache must not be copied into the archive");
});

test("AC2 negative: a blocked archive destination refuses the whole removal, having deleted nothing", () => {
  // A FILE at the destination path makes every mkdir fail on every platform —
  // chmod-based unwritability is unreliable on win32, this is not.
  const s = scenario({ ignored: ["debug.log"] });
  mkdirSync(join(STATE_HOME, s.runId, "test-artifacts"), { recursive: true });
  writeFileSync(archivePath(s), "a file sitting where the archive dir must go");
  const proposed = parse(cleanup(["propose", "--run", s.runId, "--child", "dev-1", "--issue-file", s.done]), fail);
  parse(gate(["answer", "--run", s.runId, "--gate", proposed.gateId, "--text", "yes"]), fail);

  const out = parse(cleanup(["remove", "--run", s.runId, "--child", "dev-1", "--issue-file", s.done]), fail);
  assert.equal(out.ok, false);
  assert.match(out.error, /archive destination cannot be created/);
  assert.ok(existsSync(s.worktree), "the worktree was removed despite the archive refusal");
  assert.ok(existsSync(join(s.worktree, "debug.log")), "the only copy of the ignored file was destroyed");
});

test("AC3 grant path: the refusal names the checked-out branch, never a landed one with '0 commits'", () => {
  // The mis-attribution FOC-649 fixes: the registry branch is fully landed,
  // but the worktree HEAD sits on a child-made branch with unlanded work.
  const s = scenario();
  gitIn(s.worktree, "checkout", "-b", "wip-local");
  writeFileSync(join(s.worktree, "wip.txt"), "child-branch work\n");
  gitIn(s.worktree, "add", "-A");
  gitIn(s.worktree, "commit", "-m", "wip");
  const cfg = autonomyConfig(s.base, [coveringGrant(s)]);

  const out = parse(cleanup(["remove", "--run", s.runId, "--child", "dev-1", "--issue-file", s.done], { LA_AUTONOMY_CONFIG: cfg }), fail);
  assert.equal(out.ok, false);
  assert.match(out.error, /not landed/);
  assert.match(out.error, /wip-local/, "the refusal must name the branch that actually failed");
  assert.match(out.error, /carries 1 commit/);
  assert.doesNotMatch(out.error, /carries 0/, "a divergent tree must never be described as carrying 0 commits");
  assert.ok(existsSync(s.worktree));
});

test("AC3 two-key: HEAD on a child-made branch with unlanded work is refused by name", () => {
  const s = scenario();
  gitIn(s.worktree, "checkout", "-b", "wip-local");
  writeFileSync(join(s.worktree, "wip.txt"), "child-branch work\n");
  gitIn(s.worktree, "add", "-A");
  gitIn(s.worktree, "commit", "-m", "wip");
  const proposed = parse(cleanup(["propose", "--run", s.runId, "--child", "dev-1", "--issue-file", s.done]), fail);
  parse(gate(["answer", "--run", s.runId, "--gate", proposed.gateId, "--text", "yes"]), fail);

  const out = parse(cleanup(["remove", "--run", s.runId, "--child", "dev-1", "--issue-file", s.done]), fail);
  assert.equal(out.ok, false);
  assert.match(out.error, /wip-local/);
  assert.match(out.error, /does not name/, "the refusal must say WHY a foreign branch is outside the approval");
  assert.ok(existsSync(s.worktree));
});

test("AC3 two-key: a HEAD on a foreign branch that IS landed proceeds", () => {
  const s = scenario();
  gitIn(s.worktree, "checkout", "-b", "wip-local");
  writeFileSync(join(s.worktree, "landed.txt"), "landed\n");
  gitIn(s.worktree, "add", "-A");
  gitIn(s.worktree, "commit", "-m", "landed");
  gitIn(s.repo, "merge", "--ff-only", "wip-local");
  const proposed = parse(cleanup(["propose", "--run", s.runId, "--child", "dev-1", "--issue-file", s.done]), fail);
  parse(gate(["answer", "--run", s.runId, "--gate", proposed.gateId, "--text", "yes"]), fail);

  const out = parse(cleanup(["remove", "--run", s.runId, "--child", "dev-1", "--issue-file", s.done]), fail);
  assert.equal(out.ok, true, out.error);
  assert.ok(!existsSync(s.worktree));
});

test("AC3 two-key: a detached HEAD with unlanded work is refused too", () => {
  const s = scenario();
  gitIn(s.worktree, "checkout", "-b", "wip-local");
  writeFileSync(join(s.worktree, "wip.txt"), "child-branch work\n");
  gitIn(s.worktree, "add", "-A");
  gitIn(s.worktree, "commit", "-m", "wip");
  gitIn(s.worktree, "checkout", "--detach");
  const proposed = parse(cleanup(["propose", "--run", s.runId, "--child", "dev-1", "--issue-file", s.done]), fail);
  parse(gate(["answer", "--run", s.runId, "--gate", proposed.gateId, "--text", "yes"]), fail);

  const out = parse(cleanup(["remove", "--run", s.runId, "--child", "dev-1", "--issue-file", s.done]), fail);
  assert.equal(out.ok, false);
  assert.match(out.error, /detached/);
  assert.match(out.error, /does not name/);
  assert.ok(existsSync(s.worktree));
});

test("narrowed inventory: cache trees leave the inventory, ambiguity stays in it", () => {
  const s = scenario({ ignored: ["node_modules/g.js", ".codegraph/i.db", ".state/cache.json"] });
  writeFileSync(join(s.worktree, "notes.txt"), "untracked, not ignored, not a known cache\n");

  const rep = unarchivedIgnoredContent(s.worktree, archivePath(s));
  assert.equal(rep.covered, false);
  assert.deepEqual([...rep.unarchived].sort(), [".state/cache.json", "notes.txt"]);
  assert.deepEqual([...rep.ignored].sort(), [".state/cache.json"], "cache paths must leave `ignored`");
  assert.deepEqual([...rep.untracked].sort(), ["notes.txt"], "an ambiguous untracked file stays IN");
  assert.deepEqual(
    rep.skippedCache.map((e) => [e.prefix, e.files]).sort(),
    [[".codegraph/", 1], ["node_modules/", 1]],
  );

  archiveFile(s, ".state/cache.json");
  archiveFile(s, "notes.txt");
  assert.equal(unarchivedIgnoredContent(s.worktree, archivePath(s)).covered, true);
});

test("narrowed inventory flows into the grant precondition: only work product blocks coverage", () => {
  const s = scenario({ ignored: ["node_modules/g.js", ".state/cache.json"] });
  const cfg = autonomyConfig(s.base, [coveringGrant(s)]);
  const remove = () => cleanup(["remove", "--run", s.runId, "--child", "dev-1", "--issue-file", s.done], { LA_AUTONOMY_CONFIG: cfg });

  let out = parse(remove(), fail);
  assert.equal(out.ok, false);
  assert.match(out.error, /not archived/);
  assert.match(out.error, /cache\.json/);
  assert.doesNotMatch(out.error, /node_modules/, "cache must not block the grant — it is not work product");

  archiveFile(s, ".state/cache.json");
  out = parse(remove(), fail);
  assert.equal(out.ok, true, out.error);
  assert.match(out.keys.archive, /1 ignored\/untracked file\(s\) covered/);
  assert.match(out.skippedCache.join("\n"), /node_modules/);
});

summary();