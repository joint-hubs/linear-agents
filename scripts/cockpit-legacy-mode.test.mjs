// Legacy single-Supervisor compatibility suite (FOC-839 slice A, AC1):
// every GLOBAL Cockpit write route, with NO managed task session, in two
// modes — proving the task-workspace stream changed nothing for the legacy
// dashboard that sends no sessionId and whose session id is a Claude UUID.
//
//   - Mode D0 (Docker, empty host): the server is spawned WITH
//     FENIX_SUPERVISOR_HOST pointing at a fake host whose GET /sessions
//     answers { sessions: [] } — the managed-sessions probe
//     (cockpit-routes.mjs managedSessionsExist) must find nothing, so NO
//     route answers 409 selection-required; the forwarded routes hit the
//     GLOBAL host paths (/message, /session, /dialog/answer, /dialog/ask)
//     and never /sessions/<sid>/…; gate/hold answers record their files and
//     audit rows with notified:true and their notice goes to the global
//     /message.
//   - Mode N (native): spawned WITHOUT FENIX_SUPERVISOR_HOST — the
//     host-forwarded routes answer 503 docker-only, while the gate/hold
//     answer and notify routes still write their files and audit rows with
//     notified:false, and the fake host records no call at all.
//
// Baseline citation: the plan's D1 names 3e7e099, but the test file did not
// exist there (added at a48759a with FOC-783) — the legacy expectations below
// are byte-for-byte the global-route assertions of scripts/cockpit-routes
// .test.mjs as it descends from FOC-783 (status codes, body shapes, gate/hold
// files, edits.jsonl rows, notice wordings). Marked "today" where FOC-839
// added behaviour the baseline could not assert: the GET /sessions probe
// running with an empty list, the 409 selection-required NEVER firing, and
// the bad-session-id guard answering before any write.
//
// Harness: the same shape as scripts/cockpit-routes.test.mjs (serial lane —
// the fake host and the servers bind ports). spawnTestServer installs the
// process-wide SIGINT/SIGTERM/SIGHUP + crash tree-kill net; the finally block
// stops the remaining children and the fake host.

import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

const dir = mkdtempSync(join(tmpdir(), "cockpit-legacy-"));
const dataHome = join(dir, "data"); // LA_DATA_HOME: session.json + host.token
const supState = join(dir, "sup-state"); // LA_SUPERVISOR_STATE_HOME: run dirs
const runsDir = join(dir, "state-root", "runs"); // LA_DECISION_RUNS_DIR
const dbPath = join(dir, "telemetry.sqlite");

mkdirSync(join(dataHome, "supervisor"), { recursive: true });
mkdirSync(join(dataHome, "run"), { recursive: true }); // host.token lives under dataHome/run
mkdirSync(join(supState, "run-1", "gates"), { recursive: true });
mkdirSync(join(supState, "run-1", "children"), { recursive: true });
mkdirSync(join(supState, "run-2", "gates"), { recursive: true });
mkdirSync(join(runsDir, "run-1"), { recursive: true });

// A valid sqlite store so the server's own bootstrap has somewhere to go.
{
  const { openTelemetryDb } = await import("./telemetry-store.mjs");
  const { ensureViews } = await import("./telemetry-canonical.mjs");
  const db = openTelemetryDb(dbPath);
  ensureViews(db);
  db.close();
}

const TOKEN = "cockpit-legacy-test-token";
writeFileSync(hostTokenPath({ LA_DATA_HOME: dataHome }), TOKEN, "utf8");

const LIVE_PID = process.pid; // alive on any platform, including a child's probe
const NOW = new Date().toISOString();

