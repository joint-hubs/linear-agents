// FOC-547 rewards-cost probe — decomposes the fresh GET /api/manager/rewards
// latency: ingestRewards (verdict scan + indexed lookups) vs the payload build.
// Runs in-process against a pre-built telemetry db (LA_TICKLAG_DB seed) and a
// fresh rewards db in a tmp dir. Read-only on the telemetry side.
//
// Usage: node experiments/foc-547-rewards-probe.mjs

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const experimentsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(experimentsDir);
const seedDb = process.env.LA_PROBE_DB || join(repoRoot, ".state", "foc-547-bench", "seed", "telemetry.sqlite");
const supervisorRoot = process.env.LA_PROBE_SUPERVISOR
  || join(repoRoot, ".state", "supervisor");

const tmp = mkdtempSync(join(tmpdir(), "foc-547-rewards-probe-"));
process.env.LA_TELEMETRY_DB = seedDb;
process.env.LA_TELEMETRY_HOME = process.env.LA_PROBE_HOME
  || join(repoRoot, ".state", "foc-547-bench", "seed", "telemetry-home");

const { openTelemetryDb } = await import(
  pathToFileURL(join(repoRoot, "scripts", "telemetry-store.mjs"))
);
const { openRewardsDb } = await import(
  pathToFileURL(join(repoRoot, "scripts", "reward-ledger.mjs"))
);
const { ingestRewards, buildRewardsPayload } = await import(
  pathToFileURL(join(repoRoot, "scripts", "reward-ingest.mjs"))
);

const telemetryDb = openTelemetryDb(seedDb);
const rewardsDb = openRewardsDb(join(tmp, "rewards.sqlite"));

try {
  let t0 = performance.now();
  const ingested = await ingestRewards({ telemetryDb, rewardsDb, supervisorRoot });
  const tIngest = Math.round(performance.now() - t0);
  console.log(`ingestRewards: ${tIngest}ms scannedRuns=${ingested.scannedRuns} groups=${ingested.groups} awarded=${ingested.awarded} held=${ingested.held} missing=${ingested.missing.length}`);

  t0 = performance.now();
  const payload1 = await buildRewardsPayload({ telemetryDb, rewardsDb, supervisorRoot, renderedRunIds: [] });
  const tBuild1 = Math.round(performance.now() - t0);
  console.log(`buildRewardsPayload(fresh): ${tBuild1}ms source=${payload1.source} squads=${Object.keys(payload1.squads).length} ratings=${payload1.ratings.length} bytes=${JSON.stringify(payload1).length}`);

  t0 = performance.now();
  await buildRewardsPayload({ telemetryDb, rewardsDb, supervisorRoot, renderedRunIds: [] });
  const tBuild2 = Math.round(performance.now() - t0);
  console.log(`buildRewardsPayload(cached-ingest): ${tBuild2}ms`);
} finally {
  telemetryDb.close();
  rewardsDb.close();
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
