// scripts/artifacts-routes.mjs — GET /api/artifacts (FOC-779): the read-only
// freshness table over config/artifacts.json, dispatched by
// telemetry-server.mjs right beside the settings routes.
//
// Transport only — the status/refresh logic lives in artifact-registry.mjs.
// The route serves a CACHE that tick() recomputes, so a dashboard poll never
// re-digests the sources: tick() recomputes the statuses and, OUTSIDE the
// container, refreshes every stale/missing `watch` entry under the in-memory
// lock (never two refreshes at once; a failing refresh is logged once and
// never thrown — the next tick retries). The DEFAULT refresh runs the registry
// CLI as a child process with an async spawn (refreshArtifactsViaCli), so a
// seconds-long ui/dist rebuild never blocks this server's event loop or the
// dashboard requests it serves; the in-memory lock spans the whole child
// promise. The launcher's own `refresh` (bin/dashboard.bat) may stay
// synchronous — only the server path must be async. KNOCK-ON: with a child
// per id, the mutual exclusion across processes is the manifest-side lock
// file (refreshArtifacts), not just this in-memory lock. Inside the container
// it only reports: entries marked inContainer:false are shipped with the
// image. The GET payload carries `refreshStatus: { at, refreshed, failed }` —
// the last refresh attempt's outcome, so the UI/operator can see it.
//
// The one unit conversion this side owns: artifact-registry reports `age` in
// SECONDS (now - output mtime, divided by 1000 there), while the dashboard's
// formatAge renders MILLISECONDS — tick() multiplies before the payload is
// cached, so the client always sees milliseconds.
//
// Mount (telemetry-server.mjs):
//   const artifactsRoutes = createArtifactsRoutes({ inContainer: process.env.FENIX_IN_CONTAINER === '1', json, log });
//   if (await artifactsRoutes.handle(req, res)) return;   // beside the settings routes
//   setInterval(() => void artifactsRoutes.tick(), 60_000).unref();  // every 4th ingest tick
//
// Test seams: statuses/refresh are injectable fakes, `now` an injectable
// clock — the unit tests never touch the real registry or a generator.

import { artifactStatuses, manifestPath as defaultManifestPath, refreshArtifactsViaCli } from "./artifact-registry.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPTS_DIR, "..");

const ARTIFACTS_PATH = "/api/artifacts";

// Registry ages are seconds; the dashboard's formatAge expects milliseconds.
const toMilliseconds = (age) =>
  typeof age === "number" && Number.isFinite(age) ? age * 1000 : age;

function withMillisecondsAges(result) {
  return {
    computedAt: result.computedAt,
    head: result.head,
    artifacts: (result.artifacts || []).map((a) => ({ ...a, age: toMilliseconds(a.age) })),
  };
}

