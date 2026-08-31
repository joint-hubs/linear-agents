#!/usr/bin/env node
// scripts/supervisor-cleanup.mjs — reclaim a child's worktree, behind two keys.
//
//   node scripts/supervisor-cleanup.mjs list    [--run <id>]
//   node scripts/supervisor-cleanup.mjs propose --child <id> [--run <id>] [--issue-file <path>]
//   node scripts/supervisor-cleanup.mjs remove  --child <id> [--run <id>] [--issue-file <path>]
//
// WHY THIS EXISTS: every spawn creates ../la-wt/<branch> and nothing ever
// reclaimed it. ADR-0009 said "cleanup happens on handoff, never on stop" and
// no code implemented it — `git worktree remove` appeared nowhere in the repo.
//
// WHY NOT ON HANDOFF (the amendment, FOC-167). config/graph.json declares
// `review-to-dev-return` and `test-to-dev-return`. A DEV→REVIEW handoff can be
// followed by a return to DEV, so removing the tree at handoff destroys the
// checkout the return path needs. TEST pass is the first point in the topology
// where no return edge can fire: `test.output.pass` is `state: Done`, and Done
// has no outbound edge. That is not a preference, it is where the graph ends.
//
// TWO KEYS, and neither can be turned by the thing being cleaned up:
//
//   1. TEST squad approved — the issue is in a completed Linear state. Per
//      config/graph.json nothing but the `test` node produces Done, so Done IS
//      the TEST verdict. Re-checked at removal time, never trusted from propose:
//      an issue can be dragged back to In Progress after the gate was answered.
//
//   2. Mateusz approved — an answered `cleanup-approval` gate whose recorded
//      fingerprint still matches the tree. The fingerprint is the honest part:
//      a yes covers the tree he was SHOWN (that HEAD, those dirty paths), not
//      whatever the tree became while the gate sat there.
//
// AND the caller must be the Supervisor. A child runs with LA_SUPERVISOR_CHILD
// set (supervisor-spawn.mjs), so its presence here means a child is trying to
// reclaim the checkout it is standing in. Refused by identity, before any
// approval is read. SUPERVISOR_DENY also denies `git worktree remove` at the
// harness level — belt and braces, same as the push gate, and with the same
// caveat: the deny rule stops the accidental call, this check stops the rest.
//
// WHAT REMOVAL ACTUALLY COSTS: `git worktree remove` deletes the checkout and
// leaves the BRANCH. Every commit stays reachable. The only thing that dies is
// what was never committed — which is exactly what the fingerprint pins and the
// gate puts in front of a human.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve, isAbsolute } from "node:path";

import { allGates } from "./supervisor-gate.mjs";
import {
  LIVE_STATUSES,
  ROOT,
  dirtyTreeReport,
  failJson,
  git,
  listWorktrees,
  parseArgs,
  readRegistry,
  resolveGitRoot,
  updateChild,
} from "./supervisor-lib.mjs";

const GATE_KIND = "cleanup-approval";

// Deliberately small and deliberately whole-answer. "yes, but leave the log
// file" is a conversation, not an approval, and a script that reads the "yes"
// out of it and deletes the log file has answered a question nobody asked.
// Listed in the refusal message so the operator never has to guess.
const AFFIRMATIVE = ["yes", "tak", "approve", "approved", "zatwierdzam", "usun", "usuń"];
const NEGATIVE = ["no", "nie", "reject", "rejected", "odrzucam", "stop"];

const normalise = (text) =>
  String(text ?? "")
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, "");

export const isAffirmative = (text) => AFFIRMATIVE.includes(normalise(text));
export const isNegative = (text) => NEGATIVE.includes(normalise(text));

/**
 * What the human was shown, reduced to something comparable.
 *
 * HEAD plus the sorted porcelain lines, and nothing else. Not the mtime, not the
 * file sizes: this has to be stable across a re-read of an untouched tree, or
 * every approval would expire the moment it was granted.
 */
