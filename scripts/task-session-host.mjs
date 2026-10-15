#!/usr/bin/env node
import { resolveToolProfile } from './tool-profiles.mjs';
import { createRuntimeCollector } from './runtime-otel.mjs';
// scripts/task-session-host.mjs — the task-session multiplexer (PRD
// task-workspace-supervisors §5, plan task-workspace-delivery P1B).
//
// ONE authenticated HTTP server on the internal port 7332 multiplexes MANY
// unbound supervisor-host controllers in the SAME process — one per managed
// task session. No extra public ports: HTTP requests are dispatched into a
// controller's unbound server via its own 'request' listeners, WebSocket
// upgrades into its 'upgrade' listener. Each controller runs with an env copy
// carrying FENIX_SUPERVISOR_SESSION_ID / LA_TASK_KEY / LA_TASK_ID, so its tmux
// identity (socket, session, chat buffer), its state files
// (<dataHome>/supervisor/sessions/<id>/) and its isolated Claude config dir
// are that session's and nobody else's.
//
// SECURITY MODEL — identical to supervisor-host.mjs and enforced BEFORE any
// lookup or store operation (AC-4: routing never trusts the UI):
//   · peer: only addresses FENIX_HOST_PEER (fenix-api) resolves to may call
//     in; · token: x-fenix-host-token must equal the global host.token,
//     re-read per request. Both gates fail closed. GET /healthz stays
//     loopback-only, tokenless.
//   · session ids are validated against the strict opaque pattern before any
//     path or tmux name is composed from them; unknown ids 404; malformed
//     ids 400. Raw internal errors never leak (generic 500 body).
//
// GLOBAL vs SESSION routes: the legacy global routes (/state, /session,
// /message, /dialog*, /terminal) keep working ONLY while the store holds no
// managed sessions at all (a fresh install behaves byte-identically to the
// single-session host). The moment managed sessions exist the global routes
// fail closed with 409 selection-required — the host never guesses which task
// a request means. /alive stays a global process probe; /healthz a global
// health check.
//
// SCHEDULING — the durable coordinator is task-sessions.mjs (SQLite, one
// active owner per task, atomic cap). The initial prompt is durable under the
// session home (pending-prompt.json): armed before the session may start,
// delivering once the paste begins, delivered on proof. A crash between
// states leaves delivery UNPROVEN — the host then never resends (it cannot
// know the paste did not land) and surfaces the reason instead; an operator
// re-attaches and delivers manually.
//
// CLI:
//   node scripts/task-session-host.mjs serve
//   node scripts/task-session-host.mjs session-home --session <id>
//   node scripts/task-session-host.mjs config-dir   --session <id>
//   node scripts/task-session-host.mjs attach-target
//
// ESM, zero runtime deps beyond node + ws (via supervisor-host).

import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  BODY_CAP_BYTES,
  MAX_MESSAGE_BYTES,
  createGatekeeper,
  createHost,
  readBody,
  sendJSON,
  parseJSON,
  tmuxIdentity,
  writeHostToken,
} from "./supervisor-host.mjs";
import { SUPERVISOR_SESSION_ID_PATTERN, dataHome } from "./fenix-paths.mjs";
import {
  OWNER_STATUSES,
  TERMINAL_STATUSES,
  createTaskSessionStore,
  resolveTaskKey,
} from "./task-sessions.mjs";
import { readProcessIdentity, matchesProcess } from "./task-process-identity.mjs";
import { readCurrentRun } from "./supervisor-current-run.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const platform = process.platform;

// The session id is the ONLY identifier composed into paths or tmux names;
// everything else (taskKey/taskId) is opaque user data.
const validSessionId = (value) => typeof value === "string" && SUPERVISOR_SESSION_ID_PATTERN.test(value);

/** <dataHome>/supervisor/sessions/<id> for a VALIDATED id (throws otherwise). */
export function sessionHomePath(env, sessionId) {
  if (!validSessionId(sessionId)) {
    throw new TypeError(
      `sessionId must match ${SUPERVISOR_SESSION_ID_PATTERN} — refusing to compose a path from '${sessionId}'`,
    );
  }
  return join(dataHome(env, platform), "supervisor", "sessions", sessionId);
}

// ── durable initial prompt ───────────────────────────────────────────────────

const pendingPromptPath = (sessionHome) => join(sessionHome, "pending-prompt.json");

