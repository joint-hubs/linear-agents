// scripts/artifacts-routes.test.mjs — FOC-779: the /api/artifacts route
// contract. Pins: the GET serves the CACHE (the statuses fake runs once for
// two GETs after one tick), tick() refreshes stale watch entries natively and
// never inside the container, the in-memory lock admits one refresh at a
// time, a failing refresh is logged once and never thrown, POST → 405, and
// the registry's SECONDS age reaches the client as MILLISECONDS (the
// dashboard's formatAge unit).
//
// Everything runs on stub req/res with injected statuses/refresh fakes and an
// injectable clock — no fs, no git, no ports, no socket binds, no real
// registry, no telemetry DB.
//
// Run: node scripts/artifacts-routes.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { createArtifactsRoutes } from "./artifacts-routes.mjs";

const T0 = 1_700_000_000_000;

// A registry payload the fake statuses returns: ages in SECONDS (the unit
// artifact-registry.mjs reports), shaped exactly like its artifactStatus() rows.
function payload(artifacts, now = T0) {
  return {
    computedAt: new Date(now).toISOString(),
    head: "a".repeat(40),
    manifestPath: "/tmp/unused/artifacts-manifest.json",
    artifacts,
  };
}

const watchStale = () => ({
  id: "watch-stale",
  title: "Stale watched artifact",
  output: "config/out.map",
  refresh: "watch",
  committed: false,
  inContainer: true,
  exists: true,
  age: 5, // seconds
  head: "a".repeat(40),
  digest: "b".repeat(64),
  manifest: null,
  state: "stale",
  reason: "source digest changed since last refresh",
});
const watchFresh = () => ({
  ...watchStale(),
  id: "watch-fresh",
  state: "fresh",
  reason: null,
});
const externalEntry = () => ({
  id: "diagrams-png",
  title: "External artifact",
  output: "docs/diagrams/*.png",
  refresh: "external",
  committed: true,
  inContainer: false,
  exists: true,
  age: 90,
  head: null,
  digest: null,
  manifest: null,
  state: "external",
  reason: "refresh external — reported only",
});

function makeRoutes({ artifacts = [watchStale()], refreshImpl, inContainer = false } = {}) {
  const calls = { statuses: 0, refresh: [] };
  const routes = createArtifactsRoutes({
    root: "/tmp/unused-root",
    manifestPath: "/tmp/unused/artifacts-manifest.json",
    statuses: ({ now }) => {
      calls.statuses += 1;
      return payload(artifacts, now ?? T0);
    },
    refresh:
      refreshImpl ??
      (({ only }) => {
        calls.refresh.push(only);
        return { refreshed: [{ id: only, digest: "c".repeat(64), generatedAt: "x" }], skipped: [], failed: [], manifestPath: "/tmp/unused", head: "a".repeat(40) };
      }),
    inContainer,
    now: () => T0,
  });
  return { routes, calls };
}

// A request/response stub — the route only touches method, url, writeHead, end.
function stubReq(method, url) {
  return { method, url };
}
function stubRes() {
  return {
    status: null,
    headers: null,
    body: null,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(data) {
      this.body = data;
    },
  };
}

async function get(routes) {
  const res = stubRes();
  const handled = await routes.handle(stubReq("GET", "/api/artifacts"), res);
  assert.equal(handled, true);
  return { status: res.status, body: JSON.parse(res.body) };
}

test("GET serves the cached payload: one statuses call covers two GETs after one tick", async () => {
  const { routes, calls } = makeRoutes({ artifacts: [watchFresh(), externalEntry()] });
  await routes.tick();
  const first = await get(routes);
  const second = await get(routes);
  assert.equal(calls.statuses, 1, "the tick computed the cache; two GETs must not recompute");
  assert.equal(first.status, 200);
  assert.deepEqual(second.body, first.body, "both GETs serve the same cached payload");
  assert.equal(first.body.head, "a".repeat(40));
  assert.deepEqual(
    first.body.artifacts.map((a) => a.id),
    ["watch-fresh", "diagrams-png"],
  );
});

