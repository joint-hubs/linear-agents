// scripts/supervisor-current-run.test.mjs — the current-run record (FOC-807,
// supervisor-current-run.mjs).
//
// The properties worth protecting:
//   · newRunId matches run-manifest gen-id's format for squad "supervisor";
//   · readCurrentRun NEVER throws — a missing, unreadable, non-JSON file or a
//     bad runId shape reads as "no pointer", not a crash;
//   · resolveCurrentRun prefers the pointer (keeping its startedAt, updating
//     the model), then the newest valid recent run (skipping invalid ids),
//     then a new id — and ALWAYS creates the run dir under the state home so
//     the waker hook finds it from the first turn;
//   · recordLauncherRun refuses ids that do not match RUN_ID_RE;
//   · the CLI's resolve prints EXACTLY one line '<runId> <source>' on stdout
//     and its diagnostic on stderr.
//
// Everything runs in mkdtemp dirs: the library calls pass path/stateHome
// explicitly, and only the CLI child process inherits the LA_DATA_HOME /
// LA_SUPERVISOR_STATE_HOME seams pointed at temp dirs. The real .state and
// LOCALAPPDATA are never touched.
//
// Run: node --test scripts/supervisor-current-run.test.mjs

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RUN_ID_RE,
  CurrentRunError,
  newRunId,
  pidAlive,
  readCurrentRun,
  writeCurrentRun,
  resolveCurrentRun,
  recordLauncherRun,
  managedSessionsBlocking,
} from "./supervisor-current-run.mjs";
import { createTaskSessionStore } from "./task-sessions.mjs";

// The managed-session identity used by the scoped tests below.
const SESSION_ID = "sup-" + "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const scopedEnv = (overrides = {}) => ({
  FENIX_SUPERVISOR_SESSION_ID: SESSION_ID,
  LA_TASK_KEY: "workspace:ISSUE-1",
  LA_TASK_ID: "ISSUE-1",
  ...overrides,
});

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "supervisor-current-run.mjs");

const NOW = new Date("2026-10-12T12:00:00.000Z");
const VALID_ID = "2026-10-12T12-00-00-000-supervisor-26c7";
const OTHER_ID = "2026-10-12T11-00-00-000-supervisor-ffff";

function tempHome(label) {
  return mkdtempSync(join(tmpdir(), `la-sup-current-${label}-`));
}
const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });
const pointerPath = (home) => join(home, "supervisor", "current-run.json");

// ── newRunId ─────────────────────────────────────────────────────────────────

test("newRunId matches the run-manifest gen-id format for squad supervisor", () => {
  assert.equal(newRunId(NOW, () => "26c7"), VALID_ID);
});

test("newRunId's default randomness satisfies RUN_ID_RE", () => {
  assert.match(newRunId(NOW), RUN_ID_RE);
});

// ── readCurrentRun / writeCurrentRun ─────────────────────────────────────────

test("readCurrentRun → null when the file is missing", () => {
  const home = tempHome("miss");
  try {
    assert.equal(readCurrentRun({ path: pointerPath(home) }), null);
  } finally {
    cleanup(home);
  }
});

test("readCurrentRun → null on corrupt JSON and on a bad runId shape", () => {
  const home = tempHome("bad");
  const path = pointerPath(home);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{ not json");
    assert.equal(readCurrentRun({ path }), null);
    writeCurrentRun({ runId: "garbage", source: "launcher" }, { path });
    assert.equal(readCurrentRun({ path }), null);
  } finally {
    cleanup(home);
  }
});

test("writeCurrentRun is atomic, 2-space indented and newline-terminated", () => {
  const home = tempHome("write");
  const path = pointerPath(home);
  try {
    writeCurrentRun({ runId: VALID_ID }, { path });
    const raw = readFileSync(path, "utf8");
    assert.match(raw, /\n$/, "trailing newline");
    assert.match(raw, /  "runId"/, "2-space indent");
    assert.deepEqual(readdirSync(dirname(path)), ["current-run.json"], "no leftover .tmp file");
  } finally {
    cleanup(home);
  }
});

