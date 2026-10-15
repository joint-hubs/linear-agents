// scripts/task-map-routes.mjs — the semantic task map's routes (P4 slice).
//
// TRANSPORT ONLY, in the style of work-routes.mjs: the guard order, the body
// handling and the error shape mirror the Work board's routes (writeGuards
// first on the POST, then the body). Everything served is derived in
// libraries — scripts/task-map.mjs (createTaskMap: build/read/neighbors/
// status, embedding cache, projection registry) and work-routes.mjs's
// loadTaskMapCorpus (the board-composed, Linear-identified corpus) — this
// layer only guards, parses, maps statuses and tracks the background job.
//
// The routes:
//
//   GET  /api/task-map?stage=&label=   the filtered read view — NEVER embeds,
//                                      NEVER triggers a build, returns points
//                                      without vectors or descriptions;
//   GET  /api/task-map/status          the cheap status/progress poll (the
//                                      map's own status plus the background
//                                      job state and the local destination);
//   GET  /api/task-map/neighbors?taskKey=&limit=
//                                      nearest neighbours on the ORIGINAL
//                                      vectors (cosine) for one task;
//   POST /api/task-map/build           { workspace?, rebuild? } — the write
//                                      guards (same-origin loopback + the
//                                      Cockpit's 16 KB body cap), then 202
//                                      { started } IMMEDIATELY; the corpus
//                                      load and the embedding build run in a
//                                      background promise, surfaced through
//                                      /status and the map payload.
//
// Single-flight is enforced at the JOB level: a POST while a build is
// running answers 409 { code: "build_in_progress", job } — the truth about
// the SAME job, never a second one. (The map instance additionally
// single-flights its own build promise and holds a cross-process lockfile;
// a racing second process surfaces as a sanitized job error, not a crash.)
//
// Injection: the handler takes the map instance and the corpus loader from
// ctx (ctx.map, ctx.loadTaskMapCorpus) — telemetry-server wires the defaults
// (createDefaultTaskMap() and work-routes' loadTaskMapCorpus with its shared
// linearQueue); tests inject both, so no test touches the network, the real
// cache dir or the Linear API. Embedding stays LOCAL ONLY by the core's own
// guard (isEmbeddingHostAllowed refuses public remotes at construction);
// FENIX_EMBEDDING_BASE_URL / _MODEL / _REVISION override the local Ollama
// defaults and can never point the embedder at a public host.

import { join } from "node:path";

import { writeGuards } from "./cockpit-routes.mjs";
import { dataHome } from "./fenix-paths.mjs";
import { DEFAULT_EMBEDDING, createTaskMap } from "./task-map.mjs";
import { loadTaskMapCorpus } from "./work-routes.mjs";

// The build POST's body: { workspace?, rebuild? } is a control payload, not a
// document — the same 16 KB cap the Cockpit chat and the Start POST apply.
export const TASK_MAP_BODY_CAP = 16 * 1024;

// ── the default map (parent wiring; tests inject ctx.map instead) ───────────

/**
 * The default map configuration: the cache OUTSIDE the repo under
 * <dataHome>/task-map and the LOCAL Ollama embedder (embeddinggemma:latest at
 * http://ollama:11434). FENIX_EMBEDDING_BASE_URL / _MODEL / _REVISION
 * override those three fields — local only is then enforced by the core's
 * own host guard, which refuses a public remote at construction.
 */
export function taskMapDefaultConfig(env = process.env, platform = process.platform) {
  return {
    cacheDir: join(dataHome(env, platform), "task-map"),
    embedding: {
      baseUrl: env.FENIX_EMBEDDING_BASE_URL || DEFAULT_EMBEDDING.baseUrl,
      model: env.FENIX_EMBEDDING_MODEL || DEFAULT_EMBEDDING.model,
      ...(env.FENIX_EMBEDDING_REVISION ? { revision: env.FENIX_EMBEDDING_REVISION } : {}),
    },
  };
}

let defaultMap = null;
let defaultMapError = null; // sanitized, from the last failed construction
let defaultDestination = null; // { cacheDir, embedding } — where the cache lives

/** The default map instance, built lazily on first use; null when the
 * configuration was refused (the sanitized error rides in the 503s). */
export function createDefaultTaskMap(env = process.env, platform = process.platform) {
  if (defaultMap || defaultMapError) return defaultMap;
  try {
    const config = taskMapDefaultConfig(env, platform);
    defaultMap = createTaskMap(config);
    defaultDestination = {
      cacheDir: config.cacheDir,
      embedding: { model: config.embedding.model, revision: config.embedding.revision ?? config.embedding.model },
    };
  } catch (err) {
    defaultMapError = sanitizeError(err);
    console.error("[task-map] the default map configuration was refused:", err?.code ?? "", err?.message ?? err);
  }
  return defaultMap;
}

/** Test seam: forget the lazily built default map, job and corpus state. */
export function resetTaskMapRoutesState() {
  defaultMap = null;
  defaultMapError = null;
  defaultDestination = null;
  lastJob = null;
  lastCorpus = null;
}