test("a GET on an empty cache computes once and then serves the cache", async () => {
  const { routes, calls } = makeRoutes({ artifacts: [watchFresh()] });
  const first = await get(routes);
  await get(routes);
  assert.equal(calls.statuses, 1, "the first GET warmed the cache, the second reused it");
  assert.equal(first.body.artifacts[0].state, "fresh");
});

test("tick refreshes stale watch entries natively (only: the stale id), never fresh or external ones", async () => {
  const { routes, calls } = makeRoutes({ artifacts: [watchStale(), watchFresh(), externalEntry()] });
  await routes.tick();
  assert.deepEqual(calls.refresh, ["watch-stale"], "only the stale watch entry is refreshed, by id");
  assert.equal(calls.statuses, 2, "one recompute after a successful refresh so the cache goes fresh");
  const res = stubRes();
  await routes.handle(stubReq("GET", "/api/artifacts"), res);
  assert.equal(JSON.parse(res.body).artifacts.find((a) => a.id === "watch-stale").state, "stale", "the fake statuses keeps it stale — the payload still comes from the post-refresh recompute");
});

test("tick in the container only reports: refresh is never called", async () => {
  const { routes, calls } = makeRoutes({ inContainer: true });
  await routes.tick();
  await get(routes);
  assert.deepEqual(calls.refresh, []);
  assert.equal(calls.statuses, 1);
});

test("the lock prevents a second concurrent refresh", async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const { routes, calls } = makeRoutes({
    refreshImpl: ({ only }) => pending.then(() => {
      calls.refresh.push(only);
      return { refreshed: [{ id: only }], skipped: [], failed: [], manifestPath: "/tmp", head: null };
    }),
  });
  const first = routes.tick();
  const second = routes.tick(); // started while the first refresh is in flight
  release();
  await Promise.all([first, second]);
  assert.equal(calls.refresh.length, 1, "the second tick saw the lock and skipped its refresh");
});

test("a failing refresh does not throw and is logged once (retries stay silent)", async () => {
  const originalError = console.error;
  const errors = [];
  console.error = (line) => errors.push(String(line));
  try {
    const failing = () => {
      throw new Error("generator exploded");
    };
    const { routes } = makeRoutes({
      refreshImpl: failing,
      artifacts: [watchStale()],
    });
    await routes.tick(); // must not throw
    await routes.tick(); // the same failure again — the log stays quiet
  } finally {
    console.error = originalError;
  }
  assert.equal(errors.length, 1, "exactly one log line: the first failure, not every retry");
  assert.match(errors[0], /watch-stale/);
});

test("POST /api/artifacts is a 405, like the other routes' method mismatch", async () => {
  const { routes } = makeRoutes();
  const res = stubRes();
  const handled = await routes.handle(stubReq("POST", "/api/artifacts"), res);
  assert.equal(handled, true);
  assert.equal(res.status, 405);
  assert.deepEqual(JSON.parse(res.body), { error: "method not allowed" });
});

test("paths outside /api/artifacts are not ours: handle returns false", async () => {
  const { routes } = makeRoutes();
  const res = stubRes();
  assert.equal(await routes.handle(stubReq("GET", "/api/settings/keys"), res), false);
  assert.equal(res.status, null, "nothing was written to the response");
});

test("age reaches the client in milliseconds: the registry's seconds are converted, null passes through", async () => {
  const { routes } = makeRoutes({
    artifacts: [
      { ...watchStale(), age: 90 }, // 90 s
      { ...externalEntry(), age: null }, // nothing on disk to measure
    ],
  });
  const { body } = await get(routes);
  assert.equal(body.artifacts.find((a) => a.id === "watch-stale").age, 90_000, "90 s → 90 000 ms, the unit formatAge renders");
  assert.equal(body.artifacts.find((a) => a.id === "diagrams-png").age, null, "a null age stays null, never 0");
});

// ── the tick invariants pinned after the live incident (computedAt frozen) ───

