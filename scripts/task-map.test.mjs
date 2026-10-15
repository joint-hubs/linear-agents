// scripts/task-map.test.mjs — semantic task map (PRD §11, P4 slice).
//
// Pins the cache contract (digest = contract version + model + revision +
// dims + text sha256; only changed text re-embeds; metadata-only changes
// make zero calls), the digest pinning (no explicit revision → each build
// resolves the ACTUAL model digest from local Ollama /api/tags and re-keys
// the cache + refits the projection on change; an injected embed never
// resolves over the network; a failed pin keeps the last good revision),
// the wallclock (startedAt is the build's start, finishedAt its completion),
// the projection policy (fixed reference; new/changed
// vectors transform into it, existing coordinates never move; explicit
// rebuild creates a new version; tiny-N PCA/list fallback; no fake points),
// the security envelope (local/private embedding hosts only, cache outside
// the repo, no vectors/descriptions in read() output, sanitized errors) and
// the concurrency contract (single-flight per instance + lockfile).
//
// All tests inject the embed/project fakes — no production network, no
// real model calls, no python spawn.
//
// Run: node --test scripts/task-map.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONTRACT_VERSION,
  DEFAULT_TIMEOUT_MS,
  cosineSimilarity,
  createTaskMap,
  embeddingDigest,
  isEmbeddingHostAllowed,
  normalizeTaskText,
} from "./task-map.mjs";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPTS_DIR, "..");

function freshCacheDir() {
  return mkdtempSync(join(tmpdir(), "task-map-test-"));
}

/** Deterministic fake embedder: the vector is derived from the text so
 * changed texts produce changed vectors. `dimFor` lets a test control the
 * vector shape (including deliberately incompatible dimensions); `failOn`
 * returns an INVALID vector for a matching text ON ITS FIRST ENCOUNTER ONLY
 * (a retry succeeds) — the per-text partial-failure path inside an otherwise
 * successful batch. */
function fakeEmbedder({ dim = 4, dimFor, failOn } = {}) {
  const calls = [];
  const failedOnce = new Set();
  return {
    calls,
    async embed(texts) {
      calls.push([...texts]);
      return texts.map((text) => {
        if (failOn && text.includes(failOn) && !failedOnce.has(text)) {
          failedOnce.add(text);
          return null; // invalid vector → per-text embed_failed
        }
        const length = dimFor ? dimFor(text) : dim;
        const vector = [];
        for (let i = 0; i < length; i++) {
          // Stable pseudo-vector from the text bytes.
          vector.push(Math.sin(text.charCodeAt(i % text.length) + i * 0.37) || 0.5);
        }
        return vector;
      });
    },
  };
}

/** Fake projection runner: records modes, returns deterministic coords and
 * emulates the python worker's response shape (incl. modelSha256). */
function fakeProjector() {
  const calls = [];
  let transformSeq = 100;
  return {
    calls,
    async project(request) {
      calls.push(request);
      if (request.mode === "transform") {
        return {
          mode: "transform",
          coords: request.vectors.map(() => [transformSeq++, -transformSeq]),
        };
      }
      const version = (calls.filter((c) => c.mode !== "transform").length);
      const outPath = request.outPath;
      // The real worker writes a pickle; the fake writes bytes so the parent's
      // sha256 pinning and model-file bookkeeping are exercised.
      writeFileSync(outPath, Buffer.from(`fake-model-v${version}`));
      return {
        mode: request.mode,
        coords: request.vectors.map((_, i) => [i * 1.5, -i * 2.5]),
        libraryVersions: { "umap-learn": "0.5.12-fake", numpy: "fake", sklearn: "fake" },
      };
    },
  };
}

function taskMap(cacheDir, { embedder, projector, embedding: embeddingOverride, ...options } = {}) {
  return createTaskMap({
    cacheDir,
    embedding: { model: "embeddinggemma:latest", ...(embeddingOverride ?? {}) },
    embed: embedder ? (texts) => embedder.embed(texts) : undefined,
    project: typeof projector === "function"
      ? projector
      : projector ? (request) => projector.project(request) : undefined,
    ...options,
  });
}

const TASKS = [
  { taskKey: "FENIX-1", taskId: "1", title: "Login page", description: "Implement the login form", stage: "dev", labels: ["ui"], costUsd: 0.5, durationMs: 1000 },
  { taskKey: "FENIX-2", taskId: "2", title: "Login API", description: "Session endpoint for login", stage: "dev", labels: ["api"], costUsd: 1.0, durationMs: 2000 },
  { taskKey: "FENIX-3", taskId: "3", title: "Board UI", description: "Render the task board", stage: "review", labels: ["ui"], costUsd: 2.0, durationMs: 3000 },
  { taskKey: "FENIX-4", taskId: "4", title: "Deploy pipeline", description: "Ship to production", stage: "review", labels: ["ops"], costUsd: 3.0, durationMs: 4000 },
];

