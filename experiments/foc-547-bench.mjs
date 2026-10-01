// FOC-547 benchmark driver.
//
// Boots scripts/telemetry-server.mjs against isolated tmp stores and times:
// cold start to healthy, first (fresh) vs repeated (cached) /api/manager/rewards,
// /api/runs, and a follow-up health probe. Timings are persisted to
// <outDir>/summary.json after every phase, so a killed run keeps partial numbers.
//
// The repo's .state junctions point at the real host corpus; that tree is
// READ-ONLY input here — ENFORCED (FOC-599 item 6), not assumed: the env-shape
// assertion below refuses a run whose child env still carries an input-root
// seam (pinning the drops) or whose mutable stores would land outside tmp, and
// LA_STATE_READ_ONLY=1 makes the child's one state-root writer refuse. All
// mutable stores (telemetry db/home, rewards db/home) live under a mkdtemp tmp
// dir.
//
// Env seams:
//   LA_BENCH_ROOT — spawn scripts/telemetry-server.mjs from this checkout
//     instead of the bench script's own repo (base-code export vs candidate).
//   LA_BENCH_DB  — reuse a pre-built telemetry db instead of a fresh one
//     (controlled same-db comparison); only the homes stay under tmp.
//
// Usage: node experiments/foc-547-bench.mjs <outDir>

import { spawn } from "node:child_process";
import { connect } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const CLIENT_TIMEOUT_MS = 60000;
// Cold start to healthy is dominated by the bootstrap backfill over the real
// corpus (FOC-545 baseline: 139 s) — the health phase needs its own, larger
// budget than the 60 s per-request client timeout.
const HEALTH_BUDGET_MS = Number(process.env.LA_BENCH_HEALTH_MS) || 600000;
const OVERALL_MS = Number(process.env.LA_BENCH_OVERALL_MS) || 540000;

const experimentsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(experimentsDir);
const spawnRoot = process.env.LA_BENCH_ROOT || repoRoot;
const serverScript = join(spawnRoot, "scripts", "telemetry-server.mjs");
const presetDb = process.env.LA_BENCH_DB || null;

const outDirArg = process.argv[2];
if (!outDirArg) {
  console.error("usage: node experiments/foc-547-bench.mjs <outDir>");
  process.exit(2);
}
const outDir = resolve(outDirArg);
mkdirSync(outDir, { recursive: true });

const tmpDir = mkdtempSync(join(tmpdir(), "foc-547-bench-"));
const port = Number(process.env.LA_BENCH_PORT) || 7461;
const BASE = `http://127.0.0.1:${port}`;

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function portBusy(candidate) {
  return new Promise((resolvePromise) => {
    const socket = connect({ port: candidate, host: "127.0.0.1" });
    socket.once("connect", () => { socket.destroy(); resolvePromise(true); });
    socket.once("error", () => resolvePromise(false));
  });
}

if (await portBusy(port)) {
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  console.log("port busy");
  process.exit(2);
}

// Child env: isolated mutable stores under tmpDir. No LA_STATE_ROOT override —
// the default repo-root/.state (the read-only host corpus junction) is wanted,
// so drop any ambient value instead of passing it through. Same for
// LA_CORPUS_ROOT (the transcript-corpus seam, FOC-599 item 4c) — an ambient
// value would silently retarget the corpus the child scans.
const childEnv = { ...process.env };
delete childEnv.LA_STATE_ROOT;
delete childEnv.LA_CORPUS_ROOT;
childEnv.TELEMETRY_PORT = String(port);
childEnv.LA_TELEMETRY_DB = presetDb || join(tmpDir, "telemetry.sqlite");
childEnv.LA_TELEMETRY_HOME = join(tmpDir, "telemetry-home");
childEnv.LA_REWARDS_DB = join(tmpDir, "rewards.sqlite");
childEnv.LA_REWARDS_HOME = join(tmpDir, "rewards-home");
// The input tree is READ-ONLY INPUT (header): enforced now, not assumed.
// LA_STATE_READ_ONLY=1 makes the one state-root writer in the child's import
// graph (writeLaunchBat → .state/launch-*.bat) refuse instead of write
// (telemetry-store.assertStateWritable).
childEnv.LA_STATE_READ_ONLY = "1";

// FOC-599 item 6 — the env-shape assertion (store-side): both input-root seams
// stay dropped and every mutable store resolves under tmpDir, or the run
// refuses BEFORE the spawn rather than discovering a live-tree write after.
// The only store allowed outside tmp is LA_BENCH_DB when explicitly preset
// (the controlled same-db comparison is the operator's choice). Verified
// 2026-10-01: the boot/tick path writes only the telemetry/rewards stores and
// the analysis cache (all under LA_TELEMETRY_HOME — redirected here); the
// state-root writers in the graph are the launch-wrapper write (flag-guarded
// above) and the child-side run-manifest.mjs, which this probe never runs.
const inputSeams = ["LA_STATE_ROOT", "LA_CORPUS_ROOT"].filter((key) => childEnv[key]);
if (inputSeams.length > 0) {
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  console.error(`refusing to run: input-root seam(s) still set: ${inputSeams.join(", ")} — the input tree must stay the repo default`);
  process.exit(2);
}
for (const key of ["LA_TELEMETRY_DB", "LA_TELEMETRY_HOME", "LA_REWARDS_DB", "LA_REWARDS_HOME"]) {
  const value = resolve(childEnv[key] || "");
  const underTmp = value === tmpDir || value.startsWith(tmpDir + sep);
  const isPreset = key === "LA_TELEMETRY_DB" && presetDb && resolve(presetDb) === value;
  if (!underTmp && !isPreset) {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    console.error(`refusing to run: ${key}=${childEnv[key] ?? "(unset)"} is not under ${tmpDir} — a mutable store would land outside tmp`);
    process.exit(2);
  }
}

