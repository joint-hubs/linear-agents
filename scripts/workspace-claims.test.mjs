// scripts/workspace-claims.test.mjs — P1 resource ownership: the claim registry
// and the integration lock.
//
// The load-bearing properties:
//   · two processes racing to claim one branch → exactly one wins, the loser
//     is refused with the winner named (the O_EXCL + registry contract);
//   · an owner reuses its OWN branch/path/history; nobody else's — never a
//     steal, never a reset;
//   · a legacy (owner-less) ensureWorktree call is refused on a claimed branch;
//   · the integration lock releases on a throw, refuses a second process while
//     held, survives a crash as EXPLICIT recovery, and is keyed on the common
//     git dir so all worktrees of one repo share it;
//   · a managed ensureWorktree (the spawn path) meets a held lock as a FAST
//     refusal naming the holder — the P1b cap=2 spawn-vs-merge case — with no
//     worktree or claim written, and succeeds once the holder releases.
//
// Run: node scripts/workspace-claims.test.mjs
// Focused suite only — the whole supervisor suite is not required here.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

import { ROOT, fixtureRepo, gitIn, harness, runScript } from "./supervisor-test-fixtures.mjs";
import { worktreeRoot as worktreeRootOf } from "./fenix-paths.mjs";
import {
  claimWorkspace,
  commonGitDir,
  integrationLockPathFor,
  readIntegrationLock,
  readWorkspaceClaims,
  withIntegrationLock,
} from "./workspace-claims.mjs";
import { ensureWorktree } from "./supervisor-lib.mjs";

const { test, fail, summary } = harness();
const CLAIMS = join(ROOT, "scripts", "workspace-claims.mjs");
const CLAIMS_URL = pathToFileURL(CLAIMS).href;
const SUP_LIB_URL = pathToFileURL(join(ROOT, "scripts", "supervisor-lib.mjs")).href;

const inRoot = (repo, name) => join(worktreeRootOf(repo), name);

// ── 1. two owners race on one branch ─────────────────────────────────────────
console.log("\ntwo processes race on one branch: exactly one wins");
{
  const { base, repo } = fixtureRepo();
  // The race itself runs inside one child process so the two claim CLI
  // processes can be spawned CONCURRENTLY (spawnSync here would serialize them
  // and prove nothing about the atomic acquisition).
  const runner = join(base, "race-runner.mjs");
  writeFileSync(
    runner,
    [
      `import { spawn } from "node:child_process";`,
      `const [claims, gitRoot, branch, wa, wb, oa, ob] = process.argv.slice(2);`,
      `const one = (worktree, owner) => new Promise((res) => {`,
      `  const c = spawn(process.execPath, [claims, "claim", "--git-root", gitRoot, "--branch", branch,`,
      `    "--worktree", worktree, "--owner", owner], { stdio: ["ignore", "pipe", "pipe"] });`,
      `  let out = "", err = "";`,
      `  c.stdout.on("data", (d) => (out += d));`,
      `  c.stderr.on("data", (d) => (err += d));`,
      `  c.on("close", (code) => res({ code, out, err }));`,
      `});`,
      `const [a, b] = await Promise.all([one(wa, oa), one(wb, ob)]);`,
      `console.log(JSON.stringify({ a: { code: a.code, body: a.out }, b: { code: b.code, body: b.out } }));`,
    ].join("\n"),
  );
  const res = spawnSync(
    process.execPath,
    [runner, CLAIMS, repo, "foc-race-dev", inRoot(repo, "wt-a"), inRoot(repo, "wt-b"), "run-1:dev-1", "run-2:dev-1"],
    { cwd: ROOT, encoding: "utf8" },
  );
  if (res.status !== 0) fail(`race runner failed: ${res.stderr}`);
  const verdict = JSON.parse(res.stdout);
  const results = [verdict.a, verdict.b].map((r) => {
    const body = JSON.parse(r.body);
    return { ...body, code: r.code };
  });
  const winners = results.filter((r) => r.ok === true);
  const losers = results.filter((r) => r.ok === false);
  if (winners.length !== 1 || losers.length !== 1) {
    fail(`expected exactly one winner and one loser, got ${JSON.stringify(results)}`);
  }
  if (winners[0].status !== "claimed") fail(`the winner should have claimed, got ${JSON.stringify(winners[0])}`);
  if (!/claimed by owner "run-[12]:dev-1"/.test(losers[0].error)) {
    fail(`the loser's refusal should name the winning owner, got: ${losers[0].error}`);
  }
  const claims = readWorkspaceClaims({ gitRoot: repo }).claims;
  if (claims.length !== 1 || claims[0].branch !== "foc-race-dev") fail(`registry must hold exactly the winning claim, got ${JSON.stringify(claims)}`);
  if (!winners.map((w) => w.code).includes(0) || !losers.map((l) => l.code).includes(1)) {
    fail(`CLI exit codes must follow the verdicts (0 win, 1 conflict), got ${JSON.stringify(results.map((r) => r.code))}`);
  }
  test("two owners race on one branch — one wins, the loser is refused with the winner named", () => {});
}