const readPendingPrompt = (sessionHome) => {
  try {
    const parsed = JSON.parse(readFileSync(pendingPromptPath(sessionHome), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
};

// Atomic AND exclusive: 'wx' refuses to overwrite, so two racing POSTs for the
// same session can never double-arm or replace the prompt — first text wins
// and every later duplicate start re-reads the same text.
const armPendingPrompt = (sessionHome, payload) => {
  mkdirSync(sessionHome, { recursive: true });
  try {
    writeFileSync(pendingPromptPath(sessionHome), JSON.stringify({ ...payload, state: "armed" }, null, 2) + "\n", {
      encoding: "utf8",
      flag: "wx",
    });
    return true;
  } catch (err) {
    if (/EEXIST/.test(String(err?.code ?? err?.message))) return false;
    throw err;
  }
};

const markPendingPrompt = (sessionHome, pending, patch) => {
  const path = pendingPromptPath(sessionHome);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...pending, ...patch }, null, 2) + "\n");
  // Atomic rename over the target; the file was proven to exist (we read it
  // before marking), so the delivery state never goes backwards.
  renameSync(tmp, path);
};

// ── the multiplexer ──────────────────────────────────────────────────────────

const STATUS_TEXT = { 400: "Bad Request", 404: "Not Found", 409: "Conflict", 500: "Internal Server Error" };

/**
 * Build the task-session host. Every dep is optional; the defaults are the
 * real thing. deps.controllerDeps is either an object spread into EVERY
 * controller's createHost deps, or a function (sessionId) → deps — the seam
 * tests use to give each session its own fake tmux/pty/clock.
 */
