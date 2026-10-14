// Route-level tests for GET /api/runtime-statistics (implemented in
// runtime-statistics-routes.mjs). One in-process block, in the unit style of
// settings-routes.test.mjs — NO server child, NO ports:
//
//   - the handler is called with a stub req/res/ctx and INJECTED loaders
//     (ctx.loadRuntimeEvents / ctx.loadRuntimeSpans), so no store is touched
//     in this block; the captures pin the exact query each loader receives;
//
//   - one integration block exercises the DEFAULT loader path (the real
//     queryRuntimeEvents / queryRuntimeSpans) against a temp DB via the
//     LA_TELEMETRY_DB seam, fed with recordRuntimeEvent / recordRuntimeSpans
//     fixtures — proving the eventType -> type alias end to end.
//
// Coverage: the not-ours fallthrough, the 400s (non-canonical taskKey, bad
// from/to, from > to, bad window, window+from conflict), the boundary rule
// (events queried with NO window prefilter, spans WITH it), the alias, the
// truncation flags at the 10000 bound, the loader-failure 500 and the `to`
// default. The env seam is set on this process before the store import and
// never deleted (the static audit forbids it). Fixtures live under one
// mkdtemp dir; no real-repo-path writes, no real network.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) { passed++; return; }
  failed++;
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

// ── seams: the temp DB path is pinned before the store library loads ─────────

const dir = mkdtempSync(join(tmpdir(), "runtime-statistics-routes-"));
const dbPath = join(dir, "telemetry.sqlite");
process.env.LA_TELEMETRY_DB = dbPath;

const { handleRuntimeStatisticsRoute, QUERY_LIMIT } = await import("./runtime-statistics-routes.mjs");
const { recordRuntimeEvent, recordRuntimeSpans } = await import("./runtime-events.mjs");

// ── the stub harness (the settings-routes.test.mjs pattern) ──────────────────

const captured = { events: [], spans: [] };

// Injectable fixture loaders; `events`/`spans` below hold what they return.
const fixtureEvents = [];
const fixtureSpans = [];

const loadRuntimeEvents = (q, o) => {
  captured.events.push({ q, o });
  return fixtureEvents;
};
const loadRuntimeSpans = (q, o) => {
  captured.spans.push({ q, o });
  return fixtureSpans;
};

async function unit(path, { loaders = true, origin = "http://localhost:5173" } = {}) {
  const req = {
    method: "GET",
    headers: { origin },
    socket: { remoteAddress: "127.0.0.1" },
  };
  const res = {};
  const ctx = {
    json: (r, status, payload) => { res.__status = status; res.__body = payload; },
    log: () => {},
    ...(loaders ? { loadRuntimeEvents, loadRuntimeSpans } : { dbPath }),
  };
  const handled = await handleRuntimeStatisticsRoute(req, res, new URL(path, "http://127.0.0.1"), ctx);
  return { handled, status: res.__status, body: res.__body };
}

function resetCaptures() {
  captured.events.length = 0;
  captured.spans.length = 0;
  fixtureEvents.length = 0;
  fixtureSpans.length = 0;
}

// A minimal well-formed event record (the queryRuntimeEvents shape).
const iso = (offsetMs, base = Date.parse("2026-10-13T12:00:00Z")) =>
  new Date(base + offsetMs).toISOString();
const ev = (eventType, offsetMs, extra = {}, base = Date.parse("2026-10-13T12:00:00Z")) => ({
  eventId: extra.eventId ?? `${eventType}-${offsetMs}`,
  eventType,
  taskKey: "fenix:TEST-1",
  supervisorSessionId: "sup-1",
  workflowRunId: "run-1",
  attemptId: null,
  actorId: "actor-1",
  role: "supervisor",
  parentActorId: null,
  seq: 0,
  occurredAt: iso(offsetMs, base),
  payload: {},
  ...extra,
});

// ── unit: not ours ───────────────────────────────────────────────────────────

{
  resetCaptures();
  const r = await unit("/api/runtime-statistics/extra");
  check("unit unmatched path -> not handled", r.handled === false && r.status === undefined);
  // POST: the method guard.
  const res = {};
  const ctx = {
    json: (r, status, payload) => { res.__status = status; res.__body = payload; },
    log: () => {},
    loadRuntimeEvents, loadRuntimeSpans,
  };
  const handled = await handleRuntimeStatisticsRoute(
    { method: "POST", headers: {} }, res, new URL("/api/runtime-statistics", "http://127.0.0.1"), ctx,
  );
  check("unit POST -> not handled", handled === false && res.__status === undefined);
}

// ── unit: the 400s ───────────────────────────────────────────────────────────

