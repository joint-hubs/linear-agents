// Manager live snapshot builder (FOC-225 slice 2).
//
// Backs GET /api/manager/snapshot — a READ-ONLY, bounded, cached view of run
// state for the /manager Live overlay. Three sources, all pre-existing:
//   1. the telemetry store via queryManagerRuns() (bounded, allowlisted —
//      never makeRunProjection, never queryRuns);
//   2. console manifests under .state/runs/<runId>.json for the liveness of
//      ACTIVE runs only (existing isProcessAlive pattern, capped);
//   3. supervisor state under .state/supervisor/<runId>/: pending gate
//      records and recorded verdicts (latest round per task).
// No raw-log scanning, no CLI spawns, no writes. The v1 contract below is
// frozen: additive fields may appear, existing fields keep meaning.
//
// v1 response shape:
//   {
//     generatedAt, ttlMs, source: 'fresh' | 'cached', generatedInMs,
//     bounds: { activeLimit, recentPerSquad, scanLimit, livenessCap },
//     squads: {
//       <squad>: {
//         active:  [ { runId, taskId, status, startedAt, endedAt, exitCode,
//                      costUSD, costPartial, alive } ],   // endedAt null, alive true|false|null
//         recent:  [ { ...same without alive } ],           // newest first, ≤ recentPerSquad
//         pendingGates: [ { gateId, runId, kind, createdAt, squad } ],
//       },
//     },
//     acceptedByTask: { <TASK>: { round, verdict, recordedAt, supervisorRunId } },
//     missing: [ { scope, field, reason } ],   // documents every absent field
//   }
//
// State mapping (authoritative source per state — the CLIENT derives states,
// this builder only supplies facts; see ui/src/manager/live.js):
//   running        store: ended_at IS NULL (+ liveness when a pid is known)
//   waiting        a pending gate record for the squad — never inferred
//   failed         ended + exit_code ≠ 0
//   finished       ended + exit_code 0 — the DEFAULT for ended runs
//   accepted       supervisor pass verdict (latest round) keyed to the task —
//                  diagnosis note: verdict records carry no REVIEW/TEST marker,
//                  so "accepted" means "supervisor pass verdict", never guessed
//                  from exit 0; exit 0 alone stays finished
//   unknown/stale  rendered by the client when fields are missing or the
//                  snapshot is stale — never invented here

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  MANAGER_RUN_ACTIVE_LIMIT,
  MANAGER_RUN_RECENT_PER_SQUAD,
  queryManagerRuns,
} from "./telemetry-store.mjs";

export const MANAGER_SNAPSHOT_TTL_MS = 3000;
export const MANAGER_SNAPSHOT_SCAN_LIMIT = 20; // supervisor run dirs scanned
export const MANAGER_SNAPSHOT_LIVENESS_CAP = 10; // real pid checks per snapshot

function missing(list, scope, field, reason) {
  list.push({ scope, field, reason });
}

// Read one directory of gate records. Unreadable is documented, never fatal —
// a malformed file must not hide the well-formed ones (same rule
// supervisor-status.mjs follows for the same directory).
function readPendingGates(dir, runId, missingList) {
  const gatesDir = join(dir, "gates");
  if (!existsSync(gatesDir)) return [];
  const out = [];
  for (const file of readdirSync(gatesDir).filter((f) => f.endsWith(".json"))) {
    try {
      const gate = JSON.parse(readFileSync(join(gatesDir, file), "utf8"));
      if (gate?.status !== "pending") continue;
      out.push({
        gateId: gate.gateId ?? file.replace(/\.json$/, ""),
        runId: gate.runId ?? runId,
        squad: gate.squad ?? null,
        kind: gate.kind ?? null,
        createdAt: gate.createdAt ?? null,
      });
    } catch {
      missing(missingList, `gate:${runId}/${file}`, "record", "malformed JSON — skipped");
    }
  }
  return out;
}

