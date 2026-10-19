#!/usr/bin/env node
/**
 * scripts/analysis-cache.mjs — DERIVED ANALYSIS CACHE for the dashboard's
 * Analysis screen.
 *
 * Why this exists. The Analysis panels read the store's canonical views
 * (canonical_usage, canonical_tool_facts), which are window-function views:
 * every query re-evaluates the windows over the whole fact tables, and filters
 * do not push into them. Measured on the real 849 MB store: COUNT(*) over
 * canonical_usage = 12.9 s (10.2 s with a 7-day filter), canonical_tool_facts
 * = 90.1 s — while the panels need several passes each and the SQL console
 * times out at 10 s. Unusable.
 *
 * The fix is a materialisation: this module copies those views ONCE into a
 * separate SQLite file as plain indexed tables (same names, same columns), so
 * openAnalysisDb(cachePath) feeds every panel unchanged. The cache is a
 * DISPOSABLE DERIVATE — deleting it loses nothing, it is rebuilt from the
 * store in one pass. The telemetry store itself is NEVER written by this
 * module: it is only ever opened read-only (never openTelemetryDb(), which
 * migrates on open).
 *
 * Staleness. A cache is stale when it does not exist, when its schema version
 * differs from CACHE_SCHEMA_VERSION, or when the store's watermark (raw
 * usage_facts/tool_facts row counts + max observed_at, captured BEFORE the
 * views are read) no longer matches the watermark recorded at build time.
 * Reading the watermark first means a store that changes mid-build produces a
 * cache that the NEXT status check reports stale, never falsely fresh.
 * cacheStatus() reports all of this; the dashboard rebuilds when stale.
 *
 * Atomic swap. The build writes to `<cachePath>.building` and renames it over
 * `<cachePath>` only when complete — a crashed build never corrupts the
 * previous cache, and readers only ever see a whole snapshot. On Windows a
 * rename over a file another process holds open fails (EPERM/EBUSY): the swap
 * retries a few times with backoff, and on final failure the OLD cache is left
 * untouched, the .building file is deleted, and the error carries
 * .code = "swap_failed". A leftover .building from a crashed build is deleted
 * at the start of the next build.
 *
 * Concurrency. Builds hold `<cachePath>.lock` (JSON: pid + start time). A
 * second build against a live lock fails with .code = "build_in_progress";
 * a lock older than 30 minutes, or whose pid is no longer alive, is stale and
 * is taken over. The lock is always released in a finally block.
 *
 * Column lists are derived from PRAGMA table_info(<name>) on the STORE at
 * build time, so the cache follows the views when they gain columns (e.g. a
 * future message_id) without this file changing.
 */

import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { telemetryDbPath, telemetryHome } from "./telemetry-store.mjs";
import { ERA_BOUNDARY } from "./telemetry-analysis.mjs";
// FOC-915: the Insights task table and supervisor allocation are DERIVED at
// cache build time with the SAME JS functions the panels use — the build reads
// the freshly copied relations through loadTasksUnfiltered and persists what
// the panels would otherwise recompute on every request.
import {
  buildTaskTable,
  allocateSupervisorOverhead,
  addLoadedCost,
  loadTasksUnfiltered,
} from "./analysis-insights.mjs";

/** Bump when the cache layout changes in a way old files must not satisfy. */
export const CACHE_SCHEMA_VERSION = 3;

// A lock older than this is considered abandoned (crashed builder) even if its
// pid cannot be probed.
const LOCK_MAX_AGE_MS = 30 * 60 * 1000;
// Rows per write transaction while copying — large enough to be fast, small
// enough to keep the rollback journal bounded.
const COMMIT_EVERY = 5000;

// Views first (the expensive materialisations), then the small tables the
// panels also read. Each is copied wholesale with PRAGMA-derived columns.
const COPY_RELATIONS = [
  "canonical_usage",
  "canonical_tool_facts",
  "runs",
  "delegation_links",
  "data_quality_issues",
  // FOC-787: the Insights panels attribute cost to tickets through the
  // run→task links, so the cache must carry both link tables too.
  "run_task_links",
  "work_items",
];

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function cachePath() {
  return process.env.LA_ANALYSIS_CACHE || join(telemetryHome(), "analysis-cache.sqlite");
}

/**
 * Cheap, cache-meta-only probe: does the cache file exist AND carry the
 * schema the running code expects? Reads only cache_meta (no store watermark
 * — staleness must stay out of the per-request path). Absent, unreadable, or
 * wrong-schema all return false: FOC-915 — a cache written by an older
 * schema (e.g. the 2→3 bump that added the insight tables) must be treated
 * as ABSENT by the server's panels, not served and not silently 500-ing with
 * "no such table" on every request. The rebuild child writes the current
 * version, so the auto-build restores a serviceable cache.
 */
