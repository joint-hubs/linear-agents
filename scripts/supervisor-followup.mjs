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

import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { squadConfigDir } from "./fenix-paths.mjs";
import { childProviderEnv } from "./child-model.mjs";
import {
  actorIdFor,
  attemptIdFor,
  launchDirFor,
  prepareAgentLaunch,
} from "./agent-launch-profile.mjs";
import { isRuntimeToken } from "./runtime-events.mjs";
import { approveGuardedCodegraphForProject } from "./mcp-enable.mjs";

import {
  INIT_TIMEOUT_MS,
  ROOT,
  TERMINAL_STATUSES,
  TURN_END_CONTRACT,
  assertStageBudget,
  assertWithinBudget,
  comparableProgress,
  failJson,
  gatePath,
  killTree,
  parseArgs,
  printBgWaitCeilingEnv,
  readRegistry,
  roundsFor,
  runDir,
  teeAbsPath,
  teeRelPath,
  updateChild,
  writeRegistry,
} from "./supervisor-lib.mjs";
import { loadGraph } from "./graph-validate.mjs";
import { normalizeFocus, setFocus } from "./supervisor-focus.mjs";
import { RUN_ID_RE } from "./supervisor-current-run.mjs";

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

// ── the prompt is read HERE, against the caller's cwd ────────────────────────
// The watcher runs with the child's worktree as its cwd. It used to receive
// --prompt-file unresolved, so a relative path — the natural `.state/x.md` —
// was read inside the worktree, where the gitignored .state/ does not exist.
// The watcher died before claude started and the caller saw only "no
// system/init within 30000 ms". Run a93f (2026-09-12) lost four resumes this
// way (review-2, dev-5, test-7, dev-10) while the two `--prompt "$(cat …)"`
// resumes worked, and the Supervisor concluded that --resume itself was dead.
// supervisor-spawn.mjs fixed the identical defect on turn 0 and this file never
// got it: the fourth guard in this pair to drift apart. Read before any
// registry write, so a bad path is refused while refusal is still free.
let promptText = String(args.prompt ?? "");
if (args["prompt-file"] && args["prompt-file"] !== true) {
  const callerPromptPath = resolve(args["prompt-file"]);
  try {
    promptText = readFileSync(callerPromptPath, "utf8");
  } catch (err) {
    failJson(
      `--prompt-file is not readable (resolved: ${callerPromptPath}): ${err.message.split("\n")[0]} — no turn was started`,
      { childId, path: callerPromptPath },
    );
  }
}

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

  // ── incident catcher (FOC-284 rounds 2–3) ────────────────────────────────
  // A FAIL round is only a real return when the flag + In Progress actually
  // landed on the issue. Four shapes say they may NOT have, and the round-1
  // incident is exactly one of them: the Supervisor recorded a fail verdict
  // with the BASE supervisor-verdict.mjs — no apply code, no warning, the
  // flag hand-applied, the verdict record carrying no `linearEffects` at all.
  //   (a) NO linearEffects → a pre-FOC-284 tool wrote the record: whether the
  //       return landed is UNKNOWN, never assume it did.
  //   (b) label.status "failed" → the audit exists and says the stamp did not
  //       land (the enforcement gate may also exist; this is the belt to it).
  //   (c) any op "pending" (round 3, R2-3) → the record was written but the
  //       outcome was never amended — the crash window between the pending
  //       write and the amend. The state is genuinely UNKNOWN: either nothing
  //       was applied, or Linear WAS mutated while the record-time gate never
  //       fired (in-memory statuses read "applied" at the kill). Neither the
  //       failure nor the landed wording fits, so this one says so plainly.
  //   (d) the transition did not land while the label did (round 3, R2-3 /
  //       S2-1) → the same condition the record-time enforcement gate checks,
  //       mirrored here so a later resume still sees it when that gate failed
  //       to emit. Never-block cuts both ways: a belt that fires only at
  //       record time is no belt.
  // Applied/applied, skipped (child), not-applicable, dry-run and pass
  // verdicts stay silent. Warning only — the resume is not refused on a
  // signal we cannot act on from here.
  if (last?.verdict === "fail") {
    const effects = last.linearEffects;
    const labelStatus = effects?.label?.status;
    const transitionStatus = effects?.transition?.status;
    if (!effects) {
      console.error(
        `[followup] round ${last.round} of ${entry.taskId} has NO linearEffects audit (pre-FOC-284 tool) — ` +
          `whether the return flag + In Progress ever landed is UNKNOWN; check the issue before this dev round`,
      );
    } else if (labelStatus === "failed") {
      console.error(
        `[followup] round ${last.round} of ${entry.taskId} recorded a FAILED return label: ${effects.label?.detail} — ` +
          `the return flag is probably missing; apply returned-by:* + In Progress by hand if so`,
      );
    } else if (labelStatus === "pending" || transitionStatus === "pending") {
      console.error(
        `[followup] round ${last.round} of ${entry.taskId} left the return ops "pending" — ` +
          `the record was written but the outcome was never amended: state UNKNOWN, ` +
          `verify the issue on Linear (flag + In Progress) before resuming this dev round`,
      );
    } else if (transitionStatus === "failed" || (labelStatus === "applied" && transitionStatus !== "applied")) {
      console.error(
        `[followup] round ${last.round} of ${entry.taskId} recorded an unlanded return transition ` +
          `(${transitionStatus ?? "absent"}): ${effects.transition?.detail ?? "no detail"} — ` +
          `the label may be on while the issue still sits in In Review; apply the transition by hand if so`,
      );
    }
  }

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