// Latest verdict round per needed task across the scanned run dirs. File name
// contract (supervisor-lib.mjs): <taskId-lowercased>-round<N>.json. The
// '-round' delimiter disambiguates prefixes (foc-22 vs foc-225).
function readAcceptedVerdicts(dirs, taskIdsLower, missingList) {
  const best = new Map(); // taskIdLower → { round, verdict, recordedAt, supervisorRunId }
  for (const { runId, dir } of dirs) {
    const verdictsDir = join(dir, "verdicts");
    if (!existsSync(verdictsDir) || taskIdsLower.length === 0) continue;
    for (const file of readdirSync(verdictsDir)) {
      const idx = file.lastIndexOf("-round");
      if (idx <= 0 || !file.endsWith(".json")) continue;
      const task = file.slice(0, idx).toLowerCase();
      const round = Number(file.slice(idx + 6, -5));
      if (!taskIdsLower.includes(task) || !Number.isInteger(round)) continue;
      try {
        const record = JSON.parse(readFileSync(join(verdictsDir, file), "utf8"));
        const current = best.get(task);
        if (!current || round > current.round) {
          best.set(task, {
            round: record.round ?? round,
            verdict: record.verdict ?? null,
            recordedAt: record.recordedAt ?? null,
            supervisorRunId: runId,
          });
        }
      } catch {
        missing(missingList, `verdict:${runId}/${file}`, "record", "malformed JSON — skipped");
      }
    }
  }
  return best;
}

