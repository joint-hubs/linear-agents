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
// Not invoked by hand. supervisor-spawn.mjs (and later supervisor-followup.mjs)
// start it with { detached: true, stdio: 'ignore' } + unref.

import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

import {
  ROOT,
  claudeCommand,
  parseArgs,
  readRegistry,
  teeAbsPath,
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

const { command, args: spawnArgs } = claudeCommand(claudeArgs);

const child = spawn(command, spawnArgs, {
  cwd,
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});

const turnIndex = Number(args.turn ?? 0);
let sessionId = null;
let costUsd = 0;
let sawInit = false;

function patchTurn(patch) {
  const registry = readRegistry(runId);
  const entry = registry.children[childId];
  if (!entry) return;
  const turns = entry.turns || [];
  turns[turnIndex] = { ...(turns[turnIndex] || {}), ...patch };
  updateChild(runId, childId, { turns });
}

patchTurn({ pid: child.pid, startedAt: new Date().toISOString(), endedAt: null, exitCode: null });

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
      sawInit = true;
      // This write is what unblocks supervisor-spawn.mjs, which is polling the
      // registry for exactly this field.
      updateChild(runId, childId, { sessionId, status: "running", pid: child.pid });
    }
    if (event.type === "result") {
      if (typeof event.total_cost_usd === "number") costUsd += event.total_cost_usd;
      else if (typeof event.cost_usd === "number") costUsd += event.cost_usd;
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
  updateChild(runId, childId, {
    status: "crashed",
    exitCode: null,
    endedAt: new Date().toISOString(),
    error: err.message,
  });
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
  const status = entry.status === "stopped" ? "stopped" : code === 0 ? "exited" : "crashed";

  const turns = entry.turns || [];
  turns[turnIndex] = { ...(turns[turnIndex] || {}), endedAt, exitCode: code };

  updateChild(runId, childId, {
    status,
    exitCode: code,
    signal: signal || null,
    endedAt,
    costUsd: (entry.costUsd || 0) + costUsd,
    turns,
  });

  if (!sawInit) {
    note({ subtype: "no_init", message: "child exited before emitting system/init — no session_id, not resumable" });
  }

  endTelemetryRun(args["telemetry-run"], code ?? 1);
  process.exit(0);
});