// ── provider env, rebuilt exactly like spawn (FOC-762/FOC-773) ────────────────
// A resumed turn used to spread the Supervisor's own process.env — after a
// provider switch in the settings overlay, the child's pinned model would run
// on a DIFFERENT provider's endpoint than the turn that started it. Spawn
// recorded the provider it resolved (`entry.provider`); the follow-up resolves
// THAT name explicitly, which beats LA_PROVIDER env and the overlay. An older
// entry without `provider` resolves with no explicit name — today's active
// provider — which is the pre-FOC-773 resume behaviour. Failure refuses the
// turn BEFORE any turn is appended (fail closed, same as spawn).
const providerEnv = childProviderEnv({ provider: entry.provider ?? null });
if (providerEnv.error) {
  failJson(`provider resolution failed — refusing the turn: ${providerEnv.error}`, {
    reason: "provider-resolution-failed",
    childId,
  });
}

// ── the launch: a fresh owned config dir for THIS turn ───────────────────────
// A resumed turn is a new process, so it gets a new launch dir
// (runDir/launch/<childId>/turn-<n>) assembled the same way spawn assembles
// turn 0 — with the one follow-up-specific difference: the SAME child's
// previous launch projects/ history is copied in, so --resume finds its own
// transcripts. History confinement is the point:
//   · entry.launchConfigDir (a launch-owned dir) → its whole projects/ tree is
//     this child's own history by construction — copied as the tree;
//   · a legacy entry (no launchConfigDir; the child ran against the SHARED
//     squad dir) → ONLY the transcript file named after entry.sessionId is
//     copied — never the shared dir's other children, never auth.
// The provider env stays what it was before this change: resolved FRESH here
// (pinned to entry.provider) and passed in env only — never persisted into the
// launch dir. The OTel identity rides only when the supervisor session id is
// present and a valid runtime token; legacy flows behave exactly as before.
const turns = entry.turns || [];
const turnIndex = turns.length;

const prevLaunchDir = entry.launchConfigDir && existsSync(entry.launchConfigDir) ? entry.launchConfigDir : null;
const historyMode = prevLaunchDir ? "tree" : entry.sessionId ? "session" : null;
// The session id is preserved from the entry; a legacy entry picks the env's
// up ONLY when it is a valid runtime token — an invalid env value is never
// persisted into the registry (it would ride every later turn as a fact).
const envSessionId = process.env.FENIX_SUPERVISOR_SESSION_ID || null;
const supervisorSessionId =
  entry.supervisorSessionId ?? (envSessionId && isRuntimeToken(envSessionId) ? envSessionId : null);
