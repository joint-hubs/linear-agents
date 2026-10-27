// scripts/task-cockpit-routes.test.mjs — regression tests for the TASK-SCOPED
// session routes (PRD task-workspace-supervisors, plan P1c) in
// cockpit-routes.mjs: GET /api/supervisor/sessions, GET
// /api/cockpit?sessionId=, and the /api/supervisor/sessions/:sid/* mirrors.
//
// Same harness family as cockpit-routes.test.mjs, but one scenario and one
// server child: the REAL telemetry-server in Docker mode against a fake
// session host on 127.0.0.1:0, every seam (LA_TELEMETRY_DB, LA_DATA_HOME with
// the SESSION-scoped homes, LA_SQUAD_HOME, LA_SUPERVISOR_STATE_HOME,
// LA_STATE_ROOT, LA_DECISION_RUNS_DIR) isolated under one tmp dir. The fake
// host implements the new host contract: GET /sessions → { sessions,
// maxActive }, GET /sessions/:sid → { session: record }, GET
// /sessions/:sid/state → { taskSession, session: "running", panePid, hook },
// plus the scoped /message, /session, /stop, /dialog routes and the raw
// WebSocket upstream on 'upgrade'. Every call is recorded so the tests can
// assert WHICH host path a route hit (scoped vs global) and that a rejected
// request never reached the host at all.
//
// Proven here (one focused case per block):
//   1. the sessions list and the scoped /state pass through REDACTED records
//      only — planted unsafe fields (token, transcriptPath, argv) never leak;
//   2. an unknown or malformed :sid is a 404 decided BEFORE any file read or
//      mutation — the host sees at most one GET, never the forwarded write;
//   3. GET /api/cockpit?sessionId=A&taskKey=B with a taskKey the session is
//      not bound to is a 404 task-mismatch; the matching call serves ONLY the
//      target session's run (never another session's children/gates);
//   4. a scoped conversation cannot read another session's transcript — not
//      via a forged absolute path, not via a ../ traversal out of the
//      session's claude dir;
//   5. POST /sessions/:sid/message forwards to the host's SCOPED
//      /sessions/:sid/message only — never the global /message;
//   6. gate/hold answering is run-scoped through verifyRunOwnership (a
//      foreign run is 404, the session's own run records), and while managed
//      sessions exist every UNscoped mutation answers 409 selection-required;
//   7. WS: an unknown sid is closed before any upstream connect, an accepted
//      scoped terminal proxies to /sessions/:sid/terminal — and a FORGED
//      taskKey on the WS query is EXPECTED to be rejected before upstream
//      (contract parity with the HTTP 404 task-mismatch). Two checks here are
//      marked "EXPECTED (failing)": the implementation does not yet meet them,
//      the precise fix is in the failure detail, NOT a reason to weaken the
//      assertion.
//
// The server child, the fake host and every socket are closed in finally; all
// waits are bounded; no external network. Run: node scripts/task-cockpit-routes.test.mjs

import { createServer } from "node:http";
import net from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { openTelemetryDb } from "./telemetry-store.mjs";
import { ensureViews } from "./telemetry-canonical.mjs";
import { hostTokenPath } from "./fenix-paths.mjs";
import { spawnTestServer } from "./test-spawn.mjs";

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

const dir = mkdtempSync(join(tmpdir(), "task-cockpit-routes-"));
const dataHome = join(dir, "data"); // LA_DATA_HOME: session homes + host.token
const squadHome = join(dir, "agents"); // LA_SQUAD_HOME (untouched by scoped routes, but isolated)
const supState = join(dir, "sup-state"); // LA_SUPERVISOR_STATE_HOME: runs (children/gates)
const runsDir = join(dir, "state-root", "runs"); // LA_DECISION_RUNS_DIR
const dbPath = join(dir, "telemetry.sqlite");

mkdirSync(join(dataHome, "run"), { recursive: true });
mkdirSync(join(squadHome, "supervisor", "projects"), { recursive: true });
mkdirSync(runsDir, { recursive: true });

{
  const db = openTelemetryDb(dbPath);
  ensureViews(db);
  db.close();
}

const TOKEN = "task-cockpit-test-token";
writeFileSync(hostTokenPath({ LA_DATA_HOME: dataHome }), TOKEN, "utf8");

const LIVE_PID = process.pid; // alive on any platform, including the child's probe
const NOW = new Date().toISOString();
const SECRET = "sk-SECRET123xyz";

// Two managed sessions. Ids match /^sup-[a-f0-9]{32}$/ (the strict pattern
// allows 16..32 hex; the contract says 32 — both hold).
const hex = (s) => s.repeat(8); // 4 chars × 8 = 32 hex chars
const SID_A = `sup-${hex("aa11")}`;
const SID_B = `sup-${hex("bb22")}`;
const SID_UNKNOWN = `sup-${hex("00")}`; // well-formed, but the host does not know it
const MALFORMED_SID = "sup-zz"; // fails the strict pattern