let childLog = "";
const captureLog = (chunk) => { childLog = (childLog + chunk.toString()).slice(-2000); };

const startedAt = new Date().toISOString();
const spawnMs = Date.now();
const child = spawn(process.execPath, [serverScript], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
child.stdout.on("data", captureLog);
child.stderr.on("data", captureLog);

const timings = {};
let watchdogFired = false;
let anyFailure = false;
let activeController = null;

const watchdog = setTimeout(() => {
  watchdogFired = true;
  if (child.exitCode === null) child.kill();
  if (activeController) activeController.abort();
}, OVERALL_MS);

function persistSummary() {
  const partial = watchdogFired || anyFailure || child.exitCode !== null;
  const doc = { ...timings, startedAt, finishedAt: new Date().toISOString(), partial };
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(doc, null, 2), "utf8");
}

function logTail() {
  return childLog.slice(-1000);
}

async function timedGet(path) {
  const controller = new AbortController();
  activeController = controller;
  const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE}${path}`, { signal: controller.signal });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body, elapsed_ms: Date.now() - t0, timedOut: false };
  } catch (err) {
    if (watchdogFired && controller.signal.aborted) {
      return { error: "aborted by watchdog", elapsed_ms: Date.now() - t0 };
    }
    if (err && err.name === "AbortError") return { timedOut: true, elapsed_ms: Date.now() - t0 };
    return { error: String((err && err.message) || err), elapsed_ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
    activeController = null;
  }
}

// ms from spawn until the first 200 from /api/telemetry/health; also aborts
// early when the child dies, recording the captured log tail.
async function runHealthPhase() {
  const deadline = Date.now() + HEALTH_BUDGET_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      anyFailure = true;
      timings.t_health_ms = {
        child_error: `exited with code ${child.exitCode}`,
        log_tail: logTail(),
        elapsed_ms: Date.now() - spawnMs,
      };
      persistSummary();
      return;
    }
    if (watchdogFired) break;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(deadline - Date.now(), 1));
    activeController = controller;
    try {
      const res = await fetch(`${BASE}/api/telemetry/health`, { signal: controller.signal });
      if (res.ok) {
        timings.t_health_ms = Date.now() - spawnMs;
        persistSummary();
        return;
      }
    } catch { /* not up yet, or aborted */ }
    finally {
      clearTimeout(timer);
      activeController = null;
    }
    await sleep(250);
  }
  anyFailure = true;
  timings.t_health_ms = { timeout: true, elapsed_ms: Date.now() - spawnMs };
  persistSummary();
}

async function runGetPhase(key, path, fileName) {
  const r = await timedGet(path);
  if (r.body !== undefined && fileName) {
    writeFileSync(join(outDir, fileName), r.body, "utf8");
  }
  if (r.timedOut) {
    anyFailure = true;
    timings[key] = { timeout: true, elapsed_ms: r.elapsed_ms };
  } else if (r.error) {
    anyFailure = true;
    timings[key] = { error: r.error, elapsed_ms: r.elapsed_ms };
  } else if (!r.ok) {
    anyFailure = true;
    timings[key] = { error: `HTTP ${r.status}`, elapsed_ms: r.elapsed_ms };
  } else {
    timings[key] = r.elapsed_ms;
  }
  persistSummary();
}

const HEALTH_KEY = "t_health_ms";
const GET_PHASES = [
  ["t_rewards_fresh_ms", "/api/manager/rewards", "rewards-fresh.json"],
  ["t_rewards_cached1_ms", "/api/manager/rewards", "rewards-cached1.json"],
  ["t_rewards_cached2_ms", "/api/manager/rewards", "rewards-cached2.json"],
  ["t_runs_ms", "/api/runs", "runs.json"],
  ["t_health_after_ms", "/api/telemetry/health", null],
];

try {
  await runHealthPhase();
  for (const [key, path, fileName] of GET_PHASES) {
    if (watchdogFired || child.exitCode !== null) {
      anyFailure = true;
      break;
    }
    await runGetPhase(key, path, fileName);
  }
} finally {
  clearTimeout(watchdog);
  if (child.exitCode === null) child.kill();
  await Promise.race([
    new Promise((resolvePromise) => child.once("exit", resolvePromise)),
    new Promise((resolvePromise) => setTimeout(resolvePromise, 5000)),
  ]);
  persistSummary();
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  const partial = watchdogFired || anyFailure || child.exitCode !== null;
  for (const [key] of [[HEALTH_KEY], ...GET_PHASES]) {
    const v = timings[key];
    if (typeof v === "number") console.log(`${key}=${v}ms`);
    else if (v && v.timeout) console.log(`${key}=TIMEOUT(${CLIENT_TIMEOUT_MS}ms)`);
    else if (v && v.child_error) console.log(`${key}=CHILD_ERROR(${v.child_error})`);
    else if (v && v.error) console.log(`${key}=ERROR(${v.error})`);
    else console.log(`${key}=MISSING`);
  }
  console.log(`tmp=${tmpDir} (removed)`);
  console.log(`out=${outDir}`);
  console.log(`partial=${partial}`);
}
