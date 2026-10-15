#!/usr/bin/env node
/**
 * scripts/task-map.mjs — semantic task map (PRD §11, P4 slice).
 *
 * One point per task. The only embedding input is the NORMALIZED title +
 * description/AC — never transcripts, never credentials. The module owns a
 * cache directory given by the CALLER (never inside this repo):
 *
 *   <cacheDir>/embeddings/<digest>.json   one cached vector per text digest
 *   <cacheDir>/errors/<digest>.json       sanitized per-text embed failure
 *   <cacheDir>/build.lock                 cross-process build lock (pid+age)
 *   <cacheDir>/projection.json            current projection registry
 *   <cacheDir>/projection-v<N>.pkl        fitted UMAP/PCA reference model
 *   <cacheDir>/last-build.json            last build snapshot (states, counts)
 *
 * Cache contract (digest): contract version + embedding model + revision +
 * sha256 of the normalized text. A changed title/description yields a new
 * digest and re-embeds; a metadata-only change (stage/labels/cost/duration)
 * reuses the cached vector with zero embedding calls. A cached vector is
 * reused only when model+revision match and the vector is structurally valid.
 * The revision is the model identity the vectors really came from: an
 * explicitly pinned revision (env) wins; otherwise every BUILD asks the
 * local Ollama /api/tags for the model's actual digest and pins it — a
 * re-pulled model re-keys the cache and refits the projection. A read
 * (GET) never resolves anything and never embeds.
 *
 * Embedding transport: local Ollama POST /api/embed by default
 * (http://ollama:11434, embeddinggemma:latest). The base URL is restricted to
 * local/private/Docker-internal hosts — a public remote is REFUSED at
 * construction (PRD: no automatic export of task text to a remote). The
 * request bound is generous (120s): a COLD Ollama loads the model into RAM
 * on the first /api/embed of a fresh container, and a 30s bound killed the
 * first build outright. Callers may inject `embed` in tests; injection
 * bypasses the network but not the digest/cache contract. No keys or raw
 * network errors are ever persisted or exposed — failures surface as
 * sanitized codes ("embed_failed").
 *
 * Projection: fitted OUT OF PROCESS by scripts/task-map-project.py over a
 * JSON stdin/stdout protocol (umap-learn 0.5.12, seed 42, cosine,
 * n_neighbors=min(15, N-1), init=random). The fitted model is persisted in
 * the cache dir together with its parameters and library versions; filters
 * never refit and existing coordinates never move — new/changed vectors are
 * TRANSFORMED into the saved reference; only an explicit rebuild fits a new
 * version. Tiny corpora (N<4) fall back to a deterministic PCA (or a plain
 * list for N=1), clearly marked — no invented clusters, no fake vectors or
 * coordinates, ever. A missing python/umap is reported as explicitly
 * unavailable, never silently replaced by a random fallback.
 *
 * build() is a background-friendly promise with single-flight per instance
 * and a lockfile against cross-process races; a crashed build preserves the
 * last good (partial) state. read() performs NO embedding and returns points
 * WITHOUT vectors or descriptions — 2D is visual only, similarity runs on
 * the original vectors.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Bumped when the cache/projection layout or normalization changes. */
export const CONTRACT_VERSION = "task-map/1";

export const DEFAULT_EMBEDDING = Object.freeze({
  baseUrl: "http://ollama:11434",
  model: "embeddinggemma:latest",
});

/** Embedding request bound. Deliberately generous: a COLD Ollama loads the
 * model into RAM on the first /api/embed, which a 30s bound used to kill. */
export const DEFAULT_TIMEOUT_MS = 120_000;

const DEFAULT_BATCH_SIZE = 16;
const DEFAULT_TAGS_TIMEOUT_MS = 10_000;
const DEFAULT_PROJECT_TIMEOUT_MS = 120_000;
const LOCK_STALE_MS = 30 * 60 * 1000;
const PROJECTION_MODEL_PATTERN = /^projection-v\d+\.pkl$/;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/* ------------------------------------------------------------------ errors */

function codedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/* ------------------------------------------------------------- fs helpers */

/** Atomic write (tmp + rename), with a bounded rename retry for Windows
 * readers that still hold the destination open. */