// A routes instance with a mutable clock, so computedAt can be watched across
// ticks; every failure line is captured instead of hitting the test log.
function makeTimedRoutes({ refreshImpl, artifacts = [watchStale()] }) {
  let now = T0;
  const calls = { statuses: 0, refresh: 0 };
  const errors = [];
  const originalError = console.error;
  console.error = (...lines) => errors.push(lines.map(String).join(" "));
  const routes = createArtifactsRoutes({
    root: "/tmp/unused-root",
    manifestPath: "/tmp/unused/artifacts-manifest.json",
    statuses: ({ now: n }) => {
      calls.statuses += 1;
      return payload(artifacts, n ?? now);
    },
    refresh: refreshImpl
      ? (o) => refreshImpl(o)
      : () => {
          calls.refresh += 1;
          return { refreshed: [{ id: "watch-stale" }], skipped: [], failed: [], manifestPath: "/tmp/unused", head: null };
        },
    now: () => now,
  });
  const restore = (then) => {
    console.error = originalError;
    return then;
  };
  return { routes, calls, errors, advance: (ms) => { now += ms; }, now: () => now, restore };
}

test("after a failing refresh the next tick recomputes the cache (computedAt advances) and attempts the refresh again", async () => {
  const { routes, calls, errors, advance, restore } = makeTimedRoutes({
    refreshImpl: () => {
      calls.refresh += 1;
      throw new Error("generator exploded");
    },
  });
  try {
    const first = await routes.tick();
    assert.equal(calls.refresh, 1);
    assert.equal(first.computedAt, new Date(T0).toISOString());
    assert.equal(calls.statuses, 1);

    advance(30_000);
    const second = await routes.tick();
    assert.equal(calls.refresh, 2, "the next tick attempted the refresh again — the lock did not leak");
    assert.equal(second.computedAt, new Date(T0 + 30_000).toISOString(), "the status cache is recomputed at the START of every tick, whatever happened last time");
    assert.equal(errors.length, 1, "the same failure is still logged once per signature, relentless retries stay silent");
  } finally {
    restore();
  }
});

test("a refresh that throws synchronously releases the lock — the next refresh actually runs", async () => {
  // A synchronous throw, not a rejected promise — the shape that used to be
  // able to skip the finally and hold the lock forever.
  const calls = { refresh: 0 };
  let throwNext = true;
  const { routes, errors, restore } = makeTimedRoutes({
    refreshImpl: () => {
      calls.refresh += 1;
      if (throwNext) {
        throwNext = false;
        throw new Error("sync boom");
      }
      return { refreshed: [{ id: "watch-stale" }], skipped: [], failed: [], manifestPath: "/tmp/unused", head: null };
    },
  });
  try {
    await routes.tick(); // must resolve, never throw out of tick
    assert.equal(calls.refresh, 1);
    await routes.tick(); // a held lock would make `!refreshing` skip this one
    assert.equal(calls.refresh, 2, "the lock was released, the refresh was attempted again");
    assert.equal(errors.length, 1, "the sync throw was caught and logged once, not thrown out");
  } finally {
    restore();
  }
});

test("GET carries refreshStatus: { at, refreshed, failed }; null when no refresh was attempted", async () => {
  const { routes, calls } = makeRoutes({ artifacts: [watchStale()] });
  const { body } = await get(routes); // the empty-cache GET warms via tick()
  assert.equal(calls.refresh.length, 1);
  assert.deepEqual(body.refreshStatus, {
    at: new Date(T0).toISOString(),
    refreshed: 1,
    failed: [],
  });

  const fresh = makeRoutes({ artifacts: [watchFresh(), externalEntry()] });
  const noRefresh = await get(fresh.routes);
  assert.equal(calls.refresh.length, 1);
  assert.equal(noRefresh.body.refreshStatus, null, "no attempt made → refreshStatus stays null");
});

// ── the refresh is ASYNC (the incident that pinned this: a spawnSync inside
// tick froze the telemetry server's event loop — and every dashboard request —
// for the length of a ui/dist rebuild) ────────────────────────────────────────