export function cacheMatchesSchema(p = cachePath()) {
  if (!existsSync(p)) return false;
  let db = null;
  try {
    db = openReadOnly(p);
    const meta = db.prepare(
      "SELECT cache_schema_version FROM cache_meta LIMIT 1",
    ).get();
    return meta?.cache_schema_version === CACHE_SCHEMA_VERSION;
  } catch {
    return false; // unreadable/incomplete cache — treated as absent
  } finally {
    db?.close();
  }
}

/**
 * Open a SQLite file strictly read-only. Never openTelemetryDb() — that is
 * read-write and migrates on open, which must never happen to the store, and
 * would be wrong for the cache too (a status check must not create it).
 */
function openReadOnly(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec("PRAGMA busy_timeout = 10000;");
  return db;
}

/**
 * Cheap, read-only snapshot of the store's raw fact tables — the staleness
 * watermark. Raw tables only (milliseconds), never the canonical views.
 */
export function storeWatermark(storePath = telemetryDbPath()) {
  const db = openReadOnly(storePath);
  try {
    return {
      usageRows: db.prepare("SELECT COUNT(*) AS n FROM usage_facts").get().n,
      toolRows: db.prepare("SELECT COUNT(*) AS n FROM tool_facts").get().n,
      maxObservedAt: db.prepare("SELECT MAX(observed_at) AS m FROM usage_facts").get().m,
    };
  } finally {
    db.close();
  }
}

// --- build lock ---------------------------------------------------------------

// Builds started in THIS process (resolved lock paths) — the file lock below
// covers other processes; this set makes same-process overlap impossible even
// when the file was just written by ourselves.
const activeBuilds = new Set();

function readLockInfo(lockPath) {
  try {
    return JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = the process exists but is not ours. ESRCH = gone.
    return error.code === "EPERM";
  }
}

function isLockLive(info, nowMs = Date.now()) {
  if (!info || !pidAlive(info.pid)) return false;
  const startedAt = Date.parse(info.startedAt);
  if (Number.isNaN(startedAt)) return false;
  return nowMs - startedAt < LOCK_MAX_AGE_MS;
}