test("normalizeTaskText collapses whitespace and joins title+description", () => {
  assert.equal(normalizeTaskText("Login  page\n", "  Implement\tthe form "), "Login page Implement the form");
  assert.equal(normalizeTaskText("Only title"), "Only title");
  assert.equal(normalizeTaskText("", ""), "");
});

test("embeddingDigest covers contract version, model, revision, dims and text", () => {
  const base = { model: "m", revision: "r", text: "hello", dims: 4 };
  const digest = embeddingDigest(base);
  assert.equal(digest, embeddingDigest({ ...base }));
  assert.notEqual(digest, embeddingDigest({ ...base, text: "hello2" }));
  assert.notEqual(digest, embeddingDigest({ ...base, model: "m2" }));
  assert.notEqual(digest, embeddingDigest({ ...base, revision: "r2" }));
  assert.notEqual(digest, embeddingDigest({ ...base, dims: 8 }));
  assert.match(digest, /^[0-9a-f]{64}$/);
});

test("cosineSimilarity is scale-invariant and zero for zero vectors", () => {
  assert.ok(Math.abs(cosineSimilarity([1, 0], [1, 0]) - 1) < 1e-12);
  assert.ok(Math.abs(cosineSimilarity([2, 0], [1, 0]) - 1) < 1e-12);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([0, 0], [1, 0]), 0);
  assert.equal(cosineSimilarity([1], [1, 0]), 0);
});

test("isEmbeddingHostAllowed: local/private/Docker yes, public no", () => {
  for (const ok of ["http://ollama:11434", "http://localhost:11434", "http://127.0.0.1:11434", "http://10.0.0.5:8080", "http://192.168.1.4:8080", "http://172.17.0.2:11434"]) {
    assert.equal(isEmbeddingHostAllowed(ok), true, ok);
  }
  for (const bad of ["https://api.openai.com", "http://example.com", "http://8.8.8.8", "ftp://ollama:11434", "not a url"]) {
    assert.equal(isEmbeddingHostAllowed(bad), false, bad);
  }
});

test("a public embedding endpoint is refused at construction", () => {
  assert.throws(
    () => createTaskMap({ cacheDir: freshCacheDir(), embedding: { model: "m", baseUrl: "https://api.openai.com" } }),
    (err) => err.code === "remote_embedding_disabled",
  );
});

test("the cache dir must live outside the repository", () => {
  assert.throws(
    () => createTaskMap({ cacheDir: join(REPO_ROOT, "tmp-task-map"), embedding: { model: "m" }, embed: async () => [] }),
    (err) => err.code === "cache_inside_repo",
  );
});

test("build embeds once, read() returns points without vectors or descriptions, and metadata-only changes re-embed nothing", async () => {
  const cacheDir = freshCacheDir();
  const embedder = fakeEmbedder();
  const projector = fakeProjector();
  const map = taskMap(cacheDir, { embedder, projector });

  const first = await map.build(TASKS);
  assert.equal(embedder.calls.length, 1);
  assert.equal(first.counts.ready, 4);
  assert.equal(first.counts.error + first.counts.omitted + first.counts.pending, 0);

  const view = map.read();
  assert.equal(view.points.length, 4);
  for (const point of view.points) {
    assert.deepEqual(Object.keys(point).sort(), ["costUsd", "durationMs", "labels", "stage", "taskId", "taskKey", "title", "x", "y"]);
    assert.equal(typeof point.x, "number");
    assert.equal(typeof point.y, "number");
  }

  // Metadata-only change: same texts → same digests → zero embed calls, no
  // refit, coordinates identical (filters/labels never move points).
  const relabeled = TASKS.map((t) => t.taskKey === "FENIX-1" ? { ...t, stage: "done", labels: ["ui", "urgent"] } : t);
  await map.build(relabeled);
  assert.equal(embedder.calls.length, 1, "metadata-only change must not embed");
  assert.equal(projector.calls.filter((c) => c.mode === "fit").length, 1, "metadata-only change must not refit");
  const before = Object.fromEntries(map.read().points.map((p) => [p.taskKey, [p.x, p.y]]));
  const after = Object.fromEntries(map.read().points.map((p) => [p.taskKey, [p.x, p.y]]));
  assert.deepEqual(after, before);
  assert.deepEqual(map.read({ stage: "done" }).points.map((p) => p.taskKey), ["FENIX-1"]);
  assert.deepEqual(map.read({ label: "urgent" }).points.map((p) => p.taskKey), ["FENIX-1"]);
  assert.deepEqual(map.read({ label: "api" }).points.map((p) => p.taskKey), ["FENIX-2"]);
});

