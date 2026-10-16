// scripts/run-owner.test.mjs — run ownership (FOC-905).
//
// Covers the owner identity (currentOwner's shape), the owner.json record
// (read/write-if-missing — never overwrites, corrupt reads as null), the
// ownerRelation matrix (mine / restarted / foreign / unknown / terminal
// session), listRunOwners over a fixture state root, and ensureRunDir's
// write-once owner stamp through supervisor-lib.
//
// Everything runs in mkdtemp dirs: LA_SUPERVISOR_STATE_HOME is pointed at a
// temp dir BEFORE supervisor-lib is imported (it reads the seam at call time,
// but the import order keeps the guarantee obvious), and no test touches the
// real `.state/`, ports, sockets or the telemetry DB. The one SQLite touch is
// a single-process temp task-sessions store for the terminal-session case.
//
// Run: node --test scripts/run-owner.test.mjs

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.LA_SUPERVISOR_STATE_HOME = mkdtempSync(join(tmpdir(), "run-owner-state-"));

const {
  _resetClkTckCache,
  _setClkTckProbe,
  containerStartMs,
  currentOwner,
  listRunOwners,
  ownerRelation,
  ownerPath,
  readRunOwner,
  writeRunOwnerIfMissing,
} = await import("./run-owner.mjs");
const { ensureRunDir } = await import("./supervisor-lib.mjs");

const HOST = hostname();

// /proc/1/stat: fields 3..21 after the last ")" are zeros, field 22 = 500;
// built positionally so the field count cannot drift (same fixture as
// supervisor-orphans.test.mjs).
const PROC_1_STAT = ["1 (sleep infinity) S", ...Array(18).fill("0"), "500", "0", "0"].join(" ") + "\n";
const procReadFile = (p) => {
  if (p === "/proc/stat") return "btime 1000\n";
  if (p === "/proc/1/stat") return PROC_1_STAT;
  throw new Error(`unexpected path ${p}`);
};

const tempDir = (tag) => mkdtempSync(join(tmpdir(), `run-owner-${tag}-`));
const owner = (over = {}) => ({
  sessionId: null,
  hostname: HOST,
  containerStartMs: 1_000_000,
  pid: 1,
  recordedAt: "2026-10-16T09:00:00.000Z",
  ...over,
});
const current = (over = {}) => owner({ containerStartMs: 1_000_000, ...over });

test("containerStartMs (moved from supervisor-orphans, re-exported there): btime + starttime", () => {
  assert.equal(containerStartMs({ readFile: procReadFile, clkTck: 100 }), 1_005_000);
});

test("containerStartMs: unreadable /proc → null (never guess)", () => {
  assert.equal(containerStartMs({ readFile: () => { throw new Error("no /proc"); }, clkTck: 100 }), null);
});

test("currentOwner carries the session id, hostname, start, pid and a timestamp", () => {
  const o = currentOwner({ FENIX_SUPERVISOR_SESSION_ID: "sup-" + "a".repeat(32) });
  assert.equal(o.sessionId, "sup-" + "a".repeat(32));
  assert.equal(o.hostname, HOST);
  assert.equal(o.pid, process.pid);
  assert.ok(!Number.isNaN(Date.parse(o.recordedAt)), "recordedAt is an ISO timestamp");
  // On a Windows host the probe cannot prove a container start — the shape
  // allows null there and a number inside a Linux container.
  assert.ok(o.containerStartMs === null || typeof o.containerStartMs === "number");
  const unscoped = currentOwner({});
  assert.equal(unscoped.sessionId, null, "no session env → null session id");
});

test("the CLK_TCK probe is memoized: one spawn across repeated currentOwner() calls", () => {
  let probes = 0;
  const original = _setClkTckProbe(() => {
    probes += 1;
    return 500;
  });
  _resetClkTckCache();
  try {
    currentOwner();
    currentOwner();
    assert.equal(probes, 1, "the probe ran at most once across two currentOwner() calls");
    // The memoized value is what the probe returned, not the 100 fallback.
    _resetClkTckCache();
    assert.equal(containerStartMs({ readFile: procReadFile }), 1_001_000, "the cached CLK_TCK feeds the math");
  } finally {
    _setClkTckProbe(original);
    _resetClkTckCache();
  }
});

