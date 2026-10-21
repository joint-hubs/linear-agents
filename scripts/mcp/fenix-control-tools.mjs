// scripts/mcp/fenix-control-tools.mjs — the fenix-control MCP tool table
// (FOC-958 phase B, PRD fenix-remote-control-mcp §6/§8-B).
//
// Ten thin tools over the EXISTING Cockpit/Work API routes — the same routes
// the dashboard polls — so the loopback guards, the session-selection 409, the
// gate ownership check and the audit rows behave exactly as for a dashboard
// call. No business logic lives here: each tool is one HTTP call plus a
// typed-envelope mapping; the route layer stays the single owner of behaviour.
//
// Two redaction layers, on purpose:
//   · READ results are masked per string field with the routes' own redaction
//     (supervisor-lib redactDeep — the same denylist the dashboard shows),
//     WITHOUT any truncation: a read payload that lost its run ids to a
//     length cap could not be answered, and scrubMask's 32+-char opaque-run
//     rule would mask exactly those ids (runId, toolUseId) the answer tools
//     need back. Error TEXT uses scrub.mjs's scrub() (mask + cap) — an error
//     path is a bounded message, not a payload.
//   · WRITE inputs (message text, answer texts, notes) pass the FOC-450
//     egress screen before they are sent: injecting secret-shaped material
//     into the Supervisor's transcript would launder it toward every later
//     Linear/GitHub write the Supervisor makes.
//
// The routes do not run the egress screen on their RESPONSES (it is wired at
// the Linear/GitHub chokepoints only) — the masking above is the tool layer's
// own, and the residual families the denylist does not name (JWT, PEM,
// raw high-entropy runs) stay a phase-C item (PRD §8-C2 output redaction).
//
// The handler is exported programmatically on purpose: tests exercise the real
// message path against a spawned telemetry server, never spawning stdio. Only
// the stdio entry (server-fenix-control.mjs) touches process streams, and
// everything it logs goes to stderr — stdout is protocol, never log.

import { createMcpHandler } from "./jsonrpc.mjs";
import { scrub } from "./scrub.mjs";
import { assertEgressClean, EGRESS_BLOCKED } from "../egress-screen.mjs";
import { redactDeep } from "../supervisor-lib.mjs";

export const SERVER_INFO = { name: "fenix-control", version: "0.1.0" };

// The actor header the tool layer sends on every call (FOC-958 B2): the route
// threads it into gate/hold/ask audit records so a remote answer is never
// recorded as "dashboard". See cockpit-routes.mjs actorOf — only values
// matching the remote: shape are honoured, so a spoofed header falls back to
// the dashboard default.
export const ACTOR_HEADER = "x-fenix-actor";

const TEXT_SCHEMA = (what, max) => ({
  type: "string",
  description: what,
  minLength: 1,
  maxLength: max,
});