// ── resolveCurrentRun ────────────────────────────────────────────────────────

test("fresh → a new id, the run dir created under the temp stateHome", () => {
  const home = tempHome("fresh");
  const state = tempHome("fresh-state");
  try {
    // env pointed at the temp home: the unscoped guard reads the store too.
    const rec = resolveCurrentRun({
      fresh: true,
      now: NOW,
      path: pointerPath(home),
      stateHome: state,
      env: { LA_DATA_HOME: home },
    });
    assert.match(rec.runId, RUN_ID_RE);
    assert.equal(rec.source, "new");
    assert.equal(rec.startedAt, NOW.toISOString());
    assert.equal(rec.updatedAt, NOW.toISOString());
    assert.equal(rec.model, null);
    assert.ok(existsSync(join(state, rec.runId)), "run dir created");
    assert.equal(readCurrentRun({ path: pointerPath(home) }).runId, rec.runId, "pointer written");
  } finally {
    cleanup(home);
    cleanup(state);
  }
});

test("pointer reuse keeps runId and startedAt, updates the model", () => {
  const home = tempHome("ptr");
  const state = tempHome("ptr-state");
  const path = pointerPath(home);
  const startedAt = new Date("2026-10-06T15:09:19.713Z").toISOString();
  try {
    writeCurrentRun({ runId: VALID_ID, model: "m1", startedAt, source: "new", updatedAt: startedAt }, { path });
    const later = new Date("2026-10-12T13:00:00.000Z");
    const rec = resolveCurrentRun({ model: "m2", now: later, path, stateHome: state });
    assert.equal(rec.runId, VALID_ID);
    assert.equal(rec.source, "pointer");
    assert.equal(rec.startedAt, startedAt, "startedAt kept");
    assert.equal(rec.model, "m2");
    assert.equal(rec.updatedAt, later.toISOString());
    // an omitted model must NOT wipe the record's model
    const rec2 = resolveCurrentRun({ now: later, path, stateHome: state });
    assert.equal(rec2.model, "m2");
  } finally {
    cleanup(home);
    cleanup(state);
  }
});

test("corrupt JSON and a bad runId in the file are treated as missing (falls through)", () => {
  const home = tempHome("fall");
  const state = tempHome("fall-state");
  const path = pointerPath(home);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{ not json");
    const rec = resolveCurrentRun({ now: NOW, path, stateHome: state, recentRuns: () => [] });
    assert.equal(rec.source, "new", "corrupt pointer → new");
    writeCurrentRun({ runId: "garbage", source: "launcher" }, { path });
    const rec2 = resolveCurrentRun({ now: NOW, path, stateHome: state, recentRuns: () => [VALID_ID] });
    assert.equal(rec2.source, "adopted", "bad runId shape → adopt");
    assert.equal(rec2.runId, VALID_ID);
  } finally {
    cleanup(home);
    cleanup(state);
  }
});

test("adopt picks the first valid id from recentRuns and skips invalid ones", () => {
  const home = tempHome("adopt");
  const state = tempHome("adopt-state");
  try {
    const rec = resolveCurrentRun({
      now: NOW,
      path: pointerPath(home),
      stateHome: state,
      recentRuns: () => ["nope", OTHER_ID, VALID_ID],
    });
    assert.equal(rec.runId, OTHER_ID);
    assert.equal(rec.source, "adopted");
    assert.equal(rec.startedAt, NOW.toISOString());
    assert.ok(existsSync(join(state, OTHER_ID)), "adopted run dir created");
  } finally {
    cleanup(home);
    cleanup(state);
  }
});

test("no recent runs → new", () => {
  const home = tempHome("none");
  const state = tempHome("none-state");
  try {
    const rec = resolveCurrentRun({
      now: NOW,
      path: pointerPath(home),
      stateHome: state,
      recentRuns: () => [],
    });
    assert.equal(rec.source, "new");
    assert.match(rec.runId, RUN_ID_RE);
  } finally {
    cleanup(home);
    cleanup(state);
  }
});