test("readRunOwner: missing → null, corrupt → null, non-object → null", () => {
  const dir = tempDir("read");
  try {
    assert.equal(readRunOwner(dir), null, "no owner.json → null");
    writeFileSync(ownerPath(dir), "{ not json", "utf8");
    assert.equal(readRunOwner(dir), null, "corrupt JSON → null");
    writeFileSync(ownerPath(dir), JSON.stringify(["not", "an", "object"]), "utf8");
    assert.equal(readRunOwner(dir), null, "an array is not an owner → null");
    writeFileSync(ownerPath(dir), JSON.stringify(owner()));
    assert.deepEqual(readRunOwner(dir), owner(), "a well-formed owner reads back");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeRunOwnerIfMissing writes once and never overwrites", () => {
  const dir = tempDir("write");
  try {
    assert.equal(writeRunOwnerIfMissing(dir, owner({ pid: 111 })), true, "first write succeeds");
    assert.deepEqual(readRunOwner(dir), owner({ pid: 111 }));
    assert.equal(writeRunOwnerIfMissing(dir, owner({ pid: 222 })), false, "second write is refused");
    assert.equal(readRunOwner(dir).pid, 111, "the first owner stands");
    // The same guarantee when the caller skips the existence check and races
    // straight into the exclusive create.
    writeFileSync(ownerPath(dir), JSON.stringify(owner({ pid: 333 })), "utf8");
    assert.equal(writeRunOwnerIfMissing(dir, owner({ pid: 444 })), false, "existing file → false");
    assert.equal(readRunOwner(dir).pid, 333);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ownerRelation: no owner record → unknown", () => {
  assert.deepEqual(ownerRelation(null, current()), { relation: "unknown", terminal: false });
  assert.deepEqual(ownerRelation(undefined, current()), { relation: "unknown", terminal: false });
});

test("ownerRelation: same hostname + same containerStartMs → mine", () => {
  assert.deepEqual(ownerRelation(owner(), current()), { relation: "mine", terminal: false });
});

test("ownerRelation: same hostname + both starts unprovable → mine", () => {
  assert.deepEqual(ownerRelation(owner({ containerStartMs: null }), current({ containerStartMs: null })), {
    relation: "mine",
    terminal: false,
  });
});

test("ownerRelation: same hostname + older owner start → restarted", () => {
  assert.deepEqual(ownerRelation(owner({ containerStartMs: 999_000 }), current({ containerStartMs: 1_000_000 })), {
    relation: "restarted",
    terminal: false,
  });
});

test("ownerRelation: different hostname → foreign", () => {
  assert.deepEqual(ownerRelation(owner({ hostname: "other-container" }), current()), {
    relation: "foreign",
    terminal: false,
  });
});

test("ownerRelation: starts that do not line up (skew) → unknown", () => {
  // An owner start NEWER than this container's cannot be judged — the scan
  // falls back to the time rule rather than guessing a relation.
  assert.deepEqual(ownerRelation(owner({ containerStartMs: 2_000_000 }), current({ containerStartMs: 1_000_000 })), {
    relation: "unknown",
    terminal: false,
  });
  // Owner recorded without a start, current with one (and the reverse).
  assert.deepEqual(ownerRelation(owner({ containerStartMs: null }), current({ containerStartMs: 1_000_000 })), {
    relation: "unknown",
    terminal: false,
  });
  assert.deepEqual(ownerRelation(owner({ containerStartMs: 1_000_000 }), current({ containerStartMs: null })), {
    relation: "unknown",
    terminal: false,
  });
});

test("ownerRelation: terminal is true only for a stopped/completed/failed owner session", () => {
  const assertTerminal = (status, expected) => {
    assert.deepEqual(ownerRelation(owner(), current(), { session: { sessionId: "sup-x", status } }), {
      relation: "mine",
      terminal: expected,
    });
  };
  assertTerminal("stopped", true);
  assertTerminal("completed", true);
  assertTerminal("failed", true);
  assertTerminal("running", false);
  assertTerminal("queued", false);
  assertTerminal("waiting", false);
  assert.deepEqual(ownerRelation(owner(), current(), {}), { relation: "mine", terminal: false }, "no session row → not terminal");
  // Terminal is a property of the session row, independent of the relation.
  assert.deepEqual(
    ownerRelation(owner({ hostname: "other" }), current(), { session: { sessionId: "sup-x", status: "stopped" } }),
    { relation: "foreign", terminal: true },
  );
});

test("listRunOwners: owned runs, legacy runs (children.json only), non-run dirs skipped, missing root → []", () => {
  const root = tempDir("list");
  try {
    mkdirSync(join(root, "run-owned"), { recursive: true });
    writeFileSync(join(root, "run-owned", "owner.json"), JSON.stringify(owner()));
    mkdirSync(join(root, "run-legacy"), { recursive: true });
    writeFileSync(join(root, "run-legacy", "children.json"), "{}\n");
    mkdirSync(join(root, "not-a-run"), { recursive: true });
    writeFileSync(join(root, "not-a-run", "something.else"), "x");
    writeFileSync(join(root, "a-file"), "x");
    assert.deepEqual(
      listRunOwners(root).sort((a, b) => a.runId.localeCompare(b.runId)),
      [
        { runId: "run-legacy", owner: null },
        { runId: "run-owned", owner: owner() },
      ],
    );
    assert.deepEqual(listRunOwners(join(root, "missing")), [], "unreadable state root → []");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ensureRunDir writes owner.json once (a second call keeps it)", () => {
  const runId = "2026-10-16T09-00-00-000-supervisor-test";
  try {
    ensureRunDir(runId);
    const first = readRunOwner(join(process.env.LA_SUPERVISOR_STATE_HOME, runId));
    assert.ok(first, "owner.json written at run-dir creation");
    assert.equal(first.hostname, HOST);
    assert.equal(first.pid, process.pid);
    assert.equal(first.sessionId, null, "unscoped test env → no session id");
    // A second creation call must not clobber an owner that is already there.
    const foreign = owner({ hostname: "other-container", pid: 7 });
    writeFileSync(ownerPath(join(process.env.LA_SUPERVISOR_STATE_HOME, runId)), JSON.stringify(foreign), "utf8");
    ensureRunDir(runId);
    assert.deepEqual(readRunOwner(join(process.env.LA_SUPERVISOR_STATE_HOME, runId)), foreign, "write-once holds");
    assert.ok(existsSync(join(process.env.LA_SUPERVISOR_STATE_HOME, runId, "children")), "run-dir layout unchanged");
  } finally {
    rmSync(join(process.env.LA_SUPERVISOR_STATE_HOME, runId), { recursive: true, force: true });
  }
});

test("readSessionRows (via the orphan seam): every row, terminal included", async () => {
  const { sqliteAvailable, createTaskSessionStore, readSessionRows } = await import("./task-sessions.mjs");
  if (!sqliteAvailable()) return; // node:sqlite missing — nothing to prove here
  const dir = tempDir("rows");
  try {
    assert.deepEqual(readSessionRows(join(dir, "absent.sqlite")), [], "missing store → []");
    const dbPath = join(dir, "task-sessions.sqlite");
    const store = createTaskSessionStore({ dbPath });
    try {
      const rec = store.ensure({
        taskKey: "acme:ENG-905",
        taskId: "ENG-905",
        workspace: "acme",
        issueId: "ENG-905",
      });
      let rows = readSessionRows(dbPath);
      assert.equal(rows.length, 1);
      assert.deepEqual(Object.keys(rows[0]).sort(), ["pid", "processStartedAt", "sessionId", "status"]);
      assert.equal(rows[0].sessionId, rec.sessionId);
      assert.equal(rows[0].status, "queued");
      store.update(rec.sessionId, { status: "stopped" });
      rows = readSessionRows(dbPath);
      assert.equal(rows.length, 1, "the terminal row is still returned");
      assert.equal(rows[0].status, "stopped", "terminal status visible (readActiveSessions would hide it)");
    } finally {
      store.close();
    }
    const corrupt = join(dir, "corrupt.sqlite");
    writeFileSync(corrupt, "not a database at all", "utf8");
    assert.deepEqual(readSessionRows(corrupt), [], "an unreadable store reads as [] — the scan never blocks on it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
