// scripts/task-sessions.test.mjs — the durable task/session coordinator.
// Pins: ensure idempotence and new generations after terminal, the active cap
// with queued promotion order, immutable identity on update, persistence
// across reopen, strict id validation, and the cross-process invariants
// (unique active owner, cap holds) raced through independent node processes
// against one SQLite file.
//
// Run: node --test scripts/task-sessions.test.mjs
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  CAP_STATUSES,
  OWNER_STATUSES,
  SESSION_ID_PATTERN,
  STATUSES,
  TERMINAL_STATUSES,
  createTaskSessionStore,
  readActiveSessions,
  resolveTaskKey,
} from "./task-sessions.mjs";

const execFileP = promisify(execFile);
const MODULE_URL = new URL("./task-sessions.mjs", import.meta.url).href;

function tempDir() {
  return mkdtempSync(join(tmpdir(), "task-sessions-"));
}

function dbFile(dir) {
  return join(dir, "task-sessions.sqlite");
}

const TASK = { taskKey: "acme:ENG-1", taskId: "ENG-1", workspace: "acme", issueId: "ENG-1" };

function ensureArgs(overrides = {}) {
  return { ...TASK, title: "Do the thing", ...overrides };
}

/**
 * Runs a child node process (an independent connection/process against the
 * same dbPath) that imports this module and executes `body` — an async IIFE
 * body whose last statement must `return` a JSON-serializable value. The child
 * busy-waits until `startAt` first, so several children can be raced.
 */
async function runChild(dbPath, body, startAt = null) {
  const code = `
    const { createTaskSessionStore } = await import(${JSON.stringify(MODULE_URL)});
    const dbPath = process.argv[1];
    const startAt = Number(process.argv[2]);
    if (startAt > Date.now()) { const end = startAt; while (Date.now() < end) {} }
    const store = createTaskSessionStore({ dbPath, maxActive: 2 });
    try {
      const result = await (async () => { ${body} })();
      console.log(JSON.stringify(result));
    } finally { store.close(); }
  `;
  const { stdout } = await execFileP(
    process.execPath,
    ["--input-type=module", "-e", code, dbPath, String(startAt ?? 0)],
    { windowsHide: true },
  );
  return JSON.parse(stdout.trim());
}