// ── recordLauncherRun ────────────────────────────────────────────────────────

test("recordLauncherRun writes source launcher and rejects a bad id", () => {
  const home = tempHome("launcher");
  const path = pointerPath(home);
  try {
    // LEGACY=1 with NO blocking sessions must not stamp the record — the
    // deepEqual below proves the env var alone changed nothing.
    const rec = recordLauncherRun({
      runId: VALID_ID,
      model: "claude-x",
      now: NOW,
      path,
      env: { LA_DATA_HOME: home, FENIX_SUPERVISOR_LEGACY: "1" },
    });
    // FOC-905: a NEW run record carries the creator's owner identity —
    // hostname/pid are process-local, so the rest is deepEqualed without it.
    const { owner, ...recordRest } = rec;
    assert.deepEqual(recordRest, {
      runId: VALID_ID,
      model: "claude-x",
      startedAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      source: "launcher",
    });
    assert.ok(owner && typeof owner === "object", "the record carries an owner");
    assert.equal(owner.sessionId, null, "unscoped launcher → no session id");
    assert.equal(owner.hostname, hostname());
    assert.equal(owner.pid, process.pid);
    assert.ok(!Number.isNaN(Date.parse(owner.recordedAt)), "recordedAt is an ISO timestamp");
    assert.equal(readCurrentRun({ path }).source, "launcher");
    assert.throws(() => recordLauncherRun({ runId: "../escape", now: NOW, path, env: { LA_DATA_HOME: home } }), /invalid run id/);
    assert.equal(readCurrentRun({ path }).runId, VALID_ID, "the failed write left the record intact");
  } finally {
    cleanup(home);
  }
});

// ── CLI ──────────────────────────────────────────────────────────────────────

test("CLI resolve prints exactly one line '<runId> <source>' and adopts the recent run", () => {
  const home = tempHome("cli");
  const state = tempHome("cli-state");
  try {
    mkdirSync(join(state, OTHER_ID), { recursive: true });
    writeFileSync(join(state, OTHER_ID, "children.json"), "{}\n");
    const r = spawnSync(process.execPath, [SCRIPT, "resolve", "--model", "m"], {
      encoding: "utf8",
      env: { ...process.env, LA_DATA_HOME: home, LA_SUPERVISOR_STATE_HOME: state },
    });
    assert.equal(r.status, 0, `exit code (stderr: ${r.stderr})`);
    assert.equal(r.stdout, `${OTHER_ID} adopted\n`, "exactly one stdout line");
    assert.match(r.stderr, new RegExp(`^current-run: adopted ${OTHER_ID}\\n?$`));
    const rec = readCurrentRun({ path: pointerPath(home) });
    assert.equal(rec.runId, OTHER_ID);
    assert.equal(rec.model, "m");
  } finally {
    cleanup(home);
    cleanup(state);
  }
});

test("CLI resolve --new creates a fresh run and the next plain resolve reuses it via the pointer", () => {
  const home = tempHome("cli-new");
  const state = tempHome("cli-new-state");
  try {
    const fresh = spawnSync(process.execPath, [SCRIPT, "resolve", "--new", "--model", "m-new"], {
      encoding: "utf8",
      env: { ...process.env, LA_DATA_HOME: home, LA_SUPERVISOR_STATE_HOME: state },
    });
    assert.equal(fresh.status, 0, `exit code (stderr: ${fresh.stderr})`);
    const [freshId, freshSource] = fresh.stdout.split(" ");
    assert.match(freshId, RUN_ID_RE);
    assert.equal(freshSource, "new\n", "exactly one stdout line '<runId> new'");
    const rec = readCurrentRun({ path: pointerPath(home) });
    assert.equal(rec.runId, freshId);
    assert.equal(rec.source, "new");
    assert.equal(rec.model, "m-new");

    const reuse = spawnSync(process.execPath, [SCRIPT, "resolve"], {
      encoding: "utf8",
      env: { ...process.env, LA_DATA_HOME: home, LA_SUPERVISOR_STATE_HOME: state },
    });
    assert.equal(reuse.status, 0, `exit code (stderr: ${reuse.stderr})`);
    assert.equal(reuse.stdout, `${freshId} pointer\n`, "same id, source pointer");
  } finally {
    cleanup(home);
    cleanup(state);
  }
});

