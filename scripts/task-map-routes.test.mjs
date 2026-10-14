// Route-level tests for the semantic task map's endpoints (P4 slice,
// implemented in task-map-routes.mjs).
//
// Unlike work-routes.test.mjs this does NOT spawn telemetry-server — the P4
// dispatch line there is the parent's wiring and this slice must not touch
// that file. Instead the handler runs behind a minimal harness that serves
// the SAME ctx shape telemetry-server passes (readJsonBody / respondBodyError
// / json / log / isLocalOrigin / isAllowedOrigin), with the map instance and
// the corpus loader INJECTED (the handler's own injection seam) — so no test
// touches the network, the real cache dir or the Linear API.
//
// The corpus block exercises work-routes.mjs's loadTaskMapCorpus over the
// TEST-ONLY fixture seam (NODE_ENV=test + FENIX_LINEAR_FAKE_FILE) and a tmp
// LA_SUPERVISOR_STATE_HOME / LA_DATA_HOME — the same isolation the other
// route tests use. Every seam is set here and left set (the static audit
// rejects unsetting them); the cost snapshot's child is never spawned (the
// cost report is injected).
//
// Proven here:
//   - GET /api/task-map forwards the stage/label filters to map.read and
//     NEVER touches build/neighbors (no embedding on a GET); the payload
//     carries the corpus/build/destination meta beside the read view;
//   - GET /api/task-map/status merges the map status with the job state and
//     the local destination;
//   - GET /api/task-map/neighbors: 400 without taskKey or with a bad limit,
//     404 unknown_task / no_embedding with the code, 200 passthrough;
//   - POST /api/task-map/build: write guards (403 foreign origin), the body
//     cap (413), malformed JSON (400), non-boolean rebuild and a bad
//     workspace (400); the happy path answers 202 { started } IMMEDIATELY
//     (the corpus loader has not even been called yet), a second POST while
//     the build runs answers 409 code build_in_progress with the SAME job,
//     and a failed job lands sanitized (no paths, unknown errors generic);
//   - no ctx.map / default map over the LA_DATA_HOME seam answers 503 when
//     the configuration is refused;
//   - loadTaskMapCorpus: board composition (touched + open Ready, deduped,
//     completed skipped), canonical taskKey via resolveTaskKey only, failed
//     issues counted unavailable (no fake identity), labels/cost/duration
//     preserved, the 200 cap with an explicit warning.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { handleTaskMapRoute, resetTaskMapRoutesState, taskMapDefaultConfig } from "./task-map-routes.mjs";
import { loadTaskMapCorpus, resetWorkRoutesState } from "./work-routes.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) { passed++; return; }
  failed++;
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

// ── the env seams (set here, left set) ───────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), "task-map-routes-"));
const dataHomeDir = join(dir, "data");
const supState = join(dir, "sup-state");

process.env.NODE_ENV = "test";
process.env.LA_DATA_HOME = dataHomeDir;
process.env.LA_SUPERVISOR_STATE_HOME = supState;
process.env.LA_STATE_ROOT = join(dir, "state-root");
process.env.LA_TELEMETRY_DB = join(dir, "telemetry.sqlite");
process.env.LA_TELEMETRY_HOME = join(dir, "telemetry-home");
process.env.LA_SQUAD_HOME = join(dir, "agents");

// The default map's cache must land under the tmp data home, never the real one.
{
  const cfg = taskMapDefaultConfig();
  check("default config cacheDir is under LA_DATA_HOME",
    cfg.cacheDir === join(dataHomeDir, "task-map"), cfg.cacheDir);
  check("default config embedding is the local Ollama default",
    cfg.embedding.baseUrl === "http://ollama:11434" && cfg.embedding.model === "embeddinggemma:latest",
    JSON.stringify(cfg.embedding));
  const prev = process.env.FENIX_EMBEDDING_BASE_URL;
  try {
    process.env.FENIX_EMBEDDING_BASE_URL = "http://ollama:11434";
    const overridden = taskMapDefaultConfig();
    check("FENIX_EMBEDDING_* overrides the base URL", overridden.embedding.baseUrl === "http://ollama:11434",
      JSON.stringify(overridden.embedding));
  } finally {
    if (prev === undefined) delete process.env.FENIX_EMBEDDING_BASE_URL;
    else process.env.FENIX_EMBEDDING_BASE_URL = prev;
  }
}

