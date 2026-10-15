// scripts/fenix-retention.test.mjs — FOC-786 slice E: the retention snapshot.
//
// Everything runs against mkdtemp scratch dirs removed afterwards — the
// library is read-only and these tests never touch real Fenix state. Run:
//   node --test scripts/fenix-retention.test.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  promises as fs,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { cachedRetention, readRetention } from "./fenix-retention.mjs";

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "fenix-retention-"));
}

function fileAt(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.alloc(bytes, 0x61));
}

function textAt(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function optsFor(root) {
  return {
    squadHome: join(root, "agents"),
    telemetryHome: join(root, "telemetry"),
    workspacesRoot: join(root, "workspaces"),
    stateRoot: join(root, "state"),
  };
}

test("mixed policy and byte sums over nested dirs", async () => {
  const root = tempRoot();
  try {
    const squadHome = join(root, "agents");
    textAt(join(squadHome, "alpha", "settings.json"), JSON.stringify({ cleanupPeriodDays: 36500 }));
    fileAt(join(squadHome, "alpha", "projects", "p1", "sub", "a.jsonl"), 10);
    fileAt(join(squadHome, "alpha", "projects", "p1", "sub", "b.jsonl"), 20);
    fileAt(join(squadHome, "alpha", "projects", "p1", "c.jsonl"), 30);
    fileAt(join(squadHome, "alpha", "projects", "p2", "d.jsonl"), 5);
    textAt(join(squadHome, "beta", "settings.json"), JSON.stringify({ cleanupPeriodDays: 30 }));
    fileAt(join(squadHome, "beta", "projects", "s", "x.jsonl"), 3);
    fileAt(join(squadHome, "beta", "other.log"), 9); // not under projects/ — must not count
    fileAt(join(root, "telemetry", "ev.jsonl"), 100);
    fileAt(join(root, "telemetry", "day2", "ev2.jsonl"), 7);
    fileAt(join(root, "workspaces", "repo", "f.txt"), 11);
    fileAt(join(root, "workspaces", "repo", "sub", "g.txt"), 4);
    fileAt(join(root, "state", "runs", "r1", "decisions.jsonl"), 3);

    const r = await readRetention(optsFor(root));
    assert.equal(r.policy, "mixed");
    assert.deepEqual(r.cleanupPeriodDays, { alpha: 36500, beta: 30 });
    assert.deepEqual(r.usage, {
      transcriptsBytes: 68, // 65 under alpha/projects + 3 under beta/projects
      telemetryBytes: 107,
      workspacesBytes: 15,
      stateBytes: 3,
    });
    assert.deepEqual(r.partial, []);
    assert.deepEqual(r.unreadable, { transcripts: 0, telemetry: 0, workspaces: 0, state: 0 });
    assert.equal(r.managedBy, "FOC-780");
    assert.ok(!Number.isNaN(Date.parse(r.computedAt)));
    if (typeof fs.statfs === "function") {
      assert.equal(typeof r.disk.freeBytes, "number");
      assert.equal(typeof r.disk.totalBytes, "number");
      assert.ok(r.disk.freeBytes >= 0 && r.disk.freeBytes <= r.disk.totalBytes);
    } else {
      assert.equal(r.disk, null);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("both squads at 36500 -> keep-all; computedAt honours now", async () => {
  const root = tempRoot();
  try {
    textAt(join(root, "agents", "a1", "settings.json"), JSON.stringify({ cleanupPeriodDays: 36500 }));
    textAt(join(root, "agents", "a2", "settings.json"), JSON.stringify({ cleanupPeriodDays: 36500 }));
    const r = await readRetention({ ...optsFor(root), now: 0 });
    assert.equal(r.policy, "keep-all");
    assert.deepEqual(r.cleanupPeriodDays, { a1: 36500, a2: 36500 });
    assert.equal(r.computedAt, "1970-01-01T00:00:00.000Z");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no cleanupPeriodDays anywhere -> unknown", async () => {
  const root = tempRoot();
  try {
    mkdirSync(join(root, "agents", "solo"), { recursive: true });
    const r = await readRetention(optsFor(root));
    assert.equal(r.policy, "unknown");
    assert.deepEqual(r.cleanupPeriodDays, { solo: null });
    // a missing squad home tells the same story, and disk is null (path absent)
    const r2 = await readRetention({ ...optsFor(root), squadHome: join(root, "nope") });
    assert.equal(r2.policy, "unknown");
    assert.deepEqual(r2.cleanupPeriodDays, {});
    assert.equal(r2.disk, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unparseable or non-numeric cleanupPeriodDays -> null", async () => {
  const root = tempRoot();
  try {
    textAt(join(root, "agents", "s1", "settings.json"), "{ not json");
    textAt(join(root, "agents", "s2", "settings.json"), JSON.stringify({ cleanupPeriodDays: "abc" }));
    textAt(join(root, "agents", "s3", "settings.json"), JSON.stringify({ cleanupPeriodDays: "90" }));
    textAt(join(root, "agents", "s4", "settings.json"), JSON.stringify({}));
    const r = await readRetention(optsFor(root));
    assert.deepEqual(r.cleanupPeriodDays, { s1: null, s2: null, s3: 90, s4: null });
    assert.equal(r.policy, "days"); // the single set value, 90
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("symlinks are not followed when summing bytes", async (t) => {
  const root = tempRoot();
  try {
    fileAt(join(root, "outside", "secret.bin"), 500);
    const projects = join(root, "agents", "solo", "projects");
    mkdirSync(projects, { recursive: true });
    let linked = false;
    try {
      if (process.platform === "win32") {
        symlinkSync(join(root, "outside"), join(projects, "link"), "junction");
      } else {
        symlinkSync(join(root, "outside", "secret.bin"), join(projects, "link"));
      }
      linked = true;
    } catch {
      linked = false;
    }
    if (!linked) return t.skip("symlink creation is not permitted for this account");
    const r = await readRetention(optsFor(root));
    assert.equal(r.usage.transcriptsBytes, 0); // the 500-byte target was never entered
    assert.ok(existsSync(join(root, "outside", "secret.bin"))); // and untouched
    assert.deepEqual(r.partial, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unreadable entry is tolerated and counted", async () => {
  const root = tempRoot();
  try {
    const projects = join(root, "agents", "solo", "projects");
    fileAt(join(projects, "good.bin"), 7);
    fileAt(join(projects, "boom.bin"), 100);
    const realLstat = fs.lstat.bind(fs);
    const lstatImpl = (p) =>
      basename(p) === "boom.bin" ? Promise.reject(new Error("injected EACCES")) : realLstat(p);
    const r = await readRetention({ ...optsFor(root), lstatImpl });
    assert.equal(r.usage.transcriptsBytes, 7); // the unreadable entry contributes nothing
    assert.ok(r.unreadable.transcripts >= 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "an unreadable directory is tolerated (POSIX perms)",
  { skip: process.platform === "win32" ? "chmod(2) is advisory on Windows" : false },
  async (t) => {
    const root = tempRoot();
    let locked = null;
    try {
      const projects = join(root, "agents", "solo", "projects");
      fileAt(join(projects, "good.bin"), 5);
      locked = join(projects, "locked");
      fileAt(join(locked, "inner.bin"), 64);
      chmodSync(locked, 0o000);
      // root can read regardless of the mode — if so, the fixture proves nothing
      let stillReadable = false;
      try {
        readdirSync(locked);
        stillReadable = true;
      } catch {}
      if (stillReadable) return t.skip("running with read-anywhere privileges (root?)");
      const r = await readRetention(optsFor(root));
      assert.equal(r.usage.transcriptsBytes, 5);
      assert.ok(r.unreadable.transcripts >= 1);
    } finally {
      if (locked) {
        try {
          chmodSync(locked, 0o700);
        } catch {}
      }
      rmSync(root, { recursive: true, force: true });
    }
  }
);

test("the entry cap marks the root partial and keeps a lower bound", async () => {
  const root = tempRoot();
  const prev = process.env.FENIX_RETENTION_MAX_ENTRIES;
  try {
    const projects = join(root, "agents", "solo", "projects");
    fileAt(join(projects, "f1.bin"), 10);
    fileAt(join(projects, "f2.bin"), 20);
    fileAt(join(projects, "f3.bin"), 30);
    fileAt(join(projects, "d1", "f4.bin"), 1);
    const opts = optsFor(root);

    const full = await readRetention(opts);
    assert.equal(full.usage.transcriptsBytes, 61);
    assert.deepEqual(full.partial, []);

    process.env.FENIX_RETENTION_MAX_ENTRIES = "3";
    const capped = await readRetention(opts);
    assert.ok(capped.partial.includes("transcripts"));
    assert.ok(capped.usage.transcriptsBytes > 0);
    assert.ok(capped.usage.transcriptsBytes < 61); // lower bound, never the whole tree
    assert.equal(capped.unreadable.transcripts, 0);
  } finally {
    if (prev === undefined) delete process.env.FENIX_RETENTION_MAX_ENTRIES;
    else process.env.FENIX_RETENTION_MAX_ENTRIES = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

test("disk reports statfs free/total when the Node version has it", async () => {
  const root = tempRoot();
  try {
    mkdirSync(join(root, "workspaces"), { recursive: true }); // statfs target must exist
    const r = await readRetention(optsFor(root));
    if (typeof fs.statfs !== "function") {
      assert.equal(r.disk, null);
      return;
    }
    assert.ok(r.disk, "statfs exists so disk must be present");
    assert.equal(typeof r.disk.freeBytes, "number");
    assert.equal(typeof r.disk.totalBytes, "number");
    assert.ok(Number.isFinite(r.disk.freeBytes) && Number.isFinite(r.disk.totalBytes));
    assert.ok(r.disk.freeBytes >= 0 && r.disk.freeBytes <= r.disk.totalBytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cachedRetention serves one computation within the TTL", async () => {
  const root = tempRoot();
  try {
    textAt(join(root, "agents", "solo", "settings.json"), JSON.stringify({ cleanupPeriodDays: 36500 }));
    const opts = optsFor(root);
    const first = await cachedRetention(opts, { ttlMs: 60000 });
    const second = await cachedRetention(opts, { ttlMs: 60000 });
    assert.strictEqual(first, second); // same object — not recomputed
    const other = { ...opts, squadHome: join(root, "agents-b") };
    const third = await cachedRetention(other, { ttlMs: 60000 });
    assert.notStrictEqual(first, third); // a different option set is its own entry
    assert.equal(third.policy, "unknown");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspacesRoot defaults to GITHUB_ROOT when it is set", async () => {
  const root = tempRoot();
  const prev = process.env.GITHUB_ROOT;
  try {
    fileAt(join(root, "ws", "w.bin"), 9);
    process.env.GITHUB_ROOT = join(root, "ws");
    const r = await readRetention({
      squadHome: join(root, "agents"),
      telemetryHome: join(root, "t"),
      stateRoot: join(root, "s"),
    });
    assert.equal(r.usage.workspacesBytes, 9);
  } finally {
    if (prev === undefined) delete process.env.GITHUB_ROOT;
    else process.env.GITHUB_ROOT = prev;
    rmSync(root, { recursive: true, force: true });
  }
});
