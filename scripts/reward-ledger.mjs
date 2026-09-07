// Reward ledger — dedicated durable store for awards, revocations and
// manager ratings (FOC-225 slice 3; design: docs/ui/fenix-manager-rewards.md §5).
//
// Deliberately a SEPARATE SQLite database, never a table in telemetry.sqlite:
// telemetry's resetTelemetry() deletes its db, reproject passes may rewrite
// rows, and every telemetry migration would put the append-only audit trail
// at risk. No cross-db foreign keys exist in SQLite, so referenced-entity
// validity is checked at WRITE time by the ingest (the only writer).
//
// Ledger rules (design §2–§5):
//   - append-only: corrections/revocations are history, never deletes; each
//     row carries an `active` flag for current-state arithmetic
//     (active XP = SUM(points) WHERE active=1);
//   - transactional dedup on (task, repo, revision, rule_version) inside a
//     BEGIN IMMEDIATE — deliberately NOT a table UNIQUE, so the
//     revoke → re-accept → re-award cycle stays possible while replayed or
//     concurrent evidence still yields exactly one award;
//   - held awards (evidence accepted, credit subject unresolvable) live in
//     their OWN dedup namespace ('held|' prefix) so a hold dedups against
//     itself across ingest passes yet never blocks the real award once the
//     producing run is linked;
//   - absent repo/revision are the sentinel 'unknown' (never NULL, never 0 —
//     SQLite UNIQUE/comparison does not collapse NULLs and silence is unknown);
//   - ratings supersede per (subject, task, run) with NULL-safe `IS`
//     comparisons; a rating never carries points.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const REWARDS_SCHEMA_VERSION = 2;

// Per-step migration markers, same pattern telemetry-store.mjs uses: each step
// guards itself on its own marker inside migrateRewards, so opening an
// existing database always runs every step whose marker is missing — a
// short-circuit on the first marker would freeze the store at v1 forever.
export const REWARDS_MIGRATION_VERSIONS = {
  rewardsBase: 1,
  // v2 (review round 5): held rows re-keyed into the held dedup namespace and
  // crash-corrupted active 'unknown'-subject awards demoted — see
  // migrateHeldReplayRekey.
  heldReplayRekey: 2,
};

// PRODUCT RULES, not measurements (design §3): display arithmetic only.
// Every award stamps rule_version; the server sends these constants in the
// rewards payload and the UI renders them with their version label — they are
// never hardcoded in components and never consumed outside the display path.
export const XP_RULES = Object.freeze({
  version: "xp-rules v1",
  pointsPerAcceptedRevision: 100,
  xpPerLevel: 500,
});

export const REWARDS_RECORD_KINDS = Object.freeze(["award", "revocation", "rating"]);
// Design §5 lists 'correction' as a future kind; v1 implements award /
// revocation / rating only, so the CHECK constraint names exactly what exists.
const KIND_CHECK = REWARDS_RECORD_KINDS.join("','");

// Sentinel for "this field could not be proven from the evidence" — an honest
// value, distinct from a real value and from zero (design §1: silence is not
// zero and not a guess).
export const UNKNOWN = "unknown";

export function rewardsHome() {
  return (
    process.env.LA_REWARDS_HOME ||
    join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "linear-agents", "rewards")
  );
}

export function rewardsDbPath() {
  return process.env.LA_REWARDS_DB || join(rewardsHome(), "rewards.sqlite");
}

export function openRewardsDb(path = rewardsDbPath()) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  migrateRewards(db);
  return db;
}

export function migrateRewards(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  // Each step guards itself on its own marker (telemetry-store's pattern):
  // an existing v1 database must still gain every later step, so nothing may
  // return early from migrateRewards as a whole.
  migrateRewardsBase(db);
  migrateHeldReplayRekey(db);
}

function migrationMarker(db, version) {
  return db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version);
}

function stampMigration(db, version) {
  db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
    version,
    new Date().toISOString(),
  );
}

