#!/usr/bin/env node
// scripts/workspace-claims.mjs — durable ownership of a supervisor workspace.
//
//   node scripts/workspace-claims.mjs claim --git-root <dir> --branch <b> --worktree <w> --owner <id>
//   node scripts/workspace-claims.mjs read --git-root <dir>
//   node scripts/workspace-claims.mjs recover --git-root <dir> --force
//
// WHY (P1 resource ownership). ensureWorktree reuses any existing worktree for
// a branch — with several owners (supervisor runs, CLI operators) sharing one
// repo, two of them could receive the SAME branch workspace and write over
// each other's trees. The existing signature has no notion of who is asking.
//
// This module is the ownership layer:
//
//   · a durable CLAIM REGISTRY lives under the repo's CANONICAL common git dir
//     (`git rev-parse --git-common-dir`, resolved + realpathed) — one registry
//     per repository, shared by every worktree of it, so a claim made through
//     the main checkout is visible through every child worktree and vice versa;
//   · every mutation goes through the INTEGRATION LOCK — one exclusive lock
//     file per repo (all worktrees), also under the common git dir — so a
//     claim, a check and a `git worktree add` either happen together or not at
//     all, and supervisor-merge holds the same lock across its whole workflow;
//   · ownership is never stolen: a claim held by an unknown owner (including a
//     dead process) is a hard refusal. There is no liveness probing and no
//     expiry — recovery is always an explicit human decision.
//
// Files, both inside `<commonGitDir>/workspace-claims/`:
//
//   claims.json        the claim registry (versioned, fail-closed on read)
//   integration.lock   the exclusive lock record: owner, pid + process token
//
// Atomicity: claim acquisition takes the lock with O_EXCL creation (`wx`) —
// the filesystem guarantees exactly one winner across processes; the registry
// itself is rewritten through atomicWriteJSON (temp + rename). The temp file
// atomicWriteJSON produces sits NEXT TO its target, i.e. inside the canonical
// claims dir — never in some other workspace.

import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";

import { atomicWriteJSON } from "./utils.mjs";
import { worktreeRoot as worktreeRootFromPaths } from "./fenix-paths.mjs";

export const CLAIMS_SCHEMA_VERSION = 1;

// ── process identity ─────────────────────────────────────────────────────────
//
// The lock record carries pid + a per-process random token. Matching is ALWAYS
// on the whole token, never on the pid alone: a pid is reusable (the next
// process on this machine could carry it), so a pid match proves nothing. A
// token match proves the record was written by THIS process instance, which is
// what reentrancy and release are decided on.
const PROCESS_TOKEN = `${process.pid}-${randomBytes(8).toString("hex")}`;

// ── paths ────────────────────────────────────────────────────────────────────

const gitRun = (args, cwd) =>
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }).trim();

function realpathOr(path) {
  try {
    return realpathSync(path);
  } catch {
    // Not there yet (a claim can precede creation) — the resolved form is the
    // best canonical answer available.
    return resolve(path);
  }
}

/**
 * The repo's canonical common git dir — the SAME value whether you ask from the
 * main checkout or from any of its worktrees. Every registry path below is
 * derived from this, which is what makes claims repo-wide rather than
 * per-checkout. Realpathed so two spellings of the same directory (symlink,
 * forward vs back slashes) cannot produce two registries.
 */
export function commonGitDir(gitRoot) {
  const raw = gitRun(["rev-parse", "--git-common-dir"], gitRoot);
  return realpathOr(resolve(gitRoot, raw));
}

export const claimsDirFor = (commonDir) => join(commonDir, "workspace-claims");
export const claimsPathFor = (commonDir) => join(claimsDirFor(commonDir), "claims.json");
export const integrationLockPathFor = (commonDir) => join(claimsDirFor(commonDir), "integration.lock");

/**
 * The repo's MAIN worktree — the first `git worktree list` entry, the same
 * ordering supervisor-merge relies on — as the anchor of the canonical
 * workspace root. A child worktree passed as gitRoot must NOT re-anchor the
 * root to itself: the workspace a claim may cover is a property of the REPO,
 * not of whichever checkout happened to call.
 */
function mainWorktreeOf(gitRoot, commonDir) {
  const out = gitRun(["worktree", "list", "--porcelain"], gitRoot);
  const first = out.split(/\r?\n/).find((l) => l.startsWith("worktree "));
  return realpathOr(first ? first.slice("worktree ".length) : dirname(commonDir));
}

