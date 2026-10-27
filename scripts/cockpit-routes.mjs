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
// Task-scoped session routes (PRD task-workspace-supervisors, plan P1c) live
// beside the global ones: GET /api/supervisor/sessions (the list),
// GET /api/cockpit?sessionId=<sid>, and /api/supervisor/sessions/:sid/*
// mirrors of message/session/ask/dialog/wake/stop. Every :sid route validates
// the id against SUPERVISOR_SESSION_ID_PATTERN BEFORE any read or forward —
// an unknown or malformed sid is a 404 that never touched the host or the
// filesystem — and the on-disk state it reads is resolved through a
// session-scoped env VIEW (sessionScopedEnv), never a global process.env
// mutation.
//
// The terminal WebSocket is not proxied through the request handler — it is an
// `upgrade` event. handleTerminalUpgrade validates the handshake with STRICTER
// rules than the POST routes (Origin must equal the Host header exactly, so a
// page served from another local port cannot open the terminal) and then pipes
// raw TCP to the session host; it never forwards Origin or cookies.

import { readFileSync } from "node:fs";
import { resolve as resolvePath, sep } from "node:path";
import net from "node:net";

import { hostBase, hostRequest, hostSessionPath, sessionScopedEnv, redactSessionRecord, FAST_TIMEOUT_MS, SLOW_TIMEOUT_MS } from "./supervisor-host-client.mjs";
import { collectNeedsYou, collectChildren, cockpitCounts, focusTicket, recentRunIds } from "./cockpit.mjs";
import { readConversation } from "./supervisor-conversation.mjs";
import { gatePath, processAlive, readHolds, readWakeAck, readWakeQueue, readWakerLease, redactDeep, runDir, stallSilenceMs, wakerState } from "./supervisor-lib.mjs";
import { isLegacyReadOnly } from "./supervisor-migrate-legacy.mjs";
import { freshRows, formatWakeMessage } from "./supervisor-wake.mjs";
import { answerGate, answerHold } from "./supervisor-gate.mjs";
import { autoLabel } from "./decision-log.mjs";
import { resolveRunsDir } from "./decision-analytics.mjs";
import { recordAnswerRow } from "./agent-records.mjs";
import { readCurrentRun } from "./supervisor-current-run.mjs";
import { readPendingAsk } from "./session-dialog.mjs";
import {
  hostTokenPath,
  supervisorSessionPath,
  supervisorSessionClaudeDir,
  supervisorCurrentRunPath,
  squadConfigDir,
  SUPERVISOR_SESSION_ID_PATTERN,
} from "./fenix-paths.mjs";
import { supervisorStateHome } from "./supervisor-lib.mjs";

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
 * The audit actor for the answer routes (FOC-958 B2): "dashboard" by default,
 * or the caller's `remote:<client>` when the request carries a well-formed
 * x-fenix-actor header. Only the remote: shape is honoured — a spoofed or
 * foreign value ("ai", "dashboard", anything else) falls back to the dashboard
 * default, so the header can never forge another actor kind. The libraries
 * already accept a dynamic value (answerGate/answerHold answeredBy,
 * recordAnswerRow who); the dialog routes write no local audit row, so there
 * is nothing to thread there.
 */
