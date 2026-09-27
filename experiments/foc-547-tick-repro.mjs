// FOC-547 repro: ingestKnownRuns tick against the pre-seeded real-corpus db.
// Prints the full stack of the SQLite binding failure.
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dbPath = process.env.LA_PROBE_DB
  || join(repoRoot, ".state", "foc-547-bench", "seed", "telemetry.sqlite");
process.env.LA_TELEMETRY_DB = dbPath;
process.env.LA_TELEMETRY_HOME = join(repoRoot, ".state", "foc-547-bench", "seed", "telemetry-home");

const { ingestKnownRuns } = await import(
  pathToFileURL(join(repoRoot, "scripts", "telemetry-ingest.mjs"))
);
try {
  const summary = await ingestKnownRuns();
  console.log("OK", JSON.stringify(summary));
} catch (error) {
  console.log("STACK:");
  console.log(error.stack);
}