test("CLI record writes the launcher record; a bad id exits 1 with nothing on stdout", () => {
  const home = tempHome("cli-rec");
  try {
    const ok = spawnSync(process.execPath, [SCRIPT, "record", VALID_ID, "--model", "m"], {
      encoding: "utf8",
      env: { ...process.env, LA_DATA_HOME: home },
    });
    assert.equal(ok.status, 0);
    assert.equal(ok.stdout, "");
    assert.equal(readCurrentRun({ path: pointerPath(home) }).source, "launcher");

    const bad = spawnSync(process.execPath, [SCRIPT, "record", "garbage"], {
      encoding: "utf8",
      env: { ...process.env, LA_DATA_HOME: home },
    });
    assert.equal(bad.status, 1);
    assert.equal(bad.stdout, "");
    assert.match(bad.stderr, /invalid run id/);
  } finally {
    cleanup(home);
  }
});

test("CLI show prints the record or 'none'; unknown verb exits 2", () => {
  const empty = tempHome("cli-show-empty");
  const full = tempHome("cli-show-full");
  try {
    const none = spawnSync(process.execPath, [SCRIPT, "show"], {
      encoding: "utf8",
      env: { ...process.env, LA_DATA_HOME: empty },
    });
    assert.equal(none.status, 0);
    assert.equal(none.stdout, "none\n");

    recordLauncherRun({ runId: VALID_ID, now: NOW, path: pointerPath(full) });
    const shown = spawnSync(process.execPath, [SCRIPT, "show", "--json"], {
      encoding: "utf8",
      env: { ...process.env, LA_DATA_HOME: full },
    });
    assert.equal(shown.status, 0);
    // FOC-905: the stored record carries owner — process-local values, so it
    // is checked by shape and the rest deepEqualed.
    const { owner, ...recordRest } = JSON.parse(shown.stdout);
    assert.deepEqual(recordRest, {
      runId: VALID_ID,
      model: null,
      startedAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      source: "launcher",
    });
    assert.ok(owner && typeof owner.hostname === "string", "the record carries an owner");

    const unknown = spawnSync(process.execPath, [SCRIPT, "frobnicate"], {
      encoding: "utf8",
      env: { ...process.env, LA_DATA_HOME: full },
    });
    assert.equal(unknown.status, 2);
    assert.equal(unknown.stdout, "");
    assert.match(unknown.stderr, /Usage:/);
  } finally {
    cleanup(empty);
    cleanup(full);
  }
});

// ── scoped resolution (managed task sessions) ────────────────────────────────

const scopedPointerPath = (home) =>
  join(home, "supervisor", "sessions", SESSION_ID, "current-run.json");

test("scoped: a MISSING pointer never adopts the newest recent run — a new scoped run instead", () => {
  const home = tempHome("scoped-adopt");
  const state = tempHome("scoped-adopt-state");
  try {
    const rec = resolveCurrentRun({
      now: NOW,
      path: scopedPointerPath(home),
      stateHome: state,
      recentRuns: () => [OTHER_ID, VALID_ID],
      env: scopedEnv(),
    });
    assert.equal(rec.source, "new", "the recent-runs pool is OFF in scoped mode");
    assert.match(rec.runId, RUN_ID_RE, "the run id keeps the unique global format");
    assert.deepEqual(
      { supervisorSessionId: rec.supervisorSessionId, taskKey: rec.taskKey, taskId: rec.taskId },
      { supervisorSessionId: SESSION_ID, taskKey: "workspace:ISSUE-1", taskId: "ISSUE-1" },
      "the record carries the ownership triple",
    );
    assert.ok(existsSync(join(state, rec.runId)), "the run dir stays global under the state home");
    assert.ok(!existsSync(pointerPath(home)), "the GLOBAL pointer was never written");
    const stored = readCurrentRun({ path: scopedPointerPath(home) });
    assert.equal(stored.runId, rec.runId);
    assert.equal(stored.taskKey, "workspace:ISSUE-1");
  } finally {
    cleanup(home);
    cleanup(state);
  }
});