const REMOTE_ACTOR_RE = /^remote:[A-Za-z0-9._-]{1,64}$/;
function actorOf(req) {
  const raw = req.headers["x-fenix-actor"];
  return typeof raw === "string" && REMOTE_ACTOR_RE.test(raw) ? raw : "dashboard";
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

// ── task-scoped sessions (PRD task-workspace-supervisors, plan P1c) ──────────
//
// A managed session lives on the host under /sessions/<sid>; its ON-DISK state
// (session.json, current-run.json, the isolated claude config dir) lives under
// <dataHome>/supervisor/sessions/<sid> — fenix-paths resolves that from an env
// carrying FENIX_SUPERVISOR_SESSION_ID. Everything session-scoped below goes
// through the two helpers in supervisor-host-client.mjs:
//
//   · hostSessionPath(sid, suffix) — the host URL, sid validated first;
//   · sessionScopedEnv(env, sid)  — a COPY of the caller's env with the id set
//     (never a global process.env mutation — the async-scope rule).
//
// The sid regex is checked BEFORE any read or forward: an unknown or malformed
// sid is a 404 that never touched the host or the filesystem.

/** The sid shape guard every /sessions/:sid route applies first. Null when malformed. */
const validSessionId = (raw) =>
  typeof raw === "string" && SUPERVISOR_SESSION_ID_PATTERN.test(raw) ? raw : null;

/**
 * The sessionId guard the gate/hold answer + notify routes apply at the TOP,
 * BEFORE any write: absent/null/"" → null — the legacy single-session
 * dashboard sends no sessionId, and its session id is a Claude UUID that must
 * never reach hostSessionPath (which throws on anything not matching the
 * sup- pattern); a string matching SUPERVISOR_SESSION_ID_PATTERN → that id
 * (task-scoped mode); anything else → false (the caller answers 400
 * bad-session-id, nothing was written).
 */
function answerSessionId(raw) {
  if (raw === undefined || raw === null || raw === "") return null; // legacy
  return validSessionId(raw) ?? false; // false = malformed
}

/** GET the host's session record — { status, body } or { status: 0, error }. */
const fetchHostSession = (sid) => hostRequest("GET", hostSessionPath(sid), null, { timeoutMs: FAST_TIMEOUT_MS });

/**
 * The host's /state for one session, resolved against the SESSION-scoped
 * current-run pointer: the same shape the global build uses (state from the
 * top level, sessionId/notification from the hook), plus the record under
 * `taskSession`. `hostState` distinguishes the three answers the snapshot
 * needs. Returns null only when the host is configured but answers nothing
 * usable — the caller decides what that reads as per route.
 */
async function fetchScopedHostState(sid) {
  if (!hostBase()) return { hostState: "not-docker", state: null, taskSession: null };
  // FOC-1089: the EFFECTIVE state (pane dialog, needs-input clock, parked
  // policy) lives in GET /sessions/:sid/state — the bare /sessions/:sid
  // answers only { session: record }, which has no `state`, so reading it
  // here left every task-session permission prompt invisible in the task
  // cockpit. The record route stays the fallback for an older host.
  let result = await hostRequest("GET", hostSessionPath(sid, "/state"), null, { timeoutMs: FAST_TIMEOUT_MS });
  if (result.status !== 0 && result.status !== 200) result = await fetchHostSession(sid);
  if (result.status === 0) return { hostState: "unreachable", state: null, taskSession: null, error: result.error };
  if (result.status !== 200 || !result.body || typeof result.body !== "object") {
    return { hostState: "error", state: null, taskSession: null, status: result.status };
  }
  const body = result.body;
  // The state body carries the record under `taskSession`; the record route
  // under `session` (an object). The state body's `session` is a string
  // ("running"), never a record.
  const record = body.taskSession ?? (body.session && typeof body.session === "object" ? body.session : null);
  return {
    hostState: "reachable",
    state: typeof body.state === "string" ? body.state : null,
    taskSession: redactSessionRecord(record),
    hook: body.hook && typeof body.hook === "object" ? body.hook : null,
    clients: body.clients,
    needsInputSince: typeof body.needsInputSince === "string" ? body.needsInputSince : null,
    autoDenial: body.autoDenial && typeof body.autoDenial === "object" ? body.autoDenial : null,
    parkedPolicy: body.parkedPolicy && typeof body.parkedPolicy === "object" ? body.parkedPolicy : null,
  };
}

/**
 * The scoped snapshot — the same shape the global build returns, with ONLY the
 * target session's data: the run ids come from the session-scoped current-run
 * pointer (readCurrentRun with the scoped env; a missing scoped pointer is no
 * run — adoption is off for scoped panes, so a session never shows another
 * task's children), the Needs-you items and children sweep the same run ids
 * through the same collect* libraries, the focus/waker/backlog/pendingAsk
 * derivation is the global one restricted to the single run, and the
 * supervisor block carries the session record (taskSession) so the UI can
 * show task + status.
 *
 * When `taskKey` is given, the snapshot answers only when the session's record
 * agrees — a mismatch is the caller's 404 (spoofed taskKey), never a partial
 * snapshot.
 */
async function buildScopedCockpitSnapshot({ sessionId, taskKey, env = process.env }) {
  const scopedEnv = sessionScopedEnv(env, sessionId);
  const runIds = [];
  const current = readCurrentRun({ path: supervisorCurrentRunPath(scopedEnv) });
  if (current?.runId) runIds.push(current.runId);

  const host = await fetchScopedHostState(sessionId);
  const sessionInfo = {
    sessionId: typeof host.hook?.sessionId === "string" ? host.hook.sessionId : null,
    state: host.state,
    notification: host.hook?.notification ?? null,
  };
  if (host.clients !== undefined) sessionInfo.clients = host.clients;

  // The transcript confinement is scoped too: the host's hook path must sit
  // inside THIS session's claude config dir (supervisorSessionClaudeDir) —
  // never the shared squad config, never another session's home.
  const claudeRoot = resolvePath(supervisorSessionClaudeDir(scopedEnv));
  let supTranscript = null;
  const hookPath = typeof host.hook?.transcriptPath === "string" ? host.hook.transcriptPath : null;
  if (hookPath && hookPath.endsWith(".jsonl")) {
    const abs = resolvePath(hookPath);
    supTranscript = abs === claudeRoot || abs.startsWith(claudeRoot + sep) ? abs : null;
  }

  // The pane dialog, only while the session actually waits for input.
  let dialog = null;
  if (hostBase() && host.hostState === "reachable" && sessionInfo.state === "needs-input") {
    const dlg = await hostRequest("GET", hostSessionPath(sessionId, "/dialog"), null, { timeoutMs: DIALOG_TIMEOUT_MS });
    if (dlg.status === 200 && dlg.body && typeof dlg.body === "object" && dlg.body.dialog && typeof dlg.body.dialog === "object") {
      dialog = dlg.body.dialog;
    }
  }

  // One run or none — but the same derivation shape as the global build so
  // the UI code is shared. focusTicket over the scoped runIds; the DECLARED
  // focus of the scoped current-run record wins when it names that run.
  const heuristicFocus = runIds.length ? focusTicket({ runIds }) : null;
  const supRunId = supRunIdOf(current, heuristicFocus);
  const focus =
    declaredFocusOf(current, supRunId) ??
    (heuristicFocus ? { ...heuristicFocus, declared: false } : null);

  const pendingAsk = dialog && (dialog.kind === "ask" || dialog.kind === "ask-review") && supTranscript
    ? readPendingAsk(supTranscript)
    : null;

  const needsYou = [
    // FOC-1089: the same live-session inputs the global build passes, so an
    // unreadable prompt or a parked session shows as a problem card here too.
    ...supervisorSessionItems({
      dialog, pendingAsk, supRunId, focus,
      sessionState: host.state ?? null,
      needsInputSince: host.needsInputSince ?? null,
      autoDenial: host.autoDenial ?? null,
      parkedPolicy: host.parkedPolicy ?? null,
      now: snapshotClock(),
    }),
    ...(runIds.length ? collectNeedsYou({ stateHome: supervisorStateHome(scopedEnv), runIds }) : []),
  ];
  const probe = hostBase()
    ? async (pids) => {
        const alive = await hostRequest("POST", "/alive", { pids }, { timeoutMs: FAST_TIMEOUT_MS });
        return alive.status === 200 && alive.body && typeof alive.body === "object" && !Array.isArray(alive.body)
          ? alive.body
          : null;
      }
    : (pids) => Object.fromEntries(pids.map((p) => [String(p), processAlive(p)]));
  const children = runIds.length ? await collectChildren({ stateHome: supervisorStateHome(scopedEnv), runIds, probe }) : [];
  const backlog = wakeBacklog(runIds, supRunId);

  const supervisor = {
    host: host.hostState,
    state: sessionInfo.state,
    sessionId: sessionInfo.sessionId,
    notification: sessionInfo.notification,
    ...(sessionInfo.clients !== undefined ? { clients: sessionInfo.clients } : {}),
    model: current?.model || process.env.SUPERVISOR_MODEL || null,
    focus,
    runId: supRunId,
    runSource: current ? current.source : (focus ? "focus" : null),
    waker: supRunId ? wakerOf(supRunId) : null,
    wakeBacklog: backlog.count,
    wakeOldestAt: backlog.oldestAt,
    dialog,
    pendingAsk,
    taskSession: host.taskSession,
    sessionIdScoped: sessionId,
    taskKeyScoped: taskKey ?? current?.taskKey ?? host.taskSession?.taskKey ?? null,
  };
  return {
    supervisor,
    needsYou,
    children,
    counts: cockpitCounts({ needsYou, children }),
    checkedAt: new Date(snapshotClock()).toISOString(),
    taskSession: host.taskSession,
  };
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
// Keyed cache: the global snapshot under "global", each scoped session under
// "sid:<id>". No cross-snapshot sharing — a scoped poll never serves the
// global aggregate (or another session's), and an answer invalidates only its
// own key.
const snapshotCaches = new Map(); // key → { at, payload } — payload already redacted
const snapshotBuilds = new Map(); // key → the in-flight build promise, if any

/** Test seam: reset the cache and (optionally) inject a clock / TTL. */
export function resetCockpitSnapshotCache({ now, ttlMs } = {}) {
  if (typeof now === "function") snapshotClock = now;
  if (Number.isInteger(ttlMs)) snapshotTtlMs = ttlMs;
  snapshotCaches.clear();
  snapshotBuilds.clear();
}

/**
 * Drop the cached snapshot after an answer changed the world (FOC-810): the
 * next poll rebuilds immediately instead of serving the just-stale dialog /
 * pending ask for up to 2 s. `key` scopes the drop (a scoped answer drops its
 * own session's entry only); the global entry drops when no key is given. An
 * in-flight build is left alone — it started before the answer and the poll
 * after it rebuilds again.
 */
function invalidateCockpitSnapshot(key = "global") {
  snapshotCaches.delete(key);
}

/** decodeURIComponent that reports a malformed sequence instead of throwing. */
const decodeURIComponentSafe = (raw) => {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
};

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
        needsInputSince: session.state === "needs-input" && typeof session.updatedAt === "string" ? session.updatedAt : null,
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
        needsInputSince: typeof body.needsInputSince === "string" ? body.needsInputSince : null,
        // FOC-920: the deny-after policy and the last automatic "No" the host
        // answered on a parked prompt — an older host simply omits both, and
        // that reads as null, not as an error.
        autoDenial: body.autoDenial && typeof body.autoDenial === "object" ? body.autoDenial : null,
        parkedPolicy: body.parkedPolicy && typeof body.parkedPolicy === "object" ? body.parkedPolicy : null,
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
  const needsYou = [...supervisorSessionItems({ dialog, pendingAsk, supRunId, focus, sessionState: sessionInfo?.state ?? null, needsInputSince: sessionInfo?.needsInputSince ?? null, autoDenial: sessionInfo?.autoDenial ?? null, parkedPolicy: sessionInfo?.parkedPolicy ?? null, now: snapshotClock() }), ...collectNeedsYou({ runIds })];
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
    needsInputSince: sessionInfo?.needsInputSince ?? null,
    parkedSince: parkedSinceOf({ sessionState: sessionInfo?.state ?? null, needsInputSince: sessionInfo?.needsInputSince ?? null, now: snapshotClock() }),
    // FOC-920: the deny-after policy and the last automatic "No" the host
    // answered on a parked permission prompt (null on an older host).
    autoDenial: sessionInfo?.autoDenial ?? null,
    parkedPolicy: sessionInfo?.parkedPolicy ?? null,
  };
  return redactDeep({
    supervisor,
    needsYou,
    children,
    counts: cockpitCounts({ needsYou, children }),
    checkedAt: new Date(snapshotClock()).toISOString(),
  });
}