// ── the harness: the SAME ctx shape telemetry-server passes ──────────────────

function harnessJson(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

function harnessReadJsonBody(req, maxBytes = 8192) {
  // A faithful copy of telemetry-server's readJsonBody: over the limit it
  // keeps DRAINING (never req.destroy() — that RSTs the socket before the
  // handler's 413 can be read, so no client would ever see the status).
  return new Promise((resolve, reject) => {
    let data = "";
    let settled = false;
    req.on("data", (c) => {
      if (settled) return; // over limit: keep draining, stop buffering
      data += c;
      if (data.length > maxBytes) {
        settled = true;
        data = "";
        const err = new Error(`body too large (>${Math.round(maxBytes / 1024)}KB)`);
        err.tooLarge = true;
        reject(err);
      }
    });
    req.on("end", () => {
      if (settled) return;
      if (!data) { resolve({}); return; }
      try { resolve(JSON.parse(data)); } catch (err) { reject(err); }
    });
    req.on("error", reject);
  });
}

const isLoopback = (ra) => ra === "127.0.0.1" || ra === "::1" || ra === "::ffff:127.0.0.1";
const isLoopbackOrigin = (o) => typeof o === "string" && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(o);

function startServer(ctx) {
  const server = createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url, "http://127.0.0.1"); } catch { url = new URL("/bad", "http://127.0.0.1"); }
    const handled = await handleTaskMapRoute(req, res, url, ctx).catch((err) => {
      harnessJson(res, 500, { error: `harness: ${err?.message ?? err}` });
      return true;
    });
    if (!handled) harnessJson(res, 404, { error: "not a task-map route" });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })));
}

async function call(port, method, path, { origin = "http://localhost:5173", body } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(origin ? { origin } : {}),
    },
    body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body)),
  });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the fake map: records, never networks ─────────────────────────────────────

function fakeMap({ neighborsImpl } = {}) {
  const calls = { read: [], neighbors: [], build: [], statusCount: 0 };
  return {
    calls,
    read(args) { calls.read.push(args ?? {}); return fakeReadView(); },
    neighbors(taskKey, opts) {
      calls.neighbors.push({ taskKey, opts });
      if (neighborsImpl) return neighborsImpl(taskKey, opts);
      return { taskKey, neighbors: [{ taskKey: "jointhubs:WORK-2", taskId: "WORK-2", title: "Other", similarity: 0.42 }] };
    },
    status() {
      calls.statusCount++;
      return {
        running: false,
        counts: { pending: 0, ready: 2, error: 0, omitted: 0 },
        embedding: { model: "embeddinggemma:latest", revision: "embeddinggemma:latest", contractVersion: "task-map/1" },
        lastBuild: null,
        projection: { available: false, reason: "not_built" },
      };
    },
    build(tasks, opts) {
      calls.build.push({ count: Array.isArray(tasks) ? tasks.length : -1, opts: opts ?? {} });
      return (this._deferred ?? Promise.resolve({ built: true, counts: { pending: 0, ready: 2, error: 0, omitted: 0 }, projectionVersion: 3 }));
    },
  };
}

const fakeReadView = () => ({
  points: [{
    taskKey: "jointhubs:WORK-1", taskId: "WORK-1", title: "Fix the widget",
    stage: "dev", labels: ["bug"], costUsd: 1.5, durationMs: 7_200_000, x: 0.25, y: -0.5,
  }],
  unembedded: [{ taskKey: "jointhubs:WORK-3", reason: "not_embedded" }],
  projection: { available: true, version: 3, kind: "umap", params: { seed: 42 }, libraryVersions: {}, model: "embeddinggemma:latest", revision: "embeddinggemma:latest", dims: 768, fittedAt: "2026-10-13T12:00:00.000Z" },
  status: { counts: { pending: 0, ready: 2, error: 0, omitted: 0 }, lastBuild: { startedAt: "2026-10-13T12:00:00.000Z", finishedAt: "2026-10-13T12:01:00.000Z" } },
});

const fakeCorpus = (overrides = {}) => async (args) => ({
  workspace: args?.workspace ?? "jointhubs",
  tasks: [{ taskKey: "jointhubs:WORK-1", taskId: "WORK-1", title: "Fix the widget", description: "Fix it", stage: "dev", labels: ["bug"], costUsd: 1.5, durationMs: 7_200_000 }],
  unavailable: [{ taskId: "WORK-9", reason: "linear_unavailable" }],
  requested: 2,
  cap: 200,
  truncated: false,
  warning: null,
  ...overrides,
});