{
  resetCaptures();
  check("unit bad taskKey (no colon) -> 400", (await unit("/api/runtime-statistics?taskKey=TEST-1")).status === 400);
  check("unit bad taskKey (space) -> 400", (await unit("/api/runtime-statistics?taskKey=fenix:TEST%201")).status === 400);
  check("unit bad from -> 400", (await unit("/api/runtime-statistics?from=not-a-date")).status === 400);
  check("unit date-only from -> 400", (await unit("/api/runtime-statistics?from=2026-10-13")).status === 400);
  check("unit bad to -> 400", (await unit("/api/runtime-statistics?to=13.10.2026")).status === 400);
  check("unit from after to -> 400",
    (await unit("/api/runtime-statistics?from=2026-10-13T12:00:00Z&to=2026-10-12T12:00:00Z")).status === 400);
  check("unit bad window value -> 400", (await unit("/api/runtime-statistics?window=90d")).status === 400);
  check("unit window + from -> 400",
    (await unit("/api/runtime-statistics?window=24h&from=2026-10-13T00:00:00Z")).status === 400);
  check("unit no 400 reached the loaders",
    captured.events.length === 0 && captured.spans.length === 0);
  // An empty taskKey is absent, not malformed: the 200 DOES reach the loaders.
  check("unit empty taskKey treated as absent", (await unit("/api/runtime-statistics?taskKey=")).status === 200);
  check("unit only the 200 capture remains",
    captured.events.length === 1 && captured.events[0].q.taskKey === null);
}

// ── unit: the boundary rule and the passthrough ──────────────────────────────

{
  resetCaptures();
  fixtureEvents.push(ev("supervisor_started", -48 * 3_600_000)); // before the window
  fixtureEvents.push(ev("supervisor_stopped", -2 * 3_600_000));
  const r = await unit("/api/runtime-statistics?taskKey=fenix:TEST-1&window=24h");
  check("unit window 24h -> 200", r.status === 200, JSON.stringify(r.body).slice(0, 200));
  check("unit events loader got NO window prefilter",
    captured.events.length === 1 &&
    captured.events[0].q.taskKey === "fenix:TEST-1" &&
    captured.events[0].q.from === undefined &&
    captured.events[0].q.to === undefined &&
    captured.events[0].q.limit === QUERY_LIMIT,
    JSON.stringify(captured.events[0]?.q));
  // from ≈ now-24h (computed inside the handler; a small execution skew is
  // tolerated rather than asserted to the millisecond).
  const fromAt = new Date(captured.spans[0]?.q?.from ?? "").getTime();
  const toAt = new Date(captured.spans[0]?.q?.to ?? "").getTime();
  check("unit spans loader got the window",
    captured.spans.length === 1 &&
    Number.isFinite(fromAt) && Math.abs(fromAt - (Date.now() - 24 * 3_600_000)) < 5_000 &&
    Number.isFinite(toAt) && Math.abs(toAt - Date.now()) < 5_000 &&
    captured.spans[0].q.limit === QUERY_LIMIT,
    JSON.stringify(captured.spans[0]?.q));
  check("unit lifecycle pair from before the window bounds eligibility",
    r.body?.statistics?.actors?.length === 1 && r.body?.statistics?.actors[0].eligibleMs != null,
    JSON.stringify(r.body?.statistics?.actors));
  check("unit envelope carries query echo + statistics",
    r.body?.query?.taskKey === "fenix:TEST-1" &&
    typeof r.body?.query?.from === "string" &&
    typeof r.body?.generatedAt === "string" &&
    r.body?.statistics?.window?.from != null,
    JSON.stringify(r.body?.query));
  check("unit not truncated below the bound",
    r.body?.query?.truncated === false &&
    r.body?.query?.eventsTruncated === false &&
    r.body?.query?.spansTruncated === false);
}

// ── unit: the eventType alias ────────────────────────────────────────────────

{
  resetCaptures();
  // ONLY eventType — if the alias were missing, sanitizeEvent would drop both
  // records (invalidEvents 2) and the actor would have no lifecycle at all.
  fixtureEvents.push(ev("supervisor_started", -3 * 3_600_000));
  fixtureEvents.push(ev("supervisor_stopped", -1 * 3_600_000));
  const r = await unit("/api/runtime-statistics");
  check("unit alias: no invalid events", r.body?.statistics?.coverage?.invalidEvents === 0,
    JSON.stringify(r.body?.statistics?.coverage));
  check("unit alias: actor lifecycle paired",
    r.body?.statistics?.actors?.length === 1 &&
    r.body?.statistics?.coverage?.eligibleMs != null,
    JSON.stringify(r.body?.statistics?.coverage));
}

