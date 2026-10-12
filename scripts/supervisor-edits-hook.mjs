#!/usr/bin/env node
// scripts/supervisor-edits-hook.mjs — a UserPromptSubmit hook that re-surfaces
// unseen record edits (FOC-795) as context on Mateusz's next message.
//
// Why: the waker (supervisor-wake.mjs) stands down when no child is live —
// exactly when the Supervisor waits on a gate — so an edit landing in that
// window never wakes the session. This hook closes that gap: at every new
// prompt it prints the unseen rows of recently active runs as context and
// records them in <run>/edits-seen.json, a per-run watermark in the shape of
// the wake queue's ack ({ seenThrough, seenAt }). An edit row carrying
// notified === true (FOC-783: the dashboard answered a gate/hold and told the
// Supervisor through its session) is audit-only — never printed, but the
// watermark passes it so it is not rescanned.
//
//   node scripts/supervisor-edits-hook.mjs   (UserPromptSubmit: payload on stdin)
//
// UserPromptSubmit stdout becomes context for the model, so the output is a
// compact block and NOTHING else; nothing unseen means empty stdout. Never
// throws: any error is a silent exit 0 — a broken hook must never block or
// distort Mateusz's prompt.
//
// Writer discipline: writes ONLY <run>/edits-seen.json. edits.jsonl is
// read-only here — its single writer is scripts/agent-records.mjs, and the
// row reader (readEdits) lives with the waker so the format has one
// definition and two readers.
//
// Env: LA_SUPERVISOR_STATE_HOME — the state home whose run dirs are scanned
// (see supervisor-lib.mjs).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { supervisorStateHome } from "./supervisor-lib.mjs";
import { editFields, readEdits } from "./supervisor-wake.mjs";
import { atomicWriteJSON } from "./utils.mjs";

// A run touched within this window counts as recently active; older run dirs
// are finished work, and re-reading their records at every prompt is noise.
export const RECENCY_WINDOW_MS = 14 * 24 * 3_600_000;
// The context block must stay compact: at most this many "- [run] #seq ..." lines.
export const MAX_LISTED_ROWS = 20;

export const editsSeenPath = (dir) => join(dir, "edits-seen.json");

/** The watermark file's seenThrough — 0 when missing or unreadable. */
function seenThroughOf(path) {
  try {
    const seen = JSON.parse(readFileSync(path, "utf8"));
    return typeof seen?.seenThrough === "number" && Number.isFinite(seen.seenThrough) ? seen.seenThrough : 0;
  } catch {
    return 0;
  }
}

/** Was the run dir or its edits.jsonl touched within the recency window? */
function recentlyTouched(dir, editsFile, now) {
  try {
    if (now - statSync(dir).mtimeMs <= RECENCY_WINDOW_MS) return true;
    return now - statSync(editsFile).mtimeMs <= RECENCY_WINDOW_MS;
  } catch {
    return false; // an unreadable stat is unknown recency — skip, redeliver later
  }
}

const describeEdit = (runId, row) =>
  `- [${runId}] #${row.seq} ${row.type ?? "?"} ${row.path ?? "?"}: ${editFields(row)}`;

function writeSeenThrough(dir, seq) {
  try {
    atomicWriteJSON(editsSeenPath(dir), { seenThrough: seq, seenAt: new Date().toISOString() });
    return true;
  } catch {
    return false;
  }
}

/** The context block: headline, one line per row, then "+N more" when cut off. */
export function formatEditsBlock(lines, more = 0) {
  return [
    "Mateusz edited records since your last turn — re-read before acting:",
    ...lines,
    ...(more > 0 ? [`+${more} more`] : []),
  ].join("\n");
}

function run() {
  // The hook payload — tolerated empty or malformed, not used: the state this
  // hook needs is all on disk under the state home.
  readFileSync(0, "utf8");

  const home = supervisorStateHome();
  if (!existsSync(home)) return;
  const now = Date.now();
  const collected = [];
  for (const dirent of readdirSync(home, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const dir = join(home, dirent.name);
    const editsFile = join(dir, "edits.jsonl");
    if (!existsSync(editsFile)) continue;
    if (!recentlyTouched(dir, editsFile, now)) continue;
    const seenThrough = seenThroughOf(editsSeenPath(dir));
    const rows = readEdits(dirent.name)
      .filter((r) => r.seq > seenThrough)
      .sort((a, b) => a.seq - b.seq);
    if (rows.length) collected.push({ runId: dirent.name, dir, rows, seenThrough });
  }
  if (!collected.length) return;

  // The block is capped at MAX_LISTED_ROWS lines; a run's watermark advances
  // only through the rows actually CONSUMED — shown, or notified (FOC-783: an
  // answer notice the Supervisor was already told through its session never
  // prints and never costs budget, but the watermark passes it so the audit
  // stream is not rescanned). Anything beyond the consumed prefix stays unseen
  // and re-delivers on the next prompt (redelivery, never loss).
  const shown = [];
  let budget = MAX_LISTED_ROWS;
  let shownTotal = 0;
  for (const entry of collected) {
    if (budget <= 0) break;
    const lines = [];
    let watermark = entry.seenThrough;
    for (const row of entry.rows) {
      if (row.notified === true) {
        watermark = row.seq;
        continue;
      }
      if (budget === 0) break;
      lines.push(row);
      watermark = row.seq;
      budget -= 1;
    }
    shownTotal += lines.length;
    if (lines.length || watermark !== entry.seenThrough) {
      shown.push({ entry, rows: lines, watermark });
    }
  }
  // `more` counts only rows that will actually re-deliver — notified rows are
  // never shown, so they are not promised here.
  const more =
    collected.reduce((n, e) => n + e.rows.filter((r) => r.notified !== true).length, 0) - shownTotal;

  // Watermarks first, stdout second: a printed row is always a recorded row.
  // A run whose watermark could not be written is dropped from the block —
  // its rows re-deliver on the next prompt instead of printing unrecorded.
  const lines = [];
  for (const { entry, rows: printed, watermark } of shown) {
    if (!writeSeenThrough(entry.dir, watermark)) continue;
    for (const row of printed) lines.push(describeEdit(entry.runId, row));
  }
  if (!lines.length) return;
  process.stdout.write(formatEditsBlock(lines, more) + "\n");
}

try {
  run();
} catch {
  // Silent exit 0 — see the header.
}
