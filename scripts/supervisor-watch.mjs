// scripts/supervisor-watch.mjs — the detached process that OWNS one child turn.
//
// Why the watcher owns claude rather than supervisor-spawn.mjs: liveness has to
// survive the spawner returning. A process can only reliably wait on its own
// child, and the stream-json pipe dies with whoever holds it. So spawn launches
// this watcher detached, the watcher launches claude, and the watcher is the one
// that sees the real exit and records it.
//
// The contract that follows from that: supervisor-status.mjs reads the registry
// and the tee, and NEVER probes a pid or infers liveness. If a status is wrong,
// this file is where the bug is.
//
// The same ownership makes this the single writer of the run's durable wake
// queue (FOC-608, <runDir>/wake-queue.jsonl): child exit, new gate, stall past
// the SLA — one JSONL row each, deduped by key. supervisor-status.mjs drains
// and acks the queue; it never appends to it.
//
// Not invoked by hand. supervisor-spawn.mjs (and later supervisor-followup.mjs)
// start it with { detached: true, stdio: 'ignore' } + unref.

// First: this watcher owns no console on win32 (spawned with windowsHide), so
// every helper it runs would otherwise open a terminal window — see the module.
import "./spawn-windows-hide.mjs";
import { spawn, execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { calculateCost, priceThreshold, pricingSnapshot } from "./telemetry-store.mjs";
import { priceChildTranscripts } from "./transcript-cost.mjs";
import { squadConfigDir } from "./fenix-paths.mjs";
import { agentStatePath, openAgentState, pruneFacts } from "./agent-state.mjs";

import {
  ROOT,
  appendWakeEvent,
  claudeCommand,
  costFromResult,
  dirtyTreeReport,
  gatesDir,
  enumerateWin32Processes,
  hasPendingGate,
  installEnvFileSignalHandlers,
  killTree,
  parseArgs,
  readRegistry,
  reapChildDescendants,
  rememberChildLineage,
  shareChildTranscripts,
  stallSilenceMs,
  sweepChildProcesses,
  sweepMarkFor,
  teeAbsPath,
  turnEndCostPatch,
  updateChild,
} from "./supervisor-lib.mjs";

const args = parseArgs(process.argv.slice(2));

const runId = args.run;
const childId = args.child;
const cwd = args.cwd;
const tee = teeAbsPath(runId, childId);

// stdio is 'ignore' on this process, so there is nowhere to print. Anything the
// operator needs to know goes into the tee as a synthetic event — that is the
// one stream supervisor-status.mjs already reads.
function note(event) {
  try {
    appendFileSync(tee, JSON.stringify({ type: "supervisor", ...event, ts: new Date().toISOString() }) + "\n");
  } catch {
    /* the tee is the last resort; if it is gone there is nothing left to do */
  }
}

function endTelemetryRun(telemetryRunId, exitCode) {
  if (!telemetryRunId) return;
  try {
    execFileSync(process.execPath, [`${ROOT}/scripts/run-manifest.mjs`, "end", telemetryRunId, String(exitCode ?? 0)], {
      cwd,
      stdio: "ignore",
      // The watcher owns no console (see spawnOpts below): without windowsHide
      // every helper it runs opens a terminal window on a Windows desktop.
      windowsHide: true,
    });
  } catch (err) {
    note({ subtype: "telemetry_end_failed", message: err.message });
  }
}

// FOC-730: turn-scoped working state of this child's namespace is dead the
// moment the turn is — every child exit is a turn boundary (gates included).
// Task- and run-scoped keys stay: they close at task close
// (supervisor-cleanup.mjs cmdRemove) and at run retention (cmdPrune). Returns
// the retired key list, or null when there is no store to touch — a run that
// predates the store is skipped silently, and creating one here would grow a
// store for every legacy run.
function pruneTurnWorkingState() {
  const dbPath = agentStatePath(process.env);
  if (!existsSync(dbPath)) return null;
  const store = openAgentState(dbPath);
  try {
    return pruneFacts(store, {
      namespace: `child:${runId}/${childId}`,
      scope: "turn",
      actor: "supervisor-watch",
    }).retired;
  } finally {
    store.close();
  }
}

const promptText = args["prompt-file"] ? readFileSync(args["prompt-file"], "utf8") : "";

const claudeArgs = [
  "-p",
  promptText,
  "--output-format",
  "stream-json",
  "--verbose",
  "--permission-mode",
  args["permission-mode"] || "bypassPermissions",
];
// --resume makes this a follow-up turn on an existing session rather than a new
// one. Unused by spawn; FOC-120 drives it.
if (args.session) claudeArgs.push("--resume", args.session);
if (args.settings) claudeArgs.push("--settings", args.settings);
if (args.model) claudeArgs.push("--model", args.model);

// ── the launch profile's CLI args (task-workspace) ───────────────────────────
// spawn/followup pass the tool profile's captured args (--tools, --disallowed-
// Tools, --mcp-config) as ONE JSON-encoded flag; this watcher owns the claude
// command line, so here is where they become real — appended AFTER the flags
// above, which therefore keep their meaning (last-value flags the watcher set
// stay set unless the profile repeats one deliberately).
//
// Fail-closed BEFORE the spawn: only a JSON array of strings is accepted. A
// malformed payload is a crashed child, never a half-profiled launch — the
// profile was captured to run the child under a KNOWN tool set, and silently
// dropping it would launch exactly the child the snapshot was taken to prevent.
// The values ride argv, one string per element: spawn(command, args) involves
// no shell, so there is nothing to interpolate, quote or split.
const parseProfileArgs = (raw) => {
  if (raw === undefined || raw === "") return [];
  if (raw === true) {
    throw new Error("--claude-args needs a JSON array-of-strings value — a bare flag is not a launch profile");
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`--claude-args is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(parsed) || parsed.some((a) => typeof a !== "string")) {
    throw new Error(
      `--claude-args must be a JSON array of strings, got ${JSON.stringify(parsed)?.slice(0, 120)}`,
    );
  }
  return parsed;
};

let profileArgs = null;
let profileArgsError = null;
try {
  profileArgs = parseProfileArgs(args["claude-args"]);
} catch (err) {
  profileArgsError = err.message;
}

if (profileArgsError) {
  // stdio is 'ignore', so the refusal travels the same two channels a crash
  // does: the registry (the Supervisor reads status) and the tee (the why).
  note({ subtype: "claude_args_rejected", message: profileArgsError });
  updateChild(runId, childId, {
    status: "crashed",
    exitCode: null,
    endedAt: new Date().toISOString(),
    error: `refused before launch: ${profileArgsError}`,
  });
  endTelemetryRun(args["telemetry-run"], 1);
  process.exit(1);
}
claudeArgs.push(...profileArgs);

const { command, args: spawnArgs } = claudeCommand(claudeArgs);

// ── child isolation (FOC-802) ────────────────────────────────────────────────
// Inside the container the claude child must NOT run as the Supervisor's uid:
// a same-uid child can edit the Supervisor's settings and records on /data,
// read /data/run/host.token and reach the Supervisor's tmux socket (FOC-783).
// When the root-owned drop-privilege helper is available, the claude spawn goes
// through
//
//   sudo -n <helper> <env-file> <worktree> <config-dir> -- <claude argv…>
//
// The helper validates the paths, hands the worktree/config dir to
// fenix-child:fenix and re-execs argv as fenix-child with the env from the
// file (KEY=VALUE lines, values verbatim, no quoting) plus HOME/TMPDIR/umask.
//
// The env file carries EXACTLY the env the child would have received directly —
// the watcher's own process env, which supervisor-spawn.mjs builds explicitly
// and passes through — minus LA_CHILD_SPAWN_HELPER, which is a test seam and
// must never reach a child. Written 0640 and removed as soon as the child is
// gone: the watcher is the only writer and the only remover.
//
// Lifetime in the normal path is MILLISECONDS: the helper sources the file and
// unlinks it immediately after, before exec'ing claude. The watcher's removals
// (child exit, spawn error, process exit, signals) only cover the paths where
// the helper never ran — a refusal, a crash before the helper got to it, or the
// watcher itself being killed. `process.on("exit")` does NOT run on
// SIGTERM/SIGINT/SIGHUP, so the signal handlers below are what keep a hard-killed
// watcher from leaving the keys on disk readable by every child (group fenix).
//
// Fail closed: a helper that REFUSES (exit 97) fails the turn with an
// isolationError — there is no fallback to an unisolated spawn, because the
// child that would then launch is exactly the one the isolation exists to
// contain. A claude that itself exits 2 under isolation is a NORMAL child exit
// of code 2 (crashed), never an isolation error — that is exactly why the
// helper's refusals do not use an exit code a child could produce. Outside the
// container (Windows/native), with FENIX_CHILD_ISOLATION=off, or without the
// helper, today's spawn runs unchanged.
const HELPER = process.env.LA_CHILD_SPAWN_HELPER || "/usr/local/sbin/fenix-spawn-as-child";
const isolationWanted =
  process.env.FENIX_IN_CONTAINER === "1" && process.env.FENIX_CHILD_ISOLATION !== "off";
// No CLAUDE_CONFIG_DIR means nowhere to put the env file, so nothing to hand
// the helper — the unisolated spawn is the only thing left either way.
const isolated = isolationWanted && !!process.env.CLAUDE_CONFIG_DIR && existsSync(HELPER);

const childEnvFile = isolated ? join(process.env.CLAUDE_CONFIG_DIR, "child.env") : null;
const removeEnvFile = () => {
  if (!childEnvFile) return;
  try {
    rmSync(childEnvFile, { force: true });
  } catch {
    /* best effort — the file is 0640 inside the child's own config dir */
  }
};

if (isolationWanted && !isolated) {
  // stdio is 'ignore'; the tee is the operator's channel. The two ways isolation
  // can be off despite being wanted are named separately.
  note({
    subtype: "isolation_helper_missing",
    message: !process.env.CLAUDE_CONFIG_DIR
      ? "child isolation wanted (FENIX_IN_CONTAINER=1) but no CLAUDE_CONFIG_DIR — spawning unisolated"
      : `child isolation wanted (FENIX_IN_CONTAINER=1) but helper not found at ${HELPER} — spawning unisolated`,
  });
}

if (isolated) {
  // Unlink before every write (FOC-802 M1): writeFileSync must never reuse the
  // inode of a file a previous watcher left behind — a stale owner or mode
  // would survive any content fix. With `wx` the create fails loudly if the
  // unlink did not take, so a leftover file can never be silently rewritten in
  // place.
  try {
    unlinkSync(childEnvFile);
  } catch {
    /* not there — the normal case */
  }
  writeFileSync(
    childEnvFile,
    Object.entries(process.env)
      .filter(([k]) => k !== "LA_CHILD_SPAWN_HELPER")
      .map(([k, v]) => `${k}=${v ?? ""}`)
      .join("\n") + "\n",
    { mode: 0o640, flag: "wx" },
  );
  // The child handlers below cover every path after the spawn, but the file
  // must not outlive the turn even if this process dies some other way. The
  // signal handlers are the ones that matter when the Supervisor kills this
  // detached watcher hard: `exit` does not run on SIGTERM/SIGINT/SIGHUP.
  process.on("exit", removeEnvFile);
  installEnvFileSignalHandlers(removeEnvFile);
}

// LA_SUDO_BIN is a TEST SEAM, shaped like LA_CLAUDE_BIN: the suite points it at
// a node script, which cannot be execed directly, so it rides node with the
// production sudo argv appended verbatim — what follows the fake sudo is exactly
// the argv a real `sudo -n …` would carry. Production leaves it unset.
const sudoBin = process.env.LA_SUDO_BIN || "sudo";
const sudo =
  sudoBin.endsWith(".mjs") || sudoBin.endsWith(".js")
    ? { command: process.execPath, prefixArgs: [sudoBin] }
    : { command: sudoBin, prefixArgs: [] };

const turnIndex = Number(args.turn ?? 0);

// FOC-607: what this turn was PINNED to, as opposed to what the child reports
// serving with (initModel, read from system/init below). Both land on the turn
// record so a divergence between the two stays visible in the registry.
const requestedModel = typeof args.model === "string" ? args.model : null;

// FOC-760: the session id the registry carried BEFORE this turn. A resumed turn
// can fork a NEW session id (init's session_id ≠ the registered one) — the init
// handler below overwrites the registry field, so the old id is captured here,
// before the spawn, and the turn-end cost prices BOTH transcripts.
const previousSessionId = (() => {
  try {
    return readRegistry(runId).children[childId]?.sessionId ?? null;
  } catch {
    return null; // no registry yet — nothing to fall back to
  }
})();

// FOC-761: a resumed turn (turnIndex > 0) reuses the child's telemetry run id,
// and the PREVIOUS turn already ended that run — its `end` wrote run.ended with
// an identity the ingest dedup keeps, so without a re-open the run stays closed
// and after 5 min `settledRun` never reads the resumed turn's lines. Re-open
// the manifest BEFORE claude is spawned, so the run is open while this turn
// writes. Best effort, same shape as endTelemetryRun: a failure is a note in
// the tee, never a dead child.
function reopenTelemetryRun(telemetryRunId, turn) {
  if (!telemetryRunId) return;
  try {
    execFileSync(
      process.execPath,
      [`${ROOT}/scripts/run-manifest.mjs`, "reopen", telemetryRunId, String(turn)],
      { cwd, stdio: "ignore", windowsHide: true },
    );
  } catch (err) {
    note({ subtype: "telemetry_reopen_failed", message: err.message });
  }
}
if (turnIndex > 0) reopenTelemetryRun(args["telemetry-run"], turnIndex);

const spawnOpts = {
  cwd,
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
  // This watcher is itself detached, so it owns no console. Spawning claude —
  // a console application — makes win32 allocate a FRESH console for it, which
  // appears as a terminal window popping up on Mateusz's desktop for every
  // single turn. 06051c6 hid the watcher's own window and stopped there; the
  // window people actually see is this one. Pipes are unaffected: the watcher
  // still reads stdout/stderr, it just does not get a visible console with it.
  windowsHide: true,
  // POSIX: lead a process group of its own, so killTree's group signal (-pid)
  // reaches the bash and test processes claude spawns. Never on win32: there
  // detached means a fresh console, and taskkill /T already walks the tree.
  detached: process.platform !== "win32",
};

// FOC-802: when isolated, the EXACT argv claude would get today rides after
// `--` on the helper's command line; nothing about the child's command line or
// this watcher's pipe handling changes. Unisolated is today's spawn verbatim.
// FOC-1162: the instant before the spawn, recorded as the creation LOWER bound
// the win32 descendant reap verifies against — a grandchild the child spawned
// was born after this moment; a stale row that merely claims the child's ppid
// predates it (whoever held the pid then spawned that). Declared here because
// finalizeTurn reads it on every path.
const childSpawnAt = Date.now();
const child = isolated
  ? spawn(
      sudo.command,
      [
        ...sudo.prefixArgs,
        "-n",
        HELPER,
        childEnvFile,
        cwd,
        process.env.CLAUDE_CONFIG_DIR,
        "--",
        command,
        ...spawnArgs,
      ],
      spawnOpts,
    )
  : spawn(command, spawnArgs, spawnOpts);

// The status a signal-terminated turn exits with (128+n), set by terminateTurn
// below; null on a run that ends normally.
let signalTerminated = null;

// FOC-913: how long the child's stream tail may keep landing after 'exit'
// before the turn is finalized without it. Declared here, before the signal
// handlers, because terminateTurn measures its own deadline against this
// window — the terminator must never fire before the finalizer can.
const TAIL_DRAIN_MS = 2000;
// The handle to the terminator's own timer: finalizeTurn clears it the moment
// it starts, so a finalization in progress can never be pre-empted.
let terminatorTimer = null;

// FOC-802: when the Supervisor kills the watcher, the turn must die with it —
// not leave a claude child running orphaned, holding the worktree and burning
// the budget. The child leads its own process group (spawnOpts.detached), so a
// group signal reaches the sudo/helper AND everything claude spawned. On an
// isolated run the env-file handlers above run first and re-raise, so this
// handler also sees the signal a second time and acts exactly once; on an
// unisolated POSIX run it IS the signal handler. The child's exit path gets a
// bounded window (TAIL_DRAIN_MS + 1500 from the signal — strictly beyond the
// finalizer's own TAIL_DRAIN_MS drain, measured from the later 'exit' anchor)
// to run its normal bookkeeping (registry, tee, wake queue, telemetry) — but
// the watcher exits with the signal's status (143 for SIGTERM) regardless of
// what the child does. Windows has no external-signal handler semantics;
// today's behaviour there is unchanged.
if (process.platform !== "win32") {
  const SIGNAL_EXIT = { SIGTERM: 143, SIGINT: 130, SIGHUP: 129 };
  const terminateTurn = (signal) => {
    if (signalTerminated !== null) return; // the env-file handler's re-raise lands here too
    signalTerminated = SIGNAL_EXIT[signal] ?? 143;
    if (child.pid) {
      try {
        process.kill(-child.pid, signal);
      } catch {
        /* the group is already gone */
      }
      try {
        process.kill(child.pid, signal);
      } catch {
        /* the pid is already gone */
      }
    }
    // The finalizer is armed only when the child's 'exit' lands — S+δ, not S —
    // and its TAIL_DRAIN_MS fallback then ends at S+δ+TAIL_DRAIN_MS. A deadline
    // measured from S must sit strictly beyond that window, or exactly the case
    // the drain bound exists for (a grandchild holding the inherited stdout
    // pipe, delaying `close` past S+TAIL_DRAIN_MS) has the terminator fire
    // first and discard the whole finalization — registry left "running", no
    // cost patch, no wake row, no endTelemetryRun. TAIL_DRAIN_MS + 1500 keeps
    // the terminator strictly last while still bounding the watcher's life;
    // a finalization that starts clears the timer outright.
    terminatorTimer = setTimeout(() => process.exit(signalTerminated), TAIL_DRAIN_MS + 1500);
  };
  for (const signal of Object.keys(SIGNAL_EXIT)) process.on(signal, terminateTurn);
}

let sessionId = null;
// FOC-760: the costFromResult outputs of this turn, kept in order and resolved
// ONCE at exit. Each is a session-cumulative snapshot — they are never summed
// here, and no accumulator runs during the turn; turnEndCostPatch decides at
// the end what the registry entry is set to.
const resultCosts = [];
let initModel = null;
let sawInit = false;
// FOC-1154: the state of the tee's LAST parsed stream event. A turn whose last
// event is a terminal `result` has finished its work even when the process
// keeps running — on win32 claude never exits on its own after the result —
// but `result` can arrive more than once per turn (background-task wake-ups
// re-emit cumulative results), so "a result was seen" is NOT the gate. Every
// parsed event refreshes both fields: a non-result event flips the gate back
// off and normal stall behaviour resumes.
let lastEventIsResult = false;
let lastEventAt = 0;
// FOC-1160: whether a terminal `result` has been parsed at all this turn, and
// whether the LAST parsed event is the empty-registry proof that may only
// follow one. Both reset with the stream: every parsed event re-derives the
// proof (so any event after it disarms it), and the state is per-turn by
// construction — a follow-up turn is a new watcher process.
let sawResult = false;
let lastEventProvesEmptyRegistry = false;

// One read of config/models.json for the whole turn. A missing or broken price
// table must not stop the child: cost becomes unknown (null), which is exactly
// what an unpriced run is, and the budget check refuses on unknown rather than
// pretending the run was free. The whole snapshot is kept: the flat openrouter
// scope alone cannot see keys catalogued under another provider (FOC-165 —
// zai-org/GLM-5.2-FP8 lives only under nebul), so pricing resolves against
// scopes exactly like ingest does.
const snapshot = (() => {
  try {
    return pricingSnapshot();
  } catch {
    return null;
  }
})();
const priceOne = (usage, model) => (snapshot ? calculateCost(usage, model, snapshot.prices, null, snapshot.scoped) : null);
// Mirrors priceOne: lets costFromResult tell "no price row" apart from "row
// does not cover this usage" when calculateCost refuses at/above a declared
// promptTokenThreshold (FOC-165 (f)).
const thresholdOne = (model) => (snapshot ? priceThreshold(model, snapshot.prices, null, snapshot.scoped) : null);


function patchTurn(patch) {
  const registry = readRegistry(runId);
  const entry = registry.children[childId];
  if (!entry) return;
  const turns = entry.turns || [];
  turns[turnIndex] = { ...(turns[turnIndex] || {}), ...patch };
  updateChild(runId, childId, { turns });
}

// `isolated` records whether THIS turn's claude spawn went through the
// drop-privilege helper (FOC-802) — supervisor-status surfaces the latest
// turn's value per child.
patchTurn({
  pid: child.pid,
  startedAt: new Date().toISOString(),
  endedAt: null,
  exitCode: null,
  isolated,
});

// ── durable wake queue (FOC-608) ─────────────────────────────────────────────
// This watcher is the SINGLE writer of <runDir>/wake-queue.jsonl. It classifies
// three event classes into it and nothing else: a child exit, a gate appearing,
// a stall past the SLA. Zero-token by construction — it only reads files and
// appends rows; judging what a row means is the Supervisor's job (drain at the
// start of a turn → handle → ack, agents/supervisor/CLAUDE.md §4).
//
// Exactly-once lives in appendWakeEvent's dedup key (supervisor-lib.mjs), not
// here: re-observing an event is free, so a coarse scan is correct. A queue
// failure must never kill the watcher's real job (owning the child), so every
// append is best-effort and leaves a note in the tee.
const wake = (event) => {
  try {
    appendWakeEvent(runId, event);
  } catch (err) {
    note({ subtype: "wake_enqueue_failed", message: err.message });
  }
};

// Pending gates that have not been enqueued yet. `gate:<gateId>` is the dedup
// key, so rescanning is free across ticks and across watcher restarts.
function scanGates() {
  const dir = gatesDir(runId);
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    try {
      const gate = JSON.parse(readFileSync(join(dir, file), "utf8"));
      if (gate.status !== "pending") continue;
      wake({
        event: "gate",
        gateId: gate.gateId ?? file.replace(/\.json$/, ""),
        childId: gate.childId ?? childId,
        detail: { kind: gate.kind ?? null },
      });
    } catch {
      continue; // an unreadable gate file is not an event; status reports it
    }
  }
}

// Stall past the SLA — the same wall-clock rule supervisor-status.mjs displays,
// from the same shared constant. The tee GROWING is the activity signal; mtime
// alone can be touched without a write. One row per silence EPISODE, not per
// turn (FOC-621): re-polls of the same silence carry the same tee size as the
// episode discriminator and dedup to a no-op, while output between two silence
// periods grows the tee, so the next breach is a new episode with its own row.
const STALL_AFTER_MS = stallSilenceMs();
const GATE_SCAN_MS = 5_000;
// FOC-271: this watcher IS the turn, so the turn's start is the other activity
// signal. A resume launched long after the previous turn's last tee write would
// otherwise be "stalled" — and enqueue a spurious stall row — before its child
// produced a single byte. Silence runs from the LATEST of the tee write and the
// turn start, the same rule supervisor-status.mjs displays.
const TURN_START_MS = Date.now();
let lastTeeSize = null;

function scanStall() {
  try {
    if (!existsSync(tee)) return;
    const { size, mtimeMs } = statSync(tee);
    // FOC-1154: a tee whose LAST parsed event is a terminal `result` is not a
    // silent turn — it is a FINISHED turn whose process lingers. Silence after
    // a result is the linger itself, never a stall, so no stall row is ever
    // queued for it; the linger scan below reaps the child instead.
    if (lastEventIsResult) {
      lastTeeSize = size;
      return;
    }
    // FOC-271: silence runs from the LATEST of the tee write and the turn start.
    // FOC-621: `episode` = the tee size at silence onset — stable across re-polls
    // of the same silence (a silent tee does not grow), new after any output, so
    // a recover-then-restall turn emits a second row instead of being deduped.
    const activityMs = Math.max(mtimeMs, TURN_START_MS);
    if (lastTeeSize !== null && size === lastTeeSize && Date.now() - activityMs >= STALL_AFTER_MS) {
      wake({ event: "stall", childId, turn: turnIndex, episode: size, detail: { silentMs: Date.now() - activityMs } });
    }
    lastTeeSize = size;
  } catch {
    /* nothing to classify without the tee */
  }
}

// ── FOC-1160: short reap — the registry is PROVABLY empty after the result ───
// Run-3409: on win32 a turn whose background task was force-killed at turn end
// leaves the CLI in its print-mode bg-wait drain (a wait that will never
// resolve), emitting nothing after the teardown tail: result → task_updated →
// task_notification → `background_tasks_changed` with `tasks: []` → silence
// until the CLI's own 600 s ceiling expires. The FOC-1154 gate cannot see that
// shape — the teardown events flip `lastEventIsResult` off, so the SLA path
// stands down and the child lingers the full SLA.
//
// The approved rule is deliberately narrow: the short reap fires ONLY when the
// stream PROVES the background-task registry is empty after the last result —
// the LAST parsed event is `background_tasks_changed` with an empty `tasks`
// array, or a `task_summary` with no live task, and a `result` was seen before
// it. A bare terminal result is NEVER short-reaped (it stays on the 600 s SLA —
// the FOC-1154 guarantee: a healthy child re-emits cumulative results mid-turn
// and can sit tee-silent for a background task's duration). Any event after the
// proof disarms it; a second proof re-arms it.
const REAP_GRACE_MS = 60_000;
// TEST SEAM, shaped like LA_SUPERVISOR_POLL_MS: the suite shrinks the grace so
// the e2e scenarios stay around seconds; production leaves it unset.
const lingerGraceMs = () => {
  const raw = Number(process.env.LA_SUPERVISOR_LINGER_GRACE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : REAP_GRACE_MS;
};
// The proof, per the shapes run-3409 and the foc-1160 probes captured: `tasks`
// is a top-level array on background_tasks_changed; `detail` is null/"" on a
// task_summary emitted with no live task and a description when one runs.
// Anything the stream does not spell out as empty reads as NOT a proof —
// fail-safe, the SLA path stays in charge.
const emptyRegistryProof = (event) => {
  if (event?.type !== "system") return false;
  if (event.subtype === "background_tasks_changed") return Array.isArray(event.tasks) && event.tasks.length === 0;
  if (event.subtype === "task_summary") return !event.detail;
  return false;
};

// ── FOC-1154: reap a turn that ended but whose process lingers ───────────────
// The turn's work is done (the tee's last event is a terminal `result`) and the
// child will not exit on its own — on win32 never. The reap REPLACES the false
// stall at the SAME SLA, it does not preempt it: while the last event is a
// result no stall row is queued (the guard in scanStall), and once that silence
// reaches stallSilenceMs() the linger path reaps instead — at the SLA exactly
// one of {stall row, reap} fires. The SLA, not a shorter grace, is the
// threshold because a real child re-emits cumulative results mid-turn and can
// then sit tee-silent for the duration of a background task
// (supervisor-watch-cost.test.mjs): any sub-SLA grace would force-kill that
// healthy child and dress the kill up as a clean exit.
//
// Killing through the NORMAL exit path is what makes this cheap: the kill
// fires the child's own exit/close handlers, finalizeTurn runs unchanged
// (registry status, gate handling, cost patch, the `exit` wake row) and the
// watcher exits — no new wake class, no second finalizer to keep in sync.
let lingerReaped = false; // a reap LANDED — the exit row carries finishedLingering
let lingerReapShort = false; // the reap that landed was the FOC-1160 short path
let lingerReapFailed = false; // both kill attempts failed — noted once, never faked
let lingerFinalizeTimer = null;

function scanLinger() {
  if (finalized || lingerReaped || lingerReapFailed) return;
  // Two triggers, one mechanism: the FOC-1154 SLA path (the last event is a
  // bare terminal result) and the FOC-1160 short-reap path (the last event is
  // the empty-registry proof that came after a result). Everything else — a
  // bare result inside the grace window, a proof with a non-empty registry,
  // any event after the proof — is left to the stall SLA exactly as before.
  const shortReap = lastEventProvesEmptyRegistry;
  if (!shortReap && !lastEventIsResult) return;
  // Liveness before the force-kill: 'exit' may have fired with the
  // TAIL_DRAIN_MS finalize still pending — killing that pid could hit a
  // RECYCLED process on win32. A child that demonstrably already exited needs
  // no reap; its own finalizer is at most TAIL_DRAIN_MS away.
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  // Silence is measured past the last parsed event itself (the event time, not
  // the tee mtime — a watcher note must not move this anchor): the SLA on the
  // FOC-1154 path, the shorter FOC-1160 grace on the short path.
  if (shortReap) {
    // A pending gate means the Supervisor is already engaged on this turn —
    // the short reap stands down and the ordinary stall machinery owns the
    // silence (the proof shape is a non-result last event, so scanStall is
    // not suppressed). The approved 60 s grace must also fully elapse.
    if (hasPendingGate(runId, childId)) return;
    if (Date.now() - lastEventAt < lingerGraceMs()) return;
    note({
      subtype: "result_linger_reap_short",
      message: `last stream event proved the background-task registry empty ${Math.round((Date.now() - lastEventAt) / 1000)}s ago with no exit — reaping the lingering child (FOC-1160)`,
    });
  } else {
    if (Date.now() - lastEventAt < STALL_AFTER_MS) return;
    note({
      subtype: "result_linger_reap",
      message: `last stream event was a terminal result ${Math.round((Date.now() - lastEventAt) / 1000)}s ago with no exit — reaping the lingering child (FOC-1154)`,
    });
  }
  // killTree reports false for an already-gone tree. The liveness probe above
  // has already filtered the cases it can see, so a false here is either a tree
  // that died in the gap (its own exit finalizes normally — no failure to
  // report) or a live tree the kill could not land on. One retry; a double
  // failure is recorded honestly — finalizeTurn(0) here would fabricate a
  // clean exit for a tree that was not reaped.
  const reaped = killTree(child.pid, "force") || killTree(child.pid, "force");
  if (reaped) {
    lingerReaped = true;
    if (shortReap) lingerReapShort = true;
  } else {
    lingerReapFailed = true;
    note({
      subtype: "result_linger_reap_failed",
      message: `two force kills of pid ${child.pid} did not land (the tree may already be gone) — arming the bounded last-resort finalize (FOC-1154)`,
    });
  }
  // Bounded last resort (review round 2, S1): the scanner must never leave the
  // turn without a consumable signal. On a landed kill the child's own
  // exit/close normally finalizes within TAIL_DRAIN_MS and this timer is a
  // no-op; after a double kill failure nothing else will ever fire, so the
  // bound runs the NORMAL finalizeTurn with the truthful code — null when the
  // child may still be alive (status crashed, exitCode null, lingerReapFailed
  // on the turn record and the wake row). Same shape and window as the
  // terminator's timer, cleared by finalizeTurn the moment it starts, and NOT
  // unref'd — it is the last thing keeping the watcher alive.
  lingerFinalizeTimer = setTimeout(() => {
    if (!finalized) finalizeTurn(reaped ? 0 : null, null);
  }, TAIL_DRAIN_MS + 1500);
}

const scanner = setInterval(() => {
  scanGates();
  scanStall();
  scanLinger();
}, GATE_SCAN_MS);
scanner.unref(); // the child's pipes own this process's lifetime, not the timer

// ── FOC-1168: the child's remembered lineage ─────────────────────────────────
// The FOC-1162 reap walks the process table from the child's pid through LIVE
// rows only, so `child → X (dead) → Y (alive)` is never reached — and that is
// the shape every real host orphan had (a dead bash between the child and its
// node --test suite; a dead codegraph server between it and its serve
// grandchild). While the child is alive the watcher snapshots the table —
// once shortly after the spawn, then once per LINEAGE_TICK_MS — and remembers
// the verified descendants as pid → {creation, seenMs}. finalizeTurn hands
// the map to the reap, which accepts a row its identity saw before, or one
// born to a remembered (now dead) parent at or before the parent's
// last-seen-alive moment and inside the child's spawn window. An intermediate
// that died between two ticks — alive in no snapshot — stays a documented
// safe miss. Enumeration is sync and bounded (execFileSync with a timeout,
// windowsHide), runs on a timer and never on the child's stdout path, and a
// failure is a note, never a crash.
const LINEAGE_FIRST_TICK_MS = 1_200;
const LINEAGE_TICK_MS = 60_000;
const lineageRemembered = new Map(); // pid → {creation, seenMs}, verified while the child lived
let lineageChildCreation = null; // the child row's creation stamp, from its first snapshot
let lineageScanBusy = false; // the enumeration is sync; never overlap ticks
function scanLineage() {
  if (process.platform !== "win32" || finalized) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (lineageScanBusy) return;
  lineageScanBusy = true;
  try {
    // seenMs is captured BEFORE the enumeration: the snapshot moment is later
    // than this, never earlier, so "born at or before seenMs" stays provable.
    const seenMs = Date.now();
    const table = enumerateWin32Processes();
    if (table.skipped) {
      note({
        subtype: "lineage_scan_skipped",
        message: `lineage scan skipped: ${table.skipped}`,
      });
      return;
    }
    lineageChildCreation = rememberChildLineage(
      table.entries.filter((e) => e.pid !== process.pid),
      child.pid,
      lineageRemembered,
      {
        minCreationMs: childSpawnAt,
        maxCreationMs: Date.now(),
        seenMs,
        childCreation: lineageChildCreation,
      },
    );
  } catch (err) {
    note({
      subtype: "lineage_scan_failed",
      message: `lineage scan failed: ${err.message}`,
    });
  } finally {
    lineageScanBusy = false;
  }
}
if (process.platform === "win32") {
  const lineageFirstTick = setTimeout(scanLineage, LINEAGE_FIRST_TICK_MS);
  lineageFirstTick.unref(); // the child's pipes own this process's lifetime, not the timer
  const lineageTimer = setInterval(scanLineage, LINEAGE_TICK_MS);
  lineageTimer.unref();
}

// FOC-980: the child's Claude Code writes its transcripts as fenix-child with
// mode 0600 — files created DURING the turn stay unreadable to node (pricing,
// telemetry ingest, the follow-up's history copy all hit EACCES). The
// fenix-child-share helper widens the launch dir's *.jsonl files to g+r; the
// watcher shares every 30 s so the api ingests live cost, and once more at
// turn end (finalizeTurn, before pricing). Only when the helper is usable —
// the first call's skip reason is the probe: "not in container" means the
// launch-time handover is all there is, and no timer runs.
const shareConfigDir = process.env.CLAUDE_CONFIG_DIR || null;
const shareProbe = shareChildTranscripts(shareConfigDir);
if (shareProbe.skipped && shareProbe.skipped !== "not in container") {
  note({ subtype: "transcript_share_failed", message: `transcript share skipped: ${shareProbe.skipped}` });
}
const shareTimer = shareProbe.skipped === null && shareConfigDir ? setInterval(() => {
  const r = shareChildTranscripts(shareConfigDir);
  if (r.skipped && r.skipped !== "not in container") {
    note({ subtype: "transcript_share_failed", message: `transcript share skipped: ${r.skipped}` });
  }
}, 30_000) : null;
if (shareTimer) shareTimer.unref(); // the child's pipes own the lifetime, not this timer

// stream-json is NDJSON, but a chunk boundary can land mid-line — buffer until a
// newline or the tee gets corrupt records that nothing downstream can parse.
let buffer = "";
child.stdout.on("data", (chunk) => {
  const text = chunk.toString();
  buffer += text;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      appendFileSync(tee, line + "\n");
    } catch {
      /* nothing useful to do */
    }
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // not every line is guaranteed to be JSON; the tee keeps it regardless
    }

    // FOC-1154: this is the gate's heartbeat — every parsed event refreshes it,
    // so the linger scan below only acts while the LAST event is a `result`.
    lastEventIsResult = event.type === "result";
    // FOC-1160: the short-reap proof arm/disarm. A `result` must have been
    // seen first, and the proof must BE the last parsed event — every other
    // event clears it here, a second proof re-arms it in the same step.
    sawResult = sawResult || lastEventIsResult;
    lastEventProvesEmptyRegistry = sawResult && emptyRegistryProof(event);
    lastEventAt = Date.now();

    if (!sawInit && event.type === "system" && event.subtype === "init" && event.session_id) {
      sessionId = event.session_id;
      initModel = event.model ?? null;
      sawInit = true;
      // This write is what unblocks supervisor-spawn.mjs, which is polling the
      // registry for exactly this field.
      updateChild(runId, childId, { sessionId, status: "running", pid: child.pid });
      // FOC-607: persist the served model as soon as it is known, so a turn that
      // crashes after init still shows what it started on. The local stays the
      // pricing source; this is the durable copy.
      patchTurn({ initModel });
    }
    if (event.type === "result") {
      // Priced from token counts, NOT from the stream's total_cost_usd — that
      // number is Claude Code's estimate for a model it does not recognise, and
      // it is provably wrong (FOC-165: $0.2059 reported for a $0 model). The
      // reported figure is kept beside the computed one so a divergence stays
      // visible instead of one silently replacing the other. FOC-760: stored,
      // not accumulated — modelUsage here is cumulative for the session.
      resultCosts.push(costFromResult(event, initModel, priceOne, thresholdOne));
    }
  }
});

// claude writes diagnostics to stderr; keep them in the tee so a child that dies
// before emitting a single event is still explainable.
child.stderr.on("data", (chunk) => {
  note({ subtype: "stderr", message: chunk.toString().slice(0, 2000) });
});

child.on("error", (err) => {
  removeEnvFile();
  note({ subtype: "spawn_failed", message: err.message });
  clearInterval(scanner);
  scanGates();
  updateChild(runId, childId, {
    status: "crashed",
    exitCode: null,
    endedAt: new Date().toISOString(),
    error: err.message,
  });
  wake({ event: "exit", childId, turn: turnIndex, detail: { status: "crashed", spawnFailed: true } });
  endTelemetryRun(args["telemetry-run"], 1);
  process.exit(1);
});

// FOC-913: the turn is finalized only after the child's stdout is fully
// drained. 'exit' can beat the tail of the pipe — a claude that writes its last
// result events and exits in one burst leaves them in transit, and a finalizer
// that ran on 'exit' froze resultCosts empty (costUsdReported undefined under
// test-suite load). 'close' fires only once every stdio stream is closed, so
// the last 'data' events have landed by then. The bound is for a grandchild
// that inherited the pipe and outlives claude: the registry write cannot wait
// on it forever. TAIL_DRAIN_MS itself is declared beside signalTerminated,
// where terminateTurn can measure against it.
let finalized = false;
// FOC-1162: the instant the child's 'exit' fires, recorded as the creation
// UPPER bound the win32 descendant reap verifies against — a process the
// child spawned was born before this moment, a pid-reuse stranger's child
// after it. The matching lower bound is childSpawnAt, taken at the spawn.
// Declared here because finalizeTurn reads it on every path.
let childExitAt = null;
function finalizeTurn(code, signal) {
  if (finalized) return;
  finalized = true;
  // A finalization in progress is never pre-empted by the terminator: from
  // here to the process.exit at the end, the registry writes and the wake row
  // must be allowed to land (FOC-913 — the old 2 s-from-signal terminator
  // fired first whenever the tail drain was what delayed `close`).
  if (terminatorTimer) clearTimeout(terminatorTimer);
  // FOC-1154: the linger path's own bound dies with the finalization it guards,
  // exactly like the terminator above.
  if (lingerFinalizeTimer) clearTimeout(lingerFinalizeTimer);
  {
  if (buffer.trim()) {
    try {
      appendFileSync(tee, buffer + "\n");
    } catch {
      /* ignore */
    }
  }

  const registry = readRegistry(runId);
  const entry = registry.children[childId] || {};
  const endedAt = new Date().toISOString();

  // `stopped` is set by supervisor-stop.mjs before the kill lands. Do not
  // overwrite it with `crashed` — an operator-requested kill and a child that
  // died on its own are different events, and conflating them would make every
  // deliberate stop look like a failure in the digest.
  //
  // `waiting_gate` is `exited` plus an unanswered question (§2.5). Only the
  // clean-exit branch can become it: a child that crashed or was killed left a
  // gate behind as debris, not as a question anyone should answer, and dressing
  // a crash up as "waiting for Mateusz" would park a dead child in the queue.
  let status = entry.status === "stopped" ? "stopped" : code === 0 ? "exited" : "crashed";
  // FOC-1154: a child reaped after its own terminal `result` did not fail — its
  // work was done, and the non-zero exit code is the artifact of the force kill
  // (taskkill /F on win32), not of the turn. The turn reads as the clean exit
  // it functionally was; `waiting_gate` below still applies to it.
  if (status === "crashed" && lingerReaped) status = "exited";
  if (status === "exited" && hasPendingGate(runId, childId)) status = "waiting_gate";

  // FOC-802, fail closed: the helper refused the launch (exit 97). The turn is
  // a crash no matter what else the exit code might otherwise read as — there
  // is no fallback spawn, so this turn produced no child work at all, and the
  // refusal must not be dressed up as anything else. 97 is deliberately NOT a
  // code a child can produce through this path: a claude exiting 2 under
  // isolation stays a normal exit 2 (crashed), without an isolationError.
  const isolationRefused = isolated && code === 97;
  if (isolationRefused) status = "crashed";

  // ── FOC-1222: a DEV child that ends READY on a dirty tree is flagged ────────
  // Observed on run f43c (FOC-1100): a DEV brief withheld commit authorisation,
  // the child finished READY with tracked changes, and REVIEW/TEST children
  // copied the files from its worktree byte for byte — verdicts with no sha,
  // and worktrees too dirty to reuse. The exit must carry the dirt on its face.
  // Deliberately NOT a new status: the existing statuses are load-bearing
  // (drain logic, quiescence waits, `waiting_gate` semantics), so the flag is a
  // field on the entry plus a note on the exit wake row — the same shape the
  // `sweptPids` audit note takes. Scope: dev only — REVIEW/TEST exit clean by
  // contract. A missing or unreadable worktree records UNKNOWN rather than
  // inventing dirt or staying silent — and so does a dev row with NO worktree
  // field at all: the registry not naming a worktree is itself the finding
  // (r2, FOC-1222), the guard must not filter it out before the check runs.
  let dirtyExit = null;
  if (status === "exited" && entry.squad === "dev") {
    if (!entry.worktree) {
      dirtyExit = { unknown: "no worktree recorded", at: endedAt };
    } else if (!existsSync(entry.worktree)) {
      dirtyExit = { unknown: "worktree missing", at: endedAt };
    } else {
      const dirtyFiles = dirtyTreeReport(entry.worktree);
      if (dirtyFiles.length === 1 && dirtyFiles[0].startsWith("<git status failed")) {
        dirtyExit = { unknown: dirtyFiles[0], at: endedAt };
      } else if (dirtyFiles.length) {
        // The list is capped so a child that left hundreds of files behind
        // cannot bloat the registry row; `count` is the honest total.
        dirtyExit = { files: dirtyFiles.slice(0, 20), count: dirtyFiles.length, at: endedAt };
      }
    }
  }

  // ── FOC-808 (slice B): sweep the helpers the child left behind ─────────────
  // The group kill (the signal path above) reaches the child's own process
  // group; a helper that called setsid left it. Everything the child started
  // inherited LA_CHILD_MARK, so the environment identifies exactly this
  // turn's strays — the group is dead, these are not in it. After the sweep
  // the child's own TMPDIR goes too, unless LA_KEEP_CHILD_TMP=1 keeps it for
  // debugging. All best effort: a failure is a note in the tee, never a crash.
  let sweptPids = [];
  {
    // The registry record (spawn wrote it) is authoritative; the env copy and
    // the attemptId derivation are fallbacks for entries from older spawns.
    // FOC-979: the env mark is trusted only when it belongs to THIS entry —
    // a watcher run inside a foreign child (e.g. the test suite executing
    // inside a Fenix DEV child) inherits that child's mark, and sweeping on
    // it would kill the child that runs the watcher.
    const { mark, foreignEnvMark } = sweepMarkFor(entry, { runId, childId });
    if (foreignEnvMark) {
      note({
        subtype: "child_sweep_foreign_mark",
        message:
          `child sweep ignored a foreign LA_CHILD_MARK (does not belong to ` +
          `${runId}/${childId}): ${foreignEnvMark}`,
      });
    }
    if (mark) {
      try {
        const sweep = sweepChildProcesses({ mark, excludePids: [process.pid] });
        sweptPids = (sweep.killed ?? []).map((k) => k.pid);
        if (sweep.skipped && sweep.skipped !== "no /proc") {
          note({ subtype: "child_sweep_skipped", message: `child sweep skipped: ${sweep.skipped}` });
        }
        if (sweep.unsignalled?.length) {
          note({
            subtype: "child_sweep_unsignalled",
            message:
              `child sweep: ${sweep.unsignalled.length} marked process(es) could not be signalled ` +
              `[${sweep.unsignalled.map((u) => `${u.pid} ${u.comm || "unknown"} ${u.code}`).join(", ")}]`,
          });
        }
        if (sweptPids.length) {
          note({
            subtype: "child_sweep",
            message:
              `child sweep: killed ${sweptPids.length} stray process(es) ` +
              `[${sweep.killed.map((k) => `${k.pid} ${k.comm || "unknown"}`).join(", ")}]`,
          });
        }
      } catch (err) {
        note({ subtype: "child_sweep_failed", message: err.message });
      }
    }
    // The tmp dir removal is guarded twice: on the mark (this watcher genuinely
    // being a spawn child) AND on the path — the registry's tmpDir (spawn
    // recorded it) or the env TMPDIR, and only when it sits under
    // <os tmpdir>/fenix-child/. A watcher run by hand with an ambient TMPDIR
    // (/tmp, the operator's own dir) must never have it rm -rf'd.
    // The per-child dir is always <tmp root>/fenix-child/<childId> — spawn made
    // it so. os.tmpdir() cannot name that root here: on POSIX it honours TMPDIR,
    // which for this very process IS the per-child dir. The shape is the guard:
    // a parent named exactly fenix-child and a non-empty leaf.
    const childTmpCandidate = entry.tmpDir || process.env.TMPDIR || null;
    const childTmpDir = childTmpCandidate ? resolve(childTmpCandidate) : null;
    const childTmpRoot = childTmpDir !== null ? dirname(childTmpDir) : null;
    const childTmpUnderRoot =
      childTmpDir !== null &&
      basename(childTmpRoot) === "fenix-child" &&
      basename(childTmpDir).length > 0 &&
      dirname(childTmpRoot) !== childTmpRoot;
    if (mark && childTmpDir && process.env.LA_KEEP_CHILD_TMP !== "1") {
      if (childTmpUnderRoot) {
        try {
          rmSync(childTmpDir, { recursive: true, force: true });
        } catch (err) {
          note({ subtype: "child_tmpdir_remove_failed", message: err.message });
        }
      } else {
        note({
          subtype: "child_tmpdir_skipped",
          message: `child tmpdir is not a fenix-child dir: ${childTmpDir} — left in place`,
        });
      }
    }
  }

  // ── FOC-1162 (win32): reap the descendants the child left behind ───────────
  // The FOC-808 sweep above reaches only what carries LA_CHILD_MARK, and on
  // win32 there is no /proc to read — a grandchild the child spawned and left
  // behind survives it, and killTree walks from a live parent, which the
  // child no longer is. So the reap walks the process table from the child's
  // pid instead, verifies every candidate against the child's spawn window
  // (a stale pre-spawn row or a reused pid is refused, never killed), and
  // kills the verified tree tops
  // with the same force taskkill the linger path uses. Only a child that
  // demonstrably exited is reaped: a turn the linger path is still fighting
  // for keeps its own semantics (its kill already walks the live tree), and a
  // turn with no exit anchor has no bound to verify against. All best
  // effort — a failure is a note in the tee, never a crash.
  let reapedTreePids = [];
  if (
    process.platform === "win32" &&
    childExitAt !== null &&
    (child.exitCode !== null || child.signalCode !== null)
  ) {
    try {
      const reap = reapChildDescendants({
        rootPid: child.pid,
        exitAtMs: childExitAt,
        spawnAtMs: childSpawnAt,
        remembered: lineageRemembered,
        excludePids: [process.pid],
      });
      reapedTreePids = (reap.killed ?? []).filter((k) => k.ok).map((k) => k.pid);
      if (reap.skipped) {
        note({
          subtype: "child_tree_reap_skipped",
          message: `win32 descendant reap skipped: ${reap.skipped}`,
        });
      }
      if (reapedTreePids.length) {
        note({
          subtype: "child_tree_reap",
          message:
            `win32 descendant reap: killed ${reapedTreePids.length} stray process(es) ` +
            `[${reap.killed
              .filter((k) => k.ok)
              .map((k) => `${k.pid} ${k.name || "unknown"}`)
              .join(", ")}]`,
        });
      }
      if (reap.survivors?.length) {
        note({
          subtype: "child_tree_reap_survivors",
          message:
            `win32 descendant reap: ${reap.survivors.length} verified descendant(s) survived the kill ` +
            `[${reap.survivors.map((s) => `${s.pid} ${s.name || "unknown"}`).join(", ")}]`,
        });
      }
    } catch (err) {
      note({ subtype: "child_tree_reap_failed", message: err.message });
    }
  }

  const turns = entry.turns || [];
  // FOC-607: the turn closes with what was requested vs what actually served —
  // initModel is null when the child never emitted system/init.
  turns[turnIndex] = {
    ...(turns[turnIndex] || {}),
    endedAt,
    exitCode: code,
    requestedModel,
    initModel,
    // FOC-808 (slice B): the pids the sweep killed — the registry record the
    // plan names, so a turn's teardown is auditable without the tee.
    sweptPids,
    // FOC-1162: the child's descendants the win32 reap verified and killed —
    // beside sweptPids, same audit rule.
    reapedTreePids,
    // FOC-1154: the last-resort finalize after both force kills failed — the
    // child may still be alive; the Supervisor should see why this turn closed
    // without an exit.
    ...(lingerReapFailed ? { lingerReapFailed: true } : {}),
    ...(isolationRefused
      ? { isolationError: "spawn refused by the isolation helper (exit 97) — no unisolated fallback" }
      : {}),
  };
  removeEnvFile();
  if (isolationRefused) {
    note({
      subtype: "isolation_refused",
      message: "fenix-spawn-as-child refused the launch (exit 97) — failing closed, no unisolated spawn",
    });
  }

  // FOC-760: the child's cost is SET from its own transcripts — whole-session
  // truth, one row per assistant message — not added to what the entry already
  // carried (the old accumulation ran the registry at ~5x ground truth, because
  // result.modelUsage is cumulative for the session). No transcript found right
  // after a turn should be rare; then turnEndCostPatch falls back to the MAX of
  // this turn's cumulative result snapshots, never their sum. Pricing failure
  // is a note, not a dead turn — the fallback still applies.
  let transcriptCost = null;
  try {
    // FOC-980: share the transcripts the child created during THIS turn before
    // pricing reads them — the 30 s timer may not have caught the last writes.
    // Best effort: a failure is a tee note, never a dead turn, and the
    // zero-message guard in turnEndCostPatch still falls through to result-max.
    const share = shareChildTranscripts(process.env.CLAUDE_CONFIG_DIR || squadConfigDir(entry.squad));
    if (share.skipped && share.skipped !== "not in container") {
      note({ subtype: "transcript_share_failed", message: `transcript share skipped: ${share.skipped}` });
    }
    // Both the pre-turn registry id (captured before init overwrote it) and
    // this turn's init id — filtered, distinct. A resume that forked a new
    // session id prices BOTH transcripts; an unchanged one dedupes to one.
    transcriptCost = priceChildTranscripts(
      {
        configDir: process.env.CLAUDE_CONFIG_DIR || squadConfigDir(entry.squad),
        cwd,
        sessionId: sessionId ?? entry.sessionId,
        sessionIds: [...new Set([previousSessionId, sessionId ?? entry.sessionId].filter(Boolean))],
      },
      { priceOne, thresholdOne },
    );
  } catch (err) {
    note({ subtype: "transcript_cost_failed", message: err.message });
    transcriptCost = null;
  }

  // FOC-730: retire this turn's turn-scoped facts and record it on the child.
  // Best effort: a store failure writes one stderr line plus a tee note and
  // never blocks the wake or the status write below.
  //
  // FOC-1010: the prune runs BEFORE the status write, and its record rides in
  // the same registry patch. updateChild is an unlocked read-modify-write whose
  // safety rests on "after spawn, only the watcher writes this entry" — but
  // anyone who waits for `status: exited` (the Supervisor, a test editing the
  // entry) treats that status as the end of the watcher's writes. A second
  // updateChild after it re-read the entry and could land AFTER a writer that
  // keyed off `exited`, silently restoring whatever that writer had changed
  // (the provider deletion in supervisor-followup.test). With one write, the
  // terminal status IS the watcher's last registry write.
  let workingStatePrunedPatch = {};
  try {
    const retired = pruneTurnWorkingState();
    if (retired != null) {
      workingStatePrunedPatch = {
        workingStatePruned: {
          ...(entry.workingStatePruned ?? {}),
          turn: { at: endedAt, retired },
        },
      };
    }
  } catch (err) {
    const reason = err?.message ?? String(err);
    try {
      // writeSync, not process.stderr.write: process.exit below would drop
      // buffered pipe output on win32.
      writeSync(2, `agent-state: turn prune skipped (${reason})\n`);
    } catch {
      /* stdio is 'ignore' on a detached watcher — the tee note carries it */
    }
    note({ subtype: "agent_state_prune_skipped", message: reason });
  }

  // The watcher's LAST registry write for this turn (see the FOC-1010 note
  // above): terminal status, exit details, cost, the closed turn record and the
  // prune record, in one read-modify-write.
  updateChild(runId, childId, {
    status,
    exitCode: code,
    signal: signal || null,
    endedAt,
    // FOC-802: the refusal is a clear error at entry level too, so a reader
    // that never opens `turns` still sees why the child crashed.
    ...(isolationRefused
      ? { error: "isolated spawn refused by fenix-spawn-as-child (exit 97) — child not launched, no unisolated fallback" }
      : {}),
    ...turnEndCostPatch({ entry, transcriptCost, results: resultCosts }),
    turns,
    // FOC-1222: the dirt the child left behind, visible on the entry itself.
    ...(dirtyExit ? { dirtyExit } : {}),
    ...workingStatePrunedPatch,
  });

  if (!sawInit) {
    note({ subtype: "no_init", message: "child exited before emitting system/init — no session_id, not resumable" });
  }

  // One row for this turn's end, whatever the final status — `waiting_gate`
  // included. The gate itself got its own row from the final scan above; the
  // exit is a separate event with its own dedup key.
  clearInterval(scanner);
  if (shareTimer) clearInterval(shareTimer); // FOC-980: the turn is over — stop the 30 s share
  scanGates();
  // FOC-1154: `finishedLingering` marks the exit as a reap after a terminal
  // result; `lingerReapFailed` marks the last-resort finalize where both kills
  // failed and the child may still be alive. The event type stays `exit`, so
  // drain logic and quiescence waits see exactly the row they always saw.
  wake({
    event: "exit",
    childId,
    turn: turnIndex,
    detail: {
      status,
      exitCode: code,
      ...(lingerReaped ? { finishedLingering: true } : {}),
      // FOC-1160: which reap landed — `finishedLingeringShort` only ever rides
      // a short reap, so the exit row distinguishes the two without a new
      // event class (the drain logic sees the `exit` row it always saw).
      ...(lingerReapShort ? { finishedLingeringShort: true } : {}),
      ...(lingerReapFailed ? { lingerReapFailed: true } : {}),
      // FOC-1222: the wake-row note beside the entry flag — a drain reader
      // sees the dirt without opening the registry.
      ...(dirtyExit ? { dirtyExit } : {}),
    },
  });

  endTelemetryRun(args["telemetry-run"], code ?? 1);
  process.exit(signalTerminated ?? 0);
  }
}

child.on("exit", (code, signal) => {
  // FOC-1162: this is the reap's creation bound — see childExitAt above.
  childExitAt = Date.now();
  // The stream tail gets a bounded window to land; 'close' below normally
  // finalizes within milliseconds of 'exit'.
  setTimeout(() => finalizeTurn(code, signal), TAIL_DRAIN_MS);
});
child.on("close", (code, signal) => finalizeTurn(code, signal));