// ── unit: truncation ─────────────────────────────────────────────────────────

{
  resetCaptures();
  for (let i = 0; i < QUERY_LIMIT; i++) {
    fixtureEvents.push(ev("actor_state_changed", i, { eventId: `state-${i}`, seq: i }));
  }
  const r = await unit("/api/runtime-statistics");
  check("unit events at the bound -> eventsTruncated",
    r.body?.query?.eventsTruncated === true && r.body?.query?.spansTruncated === false &&
    r.body?.query?.truncated === true,
    JSON.stringify(r.body?.query));
  resetCaptures();
  for (let i = 0; i < QUERY_LIMIT; i++) {
    fixtureSpans.push({
      traceId: "a".repeat(32), spanId: i.toString(16).padStart(16, "0"),
      parentSpanId: null, taskKey: "fenix:TEST-1", supervisorSessionId: "sup-1",
      workflowRunId: "run-1", attemptId: null, actorId: "actor-1", role: "supervisor",
      parentActorId: null, baseActorId: null, name: "claude_code.interaction",
      startAt: iso(-10 * 60_000), endAt: iso(-9 * 60_000), model: null, toolName: null,
      toolUseId: null, agentId: null, querySource: null, sessionId: null, status: "ok",
    });
  }
  const r2 = await unit("/api/runtime-statistics");
  check("unit spans at the bound -> spansTruncated",
    r2.body?.query?.spansTruncated === true && r2.body?.query?.truncated === true,
    JSON.stringify(r2.body?.query));
}

// ── unit: loader failure -> 500 ──────────────────────────────────────────────

{
  const res = {};
  const ctx = {
    json: (r, status, payload) => { res.__status = status; res.__body = payload; },
    log: () => {},
    loadRuntimeEvents: () => { throw new Error("store exploded"); },
    loadRuntimeSpans,
  };
  const handled = await handleRuntimeStatisticsRoute(
    { method: "GET", headers: {} }, res, new URL("/api/runtime-statistics", "http://127.0.0.1"), ctx,
  );
  check("unit loader throw -> 500", handled === true && res.__status === 500 &&
    String(res.__body?.error).includes("store exploded"), JSON.stringify(res.__body));
}

// ── integration: the default loaders against the real store shape ────────────

try {
  // Relative to now so the 24h window provably catches the fixtures at any
  // wall-clock the suite runs at. Lifecycle [-3h, -1h]; interaction span
  // [-90m, -30m] -> known = intersection = [-90m, -60m] = 30 min.
  const now = Date.now();
  recordRuntimeEvent(ev("supervisor_started", -3 * 3_600_000, { eventId: "int-started" }, now));
  recordRuntimeEvent(ev("supervisor_stopped", -1 * 3_600_000, { eventId: "int-stopped" }, now));
  recordRuntimeSpans([{
    traceId: "b".repeat(32), spanId: "c".repeat(16), parentSpanId: null,
    taskKey: "fenix:TEST-1", supervisorSessionId: "sup-1", workflowRunId: "run-1",
    attemptId: null, actorId: "actor-1", role: "supervisor", parentActorId: null,
    baseActorId: null, name: "claude_code.interaction",
    startAt: iso(-90 * 60_000, now), endAt: iso(-30 * 60_000, now),
    model: null, toolName: null, toolUseId: null, agentId: null,
    querySource: null, sessionId: null, status: "ok",
  }]);

  const r = await unit("/api/runtime-statistics?taskKey=fenix:TEST-1&window=24h", { loaders: false });
  check("int default loaders -> 200", r.status === 200, JSON.stringify(r.body).slice(0, 200));
  check("int stored eventType records aggregate (alias proven end to end)",
    r.body?.statistics?.actors?.length === 1 &&
    r.body?.statistics?.coverage?.invalidEvents === 0,
    JSON.stringify(r.body?.statistics?.coverage));
  check("int interaction span lands in the actor's known time (intersection with the lifecycle)",
    r.body?.statistics?.actors[0].knownMs === 30 * 60_000,
    JSON.stringify(r.body?.statistics?.actors[0]));
  check("int to defaulted to now", typeof r.body?.query?.to === "string");
} catch (err) {
  failed++;
  failures.push(`integration crashed — ${err?.stack || err}`);
}

// ── report ───────────────────────────────────────────────────────────────────

try {
  rmSync(dir, { recursive: true, force: true });
} catch { /* Windows file locks — the tmp dir is disposable */ }

console.log(`\nruntime-statistics-routes: ${passed} passed, ${failed} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);

process.exit(failed ? 1 : 0);