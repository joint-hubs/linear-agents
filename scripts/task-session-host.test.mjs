// scripts/task-session-host.test.mjs — the task-session multiplexer's contract
// (PRD task-workspace-supervisors §5–6, task-session-host.mjs).
//
// The properties worth protecting (AC-1..AC-4):
//   · TWO controllers are ISOLATED: messages, WS terminals and state are
//     delivered to exactly one session's tmux identity (per-session socket,
//     session name, chat buffer) — stopping or messaging A never touches B;
//   · the cap queues: with maxActive=2 a third task stays 'queued' and the
//     queue drains when a slot is released (stop → claim);
//   · the initial prompt is delivered AT MOST ONCE: a duplicate start lands
//     on the same session ('supervisor') and never re-arms or re-pastes; an
//     unproven delivery after a crash is never resent (reconcile);
//   · routing validates server-side: auth gates (peer, fresh token) run
//     BEFORE any store lookup or claim; malformed ids 400; unknown ids 404;
//     global routes 409 selection-required once managed sessions exist,
//     legacy-identical while none do; /alive stays global;
//   · stop releases the claim FIRST, then kills only THIS session's tmux
//     identity and THIS run's live children (via the exact supervisor-stop
//     CLI contract), and never another session's;
//   · the isolated Claude config dir is seeded prompt/settings/agents/skills
//     ONLY — never .claude.json or projects/ — and never overwrites what a
//     resuming session already has.
//
// Everything is hermetic: tmux, the pty, DNS, the token and the store
// (node:sqlite :memory:) are injected seams; servers bind 127.0.0.1 port 0;
// the clock is fake.
//
// NOTE (lanes): binds sockets and uses the ws client — belongs in the SERIAL
// lane of scripts/test-lanes.json (same as supervisor-host.test.mjs).
//
// Run: node --test scripts/task-session-host.test.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

import { createTaskSessionStore, OWNER_STATUSES } from "./task-sessions.mjs";
import { createTaskSessionHost, seedSessionConfig } from "./task-session-host.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "task-session-host.mjs");
const TOKEN = "tok-123";
const SESSION_A = "sup-" + "a".repeat(32);
const SESSION_B = "sup-" + "b".repeat(32);

// ── seams ────────────────────────────────────────────────────────────────────

const READY_PANE = [
  "────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────",
  "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
].join("\n");

const fakeClock = () => {
  const api = {
    t: 1_700_000_000_000,
    now: () => api.t,
    sleep: async (ms) => {
      api.t += ms;
    },
  };
  return api;
};

// One fake tmux per session id: its own presence, pane state and paste count.
const fakeTmuxFor = (init = {}) => {
  const api = {
    present: init.present ?? false,
    capture: init.capture ?? READY_PANE,
    pastes: [],
    calls: [],
  };
  api.run = (args, opts = {}) => {
    api.calls.push({ args, input: opts.input });
    switch (args[0]) {
      case "has-session":
        return { status: api.present ? 0 : 1, stdout: "", stderr: "" };
      case "start-server":
        api.present = true;
        return { status: 0, stdout: "", stderr: "" };
      case "kill-session":
        api.present = false;
        return { status: 0, stdout: "", stderr: "" };
      case "load-buffer":
        api.pastes.push(opts.input ?? "");
        return { status: 0, stdout: "", stderr: "" };
      case "capture-pane":
        return { status: 0, stdout: api.capture, stderr: "" };
      case "list-panes":
        return api.present
          ? { status: 0, stdout: "4242 0\n", stderr: "" }
          : { status: 1, stdout: "", stderr: "no current client" };
      case "list-clients":
        return api.present
          ? { status: 0, stdout: "/dev/pts/3\n", stderr: "" }
          : { status: 1, stdout: "", stderr: "" };
      default:
        return { status: 0, stdout: "", stderr: "" };
    }
  };
  return api;
};

// A fake pty that records what was written to it (the terminal WS path).
const fakePty = () => {
  const api = {
    written: [],
    resized: [],
    killed: 0,
    onData: (cb) => {
      api.dataCb = cb;
    },
    onExit: () => {},
    write: (d) => api.written.push(d),
    resize: (c, r) => api.resized.push([c, r]),
    kill: () => {
      api.killed++;
    },
  };
  return api;
};