const telemetryContext = (() => {
  if (!supervisorSessionId || !isRuntimeToken(supervisorSessionId)) return null;
  const wanted = {
    taskKey: entry.taskKey ?? entry.taskId,
    supervisorSessionId,
    workflowRunId: runId,
    attemptId: attemptIdFor(childId, turnIndex),
    actorId: entry.actorId ?? actorIdFor(runId, childId),
    role: "squadlead",
  };
  const valid = Object.values(wanted).every((value) => isRuntimeToken(value));
  return valid ? wanted : null;
})();
const launch = prepareAgentLaunch({
  squad: entry.squad,
  role: "lead",
  outputDir: launchDirFor(runDir(runId), childId, turnIndex),
  previousConfigDir: prevLaunchDir ?? (historyMode === "session" ? squadConfigDir(entry.squad) : null),
  historyMode,
  previousSessionId: entry.sessionId ?? null,
  env: process.env,
  context: telemetryContext,
});

// The codegraph MCP approval used to be inherited from the SHARED squad dir
// the follow-up pointed CLAUDE_CONFIG_DIR at; the launch dir is per turn now,
// so the approval is re-stamped into it. Best effort, same degraded semantics
// as spawn: a failure is reported, never fatal to the turn.
const codegraphMcp = (() => {
  if (process.env.LA_SUPERVISOR_NO_CODEGRAPH === "1") {
    return { ok: false, written: false, reason: "skipped: LA_SUPERVISOR_NO_CODEGRAPH=1 (test/offline seam)" };
  }
  try {
    return approveGuardedCodegraphForProject({
      squad: entry.squad,
      projectRoot: entry.worktree,
      configDir: process.env.LA_SUPERVISOR_MCP_CONFIG_DIR ?? launch.configDir,
    });
  } catch (err) {
    return { ok: false, written: false, reason: `mcp-approval-error: ${String(err?.message ?? err).split("\n")[0]}` };
  }
})();

// ── new turn ─────────────────────────────────────────────────────────────────
// (`turns`/`turnIndex` were read above — the launch dir and the attempt id are
// built from them BEFORE the turn is appended.)

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
  // ── launch identity, preserved or derived ──────────────────────────────────
  // taskKey/supervisorSessionId/actorId/toolProfileRevision/launchConfigDir
  // survive the turn boundary; attemptId alone moves to THIS turn.
  //
  // pendingRuntimeReturn is deliberately NOT touched here. It used to be
  // cleared to null in this same patch — BEFORE the watcher had even spawned
  // claude — so a launch that died before the SessionStart hook fired took the
  // causal return evidence with it: the retry turn saw
  // FENIX_RUNTIME_RETURN="" and the return_to_dev event was never recorded.
  // The pending now rides every turn until the hook records it; the hook keys
  // the return_to_dev event id on the return's CONTENT (not the attempt), so
  // re-delivery dedups to exactly one event (first write wins) and the
  // consuming attempt is the one the event names.
  taskKey: entry.taskKey ?? entry.taskId,
  supervisorSessionId,
  actorId: entry.actorId ?? actorIdFor(runId, childId),
  attemptId: attemptIdFor(childId, turnIndex),
  toolProfileRevision: launch.profile.revision,
  launchConfigDir: launch.configDir,
  launch: {
    cliArgs: launch.cliArgs,
    changes: launch.changes,
    profileInitial: launch.profileInitial,
    copied: launch.copied.length,
    skipped: launch.skipped,
    history: launch.history,
  },
});

const promptDir = mkdtempSync(join(tmpdir(), "la-supervisor-"));
const promptFile = join(promptDir, "prompt.txt");
// The watcher always gets a path this script wrote, never the caller's — the
// same contract as spawn. See the prompt read at the top.
// The turn-end contract (FOC-522) is PREPENDED to every resume prompt: a
// resumed turn can end on a live background task exactly like a first turn
// can, and the resume prompt is the only text the follow-up path controls.
writeFileSync(promptFile, `${TURN_END_CONTRACT}\n\n${promptText}`, "utf8");

