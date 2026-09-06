// Tests for the Manager live overlay store reader (FOC-225 slice 2).
//
// Covers:
//   (a) the v6 additive index migration: fresh DB records the marker and
//       creates idx_runs_squad_ended; a v5-shaped store (marker deleted, index
//       dropped) regains both on reopen.
//   (b) queryManagerRuns semantics: bounded active + recent-per-squad sets,
//       allowlisted projection only, primary task link, contagious-null cost
//       with partial flag, squads filter, limits, empty store.
//   (c) read-only proof: queryManagerRuns runs under PRAGMA query_only — it
//       cannot be writing. queryRuns keeps working unchanged.
//
// Fixture rows are seeded with raw SQL on the migrated schema — the same
// approach the migration test uses. Started_at ordering convention: inside a
// squad, ended runs climb with their index (end-6 is the newest dev run).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SCHEMA_VERSION,
  MIGRATION_VERSIONS,
  openTelemetryDb,
  queryManagerRuns,
  queryRuns,
} from "./telemetry-store.mjs";

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

// ── fixture seeding (raw SQL) ────────────────────────────────────────────────

function seedRun(db, { runId, squad, startedAt, endedAt, exitCode, status }) {
  db.prepare(
    `INSERT INTO runs (run_id, squad, source, brief, started_at, ended_at, status, exit_code,
       native, interactive, launch_cwd, claude_config_dir, session_id, transcript_path, price_set_id, updated_at)
     VALUES (?,?,'test',?,?,?,?,?,'0','0','C:/t','C:/t/cfg',?,'C:/t/transcripts/SECRET.jsonl',NULL,?)`,
  ).run(runId, squad, `brief for ${runId}`, startedAt, endedAt, status, exitCode ?? null, `sess-${runId}`, startedAt);
}

function seedUsage(db, runId, i, { model = "z-ai/glm-5.3-flash", priced = true, cost = 0.0004 } = {}) {
  const usageId = `u-${runId}-${i}`;
  db.prepare(
    `INSERT INTO usage_facts (usage_id, run_id, session_id, agent_key, model, observed_at,
       input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
       source_path, source_offset, created_at)
     VALUES (?,?,?,'recon',?,?,10,5,0,0,?,?,?)`,
  ).run(usageId, runId, `sess-${runId}`, model, "2026-08-01T00:00:00.000Z", `C:/t/${runId}.jsonl`, i, "2026-08-01T00:00:00.000Z");
  if (priced) {
    db.prepare(`INSERT INTO cost_facts (run_id, usage_id, price_set_id, cost_usd) VALUES (?,?,NULL,?)`).run(runId, usageId, cost);
  }
}

function seedTaskLink(db, runId, taskId, { validTo = null } = {}) {
  db.prepare(
    `INSERT INTO work_items (task_id, provider, workspace, identifier, created_at) VALUES (?,'linear','t',?,'2026-08-01T00:00:00.000Z')`,
  ).run(taskId, taskId);
  db.prepare(
    `INSERT INTO run_task_links (link_id, run_id, task_id, role, valid_from, valid_to, source, confidence, created_at)
     VALUES (?,?,?,'primary','2026-08-01T00:00:00.000Z',?,'launch',1,'2026-08-01T00:00:00.000Z')`,
  ).run(`link-${runId}`, runId, taskId, validTo);
}

// dev: 6 ended (end-6 newest) + 2 active · plan: 2 ended + 1 active (newest
// active overall) · review: 2 ended. Enough to pin ordering, the 5-cap,
// squad filtering and cost states in one fixture.
function seedFixture(db) {
  const squads = {
    dev: { ended: 6, active: 2, base: 1 },
    plan: { ended: 2, active: 1, base: 20 },
    review: { ended: 2, active: 0, base: 40 },
  };
  const minute = 60_000;
  for (const [squad, cfg] of Object.entries(squads)) {
    for (let i = 1; i <= cfg.ended; i++) {
      const started = new Date(Date.UTC(2026, 7, cfg.base + i, 0, i)).toISOString();
      seedRun(db, {
        runId: `${squad}-end-${i}`, squad, startedAt: started,
        endedAt: new Date(Date.parse(started) + minute).toISOString(),
        exitCode: i === 2 ? 1 : 0, status: "ended",
      });
    }
    for (let i = 1; i <= cfg.active; i++) {
      const started = new Date(Date.UTC(2026, 7, cfg.base, 12, i)).toISOString();
      seedRun(db, { runId: `${squad}-act-${i}`, squad, startedAt: started, endedAt: null, exitCode: null, status: "running" });
    }
  }
  seedTaskLink(db, "dev-end-1", "FOC-901");
  seedTaskLink(db, "dev-end-3", "FOC-902", { validTo: "2026-08-01T01:00:00.000Z" }); // superseded → null
  // costs: end-1 fully priced · end-2 one unpriced non-synthetic row (taints) ·
  // end-3 only a synthetic unpriced row (must NOT taint) · end-4 no usage.
  for (let i = 0; i < 3; i++) seedUsage(db, "dev-end-1", i);
  seedUsage(db, "dev-end-2", 0);
  seedUsage(db, "dev-end-2", 1, { priced: false, model: "unpriced/model" });
  seedUsage(db, "dev-end-3", 0, { priced: false, model: "synthetic" });
}