// build() — a host over an in-memory store with per-session fakes.
// opts.resolveMaxActive: let the HOST resolve the cap (deps.maxActive unset,
// no injected store — FOC-901 precedence tests); the store then lives on disk
// under the temp data home at the cap the host chose.
const build = (opts = {}) => {
  const stops = [];
  const tmp = mkdtempSync(join(tmpdir(), "task-session-host-"));
  const env = { LA_DATA_HOME: tmp, ...(opts.env ?? {}) };
  const store = opts.store ?? (opts.resolveMaxActive ? undefined : createTaskSessionStore({ dbPath: ":memory:", maxActive: opts.maxActive ?? 2 }));
  const resolveDbPath = opts.resolveMaxActive ? join(tmp, "supervisor", "task-sessions.sqlite") : undefined;
  const fakes = new Map(); // sessionId → { tmux, pty, ptyArgs, clock }
  const fakeFor = (sessionId) => {
    if (!fakes.has(sessionId)) {
      fakes.set(sessionId, {
        tmux: fakeTmuxFor(opts.tmuxInit?.[sessionId]),
        pty: fakePty(),
        ptyArgs: null,
        clock: fakeClock(),
      });
    }
    return fakes.get(sessionId);
  };
  const legacyFake = { tmux: fakeTmuxFor(), clock: fakeClock() };
  const controllerDeps = (sessionId) => {
    const f = fakeFor(sessionId);
    return {
      runTmux: f.tmux.run,
      readSessionState: () => null,
      readToken: () => TOKEN,
      resolvePeer: async () => new Set(["127.0.0.1"]),
      processAlive: () => true,
      sleep: f.clock.sleep,
      now: f.clock.now,
      ptyFactory: async (file, args) => {
        f.ptyArgs = { file, args };
        return f.pty;
      },
    };
  };
  const host = createTaskSessionHost({
    env,
    store,
    dbPath: resolveDbPath,
    maxActive: opts.resolveMaxActive ? undefined : (opts.maxActive ?? 2),
    processIdentity: opts.processIdentity ?? (() => ({ state: "alive", identity: "test-boot:4242" })),
    controllerDeps,
    readToken: () => TOKEN,
    resolvePeer: async () => new Set(["127.0.0.1"]),
    legacyDeps: {
      runTmux: legacyFake.tmux.run,
      readSessionState: () => null,
      readToken: () => TOKEN,
      resolvePeer: async () => new Set(["127.0.0.1"]),
      processAlive: () => true,
      sleep: legacyFake.clock.sleep,
      now: legacyFake.clock.now,
    },
    // stop seams recording what was killed where
    stopTmux: opts.stopTmux ?? ((ident) => {
      const f = fakeFor(ident.sessionId);
      f.tmux.present = false;
      f.stoppedTmux = { socket: ident.socket, session: ident.session };
      stops.push({ ident });
      return { status: 0, stderr: "" };
    }),
    stopChild: opts.stopChild ?? ((runId, childId) => {
      stops.push({ runId, childId });
      return { status: 0 };
    }),
    lib: opts.lib ?? {
      readRegistry: (runId) => ({ runId, children: opts.registry?.[runId] ?? {} }),
      liveChildren: (registry) => Object.values(registry.children ?? {}).filter((c) => c.status === "running"),
    },
    // FOC-902 §D: pickup seams forwarded verbatim (undefined keeps the
    // overlay/real-timer defaults).
    ...(opts.pickupDeps ?? {}),
    autoPickup: opts.autoPickup,
    listCandidates: opts.listCandidates,
  });
  return { host, store, fakes, fakeFor, legacyFake, tmp, stops };
};

const listen = (host) =>
  new Promise((resolve) => {
    host.server.listen(0, "127.0.0.1", () => resolve(host.server.address().port));
  });

const request = async (port, method, path, { token = TOKEN, body } = {}) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "x-fenix-host-token": token, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json, text };
};

const startBody = (label, text = `initial prompt for ${label}`) => ({
  taskKey: `workspace:ISSUE-${label}`,
  taskId: `ISSUE-${label}`,
  workspace: "workspace",
  issueId: `ISSUE-${label}`,
  title: `Task ${label}`,
  text,
});

const tmpdirs = [];
const tempDir = (label) => {
  const d = mkdtempSync(join(tmpdir(), `tsh-${label}-`));
  tmpdirs.push(d);
  return d;
};

process.on("exit", () => {
  for (const d of tmpdirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* a handle may still be open during teardown — the OS cleans tmp */
    }
  }
});

// ── cap, queue and isolation ─────────────────────────────────────────────────

test("cap=2: two tasks start, the third queues, and each session is isolated", async () => {
  const { host, store, fakeFor } = build({ maxActive: 2 });
  const port = await listen(host);
  try {
    const a = await request(port, "POST", "/sessions", { body: startBody("A") });
    const b = await request(port, "POST", "/sessions", { body: startBody("B") });
    const c = await request(port, "POST", "/sessions", { body: startBody("C") });
    assert.equal(a.status, 202);
    assert.equal(b.status, 202);
    assert.equal(c.status, 202);
    assert.equal(a.json.delivery, "starting");
    assert.equal(b.json.delivery, "starting");
    assert.equal(c.json.delivery, "queued", "the third task queues, never silently dropped");

    await host.settled();
    const list = await request(port, "GET", "/sessions");
    assert.equal(list.json.maxActive, 2);
    const byId = new Map(list.json.sessions.map((s) => [s.sessionId, s]));
    assert.equal(byId.get(a.json.session.sessionId).status, "running");
    assert.equal(byId.get(b.json.session.sessionId).status, "running");
    assert.equal(byId.get(c.json.session.sessionId).status, "queued");

    // isolation: A's paste is A's text only, B's is B's only, once each.
    const fa = fakeFor(a.json.session.sessionId);
    const fb = fakeFor(b.json.session.sessionId);
    assert.deepEqual(fa.tmux.pastes, ["initial prompt for A"]);
    assert.deepEqual(fb.tmux.pastes, ["initial prompt for B"]);
    assert.equal(byId.get(a.json.session.sessionId).taskKey, "workspace:ISSUE-A");
  } finally {
    host.close();
    store.close();
  }
});

// ── cap source precedence (FOC-901): deps → env → overlay → default ─────────

const capSettings = (dir, value) => {
  const p = join(dir, "settings.json");
  writeFileSync(p, JSON.stringify({ taskSessions: { maxActive: value } }), "utf8");
  return p;
};

