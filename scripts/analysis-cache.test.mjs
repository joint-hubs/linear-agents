// Tests for analysis-cache.mjs — the derived analysis cache.
//
// The property that makes the cache safe to use is FAITHFULNESS: every panel,
// run against openAnalysisDb(cachePath), must return exactly what it returns
// against openAnalysisDb(storePath) — same data, same caveats. Everything else
// here guards the mechanics: atomic build, staleness detection, lock rules,
// leftover cleanup, and the hard rule that the store is never written.

import { mkdtempSync, rmSync, statSync, existsSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openTelemetryDb } from "./telemetry-store.mjs";
import { ensureViews } from "./telemetry-canonical.mjs";
import { openAnalysisDb } from "./telemetry-analysis.mjs";
import {
  metaPanel,
  toolsPanel,
  qualityPanel,
  costPanel,
  handoffsPanel,
} from "./telemetry-analysis.mjs";
import { CACHE_SCHEMA_VERSION, buildCache, cacheStatus, swapIntoPlace } from "./analysis-cache.mjs";

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) { passed++; return; }
  failed++;
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

// ---------------------------------------------------------------------------
// Fixture store — the same shape telemetry-analysis.test.mjs builds: runs,
// usage (incl. a per-message island and an unpriced turn), cost facts, tool
// facts, delegation links, data quality issues. Link counts per pair and per
// squad are distinct so every panel breakdown ordering is data-determined.
// ---------------------------------------------------------------------------

const temp = mkdtempSync(join(tmpdir(), "analysis-cache-test-"));
const storePath = join(temp, "t.sqlite");
const cachePath = join(temp, "analysis-cache.sqlite");