const TASK_A = "TASK-A";
const TASK_B = "TASK-B";
const WORKSPACE_A = "ws-immutable-a1";
const WORKSPACE_B = "ws-immutable-b2";
// readCurrentRun only trusts run ids shaped like run-manifest's gen-id output.
const RUN_A = "2026-10-14T09-00-00-001-supervisor-aa01";
const RUN_B = "2026-10-14T09-00-00-002-supervisor-bb02";

// Session-scoped on-disk state: <dataHome>/supervisor/sessions/<sid>/…
for (const [sid, runId, taskKey, taskId, workspace] of [
  [SID_A, RUN_A, TASK_A, "FIX-901", WORKSPACE_A],
  [SID_B, RUN_B, TASK_B, "FIX-902", WORKSPACE_B],
]) {
  const home = join(dataHome, "supervisor", "sessions", sid);
  const claudeDir = join(home, "claude");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(home, "current-run.json"), JSON.stringify({
    runId, taskKey, taskId, workspace, supervisorSessionId: sid,
    model: "m1", startedAt: NOW, source: "pointer", updatedAt: NOW,
  }), "utf8");
  // The host's session record (contract: sessionId/taskKey/workspace/status +
  // run data) with planted UNSAFE fields that must never pass a route.
  writeFileSync(join(home, "host-record.json"), JSON.stringify({
    sessionId: sid, taskKey, taskId, workspace, issueId: taskId,
    title: `task ${taskId}`, status: "running", runId,
    pid: LIVE_PID, processStartedAt: NOW, createdAt: NOW, updatedAt: NOW,
    token: `host-secret-${taskKey}`,
    transcriptPath: join(dir, "host-side", "should-not-leak.jsonl"),
    argv: ["claude", "--dangerously"],
  }), "utf8");
  writeFileSync(join(home, "claude", "transcript.jsonl"), [
    JSON.stringify({ type: "user", uuid: `u-${sid}`, timestamp: NOW, message: { content: `session ${taskKey} transcript line with token ${SECRET}` } }),
    JSON.stringify({ type: "assistant", uuid: `a-${sid}`, timestamp: NOW, message: { content: [{ type: "text", text: "On it." }] } }),
    "",
  ].join("\n"), "utf8");
}

// Session A's hook record (session.json): transcriptPath LEGIT (inside A's own
// claude dir) — rewritten per-case for the confinement tests.
const claudeDirA = join(dataHome, "supervisor", "sessions", SID_A, "claude");
const claudeDirB = join(dataHome, "supervisor", "sessions", SID_B, "claude");
const transcriptA = join(claudeDirA, "transcript.jsonl");
const transcriptB = join(claudeDirB, "transcript.jsonl");

function writeSessionJson(sid, transcriptPath) {
  writeFileSync(join(dataHome, "supervisor", "sessions", sid, "session.json"), JSON.stringify({
    sessionId: `claude-${sid}`, state: "idle", cwd: dir, notification: null,
    updatedAt: NOW, ...(transcriptPath ? { transcriptPath } : {}),
  }), "utf8");
}
writeSessionJson(SID_A, transcriptA);
writeSessionJson(SID_B, transcriptB);

// Run dirs (SHARED state home, keyed by runId — scoped envs resolve the same
// root): one pending gate + one live child per run, so cross-session leakage
// would be visible in the scoped snapshot.
for (const [runId, childId, gateId, taskId] of [
  [RUN_A, "child-a1", "gate-A1", "FIX-901"],
  [RUN_B, "child-b1", "gate-B1", "FIX-902"],
]) {
  mkdirSync(join(supState, runId, "gates"), { recursive: true });
  mkdirSync(join(supState, runId, "children"), { recursive: true });
  writeFileSync(join(supState, runId, "children.json"), JSON.stringify({
    runId,
    children: {
      [childId]: {
        childId, squad: "dev", taskId, status: "running",
        pid: LIVE_PID, model: "m1", startedAt: NOW, turns: [],
      },
    },
    rounds: {},
  }), "utf8");
  writeFileSync(join(supState, runId, "children", `${childId}.jsonl`), "", "utf8");
  writeFileSync(join(supState, runId, "gates", `${gateId}.json`), JSON.stringify({
    gateId, runId, childId, taskId, kind: "question", status: "pending",
    createdAt: NOW, summary: "which database?", questions: ["which database?"],
  }), "utf8");
}
// A second pending gate on run A for the taskKey-forgery case.
writeFileSync(join(supState, RUN_A, "gates", "gate-A2.json"), JSON.stringify({
  gateId: "gate-A2", runId: RUN_A, childId: "child-a1", taskId: "FIX-901",
  kind: "question", status: "pending", createdAt: NOW, summary: "second gate",
  questions: ["second question?"],
}), "utf8");
// An open hold on run A — for the unscoped-mutation evidence.
writeFileSync(join(supState, RUN_A, "holds.json"), JSON.stringify({
  version: 1,
  holds: [{
    id: "hold-1", origin: "test", question: "switch the pricing source?",
    recommendation: "yes", options: [{ label: "switch", model: "m1", costUsd: 0 }],
    impact: "high", state: "open", createdAt: NOW, presentedAt: null, until: null,
    answer: null, history: [{ event: "created", at: NOW }], blocks: null, resolution: null,
  }],
}), "utf8");

