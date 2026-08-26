// scripts/supervisor-followup.mjs — continue a child's session with one more turn.
//
//   node scripts/supervisor-followup.mjs --child <childId> [--run <runId>]
//       --prompt "<message>" [--gate <gateId>] [--review-loop]
//
// Steering happens at turn boundaries, not mid-turn: `claude -p` runs to
// completion, and the session_id captured at spawn is what makes the next turn a
// continuation rather than a fresh context. One process per turn, one watcher per
// process.
//
// The follow-up reuses the permission mode, settings file and model recorded at
// spawn. Resuming under different permissions than the turn being continued
// would be a hole in the push gate, so those are read from the registry rather
// than passed in again.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ROOT,
  failJson,
  gatePath,
  parseArgs,
  readRegistry,
  teeRelPath,
  updateChild,
  writeRegistry,
} from "./supervisor-lib.mjs";

// The dev↔review ping-pong cap. Enforced HERE, in tooling, rather than only in
// the lead's prompt — a cap a model can talk itself past is not a cap.
//
// It counts rounds, which is the weakness FOC-163 fixes: two rounds that
// reproduce the same failure are not progress, and a run that IS converging gets
// cut off at the same number. FOC-163 replaces this counter with a diff +
// failing-test fingerprint; when it lands, this constant goes.
const MAX_REVIEW_LOOPS = Number(process.env.LA_SUPERVISOR_MAX_LOOPS ?? 2);

const args = parseArgs(process.argv.slice(2));
const childId = args.child;
const runId = args.run || process.env.LA_SUPERVISOR_RUN;

if (!childId) failJson("--child <childId> is required");
if (!runId) failJson("--run <runId> is required (or set LA_SUPERVISOR_RUN)");
if (!args.prompt && !args["prompt-file"]) failJson("--prompt or --prompt-file is required");

const registry = readRegistry(runId);
const entry = registry.children[childId];
if (!entry) failJson(`no child "${childId}" in run ${runId}`, { known: Object.keys(registry.children) });

// ── guard: one turn at a time ────────────────────────────────────────────────
// --resume targets a session whose turn has ENDED. Firing a second `-p` at a
// live session does not steer it; it starts a competing turn against the same
// session id and the two interleave.
if (entry.status === "running" || entry.status === "starting") {
  failJson(
    `child ${childId} still has a turn in flight (status ${entry.status}) — resume targets an ended turn`,
    { childId, status: entry.status },
  );
}

if (!entry.sessionId) {
  failJson(`child ${childId} has no sessionId — nothing to resume`, { status: entry.status });
}

// ── guard: a gate is answered before it is delivered ─────────────────────────
// `--gate` used to be audit-only, which left two ways to break the record.
// Deliver without recording, and the gate file sits `pending` forever: the
// child is unblocked but `status` still shows an open question and the child
// reads as `waiting_gate`. Deliver a gate that does not exist, and the audit
// trail points at nothing. Both are silent.
//
// The file is the source of truth (§2.6), so the file has to be right BEFORE
// the answer travels. Order: supervisor-gate.mjs answer → this.
if (args.gate && args.gate !== true) {
  const gate = (() => {
    const path = gatePath(runId, args.gate);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      failJson(`gate ${args.gate} is not readable JSON: ${err.message}`, { path });
    }
  })();

  if (!gate) failJson(`gate ${args.gate} does not exist in run ${runId}`);
  if (gate.childId !== childId) {
    failJson(
      `gate ${args.gate} belongs to child ${gate.childId}, not ${childId} — delivering it here would answer the wrong question`,
    );
  }
  if (gate.status !== "answered") {
    failJson(
      `gate ${args.gate} is still ${gate.status} — record the answer first: ` +
        `node scripts/supervisor-gate.mjs answer --gate ${args.gate} --text "..."`,
      { hint: "the gate file is the record; this turn only delivers what the record already says" },
    );
  }
}

// ── guard: review-loop cap ───────────────────────────────────────────────────
let reviewLoopCount = registry.reviewLoopCount || {};
if (args["review-loop"]) {
  const current = reviewLoopCount[entry.taskId] ?? 0;
  if (current + 1 > MAX_REVIEW_LOOPS) {
    failJson(
      `review loop cap reached for ${entry.taskId}: ${current} of ${MAX_REVIEW_LOOPS} used — escalate instead of resuming`,
      { taskId: entry.taskId, reviewLoopCount: current, max: MAX_REVIEW_LOOPS },
    );
  }
  reviewLoopCount = { ...reviewLoopCount, [entry.taskId]: current + 1 };
  registry.reviewLoopCount = reviewLoopCount;
  writeRegistry(runId, registry);
}

// ── new turn ─────────────────────────────────────────────────────────────────
const turns = entry.turns || [];
const turnIndex = turns.length;

updateChild(runId, childId, {
  status: "starting",
  endedAt: null,
  exitCode: null,
  turns: [
    ...turns,
    {
      pid: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      exitCode: null,
      // Audit only: which gate answer this turn carries, and whether it was a
      // fix-after-review loop. Neither changes resume semantics.
      gateId: args.gate || null,
      reviewLoop: Boolean(args["review-loop"]),
    },
  ],
});

const promptDir = mkdtempSync(join(tmpdir(), "la-supervisor-"));
const promptFile = join(promptDir, "prompt.txt");
writeFileSync(promptFile, args["prompt-file"] ? "" : String(args.prompt), "utf8");

const watcherArgs = [
  join(ROOT, "scripts", "supervisor-watch.mjs"),
  "--run", runId,
  "--child", childId,
  "--cwd", entry.worktree,
  "--turn", String(turnIndex),
  "--prompt-file", args["prompt-file"] || promptFile,
  "--permission-mode", entry.permissionMode || "bypassPermissions",
  "--session", entry.sessionId,
];
if (entry.settings) watcherArgs.push("--settings", entry.settings);
if (entry.model) watcherArgs.push("--model", entry.model);
if (entry.telemetryRunId) watcherArgs.push("--telemetry-run", entry.telemetryRunId);

const watcher = spawn(process.execPath, watcherArgs, {
  cwd: entry.worktree,
  env: {
    ...process.env,
    CLAUDE_CONFIG_DIR: join(ROOT, "agents", entry.squad),
    LA_SUPERVISOR: "1",
    LA_SUPERVISOR_RUN: runId,
    LA_SUPERVISOR_CHILD: childId,
    LA_TASK_ID: entry.taskId,
  },
  detached: true,
  stdio: "ignore",
});
watcher.unref();

// Unlike spawn, there is no wait for system/init: the session already exists and
// its id cannot change on resume. The caller polls supervisor-status.mjs.
console.log(
  JSON.stringify(
    {
      ok: true,
      childId,
      sessionId: entry.sessionId,
      status: "running",
      turn: turnIndex,
      tee: teeRelPath(childId),
      gateId: args.gate || null,
      reviewLoop: Boolean(args["review-loop"]),
      reviewLoopCount: reviewLoopCount[entry.taskId] ?? 0,
    },
    null,
    2,
  ),
);
