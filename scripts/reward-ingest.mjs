// Reward ingestion — the ONLY module that turns supervisor evidence into
// awards/revocations (FOC-225 slice 3; design: docs/ui/fenix-manager-rewards.md §2).
//
// Flow: the GET /api/manager/rewards route calls getCachedRewardIngest() first;
// this module scans the ≤20 newest supervisor run dirs (same bound as the
// manager snapshot), reads verdict records, and drives the reward ledger.
//
// Evidence semantics (v1, documented limitations):
//   - only VALIDATED ingestion generates XP; there is no backfill (§2.2) —
//     verdict files that existed before the ledger are ingested the same way,
//     replay is idempotent by dedup, nothing is "imported" outside this path;
//   - the browser can never submit XP (AC 2) — this module is the sole writer;
//   - per (task, repo) group the LATEST verdict wins: retries and re-reviews
//     within a lineage never multiply awards, and a newer non-pass revokes;
//   - repo comes from the RECORDING run's launch_cwd (the run whose artifacts
//     hold the verdict — same repo as the delivery); subject comes from the
//     producing run's squad via the task's primary run_task_links link (the
//     verdict's own squad field is the REVIEW child's squad — wrong credit);
//   - prompt/config revision is not carried by verdict records — stored as
//     the 'unknown' sentinel and reported once per pass in missing[];
//   - a pass verdict with no resolvable subject is HELD: an audit row at
//     subject 'unknown', active=0 (no XP) + a missing[] entry; when a later
//     pass resolves the link the real award is inserted (dedup only blocks
//     ACTIVE awards);
//   - revocation is VERDICT-DRIVEN ONLY (supervisor decision 2): a Linear
//     reopen without a new non-pass verdict round does not revoke;
//   - provenance stamps the supervisor decision verbatim: a supervisor pass
//     verdict is acceptance evidence; the missing REVIEW/TEST stage marker is
//     the documented v1 caveat.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { MANAGER_SNAPSHOT_SCAN_LIMIT } from "./manager-snapshot.mjs";
import {
  XP_RULES,
  UNKNOWN,
  insertAward,
  insertHeldAward,
  insertRevocation,
  queryRewardSubjects,
  querySquadRewards,
  queryRatings,
  queryHeldAwards,
} from "./reward-ledger.mjs";

export const REWARDS_INGEST_TTL_MS = 30_000; // single-flight cache window

// Supervisor decision 1 (2026-09-06), stamped verbatim into award provenance.
export const PROVENANCE_CAVEAT =
  "a supervisor pass verdict is acceptance evidence; the missing REVIEW/TEST stage marker is the documented v1 caveat";

export function missing(list, ref, field, reason) {
  if (!list.some((m) => m.ref === ref && m.field === field && m.reason === reason)) {
    list.push({ ref, field, reason });
  }
}

// Windows-launch-cwd → stable repo identity (forward slashes, no trailing
// separator, case-folded: two runs in the same worktree must produce one key).
function normalizeRepo(cwd) {
  if (cwd == null) return null;
  const normalized = String(cwd).replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
  return normalized || null;
}

function toMissingEntry(err) {
  return String(err?.message || err || "unknown error");
}