function migrateRewardsBase(db) {
  if (migrationMarker(db, REWARDS_MIGRATION_VERSIONS.rewardsBase)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS reward_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK (kind IN ('${KIND_CHECK}')),
      subject TEXT NOT NULL,                -- squad key; '${UNKNOWN}' when unresolvable
      role TEXT,                            -- reserved: per-role credit is out of v1 (binding decision)
      task_id TEXT,                         -- normalized uppercase; NULL only for squad-wide rows
      repo TEXT NOT NULL DEFAULT '${UNKNOWN}',
      revision TEXT NOT NULL DEFAULT '${UNKNOWN}',
      run_id TEXT,
      evidence_id TEXT,                     -- repo-relative artifact path, never interpreted logs
      model TEXT,                           -- actual model used, or NULL = unknown
      rule_version TEXT,                    -- XP_RULES.version for award/revocation; NULL for ratings
      points INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,    -- current-state flag; audit rows stay, flags move
      rating INTEGER,                       -- 1..5, kind='rating' only
      note TEXT,                            -- rating note, rendered as text
      provenance TEXT NOT NULL,             -- which rule/vote produced the record
      recorded_at TEXT NOT NULL,
      dedup_key TEXT                        -- award/revocation: task|repo|revision|rule_version
    );
    CREATE INDEX IF NOT EXISTS idx_rewards_subject_active ON reward_records (subject, active, kind);
    CREATE INDEX IF NOT EXISTS idx_rewards_dedup ON reward_records (dedup_key);
  `);
  stampMigration(db, REWARDS_MIGRATION_VERSIONS.rewardsBase);
}

// v2 — the v1 held-award insert committed an active award row and demoted it
// with two post-commit UPDATEs. A crash in that window left an ACTIVE award
// at subject 'unknown': invisible to the held list (which requires active=0)
// and, via the award dedup check, permanently blocking the real award. And
// because v1 held rows carried the plain award dedup key, every ingest pass
// over still-unresolved evidence inserted another held row. The writer now
// inserts held rows directly in their final shape under a held-scoped key;
// this one-shot rekey moves pre-v2 rows into that same shape:
//   - any active award at subject 'unknown' is a crash leftover (the ingest
//     only awards through insertAward with a resolved subject) → demote;
//   - every unknown-subject award row gets the 'held|' key prefix, so replayed
//     held evidence dedups and the demoted rows can never block an award.
function migrateHeldReplayRekey(db) {
  if (migrationMarker(db, REWARDS_MIGRATION_VERSIONS.heldReplayRekey)) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE reward_records SET active=0 WHERE kind='award' AND subject=? AND active=1").run(UNKNOWN);
    db.prepare(
      `UPDATE reward_records SET dedup_key = '${HELD_KEY_PREFIX}' || dedup_key
        WHERE kind='award' AND subject=? AND dedup_key IS NOT NULL AND dedup_key NOT LIKE '${HELD_KEY_PREFIX}%'`,
    ).run(UNKNOWN);
    stampMigration(db, REWARDS_MIGRATION_VERSIONS.heldReplayRekey);
    db.exec("COMMIT");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw err;
  }
}

function now() {
  return new Date().toISOString();
}

function taskKey(taskId, repo, revision, ruleVersion) {
  return [taskId ?? UNKNOWN, repo ?? UNKNOWN, revision ?? UNKNOWN, ruleVersion ?? UNKNOWN].join("|");
}

// Held rows dedup in their own namespace: 'held|' + the award key. Two
// identities that must both hold at once: (1) replays of the same unresolved
// evidence group collapse to ONE held row (the held key matches itself), and
// (2) the held key never equals an award key, so a hold can never block the
// real award inserted later once the producing run is linked.
const HELD_KEY_PREFIX = "held|";

function heldKey(key) {
  return `${HELD_KEY_PREFIX}${key}`;
}

function normalizedTaskId(taskId) {
  if (taskId == null) return null;
  const normalized = String(taskId).trim().toUpperCase();
  return normalized || null;
}

// ── writes (the ingest is the only caller for awards/revocations) ───────────

/**
 * Insert an award for one accepted task-revision. The dedup pre-check and the
 * insert share one BEGIN IMMEDIATE transaction, so replayed evidence and
 * concurrent ingestion both yield exactly one active award. Returns
 * { ok, id, duplicate } — duplicate=true means an active award for the same
 * key already existed and nothing was written.
 */
export function insertAward(db, award = {}) {
  const taskId = normalizedTaskId(award.taskId);
  if (!taskId) throw new Error("insertAward requires taskId");
  if (!award.subject || typeof award.subject !== "string") throw new Error("insertAward requires subject");
  const points = Number.isInteger(award.points) ? award.points : XP_RULES.pointsPerAcceptedRevision;
  const ruleVersion = award.ruleVersion || XP_RULES.version;
  const key = taskKey(taskId, award.repo, award.revision, ruleVersion);
  const recordedAt = award.recordedAt || now();
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db
      .prepare("SELECT id FROM reward_records WHERE dedup_key=? AND kind='award' AND active=1 LIMIT 1")
      .get(key);
    if (existing) {
      db.exec("COMMIT");
      return { ok: true, id: existing.id, duplicate: true };
    }
    const result = db
      .prepare(
        `INSERT INTO reward_records
           (kind, subject, role, task_id, repo, revision, run_id, evidence_id, model,
            rule_version, points, active, provenance, recorded_at, dedup_key)
         VALUES ('award', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(
        award.subject,
        taskId,
        award.repo ?? UNKNOWN,
        award.revision ?? UNKNOWN,
        award.runId ?? null,
        award.evidenceId ?? null,
        award.model ?? null,
        ruleVersion,
        points,
        award.provenance || "award: evidence accepted by ingestion",
        recordedAt,
        key,
      );
    db.exec("COMMIT");
    return { ok: true, id: Number(result.lastInsertRowid), duplicate: false };
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw err;
  }
}