// ── the route blocks ──────────────────────────────────────────────────────────

{
  const map = fakeMap();
  let corpusCalls = 0;
  // The corpus load stays PENDING until the test releases it, and the build
  // stays PENDING until released too — "202 before the work" and the
  // single-flight 409 then have no race to lose.
  let releaseBuild = () => {};
  const buildGate = new Promise((resolve) => { releaseBuild = resolve; });
  map._deferred = buildGate;
  let releaseCorpus = () => {};
  const corpusGate = new Promise((resolve) => { releaseCorpus = resolve; });
  const ctxBase = {
    readJsonBody: harnessReadJsonBody,
    respondBodyError: (res, err) => {
      const status = err?.tooLarge ? 413 : 400;
      harnessJson(res, status, { error: err?.tooLarge ? err.message : "invalid JSON body: " + err.message });
      return status;
    },
    json: harnessJson,
    log: () => {},
    isLocalOrigin: isLoopback,
    isAllowedOrigin: isLoopbackOrigin,
    map,
    loadTaskMapCorpus: (args) => { corpusCalls++; return corpusGate.then(() => fakeCorpus()(args)); },
  };

  const { server, port } = await startServer(ctxBase);
  try {
    // GET /api/task-map forwards the filters and never builds.
    const view = await call(port, "GET", "/api/task-map?stage=dev&label=bug");
    check("GET /api/task-map -> 200", view.status === 200, `got ${view.status}`);
    check("GET forwards stage and label to read", JSON.stringify(map.calls.read) === '[{"stage":"dev","label":"bug"}]',
      JSON.stringify(map.calls.read));
    check("GET never calls build or neighbors", map.calls.build.length === 0 && map.calls.neighbors.length === 0,
      JSON.stringify({ b: map.calls.build.length, n: map.calls.neighbors.length }));
    check("GET payload keeps the read view verbatim",
      view.body?.points?.[0]?.taskKey === "jointhubs:WORK-1" && Array.isArray(view.body?.unembedded)
        && view.body?.projection?.version === 3,
      JSON.stringify(view.body).slice(0, 200));
    check("GET payload carries corpus/build/destination meta",
      "corpus" in view.body && "build" in view.body && "destination" in view.body,
      Object.keys(view.body ?? {}).join(","));

    const unfiltered = await call(port, "GET", "/api/task-map");
    check("GET without filters -> read({stage:null,label:null})",
      unfiltered.status === 200 && JSON.stringify(map.calls.read.at(-1)) === '{"stage":null,"label":null}',
      JSON.stringify(map.calls.read.at(-1)));

    // GET /api/task-map/status — status plus job/destination.
    const status = await call(port, "GET", "/api/task-map/status");
    check("GET /status -> 200 with counts and embedding identity",
      status.status === 200 && status.body?.counts?.ready === 2 && status.body?.embedding?.model === "embeddinggemma:latest",
      JSON.stringify(status.body).slice(0, 200));
    check("GET /status carries build and destination keys",
      "build" in status.body && "destination" in status.body && "corpus" in status.body,
      Object.keys(status.body ?? {}).join(","));

    // GET /api/task-map/neighbors.
    const noKey = await call(port, "GET", "/api/task-map/neighbors");
    check("neighbors without taskKey -> 400", noKey.status === 400, `got ${noKey.status}`);
    const badLimit = await call(port, "GET", "/api/task-map/neighbors?taskKey=jointhubs%3AWORK-1&limit=99");
    check("neighbors limit out of range -> 400", badLimit.status === 400, `got ${badLimit.status}`);
    const ok = await call(port, "GET", "/api/task-map/neighbors?taskKey=jointhubs%3AWORK-1");
    check("neighbors -> 200 passthrough",
      ok.status === 200 && ok.body?.neighbors?.[0]?.similarity === 0.42
        && map.calls.neighbors.at(-1)?.opts?.limit === 5,
      JSON.stringify(ok.body));
    const okLimit = await call(port, "GET", "/api/task-map/neighbors?taskKey=jointhubs%3AWORK-1&limit=3");
    check("neighbors limit forwarded", map.calls.neighbors.at(-1)?.opts?.limit === 3, JSON.stringify(map.calls.neighbors.at(-1)));
    map.calls.neighbors.length = 0;

    // POST /api/task-map/build — the guards first.
    const foreign = await call(port, "POST", "/api/task-map/build", {
      origin: "https://evil.example", body: { rebuild: false },
    });
    check("build foreign origin -> 403", foreign.status === 403, `got ${foreign.status}`);
    const oversized = await call(port, "POST", "/api/task-map/build", { body: "x".repeat(17 * 1024) });
    check("build oversized body -> 413", oversized.status === 413, `got ${oversized.status}`);
    const malformed = await call(port, "POST", "/api/task-map/build", { body: "{not json" });
    check("build malformed JSON -> 400", malformed.status === 400, `got ${malformed.status}`);
    const badRebuild = await call(port, "POST", "/api/task-map/build", { body: { rebuild: "yes" } });
    check("build non-boolean rebuild -> 400", badRebuild.status === 400, JSON.stringify(badRebuild.body));
    const badWorkspace = await call(port, "POST", "/api/task-map/build", { body: { workspace: 5 } });
    check("build non-string workspace -> 400", badWorkspace.status === 400, JSON.stringify(badWorkspace.body));
    check("the guarded builds never started a job or corpus load",
      corpusCalls === 0 && map.calls.build.length === 0,
      JSON.stringify({ corpusCalls, builds: map.calls.build.length }));

    // The happy path: 202 immediately, corpus + build in the background.
    const started = await call(port, "POST", "/api/task-map/build", { body: { workspace: "jointhubs", rebuild: false } });
    check("build -> 202 started immediately", started.status === 202 && started.body?.started === true
      && started.body?.workspace === "jointhubs" && started.body?.rebuild === false,
      JSON.stringify(started.body));
    // The corpus load is parked on its gate, so the background job CANNOT
    // have reached build yet — deterministically, the 202 beat the work.
    check("202 answers while the corpus is still loading (build not reached)",
      map.calls.build.length === 0, `builds=${map.calls.build.length}`);

    const dupe = await call(port, "POST", "/api/task-map/build", { body: {} });
    check("second POST while running -> 409 build_in_progress with the SAME job",
      dupe.status === 409 && dupe.body?.code === "build_in_progress" && dupe.body?.job?.state === "running"
        && dupe.body?.job?.workspace === "jointhubs",
      JSON.stringify(dupe.body));

    // Release the corpus, then the build (with its result payload).
    releaseCorpus();
    for (let i = 0; i < 100 && map.calls.build.length === 0; i++) await sleep(20);
    check("the background job loaded the corpus and called build once",
      corpusCalls === 1 && map.calls.build.length === 1 && map.calls.build[0].count === 1
        && map.calls.build[0].opts.rebuild === false,
      JSON.stringify(map.calls.build));
    releaseBuild({
      built: true,
      counts: { pending: 0, ready: 2, error: 0, omitted: 0 },
      projectionVersion: 3,
    });
    let st1 = null;
    for (let i = 0; i < 100; i++) {
      await sleep(20);
      st1 = await call(port, "GET", "/api/task-map/status");
      if (st1.body?.build?.state === "done") break;
    }
    check("status after the job -> done with counts and projectionVersion",
      st1.body?.build?.state === "done" && st1.body?.build?.counts?.ready === 2 && st1.body?.build?.projectionVersion === 3,
      JSON.stringify(st1.body?.build));
    check("the corpus meta is recorded (2 requested, 1 included, 1 unavailable)",
      st1.body?.corpus?.requested === 2 && st1.body?.corpus?.included === 1 && st1.body?.corpus?.unavailable === 1,
      JSON.stringify(st1.body?.corpus));

    // A failing corpus loader -> a SANITIZED job error; the retry (after the
    // failed job freed the single-flight) succeeds — the loader fails ONCE.
    const map2 = fakeMap();
    let failOnce = true;
    const ctx2 = {
      ...ctxBase,
      map: map2,
      loadTaskMapCorpus: async () => {
        if (failOnce) { failOnce = false; throw new Error(`boom at C:\\Users\\secret\\x`); }
        return fakeCorpus()({});
      },
    };
    const { server: s2, port: p2 } = await startServer(ctx2);
    try {
      const r = await call(p2, "POST", "/api/task-map/build", { body: {} });
      check("failing corpus -> still 202 (the job owns the failure)", r.status === 202, `got ${r.status}`);
      for (let i = 0; i < 100 && (await call(p2, "GET", "/api/task-map/status")).body?.build?.state !== "error"; i++) await sleep(20);
      const st2 = await call(p2, "GET", "/api/task-map/status");
      check("failing corpus -> job error with the GENERIC message (no path leaks)",
        st2.body?.build?.error?.code === "build_failed"
        && st2.body?.build?.error?.message === "the task-map operation failed (details in the server log)"
        && !JSON.stringify(st2.body).includes("secret"),
        JSON.stringify(st2.body?.build?.error));
      check("a failed job frees the single-flight (a new build may start)",
        (await call(p2, "POST", "/api/task-map/build", { body: {} })).status === 202);
      for (let i = 0; i < 100 && map2.calls.build.length === 0; i++) await sleep(20);
      check("the retried job reaches build", map2.calls.build.length === 1, JSON.stringify(map2.calls.build.length));
    } finally { s2.close(); }

    // A KNOWN coded error keeps its code and sanitized message.
    const map3 = fakeMap();
    const codedErr = new Error("the embedding endpoint is unreachable");
    codedErr.code = "embed_failed";
    const ctx3 = { ...ctxBase, map: map3, loadTaskMapCorpus: async () => { throw codedErr; } };
    const { server: s3, port: p3 } = await startServer(ctx3);
    try {
      await call(p3, "POST", "/api/task-map/build", { body: {} });
      for (let i = 0; i < 100 && (await call(p3, "GET", "/api/task-map/status")).body?.build?.state !== "error"; i++) await sleep(20);
      const st3 = await call(p3, "GET", "/api/task-map/status");
      check("a known code passes through with its sanitized message",
        st3.body?.build?.error?.code === "embed_failed" && st3.body?.build?.error?.message === "the embedding endpoint is unreachable",
        JSON.stringify(st3.body?.build?.error));
    } finally { s3.close(); }

    // neighbors error mapping.
    const map4 = fakeMap({
      neighborsImpl: (taskKey) => {
        const err = new Error(`no such task in the last build: ${taskKey}`);
        err.code = taskKey === "jointhubs:NOVEC" ? "no_embedding" : "unknown_task";
        throw err;
      },
    });
    const ctx4 = { ...ctxBase, map: map4 };
    const { server: s4, port: p4 } = await startServer(ctx4);
    try {
      const unknown = await call(p4, "GET", "/api/task-map/neighbors?taskKey=jointhubs%3ANOTHING");
      check("neighbors unknown task -> 404 with the code",
        unknown.status === 404 && unknown.body?.code === "unknown_task", JSON.stringify(unknown.body));
      const novec = await call(p4, "GET", "/api/task-map/neighbors?taskKey=jointhubs%3ANOVEC");
      check("neighbors without a vector -> 404 with the code",
        novec.status === 404 && novec.body?.code === "no_embedding", JSON.stringify(novec.body));
    } finally { s4.close(); }
  } finally { server.close(); }
}

