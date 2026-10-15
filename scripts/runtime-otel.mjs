#!/usr/bin/env node
// scripts/runtime-otel.mjs — APPROVED P1/P3 OTLP traces normalizer + collector.
//
// Accepts Claude Code's native OTLP http/json trace export (see docs/OTEL
// integration guide: CLAUDE_CODE_ENABLE_TELEMETRY=1,
// CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1, OTEL_TRACES_EXPORTER=otlp,
// OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/json), allowlists it down to runtime
// metadata, and stores normalized spans via runtime-events.mjs.
//
// Security / data minimization (hard requirements):
//   - Only known claude_code span names are accepted (interaction, llm_request,
//     tool, tool.execution, tool.blocked_on_user) — unknown names are skipped.
//   - ONLY the allowlisted attributes are retained (agent_id, parent_agent_id,
//     tool_name, tool_use_id, model, query_source_safe, session.id). Raw prompts,
//     tool inputs/outputs, authorization headers, API bodies are NEVER stored.
//   - The collector is loopback-only: it refuses to bind a non-loopback host and
//     rejects non-loopback remote sources. No Docker port mapping, no auth —
//     the loopback bind IS the security boundary (matches the existing runtime
//     profile pattern).
//   - Error responses are server-chosen sanitized tokens; request bodies are
//     never echoed or logged.
//   - Caps: max body bytes (2 MiB default) and max spans per request (5000).
//
// Exports:
//   - normalizeOtlpTraces(payload)  -> allowlisted normalized span records
//     (same shape runtime-events.recordRuntimeSpans stores). Structurally
//     invalid payloads throw TypeError; malformed SPANS are skipped (counted as
//     rejected by the collector), never fabricated.
//   - countOtlpSpans(payload)       -> number of spans in a parsed OTLP payload
//   - createRuntimeCollector(opts)  -> { server, close, stats } HTTP server
//     (loopback only; the caller calls server.listen; CLI: `serve`)
//   - runtimeTelemetryEnv(context)  -> exact env object for Claude Code child
//     processes; never mutates process.env.
//   - CLI: `node scripts/runtime-otel.mjs serve [--port N] [--host H] [--db PATH]`
//          `node scripts/runtime-otel.mjs env --task-key ... --supervisor-session ...`

import { createServer } from "node:http";
import { recordRuntimeSpans as defaultRecordRuntimeSpans, isRuntimeToken } from "./runtime-events.mjs";

/** OTLP http/json endpoint path (Collector-standard). */
export const OTLP_TRACES_PATH = "/v1/traces";

/** Only these native claude_code span names are accepted. */
export const KNOWN_SPAN_NAMES = Object.freeze([
  "claude_code.interaction",
  "claude_code.llm_request",
  "claude_code.tool",
  "claude_code.tool.execution",
  "claude_code.tool.blocked_on_user",
]);

/** Span attribute allowlist — everything else is dropped before storage. */
const SPAN_ATTR_ALLOWLIST = Object.freeze([
  "agent_id",
  "parent_agent_id",
  "tool_name",
  "tool_use_id",
  "model",
  "query_source_safe",
  "session.id",
]);

/** OTLP status code -> our storage enum. */
const OTLP_STATUS = Object.freeze({ 0: "unset", 1: "ok", 2: "error" });

const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const SPAN_ID_RE = /^[0-9a-f]{16}$/;

/** OTLP intValue is int64 — JSON encodes it as a string; accept both. */
function attrScalar(value) {
  if (!value || typeof value !== "object") return undefined;
  if (typeof value.stringValue === "string") return value.stringValue;
  if (value.intValue !== undefined) {
    const n = typeof value.intValue === "string" ? Number(value.intValue) : Number(value.intValue);
    return Number.isFinite(n) ? String(n) : undefined;
  }
  if (typeof value.boolValue === "boolean") return String(value.boolValue);
  if (typeof value.doubleValue === "number" && Number.isFinite(value.doubleValue)) {
    return String(value.doubleValue);
  }
  return undefined;
}

