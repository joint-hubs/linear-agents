#!/usr/bin/env node
// scripts/supervisor-merge.mjs — two green patches are not one green patch.
//
//   node scripts/supervisor-merge.mjs --run <id> --verify "<command>"
//        [--child <id> ...] [--base <rev>] [--keep] [--json]
//
// WHY (FOC-160). Two candidates can each pass their own tests and fail when
// combined. Verification therefore has to happen TWICE — once per candidate in
// isolation, once on the integration — and nothing did the second one. This is
// the piece that has to exist before the one-live-child guard can be removed
// (FOC-161); without it, parallelism produces more unverified work rather than
// more throughput.
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
// WHAT IT NEVER TOUCHES: a child's worktree. Those are removed only through
// supervisor-cleanup.mjs, behind TEST-pass and a human yes (FOC-167). The only
// tree this script removes is the scratch integration tree it created itself,
// and only on acceptance — a rejected integration is left on disk to be looked
// at, with its path named in the verdict.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

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
import { atomicWriteJSON } from "./utils.mjs";

const REPEATABLE = new Set(["child"]);
const args = parseArgs(process.argv.slice(2), REPEATABLE);

const runId = args.run || process.env.LA_SUPERVISOR_RUN;
if (!runId) failJson("--run <supervisorRunId> is required (or set LA_SUPERVISOR_RUN)");
if (!existsSync(runDir(runId))) failJson(`no such run: ${runId}`, { expected: runDir(runId) });

const verifyCmd = args.verify;
if (!verifyCmd || verifyCmd === true) {
  failJson('--verify "<command>" is required', {
    hint:
      "a merge node that guesses the test command can report green by running nothing. " +
      'Name it explicitly, e.g. --verify "node scripts/test-all.mjs".',
  });
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
const integrationTree = join(mainRepo, "..", "la-wt", integrationBranch.replace(/\//g, "-"));

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

/** Replay one candidate's commits onto the integration tree. */
function replay(child, tree) {
  const range = `${base}..${child.branch}`;
  let commits = [];
  try {
    const out = git(["rev-list", "--reverse", range], mainRepo);
    commits = out ? out.split(/\r?\n/).filter(Boolean) : [];
  } catch (err) {
    return { childId: child.childId, ok: false, conflicts: [], error: err.message.split("\n")[0], commits: 0 };
  }

  if (!commits.length) {
    return { childId: child.childId, ok: true, conflicts: [], commits: 0, note: "nothing to replay — no commits ahead of the base" };
  }

  try {
    git(["cherry-pick", ...commits], tree);
    return { childId: child.childId, ok: true, conflicts: [], commits: commits.length, error: null };
  } catch (err) {
    // The files git could not merge ARE the textual conflict.
    let conflicts = [];
    try {
      const out = git(["diff", "--name-only", "--diff-filter=U"], tree);
      conflicts = out ? out.split(/\r?\n/).filter(Boolean) : [];
    } catch {
      /* the conflict list is best effort; the failure itself is the finding */
    }
    try {
      git(["cherry-pick", "--abort"], tree);
    } catch {
      /* leave it as it is; the tree is kept for inspection anyway */
    }
    return {
      childId: child.childId,
      ok: false,
      conflicts,
      commits: commits.length,
      error: err.message.split("\n")[0],
    };
  }
}

// ── run it ───────────────────────────────────────────────────────────────────

const findings = [];
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
  if (!r.ok) {
    findings.push(
      r.conflicts.length
        ? `${child.childId}: textual conflict on ${r.conflicts.join(", ")}`
        : `${child.childId}: could not be replayed onto the base (${r.error})`,
    );
  }
}

// Step 5 — the combined regression. Only meaningful if everything replayed.
const replayedCleanly = replays.every((r) => r.ok);
let combined = null;
if (replayedCleanly) {
  combined = verify(tree, "combined");
  if (!combined.ok) {
    findings.push(`the combined suite failed (exit ${combined.exitCode}) — each candidate passed alone`);
  }
} else {
  findings.push("the combined suite was not run: the candidates could not be replayed together");
}

// Step 6 — one verdict per candidate.
const accepted = findings.length === 0;

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
  accepted,
  candidates: verdicts,
  isolation,
  allowedPathDrift: drift,
  replays,
  combined,
  findings,
  integration: {
    branch: integrationBranch,
    worktree: integrationRemoved ? null : tree,
    removed: integrationRemoved,
    keptForInspection: !accepted,
  },
  // Stated on every rejection: this script does not retry, and it does not
  // clean up after a child. Both are decisions for the Supervisor and Mateusz.
  next: accepted
    ? "integration verified — the Supervisor may proceed; child worktrees are untouched"
    : "REJECTED. No candidate is accepted. No retry was attempted and no worktree was cleaned; " +
      "report the conflicting pair and the failing check to Mateusz.",
};

atomicWriteJSON(join(runDir(runId), "merge.json"), report);

console.log(JSON.stringify(report, null, 2));
// Exit 1 on rejection so a caller that only checks the status code cannot read
// a rejected integration as a successful run.
process.exit(accepted ? 0 : 1);
