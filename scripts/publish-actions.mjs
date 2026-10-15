// scripts/publish-actions.mjs — FOC-788 core (plan §4.1, slice S1): the pure
// publish-preview engine behind the dashboard's Push branch / Open PR actions.
//
// Discover the checkout a push/PR would act on, derive its diff summary and the
// local checks state, bind and verify the confirm token. Read-only git in
// worktrees the ticket facts already name; no network, no push, no PR — those
// are S2's executors behind seams.
//
// Fail-closed by construction: a checkout is DISCOVERED from facts (the child's
// recorded worktree + branch, verified against the live HEAD), never invented.
// No qualifying child → { error: "no-checkout", reason } and no action offered.
//
// Branch note (recon 2026-10-15, plan §4.1): every spawn owns its own branch
// (`foc-N-<slug>-<attemptHash>`, supervisor-spawn.mjs) — children do NOT share
// one task branch. A review/test pin can therefore sit at base with no commits
// while the dev child's branch carries the work. Among qualifying children the
// pick prefers a work-carrying branch (the dev child's name on a head-sha tie),
// and falls back to the latest qualifying child — the preview then honestly
// shows commits: 0. What the human sees is what the confirm token binds.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { stripCredentials } from "./fenix-repos.mjs";

export const PUBLISH_ACTIONS = ["push", "pr"];

/** The PR base (Mateusz, 2026-10-15, decision 1) and the push refspec's target. */
export const DEFAULT_BASE = "main";

/** The remote the push goes to (decision 1): `git push origin <branch>:<branch>`. */
export const PUBLISH_REMOTE = "origin";

// How many commit subjects the preview carries. The true count is always
// reported; this only caps the display list.
const SUBJECT_CAP = 20;

/** git seam: trimmed stdout, throws on non-zero exit. Injected in tests. The
 *  optional `env` merges over process.env (the push executor passes
 *  GIT_TERMINAL_PROMPT=0 — a service must fail, never hang on a credential
 *  prompt). */
export function defaultRunGit(args, cwd, env) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
}

const norm = (out) => String(out ?? "").replace(/\r\n/g, "\n").trimEnd();

/** Probe form of the git seam — a missing ref or detached HEAD is data, not a crash. */
function tryGit(runGit, args, cwd) {
  try {
    return { ok: true, out: norm(runGit(args, cwd)) };
  } catch {
    return { ok: false, out: "" };
  }
}

const startedMs = (child) => {
  const t = child?.startedAt ? Date.parse(child.startedAt) : NaN;
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
};

// ── 1. discoverCheckout ──────────────────────────────────────────────────────

/**
 * The checkout a publish action would act on, discovered from the ticket's
 * facts. Qualifying = the child's recorded worktree exists and its live HEAD is
 * on that child's recorded branch. Among qualifiers, a branch carrying commits
 * beyond the base wins (dev's name when several share one head sha — the task
 * branch the work was authored on); with nothing to publish, the latest
 * qualifier stands and the preview shows commits: 0.
 *
 * @returns {{ok: true, checkout: object} | {ok: false, error: "no-checkout", reason: string}}
 */