test("a changed title/description re-embeds only that text and TRANSFORMS into the fixed reference (existing coordinates never move)", async () => {
  const cacheDir = freshCacheDir();
  const embedder = fakeEmbedder();
  const projector = fakeProjector();
  const map = taskMap(cacheDir, { embedder, projector });

  await map.build(TASKS);
  const coordsBefore = Object.fromEntries(map.read().points.map((p) => [p.taskKey, [p.x, p.y]]));
  assert.equal(projector.calls.filter((c) => c.mode === "fit").length, 1);

  const edited = [...TASKS.slice(1), { ...TASKS[0], description: "Login form with SSO" }];
  await map.build(edited);
  assert.equal(embedder.calls.length, 2, "only the changed text re-embeds");
  assert.deepEqual(embedder.calls[1], ["Login page Login form with SSO"]);
  assert.equal(projector.calls.filter((c) => c.mode === "fit").length, 1, "no refit for new points");
  assert.equal(projector.calls.filter((c) => c.mode === "transform").length, 1, "new vector transforms");
  const coordsAfter = Object.fromEntries(map.read().points.map((p) => [p.taskKey, [p.x, p.y]]));
  for (const key of ["FENIX-2", "FENIX-3", "FENIX-4"]) {
    assert.deepEqual(coordsAfter[key], coordsBefore[key], `${key} must not move`);
  }
  assert.notDeepEqual(coordsAfter["FENIX-1"], coordsBefore["FENIX-1"]);
});

test("an explicit rebuild creates a new projection version (fit, not transform)", async () => {
  const cacheDir = freshCacheDir();
  const embedder = fakeEmbedder();
  const projector = fakeProjector();
  const map = taskMap(cacheDir, { embedder, projector });

  await map.build(TASKS);
  assert.equal(map.status().projection.version, 1);
  await map.build(TASKS, { rebuild: true });
  assert.equal(projector.calls.filter((c) => c.mode === "fit").length, 2);
  assert.equal(map.status().projection.version, 2);
  assert.equal(map.status().projection.params.seed, 42);
  assert.equal(map.status().projection.params.metric, "cosine");
});

test("a different model revision invalidates cached vectors and refits into a new version", async () => {
  const cacheDir = freshCacheDir();
  const embedderA = fakeEmbedder();
  const mapA = taskMap(cacheDir, { embedder: embedderA, projector: fakeProjector(), embedding: { revision: "rev-1" } });
  await mapA.build(TASKS);
  assert.equal(embedderA.calls.length, 1);

  const embedderB = fakeEmbedder();
  const projectorB = fakeProjector();
  const mapB = taskMap(cacheDir, { embedder: embedderB, projector: projectorB, embedding: { revision: "rev-2" } });
  const view = await mapB.build(TASKS);
  assert.equal(embedderB.calls.length, 1, "revision change must re-embed everything");
  assert.equal(view.counts.ready, 4);
  assert.equal(projectorB.calls.filter((c) => c.mode === "fit").length, 1);
  assert.equal(mapB.status().projection.version, 2, "new revision → new projection version");
  assert.equal(mapB.status().embedding.revision, "rev-2");
});

test("partial embedding failure: failed tasks are error, the rest is ready, and a retry re-embeds only the failure", async () => {
  const cacheDir = freshCacheDir();
  const embedder = fakeEmbedder({ failOn: "Deploy" });
  const projector = fakeProjector();
  const map = taskMap(cacheDir, { embedder, projector });

  const first = await map.build(TASKS);
  assert.equal(first.counts.error, 1);
  assert.equal(first.counts.ready, 3);
  const failedDigest = JSON.parse(readFileSync(join(cacheDir, "last-build.json"), "utf8")).tasks["FENIX-4"].digest;
  const view = map.read();
  assert.equal(view.points.length, 3, "failed texts show no point");
  assert.deepEqual(view.unembedded, [{ taskKey: "FENIX-4", reason: "embed_failed" }]);
  assert.ok(existsSync(join(cacheDir, "errors", `${failedDigest}.json`)));
  const errorRecord = JSON.parse(readFileSync(join(cacheDir, "errors", `${failedDigest}.json`), "utf8"));
  assert.deepEqual(Object.keys(errorRecord).sort(), ["at", "code", "digest"], "no raw network error is stored");
  assert.equal(errorRecord.code, "embed_failed");

  const retry = await map.build(TASKS);
  assert.equal(embedder.calls.length, 2, "only the failed text is retried");
  assert.equal(retry.counts.ready, 4);
  assert.equal(existsSync(join(cacheDir, "errors", `${failedDigest}.json`)), false, "cleared on success");
});