/** FOC-918: the ISO instant the Supervisor was parked on a prompt past the stall SLA, else null. */
function parkedSinceOf({ sessionState, needsInputSince, now }) {
  if (sessionState !== "needs-input" || typeof needsInputSince !== "string") return null;
  const since = Date.parse(needsInputSince);
  if (!Number.isFinite(since)) return null;
  return now - since >= stallSilenceMs() ? needsInputSince : null;
}

/**
 * The Needs-you items the LIVE Supervisor session contributes (FOC-810),
 * prepended ahead of the run-store items: the pending ask (category "ask")
 * outranks everything, else a permission or select dialog (category "dialog")
 * the pane is showing. Both are answerable from the dashboard, so the counts
 * include them as-is. An ask-review dialog is covered by the pending ask —
 * never by a dialog item.
 *
 * FOC-918 adds two non-answerable problem items, so a waiting prompt can
 * never read as "nothing needs you": when the session waits for input the
 * parser could not read, an "unrecognised-prompt" problem shows it; and when
 * that wait has held longer than the stall SLA, a "supervisor-parked"
 * problem flags the parking.
 *
 * FOC-920 adds the deny-after policy: a recent automatic "No" the host
 * answered on a parked permission prompt (within 24 h) shows as its own
 * "supervisor-auto-denied" problem, and when the policy is deny-after the
 * parked item counts down the minutes to the next auto-deny.
 */
function supervisorSessionItems({ dialog, pendingAsk, supRunId, focus, sessionState, needsInputSince, autoDenial, parkedPolicy, now }) {
  const shared = {
    runId: supRunId ?? null,
    taskId: focus?.taskId ?? null,
    childId: null,
    createdAt: null,
    ageMs: null,
    state: "pending",
    answerable: true,
  };
  const items = [];
  if (pendingAsk) {
    items.push({
      ...shared,
      id: `ask:${pendingAsk.toolUseId}`,
      category: "ask",
      kind: "ask",
      answerKind: "ask",
      summary: pendingAsk.questions[0]?.question ?? "",
      toolUseId: pendingAsk.toolUseId,
      questions: pendingAsk.questions,
    });
  } else if (dialog && (dialog.kind === "permission" || dialog.kind === "select")) {
    items.push({
      ...shared,
      id: `dialog:${dialog.id}`,
      category: "dialog",
      kind: dialog.kind,
      answerKind: "dialog",
      summary: dialog.title ?? "",
      dialog,
    });
  }
  // FOC-918: a prompt the parser could not read must still show — and count.
  if (sessionState === "needs-input" && items.length === 0) {
    const askWithoutTranscript = !!dialog && (dialog.kind === "ask" || dialog.kind === "ask-review");
    const ageMs = typeof needsInputSince === "string" && Number.isFinite(Date.parse(needsInputSince)) ? Math.max(0, now - Date.parse(needsInputSince)) : null;
    items.push({
      ...shared, id: "problem:supervisor:unrecognised-prompt", category: "problem", kind: "unrecognised-prompt",
      answerKind: null, answerable: false, state: "open", createdAt: needsInputSince ?? null, ageMs,
      summary: askWithoutTranscript
        ? "the Supervisor asks a question the dashboard could not read from its transcript — answer it in the Terminal tab or with fenix attach"
        : "the Supervisor pane waits for input the dashboard could not read — answer it in the Terminal tab or with fenix attach",
    });
  }
  const parkedSince = parkedSinceOf({ sessionState, needsInputSince, now });
  if (parkedSince) {
    const ageMs = Math.max(0, now - Date.parse(parkedSince));
    const what = dialog?.reason
      ? `${dialog.reason.type}${dialog.reason.detail ? `: ${dialog.reason.detail}` : ""}`
      : (dialog?.title ? dialog.title : "an unrecognised prompt");
    let summary = `the Supervisor has been parked on a prompt for ${Math.round(ageMs / 60000)} min — ${what}; answer it from the Needs-you card, the Terminal tab or fenix attach`;
    // FOC-920: under deny-after the parked prompt is on a countdown — say
    // how much of the window is left before the host answers "No" itself.
    if (parkedPolicy && parkedPolicy.mode === "deny-after" && Number.isFinite(Number(parkedPolicy.minutes))) {
      const remaining = Math.max(0, Math.ceil(Number(parkedPolicy.minutes) - ageMs / 60000));
      summary += ` — auto-deny in ${remaining} min (taskSessions.parkedPrompt = deny-after)`;
    }
    items.push({
      ...shared, id: "problem:supervisor:parked", category: "problem", kind: "supervisor-parked",
      answerKind: null, answerable: false, state: "open", createdAt: parkedSince, ageMs,
      summary,
    });
  }
  // FOC-920: the host answered a parked permission prompt "No" by itself —
  // show it for 24 h so the denial is never silent. Only a CONFIRMED denial
  // (the locked answer returned 200) renders; an older host's rows carry no
  // status at all and still render, but a 409/503 row (nothing was pressed)
  // must not read as an answer the host gave.
  if (autoDenial && typeof autoDenial === "object" && typeof autoDenial.ts === "string"
    && Number.isFinite(Date.parse(autoDenial.ts))
    && (autoDenial.status === undefined || autoDenial.status === 200)
    && now - Date.parse(autoDenial.ts) < 24 * 60 * 60_000) {
    const reasonLabel = typeof autoDenial.reason === "string" && autoDenial.reason
      ? autoDenial.reason
      : (autoDenial.reason && typeof autoDenial.reason === "object" && autoDenial.reason.type
        ? `${autoDenial.reason.type}${autoDenial.reason.detail ? `: ${autoDenial.reason.detail}` : ""}`
        : "unrecognised prompt");
    items.push({
      ...shared,
      id: `problem:supervisor:auto-denied:${autoDenial.dialogId ?? "unknown"}`,
      category: "problem", kind: "supervisor-auto-denied",
      answerKind: null, answerable: false, state: "open",
      createdAt: autoDenial.ts,
      ageMs: Math.max(0, now - Date.parse(autoDenial.ts)),
      summary: `the host answered a parked permission prompt "No" after ${autoDenial.minutes} min with nobody attached (${reasonLabel}) — check the Supervisor's next turn; set taskSessions.parkedPrompt to "wait" to keep prompts open`,
    });
  }
  return items;
}

