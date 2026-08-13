#!/usr/bin/env node
// telemetry-store.mjs — central, rebuildable telemetry projection.
//
// Runtime evidence remains in Claude transcripts. This module stores immutable
// event envelopes and compact projections in a user-local SQLite database so
// dashboard reads do not scan the filesystem.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, "..");

let DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}

export const SCHEMA_VERSION = 4;

export function sqliteAvailable() {
  return DatabaseSync != null;
}

export function telemetryHome() {
  return process.env.LA_TELEMETRY_HOME || join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "linear-agents", "telemetry");
}

export function telemetryDbPath() {
  return process.env.LA_TELEMETRY_DB || join(telemetryHome(), "telemetry.sqlite");
}

export function spoolPaths() {
  const home = telemetryHome();
  return {
    home,
    pending: join(home, "spool", "pending"),
    archive: join(home, "spool", "archive"),
  };
}

function ensureParent(path) {
  mkdirSync(dirname(path), { recursive: true });
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function atomicJson(path, value) {
  ensureParent(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", "utf8");
  renameSync(temporary, path);
}

function now() {
  return new Date().toISOString();
}

function nullableNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function normalizePath(path) {
  if (!path || typeof path !== "string") return null;
  return resolve(path).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function normalizeTaskId(taskId) {
  if (!taskId || typeof taskId !== "string") return null;
  const normalized = taskId.trim().toUpperCase();
  return normalized || null;
}

function safeJson(value) {
  return JSON.stringify(value ?? {});
}

function parseJson(value, fallback = null) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

export function openTelemetryDb(path = telemetryDbPath()) {
  if (!sqliteAvailable()) {
    throw new Error(`node:sqlite is required for central telemetry (current: ${process.version})`);
  }
  if (path !== ":memory:") ensureParent(path);
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  migrate(db);
  return db;
}

// Full current schema, created once via IF NOT EXISTS. New columns on existing
// tables are NOT added here — see the migration steps below migrate(), which
// keep a paper trail of what changed and why instead of silently rewriting
// this block (and losing that history) every time the schema grows.
function createBaseSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      run_id TEXT,
      observed_at TEXT NOT NULL,
      host_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_path TEXT,
      source_offset INTEGER,
      payload_json TEXT NOT NULL,
      ingested_at TEXT NOT NULL,
      UNIQUE(source_kind, source_path, source_offset, event_type)
    );
    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY,
      squad TEXT,
      source TEXT,
      brief TEXT,
      started_at TEXT,
      ended_at TEXT,
      status TEXT,
      exit_code INTEGER,
      native INTEGER,
      interactive INTEGER,
      launch_cwd TEXT,
      claude_config_dir TEXT,
      session_id TEXT,
      transcript_path TEXT,
      price_set_id TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      first_seen_at TEXT NOT NULL,
      transcript_path TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS run_sessions (
      run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      linked_at TEXT NOT NULL,
      source TEXT NOT NULL,
      PRIMARY KEY(run_id, session_id)
    );
    CREATE TABLE IF NOT EXISTS repositories (
      repository_id TEXT PRIMARY KEY,
      common_dir TEXT NOT NULL UNIQUE,
      remote_url TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS worktrees (
      worktree_id TEXT PRIMARY KEY,
      repository_id TEXT REFERENCES repositories(repository_id),
      path TEXT NOT NULL UNIQUE,
      git_dir TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspace_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
      observed_at TEXT NOT NULL,
      cwd TEXT,
      repository_id TEXT REFERENCES repositories(repository_id),
      worktree_id TEXT REFERENCES worktrees(worktree_id),
      ref_type TEXT NOT NULL DEFAULT 'unknown',
      ref_name TEXT,
      head_sha TEXT,
      source TEXT NOT NULL,
      UNIQUE(run_id, observed_at, cwd, ref_type, ref_name, head_sha)
    );
    CREATE TABLE IF NOT EXISTS work_items (
      task_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL DEFAULT 'linear',
      workspace TEXT,
      identifier TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS run_task_links (
      link_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
      task_id TEXT NOT NULL REFERENCES work_items(task_id),
      role TEXT NOT NULL DEFAULT 'primary',
      valid_from TEXT NOT NULL,
      valid_to TEXT,
      source TEXT NOT NULL,
      confidence REAL NOT NULL,
      supersedes_link_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_run_task_links_active ON run_task_links(run_id, role, valid_to);
    CREATE TABLE IF NOT EXISTS transcript_sources (
      source_path TEXT PRIMARY KEY,
      session_id TEXT,
      run_id TEXT,
      byte_offset INTEGER NOT NULL DEFAULT 0,
      file_size INTEGER NOT NULL DEFAULT 0,
      modified_at TEXT,
      parse_status TEXT NOT NULL DEFAULT 'pending',
      last_error TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS price_sets (
      price_set_id TEXT PRIMARY KEY,
      config_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      source TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS model_prices (
      price_set_id TEXT NOT NULL REFERENCES price_sets(price_set_id) ON DELETE CASCADE,
      model_key TEXT NOT NULL,
      input_price REAL NOT NULL,
      output_price REAL NOT NULL,
      cache_read_price REAL,
      PRIMARY KEY(price_set_id, model_key)
    );
    CREATE TABLE IF NOT EXISTS usage_facts (
      usage_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
      session_id TEXT,
      agent_key TEXT NOT NULL,
      model TEXT,
      observed_at TEXT,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL,
      cache_creation_tokens INTEGER NOT NULL,
      source_path TEXT NOT NULL,
      source_offset INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(source_path, source_offset)
    );
    CREATE INDEX IF NOT EXISTS idx_usage_facts_run ON usage_facts(run_id, observed_at);
    CREATE TABLE IF NOT EXISTS cost_facts (
      usage_id TEXT NOT NULL REFERENCES usage_facts(usage_id) ON DELETE CASCADE,
      price_set_id TEXT REFERENCES price_sets(price_set_id),
      cost_usd REAL,
      PRIMARY KEY(usage_id, price_set_id)
    );
    CREATE TABLE IF NOT EXISTS data_quality_issues (
      issue_id TEXT PRIMARY KEY,
      run_id TEXT REFERENCES runs(run_id) ON DELETE CASCADE,
      issue_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      details_json TEXT NOT NULL,
      opened_at TEXT NOT NULL,
      resolved_at TEXT,
      UNIQUE(run_id, issue_type, resolved_at)
    );
    CREATE TABLE IF NOT EXISTS tool_facts (
      tool_fact_id   TEXT PRIMARY KEY,
      run_id         TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
      agent_key      TEXT NOT NULL,
      model          TEXT,
      observed_at    TEXT,
      tool_name_raw  TEXT NOT NULL,
      tool_name_canon TEXT,
      tool_input     TEXT,
      tool_has_error INTEGER NOT NULL DEFAULT 0,
      turn_index    INTEGER NOT NULL,
      source_path   TEXT NOT NULL,
      source_offset INTEGER NOT NULL,
      created_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tool_facts_run ON tool_facts(run_id, agent_key);
    CREATE INDEX IF NOT EXISTS idx_tool_facts_canon ON tool_facts(tool_name_canon);
    CREATE TABLE IF NOT EXISTS delegation_links (
      delegation_id   TEXT PRIMARY KEY,
      parent_run_id   TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
      parent_agent    TEXT NOT NULL,
      child_agent     TEXT NOT NULL,
      child_model     TEXT,
      child_transcript TEXT,
      observed_at     TEXT,
      child_tokens    INTEGER,
      child_cost_usd  REAL,
      child_turns     INTEGER,
      source          TEXT NOT NULL,
      created_at      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_delegation_links_parent ON delegation_links(parent_run_id, parent_agent);
    CREATE INDEX IF NOT EXISTS idx_delegation_links_child ON delegation_links(child_agent);
  `);
}

// Columns added to `runs` after its initial CREATE TABLE. Declarative list
// instead of one `if (!columns.includes(...)) ALTER` per line, so "which
// columns exist and why" reads in one place — this is exactly the block that
// gets a new line every time a feature needs a new column (console_pid,
// window_title, launched_by all landed here for the terminal panel).
const RUN_COLUMNS = [
  ["price_set_id", "TEXT"],
  // Terminal panel: the console window a run owns. console_pid is the stable
  // identifier — the window title is overwritten by Claude Code at startup, so
  // window_title and launched_by are labels for the UI, never lookup keys.
  ["console_pid", "INTEGER"],
  ["window_title", "TEXT"],
  ["launched_by", "TEXT"],
];

function addRunColumns(db) {
  const existing = new Set(db.prepare("PRAGMA table_info(runs)").all().map((c) => c.name));
  for (const [name, type] of RUN_COLUMNS) {
    if (!existing.has(name)) db.exec(`ALTER TABLE runs ADD COLUMN ${name} ${type}`);
  }
}

// One-time backfill: every pre-existing run gets the price set that was live
// at migration time, so cost queries never see a NULL price_set_id.
function backfillPriceSetId(db) {
  const migrationPriceSet = ensurePriceSet(db);
  db.prepare("UPDATE runs SET price_set_id=? WHERE price_set_id IS NULL").run(migrationPriceSet.id);
}

// Data-integrity backfill: close any 'primary' task link left open (valid_to
// IS NULL) despite a newer 'primary' link existing for the same run — a state
// that predates the "one active primary link" invariant enforced by the
// unique index below.
function closeSupersededPrimaryLinks(db) {
  db.exec(`
    UPDATE run_task_links SET valid_to=(
      SELECT newer.valid_from FROM run_task_links newer
      WHERE newer.run_id=run_task_links.run_id AND newer.role='primary' AND newer.valid_to IS NULL
        AND (newer.valid_from>run_task_links.valid_from OR
          (newer.valid_from=run_task_links.valid_from AND newer.rowid>run_task_links.rowid))
      ORDER BY newer.valid_from, newer.rowid LIMIT 1
    )
    WHERE role='primary' AND valid_to IS NULL AND EXISTS (
      SELECT 1 FROM run_task_links newer
      WHERE newer.run_id=run_task_links.run_id AND newer.role='primary' AND newer.valid_to IS NULL
        AND (newer.valid_from>run_task_links.valid_from OR
          (newer.valid_from=run_task_links.valid_from AND newer.rowid>run_task_links.rowid))
    )
  `);
}

function ensureOneActivePrimaryLinkIndex(db) {
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_run_task_links_one_active_primary
    ON run_task_links(run_id) WHERE role='primary' AND valid_to IS NULL`);
}

// FOC-104 one-shot backfill: re-key worktree_id on path only. Previously
// worktree_id was hash(repositoryId:cwd); rows stored under the old formula
// must be rewritten to hash(path) so their FK references in
// workspace_observations stay valid after the formula change. Idempotent and
// guarded by the SCHEMA_VERSION marker so it runs exactly once per database.
function backfillWorktreeIds(db) {
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(SCHEMA_VERSION)) return 0;
  const rows = db.prepare("SELECT worktree_id, path FROM worktrees").all();
  if (rows.length === 0) return 0;
  // workspace_observations.worktree_id → worktrees.worktree_id has no
  // ON UPDATE CASCADE, so we re-point observations first then the PK. With FK
  // enforcement ON that intermediate state fails the constraint, so disable
  // FK for this migration only (pragma must be set outside a transaction).
  db.exec("PRAGMA foreign_keys = OFF");
  let updated = 0;
  try {
    const updateObs = db.prepare("UPDATE workspace_observations SET worktree_id=? WHERE worktree_id=?");
    const updateWt = db.prepare("UPDATE worktrees SET worktree_id=? WHERE worktree_id=?");
    db.exec("BEGIN");
    for (const row of rows) {
      const newId = hash(row.path);
      if (newId === row.worktree_id) continue;
      updateObs.run(newId, row.worktree_id);
      updateWt.run(newId, row.worktree_id);
      updated++;
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
  return updated;
}

// Order matters: base schema before column adds (ALTER needs the table to
// exist); columns before the price-set backfill (it writes price_set_id);
// superseded-links cleanup before the unique index (the index would reject
// the very rows that cleanup fixes); worktree_id rekey before the schema
// marker so the one-shot guard fires correctly.
export function migrate(db) {
  createBaseSchema(db);
  addRunColumns(db);
  backfillPriceSetId(db);
  closeSupersededPrimaryLinks(db);
  ensureOneActivePrimaryLinkIndex(db);
  backfillWorktreeIds(db);
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(SCHEMA_VERSION, now());
}

export function makeEvent(eventType, payload, options = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    eventId: options.eventId || randomUUID(),
    eventType,
    runId: options.runId || payload?.runId || null,
    observedAt: options.observedAt || payload?.observedAt || now(),
    hostId: options.hostId || process.env.LA_TELEMETRY_HOST_ID || process.env.COMPUTERNAME || "local",
    source: {
      kind: options.sourceKind || "runtime",
      path: options.sourcePath || null,
      offset: Number.isInteger(options.sourceOffset) ? options.sourceOffset : null,
    },
    payload: payload || {},
  };
}

function spoolPending(event) {
  const { pending } = spoolPaths();
  const path = join(pending, `${event.eventId}.${process.pid}.${randomUUID()}.json`);
  atomicJson(path, event);
  return path;
}

function archiveEvent(event, pendingPath) {
  const { archive } = spoolPaths();
  const day = (event.observedAt || now()).slice(0, 7);
  const destination = join(archive, day, `${event.eventId}.json`);
  ensureParent(destination);
  if (!existsSync(pendingPath)) return destination;
  if (existsSync(destination)) {
    rmSync(pendingPath, { force: true });
    return destination;
  }
  renameSync(pendingPath, destination);
  return destination;
}

function transaction(db, fn) {
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

export function emitEvent(event, options = {}) {
  const pendingPath = spoolPending(event);
  let db;
  try {
    db = openTelemetryDb(options.dbPath);
    const result = transaction(db, () => applyEvent(db, event));
    if (result?.duplicate) {
      rmSync(pendingPath, { force: true });
      return { ingested: false, pending: false, duplicate: true, result };
    }
    archiveEvent(event, pendingPath);
    return { ingested: true, pending: false, result };
  } catch (error) {
    return { ingested: false, pending: true, error: error.message, pendingPath };
  } finally {
    db?.close();
  }
}

export function applyEvents(db, events) {
  return transaction(db, () => events.map((event) => applyEvent(db, event)));
}

function acquireReplayLock(lockPath) {
  try {
    mkdirSync(lockPath);
    return true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    try {
      if (Date.now() - statSync(lockPath).mtimeMs <= 5 * 60 * 1000) return false;
      rmSync(lockPath, { recursive: true, force: true });
      mkdirSync(lockPath);
      return true;
    } catch {
      return false;
    }
  }
}

export function replayPending(options = {}) {
  const { pending } = spoolPaths();
  if (!existsSync(pending)) return { scanned: 0, ingested: 0, failed: 0 };
  const lockPath = `${pending}.replay-lock`;
  if (!acquireReplayLock(lockPath)) return { scanned: 0, ingested: 0, failed: 0, locked: true };
  const summary = { scanned: 0, ingested: 0, failed: 0, locked: false };
  try {
    for (const file of readdirSync(pending).filter((name) => name.endsWith(".json"))) {
      summary.scanned++;
      const path = join(pending, file);
      try {
        const event = JSON.parse(readFileSync(path, "utf8"));
        const db = openTelemetryDb(options.dbPath);
        try { transaction(db, () => applyEvent(db, event)); } finally { db.close(); }
        archiveEvent(event, path);
        summary.ingested++;
      } catch (error) {
        console.error(`[telemetry] Failed to replay ${file}: ${error.message}`);
        summary.failed++;
      }
    }
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
  return summary;
}

function eventAlreadyApplied(db, event) {
  if (db.prepare("SELECT 1 FROM events WHERE event_id = ?").get(event.eventId)) return true;
  const source = event.source || {};
  if (source.path && Number.isInteger(source.offset)) {
    return Boolean(db.prepare(
      "SELECT 1 FROM events WHERE event_type = ? AND source_kind = ? AND source_path = ? AND source_offset = ?",
    ).get(event.eventType, source.kind || "runtime", source.path, source.offset));
  }
  return false;
}

export function applyEvent(db, event) {
  if (!event?.eventId || !event?.eventType) throw new Error("invalid telemetry event");
  if (eventAlreadyApplied(db, event)) return { duplicate: true };
  const source = event.source || {};
  db.prepare(
    `INSERT INTO events (event_id, event_type, run_id, observed_at, host_id, source_kind, source_path, source_offset, payload_json, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.eventId, event.eventType, event.runId || null, event.observedAt || now(), event.hostId || "local",
    source.kind || "runtime", source.path || null, Number.isInteger(source.offset) ? source.offset : null,
    safeJson(event.payload), now(),
  );

  switch (event.eventType) {
    case "run.started": return applyRunStarted(db, event);
    case "run.ended": return applyRunEnded(db, event);
    case "session.linked": return applySessionLinked(db, event);
    case "workspace.observed": return applyWorkspaceObserved(db, event);
    case "task.linked": return applyTaskLinked(db, event);
    case "usage.recorded": return applyUsageRecorded(db, event);
    case "transcript.progress": return applyTranscriptProgress(db, event);
    case "quality.reported": return applyQualityReported(db, event);
    default: return { ignored: true };
  }
}

function statusFor(run) {
  if (!run.endedAt) return "running";
  return Number(run.exitCode) === 0 || run.exitCode == null ? "completed" : "failed";
}

function applyRunStarted(db, event) {
  const run = event.payload;
  const runId = event.runId || run.runId;
  if (!runId) throw new Error("run.started requires runId");
  const priceSet = ensurePriceSet(db);
  db.prepare(
    `INSERT INTO runs (run_id, squad, source, brief, started_at, status, native, interactive, launch_cwd, claude_config_dir, price_set_id, console_pid, window_title, launched_by, updated_at)
     VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id) DO UPDATE SET squad=excluded.squad, source=excluded.source, brief=excluded.brief,
       started_at=COALESCE(runs.started_at, excluded.started_at), native=excluded.native,
       interactive=excluded.interactive, launch_cwd=excluded.launch_cwd,
       claude_config_dir=COALESCE(excluded.claude_config_dir, runs.claude_config_dir),
       price_set_id=COALESCE(runs.price_set_id, excluded.price_set_id),
       console_pid=COALESCE(excluded.console_pid, runs.console_pid),
       window_title=COALESCE(excluded.window_title, runs.window_title),
       launched_by=COALESCE(excluded.launched_by, runs.launched_by), updated_at=excluded.updated_at`,
  ).run(runId, run.squad || null, run.source || null, run.brief || null, run.startedAt || event.observedAt,
    run.native ? 1 : 0, run.interactive === false ? 0 : 1, run.cwd || null, run.claudeConfigDir || null, priceSet.id,
    Number.isInteger(run.consolePid) ? run.consolePid : null, run.windowTitle || null, run.launchedBy || null, now());
  return { runId };
}

function applyRunEnded(db, event) {
  const run = event.payload;
  const runId = event.runId || run.runId;
  if (!runId) throw new Error("run.ended requires runId");
  applyRunStarted(db, { ...event, eventType: "run.started" });
  db.prepare(
    `UPDATE runs SET ended_at=?, status=?, exit_code=?, claude_config_dir=COALESCE(?, claude_config_dir),
       transcript_path=COALESCE(?, transcript_path), session_id=COALESCE(?, session_id), updated_at=? WHERE run_id=?`,
  ).run(run.endedAt || event.observedAt, statusFor(run), nullableNumber(run.exitCode), run.claudeConfigDir || null,
    run.transcriptPath || null, run.sessionId || null, now(), runId);
  if (run.sessionId) applySessionLinked(db, { ...event, eventType: "session.linked", payload: run, runId });
  return { runId };
}

function applySessionLinked(db, event) {
  const payload = event.payload;
  const runId = event.runId || payload.runId;
  const sessionId = payload.sessionId || event.sessionId;
  if (!runId || !sessionId) throw new Error("session.linked requires runId and sessionId");
  db.prepare("INSERT OR IGNORE INTO runs (run_id, status, updated_at) VALUES (?, 'running', ?)").run(runId, now());
  db.prepare(
    `INSERT INTO sessions (session_id, first_seen_at, transcript_path, metadata_json)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET transcript_path=COALESCE(excluded.transcript_path, sessions.transcript_path), metadata_json=excluded.metadata_json`,
  ).run(sessionId, event.observedAt || now(), payload.transcriptPath || null, safeJson(payload.metadata));
  db.prepare("INSERT OR IGNORE INTO run_sessions (run_id, session_id, linked_at, source) VALUES (?, ?, ?, ?)")
    .run(runId, sessionId, event.observedAt || now(), payload.source || event.source?.kind || "runtime");
  db.prepare("UPDATE runs SET session_id=?, transcript_path=COALESCE(?, transcript_path), updated_at=? WHERE run_id=?")
    .run(sessionId, payload.transcriptPath || null, now(), runId);
  return { runId, sessionId };
}

function gitFacts(cwd) {
  if (!cwd || !existsSync(cwd)) return { cwd, refType: "unknown", refName: null, headSha: null, commonDir: null, gitDir: null, remoteUrl: null };
  const run = (args) => {
    try { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null; } catch { return null; }
  };
  const refName = run(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const headSha = run(["rev-parse", "HEAD"]);
  const commonDirRaw = run(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const gitDir = run(["rev-parse", "--path-format=absolute", "--git-dir"]);
  const remoteUrl = run(["remote", "get-url", "origin"]);
  return { cwd, refType: refName ? "branch" : headSha ? "detached" : "unknown", refName, headSha, commonDir: commonDirRaw ? normalizePath(commonDirRaw) : null, gitDir: gitDir ? normalizePath(gitDir) : null, remoteUrl };
}

function applyWorkspaceObserved(db, event) {
  const payload = event.payload;
  const runId = event.runId || payload.runId;
  if (!runId) throw new Error("workspace.observed requires runId");
  db.prepare("INSERT OR IGNORE INTO runs (run_id, status, updated_at) VALUES (?, 'running', ?)").run(runId, now());
  const facts = { ...gitFacts(payload.cwd), ...payload };
  let repositoryId = null;
  let worktreeId = null;
  const cwd = normalizePath(facts.cwd);
  if (facts.commonDir) {
    repositoryId = hash(facts.commonDir);
    db.prepare(
      `INSERT INTO repositories (repository_id, common_dir, remote_url, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(common_dir) DO UPDATE SET remote_url=COALESCE(excluded.remote_url, repositories.remote_url)`,
    ).run(repositoryId, facts.commonDir, facts.remoteUrl || null, now());
  }
  if (cwd) {
    // FOC-104: key worktree_id on cwd only (matches UNIQUE(path) semantics).
    // Previously `hash(`${repositoryId || "unknown"}:${cwd}`)` coupled the id
    // to repositoryId. When a path transitioned from "not a git repo"
    // (repositoryId=null) to "is a git repo" (repositoryId=hash(commonDir))
    // between sessions, the ON CONFLICT(path) DO UPDATE clause above
    // preserved the OLD worktree_id while this code computed a NEW one — the
    // next INSERT INTO workspace_observations then failed the FK on the new
    // id, rolling back the entire applyEvents txn and silently dropping every
    // usage.recorded event in the batch.
    worktreeId = hash(cwd);
    db.prepare(
      `INSERT INTO worktrees (worktree_id, repository_id, path, git_dir, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET repository_id=COALESCE(excluded.repository_id, worktrees.repository_id), git_dir=COALESCE(excluded.git_dir, worktrees.git_dir)`,
    ).run(worktreeId, repositoryId, cwd, facts.gitDir || null, now());
  }
  const observedAt = event.observedAt || now();
  const refType = facts.refType || "unknown";
  const refName = facts.refName || null;
  const headSha = facts.headSha || null;
  const existing = db.prepare(
    `SELECT 1 FROM workspace_observations
     WHERE run_id=? AND observed_at=? AND cwd IS ? AND ref_type=? AND ref_name IS ? AND head_sha IS ?`,
  ).get(runId, observedAt, cwd, refType, refName, headSha);
  if (existing) return { duplicate: true, runId, repositoryId, worktreeId };
  db.prepare(
    `INSERT OR IGNORE INTO workspace_observations (run_id, observed_at, cwd, repository_id, worktree_id, ref_type, ref_name, head_sha, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(runId, observedAt, cwd, repositoryId, worktreeId, refType, refName, headSha, payload.source || event.source?.kind || "runtime");
  return { runId, repositoryId, worktreeId };
}

function applyTaskLinked(db, event) {
  const payload = event.payload;
  const runId = event.runId || payload.runId;
  const taskId = normalizeTaskId(payload.taskId);
  if (!runId || !taskId) throw new Error("task.linked requires runId and taskId");
  const source = payload.source || "manual";
  const confidence = payload.confidence ?? (source === "launch" || source === "agent_pick" || source === "manual" ? 1 : 0.5);
  db.prepare("INSERT OR IGNORE INTO runs (run_id, status, updated_at) VALUES (?, 'running', ?)").run(runId, now());
  db.prepare("INSERT OR IGNORE INTO work_items (task_id, provider, workspace, identifier, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(taskId, payload.provider || "linear", payload.workspace || null, taskId, now());
  const active = db.prepare(
    "SELECT link_id, task_id, source, valid_from FROM run_task_links WHERE run_id=? AND role='primary' AND valid_to IS NULL ORDER BY valid_from DESC LIMIT 1",
  ).get(runId);
  // Manual link protection: automatic sources (branch, kickoff, agent_pick,
  // etc.) must not override a manual assignment. Manual→manual and
  // launch→manual still work (user correcting themselves, or explicit launch
  // from the dashboard). clearRunTask bypasses this entirely (direct SQL).
  if (payload.role !== "related" && active && active.source === "manual") {
    const isAutoSource = source !== "manual" && source !== "launch";
    if (isAutoSource) {
      return { ignored: true, reason: "manual link wins", runId, taskId };
    }
  }
  const validFrom = payload.validFrom || event.observedAt || now();
  if (payload.correctExisting && active?.task_id === taskId && active.source === source) {
    db.prepare(
      `UPDATE run_task_links SET valid_to=valid_from
       WHERE run_id=? AND role='primary' AND task_id=? AND source=?
         AND valid_from<? AND valid_to=?`,
    ).run(runId, taskId, source, validFrom, active.valid_from);
  }
  if (payload.role !== "related" && active?.task_id === taskId && active.source === source &&
      (!payload.correctExisting || active.valid_from === validFrom)) {
    return { duplicate: true, runId, taskId, linkId: active.link_id };
  }
  if (payload.role !== "related") {
    const closeAt = payload.correctExisting && active?.task_id === taskId && active.source === source
      ? active.valid_from
      : validFrom;
    db.prepare("UPDATE run_task_links SET valid_to=? WHERE run_id=? AND role='primary' AND valid_to IS NULL")
      .run(closeAt, runId);
  }
  const linkId = payload.linkId || randomUUID();
  db.prepare(
    `INSERT OR IGNORE INTO run_task_links (link_id, run_id, task_id, role, valid_from, valid_to, source, confidence, supersedes_link_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(linkId, runId, taskId, payload.role || "primary", validFrom, payload.validTo || null,
    source, confidence, payload.supersedesLinkId || null, now());
  return { runId, taskId, linkId };
}

function pricingSnapshot() {
  const source = readFileSync(join(root, "config", "models.json"), "utf8");
  const config = JSON.parse(source);
  return { id: hash(source), configHash: hash(source), prices: config.pricing || {} };
}

/**
 * Placeholder usage rows carry a sentinel instead of a real model id. It is written
 * as `<synthetic>` but every guard here checked for bare `synthetic`, so the guard
 * never fired: 16 zero-token rows were counted as unpriced and dragged
 * summary.costUSD to null — which is why the dashboard showed no total at all,
 * despite every real model being priced. Accept both spellings.
 */
const SYNTHETIC_MODELS = new Set(["synthetic", "<synthetic>"]);

export function isSyntheticModel(model) {
  return !model || SYNTHETIC_MODELS.has(model);
}

function resolvePrice(model, prices) {
  if (isSyntheticModel(model)) return null;
  if (prices[model]) return { key: model, price: prices[model] };
  const short = model.split("/").pop().replace(/\./g, "-");
  const exactShort = [];
  const contained = [];
  const containing = [];
  for (const [key, price] of Object.entries(prices)) {
    const keyShort = key.split("/").pop().replace(/\./g, "-");
    if (keyShort === short) exactShort.push({ key, price });
    else if (model.includes(key.split("/").pop())) contained.push({ key, price, length: keyShort.length });
    else if (key.split("/").pop().includes(model)) containing.push({ key, price });
  }
  if (exactShort.length === 1) return exactShort[0];
  if (contained.length > 0) return contained.sort((a, b) => b.length - a.length)[0];
  if (containing.length === 1) return containing[0];
  return null;
}

function ensurePriceSet(db) {
  const snapshot = pricingSnapshot();
  db.prepare("INSERT OR IGNORE INTO price_sets (price_set_id, config_hash, created_at, source) VALUES (?, ?, ?, 'config/models.json')")
    .run(snapshot.id, snapshot.configHash, now());
  const insert = db.prepare("INSERT OR IGNORE INTO model_prices (price_set_id, model_key, input_price, output_price, cache_read_price) VALUES (?, ?, ?, ?, ?)");
  for (const [key, price] of Object.entries(snapshot.prices)) {
    if (!Number.isFinite(price.input) || !Number.isFinite(price.output)) continue;
    insert.run(
      snapshot.id,
      key,
      nullableNumber(price.input),
      nullableNumber(price.output),
      nullableNumber(price.cacheRead),
    );
  }
  return snapshot;
}

function loadPriceSet(db, priceSetId) {
  const rows = db.prepare(
    "SELECT model_key, input_price, output_price, cache_read_price FROM model_prices WHERE price_set_id=?",
  ).all(priceSetId);
  return {
    id: priceSetId,
    prices: Object.fromEntries(rows.map((row) => [row.model_key, {
      input: row.input_price,
      output: row.output_price,
      cacheRead: row.cache_read_price,
    }])),
  };
}

function calculateCost(usage, model, prices) {
  const resolved = resolvePrice(model, prices);
  if (!resolved) return null;
  const price = resolved.price;
  if (!Number.isFinite(price.input) || !Number.isFinite(price.output)) return null;
  const cacheReadPrice = Number.isFinite(price.cacheRead) ? price.cacheRead : price.input * 0.1;
  const cost = ((usage.inputTokens || 0) * price.input + (usage.outputTokens || 0) * price.output +
    (usage.cacheReadTokens || 0) * cacheReadPrice + (usage.cacheCreationTokens || 0) * price.input) / 1_000_000;
  return Number.isFinite(cost) ? cost : null;
}

function raiseIssue(db, runId, issueType, severity, details) {
  const existing = db.prepare(
    "SELECT 1 FROM data_quality_issues WHERE run_id IS ? AND issue_type=? AND resolved_at IS NULL",
  ).get(runId, issueType);
  if (existing) return;
  db.prepare(
    `INSERT INTO data_quality_issues (issue_id, run_id, issue_type, severity, details_json, opened_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), runId, issueType, severity, safeJson(details), now());
}

function applyUsageRecorded(db, event) {
  const payload = event.payload;
  const runId = event.runId || payload.runId;
  if (!runId || !event.source?.path || !Number.isInteger(event.source.offset)) {
    throw new Error("usage.recorded requires runId and source path/offset");
  }
  db.prepare("INSERT OR IGNORE INTO runs (run_id, status, updated_at) VALUES (?, 'running', ?)").run(runId, now());
  const usageId = payload.usageId || hash(`${event.source.path}:${event.source.offset}`);
  const inserted = db.prepare(
    `INSERT OR IGNORE INTO usage_facts (usage_id, run_id, session_id, agent_key, model, observed_at, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, source_path, source_offset, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(usageId, runId, payload.sessionId || null, payload.agentKey || "_lead", payload.model || null,
    payload.observedAt || event.observedAt || null, payload.inputTokens || 0, payload.outputTokens || 0,
    payload.cacheReadTokens || 0, payload.cacheCreationTokens || 0, event.source.path, event.source.offset, now());
  if (inserted.changes === 0) return { duplicate: true, usageId };
  const run = db.prepare("SELECT price_set_id FROM runs WHERE run_id=?").get(runId);
  let snapshot;
  if (run?.price_set_id) {
    snapshot = loadPriceSet(db, run.price_set_id);
  } else {
    snapshot = ensurePriceSet(db);
    db.prepare("UPDATE runs SET price_set_id=? WHERE run_id=?").run(snapshot.id, runId);
  }
  const cost = calculateCost(payload, payload.model, snapshot.prices);
  if (cost == null && !isSyntheticModel(payload.model)) {
    raiseIssue(db, runId, "pricing_missing", "warning", { model: payload.model, usageId });
  }
  db.prepare("INSERT OR REPLACE INTO cost_facts (usage_id, price_set_id, cost_usd) VALUES (?, ?, ?)")
    .run(usageId, snapshot.id, cost);
  return { usageId, costUSD: cost };
}

function applyTranscriptProgress(db, event) {
  const payload = event.payload;
  if (!event.source?.path) throw new Error("transcript.progress requires source path");
  db.prepare(
    `INSERT INTO transcript_sources (source_path, session_id, run_id, byte_offset, file_size, modified_at, parse_status, last_error, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_path) DO UPDATE SET session_id=COALESCE(excluded.session_id, transcript_sources.session_id),
       run_id=COALESCE(excluded.run_id, transcript_sources.run_id),
       byte_offset=MAX(excluded.byte_offset, transcript_sources.byte_offset),
       file_size=MAX(excluded.file_size, transcript_sources.file_size),
       modified_at=CASE WHEN excluded.modified_at > transcript_sources.modified_at THEN excluded.modified_at ELSE transcript_sources.modified_at END,
       parse_status=excluded.parse_status, last_error=excluded.last_error, updated_at=excluded.updated_at`,
  ).run(event.source.path, payload.sessionId || null, event.runId || payload.runId || null, payload.byteOffset || 0,
    payload.fileSize || 0, payload.modifiedAt || null, payload.parseStatus || "parsed", payload.lastError || null, now());
  return { sourcePath: event.source.path };
}

function applyQualityReported(db, event) {
  const payload = event.payload;
  const runId = event.runId || payload.runId || null;
  if (!payload.issueType) throw new Error("quality.reported requires issueType");
  raiseIssue(db, runId, payload.issueType, payload.severity || "warning", payload.details || {});
  return { runId, issueType: payload.issueType };
}

export function recordManifest(manifest, phase, options = {}) {
  const eventType = phase === "ended" ? "run.ended" : "run.started";
  const result = emitEvent(makeEvent(eventType, manifest, {
    runId: manifest.runId,
    observedAt: phase === "ended" ? manifest.endedAt : manifest.startedAt,
    sourceKind: "manifest",
    sourcePath: options.sourcePath || null,
    sourceOffset: phase === "ended" ? 1 : 0,
  }), options);
  if (phase !== "ended" && manifest.cwd) {
    const refType = manifest.gitRefType || (manifest.gitBranch === "HEAD" ? "detached" : manifest.gitBranch && manifest.gitBranch !== "unknown" ? "branch" : "unknown");
    emitEvent(makeEvent("workspace.observed", {
      runId: manifest.runId,
      cwd: manifest.cwd,
      refType,
      refName: refType === "branch" ? manifest.gitBranch : null,
      headSha: manifest.gitHeadSha ?? null,
      source: "manifest",
    }, {
      runId: manifest.runId, observedAt: phase === "ended" ? manifest.endedAt : manifest.startedAt,
      sourceKind: "manifest-workspace", sourcePath: options.sourcePath || null, sourceOffset: phase === "ended" ? 1 : 0,
    }), options);
  }
  if (phase !== "ended" && (manifest.taskId || manifest.taskIdAuto)) {
    emitEvent(makeEvent("task.linked", {
      runId: manifest.runId,
      taskId: manifest.taskId || manifest.taskIdAuto,
      source: manifest.taskId ? "launch" : "agent_pick",
      confidence: 1,
    }, {
      runId: manifest.runId,
      observedAt: manifest.startedAt,
      sourceKind: "manifest-task",
      sourcePath: options.sourcePath || null,
      sourceOffset: 2,
    }), options);
  }
  return result;
}

export function recordTaskLink(runId, taskId, source = "manual", options = {}) {
  return emitEvent(makeEvent("task.linked", {
    runId,
    taskId,
    source,
    confidence: options.confidence,
    validFrom: options.validFrom,
    correctExisting: options.correctExisting || false,
  }, {
    runId,
    observedAt: options.observedAt,
    sourceKind: options.sourceKind || "runtime",
    sourcePath: options.sourcePath || null,
    sourceOffset: options.sourceOffset,
  }), options);
}

export function getRunTaskLinks(db, runId) {
  const rows = db.prepare(
    `SELECT link_id, task_id, source, confidence, valid_from, valid_to
     FROM run_task_links WHERE run_id=? AND role='primary'
     ORDER BY valid_from DESC`,
  ).all(runId);
  const currentRow = rows.find((r) => r.valid_to == null) || null;
  const current = currentRow
    ? {
        taskId: currentRow.task_id,
        source: currentRow.source,
        confidence: currentRow.confidence,
        validFrom: currentRow.valid_from,
        linkId: currentRow.link_id,
      }
    : null;
  const history = rows.map((r) => ({
    taskId: r.task_id,
    source: r.source,
    confidence: r.confidence,
    validFrom: r.valid_from,
    validTo: r.valid_to,
    linkId: r.link_id,
  }));
  return { current, history };
}

export function clearRunTask(runId, options = {}) {
  const db = openTelemetryDb(options.dbPath);
  try {
    if (options.at != null) {
      // Explicit timestamp: close from that point (for running runs where
      // the operator wants to keep past usage on the task).
      const result = db.prepare(
        `UPDATE run_task_links SET valid_to=? WHERE run_id=? AND role='primary' AND valid_to IS NULL`,
      ).run(options.at, runId);
      return { closed: result.changes > 0, runId };
    }
    // Default: collapse to zero duration (valid_to = valid_from) so no usage
    // falls within the window — the run returns to untagged. Same pattern as
    // applyTaskLinked's correctExisting path.
    const result = db.prepare(
      `UPDATE run_task_links SET valid_to = valid_from
       WHERE run_id=? AND role='primary' AND valid_to IS NULL`,
    ).run(runId);
    return { closed: result.changes > 0, runId };
  } finally {
    db.close();
  }
}

export function recordSessionLink(runId, sessionId, payload = {}, options = {}) {
  return emitEvent(makeEvent("session.linked", { ...payload, runId, sessionId }, {
    runId, observedAt: options.observedAt, sourceKind: options.sourceKind || "hook",
  }), options);
}

export function recordWorkspace(runId, cwd, payload = {}, options = {}) {
  return emitEvent(makeEvent("workspace.observed", { ...payload, runId, cwd }, {
    runId, observedAt: options.observedAt, sourceKind: options.sourceKind || "runtime",
  }), options);
}

export function reportDataQuality(runId, issueType, details = {}, options = {}) {
  return emitEvent(makeEvent("quality.reported", { runId, issueType, details, severity: options.severity || "warning" }, {
    runId,
    observedAt: options.observedAt,
    sourceKind: options.sourceKind || "runtime",
  }), options);
}

function taskForTimestamp(db, runId, timestamp) {
  const at = timestamp || now();
  return db.prepare(
    `SELECT task_id FROM run_task_links WHERE run_id=? AND role='primary' AND valid_from<=?
      AND (valid_to IS NULL OR valid_to>?) ORDER BY confidence DESC, valid_from DESC LIMIT 1`,
  ).get(runId, at, at)?.task_id || null;
}

function statusRow(row) {
  if (row.ended_at) return row.status || (row.exit_code === 0 ? "completed" : "failed");
  return "running";
}

function repositoryName(workspace, launchCwd) {
  if (workspace?.common_dir) {
    const parts = workspace.common_dir.split("/").filter(Boolean);
    const last = parts.at(-1) || "";
    if (last === ".git") return parts.at(-2) || null;
    if (last.endsWith(".git")) return last.slice(0, -4) || null;
    return last || null;
  }
  return launchCwd?.split(/[\\/]/).filter(Boolean).pop() || null;
}

function makeRunProjection(db, row, options = {}) {
  const workspace = db.prepare(
    `SELECT o.*, w.path AS worktree_path, r.common_dir, r.remote_url FROM workspace_observations o
       LEFT JOIN worktrees w ON w.worktree_id=o.worktree_id LEFT JOIN repositories r ON r.repository_id=o.repository_id
      WHERE o.run_id=?
      ORDER BY CASE WHEN o.source = 'manifest' THEN 0 ELSE 1 END DESC,
        CASE WHEN o.ref_type = 'unknown' THEN 0 ELSE 1 END DESC,
        o.observed_at DESC, o.id DESC LIMIT 1`,
  ).get(row.run_id);
  const launch = db.prepare("SELECT * FROM workspace_observations WHERE run_id=? ORDER BY observed_at, id LIMIT 1").get(row.run_id);
  const task = taskForTimestamp(db, row.run_id, row.ended_at || now());
  const taskLink = db.prepare(
    `SELECT source, confidence FROM run_task_links WHERE run_id=? AND task_id=? ORDER BY valid_from DESC LIMIT 1`,
  ).get(row.run_id, task);
  const byModelRows = db.prepare(
    `SELECT u.model, SUM(u.input_tokens) AS input_tokens, SUM(u.output_tokens) AS output_tokens,
       SUM(u.cache_read_tokens) AS cache_read_tokens, SUM(u.cache_creation_tokens) AS cache_creation_tokens,
       SUM(CASE WHEN c.cost_usd IS NOT NULL THEN c.cost_usd ELSE 0 END) AS cost_usd,
       SUM(CASE WHEN c.cost_usd IS NULL AND u.model IS NOT NULL AND u.model NOT IN ('synthetic','<synthetic>') THEN 1 ELSE 0 END) AS unpriced
       FROM usage_facts u LEFT JOIN cost_facts c ON c.usage_id=u.usage_id
       WHERE u.run_id=? GROUP BY u.model`,
  ).all(row.run_id);
  const byAgentRows = db.prepare(
    `SELECT u.agent_key, SUM(u.input_tokens) AS input_tokens, SUM(u.output_tokens) AS output_tokens,
       SUM(u.cache_read_tokens) AS cache_read_tokens, SUM(u.cache_creation_tokens) AS cache_creation_tokens,
      SUM(CASE WHEN c.cost_usd IS NOT NULL THEN c.cost_usd ELSE 0 END) AS cost_usd,
      SUM(CASE WHEN c.cost_usd IS NULL AND u.model IS NOT NULL AND u.model NOT IN ('synthetic','<synthetic>') THEN 1 ELSE 0 END) AS unpriced,
      COUNT(*) AS turns,
       MAX(u.observed_at) AS last_activity_at FROM usage_facts u LEFT JOIN cost_facts c ON c.usage_id=u.usage_id
       WHERE u.run_id=? GROUP BY u.agent_key`,
  ).all(row.run_id);
  const totals = db.prepare(
    `SELECT COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens,
       COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens, COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
       COALESCE(SUM(CASE WHEN c.cost_usd IS NOT NULL THEN c.cost_usd ELSE 0 END), 0) AS cost_usd,
       SUM(CASE WHEN c.cost_usd IS NULL AND u.model IS NOT NULL AND u.model NOT IN ('synthetic','<synthetic>') THEN 1 ELSE 0 END) AS unpriced,
       MAX(u.observed_at) AS last_activity_at FROM usage_facts u LEFT JOIN cost_facts c ON c.usage_id=u.usage_id WHERE u.run_id=?`,
  ).get(row.run_id);
  const byModel = {};
  for (const item of byModelRows) {
    byModel[item.model || "unknown"] = {
      inputTokens: item.input_tokens, outputTokens: item.output_tokens, cacheReadInputTokens: item.cache_read_tokens,
      cacheCreationInputTokens: item.cache_creation_tokens,
      costUSD: item.unpriced ? null : item.cost_usd,
      partialCostUSD: item.cost_usd,
      unpricedUsageCount: item.unpriced || 0,
      cacheSavingsUSD: 0,
    };
  }
  // Compute cache savings per model from the run's price set
  let totalCacheSavings = 0;
  if (row.price_set_id) {
    const priceSet = loadPriceSet(db, row.price_set_id);
    for (const item of byModelRows) {
      const model = item.model;
      if (isSyntheticModel(model)) continue;
      const resolved = resolvePrice(model, priceSet.prices);
      if (!resolved) continue;
      const price = resolved.price;
      if (!Number.isFinite(price.input)) continue;
      const cacheReadPrice = Number.isFinite(price.cacheRead) ? price.cacheRead : price.input * 0.1;
      const savings = (item.cache_read_tokens / 1_000_000) * (price.input - cacheReadPrice);
      if (savings > 0) {
        totalCacheSavings += savings;
        if (byModel[model]) byModel[model].cacheSavingsUSD = savings;
      }
    }
  }
  const byAgent = {};
  for (const item of byAgentRows) {
    const models = db.prepare("SELECT DISTINCT model FROM usage_facts WHERE run_id=? AND agent_key=? AND model IS NOT NULL").all(row.run_id, item.agent_key);
    byAgent[item.agent_key] = {
      inputTokens: item.input_tokens, outputTokens: item.output_tokens, cacheReadInputTokens: item.cache_read_tokens,
      cacheCreationInputTokens: item.cache_creation_tokens,
      costUSD: item.unpriced ? null : item.cost_usd,
      partialCostUSD: item.cost_usd,
      unpricedUsageCount: item.unpriced || 0,
      turns: item.turns,
      models: Object.fromEntries(models.map((model) => [model.model, 1])),
    };
  }
  const issues = db.prepare("SELECT issue_type, severity, details_json, opened_at FROM data_quality_issues WHERE run_id=? AND resolved_at IS NULL ORDER BY opened_at").all(row.run_id)
    .map((issue) => ({ type: issue.issue_type, severity: issue.severity, details: parseJson(issue.details_json, {}), openedAt: issue.opened_at }));
  const ambiguous = issues.some((issue) => issue.type === "legacy_session_ambiguous");
  return {
    runId: row.run_id, squad: row.squad, source: row.source, brief: row.brief, startedAt: row.started_at, endedAt: row.ended_at,
    status: statusRow(row), cwd: workspace?.cwd || row.launch_cwd || null,
    repo: repositoryName(workspace, row.launch_cwd),
    gitBranch: workspace?.ref_type === "branch" ? workspace.ref_name : null,
    gitRef: { type: workspace?.ref_type || "unknown", name: workspace?.ref_name || null, headSha: workspace?.head_sha || null },
    repository: workspace?.common_dir || null, worktreePath: workspace?.worktree_path || null,
    launchWorkspace: launch ? { cwd: launch.cwd, refType: launch.ref_type, refName: launch.ref_name, headSha: launch.head_sha } : null,
    exitCode: row.exit_code, native: Boolean(row.native), sessionId: row.session_id, transcriptPath: row.transcript_path,
    consolePid: row.console_pid ?? null, windowTitle: row.window_title || null, launchedBy: row.launched_by || null,
    claudeConfigDir: row.claude_config_dir, taskId: task, taskIdExplicit: taskLink?.confidence === 1 ? task : null,
    taskAttribution: task ? { source: taskLink?.source || "unknown", confidence: taskLink?.confidence ?? 0 } : null,
    lastActivityAt: totals.last_activity_at || null, ambiguous,
    totals: {
      inputTokens: totals.input_tokens, outputTokens: totals.output_tokens, cacheReadTokens: totals.cache_read_tokens,
      cacheReadInputTokens: totals.cache_read_tokens, cacheCreationInputTokens: totals.cache_creation_tokens,
      costUSD: totals.unpriced ? null : totals.cost_usd, partialCostUSD: totals.cost_usd,
      unpricedUsageCount: totals.unpriced || 0, cacheSavingsUSD: totalCacheSavings,
    },
    byModel, byAgent, dataQuality: issues,
  };
}

function repriceCurrent(db, runs) {
  const prices = pricingSnapshot().prices;
  const byRun = new Map(runs.map((run) => [run.runId, run]));
  for (const run of runs) {
    run.totals.costUSD = 0;
    run.totals.partialCostUSD = 0;
    run.totals.unpricedUsageCount = 0;
    run.totals.cacheSavingsUSD = 0;
    for (const values of Object.values(run.byModel)) {
      values.costUSD = 0;
      values.partialCostUSD = 0;
      values.unpricedUsageCount = 0;
      values.cacheSavingsUSD = 0;
    }
    for (const values of Object.values(run.byAgent)) {
      values.costUSD = 0;
      values.partialCostUSD = 0;
      values.unpricedUsageCount = 0;
    }
  }
  const usage = db.prepare(
    `SELECT run_id, agent_key, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens
     FROM usage_facts`,
  ).all();
  for (const item of usage) {
    const run = byRun.get(item.run_id);
    if (!run) continue;
    const modelKey = item.model || "unknown";
    const cost = calculateCost({
      inputTokens: item.input_tokens, outputTokens: item.output_tokens,
      cacheReadTokens: item.cache_read_tokens, cacheCreationTokens: item.cache_creation_tokens,
    }, item.model, prices);
    if (cost == null && !isSyntheticModel(item.model)) {
      run.totals.unpricedUsageCount++;
      if (run.byModel[modelKey]) run.byModel[modelKey].unpricedUsageCount++;
      if (run.byAgent[item.agent_key]) run.byAgent[item.agent_key].unpricedUsageCount++;
      continue;
    }
    const value = cost || 0;
    run.totals.partialCostUSD += value;
    if (run.byModel[modelKey]) {
      run.byModel[modelKey].costUSD += value;
      run.byModel[modelKey].partialCostUSD += value;
    }
    if (run.byAgent[item.agent_key]) {
      run.byAgent[item.agent_key].costUSD += value;
      run.byAgent[item.agent_key].partialCostUSD += value;
    }
    // Compute cache savings for this usage item
    if (item.cache_read_tokens > 0 && !isSyntheticModel(item.model)) {
      const resolved = resolvePrice(item.model, prices);
      if (resolved) {
        const price = resolved.price;
        if (Number.isFinite(price.input)) {
          const cacheReadPrice = Number.isFinite(price.cacheRead) ? price.cacheRead : price.input * 0.1;
          const savings = (item.cache_read_tokens / 1_000_000) * (price.input - cacheReadPrice);
          if (savings > 0) {
            run.totals.cacheSavingsUSD += savings;
            if (run.byModel[modelKey]) run.byModel[modelKey].cacheSavingsUSD += savings;
          }
        }
      }
    }
  }
  for (const run of runs) {
    run.totals.costUSD = run.totals.unpricedUsageCount ? null : run.totals.partialCostUSD;
    for (const values of Object.values(run.byModel)) {
      if (values.unpricedUsageCount) values.costUSD = null;
    }
    for (const values of Object.values(run.byAgent)) {
      if (values.unpricedUsageCount) values.costUSD = null;
    }
  }
  return runs;
}

export function queryRuns(db, options = {}) {
  const where = options.runId ? "WHERE run_id=?" : "";
  const rows = db.prepare(`SELECT * FROM runs ${where} ORDER BY started_at DESC`).all(...(options.runId ? [options.runId] : []));
  const runs = rows.map((row) => makeRunProjection(db, row, options));
  return options.priceMode === "current" ? repriceCurrent(db, runs) : runs;
}

function aggregateUsageByTask(db, priceMode) {
  const rows = db.prepare(
    `SELECT u.run_id, u.model, u.observed_at, u.input_tokens, u.output_tokens,
       u.cache_read_tokens, u.cache_creation_tokens, r.squad, r.started_at, r.ended_at,
       c.cost_usd,
       (SELECT l.task_id FROM run_task_links l
        WHERE l.run_id=u.run_id AND l.role='primary'
          AND l.valid_from<=COALESCE(u.observed_at, r.started_at)
          AND (l.valid_to IS NULL OR l.valid_to>COALESCE(u.observed_at, r.started_at))
        ORDER BY l.confidence DESC, l.valid_from DESC LIMIT 1) AS task_id
     FROM usage_facts u
     JOIN runs r ON r.run_id=u.run_id
     LEFT JOIN cost_facts c ON c.usage_id=u.usage_id AND c.price_set_id=r.price_set_id`,
  ).all();
  const currentPrices = priceMode === "current" ? pricingSnapshot().prices : null;
  const buckets = {};
  for (const row of rows) {
    const key = row.task_id || "__untagged__";
    const bucket = buckets[key] ||= {
      runs: 0, costUSD: 0, partialCostUSD: 0, unpricedUsageCount: 0,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationInputTokens: 0,
      firstStartedAt: null, lastEndedAt: null, squads: {}, _runs: new Set(), _running: false,
    };
    const cost = currentPrices
      ? calculateCost({
          inputTokens: row.input_tokens, outputTokens: row.output_tokens,
          cacheReadTokens: row.cache_read_tokens, cacheCreationTokens: row.cache_creation_tokens,
        }, row.model, currentPrices)
      : row.cost_usd;
    bucket.inputTokens += row.input_tokens;
    bucket.outputTokens += row.output_tokens;
    bucket.cacheReadTokens += row.cache_read_tokens;
    bucket.cacheCreationInputTokens += row.cache_creation_tokens;
    if (cost == null && !isSyntheticModel(row.model)) bucket.unpricedUsageCount++;
    else bucket.partialCostUSD += cost || 0;
    bucket._runs.add(row.run_id);
    if (!bucket.firstStartedAt || row.started_at < bucket.firstStartedAt) bucket.firstStartedAt = row.started_at;
    if (row.ended_at == null) bucket._running = true;
    else if (!bucket.lastEndedAt || row.ended_at > bucket.lastEndedAt) bucket.lastEndedAt = row.ended_at;
    const squad = row.squad || "unknown";
    const squadBucket = bucket.squads[squad] ||= { runs: 0, costUSD: 0, _runs: new Set() };
    squadBucket._runs.add(row.run_id);
    squadBucket.costUSD += cost || 0;
  }
  for (const bucket of Object.values(buckets)) {
    bucket.runs = bucket._runs.size;
    bucket.costUSD = bucket.unpricedUsageCount ? null : bucket.partialCostUSD;
    if (bucket._running) bucket.lastEndedAt = null;
    delete bucket._runs;
    delete bucket._running;
    for (const squad of Object.values(bucket.squads)) {
      squad.runs = squad._runs.size;
      delete squad._runs;
    }
  }
  return buckets;
}

export function querySummary(db, options = {}) {
  const runs = queryRuns(db, options);
  const totals = { runs: 0, inputTokens: 0, outputTokens: 0, costUSD: 0, partialCostUSD: 0, cacheSavingsUSD: 0, cacheReadTokens: 0, unpricedUsageCount: 0 };
  const bySquad = {}; const byModel = {}; const byDay = {}; const byRepo = {};
  for (const run of runs) {
    const t = run.totals; totals.runs++; totals.inputTokens += t.inputTokens; totals.outputTokens += t.outputTokens;
    totals.cacheReadTokens += t.cacheReadTokens; totals.partialCostUSD += t.partialCostUSD || 0; totals.unpricedUsageCount += t.unpricedUsageCount || 0;
    totals.cacheSavingsUSD += t.cacheSavingsUSD || 0;
    const add = (bucket, key, fields) => {
      bucket[key] ||= { runs: 0, costUSD: 0, partialCostUSD: 0, unpricedUsageCount: 0, tokens: 0 };
      bucket[key].runs++;
      bucket[key].partialCostUSD += fields.cost || 0;
      bucket[key].unpricedUsageCount += fields.unpriced || 0;
      bucket[key].tokens += fields.tokens || 0;
    };
    add(bySquad, run.squad || "unknown", { cost: t.partialCostUSD, unpriced: t.unpricedUsageCount, tokens: t.inputTokens + t.outputTokens });
    add(byRepo, run.repo || "unknown", { cost: t.partialCostUSD, unpriced: t.unpricedUsageCount, tokens: t.inputTokens + t.outputTokens });
    const day = (run.startedAt || "").slice(0, 10); if (day) add(byDay, day, { cost: t.partialCostUSD, unpriced: t.unpricedUsageCount });
    for (const [model, values] of Object.entries(run.byModel)) {
      byModel[model] ||= { tokens: 0, costUSD: 0, partialCostUSD: 0, unpricedUsageCount: 0 };
      byModel[model].tokens += values.inputTokens + values.outputTokens;
      byModel[model].partialCostUSD += values.partialCostUSD ?? values.costUSD ?? 0;
      byModel[model].unpricedUsageCount += values.unpricedUsageCount || 0;
    }
  }
  totals.costUSD = totals.unpricedUsageCount ? null : totals.partialCostUSD;
  for (const bucket of [...Object.values(bySquad), ...Object.values(byRepo), ...Object.values(byDay)]) {
    bucket.costUSD = bucket.unpricedUsageCount ? null : bucket.partialCostUSD;
  }
  for (const model of Object.values(byModel)) {
    model.costUSD = model.unpricedUsageCount ? null : model.partialCostUSD;
  }
  const byTask = aggregateUsageByTask(db, options.priceMode);
  const cacheHitRate = totals.cacheReadTokens + totals.inputTokens > 0 ? totals.cacheReadTokens / (totals.cacheReadTokens + totals.inputTokens) * 100 : 0;
  return { totals, bySquad, byModel, byDay, byRepo, byTask, cacheHitRate };
}

export function queryHealth(db) {
  const pending = spoolPaths().pending;
  const pendingCount = existsSync(pending) ? readdirSync(pending).filter((name) => name.endsWith(".json")).length : 0;
  const issues = db.prepare("SELECT issue_type AS type, severity, COUNT(*) AS count FROM data_quality_issues WHERE resolved_at IS NULL GROUP BY issue_type, severity ORDER BY count DESC").all();
  const running = db.prepare("SELECT COUNT(*) AS count FROM runs WHERE ended_at IS NULL").get().count;
  return { database: telemetryDbPath(), schemaVersion: SCHEMA_VERSION, pendingEvents: pendingCount, runningRuns: running, issues };
}

export function queryTrace(db, taskId) {
  const runRows = db.prepare(
    `SELECT DISTINCT r.* FROM runs r JOIN run_task_links l ON l.run_id=r.run_id
     WHERE l.task_id=? ORDER BY r.started_at`,
  ).all(normalizeTaskId(taskId));
  const steps = db.prepare(
    `SELECT u.agent_key AS agent, COUNT(*) AS turns,
       SUM(CASE WHEN c.cost_usd IS NOT NULL THEN c.cost_usd ELSE 0 END) AS cost,
       MIN(u.observed_at) AS first_ts, MAX(u.observed_at) AS last_ts
     FROM usage_facts u JOIN runs r ON r.run_id=u.run_id
     LEFT JOIN cost_facts c ON c.usage_id=u.usage_id AND c.price_set_id=r.price_set_id
     WHERE u.run_id=? AND
       (SELECT l.task_id FROM run_task_links l WHERE l.run_id=u.run_id AND l.role='primary'
        AND l.valid_from<=COALESCE(u.observed_at, r.started_at)
        AND (l.valid_to IS NULL OR l.valid_to>COALESCE(u.observed_at, r.started_at))
        ORDER BY l.confidence DESC, l.valid_from DESC LIMIT 1)=?
     GROUP BY u.agent_key ORDER BY MIN(u.observed_at)`,
  );
  const normalized = normalizeTaskId(taskId);
  const chain = runRows.map((row) => ({
    runId: row.run_id,
    squad: row.squad,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    status: statusRow(row),
    costUSD: steps.all(row.run_id, normalized).reduce((sum, step) => sum + (step.cost || 0), 0),
    steps: steps.all(row.run_id, normalized).map((step) => ({
      agent: step.agent,
      turns: step.turns,
      costUSD: step.cost,
      firstTs: step.first_ts,
      lastTs: step.last_ts,
    })),
  }));
  let bounces = 0;
  let lastReviewStart = null;
  const repeats = {};
  for (const run of chain) {
    repeats[run.squad] = (repeats[run.squad] || 0) + 1;
    if (run.squad === "review") lastReviewStart = run.startedAt;
    if (run.squad === "dev" && lastReviewStart && run.startedAt > lastReviewStart) bounces++;
  }
  return {
    taskId: normalized,
    runs: chain,
    totalCostUSD: chain.reduce((sum, run) => sum + (run.costUSD || 0), 0),
    reviewDevBounces: bounces,
    squadRepeats: Object.fromEntries(Object.entries(repeats).filter(([, count]) => count > 1)),
  };
}

export function queryPatterns(db, filters = {}) {
  const where = [];
  const params = [];
  if (filters.squad) { where.push("r.squad=?"); params.push(filters.squad); }
  if (filters.agent) { where.push("u.agent_key=?"); params.push(filters.agent); }
  const rows = db.prepare(
    `SELECT u.run_id, r.squad, u.agent_key AS agent, u.observed_at,
       (SELECT l.task_id FROM run_task_links l WHERE l.run_id=u.run_id AND l.role='primary'
        AND l.valid_from<=COALESCE(u.observed_at, r.started_at)
        AND (l.valid_to IS NULL OR l.valid_to>COALESCE(u.observed_at, r.started_at))
        ORDER BY l.confidence DESC, l.valid_from DESC LIMIT 1) AS task_id,
       CASE WHEN c.cost_usd IS NOT NULL THEN c.cost_usd ELSE 0 END AS cost_usd
     FROM usage_facts u JOIN runs r ON r.run_id=u.run_id
     LEFT JOIN cost_facts c ON c.usage_id=u.usage_id AND c.price_set_id=r.price_set_id
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`,
  ).all(...params);
  const stats = new Map();
  const repeated = new Map();
  for (const row of rows) {
    const key = `${row.squad}\u0000${row.agent}`;
    const stat = stats.get(key) || { squad: row.squad, agent: row.agent, runs: new Map(), turns: 0, cost_usd: 0 };
    stat.turns++;
    stat.cost_usd += row.cost_usd || 0;
    stat.runs.set(row.run_id, (stat.runs.get(row.run_id) || 0) + 1);
    stats.set(key, stat);
    if (row.task_id) {
      const repeatKey = `${row.task_id}\u0000${row.squad}\u0000${row.agent}`;
      const runIds = repeated.get(repeatKey) || new Set();
      runIds.add(row.run_id);
      repeated.set(repeatKey, runIds);
    }
  }
  const stepStats = [...stats.values()].map((stat) => ({
    squad: stat.squad,
    agent: stat.agent,
    executions: stat.runs.size,
    turns: stat.turns,
    avg_turns_per_run: stat.runs.size ? stat.turns / stat.runs.size : 0,
    cost_usd: stat.cost_usd,
  })).sort((a, b) => `${a.squad}:${a.agent}`.localeCompare(`${b.squad}:${b.agent}`));
  const repeats = [...repeated.entries()].flatMap(([key, runIds]) => {
    if (runIds.size <= 1) return [];
    const [task_id, squad, agent] = key.split("\u0000");
    return [{ task_id, squad, agent, times: runIds.size }];
  }).sort((a, b) => b.times - a.times).slice(0, 50);
  const taskRuns = db.prepare(
    `SELECT DISTINCT l.task_id, r.squad, r.started_at FROM run_task_links l JOIN runs r ON r.run_id=l.run_id
     WHERE l.task_id IS NOT NULL ORDER BY l.task_id, r.started_at`,
  ).all();
  const bounceCounts = {};
  let currentTask = null;
  let reviewStart = null;
  for (const run of taskRuns) {
    if (run.task_id !== currentTask) { currentTask = run.task_id; reviewStart = null; }
    if (run.squad === "review") reviewStart = run.started_at;
    if (run.squad === "dev" && reviewStart && run.started_at > reviewStart) bounceCounts[currentTask] = (bounceCounts[currentTask] || 0) + 1;
  }
  const bounces = Object.entries(bounceCounts).map(([taskId, count]) => ({ taskId, bounces: count })).sort((a, b) => b.bounces - a.bounces);
  const failures = db.prepare(
    `SELECT squad, COUNT(*) AS runs, SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed
     FROM runs GROUP BY squad ORDER BY squad`,
  ).all();
  return { stepStats, repeats, bounces, failures };
}

export function exportTelemetry(db, format, destination) {
  ensureParent(destination);
  if (format === "sqlite") {
    if (normalizePath(destination) === normalizePath(telemetryDbPath())) {
      throw new Error("SQLite export destination must differ from the active telemetry database");
    }
    rmSync(destination, { force: true });
    const escaped = destination.replaceAll("'", "''");
    db.exec(`VACUUM INTO '${escaped}'`);
    return { format, destination };
  }
  const runs = queryRuns(db);
  if (format === "jsonl") {
    writeFileSync(destination, runs.map((run) => JSON.stringify(run)).join("\n") + "\n", "utf8");
    return { format, destination, rows: runs.length };
  }
  if (format === "csv") {
    const header = "runId,squad,taskId,startedAt,endedAt,status,repo,worktreePath,refType,refName,headSha,costUSD,unpricedUsageCount\n";
    const quote = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const rows = runs.map((run) => [run.runId, run.squad, run.taskId, run.startedAt, run.endedAt, run.status, run.repo, run.worktreePath, run.gitRef.type, run.gitRef.name, run.gitRef.headSha, run.totals.partialCostUSD, run.totals.unpricedUsageCount].map(quote).join(","));
    writeFileSync(destination, header + rows.join("\n") + "\n", "utf8");
    return { format, destination, rows: runs.length };
  }
  throw new Error("format must be jsonl, csv, or sqlite");
}

export function resetTelemetry(options = {}) {
  const path = options.dbPath || telemetryDbPath();
  if (existsSync(path)) rmSync(path, { force: true });
  return path;
}

export async function recordToolFact(record, options = {}) {
  const db = openTelemetryDb(options.dbPath);
  try {
    const toolFactId = createHash("sha1")
      .update(`${record.source_path}:${record.source_offset}:${record.tool_index}`)
      .digest("hex");
    const toolInput = record.tool_input ? record.tool_input.slice(0, 1000) : null;
    const result = db.prepare(`
      INSERT OR IGNORE INTO tool_facts
        (tool_fact_id, run_id, agent_key, model, observed_at, tool_name_raw, tool_name_canon, tool_input, tool_has_error, turn_index, source_path, source_offset, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      toolFactId, record.run_id, record.agent_key, record.model || null, record.observed_at || null,
      record.tool_name_raw, record.tool_name_canon || null, toolInput,
      record.tool_has_error ? 1 : 0, record.turn_index, record.source_path, record.source_offset, now(),
    );
    if (result.changes === 0) return { recorded: false, reason: "duplicate" };
    return { recorded: true, id: toolFactId };
  } finally {
    db.close();
  }
}

export async function recordDelegationLink(record, options = {}) {
  const db = openTelemetryDb(options.dbPath);
  try {
    const delegationId = createHash("sha1")
      .update(`${record.parent_run_id}:${record.parent_agent}:${record.child_agent}:${record.observed_at}`)
      .digest("hex");
    const result = db.prepare(`
      INSERT OR IGNORE INTO delegation_links
        (delegation_id, parent_run_id, parent_agent, child_agent, child_model, child_transcript, observed_at, child_tokens, child_cost_usd, child_turns, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      delegationId, record.parent_run_id, record.parent_agent, record.child_agent,
      record.child_model || null, record.child_transcript || null, record.observed_at || null,
      record.child_tokens || null, record.child_cost_usd || null, record.child_turns || null,
      record.source || "transcript", now(),
    );
    if (result.changes === 0) return { recorded: false, reason: "duplicate" };
    return { recorded: true, id: delegationId };
  } finally {
    db.close();
  }
}