export function createTaskSessionHost(deps = {}) {
  const baseEnv = deps.env ?? process.env;
  const maxActive = deps.maxActive ?? Number(baseEnv.FENIX_MAX_ACTIVE_SUPERVISORS || 2);
  const processIdentity = deps.processIdentity ?? readProcessIdentity;
  const stopping = new Set();
  const uncertain = new Set();
  const startById = new Map();
  const tmuxBin = baseEnv.LA_TMUX_BIN || "tmux";

  const store = deps.store ?? createTaskSessionStore({ dbPath: deps.dbPath, maxActive });
  const gate = deps.gate
    ?? createGatekeeper({ env: baseEnv, readToken: deps.readToken, resolvePeer: deps.resolvePeer });

  // The legacy controller serves the global routes while no managed session
  // exists. Its env is explicitly stripped of any session scoping.
  const legacyEnv = { ...baseEnv };
  delete legacyEnv.FENIX_SUPERVISOR_SESSION_ID;
  const legacy = createHost({ ...(deps.legacyDeps ?? {}), env: legacyEnv });

  // ── controllers: one per managed session, created lazily, never twice ────
  const controllers = new Map(); // sessionId → { host, env, sessionHome, sessionId }
  const creating = new Map(); // sessionId → Promise<controller>

  async function controllerFor(sessionId) {
    const existing = controllers.get(sessionId);
    if (existing) return existing;
    const inflight = creating.get(sessionId);
    if (inflight) return inflight;
    const promise = (async () => {
      const record = store.get(sessionId);
      if (!record) {
        const err = new Error(`unknown session ${sessionId}`);
        err.statusCode = 404;
        throw err;
      }
      const sessionHome = sessionHomePath(baseEnv, sessionId);
      const env = {
        ...baseEnv,
        FENIX_SUPERVISOR_SESSION_ID: sessionId,
        LA_TASK_KEY: record.taskKey,
        LA_TASK_ID: record.taskId,
        LA_SUPERVISOR_SESSION_HOME: sessionHome,
      };
      const controllerDeps = typeof deps.controllerDeps === "function"
        ? (deps.controllerDeps(sessionId) ?? {})
        : (deps.controllerDeps ?? {});
      const host = createHost({ ...controllerDeps, env });
      const ctl = { host, env, sessionHome, sessionId };
      controllers.set(sessionId, ctl);
      return ctl;
    })().finally(() => creating.delete(sessionId));
    creating.set(sessionId, promise);
    return promise;
  }

  const managedSessionCount = () => store.list().length;

  // ── the queue pump ────────────────────────────────────────────────────────
  // Single-flight: claimNext() promotes the oldest queued session iff the cap
  // allows (inside SQLite, so it holds across processes). A claimed session
  // starts asynchronously — readiness and delivery never block a response.
  // In-flight starts are tracked so tests (and a future drain-on-shutdown)
  // can await the quiet point: settled() resolves when no start is running.
  const inflightStarts = new Set();
  const startSessionTracked = (record, pending) => {
    const p = startSession(record, pending).finally(() => { inflightStarts.delete(p); startById.delete(record.sessionId); });
    inflightStarts.add(p);
    startById.set(record.sessionId, p);
    return p;
  };
  const settled = () => Promise.allSettled([...inflightStarts]);
  let pumping = null;
  function pump() {
    if (pumping) return pumping;
    pumping = (async () => {
      for (;;) {
        const claimed = store.claimNext();
        if (!claimed) break;
        const pending = readPendingPrompt(sessionHomePath(baseEnv, claimed.sessionId));
        const resume = existsSync(join(sessionHomePath(baseEnv, claimed.sessionId), "resume-request.json"));
        if ((!pending || pending.state !== "armed") && !resume) {
          // Fail closed on uncertain delivery: without an ARMED durable
          // prompt we cannot prove the initial prompt was never sent — never
          // blindly resend, surface the reason instead. The failed status
          // releases the cap slot, so the next queued session is tried.
          store.update(claimed.sessionId, {
            status: "failed",
            lastError: !pending
              ? "no durable initial prompt on record; delivery cannot be proven undelivered — refusing to start or resend"
              : `initial prompt already '${pending.state}'; refusing to redeliver — re-attach via POST /sessions/:id/session and deliver manually`,
          });
          continue;
        }
        void startSessionTracked(claimed, resume ? { resume: true } : pending);
      }
    })().finally(() => {
      pumping = null;
    });
    return pumping;
  }

  async function startSession(record, pending) {
    const sessionId = record.sessionId;
    try {
      const ctl = await controllerFor(sessionId);
      if (stopping.has(sessionId)) return;
      const ens = await ctl.host.ensureSession({});
      captureIdentity(record, ctl);
      if (stopping.has(sessionId)) return;
      if (!ens.ready) {
        // 'waiting' keeps the cap slot and the reason visible; an operator
        // re-issues POST /sessions/:id/session or stops the session.
        store.update(sessionId, { status: "waiting", lastError: `supervisor not ready: ${ens.reason}` });
        return;
      }
      if (pending.resume) {
        store.update(sessionId,{status:'running',lastError:null});
        // No prompt is replayed: native --continue restores only this history.
        return;
      }
      // The paste begins: from here delivery is UNCERTAIN until proven. If the
      // process dies between the mark and the proof, the state on disk says
      // so and the host never resends.
      markPendingPrompt(ctl.sessionHome, pending, { state: "delivering", deliveringAt: new Date().toISOString() });
      const sent = await ctl.host.sendMessage(pending.text);
      if (sent.status !== 200) {
        store.update(sessionId, {
          status: "waiting",
          lastError: `initial delivery failed (${sent.body?.error ?? sent.status}); prompt NOT resent — deliver manually`,
        });
        return;
      }
      markPendingPrompt(ctl.sessionHome, { ...pending, state: "delivering" }, {
        state: "delivered",
        deliveredAt: new Date().toISOString(),
      });
      // Stamp the run id from the session-scoped pointer and the pane pid.
      const runRecord = readCurrentRun({ path: join(ctl.sessionHome, "current-run.json") });
      const state = ctl.host.getState();
      const current = store.get(sessionId);
      store.update(sessionId, {
        status: "running",
        runId: runRecord?.runId ?? current?.runId ?? null,
        pid: state.panePid ?? null,
        processStartedAt: processIdentity(state.panePid).identity,
        lastError: null,
      });
    } catch (err) {
      try {
        store.update(sessionId, { status: "waiting", lastError: "start failed; capacity reserved until scoped stop or recovery" });
      } catch {
        /* store gone — nothing more we can do */
      }
    }
  }

  // Persist an OS identity, not a wall-clock approximation of process start.
  function captureIdentity(record, ctl) {
    const state = ctl.host.getState();
    const observation = processIdentity(state.panePid);
    const pointer = readCurrentRun({ path: join(ctl.sessionHome, 'current-run.json') });
    if (pointer?.taskKey && pointer.taskKey !== record.taskKey) throw Error('run owner mismatch');
    store.update(record.sessionId, { pid: state.panePid, processStartedAt: observation.identity,
      ...(pointer?.runId ? { runId: pointer.runId } : {}) });
    return observation;
  }

  async function reconcile() {
    const active = store.list({ includeTerminal: false });
    for (const rec of active) {
      if (rec.status === 'queued') continue;
      const ctl = await controllerFor(rec.sessionId);
      const state = ctl.host.getState();
      const observation = processIdentity(rec.pid);
      const same = state.panePid === rec.pid && !state.paneDead && matchesProcess(rec, observation);
      const pending = readPendingPrompt(ctl.sessionHome);
      if (same) {
        uncertain.delete(rec.sessionId);
        store.update(rec.sessionId, { status: pending?.state === 'delivered' ? 'running' : 'waiting',
          lastError: pending?.state === 'delivered' ? null : 'initial delivery UNPROVEN; NOT resent — deliver manually' });
      } else {
        // A missing pane may still leave children. Keep the claim until stop
        // proves all owned processes have ended; PID reuse is never adopted.
        uncertain.add(rec.sessionId);
        store.update(rec.sessionId, { status: 'waiting', lastError: 'process identity unproven after restart; capacity reserved; use scoped stop' });
      }
    }
    await pump();
    return active.length;
  }

  // ── stop: THIS tmux session and THIS run's children only ──────────────────
  // The live-children enumeration imports supervisor-lib lazily; the default
  // stopChild shells out to the EXISTING per-child CLI (graceful → force,
  // marks the child stopped before the kill, never cleans the worktree).
  let libRef = null;
  const loadLib = async () => {
    if (!libRef) libRef = await import("./supervisor-lib.mjs");
    return libRef;
  };

  async function stopSession(record) {
    const sessionId = record.sessionId;
    stopping.add(sessionId);
    try {
      await startById.get(sessionId);
      record = store.get(sessionId);
      if (TERMINAL_STATUSES.includes(record.status)) return { stopped: true, runId: record.runId, children: [] };
      if (record.status === 'queued') {
        store.update(sessionId, { status: 'stopped', lastError: null });
        return { stopped: true, runId: record.runId, children: [] };
      }
      const ctl = await controllerFor(sessionId);
      const state = ctl.host.getState();
      const ident = tmuxIdentity(ctl.env);
      const results = { stopped: false, tmux: null, children: [], runId: record.runId };
      if (state.session === 'absent' || state.paneDead) results.tmux = { ok: true };
      else {
        // An unknown/reused PID must not be killed merely because a record
        // still carries it. A process launched here was captured before use.
        if (!matchesProcess(record, processIdentity(state.panePid)) || record.pid !== state.panePid) {
          uncertain.add(sessionId);
          store.update(sessionId, { status: 'waiting', lastError: 'stop refused: process identity unproven; capacity remains reserved' });
          return results;
        }
        const killed = deps.stopTmux ? await deps.stopTmux(ident, ctl.env)
          : spawnSync(tmuxBin, ['-L', ident.socket, 'kill-session', '-t', ident.session], { encoding: 'utf8', env: ctl.env });
        results.tmux = { ok: killed?.status === 0 };
      }
      if (record.runId) {
        try {
          const lib = deps.lib ?? await loadLib();
          const registry = lib.readRegistry(record.runId);
          const children = Object.entries(registry.children || {}).map(([id, child]) => ({ ...child, childId: child.childId || id }));
          const liveIds = new Set(lib.liveChildren({ ...registry, children: Object.fromEntries(children.map(c => [c.childId, c])) }).map(c => c.childId));
          for (const child of children.filter(c => liveIds.has(c.childId))) {
            const result = deps.stopChild ? await deps.stopChild(record.runId, child.childId)
              : spawnSync(process.execPath, [join(HERE, 'supervisor-stop.mjs'), '--child', child.childId, '--run', record.runId], { encoding: 'utf8', env: ctl.env });
            results.children.push({ childId: child.childId, ok: result?.status === 0 });
          }
        } catch { results.registryError = 'children could not be verified stopped'; }
      }
      results.stopped = results.tmux?.ok === true && !results.registryError && results.children.every(c => c.ok);
      store.update(sessionId, { status: results.stopped ? 'stopped' : 'waiting', lastError: results.stopped ? null : 'stop incomplete; capacity remains reserved' });
      if (results.stopped) { controllers.delete(sessionId); uncertain.delete(sessionId); }
      return results;
    } finally { stopping.delete(sessionId); }
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────

  const denyUpgrade = (socket, status, text) => {
    try {
      socket.write(`HTTP/1.1 ${status} ${text}\r\n\r\n`);
    } catch {
      /* socket already gone */
    }
    socket.destroy();
  };

  // Operations that must not run against a session without a live claim.
  const opGuard = (record) => {
    if (stopping.has(record.sessionId) || uncertain.has(record.sessionId)) return { status: 409, body: { error: "session-recovery-required" } };
    if (record.status === "queued") {
      return {
        status: 409,
        body: { error: "queued", message: "the session is queued; it starts when the cap allows" },
      };
    }
    if (TERMINAL_STATUSES.includes(record.status)) {
      return {
        status: 409,
        body: { error: "session-terminal", status: record.status, message: "this generation is over; POST /sessions starts a new one" },
      };
    }
    return null;
  };

  const delegateRequest = (ctl, req, res, newPath) => {
    if (newPath !== undefined) {
      const url = new URL(req.url, "http://localhost");
      req.url = newPath + (url.search || "");
    }
    ctl.host.server.emit("request", req, res);
  };

  const validateStartPayload = (payload) => {
    for (const field of ["taskKey", "taskId", "workspace", "issueId"]) {
      if (typeof payload[field] !== "string" || !payload[field].trim()) {
        return { status: 400, body: { error: "bad-identity", message: `${field} must be a non-empty string` } };
      }
    }
    let resolved;
    try {
      resolved = resolveTaskKey({ workspace: payload.workspace, issueId: payload.issueId });
    } catch (err) {
      return { status: 400, body: { error: "bad-identity", message: err.message } };
    }
    if (payload.taskKey !== resolved) {
      return {
        status: 400,
        body: { error: "task-key-mismatch", message: `taskKey must be '${resolved}' (workspace:issueId)` },
      };
    }
    if (typeof payload.text !== "string" || !payload.text.trim()) {
      return { status: 400, body: { error: "empty", message: "text (the initial prompt) is required" } };
    }
    if (Buffer.byteLength(payload.text, "utf8") > MAX_MESSAGE_BYTES) {
      return { status: 400, body: { error: "too-long", message: `text is limited to ${MAX_MESSAGE_BYTES} bytes` } };
    }
    const title = typeof payload.title === "string" && payload.title.trim() ? payload.title : undefined;
    return {
      values: {
        taskKey: resolved,
        taskId: payload.taskId,
        workspace: payload.workspace,
        issueId: payload.issueId,
        title,
        text: payload.text,
      },
    };
  };

  const handleSessionStart = async (req, res) => {
    const { body, over } = await readBody(req);
    if (over) {
      sendJSON(res, 413, { error: "body-too-large" });
      return;
    }
    const payload = parseJSON(body);
    if (payload === null) {
      sendJSON(res, 400, { error: "bad-json" });
      return;
    }
    const checked = validateStartPayload(payload);
    if (checked.status) {
      sendJSON(res, checked.status, checked.body);
      return;
    }
    // Idempotent: ensure returns the existing active owner for the task (a
    // duplicate start lands on the SAME session) or creates a new generation.
    let record;
    try {
      record = store.ensure(checked.values);
    } catch (err) {
      // e.g. a title beyond the store's bound — identity-shaped, so 400.
      sendJSON(res, 400, { error: "bad-identity", message: err.message });
      return;
    }
    // Arm the durable initial prompt exactly once — never overwrite: a
    // duplicate open (or a racing duplicate POST) keeps the FIRST text, so the
    // initial prompt can never be delivered twice.
    const sessionHome = sessionHomePath(baseEnv, record.sessionId);
    const pending = readPendingPrompt(sessionHome);
    if (!pending) {
      armPendingPrompt(sessionHome, {
        sessionId: record.sessionId,
        taskKey: record.taskKey,
        text: checked.values.text,
        armedAt: new Date().toISOString(),
      });
    }
    await pump();
    const fresh = store.get(record.sessionId);
    // Truthful by STATUS, not by controller bookkeeping: 'starting' means the
    // coordinator claimed it and the start is in flight; 'supervisor' means
    // the session already owns a live process (nothing was redelivered).
    const delivery = fresh.status === "queued" ? "queued" : fresh.status === "starting" ? "starting" : "supervisor";
    sendJSON(res, delivery === "supervisor" ? 200 : 202, { session: fresh, delivery });
  };

  const handleSessionStop = async (res, record) => {
    const results = await stopSession(record);
    void pump();
    sendJSON(res, results.stopped ? 200 : 409, { session: store.get(record.sessionId), ...results, ...(!results.stopped ? { error: "stop-incomplete" } : {}) });
  };

  const handleSessionEnsure = async (res, record, payload) => {
    const ctl = await controllerFor(record.sessionId);
    const guard = opGuard(store.get(record.sessionId));
    if (guard) { sendJSON(res, guard.status, guard.body); return; }
    const ens = await ctl.host.ensureSession({ fresh: payload.fresh === true });
    captureIdentity(record, ctl);
    if (!ens.ready) {
      sendJSON(res, 503, { error: "starting" });
      return;
    }
    // A valid owner re-attached or restarted in THIS process. Reflect
    // liveness — unless the initial prompt is still unproven, in which case
    // 'waiting' surfaces that it was NOT resent (the operator delivers it).
    const pending = readPendingPrompt(ctl.sessionHome);
    const unproven = !pending || pending.state !== "delivered";
    const current = store.get(record.sessionId);
    if (current && !TERMINAL_STATUSES.includes(current.status)) {
      store.update(record.sessionId, {
        status: unproven ? "waiting" : "running",
        lastError: unproven ? "initial delivery unproven; the prompt was not resent — deliver manually" : null,
      });
    }
    sendJSON(res, 200, { ready: true });
  };

  const route = async (req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    } catch {
      sendJSON(res, 404, { error: "not-found" });
      return;
    }
    const method = req.method ?? "GET";
    const path = url.pathname;

    // Health: loopback only, no token, no store operation.
    if (path === "/healthz" && method === "GET") {
      if (!gate.loopback.has(req.socket?.remoteAddress ?? "")) {
        sendJSON(res, 403, { error: "forbidden-peer" });
        return;
      }
      const sessions = managedSessionCount();
      sendJSON(res, 200, sessions === 0 ? { ok: true, session: legacy.getState().session, managedSessions: 0 } : { ok: true, managedSessions: sessions });
      return;
    }

    // BOTH gates BEFORE any lookup or store operation.
    const denied = await gate.check(req);
    if (denied) {
      sendJSON(res, denied.status, denied.body);
      return;
    }

    if (path === "/alive" && method === "POST") {
      const { body, over } = await readBody(req);
      if (over) {
        sendJSON(res, 413, { error: "body-too-large" });
        return;
      }
      const payload = parseJSON(body);
      if (payload === null) {
        sendJSON(res, 400, { error: "bad-json" });
        return;
      }
      sendJSON(res, 200, legacy.alive(payload.pids));
      return;
    }

    if (path === "/sessions" && method === "GET") {
      sendJSON(res, 200, { sessions: store.list(), maxActive });
      return;
    }
    if (path === "/sessions" && method === "POST") {
      await handleSessionStart(req, res);
      return;
    }

    const sessionMatch = /^\/sessions\/([^/]+)(\/.*)?$/.exec(path);
    if (sessionMatch) {
      let sessionId;
      try { sessionId = decodeURIComponent(sessionMatch[1]); } catch { sendJSON(res, 400, { error: "bad-session-id" }); return; }
      const sub = sessionMatch[2] ?? "";
      if (!validSessionId(sessionId)) {
        sendJSON(res, 400, { error: "bad-session-id", message: `sessionId must match ${SUPERVISOR_SESSION_ID_PATTERN}` });
        return;
      }
      const record = store.get(sessionId);
      if (!record) {
        sendJSON(res, 404, { error: "unknown-session" });
        return;
      }

      if (sub === "" || sub === "/") {
        sendJSON(res, 200, { session: record });
        return;
      }
      if (sub === "/state" && method === "GET") {
        const ctl = await controllerFor(sessionId);
        sendJSON(res, 200, { ...ctl.host.getState(), taskSession: record });
        return;
      }
      if (sub === '/profile-preview' && method === 'GET') {
        const after=resolveToolProfile({squad:'supervisor',role:'lead',env:baseEnv});
        let before=null;try{before=JSON.parse(readFileSync(join(sessionHomePath(baseEnv,sessionId),'claude','snapshot.json'),'utf8'));}catch{}
        const keys=['revision','tools','mcpServers'];
        const changes=keys.filter(k=>JSON.stringify(before?.[k])!==JSON.stringify(after[k])).map(path=>({path,before:before?.[path]??null,after:after[path]}));
        sendJSON(res,200,{revision:after.revision,changes});return;
      }
      if (sub === '/resume' && method === 'POST') {
        const {body,over}=await readBody(req);if(over){sendJSON(res,413,{error:'body-too-large'});return;}
        const payload=parseJSON(body);
        if(!payload || payload.confirm!=='resume-session'){sendJSON(res,400,{error:'resume-confirmation-required'});return;}
        const currentProfile=resolveToolProfile({squad:'supervisor',role:'lead',env:baseEnv});
        if(payload.expectedRevision!==currentProfile.revision){sendJSON(res,409,{error:'profile-changed'});return;}
        if(record.status!=='stopped'){sendJSON(res,409,{error:'session-not-stopped'});return;}
        // Stop verified process death before releasing this owner; no other
        // generation can be displaced by this explicit resume transaction.
        const home=sessionHomePath(baseEnv,sessionId);mkdirSync(home,{recursive:true});
        writeFileSync(join(home,'resume-request.json'),JSON.stringify({at:new Date().toISOString(),revision:currentProfile.revision}));
        try{store.resume(sessionId);}catch{sendJSON(res,409,{error:'task-already-owned'});return;}
        await pump();sendJSON(res,202,{session:store.get(sessionId)});return;
      }
      if (sub === "/session" && method === "POST") {
        if (record.status === "queued") {
          sendJSON(res, 409, { error: "queued", message: "the session is queued; it starts when the cap allows" });
          return;
        }
        if (TERMINAL_STATUSES.includes(record.status)) {
          sendJSON(res, 409, { error: "session-terminal", status: record.status, message: "this generation is over; POST /sessions starts a new one" });
          return;
        }
        const { body, over } = await readBody(req);
        if (over) {
          sendJSON(res, 413, { error: "body-too-large" });
          return;
        }
        const payload = parseJSON(body) ?? {};
        await handleSessionEnsure(res, record, payload);
        return;
      }
      if (sub === "/stop" && method === "POST") {
        await handleSessionStop(res, record);
        return;
      }

      const guard = opGuard(record);
      if (guard) {
        sendJSON(res, guard.status, guard.body);
        return;
      }
      const ctl = await controllerFor(sessionId);
      if (sub === "/message" && method === "POST") {
        delegateRequest(ctl, req, res, "/message");
        return;
      }
      if (sub === "/ask" && method === "POST") {
        delegateRequest(ctl, req, res, "/dialog/ask");
        return;
      }
      if (sub === "/dialog" && method === "GET") {
        delegateRequest(ctl, req, res, "/dialog");
        return;
      }
      if (sub === "/dialog" && method === "POST") {
        delegateRequest(ctl, req, res, "/dialog/answer");
        return;
      }
      sendJSON(res, 404, { error: "not-found" });
      return;
    }

    // ── global legacy routes: only while NO managed session exists ──────────
    if (managedSessionCount() > 0) {
      sendJSON(res, 409, {
        error: "selection-required",
        message: "managed task sessions exist; address one explicitly: /sessions, /sessions/:id/…",
        sessions: store.list().map((s) => ({ sessionId: s.sessionId, taskKey: s.taskKey, status: s.status })),
      });
      return;
    }
    legacy.server.emit("request", req, res);
  };

  const server = createServer((req, res) => {
    route(req, res).catch(() => {
      try {
        // Raw errors never leak — a generic body only.
        sendJSON(res, 500, { error: "internal" });
      } catch {
        /* response already gone */
      }
    });
  });

  const connections = new Set();
  server.on('connection', socket => { connections.add(socket); socket.once('close', () => connections.delete(socket)); });
  const close = () => { for (const socket of connections) socket.destroy(); server.close(); };

  // ── WebSocket terminal ────────────────────────────────────────────────────
  server.on("upgrade", (req, socket, head) => {
    // FIRST statement: the client can reset this raw socket at any moment and
    // an unhandled 'error' would crash the whole multiplexer (same rule as
    // supervisor-host.mjs).
    socket.on("error", () => socket.destroy());
    let pathname;
    try {
      pathname = new URL(req.url, "http://localhost").pathname;
    } catch {
      socket.destroy();
      return;
    }
    void (async () => {
      // Gates BEFORE any lookup — the WS path enforces the same order.
      const denied = await gate.check(req);
      if (denied) {
        denyUpgrade(socket, denied.status, STATUS_TEXT[denied.status] ?? "Denied");
        return;
      }
      const sessionMatch = /^\/sessions\/([^/]+)\/terminal$/.exec(pathname);
      if (sessionMatch) {
        const sessionId = decodeURIComponent(sessionMatch[1]);
        if (!validSessionId(sessionId)) {
          denyUpgrade(socket, 400, "Bad Request");
          return;
        }
        const record = store.get(sessionId);
        if (!record) {
          denyUpgrade(socket, 404, "Not Found");
          return;
        }
        const guard = opGuard(record);
        if (guard) {
          denyUpgrade(socket, 409, "Conflict");
          return;
        }
        const ctl = await controllerFor(sessionId);
        const url = new URL(req.url, "http://localhost");
        req.url = `/terminal${url.search}`;
        ctl.host.server.emit("upgrade", req, socket, head);
        return;
      }
      if (pathname !== "/terminal") {
        socket.destroy();
        return;
      }
      if (managedSessionCount() > 0) {
        denyUpgrade(socket, 409, "Conflict");
        return;
      }
      legacy.server.emit("upgrade", req, socket, head);
    })().catch(() => {
      socket.destroy();
    });
  });

  return {
    server,
    close,
    store,
    gate,
    maxActive,
    legacy,
    controllerFor,
    pump,
    reconcile,
    stopSession,
    settled,
  };
}

