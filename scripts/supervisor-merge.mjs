#!/usr/bin/env node
// scripts/supervisor-merge.mjs — two green patches are not one green patch.
//
//   node scripts/supervisor-merge.mjs --run <id> --verify "<command>"
//        [--child <id> ...] [--base <rev>] [--keep] [--json]
//        [--decision-event <eventId> ...] [--decision-run <runId> ...]
//        [--no-deps-install]
//
// WHY (FOC-160). Two candidates can each pass their own tests and fail when
// combined. Verification therefore has to happen TWICE — once per candidate in
// isolation, once on the integration — and nothing did the second one. This is
// the piece that had to exist before the one-live-child guard could be removed
// (FOC-161, since landed); without it, parallelism produces more unverified work
// rather than more throughput.
//
// THE PIPELINE, and the order it actually runs in:
//
//   1. re-verify each candidate ALONE, in its own worktree
//   2. compare each candidate's touched paths against its recorded
//      allowedPaths[] — declaration versus reality
//   3/4. replay each candidate onto a scratch integration tree cut from the
//      common base. Textual conflicts surface here, as the files git could not
//      merge, which is what a textual conflict operationally IS
//   5. run the SAME verify command on the integration
//   6. one machine-readable verdict per candidate
//
// REJECTION IS THE DEFAULT. Any failure at any step rejects the whole
// integration and marks no candidate accepted. There is deliberately no
// "probably fine" path: absence of a textual conflict is not evidence of
// semantic compatibility, which is the entire reason step 5 exists.
//
// --verify IS REQUIRED, and that is a safety property rather than an
// inconvenience. A merge node that guesses the test command is a merge node
// that can report green by running nothing, and a green from a command that
// does not exist is the worst outcome this script could produce.
//
// DEPENDENCIES IN THE SCRATCH TREE (FOC-523). The integration worktree is cut
// fresh from the base on every run, so it never has node_modules — and a
// verify command that imports a package then fails on module resolution, not
// on the candidates (FOC-513: REJECTED in 108 ms with ERR_MODULE_NOT_FOUND
// while each candidate passed alone). Before the combined verify this script
// therefore installs dependencies in the INTEGRATION TREE ONLY: `npm ci`
// when a lockfile is present, `npm install` when only a package.json is.
// It reports the install in its output and in the report (`depsInstall`),
// and a failed install is a TOOL failure (no verdict), not a rejection —
// a tree nobody could build has no verification verdict to give.
//
//   · Candidates' worktrees are NOT touched. Their trees were provisioned by
//     the children themselves; step 1 already re-verified them as they are.
//   · The install is skipped when node_modules already exists in the tree
//     — a base that ships it vendored or committed — and skipped entirely
//     with --no-deps-install — for a verify command that
//     installs its own dependencies, e.g.
//       --verify "npm ci && node --test scripts/x.test.mjs"
//     so the tool does not pay for the same install twice.
//
// WHAT IT NEVER TOUCHES: a child's worktree. Those are removed only through
// supervisor-cleanup.mjs, behind TEST-pass and a human yes (FOC-167). The only
// tree this script removes is the scratch integration tree it created itself,
// and only on acceptance — a rejected integration is left on disk to be looked
// at, with its path named in the verdict.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LIVE_STATUSES,
  asArray,
  failJson,
  git,
  listWorktrees,
  parseArgs,
  readRegistry,
  resolveGitRoot,
  runDir,
} from "./supervisor-lib.mjs";
import { autoLabel, pairDecisionEvents } from "./decision-log.mjs";
import { integrationTreePath } from "./fenix-paths.mjs";
import { atomicWriteJSON } from "./utils.mjs";
import { acquireIntegrationLock } from "./workspace-claims.mjs";

const REPEATABLE = new Set(["child", "decision-event", "decision-run"]);
const args = parseArgs(process.argv.slice(2), REPEATABLE);

const runId = args.run || process.env.LA_SUPERVISOR_RUN;
if (!runId) failJson("--run <supervisorRunId> is required (or set LA_SUPERVISOR_RUN)");
if (!existsSync(runDir(runId))) failJson(`no such run: ${runId}`, { expected: runDir(runId) });

