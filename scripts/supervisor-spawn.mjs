// scripts/supervisor-spawn.mjs — start one squad child, in its own worktree.
//
//   node scripts/supervisor-spawn.mjs --squad <plan|dev|review|test> --task <issueId>
//       --prompt "<kickoff>" [--run <supervisorRunId>] [--child <id>]
//       [--permission-mode <mode>] [--model <id>] [--settings <extra-deny.json>]
//       [--repo <path>] [--slug <text>] [--allowed-path <p> ...]
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
//   · another child is still live in this run (policy, see MAX_LIVE_CHILDREN_PER_RUN)
//   · no system/init arrives within 30 s (a child with no session_id is not resumable)

import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildBranchName } from "./dev-branch.mjs";
import { atomicWriteJSON } from "./utils.mjs";
import {
  INIT_TIMEOUT_MS,
  MAX_LIVE_CHILDREN_PER_RUN,
  ROOT,
  TERMINAL_STATUSES,
  asArray,
  assertWithinBudget,
  buildChildSettings,
  childSettingsPath,
  ensureRunDir,
  ensureWorktree,
  failJson,
  killTree,
  liveChildren,
  parseArgs,
  readJsonOr,
  readRegistry,
  resolveGitRoot,
  teeAbsPath,
  teeRelPath,
  triagePath,
  updateChild,
  writeRegistry,
} from "./supervisor-lib.mjs";

const SQUADS = ["plan", "dev", "review", "test"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = parseArgs(process.argv.slice(2));

const squad = args.squad;
const taskId = args.task;
const runId = args.run || process.env.LA_SUPERVISOR_RUN;

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

// ── fail-closed: one live child ──────────────────────────────────────────────
const live = liveChildren(registry);
if (live.length >= MAX_LIVE_CHILDREN_PER_RUN) {
  failJson(
    `${live.length} child(ren) already live in this run; the policy limit is ${MAX_LIVE_CHILDREN_PER_RUN}. ` +
      `This is a policy guard, not a worktree collision — each child has its own checkout. ` +
      `FOC-161 (concurrency semaphore + backpressure) is the task that lifts it.`,
    { live: live.map((c) => ({ childId: c.childId, taskId: c.taskId, status: c.status })) },
  );
}

// ── fail-closed: the spend cap ───────────────────────────────────────────────
// A turn boundary is the only place this can be checked, so the cap is post-hoc
// by construction: the turn already running may overshoot it. That is stated
// rather than hidden. Unset means no cap and no behaviour change.
assertWithinBudget(runId);

// ── worktree ─────────────────────────────────────────────────────────────────
// Every child gets its own checkout (ADR-0009 amended 2026-08-25). A shared
// working tree under two children is the failure observed twice on this repo:
// agents committing each other's changes, and a branch switched under a live run.
// Wrapped: git exits non-zero on a path that is not a repo, and an unwrapped
// throw here printed a stack trace instead of the JSON every other failure path
// returns — the Supervisor reads stdout, so that failure was invisible to it.
let gitRoot;
try {
  gitRoot = resolveGitRoot(args.repo || ROOT);
} catch (err) {
  failJson(`--repo ${args.repo || ROOT} is not inside a git repository: ${err.message.split("\n")[0]}`);
}
const branch = buildBranchName(taskId, args.slug || squad, undefined);

let worktree;
try {
  worktree = ensureWorktree(gitRoot, branch);
} catch (err) {
  failJson(`could not prepare a worktree for ${branch}: ${err.message}`, { gitRoot });
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
    [join(ROOT, "scripts", "run-manifest.mjs"), "start", telemetryRunId, squad],
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
writeFileSync(promptFile, args["prompt-file"] ? "" : String(args.prompt), "utf8");

const watcherArgs = [
  join(ROOT, "scripts", "supervisor-watch.mjs"),
  "--run", runId,
  "--child", childId,
  "--cwd", worktree.worktree,
  "--turn", "0",
  "--prompt-file", args["prompt-file"] || promptFile,
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
};

const watcher = spawn(process.execPath, watcherArgs, {
  cwd: worktree.worktree,
  env: childEnv,
  detached: true,
  stdio: "ignore",
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
      branch: worktree.branch,
      baseRevision: worktree.baseRevision,
      worktreeCreated: worktree.created,
      allowedPaths,
      settings: childSettings,
      deny: buildChildSettings(squadSettings, extraSettings).permissions.deny,
      telemetryRunId,
    },
    null,
    2,
  ),
);
