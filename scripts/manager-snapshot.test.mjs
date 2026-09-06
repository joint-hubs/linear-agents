// Tests for the Manager live snapshot builder + cache (FOC-225 slice 2).
//
// Covers:
//   (a) buildManagerSnapshot semantics: per-squad grouping, bounds block,
//       fresh source, injected now().
//   (b) liveness policy: true/false from the injected checker, null +
//       documented missing when the manifest/pid is absent, the 10-check cap.
//   (c) supervisor scan: pending gates only (non-pending ignored, malformed
//       documented and skipped), the 20-dir mtime cap, squad-less gate →
//       'unknown', run with no squad → 'unknown' + missing entry.
//   (d) acceptance mapping: latest round wins, case-insensitive taskId match,
//       a fail verdict never promotes, prefix trap (foc-91 vs foc-910) must
//       not cross-match, exit 0 without a verdict stays unaccepted.
//   (e) cache: fresh → cached inside the TTL, reset hook, single-flight
//       (first-ever callers share one compute; a caller during a recompute
//       gets the PREVIOUS snapshot, never a second concurrent compute).
//   (f) read-only proof: the whole build runs under PRAGMA query_only.
//
// Runs/links are seeded with raw SQL (same approach as
// telemetry-manager-runs.test.mjs); supervisor state and manifests are real
// files under a temp root.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DatabaseSync } from "node:sqlite";

import {
  buildManagerSnapshot,
  getCachedManagerSnapshot,
  resetManagerSnapshotCache,
} from "./manager-snapshot.mjs";
import { openTelemetryDb } from "./telemetry-store.mjs";

let passed = 0;
let failed = 0;
let skipped = 0;

class TestSkip extends Error {}

function assert(value, message) {
  if (!value) throw new Error(message || "assertion failed");
}

const testQueue = [];
function test(name, fn) {
  testQueue.push({ name, fn });
}

// ── fixture helpers ──────────────────────────────────────────────────────────

function seedRun(db, { runId, squad, startedAt, endedAt = null, exitCode = null, status }) {
  db.prepare(
    `INSERT INTO runs (run_id, squad, source, brief, started_at, ended_at, status, exit_code,
       native, interactive, launch_cwd, claude_config_dir, session_id, transcript_path, price_set_id, updated_at)
     VALUES (?,?,'test',?,?,?,?,?,'0','0','C:/t','C:/t/cfg',?,'C:/t/SECRET.jsonl',NULL,?)`,
  ).run(runId, squad, `brief SECRET for ${runId}`, startedAt, endedAt, status, exitCode, `sess-${runId}`, startedAt);
}

function seedTaskLink(db, runId, taskId) {
  db.prepare(
    `INSERT INTO work_items (task_id, provider, workspace, identifier, created_at) VALUES (?,'linear','t',?,'2026-08-01T00:00:00.000Z')`,
  ).run(taskId, taskId);
  db.prepare(
    `INSERT INTO run_task_links (link_id, run_id, task_id, role, valid_from, valid_to, source, confidence, created_at)
     VALUES (?,?,?,'primary','2026-08-01T00:00:00.000Z',NULL,'launch',1,'2026-08-01T00:00:00.000Z')`,
  ).run(`link-${runId}`, runId, taskId);
}

// Standard store fixture: dev has an active run, a clean end, a failed end;
// plan has one clean end. Task links exercise acceptance mapping.
function seedStore(db) {
  seedRun(db, { runId: "dev-act-1", squad: "dev", startedAt: "2026-08-20T10:00:00.000Z", status: "running" });
  seedRun(db, { runId: "dev-end-1", squad: "dev", startedAt: "2026-08-10T10:00:00.000Z", endedAt: "2026-08-10T11:00:00.000Z", exitCode: 0, status: "ended" });
  seedRun(db, { runId: "dev-end-2", squad: "dev", startedAt: "2026-08-11T10:00:00.000Z", endedAt: "2026-08-11T11:00:00.000Z", exitCode: 1, status: "ended" });
  seedRun(db, { runId: "plan-end-1", squad: "plan", startedAt: "2026-08-12T10:00:00.000Z", endedAt: "2026-08-12T11:00:00.000Z", exitCode: 0, status: "ended" });
  seedTaskLink(db, "dev-end-1", "FOC-910");
  seedTaskLink(db, "dev-act-1", "FOC-911");
}

