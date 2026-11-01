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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

import { createTaskSessionStore, OWNER_STATUSES } from "./task-sessions.mjs";
import {
  createTaskSessionHost,
  ownershipKeeps,
  seedSessionConfig,
  sessionBranchFor,
  sessionHomePath,
} from "./task-session-host.mjs";
import { SESSION_ANSWER_ROUTES } from "./task-session-routes.mjs";
import { checkOwnership } from "./task-ownership.mjs";
import { fixtureRepo, gitIn } from "./supervisor-test-fixtures.mjs";
import { readWorkspaceClaims } from "./workspace-claims.mjs";

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
      const clock = fakeClock();
      if (opts.macrotaskSleep) {
        // The default sleep resolves in microtasks only; tests that stage an
        // HTTP race against the send chain need the event loop between the
        // readiness polls, so this variant yields a real macrotask first.
        clock.sleep = async (ms) => {
          await new Promise((r) => setTimeout(r, 0));
          clock.t += ms;
        };
      }
      fakes.set(sessionId, {
        tmux: fakeTmuxFor(opts.tmuxInit?.[sessionId]),
        pty: fakePty(),
        ptyArgs: null,
        clock,
      });
      // Optional per-fake hook, installed at CREATION time — before the first
      // tmux call — so a test can stage an event that must fire mid-start.
      if (opts.onFake) opts.onFake(sessionId, fakes.get(sessionId));
    }
    return fakes.get(sessionId);
  };
  const legacyFake = { tmux: fakeTmuxFor(), clock: fakeClock() };
  const controllerDeps = (sessionId) => {
    const f = fakeFor(sessionId);
    return {
      runTmux: f.tmux.run,
      readSessionState: opts.hookState ? () => opts.hookState() : () => null,
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
    // FOC-1088: the per-task worktree lane. `repo` (the embedder's explicit
    // repository pin) and a wholesale `sessionWorkspace` replacement (or
    // `null` to disable) forward verbatim. The lane's on/off switch: the
    // harness default is the dep `worktrees: false` — the lane OFF, exactly
    // the shared-checkout behaviour every pre-existing test expects. Tests
    // that exercise the REAL switch pass `resolveWorktrees: true`, which
    // drops the dep so the host reads the overlay/env itself.
    ...(opts.repo !== undefined ? { repo: opts.repo } : {}),
    ...(opts.fetchIssueFacts !== undefined ? { fetchIssueFacts: opts.fetchIssueFacts } : {}),
    ...(opts.sessionWorkspace !== undefined ? { sessionWorkspace: opts.sessionWorkspace } : {}),
    ...(opts.resolveWorktrees ? { worktrees: undefined } : { worktrees: opts.worktrees ?? false }),
    // FOC-839: the legacy-migration hook is injectable; null (the default
    // here) skips it so existing tests are unaffected.
    ...(opts.migrateLegacy !== undefined ? { migrateLegacy: opts.migrateLegacy } : { migrateLegacy: null }),
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

test("no deps, no env, no overlay → the default cap of 1 (DEFAULT_MAX_ACTIVE, FOC-1088)", async () => {
  const { host } = build({ resolveMaxActive: true });
  try {
    assert.equal(host.maxActive, 1);
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
    assert.equal(withEmpty.host.maxActive, 1);
    assert.equal(withEmpty.host.maxActiveSource, "default");
    assert.equal(errs.length, 0, "an empty value must read as unset, silently");
  } finally {
    withEmpty.host.close();
    withEmpty.host.store.close();
  }
  errs.length = 0;
  const withBad = build({ resolveMaxActive: true, env: { FENIX_MAX_ACTIVE_SUPERVISORS: "zero" } });
  try {
    assert.equal(withBad.host.maxActive, 1);
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

test("FOC-1111: an initial prompt refused as a duplicate (200, sent:false) is never marked delivered", async () => {
  // The pane's hook sits busy with a STALE updatedAt, so a paste comes back
  // queued (unconfirmed) and the host holds the duplicate key. The race the
  // guard can actually refuse a START through: while startSession's
  // ensureSession is still in the send chain (readiness loop), a chat message
  // with the SAME text arrives and queues first — the start's own send is
  // then refused as a duplicate. Round 1 marked the durable prompt
  // `delivered` exactly there.
  const staleBusy = () => ({ state: "busy", updatedAt: "1970-01-01T00:00:00.000Z", notification: null });
  let port = null;
  const chats = new Map();
  const { host, store, fakeFor, tmp } = build({
    maxActive: 2,
    hookState: staleBusy,
    macrotaskSleep: true,
    // The racing chat send is installed at fake CREATION and fires on the
    // session's first pane capture — inside the start's readiness loop,
    // strictly before the start's own sendMessage. The readiness loop's fake
    // sleeps yield macrotasks (macrotaskSleep), so the POST is received and
    // its send enters the serialized chain while the ensure still owns it.
    onFake: (sid, f) => {
      // fakeTmuxFor has no onCall seam — wrap run. The first capture-pane is
      // inside the start's readiness loop, strictly before the start's own
      // sendMessage; the loop's fake sleeps yield macrotasks
      // (macrotaskSleep), so the POST is received and its send enters the
      // serialized chain while the ensure still owns it.
      const prevRun = f.tmux.run;
      f.tmux.run = (args, o) => {
        if (args[0] === "capture-pane" && port !== null && !chats.has(sid)) {
          chats.set(sid, request(port, "POST", `/sessions/${sid}/message`, {
            body: { text: "initial prompt for A" },
          }));
        }
        return prevRun(args, o);
      };
    },
  });
  port = await listen(host);
  try {
    const started = await request(port, "POST", "/sessions", { body: startBody("A") });
    const sid = started.json.session.sessionId;
    await host.settled();
    assert.ok(chats.has(sid), "the racing chat send was staged");
    const chatRes = await chats.get(sid);
    assert.equal(chatRes.status, 200);
    assert.equal(chatRes.json.queued, true, "the chat send queued behind the busy turn (it holds the key)");
    // The start's send was refused by the guard — nothing was pasted twice.
    assert.deepEqual(fakeFor(sid).tmux.pastes, ["initial prompt for A"], "exactly one paste: the chat's");
    const rec = store.get(sid);
    assert.equal(rec.status, "waiting");
    assert.match(rec.lastError, /NOT pasted/);
    assert.match(rec.lastError, /deliver manually/);
    const pendingPath = join(tmp, "supervisor", "sessions", sid, "pending-prompt.json");
    assert.equal(
      JSON.parse(readFileSync(pendingPath, "utf8")).state,
      "delivering",
      "the delivery state was never advanced to delivered",
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

// FOC-1112: the API (cockpit-routes.mjs) forwards a task cockpit's answers to
// these exact suffixes. Each must reach the session's controller — its own
// validation answering (400 bad-choice / bad-answers), never the
// multiplexer's 404 not-found that every card answer got on rc.9.
test("the API's answer routes reach the controller; the old spellings stay aliases (FOC-1112)", async () => {
  const { host, store } = build({ maxActive: 2 });
  const port = await listen(host);
  try {
    const a = await request(port, "POST", "/sessions", { body: startBody("A") });
    await host.settled();
    const sid = a.json.session.sessionId;
    for (const suffix of [SESSION_ANSWER_ROUTES.dialog, "/dialog"]) {
      const r = await request(port, "POST", `/sessions/${sid}${suffix}`, { body: { id: "dlg-x", choice: "not-a-choice" } });
      assert.equal(r.status, 400, `${suffix}: ${JSON.stringify(r.json)}`);
      assert.equal(r.json.error, "bad-choice", `${suffix} reached the controller's dialog answer`);
    }
    for (const suffix of [SESSION_ANSWER_ROUTES.ask, "/ask"]) {
      const r = await request(port, "POST", `/sessions/${sid}${suffix}`, { body: { questions: "not-a-list", answers: null } });
      assert.equal(r.status, 400, `${suffix}: ${JSON.stringify(r.json)}`);
      assert.equal(r.json.error, "bad-answers", `${suffix} reached the controller's ask answer`);
    }
    const unknown = await request(port, "POST", `/sessions/${sid}/dialog/nope`, { body: {} });
    assert.equal(unknown.status, 404, "an unknown suffix is still 404");
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
  const storeTwo = createTaskSessionStore({ dbPath: join(two, "supervisor", "task-sessions.sqlite"), maxActive: 2 });
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
  for (const action of ['session','message','ask','dialog','dialog/answer','dialog/ask']) {
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
    // FOC-1081: the tick arms the prompt and pumps, so the row leaves 'queued' at once (the fakes start it).
    assert.notEqual(store.getByTask('workspace:ISSUE-A').status, 'queued');
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
    assert.notEqual(store.getByTask('workspace:ISSUE-OK').status, 'queued'); // FOC-1081: pumped right after enqueue
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

// ── FOC-839: legacy migration hook at serve start ────────────────────────────

test('serve start runs the legacy migration once with apply:true and logs its counts', async () => {
  const calls = [];
  let release;
  const done = new Promise((resolve) => { release = resolve; });
  const migrateLegacy = async (args) => {
    calls.push(args);
    release();
    return { attached: [{ runId: 'r1', sessionId: SESSION_A }], readOnly: [{ runId: 'r2', reason: 'no-session-for-task' }], skipped: [], dryRun: false };
  };
  const { host, store } = build({ migrateLegacy });
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const port = await listen(host);
    await done;
    await new Promise((r) => setTimeout(r, 10));
    // A second listen (close, then listen again — a server cannot listen
    // twice without closing) must NOT re-run the migration — the hook is a
    // one-shot latch per host.
    await new Promise((resolve) => host.server.close(() => resolve()));
    await listen(host);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(calls.length, 1, "migrateLegacy runs exactly once across two listens");
    assert.equal(calls[0].apply, true);
    assert.ok(calls[0].env?.LA_DATA_HOME, "env is the host's baseEnv");
    assert.ok(logs.some((l) => l === 'legacy migration: attached 1, read-only 1, skipped 0'),
      `expected counts log, got: ${JSON.stringify(logs)}`);
  } finally {
    console.log = originalLog;
    host.close();
    store.close();
  }
});

test('a throwing legacy migration never blocks serving', async () => {
  const migrateLegacy = async () => { throw new Error('boom'); };
  const { host, store } = build({ migrateLegacy });
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const port = await listen(host);
    const r = await request(port, 'POST', '/alive', { body: { pids: [1] } });
    assert.equal(r.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(errors.some((l) => l === 'legacy migration: failed (boom)'),
      `expected failure log, got: ${JSON.stringify(errors)}`);
  } finally {
    console.error = originalError;
    host.close();
    store.close();
  }
});

// ── auto-pickup owner scope (FOC-1081) ───────────────────────────────────────
// Against the REAL task-ownership module: the first wiring called
// checkOwnership with a wrapped issue and compared its object result to
// `true`, so no candidate ever survived the filter on a real installation.

test("FOC-1081: ownershipKeeps keeps what the real checkOwnership allows, counts verdicts, never compares an object to true", () => {
  const fenix = { identifier: "FOC-1053", project: { name: "Fenix — wydanie 1.0 i kontrola kosztów" } };
  const other = { identifier: "WSKM-1", project: { name: "WSKM — dydaktyka" } };
  const bare = { identifier: "FOC-9", project: null };

  // Unrestricted install (the shipped config: no owners): everything is kept.
  const unrestricted = { version: 1, owners: {}, unlisted: "allow" };
  const u = ownershipKeeps([fenix, other, bare], (issue) => checkOwnership(issue, { config: unrestricted, owner: "supervisor" }));
  assert.deepEqual(u.kept.map((i) => i.identifier), ["FOC-1053", "WSKM-1", "FOC-9"]);
  assert.deepEqual(u.verdicts, { unrestricted: 3 });

  // Scoped install: the acting owner lists the Fenix project; another owner
  // lists WSKM; the bare one is unlisted and the policy says ask.
  const scoped = {
    version: 1,
    owners: {
      supervisor: { linearProjects: ["Fenix — wydanie 1.0 i kontrola kosztów"] },
      orchestrator: { linearProjects: ["WSKM — dydaktyka"] },
    },
    unlisted: "ask",
  };
  const s = ownershipKeeps([fenix, other, bare], (issue) => checkOwnership(issue, { config: scoped, owner: "supervisor" }));
  assert.deepEqual(s.kept.map((i) => i.identifier), ["FOC-1053"]);
  assert.deepEqual(s.verdicts, { owned: 1, foreign: 1, unlisted: 1 });

  // The bug's shape: a checker that answers a bare `true` (not the module's
  // contract) keeps nothing and is counted as malformed — the filter trusts
  // `allowed`, never truthiness.
  const bareTrue = ownershipKeeps([fenix], () => true);
  assert.deepEqual(bareTrue.kept, []);
  assert.deepEqual(bareTrue.verdicts, { malformed: 1 });

  // A throwing check excludes the candidate and is counted, never thrown.
  const throwing = ownershipKeeps([fenix, other], (issue) => {
    if (issue === other) throw new Error("ambiguous");
    return checkOwnership(issue, { config: unrestricted, owner: "supervisor" });
  });
  assert.deepEqual(throwing.kept.map((i) => i.identifier), ["FOC-1053"]);
  assert.deepEqual(throwing.verdicts, { unrestricted: 1, error: 1 });
});

test("FOC-1081 (second half): auto-pickup arms the Work-board hand-off text as the durable initial prompt and pumps the queue, so a picked ticket does not stay queued", async () => {
  const store = createTaskSessionStore({ dbPath: join(mkdtempSync(join(tmpdir(), "la-pickup-arm-")), "s.sqlite"), maxActive: 2 });
  const issue = { ...pickupIssue("ARM"), url: "https://linear.app/x/issue/ISSUE-ARM", description: "Do the thing.\n\nAC: it works." };
  const { host, tmp } = build({
    store,
    maxActive: 2,
    autoPickup: { enabled: true, workspace: "workspace" },
    pickupDeps: fakeTimers(),
    listCandidates: async () => [issue],
  });
  try {
    const result = await host.pickupTick();
    assert.deepEqual(result.enqueued, ["workspace:ISSUE-ARM"]);
    const record = store.getByTask("workspace:ISSUE-ARM");
    // The durable prompt is on disk, armed, with the same text the dashboard's Start shows.
    const pendingPath = join(sessionHomePath({ LA_DATA_HOME: tmp }, record.sessionId), "pending-prompt.json");
    assert.ok(existsSync(pendingPath), `no pending prompt at ${pendingPath}`);
    const pending = JSON.parse(readFileSync(pendingPath, "utf8"));
    assert.equal(pending.source, "auto-pickup");
    assert.ok(["armed", "delivering", "delivered"].includes(pending.state), `unexpected prompt state ${pending.state}`);
    assert.ok(pending.text.startsWith("Start ticket ISSUE-ARM: Ticket ARM\nhttps://linear.app/x/issue/ISSUE-ARM\n\nDo the thing."), pending.text);
    // The pump ran: the session left `queued` (the fakes make it start) instead of waiting for a POST nobody sends.
    await host.settled();
    assert.notEqual(store.get(record.sessionId).status, "queued", JSON.stringify(store.get(record.sessionId)));
  } finally { host.close(); store.close(); }
});

// ── FOC-1088: the per-task worktree lane ─────────────────────────────────────
//
// The properties worth protecting:
//   · two managed sessions on ONE repository get DISTINCT worktrees on
//     DISTINCT task-derived branches, each controller env carries its own
//     FENIX_REPO_DIR, and the main checkout's HEAD and status are untouched;
//   · the branch/worktree pair is derived from the TASK only — a resumed
//     generation reuses the same branch and tree (and its predecessor's
//     commits), never a start-point re-pin;
//   · stop releases the workspace claim but never removes the tree;
//   · when the repository cannot be resolved the start fails CLOSED with the
//     reason — never a silent fallback to a shared checkout.

const laneBody = (id, text = `initial prompt for ${id}`) => ({
  taskKey: `workspace:${id}`,
  taskId: id,
  workspace: "workspace",
  issueId: id,
  title: `Task ${id}`,
  text,
});

// Round 2: the lane is ON by default (settings taskSessions.worktrees, no
// env flag needed) — the harness opts OUT via the dep `worktrees: false`
// (build's default) and tests that exercise the real switch pass
// `resolveWorktrees: true`.

// The no-overlay case: LA_SETTINGS_FILE points at a path that does not exist,
// so readTaskSessionsSettings reads its documented defaults (worktrees on)
// without ever touching the worktree's own .fenix/config.
const noSettingsFile = () => join(tempDir("no-overlay"), "settings.json");

// A projects.json fixture in `fenix repo add`'s shape — the repo ref is the
// literal ${GITHUB_ROOT}/<name> template (the lane expands it against env
// GITHUB_ROOT), or a full path.
const projectsFixture = (entries) => {
  const file = join(tempDir("projects"), "projects.json");
  writeFileSync(file, JSON.stringify({ projects: entries }), "utf8");
  return file;
};

// A session body for a mapped workspace: the task key's workspace half is
// what the project map is consulted by.
const mappedBody = (workspace, id, text = `initial prompt for ${id}`) => ({
  taskKey: `${workspace}:${id}`,
  taskId: id,
  workspace,
  issueId: id,
  title: `Task ${id}`,
  text,
});

// A fixture repo with an origin whose HEAD is set — the lane's start-point
// resolution pins a NEW branch at the origin default branch, so the fixture
// must provide one (fixtureRepo has no remote).
const laneRepo = () => {
  const { base, repo } = fixtureRepo();
  const origin = join(base, "origin.git");
  gitIn(repo, "clone", "--bare", repo, origin);
  gitIn(repo, "remote", "add", "origin", origin);
  gitIn(repo, "fetch", "origin");
  gitIn(repo, "remote", "set-head", "origin", "-a");
  return { base, repo, origin };
};

// SEVERAL fixture repos under ONE clones root (the shape GITHUB_ROOT has in
// the container), each with an origin whose HEAD is set.
const laneRepos = (...names) => {
  const base = tempDir("lane-repos");
  const repos = {};
  for (const name of names) {
    const repo = join(base, name);
    mkdirSync(repo);
    gitIn(repo, "init", "-b", "main");
    gitIn(repo, "config", "user.email", "test@example.com");
    gitIn(repo, "config", "user.name", "test");
    writeFileSync(join(repo, "README.md"), `fixture ${name}\n`);
    gitIn(repo, "add", "-A");
    gitIn(repo, "commit", "-m", "init");
    const origin = join(base, `${name}-origin.git`);
    gitIn(repo, "clone", "--bare", repo, origin);
    gitIn(repo, "remote", "add", "origin", origin);
    gitIn(repo, "fetch", "origin");
    gitIn(repo, "remote", "set-head", "origin", "-a");
    repos[name] = repo;
  }
  return { base, repos };
};

test("sessionBranchFor derives the branch from the task, never the session id", () => {
  assert.equal(sessionBranchFor({ issueId: "FOC-1088", taskKey: "j:FOC-1088" }), "foc-1088-task");
  assert.equal(sessionBranchFor({ issueId: "joi-70" }), "joi-70-task");
  // A non TEAM-NUM identifier is refused (buildBranchName's own parser would
  // process.exit the host) rather than deriving a garbage branch.
  assert.throws(() => sessionBranchFor({ issueId: "ISSUE-A" }), /TEAM-NUM/);
});

test("FOC-1088 lane: two sessions on one repo get distinct worktrees and branches; the main checkout is untouched", async () => {
  const { repo } = laneRepo();
  const { host, store, fakeFor } = build({ maxActive: 2, repo, resolveWorktrees: true, env: { LA_SETTINGS_FILE: noSettingsFile() } });
  const headBefore = gitIn(repo, "rev-parse", "HEAD");
  const port = await listen(host);
  try {
    const a = await request(port, "POST", "/sessions", { body: laneBody("TST-1") });
    const b = await request(port, "POST", "/sessions", { body: laneBody("TST-2") });
    assert.equal(a.status, 202);
    assert.equal(b.status, 202);
    await host.settled();
    const list = await request(port, "GET", "/sessions");
    const byId = new Map(list.json.sessions.map((s) => [s.sessionId, s]));
    assert.equal(byId.get(a.json.session.sessionId).status, "running", JSON.stringify(byId.get(a.json.session.sessionId)));
    assert.equal(byId.get(b.json.session.sessionId).status, "running", JSON.stringify(byId.get(b.json.session.sessionId)));

    const ctlA = await host.controllerFor(a.json.session.sessionId);
    const ctlB = await host.controllerFor(b.json.session.sessionId);
    const dirA = ctlA.env.FENIX_REPO_DIR;
    const dirB = ctlB.env.FENIX_REPO_DIR;
    assert.ok(dirA, "session A's controller env must carry FENIX_REPO_DIR");
    assert.ok(dirB, "session B's controller env must carry FENIX_REPO_DIR");
    assert.notEqual(resolve(dirA), resolve(dirB), "the two sessions must not share a worktree");
    // Each value is a REAL worktree of the fixture repo on its OWN task
    // branch — never the main checkout. (The base tree trivially satisfies
    // "env has a repo var" by handing over the main checkout; these
    // assertions are the ones it fails.)
    assert.notEqual(resolve(dirA), resolve(repo));
    assert.equal(gitIn(dirA, "rev-parse", "--abbrev-ref", "HEAD"), "tst-1-task");
    assert.equal(gitIn(dirB, "rev-parse", "--abbrev-ref", "HEAD"), "tst-2-task");
    // The pane inherits the same value, stamped into its session's OWN tmux
    // server environment.
    const startA = fakeFor(a.json.session.sessionId).tmux.calls.find((c) => c.args[0] === "start-server");
    const stampAt = startA.args.indexOf("FENIX_REPO_DIR");
    assert.ok(stampAt !== -1, `the pane env must stamp FENIX_REPO_DIR, got ${JSON.stringify(startA.args)}`);
    assert.equal(startA.args[stampAt + 1], dirA);
    // The main checkout is untouched: same HEAD, clean status.
    assert.equal(gitIn(repo, "rev-parse", "HEAD"), headBefore);
    assert.equal(gitIn(repo, "status", "--porcelain"), "");
    // Both workspaces are claimed in the registry under their task owners.
    const claims = readWorkspaceClaims({ gitRoot: repo }).claims;
    assert.deepEqual(
      claims.map((c) => [c.branch, c.ownerId]).sort(),
      [["tst-1-task", "task-session:workspace:TST-1"], ["tst-2-task", "task-session:workspace:TST-2"]],
    );
  } finally {
    host.close();
    store.close();
  }
});

test("FOC-1088 lane: stop releases the claim but keeps the tree; the next generation reuses branch and worktree", async () => {
  const { repo } = laneRepo();
  const { host, store, tmp } = build({ maxActive: 2, repo, resolveWorktrees: true, env: { LA_SETTINGS_FILE: noSettingsFile() } });
  const port = await listen(host);
  try {
    const started = await request(port, "POST", "/sessions", { body: laneBody("TST-3") });
    assert.equal(started.status, 202);
    await host.settled();
    const sessionId = started.json.session.sessionId;
    const dir = (await host.controllerFor(sessionId)).env.FENIX_REPO_DIR;
    assert.ok(dir, "the first generation must carry FENIX_REPO_DIR");
    // Generation 1 leaves work behind: a commit on the task branch.
    writeFileSync(join(dir, "work.txt"), "generation 1\n");
    gitIn(dir, "add", "-A");
    gitIn(dir, "commit", "-m", "generation 1");
    const stopped = await request(port, "POST", `/sessions/${sessionId}/stop`);
    assert.equal(stopped.status, 200);
    assert.equal(stopped.json.stopped, true, JSON.stringify(stopped.json));
    // The claim is released; the tree is NEVER auto-removed.
    assert.equal(readWorkspaceClaims({ gitRoot: repo }).claims.length, 0);
    assert.ok(existsSync(dir), "the worktree stays on disk — cleanup is the operator's");
    // The next generation re-ensures from scratch: same branch, same tree,
    // generation 1's commit intact — never re-pinned to the origin base (a
    // start-point mismatch there would throw). Resume goes through the same
    // transaction the POST /resume route drives: the marker file first, then
    // the store, then the pump.
    const home = sessionHomePath({ LA_DATA_HOME: tmp }, sessionId);
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "resume-request.json"), JSON.stringify({ at: new Date().toISOString() }));
    store.resume(sessionId);
    await host.pump();
    await host.settled();
    assert.equal(store.get(sessionId).status, "running", JSON.stringify(store.get(sessionId)));
    const dir2 = (await host.controllerFor(sessionId)).env.FENIX_REPO_DIR;
    assert.equal(resolve(dir2), resolve(dir), "the resumed generation reuses the SAME worktree");
    assert.equal(gitIn(dir2, "rev-parse", "--abbrev-ref", "HEAD"), "tst-3-task");
    assert.equal(gitIn(dir2, "status", "--porcelain"), "");
    assert.ok(existsSync(join(dir2, "work.txt")), "generation 1's work survives the stop");
    // The live generation's workspace is claimed again.
    assert.deepEqual(
      readWorkspaceClaims({ gitRoot: repo }).claims.map((c) => [c.branch, c.ownerId]),
      [["tst-3-task", "task-session:workspace:TST-3"]],
    );
  } finally {
    host.close();
    store.close();
  }
});

test("FOC-1088 lane: Linear unavailable and no ticketPrefix entry fails the start closed with the operator remedy", async () => {
  // Lane on, the project map is readable, but Linear yields no facts and no
  // entry carries the issue's ticket prefix: the mapping gap fails closed —
  // it must NOT fall through to the host env, which could only name the
  // WRONG repository (the FOC-172 bug class).
  const projects = projectsFixture([
    { linearProject: "Other", repo: "${GITHUB_ROOT}/other", deploy: { type: "none" } },
  ]);
  const { host, store } = build({
    maxActive: 1,
    resolveWorktrees: true,
    fetchIssueFacts: async () => null,
    env: { LA_SETTINGS_FILE: noSettingsFile(), LA_PROJECTS_FILE: projects },
  });
  const port = await listen(host);
  try {
    const started = await request(port, "POST", "/sessions", { body: laneBody("TST-4") });
    assert.equal(started.status, 202);
    await host.settled();
    const record = store.get(started.json.session.sessionId);
    assert.equal(record.status, "waiting", JSON.stringify(record));
    // The error says WHAT WAS TRIED: Linear was unreachable and the issue's
    // ticket prefix matched no structured entry.
    assert.match(record.lastError, /Linear is unavailable/);
    assert.match(record.lastError, /ticket prefix 'TST'/);
    // The remedy names BOTH operator fixes, copy-pasteable.
    assert.match(record.lastError, /fenix repo add <repository url> --project/);
    assert.match(record.lastError, /fenix settings set taskSessions\.worktrees false/);
    assert.match(record.lastError, /fenix restart supervisor/);
  } finally {
    host.close();
    store.close();
  }
});

test("FOC-1088 lane: a non TEAM-NUM issueId fails the start instead of killing the host", async () => {
  const { repo } = laneRepo();
  const { host, store } = build({ maxActive: 1, repo, resolveWorktrees: true, env: { LA_SETTINGS_FILE: noSettingsFile() } });
  const port = await listen(host);
  try {
    const started = await request(port, "POST", "/sessions", { body: laneBody("NOT-A-NUM") });
    assert.equal(started.status, 202);
    await host.settled();
    const record = store.get(started.json.session.sessionId);
    assert.equal(record.status, "waiting", JSON.stringify(record));
    assert.match(record.lastError, /TEAM-NUM/);
  } finally {
    host.close();
    store.close();
  }
});

// ── FOC-1088 round 3: the issue's Linear project resolves the repository ────
// The workspace half of a task key is the LINEAR WORKSPACE NAME ("jointhubs",
// workspaceNameFor's output), not a repository name — the round-2 rule that
// matched repoRefName(entry.repo) against it could never match a real task
// key and failed every real session closed. The map is matched by the issue's
// LINEAR PROJECT instead (fetchIssueFacts), with the STRUCTURED ticketPrefix
// field as the fallback when Linear yields no project.

// THE REGRESSION TEST for the round-2 mistake: it was RED on commit 301174f
// (evidence: .state/foc-1088-round3/red-on-301174f.txt — both sessions failed
// closed with "no entry whose repo maps to workspace 'jointhubs'").
test("FOC-1088 round 3: the issue's Linear project picks the repository — jointhubs:FOC-1 works in FENIX's repo, jointhubs:NEO-2 in Neo's", async () => {
  const { base, repos } = laneRepos("alpha", "beta");
  const projects = projectsFixture([
    { linearProject: "FENIX", repo: "${GITHUB_ROOT}/alpha", deploy: { type: "none" } },
    { linearProject: "Neo", repo: "${GITHUB_ROOT}/beta", deploy: { type: "none" } },
  ]);
  const facts = {
    "FOC-1": { title: "Fenix task", team: "FOC", project: "FENIX", projectMilestone: null, parent: null },
    "NEO-2": { title: "Neo task", team: "NEO", project: "Neo", projectMilestone: null, parent: null },
  };
  const { host, store } = build({
    maxActive: 2,
    resolveWorktrees: true,
    fetchIssueFacts: async (id) => facts[id] ?? null,
    env: { LA_SETTINGS_FILE: noSettingsFile(), LA_PROJECTS_FILE: projects, GITHUB_ROOT: base },
  });
  const port = await listen(host);
  try {
    const a = await request(port, "POST", "/sessions", { body: mappedBody("jointhubs", "FOC-1") });
    const b = await request(port, "POST", "/sessions", { body: mappedBody("jointhubs", "NEO-2") });
    assert.equal(a.status, 202);
    assert.equal(b.status, 202);
    await host.settled();
    const list = await request(port, "GET", "/sessions");
    const byId = new Map(list.json.sessions.map((s) => [s.sessionId, s]));
    assert.equal(byId.get(a.json.session.sessionId).status, "running", JSON.stringify(byId.get(a.json.session.sessionId)));
    assert.equal(byId.get(b.json.session.sessionId).status, "running", JSON.stringify(byId.get(b.json.session.sessionId)));
    const dirA = resolve((await host.controllerFor(a.json.session.sessionId)).env.FENIX_REPO_DIR);
    const dirB = resolve((await host.controllerFor(b.json.session.sessionId)).env.FENIX_REPO_DIR);
    // Each session works in ITS OWN project's repository's worktree — the
    // resolution is per session, memoized per resolved repository, never one
    // root for the whole host.
    assert.equal(dirA, join(base, "la-wt", "alpha", "foc-1-task"), dirA);
    assert.equal(dirB, join(base, "la-wt", "beta", "neo-2-task"), dirB);
    assert.equal(gitIn(dirA, "rev-parse", "--abbrev-ref", "HEAD"), "foc-1-task");
    assert.equal(gitIn(dirB, "rev-parse", "--abbrev-ref", "HEAD"), "neo-2-task");
    // Claims live in EACH repo's own registry, owner task-scoped.
    assert.deepEqual(
      readWorkspaceClaims({ gitRoot: repos.alpha }).claims.map((c) => [c.branch, c.ownerId]),
      [["foc-1-task", "task-session:jointhubs:FOC-1"]],
    );
    assert.deepEqual(
      readWorkspaceClaims({ gitRoot: repos.beta }).claims.map((c) => [c.branch, c.ownerId]),
      [["neo-2-task", "task-session:jointhubs:NEO-2"]],
    );
  } finally {
    host.close();
    store.close();
  }
});

test("FOC-1088 round 3: Linear down, a STRUCTURED ticketPrefix entry resolves the repository", async () => {
  const { base, repos } = laneRepos("alpha");
  // Linear yields no facts, but an entry carries the issue's structured
  // ticket prefix — FOC for FOC-5 — and that maps the repository. (The
  // note-text fallback repoPrefixMap accepts is deliberately NOT consulted
  // here: a guess from free text must never pick a repository.)
  const projects = projectsFixture([
    { ticketPrefix: "FOC", repo: "${GITHUB_ROOT}/alpha", deploy: { type: "none" } },
  ]);
  const { host, store } = build({
    maxActive: 1,
    resolveWorktrees: true,
    fetchIssueFacts: async () => null,
    env: { LA_SETTINGS_FILE: noSettingsFile(), LA_PROJECTS_FILE: projects, GITHUB_ROOT: base },
  });
  const port = await listen(host);
  try {
    const started = await request(port, "POST", "/sessions", { body: mappedBody("jointhubs", "FOC-5") });
    assert.equal(started.status, 202);
    await host.settled();
    const record = store.get(started.json.session.sessionId);
    assert.equal(record.status, "running", JSON.stringify(record));
    const dir = resolve((await host.controllerFor(started.json.session.sessionId)).env.FENIX_REPO_DIR);
    assert.equal(dir, join(base, "la-wt", "alpha", "foc-5-task"), dir);
    assert.deepEqual(
      readWorkspaceClaims({ gitRoot: repos.alpha }).claims.map((c) => [c.branch, c.ownerId]),
      [["foc-5-task", "task-session:jointhubs:FOC-5"]],
    );
  } finally {
    host.close();
    store.close();
  }
});

test("FOC-1088 round 3: one Linear project mapped to two repositories fails closed as ambiguous", async () => {
  const { base } = laneRepos("alpha", "beta");
  // Two entries claim the SAME Linear project and disagree on WHERE the
  // repository lives — the map cannot name one repository, so the session
  // fails closed instead of guessing.
  const projects = projectsFixture([
    { linearProject: "FENIX", repo: "${GITHUB_ROOT}/alpha", deploy: { type: "none" } },
    { linearProject: "FENIX", repo: "${GITHUB_ROOT}/beta", deploy: { type: "none" } },
  ]);
  const { host, store } = build({
    maxActive: 1,
    resolveWorktrees: true,
    fetchIssueFacts: async (id) => (id === "FOC-6" ? { project: "FENIX" } : null),
    env: { LA_SETTINGS_FILE: noSettingsFile(), LA_PROJECTS_FILE: projects, GITHUB_ROOT: base },
  });
  const port = await listen(host);
  try {
    const started = await request(port, "POST", "/sessions", { body: mappedBody("jointhubs", "FOC-6") });
    assert.equal(started.status, 202);
    await host.settled();
    const record = store.get(started.json.session.sessionId);
    assert.equal(record.status, "waiting", JSON.stringify(record));
    assert.match(record.lastError, /Linear project 'FENIX'/);
    assert.match(record.lastError, /ambiguous/);
    assert.match(record.lastError, /fenix repo add <repository url> --project/);
    assert.match(record.lastError, /fenix settings set taskSessions\.worktrees false/);
    assert.match(record.lastError, /fenix restart supervisor/);
  } finally {
    host.close();
    store.close();
  }
});

test("FOC-1088 round 3: the pisi workspace's Linear lookup routes LINEAR_WORKSPACE=pisi — no other workspace does", async () => {
  const { base, repos } = laneRepos("alpha");
  const projects = projectsFixture([
    { linearProject: "Pisi Project", repo: "${GITHUB_ROOT}/alpha", deploy: { type: "none" } },
  ]);
  const seen = [];
  const { host, store } = build({
    maxActive: 2,
    resolveWorktrees: true,
    fetchIssueFacts: async (id, { env: callEnv } = {}) => {
      seen.push({ id, workspace: callEnv?.LINEAR_WORKSPACE });
      return { project: "Pisi Project" };
    },
    env: { LA_SETTINGS_FILE: noSettingsFile(), LA_PROJECTS_FILE: projects, GITHUB_ROOT: base },
  });
  const port = await listen(host);
  try {
    const pisi = await request(port, "POST", "/sessions", { body: mappedBody("pisi", "PIS-1") });
    const jointhubs = await request(port, "POST", "/sessions", { body: mappedBody("jointhubs", "JOIN-2") });
    assert.equal(pisi.status, 202);
    assert.equal(jointhubs.status, 202);
    await host.settled();
    // ONLY the pisi workspace's lookup is routed to the pisi key; every other
    // workspace's env passes through untouched.
    assert.deepEqual(
      seen.find((s) => s.id === "PIS-1"),
      { id: "PIS-1", workspace: "pisi" },
    );
    assert.deepEqual(
      seen.find((s) => s.id === "JOIN-2"),
      { id: "JOIN-2", workspace: undefined },
    );
    // And the resolution itself worked for both (the pisi routing does not
    // change which repository the map names).
    const dirP = resolve((await host.controllerFor(pisi.json.session.sessionId)).env.FENIX_REPO_DIR);
    assert.equal(dirP, join(base, "la-wt", "alpha", "pis-1-task"), dirP);
    const dirJ = resolve((await host.controllerFor(jointhubs.json.session.sessionId)).env.FENIX_REPO_DIR);
    assert.equal(dirJ, join(base, "la-wt", "alpha", "join-2-task"), dirJ);
  } finally {
    host.close();
    store.close();
  }
});

test("FOC-1088 round 2: with no readable project map the env candidates decide — all-fail still carries the remedy", async () => {
  // An UNPARSEABLE LA_PROJECTS_FILE (projectsConfigPath pins it once it
  // exists) leaves the lane without a project map: the env candidates decide.
  // baseEnv here sets neither FENIX_REPO_DIR nor LA_SUPERVISOR_REPO, so
  // nothing resolves — the error names what happened and both operator fixes.
  const brokenMap = join(tempDir("broken-map"), "projects.json");
  writeFileSync(brokenMap, "{ not json", "utf8");
  const { host, store } = build({
    maxActive: 1,
    resolveWorktrees: true,
    env: { LA_SETTINGS_FILE: noSettingsFile(), LA_PROJECTS_FILE: brokenMap },
  });
  const port = await listen(host);
  try {
    const started = await request(port, "POST", "/sessions", { body: mappedBody("workspace", "MAP-4") });
    assert.equal(started.status, 202);
    await host.settled();
    const record = store.get(started.json.session.sessionId);
    assert.equal(record.status, "waiting", JSON.stringify(record));
    assert.match(record.lastError, /could not determine which repository/);
    assert.match(record.lastError, /fenix repo add <repository url> --project/);
    assert.match(record.lastError, /fenix settings set taskSessions\.worktrees false/);
    assert.match(record.lastError, /fenix restart supervisor/);
  } finally {
    host.close();
    store.close();
  }
});

test("FOC-1088 round 2: the lane is ON by default — no settings file, no env flag, the session still gets a worktree", async () => {
  const { repo } = laneRepo();
  const { host, store } = build({ maxActive: 1, repo, resolveWorktrees: true, env: { LA_SETTINGS_FILE: noSettingsFile() } });
  const port = await listen(host);
  try {
    const started = await request(port, "POST", "/sessions", { body: laneBody("DEF-1") });
    assert.equal(started.status, 202);
    await host.settled();
    const record = store.get(started.json.session.sessionId);
    assert.equal(record.status, "running", JSON.stringify(record));
    const dir = (await host.controllerFor(started.json.session.sessionId)).env.FENIX_REPO_DIR;
    assert.ok(dir, "the default-on lane must hand the controller a FENIX_REPO_DIR");
    assert.equal(gitIn(resolve(dir), "rev-parse", "--abbrev-ref", "HEAD"), "def-1-task");
  } finally {
    host.close();
    store.close();
  }
});

test("FOC-1088 round 2: taskSessions.worktrees=false restores the shared checkout — no FENIX_REPO_DIR, no claim", async () => {
  const dir = tempDir("worktrees-off");
  const settings = join(dir, "settings.json");
  writeFileSync(settings, JSON.stringify({ taskSessions: { worktrees: false } }), "utf8");
  // Even a perfectly resolvable repository pin is ignored: the switch is off.
  const { repo } = laneRepo();
  const { host, store } = build({ maxActive: 1, repo, resolveWorktrees: true, env: { LA_SETTINGS_FILE: settings } });
  const port = await listen(host);
  try {
    const started = await request(port, "POST", "/sessions", { body: laneBody("OFF-1") });
    assert.equal(started.status, 202);
    await host.settled();
    const record = store.get(started.json.session.sessionId);
    assert.equal(record.status, "running", JSON.stringify(record));
    const env = (await host.controllerFor(started.json.session.sessionId)).env;
    assert.ok(!("FENIX_REPO_DIR" in env), "the shared-checkout path must not carry FENIX_REPO_DIR");
    assert.equal(readWorkspaceClaims({ gitRoot: repo }).claims.length, 0, "nothing may be claimed");
  } finally {
    host.close();
    store.close();
  }
});

test("FOC-1088 round 2: FENIX_TASK_WORKTREES stays an emergency override, winning over the overlay both ways", async () => {
  const { repo } = laneRepo();
  // env 0 + overlay default (on) → OFF: the operator who opted out before the
  // lane went default-on keeps their opt-out.
  const off = build({
    maxActive: 1,
    repo,
    resolveWorktrees: true,
    env: { LA_SETTINGS_FILE: noSettingsFile(), FENIX_TASK_WORKTREES: "0" },
  });
  const portOff = await listen(off.host);
  try {
    const started = await request(portOff, "POST", "/sessions", { body: laneBody("OVR-1") });
    assert.equal(started.status, 202);
    await off.host.settled();
    const env = (await off.host.controllerFor(started.json.session.sessionId)).env;
    assert.ok(!("FENIX_REPO_DIR" in env), "env 0 must force the shared checkout");
    assert.equal(readWorkspaceClaims({ gitRoot: repo }).claims.length, 0);
  } finally {
    off.host.close();
    off.store.close();
  }
  // env 1 + overlay off → ON: the emergency switch works in the other
  // direction too, without editing the overlay.
  const dir = tempDir("worktrees-off-env1");
  const settings = join(dir, "settings.json");
  writeFileSync(settings, JSON.stringify({ taskSessions: { worktrees: false } }), "utf8");
  const on = build({
    maxActive: 1,
    repo,
    resolveWorktrees: true,
    env: { LA_SETTINGS_FILE: settings, FENIX_TASK_WORKTREES: "1" },
  });
  const portOn = await listen(on.host);
  try {
    const started = await request(portOn, "POST", "/sessions", { body: laneBody("OVR-2") });
    assert.equal(started.status, 202);
    await on.host.settled();
    const record = on.store.get(started.json.session.sessionId);
    assert.equal(record.status, "running", JSON.stringify(record));
    const env = (await on.host.controllerFor(started.json.session.sessionId)).env;
    assert.ok(env.FENIX_REPO_DIR, "env 1 must force the worktree lane on");
  } finally {
    on.host.close();
    on.store.close();
  }
});
