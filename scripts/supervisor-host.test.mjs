// scripts/supervisor-host.test.mjs — the session host's contract (FOC-783,
// supervisor-host.mjs).
//
// The properties worth protecting:
//   · ensureSession starts the session with ONE tmux invocation and reports
//     ready only when the PANE shows a free input prompt on two consecutive
//     polls — no hook write is required (a `claude --continue` restart may
//     write nothing); a fresh "ended" hook write vetoes, and a timeout is
//     "starting", never a lie;
//   · getState trusts the PANE, not the hook file: a dead or missing pane is
//     "absent" whatever session.json says;
//   · sendMessage validates before it touches tmux: empty, too-long (bytes,
//     not chars), slash commands; strips \r and C0/C1 control characters while
//     keeping \t and \n;
//   · the visible pane is a second source of truth: a dialog on screen is
//     409 whatever the hook says, a hook "needs-input" beside an empty prompt
//     is stale (Esc-cancelled turns never fire Stop), an unreadable pane
//     leaves the hook in charge, and a message is only pasted when the input
//     line is free — or a turn is running, whose input Claude Code queues;
//   · a message is confirmed by any hook write AFTER the send in a state that
//     means the prompt was taken (busy, idle or needs-input — a fast turn can
//     start AND end between two polls); an unconfirmed send during a running
//     turn is queued, never retried;
//   · dialogs are answered from the pane (FOC-810): GET /dialog parses the
//     capture; /dialog/answer presses only an option that carries the exact
//     choice (an auto-mode option is never pressed), deny Escapes and with a
//     note pastes it through the shared paste path once the prompt is back;
//   · /dialog/ask replans the ask keys and re-captures before EVERY step —
//     a mismatch is re-polled for a 2 s settle window (the TUI redraws
//     asynchronously after a step's keys) before it is a 409
//     dialog-changed with the step; a first capture already on a later step
//     of the same ask resumes there (resumedFrom), a mid-flow drift that
//     outlives the window is 409 with partial:true (no automatic Escape);
//   · slash commands are gated by the policy: /context and /cost are sent and
//     their scrollback output returned (a modal is Esc-closed), anything else
//     is 400 with the allowed list;
//   · a permission prompt parked past taskSessions.parkedPrompt minutes
//     (deny-after) is answered No by the host itself: Escape, the note pasted
//     once the prompt is back, one row in parked-denials.jsonl, autoDenial on
//     /state — and never twice for the same dialog; the deny clock is floored
//     at the host's start (a stale hook anchor never inherits old minutes)
//     and an answerDialog that did not press anything (409/503) records
//     nothing and is retried on the next tick; the denial's reason is
//     redacted (denylist + egress shapes) before it reaches the jsonl or
//     /state; select/ask dialogs are never auto-answered and a failure in
//     the watchdog never takes the host down;
//   · every non-healthz request passes TWO gates in order — peer (403) then
//     token (401; a missing token FILE is 503) — and the token is re-read per
//     request so a supervisor restart rotates it;
//   · /healthz answers loopback only, without a token;
//   · the WebSocket terminal is gated the same way, clamps cols/rows, speaks
//     the {"t":"i"|"r"} protocol only, and closing the socket kills only THIS
//     client's pty (a detach), never the session.
//
// Everything is hermetic: tmux, the hook file, the token, DNS and the pty are
// injected seams; servers bind 127.0.0.1 port 0; the clock is fake, so the
// 30 s readiness deadline and the 5 s confirmation deadline cost nothing.
//
// NOTE (lanes): this file binds sockets and uses the ws client against the
// host's WebSocketServer, so it belongs in the SERIAL lane of
// scripts/test-lanes.json — the parallel-lane static audit in test-run.mjs
// forbids exactly these markers there.
//
// Run: node scripts/supervisor-host.test.mjs

import assert from "node:assert/strict";
import net from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

import { createHost, MAX_MESSAGE_BYTES, BODY_CAP_BYTES } from "./supervisor-host.mjs";
import { extractCommandOutput, parseDialog } from "./session-dialog.mjs";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "session-dialogs");
const readFixture = (name) => readFileSync(join(FIXTURES, name), "utf8");

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const fail = (msg) => { throw new Error(msg); };
const eq = (a, b, label) => assert.deepEqual(a, b, label);

// ── seams ─────────────────────────────────────────────────────────────────────

const fakeClock = () => {
  const api = {
    t: 1_700_000_000_000,
    sleeps: [],
    now: () => api.t,
    sleep: async (ms) => {
      api.sleeps.push(ms);
      api.t += ms;
    },
  };
  return api;
};

// Real capture-pane output shapes the pane regexes are built on (FOC-783
// acceptance, tmux 3.3a): the empty input line between box rules is a free
// prompt; the permission dialog's markers are what must refuse keystrokes.
const READY_PANE = [
  "────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────",
  "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
].join("\n");
const DIALOG_PANE = [
  " Ask rule Bash(git push:*) overrides auto mode for this command.",
  " /permissions to let auto mode decide",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. No",
  " Esc to cancel · Tab to amend",
].join("\n");

const fakeTmux = (init = {}) => {
  const api = {
    present: init.present ?? false,
    paneDead: init.paneDead ?? 0,
    fail: new Set(init.fail ?? []),
    // The pane shows a free prompt unless a test says otherwise; `fail` with
    // "capture-pane" makes the pane unreadable (ok=false path).
    capture: init.capture ?? READY_PANE,
    // Optional scripted capture SEQUENCE: capture-pane pops entries until one
    // remains, which then repeats forever (the pane settled).
    captureSeq: init.captureSeq ?? null,
    calls: [],
    onCall: null,
  };
  api.run = (args, opts = {}) => {
    api.calls.push({ args, input: opts.input });
    if (api.onCall) api.onCall(args);
    if (api.fail.has(args[0])) return { status: 1, stdout: "", stderr: `${args[0]} blew up` };
    switch (args[0]) {
      case "has-session":
        return { status: api.present ? 0 : 1, stdout: "", stderr: "" };
      case "capture-pane":
        if (api.captureSeq) {
          if (api.captureSeq.length > 1) return { status: 0, stdout: api.captureSeq.shift(), stderr: "" };
          return { status: 0, stdout: api.captureSeq[0], stderr: "" };
        }
        return { status: 0, stdout: api.capture, stderr: "" };
      case "list-panes":
        return api.present
          ? { status: 0, stdout: `4242 ${api.paneDead}\n`, stderr: "" }
          : { status: 1, stdout: "", stderr: "no current client" };
      case "list-clients":
        return api.present
          ? { status: 0, stdout: "/dev/pts/3\n", stderr: "" }
          : { status: 1, stdout: "", stderr: "" };
      default:
        return { status: 0, stdout: "", stderr: "" };
    }
  };
  return api;
};

const iso = (clock) => new Date(clock.t).toISOString();

// build() — one host with every seam injected. `token: undefined` leaves the
// REAL readToken in place (exercised via the LA_DATA_HOME seam in its test).
const build = (opts = {}) => {
  const clk = opts.clk ?? fakeClock();
  const tmux = opts.tmux ?? fakeTmux();
  const deps = {
    env: opts.env ?? {},
    runTmux: tmux.run,
    readSessionState: () => (opts.stateNow ? opts.stateNow() : null),
    resolvePeer: async () => new Set(opts.peers ?? ["127.0.0.1", "10.0.0.5"]),
    processAlive: opts.processAliveImpl ?? (() => true),
    sleep: clk.sleep,
    now: clk.now,
  };
  // "token" PRESENT (even null) pins readToken explicitly; omitted → the
  // shared fixture token. Only the real-readToken test bypasses this by
  // calling createHost directly.
  deps.readToken = "token" in opts ? () => opts.token : () => "tok-123";
  if (opts.ptyFactory !== undefined) deps.ptyFactory = opts.ptyFactory;
  if (opts.wsMaxBufferedBytes !== undefined) deps.wsMaxBufferedBytes = opts.wsMaxBufferedBytes;
  if (opts.wsHeartbeatIntervalMs !== undefined) deps.wsHeartbeatIntervalMs = opts.wsHeartbeatIntervalMs;
  if (opts.readParkedPolicy !== undefined) deps.readParkedPolicy = opts.readParkedPolicy;
  if (opts.parkedCheckMs !== undefined) deps.parkedCheckMs = opts.parkedCheckMs;
  return { host: createHost(deps), tmux, clk };
};

const presentHost = (extra = {}) => build({ tmux: fakeTmux({ present: true }), ...extra });

const listen = (host) =>
  new Promise((resolve) => {
    host.server.listen(0, "127.0.0.1", () => resolve(host.server.address().port));
  });

const closeServer = async (host) => {
  host.server.closeAllConnections?.();
  // A socket the http server no longer tracks (an upgraded one) must not hang
  // the suite — the ports are ephemeral, so a laggard is raced, not awaited.
  await Promise.race([
    new Promise((resolve) => host.server.close(resolve)),
    new Promise((resolve) => setTimeout(resolve, 1000)),
  ]);
};

const call = async (port, method, path, { body, headers } = {}) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      "x-fenix-host-token": "tok-123",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json };
};

const until = async (fn, ms = 3000, label = "condition") => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) fail(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

// Every send-keys invocation, in order — the keys a flow actually pressed.
const sendKeysArgs = (tmux) => tmux.calls.filter((c) => c.args[0] === "send-keys").map((c) => c.args);

// A fake node-pty IPty: onData/onExit registrations, write/resize/kill.
const fakePtyFactory = () => {
  const made = [];
  const factory = async (file, args, opts) => {
    const listeners = { data: [], exit: [] };
    const pty = {
      file, args, opts,
      written: [], resized: [], killed: false,
      write(d) { pty.written.push(d); },
      resize(c, r) { pty.resized.push([c, r]); },
      kill() { pty.killed = true; },
      onData(cb) { listeners.data.push(cb); },
      onExit(cb) { listeners.exit.push(cb); },
      emitData(d) { for (const cb of listeners.data) cb(d); },
      emitExit() { for (const cb of listeners.exit) cb({ exitCode: 0 }); },
    };
    made.push(pty);
    return pty;
  };
  factory.made = made;
  return factory;
};

const wsConnect = (port, { path = "/terminal", headers = {} } = {}) =>
  new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    const result = { ws, opened: false, closeCode: null, closeReason: "", messages: [], error: null };
    ws.on("open", () => {
      result.opened = true;
      resolve(result);
    });
    ws.on("message", (d) => result.messages.push(d.toString()));
    ws.on("close", (code, reason) => {
      result.closeCode = code;
      result.closeReason = reason.toString();
      resolve(result);
    });
    ws.on("error", (err) => {
      result.error = err;
      resolve(result);
    });
  });

