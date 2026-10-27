#!/usr/bin/env node
// task-sessions.mjs — durable task/session coordinator (PRD: task-workspace-supervisors).
//
// One SQLite table maps a task (workspace:issueId) to at most one ACTIVE
// session at a time, with a queue of waiting generations and a process-safe
// active cap. Built on node:sqlite only — same pattern as telemetry-store.mjs
// (WAL + busy_timeout + BEGIN IMMEDIATE), so independent processes each open
// their own connection and races are settled by SQLite's write lock, not by
// this module's bookkeeping.
//
// Exact semantics:
//   - ensure() returns the existing nonterminal owner for taskKey (queued
//     counts as an owner) or creates a new queued record. After the owner
//     reaches a terminal status (stopped|completed|failed) a later ensure()
//     creates a NEW generation row for the same taskKey.
//   - claimNext() atomically promotes the oldest queued session to `starting`
//     iff the count of active (starting|running|waiting) sessions is below
//     maxActive; the cap is enforced inside one write transaction, so it holds
//     across independent store connections/processes.
//   - update() accepts ONLY status, runId, pid, processStartedAt, lastError,
//     title. Identity (sessionId, taskKey, taskId, workspace, issueId,
//     createdAt) is immutable — attempts are rejected, never silently ignored.
//   - sessionId is strictly /^sup-[a-f0-9]{16,32}$/, generated randomly. It is
//     the ONLY identifier safe for path composition; taskId/taskKey are opaque
//     user data and must NEVER be used as (part of) a path.
//   - No adoption/migration: a legacy or foreign database is not reconciled in
//     any way; the schema is created IF NOT EXISTS and that is all.

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { dataHome } from "./fenix-paths.mjs";

let DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}

/** Every legal session status, in lifecycle order. */
export const STATUSES = ["queued", "starting", "running", "waiting", "stopped", "completed", "failed"];
/** Statuses that own a task (an active owner includes queued). */
export const OWNER_STATUSES = ["queued", "starting", "running", "waiting"];
/** Statuses counted against the active cap. */
export const CAP_STATUSES = ["starting", "running", "waiting"];
/** Statuses that release both the ownership and the cap slot. */
export const TERMINAL_STATUSES = ["stopped", "completed", "failed"];

/** Strict session id shape: sup- + 16..32 lowercase hex, random — never derived from task data. */
export const SESSION_ID_PATTERN = /^sup-[a-f0-9]{16,32}$/;

const STATUS_SET = new Set(STATUSES);
const OWNER_SQL = OWNER_STATUSES.map((s) => `'${s}'`).join(",");
const CAP_SQL = CAP_STATUSES.map((s) => `'${s}'`).join(",");

// Field budget for caller-supplied strings — wide enough for real Linear
// workspace/issue identifiers and titles, tight enough to bound the table.
const MAX_IDENTITY_LENGTH = 200;
const MAX_TITLE_LENGTH = 300;
const MAX_RUN_ID_LENGTH = 200;
const MAX_LAST_ERROR_LENGTH = 4000;

/** The default database path: dataHome()/supervisor/task-sessions.sqlite. */
export function taskSessionsDbPath(env = process.env, platform = process.platform) {
  return join(dataHome(env, platform), "supervisor", "task-sessions.sqlite");
}

export function sqliteAvailable() {
  return DatabaseSync != null;
}

/**
 * A read-only open that SQLite cannot satisfy because the WAL needs recovery
 * (a session host died mid-write) reports SQLITE_READONLY_RECOVERY; the
 * sidecar files themselves may be unopenable (SQLITE_CANTOPEN). Both get a
 * distinct reason so callers can name the fix instead of a generic "locked".
 */
const HOT_WAL_RE = /SQLITE_READONLY_RECOVERY|SQLITE_CANTOPEN/;
const hotWal = (err) =>
  HOT_WAL_RE.test(`${err?.code ?? ""} ${err?.errstr ?? ""} ${err?.message ?? ""}`) ||
  err?.errcode === 264 /* SQLITE_READONLY_RECOVERY */ ||
  err?.errcode === 14 /* SQLITE_CANTOPEN */;

function readOnlyOpenReason(dbPath, err) {
  if (hotWal(err)) {
    return `wal-recovery-needed: ${dbPath} needs WAL recovery — a session host died mid-write (${err?.message ?? err})`;
  }
  return `cannot open ${dbPath} read-only (${err?.message ?? err})`;
}

