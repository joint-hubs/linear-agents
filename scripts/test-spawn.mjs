#!/usr/bin/env node
// scripts/test-spawn.mjs — one spawn helper for real servers in tests (FOC-840).
//
// Generalises the spawnIsolatedServer shape from settings-acceptance.mjs:
// probe a free port, spawn the server child, poll a health endpoint, hand the
// caller a stop() that tree-kills. Every spawned child is registered as one
// JSONL row in the file named by LA_TEST_SPAWN_REGISTRY (set by the test runner
// for the whole run) and tracked in-process, so:
//   - scripts/test-run.mjs can sweep registered-but-still-alive servers after
//     the lanes resolve and fail the run on them — a plain exit that leaks a
//     server must STAY a leak so the run turns red (see installTestSpawnHandlers);
//   - signal and crash handlers installed once per process tree-kill everything
//     this process spawned — no more `child.kill()` leaving grandchildren behind
//     when a test file is interrupted.
//
// Registry row: { pid, port, script, label, file: <caller test file>, startedAt }.
// stop() appends a tombstone row ({ pid, stoppedAt, file }); a spawn row still
// open (no tombstone after it) at sweep time means an orphan.

import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { killTree } from "./supervisor-lib.mjs";

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// ── registry (JSONL, one row per spawned server) ─────────────────────────────

const registryPath = () => process.env.LA_TEST_SPAWN_REGISTRY;

/** Parse the registry; a missing file, torn or foreign lines are skipped. */
export function registryRows(path) {
  if (!path || !existsSync(path)) return [];
  const rows = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch { /* best effort — a torn line is worse data, not a crash */ }
  }
  return rows;
}

function appendRegistryRow(row) {
  const path = registryPath();
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(row) + "\n");
  } catch { /* best effort — the sweep can only see rows that got written */ }
}

/** Fold the raw rows in file order: a spawn row (has port/script, no
 * stoppedAt) opens the pid, a tombstone (has stoppedAt) closes it; a later
 * spawn row re-opens a reused pid. Returns the still-open rows only. */
export function openRegistryRows(path) {
  const open = new Map();
  for (const row of registryRows(path)) {
    if (row.stoppedAt !== undefined) open.delete(row.pid);
    else open.set(row.pid, row);
  }
  return [...open.values()];
}

/** Deregister a pid by appending a tombstone row — appendFileSync is the only
 * interleaving-safe operation on the shared JSONL across parallel lanes, so
 * deregistration never rewrites lines another lane may have appended. */
function appendTombstone(pid) {
  appendRegistryRow({ pid, stoppedAt: new Date().toISOString(), file: process.argv[1] });
}

// ── pid probing ───────────────────────────────────────────────────────────────

/** Linux: has the pid exited without its parent (or init) having reaped it yet? kill(pid, 0) still
 * succeeds on such a zombie although nothing runs. The state letter follows the LAST ") " of
 * /proc/<pid>/stat (the command name in between may itself hold spaces and parens). */
function isZombie(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat[stat.lastIndexOf(") ") + 2] === "Z";
  } catch {
    return false; // no /proc (macOS) or already gone
  }
}

/** Is a pid alive? win32: `tasklist /FI` token match; POSIX: kill(pid, 0) —
 * EPERM counts alive, ESRCH does not — and a zombie is not alive: an orphan the sweep just SIGKILLed
 * stays a zombie until PID 1 of a container gets scheduled to reap it, and under a loaded CI runner
 * that is long enough for a check right after the run to see it (FOC-840 flake on PR #152). */
export function probePid(pid) {
  if (!pid) return false;
  if (process.platform === "win32") {
    const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { encoding: "utf8" });
    return (r.stdout || "").split(/\s+/).includes(String(pid));
  }
  try {
    process.kill(pid, 0);
  } catch (err) {
    return err.code === "EPERM"; // alive, just not ours to signal
  }
  return !isZombie(pid);
}

// ── process-wide handlers ─────────────────────────────────────────────────────

const tracked = new Set(); // every child this process spawned and has not released

let handlersInstalled = false;

/**
 * Install, once per process, the cleanup net for every tracked child:
 *   SIGINT/SIGTERM/SIGHUP     tree-kill all, then re-raise (default disposition)
 *   uncaughtException /
 *   unhandledRejection        tree-kill all, print the error, exit 1
 *
 * Deliberately NO 'exit' handler: a plain process.exit() that leaks a spawned
 * server into the registry file must stay a leak, so the runner's sweep turns
 * the run red (FOC-840 AC-3). An exit-time tree-kill would silently reap
 * exactly the forgotten-stop leak the sweep exists to catch — hard kills
 * (SIGKILL/taskkill /T) never run 'exit' handlers anyway; the runner's own
 * killTree covers those.
 */
