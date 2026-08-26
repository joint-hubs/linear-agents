// scripts/supervisor-status.mjs — what are the children doing, and the lead's
// only way to wait.
//
//   node scripts/supervisor-status.mjs [--run <id>] [--child <id>] [--tail <n>]
//                                      [--wait] [--timeout-ms <ms>]
//
// Snapshot mode returns immediately. Wait mode blocks until the child exits, a
// pending gate appears, or the timeout elapses — Claude Code has no spontaneous
// wakeup, so without this the lead would burn a turn per poll. It reports which
// of four things happened:
//
//   exit     a child that was live has finished       → read the result, route on
//   gate     a gate appeared that was not pending     → present it to Mateusz
//   timeout  still running, nothing new               → re-issue with backoff
//   idle     nothing is live; there is nothing to     → read the result, route on
//            wait for, so it returned without waiting
//
// HARD CONTRACT: this script NEVER probes a process. Liveness is written by the
// watcher (supervisor-watch.mjs) and read here. If a status is wrong, the bug is
// in the watcher, not in a missing `kill -0` — adding one would create a second
// source of truth that disagrees with the first at exactly the worst moment.
//
// Monitor cadence (the lead's contract; FOC-124 restates this in
// agents/supervisor/CLAUDE.md): after every spawn or follow-up, call
// `status --wait`; on `timeout`, re-issue with backoff ×1, ×2, ×4, capped at 4×
// the base timeout. Stall is judged on WALL CLOCK, not on how many times the
// lead called: the tee has to be silent for 5 × the base timeout (default
// 5 × 120 s = 10 min). That is why backoff cannot stretch the kill SLA, and why
// there is one constant here rather than two that drift apart.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  TERMINAL_STATUSES,
  readHeld,
  addCost,
  budgetStatus,
  failJson,
  gatesDir,
  parseArgs,
  readRegistry,
  runDir,
  teeAbsPath,
} from "./supervisor-lib.mjs";

const BASE_POLL_MS = Number(process.env.LA_SUPERVISOR_POLL_MS ?? 120_000);
const STALL_SILENCE_MS = BASE_POLL_MS * 5;
const SNIPPET_CHARS = 200;

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
    const silentMs = activity.mtimeMs ? now - activity.mtimeMs : null;
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

if (!runId) failJson("--run <runId> is required (or set LA_SUPERVISOR_RUN)");
if (!existsSync(runDir(runId))) failJson(`no such run: ${runId}`, { expected: runDir(runId) });

if (!args.wait) {
  console.log(JSON.stringify({ ...snapshot(runId, { childFilter, tail }), mode: "snapshot" }, null, 2));
  process.exit(0);
}

// ── wait mode ────────────────────────────────────────────────────────────────
const timeoutMs = Number(args["timeout-ms"] ?? BASE_POLL_MS);
const deadline = Date.now() + timeoutMs;

const before = snapshot(runId, { childFilter, tail: 0 });
const gatesBefore = new Set(before.pendingGates.map((g) => g.gateId));
const wasTerminal = new Set(
  before.children.filter((c) => TERMINAL_STATUSES.includes(c.status)).map((c) => c.childId),
);

let reason = "timeout";
let current = before;

// Nothing live means nothing CAN change: only a running child writes the
// registry or drops a gate file. Without this guard the loop burns the whole
// timeout and reports `timeout` — which the cadence in agents/supervisor/CLAUDE.md
// answers with a backoff, so up to 4x the base timeout is spent waiting on a
// child that had already finished before the wait began. The baselining below
// is what makes that reachable: an already-terminal child is deliberately not
// reported as "just exited", and with no live sibling there is nothing else to
// report either.
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
      // there is nothing left to wait for, so backing off would be waiting on
      // no one.
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
