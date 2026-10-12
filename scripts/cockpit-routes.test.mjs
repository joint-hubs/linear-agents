// Route-level tests for the Cockpit endpoints (telemetry-server.mjs's FOC-783
// block, implemented in cockpit-routes.mjs).
//
// Spawns the REAL telemetry-server (three times: Docker mode against a fake
// session host, native mode without FENIX_SUPERVISOR_HOST, and Docker mode
// against a dead port) with fully isolated seams — LA_TELEMETRY_DB,
// LA_DATA_HOME (session.json + host token), LA_SQUAD_HOME (transcript
// confinement), LA_SUPERVISOR_STATE_HOME (runs/gates/holds/wake queue) and
// LA_STATE_ROOT under one tmp dir — so the production server, the live stores
// and the repo's real .state tree are never touched.
//
// The fake session host is an in-process node:http server on 127.0.0.1:0 that
// records every call (method, url, token header, body) and answers per a
// mutable behaviour map; its 'upgrade' event acts as the raw WebSocket upstream
// for the terminal-proxy test (raw sockets, no WebSocketServer — test-run.mjs).
//
// Proven here, over HTTP and raw sockets:
//   - GET /api/cockpit: shape, probe via the host's /alive, native probe,
//     host down → children "unknown", the host's real /state shape (effective
//     state on top, sessionId/notification/clients from the hook, an absent
//     session reporting "absent"), supervisor.host reachable/unreachable/
//     not-docker, waker lease state, wake backlog, redaction of gate text;
//     the current-run record (FOC-807): runId/runSource/waker/backlog/
//     wakeOldestAt/model follow the record, the Wake prompt targets its run,
//     the focus heuristic stands in when no record exists;
//     the 2 s TTL cache: two requests in the TTL build once (single-flight),
//     a request past the TTL rebuilds, an error is never cached;
//   - GET /api/supervisor/conversation: entries + redaction, byte-offset
//     paging, param validation, and path confinement (outside agents/supervisor
//     or not .jsonl → no transcript);
//   - POST /api/supervisor/message and /session: pass-through of the host's
//     status/body (200, 409 needs-input), 503 host-unreachable, 503
//     docker-only natively, fresh requires confirm:"new-session";
//   - POST /api/gates/answer and /api/holds/answer: happy path (gate recorded
//     with answeredBy "dashboard", audit row notified:true, the FOC-449
//     decision-event label written like the CLI's answer, the Supervisor's
//     notice carries the waker's wording), host-down → notified:false, the
//     409 of answering twice, and a held answer lock → 503 busy (lockWaitMs 0);
//   - POST /api/gates/notify: 404 missing, 409 still pending/open, 200
//     answered — for gates (gateId) and holds (holdId); both or neither id → 400;
//   - foreign Origin → 403 on every POST route;
//   - WS /api/supervisor/terminal upgrade: rejected without Origin, with an
//     Origin on another local port, with a non-loopback Host; the accepted one
//     is proxied (101 + echo, token forwarded, Origin NOT forwarded, cols/rows
//     clamped).
//
// The server children are ALWAYS killed in finally.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import net from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { openTelemetryDb } from "./telemetry-store.mjs";
import { ensureViews } from "./telemetry-canonical.mjs";
import { writeCurrentRun } from "./supervisor-current-run.mjs";
import { hostTokenPath } from "./fenix-paths.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) { passed++; return; }
  failed++;
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

// ── fixtures: one tmp tree for every seam ────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), "cockpit-routes-"));
const dataHome = join(dir, "data"); // LA_DATA_HOME: session.json + host.token
const squadHome = join(dir, "agents"); // LA_SQUAD_HOME: transcript confinement root
const supState = join(dir, "sup-state"); // LA_SUPERVISOR_STATE_HOME: runs
const runsDir = join(dir, "state-root", "runs"); // LA_STATE_ROOT
const dbPath = join(dir, "telemetry.sqlite");

mkdirSync(join(dataHome, "supervisor"), { recursive: true });
mkdirSync(join(dataHome, "run"), { recursive: true });
mkdirSync(join(squadHome, "supervisor", "projects"), { recursive: true });
mkdirSync(join(supState, "run-1", "gates"), { recursive: true });
mkdirSync(join(supState, "run-1", "children"), { recursive: true });
mkdirSync(join(supState, "run-2", "gates"), { recursive: true });
mkdirSync(join(supState, "run-2", "children"), { recursive: true });
mkdirSync(runsDir, { recursive: true });

// A valid sqlite store so the server's own bootstrap has somewhere to go.
{
  const db = openTelemetryDb(dbPath);
  ensureViews(db);
  db.close();
}

const TOKEN = "cockpit-test-token-123";
writeFileSync(hostTokenPath({ LA_DATA_HOME: dataHome }), TOKEN, "utf8");

const LIVE_PID = process.pid; // alive on any platform, including the child's probe
const NOW = new Date().toISOString();
const SECRET = "sk-SECRET123xyz";