export function discoverCheckout(facts, { exists = existsSync, runGit = defaultRunGit } = {}) {
  const children = Array.isArray(facts?.children) ? facts.children : [];
  if (!children.length) return { ok: false, error: "no-checkout", reason: "no-children" };

  // Newest first — the board's latestChild ordering — so the fallback pick and
  // the head-sha divergence pick are both "the most recent state of the work".
  const ordered = [...children].sort((a, b) => startedMs(b) - startedMs(a));

  let missReason = "no-children";
  const qualifying = [];
  for (const child of ordered) {
    const worktree = typeof child?.worktree === "string" && child.worktree ? child.worktree : null;
    const branch = typeof child?.branch === "string" && child.branch ? child.branch : null;
    if (!worktree || !branch) {
      missReason = "branch-or-worktree-unrecorded";
      continue;
    }
    if (!exists(worktree)) {
      missReason = "worktree-missing";
      continue;
    }
    const live = tryGit(runGit, ["symbolic-ref", "--short", "HEAD"], worktree);
    if (!live.ok || live.out !== branch) {
      missReason = "head-mismatch";
      continue;
    }
    const head = tryGit(runGit, ["rev-parse", "HEAD"], worktree);
    if (!head.ok || !head.out) {
      missReason = "head-unreadable";
      continue;
    }

    // The main clone's path: the worktree's common git dir is the clone's
    // .git (dirname is the clone) — or the repo itself when bare.
    const common = tryGit(runGit, ["rev-parse", "--git-common-dir"], worktree);
    const commonAbs = common.ok && common.out ? resolve(worktree, common.out) : null;
    const repoPath = commonAbs ? (basename(commonAbs) === ".git" ? dirname(commonAbs) : commonAbs) : null;

    const baseRef = resolveBaseRef(runGit, worktree, DEFAULT_BASE, child.baseRevision);
    const ahead = baseRef
      ? Number(norm(tryGit(runGit, ["rev-list", "--count", `${baseRef.sha}..${head.out}`], worktree).out)) || 0
      : 0;

    const remoteUrl = tryGit(runGit, ["remote", "get-url", PUBLISH_REMOTE], worktree);
    qualifying.push({
      childId: child.childId ?? null,
      squad: child.squad ?? null,
      branch,
      worktree,
      repoPath,
      remote: PUBLISH_REMOTE,
      remoteUrl: remoteUrl.ok && remoteUrl.out ? stripCredentials(remoteUrl.out) : null,
      base: DEFAULT_BASE,
      baseSha: baseRef?.sha ?? null,
      baseRevision: typeof child.baseRevision === "string" && child.baseRevision ? child.baseRevision : null,
      head: head.out,
      commitsAhead: ahead,
    });
  }

  if (!qualifying.length) {
    return { ok: false, error: "no-checkout", reason: missReason };
  }

  const carrying = qualifying.filter((q) => q.commitsAhead > 0);
  let pick;
  if (!carrying.length) {
    pick = qualifying[0]; // nothing to publish anywhere — still show it (commits: 0)
  } else if (new Set(carrying.map((q) => q.head)).size === 1) {
    // One head sha under several branch names (a review/test pin at the dev
    // candidate): push the branch the work was authored on.
    pick = carrying.find((q) => q.squad === "dev") ?? carrying[0];
  } else {
    pick = carrying[0]; // diverged carriers — the most recent state of the work
  }

  return {
    ok: true,
    checkout: {
      childId: pick.childId,
      squad: pick.squad,
      branch: pick.branch,
      worktree: pick.worktree,
      repoPath: pick.repoPath,
      remote: pick.remote,
      remoteUrl: pick.remoteUrl,
      base: pick.base,
      baseSha: pick.baseSha,
      baseRevision: pick.baseRevision,
      head: pick.head,
    },
  };
}

/**
 * The commit the diff is computed against: origin/<base>, else <base>, else the
 * child's recorded start revision. The PR target stays `main` (decision 1) —
 * this is only the comparison point.
 */
function resolveBaseRef(runGit, worktree, base, fallbackRevision) {
  for (const ref of [`refs/remotes/origin/${base}`, `refs/heads/${base}`, base]) {
    const r = tryGit(runGit, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], worktree);
    if (r.ok && r.out) return { ref, sha: r.out };
  }
  if (typeof fallbackRevision === "string" && fallbackRevision) {
    const r = tryGit(runGit, ["rev-parse", "--verify", "--quiet", `${fallbackRevision}^{commit}`], worktree);
    if (r.ok && r.out) return { ref: fallbackRevision, sha: r.out, fallback: true };
  }
  return null;
}

// ── 2. diffSummary ───────────────────────────────────────────────────────────

/**
 * What the human is confirming: commits on the branch beyond the base, the
 * file/line shape of that diff, and whether the worktree holds uncommitted
 * changes (which the push will NOT carry).
 */