// ── path comparison ──────────────────────────────────────────────────────────

const normPath = (p) => {
  const s = String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? s.toLowerCase() : s;
};
const samePath = (a, b) => normPath(a) === normPath(b);
const containedIn = (child, parent) => {
  const c = normPath(child);
  const p = normPath(parent);
  return c === p || c.startsWith(`${p}/`);
};

// ── refusals ─────────────────────────────────────────────────────────────────

/** A structured conflict: the message is informative, the detail machine-readable. */
function conflict(message, detail) {
  const err = new Error(message);
  err.code = "WORKSPACE_CLAIM_CONFLICT";
  err.conflict = detail;
  return err;
}

// ── the registry ─────────────────────────────────────────────────────────────

/**
 * Read + validate the registry. Fail-closed like holds.json: an unreadable or
 * invalid store THROWS rather than reading as "no claims" — silently treating
 * a broken registry as unowned would hand every claimed workspace to the next
 * caller.
 */
function readClaimsStore(path, commonDir) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`${path} is not readable JSON: ${err.message} — fix or re-create the claims registry, never guess across versions`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} is not a JSON object`);
  }
  if (parsed.version !== CLAIMS_SCHEMA_VERSION) {
    throw new Error(
      `${path} carries version ${JSON.stringify(parsed.version)} — expected ${CLAIMS_SCHEMA_VERSION}; migrate or re-create the registry, never guess across versions`,
    );
  }
  if (!Array.isArray(parsed.claims)) throw new Error(`${path} carries no claims array`);
  for (const claim of parsed.claims) {
    for (const field of ["branch", "ownerId", "worktree"]) {
      if (typeof claim?.[field] !== "string" || !claim[field].trim()) {
        throw new Error(`${path}: claim ${JSON.stringify(claim?.branch ?? "?")} has no ${field}`);
      }
    }
  }
  return { version: parsed.version, claims: parsed.claims };
}

/**
 * All claims for the repository `gitRoot` belongs to. A missing registry is an
 * empty one; an invalid one throws (see readClaimsStore).
 */
export function readWorkspaceClaims({ gitRoot }) {
  const commonDir = commonGitDir(gitRoot);
  const path = claimsPathFor(commonDir);
  if (!existsSync(path)) {
    return { commonGitDir: commonDir, path, version: CLAIMS_SCHEMA_VERSION, claims: [] };
  }
  const store = readClaimsStore(path, commonDir);
  return { commonGitDir: commonDir, path, version: store.version, claims: store.claims };
}

/**
 * The lock record, or null when the repo is unlocked. Never throws on an
 * unreadable record — a half-written lock (a process killed between O_EXCL and
 * its write) still MUST refuse acquisition, it just names an unknown holder.
 */
export function readIntegrationLock({ gitRoot }) {
  const path = integrationLockPathFor(commonGitDir(gitRoot));
  if (!existsSync(path)) return null;
  try {
    const record = JSON.parse(readFileSync(path, "utf8"));
    return record && typeof record === "object" ? { ...record, path } : { path, unreadable: true };
  } catch {
    return { path, unreadable: true };
  }
}

// ── the integration lock ─────────────────────────────────────────────────────
//
// One exclusive lock per REPO (the common dir is shared by all its worktrees),
// guarding both the claim registry and any repo-wide git mutation session
// (supervisor-merge). Crash semantics, deliberately unfriendly:
//
//   · clean exit / process.exit() → released (try/finally, plus a process-exit
//     hook for callers that exit from inside the locked region);
//   · hard crash (SIGKILL, power loss) → the file REMAINS, and every later
//     acquirer is refused until someone runs `recover --force`. No stale
//     auto-delete anywhere: deleting another process's lock based on a
//     heuristic is exactly the auto-steal this module exists to prevent.

const heldLocks = new Map(); // lock path -> { token, depth }

let exitHookInstalled = false;
function ensureExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const path of heldLocks.keys()) {
      try {
        unlinkSync(path);
      } catch {
        /* best effort — a lost lock file costs nothing, a kept one costs a recover */
      }
    }
  });
}

function safeReadJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** The refusal for "someone else holds the lock". Names the holder, never steals. */
function lockHeldError(path, record) {
  const holder = record
    ? `owner "${record.ownerId}" (pid ${record.pid}, acquired ${record.acquiredAt})`
    : "a holder whose record could not be read";
  return conflict(
    `the integration lock at ${path} is held by ${holder} — only one integration process may run per repo. ` +
      `If the holder crashed, recovery is explicit: node scripts/workspace-claims.mjs recover --git-root <dir> --force`,
    { lockPath: path, holder: record ?? null },
  );
}

function acquireLockFile(commonDir, ownerId) {
  const path = integrationLockPathFor(commonDir);

  // Reentrant for this process instance: a caller already holding the lock
  // (ensureWorktree inside withIntegrationLock, claiming while locked) re-enters
  // by depth instead of deadlocking on its own file.
  const held = heldLocks.get(path);
  if (held) {
    held.depth += 1;
    return { path, token: held.token, depth: held.depth, reentrant: true };
  }

  mkdirSync(claimsDirFor(commonDir), { recursive: true });
  let fd;
  try {
    fd = openSync(path, "wx"); // atomic exclusive create — the whole race decision
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    throw lockHeldError(path, safeReadJson(path));
  }
  try {
    writeSync(fd, JSON.stringify({ ownerId, token: PROCESS_TOKEN, pid: process.pid, acquiredAt: new Date().toISOString() }, null, 2) + "\n", null, "utf8");
  } finally {
    closeSync(fd);
  }
  heldLocks.set(path, { token: PROCESS_TOKEN, depth: 1 });
  ensureExitHook();
  return { path, token: PROCESS_TOKEN, depth: 1, reentrant: false };
}

/** Never throws: a release anomaly must not mask the caller's own error. */
function releaseLockFile(commonDir) {
  const path = integrationLockPathFor(commonDir);
  const held = heldLocks.get(path);
  if (!held) {
    console.error(`[workspace-claims] release refused: this process holds no lock at ${path}`);
    return;
  }
  held.depth -= 1;
  if (held.depth > 0) {
    heldLocks.set(path, held);
    return;
  }
  heldLocks.delete(path);
  // Unlink only when the file on disk is still OURS — explicit recovery may
  // have replaced it while we were in flight; deleting that would delete
  // somebody else's lock.
  const onDisk = safeReadJson(path);
  if (onDisk?.token !== held.token) {
    console.error(`[workspace-claims] lock at ${path} no longer holds this process's token — left in place`);
    return;
  }
  try {
    unlinkSync(path);
  } catch (err) {
    if (err.code !== "ENOENT") console.error(`[workspace-claims] could not unlink ${path}: ${err.message}`);
  }
}

