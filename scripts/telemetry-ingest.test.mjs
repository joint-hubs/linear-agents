// Contract test for transcript ingestion into the central telemetry store.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeEvent, openTelemetryDb, applyEvent, queryRuns } from "./telemetry-store.mjs";
import { ingestTranscript } from "./telemetry-ingest.mjs";

let passed = 0;
let failed = 0;
const temp = mkdtempSync(join(tmpdir(), "telemetry-ingest-test-"));
const db = openTelemetryDb(join(temp, "telemetry.sqlite"));
const transcript = join(temp, "lead.jsonl");
const sessionId = "session-worktree-1";

function test(name, fn) {
  try { fn(); passed++; console.log(`  PASS ${name}`); }
  catch (error) { failed++; console.log(`  FAIL ${name}: ${error.message}`); }
}

function assert(value, message) {
  if (!value) throw new Error(message || "assertion failed");
}

function writeJsonl(path, lines) {
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
}

applyEvent(db, makeEvent("run.started", {
  runId: "run-worktree-1", squad: "dev", startedAt: "2026-07-24T08:00:00.000Z", cwd: "C:/repos/office",
}, { runId: "run-worktree-1" }));
applyEvent(db, makeEvent("session.linked", {
  runId: "run-worktree-1", sessionId, transcriptPath: transcript,
}, { runId: "run-worktree-1" }));

writeJsonl(transcript, [
  { type: "user", timestamp: "2026-07-24T08:00:01.000Z", sessionId, cwd: "C:/repos/office", gitBranch: "dev" },
  { type: "worktree-state", sessionId, worktreeSession: { worktreePath: "C:/repos/office/.claude/worktrees/foc-36", worktreeBranch: "foc-36-design-system" } },
  { type: "assistant", timestamp: "2026-07-24T08:01:00.000Z", sessionId, cwd: "C:/repos/office/.claude/worktrees/foc-36", gitBranch: "foc-36-design-system", message: { model: "deepseek-v4-flash", usage: { input_tokens: 100, output_tokens: 50 } } },
]);
const subagents = join(temp, "lead", "subagents");
mkdirSync(subagents, { recursive: true });
writeJsonl(join(subagents, "agent-worker.jsonl"), [
  { type: "assistant", timestamp: "2026-07-24T08:01:30.000Z", sessionId, agentId: "worker", message: { model: "deepseek-v4-flash", usage: { input_tokens: 20, output_tokens: 10 } } },
]);

test("imports the transcript and worktree timeline", () => {
  const result = ingestTranscript(db, "run-worktree-1", transcript, sessionId);
  assert(result.events === 4, `events=${result.events}`);
  const run = queryRuns(db)[0];
  assert(run.worktreePath.endsWith("foc-36"), `worktree=${run.worktreePath}`);
  assert(run.gitRef.name === "foc-36-design-system", `branch=${run.gitRef.name}`);
  assert(run.byAgent._lead.turns === 1, "lead usage missing");
  assert(run.byAgent["agent-worker"].turns === 1, "subagent usage missing");
});

test("re-ingest does not duplicate usage", () => {
  const result = ingestTranscript(db, "run-worktree-1", transcript, sessionId);
  assert(result.events === 0, `events=${result.events}`);
  const run = queryRuns(db)[0];
  assert(run.byAgent._lead.turns === 1 && run.byAgent["agent-worker"].turns === 1, "usage duplicated");
});

db.close();
rmSync(temp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);