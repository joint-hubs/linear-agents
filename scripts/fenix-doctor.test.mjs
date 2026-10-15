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
  runChecks,
  summarize,
} from "./fenix-doctor.mjs";

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

console.log(`\nfenix-doctor: ${passed} passed, ${skipped} skipped, ${failures.length} failed`);
if (failures.length) {
  console.error("FAILURES:\n - " + failures.join("\n - "));
  process.exit(1);
}