const verifyCmd = args.verify;
if (!verifyCmd || verifyCmd === true) {
  failJson('--verify "<command>" is required', {
    hint:
      "a merge node that guesses the test command can report green by running nothing. " +
      'Name it explicitly, e.g. --verify "node scripts/test-all.mjs". ' +
      "The command runs in the integration tree, which has no node_modules — " +
      "this script installs dependencies there first (npm ci with a lockfile, " +
      'npm install without), or pass a self-sufficient command such as ' +
      '--verify "npm ci && node --test scripts/x.test.mjs" with --no-deps-install.',
  });
}

// FOC-449: explicit decision provenance — the merge result labels the named
// decision events (accepted → "merged", otherwise "not-merged"), by:"agent",
// via:"merge". No flags → no labels and no provenance key on the report.
let decisionEvents = [];
try {
  decisionEvents = pairDecisionEvents(asArray(args["decision-event"]), asArray(args["decision-run"]));
} catch (err) {
  failJson(err.message);
}

// ── candidates ───────────────────────────────────────────────────────────────

const registry = readRegistry(runId);
const wanted = asArray(args.child);

const candidates = Object.values(registry.children ?? {}).filter((c) => {
  if (wanted.length) return wanted.includes(c.childId);
  return c.branch && c.worktree && !LIVE_STATUSES.includes(c.status);
});

if (candidates.length < 1) {
  failJson(`no finished candidates in run ${runId}`, {
    known: Object.values(registry.children ?? {}).map((c) => ({ childId: c.childId, status: c.status })),
    hint: "a candidate needs a branch, a worktree and an ended turn",
  });
}

const live = candidates.filter((c) => LIVE_STATUSES.includes(c.status));
if (live.length) {
  failJson(`${live.map((c) => c.childId).join(", ")} still has a turn in flight — a moving tree cannot be integrated`, {
    hint: "wait for it, or stop it: node scripts/supervisor-stop.mjs --child <id>",
  });
}

const gitRoot = (() => {
  try {
    return resolveGitRoot(args.repo || candidates[0].worktree);
  } catch (err) {
    failJson(`cannot resolve a git repository: ${err.message.split("\n")[0]}`);
  }
})();
// The first entry of `git worktree list` is always the MAIN worktree; the child
// trees resolve to themselves, and integrating from inside one of them would
// operate on a checkout somebody's work is sitting in.
const mainRepo = resolve(listWorktrees(gitRoot)[0]?.path ?? gitRoot);

// ── dependencies in the integration tree (FOC-523) ──────────────────────────

/**
 * Install dependencies in the scratch integration tree before the combined
 * verify runs there. The tree is cut fresh from the base on every run, so it
 * never has node_modules — a verify command that imports a package then fails
 * on module resolution, which reads like a combined-merge failure but is not
 * one (FOC-513).
 *
 * The tree is recreated on every run (makeIntegrationTree removes any previous
 * tree before `worktree add -B`), so nothing pre-installed survives. Skipped
 * when node_modules already exists — a base that ships it vendored or
 * committed — and with --no-deps-install, for a verify command that installs
 * its own dependencies.
 *
 * Returns a depsInstall record for the report. A failed install is a TOOL
 * failure, not a verification result: the combined suite is not run and no
 * candidate is rejected on it.
 */
function installIntegrationDeps(tree) {
  if (args["no-deps-install"]) {
    return { skipped: true, reason: "no-deps-install" };
  }
  if (existsSync(join(tree, "node_modules"))) {
    return { skipped: true, reason: "node_modules already present" };
  }
  const hasLockfile = existsSync(join(tree, "package-lock.json"));
  const hasPackage = existsSync(join(tree, "package.json"));
  if (!hasPackage) {
    return { skipped: true, reason: "no package.json in the integration tree" };
  }
  const installCmd = hasLockfile ? "npm ci" : "npm install";
  console.error(
    `[merge] ${installCmd} --no-audit --no-fund (installing dependencies in the integration tree)`,
  );
  // Without a lockfile npm resolves the ranges live, so the verdict can differ
  // run to run; say so rather than let it pass silently.
  if (!hasLockfile) {
    console.error(
      "[merge] npm install without a lockfile — the verify result depends on the current registry state",
    );
  }
  const res = spawnSync(installCmd, ["--no-audit", "--no-fund"], {
    cwd: tree,
    encoding: "utf8",
    shell: true,
    timeout: Number(args["timeout-ms"] ?? 900_000),
    maxBuffer: 64 * 1024 * 1024,
  });
  const tail = `${res.stdout ?? ""}${res.stderr ?? ""}`.split("\n").filter(Boolean).slice(-20);
  return {
    skipped: false,
    ok: res.status === 0,
    command: installCmd,
    exitCode: res.status,
    error: res.error ? res.error.message.split("\n")[0] : null,
    timedOut: Boolean(res.error && /ETIMEDOUT|timed out/i.test(res.error.message)),
    ...(hasLockfile
      ? {}
      : {
          note: "npm install without a lockfile — the verify result depends on the current registry state",
        }),
    tail,
  };
}