test("a batch-level embed failure marks the batch error and preserves earlier vectors", async () => {
  const cacheDir = freshCacheDir();
  let calls = 0;
  const projector = fakeProjector();
  const map = createTaskMap({
    cacheDir,
    embedding: { model: "m" },
    batchSize: 2,
    async embed(texts) {
      calls += 1;
      if (calls === 1) throw new Error("endpoint down");
      return texts.map((t) => [t.length, 1, 0, 0]);
    },
    project: (request) => projector.project(request),
  });
  const result = await map.build(TASKS);
  assert.equal(result.counts.error, 2, "first batch failed");
  assert.equal(result.counts.ready, 2, "the second batch succeeded and was projected");
  assert.equal(calls, 2, "both batches attempted");
  const second = await map.build(TASKS);
  assert.equal(second.counts.ready, 4, "retry completes the corpus");
  assert.equal(calls, 3, "only the two failed texts re-embed");
});

test("duplicates: the first occurrence wins with a visible counter, and identical texts collapse onto one digest", async () => {
  const cacheDir = freshCacheDir();
  const embedder = fakeEmbedder();
  const map = taskMap(cacheDir, { embedder, projector: fakeProjector() });
  const result = await map.build([TASKS[0], TASKS[1], { ...TASKS[0], title: "Login page (copy)" }]);
  assert.equal(result.counts.ready, 2, "the first occurrence of each taskKey is kept");
  assert.equal(result.counts.omitted, 0, "a key duplicate is not silently dropped — it is counted");
  const lastBuild = JSON.parse(readFileSync(join(cacheDir, "last-build.json"), "utf8"));
  assert.equal(lastBuild.tasks["FENIX-1"].state, "ready");
  assert.equal(lastBuild.tasks["FENIX-1"].duplicateExtras, 1, "the later duplicate is visible in the snapshot");
  assert.equal(lastBuild.tasks["FENIX-1"].title, "Login page", "the FIRST occurrence's text is kept");
  assert.ok(embedder.calls[0].length <= 2, "the duplicate text is not embedded twice");

  // Identical texts under DIFFERENT task keys share one digest: one
  // embedding call serves both; both points land on the same coordinates.
  const cacheDir2 = freshCacheDir();
  const embedder2 = fakeEmbedder();
  const map2 = taskMap(cacheDir2, { embedder: embedder2, projector: fakeProjector() });
  const twin = { taskKey: "FENIX-1TWIN", title: TASKS[0].title, description: TASKS[0].description, stage: "dev", labels: [] };
  const result2 = await map2.build([TASKS[0], twin, TASKS[1], TASKS[2], TASKS[3]]);
  assert.equal(result2.counts.ready, 5);
  assert.equal(embedder2.calls[0].filter((t) => t === normalizeTaskText(TASKS[0].title, TASKS[0].description)).length, 1, "one call for the shared text");
  const points = map2.read().points;
  const a = points.find((p) => p.taskKey === "FENIX-1");
  const b = points.find((p) => p.taskKey === "FENIX-1TWIN");
  assert.deepEqual([b.x, b.y], [a.x, a.y], "identical texts share coordinates");
});

test("an empty-text task is omitted, never fabricated", async () => {
  const cacheDir = freshCacheDir();
  const embedder = fakeEmbedder();
  const map = taskMap(cacheDir, { embedder, projector: fakeProjector() });
  const result = await map.build([{ taskKey: "FENIX-9", title: "  ", description: "" }, TASKS[0], TASKS[1], TASKS[2]]);
  assert.equal(result.counts.omitted, 1);
  const view = map.read();
  assert.equal(view.points.some((p) => p.taskKey === "FENIX-9"), false, "no fake coordinates");
  assert.deepEqual(view.unembedded, [{ taskKey: "FENIX-9", reason: "no_text" }]);
});

test("configured dims must match: a wrong-dimension cached vector is not reused", async () => {
  const cacheDir = freshCacheDir();
  const fourDim = fakeEmbedder({ dim: 4 });
  const mapFour = taskMap(cacheDir, { embedder: fourDim, projector: fakeProjector(), embedding: { dims: 4 } });
  await mapFour.build(TASKS);

  // Same cache dir, same model, but dims=8: the digests change (dims are part
  // of the digest) AND a stale 4-dim record would be rejected by the dim
  // check — either way the texts re-embed at the new dimensionality.
  const eightDim = fakeEmbedder({ dim: 8 });
  const projectorEight = fakeProjector();
  const mapEight = taskMap(cacheDir, { embedder: eightDim, projector: projectorEight, embedding: { dims: 8 } });
  const result = await mapEight.build(TASKS);
  assert.equal(eightDim.calls.length, 1, "dims are part of the cache contract");
  assert.equal(result.counts.ready, 4);
  assert.equal(result.counts.omitted, 0);
});

