// Shared utilities for Linear Agents — idempotent creation, review-round tracking.
//
// Zero runtime deps (Node 18+). ESM (.mjs).
//
// Usage:
//   import { idempotentCreate, reviewRound } from "./utils.mjs";

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, "..");

/** Lazy-ensure `.state/` dir exists under project root. */
function ensureStateDir() {
  const d = join(root, ".state");
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

/**
 * Atomically write a JSON file: write to a temp path, then rename over target.
 * This prevents partial reads by concurrent processes on most filesystems.
 */
function atomicWriteJSON(filePath, data) {
  const tmp = filePath + "." + randomBytes(4).readUInt32BE(0).toString(36);
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  renameSync(tmp, filePath);
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
// Review-rounds store
// ---------------------------------------------------------------------------

const REVIEW_ROUNDS_PATH = () => join(ensureStateDir(), "review-rounds.json");

function readReviewStore() {
  try {
    return JSON.parse(readFileSync(REVIEW_ROUNDS_PATH(), "utf8"));
  } catch {
    return {};
  }
}

function writeReviewStore(store) {
  atomicWriteJSON(REVIEW_ROUNDS_PATH(), store);
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
export async function idempotentCreate({ key, externalId, slice, createFn, existsFn }) {
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
      if (stillExists) return cached;
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
 * @param {object} opts
 * @param {string} opts.taskId    - Unique task identifier (e.g. Linear issue ID).
 * @param {number} [opts.maxRounds=2] - Maximum review rounds before escalation.
 * @returns {{ round: number, status: "review" | "escalated" }}
 *   - `round`: the current (1-based) round number.
 *   - `status`: `"review"` while round <= maxRounds, `"escalated"` once exceeded.
 */
export function reviewRound({ taskId, maxRounds = 2 }) {
  const store = readReviewStore();
  const current = store[taskId] ?? 0;

  // If already past the limit, don't increment further
  if (current > maxRounds) {
    return { round: current, status: "escalated" };
  }

  const next = current + 1;
  store[taskId] = next;
  writeReviewStore(store);

  return {
    round: next,
    status: next > maxRounds ? "escalated" : "review",
  };
}

/**
 * Reset the review-rounds store. Useful in tests to start with a clean slate.
 */
export function resetReviewRounds() {
  writeReviewStore({});
}
