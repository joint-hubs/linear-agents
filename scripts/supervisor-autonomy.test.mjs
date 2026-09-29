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
// Isolation: the supervisor state home is redirected to a mkdtemp dir at
// module load (the LA_SUPERVISOR_STATE_HOME seam, same as
// supervisor-guard.test.mjs) and the spawned cleanup processes inherit it; the
// autonomy config is redirected per-invocation via the LA_AUTONOMY_CONFIG seam
// pointed at temp files. Nothing touches the repo's real .state/.
//
// Run: node scripts/supervisor-autonomy.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

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
import { readRegistry, writeRegistry } from "./supervisor-lib.mjs";

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
function scenario({ status = "exited", dirty = null } = {}) {
  const { base, repo } = fixtureRepo();
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

  return { base, repo, runId, repoName: basename(repo), ...wt, done: issueFile(base, "Done", "completed") };
}

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

summary();