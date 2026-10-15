// scripts/supervisor-spawn.mjs — start one squad child, in its own worktree.
//
//   node scripts/supervisor-spawn.mjs --squad <plan|dev|review|test> --task <issueId>
//       --prompt "<kickoff>" [--run <supervisorRunId>] [--child <id>]
//       [--permission-mode <mode>] [--model <id>] [--settings <extra-deny.json>]
//       [--repo <path>] [--slug <text>] [--candidate <sha-or-branch>]
//       [--allowed-path <p> ...]
//       [--pre-authorized <cmd> ...] [--known-quirk <text> ...]
//       [--referenced-file <path> ...]
//   node scripts/supervisor-spawn.mjs --release [--run <supervisorRunId>]
//
// Returns as soon as the child's session_id is known; the child keeps running
// under a detached watcher (supervisor-watch.mjs), which owns liveness.
//
// Every child is launched with a GENERATED child-settings.json carrying the P9
// deny list (§1.7). `--settings` here does not replace it — the file it names is
// folded in as one more deny source, so the flag can only tighten.
//
// `--pre-authorized` and `--known-quirk` (each repeatable, FOC-296) fill two of
// the pinned-state prologue's declaration fields: the verify commands
// pre-allowed for this child and the runbook quirks the Supervisor declares at
// handoff. `--referenced-file` (repeatable, FOC-357) fills the third: the files
// the kickoff names, which spawn VERIFIES against the worktree before
// launching. They render as prologue text and ride the registry record — they
// never touch the generated settings file, which stays deny-only.
//
// Fail-closed by design — it refuses rather than guesses when:
//   · triage.json is missing (a verdict must be recorded before any spawn)
//   · the node is at its concurrency limit, or its consumer is saturated — then
//     the request is HELD (written down, released later), not refused
//   · no system/init arrives within 30 s (a child with no session_id is not resumable)

import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  actorIdFor,
  attemptIdFor,
  launchDirFor,
  prepareAgentLaunch,
} from "./agent-launch-profile.mjs";
import { isRuntimeToken } from "./runtime-events.mjs";

import { buildBranchName } from "./dev-branch.mjs";
import { settingsPath, squadConfigDir } from "./fenix-paths.mjs";
import { assertModelPolicy, childModelFor, childProviderEnv } from "./child-model.mjs";
import { readSettings } from "./fenix-settings.mjs";
import { ensureCodegraphReady } from "./codegraph-runtime.mjs";
import { approveGuardedCodegraphForProject } from "./mcp-enable.mjs";
import { atomicWriteJSON } from "./utils.mjs";
import {
  INIT_TIMEOUT_MS,
  ROOT,
  TERMINAL_STATUSES,
  TURN_END_CONTRACT,
  admissionCheck,
  heldDir,
  heldPath,
  asArray,
  assertStageBudget,
  assertWithinBudget,
  buildChildSettings,
  childSettingsPath,
  ensureRunDir,
  ensureWorktree,
  failJson,
  git,
  killTree,
  listWorktrees,
  printBgWaitCeilingEnv,
  readHeld,
  hasPriceRow,
  parseArgs,
  pinnedStatePrologue,
  readJsonOr,
  readRegistry,
  resolveGitRoot,
  runDir,
  teeAbsPath,
  teeRelPath,
  triagePath,
  updateChild,
  verifyPinnedState,
  writeRegistry,
} from "./supervisor-lib.mjs";
import { loadGraph } from "./graph-validate.mjs";
import { normalizeFocus, setFocus } from "./supervisor-focus.mjs";
import { RUN_ID_RE } from "./supervisor-current-run.mjs";

// A graph we cannot read means no topology: no per-node limit and no consumer to
// apply backpressure from. Triage would already have refused a broken graph, so
// this is a degraded path rather than a normal one.
const graphOrNull = () => { try { return loadGraph(); } catch { return null; } };

