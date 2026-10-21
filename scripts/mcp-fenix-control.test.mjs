// Route-level tests for the fenix-control MCP tool table (FOC-958 phase B).
//
// The REAL telemetry-server is spawned (cockpit-routes.test.mjs's harness:
// Docker mode against a fake session host, then native mode) with isolated
// seams, and the MCP handler runs IN-PROCESS with its HTTP transport pointed
// at the spawned server — so every tool call crosses the real routes, the real
// guards and the real audit writes, exactly as a dashboard call would. The
// stdio loop itself is never spawned.
//
// Proven here, through the MCP protocol:
//   - tools/list: exactly the ten FOC-958 tools, closed schemas;
//   - every read tool (status, inbox, sessions, conversation, queue, costs)
//     answers ok:true through its route, trimmed and paged;
//   - the canary: a secret planted in the Linear title (a surface the routes
//     do NOT redact), a gate summary and the conversation transcript never
//     appears in ANY tool result — the tool layer masks per string field;
//   - the write tools: message forwarded verbatim, dialog forwarded, ask
//     refused 409 ask-changed on a stale toolUseId, the ask answer's audit row
//     recorded with who "remote:test", the gate answer's gate record carries
//     answeredBy "remote:test";
//   - the actor: the x-fenix-actor header is honoured only in the remote:
//     shape (a direct route call with "remote:direct" records it; a spoofed
//     value falls back to "dashboard"), and the MCP initialize clientInfo
//     becomes the client part (remote:GrokApp);
//   - typed errors: egress_blocked on a secret-shaped message, invalid_input
//     on missing text, already-answered on the second gate answer,
//     docker-only natively for message and sessions;
//   - callTool never throws: a runner that explodes still answers an envelope.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { openTelemetryDb } from "./telemetry-store.mjs";
import { ensureViews } from "./telemetry-canonical.mjs";
import { writeCurrentRun } from "./supervisor-current-run.mjs";
import { hostTokenPath } from "./fenix-paths.mjs";
import { spawnTestServer } from "./test-spawn.mjs";
import { createFenixControlServer, SERVER_INFO } from "./mcp/fenix-control-tools.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) { passed++; return; }
  failed++;
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

// ── fixtures: one tmp tree for every seam (cockpit-routes.test.mjs's shape) ──

const dir = mkdtempSync(join(tmpdir(), "fenix-control-"));
const dataHome = join(dir, "data");
const squadHome = join(dir, "agents");
const supState = join(dir, "sup-state");
const runsDir = join(dir, "state-root", "runs");
const dbPath = join(dir, "telemetry.sqlite");

mkdirSync(join(dataHome, "supervisor"), { recursive: true });
mkdirSync(join(dataHome, "run"), { recursive: true });
mkdirSync(join(squadHome, "supervisor", "projects"), { recursive: true });
mkdirSync(join(supState, "run-1", "gates"), { recursive: true });
mkdirSync(join(supState, "run-1", "children"), { recursive: true });
mkdirSync(join(supState, "run-2", "gates"), { recursive: true });
mkdirSync(runsDir, { recursive: true });

{
  const db = openTelemetryDb(dbPath);
  ensureViews(db);
  db.close();
}

const TOKEN = "fenix-control-test-token";
writeFileSync(hostTokenPath({ LA_DATA_HOME: dataHome }), TOKEN, "utf8");

const LIVE_PID = process.pid;
const NOW = new Date().toISOString();
// The canary: three surfaces, one of which (the Linear title) the ROUTES do
// not redact — only the tool layer's own scrub may catch that one. Long enough
// after the sk- prefix to also trip the egress screen's 16+-char token rule.
const CANARY = "sk-CANARYabcdef0123456789";