test("scoped: a pointer owned by THIS session+task is reused (source pointer)", () => {
  const home = tempHome("scoped-ptr");
  const state = tempHome("scoped-ptr-state");
  const path = scopedPointerPath(home);
  try {
    resolveCurrentRun({ fresh: true, now: NOW, path, stateHome: state, env: scopedEnv() });
    const rec = resolveCurrentRun({
      now: new Date("2026-10-12T13:00:00.000Z"),
      path,
      stateHome: state,
      recentRuns: () => [OTHER_ID],
      env: scopedEnv(),
    });
    assert.equal(rec.source, "pointer");
    assert.equal(rec.supervisorSessionId, SESSION_ID);
  } finally {
    cleanup(home);
    cleanup(state);
  }
});

test("scoped: a pointer owned by ANOTHER task/session is refused (fail closed), file untouched", () => {
  const home = tempHome("scoped-x");
  const state = tempHome("scoped-x-state");
  const path = scopedPointerPath(home);
  try {
    const rec = resolveCurrentRun({ fresh: true, now: NOW, path, stateHome: state, env: scopedEnv() });
    assert.throws(
      () => resolveCurrentRun({
        now: NOW,
        path,
        stateHome: state,
        env: scopedEnv({ LA_TASK_KEY: "workspace:ISSUE-2", LA_TASK_ID: "ISSUE-2" }),
      }),
      /another owner/,
    );
    assert.equal(readCurrentRun({ path }).runId, rec.runId, "the pointer was not rewritten");
  } finally {
    cleanup(home);
    cleanup(state);
  }
});

test("scoped: a session id without LA_TASK_KEY/LA_TASK_ID, or a malformed id, fails closed", () => {
  const home = tempHome("scoped-bad");
  try {
    assert.throws(
      () => resolveCurrentRun({
        now: NOW,
        path: scopedPointerPath(home),
        env: { FENIX_SUPERVISOR_SESSION_ID: SESSION_ID },
      }),
      /LA_TASK_KEY and LA_TASK_ID/,
    );
    assert.throws(
      () => resolveCurrentRun({
        now: NOW,
        path: scopedPointerPath(home),
        env: scopedEnv({ FENIX_SUPERVISOR_SESSION_ID: "../escape" }),
      }),
      /must match/,
    );
  } finally {
    cleanup(home);
  }
});

test("legacy resolve (no session env) still adopts — the scoped change does not leak", () => {
  const home = tempHome("legacy-adopt");
  const state = tempHome("legacy-adopt-state");
  try {
    const rec = resolveCurrentRun({
      now: NOW,
      path: pointerPath(home),
      stateHome: state,
      recentRuns: () => [VALID_ID],
      env: { LA_DATA_HOME: home },
    });
    assert.equal(rec.source, "adopted");
    assert.equal(rec.runId, VALID_ID);
    assert.equal(rec.supervisorSessionId, undefined);
  } finally {
    cleanup(home);
    cleanup(state);
  }
});