// Spoofed-socket requests (a real client from 127.0.0.1 cannot pretend to come
// from elsewhere): emit "request" with a fake req/res pair.
const emitRequest = (host, { method = "GET", url = "/", remoteAddress = "127.0.0.1", headers = {} }) =>
  new Promise((resolve, reject) => {
    const req = { method, url, headers, socket: { remoteAddress } };
    const res = {
      writeHead(status) { res.status = status; },
      end(body) {
        try {
          resolve({ status: res.status, json: JSON.parse(body ?? "") });
        } catch (err) {
          reject(err);
        }
      },
    };
    host.server.emit("request", req, res);
  });

// ── ensureSession ─────────────────────────────────────────────────────────────

console.log("\nsupervisor-host: ensureSession");

test("present, not fresh → ready; only has-session runs", async () => {
  const { host, tmux } = presentHost();
  eq(await host.ensureSession(), { ready: true }, "ready");
  eq(tmux.calls.map((c) => c.args[0]), ["has-session"], "one probe only");
});

test("absent → exact start argv (focus-events on); ready on two consecutive ready polls with NO hook write at all, then settles 300 ms", async () => {
  const tmux = fakeTmux({ present: false });
  const clk = fakeClock();
  const { host } = build({ tmux, clk, stateNow: () => null });
  eq(await host.ensureSession(), { ready: true }, "ready without any hook write");
  const argv = tmux.calls.map((c) => c.args);
  eq(argv[0], ["has-session", "-t", "supervisor"], "probe");
  eq(argv[1], [
    "start-server", ";",
    // FOC-1080: prompt suggestions off for the pane (ghost text breaks promptReady)
    "set-environment", "-g", "CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION", "false", ";",
    "set-option", "-g", "history-limit", "50000", ";",
    "set-option", "-g", "default-size", "200x50", ";",
    "set-option", "-g", "window-size", "latest", ";",
    "set-option", "-g", "focus-events", "on", ";",
    "new-session", "-d", "-s", "supervisor", "-x", "200", "-y", "50",
    "/opt/fenix/docker/entrypoint.sh", "supervisor-run",
  ], "one start invocation, exact argv");
  eq(tmux.calls.filter((c) => c.args[0] === "capture-pane").length, 2, "two consecutive ready polls confirm");
  assert.ok(clk.sleeps.includes(300), "settles 300 ms once the prompt shows");
});

test("one ready poll is not enough — a flickering prompt needs two CONSECUTIVE ready polls", async () => {
  const tmux = fakeTmux({ present: false });
  const clk = fakeClock();
  let captures = 0;
  tmux.onCall = (args) => {
    if (args[0] === "capture-pane" && ++captures === 2) tmux.capture = ""; // flicker
    if (args[0] === "capture-pane" && captures === 3) tmux.capture = READY_PANE;
  };
  const { host } = build({ tmux, clk, stateNow: () => null });
  eq(await host.ensureSession(), { ready: true }, "ready once the prompt holds");
  eq(captures, 4, "ready, flicker, ready, ready — confirmed on the 4th poll");
});

test("fresh on a present session → kill-session, then start with --new appended", async () => {
  const tmux = fakeTmux({ present: true, capture: "" }); // the pane never readies
  const { host } = build({
    tmux,
    env: { FENIX_SUPERVISOR_CMD: "/opt/fenix/docker/entrypoint.sh supervisor-run" },
  });
  // The pane never shows a prompt here → readiness times out; this test
  // pins the argv, the timeout shape is pinned by its own test below.
  eq(await host.ensureSession({ fresh: true }), { ready: false, reason: "starting" }, "no hook write → starting");
  const argv = tmux.calls.map((c) => c.args);
  eq(argv[0], ["has-session", "-t", "supervisor"], "probe");
  eq(argv[1], ["kill-session", "-t", "supervisor"], "fresh kills the old session");
  const start = argv[2];
  eq(start[0], "start-server", "start invocation");
  eq(start.slice(-2), ["supervisor-run", "--new"], "--new appended to the start command");
});

test("a non-fresh start does NOT append --new", async () => {
  const tmux = fakeTmux({ present: false });
  const { host } = build({ tmux, env: { FENIX_SUPERVISOR_CMD: "entry.sh run" } });
  await host.ensureSession().catch(() => {});
  const start = tmux.calls.map((c) => c.args).find((a) => a[0] === "start-server");
  eq(start.slice(-2), ["entry.sh", "run"], "no --new");
});

test("fresh appends --new to a custom start command", async () => {
  const tmux = fakeTmux({ present: true });
  const { host } = build({ tmux, env: { FENIX_SUPERVISOR_CMD: "entry.sh run" } });
  await host.ensureSession({ fresh: true }).catch(() => {});
  const start = tmux.calls.map((c) => c.args).find((a) => a[0] === "start-server");
  eq(start.slice(-3), ["entry.sh", "run", "--new"], "--new appended");
});

test("the pane never shows a ready prompt → starting after the 30 s cap", async () => {
  const { host, clk } = build({ tmux: fakeTmux({ present: false, capture: "" }) });
  eq(await host.ensureSession(), { ready: false, reason: "starting" }, "timeout shape");
  const polls = clk.sleeps.filter((s) => s === 250).length;
  assert.ok(polls >= 118, `polled through the 30 s window (fake clock), got ${polls} polls`);
});

test("tmux start failure → not ready, reason start-failed", async () => {
  const { host } = build({ tmux: fakeTmux({ present: false, fail: new Set(["start-server"]) }) });
  const r = await host.ensureSession();
  eq(r.ready, false, "not ready");
  eq(r.reason, "start-failed", "reason");
});