export const TOOLS = [
  {
    name: "fenix_status",
    description:
      "What is Fenix doing right now: the Supervisor's state (idle/busy/needs-input), the focus task, live children and the counts strip. A sleeping Fenix is a normal state, not an error.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "fenix_inbox",
    description:
      "What waits for the human: pending gates, Supervisor questions (asks), permission dialogs, holds and problem items, with the counts. Answer a gate with fenix_gate_answer, an ask with fenix_ask_answer, a dialog with fenix_dialog_answer.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "fenix_sessions",
    description:
      "List the Supervisor's task-scoped sessions (managed task workspaces) with their status. Empty means the legacy single-session mode is running.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "fenix_conversation",
    description:
      "Read the Supervisor chat transcript, newest tail first, redacted. Use limit for a short tail; use after (a previous offset) to read only what is new.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        after: { type: "integer", description: "Byte offset from a previous read; only newer entries are returned.", minimum: 0 },
        limit: { type: "integer", description: "How many entries to return (default 20, max 500).", minimum: 1, maximum: 500 },
      },
    },
  },
  {
    name: "fenix_queue",
    description:
      "The work board: tickets with their stage, verdicts, cost and the Ready column from the queue. Use it to pick what Fenix should work on next.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "fenix_costs",
    description:
      "Cost snapshot summary: total spend in the period, today's spend and the five most expensive tickets. Period is 7d (default), 30d or all.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        period: { type: "string", description: 'Snapshot window: "7d" (default), "30d" or "all".', enum: ["7d", "30d", "all"] },
      },
    },
  },
  {
    name: "fenix_message",
    description:
      "Send a chat message to the Supervisor (same refusals as the dashboard chat: needs-input, slash commands, over-long text). Example: 'take FOC-920 next'.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["text"],
      properties: {
        text: TEXT_SCHEMA("The message to send to the Supervisor. Screened for secrets.", 16000),
      },
    },
  },
  {
    name: "fenix_ask_answer",
    description:
      "Answer the Supervisor's pending AskUserQuestion: one answer object per question, in order — choices carries the chosen option indexes, text carries free text. A stale toolUseId is refused (ask-changed).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["toolUseId", "answers"],
      properties: {
        toolUseId: TEXT_SCHEMA("The pending ask's toolUseId, from fenix_inbox.", 256),
        answers: {
          type: "array",
          description: "One entry per question, in order: { choices: [optionIndex...], text?: \"free text\" }.",
          items: { type: "object" },
        },
      },
    },
  },
  {
    name: "fenix_dialog_answer",
    description:
      "Answer a permission or select dialog the Supervisor pane is showing: the dialog id from fenix_inbox and the choice (e.g. allow-once, deny), with an optional note.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id", "choice"],
      properties: {
        id: TEXT_SCHEMA("The dialog id, from fenix_inbox.", 256),
        choice: TEXT_SCHEMA("The choice key the dialog offers (e.g. allow-once, allow-always, deny).", 256),
        note: { type: "string", description: "Optional note sent with the answer. Screened for secrets.", maxLength: 4000 },
      },
    },
  },
  {
    name: "fenix_gate_answer",
    description:
      "Answer a pending gate (a child asking a question, e.g. plan.gate1): the runId and gateId from fenix_inbox, the answer text, an optional note and an optional task-scoped sessionId. The answer is recorded once; answering again is refused (already-answered).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["runId", "gateId", "text"],
      properties: {
        runId: TEXT_SCHEMA("The run the gate belongs to, from fenix_inbox.", 256),
        gateId: TEXT_SCHEMA("The gate id, from fenix_inbox.", 256),
        text: TEXT_SCHEMA("The answer. Screened for secrets.", 16000),
        note: { type: "string", description: "Optional note recorded with the answer. Screened for secrets.", maxLength: 4000 },
        sessionId: { type: "string", description: "Optional task-scoped session id (sup-…); the gate's run must be that session's own current run." },
      },
    },
  },
];

const PERIODS = ["7d", "30d", "all"];