function acquireBuildLock(lockPath, target) {
  if (activeBuilds.has(lockPath)) {
    throw fail("build_in_progress", `a build of the analysis cache at ${target} is already running in this process`);
  }
  const content = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  const tryCreate = () => {
    writeFileSync(lockPath, content, { flag: "wx" });
    activeBuilds.add(lockPath);
  };
  try {
    tryCreate();
    return;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const info = readLockInfo(lockPath);
  if (isLockLive(info)) {
    throw fail("build_in_progress", `a live build lock (pid ${info?.pid}) exists for the analysis cache at ${target}`);
  }
  // Stale: crashed builder, dead pid, or older than LOCK_MAX_AGE_MS. Take over.
  rmSync(lockPath, { force: true });
  try {
    tryCreate();
  } catch (error) {
    if (error.code === "EEXIST") {
      throw fail("build_in_progress", `another build took the lock for the analysis cache at ${target} first`);
    }
    throw error;
  }
}

function releaseBuildLock(lockPath) {
  activeBuilds.delete(lockPath);
  try {
    rmSync(lockPath, { force: true });
  } catch {
    // Best effort — a stuck lock file is treated as stale by the next builder.
  }
}

// --- copy ---------------------------------------------------------------------

/**
 * Copy one store relation (view or table) into the cache as a plain table.
 * Columns come from pragma_table_info on the STORE, so a view that gains a
 * column is followed automatically. Values travel row-by-row through bound
 * parameters; nothing is string-concatenated.
 */
function copyRelation(store, cache, name, onProgress) {
  const columns = store.prepare("SELECT name, type FROM pragma_table_info(?)").all(name);
  if (columns.length === 0) {
    throw fail("source_missing", `"${name}" not found in the store — is this a telemetry database?`);
  }
  const quoted = columns.map((c) => `"${c.name}"`);
  // A column with no declared type (view expression columns report "") is
  // created with no type — BLOB affinity, values stored exactly as read.
  const decl = columns.map((c) => (c.type ? `"${c.name}" ${c.type}` : `"${c.name}"`)).join(", ");
  cache.exec(`CREATE TABLE "${name}" (${decl})`);

  const insert = cache.prepare(
    `INSERT INTO "${name}" (${quoted.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
  );
  const names = columns.map((c) => c.name);
  const select = store.prepare(`SELECT ${quoted.join(", ")} FROM "${name}"`);

  let count = 0;
  cache.exec("BEGIN");
  for (const row of select.iterate()) {
    insert.run(...names.map((n) => row[n]));
    if (++count % COMMIT_EVERY === 0) {
      cache.exec("COMMIT");
      cache.exec("BEGIN");
      if (onProgress) onProgress({ table: name, rows: count });
    }
  }
  cache.exec("COMMIT");
  if (onProgress) onProgress({ table: name, rows: count, done: true });
  return count;
}

/** The indexes that make panel queries fast on the cache. */
function createCacheIndexes(cache) {
  cache.exec(`
    CREATE INDEX idx_cache_cu_observed_at ON canonical_usage(observed_at);
    CREATE INDEX idx_cache_cu_squad       ON canonical_usage(squad);
    CREATE INDEX idx_cache_cu_model       ON canonical_usage(model);
    CREATE INDEX idx_cache_cu_run_agent   ON canonical_usage(run_id, agent_key);
    CREATE INDEX idx_cache_ctf_observed_at ON canonical_tool_facts(observed_at);
    CREATE INDEX idx_cache_ctf_squad       ON canonical_tool_facts(squad);
    CREATE INDEX idx_cache_ctf_model       ON canonical_tool_facts(model);
    CREATE INDEX idx_cache_ctf_run_agent   ON canonical_tool_facts(run_id, agent_key);
    CREATE INDEX idx_cache_runs_run_id     ON runs(run_id);
    CREATE INDEX idx_cache_dl_parent       ON delegation_links(parent_run_id);
    CREATE INDEX idx_cache_dl_observed_at  ON delegation_links(observed_at);
    CREATE INDEX idx_cache_rtl_run         ON run_task_links(run_id, valid_from);
    CREATE INDEX idx_cache_wi_task         ON work_items(task_id);
  `);
}

// ── FOC-915: the Insights tables, derived at build time ──────────────────────

/**
 * Derive the Insights task table and supervisor allocation into the cache,
 * with the SAME JS functions the panels use (analysis-insights.mjs) — so the
 * definitions live in one place and the panels read indexed rows instead of
 * recomputing the run→task attribution of ~180k canonical rows per request.
 *
 * The inputs are read from the JUST-COPIED relations in the .building cache
 * (one connection, no second pass over the store) with NO filters: the
 * per-task / per-message filters apply at read time, over the precomputed
 * rows — per task first_ts (tickets, concentration) and per message time
 * (spend), the windows the panels document today.
 *
 * Tables:
 *   insight_task_table — one row per task: first_ts, era, msgs, direct cost,
 *     unpriced share, supervisor active/adjacent cost, loaded cost, partial.
 *   insight_supervisor_alloc — one row per supervisor message: mode, the
 *     comma-separated task ids it was allocated over, cost_usd.
 *
 * Read errors fail the build (the cache must never ship half-derived): the
 * caller's try/finally deletes the .building file.
 */
function deriveInsightTables(cache) {
  const inputs = loadTasksUnfiltered(cache);
  const built = buildTaskTable(inputs.usageRows, inputs.links, { eraBoundary: ERA_BOUNDARY });
  const alloc = allocateSupervisorOverhead(inputs.supRows, inputs.childRuns, inputs.tasksByRun, {
    horizon: inputs.horizon,
  });
  addLoadedCost(built.tasks, alloc);

  cache.exec(`
    CREATE TABLE insight_task_table (
      task_id        TEXT PRIMARY KEY,
      era            TEXT,            -- informational (SQL exploration); the panels re-derive era from first_ts
      first_ts       TEXT,
      last_ts        TEXT,
      msgs           INTEGER NOT NULL,
      cost_usd       REAL,
      unpriced_share REAL NOT NULL,
      sup_active     REAL NOT NULL,
      sup_adjacent   REAL NOT NULL,
      cost_loaded    REAL,
      partial        INTEGER NOT NULL
    );
    CREATE TABLE insight_supervisor_alloc (
      usage_id    TEXT PRIMARY KEY,
      run_id      TEXT,
      observed_at TEXT,
      mode        TEXT NOT NULL,
      cost_usd    REAL,
      tasks_json  TEXT NOT NULL
    );
    CREATE INDEX idx_cache_sta_observed_at ON insight_supervisor_alloc(observed_at);
  `);
  const insertTask = cache.prepare(`
    INSERT INTO insight_task_table
      (task_id, era, first_ts, last_ts, msgs, cost_usd, unpriced_share,
       sup_active, sup_adjacent, cost_loaded, partial)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  cache.exec("BEGIN");
  try {
    for (const t of built.tasks.values()) {
      insertTask.run(
        t.taskId, t.era ?? null, t.firstTs ?? null, t.lastTs ?? null,
        t.msgs, t.costUsd ?? null, t.unpricedShare,
        t.supActive ?? 0, t.supAdjacent ?? 0, t.costLoaded ?? null, t.partial ? 1 : 0,
      );
    }
    cache.exec("COMMIT");
  } catch (err) {
    try { cache.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw err;
  }

  const insertAlloc = cache.prepare(`
    INSERT INTO insight_supervisor_alloc (usage_id, run_id, observed_at, mode, cost_usd, tasks_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  cache.exec("BEGIN");
  try {
    for (const a of alloc) {
      insertAlloc.run(a.usageId, a.runId, a.observedAt ?? null, a.mode, a.costUsd ?? null, JSON.stringify(a.tasks ?? []));
    }
    cache.exec("COMMIT");
  } catch (err) {
    try { cache.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw err;
  }

  // The attribution-drop counts the tickets panel reports as caveats — they
  // are properties of the BUILD-TIME attribution (full history), so they are
  // persisted here rather than recomputed per request.
  cache.exec(`
    CREATE TABLE insight_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  const insMeta = cache.prepare("INSERT INTO insight_meta (key, value) VALUES (?, ?)");
  insMeta.run("dropped_sup_rows", String(built.droppedSup));
  insMeta.run("dropped_sup_usd", String(built.droppedUsd));
  insMeta.run("dropped_no_link_rows", String(built.droppedNoLink));

  return {
    taskRows: built.tasks.size,
    droppedSup: built.droppedSup,
    droppedNoLink: built.droppedNoLink,
    allocRows: alloc.length,
  };
}

// The swap target must not be open by this process when renaming — connections
// are closed by the caller before swapIntoPlace runs.
// Retry budget: a SQL console query on the cache can hold the file open for up
// to its own 10 s timeout, so a ~1 s window fails while the reader is still
// busy. 48 attempts × 250 ms ≈ 12 s outlasts any legitimate reader.
const SWAP_ATTEMPTS = 48;
const SWAP_INTERVAL_MS = 250;

/**
 * Rename .building over the target, retrying while another process holds the
 * target open (Windows: EPERM/EBUSY). attempts / intervalMs / rename are
 * injectable so tests can simulate a blocker that releases mid-window
 * without sleeping real seconds.
 */
export async function swapIntoPlace(
  buildingPath,
  targetPath,
  { attempts = SWAP_ATTEMPTS, intervalMs = SWAP_INTERVAL_MS, rename = renameSync, sleepFn = sleep } = {},
) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      rename(buildingPath, targetPath);
      return;
    } catch (error) {
      if (attempt === attempts) break;
      // Windows: rename over a file another process holds open fails with
      // EPERM/EBUSY. Keep retrying inside the budget above.
      await sleepFn(intervalMs);
    }
  }
  // The old cache stays untouched — the next build (or the next reader of the
  // old snapshot) is not harmed by this failure.
  rmSync(buildingPath, { force: true });
  throw fail("swap_failed", `could not replace ${targetPath} — another process holds it open; the previous cache is untouched`);
}

/**
 * Is the cache at `cachePath` usable against the store at `storePath`?
 *
 * → { exists, builtAt, buildMs, watermark, current, stale, schemaVersion, building }
 *   stale = !exists || watermark differs from current || schema version differs.
 *   building = a live lock exists (another build is in progress).
 */
export function cacheStatus({ storePath = telemetryDbPath(), cachePath: p = cachePath() } = {}) {
  const lockPath = `${p}.lock`;
  let current = null;
  try {
    current = storeWatermark(storePath);
  } catch {
    // Unreadable store — cannot prove freshness, so everything is stale.
    current = null;
  }
  const building = Boolean(isLockLive(readLockInfo(lockPath)));

  if (!existsSync(p)) {
    return { exists: false, builtAt: null, buildMs: null, watermark: null, current, stale: true, schemaVersion: null, building };
  }

  let meta = null;
  try {
    const db = openReadOnly(p);
    try {
      meta = db.prepare(
        "SELECT built_at, build_ms, watermark_json, cache_schema_version FROM cache_meta LIMIT 1",
      ).get();
    } finally {
      db.close();
    }
  } catch {
    meta = null; // unreadable/incomplete cache — stale, the caller rebuilds
  }
  const watermark = meta ? JSON.parse(meta.watermark_json) : null;
  const schemaVersion = meta ? meta.cache_schema_version : null;
  const stale = !meta
    || schemaVersion !== CACHE_SCHEMA_VERSION
    || !current
    || JSON.stringify(watermark) !== JSON.stringify(current);
  return {
    exists: true,
    builtAt: meta?.built_at ?? null,
    buildMs: meta?.build_ms ?? null,
    watermark,
    current,
    stale,
    schemaVersion,
    building,
  };
}

/**
 * Build (or rebuild) the analysis cache from the store. Reads the store
 * strictly read-only; writes only the cache files (.building → atomic rename).
 *
 * → { builtAt, buildMs, rows: { canonical_usage, canonical_tool_facts, runs,
 *     delegation_links, data_quality_issues, insight_task_table,
 *     insight_supervisor_alloc }, watermark }
 */
export async function buildCache({ storePath = telemetryDbPath(), cachePath: p = cachePath(), onProgress } = {}) {
  const lockPath = `${p}.lock`;
  const buildingPath = `${p}.building`;
  acquireBuildLock(lockPath, p);
  // Yield once after taking the lock so a same-tick second build observes it
  // (the lock file is written synchronously above).
  await new Promise((resolve) => setImmediate(resolve));

  const startedAt = Date.now();
  let store = null;
  let cache = null;
  let swapped = false;
  try {
    // Garbage from a crashed build — never a usable partial cache.
    rmSync(buildingPath, { force: true });
    mkdirSync(dirname(p), { recursive: true });

    // Watermark BEFORE reading the views: a store that changes mid-build is
    // reported stale on the next status check, never falsely fresh.
    const watermark = storeWatermark(storePath);

    store = openReadOnly(storePath);
    cache = new DatabaseSync(buildingPath);
    // The .building file is disposable — a fast journal and no fsync cost
    // correctness nothing (a failed build is deleted, not recovered).
    cache.exec("PRAGMA busy_timeout = 10000; PRAGMA journal_mode = MEMORY; PRAGMA synchronous = OFF;");

    const rows = {};
    for (const name of COPY_RELATIONS) {
      rows[name] = copyRelation(store, cache, name, onProgress);
    }
    createCacheIndexes(cache);

    // FOC-915: derive the Insights task table + supervisor allocation from the
    // just-copied relations, with the panels' own JS functions. A failure here
    // fails the whole build — the cache must never ship half-derived.
    const insights = deriveInsightTables(cache);
    rows.insight_task_table = insights.taskRows;
    rows.insight_supervisor_alloc = insights.allocRows;

    const builtAt = new Date().toISOString();
    const buildMs = Date.now() - startedAt;
    cache.exec(`
      CREATE TABLE cache_meta (
        built_at            TEXT NOT NULL,
        build_ms            INTEGER NOT NULL,
        watermark_json      TEXT NOT NULL,
        cache_schema_version INTEGER NOT NULL,
        source_store_path   TEXT NOT NULL
      )
    `);
    cache.prepare(
      "INSERT INTO cache_meta (built_at, build_ms, watermark_json, cache_schema_version, source_store_path) VALUES (?, ?, ?, ?, ?)",
    ).run(builtAt, buildMs, JSON.stringify(watermark), CACHE_SCHEMA_VERSION, storePath);

    cache.close();
    cache = null;
    store.close();
    store = null;

    await swapIntoPlace(buildingPath, p);
    swapped = true;
    return { builtAt, buildMs, rows, watermark };
  } finally {
    if (cache) try { cache.close(); } catch { /* already closing */ }
    if (store) try { store.close(); } catch { /* already closing */ }
    if (!swapped) rmSync(buildingPath, { force: true });
    releaseBuildLock(lockPath);
  }
}

// --- CLI ------------------------------------------------------------------------

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const argv = process.argv.slice(2);
  const verb = argv[0];
  const opt = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const opts = {};
  if (opt("store")) opts.storePath = opt("store");
  if (opt("cache")) opts.cachePath = opt("cache");
  try {
    if (verb === "status") {
      console.log(JSON.stringify(cacheStatus(opts), null, 2));
    } else if (verb === "build") {
      const result = await buildCache({
        ...opts,
        onProgress: (progress) => {
          process.stderr.write(`  ${progress.table}: ${progress.rows} rows${progress.done ? " (done)" : ""}\n`);
        },
      });
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error("Usage: node scripts/analysis-cache.mjs status|build [--store <path>] [--cache <path>]");
      process.exit(2);
    }
  } catch (error) {
    console.error(`${error.code ?? "error"}: ${error.message}`);
    process.exit(1);
  }
}
