// scripts/fenix-retention.test.mjs — FOC-786 slice E (the retention snapshot)
// and FOC-780 (apply/prune): resolveRetention, applyRetention, pruneRuns and
// the show/apply/prune CLI.
//
// Everything runs against mkdtemp scratch dirs removed afterwards — writes and
// deletions land only under per-test mkdtemp roots; the CLI children run with
// every path seam (LA_SETTINGS_FILE, LA_SQUAD_HOME, LA_STATE_ROOT,
// LA_SUPERVISOR_STATE_HOME, LA_DATA_HOME, LA_TELEMETRY_HOME) pointed at those
// roots. Run:
//   node --test scripts/fenix-retention.test.mjs

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  promises as fs,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  applyRetention,
  cachedPrunable,
  cachedRetention,
  pruneRuns,
  readRetention,
  resolveRetention,
} from "./fenix-retention.mjs";
import { writeCurrentRun } from "./supervisor-current-run.mjs";

const execFileP = promisify(execFile);
const CLI = fileURLToPath(new URL("./fenix-retention.mjs", import.meta.url));

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

// ---------------------------------------------------------------------------
// FOC-780 — resolveRetention / applyRetention / pruneRuns / CLI
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** Push every file AND directory in the tree (and the root) back `days`. */
function ageTree(root, days, now = Date.now()) {
  const t = new Date(now - days * DAY_MS);
  utimesSync(root, t, t);
  for (const ent of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, ent.name);
    if (ent.isDirectory()) ageTree(p, days, now);
    else utimesSync(p, t, t);
  }
}

test("resolveRetention: the default keeps everything at the 36500 stop", () => {
  assert.deepEqual(resolveRetention({}), { keepDays: null, cleanupPeriodDays: 36500, minFreeGiB: 5 });
  assert.deepEqual(resolveRetention({ retention: { keepDays: null } }), {
    keepDays: null,
    cleanupPeriodDays: 36500,
    minFreeGiB: 5,
  });
  // absent retention entirely (real emptySettings shape) — same story
  assert.deepEqual(resolveRetention({ provider: { active: null } }), resolveRetention({}));
});

test("resolveRetention: a configured keepDays and minFreeGiB come through", () => {
  assert.deepEqual(resolveRetention({ retention: { keepDays: 30, minFreeGiB: 2 } }), {
    keepDays: 30,
    cleanupPeriodDays: 30,
    minFreeGiB: 2,
  });
  // minFreeGiB null falls back to the default
  assert.deepEqual(resolveRetention({ retention: { keepDays: 7, minFreeGiB: null } }).minFreeGiB, 5);
});

test("resolveRetention: invalid retention throws with the validation errors", () => {
  assert.throws(
    () => resolveRetention({ retention: { keepDays: 0 } }),
    (err) => err.message.includes("retention.keepDays"),
  );
  assert.throws(
    () => resolveRetention({ retention: { nope: 1 } }),
    (err) => err.message.includes("retention.nope"),
  );
});