/**
 * Read-only peek at the active (CAP_STATUSES) sessions of a task-sessions
 * store (FOC-901). Never creates the schema and never writes: callers use it
 * to decide whether an unscoped Supervisor may adopt a run, so the store file
 * must be left byte-identical. Missing file → `{ sessions: [], unknown: null }`
 * ("nothing there"); a locked or corrupt file → `unknown` carries the reason
 * and the caller refuses rather than silently proceeding — a read-only open
 * failing on a hot WAL reports the distinct `wal-recovery-needed` reason.
 * Works on the same WAL store the host keeps open: the read-only connection
 * never needs the write lock.
 */
export function readActiveSessions(dbPath) {
  if (!existsSync(dbPath)) return { sessions: [], unknown: null };
  if (!sqliteAvailable()) {
    return { sessions: [], unknown: `node:sqlite is not available in this Node build (${process.version})` };
  }
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    return { sessions: [], unknown: readOnlyOpenReason(dbPath, err) };
  }
  try {
    const rows = db
      .prepare(`SELECT session_id, task_key, status, pid FROM task_sessions WHERE status IN (${CAP_SQL})`)
      .all();
    return {
      sessions: rows.map((row) => ({
        sessionId: row.session_id,
        taskKey: row.task_key,
        status: row.status,
        pid: row.pid ?? null,
      })),
      unknown: null,
    };
  } catch (err) {
    return { sessions: [], unknown: `cannot read ${dbPath} (${err.message})` };
  } finally {
    try { db.close(); } catch {}
  }
}

/**
 * Read-only peek at EVERY row of a task-sessions store, terminal included
 * (FOC-905): the orphan scan needs the owner session's status even after it
 * stopped, which the ACTIVE-only readActiveSessions does not carry. Same
 * read-only discipline as readActiveSessions (never creates the schema, never
 * writes, works on the WAL store the host keeps open), but failures are
 * swallowed as [] rather than surfaced: the scan must never block on the
 * store, and an unreadable store simply means the terminal-owner rule does
 * not apply (the time rule still governs).
 */
export function readSessionRows(dbPath) {
  if (!existsSync(dbPath)) return [];
  if (!sqliteAvailable()) return [];
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return [];
  }
  try {
    const rows = db
      .prepare("SELECT session_id, status, pid, process_started_at FROM task_sessions")
      .all();
    return rows.map((row) => ({
      sessionId: row.session_id,
      status: row.status,
      pid: row.pid ?? null,
      processStartedAt: row.process_started_at ?? null,
    }));
  } catch {
    return [];
  } finally {
    try { db.close(); } catch {}
  }
}

/**
 * The workspace half of the canonical task key for this repo (FOC-902). ONE
 * rule, shared by every process that builds a task key: `FENIX_WORK_WORKSPACE`
 * overrides it (tests and deployments), `jointhubs` is the default — the exact
 * rule work-routes.mjs' `workWorkspace()` applies. The other call sites
 * (the triage lease check, the cockpit's claimedBy) go through this helper so
 * the store, the routes and the triage can never disagree about the key.
 * @returns {string}
 */
export function workspaceNameFor(env = process.env) {
  return env.FENIX_WORK_WORKSPACE || "jointhubs";
}

/**
 * Stable task key: `workspace:issueId`. Deliberately NOT a display
 * identifier — it is the coordination key every process must agree on.
 * @returns {string}
 */
export function resolveTaskKey({ workspace, issueId } = {}) {
  requireBoundedString(workspace, "workspace");
  requireBoundedString(issueId, "issueId");
  for (const [field, value] of Object.entries({ workspace, issueId })) {
    if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new TypeError(`${field} must be a canonical identifier without separators or whitespace`);
  }
  return `${workspace}:${issueId}`;
}

/**
 * The issue part of a task key: the display identifier (`FOC-123`) when the
 * payload carries one, never the Linear uuid. The store, the host's pickup
 * and the board are all keyed by the identifier — callers must pass this
 * helper's result to `resolveTaskKey`, never re-derive it locally.
 * @param {{ identifier?: string, id?: string }} issue a Linear issue payload
 * @returns {string | undefined} the display identifier (uuid `id` only as fallback)
 */
export function issuePartOf(issue) {
  return issue?.identifier ?? issue?.id;
}

function requireBoundedString(value, field, maxLength = MAX_IDENTITY_LENGTH) {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength) {
    throw new TypeError(`${field} must be a non-empty string of at most ${maxLength} characters`);
  }
}