// ── isolated Claude config dir (entrypoint helper) ───────────────────────────

// Seed ONLY prompt/settings/agents/skills from the global Supervisor config —
// NEVER .claude.json or projects/, which carry the native conversation history
// and project state of the shared config (a `--continue` there could
// cross-resume another task). Existing files are left untouched: resuming the
// same session keeps its history and its config.
const SEED_FILES = ["settings.json", "CLAUDE.md"];
const SEED_TREES = ["agents", "skills"];

export function seedSessionConfig(env, sessionId, opts = {}) {
  const sessionHome = sessionHomePath(env, sessionId);
  const configDir = join(sessionHome, "claude");
  if (opts.dryRun) return configDir;
  const globalDir = env.LA_SQUAD_HOME
    ? join(env.LA_SQUAD_HOME, "supervisor")
    : join(HERE, "..", "agents", "supervisor");
  mkdirSync(configDir, { recursive: true });
  for (const name of SEED_FILES) {
    const src = join(globalDir, name);
    const dest = join(configDir, name);
    if (existsSync(src) && !existsSync(dest)) copyFileSync(src, dest);
  }
  for (const name of SEED_TREES) {
    const src = join(globalDir, name);
    if (!existsSync(src)) continue;
    const dest = join(configDir, name);
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      const from = join(src, entry.name);
      const to = join(dest, entry.name);
      if (existsSync(to)) continue;
      if (entry.isDirectory()) {
        mkdirSync(to, { recursive: true });
        for (const f of readdirSync(from, { withFileTypes: true })) {
          if (f.isFile()) copyFileSync(join(from, f.name), join(to, f.name));
        }
      } else if (entry.isFile()) {
        copyFileSync(from, to);
      }
    }
  }
  return configDir;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const USAGE = [
  "Usage: node scripts/task-session-host.mjs <verb> [options]",
  "  serve                          start the session multiplexer on :7332 (writes the global host token)",
  "  session-home --session <id>    print the session's state home (validates the id)",
  "  config-dir --session <id>      create+seed the session's isolated Claude config dir; print its path",
  "  attach-target                  JSON: how `fenix attach` should attach (legacy | session | selection-required)",
].join("\n");