function writeAtomic(filePath, data) {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, data);
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(tmp, filePath);
        restrictPermissions(filePath);
        return;
      } catch (err) {
        const retriable = err?.code === "EPERM" || err?.code === "EACCES";
        if (!retriable || attempt >= 4) throw err;
        sleepSync(50 * (attempt + 1));
      }
    }
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Best-effort 0600 on POSIX; a no-op on Windows (ACLs out of scope). */
function restrictPermissions(filePath) {
  if (process.platform === "win32") return;
  try { chmodSync(filePath, 0o600); } catch { /* best effort */ }
}

function readJsonOrNull(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

/** Cross-process build lock. Unknown or live owners are never evicted by age. */
function acquireLock(lockPath, { now = () => new Date() } = {}) {
  const token=randomUUID();
  try {
    const fd=openSync(lockPath,'wx');
    try {writeSync(fd,JSON.stringify({pid:process.pid,token,startedAt:now().toISOString()}));}finally{closeSync(fd);}
  } catch(error) {
    if(error.code!=='EEXIST')throw error;
    throw codedError('build_in_progress','another build or interrupted build holds the lock; verify the owner before manual recovery');
  }
  restrictPermissions(lockPath);
  let released=false;
  return {release(){if(released)return;released=true;if(readJsonOrNull(lockPath)?.token===token)try{rmSync(lockPath);}catch{}}};
}

function isInsideDir(dir, candidate) {
  const rel = resolve(candidate).toLowerCase().slice(resolve(dir).toLowerCase().length);
  return resolve(candidate).toLowerCase().startsWith(resolve(dir).toLowerCase() + "\\")
    || resolve(candidate).toLowerCase().startsWith(resolve(dir).toLowerCase() + "/");
}

/* ------------------------------------------------------- text and digests */

/** Normalized embedding input: title + description, whitespace-collapsed.
 * This is the ONLY task text that ever reaches the embedder. */
export function normalizeTaskText(title, description) {
  const join = [title, description]
    .filter((part) => typeof part === "string")
    .join(" \n ");
  return join.replace(/\s+/g, " ").trim();
}

/** Digest of the full cache contract: version + model + revision + expected
 * vector dimensions (when configured) + text. */
export function embeddingDigest({ model, revision, text, dims = null }) {
  const payload = JSON.stringify({
    v: CONTRACT_VERSION,
    m: model,
    r: revision ?? model,
    d: dims,
    t: createHash("sha256").update(text).digest("hex"),
  });
  return createHash("sha256").update(payload).digest("hex");
}

export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/* ------------------------------------------------------- embedding config */

/** Local/private/Docker-internal hosts only; public remotes are refused
 * (PRD §11: task text must not flow to an unapproved destination). */
export function isEmbeddingHostAllowed(rawBaseUrl) {
  let url;
  try {
    url = new URL(rawBaseUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host === "::1" || host === "[::1]") return true;
  if (!host.includes(".")) return true; // Docker-internal single-label name (e.g. "ollama")
  if (/^127\.\d+\.\d+\.\d+$/.test(host)) return true;
  if (/^10\.\d+\.\d+\.\d+$/.test(host)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(host)) return true;
  const m = /^172\.(\d+)\.\d+\.\d+$/.exec(host);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  return false;
}

async function ollamaEmbed({ baseUrl, model, texts, timeoutMs }) {
  let response;
  try {
    response = await fetch(`${baseUrl}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, input: texts }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // Sanitized: no raw network error, no URL, no stack reaches the caller.
    throw codedError("embed_failed", "the embedding endpoint is unreachable");
  }
  if (!response.ok) {
    throw codedError("embed_failed", `the embedding endpoint returned HTTP ${response.status}`);
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw codedError("embed_failed", "the embedding response was not valid JSON");
  }
  const vectors = body?.embeddings;
  if (!Array.isArray(vectors) || vectors.length !== texts.length) {
    throw codedError("embed_failed", "the embedding response shape was unexpected");
  }
  return vectors;
}

/** The actual digest of the configured model from the local Ollama /api/tags.
 * Any failure (unreachable, non-OK, shape, timeout) yields null — the caller
 * falls back to the previous revision, the build itself never fails here. */
async function fetchOllamaModelDigest({ baseUrl, model, timeoutMs }) {
  let response;
  try {
    response = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  let body;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  const models = Array.isArray(body?.models) ? body.models : [];
  const entry = models.find((m) => m?.name === model)
    ?? models.find((m) => typeof m?.name === "string" && m.name.startsWith(`${model}:`));
  return typeof entry?.digest === "string" && entry.digest.trim() !== "" ? entry.digest.trim() : null;
}

/* ----------------------------------------------------------- validation */

function isValidVector(vector) {
  return Array.isArray(vector)
    && vector.length > 0
    && vector.every((x) => typeof x === "number" && Number.isFinite(x));
}

function validateTasks(tasks) {
  if (!Array.isArray(tasks)) {
    throw codedError("invalid_tasks", "tasks must be an array");
  }
  const seen = new Set();
  tasks.forEach((task, index) => {
    const where = `tasks[${index}]`;
    if (!task || typeof task !== "object") {
      throw codedError("invalid_tasks", `${where} is not an object`);
    }
    if (typeof task.taskKey !== "string" || task.taskKey.trim() === "") {
      throw codedError("invalid_tasks", `${where}.taskKey must be a non-empty string`);
    }
    if (typeof task.title !== "string") {
      throw codedError("invalid_tasks", `${where}.title must be a string`);
    }
    if (task.description !== undefined && typeof task.description !== "string") {
      throw codedError("invalid_tasks", `${where}.description must be a string when present`);
    }
    if (task.stage !== undefined && task.stage !== null && typeof task.stage !== "string") {
      throw codedError("invalid_tasks", `${where}.stage must be a string or null`);
    }
    if (task.labels !== undefined && task.labels !== null
      && !(Array.isArray(task.labels) && task.labels.every((l) => typeof l === "string"))) {
      throw codedError("invalid_tasks", `${where}.labels must be an array of strings or null`);
    }
    if (task.costUsd !== undefined && task.costUsd !== null
      && !(typeof task.costUsd === "number" && Number.isFinite(task.costUsd))) {
      throw codedError("invalid_tasks", `${where}.costUsd must be a finite number or null`);
    }
    if (task.durationMs !== undefined && task.durationMs !== null
      && !(typeof task.durationMs === "number" && Number.isFinite(task.durationMs))) {
      throw codedError("invalid_tasks", `${where}.durationMs must be a finite number or null`);
    }
    // Duplicates are NOT invalid input — the later occurrence is omitted
    // (counted, reason "duplicate_of"), so the board never loses the task.
    seen.add(task.taskKey);
  });
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/* ------------------------------------------------------------- the module */

export function createTaskMap(options = {}) {
  const {
    cacheDir,
    embedding,
    embed,
    project,
    resolveRevision,
    now = () => new Date(),
    batchSize = DEFAULT_BATCH_SIZE,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    projectTimeoutMs = DEFAULT_PROJECT_TIMEOUT_MS,
  } = options;

  if (typeof cacheDir !== "string" || cacheDir.trim() === "") {
    throw codedError("invalid_options", "cacheDir is required");
  }
  const absoluteCacheDir = resolve(cacheDir);
  if (absoluteCacheDir === REPO_ROOT
    || isInsideDir(REPO_ROOT, absoluteCacheDir)) {
    throw codedError("cache_inside_repo", "the task-map cache must live outside the repository");
  }

  if (!embedding || typeof embedding !== "object" || typeof embedding.model !== "string") {
    throw codedError("invalid_options", "embedding.model is required");
  }
  const model = embedding.model;
  const explicitRevision = typeof embedding.revision === "string" && embedding.revision.trim() !== ""
    ? embedding.revision
    : null;
  let revision = explicitRevision ?? model;
  const dims = Number.isInteger(embedding.dims) && embedding.dims > 0 ? embedding.dims : null;

  let useEmbed;
  let embeddingBaseUrl = null;
  if (typeof embed === "function") {
    useEmbed = embed;
  } else {
    embeddingBaseUrl = embedding.baseUrl ?? DEFAULT_EMBEDDING.baseUrl;
    if (!isEmbeddingHostAllowed(embeddingBaseUrl)) {
      throw codedError(
        "remote_embedding_disabled",
        "the embedding endpoint must be local, private or a Docker-internal host; public remotes are disabled",
      );
    }
    useEmbed = (texts) => ollamaEmbed({ baseUrl: embeddingBaseUrl, model, texts, timeoutMs });
  }

  // Digest pinning on build: an explicitly pinned revision (env) wins and
  // nothing is resolved. Otherwise an injected `resolveRevision` seam is
  // used (tests); without one, only the REAL transport resolves — an
  // injected `embed` (tests) keeps the model name as the revision and never
  // touches the network. The default resolver reads the actual model digest
  // from local Ollama /api/tags (bounded); a failed resolution keeps the
  // previous revision — no cache churn, no build failure. Reads never
  // resolve: GET stays read-only and embedding-free.
  const resolveRevisionOnBuild = explicitRevision
    ? null
    : typeof resolveRevision === "function"
      ? resolveRevision
      : typeof embed === "function"
        ? null
        : () => fetchOllamaModelDigest({
          baseUrl: embeddingBaseUrl ?? DEFAULT_EMBEDDING.baseUrl,
          model,
          timeoutMs: DEFAULT_TAGS_TIMEOUT_MS,
        });

  const projectScript = join(dirname(fileURLToPath(import.meta.url)), "task-map-project.py");
  const useProject = typeof project === "function"
    ? project
    : (request) => runPythonProject({ scriptPath: projectScript, request, timeoutMs: projectTimeoutMs });

  mkdirSync(join(absoluteCacheDir, "embeddings"), { recursive: true });
  mkdirSync(join(absoluteCacheDir, "errors"), { recursive: true });

  const paths = {
    cacheDir: absoluteCacheDir,
    embeddings: join(absoluteCacheDir, "embeddings"),
    errors: join(absoluteCacheDir, "errors"),
    lock: join(absoluteCacheDir, "build.lock"),
    projection: join(absoluteCacheDir, "projection.json"),
    lastBuild: join(absoluteCacheDir, "last-build.json"),
  };

  let buildPromise = null;

  /* ---------------------------------------------------------- cache I/O */

  function embeddingPath(digest) {
    return join(paths.embeddings, `${digest}.json`);
  }

  function readCachedVector(digest) {
    const record = readJsonOrNull(embeddingPath(digest));
    if (!record || record.digest !== digest || record.model !== model || record.revision !== revision) {
      return null;
    }
    if (!isValidVector(record.vector)) return null;
    if (dims && record.vector.length !== dims) return null;
    return record.vector;
  }

  function writeCachedVector(digest, vector) {
    writeAtomic(embeddingPath(digest), JSON.stringify({
      digest,
      model,
      revision,
      dim: vector.length,
      vector,
      embeddedAt: now().toISOString(),
    }));
  }

  function recordEmbedError(digest) {
    // Sanitized on purpose: no URL, no raw network error, no keys.
    writeAtomic(join(paths.errors, `${digest}.json`), JSON.stringify({
      digest,
      code: "embed_failed",
      at: now().toISOString(),
    }));
  }

  function clearEmbedError(digest) {
    try { rmSync(join(paths.errors, `${digest}.json`), { force: true }); } catch { /* best effort */ }
  }

  function readProjection() {
    const registry = readJsonOrNull(paths.projection);
    if (!registry || registry.contractVersion !== CONTRACT_VERSION) return null;
    return registry;
  }

  /** The registry is the only source of a loadable pickle path; the file must
   * sit in the cache dir, match the naming pattern and hash — a user-supplied
   * pickle path is never loaded. */
  function validatedModelPath(registry) {
    if (!registry || typeof registry.modelFile !== "string") return null;
    if (!PROJECTION_MODEL_PATTERN.test(registry.modelFile)) return null;
    const modelPath = join(paths.cacheDir, registry.modelFile);
    if (!isInsideDir(paths.cacheDir, modelPath)) return null;
    if (!existsSync(modelPath)) return null;
    if (registry.modelSha256) {
      const actual = createHash("sha256").update(readFileSync(modelPath)).digest("hex");
      if (actual !== registry.modelSha256) return null;
    }
    return modelPath;
  }

  function writeProjectionRegistry(registry) {
    writeAtomic(paths.projection, JSON.stringify(registry, null, 2));
  }

  /* ------------------------------------------------------------- build */

  async function buildInternal(tasks, { rebuild = false } = {}) {
    const startedAt = now().toISOString(); // the ACTUAL build start; finishedAt lands at the end
    validateTasks(tasks);
    if (tasks.length === 0) {
      const snapshot = {
        startedAt,
        finishedAt: now().toISOString(),
        tasks: {},
        counts: { pending: 0, ready: 0, error: 0, omitted: 0 },
        projectionVersion: readProjection()?.version ?? null,
      };
      writeAtomic(paths.lastBuild, JSON.stringify(snapshot, null, 2));
      return { built: true, counts: snapshot.counts, projectionVersion: null };
    }

    // -- 0. pin the actual model digest as the revision (see
    //      resolveRevisionOnBuild) BEFORE any digest is computed — the cache
    //      keys and the projection identity follow the model really in use.
    if (resolveRevisionOnBuild) {
      try {
        const pinned = await resolveRevisionOnBuild(revision);
        if (typeof pinned === "string" && pinned.trim() !== "") revision = pinned.trim();
      } catch {
        // Keep the previous revision (model name or the last pinned digest):
        // a failed pin must not re-key the cache or fail the build.
      }
    }

    const lock = acquireLock(paths.lock, { now });
    try {
      // -- 1. dedupe by taskKey: the FIRST occurrence wins; later ones only
      //      bump a visible counter on the kept entry (never silent, never a
      //      second point — the map has one point per task).
      const byKey = new Map();
      const duplicateCount = new Map();
      for (const task of tasks) {
        if (byKey.has(task.taskKey)) {
          duplicateCount.set(task.taskKey, (duplicateCount.get(task.taskKey) ?? 0) + 1);
          continue;
        }
        byKey.set(task.taskKey, task);
      }

      // -- 2. normalized text + digests. Identical texts across different
      //      tasks collapse onto one digest: a single embedding call serves
      //      both, and both points land on the same coordinates.
      const textByDigest = new Map();
      const digestByKey = new Map();
      for (const [taskKey, task] of byKey) {
        const text = normalizeTaskText(task.title, task.description);
        if (text === "") {
          digestByKey.set(taskKey, null); // omitted: no_text
          continue;
        }
        const digest = embeddingDigest({ model, revision, text, dims });
        digestByKey.set(taskKey, digest);
        textByDigest.set(digest, text);
      }

      // -- 3. embed what is missing (batched; per-text partial failure) ----
      const missing = [...textByDigest.keys()].filter((d) => !readCachedVector(d));
      for (const batch of chunk(missing, batchSize)) {
        try {
          const vectors = await useEmbed(batch.map((d) => textByDigest.get(d)));
          batch.forEach((digest, i) => {
            const vector = Array.isArray(vectors) ? vectors[i] : undefined;
            if (isValidVector(vector)) {
              writeCachedVector(digest, vector);
              clearEmbedError(digest);
            } else {
              recordEmbedError(digest);
            }
          });
        } catch {
          // Sanitized batch failure: every text in the batch is retried by
          // the next build; embeddings obtained so far are preserved.
          batch.forEach((digest) => recordEmbedError(digest));
        }
      }

      // -- 4. projection ----------------------------------------------------
      const vectorByDigest = new Map();
      for (const digest of textByDigest.keys()) {
        const vector = readCachedVector(digest);
        if (vector) vectorByDigest.set(digest, vector);
      }

      let registry = readProjection();
      let projectionOutcome = { changed: false, error: null };

      // Pick the dimension to project on: the current reference's dim when
      // it is still populated, otherwise the largest dim group (smaller dim
      // wins ties for determinism).
      const byDim = new Map();
      for (const [digest, vector] of vectorByDigest) {
        const list = byDim.get(vector.length) ?? [];
        list.push(digest);
        byDim.set(vector.length, list);
      }
      const registryUsable = registry
        && registry.model === model
        && registry.revision === revision
        && byDim.has(registry.dims);
      const targetDim = registryUsable
        ? registry.dims
        : [...byDim.entries()].sort((a, b) => b[1].length - a[1].length || a[0] - b[0])[0]?.[0] ?? null;
      const fitDigests = targetDim != null ? byDim.get(targetDim) : [];

      if (targetDim == null) {
        // Nothing embeddable — keep any previous projection untouched.
        projectionOutcome.error = null;
      } else if (!rebuild && registryUsable) {
        // Transform new/changed digests into the fixed reference; existing
        // coordinates never move. If the reference is somehow broken
        // (missing/tampered model), fall through to a fresh fit below.
        const modelPath = validatedModelPath(registry);
        const newDigests = fitDigests.filter((d) => !(d in (registry.pointsByDigest ?? {})));
        // A fit digest whose task disappeared is simply no longer shown; it
        // does NOT invalidate the reference (existing coords never move).
        const referenceIntact = true;
        if (modelPath && referenceIntact && newDigests.length > 0) {
          try {
            const result = await useProject({
              mode: "transform",
              vectors: newDigests.map((d) => vectorByDigest.get(d)),
              request: { contractVersion: CONTRACT_VERSION, model, revision, dims: targetDim },
              modelPath,
            });
            const points = { ...(registry.pointsByDigest ?? {}) };
            newDigests.forEach((digest, i) => { points[digest] = result.coords[i]; });
            writeProjectionRegistry({
              ...registry,
              pointsByDigest: points,
              updatedAt: now().toISOString(),
            });
            registry = readProjection();
            projectionOutcome.changed = true;
          } catch (err) {
            projectionOutcome.error = err?.code === "projection_unavailable"
              ? "projection_unavailable"
              : "projection_failed";
          }
        } else if (modelPath && referenceIntact) {
          projectionOutcome.changed = false; // nothing new to transform
        } else {
          registry = null; // broken reference → full fit below
        }
      }

      const needsFit = targetDim != null
        && (!registry || rebuild || !registryUsable
          || !validatedModelPath(registry) && registry.kind !== "list");

      if (needsFit && fitDigests.length > 0) {
        try {
          const version = (readProjection()?.version ?? 0) + 1;
          const params = {
            seed: 42,
            nNeighbors: Math.max(1, Math.min(15, fitDigests.length - 1)),
            metric: "cosine",
          };
          let kind;
          let coords;
          let modelFile = null;
          let modelSha256 = null;
          let libraryVersions = {};
          if (fitDigests.length === 1) {
            // Tiny-N fallback, clearly marked: a single point is a list, not
            // a projection — no clusters, no invented geometry.
            kind = "list";
            coords = [[0, 0]];
          } else {
            const isTiny = fitDigests.length < 4;
            kind = isTiny ? "pca" : "umap";
            const outPath = join(paths.cacheDir, `projection-v${version}.pkl`);
            const result = await useProject({
              mode: isTiny ? "pca" : "fit",
              vectors: fitDigests.map((d) => vectorByDigest.get(d)),
              params: { ...params, kind },
              request: { contractVersion: CONTRACT_VERSION, model, revision, dims: targetDim },
              outPath,
            });
            coords = result.coords;
            libraryVersions = result.libraryVersions ?? {};
            if (existsSync(outPath)) {
              modelFile = `projection-v${version}.pkl`;
              modelSha256 = createHash("sha256").update(readFileSync(outPath)).digest("hex");
            }
          }
          const pointsByDigest = {};
          fitDigests.forEach((digest, i) => { pointsByDigest[digest] = coords[i]; });
          const nextRegistry = {
            version,
            kind,
            contractVersion: CONTRACT_VERSION,
            model,
            revision,
            dims: targetDim,
            params,
            createdAt: now().toISOString(),
            libraryVersions,
            fitDigests,
            pointsByDigest,
            modelFile,
            modelSha256,
          };
          writeProjectionRegistry(nextRegistry);
          registry = nextRegistry;
          projectionOutcome.changed = true;
          projectionOutcome.error = null;
        } catch (err) {
          projectionOutcome.error = err?.code === "projection_unavailable"
            ? "projection_unavailable"
            : "projection_failed";
        }
      }

      registry = readProjection();

      // -- 5. per-task states (snapshot for status()/read()) ----------------
      const taskStates = {};
      const counts = { pending: 0, ready: 0, error: 0, omitted: 0 };
      for (const [taskKey, task] of byKey) {
        const digest = digestByKey.get(taskKey);
        const duplicateExtras = duplicateCount.get(taskKey) ?? 0;
        let state;
        let reason;
        if (digest == null) {
          state = "omitted";
          reason = "no_text";
        } else {
          const vector = vectorByDigest.get(digest);
          if (!vector) {
            const failed = existsSync(join(paths.errors, `${digest}.json`));
            state = failed ? "error" : "pending";
            reason = failed ? "embed_failed" : "not_embedded";
          } else if (registry && registry.pointsByDigest && digest in registry.pointsByDigest) {
            state = "ready";
          } else if (registry && vector.length !== registry.dims) {
            state = "omitted";
            reason = "incompatible_dims";
          } else {
            state = "pending";
            reason = projectionOutcome.error ?? "not_projected";
          }
        }
        counts[state] += 1;
        taskStates[taskKey] = {
          state,
          reason: reason ?? null,
          duplicateExtras: duplicateExtras || undefined,
          digest,
          taskId: task.taskId ?? null,
          title: task.title ?? "",
          stage: task.stage ?? null,
          labels: task.labels ?? [],
          costUsd: task.costUsd ?? null,
          durationMs: task.durationMs ?? null,
        };
      }

      const snapshot = {
        startedAt,
        finishedAt: now().toISOString(), // the ACTUAL wallclock completion
        tasks: taskStates,
        counts,
        projectionVersion: registry?.version ?? null,
        projectionError: projectionOutcome.error,
      };
      writeAtomic(paths.lastBuild, JSON.stringify(snapshot, null, 2));
      return { built: true, counts, projectionVersion: registry?.version ?? null };
    } finally {
      lock.release();
    }
  }

  /* ------------------------------------------------------- public API */

  return {
    /** Background-friendly: single-flight per instance (the same promise is
     * returned to concurrent callers); the lockfile guards cross-process. */
    build(tasks, opts = {}) {
      if (buildPromise) return buildPromise;
      buildPromise = buildInternal(tasks, opts).finally(() => {
        buildPromise = null;
      });
      return buildPromise;
    },

    /** Filter+project view. NEVER embeds, NEVER returns vectors or task
     * descriptions. Coordinates come from the persisted projection only. */
    read({ stage, label } = {}) {
      const lastBuild = readJsonOrNull(paths.lastBuild);
      const registry = readProjection();
      const points = [];
      const unembedded = [];
      if (lastBuild) {
        for (const [taskKey, meta] of Object.entries(lastBuild.tasks)) {
          if (stage != null && meta.stage !== stage) continue;
          if (label != null && !(meta.labels ?? []).includes(label)) continue;
          const coords = registry && meta.digest && registry.pointsByDigest
            ? registry.pointsByDigest[meta.digest]
            : null;
          if (meta.state === "ready" && Array.isArray(coords) && coords.length === 2) {
            points.push({
              taskKey,
              taskId: meta.taskId,
              title: meta.title,
              stage: meta.stage,
              labels: meta.labels ?? [],
              costUsd: meta.costUsd,
              durationMs: meta.durationMs,
              x: coords[0],
              y: coords[1],
            });
          } else {
            unembedded.push({ taskKey, reason: meta.reason ?? meta.state });
          }
        }
      }
      return {
        points,
        unembedded,
        projection: registry
          ? {
            available: true,
            version: registry.version,
            kind: registry.kind,
            params: registry.params,
            libraryVersions: registry.libraryVersions ?? {},
            model: registry.model,
            revision: registry.revision,
            dims: registry.dims,
            fittedAt: registry.createdAt,
          }
          : { available: false, reason: "not_built", lastError: lastBuild?.projectionError ?? null },
        status: {
          counts: lastBuild?.counts ?? { pending: 0, ready: 0, error: 0, omitted: 0 },
          lastBuild: lastBuild
            ? { startedAt: lastBuild.startedAt, finishedAt: lastBuild.finishedAt }
            : null,
        },
      };
    },

    /** Nearest neighbours on the ORIGINAL vectors (cosine) — 2D is visual
     * only. Incompatible-dimension vectors are excluded. No vectors are
     * returned. */
    neighbors(taskKey, { limit = 5 } = {}) {
      const lastBuild = readJsonOrNull(paths.lastBuild);
      const meta = lastBuild?.tasks?.[taskKey];
      if (!meta) throw codedError("unknown_task", `no such task in the last build: ${taskKey}`);
      if (!meta.digest) throw codedError("no_embedding", "the task has no embeddable text");
      const target = readCachedVector(meta.digest);
      if (!target) throw codedError("no_embedding", "the task has no cached vector yet");
      const scored = [];
      for (const [otherKey, other] of Object.entries(lastBuild.tasks)) {
        if (otherKey === taskKey || !other.digest) continue;
        const vector = readCachedVector(other.digest);
        if (!vector || vector.length !== target.length) continue;
        scored.push({
          taskKey: otherKey,
          taskId: other.taskId,
          title: other.title,
          similarity: cosineSimilarity(target, vector),
        });
      }
      scored.sort((a, b) => b.similarity - a.similarity);
      return { taskKey, neighbors: scored.slice(0, limit) };
    },

    status() {
      const lastBuild = readJsonOrNull(paths.lastBuild);
      const registry = readProjection();
      return {
        running: buildPromise != null,
        counts: lastBuild?.counts ?? { pending: 0, ready: 0, error: 0, omitted: 0 },
        embedding: { model, revision, contractVersion: CONTRACT_VERSION },
        lastBuild: lastBuild
          ? {
            startedAt: lastBuild.startedAt,
            finishedAt: lastBuild.finishedAt,
            projectionVersion: lastBuild.projectionVersion,
            projectionError: lastBuild.projectionError ?? null,
          }
          : null,
        projection: registry
          ? {
            available: true,
            version: registry.version,
            kind: registry.kind,
            params: registry.params,
            libraryVersions: registry.libraryVersions ?? {},
          }
          : { available: false, reason: "not_built" },
      };
    },
  };
}

/* ------------------------------------------------- default python runner */

/**
 * Controlled child process for scripts/task-map-project.py: one JSON request
 * on stdin, one JSON response on stdout, hard timeout with SIGKILL. Only
 * python's stdlib + the pinned umap-learn stack are used; a missing
 * interpreter or missing deps is surfaced as "projection_unavailable" (an
 * explicit state, never a random fallback).
 *
 * `-P` keeps the current directory off sys.path (the injection risk `-I`
 * guards against) while leaving the user site-packages enabled — the pinned
 * umap-learn stack is commonly installed there and `-I` would silently turn
 * every projection into "unavailable". `-E` keeps the environment honest
 * (no PYTHONPATH smuggled in).
 */
export function runPythonProject({ scriptPath, request, timeoutMs = DEFAULT_PROJECT_TIMEOUT_MS, pythonBin = process.env.FENIX_PYTHON ?? "python" }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(pythonBin, ["-E", "-P", scriptPath], { stdio: ["pipe", "pipe", "pipe"] });
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle(rejectPromise, codedError("projection_unavailable", "the projection worker timed out"));
    }, timeoutMs);

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.stdin.on("error", () => { /* EPIPE if the child died early */ });

    child.on("error", () => {
      settle(rejectPromise, codedError("projection_unavailable", "python or its projection dependencies are unavailable"));
    });
    child.on("close", () => {
      let response = null;
      try { response = JSON.parse(stdout); } catch { /* handled below */ }
      if (response && !response.error) {
        settle(resolvePromise, response);
      } else if (response?.error === "dependency_missing") {
        settle(rejectPromise, codedError("projection_unavailable", "python or its projection dependencies are unavailable"));
      } else {
        // Sanitized: the child's stderr is not forwarded.
        settle(rejectPromise, codedError("projection_failed", "the projection worker failed"));
      }
    });

    child.stdin.write(JSON.stringify(request) + "\n");
    child.stdin.end();
  });
}

/* ------------------------------------------------------------------ CLI */

if (process.argv[1] && isAbsolute(process.argv[1]) && basename(process.argv[1]) === "task-map.mjs") {
  // No CLI on purpose: the module is driven by routes/tests with an explicit
  // cacheDir. Running it directly prints the contract, touches nothing.
  console.log(`task-map.mjs — semantic task map module (contract ${CONTRACT_VERSION}); import createTaskMap from this file.`);
}