test("start failing with 'duplicate session' → a lost race, the session exists → ready", async () => {
  const clk = fakeClock();
  const tmux = fakeTmux({ present: false });
  let raced = false; // the other ensure's session appears between probe and start
  tmux.run = (args, opts = {}) => {
    tmux.calls.push({ args, input: opts.input });
    if (args[0] === "start-server") {
      raced = true;
      return { status: 1, stdout: "", stderr: "duplicate session: supervisor" };
    }
    if (args[0] === "has-session") return { status: raced ? 0 : 1, stdout: "", stderr: "" };
    if (args[0] === "capture-pane") return { status: 0, stdout: READY_PANE, stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  const { host } = build({ tmux, clk, stateNow: () => null });
  eq(await host.ensureSession(), { ready: true }, "the race winner's session counts (pane-ready, no hook write)");
});

test("a SessionEnd write (state 'ended') after start does NOT satisfy readiness", async () => {
  const clk = fakeClock();
  const tmux = fakeTmux({ present: false });
  let started = false;
  const { host } = build({
    tmux,
    clk,
    // The OLD session dies right after ours starts: its SessionEnd writes a
    // fresh updatedAt with state "ended" — that write VETOES readiness (the
    // pane may look ready, but a dying session must never count as started).
    stateNow: () => (started
      ? { state: "ended", updatedAt: iso(clk), notification: null }
      : null),
  });
  tmux.onCall = (args) => {
    if (args[0] === "start-server") started = true;
  };
  eq(await host.ensureSession(), { ready: false, reason: "starting" }, "ended never counts as ready");
});

test("booting pane: readiness waits for the drawn prompt on two consecutive polls before settling", async () => {
  const tmux = fakeTmux({ present: false, capture: "" }); // booting: no prompt yet
  const clk = fakeClock();
  let captures = 0;
  const { host } = build({ tmux, clk, stateNow: () => null });
  tmux.onCall = (args) => {
    if (args[0] === "capture-pane" && ++captures === 3) tmux.capture = READY_PANE; // the TUI finishes booting
  };
  eq(await host.ensureSession(), { ready: true }, "ready once the prompt is drawn twice");
  eq(captures, 4, "two booting polls, then the prompt held twice");
  assert.ok(clk.sleeps.includes(300), "settles 300 ms once ready");
});

// ── getState ──────────────────────────────────────────────────────────────────

console.log("\nsupervisor-host: getState precedence");

test("absent session → state 'absent' even though the hook says busy", async () => {
  const { host, clk } = build({
    tmux: fakeTmux({ present: false }),
    stateNow: () => ({ state: "busy", updatedAt: iso(clk), notification: null }),
  });
  const s = host.getState();
  eq(s.session, "absent", "session");
  eq(s.state, "absent", "the pane wins over the hook file");
});

test("dead pane → state 'absent' whatever the hook says", async () => {
  const { host, clk } = build({
    tmux: fakeTmux({ present: true, paneDead: 1 }),
    stateNow: () => ({ state: "busy", updatedAt: iso(clk), notification: null }),
  });
  const s = host.getState();
  eq(s.session, "running", "the tmux session still exists");
  eq(s.paneDead, true, "pane dead");
  eq(s.state, "absent", "state");
});

test("live pane → hook state wins; clients and pid reported", async () => {
  const { host, clk } = build({
    tmux: fakeTmux({ present: true }),
    stateNow: () => ({ state: "busy", updatedAt: iso(clk), notification: null }),
  });
  const s = host.getState();
  eq(s.session, "running", "session");
  eq(s.panePid, 4242, "panePid");
  eq(s.paneDead, false, "paneDead");
  eq(s.clients, ["/dev/pts/3"], "clients");
  eq(s.state, "busy", "state");
});

test("live pane, no hook file yet → state 'unknown'", async () => {
  const { host } = build({ tmux: fakeTmux({ present: true }) });
  eq(host.getState().state, "unknown", "unknown");
});

test("an open dialog → effective state 'needs-input' even when the hook says idle", async () => {
  const { host, clk } = build({
    tmux: fakeTmux({ present: true, capture: DIALOG_PANE }),
    stateNow: () => ({ state: "idle", updatedAt: iso(clk), notification: null }),
  });
  const s = host.getState();
  eq(s.dialog, true, "dialog");
  eq(s.promptReady, false, "promptReady");
  eq(s.state, "needs-input", "the pane's dialog wins over the hook file");
});

test("hook needs-input beside a drawn prompt (stale after an Esc) → effective state 'idle'", async () => {
  const { host, clk } = build({
    tmux: fakeTmux({ present: true }), // free prompt on the pane
    stateNow: () => ({ state: "needs-input", updatedAt: iso(clk), notification: null }),
  });
  const s = host.getState();
  eq(s.dialog, false, "dialog");
  eq(s.promptReady, true, "promptReady");
  eq(s.state, "idle", "a drawn prompt means the turn is over — the hook file is stale");
  // The flip side: a readable pane with NO prompt and NO dialog is no proof
  // of staleness — the hook's needs-input stands.
  const waiting = build({
    tmux: fakeTmux({ present: true, capture: "" }),
    stateNow: () => ({ state: "needs-input", updatedAt: iso(clk), notification: null }),
  });
  const w = waiting.host.getState();
  eq(w.promptReady, false, "no prompt on the pane");
  eq(w.state, "needs-input", "hook needs-input without pane proof stays");
});

test("needsInputSince: first observed on the pane, stable across polls, cleared when the prompt is gone", () => {
  const { host, clk } = build({
    tmux: fakeTmux({ present: true, capture: DIALOG_PANE }),
    stateNow: () => ({ state: "idle", updatedAt: iso(clk), notification: null }),
  });
  const firstAt = iso(clk);
  const s1 = host.getState();
  eq(s1.state, "needs-input", "dialog on the pane");
  eq(s1.needsInputSince, firstAt, "anchored at the first poll that saw the prompt");
  clk.t += 60_000;
  const s2 = host.getState();
  eq(s2.needsInputSince, s1.needsInputSince, "stable across polls (not re-anchored)");
  // A host whose pane shows a free prompt (no dialog, hook idle) has never
  // been in needs-input — the field starts null, not invented.
  const free = build({
    tmux: fakeTmux({ present: true }),
    stateNow: () => ({ state: "idle", updatedAt: iso(clk), notification: null }),
  });
  eq(free.host.getState().needsInputSince, null, "no prompt → null");
});

test("needsInputSince: the hook's updatedAt wins when the hook itself says needs-input", () => {
  const { host } = build({
    tmux: fakeTmux({ present: true, capture: "" }), // readable pane, no prompt, no dialog
    stateNow: () => ({ state: "needs-input", updatedAt: "2026-10-19T10:00:00.000Z", notification: null }),
  });
  const s = host.getState();
  eq(s.state, "needs-input", "state");
  eq(s.needsInputSince, "2026-10-19T10:00:00.000Z", "the hook wrote the record as the prompt appeared");
});

test("needsInputSince: absent session → null", () => {
  const { host } = build({ tmux: fakeTmux({ present: false }) });
  eq(host.getState().needsInputSince, null, "absent");
});

// ── sendMessage: validation ───────────────────────────────────────────────────

console.log("\nsupervisor-host: sendMessage validation");

test("non-string and whitespace-only → 400 empty", async () => {
  const { host } = presentHost();
  eq(await host.sendMessage(undefined), { status: 400, body: { error: "empty" } }, "undefined");
  eq(await host.sendMessage(42), { status: 400, body: { error: "empty" } }, "number");
  eq(await host.sendMessage("   \n  "), { status: 400, body: { error: "empty" } }, "whitespace");
});

test("over 8192 BYTES → 400 too-long (multibyte counts as bytes)", async () => {
  const { host } = presentHost();
  eq((await host.sendMessage("a".repeat(MAX_MESSAGE_BYTES + 1))).status, 400, "8193 ascii");
  eq((await host.sendMessage("ż".repeat(4097))).status, 400, "4097 ż = 8194 bytes");
  eq((await host.sendMessage("ż".repeat(4096))).status, 200, "4096 ż = exactly 8192 bytes passes");
});

test("a leading slash (even after whitespace) → 400 slash-command", async () => {
  const { host } = presentHost();
  const slash = await host.sendMessage("/exit");
  eq(slash.status, 400, "status");
  eq(slash.body.error, "slash-command", "error");
  eq((await host.sendMessage("  /help")).status, 400, "leading spaces do not hide the slash");
});

test("control characters are stripped, \\t and \\n survive; the buffer gets the cleaned text", async () => {
  const { host, tmux } = presentHost();
  const r = await host.sendMessage("  hi\u0000\u0007bad\rline\n\tkeep\u009f");
  eq(r.status, 200, "sent");
  const load = tmux.calls.find((c) => c.args[0] === "load-buffer");
  eq(load.input, "  hibadline\n\tkeep", "cleaned input (\\r, C0, C1 gone; \\t, \\n kept)");
});

test("a dialog on the pane → 409 even with the hook idle; no keystrokes reach tmux", async () => {
  const tmux = fakeTmux({ present: true, capture: DIALOG_PANE });
  const { host } = build({
    tmux,
    stateNow: () => ({ state: "idle", updatedAt: "1970-01-01T00:00:00.000Z", notification: null }),
  });
  const r = await host.sendMessage("hello");
  eq(r.status, 409, "status");
  eq(r.body, { error: "needs-input", notification: null }, "the pane outranks the hook file");
  eq(tmux.calls.map((c) => c.args[0]), ["has-session", "capture-pane"], "probed the pane, touched nothing else");
});

test("a STALE hook needs-input with an empty prompt on the pane → sent, not 409", async () => {
  const { host } = build({
    tmux: fakeTmux({ present: true }),
    stateNow: () => ({
      state: "needs-input",
      updatedAt: "1970-01-01T00:00:00.000Z",
      notification: { type: "permission_prompt", message: "Allow?" },
    }),
  });
  const r = await host.sendMessage("hello");
  eq(r.status, 200, "the pane shows no dialog — the hook state is stale");
  eq(r.body, { sent: true, confirmed: false, queued: false }, "sent");
});

test("hook needs-input with an UNREADABLE pane → 409 (the hook alone decides)", async () => {
  const tmux = fakeTmux({ present: true, fail: new Set(["capture-pane"]) });
  const { host } = build({
    tmux,
    stateNow: () => ({
      state: "needs-input",
      updatedAt: "1970-01-01T00:00:00.000Z",
      notification: { type: "permission_prompt", message: "Allow?" },
    }),
  });
  const r = await host.sendMessage("hello");
  eq(r.status, 409, "status");
  eq(r.body.error, "needs-input", "error");
  eq(r.body.notification, { type: "permission_prompt", message: "Allow?" }, "notification passthrough");
});

test("pane not ready, hook idle → polls the pane up to 3 s, then 503 not-ready", async () => {
  const tmux = fakeTmux({ present: true, capture: "" });
  const { host } = build({
    tmux,
    stateNow: () => ({ state: "idle", updatedAt: "1970-01-01T00:00:00.000Z", notification: null }),
  });
  const r = await host.sendMessage("hello");
  eq(r.status, 503, "status");
  eq(r.body, { error: "not-ready", detail: "the Supervisor's input is not ready" }, "body");
  const captures = tmux.calls.filter((c) => c.args[0] === "capture-pane").length;
  assert.ok(captures > 1, `waited, polling the pane (${captures} captures)`);
});

test("pane not ready but the hook is busy → the paste queues behind the turn, no wait", async () => {
  const tmux = fakeTmux({ present: true, capture: "" });
  const { host } = build({
    tmux,
    stateNow: () => ({ state: "busy", updatedAt: "1970-01-01T00:00:00.000Z", notification: null }),
  });
  const r = await host.sendMessage("hello");
  eq(r.status, 200, "status");
  eq(r.body, { sent: true, confirmed: false, queued: true }, "queued while a turn runs");
  eq(tmux.calls.filter((c) => c.args[0] === "capture-pane").length, 1, "one probe, no 3 s wait");
});

test("a STALE needs-input (session absent) does not block chat: ensure runs, the fresh state is idle → sent", async () => {
  const tmux = fakeTmux({ present: false });
  const clk = fakeClock();
  let generation = 0; // 0 = the stale file, 1 = the new session's own writes
  const { host } = build({
    tmux,
    clk,
    stateNow: () => (generation === 0
      ? { state: "needs-input", updatedAt: iso(clk), notification: { type: "permission_prompt", message: "Allow?" } }
      : { state: "idle", updatedAt: iso(clk), notification: null }),
  });
  tmux.onCall = (args) => {
    if (args[0] === "start-server") generation = 1;
  };
  const r = await host.sendMessage("hello");
  eq(r.status, 200, "sent, not 409");
  assert.ok(tmux.calls.some((c) => c.args[0] === "start-server"), "ensure started a fresh session");
});

// ── sendMessage: delivery ─────────────────────────────────────────────────────

console.log("\nsupervisor-host: sendMessage delivery");

test("absent session, pane never readies → 503 starting", async () => {
  const { host } = build({ tmux: fakeTmux({ present: false, capture: "" }) });
  eq(await host.sendMessage("hello"), { status: 503, body: { error: "starting" } }, "starting");
});

test("exact tmux argv sequence; confirmed when session.json turns busy after the send", async () => {
  const tmux = fakeTmux({ present: true });
  const clk = fakeClock();
  let sent = false;
  const { host } = build({
    tmux,
    clk,
    stateNow: () => (sent
      ? { state: "busy", updatedAt: iso(clk), notification: null }
      : { state: "idle", updatedAt: "1970-01-01T00:00:00.000Z", notification: null }),
  });
  tmux.onCall = (args) => {
    if (args[0] === "send-keys") sent = true;
  };
  const r = await host.sendMessage("Status of all children");
  eq(r.status, 200, "status");
  eq(r.body, { sent: true, confirmed: true, queued: false }, "confirmed");
  eq(tmux.calls.map((c) => c.args), [
    ["has-session", "-t", "supervisor"],
    ["capture-pane", "-p", "-t", "supervisor"],
    ["load-buffer", "-b", "fenix-chat", "-"],
    ["paste-buffer", "-p", "-d", "-b", "fenix-chat", "-t", "supervisor"],
    ["send-keys", "-t", "supervisor", "Enter"],
  ], "exact argv sequence (the pane probe precedes the paste)");
  eq(tmux.calls[2].input, "Status of all children", "buffer input is the message");
  assert.ok(clk.sleeps.includes(200), "paste settles 200 ms before Enter");
});

test("turn already running and no busy-after → sent, not confirmed, queued", async () => {
  const { host } = build({
    tmux: fakeTmux({ present: true }),
    stateNow: () => ({ state: "busy", updatedAt: "1970-01-01T00:00:00.000Z", notification: null }),
  });
  const r = await host.sendMessage("hello");
  eq(r.status, 200, "status");
  eq(r.body, { sent: true, confirmed: false, queued: true }, "queued while a turn runs");
});

test("idle before and no busy-after → sent, not confirmed, not queued", async () => {
  const { host } = build({
    tmux: fakeTmux({ present: true }),
    stateNow: () => ({ state: "idle", updatedAt: "1970-01-01T00:00:00.000Z", notification: null }),
  });
  const r = await host.sendMessage("hello");
  eq(r.body, { sent: true, confirmed: false, queued: false }, "neither");
});

test("a fast turn — busy written, then overwritten to idle BEFORE the first poll — still confirms", async () => {
  const clk = fakeClock();
  let hook = null; // null = the pre-send file; after Enter the hooks own it
  const { host, tmux } = build({
    tmux: fakeTmux({ present: true }),
    clk,
    stateNow: () => hook ?? { state: "idle", updatedAt: "1970-01-01T00:00:00.000Z", notification: null },
  });
  tmux.onCall = (args) => {
    if (args[0] !== "send-keys") return;
    // UserPromptSubmit writes busy 5 ms after the send; the whole turn lands
    // before the host's first 250 ms poll, so Stop overwrites the file to
    // idle at +10 — every poll only ever sees idle.
    hook = { state: "busy", updatedAt: new Date(clk.t + 5).toISOString() };
    hook = { state: "idle", updatedAt: new Date(clk.t + 10).toISOString() };
  };
  const r = await host.sendMessage("hello");
  eq(r.status, 200, "status");
  eq(r.body, { sent: true, confirmed: true, queued: false }, "the consumed prompt is proof enough");
});

test("a tmux step failing mid-sequence → 500 with the stderr; send-keys never runs", async () => {
  const tmux = fakeTmux({ present: true, fail: new Set(["paste-buffer"]) });
  const { host } = build({ tmux });
  const r = await host.sendMessage("hello");
  eq(r.status, 500, "status");
  eq(r.body.error, "tmux", "error");
  eq(r.body.detail, "paste-buffer blew up", "detail is stderr");
  assert.ok(!tmux.calls.some((c) => c.args[0] === "send-keys"), "Enter never sent after a failed paste");
});

// ── alive ─────────────────────────────────────────────────────────────────────

console.log("\nsupervisor-host: alive");

test("alive filters to positive integers, caps at 200, reports via processAlive", async () => {
  const { host } = build({ processAliveImpl: (pid) => pid % 2 === 0 });
  const pids = [5, "x", -1, 0, 1.5, null, 42, ...Array.from({ length: 250 }, (_, i) => 1000 + i)];
  const out = host.alive(pids);
  eq(out[5], false, "odd → false");
  eq(out[42], true, "even → true");
  eq(Object.keys(out).length, 200, "at most 200 entries");
  for (const junk of ["x", "-1", "0", "1.5", "null", "undefined"]) {
    assert.ok(!(junk in out), `junk ${junk} ignored`);
  }
  eq(out[1000], true, "first kept pid after the junk");
  assert.ok(!("1249" in out), "beyond the 200 cap ignored");
  eq(host.alive("nope"), {}, "non-array → empty");
});

// ── HTTP gates ────────────────────────────────────────────────────────────────

console.log("\nsupervisor-host: HTTP gates");

test("wrong peer → 403 on actions (real socket from 127.0.0.1, peer set excludes it)", async () => {
  const { host } = build({ tmux: fakeTmux({ present: true }), peers: ["10.9.9.9"] });
  const port = await listen(host);
  eq((await call(port, "GET", "/state")).status, 403, "peer denied");
  await closeServer(host);
});

test("missing token header → 401; wrong token → 401", async () => {
  const { host } = presentHost();
  const port = await listen(host);
  eq((await call(port, "GET", "/state", { headers: { "x-fenix-host-token": "" } })).status, 401, "missing");
  eq((await call(port, "GET", "/state", { headers: { "x-fenix-host-token": "wrong" } })).status, 401, "wrong");
  await closeServer(host);
});

test("missing token FILE → 503 (cannot compare against nothing)", async () => {
  const { host } = build({ tmux: fakeTmux({ present: true }), token: null });
  const port = await listen(host);
  eq((await call(port, "GET", "/state")).status, 503, "no token file");
  await closeServer(host);
});

test("good peer + token → 200 /state with the getState shape", async () => {
  const { host, clk } = build({
    tmux: fakeTmux({ present: true }),
    stateNow: () => ({ state: "idle", updatedAt: iso(clk), notification: null }),
  });
  const port = await listen(host);
  const r = await call(port, "GET", "/state");
  eq(r.status, 200, "status");
  eq(r.json.session, "running", "session");
  eq(r.json.state, "idle", "state");
  eq(r.json.panePid, 4242, "panePid");
  await closeServer(host);
});

test("POST /session fresh → kill-session ran; a never-ready pane → 503", async () => {
  const tmux = fakeTmux({ present: true, capture: "" });
  const { host } = build({ tmux });
  const port = await listen(host);
  const r = await call(port, "POST", "/session", { body: { fresh: true } });
  // The pane never shows a prompt after the fresh start here → 503; the
  // kill-session side effect is what this test pins.
  eq(r.status, 503, "no hook write → starting");
  assert.ok(tmux.calls.some((c) => c.args[0] === "kill-session"), "fresh killed the session");
  await closeServer(host);
});

test("POST /session on a present session (no fresh) → 200 ready", async () => {
  const { host } = presentHost();
  const port = await listen(host);
  const r = await call(port, "POST", "/session", { body: {} });
  eq(r.status, 200, "status");
  eq(r.json, { ready: true }, "ready");
  await closeServer(host);
});

test("POST /message surfaces needs-input; POST /alive returns the filtered map", async () => {
  const { host, clk } = build({
    tmux: fakeTmux({ present: true, capture: DIALOG_PANE }),
    stateNow: () => ({ state: "needs-input", updatedAt: iso(clk), notification: null }),
    processAliveImpl: (pid) => pid === 7,
  });
  const port = await listen(host);
  eq((await call(port, "POST", "/message", { body: { text: "hi" } })).status, 409, "needs-input surfaced");
  const alive = await call(port, "POST", "/alive", { body: { pids: [7, 8, -3] } });
  eq(alive.status, 200, "alive status");
  eq(alive.json, { 7: true, 8: false }, "alive map");
  await closeServer(host);
});

test("body over 16 KB → 413", async () => {
  const { host } = presentHost();
  const port = await listen(host);
  const res = await fetch(`http://127.0.0.1:${port}/message`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-fenix-host-token": "tok-123" },
    body: JSON.stringify({ text: "x".repeat(BODY_CAP_BYTES + 100) }),
  });
  eq(res.status, 413, "capped");
  await res.text();
  await closeServer(host);
});

test("malformed JSON → 400; unknown path → 404; wrong method → 404", async () => {
  const { host } = presentHost();
  const port = await listen(host);
  const res = await fetch(`http://127.0.0.1:${port}/message`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-fenix-host-token": "tok-123" },
    body: "{not json",
  });
  eq(res.status, 400, "bad json");
  await res.text();
  eq((await call(port, "GET", "/nope")).status, 404, "unknown path");
  eq((await call(port, "GET", "/message")).status, 404, "GET on a POST route");
  await closeServer(host);
});