// run-1: one live child, one pending question gate, a wake queue with two
// un-acked rows, a live waker lease, the focus ticket — the whole panel.
writeFileSync(join(supState, "run-1", "children.json"), JSON.stringify({
  runId: "run-1",
  children: {
    "child-1": {
      childId: "child-1", squad: "dev", taskId: "FIX-42", status: "running",
      pid: LIVE_PID, model: "m1", startedAt: NOW, turns: [],
    },
    // No gate for this one — the probe (not a gate) decides its status.
    "child-1b": {
      childId: "child-1b", squad: "review", taskId: "FIX-42", status: "running",
      pid: LIVE_PID, model: "m1", startedAt: NOW, turns: [],
    },
  },
  rounds: {},
}), "utf8");
writeFileSync(join(supState, "run-1", "children", "child-1.jsonl"), "", "utf8");
writeFileSync(join(supState, "run-1", "children", "child-1b.jsonl"), "", "utf8");
writeFileSync(join(supState, "run-1", "triage.json"), JSON.stringify({ issue: "FIX-42" }), "utf8");
writeFileSync(join(supState, "run-1", "gates", "gate-1.json"), JSON.stringify({
  gateId: "gate-1", runId: "run-1", childId: "child-1", taskId: "FIX-42",
  kind: "question", status: "pending", createdAt: NOW,
  summary: `Which DB? echo ${SECRET}`,
  questions: ["which database should dev use?"],
  // FOC-449 provenance: the answer must label this event (by:"human", via:"gate").
  decisionEvents: [{ eventId: "ev-gate-1", runId: "run-1" }],
}), "utf8");
// The decision log the label lands in (LA_DECISION_RUNS_DIR): one event line
// for ev-gate-1, so appendLabel's findEventFile finds it.
mkdirSync(join(runsDir, "run-1"), { recursive: true });
writeFileSync(join(runsDir, "run-1", "decisions.jsonl"), `${JSON.stringify({
  type: "event", eventId: "ev-gate-1", decisionId: "test.pick-db", ts: NOW, ok: true,
})}\n`, "utf8");
writeFileSync(join(supState, "run-1", "wake-queue.jsonl"), [
  JSON.stringify({ seq: 1, event: "exit", childId: "child-0", turn: 1, dedupKey: "exit:child-0:1", detail: {}, ts: NOW }),
  JSON.stringify({ seq: 2, event: "gate", gateId: "gate-1", dedupKey: "gate:gate-1", detail: {}, ts: NOW }),
  "",
].join("\n"), "utf8");
writeFileSync(join(supState, "run-1", "waker.json"), JSON.stringify({
  pid: LIVE_PID, sessionId: "waker-sess", startedAt: NOW, heartbeatAt: NOW, firedThrough: 0,
}), "utf8");
writeFileSync(join(supState, "run-1", "holds.json"), JSON.stringify({
  version: 1,
  holds: [{
    id: "hold-1", origin: "test", question: "switch the pricing source?",
    recommendation: "yes", options: [{ label: "switch", model: "m1", costUsd: 0 }],
    impact: "high", state: "open", createdAt: NOW, presentedAt: null, until: null,
    answer: null, history: [{ event: "created", at: NOW }], blocks: null, resolution: null,
  }],
}), "utf8");

// run-2: the host-down scenario's gate (answered in Docker mode against a dead
// host — notified must come out false).
writeFileSync(join(supState, "run-2", "gates", "gate-2.json"), JSON.stringify({
  gateId: "gate-2", runId: "run-2", childId: "child-9", taskId: "FIX-43",
  kind: "question", status: "pending", createdAt: NOW, summary: "pick a port",
  questions: ["which port?"],
}), "utf8");
writeFileSync(join(supState, "run-2", "children.json"), JSON.stringify({
  runId: "run-2",
  children: {
    "child-2": {
      childId: "child-2", squad: "dev", taskId: "FIX-43", status: "running",
      pid: LIVE_PID, model: "m1", startedAt: NOW, turns: [],
    },
  },
  rounds: {},
}), "utf8");
writeFileSync(join(supState, "run-2", "children", "child-2.jsonl"), "", "utf8");

// The Supervisor's session record + a real-shape transcript inside the
// confinement root, plus an outside file for the refusal case.
const transcriptPath = join(squadHome, "supervisor", "projects", "sess-1.jsonl");
const outsidePath = join(dir, "outside.jsonl");
writeFileSync(transcriptPath, [
  JSON.stringify({ type: "user", uuid: "u1", timestamp: NOW, message: { content: `check status with token ${SECRET}` } }),
  JSON.stringify({ type: "assistant", uuid: "a1", timestamp: NOW, message: { content: [{ type: "text", text: "On it." }] } }),
  "",
].join("\n"), "utf8");

function writeSession(extra = {}) {
  writeFileSync(join(dataHome, "supervisor", "session.json"), JSON.stringify({
    sessionId: "sess-1", transcriptPath, cwd: dir, state: "idle",
    notification: null, updatedAt: NOW, ...extra,
  }), "utf8");
}
writeSession();

// ── the fake session host ────────────────────────────────────────────────────

const hostCalls = []; // { method, url, token, body }
const hostUpgrades = []; // { url, headers }

