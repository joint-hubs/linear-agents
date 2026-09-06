// Tests for the reward ledger (FOC-225 slice 3, design: docs/ui/fenix-manager-rewards.md §5).
//
// Covers:
//   (a) dedicated store: fresh rewards.sqlite stamps the v1 marker; a close→
//       reopen cycle keeps every record (restart persistence);
//   (b) award semantics: replay dedup inside one BEGIN IMMEDIATE, concurrent
//       writers across two connections still yield exactly one award, the
//       revoke → re-accept → re-award cycle stays possible, cross-repo same
//       taskId yields two awards, absent repo/revision become 'unknown';
//   (c) revocation semantics: award deactivates, revocation row is audit
//       (active=0, points −100), active XP returns to the pre-award state,
//       revoking an inactive award is a no-op;
//   (d) rating semantics: NULL-safe supersession per (subject, task, run),
//       prior entries kept, latest wins, ratings never carry points;
//   (e) schema honesty: the record column set contains no secrets/prompt
//       columns (AC 14) and bounded reads return the allowlisted projection.
//
// Windows discipline: every handle is closed in `finally` BEFORE rmSync — a
// leaked handle turns the cleanup into EBUSY and would mask the real
// assertion error with a lock failure.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  REWARDS_SCHEMA_VERSION,
  REWARDS_MIGRATION_VERSIONS,
  XP_RULES,
  UNKNOWN,
  openRewardsDb,
  insertAward,
  insertHeldAward,
  insertRevocation,
  insertRating,
  querySquadRewards,
  queryRatings,
} from "./reward-ledger.mjs";

let DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}

let passed = 0;
let failed = 0;
let skipped = 0;

class TestSkip extends Error {}

function assert(value, message) {
  if (!value) throw new Error(message || "assertion failed");
}

function requireSqlite() {
  if (!DatabaseSync) throw new TestSkip("node:sqlite unavailable");
}

const testQueue = [];
function test(name, fn) {
  testQueue.push({ name, fn });
}