/**
 * Acquire the repo-wide integration lock for `ownerId`. Throws (informative
 * conflict) when another process holds it. Synchronous, reentrant per process.
 */
export function acquireIntegrationLock({ gitRoot, ownerId }) {
  if (typeof ownerId !== "string" || !ownerId.trim()) {
    throw new Error("acquireIntegrationLock: ownerId must be a non-empty string");
  }
  const commonDir = commonGitDir(gitRoot);
  const acq = acquireLockFile(commonDir, ownerId);
  return {
    commonDir,
    path: acq.path,
    token: acq.token,
    reentrant: acq.reentrant,
    release: () => releaseLockFile(commonDir),
  };
}

/**
 * Run `fn` (synchronous — every CLI in this runtime is sync) while holding the
 * repo-wide integration lock. Released in finally, and — because fn may call
 * failJson(), i.e. process.exit(), which skips finally blocks — also by the
 * module's process-exit hook. A return value passes through; a throw releases
 * and rethrows.
 */
export function withIntegrationLock(gitRoot, ownerId, fn) {
  const lock = acquireIntegrationLock({ gitRoot, ownerId });
  try {
    return fn();
  } finally {
    lock.release();
  }
}

// ── the claim itself ─────────────────────────────────────────────────────────

/**
 * Read-only double check: may `ownerId` take `branch` (and stamp `worktree`)?
 * Called BEFORE any git mutation in the managed path; claimWorkspace re-runs
 * the same checks atomically under the lock. Throws an informative conflict.
 */