// ── 2. same owner retry ──────────────────────────────────────────────────────
console.log("\nsame owner reuses its own branch, path and history");
{
  const { repo } = fixtureRepo();
  const wt = inRoot(repo, "shared-tree");
  const first = claimWorkspace({ gitRoot: repo, branch: "foc-1-dev", worktree: wt, ownerId: "run-1:dev-1" });
  if (first.status !== "claimed") fail(`first claim should create, got ${first.status}`);
  const second = claimWorkspace({ gitRoot: repo, branch: "foc-1-dev", worktree: wt, ownerId: "run-1:dev-1" });
  if (second.status !== "reused") fail(`same owner retry should reuse, got ${second.status}`);
  if (second.moved !== false) fail("same path must not be a re-stamp");
  if (second.claim.history.length !== 2) fail(`history should be append-only, got ${JSON.stringify(second.claim.history)}`);
  if (second.claim.claimedAt !== first.claim.claimedAt) fail("a reuse must keep the original claimedAt");
  // Same owner, moved path — a re-stamp of its own claim, history records it.
  const moved = claimWorkspace({ gitRoot: repo, branch: "foc-1-dev", worktree: inRoot(repo, "moved-tree"), ownerId: "run-1:dev-1" });
  if (!moved.moved || moved.status !== "reused") fail(`a same-owner path move is a re-stamp, got ${JSON.stringify(moved)}`);
  if (!moved.claim.history.some((h) => h.event === "restamped")) fail("the restamp must be in the owner's history");
  // A different owner on the same branch is refused — no reset, no delete.
  assert.throws(
    () => claimWorkspace({ gitRoot: repo, branch: "foc-1-dev", worktree: wt, ownerId: "run-2:dev-1" }),
    /claimed by owner "run-1:dev-1"/,
  );
  test("same owner retry reuses its claim; another owner is refused with an informative conflict", () => {});
}

// ── 3. different branches, different owners ──────────────────────────────────
console.log("\ndifferent branches and owners coexist");
{
  const { repo } = fixtureRepo();
  const a = claimWorkspace({ gitRoot: repo, branch: "foc-1-dev", worktree: inRoot(repo, "wt-a"), ownerId: "run-1:dev-1" });
  const b = claimWorkspace({ gitRoot: repo, branch: "foc-2-review", worktree: inRoot(repo, "wt-b"), ownerId: "run-2:rev-1" });
  if (a.status !== "claimed" || b.status !== "claimed") fail(`independent claims must both be granted, got ${JSON.stringify({ a: a.status, b: b.status })}`);
  const claims = readWorkspaceClaims({ gitRoot: repo }).claims;
  if (claims.length !== 2) fail(`both claims must be in the registry, got ${JSON.stringify(claims)}`);
  test("different branches with different owners are both granted", () => {});
}

// ── 4. common git dir ────────────────────────────────────────────────────────
console.log("\nclaims are repo-wide (common git dir), not per-checkout");
{
  const { base, repo } = fixtureRepo();
  const wt = inRoot(repo, "wt-branch");
  mkdirSync(worktreeRootOf(repo), { recursive: true });
  gitIn(repo, "worktree", "add", "-b", "shared", wt, "HEAD");
  // Claim made through the WORKTREE's gitRoot...
  claimWorkspace({ gitRoot: wt, branch: "foc-1-dev", worktree: inRoot(repo, "wt-claim"), ownerId: "run-1:dev-1" });
  const fromMain = readWorkspaceClaims({ gitRoot: repo });
  const fromWorktree = readWorkspaceClaims({ gitRoot: wt });
  if (fromMain.claims.length !== 1) fail(`a claim made via the worktree must be visible from the main repo, got ${JSON.stringify(fromMain)}`);
  if (fromWorktree.commonGitDir !== fromMain.commonGitDir) fail("both checkouts must resolve the same common git dir");
  if (fromWorktree.claims.length !== 1) fail("both checkouts must read the same registry");
  if (!fromMain.commonGitDir.includes(basename(repo))) fail(`the registry lives under the repo's own .git, got ${fromMain.commonGitDir}`);
  // ...and a different repo shares nothing.
  const { repo: other } = fixtureRepo();
  const otherClaims = readWorkspaceClaims({ gitRoot: other });
  if (otherClaims.claims.length !== 0) fail(`a separate repo must not see the other's claims, got ${JSON.stringify(otherClaims)}`);
  if (otherClaims.commonGitDir === fromMain.commonGitDir) fail("two repos must not collide on one registry");
  test("one common git dir, one registry — visible from every worktree, never across repos", () => {});
}