// One ingest pass. Synchronous fs on a bounded set (≤ scanLimit run dirs),
// zero child-process spawns — the event loop is never blocked for long.
export function ingestRewards(deps = {}) {
  const {
    telemetryDb,
    rewardsDb,
    supervisorRoot,
    scanLimit = MANAGER_SNAPSHOT_SCAN_LIMIT,
    now = () => new Date().toISOString(),
  } = deps;
  const result = {
    ingestedAt: now(),
    scanLimit,
    scannedRuns: 0,
    groups: 0,
    awarded: 0,
    duplicated: 0,
    revoked: 0,
    held: 0,
    missing: [],
  };
  if (!supervisorRoot || !existsSync(supervisorRoot)) {
    missing(result.missing, "supervisor", "root", "no supervisor root configured — nothing ingested");
    return result;
  }

  // ── scan: ≤ scanLimit newest run dirs ──────────────────────────────────────
  const entries = readdirSync(supervisorRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, mtimeMs: statSync(join(supervisorRoot, e.name)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (entries.length > scanLimit) {
    missing(result.missing, "supervisor", "scan", `scan limit reached — ${entries.length - scanLimit} older run dirs not scanned`);
  }
  const runDirs = entries.slice(0, scanLimit);

  // Verdict records, grouped by (task, repo). The repo is resolved per verdict
  // from the RECORDING run's launch_cwd so two repos sharing a task id stay
  // two groups (two awards).
  const groups = new Map(); // key → { taskId, repo, verdicts: [] }
  for (const { name: runId } of runDirs) {
    const verdictsDir = join(supervisorRoot, runId, "verdicts");
    if (!existsSync(verdictsDir)) continue;
    result.scannedRuns++;
    let recordingCwd = null;
    let recordingCwdResolved = false;
    for (const file of readdirSync(verdictsDir)) {
      if (!file.endsWith(".json")) continue;
      const evidenceId = `supervisor/${runId}/verdicts/${file.replaceAll("\\", "/")}`;
      let record = null;
      try {
        record = JSON.parse(readFileSync(join(verdictsDir, file), "utf8"));
      } catch (err) {
        missing(result.missing, evidenceId, "verdict", `verdict record unreadable: ${toMissingEntry(err)}`);
        continue;
      }
      const taskId = typeof record?.taskId === "string" ? record.taskId.trim().toUpperCase() : "";
      const round = Number(record?.round);
      const verdict = typeof record?.verdict === "string" ? record.verdict.trim().toLowerCase() : "";
      const recordedAt = typeof record?.recordedAt === "string" ? record.recordedAt : "";
      if (!taskId || !Number.isInteger(round) || !verdict || !recordedAt || Number.isNaN(Date.parse(recordedAt))) {
        missing(result.missing, evidenceId, "verdict", "verdict record missing required fields (taskId, round, verdict, recordedAt)");
        continue;
      }
      if (!recordingCwdResolved) {
        // one bounded indexed lookup per run dir
        try {
          const row = telemetryDb.prepare("SELECT launch_cwd AS cwd FROM runs WHERE run_id=?").get(runId);
          recordingCwd = normalizeRepo(row?.cwd);
        } catch (err) {
          missing(result.missing, evidenceId, "repo", `recording run lookup failed: ${toMissingEntry(err)}`);
        }
        recordingCwdResolved = true;
      }
      const repo = recordingCwd ?? UNKNOWN;
      const key = `${taskId}|${repo}`;
      if (!groups.has(key)) groups.set(key, { taskId, repo, verdicts: [] });
      groups.get(key).verdicts.push({ round, verdict, recordedAt, evidenceId, recordingRunId: runId });
    }
  }
  if (result.scannedRuns === 0) {
    missing(result.missing, "supervisor", "runs", "no supervisor run dirs carry verdict records");
  }

  // ── act: one action per group — the latest verdict drives state ───────────
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key);
    result.groups++;
    // latest wins: recordedAt first (across runs the wall clock is honest),
    // higher round breaks ties within the same timestamp
    const latest = [...group.verdicts].sort(
      (a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt) || a.round - b.round,
    ).pop();

    if (latest.verdict !== "pass") {
      // non-pass only acts on an ACTIVE award; the ledger makes a second
      // revocation of the same inactive award a no-op, so replay stays clean
      const active = rewardsDb
        .prepare("SELECT repo, revision, rule_version AS ruleVersion FROM reward_records WHERE kind='award' AND active=1 AND task_id=? AND repo=?")
        .all(group.taskId, group.repo);
      for (const award of active) {
        const outcome = insertRevocation(rewardsDb, {
          taskId: group.taskId,
          repo: award.repo,
          revision: award.revision,
          ruleVersion: award.ruleVersion,
          runId: latest.recordingRunId,
          evidenceId: latest.evidenceId,
          provenance: `revocation: ${PROVENANCE_CAVEAT.replace("pass verdict is acceptance evidence", `non-pass verdict (round ${latest.round}) supersedes acceptance`)} — evidence ${latest.evidenceId}`,
        });
        if (!outcome.noop) result.revoked++;
      }
      continue;
    }

    // pass → resolve the credit subject via the task's primary producing run
    let producing = null;
    try {
      producing = telemetryDb
        .prepare(
          `SELECT l.run_id AS runId, r.squad AS squad
             FROM run_task_links l JOIN runs r ON r.run_id = l.run_id
            WHERE l.task_id=? AND l.role='primary' AND l.valid_to IS NULL
            ORDER BY l.valid_from DESC LIMIT 1`,
        )
        .get(group.taskId);
    } catch (err) {
      missing(result.missing, `award:${group.taskId}`, "subject", `producing-run lookup failed: ${toMissingEntry(err)}`);
    }
    const subject = producing?.squad && String(producing.squad).trim() ? String(producing.squad).trim() : null;

    // one bounded indexed lookup for the actual model used by the delivery run
    let model = null;
    if (producing?.runId) {
      try {
        const usage = telemetryDb
          .prepare(
            `SELECT model FROM usage_facts
              WHERE run_id=? AND model IS NOT NULL AND model <> '' AND model <> 'synthetic'
              ORDER BY observed_at DESC LIMIT 1`,
          )
          .get(producing.runId);
        model = usage?.model ?? null;
      } catch (err) {
        missing(result.missing, `award:${group.taskId}`, "model", `usage lookup failed: ${toMissingEntry(err)}`);
      }
    }

    const awardInput = {
      subject: subject ?? UNKNOWN,
      taskId: group.taskId,
      repo: group.repo === UNKNOWN ? undefined : group.repo,
      // v1: verdict records carry no prompt/config revision — sentinel + one
      // documented gap per pass instead of a per-row missing entry
      revision: undefined,
      runId: producing?.runId ?? null,
      evidenceId: latest.evidenceId,
      model,
      provenance: `xp-rules v1: ${PROVENANCE_CAVEAT} (round ${latest.round}, evidence ${latest.evidenceId})`,
    };
    if (!subject) {
      const held = insertHeldAward(rewardsDb, awardInput);
      if (!held.duplicate) {
        result.held++;
        missing(
          result.missing,
          `award:${group.taskId}`,
          "subject",
          producing?.runId
            ? "producing run has no squad recorded — award held at subject unknown"
            : "no linked producing run — award held at subject unknown",
        );
      }
      continue;
    }
    const outcome = insertAward(rewardsDb, awardInput);
    if (outcome.duplicate) result.duplicated++;
    else result.awarded++;
  }

  missing(
    result.missing,
    "rewards",
    "revision",
    "verdict records do not carry a prompt/config revision — every award stores the 'unknown' sentinel in v1",
  );
  return result;
}