function attrsToMap(attributes) {
  const map = new Map();
  if (!Array.isArray(attributes)) return map;
  for (const attr of attributes) {
    if (!attr || typeof attr.key !== "string") continue;
    const value = attrScalar(attr.value);
    if (typeof value === "string") map.set(attr.key, value);
  }
  return map;
}

/**
 * BigInt nanoseconds (OTLP JSON encodes int64 as string; accept numbers too)
 * -> canonical millisecond ISO string. Returns null for absent/zero/unparseable
 * values — never fabricates a timestamp.
 */
export function nanosToIso(value) {
  if (value === undefined || value === null || value === "") return null;
  try {
    const n = typeof value === "bigint" ? value : BigInt(String(value));
    if (n <= 0n) return null;
    return new Date(Number(n / 1000000n)).toISOString();
  } catch {
    return null;
  }
}

/**
 * Extract the fenix runtime context from OTLP resource attributes.
 * Required identity: fenix.task_key, fenix.supervisor_session_id,
 * fenix.workflow_run_id, fenix.actor_id, fenix.role. fenix.attempt_id is
 * optional. Returns null when required identity is missing/invalid —
 * the span batch is skipped and counted as rejected, never fabricated.
 */
export function resourceContext(resource) {
  const attrs = attrsToMap(resource?.attributes);
  const taskKey = attrs.get("fenix.task_key");
  const supervisorSessionId = attrs.get("fenix.supervisor_session_id");
  const workflowRunId = attrs.get("fenix.workflow_run_id");
  const actorId = attrs.get("fenix.actor_id");
  const role = attrs.get("fenix.role");
  const attemptId = attrs.get("fenix.attempt_id") ?? null;
  if (
    !isRuntimeToken(taskKey) ||
    !isRuntimeToken(supervisorSessionId) ||
    !isRuntimeToken(workflowRunId) ||
    !isRuntimeToken(actorId) ||
    !isRuntimeToken(role) ||
    (attemptId !== null && !isRuntimeToken(attemptId))
  ) {
    return null;
  }
  return { taskKey, supervisorSessionId, workflowRunId, attemptId, actorId, role };
}

/**
 * Normalize one OTLP span against a resource context. Returns a normalized
 * span record, or null when the span must be skipped (unknown span name, bad
 * trace/span ids, missing/unparseable start time, end before start).
 * Parent linkage: preserved verbatim via parentSpanId. parent_agent_id maps to
 * a composite parentActorId (fenix.actor_id:parent_agent_id); we never guess
 * or invent parent relationships beyond native attributes.
 */
export function normalizeOtlpSpan(span, context) {
  if (!span || typeof span !== "object" || Array.isArray(span)) return null;
  const name = typeof span.name === "string" ? span.name : "";
  if (!KNOWN_SPAN_NAMES.includes(name)) return null;

  const traceId = typeof span.traceId === "string" ? span.traceId.toLowerCase() : "";
  if (!TRACE_ID_RE.test(traceId)) return null;
  const spanId = typeof span.spanId === "string" ? span.spanId.toLowerCase() : "";
  if (!SPAN_ID_RE.test(spanId)) return null;

  // Preserve native child->parent linkage; a malformed parent id is dropped
  // (never guessed), the span itself stays.
  const rawParent = typeof span.parentSpanId === "string" ? span.parentSpanId.toLowerCase() : "";
  const parentSpanId = SPAN_ID_RE.test(rawParent) ? rawParent : null;

  const startAt = nanosToIso(span.startTimeUnixNano);
  if (startAt == null) return null;
  const endAt = nanosToIso(span.endTimeUnixNano);
  if (endAt != null && endAt < startAt) return null;

  let status = "unset";
  const code = span.status?.code;
  if (typeof code === "number" && code in OTLP_STATUS) status = OTLP_STATUS[code];
  else if (typeof code === "string" && /unset|ok|error/i.test(code)) status = code.toLowerCase();

  // Attribute allowlist: unknown attributes (prompt, tool_input, output,
  // authorization, API bodies, ...) are dropped here, before any storage.
  const attrs = attrsToMap(span.attributes);
  const agentId = attrs.get("agent_id") ?? null;
  const parentAgentId = attrs.get("parent_agent_id") ?? null;
  const baseActorId = context.actorId;
  const actorId = agentId !== null && isRuntimeToken(agentId) ? `${baseActorId}:${agentId}` : baseActorId;
  const parentActorId =
    parentAgentId !== null && isRuntimeToken(parentAgentId) ? `${baseActorId}:${parentAgentId}` : null;

  // Optional allowlisted attributes that fail the identifier check are dropped
  // (set to null) rather than stored raw — unrepresentable values never land.
  const opt = (key) => {
    const value = attrs.get(key) ?? null;
    return value !== null && isRuntimeToken(value) ? value : null;
  };

  return {
    traceId,
    spanId,
    parentSpanId,
    taskKey: context.taskKey,
    supervisorSessionId: context.supervisorSessionId,
    workflowRunId: context.workflowRunId,
    attemptId: context.attemptId,
    actorId,
    role: context.role,
    parentActorId,
    baseActorId,
    name,
    startAt,
    endAt,
    model: opt("model"),
    toolName: opt("tool_name"),
    toolUseId: opt("tool_use_id"),
    agentId: agentId !== null && isRuntimeToken(agentId) ? agentId : null,
    querySource: opt("query_source_safe"),
    sessionId: opt("session.id"),
    status,
  };
}

