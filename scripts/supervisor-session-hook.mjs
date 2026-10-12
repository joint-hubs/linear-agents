#!/usr/bin/env node
// scripts/supervisor-session-hook.mjs — records what the Supervisor's Claude
// Code session is doing, as one session.json under the data home (FOC-783).
//
// Why: the dashboard can only show the frontman's state (busy / idle / waiting
// on a permission / ended) if something OUTSIDE the session observes it. This
// hook is that observer: Claude Code fires it on session events and the hook
// folds each one into <dataHome>/supervisor/session.json (fenix-paths.mjs).
//
//   node scripts/supervisor-session-hook.mjs <Event>   (JSON payload on stdin)
//
// Event comes from argv[2] or payload.hook_event_name. The file is written
// ONLY when something changed versus the previous content — PostToolUse fires
// per tool call, so a per-call rewrite would be churn. The exception is
// SessionStart / SessionEnd, which ALWAYS write: a restart with `claude
// --continue` reproduces the very same content, and a skipped write looks to
// the host like a session that never started. The write is atomic
// (atomicWriteJSON) and the state mapping lives in nextSessionState, exported
// so tests can pin it without spawning a child.
//
// State fidelity is layered: idle / busy are BEST EFFORT — they describe the
// session between events, and a Stop blocked by supervisor-guard still writes
// idle. Only needs-input gates anything, so it is pinned harder: the
// notification_type values come from the real payload of the pinned Claude
// Code, verified at acceptance, and the message regex
// (/permission|needs your (input|approval)/i) is only the fallback for a
// payload without the type field.
//
// MUST print nothing to stdout or stderr (SessionStart / UserPromptSubmit
// stdout becomes model context) and NEVER fail: any error — malformed or empty
// stdin, unwritable path — is a silent exit 0, a broken hook must never block
// or distort the session.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import { supervisorSessionPath } from "./fenix-paths.mjs";
import { atomicWriteJSON } from "./utils.mjs";

/**
 * The next session record for a hook event, or null when nothing would change
 * (no write). SessionStart / SessionEnd never return null — they always write
 * a fresh updatedAt. Pure: prev is the parsed existing file (or null), event
 * the hook event name, payload the stdin JSON, now the timestamp to stamp.
 */
export function nextSessionState(prev, event, payload, now = new Date()) {
  const keep = (payloadKey, fileKey) =>
    payload?.[payloadKey] ?? prev?.[fileKey] ?? null;
  let state;
  let notification = null;
  switch (event) {
    case "SessionStart":
      state = "idle";
      break;
    case "UserPromptSubmit":
    case "PostToolUse":
      state = "busy";
      break;
    case "Stop":
      state = "idle";
      break;
    case "SessionEnd":
      state = "ended";
      break;
    case "Notification": {
      const type = payload?.notification_type ?? null;
      // needs-input is the one state that gates a human: the two types the
      // pinned Claude Code sends for it, plus the message regex as fallback
      // for a payload without the type field (see the header).
      const needsInput = type === "permission_prompt"
        || type === "elicitation_dialog"
        || (type === null && /permission|needs your (input|approval)/i.test(payload?.message ?? ""));
      notification = { type, message: payload?.message ?? null };
      // Any other notification is recorded but leaves the state as it was.
      state = needsInput ? "needs-input" : prev?.state ?? null;
      break;
    }
    default:
      return null; // unknown event — never write
  }
  const next = {
    sessionId: keep("session_id", "sessionId"),
    transcriptPath: keep("transcript_path", "transcriptPath"),
    cwd: keep("cwd", "cwd"),
    state,
    notification,
    updatedAt: now.toISOString(),
  };
  // updatedAt always differs, so compare only what the file is FOR — except
  // on SessionStart / SessionEnd, which write even when nothing else changed
  // (a fresh updatedAt is itself the news: the session was (re)started/ended;
  // see the header). The no-churn skip stays for the per-call events.
  if (event === "SessionStart" || event === "SessionEnd") return next;
  const unchanged = prev
    && prev.sessionId === next.sessionId
    && prev.transcriptPath === next.transcriptPath
    && prev.cwd === next.cwd
    && prev.state === next.state
    && sameNotification(prev.notification, next.notification);
  return unchanged ? null : next;
}

const sameNotification = (a, b) =>
  a === b
  || (!!a && !!b && a.type === b.type && a.message === b.message);

function run() {
  // The hook payload — tolerated empty or malformed; a parse failure is a
  // no-write, never an error.
  let payload = null;
  try {
    payload = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return;
  }
  if (!payload || typeof payload !== "object") return;
  const path = supervisorSessionPath();
  let prev = null;
  try {
    prev = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // No file yet — everything counts as new.
  }
  const next = nextSessionState(
    prev,
    process.argv[2] || payload.hook_event_name,
    payload,
    new Date(),
  );
  if (!next) return;
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteJSON(path, next);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

try {
  if (isMain) run();
} catch {
  // Silent exit 0 — see the header.
}