// ── 5. lock release on throw ─────────────────────────────────────────────────
console.log("\nthe integration lock releases on a throw");
{
  const { repo } = fixtureRepo();
  assert.throws(() => withIntegrationLock(repo, "run-1:dev-1", () => { throw new Error("boom"); }), /boom/);
  const lockPath = integrationLockPathFor(commonGitDir(repo));
  if (existsSync(lockPath)) fail(`the lock file must be gone after a throwing fn, got ${lockPath}`);
  const value = withIntegrationLock(repo, "run-1:dev-1", () => 42);
  if (value !== 42) fail("the next acquisition must work and pass the value through");
  if (readIntegrationLock({ gitRoot: repo }) !== null) fail("the lock must be released after the fn returns");
  test("withIntegrationLock releases on a throw and the next acquisition succeeds", () => {});
}

// ── 6. legacy ensureWorktree on a claimed branch ─────────────────────────────
console.log("\nlegacy ensureWorktree refuses claimed branches, keeps everything else");
{
  const { repo } = fixtureRepo();
  claimWorkspace({ gitRoot: repo, branch: "foc-claimed-dev", worktree: inRoot(repo, "claimed"), ownerId: "run-1:dev-1" });
  assert.throws(() => ensureWorktree(repo, "foc-claimed-dev"), /claimed by owner "run-1:dev-1"/);
  // Legacy on an unclaimed branch: unchanged behaviour (create, then reuse).
  const created = ensureWorktree(repo, "foc-legacy-dev");
  if (!created.created) fail("legacy create must still work on an unclaimed branch");
  const reused = ensureWorktree(repo, "foc-legacy-dev");
  if (reused.created !== false) fail("legacy reuse must still work on an unclaimed branch");
  if (reused.worktree !== created.worktree) fail("legacy reuse must hand back the same tree");
  test("3-arg legacy ensureWorktree is refused on a claimed branch and unchanged otherwise", () => {});
}

// ── 7. managed ensureWorktree claims, reuses, refuses ────────────────────────
console.log("\nmanaged ensureWorktree (ownerId) stamps a durable claim");
{
  const { repo } = fixtureRepo();
  const first = ensureWorktree(repo, "foc-1-dev", null, { ownerId: "run-1:dev-1" });
  if (!first.created || first.owner !== "run-1:dev-1") fail(`a managed create must stamp its owner, got ${JSON.stringify(first)}`);
  if (first.claim.status !== "claimed") fail(`the first managed call claims, got ${JSON.stringify(first.claim)}`);
  const stored = readWorkspaceClaims({ gitRoot: repo }).claims.find((c) => c.branch === "foc-1-dev");
  if (!stored || stored.worktree !== first.worktree) fail(`the registry must hold the stamped claim, got ${JSON.stringify(stored)}`);
  const second = ensureWorktree(repo, "foc-1-dev", null, { ownerId: "run-1:dev-1" });
  if (second.created !== false || second.claim.status !== "reused") fail(`the same owner reuses, got ${JSON.stringify(second)}`);
  assert.throws(
    () => ensureWorktree(repo, "foc-1-dev", null, { ownerId: "run-2:dev-1" }),
    /claimed by owner "run-1:dev-1"/,
  );
  test("managed ensureWorktree reuses its own claim and refuses another owner's branch", () => {});
}

// ── 8. containment ───────────────────────────────────────────────────────────
console.log("\na claim refuses a worktree outside the workspace root");
{
  const { base, repo } = fixtureRepo();
  assert.throws(
    () => claimWorkspace({ gitRoot: repo, branch: "foc-1-dev", worktree: join(base, "outside"), ownerId: "run-1:dev-1" }),
    /not contained in the worktree root/,
  );
  if (existsSync(commonGitDir(repo) + "\\workspace-claims\\claims.json") && readWorkspaceClaims({ gitRoot: repo }).claims.length) {
    fail("a refused claim must not be written");
  }
  test("a worktree path outside the worktree root is refused before anything is written", () => {});
}

