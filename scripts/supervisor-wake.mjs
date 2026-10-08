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
// registry and gates are read-only here.
//
// Env knobs (tests): LA_SUPERVISOR_WAKE_POLL_MS (default 1000),
// LA_SUPERVISOR_WAKE_GRACE_MS (default 3000), LA_SUPERVISOR_WAKE_MAX_MS
// (default 5.5 h — keep it below the hook `timeout` in
// agents/supervisor/settings.json, or the harness kills the waker first).

import { existsSync, readFileSync } from "node:fs";
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
    const now = new Date().toISOString();
    if (fresh.length) {
      writeLease(runId, {
        ...lease,
        heartbeatAt: now,
        endedAt: now,
        firedThrough: fresh[fresh.length - 1].seq,
      });
      process.stderr.write(formatWakeMessage(runId, fresh) + "\n");
      return 2;
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