test("CLI scoped resolve: writes the SCOPED pointer, stamps ownership, exits non-zero on refusal", () => {
  const home = tempHome("cli-scoped");
  const state = tempHome("cli-scoped-state");
  try {
    const fresh = spawnSync(process.execPath, [SCRIPT, "resolve", "--model", "m"], {
      encoding: "utf8",
      env: {
        ...process.env,
        LA_DATA_HOME: home,
        LA_SUPERVISOR_STATE_HOME: state,
        FENIX_SUPERVISOR_SESSION_ID: SESSION_ID,
        LA_TASK_KEY: "workspace:ISSUE-1",
        LA_TASK_ID: "ISSUE-1",
      },
    });
    assert.equal(fresh.status, 0, `exit code (stderr: ${fresh.stderr})`);
    const [freshId, freshSource] = fresh.stdout.split(" ");
    assert.match(freshId, RUN_ID_RE);
    assert.equal(freshSource, "new\n");
    assert.ok(existsSync(scopedPointerPath(home)), "scoped pointer written");
    assert.ok(!existsSync(pointerPath(home)), "global pointer untouched");

    // A pointer stamped for ANOTHER task makes the same CLI fail closed.
    const refused = spawnSync(process.execPath, [SCRIPT, "resolve"], {
      encoding: "utf8",
      env: {
        ...process.env,
        LA_DATA_HOME: home,
        LA_SUPERVISOR_STATE_HOME: state,
        FENIX_SUPERVISOR_SESSION_ID: SESSION_ID,
        LA_TASK_KEY: "workspace:ISSUE-9",
        LA_TASK_ID: "ISSUE-9",
      },
    });
    assert.equal(refused.status, 1, "refusal exits non-zero");
    assert.equal(refused.stdout, "");
    assert.match(refused.stderr, /another owner/);
  } finally {
    cleanup(home);
    cleanup(state);
  }
});

// ── scoped-only autonomy (FOC-901) ───────────────────────────────────────────

// A pid that cannot exist on any supported platform: above Linux's default
// pid_max (2^22) and odd (Windows pids are multiples of 4).
const DEAD_PID = 2 ** 22 + 12345;

/** One managed session in a temp store, claimed and driven to `status` with the given pid. */
function startManagedSession(home, { status = "running", pid = process.pid, issueId = "ISSUE-1" } = {}) {
  const dbPath = join(home, "supervisor", "task-sessions.sqlite");
  const store = createTaskSessionStore({ dbPath });
  const taskKey = `workspace:${issueId}`;
  const created = store.ensure({ taskKey, taskId: issueId, workspace: "workspace", issueId });
  const claimed = store.claimNext(); // queued admission requires claimNext()
  if (!claimed || claimed.sessionId !== created.sessionId) {
    throw new Error(`fixture: ${issueId} could not be claimed (claimed ${claimed?.sessionId ?? "none"})`);
  }
  store.update(created.sessionId, { status, pid });
  return { store, dbPath, sessionId: created.sessionId, taskKey };
}

test("pidAlive: this process is alive, an impossible pid is dead, a garbage pid is conservatively alive", () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(DEAD_PID), false, "the dead-pid fixture must read as dead on this host");
  assert.equal(pidAlive(null), true, "no pid — conservative");
  assert.equal(pidAlive(undefined), true);
  assert.equal(pidAlive(0), true);
  assert.equal(pidAlive(-1), true);
  assert.equal(pidAlive(1.5), true);
  assert.equal(pidAlive("123"), true);
});

test("managedSessionsBlocking partitions by pid liveness; a missing store reads as nothing", () => {
  const home = tempHome("blocking-empty");
  try {
    assert.deepEqual(managedSessionsBlocking({ env: { LA_DATA_HOME: home } }), {
      blocking: [],
      stale: [],
      unknown: null,
    });
  } finally {
    cleanup(home);
  }
  const home2 = tempHome("blocking-mix");
  const { store, dbPath, sessionId, taskKey } = startManagedSession(home2, { pid: process.pid });
  // A second, provably dead session for another task.
  const dead = startManagedSession(home2, { pid: DEAD_PID, issueId: "ISSUE-2" });
  try {
    const r = managedSessionsBlocking({ env: { LA_DATA_HOME: home2 } });
    assert.equal(r.unknown, null);
    assert.deepEqual(
      r.blocking.map((s) => [s.sessionId, s.taskKey, s.status]),
      [[sessionId, taskKey, "running"]],
    );
    assert.deepEqual(r.stale, [dead.sessionId]);
    assert.ok(existsSync(dbPath));
  } finally {
    store.close();
    dead.store.close();
    cleanup(home2);
  }
});