test("healthz from a real loopback client → 200 with the session", async () => {
  const { host } = build({ tmux: fakeTmux({ present: false }) });
  const port = await listen(host);
  const r = await call(port, "GET", "/healthz");
  eq(r.status, 200, "status");
  eq(r.json, { ok: true, session: "absent" }, "body");
  await closeServer(host);
});

test("healthz from a non-loopback peer (spoofed socket) → 403", async () => {
  const { host } = presentHost();
  const r = await emitRequest(host, { url: "/healthz", remoteAddress: "10.1.2.3" });
  eq(r.status, 403, "non-loopback refused");
});

test("peer gate denies a spoofed loopback address on /state — loopback is not in the action peer set", async () => {
  const { host } = build({ tmux: fakeTmux({ present: true }), peers: ["10.0.0.5"] });
  const r = await emitRequest(host, { url: "/state", remoteAddress: "127.0.0.1" });
  eq(r.status, 403, "loopback refused for actions");
});

// ── token file seam (real fs via LA_DATA_HOME) ────────────────────────────────

console.log("\nsupervisor-host: token file seam (real fs via LA_DATA_HOME)");

test("real readToken: 503 without the file, 401 on a mismatch, 200 on a match, rotation re-read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "la-host-token-"));
  const tmux = fakeTmux({ present: true });
  const host = createHost({
    env: { LA_DATA_HOME: dir },
    runTmux: tmux.run,
    readSessionState: () => null,
    resolvePeer: async () => new Set(["127.0.0.1"]),
    processAlive: () => true,
    sleep: async () => {},
    now: () => Date.now(),
  });
  try {
    const port = await listen(host);
    const tokenPath = join(dir, "run", "host.token");
    eq((await call(port, "GET", "/state")).status, 503, "no file → 503");
    mkdirSync(join(dir, "run"), { recursive: true });
    writeFileSync(tokenPath, "abc123\n");
    eq((await call(port, "GET", "/state")).status, 401, "no header → 401");
    eq((await call(port, "GET", "/state", { headers: { "x-fenix-host-token": "nope" } })).status, 401, "wrong → 401");
    eq((await call(port, "GET", "/state", { headers: { "x-fenix-host-token": "abc123" } })).status, 200, "match → 200");
    // Rotation: the supervisor restarted, the token changed — the OLD one must die.
    writeFileSync(tokenPath, "def456");
    eq((await call(port, "GET", "/state", { headers: { "x-fenix-host-token": "abc123" } })).status, 401, "rotated → old 401");
    eq((await call(port, "GET", "/state", { headers: { "x-fenix-host-token": "def456" } })).status, 200, "new → 200");
  } finally {
    await closeServer(host).catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── WebSocket terminal ────────────────────────────────────────────────────────

console.log("\nsupervisor-host: WebSocket terminal");

const wsSetup = async ({ query = "", headers = { "x-fenix-host-token": "tok-123" }, ...rest } = {}) => {
  const pty = fakePtyFactory();
  const { host, tmux } = build({ tmux: fakeTmux({ present: true }), ptyFactory: pty, ...rest });
  const port = await listen(host);
  const conn = await wsConnect(port, { path: `/terminal${query}`, headers });
  return { host, tmux, pty, port, conn };
};

test("wrong peer → raw 403 before any handshake", async () => {
  const pty = fakePtyFactory();
  const { host } = build({ tmux: fakeTmux({ present: true }), ptyFactory: pty, peers: ["10.9.9.9"] });
  const port = await listen(host);
  const conn = await wsConnect(port, { headers: { "x-fenix-host-token": "tok-123" } });
  assert.ok(conn.error && !conn.opened, "handshake refused");
  eq(conn.error?.message, "Unexpected server response: 403", "403 surfaced");
  await closeServer(host);
});

test("no token / wrong token → 401; missing token file → 503", async () => {
  for (const [label, opts, expected] of [
    ["no token", { headers: {} }, 401],
    ["wrong token", { headers: { "x-fenix-host-token": "wrong" } }, 401],
    ["no token file", { token: null }, 503],
  ]) {
    const pty = fakePtyFactory();
    const built = build({ tmux: fakeTmux({ present: true }), ptyFactory: pty, ...(opts.token !== undefined ? { token: opts.token } : {}) });
    const port = await listen(built.host);
    const conn = await wsConnect(port, { headers: opts.headers ?? { "x-fenix-host-token": "tok-123" } });
    assert.ok(conn.error && !conn.opened, `${label}: refused`);
    eq(conn.error?.message, `Unexpected server response: ${expected}`, `${label}: status`);
    await closeServer(built.host);
  }
});

test("non-/terminal upgrade → connection destroyed", async () => {
  const { host } = await wsSetup({});
  const conn = await wsConnect(host.server.address().port, { path: "/other", headers: { "x-fenix-host-token": "tok-123" } });
  assert.ok(conn.error && !conn.opened, "destroyed");
  await closeServer(host);
});

test("a client that RSTs during a rejected upgrade does not take the host down", async () => {
  const { host } = presentHost();
  const port = await listen(host);
  // Raw socket (no ws client): send an upgrade with no token → the host's
  // denyUpgrade writes a raw 401 and destroys. The client resets the
  // connection right away, so the reset can land before/while the host acts —
  // the socket's first-statement 'error' listener must keep the process up.
  await new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.on("error", () => {}); // the RST this test provokes is expected HERE (client side)
    socket.on("connect", () => {
      socket.write("GET /terminal HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
      if (typeof socket.resetAndDestroy === "function") socket.resetAndDestroy();
      else socket.destroy();
      resolve();
    });
  });
  const r = await call(port, "GET", "/healthz");
  eq(r.status, 200, "host still serving after the RST");
  await closeServer(host);
});

test("connected: pty spawned as a tmux attach with the clamped size; default 120x40", async () => {
  const { host, pty, conn } = await wsSetup({});
  assert.ok(conn.opened, "open");
  eq(pty.made.length, 1, "one pty");
  eq(pty.made[0].file, "tmux", "tmux binary");
  eq(pty.made[0].args, ["-L", "fenix", "attach-session", "-t", "supervisor"], "attach argv");
  eq(pty.made[0].opts.cols, 120, "default cols");
  eq(pty.made[0].opts.rows, 40, "default rows");
  await conn.ws.close();
  await until(() => pty.made[0].killed, 3000, "pty killed on close");
  await closeServer(host);
});

test("query cols/rows are clamped (9999→500, 0→5, junk→default)", async () => {
  const a = await wsSetup({ query: "?cols=9999&rows=0" });
  eq(a.pty.made[0].opts.cols, 500, "cols clamped high");
  eq(a.pty.made[0].opts.rows, 5, "rows clamped low");
  await a.conn.ws.close();
  await closeServer(a.host);

  const b = await wsSetup({ query: "?cols=abc&rows=7.5" });
  eq(b.pty.made[0].opts.cols, 120, "junk cols → default");
  eq(b.pty.made[0].opts.rows, 40, "junk rows → default");
  await b.conn.ws.close();
  await closeServer(b.host);
});

test("input frames write the pty; binary and junk frames are ignored", async () => {
  const { host, pty, conn } = await wsSetup({});
  await new Promise((r) => conn.ws.send(JSON.stringify({ t: "i", d: "ls\n" }), r));
  await until(() => pty.made[0].written.includes("ls\n"), 3000, "input forwarded");
  conn.ws.send("garbage not json");
  conn.ws.send(JSON.stringify({ t: "x", d: "ignored" }));
  await new Promise((r) => setTimeout(r, 50));
  eq(pty.made[0].written, ["ls\n"], "only the typed input reached the pty");
  await conn.ws.close();
  await closeServer(host);
});

test("resize frames clamp before reaching the pty", async () => {
  const { host, pty, conn } = await wsSetup({});
  await new Promise((r) => conn.ws.send(JSON.stringify({ t: "r", c: 10000, r: -5 }), r));
  await new Promise((r) => conn.ws.send(JSON.stringify({ t: "r", c: 80 }), r));
  await until(() => pty.made[0].resized.length === 2, 3000, "both resizes forwarded");
  eq(pty.made[0].resized, [[500, 5], [80, 40]], "clamped (a missing dim falls back to the session default)");
  await conn.ws.close();
  await closeServer(host);
});

test("pty output is forwarded to the client", async () => {
  const { host, conn, pty } = await wsSetup({});
  pty.made[0].emitData("hello from tmux");
  await until(() => conn.messages.includes("hello from tmux"), 3000, "output forwarded");
  await conn.ws.close();
  await closeServer(host);
});

test("client close kills only this client's pty — a detach, never a session kill", async () => {
  const { host, tmux, pty, conn } = await wsSetup({});
  const killCalls = () => tmux.calls.filter((c) => c.args[0] === "kill-session").length;
  const before = killCalls();
  await conn.ws.close();
  await until(() => pty.made[0].killed, 3000, "pty killed");
  eq(killCalls(), before, "the SESSION was not killed");
  await closeServer(host);
});

test("pty exit closes the socket with 1000", async () => {
  const { host, conn, pty } = await wsSetup({});
  pty.made[0].emitExit();
  await until(() => conn.closeCode !== null, 3000, "closed");
  eq(conn.closeCode, 1000, "clean close on pty exit");
  await closeServer(host);
});

test("session never becomes ready → close 1013 'starting'", async () => {
  const pty = fakePtyFactory();
  const built = build({ tmux: fakeTmux({ present: false, capture: "" }), ptyFactory: pty });
  const port = await listen(built.host);
  const conn = await wsConnect(port, { headers: { "x-fenix-host-token": "tok-123" } });
  await until(() => conn.closeCode !== null || conn.error, 3000, "closed");
  eq(conn.closeCode, 1013, "starting close code");
  eq(conn.closeReason, "starting", "reason");
  eq(pty.made.length, 0, "no pty was spawned");
  await closeServer(built.host);
});

test("ptyFactory failure → close 1011 'terminal unavailable'", async () => {
  const failing = async () => {
    throw new Error("no pty on this box");
  };
  const { host } = build({ tmux: fakeTmux({ present: true }), ptyFactory: failing });
  const port = await listen(host);
  const conn = await wsConnect(port, { headers: { "x-fenix-host-token": "tok-123" } });
  await until(() => conn.closeCode !== null, 3000, "closed");
  eq(conn.closeCode, 1011, "unavailable close code");
  await closeServer(host);
});

test("client closes while the pty factory is pending → the late pty is still killed", async () => {
  const base = fakePtyFactory();
  let release;
  const gated = (file, args, opts) => new Promise((resolve) => {
    release = () => resolve(base(file, args, opts));
  });
  const built = build({ tmux: fakeTmux({ present: true }), ptyFactory: gated });
  const port = await listen(built.host);
  const conn = await wsConnect(port, { headers: { "x-fenix-host-token": "tok-123" } });
  await until(() => release !== undefined, 3000, "pty factory reached");
  await conn.ws.close(); // the dashboard goes away mid-setup
  release(); // the pty is created only AFTER the close
  await until(() => base.made[0]?.killed, 3000, "late pty killed");
  eq(base.made.length, 1, "exactly one pty was spawned");
  eq(base.made[0].killed, true, "no orphan tmux client");
  await closeServer(built.host);
});

test("backpressure: output over the buffered cap closes 1009 'client too slow' and kills the pty", async () => {
  const pty = fakePtyFactory();
  const built = build({
    tmux: fakeTmux({ present: true }),
    ptyFactory: pty,
    wsMaxBufferedBytes: 1024 * 1024,
  });
  const port = await listen(built.host);
  const conn = await wsConnect(port, { headers: { "x-fenix-host-token": "tok-123" } });
  await until(() => pty.made.length === 1, 3000, "pty spawned");
  conn.ws._socket.pause(); // the dashboard stopped reading
  const chunk = "x".repeat(1024 * 1024);
  // A paused client never drains its socket, so the host's write buffer (and
  // with it ws.bufferedAmount) grows until the cap trips — then the host
  // closes 1009 and kills the pty.
  for (let i = 0; i < 64 && !pty.made[0].killed; i++) {
    pty.made[0].emitData(chunk);
  }
  await until(() => pty.made[0].killed, 3000, "pty killed on backpressure");
  conn.ws._socket.resume(); // a paused client cannot even read the close frame
  await until(() => conn.closeCode !== null || conn.error, 3000, "closed");
  eq(conn.closeCode, 1009, "close code");
  eq(conn.closeReason, "client too slow", "reason");
  eq(pty.made[0].killed, true, "pty killed");
  await closeServer(built.host);
});

test("heartbeat: a client that misses its pong is terminated and its pty killed", async () => {
  const pty = fakePtyFactory();
  const built = build({
    tmux: fakeTmux({ present: true }),
    ptyFactory: pty,
    wsHeartbeatIntervalMs: 25,
  });
  const port = await listen(built.host);
  const conn = await wsConnect(port, { headers: { "x-fenix-host-token": "tok-123" } });
  await until(() => pty.made.length === 1, 3000, "pty spawned");
  // Swallow everything the client would send back — its automatic pong frame
  // included — so the host sees a silent client behind a dead network.
  conn.ws._socket.write = () => true;
  await until(() => conn.closeCode !== null || conn.error, 3000, "terminated");
  eq(pty.made[0].killed, true, "pty killed after the missed pong");
  await closeServer(built.host);
});

// ── dialogs: GET /dialog, /dialog/answer (FOC-810) ───────────────────────────

console.log("\nsupervisor-host: dialogs");

const PERM = readFixture("permission-bash.txt");
const PERM_ID = parseDialog(PERM).id;
const IDLE = readFixture("idle-after-cancel.txt");
const NUDGE = readFixture("auto-mode-nudge.txt");
const ASK_SINGLE = readFixture("ask-single.txt");
const ASK_Q1 = readFixture("ask-multi-q1.txt");
const ASK_Q2 = readFixture("ask-multi-q2.txt");
const ASK_REVIEW = readFixture("ask-multi-review.txt");
const IDLE_AFTER_ANSWER = readFixture("idle-after-answer.txt");
const TWO_QUESTIONS = [
  {
    question: "Should the export land in v1?",
    multiSelect: false,
    options: [{ label: "Narrow the AC" }, { label: "Finish before landing" }, { label: "Leave as a DoD gap" }],
  },
  {
    question: "Which checks should run before the PR?",
    multiSelect: true,
    options: [{ label: "Unit tests" }, { label: "npm audit" }, { label: "E2E" }],
  },
];

test("GET /dialog: permission pane → the parsed dialog", async () => {
  const { host } = build({ tmux: fakeTmux({ present: true, capture: PERM }) });
  const port = await listen(host);
  const r = await call(port, "GET", "/dialog");
  eq(r.status, 200, "status");
  eq(r.json.dialog.id, PERM_ID, "id matches the parser");
  eq(r.json.dialog.kind, "permission", "kind");
  eq(r.json.dialog.command, "npm audit --json", "command");
  eq(r.json.dialog.options.length, 4, "options");
  await closeServer(host);
});

test("GET /dialog: idle pane → null; unreadable pane → 503 pane-unreadable", async () => {
  const a = build({ tmux: fakeTmux({ present: true, capture: IDLE }) });
  const p1 = await listen(a.host);
  eq(await call(p1, "GET", "/dialog").then((r) => r.json), { dialog: null }, "idle → null");
  await closeServer(a.host);

  const b = build({ tmux: fakeTmux({ present: true, fail: new Set(["capture-pane"]) }) });
  const p2 = await listen(b.host);
  const r = await call(p2, "GET", "/dialog");
  eq(r.status, 503, "unreadable → 503");
  eq(r.json, { error: "pane-unreadable" }, "error");
  await closeServer(b.host);
});

test("answer allow-once presses option key 1 and reports closed", async () => {
  const tmux = fakeTmux({ present: true, captureSeq: [PERM, IDLE] });
  const { host } = build({ tmux });
  const r = await host.answerDialog({ id: PERM_ID, choice: "allow-once" });
  eq(r.status, 200, "status");
  eq(r.body, { sent: true, closed: true }, "body");
  eq(sendKeysArgs(tmux), [["send-keys", "-t", "supervisor", "1"]], "pressed 1");
  assert.ok(!tmux.calls.some((c) => c.args[0] === "load-buffer"), "no paste for a bare answer");
});

test("answer allow-always presses option key 2 (the don't-ask-again option)", async () => {
  const tmux = fakeTmux({ present: true, captureSeq: [PERM, IDLE] });
  const { host } = build({ tmux });
  const r = await host.answerDialog({ id: PERM_ID, choice: "allow-always" });
  eq(r.body, { sent: true, closed: true }, "body");
  eq(sendKeysArgs(tmux), [["send-keys", "-t", "supervisor", "2"]], "pressed 2");
});

test("answer deny presses Escape", async () => {
  const tmux = fakeTmux({ present: true, captureSeq: [PERM, IDLE] });
  const { host } = build({ tmux });
  const r = await host.answerDialog({ id: PERM_ID, choice: "deny" });
  eq(r.body, { sent: true, closed: true }, "body");
  eq(sendKeysArgs(tmux), [["send-keys", "-t", "supervisor", "Escape"]], "Escape");
});

test("answer closed:false when the dialog is still there after the 3 s cap", async () => {
  const tmux = fakeTmux({ present: true, captureSeq: [PERM] });
  const { host } = build({ tmux });
  const r = await host.answerDialog({ id: PERM_ID, choice: "deny" });
  eq(r.body, { sent: true, closed: false }, "reported honestly");
  eq(sendKeysArgs(tmux), [["send-keys", "-t", "supervisor", "Escape"]], "Escape was still pressed");
});

test("answer choice auto-mode → 400 bad-choice, no keys pressed", async () => {
  const tmux = fakeTmux({ present: true, captureSeq: [PERM] });
  const { host } = build({ tmux });
  const r = await host.answerDialog({ id: PERM_ID, choice: "auto-mode" });
  eq(r.status, 400, "status");
  eq(r.body.error, "bad-choice", "error");
  eq(sendKeysArgs(tmux), [], "never pressed the auto-mode option");
});

test("answer with a wrong id → 409 dialog-changed, no keys; no dialog → 409 no-dialog", async () => {
  const a = build({ tmux: fakeTmux({ present: true, captureSeq: [PERM] }) });
  const r = await a.host.answerDialog({ id: "0123456789ab", choice: "allow-once" });
  eq(r.status, 409, "status");
  eq(r.body, { error: "dialog-changed" }, "body");
  eq(sendKeysArgs(a.tmux), [], "no keys");

  const b = build({ tmux: fakeTmux({ present: true, captureSeq: [IDLE] }) });
  const r2 = await b.host.answerDialog({ id: PERM_ID, choice: "deny" });
  eq(r2.status, 409, "status");
  eq(r2.body, { error: "no-dialog" }, "body");
  eq(sendKeysArgs(b.tmux), [], "no keys");
});

test("answer allow-* on a select dialog and deny on an ask dialog → 400 bad-choice", async () => {
  const a = build({ tmux: fakeTmux({ present: true, captureSeq: [NUDGE] }) });
  const r = await a.host.answerDialog({ id: parseDialog(NUDGE).id, choice: "allow-once" });
  eq(r.status, 400, "allow on select refused");
  eq(r.body.error, "bad-choice", "error");
  eq(sendKeysArgs(a.tmux), [], "no keys");

  const b = build({ tmux: fakeTmux({ present: true, captureSeq: [ASK_SINGLE] }) });
  const r2 = await b.host.answerDialog({ id: parseDialog(ASK_SINGLE).id, choice: "deny" });
  eq(r2.status, 400, "deny on ask refused");
  eq(r2.body.error, "bad-choice", "error");
  eq(sendKeysArgs(b.tmux), [], "no keys");
});

test("deny with a note: Escape first, the note pasted once the prompt is back, control chars stripped", async () => {
  const tmux = fakeTmux({ present: true, captureSeq: [PERM, IDLE] });
  const { host } = build({ tmux });
  const r = await host.answerDialog({ id: PERM_ID, choice: "deny", note: "fix\u0000 it\r\nplease" });
  eq(r.status, 200, "status");
  eq(r.body, { sent: true, closed: true, noteSent: true }, "note delivered");
  const keys = sendKeysArgs(tmux);
  eq(keys[0], ["send-keys", "-t", "supervisor", "Escape"], "Escape dismissed the dialog first");
  eq(keys[keys.length - 1], ["send-keys", "-t", "supervisor", "Enter"], "note submitted with Enter");
  const load = tmux.calls.find((c) => c.args[0] === "load-buffer");
  eq(load.input, "fix it\nplease", "the note went through the chat paste path, cleaned");
});

test("deny with an over-long note → 400 bad-note before any key", async () => {
  const tmux = fakeTmux({ present: true, captureSeq: [PERM] });
  const { host } = build({ tmux });
  const r = await host.answerDialog({ id: PERM_ID, choice: "deny", note: "x".repeat(4001) });
  eq(r.status, 400, "status");
  eq(r.body.error, "bad-note", "error");
  eq(sendKeysArgs(tmux), [], "no keys, no paste");
});

test("answer behind the HTTP router, gated like every other action", async () => {
  const tmux = fakeTmux({ present: true, captureSeq: [PERM, IDLE] });
  const { host } = build({ tmux });
  const port = await listen(host);
  const r = await call(port, "POST", "/dialog/answer", { body: { id: PERM_ID, choice: "allow-once" } });
  eq(r.status, 200, "answer status");
  eq(r.json, { sent: true, closed: true }, "answer body");
  await closeServer(host);

  const tmux2 = fakeTmux({ present: true, captureSeq: [ASK_Q1, IDLE_AFTER_ANSWER] });
  const built = build({ tmux: tmux2 });
  const port2 = await listen(built.host);
  const r2 = await call(port2, "POST", "/dialog/ask", {
    body: {
      questions: [TWO_QUESTIONS[0]],
      answers: [{ choices: [1] }],
    },
  });
  eq(r2.status, 200, "ask status");
  eq(r2.json, { answered: true }, "ask body");
  await closeServer(built.host);

  const gated = build({ tmux: fakeTmux({ present: true }), peers: ["10.9.9.9"] });
  const port3 = await listen(gated.host);
  eq((await call(port3, "GET", "/dialog")).status, 403, "peer gate on /dialog");
  eq((await call(port3, "POST", "/dialog/answer", { body: {} })).status, 403, "peer gate on /dialog/answer");
  eq((await call(port3, "POST", "/dialog/ask", { body: {} })).status, 403, "peer gate on /dialog/ask");
  await closeServer(gated.host);
});

test("paneState treats the auto-mode nudge as a dialog (needs-input via the parser)", async () => {
  const { host } = build({
    tmux: fakeTmux({ present: true, capture: NUDGE }),
    stateNow: () => ({ state: "idle", updatedAt: "1970-01-01T00:00:00.000Z", notification: null }),
  });
  const s = host.getState();
  eq(s.dialog, true, "select dialog detected");
  eq(s.promptReady, false, "no free prompt");
  eq(s.state, "needs-input", "effective state");
});

// ── dialogs: /dialog/ask (FOC-810) ────────────────────────────────────────────

console.log("\nsupervisor-host: /dialog/ask");

test("ask: two-question flow q1 → q2 → review → idle sends the planned keys", async () => {
  const tmux = fakeTmux({ present: true, captureSeq: [ASK_Q1, ASK_Q2, ASK_REVIEW, IDLE_AFTER_ANSWER] });
  const { host } = build({ tmux });
  const r = await host.answerAsk({
    questions: TWO_QUESTIONS,
    answers: [{ choices: [0] }, { choices: [0, 1] }],
  });
  eq(r.status, 200, "status");
  eq(r.body, { answered: true }, "answered");
  eq(sendKeysArgs(tmux), [
    ["send-keys", "-t", "supervisor", "1"],
    ["send-keys", "-t", "supervisor", "1"],
    ["send-keys", "-t", "supervisor", "2"],
    ["send-keys", "-t", "supervisor", "Right"],
    ["send-keys", "-t", "supervisor", "1"],
  ], "q1 pick, q2 toggles + advance, review submit");
});

test("ask: a pane that does not show the expected question → 409 with the step, no keys", async () => {
  const tmux = fakeTmux({ present: true, captureSeq: [ASK_Q1] });
  const { host } = build({ tmux });
  const r = await host.answerAsk({
    questions: [{ ...TWO_QUESTIONS[0], question: "Something else entirely?" }, TWO_QUESTIONS[1]],
    answers: [{ choices: [0] }, { choices: [0, 1] }],
  });
  eq(r.status, 409, "status");
  eq(r.body, { error: "dialog-changed", step: 0 }, "step reported");
  eq(sendKeysArgs(tmux), [], "no keys");
});

test("ask: free-text answer sends the Type-something key, the literal with -l, then Enter", async () => {
  const tmux = fakeTmux({ present: true, captureSeq: [ASK_SINGLE, IDLE_AFTER_ANSWER] });
  const { host } = build({ tmux });
  const r = await host.answerAsk({
    questions: [{
      question: "npm audit found 2 critical advisories in devDependencies. What now?",
      multiSelect: false,
      options: [{ label: "Override tinypool" }, { label: "Separate ticket" }, { label: "Upgrade vitest" }],
    }],
    answers: [{ choices: [], text: "Diagnose first, then decide" }],
  });
  eq(r.status, 200, "status");
  eq(r.body, { answered: true }, "answered");
  eq(sendKeysArgs(tmux), [
    ["send-keys", "-t", "supervisor", "4"],
    ["send-keys", "-l", "-t", "supervisor", "Diagnose first, then decide"],
    ["send-keys", "-t", "supervisor", "Enter"],
  ], "option key, literal text, submit");
});

test("ask: a plan that throws → 400 bad-answers with the message, no keys", async () => {
  const tmux = fakeTmux({ present: true, captureSeq: [ASK_Q1] });
  const { host } = build({ tmux });
  const r = await host.answerAsk({ questions: TWO_QUESTIONS, answers: [{ choices: [0] }] });
  eq(r.status, 400, "status");
  eq(r.body.error, "bad-answers", "error");
  assert.match(r.body.message, /lengths must match/, "message from askKeyPlan");
  eq(sendKeysArgs(tmux), [], "no keys");
});

test("ask: the dialog still open after the last step → answered:false", async () => {
  const tmux = fakeTmux({ present: true, captureSeq: [ASK_Q1] });
  const { host } = build({ tmux });
  const r = await host.answerAsk({
    questions: [TWO_QUESTIONS[0]],
    answers: [{ choices: [0] }],
  });
  eq(r.status, 200, "status");
  eq(r.body, { answered: false }, "reported honestly");
  eq(sendKeysArgs(tmux), [["send-keys", "-t", "supervisor", "1"]], "the key was still sent");
});

test("ask: the pane may lag a step — the 2 s settle window retries before any 409", async () => {
  // The acceptance-stack race: the capture right after the step-0 key still
  // shows the previous screen; the redraw lands a moment later.
  const tmux = fakeTmux({
    present: true,
    captureSeq: [ASK_Q1, ASK_Q1, ASK_Q1, ASK_Q2, ASK_REVIEW, IDLE_AFTER_ANSWER],
  });
  const { host, clk } = build({ tmux });
  const r = await host.answerAsk({
    questions: TWO_QUESTIONS,
    answers: [{ choices: [0] }, { choices: [0, 1] }],
  });
  eq(r.status, 200, "status");
  eq(r.body, { answered: true }, "answered");
  eq(sendKeysArgs(tmux), [
    ["send-keys", "-t", "supervisor", "1"],
    ["send-keys", "-t", "supervisor", "1"],
    ["send-keys", "-t", "supervisor", "2"],
    ["send-keys", "-t", "supervisor", "Right"],
    ["send-keys", "-t", "supervisor", "1"],
  ], "the flow completed once the pane settled");
  assert.ok(clk.sleeps.includes(150), "the settle poll slept between captures");
});

test("ask: a mid-flow mismatch that outlives the window → 409 with partial:true, no Escape", async () => {
  const tmux = fakeTmux({ present: true, captureSeq: [ASK_Q1, ASK_Q1] });
  const { host } = build({ tmux });
  const r = await host.answerAsk({
    questions: TWO_QUESTIONS,
    answers: [{ choices: [0] }, { choices: [0, 1] }],
  });
  eq(r.status, 409, "status");
  eq(r.body, { error: "dialog-changed", step: 1, partial: true }, "step + partial");
  eq(sendKeysArgs(tmux), [["send-keys", "-t", "supervisor", "1"]], "only step 0's key was sent");
});

test("ask: a pane already on question 2 (tab 1 done) resumes the plan → resumedFrom:1", async () => {
  const tmux = fakeTmux({ present: true, captureSeq: [ASK_Q2, ASK_Q2, ASK_REVIEW, IDLE_AFTER_ANSWER] });
  const { host } = build({ tmux });
  const r = await host.answerAsk({
    questions: TWO_QUESTIONS,
    answers: [{ choices: [0] }, { choices: [0, 1] }],
  });
  eq(r.status, 200, "status");
  eq(r.body, { answered: true, resumedFrom: 1 }, "the first answer was already applied");
  eq(sendKeysArgs(tmux), [
    ["send-keys", "-t", "supervisor", "1"],
    ["send-keys", "-t", "supervisor", "2"],
    ["send-keys", "-t", "supervisor", "Right"],
    ["send-keys", "-t", "supervisor", "1"],
  ], "only q2's toggles and the review submit were sent");
});

test("ask: a pane already on the review screen resumes there → resumedFrom:2", async () => {
  const tmux = fakeTmux({ present: true, captureSeq: [ASK_REVIEW, ASK_REVIEW, IDLE_AFTER_ANSWER] });
  const { host } = build({ tmux });
  const r = await host.answerAsk({
    questions: TWO_QUESTIONS,
    answers: [{ choices: [0] }, { choices: [0, 1] }],
  });
  eq(r.status, 200, "status");
  eq(r.body, { answered: true, resumedFrom: 2 }, "both answers were already applied");
  eq(sendKeysArgs(tmux), [["send-keys", "-t", "supervisor", "1"]], "only the review submit");
});

test("ask: a later question whose earlier tabs are NOT done is not a resume → 409 step 0", async () => {
  // Question 2 on screen but tab 1 unchecked: nothing proves question 1 was
  // answered, so the pane matches nothing in the plan.
  const stale = readFixture("ask-multi-q2.txt").replace("☒ Export", "☐ Export");
  const tmux = fakeTmux({ present: true, captureSeq: [stale] });
  const { host } = build({ tmux });
  const r = await host.answerAsk({
    questions: TWO_QUESTIONS,
    answers: [{ choices: [0] }, { choices: [0, 1] }],
  });
  eq(r.status, 409, "status");
  eq(r.body, { error: "dialog-changed", step: 0 }, "no resume without the done tabs");
  eq(sendKeysArgs(tmux), [], "no keys");
});

// ── slash commands from the chat (FOC-810) ────────────────────────────────────

console.log("\nsupervisor-host: slash commands");

const IDLE_HOOK = () => ({ state: "idle", updatedAt: "1970-01-01T00:00:00.000Z", notification: null });

test("slash: /context is pasted and its scrollback output returned", async () => {
  const context = readFixture("slash-context-scrollback.txt");
  const tmux = fakeTmux({ present: true, captureSeq: [READY_PANE, context] });
  const { host } = build({ tmux, stateNow: IDLE_HOOK });
  const r = await host.sendMessage("/context");
  eq(r.status, 200, "status");
  eq(r.body.sent, true, "sent");
  eq(r.body.confirmed, true, "the rendered output is the confirmation");
  eq(r.body.output, extractCommandOutput(context, "/context"), "output from the scrollback");
  const load = tmux.calls.find((c) => c.args[0] === "load-buffer");
  eq(load.input, "/context", "pasted as-is");
  assert.ok(!sendKeysArgs(tmux).some((a) => a[3] === "Escape"), "no Escape for a non-modal command");
});

test("slash: /cost returns the panel output and Esc-closes the modal", async () => {
  const cost = readFixture("slash-cost-scrollback.txt");
  const tmux = fakeTmux({ present: true, captureSeq: [READY_PANE, cost] });
  const { host } = build({ tmux, stateNow: IDLE_HOOK });
  const r = await host.sendMessage("/cost");
  eq(r.status, 200, "status");
  eq(r.body.confirmed, true, "confirmed");
  eq(r.body.output, extractCommandOutput(cost, "/cost"), "panel output");
  const keys = sendKeysArgs(tmux);
  eq(keys[keys.length - 1], ["send-keys", "-t", "supervisor", "Escape"], "Escape closed the modal last");
});

test("slash: a refused command is 400 with the allowed list and touches nothing", async () => {
  const tmux = fakeTmux({ present: true });
  const { host } = build({ tmux });
  const r = await host.sendMessage("/exit");
  eq(r.status, 400, "status");
  eq(r.body.error, "slash-command", "error");
  eq(r.body.message, "only /compact, /context and /cost can be sent from the chat", "allowed list");
  eq(tmux.calls, [], "no tmux call at all");
});

test("slash: /compact keeps the hook confirmation path (no output, no Escape)", async () => {
  const tmux = fakeTmux({ present: true, captureSeq: [READY_PANE] });
  const clk = fakeClock();
  let sent = false;
  const { host } = build({
    tmux,
    clk,
    stateNow: () => (sent
      ? { state: "busy", updatedAt: iso(clk), notification: null }
      : IDLE_HOOK()),
  });
  tmux.onCall = (args) => {
    if (args[0] === "send-keys") sent = true;
  };
  const r = await host.sendMessage("/compact focus tests");
  eq(r.status, 200, "status");
  eq(r.body, { sent: true, confirmed: true, queued: false }, "hook-confirmed");
  assert.ok(!("output" in r.body), "no output field for /compact");
  assert.ok(!sendKeysArgs(tmux).some((a) => a[3] === "Escape"), "no Escape");
});

test("slash: an allowed command still hits the dialog check → 409", async () => {
  const tmux = fakeTmux({ present: true, capture: DIALOG_PANE });
  const { host } = build({ tmux, stateNow: IDLE_HOOK });
  const r = await host.sendMessage("/context");
  eq(r.status, 409, "status");
  eq(r.body.error, "needs-input", "error");
  eq(tmux.calls.map((c) => c.args[0]), ["has-session", "capture-pane"], "refused before any paste");
});

// ── parked-prompt auto-deny (FOC-920) ────────────────────────────────────────

console.log("\nsupervisor-host: parked-prompt auto-deny (FOC-920)");

// A permission dialog the parser actually frames (bottom rule) — the inline
// DIALOG_PANE above carries the markers but no rule, so parseDialog gives
// null for it and the watchdog (which re-parses the pane) must not see it.
const PARK_RULE = "─".repeat(60);
const PARK_PANE = [
  "",
  PARK_RULE,
  " Ask rule Bash(git push:*) overrides auto mode for this command.",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. No",
  " Esc to cancel · Tab to amend",
  "",
].join("\n");
const PARK_DIALOG = parseDialog(PARK_PANE);

const parkedNote = (reasonText, minutes) =>
  `FOC-920 auto-deny: this permission prompt (${reasonText}) waited ${minutes} min with nobody attached and was answered No by the host (taskSessions.parkedPrompt = deny-after). Record it in your report; if the denied action was needed, leave the work in a resumable state and escalate it as one specific question.`;

// One host pointed at a throwaway session home; the watchdog interval is
// parked far out — tests drive checkParkedPrompt() directly. The clock is
// advanced AFTER the host exists (FOC-920: the deny clock is floored at the
// host's start, so the wait only accrues while THIS host has been running);
// the hook file reports needs-input with updatedAt `sinceMs` in the past of
// the CURRENT clock tick, so the anchor needs no warm-up call.
const parkedHost = ({ tmuxInit = {}, policy, sinceMs = 0, advanceMs = sinceMs, env: extraEnv = {} } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "la-host-parked-"));
  const clk = fakeClock();
  const built = build({
    tmux: fakeTmux({ present: true, ...tmuxInit }),
    clk,
    env: { LA_DATA_HOME: dir, ...extraEnv },
    parkedCheckMs: 3_600_000,
    readParkedPolicy: policy
      ? () => policy
      : () => { throw new Error("no policy configured for this test"); },
    stateNow: () => ({
      state: "needs-input",
      updatedAt: new Date(clk.t - sinceMs).toISOString(),
      notification: null,
    }),
  });
  clk.t += advanceMs;
  return { ...built, dir };
};