test("a GET served during a pending async refresh returns immediately (the loop is free); the lock spans the whole promise", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const events = [];
  const { routes, calls } = makeRoutes({
    refreshImpl: async ({ only }) => {
      events.push(`start ${only}`);
      await gate; // parked: the refresh is in flight, the loop is free
      events.push(`end ${only}`);
      calls.refresh.push(only);
      return { refreshed: [{ id: only }], skipped: [], failed: [], manifestPath: "/tmp", head: null };
    },
  });

  const tickPromise = routes.tick(); // runs the statuses, then parks on the gated refresh
  const res = stubRes();
  const served = await routes.handle(stubReq("GET", "/api/artifacts"), res); // must complete WHILE the refresh is still parked
  assert.equal(served, true, "the GET completed during the pending refresh");
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body).artifacts.map((a) => a.id), ["watch-stale"]);

  release();
  await tickPromise;
  assert.deepEqual(events, ["start watch-stale", "end watch-stale"]);
  assert.deepEqual(calls.refresh, ["watch-stale"], "one refresh ran — the GET's inner tick saw the lock and skipped its own");
});

// A spawn stub for the DEFAULT refresh (no refresh injected): captures the
// child argv/env and emits a scripted result through the EventEmitter shape
// async spawn actually produces.
function stubSpawn(result) {
  const calls = [];
  const spawnImpl = (file, argv, opts) => {
    calls.push({ file, argv, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      if (result.error) {
        child.emit("error", result.error);
        return;
      }
      if (result.stdout !== undefined) child.stdout.emit("data", result.stdout);
      if (result.stderr !== undefined) child.stderr.emit("data", result.stderr);
      child.emit("close", result.code ?? 0);
    });
    return child;
  };
  return { spawnImpl, calls };
}

test("the default refresh runs the registry CLI as a child process: argv, cwd and manifest env asserted through the injectable spawnImpl", async () => {
  const CHILD_RESULT = JSON.stringify({
    refreshed: [{ id: "watch-stale", digest: "c".repeat(64), generatedAt: "x" }],
    skipped: [],
    failed: [],
    manifestPath: "/tmp/unused/artifacts-manifest.json",
    head: "a".repeat(40),
  }) + "\n";
  const { spawnImpl, calls } = stubSpawn({ stdout: CHILD_RESULT });
  const routes = createArtifactsRoutes({
    root: "R:/repo",
    manifestPath: "R:/state/artifacts-manifest.json",
    statuses: ({ now }) => payload([watchStale()], now ?? T0),
    spawnImpl,
    now: () => T0,
  });

  await routes.tick(); // must not throw; the parsed child result drives refreshStatus
  assert.equal(calls.length, 1, "the refresh spawned exactly one registry child");
  const { file, argv, opts } = calls[0];
  assert.equal(file, process.execPath);
  assert.match(argv[0], /artifact-registry\.mjs$/, "the child is the registry script itself");
  assert.deepEqual(
    argv.slice(1),
    ["refresh", "--only", "watch-stale", "--root", "R:/repo", "--json"],
    "refresh --only <id> --root <root> with a --json result the route parses",
  );
  assert.equal(opts.cwd, "R:/repo");
  assert.equal(opts.env.LA_ARTIFACTS_MANIFEST, "R:/state/artifacts-manifest.json");
});

test("a child that cannot be spawned rejects into tick's failure path: logged once, never thrown, visible in refreshStatus", async () => {
  const originalError = console.error;
  const errors = [];
  console.error = (line) => errors.push(String(line));
  try {
    const { spawnImpl } = stubSpawn({ error: new Error("enoent") });
    const routes = createArtifactsRoutes({
      root: "R:/repo",
      manifestPath: "R:/state/artifacts-manifest.json",
      statuses: ({ now }) => payload([watchStale()], now ?? T0),
      spawnImpl,
      now: () => T0,
    });
    await routes.tick(); // must not throw
    const { body } = await get(routes);
    assert.equal(errors.length, 1, "one log line for the spawn failure");
    assert.match(errors[0], /watch-stale/);
    assert.equal(body.refreshStatus.failed.length, 1);
    assert.match(body.refreshStatus.failed[0].error, /spawn failed: enoent/);
  } finally {
    console.error = originalError;
  }
});
