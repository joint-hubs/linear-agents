// FOC-547 AC4 runs capture — spawns the telemetry server of the tree this file
// lives in against a preset telemetry db, lets ingest ticks + reconcileDeadRuns
// settle for a window, captures /api/runs, then shuts the server down. Running
// the worktree copy exercises the NEW modules; the copy in the base-code
// export the OLD ones — same db, only code differs.
//
// Usage: LA_RUNCAP_DB=<db> LA_RUNCAP_OUT=<runs.json> [LA_RUNCAP_PORT=7464]
//        [LA_RUNCAP_SETTLE_MS=75000] node foc-547-runs-capture.mjs

import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const experimentsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(experimentsDir);
const dbPath = process.env.LA_RUNCAP_DB;
const outPath = process.env.LA_RUNCAP_OUT;
const port = Number(process.env.LA_RUNCAP_PORT) || 7464;
const settleMs = Number(process.env.LA_RUNCAP_SETTLE_MS) || 75000;
if (!dbPath || !outPath) {
  console.error("usage: LA_RUNCAP_DB=<db> LA_RUNCAP_OUT=<out> node foc-547-runs-capture.mjs");
  process.exit(2);
}

const tmp = mkdtempSync(join(tmpdir(), "ac4-runcap-"));
const env = { ...process.env };
delete env.LA_STATE_ROOT;
env.TELEMETRY_PORT = String(port);
env.LA_TELEMETRY_DB = dbPath;
env.LA_TELEMETRY_HOME = join(tmp, "telemetry-home");
env.LA_REWARDS_DB = join(tmp, "rewards.sqlite");
env.LA_REWARDS_HOME = join(tmp, "rewards-home");

const logPath = process.env.LA_RUNCAP_LOG || null;
const logStream = logPath ? createWriteStream(logPath, "utf8") : null;
const child = spawn(process.execPath, [join(repoRoot, "scripts", "telemetry-server.mjs")], {
  env, stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
child.stdout.on("data", (c) => { const s = c.toString(); log = (log + s).slice(-4000); if (logStream) logStream.write(s); });
child.stderr.on("data", (c) => { const s = c.toString(); log = (log + s).slice(-4000); if (logStream) logStream.write(s); });

const base = `http://127.0.0.1:${port}`;
async function waitHealthy() {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${log.slice(-800)}`);
    try {
      const r = await fetch(`${base}/api/telemetry/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("health timeout");
}

try {
  await waitHealthy();
  await new Promise((r) => setTimeout(r, settleMs));
  const t0 = Date.now();
  const res = await fetch(`${base}/api/runs`);
  const body = await res.text();
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, body, "utf8");
  console.log(`runs_ms=${Date.now() - t0} bytes=${body.length} out=${outPath}`);
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([
    new Promise((r) => child.once("exit", r)),
    new Promise((r) => setTimeout(r, 5000)),
  ]);
  const tail = log.split("\n").filter((l) => /reconcile|liveness|ingest|error|failed/i.test(l)).slice(-15);
  console.log("--- server log (reconcile/ingest/error tail) ---");
  for (const line of tail) console.log(line.trim().slice(0, 200));
  if (logStream) logStream.end();
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