/**
 * Insert a held award — evidence accepted but the producing run could not be
 * linked, so credit subject is 'unknown'. The row is written directly in its
 * final shape (active=0, no XP, held-scoped dedup key) inside one
 * BEGIN IMMEDIATE: replaying the same unresolved evidence yields exactly one
 * held row (duplicate=true, nothing written), and because the held key lives
 * in its own namespace the hold never blocks the real award inserted once the
 * link resolves. v1 instead committed an active award and demoted it with
 * post-commit UPDATEs — a crash in that window left an active award at
 * subject 'unknown' that hid from the held list and blocked the real award.
 */
export function insertHeldAward(db, award = {}) {
  const taskId = normalizedTaskId(award.taskId);
  if (!taskId) throw new Error("insertHeldAward requires taskId");
  const points = Number.isInteger(award.points) ? award.points : XP_RULES.pointsPerAcceptedRevision;
  const ruleVersion = award.ruleVersion || XP_RULES.version;
  const key = heldKey(taskKey(taskId, award.repo, award.revision, ruleVersion));
  const recordedAt = award.recordedAt || now();
  const provenance = `${award.provenance || "award: evidence accepted by ingestion"} [held: no linked producing run — subject unresolvable at ingest time]`;
  db.exec("BEGIN IMMEDIATE");
  try {
    // No active filter: a held row is always active=0 by construction, and
    // the held key cannot collide with an award key (separate namespace).
    const existing = db.prepare("SELECT id FROM reward_records WHERE dedup_key=? AND kind='award' LIMIT 1").get(key);
    if (existing) {
      db.exec("COMMIT");
      return { ok: true, id: existing.id, duplicate: true };
    }
    const result = db
      .prepare(
        `INSERT INTO reward_records
           (kind, subject, role, task_id, repo, revision, run_id, evidence_id, model,
            rule_version, points, active, provenance, recorded_at, dedup_key)
         VALUES ('award', '${UNKNOWN}', NULL, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      )
      .run(
        taskId,
        award.repo ?? UNKNOWN,
        award.revision ?? UNKNOWN,
        award.runId ?? null,
        award.evidenceId ?? null,
        award.model ?? null,
        ruleVersion,
        points,
        provenance,
        recordedAt,
        key,
      );
    db.exec("COMMIT");
    return { ok: true, id: Number(result.lastInsertRowid), duplicate: false };
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw err;
  }
}

/**
 * Record a revocation: the latest-round verdict for an awarded task turned
 * non-pass. The award row DEACTIVATES (its points leave the active sum) and
 * the revocation row is pure audit — points are recorded as −points for
 * legibility but active=0, so active XP returns to the pre-award state
 * instead of going negative. Revocation of an already-inactive award is a
 * no-op (the audit row would double otherwise).
 */
export function insertRevocation(db, revocation = {}) {
  const taskId = normalizedTaskId(revocation.taskId);
  if (!taskId) throw new Error("insertRevocation requires taskId");
  const ruleVersion = revocation.ruleVersion || XP_RULES.version;
  const key = taskKey(taskId, revocation.repo, revocation.revision, ruleVersion);
  const recordedAt = revocation.recordedAt || now();
  db.exec("BEGIN IMMEDIATE");
  try {
    const award = db
      .prepare("SELECT id, points, subject FROM reward_records WHERE dedup_key=? AND kind='award' AND active=1 LIMIT 1")
      .get(key);
    if (!award) {
      db.exec("COMMIT");
      return { ok: true, id: null, noop: true };
    }
    const result = db
      .prepare(
        `INSERT INTO reward_records
           (kind, subject, role, task_id, repo, revision, run_id, evidence_id, model,
            rule_version, points, active, provenance, recorded_at, dedup_key)
         VALUES ('revocation', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      )
      .run(
        award.subject,
        taskId,
        revocation.repo ?? UNKNOWN,
        revocation.revision ?? UNKNOWN,
        revocation.runId ?? null,
        revocation.evidenceId ?? null,
        revocation.model ?? null,
        ruleVersion,
        -(revocation.points ?? award.points),
        revocation.provenance || "revocation: latest-round verdict non-pass",
        recordedAt,
        key,
      );
    db.prepare("UPDATE reward_records SET active=0 WHERE id=?").run(award.id);
    db.exec("COMMIT");
    return { ok: true, id: Number(result.lastInsertRowid), noop: false };
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw err;
  }
}

/**
 * Insert a manager rating (human-authored, subjective, never points). The
 * previous active rating for the same (subject, task, run) is superseded —
 * NULL-safe via SQLite `IS` — and the full audit trail stays. Latest wins for
 * display; editing a rating never regenerates XP.
 */
export function insertRating(db, rating = {}) {
  if (!rating.subject || typeof rating.subject !== "string") throw new Error("insertRating requires subject");
  // Strictly a number: the HTTP layer must not be able to smuggle "3" or [3]
  // past a Number() coercion (review round 5).
  const value = rating.rating;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 5) {
    throw new Error("insertRating requires rating 1..5");
  }
  const taskId = normalizedTaskId(rating.taskId);
  const runId = rating.runId ?? null;
  const note = rating.note == null ? null : String(rating.note).slice(0, 500);
  const recordedAt = rating.recordedAt || now();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `UPDATE reward_records SET active=0
        WHERE kind='rating' AND active=1 AND subject=? AND task_id IS ? AND run_id IS ?`,
    ).run(rating.subject, taskId, runId);
    const result = db
      .prepare(
        `INSERT INTO reward_records
           (kind, subject, role, task_id, repo, revision, run_id, evidence_id, model,
            rule_version, points, active, rating, note, provenance, recorded_at, dedup_key)
         VALUES ('rating', ?, NULL, ?, '${UNKNOWN}', '${UNKNOWN}', ?, NULL, NULL, NULL, 0, 1, ?, ?, ?, ?, NULL)`,
      )
      .run(rating.subject, taskId, runId, value, note, rating.provenance ?? "manager rating (subjective) — human-authored", recordedAt);
    db.exec("COMMIT");
    return { ok: true, id: Number(result.lastInsertRowid) };
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw err;
  }
}

