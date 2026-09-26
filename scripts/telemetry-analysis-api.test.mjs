// Route-level tests for the Analysis-screen endpoints (telemetry-server.mjs's
// /api/analysis/* block).
//
// Spawns the REAL telemetry-server on a free random port with fully isolated
// stores (LA_TELEMETRY_DB / LA_TELEMETRY_HOME / LA_DECISION_RUNS_DIR under a
// tmp dir), so the production server on 7331, the live telemetry.sqlite and
// the repo's real .state tree are never touched. The fixture DB is built with
// openTelemetryDb() + ensureViews (fine in a temp dir) exactly as
// telemetry-analysis.test.mjs builds its fixtures.
//
// Proven here, over HTTP:
//   - GET meta/cost/tools/handoffs/quality/decisions → 200 with the panels'
//     envelope shape ({ filters?, data, caveats }) — served from the DERIVED
//     cache (built below with buildCache before the server starts), so the
//     checks double as proof the panels read the cache, not the store;
//   - bad filter input (?era=nonsense) → 400 with code "bad_filter";
//   - POST /api/analysis/sql: SELECT → 200 { columns, rows }; DELETE → 400
//     code "rejected"; a query on decision_events (extraTable from the
//     decision log) → 200; invalid JSON body → 400 code "bad_json";
//     target "store" reads raw store tables, "cache" the materialisation,
//     anything else → 400 code "rejected";
//   - GET /api/analysis/cache → status (stale/building/lastBuild);
//   - POST /api/analysis/cache/rebuild → 202 + the build child finishes
//     (poll until building:false), 409 while a live lock exists, 403 from a
//     non-allowed Origin;
//   - a missing cache → panels 503 code "cache_building" + an auto-build
//     child restores the cache.
//
// The server child is ALWAYS killed in finally.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { openTelemetryDb } from "./telemetry-store.mjs";
import { ensureViews } from "./telemetry-canonical.mjs";
import { buildCache } from "./analysis-cache.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) { passed++; return; }
  failed++;
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

// ── fixture: telemetry store ─────────────────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), "telemetry-analysis-api-"));
const dbPath = join(dir, "telemetry.sqlite");