/**
 * Serve a snapshot through the TTL cache; `build` is injected so tests can
 * count builds and force errors. `key` scopes the entry — "global" for the
 * aggregate, `sid:<id>` per session — so a scoped poll never serves another
 * session's (or the global) snapshot. A fresh cache returns immediately;
 * otherwise one build runs per key and every concurrent caller awaits the
 * same promise. A build that throws is not cached — the error propagates and
 * the next request starts over.
 */
export async function cachedCockpitSnapshot(build, { key = "global" } = {}) {
  const cache = snapshotCaches.get(key);
  if (cache && snapshotClock() - cache.at < snapshotTtlMs) return cache.payload;
  if (!snapshotBuilds.has(key)) {
    const buildPromise = (async () => {
      const payload = await build();
      snapshotCaches.set(key, { at: snapshotClock(), payload });
      return payload;
    })().finally(() => {
      snapshotBuilds.delete(key);
    });
    snapshotBuilds.set(key, buildPromise);
  }
  return snapshotBuilds.get(key);
}

// ── routes ───────────────────────────────────────────────────────────────────

/**
 * The host's session list (redacted) plus the active-cap ceiling, or null when
 * the host is not configured / unreachable — the caller decides what that
 * reads as (the list answers 503; the managed check treats null as "none").
 * Only safe record fields pass through (redactSessionRecord); delivery comes
 * back as-is.
 */
async function fetchHostSessions() {
  if (!hostBase()) return null;
  const result = await hostRequest("GET", "/sessions", null, { timeoutMs: FAST_TIMEOUT_MS });
  if (result.status !== 200 || !result.body || typeof result.body !== "object") return null;
  const records = Array.isArray(result.body.sessions) ? result.body.sessions : [];
  return {
    sessions: records.map(redactSessionRecord).filter(Boolean),
    ...(result.body.maxActive !== undefined ? { maxActive: result.body.maxActive } : {}),
  };
}

/**
 * Do managed (task-scoped) sessions exist right now? The global
 * /api/supervisor/* controls and the global /api/cockpit snapshot are
 * unambiguous only while the answer is "no" — with managed sessions alive the
 * global endpoints can never tell WHICH session the caller means, so they
 * answer 409 selection-required. Fail-open only toward "unmanaged": a host
 * that is not configured (native) or unreachable cannot prove managed
 * sessions exist, and blocking the dashboard on a dead host would hide the
 * outage behind a 409.
 */
async function managedSessionsExist() {
  const list = await fetchHostSessions();
  if (!list) return false;
  return list.sessions.some((s) => !["stopped", "completed", "failed"].includes(s?.status));
}

/** The 409 the global endpoints answer when the choice of session is required. */
const selectionRequired = (res, path, json, log, method) => {
  json(res, 409, {
    error: "selection-required",
    reason: "managed task sessions exist — address one through /api/supervisor/sessions/:sid/… or /api/cockpit?sessionId=",
  });
  log(method, path, 409);
};

/** Parse `after`/`limit` for the conversation GETs; null body on a 400. */
function conversationParams(url) {
  let after = null;
  const afterRaw = url.searchParams.get("after");
  if (afterRaw !== null) {
    const n = Number(afterRaw);
    if (!Number.isInteger(n) || n < 0) return { error: "after must be an integer >= 0" };
    after = n;
  }
  let limit = 200;
  const limitRaw = url.searchParams.get("limit");
  if (limitRaw !== null) {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n < 1 || n > 500) return { error: "limit must be an integer in 1..500" };
    limit = n;
  }
  return { after, limit };
}

/**
 * Resolve the ONE run a scoped write is allowed to touch: the session's own
 * current-run pointer (the scoped env's supervisorCurrentRunPath). Returns
 * { runId } or { error: "no-run" | "unreachable" } — a scoped answer must
 * never fall back to another run's gate.
 */
function scopedRunIdOf(sid) {
  const scopedEnv = sessionScopedEnv(process.env, sid);
  const current = readCurrentRun({ path: supervisorCurrentRunPath(scopedEnv) });
  return current?.runId ? { runId: current.runId } : { error: "no-run" };
}

/**
 * The taskKey the session is bound to, from the two sources that must agree:
 * the host's session record and the session-scoped current-run pointer. A
 * record taskKey always wins when present; null when neither says.
 */
function scopedTaskKeyOf(sid, record) {
  if (record?.taskKey) return record.taskKey;
  try {
    const scopedEnv = sessionScopedEnv(process.env, sid);
    return readCurrentRun({ path: supervisorCurrentRunPath(scopedEnv) })?.taskKey ?? null;
  } catch {
    return null;
  }
}

/**
 * The runId-ownership check the gate/hold endpoints apply when the caller
 * names a sessionId: the run being answered must be the session's own current
 * run. true passes; otherwise { status, body } is the answer to send (400
 * malformed sid, 404 unknown session or foreign run, 503 unreachable host).
 * A scoped UI therefore can NEVER answer a foreign run's gate by naming a
 * session it controls.
 */
async function verifyRunOwnership(sid, runId, taskKey) {
  if (!validSessionId(sid)) return { status: 400, body: { error: "bad-session-id" } };
  const recordResult = await fetchHostSession(sid);
  if (recordResult.status === 0) {
    return { status: 503, body: { error: "host-unreachable", reason: recordResult.error } };
  }
  if (recordResult.status !== 200 || !recordResult.body || typeof recordResult.body !== "object") {
    return { status: 404, body: { error: "unknown-session" } };
  }
  const record = redactSessionRecord(recordResult.body.taskSession ?? recordResult.body.session ?? recordResult.body);
  if (taskKey && record?.taskKey !== taskKey) return { status: 404, body: { error: "task-mismatch" } };
  const resolved = scopedRunIdOf(sid);
  if (resolved.error) {
    return { status: 404, body: { error: "no-run", reason: `session ${sid} has no current run` } };
  }
  if (resolved.runId !== runId) {
    return {
      status: 404,
      body: { error: "foreign-run", reason: `run ${runId} does not belong to session ${sid}` },
    };
  }
  return true;
}

/**
 * Handle a Cockpit HTTP route. Returns true when the request was handled (the
 * caller returns immediately), false when it is not one of ours.
 */
