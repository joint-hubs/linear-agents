// scripts/supervisor-status.mjs — what are the children doing, and how the lead
// drains the wake queue.
//
//   node scripts/supervisor-status.mjs [--run <id>] [--child <id>] [--tail <n>]
//                                      [--wait] [--timeout-ms <ms>]
//                                      [--drain] [--ack <seq>] [--briefing]
//
// Snapshot mode returns immediately. Wait mode blocks until the child exits, a
// pending gate appears, or the timeout elapses — kept for a SHORT bounded wait
// (≤ 120 s). It reports which of five things happened:
//
//   exit     a child that was live has finished       → read the result, route on
//   gate     a gate appeared that was not pending     → present it to Mateusz
//   timeout  still running, nothing new               → end the turn; the wake
//                                                     queue replaces the old
//                                                     in-turn backoff chain
//   idle     nothing is live; there is nothing to     → read the result, route on
//            wait for, so it returned without waiting
//
// Drain mode (FOC-608) prints the wake queue's un-acked rows — child exits,
// gates and stalls the watcher classified while nobody was waiting. Ack mode
// retires rows through a seq, persisting the watermark so a reader restart does
// not re-deliver them. This script writes ONLY the ack store; the queue itself
// is written only by the watcher.
//
// HARD CONTRACT: this script NEVER probes a process. Liveness is written by the
// watcher (supervisor-watch.mjs) and read here. If a status is wrong, the bug is
// in the watcher, not in a missing `kill -0` — adding one would create a second
// source of truth that disagrees with the first at exactly the worst moment.
//
// Stall is judged on WALL CLOCK: the tee has to be silent for 5 × the base
// timeout (default 5 × 120 s = 10 min). The watcher enqueues a `stall` row at
// the same threshold — one shared constant, not two that drift apart.
//
// Briefing mode (FOC-609) is the SessionStart digest: one call at the start of
// a turn that names everything the lead owes attention to — live and held
// children, pending gates, un-acked wake rows, the last action per child. It is
// read-only and deliberately tolerant of a run that does not exist yet: the
// SessionStart hook fires before the first spawn too, and a hook that exits 1
// would inject an error into the session context instead of a briefing.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteJSON } from "./utils.mjs";
import {
  TERMINAL_STATUSES,
  pollBaseMs,
  readHeld,
  readWakeAck,
  readWakeQueue,
  readRegistry,
  stallSilenceMs,
  addCost,
  budgetStatus,
  failJson,
  gatesDir,
  parseArgs,
  runDir,
  teeAbsPath,
  waitArmedPath,
  wakeQueueMaxSeq,
  writeWakeAck,
} from "./supervisor-lib.mjs";

const BASE_POLL_MS = pollBaseMs();
const STALL_SILENCE_MS = stallSilenceMs();
const SNIPPET_CHARS = 200;
// The armed-wait marker's TTL is the wait's own timeout plus this grace, so a
// wait that is finishing up as the guard fires is still counted as armed, while
// a wait process that crashed without cleaning up expires out of the judgement.
const ARMED_GRACE_MS = 60_000;
// A finished `--wait` leaves its outcome behind instead of vanishing. The grace
// is deliberately long: the lead owes real work after a timeout (read the tee,
// judge, write the state doc) and the marker has to still be there at the turn
// end. What scopes the allowance to ONE turn end is not this TTL but the guard
// charging it in guard/state.json — the TTL is only the crash net for a turn end
// that never reached the guard at all.
const SPENT_GRACE_MS = 45 * 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Minimal denylist, applied ONLY to text printed to the operator. The tee on
// disk stays unredacted — it is local and gitignored, and a scrubbed tee would
// be useless for debugging the one case where the secret matters.
//
// This is not a secret scanner and does not pretend to be: it catches the shapes
// that actually show up in agent output (a key echoed by a failing curl, an
// Authorization header in a stack trace), not every possible credential.
const REDACTIONS = [
  [/\bsk-[A-Za-z0-9_-]{6,}/g, "sk-***"],
  [/\blin_api_[A-Za-z0-9_-]{6,}/g, "lin_api_***"],
  [/\b(api[_-]?key)\s*[=:]\s*\S+/gi, "$1=***"],
  [/\bBearer\s+\S+/gi, "Bearer ***"],
  [/\b(password)\s*[=:]\s*\S+/gi, "$1=***"],
];

