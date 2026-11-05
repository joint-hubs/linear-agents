// scripts/bash-output-distribution.test.mjs — FOC-1072 Item 1.
//
// The fixture DB carries the REAL store schema — openTelemetryDb() creates the
// same CREATE TABLE block the 3.3 GB production store runs — seeded with rows
// whose percentiles and shares are computable by hand, so every number the
// script reports is asserted exactly. No real store is touched: the script's
// store-facing CLI path is exercised against this fixture via --db, and the
// read-only production measurement is a separate manual step recorded in the
// decision doc.
//
// Run: node scripts/bash-output-distribution.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openTelemetryDb } from "./telemetry-store.mjs";
import { bashOutputDistribution, summarizeBytes } from "./bash-output-distribution.mjs";

// ── summarizeBytes: exact nearest-rank percentiles and shares ────────────────

test("summarizeBytes: nearest-rank percentiles on a 5-element sample", () => {
  // sorted: 1000 2000 3000 4000 5000
  // nearest rank: p20 = ceil(0.2*5)=1st, p50 = ceil(2.5)=3rd, p80 = ceil(4)=4th, p95 = ceil(4.75)=5th
  const s = summarizeBytes([1000, 2000, 3000, 4000, 5000]);
  assert.equal(s.n, 5);
  assert.equal(s.bytes, 15000);
  assert.equal(s.p20, 1000);
  assert.equal(s.p50, 3000);
  assert.equal(s.p80, 4000);
  assert.equal(s.p95, 5000);
  // above 2048: 3000, 4000, 5000 → 3 of 5
  assert.equal(s.above2k.count, 3);
  assert.equal(s.above2k.countShare, 0.6);
  assert.equal(s.above2k.bytes, 12000);
  assert.equal(s.above2k.bytesShare, 12000 / 15000);
  // above 8192 and 32768: nothing
  assert.equal(s.above8k.count, 0);
  assert.equal(s.above8k.countShare, 0);
  assert.equal(s.above32k.count, 0);
  assert.equal(s.above32k.bytesShare, 0);
});

test("summarizeBytes: 10-element sample with a real tail", () => {
  // sorted: 500 1000 2000 4000 8000 16000 32000 64000 128000 256000
  // p20=2nd(1000) p50=5th(8000) p80=8th(64000) p95=10th(256000)
  const s = summarizeBytes([8000, 500, 256000, 1000, 32000, 2000, 64000, 4000, 128000, 16000]);
  assert.equal(s.n, 10);
  assert.equal(s.p20, 1000);
  assert.equal(s.p50, 8000);
  assert.equal(s.p80, 64000);
  assert.equal(s.p95, 256000);
  // above 32768: 64000, 128000, 256000 → 3 of 10
  assert.equal(s.above32k.count, 3);
  assert.equal(s.above32k.countShare, 0.3);
  // total = 511500; above-32k bytes = 448000
  assert.equal(s.bytes, 511500);
  assert.equal(s.above32k.bytes, 448000);
  assert.equal(s.above32k.bytesShare, 448000 / 511500);
});

test("summarizeBytes: empty input → null percentiles, zero counts", () => {
  const s = summarizeBytes([]);
  assert.equal(s.n, 0);
  assert.equal(s.bytes, 0);
  assert.equal(s.p20, null);
  assert.equal(s.p50, null);
  assert.equal(s.p80, null);
  assert.equal(s.p95, null);
  assert.equal(s.above2k.count, 0);
  assert.equal(s.above2k.countShare, 0);
  assert.equal(s.above2k.bytesShare, 0);
});

test("summarizeBytes: single value is every percentile", () => {
  const s = summarizeBytes([42]);
  assert.equal(s.n, 1);
  assert.equal(s.p20, 42);
  assert.equal(s.p95, 42);
});

// ── bashOutputDistribution: roles, window filter, NULL exclusion ─────────────

function makeFixtureDb() {
  const dir = mkdtempSync(join(tmpdir(), "bashdist-"));
  const db = openTelemetryDb(join(dir, "telemetry.sqlite"));
  return { dir, db };
}

function seedRun(db, runId, squad, startedAt) {
  db.prepare("INSERT INTO runs (run_id, squad, started_at, updated_at) VALUES (?, ?, ?, ?)").run(
    runId,
    squad,
    startedAt,
    startedAt,
  );
}

