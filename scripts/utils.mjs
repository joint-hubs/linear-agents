// Shared utilities for Linear Agents — idempotent creation, review-round
// tracking, the supervisor state-home seam and per-run scratch (FOC-903).
//
// Zero runtime deps (Node 18+). ESM (.mjs). This module sits at the BOTTOM of
// the scripts import graph: supervisor-lib.mjs re-exports the seam functions
// from here, so nothing may import supervisor-lib from this file (that edge
// would be a cycle).
//
// Usage:
//   import { idempotentCreate, reviewRound, collectRunScratch } from "./utils.mjs";

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync, readdirSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stateRoot } from "./fenix-paths.mjs";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, "..");

/**
 * Lazy-ensure the app-state dir exists (`.state/` under the repo root, or
 * `$LA_STATE_ROOT` — the shared seam from fenix-paths, FOC-811; the default is
 * byte-identical to the pre-seam location).
 */
function ensureStateDir() {
  const d = stateRoot();
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

/** Blocking (synchronous) sleep — the write path this serves is sync end to end. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Windows-only transient rename failures: another process (AV/Defender scan,
// indexer, a parallel run) holds the destination open for a moment. Anything
// else — ENOENT, EISDIR, … — is a real defect and fails on the first attempt.
const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EACCES"]);
const RENAME_MAX_ATTEMPTS = 5;
// Deterministic backoff, capped so the worst-case blocking on the live write
// path stays in the low hundreds of ms (25 + 50 + 100 + 100 = 275ms).
const renameBackoffMs = (attempt) => Math.min(25 * 2 ** (attempt - 1), 100);

/**
 * Atomically write a JSON file: write to a temp path, then rename over target.
 * This prevents partial reads by concurrent processes on most filesystems.
 *
 * The rename is retried up to 5 times on transient Windows `EPERM`/`EACCES`
 * (destination momentarily held open by another process), with a capped
 * deterministic backoff (~275ms worst case); any other error code fails on the
 * first attempt, unchanged. When retries are exhausted the temp file is
 * removed (best effort — a cleanup failure never masks the rename error) and
 * the error is rethrown with the destination path and the attempt count in its
 * message. A failed rename leaves the destination untouched — either the old
 * content or the new content, never partial.
 *
 * Exported because four other scripts used to carry a byte-identical private
 * copy (code-review-2026-08-03 §3) — they could not import it while it lived
 * here unexported.
 *
 * @param {string} filePath - Destination path.
 * @param {unknown} data    - JSON-serializable payload (written as
 *                            `JSON.stringify(data, null, 2) + "\n"`).
 * @param {object}  [opts]  - Seams and knobs. Without them callers get
 *                            today's behaviour byte-for-byte.
 * @param {Function} [opts.rename] - rename(tmp, dest) override (tests).
 * @param {Function} [opts.sleep]  - Synchronous backoff override (tests).
 * @param {number}  [opts.mode]   - POSIX mode for the created file (e.g.
 *                            0o644). Applied to the TEMP file's write, so the
 *                            renamed destination carries it exactly — a rename
 *                            replaces the old inode, which is what makes the
 *                            mode stick on every rewrite, not just the first.
 *                            Default unchanged (0o666 & ~umask); ignored on
 *                            Windows. Run-level writers pass 0o644 so state a
 *                            child must read but not rewrite stays so even
 *                            between fix_permissions passes (FOC-802 M3).
 */
export function atomicWriteJSON(filePath, data, { rename = renameSync, sleep = sleepSync, mode } = {}) {
  const tmp = filePath + "." + randomBytes(4).readUInt32BE(0).toString(36);
  writeFileSync(
    tmp,
    JSON.stringify(data, null, 2) + "\n",
    mode === undefined ? "utf8" : { encoding: "utf8", mode },
  );
  for (let attempt = 1; ; attempt++) {
    try {
      rename(tmp, filePath);
      return;
    } catch (err) {
      if (!TRANSIENT_RENAME_CODES.has(err?.code)) throw err;
      if (attempt >= RENAME_MAX_ATTEMPTS) {
        err.message = `${err.message} (atomicWriteJSON: gave up on "${filePath}" after ${attempt} attempts)`;
        try {
          unlinkSync(tmp);
        } catch {
          // Best effort only — the rename error below is the one that matters.
        }
        throw err;
      }
      sleep(renameBackoffMs(attempt));
    }
  }
}

// ---------------------------------------------------------------------------
// Created-keys store
// ---------------------------------------------------------------------------

const CREATED_KEYS_PATH = () => join(ensureStateDir(), "created-keys.json");

function readCreatedStore() {
  try {
    return JSON.parse(readFileSync(CREATED_KEYS_PATH(), "utf8"));
  } catch {
    return {};
  }
}

function writeCreatedStore(store) {
  atomicWriteJSON(CREATED_KEYS_PATH(), store);
}

// ---------------------------------------------------------------------------
// Supervisor state-home seam (FOC-608) + per-run scratch (FOC-903)
// ---------------------------------------------------------------------------

// The state root is a SEAM, in the same spirit as telemetry-store's
// LA_TELEMETRY_HOME — one function derives every path below it, and the default
// is never inlined anywhere else. `LA_SUPERVISOR_STATE_HOME` redirects the whole
// supervisor state tree (runs, gates, tees, wake queues) to another directory,
// which is what lets tests run against a temp dir instead of the repo's real
// `.state/supervisor/`. Unset means the historical location, unchanged.
// Defined here (not in supervisor-lib.mjs) because reviewRound/collectRunScratch
// below need it and this module must stay at the bottom of the import graph;
// supervisor-lib.mjs re-exports it.
export const supervisorStateHome = () =>
  process.env.LA_SUPERVISOR_STATE_HOME || join(root, ".state", "supervisor");

export const runDir = (runId) => join(supervisorStateHome(), runId);

// The supervisor run id shape `run-manifest.mjs gen-id supervisor` produces
// (e.g. 2026-10-06T15-09-19-713-supervisor-26c7) — the guard against treating a
// stray directory name (or a `test-*` fixture dir) as a run. Canonical home:
// supervisor-current-run.mjs re-exports it for its existing importers.
export const RUN_ID_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}-supervisor-[0-9a-f]{4}$/;

