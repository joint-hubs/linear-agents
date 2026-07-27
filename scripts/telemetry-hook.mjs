#!/usr/bin/env node
// telemetry-hook.mjs — Claude Code command hook adapter.
// Reads hook JSON from stdin and emits exact session/workspace telemetry.

import { readFileSync } from "node:fs";
import {
  recordSessionLink,
  recordTaskLink,
  recordWorkspace,
} from "./telemetry-store.mjs";

function readInput() {
  try {
    const raw = readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function runIdFrom(input) {
  return process.env.LA_RUN_ID || process.env.RUN_ID || input.run_id || input.runId || null;
}

function sessionIdFrom(input) {
  return process.env.CLAUDE_CODE_SESSION_ID || input.session_id || input.sessionId || null;
}

const input = readInput();
const eventName = input.hook_event_name || process.env.LA_TELEMETRY_HOOK_EVENT || "SessionStart";
const runId = runIdFrom(input);
const sessionId = sessionIdFrom(input);
const cwd = input.cwd || input.workspace?.current_dir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
const observedAt = input.timestamp || new Date().toISOString();

// Telemetry must never prevent the agent from starting or stopping. The event
// writer preserves failed writes in the local spool for server-side replay.
try {
  if (runId && sessionId) {
    recordSessionLink(runId, sessionId, {
      transcriptPath: input.transcript_path || input.transcriptPath || null,
      source: eventName.toLowerCase(),
      metadata: { eventName, cwd },
    }, { observedAt, sourceKind: "claude-hook" });
  }
  if (runId && cwd) {
    recordWorkspace(runId, cwd, { source: eventName.toLowerCase() }, {
      observedAt,
      sourceKind: "claude-hook",
    });
  }
  const taskId = process.env.LA_TASK_ID || input.task_id || input.taskId || null;
  if (runId && taskId) {
    recordTaskLink(runId, taskId, "launch", { observedAt, sourceKind: "claude-hook" });
  }
} catch {
  // Hooks must stay non-blocking. Event delivery is retried from the spool.
}

process.exit(0);