/** Hand-rolled validation (the schema is documentation; the gate is here). Returns null or a reason. */
export function validateArgs(name, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "arguments must be an object";
  const spec = {
    fenix_status: [],
    fenix_inbox: [],
    fenix_sessions: [],
    fenix_conversation: ["after", "limit"],
    fenix_queue: [],
    fenix_costs: ["period"],
    fenix_message: ["text"],
    fenix_ask_answer: ["toolUseId", "answers"],
    fenix_dialog_answer: ["id", "choice", "note"],
    fenix_gate_answer: ["runId", "gateId", "text", "note", "sessionId"],
  }[name];
  if (spec === undefined) return `unknown tool: ${name}`;
  for (const key of Object.keys(args)) {
    if (!spec.includes(key)) return `unknown property: ${key}`;
  }
  for (const key of ["text", "toolUseId", "id", "choice", "runId", "gateId"]) {
    if (args[key] !== undefined && (typeof args[key] !== "string" || args[key].length === 0)) {
      return `${key} must be a non-empty string`;
    }
  }
  if (name === "fenix_message" && (typeof args.text !== "string" || args.text.length > 16000)) {
    return "text is required (1..16000 characters)";
  }
  if (name === "fenix_gate_answer") {
    for (const key of ["runId", "gateId", "text"]) {
      if (typeof args[key] !== "string" || args[key].length === 0) return `${key} is required`;
    }
    if (args.text.length > 16000) return "text must be at most 16000 characters";
    if (args.note !== undefined && (typeof args.note !== "string" || args.note.length > 4000)) return "note must be a string of at most 4000 characters";
    if (args.sessionId !== undefined && (typeof args.sessionId !== "string" || args.sessionId.length === 0)) return "sessionId must be a non-empty string";
  }
  if (name === "fenix_dialog_answer") {
    for (const key of ["id", "choice"]) {
      if (typeof args[key] !== "string" || args[key].length === 0) return `${key} is required`;
    }
    if (args.note !== undefined && (typeof args.note !== "string" || args.note.length > 4000)) return "note must be a string of at most 4000 characters";
  }
  if (name === "fenix_ask_answer") {
    if (typeof args.toolUseId !== "string" || args.toolUseId.length === 0) return "toolUseId is required";
    if (!Array.isArray(args.answers)) return "answers must be an array";
    for (const a of args.answers) {
      if (!a || typeof a !== "object" || Array.isArray(a)) return "each answer must be an object";
      if (a.choices !== undefined) {
        if (!Array.isArray(a.choices)) return "answer.choices must be an array of option indexes";
        for (const c of a.choices) {
          if (!Number.isInteger(c) || c < 0) return "answer.choices must be non-negative integers";
        }
      }
      if (a.text !== undefined && (typeof a.text !== "string" || a.text.length > 2000)) {
        return "answer.text must be a string of at most 2000 characters";
      }
    }
  }
  if (name === "fenix_conversation") {
    if (args.after !== undefined && (!Number.isInteger(args.after) || args.after < 0)) return "after must be an integer >= 0";
    if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 500)) return "limit must be an integer in 1..500";
  }
  if (name === "fenix_costs" && args.period !== undefined && !PERIODS.includes(args.period)) {
    return 'period must be "7d", "30d" or "all"';
  }
  return null;
}

/**
 * Read-side scrub: the routes' own redaction vocabulary, applied per string
 * field, mask only — see the header comment for why NOT scrubMask's opaque-run
 * rule here.
 */
function scrubRead(value) {
  return redactDeep(value);
}

// A route error label is a typed code when it is the route's kebab shape
// ("selection-required", "docker-only", …); prose ("text (string) is
// required", "unknown ticket: X") falls through to the status mapping.
const CODE_RE = /^[a-z][a-z0-9-]*$/;

/**
 * Map one route response onto the tool envelope. 2xx keeps the (trimmed,
 * masked) payload; every other status becomes a typed error that names the
 * route's own code when it has one — never a raw crash, never a swallow.
 */
function mapResult(tool, status, body, pick = (b) => b) {
  if (status >= 200 && status < 300) {
    return { ok: true, tool, status, data: scrubRead(pick(body)) };
  }
  const err = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const label = typeof err.error === "string" ? err.error : "";
  const detail = typeof err.reason === "string" && err.reason ? err.reason : label;
  const code = CODE_RE.test(label)
    ? label
    : status === 400 ? "invalid_input"
      : status === 403 ? "forbidden"
        : status === 404 ? "not_found"
          : status === 409 ? "conflict"
            : status === 502 || status === 503 ? "upstream_unavailable"
              : "route_failed";
  return {
    ok: false,
    tool,
    error: { code, message: scrub(detail || `route answered ${status}`), status },
  };
}

/** The connection-level failure: the API server is not there (yet). */
function unreachable(tool, err) {
  return { ok: false, tool, error: { code: "api_unreachable", message: scrub(String(err?.message ?? err)) } };
}

/** One api() result → envelope: a transport failure (status 0) is typed
 * api_unreachable, anything else maps by status. */
function respond(tool, r, pick) {
  if (r.status === 0) return unreachable(tool, r.error);
  return mapResult(tool, r.status, r.body, pick);
}