const denialRows = (dir) =>
  readFileSync(join(dir, "supervisor", "parked-denials.jsonl"), "utf8")
    .trim().split("\n").map((l) => JSON.parse(l));

test("parked: mode wait → no keys, no paste, no jsonl; /state shows the policy and a null autoDenial", async () => {
  const { host, tmux, dir } = parkedHost({
    tmuxInit: { capture: PARK_PANE },
    policy: { mode: "wait", minutes: 30 },
    sinceMs: 60 * 60_000, // parked an hour — still never answered in wait mode
  });
  try {
    eq(await host.checkParkedPrompt(), { action: "none" }, "no action");
    eq(sendKeysArgs(tmux), [], "no keystrokes");
    assert.ok(!tmux.calls.some((c) => c.args[0] === "load-buffer"), "no paste");
    assert.ok(!existsSync(join(dir, "supervisor", "parked-denials.jsonl")), "no jsonl");
    const port = await listen(host);
    const s = await call(port, "GET", "/state");
    eq(s.json.autoDenial, null, "no denial on /state");
    eq(s.json.parkedPolicy, { mode: "wait", minutes: 30 }, "policy on /state");
    await closeServer(host);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parked: deny-after at 29 of 30 min → nothing yet", async () => {
  const { host, tmux, dir } = parkedHost({
    tmuxInit: { capture: PARK_PANE },
    policy: { mode: "deny-after", minutes: 30 },
    sinceMs: 29 * 60_000,
  });
  try {
    eq(await host.checkParkedPrompt(), { action: "none" }, "still inside the window");
    eq(sendKeysArgs(tmux), [], "no keystrokes");
    assert.ok(!existsSync(join(dir, "supervisor", "parked-denials.jsonl")), "no jsonl");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parked: deny-after at 31 min → Escape, the note pasted, one jsonl row, /state autoDenial", async () => {
  // getState's pane probe, the watchdog's re-read and answerDialog's own
  // capture all see the dialog; the close-poll and the note's prompt wait
  // see the free pane.
  const tmuxInit = { captureSeq: [PARK_PANE, PARK_PANE, PARK_PANE, READY_PANE] };
  const { host, tmux, dir } = parkedHost({
    tmuxInit,
    policy: { mode: "deny-after", minutes: 30 },
    sinceMs: 31 * 60_000,
  });
  try {
    const r = await host.checkParkedPrompt();
    eq(r.action, "denied", "denied");
    eq(r.denial.dialogId, PARK_DIALOG.id, "the parsed dialog's id");
    const keys = sendKeysArgs(tmux);
    assert.ok(keys.some((a) => a[3] === "Escape"), "Escape dismissed the dialog");
    eq(keys[keys.length - 1], ["send-keys", "-t", "supervisor", "Enter"], "note submitted with Enter");
    const load = tmux.calls.find((c) => c.args[0] === "load-buffer");
    eq(load.input, parkedNote("ask-rule: Bash(git push:*)", 30), "the exact note text");
    const rows = denialRows(dir);
    eq(rows.length, 1, "one jsonl row");
    eq(rows[0], {
      ts: rows[0].ts,
      since: rows[0].since,
      minutes: 30,
      dialogId: PARK_DIALOG.id,
      kind: "permission",
      reason: PARK_DIALOG.reason,
      status: 200,
      closed: true,
    }, "row shape");
    const port = await listen(host);
    const s = await call(port, "GET", "/state");
    eq(s.json.autoDenial, rows[0], "autoDenial surfaced on /state");
    eq(s.json.parkedPolicy, { mode: "deny-after", minutes: 30 }, "policy on /state");
    await closeServer(host);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parked: answerDialog 409 (pane changed) → nothing recorded, no key latch; the next tick denies", async () => {
  // Captures 1-2: the watchdog sees the dialog; capture 3: answerDialog's
  // locked re-capture sees a free pane (the pane changed between the parse
  // and the re-capture) → 409 nothing-pressed. Capture 4 is the test's own
  // getState assertion; the next tick re-reads the same dialog and denies it
  // for real (captures 5-7, then the close-poll sees the free pane).
  const tmuxInit = { captureSeq: [PARK_PANE, PARK_PANE, READY_PANE, PARK_PANE, PARK_PANE, PARK_PANE, PARK_PANE, READY_PANE] };
  const { host, tmux, dir } = parkedHost({
    tmuxInit,
    policy: { mode: "deny-after", minutes: 30 },
    sinceMs: 31 * 60_000,
  });
  try {
    eq(await host.checkParkedPrompt(), { action: "retry", status: 409 }, "reported as a retry, not a denial");
    eq(sendKeysArgs(tmux), [], "nothing was pressed");
    assert.ok(!tmux.calls.some((c) => c.args[0] === "load-buffer"), "no note pasted");
    assert.ok(!existsSync(join(dir, "supervisor", "parked-denials.jsonl")), "no jsonl row for a 409");
    eq(host.getState().autoDenial, null, "no autoDenial on /state after a 409");
    const r = await host.checkParkedPrompt();
    eq(r.action, "denied", "the same dialog (same id) is denied on the next tick — the key was not latched");
    eq(denialRows(dir).length, 1, "exactly one jsonl row");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parked: a stale hook anchor older than the host waits from host start (FOC-920 F2)", async () => {
  // The hook says the prompt has been there for 2.5 h — longer than the host
  // has existed. The deny clock is floored at the host's start: nothing at
  // host start + 1 min, denied only at host start + 31 min.
  const tmuxInit = { captureSeq: [PARK_PANE, PARK_PANE, PARK_PANE, PARK_PANE, PARK_PANE, READY_PANE] };
  const { host, tmux, dir, clk } = parkedHost({
    tmuxInit,
    policy: { mode: "deny-after", minutes: 30 },
    sinceMs: 2 * 60 * 60_000 + 31 * 60_000,
    advanceMs: 60_000,
  });
  try {
    eq(await host.checkParkedPrompt(), { action: "none" }, "nothing at host start + 1 min despite the 2.5 h hook anchor");
    eq(sendKeysArgs(tmux), [], "no keystrokes yet");
    clk.t += 30 * 60_000;
    const r = await host.checkParkedPrompt();
    eq(r.action, "denied", "denied at host start + 31 min");
    const rows = denialRows(dir);
    eq(rows.length, 1, "one jsonl row");
    // The reported anchor keeps the hook's timestamp (host start + 1 min
    // minus the 2 h 31 min hook age = 2.5 h before the host started).
    eq(rows[0].since, new Date(1_700_000_000_000 + 60_000 - (2 * 60 * 60_000 + 31 * 60_000)).toISOString(),
      "the record anchors on the hook timestamp, not the host start");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parked: a secret in reason.detail is redacted in the jsonl row, on /state and in the note", async () => {
  // Built at runtime so the canary cannot match a scanner over this file.
  const canary = "ghp_".concat("9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c", "3fXX");
  const pane = [
    "",
    PARK_RULE,
    ` Ask rule Bash(echo ${canary}:*) overrides auto mode for this command.`,
    " Do you want to proceed?",
    " ❯ 1. Yes",
    "   2. No",
    " Esc to cancel · Tab to amend",
    "",
  ].join("\n");
  const { host, tmux, dir } = parkedHost({
    tmuxInit: { captureSeq: [pane, pane, pane, READY_PANE] },
    policy: { mode: "deny-after", minutes: 30 },
    sinceMs: 31 * 60_000,
  });
  try {
    const r = await host.checkParkedPrompt();
    eq(r.action, "denied", "denied");
    const rows = denialRows(dir);
    assert.ok(!JSON.stringify(rows).includes(canary), "the canary never lands in the jsonl");
    assert.ok(rows[0].reason.detail.includes("[redacted]"), "the detail carries the [redacted] span");
    const port = await listen(host);
    const s = await call(port, "GET", "/state");
    assert.ok(!JSON.stringify(s.json.autoDenial).includes(canary), "the canary never lands on /state");
    await closeServer(host);
    const load = tmux.calls.find((c) => c.args[0] === "load-buffer");
    assert.ok(!load.input.includes(canary), "the pasted note carries no secret either");
    assert.ok(load.input.includes("[redacted]"), "the note shows the redacted span");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parked: the same dialog still on screen → no second deny, one row", async () => {
  // The dialog never closes (capture repeats), so the second check must be
  // held back by the last-denied key alone.
  const { host, tmux, dir } = parkedHost({
    tmuxInit: { capture: PARK_PANE },
    policy: { mode: "deny-after", minutes: 30 },
    sinceMs: 31 * 60_000,
  });
  try {
    const r1 = await host.checkParkedPrompt();
    eq(r1.action, "denied", "first deny");
    eq(r1.denial.closed, false, "reported honestly: the dialog never closed");
    const escapes = () => sendKeysArgs(tmux).filter((a) => a[3] === "Escape").length;
    eq(escapes(), 1, "one Escape");
    const r2 = await host.checkParkedPrompt();
    eq(r2.action, "none", "no re-deny of the same dialog");
    eq(escapes(), 1, "still one Escape");
    eq(denialRows(dir).length, 1, "still one row");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parked: a select dialog parked 60 min is never auto-answered", async () => {
  const { host, tmux, dir } = parkedHost({
    tmuxInit: { capture: NUDGE },
    policy: { mode: "deny-after", minutes: 30 },
    sinceMs: 60 * 60_000,
  });
  try {
    eq(host.getState().state, "needs-input", "the select dialog does park the session");
    eq(await host.checkParkedPrompt(), { action: "none" }, "select is never denied");
    eq(sendKeysArgs(tmux), [], "no keystrokes");
    assert.ok(!existsSync(join(dir, "supervisor", "parked-denials.jsonl")), "no jsonl");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parked: a throwing policy reader is swallowed once logged; the host keeps serving", async () => {
  const { host, tmux, dir } = parkedHost({
    tmuxInit: { capture: PARK_PANE },
    sinceMs: 60 * 60_000,
  });
  // parkedHost without a policy injects a throwing reader.
  try {
    eq(await host.checkParkedPrompt(), { action: "none" }, "swallowed");
    eq(sendKeysArgs(tmux), [], "no keystrokes");
    assert.ok(!existsSync(join(dir, "supervisor", "parked-denials.jsonl")), "no jsonl");
    const port = await listen(host);
    eq((await call(port, "GET", "/healthz")).status, 200, "healthz fine");
    await closeServer(host);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parked: after a restart the last jsonl row is autoDenial on /state; a torn last line falls back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "la-host-parked-"));
  try {
    mkdirSync(join(dir, "supervisor"), { recursive: true });
    const path = join(dir, "supervisor", "parked-denials.jsonl");
    const mk = (env) => build({
      tmux: fakeTmux({ present: true }),
      env,
      parkedCheckMs: 3_600_000,
    }).host;
    writeFileSync(path, '{"ts":"2026-10-19T10:00:00.000Z","dialogId":"a"}\n{"ts":"2026-10-19T11:00:00.000Z","dialogId":"b"}\n');
    eq(mk({ LA_DATA_HOME: dir }).getState().autoDenial.dialogId, "b", "last row wins");
    writeFileSync(path, '{"dialogId":"a"}\n{"dialogId":"b"\n'); // torn trailing line
    eq(mk({ LA_DATA_HOME: dir }).getState().autoDenial.dialogId, "a", "torn last line → previous row");
    writeFileSync(path, "not json at all\n");
    eq(mk({ LA_DATA_HOME: dir }).getState().autoDenial, null, "unparseable file → null");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── runner ────────────────────────────────────────────────────────────────────

let passed = 0;
const failures = [];
for (const [name, fn] of tests) {
  try {
    await fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

console.log(`\nsupervisor-host: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("FAILURES:\n - " + failures.join("\n - "));
  process.exit(1);
}
// Upgraded WebSocket sockets are not tracked by server.closeAllConnections(),
// so a laggard client socket would hold the event loop open forever after a
// green run — end the suite explicitly instead.
process.exit(0);
