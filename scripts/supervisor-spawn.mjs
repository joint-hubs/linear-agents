// scripts/supervisor-spawn.mjs — start one squad child, in its own worktree.
//
//   node scripts/supervisor-spawn.mjs --squad <plan|dev|review|test> --task <issueId>
//       --prompt "<kickoff>" [--run <supervisorRunId>] [--child <id>]
//       [--permission-mode <mode>] [--model <id>] [--settings <extra-deny.json>]
//       [--repo <path>] [--slug <text>] [--allowed-path <p> ...]
//   node scripts/supervisor-spawn.mjs --release [--run <supervisorRunId>]
//
// Returns as soon as the child's session_id is known; the child keeps running
// under a detached watcher (supervisor-watch.mjs), which owns liveness.
//
// Every child is launched with a GENERATED child-settings.json carrying the P9
// deny list (§1.7). `--settings` here does not replace it — the file it names is
// folded in as one more deny source, so the flag can only tighten.
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
  killTree,
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

let worktree;
try {
  worktree = ensureWorktree(gitRoot, branch);
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

// ── registry entry, written BEFORE the watcher starts ────────────────────────
// Single-writer discipline: spawn owns the entry until the watcher launches,
// and the watcher owns it afterwards. Nothing writes it concurrently.
const childId = args.child || `${squad}-${Object.keys(registry.children).length + 1}`;

// allowedPaths is a DECLARATION, recorded for audit and for the merge node's
// conflict detection (FOC-160). It is not enforced — nothing stops a child
// writing outside it, exactly as deny-rules are not a sandbox. An empty list
// means "undeclared", not "denied".
const allowedPaths = asArray(args["allowed-path"]);

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
  model: args.model || null,
  worktree: worktree.worktree,
  branch: worktree.branch,
  baseRevision: worktree.baseRevision,
  allowedPaths,
  // FOC-286: what spawn verified before this entry existed. The prologue text
  // the child actually received is patched in below, once telemetry has given
  // the prologue its LA_RUN_ID value — still before the watcher launches, so
  // spawn remains the entry's only writer.
  pinnedStateVerification: pinnedVerification,
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
});
writeFileSync(promptFile, `${prologue}\n\n${kickoff}`, "utf8");
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
      settings: childSettings,
      deny: buildChildSettings(squadSettings, extraSettings).permissions.deny,
      telemetryRunId,
      // FOC-286: reported alongside the facts so the Supervisor can say, at
      // spawn time, not just where the child is but that the state it was
      // handed was checked before it existed.
      pinnedStateVerification: { ...pinnedVerification, prologue },
    },
    null,
    2,
  ),
);