export function installTestSpawnHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;

  const killAll = () => {
    for (const child of tracked) killTree(child.pid, "force");
  };

  const signalNumbers = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };
  const onSignal = (signal) => {
    killAll();
    // Re-raise with the default disposition: drop our own listener first, so
    // the re-raised signal is not caught by this handler again.
    try {
      process.removeListener(signal, onSignal);
      process.kill(process.pid, signal);
    } catch {
      process.exit(128 + (signalNumbers[signal] || 1));
    }
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    try {
      process.on(signal, onSignal);
    } catch { /* a platform may not implement the signal */ }
  }

  const crash = (err) => {
    killAll();
    console.error(err);
    process.exit(1);
  };
  process.on("uncaughtException", crash);
  process.on("unhandledRejection", crash);
}

// ── the helper ────────────────────────────────────────────────────────────────

/** Free localhost port (bound and released before the real listener takes it). */
function freePort() {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Resolve true when the exit event fired, false on timeout. */
function waitForExit(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * Spawn `script` as a detached (except win32) child of this test, on a free
 * port, and wait until its health endpoint answers.
 *
 * @param {object}  opts
 * @param {string}  opts.script     absolute or resolvable path to the server script
 * @param {string[]} [opts.args]    extra argv for the child
 * @param {object}  [opts.env]      extra env for the child (over process.env)
 * @param {boolean} [opts.inheritEnv] merge process.env under opts.env (default
 *                            true); false passes exactly opts.env plus the
 *                            port var — for callers whose env is already complete
 * @param {number}  [opts.port]     fixed port to bind instead of probing a free
 *                            one; still recorded in the row and the health URL
 * @param {string}  [opts.healthUrl] full URL template; "{port}" is substituted
 * @param {string}  [opts.healthPath] path appended to the default 127.0.0.1 URL
 * @param {string}  [opts.portEnv]  env var carrying the port (TELEMETRY_PORT)
 * @param {number}  [opts.timeoutMs] health deadline (20000)
 * @param {string}  [opts.cwd]      child working directory
 * @param {string}  [opts.label]    free-form tag stored in the registry row
 * @returns {Promise<{child, port, stop}>}
 */
export async function spawnTestServer({
  script,
  args = [],
  env = {},
  inheritEnv = true,
  port: portOption,
  healthUrl,
  healthPath = "/api/telemetry/health",
  portEnv = "TELEMETRY_PORT",
  timeoutMs = 20000,
  cwd,
  label,
} = {}) {
  if (!script) throw new Error("spawnTestServer: script is required");
  installTestSpawnHandlers();

  const port = portOption ?? (await freePort());
  const url =
    healthUrl !== undefined
      ? healthUrl.replace(/\{port\}/g, String(port))
      : `http://127.0.0.1:${port}${healthPath}`;

  const childEnv = inheritEnv ? { ...process.env, ...env } : { ...env };
  childEnv[portEnv] = String(port);

  const child = nodeSpawn(process.execPath, [script, ...args], {
    env: childEnv,
    cwd,
    // Detached on every platform: POSIX children lead their own process group
    // for killTree(-pid), and the server's lifetime never depends on the
    // parent's handles. windowsHide suppresses the console window on win32;
    // taskkill /T /F reaches the detached tree.
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdoutBuf = "";
  child.stderrBuf = "";
  child.stdout.on("data", (c) => { child.stdoutBuf += c; });
  child.stderr.on("data", (c) => { child.stderrBuf += c; });
  tracked.add(child);
  appendRegistryRow({
    pid: child.pid,
    port,
    script,
    label,
    file: process.argv[1],
    startedAt: new Date().toISOString(),
  });

  const deregister = () => {
    tracked.delete(child);
    appendTombstone(child.pid);
  };

  /** Tree-kill the child, wait for the exit (bounded), then deregister. Only a
   * confirmed exit leaves the books: a child that survived the kill keeps its
   * registry row and tracked entry so the runner's sweep can still reach it. */
  const stop = ({ timeoutMs: killTimeoutMs = 5000 } = {}) => {
    killTree(child.pid, "force");
    return waitForExit(child, killTimeoutMs).then((exited) => {
      if (!exited && probePid(child.pid)) {
        throw new Error(
          `test server pid ${child.pid} survived killTree after ${killTimeoutMs} ms${label ? ` [${label}]` : ""}`,
        );
      }
      deregister();
    });
  };

  const pollStep = Math.max(25, Math.min(150, Math.round(timeoutMs / 40)));
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(
          `test server exited early (${child.exitCode})${label ? ` [${label}]` : ""}:\n${child.stderrBuf.slice(-800)}`,
        );
      }
      try {
        const res = await fetch(url);
        if (res.ok) return { child, port, stop };
      } catch { /* not up yet */ }
      await sleepMs(pollStep);
    }
    throw new Error(
      `test server not ready in ${timeoutMs}ms${label ? ` [${label}]` : ""}:\n${child.stderrBuf.slice(-800)}`,
    );
  } catch (err) {
    // Tree-kill the straggler (or early exiter — killTree is a no-op then),
    // take it off the books, give the OS a bounded moment, and surface stderr.
    killTree(child.pid, "force");
    deregister();
    await waitForExit(child, 2000);
    throw err;
  }
}