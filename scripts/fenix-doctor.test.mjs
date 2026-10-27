// scripts/fenix-doctor.test.mjs — FOC-803: the uid-mismatch checks.
//
// When the image was not built for the host user's uid/gid, the bind-mounted
// host files keep their host ownership: the Compose secrets (0600 on the
// host) are unreadable and the project-map directory (/fenix-config) is not
// writable. Doctor must catch both, only in the container, with a fix that
// names the rebuild. Paths are injectable so the tests run against temp dirs;
// the unreadable-file paths are additionally forced through a fake fsImpl, so
// the fail branch is exercised on Windows too (chmod there cannot remove read
// access).
//
// Run: node scripts/fenix-doctor.test.mjs   (also: node --test <this file>)

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GH_MIN_VERSION,
  applyGhFloor,
  checkCaches,
  ghBelowFloor,
  checkFenixCode,
  checkPermissionMode,
  checkProjectsDir,
  checkRunOwners,
  checkSecretsReadable,
  checkSupervisorPrompt,
  checkTaskSessions,
  runChecks,
  summarize,
} from "./fenix-doctor.mjs";
import { buildManifest, compareToManifest, listCodeFiles, readManifest } from "./fenix-manifest.mjs";
import { pidAlive } from "./supervisor-current-run.mjs";
import { currentOwner } from "./run-owner.mjs";

let passed = 0;
let skipped = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  PASS " + name);
  } catch (err) {
    failures.push(name);
    console.log("  FAIL " + name + "\n       " + err.message);
  }
}

const UID_FIX = "rebuild the image for your user: ./fenix up (sets FENIX_UID/FENIX_GID from id -u/-g)";
const VOLUME_FIX = "check the fenix-data volume";
// FOC-803: a rebuild re-owns the bind mounts but not the named data volume —
// the volume keeps the uid it was first created with.
const VOLUME_REOWN_FIX =
  "the data volume belongs to another uid — re-own it once: docker run --rm -u 0 -v fenix_fenix-data:/data --entrypoint chown fenix:dev -R $(id -u):$(id -g) /data";
const IN_CONTAINER = { FENIX_IN_CONTAINER: "1" };

// fsImpl whose mkdirSync and accessSync fail for the given path — what an
// unwritable volume dir looks like to the container user, without chmod
// (which Windows ignores). Everything else delegates to the real fs.
function fsWithDeniedDir(dir) {
  return {
    constants: fs.constants,
    readdirSync: (d) => fs.readdirSync(d),
    statSync: (p) => fs.statSync(p),
    statfsSync: (p) => fs.statfsSync(p),
    existsSync: (p) => fs.existsSync(p),
    mkdirSync: (p, opts) => {
      if (p === dir) throw new Error("EACCES: permission denied, mkdir '" + p + "'");
      return fs.mkdirSync(p, opts);
    },
    accessSync: (p, mode) => {
      if (p === dir) throw new Error("EACCES: permission denied, access '" + p + "'");
      return fs.accessSync(p, mode);
    },
  };
}

const fakeSpawn = () => ({ status: 0, stdout: "fake 1.0\n" });

// Minimal fsImpl standing in for fs: everything real, except access to the
// given path fails — that is what a host-owned 0600 secret looks like to the
// container's `node` user, without needing chmod (which Windows ignores).
function fsWithDeniedAccess(deniedRead, deniedWrite) {
  return {
    constants: fs.constants,
    readdirSync: (d) => fs.readdirSync(d),
    statSync: (p) => fs.statSync(p),
    mkdirSync: fs.mkdirSync,
    accessSync: (p, mode) => {
      if (deniedRead && p === deniedRead && mode & fs.constants.R_OK) {
        throw new Error("EACCES: permission denied, access '" + p + "'");
      }
      if (deniedWrite && p === deniedWrite && mode & fs.constants.W_OK) {
        throw new Error("EACCES: permission denied, access '" + p + "'");
      }
      return fs.accessSync(p, mode);
    },
  };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fenix-doctor-"));
}

console.log("\nfenix-doctor: secrets readable (FOC-803)");

test("empty secrets dir is ok (checkKeys owns the missing-keys case)", () => {
  const dir = tempDir();
  try {
    const c = checkSecretsReadable(IN_CONTAINER, fs, dir);
    assert.equal(c.status, "ok");
    assert.match(c.detail, /0 file\(s\)/);
  } finally {
    fs.rmdirSync(dir);
  }
});