{
  const db = openTelemetryDb(dbPath);
  ensureViews(db);

  db.prepare("INSERT INTO price_sets (price_set_id, config_hash, created_at, source) VALUES (?,?,?,?)")
    .run("ps1", "hash1", "2026-09-01T00:00:00.000Z", "test");
  const insertRun = db.prepare(`INSERT INTO runs (run_id, squad, started_at, ended_at, price_set_id, status, updated_at)
    VALUES (?,?,?,?,?,?,'2026-09-01T00:00:00.000Z')`);
  insertRun.run("runPre", "alpha", "2026-09-20T10:00:00.000Z", "2026-09-20T11:00:00.000Z", "ps1", "completed");
  insertRun.run("runPost", "beta", "2026-09-24T10:00:00.000Z", "2026-09-24T11:00:00.000Z", "ps1", "completed");

  const usage = db.prepare(`INSERT INTO usage_facts
    (usage_id, run_id, session_id, agent_key, model, observed_at,
     input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
     source_path, source_offset, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const cost = db.prepare("INSERT INTO cost_facts (run_id, usage_id, price_set_id, cost_usd) VALUES (?,?,?,?)");
  // One priced pre-boundary turn (alpha), one priced post-boundary lead turn
  // (beta), and the post run's worker-1 turn — the delegation link's child,
  // so handoffsPanel can resolve it via canonical_usage.
  usage.run("up1", "runPre", "s1", "_lead", "m1", "2026-09-20T10:30:00.000Z", 100, 50, 0, 0, "/pre.jsonl", 10, "2026-09-20T10:30:00.000Z");
  usage.run("up2", "runPost", "s2", "_lead", "m1", "2026-09-24T10:30:00.000Z", 80, 40, 0, 0, "/post.jsonl", 10, "2026-09-24T10:30:00.000Z");
  usage.run("up3", "runPost", "s3", "worker-1", "m1", "2026-09-24T10:35:00.000Z", 20, 10, 0, 0, "/post.jsonl", 40, "2026-09-24T10:35:00.000Z");
  cost.run("runPre", "up1", "ps1", 1.5);
  cost.run("runPost", "up2", "ps1", 2.0);
  cost.run("runPost", "up3", "ps1", 0.5);

  const tool = db.prepare(`INSERT INTO tool_facts
    (tool_fact_id, run_id, agent_key, model, observed_at, tool_name_raw, tool_name_canon,
     tool_input, tool_has_error, turn_index, source_path, source_offset, created_at,
     tool_input_id, tool_index, tool_result_state, tool_result_bytes, tool_result_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  tool.run("tf1", "runPost", "_lead", "m1", "2026-09-24T10:31:00.000Z", "Read", "read_file",
    '{"file_path":"/a.txt"}', 0, 0, "/tp.jsonl", 10, "2026-09-24T10:31:00.000Z", "idA", 0, "ok", 10, "res1");
  tool.run("tf2", "runPost", "_lead", "m1", "2026-09-24T10:32:00.000Z", "Read", "read_file",
    '{"file_path":"/a.txt"}', 0, 1, "/tp.jsonl", 20, "2026-09-24T10:32:00.000Z", "idA", 1, "ok", 10, "res1");
  tool.run("tf3", "runPost", "_lead", "m1", "2026-09-24T10:33:00.000Z", "Edit", "edit_file",
    '{"file_path":"/b.txt"}', 1, 2, "/tp.jsonl", 30, "2026-09-24T10:33:00.000Z", "idB", 2, "error", 20, "res2");

  // A delegation link so handoffs has something to resolve (child usage exists).
  const link = db.prepare(`INSERT INTO delegation_links
    (delegation_id, parent_run_id, parent_agent, child_agent, child_model,
     child_transcript, observed_at, child_tokens, child_cost_usd, child_turns,
     source, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  link.run("dl1", "runPost", "lead-1", "worker-1", "m1", "/w1.jsonl", "2026-09-24T10:40:00.000Z", null, null, null, "test", "2026-09-24T10:40:00.000Z");

  // An open data-quality issue so quality's openIssues is non-empty.
  db.prepare(`INSERT INTO data_quality_issues
    (issue_id, run_id, issue_type, severity, details_json, opened_at, resolved_at) VALUES (?,?,?,?,?,?,?)`)
    .run("iss1", "runPre", "pricing_missing", "warning", "{}", "2026-09-20T12:00:00.000Z", null);

  db.close();
}

// ── fixture: decision log (one event + one label) ────────────────────────────

const runsDir = join(dir, "runs");
mkdirSync(join(runsDir, "fixture-run-1"), { recursive: true });
writeFileSync(
  join(runsDir, "fixture-run-1", "decisions.jsonl"),
  [
    JSON.stringify({
      type: "event",
      eventId: "evt-1",
      decisionId: "intake.triage_node",
      ts: "2026-09-24T12:00:00.000Z",
      model: "m1",
      tier: 1,
      mode: "test",
      ok: true,
      confidence: 0.9,
      durationMs: 120,
      usage: { cost: 0.00001, inputTokens: 10, outputTokens: 5 },
      answers: { q0: { type: "choice", choice: "dev" } },
      taskKey: "FIX-1",
    }),
    JSON.stringify({
      type: "label",
      eventId: "evt-1",
      outcome: "dev",
      by: "human",
      source: "manual",
      ts: "2026-09-24T12:05:00.000Z",
    }),
    "\n",
  ].join("\n"),
  "utf8",
);

// ── fixture: analysis cache ──────────────────────────────────────────────────

// Panels and sql target:"cache" read the DERIVED cache, so it must exist
// before the server starts. Built in-process here (the fixture store is tiny —
// milliseconds) with the same buildCache the server's rebuild child runs.
const cacheFile = join(dir, "analysis-cache.sqlite");
await buildCache({ storePath: dbPath, cachePath: cacheFile });

// ── server spawn (free random port) ──────────────────────────────────────────

// Grab a free port by binding an ephemeral listener and closing it. Small
// race window, but the port comes from the OS free set and nothing else in
// the test run is listening on it.
const freePort = await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});
const BASE = `http://127.0.0.1:${freePort}`;

const child = spawn(process.execPath, [join(__dir, "telemetry-server.mjs")], {
  env: {
    ...process.env,
    TELEMETRY_PORT: String(freePort),
    LA_TELEMETRY_DB: dbPath,
    LA_TELEMETRY_HOME: join(dir, "telemetry-home"),
    LA_STATE_ROOT: join(dir, "state-root"),
    LA_DECISION_RUNS_DIR: runsDir,
    LA_ANALYSIS_CACHE: cacheFile,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let childStderr = "";
child.stderr.on("data", (chunk) => { childStderr += chunk; });
let childStdout = "";
child.stdout.on("data", (chunk) => { childStdout += chunk; });

async function waitForServer(ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early (${child.exitCode}): ${childStderr.slice(-600)}`);
    }
    try {
      const res = await fetch(`${BASE}/api/telemetry/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server not ready in ${ms}ms: ${childStderr.slice(-600)}`);
}

async function getJsonFrom(base, path) {
  const res = await fetch(`${base}${path}`);
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

async function getJson(path) {
  return getJsonFrom(BASE, path);
}

let serverUp = false;

try {
  try {
    await waitForServer();
    serverUp = true;
  } catch (err) {
    failed++;
    failures.push(`server setup — ${err.message}`);
  }

  if (serverUp) {
    // ── GET panels: 200 + envelope shape ─────────────────────────────────

    const meta = await getJson("/api/analysis/meta");
    check("GET /api/analysis/meta -> 200", meta.status === 200, `got ${meta.status}: ${JSON.stringify(meta.body).slice(0, 300)}`);
    check("meta envelope: data + caveats",
      meta.body && meta.body.data && Array.isArray(meta.body.caveats),
      JSON.stringify(meta.body).slice(0, 200));
    check("meta data: counts + window + eraBoundary",
      meta.body?.data?.counts && typeof meta.body?.data?.counts?.turns === "number" &&
      meta.body?.data?.window && typeof meta.body?.data?.eraBoundary === "string",
      JSON.stringify(meta.body?.data).slice(0, 200));
    check("meta counts: 2 runs, 3 turns, 3 tool calls",
      meta.body?.data?.counts?.runs === 2 && meta.body?.data?.counts?.turns === 3 &&
      meta.body?.data?.counts?.toolCalls === 3,
      JSON.stringify(meta.body?.data?.counts));

    // era=post default keeps only the post-boundary turns; era=all sees all.
    const cost = await getJson("/api/analysis/cost?era=all");
    check("GET /api/analysis/cost -> 200", cost.status === 200, `got ${cost.status}`);
    check("cost envelope: filters + data + caveats",
      cost.body && cost.body.filters && cost.body.data && Array.isArray(cost.body.caveats),
      JSON.stringify(cost.body).slice(0, 200));
    check("cost data: era=all totals 3 turns / $4.0",
      cost.body?.data?.totals?.turns === 3 && Math.abs(cost.body?.data?.totals?.usd - 4.0) < 1e-9,
      JSON.stringify(cost.body?.data?.totals));

    const tools = await getJson("/api/analysis/tools?era=post");
    check("GET /api/analysis/tools -> 200", tools.status === 200, `got ${tools.status}`);
    check("tools envelope: totals + byTool",
      tools.body?.data?.totals && Array.isArray(tools.body?.data?.byTool),
      JSON.stringify(tools.body).slice(0, 200));
    check("tools data: era=post counts 3 calls, 1 error",
      tools.body?.data?.totals?.calls === 3 && tools.body?.data?.totals?.errors === 1,
      JSON.stringify(tools.body?.data?.totals));

    const handoffs = await getJson("/api/analysis/handoffs?era=all");
    check("GET /api/analysis/handoffs -> 200", handoffs.status === 200, `got ${handoffs.status}`);
    check("handoffs envelope: totals + byPair + bySquad",
      handoffs.body?.data?.totals && Array.isArray(handoffs.body?.data?.byPair) &&
      Array.isArray(handoffs.body?.data?.bySquad),
      JSON.stringify(handoffs.body).slice(0, 200));
    check("handoffs data: 1 link, resolved",
      handoffs.body?.data?.totals?.links === 1 && handoffs.body?.data?.totals?.resolved === 1,
      JSON.stringify(handoffs.body?.data?.totals));

    const quality = await getJson("/api/analysis/quality?era=all");
    check("GET /api/analysis/quality -> 200", quality.status === 200, `got ${quality.status}`);
    check("quality envelope: canonCoverage + openIssues",
      quality.body?.data?.canonCoverage && Array.isArray(quality.body?.data?.openIssues),
      JSON.stringify(quality.body).slice(0, 200));
    check("quality data: the seeded pricing_missing issue is listed open",
      quality.body?.data?.openIssues?.some((r) => r.issue_type === "pricing_missing" && r.n === 1),
      JSON.stringify(quality.body?.data?.openIssues));

    const decisions = await getJson("/api/analysis/decisions");
    check("GET /api/analysis/decisions -> 200", decisions.status === 200, `got ${decisions.status}`);
    check("decisions envelope: totals + decisions[]",
      decisions.body?.data?.totals && Array.isArray(decisions.body?.data?.decisions),
      JSON.stringify(decisions.body).slice(0, 200));
    check("decisions data: the fixture event lands under its decisionId with agreement",
      decisions.body?.data?.totals?.events === 1 &&
      decisions.body?.data?.decisions?.[0]?.decisionId === "intake.triage_node" &&
      decisions.body?.data?.decisions?.[0]?.agreement?.compared === 1 &&
      decisions.body?.data?.decisions?.[0]?.agreement?.rate === 1,
      JSON.stringify(decisions.body?.data).slice(0, 300));
    check("decisions without squad/model: no filter_not_applied caveat",
      !decisions.body?.caveats?.some((c) => c.code === "filter_not_applied"),
      JSON.stringify(decisions.body?.caveats));

    // squad/model mean nothing for decision events — the route must SAY so
    // (a silently dropped filter lies in the numbers), not just ignore them.
    const decisionsFiltered = await getJson("/api/analysis/decisions?squad=alpha&model=m1");
    check("decisions with squad/model -> 200", decisionsFiltered.status === 200, `got ${decisionsFiltered.status}`);
    check("decisions with squad/model -> info caveat filter_not_applied",
      decisionsFiltered.body?.caveats?.some(
        (c) => c.code === "filter_not_applied" && c.level === "info" &&
          /do not apply to decision events/.test(c.message),
      ),
      JSON.stringify(decisionsFiltered.body?.caveats));

    // ── error mapping ────────────────────────────────────────────────────

    const badEra = await getJson("/api/analysis/cost?era=nonsense");
    check("bad era -> 400 with code bad_filter", badEra.status === 400 && badEra.body?.code === "bad_filter",
      `status ${badEra.status} body ${JSON.stringify(badEra.body)}`);
    const badDate = await getJson("/api/analysis/quality?from=not-a-date");
    check("bad date -> 400 with code bad_filter", badDate.status === 400 && badDate.body?.code === "bad_filter",
      `status ${badDate.status} body ${JSON.stringify(badDate.body)}`);

    // ── POST /api/analysis/sql ───────────────────────────────────────────

    const sel = await fetch(`${BASE}/api/analysis/sql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sql: "SELECT run_id, squad FROM runs ORDER BY run_id" }),
    });
    const selBody = await sel.json().catch(() => null);
    check("POST sql SELECT -> 200", sel.status === 200, `got ${sel.status}: ${JSON.stringify(selBody).slice(0, 300)}`);
    check("sql SELECT returns columns + rows",
      Array.isArray(selBody?.columns) && selBody.columns.join(",") === "run_id,squad" &&
      Array.isArray(selBody.rows) && selBody.rows.length === 2 &&
      selBody.rows.some((r) => r[0] === "runPre" && r[1] === "alpha") &&
      selBody.rows.some((r) => r[0] === "runPost" && r[1] === "beta"),
      JSON.stringify(selBody).slice(0, 300));
    check("sql SELECT result carries rowCount + elapsedMs",
      selBody?.rowCount === 2 && typeof selBody?.elapsedMs === "number",
      JSON.stringify(selBody).slice(0, 200));

    const del = await fetch(`${BASE}/api/analysis/sql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sql: "DELETE FROM runs" }),
    });
    const delBody = await del.json().catch(() => null);
    check("POST sql DELETE -> 400 code rejected", del.status === 400 && delBody?.code === "rejected",
      `status ${del.status} body ${JSON.stringify(delBody)}`);

    const devTable = await fetch(`${BASE}/api/analysis/sql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sql: "SELECT decisionId, runId FROM decision_events ORDER BY eventId" }),
    });
    const devBody = await devTable.json().catch(() => null);
    check("POST sql decision_events extra table -> 200",
      devTable.status === 200 && Array.isArray(devBody?.rows) && devBody.rows.length === 1 &&
      devBody.rows[0][0] === "intake.triage_node" && devBody.rows[0][1] === "fixture-run-1",
      `status ${devTable.status} body ${JSON.stringify(devBody).slice(0, 300)}`);

    const badJson = await fetch(`${BASE}/api/analysis/sql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    const badJsonBody = await badJson.json().catch(() => null);
    check("POST invalid JSON -> 400 code bad_json", badJson.status === 400 && badJsonBody?.code === "bad_json",
      `status ${badJson.status} body ${JSON.stringify(badJsonBody)}`);

    const tooLarge = await fetch(`${BASE}/api/analysis/sql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sql: "SELECT 1", pad: "x".repeat(70 * 1024) }),
    });
    const tooLargeBody = await tooLarge.json().catch(() => null);
    check("POST over-64KB body -> 413 code too_large", tooLarge.status === 413 && tooLargeBody?.code === "too_large",
      `status ${tooLarge.status} body ${JSON.stringify(tooLargeBody).slice(0, 200)}`);

    const missingSql = await fetch(`${BASE}/api/analysis/sql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nosql: true }),
    });
    const missingSqlBody = await missingSql.json().catch(() => null);
    check("POST without sql -> 400 code rejected", missingSql.status === 400 && missingSqlBody?.code === "rejected",
      `status ${missingSql.status} body ${JSON.stringify(missingSqlBody)}`);

    // ── panels serve from the CACHE, not the store ───────────────────────

    // Insert an extra usage row DIRECTLY into the fixture STORE (the cache is
    // already built). The stale cache still serves: totals unchanged, and
    // the status route reports staleness — the UI contract for manual rebuild.
    {
      const db = openTelemetryDb(dbPath);
      try {
        db.prepare(`INSERT INTO usage_facts
          (usage_id, run_id, session_id, agent_key, model, observed_at,
           input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
           source_path, source_offset, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run("upExtra", "runPost", "sX", "_lead", "m1", "2026-09-24T10:45:00.000Z",
            10, 5, 0, 0, "/extra.jsonl", 10, "2026-09-24T10:45:00.000Z");
      } finally {
        db.close();
      }

      const costStale = await getJson("/api/analysis/cost?era=all");
      check("stale cache still serves: panel totals unchanged after a store insert",
        costStale.status === 200 && costStale.body?.data?.totals?.turns === 3,
        `status ${costStale.status} totals ${JSON.stringify(costStale.body?.data?.totals)}`);

      const st = await getJson("/api/analysis/cache");
      check("GET /api/analysis/cache -> 200, exists, stale:true after the store insert",
        st.status === 200 && st.body?.exists === true && st.body?.stale === true && st.body?.building === false,
        `status ${st.status} body ${JSON.stringify(st.body).slice(0, 300)}`);

      // The sql target split proves the same thing: "store" sees the new RAW
      // row immediately, "cache" (canonical_usage) does not until a rebuild.
      const rawRow = await fetch(`${BASE}/api/analysis/sql`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sql: "SELECT COUNT(*) FROM usage_facts WHERE usage_id = 'upExtra'", target: "store" }),
      });
      const rawRowBody = await rawRow.json().catch(() => null);
      check("sql target store sees the extra raw usage_facts row",
        rawRow.status === 200 && rawRowBody?.rows?.[0]?.[0] === 1,
        `status ${rawRow.status} body ${JSON.stringify(rawRowBody).slice(0, 300)}`);

      const canonRow = await fetch(`${BASE}/api/analysis/sql`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sql: "SELECT COUNT(*) FROM canonical_usage WHERE usage_id = 'upExtra'", target: "cache" }),
      });
      const canonRowBody = await canonRow.json().catch(() => null);
      check("sql target cache reads canonical_usage — extra row not there yet",
        canonRow.status === 200 && canonRowBody?.rows?.[0]?.[0] === 0,
        `status ${canonRow.status} body ${JSON.stringify(canonRowBody).slice(0, 300)}`);
    }

    // bad target → 400 rejected (never silently coerced to the default)
    {
      const bad = await fetch(`${BASE}/api/analysis/sql`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sql: "SELECT 1", target: "warehouse" }),
      });
      const badBody = await bad.json().catch(() => null);
      check("sql bad target -> 400 code rejected", bad.status === 400 && badBody?.code === "rejected",
        `status ${bad.status} body ${JSON.stringify(badBody)}`);
    }

    // ── POST /api/analysis/cache/rebuild ─────────────────────────────────

    // A cross-site Origin must not be able to drive builds (same CSRF
    // discipline as every other POST route).
    {
      const evil = await fetch(`${BASE}/api/analysis/cache/rebuild`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://evil.com" },
      });
      check("rebuild from non-allowed Origin -> 403", evil.status === 403,
        `status ${evil.status} body ${JSON.stringify(await evil.json().catch(() => null))}`);
    }

    // 409 while a build is in progress — deterministic without racing a real
    // build: write the cache's lock file ourselves. analysis-cache.mjs names
    // it <cachePath>.lock and validates JSON { pid, startedAt }; this test
    // process's own pid is alive, so the lock reads as live.
    {
      const lockPath = `${cacheFile}.lock`;
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), "utf8");
      try {
        const busy = await fetch(`${BASE}/api/analysis/cache/rebuild`, { method: "POST" });
        const busyBody = await busy.json().catch(() => null);
        check("rebuild while a live lock exists -> 409 code build_in_progress",
          busy.status === 409 && busyBody?.code === "build_in_progress",
          `status ${busy.status} body ${JSON.stringify(busyBody)}`);

        const stBusy = await getJson("/api/analysis/cache");
        check("cache status reports building:true while the lock is live",
          stBusy.body?.building === true, JSON.stringify(stBusy.body).slice(0, 200));
      } finally {
        rmSync(lockPath, { force: true });
      }
    }

    // 202 → the build child runs; poll the status route until it settles.
    // The fixture store is tiny so the build takes seconds, but the poll keeps
    // the same contract the dashboard UI would use (60 s ceiling).
    {
      const rb = await fetch(`${BASE}/api/analysis/cache/rebuild`, { method: "POST" });
      const rbBody = await rb.json().catch(() => null);
      check("POST /api/analysis/cache/rebuild -> 202 { started, startedAt }",
        rb.status === 202 && rbBody?.started === true && typeof rbBody?.startedAt === "string",
        `status ${rb.status} body ${JSON.stringify(rbBody)}`);

      let settled = null;
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const st = await getJson("/api/analysis/cache");
        if (st.body && st.body.building === false) { settled = st.body; break; }
        await new Promise((r) => setTimeout(r, 200));
      }
      check("rebuild child finishes within 60 s (building:false)",
        settled !== null, "still building after 60 s");
      check("rebuilt cache is fresh (stale:false) and lastBuild.ok",
        settled?.stale === false && settled?.lastBuild?.ok === true,
        JSON.stringify(settled).slice(0, 300));

      const costFresh = await getJson("/api/analysis/cost?era=all");
      check("panel includes the extra row after the rebuild",
        costFresh.status === 200 && costFresh.body?.data?.totals?.turns === 4,
        `status ${costFresh.status} totals ${JSON.stringify(costFresh.body?.data?.totals)}`);
    }

    // ── missing cache → 503 cache_building + auto-build ───────────────────

    // The server closes its SQLite handles per request, so deleting the cache
    // file from the test process is safe. The next panel read answers 503 and
    // (that being the only automatic build) starts a build child.
    {
      rmSync(cacheFile, { force: true });

      const miss = await getJson("/api/analysis/cost?era=all");
      check("panel with a missing cache -> 503 code cache_building",
        miss.status === 503 && miss.body?.code === "cache_building",
        `status ${miss.status} body ${JSON.stringify(miss.body)}`);

      let restored = false;
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        if (existsSync(cacheFile)) {
          const st = await getJson("/api/analysis/cache");
          if (st.body?.building === false && st.body?.stale === false) { restored = true; break; }
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      check("auto-build restores the missing cache within 60 s", restored,
        "cache still missing or building after 60 s");

      const costRestored = await getJson("/api/analysis/cost?era=all");
      check("panel serves again after the auto-build",
        costRestored.status === 200 && costRestored.body?.data?.totals?.turns === 4,
        `status ${costRestored.status} totals ${JSON.stringify(costRestored.body?.data?.totals)}`);
    }

    // ── build watchdog: a hung build child cannot stick building=true ──────
    //
    // Second server with a tiny watchdog timeout (LA_ANALYSIS_BUILD_TIMEOUT_MS)
    // and a test build command that hangs (LA_ANALYSIS_BUILD_CMD_TEST, a JSON
    // argv array honoured only under NODE_ENV === 'test'). The fake child is
    // `node -e "setTimeout(() => {}, 3000)"` so even a broken watchdog leaves
    // no stray process behind — it self-exits after 3 s.
    {
      const wPort = await new Promise((resolve, reject) => {
        const probe = createServer();
        probe.once("error", reject);
        probe.listen(0, "127.0.0.1", () => {
          const { port } = probe.address();
          probe.close(() => resolve(port));
        });
      });
      const WBASE = `http://127.0.0.1:${wPort}`;
      const wChild = spawn(process.execPath, [join(__dir, "telemetry-server.mjs")], {
        env: {
          ...process.env,
          NODE_ENV: "test",
          TELEMETRY_PORT: String(wPort),
          LA_TELEMETRY_DB: dbPath,
          LA_TELEMETRY_HOME: join(dir, "telemetry-home-w"),
          LA_STATE_ROOT: join(dir, "state-root-w"),
          LA_DECISION_RUNS_DIR: runsDir,
          LA_ANALYSIS_CACHE: join(dir, "watchdog-cache.sqlite"),
          LA_ANALYSIS_BUILD_TIMEOUT_MS: "400",
          LA_ANALYSIS_BUILD_CMD_TEST: JSON.stringify(["-e", "setTimeout(() => {}, 3000)"]),
        },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let wStderr = "";
      wChild.stderr.on("data", (chunk) => { wStderr += chunk; });
      try {
        let up = false;
        const wDeadline = Date.now() + 20_000;
        while (Date.now() < wDeadline) {
          if (wChild.exitCode !== null) throw new Error(`watchdog server exited early: ${wStderr.slice(-400)}`);
          try {
            const res = await fetch(`${WBASE}/api/telemetry/health`);
            if (res.ok) { up = true; break; }
          } catch { /* not up yet */ }
          await new Promise((r) => setTimeout(r, 200));
        }
        check("watchdog server starts", up, wStderr.slice(-400));
        if (up) {
          const rb = await fetch(`${WBASE}/api/analysis/cache/rebuild`, { method: "POST" });
          check("rebuild on the watchdog server -> 202", rb.status === 202, `got ${rb.status}`);

          let timedOut = null;
          const killDeadline = Date.now() + 15_000;
          while (Date.now() < killDeadline) {
            const st = await getJsonFrom(WBASE, "/api/analysis/cache");
            if (st.body && st.body.building === false &&
                st.body.lastBuild?.error === "build_timeout" && st.body.lastBuild?.ok === false) {
              timedOut = st.body.lastBuild;
              break;
            }
            await new Promise((r) => setTimeout(r, 100));
          }
          check("hung build child is watchdog-killed (lastBuild error build_timeout, ok false)",
            timedOut !== null, `lastBuild: ${JSON.stringify(timedOut)}`);
          check("watchdog records finishedAt and buildMs on the timeout",
            timedOut !== null && typeof timedOut.finishedAt === "string" && typeof timedOut.buildMs === "number",
            JSON.stringify(timedOut));

          // The regression this guards: building stuck at true → every
          // rebuild 409s until restart. After the watchdog it must be 202.
          const again = await fetch(`${WBASE}/api/analysis/cache/rebuild`, { method: "POST" });
          check("a rebuild after the watchdog timeout is accepted again (202, not 409)",
            again.status === 202, `got ${again.status}`);
        }
      } finally {
        if (wChild.exitCode === null) wChild.kill();
        await Promise.race([
          new Promise((r) => wChild.once("exit", r)),
          new Promise((r) => setTimeout(r, 5000)),
        ]);
      }
    }
  }
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([
    new Promise((r) => child.once("exit", r)),
    new Promise((r) => setTimeout(r, 5000)),
  ]);
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

console.log(`${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  FAIL: ${f}`).join("\n"));
  if (childStderr.trim()) console.log(`  server stderr (tail): ${childStderr.slice(-400)}`);
  process.exit(1);
}