const hostRecordA = JSON.parse(readFileSync(join(dataHome, "supervisor", "sessions", SID_A, "host-record.json"), "utf8"));
const hostRecordB = JSON.parse(readFileSync(join(dataHome, "supervisor", "sessions", SID_B, "host-record.json"), "utf8"));

// ── the fake session host (new contract) ─────────────────────────────────────

const hostCalls = []; // { method, url, token, body }
const hostUpgrades = []; // { url, headers }
const fakeHostBehavior = {}; // { sessionsList, state404, needsInput: { [sid]: sinceIso } }
const PERM_DIALOG_1089 = {
  id: "dlg-1089", kind: "permission", title: "Bash command",
  lines: ["Bash command", "git push -u origin foc-1053-key-wizard", "Do you want to proceed?"],
  command: "git push -u origin foc-1053-key-wizard", question: null, tabs: null,
  reason: { type: "ask-rule", detail: "Bash(git push:*)" },
  options: [
    { key: "1", label: "Yes", description: null, focused: true, checked: null, choice: "allow-once" },
    { key: "2", label: "No", description: null, focused: false, checked: null, choice: "deny" },
  ],
  footer: "Esc to cancel",
};

const fakeHost = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  let body = null;
  try { body = JSON.parse(raw); } catch { body = raw || null; }
  hostCalls.push({ method: req.method, url: req.url, token: req.headers["x-fenix-host-token"] ?? null, body });
  const url = req.url;
  const json = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };

  // The list: { sessions, maxActive } — the new host contract.
  if (url === "/sessions") {
    const b = fakeHostBehavior.sessionsList ?? {
      status: 200,
      body: { sessions: [hostRecordA, hostRecordB], maxActive: 4 },
    };
    return json(b.status, b.body);
  }

  const sidMatch = url.match(/^\/sessions\/(sup-[a-f0-9]{16,32})(\/.*)?$/);
  if (sidMatch) {
    const [, sid, suffix = ""] = sidMatch;
    const record = sid === SID_A ? hostRecordA : sid === SID_B ? hostRecordB : null;
    if (!record) return json(404, { error: "unknown session" });
    if (suffix === "" && req.method === "GET") return json(200, { session: record });
    if (suffix === "/state" && req.method === "GET") {
      if (fakeHostBehavior.state404) return json(404, { error: "unknown session" });
      // FOC-1089: the real host's effective state — a permission prompt on
      // the pane: top-level state needs-input + dialog + the parked clock.
      if (fakeHostBehavior.needsInput?.[sid]) {
        return json(200, {
          taskSession: record, session: "running", panePid: 4243, paneDead: false, clients: [],
          hook: { sessionId: `claude-${sid}`, cwd: dir, state: "needs-input", notification: { type: "permission_prompt" }, updatedAt: NOW },
          dialog: true, promptReady: false, state: "needs-input",
          needsInputSince: fakeHostBehavior.needsInput[sid], autoDenial: null, parkedPolicy: { mode: "wait", minutes: 30 },
        });
      }
      return json(200, {
        taskSession: record, // the contract shape: record under taskSession
        session: "running",
        panePid: 4243,
        paneDead: false,
        clients: ["tmux-x"],
        hook: {
          sessionId: `claude-${sid}`,
          // planted: must be stripped by the scoped /state pass-through
          transcriptPath: join(dir, "host-side", "state-hook-leak.jsonl"),
          cwd: dir, state: "idle", notification: null, updatedAt: NOW,
        },
      });
    }
    if (suffix === "/message" && req.method === "POST") return json(200, { sent: true, to: sid });
    if (suffix === "/session" && req.method === "POST") return json(200, { ready: true, to: sid });
    if (suffix === "/stop" && req.method === "POST") return json(200, { stopped: true, to: sid });
    if (suffix === "/dialog" && req.method === "GET") {
      return json(200, { dialog: fakeHostBehavior.needsInput?.[sid] ? PERM_DIALOG_1089 : null });
    }
    return json(404, { error: "not found" });
  }

  // The GLOBAL host routes (the pre-existing contract) — a scoped route must
  // never call these for another session's business.
  if (url === "/message" && req.method === "POST") return json(200, { sent: true, global: true });
  if (url === "/session" && req.method === "POST") return json(200, { ready: true, global: true });
  if (url === "/alive" && req.method === "POST") {
    const pids = Array.isArray(body?.pids) ? body.pids : [];
    return json(200, Object.fromEntries(pids.map((p) => [String(p), true])));
  }
  if (url === "/state") return json(200, { session: "running", panePid: 4242, state: "idle", hook: { sessionId: "legacy-sess" } });
  return json(404, { error: "not found" });
});

// The raw WebSocket upstream: 101 + byte echo, like cockpit-routes.test.mjs.
fakeHost.on("upgrade", (req, socket) => {
  hostUpgrades.push({ url: req.url, headers: { ...req.headers } });
  socket.on("error", () => socket.destroy());
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
  socket.pipe(socket);
});

await new Promise((resolve) => fakeHost.listen(0, "127.0.0.1", resolve));
const hostPort = fakeHost.address().port;
const HOST_URL = `http://127.0.0.1:${hostPort}`;