// ── the verify command ───────────────────────────────────────────────────────

/** Run the verify command in a directory. Non-zero is a failure, always. */
function verify(cwd, label) {
  const res = spawnSync(verifyCmd, {
    cwd,
    encoding: "utf8",
    shell: true,
    timeout: Number(args["timeout-ms"] ?? 900_000),
    maxBuffer: 64 * 1024 * 1024,
  });
  const tail = `${res.stdout ?? ""}${res.stderr ?? ""}`.split("\n").filter(Boolean).slice(-20);
  return {
    label,
    cwd,
    command: verifyCmd,
    // A command that could not be started is NOT a pass. spawnSync reports that
    // as status null, and treating null as 0 would turn "the runner is missing"
    // into "everything is fine".
    ok: res.status === 0,
    exitCode: res.status,
    timedOut: Boolean(res.error && /ETIMEDOUT|timed out/i.test(res.error.message)),
    error: res.error ? res.error.message.split("\n")[0] : null,
    tail,
  };
}

// ── step 2: declaration versus reality ───────────────────────────────────────

const withinAllowed = (path, allowed) =>
  allowed.some((a) => {
    const decl = a.replace(/\\/g, "/").replace(/\/+$/, "");
    const p = path.replace(/\\/g, "/");
    return p === decl || p.startsWith(`${decl}/`);
  });

function pathDrift(child, base) {
  const allowed = asArray(child.allowedPaths);
  let touched = [];
  try {
    const out = git(["diff", "--name-only", base], child.worktree);
    touched = out ? out.split(/\r?\n/).filter(Boolean) : [];
  } catch (err) {
    return { declared: allowed, touched: null, outside: null, error: err.message.split("\n")[0] };
  }
  // An empty declaration means UNDECLARED, not "everything is forbidden" —
  // supervisor-spawn.mjs says so where it records the field. Reporting every
  // path as a violation there would bury the real ones.
  const outside = allowed.length ? touched.filter((p) => !withinAllowed(p, allowed)) : [];
  return {
    declared: allowed,
    touched,
    outside,
    undeclared: allowed.length === 0,
    error: null,
  };
}

// ── steps 3/4: replay onto a scratch integration tree ────────────────────────

const base = args.base && args.base !== true ? args.base : commonBase();

function commonBase() {
  // Every candidate recorded the revision its worktree was cut from. When they
  // agree, that IS the common base. When they do not, use the merge-base of the
  // branches rather than picking one child's answer.
  const bases = [...new Set(candidates.map((c) => c.baseRevision).filter(Boolean))];
  if (bases.length === 1) return bases[0];
  try {
    return git(["merge-base", ...candidates.map((c) => c.branch)], mainRepo);
  } catch (err) {
    failJson(`candidates disagree on their base revision and no merge-base could be found: ${err.message.split("\n")[0]}`, {
      bases,
      hint: "pass --base <rev> to state it",
    });
  }
}

