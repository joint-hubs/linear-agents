// Multi-process concurrency test for the central telemetry store.

import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { makeEvent, openTelemetryDb, applyEvent, emitEvent } from "./telemetry-store.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const temp = mkdtempSync(join(tmpdir(), "telemetry-concurrency-test-"));
const dbPath = join(temp, "telemetry.sqlite");
const storeUrl = pathToFileURL(join(__dir, "telemetry-store.mjs")).href;
const ingestUrl = pathToFileURL(join(__dir, "telemetry-ingest.mjs")).href;
const env = { ...process.env, LA_TELEMETRY_HOME: temp, LA_TELEMETRY_DB: dbPath };
process.env.LA_TELEMETRY_HOME = temp;
process.env.LA_TELEMETRY_DB = dbPath;

function child(code) {
  return new Promise((resolve, reject) => {
    const childProcess = spawn(process.execPath, ["--input-type=module", "-e", code], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    childProcess.stderr.on("data", (chunk) => { stderr += chunk; });
    childProcess.on("error", reject);
    childProcess.on("exit", (exitCode) => exitCode === 0 ? resolve() : reject(new Error(`child exit ${exitCode}: ${stderr}`)));
  });
}

try {
  const emitCode = `
    import { emitEvent, makeEvent } from ${JSON.stringify(storeUrl)};
    const event = makeEvent('run.started', { runId:'concurrent-run', squad:'dev', startedAt:'2026-07-24T10:00:00.000Z' },
      { runId:'concurrent-run', eventId:'same-event', observedAt:'2026-07-24T10:00:00.000Z' });
    const result = emitEvent(event);
    if (result.pending) process.exit(1);
  `;
  await Promise.all(Array.from({ length: 8 }, () => child(emitCode)));

  const transcript = join(temp, "session.jsonl");
  writeFileSync(transcript, JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-24T10:01:00.000Z",
    sessionId: "concurrent-session",
    message: { model: "deepseek-v4-flash", usage: { input_tokens: 100, output_tokens: 10 } },
  }) + "\n", "utf8");
  const db = openTelemetryDb(dbPath);
  applyEvent(db, makeEvent("session.linked", {
    runId: "concurrent-run", sessionId: "concurrent-session", transcriptPath: transcript,
  }, { runId: "concurrent-run" }));
  db.close();

  const ingestCode = `
    import { openTelemetryDb } from ${JSON.stringify(storeUrl)};
    import { ingestTranscript } from ${JSON.stringify(ingestUrl)};
    const db = openTelemetryDb(process.env.LA_TELEMETRY_DB);
    try { await ingestTranscript(db, 'concurrent-run', ${JSON.stringify(transcript)}, 'concurrent-session'); }
    finally { db.close(); }
  `;
  await Promise.all([child(ingestCode), child(ingestCode)]);

  const pendingEvent = makeEvent("run.started", {
    runId: "pending-run", squad: "review", startedAt: "2026-07-24T10:02:00.000Z",
  }, { runId: "pending-run", eventId: "pending-event" });
  const pendingResult = emitEvent(pendingEvent, { dbPath: temp });
  if (!pendingResult.pending) throw new Error("failed DB write did not create a pending event");
  const replayCode = `
    import { replayPending } from ${JSON.stringify(storeUrl)};
    replayPending({ dbPath: process.env.LA_TELEMETRY_DB });
  `;
  await Promise.all([child(replayCode), child(replayCode)]);

  const verify = openTelemetryDb(dbPath);
  const eventCount = verify.prepare("SELECT COUNT(*) AS count FROM events WHERE event_id='same-event'").get().count;
  const usageCount = verify.prepare("SELECT COUNT(*) AS count FROM usage_facts WHERE run_id='concurrent-run'").get().count;
  const replayedCount = verify.prepare("SELECT COUNT(*) AS count FROM events WHERE event_id='pending-event'").get().count;
  verify.close();
  const pending = join(temp, "spool", "pending");
  mkdirSync(pending, { recursive: true });
  const pendingCount = readdirSync(pending).filter((file) => file.endsWith(".json")).length;
  if (eventCount !== 1 || usageCount !== 1 || replayedCount !== 1 || pendingCount !== 0) {
    throw new Error(`eventCount=${eventCount} usageCount=${usageCount} replayedCount=${replayedCount} pendingCount=${pendingCount}`);
  }
  console.log("PASS concurrent event and transcript ingestion");
} finally {
  rmSync(temp, { recursive: true, force: true });
}