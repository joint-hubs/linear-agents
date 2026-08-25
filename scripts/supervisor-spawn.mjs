// scripts/supervisor-spawn.mjs — start one squad child, in its own worktree.
//
//   node scripts/supervisor-spawn.mjs --squad <plan|dev|review|test> --task <issueId>
//       --prompt "<kickoff>" [--run <supervisorRunId>] [--child <id>]
//       [--permission-mode <mode>] [--model <id>] [--settings <path>]
//       [--repo <path>] [--slug <text>] [--allowed-path <p> ...]
//
// Returns as soon as the child's session_id is known; the child keeps running
// under a detached watcher (supervisor-watch.mjs), which owns liveness.
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
import {
  INIT_TIMEOUT_MS,
  MAX_LIVE_CHILDREN_PER_RUN,
  ROOT,
  asArray,
  ensureRunDir,
  ensureWorktree,
  failJson,
  killTree,
  liveChildren,
  parseArgs,
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

// ── worktree ─────────────────────────────────────────────────────────────────
// Every child gets its own checkout (ADR-0009 amended 2026-08-25). A shared
// working tree under two children is the failure observed twice on this repo:
// agents committing each other's changes, and a branch switched under a live run.
const gitRoot = resolveGitRoot(args.repo || ROOT);
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
  settings: args.settings || null,
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
];
if (args.settings) watcherArgs.push("--settings", args.settings);
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
  if (entry && ["crashed", "exited", "stopped"].includes(entry.status)) break;
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
      telemetryRunId,
    },
    null,
    2,
  ),
);