const watcherArgs = [
  join(ROOT, "scripts", "supervisor-watch.mjs"),
  "--run", runId,
  "--child", childId,
  "--cwd", entry.worktree,
  "--turn", String(turnIndex),
  "--prompt-file", promptFile,
  "--permission-mode", entry.permissionMode || "bypassPermissions",
  "--session", entry.sessionId,
];
if (entry.settings) watcherArgs.push("--settings", entry.settings);
if (entry.model) watcherArgs.push("--model", entry.model);
if (entry.telemetryRunId) watcherArgs.push("--telemetry-run", entry.telemetryRunId);
// The launch profile's CLI args (--tools / --disallowedTools / --mcp-config),
// JSON-encoded as one flag — the same channel spawn uses. The watcher owns the
// claude command line; until it consumes this channel the args stay recorded
// in the registry entry and the launch result.
watcherArgs.push("--claude-args", JSON.stringify(launch.cliArgs));

const watcher = spawn(process.execPath, watcherArgs, {
  cwd: entry.worktree,
  env: {
    ...process.env,
    // FOC-762/FOC-773: the FRESH provider resolution, pinned to the provider
    // recorded at spawn (`entry.provider`) — the same block spawn spreads, so
    // base URL, auth vars and tiers match the first turn even after the active
    // provider moved on. Spread BEFORE the overrides below, as spawn does.
    ...providerEnv,
    // FOC-762: the pinned model rides ANTHROPIC_MODEL here too — the watcher
    // already replays entry.model as --model, but spawn sets both, so the two
    // turn paths cannot drift on which channel carries the routing decision.
    ...(entry.model ? { ANTHROPIC_MODEL: entry.model } : {}),
    // FOC-522: the same finite background-wait ceiling spawn sets. This env
    // block is NOT a copy of spawn's — it was written separately once and
    // drifted before (FOC-171, RUN_ID) — so the value comes from the shared
    // helper, and supervisor-followup.test.mjs proves this carrier sets it.
    ...printBgWaitCeilingEnv(),
    // THIS turn's launch-owned config dir — this child's own squad sources,
    // its own copied resume history and this turn's tool-profile snapshot.
    CLAUDE_CONFIG_DIR: launch.configDir,
    // The launch env: the thoughtmap MCP server env (URLs and paths only) plus,
    // when a valid supervisor session id is present, the OTel identity.
    ...launch.env,
    FENIX_STAGE: entry.squad,
    FENIX_DEPENDS_ON_ATTEMPTS: JSON.stringify([entry.attemptId,entry.pendingRuntimeReturn?.sourceAttemptId].filter(Boolean)),
    FENIX_RUNTIME_RETURN: entry.pendingRuntimeReturn ? JSON.stringify(entry.pendingRuntimeReturn) : '',
    LA_SUPERVISOR: "1",
    LA_SUPERVISOR_RUN: runId,
    LA_SUPERVISOR_CHILD: childId,
    LA_TASK_ID: entry.taskId,
    // Same override spawn does, and for the same reason — it was missing here,
    // which is the whole of FOC-171. `claude --resume` fires SessionStart like
    // any other start, telemetry-hook.mjs reads LA_RUN_ID/RUN_ID, and without
    // this the inherited value is the SUPERVISOR's run: every follow-up turn
    // filed the child's session against the parent. Turn 0 was fixed in
    // 06051c6; turns 1..n were not, and they are where the volume is.
    //
    // Set to "" rather than left inherited when there is no telemetry run.
    // Inheriting means the parent's id, and a child's tokens recorded against
    // the SUPERVISOR are worse than a child's tokens recorded nowhere: the
    // first silently doubles the parent's cost, the second shows up as a gap.
    RUN_ID: entry.telemetryRunId || "",
    LA_RUN_ID: entry.telemetryRunId || "",
  },
  detached: true,
  stdio: "ignore",
  // Same as supervisor-spawn.mjs. Missing here for the same reason RUN_ID was:
  // the fix landed on the turn-0 path and was never carried to the follow-up
  // path, and follow-ups are the frequent one — a gate answer or a review loop
  // opens a window every time.
  windowsHide: true,
});
watcher.unref();