export function assertClaimAvailable({ gitRoot, branch, ownerId, worktree = null }) {
  const store = readWorkspaceClaims({ gitRoot });
  const existing = store.claims.find((c) => c.branch === branch);
  if (existing && existing.ownerId !== ownerId) {
    throw conflict(
      `branch ${branch} is claimed by owner "${existing.ownerId}" (${existing.worktree}, claimed ${existing.claimedAt}) — ` +
        `owner "${ownerId}" cannot use it. Claims are never stolen or reset: use a unique branch, ` +
        `or have "${existing.ownerId}" (e.g. its supervisor run) release or finish.`,
      { branch, ownerId, claimedBy: existing.ownerId, claimedWorktree: existing.worktree, claimedAt: existing.claimedAt },
    );
  }
  if (worktree) {
    const stamped = store.claims.find((c) => c.branch !== branch && samePath(c.worktree, worktree));
    if (stamped) {
      throw conflict(
        `worktree ${worktree} is already stamped to branch ${stamped.branch} by owner "${stamped.ownerId}" — ` +
          `one checkout cannot serve two claims`,
        { worktree, branch: stamped.branch, ownerId: stamped.ownerId, requestedBy: ownerId },
      );
    }
  }
}

/**
 * Claim a workspace for `ownerId`. Same owner may reuse its own branch, path
 * and history (the claim is re-stamped when the path moved); a different owner
 * on the same branch, or anyone on a stamped path, is refused with an
 * informative conflict — no reset, no delete, no steal.
 *
 * The whole read-check-write runs under the integration lock, so two
 * processes racing on one branch see exactly one winner. Reentrant: safe to
 * call from inside withIntegrationLock (ensureWorktree's managed path).
 *
 * The worktree path is validated to sit inside the canonical worktree root
 * for this repo BEFORE anything is written — a claim must never vouch for a
 * directory outside the workspace the parent expects children in.
 *
 * @returns {{ ok: true, status: "claimed"|"reused", moved: boolean, claim: object }}
 */
export function claimWorkspace({ gitRoot, branch, worktree, ownerId, baseRevision = null }) {
  if (!gitRoot) throw new Error("claimWorkspace: gitRoot is required");
  if (typeof branch !== "string" || !branch.trim()) throw new Error("claimWorkspace: branch must be a non-empty string");
  if (typeof ownerId !== "string" || !ownerId.trim()) throw new Error("claimWorkspace: ownerId must be a non-empty string");
  if (!worktree) throw new Error("claimWorkspace: worktree is required");

  const commonDir = commonGitDir(gitRoot);
  // The root is anchored on the repo's MAIN worktree, so the containment rule
  // is the same no matter which checkout the claim was asked through.
  const root = resolve(worktreeRootFromPaths(mainWorktreeOf(gitRoot, commonDir)));
  const wt = resolve(worktree);
  // Containment BEFORE any write — including before the lock (nothing about a
  // wrong-workspace path deserves a claim attempt).
  if (!containedIn(wt, root)) {
    throw new Error(
      `worktree ${wt} is not contained in the worktree root ${root} for ${gitRoot} — ` +
        `refusing to claim a directory outside the workspace (check LA_WORKTREE_HOME)`,
    );
  }

  return withIntegrationLock(gitRoot, ownerId, () => {
    mkdirSync(claimsDirFor(commonDir), { recursive: true });
    const path = claimsPathFor(commonDir);
    const store = existsSync(path)
      ? readClaimsStore(path, commonDir)
      : { version: CLAIMS_SCHEMA_VERSION, claims: [] };

    // Re-checked under the lock — assertClaimAvailable outside cannot see a
    // concurrent claim; this is the atomic decision point.
    const existing = store.claims.find((c) => c.branch === branch);
    if (existing && existing.ownerId !== ownerId) {
      throw conflict(
        `branch ${branch} is claimed by owner "${existing.ownerId}" (${existing.worktree}, claimed ${existing.claimedAt}) — ` +
          `owner "${ownerId}" cannot use it. Claims are never stolen or reset: use a unique branch, ` +
          `or have "${existing.ownerId}" (e.g. its supervisor run) release or finish.`,
        { branch, ownerId, claimedBy: existing.ownerId, claimedWorktree: existing.worktree, claimedAt: existing.claimedAt },
      );
    }
    const stamped = store.claims.find((c) => c.branch !== branch && samePath(c.worktree, wt));
    if (stamped) {
      throw conflict(
        `worktree ${wt} is already stamped to branch ${stamped.branch} by owner "${stamped.ownerId}" — ` +
          `one checkout cannot serve two claims`,
        { worktree: wt, branch: stamped.branch, ownerId: stamped.ownerId, requestedBy: ownerId },
      );
    }

    const at = new Date().toISOString();
    if (existing) {
      // Same owner: reuse its own branch, path and history. A moved path is a
      // re-stamp of the owner's own claim, never a reset of somebody else's.
      const moved = !samePath(existing.worktree, wt);
      existing.worktree = wt;
      existing.updatedAt = at;
      if (baseRevision) existing.baseRevision = baseRevision;
      existing.history.push({
        at,
        event: moved ? "restamped" : "reused",
        ownerId,
        worktree: wt,
        ...(baseRevision ? { baseRevision } : {}),
      });
      atomicWriteJSON(path, store);
      return { ok: true, status: "reused", moved, claim: existing };
    }

    const claim = {
      branch,
      ownerId,
      worktree: wt,
      ...(baseRevision ? { baseRevision } : {}),
      claimedAt: at,
      updatedAt: at,
      history: [{ at, event: "claimed", ownerId, worktree: wt, ...(baseRevision ? { baseRevision } : {}) }],
    };
    store.claims.push(claim);
    atomicWriteJSON(path, store);
    return { ok: true, status: "claimed", moved: false, claim };
  });
}