function seedBashFact(db, runId, agentKey, bytes, observedAt = "2026-11-01T12:00:00.000Z") {
  db.prepare(
    `INSERT INTO tool_facts (tool_fact_id, run_id, agent_key, tool_name_raw, tool_name_canon,
       observed_at, tool_has_error, turn_index, source_path, source_offset, created_at, tool_result_bytes)
     VALUES (?, ?, ?, 'Bash', 'bash', ?, 0, 0, 't.jsonl', 0, ?, ?)`,
  ).run(`tf-${agentKey}-${bytes}-${Math.random()}`, runId, agentKey, observedAt, observedAt, bytes);
}

test("bashOutputDistribution: roles split on agent_key, window filters runs", () => {
  const { dir, db } = makeFixtureDb();
  try {
    // In-window run (started 2026-11-01): lead rows + subagent rows.
    seedRun(db, "run-in", "dev", "2026-11-01T08:00:00.000Z");
    for (const b of [1000, 2000, 3000, 4000, 5000]) seedBashFact(db, "run-in", "_lead", b);
    for (const b of [8000, 500, 256000, 1000, 32000, 2000, 64000, 4000, 128000, 16000]) {
      seedBashFact(db, "run-in", "dev-1", b);
    }
    // Out-of-window run (started 2026-09-01, more than 30 days before the window).
    seedRun(db, "run-old", "dev", "2026-09-01T08:00:00.000Z");
    seedBashFact(db, "run-old", "_lead", 999999);

    // Rows that probe the exclusions: NULL bytes (unknown — must never enter),
    // and a non-Bash tool (Read — must never enter). The extra valid Bash row
    // (1234567) DOES enter — it is a real measurement; if the NULL row also
    // leaked in, subagent would be 12, not 11.
    seedBashFact(db, "run-in", "dev-2", null);
    seedBashFact(db, "run-in", "dev-2", 1234567);
    db.prepare(
      `INSERT INTO tool_facts (tool_fact_id, run_id, agent_key, tool_name_raw, tool_name_canon,
         observed_at, tool_has_error, turn_index, source_path, source_offset, created_at, tool_result_bytes)
       VALUES ('tf-read', 'run-in', 'dev-2', 'Read', 'read_file', '2026-11-01T12:00:00.000Z', 0, 0, 't.jsonl', 0, '2026-11-01T12:00:00.000Z', 700000)`,
    ).run();

    const result = bashOutputDistribution(db, { sinceIso: "2026-10-06T00:00:00.000Z" });

    assert.equal(result.roles.lead.n, 5);
    assert.equal(result.roles.lead.p50, 3000);
    assert.equal(result.roles.subagent.n, 11);
    // 11 sorted values → p50 = ceil(5.5)=6th (16000), p95 = 11th (the max)
    assert.equal(result.roles.subagent.p50, 16000);
    assert.equal(result.roles.subagent.p95, 1234567);
    // all = lead ∪ subagent (in-window Bash rows with known bytes only)
    assert.equal(result.all.n, 16);
    assert.equal(result.all.bytes, 15000 + 511500 + 1234567);
    assert.equal(result.all.p95, 1234567);
    // the out-of-window 999999 run is gone: lead stats carry no such value
    assert.ok(result.roles.lead.p95 < 999999);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bashOutputDistribution: zero-byte results count, NULL never does", () => {
  const { dir, db } = makeFixtureDb();
  try {
    seedRun(db, "run-a", "dev", "2026-11-01T08:00:00.000Z");
    seedBashFact(db, "run-a", "dev-1", 0); // present but empty — a real measurement
    seedBashFact(db, "run-a", "dev-1", null); // unknown — excluded
    const result = bashOutputDistribution(db, { sinceIso: "2026-10-06T00:00:00.000Z" });
    assert.equal(result.roles.subagent.n, 1);
    assert.equal(result.roles.subagent.bytes, 0);
    assert.equal(result.roles.subagent.p50, 0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bashOutputDistribution: empty store → nulls everywhere, no crash", () => {
  const { dir, db } = makeFixtureDb();
  try {
    const result = bashOutputDistribution(db, { sinceIso: "2026-10-06T00:00:00.000Z" });
    assert.equal(result.roles.lead.n, 0);
    assert.equal(result.roles.subagent.n, 0);
    assert.equal(result.all.n, 0);
    assert.equal(result.all.p50, null);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