// ── 9. held lock, crash, explicit recovery ───────────────────────────────────
console.log("\nlock held by another process refuses; a crash leaves explicit recovery");
{
  const { base, repo } = fixtureRepo();
  // One child orchestrates the cross-process scenario so this file can stay
  // in the repo's synchronous harness: it starts a holder, gets refused while
  // the lock is held, hard-kills the holder (the lock file must REMAIN — no
  // stale auto-delete), refuses further claims, and recovers explicitly.
  const holder = join(base, "holder.mjs");
  writeFileSync(
    holder,
    [
      `import { acquireIntegrationLock } from "${CLAIMS_URL}";`,
      `acquireIntegrationLock({ gitRoot: process.argv[2], ownerId: "run-crash:dev-1" });`,
      `console.log("HELD");`,
      `setInterval(() => {}, 1000); // hold until killed`,
    ].join("\n"),
  );
  const runner = join(base, "lock-runner.mjs");
  writeFileSync(
    runner,
    [
      `import { spawn, spawnSync } from "node:child_process";`,
      `import { readIntegrationLock, acquireIntegrationLock } from "${CLAIMS_URL}";`,
      `import { claimWorkspace } from "${CLAIMS_URL}";`,
      `const [gitRoot, holderScript] = process.argv.slice(2);`,
      `const holder = spawn(process.execPath, [holderScript, gitRoot], { stdio: ["ignore", "pipe", "pipe"] });`,
      `const deadline = Date.now() + 15_000;`,
      `while (!readIntegrationLock({ gitRoot })) {`,
      `  if (Date.now() > deadline) { console.log(JSON.stringify({ ok: false, error: "holder never took the lock" })); process.exit(1); }`,
      `  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);`,
      `}`,
      `let refusedWhileHeld = null;`,
      `try { acquireIntegrationLock({ gitRoot, ownerId: "other-owner" }); } catch (err) { refusedWhileHeld = err.message; }`,
      `let claimRefusedWhileHeld = null;`,
      `try { claimWorkspace({ gitRoot, branch: "foc-x-dev", worktree: process.argv[4], ownerId: "other-owner" }); } catch (err) { claimRefusedWhileHeld = err.message; }`,
      `holder.kill("SIGKILL");`,
      `await new Promise((r) => holder.on("close", r));`,
      `const crashLeftLock = Boolean(readIntegrationLock({ gitRoot }));`,
      `const noForce = spawnSync(process.execPath, [process.argv[5], "recover", "--git-root", gitRoot], { encoding: "utf8" });`,
      `spawnSync(process.execPath, [process.argv[5], "recover", "--git-root", gitRoot, "--force"], { encoding: "utf8" });`,
      `let reacquired = null;`,
      `try { acquireIntegrationLock({ gitRoot, ownerId: "other-owner" }).release(); } catch (err) { reacquired = err.message; }`,
      `console.log(JSON.stringify({ ok: true, refusedWhileHeld, claimRefusedWhileHeld, crashLeftLock,`,
      `  recoverRefused: noForce.status !== 0, reacquired: reacquired === null }));`,
    ].join("\n"),
  );
  const res = spawnSync(process.execPath, [runner, repo, holder, inRoot(repo, "wt-x"), CLAIMS], { cwd: ROOT, encoding: "utf8" });
  if (res.status !== 0) fail(`lock runner failed: ${res.stderr}`);
  const v = JSON.parse(res.stdout);
  if (!v.ok) fail(`lock runner said no: ${v.error}`);
  if (!/held by owner "run-crash:dev-1"/.test(v.refusedWhileHeld ?? "")) fail(`another process must be refused while the lock is held, got ${v.refusedWhileHeld}`);
  if (!/held/.test(v.claimRefusedWhileHeld ?? "")) fail(`a claim must also be refused while the lock is held, got ${v.claimRefusedWhileHeld}`);
  if (!v.crashLeftLock) fail("a hard crash must leave the lock on disk — explicit recovery, never auto-delete");
  if (!v.recoverRefused) fail("recover without --force must refuse (no stale auto-delete)");
  if (!v.reacquired) fail("after explicit recovery a new acquisition must succeed");
  test("held lock refuses other processes; a crash leaves it for explicit recovery, which unblocks", () => {});
}

// ── 10. corrupt registry ─────────────────────────────────────────────────────
console.log("\na corrupt claims registry fails closed");
{
  const { repo } = fixtureRepo();
  const path = join(commonGitDir(repo), "workspace-claims");
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "claims.json"), "{ not json");
  assert.throws(() => readWorkspaceClaims({ gitRoot: repo }), /not readable JSON/);
  assert.throws(() => ensureWorktree(repo, "foc-1-dev"), /not readable JSON/);
  test("an unreadable registry throws instead of reading as 'no claims'", () => {});
}

