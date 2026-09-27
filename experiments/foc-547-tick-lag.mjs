// FOC-547 tick-lag driver (in-process, no server spawn).
//
// Measures event-loop lag while the ingest pipeline runs against a fresh tmp
// telemetry db backed by the repo's real .state corpus (read-only input):
//
//   backfill : first full pass over the corpus (fresh db, expect minutes)
//   tick1    : replayPending() + ingestKnownRuns() right after backfill
//   tick2    : the same again immediately (incremental case)
//
// reconcileDeadRuns lives in telemetry-server.mjs and is not exported, so it
// is out of scope for this driver; the summary notes that.
//
// Usage: node experiments/foc-547-tick-lag.mjs <outDir>

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const outDirArg = process.argv[2];
if (!outDirArg) {
  console.error("usage: node experiments/foc-547-tick-lag.mjs <outDir>");
  process.exit(2);
}
const outDir = resolve(outDirArg);
mkdirSync(outDir, { recursive: true });

// Environment seam FIRST: the telemetry modules read their store paths at
// import time, so the tmp db/home must be in place before importing scripts/.
// LA_STATE_ROOT is dropped so the default repo-root/.state (the read-only host
// corpus junction) is used.
const experimentsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(experimentsDir);
// LA_TICKLAG_DB/LA_TICKLAG_HOME: reuse a pre-seeded db (skip the backfill
// phase — seeding a fresh db over the real corpus takes >10 min on its own).
// Without them: fresh mkdtemp stores, backfill runs first.
const reuseDb = process.env.LA_TICKLAG_DB || null;
// LA_TICKLAG_SEED=1: backfill into LA_TICKLAG_DB (persisted), then tick phases
// — the "first tick after bootstrap" shape, with a db that survives the run.
const seedMode = Boolean(reuseDb && process.env.LA_TICKLAG_SEED === "1");
const tmpDir = reuseDb ? null : mkdtempSync(join(tmpdir(), "foc-547-tick-lag-"));
process.env.LA_TELEMETRY_DB = reuseDb || join(tmpDir, "telemetry.sqlite");
process.env.LA_TELEMETRY_HOME = process.env.LA_TICKLAG_HOME || join(tmpDir, "telemetry-home");
delete process.env.LA_STATE_ROOT;

const { backfill, ingestKnownRuns } = await import(
  pathToFileURL(join(repoRoot, "scripts", "telemetry-ingest.mjs"))
);
const { replayPending } = await import(
  pathToFileURL(join(repoRoot, "scripts", "telemetry-store.mjs"))
);
const { monitorEventLoopDelay } = await import("node:perf_hooks");
const histogram = monitorEventLoopDelay({ resolution: 1 });
histogram.enable();

const OVERALL_MS = Number(process.env.LA_BENCH_OVERALL_MS) || 540000;
let watchdogFired = false;
// Advisory only: marks the summary partial. It must never SKIP phases —
// the tick phases are the whole point of this driver, and a long backfill
// would otherwise consume the budget and leave nothing behind.
const watchdog = setTimeout(() => { watchdogFired = true; }, OVERALL_MS).unref();

const startedAt = new Date().toISOString();
const results = [];

// Histogram stats are nanoseconds; report milliseconds with 1 decimal.
function round1(ns) {
  return Math.round((ns / 1e6) * 10) / 10;
}

async function measure(phase, fn) {
  histogram.reset();
  const t0 = performance.now();
  try {
    await fn();
  } catch (err) {
    return { phase, error: String((err && err.message) || err) };
  }
  return {
    phase,
    duration_ms: Math.round(performance.now() - t0),
    p50_ms: round1(histogram.percentile(50)),
    p95_ms: round1(histogram.percentile(95)),
    p99_ms: round1(histogram.percentile(99)),
    max_ms: round1(histogram.max),
  };
}

function persistSummary() {
  const doc = {
    results,
    startedAt,
    finishedAt: new Date().toISOString(),
    partial: watchdogFired,
    db: process.env.LA_TELEMETRY_DB,
    notes: "reconcileDeadRuns not measured (not exported)",
  };
  // Distinct filename: the bench-server script writes summary.json into the
  // same outDir and must not be clobbered.
  writeFileSync(join(outDir, "tick-lag-summary.json"), JSON.stringify(doc, null, 2), "utf8");
}

const PHASES = [
  // Skip backfill only when reusing a pre-seeded db without reseeding.
  ...(reuseDb && !seedMode ? [] : [["backfill", () => backfill()]]),
  ["tick1", async () => {
    replayPending();
    await ingestKnownRuns();
  }],
  ["tick2", async () => {
    replayPending();
    await ingestKnownRuns();
  }],
];

try {
  for (const [phase, fn] of PHASES) {
    results.push(await measure(phase, fn));
    persistSummary();
  }
} finally {
  clearTimeout(watchdog);
  persistSummary();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  for (const r of results) {
    if (r.error) console.log(`${r.phase} error=${r.error.slice(0, 120)}`);
    else {
      console.log(`${r.phase} duration=${r.duration_ms}ms p50=${r.p50_ms}ms p95=${r.p95_ms}ms p99=${r.p99_ms}ms max=${r.max_ms}ms`);
    }
  }
  console.log(`db=${process.env.LA_TELEMETRY_DB}`);
  if (tmpDir) console.log(`tmp=${tmpDir} (removed)`);
}
