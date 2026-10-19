// scripts/fenix-prune.test.mjs — FOC-808: cache prune and child-tmp sweep.
//
// Runs against fixture roots via the LA_CACHE_ROOT / LA_CHILD_TMP_ROOT /
// LA_SUPERVISOR_STATE_HOME-shaped function args (never the real /home or /tmp;
// never /data — there is a dedicated guard test). The live-pid test uses this
// process's own pid, so the registry liveness check works on Windows too.
//
// Run: node scripts/fenix-prune.test.mjs   (also: node --test <this file>)

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cacheToolSizes,
  cacheLeafEntries,
  childTmpSizes,
  liveChildIds,
  pruneCache,
  resolveCapBytes,
  sweepChildTmp,
  assertNotData,
} from "./fenix-prune.mjs";

let passed = 0;
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

const GB = 1024 ** 3;

function fixtureRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fenix-prune-"));
}

function writeTree(root, rel, bytes) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(bytes, 1));
  return p;
}

// writeTree + a fixed atime, so prune-by-atime order is deterministic.
function writeAt(root, rel, bytes, atimeMs) {
  const p = writeTree(root, rel, bytes);
  fs.utimesSync(p, new Date(atimeMs), new Date(atimeMs));
  return p;
}

// ── sizes report ────────────────────────────────────────────────────────────

