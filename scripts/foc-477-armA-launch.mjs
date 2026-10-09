#!/usr/bin/env node
// scripts/foc-477-armA-launch.mjs — FOC-477 arm-A harness launcher (NOT the instrument).
//
// One startup script for an arm-A graph run. It sets the two environment
// variables `defaultGateEmitter` needs (LA_SUPERVISOR_RUN, LA_SUPERVISOR_CHILD),
// registers the deterministic child id in that run's children.json so
// `supervisor-gate.mjs emit` can route and answer the gate, writes the launch
// record, then execs graph-runner with the SAME arguments previous attempts
// used. Zero changes to graph-runner.mjs and to the frozen configs: this file is
// harness, not instrument (runnerSha stays a1f8577e328fd94bf6f5f52fd70b3e02db5fcdc8).
//
// Why the child must be registered: `supervisor-gate.mjs` cmdEmit refuses a gate
// from a child nobody registered ("A gate from a child nobody registered cannot
// be answered"). Attempt 2 died on the env half of this; the registry half is the
// other precondition, and this launcher turns both.
//
// Usage:
//   node scripts/foc-477-armA-launch.mjs --child arma-03-foc236-a3 \
//     [--wake-run <supervisorSessionRunId>] [--task FOC-236] [--squad plan] \
//     [--worktree <path>] [--register-only] \
//     -- run --run-id <graphRunId> --inputs @<inputs.json>
//
//   --child       REQUIRED. Deterministic arm-A child id, shape
//                 arma-<NN>-<issue>-a<attempt> (protocol §4.3b), so gates come
//                 out gate-<child>-<seq>.
//   --wake-run    The supervisor run whose wake-queue the session waker watches.
//                 arm A has no watcher (supervisor-watch.mjs is the single queue
//                 writer and only runs for spawned claude children), so this
//                 launcher bridges the gate row there. The canonical row still
//                 lands in the arm-A run's own queue next to gates/ and
//                 children.json. Omit to skip the bridge entirely.
//   --task        Issue id for children.json.taskId. Defaults to FOC-<NN>
//                 parsed out of the child id.
//   --squad       children.json.squad (default "plan").
//   --worktree    children.json.worktree (default the repo root).
//   --register-only  Register the child and write the launch record, do not run.
//
// Everything after `--` is forwarded to scripts/graph-runner.mjs verbatim.
// stdout: one JSON launch record (ok | not-ok). stderr: human log.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ROOT,
  parseArgs,
  failJson,
  updateChild,
  appendWakeEvent,
  runDir,
  registryPath,
} from "./supervisor-lib.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));

// The instrument, unchanged. The launcher never edits it — only invokes it.
const GRAPH_RUNNER = join(__dir, "graph-runner.mjs");
const RUNNER_SHA_EXPECTED = "a1f8577e328fd94bf6f5f52fd70b3e02db5fcdc8";

// §4.3b: arma-<NN>-<issue>-a<attempt>, e.g. arma-03-foc236-a3. The gate id is
// gate-<child>-<seq>, which is the shape both arms share.
const CHILD_ID_RE = /^arma-(\d{2})-([a-z0-9]+)-a(\d+)$/;

function gitHashObject(path) {
  const res = spawnSync("git", ["hash-object", path], { cwd: ROOT, encoding: "utf8" });
  return res.status === 0 ? res.stdout.trim() : null;
}