// ── scenarios ────────────────────────────────────────────────────────────────

test("v6 migration: fresh DB stamps the marker and creates idx_runs_squad_ended", async () => {
  requireSqlite();
  const dir = mkdtempSync(join(tmpdir(), "mgr-runs-"));
  try {
    const db = openTelemetryDb(join(dir, "t.sqlite"));
    assert(SCHEMA_VERSION === 6, `SCHEMA_VERSION should be 6, got ${SCHEMA_VERSION}`);
    const markers = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((r) => r.version);
    assert(markers.includes(MIGRATION_VERSIONS.managerRunIndex), `marker 6 missing, have ${markers}`);
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_runs_squad_ended'").get();
    assert(idx, "idx_runs_squad_ended missing on a fresh DB");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("v6 migration: a v5 store (marker deleted, index dropped) regains both on reopen", async () => {
  requireSqlite();
  const dir = mkdtempSync(join(tmpdir(), "mgr-runs-"));
  try {
    const path = join(dir, "t.sqlite");
    openTelemetryDb(path).close();
    // simulate a store last written by v5 code
    const raw = new DatabaseSync(path);
    raw.exec("DROP INDEX idx_runs_squad_ended; DELETE FROM schema_migrations WHERE version=6;");
    raw.close();
    const reopened = openTelemetryDb(path);
    const idx = reopened.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_runs_squad_ended'").get();
    assert(idx, "index not recreated on reopen");
    const marker = reopened.prepare("SELECT 1 AS ok FROM schema_migrations WHERE version=?").get(MIGRATION_VERSIONS.managerRunIndex);
    assert(marker, "marker 6 not re-stamped on reopen");
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("queryManagerRuns: bounded sets, allowlisted projection, task links", async () => {
  requireSqlite();
  const dir = mkdtempSync(join(tmpdir(), "mgr-runs-"));
  try {
    const db = openTelemetryDb(join(dir, "t.sqlite"));
    seedFixture(db);
    const { active, recent } = queryManagerRuns(db);

    // active: unended runs only, newest first across squads
    assert(active.length === 3, `expected 3 active (plan×1 + dev×2), got ${active.length}`);
    assert(
      active.map((r) => r.runId).join(",") === "plan-act-1,dev-act-2,dev-act-1",
      `active order wrong: ${active.map((r) => r.runId)}`,
    );
    assert(active.every((r) => r.endedAt === null && r.exitCode === null), "active rows must be unended");

    // recent: at most 5 per squad, newest first inside the squad
    const bySquad = {};
    for (const r of recent) bySquad[r.squad] = (bySquad[r.squad] || 0) + 1;
    assert(bySquad.dev === 5 && bySquad.plan === 2 && bySquad.review === 2, `recent counts wrong: ${JSON.stringify(bySquad)}`);
    const devRecent = recent.filter((r) => r.squad === "dev").map((r) => r.runId);
    assert(devRecent.join(",") === "dev-end-6,dev-end-5,dev-end-4,dev-end-3,dev-end-2", `dev recent wrong: ${devRecent}`);
    assert(!devRecent.includes("dev-end-1"), "oldest dev run must fall outside the 5-cap");

    // allowlisted projection — exactly these keys, nothing else
    const keys = Object.keys(recent[0]).sort();
    assert(
      JSON.stringify(keys) === JSON.stringify(["costPartial", "costUSD", "endedAt", "exitCode", "runId", "squad", "startedAt", "status", "taskId"]),
      `projection keys wrong: ${keys}`,
    );
    const serialized = JSON.stringify({ active, recent });
    assert(!serialized.includes("SECRET"), "projection leaked a non-allowlisted column");
    assert(!serialized.includes("brief for"), "projection leaked runs.brief");

    // primary task link: superseded link never resolves
    assert(recent.find((r) => r.runId === "dev-end-3").taskId === null, "superseded link must not resolve");
    // the live link sits on end-1, which the default 5-cap drops — widen the cap
    const wide = queryManagerRuns(db, { squads: ["dev"], recentPerSquad: 10 });
    assert(wide.recent.find((r) => r.runId === "dev-end-1").taskId === "FOC-901", "live primary link missing");

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("queryManagerRuns: costUSD null is contagious on unpriced usage; synthetic does not taint", async () => {
  requireSqlite();
  const dir = mkdtempSync(join(tmpdir(), "mgr-runs-"));
  let db;
  try {
    db = openTelemetryDb(join(dir, "t.sqlite"));
    seedFixture(db);
    const { recent } = queryManagerRuns(db, { squads: ["dev"], recentPerSquad: 10 });
    const byId = Object.fromEntries(recent.map((r) => [r.runId, r]));
    // SUM of REALs is float math — compare with a tolerance, not ===
    assert(Math.abs(byId["dev-end-1"].costUSD - 0.0012) < 1e-9 && byId["dev-end-1"].costPartial === false, `fully priced run: ${JSON.stringify(byId["dev-end-1"])}`);
    assert(byId["dev-end-2"].costUSD === null && byId["dev-end-2"].costPartial === true, "unpriced usage must null the cost");
    assert(byId["dev-end-3"].costUSD === 0 && byId["dev-end-3"].costPartial === false, "synthetic-only unpriced must not taint");
    assert(byId["dev-end-4"].costUSD === 0 && byId["dev-end-4"].costPartial === false, "no-usage run costs 0");
    assert(byId["dev-end-2"].exitCode === 1 && byId["dev-end-1"].exitCode === 0, "exit_code passthrough");
  } finally {
    try { if (db) db.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("queryManagerRuns: squads filter, limits, and the empty store", async () => {
  requireSqlite();
  const dir = mkdtempSync(join(tmpdir(), "mgr-runs-"));
  try {
    const db = openTelemetryDb(join(dir, "t.sqlite"));
    seedFixture(db);

    const onlyDev = queryManagerRuns(db, { squads: ["dev"] });
    assert(onlyDev.active.every((r) => r.squad === "dev") && onlyDev.recent.every((r) => r.squad === "dev"), "squads filter leaked another squad");
    assert(onlyDev.active.length === 2 && onlyDev.recent.length === 5, `dev-only counts wrong: ${onlyDev.active.length}/${onlyDev.recent.length}`);

    const capped = queryManagerRuns(db, { activeLimit: 1, recentPerSquad: 1 });
    assert(capped.active.length === 1, "activeLimit not respected");
    assert(capped.active[0].runId === "plan-act-1", `activeLimit kept the wrong row: ${capped.active[0].runId}`);
    const perSquad = {};
    for (const r of capped.recent) perSquad[r.squad] = (perSquad[r.squad] || 0) + 1;
    assert(Object.values(perSquad).every((n) => n === 1), `recentPerSquad not respected: ${JSON.stringify(perSquad)}`);

    assert(queryManagerRuns(db, { recentPerSquad: 0 }).recent.length === 0, "recentPerSquad 0 must skip the recent set");

    db.close();

    const empty = openTelemetryDb(join(dir, "empty.sqlite"));
    const none = queryManagerRuns(empty);
    assert(none.active.length === 0 && none.recent.length === 0, "empty store must return empty sets");
    empty.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("queryManagerRuns: the default active cut (25) keeps the newest actives only", async () => {
  requireSqlite();
  const dir = mkdtempSync(join(tmpdir(), "mgr-runs-"));
  try {
    const db = openTelemetryDb(join(dir, "t.sqlite"));
    for (let i = 1; i <= 30; i++) {
      seedRun(db, {
        runId: `dev-bulk-${String(i).padStart(2, "0")}`, squad: "dev",
        startedAt: new Date(Date.UTC(2026, 7, 1, 0, i)).toISOString(),
        endedAt: null, exitCode: null, status: "running",
      });
    }
    const { active, recent } = queryManagerRuns(db); // no options — default limits
    assert(active.length === 25, `default activeLimit must cut at 25, got ${active.length}`);
    assert(active[0].runId === "dev-bulk-30", `newest active must survive the cut: ${active[0].runId}`);
    assert(active[24].runId === "dev-bulk-06", `25th newest must be the last kept: ${active[24].runId}`);
    assert(!active.some((r) => r.runId === "dev-bulk-05"), "actives beyond the cut must be dropped");
    assert(recent.length === 0, "no ended runs seeded → recent must be empty");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read-only proof: queryManagerRuns and queryRuns both work under PRAGMA query_only", async () => {
  requireSqlite();
  const dir = mkdtempSync(join(tmpdir(), "mgr-runs-"));
  try {
    const path = join(dir, "t.sqlite");
    const writer = openTelemetryDb(path);
    seedFixture(writer);
    writer.close();
    const ro = new DatabaseSync(path);
    ro.exec("PRAGMA query_only = 1;");
    const mgr = queryManagerRuns(ro);
    assert(mgr.active.length === 3 && mgr.recent.length === 9, `read-only run failed: ${mgr.active.length}/${mgr.recent.length}`);
    const legacy = queryRuns(ro);
    assert(legacy.length === 13, `queryRuns must keep working unchanged (got ${legacy.length})`);
    ro.close();
  } finally {
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
