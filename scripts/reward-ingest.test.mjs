// Tests for reward ingestion (FOC-225 slice 3): the only writer of awards and
// revocations, driven by supervisor verdict records under a tmp supervisor root.
//
// Covers:
//   (a) award path: pass verdict + linked producing run → one award with the
//       resolved subject/repo/model, evidence id and the v1 caveat in
//       provenance; replay stays idempotent;
//   (b) latest-round-wins: fail→pass awards, pass→fail revokes, pass after
//       revoke re-awards, replay of a revocation stays clean;
//   (c) held awards: no linked producing run or squad-less run → subject
//       'unknown', no XP, missing[] entry, awaiting list; replays across passes
//       stay one held row counted once; resolution re-awards;
//   (d) repo identity: cross-repo same taskId → two groups, two awards;
//       worktrees of one repo share the git common dir → one award, while
//       repos sharing a basename stay two;
//   (e) bounds and hygiene: scan limit, malformed records, absent root,
//       zero-award quiet store;
//   (f) cache: TTL window, single-flight sharing, reset;
//   (g) display payload: server facts only (rules, squads, ratings, held).

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  openTelemetryDb,
} from "./telemetry-store.mjs";
import {
  PROVENANCE_CAVEAT,
  REWARDS_INGEST_TTL_MS,
  ingestRewards,
  getCachedRewardIngest,
  resetRewardsIngestCache,
  buildRewardsPayload,
} from "./reward-ingest.mjs";
import {
  XP_RULES,
  UNKNOWN,
  openRewardsDb,
  insertRating,
  querySquadRewards,
  queryHeldAwards,
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

const FIXED_NOW = "2026-09-06T12:00:00.000Z";
const REPO_LA = "C:/repos/linear-agents";

// ── fixture helpers ──────────────────────────────────────────────────────────

function seedRun(db, { runId, squad, launchCwd = REPO_LA, startedAt = "2026-09-01T00:00:00.000Z" }) {
  db.prepare(
    `INSERT INTO runs (run_id, squad, source, brief, started_at, ended_at, status, exit_code,
       native, interactive, launch_cwd, claude_config_dir, session_id, transcript_path, price_set_id, updated_at)
     VALUES (?,?,'test',?,?,NULL,'running',NULL,'0','0',?,'C:/cfg',?,NULL,NULL,?)`,
  ).run(runId, squad, `brief for ${runId}`, startedAt, launchCwd, `sess-${runId}`, startedAt);
}

function seedLink(db, runId, taskId, { validFrom = "2026-09-01T00:05:00.000Z" } = {}) {
  db.prepare(
    "INSERT OR IGNORE INTO work_items (task_id, provider, workspace, identifier, created_at) VALUES (?,'linear','t',?,'2026-09-01T00:00:00.000Z')",
  ).run(taskId, taskId);
  db.prepare(
    `INSERT INTO run_task_links (link_id, run_id, task_id, role, valid_from, valid_to, source, confidence, created_at)
     VALUES (?,?,?,'primary',?,NULL,'launch',1,'2026-09-01T00:00:00.000Z')`,
  ).run(`link-${runId}-${taskId.toLowerCase()}`, runId, taskId, validFrom);
}

function seedUsage(db, runId, model, observedAt = "2026-09-01T00:10:00.000Z") {
  db.prepare(
    `INSERT INTO usage_facts (usage_id, run_id, session_id, agent_key, model, observed_at,
       input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, source_path, source_offset, created_at)
     VALUES (?,?,?,'implement',?, ?,10,5,0,0,'C:/t/x.jsonl',0,'2026-09-01T00:10:00.000Z')`,
  ).run(`u-${runId}-${model.replaceAll("/", "-")}`, runId, `sess-${runId}`, model, observedAt);
}

// A recorded workspace observation (what a hook / transcript scan would have
// written at event time) — lets the ingest resolve the run's LOGICAL repo via
// the git common dir without spawning git.
function seedWorkspace(db, runId, { cwd, commonDir, observedAt = "2026-09-01T00:02:00.000Z" }) {
  const repositoryId = `repo-${commonDir.toLowerCase()}`;
  db.prepare(
    "INSERT OR IGNORE INTO repositories (repository_id, common_dir, remote_url, created_at) VALUES (?,?,NULL,?)",
  ).run(repositoryId, commonDir, "2026-09-01T00:00:00.000Z");
  db.prepare(
    `INSERT INTO workspace_observations (run_id, observed_at, cwd, repository_id, worktree_id, ref_type, ref_name, head_sha, source)
     VALUES (?,?,?,?,NULL,'branch','main',NULL,'test')`,
  ).run(runId, observedAt, cwd, repositoryId);
}

function writeVerdict(root, runId, taskId, round, verdict, { recordedAt = "2026-09-05T10:00:00.000Z", squad = "review" } = {}) {
  const dir = join(root, runId, "verdicts");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${taskId.toLowerCase()}-round${round}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      taskId, runId, childId: `child-${round}`, squad, round, verdict,
      findings: [], acMapping: [], declaredAcs: [], fingerprint: { combined: "fp" }, recordedAt,
    }),
    "utf8",
  );
  return file;
}