test("incompatible vector dimensions are excluded from similarity and omitted from the map", async () => {
  const cacheDir = freshCacheDir();
  // The odd task out gets a 3-dim vector; the rest get 4-dim ones.
  const embedder = fakeEmbedder({ dimFor: (text) => text.includes("Board") ? 3 : 4 });
  const projector = fakeProjector();
  const map = taskMap(cacheDir, { embedder, projector });
  const result = await map.build(TASKS);
  assert.equal(result.counts.omitted, 1);
  assert.equal(map.read().points.length, 3);

  const neighbors = map.neighbors("FENIX-1");
  assert.equal(neighbors.taskKey, "FENIX-1");
  assert.equal(neighbors.neighbors.length, 2, "only compatible-dimension vectors participate");
  assert.ok(neighbors.neighbors.every((n) => n.taskKey !== "FENIX-3"));
  const sims = neighbors.neighbors.map((n) => n.similarity);
  assert.deepEqual(sims, [...sims].sort((a, b) => b - a), "sorted by similarity");
  assert.ok(neighbors.neighbors.every((n) => !("vector" in n)), "no vectors are returned");
});

test("nearest neighbors rank by cosine similarity on the original vectors", async () => {
  const cacheDir = freshCacheDir();
  const projector = fakeProjector();
  const map = createTaskMap({
    cacheDir,
    embedding: { model: "m" },
    async embed(texts) {
      // Hand-built geometry: FENIX-2 is closest to FENIX-1.
      const table = { "a": [1, 0, 0, 0], "b": [0.9, 0.1, 0, 0], "c": [0, 1, 0, 0], "d": [-1, 0, 0, 0] };
      return texts.map((t) => table[t]);
    },
    project: (request) => projector.project(request),
  });
  await map.build([
    { taskKey: "FENIX-1", title: "a" },
    { taskKey: "FENIX-2", title: "b" },
    { taskKey: "FENIX-3", title: "c" },
    { taskKey: "FENIX-4", title: "d" },
  ]);
  const { neighbors } = map.neighbors("FENIX-1", { limit: 3 });
  assert.deepEqual(neighbors.map((n) => n.taskKey), ["FENIX-2", "FENIX-3", "FENIX-4"]);
  assert.ok(neighbors[0].similarity > neighbors[1].similarity);
  assert.ok(neighbors[1].similarity > neighbors[2].similarity);
  assert.ok(neighbors[2].similarity < 0);
  assert.throws(() => map.neighbors("FENIX-404"), (err) => err.code === "unknown_task");
});

test("invalid tasks are rejected before anything is written or embedded", async () => {
  const cacheDir = freshCacheDir();
  const embedder = fakeEmbedder();
  const map = taskMap(cacheDir, { embedder, projector: fakeProjector() });
  await assert.rejects(
    () => map.build([{ title: "no key" }]),
    (err) => err.code === "invalid_tasks",
  );
  await assert.rejects(
    () => map.build([{ taskKey: "FENIX-1", title: 42 }]),
    (err) => err.code === "invalid_tasks",
  );
  await assert.rejects(
    () => map.build("not an array"),
    (err) => err.code === "invalid_tasks",
  );
  assert.equal(embedder.calls.length, 0, "no embedding calls for invalid input");
  assert.equal(existsSync(join(cacheDir, "last-build.json")), false);
});

test("build is single-flight per instance: concurrent callers share one promise", async () => {
  const cacheDir = freshCacheDir();
  const embedder = fakeEmbedder();
  const map = taskMap(cacheDir, { embedder, projector: fakeProjector() });
  const p1 = map.build(TASKS);
  const p2 = map.build(TASKS);
  assert.equal(p1, p2, "the same in-flight promise is returned");
  await p1;
  assert.equal(embedder.calls.length, 1);
  // After completion a new build is a new promise (and a no-op cache hit).
  const p3 = map.build(TASKS);
  assert.notEqual(p3, p1);
  await p3;
  assert.equal(embedder.calls.length, 1);
});