// ── CLI ──────────────────────────────────────────────────────────────────────

// A local minimal parser (same flag semantics as supervisor-lib's parseArgs)
// rather than an import: supervisor-lib imports THIS module, so importing it
// back would close a cycle.
function parseCli(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      out._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function failJson(message, extra = {}) {
  console.log(JSON.stringify({ ok: false, error: message, ...extra }, null, 2));
  process.exit(1);
}

function main() {
  const args = parseCli(process.argv.slice(2));
  const command = args._[0];
  const gitRoot = args["git-root"];
  if (command === "claim") {
    if (!gitRoot) failJson("claim: --git-root <dir> is required");
    if (!args.branch) failJson("claim: --branch <name> is required");
    if (!args.worktree) failJson("claim: --worktree <path> is required");
    if (!args.owner) failJson("claim: --owner <id> is required");
    try {
      const result = claimWorkspace({
        gitRoot,
        branch: args.branch,
        worktree: args.worktree,
        ownerId: args.owner,
        baseRevision: args["base-revision"] ?? null,
      });
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      failJson(err.message, { ...(err.conflict ?? {}), code: err.code ?? null });
    }
    return;
  }
  if (command === "read") {
    if (!gitRoot) failJson("read: --git-root <dir> is required");
    try {
      console.log(JSON.stringify(readWorkspaceClaims({ gitRoot }), null, 2));
    } catch (err) {
      failJson(err.message);
    }
    return;
  }
  if (command === "recover") {
    if (!gitRoot) failJson("recover: --git-root <dir> is required");
    if (args.force !== true) {
      failJson(
        "recover refuses to delete a lock without --force — a crashed holder's lock is evidence, and recovery is an explicit human decision (no stale auto-delete)",
        { lock: readIntegrationLock({ gitRoot }) },
      );
    }
    const commonDir = commonGitDir(gitRoot);
    const path = integrationLockPathFor(commonDir);
    if (!existsSync(path)) {
      console.log(JSON.stringify({ ok: true, recovered: false, path }));
      return;
    }
    const formerHolder = safeReadJson(path);
    unlinkSync(path);
    console.log(JSON.stringify({ ok: true, recovered: true, path, formerHolder }));
    return;
  }
  failJson(
    `unknown command: ${JSON.stringify(command ?? "")} — known commands: claim, read, recover`,
    { usage: "node scripts/workspace-claims.mjs claim --git-root <dir> --branch <b> --worktree <w> --owner <id>" },
  );
}

// Dual mode: module import (the tests, supervisor-lib, supervisor-merge) vs the
// CLI entry. pathToFileURL comparison, case-insensitive on win32 (argv[1]
// preserves the drive-letter case as typed; the module URL is the resolved form).
const isMain = Boolean(process.argv[1]) && samePath(pathToFileURL(process.argv[1]).href, import.meta.url);
if (isMain) main();