// Full harness: tmp supervisor root + telemetry db + rewards db, all cleaned up.
function harness() {
  const dir = mkdtempSync(join(tmpdir(), "rewards-ingest-"));
  const telemetryDb = openTelemetryDb(join(dir, "telemetry.sqlite"));
  const rewardsDb = openRewardsDb(join(dir, "rewards.sqlite"));
  const supervisorRoot = join(dir, "supervisor");
  mkdirSync(supervisorRoot, { recursive: true });
  const deps = { supervisorRoot, telemetryDb, rewardsDb, now: () => FIXED_NOW };
  return {
    dir, telemetryDb, rewardsDb, supervisorRoot, deps,
    cleanup() {
      for (const db of [telemetryDb, rewardsDb]) {
        try { db.close(); } catch { /* already closed */ }
      }
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

// ── scenarios ────────────────────────────────────────────────────────────────

test("award: pass verdict + linked producing run → one resolved award", () => {
  requireSqlite();
  resetRewardsIngestCache();
  const h = harness();
  try {
    seedRun(h.telemetryDb, { runId: "run-a", squad: "dev", launchCwd: REPO_LA });
    seedLink(h.telemetryDb, "run-a", "FOC-500");
    seedUsage(h.telemetryDb, "run-a", "z-ai/glm-5.3-flash");
    writeVerdict(h.supervisorRoot, "run-a", "FOC-500", 1, "pass");

    const result = ingestRewards(h.deps);
    assert(result.awarded === 1 && result.held === 0 && result.revoked === 0, `counters wrong: ${JSON.stringify(result)}`);
    assert(result.scannedRuns === 1, `scannedRuns wrong: ${result.scannedRuns}`);

    const squad = querySquadRewards(h.rewardsDb, "dev");
    assert(squad.xp === 100 && squad.distinctRevisions === 1, `xp wrong: ${squad.xp}/${squad.distinctRevisions}`);
    const award = squad.recent.find((r) => r.kind === "award");
    assert(award.taskId === "FOC-500" && award.points === 100, `award projection wrong: ${JSON.stringify(award)}`);
    const row = h.rewardsDb.prepare("SELECT subject, repo, revision, run_id, evidence_id, model, rule_version, provenance FROM reward_records WHERE kind='award'").get();
    assert(row.subject === "dev", `subject wrong: ${row.subject}`);
    assert(row.repo === "c:/repos/linear-agents", `repo must be the normalized recording cwd: ${row.repo}`);
    assert(row.revision === UNKNOWN, `revision must be the v1 sentinel: ${row.revision}`);
    assert(row.run_id === "run-a", `award run must be the producing run: ${row.run_id}`);
    assert(row.evidence_id === "supervisor/run-a/verdicts/foc-500-round1.json", `evidence id wrong: ${row.evidence_id}`);
    assert(row.model === "z-ai/glm-5.3-flash", `model wrong: ${row.model}`);
    assert(row.rule_version === XP_RULES.version, `rule version wrong: ${row.rule_version}`);
    assert(row.provenance.includes(PROVENANCE_CAVEAT), `caveat must be stamped verbatim: ${row.provenance}`);
    assert(row.provenance.includes("round 1"), `provenance must name the round: ${row.provenance}`);
    // the one documented v1 gap: no prompt/config revision in verdict records
    assert(
      result.missing.some((m) => m.ref === "rewards" && m.field === "revision"),
      `revision gap must be documented once: ${JSON.stringify(result.missing)}`,
    );
    assert(result.missing.filter((m) => m.field === "revision").length === 1, "revision gap must appear exactly once per pass");
  } finally {
    h.cleanup();
  }
});

test("replay: re-ingesting the same evidence awards nothing more", () => {
  requireSqlite();
  resetRewardsIngestCache();
  const h = harness();
  try {
    seedRun(h.telemetryDb, { runId: "run-a", squad: "dev" });
    seedLink(h.telemetryDb, "run-a", "FOC-500");
    writeVerdict(h.supervisorRoot, "run-a", "FOC-500", 1, "pass");
    ingestRewards(h.deps);
    const replay = ingestRewards(h.deps);
    assert(replay.awarded === 0 && replay.duplicated === 1, `replay counters wrong: ${JSON.stringify(replay)}`);
    assert(querySquadRewards(h.rewardsDb, "dev").xp === 100, "replay must not multiply xp");
    const rows = h.rewardsDb.prepare("SELECT COUNT(*) AS n FROM reward_records WHERE kind='award'").get();
    assert(rows.n === 1, `exactly one award row after replay, got ${rows.n}`);
  } finally {
    h.cleanup();
  }
});

test("latest round wins: a retried fail→pass awards in one scan", () => {
  requireSqlite();
  resetRewardsIngestCache();
  const h = harness();
  try {
    seedRun(h.telemetryDb, { runId: "run-a", squad: "dev" });
    seedLink(h.telemetryDb, "run-a", "FOC-600");
    writeVerdict(h.supervisorRoot, "run-a", "FOC-600", 1, "fail", { recordedAt: "2026-09-05T10:00:00.000Z" });
    writeVerdict(h.supervisorRoot, "run-a", "FOC-600", 2, "pass", { recordedAt: "2026-09-05T11:00:00.000Z" });

    const result = ingestRewards(h.deps);
    assert(result.awarded === 1 && result.revoked === 0, `the pass round must drive the state: ${JSON.stringify(result)}`);
    assert(querySquadRewards(h.rewardsDb, "dev").xp === 100, "the retried pass must award");
  } finally {
    h.cleanup();
  }
});

test("pass→fail revokes across scans (evidence arrives over time)", () => {
  requireSqlite();
  resetRewardsIngestCache();
  const h = harness();
  try {
    seedRun(h.telemetryDb, { runId: "run-a", squad: "dev" });
    seedLink(h.telemetryDb, "run-a", "FOC-601");
    writeVerdict(h.supervisorRoot, "run-a", "FOC-601", 1, "pass", { recordedAt: "2026-09-05T10:30:00.000Z" });
    assert(ingestRewards(h.deps).awarded === 1, "first scan awards the pass");

    writeVerdict(h.supervisorRoot, "run-a", "FOC-601", 2, "fail", { recordedAt: "2026-09-05T11:30:00.000Z" });
    const result = ingestRewards(h.deps);
    assert(result.awarded === 0 && result.revoked === 1, `counters wrong: ${JSON.stringify(result)}`);
    assert(querySquadRewards(h.rewardsDb, "dev").xp === 0, "the overturned award must stop counting");

    const revRow = h.rewardsDb.prepare("SELECT points, active, evidence_id FROM reward_records WHERE kind='revocation'").get();
    assert(revRow.points === -100 && revRow.active === 0, `revocation row wrong: ${JSON.stringify(revRow)}`);
    assert(revRow.evidence_id.includes("foc-601-round2.json"), `revocation must cite its own evidence: ${revRow.evidence_id}`);
  } finally {
    h.cleanup();
  }
});

test("revocation replay stays clean; a later pass re-awards", () => {
  requireSqlite();
  resetRewardsIngestCache();
  const h = harness();
  try {
    seedRun(h.telemetryDb, { runId: "run-a", squad: "dev" });
    seedLink(h.telemetryDb, "run-a", "FOC-601");
    writeVerdict(h.supervisorRoot, "run-a", "FOC-601", 1, "pass", { recordedAt: "2026-09-05T10:00:00.000Z" });
    ingestRewards(h.deps);
    writeVerdict(h.supervisorRoot, "run-a", "FOC-601", 2, "fail", { recordedAt: "2026-09-05T11:00:00.000Z" });
    ingestRewards(h.deps);
    const replay = ingestRewards(h.deps);
    assert(replay.revoked === 0, `revocation replay must be a no-op: ${JSON.stringify(replay)}`);
    const revCount = h.rewardsDb.prepare("SELECT COUNT(*) AS n FROM reward_records WHERE kind='revocation'").get();
    assert(revCount.n === 1, `no second revocation row, got ${revCount.n}`);

    writeVerdict(h.supervisorRoot, "run-a", "FOC-601", 3, "pass", { recordedAt: "2026-09-05T12:00:00.000Z" });
    const reaccept = ingestRewards(h.deps);
    assert(reaccept.awarded === 1, `re-acceptance must re-award: ${JSON.stringify(reaccept)}`);
    assert(querySquadRewards(h.rewardsDb, "dev").xp === 100, "xp must be restored");
    const awards = h.rewardsDb.prepare("SELECT COUNT(*) AS n FROM reward_records WHERE kind='award'").get();
    assert(awards.n === 2, `audit keeps both award rows, got ${awards.n}`);
  } finally {
    h.cleanup();
  }
});

test("held: no linked producing run → subject unknown, no xp, awaiting; resolution re-awards", () => {
  requireSqlite();
  resetRewardsIngestCache();
  const h = harness();
  try {
    seedRun(h.telemetryDb, { runId: "run-a", squad: "dev" });
    writeVerdict(h.supervisorRoot, "run-a", "FOC-700", 1, "pass");
    const result = ingestRewards(h.deps);
    assert(result.held === 1 && result.awarded === 0, `held counters wrong: ${JSON.stringify(result)}`);
    assert(querySquadRewards(h.rewardsDb, "dev").xp === 0, "held award must not credit any squad");
    const held = queryHeldAwards(h.rewardsDb);
    assert(held.length === 1 && held[0].taskId === "FOC-700", `awaiting list wrong: ${JSON.stringify(held)}`);
    assert(
      result.missing.some((m) => m.field === "subject" && m.reason.includes("no linked producing run")),
      `missing[] must document the hold: ${JSON.stringify(result.missing)}`,
    );
    const row = h.rewardsDb.prepare("SELECT subject, active, provenance FROM reward_records WHERE kind='award'").get();
    assert(row.subject === UNKNOWN && row.active === 0, `held row wrong: ${JSON.stringify(row)}`);
    assert(row.provenance.includes("[held:"), `hold must be visible in provenance: ${row.provenance}`);

    // the link appears in a later pass → the real squad is credited
    seedLink(h.telemetryDb, "run-a", "FOC-700");
    const resolved = ingestRewards(h.deps);
    assert(resolved.awarded === 1, `resolution must award: ${JSON.stringify(resolved)}`);
    assert(querySquadRewards(h.rewardsDb, "dev").xp === 100, "resolved squad must be credited");
    assert(queryHeldAwards(h.rewardsDb).length === 0, "resolved hold must drop out of the awaiting list");
  } finally {
    h.cleanup();
  }
});

test("held replay: unresolved evidence re-scanned by later passes stays one held row, counted once", () => {
  requireSqlite();
  resetRewardsIngestCache();
  const h = harness();
  try {
    seedRun(h.telemetryDb, { runId: "run-a", squad: "dev" });
    writeVerdict(h.supervisorRoot, "run-a", "FOC-920", 1, "pass");
    const first = ingestRewards(h.deps);
    assert(first.held === 1 && first.awarded === 0, `first pass must hold: ${JSON.stringify(first)}`);

    // the Manager polls ~every 30 s: passes 2..N ride the same unresolved
    // evidence and must neither mint rows nor re-count the hold
    for (let pass = 2; pass <= 4; pass++) {
      const replay = ingestRewards(h.deps);
      assert(replay.held === 0 && replay.awarded === 0, `pass ${pass} must be a no-op: ${JSON.stringify(replay)}`);
    }
    const rows = h.rewardsDb.prepare("SELECT COUNT(*) AS n FROM reward_records WHERE kind='award'").get();
    assert(rows.n === 1, `exactly one held row across four passes, got ${rows.n}`);
    assert(queryHeldAwards(h.rewardsDb).length === 1, "the hold must stay on the awaiting list while unresolved");

    // resolution still awards the real squad, and the next replay is a plain duplicate
    seedLink(h.telemetryDb, "run-a", "FOC-920");
    const resolved = ingestRewards(h.deps);
    assert(resolved.awarded === 1, `resolution must award: ${JSON.stringify(resolved)}`);
    assert(querySquadRewards(h.rewardsDb, "dev").xp === 100, "resolved squad must be credited");
    const after = ingestRewards(h.deps);
    assert(after.duplicated === 1 && after.held === 0, `post-resolution replay wrong: ${JSON.stringify(after)}`);
  } finally {
    h.cleanup();
  }
});

test("held: producing run without squad → subject unknown + missing[]", () => {
  requireSqlite();
  resetRewardsIngestCache();
  const h = harness();
  try {
    seedRun(h.telemetryDb, { runId: "run-a", squad: null });
    seedLink(h.telemetryDb, "run-a", "FOC-701");
    writeVerdict(h.supervisorRoot, "run-a", "FOC-701", 1, "pass");
    const result = ingestRewards(h.deps);
    assert(result.held === 1, `must hold: ${JSON.stringify(result)}`);
    assert(
      result.missing.some((m) => m.field === "subject" && m.reason.includes("no squad recorded")),
      `missing[] must name the squad gap: ${JSON.stringify(result.missing)}`,
    );
  } finally {
    h.cleanup();
  }
});

test("cross-repo same taskId: recording cwd separates the groups → two awards", () => {
  requireSqlite();
  resetRewardsIngestCache();
  const h = harness();
  try {
    seedRun(h.telemetryDb, { runId: "run-one", squad: "dev", launchCwd: "C:/repos/one" });
    seedRun(h.telemetryDb, { runId: "run-two", squad: "dev", launchCwd: "C:/repos/two" });
    seedLink(h.telemetryDb, "run-one", "FOC-800", { validFrom: "2026-09-01T00:05:00.000Z" });
    seedLink(h.telemetryDb, "run-two", "FOC-800", { validFrom: "2026-09-01T00:06:00.000Z" });
    writeVerdict(h.supervisorRoot, "run-one", "FOC-800", 1, "pass", { recordedAt: "2026-09-05T10:00:00.000Z" });
    writeVerdict(h.supervisorRoot, "run-two", "FOC-800", 1, "pass", { recordedAt: "2026-09-05T10:05:00.000Z" });

    const result = ingestRewards(h.deps);
    assert(result.awarded === 2 && result.groups === 2, `cross-repo must award twice: ${JSON.stringify(result)}`);
    const repos = h.rewardsDb.prepare("SELECT repo FROM reward_records WHERE kind='award' AND active=1 ORDER BY repo").all().map((r) => r.repo);
    assert(JSON.stringify(repos) === JSON.stringify(["c:/repos/one", "c:/repos/two"]), `repos wrong: ${repos}`);
    const squad = querySquadRewards(h.rewardsDb, "dev");
    assert(squad.xp === 200 && squad.distinctRevisions === 2, `xp/distinct wrong: ${squad.xp}/${squad.distinctRevisions}`);
  } finally {
    h.cleanup();
  }
});

test("repo identity: two worktrees of one repo share the git common dir → one award; same-basename repos stay two", () => {
  requireSqlite();
  resetRewardsIngestCache();
  const h = harness();
  try {
    // the same accepted revision re-reviewed from ANOTHER checkout of the same
    // repo (a worktree) — both recording runs share one git common dir
    seedRun(h.telemetryDb, { runId: "run-main", squad: "dev", launchCwd: "C:/repos/linear-agents" });
    seedRun(h.telemetryDb, { runId: "run-wt", squad: "dev", launchCwd: "C:/repos/linear-agents/wt-foc-225" });
    seedWorkspace(h.telemetryDb, "run-main", { cwd: "C:/repos/linear-agents", commonDir: "C:/repos/linear-agents/.git" });
    seedWorkspace(h.telemetryDb, "run-wt", { cwd: "C:/repos/linear-agents/wt-foc-225", commonDir: "C:/repos/linear-agents/.git" });
    seedLink(h.telemetryDb, "run-main", "FOC-910");
    seedLink(h.telemetryDb, "run-wt", "FOC-910");
    writeVerdict(h.supervisorRoot, "run-main", "FOC-910", 1, "pass", { recordedAt: "2026-09-05T10:00:00.000Z" });
    writeVerdict(h.supervisorRoot, "run-wt", "FOC-910", 2, "pass", { recordedAt: "2026-09-05T11:00:00.000Z" });

    // two genuinely different repos that merely share a basename stay separate
    seedRun(h.telemetryDb, { runId: "run-a", squad: "dev", launchCwd: "C:/repos/la" });
    seedRun(h.telemetryDb, { runId: "run-b", squad: "dev", launchCwd: "C:/repos/other/la" });
    seedWorkspace(h.telemetryDb, "run-a", { cwd: "C:/repos/la", commonDir: "C:/repos/la/.git" });
    seedWorkspace(h.telemetryDb, "run-b", { cwd: "C:/repos/other/la", commonDir: "C:/repos/other/la/.git" });
    seedLink(h.telemetryDb, "run-a", "FOC-911");
    seedLink(h.telemetryDb, "run-b", "FOC-911");
    writeVerdict(h.supervisorRoot, "run-a", "FOC-911", 1, "pass", { recordedAt: "2026-09-05T10:05:00.000Z" });
    writeVerdict(h.supervisorRoot, "run-b", "FOC-911", 1, "pass", { recordedAt: "2026-09-05T10:10:00.000Z" });

    const result = ingestRewards(h.deps);
    assert(result.groups === 3, `worktree evidence must group with its repo, same-basename repos must not: ${JSON.stringify(result)}`);
    assert(result.awarded === 3, `one award per accepted revision, not per checkout: ${JSON.stringify(result)}`);
    const repos = h.rewardsDb
      .prepare("SELECT repo FROM reward_records WHERE kind='award' AND active=1 ORDER BY repo")
      .all()
      .map((r) => r.repo);
    assert(
      JSON.stringify(repos) === JSON.stringify([
        "c:/repos/la/.git",
        "c:/repos/linear-agents/.git",
        "c:/repos/other/la/.git",
      ]),
      `repo identity must be the git common dir: ${repos}`,
    );
    const worktreeAward = h.rewardsDb
      .prepare("SELECT provenance, run_id FROM reward_records WHERE repo='c:/repos/linear-agents/.git' AND kind='award' AND active=1")
      .get();
    assert(worktreeAward.provenance.includes("git common dir"), `provenance must name the identity surface: ${worktreeAward.provenance}`);
    assert(
      worktreeAward.provenance.includes("C:/repos/linear-agents/wt-foc-225"),
      `provenance must keep the raw checkout path: ${worktreeAward.provenance}`,
    );
    assert(querySquadRewards(h.rewardsDb, "dev").xp === 300 && querySquadRewards(h.rewardsDb, "dev").distinctRevisions === 3, "xp must match the award count");
  } finally {
    h.cleanup();
  }
});

test("a non-pass verdict only revokes its own repo lineage", () => {
  requireSqlite();
  resetRewardsIngestCache();
  const h = harness();
  try {
    seedRun(h.telemetryDb, { runId: "run-one", squad: "dev", launchCwd: "C:/repos/one" });
    seedRun(h.telemetryDb, { runId: "run-two", squad: "dev", launchCwd: "C:/repos/two" });
    seedLink(h.telemetryDb, "run-one", "FOC-810", { validFrom: "2026-09-01T00:05:00.000Z" });
    seedLink(h.telemetryDb, "run-two", "FOC-810", { validFrom: "2026-09-01T00:06:00.000Z" });
    writeVerdict(h.supervisorRoot, "run-one", "FOC-810", 1, "pass", { recordedAt: "2026-09-05T10:00:00.000Z" });
    writeVerdict(h.supervisorRoot, "run-two", "FOC-810", 1, "pass", { recordedAt: "2026-09-05T10:05:00.000Z" });
    ingestRewards(h.deps);
    // a later non-pass in repo two must not touch repo one's award
    writeVerdict(h.supervisorRoot, "run-two", "FOC-810", 2, "fail", { recordedAt: "2026-09-05T11:00:00.000Z" });
    const result = ingestRewards(h.deps);
    assert(result.revoked === 1, `one lineage revoked: ${JSON.stringify(result)}`);
    const active = h.rewardsDb.prepare("SELECT repo FROM reward_records WHERE kind='award' AND active=1").all().map((r) => r.repo);
    assert(JSON.stringify(active) === JSON.stringify(["c:/repos/one"]), `surviving award wrong: ${active}`);
  } finally {
    h.cleanup();
  }
});

test("scan bound: only the newest N run dirs are ingested, and the cut is documented", () => {
  requireSqlite();
  resetRewardsIngestCache();
  const h = harness();
  try {
    for (let i = 1; i <= 3; i++) {
      const runId = `run-${i}`;
      seedRun(h.telemetryDb, { runId, squad: "dev", startedAt: new Date(Date.UTC(2026, 8, i)).toISOString() });
      seedLink(h.telemetryDb, runId, `FOC-90${i}`);
      writeVerdict(h.supervisorRoot, runId, `FOC-90${i}`, 1, "pass");
    }
    const deps = { ...h.deps, scanLimit: 2 };
    const result = ingestRewards(deps);
    assert(result.scannedRuns === 2 && result.awarded === 2, `bound scan wrong: ${JSON.stringify(result)}`);
    assert(
      result.missing.some((m) => m.field === "scan" && m.reason.includes("1 older run dirs")),
      `scan cut must be documented: ${JSON.stringify(result.missing)}`,
    );
  } finally {
    h.cleanup();
  }
});

test("malformed verdict records are documented and skipped, good ones still ingest", () => {
  requireSqlite();
  resetRewardsIngestCache();
  const h = harness();
  try {
    seedRun(h.telemetryDb, { runId: "run-a", squad: "dev" });
    seedLink(h.telemetryDb, "run-a", "FOC-950");
    mkdirSync(join(h.supervisorRoot, "run-a", "verdicts"), { recursive: true });
    writeFileSync(join(h.supervisorRoot, "run-a", "verdicts", "broken-round1.json"), "{not json", "utf8");
    writeFileSync(
      join(h.supervisorRoot, "run-a", "verdicts", "incomplete-round1.json"),
      JSON.stringify({ taskId: "FOC-951", verdict: "pass" }), // no round/recordedAt
      "utf8",
    );
    writeVerdict(h.supervisorRoot, "run-a", "FOC-950", 1, "pass");
    const result = ingestRewards(h.deps);
    assert(result.awarded === 1, `good record must ingest: ${JSON.stringify(result)}`);
    assert(
      result.missing.some((m) => m.reason.includes("unreadable")),
      `unreadable must be documented: ${JSON.stringify(result.missing)}`,
    );
    assert(
      result.missing.some((m) => m.reason.includes("missing required fields")),
      `incomplete must be documented: ${JSON.stringify(result.missing)}`,
    );
  } finally {
    h.cleanup();
  }
});

test("absent supervisor root: documented, zero actions, no throw", () => {
  requireSqlite();
  resetRewardsIngestCache();
  const h = harness();
  try {
    const result = ingestRewards({ ...h.deps, supervisorRoot: join(h.dir, "missing-root") });
    assert(result.awarded === 0 && result.scannedRuns === 0, `no actions expected: ${JSON.stringify(result)}`);
    assert(
      result.missing.some((m) => m.reason.includes("no supervisor root configured")),
      `absent root must be documented: ${JSON.stringify(result.missing)}`,
    );
    const empty = ingestRewards({ ...h.deps, supervisorRoot: h.supervisorRoot });
    assert(empty.awarded === 0 && empty.scannedRuns === 0, "empty root is quiet, not an error");
  } finally {
    h.cleanup();
  }
});

test("cache: TTL window, single-flight sharing, reset", async () => {
  requireSqlite();
  resetRewardsIngestCache();
  const h = harness();
  try {
    seedRun(h.telemetryDb, { runId: "run-a", squad: "dev" });
    seedLink(h.telemetryDb, "run-a", "FOC-500");
    writeVerdict(h.supervisorRoot, "run-a", "FOC-500", 1, "pass");
    let clock = 1_000;
    const deps = { ...h.deps, nowMs: () => clock };

    const first = await getCachedRewardIngest(deps);
    assert(first.source === "fresh" && first.result.awarded === 1, `first call must be fresh: ${first.source}`);
    const second = await getCachedRewardIngest(deps);
    assert(second.source === "cached" && second.result === first.result, "within TTL the same object must come back");

    clock += REWARDS_INGEST_TTL_MS + 1;
    const expired = await getCachedRewardIngest(deps);
    assert(expired.source === "fresh", "past the TTL a new pass must run");
    assert(expired.result !== first.result, "a new pass must produce a new result object");

    // single-flight: two overlapping first-calls share one promise
    resetRewardsIngestCache();
    const [a, b] = await Promise.all([getCachedRewardIngest(deps), getCachedRewardIngest(deps)]);
    assert(a.source === "fresh" && b.source === "cached" && a.result === b.result, `single-flight broken: ${a.source}/${b.source}`);

    resetRewardsIngestCache();
    const afterReset = await getCachedRewardIngest(deps);
    assert(afterReset.source === "fresh", "reset must drop the cached window");
  } finally {
    h.cleanup();
  }
});

test("display payload: server facts only — rules, squads, ratings, held, ingest", async () => {
  requireSqlite();
  resetRewardsIngestCache();
  const h = harness();
  try {
    seedRun(h.telemetryDb, { runId: "run-a", squad: "dev" });
    seedRun(h.telemetryDb, { runId: "run-b", squad: "plan" });
    seedLink(h.telemetryDb, "run-a", "FOC-500");
    seedLink(h.telemetryDb, "run-b", "FOC-501", { validFrom: "2026-09-01T00:06:00.000Z" });
    writeVerdict(h.supervisorRoot, "run-a", "FOC-500", 1, "pass");
    writeVerdict(h.supervisorRoot, "run-b", "FOC-502", 1, "pass"); // run-b linked to FOC-501, verdict for 502 → held
    insertRating(h.rewardsDb, { subject: "dev", taskId: "FOC-500", runId: "run-a", rating: 4, note: "solid" });

    const payload = await buildRewardsPayload(h.deps);
    assert(JSON.stringify(payload.rules) === JSON.stringify({ ...XP_RULES }), `rules must pass through: ${JSON.stringify(payload.rules)}`);
    assert(payload.squads.dev.xp === 100 && payload.squads.dev.distinctRevisions === 1, `dev squad wrong: ${JSON.stringify(payload.squads.dev)}`);
    assert(payload.squads.dev.recent.length === 2, "recent records: the award + the rating");
    assert(payload.ratings.length === 1 && payload.ratings[0].rating === 4, `ratings wrong: ${JSON.stringify(payload.ratings)}`);
    assert(payload.held.length === 1 && payload.held[0].taskId === "FOC-502", `held wrong: ${JSON.stringify(payload.held)}`);
    assert(payload.ingest.awarded === 1 && payload.ingest.held === 1, `ingest diagnostics wrong: ${JSON.stringify(payload.ingest)}`);
    assert(payload.source === "fresh", "first payload build is fresh");
    const again = await buildRewardsPayload(h.deps);
    assert(again.source === "cached" && again.generatedAt >= payload.generatedAt, "second payload build rides the cache");
  } finally {
    resetRewardsIngestCache();
    h.cleanup();
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