function sha256Of(path) {
  // Fallback when git is unavailable: still a stable content identity, just not
  // the git blob sha the campaign record uses. Say which one it is in the record.
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// The launcher's own identity, recorded next to runnerSha. Same convention as
// the campaign's runnerSha: `git hash-object` of the file.
function selfSha() {
  const blob = gitHashObject(fileURLToPath(import.meta.url));
  if (blob) return { launcherSha: blob, launcherShaKind: "git-blob" };
  return { launcherSha: sha256Of(fileURLToPath(import.meta.url)), launcherShaKind: "sha256" };
}

function findRunnerArg(argv, name) {
  // graph-runner's CLI: run|decide|status --run-id --inputs --edge --state --store
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return null;
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? null : v;
}

function taskFromChildId(childId) {
  const m = CHILD_ID_RE.exec(childId);
  return m ? `FOC-${m[2].replace(/^foc/i, "")}` : null;
}

function main() {
  const argv = process.argv.slice(2);
  const sep = argv.indexOf("--");
  if (sep === -1) {
    return failJson("the graph-runner argv must follow a `--` separator — nothing is forwarded implicitly", {
      usage:
        "node scripts/foc-477-armA-launch.mjs --child arma-03-foc236-a3 [--wake-run <id>] -- run --run-id <id> --inputs @<path>",
    });
  }
  const harnessArgv = argv.slice(0, sep);
  const runnerArgv = argv.slice(sep + 1);
  const args = parseArgs(harnessArgv);

  const childId = args.child;
  if (!childId || childId === true) {
    return failJson("--child <arma-NN-issue-aN> is required (protocol §4.3b)");
  }
  if (!CHILD_ID_RE.test(childId)) {
    return failJson(`--child "${childId}" is not the §4.3b shape arma-<NN>-<issue>-a<attempt>`, {
      example: "arma-03-foc236-a3",
    });
  }
  if (!runnerArgv.length) {
    return failJson("no graph-runner argv after `--`");
  }

  // LA_SUPERVISOR_RUN = the run being started (the arm-A run id), the same value
  // as graph-runner's --run-id. That is what puts gates/, children.json and
  // wake-queue.jsonl under one run dir — which is what foc-477-measure.mjs
  // reads (loadArmFromDisk) and what Q5 books the PLAN child into.
  const runId = findRunnerArg(runnerArgv, "run-id");
  if (!runId) {
    return failJson("the forwarded argv carries no --run-id — LA_SUPERVISOR_RUN has nothing to point at");
  }
  const inputsArg = findRunnerArg(runnerArgv, "inputs");
  const taskId = args.task && args.task !== true ? String(args.task) : taskFromChildId(childId);
  const squad = args.squad && args.squad !== true ? String(args.squad) : "plan";
  const worktree = args.worktree && args.worktree !== true ? resolve(String(args.worktree)) : ROOT;
  const wakeRun = args["wake-run"] && args["wake-run"] !== true ? String(args["wake-run"]) : null;
  const registerOnly = args["register-only"] === true;

  // The runner itself is the instrument. Confirm its sha rather than trust the
  // caller: a run recorded against a drifted runnerSha is not comparable.
  const runnerSha = gitHashObject(GRAPH_RUNNER);
  const runnerDrift = runnerSha !== null && runnerSha !== RUNNER_SHA_EXPECTED;

  // Register the child BEFORE anything can emit a gate. Fields cmdEmit reads:
  // squad (into the gate record), taskId (into the gate record), worktree
  // (resolves relative --artifact paths).
  const entry = {
    childId,
    squad,
    taskId,
    worktree,
    status: "running",
    arm: "A",
    instrument: "graph-runner",
    runnerSha: runnerSha ?? RUNNER_SHA_EXPECTED,
    launcher: "scripts/foc-477-armA-launch.mjs",
    spawnedAt: new Date().toISOString(),
    pid: process.pid,
    costUsd: 0,
    costUsdReported: null,
    note: "arm-A runner child — gate emitter context, not a claude -p session (no tee)",
  };
  updateChild(runId, childId, entry);

  const startLine =
    `node scripts/foc-477-armA-launch.mjs --child ${childId}` +
    (wakeRun ? ` --wake-run ${wakeRun}` : "") +
    (args.task ? ` --task ${String(args.task)}` : "") +
    (args["register-only"] === true ? " --register-only" : "") +
    ` -- ${runnerArgv.join(" ")}`;

  const record = {
    type: "armA.launch",
    ok: true,
    startedAt: entry.spawnedAt,
    runId,
    childId,
    taskId,
    squad,
    worktree,
    wakeRun,
    registerOnly,
    startLine,
    env: {
      LA_SUPERVISOR_RUN: runId,
      LA_SUPERVISOR_CHILD: childId,
      ...(wakeRun ? { LA_SUPERVISOR_WAKE_RUN: wakeRun } : {}),
    },
    runnerArgv,
    inputsArg,
    runnerSha: runnerSha ?? null,
    runnerShaExpected: RUNNER_SHA_EXPECTED,
    runnerDrift,
    ...selfSha(),
    childRegistered: { registry: registryPath(runId), entry },
  };

  const runDirAbs = runDir(runId);
  mkdirSync(runDirAbs, { recursive: true });
  const launchRecordPath = join(runDirAbs, "armA-launch.json");

  console.error(
    `[armA-launch] run=${runId} child=${childId} wakeRun=${wakeRun ?? "(none)"}\n` +
      `[armA-launch] LA_SUPERVISOR_RUN=${runId} LA_SUPERVISOR_CHILD=${childId}\n` +
      `[armA-launch] registered ${childId} in ${registryPath(runId)}\n` +
      `[armA-launch] runnerSha=${record.runnerSha ?? "unavailable"}${runnerDrift ? " (DRIFT vs " + RUNNER_SHA_EXPECTED + ")" : ""}\n` +
      `[armA-launch] launcherSha=${record.launcherSha} (${record.launcherShaKind})\n` +
      `[armA-launch] startLine: ${startLine}`,
  );

  if (registerOnly) {
    writeFileSync(launchRecordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    return console.log(JSON.stringify({ ...record, launchRecordPath, result: "register-only" }, null, 2));
  }

  // Same arguments as before — forwarded verbatim. The env is the only thing
  // this launcher adds, and it is exactly the pair defaultGateEmitter reads.
  const childEnv = {
    ...process.env,
    LA_SUPERVISOR_RUN: runId,
    LA_SUPERVISOR_CHILD: childId,
    ...(wakeRun ? { LA_SUPERVISOR_WAKE_RUN: wakeRun } : {}),
  };
  const res = spawnSync(process.execPath, [GRAPH_RUNNER, ...runnerArgv], {
    cwd: ROOT,
    env: childEnv,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });

  let runnerOut = null;
  try {
    runnerOut = JSON.parse(res.stdout ?? "");
  } catch {
    runnerOut = { ok: false, error: "graph-runner stdout was not JSON", raw: (res.stdout ?? "").slice(0, 4000) };
  }

  // The wake bridge. arm A has no supervisor-watch.mjs, so nothing else appends
  // to the wake queue; without this row the session waker never learns a gate
  // appeared. Canonical row: the arm-A run's own queue. Bridged row: --wake-run,
  // the queue the Stop-hook waker actually polls. Dedup is by wakeDedupKey, so
  // a re-launch of the same gate does not double-wake.
  const gateId = runnerOut?.record?.gateId ?? runnerOut?.record?.output?.gateId ?? null;
  const stoppedAtGate =
    runnerOut?.status === "stopped" && (runnerOut?.record?.status === "gate-pending" || Boolean(gateId));
  const wakeRows = [];
  if (stoppedAtGate && gateId) {
    const ev = {
      event: "gate",
      childId,
      turn: 0,
      gateId,
      detail: {
        runId,
        stepId: runnerOut?.stepId ?? null,
        kind: runnerOut?.record?.output?.kind ?? null,
        source: "foc-477-armA-launch",
      },
    };
    try {
      const own = appendWakeEvent(runId, ev);
      if (own) wakeRows.push({ queue: runId, row: own });
    } catch (err) {
      wakeRows.push({ queue: runId, error: err?.message ?? String(err) });
    }
    if (wakeRun) {
      try {
        const bridged = appendWakeEvent(wakeRun, { ...ev, detail: { ...ev.detail, bridgedFrom: runId } });
        if (bridged) wakeRows.push({ queue: wakeRun, row: bridged });
      } catch (err) {
        wakeRows.push({ queue: wakeRun, error: err?.message ?? String(err) });
      }
    }
    console.error(`[armA-launch] gate ${gateId} pending — wake row(s): ${wakeRows.map((w) => w.queue).join(", ") || "none"}`);
  }

  const out = {
    ...record,
    launchRecordPath,
    finishedAt: new Date().toISOString(),
    runnerExitCode: res.status,
    runnerSignal: res.signal,
    result: runnerOut,
    stderrTail: (res.stderr ?? "").split(/\r?\n/).slice(-20).join("\n"),
    wakeRows,
  };
  writeFileSync(launchRecordPath, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(out, null, 2));
  process.exit(res.status ?? 0);
}

main();