const SQUADS = ["plan", "dev", "review", "test"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = parseArgs(process.argv.slice(2));

const squad = args.squad;
const taskId = args.task;
const runId = args.run || process.env.LA_SUPERVISOR_RUN;

// ── --release: start what was held, oldest first ─────────────────────────────
// Handled before the normal argument checks, because a release carries no
// --squad or --prompt of its own: those live in the held record, and replaying
// them is the whole point. Held requests are released oldest-first so a slot
// that frees goes to whoever has been waiting longest.
if (args.release) {
  if (!runId) failJson("--run <supervisorRunId> is required (or set LA_SUPERVISOR_RUN)");
  const graph = graphOrNull();
  const started = [];
  const stillHeld = [];

  for (const h of readHeld(runId)) {
    if (h.unreadable) {
      // Not skipped silently: an unreadable held record is a slot somebody is
      // waiting for, and pretending it is not there releases that slot to
      // someone else.
      stillHeld.push({ ...h, why: "unreadable — inspect it by hand" });
      continue;
    }
    // excludeHeldSquad: the sibling held requests are queued BEHIND this record,
    // they do not occupy its slot. Counting them would deadlock the release
    // whenever concurrency=1 and two or more requests wait (each refused
    // because of the others, so none can ever start). The replay below still
    // passes the normal admission path, so a slot taken by the record released
    // here is seen by the siblings checked after it.
    const check = admissionCheck(runId, h.squad, graph, undefined, {
      excludeHeld: h.heldId,
      excludeHeldSquad: h.squad,
    });
    if (!check.admit) {
      stillHeld.push({ heldId: h.heldId, squad: h.squad, taskId: h.taskId, why: check.detail });
      continue;
    }
    // Remove the record BEFORE replaying it — a held request counts against
    // its own slot otherwise. The replay carries `--release-replay` so the
    // normal admission path below asks the same question this check just
    // answered ("is the LIVE slot free?") instead of the new-spawn question
    // ("is the queue empty?"), which would re-hold the request behind the
    // very siblings this check excluded — re-held with a fresh record, so
    // nothing would ever start.
    rmSync(heldPath(runId, h.heldId), { force: true });
    const res = spawnSync(process.execPath, [process.argv[1], ...(h.argv ?? []), "--release-replay"], {
      encoding: "utf8",
      env: process.env,
    });
    let result = null;
    try {
      result = JSON.parse(res.stdout);
    } catch {
      result = { ok: false, error: (res.stderr || res.stdout || "").split("\n")[0] };
    }
    started.push({ heldId: h.heldId, squad: h.squad, taskId: h.taskId, result });
  }

  console.log(JSON.stringify({ ok: true, released: started.length, started, stillHeld }, null, 2));
  process.exit(0);
}

if (!squad || !SQUADS.includes(squad)) failJson(`--squad must be one of ${SQUADS.join(" | ")}`);
if (!taskId) failJson("--task <issueId> is required");
// Checked here rather than left to buildBranchName, which exits 2 directly and
// would bypass the JSON error contract every other failure path honours.
if (!/^[A-Za-z]+-\d+$/.test(String(taskId))) {
  failJson(`--task "${taskId}" is not a Linear identifier (expected TEAM-NUM, e.g. FOC-123)`);
}
if (!runId) failJson("--run <supervisorRunId> is required (or set LA_SUPERVISOR_RUN)");
if (!args.prompt && !args["prompt-file"]) failJson("--prompt or --prompt-file is required");

// FOC-296: the two prologue declaration fields are TEXT, rendered one field per
// line. A missing value parses as boolean `true`, and a value starting with
// `--` is swallowed as the next flag — either would render the string "true"
// into the prologue as if it were a command. A newline would break the
// one-line-per-field invariant the fixed ten-field shape depends on. All three
// refuse here, before anything is written or launched.
for (const flag of ["pre-authorized", "known-quirk"]) {
  for (const value of asArray(args[flag])) {
    if (value === true) {
      failJson(`--${flag} needs a value — a missing value, or one starting with "--", is not a command to pin`);
    }
    if (/[\r\n]/.test(String(value))) {
      failJson(`--${flag} value must be a single line — split it into repeated --${flag} flags`);
    }
  }
}

// FOC-357: --referenced-file declares a PATH the kickoff names, checked against
// the worktree below. Same parse hazard as the FOC-296 fields — a missing value
// parses as boolean `true` and would be verified as the literal path "true" —
// so it refuses up front, naming the thing it is not: a file path, not a
// command to pin. A newline would break the prologue's one-line-per-field
// shape the same way.
for (const value of asArray(args["referenced-file"])) {
  if (value === true) {
    failJson(`--referenced-file needs a value — a missing value, or one starting with "--", is not a file path`);
  }
  if (/[\r\n]/.test(String(value))) {
    failJson(`--referenced-file value must be a single line — split it into repeated --referenced-file flags`);
  }
}

// FOC-406: --candidate names the commit a child's worktree must start at — the
// DEV candidate a REVIEW/TEST child verifies. Same parse hazard as the
// FOC-296/FOC-357 fields: a missing value parses as boolean `true`, a newline
// is not a revision anyone typed, and an empty value would resolve to nothing
// at all. All three refuse here, before anything is written or launched; the
// git resolution itself happens below, once the repo is known.
const hasCandidate = args.candidate !== undefined;
if (hasCandidate) {
  if (args.candidate === true) {
    failJson(`--candidate needs a value — a missing value, or one starting with "--", is not a revision`);
  }
  if (/[\r\n]/.test(String(args.candidate))) {
    failJson(`--candidate value must be a single line — name one commit or branch`);
  }
  if (!String(args.candidate).trim()) {
    failJson(`--candidate value is empty — name the commit or branch to pin the worktree at`);
  }
}

// ── FOC-607: the --model policy, judged before anything is created ───────────
// Sits with the other argument checks, ABOVE the admission/hold branch below:
// a banned or unpriced --model must be refused whether the node is at capacity
// or not. Left after admission, a refused request consumed a hold record (with
// the original argv) and was then rejected on replay — the request was lost.
// This judges only the explicit --model request; the child's model itself is
// still resolved by childModelFor below (precedence unchanged, FOC-762).
// hasPriceRow honours the LA_MODELS_ROOT test seam. The first side effects
// below are the run dir (ensureRunDir), the held-request record and the
// workspace claim — none of which a refused spawn reaches.
const requestedModel = args.model && args.model !== true ? String(args.model) : null;
const policyRefusal = assertModelPolicy({ squad, requestedModel, hasPriceRow });
if (policyRefusal) {
  failJson(`model policy refused the spawn: ${policyRefusal.message}`, {
    error: policyRefusal.error,
    message: policyRefusal.message,
  });
}

// ── fail-closed: the verdict comes before the spawn ──────────────────────────
// AC-2. Spawning without a recorded triage verdict is how a Supervisor ends up
// running a squad nobody chose, with no record of why.
if (!existsSync(triagePath(runId))) {
  failJson(`no triage verdict recorded for run ${runId} — run supervisor-triage.mjs record first`, {
    expected: triagePath(runId),
  });
}

ensureRunDir(runId);
const registry = readRegistry(runId);

// ── the child id is decided BEFORE the branch name ───────────────────────────
// The branch for this attempt is made unique per run:child (the attempt hash
// below), so the id has to exist first. An EXPLICIT --child that already sits
// in the registry is a refusal, never an overwrite — a duplicated child id
// would silently orphan the first child's session, settings and worktree
// claim. A bare `--child` without a value parses as boolean `true` and is
// refused the same way every other value-taking flag here is.
const explicitChild = args.child ?? null;
if (explicitChild === true) {
  failJson(`--child needs a value — a missing value is not a child id`);
}
if (explicitChild && registry.children[explicitChild]) {
  failJson(
    `child "${explicitChild}" already exists in run ${runId} — refusing to overwrite it: duplicate-child-id`,
    {
      reason: "duplicate-child-id",
      childId: explicitChild,
      existing: { squad: registry.children[explicitChild].squad, taskId: registry.children[explicitChild].taskId },
    },
  );
}
const childId = explicitChild || `${squad}-${Object.keys(registry.children).length + 1}`;

// ── semaphore + backpressure (FOC-161) ───────────────────────────────────────
// Replaces the one-live-child constant. Limits come from config/graph.json, and
// a spawn that cannot start now is HELD rather than refused: the request is
// written down and released when a slot frees. Refusing would make the
// Supervisor responsible for remembering what it asked for, which is the kind of
// state a model loses across a compaction.
// `--release-replay` marks a request the release loop already admitted. The
// replay re-enters this normal path, and the held siblings queued BEHIND it
// must not hold it out of its own slot again. This is not a bypass flag: live
// capacity still refuses (a slot taken since the release check re-holds the
// request), and only the release loop ever writes the marker.
const admission = args["release-replay"]
  ? admissionCheck(runId, squad, graphOrNull(), undefined, { excludeHeldSquad: squad })
  : admissionCheck(runId, squad, graphOrNull());
// No bypass flag. One was there for a moment and it defeated the point: the
// semaphore exists so that raising a limit is a committed edit to
// config/graph.json, and a CLI flag that skips it hands that decision back to
// whoever types the command.
if (!admission.admit) {
  const heldId = `held-${squad}-${Date.now()}`;
  mkdirSync(heldDir(runId), { recursive: true });
  atomicWriteJSON(heldPath(runId, heldId), {
    heldId,
    squad,
    taskId,
    reason: admission.reason,
    detail: admission.detail,
    consumer: admission.consumer ?? null,
    heldAt: new Date().toISOString(),
    // Everything needed to start it later, so `--release` replays the request
    // rather than asking the Supervisor to reconstruct it. The release marker
    // is stripped: it belongs to the release attempt, not to the request — a
    // replay that is held again must keep its original argv (and queue
    // seniority would be lost rewriting it anyway).
    argv: process.argv.slice(2).filter((a) => a !== "--release-replay"),
  });
  console.log(
    JSON.stringify(
      {
        ok: true,
        held: true,
        heldId,
        squad,
        taskId,
        reason: admission.reason,
        detail: admission.detail,
        queue: admission.state,
        next: `node scripts/supervisor-spawn.mjs --release --run ${runId}  (starts held requests whose slot has freed)`,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

// ── fail-closed: the spend cap ───────────────────────────────────────────────
// A turn boundary is the only place this can be checked, so the cap is post-hoc
// by construction: the turn already running may overshoot it. That is stated
// rather than hidden. Unset means no cap and no behaviour change.
assertWithinBudget(runId);

// The per-stage split, checked AFTER the global cap and never instead of it.
// Order matters and is the contract (FOC-162): the global cap is the outer
// backstop, the stage gate is the working control, and each refusal names
// which one it was. A run with no allocation skips this entirely — the
// feature is opt-in per run, and a run started before `budget allocate` must
// not become unstartable.
assertStageBudget(runId, squad, { graph: (() => {
  try {
    return loadGraph();
  } catch {
    // A graph we cannot read means no stage mapping, so no stage gate. The
    // global cap still applies; triage would already have refused a broken graph.
    return null;
  }
})() });

// ── worktree ─────────────────────────────────────────────────────────────────
// Every child gets its own checkout (ADR-0009 amended 2026-08-25). A shared
// working tree under two children is the failure observed twice on this repo:
// agents committing each other's changes, and a branch switched under a live run.
// Wrapped: git exits non-zero on a path that is not a repo, and an unwrapped
// throw here printed a stack trace instead of the JSON every other failure path
// returns — the Supervisor reads stdout, so that failure was invisible to it.
// WHICH repo, and why it is not ROOT (FOC-172). This used to fall back to
// linear-agents, the orchestration repo — so a child working on a task in some
// other codebase got a checkout of the ORCHESTRATOR instead of the code the task
// is about, and reported the missing code as a configuration blocker. Observed
// on a real run: every supervisor launch in the store has a different cwd
// (Fraud-Prediction, joint-flows, moto_computer_vision, landing), because the
// Supervisor is launched FROM the repo it is working on. That cwd is the answer.
//
// Order: explicit flag, then the launcher's captured start directory, then this
// process's cwd. No ROOT fallback — a silent default to linear-agents is the
// bug, and "no repo" is a question for Mateusz, not something to guess at.
// An EXPLICIT --repo that is not a repo is an error, not an invitation to try
// the next candidate. Letting it fall through was a real defect in the first
// version of this block — caught by supervisor-triage.test.mjs, which points
// --repo at a non-repo and expects a refusal: the fallback quietly reached
// process.cwd(), found linear-agents, and started a child there. The exact
// failure this whole change exists to remove.
if (args.repo && args.repo !== true) {
  try {
    resolveGitRoot(args.repo);
  } catch (err) {
    failJson(`--repo ${args.repo} is not inside a git repository: ${err.message.split("\n")[0]}`);
  }
}

const repoCandidates = [
  { value: args.repo, from: "--repo" },
  { value: process.env.LA_SUPERVISOR_REPO, from: "LA_SUPERVISOR_REPO (bin/supervisor.bat)" },
  { value: process.cwd(), from: "current directory" },
].filter((c) => c.value && c.value !== true);

let gitRoot;
let repoFrom;
const repoErrors = [];
for (const candidate of repoCandidates) {
  try {
    gitRoot = resolveGitRoot(candidate.value);
    repoFrom = candidate.from;
    break;
  } catch (err) {
    repoErrors.push(`${candidate.from}: ${candidate.value} — ${err.message.split("\n")[0]}`);
  }
}
if (!gitRoot) {
  failJson(
    "could not determine which repository this child should work in — none of the candidates is a git repo",
    {
      tried: repoErrors,
      hint: "pass --repo <path>, or launch bin/supervisor.bat from the repo the task belongs to",
    },
  );
}
// Every spawn is a NEW attempt and owns its branch: the managed branch name
// carries a stable 12-hex hash of `runId:childId`, so two attempts of the same
// task never share a branch — and therefore never share a worktree, which is
// what the claims registry (the ownerId passed to ensureWorktree below) then
// vouches for. The hash is stable, so a retry of the same child id in the same
// run resolves to the SAME branch and reuses its own worktree; a new child id
// (a new attempt) gets a new one. Shared-branch reuse ACROSS runs is gone by
// design: the owner of `foc-123-dev` is now the attempt, not the task slug.
const dependencyChildren = typeof args['after-child'] === 'string' ? args['after-child'].split(',').map(x=>x.trim()).filter(Boolean) : [];
const dependencyAttempts = dependencyChildren.map(id => { const source=registry.children?.[id];if(!source?.attemptId)failJson('unknown dependency child or attempt: '+id);return source.attemptId; });

const baseBranch = buildBranchName(taskId, args.slug || squad, undefined);
const attemptHash = createHash("sha256").update(`${runId}:${childId}`).digest("hex").slice(0, 12);
const branch = `${baseBranch}-${attemptHash}`;

// ── --candidate (FOC-406): pin the worktree at the DEV candidate ─────────────
// REVIEW/TEST verify a candidate DEV produced; without this flag their worktree
// starts at the base revision and the reviewer has to checkout the candidate by
// hand (observed live, FOC-473 review kickoff) — and nothing fails when they
// forget. With it, the child's branch is CREATED at the resolved commit and
// `baseRevision` reports it, so the prologue cannot claim a state the child is
// not in. The mechanics are squad-agnostic: dev simply does not pass the flag
// today. Every refusal below is fail-closed — an unresolved or mismatched
// candidate never falls back to the base revision, because verifying the wrong
// tree is worse than verifying nothing.
let candidateSha = null;
if (hasCandidate) {
  const wanted = String(args.candidate).trim();
  // Resolve through git to exactly one commit — by full or short sha, or by
  // branch/tag name. A tree or blob is not a commit a branch can start at.
  try {
    candidateSha = git(["rev-parse", "--verify", "--quiet", `${wanted}^{commit}`], gitRoot);
  } catch {
    failJson(
      `--candidate "${wanted}" does not resolve to a commit in ${gitRoot} — refusing the spawn: candidate-unresolved`,
      { reason: "candidate-unresolved", candidate: wanted, repo: gitRoot },
    );
  }

  // The flag wants its own branch to pin. Sharing a branch a recorded child
  // already owns would put a second child into a tree another child works in —
  // the shared-tree failure ADR-0009 exists to prevent. Candidate-only: the
  // no-flag reuse path below stays exactly as it was (FOC-167).
  const colliding = Object.values(registry.children).filter((c) => c.branch === branch);
  if (colliding.length) {
    failJson(
      `branch ${branch} is already owned by child ${colliding.map((c) => c.childId).join(", ")} in this run — ` +
        `a --candidate spawn needs its own branch, refusing the spawn: candidate-branch-collision`,
      { reason: "candidate-branch-collision", branch, children: colliding.map((c) => c.childId) },
    );
  }

  // Reuse only when the standing tree IS the candidate — a reused worktree is
  // pinned as it stands, so ignoring the candidate would be the exact bug
  // class this flag exists to close.
  const existing = listWorktrees(gitRoot).find((w) => w.branch === branch);
  if (existing) {
    const standingHead = git(["rev-parse", "HEAD"], resolve(existing.path));
    if (standingHead !== candidateSha) {
      failJson(
        `worktree for ${branch} exists at ${resolve(existing.path)} and stands at ${standingHead.slice(0, 12)}, ` +
          `not at the candidate ${candidateSha.slice(0, 12)} — refusing the spawn: candidate-head-mismatch`,
        {
          reason: "candidate-head-mismatch",
          branch,
          worktree: resolve(existing.path),
          worktreeHead: standingHead,
          candidate: candidateSha,
        },
      );
    }
  } else {
    // The branch can exist without a worktree (a previous run's leftover), and
    // `worktree add <path> <branch>` checks out its TIP — which is not
    // necessarily the candidate. Refuse rather than move somebody's branch.
    const branchTip = (() => {
      try {
        return git(["rev-parse", "--verify", `refs/heads/${branch}`], gitRoot);
      } catch {
        return null; // branch does not exist yet — it will be created at the candidate
      }
    })();
    if (branchTip && branchTip !== candidateSha) {
      failJson(
        `branch ${branch} already exists at ${branchTip.slice(0, 12)}, not at the candidate ` +
          `${candidateSha.slice(0, 12)} — refusing the spawn: candidate-branch-tip-mismatch`,
        { reason: "candidate-branch-tip-mismatch", branch, branchTip, candidate: candidateSha },
      );
    }
  }
}

let worktree;
try {
  // P1 resource ownership: the workspace is claimed for THIS attempt, so no
  // other run (or CLI operator) can receive the same branch workspace while
  // this child holds it.
  worktree = ensureWorktree(gitRoot, branch, candidateSha, { ownerId: `${runId}:${childId}` });
} catch (err) {
  failJson(`could not prepare a worktree for ${branch}: ${err.message}`, { gitRoot });
}

// ── pinned state (FOC-286): verify what the kickoff will claim ───────────────
// Every kickoff below starts with a prologue stating the worktree facts as
// certainties. A child that re-checks them — 37% of sessions did, FOC-272 §6 —
// must find them true, or the prologue is one more thing to distrust. So the
// facts are verified HERE, before the registry entry, the settings file and
// the watcher exist: a refusal costs nothing and leaves nothing behind.
const pinnedVerification = verifyPinnedState(worktree);
if (!pinnedVerification.ok) {
  failJson(`pinned-state verification refused the spawn: ${pinnedVerification.reasons.join(", ")}`, {
    pinnedStateVerification: pinnedVerification,
    worktree: worktree.worktree,
    branch: worktree.branch,
    baseRevision: worktree.baseRevision,
  });
}

// The caller's --prompt-file is an input the kickoff is built on, so an
// unreadable one refuses HERE too, while refusal is still free. This also
// closes a silent crash class: the watcher used to receive this path
// unresolved and read it with the worktree as its cwd, so a missing or
// relative path died invisibly behind the 30 s init timeout. Spawn now reads
// the file itself — resolved against the CALLER's cwd, not the worktree's —
// and the watcher is handed a path spawn wrote.
let kickoff = String(args.prompt ?? "");
if (args["prompt-file"]) {
  const callerPromptPath = resolve(args["prompt-file"]);
  try {
    kickoff = readFileSync(callerPromptPath, "utf8");
    pinnedVerification.checks.push({ name: "prompt-file-readable", ok: true, path: callerPromptPath });
  } catch (err) {
    failJson(
      `--prompt-file is not readable (resolved: ${callerPromptPath}): ` +
        `${err.message.split("\n")[0]} — refusing the spawn: prompt-file-unreadable`,
      {
        pinnedStateVerification: {
          ...pinnedVerification,
          ok: false,
          reasons: [...pinnedVerification.reasons, "prompt-file-unreadable"],
        },
      },
    );
  }
}

// FOC-357: the frontman declares the files the kickoff names (--referenced-file,
// repeatable). A kickoff naming a file missing from the child tree cost a full
// turn to discover (§F6): the child reads the pinned worktree, looks for the
// file, finds nothing, and spends the turn reporting the discrepancy instead of
// working. So the declaration is VERIFIED here, on the same terms as the git
// facts above — before the registry entry, the settings file and the watcher
// exist, where a refusal is free and leaves nothing behind. Paths resolve
// against the worktree root; an absolute path inside it resolves to itself.
// Pure declaration read, no Linear access (FOC-286 constraint untouched).
const referencedFiles = asArray(args["referenced-file"]);
if (referencedFiles.length) {
  const missing = referencedFiles.filter((declared) => !existsSync(resolve(worktree.worktree, declared)));
  if (missing.length) {
    pinnedVerification.checks.push({
      name: "referenced-files",
      ok: false,
      reason: "referenced-file-missing",
      missing,
    });
    pinnedVerification.reasons.push("referenced-file-missing");
    pinnedVerification.ok = false;
    failJson(
      `--referenced-file names ${missing.length} file(s) missing from the worktree ` +
        `(resolved against ${worktree.worktree}): ${missing.join(", ")} — refusing the spawn: referenced-file-missing`,
      { pinnedStateVerification: pinnedVerification },
    );
  }
  pinnedVerification.checks.push({ name: "referenced-files", ok: true });
}

// ── CodeGraph launch readiness (plan 2026-09-23 §4: prepare once) ─────────────
// Sits right after the pinned-state validation on purpose (the plan's anchor):
// the kickoff is about to tell this child the graph is its first move, so the
// tree it will work in must actually have a usable index. NEW and REUSED
// worktrees take the SAME check — readiness is a property of the tree's index,
// not of how the tree came to exist — and it runs before the registry entry,
// the settings file and the watcher exist, so the bounded wait (30 s default)
// is the whole cost and a degraded outcome leaves nothing behind.
//
// NOT fail-closed, and that is the contract, not an oversight: an index that
// cannot be proven fresh degrades the child to the sanctioned direct-file
// fallback (Read/Grep) and says so loudly in the kickoff below; refusing the
// spawn over an optional index would trade a bounded degradation for a dead
// child. `initialize: true` is the AUTHORIZED provision path — once per missing
// index, never per question — and only for a worktree THIS spawn owns.
const CODEGRAPH_LAUNCH_TIMEOUT_MS = 30_000;

function prepareCodegraphLaunchReadiness(worktreeRoot, squad, configDir = null) {
  // Test/offline seam: the mock-children suites spawn against fixture repos,
  // and `initialize: true` would index them for real. The seam skips the
  // preflight entirely and reports itself as skipped — a skipped check is a
  // visible state, never a silent ready.
  if (process.env.LA_SUPERVISOR_NO_CODEGRAPH === "1") {
    return {
      ok: false,
      skipped: true,
      root: worktreeRoot,
      reason: "skipped: LA_SUPERVISOR_NO_CODEGRAPH=1 (test/offline seam)",
      synced: false,
      initialized: false,
    };
  }
  let readiness;
  try {
    readiness = ensureCodegraphReady({
      projectRoot: worktreeRoot,
      initialize: true,
      timeoutMs: CODEGRAPH_LAUNCH_TIMEOUT_MS,
    });
  } catch (err) {
    readiness = {
      ok: false,
      root: worktreeRoot,
      reason: `runtime-error: ${String(err?.message ?? err).split("\n")[0]}`,
      synced: false,
      initialized: false,
    };
  }
  // Headless MCP access is the other half of "usable" (plan §4): a worktree is
  // a NEW project key for Claude Code, and the ROOT approval in the squad's
  // config covers only the main checkout — without this, the worktree's
  // project-scoped .mcp.json stays `Pending approval` and a headless child can
  // never click the trust dialog. Only the repo-owned GUARDED codegraph entry
  // is approved, never a foreign repo's servers and never the unguarded raw
  // upstream `codegraph install` leaves behind; a target without it keeps
  // CLI-only access, which the role prompts already route correctly.
  let mcp;
  try {
    mcp = approveGuardedCodegraphForProject({
      squad,
      projectRoot: worktreeRoot,
      // The child's CLAUDE_CONFIG_DIR is now THIS launch dir (agent-launch-
      // profile), so the approval must land where the child will actually read
      // it — not in the shared squad dir the child no longer points at. The
      // explicit env override keeps its precedence for tests and the container.
      configDir: process.env.LA_SUPERVISOR_MCP_CONFIG_DIR ?? configDir,
    });
  } catch (err) {
    mcp = { ok: false, written: false, reason: `mcp-approval-error: ${String(err?.message ?? err).split("\n")[0]}` };
  }
  return { ...readiness, mcp };
}

// The kickoff block the child reads. Rendered here and not inside
// pinnedStatePrologue: the FOC-286 ten-field shape is pinned by
// supervisor-pinned-state.test.mjs and stays fixed; CodeGraph state is a
// separate, additive section. A degraded index must be UNMISSABLE — the child
// is one prompt line away from treating a missing graph answer as absence,
// which is exactly the confidently-wrong failure this whole contract exists to
// prevent — so the fallback is spelled out, not implied.
function codegraphKickoffBlock(codegraph) {
  const lines = ["=== CODEGRAPH (launch readiness) ==="];
  if (codegraph.skipped) {
    lines.push(`status: SKIPPED — ${codegraph.reason}`);
  } else if (codegraph.ok) {
    lines.push(
      `status: ready | index: initialized, freshness proven${codegraph.synced ? " (synced at launch)" : ""}` +
        `${codegraph.version ? ` | CLI ${codegraph.version}` : ""}`,
    );
    lines.push("graph-first: use codegraph_explore (or the guarded CLI) BEFORE grepping — one call replaces a read sweep.");
  } else {
    lines.push(`status: DEGRADED-UNKNOWN — ${codegraph.reason}`);
    lines.push(
      "fallback: Read/Grep are SANCTIONED for structural questions in this run — a missing",
      "graph answer here is UNKNOWN, never absence. The guarded CLI exits 3 UNKNOWN rather",
      "than answer from an unproven index; never read that refusal as 'symbol not found'.",
    );
  }
  if (codegraph.mcp) {
    lines.push(
      codegraph.mcp.ok
        ? `mcp: approved for this worktree (${codegraph.mcp.written ? "written at launch" : "already approved"}) — codegraph_explore is live`
        : `mcp: not approved — ${codegraph.mcp.reason ?? "no guarded codegraph MCP at this target"}; ` +
          "use the guarded CLI: node \"$LA_ROOT/scripts/code-intel.mjs\" <verb> --project-root <this worktree>",
    );
  }
  lines.push("=== END CODEGRAPH ===");
  return lines.join("\n");
}

// ── the launch: an owned config dir per run/child/turn ───────────────────────
// The child no longer points CLAUDE_CONFIG_DIR at the SHARED squad dir. Every
// turn gets its own launch dir (runDir/launch/<child>/turn-<n>), assembled by
// agent-launch-profile.mjs from bounded, known sources: the squad's CLAUDE.md,
// settings.json, agents/ and skills/ — never the shared projects/ history and
// never auth. The tool-profile snapshot (registry revision + resolved tools,
// snapshot.json + mcp.json) lands in the same dir, and the lead's CLI args
// (--tools builtins only, --disallowedTools for the unselected thoughtmap
// tools, --mcp-config for the profile's servers) are recorded so the next
// process runs on the profile that was captured, not whatever is on disk now.
//
// Provider keys are NOT part of this layer: they resolve FRESH per spawn below
// (childProviderEnv) and travel in env only — never persisted into the launch
// dir. The OTel resource identity is attached only when the SUPERVISOR session
// id is present and a valid runtime token (FENIX_SUPERVISOR_SESSION_ID); a
// legacy flow — no session id — gets no telemetry env and behaves exactly as
// before. A half-valid identity is dropped to that same legacy shape, never
// guessed into a valid one.
const launchTurn = 0;
const supervisorSessionId = process.env.FENIX_SUPERVISOR_SESSION_ID || null;
const telemetryContext = (() => {
  if (!supervisorSessionId || !isRuntimeToken(supervisorSessionId)) return null;
  const wanted = {
    taskKey: taskId,
    supervisorSessionId,
    workflowRunId: runId,
    attemptId: attemptIdFor(childId, launchTurn),
    actorId: actorIdFor(runId, childId),
    role: "squadlead",
  };
  const valid = Object.values(wanted).every((value) => isRuntimeToken(value));
  return valid ? wanted : null;
})();
const launch = prepareAgentLaunch({
  squad,
  role: "lead",
  outputDir: launchDirFor(runDir(runId), childId, launchTurn),
  env: process.env,
  context: telemetryContext,
});

const codegraph = prepareCodegraphLaunchReadiness(worktree.worktree, squad, launch.configDir);
codegraph.kickoff = codegraphKickoffBlock(codegraph);

// ── registry entry, written BEFORE the watcher starts ────────────────────────
// Single-writer discipline: spawn owns the entry until the watcher launches,
// and the watcher owns it afterwards. Nothing writes it concurrently.
// (`childId` is decided up top, before the branch name — this attempt's branch
// carries the run:child hash.)

// allowedPaths is a DECLARATION, recorded for audit and for the merge node's
// conflict detection (FOC-160). It is not enforced — nothing stops a child
// writing outside it, exactly as deny-rules are not a sandbox. An empty list
// means "undeclared", not "denied".
const allowedPaths = asArray(args["allowed-path"]);

// FOC-296: two of the prologue's declaration fields, validated above. Recorded
// beside allowedPaths — the same kind of per-child handoff declaration,
// auditable in the record without re-parsing the prologue text. An empty array
// means "not declared", exactly as it does for allowedPaths.
const preAuthorized = asArray(args["pre-authorized"]);
const knownQuirks = asArray(args["known-quirk"]);

// ── P9: the child's deny list, generated per child ───────────────────────────
// The push gate has to hold without the child cooperating, so it is written
// into a settings file rather than into the kickoff prompt. `--settings` loads
// ADDITIONAL settings (claude --help), so this merges with the squad's own
// settings.json from CLAUDE_CONFIG_DIR instead of replacing it.
//
// `--settings` passed to spawn is folded in as a further deny source, never as
// a replacement: a deny-only merge can tighten what a child may do, and cannot
// loosen it. That asymmetry is the point — there must be no flag that hands a
// child the push it is not allowed to have.
const squadSettings = readJsonOr(join(squadConfigDir(squad), "settings.json"), {});
const extraSettings = args.settings ? readJsonOr(args.settings, {}) : {};
const childSettings = childSettingsPath(runId, childId);
atomicWriteJSON(childSettings, buildChildSettings(squadSettings, extraSettings));

// ── the model the child will actually run on (FOC-762/FOC-773) ───────────────
// The child's model is DECIDED here, never inherited: the old logic fell back
// to this process's ANTHROPIC_MODEL — the Supervisor's own model — and run a93f
// (2026-09-12) put dev-1, dev-5, test-9 and test-16 on deepseek-v4.1-flash that
// way while the registry said `model: null`. The precedence lives in
// child-model.mjs: --model > settings overlay routing.<squad>.lead > models.json
// routing for the squad > the provider's defaultModel. A routing change made in
// Settings (FOC-786 AC1) is therefore effective on the next spawn.
//
// The provider environment is resolved FRESH at spawn time for the same reason:
// a provider switch in the overlay must reach the next child without a
// Supervisor restart. Resolution failure refuses the spawn — fail closed, a
// child on a half-resolved provider (right base URL, wrong key, or no key at
// all) is worse than no child.
const providerEnv = childProviderEnv();
if (providerEnv.error) {
  failJson(`provider resolution failed — refusing the spawn: ${providerEnv.error}`, {
    reason: "provider-resolution-failed",
  });
}

const settings = (() => {
  try {
    return readSettings({ path: settingsPath() });
  } catch (err) {
    failJson(`settings overlay is unreadable — refusing the spawn: ${err.message.split("\n")[0]}`, {
      reason: "settings-unreadable",
      settings: settingsPath(),
    });
  }
})();

// Parsed models.json: the routing table and the provider entries (for
// defaultModel). A missing or unreadable file degrades to null — childModelFor
// then falls through to the provider default, exactly as with no routing rows.
const modelsConfig = (() => {
  const path = process.env.LA_PROVIDER_CONFIG || join(ROOT, "config", "models.json");
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
})();

const providerName = providerEnv.LA_PROVIDER ?? null;
// The provider entry for defaultModel: models.json for built-in providers; the
// overlay's custom block when the active provider is not one of them.
const providerEntry =
  modelsConfig?.providers?.[providerName] ??
  (settings?.provider?.custom ? { defaultModel: settings.provider.custom.defaultModel ?? null } : null);

const modelPick = childModelFor({
  squad,
  // Already policy-checked above (FOC-607) — this is the same value, reused.
  explicitModel: requestedModel,
  settings,
  modelsConfig,
  provider: providerName,
  providerEntry,
});
const childModel = modelPick.model;
const modelSource = modelPick.source;
if (modelSource !== "--model") {
  console.error(
    `[spawn] no --model: ${childId} runs on ${childModel ?? "(no model configured)"} ` +
      `(source: ${modelSource ?? "none"}) — set routing.${squad}.lead in the settings overlay or pass --model`,
  );
}

registry.children[childId] = {
  childId,
  squad,
  taskId,
  sessionId: null,
  status: "starting",
  tee: teeRelPath(childId),
  turns: [],
  costUsd: 0,
  telemetryRunId: null,
  // Recorded so supervisor-followup.mjs can resume with the SAME permission
  // mode, settings file and model. A follow-up that silently ran under different
  // permissions than the turn it continues would be a hole in the P9 push gate.
  permissionMode: args["permission-mode"] || "bypassPermissions",
  settings: childSettings,
  model: childModel,
  modelSource,
  // FOC-762/FOC-773: the provider this child was resolved against, so a
  // follow-up turn rebuilds the SAME provider env even after the active
  // provider moved on in the settings overlay — the pinned model must not run
  // on a different provider's endpoint than the turn that started it.
  provider: providerName,
  worktree: worktree.worktree,
  branch: worktree.branch,
  baseRevision: worktree.baseRevision,
  allowedPaths,
  // FOC-296/FOC-357: what the Supervisor declared for THIS child at handoff —
  // the pre-allowed verify commands, known runbook quirks and referenced files
  // rendered into the prologue below (the files verified above). Always
  // present; empty means not declared.
  preAuthorized,
  knownQuirks,
  referencedFiles,
  // FOC-286: what spawn verified before this entry existed. The prologue text
  // the child actually received is patched in below, once telemetry has given
  // the prologue its LA_RUN_ID value — still before the watcher launches, so
  // spawn remains the entry's only writer.
  pinnedStateVerification: pinnedVerification,
  // CodeGraph launch readiness (plan §4): what the index state was decided to
  // be — `ok` or a visible degraded reason plus the kickoff block verbatim, so
  // a later reader can see what the child was told without the temp prompt
  // file, which does not survive the machine.
  codegraph,
  // ── launch identity (task-workspace PRD §7) ────────────────────────────────
  // taskKey/supervisorSessionId/actorId/attemptId/toolProfileRevision/
  // launchConfigDir are the fields followup must PRESERVE (or derive in the
  // same way). actorId is stable for the child's whole life; attemptId is
  // per-turn (`childId:turn:<n>`); supervisorSessionId is null in legacy flows
  // (no valid FENIX_SUPERVISOR_SESSION_ID) and stays null through follow-ups.
  taskKey: taskId,
  supervisorSessionId,
  actorId: actorIdFor(runId, childId),
  attemptId: attemptIdFor(childId, launchTurn),
  toolProfileRevision: launch.profile.revision,
  launchConfigDir: launch.configDir,
  // What THIS launch captured: the CLI args and the profile diff against the
  // prior safe snapshot. Recorded and reported — never an extra approval gate:
  // the user's Settings apply already authorized the next process.
  launch: {
    cliArgs: launch.cliArgs,
    changes: launch.changes,
    profileInitial: launch.profileInitial,
    copied: launch.copied.length,
    skipped: launch.skipped,
    history: launch.history,
  },
};
writeRegistry(runId, registry);

// ── telemetry run ────────────────────────────────────────────────────────────
// Started with cwd = the worktree so the manifest records the child's branch and
// head, not the Supervisor's. run-manifest reads both from process.cwd().
// LA_SUPERVISOR_NO_TELEMETRY is a TEST SEAM: the suite spawns real children
// against a fixture repo, and without it every test run would write manifests
// into .state/runs/ and the central store, polluting real cost reporting.
let telemetryRunId = null;
try {
  if (process.env.LA_SUPERVISOR_NO_TELEMETRY === "1") throw new Error("telemetry disabled");
  const env = { ...process.env, LA_TASK_ID: taskId, CLAUDE_CONFIG_DIR: squadConfigDir(squad) };
  telemetryRunId = execFileSync(
    process.execPath,
    [join(ROOT, "scripts", "run-manifest.mjs"), "gen-id", squad],
    { cwd: worktree.worktree, env, encoding: "utf8" },
  ).trim();
  execFileSync(
    process.execPath,
    // --headless: this child has no console. Without it run-manifest records the
    // pid of THIS spawn process, which exits in seconds, and the dashboard's
    // reconciler closes the run on "console pid gone" while the child works on.
    [join(ROOT, "scripts", "run-manifest.mjs"), "start", telemetryRunId, squad, "--headless"],
    { cwd: worktree.worktree, env, stdio: "ignore" },
  );
  // Two tags, two questions the dashboard has to answer about a child run:
  // which issue it belongs to, and which Supervisor session put it there.
  // Without the second one a child run looks like it started itself.
  for (const tag of [taskId, `sup:${runId}`]) {
    execFileSync(
      process.execPath,
      [join(ROOT, "scripts", "run-manifest.mjs"), "tag", telemetryRunId, tag],
      { cwd: worktree.worktree, env, stdio: "ignore" },
    );
  }
  updateChild(runId, childId, { telemetryRunId });
} catch {
  // Telemetry is observability, not control flow. A child that runs unrecorded
  // is bad; a child that refuses to start because the ledger hiccuped is worse.
  telemetryRunId = null;
}

// ── launch the watcher ───────────────────────────────────────────────────────
// The prompt goes through a file rather than argv: kickoffs are multi-line and
// carry quotes, and Windows argv quoting mangles both.
const promptDir = mkdtempSync(join(tmpdir(), "la-supervisor-"));
const promptFile = join(promptDir, "prompt.txt");
// FOC-286: the pinned-state prologue is prepended to the kickoff itself, so
// every squad receives it without kickoff authors repeating it. Both entry
// paths meet here — the inline --prompt and the caller's --prompt-file, whose
// content was read and verified above — and the combined text goes into the
// spawn-owned temp file. The caller's file is never rewritten, and the watcher
// always receives THAT path, absolute by construction.
// The three declaration fields come from --pre-authorized/--known-quirk
// (FOC-296) and --referenced-file (FOC-357); absent flags render the honest
// "(none)" placeholders.
const prologue = pinnedStatePrologue({
  repo: gitRoot,
  laRoot: process.env.LA_ROOT || null,
  worktree: worktree.worktree,
  branch: worktree.branch,
  baseRevision: worktree.baseRevision,
  cleanAtSpawn: pinnedVerification.cleanAtSpawn,
  dirtyPaths: pinnedVerification.dirtyPaths,
  task: taskId,
  runId,
  childId,
  laRunId: telemetryRunId,
  verification: pinnedVerification,
  preAuthorized,
  knownQuirks,
  referencedFiles,
});
// The CodeGraph block rides the same prompt file, AFTER the pinned-state
// prologue — a separate section, so the FOC-286 ten-field shape stays fixed.
// The turn-end contract (FOC-522) rides the same way: one more separate
// section, so every kickoff tells the child that a background task must never
// outlive the turn — without kickoff authors repeating the rule by hand.
writeFileSync(promptFile, `${prologue}\n\n${codegraph.kickoff}\n\n${TURN_END_CONTRACT}\n\n${kickoff}`, "utf8");
// The registry entry recorded what was verified; now it can also say WHAT THE
// CHILD WAS TOLD — the prologue verbatim. Patched while spawn still owns the
// entry (the watcher has not launched), so the single-writer discipline holds.
updateChild(runId, childId, { pinnedStateVerification: { ...pinnedVerification, prologue } });

const watcherArgs = [
  join(ROOT, "scripts", "supervisor-watch.mjs"),
  "--run", runId,
  "--child", childId,
  "--cwd", worktree.worktree,
  "--turn", "0",
  "--prompt-file", promptFile,
  "--permission-mode", args["permission-mode"] || "bypassPermissions",
  // Unconditional: a child without the generated deny list is a child that
  // can push. There is no branch here on purpose.
  "--settings", childSettings,
];
if (args.model) watcherArgs.push("--model", args.model);
if (telemetryRunId) watcherArgs.push("--telemetry-run", telemetryRunId);
// The launch profile's CLI args (--tools / --disallowedTools / --mcp-config),
// JSON-encoded as one flag. The watcher owns the claude command line; until it
// consumes this channel the args stay recorded in the registry entry and the
// launch result, so the captured profile is never lost.
watcherArgs.push("--claude-args", JSON.stringify(launch.cliArgs));

const childEnv = {
  ...process.env,
  // FOC-762/FOC-773: the FRESH provider resolution (base URL, auth var, the
  // inactive auth var cleared, tier vars, LA_PROVIDER). Spread BEFORE the
  // overrides below so a provider change in the settings overlay is effective
  // on this very spawn, while RUN_ID/LA_SUPERVISOR_* keep the last word.
  ...providerEnv,
  // FOC-762: the model chosen above rides ANTHROPIC_MODEL — the same channel
  // the old (removed) Supervisor inheritance used — so the child actually runs
  // on the routing decision, not just records it. Followup already replays
  // entry.model as --model, so resumed turns stay pinned to it.
  ...(childModel ? { ANTHROPIC_MODEL: childModel } : {}),
  // FOC-522: the finite background-wait ceiling. The CLI default (600 s) sits
  // below our full suite, and turn teardown kills whatever is still running —
  // see the rationale at PRINT_BG_WAIT_CEILING_MS in supervisor-lib.mjs. Built
  // through the helper so the value has exactly one source.
  ...printBgWaitCeilingEnv(),
  // The launch-owned config dir assembled above — this child's own copy of the
  // squad sources plus this turn's tool-profile snapshot — no longer the
  // shared squad dir.
  CLAUDE_CONFIG_DIR: launch.configDir,
  // The launch env: the thoughtmap MCP server env (URLs and paths only) plus,
  // when a valid supervisor session id was present, the OTel resource identity.
  ...launch.env,
  FENIX_STAGE: squad,
  FENIX_DEPENDS_ON_ATTEMPTS: JSON.stringify(dependencyAttempts),
  FENIX_RUNTIME_RETURN: "",
  LA_SUPERVISOR: "1",
  LA_SUPERVISOR_RUN: runId,
  LA_SUPERVISOR_CHILD: childId,
  LA_TASK_ID: taskId,
  // The child inherits the Supervisor's environment, and bin/supervisor.bat sets
  // RUN_ID/LA_RUN_ID to the SUPERVISOR's telemetry run. telemetry-hook.mjs reads
  // exactly those on SessionStart, so without this override the child's session,
  // its tokens and its cost were all recorded against the Supervisor's run —
  // observed 2026-08-27: 54 usage rows and 565k tokens on the parent while the
  // child's own run showed 0 tokens, no model, and a `transcript_missing` issue.
  //
  // LA_SUPERVISOR_RUN stays the Supervisor's: that one addresses the gate and
  // registry directory, which genuinely belong to the parent. Two different
  // ideas that were sharing one value by accident.
  //
  // Empty string, not "leave it inherited", when telemetry failed to start. The
  // conditional this replaces looked harmless and was not: the fallback for a
  // null telemetryRunId was the SUPERVISOR's own RUN_ID, so a hiccup in the
  // block above quietly turned into the parent being billed for the child.
  RUN_ID: telemetryRunId || "",
  LA_RUN_ID: telemetryRunId || "",
};

const watcher = spawn(process.execPath, watcherArgs, {
  cwd: worktree.worktree,
  env: childEnv,
  detached: true,
  stdio: "ignore",
  // win32 gives a detached process its own console unless told otherwise, and
  // that is the empty "claude" window that appeared next to the Supervisor.
  // Children are headless by contract (ADR-0009): a window is not just noise,
  // it invites someone to type into a session nobody is reading.
  windowsHide: true,
});
watcher.unref();

// ── wait for system/init ─────────────────────────────────────────────────────
// The session_id is the child's durable identity — without it there is no
// --resume, so a child we cannot identify is worse than no child at all.
const deadline = Date.now() + INIT_TIMEOUT_MS;
let entry = null;

while (Date.now() < deadline) {
  await sleep(150);
  entry = readRegistry(runId).children[childId];
  if (entry?.sessionId) break;
  if (entry && TERMINAL_STATUSES.includes(entry.status)) break;
}

if (!entry?.sessionId) {
  const pid = entry?.turns?.[0]?.pid;
  killTree(pid, "force");
  updateChild(runId, childId, {
    status: "crashed",
    endedAt: new Date().toISOString(),
    error: `no system/init within ${INIT_TIMEOUT_MS} ms`,
  });
  failJson(`child ${childId} produced no system/init within ${INIT_TIMEOUT_MS} ms — not resumable, killed`, {
    childId,
    tee: teeAbsPath(runId, childId),
    worktree: worktree.worktree,
  });
}

// ── auto-focus (FOC-769) ─────────────────────────────────────────────────────
// The Supervisor is acting on THIS ticket at this moment, so the successful
// spawn declares the focus for it (source "spawn"); an explicit `set` holds
// until the next spawn/followup. The declaration never fails the spawn — a
// focus failure is observability, and a child that did start must not be
// reported as one that did not, so a setFocus error lands in `focusError`
// beside the result. Skipped silently when the task is not a ticket shape or
// the run id is not a run id: those are shapes cost cannot be attributed to,
// not errors to escalate. (Same block lives in supervisor-followup.mjs — the
// helper home, supervisor-lib.mjs, is not this slice's file.)
let focus = null;
let focusError = null;
if (RUN_ID_RE.test(String(runId))) {
  const wanted = (() => {
    try {
      return normalizeFocus(taskId);
    } catch {
      return null; // not a ticket — nothing to attribute, skip silently
    }
  })();
  if (wanted) {
    try {
      const res = setFocus({ runId, value: taskId, source: "spawn" });
      focus = { changed: res.changed, taskId: res.focus.taskId };
    } catch (err) {
      focusError = `focus: ${err.message}`;
    }
  }
}

console.log(
  JSON.stringify(
    {
      ok: true,
      childId,
      sessionId: entry.sessionId,
      pid: entry.pid ?? entry.turns?.[0]?.pid ?? null,
      tee: teeRelPath(childId),
      status: entry.status,
      worktree: worktree.worktree,
      // Reported so the Supervisor can SAY which repo it put the child in, and
      // Mateusz can catch a wrong one at spawn time rather than from a child
      // that reports the code missing twenty minutes later.
      repo: gitRoot,
      repoFrom,
      branch: worktree.branch,
      baseRevision: worktree.baseRevision,
      worktreeCreated: worktree.created,
      allowedPaths,
      // FOC-296/FOC-357: reported beside allowedPaths so the Supervisor can say
      // what it declared for this child without re-reading the prologue text.
      preAuthorized,
      knownQuirks,
      referencedFiles,
      settings: childSettings,
      deny: buildChildSettings(squadSettings, extraSettings).permissions.deny,
      model: childModel,
      modelSource,
      telemetryRunId,
      // FOC-286: reported alongside the facts so the Supervisor can say, at
      // spawn time, not just where the child is but that the state it was
      // handed was checked before it existed.
      pinnedStateVerification: { ...pinnedVerification, prologue },
      // CodeGraph launch readiness: the Supervisor can say at spawn time which
      // navigation path the child actually has — ready, degraded (Read/Grep
      // sanctioned) or skipped — instead of the child discovering it mid-turn.
      codegraph,
      // The launch record: where this turn's config dir lives, what CLI args
      // and tool-profile revision it captured, and the diff against the prior
      // safe snapshot. Metadata for the log, not a gate — the user's Settings
      // apply already authorized the next process.
      launch: {
        configDir: launch.configDir,
        cliArgs: launch.cliArgs,
        toolProfileRevision: launch.profile.revision,
        changes: launch.changes,
        profileInitial: launch.profileInitial,
      },
      // FOC-769: the focus this spawn declared (absent when skipped as not a
      // ticket / not a run id), and the focus failure that did NOT fail the
      // spawn, if there was one.
      ...(focus ? { focus } : {}),
      ...(focusError ? { focusError } : {}),
    },
    null,
    2,
  ),
);