function parseSessionArg(rest) {
  const idx = rest.indexOf("--session");
  if (idx === -1) throw new Error("--session <id> is required");
  const id = rest[idx + 1];
  if (!id) throw new Error("--session requires a value");
  return id;
}

function attachTarget(sessionId = null) {
  const store = createTaskSessionStore({});
  const all = store.list();
  store.close();
  if (sessionId) {
    if (!validSessionId(sessionId)) throw Error("invalid session id");
    const chosen = all.find(s => s.sessionId === sessionId && OWNER_STATUSES.includes(s.status));
    if (!chosen) throw Error("unknown or terminal session");
    return { mode: "session", sessionId, taskKey: chosen.taskKey, status: chosen.status };
  }
  if (all.length === 0) return { mode: "legacy" };
  const active = all.filter((s) => OWNER_STATUSES.includes(s.status));
  if (active.length === 1) {
    return { mode: "session", sessionId: active[0].sessionId, taskKey: active[0].taskKey, status: active[0].status };
  }
  return {
    mode: "selection-required",
    message: "no single unambiguous task session to attach; pick one explicitly",
    sessions: all.map((s) => ({ sessionId: s.sessionId, taskKey: s.taskKey, status: s.status })),
  };
}

async function main(argv) {
  const [verb, ...rest] = argv;
  if (verb === "serve") {
    writeHostToken();
    const collector = createRuntimeCollector();
    await new Promise((resolve, reject) => {collector.server.once('error',reject);collector.server.listen(4318,'127.0.0.1',resolve);});
    const host = createTaskSessionHost();
    const failed = await host.reconcile();
    if (failed > 0) {
      console.error(`task-session-host: reconciled ${failed} active session(s) after restart — none re-adopted automatically`);
    }
    const bind = process.env.FENIX_HOST_BIND || "0.0.0.0";
    const port = Number.parseInt(process.env.FENIX_HOST_PORT ?? "", 10) || 7332;
    host.server.listen(port, bind, () => {
      console.log(`task-session-host listening on ${bind}:${port} (token written to host.token)`);
    });
    host.server.on("error", (err) => {
      console.error(`task-session-host: ${err.message}`);
      process.exit(1);
    });
    const shutdown = () => {
      collector.server.close();
      host.server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000).unref();
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
    return 0;
  }
  if (verb === "session-home") {
    console.log(sessionHomePath(process.env, parseSessionArg(rest)));
    return 0;
  }
  if (verb === "config-dir") {
    console.log(seedSessionConfig(process.env, parseSessionArg(rest)));
    return 0;
  }
  if (verb === "attach-target") {
    console.log(JSON.stringify(attachTarget(rest.includes("--session") ? parseSessionArg(rest) : null)));
    return 0;
  }
  console.error(USAGE);
  return 2;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (err) {
    console.error(`task-session-host: ${err.message}`);
    process.exit(1);
  }
}
