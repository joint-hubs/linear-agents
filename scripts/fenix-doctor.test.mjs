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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkProjectsDir,
  checkSecretsReadable,
  checkTaskSessions,
  runChecks,
  summarize,
} from "./fenix-doctor.mjs";
import { pidAlive } from "./supervisor-current-run.mjs";

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
    spawn: () => ({ status: 0, stdout: "fake 1.0\n" }),
    fsImpl: fs,
  });
  assert.equal(checks.some((c) => c.name === "secrets readable"), false);
  assert.equal(checks.some((c) => c.name === "config writable"), false);
});

test("with FENIX_IN_CONTAINER=1 both uid checks run, with injected paths", async () => {
  const dir = tempDir();
  try {
    const checks = await runChecks({
      env: { ...IN_CONTAINER, LA_PROJECTS_FILE: path.join(dir, "projects.json") },
      spawn: fakeSpawn,
      fsImpl: fs,
      secretsDir: dir,
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
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log("\nfenix-doctor: /data volume uid fix (FOC-803 re-own)");

test("a failing /data dir check in the container names the one-time re-own fix", async () => {
  const checks = await runChecks({
    env: { ...IN_CONTAINER, LA_TELEMETRY_HOME: "/data/telemetry" },
    spawn: fakeSpawn,
    fsImpl: fsWithDeniedDir("/data/telemetry"),
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
      spawn: fakeSpawn,
      fsImpl: fsWithDeniedDir(dir),
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
      spawn: fakeSpawn,
      fsImpl: fsWithDeniedDir(dir),
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

test("2 active / cap 2 → warn 'cap reached' with the ids and the key fix", () => {
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
    assert.match(c.detail, /2 active \/ cap 2/);
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
  try {
    const c = checkTaskSessions({
      env: { LA_DATA_HOME: dir },
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
  try {
    const c = checkTaskSessions({
      env: { LA_DATA_HOME: dir },
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
    assert.equal(c.status, "ok");
    assert.match(c.detail, /cap 2/, "the invalid overlay falls back to the default cap");
    assert.match(c.detail, /settings overlay ignored/);
    assert.equal(errs.length, 0, "quiet — the doctor must not print to stderr mid-run");
  } finally {
    console.error = orig;
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

test("summarize turns a uid-mismatch fail into ok: false", () => {
  const { ok } = summarize([
    { name: "node", status: "ok", detail: "v22" },
    { name: "secrets readable", status: "fail", detail: "1 of 3 file(s) not readable", fix: UID_FIX },
    { name: "keys", status: "warn", detail: "present" },
  ]);
  assert.equal(ok, false);
});

// tmpdir() itself, so the "no-such-dir" paths stay inside a writable parent.
function tempDirRoot() {
  return os.tmpdir();
}

console.log(`\nfenix-doctor: ${passed} passed, ${skipped} skipped, ${failures.length} failed`);
if (failures.length) {
  console.error("FAILURES:\n - " + failures.join("\n - "));
  process.exit(1);
}