/** Parse + allowlist an OTLP http/json ExportTraceServiceRequest. */
export function normalizeOtlpTraces(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("runtime-otel: payload must be an OTLP ExportTraceServiceRequest object");
  }
  const resourceSpans = payload.resourceSpans;
  if (resourceSpans !== undefined && resourceSpans !== null && !Array.isArray(resourceSpans)) {
    throw new TypeError("runtime-otel: resourceSpans must be an array");
  }
  const out = [];
  const seen = new Set(); // dedupe stable traceId+spanId within one batch
  for (const rs of resourceSpans ?? []) {
    const context = resourceContext(rs?.resource);
    if (context == null) continue; // rejected: missing required identity
    for (const scopeSpans of rs?.scopeSpans ?? []) {
      for (const span of scopeSpans?.spans ?? []) {
        const record = normalizeOtlpSpan(span, context);
        if (record == null) continue; // rejected: unknown name / bad ids / bad time
        const key = `${record.traceId}:${record.spanId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(record);
      }
    }
  }
  return out;
}

/** Count every span entry in a parsed OTLP payload (for caps + rejection math). */
export function countOtlpSpans(payload) {
  let count = 0;
  for (const rs of payload?.resourceSpans ?? []) {
    for (const scopeSpans of rs?.scopeSpans ?? []) count += Array.isArray(scopeSpans?.spans) ? scopeSpans.spans.length : 0;
  }
  return count;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const LOOPBACK_REMOTES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1"]);

export function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(host);
}

export function defaultIsRemoteAllowed(remoteAddress) {
  return LOOPBACK_REMOTES.has(remoteAddress);
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", connection: "close" });
  res.end(body);
}

/**
 * Create the loopback OTLP trace collector. Not listening until the caller
 * calls server.listen(port, host). Returns { server, close, stats } where
 * stats() -> { requests, accepted, rejected, errors }:
 *   accepted = spans newly inserted; rejected = spans in payloads that were
 *   not stored (missing identity, unknown name, bad ids/time, duplicates);
 *   errors = request-handler failures. Bodies are never echoed or logged.
 */
export function createRuntimeCollector({
  dbPath,
  host = "127.0.0.1",
  port = 4318,
  recordRuntimeSpans = defaultRecordRuntimeSpans,
  maxBodyBytes = 2 * 1024 * 1024,
  maxSpansPerRequest = 5000,
  isRemoteAllowed = defaultIsRemoteAllowed,
} = {}) {
  if (!isLoopbackHost(host)) {
    throw new Error(`runtime-otel: refusing to bind non-loopback host "${host}"`);
  }
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new Error("runtime-otel: maxBodyBytes must be a positive integer");
  }
  if (!Number.isInteger(maxSpansPerRequest) || maxSpansPerRequest <= 0) {
    throw new Error("runtime-otel: maxSpansPerRequest must be a positive integer");
  }
  const counters = { requests: 0, accepted: 0, rejected: 0, errors: 0 };

  const server = createServer((req, res) => {
    counters.requests += 1;
    try {
      // Foreign source rejection: loopback only.
      if (!isRemoteAllowed(req.socket?.remoteAddress ?? "")) {
        sendJson(res, 403, JSON.stringify({ error: "rejected" }));
        req.socket.destroy();
        return;
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== OTLP_TRACES_PATH) {
        sendJson(res, 404, JSON.stringify({ error: "not-found" }));
        return;
      }
      if (req.method !== "POST") {
        sendJson(res, 405, JSON.stringify({ error: "unsupported-method" }));
        return;
      }
      const contentType = String(req.headers["content-type"] ?? "");
      if (!contentType.startsWith("application/json")) {
        sendJson(res, 415, JSON.stringify({ error: "unsupported-content-type" }));
        return;
      }
      const contentLength = Number(req.headers["content-length"]);
      if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
        sendJson(res, 413, JSON.stringify({ error: "payload-too-large" }));
        return;
      }

      let size = 0;
      let aborted = false;
      const chunks = [];
      req.on("data", (chunk) => {
        if (aborted) return;
        size += chunk.length;
        if (size > maxBodyBytes) {
          aborted = true;
          sendJson(res, 413, JSON.stringify({ error: "payload-too-large" }));
          req.socket.destroy(); // unbounded uploads are cut immediately
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (aborted) return;
        let payload;
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          sendJson(res, 400, JSON.stringify({ error: "invalid-json" }));
          return;
        }
        let spanCount;
        try {
          spanCount = countOtlpSpans(payload);
        } catch {
          sendJson(res, 400, JSON.stringify({ error: "invalid-payload" }));
          return;
        }
        if (spanCount > maxSpansPerRequest) {
          sendJson(res, 400, JSON.stringify({ error: "too-many-spans" }));
          return;
        }
        let spans;
        try {
          spans = normalizeOtlpTraces(payload);
        } catch {
          sendJson(res, 400, JSON.stringify({ error: "invalid-payload" }));
          return;
        }
        counters.rejected += Math.max(0, spanCount - spans.length);
        try {
          const { inserted } = recordRuntimeSpans(spans, { dbPath });
          counters.accepted += inserted;
          // OTLP http/json success response: empty ExportTraceServiceResponse.
          sendJson(res, 200, "{}");
        } catch {
          counters.errors += 1;
          sendJson(res, 500, JSON.stringify({ error: "storage-error" }));
        }
      });
      req.on("error", () => {
        counters.errors += 1;
      });
    } catch {
      counters.errors += 1;
      try {
        sendJson(res, 500, JSON.stringify({ error: "rejected" }));
      } catch {
        /* socket already gone */
      }
    }
  });

  function close() {
    return new Promise((resolve) => server.close(() => resolve()));
  }

  return {
    server,
    close,
    port,
    host,
    stats: () => ({ ...counters }),
  };
}

/**
 * Exact env object for Claude Code child processes (the Supervisor container
 * spawns with these; the collector URL points at our own loopback process).
 * Never mutates process.env — the caller spreads the returned object.
 * Rejects non-loopback collector URLs unless explicit trustedContainerHost.
 */
export function runtimeTelemetryEnv(context, { collectorUrl = "http://127.0.0.1:4318/v1/traces", trustedContainerHost = false } = {}) {
  const taskKey = context?.taskKey;
  const supervisorSessionId = context?.supervisorSessionId;
  const workflowRunId = context?.workflowRunId;
  const actorId = context?.actorId;
  const role = context?.role;
  const attemptId = context?.attemptId ?? null;
  if (!isRuntimeToken(taskKey)) throw new TypeError("runtime-otel: taskKey must be a short safe identifier");
  if (!isRuntimeToken(supervisorSessionId)) throw new TypeError("runtime-otel: supervisorSessionId must be a short safe identifier");
  if (!isRuntimeToken(workflowRunId)) throw new TypeError("runtime-otel: workflowRunId must be a short safe identifier");
  if (!isRuntimeToken(actorId)) throw new TypeError("runtime-otel: actorId must be a short safe identifier");
  if (!isRuntimeToken(role)) throw new TypeError("runtime-otel: role must be a short safe identifier");
  if (attemptId !== null && !isRuntimeToken(attemptId)) throw new TypeError("runtime-otel: attemptId must be null or a short safe identifier");

  let url;
  try {
    url = new URL(collectorUrl);
  } catch {
    throw new TypeError("runtime-otel: collectorUrl must be an absolute URL");
  }
  const isLoopback = LOOPBACK_HOSTS.has(url.hostname);
  if (!isLoopback && !trustedContainerHost) {
    throw new Error(
      `runtime-otel: refusing non-loopback collector URL "${url.hostname}" — pass trustedContainerHost explicitly if this is an explicit trusted container host`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("runtime-otel: collectorUrl must use http or https");
  }
  if (!url.pathname.startsWith("/")) throw new TypeError("runtime-otel: collectorUrl must include a path");

  const resourcePairs = [
    ["fenix.task_key", taskKey],
    ["fenix.supervisor_session_id", supervisorSessionId],
    ["fenix.workflow_run_id", workflowRunId],
    ["fenix.actor_id", actorId],
    ["fenix.role", role],
  ];
  if (attemptId !== null) resourcePairs.push(["fenix.attempt_id", attemptId]);
  const resourceAttributes = resourcePairs.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join(",");

  return Object.freeze({
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
    OTEL_TRACES_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: collectorUrl,
    OTEL_LOGS_EXPORTER: "none",
    OTEL_METRICS_EXPORTER: "none",
    OTEL_LOG_USER_PROMPTS: "0",
    OTEL_LOG_ASSISTANT_RESPONSES: "0",
    OTEL_LOG_TOOL_DETAILS: "0",
    OTEL_LOG_TOOL_CONTENT: "0",
    OTEL_LOG_RAW_API_BODIES: "0",
    ENABLE_BETA_TRACING_DETAILED: "0",
    OTEL_TRACES_EXPORT_INTERVAL: "1000",
    OTEL_RESOURCE_ATTRIBUTES: resourceAttributes,
  });
}

// ---------------------------------------------------------------------------
// CLI: serve (run the collector) / env (print the env object as JSON).
// ---------------------------------------------------------------------------
function parseCliArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

async function main() {
  const { pathToFileURL } = await import("node:url");
  if (!process.argv[1] || pathToFileURL(process.argv[1]).href !== import.meta.url) return;
  const command = process.argv[2];
  const flags = parseCliArgs(process.argv.slice(3));

  if (command === "env") {
    const env = runtimeTelemetryEnv(
      {
        taskKey: flags["task-key"],
        supervisorSessionId: flags["supervisor-session"],
        workflowRunId: flags["workflow-run"],
        attemptId: flags["attempt-id"] ?? null,
        actorId: flags["actor-id"],
        role: flags.role,
      },
      { collectorUrl: flags["collector-url"] ?? undefined, trustedContainerHost: flags["trusted-container-host"] === true },
    );
    process.stdout.write(`${JSON.stringify(env, null, 2)}\n`);
    return;
  }

  if (command === "serve") {
    const collector = createRuntimeCollector({
      dbPath: flags.db ?? undefined,
      host: flags.host ?? "127.0.0.1",
      port: Number.parseInt(flags.port ?? "4318", 10),
    });
    const { server, close } = collector;
    server.listen(collector.port, collector.host, () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address !== null ? address.port : collector.port;
      // Sanitized startup line only — no request/body logging ever.
      process.stdout.write(`runtime-otel listening http://127.0.0.1:${actualPort}${OTLP_TRACES_PATH}\n`);
    });
    let closing = false;
    const shutdown = async () => {
      if (closing) return;
      closing = true;
      await close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return;
  }

  process.stderr.write('usage: runtime-otel.mjs serve [--port N] [--host H] [--db PATH]\n       runtime-otel.mjs env --task-key K --supervisor-session S --workflow-run W --actor-id A --role R [--attempt-id X] [--collector-url U]\n');
  process.exitCode = 1;
}

await main();
