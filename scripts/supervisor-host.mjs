#!/usr/bin/env node
// scripts/supervisor-host.mjs — owns the Supervisor's tmux session and serves
// the dashboard API container (FOC-783, plan §1).
//
// The Supervisor runs ONCE, inside a tmux session in the fenix-supervisor
// container; every view (fenix attach, the dashboard Terminal over a
// WebSocket, the dashboard Chat by pasting into the same pane) attaches to
// that one process. This host starts it, reports its state, delivers chat
// messages into it, answers its on-screen dialogs (FOC-810: permission
// prompts, AskUserQuestion, select nudges) and proxies raw terminal bytes
// to the dashboard.
//
// SECURITY MODEL — two gates on every non-healthz request, both fail closed:
//   1. PEER: the client's address (after stripping the ::ffff: IPv4-mapped
//      prefix) must be an address the compose DNS name FENIX_HOST_PEER
//      (fenix-api) resolves to — only the API container may call in. Children
//      of the Supervisor share this container, so loopback/the container's own
//      address is intentionally NOT in the set for actions.
//   2. TOKEN: the x-fenix-host-token header must equal the content of
//      <dataHome>/run/host.token (fenix-paths.mjs hostTokenPath), rewritten at
//      every host start; the API re-reads it per request because a supervisor
//      restart rotates it. Comparison is timing-safe.
// GET /healthz is the one exception: loopback peers only, no token, no side
// effects — it exists for the compose healthcheck. The port is compose-network
// only (not published), so "the Linux host cannot reach it without the token"
// holds; these two gates are defense in depth, not the only wall.
//
// Everything external is a seam (runTmux, readSessionState, readToken,
// resolvePeer, ptyFactory, processAlive, sleep, now) so tests can drive the
// whole surface without tmux, a pty or the network.

