#!/usr/bin/env node
// scripts/supervisor-wake.mjs — the Supervisor's waker: a Stop hook that runs
// with `asyncRewake` and wakes an idle session when the wake queue gets a row.
//
//   node scripts/supervisor-wake.mjs [--run <id>]     (Stop hook: payload on stdin)
//
// Why: the watcher appends exit/gate/stall rows to <run>/wake-queue.jsonl, but a
// queue is a file, not an alarm. Once the Supervisor ended its turn nothing
// re-entered the session, so a finished child waited for Mateusz to type "jak
// tam status?" — measured 2026-10-08 over 150 rows: 52 of 132 child exits were
// handled only after a human message (median 19 min, worst ~10 h).
//
// How: Claude Code runs an `asyncRewake` hook in the background and, when it
// exits 2, wakes the session immediately — even an idle one — showing the
// hook's stderr as a system reminder. Exit 0 wakes nobody. So this script waits
// at zero token cost and exits:
//
//   · 2 — a row the session has neither acked nor been woken for landed
//         (stderr names the rows and the drain command);
//   · 2 — an edit record above the lease's editsFiredThrough landed: Mateusz
//         edited a record the session may hold a stale copy of (stderr names
//         the paths and the re-read command). An edit row carrying
//         notified === true (FOC-783: the dashboard answered a gate/hold and
//         told the Supervisor through its session) never wakes — it is
//         audit-only and only advances editsFiredThrough past itself;
//   · 2 — its lifetime ran out while children are still live (stderr says it
//         only re-arms: draining and ending the turn starts a fresh waker);
//   · 0 — nothing is live any more, the run is not there, another waker of
//         this session is already on duty, or a newer waker superseded it.
//
// Lease (waker.json, see supervisor-lib.mjs): every turn end fires this hook and
// the harness does not deduplicate, so a fresh lease of the SAME session id
// means "already on duty" and this copy exits 0. A different session id (the
// Supervisor was restarted) takes the lease over, so an orphan of a closed
// session cannot keep the new one asleep; the orphan notices on its next poll
// and exits without writing. Liveness is the heartbeat only — no process is
// ever probed. Every exit this waker owns stamps `endedAt`, so the next turn
// end starts a new one at once instead of waiting out a stale heartbeat.
//
// At most one wake per row: `firedThrough` survives takeovers. A row the lead
// drained but left unacked on purpose (a gate waiting for Mateusz) cannot wake
// the session in a loop.
//
// The watcher sets a child's terminal status BEFORE it appends the exit row, so
// "nothing live" is confirmed for a short grace window before the waker gives
// up — otherwise it could exit 0 one poll before the row it exists for.
//
// Writer discipline: writes ONLY <run>/waker.json. The queue, the ack, the
// registry, gates and edits.jsonl are read-only here.
//
// Env knobs (tests): LA_SUPERVISOR_WAKE_POLL_MS (default 1000),
// LA_SUPERVISOR_WAKE_GRACE_MS (default 3000), LA_SUPERVISOR_WAKE_MAX_MS
// (default 5.5 h — keep it below the hook `timeout` in
// agents/supervisor/settings.json, or the harness kills the waker first).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  liveChildren,
  parseArgs,
  readRegistry,
  readWakeAck,
  readWakeQueue,
  readWakerLease,
  runDir,
  wakerPath,
  wakerState,
} from "./supervisor-lib.mjs";
import { atomicWriteJSON } from "./utils.mjs";

export const DEFAULT_MAX_LIFETIME_MS = 19_800_000; // 5.5 h
const LISTED_ROWS = 5;

const envMs = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Rows the session has neither acked nor been woken for, in seq order. */
export function freshRows({ rows, ackedThrough = 0, firedThrough = 0 }) {
  return rows
    .filter((r) => r.seq > ackedThrough && r.seq > firedThrough)
    .sort((a, b) => a.seq - b.seq);
}

function describeRow(r) {
  if (r.event === "exit") return `#${r.seq} exit ${r.childId} (${r.detail?.status ?? "unknown"})`;
  if (r.event === "gate") return `#${r.seq} gate ${r.gateId} [${r.detail?.kind ?? "unknown"}]`;
  return `#${r.seq} ${r.event} ${r.childId ?? ""}`.trim();
}