// run-1: the whole legacy panel — a live child, the pending question gate
// (with the FOC-449 decision event), two un-acked wake rows, the open holds.
writeFileSync(join(supState, "run-1", "children.json"), JSON.stringify({
  runId: "run-1",
  children: {
    "child-1": {
      childId: "child-1", squad: "dev", taskId: "FIX-42", status: "running",
      pid: LIVE_PID, model: "m1", startedAt: NOW, turns: [],
    },
  },
  rounds: {},
}), "utf8");
writeFileSync(join(supState, "run-1", "children", "child-1.jsonl"), "", "utf8");
writeFileSync(join(supState, "run-1", "triage.json"), JSON.stringify({ issue: "FIX-42" }), "utf8");
writeFileSync(join(supState, "run-1", "gates", "gate-1.json"), JSON.stringify({
  gateId: "gate-1", runId: "run-1", childId: "child-1", taskId: "FIX-42",
  kind: "question", status: "pending", createdAt: NOW,
  summary: "Which DB?",
  questions: ["which database should dev use?"],
  decisionEvents: [{ eventId: "ev-gate-1", runId: "run-1" }],
}), "utf8");
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
  holds: [
    {
      id: "hold-1", origin: "test", question: "switch the pricing source?",
      recommendation: "yes", options: [{ label: "switch", model: "m1", costUsd: 0 }],
      impact: "high", state: "open", createdAt: NOW, presentedAt: null, until: null,
      answer: null, history: [{ event: "created", at: NOW }], blocks: null, resolution: null,
    },
    {
      id: "hold-2", origin: "test", question: "an open one?",
      recommendation: "wait", options: [{ label: "wait", model: "m1", costUsd: 0 }],
      impact: "low", state: "open", createdAt: NOW, presentedAt: null, until: null,
      answer: null, history: [{ event: "created", at: NOW }], blocks: null, resolution: null,
    },
  ],
}), "utf8");

// run-2: the native scenario's untouched gate + hold (answered there with
// notified:false — the host does not exist to carry the notice).
writeFileSync(join(supState, "run-2", "gates", "gate-2.json"), JSON.stringify({
  gateId: "gate-2", runId: "run-2", childId: "child-9", taskId: "FIX-43",
  kind: "question", status: "pending", createdAt: NOW, summary: "pick a port",
  questions: ["which port?"],
}), "utf8");
writeFileSync(join(supState, "run-2", "holds.json"), JSON.stringify({
  version: 1,
  holds: [{
    id: "hold-2", origin: "test", question: "hold the deploy?",
    recommendation: "no", options: [{ label: "go", model: "m1", costUsd: 0 }],
    impact: "low", state: "open", createdAt: NOW, presentedAt: null, until: null,
    answer: null, history: [{ event: "created", at: NOW }], blocks: null, resolution: null,
  }],
}), "utf8");

// The LEGACY session record: a Claude UUID sessionId (never a sup- id) — the
// same fixture shape the sibling suite carries. Written before both spawns;
// the legacy conversation/snapshot paths read it, the write routes never need
// it (their session id comes from the request body only).
writeFileSync(join(dataHome, "supervisor", "session.json"), JSON.stringify({
  sessionId: "sess-1", transcriptPath: "", cwd: dir, state: "idle",
  notification: null, updatedAt: NOW,
}), "utf8");

// ── the fake session host ────────────────────────────────────────────────────

const hostCalls = []; // { method, url, token, body }

const fakeHost = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  let body = null;
  try { body = JSON.parse(raw); } catch { body = raw || null; }
  hostCalls.push({ method: req.method, url: req.url, token: req.headers["x-fenix-host-token"] ?? null, body });

  if (req.url === "/state") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      session: "running", panePid: 4242, paneDead: false, clients: ["tmux-dash-1"],
      hook: { sessionId: "sess-host-1", transcriptPath: "", cwd: dir, state: "idle", notification: null, updatedAt: NOW },
      state: "idle",
    }));
    return;
  }
  if (req.url === "/alive") {
    const pids = Array.isArray(body?.pids) ? body.pids : [];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(Object.fromEntries(pids.map((p) => [String(p), true]))));
    return;
  }
  // The managed-sessions probe: an EMPTY list — the whole point of D0.
  if (req.url === "/sessions" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ sessions: [] }));
    return;
  }
  if (req.url === "/message") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ sent: true, confirmed: true, queued: false }));
    return;
  }
  if (req.url === "/session") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ready: true }));
    return;
  }
  if (req.url === "/dialog") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ dialog: null }));
    return;
  }
  if (req.url === "/dialog/answer") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ sent: true, closed: true, noteSent: false }));
    return;
  }
  if (req.url === "/dialog/ask") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ answered: true }));
    return;
  }
  // Anything scoped (/sessions/<sid>/…) must never be hit in legacy mode —
  // answer 404 so a stray scoped forward is LOUD (recorded + non-200), not
  // silently absorbed.
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

