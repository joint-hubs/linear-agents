// scripts/supervisor-migrate-legacy.mjs — one-shot legacy run migration into
// the managed task-sessions store (FOC-839, PRD §5).
//
// Before task workspaces (PR #71) every Supervisor run was owned by the single
// legacy session (`session.json` + the global current-run pointer, no
// `owner.json` session link). After an update onto a volume that already holds
// legacy runs, those runs must be resolved exactly once:
//
//   1. A store with NO row at all (file missing or empty) → nothing happens
//      (`no-managed-sessions`); legacy mode continues untouched.
//   2. Legacy run = a run dir (state home, RUN_ID_RE, holding children.json)
//      whose `owner.json` is missing or has `sessionId` null, not already
//      carrying `legacy-attach.json` or `legacy-readonly.json`.
//   3. A legacy run whose owner Supervisor is PROVABLY alive is skipped
//      (`owner-alive`): the global current-run pointer names this runId and
//      its pid (top-level, or FOC-905's `owner.pid`) is alive (pidAlive), or
//      `owner.json.pid` is alive.
//   3b. The run named by the global current-run pointer is ALWAYS skipped
//      (`current-pointer`) unless a pid is known (pointer top-level,
//      pointer `owner.pid`, or `owner.json.pid`) AND pidAlive reports it
//      dead. "No pid known" → skip, never attach, never mark: a PRE-FOC-905
//      pointer carries neither a pid nor an owner, so liveness cannot be
//      proven and the CURRENT legacy Supervisor may still be running. Such a
//      volume must have its legacy Supervisor stopped and its pointer
//      re-recorded; until then the current run simply stays untouched — the
//      safe default.
//   4. Attach ONCE: the run's `triage.json.issue` resolves (resolveTaskKey +
//      workspaceNameFor(env)) to a task key with EXACTLY ONE non-terminal
//      session row with runId null → `store.update(sessionId, { runId })` and
//      `<runDir>/legacy-attach.json { sessionId, attachedAt }`. Several legacy
//      runs naming the same task: the NEWEST run dir (run ids are timestamps)
//      attaches, the others go read-only (`older-duplicate`).
//   5. Every other legacy run → `<runDir>/legacy-readonly.json { markedAt,
//      reason }`: `no-session-for-task` | `no-triage-issue` | `session-has-run`
//      | `older-duplicate`. A run is NEVER adopted into a task it does not
//      name. (A task whose only non-terminal session already carries a runId
//      is `session-has-run` — that session is never re-pointed, D2. A task
//      with SEVERAL runId-null candidates is ambiguous, not guessable → the
//      run is collected under `skipped` with `ambiguous-candidates`.)
//   6. Dry run is the default — nothing is written without `--apply`. Both
//      marker files short-circuit, so a second `--apply` changes nothing.
//
// Per-run problems (unreadable dirs, store hiccups) never throw — collected
// under `skipped` with a reason.
//
// Usage:
//   node scripts/supervisor-migrate-legacy.mjs [--apply] [--json]
//
// Exit: 0 normally, 2 on usage error. ESM, zero runtime deps (Node 22+,
// node:sqlite read-only for the candidate peek; the store write path only on
// --apply).

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { supervisorCurrentRunPath } from "./fenix-paths.mjs";
import { readRunOwner } from "./run-owner.mjs";
import { pidAlive, readCurrentRun } from "./supervisor-current-run.mjs";
import { RUN_ID_RE, supervisorStateHome } from "./utils.mjs";
import {
  TERMINAL_STATUSES,
  createTaskSessionStore,
  readSessionRows,
  resolveTaskKey,
  taskSessionsDbPath,
  workspaceNameFor,
} from "./task-sessions.mjs";

const LEGACY_ATTACH_FILE = "legacy-attach.json";
const LEGACY_READONLY_FILE = "legacy-readonly.json";

/** The run was marked read-only by a previous migration pass (part 2's 409 guard reads this). */
export function isLegacyReadOnly(runDir) {
  return existsSync(join(runDir, LEGACY_READONLY_FILE));
}