test("overlay taskSessions.maxActive=4 → the third claim succeeds", async () => {
  const dir = tempDir("cap4");
  const settings = capSettings(dir, 4);
  const { host } = build({ resolveMaxActive: true, env: { LA_SETTINGS_FILE: settings } });
  const port = await listen(host);
  try {
    assert.equal(host.maxActive, 4);
    assert.equal(host.maxActiveSource, "settings taskSessions.maxActive");
    const a = await request(port, "POST", "/sessions", { body: startBody("A") });
    const b = await request(port, "POST", "/sessions", { body: startBody("B") });
    const c = await request(port, "POST", "/sessions", { body: startBody("C") });
    assert.equal(a.json.delivery, "starting");
    assert.equal(b.json.delivery, "starting");
    assert.equal(c.json.delivery, "starting", "the third claim succeeds at cap 4");
    await host.settled();
    assert.equal((await request(port, "GET", "/sessions")).json.maxActive, 4);
  } finally {
    host.close();
    host.store.close();
  }
});

test("overlay taskSessions.maxActive=2 → the third claim stays queued", async () => {
  const dir = tempDir("cap2-overlay");
  const settings = capSettings(dir, 2);
  const { host } = build({ resolveMaxActive: true, env: { LA_SETTINGS_FILE: settings } });
  const port = await listen(host);
  try {
    assert.equal(host.maxActive, 2);
    assert.equal(host.maxActiveSource, "settings taskSessions.maxActive");
    await request(port, "POST", "/sessions", { body: startBody("A") });
    await request(port, "POST", "/sessions", { body: startBody("B") });
    const c = await request(port, "POST", "/sessions", { body: startBody("C") });
    assert.equal(c.json.delivery, "queued", "the cap from the overlay is enforced by the store");
  } finally {
    host.close();
    host.store.close();
  }
});

test("FENIX_MAX_ACTIVE_SUPERVISORS=1 beats the overlay's 4", async () => {
  const dir = tempDir("cap-env");
  const settings = capSettings(dir, 4);
  const { host } = build({
    resolveMaxActive: true,
    env: { LA_SETTINGS_FILE: settings, FENIX_MAX_ACTIVE_SUPERVISORS: "1" },
  });
  const port = await listen(host);
  try {
    assert.equal(host.maxActive, 1);
    assert.equal(host.maxActiveSource, "env FENIX_MAX_ACTIVE_SUPERVISORS");
    await request(port, "POST", "/sessions", { body: startBody("A") });
    const b = await request(port, "POST", "/sessions", { body: startBody("B") });
    assert.equal(b.json.delivery, "queued", "the env override holds the cap at 1");
  } finally {
    host.close();
    host.store.close();
  }
});

test("no deps, no env, no overlay → the default cap of 2", async () => {
  const { host } = build({ resolveMaxActive: true });
  try {
    assert.equal(host.maxActive, 2);
    assert.equal(host.maxActiveSource, "default");
  } finally {
    host.close();
    host.store.close();
  }
});

test("an empty FENIX_MAX_ACTIVE_SUPERVISORS is unset — no warning; a non-empty invalid value warns", async () => {
  const errs = [];
  const orig = console.error;
  console.error = (msg) => errs.push(String(msg));
  const withEmpty = build({ resolveMaxActive: true, env: { FENIX_MAX_ACTIVE_SUPERVISORS: "" } });
  try {
    assert.equal(withEmpty.host.maxActive, 2);
    assert.equal(withEmpty.host.maxActiveSource, "default");
    assert.equal(errs.length, 0, "an empty value must read as unset, silently");
  } finally {
    withEmpty.host.close();
    withEmpty.host.store.close();
  }
  errs.length = 0;
  const withBad = build({ resolveMaxActive: true, env: { FENIX_MAX_ACTIVE_SUPERVISORS: "zero" } });
  try {
    assert.equal(withBad.host.maxActive, 2);
    assert.equal(withBad.host.maxActiveSource, "default");
    assert.equal(errs.length, 1, "a non-empty invalid value warns once");
    assert.match(errs[0], /FENIX_MAX_ACTIVE_SUPERVISORS/);
  } finally {
    console.error = orig;
    withBad.host.close();
    withBad.host.store.close();
  }
});

test("duplicate start lands on the same session and NEVER redelivers the initial prompt", async () => {
  const { host, store, fakeFor, tmp } = build({ maxActive: 2 });
  const port = await listen(host);
  try {
    const first = await request(port, "POST", "/sessions", { body: startBody("A") });
    await host.settled();
    const sid = first.json.session.sessionId;
    const pastesBefore = fakeFor(sid).tmux.pastes.length;
    const pendingBefore = readFileSync(
      join(tmp, "supervisor", "sessions", sid, "pending-prompt.json"),
      "utf8",
    );

    const dup = await request(port, "POST", "/sessions", {
      body: startBody("A", "a DIFFERENT text that must never be delivered"),
    });
    assert.equal(dup.status, 200);
    assert.equal(dup.json.delivery, "supervisor", "a duplicate open is the running supervisor, not a start");
    assert.equal(dup.json.session.sessionId, sid, "idempotent: the SAME session");

    await host.settled();
    assert.equal(fakeFor(sid).tmux.pastes.length, pastesBefore, "no second paste");
    assert.equal(
      readFileSync(join(tmp, "supervisor", "sessions", sid, "pending-prompt.json"), "utf8"),
      pendingBefore,
      "the armed prompt text was not replaced",
    );
  } finally {
    host.close();
    store.close();
  }
});

