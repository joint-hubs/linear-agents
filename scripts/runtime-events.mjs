#!/usr/bin/env node
// scripts/runtime-events.mjs — APPROVED P1/P3 runtime event + span foundation.
//
// Additive, module-owned side tables (`fenix_runtime_events`, `fenix_runtime_spans`)
// inside the SAME central telemetry DB that openTelemetryDb() manages. This module
// deliberately does NOT edit telemetry-store.mjs: it owns its CREATE TABLE IF NOT
// EXISTS schema (the same idempotent side-table pattern as the store's run_focus /
// codegraph_query_facts tables), so the store's own migrations (e.g. the v5
// tool_facts rebuild) can never drop or rewrite these rows.
//
// Why: wall-clock timestamps cannot measure active work. Events record Supervisor
// workflow milestones; spans record normalized Claude Code OTLP trace spans
// (see runtime-otel.mjs) with native start/end times.
//
// Return/error contract (explicit, by design):
//   - recordRuntimeEvent(): malformed input THROWS — never silently fabricated.
//     Insert is idempotent on eventId: re-recording an eventId returns the
//     already-stored normalized row (first write wins), so it never returns null.
//   - recordRuntimeSpans(): malformed span input THROWS; well-formed spans with
//     an existing (traceId, spanId) PK count as duplicates → {inserted, duplicates}.
//   - queryRuntimeEvents()/queryRuntimeSpans(): arrays of camelCase records,
//     [] when nothing matches. Span windows clip by INTERSECTION
//     (start <= to AND (end open OR end >= from)), never start-only.
//   - Hooks write best-effort: CALLERS wrap these in try/catch. Tests pass an
//     explicit {dbPath} to a temp DB; without dbPath the default store DB is used.
//   - Payloads are allowlisted structured data only — raw prompts, error strings
//     and credentials never reach these tables.

import { openTelemetryDb, telemetryDbPath } from "./telemetry-store.mjs";

/** Schema version of the runtime side tables (bumped only on breaking shape). */
export const RUNTIME_SCHEMA_VERSION = 1;

/** Supervisor event types this store accepts — anything else throws. */
export const RUNTIME_EVENT_TYPES = Object.freeze([
  "supervisor_started",
  "actor_started",
  "actor_stopped",
  "workflow_completed",
  "supervisor_stopped",
  "actor_state_changed",
  "workflow_selected",
  "workflow_revised",
  "stage_attempt_started",
  "stage_attempt_completed",
  "return_to_dev",
]);

/** Known workflow stage names for the payload `stages` allowlist. */
export const RUNTIME_STAGES = Object.freeze(["supervisor", "plan", "dev", "review", "test", "cadence", "human"]);

/** Who triggered a workflow revision / return-to-dev. */
export const RUNTIME_SOURCES = Object.freeze(["review", "test", "human", "other", "unknown", "infrastructure"]);

/** Closed enum for payload `reason` — callers map native causes onto these. */
export const RUNTIME_REASONS = Object.freeze([
  "approved",
  "rejected",
  "revised",
  "failed",
  "timeout",
  "handoff",
  "infrastructure_retry",
  "escalated",
  "completed",
  "other",
]);

const PAYLOAD_KEYS = Object.freeze([
  "state",
  "stages",
  "dependsOnAttemptIds",
  "fromAttemptId",
  "toAttemptId",
  "source",
  "reason",
  "evidenceRef",
  "status",
  "evidenceKind",
]);

// Identifiers only: first char alphanumeric, then alnum/._:-/ — no whitespace,
// no quotes, no newlines. This shape can never carry a prompt or credential.
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

export function isRuntimeToken(value) {
  return typeof value === "string" && TOKEN_RE.test(value) && !/sk-or-|sk-ant-|lin_api_|github_pat_/.test(value);
}

/** Validate an identifier; throws with a caller-visible field name. */
function requireToken(value, field) {
  if (!isRuntimeToken(value)) {
    throw new TypeError(`runtime-events: ${field} must be a short safe identifier (got ${typeof value})`);
  }
  return value;
}