/** Screen the write inputs before anything is sent (see the header comment). */
function screenOrBlock(tool, pairs) {
  try {
    for (const [label, text] of pairs) {
      if (typeof text === "string" && text.trim()) assertEgressClean(text, `fenix-control ${tool} ${label}`);
    }
    return null;
  } catch (err) {
    if (err && err.code === EGRESS_BLOCKED) {
      return { ok: false, tool, error: { code: "egress_blocked", message: err.message } };
    }
    throw err;
  }
}

/** Today's spend from the costs payload's byDay rows (a day with no rows is genuinely $0, not unknown). */
function costsSummary(body) {
  const ok = body?.state === "ok";
  const day = new Date().toISOString().slice(0, 10);
  const todayRow = ok ? (Array.isArray(body.byDay) ? body.byDay : []).find((b) => b?.day === day) : null;
  const totalOf = (row) =>
    (row.childrenUsd ?? 0) + (row.supervisorUsd ?? 0) + (row.overheadUsd ?? 0) + (row.unattributedUsd ?? 0);
  return {
    period: body?.period ?? null,
    state: body?.state ?? null,
    computedAt: body?.computedAt ?? null,
    stale: body?.stale ?? null,
    totals: ok ? {
      childrenUsd: body.kpis?.childrenUsd ?? null,
      supervisorUsd: body.kpis?.supervisorUsd ?? null,
      totalUsd: body.kpis?.totalUsd ?? null,
    } : null,
    today: ok ? (todayRow ? { day, totalUsd: totalOf(todayRow) } : { day, totalUsd: 0 }) : null,
    topTickets: ok ? (Array.isArray(body.mostExpensive) ? body.mostExpensive : []).slice(0, 5) : [],
  };
}

// The read tools' routes — each tool owns exactly one endpoint, so the table
// (not a branch) decides where a read goes.
const READ_PATHS = {
  fenix_status: "/api/cockpit",
  fenix_inbox: "/api/cockpit",
  fenix_sessions: "/api/supervisor/sessions",
  fenix_queue: "/api/work/tickets",
};

// The read tools' payload trims: the remote caller needs the decision-ready
// slice, not the whole snapshot — the derivation stays in the route, this is
// presentation shaping only.
const READ_SHAPES = {
  fenix_status: (b) => ({ supervisor: b?.supervisor ?? null, counts: b?.counts ?? null, checkedAt: b?.checkedAt ?? null }),
  fenix_inbox: (b) => ({ needsYou: b?.needsYou ?? [], counts: b?.counts ?? null }),
  fenix_sessions: (b) => b,
  fenix_queue: (b) => b,
};

/**
 * Build the API caller. Every call carries the actor header; the body is
 * JSON when present. A transport failure is a status-0 result, never a throw.
 */
function makeApi({ fetchImpl, baseUrl, actor }) {
  return async function api(method, path, body) {
    let res;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          [ACTOR_HEADER]: actor(),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      return { status: 0, body: null, error: String(err?.message ?? err) };
    }
    let parsed = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null; // a non-JSON body maps through mapResult by status alone
    }
    return { status: res.status, body: parsed };
  };
}

