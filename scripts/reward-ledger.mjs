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
//   - absent repo/revision are the sentinel 'unknown' (never NULL, never 0 —
//     SQLite UNIQUE/comparison does not collapse NULLs and silence is unknown);
//   - ratings supersede per (subject, task, run) with NULL-safe `IS`
//     comparisons; a rating never carries points.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const REWARDS_SCHEMA_VERSION = 1;

// Per-step migration markers, same pattern telemetry-store.mjs uses: a one-shot
// step is guarded by its own constant so bumping the shared version no longer
// re-arms older steps that already ran.
export const REWARDS_MIGRATION_VERSIONS = {
  rewardsBase: 1,
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
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(REWARDS_MIGRATION_VERSIONS.rewardsBase)) return;
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
  db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
    REWARDS_MIGRATION_VERSIONS.rewardsBase,
    new Date().toISOString(),
  );
}

function now() {
  return new Date().toISOString();
}

function taskKey(taskId, repo, revision, ruleVersion) {
  return [taskId ?? UNKNOWN, repo ?? UNKNOWN, revision ?? UNKNOWN, ruleVersion ?? UNKNOWN].join("|");
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
 * linked, so credit subject is 'unknown'. The row sits in the ledger for the
 * audit trail with active=0 (no XP); when a later ingest pass resolves the
 * link, the normal award path inserts a real active award because the dedup
 * pre-check only blocks ACTIVE awards.
 */
export function insertHeldAward(db, award = {}) {
  const inserted = insertAward(db, { ...award, subject: UNKNOWN });
  if (!inserted.duplicate) {
    db.prepare("UPDATE reward_records SET active=0 WHERE id=?").run(inserted.id);
    db.prepare("UPDATE reward_records SET provenance=? WHERE id=?").run(
      `${award.provenance || "award: evidence accepted by ingestion"} [held: no linked producing run — subject unresolvable at ingest time]`,
      inserted.id,
    );
  }
  return inserted;
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
  const value = Number(rating.rating);
  if (!Number.isInteger(value) || value < 1 || value > 5) throw new Error("insertRating requires rating 1..5");
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
 * dedup key now exists) drops out of the list.
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
             WHERE cur.dedup_key = reward_records.dedup_key AND cur.kind='award' AND cur.active=1
          )
        ORDER BY id DESC LIMIT ?`,
    )
    .all(UNKNOWN, Number.isInteger(limit) && limit > 0 ? limit : 20);
}