const integrationBranch = `la-merge/${runId}`;
const integrationTree = integrationTreePath(mainRepo, integrationBranch.replace(/\//g, "-"));

function makeIntegrationTree() {
  // A leftover from an earlier run would silently integrate onto the wrong
  // starting point, so it is removed first — and it is safe to remove because
  // this script is the only thing that creates it. Guarded below anyway.
  removeIntegrationTree({ force: true });
  try {
    git(["worktree", "add", "-B", integrationBranch, integrationTree, base], mainRepo);
  } catch (err) {
    failJson(`could not create the integration worktree: ${err.message.split("\n")[0]}`, {
      path: integrationTree,
      base,
    });
  }
  // Normalize the checkout — worktree add -B can leave a dirty index
  // when the base branch has been force-updated. A clean tree means
  // the merge never refuses for stale-index reasons.
  try {
    git(["checkout", "--", "."], resolve(integrationTree));
  } catch {
    /* best effort — if checkout fails the tree is still usable */
  }
  return resolve(integrationTree);
}

function removeIntegrationTree({ force = false } = {}) {
  const target = resolve(integrationTree);
  // Never remove a tree that belongs to a child. Those go through
  // supervisor-cleanup.mjs behind two keys (FOC-167); this script has no
  // business deleting one even by accident.
  const isChildTree = Object.values(registry.children ?? {}).some(
    (c) => c.worktree && resolve(c.worktree).toLowerCase() === target.toLowerCase(),
  );
  if (isChildTree) return false;
  if (!existsSync(target)) return false;
  try {
    git(["worktree", "remove", target, "--force"], mainRepo);
    return true;
  } catch {
    if (force) {
      try {
        rmSync(target, { recursive: true, force: true });
        git(["worktree", "prune"], mainRepo);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

// ── the generated task-journal index (FOC-904) ───────────────────────────────
//
// Journals are per task (docs/state/<TASK-ID>.md), so two sessions never edit
// the same journal file. The ONE thing they can still collide on is the
// generated index block in docs/STATE.md — machine-owned, fully derived from
// docs/state/, and therefore re-derivable instead of conflict-worthy:
//
//   · after every successful replay the block is regenerated in the scratch
//     tree and committed when it changed;
//   · when a replay fails and the ONLY conflicted file is docs/STATE.md and
//     every conflict hunk lies INSIDE the index markers, the conflict is ours
//     by construction: take ours, regenerate, complete the merge;
//   · any hunk outside the markers is a real textual conflict and keeps
//     today's behaviour — abort, report, reject.

const STATE_FILE = "docs/STATE.md";
const INDEX_START = "<!-- state-index:start -->";
const INDEX_END = "<!-- state-index:end -->";
const STATE_INDEX_SCRIPT = fileURLToPath(new URL("./state-index.mjs", import.meta.url));

/**
 * Regenerate the index block in `tree`. The script is run from THIS checkout
 * (its own directory), pointed at the scratch tree through LA_ROOT — the tree
 * itself never needs the tool present.
 */
function regenerateStateIndex(tree) {
  const res = spawnSync(process.execPath, [STATE_INDEX_SCRIPT, "--write"], {
    cwd: tree,
    encoding: "utf8",
    env: { ...process.env, LA_ROOT: tree },
  });
  if (res.status === 0) return { ok: true, error: null };
  const detail = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim().split("\n")[0] || `exit ${res.status}`;
  return { ok: false, error: detail };
}

/**
 * Regenerate + commit the block when it changed. A tree with neither journal
 * files nor an existing block is skipped untouched — a repo that never opted
 * into journals must not gain a generated section as a side effect of a merge.
 */
function commitRegeneratedIndex(tree) {
  const journalsDir = join(tree, "docs", "state");
  const hasJournals = existsSync(journalsDir) && readdirSync(journalsDir).some((f) => f.endsWith(".md"));
  const statePath = join(tree, STATE_FILE);
  const hasBlock =
    existsSync(statePath) && readFileSync(statePath, "utf8").includes(INDEX_START);
  if (!hasJournals && !hasBlock) return { committed: false, error: null, skipped: true };

  const regen = regenerateStateIndex(tree);
  if (!regen.ok) return { committed: false, error: regen.error };
  const dirty = git(["status", "--porcelain", "--", STATE_FILE], tree);
  if (!dirty) return { committed: false, error: null };
  git(["add", "--", STATE_FILE], tree);
  git(["commit", "-m", "docs(state): regenerate task journal index", "--", STATE_FILE], tree);
  return { committed: true, error: null };
}

/**
 * True when every conflict marker in the conflicted docs/STATE.md lies inside
 * the index markers — i.e. the merge collision is purely the generated block.
 */
function conflictsInsideIndexBlock(tree) {
  let text;
  try {
    text = readFileSync(join(tree, STATE_FILE), "utf8");
  } catch {
    return false;
  }
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.includes(INDEX_START));
  const end = lines.findIndex((l) => l.includes(INDEX_END));
  if (start === -1 || end === -1 || end <= start) return false;
  return lines.every((l, i) => !/^(<{7}|>{7})( |$)/.test(l) || (i > start && i < end));
}

/**
 * Replay one candidate onto the integration tree by MERGING its branch.
 *
 * FOC-726: every landing goes branch→PR→merge, so a candidate's history
 * contains merge commits — and `git cherry-pick` refuses those outright ("is a
 * merge but no -m option was given"), which used to surface as a verification
 * REJECT over a tree that was never built. Merging the branch makes the
 * candidate's own merge commits ordinary ancestors that `git merge` handles.
 */
function replay(child, tree) {
  const range = `${base}..${child.branch}`;
  let commits = 0;
  try {
    commits = Number(git(["rev-list", "--count", range], mainRepo)) || 0;
  } catch (err) {
    return { childId: child.childId, ok: false, conflicts: [], error: (err.stderr || err.message).trim().split("\n")[0], commits: 0 };
  }

  // Already an ancestor of the integration HEAD — no work of its own, or
  // another candidate's merge carried it in — so there is nothing to replay.
  try {
    git(["merge-base", "--is-ancestor", child.branch, "HEAD"], tree);
    return { childId: child.childId, ok: true, conflicts: [], commits, note: "nothing to replay — already contained in the integration tree" };
  } catch {
    /* not an ancestor — merge it below */
  }

  try {
    git(["merge", "--no-ff", "--no-edit", child.branch], tree);
    const index = commitRegeneratedIndex(tree);
    return { childId: child.childId, ok: true, conflicts: [], commits, error: null, index };
  } catch (err) {
    // The files git could not merge ARE the textual conflict. Any other refusal
    // — unrelated histories, an unreadable rev, git failing outright — is this
    // TOOL failing, not the candidates contradicting each other, and must never
    // be reported as a verification result.
    let conflicts = [];
    try {
      const out = git(["diff", "--name-only", "--diff-filter=U"], tree);
      conflicts = out ? out.split(/\r?\n/).filter(Boolean) : [];
    } catch {
      /* the conflict list is best effort; the failure itself is the finding */
    }
    // FOC-904: a collision confined to the generated index block is not a
    // candidate contradiction — the block is derived state. Regenerate it over
    // ours and complete the merge; anything broader stays a hard conflict.
    if (conflicts.length === 1 && conflicts[0] === STATE_FILE && conflictsInsideIndexBlock(tree)) {
      try {
        git(["checkout", "--ours", "--", STATE_FILE], tree);
        const regen = regenerateStateIndex(tree);
        if (!regen.ok) throw new Error(`state-index --write failed: ${regen.error}`);
        git(["add", "--", STATE_FILE], tree);
        git(["commit", "--no-edit"], tree);
        return {
          childId: child.childId,
          ok: true,
          conflicts: [],
          commits,
          error: null,
          note: "docs/STATE.md conflict was inside the generated index block — resolved by regenerating it",
        };
      } catch (resolveErr) {
        /* resolution failed — fall through to the abort + report below */
        err.message = `${err.message}; index-block resolution also failed: ${resolveErr.message}`;
      }
    }
    try {
      git(["merge", "--abort"], tree);
    } catch {
      /* nothing in progress, or the abort failed; the tree is kept for inspection anyway */
    }
    return {
      childId: child.childId,
      ok: false,
      conflicts,
      commits,
      error: (err.stderr || err.message).trim().split("\n")[0],
    };
  }
}

// ── P1 resource ownership: one merge process per repo ────────────────────────
//
// Everything below is a repo-wide git mutation session (`git worktree add -B`
// on the shared common dir, merges replayed onto it), so the whole workflow
// runs under the repo's integration lock: acquired BEFORE the first mutation
// and released in finally. Two `supervisor-merge` processes would fight over
// the same `la-merge/<runId>` branch and integration tree — the second is
// refused here, before touching git. A refusal inside the locked region
// reaches failJson(), i.e. process.exit(), which skips finally blocks — the
// release then happens through workspace-claims' process-exit hook. A hard
// crash leaves the lock on disk for EXPLICIT recovery
// (node scripts/workspace-claims.mjs recover --git-root <dir> --force);
// there is no stale auto-delete.
let integrationLock = null;
try {
  integrationLock = acquireIntegrationLock({ gitRoot, ownerId: `merge:${runId}` });
} catch (err) {
  failJson(`refusing to run the merge before any git mutation: ${err.message}`, err.conflict ?? {});
}

try {

// ── run it ───────────────────────────────────────────────────────────────────

const findings = [];
// Observations that are NOT verification results: they must not move the
// verdict. The index regen failing on an otherwise-successful replay leaves
// the integration exactly as the real checks judged it — the stale block is
// recorded here for the human, not counted against the candidates.
const notes = [];
const isolation = [];
const drift = [];

// Step 1 — each candidate alone.
for (const child of candidates) {
  if (!existsSync(child.worktree)) {
    isolation.push({ childId: child.childId, ok: false, error: `worktree is gone: ${child.worktree}` });
    findings.push(`${child.childId}: its worktree no longer exists, so it cannot be verified in isolation`);
    continue;
  }
  const r = verify(child.worktree, child.childId);
  isolation.push({ childId: child.childId, ...r });
  if (!r.ok) findings.push(`${child.childId}: failed its own verify (exit ${r.exitCode})`);
}

// Step 2 — declaration versus reality.
for (const child of candidates) {
  const d = pathDrift(child, base);
  drift.push({ childId: child.childId, ...d });
  if (d.error) findings.push(`${child.childId}: could not read its diff (${d.error})`);
  else if (d.outside.length) {
    // A first-class finding, not a warning. allowedPaths is not enforced at
    // runtime (spawn says so), so this is the only place the declaration is ever
    // checked against what actually happened.
    findings.push(
      `${child.childId}: wrote ${d.outside.length} path(s) outside its declared allowedPaths — ${d.outside.slice(0, 5).join(", ")}`,
    );
  }
}

// Steps 3/4 — replay onto the integration tree.
const tree = makeIntegrationTree();
const replays = [];
for (const child of candidates) {
  const r = replay(child, tree);
  replays.push(r);
  if (r.index?.error) {
    // A failed index regen after a SUCCESSFUL replay is bookkeeping, not a
    // verification failure — `accepted` stays as the real checks computed it.
    notes.push(`${child.childId}: the task journal index was not regenerated after the replay (${r.index.error})`);
  }
  if (!r.ok) {
    findings.push(
      r.conflicts.length
        ? `${child.childId}: textual conflict on ${r.conflicts.join(", ")}`
        : `${child.childId}: could not be replayed onto the base (${r.error})`,
    );
  }
}

// Step 5 — the combined regression. Only meaningful if everything replayed.
// FOC-726: a replay failure with unmerged files left behind is the candidates'
// genuine textual conflict — a verification result, rejected as before. A
// replay failure WITHOUT them is git refusing to build the tree at all, and a
// tree that was never assembled has no verification verdict to report.
const conflicted = replays.some((r) => !r.ok && r.conflicts.length > 0);
const toolFailure = replays.some((r) => !r.ok && r.conflicts.length === 0);
let combined = null;
let depsInstall = null;
if (!conflicted && !toolFailure) {
  // FOC-523: the tree was just cut from the base, so it has no node_modules.
  // Install dependencies in the integration tree BEFORE the combined verify,
  // or a verify command that imports a package fails on module resolution
  // and reads as a combined-merge failure that never was one.
  depsInstall = installIntegrationDeps(tree);
  if (!depsInstall.skipped && !depsInstall.ok) {
    // A failed install is a TOOL failure, not a rejection: the tree was never
    // buildable, so the combined suite says nothing about the candidates.
    // Same classification as a tree git could not assemble (above).
    // Phrase the failure the way the verify path phrases spawn errors: an
    // error on the record means the process never started, timedOut means the
    // timeout budget ran out, anything else is a non-zero exit.
    const detail = depsInstall.error
      ? `could not be started: ${depsInstall.error}`
      : depsInstall.timedOut
        ? `timed out after ${Number(args["timeout-ms"] ?? 900_000)} ms`
        : `exited ${depsInstall.exitCode}`;
    findings.push(
      `the combined suite was not run: dependencies could not be installed in the integration tree ` +
        `(${depsInstall.command} ${detail})`,
    );
  } else {
    combined = verify(tree, "combined");
    if (!combined.ok) {
      findings.push(`the combined suite failed (exit ${combined.exitCode}) — each candidate passed alone`);
    }
  }
} else if (conflicted) {
  findings.push("the combined suite was not run: the candidates could not be replayed together");
} else {
  findings.push("the combined suite was not run: the integration tree could not be assembled");
}

// Step 6 — one verdict per candidate. `accepted: null` on a tool failure is the
// point of the classification: no tree was tested, so no candidate can be
// reported as having failed verification — but none passes either. FOC-523:
// a dependency install that failed is the same class of tool failure — the
// combined suite never ran, so nothing was verified and nobody is rejected.
const depsFailed = depsInstall !== null && !depsInstall.skipped && !depsInstall.ok;
const accepted = depsFailed
  ? null
  : conflicted || !toolFailure
    ? findings.length === 0
    : null;
const status = accepted === null ? "tool_error" : accepted ? "accepted" : "rejected";

const verdicts = candidates.map((c) => ({
  childId: c.childId,
  branch: c.branch,
  taskId: c.taskId ?? null,
  worktree: c.worktree,
  isolation: isolation.find((i) => i.childId === c.childId)?.ok ?? null,
  replayed: replays.find((r) => r.childId === c.childId)?.ok ?? null,
  pathsOutsideDeclaration: drift.find((d) => d.childId === c.childId)?.outside ?? null,
  // No candidate is accepted unless the INTEGRATION is. A candidate green in
  // isolation is never sufficient — that is the whole premise.
  accepted,
}));

// A rejected integration is left on disk to be looked at. Removing it would
// throw away the one artefact that shows what the combination actually did.
let integrationRemoved = false;
if (accepted && !args.keep) integrationRemoved = removeIntegrationTree();

const report = {
  ok: true,
  runId,
  base,
  verifyCommand: verifyCmd,
  // FOC-726: always present, always one of the three. "tool_error" means the
  // tree was never assembled and nothing was tested — it is not a verdict.
  status,
  accepted,
  candidates: verdicts,
  isolation,
  allowedPathDrift: drift,
  replays,
  combined,
  // FOC-523: the dependency install this tool ran (or skipped) in the
  // integration tree before the combined verify. null on a tool error
  // before step 5 — the tree was never assembled.
  depsInstall,
  findings,
  // Non-verdict observations (FOC-904): a failed index regen on an otherwise
  // accepted integration is reported here, not as a finding.
  notes,
  // FOC-449: the provenance this merge labelled — absent when none was given.
  ...(decisionEvents.length ? { decisionEvents } : {}),
  integration: {
    branch: integrationBranch,
    worktree: integrationRemoved ? null : tree,
    removed: integrationRemoved,
    keptForInspection: !accepted,
  },
  // Stated on every rejection: this script does not retry, and it does not
  // clean up after a child. Both are decisions for the Supervisor and Mateusz.
  next:
    accepted === null
      ? depsFailed
        ? "TOOL ERROR, not a verification result: dependencies could not be installed in the " +
          "integration tree, so the combined suite never ran. No candidate is rejected. No retry " +
          "was attempted; the tree is kept for inspection — report the failure to Mateusz. " +
          "If the verify command installs its own dependencies, pass --no-deps-install."
        : "TOOL ERROR, not a verification result: the integration tree could not be assembled, " +
          "so the combined suite never ran. No candidate is rejected. No retry was attempted; " +
          "the tree is kept for inspection — report the failure to Mateusz."
      : accepted
        ? "integration verified — the Supervisor may proceed; child worktrees are untouched"
        : "REJECTED. No candidate is accepted. No retry was attempted and no worktree was cleaned; " +
          "report the conflicting pair and the failing check to Mateusz.",
};

atomicWriteJSON(join(runDir(runId), "merge.json"), report);

// FOC-449 auto-join: the merge result IS the outcome for the decision events
// the caller named — accepted → "merged", otherwise "not-merged"; by:"agent",
// via:"merge". Best-effort: a failed label is a stderr warning and never
// changes the verdict or the exit code.
const labelWarnings = autoLabel(decisionEvents, {
  outcome: accepted ? "merged" : "not-merged",
  by: "agent",
  via: "merge",
}).warnings;
for (const w of labelWarnings) console.error(`[merge] ${w}`);

console.log(JSON.stringify(report, null, 2));
// Exit 1 on rejection so a caller that only checks the status code cannot read
// a rejected integration as a successful run. Exit 2 on a tool error for the
// same reason in the other direction: an untested tree is not a verdict either.
process.exit(accepted === null ? 2 : accepted ? 0 : 1);

} finally {
  integrationLock.release();
}