import { spawnSync } from "node:child_process";
import { timingSafeEqual, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import dns from "node:dns";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

import { hostTokenPath, supervisorSessionHome, supervisorSessionPath, SUPERVISOR_SESSION_ID_PATTERN } from "./fenix-paths.mjs";
import { readProcessIdentity, matchesProcess } from "./task-process-identity.mjs";
import { processAlive as defaultProcessAlive } from "./supervisor-lib.mjs";
import { askKeyPlan, extractCommandOutput, parseDialog, slashCommandPolicy } from "./session-dialog.mjs";

// Legacy single-session identity — the module constants keep their exact
// values so every existing deployment, test and note stays byte-identical. A
// managed task session (PRD task-workspace-supervisors §5) derives its own
// per-session identity from FENIX_SUPERVISOR_SESSION_ID via tmuxIdentity()
// below; the derived values are only used INSIDE a createHost whose env
// carries a validated session id.
export const TMUX_SOCKET = "fenix";
export const TMUX_SESSION = "supervisor";
export const CHAT_BUFFER = "fenix-chat";

/**
 * The tmux identity a host uses, derived from env. Unscoped (no
 * FENIX_SUPERVISOR_SESSION_ID) this is exactly the legacy triple above. With a
 * session id each managed session gets its OWN tmux server socket and session
 * name (so `fenix attach` of task A can never land on task B's pane) and its
 * own chat paste buffer. A set-but-invalid id throws — fail closed, never
 * compose tmux names from unbounded data.
 */
export function tmuxIdentity(env = process.env) {
  const sessionId = env.FENIX_SUPERVISOR_SESSION_ID;
  if (!sessionId) {
    return { sessionId: null, scoped: false, socket: TMUX_SOCKET, session: TMUX_SESSION, chatBuffer: CHAT_BUFFER };
  }
  if (!SUPERVISOR_SESSION_ID_PATTERN.test(sessionId)) {
    throw new TypeError(
      `FENIX_SUPERVISOR_SESSION_ID must match ${SUPERVISOR_SESSION_ID_PATTERN} — refusing to derive tmux names from '${sessionId}'`,
    );
  }
  return {
    sessionId,
    scoped: true,
    socket: `fenix-${sessionId}`,
    session: sessionId,
    chatBuffer: `${sessionId}-chat`,
  };
}
export const MAX_MESSAGE_BYTES = 8192;
export const BODY_CAP_BYTES = 16 * 1024;
export const READINESS_TIMEOUT_MS = 30_000;
export const CONFIRM_TIMEOUT_MS = 5_000;
// How long a single message may wait for a free input line before refusing.
export const SEND_READY_TIMEOUT_MS = 3_000;
// Dialog answering (FOC-810): the pane re-capture cadence while waiting for a
// dialog to close, and the caps for the close wait, the ask flow's settle
// wait and the slash-command output wait.
export const DIALOG_POLL_MS = 250;
export const DIALOG_CLOSE_TIMEOUT_MS = 3_000;
export const ASK_CLOSE_TIMEOUT_MS = 3_000;
export const SLASH_OUTPUT_TIMEOUT_MS = 4_000;
// The ask flow's settle window: the TUI redraws asynchronously after a
// step's keys, so a step's expectation is re-polled at this interval for up
// to the window before the drift counts as a change (the acceptance stack
// reproduced a 409 from a capture ~150 ms after the step-0 key).
export const ASK_SETTLE_TIMEOUT_MS = 2_000;
export const ASK_SETTLE_POLL_MS = 150;
// Scrollback depth for command-output extraction (capture-pane -S).
export const SCROLLBACK_LINES = 200;
// A denial note pasted back into the chat after the dialog closes.
export const MAX_NOTE_CHARS = 4000;
// Bounds for the terminal size, from the query string and resize frames.
export const COLS_MIN = 20, COLS_MAX = 500, ROWS_MIN = 5, ROWS_MAX = 200;
export const DEFAULT_COLS = 120, DEFAULT_ROWS = 40;
// WebSocket terminal guards: how much unread output may sit buffered for a
// client before it is judged too slow, and the ping/pong heartbeat interval.
export const WS_MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
export const WS_HEARTBEAT_INTERVAL_MS = 30_000;

const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g; // keeps \t (\u0009) and \n (\u000A)

const clampInt = (value, min, max, fallback) => {
  const n = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const tokensEqual = (provided, expected) => {
  if (typeof provided !== "string" || provided === "") return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
};

const stripV6Prefix = (address) => String(address ?? "").replace(/^::ffff:/, "");

// Whitespace-normalised comparison of ask questions (the pane wraps lines
// the transcript keeps on one).
const normalizeSpace = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/**
 * The two gates — PEER (only the API container may call in) and TOKEN (fresh,
 * re-read per request) — shared by the single-session host and the
 * task-session multiplexer, so both enforce the identical gate order
 * (peer 403 → missing token file 503 → wrong token 401) and both fail closed.
 * check(req) returns null when the request may proceed, else {status, body}.
 */
export function createGatekeeper(deps = {}) {
  const env = deps.env ?? process.env;
  const peerName = env.FENIX_HOST_PEER || "fenix-api";

  const readToken = deps.readToken ?? (() => {
    try {
      return readFileSync(hostTokenPath(env), "utf8").trim() || null;
    } catch {
      return null;
    }
  });

  // DNS of the API container, cached briefly (10 s); an unreachable DNS means
  // an EMPTY set — fail closed, never "let everyone in because lookup failed".
  const PEER_CACHE_MS = 10_000;
  let peerCache = { at: -Infinity, set: new Set() };
  const resolvePeer = deps.resolvePeer ?? (async () => {
    const t = Date.now();
    if (t - peerCache.at < PEER_CACHE_MS) return peerCache.set;
    try {
      const all = await dns.promises.lookup(peerName, { all: true });
      peerCache = { at: t, set: new Set(all.map((a) => a.address)) };
    } catch {
      peerCache = { at: t, set: new Set() };
    }
    return peerCache.set;
  });

  const check = async (req) => {
    const address = req.socket?.remoteAddress ?? "";
    if (!(await resolvePeer()).has(stripV6Prefix(address))) {
      return { status: 403, body: { error: "forbidden-peer" } };
    }
    const token = readToken();
    if (token === null) return { status: 503, body: { error: "no-token" } };
    if (!tokensEqual(req.headers["x-fenix-host-token"], token)) {
      return { status: 401, body: { error: "unauthorized" } };
    }
    return null;
  };

  return {
    check,
    resolvePeer,
    readToken,
    loopback: LOOPBACK,
  };
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

// Shared JSON plumbing (exported for the task-session multiplexer so both
// servers answer with identical shapes).
export const sendJSON = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

export const readBody = (req) => new Promise((resolve) => {
  const chunks = [];
  let size = 0;
  let over = false;
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > BODY_CAP_BYTES) {
      over = true;
      chunks.length = 0;
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => resolve({ body: Buffer.concat(chunks).toString("utf8"), over }));
  req.on("error", () => resolve({ body: "", over }));
});

export const parseJSON = (raw) => {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/**
 * Build the host. Every dep is optional; the defaults are the real thing.
 * Returns { server, ensureSession, sendMessage, getState, alive,
 * answerDialog, answerAsk } — the server is NOT listening; `serve` (CLI) or
 * a test binds it.
 */
export function createHost(deps = {}) {
  const env = deps.env ?? process.env;
  const port = Number.parseInt(env.FENIX_HOST_PORT ?? "", 10) || 7332;
  const bind = env.FENIX_HOST_BIND || "0.0.0.0";
  const tmux = tmuxIdentity(env);
  const tmuxBin = env.LA_TMUX_BIN || "tmux";
  const startCmd = (env.FENIX_SUPERVISOR_CMD || "/opt/fenix/docker/entrypoint.sh supervisor-run")
    .split(" ")
    .filter(Boolean);

  const runTmux = deps.runTmux ?? ((args, opts = {}) =>
    spawnSync(tmuxBin, ["-L", tmux.socket, ...args], { encoding: "utf8", input: opts.input, env }));

  const readSessionState = deps.readSessionState ?? (() => {
    try {
      return JSON.parse(readFileSync(supervisorSessionPath(env), "utf8"));
    } catch {
      return null;
    }
  });

  // One gate per host: peer + fresh token (createGatekeeper above). The
  // multiplexer may inject its own via deps.gate so the front door and the
  // controllers share one DNS cache and one token reader; readToken and
  // resolvePeer stay exposed here because the WS upgrade path calls them.
  const gate = deps.gate ?? createGatekeeper({ env, readToken: deps.readToken, resolvePeer: deps.resolvePeer });
  const readToken = gate.readToken;
  const resolvePeer = gate.resolvePeer;

  const ptyFactory = deps.ptyFactory ?? (async (file, args, opts) => {
    const { spawn: ptySpawn } = await import("node-pty");
    return ptySpawn(file, args, opts);
  });

  const processAlive = deps.processAlive ?? defaultProcessAlive;
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => Date.now());
  const wsMaxBufferedBytes = deps.wsMaxBufferedBytes ?? WS_MAX_BUFFERED_BYTES;
  const wsHeartbeatIntervalMs = deps.wsHeartbeatIntervalMs ?? WS_HEARTBEAT_INTERVAL_MS;

  // ── the pane is the second source of truth ────────────────────────────────
  // session.json can lag or lie: an Esc-cancelled turn never fires the Stop
  // hook (the file stays "needs-input" forever), and the SessionStart write
  // lands before the TUI accepts input. The visible pane cannot lie, so
  // dialog detection and prompt readiness read it and the hook file only
  // fills the gaps. ok=false means the pane itself is unreadable — callers
  // then fall back to the hook alone.
  const DIALOG_RE = /Do you want to proceed\?|Esc to cancel|^\s*❯\s*1\.\s/m;
  const PROMPT_LINE_RE = /^(?:❯|>)\s*$/;
  const RULE_LINE_RE = /^─{3,}$/;

  const paneState = () => {
    const cap = runTmux(["capture-pane", "-p", "-t", tmux.session]);
    if (cap.status !== 0) return { ok: false, dialog: false, promptReady: false };
    const text = cap.stdout ?? "";
    // parseDialog first: any parsed dialog — permission, ask, ask-review,
    // select (the auto-mode nudge) — counts. DIALOG_RE stays as the fallback
    // for markers the parser does not frame with a bottom rule (the /cost
    // modal's "Esc to cancel").
    const dialog = parseDialog(text) !== null || DIALOG_RE.test(text);
    if (dialog) return { ok: true, dialog: true, promptReady: false };
    const lines = text.split("\n");
    const promptReady = lines.some((line, i) =>
      i > 0 && PROMPT_LINE_RE.test(line) && RULE_LINE_RE.test(lines[i - 1].trim()));
    return { ok: true, dialog: false, promptReady };
  };

  // ── serialization: one promise chain shared by ensureSession + sendMessage ──
  // ensureSession and sendMessage are NOT re-entrant through this chain (the
  // sendMessage body calls the LOCKED ensure directly); a public call from
  // inside a locked body would enqueue behind itself and deadlock.
  let chain = Promise.resolve();
  const serialized = (fn) => {
    const p = chain.then(fn, fn);
    chain = p.then(() => {}, () => {});
    return p;
  };

  const ensureLocked = async ({ fresh = false } = {}) => {
    const present = runTmux(["has-session", "-t", tmux.session]).status === 0;
    if (present && !fresh) return { ready: true };
    if (present && fresh) {
      const killed = runTmux(["kill-session", "-t", tmux.session]);
      if (killed.status !== 0) {
        return { ready: false, reason: "kill-failed", detail: (killed.stderr || "").trim() };
      }
    }
    // ONE tmux invocation: server options and the new session, semicolon-chained.
    // A managed session's pane MUST see its task identity — the entrypoint's
    // supervisor-run branch keys on FENIX_SUPERVISOR_SESSION_ID to pick the
    // isolated config dir, and the waker/telemetry hooks key on LA_TASK_*.
    // The env is stamped into the SERVER's global environment (this tmux
    // invocation created the server, so its global env is the pane's
    // inheritance) — the host process's own process.env is never mutated.
    const paneEnvArgs = tmux.scoped
      ? [
          "set-environment", "-g", "FENIX_SUPERVISOR_SESSION_ID", tmux.sessionId, ";",
          "set-environment", "-g", "LA_TASK_KEY", env.LA_TASK_KEY ?? "", ";",
          "set-environment", "-g", "LA_TASK_ID", env.LA_TASK_ID ?? "", ";",
          "set-environment", "-g", "LA_SUPERVISOR_SESSION_HOME", env.LA_SUPERVISOR_SESSION_HOME ?? "", ";",
        ]
      : [];
    const cmd = fresh ? [...startCmd, "--new"] : startCmd;
    const started = runTmux([
      "start-server", ";",
      ...paneEnvArgs,
      "set-option", "-g", "history-limit", "50000", ";",
      "set-option", "-g", "default-size", "200x50", ";",
      "set-option", "-g", "window-size", "latest", ";",
      "set-option", "-g", "focus-events", "on", ";",
      "new-session", "-d", "-s", tmux.session, "-x", "200", "-y", "50",
      ...cmd,
    ]);
    if (started.status !== 0) {
      // Another ensure (fenix attach's) may have won the race: it created the
      // session between our probe and our start, tmux failed with "duplicate
      // session", and the session NOW exists — re-probe and continue to
      // readiness instead of failing.
      const detail = (started.stderr || "").trim();
      const lostRace = /duplicate session/i.test(detail)
        && runTmux(["has-session", "-t", tmux.session]).status === 0;
      if (!lostRace) {
        return { ready: false, reason: "start-failed", detail };
      }
    }
    // Ready when the PANE shows a free input prompt on TWO consecutive polls
    // (250 ms apart) — the visible prompt is the only proof that cannot lie:
    // a restart with `claude --continue` reuses the session, so the SessionStart
    // hook may write nothing new at all, and a user's settings.json without the
    // hook would never write. The hook file is still read, but only to VETO:
    // a fresh (post-start) "ended" write is a dying session's SessionEnd and
    // never counts as ready.
    const startedAt = now();
    const deadline = startedAt + READINESS_TIMEOUT_MS;
    let confirmed = false;
    let readyStreak = 0;
    while (now() < deadline) {
      await sleep(250);
      const s = readSessionState();
      const at = Date.parse(s?.updatedAt ?? "");
      if (Number.isFinite(at) && at >= startedAt && s.state === "ended") {
        readyStreak = 0;
        continue;
      }
      readyStreak = paneState().promptReady ? readyStreak + 1 : 0;
      if (readyStreak >= 2) {
        confirmed = true;
        break;
      }
    }
    if (!confirmed) return { ready: false, reason: "starting" };
    await sleep(300); // let the TUI itself settle before the first paste
    return { ready: true };
  };

  const ensureSession = (opts = {}) => serialized(() => ensureLocked(opts));

  const getState = () => {
    const panes = runTmux(["list-panes", "-t", tmux.session, "-F", "#{pane_pid} #{pane_dead}"]);
    const hook = readSessionState();
    if (panes.status !== 0) {
      // A dead or missing pane means "absent" whatever session.json says (no
      // SessionEnd after a kill or OOM) — the hook file is never trusted alone.
      return {
        session: "absent", panePid: null, paneDead: null, clients: [], hook,
        dialog: false, promptReady: false, state: "absent",
      };
    }
    const first = (panes.stdout || "").split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? "";
    const [pidStr, deadStr] = first.split(/\s+/);
    const panePid = /^\d+$/.test(pidStr ?? "") ? Number(pidStr) : null;
    const paneDead = deadStr === "1";
    const clients = runTmux(["list-clients", "-t", tmux.session, "-F", "#{client_name}"]);
    const clientList = clients.status === 0
      ? (clients.stdout || "").split("\n").map((l) => l.trim()).filter(Boolean)
      : [];
    // The pane is captured only while it is alive — a dead pane shows nothing,
    // and the pane outranks the hook file for the effective state: a dialog on
    // screen is "needs-input" even when the hook missed it, and a hook
    // "needs-input" beside an empty prompt is a stale leftover (an
    // Esc-cancelled turn never fires Stop) — read as idle.
    const pane = paneDead ? { dialog: false, promptReady: false } : paneState();
    let state;
    if (paneDead) state = "absent";
    else if (pane.dialog) state = "needs-input";
    else if (hook?.state === "needs-input" && pane.promptReady) state = "idle";
    else state = hook?.state ?? "unknown";
    return {
      session: "running", panePid, paneDead, clients: clientList, hook,
      dialog: pane.dialog, promptReady: pane.promptReady, state,
    };
  };

  const fail500 = (step, result) => ({
    status: 500,
    body: { error: "tmux", detail: (result.stderr || "").trim() || `${step} failed` },
  });

  const pressKey = (key) => runTmux(["send-keys", "-t", tmux.session, key]);

  const pressLiteral = (text) => runTmux(["send-keys", "-l", "-t", tmux.session, text]);

  // Scrollback capture for command-output extraction; null when unreadable.
  const captureScrollback = () => {
    const cap = runTmux(["capture-pane", "-p", "-S", `-${SCROLLBACK_LINES}`, "-t", tmux.session]);
    return cap.status === 0 ? (cap.stdout ?? "") : null;
  };

  // THE delivery path — one implementation, shared by chat messages and
  // dialog notes: load the buffer, bracketed paste, settle, Enter. Returns
  // the 500 response of the first failed tmux step, or null on success.
  const pasteAndEnter = async (text) => {
    const load = runTmux(["load-buffer", "-b", tmux.chatBuffer, "-"], { input: text });
    if (load.status !== 0) return fail500("load-buffer", load);
    const paste = runTmux(["paste-buffer", "-p", "-d", "-b", tmux.chatBuffer, "-t", tmux.session]);
    if (paste.status !== 0) return fail500("paste-buffer", paste);
    await sleep(200); // let the paste land before Enter
    const keys = runTmux(["send-keys", "-t", tmux.session, "Enter"]);
    if (keys.status !== 0) return fail500("send-keys", keys);
    return null;
  };

  // Poll the pane until the input line is free: "ready", "dialog" (a dialog
  // appeared — the caller turns it into its 409) or "timeout". The busy
  // shortcut (queueing behind a running turn without waiting) stays with the
  // callers, which consult the hook state themselves.
  const awaitPromptReady = async (timeoutMs) => {
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      await sleep(250);
      const p = paneState();
      if (p.dialog) return "dialog";
      if (p.promptReady) return "ready";
    }
    return "timeout";
  };

  const sendLocked = async (text) => {
    if (typeof text !== "string" || !text.trim()) return { status: 400, body: { error: "empty" } };
    const cleaned = text.replace(/\r/g, "").replace(CONTROL_CHARS, "");
    if (Buffer.byteLength(cleaned, "utf8") > MAX_MESSAGE_BYTES) {
      return { status: 400, body: { error: "too-long" } };
    }
    // Slash commands are gated by the policy (FOC-810): /compact, /context
    // and /cost may be typed from the chat and go through the normal send
    // path below; anything else is refused with the canonical reason.
    let slash = null;
    if (cleaned.trimStart().startsWith("/")) {
      const policy = slashCommandPolicy(cleaned.trim());
      if (!policy.allowed) {
        return { status: 400, body: { error: "slash-command", message: policy.reason } };
      }
      slash = policy;
    }
    const ens = await ensureLocked({});
    if (!ens.ready) return { status: 503, body: { error: "starting" } };
    // The pane outranks session.json, read AFTER ensure — a stale file left by
    // a killed or previous session must never block chat. A dialog on screen
    // refuses keystrokes whatever the hook says (they would answer it); a
    // hook "needs-input" beside an empty prompt is a stale leftover (an
    // Esc-cancelled turn never fires Stop) and is read as idle; an unreadable
    // pane leaves the decision to the hook alone, as before.
    const hook = readSessionState();
    const pane = paneState();
    if (pane.dialog || (hook?.state === "needs-input" && !pane.ok)) {
      return { status: 409, body: { error: "needs-input", notification: hook?.notification ?? null } };
    }
    if (!pane.promptReady && hook?.state !== "busy") {
      // No empty prompt and no running turn to queue behind: the TUI may be
      // booting or mid-render. Give it a moment, then refuse rather than
      // paste into whatever else the screen is showing.
      const wait = await awaitPromptReady(SEND_READY_TIMEOUT_MS);
      if (wait === "dialog") {
        return { status: 409, body: { error: "needs-input", notification: hook?.notification ?? null } };
      }
      if (wait === "timeout") {
        return { status: 503, body: { error: "not-ready", detail: "the Supervisor's input is not ready" } };
      }
    }

    const stateBefore = readSessionState()?.state ?? null;
    const sendAt = now();
    const pasteErr = await pasteAndEnter(cleaned);
    if (pasteErr) return pasteErr;

    if (slash && slash.command !== "/compact") {
      // /context and /cost are local: they never fire a hook write, so the
      // rendered output on screen IS the confirmation. Poll the scrollback
      // for it; a modal command (/cost opens a panel) is closed with Esc
      // once the output has been read.
      let output = "";
      const outDeadline = now() + SLASH_OUTPUT_TIMEOUT_MS;
      while (now() < outDeadline) {
        await sleep(DIALOG_POLL_MS);
        const scroll = captureScrollback();
        if (scroll !== null) {
          output = extractCommandOutput(scroll, slash.command);
          if (output) break;
        }
      }
      if (slash.modal) {
        const esc = pressKey("Escape");
        if (esc.status !== 0) return fail500("send-keys", esc);
      }
      return { status: 200, body: { sent: true, confirmed: Boolean(output), queued: false, output } };
    }

    // Proof, not hope: any hook write AFTER the send, in a state that means
    // the prompt was taken — busy (a turn started), idle (it finished) or
    // needs-input (it asked for permission). A fast turn can start AND end
    // between two polls, so requiring "busy" specifically misses it.
    let confirmed = false;
    const deadline = now() + CONFIRM_TIMEOUT_MS;
    while (now() < deadline) {
      await sleep(250);
      const s = readSessionState();
      const at = Date.parse(s?.updatedAt ?? "");
      if (Number.isFinite(at) && at > sendAt
        && (s.state === "busy" || s.state === "idle" || s.state === "needs-input")) {
        confirmed = true;
        break;
      }
    }
    const queued = !confirmed && stateBefore === "busy";
    return { status: 200, body: { sent: true, confirmed, queued } };
  };

  const sendMessage = (text) => serialized(() => sendLocked(text));

  // ── dialog answering (FOC-810) ────────────────────────────────────────────
  // Both flows run under the send mutex — an answer must never interleave
  // with a chat paste fighting over the same prompt.

  const ANSWER_CHOICES = new Set(["allow-once", "allow-always", "deny"]);
  const BAD_CHOICE_MESSAGE = "choice must be one of allow-once, allow-always, deny";

  const answerDialogLocked = async ({ id, choice, note }) => {
    if (!ANSWER_CHOICES.has(choice)) {
      return { status: 400, body: { error: "bad-choice", message: BAD_CHOICE_MESSAGE } };
    }
    // A note is only ever delivered after a deny; validate it up front so a
    // bad note never leaves a half-answered dialog behind.
    let cleanedNote = "";
    if (typeof note === "string" && note.trim()) {
      cleanedNote = note.replace(/\r/g, "").replace(CONTROL_CHARS, "").trim();
      if (cleanedNote.length > MAX_NOTE_CHARS) {
        return {
          status: 400,
          body: { error: "bad-note", message: `note is limited to ${MAX_NOTE_CHARS} characters` },
        };
      }
    }

    const cap = runTmux(["capture-pane", "-p", "-t", tmux.session]);
    if (cap.status !== 0) return { status: 503, body: { error: "pane-unreadable" } };
    const dialog = parseDialog(cap.stdout ?? "");
    if (!dialog) return { status: 409, body: { error: "no-dialog" } };
    if (dialog.id !== id) return { status: 409, body: { error: "dialog-changed" } };

    let key;
    if (choice === "deny") {
      if (dialog.kind !== "permission" && dialog.kind !== "select") {
        return {
          status: 400,
          body: { error: "bad-choice", message: `deny applies to permission and select dialogs, not ${dialog.kind}` },
        };
      }
      key = "Escape";
    } else {
      if (dialog.kind !== "permission") {
        return {
          status: 400,
          body: { error: "bad-choice", message: `${choice} applies to permission dialogs only` },
        };
      }
      // Only an option that carries the exact choice is pressed — an
      // auto-mode option (choice "auto-mode") can never match an allow-*.
      const option = dialog.options.find((o) => o.choice === choice);
      if (!option || typeof option.key !== "string") {
        return {
          status: 400,
          body: { error: "bad-choice", message: `no option offers ${choice}` },
        };
      }
      key = option.key;
    }

    const pressed = pressKey(key);
    if (pressed.status !== 0) return fail500("send-keys", pressed);

    // Closed when the dialog is gone — or when a DIFFERENT dialog replaced
    // it (the original one left the screen either way).
    let closed = false;
    const deadline = now() + DIALOG_CLOSE_TIMEOUT_MS;
    while (now() < deadline) {
      await sleep(DIALOG_POLL_MS);
      const poll = runTmux(["capture-pane", "-p", "-t", tmux.session]);
      const d = poll.status === 0 ? parseDialog(poll.stdout ?? "") : null;
      if (!d || d.id !== id) {
        closed = true;
        break;
      }
    }

    const body = { sent: true, closed };
    if (choice === "deny" && cleanedNote) {
      // Deliver the note like a chat message once the prompt is back — the
      // shared paste path, not a second implementation. A dialog that shows
      // up instead, or a prompt that never returns, is reported honestly.
      let noteSent = false;
      if ((await awaitPromptReady(SEND_READY_TIMEOUT_MS)) === "ready") {
        const pasteErr = await pasteAndEnter(cleanedNote);
        if (pasteErr) return pasteErr;
        noteSent = true;
      }
      body.noteSent = noteSent;
    }
    return { status: 200, body };
  };

  const answerDialog = (payload) => serialized(() => answerDialogLocked(payload ?? {}));

  const answerAskLocked = async ({ questions, answers }) => {
    let steps;
    try {
      steps = askKeyPlan(questions, answers);
    } catch (err) {
      return { status: 400, body: { error: "bad-answers", message: err.message } };
    }
    const questionList = Array.isArray(questions) ? questions : [];

    const capturePane = () => {
      const cap = runTmux(["capture-pane", "-p", "-t", tmux.session]);
      if (cap.status !== 0) return { unreadable: true };
      return { dialog: parseDialog(cap.stdout ?? "") };
    };

    // Does the dialog satisfy step i's expectation — the ask dialog with
    // question i, or the review screen?
    const matchesStep = (dialog, i) => {
      if (!dialog) return false;
      const step = steps[i];
      if (step.expectQuestion) {
        return dialog.kind === "ask"
          && normalizeSpace(dialog.question) === normalizeSpace(questionList[i]?.question);
      }
      return !!step.expectReview && dialog.kind === "ask-review";
    };

    // Where in THIS ask's plan does the pane sit (first capture only)? A
    // later question j (with tabs 0..j-1 all marked done — proof the earlier
    // answers were applied, not just re-asked) or the review screen. -1 when
    // the pane matches nothing in the plan.
    const resumeStep = (dialog) => {
      if (!dialog) return -1;
      if (dialog.kind === "ask-review") {
        const last = steps.length - 1;
        return steps[last]?.expectReview ? last : -1;
      }
      if (dialog.kind !== "ask") return -1;
      const wanted = normalizeSpace(dialog.question);
      const tabs = Array.isArray(dialog.tabs) ? dialog.tabs : [];
      for (let j = 1; j < questionList.length; j++) {
        if (normalizeSpace(questionList[j]?.question) !== wanted) continue;
        let earlierDone = true;
        for (let t = 0; t < j; t++) {
          if (!tabs[t]?.done) {
            earlierDone = false;
            break;
          }
        }
        if (earlierDone) return j;
      }
      return -1;
    };

    // Re-capture before EVERY step: a question step must show the ask dialog
    // with the expected question, the review step the review screen. The TUI
    // redraws asynchronously after the previous step's keys, so a mismatch
    // is re-polled for up to ASK_SETTLE_TIMEOUT_MS before it counts as a
    // change (an immediate capture raced the redraw and 409'd a healthy
    // flow on the acceptance stack). The FIRST capture may also land on a
    // LATER step of this same ask — a retried answer whose earlier steps
    // were already applied: the plan resumes there and the result says so
    // (resumedFrom). A pane that matches nothing in the plan is a different
    // ask → 409 as before.
    let start = 0;
    let settled = null; // the dialog the settle phase already matched for step `start`
    {
      const deadline = now() + ASK_SETTLE_TIMEOUT_MS;
      for (;;) {
        const cap = capturePane();
        if (cap.unreadable) return { status: 503, body: { error: "pane-unreadable" } };
        if (matchesStep(cap.dialog, 0)) {
          settled = cap.dialog;
          break;
        }
        const resume = resumeStep(cap.dialog);
        if (resume > 0) {
          start = resume;
          settled = cap.dialog;
          break;
        }
        if (now() >= deadline) {
          return { status: 409, body: { error: "dialog-changed", step: 0 } };
        }
        await sleep(ASK_SETTLE_POLL_MS);
      }
    }

    for (let i = start; i < steps.length; i++) {
      const step = steps[i];
      if (!(i === start && settled)) {
        // The settle phase already verified step `start` — a fresh capture
        // there would only race the redraw it just settled.
        const deadline = now() + ASK_SETTLE_TIMEOUT_MS;
        for (;;) {
          const cap = capturePane();
          if (cap.unreadable) return { status: 503, body: { error: "pane-unreadable" } };
          if (matchesStep(cap.dialog, i)) break;
          if (now() >= deadline) {
            // Mid-flow drift that outlived the window: the steps before i
            // already pressed keys (and a resume means earlier answers were
            // applied too) — the 409 says so (partial). Nothing automatic is
            // pressed afterwards (no Escape); the human looks at the pane.
            return {
              status: 409,
              body: { error: "dialog-changed", step: i, partial: i > start || start > 0 },
            };
          }
          await sleep(ASK_SETTLE_POLL_MS);
        }
      }
      settled = null;
      for (let k = 0; k < step.keys.length; k++) {
        if (k > 0) await sleep(150);
        const pressed = pressKey(step.keys[k]);
        if (pressed.status !== 0) return fail500("send-keys", pressed);
      }
      if (step.literal !== undefined) {
        await sleep(150);
        const typed = pressLiteral(step.literal);
        if (typed.status !== 0) return fail500("send-keys", typed);
      }
      for (const key of step.after ?? []) {
        await sleep(150);
        const pressed = pressKey(key);
        if (pressed.status !== 0) return fail500("send-keys", pressed);
      }
    }

    // Done when the pane no longer shows an ask dialog (the TUI moved on —
    // idle, the turn running, or a different kind of dialog entirely).
    let answered = false;
    const deadline = now() + ASK_CLOSE_TIMEOUT_MS;
    while (now() < deadline) {
      await sleep(DIALOG_POLL_MS);
      const poll = capturePane();
      const d = poll.unreadable ? null : poll.dialog;
      if (!d || (d.kind !== "ask" && d.kind !== "ask-review")) {
        answered = true;
        break;
      }
    }
    return start > 0
      ? { status: 200, body: { answered, resumedFrom: start } }
      : { status: 200, body: { answered } };
  };

  const answerAsk = (payload) => serialized(() => answerAskLocked(payload ?? {}));

  const alive = (pids) => {
    const out = {};
    if (!Array.isArray(pids)) return out;
    const valid = pids.filter((p) => Number.isInteger(p) && p > 0).slice(0, 200);
    for (const pid of valid) out[pid] = processAlive(pid);
    return out;
  };

  // ── HTTP ──────────────────────────────────────────────────────────────────
  // sendJSON / readBody / parseJSON and the two gates live at module level
  // (createGatekeeper above) so the task-session multiplexer serves exactly
  // the same shapes and gate order; only the gate ANSWER is wrapped here.
  const gatekeeper = async (req, res) => {
    const denied = await gate.check(req);
    if (denied) {
      sendJSON(res, denied.status, denied.body);
      return false;
    }
    return true;
  };

  const handleRequest = async (req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    } catch {
      sendJSON(res, 404, { error: "not-found" });
      return;
    }
    const method = req.method ?? "GET";
    const path = url.pathname;

    if (path === "/healthz" && method === "GET") {
      if (!LOOPBACK.has(req.socket?.remoteAddress ?? "")) {
        sendJSON(res, 403, { error: "forbidden-peer" });
        return;
      }
      sendJSON(res, 200, { ok: true, session: getState().session });
      return;
    }

    if (!(await gatekeeper(req, res))) return;

    if (path === "/state" && method === "GET") {
      sendJSON(res, 200, getState());
      return;
    }
    if (path === "/session" && method === "POST") {
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
      const result = await ensureSession({ fresh: payload.fresh === true });
      if (result.ready) sendJSON(res, 200, { ready: true });
      else sendJSON(res, 503, { error: "starting" });
      return;
    }
    if (path === "/message" && method === "POST") {
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
      const result = await sendMessage(payload.text);
      sendJSON(res, result.status, result.body);
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
      sendJSON(res, 200, alive(payload.pids));
      return;
    }
    if (path === "/dialog" && method === "GET") {
      const cap = runTmux(["capture-pane", "-p", "-t", tmux.session]);
      if (cap.status !== 0) {
        sendJSON(res, 503, { error: "pane-unreadable" });
        return;
      }
      sendJSON(res, 200, { dialog: parseDialog(cap.stdout ?? "") });
      return;
    }
    if (path === "/dialog/answer" && method === "POST") {
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
      const result = await answerDialog(payload);
      sendJSON(res, result.status, result.body);
      return;
    }
    if (path === "/dialog/ask" && method === "POST") {
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
      const result = await answerAsk(payload);
      sendJSON(res, result.status, result.body);
      return;
    }
    sendJSON(res, 404, { error: "not-found" });
  };

  const server = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      try {
        sendJSON(res, 500, { error: "internal", detail: err.message });
      } catch {
        /* response already gone */
      }
    });
  });

  // ── WebSocket terminal ────────────────────────────────────────────────────
  const wss = new WebSocketServer({ noServer: true });

  const denyUpgrade = (socket, status, text) => {
    try {
      socket.write(`HTTP/1.1 ${status} ${text}\r\n\r\n`);
    } catch {
      /* socket already gone */
    }
    socket.destroy();
  };

  server.on("upgrade", (req, socket, head) => {
    // FIRST statement: the client can reset this raw socket at any moment
    // (mid-rejection, mid-handshake) and an unhandled 'error' on it would
    // crash the whole host process. denyUpgrade writes a status line and
    // destroys — both need a listener already attached, before any check or
    // write. The ws instance keeps its own error listener after the takeover.
    socket.on("error", () => socket.destroy());
    let pathname;
    try {
      pathname = new URL(req.url, "http://localhost").pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== "/terminal") {
      socket.destroy();
      return;
    }
    void (async () => {
      const address = req.socket?.remoteAddress ?? "";
      if (!(await resolvePeer()).has(stripV6Prefix(address))) {
        denyUpgrade(socket, 403, "Forbidden");
        return;
      }
      const token = readToken();
      if (token === null) {
        denyUpgrade(socket, 503, "Service Unavailable");
        return;
      }
      if (!tokensEqual(req.headers["x-fenix-host-token"], token)) {
        denyUpgrade(socket, 401, "Unauthorized");
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        void (async () => {
          const params = new URL(req.url, "http://localhost").searchParams;
          const cols = clampInt(params.get("cols"), COLS_MIN, COLS_MAX, DEFAULT_COLS);
          const rows = clampInt(params.get("rows"), ROWS_MIN, ROWS_MAX, DEFAULT_ROWS);
          // Lifecycle is registered BEFORE any await: a client that disconnects
          // mid-ensure must never leave a pty (a tmux client) behind. killPty
          // kills whatever pty exists at call time, so the post-await
          // bail-outs below also kill a pty created after the close.
          let pty;
          let closed = false;
          const killPty = () => {
            closed = true;
            try {
              pty?.kill();
            } catch {
              /* already dead */
            }
          };
          ws.on("close", () => {
            // Killing the pty only detaches THIS tmux client; the session and
            // the Supervisor inside it keep running.
            killPty();
          });
          ws.on("error", killPty);
          const gone = () => closed || ws.readyState !== ws.OPEN;
          const ens = await ensureSession();
          if (gone()) {
            killPty();
            return;
          }
          if (!ens.ready) {
            ws.close(1013, "starting");
            return;
          }
          try {
            pty = await ptyFactory(tmuxBin, ["-L", tmux.socket, "attach-session", "-t", tmux.session], {
              name: "xterm-256color",
              cols,
              rows,
              cwd: process.cwd(),
              env,
            });
          } catch {
            if (!gone()) ws.close(1011, "terminal unavailable");
            return;
          }
          if (gone()) {
            killPty();
            return;
          }
          pty.onData((data) => {
            if (ws.readyState !== ws.OPEN) return;
            if (ws.bufferedAmount > wsMaxBufferedBytes) {
              // The dashboard stopped reading: close rather than buffer the
              // whole pane history in memory.
              killPty();
              try {
                ws.close(1009, "client too slow");
              } catch {
                /* already closing */
              }
              return;
            }
            ws.send(data);
          });
          pty.onExit(() => {
            try {
              ws.close(1000);
            } catch {
              /* already closing */
            }
          });
          ws.on("message", (data, isBinary) => {
            if (isBinary) return; // JSON text frames only
            let msg;
            try {
              msg = JSON.parse(data.toString("utf8"));
            } catch {
              return;
            }
            if (!msg || typeof msg !== "object") return;
            if (msg.t === "i" && typeof msg.d === "string") {
              try {
                pty.write(msg.d);
              } catch {
                /* pty gone */
              }
            } else if (msg.t === "r") {
              const c = clampInt(msg.c, COLS_MIN, COLS_MAX, cols);
              const r = clampInt(msg.r, ROWS_MIN, ROWS_MAX, rows);
              try {
                pty.resize(c, r);
              } catch {
                /* pty gone */
              }
            }
            // anything else ignored
          });
          // Heartbeat: a ping per interval; a client that misses one pong is
          // presumed gone (asleep laptop, dead network) and is terminated —
          // the close that follows kills the pty.
          let ponged = true;
          const heartbeat = setInterval(() => {
            if (ws.readyState !== ws.OPEN) {
              clearInterval(heartbeat);
              return;
            }
            if (!ponged) {
              ws.terminate();
              return;
            }
            ponged = false;
            try {
              ws.ping();
            } catch {
              /* already closing */
            }
          }, wsHeartbeatIntervalMs);
          heartbeat.unref?.();
          ws.on("pong", () => {
            ponged = true;
          });
          ws.on("close", () => {
            clearInterval(heartbeat);
          });
        })().catch(() => {
          try {
            ws.close(1011, "terminal unavailable");
          } catch {
            /* already closed */
          }
        });
      });
    })().catch(() => {
      socket.destroy();
    });
  });

  return { server, ensureSession, sendMessage, getState, alive, answerDialog, answerAsk };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