export function redact(text) {
  let out = String(text ?? "");
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out;
}

function snippetOf(event) {
  if (event.type === "assistant") {
    const parts = event.message?.content ?? [];
    const text = parts.map((p) => p.text ?? `[${p.type}]`).join(" ");
    return text;
  }
  if (event.type === "result") {
    return `${event.subtype ?? "result"} cost=${event.total_cost_usd ?? event.cost_usd ?? 0}`;
  }
  if (event.type === "system") return `${event.subtype ?? "system"}`;
  if (event.type === "supervisor") return `${event.subtype ?? "note"}: ${event.message ?? ""}`;
  if (event.type === "user") return "[user turn]";
  return event.type ?? "unknown";
}

function tailEvents(runId, childId, count) {
  if (!count) return [];
  const path = teeAbsPath(runId, childId);
  if (!existsSync(path)) return [];

  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
  return lines.slice(-count).map((line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return { type: "unparsed", timestamp: null, text: redact(line).slice(0, SNIPPET_CHARS) };
    }
    return {
      type: event.type ?? "unknown",
      subtype: event.subtype ?? null,
      timestamp: event.ts ?? event.timestamp ?? null,
      text: redact(snippetOf(event)).slice(0, SNIPPET_CHARS),
    };
  });
}

// Activity is measured by the tee GROWING. mtime alone is too coarse on some
// filesystems and can be touched without a write; byte length cannot.
function teeActivity(runId, childId) {
  const path = teeAbsPath(runId, childId);
  if (!existsSync(path)) return { size: 0, mtimeMs: 0 };
  const s = statSync(path);
  return { size: s.size, mtimeMs: s.mtimeMs };
}

function pendingGates(runId) {
  const dir = gatesDir(runId);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    try {
      const gate = JSON.parse(readFileSync(join(dir, file), "utf8"));
      if (gate.status === "pending") {
        out.push({
          gateId: gate.gateId ?? file.replace(/\.json$/, ""),
          childId: gate.childId ?? null,
          kind: gate.kind ?? null,
          summary: redact(gate.summary ?? "").slice(0, SNIPPET_CHARS),
          questions: (gate.questions ?? []).map((q) => redact(q).slice(0, SNIPPET_CHARS)),
          createdAt: gate.createdAt ?? null,
        });
      }
    } catch {
      // A malformed gate file must not hide the well-formed ones.
      out.push({ gateId: file.replace(/\.json$/, ""), kind: "unreadable", summary: "", questions: [] });
    }
  }
  return out;
}