async function dispatch(api, name, args) {
  if (name === "fenix_costs") {
    const period = args.period ?? "7d";
    const r = await api("GET", `/api/costs?period=${encodeURIComponent(period)}`);
    return respond(name, r, costsSummary);
  }
  if (name === "fenix_conversation") {
    const params = new URLSearchParams();
    if (args.after !== undefined) params.set("after", String(args.after));
    params.set("limit", String(args.limit ?? 20)); // the tool's own default tail — the route's default is the dashboard's
    const q = params.toString();
    const r = await api("GET", `/api/supervisor/conversation${q ? `?${q}` : ""}`);
    return respond(name, r);
  }
  if (READ_PATHS[name]) {
    const r = await api("GET", READ_PATHS[name]);
    return respond(name, r, READ_SHAPES[name]);
  }
  // The four write/answer tools — each screened, then one POST.
  if (name === "fenix_message") {
    const blocked = screenOrBlock(name, [["text", args.text]]);
    if (blocked) return blocked;
    const r = await api("POST", "/api/supervisor/message", { text: args.text });
    return respond(name, r);
  }
  if (name === "fenix_ask_answer") {
    const blocked = screenOrBlock(name, args.answers.map((a, i) => [`answers[${i}].text`, a.text]));
    if (blocked) return blocked;
    const r = await api("POST", "/api/supervisor/ask", { toolUseId: args.toolUseId, answers: args.answers });
    return respond(name, r);
  }
  if (name === "fenix_dialog_answer") {
    const blocked = screenOrBlock(name, [["note", args.note]]);
    if (blocked) return blocked;
    const body = { id: args.id, choice: args.choice };
    if (args.note !== undefined) body.note = args.note;
    const r = await api("POST", "/api/supervisor/dialog", body);
    return respond(name, r);
  }
  if (name === "fenix_gate_answer") {
    const blocked = screenOrBlock(name, [["text", args.text], ["note", args.note]]);
    if (blocked) return blocked;
    const body = { runId: args.runId, gateId: args.gateId, text: args.text };
    if (args.note !== undefined) body.note = args.note;
    if (args.sessionId !== undefined) body.sessionId = args.sessionId;
    const r = await api("POST", "/api/gates/answer", body);
    return respond(name, r);
  }
  return { ok: false, tool: name, error: { code: "unknown_tool", message: `unknown tool: ${name}` } };
}

// The actor's client part: explicit option > the MCP client's initialize
// clientInfo > FENIX_CONTROL_CLIENT env > "mcp". Sanitized to the same shape
// the route's actorOf accepts, so a hostile clientInfo can neither forge
// another actor kind nor smuggle characters outside the remote: shape.
const CLIENT_RE = /^[A-Za-z0-9._-]{1,64}$/;

function sanitizeClient(name) {
  if (typeof name !== "string") return null;
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64);
  return CLIENT_RE.test(cleaned) ? cleaned : null;
}

/**
 * Programmatic factory — tests inject fetchImpl (and pin the client); the
 * stdio entry uses global fetch and the env/default client. callTool never
 * throws: every failure crosses the protocol boundary as a typed envelope.
 */
export function createFenixControlServer({ baseUrl, fetchImpl, client } = {}) {
  const url = baseUrl
    ?? process.env.FENIX_CONTROL_API_URL
    ?? `http://127.0.0.1:${parseInt(process.env.TELEMETRY_PORT, 10) || 7331}`;
  const fetchFn = fetchImpl ?? globalThis.fetch;
  let clientName = (typeof client === "string" && CLIENT_RE.test(client) && client)
    || sanitizeClient(process.env.FENIX_CONTROL_CLIENT)
    || "mcp";
  const actor = () => `remote:${clientName}`;
  const api = makeApi({ fetchImpl: fetchFn, baseUrl: url, actor });

  async function callTool(name, args) {
    try {
      const invalid = validateArgs(name, args);
      if (invalid) return { ok: false, tool: name, error: { code: "invalid_input", message: invalid } };
      return await dispatch(api, name, args);
    } catch (err) {
      return { ok: false, tool: name, error: { code: "fenix_control_failed", message: scrub(String(err?.message ?? err)) } };
    }
  }

  const handler = createMcpHandler({ serverInfo: SERVER_INFO, tools: TOOLS, callTool });

  // Peek at initialize (never throws, never blocks the protocol) to learn the
  // MCP client's own name — the audit actor becomes remote:<that name>.
  async function handleLine(line) {
    try {
      const request = JSON.parse(line);
      if (request?.method === "initialize") {
        const fromClient = sanitizeClient(request.params?.clientInfo?.name);
        if (fromClient && typeof client !== "string") clientName = fromClient;
      }
    } catch {
      /* not JSON — handleLine's own parse error path answers it */
    }
    return handler.handleLine(line);
  }

  return { ...handler, handleLine, serverInfo: SERVER_INFO, tools: TOOLS, actor };
}