// ── spawn the REAL telemetry-server against the fake host ────────────────────

const servers = [];
let sockets = [];

const env = {
  ...process.env,
  LA_TELEMETRY_DB: dbPath,
  LA_TELEMETRY_HOME: join(dir, "telemetry-home"),
  LA_DATA_HOME: dataHome,
  LA_SQUAD_HOME: squadHome,
  LA_SUPERVISOR_STATE_HOME: supState,
  LA_STATE_ROOT: join(dir, "state-root"),
  LA_DECISION_RUNS_DIR: runsDir,
  FENIX_SUPERVISOR_HOST: HOST_URL,
};
delete env.LA_ANALYSIS_CACHE;
delete env.FENIX_SUPERVISOR_SESSION_ID; // scoping must come from the ROUTE, never the process env

const spawned = await spawnTestServer({
  script: join(__dir, "telemetry-server.mjs"),
  env,
  inheritEnv: false, // env already spreads process.env (minus the deleted keys)
  label: "task-cockpit-routes",
});
servers.push(spawned);
const P = spawned.port;

async function call(method, path, { origin = "http://localhost:5173", body } = {}) {
  const res = await fetch(`http://127.0.0.1:${P}${path}`, {
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

// Bounded raw-socket probe for upgrade requests: resolves with whether the
// handshake got 101, the status line otherwise (or null on a bare destroy).
function probeUpgrade(requestText, { echoText = null, waitMs = 1500 } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect(P, "127.0.0.1");
    sockets.push(socket);
    let buf = "";
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ status: null, connected: false, head: buf }), waitMs);
    socket.on("error", () => finish({ status: null, connected: false, head: buf }));
    socket.on("connect", () => socket.write(requestText));
    socket.on("data", (c) => {
      buf += c.toString("latin1");
      const idx = buf.indexOf("\r\n\r\n");
      if (idx === -1) return;
      const statusLine = buf.slice(0, buf.indexOf("\r\n"));
      if (!statusLine.includes(" 101 ")) {
        return finish({ status: statusLine.trim(), connected: false, head: buf });
      }
      if (echoText !== null) socket.write(echoText);
      setTimeout(() => finish({
        status: statusLine.trim(), connected: true, head: buf,
        echoed: echoText !== null && buf.includes(echoText),
      }), 400);
    });
  });
}

function upgradeRequest(pathWithQuery) {
  return [
    `GET ${pathWithQuery} HTTP/1.1`,
    `Host: 127.0.0.1:${P}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    "Sec-WebSocket-Version: 13",
    `Origin: http://127.0.0.1:${P}`, // Origin must equal the Host header exactly
    "",
    "",
  ].join("\r\n");
}

const unsafeLeak = (body) => JSON.stringify(body ?? {}).includes("host-secret-")
  || JSON.stringify(body ?? {}).includes("should-not-leak")
  || JSON.stringify(body ?? {}).includes("argv");

// ── the cases ────────────────────────────────────────────────────────────────

