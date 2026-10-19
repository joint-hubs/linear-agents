// Idle-tick test (FOC-808): the server's 15 s ingest tick must write NOTHING
// when there is nothing to ingest — no pending spool, no new transcript bytes,
// no dead runs. On the VM this was ~1.5 MB/min of WAL churn (plan §0 item 3).
//
// Spawns the REAL telemetry-server (spawnTestServer, FOC-840) against a
// fixture store with 2 settled runs whose transcripts are fully ingested, then
// overrides the ingest interval via LA_TELEMETRY_INGEST_MS and waits out
// several ticks. Each tick's store state (file sizes + PRAGMA data_version on
// a read-only connection) must be byte-identical to the previous one.
//
// Serial lane: it spawns the server on a real port.

import assert from "node:assert/strict";
import { statSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { applyEvent, makeEvent, openTelemetryDb } from "./telemetry-store.mjs";
import { spawnTestServer } from "./test-spawn.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));

// Ticks are cheap once idle; 4 waits of 900 ms cover ≥4 ticks at 300 ms even
// with timer drift on a loaded CI machine.
const TICK_MS = 300;
const WAITS = 4;
const WAIT_MS = 900;

const dir = mkdtempSync(join(tmpdir(), "telemetry-idle-"));
const dbPath = join(dir, "telemetry.sqlite");
const home = join(dir, "telemetry-home");
const stateRoot = join(dir, "state-root");
const sessionDir = join(dir, "sessions");
mkdirSync(join(home, "spool", "pending"), { recursive: true });
mkdirSync(join(stateRoot, "runs"), { recursive: true });
mkdirSync(sessionDir, { recursive: true });

// ── fixture: 2 settled runs, transcripts fully ingested, no spool, no dead ──
// Ended > 5 min ago (REINGEST_GRACE_MS) so settledRun() skips them on the
// very first tick; parse_status='parsed' at the final file size so the skip
// cache holds and the growth sweep has nothing to re-pend.
const runs = [
  { runId: "run-idle-1", squad: "dev", sessionId: "sess-idle-1", lines: 2 },
  { runId: "run-idle-2", squad: "dev", sessionId: "sess-idle-2", lines: 2 },
];
const seedDb = openTelemetryDb(dbPath);
for (const run of runs) {
  const startedAt = "2026-10-19T08:00:00.000Z";
  const endedAt = "2026-10-19T08:10:00.000Z";
  const transcriptPath = join(sessionDir, `${run.sessionId}.jsonl`);
  const lines = [];
  for (let i = 0; i < run.lines; i++) {
    lines.push(JSON.stringify({
      type: "assistant",
      timestamp: `2026-10-19T08:0${i}:00.000Z`,
      sessionId: run.sessionId,
      message: {
        id: `msg-${run.sessionId}-${i}`,
        model: "claude-haiku-5-5",
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }));
  }
  writeFileSync(transcriptPath, lines.join("\n") + "\n", "utf8");
  const stats = statSync(transcriptPath);
  applyEvent(seedDb, makeEvent("run.started", { runId: run.runId, squad: run.squad, startedAt }, {
    runId: run.runId, observedAt: startedAt, sourceKind: "test", sourcePath: `test://${run.runId}`,
  }));
  applyEvent(seedDb, makeEvent("run.ended", {
    runId: run.runId, squad: run.squad, startedAt, endedAt, exitCode: 0, status: "completed",
    sessionId: run.sessionId, transcriptPath,
  }, { runId: run.runId, observedAt: endedAt, sourceKind: "test", sourcePath: `test://${run.runId}:end` }));
  applyEvent(seedDb, makeEvent("session.linked", { runId: run.runId, sessionId: run.sessionId, transcriptPath }, {
    runId: run.runId, observedAt: startedAt, sourceKind: "test", sourcePath: `test://${run.runId}:session`,
  }));
  // The transcript progress row IS the fully-ingested state — write it
  // directly (the projection the transcript ingest converges to) so no
  // transcript bytes remain unread and the skip cache is already armed.
  applyEvent(seedDb, makeEvent("transcript.progress", {
    runId: run.runId, sessionId: run.sessionId, byteOffset: stats.size, fileSize: stats.size,
    modifiedAt: "2026-10-19T08:10:00.000Z", parseStatus: "parsed",
  }, { runId: run.runId, observedAt: endedAt, sourceKind: "test", sourcePath: transcriptPath, sourceOffset: stats.size }));
}
seedDb.close();

let passed = 0;
let failed = 0;
const failures = [];
function test(name, fn) {
  return fn()
    .then(() => { passed++; console.log(`  PASS ${name}`); })
    .catch((error) => { failed++; failures.push(`${name}: ${error.message}`); console.log(`  FAIL ${name}: ${error.message}`); });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function storeState() {
  const dbSize = statSync(dbPath).size;
  let walSize = 0;
  try { walSize = statSync(`${dbPath}-wal`).size; } catch { /* no wal file yet */ }
  const ro = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const dataVersion = ro.prepare("PRAGMA data_version").get().data_version;
    return { dbSize, walSize, dataVersion };
  } finally {
    ro.close();
  }
}

const server = await spawnTestServer({
  script: join(__dir, "telemetry-server.mjs"),
  env: {
    LA_TELEMETRY_DB: dbPath,
    LA_TELEMETRY_HOME: home,
    LA_STATE_ROOT: stateRoot,
    LA_TELEMETRY_INGEST_MS: String(TICK_MS),
  },
  label: "telemetry-idle-tick",
});

try {
  await test("idle ticks write nothing to the store", async () => {
    // Let the boot settle (bootstrap backfill + the first ingest tick) so the
    // measured window starts from a quiesced store.
    await sleep(1500);
    const states = [storeState()];
    for (let i = 0; i < WAITS; i++) {
      await sleep(WAIT_MS);
      states.push(storeState());
    }
    const [first, ...rest] = states;
    const same = rest.every((s) =>
      s.dbSize === first.dbSize && s.walSize === first.walSize && s.dataVersion === first.dataVersion);
    if (!same) {
      throw new Error(`store changed across idle ticks:\n` +
        `  baseline  db=${first.dbSize} wal=${first.walSize} dv=${first.dataVersion}\n` +
        rest.map((s, i) => `  tick ${i + 1}  db=${s.dbSize} wal=${s.walSize} dv=${s.dataVersion}`).join("\n"));
    }
    assert.equal(first.dataVersion, rest[0].dataVersion, "PRAGMA data_version must not move while idle");
  });
} finally {
  await server.stop().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) console.log(failures.join("\n"));
process.exit(failed ? 1 : 0);