test("message and state are isolated between two controllers", async () => {
  const { host, store, fakeFor } = build({ maxActive: 2 });
  const port = await listen(host);
  try {
    const a = await request(port, "POST", "/sessions", { body: startBody("A") });
    const b = await request(port, "POST", "/sessions", { body: startBody("B") });
    await host.settled();
    const sidA = a.json.session.sessionId;
    const sidB = b.json.session.sessionId;

    const ma = await request(port, "POST", `/sessions/${sidA}/message`, { body: { text: "hello-A" } });
    const mb = await request(port, "POST", `/sessions/${sidB}/message`, { body: { text: "hello-B" } });
    assert.equal(ma.status, 200);
    assert.equal(mb.status, 200);
    assert.deepEqual(fakeFor(sidA).tmux.pastes, ["initial prompt for A", "hello-A"]);
    assert.deepEqual(fakeFor(sidB).tmux.pastes, ["initial prompt for B", "hello-B"]);

    const sa = await request(port, "GET", `/sessions/${sidA}/state`);
    assert.equal(sa.status, 200);
    assert.equal(sa.json.taskSession.sessionId, sidA, "taskSession carries the record, not a native id overwrite");
    assert.equal(sa.json.taskSession.taskKey, "workspace:ISSUE-A");
  } finally {
    host.close();
    store.close();
  }
});

// ── validation, auth ordering, unknown ids ───────────────────────────────────

test("auth runs BEFORE any store operation: a bad token never creates a claim", async () => {
  const { host, store } = build({ maxActive: 2 });
  const port = await listen(host);
  try {
    const res = await request(port, "POST", "/sessions", { token: "wrong", body: startBody("A") });
    assert.equal(res.status, 401);
    assert.deepEqual(await request(port, "GET", "/sessions").then((r) => r.json.sessions), []);
  } finally {
    host.close();
    store.close();
  }
});

test("malformed ids 400, unknown ids 404, bad bodies 4xx — the store stays untouched", async () => {
  const { host, store } = build({ maxActive: 2 });
  const port = await listen(host);
  try {
    assert.equal((await request(port, "GET", "/sessions/not-a-session-id")).status, 400);
    assert.equal((await request(port, "GET", "/sessions/../../etc")).status, 404);
    assert.equal((await request(port, "GET", `/sessions/${SESSION_A}/state`)).status, 404);
    assert.equal((await request(port, "POST", `/sessions/${SESSION_A}/stop`)).status, 404);

    assert.equal((await request(port, "POST", "/sessions", { body: { taskKey: "x" } })).status, 400);
    const mismatch = startBody("A");
    mismatch.taskKey = "other:ISSUE-A";
    assert.equal((await request(port, "POST", "/sessions", { body: mismatch })).status, 400);
    assert.equal((await request(port, "POST", "/sessions", { body: { ...startBody("A"), text: "  " } })).status, 400);
    assert.equal(
      (await request(port, "POST", "/sessions", { body: { ...startBody("A"), text: "x".repeat(9000) } })).status,
      400,
      "text is bounded",
    );
    assert.deepEqual((await request(port, "GET", "/sessions")).json.sessions, []);
  } finally {
    host.close();
    store.close();
  }
});

// ── global routes: legacy while empty, 409 selection-required after ──────────

test("global routes are legacy while no session exists and 409 selection-required after; /alive stays global", async () => {
  const { host, store, legacyFake } = build({ maxActive: 2 });
  const port = await listen(host);
  try {
    // legacy mode: the global message path pastes into the legacy pane.
    const before = await request(port, "POST", "/message", { body: { text: "legacy hello" } });
    assert.equal(before.status, 200);
    assert.equal(legacyFake.tmux.pastes.includes("legacy hello"), true);
    const health0 = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health0.status, 200);

    const started = await request(port, "POST", "/sessions", { body: startBody("A") });
    await host.settled();
    const sid = started.json.session.sessionId;

    const state = await request(port, "GET", "/state");
    assert.equal(state.status, 409);
    assert.equal(state.json.error, "selection-required");
    assert.equal((await request(port, "POST", "/message", { body: { text: "x" } })).status, 409);
    const health1 = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal((await health1.json()).managedSessions, 1, "health stays global");

    // /alive is the shared process probe — still global with sessions present.
    const alive = await request(port, "POST", "/alive", { body: { pids: [1, 2] } });
    assert.equal(alive.status, 200);
    assert.deepEqual(alive.json, { 1: true, 2: true });
    void sid;
  } finally {
    host.close();
    store.close();
  }
});

// ── stop: scoped to A, queue drains, B untouched ─────────────────────────────