// ── auto-focus (FOC-769) ─────────────────────────────────────────────────────
// Same rule as spawn: the follow-up is the Supervisor acting on the child's
// ticket RIGHT NOW, so the launched watcher's turn declares the focus for it
// (source "followup") and holds until the next spawn/followup. Never fails the
// turn — a setFocus error lands in `focusError` beside the result, not in an
// exit code. Skipped silently when the child's task is not a ticket shape or
// the run id is not a run id — nothing to attribute, nothing to escalate.
// (Same block lives in supervisor-spawn.mjs — the helper home,
// supervisor-lib.mjs, is not this slice's file.)
let focus = null;
let focusError = null;
if (RUN_ID_RE.test(String(runId))) {
  const wanted = (() => {
    try {
      return normalizeFocus(entry.taskId);
    } catch {
      return null; // not a ticket — nothing to attribute, skip silently
    }
  })();
  if (wanted) {
    try {
      const res = setFocus({ runId, value: entry.taskId, source: "followup" });
      focus = { changed: res.changed, taskId: res.focus.taskId };
    } catch (err) {
      focusError = `focus: ${err.message}`;
    }
  }
}

// ── wait for system/init (FOC-271) ───────────────────────────────────────────
// This used to return the moment the watcher was spawned, on the reasoning that
// the session already exists so there is no session_id to wait for. True, and
// beside the point: what needed verifying was never the id, it was that a
// process started at all.
//
// Observed twice in one run (2026-09-09, 11:25 and 11:44): followup answered
// ok:true, the watcher never got claude off the ground, and the registry showed
// a turn with 0 bytes in the tee and a null pid. The Supervisor then waited on
// a child that did not exist — 7 and 12 minutes of silence before anyone
// noticed. Spawn has had this check since the beginning and refused correctly
// on the same day; only this path was blind.
//
// The signal differs from spawn's. There is no new sessionId, so we wait for
// the status the watcher writes when it sees system/init: the "starting" set
// above becoming "running". A turn that finishes before we look is a terminal
// status, which is success, not silence.
const deadline = Date.now() + INIT_TIMEOUT_MS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let live = null;
let started = false;

while (Date.now() < deadline) {
  await sleep(150);
  live = readRegistry(runId).children[childId];
  if (live?.status === "running" || (live && TERMINAL_STATUSES.includes(live.status))) {
    started = true;
    break;
  }
}

if (!started) {
  // Same disposal as spawn: kill whatever fragment exists, record the turn as
  // crashed, and fail loudly. A zombie recorded as a live turn is the thing
  // this whole check exists to stop, so it must not degrade into a warning.
  killTree(live?.turns?.[turnIndex]?.pid, "force");
  updateChild(runId, childId, {
    status: "crashed",
    endedAt: new Date().toISOString(),
    error: `no system/init within ${INIT_TIMEOUT_MS} ms (follow-up turn ${turnIndex})`,
  });
  failJson(
    `follow-up turn ${turnIndex} for ${childId} produced no system/init within ${INIT_TIMEOUT_MS} ms — killed`,
    {
      childId,
      turn: turnIndex,
      tee: teeAbsPath(runId, childId),
      hint: "the watcher started but claude never did; the tee is the first place to look",
    },
  );
}

console.log(
  JSON.stringify(
    {
      ok: true,
      childId,
      sessionId: entry.sessionId,
      // The OBSERVED status, not a hardcoded "running". Now that this waits for
      // init, a fast turn can already have finished by the time we look, and
      // reporting it as running would be the same class of lie the wait was
      // added to remove.
      status: live?.status ?? "running",
      turn: turnIndex,
      tee: teeRelPath(childId),
      gateId: args.gate || null,
      reviewLoop: Boolean(args["review-loop"]),
      // What replaced the counter. `repeated: null` is UNKNOWN, not "fine" —
      // whoever reads this next has to be able to tell those apart.
      progress,
      // FOC-769: the focus this follow-up declared (absent when skipped as not
      // a ticket / not a run id), and the focus failure that did NOT fail the
      // turn, if there was one.
      ...(focus ? { focus } : {}),
      ...(focusError ? { focusError } : {}),
      // The launch record: this turn's config dir, the captured CLI args and
      // tool-profile revision, the diff against the prior safe snapshot, and
      // the codegraph MCP re-stamp. Metadata, not a gate — the Settings apply
      // already authorized the next process.
      launch: {
        configDir: launch.configDir,
        cliArgs: launch.cliArgs,
        toolProfileRevision: launch.profile.revision,
        changes: launch.changes,
        profileInitial: launch.profileInitial,
        history: launch.history,
        codegraphMcp,
      },
    },
    null,
    2,
  ),
);