// ── bounded reads (no SELECT *, no unbounded scans) ─────────────────────────

/**
 * Current-state rewards for ONE squad subject. Active XP, the distinct
 * task-revision count (badge evidence) and the ≤10 newest records. Held
 * awards (subject 'unknown') are never part of a real squad's answer.
 */
export function querySquadRewards(db, subject) {
  if (!subject || typeof subject !== "string") throw new Error("querySquadRewards requires subject");
  const totals = db
    .prepare(
      `SELECT COALESCE(SUM(points), 0) AS xp,
              COUNT(DISTINCT CASE WHEN kind='award' THEN task_id || '|' || repo || '|' || revision END) AS distinct_revisions
         FROM reward_records WHERE active=1 AND subject=?`,
    )
    .get(subject);
  const recent = db
    .prepare(
      `SELECT id, kind, task_id AS taskId, repo, revision, run_id AS runId, evidence_id AS evidenceId,
              model, rule_version AS ruleVersion, points, active, rating, note, recorded_at AS recordedAt
         FROM reward_records WHERE subject=? ORDER BY id DESC LIMIT 10`,
    )
    .all(subject);
  return { subject, xp: totals.xp, distinctRevisions: totals.distinct_revisions, recent };
}

/**
 * Latest active ratings per (subject, task, run) — the display set. Bounded
 * to the 20 newest active rows; the UI picks the row matching a run/task.
 */
