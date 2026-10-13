// scripts/cockpit-routes.mjs — the Cockpit's routes on the telemetry server
// (FOC-783 plan §3, slice S7): the /api/cockpit snapshot, the Supervisor chat
// endpoints, and the gate/hold answering endpoints.
//
// This module is TRANSPORT ONLY. Everything it serves is derived in libraries
// (cockpit.mjs, supervisor-conversation.mjs, supervisor-host-client.mjs,
// supervisor-lib.mjs) and the write paths go through the same libraries the
// CLI and the Supervisor use (supervisor-gate.mjs answerGate/answerHold,
// agent-records.mjs recordAnswerRow) — the route layer only guards, parses,
// maps statuses and passes bodies through. Guard order, body handling and the
// error shape mirror the FOC-795 records routes in telemetry-server.mjs
// exactly: isLocalOrigin first, isAllowedOrigin second, then the body.
//
// The terminal WebSocket is not proxied through the request handler — it is an
// `upgrade` event. handleTerminalUpgrade validates the handshake with STRICTER
// rules than the POST routes (Origin must equal the Host header exactly, so a
// page served from another local port cannot open the terminal) and then pipes
// raw TCP to the session host; it never forwards Origin or cookies.

import { readFileSync } from "node:fs";
import { resolve as resolvePath, sep } from "node:path";
import net from "node:net";

import { hostBase, hostRequest, FAST_TIMEOUT_MS, SLOW_TIMEOUT_MS } from "./supervisor-host-client.mjs";
import { collectNeedsYou, collectChildren, cockpitCounts, focusTicket, recentRunIds } from "./cockpit.mjs";
import { readConversation } from "./supervisor-conversation.mjs";
import { gatePath, processAlive, readHolds, readWakeAck, readWakeQueue, readWakerLease, redactDeep, wakerState } from "./supervisor-lib.mjs";
import { freshRows, formatWakeMessage } from "./supervisor-wake.mjs";
import { answerGate, answerHold } from "./supervisor-gate.mjs";
import { autoLabel } from "./decision-log.mjs";
import { resolveRunsDir } from "./decision-analytics.mjs";
import { recordAnswerRow } from "./agent-records.mjs";
import { readCurrentRun } from "./supervisor-current-run.mjs";
import { readPendingAsk } from "./session-dialog.mjs";
import { hostTokenPath, supervisorSessionPath, squadConfigDir } from "./fenix-paths.mjs";

// The body cap for the cockpit POSTs: chat messages and gate/hold answers are
// control payloads, not documents — 16 KB like the contract, above the 8 KB
// default but far below the record-editor's 300 KB.
const BODY_CAP = 16 * 1024;

// The snapshot's GET /dialog budget (FOC-810): the host captures the tmux pane
// and parses it, but the snapshot must stay a fast poll — a slow or broken
// host reads as "no dialog" (null), never as a hung snapshot.
const DIALOG_TIMEOUT_MS = 1_500;

// One free-text ask answer is capped at this many characters in the audit row
// (the same bound askKeyPlan enforces on the host side).
const ASK_ANSWER_CAP = 2_000;

// ── small shared readers ─────────────────────────────────────────────────────