/**
 * Resolve the run id behind a per-run store: the explicit option wins, else
 * `LA_SUPERVISOR_RUN`. Returns null when neither is set — the caller then uses
 * the legacy global store (standalone squads). A present-but-invalid id throws:
 * silently falling back to the shared legacy file would recreate exactly the
 * cross-session lost update the per-run layout removes.
 */
function resolveRunId(runId) {
  const id = runId ?? process.env.LA_SUPERVISOR_RUN;
  if (id == null || id === "") return null;
  if (typeof id !== "string" || !RUN_ID_RE.test(id)) {
    throw new Error(`invalid supervisor run id: ${id} (expected the run-manifest gen-id shape, e.g. 2026-10-06T15-09-19-713-supervisor-26c7)`);
  }
  return id;
}

// Scratch kinds are path segments under <runDir>/scratch/ — one whitelist, so a
// kind can never carry a separator or traversal.
const SCRATCH_KIND_RE = /^[A-Za-z0-9_-]+$/;

/**
 * `<runDir>/scratch/<kind>/` — the per-run scratch area (FOC-903). Kinds in use:
 * `reviews` (review round files) and `krok0` (kickoff drafts). Created on demand.
 */
export function scratchDir(runId, kind) {
  const id = resolveRunId(runId);
  if (!id) throw new Error("scratchDir: a run id is required (option or LA_SUPERVISOR_RUN)");
  if (typeof kind !== "string" || !SCRATCH_KIND_RE.test(kind)) {
    throw new Error(`scratchDir: invalid scratch kind: ${kind}`);
  }
  const dir = join(runDir(id), "scratch", kind);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Scan every run dir under `stateHome` for per-run scratch inputs (FOC-903).
 * Only dirs matching RUN_ID_RE are runs — legacy `test-*` fixture dirs and
 * anything else is never read.
 *
 * Returns:
 *   rounds  — Map<taskId, { round, runId }>: the union of every run's
 *             review-rounds.json, the NEWEST run winning per task (run ids are
 *             zero-padded timestamps, so descending name order is chronological);
 *   reviews — [{ taskId, round, file (absolute path), runId }]: every
 *             `<runDir>/scratch/reviews/<taskId>-round<N>.md`, deduplicated per
 *             (taskId, round) with the newest run winning, same rule.
 *
 * Legacy inputs (.state/review-rounds.json, .state/reviews/) are NOT included —
 * callers merge them in at LOWER precedence (see delegation-outcomes.mjs).
 */
export function collectRunScratch({ stateHome = supervisorStateHome() } = {}) {
  const rounds = new Map();
  const reviews = [];
  let entries;
  try {
    entries = readdirSync(stateHome, { withFileTypes: true });
  } catch {
    return { rounds, reviews }; // no state home — nothing per-run anywhere
  }
  const runs = entries
    .filter((e) => e.isDirectory() && RUN_ID_RE.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse(); // newest first — the first run to claim a task wins

  const claimedReviews = new Set(); // `${taskId}|${round}` — first (newest) run wins
  for (const runId of runs) {
    const rDir = join(stateHome, runId);
    let store = null;
    try {
      store = JSON.parse(readFileSync(join(rDir, "review-rounds.json"), "utf8"));
    } catch {
      // absent or corrupt — this run contributes no counter
    }
    if (store && typeof store === "object" && !Array.isArray(store)) {
      for (const [taskId, value] of Object.entries(store)) {
        const round = Number(value);
        if (!Number.isFinite(round) || round < 0) continue;
        if (!rounds.has(taskId)) rounds.set(taskId, { round, runId });
      }
    }
    const revDir = join(rDir, "scratch", "reviews");
    let files;
    try {
      files = readdirSync(revDir);
    } catch {
      continue; // no scratch/reviews in this run
    }
    for (const file of files) {
      const m = file.match(/^(.+)-round(\d+)\.md$/);
      if (!m) continue;
      const key = `${m[1]}|${m[2]}`;
      if (claimedReviews.has(key)) continue;
      claimedReviews.add(key);
      reviews.push({ taskId: m[1], round: Number(m[2]), file: join(revDir, file), runId });
    }
  }
  return { rounds, reviews };
}

// ---------------------------------------------------------------------------
// Review-rounds store
// ---------------------------------------------------------------------------

const REVIEW_ROUNDS_PATH = () => join(ensureStateDir(), "review-rounds.json");

/** The counter file for a resolved run id: per-run when known, legacy otherwise. */
function reviewRoundsPath(id) {
  if (!id) return REVIEW_ROUNDS_PATH();
  const dir = runDir(id);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, "review-rounds.json");
}

function readReviewStore(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function writeReviewStore(path, store) {
  atomicWriteJSON(path, store);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Idempotently create an external entity (e.g. a Linear issue, label, or state).
 *
 * If the same `key` (derived from `slice` or provided via `externalId`) has
 * already been created and the entity still exists (confirmed by `existsFn`),
 * the existing entity ID is returned WITHOUT calling `createFn`.
 *
 * @param {object} opts
 * @param {string}  [opts.key]        - Explicit key. If omitted, derived from
 *                                      `slice` (SHA-256 hex) or `externalId`.
 * @param {string}  [opts.externalId] - Use an external identifier as the key
 *                                      directly (e.g. a Linear issue ID from
 *                                      the caller). Takes precedence over `slice`.
 * @param {string}  [opts.slice]      - Arbitrary string to derive a stable key
 *                                      from (SHA-256 hex). Ignored if `key` or
 *                                      `externalId` is provided.
 * @param {Function} opts.createFn    - Async function() => entityId. Called only
 *                                      when no cached entry exists or the cached
 *                                      entity is gone.
 * @param {Function} opts.existsFn    - Async function(entityId) => boolean.
 *                                      Confirms the cached entity still exists.
 * @returns {Promise<string>} The entity ID (cached or freshly created).
 */
export async function idempotentCreate({ key, externalId, slice, createFn, existsFn, onSkip }) {
  // Input validation
  if (!key && !externalId && !slice) {
    throw new TypeError("idempotentCreate: provide one of key | externalId | slice");
  }
  if (typeof existsFn !== "function") {
    throw new TypeError("idempotentCreate: existsFn is required");
  }

  // Resolve the stable key
  const resolvedKey = key ?? externalId ?? createHash("sha256").update(slice).digest("hex");

  // TODO(pilot-hardening): lost-update race — two concurrent same-key calls can both
  // create; atomic write prevents corruption but not the race. The pilot runs squads
  // sequentially (WIP=1) so it is acceptable now. Real fix: lock file / CAS.
  // Read current store
  const store = readCreatedStore();
  const cached = store[resolvedKey];

  if (cached !== undefined && existsFn) {
    try {
      const stillExists = await existsFn(cached);
      if (stillExists) {
        if (typeof onSkip === "function") onSkip(cached);
        return cached;
      }
    } catch {
      // existsFn threw (e.g. network error) — treat as "entity gone" and
      // re-create to be safe.
    }
  }

  // Create the entity
  const newId = await createFn();

  // Persist
  store[resolvedKey] = newId;
  writeCreatedStore(store);

  return newId;
}

/**
 * Reset the created-keys store. Useful in tests to start with a clean slate.
 */
export function resetCreatedStore() {
  writeCreatedStore({});
}

/**
 * Track and limit review rounds for a task.
 *
 * Each call increments the round counter for the given task. Once the counter
 * exceeds `maxRounds`, the status flips to `"escalated"` and no further
 * increments occur.
 *
 * The counter file follows the run (FOC-903): when a run id is known (the
 * `runId` option, else `LA_SUPERVISOR_RUN`), the counter lives at
 * `<runDir>/review-rounds.json` — one writer per task, so two supervised
 * sessions can no longer lose each other's increments on the single global
 * file. Without a run id the legacy global `.state/review-rounds.json` is used,
 * exactly as before (standalone squads).
 *
 * @param {object} opts
 * @param {string} opts.taskId    - Unique task identifier (e.g. Linear issue ID).
 * @param {number} [opts.maxRounds=2] - Maximum review rounds before escalation.
 * @param {string} [opts.runId]   - Supervisor run id (defaults to
 *                                  `LA_SUPERVISOR_RUN`); an invalid id throws.
 * @returns {{ round: number, status: "review" | "escalated" }}
 *   - `round`: the current (1-based) round number.
 *   - `status`: `"review"` while round <= maxRounds, `"escalated"` once exceeded.
 */
export function reviewRound({ taskId, maxRounds = 2, runId } = {}) {
  const path = reviewRoundsPath(resolveRunId(runId));
  const store = readReviewStore(path);
  const current = store[taskId] ?? 0;

  // If already past the limit, don't increment further
  if (current > maxRounds) {
    return { round: current, status: "escalated" };
  }

  const next = current + 1;
  store[taskId] = next;
  writeReviewStore(path, store);

  return {
    round: next,
    status: next > maxRounds ? "escalated" : "review",
  };
}

/**
 * Reset the review-rounds store. Useful in tests to start with a clean slate.
 * Follows the same run-id rule as `reviewRound`: with a run id (option or
 * `LA_SUPERVISOR_RUN`) the per-run counter is cleared, without one the legacy
 * global file.
 */
export function resetReviewRounds({ runId } = {}) {
  writeReviewStore(reviewRoundsPath(resolveRunId(runId)), {});
}