test("unscoped resolve refuses while a live managed session exists — nothing is written", () => {
  const home = tempHome("refuse");
  const state = tempHome("refuse-state");
  const { store, sessionId, taskKey } = startManagedSession(home, { pid: process.pid });
  try {
    assert.throws(
      () =>
        resolveCurrentRun({
          now: NOW,
          path: pointerPath(home),
          stateHome: state,
          recentRuns: () => [VALID_ID],
          env: { LA_DATA_HOME: home },
        }),
      (err) =>
        err instanceof CurrentRunError
        && err.code === "MANAGED_SESSIONS_ACTIVE"
        && err.message.includes(sessionId)
        && err.message.includes(`(${taskKey}, running)`)
        && err.message.includes(`FENIX_SUPERVISOR_SESSION_ID=${sessionId} LA_TASK_KEY=${taskKey} fenix supervisor-run`)
        && err.message.includes("FENIX_SUPERVISOR_LEGACY=1 to adopt anyway (logged)"),
    );
    assert.equal(readCurrentRun({ path: pointerPath(home) }), null, "no pointer written");
    assert.ok(!existsSync(join(state, VALID_ID)), "no run dir created");
    assert.equal(store.get(sessionId).status, "running", "the managed session is untouched");
  } finally {
    store.close();
    cleanup(home);
    cleanup(state);
  }
});

test("FENIX_SUPERVISOR_LEGACY=1 overrides the refusal and stamps legacyOverride on the record", () => {
  const home = tempHome("override");
  const state = tempHome("override-state");
  const { store } = startManagedSession(home, { pid: process.pid });
  try {
    const rec = resolveCurrentRun({
      now: NOW,
      path: pointerPath(home),
      stateHome: state,
      recentRuns: () => [VALID_ID],
      env: { LA_DATA_HOME: home, FENIX_SUPERVISOR_LEGACY: "1" },
    });
    assert.equal(rec.source, "adopted");
    assert.equal(rec.runId, VALID_ID);
    assert.equal(rec.legacyOverride, true);
  } finally {
    store.close();
    cleanup(home);
    cleanup(state);
  }
});

test("only stale sessions (provably dead pids) do not block — the record lists them", () => {
  const home = tempHome("stale");
  const state = tempHome("stale-state");
  const { store, sessionId } = startManagedSession(home, { pid: DEAD_PID });
  try {
    const rec = resolveCurrentRun({
      now: NOW,
      path: pointerPath(home),
      stateHome: state,
      recentRuns: () => [VALID_ID],
      env: { LA_DATA_HOME: home },
    });
    assert.equal(rec.source, "adopted");
    assert.deepEqual(rec.staleManagedSessions, [sessionId]);
    assert.equal(rec.legacyOverride, undefined);
  } finally {
    store.close();
    cleanup(home);
    cleanup(state);
  }
});

test("no store file → unscoped resolve behaves exactly as before — LEGACY=1 alone stamps nothing", () => {
  const home = tempHome("no-store");
  const state = tempHome("no-store-state");
  try {
    const rec = resolveCurrentRun({
      now: NOW,
      path: pointerPath(home),
      stateHome: state,
      recentRuns: () => [VALID_ID],
      env: { LA_DATA_HOME: home },
    });
    assert.equal(rec.source, "adopted");
    assert.equal(rec.runId, VALID_ID);
    assert.equal(rec.staleManagedSessions, undefined);
    assert.equal(rec.legacyOverride, undefined);
    // The stamp marks an overridden REFUSAL, not the env var: with nothing
    // blocking, LEGACY=1 changes nothing worth logging.
    const overridden = resolveCurrentRun({
      now: NOW,
      path: pointerPath(home),
      stateHome: state,
      recentRuns: () => [VALID_ID],
      env: { LA_DATA_HOME: home, FENIX_SUPERVISOR_LEGACY: "1" },
    });
    assert.equal(overridden.source, "pointer");
    assert.equal(overridden.legacyOverride, undefined);
  } finally {
    cleanup(home);
    cleanup(state);
  }
});

