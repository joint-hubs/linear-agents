// FOC-547 AC4 rewards capture — in-process ingestRewards + buildRewardsPayload
// against a preset telemetry db, saving the built payload for a before/after
// diff. Repo root = the tree this script file lives in, so running the copy in
// the base-code export exercises the OLD modules and the worktree copy the NEW
// ones — same db, only code differs.
//
// Usage: LA_CAP_DB=<telemetry.sqlite> LA_CAP_OUT=<payload.json> \
//        [LA_CAP_HOME=<dir>] [LA_CAP_SUPERVISOR=<dir>] \
//        node foc-547-rewards-capture.mjs

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const experimentsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(experimentsDir);
const dbPath = process.env.LA_CAP_DB;
const outPath = process.env.LA_CAP_OUT;
const supervisorRoot = process.env.LA_CAP_SUPERVISOR
  || join(repoRoot, ".state", "supervisor");
if (!dbPath || !outPath) {
  console.error("usage: LA_CAP_DB=<db> LA_CAP_OUT=<payload.json> node foc-547-rewards-capture.mjs");
  process.exit(2);
}
process.env.LA_TELEMETRY_DB = dbPath;
process.env.LA_TELEMETRY_HOME = process.env.LA_CAP_HOME || join(tmpdir(), "ac4-cap-home");

const tmp = mkdtempSync(join(tmpdir(), "ac4-rewards-cap-"));
process.env.LA_REWARDS_DB = join(tmp, "rewards.sqlite");
process.env.LA_REWARDS_HOME = join(tmp, "rewards-home");

const { openTelemetryDb } = await import(
  pathToFileURL(join(repoRoot, "scripts", "telemetry-store.mjs"))
);
const { openRewardsDb } = await import(
  pathToFileURL(join(repoRoot, "scripts", "reward-ledger.mjs"))
);
const { ingestRewards, buildRewardsPayload } = await import(
  pathToFileURL(join(repoRoot, "scripts", "reward-ingest.mjs"))
);

const telemetryDb = openTelemetryDb(dbPath);
const rewardsDb = openRewardsDb(join(tmp, "rewards.sqlite"));
try {
  let t0 = performance.now();
  const ingested = await ingestRewards({ telemetryDb, rewardsDb, supervisorRoot });
  const tIngest = Math.round(performance.now() - t0);
  t0 = performance.now();
  const payload = await buildRewardsPayload({ telemetryDb, rewardsDb, supervisorRoot, renderedRunIds: [] });
  const tBuild = Math.round(performance.now() - t0);
  writeFileSync(outPath, JSON.stringify(payload), "utf8");
  console.log(`ingest=${tIngest}ms build=${tBuild}ms source=${payload.source} squads=${Object.keys(payload.squads || {}).length} held=${(payload.held || []).length} bytes=${JSON.stringify(payload).length} out=${outPath}`);
} finally {
  telemetryDb.close();
  rewardsDb.close();
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