export function diffSummary(checkout, { runGit = defaultRunGit } = {}) {
  const { worktree, head } = checkout;
  const baseSha = checkout.baseSha ?? null;
  const empty = { commits: 0, files: 0, insertions: 0, deletions: 0, commitSubjects: [], dirty: false };
  if (!worktree || !head || !baseSha) {
    return { ...empty, dirty: worktree ? tryGit(runGit, ["status", "--porcelain"], worktree).out !== "" : false };
  }

  const log = tryGit(runGit, ["log", "--format=%s", `${baseSha}..${head}`], worktree);
  const subjects = log.ok && log.out ? log.out.split("\n").filter((s) => s !== "") : [];

  // --numstat: "<added>\t<deleted>\t<path>" per file; binary files say "-\t-".
  const numstat = tryGit(runGit, ["diff", "--numstat", `${baseSha}...${head}`], worktree);
  let files = 0;
  let insertions = 0;
  let deletions = 0;
  if (numstat.ok && numstat.out) {
    for (const line of numstat.out.split("\n")) {
      if (!line) continue;
      files += 1;
      const [added, removed] = line.split("\t");
      if (/^\d+$/.test(added)) insertions += Number(added);
      if (/^\d+$/.test(removed)) deletions += Number(removed);
    }
  }

  const dirty = tryGit(runGit, ["status", "--porcelain"], worktree).out !== "";
  return {
    commits: subjects.length,
    files,
    insertions,
    deletions,
    commitSubjects: subjects.slice(0, SUBJECT_CAP),
    dirty,
  };
}

// ── 3. deriveChecks ──────────────────────────────────────────────────────────

/**
 * The local verification result (decision 2) — never GitHub checks: this repo
 * has no CI, so a GitHub check status would always be empty. `latest` is the
 * highest round's verdict; `failing` are the FAIL rounds AC-2 wants shown
 * before the confirm; a crashed child surfaces through `children`.
 */
export function deriveChecks(facts) {
  const verdicts = [...(Array.isArray(facts?.verdicts) ? facts.verdicts : [])].sort(
    (a, b) => (a?.round ?? 0) - (b?.round ?? 0),
  );
  const failing = verdicts.filter((v) => v?.verdict === "FAIL");
  const latest = verdicts.length ? verdicts[verdicts.length - 1].verdict : null;
  const children = (Array.isArray(facts?.children) ? facts.children : []).map((c) => ({
    childId: c?.childId ?? null,
    status: c?.status ?? null,
  }));
  return { latest, failing, verdicts, children };
}

// ── 4. confirm token ─────────────────────────────────────────────────────────

/**
 * sha256 over the exact state the human saw. The confirm is only good for this
 * action, on this ticket, for this branch at this head against this base — a
 * moved head between preview and click answers stale-preview, never an action.
 */
export function confirmToken({ action, ticket, branch, head, base }) {
  return createHash("sha256")
    .update([action, ticket, branch, head, base].join("\n"), "utf8")
    .digest("hex");
}

/**
 * Re-check the body's token against the CURRENT checkout state.
 * Missing → the body-shape error (the `start` route's "text is required" twin);
 * mismatch → stale-preview: the preview's state is gone, preview again.
 */
export function verifyConfirmToken({ action, ticket, checkout, token }) {
  if (typeof token !== "string" || !token) {
    return { ok: false, error: "confirmToken (string) is required" };
  }
  const want = confirmToken({
    action,
    ticket,
    branch: checkout.branch,
    head: checkout.head,
    base: checkout.base,
  });
  if (token !== want) {
    return {
      ok: false,
      error: "stale-preview",
      reason: "the confirm does not match the current checkout state — preview again",
    };
  }
  return { ok: true };
}

// ── 5. buildPublishPreview ───────────────────────────────────────────────────

/** The GET .../publish-preview payload: checkout + diff + checks + confirmToken. */
export function buildPublishPreview({ ticket, action, facts, runGit = defaultRunGit, exists = existsSync }) {
  if (!PUBLISH_ACTIONS.includes(action)) {
    return { ok: false, error: "bad-action", reason: `action must be one of: ${PUBLISH_ACTIONS.join(", ")}` };
  }
  if (typeof ticket !== "string" || !ticket) {
    return { ok: false, error: "bad-ticket", reason: "ticket id is required" };
  }
  const discovered = discoverCheckout(facts, { runGit, exists });
  if (!discovered.ok) return discovered;
  const checkout = discovered.checkout;
  return {
    ok: true,
    ticket,
    action,
    checkout,
    diff: diffSummary(checkout, { runGit }),
    checks: deriveChecks(facts),
    confirmToken: confirmToken({
      action,
      ticket,
      branch: checkout.branch,
      head: checkout.head,
      base: checkout.base,
    }),
  };
}