export function fingerprint({ head, dirty }) {
  const payload = JSON.stringify({ head: head ?? null, dirty: [...(dirty ?? [])].sort() });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

// ── the two keys ─────────────────────────────────────────────────────────────

/**
 * Key 1. `--issue-file` is the offline seam, the same one supervisor-triage.mjs
 * uses: the suite feeds fixtures through it, and it is how you proceed when
 * Linear is down. There is deliberately NO `--test-approved` flag — a key you
 * can turn with a flag is not a key.
 */
export function testApproval(taskId, args) {
  let issue;
  if (args["issue-file"] && args["issue-file"] !== true) {
    const path = args["issue-file"];
    if (!existsSync(path)) failJson(`--issue-file ${path} does not exist`);
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      issue = parsed.issue ?? parsed;
    } catch (err) {
      failJson(`--issue-file ${path} is not readable JSON: ${err.message}`);
    }
  } else {
    if (!taskId) {
      return { approved: false, reason: "the registry entry has no taskId, so there is no issue to check" };
    }
    try {
      const out = execFileSync(
        process.execPath,
        [join(ROOT, "scripts", "linear-query.mjs"), "issue", taskId, "--json"],
        { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      issue = JSON.parse(out);
    } catch (err) {
      // Unreachable Linear is UNKNOWN, not "not approved" and certainly not
      // "approved". Both keys must be positively established; a network error
      // establishes neither.
      failJson(`could not read issue ${taskId} from Linear: ${err.message.split("\n")[0]}`, {
        hint: "pass --issue-file <path> to check against a saved payload",
      });
    }
  }

  const state = issue?.state ?? {};
  const approved = state.type === "completed";
  return {
    approved,
    state: state.name ?? null,
    stateType: state.type ?? null,
    issue: issue?.identifier ?? taskId ?? null,
    reason: approved
      ? null
      : `${issue?.identifier ?? taskId} is "${state.name ?? "unknown"}" (${state.type ?? "?"}), not completed — ` +
        `only the TEST node produces Done (config/graph.json), so nothing has approved this work yet`,
  };
}

/** Key 2. The most recent cleanup gate for this child, whatever its status. */
export function latestCleanupGate(runId, childId) {
  const mine = allGates(runId).filter((g) => g.kind === GATE_KIND && g.childId === childId);
  return mine.length ? mine[mine.length - 1] : null;
}

// ── the tree ─────────────────────────────────────────────────────────────────

/**
 * The main checkout — where `git worktree remove` has to run from. The first
 * entry of `git worktree list` is always the main worktree, so ask the tree
 * itself rather than assuming this script lives in the same repo as the child.
 */
function mainRepoFor(entry, args) {
  if (args.repo && args.repo !== true) {
    try {
      return resolveGitRoot(args.repo);
    } catch (err) {
      failJson(`--repo ${args.repo} is not inside a git repository: ${err.message.split("\n")[0]}`);
    }
  }
  if (entry.worktree && existsSync(entry.worktree)) {
    try {
      const listed = listWorktrees(entry.worktree);
      if (listed.length) return resolve(listed[0].path);
    } catch {
      // fall through — a corrupt worktree still has a repo somewhere
    }
  }
  try {
    return resolveGitRoot(ROOT);
  } catch (err) {
    failJson(`cannot resolve a git repository to work from: ${err.message.split("\n")[0]}`);
  }
}

function treeState(worktree, baseRevision) {
  const head = (() => {
    try {
      return git(["rev-parse", "HEAD"], worktree);
    } catch {
      return null;
    }
  })();
  const dirty = dirtyTreeReport(worktree);
  let commitsAhead = null;
  if (head && baseRevision) {
    try {
      commitsAhead = Number(git(["rev-list", "--count", `${baseRevision}..HEAD`], worktree));
    } catch {
      commitsAhead = null;
    }
  }
  return { head, dirty, commitsAhead, fingerprint: fingerprint({ head, dirty }) };
}

const insideOf = (parent, child) => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

// ── guards shared by propose and remove ──────────────────────────────────────

/**
 * Identity. Runs before anything else on every subcommand, including `list`:
 * a child has no business even enumerating which trees are reclaimable, and a
 * refusal that depends on which subcommand was typed is a refusal with a hole
 * in it.
 */
function assertSupervisorIdentity() {
  const childId = process.env.LA_SUPERVISOR_CHILD;
  if (!childId) return;
  failJson(
    `refusing: LA_SUPERVISOR_CHILD=${childId} is set, so this is running inside a spawned child`,
    {
      hint:
        "worktree removal is the Supervisor's act, never a child's — a child would be reclaiming " +
        "the checkout it is standing in. Run this from the Supervisor session.",
    },
  );
}

function requireEntry(runId, childId) {
  if (!childId || childId === true) failJson("--child <childId> is required");
  const registry = readRegistry(runId);
  const entry = registry.children[childId];
  if (!entry) {
    failJson(`no child "${childId}" in run ${runId}`, { known: Object.keys(registry.children) });
  }
  if (!entry.worktree) {
    failJson(`child "${childId}" has no worktree recorded — there is nothing to reclaim`, { entry });
  }
  return entry;
}

function assertNotLive(childId, entry) {
  if (LIVE_STATUSES.includes(entry.status)) {
    failJson(
      `child "${childId}" is ${entry.status} — a worktree under a running process is never reclaimable`,
      { hint: `stop it first: node scripts/supervisor-stop.mjs --child ${childId}` },
    );
  }
}

// ── list ─────────────────────────────────────────────────────────────────────

function cmdList(args) {
  const runId = requireRun(args);
  const registry = readRegistry(runId);

  const children = Object.values(registry.children).map((entry) => {
    const gate = latestCleanupGate(runId, entry.childId);
    const present = Boolean(entry.worktree) && existsSync(entry.worktree);
    const state = present ? treeState(entry.worktree, entry.baseRevision) : null;

    // Deliberately offline: `list` must stay cheap enough to run on every
    // digest. The TEST key needs Linear, so it is reported as unchecked rather
    // than guessed — `propose` is where that key gets turned.
    //
    // Hence `localBlockers`, not `blockers`. An empty list here means "nothing
    // I can see from disk stops this", which is NOT the same as reclaimable:
    // one of the two keys has not been looked at. A field called `blockers`
    // coming back empty would have said the opposite.
    const localBlockers = [];
    if (!entry.worktree) localBlockers.push("no worktree recorded");
    else if (!present) localBlockers.push("worktree already gone");
    if (LIVE_STATUSES.includes(entry.status)) localBlockers.push(`child is ${entry.status}`);
    if (!gate) localBlockers.push("no cleanup-approval gate yet — run `propose`");
    else if (gate.status !== "answered") localBlockers.push(`gate ${gate.gateId} is ${gate.status}`);
    else if (!isAffirmative(gate.answer?.text)) localBlockers.push(`gate ${gate.gateId} was not approved`);
    else if (gate.facts?.fingerprint !== state?.fingerprint) {
      localBlockers.push(`gate ${gate.gateId} approved a different tree state`);
    }

    return {
      childId: entry.childId,
      squad: entry.squad ?? null,
      taskId: entry.taskId ?? null,
      status: entry.status,
      worktree: entry.worktree ?? null,
      branch: entry.branch ?? null,
      present,
      worktreeRemovedAt: entry.worktreeRemovedAt ?? null,
      dirtyCount: state ? state.dirty.length : null,
      commitsAhead: state ? state.commitsAhead : null,
      gate: gate ? { gateId: gate.gateId, status: gate.status } : null,
      testApproval: "unchecked — `propose` reads Linear",
      localBlockers,
    };
  });

  console.log(JSON.stringify({ ok: true, runId, children }, null, 2));
}

// ── propose ──────────────────────────────────────────────────────────────────

function cmdPropose(args) {
  const runId = requireRun(args);
  const childId = args.child;
  const entry = requireEntry(runId, childId);
  assertNotLive(childId, entry);

  if (!existsSync(entry.worktree)) {
    failJson(`the worktree for "${childId}" is already gone (${entry.worktree})`, {
      hint: `run \`remove --child ${childId}\` to reconcile git's own record of it`,
    });
  }

  // Key 1 first, and fail-closed. Asking Mateusz to approve cleanup of work TEST
  // has not blessed teaches him to approve these without reading them, which is
  // how the second key stops being a key.
  const test = testApproval(entry.taskId, args);
  if (!test.approved) {
    failJson(`TEST has not approved this work: ${test.reason}`, {
      childId,
      taskId: entry.taskId ?? null,
      state: test.state,
      noGateEmitted: true,
    });
  }

  const state = treeState(entry.worktree, entry.baseRevision);

  // Don't ask the same question twice. A gate is answered once, so re-proposing
  // an unchanged tree just puts a second identical question in his queue and
  // leaves the first one pending forever. A tree that HAS moved is a different
  // question and gets a new gate — the stale one stays on disk as the record of
  // what was asked when.
  const pending = latestCleanupGate(runId, childId);
  if (pending && pending.status === "pending" && pending.facts?.fingerprint === state.fingerprint) {
    failJson(`gate ${pending.gateId} is already open for this exact tree — it is waiting on Mateusz, not on you`, {
      gateId: pending.gateId,
      hint: `node scripts/supervisor-gate.mjs list --run ${runId} --status pending`,
    });
  }

  const facts = {
    childId,
    squad: entry.squad ?? null,
    taskId: entry.taskId ?? null,
    worktree: entry.worktree,
    branch: entry.branch ?? null,
    head: state.head,
    dirty: state.dirty,
    commitsAhead: state.commitsAhead,
    fingerprint: state.fingerprint,
    testState: test.state,
    proposedAt: new Date().toISOString(),
  };

  const loss = state.dirty.length
    ? `${state.dirty.length} uncommitted path(s) will be destroyed:\n  ${state.dirty.join("\n  ")}`
    : "the tree is clean — nothing uncommitted will be lost";

  const summary =
    `Remove the worktree for ${childId} (${entry.taskId ?? "no task"}) at ${entry.worktree}. ` +
    `TEST approved: ${test.issue} is ${test.state}.`;

  const question =
    `${loss}\n\n` +
    `The branch ${entry.branch ?? "?"} and its ` +
    `${state.commitsAhead ?? "?"} commit(s) survive — only the checkout goes. ` +
    `Approve removal? (yes / tak / approve)`;

  // Written through supervisor-gate.mjs rather than here, so gate records keep
  // exactly one writer. The Supervisor emits this one; the child does not.
  const out = execFileSync(
    process.execPath,
    [
      join(ROOT, "scripts", "supervisor-gate.mjs"),
      "emit",
      "--run", runId,
      "--child", childId,
      "--kind", GATE_KIND,
      "--summary", summary,
      "--question", question,
      "--facts", JSON.stringify(facts),
    ],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );

  const gate = JSON.parse(out);

  console.log(
    JSON.stringify(
      {
        ok: true,
        runId,
        childId,
        gateId: gate.gateId,
        testApproval: test,
        facts,
        // Recording is not approving, the same gap supervisor-gate.mjs states on
        // every answer. Say what is still missing rather than implying the tree
        // is now scheduled for anything.
        next: [
          `read it to Mateusz verbatim: node scripts/supervisor-gate.mjs list --run ${runId} --status pending`,
          `record his answer:        node scripts/supervisor-gate.mjs answer --run ${runId} --gate ${gate.gateId} --text "<his words>"`,
          `then, and only then:      node scripts/supervisor-cleanup.mjs remove --run ${runId} --child ${childId}`,
        ],
      },
      null,
      2,
    ),
  );
}

// ── remove ───────────────────────────────────────────────────────────────────

function cmdRemove(args) {
  const runId = requireRun(args);
  const childId = args.child;
  const entry = requireEntry(runId, childId);
  assertNotLive(childId, entry);

  const repo = mainRepoFor(entry, args);
  const listed = listWorktrees(repo).find(
    (w) => resolve(w.path).toLowerCase() === resolve(entry.worktree).toLowerCase(),
  );

  // Already gone. No key is required to report that, because the thing the keys
  // protect — an existing checkout with possibly-uncommitted work in it — is not
  // there to protect. `prune` here only reconciles git's administrative record
  // with a directory somebody already deleted; it destroys nothing.
  if (!existsSync(entry.worktree)) {
    let pruned = false;
    if (listed) {
      try {
        git(["worktree", "prune"], repo);
        pruned = true;
      } catch {
        pruned = false;
      }
    }
    updateChild(runId, childId, { worktreeRemovedAt: entry.worktreeRemovedAt ?? new Date().toISOString() });
    console.log(
      JSON.stringify(
        {
          ok: true,
          childId,
          alreadyRemoved: true,
          pruned,
          worktree: entry.worktree,
          branch: entry.branch ?? null,
          note: "the checkout was already gone; nothing was destroyed and no approval was needed",
        },
        null,
        2,
      ),
    );
    return;
  }

  // Never delete the directory you are standing in: the removal would half-
  // succeed, git would be left with a stale entry, and the cwd of this very
  // process would be a path that no longer exists.
  if (insideOf(entry.worktree, process.cwd())) {
    failJson(`refusing: the current directory is inside the worktree being removed (${entry.worktree})`, {
      cwd: process.cwd(),
      hint: "run this from the main checkout",
    });
  }

  // Key 1, re-checked. propose's verdict is not carried forward: an issue can be
  // dragged back to In Progress between the approval and the removal, and the
  // approval was for finished work.
  const test = testApproval(entry.taskId, args);
  if (!test.approved) {
    failJson(`TEST has not approved this work: ${test.reason}`, { childId, state: test.state });
  }

  // Key 2.
  const gate = latestCleanupGate(runId, childId);
  if (!gate) {
    failJson(`no ${GATE_KIND} gate for "${childId}" — Mateusz has not been asked`, {
      hint: `node scripts/supervisor-cleanup.mjs propose --run ${runId} --child ${childId}`,
    });
  }
  if (gate.status !== "answered") {
    failJson(`gate ${gate.gateId} is ${gate.status} — TEST approving is one key, not two`, {
      gateId: gate.gateId,
      question: gate.questions,
    });
  }
  if (isNegative(gate.answer?.text)) {
    failJson(`gate ${gate.gateId} was answered "${gate.answer?.text}" — Mateusz said no`, {
      gateId: gate.gateId,
      hint: "if that has changed, propose again; an answered gate is never rewritten",
    });
  }
  if (!isAffirmative(gate.answer?.text)) {
    failJson(
      `gate ${gate.gateId} was answered "${gate.answer?.text}", which is not an unambiguous approval`,
      {
        gateId: gate.gateId,
        accepted: AFFIRMATIVE,
        hint:
          "a destructive approval has to be the whole answer — \"yes, but keep the log\" is a conversation, " +
          "not a yes. Propose again and let him answer it cleanly.",
      },
    );
  }

  // The fingerprint. This is the one that earns its keep: the yes covered the
  // tree Mateusz was shown, and a tree that moved since is a tree nobody
  // approved.
  const state = treeState(entry.worktree, entry.baseRevision);
  const approvedFingerprint = gate.facts?.fingerprint ?? null;
  if (!approvedFingerprint) {
    failJson(`gate ${gate.gateId} carries no fingerprint — it cannot be matched against the tree`, {
      gateId: gate.gateId,
      hint: "emitted before FOC-167, or by hand. Propose again.",
    });
  }
  if (approvedFingerprint !== state.fingerprint) {
    failJson(`the worktree changed since gate ${gate.gateId} was approved`, {
      gateId: gate.gateId,
      approved: { head: gate.facts?.head ?? null, dirty: gate.facts?.dirty ?? [], fingerprint: approvedFingerprint },
      now: { head: state.head, dirty: state.dirty, fingerprint: state.fingerprint },
      hint: `that approval was for a different tree — node scripts/supervisor-cleanup.mjs propose --run ${runId} --child ${childId}`,
    });
  }

  // `--force` only because the dirty set in front of him is byte-for-byte the
  // dirty set here — the fingerprint above is what makes that true. Without it
  // this flag would be the script deciding which uncommitted work is expendable.
  const forced = state.dirty.length > 0;
  const gitArgs = ["worktree", "remove", entry.worktree, ...(forced ? ["--force"] : [])];
  try {
    git(gitArgs, repo);
  } catch (err) {
    failJson(`git worktree remove failed: ${err.message.split("\n")[0]}`, {
      repo,
      command: `git ${gitArgs.join(" ")}`,
    });
  }

  // worktree/branch/baseRevision are KEPT. Whoever picks this up later — the
  // merge node, or Mateusz reading a digest — needs to know where the work was
  // and which branch holds it. Clearing them on removal would orphan the record
  // of a branch that still exists.
  updateChild(runId, childId, { worktreeRemovedAt: new Date().toISOString() });

  console.log(
    JSON.stringify(
      {
        ok: true,
        childId,
        removed: entry.worktree,
        forced,
        branch: entry.branch ?? null,
        // Said out loud every time: the branch survives, so "removed" never has
        // to be read as "the work is gone".
        branchNote: entry.branch
          ? `branch ${entry.branch} is untouched — ${state.commitsAhead ?? "?"} commit(s) ahead of the base, still reachable`
          : "no branch recorded",
        destroyed: state.dirty,
        keys: {
          test: `${test.issue} is ${test.state}`,
          human: `gate ${gate.gateId} answered "${gate.answer?.text}" at ${gate.answer?.answeredAt}`,
          fingerprint: state.fingerprint,
        },
      },
      null,
      2,
    ),
  );
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function requireRun(args) {
  const runId = args.run || process.env.LA_SUPERVISOR_RUN;
  if (!runId || runId === true) failJson("--run <supervisorRunId> is required (or set LA_SUPERVISOR_RUN)");
  return runId;
}

function main() {
  assertSupervisorIdentity();

  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];

  if (cmd === "list") return cmdList(args);
  if (cmd === "propose") return cmdPropose(args);
  if (cmd === "remove") return cmdRemove(args);

  failJson(`unknown subcommand "${cmd ?? ""}" — expected list | propose | remove`);
}

export { GATE_KIND, AFFIRMATIVE, treeState };

if (process.argv[1]?.endsWith("supervisor-cleanup.mjs")) main();