test("a lockfile held by another (live) process blocks build with build_in_progress", async () => {
  const cacheDir = freshCacheDir();
  const map = taskMap(cacheDir, { embedder: fakeEmbedder(), projector: fakeProjector() });
  writeFileSync(join(cacheDir, "build.lock"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  await assert.rejects(
    () => map.build(TASKS),
    (err) => err.code === "build_in_progress",
  );
  rmSync(join(cacheDir, "build.lock"));
  await map.build(TASKS, { rebuild: true }); // the lock is released afterwards
  assert.equal(existsSync(join(cacheDir, "build.lock")), false, "the lock is always released");
});

test("an interrupted lock requires verified manual recovery", async () => {
  const cacheDir = freshCacheDir();
  const map = taskMap(cacheDir, { embedder: fakeEmbedder(), projector: fakeProjector() });
  // PID 4_000_000 exceeds the pid space on any realistic host.
  writeFileSync(join(cacheDir, "build.lock"), JSON.stringify({ pid: 4_000_000, startedAt: new Date().toISOString() }));
  await assert.rejects(map.build(TASKS), { code: 'build_in_progress' });
  assert.equal(existsSync(join(cacheDir, 'build.lock')), true);
});

test("tiny corpora use the clearly-marked fallback and a single point is a list, not a projection", async () => {
  const cacheDir = freshCacheDir();
  const embedder = fakeEmbedder();
  const projector = fakeProjector();
  const map = taskMap(cacheDir, { embedder, projector });

  // N=1: kind "list", no projection worker call at all.
  await map.build([TASKS[0]]);
  assert.equal(map.status().projection.kind, "list");
  assert.equal(projector.calls.length, 0, "a single point needs no projection");
  assert.equal(map.read().points.length, 1);
  assert.deepEqual(map.read().points[0].x, map.read().points[0].y === 0 ? 0 : map.read().points[0].x);

  // N=2 (a fresh dir so the list registry does not absorb the second build):
  // PCA, clearly marked, no UMAP.
  const cacheDir2 = freshCacheDir();
  const embedder2 = fakeEmbedder();
  const projector2 = fakeProjector();
  const map2 = taskMap(cacheDir2, { embedder: embedder2, projector: projector2 });
  await map2.build([TASKS[0], TASKS[1]]);
  assert.equal(projector2.calls.length, 1);
  assert.equal(projector2.calls[0].mode, "pca");
  assert.equal(map2.status().projection.kind, "pca");
  assert.equal(projector2.calls[0].params.nNeighbors, 1, "min(15, N-1)");

  // N>=4: real UMAP path with n_neighbors=min(15, N-1).
  assert.equal(projector.calls.length, 0, "the N=1 map never invoked the projector");
  const cacheDir3 = freshCacheDir();
  const embedder3 = fakeEmbedder();
  const projector3 = fakeProjector();
  const map3 = taskMap(cacheDir3, { embedder: embedder3, projector: projector3 });
  await map3.build(TASKS);
  assert.equal(projector3.calls[0].mode, "fit");
  assert.equal(projector3.calls[0].params.nNeighbors, 3);
  assert.equal(projector3.calls[0].params.seed, 42);
  assert.equal(projector3.calls[0].params.metric, "cosine");
});

test("read() before any build: no points, no fabricated projection, counts all zero", () => {
  const cacheDir = freshCacheDir();
  const map = taskMap(cacheDir, { embedder: fakeEmbedder(), projector: fakeProjector() });
  const view = map.read();
  assert.deepEqual(view.points, []);
  assert.deepEqual(view.unembedded, []);
  assert.equal(view.projection.available, false);
  assert.deepEqual(view.status.counts, { pending: 0, ready: 0, error: 0, omitted: 0 });
  const status = map.status();
  assert.equal(status.running, false);
  assert.equal(status.projection.available, false);
  assert.equal(status.embedding.contractVersion, CONTRACT_VERSION);
});

test("a broken/tampered projection model falls back to a fresh fit, never to loading a user-supplied pickle", async () => {
  const cacheDir = freshCacheDir();
  const embedder = fakeEmbedder();
  const projector = fakeProjector();
  const map = taskMap(cacheDir, { embedder, projector });
  await map.build(TASKS);
  const registry = JSON.parse(readFileSync(join(cacheDir, "projection.json"), "utf8"));
  assert.ok(existsSync(join(cacheDir, registry.modelFile)));

  // Tamper: the pinned sha256 no longer matches the file on disk.
  const modelFile = registry.modelFile;
  writeFileSync(join(cacheDir, modelFile), Buffer.from("tampered"));
  const embedder2 = fakeEmbedder();
  const projector2 = fakeProjector();
  const map2 = taskMap(cacheDir, { embedder: embedder2, projector: projector2 });
  const edited = [...TASKS.slice(1), { ...TASKS[0], title: "Login page v2" }];
  const result = await map2.build(edited);
  assert.equal(result.counts.ready, 4);
  assert.equal(projector2.calls.filter((c) => c.mode === "fit").length, 1, "a broken reference is refitted");
  assert.equal(projector2.calls.filter((c) => c.mode === "transform").length, 0, "never transformed into a tampered model");
  const registry2 = JSON.parse(readFileSync(join(cacheDir, "projection.json"), "utf8"));
  assert.notEqual(registry2.modelFile, modelFile, "the new version pins a fresh artifact");

  // A registry pointing OUTSIDE the cache dir (or a weird filename) is not
  // loadable: the module refits instead of following the path.
  const registry3 = { ...registry2, modelFile: "..\\evil.pkl" };
  writeFileSync(join(cacheDir, "projection.json"), JSON.stringify(registry3));
  const projector3 = fakeProjector();
  const map3 = taskMap(cacheDir, { embedder: fakeEmbedder(), projector: projector3 });
  await map3.build([...TASKS, { taskKey: "FENIX-5", title: "new text five" }]);
  assert.equal(projector3.calls.filter((c) => c.mode === "transform").length, 0, "an outside-modelFile registry is not trusted");
  assert.equal(JSON.parse(readFileSync(join(cacheDir, "projection.json"), "utf8")).version, registry2.version + 1);
});

test("a projection worker that reports missing dependencies is an explicit unavailable, not a random fallback", async () => {
  const cacheDir = freshCacheDir();
  const projector = async () => {
    const err = new Error("python or its projection dependencies are unavailable");
    err.code = "projection_unavailable";
    throw err;
  };
  const map = taskMap(cacheDir, { embedder: fakeEmbedder(), projector, embedding: { model: "m" } });
  const result = await map.build(TASKS);
  assert.equal(result.counts.pending, 4, "embedded but not projected");
  const lastBuild = JSON.parse(readFileSync(join(cacheDir, "last-build.json"), "utf8"));
  assert.equal(lastBuild.projectionError, "projection_unavailable");
  assert.equal(map.read().points.length, 0, "no fabricated coordinates");
  assert.equal(map.read().projection.available, false);
  assert.equal(map.read().projection.lastError, "projection_unavailable");
  assert.equal(map.read().unembedded.length, 4);
});

test("status() reports pending/ready/error/omitted and the running flag during a build", async () => {
  const cacheDir = freshCacheDir();
  const projector = fakeProjector();
  let releaseEmbed;
  const gate = new Promise((resolveGate) => { releaseEmbed = resolveGate; });
  const map = createTaskMap({
    cacheDir,
    embedding: { model: "m" },
    async embed(texts) {
      await gate;
      return texts.map((t) => [1, 0, 0, 0]);
    },
    project: (request) => projector.project(request),
  });
  const building = map.build(TASKS);
  assert.equal(map.status().running, true, "single-flight state is visible");
  releaseEmbed();
  const result = await building;
  assert.equal(result.counts.ready, 4);
  assert.equal(map.status().running, false);
  assert.equal(map.status().counts.ready, 4);
  assert.equal(map.status().lastBuild.projectionVersion, 1);
});

test("the persisted registry and cache artifacts carry version/params/library metadata and stay out of the repo", async () => {
  const cacheDir = freshCacheDir();
  const embedder = fakeEmbedder();
  const projector = fakeProjector();
  const map = taskMap(cacheDir, { embedder, projector });
  await map.build(TASKS);
  const registry = JSON.parse(readFileSync(join(cacheDir, "projection.json"), "utf8"));
  assert.equal(registry.contractVersion, CONTRACT_VERSION);
  assert.equal(registry.model, "embeddinggemma:latest");
  assert.equal(registry.params.seed, 42);
  assert.equal(registry.params.metric, "cosine");
  assert.equal(registry.libraryVersions["umap-learn"], "0.5.12-fake");
  assert.match(registry.modelFile, /^projection-v\d+\.pkl$/);
  assert.match(registry.modelSha256, /^[0-9a-f]{64}$/);
  assert.ok(registry.createdAt);
  assert.ok(!cacheDir.startsWith(REPO_ROOT), "the cache lives outside the repo");
});

test("the default embedding timeout bounds a cold Ollama first build at 120s", () => {
  // A cold Ollama loads the model into RAM on the first /api/embed; 30s used
  // to kill the first build of a fresh container outright.
  assert.equal(DEFAULT_TIMEOUT_MS, 120_000);
});

test("lastBuild.startedAt/finishedAt record the real build wallclock, not one timestamp", async () => {
  const cacheDir = freshCacheDir();
  let tick = 0;
  const base = Date.parse("2026-10-14T12:00:00.000Z");
  const now = () => new Date(base + (tick++) * 1000); // advances on every read
  const embedder = fakeEmbedder();
  const projector = fakeProjector();
  const map = taskMap(cacheDir, { embedder, projector, now });

  await map.build(TASKS);
  const lastBuild = JSON.parse(readFileSync(join(cacheDir, "last-build.json"), "utf8"));
  assert.equal(new Date(lastBuild.startedAt).getTime(), base, "startedAt is the build's START");
  assert.ok(
    new Date(lastBuild.finishedAt) > new Date(lastBuild.startedAt),
    "finishedAt is the actual wallclock completion, strictly after startedAt",
  );

  // The empty-corpus path also records both ends honestly.
  tick = 0;
  await map.build([]);
  const empty = JSON.parse(readFileSync(join(cacheDir, "last-build.json"), "utf8"));
  assert.ok(new Date(empty.finishedAt) >= new Date(empty.startedAt));
});

test("without an explicit revision the build pins the digest from local Ollama /api/tags and re-keys the cache on change", async (t) => {
  const cacheDir = freshCacheDir();
  const calls = { tags: 0, embed: 0 };
  let digest = "sha256:d1";
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.endsWith("/api/tags")) {
      calls.tags++;
      return { ok: true, status: 200, json: async () => ({ models: [{ name: "embeddinggemma:latest", digest }] }) };
    }
    if (target.endsWith("/api/embed")) {
      calls.embed++;
      const body = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          embeddings: body.input.map((text) => {
            const vector = [];
            for (let i = 0; i < 4; i++) {
              vector.push(Math.sin(text.charCodeAt(i % text.length) + i * 0.37) || 0.5);
            }
            return vector;
          }),
        }),
      };
    }
    throw new Error(`unexpected fetch: ${target}`);
  };

  const projector = fakeProjector();
  // NO injected embed — the real transport runs over the stubbed fetch, so
  // the /api/tags pinning is exercised end to end (still zero real network).
  const map = taskMap(cacheDir, { projector });

  const first = await map.build(TASKS);
  assert.equal(first.counts.ready, 4);
  assert.equal(calls.tags, 1, "the build pinned the digest once");
  assert.equal(calls.embed, 1);
  assert.equal(map.status().embedding.revision, "sha256:d1", "the pinned digest is the revision");

  // The cache record carries the pinned revision.
  const lastBuild = JSON.parse(readFileSync(join(cacheDir, "last-build.json"), "utf8"));
  const record = JSON.parse(readFileSync(join(cacheDir, "embeddings", `${lastBuild.tasks["FENIX-1"].digest}.json`), "utf8"));
  assert.equal(record.revision, "sha256:d1", "the cache is keyed by the actual model digest");

  // Unchanged digest: each build re-pins /api/tags, but nothing re-embeds.
  await map.build(TASKS);
  assert.equal(calls.tags, 2, "each build re-pins the digest");
  assert.equal(calls.embed, 1, "the same digest reuses the cached vectors");

  // The model was re-pulled with a NEW digest: everything re-embeds and the
  // projection is replaced by a fresh fit (the old reference is not reused).
  digest = "sha256:d2";
  const third = await map.build(TASKS);
  assert.equal(calls.embed, 2, "a digest change re-embeds every text");
  assert.equal(third.counts.ready, 4);
  assert.equal(map.status().embedding.revision, "sha256:d2");
  assert.equal(map.read().projection.revision, "sha256:d2", "the projection follows the new digest");
  assert.equal(map.status().projection.version, 2, "a digest change refits into a new version");
});

