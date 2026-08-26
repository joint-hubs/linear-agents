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
  assertStageBudget,
  assertWithinBudget,
  comparableProgress,
  failJson,
  gatePath,
  parseArgs,
  readRegistry,
  roundsFor,
  teeRelPath,
  updateChild,
  writeRegistry,
} from "./supervisor-lib.mjs";
import { loadGraph } from "./graph-validate.mjs";

// FOC-163 removed the dev↔review round cap. It was `LA_SUPERVISOR_MAX_LOOPS`,
// default 2, and it counted: it stopped a run that was converging at the same
// number as one that was going in circles, because a counter cannot tell them
// apart. What stops a loop now is the PROGRESS FINGERPRINT — see the guard
// below. No counter remains; an unused one would be worse than none, because
// the next reader would take it for the live control.

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

// ── guard: the spend cap ─────────────────────────────────────────────────────
// Same gate as spawn: a follow-up is a new turn, and a cap enforced only on
// first spawn would be a cap on one turn rather than on the run.
assertWithinBudget(runId);

// Same ordering as spawn: a follow-up is a new turn, and a stage that has spent
// its allocation must not keep spending just because the child already exists.
assertStageBudget(runId, entry.squad, { graph: (() => {
  try {
    return loadGraph();
  } catch {
    return null;
  }
})() });

// ── guard: progress, not rounds (FOC-163) ────────────────────────────────────
// A round is progress when the WORK changed. Two rounds with the same diff and
// the same failing tests are not two attempts — they are one attempt billed
// twice, and spawning a third would buy the same result a third time.
let progress = null;
if (args["review-loop"]) {
  const rounds = roundsFor(runId, entry.taskId);

  // Without a recorded verdict there is nothing to loop ON: no findings to hand
  // back, and no fingerprint to compare. This also closes the obvious bypass —
  // a Supervisor that never records a verdict would otherwise loop forever,
  // exactly the freedom the old counter existed to remove.
  if (!rounds.length) {
    failJson(
      `no REVIEW verdict recorded for ${entry.taskId} — there is nothing to send back to DEV`,
      {
        taskId: entry.taskId,
        hint: `record it first: node scripts/supervisor-verdict.mjs record --child <reviewChild> --verdict fail --finding '{"text":"...","evidence":"..."}'`,
      },
    );
  }

  const last = rounds[rounds.length - 1];
  const prev = rounds.length > 1 ? rounds[rounds.length - 2] : null;
  const repeated = comparableProgress(last?.fingerprint, prev?.fingerprint);

  if (repeated === true) {
    failJson(
      `round ${last.round} of ${entry.taskId} reproduced round ${prev.round}: same diff, same failing tests — ` +
        `another identical round is budget, not progress`,
      {
        taskId: entry.taskId,
        fingerprints: { previous: prev.fingerprint, latest: last.fingerprint },
        failingTests: last.fingerprint?.failingTests ?? [],
        hint:
          "change strategy before resuming: a different role or model, a restored checkpoint, or " +
          "escalate to Mateusz with both fingerprints shown. Re-running the same one is the thing " +
          "this guard exists to stop.",
      },
    );
  }

  // `null` means one of the two fingerprints could not be read. That is UNKNOWN,
  // and unknown must not block: escalating because we failed to LOOK is a worse
  // failure than one extra round. Said out loud instead of silently allowed.
  if (repeated === null && prev) {
    console.error(
      `[followup] progress is UNKNOWN for ${entry.taskId} (a fingerprint could not be read) — allowing the round`,
    );
  }

  progress = {
    rounds: rounds.length,
    latest: last.fingerprint?.combined ?? null,
    previous: prev?.fingerprint?.combined ?? null,
    repeated,
  };
  registry.rounds = { ...(registry.rounds || {}), [entry.taskId]: progress };
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
      // What replaced the counter. `repeated: null` is UNKNOWN, not "fine" —
      // whoever reads this next has to be able to tell those apart.
      progress,
    },
    null,
    2,
  ),
);