try {
  // ── Case 1 — GET /api/supervisor/sessions: redacted list + maxActive; the
  // scoped /state pass-through keeps the contract shape and strips the rest.
  {
    const list = await call("GET", "/api/supervisor/sessions");
    check("1. sessions list -> 200", list.status === 200, `${list.status} ${JSON.stringify(list.body).slice(0, 200)}`);
    check("1. sessions list carries maxActive", list.body?.maxActive === 4, JSON.stringify(list.body?.maxActive));
    check("1. sessions list has both managed sessions",
      Array.isArray(list.body?.sessions) && list.body.sessions.length === 2
      && list.body.sessions.some((s) => s?.sessionId === SID_A && s?.taskKey === TASK_A)
      && list.body.sessions.some((s) => s?.sessionId === SID_B && s?.taskKey === TASK_B),
      JSON.stringify(list.body?.sessions));
    check("1. sessions list redacts unsafe record fields", !unsafeLeak(list.body), JSON.stringify(list.body).slice(0, 300));
    check("1. host token forwarded on /sessions", hostCalls.find((c) => c.url === "/sessions")?.token === TOKEN,
      String(hostCalls.find((c) => c.url === "/sessions")?.token));

    const state = await call("GET", `/api/supervisor/sessions/${SID_A}/state`);
    check("1. scoped state -> 200 contract shape",
      state.status === 200 && state.body?.session === "running" && state.body?.panePid === 4243
      && state.body?.taskSession?.taskKey === TASK_A,
      `status ${state.status} session=${JSON.stringify(state.body?.session)} panePid=${JSON.stringify(state.body?.panePid)} taskKey=${JSON.stringify(state.body?.taskSession?.taskKey)}`);
    check("1. scoped state redacts taskSession + strips hook transcriptPath",
      !unsafeLeak(state.body) && state.body?.taskSession?.sessionId === SID_A
      && state.body?.hook && state.body.hook.transcriptPath === undefined,
      JSON.stringify(state.body?.hook));
  }

  // ── Case 2 — unknown / malformed :sid → 404 BEFORE any file read or
  // mutation: at most one existence GET reaches the host, the write never does.
  {
    hostCalls.length = 0;
    const unknown = await call("POST", `/api/supervisor/sessions/${SID_UNKNOWN}/message`, { body: { text: "hi" } });
    check("2. unknown scoped session message -> 404",
      unknown.status === 404 && unknown.body?.error === "unknown-session",
      `${unknown.status} ${JSON.stringify(unknown.body)}`);
    check("2. unknown sid: only the existence GET reached the host, no write forwarded",
      hostCalls.every((c) => c.method === "GET" && c.url === `/sessions/${SID_UNKNOWN}`)
        && !hostCalls.some((c) => c.url === `/sessions/${SID_UNKNOWN}/message`),
      JSON.stringify(hostCalls));

    const unknownConv = await call("GET", `/api/supervisor/sessions/${SID_UNKNOWN}/conversation`);
    check("2. unknown scoped session conversation -> 404 (before reading any file)",
      unknownConv.status === 404 && unknownConv.body?.error === "unknown-session",
      `${unknownConv.status} ${JSON.stringify(unknownConv.body)}`);

    hostCalls.length = 0;
    const malformed = await call("GET", `/api/supervisor/sessions/${MALFORMED_SID}/conversation`);
    check("2. malformed sid -> 404",
      malformed.status === 404,
      `${malformed.status} ${JSON.stringify(malformed.body)}`);
    check("2. malformed sid never touched the host",
      !hostCalls.some((c) => c.url.includes(MALFORMED_SID)),
      JSON.stringify(hostCalls));
  }

  // ── Case 3 — GET /api/cockpit?sessionId=A&taskKey=B → 404 task-mismatch;
  // the matching scoped poll serves ONLY the target session's run.
  {
    hostCalls.length = 0;
    const mismatch = await call("GET", `/api/cockpit?sessionId=${SID_A}&taskKey=${TASK_B}`);
    check("3. scoped snapshot with foreign taskKey -> 404 task-mismatch",
      mismatch.status === 404 && mismatch.body?.error === "task-mismatch",
      `${mismatch.status} ${JSON.stringify(mismatch.body)}`);
    check("3. taskKey mismatch never built a snapshot (no /alive probe fired)",
      !hostCalls.some((c) => c.url === "/alive"),
      JSON.stringify(hostCalls.filter((c) => c.url === "/alive")));

    const snapA = await call("GET", `/api/cockpit?sessionId=${SID_A}&taskKey=${TASK_A}`);
    check("3. scoped snapshot matching taskKey -> 200", snapA.status === 200,
      `${snapA.status} ${JSON.stringify(snapA.body).slice(0, 300)}`);
    check("3. scoped snapshot carries session A's binding",
      snapA.body?.taskSession?.taskKey === TASK_A && snapA.body?.supervisor?.taskKeyScoped === TASK_A
      && snapA.body?.supervisor?.sessionIdScoped === SID_A,
      JSON.stringify({ taskSession: snapA.body?.taskSession, supervisor: snapA.body?.supervisor?.taskKeyScoped }));
    check("3. scoped snapshot host reachable", snapA.body?.supervisor?.host === "reachable",
      String(snapA.body?.supervisor?.host));
    check("3. scoped snapshot sweeps ONLY run A (children: a yes, b no)",
      snapA.body?.children?.some((c) => c.childId === "child-a1")
      && !snapA.body?.children?.some((c) => c.childId === "child-b1"),
      JSON.stringify(snapA.body?.children));
    check("3. scoped snapshot needs-you ONLY run A's gate (gate-A1 yes, gate-B1 no)",
      snapA.body?.needsYou?.some((it) => it.gateId === "gate-A1")
      && !snapA.body?.needsYou?.some((it) => it.gateId === "gate-B1"),
      JSON.stringify(snapA.body?.needsYou));
    check("3. scoped snapshot redacts secrets", !JSON.stringify(snapA.body).includes(SECRET),
      JSON.stringify(snapA.body).includes("host-secret") ? "host record secret leaked" : "");

    const snapB = await call("GET", `/api/cockpit?sessionId=${SID_B}`);
    check("3. scoped snapshot B (no taskKey) -> 200 with B's run only",
      snapB.status === 200 && snapB.body?.supervisor?.taskKeyScoped === TASK_B
      && snapB.body?.children?.some((c) => c.childId === "child-b1")
      && !snapB.body?.children?.some((c) => c.childId === "child-a1"),
      JSON.stringify(snapB.body?.children));
  }

  // ── Case 3b (FOC-1089) — a task session waiting on a permission prompt
  // shows it in ITS scoped snapshot: state needs-input, the dialog, and a
  // dialog Needs-you item; session B (idle) gets none of it.
  {
    fakeHostBehavior.needsInput = { [SID_A]: new Date(Date.now() - 60_000).toISOString() };
    await new Promise((r) => setTimeout(r, 2100)); // past the 2 s snapshot TTL
    hostCalls.length = 0;
    const snapA = await call("GET", `/api/cockpit?sessionId=${SID_A}&taskKey=${TASK_A}`);
    check("3b. scoped snapshot reads the host's /sessions/:sid/state",
      hostCalls.some((c) => c.method === "GET" && c.url === `/sessions/${SID_A}/state`),
      JSON.stringify(hostCalls.map((c) => c.url)));
    check("3b. scoped snapshot: supervisor.state needs-input",
      snapA.body?.supervisor?.state === "needs-input", String(snapA.body?.supervisor?.state));
    check("3b. scoped snapshot carries the pane dialog",
      snapA.body?.supervisor?.dialog?.id === "dlg-1089", JSON.stringify(snapA.body?.supervisor?.dialog ?? null).slice(0, 200));
    const item = (snapA.body?.needsYou ?? []).find((it) => it.id === "dialog:dlg-1089");
    check("3b. scoped Needs-you has an answerable dialog card",
      item?.category === "dialog" && item?.answerKind === "dialog" && item?.answerable === true,
      JSON.stringify(snapA.body?.needsYou ?? []).slice(0, 400));
    check("3b. the dialog card counts in needsYou",
      (snapA.body?.counts?.needsYou ?? 0) >= 1, JSON.stringify(snapA.body?.counts));
    check("3b. the task binding survives the /state read (taskSession from the state body)",
      snapA.body?.taskSession?.taskKey === TASK_A, JSON.stringify(snapA.body?.taskSession));
    const snapB = await call("GET", `/api/cockpit?sessionId=${SID_B}`);
    check("3b. idle session B shows no dialog card",
      !(snapB.body?.needsYou ?? []).some((it) => it.category === "dialog") && snapB.body?.supervisor?.state !== "needs-input",
      JSON.stringify({ state: snapB.body?.supervisor?.state, ny: snapB.body?.needsYou }).slice(0, 300));
    delete fakeHostBehavior.needsInput;
    await new Promise((r) => setTimeout(r, 2100));
  }

  // ── Case 4 — a scoped conversation cannot read another session's
  // transcript: not via a forged absolute path, not via a ../ traversal.
  {
    const own = await call("GET", `/api/supervisor/sessions/${SID_A}/conversation`);
    check("4. scoped conversation reads its own transcript",
      own.status === 200 && own.body?.entries?.length === 2
      && JSON.stringify(own.body.entries).includes(`session ${TASK_A} transcript line`)
      && !JSON.stringify(own.body.entries).includes(SECRET),
      `${own.status} entries=${own.body?.entries?.length} ${JSON.stringify(own.body?.entries).slice(0, 200)}`);
    check("4. scoped conversation redacts the planted secret",
      JSON.stringify(own.body?.entries).includes("sk-***") && !JSON.stringify(own.body?.entries).includes(SECRET),
      JSON.stringify(own.body?.entries));
    check("4. scoped conversation names the session binding",
      own.body?.taskKey === TASK_A && own.body?.taskSession?.sessionId === SID_A,
      JSON.stringify({ taskKey: own.body?.taskKey, taskSession: own.body?.taskSession }));

    // Forge A's session.json at B's absolute transcript path — outside A's
    // claude dir → the read must be refused (empty entries), never served.
    writeSessionJson(SID_A, transcriptB);
    const forgedAbs = await call("GET", `/api/supervisor/sessions/${SID_A}/conversation`);
    check("4. forged absolute transcriptPath (session B's file) -> empty entries",
      forgedAbs.status === 200 && forgedAbs.body?.entries?.length === 0
      && !JSON.stringify(forgedAbs.body).includes("transcript line"),
      `${forgedAbs.status} ${JSON.stringify(forgedAbs.body).slice(0, 200)}`);

    // Same refusal through a traversal path that RESOLVES outside the claude dir.
    writeSessionJson(SID_A, join(claudeDirA, "..", "..", SID_B, "claude", "transcript.jsonl"));
    const forgedTraversal = await call("GET", `/api/supervisor/sessions/${SID_A}/conversation`);
    check("4. traversal transcriptPath out of the claude dir -> empty entries",
      forgedTraversal.status === 200 && forgedTraversal.body?.entries?.length === 0,
      `${forgedTraversal.status} ${JSON.stringify(forgedTraversal.body).slice(0, 200)}`);

    writeSessionJson(SID_A, transcriptA); // restore the legit record
  }

  // ── Case 5 — POST /sessions/:sid/message forwards to the host's SCOPED
  // route only — never the global /message; a forged taskKey is rejected.
  {
    hostCalls.length = 0;
    const msg = await call("POST", `/api/supervisor/sessions/${SID_A}/message`, { body: { text: "hello A" } });
    check("5. scoped message -> host 200 pass-through",
      msg.status === 200 && msg.body?.sent === true && msg.body?.to === SID_A,
      `${msg.status} ${JSON.stringify(msg.body)}`);
    check("5. scoped message hit /sessions/:sid/message with the text",
      hostCalls.some((c) => c.method === "POST" && c.url === `/sessions/${SID_A}/message` && c.body?.text === "hello A"),
      JSON.stringify(hostCalls));
    check("5. scoped message never called the global /message",
      !hostCalls.some((c) => c.url === "/message"),
      JSON.stringify(hostCalls.filter((c) => c.url === "/message")));

    hostCalls.length = 0;
    const forged = await call("POST", `/api/supervisor/sessions/${SID_A}/message`, { body: { text: "x", taskKey: TASK_B } });
    check("5. scoped message with foreign taskKey -> 404 task-mismatch",
      forged.status === 404 && forged.body?.error === "task-mismatch",
      `${forged.status} ${JSON.stringify(forged.body)}`);
    check("5. forged-taskKey message was not forwarded",
      !hostCalls.some((c) => c.url === `/sessions/${SID_A}/message`),
      JSON.stringify(hostCalls));
  }

  // ── Case 6 — while managed sessions exist, unscoped mutations answer 409
  // selection-required; a session-scoped gate/hold answer is run-scoped
  // (foreign run 404, own run records).
  {
    hostCalls.length = 0;
    const unscopedMsg = await call("POST", "/api/supervisor/message", { body: { text: "ambiguous" } });
    check("6. unscoped message with managed sessions -> 409 selection-required",
      unscopedMsg.status === 409 && unscopedMsg.body?.error === "selection-required",
      `${unscopedMsg.status} ${JSON.stringify(unscopedMsg.body)}`);
    check("6. the 409 answered before any host write",
      !hostCalls.some((c) => c.method === "POST"),
      JSON.stringify(hostCalls));

    const unscopedSession = await call("POST", "/api/supervisor/session", { body: {} });
    check("6. unscoped session with managed sessions -> 409",
      unscopedSession.status === 409 && unscopedSession.body?.error === "selection-required",
      `${unscopedSession.status} ${JSON.stringify(unscopedSession.body)}`);

    const unscopedGate = await call("POST", "/api/gates/answer", { body: { runId: RUN_A, gateId: "gate-A2", text: "x" } });
    check("6. unscoped gates/answer with managed sessions -> 409",
      unscopedGate.status === 409 && unscopedGate.body?.error === "selection-required",
      `${unscopedGate.status} ${JSON.stringify(unscopedGate.body)}`);
    const gateA2After409 = JSON.parse(readFileSync(join(supState, RUN_A, "gates", "gate-A2.json"), "utf8"));
    check("6. the 409'd gate answer never touched the gate file",
      gateA2After409.status === "pending",
      JSON.stringify(gateA2After409.status));

    // EXPECTED (currently FAILING): /api/holds/answer is the ONLY global
    // control without the managedSessionsExist() 409 gate (message, session,
    // wake, ask, dialog and gates/answer all have it) — so an unscoped hold
    // answer RECORDS against a run while managed sessions exist. The fix: add
    // the same `if (await managedSessionsExist()) selectionRequired(...)` to
    // /api/holds/answer, and move it AFTER the body.sessionId ownership path
    // in /api/gates/answer (see the scoped checks below — today the 409 fires
    // before verifyRunOwnership, so a session-scoped UI can never answer its
    // own run's gate).
    const unscopedHold = await call("POST", "/api/holds/answer", { body: { runId: RUN_A, holdId: "hold-1", text: "unscoped hold answer" } });
    const hold1OnDisk = JSON.parse(readFileSync(join(supState, RUN_A, "holds.json"), "utf8")).holds.find((h) => h.id === "hold-1");
    check("6. EXPECTED (failing): unscoped holds/answer with managed sessions -> 409 (not recorded)",
      unscopedHold.status === 409 && unscopedHold.body?.error === "selection-required" && hold1OnDisk?.state === "open",
      `got ${unscopedHold.status} ${JSON.stringify(unscopedHold.body).slice(0, 150)}, hold on disk: ${hold1OnDisk?.state} — fix: add the managedSessionsExist() 409 to /api/holds/answer like its sibling routes`);

    const unscopedSnap = await call("GET", "/api/cockpit");
    check("6. global snapshot with managed sessions -> 409 (pick a session)",
      unscopedSnap.status === 409 && unscopedSnap.body?.error === "selection-required",
      `${unscopedSnap.status} ${JSON.stringify(unscopedSnap.body).slice(0, 200)}`);

    // Scoped write, foreign run: session A must never answer run B's gate.
    hostCalls.length = 0;
    const foreign = await call("POST", "/api/gates/answer", {
      body: { sessionId: SID_A, runId: RUN_B, gateId: "gate-B1", text: "take over" },
    });
    check("6. scoped gate answer naming a foreign run -> 404 foreign-run",
      foreign.status === 404 && foreign.body?.error === "foreign-run",
      `${foreign.status} ${JSON.stringify(foreign.body)}`);
    const gateB1 = JSON.parse(readFileSync(join(supState, RUN_B, "gates", "gate-B1.json"), "utf8"));
    check("6. the foreign run's gate file is untouched",
      gateB1.status === "pending",
      JSON.stringify(gateB1.status));

    const unknownOwner = await call("POST", "/api/gates/answer", {
      body: { sessionId: SID_UNKNOWN, runId: RUN_A, gateId: "gate-A2", text: "x" },
    });
    check("6. gate answer naming an unknown session -> 404 unknown-session",
      unknownOwner.status === 404 && unknownOwner.body?.error === "unknown-session",
      `${unknownOwner.status} ${JSON.stringify(unknownOwner.body)}`);

    // Scoped write, own run: records through the gate library.
    const own = await call("POST", "/api/gates/answer", {
      body: { sessionId: SID_A, runId: RUN_A, gateId: "gate-A1", text: "use postgres" },
    });
    check("6. scoped gate answer on the session's own run -> 200 recorded",
      own.status === 200 && own.body?.recorded === true,
      `${own.status} ${JSON.stringify(own.body).slice(0, 300)}`);
    const gateA1 = JSON.parse(readFileSync(join(supState, RUN_A, "gates", "gate-A1.json"), "utf8"));
    check("6. the own run's gate file is answered by the dashboard",
      gateA1.status === "answered" && gateA1.answer?.answeredBy === "dashboard" && gateA1.answer?.text === "use postgres",
      JSON.stringify(gateA1.answer));

    // EXPECTED (currently FAILING): the scope must also validate the taskKey —
    // a body naming session A (bound to TASK-A) with taskKey TASK-B must be a
    // 404 task-mismatch, exactly like every /sessions/:sid mirror. Today the
    // body taskKey is ignored, so this check fails and gate-A2 gets answered —
    // the fix is to apply scopedTaskKeyOf() alongside verifyRunOwnership in
    // the /api/gates/answer and /api/holds/answer guards (404 task-mismatch
    // when body.taskKey is present and !== the session's bound taskKey).
    const forgedTaskKey = await call("POST", "/api/gates/answer", {
      body: { sessionId: SID_A, taskKey: TASK_B, runId: RUN_A, gateId: "gate-A2", text: "forged task binding" },
    });
    check("6. EXPECTED (failing): scoped gate answer with a foreign taskKey -> 404 task-mismatch",
      forgedTaskKey.status === 404 && forgedTaskKey.body?.error === "task-mismatch",
      `got ${forgedTaskKey.status} ${JSON.stringify(forgedTaskKey.body).slice(0, 200)} — fix: validate body.taskKey against scopedTaskKeyOf(sid, record) in the gates/holds answer guards (404 task-mismatch), like the /sessions/:sid mirrors already do`);
  }

  // ── Case 7 — the scoped terminal WebSocket: unknown sid closed before any
  // upstream connect; an accepted session proxies to /sessions/:sid/terminal;
  // a FORGED taskKey on the WS query must be rejected before upstream.
  {
    hostUpgrades.length = 0;
    const unknown = await probeUpgrade(upgradeRequest(`/api/supervisor/sessions/${SID_UNKNOWN}/terminal`));
    check("7. WS unknown sid -> rejected, no upstream connect",
      unknown.connected === false && (unknown.status?.includes("404") || unknown.status === null)
      && hostUpgrades.length === 0,
      `status ${JSON.stringify(unknown.status)} upstream ${JSON.stringify(hostUpgrades)}`);

    const ok = await probeUpgrade(upgradeRequest(`/api/supervisor/sessions/${SID_A}/terminal`), { echoText: "WS-ECHO-PROBE-42" });
    check("7. WS accepted scoped session -> 101 proxied to the scoped upstream",
      ok.connected === true && ok.echoed === true
      && hostUpgrades.some((u) => u.url.startsWith(`/sessions/${SID_A}/terminal`)),
      `status ${JSON.stringify(ok.status)} echoed ${ok.echoed} upstream ${JSON.stringify(hostUpgrades)}`);
    const up = hostUpgrades.find((u) => u.url.startsWith(`/sessions/${SID_A}/terminal`));
    check("7. WS proxy forwards the token, never the Origin",
      up?.headers["x-fenix-host-token"] === TOKEN && up?.headers.origin === undefined,
      JSON.stringify({ token: up?.headers["x-fenix-host-token"], origin: up?.headers.origin }));

    hostUpgrades.length = 0;
    // EXPECTED (currently FAILING): a taskKey on the WS query that the session
    // is not bound to must be rejected (404) BEFORE the upstream connect —
    // contract parity with the HTTP routes' 404 task-mismatch. Today the
    // terminal upgrade never reads taskKey, so the forged query is proxied.
    const forged = await probeUpgrade(upgradeRequest(`/api/supervisor/sessions/${SID_A}/terminal?taskKey=${TASK_B}`));
    check("7. EXPECTED (failing): WS with a forged taskKey -> rejected before upstream",
      forged.connected === false && hostUpgrades.length === 0,
      `got 101 + upstream ${JSON.stringify(hostUpgrades)} — fix: in handleTerminalUpgrade, when the scoped query carries taskKey, check it against scopedTaskKeyOf(sid, record) after verifyScopedTerminal and reject("404 Not Found") on a mismatch before proxyTerminal`);
  }
} catch (err) {
  failed++;
  failures.push(`unexpected error — ${err?.stack || err}`);
  for (const s of servers) if (s.child.stderrBuf) console.error(`[child stderr] ${s.child.stderrBuf}`);
} finally {
  for (const socket of sockets) { try { socket.destroy(); } catch { /* gone */ } }
  for (const s of servers) await s.stop();
  await new Promise((resolve) => fakeHost.close(resolve));
}

// ── report ───────────────────────────────────────────────────────────────────

console.log(`\ntask-cockpit-routes: ${passed} passed, ${failed} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
try {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
} catch { /* Windows AV lock — the tmp dir is the OS's to clean */ }
process.exit(failed ? 1 : 0);