// The local sender for tests and any mount that does not pass the shared
// helpers — same shape as telemetry-server's json(): pretty JSON, one header.
function sendJson(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

/**
 * Create the /api/artifacts route + tick pair.
 *
 * @param {object} [opts]
 * @param {string} [opts.root] repo root the registry describes (default: this checkout).
 * @param {string} [opts.manifestPath] the manifest file (default: the LA_ARTIFACTS_MANIFEST/dataHome seam).
 * @param {Function} [opts.statuses] injectable artifactStatuses stand-in, called with { root, manifestPath, now }.
 * @param {Function} [opts.refresh] injectable refreshArtifacts stand-in, called with { root, manifestPath, only, inContainer, now }.
 * @param {Function} [opts.spawnImpl] injectable async spawn for the DEFAULT refresh (tests assert the CLI argv); ignored with a custom refresh.
 * @param {boolean} [opts.inContainer] true inside the image (FENIX_IN_CONTAINER=1): report only, never refresh.
 * @param {Function} [opts.now] injectable clock (ms).
 * @param {Function} [opts.json] the server's shared json(res, status, data) when mounted there.
 * @param {Function} [opts.log] the server's shared log(method, path, status) when mounted there.
 */
export function createArtifactsRoutes({
  root = REPO_ROOT,
  manifestPath: mpArg,
  statuses,
  refresh,
  inContainer = false,
  now: clockArg,
  json: jsonFn,
  log: logFn,
  spawnImpl,
} = {}) {
  const mp = mpArg || defaultManifestPath();
  const clock = clockArg || (() => Date.now());
  const computeStatuses = statuses || ((o) => artifactStatuses({ ...o }));
  // The default refresh is ASYNC ON PURPOSE (the live incident this fixes: a
  // spawnSync inside tick froze every dashboard request for the length of a
  // ui/dist rebuild): it runs the registry CLI as a child process and the
  // event loop stays free until the child exits. With a custom refresh
  // injected, that stands in entirely.
  const runRefresh = refresh || ((o) => refreshArtifactsViaCli({ ...o, spawnImpl }));
  const send = jsonFn || sendJson;
  const log = logFn || (() => {});

  let cache = null; // the last tick()'s payload, ages already in milliseconds
  let refreshing = false; // the in-memory lock: never two refresh runs at once
  let lastFailureKey = null; // a failing refresh is logged once — retries stay silent until the signature changes
  let lastRefresh = null; // { at, refreshed, failed } — the last refresh attempt's outcome, persisted across ticks

  // Recompute the status cache and, outside the container, refresh the stale
  // or missing watch entries under the lock. INVARIANTS (the live incident
  // this pins down: a failed refresh left the payload's computedAt frozen):
  //   - the status cache is recomputed at the START of every tick, whatever
  //     happened last time — a failure never stops the recomputing;
  //   - the lock is released in a `finally`, so it is never held after a
  //     refresh — synchronous throw included — and the NEXT tick retries;
  //   - tick never throws: it runs on a server timer, and a throw there is
  //     how the cache used to freeze; the last good payload survives instead.
  // Order otherwise: statuses first (they name the stale ids), refresh, then
  // one recompute so the cache reflects what the refresh just produced. A
  // refresh failure lands in the log once and never propagates.
  async function tick({ now: nowArg } = {}) {
    try {
      const now = nowArg ?? clock();
      let result = withMillisecondsAges(computeStatuses({ root, manifestPath: mp, now }));

      if (!inContainer && !refreshing) {
        const stale = result.artifacts.filter(
          (a) => a.refresh === "watch" && (a.state === "stale" || a.state === "missing"),
        );
        if (stale.length > 0) {
          refreshing = true;
          try {
            const failures = [];
            let refreshedCount = 0;
            for (const a of stale) {
              try {
                const r = await runRefresh({ root, manifestPath: mp, only: a.id, inContainer, now });
                if (r && Array.isArray(r.refreshed)) refreshedCount += r.refreshed.length;
                if (r && Array.isArray(r.failed)) failures.push(...r.failed);
              } catch (err) {
                failures.push({ id: a.id, error: (err && err.message) || String(err) });
              }
            }
            if (failures.length > 0) {
              const key = failures.map((f) => `${f.id}:${f.error}`).join("|");
              if (key !== lastFailureKey) {
                console.error(
                  `[artifacts] refresh failed for ${failures.map((f) => f.id).join(", ")} — retrying on the next tick`,
                );
                lastFailureKey = key;
              }
            } else {
              lastFailureKey = null;
            }
            if (refreshedCount > 0) {
              try {
                result = withMillisecondsAges(computeStatuses({ root, manifestPath: mp, now }));
              } catch (err) {
                console.error(`[artifacts] status recompute after refresh failed: ${(err && err.message) || err} — the start-of-tick payload stands`);
              }
            }
            lastRefresh = { at: new Date(now).toISOString(), refreshed: refreshedCount, failed: failures };
          } finally {
            refreshing = false;
          }
        }
      }

      cache = { ...result, lastRefresh };
      return cache;
    } catch (err) {
      console.error(`[artifacts] tick failed, keeping the previous cache: ${(err && err.message) || err}`);
      return cache;
    }
  }

  // GET /api/artifacts → the cached payload (a fresh compute when empty);
  // anything else on this path → false (not ours) or 405 (method mismatch,
  // same vocabulary as the settings routes). refreshStatus carries the last
  // refresh attempt's outcome so the UI/operator can see it.
  async function handle(req, res) {
    let path;
    try {
      path = new URL(req.url, "http://localhost").pathname;
    } catch {
      return false;
    }
    if (path !== ARTIFACTS_PATH) return false;
    if (req.method !== "GET") {
      send(res, 405, { error: "method not allowed" });
      log(req.method, path, 405);
      return true;
    }
    if (!cache) await tick();
    send(res, 200, {
      computedAt: cache.computedAt,
      head: cache.head,
      artifacts: cache.artifacts,
      refreshStatus: cache.lastRefresh ?? null,
    });
    log(req.method, path, 200);
    return true;
  }

  return { handle, tick };
}