// The Supervisor session + a 30-entry transcript so the tool's default tail
// (20) is distinguishable from the route's default (200).
const transcriptPath = join(squadHome, "supervisor", "projects", "sess-1.jsonl");
const transcriptLines = [];
for (let i = 1; i <= 30; i++) {
  const role = i % 2 === 1 ? "user" : "assistant";
  const content = role === "user"
    ? `turn ${i} check status with token ${CANARY}`
    : [{ type: "text", text: `turn ${i} reply` }];
  transcriptLines.push(JSON.stringify({ type: role, uuid: `u${i}`, timestamp: NOW, message: { content } }));
}
writeFileSync(transcriptPath, transcriptLines.join("\n") + "\n", "utf8");
writeFileSync(join(dataHome, "supervisor", "session.json"), JSON.stringify({
  sessionId: "sess-1", transcriptPath, cwd: dir, state: "idle",
  notification: null, updatedAt: NOW,
}), "utf8");

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
  summary: `Which DB? echo ${CANARY}`,
  questions: ["which database should dev use?"],
  decisionEvents: [{ eventId: "ev-gate-1", runId: "run-1" }],
}), "utf8");
mkdirSync(join(runsDir, "run-1"), { recursive: true });
writeFileSync(join(runsDir, "run-1", "decisions.jsonl"), `${JSON.stringify({
  type: "event", eventId: "ev-gate-1", decisionId: "test.pick-db", ts: NOW, ok: true,
})}\n`, "utf8");
writeFileSync(join(supState, "run-1", "holds.json"), JSON.stringify({
  version: 1,
  holds: [{
    id: "hold-1", origin: "test", question: `switch the source? ${CANARY}`,
    recommendation: "yes", options: [{ label: "switch", model: "m1", costUsd: 0 }],
    impact: "high", state: "open", createdAt: NOW, presentedAt: null, until: null,
    answer: null, history: [{ event: "created", at: NOW }], blocks: null, resolution: null,
  }],
}), "utf8");
writeFileSync(join(supState, "run-1", "wake-queue.jsonl"), `${JSON.stringify({
  seq: 1, event: "exit", childId: "child-0", turn: 1, dedupKey: "exit:child-0:1", detail: {}, ts: NOW,
})}\n`, "utf8");
writeFileSync(join(supState, "run-1", "waker.json"), JSON.stringify({
  pid: LIVE_PID, sessionId: "waker-sess", startedAt: NOW, heartbeatAt: NOW, firedThrough: 0,
}), "utf8");

// run-2: three pending gates for the actor tests (MCP tool, direct header,
// spoofed header) — each answered at most once.
for (const gateId of ["gate-2", "gate-3", "gate-4"]) {
  writeFileSync(join(supState, "run-2", "gates", `${gateId}.json`), JSON.stringify({
    gateId, runId: "run-2", childId: "child-2", taskId: "FIX-43",
    kind: "question", status: "pending", createdAt: NOW, summary: `gate ${gateId}`,
    questions: ["which port?"],
  }), "utf8");
}

// ── the TEST-ONLY Linear fixture (work-routes.test.mjs's seam) ───────────────

const linearFixturePath = join(dir, "linear-fake.json");
writeFileSync(linearFixturePath, JSON.stringify({
  queue: {
    tasks: [{
      identifier: "WORK-3", title: `Ready ticket (${CANARY})`, url: "https://linear.app/jointhubs/issue/WORK-3",
      team: "FEN", state: "Todo", stateType: "unstarted", priority: 2, estimate: 3,
      updatedAt: NOW, assignee: null, labels: ["fenix"], parent: null, suggestedSquad: "dev",
    }],
    error: null,
    fetchedAt: NOW,
  },
  issues: {
    "WORK-3": {
      identifier: "WORK-3", title: `Ready ticket (${CANARY})`, url: "https://linear.app/jointhubs/issue/WORK-3",
      description: "Ready to start.",
      state: { name: "Todo", type: "unstarted" },
    },
  },
}), "utf8");

// ── the fake session host ────────────────────────────────────────────────────