/** The Supervisor's session.json, or null when absent/unreadable. Never throws. */
function readSupervisorSession(env = process.env) {
  try {
    const parsed = JSON.parse(readFileSync(supervisorSessionPath(env), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The transcript path is trusted ONLY when it ends .jsonl AND resolves inside
 * the Supervisor's config dir (agents/supervisor/**) — the file is read by
 * offset, so a path pointing anywhere else on disk must never be honoured.
 */
function confinedTranscriptPath(session, env = process.env) {
  const p = typeof session?.transcriptPath === "string" ? session.transcriptPath : null;
  if (!p || !p.endsWith(".jsonl")) return null;
  const root = resolvePath(squadConfigDir("supervisor", env));
  const abs = resolvePath(p);
  return abs === root || abs.startsWith(root + sep) ? abs : null;
}

/** The waker lease of one run, in the shape supervisor-status's briefing emits. */
function wakerOf(runId) {
  const lease = readWakerLease(runId);
  return {
    state: wakerState(lease),
    heartbeatAt: lease?.heartbeatAt ?? null,
    firedThrough: lease?.firedThrough ?? null,
    sessionId: lease?.sessionId ?? null,
  };
}

/**
 * The run the live Supervisor session belongs to (FOC-807): the current-run
 * record's id when the pointer file exists, else the focus-ticket run — the
 * pre-record heuristic, kept as the fallback. One resolution for every wake
 * concern: the snapshot's waker/backlog and the Wake prompt all use it.
 */
function supRunIdOf(current, focus) {
  return current?.runId ?? focus?.runId ?? null;
}

/**
 * The current-run record's DECLARED focus (FOC-769) — what supervisor-focus.mjs
 * wrote (`{ kind, taskId, at, source }` on the live record) — as the snapshot
 * shape `{ taskId, kind, runId, at, source, declared: true }`. Returned only
 * when the record carries a focus AND names the Supervisor run it was declared
 * for (`supRunIdOf` semantics unchanged: the record's runId leads). Anything
 * else is null — the caller falls back to the triage heuristic. An overhead
 * focus keeps taskId null; `kind` is what the UI reads it by.
 */
function declaredFocusOf(current, supRunId) {
  const f = current?.focus;
  if (!f || typeof f !== "object" || Array.isArray(f)) return null;
  if (!current.runId || current.runId !== supRunId) return null;
  return {
    taskId: typeof f.taskId === "string" ? f.taskId : null,
    kind: f.kind === "overhead" ? "overhead" : "ticket",
    runId: current.runId,
    at: typeof f.at === "string" ? f.at : null,
    source: typeof f.source === "string" ? f.source : null,
    declared: true,
  };
}

/** Un-acked wake-queue rows — { count, oldestAt }, oldestAt the oldest un-acked row's ts (null when none). Read-only, never writes the ack. When `supRunId` is known ONLY that run is counted; otherwise the 14-day sum over every recent run. */
function wakeBacklog(runIds, supRunId = null) {
  let count = 0;
  let oldestAt = null;
  for (const runId of supRunId ? [supRunId] : runIds) {
    const ackedThrough = readWakeAck(runId);
    for (const row of readWakeQueue(runId)) {
      if (row.seq <= ackedThrough) continue;
      count++;
      const t = Date.parse(row.ts);
      if (Number.isFinite(t) && (oldestAt === null || t < Date.parse(oldestAt))) oldestAt = row.ts;
    }
  }
  return { count, oldestAt };
}

/** The drain prompt the Wake button sends: the waker's own wording, prefixed. */
function wakePromptText() {
  const prefix = "[dashboard] Mateusz asked you to check waiting events: ";
  const drain = "drain now: node $LA_ROOT/scripts/supervisor-status.mjs --drain --tail 20";
  const runId = supRunIdOf(readCurrentRun(), focusTicket());
  if (runId) {
    const fresh = freshRows({
      rows: readWakeQueue(runId),
      ackedThrough: readWakeAck(runId),
      firedThrough: readWakerLease(runId)?.firedThrough ?? 0,
    });
    if (fresh.length) return prefix + formatWakeMessage(runId, fresh);
  }
  return prefix + drain;
}

// ── the guard / forward / error-mapping helpers ──────────────────────────────

/**
 * The two write guards of every POST route, in the records routes' order and
 * wording. Exported for the sibling transport modules that forward write
 * POSTs with the same guards (the Work board's Start, FOC-784 W5) — the
 * behaviour is shared, not copied.
 */
export function writeGuards(req, res, path, ctx) {
  const { isLocalOrigin, isAllowedOrigin, json, log } = ctx;
  if (!isLocalOrigin(req.socket.remoteAddress)) {
    json(res, 403, { error: `forbidden: ${path} is 127.0.0.1 only` });
    log(req.method, path, 403);
    return false;
  }
  if (!isAllowedOrigin(req.headers.origin)) {
    json(res, 403, { error: `forbidden origin: ${path} is same-origin loopback only` });
    log(req.method, path, 403);
    return false;
  }
  return true;
}

/**
 * Forward one call to the session host and pass its status/body through.
 * Native mode and an unreachable host are answered HERE, in the shape every
 * host-backed route shares. Returns the host result, or null when answered.
 */
async function forwardToHost(res, ctx, routePath, hostPath, payload, timeoutMs) {
  const { json, log } = ctx;
  if (!hostBase()) {
    json(res, 503, { error: "docker-only" });
    log("POST", routePath, 503);
    return null;
  }
  const result = await hostRequest("POST", hostPath, payload, { timeoutMs });
  if (result.status === 0) {
    json(res, 503, { error: "host-unreachable", reason: result.error });
    log("POST", routePath, 503);
    return null;
  }
  json(res, result.status, result.body);
  log("POST", routePath, result.status);
  return result;
}

/**
 * Thin exported wrapper around forwardToHost for the /message forward — the
 * Work board's Start (FOC-784 W5) sends the hand-off text exactly like the
 * Cockpit chat does. The caller names its own route path for the log line;
 * the behaviour (503 docker-only natively, 503 host-unreachable, status/body
 * pass-through otherwise) is forwardToHost's, unchanged.
 */
export async function forwardMessageToHost(res, ctx, routePath, text) {
  return forwardToHost(res, ctx, routePath, "/message", { text }, SLOW_TIMEOUT_MS);
}

/** Map an answerGate/answerHold error code to its HTTP status (contract: the recordErrorStatus shape). */
function answerErrorStatus(code) {
  if (code === "busy") return 503;
  if (code === "not-found") return 404;
  if (code === "already-answered") return 409;
  if (code === "invalid-answer" || code === "bad-id") return 400;
  return 500;
}

/**
 * The error body for a failed answer. "busy" is retryable — the reason is the
 * fixed contract string, not the library message (which names a lock path the
 * UI should never show); everything else keeps the library's message.
 */
function answerErrorBody(err) {
  if (err?.code === "busy") return { error: "busy", reason: "another answer is being recorded — try again" };
  return { error: err?.code || "internal", reason: err?.message };
}

// ── the /api/cockpit snapshot cache ──────────────────────────────────────────
//
// Building the snapshot costs 70–145 ms of synchronous fs reads (53 runs) and
// the Cockpit polls it every 5 s while the nav badge hits it on every page.
// A module-level cache with a short TTL absorbs the burst: within the TTL the
// cached payload is served as-is, concurrent requests await one in-flight
// build (single-flight), and errors are NEVER cached — the next poll retries.
// checkedAt stays the time the snapshot was BUILT, not served.

const SNAPSHOT_TTL_MS = 2_000;
let snapshotClock = () => Date.now();
let snapshotTtlMs = SNAPSHOT_TTL_MS;
let snapshotCache = null; // { at, payload } — payload already redacted
let snapshotBuild = null; // the in-flight build promise, if any

/** Test seam: reset the cache and (optionally) inject a clock / TTL. */
export function resetCockpitSnapshotCache({ now, ttlMs } = {}) {
  if (typeof now === "function") snapshotClock = now;
  if (Number.isInteger(ttlMs)) snapshotTtlMs = ttlMs;
  snapshotCache = null;
  snapshotBuild = null;
}

/**
 * Drop the cached snapshot after an answer changed the world (FOC-810): the
 * next poll rebuilds immediately instead of serving the just-stale dialog /
 * pending ask for up to 2 s. An in-flight build is left alone — it started
 * before the answer and the poll after it rebuilds again.
 */
function invalidateCockpitSnapshot() {
  snapshotCache = null;
}

/**
 * The audit payload of an ask answer: toolUseId plus, per question, the
 * CHOSEN LABELS for index choices and the free text — each string capped at
 * ASK_ANSWER_CAP characters. Answers align by index with the pending ask's
 * questions; an out-of-range choice degrades to its index text.
 */
function askAnswerPayload(pending, answers) {
  return {
    toolUseId: pending.toolUseId,
    answers: (pending.questions ?? []).map((q, i) => {
      const a = answers?.[i] ?? {};
      const choices = (Array.isArray(a.choices) ? a.choices : [])
        .map((c) => String(q.options?.[c]?.label ?? c).slice(0, ASK_ANSWER_CAP));
      const text = typeof a.text === "string" ? a.text.slice(0, ASK_ANSWER_CAP) : null;
      return { question: q.question ?? null, choices, ...(text !== null ? { text } : {}) };
    }),
  };
}

/** One-line summary of an ask answer for the audit row's `changes` value. */
function askAnswerSummary(pending, answers) {
  return askAnswerPayload(pending, answers)
    .answers.map((a, i) => {
      const chosen = [...a.choices, a.text ?? ""].filter(Boolean).join(", ");
      return `${a.question || `question ${i + 1}`}: ${chosen || "(no answer)"}`;
    })
    .join(" | ");
}

/** The full snapshot body — everything the GET /api/cockpit route used to do inline. */
async function buildCockpitSnapshot() {
  const runIds = recentRunIds();
  let probe;
  let sessionInfo = null;
  let hostState = "not-docker";
  let dialog = null;
  let supTranscript = null;
  const base = hostBase();
  if (!base) {
    probe = (pids) => Object.fromEntries(pids.map((p) => [String(p), processAlive(p)]));
    const session = readSupervisorSession();
    if (session) {
      sessionInfo = {
        sessionId: typeof session.sessionId === "string" ? session.sessionId : null,
        state: typeof session.state === "string" ? session.state : null,
        notification: session.notification ?? null,
      };
    }
  } else {
    hostState = "unreachable";
    const state = await hostRequest("GET", "/state", null, { timeoutMs: FAST_TIMEOUT_MS });
    if (state.status === 200 && state.body && typeof state.body === "object") {
      hostState = "reachable";
      // The host's GET /state returns the EFFECTIVE state at the top level —
      // "absent" when the session/pane is gone, else the session hook's
      // state — with the session.json record the FOC-783 hook wrote under
      // `hook`. The hook alone is never trusted (a killed pane leaves a
      // stale file), so each field comes from its own place: state from the
      // top level, sessionId/notification from the hook.
      const body = state.body;
      sessionInfo = {
        sessionId: typeof body.hook?.sessionId === "string" ? body.hook.sessionId : null,
        state: typeof body.state === "string" ? body.state : null,
        notification: body.hook?.notification ?? null,
      };
      if (body.clients !== undefined) sessionInfo.clients = body.clients;
      // The Supervisor session's own transcript (FOC-810): the pending ask is
      // read from it — same confinement rule as the conversation route.
      supTranscript = confinedTranscriptPath(body.hook);
      // The pane's dialog, only while the session actually waits for input.
      // Any failure — unreachable, non-200, malformed body — reads as null.
      if (sessionInfo.state === "needs-input") {
        const dlg = await hostRequest("GET", "/dialog", null, { timeoutMs: DIALOG_TIMEOUT_MS });
        if (dlg.status === 200 && dlg.body && typeof dlg.body === "object"
          && dlg.body.dialog && typeof dlg.body.dialog === "object") {
          dialog = dlg.body.dialog;
        }
      }
    }
    probe = async (pids) => {
      const alive = await hostRequest("POST", "/alive", { pids }, { timeoutMs: FAST_TIMEOUT_MS });
      return alive.status === 200 && alive.body && typeof alive.body === "object" && !Array.isArray(alive.body)
        ? alive.body
        : null;
    };
  }

  // FOC-807: the current-run record (<dataHome>/supervisor/current-run.json)
  // pins the run the live session belongs to; without it the focus-ticket
  // heuristic stands in, exactly as before.
  // FOC-769: the DECLARED focus wins when the record carries one for the
  // Supervisor run — the triage heuristic stays the fallback, marked
  // `declared: false` so the UI can say which kind of fact it is showing.
  const heuristicFocus = focusTicket({ runIds });
  const current = readCurrentRun();
  const supRunId = supRunIdOf(current, heuristicFocus);
  const focus =
    declaredFocusOf(current, supRunId) ??
    (heuristicFocus ? { ...heuristicFocus, declared: false } : null);
  // FOC-810: the unanswered AskUserQuestion from the transcript — only while
  // the pane actually shows an ask dialog for it.
  const pendingAsk = dialog && (dialog.kind === "ask" || dialog.kind === "ask-review") && supTranscript
    ? readPendingAsk(supTranscript)
    : null;
  const needsYou = [...supervisorSessionItems({ dialog, pendingAsk, supRunId, focus }), ...collectNeedsYou({ runIds })];
  const children = await collectChildren({ runIds, probe });
  const backlog = wakeBacklog(runIds, supRunId);
  const supervisor = {
    host: hostState,
    state: sessionInfo?.state ?? null,
    sessionId: sessionInfo?.sessionId ?? null,
    notification: sessionInfo?.notification ?? null,
    // Attached tmux clients — only when the host reported them (native mode
    // has no host to ask).
    ...(sessionInfo?.clients !== undefined ? { clients: sessionInfo.clients } : {}),
    model: current?.model || process.env.SUPERVISOR_MODEL || null,
    focus,
    runId: supRunId,
    runSource: current ? current.source : (focus ? "focus" : null),
    waker: supRunId ? wakerOf(supRunId) : null,
    wakeBacklog: backlog.count,
    wakeOldestAt: backlog.oldestAt,
    dialog,
    pendingAsk,
  };
  return redactDeep({
    supervisor,
    needsYou,
    children,
    counts: cockpitCounts({ needsYou, children }),
    checkedAt: new Date(snapshotClock()).toISOString(),
  });
}

/**
 * The Needs-you items the LIVE Supervisor session contributes (FOC-810),
 * prepended ahead of the run-store items: the pending ask (category "ask")
 * outranks everything, else a permission or select dialog (category "dialog")
 * the pane is showing. Both are answerable from the dashboard, so the counts
 * include them as-is. An ask-review dialog is covered by the pending ask —
 * never by a dialog item.
 */
function supervisorSessionItems({ dialog, pendingAsk, supRunId, focus }) {
  const shared = {
    runId: supRunId ?? null,
    taskId: focus?.taskId ?? null,
    childId: null,
    createdAt: null,
    ageMs: null,
    state: "pending",
    answerable: true,
  };
  if (pendingAsk) {
    return [{
      ...shared,
      id: `ask:${pendingAsk.toolUseId}`,
      category: "ask",
      kind: "ask",
      answerKind: "ask",
      summary: pendingAsk.questions[0]?.question ?? "",
      toolUseId: pendingAsk.toolUseId,
      questions: pendingAsk.questions,
    }];
  }
  if (dialog && (dialog.kind === "permission" || dialog.kind === "select")) {
    return [{
      ...shared,
      id: `dialog:${dialog.id}`,
      category: "dialog",
      kind: dialog.kind,
      answerKind: "dialog",
      summary: dialog.title ?? "",
      dialog,
    }];
  }
  return [];
}

/**
 * Serve the snapshot through the TTL cache; `build` is injected so tests can
 * count builds and force errors. A fresh cache returns immediately; otherwise
 * one build runs and every concurrent caller awaits the same promise. A build
 * that throws is not cached — the error propagates and the next request
 * starts over.
 */
export async function cachedCockpitSnapshot(build) {
  if (snapshotCache && snapshotClock() - snapshotCache.at < snapshotTtlMs) return snapshotCache.payload;
  if (!snapshotBuild) {
    snapshotBuild = (async () => {
      const payload = await build();
      snapshotCache = { at: snapshotClock(), payload };
      return payload;
    })().finally(() => {
      snapshotBuild = null;
    });
  }
  return snapshotBuild;
}

// ── routes ───────────────────────────────────────────────────────────────────

/**
 * Handle a Cockpit HTTP route. Returns true when the request was handled (the
 * caller returns immediately), false when it is not one of ours.
 */
export async function handleCockpitRoute(req, res, url, ctx) {
  const method = req.method;
  const path = url.pathname;
  const { readJsonBody, respondBodyError, json, log } = ctx;

  // GET /api/cockpit — the whole snapshot in one poll: the Needs-you inbox,
  // the children board, the counts strip and the Supervisor panel. In Docker
  // the process probe is the host's POST /alive (the API container cannot see
  // the supervisor container's pids); natively it is processAlive on this
  // machine. A host that cannot be reached makes the probe return null —
  // live children then show "unknown", never silently "running".
  // Served through the TTL cache (see cachedCockpitSnapshot): a build costs
  // 70–145 ms of synchronous fs and every page in the UI polls this route.
  if (method === "GET" && path === "/api/cockpit") {
    const payload = await cachedCockpitSnapshot(buildCockpitSnapshot);
    json(res, 200, payload);
    log(method, path, 200);
    return true;
  }

  // GET /api/supervisor/conversation?after=&limit= — the chat transcript,
  // incrementally by byte offset. The transcript comes from session.json and is
  // used only when it is confined (see confinedTranscriptPath); everything else
  // answers the empty shape, so a missing session is never an error.
  if (method === "GET" && path === "/api/supervisor/conversation") {
    let after = null;
    const afterRaw = url.searchParams.get("after");
    if (afterRaw !== null) {
      const n = Number(afterRaw);
      if (!Number.isInteger(n) || n < 0) {
        json(res, 400, { error: "after must be an integer >= 0" });
        log(method, path, 400);
        return true;
      }
      after = n;
    }
    let limit = 200;
    const limitRaw = url.searchParams.get("limit");
    if (limitRaw !== null) {
      const n = Number(limitRaw);
      if (!Number.isInteger(n) || n < 1 || n > 500) {
        json(res, 400, { error: "limit must be an integer in 1..500" });
        log(method, path, 400);
        return true;
      }
      limit = n;
    }

    const session = readSupervisorSession();
    const sessionId = typeof session?.sessionId === "string" ? session.sessionId : null;
    const state = typeof session?.state === "string" ? session.state : null;
    const transcriptPath = confinedTranscriptPath(session);
    let result = { offset: 0, entries: [], reset: false, truncated: false };
    if (transcriptPath) result = readConversation({ transcriptPath, after, limit });
    json(res, 200, {
      sessionId,
      state,
      offset: result.offset,
      entries: redactDeep(result.entries),
      reset: result.reset,
      truncated: result.truncated,
    });
    log(method, path, 200);
    return true;
  }

  // POST /api/supervisor/message { text } — a chat message, forwarded to the
  // host verbatim (the host refuses needs-input / slash commands / over-long
  // text; its statuses pass through unchanged).
  if (method === "POST" && path === "/api/supervisor/message") {
    if (!writeGuards(req, res, path, ctx)) return true;
    let body;
    try {
      body = await readJsonBody(req, BODY_CAP);
    } catch (err) {
      log(method, path, respondBodyError(res, err));
      return true;
    }
    if (typeof body.text !== "string" || !body.text.trim()) {
      json(res, 400, { error: "text (string) is required" });
      log(method, path, 400);
      return true;
    }
    await forwardToHost(res, ctx, path, "/message", { text: body.text }, SLOW_TIMEOUT_MS);
    return true;
  }

  // POST /api/supervisor/session { fresh, confirm } — ensure (or, with fresh,
  // restart) the Supervisor session on the host. A fresh restart kills the
  // running Supervisor, so it needs the typed confirmation, not just a flag.
  if (method === "POST" && path === "/api/supervisor/session") {
    if (!writeGuards(req, res, path, ctx)) return true;
    let body;
    try {
      body = await readJsonBody(req, BODY_CAP);
    } catch (err) {
      log(method, path, respondBodyError(res, err));
      return true;
    }
    const fresh = Boolean(body.fresh);
    if (fresh && body.confirm !== "new-session") {
      json(res, 400, { error: 'fresh requires confirm: "new-session"' });
      log(method, path, 400);
      return true;
    }
    await forwardToHost(res, ctx, path, "/session", { fresh }, SLOW_TIMEOUT_MS);
    return true;
  }

  // POST /api/supervisor/wake — the Wake button: the usual drain prompt,
  // prefixed so the Supervisor knows it came from Mateusz through the
  // dashboard. Never sent on a timer — only on a human click.
  if (method === "POST" && path === "/api/supervisor/wake") {
    if (!writeGuards(req, res, path, ctx)) return true;
    await forwardToHost(res, ctx, path, "/message", { text: wakePromptText() }, SLOW_TIMEOUT_MS);
    return true;
  }

  // POST /api/supervisor/ask { toolUseId, answers } — answer the Supervisor's
  // pending AskUserQuestion from the dashboard (FOC-810). Optimistic like the
  // gate answer: the pending ask is re-read from the transcript (the path
  // comes from the host's /state hook block, confined like the conversation
  // route's) and a toolUseId mismatch means the Supervisor moved on — 409
  // ask-changed, nothing forwarded. The host runs askKeyPlan and validates the
  // answers; its status/body pass through unchanged. On a real answer the
  // audit row is recorded in the current run's edits and the snapshot cache is
  // dropped so the next poll no longer offers the answered ask.
  if (method === "POST" && path === "/api/supervisor/ask") {
    if (!writeGuards(req, res, path, ctx)) return true;
    let body;
    try {
      body = await readJsonBody(req, BODY_CAP);
    } catch (err) {
      log(method, path, respondBodyError(res, err));
      return true;
    }
    if (typeof body.toolUseId !== "string" || !body.toolUseId.trim() || !Array.isArray(body.answers)) {
      json(res, 400, { error: "toolUseId (string) and answers (array) are required" });
      log(method, path, 400);
      return true;
    }
    if (!hostBase()) {
      json(res, 503, { error: "docker-only" });
      log(method, path, 503);
      return true;
    }
    const state = await hostRequest("GET", "/state", null, { timeoutMs: FAST_TIMEOUT_MS });
    if (state.status !== 200 || !state.body || typeof state.body !== "object") {
      json(res, 503, {
        error: "host-unreachable",
        reason: state.status === 0 ? state.error : `host /state answered ${state.status}`,
      });
      log(method, path, 503);
      return true;
    }
    const transcriptPath = confinedTranscriptPath(state.body.hook);
    const pending = transcriptPath ? readPendingAsk(transcriptPath) : null;
    if (!pending || pending.toolUseId !== body.toolUseId) {
      json(res, 409, { error: "ask-changed" });
      log(method, path, 409);
      return true;
    }
    const result = await forwardToHost(res, ctx, path, "/dialog/ask", {
      // The host re-plans the keys from the tool_use shape — labels only, no
      // descriptions, exactly what the transcript carried.
      questions: pending.questions.map((q) => ({
        question: q.question,
        multiSelect: q.multiSelect,
        options: (q.options ?? []).map((o) => ({ label: o.label })),
      })),
      answers: body.answers,
    }, SLOW_TIMEOUT_MS);
    if (result && result.status === 200 && result.body?.answered === true) {
      invalidateCockpitSnapshot();
      const runId = readCurrentRun()?.runId;
      const summary = askAnswerSummary(pending, body.answers);
      if (runId && summary.trim()) {
        try {
          recordAnswerRow({
            runId,
            kind: "ask-answer",
            id: pending.toolUseId,
            text: summary,
            who: "dashboard",
            notified: true, // the answer went into the pane — already delivered
            payload: askAnswerPayload(pending, body.answers),
          });
        } catch (err) {
          // The answer IS delivered; the audit row is the only thing that failed.
          console.error("[supervisor/ask] edit row failed:", err);
        }
      }
    }
    return true;
  }

  // POST /api/supervisor/dialog { id, choice, note? } — answer a permission
  // or select dialog the pane is showing (FOC-810). The host owns the rules
  // (id must still match the pane's dialog, allow-once/allow-always/deny for
  // a permission, Esc-only for a select); the status/body pass through.
  if (method === "POST" && path === "/api/supervisor/dialog") {
    if (!writeGuards(req, res, path, ctx)) return true;
    let body;
    try {
      body = await readJsonBody(req, BODY_CAP);
    } catch (err) {
      log(method, path, respondBodyError(res, err));
      return true;
    }
    if (typeof body.id !== "string" || !body.id.trim() || typeof body.choice !== "string" || !body.choice.trim()) {
      json(res, 400, { error: "id and choice (string) are required" });
      log(method, path, 400);
      return true;
    }
    const payload = { id: body.id, choice: body.choice };
    if (typeof body.note === "string" && body.note.trim()) payload.note = body.note;
    const result = await forwardToHost(res, ctx, path, "/dialog/answer", payload, SLOW_TIMEOUT_MS);
    if (result && result.status === 200) invalidateCockpitSnapshot();
    return true;
  }

  // POST /api/gates/answer { runId, gateId, text, note? } — record the answer
  // through the gate library (answered once, atomic), tell the Supervisor
  // through its session, and append the audit row. The record happens FIRST:
  // an answer that is recorded but un-notified is safe (the waker and the next
  // prompt hook still carry it), the reverse would let the Supervisor act on
  // an answer that was never written down.
  if (method === "POST" && path === "/api/gates/answer") {
    if (!writeGuards(req, res, path, ctx)) return true;
    let body;
    try {
      body = await readJsonBody(req, BODY_CAP);
    } catch (err) {
      log(method, path, respondBodyError(res, err));
      return true;
    }
    const { runId, gateId, text, note } = body;
    if (!runId || !gateId || typeof text !== "string" || !text.trim()) {
      json(res, 400, { error: "runId, gateId and text (string) are required" });
      log(method, path, 400);
      return true;
    }
    let gate;
    try {
      gate = answerGate({
        runId,
        gateId,
        text,
        note: typeof note === "string" && note.trim() ? note : null,
        answeredBy: "dashboard",
        // Never block the API server on the answer lock: a held lock throws
        // "busy" immediately and the UI retries, instead of every poll of the
        // server freezing for up to 2 s behind Atomics.wait.
        lockWaitMs: 0,
      });
    } catch (err) {
      const status = answerErrorStatus(err?.code);
      if (status === 500) console.error("[gates/answer]", err?.message || err);
      json(res, status, answerErrorBody(err));
      log(method, path, status);
      return true;
    }
    // FOC-449 provenance, the CLI's exact labeling (supervisor-gate.mjs
    // cmdAnswer): the recorded answer IS the outcome for every decision event
    // the gate carried — outcome = the answer value, by:"human", via:"gate".
    // Runs against the same runs dir the server's decision panel reads
    // (LA_DECISION_RUNS_DIR, else the repo's .state/runs). Best-effort: a
    // failed label is a warning on the server log, never a failed request —
    // the gate record is the primary flow.
    try {
      const { warnings: labelWarnings } = autoLabel(gate.decisionEvents, {
        outcome: text,
        by: "human",
        via: "gate",
        runsDir: resolveRunsDir(),
      });
      for (const w of labelWarnings) console.error("[gates/answer]", w);
    } catch (err) {
      console.error("[gates/answer] decision label failed:", err?.message ?? err);
    }
    const notified = await notifyGateAnswered(gate, gateId);
    let rowError = null;
    try {
      recordAnswerRow({ runId, kind: "gate-answer", id: gateId, text, who: "dashboard", notified });
    } catch (err) {
      // The answer IS recorded; the audit row is the only thing that failed.
      // The response still says recorded:true — a 500 would make the UI hide
      // an answer that exists on disk.
      rowError = err?.message ?? String(err);
      console.error("[gates/answer] edit row failed:", rowError);
    }
    json(res, 200, { recorded: true, notified, gate, ...(rowError ? { rowError } : {}) });
    log(method, path, 200);
    return true;
  }

  // POST /api/holds/answer { runId, holdId, text } — same pattern through the
  // hold library. A hold has no separate delivery step: the answer is in force
  // the moment it is recorded, so the notice asks the Supervisor to ACT.
  if (method === "POST" && path === "/api/holds/answer") {
    if (!writeGuards(req, res, path, ctx)) return true;
    let body;
    try {
      body = await readJsonBody(req, BODY_CAP);
    } catch (err) {
      log(method, path, respondBodyError(res, err));
      return true;
    }
    const { runId, holdId, text } = body;
    if (!runId || !holdId || typeof text !== "string" || !text.trim()) {
      json(res, 400, { error: "runId, holdId and text (string) are required" });
      log(method, path, 400);
      return true;
    }
    let hold;
    try {
      hold = answerHold({ runId, holdId, text, answeredBy: "dashboard", lockWaitMs: 0 });
    } catch (err) {
      const status = answerErrorStatus(err?.code);
      if (status === 500) console.error("[holds/answer]", err?.message || err);
      json(res, status, answerErrorBody(err));
      log(method, path, status);
      return true;
    }
    const taskId = hold?.taskId ?? null;
    let notified = false;
    if (hostBase()) {
      const r = await hostRequest(
        "POST",
        "/message",
        { text: `[dashboard] Mateusz answered hold ${holdId} (${taskId ?? "no task"}) in the Cockpit; the answer is recorded — act on it now.` },
        { timeoutMs: SLOW_TIMEOUT_MS },
      );
      notified = r.status === 200 && r.body?.sent === true;
    }
    let rowError = null;
    try {
      recordAnswerRow({ runId, kind: "hold-answer", id: holdId, text, who: "dashboard", notified });
    } catch (err) {
      rowError = err?.message ?? String(err);
      console.error("[holds/answer] edit row failed:", rowError);
    }
    json(res, 200, { recorded: true, notified, hold, ...(rowError ? { rowError } : {}) });
    log(method, path, 200);
    return true;
  }

  // POST /api/gates/notify { runId, gateId | holdId } — the "Tell the
  // Supervisor" button: re-send the notice for an answer that was recorded but
  // never delivered (the host was down at answer time). The UI sends gateId
  // for a gate, holdId for a hold ("Tell the Supervisor" after a hold answer
  // whose notice failed) — exactly one of the two, else 400. Only an ANSWERED
  // record can be notified — a pending gate or an open hold has no answer to
  // deliver.
  if (method === "POST" && path === "/api/gates/notify") {
    if (!writeGuards(req, res, path, ctx)) return true;
    let body;
    try {
      body = await readJsonBody(req, BODY_CAP);
    } catch (err) {
      log(method, path, respondBodyError(res, err));
      return true;
    }
    const { runId, gateId, holdId } = body;
    if (!runId || (!gateId && !holdId) || (gateId && holdId)) {
      json(res, 400, { error: "runId and exactly one of gateId, holdId are required" });
      log(method, path, 400);
      return true;
    }
    if (gateId) {
      const gate = readGateQuietly(runId, gateId);
      if (!gate) {
        json(res, 404, { error: "not-found", reason: `gate ${gateId} does not exist in run ${runId}` });
        log(method, path, 404);
        return true;
      }
      if (gate.status !== "answered") {
        json(res, 409, { error: "still-pending", reason: `gate ${gateId} is ${gate.status} — there is no answer to deliver yet` });
        log(method, path, 409);
        return true;
      }
      const notified = await notifyGateAnswered(gate, gateId);
      json(res, 200, { notified });
      log(method, path, 200);
      return true;
    }
    const hold = readHoldQuietly(runId, holdId);
    if (!hold) {
      json(res, 404, { error: "not-found", reason: `hold ${holdId} does not exist in run ${runId}` });
      log(method, path, 404);
      return true;
    }
    if (hold.state !== "answered") {
      json(res, 409, { error: "still-open", reason: `hold ${holdId} is ${hold.state} — there is no answer to deliver yet` });
      log(method, path, 409);
      return true;
    }
    // Same wording as /api/holds/answer's notice — this re-sends exactly that.
    const taskId = hold?.taskId ?? null;
    let notified = false;
    if (hostBase()) {
      const r = await hostRequest(
        "POST",
        "/message",
        { text: `[dashboard] Mateusz answered hold ${holdId} (${taskId ?? "no task"}) in the Cockpit; the answer is recorded — act on it now.` },
        { timeoutMs: SLOW_TIMEOUT_MS },
      );
      notified = r.status === 200 && r.body?.sent === true;
    }
    json(res, 200, { notified });
    log(method, path, 200);
    return true;
  }

  return false;
}

/** Re-send the "answer recorded — deliver it now" notice for an answered gate. */
async function notifyGateAnswered(gate, gateId) {
  const childId = gate?.childId ?? null;
  const taskId = gate?.taskId ?? null;
  let notified = false;
  if (hostBase()) {
    const r = await hostRequest(
      "POST",
      "/message",
      {
        text:
          `[dashboard] Mateusz answered ${gateId} for ${childId ?? "?"} (${taskId ?? "no task"}) in the Cockpit; ` +
          "the answer is recorded in the gate — deliver it now.",
      },
      { timeoutMs: SLOW_TIMEOUT_MS },
    );
    notified = r.status === 200 && r.body?.sent === true;
  }
  return notified;
}

/** One gate record, or null when it does not exist / cannot be read. Never throws. */
function readGateQuietly(runId, gateId) {
  try {
    return JSON.parse(readFileSync(gatePath(runId, gateId), "utf8"));
  } catch {
    return null;
  }
}

/** One hold record, or null when it does not exist / the store cannot be read. Never throws. */
function readHoldQuietly(runId, holdId) {
  try {
    return readHolds(runId).holds.find((h) => h.id === holdId) ?? null;
  } catch {
    return null;
  }
}

// ── the terminal WebSocket proxy ─────────────────────────────────────────────

// The host's tmux default size (plan §1); the query params are optional.
const DEFAULT_COLS = 200;
const DEFAULT_ROWS = 50;
const clampInt = (raw, min, max, fallback) => {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

/**
 * Handle the /api/supervisor/terminal upgrade: validate harder than the POST
 * routes, then proxy raw TCP to the session host's own /terminal endpoint.
 *
 * Stricter on purpose (plan §3): isAllowedOrigin accepts ANY localhost port —
 * right for the API's POSTs, wrong for a terminal with full keystroke access.
 * Here the Origin's host AND port must equal the Host header exactly, so a
 * page from another local dev server cannot open it. Host must be a loopback
 * name (DNS-rebinding guard). No Origin/cookies are forwarded.
 *
 * Rejections write a raw HTTP status line and destroy the socket — there is
 * no req/res pair at this stage of the connection.
 */
export function handleTerminalUpgrade(req, socket, head, ctx) {
  // FIRST statement: a client that resets the connection before/while we act
  // (a hung-up browser, a scanner, a proxy) would otherwise emit an unhandled
  // 'error' on this raw socket and kill the whole API process (the Windows
  // suite crash: read ECONNRESET on Socket). The proxy's destroyBoth handlers
  // below stay — this one just guarantees a listener exists from birth.
  socket.on("error", () => socket.destroy());
  const reject = (status) => {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`, () => socket.destroy());
  };
  const pathname = (() => {
    try {
      return new URL(req.url, "http://localhost").pathname;
    } catch {
      return null;
    }
  })();
  if (pathname !== "/api/supervisor/terminal") {
    socket.destroy();
    return;
  }
  if (!ctx.isLocalOrigin(req.socket.remoteAddress)) return reject("403 Forbidden");

  // Host header: loopback hostname only, any port.
  const hostHeader = String(req.headers.host ?? "").toLowerCase();
  const hostname = hostHeader.replace(/:\d+$/, "");
  if (!["localhost", "127.0.0.1", "[::1]"].includes(hostname)) return reject("403 Forbidden");

  // Origin: present, http(s), and its host:port equals the Host header exactly.
  const origin = req.headers.origin;
  if (!origin) return reject("403 Forbidden");
  let originUrl;
  try {
    originUrl = new URL(origin);
  } catch {
    return reject("403 Forbidden");
  }
  if (originUrl.protocol !== "http:" && originUrl.protocol !== "https:") return reject("403 Forbidden");
  if (originUrl.host.toLowerCase() !== hostHeader) return reject("403 Forbidden");

  const base = hostBase();
  if (!base) return reject("503 Service Unavailable");

  // The token is read NOW, at proxy time: a supervisor restart rotates it, and
  // a queued upgrade must not carry a stale one.
  let token;
  try {
    token = readFileSync(hostTokenPath(), "utf8").trim();
  } catch {
    return reject("503 Service Unavailable");
  }

  let baseUrl;
  try {
    baseUrl = new URL(base);
  } catch {
    return reject("503 Service Unavailable");
  }
  const cols = clampInt(new URL(req.url, "http://localhost").searchParams.get("cols"), 20, 500, DEFAULT_COLS);
  const rows = clampInt(new URL(req.url, "http://localhost").searchParams.get("rows"), 5, 200, DEFAULT_ROWS);

  const upstream = net.connect({ host: baseUrl.hostname, port: Number(baseUrl.port) || 80 });
  const destroyBoth = () => {
    upstream.destroy();
    socket.destroy();
  };
  upstream.on("error", destroyBoth);
  socket.on("error", destroyBoth);
  upstream.on("close", () => socket.destroy());
  socket.on("close", () => upstream.destroy());

  // Only the handshake headers the upstream needs — never Origin, never cookies.
  const lines = [
    `GET /terminal?cols=${cols}&rows=${rows} HTTP/1.1`,
    `Host: ${baseUrl.host}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    req.headers["sec-websocket-key"] ? `Sec-WebSocket-Key: ${req.headers["sec-websocket-key"]}` : null,
    req.headers["sec-websocket-version"] ? `Sec-WebSocket-Version: ${req.headers["sec-websocket-version"]}` : null,
    req.headers["sec-websocket-extensions"] ? `Sec-WebSocket-Extensions: ${req.headers["sec-websocket-extensions"]}` : null,
    req.headers["sec-websocket-protocol"] ? `Sec-WebSocket-Protocol: ${req.headers["sec-websocket-protocol"]}` : null,
    `x-fenix-host-token: ${token}`,
  ].filter(Boolean);
  upstream.write(lines.join("\r\n") + "\r\n\r\n");
  if (head && head.length) upstream.write(head);
  upstream.pipe(socket);
  socket.pipe(upstream);
}
