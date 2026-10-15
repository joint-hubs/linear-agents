// scripts/runtime-statistics-routes.mjs — GET /api/runtime-statistics
// (PRD "Task workspace, concurrent supervisors, manager tool config,
// statistics & semantic map" §9–10, phase P3): the transport adapter in front
// of the pure aggregation in runtime-statistics.mjs.
//
// TRANSPORT ONLY, in the work-routes.mjs style: the route guards, validates
// the query, loads the raw records and passes them through — every metric is
// derived in runtime-statistics.mjs, never here. The response envelope is:
//
//   {
//     generatedAt,
//     query: { taskKey, from, to, limit, eventsTruncated, spansTruncated,
//              truncated },
//     statistics: aggregateRuntimeStatistics(...)  // the module output verbatim
//   }
//
// Query parameters (all optional):
//   taskKey  — canonical `workspace:issueId`; anything else is a 400.
//   from/to  — ISO-8601 timestamps bounding the window; invalid dates or
//              from > to are a 400. `to` defaults to now: an unbounded window
//              cannot bound open lifetimes, so coverage would read unknown for
//              every still-running supervisor — a systematic false "unknown",
//              not honesty (PRD §10: missing denominators render null, but the
//              missingness must not be manufactured).
//   window   — shorthand for `from`: 24h | 7d | 30d. Mutually exclusive with
//              an explicit `from`.
//
// Loading rules (PRD §9, P3 decisions):
//   - events are queried WITHOUT the window prefilter: lifecycle pairs
//     (supervisor_started before the window) must survive so the aggregation
//     can bound eligible lifetimes; the aggregation clips time itself;
//   - spans are queried with the window and clip by intersection inside the
//     loader (open spans count from their start);
//   - both queries are bounded at 10000 records; hitting the bound reports
//     truncated: true — a partial view must never advertise global counts.
//
// The stored event records carry `eventType`; the aggregation reads `type`.
// The alias is added here, additively, so both spellings aggregate.
//
// ctx: { json, log } as the server passes to every route module, plus the
// TEST-ONLY seam { loadRuntimeEvents, loadRuntimeSpans, dbPath } — injected
// loaders replace the store reads in unit tests; without them the default
// loaders read the central telemetry DB (LA_TELEMETRY_DB / its default path).

import { queryRuntimeEvents, queryRuntimeSpans } from "./runtime-events.mjs";
import { aggregateRuntimeStatistics } from "./runtime-statistics.mjs";

// The same bound runtime-events.mjs applies as its own default limit.
export const QUERY_LIMIT = 10_000;

// The canonical taskKey shape: `workspace:issueId`, both parts short safe
// tokens (the same character class runtime-events.mjs accepts, so a key that
// passes here can never fail downstream).
const TASK_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*:[A-Za-z0-9][A-Za-z0-9._:-]*$/;

// ISO-8601 with a date and at least minutes — the same shape
// runtime-events.mjs stores, plus a finite parse.
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

// `window` shorthands: milliseconds back from now.
const WINDOW_SHORTHAND_MS = {
  "24h": 24 * 3_600_000,
  "7d": 7 * 24 * 3_600_000,
  "30d": 30 * 24 * 3_600_000,
};

/** An ISO-8601 string -> the canonical UTC form, or null when malformed. */
function parseIso(value) {
  if (typeof value !== "string" || !ISO_RE.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Handle the runtime statistics route. Returns true when the request was
 * handled (the caller returns immediately), false when it is not ours.
 */
export async function handleRuntimeStatisticsRoute(req, res, url, ctx) {
  if (req.method !== "GET" || url.pathname !== "/api/runtime-statistics") return false;
  const { json, log } = ctx;
  const method = req.method;
  const path = url.pathname;
  const reject = (status, error) => {
    json(res, status, { error });
    log(method, path, status);
    return true;
  };

  // taskKey — optional; present but non-canonical is a 400 (never silently
  // widened to "everything": a mistyped filter that silently matched all
  // tasks would publish exactly the global counts the PRD forbids).
  let taskKey = null;
  const rawTaskKey = url.searchParams.get("taskKey");
  if (rawTaskKey != null && rawTaskKey !== "") {
    if (!TASK_KEY_RE.test(rawTaskKey)) {
      return reject(400, "bad taskKey: expected canonical workspace:issueId");
    }
    taskKey = rawTaskKey;
  }

  // Window — from/to ISO (optional), or the window shorthand for from.
  let from = null;
  let to = null;
  const rawFrom = url.searchParams.get("from");
  if (rawFrom != null && rawFrom !== "") {
    const iso = parseIso(rawFrom);
    if (!iso) return reject(400, "bad from: not an ISO-8601 timestamp");
    from = iso;
  }
  const rawTo = url.searchParams.get("to");
  if (rawTo != null && rawTo !== "") {
    const iso = parseIso(rawTo);
    if (!iso) return reject(400, "bad to: not an ISO-8601 timestamp");
    to = iso;
  }
  const rawWindow = url.searchParams.get("window");
  if (rawWindow != null && rawWindow !== "") {
    const ms = WINDOW_SHORTHAND_MS[rawWindow];
    if (!ms) return reject(400, "bad window: expected 24h|7d|30d");
    if (from) return reject(400, "window is a shorthand for from; pass either window or from");
    from = new Date(Date.now() - ms).toISOString();
  }
  if (from && to && from > to) {
    return reject(400, "bad window: from is after to");
  }
  if (!to) to = new Date().toISOString(); // bounded window (see the header note)

  // The loaders: injected for tests, the store reads otherwise.
  const opts = { dbPath: ctx.dbPath };
  const loadEvents = ctx.loadRuntimeEvents ?? ((q, o) => queryRuntimeEvents(q, o));
  const loadSpans = ctx.loadRuntimeSpans ?? ((q, o) => queryRuntimeSpans(q, o));

  let events;
  let spans;
  try {
    [events, spans] = await Promise.all([
      loadEvents({ taskKey, limit: QUERY_LIMIT }, opts),
      loadSpans({ taskKey, from, to, limit: QUERY_LIMIT }, opts),
    ]);
  } catch (err) {
    return reject(500, `runtime store failed: ${String(err?.message ?? err)}`);
  }
  const eventList = Array.isArray(events) ? events : [];
  const spanList = Array.isArray(spans) ? spans : [];

  // The eventType -> type alias (see the header note): additive, per record.
  const aliasedEvents = eventList.map((e) =>
    e && e.type == null && e.eventType != null ? { ...e, type: e.eventType } : e,
  );

  const eventsTruncated = eventList.length >= QUERY_LIMIT;
  const spansTruncated = spanList.length >= QUERY_LIMIT;

  const statistics = aggregateRuntimeStatistics({
    events: aliasedEvents,
    spans: spanList,
    from,
    to,
    taskKey,
  });

  json(res, 200, {
    generatedAt: new Date().toISOString(),
    query: {
      taskKey,
      from,
      to,
      limit: QUERY_LIMIT,
      eventsTruncated,
      spansTruncated,
      truncated: eventsTruncated || spansTruncated,
    },
    statistics,
  });
  log(method, path, 200);
  return true;
}