/** The one-line system reminder the woken session reads. Ids and kinds only. */
export function formatWakeMessage(runId, rows) {
  const shown = rows.slice(0, LISTED_ROWS).map(describeRow).join(", ");
  const more = rows.length > LISTED_ROWS ? `, +${rows.length - LISTED_ROWS} more` : "";
  return (
    `supervisor-wake: ${rows.length} new wake event(s) in run ${runId}: ${shown}${more}` +
    " — drain now: node $LA_ROOT/scripts/supervisor-status.mjs --drain --tail 20"
  );
}

// ── edit records (FOC-795) ───────────────────────────────────────────────────
//
// edits.jsonl (one JSON row per line, single writer: scripts/agent-records.mjs)
// carries an audit row for every record Mateusz edits from the dashboard. The
// session holds its own copy of those records in context, so a row it has not
// been woken for is a stale-copy hazard: the rows above the lease's
// editsFiredThrough wake it exactly like queue rows, with a message that names
// the paths to re-read. Both watermarks live on the same lease and survive
// takeovers, so neither stream can wake twice for the same row.

/** The change field names of one edit row, joined — the "(fields)" of the message. */
export function editFields(row) {
  return (Array.isArray(row?.changes) ? row.changes : [])
    .map((c) => (c && typeof c.field === "string" ? c.field : null))
    .filter(Boolean)
    .join(", ");
}

/** The one-line system reminder for fresh edit rows. Paths and fields only. */
export function formatEditsMessage(runId, rows) {
  const shown = rows.slice(0, LISTED_ROWS).map((r) => `${r.path ?? "?"} (${editFields(r)})`).join(", ");
  const more = rows.length > LISTED_ROWS ? `, +${rows.length - LISTED_ROWS} more` : "";
  return (
    `supervisor-wake: Mateusz edited ${rows.length} record(s) in run ${runId}: ${shown}${more}` +
    ` — re-read them before acting: node $LA_ROOT/scripts/agent-records.mjs edits --run ${runId}`
  );
}

/**
 * Every valid edit row of the run, in file order. A torn or malformed line is
 * skipped, not fatal — same discipline as readWakeQueue.
 */
export function readEdits(runId) {
  const path = join(runDir(runId), "edits.jsonl");
  if (!existsSync(path)) return [];
  const rows = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row.seq === "number" && Number.isFinite(row.seq)) rows.push(row);
    } catch {
      /* torn or malformed line — see the doc comment */
    }
  }
  return rows;
}

/**
 * Edit rows above the watermark that should WAKE, in seq order. A row with
 * notified === true (FOC-783: the dashboard answered a gate/hold and told the
 * Supervisor through its session) is audit-only and never wakes — but the
 * watermark still advances past it (latestEditSeq, applied in main), so a
 * notified-only stream is not rescanned forever.
 */
export function freshEdits(rows, editsFiredThrough = 0) {
  return rows
    .filter((r) => r.seq > editsFiredThrough && r.notified !== true)
    .sort((a, b) => a.seq - b.seq);
}

/**
 * The watermark to advance to: the newest row above the watermark SEEN THIS
 * PASS, notified or not — while any un-notified row beyond it still re-delivers.
 */
export function latestEditSeq(rows, editsFiredThrough = 0) {
  let max = editsFiredThrough;
  for (const r of rows) if (r.seq > max) max = r.seq;
  return max;
}

// Tolerant, like the guard: an empty or malformed payload is an unknown stop.
function readPayload() {
  try {
    return JSON.parse(readFileSync(0, "utf8")) ?? {};
  } catch {
    return {};
  }
}

const seqOr0 = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function writeLease(runId, lease) {
  try {
    atomicWriteJSON(wakerPath(runId), lease);
    return true;
  } catch {
    return false;
  }
}

// null = the registry could not be read: unknown, never "nothing live".
function liveCount(runId) {
  try {
    return liveChildren(readRegistry(runId)).length;
  } catch {
    return null;
  }
}