{
  const db = openTelemetryDb(storePath);
  ensureViews(db);

  db.prepare("INSERT INTO price_sets (price_set_id, config_hash, created_at, source) VALUES (?,?,?,?)")
    .run("ps1", "hash1", "2026-09-01T00:00:00.000Z", "test");

  const insertRun = db.prepare(`INSERT INTO runs (run_id, squad, started_at, ended_at, price_set_id, status, updated_at)
    VALUES (?,?,?,?,?,?,'2026-09-01T00:00:00.000Z')`);
  insertRun.run("runA", "alpha", "2026-09-01T10:00:00.000Z", "2026-09-01T12:00:00.000Z", "ps1", "completed");
  insertRun.run("runB", "beta", "2026-09-08T10:00:00.000Z", "2026-09-08T12:00:00.000Z", "ps1", "completed");
  insertRun.run("runC", "alpha", "2026-09-15T10:00:00.000Z", "2026-09-15T12:00:00.000Z", "ps1", "completed");

  const usage = db.prepare(`INSERT INTO usage_facts
    (usage_id, run_id, session_id, agent_key, model, observed_at,
     input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
     source_path, source_offset, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const cost = db.prepare("INSERT INTO cost_facts (run_id, usage_id, price_set_id, cost_usd) VALUES (?,?,?,?)");

  usage.run("u1", "runA", "a1", "_lead", "m1", "2026-09-01T10:30:00.000Z", 100, 50, 200, 10, "/c1.jsonl", 10, "2026-09-01T10:30:00.000Z");
  usage.run("u2", "runA", "a2", "worker-1", "m1", "2026-09-01T11:00:00.000Z", 50, 25, 0, 0, "/c2.jsonl", 10, "2026-09-01T11:00:00.000Z");
  usage.run("u3", "runB", "b1", "_lead", "m2", "2026-09-08T10:30:00.000Z", 60, 30, 0, 0, "/c3.jsonl", 10, "2026-09-08T10:30:00.000Z");
  usage.run("u4", "runB", "b2", "agent-abc123", "m1", "2026-09-08T11:00:00.000Z", 40, 20, 0, 0, "/c4.jsonl", 10, "2026-09-08T11:00:00.000Z");
  usage.run("u5", "runC", "c1", "worker-2", "m1", "2026-09-15T10:30:00.000Z", 10, 5, 0, 0, "/c5.jsonl", 10, "2026-09-15T10:30:00.000Z");
  usage.run("u6", "runC", "c2", "worker-2", "m1", "2026-09-22T10:30:00.000Z", 10, 5, 0, 0, "/c6.jsonl", 10, "2026-09-22T10:30:00.000Z");
  // Two-line per-message island (identical tuples 10 s apart) → one canonical row.
  usage.run("u7a", "runA", "a3", "_lead", "m1", "2026-09-01T11:30:00.000Z", 200, 100, 0, 0, "/msg.jsonl", 10, "2026-09-01T11:30:00.000Z");
  usage.run("u7b", "runA", "a3", "_lead", "m1", "2026-09-01T11:30:10.000Z", 200, 100, 0, 0, "/msg.jsonl", 20, "2026-09-01T11:30:10.000Z");

  cost.run("runA", "u1", "ps1", 1.0);
  cost.run("runA", "u2", "ps1", 0.5);
  cost.run("runB", "u4", "ps1", 0.2);
  cost.run("runC", "u5", "ps1", 0.1);
  cost.run("runC", "u6", "ps1", 0.1);
  cost.run("runA", "u7a", "ps1", 0.3);
  cost.run("runA", "u7b", "ps1", 0.3); // u3 stays unpriced (m2 in no price set)

  const tool = db.prepare(`INSERT INTO tool_facts
    (tool_fact_id, run_id, agent_key, model, observed_at, tool_name_raw, tool_name_canon,
     tool_input, tool_has_error, turn_index, source_path, source_offset, created_at,
     tool_input_id, tool_index, tool_result_state, tool_result_bytes, tool_result_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  tool.run("tf1", "runB", "_lead", "m1", "2026-09-08T10:31:00.000Z", "Read", "read_file",
    '{"file_path":"/a.txt"}', 0, 0, "/tp.jsonl", 10, "2026-09-08T10:31:00.000Z", "idA", 0, "ok", 10, "res1");
  tool.run("tf2", "runB", "_lead", "m1", "2026-09-08T10:32:00.000Z", "Read", "read_file",
    '{"file_path":"/a.txt"}', 0, 1, "/tp.jsonl", 20, "2026-09-08T10:32:00.000Z", "idA", 1, "ok", 10, "res1");
  tool.run("tf3", "runB", "_lead", "m1", "2026-09-08T10:33:00.000Z", "Edit", "edit_file",
    '{"file_path":"/b.txt"}', 1, 2, "/tp.jsonl", 30, "2026-09-08T10:33:00.000Z", "idB", 2, "error", 20, "res2");
  tool.run("tf4", "runA", "_lead", "m1", "2026-09-01T10:32:00.000Z", "Weird", null,
    "{}", 0, 0, "/tpre.jsonl", 10, "2026-09-01T10:32:00.000Z", null, 0, null, null, null);
  tool.run("tf5", "runA", "_lead", "m1", "2026-09-01T10:33:00.000Z", "Bash", "bash",
    "{}", 0, 1, "/tpre.jsonl", 20, "2026-09-01T10:33:00.000Z", "idC", 1, null, null, null);

  const link = db.prepare(`INSERT INTO delegation_links
    (delegation_id, parent_run_id, parent_agent, child_agent, child_model,
     child_transcript, observed_at, child_tokens, child_cost_usd, child_turns,
     source, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  link.run("dl1", "runA", "lead-1", "worker-1", "m1", "/w1.jsonl", "2026-09-01T11:00:00.000Z", null, null, null, "test", "2026-09-01T11:00:00.000Z");
  link.run("dl2", "runA", "lead-1", "worker-1", "m1", "/w1.jsonl", "2026-09-01T11:10:00.000Z", null, null, null, "test", "2026-09-01T11:10:00.000Z");
  link.run("dl3", "runB", "lead-2", "ghost", "m1", "/ghost.jsonl", "2026-09-08T10:30:00.000Z", null, null, null, "test", "2026-09-08T10:30:00.000Z");
  link.run("dl4", "runC", "lead-3", "worker-2", "m9", "/w2.jsonl", "2026-09-15T10:30:00.000Z", null, null, null, "test", "2026-09-15T10:30:00.000Z");
  link.run("dl5", "runC", "lead-3", "worker-2", "m9", "/w2.jsonl", "2026-09-15T10:40:00.000Z", null, null, null, "test", "2026-09-15T10:40:00.000Z");
  link.run("dl6", "runC", "lead-3", "worker-2", "m9", "/w2.jsonl", "2026-09-15T10:50:00.000Z", null, null, null, "test", "2026-09-15T10:50:00.000Z");

  const issue = db.prepare(`INSERT INTO data_quality_issues
    (issue_id, run_id, issue_type, severity, details_json, opened_at, resolved_at) VALUES (?,?,?,?,?,?,?)`);
  issue.run("iss1", "runA", "pricing_missing", "warning", "{}", "2026-09-01T12:00:00.000Z", null);
  issue.run("iss2", "runB", "transcript_missing", "warning", "{}", "2026-09-08T12:00:00.000Z", "2026-09-08T13:00:00.000Z");

  db.close();
}

// Expected canonical shape: 7 usage rows (u1..u6 + the u7 island), 5 tool calls.
const EXPECTED = { canonical_usage: 7, canonical_tool_facts: 5, runs: 3, delegation_links: 6, data_quality_issues: 2 };

const opts = { storePath, cachePath };

// --- status on a missing cache ------------------------------------------------

{
  const status = cacheStatus(opts);
  check("missing cache: exists false", status.exists === false);
  check("missing cache: stale true", status.stale === true);
  check("missing cache: building false", status.building === false);
  check("missing cache: current watermark read from the store",
    status.current != null && status.current.usageRows === 8, JSON.stringify(status.current));
}

// --- build --------------------------------------------------------------------

const built = await buildCache(opts);
{
  check("build reports row counts", JSON.stringify(built.rows) === JSON.stringify(EXPECTED), JSON.stringify(built.rows));
  check("build reports a watermark matching the store",
    JSON.stringify(built.watermark) === JSON.stringify(cacheStatus(opts).current), JSON.stringify(built.watermark));
  check("cache file exists after build", existsSync(cachePath));
  check("no .building file left behind", !existsSync(`${cachePath}.building`));
  check("no .lock file left behind", !existsSync(`${cachePath}.lock`));

  const cdb = openAnalysisDb(cachePath);
  for (const [name, expected] of Object.entries(EXPECTED)) {
    const n = cdb.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n;
    check(`cache table ${name} holds ${expected} rows`, n === expected, `got ${n}`);
  }
  const storeDb = openAnalysisDb(storePath);
  const storeCount = storeDb.prepare("SELECT COUNT(*) AS n FROM canonical_usage").get().n;
  storeDb.close();
  check("cache canonical_usage matches the store's view count",
    cdb.prepare("SELECT COUNT(*) AS n FROM canonical_usage").get().n === storeCount);

  const meta = cdb.prepare(
    "SELECT built_at, build_ms, watermark_json, cache_schema_version, source_store_path FROM cache_meta LIMIT 1",
  ).get();
  check("cache_meta built_at filled", typeof meta.built_at === "string" && Date.parse(meta.built_at) > 0);
  check("cache_meta build_ms filled", Number.isInteger(meta.build_ms) && meta.build_ms >= 0);
  check("cache_meta watermark_json parses to the store watermark",
    JSON.stringify(JSON.parse(meta.watermark_json)) === JSON.stringify(built.watermark));
  check("cache_meta schema version", meta.cache_schema_version === CACHE_SCHEMA_VERSION);
  check("cache_meta source_store_path", meta.source_store_path === storePath);

  const indexNames = new Set(cdb.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name));
  for (const index of [
    "idx_cache_cu_observed_at", "idx_cache_cu_squad", "idx_cache_cu_model", "idx_cache_cu_run_agent",
    "idx_cache_ctf_observed_at", "idx_cache_ctf_squad", "idx_cache_ctf_model", "idx_cache_ctf_run_agent",
    "idx_cache_runs_run_id", "idx_cache_dl_parent", "idx_cache_dl_observed_at",
  ]) {
    check(`index ${index} present`, indexNames.has(index));
  }
  cdb.close();

  const status = cacheStatus(opts);
  check("status after build: exists, fresh, not building",
    status.exists === true && status.stale === false && status.building === false, JSON.stringify(status));
  check("status after build: schemaVersion matches", status.schemaVersion === CACHE_SCHEMA_VERSION);
}

// --- faithfulness: panels agree between store and cache ------------------------

{
  const storeDb = openAnalysisDb(storePath);
  const cacheDb = openAnalysisDb(cachePath);
  const FILTER_SETS = [
    ["era all", { era: "all", from: "2026-01-01T00:00:00.000Z" }],
    ["squad alpha", { era: "all", from: "2026-01-01T00:00:00.000Z", squad: "alpha" }],
    ["era post", { era: "post", from: "2026-01-01T00:00:00.000Z" }],
  ];
  const panels = [
    ["metaPanel", (db) => metaPanel(db)],
    ["costPanel", (db, f) => costPanel(db, f)],
    ["toolsPanel", (db, f) => toolsPanel(db, f)],
    ["handoffsPanel", (db, f) => handoffsPanel(db, f)],
    ["qualityPanel", (db, f) => qualityPanel(db, f)],
  ];
  for (const [filterName, filters] of FILTER_SETS) {
    for (const [panelName, panel] of panels) {
      let a; let b;
      try { a = panel(storeDb, filters); } catch (e) { a = { error: `${e.code}: ${e.message}` }; }
      try { b = panel(cacheDb, filters); } catch (e) { b = { error: `${e.code}: ${e.message}` }; }
      const sa = JSON.stringify({ data: a.data, caveats: a.caveats });
      const sb = JSON.stringify({ data: b.data, caveats: b.caveats });
      check(`${panelName} deep-equal store vs cache (${filterName})`, sa === sb,
        `store: ${sa.slice(0, 300)} | cache: ${sb.slice(0, 300)}`);
    }
  }
  storeDb.close();
  cacheDb.close();
}

// --- the store is never written by a build -------------------------------------

{
  const before = statSync(storePath);
  await buildCache(opts);
  const after = statSync(storePath);
  check("build leaves the store's mtime unchanged", before.mtimeMs === after.mtimeMs,
    `${before.mtimeMs} → ${after.mtimeMs}`);
  check("build leaves the store's size unchanged", before.size === after.size,
    `${before.size} → ${after.size}`);
  // A read-only open of a WAL-mode database legitimately creates empty -shm/-wal
  // sidecars (SQLite coordination); the proof the build wrote nothing is that
  // the main file is byte-for-byte untouched and the -wal holds no frames.
  const walPath = `${storePath}-wal`;
  check("no WAL frames written to the store", !existsSync(walPath) || statSync(walPath).size === 0,
    `wal size ${existsSync(walPath) ? statSync(walPath).size : "n/a"}`);
}

// --- leftover .building from a crashed build is cleaned -------------------------

{
  writeFileSync(`${cachePath}.building`, "garbage from a crashed build");
  const result = await buildCache(opts);
  check("build over a leftover .building succeeds", result.rows.canonical_usage === EXPECTED.canonical_usage);
  check("leftover .building is gone after the build", !existsSync(`${cachePath}.building`));
  check("cache is fresh after rebuilding over the leftover", cacheStatus(opts).stale === false);
}

// --- stale lock (dead pid) is taken over ---------------------------------------

{
  const lockPath = `${cachePath}.lock`;
  writeFileSync(lockPath, JSON.stringify({ pid: 4194303, startedAt: new Date().toISOString() }));
  const result = await buildCache(opts);
  check("stale lock (dead pid) is taken over and the build succeeds",
    result.rows.canonical_usage === EXPECTED.canonical_usage);
  check("taken-over lock is released after the build", !existsSync(lockPath));
}

// --- live lock: concurrent build refuses; status reports building ----------------

{
  const lockPath = `${cachePath}.lock`;
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  const statusWhileLocked = cacheStatus(opts);
  check("status reports building while a live lock exists", statusWhileLocked.building === true);

  let err = null;
  try { await buildCache(opts); } catch (e) { err = e; }
  check("second build against a live lock rejects with build_in_progress",
    err?.code === "build_in_progress", `code=${err?.code} message=${err?.message}`);
  check("the rejected build did not touch the cache file", cacheStatus(opts).stale === false);
  rmSync(lockPath, { force: true });

  // Real in-process overlap: the first build yields after taking the lock, so
  // a same-tick second build must observe it.
  const [first, second] = await Promise.allSettled([buildCache(opts), buildCache(opts)]);
  const codes = [first, second].map((r) => r.status === "rejected" ? r.reason.code : "ok");
  check("one of two concurrent in-process builds wins",
    codes.includes("ok") && codes.includes("build_in_progress"), JSON.stringify(codes));
  check("no lock left after the concurrent pair", !existsSync(lockPath));
  check("cache is fresh after the concurrent pair", cacheStatus(opts).stale === false);
}

// --- store changes → stale; rebuild → fresh -------------------------------------

{
  const db = openTelemetryDb(storePath);
  db.prepare(`INSERT INTO usage_facts
    (usage_id, run_id, session_id, agent_key, model, observed_at,
     input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
     source_path, source_offset, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run("u8", "runA", "a5", "_lead", "m1", "2026-09-02T10:00:00.000Z", 10, 5, 0, 0, "/c8.jsonl", 10, "2026-09-02T10:00:00.000Z");
  db.close();

  const stale = cacheStatus(opts);
  check("status is stale after the store gains a row", stale.stale === true, JSON.stringify(stale));
  check("stale status still reports the old watermark",
    stale.watermark.usageRows === 8 && stale.current.usageRows === 9, JSON.stringify(stale));

  const rebuilt = await buildCache(opts);
  check("rebuild after the store change picks up the new row",
    rebuilt.rows.canonical_usage === EXPECTED.canonical_usage + 1, JSON.stringify(rebuilt.rows));
  const fresh = cacheStatus(opts);
  check("status is fresh after the rebuild", fresh.stale === false, JSON.stringify(fresh));
}

// --- unreadable/absent store is reported stale, never fresh ----------------------

{
  const status = cacheStatus({ storePath: join(temp, "no-such-store.sqlite"), cachePath });
  check("missing store: current is null and cache is stale",
    status.current === null && status.stale === true, JSON.stringify(status));
}

// --- swap retries outlast a slow reader -------------------------------------------

{
  // A SQL console query on the cache can hold the file for up to its own
  // 10 s timeout, so the swap must retry for ~12 s, not ~1 s. Simulated with
  // an injected rename that fails a few times (the blocker holding the file)
  // and then succeeds (the blocker released inside the window).
  const swapDir = mkdtempSync(join(tmpdir(), "analysis-cache-swap-test-"));
  try {
    const building = join(swapDir, "building.sqlite");
    const target = join(swapDir, "target.sqlite");
    writeFileSync(building, "snapshot");

    let failuresLeft = 3;
    const flakyRename = (a, b) => {
      if (failuresLeft-- > 0) throw Object.assign(new Error("EPERM: file held open"), { code: "EPERM" });
      renameSync(a, b);
    };
    await swapIntoPlace(building, target, { attempts: 48, intervalMs: 1, rename: flakyRename });
    check("swap succeeds once the blocker releases inside the retry window",
      existsSync(target) && !existsSync(building));
    check("the swapped-in snapshot is the built content",
      existsSync(target) && statSync(target).size > 0);

    // A blocker that never releases: swap_failed after the budget, the
    // .building file cleaned up, the old target untouched.
    const building2 = join(swapDir, "building2.sqlite");
    writeFileSync(building2, "second snapshot");
    let err = null;
    try {
      await swapIntoPlace(building2, target, {
        attempts: 3,
        intervalMs: 1,
        rename: () => { throw new Error("EPERM: file held open"); },
      });
    } catch (e) { err = e; }
    check("swap that never wins rejects with swap_failed", err?.code === "swap_failed", `code=${err?.code}`);
    check("failed swap cleans up the .building file", !existsSync(building2));
    check("failed swap leaves the old target untouched", existsSync(target));
  } finally {
    rmSync(swapDir, { recursive: true, force: true });
  }
}

// -----------------------------------------------------------------------------

rmSync(temp, { recursive: true, force: true });

console.log(`${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  FAIL: ${f}`).join("\n"));
  process.exit(1);
}