function snapshot(runId, { childFilter, tail }) {
  const registry = readRegistry(runId);
  const now = Date.now();

  const entries = Object.values(registry.children).filter(
    (c) => !childFilter || c.childId === childFilter,
  );

  const children = entries.map((entry) => {
    const activity = teeActivity(runId, entry.childId);
    // FOC-271: the silence window is wall-clock from the LAST sign of activity.
    // A resumed turn can start long after the previous turn's last tee write, so
    // the tee's mtime alone counts the predecessor's silence against the fresh
    // turn — "stalled" before it ever spoke. The window resets at turn start:
    // silence runs from the LATEST of the tee write and the live turn's start.
    const turns = Array.isArray(entry.turns) ? entry.turns : [];
    const liveTurn = [...turns].reverse().find((t) => t && !t.endedAt) || null;
    const turnStart = liveTurn?.startedAt ? Date.parse(liveTurn.startedAt) : NaN;
    const activityMs = Math.max(activity.mtimeMs || 0, Number.isFinite(turnStart) ? turnStart : 0);
    const silentMs = activityMs ? now - activityMs : null;
    return {
      ...entry,
      events: tailEvents(runId, entry.childId, tail),
      silentMs,
      // Stalled is only meaningful for a child that is supposed to be producing
      // output. A finished child is silent by definition, not stalled.
      stalled: !TERMINAL_STATUSES.includes(entry.status) && silentMs !== null && silentMs >= STALL_SILENCE_MS,
    };
  });

  return {
    ok: true,
    runId,
    children,
    pendingGates: pendingGates(runId),
    totals: {
      // Provenance: the watcher prices each `result` event from its TOKEN COUNTS
      // through config/models.json; this is the sum of those. `null` means at
      // least one model had no price row, so the total is UNKNOWN — never 0.
      // The stream's own figure is reported separately and is not trusted:
      // Claude Code computes it for models it does not recognise (FOC-165).
      costUsd: entries.reduce((acc, c) => addCost(acc, c.costUsd === undefined ? 0 : c.costUsd), 0),
      costUsdReported: entries.reduce((sum, c) => sum + (c.costUsdReported || 0), 0),
      unpricedModels: [...new Set(entries.flatMap((c) => c.unpricedModels || []))],
      children: entries.length,
      live: entries.filter((c) => !TERMINAL_STATUSES.includes(c.status)).length,
    },
    budget: budgetStatus(runId, registry),
    // FOC-163 replaced the round counter with a progress signal. Two distinct
    // conditions, deliberately NOT merged into one "stuck" flag:
    //
    //   · stalled  — the tee went silent (wall clock, unchanged). The child is
    //                not producing output. Says nothing about the work.
    //   · repeated — the last two REVIEW rounds fingerprinted the same. The
    //                child is producing output that changes nothing.
    //
    // A live child can be busy and going nowhere; a silent one may have finished.
    // Collapsing them would leave the lead unable to tell which it is looking at,
    // and the two need opposite responses.
    // Held spawn requests (FOC-161). Held is NOT refused: the request is on
    // disk and starts when a slot frees. It is reported here because the
    // Supervisor has no other way to know it asked for something that has
    // not begun — and `reason` separates a full node from a saturated
    // consumer, which need different responses.
    held: readHeld(runId).map((h) => ({
      heldId: h.heldId,
      squad: h.squad ?? null,
      taskId: h.taskId ?? null,
      reason: h.reason ?? (h.unreadable ? "unreadable" : null),
      consumer: h.consumer ?? null,
      heldAt: h.heldAt ?? null,
    })),
    rounds: registry.rounds ?? {},
    repeatedTasks: Object.entries(registry.rounds ?? {})
      .filter(([, p]) => p?.repeated === true)
      .map(([taskId, p]) => ({ taskId, rounds: p.rounds, fingerprint: p.latest })),
    stallSilenceMs: STALL_SILENCE_MS,
  };
}

const args = parseArgs(process.argv.slice(2));
const runId = args.run || process.env.LA_SUPERVISOR_RUN;
const childFilter = args.child || null;
const tail = Number(args.tail ?? 0);