export function buildManagerSnapshot(deps = {}) {
  const {
    db,
    supervisorRoot,
    runsManifestDir,
    isProcessAlive = null,
    now = () => new Date().toISOString(),
    scanLimit = MANAGER_SNAPSHOT_SCAN_LIMIT,
    livenessCap = MANAGER_SNAPSHOT_LIVENESS_CAP,
    queryManagerRunsFn = queryManagerRuns,
  } = deps;
  if (!db) throw new Error("buildManagerSnapshot requires an open telemetry db");
  if (!Number.isInteger(livenessCap) || livenessCap < 0) throw new Error("livenessCap must be a non-negative integer");

  const missingList = [];
  const { active, recent } = queryManagerRunsFn(db);

  // Liveness for ACTIVE runs only: manifest consolePid → injected checker.
  // null means "cannot tell" and is documented, never guessed into a state.
  let checks = 0;
  for (const run of active) {
    run.alive = null;
    if (!runsManifestDir) {
      missing(missingList, `run:${run.runId}`, "alive", "no manifest dir configured");
      continue;
    }
    if (checks >= livenessCap) {
      missing(missingList, `run:${run.runId}`, "alive", "liveness cap reached");
      continue;
    }
    try {
      const manifestPath = join(runsManifestDir, `${run.runId}.json`);
      if (!existsSync(manifestPath)) {
        missing(missingList, `run:${run.runId}`, "alive", "console manifest absent");
        continue;
      }
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      const pid = manifest?.consolePid;
      if (!Number.isInteger(pid) || pid <= 0) {
        missing(missingList, `run:${run.runId}`, "alive", "no console pid recorded");
        continue;
      }
      if (typeof isProcessAlive !== "function") {
        missing(missingList, `run:${run.runId}`, "alive", "liveness checker unavailable");
        continue;
      }
      run.alive = isProcessAlive(pid) === true;
      checks++;
    } catch {
      missing(missingList, `run:${run.runId}`, "alive", "console manifest unreadable");
    }
  }

  // Supervisor run dirs: newest first, bounded scan. mtime, because run ids
  // are names, not timestamps.
  const dirs = [];
  if (supervisorRoot && existsSync(supervisorRoot)) {
    const entries = readdirSync(supervisorRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => {
        try {
          return { name: e.name, mtime: statSync(join(supervisorRoot, e.name)).mtimeMs };
        } catch {
          return { name: e.name, mtime: 0 };
        }
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, scanLimit);
    for (const e of entries) dirs.push({ runId: e.name, dir: join(supervisorRoot, e.name) });
  } else {
    missing(missingList, "supervisor", "state", "supervisor state dir absent");
  }

  // Pending gates per squad (squad-level v1 binding — never mapped to roles).
  const gatesBySquad = new Map();
  for (const { runId, dir } of dirs) {
    for (const gate of readPendingGates(dir, runId, missingList)) {
      const squad = gate.squad || "unknown";
      if (!gatesBySquad.has(squad)) gatesBySquad.set(squad, []);
      gatesBySquad.get(squad).push(gate);
    }
  }

  // Independent acceptance: latest-round pass verdict per linked task.
  const taskIdsLower = [...new Set([...active, ...recent].map((r) => r.taskId).filter(Boolean).map((t) => String(t).toLowerCase()))];
  const accepted = readAcceptedVerdicts(dirs, taskIdsLower, missingList);

  // Per-squad live block. A run with no squad lands under 'unknown' — it is
  // reported, not dropped, and the absence is documented.
  const squads = {};
  const group = (run) => {
    const squad = run.squad || "unknown";
    if (!run.squad) missing(missingList, `run:${run.runId}`, "squad", "run has no squad in the store");
    return (squads[squad] ||= { active: [], recent: [], pendingGates: gatesBySquad.get(squad) || [] });
  };
  for (const run of active) group(run).active.push(run);
  for (const run of recent) group(run).recent.push(run);

  // Squad keys exist even when only gates are known for them.
  for (const [squad, gates] of gatesBySquad) {
    if (!squads[squad]) squads[squad] = { active: [], recent: [], pendingGates: gates };
  }

  const acceptedByTask = {};
  for (const [task, record] of accepted) {
    if (record.verdict !== "pass") continue; // fail/other never promotes a run
    acceptedByTask[task.toUpperCase()] = record;
  }

  return {
    generatedAt: now(),
    ttlMs: typeof deps.ttlMs === "number" ? deps.ttlMs : MANAGER_SNAPSHOT_TTL_MS,
    source: "fresh",
    bounds: {
      activeLimit: MANAGER_RUN_ACTIVE_LIMIT,
      recentPerSquad: MANAGER_RUN_RECENT_PER_SQUAD,
      scanLimit,
      livenessCap,
    },
    squads,
    acceptedByTask,
    missing: missingList,
  };
}

// Module-level cache: TTL + single-flight. A request arriving while a compute
// is in flight gets the PREVIOUS snapshot when one exists (never two
// concurrent computes); the very first request waits for the first compute.
// On build errors the previous snapshot stays — the overlay keeps last-known
// data and the header reports the failure.
let cacheState = { snapshot: null, computedAt: 0, inflight: null };

export function resetManagerSnapshotCache() {
  cacheState = { snapshot: null, computedAt: 0, inflight: null };
}

export async function getCachedManagerSnapshot(deps = {}) {
  const ttlMs = typeof deps.ttlMs === "number" ? deps.ttlMs : MANAGER_SNAPSHOT_TTL_MS;
  if (cacheState.snapshot && Date.now() - cacheState.computedAt < ttlMs) {
    return { ...cacheState.snapshot, source: "cached" };
  }
  if (cacheState.inflight) {
    if (cacheState.snapshot) return { ...cacheState.snapshot, source: "cached" };
    return cacheState.inflight; // first request ever — wait for it
  }
  const compute = (async () => {
    const build = typeof deps.buildFn === "function" ? deps.buildFn : buildManagerSnapshot;
    const snapshot = await build(deps);
    cacheState.snapshot = snapshot;
    cacheState.computedAt = Date.now();
    return snapshot;
  })();
  cacheState.inflight = compute;
  try {
    return await compute;
  } finally {
    cacheState.inflight = null;
  }
}