async function main() {
  const payload = readPayload();
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : null;
  const args = parseArgs(process.argv.slice(2));
  const runId = args.run || process.env.LA_SUPERVISOR_RUN;
  if (!runId || !existsSync(runDir(runId))) return 0;

  const pollMs = envMs("LA_SUPERVISOR_WAKE_POLL_MS", 1000);
  const graceMs = envMs("LA_SUPERVISOR_WAKE_GRACE_MS", 3000);
  const maxMs = envMs("LA_SUPERVISOR_WAKE_MAX_MS", DEFAULT_MAX_LIFETIME_MS);

  const existing = readWakerLease(runId);
  if (wakerState(existing) === "alive" && (existing.sessionId ?? null) === sessionId) return 0;

  const startedAt = new Date().toISOString();
  let lease = {
    pid: process.pid,
    sessionId,
    startedAt,
    heartbeatAt: startedAt,
    firedThrough: seqOr0(existing?.firedThrough),
    editsFiredThrough: seqOr0(existing?.editsFiredThrough),
  };
  // Without a lease there is no firedThrough to record, and a waker that cannot
  // record what it fired for could wake the session in a loop. Stand down.
  if (!writeLease(runId, lease)) return 0;

  // Release on the harness's kill (hook timeout) or an interrupt: the next turn
  // end must be able to start a new waker at once.
  const release = () => {
    const current = readWakerLease(runId);
    if (current?.pid === process.pid) writeLease(runId, { ...current, endedAt: new Date().toISOString() });
    process.exit(0);
  };
  process.on("SIGTERM", release);
  process.on("SIGINT", release);

  const deadline = Date.now() + maxMs;
  let nothingLiveSince = null;

  for (;;) {
    const current = readWakerLease(runId);
    if (current?.pid !== process.pid) return 0; // superseded: the lease is not ours to write
    lease = current;

    const fresh = freshRows({
      rows: readWakeQueue(runId),
      ackedThrough: readWakeAck(runId),
      firedThrough: seqOr0(lease.firedThrough),
    });
    const editRows = readEdits(runId);
    const editsThrough = seqOr0(lease.editsFiredThrough);
    const freshEditsRows = freshEdits(editRows, editsThrough);
    const editsSeenUpTo = latestEditSeq(editRows, editsThrough);
    const now = new Date().toISOString();
    if (fresh.length || freshEditsRows.length) {
      // Each watermark advances to the newest row SEEN IN ITS OWN STREAM — a
      // fresh edit must never retire an unfired queue row, or the reverse.
      // editsSeenUpTo passes notified rows too: they were seen, they just do
      // not wake.
      writeLease(runId, {
        ...lease,
        heartbeatAt: now,
        endedAt: now,
        firedThrough: fresh.length ? fresh[fresh.length - 1].seq : seqOr0(lease.firedThrough),
        editsFiredThrough: editsSeenUpTo,
      });
      if (fresh.length) process.stderr.write(formatWakeMessage(runId, fresh) + "\n");
      if (freshEditsRows.length) process.stderr.write(formatEditsMessage(runId, freshEditsRows) + "\n");
      return 2;
    }
    if (editsSeenUpTo !== editsThrough) {
      // Notified rows only (FOC-783): nothing wakes, but the watermark moves
      // past them so the audit stream is never rescanned as fresh. The local
      // lease is updated too — the loop's heartbeat write would otherwise
      // clobber the advance with the stale watermark.
      lease = { ...lease, heartbeatAt: now, editsFiredThrough: editsSeenUpTo };
      writeLease(runId, lease);
    }

    const live = liveCount(runId);
    if (live === 0) {
      nothingLiveSince ??= Date.now();
      if (Date.now() - nothingLiveSince >= graceMs) {
        writeLease(runId, { ...lease, heartbeatAt: now, endedAt: now });
        return 0;
      }
    } else {
      nothingLiveSince = null;
    }

    if (Date.now() >= deadline) {
      writeLease(runId, { ...lease, heartbeatAt: now, endedAt: now });
      const hours = (maxMs / 3_600_000).toFixed(1);
      const what = live === null ? "an unreadable registry" : `${live} live child(ren)`;
      process.stderr.write(
        `supervisor-wake: still waiting on ${what} in run ${runId} after ${hours} h with no new event` +
          " — this wake only re-arms the waker; drain, then end the turn.\n",
      );
      return 2;
    }

    writeLease(runId, { ...lease, heartbeatAt: now });
    await sleep(pollMs);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      // A crashing waker must not wake the session with a stack trace: exit 0
      // and leave the lease to go stale.
      process.stderr.write(`supervisor-wake: ${err?.message ?? err}\n`);
      process.exitCode = 0;
    },
  );
}