test("ensure: creates a queued record and a duplicate ensure returns the same owner", () => {
  const dir = tempDir();
  try {
    const store = createTaskSessionStore({ dbPath: dbFile(dir) });
    const first = store.ensure(ensureArgs());
    assert.equal(first.status, "queued");
    assert.match(first.sessionId, SESSION_ID_PATTERN);
    assert.equal(first.taskKey, "acme:ENG-1");
    assert.equal(first.title, "Do the thing");
    assert.equal(first.runId, null);
    assert.equal(first.pid, null);
    const second = store.ensure(ensureArgs({ title: "Different title" }));
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(second.title, "Do the thing"); // identity record wins; title not adopted
    assert.equal(store.list().length, 1);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensure: after a terminal status a new generation is created", () => {
  const dir = tempDir();
  try {
    const store = createTaskSessionStore({ dbPath: dbFile(dir) });
    const first = store.ensure(ensureArgs());
    store.claimNext();
    store.update(first.sessionId, { status: "completed" });
    const second = store.ensure(ensureArgs());
    assert.notEqual(second.sessionId, first.sessionId);
    assert.equal(second.status, "queued");
    assert.equal(store.list().length, 2);
    assert.equal(store.getByTask(TASK.taskKey).sessionId, second.sessionId); // newest
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claimNext: cap of 2 with a third queued; promotion order is oldest first", () => {
  const dir = tempDir();
  try {
    const store = createTaskSessionStore({ dbPath: dbFile(dir), maxActive: 2 });
    const a = store.ensure(ensureArgs({ taskKey: "acme:ENG-1", taskId: "ENG-1", issueId: "ENG-1" }));
    // Ensure created_at differs deterministically enough for ordering; force a
    // small gap via a second task ensured after the first.
    const b = store.ensure(ensureArgs({ taskKey: "acme:ENG-2", taskId: "ENG-2", issueId: "ENG-2" }));
    const c = store.ensure(ensureArgs({ taskKey: "acme:ENG-3", taskId: "ENG-3", issueId: "ENG-3" }));
    const first = store.claimNext();
    assert.equal(first.sessionId, a.sessionId);
    assert.equal(first.status, "starting");
    const second = store.claimNext();
    assert.equal(second.sessionId, b.sessionId);
    assert.equal(store.claimNext(), null, "cap reached; the queued session must wait");
    // Releasing one active slot lets the oldest queued in.
    store.update(second.sessionId, { status: "completed" });
    const third = store.claimNext();
    assert.equal(third.sessionId, c.sessionId);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claimNext: queued does not count against the cap; terminal releases the slot", () => {
  const dir = tempDir();
  try {
    const store = createTaskSessionStore({ dbPath: dbFile(dir), maxActive: 1 });
    const a = store.ensure(ensureArgs({ taskKey: "acme:ENG-1", taskId: "ENG-1", issueId: "ENG-1" }));
    const b = store.ensure(ensureArgs({ taskKey: "acme:ENG-2", taskId: "ENG-2", issueId: "ENG-2" }));
    assert.equal(store.claimNext().sessionId, a.sessionId);
    assert.equal(store.claimNext(), null);
    store.update(a.sessionId, { status: "stopped" });
    assert.equal(store.claimNext().sessionId, b.sessionId);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("update: mutable fields apply; identity fields are rejected outright", () => {
  const dir = tempDir();
  try {
    const store = createTaskSessionStore({ dbPath: dbFile(dir) });
    const session = store.ensure(ensureArgs());
    store.claimNext();
    const updated = store.update(session.sessionId, {
      status: "running",
      runId: "run-abc",
      pid: 4242,
      processStartedAt: new Date().toISOString(),
    });
    assert.equal(updated.status, "running");
    assert.equal(updated.runId, "run-abc");
    assert.equal(updated.pid, 4242);
    for (const [field, value] of [
      ["taskId", "EVIL-9"],
      ["workspace", "evil"],
      ["issueId", "EVIL-9"],
      ["taskKey", "evil:EVIL-9"],
      ["sessionId", "sup-0000000000000000"],
      ["createdAt", "2000-01-01T00:00:00.000Z"],
    ]) {
      assert.throws(
        () => store.update(session.sessionId, { [field]: value }),
        (err) => err.message.includes(`'${field}'`) && err.message.includes("not writable"),
        `${field} must be rejected`,
      );
    }
    // The identity is intact and update history is visible via updatedAt.
    assert.equal(store.get(session.sessionId).taskId, "ENG-1");
    assert.ok(store.get(session.sessionId).updatedAt >= session.updatedAt);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("update: unknown sessionId, invalid status and malformed values throw", () => {
  const dir = tempDir();
  try {
    const store = createTaskSessionStore({ dbPath: dbFile(dir) });
    const session = store.ensure(ensureArgs());
    assert.throws(() => store.update("sup-0000000000000000", { status: "running" }), /unknown sessionId/);
    assert.throws(() => store.update(session.sessionId, { status: "deployed" }), /status must be one of/);
    assert.throws(() => store.update(session.sessionId, { pid: -1 }), /pid/);
    assert.throws(() => store.update(session.sessionId, { lastError: "" }), /lastError/);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reopen: records persist across close and a fresh store instance", () => {
  const dir = tempDir();
  try {
    const path = dbFile(dir);
    let store = createTaskSessionStore({ dbPath: path });
    const session = store.ensure(ensureArgs());
    store.claimNext();
    store.update(session.sessionId, { status: "running", pid: 7 });
    store.close();
    store = createTaskSessionStore({ dbPath: path });
    const reloaded = store.get(session.sessionId);
    assert.equal(reloaded.status, "running");
    assert.equal(reloaded.pid, 7);
    // Ownership still enforced after reopen: duplicate ensure is a no-op.
    assert.equal(store.ensure(ensureArgs()).sessionId, session.sessionId);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed ids and inputs are rejected", () => {
  const dir = tempDir();
  try {
    const store = createTaskSessionStore({ dbPath: dbFile(dir) });
    for (const bad of ["", "sup-", "sup-nothex", "sup-ABCDEF0123456789", "task-1", "x".repeat(400), null, 42]) {
      assert.throws(() => store.get(bad), /sessionId must match/, `get(${JSON.stringify(bad)}) must throw`);
      assert.throws(() => store.update(bad, { status: "running" }), /sessionId must match/);
    }
    assert.throws(() => store.ensure(ensureArgs({ taskKey: "" })), /taskKey/);
    assert.throws(() => store.ensure(ensureArgs({ taskId: "" })), /taskId/);
    assert.throws(() => store.ensure(ensureArgs({ workspace: "" })), /workspace/);
    assert.throws(() => store.ensure(ensureArgs({ issueId: "" })), /issueId/);
    assert.throws(() => store.ensure(ensureArgs({ title: "" })), /title/);
    assert.throws(() => store.ensure(ensureArgs({ taskKey: "k".repeat(201) })), /taskKey/);
    assert.throws(() => store.getByTask(""), /taskKey/);
    assert.throws(() => createTaskSessionStore({ dbPath: dbFile(dir), maxActive: 0 }), /maxActive/);
    assert.throws(() => createTaskSessionStore({ dbPath: dbFile(dir), maxActive: 1.5 }), /maxActive/);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveTaskKey: stable coordination string, validated", () => {
  assert.equal(resolveTaskKey({ workspace: "acme", issueId: "ENG-1" }), "acme:ENG-1");
  assert.equal(typeof resolveTaskKey({ workspace: "acme", issueId: "ENG-1" }), "string");
  assert.throws(() => resolveTaskKey({ workspace: "", issueId: "ENG-1" }), /workspace/);
  assert.throws(() => resolveTaskKey({ issueId: "ENG-1" }), /workspace/);
  assert.throws(() => resolveTaskKey({ workspace: "acme", issueId: 7 }), /issueId/);
});

test("list: includeTerminal=false filters to active records", () => {
  const dir = tempDir();
  try {
    const store = createTaskSessionStore({ dbPath: dbFile(dir) });
    const a = store.ensure(ensureArgs({ taskKey: "acme:ENG-1", taskId: "ENG-1", issueId: "ENG-1" }));
    store.ensure(ensureArgs({ taskKey: "acme:ENG-2", taskId: "ENG-2", issueId: "ENG-2" }));
    store.update(a.sessionId, { status: "failed", lastError: "boom" });
    assert.equal(store.list().length, 2);
    const active = store.list({ includeTerminal: false });
    assert.equal(active.length, 1);
    assert.equal(active[0].taskKey, "acme:ENG-2");
    assert.ok(OWNER_STATUSES.includes(active[0].status));
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exported status groups and pattern are coherent", () => {
  assert.deepEqual(new Set([...OWNER_STATUSES, ...TERMINAL_STATUSES]), new Set(STATUSES));
  assert.ok(CAP_STATUSES.every((s) => OWNER_STATUSES.includes(s)));
  assert.match(`sup-${"a".repeat(16)}`, SESSION_ID_PATTERN);
  assert.match(`sup-${"a".repeat(32)}`, SESSION_ID_PATTERN);
});

test("readActiveSessions: a garbage store file reads as unknown and leaves no sibling files behind", () => {
  const dir = tempDir();
  try {
    const dbPath = dbFile(dir);
    writeFileSync(dbPath, "this is not a sqlite database at all — just bytes. ".repeat(16), "utf8");
    const r = readActiveSessions(dbPath);
    assert.equal(r.sessions.length, 0);
    assert.ok(r.unknown, "garbage reads as unknown, never as 'nothing there'");
    assert.deepEqual(
      readdirSync(dir).filter((name) => name !== "task-sessions.sqlite"),
      [],
      "the read-only open must not create -wal/-shm/recovery siblings",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Cross-process invariants (independent node processes, one SQLite file) ---

test("processes: concurrent duplicate ensure yields ONE owner for the task", async () => {
  const dir = tempDir();
  try {
    const dbPath = dbFile(dir);
    const startAt = Date.now() + 700;
    const children = await Promise.all(
      Array.from({ length: 4 }, () =>
        runChild(dbPath, "return store.ensure({ taskKey: 'acme:ENG-1', taskId: 'ENG-1', workspace: 'acme', issueId: 'ENG-1' });", startAt),
      ),
    );
    const ids = new Set(children.map((r) => r.sessionId));
    assert.equal(ids.size, 1, `all racers must agree on one owner, got ${[...ids].join(", ")}`);
    const store = createTaskSessionStore({ dbPath });
    const rows = store.list();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].sessionId, children[0].sessionId);
    assert.equal(rows[0].status, "queued");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("processes: the active cap of 2 holds when 6 processes race claimNext", async () => {
  const dir = tempDir();
  try {
    const dbPath = dbFile(dir);
    let store = createTaskSessionStore({ dbPath, maxActive: 2 });
    for (const i of [1, 2, 3, 4, 5, 6]) {
      store.ensure({ taskKey: `acme:ENG-${i}`, taskId: `ENG-${i}`, workspace: "acme", issueId: `ENG-${i}` });
    }
    store.close();
    const startAt = Date.now() + 700;
    const children = await Promise.all(
      Array.from({ length: 6 }, () => runChild(dbPath, "return { claimed: store.claimNext() };", startAt)),
    );
    const claimed = children.filter((r) => r.claimed !== null);
    assert.equal(claimed.length, 2, `exactly 2 of 6 racers may claim, got ${claimed.length}`);
    assert.equal(claimed.every((r) => r.claimed.status === "starting"), true);
    // The store agrees: 2 starting, 4 still queued, all for distinct tasks.
    store = createTaskSessionStore({ dbPath, maxActive: 2 });
    const rows = store.list();
    assert.equal(rows.filter((r) => r.status === "starting").length, 2);
    assert.equal(rows.filter((r) => r.status === "queued").length, 4);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("processes: 6 concurrent first opens of a fresh db all survive the WAL switch, 5 rounds", async () => {
  // journal_mode = WAL takes an exclusive lock and ignores busy_timeout, so
  // first-ever concurrent opens of a fresh file used to race with
  // "database is locked". Every child must now get through the open path and
  // see the file in WAL mode.
  for (let round = 0; round < 5; round++) {
    const dir = tempDir();
    try {
      const dbPath = dbFile(dir);
      const startAt = Date.now() + 700;
      const children = await Promise.all(
        Array.from({ length: 6 }, () =>
          runChild(
            dbPath,
            `const { DatabaseSync } = await import("node:sqlite");
             const probe = new DatabaseSync(dbPath);
             const mode = probe.prepare("PRAGMA journal_mode").get().journal_mode;
             probe.close();
             return { mode };`,
            startAt,
          ),
        ),
      );
      assert.equal(children.length, 6);
      for (const child of children) {
        assert.equal(child.mode, "wal", `round ${round}: every child must see wal`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("update cannot bypass capacity or reactivate a terminal owner", () => {
  const dir = tempDir();
  const store = createTaskSessionStore({ dbPath: dbFile(dir), maxActive: 1 });
  try {
    const a = store.ensure(ensureArgs());
    const b = store.ensure(ensureArgs({taskKey:"acme:ENG-2", taskId:"ENG-2", issueId:"ENG-2"}));
    store.claimNext();
    for (const status of ["starting", "running", "waiting"]) {
      assert.throws(() => store.update(b.sessionId, {status}), /claimNext/);
    }
    store.update(a.sessionId, {status:"stopped"});
    assert.equal(store.claimNext().sessionId, b.sessionId);
    assert.throws(() => store.update(a.sessionId, {status:"running"}), /invalid session transition/);
    assert.throws(() => store.update(a.sessionId, {status:"queued"}), /invalid session transition/);
    assert.equal(store.get(a.sessionId).status, "stopped");
    assert.equal(store.get(b.sessionId).status, "starting");
  } finally { store.close(); rmSync(dir, {recursive:true, force:true}); }
});

test("task ownership rejects forged or delimiter-colliding identities", () => {
  const dir = tempDir();
  const store = createTaskSessionStore({dbPath:dbFile(dir)});
  try {
    assert.throws(() => store.ensure(ensureArgs({taskKey:"other:ENG-1"})), /taskKey must match/);
    assert.throws(() => resolveTaskKey({workspace:"a:b",issueId:"c"}), /canonical identifier/);
    assert.throws(() => resolveTaskKey({workspace:"a",issueId:"b:c"}), /canonical identifier/);
    assert.equal(store.list().length, 0);
  } finally { store.close(); rmSync(dir, {recursive:true, force:true}); }
});

test('explicit resume retains identity but respects task ownership and queue capacity',()=>{
 const s=createTaskSessionStore({dbPath:':memory:',maxActive:1});try{
 const a=s.ensure(ensureArgs());s.claimNext();s.update(a.sessionId,{status:'stopped',runId:'run-a'});
 const b=s.ensure(ensureArgs({taskKey:'acme:OTHER',issueId:'OTHER',taskId:'OTHER'}));s.claimNext();
 assert.equal(s.resume(a.sessionId).status,'queued');assert.equal(s.claimNext(),null);assert.equal(s.get(a.sessionId).runId,'run-a');
 s.update(a.sessionId,{status:'stopped'});const fresh=s.ensure(ensureArgs());assert.notEqual(fresh.sessionId,a.sessionId);assert.throws(()=>s.resume(a.sessionId),/another generation/);
 }finally{s.close();}
});