// ── no ctx.map: the lazily built default (over the tmp LA_DATA_HOME) ─────────

{
  resetTaskMapRoutesState();
  const ctx = {
    readJsonBody: harnessReadJsonBody,
    respondBodyError: (res, err) => { harnessJson(res, err?.tooLarge ? 413 : 400, { error: err?.message ?? "bad body" }); return 400; },
    json: harnessJson,
    log: () => {},
    isLocalOrigin: isLoopback,
    isAllowedOrigin: isLoopbackOrigin,
    // no map, no loadTaskMapCorpus, no linearQueue — the default map serves
    // reads; a build would fail honestly in the job state.
  };
  const { server, port } = await startServer(ctx);
  try {
    const view = await call(port, "GET", "/api/task-map");
    check("GET without ctx.map -> the default map serves an empty view",
      view.status === 200 && Array.isArray(view.body?.points) && view.body?.points.length === 0
        && view.body?.destination?.cacheDir === join(dataHomeDir, "task-map"),
      JSON.stringify(view.body?.destination) + ` status=${view.status}`);
    const refused = await call(port, "POST", "/api/task-map/build", { body: {} });
    check("POST without a corpus source -> 202, the job records the failure",
      refused.status === 202);
    for (let i = 0; i < 100 && (await call(port, "GET", "/api/task-map/status")).body?.build?.state !== "error"; i++) await sleep(20);
    const st = await call(port, "GET", "/api/task-map/status");
    check("the corpus-less job fails with a sanitized error",
      st.body?.build?.state === "error" && typeof st.body?.build?.error?.message === "string"
        && !JSON.stringify(st.body?.build?.error).includes(dataHomeDir),
      JSON.stringify(st.body?.build?.error));
  } finally {
    server.close();
    resetTaskMapRoutesState();
  }
}