function writeGate(root, runId, fileName, body) {
  mkdirSync(join(root, runId, "gates"), { recursive: true });
  writeFileSync(join(root, runId, "gates", fileName), typeof body === "string" ? body : JSON.stringify(body));
}

function writeVerdict(root, runId, fileName, body) {
  mkdirSync(join(root, runId, "verdicts"), { recursive: true });
  writeFileSync(join(root, runId, "verdicts", fileName), JSON.stringify(body));
}

function writeManifest(dir, runId, body) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${runId}.json`), JSON.stringify(body));
}

function setMtime(dir, ms) {
  utimesSync(dir, new Date(ms), new Date(ms));
}

function assertAlive(runId, snapshot, expected, label) {
  const run = snapshot.squads.dev.active.find((r) => r.runId === runId);
  assert(run, `${label}: ${runId} not in dev.active`);
  assert(run.alive === expected, `${label}: ${runId}.alive = ${run.alive}, expected ${expected}`);
}

// ── scenarios ────────────────────────────────────────────────────────────────

test("buildManagerSnapshot: per-squad grouping, bounds, fresh source, injected now", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mgr-snap-"));
  let db;
  try {
    db = openTelemetryDb(join(dir, "t.sqlite"));
    seedStore(db);
    const supRoot = join(dir, "supervisor");
    mkdirSync(supRoot, { recursive: true });
    writeGate(supRoot, "runA", "g1.json", { gateId: "g1", runId: "runA", squad: "dev", kind: "question", createdAt: "2026-08-20T09:00:00.000Z", status: "pending" });
    writeManifest(join(dir, "manifests"), "dev-act-1", { consolePid: 4242 });
    const snapshot = await buildManagerSnapshot({
      db,
      supervisorRoot: supRoot,
      runsManifestDir: join(dir, "manifests"),
      checkProcessesAlive: async (pids) => new Map(pids.map((p) => [p, true])),
      now: () => "2026-09-06T00:00:00.000Z",
    });

    assert(snapshot.generatedAt === "2026-09-06T00:00:00.000Z", `generatedAt wrong: ${snapshot.generatedAt}`);
    assert(snapshot.source === "fresh", `source wrong: ${snapshot.source}`);
    assert(snapshot.ttlMs === 3000, `default ttlMs wrong: ${snapshot.ttlMs}`);
    assert(
      JSON.stringify(snapshot.bounds) === JSON.stringify({ activeLimit: 25, recentPerSquad: 5, scanLimit: 20, livenessCap: 10 }),
      `bounds wrong: ${JSON.stringify(snapshot.bounds)}`,
    );

    // dev: 1 active + 2 recent · plan: 2 recent (only one run, but recentPerSquad
    // is a cap, not a target — plan-end-1 appears once) · pending gate on dev.
    assert(snapshot.squads.dev.active.map((r) => r.runId).join(",") === "dev-act-1", "dev active wrong");
    assert(snapshot.squads.dev.recent.map((r) => r.runId).join(",") === "dev-end-2,dev-end-1", "dev recent wrong");
    assert(snapshot.squads.plan.recent.map((r) => r.runId).join(",") === "plan-end-1", "plan recent wrong");
    assert(snapshot.squads.dev.pendingGates.length === 1, "dev pending gate missing");
    assert(snapshot.squads.dev.pendingGates[0].gateId === "g1" && snapshot.squads.dev.pendingGates[0].kind === "question", "gate projection wrong");

    // ended+exit0 never promotes to accepted on its own — acceptance is verdict-only
    assert(snapshot.acceptedByTask.FOC_910 === undefined && !("FOC-910" in snapshot.acceptedByTask), "exit-0 run must not be accepted");
    assert(JSON.stringify(snapshot).includes("SECRET") === false, "snapshot leaked a non-allowlisted store column");
  } finally {
    try { if (db) db.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("acceptance: latest round wins, case-insensitive match, fail never accepts, prefix trap ignored", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mgr-snap-"));
  let db;
  try {
    db = openTelemetryDb(join(dir, "t.sqlite"));
    seedStore(db);
    seedTaskLink(db, "dev-end-2", "FOC-912");
    const supRoot = join(dir, "supervisor");
    // FOC-910: pass round 1 then fail round 2 → latest (fail) wins → not accepted
    // FOC-911: fail round 1, pass round 3 → latest (pass) wins → accepted
    // FOC-912: single pass round 1 → accepted
    // foc-91-round9.json: prefix trap for foc-910/foc-911 — must be ignored
    writeVerdict(supRoot, "runA", "foc-910-round1.json", { taskId: "FOC-910", round: 1, verdict: "pass", recordedAt: "2026-08-10T12:00:00.000Z" });
    writeVerdict(supRoot, "runA", "foc-910-round2.json", { taskId: "FOC-910", round: 2, verdict: "fail", recordedAt: "2026-08-11T12:00:00.000Z" });
    writeVerdict(supRoot, "runB", "FOC-911-ROUND1.json", { taskId: "FOC-911", round: 1, verdict: "fail", recordedAt: "2026-08-20T12:00:00.000Z" });
    writeVerdict(supRoot, "runB", "foc-911-round3.json", { taskId: "FOC-911", round: 3, verdict: "pass", recordedAt: "2026-08-21T12:00:00.000Z" });
    writeVerdict(supRoot, "runB", "foc-912-round1.json", { taskId: "FOC-912", round: 1, verdict: "pass", recordedAt: "2026-08-11T12:00:00.000Z" });
    writeVerdict(supRoot, "runB", "foc-91-round9.json", { taskId: "FOC-91", round: 9, verdict: "pass", recordedAt: "2026-08-21T12:00:00.000Z" });
    const snapshot = await buildManagerSnapshot({ db, supervisorRoot: supRoot });

    assert(!("FOC-910" in snapshot.acceptedByTask), "latest fail verdict must not leave the task accepted");
    const acc911 = snapshot.acceptedByTask["FOC-911"];
    assert(acc911 && acc911.round === 3 && acc911.verdict === "pass" && acc911.supervisorRunId === "runB", `FOC-911 acceptance wrong: ${JSON.stringify(acc911)}`);
    const acc912 = snapshot.acceptedByTask["FOC-912"];
    assert(acc912 && acc912.round === 1 && acc912.verdict === "pass", `FOC-912 acceptance wrong: ${JSON.stringify(acc912)}`);
    assert(!("FOC-91" in snapshot.acceptedByTask), "prefix trap verdict must be ignored");
    assert(JSON.stringify(snapshot).includes("FOC-91\n") === false, "unexpected FOC-91 key leaked");
  } finally {
    try { if (db) db.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("liveness: checker true/false, manifest absent, no pid, and the 10-check cap", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mgr-snap-"));
  let db;
  try {
    db = openTelemetryDb(join(dir, "t.sqlite"));
    // 12 active runs → cap 10 real checks, 2 documented as capped. active is
    // started_at DESC, so run 1 gets the NEWEST stamp: the manifest-backed
    // runs are processed first and the two pid-less ones hit the cap.
    for (let i = 1; i <= 12; i++) {
      seedRun(db, { runId: `dev-act-${i}`, squad: "dev", startedAt: `2026-08-20T10:${String(13 - i).padStart(2, "0")}:00.000Z`, status: "running" });
      if (i <= 10) writeManifest(join(dir, "manifests"), `dev-act-${i}`, { consolePid: 100 + i });
      // dev-act-11: manifest exists but has no pid · dev-act-12: no manifest at all
      if (i === 11) writeManifest(join(dir, "manifests"), "dev-act-11", {});
    }
    let calls = 0;
    const aliveByPid = { 101: true, 102: false };
    const snapshot = await buildManagerSnapshot({
      db,
      supervisorRoot: null,
      runsManifestDir: join(dir, "manifests"),
      checkProcessesAlive: async (pids) => {
        calls += pids.length;
        return new Map(pids.map((p) => [p, aliveByPid[p] ?? true]));
      },
    });

    assertAlive("dev-act-1", snapshot, true, "liveness");
    assertAlive("dev-act-2", snapshot, false, "liveness");
    assertAlive("dev-act-3", snapshot, true, "liveness");
    assertAlive("dev-act-11", snapshot, null, "liveness");
    assertAlive("dev-act-12", snapshot, null, "liveness");
    assert(calls === 10, `expected exactly 10 real checks, got ${calls}`);
    const capped = snapshot.missing.filter((m) => m.reason === "liveness cap reached");
    assert(capped.length === 2, `cap missing-entries wrong: ${JSON.stringify(capped)}`);
    assert(capped.some((m) => m.scope === "run:dev-act-11") && capped.some((m) => m.scope === "run:dev-act-12"), "capped runs undocumented");
    // supervisorRoot null is documented, not silent
    assert(snapshot.missing.some((m) => m.scope === "supervisor" && m.field === "state"), "absent supervisor root undocumented");
  } finally {
    try { if (db) db.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("liveness: a failed checker is unknown + documented — never a fake dead process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mgr-snap-"));
  let db;
  try {
    db = openTelemetryDb(join(dir, "t.sqlite"));
    seedRun(db, { runId: "dev-act-1", squad: "dev", startedAt: "2026-08-20T10:05:00.000Z", status: "running" });
    writeManifest(join(dir, "manifests"), "dev-act-1", { consolePid: 501 });
    const snapshot = await buildManagerSnapshot({
      db,
      supervisorRoot: null,
      runsManifestDir: join(dir, "manifests"),
      checkProcessesAlive: async () => {
        throw new Error("powershell broke");
      },
    });
    assertAlive("dev-act-1", snapshot, null, "checker failure");
    const failed = snapshot.missing.filter((m) => m.reason === "liveness checker failed");
    assert(failed.length === 1 && failed[0].scope === "run:dev-act-1", `checker failure undocumented: ${JSON.stringify(failed)}`);
  } finally {
    try { if (db) db.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("liveness: a partial checker answer keeps unanswered pids unknown + documented", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mgr-snap-"));
  let db;
  try {
    db = openTelemetryDb(join(dir, "t.sqlite"));
    seedRun(db, { runId: "dev-act-1", squad: "dev", startedAt: "2026-08-20T10:05:00.000Z", status: "running" });
    seedRun(db, { runId: "dev-act-2", squad: "dev", startedAt: "2026-08-20T10:04:00.000Z", status: "running" });
    writeManifest(join(dir, "manifests"), "dev-act-1", { consolePid: 601 });
    writeManifest(join(dir, "manifests"), "dev-act-2", { consolePid: 602 });
    const snapshot = await buildManagerSnapshot({
      db,
      supervisorRoot: null,
      runsManifestDir: join(dir, "manifests"),
      checkProcessesAlive: async (pids) => new Map([[pids[0], true]]), // second pid missing from the answer
    });
    assertAlive("dev-act-1", snapshot, true, "partial checker");
    assertAlive("dev-act-2", snapshot, null, "partial checker");
    assert(
      snapshot.missing.some((m) => m.scope === "run:dev-act-2" && m.reason === "liveness result missing"),
      "missing checker answer undocumented",
    );
  } finally {
    try { if (db) db.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("supervisor scan: pending gates only, malformed documented, 20-dir mtime cap, squad-less gate → unknown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mgr-snap-"));
  let db;
  try {
    db = openTelemetryDb(join(dir, "t.sqlite"));
    seedStore(db);
    const supRoot = join(dir, "supervisor");
    // 25 run dirs; run-01..run-25 with rising mtimes. Only the newest 20 are
    // scanned, so run-01..run-05 gates must be invisible.
    for (let i = 1; i <= 25; i++) {
      const runId = `run-${String(i).padStart(2, "0")}`;
      mkdirSync(join(supRoot, runId), { recursive: true });
      setMtime(join(supRoot, runId), Date.UTC(2026, 7, 1, 0, i));
      writeGate(supRoot, runId, "g.json", { gateId: `gate-${i}`, squad: `sq-${i}`, kind: "plan.gate1", createdAt: "2026-08-01T00:00:00.000Z", status: "pending" });
    }
    // answered gate in a scanned dir → ignored; malformed gate → skipped + documented
    writeGate(supRoot, "run-25", "answered.json", { gateId: "g-answered", squad: "dev", kind: "question", status: "answered" });
    writeGate(supRoot, "run-25", "broken.json", "{ not json");
    // squad-less pending gate lands under 'unknown'
    writeGate(supRoot, "run-25", "nosquad.json", { gateId: "g-nosquad", kind: "question", status: "pending" });

    const snapshot = await buildManagerSnapshot({ db, supervisorRoot: supRoot });
    const squadKeys = Object.keys(snapshot.squads).sort();
    // 20 scanned gate squads (sq-06..sq-25) + dev/plan from the store fixture
    assert(squadKeys.filter((k) => k.startsWith("sq-")).length === 20, `expected 20 scanned gate squads, got ${squadKeys.length}: ${squadKeys}`);
    assert(squadKeys.includes("dev") && squadKeys.includes("plan"), "store squads must survive alongside gate squads");
    assert(snapshot.squads["sq-25"] && snapshot.squads["sq-25"].pendingGates.some((g) => g.gateId === "gate-25"), "newest dir gate missing");
    assert(!snapshot.squads["sq-01"] && !snapshot.squads["sq-05"], "scan cap leaked oldest dirs");
    const devGates = snapshot.squads.dev.pendingGates.map((g) => g.gateId);
    assert(devGates.includes("g-nosquad") === false, "squad-less gate must not land on dev");
    assert(snapshot.squads.unknown && snapshot.squads.unknown.pendingGates.some((g) => g.gateId === "g-nosquad"), "squad-less gate not grouped under unknown");
    assert(snapshot.squads.dev.pendingGates.every((g) => g.status === undefined), "non-allowlisted gate fields leaked");
    assert(snapshot.missing.some((m) => m.scope.includes("broken.json") && m.reason.includes("malformed")), "malformed gate undocumented");
  } finally {
    try { if (db) db.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run with no squad in the store → 'unknown' bucket + documented missing entry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mgr-snap-"));
  let db;
  try {
    db = openTelemetryDb(join(dir, "t.sqlite"));
    seedRun(db, { runId: "ghost-1", squad: null, startedAt: "2026-08-20T10:00:00.000Z", status: "running" });
    const snapshot = await buildManagerSnapshot({ db, supervisorRoot: null, runsManifestDir: null });
    assert(snapshot.squads.unknown && snapshot.squads.unknown.active.some((r) => r.runId === "ghost-1"), "squad-less run not reported");
    assert(snapshot.missing.some((m) => m.scope === "run:ghost-1" && m.field === "squad"), "squad-less run undocumented");
  } finally {
    try { if (db) db.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cache: fresh then cached inside TTL; reset clears", async () => {
  resetManagerSnapshotCache();
  const dir = mkdtempSync(join(tmpdir(), "mgr-snap-"));
  let db;
  try {
    db = openTelemetryDb(join(dir, "t.sqlite"));
    seedStore(db);
    const deps = { db, supervisorRoot: null, runsManifestDir: null };
    const first = await getCachedManagerSnapshot(deps);
    assert(first.source === "fresh", `first call must be fresh, got ${first.source}`);
    const second = await getCachedManagerSnapshot(deps);
    assert(second.source === "cached", `second call must be cached, got ${second.source}`);
    assert(second.generatedAt === first.generatedAt, "cached snapshot must be the same compute");
    resetManagerSnapshotCache();
    const third = await getCachedManagerSnapshot(deps);
    assert(third.source === "fresh", "after reset the snapshot must be rebuilt");
  } finally {
    resetManagerSnapshotCache();
    try { if (db) db.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cache single-flight: first-ever callers share one compute; recompute returns the previous snapshot", async () => {
  resetManagerSnapshotCache();
  const dir = mkdtempSync(join(tmpdir(), "mgr-snap-"));
  let db;
  try {
    db = openTelemetryDb(join(dir, "t.sqlite"));
    seedStore(db);
    const deps = { db, supervisorRoot: null, runsManifestDir: null, ttlMs: 0 };

    // First ever: two callers before the compute resolves share ONE promise.
    let releaseFirst;
    const gateFirst = new Promise((r) => { releaseFirst = r; });
    let builds = 0;
    const slowBuild = () => { builds++; return gateFirst.then(() => ({ generatedAt: "first", ttlMs: 0, source: "fresh", squads: {}, acceptedByTask: {}, missing: [] })); };
    const p1 = getCachedManagerSnapshot({ ...deps, buildFn: slowBuild });
    const p2 = getCachedManagerSnapshot({ ...deps, buildFn: slowBuild });
    releaseFirst();
    const firstSnap = await p1;
    assert((await p2) === firstSnap, "second first-ever caller must share the same compute result");
    assert(builds === 1, `buildFn must run once, ran ${builds}×`);

    // Recompute after TTL: a caller arriving during a slow recompute gets the
    // PREVIOUS snapshot as 'cached', and no second build starts.
    let releaseSecond;
    const gateSecond = new Promise((r) => { releaseSecond = r; });
    const secondBuild = () => { builds++; return gateSecond.then(() => ({ generatedAt: "second", ttlMs: 0, source: "fresh", squads: {}, acceptedByTask: {}, missing: [] })); };
    const p3 = getCachedManagerSnapshot({ ...deps, buildFn: secondBuild });
    const previous = await getCachedManagerSnapshot({ ...deps, buildFn: secondBuild }); // must NOT wait
    assert(previous.source === "cached" && previous.generatedAt === "first", `in-flight caller must get the previous snapshot, got ${previous.source}/${previous.generatedAt}`);
    releaseSecond();
    const rebuilt = await p3;
    assert(rebuilt.generatedAt === "second", "recompute must eventually replace the snapshot");
    assert(builds === 2, `buildFn must run exactly twice, ran ${builds}×`);
  } finally {
    resetManagerSnapshotCache();
    try { if (db) db.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read-only proof: the whole snapshot build runs under PRAGMA query_only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mgr-snap-"));
  let ro;
  try {
    const path = join(dir, "t.sqlite");
    const writer = openTelemetryDb(path);
    seedStore(writer);
    writer.close();
    ro = new DatabaseSync(path);
    ro.exec("PRAGMA query_only = 1;");
    const snapshot = await buildManagerSnapshot({ db: ro, supervisorRoot: null, runsManifestDir: null });
    assert(snapshot.squads.dev.active.length === 1 && snapshot.squads.dev.recent.length === 2, "read-only build returned wrong sets");
  } finally {
    try { if (ro) ro.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
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