/** The `{ sessionId, attachedAt }` record a successful attach wrote, or null (missing/corrupt). */
export function legacyAttachOf(runDir) {
  try {
    const parsed = JSON.parse(readFileSync(join(runDir, LEGACY_ATTACH_FILE), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** `triage.json.issue`, or null — missing, corrupt, or not a non-empty string. */
function triageIssueOf(rDir) {
  try {
    const parsed = JSON.parse(readFileSync(join(rDir, "triage.json"), "utf8"));
    const issue = parsed?.issue;
    return typeof issue === "string" && issue.trim() ? issue : null;
  } catch {
    return null;
  }
}

/** Legacy = no owner session id: a missing/corrupt owner.json (readRunOwner → null) or `sessionId` null (FOC-905's record for legacy/host runs). */
function isLegacyRun(rDir) {
  const owner = readRunOwner(rDir);
  return !owner || typeof owner.sessionId !== "string" || owner.sessionId.length === 0;
}

/**
 * Read-only peek at the NON-terminal rows of the task-sessions store with the
 * fields the attach decision needs (readSessionRows does not carry run_id /
 * task_key). Same read-only discipline as readActiveSessions: never creates
 * the schema, never writes, works on the WAL store the host keeps open.
 * Failures (missing file aside) throw — the caller collects them as skipped.
 */
function readNonTerminalRows(dbPath) {
  if (!existsSync(dbPath)) return [];
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    throw new Error(`cannot open ${dbPath} read-only (${err?.message ?? err})`);
  }
  try {
    const terminalSql = TERMINAL_STATUSES.map((s) => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT session_id, task_key, status, run_id FROM task_sessions
         WHERE status NOT IN (${terminalSql})`,
      )
      .all(...TERMINAL_STATUSES);
    return rows.map((row) => ({
      sessionId: row.session_id,
      taskKey: row.task_key,
      status: row.status,
      runId: row.run_id ?? null,
    }));
  } finally {
    try { db.close(); } catch {}
  }
}

/**
 * The migration. `env` (default process.env) names the state home
 * (LA_SUPERVISOR_STATE_HOME) and the store path (LA_DATA_HOME via
 * taskSessionsDbPath); `stateHome`/`dbPath` override those for tests.
 *
 * @param {{ env?: object, apply?: boolean, stateHome?: string, dbPath?: string, now?: Date }} options
 * @returns {{ attached: Array<{runId, sessionId}>, readOnly: Array<{runId, reason}>, skipped: Array<{runId, reason}>, dryRun: boolean }}
 */
export function migrateLegacy({ env = process.env, apply = false, stateHome, dbPath, now = new Date() } = {}) {
  const dryRun = !apply;
  const result = { attached: [], readOnly: [], skipped: [], dryRun };
  const home = stateHome ?? (env.LA_SUPERVISOR_STATE_HOME || join(dirname(fileURLToPath(import.meta.url)), "..", ".state", "supervisor"));
  const storePath = dbPath ?? taskSessionsDbPath(env);
  const nowIso = now.toISOString();

  // Rule 1: no managed sessions at all → legacy mode continues untouched.
  let rowCount;
  try {
    rowCount = readSessionRows(storePath).length;
  } catch (err) {
    result.skipped.push({ runId: null, reason: `store-unreadable: ${err?.message ?? err}` });
    return result;
  }
  if (rowCount === 0) {
    result.skipped.push({ runId: null, reason: "no-managed-sessions" });
    return result;
  }

  let nonTerminal;
  try {
    nonTerminal = readNonTerminalRows(storePath);
  } catch (err) {
    result.skipped.push({ runId: null, reason: `store-unreadable: ${err?.message ?? err}` });
    return result;
  }
  // Candidates per task key: runId-null rows are attach candidates; runId-set
  // rows are counted separately so "the only session already has a run" gets
  // its own read-only reason instead of a generic no-session.
  const unclaimed = new Map(); // taskKey -> sessionId[]
  const claimed = new Set();
  for (const row of nonTerminal) {
    if (row.runId) claimed.add(row.taskKey);
    else if (!unclaimed.has(row.taskKey)) unclaimed.set(row.taskKey, []);
    if (!row.runId) unclaimed.get(row.taskKey).push(row.sessionId);
  }

  // Rule 3: the provably-alive legacy owner — the global pointer names a run
  // and carries the pid of the Supervisor still attached to it. The pid rides
  // at the top level on a pre-FOC-905 writer that stamped one, otherwise only
  // inside the FOC-905 `owner` object; no production writer sets both, so
  // fall through them in that order. A PRE-FOC-905 pointer carries neither —
  // rule 3b then keeps its run untouched.
  const current = readCurrentRun({ path: supervisorCurrentRunPath(env) });
  const currentRunId = typeof current?.runId === "string" ? current.runId : null;
  const currentPid = [current?.pid, current?.owner?.pid].find((p) => Number.isInteger(p) && p > 0) ?? null;

  const runIds = listRunIds(home);

  // Rule 4: several legacy runs naming the same task — only the newest run
  // dir (run ids sort as timestamps) may attach; older ones go read-only.
  const newestByTaskKey = new Map();
  for (const runId of runIds) {
    const issue = triageIssueOf(join(home, runId));
    if (!issue) continue;
    let taskKey;
    try {
      taskKey = resolveTaskKey({ workspace: workspaceNameFor(env), issueId: issue });
    } catch {
      continue; // not a canonical identifier — the run loop marks it read-only
    }
    if (!newestByTaskKey.has(taskKey) || runId > newestByTaskKey.get(taskKey)) {
      newestByTaskKey.set(taskKey, runId);
    }
  }

  // The store connection is opened lazily, once, and only on a real attach
  // (a dry run and a mark-only pass never open a write connection).
  let store = null;
  const openStore = () => {
    if (!store) store = createTaskSessionStore({ dbPath: storePath });
    return store;
  };

  for (const runId of runIds) {
    const rDir = join(home, runId);
    try {
      // Rule 2: already migrated (attach or read-only marker present) or a
      // managed-owned run — out of scope, silently (not a skip).
      if (existsSync(join(rDir, LEGACY_ATTACH_FILE)) || existsSync(join(rDir, LEGACY_READONLY_FILE))) continue;
      if (!isLegacyRun(rDir)) continue;
      decideRun(runId, rDir, { result, unclaimed, claimed, newestByTaskKey, currentRunId, currentPid, dryRun, nowIso, env, openStore });
    } catch (err) {
      result.skipped.push({ runId, reason: `error: ${err?.message ?? err}` });
    }
  }
  if (store) store.close();
  return result;
}

/** Rules 3–5 for one legacy run dir. Throws only on per-run errors (collected as skipped). */
function decideRun(runId, rDir, ctx) {
  const { result, unclaimed, claimed, newestByTaskKey, currentRunId, currentPid, dryRun, nowIso, env, openStore } = ctx;

  const owner = readRunOwner(rDir);
  const ownerPid = Number.isInteger(owner?.pid) && owner.pid > 0 ? owner.pid : null;

  // Rule 3: the owner Supervisor is provably alive → leave it alone (the
  // pointer's pid, wherever it rides, or owner.json's).
  if ((runId === currentRunId && currentPid !== null && pidAlive(currentPid)) || (ownerPid !== null && pidAlive(ownerPid))) {
    result.skipped.push({ runId, reason: "owner-alive" });
    return;
  }

  // Rule 3b: the pointer-named run stays untouched unless a pid is known AND
  // provably dead — "no pid known" (a pre-FOC-905 pointer over a pre-FOC-905
  // run) means the CURRENT legacy Supervisor may still be live.
  if (runId === currentRunId && currentPid === null && ownerPid === null) {
    result.skipped.push({ runId, reason: "current-pointer" });
    return;
  }

  // Rule 5: no triage issue → read-only (never adopt into a task it does not name).
  const issue = triageIssueOf(rDir);
  if (!issue) {
    markReadOnly(runId, rDir, "no-triage-issue", { result, dryRun, nowIso });
    return;
  }
  let taskKey;
  try {
    taskKey = resolveTaskKey({ workspace: workspaceNameFor(env), issueId: issue });
  } catch {
    markReadOnly(runId, rDir, "no-triage-issue", { result, dryRun, nowIso });
    return;
  }

  // Rule 4: another legacy run names the same task and is newer → read-only.
  if (newestByTaskKey.get(taskKey) !== runId) {
    markReadOnly(runId, rDir, "older-duplicate", { result, dryRun, nowIso });
    return;
  }

  const candidates = unclaimed.get(taskKey) ?? [];
  if (candidates.length === 0) {
    // No attachable session. Distinguish "no session at all" from "the only
    // non-terminal session already carries a runId (never re-pointed, D2)".
    markReadOnly(runId, rDir, claimed.has(taskKey) ? "session-has-run" : "no-session-for-task", { result, dryRun, nowIso });
    return;
  }
  if (candidates.length > 1) {
    // Exactly one is a hard gate — do not guess which session to adopt into.
    result.skipped.push({ runId, reason: `ambiguous-candidates: ${taskKey} has ${candidates.length} runId-null non-terminal sessions` });
    return;
  }

  // Rule 4: attach once — point the session at this run and stamp the marker.
  const sessionId = candidates[0];
  if (!dryRun) {
    openStore().update(sessionId, { runId });
    writeMarker(rDir, LEGACY_ATTACH_FILE, { sessionId, attachedAt: nowIso });
  }
  result.attached.push({ runId, sessionId });
}

function markReadOnly(runId, rDir, reason, { result, dryRun, nowIso }) {
  if (!dryRun) writeMarker(rDir, LEGACY_READONLY_FILE, { markedAt: nowIso, reason });
  result.readOnly.push({ runId, reason });
}

function writeMarker(rDir, name, payload) {
  mkdirSync(rDir, { recursive: true });
  writeFileSync(join(rDir, name), JSON.stringify(payload, null, 2) + "\n", "utf8");
}

/** Run dir ids (RUN_ID_RE + children.json present), NEWEST first. */
function listRunIds(home) {
  let entries;
  try {
    entries = readdirSync(home, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && RUN_ID_RE.test(e.name) && existsSync(join(home, e.name, "children.json")))
    .map((e) => e.name)
    .sort()
    .reverse();
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function main(argv) {
  let apply = false;
  let json = false;
  for (const arg of argv) {
    if (arg === "--apply") apply = true;
    else if (arg === "--json") json = true;
    else {
      console.error(`usage: node scripts/supervisor-migrate-legacy.mjs [--apply] [--json] (unknown argument: ${arg})`);
      return 2;
    }
  }
  const result = migrateLegacy({ apply });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`legacy migration: attached ${result.attached.length}, read-only ${result.readOnly.length}, skipped ${result.skipped.length}`);
    for (const a of result.attached) console.log(`attach ${a.runId} -> ${a.sessionId}`);
    for (const r of result.readOnly) console.log(`read-only ${r.runId} (${r.reason})`);
    for (const s of result.skipped) console.log(`skip ${s.runId ?? "-"} (${s.reason})`);
  }
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(`supervisor-migrate-legacy: ${err.message}`);
    process.exit(1);
  }
}