// ── loadTaskMapCorpus (work-routes.mjs) over the fixture seams ────────────────

{
  const linearFixturePath = join(dir, "linear-fake.json");
  writeFileSync(linearFixturePath, JSON.stringify({
    queue: { tasks: [], error: null, fetchedAt: "2026-10-13T12:00:00.000Z" },
    issues: {
      "WORK-1": {
        identifier: "WORK-1", title: "Fix the widget", url: "https://linear.app/jointhubs/issue/WORK-1",
        description: "Please fix the widget.\nAcceptance: it compiles.",
        state: { name: "In Progress", type: "started" },
      },
      "WORK-3": {
        identifier: "WORK-3", title: "Ready ticket", url: "https://linear.app/jointhubs/issue/WORK-3",
        description: "Ready to start.",
        state: { name: "Todo", type: "unstarted" },
      },
      "BAD ID": {
        identifier: "BAD ID", title: "Broken identity", url: null,
        description: "space in the identifier", state: { name: "Todo", type: "unstarted" },
      },
    },
  }), "utf8");
  process.env.FENIX_LINEAR_FAKE_FILE = linearFixturePath;

  // One touched ticket: WORK-1, one dev child with two 1 h turns.
  mkdirSync(join(supState, "run-a"), { recursive: true });
  writeFileSync(join(supState, "run-a", "children.json"), JSON.stringify({
    runId: "run-a",
    children: {
      "dev-1": {
        childId: "dev-1", squad: "dev", taskId: "WORK-1", status: "exited",
        sessionId: "sess-1", telemetryRunId: null, worktree: null,
        costUsd: 0.5, model: "m1",
        turns: [
          { startedAt: "2026-10-13T08:00:00.000Z", endedAt: "2026-10-13T09:00:00.000Z", exitCode: 0 },
          { startedAt: "2026-10-13T10:00:00.000Z", endedAt: "2026-10-13T11:00:00.000Z", exitCode: 0 },
        ],
      },
    },
    rounds: {},
  }), "utf8");

  const costReport = { tickets: [{ taskId: "WORK-1", childrenUsd: 1, supervisorUsd: 0.5, totalUsd: 1.5 }] };
  const queue = (tasks) => async () => ({ tasks, error: null, fetchedAt: "2026-10-13T12:00:00.000Z" });
  const readyItem = (identifier, extra = {}) => ({
    identifier, title: identifier, url: null, team: "FEN", state: "Todo", stateType: "unstarted",
    priority: 0, estimate: 0, updatedAt: "2026-10-13T12:00:00.000Z", assignee: null,
    labels: [], parent: null, suggestedSquad: "dev", ...extra,
  });

  const statesWithLabels = async () => ({
    states: {
      "WORK-1": { name: "In Progress", type: "started", labels: [{ id: "l1", name: "bug", color: null }] },
    },
    error: null,
    fetchedAt: "2026-10-13T12:00:00.000Z",
  });

  try {
    resetWorkRoutesState();

    // Composition: the touched ticket + the open Ready item, deduped.
    const corpus = await loadTaskMapCorpus({
      linearQueue: queue([readyItem("WORK-1"), readyItem("WORK-3"), readyItem("WORK-DONE", { stateType: "completed" })]),
      costReport,
    });
    check("corpus: touched + open Ready, deduped, completed skipped",
      corpus.workspace === "jointhubs"
      && JSON.stringify(corpus.tasks.map((t) => t.taskId)) === '["WORK-1","WORK-3"]',
      JSON.stringify(corpus.tasks.map((t) => t.taskId)));
    check("corpus: canonical taskKey via the Start identity resolver",
      corpus.tasks[0].taskKey === "jointhubs:WORK-1" && corpus.tasks[1].taskKey === "jointhubs:WORK-3",
      JSON.stringify(corpus.tasks.map((t) => t.taskKey)));
    check("corpus: WORK-1 stage dev from the child squad, WORK-3 ready",
      corpus.tasks[0].stage === "dev" && corpus.tasks[1].stage === "ready",
      JSON.stringify(corpus.tasks.map((t) => t.stage)));
    check("corpus: title and description come from the fetched issue",
      corpus.tasks[0].title === "Fix the widget" && corpus.tasks[0].description.includes("fix the widget"),
      JSON.stringify(corpus.tasks[0]).slice(0, 200));
    // The fixture's states lookup carries no labels (production's
    // fetchLinearStates does) — unknown stays an EMPTY list, never invented;
    // label preservation itself is proven by the injected statesLookup below.
    check("corpus: unknown labels stay empty, never invented",
      JSON.stringify(corpus.tasks[0].labels) === '[]', JSON.stringify(corpus.tasks[0].labels));
    check("corpus: cost from the injected report, unknown stays null",
      corpus.tasks[0].costUsd === 1.5 && corpus.tasks[1].costUsd === null,
      JSON.stringify(corpus.tasks.map((t) => t.costUsd)));
    check("corpus: duration is the summed child turn time (2 h)",
      corpus.tasks[0].durationMs === 7_200_000 && corpus.tasks[1].durationMs === null,
      JSON.stringify(corpus.tasks.map((t) => t.durationMs)));
    check("corpus: nothing truncated at the default cap",
      corpus.requested === 2 && corpus.truncated === false && corpus.warning === null,
      JSON.stringify({ requested: corpus.requested, truncated: corpus.truncated }));

    // A queue id the fixture cannot fetch -> unavailable, no fake identity.
    // WORK-1 stays touched (the facts cache spans these calls) and keeps its
    // point; only the NEW unresolvable id is dropped.
    const withMissing = await loadTaskMapCorpus({
      linearQueue: queue([readyItem("WORK-9")]),
      costReport,
    });
    check("corpus: a failed fetch is counted unavailable, never a point",
      JSON.stringify(withMissing.tasks.map((t) => t.taskId)) === '["WORK-1"]'
      && JSON.stringify(withMissing.unavailable) === '[{"taskId":"WORK-9","reason":"linear_unavailable"}]',
      JSON.stringify({ tasks: withMissing.tasks.map((t) => t.taskId), unavailable: withMissing.unavailable }));

    // An identifier resolveTaskKey refuses -> unavailable, not faked.
    const withBad = await loadTaskMapCorpus({
      linearQueue: queue([readyItem("BAD ID")]),
      costReport,
    });
    check("corpus: a non-canonical identifier never invents an identity",
      withBad.tasks.length === 1 && withBad.unavailable[0]?.reason === "no_canonical_identity",
      JSON.stringify({ tasks: withBad.tasks.map((t) => t.taskId), unavailable: withBad.unavailable }));

    // The cap: explicit truncation + warning (requested counts the touched
    // ticket too).
    const capped = await loadTaskMapCorpus({
      linearQueue: queue([readyItem("WORK-3"), readyItem("WORK-9"), readyItem("WORK-10")]),
      cap: 2,
      costReport,
    });
    check("corpus: over the cap -> truncated with an explicit warning",
      capped.truncated === true && capped.tasks.length === 2 && capped.tasks[0].taskId === "WORK-1"
        && typeof capped.warning === "string" && capped.warning.includes("capped at 2 of 4"),
      JSON.stringify(capped.warning));

    // The injected states lookup wins over the fixture (label preservation
    // does not depend on the fixture's shape).
    const withStates = await loadTaskMapCorpus({
      linearQueue: queue([]),
      costReport,
      statesLookup: statesWithLabels,
    });
    check("corpus: an injected states lookup feeds the labels",
      JSON.stringify(withStates.tasks[0]?.labels) === '["bug"]',
      JSON.stringify(withStates.tasks[0]?.labels));

    // No linearQueue -> an honest refusal, never an empty corpus.
    await loadTaskMapCorpus({}).then(
      () => check("corpus: missing linearQueue -> throws", false, "resolved"),
      (err) => check("corpus: missing linearQueue -> throws", /linearQueue/.test(String(err?.message)), String(err?.message)),
    );
  } catch (err) {
    failed++;
    failures.push(`corpus block — ${err?.stack || err}`);
  } finally {
    delete process.env.FENIX_LINEAR_FAKE_FILE;
    resetWorkRoutesState();
  }
}

// ── report ───────────────────────────────────────────────────────────────────

console.log(`\ntask-map-routes: ${passed} passed, ${failed} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
rmSync(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