test("applyRetention: rewrites only differing squads, preserves key order, creates missing", async () => {
  const root = tempRoot();
  try {
    const squadHome = join(root, "agents");
    // alpha already at the target — untouched
    textAt(join(squadHome, "alpha", "settings.json"), JSON.stringify({ cleanupPeriodDays: 36500 }));
    // beta differs, and its own key order must survive the rewrite
    textAt(
      join(squadHome, "beta", "settings.json"),
      JSON.stringify({ zebra: true, cleanupPeriodDays: 30, apiKeyHelper: "x" }),
    );
    // delta has no settings.json yet — the file is created
    mkdirSync(join(squadHome, "delta"), { recursive: true });
    // gamma is not valid JSON — skipped, never thrown
    textAt(join(squadHome, "gamma", "settings.json"), "{ not json");

    const r = await applyRetention({ squadHome });
    assert.equal(r.cleanupPeriodDays, 36500);
    assert.deepEqual(r.changed, [
      { squad: "beta", from: 30, to: 36500 },
      { squad: "delta", from: null, to: 36500 },
    ]);
    assert.deepEqual(r.unchanged, ["alpha"]);
    assert.deepEqual(r.skipped, [{ squad: "gamma", reason: "invalid json" }]);

    assert.deepEqual(JSON.parse(readFileSync(join(squadHome, "alpha", "settings.json"), "utf8")), {
      cleanupPeriodDays: 36500,
    });
    // key order kept: zebra, cleanupPeriodDays (in place), apiKeyHelper
    const betaRaw = readFileSync(join(squadHome, "beta", "settings.json"), "utf8");
    const betaKeys = JSON.parse(betaRaw);
    assert.deepEqual(Object.keys(betaKeys), ["zebra", "cleanupPeriodDays", "apiKeyHelper"]);
    assert.equal(betaKeys.cleanupPeriodDays, 36500);
    assert.deepEqual(JSON.parse(readFileSync(join(squadHome, "delta", "settings.json"), "utf8")), {
      cleanupPeriodDays: 36500,
    });
    assert.equal(readFileSync(join(squadHome, "gamma", "settings.json"), "utf8"), "{ not json");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("applyRetention: the string spelling of the same value counts as unchanged", async () => {
  const root = tempRoot();
  try {
    const squadHome = join(root, "agents");
    const before = JSON.stringify({ cleanupPeriodDays: "36500" });
    textAt(join(squadHome, "alpha", "settings.json"), before);
    const r = await applyRetention({ squadHome });
    assert.deepEqual(r.unchanged, ["alpha"]);
    assert.deepEqual(r.changed, []);
    assert.equal(readFileSync(join(squadHome, "alpha", "settings.json"), "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("applyRetention: honours the configured keepDays and a dry run writes nothing", async () => {
  const root = tempRoot();
  try {
    const squadHome = join(root, "agents");
    textAt(join(squadHome, "alpha", "settings.json"), JSON.stringify({ cleanupPeriodDays: 30 }));
    const settings = { retention: { keepDays: 14 } };
    const raw = (squad) => readFileSync(join(squadHome, squad, "settings.json"), "utf8");

    const dry = await applyRetention({ squadHome, settings, dryRun: true });
    assert.equal(dry.cleanupPeriodDays, 14);
    assert.deepEqual(dry.changed, [{ squad: "alpha", from: 30, to: 14 }]);
    assert.equal(raw("alpha"), JSON.stringify({ cleanupPeriodDays: 30 })); // untouched

    const real = await applyRetention({ squadHome, settings });
    assert.deepEqual(real.changed, [{ squad: "alpha", from: 30, to: 14 }]);
    assert.deepEqual(JSON.parse(raw("alpha")), { cleanupPeriodDays: 14 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pruneRuns: keepDays null refuses without touching disk", async () => {
  const root = tempRoot();
  try {
    const runs = join(root, "state", "runs");
    mkdirSync(join(runs, "old-run"), { recursive: true });
    const r = await pruneRuns({
      settings: {},
      runsDir: runs,
      supervisorHome: join(root, "supervisor"),
    });
    assert.deepEqual(r, { refused: "retention keeps everything", pruned: [] });
    assert.ok(existsSync(join(runs, "old-run")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pruneRuns: keepDays 7 deletes 10-day-old runs from both roots, keeps fresh ones", async () => {
  const root = tempRoot();
  try {
    const runs = join(root, "state", "runs");
    const sup = join(root, "supervisor");
    fileAt(join(runs, "old-run", "decisions.jsonl"), 100);
    fileAt(join(runs, "fresh-run", "decisions.jsonl"), 40);
    fileAt(join(sup, "sup-old", "session.json"), 60);
    ageTree(join(runs, "old-run"), 10);
    ageTree(join(runs, "fresh-run"), 2);
    ageTree(join(sup, "sup-old"), 10);

    const r = await pruneRuns({
      settings: { retention: { keepDays: 7 } },
      runsDir: runs,
      supervisorHome: sup,
    });
    assert.equal(r.keepDays, 7);
    assert.ok(Date.parse(r.cutoff) < Date.now() - 6.9 * DAY_MS);
    assert.deepEqual(
      r.pruned.map((p) => p.runId).sort(),
      ["old-run", "sup-old"],
    );
    for (const p of r.pruned) {
      assert.equal(typeof p.bytes, "number");
      assert.ok(p.bytes > 0);
      assert.ok(!Number.isNaN(Date.parse(p.newestAt)));
    }
    assert.equal(r.bytes, r.pruned.reduce((a, p) => a + p.bytes, 0));
    assert.deepEqual(r.skipped, []);
    assert.ok(!existsSync(join(runs, "old-run")));
    assert.ok(!existsSync(join(sup, "sup-old")));
    assert.ok(existsSync(join(runs, "fresh-run")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pruneRuns: a run with a live child is skipped, a dead one is pruned", async () => {
  const root = tempRoot();
  try {
    const runs = join(root, "state", "runs");
    fileAt(join(runs, "running-child", "decisions.jsonl"), 10);
    fileAt(join(runs, "alive-pid", "decisions.jsonl"), 10);
    fileAt(join(runs, "dead-child", "decisions.jsonl"), 10);
    fileAt(join(runs, "broken-registry", "decisions.jsonl"), 10);
    textAt(join(runs, "running-child", "children.json"), JSON.stringify({ children: { c1: { status: "running" } } }));
    textAt(join(runs, "alive-pid", "children.json"), JSON.stringify({ children: { c1: { status: "exited", pid: process.pid } } }));
    textAt(join(runs, "dead-child", "children.json"), JSON.stringify({ children: { c1: { status: "exited", pid: 999999 } } }));
    textAt(join(runs, "broken-registry", "children.json"), "{ not json");
    for (const runId of ["running-child", "alive-pid", "dead-child", "broken-registry"]) {
      ageTree(join(runs, runId), 30);
    }

    const r = await pruneRuns({
      settings: { retention: { keepDays: 7 } },
      runsDir: runs,
      supervisorHome: join(root, "supervisor"),
    });
    assert.deepEqual(
      r.skipped.sort((a, b) => a.runId.localeCompare(b.runId)),
      [
        { runId: "alive-pid", reason: "live-child" },
        { runId: "broken-registry", reason: "unreadable-registry" },
        { runId: "running-child", reason: "live-child" },
      ],
    );
    assert.deepEqual(r.pruned.map((p) => p.runId), ["dead-child"]);
    assert.ok(existsSync(join(runs, "running-child")));
    assert.ok(existsSync(join(runs, "alive-pid")));
    assert.ok(existsSync(join(runs, "broken-registry")));
    assert.ok(!existsSync(join(runs, "dead-child")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pruneRuns: dry-run reports the same list and deletes nothing", async () => {
  const root = tempRoot();
  try {
    const runs = join(root, "state", "runs");
    fileAt(join(runs, "old-run", "decisions.jsonl"), 100);
    ageTree(join(runs, "old-run"), 10);
    const opts = {
      settings: { retention: { keepDays: 7 } },
      runsDir: runs,
      supervisorHome: join(root, "supervisor"),
    };
    const dry = await pruneRuns({ ...opts, dryRun: true });
    assert.deepEqual(dry.pruned, [{ runId: "old-run", bytes: 100, newestAt: dry.pruned[0].newestAt }]);
    assert.equal(dry.bytes, 100);
    assert.ok(existsSync(join(runs, "old-run"))); // dry-run deleted nothing
    const real = await pruneRuns(opts);
    assert.deepEqual(real.pruned, dry.pruned);
    assert.equal(real.bytes, dry.bytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pruneRuns: a 10-day-old run whose newest file is fresh is KEPT", async () => {
  const root = tempRoot();
  try {
    const runs = join(root, "state", "runs");
    fileAt(join(runs, "mixed-age", "decisions.jsonl"), 50);
    ageTree(join(runs, "mixed-age"), 10);
    // one fresh touch inside the tree — the newest mtime wins over the age
    utimesSync(join(runs, "mixed-age", "decisions.jsonl"), new Date(), new Date());
    const r = await pruneRuns({
      settings: { retention: { keepDays: 7 } },
      runsDir: runs,
      supervisorHome: join(root, "supervisor"),
    });
    assert.deepEqual(r.pruned, []);
    assert.ok(!r.skipped.some((s) => s.runId === "mixed-age"), JSON.stringify(r.skipped));
    assert.ok(existsSync(join(runs, "mixed-age")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pruneRuns: the Supervisor's current run is skipped as current-run", async () => {
  const root = tempRoot();
  try {
    const runs = join(root, "state", "runs");
    const sup = join(root, "supervisor");
    const currentId = "2026-10-05T10-00-00-000-supervisor-beef";
    fileAt(join(runs, currentId, "decisions.jsonl"), 80);
    fileAt(join(sup, "stale-run", "session.json"), 20);
    ageTree(join(runs, currentId), 30);
    ageTree(join(sup, "stale-run"), 30);
    // The pointer file, written the way supervisor-current-run writes it.
    const pointerPath = join(root, "data", "supervisor", "current-run.json");
    writeCurrentRun({ runId: currentId, startedAt: new Date().toISOString() }, { path: pointerPath });
    const r = await pruneRuns({
      settings: { retention: { keepDays: 7 } },
      runsDir: runs,
      supervisorHome: sup,
      currentRunPaths: [pointerPath],
    });
    assert.deepEqual(r.skipped, [{ runId: currentId, reason: "current-run" }]);
    assert.deepEqual(r.pruned.map((p) => p.runId), ["stale-run"]); // the other root still prunes
    assert.ok(existsSync(join(runs, currentId))); // regardless of age, never deleted
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pruneRuns: a registry touched 1 h ago is skipped as recent-activity", async () => {
  const root = tempRoot();
  try {
    const runs = join(root, "state", "runs");
    fileAt(join(runs, "recently-active", "decisions.jsonl"), 30);
    textAt(join(runs, "recently-active", "children.json"), JSON.stringify({ children: {} }));
    ageTree(join(runs, "recently-active"), 30);
    const anHourAgo = new Date(Date.now() - 3_600_000);
    utimesSync(join(runs, "recently-active", "children.json"), anHourAgo, anHourAgo);
    const r = await pruneRuns({
      settings: { retention: { keepDays: 7 } },
      runsDir: runs,
      supervisorHome: join(root, "supervisor"),
    });
    assert.deepEqual(r.skipped, [{ runId: "recently-active", reason: "recent-activity" }]);
    assert.deepEqual(r.pruned, []);
    assert.ok(existsSync(join(runs, "recently-active")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pruneRuns: a non-run-id directory is skipped as not-a-run", async () => {
  const root = tempRoot();
  try {
    const runs = join(root, "state", "runs");
    fileAt(join(runs, "not a run", "notes.txt"), 40);
    fileAt(join(runs, "real-run", "decisions.jsonl"), 10);
    ageTree(join(runs, "not a run"), 30);
    ageTree(join(runs, "real-run"), 30);
    const r = await pruneRuns({
      settings: { retention: { keepDays: 7 } },
      runsDir: runs,
      supervisorHome: join(root, "supervisor"),
    });
    assert.deepEqual(r.skipped, [{ runId: "not a run", reason: "not-a-run" }]);
    assert.deepEqual(r.pruned.map((p) => p.runId), ["real-run"]);
    assert.ok(existsSync(join(runs, "not a run"))); // surfaced, never deleted
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pruneRuns: a failed rm lands in failed and the other candidate is still pruned", async () => {
  const root = tempRoot();
  try {
    const runs = join(root, "state", "runs");
    fileAt(join(runs, "doomed", "decisions.jsonl"), 10);
    fileAt(join(runs, "other-old", "decisions.jsonl"), 100);
    ageTree(join(runs, "doomed"), 10);
    ageTree(join(runs, "other-old"), 10);
    // Cross-platform failure injection: the seam throws for one run only
    // (an open file handle / chmod trick is platform-dependent).
    const rmImpl = (path) =>
      basename(path) === "doomed"
        ? Promise.reject(Object.assign(new Error("remove failed"), { code: "EBUSY" }))
        : fs.rm(path, { recursive: true, force: true });
    const r = await pruneRuns({
      settings: { retention: { keepDays: 7 } },
      runsDir: runs,
      supervisorHome: join(root, "supervisor"),
      rmImpl,
    });
    assert.deepEqual(r.failed, [{ runId: "doomed", error: "EBUSY" }]);
    assert.deepEqual(r.pruned.map((p) => p.runId), ["other-old"]); // the loop continued
    assert.equal(r.bytes, 100); // only what was actually removed
    assert.ok(existsSync(join(runs, "doomed")));
    assert.ok(!existsSync(join(runs, "other-old")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pruneRuns: the entry cap marks the estimate partial and skips capped runs", async () => {
  const root = tempRoot();
  const prev = process.env.FENIX_RETENTION_MAX_ENTRIES;
  try {
    const runs = join(root, "state", "runs");
    fileAt(join(runs, "old-run", "a.jsonl"), 10);
    fileAt(join(runs, "old-run", "b.jsonl"), 10);
    fileAt(join(runs, "old-run", "c.jsonl"), 10);
    fileAt(join(runs, "fresh-run", "a.jsonl"), 10);
    ageTree(join(runs, "old-run"), 10);
    ageTree(join(runs, "fresh-run"), 2);
    process.env.FENIX_RETENTION_MAX_ENTRIES = "2";
    const r = await pruneRuns({
      dryRun: true,
      settings: { retention: { keepDays: 7 } },
      runsDir: runs,
      supervisorHome: join(root, "supervisor"),
    });
    assert.equal(r.partial, true);
    assert.deepEqual(r.pruned, []); // the walk cannot prove old-run is stale
    assert.deepEqual(r.skipped, [{ runId: "old-run", reason: "cap" }]);
    assert.ok(existsSync(join(runs, "old-run")));
  } finally {
    if (prev === undefined) delete process.env.FENIX_RETENTION_MAX_ENTRIES;
    else process.env.FENIX_RETENTION_MAX_ENTRIES = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

test("cachedPrunable: one dry-run per keepDays+roots fingerprint within the TTL", async () => {
  const root = tempRoot();
  try {
    const runs = join(root, "state", "runs");
    fileAt(join(runs, "old-run", "decisions.jsonl"), 100);
    ageTree(join(runs, "old-run"), 10);
    const opts = { settings: { retention: { keepDays: 7 } }, runsDir: runs, supervisorHome: join(root, "supervisor") };
    let walks = 0;
    const pruneImpl = async (o) => {
      walks += 1;
      return pruneRuns(o);
    };
    const first = await cachedPrunable(opts, { ttlMs: 60000, pruneImpl });
    const second = await cachedPrunable(opts, { ttlMs: 60000, pruneImpl });
    assert.equal(walks, 1); // two calls, one walk
    assert.strictEqual(first, second); // same object — served from the cache
    const other = await cachedPrunable({ ...opts, settings: { retention: { keepDays: 14 } } }, { ttlMs: 60000, pruneImpl });
    assert.equal(walks, 2); // a different keepDays is its own fingerprint
    assert.equal(other.keepDays, 14);
    assert.deepEqual(other.pruned, []); // 10-day-old run stays under 14 days
    await cachedPrunable({ ...opts, now: 0 }, { ttlMs: 60000, pruneImpl });
    assert.equal(walks, 3); // a pinned `now` is never cached
    const refused = await cachedPrunable({ settings: {} }, { ttlMs: 60000, pruneImpl });
    assert.deepEqual(refused, { refused: "retention keeps everything", pruned: [] });
    assert.equal(walks, 4); // the refusal is cached under keepDays null too
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- CLI: show / apply / prune ----------------------------------------------

/** Runs the retention CLI with every seam pointed inside `root`. */
function runCli(root, ...args) {
  const runs = join(root, "state", "runs");
  mkdirSync(runs, { recursive: true });
  return execFileP(process.execPath, [CLI, ...args], {
    env: {
      ...process.env,
      LA_SETTINGS_FILE: join(root, "settings.json"),
      LA_SQUAD_HOME: join(root, "agents"),
      LA_STATE_ROOT: join(root, "state"),
      LA_SUPERVISOR_STATE_HOME: join(root, "supervisor"),
      LA_DATA_HOME: join(root, "data"),
      LA_TELEMETRY_HOME: join(root, "telemetry"),
      GITHUB_ROOT: join(root, "workspaces"),
    },
    windowsHide: true,
  });
}

test("CLI show: exits 0 with the resolved policy in the JSON", async () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "settings.json"), JSON.stringify({ retention: { keepDays: 30 } }));
    const { stdout } = await runCli(root, "show");
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.resolved.keepDays, 30);
    assert.equal(parsed.resolved.cleanupPeriodDays, 30);
    assert.equal(parsed.retention.policy, "unknown");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI apply: rewrites the differing squad settings.json; --dry-run does not", async () => {
  const root = tempRoot();
  try {
    const squadHome = join(root, "agents");
    textAt(join(squadHome, "alpha", "settings.json"), JSON.stringify({ cleanupPeriodDays: 30 }));
    const dry = JSON.parse((await runCli(root, "apply", "--dry-run")).stdout);
    assert.deepEqual(dry.changed, [{ squad: "alpha", from: 30, to: 36500 }]);
    assert.equal(
      readFileSync(join(squadHome, "alpha", "settings.json"), "utf8"),
      JSON.stringify({ cleanupPeriodDays: 30 }),
    );
    const real = JSON.parse((await runCli(root, "apply")).stdout);
    assert.deepEqual(real.changed, [{ squad: "alpha", from: 30, to: 36500 }]);
    assert.deepEqual(JSON.parse(readFileSync(join(squadHome, "alpha", "settings.json"), "utf8")), {
      cleanupPeriodDays: 36500,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI prune: keepDays null exits 1 with the refusal JSON", async () => {
  const root = tempRoot();
  try {
    await assert.rejects(runCli(root, "prune"), (err) => {
      assert.equal(err.code, 1);
      assert.deepEqual(JSON.parse(err.stdout), { refused: "retention keeps everything", pruned: [] });
      return true;
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI prune: keepDays 7 deletes the old run and exits 0", async () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "settings.json"), JSON.stringify({ retention: { keepDays: 7 } }));
    const runs = join(root, "state", "runs");
    fileAt(join(runs, "old-run", "decisions.jsonl"), 100);
    fileAt(join(runs, "fresh-run", "decisions.jsonl"), 10);
    ageTree(join(runs, "old-run"), 10);
    ageTree(join(runs, "fresh-run"), 2);
    const out = JSON.parse((await runCli(root, "prune")).stdout);
    assert.deepEqual(out.pruned.map((p) => p.runId), ["old-run"]);
    assert.ok(!existsSync(join(runs, "old-run")));
    assert.ok(existsSync(join(runs, "fresh-run")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI: unknown or missing subcommand → usage on stderr, exit 2", async () => {
  const root = tempRoot();
  try {
    for (const argv of [[], ["bogus"], ["show", "--bogus"]]) {
      await assert.rejects(runCli(root, ...argv), (err) => {
        assert.equal(err.code, 2);
        assert.ok(err.stderr.includes("Usage"));
        return true;
      });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