function optionalToken(value, field) {
  if (value === undefined || value === null) return null;
  if (!isRuntimeToken(value)) {
    throw new TypeError(`runtime-events: ${field} must be null or a short safe identifier`);
  }
  return value;
}

function isIso(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) &&
    Number.isFinite(new Date(value).getTime())
  );
}

function requireIso(value, field) {
  if (!isIso(value)) {
    throw new TypeError(`runtime-events: ${field} must be an ISO-8601 timestamp`);
  }
  return new Date(value).toISOString();
}

function optionalIso(value, field) {
  if (value === undefined || value === null) return null;
  return requireIso(value, field);
}

/** Validate + canonicalize the allowlisted event payload. Throws on unknown keys. */
function normalizePayload(payload) {
  if (payload === undefined || payload === null) return {};
  if (typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("runtime-events: payload must be a plain object");
  }
  const out = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!PAYLOAD_KEYS.includes(key)) {
      throw new TypeError(`runtime-events: payload key "${key}" is not allowlisted`);
    }
    switch (key) {
      case "state":
      case "status": {
        if (typeof value !== "string" || !TOKEN_RE.test(value)) {
          throw new TypeError(`runtime-events: payload.${key} must be a short safe token`);
        }
        out[key] = value;
        break;
      }
      case "stages": {
        if (!Array.isArray(value) || value.length === 0) {
          throw new TypeError("runtime-events: payload.stages must be a non-empty array of known stage names");
        }
        for (const stage of value) {
          if (!RUNTIME_STAGES.includes(stage)) {
            throw new TypeError(`runtime-events: payload.stages entry ${JSON.stringify(stage)} is not a known stage`);
          }
        }
        out[key] = value.slice();
        break;
      }
      case "dependsOnAttemptIds": {
        if (!Array.isArray(value) || value.length > 100) throw new TypeError("runtime-events: invalid dependency list");
        out[key] = [...new Set(value.map(v => requireToken(v, "payload.dependsOnAttemptIds")))]; break;
      }
      case "fromAttemptId":
      case "toAttemptId": {
        out[key] = optionalToken(value, `payload.${key}`);
        break;
      }
      case "source": {
        if (!RUNTIME_SOURCES.includes(value)) {
          throw new TypeError(`runtime-events: payload.source must be one of ${RUNTIME_SOURCES.join("|")}`);
        }
        out[key] = value;
        break;
      }
      case "evidenceKind": {
        if (!["direct", "inferred", "unknown"].includes(value)) throw new TypeError("invalid evidence kind");
        out[key] = value; break;
      }
      case "reason": {
        if (!RUNTIME_REASONS.includes(value)) {
          throw new TypeError(`runtime-events: payload.reason must be one of ${RUNTIME_REASONS.join("|")}`);
        }
        out[key] = value;
        break;
      }
      case "evidenceRef": {
        if (!isRuntimeToken(value)) {
          throw new TypeError("runtime-events: payload.evidenceRef must be a short safe identifier/path");
        }
        out[key] = value;
        break;
      }
      default:
        throw new TypeError(`runtime-events: payload key "${key}" is not allowlisted`);
    }
  }
  // Deterministic key order so the stored JSON is comparable across processes.
  return Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]));
}

function ensureRuntimeSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fenix_runtime_events (
      event_id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      task_key TEXT NOT NULL,
      supervisor_session_id TEXT NOT NULL,
      workflow_run_id TEXT NOT NULL,
      attempt_id TEXT,
      actor_id TEXT NOT NULL,
      role TEXT NOT NULL,
      parent_actor_id TEXT,
      seq INTEGER NOT NULL,
      occurred_at TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS fenix_runtime_events_task
      ON fenix_runtime_events (task_key, occurred_at, seq);
    CREATE TABLE IF NOT EXISTS fenix_runtime_spans (
      trace_id TEXT NOT NULL,
      span_id TEXT NOT NULL,
      parent_span_id TEXT,
      task_key TEXT NOT NULL,
      supervisor_session_id TEXT NOT NULL,
      workflow_run_id TEXT NOT NULL,
      attempt_id TEXT,
      actor_id TEXT NOT NULL,
      role TEXT NOT NULL,
      parent_actor_id TEXT,
      base_actor_id TEXT,
      name TEXT NOT NULL,
      start_at TEXT NOT NULL,
      end_at TEXT,
      model TEXT,
      tool_name TEXT,
      tool_use_id TEXT,
      agent_id TEXT,
      query_source TEXT,
      session_id TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (trace_id, span_id)
    );
    CREATE INDEX IF NOT EXISTS fenix_runtime_spans_task
      ON fenix_runtime_spans (task_key, start_at);
  `);
}

function eventFromRow(row) {
  if (!row) return null;
  return {
    eventId: row.event_id,
    schemaVersion: row.schema_version,
    taskKey: row.task_key,
    supervisorSessionId: row.supervisor_session_id,
    workflowRunId: row.workflow_run_id,
    attemptId: row.attempt_id,
    actorId: row.actor_id,
    role: row.role,
    parentActorId: row.parent_actor_id,
    seq: row.seq,
    occurredAt: row.occurred_at,
    eventType: row.event_type,
    type: row.event_type,
    payload: JSON.parse(row.payload_json),
  };
}

function spanFromRow(row) {
  if (!row) return null;
  return {
    traceId: row.trace_id,
    spanId: row.span_id,
    parentSpanId: row.parent_span_id,
    taskKey: row.task_key,
    supervisorSessionId: row.supervisor_session_id,
    workflowRunId: row.workflow_run_id,
    attemptId: row.attempt_id,
    actorId: row.actor_id,
    role: row.role,
    parentActorId: row.parent_actor_id,
    baseActorId: row.base_actor_id,
    name: row.name,
    startAt: row.start_at,
    endAt: row.end_at,
    model: row.model,
    toolName: row.tool_name,
    toolUseId: row.tool_use_id,
    agentId: row.agent_id,
    querySource: row.query_source,
    sessionId: row.session_id,
    status: row.status,
  };
}

/**
 * Validate a caller-supplied normalized span record. Throws on malformed input;
 * the collector path (runtime-otel.mjs) produces exactly this shape.
 */
function validateSpanRecord(span) {
  if (!span || typeof span !== "object" || Array.isArray(span)) {
    throw new TypeError("runtime-events: span must be a plain object");
  }
  const traceId = typeof span.traceId === "string" ? span.traceId.toLowerCase() : "";
  if (!/^[0-9a-f]{32}$/.test(traceId)) {
    throw new TypeError("runtime-events: span.traceId must be 32 hex characters");
  }
  const spanId = typeof span.spanId === "string" ? span.spanId.toLowerCase() : "";
  if (!/^[0-9a-f]{16}$/.test(spanId)) {
    throw new TypeError("runtime-events: span.spanId must be 16 hex characters");
  }
  const parentSpanId = span.parentSpanId == null ? null : span.parentSpanId.toLowerCase();
  if (parentSpanId != null && !/^[0-9a-f]{16}$/.test(parentSpanId)) {
    throw new TypeError("runtime-events: span.parentSpanId must be 16 hex characters or null");
  }
  const taskKey = requireToken(span.taskKey, "span.taskKey");
  const supervisorSessionId = requireToken(span.supervisorSessionId, "span.supervisorSessionId");
  const workflowRunId = requireToken(span.workflowRunId, "span.workflowRunId");
  const actorId = requireToken(span.actorId, "span.actorId");
  const role = requireToken(span.role, "span.role");
  const name = requireToken(span.name, "span.name");
  const startAt = requireIso(span.startAt, "span.startAt");
  const endAt = optionalIso(span.endAt, "span.endAt");
  if (endAt != null && endAt < startAt) {
    throw new TypeError("runtime-events: span.endAt must not precede span.startAt");
  }
  let status = span.status === undefined || span.status === null ? "unset" : span.status;
  if (!["unset", "ok", "error"].includes(status)) {
    throw new TypeError("runtime-events: span.status must be unset|ok|error");
  }
  return {
    traceId,
    spanId,
    parentSpanId,
    taskKey,
    supervisorSessionId,
    workflowRunId,
    attemptId: optionalToken(span.attemptId, "span.attemptId"),
    actorId,
    role,
    parentActorId: optionalToken(span.parentActorId, "span.parentActorId"),
    baseActorId: optionalToken(span.baseActorId, "span.baseActorId"),
    name,
    startAt,
    endAt,
    model: optionalToken(span.model, "span.model"),
    toolName: optionalToken(span.toolName, "span.toolName"),
    toolUseId: optionalToken(span.toolUseId, "span.toolUseId"),
    agentId: optionalToken(span.agentId, "span.agentId"),
    querySource: optionalToken(span.querySource, "span.querySource"),
    sessionId: optionalToken(span.sessionId, "span.sessionId"),
    status,
  };
}

function withTempDb(dbPath, fn) {
  const db = openTelemetryDb(dbPath === undefined ? telemetryDbPath() : dbPath);
  try {
    ensureRuntimeSchema(db);
    return fn(db);
  } finally {
    db.close();
  }
}

/**
 * Record one supervisor runtime event. Idempotent on eventId (first write wins);
 * malformed input throws. Returns the stored normalized record — never null.
 * Callers write best-effort (try/catch); tests pass {dbPath} to a temp DB.
 */
export function recordRuntimeEvent(event, { dbPath } = {}) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new TypeError("runtime-events: event must be a plain object");
  }
  const eventId = requireToken(event.eventId, "event.eventId");
  if (event.schemaVersion !== undefined && event.schemaVersion !== 1) throw new TypeError("unsupported runtime schema version");
  const eventType = event.eventType ?? event.type;
  if (!RUNTIME_EVENT_TYPES.includes(eventType)) {
    throw new TypeError(`runtime-events: event.eventType must be one of ${RUNTIME_EVENT_TYPES.join("|")}`);
  }
  const taskKey = requireToken(event.taskKey, "event.taskKey");
  const supervisorSessionId = requireToken(event.supervisorSessionId, "event.supervisorSessionId");
  const workflowRunId = requireToken(event.workflowRunId, "event.workflowRunId");
  const actorId = requireToken(event.actorId, "event.actorId");
  const role = requireToken(event.role, "event.role");
  const attemptId = optionalToken(event.attemptId, "event.attemptId");
  const parentActorId = optionalToken(event.parentActorId, "event.parentActorId");
  if (event.seq !== undefined && (!Number.isInteger(event.seq) || event.seq < 0)) {
    throw new TypeError("runtime-events: event.seq must be a non-negative integer");
  }
  const occurredAt =
    event.occurredAt === undefined ? new Date().toISOString() : requireIso(event.occurredAt, "event.occurredAt");
  const payload = normalizePayload(event.payload);

  return withTempDb(dbPath, (db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
    const prior = db.prepare('SELECT * FROM fenix_runtime_events WHERE event_id = ?').get(eventId);
    if (prior) { db.exec('COMMIT'); return eventFromRow(prior); }
    const seq = event.seq ?? (db.prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM fenix_runtime_events WHERE supervisor_session_id = ? AND actor_id = ?').get(supervisorSessionId, actorId).n);
    db.prepare(
      `INSERT INTO fenix_runtime_events
        (event_id, schema_version, task_key, supervisor_session_id, workflow_run_id,
         attempt_id, actor_id, role, parent_actor_id, seq, occurred_at, event_type,
         payload_json, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(event_id) DO NOTHING`,
    ).run(
      eventId,
      RUNTIME_SCHEMA_VERSION,
      taskKey,
      supervisorSessionId,
      workflowRunId,
      attemptId,
      actorId,
      role,
      parentActorId,
      seq,
      occurredAt,
      eventType,
      JSON.stringify(payload),
      new Date().toISOString(),
    );
    const result = eventFromRow(db.prepare("SELECT * FROM fenix_runtime_events WHERE event_id = ?").get(eventId));
    db.exec('COMMIT'); return result;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  });
}

/**
 * Query stored runtime events. Filters: taskKey (exact), from/to on occurredAt
 * (inclusive), limit (default 10000). Returns camelCase records, [] if empty.
 */
export function queryRuntimeEvents({ taskKey, from, to, limit = 10000 } = {}, { dbPath } = {}) {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new TypeError("runtime-events: limit must be a positive integer");
  }
  const where = [];
  const params = [];
  if (taskKey !== undefined && taskKey !== null) {
    where.push("task_key = ?");
    params.push(requireToken(taskKey, "query.taskKey"));
  }
  if (from !== undefined && from !== null) {
    where.push("occurred_at >= ?");
    params.push(requireIso(from, "query.from"));
  }
  if (to !== undefined && to !== null) {
    where.push("occurred_at <= ?");
    params.push(requireIso(to, "query.to"));
  }
  const sql = `SELECT * FROM fenix_runtime_events
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY occurred_at ASC, seq ASC, event_id ASC LIMIT ?`;
  params.push(limit);
  return withTempDb(dbPath, (db) =>
    db
      .prepare(sql)
      .all(...params)
      .map(eventFromRow),
  );
}

/**
 * Record a batch of normalized spans. Well-formed duplicates on the
 * (traceId, spanId) PK count as duplicates; malformed input throws.
 * Returns {inserted, duplicates}.
 */
export function recordRuntimeSpans(spans, { dbPath } = {}) {
  if (!Array.isArray(spans)) {
    throw new TypeError("runtime-events: spans must be an array of normalized span records");
  }
  const validated = spans.map(validateSpanRecord);
  let inserted = 0;
  let duplicates = 0;
  withTempDb(dbPath, (db) => {
    const insert = db.prepare(
      `INSERT INTO fenix_runtime_spans
        (trace_id, span_id, parent_span_id, task_key, supervisor_session_id,
         workflow_run_id, attempt_id, actor_id, role, parent_actor_id, base_actor_id,
         name, start_at, end_at, model, tool_name, tool_use_id, agent_id,
         query_source, session_id, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(trace_id, span_id) DO NOTHING`,
    );
    for (const s of validated) {
      const info = insert.run(
        s.traceId,
        s.spanId,
        s.parentSpanId,
        s.taskKey,
        s.supervisorSessionId,
        s.workflowRunId,
        s.attemptId,
        s.actorId,
        s.role,
        s.parentActorId,
        s.baseActorId,
        s.name,
        s.startAt,
        s.endAt,
        s.model,
        s.toolName,
        s.toolUseId,
        s.agentId,
        s.querySource,
        s.sessionId,
        s.status,
        new Date().toISOString(),
      );
      // node:sqlite reports 0 changes for an INSERT ... DO NOTHING conflict.
      if (info.changes > 0) inserted += 1;
      else duplicates += 1;
    }
  });
  return { inserted, duplicates };
}

/**
 * Query stored spans. taskKey filters exactly; from/to clip by INTERSECTION:
 * a span is included when start_at <= to AND (end_at is open OR end_at >= from)
 * — in-flight spans (open end) count from their start. Returns camelCase records.
 */
export function queryRuntimeSpans({ taskKey, from, to, limit = 10000 } = {}, { dbPath } = {}) {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new TypeError("runtime-events: limit must be a positive integer");
  }
  const where = [];
  const params = [];
  if (taskKey !== undefined && taskKey !== null) {
    where.push("task_key = ?");
    params.push(requireToken(taskKey, "query.taskKey"));
  }
  if (from !== undefined && from !== null) {
    where.push("(end_at IS NULL OR end_at >= ?)");
    params.push(requireIso(from, "query.from"));
  }
  if (to !== undefined && to !== null) {
    where.push("start_at <= ?");
    params.push(requireIso(to, "query.to"));
  }
  const sql = `SELECT * FROM fenix_runtime_spans
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY start_at ASC, trace_id ASC, span_id ASC LIMIT ?`;
  params.push(limit);
  return withTempDb(dbPath, (db) =>
    db
      .prepare(sql)
      .all(...params)
      .map(spanFromRow),
  );
}