const hostCalls = [];
const fakeHost = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  let body = null;
  try { body = JSON.parse(raw); } catch { body = raw || null; }
  hostCalls.push({ method: req.method, url: req.url, body });

  if (req.url === "/state") {
    const b = fakeHostBehavior.state ?? {
      status: 200,
      body: {
        session: "running", panePid: 4242, paneDead: false, clients: [],
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
  // Empty session list: fenix_sessions answers 200, and the managed-session
  // probes (which would 409 the global routes) stay negative.
  if (req.url === "/sessions") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ sessions: [], maxActive: 3 }));
    return;
  }
  if (/^\/sessions\/sup-[a-f0-9]+$/.test(req.url ?? "")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ taskSession: { sessionId: req.url.split("/")[2], status: "running" } }));
    return;
  }
  if (/^\/sessions\/sup-[a-f0-9]+\/message$/.test(req.url ?? "")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ sent: true, confirmed: true, queued: false }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});
const fakeHostBehavior = {};
await new Promise((resolve) => fakeHost.listen(0, "127.0.0.1", resolve));
const HOST_URL = `http://127.0.0.1:${fakeHost.address().port}`;

// ── server spawns ────────────────────────────────────────────────────────────

const baseEnv = {
  ...process.env,
  NODE_ENV: "test",
  FENIX_LINEAR_FAKE_FILE: linearFixturePath,
  LA_LINEAR_NO_ENV_FILE: "1",
  LINEAR_API_KEY: "",
  FENIX_COST_SNAPSHOT_TTL_MS: "60000",
  LA_TELEMETRY_DB: dbPath,
  LA_TELEMETRY_HOME: join(dir, "telemetry-home"),
  LA_DATA_HOME: dataHome,
  LA_SQUAD_HOME: squadHome,
  LA_SUPERVISOR_STATE_HOME: supState,
  LA_STATE_ROOT: join(dir, "state-root"),
  LA_DECISION_RUNS_DIR: runsDir,
};
delete baseEnv.LA_ANALYSIS_CACHE;

const spawnControlServer = (env) => spawnTestServer({
  script: join(__dir, "telemetry-server.mjs"),
  env,
  inheritEnv: false,
  label: "mcp-fenix-control",
});

// ── MCP helpers ──────────────────────────────────────────────────────────────