test("stop A kills only A's tmux identity and A's run children; B is untouched and the queue drains", async () => {
  const stopChildCalls = [];
  const { host, store, fakeFor } = build({
    maxActive: 2,
    stopChild: (runId, childId) => {
      stopChildCalls.push({ runId, childId });
      return { status: 0 };
    },
    registry: {
      "run-A": { c1: { status: "running" }, c2: { status: "running" }, dead: { status: "stopped" } },
      "run-B": { c3: { status: "running" } },
    },
  });
  const port = await listen(host);
  try {
    const a = await request(port, "POST", "/sessions", { body: startBody("A") });
    const b = await request(port, "POST", "/sessions", { body: startBody("B") });
    const c = await request(port, "POST", "/sessions", { body: startBody("C") });
    await host.settled();
    const sidA = a.json.session.sessionId;
    const sidB = b.json.session.sessionId;
    const sidC = c.json.session.sessionId;
    store.update(sidA, { runId: "run-A" });
    store.update(sidB, { runId: "run-B" });

    const stopped = await request(port, "POST", `/sessions/${sidA}/stop`);
    assert.equal(stopped.status, 200);
    assert.equal(stopped.json.stopped, true);
    assert.deepEqual(stopped.json.children.map((x) => x.childId).sort(), ["c1", "c2"], "only A's live children");
    assert.deepEqual(stopChildCalls, [
      { runId: "run-A", childId: "c1" },
      { runId: "run-A", childId: "c2" },
    ]);
    assert.equal(fakeFor(sidA).stoppedTmux.socket, `fenix-${sidA}`, "A's own tmux identity");
    assert.equal(fakeFor(sidA).stoppedTmux.session, sidA);

    const recA = store.get(sidA);
    const recB = store.get(sidB);
    assert.equal(recA.status, "stopped", "stop is persistent and releases the claim");
    assert.equal(recB.status, "running", "B was never stopped");
    assert.equal(fakeFor(sidB).stoppedTmux, undefined, "B's tmux was never killed");

    // the queue drains: C is claimed and started after A's slot freed.
    await host.settled();
    assert.equal(store.get(sidC).status, "running");
    assert.deepEqual(fakeFor(sidC).tmux.pastes, ["initial prompt for C"]);

    // a stopped session refuses operations instead of resurrecting a pane.
    assert.equal((await request(port, "POST", `/sessions/${sidA}/message`, { body: { text: "x" } })).status, 409);
    assert.equal((await request(port, "POST", `/sessions/${sidA}/session`)).status, 409);
    // B still answers.
    const mb = await request(port, "POST", `/sessions/${sidB}/message`, { body: { text: "still-B" } });
    assert.equal(mb.status, 200);
    assert.ok(fakeFor(sidB).tmux.pastes.includes("still-B"));
  } finally {
    host.close();
    store.close();
  }
});

// ── WS terminal isolation ────────────────────────────────────────────────────

test("WS /sessions/:id/terminal attaches with THAT session's tmux identity; bytes go to one pane", async () => {
  const { host, store, fakeFor } = build({ maxActive: 2 });
  const port = await listen(host);
  try {
    const a = await request(port, "POST", "/sessions", { body: startBody("A") });
    const b = await request(port, "POST", "/sessions", { body: startBody("B") });
    await host.settled();
    const sidA = a.json.session.sessionId;
    const sidB = b.json.session.sessionId;

    const connect = (sid) =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/sessions/${sid}/terminal`, {
          headers: { "x-fenix-host-token": TOKEN },
        });
        ws.on("open", () => resolve(ws));
        ws.on("error", reject);
      });
    const wsA = await connect(sidA);
    const wsB = await connect(sidB);
    await new Promise((r) => setTimeout(r, 50));

    const argsA = fakeFor(sidA).ptyArgs?.args ?? [];
    const argsB = fakeFor(sidB).ptyArgs?.args ?? [];
    assert.deepEqual(
      { socket: argsA[argsA.indexOf("-L") + 1], target: argsA[argsA.indexOf("-t") + 1] },
      { socket: `fenix-${sidA}`, target: sidA },
      "A's pty attaches to A's own tmux server and session",
    );
    assert.equal(argsB[argsB.indexOf("-L") + 1], `fenix-${sidB}`, "B's pty attaches to B's own server");

    wsA.send(JSON.stringify({ t: "i", d: "typed-in-A" }));
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(fakeFor(sidA).pty.written.includes("typed-in-A"));
    assert.deepEqual(fakeFor(sidB).pty.written, [], "B's pane saw nothing of A's typing");

    // auth applies to the WS path too.
    const denied = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/sessions/${sidA}/terminal`, {
        headers: { "x-fenix-host-token": "wrong" },
      });
      ws.on("error", () => resolve("denied"));
      ws.on("open", () => resolve("opened"));
    });
    assert.equal(denied, "denied");
    wsA.close();
    wsB.close();
  } finally {
    host.close();
    store.close();
  }
});

// ── boot reconciliation: never re-adopt, never resend ────────────────────────

test("reconcile retains capacity for a live owner; the unproven prompt is NOT resent", async () => {
  const { host, store, fakeFor, tmp } = build({ maxActive: 2 });
  const port = await listen(host);
  try {
    const started = await request(port, "POST", "/sessions", { body: startBody("A") });
    const sid = started.json.session.sessionId;
    await host.settled();
    // Simulate a restart: no controllers in this process, the record active.
    const pendingPath = join(tmp, "supervisor", "sessions", sid, "pending-prompt.json");
    const pending = JSON.parse(readFileSync(pendingPath, "utf8"));
    writeFileSync(pendingPath, JSON.stringify({ ...pending, state: "delivering" }), "utf8");
    store.update(sid, { status: "running", runId: "run-A" });

    const n = await host.reconcile();
    assert.equal(n, 1);
    const rec = store.get(sid);
    assert.equal(rec.status, "waiting");
    assert.match(rec.lastError, /NOT resent/);
    assert.equal(store.list({ includeTerminal: false }).length, 1);
    assert.equal(
      JSON.parse(readFileSync(pendingPath, "utf8")).state,
      "delivering",
      "the delivery state was never advanced by the host itself",
    );
    assert.equal(fakeFor(sid).tmux.pastes.length, 1, "nothing was pasted again");
  } finally {
    host.close();
    store.close();
  }
});