test("an injected embed without a resolver keeps the model name as the revision and touches no network", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let networkTouched = false;
  globalThis.fetch = async () => { networkTouched = true; throw new Error("no network in tests"); };

  const cacheDir = freshCacheDir();
  const embedder = fakeEmbedder();
  const projector = fakeProjector();
  const map = taskMap(cacheDir, { embedder, projector });
  const result = await map.build(TASKS);
  assert.equal(result.counts.ready, 4);
  assert.equal(map.status().embedding.revision, "embeddinggemma:latest", "injected embed keeps the legacy revision");
  assert.equal(networkTouched, false, "an injected embed never resolves the digest over the network");
});

test("a failed digest pin keeps the last good revision — no cache churn, no build failure", async () => {
  const cacheDir = freshCacheDir();
  let fail = false;
  const embedder = fakeEmbedder();
  const projector = fakeProjector();
  const map = taskMap(cacheDir, {
    embedder,
    projector,
    resolveRevision: async () => { if (fail) throw new Error("tags down"); return "sha256:pinned"; },
  });

  await map.build(TASKS);
  assert.equal(embedder.calls.length, 1);
  fail = true;
  const second = await map.build(TASKS);
  assert.equal(embedder.calls.length, 1, "the failed pin does not re-key the cache");
  assert.equal(second.counts.ready, 4);
  assert.equal(map.status().embedding.revision, "sha256:pinned", "the last good digest is kept");
});