// ── the background job state (module-level, one build at a time) ─────────────

let lastJob = null; // the public job shape, or null before the first build
let lastCorpus = null; // the last corpus composition the job loaded

/** Error surfaces are SANITIZED: no paths, no credentials, no raw network
 * text. Known coded errors keep their (already sanitized) core message; an
 * unknown error is summarized to a fixed message — its details go to the
 * server log only. */
const KNOWN_CODES = new Set([
  "build_in_progress",
  "invalid_tasks",
  "invalid_options",
  "cache_inside_repo",
  "remote_embedding_disabled",
  "embed_failed",
  "projection_unavailable",
  "projection_failed",
]);

export function sanitizeError(err) {
  const code = err?.code && KNOWN_CODES.has(err.code) ? err.code : "build_failed";
  if (code === "build_failed") {
    return { code, message: "the task-map operation failed (details in the server log)" };
  }
  // Defence in depth: even a known code's message gets a path scrub.
  const scrubbed = String(err?.message ?? "")
    .replace(/[A-Za-z]:\\[^\s"']*/g, "[path]")
    .replace(/\/(?:home|Users|data|tmp|var|root|fenix)\/[^\s"']*/g, "[path]");
  return { code, message: scrubbed || "the task-map operation failed" };
}

function publicJob() {
  return lastJob ? { ...lastJob } : null;
}

function publicCorpus() {
  return lastCorpus ? { ...lastCorpus } : null;
}

/** The background build: corpus first (Linear reads, bounded), then the map
 * build (embeddings + projection). Never runs on the response path — the
 * POST already answered 202. One failure lands in the job state, sanitized. */
async function runBuildJob({ map, corpusLoader, workspace, rebuild }) {
  await new Promise((resolve) => setImmediate(resolve)); // off the response path
  try {
    const corpus = await corpusLoader({ workspace: workspace ?? undefined });
    lastCorpus = {
      workspace: corpus.workspace,
      requested: corpus.requested,
      included: Array.isArray(corpus.tasks) ? corpus.tasks.length : 0,
      unavailable: Array.isArray(corpus.unavailable) ? corpus.unavailable.length : 0,
      cap: corpus.cap ?? null,
      truncated: corpus.truncated === true,
      warning: corpus.warning ?? null,
      at: new Date().toISOString(),
    };
    const result = await map.build(corpus.tasks, { rebuild: rebuild === true });
    lastJob = {
      ...lastJob,
      state: "done",
      finishedAt: new Date().toISOString(),
      counts: result?.counts ?? null,
      projectionVersion: result?.projectionVersion ?? null,
    };
  } catch (err) {
    console.error("[task-map] build failed:", err?.code ?? "", err?.message ?? err);
    lastJob = {
      ...lastJob,
      state: "error",
      finishedAt: new Date().toISOString(),
      error: sanitizeError(err),
    };
  }
}

/** The map instance for this request: ctx.map wins (the wiring's injection
 * seam, what the tests use); otherwise the lazily built default. */
function resolveMap(ctx) {
  if (ctx.map) return ctx.map;
  return createDefaultTaskMap();
}

/** The destination shown in the UI ("where the cache lives"): the default
 * map knows its own config; a wired parent can inject ctx.mapDestination. */
function destinationOf(ctx) {
  if (ctx.mapDestination) return ctx.mapDestination;
  if (!ctx.map) {
    createDefaultTaskMap(); // records defaultDestination on success
    if (defaultDestination) return defaultDestination;
  }
  return null;
}

/** A bad percent-encoding or missing value is a clean 400, not a throw. */
function queryParam(url, name) {
  const raw = url.searchParams.get(name);
  return raw === null || raw === "" ? null : raw;
}

// ── the routes ───────────────────────────────────────────────────────────────

/**
 * Handle a task-map route. Returns true when the request was handled (the
 * caller returns immediately), false when it is not one of ours.
 */
export async function handleTaskMapRoute(req, res, url, ctx) {
  const method = req.method;
  const path = url.pathname;
  const { readJsonBody, respondBodyError, json, log } = ctx;

  // GET /api/task-map?stage=&label= — the filtered read view. NEVER embeds
  // and NEVER builds: the coordinates come from the persisted projection
  // only, the points carry no vectors and no descriptions.
  if (method === "GET" && path === "/api/task-map") {
    const map = resolveMap(ctx);
    if (!map) {
      json(res, 503, { error: defaultMapError?.message ?? "the task map is not configured on this server", code: defaultMapError?.code ?? "unconfigured" });
      log(method, path, 503);
      return true;
    }
    const stage = queryParam(url, "stage");
    const label = queryParam(url, "label");
    let view;
    try {
      view = map.read({ stage, label });
    } catch (err) {
      json(res, 500, { error: sanitizeError(err).message });
      log(method, path, 500);
      return true;
    }
    json(res, 200, {
      ...view,
      corpus: publicCorpus(),
      build: publicJob(),
      destination: destinationOf(ctx),
    });
    log(method, path, 200);
    return true;
  }

  // GET /api/task-map/status — the cheap poll: the map's own status (running
  // flag, counts, embedding identity, last build, projection) plus the job
  // state and the local destination. No embedding, no build.
  if (method === "GET" && path === "/api/task-map/status") {
    const map = resolveMap(ctx);
    if (!map) {
      json(res, 503, { error: defaultMapError?.message ?? "the task map is not configured on this server", code: defaultMapError?.code ?? "unconfigured" });
      log(method, path, 503);
      return true;
    }
    let status;
    try {
      status = map.status();
    } catch (err) {
      json(res, 500, { error: sanitizeError(err).message });
      log(method, path, 500);
      return true;
    }
    json(res, 200, {
      ...status,
      corpus: publicCorpus(),
      build: publicJob(),
      destination: destinationOf(ctx),
    });
    log(method, path, 200);
    return true;
  }

  // GET /api/task-map/neighbors?taskKey=&limit= — nearest neighbours on the
  // ORIGINAL vectors (cosine), 2D is visual only. Unknown task / no vector
  // yet is an honest 404 with the core's code, never an invented list.
  let m = path.match(/^\/api\/task-map\/neighbors$/);
  if (method === "GET" && m) {
    const map = resolveMap(ctx);
    if (!map) {
      json(res, 503, { error: defaultMapError?.message ?? "the task map is not configured on this server", code: defaultMapError?.code ?? "unconfigured" });
      log(method, path, 503);
      return true;
    }
    const taskKey = queryParam(url, "taskKey");
    if (!taskKey) {
      json(res, 400, { error: "taskKey (query) is required" });
      log(method, path, 400);
      return true;
    }
    const limitRaw = queryParam(url, "limit");
    let limit = 5;
    if (limitRaw != null) {
      limit = Number(limitRaw);
      if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
        json(res, 400, { error: "limit must be an integer between 1 and 25" });
        log(method, path, 400);
        return true;
      }
    }
    try {
      const result = map.neighbors(taskKey, { limit });
      json(res, 200, result);
      log(method, path, 200);
    } catch (err) {
      const code = err?.code ?? null;
      if (code === "unknown_task" || code === "no_embedding") {
        json(res, 404, { error: sanitizeError(err).message, code });
      } else {
        console.error("[task-map] neighbors failed:", code ?? "", err?.message ?? err);
        json(res, 500, { error: "the task-map lookup failed" });
      }
      log(method, path, code === "unknown_task" || code === "no_embedding" ? 404 : 500);
    }
    return true;
  }

  // POST /api/task-map/build { workspace?, rebuild? } — the write guards
  // (same-origin loopback), the body cap, then 202 IMMEDIATELY with the
  // corpus load + embedding build running in the background. A build already
  // running answers 409 with the SAME job's public shape — the truth, never
  // a second concurrent job.
  m = path.match(/^\/api\/task-map\/build$/);
  if (method === "POST" && m) {
    if (!writeGuards(req, res, path, ctx)) return true;
    const map = resolveMap(ctx);
    if (!map) {
      json(res, 503, { error: defaultMapError?.message ?? "the task map is not configured on this server", code: defaultMapError?.code ?? "unconfigured" });
      log(method, path, 503);
      return true;
    }
    let body;
    try {
      body = await readJsonBody(req, TASK_MAP_BODY_CAP);
    } catch (err) {
      log(method, path, respondBodyError(res, err));
      return true;
    }
    const rebuild = body?.rebuild ?? false;
    if (typeof rebuild !== "boolean") {
      json(res, 400, { error: "rebuild must be a boolean when present" });
      log(method, path, 400);
      return true;
    }
    let workspace;
    if (body?.workspace !== undefined) {
      if (typeof body.workspace !== "string" || !body.workspace.trim()) {
        json(res, 400, { error: "workspace must be a non-empty string when present" });
        log(method, path, 400);
        return true;
      }
      workspace = body.workspace.trim();
    }
    if (lastJob && lastJob.state === "running") {
      json(res, 409, {
        error: "a task-map build is already running",
        code: "build_in_progress",
        job: publicJob(),
      });
      log(method, path, 409);
      return true;
    }
    const startedAt = new Date().toISOString();
    lastJob = {
      state: "running",
      startedAt,
      finishedAt: null,
      workspace: workspace ?? null,
      rebuild,
      error: null,
      counts: null,
      projectionVersion: null,
    };
    json(res, 202, { started: true, startedAt, workspace: workspace ?? null, rebuild });
    log(method, path, 202);
    const corpusLoader = ctx.loadTaskMapCorpus
      ? ctx.loadTaskMapCorpus
      : (args) => loadTaskMapCorpus({ ...args, linearQueue: ctx.linearQueue });
    // Fire and forget: the response is gone; the job state carries the truth.
    void runBuildJob({ map, corpusLoader, workspace, rebuild });
    return true;
  }

  return false;
}