await new Promise((resolve) => fakeHost.listen(0, "127.0.0.1", resolve));
const HOST_URL = `http://127.0.0.1:${fakeHost.address().port}`;

// ── server spawns ────────────────────────────────────────────────────────────

const baseEnv = {
  ...process.env,
  LA_TELEMETRY_DB: dbPath,
  LA_TELEMETRY_HOME: join(dir, "telemetry-home"),
  LA_DATA_HOME: dataHome,
  LA_SQUAD_HOME: join(dir, "agents"),
  LA_SUPERVISOR_STATE_HOME: supState,
  LA_STATE_ROOT: join(dir, "state-root"),
  LA_DECISION_RUNS_DIR: runsDir,
};
delete baseEnv.LA_ANALYSIS_CACHE;
// The seams must decide the mode — never the operator's own environment.
delete baseEnv.FENIX_SUPERVISOR_HOST;
delete baseEnv.FENIX_SUPERVISOR_SESSION_ID;

const spawnCockpitServer = (env) => spawnTestServer({
  script: join(__dir, "telemetry-server.mjs"),
  env,
  inheritEnv: false, // baseEnv already spreads process.env (minus the seams above)
  label: "cockpit-legacy-mode",
});

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

const editsRows = (runId) => existsSync(join(supState, runId, "edits.jsonl"))
  ? readFileSync(join(supState, runId, "edits.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : [];

// ── the two scenarios ────────────────────────────────────────────────────────

let servers = [];
try {
  // ── Mode D0 — Docker, the host reachable with an EMPTY session list ──────
  {
    const spawned = await spawnCockpitServer({ ...baseEnv, FENIX_SUPERVISOR_HOST: HOST_URL });
    servers.push(spawned);
    const P = spawned.port;

    // POST /api/supervisor/message — forwarded to the GLOBAL /message
    // (baseline: sibling "message -> host 200 pass-through"; the GET /sessions
    // probe running and finding none is today's FOC-839 addition).
    hostCalls.length = 0;
    const msg = await call(P, "POST", "/api/supervisor/message", { body: { text: "status of all children?" } });
    check("D0 message -> 200 sent (no 409 selection-required)",
      msg.status === 200 && msg.body?.sent === true && msg.body?.error !== "selection-required",
      JSON.stringify(msg));
    const msgFwd = hostCalls.find((c) => c.method === "POST" && c.url === "/message");
    check("D0 message text forwarded verbatim to the GLOBAL /message",
      msgFwd?.body?.text === "status of all children?" && msgFwd?.token === TOKEN,
      JSON.stringify(msgFwd));
    check("D0 the managed-sessions probe ran (GET /sessions) before the forward",
      hostCalls.some((c) => c.method === "GET" && c.url === "/sessions"),
      JSON.stringify(hostCalls.map((c) => `${c.method} ${c.url}`)));

    // POST /api/supervisor/session — fresh needs the typed confirm; plain
    // ensure forwards (baseline: sibling lines 501–509).
    const freshNo = await call(P, "POST", "/api/supervisor/session", { body: { fresh: true } });
    check("D0 session fresh without confirm -> 400", freshNo.status === 400, JSON.stringify(freshNo));
    const freshYes = await call(P, "POST", "/api/supervisor/session", { body: { fresh: true, confirm: "new-session" } });
    check("D0 session fresh+confirm -> 200 ready, forwarded fresh:true",
      freshYes.status === 200 && freshYes.body?.ready === true
      && hostCalls.filter((c) => c.url === "/session").pop()?.body?.fresh === true,
      JSON.stringify(freshYes));
    const plain = await call(P, "POST", "/api/supervisor/session", { body: {} });
    check("D0 session plain ensure -> 200, forwarded fresh:false",
      plain.status === 200
      && hostCalls.filter((c) => c.url === "/session").pop()?.body?.fresh === false,
      JSON.stringify(plain));

    // POST /api/supervisor/wake — the drain prompt, the waker's own wording
    // (baseline: sibling lines 512–520).
    const wake = await call(P, "POST", "/api/supervisor/wake", { body: {} });
    const wakeMsg = hostCalls.filter((c) => c.url === "/message").pop();
    check("D0 wake -> 200 sent", wake.status === 200 && wake.body?.sent === true, JSON.stringify(wake));
    check("D0 wake prompt is the prefixed waker wording for run-1",
      typeof wakeMsg?.body?.text === "string"
      && wakeMsg.body.text.startsWith("[dashboard] Mateusz asked you to check waiting events: ")
      && wakeMsg.body.text.includes("2 new wake event(s) in run run-1")
      && wakeMsg.body.text.includes("supervisor-status.mjs --drain --tail 20"),
      JSON.stringify(wakeMsg?.body));

    // POST /api/supervisor/ask — no pending ask anywhere: 409 ask-changed,
    // nothing forwarded (baseline: sibling lines 767–775).
    hostCalls.length = 0;
    const ask = await call(P, "POST", "/api/supervisor/ask", { body: { toolUseId: "toolu_x", answers: [{ choices: [0] }] } });
    check("D0 ask with no pending ask -> 409 ask-changed (never 409 selection-required)",
      ask.status === 409 && ask.body?.error === "ask-changed", JSON.stringify(ask));
    check("D0 ask forwarded nothing", !hostCalls.some((c) => c.url === "/dialog/ask"),
      JSON.stringify(hostCalls.map((c) => c.url)));

    // POST /api/supervisor/dialog — forwarded { id, choice, note } to the
    // GLOBAL /dialog/answer (baseline: sibling lines 829–837).
    hostCalls.length = 0;
    const dlg = await call(P, "POST", "/api/supervisor/dialog", { body: { id: "dlg-perm-1", choice: "deny", note: "not now" } });
    check("D0 dialog -> 200 pass-through sent+closed",
      dlg.status === 200 && dlg.body?.sent === true && dlg.body?.closed === true, JSON.stringify(dlg));
    const dlgFwd = hostCalls.find((c) => c.url === "/dialog/answer");
    check("D0 dialog forwards id, choice and note",
      dlgFwd?.body?.id === "dlg-perm-1" && dlgFwd?.body?.choice === "deny" && dlgFwd?.body?.note === "not now",
      JSON.stringify(dlgFwd?.body));

    // POST /api/gates/answer — happy path (baseline: sibling lines 522–560):
    // the gate is recorded, the notice hits the global /message, the audit row
    // is notified:true, the FOC-449 label lands.
    hostCalls.length = 0;
    const answer = await call(P, "POST", "/api/gates/answer", {
      body: { runId: "run-1", gateId: "gate-1", text: "use postgres", note: "decided in the cockpit" },
    });
    check("D0 gate answer -> 200 recorded+notified",
      answer.status === 200 && answer.body?.recorded === true && answer.body?.notified === true,
      JSON.stringify(answer).slice(0, 300));
    const gateOnDisk = JSON.parse(readFileSync(join(supState, "run-1", "gates", "gate-1.json"), "utf8"));
    check("D0 gate file answered with answeredBy dashboard",
      gateOnDisk.status === "answered" && gateOnDisk.answer?.answeredBy === "dashboard" && gateOnDisk.answer?.text === "use postgres",
      JSON.stringify(gateOnDisk.answer));
    const notice = hostCalls.find((c) => c.url === "/message" && c.body?.text?.includes("gate-1"));
    check("D0 gate notice carries the dashboard wording on the GLOBAL /message",
      typeof notice?.body?.text === "string"
      && notice.body.text.startsWith("[dashboard] Mateusz answered gate-1 for child-1 (FIX-42)")
      && notice.body.text.includes("the answer is recorded in the gate — deliver it now."),
      JSON.stringify(notice?.body));
    const gateRow = editsRows("run-1").find((r) => r.type === "gate-answer");
    check("D0 gate answer audit row: who dashboard, notified:true, path gates/gate-1.json",
      gateRow?.who === "dashboard" && gateRow?.notified === true && gateRow?.path === "gates/gate-1.json",
      JSON.stringify(gateRow));
    // Today (FOC-839): the legacy answer (no sessionId) probes GET /sessions
    // and NEVER touches a scoped /sessions/<sid>/… route — the scoped fake
    // answers 404, so a stray forward would be both recorded and non-200.
    check("D0 legacy gate answer notified via the global /message only",
      hostCalls.some((c) => c.method === "POST" && c.url === "/message")
      && !hostCalls.some((c) => c.url.startsWith("/sessions/")),
      JSON.stringify(hostCalls.map((c) => `${c.method} ${c.url}`)));
    const label = readFileSync(join(runsDir, "run-1", "decisions.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l))
      .find((l) => l.type === "label" && l.eventId === "ev-gate-1");
    check("D0 gate answer labels the decision event (human/gate provenance)",
      label && label.outcome === "use postgres" && label.by === "human" && label.source === "auto" && label.via === "gate",
      JSON.stringify(label));
    const again = await call(P, "POST", "/api/gates/answer", { body: { runId: "run-1", gateId: "gate-1", text: "use postgres" } });
    check("D0 gate answer twice -> 409 already-answered",
      again.status === 409 && again.body?.error === "already-answered", JSON.stringify(again));

    // POST /api/gates/notify — answered re-notified, pending/missing refused
    // (baseline: sibling lines 566–572, 612–616).
    const notify = await call(P, "POST", "/api/gates/notify", { body: { runId: "run-1", gateId: "gate-1" } });
    check("D0 gate notify answered -> 200 notified", notify.status === 200 && notify.body?.notified === true, JSON.stringify(notify));
    const notifyPending = await call(P, "POST", "/api/gates/notify", { body: { runId: "run-2", gateId: "gate-2" } });
    check("D0 gate notify pending -> 409 still-pending", notifyPending.status === 409, JSON.stringify(notifyPending));
    const notifyMissing = await call(P, "POST", "/api/gates/notify", { body: { runId: "run-2", gateId: "gate-nope" } });
    check("D0 gate notify missing -> 404", notifyMissing.status === 404, JSON.stringify(notifyMissing));
    const notifyBoth = await call(P, "POST", "/api/gates/notify", { body: { runId: "run-1", gateId: "gate-1", holdId: "hold-1" } });
    check("D0 notify both ids -> 400", notifyBoth.status === 400, JSON.stringify(notifyBoth));
    const notifyNeither = await call(P, "POST", "/api/gates/notify", { body: { runId: "run-1" } });
    check("D0 notify neither id -> 400", notifyNeither.status === 400, JSON.stringify(notifyNeither));

    // POST /api/holds/answer — same pattern on the holds store (baseline:
    // sibling lines 574–582).
    hostCalls.length = 0;
    const holdAnswer = await call(P, "POST", "/api/holds/answer", { body: { runId: "run-1", holdId: "hold-1", text: "switch it" } });
    check("D0 hold answer -> 200 recorded+notified",
      holdAnswer.status === 200 && holdAnswer.body?.recorded === true && holdAnswer.body?.notified === true,
      JSON.stringify(holdAnswer));
    const holdsOnDisk = JSON.parse(readFileSync(join(supState, "run-1", "holds.json"), "utf8"));
    check("D0 hold file answered with answeredBy dashboard",
      holdsOnDisk.holds.find((h) => h.id === "hold-1")?.state === "answered"
      && holdsOnDisk.holds.find((h) => h.id === "hold-1")?.answer?.answeredBy === "dashboard",
      JSON.stringify(holdsOnDisk.holds.find((h) => h.id === "hold-1")?.answer));
    const holdRow = editsRows("run-1").filter((r) => r.type === "hold-answer");
    check("D0 hold answer audit row notified:true", holdRow.length === 1 && holdRow[0].notified === true, JSON.stringify(holdRow));
    const holdNotice = hostCalls.find((c) => c.url === "/message");
    check("D0 hold notice wording matches /api/holds/answer on the GLOBAL /message",
      typeof holdNotice?.body?.text === "string"
      && holdNotice.body.text === "[dashboard] Mateusz answered hold hold-1 (no task) in the Cockpit; the answer is recorded — act on it now.",
      JSON.stringify(holdNotice?.body));

    // The "Tell the Supervisor" fallback for holds (baseline: sibling lines
    // 584–610): an OPEN hold is 409 still-open, a missing one 404, the
    // answered one re-notifies with the exact wording.
    const holdOpen = await call(P, "POST", "/api/gates/notify", { body: { runId: "run-1", holdId: "hold-2" } });
    check("D0 hold notify open -> 409 still-open",
      holdOpen.status === 409 && holdOpen.body?.error === "still-open", JSON.stringify(holdOpen));
    const holdMissing = await call(P, "POST", "/api/gates/notify", { body: { runId: "run-1", holdId: "hold-nope" } });
    check("D0 hold notify missing -> 404", holdMissing.status === 404, JSON.stringify(holdMissing));
    hostCalls.length = 0;
    const holdNotify = await call(P, "POST", "/api/gates/notify", { body: { runId: "run-1", holdId: "hold-1" } });
    check("D0 hold notify answered -> 200 notified",
      holdNotify.status === 200 && holdNotify.body?.notified === true, JSON.stringify(holdNotify));
    const holdNotifyCall = hostCalls.find((c) => c.url === "/message");
    check("D0 hold re-notify wording matches /api/holds/answer",
      typeof holdNotifyCall?.body?.text === "string"
      && holdNotifyCall.body.text === "[dashboard] Mateusz answered hold hold-1 (no task) in the Cockpit; the answer is recorded — act on it now.",
      JSON.stringify(holdNotifyCall?.body));

    // No stray writes: run-1's audit log carries exactly the two answers.
    check("D0 no stray audit rows in run-1",
      editsRows("run-1").length === 2
      && editsRows("run-1").every((r) => r.type === "gate-answer" || r.type === "hold-answer"),
      JSON.stringify(editsRows("run-1").map((r) => r.type)));

    await spawned.stop();
  }

  // ── Mode N — native: no FENIX_SUPERVISOR_HOST ─────────────────────────────
  {
    hostCalls.length = 0; // the D0 calls are asserted above — count only new ones
    const spawned = await spawnCockpitServer({ ...baseEnv });
    servers.push(spawned);
    const P = spawned.port;

    // The forwarded routes: 503 docker-only with the exact error shape
    // (baseline: sibling native block, lines 943–951).
    const msg = await call(P, "POST", "/api/supervisor/message", { body: { text: "hi" } });
    check("N message -> 503 docker-only", msg.status === 503 && msg.body?.error === "docker-only", JSON.stringify(msg));
    const freshNo = await call(P, "POST", "/api/supervisor/session", { body: { fresh: true } });
    check("N session fresh without confirm -> 400 even natively (validation first)",
      freshNo.status === 400, JSON.stringify(freshNo));
    const freshYes = await call(P, "POST", "/api/supervisor/session", { body: { fresh: true, confirm: "new-session" } });
    check("N session fresh+confirm -> 503 docker-only", freshYes.status === 503 && freshYes.body?.error === "docker-only",
      JSON.stringify(freshYes));
    const wake = await call(P, "POST", "/api/supervisor/wake", { body: {} });
    check("N wake -> 503 docker-only", wake.status === 503 && wake.body?.error === "docker-only", JSON.stringify(wake));
    const askMissing = await call(P, "POST", "/api/supervisor/ask", { body: { toolUseId: "toolu_x" } });
    check("N ask without answers -> 400 even natively (validation before the mode check)",
      askMissing.status === 400, JSON.stringify(askMissing));
    const ask = await call(P, "POST", "/api/supervisor/ask", { body: { toolUseId: "toolu_x", answers: [] } });
    check("N ask -> 503 docker-only", ask.status === 503 && ask.body?.error === "docker-only", JSON.stringify(ask));
    const dlg = await call(P, "POST", "/api/supervisor/dialog", { body: { id: "dlg-1", choice: "deny" } });
    check("N dialog -> 503 docker-only", dlg.status === 503 && dlg.body?.error === "docker-only", JSON.stringify(dlg));

    // Today (FOC-839): the bad-session-id guard answers BEFORE any write —
    // even natively, the gate file and the edits audit stay untouched.
    const gate2Before = readFileSync(join(supState, "run-2", "gates", "gate-2.json"), "utf8");
    const malformed = await call(P, "POST", "/api/gates/answer", {
      body: { runId: "run-2", gateId: "gate-2", text: "x", sessionId: "not-a-sup-id" },
    });
    check("N gate answer malformed sessionId -> 400 bad-session-id",
      malformed.status === 400 && malformed.body?.error === "bad-session-id", JSON.stringify(malformed));
    check("N the malformed answer wrote nothing",
      readFileSync(join(supState, "run-2", "gates", "gate-2.json"), "utf8") === gate2Before
      && !existsSync(join(supState, "run-2", "edits.jsonl")),
      "gate file or edits row changed");

    // The write routes still work natively — recorded, notified:false (the
    // host does not exist to carry the notice; baseline: sibling host-down
    // block lines 927–932, native variant).
    const answer = await call(P, "POST", "/api/gates/answer", { body: { runId: "run-2", gateId: "gate-2", text: "port 7332" } });
    check("N gate answer -> 200 recorded, notified false",
      answer.status === 200 && answer.body?.recorded === true && answer.body?.notified === false,
      JSON.stringify(answer));
    const gate2OnDisk = JSON.parse(readFileSync(join(supState, "run-2", "gates", "gate-2.json"), "utf8"));
    check("N gate file answered with answeredBy dashboard",
      gate2OnDisk.status === "answered" && gate2OnDisk.answer?.answeredBy === "dashboard", JSON.stringify(gate2OnDisk.answer));
    const notify = await call(P, "POST", "/api/gates/notify", { body: { runId: "run-2", gateId: "gate-2" } });
    check("N gate notify answered -> 200 notified:false (no host)", notify.status === 200 && notify.body?.notified === false,
      JSON.stringify(notify));
    const holdAnswer = await call(P, "POST", "/api/holds/answer", { body: { runId: "run-2", holdId: "hold-2", text: "hold it" } });
    check("N hold answer -> 200 recorded, notified false",
      holdAnswer.status === 200 && holdAnswer.body?.recorded === true && holdAnswer.body?.notified === false,
      JSON.stringify(holdAnswer));
    const hold2OnDisk = JSON.parse(readFileSync(join(supState, "run-2", "holds.json"), "utf8"));
    check("N hold file answered with answeredBy dashboard",
      hold2OnDisk.holds[0].state === "answered" && hold2OnDisk.holds[0].answer?.answeredBy === "dashboard",
      JSON.stringify(hold2OnDisk.holds[0].answer));

    // The audit rows say notified:false, exactly two of them, and the fake
    // host recorded NOTHING — native mode never reaches for the host.
    const rows = editsRows("run-2");
    check("N audit rows: gate-answer + hold-answer, both notified:false",
      rows.length === 2 && rows.every((r) => (r.type === "gate-answer" || r.type === "hold-answer") && r.notified === false),
      JSON.stringify(rows));

    await spawned.stop();
    check("N native mode made no host call at all", hostCalls.length === 0,
      JSON.stringify(hostCalls.map((c) => `${c.method} ${c.url}`)));
  }
} catch (err) {
  failed++;
  failures.push(`unexpected error — ${err?.stack || err}`);
  for (const s of servers) if (s.child.stderrBuf) console.error(`[child stderr] ${s.child.stderrBuf}`);
} finally {
  for (const s of servers) await s.stop();
  fakeHost.close();
}

// ── report ───────────────────────────────────────────────────────────────────

console.log(`\ncockpit-legacy-mode: ${passed} passed, ${failed} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
rmSync(dir, { recursive: true, force: true });
process.exitCode = failed ? 1 : 0;