test("a readable secret file is ok", () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, "openrouter_api_key"), "k");
    const c = checkSecretsReadable(IN_CONTAINER, fs, dir);
    assert.equal(c.status, "ok");
    assert.match(c.detail, /1 file\(s\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an unreadable secret file fails with the rebuild fix (fake fsImpl)", () => {
  const dir = tempDir();
  try {
    const secret = path.join(dir, "openrouter_api_key");
    fs.writeFileSync(secret, "k");
    const c = checkSecretsReadable(IN_CONTAINER, fsWithDeniedAccess(secret), dir);
    assert.equal(c.status, "fail");
    assert.match(c.detail, /openrouter_api_key/);
    assert.equal(c.fix, UID_FIX);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a secrets dir that cannot be listed warns (keys missing, not a uid issue)", () => {
  const c = checkSecretsReadable(IN_CONTAINER, fs, path.join(tempDirRoot(), "no-such-dir"));
  assert.equal(c.status, "warn");
  assert.equal(c.fix, "fenix keys");
});

// chmod 000 is the real-world failure shape; only POSIX honours it.
if (process.platform === "win32") {
  skipped++;
  console.log("  SKIP chmod-000 unreadable secret — Windows chmod cannot remove read access; the fake-fsImpl test covers the fail branch");
} else {
  test("chmod 000 secret fails with the rebuild fix (real fs)", () => {
    const dir = tempDir();
    try {
      const secret = path.join(dir, "openrouter_api_key");
      fs.writeFileSync(secret, "k");
      fs.chmodSync(secret, 0o000);
      const c = checkSecretsReadable(IN_CONTAINER, fs, dir);
      assert.equal(c.status, "fail");
      assert.equal(c.fix, UID_FIX);
    } finally {
      fs.chmodSync(path.join(dir, "openrouter_api_key"), 0o644);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

console.log("\nfenix-doctor: project-map directory writable (FOC-803)");

test("a writable projects dir is ok", () => {
  const dir = tempDir();
  try {
    const c = checkProjectsDir({ LA_PROJECTS_FILE: path.join(dir, "projects.json") }, fs);
    assert.equal(c.status, "ok");
    assert.equal(c.detail, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing projects dir warns (fenix up creates it — not a uid issue)", () => {
  const c = checkProjectsDir({ LA_PROJECTS_FILE: path.join(tempDirRoot(), "no-such-dir", "projects.json") }, fs);
  assert.equal(c.status, "warn");
  assert.match(c.detail, /missing/);
});

test("an unwritable projects dir fails with the rebuild fix (fake fsImpl)", () => {
  const dir = tempDir();
  try {
    const c = checkProjectsDir({ LA_PROJECTS_FILE: path.join(dir, "projects.json") }, fsWithDeniedAccess(null, dir));
    assert.equal(c.status, "fail");
    assert.match(c.detail, /not writable/);
    assert.equal(c.fix, UID_FIX);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// chmod 555 is the real-world failure shape; only POSIX honours it.
if (process.platform === "win32") {
  skipped++;
  console.log("  SKIP chmod-555 unwritable config dir — Windows chmod cannot remove write access; the fake-fsImpl test covers the fail branch");
} else {
  test("chmod 555 projects dir fails with the rebuild fix (real fs)", () => {
    const dir = tempDir();
    try {
      fs.chmodSync(dir, 0o555);
      const c = checkProjectsDir({ LA_PROJECTS_FILE: path.join(dir, "projects.json") }, fs);
      assert.equal(c.status, "fail");
      assert.equal(c.fix, UID_FIX);
    } finally {
      fs.chmodSync(dir, 0o755);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

console.log("\nfenix-doctor: FOC-803 checks only run in the container");

test("without FENIX_IN_CONTAINER the uid checks are absent", async () => {
  const checks = await runChecks({
    env: {},
    settings: {},
    spawn: () => ({ status: 0, stdout: "fake 1.0\n" }),
    fsImpl: fs,
    retention: async () => null,
  });
  assert.equal(checks.some((c) => c.name === "secrets readable"), false);
  assert.equal(checks.some((c) => c.name === "config writable"), false);
});

test("with FENIX_IN_CONTAINER=1 both uid checks run, with injected paths", async () => {
  const dir = tempDir();
  try {
    const checks = await runChecks({
      env: { ...IN_CONTAINER, LA_PROJECTS_FILE: path.join(dir, "projects.json") },
      settings: {},
      spawn: fakeSpawn,
      fsImpl: fs,
      secretsDir: dir,
      retention: async () => null,
    });
    const secrets = checks.find((c) => c.name === "secrets readable");
    const config = checks.find((c) => c.name === "config writable");
    assert.ok(secrets, "secrets readable check missing");
    assert.ok(config, "config writable check missing");
    assert.equal(secrets.status, "ok");
    assert.equal(config.status, "ok");
    // After the existing checks, before anything else.
    assert.equal(checks[checks.length - 2].name, "secrets readable");
    assert.equal(checks[checks.length - 1].name, "config writable");
    // FOC-988: the drift check runs in the container too, just ahead of them.
    assert.equal(checks[checks.length - 3].name, "fenix code");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log("\nfenix-doctor: /data volume uid fix (FOC-803 re-own)");

test("a failing /data dir check in the container names the one-time re-own fix", async () => {
  const checks = await runChecks({
    env: { ...IN_CONTAINER, LA_TELEMETRY_HOME: "/data/telemetry" },
    settings: {},
    spawn: fakeSpawn,
    fsImpl: fsWithDeniedDir("/data/telemetry"),
    retention: async () => null,
  });
  const c = checks.find((c) => c.name === "dir LA_TELEMETRY_HOME");
  assert.ok(c, "dir check missing");
  assert.equal(c.status, "fail");
  assert.match(c.detail, /\/data\/telemetry/);
  assert.equal(c.fix, VOLUME_REOWN_FIX);
});

test("a failing dir OUTSIDE /data keeps the generic volume fix", async () => {
  const dir = tempDir();
  try {
    const checks = await runChecks({
      env: { ...IN_CONTAINER, LA_TELEMETRY_HOME: dir },
      settings: {},
      spawn: fakeSpawn,
      fsImpl: fsWithDeniedDir(dir),
      retention: async () => null,
    });
    const c = checks.find((c) => c.name === "dir LA_TELEMETRY_HOME");
    assert.equal(c.status, "fail");
    assert.equal(c.fix, VOLUME_FIX);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("without FENIX_IN_CONTAINER the re-own fix never appears", async () => {
  const dir = tempDir();
  try {
    const checks = await runChecks({
      env: { LA_TELEMETRY_HOME: dir },
      settings: {},
      spawn: fakeSpawn,
      fsImpl: fsWithDeniedDir(dir),
      retention: async () => null,
    });
    const c = checks.find((c) => c.name === "dir LA_TELEMETRY_HOME");
    assert.equal(c.status, "fail");
    assert.equal(c.fix, VOLUME_FIX);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log("\nfenix-doctor: task sessions line (FOC-901)");

// fsImpl that pretends the task-sessions store exists (the readSessions seam
// below fakes its content) while everything else is real.
function fsWithStoreFile(dbPath) {
  return {
    ...fs,
    existsSync: (p) => (p === dbPath ? true : fs.existsSync(p)),
  };
}

const fakeSessions = (sessions, unknown = null) => () => ({ sessions, unknown });

test("no store file → ok 'no managed sessions yet'", () => {
  const dir = tempDir();
  try {
    const c = checkTaskSessions({ env: { LA_DATA_HOME: dir }, fsImpl: fs });
    assert.equal(c.status, "ok");
    assert.match(c.detail, /no managed sessions yet/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("2 active / cap 1 (the default) → warn 'cap reached' with the ids and the key fix", () => {
  const dir = tempDir();
  const dbPath = path.join(dir, "supervisor", "task-sessions.sqlite");
  const sessions = [
    { sessionId: "sup-" + "a".repeat(32), taskKey: "workspace:ISSUE-1", status: "running", pid: process.pid },
    { sessionId: "sup-" + "b".repeat(32), taskKey: "workspace:ISSUE-2", status: "waiting", pid: null },
  ];
  try {
    const c = checkTaskSessions({
      env: { LA_DATA_HOME: dir },
      fsImpl: fsWithStoreFile(dbPath),
      readSessions: fakeSessions(sessions),
    });
    assert.equal(c.status, "warn");
    assert.match(c.detail, /cap reached/);
    assert.match(c.detail, /2 active \/ cap 1/);
    assert.ok(c.detail.includes("sup-" + "a".repeat(32)));
    assert.match(c.fix, /taskSessions\.maxActive/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("1 active + a live unscoped session.json → warn 'unscoped'", () => {
  const dir = tempDir();
  const dbPath = path.join(dir, "supervisor", "task-sessions.sqlite");
  const sessionFile = path.join(dir, "supervisor", "session.json");
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(sessionFile, JSON.stringify({ state: "idle", pid: process.pid, updatedAt: "2026-10-16T10:00:00.000Z" }));
  const sessions = [
    { sessionId: "sup-" + "c".repeat(32), taskKey: "workspace:ISSUE-3", status: "running", pid: process.pid },
  ];
  try {
    const c = checkTaskSessions({
      env: { LA_DATA_HOME: dir },
      fsImpl: fsWithStoreFile(dbPath),
      readSessions: fakeSessions(sessions),
    });
    assert.equal(c.status, "warn");
    assert.match(c.detail, /unscoped Supervisor runs next to/);
    assert.match(c.detail, /stop it or start it scoped/);
    assert.match(c.fix, /FENIX_SUPERVISOR_SESSION_ID/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a session.json whose pid is provably dead does not count as live", () => {
  const dir = tempDir();
  const dbPath = path.join(dir, "supervisor", "task-sessions.sqlite");
  const sessionFile = path.join(dir, "supervisor", "session.json");
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  const deadPid = 2 ** 22 + 12345; // above Linux's default pid_max and odd — cannot exist
  assert.equal(pidAlive(deadPid), false, "fixture must read as dead on this host");
  fs.writeFileSync(sessionFile, JSON.stringify({ state: "idle", pid: deadPid }));
  const sessions = [
    { sessionId: "sup-" + "d".repeat(32), taskKey: "workspace:ISSUE-4", status: "running", pid: process.pid },
  ];
  fs.writeFileSync(path.join(dir, "cap2.json"), JSON.stringify({ taskSessions: { maxActive: 2 } }), "utf8");
  // the counting logic under test, at an explicit cap of 2 (the default is 1 since FOC-1088)
  try {
    const c = checkTaskSessions({
      env: { LA_DATA_HOME: dir, LA_SETTINGS_FILE: path.join(dir, "cap2.json") },
      fsImpl: fsWithStoreFile(dbPath),
      readSessions: fakeSessions(sessions),
    });
    assert.equal(c.status, "ok");
    assert.match(c.detail, /1 active \/ cap 2/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an unreadable store warns with the reason, never pretends it is empty", () => {
  const dir = tempDir();
  const dbPath = path.join(dir, "supervisor", "task-sessions.sqlite");
  try {
    const c = checkTaskSessions({
      env: { LA_DATA_HOME: dir },
      fsImpl: fsWithStoreFile(dbPath),
      readSessions: fakeSessions([], "cannot open read-only (boom)"),
    });
    assert.equal(c.status, "warn");
    assert.match(c.detail, /could not be read/);
    assert.match(c.detail, /boom/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a wal-recovery-needed store read gets the hot-WAL fix", () => {
  const dir = tempDir();
  const dbPath = path.join(dir, "supervisor", "task-sessions.sqlite");
  try {
    const c = checkTaskSessions({
      env: { LA_DATA_HOME: dir },
      fsImpl: fsWithStoreFile(dbPath),
      readSessions: fakeSessions([], "wal-recovery-needed: needs WAL recovery — a session host died mid-write (boom)"),
    });
    assert.equal(c.status, "warn");
    assert.match(c.fix, /hot WAL — start the host once or set FENIX_SUPERVISOR_LEGACY=1/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a stale (provably dead) session does not count against the cap and is named as stale", () => {
  const dir = tempDir();
  const dbPath = path.join(dir, "supervisor", "task-sessions.sqlite");
  const deadPid = 2 ** 22 + 12345;
  const sessions = [
    { sessionId: "sup-" + "e".repeat(32), taskKey: "workspace:ISSUE-5", status: "running", pid: process.pid },
    { sessionId: "sup-" + "f".repeat(32), taskKey: "workspace:ISSUE-6", status: "running", pid: deadPid },
  ];
  fs.writeFileSync(path.join(dir, "cap2.json"), JSON.stringify({ taskSessions: { maxActive: 2 } }), "utf8");
  // the counting logic under test, at an explicit cap of 2 (the default is 1 since FOC-1088)
  try {
    const c = checkTaskSessions({
      env: { LA_DATA_HOME: dir, LA_SETTINGS_FILE: path.join(dir, "cap2.json") },
      fsImpl: fsWithStoreFile(dbPath),
      readSessions: fakeSessions(sessions),
    });
    assert.equal(c.status, "ok", "1 live at cap 2 is not cap reached");
    assert.match(c.detail, /1 live \/ cap 2 \(1 stale: /);
    assert.ok(c.detail.includes("sup-" + "f".repeat(32)), "the stale id is named");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cap reached AND a live unscoped neighbour → ONE warn line mentions both", () => {
  const dir = tempDir();
  const dbPath = path.join(dir, "supervisor", "task-sessions.sqlite");
  const sessionFile = path.join(dir, "supervisor", "session.json");
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(sessionFile, JSON.stringify({ state: "idle", pid: process.pid }));
  const sessions = [
    { sessionId: "sup-" + "1".repeat(32), taskKey: "workspace:ISSUE-7", status: "running", pid: process.pid },
    { sessionId: "sup-" + "2".repeat(32), taskKey: "workspace:ISSUE-8", status: "waiting", pid: process.pid },
  ];
  try {
    const c = checkTaskSessions({
      env: { LA_DATA_HOME: dir },
      fsImpl: fsWithStoreFile(dbPath),
      readSessions: fakeSessions(sessions),
    });
    assert.equal(c.status, "warn");
    assert.match(c.detail, /cap reached/);
    assert.match(c.detail, /unscoped Supervisor runs next to/);
    assert.match(c.fix, /taskSessions\.maxActive/);
    assert.match(c.fix, /FENIX_SUPERVISOR_SESSION_ID/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an invalid settings overlay is surfaced in the detail, not printed to stderr", () => {
  const dir = tempDir();
  const dbPath = path.join(dir, "supervisor", "task-sessions.sqlite");
  const settings = path.join(dir, "settings.json");
  fs.writeFileSync(settings, JSON.stringify({ taskSessions: { maxActive: 9 } }), "utf8");
  const sessions = [
    { sessionId: "sup-" + "3".repeat(32), taskKey: "workspace:ISSUE-9", status: "running", pid: process.pid },
  ];
  const errs = [];
  const orig = console.error;
  console.error = (msg) => errs.push(String(msg));
  try {
    const c = checkTaskSessions({
      env: { LA_DATA_HOME: dir, LA_SETTINGS_FILE: settings },
      fsImpl: fsWithStoreFile(dbPath),
      readSessions: fakeSessions(sessions),
    });
    assert.equal(c.status, "warn", "one running session at the default cap of 1 is cap reached");
    assert.match(c.detail, /cap 1/, "the invalid overlay falls back to the default cap (1)");
    assert.match(c.detail, /settings overlay ignored/);
    assert.equal(errs.length, 0, "quiet — the doctor must not print to stderr mid-run");
  } finally {
    console.error = orig;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the task sessions detail reports auto-pickup: off without the overlay", () => {
  const dir = tempDir();
  try {
    const c = checkTaskSessions({ env: { LA_DATA_HOME: dir }, fsImpl: fs });
    assert.equal(c.status, "ok");
    assert.match(c.detail, /no managed sessions yet; auto-pickup: off$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the task sessions detail reports the enabled pickup's pollSeconds and states (FOC-902)", () => {
  const dir = tempDir();
  const settings = path.join(dir, "settings.json");
  fs.writeFileSync(
    settings,
    JSON.stringify({ taskSessions: { autoPickup: { enabled: true, pollSeconds: 120, states: ["Todo", "In Progress"] } } }),
    "utf8",
  );
  try {
    const c = checkTaskSessions({ env: { LA_DATA_HOME: dir, LA_SETTINGS_FILE: settings }, fsImpl: fs });
    assert.equal(c.status, "ok");
    assert.match(c.detail, /auto-pickup: on \(every 120s, states Todo,In Progress\)$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runChecks includes the task sessions check", async () => {
  const dir = tempDir();
  try {
    const checks = await runChecks({ env: { LA_DATA_HOME: dir }, spawn: fakeSpawn, fsImpl: fs });
    const c = checks.find((c) => c.name === "task sessions");
    assert.ok(c, "task sessions check missing");
    assert.equal(c.status, "ok");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log("\nfenix-doctor: supervisor prompt line (FOC-918)");

test("supervisor prompt: no host, no session record → ok", async () => {
  const dir = tempDir();
  try {
    const c = await checkSupervisorPrompt({ env: { LA_DATA_HOME: dir }, fsImpl: fs, readHostState: async () => null });
    assert.equal(c.status, "ok");
    assert.match(c.detail, /no Supervisor session record/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The hook writes session.json WITHOUT a pid (sessionId, transcriptPath, cwd,
// state, notification, updatedAt) — the fixture keeps that real shape.
test("supervisor prompt: no host, session.json needs-input for 11 min → warn with the since timestamp, the caveat and the fix", async () => {
  const dir = tempDir();
  const sessionFile = path.join(dir, "supervisor", "session.json");
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  const fixedNow = Date.parse("2026-10-19T12:00:00.000Z");
  const updatedAt = new Date(fixedNow - 11 * 60000).toISOString();
  fs.writeFileSync(sessionFile, JSON.stringify({ state: "needs-input", updatedAt }));
  try {
    const c = await checkSupervisorPrompt({
      env: { LA_DATA_HOME: dir },
      fsImpl: fs,
      now: () => fixedNow,
      parkedAfterMs: 10 * 60 * 1000,
      readHostState: async () => null,
    });
    assert.equal(c.status, "warn");
    assert.match(c.detail, /since 2026-.* \(11 min\)/);
    assert.match(c.detail, /stale after an Esc/);
    assert.match(c.fix, /fenix attach/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("supervisor prompt: no host, needs-input for 2 min → ok, under the threshold", async () => {
  const dir = tempDir();
  const sessionFile = path.join(dir, "supervisor", "session.json");
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  const fixedNow = Date.parse("2026-10-19T12:00:00.000Z");
  const updatedAt = new Date(fixedNow - 2 * 60000).toISOString();
  fs.writeFileSync(sessionFile, JSON.stringify({ state: "needs-input", updatedAt }));
  try {
    const c = await checkSupervisorPrompt({
      env: { LA_DATA_HOME: dir },
      fsImpl: fs,
      now: () => fixedNow,
      parkedAfterMs: 10 * 60 * 1000,
      readHostState: async () => null,
    });
    assert.equal(c.status, "ok");
    assert.match(c.detail, /waiting on a prompt for 2 min/);
    assert.match(c.detail, /under the 10-min threshold/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("supervisor prompt: no host, needs-input with an unreadable updatedAt → warn", async () => {
  const dir = tempDir();
  const sessionFile = path.join(dir, "supervisor", "session.json");
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(sessionFile, JSON.stringify({ state: "needs-input", updatedAt: "garbage" }));
  try {
    const c = await checkSupervisorPrompt({ env: { LA_DATA_HOME: dir }, fsImpl: fs, readHostState: async () => null });
    assert.equal(c.status, "warn");
    assert.match(c.detail, /since-timestamp is unreadable/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("supervisor prompt: host answers needs-input with needsInputSince 11 min ago → warn without the session.json caveat", async () => {
  const dir = tempDir();
  const fixedNow = Date.parse("2026-10-19T12:00:00.000Z");
  try {
    const c = await checkSupervisorPrompt({
      env: { LA_DATA_HOME: dir },
      fsImpl: fs,
      now: () => fixedNow,
      parkedAfterMs: 10 * 60 * 1000,
      readHostState: async () => ({ state: "needs-input", needsInputSince: new Date(fixedNow - 11 * 60000).toISOString() }),
    });
    assert.equal(c.status, "warn");
    assert.match(c.detail, /\(11 min\)/);
    assert.doesNotMatch(c.detail, /session\.json/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("supervisor prompt: host unreachable → warn 'cannot tell'; host idle → ok 'nothing waiting'", async () => {
  const dir = tempDir();
  try {
    const unreachable = await checkSupervisorPrompt({ env: { LA_DATA_HOME: dir }, fsImpl: fs, readHostState: async () => ({ unreachable: true }) });
    assert.equal(unreachable.status, "warn");
    assert.match(unreachable.detail, /did not answer/);
    const idle = await checkSupervisorPrompt({ env: { LA_DATA_HOME: dir }, fsImpl: fs, readHostState: async () => ({ state: "idle", needsInputSince: null }) });
    assert.equal(idle.status, "ok");
    assert.equal(idle.detail, "nothing waiting");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log("\nfenix-doctor: permission mode line (FOC-943)");

test("permission mode: unset → ok 'auto (declared launch default...)'", () => {
  const c = checkPermissionMode({ env: {} });
  assert.equal(c.status, "ok");
  assert.match(c.detail, /^auto \(declared launch default/);
  assert.match(c.detail, /not read from the running session/);
});

test("permission mode: env override → ok, the detail names the env var", () => {
  const c = checkPermissionMode({ env: { FENIX_SUPERVISOR_PERMISSION_MODE: "default" } });
  assert.equal(c.status, "ok");
  assert.match(c.detail, /^default \(declared via FENIX_SUPERVISOR_PERMISSION_MODE/);
  assert.match(c.detail, /not read from the running session/);
});

test("permission mode: bypassPermissions → warn with the fix", () => {
  const c = checkPermissionMode({ env: { FENIX_SUPERVISOR_PERMISSION_MODE: "bypassPermissions" } });
  assert.equal(c.status, "warn");
  assert.match(c.detail, /auto\|default\|acceptEdits\|plan/);
  assert.match(c.fix, /FENIX_SUPERVISOR_PERMISSION_MODE/);
});

test("permission mode: garbage value → warn with the fix", () => {
  const c = checkPermissionMode({ env: { FENIX_SUPERVISOR_PERMISSION_MODE: "garbage" } });
  assert.equal(c.status, "warn");
  assert.match(c.detail, /garbage/);
  assert.match(c.fix, /set FENIX_SUPERVISOR_PERMISSION_MODE to auto\|default\|acceptEdits\|plan or unset it/);
});

console.log("\nfenix-doctor: run owners (FOC-905)");

// The current identity, computed the same way the check computes it — a "mine"
// fixture built from it relates as mine on every platform (on a Windows host
// containerStartMs is null on BOTH sides, in a container it is a number).
const CURRENT_OWNER = currentOwner({});

test("run owners: no runs yet → ok", () => {
  const c = checkRunOwners({ env: {}, readOwners: () => [] });
  assert.equal(c.status, "ok");
  assert.match(c.detail, /no supervisor runs yet/);
});

test("run owners: ok line counts mine and legacy through the readOwners seam", () => {
  const c = checkRunOwners({
    env: {},
    readOwners: () => [
      { runId: "run-a", owner: { ...CURRENT_OWNER, recordedAt: "2026-10-16T09:00:00.000Z" } },
      { runId: "run-b", owner: null }, // a legacy run without owner.json
    ],
  });
  assert.equal(c.status, "ok");
  assert.match(c.detail, /2 runs: mine 1, restarted 0, legacy 1/);
});

test("run owners: a restarted owner container counts as restarted", () => {
  // Only provable when this process itself has a container start to compare
  // against (Windows hosts cannot — the time-rule cases cover the rest).
  if (CURRENT_OWNER.containerStartMs === null) {
    skipped++;
    console.log("  SKIP restarted-owner doctor line — no provable container start on this host");
    return;
  }
  const c = checkRunOwners({
    env: {},
    readOwners: () => [
      { runId: "run-c", owner: { ...CURRENT_OWNER, containerStartMs: CURRENT_OWNER.containerStartMs - 1000 } },
    ],
  });
  assert.equal(c.status, "ok");
  assert.match(c.detail, /1 runs: mine 0, restarted 1, legacy 0/);
});

test("run owners: foreign runs warn with the hostnames and never swept", () => {
  const c = checkRunOwners({
    env: {},
    readOwners: () => [
      { runId: "run-d", owner: { sessionId: null, hostname: "other-container", containerStartMs: 1000, pid: 1, recordedAt: "x" } },
      { runId: "run-e", owner: { sessionId: null, hostname: "another-container", containerStartMs: 1000, pid: 1, recordedAt: "x" } },
    ],
  });
  assert.equal(c.status, "warn");
  assert.match(c.detail, /2 run\(s\) owned by another host\/container \(another-container, other-container\)/);
  assert.match(c.detail, /never swept automatically/);
  assert.match(c.fix, /--all --yes/);
});

test("summarize turns a uid-mismatch fail into ok: false", () => {
  const { ok } = summarize([
    { name: "node", status: "ok", detail: "v22" },
    { name: "secrets readable", status: "fail", detail: "1 of 3 file(s) not readable", fix: UID_FIX },
    { name: "keys", status: "warn", detail: "present" },
  ]);
  assert.equal(ok, false);
});

console.log("\nfenix-doctor: optional integrations (FOC-772)");

test("all integrations off → ok 'none enabled'", async () => {
  const checks = await runChecks({ env: {}, settings: {}, spawn: fakeSpawn, fsImpl: fs });
  const c = checks.find((c) => c.name === "integrations");
  assert.ok(c, "integrations check missing");
  assert.equal(c.status, "ok");
  assert.equal(c.detail, "none enabled");
});

test("the integrations check sits directly after the key checks", async () => {
  const checks = await runChecks({ env: {}, settings: {}, spawn: fakeSpawn, fsImpl: fs });
  const lastIndex = checks.map((c) => c.name).lastIndexOf("GITHUB_TOKEN") + 1;
  assert.equal(checks[lastIndex].name, "integrations");
});

test("atlas enabled without its env → warn naming both variables and the fix", async () => {
  const checks = await runChecks({
    env: {},
    settings: { integrations: { atlas: true } },
    spawn: fakeSpawn,
    fsImpl: fs,
  });
  const c = checks.find((c) => c.name === "integrations");
  assert.equal(c.status, "warn");
  assert.match(c.detail, /ATLAS_ROOT/);
  assert.match(c.detail, /ATLAS_VENV_PYTHON/);
  assert.match(c.fix, /\.env|fenix keys/);
});

test("pisi enabled with the key present → ok listing the prerequisite", async () => {
  const checks = await runChecks({
    env: { LINEAR_API_KEY_PISI: "lin_api_x" },
    settings: { integrations: { pisi: true } },
    spawn: fakeSpawn,
    fsImpl: fs,
  });
  const c = checks.find((c) => c.name === "integrations");
  assert.equal(c.status, "ok");
  assert.match(c.detail, /pisi \(LINEAR_API_KEY_PISI\)/);
});

test("memory enabled → ok with no prerequisite named", async () => {
  const checks = await runChecks({
    env: {},
    settings: { integrations: { memory: true } },
    spawn: fakeSpawn,
    fsImpl: fs,
  });
  const c = checks.find((c) => c.name === "integrations");
  assert.equal(c.status, "ok");
  assert.equal(c.detail, "memory");
});

test("an invalid settings object warns and never throws", async () => {
  const checks = await runChecks({
    env: {},
    settings: { integrations: { atlas: "yes" } },
    spawn: fakeSpawn,
    fsImpl: fs,
  });
  const c = checks.find((c) => c.name === "integrations");
  assert.equal(c.status, "warn");
  assert.match(c.detail, /settings invalid/);
});

// tmpdir() itself, so the "no-such-dir" paths stay inside a writable parent.
function tempDirRoot() {
  return os.tmpdir();
}

console.log("\nfenix-doctor: FOC-780 — disk warn threshold + logs usage line");

// fsImpl whose statfsSync always reports the given number of free GiB
// (bsize pinned to 1 GiB); everything else real.
function statfsFreeGiB(freeGiB) {
  return {
    ...fs,
    statfsSync: () => ({ bavail: freeGiB, bsize: 1024 ** 3 }),
  };
}

const GIB = 1024 ** 3;

const diskCheck = async (runOpts) => {
  const checks = await runChecks({ env: { LA_TELEMETRY_HOME: "x" }, spawn: fakeSpawn, retention: async () => null, ...runOpts });
  return checks.find((c) => c.name === "disk");
};

test("warn threshold from settings: minFreeGiB 2, 3 GiB free -> ok", async () => {
  const c = await diskCheck({ fsImpl: statfsFreeGiB(3), settings: { retention: { minFreeGiB: 2 } } });
  assert.equal(c.status, "ok");
  assert.match(c.detail, /warn < 2 GiB/);
});

test("warn threshold from settings: minFreeGiB 2, 1.5 GiB free -> warn", async () => {
  const c = await diskCheck({ fsImpl: statfsFreeGiB(1.5), settings: { retention: { minFreeGiB: 2 } } });
  assert.equal(c.status, "warn");
  assert.match(c.detail, /< 2 GiB/);
});

test("the 1 GiB fail floor stays even with a low minFreeGiB", async () => {
  const c = await diskCheck({ fsImpl: statfsFreeGiB(0.8), settings: { retention: { minFreeGiB: 0.5 } } });
  assert.equal(c.status, "fail");
  assert.match(c.detail, /< 1 GiB/);
});

test("default warn threshold 5 when the retention key is absent", async () => {
  const c = await diskCheck({ fsImpl: statfsFreeGiB(3), settings: {} });
  assert.equal(c.status, "warn");
  assert.match(c.detail, /< 5 GiB/);
});

test("a settings read failure falls back to 5 and says so in the detail", async () => {
  const bad = path.join(tempDir(), "settings.json");
  fs.writeFileSync(bad, "{not json", "utf8");
  const prev = process.env.LA_SETTINGS_FILE;
  process.env.LA_SETTINGS_FILE = bad;
  try {
    const c = await diskCheck({ fsImpl: statfsFreeGiB(3) });
    assert.equal(c.status, "warn");
    assert.match(c.detail, /retention settings unreadable/);
    assert.match(c.detail, /falls back to 5 GiB/);
  } finally {
    process.env.LA_SETTINGS_FILE = prev;
    fs.rmSync(path.dirname(bad), { recursive: true, force: true });
  }
});

const usageSnapshot = {
  usage: { transcriptsBytes: 1.5 * GIB, telemetryBytes: 230 * 1024 ** 2, workspacesBytes: 12 * GIB, stateBytes: 340 * 1024 ** 2 },
  disk: { freeBytes: 42 * GIB, totalBytes: 100 * GIB },
  partial: [],
  unreadable: { transcripts: 0, telemetry: 0, workspaces: 0, state: 0 },
};

test("logs usage line: ok, humanised breakdown, placed right after disk", async () => {
  const checks = await runChecks({
    env: { LA_TELEMETRY_HOME: "x" },
    spawn: fakeSpawn,
    fsImpl: statfsFreeGiB(3),
    settings: {},
    retention: async () => usageSnapshot,
  });
  const line = checks.find((c) => c.name === "logs usage");
  assert.ok(line, "logs usage check missing");
  assert.equal(line.status, "ok");
  assert.match(line.detail, /transcripts 1\.5 GiB · telemetry 230\.0 MiB · workspaces 12\.0 GiB · state 340\.0 MiB · free 42\.0 GiB/);
  assert.equal(checks[checks.findIndex((c) => c.name === "disk") + 1].name, "logs usage");
});

test("logs usage line: partial walk or unreadable entries warn with the reason", async () => {
  const partial = {
    ...usageSnapshot,
    partial: ["transcripts"],
    unreadable: { transcripts: 2, telemetry: 0, workspaces: 0, state: 0 },
    disk: null,
  };
  const checks = await runChecks({
    env: { LA_TELEMETRY_HOME: "x" },
    spawn: fakeSpawn,
    fsImpl: statfsFreeGiB(3),
    retention: async () => partial,
  });
  const line = checks.find((c) => c.name === "logs usage");
  assert.equal(line.status, "warn");
  assert.match(line.detail, /partial walk: transcripts/);
  assert.match(line.detail, /2 unreadable entries/);
  assert.match(line.detail, /free unknown/);
});

test("logs usage line: a failed snapshot warns, never throws", async () => {
  const checks = await runChecks({
    env: { LA_TELEMETRY_HOME: "x" },
    spawn: fakeSpawn,
    fsImpl: statfsFreeGiB(3),
    retention: async () => { throw new Error("boom"); },
  });
  const line = checks.find((c) => c.name === "logs usage");
  assert.equal(line.status, "warn");
  assert.match(line.detail, /retention snapshot failed: boom/);
});

// FOC-808: the caches check — sizes + the retention.cacheMaxGb cap.
const GB = 1024 ** 3;

test("caches line: sizes under the cap are ok, fixture roots via override envs", async () => {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fenix-doctor-cache-"));
  const childTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fenix-doctor-tmp-"));
  try {
    fs.mkdirSync(path.join(cacheRoot, "npm"), { recursive: true });
    fs.writeFileSync(path.join(cacheRoot, "npm", "cacache"), "x".repeat(100));
    fs.mkdirSync(path.join(childTmpRoot, "child-x"), { recursive: true });
    fs.writeFileSync(path.join(childTmpRoot, "child-x", "scratch"), "y".repeat(50));
    const check = await checkCaches({
      env: { LA_CACHE_ROOT: cacheRoot, LA_CHILD_TMP_ROOT: childTmpRoot },
      fsImpl: fs,
    });
    assert.equal(check.name, "caches");
    assert.equal(check.status, "ok");
    assert.match(check.detail, /cache \d+ B · child tmp \d+ B · cap 5 GB \(retention\.cacheMaxGb\)/);
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
    fs.rmSync(childTmpRoot, { recursive: true, force: true });
  }
});

test("caches line: over the cap warns with the fenix prune fix", async () => {
  const check = await checkCaches({
    cacheMaxGb: 5,
    sizesReader: () => ({ tools: [{ name: "npm", bytes: 6 * GB }], totalBytes: 6 * GB, childTmpBytes: 0 }),
  });
  assert.equal(check.status, "warn");
  assert.match(check.detail, /cache 6\.0 GiB/);
  assert.equal(check.fix, "fenix prune --max-gb 5");
});

// ── gh floor (FOC-1000) ──────────────────────────────────────────────────────
console.log("\nfenix-doctor: gh version floor (FOC-1000)");

test("ghBelowFloor: Debian's 2.23 is below, the floor and newer are not, a foreign line is unknown", () => {
  assert.equal(ghBelowFloor("gh version 2.23.0 (2023-02-27)"), true);
  assert.equal(ghBelowFloor("gh version 2.88.9 (2026-01-01)"), true);
  assert.equal(ghBelowFloor(`gh version ${GH_MIN_VERSION} (2026-01-01)`), false);
  assert.equal(ghBelowFloor("gh version 2.103.0 (2026-10-01)"), false);
  assert.equal(ghBelowFloor("gh version 3.0.0 (2027-01-01)"), false);
  assert.equal(ghBelowFloor("fake 1.0"), null);
});

test("applyGhFloor: below the floor FAILs in the container with the rebuild fix, WARNs elsewhere", () => {
  const old = { name: "gh", status: "ok", detail: "gh version 2.23.0 (2023-02-27)" };
  const inImage = applyGhFloor(old, IN_CONTAINER);
  assert.equal(inImage.status, "fail");
  assert.match(inImage.detail, /gh version 2\.23\.0.*below the supported 2\.89\.0/);
  assert.equal(inImage.fix, "rebuild the image: fenix update");
  const onHost = applyGhFloor(old, {});
  assert.equal(onHost.status, "warn");
  assert.match(onHost.fix, /upgrade gh to >= 2\.89\.0/);
});

test("applyGhFloor leaves a current gh, a missing gh and other tools untouched", () => {
  const ok = { name: "gh", status: "ok", detail: "gh version 2.103.0 (2026-10-01)" };
  assert.deepEqual(applyGhFloor(ok, IN_CONTAINER), ok);
  const missing = { name: "gh", status: "fail", detail: "spawn gh ENOENT", fix: "rebuild the image: fenix update" };
  assert.deepEqual(applyGhFloor(missing, IN_CONTAINER), missing);
  const git = { name: "git", status: "ok", detail: "gh version 1.0.0" };
  assert.deepEqual(applyGhFloor(git, IN_CONTAINER), git);
});

test("the Dockerfile's build-time floor is the doctor's floor", () => {
  const dockerfile = fs.readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
  const arg = /^ARG GH_MIN_VERSION=(\S+)\s*$/m.exec(dockerfile);
  assert.ok(arg, "the Dockerfile has no ARG GH_MIN_VERSION");
  assert.equal(arg[1], GH_MIN_VERSION);
  assert.match(dockerfile, /cli\.github\.com\/packages/, "gh must come from GitHub's own apt repo");
  assert.doesNotMatch(dockerfile, /apt-get install[^\n]*\bgh\b[^\n]*tini/, "gh must not be installed from Debian's package in the base apt line");
});

// ── fenix code drift (FOC-988) ───────────────────────────────────────────────
console.log("\nfenix-doctor: fenix code vs the image manifest (FOC-988)");

// A tiny stand-in for /opt/fenix: the covered dirs and files, plus things the
// manifest must ignore (node_modules, build output, caches).
function fakeFenixTree() {
  const root = tempDir();
  const put = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  put("scripts/supervisor-spawn.mjs", "export const guard = 'duplicate-child-id';\n");
  put("scripts/supervisor-lib.mjs", "export const x = 1;\n");
  put("config/models.json", "{}\n");
  put("agents/supervisor/CLAUDE.md", "# supervisor\n");
  put("docker/entrypoint.sh", "#!/bin/sh\n");
  put("package.json", "{}\n");
  put("VERSION", "1.0.0-rc.4\n");
  // ignored: dependencies, build output, caches
  put("node_modules/x/index.js", "x");
  put("ui/dist/app.js", "x");
  put("scripts/__pycache__/a.pyc", "x");
  put("scripts/run.log", "x");
  return { root, put };
}

test("manifest: covers the code dirs and files, ignores node_modules, ui/dist and caches", () => {
  const { root } = fakeFenixTree();
  try {
    assert.deepEqual(listCodeFiles(root), [
      "VERSION",
      "agents/supervisor/CLAUDE.md",
      "config/models.json",
      "docker/entrypoint.sh",
      "package.json",
      "scripts/supervisor-lib.mjs",
      "scripts/supervisor-spawn.mjs",
    ]);
    const manifest = buildManifest(root);
    assert.equal(manifest.version, 1);
    assert.match(manifest.files["scripts/supervisor-spawn.mjs"], /^[0-9a-f]{64}$/);
    assert.deepEqual(compareToManifest(manifest, root), { modified: [], missing: [], added: [] });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("manifest: an edited file is 'modified', a deleted one 'missing', a new one 'added'", () => {
  const { root, put } = fakeFenixTree();
  try {
    const manifest = buildManifest(root);
    put("scripts/supervisor-spawn.mjs", "export const guard = null; // duplicate-child-id disabled\n");
    fs.rmSync(path.join(root, "config/models.json"));
    put("scripts/fenix-patch.mjs", "// new\n");
    assert.deepEqual(compareToManifest(manifest, root), {
      modified: ["scripts/supervisor-spawn.mjs"],
      missing: ["config/models.json"],
      added: ["scripts/fenix-patch.mjs"],
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("manifest: a registered generated output (config/models.map) is not 'added'; a forged registry excuses nothing", () => {
  const { root, put } = fakeFenixTree();
  try {
    put("config/artifacts.json", JSON.stringify({
      version: 1,
      artifacts: [
        { id: "models-map", output: "config/models.map", committed: false },
        { id: "gen-dir", output: "config/generated", committed: false },
        { id: "diagrams", output: "docs/diagrams/*.png", committed: true },
      ],
    }));
    const manifest = buildManifest(root);
    // what the entrypoint's artifact refresh writes on every healthy start
    put("config/models.map", "KEY=VALUE\n");
    put("config/generated/a.json", "{}\n");
    assert.deepEqual(compareToManifest(manifest, root).added, [], "a healthy start reports nothing");
    const doctor = tempDir();
    try {
      const manifestPath = path.join(doctor, "manifest.json");
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
      assert.equal(checkFenixCode({ env: IN_CONTAINER, manifestPath, root }).status, "ok", "fenix doctor stays green on a healthy start");
    } finally {
      fs.rmSync(doctor, { recursive: true, force: true });
    }

    // a stray script and a lookalike name are still named
    put("scripts/fenix-patch.mjs", "// stray\n");
    put("config/models.map.bak", "x");
    assert.deepEqual(compareToManifest(manifest, root).added, ["config/models.map.bak", "scripts/fenix-patch.mjs"]);

    // the registry edited to excuse a planted file: its hash no longer matches the image's, so nothing is excused
    put("config/artifacts.json", JSON.stringify({
      version: 1,
      artifacts: [
        { id: "x", output: "scripts/fenix-patch.mjs", committed: false },
        { id: "models-map", output: "config/models.map", committed: false },
      ],
    }));
    const forged = compareToManifest(manifest, root);
    assert.deepEqual(forged.modified, ["config/artifacts.json"]);
    assert.deepEqual(forged.added, ["config/generated/a.json", "config/models.map", "config/models.map.bak", "scripts/fenix-patch.mjs"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("manifest: reading — absent is null, garbage and foreign versions are errors", () => {
  const dir = tempDir();
  try {
    assert.equal(readManifest(path.join(dir, "nope.json")), null);
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(bad, "{not json");
    assert.match(readManifest(bad).error, /not valid JSON/);
    fs.writeFileSync(bad, JSON.stringify({ version: 99, files: {} }));
    assert.match(readManifest(bad).error, /not a version 1 manifest/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fenix code: natively there is nothing to check", () => {
  assert.equal(checkFenixCode({ env: {} }), null);
});

test("fenix code: clean tree is ok, an edit FAILs naming the file, a new file only WARNs, no manifest WARNs", () => {
  const { root, put } = fakeFenixTree();
  const dir = tempDir();
  const manifestPath = path.join(dir, "manifest.json");
  try {
    const noManifest = checkFenixCode({ env: IN_CONTAINER, manifestPath, root });
    assert.equal(noManifest.status, "warn");
    assert.match(noManifest.detail, /no manifest in this image/);

    fs.writeFileSync(manifestPath, JSON.stringify(buildManifest(root)));
    const clean = checkFenixCode({ env: IN_CONTAINER, manifestPath, root });
    assert.equal(clean.status, "ok");
    assert.match(clean.detail, /7 files match the image manifest/);

    put("scripts/fenix-patch.mjs", "// stray\n");
    const added = checkFenixCode({ env: IN_CONTAINER, manifestPath, root });
    assert.equal(added.status, "warn");
    assert.match(added.detail, /1 file\(s\) not in the image: scripts\/fenix-patch\.mjs/);

    put("scripts/supervisor-spawn.mjs", "// patched by the Supervisor\n");
    const drift = checkFenixCode({ env: IN_CONTAINER, manifestPath, root });
    assert.equal(drift.status, "fail");
    assert.match(drift.detail, /1 file\(s\) differ from the image: scripts\/supervisor-spawn\.mjs \(modified\)/);
    assert.match(drift.detail, /raise a hold, never patch it/);
    assert.match(drift.fix, /fenix update restores the image/);

    fs.rmSync(path.join(root, "scripts/supervisor-lib.mjs"));
    const both = checkFenixCode({ env: IN_CONTAINER, manifestPath, root });
    assert.equal(both.status, "fail");
    assert.match(both.detail, /2 file\(s\) differ/);
    assert.match(both.detail, /supervisor-lib\.mjs \(missing\)/);

    fs.writeFileSync(manifestPath, "garbage");
    assert.equal(checkFenixCode({ env: IN_CONTAINER, manifestPath, root }).status, "fail", "an unreadable manifest is not 'fine'");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fenix code: the list in the detail is capped, the count is not", () => {
  const { root, put } = fakeFenixTree();
  const dir = tempDir();
  const manifestPath = path.join(dir, "manifest.json");
  try {
    fs.writeFileSync(manifestPath, JSON.stringify(buildManifest(root)));
    for (let i = 0; i < 8; i++) put(`config/m${i}.json`, "{}"); // added: warn
    for (const f of ["scripts/supervisor-spawn.mjs", "scripts/supervisor-lib.mjs", "config/models.json", "agents/supervisor/CLAUDE.md", "docker/entrypoint.sh", "package.json", "VERSION"]) put(f, "changed\n");
    const c = checkFenixCode({ env: IN_CONTAINER, manifestPath, root });
    assert.equal(c.status, "fail");
    assert.match(c.detail, /^7 file\(s\) differ from the image: .*, … \+2 —/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// S29 / FOC-1068: deleting a helper the doctor imports used to kill it on
// import (ERR_MODULE_NOT_FOUND) before checkFenixCode could print anything. The
// manifest pass must still answer: a FAIL line naming the deleted file, never a
// stack trace.
test("a deleted helper module is a FAIL line from the manifest pass, not ERR_MODULE_NOT_FOUND", () => {
  const root = tempDir();
  const dataDir = tempDir();
  try {
    // A working copy of the real doctor tree, so the dynamic imports resolve
    // the same way they do in the image.
    const realScripts = path.dirname(fileURLToPath(new URL("./fenix-doctor.mjs", import.meta.url)));
    const scripts = path.join(root, "scripts");
    fs.cpSync(realScripts, scripts, { recursive: true });
    fs.rmSync(path.join(scripts, "supervisor-lib.mjs"), { force: true });

    const manifestPath = path.join(root, "manifest.json");
    // The manifest names the deleted file, so compareToManifest reports it as
    // missing — that is the FAIL line we expect the doctor to print.
    fs.writeFileSync(manifestPath, JSON.stringify({ version: 1, files: { "scripts/supervisor-lib.mjs": "0".repeat(64) } }));

    const r = spawnSync(process.execPath, [path.join(scripts, "fenix-doctor.mjs")], {
      encoding: "utf8",
      timeout: 60000,
      env: {
        ...process.env,
        FENIX_IN_CONTAINER: "1",
        LA_ROOT: root,
        LA_FENIX_MANIFEST: manifestPath,
        LA_DATA_HOME: path.join(dataDir, "data"),
        LA_TELEMETRY_HOME: path.join(dataDir, "telemetry"),
        LA_SUPERVISOR_STATE_HOME: path.join(dataDir, "state"),
        FENIX_WORKSPACES: path.join(dataDir, "workspaces"),
      },
    });
    const out = `${r.stdout}\n${r.stderr}`;
    assert.ok(!/ERR_MODULE_NOT_FOUND/.test(out), `doctor must not die on import:\n${out}`);
    assert.ok(!/Cannot find module/.test(r.stderr), `import errors must not reach stderr:\n${r.stderr}`);
    assert.match(r.stdout, /FAIL fenix code — .*supervisor-lib\.mjs \(missing\)/);
    assert.equal(r.status, 1, `a FAIL must exit 1:\n${out}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("the Dockerfile bakes the manifest outside /opt/fenix, root-owned and read-only (FOC-988)", () => {
  const dockerfile = fs.readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /fenix-manifest\.mjs write --root \/opt\/fenix --out \/usr\/local\/share\/fenix\/manifest\.json/);
  assert.match(dockerfile, /chmod 0444 \/usr\/local\/share\/fenix\/manifest\.json/);
  // written as root, then back to the runtime user
  const at = dockerfile.indexOf("fenix-manifest.mjs write");
  assert.ok(dockerfile.lastIndexOf("USER root", at) > dockerfile.lastIndexOf("USER node", at), "the manifest step must run as root");
  assert.ok(dockerfile.indexOf("USER node", at) > at, "the image must return to USER node after it");
});

console.log(`\nfenix-doctor: ${passed} passed, ${skipped} skipped, ${failures.length} failed`);
if (failures.length) {
  console.error("FAILURES:\n - " + failures.join("\n - "));
  process.exit(1);
}