test("cacheToolSizes reports one row per tool dir, biggest first", () => {
  const root = fixtureRoot();
  try {
    writeTree(root, "npm/_cacache/a", 100);
    writeTree(root, "pip/wheels/x", 400);
    writeTree(root, "uv/wheels/y", 50);
    const tools = cacheToolSizes(root);
    assert.deepEqual(
      tools.map((t) => t.name),
      ["pip", "npm", "uv"],
    );
    assert.ok(tools[0].bytes >= 400);
    // loose files at the root are not tool rows
    writeTree(root, "stray", 10);
    assert.equal(cacheToolSizes(root).length, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cacheToolSizes on a missing root returns empty, never throws", () => {
  assert.deepEqual(cacheToolSizes(path.join(os.tmpdir(), "fenix-prune-nope-" + Date.now())), []);
});

test("childTmpSizes reports one row per child dir", () => {
  const root = fixtureRoot();
  try {
    writeTree(root, "child-a/tmp/x", 30);
    writeTree(root, "child-b/tmp/y", 20);
    const sizes = childTmpSizes(root);
    assert.deepEqual(
      sizes.map((c) => c.childId),
      ["child-a", "child-b"],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── cap pruning by atime ────────────────────────────────────────────────────

test("pruneCache deletes oldest-by-atime until under the cap, keeps the newest", () => {
  const root = fixtureRoot();
  try {
    const t0 = new Date("2026-01-01T00:00:00Z").getTime();
    const p1 = writeAt(root, "npm/old", 900, t0);
    const p2 = writeAt(root, "pip/middle", 900, t0 + 1000);
    const p3 = writeAt(root, "uv/new", 900, t0 + 2000);
    const res = pruneCache({ cacheRoot: root, capBytes: 1 * GB, dryRun: false });
    // total is ~2.7 KiB — already under 1 GB, nothing goes
    assert.equal(res.removed.length, 0);
    assert.ok(fs.existsSync(p1));

    // cap set so exactly the two oldest must leave (each frees 900 bytes of
    // payload; platform dir-entry sizes vary, payload ordering does not)
    const total0 = cacheToolSizes(root).reduce((s, t) => s + t.bytes, 0);
    const res2 = pruneCache({ cacheRoot: root, capBytes: total0 - 1500, dryRun: false });
    assert.ok(!fs.existsSync(p1), "oldest removed");
    assert.ok(!fs.existsSync(p2), "second-oldest removed");
    assert.ok(fs.existsSync(p3), "newest kept");
    assert.ok(res2.afterBytes <= total0 - 1500);
    assert.ok(fs.existsSync(path.join(root, "npm")), "tool dir itself survives");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pruneCache dry-run reports the same plan and writes nothing", () => {
  const root = fixtureRoot();
  try {
    const t0 = new Date("2026-01-01T00:00:00Z").getTime();
    const p1 = writeAt(root, "npm/old", 900, t0);
    const p2 = writeAt(root, "pip/new", 900, t0 + 5000);
    const total0 = cacheToolSizes(root).reduce((s, t) => s + t.bytes, 0);
    // cap = total - 800: freeing the oldest entry (900 payload bytes) suffices,
    // so exactly p1 goes — deterministic in payload bytes on every platform
    const dry = pruneCache({ cacheRoot: root, capBytes: total0 - 800, dryRun: true });
    assert.deepEqual(dry.removed.map((r) => r.path), [p1]);
    assert.ok(fs.existsSync(p1), "dry-run wrote nothing");
    assert.ok(fs.existsSync(p2), "dry-run wrote nothing");
    // the real run then removes exactly what the plan said
    pruneCache({ cacheRoot: root, capBytes: total0 - 800, dryRun: false });
    assert.ok(!fs.existsSync(p1) && fs.existsSync(p2));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pruneCache excludes a failed rm from freedBytes (error leaf stays on disk)", () => {
  const root = fixtureRoot();
  try {
    const t0 = new Date("2026-01-01T00:00:00Z").getTime();
    const p1 = writeAt(root, "npm/old", 900, t0); // will fail to delete
    const p2 = writeAt(root, "pip/new", 900, t0 + 5000);
    const total0 = cacheToolSizes(root).reduce((s, t) => s + t.bytes, 0);
    // rm wrapper that throws only for the oldest leaf — the leak-rm scenario
    const broken = new Proxy(fs, {
      get(target, prop) {
        if (prop !== "rmSync") return target[prop];
        return (p, opts) => {
          if (p === p1) throw new Error("EPERM: undeletable leaf");
          return target.rmSync(p, opts);
        };
      },
    });
    const res = pruneCache({ cacheRoot: root, capBytes: total0 - 800, dryRun: false, fsImpl: broken });
    const failed = res.removed.find((r) => r.path === p1);
    assert.ok(failed && failed.error, "failed leaf is reported with its error");
    assert.ok(fs.existsSync(p1), "failed leaf is still on disk");
    // only the actually-removed leaves count as freed
    const freedOk = res.removed.filter((r) => !r.error).reduce((s, r) => s + r.bytes, 0);
    assert.equal(res.freedBytes, freedOk);
    assert.equal(res.freedBytes, res.beforeBytes - res.afterBytes, "freedBytes === beforeBytes − afterBytes");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── /data guard ─────────────────────────────────────────────────────────────

test("assertNotData refuses /data roots (prune never touches /data)", () => {
  assert.throws(() => assertNotData("/data", "cache root"), /never touches \/data/);
  assert.throws(() => assertNotData("/data/cache", "cache root"), /never touches \/data/);
  assert.throws(() => assertNotData("/data/state", "child tmp root"), /never touches \/data/);
  assert.doesNotThrow(() => assertNotData("/home/node/.cache", "cache root"));
  assert.doesNotThrow(() => assertNotData("/tmp/fenix-child", "child tmp root"));
});

test("pruneCache refuses a /data cache root", () => {
  assert.throws(() => pruneCache({ cacheRoot: "/data/cache", capBytes: 1 }), /never touches \/data/);
});

test("assertNotData refuses a symlinked root pointing into the data home", () => {
  const root = fixtureRoot();
  try {
    const fakeData = path.join(root, "fake-data");
    fs.mkdirSync(path.join(fakeData, "cache"), { recursive: true });
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside, { recursive: true });
    const link = path.join(root, "link");
    let linked = false;
    try {
      fs.symlinkSync(fakeData, link, "dir");
      linked = true;
    } catch {
      try {
        fs.symlinkSync(fakeData, link, "junction"); // Windows fallback, no admin needed
        linked = true;
      } catch {
        // fall through — SKIP below
      }
    }
    if (!linked) {
      console.log("  SKIP assertNotData symlink root (symlink creation not permitted on this host)");
      return;
    }
    // a symlink OUTSIDE the data home is fine…
    assert.doesNotThrow(() => assertNotData(link, "cache root", { dataHome: outside }));
    // …but one resolving INTO the data home is refused like a raw /data path
    assert.throws(() => assertNotData(link, "cache root", { dataHome: fakeData }), /never touches \/data/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── resolveCapBytes ─────────────────────────────────────────────────────────

test("resolveCapBytes: explicit arg wins, garbage refused", () => {
  assert.equal(resolveCapBytes(2), 2 * GB);
  assert.throws(() => resolveCapBytes(0), /integer >= 1/);
  assert.throws(() => resolveCapBytes(1.5), /integer >= 1/);
});

// ── child tmp sweep: live kept, dead removed ────────────────────────────────

test("sweepChildTmp keeps a live child's dir, removes the dead one", () => {
  const tmpRoot = fixtureRoot();
  const stateRoot = fixtureRoot();
  try {
    writeTree(tmpRoot, "child-live/tmp/x", 10);
    writeTree(tmpRoot, "child-dead/tmp/y", 10);
    writeTree(tmpRoot, "child-stale/tmp/w", 10);
    writeTree(tmpRoot, "child-unknown/tmp/z", 10);
    fs.mkdirSync(path.join(stateRoot, "run-1"), { recursive: true });
    fs.writeFileSync(
      path.join(stateRoot, "run-1", "children.json"),
      JSON.stringify({
        runId: "run-1",
        children: {
          "child-live": { status: "running", pid: process.pid }, // alive: this process
          "child-dead": { status: "finished", pid: process.pid }, // terminal status
          "child-stale": { status: "running", pid: 999999999 }, // claims running, pid gone
        },
      }),
    );
    const res = sweepChildTmp({ childTmpRoot: tmpRoot, stateRoot, dryRun: false });
    assert.deepEqual(res.kept, ["child-live"]);
    assert.deepEqual(
      [...res.removed].sort(),
      ["child-dead", "child-stale", "child-unknown"],
    );
    assert.ok(fs.existsSync(path.join(tmpRoot, "child-live")));
    assert.ok(!fs.existsSync(path.join(tmpRoot, "child-dead")));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("liveChildIds skips a corrupt registry with a note, never treats it as all-dead", () => {
  const stateRoot = fixtureRoot();
  try {
    fs.mkdirSync(path.join(stateRoot, "run-ok"), { recursive: true });
    fs.writeFileSync(path.join(stateRoot, "run-ok", "children.json"), JSON.stringify({ children: { c1: { status: "running", pid: process.pid } } }));
    fs.mkdirSync(path.join(stateRoot, "run-bad"), { recursive: true });
    fs.writeFileSync(path.join(stateRoot, "run-bad", "children.json"), "{not json");
    const { live, errors } = liveChildIds(stateRoot);
    assert.ok(live.has("c1"));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /run-bad/);
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("sweepChildTmp dry-run keeps every dir and reports the same removals", () => {
  const tmpRoot = fixtureRoot();
  const stateRoot = fixtureRoot();
  try {
    writeTree(tmpRoot, "child-a/tmp/x", 10);
    fs.mkdirSync(path.join(stateRoot, "run-1"), { recursive: true });
    fs.writeFileSync(path.join(stateRoot, "run-1", "children.json"), JSON.stringify({ children: {} }));
    const res = sweepChildTmp({ childTmpRoot: tmpRoot, stateRoot, dryRun: true });
    assert.deepEqual(res.removed, ["child-a"]);
    assert.ok(fs.existsSync(path.join(tmpRoot, "child-a")), "dry-run wrote nothing");
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("cacheLeafEntries: depth-2 leaves carry subtree bytes and atime", () => {
  const root = fixtureRoot();
  try {
    const t0 = new Date("2026-01-01T00:00:00Z").getTime();
    // a directory leaf ("npm/sub" at depth 2): its whole subtree counts, its
    // own atime orders it; creating the file inside first, then stamping.
    writeTree(root, "npm/sub/dir", 100);
    fs.utimesSync(path.join(root, "npm", "sub"), new Date(t0), new Date(t0));
    writeAt(root, "npm/loose-file", 500, t0);
    const leaves = cacheLeafEntries(root);
    assert.equal(leaves.length, 2);
    const dirLeaf = leaves.find((l) => l.isDir);
    assert.ok(dirLeaf.bytes >= 100, `dir leaf carries its subtree (${dirLeaf.bytes})`);
    assert.equal(dirLeaf.atimeMs, t0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

console.log(`\nfenix-prune: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("FAILURES:\n - " + failures.join("\n - "));
  process.exit(1);
}