// ── briefing (FOC-609) ───────────────────────────────────────────────────────
// The SessionStart digest. Unlike every other mode this one is TOLERANT of a
// missing run: the hook fires on session start, which may precede the first
// spawn, and a failing hook would inject an error into the session context
// instead of a briefing. No run resolvable, or the run dir not there yet →
// say so on stderr and exit 0 with empty stdout.
if (args.briefing) {
  if (!runId || !existsSync(runDir(runId))) {
    console.error(`briefing: no run to brief (${runId ? "run dir missing" : "no --run / LA_SUPERVISOR_RUN"})`);
    process.exit(0);
  }
  const registry = readRegistry(runId);
  const ackedThrough = readWakeAck(runId);
  const rows = readWakeQueue(runId);
  const unacked = rows.filter((r) => r.seq > ackedThrough);
  const entries = Object.values(registry.children);
  console.log(
    JSON.stringify(
      {
        ok: true,
        runId,
        mode: "briefing",
        live: entries
          .filter((c) => !TERMINAL_STATUSES.includes(c.status))
          .map((c) => ({ childId: c.childId, squad: c.squad ?? null, status: c.status })),
        held: readHeld(runId).map((h) => ({
          heldId: h.heldId,
          squad: h.squad ?? null,
          taskId: h.taskId ?? null,
          reason: h.reason ?? (h.unreadable ? "unreadable" : null),
        })),
        pendingGates: pendingGates(runId).map((g) => ({
          gateId: g.gateId,
          kind: g.kind,
          childId: g.childId ?? null,
          summary: g.summary,
        })),
        wake: {
          ackedThrough,
          unackedCount: unacked.length,
          totalRows: rows.length,
          unacked: unacked.map((r) => ({ seq: r.seq, event: r.event, childId: r.childId ?? null })),
        },
        // Last action per child, from the registry only: the watcher's status,
        // plus when the last turn ended and how. No tee content here — the
        // drain (`--drain --tail n`) is where the events themselves are read.
        lastAction: entries.map((c) => {
          const turns = Array.isArray(c.turns) ? c.turns : [];
          const last = turns[turns.length - 1] ?? null;
          return {
            childId: c.childId,
            status: c.status,
            lastTurnEndedAt: last?.endedAt ?? null,
            lastTurnExitCode: last?.exitCode ?? null,
          };
        }),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

if (!runId) failJson("--run <runId> is required (or set LA_SUPERVISOR_RUN)");
if (!existsSync(runDir(runId))) failJson(`no such run: ${runId}`, { expected: runDir(runId) });

// ── drain / ack (FOC-608) ────────────────────────────────────────────────────
// The Supervisor's start-of-turn read: what happened while nobody was waiting.
// Un-acked rows only — acked ones never come back, because the watermark is
// persisted next to the queue, not held in this process.
if (args.drain) {
  const rows = readWakeQueue(runId);
  const ackedThrough = readWakeAck(runId);
  const unacked = rows.filter((r) => r.seq > ackedThrough);
  console.log(
    JSON.stringify(
      {
        ok: true,
        runId,
        mode: "drain",
        ackedThrough,
        unackedCount: unacked.length,
        totalRows: rows.length,
        unacked,
        stalledChildren: snapshot(runId, { childFilter, tail: 0 }).children
          .filter((c) => c.stalled)
          .map((c) => c.childId),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

if (args.ack !== undefined) {
  if (typeof args.ack !== "string" || !/^\d+$/.test(args.ack)) {
    failJson("--ack <seq> requires the sequence number to retire through", {
      got: args.ack === true ? "(no seq given)" : String(args.ack),
    });
  }
  const seq = Number(args.ack);
  let ackedThrough;
  try {
    ackedThrough = writeWakeAck(runId, seq);
  } catch (err) {
    // Refused, not recorded. An ack past the last row blinds the queue to
    // everything that has not happened yet — see wakeQueueMaxSeq(). A typo here
    // would otherwise end supervision of the run and report success doing it.
    failJson(err.message, {
      validRange: `0..${wakeQueueMaxSeq(runId)}`,
      why: "rows are numbered max(seq)+1 and delivered while seq > ackedThrough, so an ack above the last row retires every future event",
    });
  }
  const remaining = readWakeQueue(runId).filter((r) => r.seq > ackedThrough).length;
  console.log(
    JSON.stringify({ ok: true, runId, mode: "ack", ackedThrough, unackedCount: remaining }, null, 2),
  );
  process.exit(0);
}

if (!args.wait) {
  console.log(JSON.stringify({ ...snapshot(runId, { childFilter, tail }), mode: "snapshot" }, null, 2));
  process.exit(0);
}

// ── wait mode ────────────────────────────────────────────────────────────────
const timeoutMs = Number(args["timeout-ms"] ?? BASE_POLL_MS);
const deadline = Date.now() + timeoutMs;

// Armed-wait marker (FOC-609): for as long as this wait is blocked, the stop-
// hook guard must see the turn as legitimately open and allow it to end. The
// marker carries a TTL (the wait's timeout plus a small grace) rather than
// relying on cleanup — a wait process killed mid-poll leaves the marker behind,
// and it expires out of the guard's judgement on its own. A normal completion
// rewrites the marker with the outcome rather than erasing it (see `finally`).
const armedAt = new Date().toISOString();
mkdirSync(runDir(runId), { recursive: true });
atomicWriteJSON(waitArmedPath(runId), {
  armedAt,
  expiresAt: deadline + ARMED_GRACE_MS,
});

const before = snapshot(runId, { childFilter, tail: 0 });
const gatesBefore = new Set(before.pendingGates.map((g) => g.gateId));
const wasTerminal = new Set(
  before.children.filter((c) => TERMINAL_STATUSES.includes(c.status)).map((c) => c.childId),
);

let reason = "timeout";
let current = before;

// Nothing live means nothing CAN change: only a running child writes the
// registry or drops a gate file. Without this guard the loop burns the whole
// timeout and reports `timeout` on a child that had already finished before the
// wait began. The baselining below is what makes that reachable: an
// already-terminal child is deliberately not reported as "just exited", and
// with no live sibling there is nothing else to report either.
//
// Found by running the pipeline end to end (triage → spawn → status), where the
// mock child exits in milliseconds and the gap is always hit. A read-through
// would not have shown it: every unit test starts its wait while a child runs.
if (before.totals.live === 0) {
  // ...unless something is HELD. `idle` tells the lead to stop waiting and read
  // the result (agents/supervisor/CLAUDE.md §4), which for a run with a held
  // spawn means walking away from work that was never started — the exact
  // outcome "held is not dropped" exists to prevent. A distinct reason, because
  // the action is distinct: release it, do not stop.
  reason = before.held?.length ? "held" : "idle";
}

try {
  while (reason === "timeout" && Date.now() < deadline) {
    await sleep(500);
    current = snapshot(runId, { childFilter, tail: 0 });

    // (a) a child that was live has finished
    const justExited = current.children.find(
      (c) => TERMINAL_STATUSES.includes(c.status) && !wasTerminal.has(c.childId),
    );
    if (justExited) {
      reason = "exit";
      break;
    }

    // (b) a gate appeared that was not pending when we started waiting
    if (current.pendingGates.some((g) => !gatesBefore.has(g.gateId))) {
      reason = "gate";
      break;
    }
  }
} finally {
  // The wait is over. Erase nothing: record the outcome instead, so the guard
  // can tell "a wait is running now" from "a wait already ran in this turn".
  // A `timeout` is the lead's one diligence step for the turn (CLAUDE.md §4 —
  // the child got its window, there is nothing to judge, end the turn and let
  // the wake queue carry the event on), and the guard allows exactly one turn
  // end on it. Any other outcome changed the situation and grants nothing.
  atomicWriteJSON(waitArmedPath(runId), {
    armedAt,
    spentAt: new Date().toISOString(),
    outcome: reason,
    expiresAt: Date.now() + SPENT_GRACE_MS,
  });
}

const final = snapshot(runId, { childFilter, tail });

console.log(
  JSON.stringify(
    {
      ...final,
      mode: "wait",
      reason,
      waitedMs: timeoutMs - Math.max(0, deadline - Date.now()),
      // Present on every wait so the lead can apply the cadence without keeping
      // its own counter: any stalled child means stop + escalate, regardless of
      // how many times it has polled or what backoff it used.
      stalledChildren: final.children.filter((c) => c.stalled).map((c) => c.childId),
      // The other stall condition, reported separately on purpose (FOC-163):
      // silence means no output, a repeated fingerprint means output that
      // changed nothing. Escalating one as the other sends the wrong question
      // to Mateusz.
      repeatedTasks: final.repeatedTasks ?? [],
      // Only `timeout` means "still running, ask again later". `idle` means
      // there is nothing left to wait for. Kept for output compatibility with
      // existing consumers (FOC-608): the Monitor loop no longer re-issues
      // waits in a backoff chain — it ends the turn and drains the wake queue —
      // but the field's value and shape are unchanged.
      nextBackoffHint: reason === "timeout" ? Math.min(timeoutMs * 2, BASE_POLL_MS * 4) : BASE_POLL_MS,
      // Only present when the reason is `held`, so the lead does not have to
      // work out what to do with a run that is neither running nor finished.
      ...(reason === "held"
        ? { next: `node scripts/supervisor-spawn.mjs --release --run ${runId}` }
        : {}),
    },
    null,
    2,
  ),
);