test("unscoped resolve --new refuses too — no pointer, no run dir (the guard covers EVERY unscoped branch)", () => {
  const home = tempHome("refuse-new");
  const state = tempHome("refuse-new-state");
  const { store, sessionId } = startManagedSession(home, { pid: process.pid });
  try {
    assert.throws(
      () =>
        resolveCurrentRun({
          fresh: true,
          now: NOW,
          path: pointerPath(home),
          stateHome: state,
          env: { LA_DATA_HOME: home },
        }),
      (err) => err instanceof CurrentRunError && err.code === "MANAGED_SESSIONS_ACTIVE" && err.message.includes(sessionId),
    );
    assert.equal(readCurrentRun({ path: pointerPath(home) }), null, "no pointer written");
    assert.equal(readdirSync(state).length, 0, "no run dir created");
  } finally {
    store.close();
    cleanup(home);
    cleanup(state);
  }
});

test("FENIX_SUPERVISOR_LEGACY=1 lets unscoped resolve --new create the run, stamped legacyOverride", () => {
  const home = tempHome("override-new");
  const state = tempHome("override-new-state");
  const { store } = startManagedSession(home, { pid: process.pid });
  try {
    const rec = resolveCurrentRun({
      fresh: true,
      now: NOW,
      path: pointerPath(home),
      stateHome: state,
      env: { LA_DATA_HOME: home, FENIX_SUPERVISOR_LEGACY: "1" },
    });
    assert.equal(rec.source, "new");
    assert.match(rec.runId, RUN_ID_RE);
    assert.equal(rec.legacyOverride, true, "the overridden refusal is stamped");
    assert.ok(existsSync(join(state, rec.runId)), "the run dir was created");
  } finally {
    store.close();
    cleanup(home);
    cleanup(state);
  }
});

test("CLI resolve exits 3 with the refusal on stderr while a live managed session exists", () => {
  const home = tempHome("cli-refuse");
  const state = tempHome("cli-refuse-state");
  const { store, sessionId } = startManagedSession(home, { pid: process.pid });
  try {
    const r = spawnSync(process.execPath, [SCRIPT, "resolve"], {
      encoding: "utf8",
      env: { ...process.env, LA_DATA_HOME: home, LA_SUPERVISOR_STATE_HOME: state },
    });
    assert.equal(r.status, 3, `exit code (stderr: ${r.stderr})`);
    assert.equal(r.stdout, "", "nothing on stdout");
    assert.match(r.stderr, /^current-run: unscoped Supervisor run resolution refused/);
    assert.match(r.stderr, new RegExp(sessionId));
    assert.match(r.stderr, /FENIX_SUPERVISOR_LEGACY=1/);
    assert.equal(readCurrentRun({ path: pointerPath(home) }), null, "no pointer written");
  } finally {
    store.close();
    cleanup(home);
    cleanup(state);
  }
});

test("recordLauncherRun runs the same guard: refuses natively, overrides with the stamp", () => {
  const home = tempHome("record-guard");
  const path = pointerPath(home);
  const { store, sessionId } = startManagedSession(home, { pid: process.pid });
  try {
    assert.throws(
      () => recordLauncherRun({ runId: VALID_ID, now: NOW, path, env: { LA_DATA_HOME: home } }),
      (err) => err.code === "MANAGED_SESSIONS_ACTIVE" && err.message.includes(sessionId),
    );
    assert.equal(readCurrentRun({ path }), null, "the refused record wrote nothing");
    const rec = recordLauncherRun({
      runId: VALID_ID,
      now: NOW,
      path,
      env: { LA_DATA_HOME: home, FENIX_SUPERVISOR_LEGACY: "1" },
    });
    assert.equal(rec.source, "launcher");
    assert.equal(rec.legacyOverride, true);
  } finally {
    store.close();
    cleanup(home);
  }
});