const callTool = (server, name, args, id = 1) =>
  server.handleMessage({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

const envelopeOf = (response) => JSON.parse(response.result.content[0].text);

const servers = [];
try {
  // ── Docker mode, host reachable ──────────────────────────────────────────
  {
    const spawned = await spawnControlServer({ ...baseEnv, FENIX_SUPERVISOR_HOST: HOST_URL });
    servers.push(spawned);
    const P = spawned.port;

    // The tool layer over the real routes: client "test" → actor remote:test.
    const server = createFenixControlServer({ baseUrl: `http://127.0.0.1:${P}`, client: "test" });

    const init = await server.handleMessage({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
    check("initialize reports the fenix-control server info",
      init.result.serverInfo.name === "fenix-control" && init.result.serverInfo.version === SERVER_INFO.version,
      JSON.stringify(init.result.serverInfo));
    const list = await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const names = list.result.tools.map((t) => t.name);
    check("tools/list returns exactly the ten FOC-958 tools",
      JSON.stringify(names) === JSON.stringify([
        "fenix_status", "fenix_inbox", "fenix_sessions", "fenix_conversation",
        "fenix_queue", "fenix_costs", "fenix_message", "fenix_ask_answer",
        "fenix_dialog_answer", "fenix_gate_answer",
      ]), JSON.stringify(names));
    for (const tool of list.result.tools) {
      if (tool.inputSchema.additionalProperties !== false) check(`schema closed: ${tool.name}`, false, "additionalProperties not false");
    }

    // ── the read tools ─────────────────────────────────────────────────────
    const status = envelopeOf(await callTool(server, "fenix_status", {}));
    check("fenix_status -> ok, supervisor state idle via the route",
      status.ok === true && status.data?.supervisor?.state === "idle" && status.data?.supervisor?.host === "reachable"
        && typeof status.data?.counts === "object",
      JSON.stringify(status).slice(0, 300));
    check("fenix_status keeps structured ids intact (no opaque-run masking)",
      status.data?.supervisor?.focus?.runId === "run-1" && status.data?.supervisor?.focus?.taskId === "FIX-42",
      JSON.stringify(status.data?.supervisor?.focus));

    const inbox = envelopeOf(await callTool(server, "fenix_inbox", {}));
    const gateItem = (inbox.data?.needsYou ?? []).find((it) => it.category === "gate" && it.gateId === "gate-1");
    check("fenix_inbox -> the pending gate is answerable and carries ids",
      inbox.ok === true && gateItem?.state === "pending" && gateItem?.answerable === true
        && gateItem?.runId === "run-1" && gateItem?.taskId === "FIX-42",
      JSON.stringify(gateItem));
    check("fenix_inbox counts", inbox.data?.counts?.needsYou >= 2, JSON.stringify(inbox.data?.counts));

    const sessions = envelopeOf(await callTool(server, "fenix_sessions", {}));
    check("fenix_sessions -> the host's (empty) list through the route",
      sessions.ok === true && Array.isArray(sessions.data?.sessions) && sessions.data?.maxActive === 3,
      JSON.stringify(sessions));

    const conv = envelopeOf(await callTool(server, "fenix_conversation", {}));
    check("fenix_conversation -> the tool's own 20-entry default tail",
      conv.ok === true && conv.data?.entries?.length === 20 && conv.data?.offset > 0,
      JSON.stringify({ n: conv.data?.entries?.length, offset: conv.data?.offset }));
    check("fenix_conversation masks the transcript canary",
      conv.data?.entries?.[0]?.text === "turn 11 check status with token sk-***",
      JSON.stringify(conv.data?.entries?.[0]));
    // The default call is a TAIL read — its offset is EOF. Forward paging
    // starts from after=0: the head, then the next page from its offset.
    const convHead = envelopeOf(await callTool(server, "fenix_conversation", { after: 0, limit: 5 }));
    check("fenix_conversation after=0 reads from the top",
      convHead.ok === true && convHead.data?.entries?.length === 5
        && convHead.data?.entries?.[0]?.text === "turn 1 check status with token sk-***",
      JSON.stringify(convHead.data?.entries?.[0]));
    const convNext = envelopeOf(await callTool(server, "fenix_conversation", { after: convHead.data.offset, limit: 5 }));
    check("fenix_conversation after=offset continues forward",
      convNext.ok === true && convNext.data?.entries?.length === 5
        && convNext.data?.entries?.[0]?.role === "assistant" && convNext.data?.entries?.[0]?.text === "turn 6 reply"
        && convNext.data?.reset === false,
      JSON.stringify({ n: convNext.data?.entries?.length, first: convNext.data?.entries?.[0], reset: convNext.data?.reset }));
    const convBad = envelopeOf(await callTool(server, "fenix_conversation", { limit: 501 }));
    check("fenix_conversation limit over 500 -> invalid_input", convBad.ok === false && convBad.error?.code === "invalid_input",
      JSON.stringify(convBad));

    const queue = envelopeOf(await callTool(server, "fenix_queue", {}));
    const work3 = (queue.data?.tickets ?? []).find((t) => t.taskId === "WORK-3");
    check("fenix_queue -> the board through the route, Ready ticket present",
      queue.ok === true && Array.isArray(queue.data?.tickets) && work3 !== undefined,
      JSON.stringify(queue).slice(0, 300));

    // The costs payload's first refresh runs the cost-snapshot child — poll
    // the raw route until "ok", then the tool reads the same snapshot.
    const deadline = Date.now() + 30000;
    let costsRaw = null;
    while (Date.now() < deadline) {
      costsRaw = await (await fetch(`http://127.0.0.1:${P}/api/costs?period=7d`)).json();
      if (costsRaw?.state === "ok") break;
      await new Promise((r) => setTimeout(r, 200));
    }
    check("costs route reached ok on the test store", costsRaw?.state === "ok", JSON.stringify(costsRaw).slice(0, 200));
    const costs = envelopeOf(await callTool(server, "fenix_costs", {}));
    check("fenix_costs -> summary with totals, today and at most 5 top tickets",
      costs.ok === true && costs.data?.state === "ok" && costs.data?.totals?.totalUsd === 0
        && costs.data?.today?.day === new Date().toISOString().slice(0, 10)
        && Array.isArray(costs.data?.topTickets) && costs.data.topTickets.length <= 5,
      JSON.stringify(costs.data));
    const costsBad = envelopeOf(await callTool(server, "fenix_costs", { period: "yesterday" }));
    check("fenix_costs unknown period -> invalid_input", costsBad.ok === false && costsBad.error?.code === "invalid_input",
      JSON.stringify(costsBad));

    // ── the canary: no tool result ever carries the planted secret ─────────
    const readEnvelopes = [];
    for (const [name, args] of [
      ["fenix_status", {}], ["fenix_inbox", {}], ["fenix_sessions", {}],
      ["fenix_conversation", {}], ["fenix_queue", {}], ["fenix_costs", {}],
    ]) {
      readEnvelopes.push(envelopeOf(await callTool(server, name, args)));
    }
    check("canary: the planted secret appears in NO read tool result",
      readEnvelopes.every((e) => !JSON.stringify(e).includes(CANARY)),
      readEnvelopes.map((e) => JSON.stringify(e).includes(CANARY)).join(","));
    check("canary: the queue's Linear title is masked by the TOOL layer (the routes do not redact the board)",
      JSON.stringify(readEnvelopes.find((e) => e.tool === "fenix_queue")).includes("sk-***"),
      JSON.stringify(readEnvelopes.find((e) => e.tool === "fenix_queue")).slice(0, 200));

    // ── the write tools ────────────────────────────────────────────────────
    hostCalls.length = 0;
    const msg = envelopeOf(await callTool(server, "fenix_message", { text: "status of all children?" }));
    check("fenix_message -> forwarded verbatim, host 200 pass-through",
      msg.ok === true && msg.data?.sent === true
        && hostCalls.find((c) => c.url === "/message")?.body?.text === "status of all children?",
      JSON.stringify(msg));

    hostCalls.length = 0;
    const dirty = envelopeOf(await callTool(server, "fenix_message", { text: `post this: Bearer ${CANARY}` }));
    check("fenix_message secret-shaped text -> egress_blocked, nothing sent",
      dirty.ok === false && dirty.error?.code === "egress_blocked" && !hostCalls.some((c) => c.url === "/message"),
      JSON.stringify(dirty));

    const msgBad = envelopeOf(await callTool(server, "fenix_message", {}));
    check("fenix_message without text -> invalid_input", msgBad.ok === false && msgBad.error?.code === "invalid_input",
      JSON.stringify(msgBad));

    const askStale = envelopeOf(await callTool(server, "fenix_ask_answer", { toolUseId: "toolu_stale", answers: [{ choices: [0] }] }));
    check("fenix_ask_answer stale toolUseId -> typed ask-changed",
      askStale.ok === false && askStale.error?.code === "ask-changed", JSON.stringify(askStale));

    const dlg = envelopeOf(await callTool(server, "fenix_dialog_answer", { id: "dlg-1", choice: "deny", note: "not now" }));
    check("fenix_dialog_answer -> forwarded id/choice/note",
      dlg.ok === true && dlg.data?.sent === true
        && hostCalls.find((c) => c.url === "/dialog/answer")?.body?.id === "dlg-1"
        && hostCalls.find((c) => c.url === "/dialog/answer")?.body?.choice === "deny"
        && hostCalls.find((c) => c.url === "/dialog/answer")?.body?.note === "not now",
      JSON.stringify(dlg));

    // ── the ask happy path: the audit row carries the remote actor ─────────
    const askTranscriptPath = join(squadHome, "supervisor", "projects", "ask-pending.jsonl");
    writeFileSync(askTranscriptPath, readFileSync(join(__dir, "fixtures", "session-dialogs", "pending-ask-multi.jsonl")), "utf8");
    const ASK_TOOL_ID = "toolu_mock_0450d5b7-a1be-4ca7-8270-405f3a99368a";
    fakeHostBehavior.state = {
      status: 200,
      body: {
        session: "running", panePid: 4242, paneDead: false, clients: [],
        hook: { sessionId: "sess-host-1", transcriptPath: askTranscriptPath, cwd: dir, state: "needs-input", notification: null, updatedAt: NOW },
        state: "needs-input",
      },
    };
    const runIdAsk = "2026-10-12T11-00-00-000-supervisor-f10c";
    mkdirSync(join(supState, runIdAsk), { recursive: true });
    writeCurrentRun(
      { runId: runIdAsk, model: "m1", startedAt: NOW, updatedAt: NOW, source: "pointer" },
      { path: join(dataHome, "supervisor", "current-run.json") },
    );
    const askOk = envelopeOf(await callTool(server, "fenix_ask_answer", { toolUseId: ASK_TOOL_ID, answers: [{ choices: [1] }, { choices: [0, 2] }] }));
    check("fenix_ask_answer -> host 200 answered", askOk.ok === true && askOk.data?.answered === true, JSON.stringify(askOk));
    let askRow = null;
    for (let waited = 0; waited < 2000 && !askRow; waited += 25) {
      try {
        askRow = readFileSync(join(supState, runIdAsk, "edits.jsonl"), "utf8")
          .split("\n").filter(Boolean).map((l) => JSON.parse(l))
          .find((r) => r.type === "ask-answer") ?? null;
      } catch {
        await new Promise((r) => setTimeout(r, 25)); // the row lands after the 200 — poll briefly
      }
    }
    check("ask answer audit row carries who remote:test",
      askRow?.who === "remote:test" && askRow?.notified === true, JSON.stringify(askRow));
    delete fakeHostBehavior.state;
    rmSync(join(dataHome, "supervisor", "current-run.json"));

    // ── the gate answer: the record carries the remote actor ───────────────
    const gate = envelopeOf(await callTool(server, "fenix_gate_answer", { runId: "run-1", gateId: "gate-1", text: "use postgres", note: "from grok" }));
    check("fenix_gate_answer -> recorded+notified",
      gate.ok === true && gate.data?.recorded === true && gate.data?.notified === true, JSON.stringify(gate).slice(0, 300));
    const gateOnDisk = JSON.parse(readFileSync(join(supState, "run-1", "gates", "gate-1.json"), "utf8"));
    check("gate record answeredBy remote:test",
      gateOnDisk.status === "answered" && gateOnDisk.answer?.answeredBy === "remote:test" && gateOnDisk.answer?.text === "use postgres",
      JSON.stringify(gateOnDisk.answer));
    const gateRow = readFileSync(join(supState, "run-1", "edits.jsonl"), "utf8").split("\n").filter(Boolean)
      .map((l) => JSON.parse(l)).find((r) => r.type === "gate-answer");
    check("gate answer audit row who remote:test, notified:true",
      gateRow?.who === "remote:test" && gateRow?.notified === true, JSON.stringify(gateRow));
    check("the gate envelope masks the summary canary", !JSON.stringify(gate).includes(CANARY), JSON.stringify(gate).slice(0, 200));

    const again = envelopeOf(await callTool(server, "fenix_gate_answer", { runId: "run-1", gateId: "gate-1", text: "use postgres" }));
    check("fenix_gate_answer twice -> typed already-answered",
      again.ok === false && again.error?.code === "already-answered", JSON.stringify(again));

    // ── the actor header at the route level, independent of the MCP layer ──
    // A well-formed remote: value is honoured; a spoofed non-remote value
    // falls back to "dashboard" — the header can never forge another kind.
    const direct = await fetch(`http://127.0.0.1:${P}/api/gates/answer`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-fenix-actor": "remote:direct" },
      body: JSON.stringify({ runId: "run-2", gateId: "gate-2", text: "port 7332" }),
    });
    check("direct remote:direct header -> 200", direct.status === 200, String(direct.status));
    check("direct header recorded answeredBy remote:direct",
      JSON.parse(readFileSync(join(supState, "run-2", "gates", "gate-2.json"), "utf8")).answer?.answeredBy === "remote:direct",
      "gate-2");
    const spoofed = await fetch(`http://127.0.0.1:${P}/api/gates/answer`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-fenix-actor": "ai" },
      body: JSON.stringify({ runId: "run-2", gateId: "gate-3", text: "port 7333" }),
    });
    check("spoofed x-fenix-actor (not remote:) -> still 200", spoofed.status === 200, String(spoofed.status));
    check("spoofed header falls back to the dashboard actor",
      JSON.parse(readFileSync(join(supState, "run-2", "gates", "gate-3.json"), "utf8")).answer?.answeredBy === "dashboard",
      "gate-3");

    // ── the MCP initialize clientInfo becomes the client part ──────────────
    const serverB = createFenixControlServer({ baseUrl: `http://127.0.0.1:${P}` });
    // Through handleLine — the stdio path the clientInfo peek actually sees.
    await serverB.handleLine(JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { clientInfo: { name: "Grok App!" } },
    }));
    const gateB = envelopeOf(await callTool(serverB, "fenix_gate_answer", { runId: "run-2", gateId: "gate-4", text: "port 7334" }));
    check("initialize clientInfo (sanitized) becomes the audit actor",
      gateB.ok === true
        && JSON.parse(readFileSync(join(supState, "run-2", "gates", "gate-4.json"), "utf8")).answer?.answeredBy === "remote:GrokApp",
      JSON.stringify(gateB).slice(0, 200));

    // callTool never throws — the route layer exploding is a typed envelope.
    // (validateArgs runs first here; the never-throw catch is proven natively
    // below with a transport that cannot connect.)
    const unknown = await server.handleMessage({
      jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "fenix_wake", arguments: {} },
    });
    check("unknown tool -> JSON-RPC invalidParams, never a crash", unknown.error?.code === -32602, JSON.stringify(unknown.error));

    await spawned.stop();
  }

  // ── Native mode (no FENIX_SUPERVISOR_HOST) ───────────────────────────────
  {
    const spawned = await spawnControlServer({ ...baseEnv });
    servers.push(spawned);
    const P = spawned.port;
    const server = createFenixControlServer({ baseUrl: `http://127.0.0.1:${P}`, client: "test" });

    const msg = envelopeOf(await callTool(server, "fenix_message", { text: "hi" }));
    check("native fenix_message -> typed docker-only", msg.ok === false && msg.error?.code === "docker-only", JSON.stringify(msg));
    const sessions = envelopeOf(await callTool(server, "fenix_sessions", {}));
    check("native fenix_sessions -> typed docker-only", sessions.ok === false && sessions.error?.code === "docker-only", JSON.stringify(sessions));

    // A base URL with nothing behind it: the transport failure is a typed
    // api_unreachable envelope, never a throw.
    const dead = createFenixControlServer({ baseUrl: "http://127.0.0.1:1", client: "test" });
    const deadStatus = envelopeOf(await callTool(dead, "fenix_status", {}));
    check("API unreachable -> typed api_unreachable, callTool did not throw",
      deadStatus.ok === false && deadStatus.error?.code === "api_unreachable", JSON.stringify(deadStatus));

    await spawned.stop();
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

console.log(`\nfenix-control: ${passed} passed, ${failed} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
rmSync(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