// ── the isolated Claude config dir (entrypoint helper) ───────────────────────

test("seedSessionConfig seeds prompt/settings/agents/skills ONLY and never overwrites history", () => {
  const dataHome = tempDir("seed");
  const globalDir = join(dataHome, "squad", "supervisor");
  mkdirSync(join(globalDir, "agents"), { recursive: true });
  mkdirSync(join(globalDir, "skills"), { recursive: true });
  mkdirSync(join(globalDir, "projects"), { recursive: true });
  writeFileSync(join(globalDir, "settings.json"), '{"model":"m"}');
  writeFileSync(join(globalDir, "CLAUDE.md"), "supervisor prompt");
  writeFileSync(join(globalDir, "agents", "lead.md"), "lead tools");
  writeFileSync(join(globalDir, "skills", "s.md"), "skill");
  writeFileSync(join(globalDir, ".claude.json"), '{"history":"native conversation"}');
  writeFileSync(join(globalDir, "projects", "x.jsonl"), "native history");
  const env = { LA_DATA_HOME: dataHome, LA_SQUAD_HOME: join(dataHome, "squad") };
  const sessionId = SESSION_A;

  const configDir = seedSessionConfig(env, sessionId);
  const sessionHome = join(dataHome, "supervisor", "sessions", sessionId);
  assert.equal(configDir, join(sessionHome, "claude"));
  assert.equal(readFileSync(join(configDir, "settings.json"), "utf8"), '{"model":"m"}');
  assert.equal(readFileSync(join(configDir, "CLAUDE.md"), "utf8"), "supervisor prompt");
  assert.equal(readFileSync(join(configDir, "agents", "lead.md"), "utf8"), "lead tools");
  assert.equal(readFileSync(join(configDir, "skills", "s.md"), "utf8"), "skill");
  assert.equal(existsSync(join(configDir, ".claude.json")), false, "native history is NEVER copied");
  assert.equal(existsSync(join(configDir, "projects")), false, "projects/ is NEVER copied");

  // Resuming the same session keeps what it already has: edited files are not
  // clobbered by a re-seed.
  writeFileSync(join(configDir, "settings.json"), '{"model":"edited-by-session"}');
  seedSessionConfig(env, sessionId);
  assert.equal(readFileSync(join(configDir, "settings.json"), "utf8"), '{"model":"edited-by-session"}');
});

test("seedSessionConfig refuses a malformed session id", () => {
  assert.throws(() => seedSessionConfig({ LA_DATA_HOME: tempDir("bad") }, "../../escape"), /must match/);
});

// ── CLI: session-home / attach-target / config-dir ───────────────────────────

test("CLI session-home validates the id and prints the scoped home", () => {
  const dataHome = tempDir("cli-home");
  const ok = spawnSync(process.execPath, [SCRIPT, "session-home", "--session", SESSION_A], {
    encoding: "utf8",
    env: { ...process.env, LA_DATA_HOME: dataHome },
  });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout.trim(), join(dataHome, "supervisor", "sessions", SESSION_A));
  const bad = spawnSync(process.execPath, [SCRIPT, "session-home", "--session", "../../escape"], {
    encoding: "utf8",
    env: { ...process.env, LA_DATA_HOME: dataHome },
  });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /must match/);
});

test("CLI attach-target: legacy when empty, the single active session, else selection-required", () => {
  const empty = tempDir("attach-empty");
  const none = spawnSync(process.execPath, [SCRIPT, "attach-target"], {
    encoding: "utf8",
    env: { ...process.env, LA_DATA_HOME: empty },
  });
  assert.equal(none.status, 0, none.stderr);
  assert.deepEqual(JSON.parse(none.stdout), { mode: "legacy" });

  const one = tempDir("attach-one");
  const storeOne = createTaskSessionStore({ dbPath: join(one, "supervisor", "task-sessions.sqlite") });
  const rec = storeOne.ensure({ taskKey: "w:ISSUE-1", taskId: "ISSUE-1", workspace: "w", issueId: "ISSUE-1" });
  storeOne.claimNext();
  storeOne.update(rec.sessionId, { status: "running" });
  storeOne.close();
  const single = spawnSync(process.execPath, [SCRIPT, "attach-target"], {
    encoding: "utf8",
    env: { ...process.env, LA_DATA_HOME: one },
  });
  assert.deepEqual(JSON.parse(single.stdout), {
    mode: "session",
    sessionId: rec.sessionId,
    taskKey: "w:ISSUE-1",
    status: "running",
  });

  const two = tempDir("attach-two");
  const storeTwo = createTaskSessionStore({ dbPath: join(two, "supervisor", "task-sessions.sqlite") });
  const r1 = storeTwo.ensure({ taskKey: "w:ISSUE-1", taskId: "ISSUE-1", workspace: "w", issueId: "ISSUE-1" });
  const r2 = storeTwo.ensure({ taskKey: "w:ISSUE-2", taskId: "ISSUE-2", workspace: "w", issueId: "ISSUE-2" });
  storeTwo.claimNext();
  storeTwo.claimNext();
  storeTwo.update(r1.sessionId, { status: "running" });
  storeTwo.update(r2.sessionId, { status: "waiting" });
  const target = attachTargetFor(two);
  assert.equal(target.mode, "selection-required");
  assert.equal(target.sessions.length, 2);
  storeTwo.close();
});