// Exported so the task-session multiplexer's serve writes the SAME token the
// single-session host did (global host.token — never per-session).
export const writeHostToken = () => {
  const path = hostTokenPath();
  const token = randomBytes(32).toString("hex");
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, token, { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
  return token;
};

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const command = process.argv[2];
  if (command === "serve") {
    const token = writeHostToken();
    const host = createHost();
    const { server } = host;
    const bind = process.env.FENIX_HOST_BIND || "0.0.0.0";
    const port = Number.parseInt(process.env.FENIX_HOST_PORT ?? "", 10) || 7332;
    server.listen(port, bind, () => {
      console.log(`supervisor-host listening on ${bind}:${port} (token written to ${hostTokenPath()})`);
    });
    server.on("error", (err) => {
      console.error(`supervisor-host: ${err.message}`);
      process.exit(1);
    });
    const shutdown = () => {
      server.close(() => process.exit(0));
      // Connections may linger; do not hang the container's stop sequence.
      setTimeout(() => process.exit(0), 2000).unref();
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  } else if (command === "ensure") {
    const fresh = process.argv.includes("--new");
    const sessionIdx = process.argv.indexOf("--session");
    const sessionArg = sessionIdx !== -1 ? (process.argv[sessionIdx + 1] ?? "") : null;
    // Managed task sessions (PRD task-workspace-supervisors §5) change which
    // tmux identity `ensure` may touch: once ANY task session is known, an
    // unqualified ensure must never silently start the legacy global
    // supervisor — it needs an explicit --session <id>, and it then operates
    // on THAT session's own socket, stamping the task identity the pane's
    // hooks and entrypoint branch require.
    let env = process.env;
    try {
      const { createTaskSessionStore } = await import("./task-sessions.mjs");
      const store = createTaskSessionStore({});
      const known = store.list();
      store.close();
      if (known.length > 0) {
        if (!sessionArg) {
          console.error("usage: node scripts/supervisor-host.mjs ensure [--new] --session <id>");
          console.error(`managed task sessions exist (${known.length}); ensure needs an explicit --session. Known:`);
          for (const s of known) console.error(`  ${s.sessionId}  ${s.taskKey}  ${s.status}`);
          process.exit(2);
        }
        const record = known.find((s) => s.sessionId === sessionArg);
        if (!record) {
          console.error(`ensure: unknown session ${sessionArg}`);
          process.exit(2);
        }
        if (fresh || !["running", "waiting"].includes(record.status)) {
          console.error("ensure: managed sessions must be started through the authenticated task API");
          process.exit(2);
        }
        env = {
          ...process.env,
          FENIX_SUPERVISOR_SESSION_ID: record.sessionId,
          LA_TASK_KEY: record.taskKey,
          LA_TASK_ID: record.taskId,
          LA_SUPERVISOR_SESSION_HOME: supervisorSessionHome({ ...process.env, FENIX_SUPERVISOR_SESSION_ID: record.sessionId }),
        };
        const existing = createHost({ env }).getState();
        if (existing.panePid !== record.pid || existing.paneDead || !matchesProcess(record, readProcessIdentity(record.pid))) {
          console.error("ensure: managed process identity not proven; recover from the task cockpit");
          process.exit(2);
        }
        console.log("ready");
        process.exit(0);
      }
    } catch {
      console.error("ensure: session registry unavailable; refusing to start an unowned process");
      process.exit(2);
    }
    const host = createHost({ env });
    const result = await host.ensureSession({ fresh });
    if (result.ready) {
      console.log("ready");
      process.exit(0);
    } else {
      console.log(`starting${result.detail ? ` (${result.reason}: ${result.detail})` : ` (${result.reason})`}`);
      process.exit(1);
    }
  } else {
    console.error("usage: node scripts/supervisor-host.mjs serve | ensure [--new] [--session <id>]");
    process.exit(2);
  }
}