// ── 11. cap=2 contention: a spawn vs a held integration lock ─────────────────
console.log();
console.log("managed ensureWorktree is refused while the lock is held, and succeeds after release");
{
  const { base, repo } = fixtureRepo();
  // The P1b cap=2 scenario: two task sessions share one repo, so a child's
  // worktree creation (managed ensureWorktree) can meet a merge run that holds
  // the same integration lock. The contract is fail-fast — the spawn is refused
  // with the holder named, it never queues behind the merge (the holder holds
  // until told to stop, so a wait would deadlock this runner) — the refusal
  // writes neither a worktree nor a claim, and a clean release unblocks the
  // very same call.
  const NL = String.fromCharCode(10);
  const holder = join(base, "merge-holder.mjs");
  writeFileSync(
    holder,
    [
      `import { existsSync } from "node:fs";`,
      `import { acquireIntegrationLock } from "${CLAIMS_URL}";`,
      `acquireIntegrationLock({ gitRoot: process.argv[2], ownerId: "merge:run-x" });`,
      `const releaseFlag = process.argv[3];`,
      `const poll = () => (existsSync(releaseFlag) ? process.exit(0) : setTimeout(poll, 50));`,
      `poll(); // hold until the runner says the probe is done`,
    ].join(NL),
  );
  const runner = join(base, "cap2-runner.mjs");
  writeFileSync(
    runner,
    [
      `import { spawn } from "node:child_process";`,
      `import { writeFileSync } from "node:fs";`,
      `import { readIntegrationLock, readWorkspaceClaims } from "${CLAIMS_URL}";`,
      `import { ensureWorktree } from "${SUP_LIB_URL}";`,
      `const [gitRoot, holderScript, releaseFlag] = process.argv.slice(2);`,
      `const holder = spawn(process.execPath, [holderScript, gitRoot, releaseFlag], { stdio: ["ignore", "ignore", "pipe"] });`,
      `const deadline = Date.now() + 15_000;`,
      `while (!readIntegrationLock({ gitRoot })) {`,
      `  if (Date.now() > deadline) { console.log(JSON.stringify({ ok: false, error: "holder never took the lock" })); process.exit(1); }`,
      `  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);`,
      `}`,
      `let refusedWhileHeld = null;`,
      `try { ensureWorktree(gitRoot, "foc-cap2-dev", null, { ownerId: "run-2:dev-1" }); } catch (err) { refusedWhileHeld = err.message; }`,
      `const lockSurvivedRefusal = Boolean(readIntegrationLock({ gitRoot }));`,
      `const claimUntouched = !readWorkspaceClaims({ gitRoot }).claims.some((c) => c.branch === "foc-cap2-dev");`,
      `writeFileSync(releaseFlag, "go");`,
      `const holderExit = await new Promise((r) => holder.on("close", (code) => r(code)));`,
      `const lockAfterCleanExit = Boolean(readIntegrationLock({ gitRoot }));`,
      `let createdAfterRelease = null;`,
      `try { const r = ensureWorktree(gitRoot, "foc-cap2-dev", null, { ownerId: "run-2:dev-1" }); createdAfterRelease = r.created === true && r.owner === "run-2:dev-1"; } catch (err) { createdAfterRelease = "threw: " + err.message; }`,
      `console.log(JSON.stringify({ ok: true, refusedWhileHeld, lockSurvivedRefusal, claimUntouched, holderExit, lockAfterCleanExit, createdAfterRelease }));`,
    ].join(NL),
  );
  const res = spawnSync(process.execPath, [runner, repo, holder, join(base, "release.flag")], { cwd: ROOT, encoding: "utf8" });
  if (res.status !== 0) fail(`cap2 runner failed: ${res.stderr}`);
  const v = JSON.parse(res.stdout);
  if (!v.ok) fail(`cap2 runner said no: ${v.error}`);
  if (!/held by owner "merge:run-x"/.test(v.refusedWhileHeld ?? "")) {
    fail(`the spawn must be refused naming the holder, got: ${v.refusedWhileHeld}`);
  }
  if (!v.lockSurvivedRefusal) fail("a refused spawn must not clear or steal the holder's lock");
  if (!v.claimUntouched) fail("a refused spawn must not write a claim");
  if (v.holderExit !== 0) fail(`the holder must exit cleanly (release on exit), got code ${v.holderExit}`);
  if (v.lockAfterCleanExit) fail("a clean exit must release the lock, not leave it for recovery");
  if (v.createdAfterRelease !== true) fail(`the same call must succeed after release, got ${JSON.stringify(v.createdAfterRelease)}`);
  test("managed ensureWorktree is refused fail-fast while the lock is held and succeeds after a clean release", () => {});
}

summary();