const fakeHost = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  let body = null;
  try { body = JSON.parse(raw); } catch { body = raw || null; }
  hostCalls.push({ method: req.method, url: req.url, token: req.headers["x-fenix-host-token"] ?? null, body });

  if (req.url === "/state") {
    // The REAL host shape (supervisor-host.mjs getState): the effective state
    // at the top level, the session hook record under `hook`, tmux clients as
    // a list. fakeHostBehavior.state overrides it for the absent-session case.
    const b = fakeHostBehavior.state ?? {
      status: 200,
      body: {
        session: "running",
        panePid: 4242,
        paneDead: false,
        clients: ["tmux-dash-1"],
        hook: { sessionId: "sess-host-1", transcriptPath: "", cwd: dir, state: "idle", notification: null, updatedAt: NOW },
        state: "idle",
      },
    };
    res.writeHead(b.status, { "content-type": "application/json" });
    res.end(JSON.stringify(b.body));
    return;
  }
  if (req.url === "/alive") {
    const pids = Array.isArray(body?.pids) ? body.pids : [];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(Object.fromEntries(pids.map((p) => [String(p), true]))));
    return;
  }
  if (req.url === "/message") {
    const b = fakeHostBehavior.message ?? { status: 200, body: { sent: true, confirmed: true, queued: false } };
    res.writeHead(b.status, { "content-type": "application/json" });
    res.end(JSON.stringify(b.body));
    return;
  }
  if (req.url === "/session") {
    const b = fakeHostBehavior.session ?? { status: 200, body: { ready: true } };
    res.writeHead(b.status, { "content-type": "application/json" });
    res.end(JSON.stringify(b.body));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

// The raw WebSocket upstream: answers the proxy's handshake itself, then echoes
// every byte — enough to prove the pipe both ways without a WS library.
fakeHost.on("upgrade", (req, socket) => {
  hostUpgrades.push({ url: req.url, headers: { ...req.headers } });
  // A server-side socket with no 'error' listener dies on a client RST
  // (read ECONNRESET) — the exact crash this suite guards against.
  socket.on("error", () => socket.destroy());
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
  socket.pipe(socket);
});

const fakeHostBehavior = {};

await new Promise((resolve) => fakeHost.listen(0, "127.0.0.1", resolve));
const hostPort = fakeHost.address().port;
const HOST_URL = `http://127.0.0.1:${hostPort}`;

// A port with nothing behind it, for the host-down scenario.
const deadPort = await new Promise((resolve) => {
  const probe = createServer();
  probe.listen(0, "127.0.0.1", () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

// ── server spawns ────────────────────────────────────────────────────────────

const baseEnv = {
  ...process.env,
  LA_TELEMETRY_DB: dbPath,
  LA_TELEMETRY_HOME: join(dir, "telemetry-home"),
  LA_DATA_HOME: dataHome,
  LA_SQUAD_HOME: squadHome,
  LA_SUPERVISOR_STATE_HOME: supState,
  LA_STATE_ROOT: join(dir, "state-root"),
  LA_DECISION_RUNS_DIR: runsDir,
};
delete baseEnv.LA_ANALYSIS_CACHE;

function spawnServer(env) {
  const freePortP = new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
  return freePortP.then((port) => new Promise((resolve) => {
    const child = spawn(process.execPath, [join(__dir, "telemetry-server.mjs")], {
      env: { ...env, TELEMETRY_PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("exit", (code) => { if (code !== 0 && code !== null) child._exitCode = code; });
    resolve({ child, port, stderr });
  }));
}

async function waitForServer(port, child, ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode})`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/telemetry/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("server not ready");
}

async function call(port, method, path, { origin = "http://localhost:5173", body } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(origin ? { origin } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json };
}

// Raw-socket helpers for the upgrade tests (no WebSocketServer — test-run.mjs).
function rawUpgrade(port, requestText) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let buf = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("upgrade timeout")); }, 5000);
    socket.on("error", (e) => { clearTimeout(timer); reject(e); });
    socket.on("connect", () => socket.write(requestText));
    socket.on("data", function onData(c) {
      buf += c.toString("latin1");
      const idx = buf.indexOf("\r\n\r\n");
      if (idx === -1) return;
      clearTimeout(timer);
      socket.removeListener("data", onData);
      resolve({ head: buf.slice(0, idx), rest: buf.slice(idx + 4), socket });
    });
  });
}

function upgradeRequest({ host, origin, extra = "" }) {
  return [
    "GET /api/supervisor/terminal?cols=9999&rows=1 HTTP/1.1",
    `Host: ${host}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    "Sec-WebSocket-Version: 13",
    ...(origin ? [`Origin: ${origin}`] : []),
    ...(extra ? [extra] : []),
    "",
    "",
  ].join("\r\n");
}

// ── run the three scenarios ──────────────────────────────────────────────────

let servers = [];
try {
  // ── Docker mode, host reachable ──────────────────────────────────────────
  {
    const { child, port } = await spawnServer({ ...baseEnv, FENIX_SUPERVISOR_HOST: HOST_URL });
    servers.push(child);
    await waitForServer(port, child);
    const P = port;

    // GET /api/cockpit — full shape, probe through the host, redaction.
    const snap = await call(P, "GET", "/api/cockpit");
    check("cockpit -> 200", snap.status === 200, JSON.stringify(snap.body).slice(0, 200));
    check("cockpit shape", ["supervisor", "needsYou", "children", "counts", "checkedAt"].every((k) => k in snap.body),
      Object.keys(snap.body ?? {}).join(","));
    check("cockpit supervisor.host reachable", snap.body?.supervisor?.host === "reachable", snap.body?.supervisor?.host);
    check("cockpit supervisor state/session via host",
      snap.body?.supervisor?.state === "idle" && snap.body?.supervisor?.sessionId === "sess-host-1",
      JSON.stringify(snap.body?.supervisor));
    check("cockpit supervisor clients from the host's /state",
      JSON.stringify(snap.body?.supervisor?.clients) === '["tmux-dash-1"]',
      JSON.stringify(snap.body?.supervisor?.clients));

    // A dead/absent session: the host's top-level state wins ("absent"), the
    // hook's stale state/notification do not leak through — sessionId still
    // comes from the hook, notification from the hook too. The snapshot is
    // served from a 2 s TTL cache now, so the flipped host state is only seen
    // after the TTL lapses.
    fakeHostBehavior.state = {
      status: 200,
      body: {
        session: "absent", panePid: null, paneDead: null, clients: [],
        hook: { sessionId: "sess-host-1", transcriptPath: "", cwd: dir, state: "busy", notification: "stale", updatedAt: NOW },
        state: "absent",
      },
    };
    await new Promise((r) => setTimeout(r, 2100));
    const snapAbsent = await call(P, "GET", "/api/cockpit");
    check("cockpit absent session -> state absent, hook state ignored",
      snapAbsent.body?.supervisor?.state === "absent" && snapAbsent.body?.supervisor?.sessionId === "sess-host-1"
        && snapAbsent.body?.supervisor?.notification === "stale",
      JSON.stringify(snapAbsent.body?.supervisor));
    delete fakeHostBehavior.state;
    check("cockpit model", snap.body?.supervisor?.model === null);
    check("cockpit focus ticket", snap.body?.supervisor?.focus?.taskId === "FIX-42" && snap.body?.supervisor?.focus?.runId === "run-1",
      JSON.stringify(snap.body?.supervisor?.focus));
    check("cockpit waker lease alive", snap.body?.supervisor?.waker?.state === "alive", JSON.stringify(snap.body?.supervisor?.waker));
    check("cockpit wake backlog 2", snap.body?.supervisor?.wakeBacklog === 2, String(snap.body?.supervisor?.wakeBacklog));
    const child1 = (snap.body?.children ?? []).find((c) => c.childId === "child-1");
    check("cockpit child-1 waiting-gate (pending gate outranks liveness)",
      child1?.status === "waiting-gate", JSON.stringify(child1));
    const child1b = (snap.body?.children ?? []).find((c) => c.childId === "child-1b");
    check("cockpit child-1b running via host probe", child1b?.status === "running", JSON.stringify(child1b));
    const gateItem = (snap.body?.needsYou ?? []).find((it) => it.category === "gate" && it.gateId === "gate-1");
    check("cockpit needs-you has pending gate-1", gateItem?.state === "pending" && gateItem?.answerable === true,
      JSON.stringify(gateItem));
    check("cockpit counts (gate-1 + hold-1 + gate-2 answerable; child-1b + child-2 running)",
      snap.body?.counts?.needsYou === 3 && snap.body?.counts?.running === 2 && snap.body?.counts?.waitingGate === 1,
      JSON.stringify(snap.body?.counts));
    check("cockpit redacts secrets", !JSON.stringify(snap.body).includes(SECRET) && JSON.stringify(snap.body).includes("sk-***"));
    const stateCall = hostCalls.find((c) => c.url === "/state");
    check("host token forwarded on /state", stateCall?.token === TOKEN, String(stateCall?.token));
    const aliveCall = hostCalls.find((c) => c.url === "/alive");
    check("probe used host /alive", Array.isArray(aliveCall?.body?.pids) && aliveCall.body.pids.includes(LIVE_PID),
      JSON.stringify(aliveCall?.body));

    // GET /api/supervisor/conversation — entries + redaction + paging.
    const conv = await call(P, "GET", "/api/supervisor/conversation");
    check("conversation -> 200", conv.status === 200, JSON.stringify(conv.body).slice(0, 200));
    check("conversation session ids", conv.body?.sessionId === "sess-1" && conv.body?.state === "idle",
      JSON.stringify(conv.body));
    check("conversation two entries", conv.body?.entries?.length === 2, JSON.stringify(conv.body?.entries));
    check("conversation first is the user line, redacted",
      conv.body?.entries?.[0]?.role === "user" && conv.body?.entries?.[0]?.text === `check status with token sk-***`,
      JSON.stringify(conv.body?.entries?.[0]));
    check("conversation offset advanced", conv.body?.offset > 0, String(conv.body?.offset));
    const conv2 = await call(P, "GET", `/api/supervisor/conversation?after=${conv.body?.offset}`);
    check("conversation after offset -> empty, no reset",
      conv2.body?.entries?.length === 0 && conv2.body?.reset === false, JSON.stringify(conv2.body));
    const convTail = await call(P, "GET", "/api/supervisor/conversation?after=999999999");
    check("conversation after beyond size -> reset tail", convTail.body?.reset === true, JSON.stringify(convTail.body));
    for (const [q, why] of [["?after=abc", "after not an integer"], ["?after=-1", "after negative"], ["?limit=0", "limit 0"], ["?limit=501", "limit over 500"]]) {
      const bad = await call(P, "GET", `/api/supervisor/conversation${q}`);
      check(`conversation ${why} -> 400`, bad.status === 400, `${q} got ${bad.status}`);
    }

    // POST /api/supervisor/message — pass-through, 409, body forwarded.
    const msg = await call(P, "POST", "/api/supervisor/message", { body: { text: "status of all children?" } });
    check("message -> host 200 pass-through", msg.status === 200 && msg.body?.sent === true, JSON.stringify(msg));
    check("message text forwarded verbatim",
      hostCalls.find((c) => c.url === "/message")?.body?.text === "status of all children?",
      JSON.stringify(hostCalls.filter((c) => c.url === "/message")));
    fakeHostBehavior.message = { status: 409, body: { error: "needs-input", notification: "permission prompt open" } };
    const msg409 = await call(P, "POST", "/api/supervisor/message", { body: { text: "hi" } });
    check("message 409 needs-input passes through", msg409.status === 409 && msg409.body?.error === "needs-input",
      JSON.stringify(msg409));
    delete fakeHostBehavior.message;

    // POST /api/supervisor/session — fresh needs confirm; plain ensure forwards.
    const freshNo = await call(P, "POST", "/api/supervisor/session", { body: { fresh: true } });
    check("session fresh without confirm -> 400", freshNo.status === 400, JSON.stringify(freshNo));
    const freshYes = await call(P, "POST", "/api/supervisor/session", { body: { fresh: true, confirm: "new-session" } });
    check("session fresh+confirm -> forwarded", freshYes.status === 200 && freshYes.body?.ready === true, JSON.stringify(freshYes));
    const ensureCall = hostCalls.filter((c) => c.url === "/session").pop();
    check("session forwarded with fresh:true", ensureCall?.body?.fresh === true, JSON.stringify(ensureCall?.body));
    const plain = await call(P, "POST", "/api/supervisor/session", { body: {} });
    check("session plain ensure -> 200", plain.status === 200, JSON.stringify(plain));
    check("session plain forwarded with fresh:false", hostCalls.filter((c) => c.url === "/session").pop()?.body?.fresh === false);

    // POST /api/supervisor/wake — the drain prompt, the waker's own wording.
    const wake = await call(P, "POST", "/api/supervisor/wake", { body: {} });
    check("wake -> host 200 pass-through", wake.status === 200 && wake.body?.sent === true, JSON.stringify(wake));
    const wakeMsg = hostCalls.filter((c) => c.url === "/message").pop();
    check("wake prompt is prefixed waker wording",
      typeof wakeMsg?.body?.text === "string"
      && wakeMsg.body.text.startsWith("[dashboard] Mateusz asked you to check waiting events: ")
      && wakeMsg.body.text.includes("2 new wake event(s) in run run-1")
      && wakeMsg.body.text.includes("supervisor-status.mjs --drain --tail 20"),
      JSON.stringify(wakeMsg?.body));

    // POST /api/gates/answer — happy path: gate recorded, notice sent, row audit.
    hostCalls.length = 0;
    const answer = await call(P, "POST", "/api/gates/answer", {
      body: { runId: "run-1", gateId: "gate-1", text: "use postgres", note: "decided in the cockpit" },
    });
    check("gate answer -> 200", answer.status === 200, JSON.stringify(answer).slice(0, 300));
    check("gate answer recorded+notified", answer.body?.recorded === true && answer.body?.notified === true,
      JSON.stringify(answer.body));
    const gateOnDisk = JSON.parse(readFileSync(join(supState, "run-1", "gates", "gate-1.json"), "utf8"));
    check("gate file answered with answeredBy dashboard",
      gateOnDisk.status === "answered" && gateOnDisk.answer?.answeredBy === "dashboard" && gateOnDisk.answer?.text === "use postgres",
      JSON.stringify(gateOnDisk.answer));
    const notice = hostCalls.find((c) => c.url === "/message" && c.body?.text?.includes("gate-1"));
    check("gate notice carries the dashboard wording",
      typeof notice?.body?.text === "string"
      && notice.body.text.startsWith("[dashboard] Mateusz answered gate-1 for child-1 (FIX-42)")
      && notice.body.text.includes("the answer is recorded in the gate — deliver it now."),
      JSON.stringify(notice?.body));
    const editsRows = readFileSync(join(supState, "run-1", "edits.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const gateRow = editsRows.find((r) => r.type === "gate-answer");
    check("gate answer audit row notified:true",
      gateRow?.who === "dashboard" && gateRow?.notified === true && gateRow?.path === "gates/gate-1.json",
      JSON.stringify(gateRow));

    // FOC-449 provenance: the dashboard answer labels the gate's decision
    // event exactly like the CLI's answer does (outcome = the answer,
    // by:"human", via:"gate") — into the LA_DECISION_RUNS_DIR log.
    const decisionLines = readFileSync(join(runsDir, "run-1", "decisions.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const label = decisionLines.find((l) => l.type === "label" && l.eventId === "ev-gate-1");
    check("gate answer labels the decision event (human/gate provenance)",
      label && label.outcome === "use postgres" && label.by === "human" && label.source === "auto" && label.via === "gate",
      JSON.stringify(decisionLines));

    // Answering again → 409.
    const again = await call(P, "POST", "/api/gates/answer", { body: { runId: "run-1", gateId: "gate-1", text: "use postgres" } });
    check("gate answer twice -> 409", again.status === 409 && again.body?.error === "already-answered", JSON.stringify(again));

    // POST /api/gates/notify — answered gate re-notified.
    const notify = await call(P, "POST", "/api/gates/notify", { body: { runId: "run-1", gateId: "gate-1" } });
    check("gate notify answered -> 200 notified", notify.status === 200 && notify.body?.notified === true, JSON.stringify(notify));
    const notifyPending = await call(P, "POST", "/api/gates/notify", { body: { runId: "run-2", gateId: "gate-2" } });
    check("gate notify pending -> 409", notifyPending.status === 409, JSON.stringify(notifyPending));
    const notifyMissing = await call(P, "POST", "/api/gates/notify", { body: { runId: "run-2", gateId: "gate-nope" } });
    check("gate notify missing -> 404", notifyMissing.status === 404, JSON.stringify(notifyMissing));

    // POST /api/holds/answer — same pattern on the holds store.
    const holdAnswer = await call(P, "POST", "/api/holds/answer", { body: { runId: "run-1", holdId: "hold-1", text: "switch it" } });
    check("hold answer -> 200 notified", holdAnswer.status === 200 && holdAnswer.body?.notified === true, JSON.stringify(holdAnswer));
    const holdsOnDisk = JSON.parse(readFileSync(join(supState, "run-1", "holds.json"), "utf8"));
    check("hold file answered", holdsOnDisk.holds[0].state === "answered" && holdsOnDisk.holds[0].answer?.answeredBy === "dashboard",
      JSON.stringify(holdsOnDisk.holds[0].answer));
    const holdRow = readFileSync(join(supState, "run-1", "edits.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
      .filter((r) => r.type === "hold-answer");
    check("hold answer audit row notified:true", holdRow.length === 1 && holdRow[0].notified === true, JSON.stringify(holdRow));

    // POST /api/gates/notify with holdId — the "Tell the Supervisor" fallback
    // after a hold answer whose notice failed. An OPEN hold has no answer to
    // deliver (409); the answered one is re-notified with /api/holds/answer's
    // exact wording.
    const holdsStore = JSON.parse(readFileSync(join(supState, "run-1", "holds.json"), "utf8"));
    holdsStore.holds.push({
      id: "hold-2", origin: "test", question: "an open one?", recommendation: "wait",
      options: [{ label: "wait", model: "m1", costUsd: 0 }],
      impact: "low", state: "open", createdAt: NOW, presentedAt: null, until: null,
      answer: null, history: [{ event: "created", at: NOW }], blocks: null, resolution: null,
    });
    writeFileSync(join(supState, "run-1", "holds.json"), JSON.stringify(holdsStore), "utf8");
    const holdOpen = await call(P, "POST", "/api/gates/notify", { body: { runId: "run-1", holdId: "hold-2" } });
    check("hold notify open -> 409 still-open",
      holdOpen.status === 409 && holdOpen.body?.error === "still-open", JSON.stringify(holdOpen));
    const holdMissing = await call(P, "POST", "/api/gates/notify", { body: { runId: "run-1", holdId: "hold-nope" } });
    check("hold notify missing -> 404", holdMissing.status === 404, JSON.stringify(holdMissing));

    hostCalls.length = 0;
    const holdNotify = await call(P, "POST", "/api/gates/notify", { body: { runId: "run-1", holdId: "hold-1" } });
    check("hold notify answered -> 200 notified",
      holdNotify.status === 200 && holdNotify.body?.notified === true, JSON.stringify(holdNotify));
    const holdNotice = hostCalls.find((c) => c.url === "/message");
    check("hold notice wording matches /api/holds/answer",
      typeof holdNotice?.body?.text === "string"
      && holdNotice.body.text === "[dashboard] Mateusz answered hold hold-1 (no task) in the Cockpit; the answer is recorded — act on it now.",
      JSON.stringify(holdNotice?.body));

    // Exactly one of gateId / holdId, else 400.
    const notifyBoth = await call(P, "POST", "/api/gates/notify", { body: { runId: "run-1", gateId: "gate-1", holdId: "hold-1" } });
    check("notify both ids -> 400", notifyBoth.status === 400, JSON.stringify(notifyBoth));
    const notifyNeither = await call(P, "POST", "/api/gates/notify", { body: { runId: "run-1" } });
    check("notify neither id -> 400", notifyNeither.status === 400, JSON.stringify(notifyNeither));

    // Foreign Origin → 403 on every POST route.
    for (const [p, body] of [
      ["/api/supervisor/message", { text: "hi" }],
      ["/api/supervisor/session", {}],
      ["/api/supervisor/wake", {}],
      ["/api/gates/answer", { runId: "run-1", gateId: "gate-1", text: "x" }],
      ["/api/holds/answer", { runId: "run-1", holdId: "hold-1", text: "x" }],
      ["/api/gates/notify", { runId: "run-1", gateId: "gate-1" }],
    ]) {
      const r = await call(P, "POST", p, { origin: "https://evil.example", body });
      check(`foreign origin 403 on ${p}`, r.status === 403, `got ${r.status}`);
    }
    child.kill();
  }

  // ── Docker mode, host down ───────────────────────────────────────────────
  {
    const { child, port } = await spawnServer({ ...baseEnv, FENIX_SUPERVISOR_HOST: `http://127.0.0.1:${deadPort}` });
    servers.push(child);
    await waitForServer(port, child);
    const P = port;

    const snap = await call(P, "GET", "/api/cockpit");
    check("cockpit host-down -> unreachable", snap.status === 200 && snap.body?.supervisor?.host === "unreachable",
      JSON.stringify(snap.body?.supervisor));
    const child2 = (snap.body?.children ?? []).find((c) => c.childId === "child-2");
    check("cockpit host-down -> child unknown with detail",
      child2?.status === "unknown" && child2?.detail === "process probe unavailable", JSON.stringify(child2));
    check("cockpit host-down still lists gate-2",
      (snap.body?.needsYou ?? []).some((it) => it.gateId === "gate-2" && it.state === "pending"));

    const msg = await call(P, "POST", "/api/supervisor/message", { body: { text: "hi" } });
    check("message host-down -> 503 host-unreachable", msg.status === 503 && msg.body?.error === "host-unreachable",
      JSON.stringify(msg));

    // A held answer lock + the route's lockWaitMs: 0 → busy 503 with the fixed
    // retryable reason, without the API waiting out the 2 s lock deadline.
    writeFileSync(join(supState, "run-2", "gates", "gate-2.json.lock"), "", "utf8");
    const busy = await call(P, "POST", "/api/gates/answer", { body: { runId: "run-2", gateId: "gate-2", text: "port 7332" } });
    check("gate answer with a held lock -> 503 busy, fixed reason",
      busy.status === 503 && busy.body?.error === "busy" && busy.body?.reason === "another answer is being recorded — try again",
      JSON.stringify(busy));
    rmSync(join(supState, "run-2", "gates", "gate-2.json.lock"));

    const answer = await call(P, "POST", "/api/gates/answer", { body: { runId: "run-2", gateId: "gate-2", text: "port 7332" } });
    check("gate answer host-down -> recorded, notified false",
      answer.status === 200 && answer.body?.recorded === true && answer.body?.notified === false,
      JSON.stringify(answer));
    const rows = readFileSync(join(supState, "run-2", "edits.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    check("gate answer host-down row notified:false", rows.length === 1 && rows[0].notified === false, JSON.stringify(rows));
    child.kill();
  }

  // ── Native mode (no FENIX_SUPERVISOR_HOST) ───────────────────────────────
  {
    const { child, port } = await spawnServer({ ...baseEnv, SUPERVISOR_MODEL: "test-model" });
    servers.push(child);
    await waitForServer(port, child);
    const P = port;

    const msg = await call(P, "POST", "/api/supervisor/message", { body: { text: "hi" } });
    check("message native -> 503 docker-only", msg.status === 503 && msg.body?.error === "docker-only", JSON.stringify(msg));
    const fresh = await call(P, "POST", "/api/supervisor/session", { body: { fresh: true } });
    check("session fresh without confirm -> 400 even natively", fresh.status === 400, JSON.stringify(fresh));

    const snap = await call(P, "GET", "/api/cockpit");
    check("cockpit native -> not-docker", snap.body?.supervisor?.host === "not-docker", snap.body?.supervisor?.host);
    check("cockpit native state/session from session.json",
      snap.body?.supervisor?.state === "idle" && snap.body?.supervisor?.sessionId === "sess-1",
      JSON.stringify(snap.body?.supervisor));
    check("cockpit native model from env", snap.body?.supervisor?.model === "test-model", snap.body?.supervisor?.model);
    const child1b = (snap.body?.children ?? []).find((c) => c.childId === "child-1b");
    check("cockpit native probe -> running", child1b?.status === "running", JSON.stringify(child1b));

    // Conversation confinement: outside the squad dir, or not .jsonl → none.
    writeSession({ transcriptPath: outsidePath });
    const convOut = await call(P, "GET", "/api/supervisor/conversation");
    check("conversation outside squad dir -> no transcript",
      convOut.body?.sessionId === "sess-1" && convOut.body?.entries?.length === 0 && convOut.body?.offset === 0,
      JSON.stringify(convOut.body));
    writeSession({ transcriptPath: join(squadHome, "supervisor", "notes.txt") });
    const convTxt = await call(P, "GET", "/api/supervisor/conversation");
    check("conversation non-.jsonl -> no transcript", convTxt.body?.entries?.length === 0, JSON.stringify(convTxt.body));
    rmSync(join(dataHome, "supervisor", "session.json"));
    const convNone = await call(P, "GET", "/api/supervisor/conversation");
    check("conversation no session -> empty shape",
      convNone.body?.sessionId === null && convNone.body?.offset === 0 && convNone.body?.entries?.length === 0,
      JSON.stringify(convNone.body));
    writeSession();

    // The WS route natively → 503 (no host to proxy to).
    const rej = await rawUpgrade(P, upgradeRequest({ host: `127.0.0.1:${P}`, origin: `http://127.0.0.1:${P}` }));
    check("terminal native -> 503", rej.head.startsWith("HTTP/1.1 503"), rej.head);
    rej.socket.destroy();
    child.kill();
  }

  // ── WS upgrade guards + proxy (Docker mode, host reachable) ──────────────
  {
    const { child, port } = await spawnServer({ ...baseEnv, FENIX_SUPERVISOR_HOST: HOST_URL });
    servers.push(child);
    await waitForServer(port, child);
    const P = port;

    const noOrigin = await rawUpgrade(P, upgradeRequest({ host: `127.0.0.1:${P}`, origin: null }));
    check("terminal without Origin -> 403", noOrigin.head.startsWith("HTTP/1.1 403"), noOrigin.head);
    noOrigin.socket.destroy();

    const otherPort = await rawUpgrade(P, upgradeRequest({ host: `127.0.0.1:${P}`, origin: "http://127.0.0.1:9999" }));
    check("terminal Origin on another port -> 403", otherPort.head.startsWith("HTTP/1.1 403"), otherPort.head);
    otherPort.socket.destroy();

    const foreignHost = await rawUpgrade(P, upgradeRequest({ host: "evil.example:80", origin: "http://evil.example:80" }));
    check("terminal non-loopback Host -> 403", foreignHost.head.startsWith("HTTP/1.1 403"), foreignHost.head);
    foreignHost.socket.destroy();

    // A client that RSTs while the server rejects the upgrade: the server's
    // raw socket has an 'error' listener from birth (handleTerminalUpgrade's
    // first statement), so the reset must never kill the API process — a
    // follow-up snapshot still answers.
    await new Promise((resolve) => {
      const socket = net.connect(P, "127.0.0.1");
      socket.on("error", () => {}); // the RST this test provokes is expected HERE (client side)
      socket.on("connect", () => {
        socket.write(upgradeRequest({ host: `127.0.0.1:${P}`, origin: null }));
        if (typeof socket.resetAndDestroy === "function") socket.resetAndDestroy();
        else socket.destroy();
        resolve();
      });
    });
    const afterReset = await call(P, "GET", "/api/cockpit");
    check("cockpit serves after a rejected-upgrade RST", afterReset.status === 200, `got ${afterReset.status}`);

    // Accepted: proxied to the fake host's upgrade, token forwarded, Origin NOT
    // forwarded, cols/rows clamped (9999→500, 1→5), and bytes echo both ways.
    hostUpgrades.length = 0;
    const ok = await rawUpgrade(P, upgradeRequest({ host: `127.0.0.1:${P}`, origin: `http://127.0.0.1:${P}` }));
    check("terminal accepted -> 101", ok.head.startsWith("HTTP/1.1 101"), ok.head);
    const up = hostUpgrades[0];
    check("proxy hits /terminal with clamped cols/rows", up?.url === "/terminal?cols=500&rows=5", String(up?.url));
    check("proxy forwards the host token", up?.headers?.["x-fenix-host-token"] === TOKEN, String(up?.headers?.["x-fenix-host-token"]));
    check("proxy does NOT forward Origin", up?.headers?.origin === undefined, String(up?.headers?.origin));
    const echoed = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ok.socket.destroy(); reject(new Error("echo timeout")); }, 5000);
      ok.socket.write("hello-proxy");
      ok.socket.on("data", (c) => {
        if (c.toString("latin1").includes("hello-proxy")) { clearTimeout(timer); resolve(true); }
      });
      ok.socket.on("error", (e) => { clearTimeout(timer); reject(e); });
    });
    check("terminal pipes bytes both ways", echoed === true);
    ok.socket.destroy();
    child.kill();
  }

  // ── the current-run record (FOC-807) ─────────────────────────────────────
  //
  // A third run with a REAL run-id shape, its own wake queue (two un-acked
  // rows, distinct ts) and its own waker lease — the record points HERE, so
  // every assertion doubles as a proof that run-1's rows/lease are ignored.
  {
    const curRunId = "2026-10-12T10-00-00-000-supervisor-c0de";
    const curOldest = "2026-10-12T09:55:00.000Z";
    const curNewer = "2026-10-12T09:58:00.000Z";
    const recordPath = join(dataHome, "supervisor", "current-run.json");
    mkdirSync(join(supState, curRunId), { recursive: true });
    writeFileSync(join(supState, curRunId, "wake-queue.jsonl"), [
      JSON.stringify({ seq: 5, event: "exit", childId: "child-c", turn: 1, dedupKey: "exit:child-c:5", detail: {}, ts: curOldest }),
      JSON.stringify({ seq: 6, event: "gate", gateId: "gate-1", dedupKey: "gate:gate-1", detail: {}, ts: curNewer }),
      "",
    ].join("\n"), "utf8");
    writeFileSync(join(supState, curRunId, "waker.json"), JSON.stringify({
      pid: LIVE_PID, sessionId: "waker-cur", startedAt: NOW, heartbeatAt: NOW, firedThrough: 0,
    }), "utf8");

    const { child, port } = await spawnServer({ ...baseEnv, FENIX_SUPERVISOR_HOST: HOST_URL, SUPERVISOR_MODEL: "env-model" });
    servers.push(child);
    await waitForServer(port, child);
    const P = port;

    // No record yet: the focus run (run-1) drives runId, runSource says so,
    // and the backlog counts the focus run only — the new run's un-acked rows
    // stay out even though they sit in a recent run dir.
    let snap = await call(P, "GET", "/api/cockpit");
    let sup = snap.body?.supervisor;
    check("current-run absent -> runId falls back to focus", sup?.runId === "run-1", JSON.stringify(sup));
    check("current-run absent -> runSource focus", sup?.runSource === "focus", String(sup?.runSource));
    check("current-run absent -> waker from the focus run", sup?.waker?.state === "alive", JSON.stringify(sup?.waker));
    check("current-run absent -> backlog counts the focus run only", sup?.wakeBacklog === 2, String(sup?.wakeBacklog));
    check("current-run absent -> wakeOldestAt is the focus run's oldest ts", sup?.wakeOldestAt === NOW, String(sup?.wakeOldestAt));
    check("current-run absent -> model from env", sup?.model === "env-model", String(sup?.model));

    // The record arrives: runId/runSource/waker/backlog/model all follow it.
    writeCurrentRun(
      { runId: curRunId, model: "record-model", startedAt: NOW, updatedAt: NOW, source: "pointer" },
      { path: recordPath },
    );
    await new Promise((r) => setTimeout(r, 2100)); // the 2 s TTL cache
    snap = await call(P, "GET", "/api/cockpit");
    sup = snap.body?.supervisor;
    check("current-run record -> runId from the record", sup?.runId === curRunId, JSON.stringify(sup));
    check("current-run record -> runSource from the record", sup?.runSource === "pointer", String(sup?.runSource));
    check("current-run record -> waker read from that run",
      sup?.waker?.sessionId === "waker-cur" && sup?.waker?.state === "alive", JSON.stringify(sup?.waker));
    check("current-run record -> backlog counts ONLY that run (run-1's rows not counted)",
      sup?.wakeBacklog === 2, String(sup?.wakeBacklog));
    check("current-run record -> wakeOldestAt is that run's oldest un-acked ts",
      sup?.wakeOldestAt === curOldest, String(sup?.wakeOldestAt));
    check("current-run record -> model wins over SUPERVISOR_MODEL", sup?.model === "record-model", String(sup?.model));
    check("current-run record -> focus unchanged", sup?.focus?.runId === "run-1", JSON.stringify(sup?.focus));

    // The Wake prompt targets the record's run, not the focus heuristic's.
    const wake = await call(P, "POST", "/api/supervisor/wake", { body: {} });
    const wakeMsg = hostCalls.filter((c) => c.url === "/message").pop();
    check("wake prompt targets the current-run record's run",
      wake.status === 200 && typeof wakeMsg?.body?.text === "string"
      && wakeMsg.body.text.startsWith("[dashboard] Mateusz asked you to check waiting events: ")
      && wakeMsg.body.text.includes(`2 new wake event(s) in run ${curRunId}`),
      JSON.stringify(wakeMsg?.body));

    child.kill();
  }
} catch (err) {
  failed++;
  failures.push(`unexpected error — ${err?.stack || err}`);
} finally {
  for (const child of servers) {
    if (child.exitCode === null) child.kill();
  }
  fakeHost.close();
}

// ── the snapshot cache, in-process (unit level, injected builds + clock) ─────

{
  const { cachedCockpitSnapshot, resetCockpitSnapshotCache } = await import("./cockpit-routes.mjs");

  // Two requests within the TTL build once.
  {
    let builds = 0;
    resetCockpitSnapshotCache({ now: () => 1000, ttlMs: 2000 });
    const build = async () => { builds++; return { n: builds }; };
    const a = await cachedCockpitSnapshot(build);
    const b = await cachedCockpitSnapshot(build);
    check("cache: two requests within the TTL build once", builds === 1 && a === b && a.n === 1, String(builds));
  }

  // A request just inside the TTL is served from cache; at the TTL boundary
  // (age === TTL) it rebuilds. The clock is a mutable variable — resetting
  // would clear the cache under test.
  {
    let builds = 0;
    let clock = 1000;
    resetCockpitSnapshotCache({ now: () => clock, ttlMs: 2000 });
    const build = async () => { builds++; return { n: builds }; };
    await cachedCockpitSnapshot(build);
    check("cache: sanity — first call builds", builds === 1, String(builds));
    clock = 2999; // age 1999 < TTL
    await cachedCockpitSnapshot(build);
    check("cache: a request 1 ms inside the TTL is served from cache", builds === 1, String(builds));
    clock = 3000; // age 2000 === TTL
    const fresh = await cachedCockpitSnapshot(build);
    check("cache: a request at the TTL boundary rebuilds", builds === 2 && fresh.n === 2, String(builds));
  }

  // Concurrent requests share one build (single-flight).
  {
    let builds = 0;
    resetCockpitSnapshotCache({ now: () => 1000, ttlMs: 2000 });
    const build = async () => {
      builds++;
      await new Promise((r) => setTimeout(r, 50));
      return { n: builds };
    };
    const [a, b] = await Promise.all([cachedCockpitSnapshot(build), cachedCockpitSnapshot(build)]);
    check("cache: concurrent requests share one build", builds === 1 && a === b && a.n === 1, String(builds));
  }

  // An error is NEVER cached — the next request builds again.
  {
    let attempts = 0;
    resetCockpitSnapshotCache({ now: () => 1000, ttlMs: 2000 });
    const failing = async () => { attempts++; throw new Error("boom"); };
    await assert.rejects(() => cachedCockpitSnapshot(failing), /boom/);
    check("cache: the failing build ran", attempts === 1, String(attempts));
    const ok = await cachedCockpitSnapshot(async () => ({ ok: true }));
    check("cache: an error is not cached — the next request rebuilds",
      attempts === 1 && ok.ok === true, JSON.stringify(ok));
  }

  resetCockpitSnapshotCache(); // back to the real clock and TTL
}

// ── report ───────────────────────────────────────────────────────────────────

console.log(`\ncockpit-routes: ${passed} passed, ${failed} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
rmSync(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