function newSessionId() {
  return `sup-${randomBytes(16).toString("hex")}`;
}

function nowIso() {
  return new Date().toISOString();
}

function sanitize(row) {
  if (!row) return null;
  return {
    sessionId: row.session_id,
    taskKey: row.task_key,
    taskId: row.task_id,
    workspace: row.workspace,
    issueId: row.issue_id,
    title: row.title ?? null,
    status: row.status,
    runId: row.run_id ?? null,
    pid: row.pid ?? null,
    processStartedAt: row.process_started_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastError: row.last_error ?? null,
  };
}

function createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_sessions (
      session_id        TEXT PRIMARY KEY,
      task_key          TEXT NOT NULL,
      task_id           TEXT NOT NULL,
      workspace         TEXT NOT NULL,
      issue_id          TEXT NOT NULL,
      title             TEXT,
      status            TEXT NOT NULL CHECK (status IN ('queued','starting','running','waiting','stopped','completed','failed')),
      run_id            TEXT,
      pid               INTEGER,
      process_started_at TEXT,
      last_error        TEXT,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_task_sessions_task_key
      ON task_sessions(task_key, created_at, session_id);
    CREATE INDEX IF NOT EXISTS idx_task_sessions_queue
      ON task_sessions(created_at, session_id) WHERE status = 'queued';
    -- The ownership invariant itself: at most one ACTIVE row per task key.
    -- A partial unique index is checked on every insert/update across ALL
    -- connections, so a terminal row never blocks a new generation and two
    -- processes cannot both own the same task.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_task_sessions_one_active_owner
      ON task_sessions(task_key) WHERE status IN (${OWNER_SQL});
  `);
}

/** Fields update() may write; everything else (identity) is rejected. */
const MUTABLE_FIELDS = new Set(["status", "runId", "pid", "processStartedAt", "lastError", "title"]);

/**
 * The default cap on concurrently active task sessions: ONE for 1.0. Two
 * small-ticket sessions on one repository still share the main checkout
 * (FOC-1088: no per-session worktree, a branch switch lands under the other
 * session), so concurrency is opt-in until that lands:
 * `fenix settings set taskSessions.maxActive 2` or FENIX_MAX_ACTIVE_SUPERVISORS.
 * The host, the store and `fenix doctor` all read this one constant.
 */
export const DEFAULT_MAX_ACTIVE = 1;

/**
 * Durable task/session store. Each instance holds one independent SQLite
 * connection; the ownership invariant and the active cap are safe across
 * instances and processes because both are enforced by SQLite inside a single
 * write transaction (BEGIN IMMEDIATE) guarded additionally by the partial
 * unique index above.
 *
 * @param {{dbPath?: string, maxActive?: number}} [options]
 * @param {string} [options.dbPath] defaults to dataHome()/supervisor/task-sessions.sqlite
 * @param {number} [options.maxActive=DEFAULT_MAX_ACTIVE] cap on concurrently active (starting|running|waiting) sessions
 */
export function createTaskSessionStore({ dbPath, maxActive = DEFAULT_MAX_ACTIVE } = {}) {
  if (!sqliteAvailable()) {
    throw new Error(`node:sqlite is required for task sessions (current: ${process.version})`);
  }
  if (!Number.isInteger(maxActive) || maxActive < 1) {
    throw new TypeError("maxActive must be an integer >= 1");
  }
  const path = dbPath ?? taskSessionsDbPath();
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // busy_timeout first, in its own exec: the WAL switch below ignores it.
  db.exec("PRAGMA busy_timeout = 10000;");
  // Switching journal_mode to WAL takes an exclusive lock and does NOT invoke
  // the busy handler, so busy_timeout does not cover it — first-ever concurrent
  // opens of a fresh file race here with SQLITE_BUSY (errcode 5) instead of
  // waiting. Retry the switch on a bounded budget, re-reading journal_mode and
  // accepting `wal` already set by a racing connection; after the bound,
  // rethrow the original error (fail closed).
  const walDeadline = Date.now() + 10_000;
  const walWait = new Int32Array(new SharedArrayBuffer(4));
  let walError;
  for (;;) {
    try {
      if (db.prepare("PRAGMA journal_mode").get().journal_mode !== "wal") {
        db.exec("PRAGMA journal_mode = WAL;");
      }
      walError = undefined;
      break;
    } catch (error) {
      walError = error;
      const locked = error?.errcode === 5 || /database is locked/i.test(String(error?.message));
      if (!locked || Date.now() >= walDeadline) break;
      Atomics.wait(walWait, 0, 0, 25); // synchronous 25 ms sleep
    }
  }
  if (walError !== undefined) throw walError;

  createSchema(db);

  const statements = {
    bySessionId: db.prepare("SELECT * FROM task_sessions WHERE session_id = ?"),
    activeOwnerByTaskKey: db.prepare(
      `SELECT * FROM task_sessions WHERE task_key = ? AND status IN (${OWNER_SQL})
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ),
    activeCapCount: db.prepare(`SELECT COUNT(*) AS n FROM task_sessions WHERE status IN (${CAP_SQL})`),
    oldestQueued: db.prepare(
      "SELECT * FROM task_sessions WHERE status = 'queued' ORDER BY created_at ASC, rowid ASC LIMIT 1",
    ),
    newestByTaskKey: db.prepare(
      "SELECT * FROM task_sessions WHERE task_key = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
    ),
    insert: db.prepare(`
      INSERT INTO task_sessions
        (session_id, task_key, task_id, workspace, issue_id, title, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)
    `),
  };

  /** Runs fn inside one write transaction; rolls back and rethrows on failure. */
  function inWriteTransaction(fn) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  function requireSessionId(sessionId) {
    if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) {
      throw new TypeError(`sessionId must match ${SESSION_ID_PATTERN}`);
    }
  }

  const store = {
    /** Resolved database path (exposed for diagnostics; tests pass dbPath explicitly). */
    dbPath: path,

    /**
     * Return the existing nonterminal owner for taskKey (queued included), or
     * create and return a new queued generation. Identity fields are immutable
     * and never adopted from a previous generation.
     */
    ensure({ taskKey, taskId, workspace, issueId, title } = {}) {
      requireBoundedString(taskKey, "taskKey");
      requireBoundedString(taskId, "taskId");
      requireBoundedString(workspace, "workspace");
      requireBoundedString(issueId, "issueId");
      if (taskKey !== resolveTaskKey({ workspace, issueId })) throw new TypeError("taskKey must match workspace and issueId");
      if (title !== undefined && title !== null) {
        requireBoundedString(title, "title", MAX_TITLE_LENGTH);
      }
      const titleValue = title ?? null;
      return inWriteTransaction(() => {
        const existing = statements.activeOwnerByTaskKey.get(taskKey);
        if (existing) return sanitize(existing);
        const sessionId = newSessionId();
        const at = nowIso();
        try {
          statements.insert.run(sessionId, taskKey, taskId, workspace, issueId, titleValue, at, at);
        } catch (error) {
          // A racing process inserted the active owner between our SELECT and
          // INSERT (the unique index fired). Re-read and return the winner —
          // this process did not lose data, it lost the race.
          if (!/UNIQUE constraint failed/i.test(String(error?.message))) throw error;
          const winner = statements.activeOwnerByTaskKey.get(taskKey);
          if (!winner) throw error;
          return sanitize(winner);
        }
        return sanitize(statements.bySessionId.get(sessionId));
      });
    },

    /** Explicit stopped-session resume, admitted through the normal queue/cap. */
    resume(sessionId) {
      requireSessionId(sessionId);
      return inWriteTransaction(() => {
        const row=statements.bySessionId.get(sessionId);
        if(!row || row.status!=='stopped') throw Error('only a verified stopped session can resume');
        if(statements.activeOwnerByTaskKey.get(row.task_key))throw Error('another generation owns this task');
        db.prepare("UPDATE task_sessions SET status='queued', pid=NULL, process_started_at=NULL, last_error=NULL, updated_at=? WHERE session_id=?").run(nowIso(),sessionId);
        return sanitize(statements.bySessionId.get(sessionId));
      });
    },

    /** The session record, or null. */
    get(sessionId) {
      requireSessionId(sessionId);
      return sanitize(statements.bySessionId.get(sessionId));
    },

    /** Newest record for taskKey regardless of status, or null. */
    getByTask(taskKey) {
      requireBoundedString(taskKey, "taskKey");
      return sanitize(statements.newestByTaskKey.get(taskKey));
    },

    /**
     * All records, newest first. With includeTerminal=false only active
     * (queued|starting|running|waiting) records are returned.
     */
    list({ includeTerminal = true } = {}) {
      const rows = includeTerminal
        ? db.prepare("SELECT * FROM task_sessions ORDER BY created_at DESC, rowid DESC").all()
        : db
            .prepare(
              `SELECT * FROM task_sessions WHERE status IN (${OWNER_SQL})
               ORDER BY created_at DESC, rowid DESC`,
            )
            .all();
      return rows.map(sanitize);
    },

    /**
     * Atomically promote the oldest queued session to `starting` iff the count
     * of active (starting|running|waiting) sessions is below maxActive.
     * Returns the promoted record, or null when the cap is full or the queue
     * is empty. Safe across independent store connections.
     */
    claimNext() {
      return inWriteTransaction(() => {
        const { n } = statements.activeCapCount.get();
        if (n >= maxActive) return null;
        const queued = statements.oldestQueued.get();
        if (!queued) return null;
        const at = nowIso();
        db.prepare(
          "UPDATE task_sessions SET status = 'starting', updated_at = ? WHERE session_id = ? AND status = 'queued'",
        ).run(at, queued.session_id);
        return sanitize(statements.bySessionId.get(queued.session_id));
      });
    },

    /**
     * Patch a session. ONLY status, runId, pid, processStartedAt, lastError and
     * title are writable; identity and timestamps present in the patch are
     * rejected outright. Unknown session ids throw.
     */
    update(sessionId, patch = {}) {
      requireSessionId(sessionId);
      if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
        throw new TypeError("patch must be an object");
      }
      for (const key of Object.keys(patch)) {
        if (!MUTABLE_FIELDS.has(key)) {
          throw new TypeError(`field '${key}' is not writable (immutable identity or unknown); allowed: ${[...MUTABLE_FIELDS].join(", ")}`);
        }
      }
      const sets = [];
      const values = [];
      if ("status" in patch) {
        if (typeof patch.status !== "string" || !STATUS_SET.has(patch.status)) {
          throw new TypeError(`status must be one of: ${STATUSES.join(", ")}`);
        }
        sets.push("status = ?");
        values.push(patch.status);
      }
      if ("runId" in patch) {
        if (patch.runId !== null) requireBoundedString(patch.runId, "runId", MAX_RUN_ID_LENGTH);
        sets.push("run_id = ?");
        values.push(patch.runId);
      }
      if ("pid" in patch) {
        if (patch.pid !== null && (!Number.isInteger(patch.pid) || patch.pid < 1)) {
          throw new TypeError("pid must be a positive integer or null");
        }
        sets.push("pid = ?");
        values.push(patch.pid);
      }
      if ("processStartedAt" in patch) {
        if (patch.processStartedAt !== null) {
          requireBoundedString(patch.processStartedAt, "processStartedAt", MAX_TITLE_LENGTH);
        }
        sets.push("process_started_at = ?");
        values.push(patch.processStartedAt);
      }
      if ("lastError" in patch) {
        if (patch.lastError !== null) {
          requireBoundedString(patch.lastError, "lastError", MAX_LAST_ERROR_LENGTH);
        }
        sets.push("last_error = ?");
        values.push(patch.lastError);
      }
      if ("title" in patch) {
        if (patch.title !== null) requireBoundedString(patch.title, "title", MAX_TITLE_LENGTH);
        sets.push("title = ?");
        values.push(patch.title);
      }
      return inWriteTransaction(() => {
        const row = statements.bySessionId.get(sessionId);
        if (!row) throw new Error(`unknown sessionId: ${sessionId}`);
        if (patch.status && patch.status !== row.status) {
          const allowed = {
            queued: ["stopped", "failed"],
            starting: ["running", "waiting", "stopped", "completed", "failed"],
            running: ["starting", "waiting", "stopped", "completed", "failed"],
            waiting: ["starting", "running", "stopped", "completed", "failed"],
          };
          if (!allowed[row.status]?.includes(patch.status)) {
            throw new Error(`invalid session transition ${row.status} -> ${patch.status}; queued admission requires claimNext()`);
          }
        }
        if (sets.length > 0) {
          values.push(nowIso(), sessionId);
          db.prepare(`UPDATE task_sessions SET ${sets.join(", ")}, updated_at = ? WHERE session_id = ?`).run(...values);
        }
        return sanitize(statements.bySessionId.get(sessionId));
      });
    },

    /** Close this store's connection. Other connections stay usable. */
    close() {
      db.close();
    },
  };

  store.resolveTaskKey = resolveTaskKey;
  return store;
}