export function queryRatings(db, { limit = 20 } = {}) {
  return db
    .prepare(
      `SELECT id, subject, task_id AS taskId, run_id AS runId, rating, note, recorded_at AS recordedAt
         FROM reward_records WHERE kind='rating' AND active=1 ORDER BY id DESC LIMIT ?`,
    )
    .all(Number.isInteger(limit) && limit > 0 ? limit : 20);
}

/**
 * Active ratings for a bounded set of run ids — the scoped companion to
 * queryRatings. The 20-newest display cap hides honestly-recorded ratings
 * once more than 20 (task, run) pairs are rated; the Manager's rendered
 * History window must still resolve every visible row, so the payload builder
 * looks up exactly the run ids the window can show. Inputs are filtered to
 * run-id shape and capped (one indexed parameterized lookup, no scans);
 * ordering stays newest-first like queryRatings.
 */
export function queryRatingsForRuns(db, runIds = []) {
  const ids = [...new Set(
    (Array.isArray(runIds) ? runIds : [])
      .filter((id) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)),
  )].slice(0, 100);
  if (ids.length === 0) return [];
  return db
    .prepare(
      `SELECT id, subject, task_id AS taskId, run_id AS runId, rating, note, recorded_at AS recordedAt
         FROM reward_records WHERE kind='rating' AND active=1 AND run_id IN (${ids.map(() => "?").join(",")})
        ORDER BY id DESC`,
    )
    .all(...ids);
}

/**
 * Subjects holding active XP-bearing records — the squad list for the
 * rewards payload. The 'unknown' subject (held awards) is excluded: held
 * rows are surfaced by queryHeldAwards, never credited.
 */
export function queryRewardSubjects(db) {
  return db
    .prepare("SELECT DISTINCT subject FROM reward_records WHERE active=1 AND subject <> ? ORDER BY subject")
    .all(UNKNOWN)
    .map((row) => row.subject);
}

/**
 * Held awards — pass evidence whose credit subject could not be resolved at
 * ingest time. This is the "awaiting verified evidence" surface: never XP,
 * and a hold whose lineage later resolved (an active award with the same
 * task/repo/revision identity now exists) drops out of the list. Resolution
 * is matched on the natural evidence identity, NOT on dedup_key: the held row
 * carries a held-scoped key that can never equal an award's key.
 */
export function queryHeldAwards(db, { limit = 20 } = {}) {
  return db
    .prepare(
      `SELECT id, task_id AS taskId, repo, revision, evidence_id AS evidenceId, run_id AS runId,
              provenance, recorded_at AS recordedAt
         FROM reward_records
        WHERE subject=? AND kind='award' AND active=0
          AND NOT EXISTS (
            SELECT 1 FROM reward_records cur
             WHERE cur.kind='award' AND cur.active=1
               AND cur.task_id IS reward_records.task_id
               AND cur.repo IS reward_records.repo
               AND cur.revision IS reward_records.revision
          )
        ORDER BY id DESC LIMIT ?`,
    )
    .all(UNKNOWN, Number.isInteger(limit) && limit > 0 ? limit : 20);
}