// Every opened handle lands here; the runner closes them all in finally.
function tracker() {
  const dbs = [];
  return {
    open(path) {
      const db = openRewardsDb(path);
      dbs.push(db);
      return db;
    },
    closeAll() {
      for (const db of dbs) {
        try { db.close(); } catch { /* already closed */ }
      }
    },
  };
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

const AWARD = {
  subject: "dev",
  taskId: "FOC-225",
  repo: "C:/repos/linear-agents",
  revision: "48e61f2",
  runId: "run-1",
  evidenceId: "supervisor/run-1/verdicts/foc-225-round1.json",
  model: "z-ai/glm-5.3-flash",
};

// ── scenarios ────────────────────────────────────────────────────────────────

test("xp rules: frozen constants with a version label", () => {
  assert(XP_RULES.version === "xp-rules v1", `version wrong: ${XP_RULES.version}`);
  assert(XP_RULES.pointsPerAcceptedRevision === 100, "points per revision wrong");
  assert(XP_RULES.xpPerLevel === 500, "xp per level wrong");
  assert(Object.isFrozen(XP_RULES), "XP_RULES must be frozen");
});

test("migration: fresh store stamps the v1 marker; reopen does not duplicate it", () => {
  requireSqlite();
  const dir = mkdtempSync(join(tmpdir(), "rewards-ledger-"));
  const h = tracker();
  try {
    const path = join(dir, "rewards.sqlite");
    const db = h.open(path);
    assert(REWARDS_SCHEMA_VERSION === 1, `schema version should be 1, got ${REWARDS_SCHEMA_VERSION}`);
    const marker = db.prepare("SELECT version FROM schema_migrations WHERE version=?").get(REWARDS_MIGRATION_VERSIONS.rewardsBase);
    assert(marker, "rewardsBase marker missing");
    const reopened = h.open(path);
    const markers = reopened.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get();
    assert(markers.n === 1, `reopen must not re-stamp, got ${markers.n} markers`);
  } finally {
    h.closeAll();
    cleanup(dir);
  }
});

test("restart persistence: records survive a close→reopen cycle", () => {
  requireSqlite();
  const dir = mkdtempSync(join(tmpdir(), "rewards-ledger-"));
  const h = tracker();
  try {
    const path = join(dir, "rewards.sqlite");
    const writer = h.open(path);
    insertAward(writer, AWARD);
    insertRating(writer, { subject: "dev", taskId: "FOC-225", runId: "run-1", rating: 4, note: "solid" });
    writer.close(); // simulate a process exit
    const reopened = h.open(path);
    const squad = querySquadRewards(reopened, "dev");
    assert(squad.xp === 100, `xp must survive reopen, got ${squad.xp}`);
    assert(squad.recent.length === 2, `records must survive reopen, got ${squad.recent.length}`);
  } finally {
    h.closeAll();
    cleanup(dir);
  }
});

test("award replay: re-ingesting the same evidence yields exactly one award", () => {
  requireSqlite();
  const dir = mkdtempSync(join(tmpdir(), "rewards-ledger-"));
  const h = tracker();
  try {
    const db = h.open(join(dir, "rewards.sqlite"));
    const first = insertAward(db, AWARD);
    const replay = insertAward(db, AWARD);
    assert(first.duplicate === false && first.ok, "first ingest must insert");
    assert(replay.duplicate === true && replay.ok, "replay must report duplicate, not fail");
    assert(replay.id === first.id, "replay must point at the existing award");
    const rows = db.prepare("SELECT COUNT(*) AS n FROM reward_records WHERE kind='award'").get();
    assert(rows.n === 1, `exactly one award row expected, got ${rows.n}`);
  } finally {
    h.closeAll();
    cleanup(dir);
  }
});

test("concurrent writers: two connections racing one award still insert exactly one", () => {
  requireSqlite();
  const dir = mkdtempSync(join(tmpdir(), "rewards-ledger-"));
  const h = tracker();
  try {
    const path = join(dir, "rewards.sqlite");
    h.open(path).close(); // schema exists before the race
    const a = h.open(path);
    const b = h.open(path);
    // BEGIN IMMEDIATE + busy_timeout serialize the two transactions; whichever
    // runs second must observe the first's active award and dedup away.
    const results = [insertAward(a, AWARD), insertAward(b, AWARD)];
    a.close();
    b.close();
    const duplicates = results.filter((r) => r.duplicate).length;
    assert(duplicates === 1, `exactly one writer must dedup, got ${duplicates} of ${results.length}`);
    const check = h.open(path);
    const rows = check.prepare("SELECT COUNT(*) AS n FROM reward_records WHERE kind='award'").get();
    const sum = check.prepare("SELECT COALESCE(SUM(points),0) AS xp FROM reward_records WHERE active=1").get();
    assert(rows.n === 1, `exactly one award row expected, got ${rows.n}`);
    assert(sum.xp === 100, `active xp must be 100, got ${sum.xp}`);
  } finally {
    h.closeAll();
    cleanup(dir);
  }
});

test("revoke → re-accept cycle: audit kept, active xp returns to 0 then re-awards", () => {
  requireSqlite();
  const dir = mkdtempSync(join(tmpdir(), "rewards-ledger-"));
  const h = tracker();
  try {
    const db = h.open(join(dir, "rewards.sqlite"));
    const awarded = insertAward(db, AWARD);
    assert(awarded.duplicate === false, "award must insert");

    const revoked = insertRevocation(db, {
      ...AWARD,
      runId: "run-review-1",
      evidenceId: "supervisor/run-review-1/verdicts/foc-225-round2.json",
      provenance: "latest-round verdict non-pass (round 2)",
    });
    assert(revoked.noop === false, "revocation of an active award must apply");
    let squad = querySquadRewards(db, "dev");
    assert(squad.xp === 0, `active xp must return to 0 after revoke, got ${squad.xp}`);
    const kinds = squad.recent.map((r) => `${r.kind}:${r.active}`).join(",");
    assert(kinds === "revocation:0,award:0", `audit rows must survive with flags moved: ${kinds}`);
    const revRow = squad.recent.find((r) => r.kind === "revocation");
    assert(revRow.points === -100, `revocation audit points must read −100, got ${revRow.points}`);
    assert(revRow.evidenceId.includes("round2"), "revocation must carry its own evidence id");

    // replay of the revoke (same evidence re-scanned) — the award is already
    // inactive, so this is a no-op, never a second revocation row
    const replayRevoke = insertRevocation(db, {
      ...AWARD,
      evidenceId: "supervisor/run-review-1/verdicts/foc-225-round2.json",
    });
    assert(replayRevoke.noop === true, "revoking an inactive award must be a no-op");
    const revCount = db.prepare("SELECT COUNT(*) AS n FROM reward_records WHERE kind='revocation'").get();
    assert(revCount.n === 1, `exactly one revocation row expected, got ${revCount.n}`);

    // re-acceptance: a NEW pass round re-awards the same task-revision
    const reaward = insertAward(db, {
      ...AWARD,
      runId: "run-3",
      evidenceId: "supervisor/run-3/verdicts/foc-225-round3.json",
    });
    assert(reaward.duplicate === false, "re-acceptance must re-award");
    squad = querySquadRewards(db, "dev");
    assert(squad.xp === 100, `active xp must be 100 after re-award, got ${squad.xp}`);
    assert(squad.distinctRevisions === 1, `one distinct revision despite 2 award rows, got ${squad.distinctRevisions}`);
    const awardCount = db.prepare("SELECT COUNT(*) AS n FROM reward_records WHERE kind='award'").get();
    assert(awardCount.n === 2, `both award rows must stay in the audit trail, got ${awardCount.n}`);
  } finally {
    h.closeAll();
    cleanup(dir);
  }
});

test("cross-repo same taskId: full repo+taskId identity yields two awards", () => {
  requireSqlite();
  const dir = mkdtempSync(join(tmpdir(), "rewards-ledger-"));
  const h = tracker();
  try {
    const db = h.open(join(dir, "rewards.sqlite"));
    const one = insertAward(db, { ...AWARD, repo: "C:/repos/linear-agents" });
    const two = insertAward(db, { ...AWARD, repo: "C:/repos/fenix" });
    assert(one.duplicate === false && two.duplicate === false, "different repos must not dedup");
    const rows = db.prepare("SELECT COUNT(*) AS n FROM reward_records WHERE kind='award'").get();
    assert(rows.n === 2, `two awards expected, got ${rows.n}`);
    const squad = querySquadRewards(db, "dev");
    assert(squad.xp === 200 && squad.distinctRevisions === 2, `xp/distinct wrong: ${squad.xp}/${squad.distinctRevisions}`);
  } finally {
    h.closeAll();
    cleanup(dir);
  }
});

test("absent repo/revision: sentinel 'unknown', never null", () => {
  requireSqlite();
  const dir = mkdtempSync(join(tmpdir(), "rewards-ledger-"));
  const h = tracker();
  try {
    const db = h.open(join(dir, "rewards.sqlite"));
    const first = insertAward(db, { ...AWARD, repo: undefined, revision: undefined });
    const row = db.prepare("SELECT repo, revision, dedup_key FROM reward_records WHERE id=?").get(first.id);
    assert(row.repo === UNKNOWN && row.revision === UNKNOWN, `sentinel missing: ${JSON.stringify(row)}`);
    assert(row.dedup_key.includes("|unknown|unknown|"), `dedup key must embed sentinels: ${row.dedup_key}`);
    // a second award with the SAME unresolved sentinels dedups (one accepted revision)
    const again = insertAward(db, { ...AWARD, repo: undefined, revision: undefined });
    assert(again.duplicate === true, "same task with unresolved sentinels must dedup");
    // a real value beats the sentinel: a resolved repo is a different key
    const resolved = insertAward(db, { ...AWARD, revision: undefined });
    assert(resolved.duplicate === false, "a resolved repo must not dedup against the sentinel award");
  } finally {
    h.closeAll();
    cleanup(dir);
  }
});

test("held award: subject 'unknown', active=0, later link resolution re-awards the real squad", () => {
  requireSqlite();
  const dir = mkdtempSync(join(tmpdir(), "rewards-ledger-"));
  const h = tracker();
  try {
    const db = h.open(join(dir, "rewards.sqlite"));
    const held = insertHeldAward(db, AWARD);
    assert(held.ok, "held award must write an audit row");
    const row = db.prepare("SELECT subject, active, provenance FROM reward_records WHERE id=?").get(held.id);
    assert(row.subject === UNKNOWN, `held award must sit at subject unknown, got ${row.subject}`);
    assert(row.active === 0, `held award must carry no xp, got active=${row.active}`);
    assert(row.provenance.includes("held:"), `provenance must document the hold: ${row.provenance}`);
    assert(querySquadRewards(db, "dev").xp === 0, "holding must not credit the squad");

    // later ingest pass resolves the link → the real squad gets its award
    const real = insertAward(db, AWARD);
    assert(real.duplicate === false, "resolved link must award despite the held row");
    const squad = querySquadRewards(db, "dev");
    assert(squad.xp === 100, `squad must be credited after resolution, got ${squad.xp}`);
    // and re-scanning the still-unlinked evidence must not produce a second held row
    const heldAgain = insertHeldAward(db, AWARD);
    assert(heldAgain.duplicate === true, "held evidence replay must dedup against the active award");
  } finally {
    h.closeAll();
    cleanup(dir);
  }
});

test("rating supersession: NULL-safe per (subject, task, run), prior kept, latest wins, no points", () => {
  requireSqlite();
  const dir = mkdtempSync(join(tmpdir(), "rewards-ledger-"));
  const h = tracker();
  try {
    const db = h.open(join(dir, "rewards.sqlite"));
    insertAward(db, AWARD); // 100 active xp — ratings must never touch it
    insertRating(db, { subject: "dev", taskId: "FOC-225", runId: "run-1", rating: 3, note: "first take" });
    insertRating(db, { subject: "dev", taskId: "FOC-225", runId: "run-1", rating: 5, note: "revised up" });
    insertRating(db, { subject: "dev", taskId: "FOC-901", runId: "run-1", rating: 2 }); // different task → own slot
    insertRating(db, { subject: "dev", taskId: null, runId: null, rating: 4 }); // NULL keys — IS must match only this slot

    const ratings = queryRatings(db);
    assert(ratings.length === 3, `only active ratings listed, got ${ratings.length}`);
    const foc225 = ratings.find((r) => r.taskId === "FOC-225");
    assert(foc225.rating === 5 && foc225.note === "revised up", `latest must win: ${JSON.stringify(foc225)}`);
    assert(ratings.find((r) => r.taskId === "FOC-901").rating === 2, "other task's rating must survive");
    assert(ratings.find((r) => r.taskId === null && r.runId === null).rating === 4, "NULL-keyed slot must survive the IS supersession");

    const all = db.prepare("SELECT COUNT(*) AS n FROM reward_records WHERE kind='rating'").get();
    assert(all.n === 4, `superseded entries must stay in the audit trail, got ${all.n}`);
    const squad = querySquadRewards(db, "dev");
    assert(squad.xp === 100, `a rating must never change xp, got ${squad.xp}`);
    assert(squad.recent.every((r) => r.kind !== "rating" || r.points === 0), "rating rows carry zero points");
  } finally {
    h.closeAll();
    cleanup(dir);
  }
});

test("validation: bad inputs are rejected before any write", () => {
  requireSqlite();
  const dir = mkdtempSync(join(tmpdir(), "rewards-ledger-"));
  const h = tracker();
  try {
    const db = h.open(join(dir, "rewards.sqlite"));
    const cases = [
      ["award without taskId", () => insertAward(db, { ...AWARD, taskId: undefined })],
      ["award without subject", () => insertAward(db, { ...AWARD, subject: "" })],
      ["revocation without taskId", () => insertRevocation(db, { ...AWARD, taskId: " " })],
      ["rating out of range", () => insertRating(db, { subject: "dev", taskId: "FOC-225", rating: 6 })],
      ["rating non-integer", () => insertRating(db, { subject: "dev", taskId: "FOC-225", rating: 4.5 })],
      ["rating without subject", () => insertRating(db, { taskId: "FOC-225", rating: 3 })],
      ["read without subject", () => querySquadRewards(db, "")],
    ];
    for (const [label, fn] of cases) {
      let threw = null;
      try { fn(); } catch (err) { threw = err.message; }
      assert(threw, `${label} must throw`);
    }
    const count = db.prepare("SELECT COUNT(*) AS n FROM reward_records").get();
    assert(count.n === 0, `rejected writes must leave no rows, got ${count.n}`);
  } finally {
    h.closeAll();
    cleanup(dir);
  }
});

test("schema honesty: record columns carry no secrets, prompts or tokens (AC 14)", () => {
  requireSqlite();
  const dir = mkdtempSync(join(tmpdir(), "rewards-ledger-"));
  const h = tracker();
  try {
    const db = h.open(join(dir, "rewards.sqlite"));
    insertAward(db, AWARD);
    insertRevocation(db, AWARD);
    insertRating(db, { subject: "dev", taskId: "FOC-225", runId: "run-1", rating: 4, note: "ok" });
    const columns = db.prepare("PRAGMA table_info(reward_records)").all().map((c) => c.name).sort();
    const expected = [
      "active", "dedup_key", "evidence_id", "id", "kind", "model", "note",
      "points", "provenance", "rating", "recorded_at", "repo", "revision",
      "role", "rule_version", "run_id", "subject", "task_id",
    ].sort();
    assert(
      JSON.stringify(columns) === JSON.stringify(expected),
      `column set drifted: ${columns}`,
    );
    const forbidden = /prompt|secret|token|password|api_key|apikey|credential/i;
    const offenders = columns.filter((c) => forbidden.test(c));
    assert(offenders.length === 0, `forbidden columns present: ${offenders}`);
    // one record of each kind, round-tripped: exactly the documented fields
    const rows = db
      .prepare(
        `SELECT id, kind, subject, role, task_id, repo, revision, run_id, evidence_id,
                model, rule_version, points, active, rating, note, provenance, recorded_at, dedup_key
           FROM reward_records ORDER BY id`,
      )
      .all();
    assert(rows.length === 3, `expected 3 records, got ${rows.length}`);
    for (const row of rows) {
      assert(Object.keys(row).length === expected.length, `row ${row.id} field count drifted`);
      assert(typeof row.recorded_at === "string" && !Number.isNaN(Date.parse(row.recorded_at)), "recorded_at must be an ISO timestamp");
      assert(typeof row.provenance === "string" && row.provenance.length > 0, "provenance is NOT NULL and non-empty");
    }
  } finally {
    h.closeAll();
    cleanup(dir);
  }
});

test("bounded reads: squad list caps at 10 and returns the allowlisted projection", () => {
  requireSqlite();
  const dir = mkdtempSync(join(tmpdir(), "rewards-ledger-"));
  const h = tracker();
  try {
    const db = h.open(join(dir, "rewards.sqlite"));
    for (let i = 1; i <= 14; i++) {
      insertAward(db, { ...AWARD, taskId: `FOC-${900 + i}`, runId: `run-${i}` });
    }
    const squad = querySquadRewards(db, "dev");
    assert(squad.xp === 1400, `xp sum wrong: ${squad.xp}`);
    assert(squad.recent.length === 10, `recent must cap at 10, got ${squad.recent.length}`);
    assert(squad.recent[0].taskId === "FOC-914", `newest first expected, got ${squad.recent[0].taskId}`);
    const keys = Object.keys(squad.recent[0]).sort();
    assert(
      JSON.stringify(keys) === JSON.stringify(
        ["active", "evidenceId", "id", "kind", "model", "note", "points", "rating", "recordedAt", "repo", "revision", "ruleVersion", "runId", "taskId"],
      ),
      `projection keys drifted: ${keys}`,
    );
  } finally {
    h.closeAll();
    cleanup(dir);
  }
});

// ── runner ───────────────────────────────────────────────────────────────────

for (const { name, fn } of testQueue) {
  try {
    await fn();
    passed++;
    console.log(`√ ${name}`);
  } catch (err) {
    if (err instanceof TestSkip) {
      skipped++;
      console.log(`- ${name} — ${err.message}`);
    } else {
      failed++;
      console.log(`× ${name}`);
      console.log(`  ${err && err.stack ? err.stack.split("\n").slice(0, 4).join("\n  ") : err}`);
    }
  }
}

console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}`);
process.exit(failed > 0 ? 1 : 0);