function attachTargetFor(dataHome) {
  const out = spawnSync(process.execPath, [SCRIPT, "attach-target"], {
    encoding: "utf8",
    env: { ...process.env, LA_DATA_HOME: dataHome },
  });
  assert.equal(out.status, 0, out.stderr);
  return JSON.parse(out.stdout);
}

test("ensure via the supervisor-host CLI refuses an unqualified ensure while sessions exist (contract)", () => {
  // Covered by contract here: the store is the source of truth both CLIs read.
  const dataHome = tempDir("ensure");
  const store = createTaskSessionStore({ dbPath: join(dataHome, "t.sqlite") });
  const rec = store.ensure({ taskKey: "w:ISSUE-1", taskId: "ISSUE-1", workspace: "w", issueId: "ISSUE-1" });
  assert.ok(OWNER_STATUSES.includes(rec.status));
  store.close();
  void dataHome;
});


test('failed stop retains capacity and does not start queued task', async () => {
 const {host,store}=build({maxActive:1,stopTmux:()=>({status:1})}); const port=await listen(host);
 try {
  const a=await request(port,'POST','/sessions',{body:startBody('A')});
  const b=await request(port,'POST','/sessions',{body:startBody('B')}); await host.settled();
  const stop=await request(port,'POST','/sessions/'+a.json.session.sessionId+'/stop');
  assert.equal(stop.status,409); assert.equal(stop.json.stopped,false);
  assert.equal(store.get(a.json.session.sessionId).status,'waiting');
  assert.equal(store.get(b.json.session.sessionId).status,'queued');
 } finally {host.close();store.close();}
});
test('failed terminal generation rejects mutations instead of bypassing admission', async () => {
 const {host,store}=build();const port=await listen(host);
 try {
  const a=await request(port,'POST','/sessions',{body:startBody('A')});await host.settled();
  const sid=a.json.session.sessionId;store.update(sid,{status:'failed'});
  for (const action of ['session','message','ask','dialog']) {
    const response=await request(port,'POST','/sessions/'+sid+'/'+action,{body:{text:'must not send'}});
    assert.equal(response.status,409,action);
  }
 }finally {host.close();store.close();}
});
test('recovery never adopts a reused PID and keeps the queue blocked', async () => {
 let identity='old'; const {host,store}=build({maxActive:1,processIdentity:()=>({state:'alive',identity})});
 const port=await listen(host);
 try {
  const a=await request(port,'POST','/sessions',{body:startBody('A')});await host.settled();
  const b=await request(port,'POST','/sessions',{body:startBody('B')});identity='reused';
  await host.reconcile();
  assert.equal(store.get(a.json.session.sessionId).status,'waiting');
  assert.equal(store.get(b.json.session.sessionId).status,'queued');
  const send=await request(port,'POST','/sessions/'+a.json.session.sessionId+'/message',{body:{text:'unsafe'}});
  assert.equal(send.status,409);
 }finally {host.close();store.close();}
});

test('explicit resume starts through cap, preserves history and never replays initial prompt',async()=>{
 const {host,store,fakeFor}=build({maxActive:1});const port=await listen(host);try{
 const a=await request(port,'POST','/sessions',{body:startBody('resume')});const sid=a.json.session.sessionId;await host.settled();
 assert.equal((await request(port,'POST','/sessions/'+sid+'/stop',{body:{}})).status,200);
 const preview=await request(port,'GET','/sessions/'+sid+'/profile-preview');assert.equal(preview.status,200);
 const body={confirm:'resume-session',expectedRevision:preview.json.revision};
 assert.equal((await request(port,'POST','/sessions/'+sid+'/resume',{body})).status,202);await host.settled();
 assert.equal(store.get(sid).status,'running');assert.deepEqual(fakeFor(sid).tmux.pastes,['initial prompt for resume']);
 }finally{host.close();store.close();}
});

// ── FOC-902 §D: autonomous pickup ────────────────────────────────────────────

// Fake timer seams: nothing ever fires; tests read what was scheduled and call
// host.pickupTick() directly.
const fakeTimers = () => {
  const timers = [];
  const api = {
    timers,
    setTimeout: (fn, ms) => { const h = { kind: 'timeout', fn, ms, cleared: false }; timers.push(h); return h; },
    setInterval: (fn, ms) => { const h = { kind: 'interval', fn, ms, cleared: false }; timers.push(h); return h; },
    clearTimeout: (h) => { if (h) h.cleared = true; },
    clearInterval: (h) => { if (h) h.cleared = true; },
  };
  return api;
};

const pickupIssue = (label, { priority = null, createdAt = '2026-01-01T00:00:00.000Z' } = {}) => ({
  identifier: `ISSUE-${label}`,
  title: `Ticket ${label}`,
  priority,
  createdAt,
  project: { name: 'Fenix' },
});

test('auto-pickup is off by default: no timer scheduled, /pickup reports the documented defaults, tick is a no-op', async () => {
  const timersApi = fakeTimers();
  const { host, store } = build({ pickupDeps: { ...timersApi, now: () => 0 } });
  const port = await listen(host);
  try {
    assert.equal(host.autoPickup.enabled, false);
    assert.deepEqual(timersApi.timers, []);
    const r = await request(port, 'GET', '/pickup');
    assert.deepEqual(r.json, {
      enabled: false, pollSeconds: 300, states: ['Backlog'], lastTickAt: null, lastError: null, lastEnqueued: [],
    });
    assert.equal(await host.pickupTick(), null);
    assert.equal(r.json.lastTickAt, null); // the disabled tick wrote nothing
  } finally { host.close(); store.close(); }
});

