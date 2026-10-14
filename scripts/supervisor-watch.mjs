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

import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { calculateCost, priceThreshold, pricingSnapshot } from "./telemetry-store.mjs";
import { priceChildTranscripts } from "./transcript-cost.mjs";
import { squadConfigDir } from "./fenix-paths.mjs";

import {
  ROOT,
  appendWakeEvent,
  claudeCommand,
  costFromResult,
  gatesDir,
  hasPendingGate,
  parseArgs,
  readRegistry,
  stallSilenceMs,
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
    });
  } catch (err) {
    note({ subtype: "telemetry_end_failed", message: err.message });
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

const turnIndex = Number(args.turn ?? 0);

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
      { cwd, stdio: "ignore" },
    );
  } catch (err) {
    note({ subtype: "telemetry_reopen_failed", message: err.message });
  }
}
if (turnIndex > 0) reopenTelemetryRun(args["telemetry-run"], turnIndex);

const child = spawn(command, spawnArgs, {
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
});

let sessionId = null;
// FOC-760: the costFromResult outputs of this turn, kept in order and resolved
// ONCE at exit. Each is a session-cumulative snapshot — they are never summed
// here, and no accumulator runs during the turn; turnEndCostPatch decides at
// the end what the registry entry is set to.
const resultCosts = [];
let initModel = null;
let sawInit = false;

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

patchTurn({ pid: child.pid, startedAt: new Date().toISOString(), endedAt: null, exitCode: null });

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

const scanner = setInterval(() => {
  scanGates();
  scanStall();
}, GATE_SCAN_MS);
scanner.unref(); // the child's pipes own this process's lifetime, not the timer

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

    if (!sawInit && event.type === "system" && event.subtype === "init" && event.session_id) {
      sessionId = event.session_id;
      initModel = event.model ?? null;
      sawInit = true;
      // This write is what unblocks supervisor-spawn.mjs, which is polling the
      // registry for exactly this field.
      updateChild(runId, childId, { sessionId, status: "running", pid: child.pid });
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

child.on("exit", (code, signal) => {
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
  if (status === "exited" && hasPendingGate(runId, childId)) status = "waiting_gate";

  const turns = entry.turns || [];
  turns[turnIndex] = { ...(turns[turnIndex] || {}), endedAt, exitCode: code };

  // FOC-760: the child's cost is SET from its own transcripts — whole-session
  // truth, one row per assistant message — not added to what the entry already
  // carried (the old accumulation ran the registry at ~5x ground truth, because
  // result.modelUsage is cumulative for the session). No transcript found right
  // after a turn should be rare; then turnEndCostPatch falls back to the MAX of
  // this turn's cumulative result snapshots, never their sum. Pricing failure
  // is a note, not a dead turn — the fallback still applies.
  let transcriptCost = null;
  try {
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

  updateChild(runId, childId, {
    status,
    exitCode: code,
    signal: signal || null,
    endedAt,
    ...turnEndCostPatch({ entry, transcriptCost, results: resultCosts }),
    turns,
  });

  if (!sawInit) {
    note({ subtype: "no_init", message: "child exited before emitting system/init — no session_id, not resumable" });
  }

  // One row for this turn's end, whatever the final status — `waiting_gate`
  // included. The gate itself got its own row from the final scan above; the
  // exit is a separate event with its own dedup key.
  clearInterval(scanner);
  scanGates();
  wake({ event: "exit", childId, turn: turnIndex, detail: { status, exitCode: code } });

  endTelemetryRun(args["telemetry-run"], code ?? 1);
  process.exit(0);
});