// ── single-flight cache (mirror of the manager snapshot cache pattern) ───────
// Callers during a recompute receive the PREVIOUS result labelled 'cached';
// first-ever callers share one in-flight promise.

let cacheState = { result: null, computedAt: 0, inflight: null };

export function resetRewardsIngestCache() {
  cacheState = { result: null, computedAt: 0, inflight: null };
}

export async function getCachedRewardIngest(deps = {}) {
  const ttlMs = deps.ttlMs ?? REWARDS_INGEST_TTL_MS;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs() : Date.now();
  if (cacheState.result && nowMs - cacheState.computedAt < ttlMs) {
    return { result: cacheState.result, source: "cached" };
  }
  if (cacheState.inflight) {
    const result = await cacheState.inflight;
    return { result, source: "cached" };
  }
  const promise = (async () => {
    const result = ingestRewards(deps);
    cacheState.result = result;
    // stamped from the same clock the freshness check reads (injected nowMs in
    // tests, wall clock in production) so TTL tests stay deterministic
    cacheState.computedAt = nowMs;
    return result;
  })().finally(() => {
    cacheState.inflight = null;
  });
  cacheState.inflight = promise;
  const result = await promise;
  return { result, source: "fresh" };
}

// ── display payload ──────────────────────────────────────────────────────────
// Server facts only: rules constants, per-squad totals + recent records, the
// ratings display set, held awards (awaiting verified evidence) and the ingest
// diagnostics. Level math and badge thresholds are client-side (adapter).

export async function buildRewardsPayload(deps = {}) {
  const { result, source } = await getCachedRewardIngest(deps);
  const rewardsDb = deps.rewardsDb;
  const subjects = queryRewardSubjects(rewardsDb);
  const squads = {};
  for (const subject of subjects) {
    squads[subject] = querySquadRewards(rewardsDb, subject);
  }
  return {
    generatedAt: new Date().toISOString(),
    source,
    rules: { ...XP_RULES },
    squads,
    ratings: queryRatings(rewardsDb),
    held: queryHeldAwards(rewardsDb),
    ingest: {
      at: result.ingestedAt,
      scannedRuns: result.scannedRuns,
      awarded: result.awarded,
      duplicated: result.duplicated,
      revoked: result.revoked,
      held: result.held,
      missing: result.missing,
    },
  };
}