export async function handleCockpitRoute(req, res, url, ctx) {
  const method = req.method;
  const path = url.pathname;
  const { readJsonBody, respondBodyError, json, log } = ctx;
  // FOC-958: the audit actor for every answer route below — "dashboard" unless
  // the caller carries a well-formed remote: header (actorOf).
  const actor = actorOf(req);

  // FOC-839: the run-targeted global write routes refuse any run that the
  // legacy migration marked read-only. Returns true when the 409 was sent.
  // The runId reaches the filesystem probe unvalidated from the URL, so gate
  // on a coarse shape first (non-empty, no path separators, no `..`) — the
  // strict RUN_ID_RE would exclude the existing `run-*` fixture ids. Malformed
  // ids keep the routes' existing status codes; they just never probe the fs.
  const denyIfLegacyReadOnly = (res, runId, method, path) => {
    if (typeof runId !== "string" || runId.length === 0 || /[\\/]/.test(runId) || runId.includes("..")) return false;
    if (!isLegacyReadOnly(runDir(runId))) return false;
    json(res, 409, {
      error: "legacy-readonly",
      reason: "this run was marked read-only by the legacy session migration (FOC-839); its history stays readable",
    });
    log(method, path, 409);
    return true;
  };

  // ── task-scoped session routes (plan P1c) ────────────────────────────────
  // Dispatched BEFORE the global routes. The :sid is validated against the
  // strict pattern first — a malformed id is a 404 that never touched the
  // host — then existence is checked against the host's own session list, so
  // an unknown-but-well-formed sid is ALSO a 404 before any read or forward.

  // GET /api/supervisor/sessions — the host's list, redacted to the safe
  // record fields (+ maxActive). Native mode / unreachable host → 503 with
  // the same error shapes the other host-backed routes use.
  if (method === "GET" && path === "/api/supervisor/sessions") {
    const list = await fetchHostSessions();
    if (!list) {
      json(res, 503, { error: hostBase() ? "host-unreachable" : "docker-only" });
      log(method, path, 503);
      return true;
    }
    json(res, 200, list);
    log(method, path, 200);
    return true;
  }

  // GET /api/cockpit?sessionId=<sid>&taskKey=<optional> — the scoped
  // snapshot: only the target run's children / needs-you / gates / holds /
  // focus. Without sessionId this falls through to the global snapshot.
  if (method === "GET" && path === "/api/cockpit" && url.searchParams.get("sessionId")) {
    const sid = validSessionId(url.searchParams.get("sessionId"));
    if (!sid) {
      json(res, 400, { error: "sessionId must match /sup-[a-f0-9]{16,32}/" });
      log(method, path, 400);
      return true;
    }
    const taskKey = url.searchParams.get("taskKey");
    // Existence + (when taskKey is given) the taskKey match — both decided
    // from the host's own record before anything is built.
    const recordResult = await fetchHostSession(sid);
    if (recordResult.status === 0 || recordResult.status !== 200 || !recordResult.body || typeof recordResult.body !== "object") {
      json(res, recordResult.status === 0 ? 503 : recordResult.status === 404 ? 404 : 502, {
        error: recordResult.status === 0 ? "host-unreachable" : recordResult.status === 404 ? "unknown-session" : "host-error",
        ...(recordResult.status === 0 ? { reason: recordResult.error } : {}),
      });
      log(method, path, recordResult.status === 0 ? 503 : recordResult.status === 404 ? 404 : 502);
      return true;
    }
    const record = redactSessionRecord(recordResult.body.session ?? recordResult.body.taskSession ?? recordResult.body);
    if (taskKey) {
      const bound = scopedTaskKeyOf(sid, record);
      if (bound !== taskKey) {
        json(res, 404, { error: "task-mismatch", reason: `session ${sid} is not bound to taskKey ${taskKey}` });
        log(method, path, 404);
        return true;
      }
    }
    // Same TTL cache as the global snapshot, keyed per sessionId+run: the
    // payload carries both, and a scoped poll never serves another session's
    // entry (and never the global one).
    const payload = await cachedCockpitSnapshot(
      () => buildScopedCockpitSnapshot({ sessionId: sid, taskKey: taskKey ?? null }),
      { key: `sid:${sid}` },
    );
    const redacted = { ...payload, taskSession: payload.taskSession ?? record };
    json(res, 200, redactDeep(redacted));
    log(method, path, 200);
    return true;
  }

  // The scoped mirrors. Each validates the sid, then the session's existence
  // on the host, then (where the route touches a task binding) the taskKey.
  const scopedMatch = path.match(/^\/api\/supervisor\/sessions\/([^/]+)(\/.*)?$/);
  if (scopedMatch) {
    const sid = validSessionId(decodeURIComponentSafe(scopedMatch[1]));
    const suffix = scopedMatch[2] ?? "";
    if (!sid) {
      json(res, 404, { error: "unknown-session", reason: "malformed session id" });
      log(method, path, 404);
      return true;
    }
    // Existence check ONCE per request; /alive stays a shared probe (see the
    // plan) and is NOT proxied here — the scoped surface has no /alive.
    const recordResult = await fetchHostSession(sid);
    if (recordResult.status === 0) {
      json(res, 503, { error: "host-unreachable", reason: recordResult.error });
      log(method, path, 503);
      return true;
    }
    if (recordResult.status !== 200 || !recordResult.body || typeof recordResult.body !== "object") {
      json(res, 404, { error: "unknown-session" });
      log(method, path, 404);
      return true;
    }
    const record = redactSessionRecord(recordResult.body.session ?? recordResult.body.taskSession ?? recordResult.body);
    const boundTaskKey = scopedTaskKeyOf(sid, record);
    const taskKeyMatches = (candidate) => !candidate || candidate === boundTaskKey;
    if(!taskKeyMatches(url.searchParams.get('taskKey'))){json(res,404,{error:'task-mismatch'});return true;}

    if (method === 'GET' && suffix === '/profile-preview') {
      const result=await hostRequest('GET',hostSessionPath(sid,'/profile-preview'),null,{timeoutMs:FAST_TIMEOUT_MS});
      json(res,result.status||503,result.body??{error:'host-unreachable'});return true;
    }
    if (method === 'POST' && suffix === '/resume') {
      if(!writeGuards(req,res,path,ctx))return true;
      let body;try{body=await readJsonBody(req,BODY_CAP);}catch(error){respondBodyError(res,error);return true;}
      if(!taskKeyMatches(body.taskKey)){json(res,404,{error:'task-mismatch'});return true;}
      const result=await hostRequest('POST',hostSessionPath(sid,'/resume'),{confirm:body.confirm,expectedRevision:body.expectedRevision},{timeoutMs:SLOW_TIMEOUT_MS});
      json(res,result.status||503,result.body??{error:'host-unreachable'});return true;
    }

    // GET /sessions/:sid/state — the host's own getState shape, passed through
    // with the record redacted. Nothing on disk is read here: the host IS the
    // state owner.
    if (method === "GET" && suffix === "/state") {
      const result = await hostRequest("GET", hostSessionPath(sid, "/state"), null, { timeoutMs: FAST_TIMEOUT_MS });
      if (result.status === 0) {
        json(res, 503, { error: "host-unreachable", reason: result.error });
      } else if (result.body && typeof result.body === "object") {
        const body = { ...result.body };
        if (body.taskSession) body.taskSession = redactSessionRecord(body.taskSession);
        if (body.session && typeof body.session === "object") body.session = redactSessionRecord(body.session);
        if (body.hook?.transcriptPath) delete body.hook.transcriptPath;
        json(res, result.status, body);
      } else {
        json(res, result.status, result.body);
      }
      log(method, path, result.status === 0 ? 503 : result.status);
      return true;
    }

    // GET /sessions/:sid/conversation — the session's own chat transcript,
    // read from the isolated claude dir under THIS session's home. The cursor
    // resets when the conversation generation changes (the read's `reset`
    // flag), and the path is confined to supervisorSessionClaudeDir — never
    // the shared squad config, never another session's home.
    if (method === "GET" && suffix === "/conversation") {
      const params = conversationParams(url);
      if (params.error) {
        json(res, 400, { error: params.error });
        log(method, path, 400);
        return true;
      }
      // The session's own hook record on disk (session.json under the session
      // home) carries transcriptPath; the host's state hook is the fallback.
      const scopedEnv = sessionScopedEnv(process.env, sid);
      const session = readSupervisorSession(scopedEnv);
      let transcriptPath = null;
      const hookPath = typeof session?.transcriptPath === "string" ? session.transcriptPath : null;
      if (hookPath && hookPath.endsWith(".jsonl")) {
        const claudeRoot = resolvePath(supervisorSessionClaudeDir(scopedEnv));
        const abs = resolvePath(hookPath);
        transcriptPath = abs === claudeRoot || abs.startsWith(claudeRoot + sep) ? abs : null;
      }
      let result = { offset: 0, entries: [], reset: false, truncated: false };
      if (transcriptPath) result = readConversation({ transcriptPath, after: params.after, limit: params.limit });
      json(res, 200, {
        sessionId: typeof session?.sessionId === "string" ? session.sessionId : sid,
        state: typeof session?.state === "string" ? session.state : null,
        taskKey: boundTaskKey,
        taskSession: record,
        offset: result.offset,
        entries: redactDeep(result.entries),
        reset: result.reset,
        truncated: result.truncated,
      });
      log(method, path, 200);
      return true;
    }

    // POST /sessions/:sid/message { text } — the chat forward to the scoped
    // host route.
    if (method === "POST" && suffix === "/message") {
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
      if (body.taskKey !== undefined && !taskKeyMatches(body.taskKey)) {
        json(res, 404, { error: "task-mismatch", reason: `session ${sid} is not bound to taskKey ${body.taskKey}` });
        log(method, path, 404);
        return true;
      }
      const result = await hostRequest("POST", hostSessionPath(sid, "/message"), { text: body.text }, { timeoutMs: SLOW_TIMEOUT_MS });
      json(res, result.status === 0 ? 503 : result.status, result.status === 0 ? { error: "host-unreachable", reason: result.error } : result.body);
      log(method, path, result.status === 0 ? 503 : result.status);
      return true;
    }

    // POST /sessions/:sid/session { fresh, confirm } — the scoped restart.
    // Same typed confirmation as the global route.
    if (method === "POST" && suffix === "/session") {
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
      if (body.taskKey !== undefined && !taskKeyMatches(body.taskKey)) {
        json(res, 404, { error: "task-mismatch", reason: `session ${sid} is not bound to taskKey ${body.taskKey}` });
        log(method, path, 404);
        return true;
      }
      const result = await hostRequest("POST", hostSessionPath(sid, "/session"), { fresh }, { timeoutMs: SLOW_TIMEOUT_MS });
      json(res, result.status === 0 ? 503 : result.status, result.status === 0 ? { error: "host-unreachable", reason: result.error } : result.body);
      log(method, path, result.status === 0 ? 503 : result.status);
      return true;
    }

    // POST /sessions/:sid/stop — stop this session only.
    if (method === "POST" && suffix === "/stop") {
      if (!writeGuards(req, res, path, ctx)) return true;
      let body = {};
      try {
        body = (await readJsonBody(req, BODY_CAP)) ?? {};
      } catch (err) {
        log(method, path, respondBodyError(res, err));
        return true;
      }
      if (body.taskKey !== undefined && !taskKeyMatches(body.taskKey)) {
        json(res, 404, { error: "task-mismatch", reason: `session ${sid} is not bound to taskKey ${body.taskKey}` });
        log(method, path, 404);
        return true;
      }
      const result = await hostRequest("POST", hostSessionPath(sid, "/stop"), {}, { timeoutMs: SLOW_TIMEOUT_MS });
      json(res, result.status === 0 ? 503 : result.status, result.status === 0 ? { error: "host-unreachable", reason: result.error } : result.body);
      log(method, path, result.status === 0 ? 503 : result.status);
      return true;
    }

    // POST /sessions/:sid/wake — the drain prompt for THIS session's run only:
    // fresh rows read from the scoped run's wake queue, not the 14-day sum.
    if (method === "POST" && suffix === "/wake") {
      if (!writeGuards(req, res, path, ctx)) return true;
      let body = {};
      try {
        body = (await readJsonBody(req, BODY_CAP)) ?? {};
      } catch (err) {
        log(method, path, respondBodyError(res, err));
        return true;
      }
      if (body.taskKey !== undefined && !taskKeyMatches(body.taskKey)) {
        json(res, 404, { error: "task-mismatch", reason: `session ${sid} is not bound to taskKey ${body.taskKey}` });
        log(method, path, 404);
        return true;
      }
      const resolved = scopedRunIdOf(sid);
      if (resolved.error) {
        json(res, 409, { error: resolved.error, reason: `session ${sid} has no current run — nothing to wake` });
        log(method, path, 409);
        return true;
      }
      const runId = resolved.runId;
      const prefix = "[dashboard] Mateusz asked you to check waiting events: ";
      const drain = "drain now: node $LA_ROOT/scripts/supervisor-status.mjs --drain --tail 20";
      let text = prefix + drain;
      try {
        const fresh = freshRows({
          rows: readWakeQueue(runId),
          ackedThrough: readWakeAck(runId),
          firedThrough: readWakerLease(runId)?.firedThrough ?? 0,
        });
        if (fresh.length) text = prefix + formatWakeMessage(runId, fresh);
      } catch {
        /* the drain fallback stands */
      }
      const result = await hostRequest("POST", hostSessionPath(sid, "/message"), { text }, { timeoutMs: SLOW_TIMEOUT_MS });
      json(res, result.status === 0 ? 503 : result.status, result.status === 0 ? { error: "host-unreachable", reason: result.error } : result.body);
      log(method, path, result.status === 0 ? 503 : result.status);
      return true;
    }

    // POST /sessions/:sid/dialog { id, choice, note? } — the scoped dialog
    // answer. Same body rules as the global route.
    if (method === "POST" && suffix === "/dialog") {
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
      if (body.taskKey !== undefined && !taskKeyMatches(body.taskKey)) {
        json(res, 404, { error: "task-mismatch", reason: `session ${sid} is not bound to taskKey ${body.taskKey}` });
        log(method, path, 404);
        return true;
      }
      const payload = { id: body.id, choice: body.choice };
      if (typeof body.note === "string" && body.note.trim()) payload.note = body.note;
      const result = await hostRequest("POST", hostSessionPath(sid, "/dialog/answer"), payload, { timeoutMs: SLOW_TIMEOUT_MS });
      const status = result.status === 0 ? 503 : result.status;
      json(res, status, result.status === 0 ? { error: "host-unreachable", reason: result.error } : result.body);
      log(method, path, status);
      return true;
    }

    // POST /sessions/:sid/ask { toolUseId, answers } — the scoped ask answer.
    // The pending ask is re-read from THIS session's transcript (same
    // confinement as the scoped conversation), a mismatch is 409 ask-changed,
    // and the audit row lands in the session's own run.
    if (method === "POST" && suffix === "/ask") {
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
      if (body.taskKey !== undefined && !taskKeyMatches(body.taskKey)) {
        json(res, 404, { error: "task-mismatch", reason: `session ${sid} is not bound to taskKey ${body.taskKey}` });
        log(method, path, 404);
        return true;
      }
      if (!hostBase()) {
        json(res, 503, { error: "docker-only" });
        log(method, path, 503);
        return true;
      }
      // The pending ask comes from the session's own transcript on disk — the
      // same source the scoped snapshot reads it from. A pane that moved on
      // (or a session without a transcript) is 409 ask-changed, nothing sent.
      const scopedEnv = sessionScopedEnv(process.env, sid);
      const session = readSupervisorSession(scopedEnv);
      let pending = null;
      const hookPath = typeof session?.transcriptPath === "string" ? session.transcriptPath : null;
      if (hookPath && hookPath.endsWith(".jsonl")) {
        const claudeRoot = resolvePath(supervisorSessionClaudeDir(scopedEnv));
        const abs = resolvePath(hookPath);
        const transcriptPath = abs === claudeRoot || abs.startsWith(claudeRoot + sep) ? abs : null;
        pending = transcriptPath ? readPendingAsk(transcriptPath) : null;
      }
      if (!pending || pending.toolUseId !== body.toolUseId) {
        json(res, 409, { error: "ask-changed" });
        log(method, path, 409);
        return true;
      }
      const result = await hostRequest("POST", hostSessionPath(sid, "/dialog/ask"), {
        questions: pending.questions.map((q) => ({
          question: q.question,
          multiSelect: q.multiSelect,
          options: (q.options ?? []).map((o) => ({ label: o.label })),
        })),
        answers: body.answers,
      }, { timeoutMs: SLOW_TIMEOUT_MS });
      const status = result.status === 0 ? 503 : result.status;
      json(res, status, result.status === 0 ? { error: "host-unreachable", reason: result.error } : result.body);
      log(method, path, status);
      if (result.status === 200 && result.body?.answered === true) {
        invalidateCockpitSnapshot(`sid:${sid}`);
        const resolved = scopedRunIdOf(sid);
        const runId = resolved.runId ?? null;
        const summary = askAnswerSummary(pending, body.answers);
        if (runId && summary.trim()) {
          try {
            recordAnswerRow({
              runId,
              kind: "ask-answer",
              id: pending.toolUseId,
              text: summary,
              who: actor,
              notified: true,
              payload: askAnswerPayload(pending, body.answers),
            });
          } catch (err) {
            console.error("[supervisor/ask] edit row failed:", err);
          }
        }
      }
      return true;
    }

    // Anything else under /sessions/:sid/… is not ours.
    return false;
  }

  // ── global routes — gated while managed sessions exist ───────────────────
  // (GET /alive stays available through the host directly; the dashboard's
  // shared probe does not need a selection. The conversation GET is read-only
  // and stays ungated for the legacy UI, which cannot name a session.)

  // GET /api/cockpit — the whole snapshot in one poll: the Needs-you inbox,
  // the children board, the counts strip and the Supervisor panel. In Docker
  // the process probe is the host's POST /alive (the API container cannot see
  // the supervisor container's pids); natively it is processAlive on this
  // machine. A host that cannot be reached makes the probe return null —
  // live children then show "unknown", never silently "running".
  // Served through the TTL cache (see cachedCockpitSnapshot): a build costs
  // 70–145 ms of synchronous fs and every page in the UI polls this route.
  // With managed sessions alive the aggregate is ambiguous — 409, pick one.
  if (method === "GET" && path === "/api/cockpit") {
    if (await managedSessionsExist()) {
      selectionRequired(res, path, json, log, method);
      return true;
    }
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
  // text; its statuses pass through unchanged). With managed sessions alive
  // the target is ambiguous — 409, address one through the scoped mirrors.
  if (method === "POST" && path === "/api/supervisor/message") {
    if (!writeGuards(req, res, path, ctx)) return true;
    if (await managedSessionsExist()) {
      selectionRequired(res, path, json, log, method);
      return true;
    }
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
    if (await managedSessionsExist()) {
      selectionRequired(res, path, json, log, method);
      return true;
    }
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
    if (await managedSessionsExist()) {
      selectionRequired(res, path, json, log, method);
      return true;
    }
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
    if (await managedSessionsExist()) {
      selectionRequired(res, path, json, log, method);
      return true;
    }
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
            who: actor,
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
    if (await managedSessionsExist()) {
      selectionRequired(res, path, json, log, method);
      return true;
    }
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
    // The sessionId decides legacy vs task-scoped BEFORE any write (see
    // answerSessionId): the legacy dashboard sends none — its session id is a
    // Claude UUID that must never reach hostSessionPath — and a malformed
    // string is a 400 with nothing written.
    const answerSid = answerSessionId(body.sessionId);
    if (answerSid === false) {
      json(res, 400, { error: "bad-session-id" });
      log(method, path, 400);
      return true;
    }
    if (!body.sessionId && await managedSessionsExist()) {
      selectionRequired(res, path, json, log, method);
      return true;
    }
    const { runId, gateId, text, note } = body;
    if (!runId || !gateId || typeof text !== "string" || !text.trim()) {
      json(res, 400, { error: "runId, gateId and text (string) are required" });
      log(method, path, 400);
      return true;
    }
    // FOC-839: refuse runs marked read-only by the legacy migration.
    if (denyIfLegacyReadOnly(res, runId, method, path)) return true;
    // Cross-session guard: in a managed context a scoped UI must not be able
    // to answer a run it does not own. When the caller names a sessionId, the
    // gate's run must be that session's own current run.
    if (answerSid) {
      const ownership = await verifyRunOwnership(answerSid, runId, body.taskKey);
      if (ownership !== true) {
        json(res, ownership.status, ownership.body);
        log(method, path, ownership.status);
        return true;
      }
    }
    let gate;
    try {
      gate = answerGate({
        runId,
        gateId,
        text,
        note: typeof note === "string" && note.trim() ? note : null,
        answeredBy: actor,
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
    const notify = await notifyGateAnswered(gate, gateId, answerSid);
    let rowError = null;
    try {
      recordAnswerRow({ runId, kind: "gate-answer", id: gateId, text, who: actor, notified: notify.notified });
    } catch (err) {
      // The answer IS recorded; the audit row is the only thing that failed.
      // The response still says recorded:true — a 500 would make the UI hide
      // an answer that exists on disk.
      rowError = err?.message ?? String(err);
      console.error("[gates/answer] edit row failed:", rowError);
    }
    json(res, 200, {
      recorded: true,
      notified: notify.notified,
      gate,
      ...(notify.notifyError ? { notifyError: notify.notifyError } : {}),
      ...(rowError ? { rowError } : {}),
    });
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
    // The sessionId decides legacy vs task-scoped BEFORE any write — same
    // guard as the gate answer (answerSessionId).
    const answerSid = answerSessionId(body.sessionId);
    if (answerSid === false) {
      json(res, 400, { error: "bad-session-id" });
      log(method, path, 400);
      return true;
    }
    if (!body.sessionId && await managedSessionsExist()) {
      selectionRequired(res, path, json, log, method);
      return true;
    }
    const { runId, holdId, text } = body;
    if (!runId || !holdId || typeof text !== "string" || !text.trim()) {
      json(res, 400, { error: "runId, holdId and text (string) are required" });
      log(method, path, 400);
      return true;
    }
    // FOC-839: refuse runs marked read-only by the legacy migration.
    if (denyIfLegacyReadOnly(res, runId, method, path)) return true;
    // Cross-session guard: same ownership rule as the gate answer.
    if (answerSid) {
      const ownership = await verifyRunOwnership(answerSid, runId, body.taskKey);
      if (ownership !== true) {
        json(res, ownership.status, ownership.body);
        log(method, path, ownership.status);
        return true;
      }
    }
    let hold;
    try {
      hold = answerHold({ runId, holdId, text, answeredBy: actor, lockWaitMs: 0 });
    } catch (err) {
      const status = answerErrorStatus(err?.code);
      if (status === 500) console.error("[holds/answer]", err?.message || err);
      json(res, status, answerErrorBody(err));
      log(method, path, status);
      return true;
    }
    const taskId = hold?.taskId ?? null;
    const notify = await notifyAnswerText(
      answerSid,
      `[dashboard] Mateusz answered hold ${holdId} (${taskId ?? "no task"}) in the Cockpit; the answer is recorded — act on it now.`,
    );
    let rowError = null;
    try {
      recordAnswerRow({ runId, kind: "hold-answer", id: holdId, text, who: actor, notified: notify.notified });
    } catch (err) {
      rowError = err?.message ?? String(err);
      console.error("[holds/answer] edit row failed:", rowError);
    }
    json(res, 200, {
      recorded: true,
      notified: notify.notified,
      hold,
      ...(notify.notifyError ? { notifyError: notify.notifyError } : {}),
      ...(rowError ? { rowError } : {}),
    });
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
    // The sessionId decides legacy vs task-scoped BEFORE any write — same
    // guard as the gate answer (answerSessionId).
    const answerSid = answerSessionId(body.sessionId);
    if (answerSid === false) {
      json(res, 400, { error: "bad-session-id" });
      log(method, path, 400);
      return true;
    }
    if (!body.sessionId && await managedSessionsExist()) {
      selectionRequired(res, path, json, log, method);
      return true;
    }
    const { runId, gateId, holdId } = body;
    if (!runId || (!gateId && !holdId) || (gateId && holdId)) {
      json(res, 400, { error: "runId and exactly one of gateId, holdId are required" });
      log(method, path, 400);
      return true;
    }
    // FOC-839: refuse runs marked read-only by the legacy migration.
    if (denyIfLegacyReadOnly(res, runId, method, path)) return true;
    // Cross-session guard: same ownership rule as the gate answer.
    if (answerSid) {
      const ownership = await verifyRunOwnership(answerSid, runId, body.taskKey);
      if (ownership !== true) {
        json(res, ownership.status, ownership.body);
        log(method, path, ownership.status);
        return true;
      }
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
      const notify = await notifyGateAnswered(gate, gateId, answerSid);
      json(res, 200, { notified: notify.notified, ...(notify.notifyError ? { notifyError: notify.notifyError } : {}) });
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
    const notify = await notifyAnswerText(
      answerSid,
      `[dashboard] Mateusz answered hold ${holdId} (${taskId ?? "no task"}) in the Cockpit; the answer is recorded — act on it now.`,
    );
    json(res, 200, { notified: notify.notified, ...(notify.notifyError ? { notifyError: notify.notifyError } : {}) });
    log(method, path, 200);
    return true;
  }

  return false;
}

/**
 * One notice POST to the Supervisor's session, for a gate/hold answer. A NULL
 * sessionId is the LEGACY single-session dashboard: the notice goes to the
 * global host /message exactly as before the task-workspace stream (the same
 * path forwardMessageToHost forwards chat through); a session id (validated by
 * answerSessionId before any write) goes to /sessions/<sid>/message. Never
 * throws — a failed notify reads as notified:false (+ notifyError) and the
 * caller keeps its recorded answer: the gate/hold record is the primary flow.
 */
async function notifyAnswerText(sessionId, text) {
  if (!hostBase()) return { notified: false };
  try {
    const r = await hostRequest(
      "POST",
      sessionId ? hostSessionPath(sessionId, "/message") : "/message",
      { text },
      { timeoutMs: SLOW_TIMEOUT_MS },
    );
    return { notified: r.status === 200 && r.body?.sent === true };
  } catch (err) {
    return { notified: false, notifyError: err?.message ?? String(err) };
  }
}

/** Re-send the "answer recorded — deliver it now" notice for an answered gate. */
async function notifyGateAnswered(gate, gateId, sessionId) {
  const childId = gate?.childId ?? null;
  const taskId = gate?.taskId ?? null;
  return notifyAnswerText(
    sessionId,
    `[dashboard] Mateusz answered ${gateId} for ${childId ?? "?"} (${taskId ?? "no task"}) in the Cockpit; ` +
    "the answer is recorded in the gate — deliver it now.",
  );
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
 * Handle the /api/supervisor/terminal and /api/supervisor/sessions/:sid/terminal
 * upgrades: validate harder than the POST routes, then proxy raw TCP to the
 * session host's own /terminal (global) or /sessions/:sid/terminal (scoped)
 * endpoint.
 *
 * Stricter on purpose (plan §3): isAllowedOrigin accepts ANY localhost port —
 * right for the API's POSTs, wrong for a terminal with full keystroke access.
 * Here the Origin's host AND port must equal the Host header exactly, so a
 * page from another local dev server cannot open it. Host must be a loopback
 * name (DNS-rebinding guard). No Origin/cookies are forwarded.
 *
 * A scoped upgrade validates the sid against the strict pattern FIRST — a
 * malformed id destroys the socket before any upstream connection is opened —
 * and existence is checked against the host BEFORE the proxy starts: an
 * unknown-but-well-formed sid is closed without ever connecting (the task
 * contract: no WS connect before validation).
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
  // Two shapes: the legacy global terminal, and the scoped per-session one.
  let sid = null;
  let upstreamPath = "/terminal";
  if (pathname === "/api/supervisor/terminal") {
    // global — unchanged behaviour
  } else {
    const scopedMatch = typeof pathname === "string"
      ? pathname.match(/^\/api\/supervisor\/sessions\/([^/]+)\/terminal$/)
      : null;
    if (!scopedMatch) {
      socket.destroy();
      return;
    }
    const decoded = decodeURIComponentSafe(scopedMatch[1]);
    // Pattern check BEFORE anything else — no upstream connect on a malformed id.
    if (!validSessionId(decoded)) {
      socket.destroy();
      return;
    }
    sid = decoded;
    upstreamPath = hostSessionPath(sid, "/terminal");
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

  // Scoped: the session must EXIST before the proxy opens the upstream —
  // an unknown sid is closed without ever connecting. Synchronous validation
  // is impossible here (the host call is async), so the actual proxy moves
  // into the continuation below; the socket error listener from birth covers
  // the await window.
  if (sid) {
    verifyScopedTerminal(sid, new URL(req.url, "http://localhost").searchParams.get("taskKey"))
      .then((ok) => {
        if (ok) proxyTerminal(req, socket, head, base, upstreamPath);
        else reject("404 Not Found");
      })
      .catch(() => reject("503 Service Unavailable"));
    return;
  }
  proxyTerminal(req, socket, head, base, upstreamPath);
}

/** The scoped terminal's existence check: the host must know this session. */
async function verifyScopedTerminal(sid, taskKey) {
  const result = await fetchHostSession(sid);
  if (result.status !== 200 || !result.body || typeof result.body !== "object") return false;
  const record = redactSessionRecord(result.body.taskSession ?? result.body.session ?? result.body);
  return !!record && (!taskKey || record.taskKey === taskKey);
}

/**
 * The proxy itself, shared by the global and scoped shapes: token at proxy
 * time, clamped cols/rows, handshake-only headers, raw TCP pipe.
 */
function proxyTerminal(req, socket, head, base, upstreamPath) {
  // The token is read NOW, at proxy time: a supervisor restart rotates it, and
  // a queued upgrade must not carry a stale one.
  let token;
  try {
    token = readFileSync(hostTokenPath(), "utf8").trim();
  } catch {
    socket.end(`HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n`, () => socket.destroy());
    return;
  }

  let baseUrl;
  try {
    baseUrl = new URL(base);
  } catch {
    socket.end(`HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n`, () => socket.destroy());
    return;
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
    `GET ${upstreamPath}?cols=${cols}&rows=${rows} HTTP/1.1`,
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
