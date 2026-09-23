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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { buildBranchName } from "./dev-branch.mjs";
import { ensureCodegraphReady } from "./codegraph-runtime.mjs";
import { approveGuardedCodegraphForProject } from "./mcp-enable.mjs";
import { atomicWriteJSON } from "./utils.mjs";
import {
  INIT_TIMEOUT_MS,
  admissionCheck,
  heldDir,
  heldPath,
  ROOT,
  TERMINAL_STATUSES,
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
  readHeld,
  parseArgs,
  pinnedStatePrologue,
  readJsonOr,
  readRegistry,
  resolveGitRoot,
  teeAbsPath,
  teeRelPath,
  triagePath,
  updateChild,
  verifyPinnedState,
  writeRegistry,
} from "./supervisor-lib.mjs";
import { loadGraph } from "./graph-validate.mjs";

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
const branch = buildBranchName(taskId, args.slug || squad, undefined);

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
  worktree = ensureWorktree(gitRoot, branch, candidateSha);
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

function prepareCodegraphLaunchReadiness(worktreeRoot, squad) {
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
      ...(process.env.LA_SUPERVISOR_MCP_CONFIG_DIR
        ? { configDir: process.env.LA_SUPERVISOR_MCP_CONFIG_DIR }
        : {}),
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

const codegraph = prepareCodegraphLaunchReadiness(worktree.worktree, squad);
codegraph.kickoff = codegraphKickoffBlock(codegraph);

// ── registry entry, written BEFORE the watcher starts ────────────────────────
// Single-writer discipline: spawn owns the entry until the watcher launches,
// and the watcher owns it afterwards. Nothing writes it concurrently.
const childId = args.child || `${squad}-${Object.keys(registry.children).length + 1}`;

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
const squadSettings = readJsonOr(join(ROOT, "agents", squad, "settings.json"), {});
const extraSettings = args.settings ? readJsonOr(args.settings, {}) : {};
const childSettings = childSettingsPath(runId, childId);
atomicWriteJSON(childSettings, buildChildSettings(squadSettings, extraSettings));

// ── the model the child will actually run on ─────────────────────────────────
// Without --model the child does not run on "no model": claude inherits
// ANTHROPIC_MODEL from this process, and bin/supervisor.bat sets that to the
// SUPERVISOR's own model. Run a93f (2026-09-12) put dev-1, dev-5, test-9 and
// test-16 on deepseek-v4.1-flash that way while the registry said `model: null`
// and the squads are routed to glm-5.3-flash. Recording the inherited id keeps
// the registry truthful, and pins resumed turns to it — followup replays
// entry.model, so a Supervisor restarted on a different model can no longer
// silently switch a half-finished child.
const inheritedModel = process.env.ANTHROPIC_MODEL || null;
const childModel = args.model && args.model !== true ? String(args.model) : inheritedModel;
const modelSource = args.model && args.model !== true ? "--model" : inheritedModel ? "inherited:ANTHROPIC_MODEL" : null;
if (modelSource !== "--model") {
  console.error(
    `[spawn] no --model: ${childId} inherits ANTHROPIC_MODEL=${inheritedModel ?? "(unset)"} from the Supervisor's ` +
      `environment — pass --model to choose the squad's model explicitly`,
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
  const env = { ...process.env, LA_TASK_ID: taskId, CLAUDE_CONFIG_DIR: join(ROOT, "agents", squad) };
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
writeFileSync(promptFile, `${prologue}\n\n${codegraph.kickoff}\n\n${kickoff}`, "utf8");
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

const childEnv = {
  ...process.env,
  CLAUDE_CONFIG_DIR: join(ROOT, "agents", squad),
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
    },
    null,
    2,
  ),
);