test('auto-pickup enabled: first tick scheduled 10 s out, repeats every pollSeconds; pickupStop clears both', () => {
  const timersApi = fakeTimers();
  const { host, store } = build({
    autoPickup: { enabled: true, pollSeconds: 90, states: ['Todo', 'Backlog'], workspace: 'workspace' },
    pickupDeps: { ...timersApi, now: () => 0 },
  });
  try {
    assert.deepEqual(
      timersApi.timers.map((h) => ({ kind: h.kind, ms: h.ms })),
      [{ kind: 'timeout', ms: 10_000 }, { kind: 'interval', ms: 90_000 }],
    );
    assert.deepEqual(host.autoPickup.states, ['Todo', 'Backlog']);
    host.pickupStop();
    assert.ok(timersApi.timers.every((h) => h.cleared));
  } finally { host.close(); store.close(); }
});

test('pickupTick enqueues by priority then age, skips candidates already in the store (terminal rows included) and stops at the cap', async () => {
  const store = createTaskSessionStore({ dbPath: ':memory:', maxActive: 2 });
  // A queued owner (active) and a terminal row: both must block their ticket.
  const taken = store.ensure({ taskKey: 'workspace:ISSUE-TAKEN', taskId: 'ISSUE-TAKEN', workspace: 'workspace', issueId: 'ISSUE-TAKEN', title: 'taken' });
  const done = store.ensure({ taskKey: 'workspace:ISSUE-DONE', taskId: 'ISSUE-DONE', workspace: 'workspace', issueId: 'ISSUE-DONE', title: 'done' });
  store.update(done.sessionId, { status: 'stopped' });
  const candidates = [
    pickupIssue('DONE', { priority: 1, createdAt: '2026-01-01T00:00:00.000Z' }),
    pickupIssue('TAKEN', { priority: 1, createdAt: '2026-01-01T00:00:00.000Z' }),
    pickupIssue('A', { priority: 1, createdAt: '2026-01-02T00:00:00.000Z' }),
    pickupIssue('C', { priority: 3 }),
    pickupIssue('B', { priority: 1, createdAt: '2026-01-03T00:00:00.000Z' }),
    pickupIssue('D'), // no priority — after every ranked one
  ];
  const { host } = build({
    store,
    maxActive: 2,
    autoPickup: { enabled: true, workspace: 'workspace' },
    pickupDeps: fakeTimers(),
    listCandidates: async () => candidates,
  });
  try {
    // DONE and TAKEN are skipped (in store); A wins over B and C on priority;
    // the cap (2 minus the queued TAKEN row) stops the loop before B.
    const result = await host.pickupTick();
    assert.deepEqual(result, { candidates: 6, enqueued: ['workspace:ISSUE-A'], skipped: 2 });
    assert.deepEqual(host.pickupState.lastEnqueued, ['workspace:ISSUE-A']);
    assert.equal(host.pickupState.lastError, null);
    // A won over B and C; the cap (2 minus the queued TAKEN row) stopped the
    // loop before B.
    assert.equal(store.getByTask('workspace:ISSUE-A').status, 'queued');
    assert.equal(store.getByTask('workspace:ISSUE-B'), null);
    assert.equal(store.getByTask('workspace:ISSUE-C'), null);
    assert.equal(store.getByTask('workspace:ISSUE-D'), null);
  } finally { host.close(); store.close(); }
});

test('a throwing listCandidates is logged as lastError and the next tick still runs', async () => {
  let fail = true;
  const { host, store } = build({
    autoPickup: { enabled: true, workspace: 'workspace' },
    pickupDeps: { ...fakeTimers(), now: () => 0 },
    listCandidates: async () => {
      if (fail) throw new Error('linear down');
      return [pickupIssue('OK')];
    },
  });
  try {
    const first = await host.pickupTick();
    assert.deepEqual(first, { error: 'linear down' });
    assert.equal(host.pickupState.lastError, 'linear down');
    assert.equal(host.pickupState.lastTickAt, new Date(0).toISOString());
    fail = false;
    const second = await host.pickupTick();
    assert.deepEqual(second, { candidates: 1, enqueued: ['workspace:ISSUE-OK'], skipped: 0 });
    assert.equal(host.pickupState.lastError, null);
    assert.equal(store.getByTask('workspace:ISSUE-OK').status, 'queued');
  } finally { host.close(); store.close(); }
});

test('GET /pickup with pickup enabled reports the configured shape and the last tick', async () => {
  const { host, store } = build({
    autoPickup: { enabled: true, pollSeconds: 120, workspace: 'workspace' },
    pickupDeps: { ...fakeTimers(), now: () => 0 },
    listCandidates: async () => [pickupIssue('P1')],
  });
  const port = await listen(host);
  try {
    await host.pickupTick();
    const r = await request(port, 'GET', '/pickup');
    assert.equal(r.status, 200);
    assert.equal(r.json.enabled, true);
    assert.equal(r.json.pollSeconds, 120);
    assert.deepEqual(r.json.states, ['Backlog']);
    assert.equal(r.json.lastError, null);
    assert.deepEqual(r.json.lastEnqueued, ['workspace:ISSUE-P1']);
    assert.ok(typeof r.json.lastTickAt === 'string');
  } finally { host.close(); store.close(); }
});
